import { loadCalendarData } from "../calendarDataService.js";

(() => {
  "use strict";
  const profile = read("recovibeAdminProfile", null),
    identity = localStorage.getItem("recovibeAdminId");
  if (
    !profile ||
    String(profile.role || "").toLowerCase() !== "admin" ||
    !identity
  ) {
    location.replace("AdminLogin.html");
    return;
  }
  const root = document.getElementById("calendarRoot"),
    host = document.getElementById("calendarModalHost"),
    monthSelect = document.getElementById("adminMonthSelect"),
    yearSelect = document.getElementById("adminYearSelect"),
    calendarGrid = document.getElementById("adminMonthGrid"),
    upcomingItems = document.getElementById("adminUpcomingItems"),
    categoryFilters = [
      ...document.querySelectorAll("[data-calendar-category]"),
    ],
    today = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Manila",
    }).format(new Date());
  let viewed = new Date(),
    activePopup = null,
    firestoreEvents = [],
    holidays = [],
    monthDataSequence = 0,
    loadedMonthDataKey = "";
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
  const selectedCategories = new Set(
    categoryFilters.map((filter) => filter.dataset.calendarCategory),
  );
  monthSelect.innerHTML = monthNames
    .map((month, index) => `<option value="${index}">${month}</option>`)
    .join("");
  document.querySelector("[data-name]").textContent = (
    profile.name || identity
  ).toUpperCase();
  document.querySelector("[data-avatar]").textContent = (profile.name || "HA")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0])
    .join("")
    .toUpperCase();
  document.querySelector("[data-role]").textContent =
    "Head of Academic Programs";
  document.querySelector("[data-today]").textContent =
    new Date().toLocaleDateString("en-US", {
      timeZone: "Asia/Manila",
      month: "long",
      day: "numeric",
      year: "numeric",
    });
  document.querySelector(".admin-logout").onclick = () =>
    localStorage.removeItem("recovibeAdminId");
  function read(key, fallback) {
    try {
      return JSON.parse(localStorage.getItem(key) || "null") ?? fallback;
    } catch {
      return fallback;
    }
  }
  function esc(value) {
    return String(value ?? "").replace(
      /[&<>"']/g,
      (ch) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[ch],
    );
  }
  function stageVisible(event) {
    const status = String(event.status || "")
      .toLowerCase()
      .replace(/[ _-]+/g, " ");
    return (
      [
        "awaiting final documents",
        "final documents submitted",
        "ready to publish",
        "approved",
        "published",
        "cancelled",
        "canceled",
        "completed",
      ].includes(status) || event.published === true
    );
  }
  function allEvents() {
    const saved = ["recovibeTeacherEvents", "recovibeOrganizerEvents"].flatMap(
      (key) => {
        const list = read(key, []);
        return Array.isArray(list) ? list : [];
      },
    );
    const source = Array.isArray(window.RECOVIBE_EVENTS)
      ? window.RECOVIBE_EVENTS
      : [];
    const seen = new Set();
    return [...saved, ...source, ...firestoreEvents].filter((event) => {
      const id = String(event.eventId || event.id || "");
      if (
        !id ||
        seen.has(id) ||
        !stageVisible(event) ||
        ["cancelled", "canceled"].includes(
          String(event.status || "").toLowerCase(),
        )
      )
        return false;
      seen.add(id);
      return true;
    });
  }
  function sourceName(event) {
    const value = String(
      event.source || event.organizerName || "Others / External",
    );
    if (value === "PUP Biñan Campus") return "PUP Biñan";
    if (value === "Teacher / Faculty" || value === "Teachers/Faculty")
      return "Teachers / Faculty";
    if (value === "Event Organizer" || value === "Organizational")
      return "Organizational";
    return value;
  }
  function eventCategory(event) {
    const value = [
      event.category,
      event.eventCategory,
      event.eventType,
      event.source,
      event.organization,
      event.organizerName,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    if (/academic|cite|teacher|faculty/.test(value)) return "Academic";
    if (/organization|organizer|\bcsc\b/.test(value)) return "Organization";
    return "Institutional";
  }
  function visibleEvents() {
    return allEvents().filter((event) =>
      selectedCategories.has(eventCategory(event)),
    );
  }
  function dateOf(event) {
    return String(event.dateISO || event.date || "").slice(0, 10);
  }
  function render() {
    try {
      const year = viewed.getFullYear(),
        month = viewed.getMonth(),
        first = new Date(year, month, 1),
        offset = first.getDay(),
        days = new Date(year, month + 1, 0).getDate(),
        events = visibleEvents();
      renderYearOptions();
      monthSelect.value = String(month);
      yearSelect.value = String(year);
      const cells = [];
      for (let index = 0; index < offset; index++) cells.push(cell("", "muted", ""));
      for (let day = 1; day <= days; day++) {
        const iso = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
          dayEvents = events.filter((event) => dateOf(event) === iso);
        cells.push(cell(day, iso === today ? "today" : "", iso, dayEvents));
      }
      while (cells.length % 7 !== 0) cells.push(cell("", "muted", ""));
      calendarGrid.innerHTML = cells.join("");
      renderUpcoming(events);
      renderHolidayBadges();
      loadMonthData(year, month);
    } catch (error) {
      console.error("Unable to render admin calendar:", error);
      calendarGrid.innerHTML =
        '<div class="admin-error">Could not load calendar.</div>';
    }
  }
  function isHolidayEvent(event) {
    if (!event) return false;
    const id = String(event.id || event.eventId || "");
    const src = String(event.source || event.organizerName || "").toLowerCase();
    const cat = String(event.category || "").toLowerCase();
    const title = String(event.title || "").toLowerCase();
    return (
      event.isHoliday === true ||
      id.startsWith("holiday:") ||
      src.includes("holiday") ||
      cat.includes("holiday") ||
      title.includes("holiday") ||
      sourceName(event) === "Philippine Holiday" ||
      sourceName(event) === "Holiday"
    );
  }
  function cell(day, klass, iso, dayEvents = []) {
    const regularEvents = dayEvents.filter((event) => !isHolidayEvent(event));
    const isOnlyHoliday = dayEvents.length > 0 && regularEvents.length === 0;
    const dots = regularEvents
      .slice(0, 4)
      .map(
        (event) =>
          `<span class="admin-dot" style="background:${color(event)}" title="${esc(event.title || "Untitled event")}"></span>`,
      )
      .join("");
    const cellClass = ["admin-day", klass, isOnlyHoliday ? "only-holiday" : ""].filter(Boolean).join(" ");
    return `<div class="${cellClass}" ${iso ? `data-date="${iso}" data-iso="${iso}"` : ""}><button type="button" ${iso ? `aria-label="${iso}, ${regularEvents.length ? `${regularEvents.length} events` : "no events"}"` : "disabled"}>${day}</button>${regularEvents.length ? `<div class="admin-day-dots" aria-hidden="true">${dots}</div>` : iso ? '<small class="admin-day-empty">No events</small>' : ""}</div>`;
  }
  function renderUpcoming(events) {
    const upcoming = events
      .filter((event) => dateOf(event) >= today)
      .sort((first, second) => dateOf(first).localeCompare(dateOf(second)))
      .slice(0, 5);
    upcomingItems.innerHTML = upcoming.length
      ? upcoming
          .map((event) => {
            const date = new Date(`${dateOf(event)}T00:00:00`);
            const isHol = isHolidayEvent(event);
            const source = isHol ? "Holiday" : sourceName(event);
            const id = esc(event.eventId || event.id);
            if (isHol) {
              return `<div class="admin-upcoming-item admin-upcoming-item--holiday" style="cursor: default; pointer-events: none;" aria-label="${esc(event.title || "Holiday")} (Holiday)"><span class="admin-upcoming-date"><strong>${date.getDate()}</strong><small>${date.toLocaleDateString("en-US", { month: "short" }).toUpperCase()}</small></span><span class="admin-upcoming-copy"><strong>${esc(event.title || "Holiday")}</strong><small>Holiday</small></span></div>`;
            }
            return `<div class="admin-upcoming-item" data-iso="${dateOf(event)}" data-event-id="${id}" role="button" tabindex="0"><span class="admin-upcoming-date"><strong>${date.getDate()}</strong><small>${date.toLocaleDateString("en-US", { month: "short" }).toUpperCase()}</small></span><span class="admin-upcoming-copy"><strong>${esc(event.title || "Untitled event")}</strong><small>${esc(source)}</small></span></div>`;
          })
          .join("")
      : '<p class="admin-upcoming-empty">No upcoming events.</p>';
  }
  function renderYearOptions() {
    const selectedYear = viewed.getFullYear();
    const years = Array.from(
      { length: 21 },
      (_, index) => selectedYear - 10 + index,
    );
    yearSelect.innerHTML = years
      .map((year) => `<option value="${year}">${year}</option>`)
      .join("");
  }
  async function loadMonthData(year, month) {
    const monthKey = `${year}-${month}`;
    if (loadedMonthDataKey === monthKey) return;
    const sequence = ++monthDataSequence;
    try {
      const { events, holidays: monthHolidays } = await loadCalendarData(
        allEvents(),
        year,
        month,
      );
      if (sequence !== monthDataSequence) return;
      firestoreEvents = events;
      holidays = monthHolidays;
      loadedMonthDataKey = monthKey;
      render();
      renderHolidayBadges();
    } catch (error) {
      console.error("Unable to load admin calendar data:", error);
    }
  }
  function renderHolidayBadges() {
    const holidaysByDate = new Map();
    holidays.forEach((holiday) => {
      const names = holidaysByDate.get(holiday.date) || [];
      names.push(holiday.title || holiday.name);
      holidaysByDate.set(holiday.date, names);
    });
    const cellsByDate = new Map();
    root.querySelectorAll(".admin-day[data-date]").forEach((day) => {
      cellsByDate.set(day.dataset.date, day);
      const names = selectedCategories.has("Holiday")
        ? holidaysByDate.get(day.dataset.date) || []
        : [];
      day.classList.toggle("is-holiday", names.length > 0);
      day.querySelectorAll(".calendar-badge.badge-holiday").forEach((badge) =>
        badge.remove(),
      );
      names.forEach((name) => {
        const badge = document.createElement("span");
        badge.className = "calendar-badge badge-holiday";
        badge.style.pointerEvents = "none";
        badge.style.cursor = "default";
        badge.textContent = name;
        badge.title = name;
        day.appendChild(badge);
      });
    });

    try {
      if (
        new URLSearchParams(location.search).get("debugHolidays") === "1" ||
        localStorage.getItem("recovibeDebugHolidays") === "true"
      ) {
        holidays.forEach((holiday) => {
          if (!cellsByDate.has(holiday.date)) {
            console.log("[AdminCalendar] Holiday date has no matching cell", {
              holiday,
              renderedDates: [...cellsByDate.keys()],
            });
          }
        });
        console.log("[AdminCalendar] Holiday-to-cell mapping", {
          holidayCount: holidays.length,
          matchedCount: holidays.filter((holiday) =>
            cellsByDate.has(holiday.date),
          ).length,
          renderedCellCount: cellsByDate.size,
        });
      }
    } catch (error) {
      console.warn("Unable to read holiday diagnostic setting:", error);
    }
  }
  function move(amount) {
    viewed = new Date(viewed.getFullYear(), viewed.getMonth() + amount, 1);
    render();
  }
  function openDay(iso) {
    const allDayEvents = visibleEvents().filter((event) => dateOf(event) === iso);
    const events = allDayEvents.filter((event) => !isHolidayEvent(event));
    if (!events.length) {
      // Day only has holidays: holiday is shown on calendar cell, not clickable
      return;
    }
    const holidayName = selectedCategories.has("Holiday")
      ? holidays.find((holiday) => holiday.date === iso)?.title
      : "";
    const date = new Date(`${iso}T00:00:00`);
    const overlay = document.createElement("div");
    overlay.className = "admin-day-overlay";
    overlay.innerHTML = `<section class="admin-day-dialog" role="dialog" aria-modal="true" aria-labelledby="adminDayTitle" tabindex="-1"><button type="button" class="admin-close" aria-label="Close day details">×</button><h2 id="adminDayTitle">${date.toLocaleDateString("en-US", { timeZone: "Asia/Manila", month: "long", day: "numeric", year: "numeric" })}</h2>${holidayName ? `<p class="admin-holiday-note">${esc(holidayName)} · Holiday</p>` : ""}<div class="admin-day-list">${events
      .map((event) => {
        const source = sourceName(event),
          time =
            event.time || `${event.startTime || ""} - ${event.endTime || ""}`,
          id = event.eventId || event.id,
          count = participants(id);
        return `<article class="admin-day-card" style="--event-source:${color(source)}"><strong>${esc(event.title || "Untitled event")}</strong><small>${esc(source)} · ${esc(date.toLocaleDateString("en-US", { month: "short", day: "numeric" }))}</small><p>${esc(time)}</p><p>${esc(event.venueOther || event.location || event.venue || "Venue to be announced")}</p><span class="admin-chip">${esc(source)}</span><p class="day-desc">${esc(event.description || event.desc || "")}</p><hr><small>${count} Students Participating</small><button type="button" data-details="${esc(id)}">View Details</button></article>`;
      })
      .join("")}</div></section>`;
    host.append(overlay);
    activePopup = overlay;
    document.body.style.overflow = "hidden";
    overlay.querySelector(".admin-close").onclick = closePopup;
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) closePopup();
    });
    overlay.querySelectorAll("[data-details]").forEach(
      (button) =>
        (button.onclick = () => {
          const event = events.find(
            (item) =>
              String(item.eventId || item.id) === button.dataset.details,
          );
          closePopup();
          window.RecovibeEventDetails?.open(event);
        }),
    );
    overlay.querySelector(".admin-day-dialog").focus();
  }
  function color(event) {
    if (isHolidayEvent(event)) return "#d97706";
    return (
      {
        Academic: "#3a76a6",
        Organization: "#765092",
        Institutional: "#6b1220",
      }[eventCategory(event)] || "#6b1220"
    );
  }
  function participants(id) {
    const event = allEvents().find(
      (item) => String(item.eventId || item.id) === String(id),
    );
    if (!event || event.capacityMode === "N/A") return 0;
    const capacity = Number(
      event.maxCapacity ?? event.capacity ?? event.maxSlots,
    );
    const open = Number(
      event.openSlots ??
        event.slotsOpen ??
        event.availableSlots ??
        event.slots ??
        capacity,
    );
    return Number.isFinite(capacity) && Number.isFinite(open)
      ? Math.max(0, capacity - open)
      : 0;
  }
  function closePopup() {
    if (!activePopup) return;
    activePopup.remove();
    activePopup = null;
    document.body.style.overflow = "";
  }
  monthSelect.addEventListener("change", () => {
    viewed = new Date(viewed.getFullYear(), Number(monthSelect.value), 1);
    render();
  });
  yearSelect.addEventListener("change", () => {
    viewed = new Date(Number(yearSelect.value), viewed.getMonth(), 1);
    render();
  });
  document.getElementById("previousMonth").addEventListener("click", () => {
    move(-1);
  });
  document.getElementById("nextMonth").addEventListener("click", () => {
    move(1);
  });
  document.getElementById("goToday").addEventListener("click", () => {
    viewed = new Date();
    render();
  });
  document
    .getElementById("resetCalendarFilters")
    .addEventListener("click", () => {
      categoryFilters.forEach((filter) => {
        filter.checked = true;
        selectedCategories.add(filter.dataset.calendarCategory);
      });
      render();
    });
  categoryFilters.forEach((filter) => {
    filter.addEventListener("change", () => {
      if (filter.checked) {
        selectedCategories.add(filter.dataset.calendarCategory);
      } else {
        selectedCategories.delete(filter.dataset.calendarCategory);
      }
      render();
    });
  });
  calendarGrid.addEventListener("click", (event) => {
    const day = event.target.closest("[data-iso]");
    if (day) openDay(day.dataset.iso);
  });
  calendarGrid.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const day = event.target.closest("[data-iso]");
    if (!day) return;
    event.preventDefault();
    openDay(day.dataset.iso);
  });
  upcomingItems.addEventListener("click", (event) => {
    const item = event.target.closest("[data-iso]");
    if (item) openDay(item.dataset.iso);
  });
  upcomingItems.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const item = event.target.closest("[data-iso]");
    if (!item) return;
    event.preventDefault();
    openDay(item.dataset.iso);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && activePopup) closePopup();
  });
  window.addEventListener("storage", (event) => {
    if (!event.key || event.key.includes("Events")) render();
  });
  window.addEventListener("focus", render);
  window.addEventListener("online", () => {
    loadedMonthDataKey = "";
    render();
  });
  render();
})();
