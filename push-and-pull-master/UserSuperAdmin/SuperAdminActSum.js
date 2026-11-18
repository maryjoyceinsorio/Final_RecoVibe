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
  let currentPeriod = "all";
  let customStartDate = null;
  let customEndDate = null;
  let activeDateRangeLabel = "All Dates";
  let activeDateRangePreset = "all";
  let clockInterval = null;

  // DOM Elements
  const scopeNote = document.getElementById("actSumScopeNote");
  const customRangeBtn = document.getElementById("customRangeBtn");
  const customPopover = document.getElementById("customRangePopover");
  const customFromInput = document.getElementById("customFromDate");
  const customToInput = document.getElementById("customToDate");
  const customApplyBtn = document.getElementById("customApplyBtn");
  const customError = document.getElementById("customRangeError");
  const dateRangeTriggerLabel = document.getElementById("dateRangeTriggerLabel");
  const dateRangeCalendarOne = document.getElementById("dateRangeCalendarOne");
  const dateRangeCalendarTwo = document.getElementById("dateRangeCalendarTwo");
  const dateRangeCalendarTitle = document.getElementById("dateRangeCalendarTitle");
  const dateRangePrevMonth = document.getElementById("dateRangePrevMonth");
  const dateRangeNextMonth = document.getElementById("dateRangeNextMonth");
  const dateRangeClear = document.getElementById("dateRangeClear");
  const dateRangeCancel = document.getElementById("dateRangeCancel");
  const dateRangeClose = document.getElementById("dateRangeCloseBtn");

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
    const localToday = new Date();
    const year = localToday.getFullYear();
    const month = localToday.getMonth();
    const day = localToday.getDate();

    if (periodKey === "all") {
      return {
        start: null,
        end: null,
        label: "All Dates",
        badge: "All Dates",
      };
    }

    if (periodKey === "today") {
      const start = new Date(year, month, day, 0, 0, 0, 0);
      const end = new Date(year, month, day, 23, 59, 59, 999);
      return { start, end, label: formatDisplayDate(start), badge: "Today's Report" };
    }

    if (periodKey === "week") {
      const dayOfWeek = manilaToday.getDay(); // 0 is Sunday
      const start = new Date(year, month, day - dayOfWeek, 0, 0, 0, 0);
      const end = new Date(year, month, day + (6 - dayOfWeek), 23, 59, 59, 999);
      const label = `${start.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })} – ${end.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}`;
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
    updateReportHeaderMeta();
    renderReport();
  }

  // Render Engine
  function renderReport() {
    if (!allEvents) return;
    const now = getManilaNow();
    const { start: pStart, end: pEnd } = getPeriodRange(currentPeriod);

    // Super Admin scope: All campus events
    const periodEvents = currentPeriod === "all"
      ? allEvents
      : allEvents.filter((ev) => isEventInPeriod(ev, pStart, pEnd));

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

  function setupPeriodControls() {
    let pendingStart = null;
    let pendingEnd = null;
    let pendingPreset = null;
    let hoverDate = "";
    let previousBodyOverflow = null;
    const today = new Date();
    let viewYear = today.getFullYear();
    let viewMonth = today.getMonth();
    const quickLabels = {
      today: "Today",
      tomorrow: "Tomorrow",
      thisWeek: "This week",
      thisWeekend: "This weekend",
      nextWeek: "Next week",
      thisMonth: "This month",
      nextMonth: "Next month",
      all: "All time",
    };
    const weekdays = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

    function toISO(date) {
      return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    }

    function parseDate(value) {
      const text = String(value || "").trim();
      let year;
      let month;
      let day;
      let match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (match) {
        year = Number(match[1]);
        month = Number(match[2]);
        day = Number(match[3]);
      } else {
        return null;
      }
      const date = new Date(year, month - 1, day);
      if (year < 1000) return null;
      if (date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day) return date;
      return null;
    }

    function dateValue(value) {
      if (value instanceof Date) return toISO(value);
      return String(value || "").slice(0, 10);
    }

    function currentRange() {
      if (currentPeriod === "all") return { start: "", end: "" };
      const range = typeof getSelectedDateRange === "function"
        ? getSelectedDateRange()
        : getPeriodRange(currentPeriod);
      return { start: dateValue(range.start), end: dateValue(range.end) };
    }

    function presetRange(preset) {
      const now = new Date();
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const end = new Date(start);
      if (preset === "tomorrow") {
        start.setDate(start.getDate() + 1);
        end.setTime(start.getTime());
      } else if (preset === "thisWeek" || preset === "nextWeek") {
        start.setDate(start.getDate() - start.getDay() + (preset === "nextWeek" ? 7 : 0));
        end.setDate(start.getDate() + 6);
      } else if (preset === "thisWeekend") {
        if (start.getDay() === 0) {
          end.setTime(start.getTime());
        } else {
          start.setDate(start.getDate() - start.getDay() + 6);
          end.setDate(start.getDate() + 1);
        }
      } else if (preset === "thisMonth") {
        start.setDate(1);
        end.setMonth(start.getMonth() + 1, 0);
      } else if (preset === "nextMonth") {
        start.setDate(1);
        start.setMonth(start.getMonth() + 1);
        end.setTime(start.getTime());
        end.setMonth(start.getMonth() + 1, 0);
      } else if (preset === "all") {
        return { start: "", end: "" };
      }
      return { start: toISO(start), end: toISO(end) };
    }

    function formatLabel(start, end, preset) {
      if (preset === "all") return "All Dates";
      if (quickLabels[preset]) return quickLabels[preset];
      const format = (value) => new Intl.DateTimeFormat("en-US", {
        month: "short", day: "numeric", year: "numeric",
      }).format(parseDate(value));
      return start === end ? format(start) : `${format(start)} – ${format(end)}`;
    }

    function syncInputs() {
      customFromInput.value = pendingStart || "";
      customToInput.value = pendingEnd || "";
    }

    function renderCalendar(container, year, month) {
      const firstDay = new Date(year, month, 1).getDay();
      const daysInMonth = new Date(year, month + 1, 0).getDate();
      const title = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric" })
        .format(new Date(year, month, 1));
      let html = `<h3 class="date-range-calendar-title">${title}</h3><div class="date-range-weekdays" aria-hidden="true">`;
      html += weekdays.map((day) => `<span>${day}</span>`).join("");
      html += `</div><div class="date-range-days" role="grid" aria-label="${title}"></div>`;
      container.innerHTML = html;
      const grid = container.querySelector(".date-range-days");
      for (let blank = 0; blank < firstDay; blank += 1) {
        grid.insertAdjacentHTML("beforeend", '<span class="date-range-empty" aria-hidden="true"></span>');
      }
      for (let day = 1; day <= daysInMonth; day += 1) {
        const date = new Date(year, month, day);
        const iso = toISO(date);
        const isStart = iso === pendingStart;
        const isEnd = Boolean(pendingEnd) && iso === pendingEnd;
        const inRange = pendingStart && pendingEnd && iso > pendingStart && iso < pendingEnd;
        const isToday = iso === toISO(new Date());
        const classes = ["date-range-day", isStart ? "is-start" : "", isEnd ? "is-end" : "", inRange ? "is-in-range" : "", isToday ? "is-today" : ""].filter(Boolean).join(" ");
        grid.insertAdjacentHTML("beforeend", `<button type="button" class="${classes}" data-date="${iso}" role="gridcell" aria-pressed="${isStart || isEnd}" aria-label="${new Intl.DateTimeFormat("en-US", { dateStyle: "full" }).format(date)}">${day}</button>`);
      }
    }

    function renderCalendars() {
      renderCalendar(dateRangeCalendarOne, viewYear, viewMonth);
      renderCalendar(dateRangeCalendarTwo, viewYear + (viewMonth === 11 ? 1 : 0), (viewMonth + 1) % 12);
      dateRangeCalendarTitle.textContent = new Intl.DateTimeFormat("en-US", {
        month: "long", year: "numeric",
      }).format(new Date(viewYear, viewMonth, 1));
    }

    function setPendingRange(range, preset) {
      pendingStart = range.start || null;
      pendingEnd = range.end || null;
      pendingPreset = preset || null;
      const first = parseDate(pendingStart);
      if (preset === "all") {
        const now = new Date();
        viewYear = now.getFullYear();
        viewMonth = now.getMonth();
      } else if (first) {
        viewYear = first.getFullYear();
        viewMonth = first.getMonth();
      }
      syncInputs();
      customFromInput.removeAttribute("aria-invalid");
      customToInput.removeAttribute("aria-invalid");
      customError.textContent = "";
      customError.hidden = true;
      renderCalendars();
      updateApplyButton();
      document.querySelectorAll(".date-range-quick-btn").forEach((button) => {
        button.setAttribute("aria-pressed", String(button.dataset.preset === pendingPreset));
      });
    }

    const appliedRange = currentRange();
    function updateApplyButton() {
      const startText = customFromInput.value.trim();
      const endText = customToInput.value.trim();
      const start = parseDate(startText);
      const end = parseDate(endText);
      const invalid = (startText && !start) || (endText && !end);
      const changed = (pendingStart || "") !== appliedRange.start ||
        (pendingEnd || "") !== appliedRange.end ||
        pendingPreset !== activeDateRangePreset;
      customApplyBtn.disabled = Boolean(invalid || (start && end && start > end)) || !changed;
    }

    function closePicker() {
      const range = currentRange();
      setPendingRange(range, activeDateRangePreset);
      customPopover.hidden = true;
      customRangeBtn.setAttribute("aria-expanded", "false");
      if (previousBodyOverflow !== null) {
        document.body.style.overflow = previousBodyOverflow;
        previousBodyOverflow = null;
      }
      customRangeBtn.focus();
    }

    function openPicker() {
      if (!customPopover.hidden) {
        closePicker();
        return;
      }
      const range = currentRange();
      setPendingRange(range, activeDateRangePreset);
      customPopover.hidden = false;
      customRangeBtn.setAttribute("aria-expanded", "true");
      previousBodyOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      dateRangeClose.focus();
    }

    customRangeBtn.addEventListener("click", openPicker);
    dateRangeClose.addEventListener("click", closePicker);
    dateRangePrevMonth.addEventListener("click", () => {
      const month = new Date(viewYear, viewMonth - 1, 1);
      viewYear = month.getFullYear();
      viewMonth = month.getMonth();
      renderCalendars();
    });
    dateRangeNextMonth.addEventListener("click", () => {
      const month = new Date(viewYear, viewMonth + 1, 1);
      viewYear = month.getFullYear();
      viewMonth = month.getMonth();
      renderCalendars();
    });
    document.querySelectorAll(".date-range-quick-btn").forEach((button) => {
      button.addEventListener("click", () => setPendingRange(presetRange(button.dataset.preset), button.dataset.preset));
    });
    [dateRangeCalendarOne, dateRangeCalendarTwo].forEach((calendar) => {
      calendar.addEventListener("click", (event) => {
        const button = event.target.closest(".date-range-day");
        if (!button) return;
        event.stopPropagation();
        const value = button.dataset.date;
        if (!pendingStart || (pendingStart && pendingEnd)) {
          pendingStart = value;
          pendingEnd = null;
        } else if (value < pendingStart) {
          pendingEnd = pendingStart;
          pendingStart = value;
        } else {
          pendingEnd = value;
        }
        hoverDate = "";
        const effectiveStart = parseDate(pendingStart);
        const effectiveEnd = parseDate(pendingEnd) || effectiveStart;
        pendingPreset = effectiveStart && effectiveEnd
          ? [...customPopover.querySelectorAll(".date-range-quick-btn")].find((quick) => {
            const range = presetRange(quick.dataset.preset);
            return range.start === toISO(effectiveStart) && range.end === toISO(effectiveEnd);
          })?.dataset.preset || null
          : null;
        syncInputs();
        customFromInput.removeAttribute("aria-invalid");
        customToInput.removeAttribute("aria-invalid");
        customError.hidden = true;
        updateApplyButton();
        renderCalendars();
        calendar.querySelector(`.date-range-day[data-date="${value}"]`)?.focus();
        document.querySelectorAll(".date-range-quick-btn").forEach((quick) =>
          quick.setAttribute("aria-pressed", String(quick.dataset.preset === pendingPreset))
        );
      });
      calendar.addEventListener("pointerover", (event) => {
        const button = event.target.closest(".date-range-day");
        if (!button || !pendingStart || pendingEnd) return;
        hoverDate = button.dataset.date;
        const lower = hoverDate < pendingStart ? hoverDate : pendingStart;
        const upper = hoverDate < pendingStart ? pendingStart : hoverDate;
        [dateRangeCalendarOne, dateRangeCalendarTwo].forEach((visibleCalendar) => {
          visibleCalendar.querySelectorAll(".date-range-day").forEach((day) => {
            day.classList.toggle("is-in-range", day.dataset.date > lower && day.dataset.date < upper);
          });
        });
      });
      calendar.addEventListener("pointerleave", () => {
        if (!hoverDate) return;
        hoverDate = "";
        renderCalendars();
      });
    });
    [customFromInput, customToInput].forEach((input) => {
      input.addEventListener("input", () => {
        const start = parseDate(customFromInput.value);
        const end = parseDate(customToInput.value);
        pendingStart = start ? toISO(start) : null;
        pendingEnd = end ? toISO(end) : null;
        hoverDate = "";
        const effectiveStart = start || end;
        const effectiveEnd = end || start;
        pendingPreset = effectiveStart && effectiveEnd
          ? [...customPopover.querySelectorAll(".date-range-quick-btn")].find((quick) => {
            const range = presetRange(quick.dataset.preset);
            return range.start === toISO(effectiveStart) && range.end === toISO(effectiveEnd);
          })?.dataset.preset || null
          : "all";
        const invalidInput = [customFromInput, customToInput].find((dateInput) =>
          dateInput.value.trim() && !parseDate(dateInput.value)
        );
        if (invalidInput) {
          invalidInput.setAttribute("aria-invalid", "true");
          customError.textContent = "Enter a valid date (YYYY-MM-DD).";
          customError.hidden = false;
        } else if (start && end && start > end) {
          customToInput.setAttribute("aria-invalid", "true");
          customError.textContent = "Start date must be on or before end date.";
          customError.hidden = false;
        } else {
          customFromInput.removeAttribute("aria-invalid");
          customToInput.removeAttribute("aria-invalid");
          customError.textContent = "";
          customError.hidden = true;
        }
        const first = parseDate(pendingStart) || parseDate(pendingEnd);
        if (first) {
          viewYear = first.getFullYear();
          viewMonth = first.getMonth();
        }
        updateApplyButton();
        renderCalendars();
        document.querySelectorAll(".date-range-quick-btn").forEach((quick) =>
          quick.setAttribute("aria-pressed", String(quick.dataset.preset === pendingPreset))
        );
      });
      input.addEventListener("blur", () => {
        const start = parseDate(customFromInput.value);
        const end = parseDate(customToInput.value);
        if (input.value && !parseDate(input.value)) {
          input.setAttribute("aria-invalid", "true");
          customError.textContent = "Enter a valid date (YYYY-MM-DD).";
          customError.hidden = false;
        } else if (start && end && start > end) {
          customToInput.setAttribute("aria-invalid", "true");
          customError.textContent = "Start date must be on or before end date.";
          customError.hidden = false;
        } else {
          customError.textContent = "";
          customError.hidden = true;
        }
      });
    });
    dateRangeClear.addEventListener("click", () => setPendingRange(presetRange("all"), "all"));
    dateRangeCancel.addEventListener("click", closePicker);
    customApplyBtn.addEventListener("click", () => {
      const startText = customFromInput.value.trim();
      const endText = customToInput.value.trim();
      const parsedStart = parseDate(startText);
      const parsedEnd = parseDate(endText);
      if ((startText && !parsedStart) || (endText && !parsedEnd) ||
        (parsedStart && parsedEnd && parsedStart > parsedEnd)) {
        customError.textContent = (startText && !parsedStart) || (endText && !parsedEnd)
          ? "Enter a valid date (YYYY-MM-DD)."
          : "Start date must be on or before end date.";
        customError.hidden = false;
        if (startText && !parsedStart) {
          customFromInput.setAttribute("aria-invalid", "true");
          customFromInput.focus();
        } else if (endText && !parsedEnd) {
          customToInput.setAttribute("aria-invalid", "true");
          customToInput.focus();
        } else {
          customToInput.setAttribute("aria-invalid", "true");
          customToInput.focus();
        }
        return;
      }
      const start = parsedStart || parsedEnd;
      const end = parsedEnd || parsedStart;
      if (!start || !end) {
        currentPeriod = "all";
        customStartDate = null;
        customEndDate = null;
        activeDateRangePreset = "all";
        activeDateRangeLabel = "All Dates";
        appliedRange.start = "";
        appliedRange.end = "";
        dateRangeTriggerLabel.textContent = activeDateRangeLabel;
        customRangeBtn.setAttribute("aria-label", `Date range: ${activeDateRangeLabel}`);
        if (typeof setPeriod === "function") setPeriod(currentPeriod);
        else renderReport();
        closePicker();
        return;
      }
      const startISO = toISO(start);
      const endISO = toISO(end);
      const preset = pendingPreset;
      customStartDate = start;
      customEndDate = end;
      customFromInput.removeAttribute("aria-invalid");
      customToInput.removeAttribute("aria-invalid");
      currentPeriod = "custom";
      activeDateRangePreset = preset;
      activeDateRangeLabel = formatLabel(startISO, endISO, preset);
      appliedRange.start = startISO;
      appliedRange.end = endISO;
      dateRangeTriggerLabel.textContent = activeDateRangeLabel;
      customRangeBtn.setAttribute("aria-label", `Date range: ${activeDateRangeLabel}`);
      if (typeof setPeriod === "function") setPeriod(currentPeriod);
      else renderReport();
      closePicker();
    });
    customPopover.addEventListener("keydown", (event) => {
      const button = event.target.closest(".date-range-day");
      if (!button) return;
      const current = parseDate(button.dataset.date);
      let target = null;
      if (event.key === "ArrowLeft") target = new Date(current.getFullYear(), current.getMonth(), current.getDate() - 1);
      else if (event.key === "ArrowRight") target = new Date(current.getFullYear(), current.getMonth(), current.getDate() + 1);
      else if (event.key === "ArrowUp") target = new Date(current.getFullYear(), current.getMonth(), current.getDate() - 7);
      else if (event.key === "ArrowDown") target = new Date(current.getFullYear(), current.getMonth(), current.getDate() + 7);
      else if (event.key === "Home") target = new Date(current.getFullYear(), current.getMonth(), current.getDate() - current.getDay());
      else if (event.key === "End") target = new Date(current.getFullYear(), current.getMonth(), current.getDate() + 6 - current.getDay());
      else if (event.key === "PageUp" || event.key === "PageDown") {
        const offset = event.key === "PageUp" ? -1 : 1;
        const month = new Date(current.getFullYear(), current.getMonth() + offset, 1);
        const lastDay = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
        target = new Date(month.getFullYear(), month.getMonth(), Math.min(current.getDate(), lastDay));
      }
      if (!target) return;
      event.preventDefault();
      const firstVisibleMonth = new Date(viewYear, viewMonth, 1);
      const secondVisibleMonth = new Date(viewYear, viewMonth + 1, 1);
      const visibleMonths = window.matchMedia("(max-width: 760px)").matches
        ? [firstVisibleMonth]
        : [firstVisibleMonth, secondVisibleMonth];
      const targetIsVisible = visibleMonths.some((month) =>
        month.getFullYear() === target.getFullYear() && month.getMonth() === target.getMonth()
      );
      if (!targetIsVisible) {
        viewYear = target.getFullYear();
        viewMonth = target.getMonth();
        renderCalendars();
      }
      customPopover.querySelector(`.date-range-day[data-date="${toISO(target)}"]`)?.focus();
    });
    document.addEventListener("click", (event) => {
      if (!customPopover.hidden && !customPopover.contains(event.target) && !customRangeBtn.contains(event.target)) {
        closePicker();
      }
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !customPopover.hidden) closePicker();
    });
    renderCalendars();
    updateApplyButton();
  }

  setupPeriodControls();

  // Download PDF functionality
  if (downloadCopyBtn) {
    downloadCopyBtn.addEventListener("click", () => {
      const { start, end } = getPeriodRange(currentPeriod);
      const sStr = start ? getManilaDateString(start) : "all";
      const eStr = end ? getManilaDateString(end) : "all";
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
          window.dispatchEvent(new Event("page-data-ready"));
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
    window.dispatchEvent(new Event("page-data-ready"));
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
