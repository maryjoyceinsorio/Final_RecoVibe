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
  let loadErrorOccurred = false;
  let missingNewTimer = null;

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
      const matchesDate =
        selectedDate === "all" ||
        (validDate && (selectedDate === "upcoming" ? date >= today : date < today));

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
      showNotice("Couldn't load your events.");
      render();
      return;
    }

    indexRef = ref(rtdb, `organizerEvents/${uid}`);
    onValue(
      indexRef,
      (snapshot) => {
        indexLoaded = true;
        const ids = new Set(Object.keys(snapshot.val() || {}));
        [...activeRefs.keys()].forEach((idKey) => {
          const rawId = idKey.split(":")[0];
          if (!ids.has(rawId)) {
            off(activeRefs.get(idKey));
            activeRefs.delete(idKey);
            eventsById.delete(rawId);
            approvalsById.delete(rawId);
          }
        });

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
            },
            (error) => {
              console.error("Could not load owned teacher event:", error);
              loadErrorOccurred = true;
              renderOwnedEvents();
            },
          );

          onValue(approvalRef, (approvalSnapshot) => {
            if (approvalSnapshot.exists()) {
              approvalsById.set(id, approvalSnapshot.val());
            }
            renderOwnedEvents();
          });

          activeRefs.set(id, eventRef);
          activeRefs.set(`${id}:approval`, approvalRef);
        });

        renderOwnedEvents();
      },
      (error) => {
        console.error("Could not load teacher event index:", error);
        loadErrorOccurred = true;
        renderOwnedEvents();
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
      },
      (error) => {
        console.error("Could not load teacher drafts:", error);
        loadErrorOccurred = true;
        renderOwnedEvents();
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

  function setupTeacherFilterDropdowns() {
    const wrappers = [];
    function closeMenus(except) {
      wrappers.forEach(({ wrapper, button, menu }) => {
        if (wrapper === except) return;
        menu.classList.remove("show");
        button.setAttribute("aria-expanded", "false");
      });
    }

    [statusFilter, dateFilter].forEach((select) => {
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
    if (roleEl) roleEl.textContent = teacher.department || teacher.organization || "Faculty account";
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
    }
  });
})();
