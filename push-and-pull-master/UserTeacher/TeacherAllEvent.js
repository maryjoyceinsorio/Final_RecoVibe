import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  onSnapshot,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  auth,
  authReady,
  db,
  isFirebaseConfigured,
} from "../UserStudent/firebaseConfig.js";
import { teacherEventReadFilters, teacherEventsQuery } from "./TeacherEventQuery.js";

(() => {
  "use strict";

  const DEBUG = false;
  const TIME_ZONE = "Asia/Manila";
  const DAY_MS = 24 * 60 * 60 * 1000;
  const FILTER_DEFAULTS = {
    query: "",
    scope: "all",
    source: "all",
    category: "all",
    date: "all",
    status: "all",
    availability: "all",
    dateFrom: "",
    dateTo: "",
  };
  const state = { ...FILTER_DEFAULTS };
  const elements = {
    search: document.getElementById("teacherEventSearch"),
    scope: document.getElementById("teacherScopeFilter"),
    source: document.getElementById("teacherSourceFilter"),
    category: document.getElementById("teacherCategoryFilter"),
    date: document.getElementById("teacherDateFilter"),
    dateRange: document.getElementById("teacherCustomRange"),
    dateFrom: document.getElementById("teacherDateFrom"),
    dateTo: document.getElementById("teacherDateTo"),
    status: document.getElementById("teacherStatusFilter"),
    availability: document.getElementById("teacherAvailabilityFilter"),
    availabilityNote: document.getElementById("teacherAvailabilityNote"),
    clear: document.getElementById("teacherClearFilters"),
    notice: document.getElementById("teacherEventNotice"),
    loadState: document.getElementById("teacherLoadState"),
    current: document.getElementById("teacherCurrentEvents"),
    all: document.getElementById("teacherUpcomingEvents"),
    count: document.getElementById("teacherResultCount"),
    detailsOverlay: document.getElementById("teacherEventOverlay"),
  };

  let events = [];
  let visibleEvents = [];
  let eventsUnsubscribe = null;
  let authUnsubscribe = null;
  let timeoutId = null;
  let minuteInterval = null;
  let active = true;
  let currentUser = null;
  let activeReadUid = null;
  let activeReadFilters = [];
  let authGeneration = 0;
  let loading = true;
  let loadError = "";
  let directEventHandled = false;
  let searchTimer = null;
  let pageLoadSignaled = false;
  function signalEventsPageReady() {
    if (pageLoadSignaled) return;
    pageLoadSignaled = true;
    window.dispatchEvent(new Event("page-data-ready"));
  }

  function debug(...args) {
    if (DEBUG) console.debug("[Teacher Events]", ...args);
  }

  function escapeHTML(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[character]);
  }

  function normalizeStatus(event) {
    return String(event?.status || "")
      .trim()
      .toLowerCase()
      .replace(/[\s_-]+/g, "");
  }

  function getManilaParts(timestamp) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: TIME_ZONE,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      hourCycle: "h23",
    }).formatToParts(new Date(timestamp));
    const get = (type) => Number(parts.find((part) => part.type === type)?.value || 0);
    return {
      year: get("year"),
      month: get("month"),
      day: get("day"),
      hour: get("hour"),
      minute: get("minute"),
    };
  }

  function dateKey(parts) {
    return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
  }

  function dateOrdinal(key) {
    const [year, month, day] = key.split("-").map(Number);
    return Math.floor(Date.UTC(year, month - 1, day) / DAY_MS);
  }

  function manilaTimestamp(year, month, day, hour = 0, minute = 0, second = 0) {
    return Date.UTC(year, month - 1, day, hour - 8, minute, second);
  }

  function parseClock(value) {
    const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?$/i.exec(String(value || "").trim());
    if (!match) return null;
    let hour = Number(match[1]);
    const minute = Number(match[2]);
    if (minute > 59 || hour > 24 || (hour === 24 && minute !== 0)) return null;
    if (match[4]) {
      if (hour < 1 || hour > 12) return null;
      hour = (hour % 12) + (match[4].toUpperCase() === "PM" ? 12 : 0);
    }
    if (hour === 24) hour = 0;
    return { hour, minute, second: Number(match[3] || 0) };
  }

  function parseDateTime(value) {
    const text = String(value ?? "").trim();
    if (!text) return 0;
    if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)) {
      const timestamp = Date.parse(text);
      return Number.isFinite(timestamp) ? timestamp : 0;
    }
    const match = /^(\d{4})-(\d{2})-(\d{2})[T ](.+)$/.exec(text);
    if (!match) return 0;
    const clock = parseClock(match[4]);
    if (!clock) return 0;
    return manilaTimestamp(
      Number(match[1]),
      Number(match[2]),
      Number(match[3]),
      clock.hour,
      clock.minute,
      clock.second,
    );
  }

  function parseDateKey(value) {
    if (value && typeof value.toDate === "function") {
      const date = value.toDate();
      return dateKey(getManilaParts(date.getTime()));
    }
    if (value instanceof Date && Number.isFinite(value.getTime())) {
      return dateKey(getManilaParts(value.getTime()));
    }
    const text = String(value ?? "").trim();
    const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
    if (dateOnly) {
      const year = Number(dateOnly[1]);
      const month = Number(dateOnly[2]);
      const day = Number(dateOnly[3]);
      const check = new Date(Date.UTC(year, month - 1, day));
      if (
        month < 1 || month > 12 || day < 1 ||
        check.getUTCFullYear() !== year ||
        check.getUTCMonth() !== month - 1 ||
        check.getUTCDate() !== day
      ) return "";
      return `${dateOnly[1]}-${dateOnly[2]}-${dateOnly[3]}`;
    }
    if (/^\d{4}-\d{2}-\d{2}[T ]/.test(text)) {
      const parsed = parseDateTime(text);
      return Number.isFinite(parsed) && parsed ? dateKey(getManilaParts(parsed)) : "";
    }
    return "";
  }

  function toMillis(value) {
    if (value && typeof value.toMillis === "function") return value.toMillis();
    if (value && typeof value.toDate === "function") return value.toDate().getTime();
    if (value && typeof value.seconds === "number") return value.seconds * 1000;
    if (value instanceof Date && Number.isFinite(value.getTime())) return value.getTime();
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
    if (typeof value === "string" && value.trim()) {
      const text = value.trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return parseDateTime(`${text}T00:00`);
      const parsed = parseDateTime(text) || Date.parse(text);
      return Number.isFinite(parsed) ? parsed : 0;
    }
    return 0;
  }

  function splitTimeRange(value) {
    return String(value || "").split(/\s*(?:-|–|—)\s*/).map((part) => part.trim());
  }

  function displayValue(value) {
    if (value && typeof value === "object") {
      return String(value.name || value.organization || value.label || "").trim();
    }
    return String(value || "").trim();
  }

  function categoriesFor(event) {
    const value = event.category ?? event.categories ?? event.tag ?? "";
    const categories = Array.isArray(value) ? value : String(value).split(",");
    return [...new Set(categories.map(displayValue).filter(Boolean))];
  }

  function normalizeEvent(id, data) {
    if (!data || typeof data !== "object") throw new Error("Event data is not an object.");
    if (
      typeof window.isTeacherEventVisible !== "function" ||
      !window.isTeacherEventVisible(data, { includeCancelled: true })
    ) {
      return null;
    }

    const rawTime = splitTimeRange(data.time);
    const dateValue = data.dateISO || data.eventDate || data.date || data.startDate || "";
    const rawStartAt = data.startAt ?? data.start_at;
    const startAtIsDateOnly = typeof rawStartAt === "string" && /^\d{4}-\d{2}-\d{2}$/.test(rawStartAt.trim());
    let start = startAtIsDateOnly ? 0 : toMillis(rawStartAt);
    let startDate = parseDateKey(dateValue) || parseDateKey(rawStartAt);
    const startClock = parseClock(data.startTime || data.timeStart || rawTime[0] || "");

    if (!start && startDate) {
      const [year, month, day] = startDate.split("-").map(Number);
      start = manilaTimestamp(
        year,
        month,
        day,
        startClock?.hour || 0,
        startClock?.minute || 0,
        startClock?.second || 0,
      );
    }
    if (!start && dateValue) {
      start = parseDateTime(dateValue);
      if (start) startDate = dateKey(getManilaParts(start));
    }
    if (!start || !Number.isFinite(start)) {
      debug(`Skipped event ${id}: no usable start date.`, data);
      return null;
    }
    if (!startDate) startDate = dateKey(getManilaParts(start));

    const endDateValue = data.endDateISO || data.dateEnd || data.endDate || dateValue;
    const rawEndAt = data.endAt ?? data.end_at;
    const endAtIsDateOnly = typeof rawEndAt === "string" && /^\d{4}-\d{2}-\d{2}$/.test(rawEndAt.trim());
    const endDate = parseDateKey(rawEndAt) || parseDateKey(endDateValue) || startDate;
    const endClock = parseClock(data.endTime || data.timeEnd || rawTime[1] || "");
    let end = endAtIsDateOnly ? 0 : toMillis(rawEndAt);
    if (!end && endClock) {
      const [year, month, day] = endDate.split("-").map(Number);
      end = manilaTimestamp(year, month, day, endClock.hour, endClock.minute, endClock.second);
      if (end < start && endDate === startDate) end += DAY_MS;
    } else if (!end) {
      const [year, month, day] = endDate.split("-").map(Number);
      end = manilaTimestamp(year, month, day, 23, 59, 59);
    }

    const organization = displayValue(
      data.organization || data.organizationName || data.organizerName || data.organizer || data.orgName,
    );
    const source = displayValue(data.source || data.eventSource || organization) || "Source not specified";
    const capacityValue = data.capacity ?? data.maxCapacity ?? data.maxSlots ?? "";
    const capacity = String(capacityValue).trim() === "" ? null : Number(capacityValue);
    const registeredValue = data.registeredCount;
    const registeredCount = registeredValue === null ||
      registeredValue === undefined ||
      String(registeredValue).trim() === ""
      ? null
      : Number(registeredValue);
    const venue = [displayValue(data.venue || data.location), displayValue(data.room)]
      .filter(Boolean)
      .join(" · ");

    return {
      id: String(id),
      raw: data,
      status: normalizeStatus(data),
      title: String(data.title || data.name || data.eventName || "Untitled event"),
      description: String(data.description || data.desc || data.summary || ""),
      organization: organization || source,
      source,
      venue: venue || "Location to be announced",
      categories: categoriesFor(data),
      start,
      end,
      date: startDate,
      capacity: Number.isFinite(capacity) && capacity >= 0 ? capacity : null,
      registeredCount: Number.isFinite(registeredCount) ? Math.max(0, registeredCount) : null,
    };
  }

  function todayKey() {
    return dateKey(getManilaParts(Date.now()));
  }

  function formatDate(timestamp, options) {
    return new Intl.DateTimeFormat("en-US", { timeZone: TIME_ZONE, ...options }).format(new Date(timestamp));
  }

  function timeRange(event) {
    return `${formatDate(event.start, { weekday: "short" })}, ${formatDate(event.start, { hour: "numeric", minute: "2-digit" })} - ${formatDate(event.end, { hour: "numeric", minute: "2-digit" })}`;
  }

  function isLive(event, now = Date.now()) {
    return event.start <= now && now < event.end;
  }

  function eventStatus(event, now = Date.now()) {
    if (event.status === "cancelled" || event.status === "canceled") return "Cancelled";
    if (event.status === "rescheduled") return "Rescheduled";
    if (isLive(event, now)) return "Live now";
    return event.start > now ? "Upcoming" : "Completed";
  }

  function availability(event) {
    if (event.capacity === null || event.registeredCount === null) return "";
    if (event.registeredCount >= event.capacity) return "full";
    if (event.capacity > 0 && event.registeredCount / event.capacity >= 0.8) return "almost-full";
    return "open";
  }

  function refreshOptions(select, values, placeholder) {
    const selected = select.value;
    select.replaceChildren(new Option(placeholder, "all"));
    values.forEach((value) => select.add(new Option(value, value)));
    if ([...select.options].some((option) => option.value === selected)) {
      select.value = selected;
    } else {
      select.value = "all";
    }
  }

  function updateDynamicOptions() {
    const sources = [...new Set(events.flatMap((event) => [event.source, event.organization]).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b));
    const categories = [...new Set(events.flatMap((event) => event.categories))]
      .sort((a, b) => a.localeCompare(b));
    refreshOptions(elements.source, sources, "All Sources");
    refreshOptions(elements.category, categories, "Category");
    let invalidFilter = false;
    if (!sources.includes(state.source)) {
      invalidFilter = state.source !== "all";
      state.source = "all";
    }
    if (!categories.includes(state.category)) {
      invalidFilter = invalidFilter || state.category !== "all";
      state.category = "all";
    }
    elements.source.value = state.source;
    elements.category.value = state.category;

    const hasCapacity = events.some((event) => event.capacity !== null);
    const hasUnknownAvailability = events.some(
      (event) => event.capacity === null || event.registeredCount === null,
    );
    elements.availability.disabled = !hasCapacity;
    elements.availabilityNote.hidden = !events.length || (!hasUnknownAvailability && hasCapacity);
    elements.availabilityNote.textContent = hasCapacity
      ? "Events without stored capacity or registered count are excluded from availability filters."
      : "Availability filters are disabled because no events have capacity.";
    if (!hasCapacity && state.availability !== "all") {
      state.availability = "all";
      invalidFilter = true;
    }
    elements.availability.value = state.availability;
    if (invalidFilter) writeUrlFilters(true);
  }

  function dateMatch(event, nowKey) {
    if (state.date === "all") return true;
    if (state.date === "today") return event.date === nowKey;
    const currentOrdinal = dateOrdinal(nowKey);
    const eventOrdinal = dateOrdinal(event.date);
    if (state.date === "week") {
      const weekStart = currentOrdinal - new Date(Date.UTC(
        Number(nowKey.slice(0, 4)),
        Number(nowKey.slice(5, 7)) - 1,
        Number(nowKey.slice(8, 10)),
      )).getUTCDay();
      return eventOrdinal >= weekStart && eventOrdinal < weekStart + 7;
    }
    if (state.date === "month") return event.date.slice(0, 7) === nowKey.slice(0, 7);
    if (state.date === "custom") {
      const start = state.dateFrom || state.dateTo;
      const end = state.dateTo || state.dateFrom;
      return Boolean(start && end && event.date >= start && event.date <= end);
    }
    return true;
  }

  function filterEvents() {
    const now = Date.now();
    const nowKey = todayKey();
    const query = state.query.trim().toLocaleLowerCase();
    const steps = [
      ["search", (event) => !query || `${event.title} ${event.venue} ${event.organization} ${event.source}`.toLocaleLowerCase().includes(query)],
      ["scope", (event) => state.scope === "all" || (state.scope === "upcoming" ? event.start >= now : event.start < now)],
      ["source", (event) => state.source === "all" || event.source === state.source || event.organization === state.source],
      ["category", (event) => state.category === "all" || event.categories.includes(state.category)],
      ["date", (event) => dateMatch(event, nowKey)],
      ["status", (event) => state.status === "all" || eventStatus(event, now).toLowerCase().replace(/\s+/g, "-") === state.status],
      ["availability", (event) => state.availability === "all" || availability(event) === state.availability],
    ];
    let filtered = [...events];
    const counts = { visible: filtered.length };
    steps.forEach(([name, predicate]) => {
      filtered = filtered.filter(predicate);
      counts[name] = filtered.length;
    });
    debug("Filter counts:", counts);
    return filtered.sort((a, b) => {
      const aUpcoming = a.start >= now;
      const bUpcoming = b.start >= now;
      if (aUpcoming !== bUpcoming) return aUpcoming ? -1 : 1;
      return aUpcoming ? a.start - b.start : b.start - a.start;
    });
  }

  function renderCard(event, section) {
    const status = eventStatus(event);
    const registrationText = event.capacity === null || event.registeredCount === null
      ? ""
      : `<p class="teacher-event-slots">${event.registeredCount} of ${event.capacity} registered</p>`;
    const classes = [
      "teacher-event-card",
      event.status === "cancelled" || event.status === "canceled" ? "is-cancelled" : "",
    ].filter(Boolean).join(" ");
    return `<article class="${classes}" data-event-id="${escapeHTML(event.id)}" data-section="${section}">
      <div class="teacher-date" aria-label="${escapeHTML(formatDate(event.start, { month: "long", day: "numeric" }))}">
        <span>${escapeHTML(formatDate(event.start, { month: "short" }))}</span>
        <strong>${escapeHTML(formatDate(event.start, { day: "numeric" }))}</strong>
        <small>${escapeHTML(formatDate(event.start, { year: "numeric" }))}</small>
      </div>
      <div class="teacher-event-content">
        <div class="teacher-event-categories">${event.categories.map((category) => `<span class="teacher-tag">${escapeHTML(category)}</span>`).join("")}</div>
        <h3 class="teacher-event-title">${escapeHTML(event.title)}</h3>
        <p class="teacher-event-source">${escapeHTML(event.organization)}</p>
        <div class="teacher-event-meta">
          <span>${escapeHTML(timeRange(event))}</span>
          <span>${escapeHTML(event.venue)}</span>
        </div>
        ${registrationText}
      </div>
      <div class="teacher-event-actions">
        <span class="teacher-status-chip status-${status.toLowerCase().replace(/\s+/g, "-")}">${escapeHTML(status)}</span>
        <button type="button" class="teacher-details-button" data-event-details="${escapeHTML(event.id)}" aria-controls="teacherEventOverlay">Details</button>
      </div>
    </article>`;
  }

  function activeFilters() {
    return state.query !== "" ||
      state.scope !== "all" ||
      state.source !== "all" ||
      state.category !== "all" ||
      state.date !== "all" ||
      state.status !== "all" ||
      state.availability !== "all";
  }

  function render() {
    elements.clear.hidden = !activeFilters();
    elements.dateRange.hidden = elements.date.value !== "custom";
    if (loading) {
      elements.count.textContent = "";
      elements.current.replaceChildren();
      elements.all.replaceChildren();
      elements.loadState.hidden = true;
      return;
    }
    if (loadError) {
      elements.count.textContent = "";
      elements.current.replaceChildren();
      elements.all.replaceChildren();
      elements.loadState.hidden = false;
      elements.loadState.innerHTML = `<span>${escapeHTML(loadError)}</span><button type="button" id="teacherRetryEvents">Retry</button>`;
      signalEventsPageReady();
      return;
    }

    elements.loadState.hidden = true;
    const filtered = filterEvents();
    const live = filtered.filter((event) => isLive(event));
    elements.count.textContent = `${filtered.length} ${filtered.length === 1 ? "event" : "events"}`;
    if (live.length) {
      elements.current.innerHTML = live.map((event) => renderCard(event, "current")).join("");
    } else {
      elements.current.innerHTML = '<div class="teacher-empty">No events happening right now.</div>';
    }
    if (filtered.length) {
      elements.all.innerHTML = filtered.map((event) => renderCard(event, "all")).join("");
    } else if (!events.length) {
      elements.all.innerHTML = '<div class="teacher-empty">No events yet.</div>';
    } else {
      elements.all.innerHTML = '<div class="teacher-empty">No events match your filters.</div>';
    }
  }

  function readUrlFilters() {
    const params = new URLSearchParams(window.location.search);
    const valid = (value, choices) => choices.includes(value) ? value : "all";
    state.query = (params.get("search") || "").trim();
    state.scope = valid(params.get("scope"), ["all", "upcoming", "past"]);
    state.source = params.get("source") || "all";
    state.category = params.get("category") || "all";
    state.date = valid(params.get("date"), ["all", "today", "week", "month", "custom"]);
    state.status = valid(params.get("status"), ["all", "upcoming", "live", "completed", "cancelled", "rescheduled"]);
    state.availability = valid(params.get("availability"), ["all", "open", "almost-full", "full"]);
    state.dateFrom = params.get("dateFrom") || "";
    state.dateTo = params.get("dateTo") || "";
    if (
      (state.dateFrom && parseDateKey(state.dateFrom) !== state.dateFrom) ||
      (state.dateTo && parseDateKey(state.dateTo) !== state.dateTo) ||
      (state.dateFrom && state.dateTo && state.dateFrom > state.dateTo)
    ) {
      state.date = "all";
      state.dateFrom = "";
      state.dateTo = "";
    }
    if (state.date !== "custom") {
      state.dateFrom = "";
      state.dateTo = "";
    }
    if (state.date === "custom" && !state.dateFrom && !state.dateTo) state.date = "all";
    elements.search.value = state.query;
    elements.scope.value = state.scope;
    elements.date.value = state.date;
    elements.dateFrom.value = state.dateFrom;
    elements.dateTo.value = state.dateTo;
    elements.status.value = state.status;
    elements.availability.value = state.availability;
  }

  function writeUrlFilters(replace = false) {
    const url = new URL(window.location.href);
    const params = url.searchParams;
    const values = {
      search: state.query,
      scope: state.scope,
      source: state.source,
      category: state.category,
      date: state.date,
      dateFrom: state.date === "custom" ? state.dateFrom : "",
      dateTo: state.date === "custom" ? state.dateTo : "",
      status: state.status,
      availability: state.availability,
    };
    Object.entries(values).forEach(([key, value]) => {
      if (value && value !== "all") params.set(key, value);
      else params.delete(key);
    });
    if (url.href !== window.location.href) {
      if (replace) window.history.replaceState(null, "", url);
      else window.history.pushState(null, "", url);
    }
  }

  function syncControls() {
    elements.search.value = state.query;
    elements.scope.value = state.scope;
    elements.source.value = state.source;
    elements.category.value = state.category;
    elements.date.value = state.date;
    elements.dateFrom.value = state.dateFrom;
    elements.dateTo.value = state.dateTo;
    elements.status.value = state.status;
    elements.availability.value = state.availability;
  }

  function onFilterChange() {
    state.query = elements.search.value.trim();
    state.scope = elements.scope.value;
    state.source = elements.source.value;
    state.category = elements.category.value;
    state.date = elements.date.value;
    state.dateFrom = elements.dateFrom.value;
    state.dateTo = elements.dateTo.value;
    state.status = elements.status.value;
    state.availability = elements.availability.value;
    writeUrlFilters();
    render();
  }

  function setError(error, fallback) {
    const code = String(error?.code || "unknown");
    debug("Firestore read failed:", {
      path: "events",
      filters: activeReadFilters,
      code,
      message: error?.message || String(error),
      uid: activeReadUid,
    });
    if (code.includes("permission-denied")) {
      loadError = "You don't have permission to view events. Ask an administrator to check the Firestore events read rule.";
    } else if (/unavailable|deadline-exceeded|network|unknown/.test(code)) {
      loadError = "Couldn't connect to events. Check your network connection and retry.";
    } else {
      loadError = fallback || "Events could not be loaded. Please retry.";
    }
    loading = false;
    clearTimeout(timeoutId);
    timeoutId = null;
    render();
  }

  function stopEvents() {
    eventsUnsubscribe?.();
    eventsUnsubscribe = null;
    clearTimeout(timeoutId);
    timeoutId = null;
  }

  function startSafetyTimeout() {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => {
      if (loading) setError({ code: "timeout" }, "Events are taking longer than expected to load. Please retry.");
    }, 5000);
  }

  function handleSnapshot(snapshot) {
    const nextEvents = [];
    let visibleCount = 0;
    snapshot.docs.forEach((item) => {
      try {
        const data = item.data();
        if (window.isTeacherEventVisible?.(data, { includeCancelled: true })) visibleCount += 1;
        const event = normalizeEvent(item.id, data);
        if (event) nextEvents.push(event);
      } catch (error) {
        debug(`Skipped malformed event ${item.id}:`, error);
      }
    });
    events = nextEvents;
    visibleEvents = nextEvents;
    loading = false;
    loadError = "";
    clearTimeout(timeoutId);
    timeoutId = null;
    debug("Event snapshot:", {
      rawSnapshotSize: snapshot.size,
      afterVisibilityRule: visibleCount,
      afterUsableStartDate: nextEvents.length,
    });
    updateDynamicOptions();
    syncControls();
    render();
    if (!directEventHandled) openRequestedEvent();
    signalEventsPageReady();
  }

  function subscribeEvents(user) {
    stopEvents();
    currentUser = user;
    events = [];
    visibleEvents = [];
    loading = true;
    loadError = "";
    render();
    if (!db || !isFirebaseConfigured || !user?.uid || auth?.currentUser?.uid !== user.uid) {
      loadError = "Sign in with a teacher account to view events.";
      loading = false;
      render();
      signalEventsPageReady();
      return;
    }
    startSafetyTimeout();
    const uidAtRead = auth.currentUser?.uid;
    const filters = teacherEventReadFilters(user.uid);
    activeReadUid = uidAtRead;
    activeReadFilters = filters;
    debug("Firestore read started:", {
      path: "events",
      filters,
      uid: uidAtRead,
    });
    try {
      eventsUnsubscribe = onSnapshot(
        teacherEventsQuery(db, user.uid),
        handleSnapshot,
        (error) => setError(error, "Events could not be loaded. Please retry."),
      );
    } catch (error) {
      setError(error, "Events could not be loaded. Please retry.");
    }
  }

  function detailStatus(event) {
    return eventStatus(event);
  }

  function openDetails(event) {
    if (!event) return;
    const date = formatDate(event.start, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
    document.getElementById("teacherModalSource").textContent = event.organization;
    document.getElementById("teacherModalTitle").textContent = event.title;
    document.getElementById("teacherModalDate").textContent = date;
    document.getElementById("teacherModalTime").textContent = timeRange(event);
    document.getElementById("teacherModalLocation").textContent = event.venue;
    document.getElementById("teacherModalDescription").textContent = event.description;
    document.getElementById("teacherModalCategory").textContent = event.categories.join(", ") || "Not specified";
    document.getElementById("teacherModalCapacity").textContent = event.capacity === null
      ? "Not specified"
      : String(event.capacity);
    document.getElementById("teacherModalStatus").textContent = detailStatus(event);
    elements.detailsOverlay.hidden = false;
    document.getElementById("teacherModalClose").focus();
  }

  function closeDetails() {
    elements.detailsOverlay.hidden = true;
  }

  function openRequestedEvent() {
    const eventId = new URLSearchParams(window.location.search).get("eventId");
    if (!eventId) {
      directEventHandled = true;
      return;
    }
    const event = visibleEvents.find((item) => item.id === eventId);
    directEventHandled = true;
    if (!event) {
      elements.notice.textContent = "That event could not be found in the events available to your account.";
      elements.notice.hidden = false;
      return;
    }
    elements.notice.hidden = true;
    if (!matchesCurrentFilters(event)) {
      Object.assign(state, FILTER_DEFAULTS);
      syncControls();
      writeUrlFilters();
      render();
    }
    requestAnimationFrame(() => {
      const card = [...elements.all.querySelectorAll("[data-event-id]")].find((item) => item.dataset.eventId === event.id);
      if (card) {
        card.scrollIntoView({ behavior: "smooth", block: "center" });
        card.classList.add("is-highlighted");
        window.setTimeout(() => card.classList.remove("is-highlighted"), 2200);
      }
      openDetails(event);
    });
  }

  function matchesCurrentFilters(event) {
    const saved = events;
    events = [event];
    const match = filterEvents().length > 0;
    events = saved;
    return match;
  }

  function resetFilters() {
    Object.assign(state, FILTER_DEFAULTS);
    syncControls();
    writeUrlFilters();
    render();
  }

  function setup() {
    readUrlFilters();
    writeUrlFilters(true);
    elements.search.addEventListener("input", () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(onFilterChange, 250);
    });
    [
      elements.scope,
      elements.source,
      elements.category,
      elements.date,
      elements.status,
      elements.availability,
      elements.dateFrom,
      elements.dateTo,
    ].forEach((control) => control.addEventListener("change", onFilterChange));
    elements.clear.addEventListener("click", resetFilters);
    document.addEventListener("click", (event) => {
      const detailsButton = event.target.closest("[data-event-details]");
      if (detailsButton) {
        const item = visibleEvents.find((candidate) => candidate.id === detailsButton.dataset.eventDetails);
        openDetails(item);
      }
      if (event.target.closest("#teacherRetryEvents")) subscribeEvents(currentUser);
    });
    document.getElementById("teacherModalClose").addEventListener("click", closeDetails);
    elements.detailsOverlay.addEventListener("click", (event) => {
      if (event.target === elements.detailsOverlay) closeDetails();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeDetails();
    });
    document.getElementById("teacherMenuToggle").addEventListener("click", () => {
      const sidebar = document.getElementById("teacherSidebar");
      const open = sidebar.classList.toggle("is-open");
      document.getElementById("teacherMenuToggle").setAttribute("aria-expanded", String(open));
    });
    document.getElementById("teacherLogout").addEventListener("click", () => {
      localStorage.removeItem("recovibeCurrentTeacher");
      localStorage.removeItem("recovibeTeacherId");
    });
    window.addEventListener("popstate", () => {
      clearTimeout(searchTimer);
      Object.assign(state, FILTER_DEFAULTS);
      readUrlFilters();
      if (events.length) updateDynamicOptions();
      render();
    });
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("pageshow", onPageShow);

    try {
      const teacher = JSON.parse(localStorage.getItem("recovibeCurrentTeacher") || "null");
      if (teacher) {
        const teacherName = teacher.name || teacher.fullName || "Teacher";
        document.getElementById("teacherName").textContent = teacherName;
        document.getElementById("teacherAvatar").textContent = teacherName
          .split(/\s+/).filter(Boolean).map((part) => part[0]).slice(0, 2).join("").toUpperCase();
        document.getElementById("teacherRole").textContent = "Teacher";
      }
    } catch (error) {
      debug("Unable to read teacher profile:", error);
    }

    render();
    startSafetyTimeout();
    setupAuth();
  }

  function onPageHide() {
    active = false;
    authGeneration += 1;
    authUnsubscribe?.();
    authUnsubscribe = null;
    stopEvents();
    clearInterval(minuteInterval);
    clearTimeout(searchTimer);
  }

  function onPageShow(event) {
    if (!event.persisted) return;
    active = true;
    setupAuth();
  }

  function setupAuth() {
    const generation = ++authGeneration;
    Promise.resolve(authReady).then(() => {
      if (!active || generation !== authGeneration || authUnsubscribe) return;
      if (!auth || !isFirebaseConfigured) {
        window.location.replace("TeacherLogin.html");
        return;
      }
      authUnsubscribe = onAuthStateChanged(auth, (user) => {
        if (!active) return;
        if (!user?.uid) {
          stopEvents();
          window.location.replace("TeacherLogin.html");
          return;
        }
        subscribeEvents(user);
      });
    }).catch((error) => {
      debug("Teacher authentication initialization failed:", error);
      window.location.replace("TeacherLogin.html");
    });
    minuteInterval = window.setInterval(() => {
      if (!loading && !loadError) render();
    }, 60000);
  }

  setup();
})();
