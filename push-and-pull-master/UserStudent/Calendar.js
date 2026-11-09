import { loadCalendarData } from "../calendarDataService.js";
import { isEventVisibleToStudent } from "./eventAudience.js";

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
  const rawEvents = (
    Array.isArray(window.RECOVIBE_EVENTS) ? [...window.RECOVIBE_EVENTS] : []
  ).filter((event) => {
    const s = String(event.status || "")
      .trim()
      .toLowerCase()
      .replace(/[ _-]+/g, " ");
    return (
      ["approved", "published", "rescheduled"].includes(s) ||
      event.published === true
    );
  });
  const baseEvents = rawEvents.reduce((list, event) => {
    const uniqueKey = event.id || event.eventId;
    if (
      !uniqueKey ||
      list.some((item) => String(item.id || item.eventId) === String(uniqueKey))
    )
      return list;
    list.push(event);
    return list;
  }, []);
  let events = baseEvents;

  let activeSources = [];
  let activeSourceKeys = new Set();
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

  const toDate = (value) => {
    if (!value) return null;
    if (typeof value === "object" && typeof value.toDate === "function") {
      return toDate(value.toDate());
    }
    if (typeof value === "object" && Number.isFinite(value.seconds)) {
      return new Date(value.seconds * 1000);
    }
    if (value instanceof Date) {
      return Number.isNaN(value.getTime()) ? null : value;
    }
    if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
      const [year, month, day] = value.split("-").map(Number);
      const date = new Date(year, month - 1, day);
      return date.getFullYear() === year &&
        date.getMonth() === month - 1 &&
        date.getDate() === day
        ? date
        : null;
    }
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  };

  const toISODate = (value) => {
    const date = toDate(value);
    if (!date) return "";
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  };

  function eventDateRange(event) {
    const start =
      [
        event.dateISO,
        event.eventDate,
        event.date,
        event.startDate,
      ].map(toISODate).find(Boolean) || "";
    const end =
      [
        event.endDateISO,
        event.eventEndDate,
        event.endDate,
        event.dateEnd,
        event.end,
        start,
      ].map(toISODate).find(Boolean) || start;
    return start ? { start, end: end && end >= start ? end : start } : null;
  }

  function eventOccursOn(event, iso) {
    const range = eventDateRange(event);
    return Boolean(range && range.start <= iso && iso <= range.end);
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
    if (norm === "pup cite" || norm === "cite" || norm.includes("cite")) {
      return {
        key: "PUP CITE",
        label: "PUP CITE",
        dotClass: "cite",
        accent: "var(--cat-cite, #c79a2b)",
      };
    }
    if (norm.includes("pup official") || norm === "official") {
      return {
        key: "PUP Official",
        label: "PUP Official",
        dotClass: "official",
        accent: "var(--cat-official, #8f2536)",
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
    if (norm.includes("teacher") || norm.includes("faculty")) {
      return {
        key: "Teachers/Faculty",
        label: "Teachers/Faculty",
        dotClass: "faculty",
        accent: "var(--cat-faculty, #1e9a73)",
      };
    }
    if (norm === "ibits") {
      return {
        key: "IBITS",
        label: "IBITS",
        dotClass: "ibits",
        accent: "var(--cat-ibits, #7c5cc4)",
      };
    }
    if (
      norm.includes("organizer") ||
      norm.includes("organization") ||
      norm.includes("organizational")
    ) {
      return {
        key: "Organizational",
        label: "Organizational",
        dotClass: "organizational",
        accent: "var(--cat-ibits, #7c5cc4)",
      };
    }
    if (norm.includes("external") || norm.includes("other")) {
      return {
        key: "Others/External",
        label: "Others/External",
        dotClass: "external",
        accent: "var(--cat-external, #64748b)",
      };
    }
    return {
      key: sourceStr,
      label: sourceStr,
      dotClass: "external",
      accent: "var(--cat-external, #64748b)",
    };
  }

  function getStudentActiveSources() {
    let rawList = null;
    try {
      const user =
        JSON.parse(localStorage.getItem("recovibeCurrentUser") || sessionStorage.getItem("recovibeCurrentUser") || "null") || {};
      const preferenceKey = "recovibePreferences";
      const accountPreferenceKey = `recovibePreferences:${user.uid || user.email || "student"}`;

      if (
        user.preferences &&
        Array.isArray(user.preferences.sources) &&
        user.preferences.sources.length
      ) {
        rawList = user.preferences.sources;
      } else {
        const accPref = JSON.parse(
          localStorage.getItem(accountPreferenceKey) || "null",
        );
        if (
          accPref &&
          Array.isArray(accPref.sources) &&
          accPref.sources.length
        ) {
          rawList = accPref.sources;
        } else {
          const genPref = JSON.parse(
            localStorage.getItem(preferenceKey) || "null",
          );
          if (
            genPref &&
            Array.isArray(genPref.sources) &&
            genPref.sources.length
          ) {
            rawList = genPref.sources;
          }
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
    for (const item of rawList) {
      const meta = resolveSourceMeta(item);
      if (meta.key === "Teachers/Faculty") continue;
      if (!seen.has(meta.key)) {
        seen.add(meta.key);
        metas.push(meta);
      }
    }

    // Always ensure Holiday is present for all students
    if (!seen.has("Holiday")) {
      metas.push(resolveSourceMeta("Holiday"));
      seen.add("Holiday");
    }

    return metas;
  }

  function renderFilterAndLegend() {
    activeSources = getStudentActiveSources();
    activeSourceKeys = new Set(activeSources.map((s) => s.key));

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
      event.eventSource,
      event.source,
      event.organization,
      event.organizer,
      event.organizerName,
      event.tag,
    ];

    for (const s of rawSources) {
      const norm = String(s || "").trim().toLowerCase();
      if (norm.includes("holiday")) return "Holiday";
    }

    for (const s of rawSources) {
      const norm = String(s || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "");
      if (
        norm === "csc" ||
        norm.includes("centralstudentcouncil") ||
        norm === "centralstudentcouncilcsc"
      ) {
        return "CSC";
      }
    }

    for (const s of rawSources) {
      const norm = String(s || "").trim().toLowerCase();
      if (norm.includes("pup official") || norm === "official") return "PUP Official";
      if (norm.includes("biñan") || norm.includes("binan")) return "PUP Biñan Campus";
      if (norm.includes("cite")) return activeSourceKeys.has("PUP CITE") ? "PUP CITE" : "PUP Official";
      if (norm.includes("teacher") || norm.includes("faculty")) return "Teachers/Faculty";
    }

    for (const s of rawSources) {
      const norm = String(s || "").trim().toLowerCase();
      if (norm === "ibits" && activeSourceKeys.has("IBITS")) return "IBITS";
      if (
        norm === "organizational" ||
        norm === "ibits" ||
        norm === "aces" ||
        norm === "jpcs" ||
        norm === "org" ||
        norm.includes("organization") ||
        /^(ibits|aces|jpcs|pice|iie|jma|jphia|pasoa|chrms|cites)\b/i.test(norm)
      ) {
        return "Organizational";
      }
    }

    if (
      event.organizerId ||
      event.organization ||
      event.source === "Event Organizer"
    ) {
      return "Organizational";
    }

    for (const s of rawSources) {
      const str = String(s || "").trim();
      if (str && activeSourceKeys.has(str)) return str;
    }

    for (const s of rawSources) {
      const norm = String(s || "").trim().toLowerCase();
      if (norm.includes("external") || norm.includes("other")) return "Others/External";
    }

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
      eventSource(event) === "Philippine Holiday" ||
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
        "PUP Biñan": "binan",
        CSC: "csc",
        "PUP CITE": "cite",
        IBITS: "ibits",
        Organizational: "organizational",
        "Teachers/Faculty": "faculty",
        "Teacher / Faculty": "faculty",
        "Others/External": "external",
        "Others / External": "external",
        "Philippine Holiday": "holiday",
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
    let studentProfile = {};
    try {
      studentProfile = JSON.parse(
        localStorage.getItem("recovibeCurrentUser") || sessionStorage.getItem("recovibeCurrentUser") || "null",
      ) || {};
    } catch (error) {
      console.warn("Could not read student audience profile:", error);
    }
    return events.filter((event) =>
      (isHolidayEvent(event) || isEventVisibleToStudent(event, studentProfile)) &&
      checked.includes(eventSource(event)),
    );
  }

  function buildUpcomingList() {
    if (!upcomingPanel) return;

    const now = new Date();
    const upcoming = visibleEvents()
      .filter((event) => {
        const range = eventDateRange(event);
        return (
          range &&
          range.end >=
            `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`
        );
      })
      .sort((a, b) =>
        eventDateRange(a).start.localeCompare(eventDateRange(b).start),
      );

    if (!upcoming.length) {
      upcomingPanel.innerHTML =
        '<h3>Upcoming</h3><div class="upcoming-empty">No upcoming events.</div>';
      return;
    }

    const shownUpcoming = upcoming.slice(0, 5);
    const moreCount = upcoming.length - shownUpcoming.length;
    upcomingPanel.innerHTML = [
      "<h3>Upcoming</h3>",
      `<div class="upcoming-list">${shownUpcoming.map((event) => {
        const date = toDate(eventDateRange(event)?.start);
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
                <strong>${escape(event.title || "Holiday")}</strong>
                <span>Holiday</span>
              </div>
            </div>
          `;
        }
        return `
          <div class="upcoming-item" data-event-id="${escape(event.id || event.eventId || "")}" tabindex="0" role="button">
            <div class="upcoming-date ${categoryClass}"><span>${day}</span><small>${month}</small></div>
            <div class="upcoming-copy">
              <strong>${escape(event.title || "Untitled event")}</strong>
              <span>${escape(sourceLabel)}</span>
            </div>
          </div>
        `;
      }).join("")}</div>`,
      moreCount
        ? `<button class="upcoming-more" type="button" data-upcoming-more>+${moreCount} more</button>`
        : "",
    ].join("");
  }

  function openRemainingUpcoming() {
    const now = new Date();
    const today =
      `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const remaining = visibleEvents()
      .filter((item) => {
        const range = eventDateRange(item);
        return range && range.end >= today;
      })
      .sort((a, b) =>
        eventDateRange(a).start.localeCompare(eventDateRange(b).start),
      )
      .slice(5);
    openEventList("More upcoming events", remaining);
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

    renderYearOptions();
    monthSelect.value = String(month);
    yearSelect.value = String(year);

    const visible = visibleEvents();
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
        events: visible.filter((event) => eventOccursOn(event, iso)),
      });
    }

    while (cells.length % 7 !== 0) {
      cells.push({ day: "", iso: "", muted: true, events: [] });
    }

    calendarDays.innerHTML = cells
      .map((cell) => {
        const currentDate = new Date();
        const todayIso = `${currentDate.getFullYear()}-${String(currentDate.getMonth() + 1).padStart(2, "0")}-${String(currentDate.getDate()).padStart(2, "0")}`;
        const today = cell.iso && cell.iso === todayIso;
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
    buildUpcomingList();
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
    if (!regularEvents.length) {
      // Day only has holidays: holiday is shown on calendar cell, not clickable
      return;
    }

    if (regularEvents.length === 1 && dayEvents.length === 1 && !forceList) {
      openEventModal(regularEvents[0].id || regularEvents[0].eventId);
      return;
    }

    const date = toDate(iso);
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

  let dataRequestSequence = 0;
  async function refreshCalendarData() {
    const sequence = ++dataRequestSequence;
    const year = state.date.getFullYear();
    const month = state.date.getMonth();
    try {
      const { events: loadedEvents, holidays } = await loadCalendarData(
        baseEvents,
        year,
        month,
      );
      if (sequence !== dataRequestSequence) return;
      const holidayEvents = holidays.map((holiday) => ({
        id: `holiday:${holiday.date}:${holiday.title}`,
        eventId: `holiday:${holiday.date}:${holiday.title}`,
        title: holiday.title,
        dateISO: holiday.date,
        source: "Holiday",
        status: "published",
        time: "All day",
        isHoliday: true,
      }));
      events = [...loadedEvents, ...holidayEvents];
      window.RecoVibeCalendarShell?.setHolidays(holidays);
      renderCalendar();
    } catch (error) {
      console.error("Unable to refresh student calendar data:", error);
    }
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
  renderFilterAndLegend();
  renderCalendar();
  refreshCalendarData();
})();
