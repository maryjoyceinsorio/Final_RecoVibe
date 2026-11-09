import {
  collection,
  onSnapshot,
  orderBy,
  query,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { auth, db, isFirebaseConfigured } from "../UserStudent/firebaseConfig.js";

(() => {
  "use strict";

  const ROLE_NAME = "Super Admin";

  function readStorage(key, fallback = null) {
    try {
      return JSON.parse(localStorage.getItem(key) || "null") ?? fallback;
    } catch {
      return fallback;
    }
  }

  // Profile resolution
  let superAdminFullName = "Super Admin";
  let superAdminRoleTitle = "Super Admin account";

  const savedProfile =
    readStorage("recovibeSuperAdminProfile", null) ||
    readStorage("recovibeAdminProfile", null);
  if (savedProfile) {
    const fn =
      [savedProfile.firstName, savedProfile.middleName, savedProfile.lastName]
        .filter(Boolean)
        .join(" ") ||
      savedProfile.name ||
      savedProfile.fullName;
    if (fn) superAdminFullName = fn;
  }

  const avatarEl = document.getElementById("sidebar-user-avatar");
  const nameEl = document.getElementById("sidebar-user-name");
  const roleEl = document.getElementById("sidebar-user-role");

  function updateSidebarProfile(fullName, role) {
    if (nameEl) nameEl.textContent = fullName;
    if (roleEl) roleEl.textContent = role;
    if (avatarEl) {
      avatarEl.textContent = fullName.trim().charAt(0).toUpperCase() || "S";
    }
  }

  updateSidebarProfile(superAdminFullName, superAdminRoleTitle);

  window.addEventListener("superadmin-profile-authorized", (event) => {
    const { profile, user } = event.detail || {};
    if (profile) {
      const fn =
        [profile.firstName, profile.middleName, profile.lastName]
          .filter(Boolean)
          .join(" ") ||
        profile.name ||
        profile.fullName ||
        user?.displayName ||
        superAdminFullName;
      superAdminFullName = fn;
      superAdminRoleTitle = "Super Admin account";
      updateSidebarProfile(superAdminFullName, superAdminRoleTitle);
      updateReportHeaderMeta();
    }
  });

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

  const eventChangesTableBody = document.getElementById("eventChangesTableBody");

  if (scopeNote) {
    scopeNote.textContent = "All events";
  }

  // Time & Date Helpers in Asia/Manila
  function getManilaNow() {
    const now = new Date();
    const manilaString = now.toLocaleString("en-US", { timeZone: "Asia/Manila" });
    return new Date(manilaString);
  }

  function getManilaDateString(dateObj = new Date()) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Manila",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(dateObj);
    const y = parts.find((p) => p.type === "year")?.value;
    const m = parts.find((p) => p.type === "month")?.value;
    const d = parts.find((p) => p.type === "day")?.value;
    return `${y}-${m}-${d}`;
  }

  function parseDateOnly(str) {
    if (!str) return null;
    const s = String(str).trim();
    const match = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (match) {
      return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    }
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  function formatDisplayDate(dateObj, options = {}) {
    if (!dateObj || Number.isNaN(dateObj.getTime())) return "—";
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Manila",
      month: "long",
      day: "numeric",
      year: "numeric",
      ...options,
    }).format(dateObj);
  }

  function formatGeneratedDateTime() {
    const now = new Date();
    const datePart = new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Manila",
      month: "long",
      day: "numeric",
      year: "numeric",
    }).format(now);
    const timePart = new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Manila",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).format(now);
    return `${datePart} — ${timePart}`;
  }

  function formatTimeHHMM(dateObj = new Date()) {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Manila",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).format(dateObj);
  }

  function getPeriodRange(periodKey) {
    const manilaToday = getManilaNow();
    const year = manilaToday.getFullYear();
    const month = manilaToday.getMonth();
    const day = manilaToday.getDate();

    if (periodKey === "today") {
      const start = new Date(year, month, day, 0, 0, 0, 0);
      const end = new Date(year, month, day, 23, 59, 59, 999);
      return { start, end, label: formatDisplayDate(start), badge: "Today's Report" };
    }

    if (periodKey === "week") {
      const dayOfWeek = manilaToday.getDay(); // 0 is Sunday
      const start = new Date(year, month, day - dayOfWeek, 0, 0, 0, 0);
      const end = new Date(year, month, day + (6 - dayOfWeek), 23, 59, 59, 999);
      const label = `${formatDisplayDate(start)} – ${formatDisplayDate(end)}`;
      return { start, end, label, badge: "This Week's Report" };
    }

    if (periodKey === "month") {
      const start = new Date(year, month, 1, 0, 0, 0, 0);
      const end = new Date(year, month + 1, 0, 23, 59, 59, 999);
      const label = new Intl.DateTimeFormat("en-US", {
        timeZone: "Asia/Manila",
        month: "long",
        year: "numeric",
      }).format(start);
      return { start, end, label, badge: "This Month's Report" };
    }

    if (periodKey === "year") {
      const start = new Date(year, 0, 1, 0, 0, 0, 0);
      const end = new Date(year, 11, 31, 23, 59, 59, 999);
      const label = `${year}`;
      return { start, end, label, badge: "This Year's Report" };
    }

    if (periodKey === "custom" && customStartDate && customEndDate) {
      const start = new Date(
        customStartDate.getFullYear(),
        customStartDate.getMonth(),
        customStartDate.getDate(),
        0, 0, 0, 0
      );
      const end = new Date(
        customEndDate.getFullYear(),
        customEndDate.getMonth(),
        customEndDate.getDate(),
        23, 59, 59, 999
      );
      const label = `${formatDisplayDate(start)} – ${formatDisplayDate(end)}`;
      return { start, end, label, badge: "Custom Report" };
    }

    const start = new Date(year, month, day, 0, 0, 0, 0);
    const end = new Date(year, month, day, 23, 59, 59, 999);
    return { start, end, label: formatDisplayDate(start), badge: "Today's Report" };
  }

  function parseEventDates(event) {
    const rawDate = event.date || event.startDate || event.eventDate;
    const rawEndDate = event.endDate || rawDate;
    const startDateObj = parseDateOnly(rawDate);
    const endDateObj = parseDateOnly(rawEndDate) || startDateObj;

    const startTimeStr = event.startTime || event.timeStart || "08:00";
    const endTimeStr = event.endTime || event.timeEnd || "17:00";

    function parseTimeComponents(tStr) {
      if (!tStr) return { h: 8, m: 0 };
      const m12 = String(tStr).trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i);
      if (m12) {
        let h = parseInt(m12[1], 10);
        const min = parseInt(m12[2], 10);
        const meridiem = (m12[3] || "").toUpperCase();
        if (meridiem === "PM" && h < 12) h += 12;
        if (meridiem === "AM" && h === 12) h = 0;
        return { h, m: min };
      }
      return { h: 8, m: 0 };
    }

    const startTC = parseTimeComponents(startTimeStr);
    const endTC = parseTimeComponents(endTimeStr);

    let startFull = null;
    let endFull = null;

    if (startDateObj) {
      startFull = new Date(
        startDateObj.getFullYear(),
        startDateObj.getMonth(),
        startDateObj.getDate(),
        startTC.h,
        startTC.m,
        0
      );
    }

    if (endDateObj) {
      endFull = new Date(
        endDateObj.getFullYear(),
        endDateObj.getMonth(),
        endDateObj.getDate(),
        endTC.h,
        endTC.m,
        0
      );
    }

    return {
      startDateObj,
      endDateObj,
      startFull,
      endFull,
      startTimeStr,
      endTimeStr,
    };
  }

  function computeEventStatus(event, now = new Date()) {
    const rawStatus = String(event.status || "").trim().toLowerCase();

    if (["cancelled", "canceled"].includes(rawStatus)) return "cancelled";
    if (["rescheduled"].includes(rawStatus)) return "rescheduled";
    if (["pending", "pending approval", "for approval"].includes(rawStatus)) {
      return "pending_approval";
    }

    const { startFull, endFull } = parseEventDates(event);
    if (!startFull || !endFull) {
      return rawStatus || "upcoming";
    }

    if (now < startFull) return "upcoming";
    if (now >= startFull && now <= endFull) return "ongoing";
    return "completed";
  }

  function isEventInPeriod(event, periodStart, periodEnd) {
    const { startDateObj, endDateObj } = parseEventDates(event);
    if (!startDateObj) return false;
    const eventEnd = endDateObj || startDateObj;

    const pStartDay = new Date(periodStart.getFullYear(), periodStart.getMonth(), periodStart.getDate());
    const pEndDay = new Date(periodEnd.getFullYear(), periodEnd.getMonth(), periodEnd.getDate(), 23, 59, 59);

    return startDateObj <= pEndDay && eventEnd >= pStartDay;
  }

  function parseVenueInfo(event) {
    const rawVenue =
      event.venue || event.room || event.location || event.venueRoom || "TBD";
    const rawCampus =
      event.campus ||
      event.building ||
      (String(rawVenue).toLowerCase().includes("cite")
        ? "PUP Biñan — CITE"
        : "PUP Biñan — Main Campus");

    let cleanRoom = rawVenue;
    if (cleanRoom.includes("|")) {
      cleanRoom = cleanRoom.split("|")[0].trim();
    }
    return {
      rawVenue,
      room: cleanRoom,
      campus: rawCampus,
    };
  }

  function updateReportHeaderMeta() {
    const range = getPeriodRange(currentPeriod);
    if (reportPeriodText) reportPeriodText.textContent = range.label;
    if (reportPeriodBadge) reportPeriodBadge.textContent = range.badge;
    if (reportGeneratedText) reportGeneratedText.textContent = formatGeneratedDateTime();
    if (reportGeneratedByText) {
      reportGeneratedByText.textContent = `${ROLE_NAME} — ${superAdminFullName}`;
    }
  }

  function setPeriod(periodKey) {
    currentPeriod = periodKey;
    periodButtons.forEach((btn) => {
      const match = btn.dataset.period === periodKey;
      btn.classList.toggle("is-active", match);
      btn.setAttribute("aria-pressed", String(match));
    });
    updateReportHeaderMeta();
    renderReport();
  }

  // Render Engine
  function renderReport() {
    if (!allEvents) return;
    const now = getManilaNow();
    const { start: pStart, end: pEnd } = getPeriodRange(currentPeriod);

    // Super Admin scope: All campus events
    const periodEvents = allEvents.filter((ev) => isEventInPeriod(ev, pStart, pEnd));

    // 1. EVENT SUMMARY
    let upcoming = 0;
    let ongoing = 0;
    let completed = 0;
    let cancelled = 0;
    let pendingApproval = 0;

    periodEvents.forEach((ev) => {
      const st = computeEventStatus(ev, now);
      if (st === "upcoming") upcoming += 1;
      else if (st === "ongoing") ongoing += 1;
      else if (st === "completed") completed += 1;
      else if (st === "cancelled") cancelled += 1;
      else if (st === "pending_approval") pendingApproval += 1;
    });

    const totalEventsCount = upcoming + ongoing + completed + cancelled + pendingApproval;

    if (metricTotalEvents) metricTotalEvents.textContent = String(totalEventsCount);
    if (metricUpcomingEvents) metricUpcomingEvents.textContent = String(upcoming);
    if (metricOngoingEvents) metricOngoingEvents.textContent = String(ongoing);
    if (metricCompletedEvents) metricCompletedEvents.textContent = String(completed);
    if (metricCancelledEvents) metricCancelledEvents.textContent = String(cancelled);
    if (metricPendingEvents) metricPendingEvents.textContent = String(pendingApproval);

    // 2. VENUE UTILIZATION & CURRENT OCCUPANCY (Today's live snapshot)
    renderVenueOccupancy(now);

    // 3. ROOM UTILIZATION STATISTICS (Period Completed Events)
    renderRoomUtilization(periodEvents);

    // 4. PARTICIPATION SUMMARY & MOST PARTICIPATED EVENTS
    renderParticipationSummary(periodEvents);

    // 5. CANCELLED / RESCHEDULED EVENTS
    renderEventChanges(periodEvents, pStart, pEnd);

    if (downloadCopyBtn) downloadCopyBtn.disabled = false;
  }

  function renderVenueOccupancy(now) {
    if (!venueOccupancyContainer) return;
    if (venueAsOfTime) venueAsOfTime.textContent = `As of ${formatTimeHHMM(now)}`;

    const todayStr = getManilaDateString(now);

    const todayEvents = allEvents.filter((ev) => {
      const { startDateObj, endDateObj } = parseEventDates(ev);
      if (!startDateObj) return false;
      const endObj = endDateObj || startDateObj;
      const todayDate = parseDateOnly(todayStr);
      return startDateObj <= todayDate && endObj >= todayDate;
    });

    const venueMap = new Map();
    DEFAULT_VENUES.forEach((dv) => {
      const campus = dv.campus;
      if (!venueMap.has(campus)) venueMap.set(campus, new Map());
      venueMap.get(campus).set(dv.room, []);
    });

    todayEvents.forEach((ev) => {
      const { room, campus } = parseVenueInfo(ev);
      const campusKey = campus.includes("CITE")
        ? "PUP Biñan — CITE"
        : "PUP Biñan — Main Campus";

      if (!venueMap.has(campusKey)) venueMap.set(campusKey, new Map());
      const campusRooms = venueMap.get(campusKey);
      if (!campusRooms.has(room)) campusRooms.set(room, []);
      campusRooms.get(room).push(ev);
    });

    venueOccupancyContainer.innerHTML = "";

    venueMap.forEach((roomsMap, campusName) => {
      const section = document.createElement("div");
      section.className = "venue-campus-group";

      const heading = document.createElement("h5");
      heading.className = "venue-group-heading";
      heading.textContent = campusName;
      section.appendChild(heading);

      const tableWrap = document.createElement("div");
      tableWrap.className = "report-table-scroll";

      const table = document.createElement("table");
      table.className = "report-table";
      table.innerHTML = `
        <thead>
          <tr>
            <th scope="col" class="text-left">Room/Venue</th>
            <th scope="col" class="text-left">Time</th>
            <th scope="col" class="text-left">Event</th>
            <th scope="col" class="text-left">Organizer</th>
            <th scope="col" class="text-center">Status</th>
          </tr>
        </thead>
        <tbody></tbody>
      `;
      const tbody = table.querySelector("tbody");

      roomsMap.forEach((events, roomName) => {
        if (!events || events.length === 0) {
          const row = document.createElement("tr");
          row.innerHTML = `
            <td><strong>${escapeHtml(roomName)}</strong></td>
            <td>---</td>
            <td>---</td>
            <td>---</td>
            <td class="text-center"><span class="status-pill status-available">Available</span></td>
          `;
          tbody.appendChild(row);
        } else {
          events.sort((a, b) => {
            const tA = parseEventDates(a).startFull || 0;
            const tB = parseEventDates(b).startFull || 0;
            return tA - tB;
          });

          events.forEach((ev) => {
            const { startFull, endFull, startTimeStr, endTimeStr } = parseEventDates(ev);
            let statusBadge = "";
            const isCancelled = ["cancelled", "canceled"].includes(String(ev.status || "").toLowerCase());

            if (isCancelled) {
              statusBadge = `<span class="status-pill status-cancelled">Cancelled</span>`;
            } else if (now >= startFull && now <= endFull) {
              statusBadge = `<span class="status-pill status-in-use">In Use</span>`;
            } else if (now < startFull) {
              statusBadge = `<span class="status-pill status-scheduled">Scheduled</span>`;
            } else {
              statusBadge = `<span class="status-pill status-completed">Completed</span>`;
            }

            const title = ev.title || ev.eventName || "Untitled Event";
            const organizer =
              ev.organizer ||
              ev.leadOrganizer ||
              ev.createdByName ||
              ev.creatorName ||
              "—";
            const timeDisplay = `${startTimeStr} – ${endTimeStr}`;

            const row = document.createElement("tr");
            row.innerHTML = `
              <td><strong>${escapeHtml(roomName)}</strong></td>
              <td>${escapeHtml(timeDisplay)}</td>
              <td>${escapeHtml(title)}</td>
              <td>${escapeHtml(organizer)}</td>
              <td class="text-center">${statusBadge}</td>
            `;
            tbody.appendChild(row);
          });
        }
      });

      tableWrap.appendChild(table);
      section.appendChild(tableWrap);
      venueOccupancyContainer.appendChild(section);
    });
  }

  function renderRoomUtilization(periodEvents) {
    if (!roomUtilizationBody) return;
    roomUtilizationBody.innerHTML = "";

    const roomStats = new Map();
    DEFAULT_VENUES.forEach((dv) => {
      roomStats.set(dv.room, { eventsHeld: 0, hoursUsed: 0 });
    });

    const now = getManilaNow();
    periodEvents.forEach((ev) => {
      const st = computeEventStatus(ev, now);
      if (st === "completed") {
        const { room } = parseVenueInfo(ev);
        if (!roomStats.has(room)) {
          roomStats.set(room, { eventsHeld: 0, hoursUsed: 0 });
        }
        const data = roomStats.get(room);
        data.eventsHeld += 1;

        const { startFull, endFull } = parseEventDates(ev);
        if (startFull && endFull && endFull > startFull) {
          const diffMs = endFull.getTime() - startFull.getTime();
          const diffHrs = diffMs / (1000 * 60 * 60);
          data.hoursUsed += diffHrs;
        }
      }
    });

    const sortedRooms = Array.from(roomStats.entries()).sort((a, b) =>
      a[0].localeCompare(b[0])
    );

    sortedRooms.forEach(([roomName, stats]) => {
      const tr = document.createElement("tr");
      const roundedHours = Math.round(stats.hoursUsed * 10) / 10;
      tr.innerHTML = `
        <td><strong>${escapeHtml(roomName)}</strong></td>
        <td class="text-center">${stats.eventsHeld}</td>
        <td class="text-right">${roundedHours} hrs</td>
      `;
      roomUtilizationBody.appendChild(tr);
    });
  }

  function renderParticipationSummary(periodEvents) {
    let totalConfirmed = 0;
    let totalCancelled = 0;
    let completedAtt = 0;
    let completedConfirmed = 0;

    const eventParticipation = [];
    const now = getManilaNow();

    periodEvents.forEach((ev) => {
      const isCompleted = computeEventStatus(ev, now) === "completed";
      const confirmed =
        Number(ev.confirmedRegistrations ?? ev.attendeesCount ?? ev.registrationCount ?? 0) || 0;
      const cancelled = Number(ev.cancelledRegistrations ?? ev.cancelledCount ?? 0) || 0;
      const attended = Number(ev.attendedCount ?? ev.completedAttendance ?? 0) || 0;

      totalConfirmed += confirmed;
      totalCancelled += cancelled;

      if (isCompleted) {
        completedAtt += attended;
        completedConfirmed += confirmed;
      }

      eventParticipation.push({
        title: ev.title || ev.eventName || "Untitled Event",
        confirmed,
      });
    });

    const totalReg = totalConfirmed + totalCancelled;
    const avgRate =
      completedConfirmed > 0
        ? ((completedAtt / completedConfirmed) * 100).toFixed(1) + "%"
        : "—";

    if (summaryTotalReg) summaryTotalReg.textContent = String(totalReg);
    if (summaryConfirmedPart) summaryConfirmedPart.textContent = String(totalConfirmed);
    if (summaryCancelledPart) summaryCancelledPart.textContent = String(totalCancelled);
    if (summaryCompletedAtt) summaryCompletedAtt.textContent = String(completedAtt);
    if (summaryAvgAttRate) summaryAvgAttRate.textContent = avgRate;

    // Most Participated Events (Top 3)
    if (mostParticipatedList) {
      mostParticipatedList.innerHTML = "";
      eventParticipation.sort((a, b) => {
        if (b.confirmed !== a.confirmed) return b.confirmed - a.confirmed;
        return a.title.localeCompare(b.title);
      });

      const top3 = eventParticipation.slice(0, 3);
      if (top3.length === 0 || top3.every((e) => e.confirmed === 0)) {
        mostParticipatedList.innerHTML = `<li class="empty-item">No participated events recorded</li>`;
      } else {
        top3.forEach((item) => {
          const li = document.createElement("li");
          li.innerHTML = `<span>${escapeHtml(item.title)}</span> <strong>${item.confirmed}</strong>`;
          mostParticipatedList.appendChild(li);
        });
      }
    }
  }

  function renderEventChanges(periodEvents, pStart, pEnd) {
    if (!eventChangesTableBody) return;
    eventChangesTableBody.innerHTML = "";

    const changedEvents = periodEvents.filter((ev) => {
      const st = String(ev.status || "").toLowerCase();
      return (
        ["cancelled", "canceled", "rescheduled"].includes(st) ||
        Boolean(ev.rescheduledFrom || ev.rescheduledDate || ev.cancellationReason)
      );
    });

    if (changedEvents.length === 0) {
      eventChangesTableBody.innerHTML = `
        <tr>
          <td colspan="4" class="empty-cell">No cancelled or rescheduled events in this period</td>
        </tr>
      `;
      return;
    }

    changedEvents.forEach((ev) => {
      const isRescheduled =
        String(ev.status || "").toLowerCase() === "rescheduled" ||
        Boolean(ev.rescheduledFrom || ev.rescheduledDate);
      const changeType = isRescheduled ? "Rescheduled" : "Cancelled";
      const badgeClass = isRescheduled ? "status-rescheduled" : "status-cancelled";

      const title = ev.title || ev.eventName || "Untitled Event";
      const origSchedule =
        ev.originalSchedule ||
        ev.rescheduledFrom ||
        ev.originalDate ||
        "—";
      const reason =
        ev.cancellationReason ||
        ev.rescheduleReason ||
        ev.reason ||
        "—";

      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td><strong>${escapeHtml(title)}</strong></td>
        <td>${escapeHtml(origSchedule)}</td>
        <td><span class="status-pill ${badgeClass}">${changeType}</span></td>
        <td>${escapeHtml(reason)}</td>
      `;
      eventChangesTableBody.appendChild(tr);
    });
  }

  function escapeHtml(str) {
    if (!str) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  // Popover & UI Event Handlers
  function toggleCustomPopover(show) {
    if (!customPopover) return;
    const isShowing = !customPopover.hidden;
    const nextState = typeof show === "boolean" ? show : !isShowing;
    customPopover.hidden = !nextState;
    if (nextState) {
      customPopover.removeAttribute("hidden");
      if (customError) customError.hidden = true;
    } else {
      customPopover.setAttribute("hidden", "");
    }
  }

  if (customRangeBtn) {
    customRangeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleCustomPopover();
    });
  }

  document.addEventListener("click", (e) => {
    if (customPopover && !customPopover.hidden) {
      if (!customPopover.contains(e.target) && e.target !== customRangeBtn) {
        toggleCustomPopover(false);
      }
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && customPopover && !customPopover.hidden) {
      toggleCustomPopover(false);
    }
  });

  periodButtons.forEach((btn) => {
    if (btn.dataset.period === "custom") return;
    btn.addEventListener("click", () => {
      toggleCustomPopover(false);
      setPeriod(btn.dataset.period);
    });
  });

  function parseInputMMDDYYYY(val) {
    if (!val) return null;
    const parts = val.trim().split(/[\/\-.]/);
    if (parts.length !== 3) return null;
    const m = parseInt(parts[0], 10);
    const d = parseInt(parts[1], 10);
    const y = parseInt(parts[2], 10);
    if (!m || !d || !y || m < 1 || m > 12 || d < 1 || d > 31 || y < 2000 || y > 2100) {
      return null;
    }
    const dt = new Date(y, m - 1, d);
    if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) {
      return null;
    }
    return dt;
  }

  if (customApplyBtn) {
    customApplyBtn.addEventListener("click", () => {
      const fromDt = parseInputMMDDYYYY(customFromInput?.value);
      const toDt = parseInputMMDDYYYY(customToInput?.value);

      if (!fromDt || !toDt) {
        if (customError) {
          customError.textContent = "Please enter valid dates in MM/DD/YYYY format.";
          customError.hidden = false;
        }
        return;
      }

      if (fromDt > toDt) {
        if (customError) {
          customError.textContent = "'From' date must be earlier than or equal to 'To' date.";
          customError.hidden = false;
        }
        return;
      }

      customStartDate = fromDt;
      customEndDate = toDt;
      if (customError) customError.hidden = true;
      toggleCustomPopover(false);
      setPeriod("custom");
    });
  }

  // Download PDF functionality
  if (downloadCopyBtn) {
    downloadCopyBtn.addEventListener("click", () => {
      const { start, end } = getPeriodRange(currentPeriod);
      const sStr = getManilaDateString(start);
      const eStr = getManilaDateString(end);
      const originalTitle = document.title;
      document.title = `RECOVIBE_Activity_Summary_${sStr}_to_${eStr}`;
      window.print();
      document.title = originalTitle;
    });
  }

  // Firestore Real-Time Listener
  function startEventsListener() {
    if (!db || !isFirebaseConfigured) {
      showErrorState("Database connection unavailable.");
      return;
    }

    if (loadingState) loadingState.hidden = false;
    if (errorState) errorState.hidden = true;
    if (dataContainer) dataContainer.hidden = true;
    if (downloadCopyBtn) downloadCopyBtn.disabled = true;

    try {
      const q = query(collection(db, "events"), orderBy("date", "asc"));
      unsubscribeEvents = onSnapshot(
        q,
        (snapshot) => {
          allEvents = snapshot.docs.map((docSnap) => ({
            id: docSnap.id,
            ...docSnap.data(),
          }));

          if (loadingState) loadingState.hidden = true;
          if (errorState) errorState.hidden = true;
          if (dataContainer) dataContainer.hidden = false;

          updateReportHeaderMeta();
          renderReport();
        },
        (err) => {
          console.error("Firestore listener error:", err);
          showErrorState("Failed to stream events from database.");
        }
      );
    } catch (err) {
      console.error("Query creation error:", err);
      showErrorState("Failed to connect to events database.");
    }
  }

  function showErrorState(msg) {
    if (loadingState) loadingState.hidden = true;
    if (dataContainer) dataContainer.hidden = true;
    if (errorState) errorState.hidden = false;
    if (errorMessage) errorMessage.textContent = msg;
    if (downloadCopyBtn) downloadCopyBtn.disabled = true;
  }

  if (retryBtn) {
    retryBtn.addEventListener("click", () => {
      startEventsListener();
    });
  }

  // Initialization
  function init() {
    updateReportHeaderMeta();
    startEventsListener();

    // Recompute statuses every minute without reload
    clockInterval = setInterval(() => {
      renderReport();
    }, 60000);
  }

  window.addEventListener("beforeunload", () => {
    if (unsubscribeEvents) unsubscribeEvents();
    if (clockInterval) clearInterval(clockInterval);
  });

  init();
})();

