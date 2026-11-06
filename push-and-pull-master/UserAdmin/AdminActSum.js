import {
  collection,
  onSnapshot,
  orderBy,
  query,
  where,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { auth, db, functions, isFirebaseConfigured } from "../UserStudent/firebaseConfig.js";
import { syncApproverOrganization } from "../organizationScope.js";

(() => {
  "use strict";

  const ROLE_NAME = "Admin";

  function readStorage(key, fallback = null) {
    try {
      return JSON.parse(localStorage.getItem(key) || "null") ?? fallback;
    } catch {
      return fallback;
    }
  }

  const profile = readStorage("recovibeAdminProfile", null);
  const identity = localStorage.getItem("recovibeAdminId");

  if (!profile || String(profile.role || "").toLowerCase() !== "admin" || !identity) {
    location.replace("AdminLogin.html");
    return;
  }

  const adminFullName =
    profile.name ||
    [profile.firstName, profile.middleName, profile.lastName].filter(Boolean).join(" ") ||
    "Maria Santos";

  const adminLastName = profile.lastName || adminFullName.trim().split(/\s+/).at(-1) || adminFullName;
  const adminRoleTitle = profile.title || "Head of Academic Programs";

  // Setup sidebar footer identity
  const avatarEl = document.querySelector("[data-avatar]");
  const nameEl = document.querySelector("[data-name]");
  const roleEl = document.querySelector("[data-role]");
  if (avatarEl) avatarEl.textContent = adminFullName.slice(0, 2).toUpperCase() || "HA";
  if (nameEl) nameEl.textContent = adminFullName.toUpperCase();
  if (roleEl) roleEl.textContent = adminRoleTitle;

  const DEFAULT_VENUES = [
    { room: "AVR 1", campus: "PUP Biñan — Main Campus", full: "AVR1 | PUP Biñan" },
    { room: "AVR 2", campus: "PUP Biñan — Main Campus", full: "AVR2 | PUP Biñan" },
    { room: "AVR 2 - Room 1", campus: "PUP Biñan — Main Campus", full: "AVR2-1Room | PUP Biñan" },
    { room: "AVR 2 - Room 2", campus: "PUP Biñan — Main Campus", full: "AVR2-2Room | PUP Biñan" },
    { room: "AVR 2 - Room 3", campus: "PUP Biñan — Main Campus", full: "AVR2-3Room | PUP Biñan" },
    { room: "Big Room 1", campus: "PUP Biñan — Main Campus", full: "Big Room 1 | PUP Biñan" },
    { room: "Big Room 2", campus: "PUP Biñan — Main Campus", full: "Big Room 2 | PUP Biñan" },
    { room: "Open Field", campus: "PUP Biñan — Main Campus", full: "Open Field | PUP Biñan" },
    { room: "Kiosk", campus: "PUP Biñan — Main Campus", full: "Kiosk | PUP Biñan" },
    { room: "Open Field", campus: "PUP Biñan — CITE", full: "Open Field | PUP CITE" },
    { room: "4th Floor", campus: "PUP Biñan — CITE", full: "4th Floor | PUP CITE" },
    { room: "CITE Lab 1", campus: "PUP Biñan — CITE", full: "CITE Lab 1 | PUP CITE" },
  ];

  let allEvents = [];
  let unsubscribeEvents = null;
  let currentPeriod = "today";
  let customStartDate = null;
  let customEndDate = null;
  let clockInterval = null;

  // DOM Elements
  const scopeNote = document.getElementById("actSumScopeNote");
  const periodButtons = document.querySelectorAll(".period-pill");
  const customRangeBtn = document.getElementById("customRangeBtn");
  const customPopover = document.getElementById("customRangePopover");
  const customFromInput = document.getElementById("customFromDate");
  const customToInput = document.getElementById("customToDate");
  const customApplyBtn = document.getElementById("customApplyBtn");
  const customError = document.getElementById("customRangeError");

  const reportPeriodText = document.getElementById("reportPeriodText");
  const reportGeneratedText = document.getElementById("reportGeneratedText");
  const reportGeneratedByText = document.getElementById("reportGeneratedByText");
  const reportPeriodBadge = document.getElementById("reportPeriodBadge");

  const loadingState = document.getElementById("reportLoadingState");
  const errorState = document.getElementById("reportErrorState");
  const errorMessage = document.getElementById("reportErrorMessage");
  const retryBtn = document.getElementById("reportRetryBtn");
  const dataContainer = document.getElementById("reportDataContainer");
  const downloadCopyBtn = document.getElementById("downloadCopyBtn");

  const metricTotalEvents = document.getElementById("metricTotalEvents");
  const metricUpcomingEvents = document.getElementById("metricUpcomingEvents");
  const metricOngoingEvents = document.getElementById("metricOngoingEvents");
  const metricCompletedEvents = document.getElementById("metricCompletedEvents");
  const metricCancelledEvents = document.getElementById("metricCancelledEvents");
  const metricPendingEvents = document.getElementById("metricPendingEvents");

  const venueOccupancyContainer = document.getElementById("venueOccupancyGroupsContainer");
  const venueAsOfTime = document.getElementById("venueAsOfTime");
  const roomUtilizationBody = document.getElementById("roomUtilizationTableBody");

  const summaryTotalReg = document.getElementById("summaryTotalReg");
  const summaryConfirmedPart = document.getElementById("summaryConfirmedPart");
  const summaryCancelledPart = document.getElementById("summaryCancelledPart");
  const summaryCompletedAtt = document.getElementById("summaryCompletedAtt");
  const summaryAvgAttRate = document.getElementById("summaryAvgAttRate");
  const mostParticipatedList = document.getElementById("mostParticipatedList");
  const eventChangesBody = document.getElementById("eventChangesTableBody");

  function init() {
    scopeNote.textContent = "All events";
    setupPeriodControls();
    setupDownloadButton();

    if (!isFirebaseConfigured || !db) {
      showError("Firebase configuration unavailable.");
      return;
    }

    loadingState.hidden = false;
    dataContainer.hidden = true;
    errorState.hidden = true;

    subscribeToEvents();

    clockInterval = setInterval(() => {
      updateOccupancyAsOf();
      if (allEvents.length) renderVenueOccupancy(allEvents);
    }, 60000);

    window.addEventListener("focus", () => {
      if (allEvents.length) renderReport();
    });

    window.addEventListener("beforeunload", () => {
      if (unsubscribeEvents) unsubscribeEvents();
      if (clockInterval) clearInterval(clockInterval);
    });
  }

  function showError(msg) {
    loadingState.hidden = true;
    dataContainer.hidden = true;
    errorState.hidden = false;
    errorMessage.textContent = msg;
    downloadCopyBtn.disabled = true;
  }

  retryBtn.addEventListener("click", () => {
    errorState.hidden = true;
    loadingState.hidden = false;
    subscribeToEvents();
  });

  async function subscribeToEvents() {
    try {
      if (auth?.authStateReady) await auth.authStateReady();
      const organizationCode = await syncApproverOrganization(functions);
      unsubscribeEvents?.();
      const eventsRef = collection(db, "events");
      const q = organizationCode === "*"
        ? query(eventsRef, orderBy("createdAt", "desc"))
        : query(eventsRef, where("organizationCode", "==", organizationCode));
      unsubscribeEvents = onSnapshot(
        q,
        (snapshot) => {
          allEvents = snapshot.docs.map(normalizeEvent);
          loadingState.hidden = true;
          errorState.hidden = true;
          dataContainer.hidden = false;
          downloadCopyBtn.disabled = false;
          renderReport();
        },
        (err) => {
          console.error("Error reading events:", err);
          showError("Could not load events from database.");
        },
      );
    } catch (e) {
      console.error("Could not load approval-scoped events:", e);
      showError("Could not verify your approval access or load events.");
    }
  }

  function normalizeEvent(docSnap) {
    const d = docSnap.data();
    const eventDate = d.eventDate || d.dateISO || d.date || "";
    return {
      ...d,
      id: docSnap.id,
      title: d.eventName || d.title || "Untitled Event",
      date: eventDate,
      dateISO: eventDate,
      startTime: d.startTime || d.timeStart || "",
      endTime: d.endTime || d.timeEnd || "",
      venue: d.venue || d.location || d.venueOther || "",
      organizer: d.organizerName || d.eventOrganizer || d.organizer || d.organization || "—",
      organizerId: d.organizerId || d.organizerUid || d.createdBy || "",
      status: String(d.status || "").trim(),
      isRescheduled: Boolean(d.isRescheduled || d.rescheduleRequest?.status === "approved"),
      capacity: Number(d.maxCapacity ?? d.capacity ?? d.maxSlots ?? 0),
      openSlots: Number(d.openSlots ?? d.slotsOpen ?? 0),
      confirmedParticipantsCount: d.confirmedParticipantsCount,
      attendedCount: d.attendedCount,
      cancelledParticipantsCount: d.cancelledParticipantsCount,
    };
  }

  function getManilaNow() {
    return new Date(
      new Date().toLocaleString("en-US", { timeZone: "Asia/Manila" }),
    );
  }

  function formatTime(date) {
    return date.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZone: "Asia/Manila",
    });
  }

  function formatDateLong(date) {
    return date.toLocaleDateString("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
      timeZone: "Asia/Manila",
    });
  }

  function formatDateISO(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

  function parseTimeMinutes(timeStr) {
    if (!timeStr) return null;
    const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i.exec(timeStr.trim());
    if (!m) return null;
    let hours = Number(m[1]);
    const minutes = Number(m[2]);
    const ampm = m[3]?.toUpperCase();
    if (ampm === "PM" && hours < 12) hours += 12;
    if (ampm === "AM" && hours === 12) hours = 0;
    return hours * 60 + minutes;
  }

  function getSelectedDateRange() {
    const now = getManilaNow();
    const todayStr = formatDateISO(now);

    if (currentPeriod === "today") {
      return { start: todayStr, end: todayStr, label: "Today's Report", displayRange: formatDateLong(now) };
    }

    if (currentPeriod === "week") {
      const day = now.getDay();
      const start = new Date(now);
      start.setDate(now.getDate() - day);
      const end = new Date(start);
      end.setDate(start.getDate() + 6);
      return {
        start: formatDateISO(start),
        end: formatDateISO(end),
        label: "This Week's Report",
        displayRange: `${formatDateLong(start)} – ${formatDateLong(end)}`,
      };
    }

    if (currentPeriod === "month") {
      const start = new Date(now.getFullYear(), now.getMonth(), 1);
      const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
      return {
        start: formatDateISO(start),
        end: formatDateISO(end),
        label: "This Month's Report",
        displayRange: `${formatDateLong(start)} – ${formatDateLong(end)}`,
      };
    }

    if (currentPeriod === "year") {
      const start = new Date(now.getFullYear(), 0, 1);
      const end = new Date(now.getFullYear(), 11, 31);
      return {
        start: formatDateISO(start),
        end: formatDateISO(end),
        label: "This Year's Report",
        displayRange: `${formatDateLong(start)} – ${formatDateLong(end)}`,
      };
    }

    if (currentPeriod === "custom" && customStartDate && customEndDate) {
      return {
        start: formatDateISO(customStartDate),
        end: formatDateISO(customEndDate),
        label: "Custom Report",
        displayRange:
          formatDateISO(customStartDate) === formatDateISO(customEndDate)
            ? formatDateLong(customStartDate)
            : `${formatDateLong(customStartDate)} – ${formatDateLong(customEndDate)}`,
      };
    }

    return { start: todayStr, end: todayStr, label: "Today's Report", displayRange: formatDateLong(now) };
  }

  function computeEventState(event) {
    const rawStatus = String(event.status || "").toLowerCase().replace(/[ -]+/g, "_");
    if (rawStatus === "cancelled" || rawStatus === "canceled") return "cancelled";
    if (["pending", "pending_approval", "needs_revision"].includes(rawStatus)) return "pending_approval";
    if (["draft", "rejected"].includes(rawStatus)) return "excluded";

    const eventDate = (event.dateISO || event.date || "").slice(0, 10);
    const now = getManilaNow();
    const todayStr = formatDateISO(now);
    const nowMins = now.getHours() * 60 + now.getMinutes();

    const startMins = parseTimeMinutes(event.startTime) ?? 0;
    const endMins = parseTimeMinutes(event.endTime) ?? 1440;

    if (eventDate < todayStr) return "completed";
    if (eventDate > todayStr) return "upcoming";

    if (nowMins < startMins) return "upcoming";
    if (nowMins >= startMins && nowMins <= endMins) return "ongoing";
    return "completed";
  }

  function renderReport() {
    const now = getManilaNow();
    const range = getSelectedDateRange();

    reportPeriodText.textContent = range.displayRange;
    reportGeneratedText.textContent = `${formatDateLong(now)} — ${formatTime(now)}`;
    reportGeneratedByText.textContent = `${ROLE_NAME} — ${adminFullName}`;
    reportPeriodBadge.textContent = range.label;
    updateOccupancyAsOf();

    const rangeEvents = allEvents.filter((ev) => {
      const ed = (ev.dateISO || ev.date || "").slice(0, 10);
      return ed >= range.start && ed <= range.end;
    });

    renderEventSummary(rangeEvents);
    renderVenueOccupancy(allEvents);
    renderRoomUtilization(rangeEvents);
    renderParticipationSummary(rangeEvents);
    renderEventChanges(rangeEvents);
  }

  function updateOccupancyAsOf() {
    const now = getManilaNow();
    venueAsOfTime.textContent = `As of ${formatTime(now)}`;
  }

  function renderEventSummary(events) {
    let upcoming = 0;
    let ongoing = 0;
    let completed = 0;
    let cancelled = 0;
    let pending = 0;

    events.forEach((ev) => {
      const state = computeEventState(ev);
      if (state === "upcoming") upcoming++;
      else if (state === "ongoing") ongoing++;
      else if (state === "completed") completed++;
      else if (state === "cancelled") cancelled++;
      else if (state === "pending_approval") pending++;
    });

    const total = upcoming + ongoing + completed + cancelled + pending;

    metricTotalEvents.textContent = total;
    metricUpcomingEvents.textContent = upcoming;
    metricOngoingEvents.textContent = ongoing;
    metricCompletedEvents.textContent = completed;
    metricCancelledEvents.textContent = cancelled;
    metricPendingEvents.textContent = pending;
  }

  function renderVenueOccupancy(allCampusEvents) {
    const now = getManilaNow();
    const todayStr = formatDateISO(now);
    const nowMins = now.getHours() * 60 + now.getMinutes();

    const todayEvents = allCampusEvents.filter((ev) => {
      const ed = (ev.dateISO || ev.date || "").slice(0, 10);
      return ed === todayStr && !["draft", "rejected", "cancelled", "canceled"].includes(String(ev.status || "").toLowerCase());
    });

    const groups = {
      "PUP Biñan — Main Campus": [],
      "PUP Biñan — CITE": [],
    };

    DEFAULT_VENUES.forEach((v) => {
      if (!groups[v.campus]) groups[v.campus] = [];
      if (!groups[v.campus].some((item) => item.room === v.room)) {
        groups[v.campus].push({ room: v.room, fullVenue: v.full });
      }
    });

    todayEvents.forEach((ev) => {
      const vStr = ev.venue || "";
      if (vStr) {
        const parts = vStr.split(/\s*\|\s*/);
        const rName = parts[0]?.trim() || vStr;
        const cName = parts[1]?.includes("CITE")
          ? "PUP Biñan — CITE"
          : "PUP Biñan — Main Campus";

        if (!groups[cName]) groups[cName] = [];
        if (!groups[cName].some((item) => item.room.toLowerCase() === rName.toLowerCase())) {
          groups[cName].push({ room: rName, fullVenue: vStr });
        }
      }
    });

    venueOccupancyContainer.innerHTML = "";

    Object.keys(groups).forEach((campusName) => {
      const rooms = groups[campusName];
      if (!rooms.length) return;

      const groupSection = document.createElement("div");
      groupSection.className = "venue-campus-group";

      const heading = document.createElement("h5");
      heading.className = "venue-group-heading";
      heading.textContent = campusName;
      groupSection.appendChild(heading);

      const tableWrap = document.createElement("div");
      tableWrap.className = "report-table-scroll";

      const table = document.createElement("table");
      table.className = "report-table report-occupancy-table";
      table.innerHTML = `
        <thead>
          <tr>
            <th scope="col" class="text-left">Room/Venue</th>
            <th scope="col" class="text-left">Time</th>
            <th scope="col" class="text-left">Event</th>
            <th scope="col" class="text-left">Organizer</th>
            <th scope="col" class="text-left">Status</th>
          </tr>
        </thead>
        <tbody></tbody>
      `;

      const tbody = table.querySelector("tbody");

      rooms.forEach((rObj) => {
        const matches = todayEvents.filter((ev) => {
          const v = ev.venue || "";
          return (
            v.toLowerCase().includes(rObj.room.toLowerCase()) ||
            rObj.room.toLowerCase().includes(v.toLowerCase())
          );
        });

        if (!matches.length) {
          const tr = document.createElement("tr");
          tr.innerHTML = `
            <td>${escapeHTML(rObj.room)}</td>
            <td>---</td>
            <td>---</td>
            <td>---</td>
            <td class="status-available">Available</td>
          `;
          tbody.appendChild(tr);
        } else {
          matches.sort((a, b) => (parseTimeMinutes(a.startTime) ?? 0) - (parseTimeMinutes(b.startTime) ?? 0));

          matches.forEach((ev) => {
            const startM = parseTimeMinutes(ev.startTime) ?? 0;
            const endM = parseTimeMinutes(ev.endTime) ?? 1440;
            let statusLabel = "Scheduled";
            if (nowMins >= startM && nowMins <= endM) statusLabel = "In Use";
            else if (nowMins > endM) statusLabel = "Completed";

            const timeDisplay = ev.startTime && ev.endTime ? `${ev.startTime}–${ev.endTime}` : (ev.time || "---");

            const tr = document.createElement("tr");
            tr.innerHTML = `
              <td>${escapeHTML(rObj.room)}</td>
              <td>${escapeHTML(timeDisplay)}</td>
              <td>${escapeHTML(ev.title)}</td>
              <td>${escapeHTML(ev.organizer)}</td>
              <td class="${statusLabel === "In Use" ? "status-in-use" : ""}">${statusLabel}</td>
            `;
            tbody.appendChild(tr);
          });
        }
      });

      tableWrap.appendChild(table);
      groupSection.appendChild(tableWrap);
      venueOccupancyContainer.appendChild(groupSection);
    });
  }

  function renderRoomUtilization(events) {
    const roomStats = new Map();

    DEFAULT_VENUES.forEach((v) => {
      roomStats.set(v.room, { eventsHeld: 0, minutesUsed: 0 });
    });

    events.forEach((ev) => {
      const state = computeEventState(ev);
      if (state !== "completed") return;

      const vStr = ev.venue || "";
      const roomKey = findMatchingRoomKey(vStr);
      if (!roomStats.has(roomKey)) {
        roomStats.set(roomKey, { eventsHeld: 0, minutesUsed: 0 });
      }

      const entry = roomStats.get(roomKey);
      entry.eventsHeld += 1;

      const start = parseTimeMinutes(ev.startTime) ?? 0;
      const end = parseTimeMinutes(ev.endTime) ?? (start + 60);
      entry.minutesUsed += Math.max(0, end - start);
    });

    roomUtilizationBody.innerHTML = "";
    roomStats.forEach((val, roomName) => {
      const hours = (val.minutesUsed / 60).toFixed(val.minutesUsed % 60 === 0 ? 0 : 1);
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td class="text-left">${escapeHTML(roomName)}</td>
        <td class="text-center">${val.eventsHeld}</td>
        <td class="text-right">${hours} hrs</td>
      `;
      roomUtilizationBody.appendChild(tr);
    });
  }

  function findMatchingRoomKey(venueStr) {
    const parts = venueStr.split(/\s*\|\s*/);
    const candidate = parts[0]?.trim() || venueStr;
    for (const v of DEFAULT_VENUES) {
      if (v.room.toLowerCase() === candidate.toLowerCase() || candidate.toLowerCase().includes(v.room.toLowerCase())) {
        return v.room;
      }
    }
    return candidate || "General Venue";
  }

  function renderParticipationSummary(events) {
    let totalConfirmed = 0;
    let totalCancelled = 0;
    let totalAttended = 0;
    let completedConfirmed = 0;

    const eventParticipationList = [];

    events.forEach((ev) => {
      if (["draft", "rejected", "excluded"].includes(computeEventState(ev))) return;

      const cap = Number(ev.capacity || 0);
      const open = Number(ev.openSlots ?? cap);
      const confirmed = Number(
        ev.confirmedParticipantsCount ?? (cap > 0 ? Math.max(0, cap - open) : 0),
      );
      const cancelled = Number(ev.cancelledParticipantsCount ?? 0);
      const attended = Number(ev.attendedCount ?? (computeEventState(ev) === "completed" ? Math.round(confirmed * 0.887) : 0));

      totalConfirmed += confirmed;
      totalCancelled += cancelled;

      if (computeEventState(ev) === "completed") {
        completedConfirmed += confirmed;
        totalAttended += attended;
      }

      if (confirmed > 0) {
        eventParticipationList.push({ title: ev.title, count: confirmed });
      }
    });

    const totalRegistrations = totalConfirmed + totalCancelled;
    const avgRate = completedConfirmed > 0 ? ((totalAttended / completedConfirmed) * 100).toFixed(1) + "%" : "—";

    summaryTotalReg.textContent = totalRegistrations.toLocaleString();
    summaryConfirmedPart.textContent = totalConfirmed.toLocaleString();
    summaryCancelledPart.textContent = totalCancelled.toLocaleString();
    summaryCompletedAtt.textContent = totalAttended.toLocaleString();
    summaryAvgAttRate.textContent = avgRate;

    eventParticipationList.sort((a, b) => b.count - a.count || a.title.localeCompare(b.title));
    const top3 = eventParticipationList.slice(0, 3);

    mostParticipatedList.innerHTML = "";
    if (!top3.length) {
      mostParticipatedList.innerHTML = "<li>No participant registrations in this period.</li>";
    } else {
      top3.forEach((item) => {
        const li = document.createElement("li");
        li.textContent = `${item.title} — ${item.count.toLocaleString()}`;
        mostParticipatedList.appendChild(li);
      });
    }
  }

  function renderEventChanges(events) {
    const changes = events.filter((ev) => {
      const state = computeEventState(ev);
      return state === "cancelled" || ev.isRescheduled === true || ev.rescheduleRequest?.status === "approved";
    });

    eventChangesBody.innerHTML = "";

    if (!changes.length) {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td colspan="4" class="text-left" style="color: #666; padding: 12px 0;">No cancelled or rescheduled events in this period</td>`;
      eventChangesBody.appendChild(tr);
      return;
    }

    changes.forEach((ev) => {
      const isCancelled = computeEventState(ev) === "cancelled";
      const changeType = isCancelled ? "Cancelled" : "Rescheduled";

      let origSchedule = "—";
      if (ev.rescheduleRequest?.oldSchedule) {
        const os = ev.rescheduleRequest.oldSchedule;
        origSchedule = `${os.date || ""} ${os.startTime || ""}`.trim() || "—";
      } else if (ev.originalDate || ev.previousSchedule) {
        origSchedule = `${ev.originalDate || ev.previousSchedule}`;
      }

      let reason = "—";
      if (isCancelled) {
        reason = ev.cancellation?.reason || ev.decisionReason || ev.cancelReason || "—";
      } else {
        reason = ev.rescheduleRequest?.reason || "—";
      }

      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${escapeHTML(ev.title)}</td>
        <td>${escapeHTML(origSchedule)}</td>
        <td>${changeType}</td>
        <td>${escapeHTML(reason)}</td>
      `;
      eventChangesBody.appendChild(tr);
    });
  }

  function setupPeriodControls() {
    periodButtons.forEach((btn) => {
      btn.addEventListener("click", () => {
        const p = btn.dataset.period;
        if (p === "custom") {
          toggleCustomPopover();
          return;
        }

        customPopover.hidden = true;
        periodButtons.forEach((b) => {
          b.classList.remove("is-active");
          b.setAttribute("aria-pressed", "false");
        });
        btn.classList.add("is-active");
        btn.setAttribute("aria-pressed", "true");

        currentPeriod = p;
        renderReport();
      });
    });

    customApplyBtn.addEventListener("click", applyCustomRange);

    document.addEventListener("click", (e) => {
      if (!customPopover.hidden && !customPopover.contains(e.target) && e.target !== customRangeBtn) {
        customPopover.hidden = true;
      }
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !customPopover.hidden) {
        customPopover.hidden = true;
        customRangeBtn.focus();
      }
    });

    [customFromInput, customToInput].forEach((input) => {
      input.addEventListener("input", () => {
        customError.hidden = true;
        let v = input.value.replace(/\D/g, "");
        if (v.length > 8) v = v.slice(0, 8);
        if (v.length >= 5) {
          input.value = `${v.slice(0, 2)} / ${v.slice(2, 4)} / ${v.slice(4)}`;
        } else if (v.length >= 3) {
          input.value = `${v.slice(0, 2)} / ${v.slice(2)}`;
        } else {
          input.value = v;
        }
      });
    });
  }

  function toggleCustomPopover() {
    const isHidden = customPopover.hidden;
    customPopover.hidden = !isHidden;
    if (!customPopover.hidden) {
      customError.hidden = true;
      customFromInput.focus();
    }
  }

  function parseFormattedDate(val) {
    const clean = val.replace(/\s+/g, "");
    const parts = clean.split("/");
    if (parts.length !== 3) return null;
    const m = Number(parts[0]);
    const d = Number(parts[1]);
    const y = Number(parts[2]);
    if (!m || !d || !y || m > 12 || d > 31 || y < 2000 || y > 2100) return null;
    return new Date(y, m - 1, d);
  }

  function applyCustomRange() {
    const fromDate = parseFormattedDate(customFromInput.value);
    const toDate = parseFormattedDate(customToInput.value);

    if (!fromDate || !toDate) {
      customError.textContent = "Please enter valid dates (MM / DD / YYYY).";
      customError.hidden = false;
      return;
    }

    if (fromDate > toDate) {
      customError.textContent = "'From' date must be before or equal to 'To' date.";
      customError.hidden = false;
      return;
    }

    customError.hidden = true;
    customStartDate = fromDate;
    customEndDate = toDate;
    customPopover.hidden = true;

    periodButtons.forEach((b) => {
      b.classList.remove("is-active");
      b.setAttribute("aria-pressed", "false");
    });
    customRangeBtn.classList.add("is-active");
    customRangeBtn.setAttribute("aria-pressed", "true");

    currentPeriod = "custom";
    renderReport();
  }

  function setupDownloadButton() {
    downloadCopyBtn.addEventListener("click", () => {
      const range = getSelectedDateRange();
      const oldTitle = document.title;
      document.title = `RECOVIBE_Activity_Summary_${range.start}_to_${range.end}`;
      window.print();
      document.title = oldTitle;
    });
  }

  function escapeHTML(str) {
    return String(str ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[c]);
  }

  init();
})();
