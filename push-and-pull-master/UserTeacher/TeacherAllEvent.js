(() => {
  "use strict";

  let events = (
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
  try {
    const teacherEvents = JSON.parse(
      localStorage.getItem("recovibeTeacherEvents") || "[]",
    );
    if (Array.isArray(teacherEvents)) {
      teacherEvents
        .filter((event) => {
          const s = String(event.status || "")
            .trim()
            .toLowerCase()
            .replace(/[ _-]+/g, " ");
          return (
            ["approved", "published", "rescheduled"].includes(s) ||
            event.published === true
          );
        })
        .forEach((event) => {
          const id = event.eventId || event.id;
          if (!events.some((existing) => String(existing.id) === String(id))) {
            events.push({
              ...event,
              id,
              source: event.source || "PUP Biñan Campus",
              desc: event.description || "",
            });
          }
        });
    }
  } catch (error) {
    console.warn("Teacher event records could not be loaded.", error);
  }
  const state = {
    query: "",
    type: "all",
    source: "all",
    category: "all",
    date: "all",
    status: "all",
    availability: "all",
  };
  const currentEvents = document.getElementById("teacherCurrentEvents");
  const upcomingEvents = document.getElementById("teacherUpcomingEvents");
  const resultCount = document.getElementById("teacherResultCount");
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const dateRangeBounds = (value) => {
    const date = new Date(todayStart);
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
      return [
        new Date(todayStart.getFullYear(), todayStart.getMonth(), 1),
        new Date(todayStart.getFullYear(), todayStart.getMonth() + 1, 0),
      ];
    if (value === "next_month")
      return [
        new Date(todayStart.getFullYear(), todayStart.getMonth() + 1, 1),
        new Date(todayStart.getFullYear(), todayStart.getMonth() + 2, 0),
      ];
    return null;
  };

  const escapeHTML = (value) =>
    String(value ?? "").replace(
      /[&<>'"]/g,
      (char) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          "'": "&#39;",
          '"': "&quot;",
        })[char],
    );
  const dateFor = (event) => new Date(`${event.dateISO}T00:00:00`);
  const formatDate = (event) =>
    dateFor(event).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    });
  const today = new Date();
  const todayISO = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const isCurrent = (event) => event.dateISO === todayISO;
  const categoryMatches = {
    "Academic & Learning": ["academic", "learning"],
    "Tech & Innovation": ["tech", "innovation"],
    "Leadership & Career": ["leadership", "career", "student development"],
    "Sports & Fitness": ["sport", "fitness"],
    "Music & Entertainment": ["music", "entertainment"],
    "Orgs & Student Acts": ["org", "organization", "student act"],
    "Social Events": ["social"],
    "Community & Outreach": ["community", "outreach"],
    Competitions: ["competition", "hackathon"],
    "Seminars & Workshops": ["seminar", "workshop"],
    "Arts & Culture": ["art", "culture"],
    "University & Campuses": ["university", "campus"],
  };
  function normalizeSource(source) {
    const value = String(source || "").trim().toLowerCase();
    if (/\bcsc\b/.test(value)) return "CSC";
    if (/teacher|faculty/.test(value)) return "Teacher / Faculty";
    if (/organization|organizational|ibits|event organizer/.test(value))
      return "Organizational";
    if (/external|admin|other/.test(value)) return "Others / External";
    if (/pup|campus|cite/.test(value)) return "PUP Official";
    return "Others / External";
  }
  events.forEach((event) => {
    event.source = normalizeSource(event.source || event.eventSource);
  });
  function eventStatus(event) {
    const raw = String(event.status || "").trim().toLowerCase();
    if (raw === "cancelled" || raw === "canceled") return "Cancelled";
    if (raw === "rescheduled") return "Rescheduled";
    const openSlots = event.slotsOpen ?? event.availableSlots ?? event.slots;
    if (raw === "registration closed" || (openSlots != null && Number(openSlots) <= 0))
      return "Registration Closed";
    return "Available to Join";
  }

  function matches(event) {
    const query = state.query.trim().toLowerCase();
    const text =
      `${event.title} ${event.location} ${event.room} ${event.source} ${event.category}`.toLowerCase();
    const categoryTerms = categoryMatches[state.category] || [];
    const categoryMatch =
      state.category === "all" ||
      categoryTerms.some((term) =>
        String(event.category || "")
          .toLowerCase()
          .includes(term),
      );
    const source = String(event.source || "").toLowerCase();
    const organizationEvent =
      /organization|organizer|ibits|club|association/.test(source);
    const eventDate = event.dateISO
      ? new Date(`${event.dateISO}T00:00:00`)
      : null;
    const validDate = eventDate && !Number.isNaN(eventDate.getTime());
    const weekEnd = new Date(todayStart);
    weekEnd.setDate(weekEnd.getDate() + 7);
    const customRange = /^custom:(\d{4}-\d{2}-\d{2}):(\d{4}-\d{2}-\d{2})$/.exec(state.date);
    const range = dateRangeBounds(state.date);
    const dateMatch =
      state.date === "all" ||
      (validDate &&
        state.date === "today" &&
        eventDate.getTime() === todayStart.getTime()) ||
      (validDate &&
        state.date === "week" &&
        eventDate >= todayStart &&
        eventDate < weekEnd) ||
      (validDate &&
        state.date === "month" &&
        eventDate.getFullYear() === todayStart.getFullYear() &&
        eventDate.getMonth() === todayStart.getMonth()) ||
      (validDate && state.date === "upcoming" && eventDate >= todayStart) ||
      (validDate && state.date === "past" && eventDate < todayStart) ||
      (validDate && range && eventDate >= range[0] && eventDate <= range[1]) ||
      (validDate &&
        customRange &&
        eventDate >= new Date(`${customRange[1]}T00:00:00`) &&
        eventDate <= new Date(`${customRange[2]}T00:00:00`));
    const statusMatch =
      state.status === "all" || eventStatus(event) === state.status;
    const openSlots = event.slotsOpen ?? event.availableSlots;
    const availabilityMatch =
      state.availability === "all" ||
      (state.availability === "available" &&
        openSlots !== undefined &&
        Number(openSlots) > 0) ||
      (state.availability === "full" &&
        openSlots !== undefined &&
        Number(openSlots) <= 0) ||
      (state.availability === "unknown" && openSlots === undefined);
    const sourceMatches =
      state.source === "all" || normalizeSource(event.source) === state.source;
    const typeMatch =
      state.type === "all" ||
      (state.type === "organization" && organizationEvent) ||
      (state.type === "campus" && !organizationEvent);
    return (
      (!query || text.includes(query)) &&
      typeMatch &&
      sourceMatches &&
      categoryMatch &&
      dateMatch &&
      statusMatch &&
      availabilityMatch
    );
  }

  function isHappeningNow(event) {
    if (!isCurrent(event)) return false;
    const range =
      event.startTime && event.endTime
        ? [event.startTime, event.endTime]
        : String(event.time || "").split(/\s+-\s+/);
    if (range.length < 2) return true;
    const toMinutes = (value) => {
      const text = String(value).trim();
      const match = /^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i.exec(text);
      if (!match) return null;
      let hour = Number(match[1]);
      if (match[3])
        hour = (hour % 12) + (match[3].toUpperCase() === "PM" ? 12 : 0);
      return hour * 60 + Number(match[2]);
    };
    const start = toMinutes(range[0]);
    const end = toMinutes(range[1]);
    const nowMinutes = new Date().getHours() * 60 + new Date().getMinutes();
    return (
      start !== null && end !== null && nowMinutes >= start && nowMinutes <= end
    );
  }

  function eventCard(event) {
    const date = dateFor(event);
    return `<article class="teacher-event-card" data-event-id="${escapeHTML(event.id)}" id="teacher-event-card-${escapeHTML(event.id)}">
			<div class="teacher-date" id="teacher-event-date-${escapeHTML(event.id)}" data-event-field="date"><span id="teacher-event-month-${escapeHTML(event.id)}">${date.toLocaleDateString("en-US", { month: "short" })}</span><strong id="teacher-event-day-${escapeHTML(event.id)}">${date.getDate()}</strong><small>${date.getFullYear()}</small></div>
			<div class="teacher-event-content" id="teacher-event-content-${escapeHTML(event.id)}"><h3 class="teacher-event-title" id="teacher-event-title-${escapeHTML(event.id)}" data-event-field="title">${escapeHTML(event.title)}</h3><p class="teacher-event-source" id="teacher-event-source-${escapeHTML(event.id)}" data-event-field="source">${escapeHTML(normalizeSource(event.source || event.location))}</p><div class="teacher-event-meta" id="teacher-event-meta-${escapeHTML(event.id)}" data-event-field="schedule"><span id="teacher-event-time-${escapeHTML(event.id)}" data-event-field="time"><svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><circle cx="10" cy="10" r="7" stroke="currentColor" stroke-width="1.4"/><path d="M10 6v4l2.5 2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>${escapeHTML(event.time || "Schedule to be announced")}</span><span id="teacher-event-location-${escapeHTML(event.id)}" data-event-field="location"><svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M10 17.5S15.5 12.8 15.5 8.5a5.5 5.5 0 1 0-11 0c0 4.3 5.5 9 5.5 9Z" stroke="currentColor" stroke-width="1.4"/><circle cx="10" cy="8.3" r="2" stroke="currentColor" stroke-width="1.4"/></svg>${escapeHTML(event.location || "Location to be announced")} · ${escapeHTML(event.room || "Room TBD")}</span></div><span class="teacher-tag" id="teacher-event-category-${escapeHTML(event.id)}" data-event-field="category">${escapeHTML(event.tag || event.category || "University Event")}</span><p class="teacher-event-slots">${event.slotsOpen !== undefined ? `${escapeHTML(event.slotsOpen)} of ${escapeHTML(event.maxSlots ?? event.capacity ?? event.slotsOpen)} Slots Open` : "Availability not specified"}</p></div>
			<div class="teacher-event-actions" id="teacher-event-actions-${escapeHTML(event.id)}"><button type="button" class="teacher-details-button" id="teacher-event-details-button-${escapeHTML(event.id)}" data-event-details="${escapeHTML(event.id)}" aria-controls="teacherEventOverlay">View Details</button></div>
		</article>`;
  }

  function render() {
    const visible = events
      .filter(matches)
      .sort((first, second) =>
        String(first.dateISO || "").localeCompare(String(second.dateISO || "")),
      );
    const current = visible.filter(isHappeningNow);
    currentEvents.innerHTML = current.length
      ? current.map(eventCard).join("")
      : '<div class="teacher-empty">No events match your filters.</div>';
    upcomingEvents.innerHTML = visible.length
      ? visible.map(eventCard).join("")
      : '<div class="teacher-empty">No events match your filters.</div>';
    resultCount.textContent = `${visible.length} event${visible.length === 1 ? "" : "s"}`;
  }

  function openDetails(id) {
    const event = events.find((item) => item.id === id);
    if (!event) return;
    const teacherId = localStorage.getItem("recovibeTeacherId");
    const canReviewDocuments =
      teacherId &&
      String(event.createdBy || event.teacherId || event.organizerId || "") ===
        String(teacherId);
    window.RecovibeEventDetails?.open(event, {
      showApprovalDocuments: Boolean(canReviewDocuments),
    });
  }

  function closeDetails() {
    document.getElementById("teacherEventOverlay").hidden = true;
  }

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
    const selects = [...document.querySelectorAll(".teacher-toolbar select")]
      .filter((select) => select.id !== "teacherDateFilter");
    const wrappers = [];

    function closeMenus(except) {
      wrappers.forEach(({ wrapper, button, menu }) => {
        if (wrapper === except) return;
        menu.classList.remove("show");
        button.setAttribute("aria-expanded", "false");
      });
    }

    selects.forEach((select) => {
      const wrapper = document.createElement("div");
      const button = document.createElement("button");
      const menu = document.createElement("div");
      const dropdownId = `${select.id}Dropdown`;
      wrapper.className = "filter-dropdown";
      button.className = "filter-button";
      button.type = "button";
      button.setAttribute("aria-haspopup", "listbox");
      button.setAttribute("aria-expanded", "false");
      button.setAttribute(
        "aria-label",
        select.getAttribute("aria-label") || "Filter events",
      );
      button.id = `${dropdownId}Button`;
      menu.className = "filter-menu";
      menu.id = dropdownId;
      menu.setAttribute("role", "listbox");
      menu.setAttribute("aria-labelledby", button.id);
      button.setAttribute("aria-controls", menu.id);

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
      select.parentNode.insertBefore(wrapper, select);
      wrapper.append(button, menu, select);
      wrappers.push({ wrapper, button, menu, select, syncSelection });

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
        select.value = item.dataset.value;
        select.dispatchEvent(new Event("change", { bubbles: true }));
        syncSelection();
        closeMenus();
        button.focus();
      });
      select.addEventListener("change", syncSelection);
    });

    document.addEventListener("click", (event) => {
      if (!event.target.closest(".teacher-toolbar .filter-dropdown"))
        closeMenus();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeMenus();
    });
  }

  setupTeacherFilterDropdowns();
  createDateRangePicker(
    document.getElementById("teacherDateFilter").parentElement,
    document.getElementById("teacherDateFilter"),
  );

  document
    .getElementById("teacherEventSearch")
    .addEventListener("input", (event) => {
      state.query = event.target.value;
      render();
    });
  const filterBindings = [
    ["teacherEventTypeFilter", "type"],
    ["teacherSourceFilter", "source"],
    ["teacherCategoryFilter", "category"],
    ["teacherDateFilter", "date"],
    ["teacherStatusFilter", "status"],
    ["teacherAvailabilityFilter", "availability"],
  ];
  filterBindings.forEach(([id, key]) =>
    document.getElementById(id).addEventListener("change", (event) => {
      state[key] = event.target.value;
      render();
    }),
  );
  document.addEventListener("click", (event) => {
    const button = event.target.closest("[data-event-details]");
    if (button) openDetails(button.dataset.eventDetails);
  });
  document
    .getElementById("teacherModalClose")
    .addEventListener("click", closeDetails);
  document
    .getElementById("teacherEventOverlay")
    .addEventListener("click", (event) => {
      if (event.target.id === "teacherEventOverlay") closeDetails();
    });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeDetails();
  });
  document.getElementById("teacherMenuToggle").addEventListener("click", () => {
    const sidebar = document.getElementById("teacherSidebar");
    const open = sidebar.classList.toggle("is-open");
    document
      .getElementById("teacherMenuToggle")
      .setAttribute("aria-expanded", String(open));
  });
  let teacher = null;
  try {
    teacher = JSON.parse(
      localStorage.getItem("recovibeCurrentTeacher") || "null",
    );
  } catch (error) {
    console.warn("Unable to read teacher account.", error);
  }
  if (teacher) {
    const teacherName = teacher.name || teacher.fullName || "Mr. Miguel";
    document.getElementById("teacherName").textContent = teacherName;
    document.getElementById("teacherAvatar").textContent = teacherName
      .split(/\s+/)
      .filter(Boolean)
      .map((part) => part[0])
      .slice(0, 2)
      .join("")
      .toUpperCase();
    document.getElementById("teacherRole").textContent =
      teacher.department ||
      teacher.organization ||
      teacher.role ||
      "Faculty account";
  }
  document.getElementById("teacherLogout").addEventListener("click", () => {
    localStorage.removeItem("recovibeCurrentTeacher");
    localStorage.removeItem("recovibeTeacherId");
  });
  render();
  const requestedEventId = new URLSearchParams(window.location.search).get(
    "eventId",
  );
  if (requestedEventId) openDetails(requestedEventId);
})();
