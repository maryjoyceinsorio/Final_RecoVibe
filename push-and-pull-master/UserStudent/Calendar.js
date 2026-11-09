import { fetchMonthHolidays } from "../holidayService.js";
import { auth, db } from "./firebaseConfig.js";
import {
  clearCachedStudentProfile,
  loadStudentProfile,
  renderStudentSidebar,
} from "./studentIdentity.js";
import {
  isEventVisibleToStudent,
  isStudentEventStatus,
  STUDENT_EVENT_STATUSES,
} from "./eventAudience.js";
import {
  clampEventDateRangeToGrid,
  getEventDateRange,
} from "./calendarDateRange.mjs";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  collection,
  onSnapshot,
  query,
  where,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

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
  let firestoreEvents = [];
  let holidayEvents = [];
  let events = [];
  let studentProfile = {};
  let eventsUnsubscribe = null;
  let authUnsubscribe = null;
  let currentStudentUid = "";
  let eventLoadError = "";
  let profileLoadError = "";
  let holidayLoadError = "";
  let eventsLoading = true;
  let disposed = false;
  let authRequestSequence = 0;
  let holidayRequestSequence = 0;
  let activeSources = [];
  const state = {
    date: new Date(),
  };
  const monthSelect = document.getElementById("calMonthSelect");
  const yearSelect = document.getElementById("calYearSelect");
  const calendarDays = document.getElementById("calFullDays");
  const modal = document.getElementById("organizerModalOverlay");
  const dayModal = document.getElementById("organizerDayOverlay");
  const upcomingPanel = document.querySelector(".upcoming-panel");
  const todayButton = document.querySelector(".cal-toggle");
  const resetButton = document.querySelector(".filter-reset");
  const statusElement = document.createElement("div");
  statusElement.id = "calendarDataStatus";
  statusElement.setAttribute("role", "status");
  statusElement.setAttribute("aria-live", "polite");
  statusElement.hidden = true;
  calendarDays.parentNode.insertBefore(statusElement, calendarDays);

  const manilaDateKey = (date) => {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "";
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Manila",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date);
    const part = (type) => parts.find((item) => item.type === type)?.value;
    return `${part("year")}-${part("month")}-${part("day")}`;
  };
  const dateFromISO = (iso) => {
    if (!iso) return null;
    const [year, month, day] = iso.split("-").map(Number);
    return new Date(year, month - 1, day, 12);
  };
  state.date = dateFromISO(manilaDateKey(new Date())) || state.date;
  const todayISO = () => manilaDateKey(new Date());

  function normalizeCalendarEvent(id, data) {
    const raw = data || {};
    const calendarDateRange = getEventDateRange(raw);
    let start = calendarDateRange
      ? manilaDateKey(calendarDateRange.start)
      : "";
    let end = calendarDateRange
      ? manilaDateKey(calendarDateRange.end)
      : "";

    // --- SAFETY GUARD PARA SA CORRUPTED / OVERFLOW DATES ---
    if (start && end) {
      const startMs = new Date(start).getTime();
      const endMs = new Date(end).getTime();
      const diffDays = Math.round((endMs - startMs) / (1000 * 60 * 60 * 24));
      
      // Kung lumampas ng 14 na araw o inverted ang petsa, piliting maging 1-day event
      if (diffDays > 14 || diffDays < 0) {
        end = start;
      }
    }

    const normalized = {
      ...raw,
      id: String(id || raw.id || raw.eventId || ""),
      eventId: String(id || raw.eventId || raw.id || ""),
      title: raw.title || raw.eventName || raw.name || "Untitled event",
      status: raw.status || raw.publicationStatus || "",
      category: raw.category || raw.categories || raw.tag || "",
      targetAudience: raw.targetAudience || raw.target_audience ||
        raw.audienceType || raw.audience_type || raw.audience || "",
      dateISO: start,
      endDateISO: end,
      calendarDateRange,
      source: raw.source || raw.eventSource || raw.category || raw.organization ||
        raw.organizerName || "",
      time: raw.time ||
        [raw.timeStart || raw.startTime, raw.timeEnd || raw.endTime]
          .filter(Boolean)
          .join(" - ") ||
        "Time TBA",
      location: raw.location || raw.venue || raw.venueOther || "",
    };
    return normalized;
  }

  function eventDateRange(event) {
    return event.calendarDateRange || getEventDateRange(event);
  }

  function eventOccursOn(event, iso) {
    const range = eventDateRange(event);
    return Boolean(
      range && manilaDateKey(range.start) <= iso && iso <= manilaDateKey(range.end),
    );
  }

  function eventIdentity(event) {
    const id = String(event.id || event.eventId || "");
    if (id) return id;
    const range = eventDateRange(event);
    return `${event.title || ""}:${manilaDateKey(range?.start)}:${manilaDateKey(range?.end)}`;
  }

  function updateDataStatus() {
    const message = eventsLoading
      ? "Loading calendar events…"
      : eventLoadError || profileLoadError || holidayLoadError;
    statusElement.hidden = !message;
    statusElement.textContent = message;
    statusElement.className = message
      ? eventsLoading ? "calendar-data-status is-loading" : "calendar-data-status is-error"
      : "calendar-data-status";
    statusElement.setAttribute(
      "role",
      eventsLoading ? "status" : message ? "alert" : "status",
    );
  }

  const escape = (value) =>
    String(value ?? "").replace(
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

  function resolveSourceMeta(sourceStr) {
    const norm = String(sourceStr || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .trim()
      .toLowerCase();

    if (norm.includes("holiday")) {
      return {
        key: "Holiday",
        label: "Holiday",
        dotClass: "holiday",
        accent: "var(--cat-holiday, #d97706)",
      };
    }
    if (
      norm === "csc" ||
      norm.includes("centralstudentcouncil") ||
      norm.includes("central student council") ||
      norm === "council"
    ) {
      return {
        key: "CSC",
        label: "CSC",
        dotClass: "csc",
        accent: "var(--cat-cite, #c79a2b)",
      };
    }
    if (norm.includes("binan")) {
      return {
        key: "PUP Biñan Campus",
        label: "PUP Biñan",
        dotClass: "binan",
        accent: "var(--cat-binan, #3a76c4)",
      };
    }
    if (
      norm.includes("pup") ||
      norm.includes("official") ||
      norm.includes("cite") ||
      norm.includes("teacher") ||
      norm.includes("faculty")
    ) {
      return {
        key: "PUP Official",
        label: "PUP Official",
        dotClass: "official",
        accent: "var(--cat-official, #8f2536)",
      };
    }
    if (
      norm.includes("organizer") ||
      norm.includes("organization") ||
      norm.includes("organizational") ||
      /^(ibits|aces|jpcs|pice|iie|piie|hrss|sms|yes|jma|jphia|pasoa|chrms|cites)\b/i.test(norm)
    ) {
      return {
        key: "Organizational",
        label: "Organizational",
        dotClass: "organizational",
        accent: "var(--cat-ibits, #7c5cc4)",
      };
    }
    return {
      key: "Others/External",
      label: "Others/External",
      dotClass: "external",
      accent: "var(--cat-external, #64748b)",
    };
  }

  function getStudentActiveSources() {
    let rawList = null;
    try {
      if (
        studentProfile.preferences &&
        Array.isArray(studentProfile.preferences.sources) &&
        studentProfile.preferences.sources.length
      ) {
        rawList = studentProfile.preferences.sources;
      } else {
        const accountPreferenceKey = `recovibePreferences:${studentProfile.uid || "student"}`;
        const accPref = JSON.parse(localStorage.getItem(accountPreferenceKey) || "null");
        if (
          accPref &&
          Array.isArray(accPref.sources) &&
          accPref.sources.length
        ) {
          rawList = accPref.sources;
        }
      }
    } catch (e) {
      console.warn("Could not read student preferences:", e);
    }

    if (!Array.isArray(rawList) || !rawList.length) {
      rawList = [
        "PUP Official",
        "PUP Biñan",
        "CSC",
        "Organizational",
        "Others/External",
      ];
    }

    const metas = [];
    const seen = new Set();
    const allowedKeys = new Set([
      "PUP Official",
      "PUP Biñan Campus",
      "CSC",
      "Organizational",
      "Others/External",
    ]);
    for (const item of rawList) {
      const meta = resolveSourceMeta(item);
      if (!allowedKeys.has(meta.key)) continue;
      if (!seen.has(meta.key)) {
        seen.add(meta.key);
        metas.push(meta);
      }
    }

    if (!seen.has("Holiday")) {
      metas.push(resolveSourceMeta("Holiday"));
      seen.add("Holiday");
    }

    return metas;
  }

  function renderFilterAndLegend() {
    activeSources = getStudentActiveSources();

    const filterPanel = document.querySelector(".filter-panel");
    if (filterPanel) {
      filterPanel.querySelectorAll(".filter-option").forEach((el) => el.remove());
      activeSources.forEach((source) => {
        const label = document.createElement("label");
        label.className = "filter-option";
        label.innerHTML = `<input type="checkbox" checked data-source="${escape(source.key)}" style="accent-color: ${source.accent};" /><span>${escape(source.label)}</span>`;
        filterPanel.appendChild(label);
      });

      filterPanel.querySelectorAll(".filter-option input").forEach((input) => {
        input.addEventListener("change", () => {
          renderCalendar();
        });
      });
    }

    const legendPanel = document.getElementById("calendarLegend");
    if (legendPanel) {
      legendPanel.querySelectorAll(".legend-item").forEach((el) => el.remove());
      activeSources.forEach((source) => {
        const item = document.createElement("span");
        item.className = "legend-item";
        item.innerHTML = `<span class="dot dot-${source.dotClass}" aria-hidden="true"></span>${escape(source.label)}`;
        legendPanel.appendChild(item);
      });
    }
  }

  function eventSource(event) {
    const rawSources = [
      event.category,
      event.categories,
      event.eventSource,
      event.source,
      event.organization,
      event.organizer,
      event.organizerName,
      event.tag,
      event.title,
      event.eventName,
      event.name,
    ].flatMap((value) => Array.isArray(value) ? value : [value])
      .map((value) => String(value || "").trim())
      .filter(Boolean);
    const normalizedSources = rawSources.map((source) =>
      source.normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .trim()
        .toLowerCase(),
    );

    if (normalizedSources.some((source) => source.includes("holiday"))) return "Holiday";
    if (normalizedSources.some((source) =>
      /(^|[^a-z])csc([^a-z]|$)/.test(source) ||
      source.includes("central student council"),
    )) return "CSC";
    if (normalizedSources.some((source) => source.includes("binan"))) {
      return "PUP Biñan Campus";
    }
    const hasOrganizationalCategory = normalizedSources.some((source) =>
      source.includes("organization") ||
      source.includes("organizational") ||
      source.includes("event organizer") ||
      source.includes("orgs & student acts") ||
      /(^|[^a-z0-9])(ibits|aces|jpcs|pice|iie|piie|hrss|sms|yes|jma|jphia|pasoa|chrms|cites)(?=$|[^a-z0-9])/i.test(source),
    );
    if (hasOrganizationalCategory) return "Organizational";
    if (normalizedSources.some((source) =>
      source.includes("pup") ||
      source.includes("official") ||
      source.includes("cite") ||
      source.includes("teacher") ||
      source.includes("faculty"),
    )) return "PUP Official";
    if (
      event.organizerId ||
      event.organization ||
      Array.isArray(event.targetOrgs) && event.targetOrgs.length > 0 ||
      Array.isArray(event.targetOrganizations) && event.targetOrganizations.length > 0
    ) return "Organizational";
    return "Others/External";
  }

  function isHolidayEvent(event) {
    if (!event) return false;
    const id = String(event.id || event.eventId || "");
    const src = String(event.source || event.eventSource || "").toLowerCase();
    const cat = String(event.category || "").toLowerCase();
    return (
      event.isHoliday === true ||
      id.startsWith("holiday:") ||
      eventSource(event) === "Holiday" ||
      src.includes("holiday") ||
      cat.includes("holiday")
    );
  }

  function eventDotClass(event) {
    const src = eventSource(event);
    return (
      {
        "PUP Official": "official",
        "PUP Biñan Campus": "binan",
        CSC: "csc",
        Organizational: "organizational",
        "Others/External": "external",
        Holiday: "holiday",
      }[src] || "external"
    );
  }

  function visibleEvents() {
    const filterPanel = document.querySelector(".filter-panel");
    const checked = filterPanel
      ? [...filterPanel.querySelectorAll(".filter-option input")]
          .filter((input) => input.checked)
          .map((input) => input.dataset.source)
      : [];
    return events.filter((event) => {
      const holiday = isHolidayEvent(event);
      if (!holiday && !isStudentEventStatus(event.status || event.publicationStatus)) {
        return false;
      }
      if (!holiday && !isEventVisibleToStudent(event, studentProfile)) {
        return false;
      }
      const category = eventSource(event);
      if (!checked.includes(category)) {
        return false;
      }
      if (!eventDateRange(event)) {
        return false;
      }
      return true;
    });
  }

  function getUpcomingEvents(visible = visibleEvents()) {
    const today = todayISO();
    const uniqueEvents = new Map();
    visible.forEach((event) => {
      const key = eventIdentity(event);
      if (!uniqueEvents.has(key)) uniqueEvents.set(key, event);
    });
    return [...uniqueEvents.values()]
      .filter((event) => {
        const range = eventDateRange(event);
        return range && manilaDateKey(range.end) >= today;
      })
      .sort((first, second) => {
        const firstRange = eventDateRange(first);
        const secondRange = eventDateRange(second);
        const firstStart = manilaDateKey(firstRange.start);
        const secondStart = manilaDateKey(secondRange.start);
        const firstDate = firstStart < today ? today : firstStart;
        const secondDate = secondStart < today ? today : secondStart;
        return firstDate.localeCompare(secondDate) ||
          String(first.title).localeCompare(String(second.title));
      });
  }

  function buildUpcomingList(visible) {
    if (!upcomingPanel) return;

    const upcoming = getUpcomingEvents(visible);

    if (!upcoming.length) {
      upcomingPanel.innerHTML =
        '<h3>Upcoming</h3><div class="upcoming-empty">No upcoming events or holidays.</div>';
      return;
    }

    upcomingPanel.innerHTML = [
      "<h3>Upcoming</h3>",
      `<div class="upcoming-list">${upcoming.slice(0, 5).map((event) => {
        const range = eventDateRange(event);
        const startDate = manilaDateKey(range.start);
        const date = dateFromISO(
          startDate < todayISO() ? todayISO() : startDate,
        );
        const month = date
          ? date.toLocaleDateString("en-US", { month: "short" }).toUpperCase()
          : "TBA";
        const day = date ? date.getDate() : "";
        const sourceLabel = eventSource(event);
        const categoryClass = `dot-${eventDotClass(event)}`;
        if (isHolidayEvent(event)) {
          return `
            <div class="upcoming-item upcoming-item--holiday" style="cursor: default;" aria-label="${escape(event.title || "Holiday")} (Holiday)">
              <div class="upcoming-date ${categoryClass}"><span>${day}</span><small>${month}</small></div>
              <div class="upcoming-copy">
                <strong title="${escape(event.title || "Holiday")}">${escape(event.title || "Holiday")}</strong>
                <span>Holiday</span>
              </div>
            </div>
          `;
        }
        return `
          <div class="upcoming-item" data-event-id="${escape(event.id || event.eventId || "")}" tabindex="0" role="button">
            <div class="upcoming-date ${categoryClass}"><span>${day}</span><small>${month}</small></div>
            <div class="upcoming-copy">
              <strong title="${escape(event.title || "Untitled event")}">${escape(event.title || "Untitled event")}</strong>
              <span>${escape(sourceLabel)}</span>
            </div>
          </div>
        `;
      }).join("")}</div>`,
      upcoming.length > 5
        ? '<button class="upcoming-more" type="button" data-upcoming-more>See all upcoming</button>'
        : "",
    ].join("");
  }

  function openRemainingUpcoming() {
    openEventList("More upcoming events", getUpcomingEvents().slice(5));
  }

  function openEventList(listTitle, listedEvents, iso) {
    const dayTitle = document.getElementById("organizerDayTitle");
    const dayList = document.getElementById("organizerDayList");
    dayTitle.textContent = listTitle;
    const openDayHeader = iso
      ? `<div style="display:flex; justify-content:flex-end; margin-bottom:10px;"><a href="Events.html?from=${encodeURIComponent(iso)}&to=${encodeURIComponent(iso)}" class="btn-open-day" style="font-size:12px; font-weight:600; color:var(--maroon-700, #7a1f2e); text-decoration:underline;" title="Open this day in Events">Open day &rarr;</a></div>`
      : "";
    dayList.innerHTML = openDayHeader + listedEvents
      .map((event) => {
        if (isHolidayEvent(event)) {
          return `<div class="day-modal-row day-modal-row--holiday dot-${eventDotClass(event)}" style="cursor: default; pointer-events: none;" aria-label="${escape(event.title || "Holiday")} (Holiday)"><strong>${escape(event.title || "Holiday")}</strong><small>Holiday</small></div>`;
        }
        return `<button class="day-modal-row dot-${eventDotClass(event)}" type="button" data-event-id="${escape(event.id || event.eventId || "")}"><strong>${escape(event.title || "Untitled event")}</strong><small>${escape(event.time || "Time TBA")}</small></button>`;
      })
      .join("");
    dayModal.classList.add("is-open");
  }

  function renderCalendar() {
    const year = state.date.getFullYear();
    const month = state.date.getMonth();
    const firstDay = new Date(year, month, 1).getDay();
    const totalDays = new Date(year, month + 1, 0).getDate();
    const calendarCellCount = Math.ceil((firstDay + totalDays) / 7) * 7;
    const gridStartISO = new Date(Date.UTC(year, month, 1 - firstDay))
      .toISOString()
      .slice(0, 10);
    const gridEndISO = new Date(Date.UTC(year, month, 1 - firstDay + calendarCellCount - 1))
      .toISOString()
      .slice(0, 10);

    renderYearOptions();
    monthSelect.value = String(month);
    yearSelect.value = String(year);

    const visible = visibleEvents();
    const eventsByDate = new Map();
    visible.forEach((event) => {
      const range = eventDateRange(event);
      if (!range) return;
      const visibleRange = clampEventDateRangeToGrid(
        range,
        gridStartISO,
        gridEndISO,
      );
      if (!visibleRange) return;
      let cursor = new Date(`${visibleRange.start}T00:00:00Z`);
      while (cursor.toISOString().slice(0, 10) <= visibleRange.end) {
        const dateKey = cursor.toISOString().slice(0, 10);
        const eventsForDate = eventsByDate.get(dateKey) || [];
        const identity = eventIdentity(event);
        if (!eventsForDate.some((item) => eventIdentity(item) === identity)) {
          eventsForDate.push(event);
          eventsByDate.set(dateKey, eventsForDate);
        }
        cursor.setUTCDate(cursor.getUTCDate() + 1);
      }
    });
    const cells = [];

    for (let index = 0; index < firstDay; index += 1) {
      cells.push({ day: "", iso: "", muted: true, events: [] });
    }

    for (let day = 1; day <= totalDays; day += 1) {
      const iso = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      cells.push({
        day,
        iso,
        muted: false,
        events: eventsByDate.get(iso) || [],
      });
    }

    while (cells.length < calendarCellCount) {
      cells.push({ day: "", iso: "", muted: true, events: [] });
    }

    calendarDays.innerHTML = cells
      .map((cell) => {
        const today = cell.iso && cell.iso === todayISO();
        const eventCount =
          cell.events && cell.events.length ? cell.events.length : 0;
        const eventDots = cell.events
          .slice(0, 3)
          .map(
            (event) =>
              `<span class="dot dot-${eventDotClass(event)}" title="${escape(event.title || "Untitled event")}"></span>`,
          )
          .join("");
        const isOnlyHoliday =
          cell.events &&
          cell.events.length > 0 &&
          cell.events.every(isHolidayEvent);
        const eventTitles = cell.events
          .map(
            (event) =>
              isHolidayEvent(event)
                ? `<span class="calendar-day-event dot-holiday" style="pointer-events: none; cursor: default;" title="${escape(event.title || "Holiday")}">${escape(event.title || "Holiday")}</span>`
                : `<span class="calendar-day-event dot-${eventDotClass(event)}" title="${escape(event.title || "Untitled event")}">${escape(event.title || "Untitled event")}</span>`,
          )
          .join("");
        const dotOverflowCount = Math.max(0, eventCount - 3);
        return `
        <div class="cal-day-full ${cell.muted ? "is-muted" : ""} ${eventCount ? "has-event" : ""} ${isOnlyHoliday ? "only-holiday" : ""} ${today ? "is-today" : ""}" ${cell.iso ? `data-date="${cell.iso}" data-iso="${cell.iso}" tabindex="0" aria-label="${cell.iso}: ${eventCount ? `${eventCount} event${eventCount === 1 ? "" : "s"}` : "no events"}"` : ""}>
          <span class="day-num">${cell.day || ""}</span>
          ${eventCount ? `<span class="event-dots" aria-hidden="true">${eventDots}${dotOverflowCount ? `<span class="event-dot-overflow">+${dotOverflowCount}</span>` : ""}</span>` : ""}
          ${eventCount ? `<span class="calendar-day-event-list">${eventTitles}<button class="calendar-day-more" type="button" hidden></button></span>` : ""}
        </div>
      `;
      })
      .join("");

    fitCalendarEventChips();
    buildUpcomingList(visible);
  }

  function fitCalendarEventChips() {
    if (!window.matchMedia("(min-width: 1100px)").matches) return;
    calendarDays.querySelectorAll(".cal-day-full").forEach((cell) => {
      const list = cell.querySelector(".calendar-day-event-list");
      if (!list) return;

      const chips = [...list.querySelectorAll(".calendar-day-event")];
      const more = list.querySelector(".calendar-day-more");
      if (!chips.length || !more) return;
      chips.forEach((chip) => {
        chip.hidden = false;
      });
      more.hidden = true;
      const chipHeight = chips[0].getBoundingClientRect().height;
      if (!chipHeight) return;

      const gap = Number.parseFloat(getComputedStyle(list).rowGap) || 2;
      const moreHeight = Number.parseFloat(getComputedStyle(more).lineHeight) || 13;
      const availableHeight = list.clientHeight;
      const maxVisible = Math.floor(
        (availableHeight + gap) / (chipHeight + gap),
      );
      const visibleCount =
        chips.length > maxVisible
          ? Math.max(
              0,
              Math.floor(
                (availableHeight - moreHeight + gap) / (chipHeight + gap),
              ),
            )
          : chips.length;

      chips.forEach((chip, index) => {
        chip.hidden = index >= visibleCount;
      });
      const hiddenCount = chips.length - visibleCount;
      more.hidden = hiddenCount === 0;
      more.textContent = `+${hiddenCount} more`;
      more.setAttribute("aria-label", `Show ${hiddenCount} more events`);
    });
  }

  function openEventModal(eventId) {
    const event = events.find(
      (item) => String(item.id || item.eventId) === String(eventId),
    );
    if (!event || isHolidayEvent(event)) return;
    window.RecovibeStudentEventDetails?.open(event);
  }

  function closeModal() {
    if (modal) modal.classList.remove("is-open");
  }

  function openDay(iso, forceList = false) {
    const dayEvents = visibleEvents().filter((event) => eventOccursOn(event, iso));
    if (!dayEvents.length) return;

    const regularEvents = dayEvents.filter((event) => !isHolidayEvent(event));
    if (regularEvents.length === 1 && dayEvents.length === 1 && !forceList) {
      openEventModal(regularEvents[0].id || regularEvents[0].eventId);
      return;
    }
    if (!regularEvents.length && dayEvents.length === 1) return;

    const date = dateFromISO(iso);
    const title = date
      ? date.toLocaleDateString("en-US", {
          month: "long",
          day: "numeric",
          year: "numeric",
        })
      : iso;
    openEventList(title, dayEvents, iso);
  }

  function renderYearOptions() {
    const currentYear = state.date.getFullYear();
    const years = Array.from(
      { length: 21 },
      (_, index) => currentYear - 10 + index,
    );
    yearSelect.innerHTML = years
      .map((year) => `<option value="${year}">${year}</option>`)
      .join("");
  }

  function setCalendarMonth(year, month) {
    const day = Math.min(
      state.date.getDate(),
      new Date(year, month + 1, 0).getDate(),
    );
    state.date = new Date(year, month, day);
    renderCalendar();
    refreshCalendarData();
  }

  function replaceEventsAndRender() {
    events = [...firestoreEvents, ...holidayEvents];
    updateDataStatus();
    renderCalendar();
  }

  function normalizeStudentProfile(profile) {
    const organization =
      profile.organization ||
      profile.courseOrganization ||
      profile.courseOrg ||
      profile.organizationCode ||
      profile.organizationName ||
      "";
    const department =
      profile.department || profile.departmentCode || profile.course || "";
    let derivedOrganization = organization;
    if (!derivedOrganization && department) {
      const normalizedDepartment = String(department).toUpperCase();
      if (normalizedDepartment.includes("IT") || normalizedDepartment.includes("INFORMATION")) {
        derivedOrganization = "IBITS";
      } else if (normalizedDepartment.includes("CPE") || normalizedDepartment.includes("COMPUTER")) {
        derivedOrganization = "ACES";
      } else if (normalizedDepartment.includes("IE") || normalizedDepartment.includes("INDUSTRIAL")) {
        derivedOrganization = "PIIE";
      } else if (normalizedDepartment.includes("HRM") || normalizedDepartment.includes("HRSS")) {
        derivedOrganization = "HRSS";
      }
    }
    return {
      ...profile,
      organization: derivedOrganization,
      courseOrganization: profile.courseOrganization || profile.courseOrg || derivedOrganization,
      courseOrg: profile.courseOrg || derivedOrganization,
      department,
      departmentCode: profile.departmentCode || department,
      StudentOrgs: profile.StudentOrgs || profile.studentOrgs ||
        (derivedOrganization ? [derivedOrganization] : []),
    };
  }

  function listenForCalendarEvents() {
    if (!db) {
      eventsLoading = false;
      eventLoadError = "Calendar events are unavailable because Firebase is not configured.";
      replaceEventsAndRender();
      return;
    }

    eventsLoading = true;
    eventLoadError = "";
    updateDataStatus();
    try {
      const eventsQuery = query(
        collection(db, "events"),
        where("status", "in", STUDENT_EVENT_STATUSES),
      );
      eventsUnsubscribe = onSnapshot(
        eventsQuery,
        (snapshot) => {
          firestoreEvents = snapshot.docs.map((eventDocument) =>
            normalizeCalendarEvent(eventDocument.id, eventDocument.data()),
          );
          eventsLoading = false;
          eventLoadError = "";
          replaceEventsAndRender();
        },
        (error) => {
          console.error("Unable to listen for student calendar events:", error);
          eventsLoading = false;
          eventLoadError = error?.code === "permission-denied"
            ? "Your account cannot read calendar events. Check your sign-in and Firestore access."
            : "Calendar events could not be loaded. Check your connection and try again.";
          replaceEventsAndRender();
        },
      );
    } catch (error) {
      console.error("Unable to attach the student calendar event listener:", error);
      eventsLoading = false;
      eventLoadError = error?.code === "permission-denied"
        ? "Your account cannot read calendar events. Check your sign-in and Firestore access."
        : "Calendar events could not be loaded. Check your connection and try again.";
      replaceEventsAndRender();
    }
  }

  async function loadStudentProfileAndListen(user) {
    const request = ++authRequestSequence;
    const nextUid = user?.uid || "";
    if (currentStudentUid && currentStudentUid !== nextUid) {
      renderStudentSidebar({});
    }
    currentStudentUid = nextUid;
    eventsUnsubscribe?.();
    eventsUnsubscribe = null;
    eventsLoading = true;
    studentProfile = {};
    profileLoadError = "";
    if (!user) {
      clearCachedStudentProfile();
      renderStudentSidebar({});
    }
    updateDataStatus();
    if (user && db) {
      try {
        const profile = await loadStudentProfile(user);
        if (disposed || request !== authRequestSequence) return;
        studentProfile = normalizeStudentProfile(profile);
        studentProfile.uid = user.uid;
        renderStudentSidebar(profile);
      } catch (error) {
        console.error("Unable to load student profile for calendar audience filtering:", error);
        if (disposed || request !== authRequestSequence) return;
        profileLoadError =
          "Your student profile could not be loaded; audience-specific event visibility may be incomplete.";
      }
    }
    if (disposed || request !== authRequestSequence) return;
    listenForCalendarEvents();
  }

  async function refreshCalendarData() {
    const sequence = ++holidayRequestSequence;
    const currentMonthIndex =
      Number(todayISO().slice(0, 4)) * 12 + Number(todayISO().slice(5, 7)) - 1;
    const displayedMonthIndex = state.date.getFullYear() * 12 + state.date.getMonth();
    const monthIndexes = new Set([displayedMonthIndex]);
    for (let offset = 0; offset < 12; offset += 1) {
      monthIndexes.add(currentMonthIndex + offset);
    }

    let holidayRequestHadError = false;
    const holidayResults = await Promise.all(
      [...monthIndexes].map(async (monthIndex) => {
        const year = Math.floor(monthIndex / 12);
        const month = monthIndex % 12;
        try {
          return await fetchMonthHolidays(year, month);
        } catch (error) {
          console.error(`Unable to load holidays for ${year}-${month + 1}:`, error);
          holidayRequestHadError = true;
          return [];
        }
      }),
    );
    if (disposed || sequence !== holidayRequestSequence) return;

    const uniqueHolidays = new Map();
    holidayResults.flat().forEach((holiday) => {
      uniqueHolidays.set(`${holiday.date}:${holiday.title}`, holiday);
    });
    const holidays = [...uniqueHolidays.values()];
    holidayLoadError = holidayRequestHadError
      ? "Some holiday data could not be loaded."
      : "";
    holidayEvents = holidays.map((holiday) =>
      normalizeCalendarEvent(
        `holiday:${holiday.date}:${holiday.title}`,
        {
          title: holiday.title,
          dateISO: holiday.date,
          source: "Holiday",
          status: "published",
          time: "All day",
          isHoliday: true,
        },
      ),
    );
    window.RecoVibeCalendarShell?.setHolidays(holidays);
    replaceEventsAndRender();
  }

  function bindCalendarInteractions() {
    calendarDays.addEventListener("click", (event) => {
      const cell = event.target.closest("[data-iso]");
      if (!cell) return;
      openDay(
        cell.dataset.iso,
        Boolean(event.target.closest(".calendar-day-more")),
      );
    });

    calendarDays.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        const cell = event.target.closest("[data-iso]");
        if (cell) {
          event.preventDefault();
          openDay(cell.dataset.iso);
        }
      }
    });

    upcomingPanel.addEventListener("click", (event) => {
      if (event.target.closest("[data-upcoming-more]")) {
        openRemainingUpcoming();
        return;
      }
      const item = event.target.closest("[data-event-id]");
      if (!item) return;
      openEventModal(item.dataset.eventId);
    });

    upcomingPanel.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        if (event.target.closest("[data-upcoming-more]")) {
          event.preventDefault();
          openRemainingUpcoming();
          return;
        }
        const item = event.target.closest("[data-event-id]");
        if (item) {
          event.preventDefault();
          openEventModal(item.dataset.eventId);
        }
      }
    });

    document
      .getElementById("organizerDayList")
      .addEventListener("click", (event) => {
        const button = event.target.closest("[data-event-id]");
        if (!button) return;
        openEventModal(button.dataset.eventId);
        if (dayModal) dayModal.classList.remove("is-open");
      });

    document
      .getElementById("organizerModalClose")
      .addEventListener("click", closeModal);
    document
      .getElementById("organizerDayClose")
      .addEventListener("click", () => {
        if (dayModal) dayModal.classList.remove("is-open");
      });

    if (modal) {
      modal.addEventListener("click", (event) => {
        if (event.target === modal) closeModal();
      });
    }

    if (dayModal) {
      dayModal.addEventListener("click", (event) => {
        if (event.target === dayModal) dayModal.classList.remove("is-open");
      });
    }

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        closeModal();
        if (dayModal) dayModal.classList.remove("is-open");
      }
    });

    document
      .getElementById("organizerModalEdit")
      .addEventListener("click", (event) => {
        event.preventDefault();
        const eventId = document
          .getElementById("organizerModalEdit")
          .getAttribute("data-event-id");
        if (!eventId) return;
        const selectedEvent = events.find(
          (item) => String(item.id || item.eventId) === String(eventId),
        );
        if (selectedEvent) window.RecovibeEventDetails?.open(selectedEvent);
      });
  }

  monthSelect.innerHTML = monthNames
    .map((month, index) => `<option value="${index}">${month}</option>`)
    .join("");
  renderYearOptions();

  monthSelect.addEventListener("change", () => {
    setCalendarMonth(state.date.getFullYear(), Number(monthSelect.value));
  });

  yearSelect.addEventListener("change", () => {
    setCalendarMonth(Number(yearSelect.value), state.date.getMonth());
  });

  document.getElementById("calFullPrev").addEventListener("click", () => {
    setCalendarMonth(state.date.getFullYear(), state.date.getMonth() - 1);
  });

  document.getElementById("calFullNext").addEventListener("click", () => {
    setCalendarMonth(state.date.getFullYear(), state.date.getMonth() + 1);
  });

  todayButton.addEventListener("click", () => {
    state.date = new Date();
    renderCalendar();
    refreshCalendarData();
  });

  resetButton.addEventListener("click", () => {
    const filterPanel = document.querySelector(".filter-panel");
    if (filterPanel) {
      filterPanel.querySelectorAll(".filter-option input").forEach((input) => {
        input.checked = true;
      });
    }
    renderCalendar();
  });

  bindCalendarInteractions();
  document.addEventListener("recovibeParticipationChanged", (event) => {
    const changed = events.find(
      (item) =>
        String(item.id || item.eventId) === String(event.detail.eventId),
    );
    if (changed) changed.slotsOpen = event.detail.slotsOpen;
    renderCalendar();
  });
  window.addEventListener("storage", (event) => {
    if (
      event.key === "recovibePreferences" ||
      (event.key && event.key.startsWith("recovibePreferences:")) ||
      event.key === "recovibeCurrentUser"
    ) {
      renderFilterAndLegend();
      renderCalendar();
      return;
    }
    if (
      event.key !== "recovibeParticipations" &&
      event.key !== "recovibeEventSlots"
    )
      return;
    const savedSlots = (() => {
      try {
        return JSON.parse(localStorage.getItem("recovibeEventSlots") || "{}");
      } catch (error) {
        return {};
      }
    })();
    events.forEach((item) => {
      const id = String(item.id || item.eventId);
      if (savedSlots[id] !== undefined) item.slotsOpen = savedSlots[id];
    });
    renderCalendar();
  });
  window.addEventListener("online", refreshCalendarData);
  let resizeFrame = 0;
  window.addEventListener("resize", () => {
    window.cancelAnimationFrame(resizeFrame);
    resizeFrame = window.requestAnimationFrame(renderCalendar);
  });
  if (window.ResizeObserver) {
    new ResizeObserver(fitCalendarEventChips).observe(calendarDays);
  }

  function startCalendarListeners() {
    disposed = false;
    if (auth) {
      authUnsubscribe = onAuthStateChanged(
        auth,
        (user) => {
          console.info("[Student Calendar] auth-wait-success", {
            authenticated: Boolean(user),
            uid: user?.uid || "",
            appName: auth.app.name,
            projectId: auth.app.options.projectId,
          });
          loadStudentProfileAndListen(user);
        },
        (error) => {
          console.error("Unable to observe student authentication state:", error);
          eventsLoading = false;
          eventLoadError = "Calendar events could not be loaded for this account.";
          updateDataStatus();
        },
      );
    } else {
      loadStudentProfileAndListen(null);
    }
    refreshCalendarData();
  }

  function stopCalendarListeners() {
    disposed = true;
    authRequestSequence += 1;
    holidayRequestSequence += 1;
    authUnsubscribe?.();
    authUnsubscribe = null;
    eventsUnsubscribe?.();
    eventsUnsubscribe = null;
  }

  window.addEventListener("pagehide", stopCalendarListeners);
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) startCalendarListeners();
  });

  renderFilterAndLegend();
  renderCalendar();
  startCalendarListeners();
})();