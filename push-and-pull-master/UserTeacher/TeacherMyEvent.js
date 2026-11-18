import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { ref, onValue, off, get, remove } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js";
import { auth, rtdb, functions } from "../UserStudent/firebaseConfig.js";

(() => {
  "use strict";

  const tableBody = document.getElementById("eventTableBody");
  const searchInput = document.getElementById("eventSearch");
  const statusFilter = document.getElementById("eventStatusFilter");
  const dateFilter = document.getElementById("eventDateFilter");
  const resultsCount = document.getElementById("eventResultsCount");
  const modal = document.getElementById("eventDetailsModal");

  let teacherUid = "";
  let eventsById = new Map();
  let draftsById = new Map();
  const approvalsById = new Map();
  const activeRefs = new Map();
  let indexRef = null;
  let draftsRef = null;
  let indexLoaded = false;
  let draftsLoaded = false;
  const initialEventReadsPending = new Set();
  let pageLoadSignaled = false;
  let loadErrorOccurred = false;
  let missingNewTimer = null;

  function signalPageReadyIfLoaded() {
    if (pageLoadSignaled || !indexLoaded || !draftsLoaded || initialEventReadsPending.size) return;
    pageLoadSignaled = true;
    window.dispatchEvent(new Event("page-data-ready"));
  }

  // Keep in sync with the other role's page.
  const escapeHTML = (value) =>
    String(value ?? "").replace(
      /[&<>"']/g,
      (character) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[character],
    );

  // Keep in sync with the other role's page.
  function normalizeStatus(status) {
    const raw = String(status ?? "").trim().toLowerCase().replace(/[\s_-]+/g, " ");
    if (raw === "pending approval") return "pending";
    if (raw === "needs revision") return "revision";
    return raw;
  }

  // Keep in sync with the other role's page.
  function formatDisplayStatus(status) {
    const norm = normalizeStatus(status);
    if (norm === "pending") return "Pending";
    if (norm === "revision") return "Needs Revision";
    if (norm === "approved") return "Approved";
    if (norm === "published") return "Published";
    if (norm === "completed") return "Completed";
    if (norm === "cancelled" || norm === "canceled") return "Cancelled";
    if (norm === "rejected") return "Rejected";
    return status || "Draft";
  }

  // Keep in sync with the other role's page.
  function getStatusClass(status) {
    const norm = normalizeStatus(status);
    if (norm === "pending") return "pending";
    if (norm === "revision") return "revision";
    if (norm === "approved") return "approved";
    if (norm === "published") return "published";
    if (norm === "completed") return "completed";
    if (norm === "cancelled" || norm === "canceled") return "cancelled";
    if (norm === "rejected") return "rejected";
    return "draft";
  }

  // Keep in sync with the other role's page.
  function formatDate(value, fallback = "Date TBA") {
    if (!value) return fallback;
    const text = String(value);
    const date = new Date(text.includes("T") ? text : `${text.slice(0, 10)}T00:00:00`);
    return Number.isNaN(date.getTime())
      ? fallback
      : date.toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
        });
  }

  function readEvents() {
    return [...draftsById.values(), ...eventsById.values()].sort((first, second) => {
      if ((first.status === "draft") !== (second.status === "draft")) return first.status === "draft" ? -1 : 1;
      return new Date(second.createdAt || second.updatedAt || 0) - new Date(first.createdAt || first.updatedAt || 0);
    });
  }

  function hapApproved(event, number) {
    if (!event) return false;
    const approval = approvalsById.get(String(event.eventId || event.id));
    if (approval && approval.members) {
      const members = Object.values(approval.members).sort((a, b) => (a.step || 0) - (b.step || 0));
      if (members[number - 1]) {
        return members[number - 1].status === "ok";
      }
    }
    const approvalKey = `hap${number}Approved`;
    const statusKey = `hap_${number}_status`;
    const legacyKey = `hap${number}`;
    const nestedApproval = event.approvals?.[`hap${number}`];

    if (event[approvalKey] === true) return true;
    if (nestedApproval === true) return true;
    if (typeof nestedApproval === "string" && nestedApproval.toLowerCase() === "approved") return true;
    if (typeof event[statusKey] === "string" && event[statusKey].toLowerCase() === "approved") return true;
    if (event[legacyKey] === true) return true;

    const normStatus = normalizeStatus(event.status);
    if (["approved", "published", "completed"].includes(normStatus)) return true;
    return false;
  }

  function getStatus(event) {
    if (event.status === "draft") return "Draft";
    const approval = approvalsById.get(String(event.eventId || event.id));
    const raw = String(approval?.status || event.status || "Pending").trim();
    return formatDisplayStatus(raw);
  }

  function renderStatistics(events) {
    const totalEl = document.getElementById("totalEventsCount");
    const pendingEl = document.getElementById("pendingEventsCount");
    const approvedEl = document.getElementById("approvedEventsCount");
    const revisionEl = document.getElementById("needsRevisionCount");

    if (totalEl) totalEl.textContent = events.length;
    if (pendingEl) pendingEl.textContent = events.filter((e) => getStatus(e) === "Pending").length;
    if (approvedEl) approvedEl.textContent = events.filter((e) => ["Approved", "Published", "Completed"].includes(getStatus(e))).length;
    if (revisionEl) revisionEl.textContent = events.filter((e) => getStatus(e) === "Needs Revision").length;
  }

  function dateRangeBounds(value, today) {
    const date = new Date(today);
    if (value === "today") return [date, date];
    if (value === "tomorrow") {
      date.setDate(date.getDate() + 1);
      return [date, date];
    }
    if (value === "this_week") {
      date.setDate(date.getDate() - date.getDay());
      const end = new Date(date);
      end.setDate(end.getDate() + 6);
      return [date, end];
    }
    if (value === "this_weekend") {
      if (date.getDay() === 0) return [date, date];
      date.setDate(date.getDate() + 6 - date.getDay());
      const end = new Date(date);
      end.setDate(end.getDate() + 1);
      return [date, end];
    }
    if (value === "next_week") {
      date.setDate(date.getDate() + 7 - date.getDay());
      const end = new Date(date);
      end.setDate(end.getDate() + 6);
      return [date, end];
    }
    if (value === "this_month")
      return [new Date(today.getFullYear(), today.getMonth(), 1), new Date(today.getFullYear(), today.getMonth() + 1, 0)];
    if (value === "next_month")
      return [new Date(today.getFullYear(), today.getMonth() + 1, 1), new Date(today.getFullYear(), today.getMonth() + 2, 0)];
    return null;
  }

  function getFilteredEvents(events) {
    const query = searchInput?.value.trim().toLowerCase() || "";
    const selectedStatus = statusFilter?.value || "all";
    const selectedDate = dateFilter?.value || "all";
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    return events.filter((event) => {
      const text = `${event.title || event.name || ""} ${event.location || event.venue || ""} ${event.category || ""}`.toLowerCase();
      const dateVal = event.dateISO || event.date || event.eventDate || event.startAt;
      const date = dateVal ? new Date(`${String(dateVal).slice(0, 10)}T00:00:00`) : null;
      const validDate = date && !Number.isNaN(date.getTime());
      const selectedRange = dateRangeBounds(selectedDate, today);
      const customRange = /^custom:(\d{4}-\d{2}-\d{2}):(\d{4}-\d{2}-\d{2})$/.exec(selectedDate);
      const matchesDate =
        selectedDate === "all" ||
        (validDate && selectedDate === "upcoming" && date >= today) ||
        (validDate && selectedDate === "past" && date < today) ||
        (validDate && selectedRange && date >= selectedRange[0] && date <= selectedRange[1]) ||
        (validDate &&
          customRange &&
          date >= new Date(`${customRange[1]}T00:00:00`) &&
          date <= new Date(`${customRange[2]}T00:00:00`));

      const eventStatus = getStatus(event);
      const matchesStatus =
        selectedStatus === "all" ||
        normalizeStatus(eventStatus) === normalizeStatus(selectedStatus);

      return (!query || text.includes(query)) && matchesStatus && matchesDate;
    });
  }

  function openDetails(event) {
    const canReviewDocuments = teacherUid && event.organizerUid === teacherUid;
    window.RecovibeEventDetails?.open(event, {
      showApprovalDocuments: Boolean(canReviewDocuments),
    });
  }

  function showNotice(message) {
    let notice = document.getElementById("myEventsNotice");
    if (!notice) {
      notice = document.createElement("div");
      notice.id = "myEventsNotice";
      notice.setAttribute("role", "status");
      tableBody?.closest("table")?.before(notice);
    }
    notice.textContent = message;
  }

  function showMissingNotice(message) {
    let notice = document.getElementById("myEventMissingNotice");
    if (!notice) {
      notice = document.createElement("div");
      notice.id = "myEventMissingNotice";
      notice.setAttribute("role", "status");
      tableBody?.closest("table")?.before(notice);
    }
    notice.textContent = message;
  }

  function render() {
    if (!tableBody) return;
    const allEvents = readEvents();
    const events = getFilteredEvents(allEvents);
    renderStatistics(allEvents);

    if (resultsCount) {
      resultsCount.textContent = `Showing ${events.length} of ${allEvents.length} events`;
    }

    if (loadErrorOccurred) {
      tableBody.innerHTML = `
        <tr>
          <td colspan="9">
            <div class="event-table-empty">
              <strong>Couldn't load your events</strong>
              <span>There was a problem loading your event submissions.</span>
              <button type="button" class="organizer-button" id="btnTryAgain">Try again</button>
            </div>
          </td>
        </tr>`;
      return;
    }

    if (!events.length) {
      tableBody.innerHTML = `
        <tr>
          <td colspan="9">
            <div class="event-table-empty">
              <strong>You haven't created any events yet.</strong>
              <span>Submit an event to see its approval status here.</span>
              <a class="organizer-button" href="TeacherCreate.html">+ Create Event</a>
            </div>
          </td>
        </tr>`;
      return;
    }

    const newParam = new URLSearchParams(location.search).get("new");

    tableBody.innerHTML = events
      .map((event) => {
        const id = escapeHTML(event.eventId || event.id);
        const status = getStatus(event);
        const statusClass = getStatusClass(status);
        const isDraft = event.status === "draft";
        const showAttendanceAction = ["Published", "Completed"].includes(status);
        const isNew = newParam === String(id);
        const schedule = event.time || [event.startTime, event.endTime].filter(Boolean).join(" - ") || "Time TBA";
        const locationText = event.location || event.venue || "Location TBA";
        const scanParams = new URLSearchParams({
          eventId: String(event.eventId || event.id),
          eventName: String(event.title || event.name || "Untitled event"),
          eventDate: String(event.dateISO || event.date || event.eventDate || ""),
          eventTime: String(schedule),
          eventVenue: String(locationText),
        });

        return `<tr data-event-id="${id}"${isNew ? ' class="new-event-highlight"' : ""}>
          <td data-label="Event">
            <strong>${escapeHTML(event.title || event.name || "Untitled event")}</strong>
            <small>${escapeHTML(event.category || "General")}</small>
          </td>
          <td data-label="Date Created">${formatDate(event.createdAt || event.updatedAt, "Date unavailable")}</td>
          <td data-label="HAP 1"><input type="checkbox" class="hap-status" aria-label="HAP 1" ${hapApproved(event, 1) ? "checked" : ""} disabled></td>
          <td data-label="HAP 2"><input type="checkbox" class="hap-status" aria-label="HAP 2" ${hapApproved(event, 2) ? "checked" : ""} disabled></td>
          <td data-label="HAP 3"><input type="checkbox" class="hap-status" aria-label="HAP 3" ${hapApproved(event, 3) ? "checked" : ""} disabled></td>
          <td data-label="Schedule">${escapeHTML(schedule)}</td>
          <td data-label="Location">${escapeHTML(locationText)}</td>
          <td data-label="Status">
            <span class="organizer-status ${statusClass}">${escapeHTML(status)}</span>
          </td>
          <td data-label="Actions">
            <div class="event-actions">
              ${
                isDraft
                  ? `<a class="event-action" href="TeacherCreate.html?draft=${id}">Continue editing</a><button type="button" class="event-action event-action-danger" data-action="delete" data-event-id="${id}">Delete</button>`
                  : `<button type="button" class="event-action" data-action="view" data-event-id="${id}">View</button>${
                      status !== "Cancelled"
                        ? `<button type="button" class="event-action event-action-danger" data-action="cancel" data-event-id="${id}">Cancel</button>`
                        : ""
                    }${showAttendanceAction ? `<a class="event-action" href="../UserEventOrganizer/EventOrganizerScanAttendance.html?${scanParams.toString()}">Scan attendance</a>` : ""}`
              }
            </div>
          </td>
        </tr>`;
      })
      .join("");
  }

  function renderOwnedEvents() {
    render();
    const params = new URLSearchParams(location.search);
    const requestedId = params.get("event") || params.get("openEvent");

    if (requestedId && indexLoaded && draftsLoaded) {
      const event = eventsById.get(requestedId);
      if (event && event.organizerUid === teacherUid) {
        openDetails(event);
      } else {
        showMissingNotice("We couldn't find that event in your list.");
      }
    }

    const newId = params.get("new");
    if (newId && eventsById.has(newId)) {
      const notice = sessionStorage.getItem("recovibeEventNotice") || "Event submitted.";
      showNotice(notice);
      if (missingNewTimer) clearTimeout(missingNewTimer);
    } else if (newId && !missingNewTimer) {
      missingNewTimer = setTimeout(() => {
        if (!eventsById.has(newId)) {
          showNotice("Your event was submitted but is taking a moment to appear. Refresh to check.");
          const refreshBtn = document.createElement("button");
          refreshBtn.type = "button";
          refreshBtn.className = "organizer-button";
          refreshBtn.style.marginLeft = "8px";
          refreshBtn.textContent = "Refresh";
          refreshBtn.addEventListener("click", () => location.reload());
          document.getElementById("myEventsNotice")?.appendChild(refreshBtn);
        }
      }, 5000);
    }
  }

  function cleanupListeners() {
    if (missingNewTimer) clearTimeout(missingNewTimer);
    if (indexRef && rtdb) off(indexRef);
    if (draftsRef && rtdb) off(draftsRef);
    activeRefs.forEach((r) => off(r));
    activeRefs.clear();
    indexRef = null;
    draftsRef = null;
  }

  function listenToMyEvents(uid) {
    cleanupListeners();
    loadErrorOccurred = false;

    if (!rtdb) {
      loadErrorOccurred = true;
      indexLoaded = true;
      draftsLoaded = true;
      showNotice("Couldn't load your events.");
      render();
      signalPageReadyIfLoaded();
      return;
    }

    indexRef = ref(rtdb, `organizerEvents/${uid}`);
    onValue(
      indexRef,
      (snapshot) => {
        indexLoaded = true;
        const ids = new Set(Object.keys(snapshot.val() || {}));
        if (!pageLoadSignaled) {
          ids.forEach((id) => {
            initialEventReadsPending.add(`${id}:event`);
            initialEventReadsPending.add(`${id}:approval`);
          });
        }
        [...activeRefs.keys()].forEach((idKey) => {
          const rawId = idKey.split(":")[0];
          if (!ids.has(rawId)) {
            off(activeRefs.get(idKey));
            activeRefs.delete(idKey);
            eventsById.delete(rawId);
            approvalsById.delete(rawId);
            initialEventReadsPending.delete(`${rawId}:event`);
            initialEventReadsPending.delete(`${rawId}:approval`);
          }
        });
        signalPageReadyIfLoaded();

        ids.forEach((id) => {
          if (activeRefs.has(id)) return;
          const eventRef = ref(rtdb, `events/${id}`);
          const approvalRef = ref(rtdb, `approvals/${id}`);

          onValue(
            eventRef,
            (eventSnapshot) => {
              const event = eventSnapshot.val();
              // Defense in depth: drop if event.organizerUid is not the signed-in uid
              if (!event || event.organizerUid !== uid) {
                eventsById.delete(id);
                activeRefs.delete(id);
                off(eventRef);
                renderOwnedEvents();
                initialEventReadsPending.delete(`${id}:event`);
                signalPageReadyIfLoaded();
                return;
              }
              eventsById.set(id, {
                ...event,
                id,
                eventId: id,
                title: event.name || event.title || "Untitled event",
                dateISO: event.dateISO || event.date || (event.startAt ? String(event.startAt).slice(0, 10) : ""),
                location: event.location || event.venue || "",
              });
              renderOwnedEvents();
              initialEventReadsPending.delete(`${id}:event`);
              signalPageReadyIfLoaded();
            },
            (error) => {
              console.error("Could not load owned teacher event:", error);
              loadErrorOccurred = true;
              renderOwnedEvents();
              initialEventReadsPending.delete(`${id}:event`);
              signalPageReadyIfLoaded();
            },
          );

          onValue(
            approvalRef,
            (approvalSnapshot) => {
              if (approvalSnapshot.exists()) {
                approvalsById.set(id, approvalSnapshot.val());
              }
              renderOwnedEvents();
              initialEventReadsPending.delete(`${id}:approval`);
              signalPageReadyIfLoaded();
            },
            (error) => {
              console.error("Could not load teacher event approval:", error);
              initialEventReadsPending.delete(`${id}:approval`);
              signalPageReadyIfLoaded();
            },
          );

          activeRefs.set(id, eventRef);
          activeRefs.set(`${id}:approval`, approvalRef);
        });

        renderOwnedEvents();
        signalPageReadyIfLoaded();
      },
      (error) => {
        console.error("Could not load teacher event index:", error);
        loadErrorOccurred = true;
        indexLoaded = true;
        renderOwnedEvents();
        signalPageReadyIfLoaded();
      },
    );

    draftsRef = ref(rtdb, `drafts/${uid}`);
    onValue(
      draftsRef,
      (snapshot) => {
        draftsLoaded = true;
        draftsById = new Map(
          Object.entries(snapshot.val() || {})
            .filter(([, draft]) => {
              // Defense in depth for drafts
              if (!draft || draft.status !== "draft" || typeof draft.name !== "string") return false;
              if (draft.organizerUid && draft.organizerUid !== uid) return false;
              return true;
            })
            .map(([id, draft]) => [
              id,
              {
                ...draft,
                id,
                eventId: id,
                title: draft.eventName || draft.name,
                status: "draft",
                location: draft.location || draft.venue || "",
                dateISO: draft.dateISO || draft.date || (draft.startAt ? String(draft.startAt).slice(0, 10) : ""),
              },
            ]),
        );
        renderOwnedEvents();
        signalPageReadyIfLoaded();
      },
      (error) => {
        console.error("Could not load teacher drafts:", error);
        loadErrorOccurred = true;
        draftsLoaded = true;
        renderOwnedEvents();
        signalPageReadyIfLoaded();
      },
    );
  }

  // Event handlers
  tableBody?.addEventListener("click", (event) => {
    const tryAgainBtn = event.target.closest("#btnTryAgain");
    if (tryAgainBtn) {
      listenToMyEvents(teacherUid);
      return;
    }

    const button = event.target.closest("[data-action]");
    if (!button) return;
    const action = button.dataset.action;
    const eventId = button.dataset.eventId;
    if (!eventId) return;

    const record = readEvents().find((item) => String(item.eventId || item.id) === String(eventId));
    if (!record) return;

    if (action === "delete") {
      if (!window.confirm("Delete this draft? This cannot be undone.")) return;
      remove(ref(rtdb, `drafts/${teacherUid}/${eventId}`)).catch((error) => {
        console.error("Could not delete teacher draft:", error);
        showNotice("Couldn't delete this draft. Please try again.");
      });
      return;
    }

    if (action === "view") {
      openDetails(record);
      return;
    }

    if (action === "cancel") {
      if (!window.confirm("Are you sure you want to cancel this event?")) return;
      if (functions) {
        const cancelFn = httpsCallable(functions, "cancelEvent");
        cancelFn({ eventId, reason: "Cancelled by event owner" })
          .then(() => showNotice("Event cancellation requested."))
          .catch((error) => {
            console.error("Could not cancel teacher event:", error);
            showNotice("Couldn't cancel this event. Please try again.");
          });
      }
    }
  });

  function createDateRangePicker(host, select) {
    const wrapper = document.createElement("div");
    const trigger = document.createElement("button");
    const panel = document.createElement("section");
    wrapper.className = "date-range-picker";
    trigger.className = "date-range-trigger";
    trigger.type = "button";
    trigger.textContent = "All Dates";
    trigger.setAttribute("aria-label", "Date filter: All Dates");
    trigger.setAttribute("aria-expanded", "false");
    trigger.setAttribute("aria-haspopup", "dialog");
    trigger.setAttribute("aria-controls", `${select.id}PickerPanel`);
    panel.className = "date-range-panel";
    panel.id = `${select.id}PickerPanel`;
    panel.hidden = true;
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-labelledby", `${panel.id}Title`);
    panel.innerHTML = `<header class="date-range-header"><h2 id="${panel.id}Title">Choose date range</h2><button type="button" class="date-range-close" aria-label="Close date picker">&times;</button></header><div class="date-range-quick" role="group" aria-label="Quick date ranges"></div><div class="date-range-months" aria-label="Choose dates"></div><div class="date-range-fields"><label>From<input type="text" inputmode="numeric" autocomplete="off" placeholder="YYYY-MM-DD" aria-label="Start date"></label><label>To<input type="text" inputmode="numeric" autocomplete="off" placeholder="YYYY-MM-DD" aria-label="End date"></label></div><p class="date-range-error" role="alert" aria-live="polite"></p><footer class="date-range-actions"><button type="button" class="date-range-clear">Clear</button><button type="button" class="date-range-cancel">Cancel</button><button type="button" class="date-range-apply">Apply</button></footer>`;
    wrapper.appendChild(trigger);
    host.appendChild(wrapper);
    host.classList.add("date-range-host");
    document.body.appendChild(panel);

    const startInput = panel.querySelector(".date-range-fields label:first-child input");
    const endInput = panel.querySelector(".date-range-fields label:last-child input");
    const quick = panel.querySelector(".date-range-quick");
    const monthsElement = panel.querySelector(".date-range-months");
    const error = panel.querySelector(".date-range-error");
    const pad = (value) => String(value).padStart(2, "0");
    const dateString = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    const parseDate = (value) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return null;
      const [year, month, day] = value.split("-").map(Number);
      const date = new Date(year, month - 1, day);
      return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : null;
    };
    const addDays = (date, count) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + count);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const rangeFor = (preset) => {
      const day = new Date(today);
      if (preset === "today") return [day, day];
      if (preset === "tomorrow") return [addDays(day, 1), addDays(day, 1)];
      if (preset === "this_week") {
        const start = addDays(day, -day.getDay());
        return [start, addDays(start, 6)];
      }
      if (preset === "this_weekend") {
        if (day.getDay() === 0) return [day, day];
        const saturday = addDays(day, 6 - day.getDay());
        return [saturday, addDays(saturday, 1)];
      }
      if (preset === "next_week") {
        const start = addDays(day, 7 - day.getDay());
        return [start, addDays(start, 6)];
      }
      if (preset === "this_month") return [new Date(day.getFullYear(), day.getMonth(), 1), new Date(day.getFullYear(), day.getMonth() + 1, 0)];
      if (preset === "next_month") return [new Date(day.getFullYear(), day.getMonth() + 1, 1), new Date(day.getFullYear(), day.getMonth() + 2, 0)];
      return null;
    };
    const baseOptions = [
      { value: "today", label: "Today" },
      { value: "tomorrow", label: "Tomorrow" },
      { value: "this_week", label: "This week" },
      { value: "this_weekend", label: "This weekend" },
      { value: "next_week", label: "Next week" },
      { value: "this_month", label: "This month" },
      { value: "next_month", label: "Next month" },
      { value: "all", label: "All time" },
    ];
    const options = [...baseOptions];
    ["upcoming", "past"].forEach((value) => {
      const oldOption = [...select.options].find((option) => option.value === value);
      if (oldOption) options.push({ value, label: oldOption.textContent.trim() });
    });
    let applied = { value: select.value || "all", start: "", end: "" };
    let pending = { ...applied };
    let shownMonth = new Date(today.getFullYear(), today.getMonth(), 1);

    function setPending(value, bounds = null) {
      if (value.startsWith("custom:")) {
        const [, start, end] = value.split(":");
        pending = { value: "custom", start, end };
      } else if (bounds) {
        pending = { value, start: dateString(bounds[0]), end: dateString(bounds[1]) };
      } else if (value === "all" || value === "upcoming" || value === "past") {
        pending = { value, start: "", end: "" };
      } else {
        const presetBounds = rangeFor(value);
        pending = presetBounds
          ? { value, start: dateString(presetBounds[0]), end: dateString(presetBounds[1]) }
          : { value: "custom", start: "", end: "" };
      }
      startInput.value = pending.start;
      endInput.value = pending.end;
      if (pending.start) {
        const parsed = parseDate(pending.start);
        if (parsed) shownMonth = new Date(parsed.getFullYear(), parsed.getMonth(), 1);
      }
      error.textContent = "";
      renderCalendars();
    }
    function syncPicker() {
      const start = startInput.value.trim();
      const end = endInput.value.trim();
      const startDate = start ? parseDate(start) : null;
      const endDate = end ? parseDate(end) : null;
      if ((start && !startDate) || (end && !endDate)) {
        error.textContent = "Enter a valid date (YYYY-MM-DD).";
      } else if (startDate && endDate && start && end && start > end) {
        error.textContent = "Start date must be on or before end date.";
      } else {
        error.textContent = "";
      }
      const unchanged = pending.value === applied.value
        && pending.start === applied.start
        && pending.end === applied.end;
      panel.querySelector(".date-range-apply").disabled = Boolean(error.textContent) || unchanged;
      quick.querySelectorAll("button").forEach((button) => {
        const active = button.dataset.value === pending.value;
        button.classList.toggle("active", active);
        button.setAttribute("aria-pressed", String(active));
      });
      monthsElement.querySelectorAll(".date-range-day").forEach((button) => {
        const value = button.dataset.date;
        const selected = value === pending.start || value === pending.end;
        button.classList.toggle("selected", selected);
        button.classList.toggle("in-range", Boolean(pending.start && pending.end && value > pending.start && value < pending.end));
        if (selected) button.setAttribute("aria-pressed", "true");
        else button.setAttribute("aria-pressed", "false");
      });
    }
    function renderMonth(monthDate, index) {
      const year = monthDate.getFullYear();
      const month = monthDate.getMonth();
      const section = document.createElement("section");
      section.className = "date-range-month";
      section.setAttribute("aria-label", monthDate.toLocaleDateString("en-US", { month: "long", year: "numeric" }));
      const title = document.createElement("h3");
      title.className = "date-range-month-title";
      title.textContent = monthDate.toLocaleDateString("en-US", { month: "long", year: "numeric" });
      section.appendChild(title);
      const weekdayRow = document.createElement("div");
      weekdayRow.className = "date-range-weekdays";
      weekdayRow.setAttribute("aria-hidden", "true");
      ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].forEach((label) => {
        const weekday = document.createElement("span");
        weekday.textContent = label;
        weekdayRow.appendChild(weekday);
      });
      section.appendChild(weekdayRow);
      const grid = document.createElement("div");
      grid.className = "date-range-days";
      grid.setAttribute("role", "grid");
      const first = new Date(year, month, 1);
      for (let blank = 0; blank < first.getDay(); blank += 1) {
        const spacer = document.createElement("span");
        spacer.className = "date-range-empty-day";
        spacer.setAttribute("aria-hidden", "true");
        grid.appendChild(spacer);
      }
      const count = new Date(year, month + 1, 0).getDate();
      for (let day = 1; day <= count; day += 1) {
        const value = `${year}-${pad(month + 1)}-${pad(day)}`;
        const button = document.createElement("button");
        button.type = "button";
        button.className = "date-range-day";
        button.dataset.date = value;
        button.textContent = String(day);
        button.setAttribute("role", "gridcell");
        button.setAttribute("aria-label", new Date(year, month, day).toLocaleDateString("en-US", { dateStyle: "full" }));
        button.classList.toggle("is-today", value === dateString(today));
        button.addEventListener("click", () => {
          if (!pending.start || pending.end) {
            pending = { value: "custom", start: value, end: "" };
          } else if (value < pending.start) {
            pending = { value: "custom", start: value, end: pending.start };
          } else {
            pending = { value: "custom", start: pending.start, end: value };
          }
          startInput.value = pending.start;
          endInput.value = pending.end;
          error.textContent = "";
          renderCalendars();
          monthsElement.querySelector(`[data-date="${pending.end || pending.start}"]`)?.focus();
        });
        grid.appendChild(button);
      }
      section.appendChild(grid);
      if (index > 0) section.classList.add("date-range-next-month");
      return section;
    }
    function renderCalendars() {
      monthsElement.replaceChildren();
      const previous = document.createElement("button");
      previous.type = "button";
      previous.className = "date-range-month-nav date-range-previous";
      previous.setAttribute("aria-label", "Previous month");
      previous.textContent = "\u2039";
      previous.addEventListener("click", () => {
        shownMonth = new Date(shownMonth.getFullYear(), shownMonth.getMonth() - 1, 1);
        renderCalendars();
        monthsElement.querySelector(".date-range-previous")?.focus();
      });
      const next = document.createElement("button");
      next.type = "button";
      next.className = "date-range-month-nav date-range-next";
      next.setAttribute("aria-label", "Next month");
      next.textContent = "\u203a";
      next.addEventListener("click", () => {
        shownMonth = new Date(shownMonth.getFullYear(), shownMonth.getMonth() + 1, 1);
        renderCalendars();
        monthsElement.querySelector(".date-range-next")?.focus();
      });
      monthsElement.append(previous, renderMonth(shownMonth, 0), renderMonth(new Date(shownMonth.getFullYear(), shownMonth.getMonth() + 1, 1), 1), next);
      syncPicker();
    }
    options.forEach(({ value, label }) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "date-range-quick-option";
      button.dataset.value = value;
      button.textContent = label;
      button.addEventListener("click", () => {
        if (value === "all" || value === "upcoming" || value === "past") setPending(value);
        else setPending(value, rangeFor(value));
      });
      quick.appendChild(button);
    });
    [startInput, endInput].forEach((input) => input.addEventListener("input", () => {
      const start = startInput.value.trim();
      const end = endInput.value.trim();
      pending = start || end ? { value: "custom", start, end } : { value: "all", start: "", end: "" };
      const enteredDate = parseDate(pending.start) || parseDate(pending.end);
      if (enteredDate) shownMonth = new Date(enteredDate.getFullYear(), enteredDate.getMonth(), 1);
      error.textContent = "";
      renderCalendars();
    }));
    function triggerLabel(selection) {
      if (selection.value === "all") return "All Dates";
      if (selection.value === "upcoming" || selection.value === "past")
        return options.find((option) => option.value === selection.value)?.label || selection.value;
      const preset = options.find((option) => option.value === selection.value);
      if (preset) return preset.label;
      if (selection.start && selection.end) {
        const start = parseDate(selection.start);
        const end = parseDate(selection.end);
        if (start && end) {
          const startLabel = start.toLocaleDateString("en-US", { month: "short", day: "numeric" });
          const endLabel = end.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
          return selection.start === selection.end ? endLabel : `${startLabel} \u2013 ${endLabel}`;
        }
      }
      return "Custom range";
    }
    function validCustomRange() {
      const start = startInput.value.trim();
      const end = endInput.value.trim();
      if (!start && !end) return { value: "all", start: "", end: "" };
      const startDate = parseDate(start || end);
      const endDate = parseDate(end || start);
      if (!startDate || !endDate) {
        error.textContent = "Enter a valid date (YYYY-MM-DD).";
        return null;
      }
      if (start && end && start > end) {
        error.textContent = "Start date must be on or before end date.";
        return null;
      }
      return { value: "custom", start: start || end, end: end || start };
    }
    function closePicker(restore, returnFocus = true) {
      panel.hidden = true;
      trigger.setAttribute("aria-expanded", "false");
      if (restore) {
        pending = { ...applied };
        if (pending.start) {
          const parsed = parseDate(pending.start);
          if (parsed) shownMonth = new Date(parsed.getFullYear(), parsed.getMonth(), 1);
        }
        startInput.value = pending.start;
        endInput.value = pending.end;
        error.textContent = "";
      }
      if (returnFocus) trigger.focus();
    }
    function positionPanel() {
      if (panel.hidden) return;
      const rect = trigger.getBoundingClientRect();
      const margin = 8;
      const width = Math.min(720, window.innerWidth - margin * 2);
      panel.style.width = `${width}px`;
      panel.style.left = `${Math.max(margin, Math.min(rect.left, window.innerWidth - width - margin))}px`;
      const height = panel.getBoundingClientRect().height;
      const below = rect.bottom + height + margin <= window.innerHeight;
      const top = below ? rect.bottom + margin : rect.top - height - margin;
      panel.style.top = `${Math.max(margin, Math.min(top, window.innerHeight - height - margin))}px`;
    }
    function openPicker() {
      pending = { ...applied };
      startInput.value = pending.start;
      endInput.value = pending.end;
      if (pending.start) {
        const parsed = parseDate(pending.start);
        if (parsed) shownMonth = new Date(parsed.getFullYear(), parsed.getMonth(), 1);
      } else shownMonth = new Date(today.getFullYear(), today.getMonth(), 1);
      error.textContent = "";
      renderCalendars();
      panel.hidden = false;
      trigger.setAttribute("aria-expanded", "true");
      positionPanel();
      startInput.focus();
    }
    trigger.addEventListener("click", () => panel.hidden ? openPicker() : closePicker(true));
    panel.querySelector(".date-range-close").addEventListener("click", () => closePicker(true));
    panel.querySelector(".date-range-cancel").addEventListener("click", () => closePicker(true));
    panel.querySelector(".date-range-clear").addEventListener("click", () => setPending("all"));
    panel.querySelector(".date-range-apply").addEventListener("click", () => {
      let selection = pending;
      if (pending.value === "custom") {
        selection = validCustomRange();
        if (!selection) return;
      }
      applied = { ...selection };
      let value = selection.value;
      if (value === "custom") value = `custom:${selection.start}:${selection.end}`;
      if (![...select.options].some((option) => option.value === value)) {
        select.add(new Option(triggerLabel(selection), value));
      }
      select.value = value;
      trigger.textContent = triggerLabel(selection);
      trigger.setAttribute("aria-label", `Date filter: ${trigger.textContent}`);
      select.dispatchEvent(new Event("change", { bubbles: true }));
      panel.hidden = true;
      trigger.setAttribute("aria-expanded", "false");
      trigger.focus();
    });
    document.addEventListener("click", (event) => {
      if (!panel.hidden && !wrapper.contains(event.target) && !panel.contains(event.target)) closePicker(true, false);
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !panel.hidden) {
        event.preventDefault();
        closePicker(true);
      }
    });
    window.addEventListener("resize", positionPanel);
    window.addEventListener("scroll", positionPanel, true);
    select.classList.add("date-range-native-select");
    select.setAttribute("aria-hidden", "true");
    select.tabIndex = -1;
    select.hidden = true;
    if (select.parentElement !== host) host.appendChild(select);
    host.insertBefore(wrapper, select);
    const currentValue = select.value || "all";
    setPending(currentValue);
    applied = { ...pending };
    trigger.textContent = triggerLabel(applied);
    trigger.setAttribute("aria-label", `Date filter: ${trigger.textContent}`);
    renderCalendars();
  }

  function setupTeacherFilterDropdowns() {
    const wrappers = [];
    function closeMenus(except) {
      wrappers.forEach(({ wrapper, button, menu }) => {
        if (wrapper === except) return;
        menu.classList.remove("show");
        button.setAttribute("aria-expanded", "false");
      });
    }

    [statusFilter].forEach((select) => {
      if (!select) return;
      const wrapper = document.createElement("div");
      const button = document.createElement("button");
      const menu = document.createElement("div");
      const menuId = `${select.id}Dropdown`;
      wrapper.className = "filter-dropdown";
      button.className = "filter-button";
      button.type = "button";
      button.id = `${menuId}Button`;
      button.setAttribute("aria-haspopup", "listbox");
      button.setAttribute("aria-expanded", "false");
      button.setAttribute(
        "aria-label",
        select.previousElementSibling?.textContent || "Filter events",
      );
      button.setAttribute("aria-controls", menuId);
      menu.className = "filter-menu";
      menu.id = menuId;
      menu.setAttribute("role", "listbox");
      menu.setAttribute("aria-labelledby", button.id);

      [...select.options].forEach((option) => {
        const item = document.createElement("button");
        item.className = `filter-option${option.selected ? " active" : ""}`;
        item.type = "button";
        item.setAttribute("role", "option");
        item.setAttribute("aria-selected", String(option.selected));
        item.dataset.value = option.value;
        item.textContent = option.textContent.trim();
        menu.appendChild(item);
      });

      function syncSelection() {
        const selected = select.options[select.selectedIndex];
        button.childNodes[0]?.remove();
        button.insertBefore(
          document.createTextNode(selected ? selected.textContent.trim() : ""),
          button.firstChild,
        );
        menu.querySelectorAll(".filter-option").forEach((item) => {
          const active = item.dataset.value === select.value;
          item.classList.toggle("active", active);
          item.setAttribute("aria-selected", String(active));
        });
      }
      syncSelection();
      select.classList.add("teacher-native-filter-select");
      select.setAttribute("aria-hidden", "true");
      select.tabIndex = -1;
      select.hidden = true;
      select.parentElement.classList.add("teacher-has-custom-filter");
      select.parentNode.insertBefore(wrapper, select);
      wrapper.append(button, menu, select);
      wrappers.push({ wrapper, button, menu });

      button.addEventListener("click", (event) => {
        event.stopPropagation();
        const wasOpen = menu.classList.contains("show");
        closeMenus();
        if (!wasOpen) {
          menu.classList.add("show");
          button.setAttribute("aria-expanded", "true");
        }
      });
      menu.addEventListener("click", (event) => {
        const item = event.target.closest(".filter-option");
        if (!item) return;
        event.stopPropagation();
        select.value = item.dataset.value;
        select.dispatchEvent(new Event("change", { bubbles: true }));
        syncSelection();
        closeMenus();
        button.focus();
      });
      select.addEventListener("change", syncSelection);
    });

    document.addEventListener("click", (event) => {
      if (!event.target.closest(".my-events-filter .filter-dropdown")) {
        closeMenus();
      }
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeMenus();
    });
  }

  setupTeacherFilterDropdowns();
  createDateRangePicker(dateFilter.parentElement, dateFilter);

  [searchInput, statusFilter, dateFilter].forEach((element) => {
    element?.addEventListener("input", render);
    element?.addEventListener("change", render);
  });

  modal?.addEventListener("click", (event) => {
    if (event.target.hasAttribute("data-modal-close")) {
      modal.hidden = true;
      document.body.classList.remove("modal-open");
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && modal && !modal.hidden) {
      modal.hidden = true;
      document.body.classList.remove("modal-open");
    }
  });

  let teacher = null;
  try {
    teacher = JSON.parse(localStorage.getItem("recovibeCurrentTeacher") || "null");
  } catch (error) {
    console.warn("Unable to read teacher account:", error);
  }
  if (teacher) {
    const name = teacher.name || teacher.fullName || "Teacher";
    const nameEl = document.getElementById("userName");
    const roleEl = document.getElementById("userRole");
    const avatarEl = document.getElementById("userAvatar");
    if (nameEl) nameEl.textContent = name;
    if (roleEl) roleEl.textContent = "Teacher";
    if (avatarEl) {
      avatarEl.textContent = name.split(/\s+/).filter(Boolean).map((part) => part[0]).slice(0, 2).join("").toUpperCase();
    }
  }

  document.getElementById("organizerLogout")?.addEventListener("click", async (event) => {
    event.preventDefault();
    cleanupListeners();
    try {
      if (auth) await signOut(auth);
    } finally {
      localStorage.removeItem("recovibeCurrentTeacher");
      localStorage.removeItem("recovibeTeacherId");
      location.assign("TeacherLogin.html");
    }
  });

  window.addEventListener("beforeunload", cleanupListeners);

  onAuthStateChanged(auth, async (user) => {
    cleanupListeners();
    if (!user || !rtdb) {
      location.replace("TeacherLogin.html");
      return;
    }
    try {
      const roleSnapshot = await get(ref(rtdb, `roles/${user.uid}`));
      if (roleSnapshot.val() !== "teacher") {
        location.replace("TeacherLogin.html");
        return;
      }
      teacherUid = user.uid;
      listenToMyEvents(teacherUid);
    } catch (error) {
      console.error("Could not verify teacher role:", error);
      showNotice("Couldn't verify your account. Please sign in again.");
      loadErrorOccurred = true;
      indexLoaded = true;
      draftsLoaded = true;
      render();
      signalPageReadyIfLoaded();
    }
  });
})();
