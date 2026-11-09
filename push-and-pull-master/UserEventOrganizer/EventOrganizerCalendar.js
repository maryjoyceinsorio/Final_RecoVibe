// Keep in sync with the other role's calendar page.

import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  ref,
  query,
  orderByChild,
  startAt,
  endAt,
  onValue,
  off,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import {
  auth,
  authReady,
  rtdb,
  isRtdbConfigured,
} from "../UserStudent/firebaseConfig.js";
import { fetchMonthHolidays } from "../holidayService.js";
import { isEventVisibleToStudent } from "../UserStudent/eventAudience.js";
import { getEventDateRange } from "../UserStudent/calendarDateRange.mjs";

(() => {
  const monthNames = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];

  const CATEGORY_DEFS = [
    { key: "pup", label: "PUP Official", color: "#7A1F2E" },
    { key: "csc", label: "CSC", color: "#D9A93B" },
    { key: "org", label: "Organizational", color: "#8B5CF6" },
    { key: "other", label: "Others/External", color: "#64748B" },
    { key: "holiday", label: "Holiday", color: "#D97706" },
  ];

  const isTeacher =
    typeof window !== "undefined" &&
    window.location.pathname.toLowerCase().includes("userteacher");

  // DOM elements
  const monthSelect = document.getElementById("calMonthSelect");
  const yearSelect = document.getElementById("calYearSelect");
  const calendarDays = document.getElementById("calFullDays");
  const currentHeading = document.getElementById("calCurrentHeading");
  const todayButton = document.querySelector(".cal-toggle");
  const prevButton = document.getElementById("calFullPrev");
  const nextButton = document.getElementById("calFullNext");
  const resetFiltersBtn = document.getElementById("resetCalendarFilters");
  const filterEmptyState = document.getElementById("filterEmptyState");
  const filterCheckboxes = document.querySelectorAll("[data-category-key]");
  const dayModal = document.getElementById("organizerDayOverlay");
  const dayTitle = document.getElementById("organizerDayTitle");
  const dayList = document.getElementById("organizerDayList");
  const dayClose = document.getElementById("organizerDayClose");
  const detailModal = document.getElementById("organizerModalOverlay");
  const detailClose = document.getElementById("organizerModalClose");
  const upcomingList = document.getElementById("upcomingList");

  // State
  const state = {
    date: new Date(),
    selectedDayIso: null,
    hiddenCategories: new Set(),
    publicEvents: [],
    upcomingEvents: [],
    organizerUnpublishedEvents: [],
    holidays: [],
    isLoading: true,
    loadError: false,
    currentUser: null,
    organizerProfile: null,
  };

  let activeFallbackTimer = null;
  let activePublicEventsRef = null;
  let activePublicEventsCallback = null;
  let activeOrganizerEventsRef = null;
  let activeOrganizerEventsCallback = null;
  let holidayRequestSequence = 0;

  // --- Philippine Time Date Helpers ---
  function toPhDateStr(timestampOrString) {
    if (!timestampOrString) return "";
    let dateObj;
    if (typeof timestampOrString === "number") {
      dateObj = new Date(timestampOrString);
    } else if (typeof timestampOrString === "string") {
      if (/^\d{4}-\d{2}-\d{2}$/.test(timestampOrString.trim())) {
        return timestampOrString.trim();
      }
      dateObj = new Date(timestampOrString);
    } else if (timestampOrString instanceof Date) {
      dateObj = timestampOrString;
    }
    if (!dateObj || Number.isNaN(dateObj.getTime())) return "";
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

  function formatPhTime(timestampOrString) {
    if (!timestampOrString) return "Time TBA";
    if (
      typeof timestampOrString === "string" &&
      /^\d{1,2}:\d{2}(\s*(AM|PM))?$/i.test(timestampOrString.trim())
    ) {
      return timestampOrString.trim();
    }
    let dateObj;
    if (typeof timestampOrString === "number") {
      dateObj = new Date(timestampOrString);
    } else {
      dateObj = new Date(timestampOrString);
    }
    if (!dateObj || Number.isNaN(dateObj.getTime())) {
      return String(timestampOrString || "Time TBA");
    }
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Manila",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).format(dateObj);
  }

  function formatPhDateDisplay(isoDateStr) {
    if (!isoDateStr) return "";
    const [y, m, d] = isoDateStr.split("-").map(Number);
    const dateObj = new Date(y, m - 1, d);
    return dateObj.toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
    });
  }

  function escapeHTML(value) {
    return String(value ?? "").replace(
      /[&<>"']/g,
      (char) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[char],
    );
  }

  // --- Source to Category Mapping ---
  function getCategoryKey(event) {
    if (!event) return "other";
    if (
      event.isHoliday === true ||
      String(event.id || event.eventId || "").startsWith("holiday:") ||
      String(event.source || "").toLowerCase().includes("holiday") ||
      String(event.category || "").toLowerCase().includes("holiday") ||
      String(event.title || "").toLowerCase().includes("holiday")
    ) {
      return "holiday";
    }

    const rawSource = String(
      event.source ||
        event.eventSource ||
        event.organizerName ||
        event.organization ||
        "",
    ).trim();

    const norm = rawSource
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase();

    if (!norm) return "other";

    if (
      norm === "csc" ||
      norm.includes("central student council") ||
      norm.includes("council")
    ) {
      return "csc";
    }

    if (
      norm.includes("teacher") ||
      norm.includes("faculty")
    ) {
      return "faculty";
    }

    if (
      norm.includes("organizational") ||
      norm.includes("organizer") ||
      /^(ibits|aces|jpcs|pice|iie|jma|jphia|pasoa|chrms|cites)\b/i.test(norm)
    ) {
      return "org";
    }

    if (
      norm === "pup official" ||
      norm.includes("pup official") ||
      norm.includes("pup binan") ||
      norm.includes("pup cite") ||
      norm.includes("official")
    ) {
      return "pup";
    }

    if (norm.includes("external") || norm.includes("other")) {
      return "other";
    }

    if (norm.startsWith("pup")) {
      return "pup";
    }

    return "other";
  }

  function isOwnOrganizerEvent(event) {
    if (isTeacher || !event) return false;
    const uid = state.currentUser?.uid;
    if (uid && (event.organizerId === uid || event.organizerUid === uid)) {
      return true;
    }
    if (event.isOwnEvent === true) return true;
    const myOrg = state.organizerProfile?.organization;
    if (
      myOrg &&
      event.organization &&
      String(event.organization).trim().toLowerCase() ===
        String(myOrg).trim().toLowerCase()
    ) {
      return true;
    }
    return false;
  }

  function isUnpublishedEvent(event) {
    if (!event) return false;
    const status = String(event.status || "").trim().toLowerCase();
    return [
      "draft",
      "pending",
      "needs revision",
      "needs_revision",
      "rejected",
      "cancelled",
      "canceled",
    ].includes(status);
  }

function normalizeEvent(id, data) {
    const dateRange = getEventDateRange(data);
    let startMs = 0;
    if (typeof data.startAt === "number") {
      startMs = data.startAt;
    } else if (data.startAt) {
      startMs = new Date(data.startAt).getTime();
    } else if (dateRange) {
      startMs = dateRange.start.getTime();
    } else if (data.dateISO || data.date) {
      startMs = new Date(`${data.dateISO || data.date}T08:00:00+08:00`).getTime();
    }

    let endMs = 0;
    if (typeof data.endAt === "number") {
      endMs = data.endAt;
    } else if (data.endAt) {
      endMs = new Date(data.endAt).getTime();
    } else if (dateRange) {
      endMs = dateRange.end.getTime();
    } else if (data.endDateISO || data.endDate) {
      endMs = new Date(`${data.endDateISO || data.endDate}T17:00:00+08:00`).getTime();
    } else {
      endMs = startMs;
    }

    let startDay = toPhDateStr(startMs || data.startAt || data.dateISO || data.date);
    let endDay = toPhDateStr(endMs || data.endAt || startMs);

    // Safety guard laban sa overflow o mahabang araw kung walang explicit end date
    if (!data.endAt && !data.endDate && !data.endDateISO && (!dateRange || dateRange.start.getTime() === dateRange.end.getTime())) {
      endDay = startDay;
    }

    const title = data.name || data.eventName || data.title || "Untitled event";
    const venue = data.venue || data.location || data.venueOther || "-";
    const source = data.source || data.eventSource || data.organizerName || "Others / External";
    const organization = 
      data.organization || 
      data.department || 
      data.organizerName || 
      (data.source ? data.source : "-");
    const status = data.status || "published";

    const categoryKey = getCategoryKey({ ...data, source, title });

    return {
      ...data,
      id: String(id),
      eventId: String(id),
      title,
      name: title,
      venue,
      location: venue,
      source,
      organization,
      status,
      startAt: startMs,
      endAt: endMs,
      startDay,
      endDay,
      categoryKey,
      isMultiDay: Boolean(startDay && endDay && startDay !== endDay),
      isOwn: isOwnOrganizerEvent(data),
      isUnpublished: isUnpublishedEvent({ status }),
      statusLabel: status.charAt(0).toUpperCase() + status.slice(1),
      time:
        data.time ||
        (startMs && endMs
          ? `${formatPhTime(startMs)} – ${formatPhTime(endMs)}`
          : "Time TBA"),
    };
  }
  

  function eventIntersectsDateRange(event, rangeStart, rangeEnd) {
    const startDay = event.startDay;
    const endDay = event.endDay || startDay;
    const isIsoDate = (value) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return false;
      const date = new Date(`${value}T00:00:00Z`);
      return !Number.isNaN(date.getTime()) &&
        date.toISOString().slice(0, 10) === value;
    };

    return isIsoDate(rangeStart) &&
      isIsoDate(rangeEnd) &&
      isIsoDate(startDay) &&
      isIsoDate(endDay) &&
      startDay <= endDay &&
      startDay <= rangeEnd &&
      endDay >= rangeStart;
  }

  function eventOccursOnDate(event, iso) {
    return eventIntersectsDateRange(event, iso, iso);
  }

  // --- Visible Events Aggregation ---
  function getAllEvents() {
    const map = new Map();

    state.publicEvents.forEach((ev) => {
      map.set(String(ev.id), ev);
    });

    state.upcomingEvents.forEach((ev) => {
      if (!map.has(String(ev.id))) {
        map.set(String(ev.id), ev);
      }
    });

    if (!isTeacher) {
      // Organizers see their own unpublished events
      state.organizerUnpublishedEvents.forEach((ev) => {
        map.set(String(ev.id), ev);
      });
    }

    // Merge monthly holidays
    state.holidays.forEach((hol) => {
      map.set(String(hol.id), hol);
    });

    const deduplicated = new Map();
    const duplicateRecords = [];
    map.forEach((event) => {
      const eventKey = [
        String(event.title || "").trim().toLowerCase(),
        event.startDay || "",
        event.endDay || "",
        String(event.venue || event.location || "").trim().toLowerCase(),
      ].join("|");
      if (!deduplicated.has(eventKey)) deduplicated.set(eventKey, event);
      else duplicateRecords.push({ kept: deduplicated.get(eventKey).id, duplicate: event.id, title: event.title });
    });
    if (duplicateRecords.length) console.warn("[OrganizerCalendar] Duplicate event records hidden from display:", duplicateRecords);

    return [...deduplicated.values()].filter((event) =>
      event.categoryKey === "holiday" ||
      isEventVisibleToStudent(event, state.organizerProfile || {}),
    );
  }

  function getFilteredEvents() {
    if (state.hiddenCategories.size === CATEGORY_DEFS.length) {
      return []; // All categories hidden
    }
    return getAllEvents().filter(
      (ev) => !state.hiddenCategories.has(ev.categoryKey),
    );
  }

  // --- Calendar Rendering ---
  function renderCalendar() {
    const year = state.date.getFullYear();
    const month = state.date.getMonth();

    renderYearOptions();
    if (monthSelect) monthSelect.value = String(month);
    if (yearSelect) yearSelect.value = String(year);
    if (currentHeading) {
      currentHeading.textContent = `${monthNames[month]} ${year}`;
    }

    // Check empty-state for category filters
    if (state.hiddenCategories.size === CATEGORY_DEFS.length) {
      if (filterEmptyState) filterEmptyState.hidden = false;
      if (calendarDays) {
        calendarDays.innerHTML = `
          <div class="calendar-grid-empty-state" style="grid-column: 1 / -1; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 280px; text-align: center; color: #7a6d66; padding: 24px;">
            <p style="font-size: 15px; font-weight: 500; margin-bottom: 12px;">No categories selected. Select at least one or press Reset.</p>
            <button type="button" class="cal-toggle" id="calEmptyResetBtn" style="cursor: pointer;">Reset</button>
          </div>
        `;
        document.getElementById("calEmptyResetBtn")?.addEventListener("click", resetAllFilters);
      }
      renderUpcomingList();
      return;
    } else {
      if (filterEmptyState) filterEmptyState.hidden = true;
    }

    if (!calendarDays) return;

    if (state.loadError) {
      calendarDays.innerHTML = `
        <div class="calendar-grid-error-state" style="grid-column: 1 / -1; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 280px; text-align: center; color: #7a6d66; padding: 24px;">
          <p style="font-size: 15px; font-weight: 500; margin-bottom: 12px;">Couldn't load events</p>
          <button type="button" class="cal-toggle" id="calTryAgainBtn" style="cursor: pointer;">Try again</button>
        </div>
      `;
      document.getElementById("calTryAgainBtn")?.addEventListener("click", () => {
        state.loadError = false;
        subscribeMonthData();
      });
      renderUpcomingList();
      return;
    }

    if (state.isLoading) {
      renderSkeletonGrid();
      renderUpcomingList();
      return;
    }

    const firstDayOfWeek = new Date(year, month, 1).getDay();
    const totalDaysInMonth = new Date(year, month + 1, 0).getDate();

    const cells = [];
    for (let i = 0; i < firstDayOfWeek; i += 1) {
      cells.push({ day: "", iso: "", muted: true, events: [] });
    }

    const filtered = getFilteredEvents();
    const lastDayNum = totalDaysInMonth;
    const monthStartDay = `${year}-${String(month + 1).padStart(2, "0")}-01`;
    const monthEndDay = `${year}-${String(month + 1).padStart(2, "0")}-${String(lastDayNum).padStart(2, "0")}`;
    const monthEvents = filtered.filter((ev) =>
      eventIntersectsDateRange(ev, monthStartDay, monthEndDay),
    );

    for (let day = 1; day <= totalDaysInMonth; day += 1) {
      const iso = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      const dayEvents = filtered
        .filter((ev) => eventOccursOnDate(ev, iso))
        .sort((a, b) => (a.startAt || 0) - (b.startAt || 0));

      cells.push({
        day,
        iso,
        muted: false,
        events: dayEvents,
      });
    }

    while (cells.length % 7 !== 0) {
      cells.push({ day: "", iso: "", muted: true, events: [] });
    }

    const now = new Date();
    const todayIso = toPhDateStr(now);

    calendarDays.innerHTML = cells
      .map((cell) => {
        if (!cell.day) {
          return '<div class="cal-day-full is-muted" aria-hidden="true"></div>';
        }

        const isToday = cell.iso === todayIso;
        const isSelected = cell.iso === state.selectedDayIso;
        const eventCount = cell.events.length;
        const displayedEvents = cell.events.slice(0, 3);
        const overflowCount = Math.max(0, eventCount - 3);

        const [cy, cm, cd] = cell.iso.split("-").map(Number);
        const monthShort = monthNames[cm - 1].slice(0, 3);
        const hasHol = cell.events.some((e) => e.isHoliday);
        let ariaDesc = `${eventCount} ${eventCount === 1 ? "event" : "events"}`;
        if (eventCount === 0) {
          ariaDesc = "no events";
        } else if (hasHol && eventCount === 1) {
          ariaDesc = "holiday";
        } else if (hasHol) {
          ariaDesc = `${eventCount} events, holiday`;
        }
        const cellAriaLabel = `${monthShort} ${cd}, ${cy}, ${ariaDesc}`;

        const barsHtml = displayedEvents
          .map((ev) => {
            const isStart = ev.isMultiDay && cell.iso === ev.startDay;
            const isEnd = ev.isMultiDay && cell.iso === ev.endDay;
            const multiClass = ev.isMultiDay
              ? `is-multiday ${isStart ? "multiday-start" : ""} ${isEnd ? "multiday-end" : ""}`
              : "";
            const mineMarker =
              !isTeacher && ev.isOwn
                ? '<span class="mine-marker">Mine</span>'
                : "";
            const unpubTag =
              !isTeacher && ev.isUnpublished
                ? `<span class="unpub-tag">[${ev.statusLabel}]</span>`
                : "";

            const isHol = Boolean(ev.isHoliday);
            return `
              <div
                class="cal-day-bar bar-${ev.categoryKey} ${multiClass} ${ev.isOwn ? "is-mine" : ""} ${ev.isUnpublished ? "is-unpublished" : ""} ${isHol ? "is-holiday-bar" : ""}"
                title="${escapeHTML(ev.title)} (${ev.organization || ev.source})"
                ${!isHol ? `data-event-id="${escapeHTML(ev.id)}"` : ""}
                ${isHol ? 'style="cursor: default; pointer-events: none;"' : ""}
              >
                ${mineMarker}${unpubTag}<span class="bar-title">${escapeHTML(ev.title)}</span>
              </div>
            `;
          })
          .join("");

        const overflowHtml = overflowCount
          ? `<span class="cal-more-chip">+${overflowCount} more</span>`
          : "";

        return `
          <div
            class="cal-day-full ${isToday ? "is-today" : ""} ${isSelected && !hasHol ? "is-selected" : ""} ${hasHol ? "is-holiday only-holiday" : ""}"
            data-iso="${cell.iso}"
            data-date="${cell.iso}"
            tabindex="${hasHol ? "-1" : "0"}"
            role="${hasHol ? "gridcell" : "button"}"
            ${hasHol ? 'aria-disabled="true"' : `aria-pressed="${isSelected ? "true" : "false"}"`}
            aria-label="${escapeHTML(cellAriaLabel)}"
          >
            <span class="day-num">${cell.day}</span>
            <div class="cal-day-events">
              ${barsHtml}
              ${overflowHtml}
            </div>
          </div>
        `;
      })
      .join("");

    renderUpcomingList(monthEvents.length === 0);
  }

  // --- Upcoming Events Card Rendering ---
  function renderUpcomingList(isMonthEmpty = false) {
    if (!upcomingList) return;

    if (state.isLoading) {
      upcomingList.innerHTML = '<div class="upcoming-empty">Loading events...</div>';
      return;
    }

    const filtered = getFilteredEvents();
    const todayIso = toPhDateStr(new Date());

    // Filter upcoming events: events occurring on or after today
    const upcoming = filtered
      .filter((ev) => ev.endDay && ev.endDay >= todayIso)
      .sort((a, b) => {
        const diff = (a.startAt || 0) - (b.startAt || 0);
        if (diff !== 0) return diff;
        return (a.title || "").localeCompare(b.title || "");
      })
      .slice(0, 5);

    if (!upcoming.length) {
      upcomingList.innerHTML = `<div class="upcoming-empty">${isMonthEmpty ? "No events this month." : "No upcoming events."}</div>`;
      return;
    }

    upcomingList.innerHTML = upcoming
      .map((ev) => {
        const isHol = Boolean(ev.isHoliday);
        const [y, m, d] = (ev.startDay || "").split("-").map(Number);
        const dateObj = y && m && d ? new Date(y, m - 1, d) : null;
        const monthShort = dateObj
          ? dateObj.toLocaleDateString("en-US", { month: "short" }).toUpperCase()
          : "TBA";
        const dayNum = d || "";
        const sourceLabel = isHol
          ? "Holiday"
          : (ev.organization || ev.source || "Event Organizer");

        if (isHol) {
          return `
            <div
              class="upcoming-item upcoming-item--holiday"
              style="cursor: default; pointer-events: none;"
              aria-label="${escapeHTML(ev.title)} (Holiday)"
            >
              <div class="upcoming-date date-holiday">
                <span>${escapeHTML(String(dayNum))}</span>
                <small>${escapeHTML(monthShort)}</small>
              </div>
              <div class="upcoming-copy">
                <strong>${escapeHTML(ev.title)}</strong>
                <span>Holiday</span>
              </div>
            </div>
          `;
        }

        const mineTag =
          !isTeacher && ev.isOwn
            ? '<span class="mine-marker">Mine</span>'
            : "";
        const unpubTag =
          !isTeacher && ev.isUnpublished
            ? `<span class="unpub-tag">[${ev.statusLabel}]</span>`
            : "";

        return `
          <div
            class="upcoming-item"
            data-event-id="${escapeHTML(ev.id)}"
            tabindex="0"
            role="button"
            aria-label="${escapeHTML(ev.title)} (${escapeHTML(sourceLabel)})"
          >
            <div class="upcoming-date date-${ev.categoryKey}">
              <span>${escapeHTML(String(dayNum))}</span>
              <small>${escapeHTML(monthShort)}</small>
            </div>
            <div class="upcoming-copy">
              <strong>${mineTag}${unpubTag}${escapeHTML(ev.title)}</strong>
              <span>${escapeHTML(sourceLabel)}</span>
            </div>
          </div>
        `;
      })
      .join("");
  }

  function renderSkeletonGrid() {
    const cells = Array.from({ length: 35 }, () => `
      <div class="cal-day-full is-skeleton">
        <span class="skeleton-num"></span>
        <div class="skeleton-bar"></div>
        <div class="skeleton-bar short"></div>
      </div>
    `);
    calendarDays.innerHTML = cells.join("");
  }

  function renderYearOptions() {
    if (!yearSelect) return;
    const currentYear = state.date.getFullYear();
    const years = Array.from(
      { length: 21 },
      (_, index) => currentYear - 10 + index,
    );
    yearSelect.innerHTML = years
      .map((y) => `<option value="${y}">${y}</option>`)
      .join("");
  }

  // --- Day View Modal ---
  function openDay(iso) {
    if (!iso) return;

    // Do not open modal or select dates with holidays
    const filtered = getFilteredEvents();
    const hasHol = filtered.some(
      (ev) => ev.isHoliday && ev.startDay && ev.endDay && ev.startDay <= iso && ev.endDay >= iso,
    );
    if (hasHol) return;

    state.selectedDayIso = iso;

    // Update URL parameter ?day=YYYY-MM-DD
    const url = new URL(window.location.href);
    url.searchParams.set("day", iso);
    window.history.replaceState({}, "", url.toString());

    // Highlight selected cell
    calendarDays?.querySelectorAll(".cal-day-full").forEach((cell) => {
      if (cell.dataset.iso === iso) {
        cell.classList.add("is-selected");
      } else {
        cell.classList.remove("is-selected");
      }
    });

    const dayEvents = filtered
      .filter((ev) => ev.startDay && ev.endDay && ev.startDay <= iso && ev.endDay >= iso)
      .sort((a, b) => (a.startAt || 0) - (b.startAt || 0));

    if (dayTitle) {
      dayTitle.textContent = formatPhDateDisplay(iso);
    }

    if (!dayList) return;

    if (!dayEvents.length) {
      dayList.innerHTML =
        '<p style="padding: 16px; color: #7a6d66; text-align: center;">No events scheduled for this day.</p>';
    } else {
      dayList.innerHTML = dayEvents
        .map((ev) => {
          const isHol = Boolean(ev.isHoliday);
          const timeText = isHol ? "All Day" : ev.time || "Time TBA";
          const venueText = ev.venue || "—";
          const orgText = ev.organization || ev.source || "—";
          const statusText = ev.statusLabel || (isHol ? "Holiday" : "Published");

          const mineTag =
            !isTeacher && ev.isOwn
              ? '<span class="mine-marker" style="margin-right:6px;">Mine</span>'
              : "";
          const unpubTag =
            !isTeacher && ev.isUnpublished
              ? `<span class="unpub-tag" style="margin-right:6px;">[${statusText}]</span>`
              : "";

          return `
            <div
              class="day-modal-row-card card-${ev.categoryKey} ${isHol ? "is-holiday" : ""}"
              ${!isHol ? `data-event-id="${escapeHTML(ev.id)}"` : ""}
              role="${isHol ? "article" : "button"}"
              tabindex="${isHol ? "-1" : "0"}"
            >
              <div class="dm-row-header">
                <span class="dm-row-title">${mineTag}${unpubTag}${escapeHTML(ev.title)}</span>
                <span class="dm-row-status">${escapeHTML(statusText)}</span>
              </div>
              <div class="dm-row-meta">
                <span>🕒 ${escapeHTML(timeText)}</span>
                <span>📍 ${escapeHTML(venueText)}</span>
                <span class="dm-row-org">🏛️ ${escapeHTML(orgText)}</span>
              </div>
            </div>
          `;
        })
        .join("");
    }

    if (dayModal) {
      dayModal.classList.add("is-open");
    }
  }

  function closeDayModal() {
    if (dayModal) {
      dayModal.classList.remove("is-open");
    }
  }

  // --- Event Detail Modal Integration ---
  function openEventDetails(eventId) {
    if (!eventId) return;
    const all = getAllEvents();
    const event = all.find((item) => String(item.id) === String(eventId));
    if (!event || event.isHoliday) return;

    const isOwnUnpub = !isTeacher && event.isOwn && event.isUnpublished;

    if (window.RecovibeEventDetails?.open) {
      const options = {};
      if (isOwnUnpub) {
        options.actionLabel = "Edit Event";
        options.onAction = () => {
          window.location.href = `EventOrganizerCreateEvent.html?edit=${encodeURIComponent(event.id)}`;
        };
      }
      window.RecovibeEventDetails.open(event, options);
    } else {
      // Fallback modal in page
      const modalTitle = document.getElementById("organizerModalTitle");
      const modalTag = document.getElementById("organizerModalTag");
      const modalDate = document.getElementById("organizerModalDate");
      const modalTime = document.getElementById("organizerModalTime");
      const modalLocation = document.getElementById("organizerModalLocation");
      const modalDescription = document.getElementById("organizerModalDescription");
      const modalSlots = document.getElementById("organizerModalSlots");
      const modalLink = document.getElementById("organizerModalEdit");

      if (modalTag) modalTag.textContent = event.source || "Event";
      if (modalTitle) modalTitle.textContent = event.title;
      if (modalDate) modalDate.textContent = formatPhDateDisplay(event.startDay);
      if (modalTime) modalTime.textContent = event.time;
      if (modalLocation) modalLocation.textContent = event.venue;
      if (modalDescription) modalDescription.textContent = event.description || "No description.";
      if (modalSlots) {
        modalSlots.textContent =
          event.capacity != null ? `${event.capacity - (event.registeredCount || 0)} slots open` : "";
      }
      if (modalLink) {
        if (isTeacher) {
          modalLink.href = "TeacherAllEvent.html";
          modalLink.textContent = "View All Events";
        } else {
          modalLink.href = `EventOrganizerAllEvents.html?eventId=${encodeURIComponent(event.id)}`;
          modalLink.textContent = isOwnUnpub ? "Edit Event" : "View Event";
        }
      }
      if (detailModal) detailModal.classList.add("is-open");
    }
  }

  function closeDetailModal() {
    if (detailModal) detailModal.classList.remove("is-open");
  }

  // --- Data Subscription (RTDB publicEvents with resilient fallback) ---
  function cleanupListeners() {
    if (activeFallbackTimer) {
      clearTimeout(activeFallbackTimer);
      activeFallbackTimer = null;
    }
    if (activePublicEventsRef && activePublicEventsCallback) {
      try {
        off(activePublicEventsRef, "value", activePublicEventsCallback);
      } catch (e) {}
      activePublicEventsRef = null;
      activePublicEventsCallback = null;
    }
    if (activeOrganizerEventsRef && activeOrganizerEventsCallback) {
      try {
        off(activeOrganizerEventsRef, "value", activeOrganizerEventsCallback);
      } catch (e) {}
      activeOrganizerEventsRef = null;
      activeOrganizerEventsCallback = null;
    }
  }

  async function fetchApprovedEvents() {
    const list = [];
    const seen = new Set();

    // 1. Try Firestore events
    try {
      const { db, isFirebaseConfigured } = await import(
        "../UserStudent/firebaseConfig.js"
      );
      if (isFirebaseConfigured && db) {
        const { collection, getDocs, query, where } = await import(
          "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js"
        );
        const eventsRef = collection(db, "events");
        const publicSnapshots = await Promise.all([
          getDocs(query(eventsRef, where("status", "in", [
            "approved", "Approved", "APPROVED",
            "published", "Published", "PUBLISHED",
            "completed", "Completed", "COMPLETED",
            "rescheduled", "Rescheduled", "RESCHEDULED",
          ]))),
          getDocs(query(eventsRef, where("publicationStatus", "in", [
            "published", "Published", "PUBLISHED",
          ]))),
          getDocs(query(eventsRef, where("published", "==", true))),
          getDocs(query(eventsRef, where("isPublished", "==", true))),
        ]);
        const publicDocuments = new Map();
        publicSnapshots.forEach((snapshot) => {
          snapshot.docs.forEach((document) => {
            publicDocuments.set(document.id, document);
          });
        });
        publicDocuments.forEach((doc) => {
          const data = doc.data();
          const s = String(data.status || "").trim().toLowerCase();
          const isApprovedOrPub =
            data.published === true ||
            ["approved", "published", "completed", "rescheduled"].includes(s);
          const isUnpub = [
            "draft",
            "rejected",
            "cancelled",
            "canceled",
          ].includes(s);
          if (isApprovedOrPub && !isUnpub) {
            const ev = normalizeEvent(doc.id, data);
            if (!seen.has(ev.id)) {
              seen.add(ev.id);
              list.push(ev);
            }
          }
        });
      }
    } catch (e) {
      console.warn("Firestore events query error:", e);
    }

    // 2. Global window.RECOVIBE_EVENTS
    if (Array.isArray(window.RECOVIBE_EVENTS)) {
      window.RECOVIBE_EVENTS.forEach((data) => {
        const id = String(data.id || data.eventId || "");
        if (!id || seen.has(id)) return;
        const s = String(data.status || "").trim().toLowerCase();
        if (
          ["published", "completed", "approved", "rescheduled"].includes(s) ||
          data.published === true
        ) {
          const ev = normalizeEvent(id, data);
          seen.add(ev.id);
          list.push(ev);
        }
      });
    }

    // 3. LocalStorage public events / organizer events
    [
      "recovibePublicEvents",
      "recovibeOrganizerEvents",
      "recovibeTeacherEvents",
    ].forEach((key) => {
      try {
        const stored = JSON.parse(localStorage.getItem(key) || "[]");
        if (Array.isArray(stored)) {
          stored.forEach((data) => {
            const id = String(data.id || data.eventId || "");
            if (!id || seen.has(id)) return;
            const s = String(data.status || "").trim().toLowerCase();
            if (
              ["published", "completed", "approved", "rescheduled"].includes(s) ||
              data.published === true
            ) {
              const ev = normalizeEvent(id, data);
              seen.add(ev.id);
              list.push(ev);
            }
          });
        }
      } catch {}
    });

    return list;
  }

  function loadOrganizerUnpublished(monthStartDay, monthEndDay) {
    if (isTeacher) return;

    const loadLocalDrafts = () => {
      const unpubList = [];
      try {
        const localDrafts = JSON.parse(
          localStorage.getItem("recovibeOrganizerEvents") || "[]",
        );
        if (Array.isArray(localDrafts)) {
          localDrafts.forEach((ld) => {
            if (isUnpublishedEvent(ld)) {
              const ev = normalizeEvent(ld.id || ld.eventId || `local_${Date.now()}`, ld, true);
              if (ev.startDay <= monthEndDay && ev.endDay >= monthStartDay) {
                if (!unpubList.some((e) => String(e.id) === String(ev.id))) {
                  unpubList.push(ev);
                }
              }
            }
          });
        }
      } catch {}
      return unpubList;
    };

    state.organizerUnpublishedEvents = loadLocalDrafts();

    if (state.currentUser && rtdb) {
      try {
        activeOrganizerEventsRef = ref(rtdb, `organizerEvents/${state.currentUser.uid}`);
        activeOrganizerEventsCallback = (snapshot) => {
          const val = snapshot.val() || {};
          const rtdbUnpub = [];

          Object.entries(val).forEach(([id, data]) => {
            if (!data) return;
            if (!isUnpublishedEvent(data)) return;

            const ev = normalizeEvent(id, data, true);
            if (ev.startDay <= monthEndDay && ev.endDay >= monthStartDay) {
              rtdbUnpub.push(ev);
            }
          });

          const localList = loadLocalDrafts();
          localList.forEach((ld) => {
            if (!rtdbUnpub.some((e) => String(e.id) === String(ld.id))) {
              rtdbUnpub.push(ld);
            }
          });

          state.organizerUnpublishedEvents = rtdbUnpub;
          if (!state.isLoading) {
            renderCalendar();
          }
        };

        onValue(activeOrganizerEventsRef, activeOrganizerEventsCallback, (err) => {
          console.warn("Error reading organizer unpublished events:", err);
        });
      } catch (e) {
        console.warn("RTDB organizer listener error:", e);
      }
    }
  }

  async function subscribeMonthData() {
    cleanupListeners();
    state.isLoading = true;
    state.loadError = false;
    renderCalendar();

    const year = state.date.getFullYear();
    const month = state.date.getMonth();

    const lastDayNum = new Date(year, month + 1, 0).getDate();
    const monthStartDay = `${year}-${String(month + 1).padStart(2, "0")}-01`;
    const monthEndDay = `${year}-${String(month + 1).padStart(2, "0")}-${String(lastDayNum).padStart(2, "0")}`;

    const queryStartDate = new Date(year, month, 1 - 31);
    const queryStartIso = `${queryStartDate.getFullYear()}-${String(queryStartDate.getMonth() + 1).padStart(2, "0")}-${String(queryStartDate.getDate()).padStart(2, "0")}`;
    const queryStartMs = new Date(`${queryStartIso}T00:00:00+08:00`).getTime();
    const monthEndMs = new Date(`${monthEndDay}T23:59:59.999+08:00`).getTime();

    // 1. Fetch holidays for this visible month
    const currentSeq = ++holidayRequestSequence;
    fetchMonthHolidays(year, month)
      .then((monthHolidays) => {
        if (currentSeq !== holidayRequestSequence) return;
        state.holidays = (monthHolidays || []).map((h) => ({
          id: `holiday:${h.date}:${h.title}`,
          eventId: `holiday:${h.date}:${h.title}`,
          title: h.title,
          name: h.title,
          dateISO: h.date,
          startDay: h.date,
          endDay: h.date,
          startAt: new Date(`${h.date}T00:00:00+08:00`).getTime(),
          endAt: new Date(`${h.date}T23:59:59+08:00`).getTime(),
          venue: "—",
          organization: "National Holiday",
          source: "Holiday",
          categoryKey: "holiday",
          status: "Holiday",
          isHoliday: true,
          time: "All Day",
        }));
        if (!state.isLoading) {
          renderCalendar();
        }
      })
      .catch((err) => {
        console.warn("Could not load monthly holidays:", err);
      });

    // 2. Query publicEvents from RTDB with resilient fallback timeout (500ms)
    let rtdbResponded = false;

    activeFallbackTimer = setTimeout(async () => {
      if (rtdbResponded) return;
      rtdbResponded = true;
      try {
        const allEvs = await fetchApprovedEvents();
        state.upcomingEvents = allEvs;
        state.publicEvents = allEvs.filter(
          (ev) => ev.startDay <= monthEndDay && ev.endDay >= monthStartDay,
        );
        state.loadError = false;
      } catch (err) {
        console.warn("Error loading fallback events:", err);
        state.loadError = true;
      } finally {
        state.isLoading = false;
        renderCalendar();
      }
    }, 500);

    if (rtdb) {
      try {
        activePublicEventsRef = query(
          ref(rtdb, "publicEvents"),
          orderByChild("startAt"),
          startAt(queryStartMs),
          endAt(monthEndMs),
        );

        activePublicEventsCallback = (snapshot) => {
          rtdbResponded = true;
          if (activeFallbackTimer) {
            clearTimeout(activeFallbackTimer);
            activeFallbackTimer = null;
          }
          state.isLoading = false;
          state.loadError = false;

          const val = snapshot.val() || {};
          const records = [];

          Object.entries(val).forEach(([id, data]) => {
            if (!data) return;
            const status = String(data.status || "").trim().toLowerCase();
            if (status !== "published" && status !== "completed") return;

            const ev = normalizeEvent(id, data);
            if (ev.startDay <= monthEndDay && ev.endDay >= monthStartDay) {
              records.push(ev);
            }
          });

          state.publicEvents = records;

          fetchApprovedEvents().then((evs) => {
            state.upcomingEvents = evs;
            renderUpcomingList();
          });

          renderCalendar();
        };

        onValue(activePublicEventsRef, activePublicEventsCallback, async (err) => {
          console.warn("Error reading publicEvents from RTDB:", err);
          rtdbResponded = true;
          if (activeFallbackTimer) {
            clearTimeout(activeFallbackTimer);
            activeFallbackTimer = null;
          }
          try {
            const allEvs = await fetchApprovedEvents();
            state.upcomingEvents = allEvs;
            state.publicEvents = allEvs.filter(
              (ev) => ev.startDay <= monthEndDay && ev.endDay >= monthStartDay,
            );
            state.loadError = false;
          } catch (e) {
            state.loadError = true;
          } finally {
            state.isLoading = false;
            renderCalendar();
          }
        });
      } catch (queryErr) {
        console.warn("RTDB query error:", queryErr);
        rtdbResponded = true;
        if (activeFallbackTimer) {
          clearTimeout(activeFallbackTimer);
          activeFallbackTimer = null;
        }
        const allEvs = await fetchApprovedEvents();
        state.upcomingEvents = allEvs;
        state.publicEvents = allEvs.filter(
          (ev) => ev.startDay <= monthEndDay && ev.endDay >= monthStartDay,
        );
        state.isLoading = false;
        renderCalendar();
      }
    } else {
      rtdbResponded = true;
      if (activeFallbackTimer) {
        clearTimeout(activeFallbackTimer);
        activeFallbackTimer = null;
      }
      const allEvs = await fetchApprovedEvents();
      state.upcomingEvents = allEvs;
      state.publicEvents = allEvs.filter(
        (ev) => ev.startDay <= monthEndDay && ev.endDay >= monthStartDay,
      );
      state.isLoading = false;
      renderCalendar();
    }

    // 3. For Organizer: load own unpublished events
    loadOrganizerUnpublished(monthStartDay, monthEndDay);
  }

  function setCalendarMonth(year, month) {
    state.date = new Date(year, month, 1);
    subscribeMonthData();
  }

  // --- Filter State & URL Sync ---
  function initFilterFromURL() {
    const urlParams = new URLSearchParams(window.location.search);
    const hideParam = urlParams.get("hide");
    if (hideParam) {
      const keys = hideParam
        .toLowerCase()
        .split(",")
        .map((k) => k.trim())
        .filter(Boolean);
      state.hiddenCategories = new Set(keys);
    } else {
      state.hiddenCategories.clear();
    }

    filterCheckboxes.forEach((cb) => {
      const key = cb.dataset.categoryKey;
      cb.checked = !state.hiddenCategories.has(key);
    });
  }

  function updateFilterURL() {
    const hidden = Array.from(state.hiddenCategories);
    const url = new URL(window.location.href);
    if (hidden.length > 0) {
      url.searchParams.set("hide", hidden.join(","));
    } else {
      url.searchParams.delete("hide");
    }
    window.history.replaceState({}, "", url.toString());
  }

  function resetAllFilters() {
    state.hiddenCategories.clear();
    filterCheckboxes.forEach((cb) => {
      cb.checked = true;
    });
    updateFilterURL();
    renderCalendar();
  }

  // --- Event Listeners Setup ---
  function setupEventListeners() {
    monthSelect?.addEventListener("change", () => {
      setCalendarMonth(state.date.getFullYear(), Number(monthSelect.value));
    });

    yearSelect?.addEventListener("change", () => {
      setCalendarMonth(Number(yearSelect.value), state.date.getMonth());
    });

    prevButton?.addEventListener("click", () => {
      setCalendarMonth(state.date.getFullYear(), state.date.getMonth() - 1);
    });

    nextButton?.addEventListener("click", () => {
      setCalendarMonth(state.date.getFullYear(), state.date.getMonth() + 1);
    });

    todayButton?.addEventListener("click", () => {
      const now = new Date();
      state.date = new Date(now.getFullYear(), now.getMonth(), 1);
      subscribeMonthData();
    });

    filterCheckboxes.forEach((cb) => {
      cb.addEventListener("change", () => {
        const key = cb.dataset.categoryKey;
        if (cb.checked) {
          state.hiddenCategories.delete(key);
        } else {
          state.hiddenCategories.add(key);
        }
        updateFilterURL();
        renderCalendar();
      });
    });

    resetFiltersBtn?.addEventListener("click", resetAllFilters);

    upcomingList?.addEventListener("click", (e) => {
      const item = e.target.closest("[data-event-id]");
      if (!item) return;
      openEventDetails(item.dataset.eventId);
    });

    upcomingList?.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        const item = e.target.closest("[data-event-id]");
        if (item) {
          e.preventDefault();
          openEventDetails(item.dataset.eventId);
        }
      }
    });

    calendarDays?.addEventListener("click", (e) => {
      const cell = e.target.closest("[data-iso]");
      if (cell && (cell.classList.contains("is-holiday") || cell.classList.contains("only-holiday") || cell.getAttribute("aria-disabled") === "true")) {
        return;
      }
      const bar = e.target.closest("[data-event-id]");
      if (bar) {
        if (bar.classList.contains("bar-holiday") || bar.classList.contains("is-holiday-bar") || bar.dataset.eventId?.startsWith("holiday:")) {
          return;
        }
        e.stopPropagation();
        openEventDetails(bar.dataset.eventId);
        return;
      }
      if (cell) {
        openDay(cell.dataset.iso);
      }
    });

    calendarDays?.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        const cell = e.target.closest("[data-iso]");
        if (cell) {
          if (cell.classList.contains("is-holiday") || cell.classList.contains("only-holiday") || cell.getAttribute("aria-disabled") === "true") {
            return;
          }
          e.preventDefault();
          openDay(cell.dataset.iso);
        }
      }
    });

    dayList?.addEventListener("click", (e) => {
      const row = e.target.closest("[data-event-id]");
      if (row) {
        openEventDetails(row.dataset.eventId);
      }
    });

    dayClose?.addEventListener("click", closeDayModal);
    detailClose?.addEventListener("click", closeDetailModal);

    dayModal?.addEventListener("click", (e) => {
      if (e.target === dayModal) closeDayModal();
    });
    detailModal?.addEventListener("click", (e) => {
      if (e.target === detailModal) closeDetailModal();
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        closeDayModal();
        closeDetailModal();
      }
    });

    window.addEventListener("beforeunload", cleanupListeners);
    window.addEventListener("pagehide", cleanupListeners);
  }

  // --- Profile & Role Sidebar Hydration ---
  function hydrateSidebar() {
    if (isTeacher) {
      try {
        const teacher = JSON.parse(
          localStorage.getItem("recovibeCurrentTeacher") || "null",
        );
        if (teacher) {
          const name = teacher.name || teacher.fullName || "Teacher";
          const nameEl = document.getElementById("teacherCalendarName");
          const roleEl = document.getElementById("teacherCalendarRole");
          const avatarEl = document.getElementById("teacherCalendarAvatar");
          if (nameEl) nameEl.textContent = name;
          if (roleEl) {
            roleEl.textContent =
              teacher.department ||
              teacher.organization ||
              teacher.role ||
              "Faculty account";
          }
          if (avatarEl) {
            avatarEl.textContent = name
              .split(/\s+/)
              .filter(Boolean)
              .map((part) => part[0])
              .slice(0, 2)
              .join("")
              .toUpperCase();
          }
        }
      } catch (e) {
        console.warn("Unable to load teacher profile:", e);
      }
      document
        .getElementById("teacherCalendarLogout")
        ?.addEventListener("click", () => {
          localStorage.removeItem("recovibeCurrentTeacher");
          localStorage.removeItem("recovibeTeacherId");
        });
    } else {
      try {
        const storedProfile = localStorage.getItem("recovibeOrganizerProfile");
        if (storedProfile) {
          state.organizerProfile = JSON.parse(storedProfile);
          const name = String(state.organizerProfile.name || "Event Organizer");
          const org = String(state.organizerProfile.organization || "IBITS");
          const nameEl = document.getElementById("userName");
          const roleEl = document.getElementById("userRole");
          const avatarEl = document.getElementById("userAvatar");
          if (nameEl) nameEl.textContent = name;
          if (roleEl) roleEl.textContent = `${org} account`;
          if (avatarEl) {
            avatarEl.textContent =
              name
                .split(/\s+/)
                .filter(Boolean)
                .map((p) => p[0].toUpperCase())
                .slice(0, 2)
                .join("") || "EO";
          }
        }
      } catch (e) {
        console.warn("Unable to load organizer profile:", e);
      }
    }
  }

  // --- Initialize ---
  function init() {
    initFilterFromURL();
    hydrateSidebar();
    setupEventListeners();

    // Check ?day=YYYY-MM-DD parameter on load
    const urlParams = new URLSearchParams(window.location.search);
    const dayParam = urlParams.get("day");
    if (dayParam && /^\d{4}-\d{2}-\d{2}$/.test(dayParam)) {
      const [dYear, dMonth, dDay] = dayParam.split("-").map(Number);
      state.date = new Date(dYear, dMonth - 1, dDay);
      state.selectedDayIso = dayParam;
    }

    if (monthSelect) {
      monthSelect.innerHTML = monthNames
        .map((m, i) => `<option value="${i}">${m}</option>`)
        .join("");
    }
    renderYearOptions();

    // Authentication observation
    if (auth) {
      authReady.then(() => onAuthStateChanged(auth, (user) => {
        state.currentUser = user;
        if (!user && !isTeacher) {
          const localOrganizer = localStorage.getItem("recovibeOrganizerId");
          if (!localOrganizer && isRtdbConfigured) {
            window.location.replace("EventOrganizerLogin.html");
            return;
          }
        }
        subscribeMonthData().then(() => {
          if (dayParam) {
            openDay(dayParam);
          }
        });
      })).catch((error) => {
        console.error("Could not restore organizer authentication state:", error);
      });
    } else {
      subscribeMonthData().then(() => {
        if (dayParam) {
          openDay(dayParam);
        }
      });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
