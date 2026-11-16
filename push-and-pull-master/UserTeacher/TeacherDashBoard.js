import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  doc,
  getDoc,
  onSnapshot,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  auth,
  authReady,
  db,
  isFirebaseConfigured,
} from "../UserStudent/firebaseConfig.js";
import { startTeacherNotificationData } from "./TeacherNotificationData.js";
import { teacherEventReadFilters, teacherEventsQuery } from "./TeacherEventQuery.js";

const DEBUG = false;
const TIME_ZONE = "Asia/Manila";
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const UPCOMING_MS = 7 * DAY_MS;
const RECENT_MS = 14 * DAY_MS;
const NOTIFICATION_KEY = "recovibeTeacherNotifications";
const DELETED_KEY = "recovibeTeacherDeletedNotifications";

const dom = {
  app: document.getElementById("teacherDashboard"),
  sidebar: document.getElementById("teacherSidebar"),
  sidebarToggle: document.getElementById("sidebarToggle"),
  sidebarClose: document.getElementById("sidebarClose"),
  sidebarScrim: document.getElementById("sidebarScrim"),
  greeting: document.getElementById("teacherGreeting"),
  subtitle: document.getElementById("teacherSubtitle"),
  today: document.getElementById("teacherToday"),
  userName: document.getElementById("userName"),
  userAvatar: document.getElementById("userAvatar"),
  comingUp: document.getElementById("comingUpContent"),
  calendar: document.getElementById("calendarContent"),
  calendarLabel: document.getElementById("calendarMonthLabel"),
  calendarPrevious: document.getElementById("calendarPrevious"),
  calendarNext: document.getElementById("calendarNext"),
  notifications: document.getElementById("notificationsContent"),
  unreadCount: document.getElementById("unreadCount"),
  notificationBadge: document.getElementById("navNotifBadge"),
};

const state = {
  uid: "",
  profile: readCachedProfile(),
  events: [],
  records: [],
  eventsLoading: true,
  eventsError: "",
  notificationItems: [],
  notificationLoading: true,
  notificationError: "",
  notificationRetry: null,
  notificationSourceErrors: [],
  month: getManilaParts(Date.now()).month - 1,
  year: getManilaParts(Date.now()).year,
  selectedDate: "",
};

let authUnsubscribe = null;
let eventsUnsubscribe = null;
let eventsTimeout = null;
let nextMinuteTimeout = null;
let minuteInterval = null;
let active = true;
let authGeneration = 0;

function debug(...args) {
  if (DEBUG) console.debug("[Teacher Dashboard]", ...args);
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

function readCachedProfile() {
  try {
    return JSON.parse(
      localStorage.getItem("recovibeCurrentTeacher") ||
      localStorage.getItem("recovibeTeacher") ||
      "{}",
    ) || {};
  } catch (error) {
    debug("Could not read the cached teacher profile:", error);
    return {};
  }
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
    return Number.isFinite(parsed) ? dateKey(getManilaParts(parsed)) : "";
  }
  return "";
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

function toMillis(value) {
  if (value && typeof value.toMillis === "function") return value.toMillis();
  if (value && typeof value.toDate === "function") return value.toDate().getTime();
  if (value && typeof value.seconds === "number") return value.seconds * 1000;
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value === "string" && value.trim()) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
      return parseDateTime(`${value.trim()}T00:00`);
    }
    const parsed = parseDateTime(value) || Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function splitRange(value) {
  return String(value || "").split(/\s*(?:-|–|—)\s*/).map((part) => part.trim());
}

function normalizeStatus(event) {
  return String(event?.status || "").trim().toLowerCase().replace(/[\s_-]+/g, "");
}

function normalizeEvent(id, event) {
  if (!event || typeof event !== "object") return null;
  if (typeof window.isTeacherEventVisible !== "function" || !window.isTeacherEventVisible(event)) {
    return null;
  }

  const rawTime = splitRange(event.time);
  const dateValue = event.dateISO || event.eventDate || event.date || event.startDate || "";
  const rawStartAt = event.startAt ?? event.start_at;
  const startAtIsDateOnly = typeof rawStartAt === "string" && /^\d{4}-\d{2}-\d{2}$/.test(rawStartAt.trim());
  let start = startAtIsDateOnly ? 0 : toMillis(rawStartAt);
  let startDate = parseDateKey(dateValue) || parseDateKey(rawStartAt);
  const startClock = parseClock(event.startTime || event.timeStart || rawTime[0] || "");

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
  if (!start || !Number.isFinite(start)) return null;
  if (!startDate) startDate = dateKey(getManilaParts(start));

  const endDateValue = event.endDateISO || event.dateEnd || event.endDate || dateValue;
  const rawEndAt = event.endAt ?? event.end_at;
  const endAtIsDateOnly = typeof rawEndAt === "string" && /^\d{4}-\d{2}-\d{2}$/.test(rawEndAt.trim());
  const endDate = parseDateKey(rawEndAt) || parseDateKey(endDateValue) || startDate;
  const endClock = parseClock(event.endTime || event.timeEnd || rawTime[1] || "");
  let end = endAtIsDateOnly ? 0 : toMillis(rawEndAt);
  if (!end && endClock) {
    const [year, month, day] = endDate.split("-").map(Number);
    end = manilaTimestamp(year, month, day, endClock.hour, endClock.minute, endClock.second);
    if (end < start && endDate === startDate) end += DAY_MS;
  } else if (!end) {
    const [year, month, day] = endDate.split("-").map(Number);
    end = manilaTimestamp(year, month, day, 23, 59, 59);
  }

  const title = String(event.title || event.name || event.eventName || "Untitled event");
  const venueParts = [event.location, event.room].filter((part) => String(part || "").trim());
  const capacityMissing =
    event.capacity === null ||
    event.capacity === undefined ||
    String(event.capacity).trim() === "";
  const capacity = capacityMissing ? Number.NaN : Number(event.capacity);
  return {
    id: String(id),
    raw: event,
    status: normalizeStatus(event),
    title,
    venue: venueParts.length ? venueParts.join(" · ") : "Location to be announced",
    start,
    end,
    date: startDate,
    capacity: Number.isFinite(capacity) && capacity >= 0 ? capacity : null,
    registeredCount: Number.isFinite(Number(event.registeredCount))
      ? Math.max(0, Number(event.registeredCount))
      : 0,
  };
}

function formatTime(timestamp) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

function formatDayHeading(key, todayKey, tomorrowKey) {
  const [year, month, day] = key.split("-").map(Number);
  if (key === todayKey) return "Today";
  if (key === tomorrowKey) {
    return `Tomorrow · ${new Intl.DateTimeFormat("en-US", {
      timeZone: TIME_ZONE,
      weekday: "short",
      month: "short",
      day: "numeric",
    }).format(new Date(manilaTimestamp(year, month, day, 12)))}`;
  }
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(new Date(manilaTimestamp(year, month, day, 12)));
}

function eventChip(event, now, todayKey) {
  if (event.start <= now && event.end >= now) {
    return '<span class="event-chip is-live">Live now</span>';
  }
  const remaining = event.start - now;
  if (remaining < HOUR_MS) {
    return `<span class="event-chip">Starts in ${Math.max(1, Math.ceil(remaining / 60000))}m</span>`;
  }
  if (remaining < DAY_MS) {
    return `<span class="event-chip">Starts in ${Math.ceil(remaining / HOUR_MS)}h</span>`;
  }
  const days = Math.max(1, dateOrdinal(event.date) - dateOrdinal(todayKey));
  return `<span class="event-chip">In ${days} ${days === 1 ? "day" : "days"}</span>`;
}

function renderError(message, retryType) {
  return `<div class="section-error"><span>${escapeHTML(message)}</span><button type="button" data-retry="${retryType}">Retry</button></div>`;
}

function renderComingUp() {
  if (state.eventsLoading) return;
  if (state.eventsError) {
    dom.comingUp.innerHTML = renderError(state.eventsError, "events");
    return;
  }

  const now = Date.now();
  const today = getManilaParts(now);
  const todayKey = dateKey(today);
  const tomorrowKey = dateKey({
    ...getManilaParts(now + DAY_MS),
  });
  const candidates = state.events
    .filter((event) => {
      const live = event.start <= now && event.end >= now;
      return live || (event.start >= now && event.start <= now + UPCOMING_MS);
    })
    .sort((first, second) => {
      const firstLive = first.start <= now && first.end >= now;
      const secondLive = second.start <= now && second.end >= now;
      return Number(secondLive) - Number(firstLive) || first.start - second.start;
    })
    .slice(0, 6);

  if (!candidates.length) {
    dom.comingUp.innerHTML = '<div class="empty-state">Nothing coming up. Events starting in the next 7 days will appear here.</div>';
    return;
  }

  const groups = [];
  candidates.forEach((event) => {
    const live = event.start <= now && event.end >= now;
    const heading = live ? "Happening now" : formatDayHeading(event.date, todayKey, tomorrowKey);
    let group = groups.find((item) => item.heading === heading);
    if (!group) {
      group = { heading, events: [] };
      groups.push(group);
    }
    group.events.push(event);
  });

  dom.comingUp.innerHTML = groups.map((group) => `
    <div class="event-group">
      <h3>${escapeHTML(group.heading)}</h3>
      ${group.events.map((event) => {
        const href = `TeacherAllEvent.html?eventId=${encodeURIComponent(event.id)}`;
        const count = event.capacity === null
          ? ""
          : `<p class="event-registered">${event.registeredCount} of ${event.capacity} registered</p>`;
        return `<a class="event-row" href="${escapeHTML(href)}" aria-label="${escapeHTML(`${event.title}, ${formatTime(event.start)} to ${formatTime(event.end)}. Open event details`)}">
          <span class="event-time"><span>${escapeHTML(formatTime(event.start))}</span><span>${escapeHTML(formatTime(event.end))}</span></span>
          <span class="event-info">
            <span class="event-title-line"><strong class="event-title">${escapeHTML(event.title)}</strong>${eventChip(event, now, todayKey)}</span>
            <span class="event-venue">${escapeHTML(event.venue)}</span>
            ${count}
          </span>
        </a>`;
      }).join("")}
    </div>`).join("");
}

function calendarMonthName(month) {
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "long" }).format(new Date(Date.UTC(2020, month, 1)));
}

function formatCalendarDate(key) {
  const [year, month, day] = key.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    month: "long",
    day: "numeric",
  }).format(new Date(manilaTimestamp(year, month, day, 12)));
}

function renderCalendar() {
  dom.calendarLabel.textContent = `${calendarMonthName(state.month)} ${state.year}`;
  if (state.eventsLoading) return;
  if (state.eventsError) {
    dom.calendar.innerHTML = renderError(state.eventsError, "events");
    return;
  }

  const todayKey = dateKey(getManilaParts(Date.now()));
  const firstDay = new Date(Date.UTC(state.year, state.month, 1)).getUTCDay();
  const daysInMonth = new Date(Date.UTC(state.year, state.month + 1, 0)).getUTCDate();
  const eventsByDate = new Map();
  state.events.forEach((event) => {
    const startOrdinal = dateOrdinal(event.date);
    const endDate = dateKey(getManilaParts(Math.max(event.start, event.end)));
    const endOrdinal = dateOrdinal(endDate);
    for (let day = 1; day <= daysInMonth; day += 1) {
      const key = `${state.year}-${String(state.month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      const ordinal = dateOrdinal(key);
      if (ordinal < startOrdinal || ordinal > endOrdinal) continue;
      if (!eventsByDate.has(key)) eventsByDate.set(key, []);
      eventsByDate.get(key).push(event);
    }
  });

  const cells = [];
  for (let index = 0; index < firstDay; index += 1) cells.push('<span class="calendar-day is-outside" aria-hidden="true"></span>');
  for (let day = 1; day <= daysInMonth; day += 1) {
    const key = `${state.year}-${String(state.month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const hasEvents = eventsByDate.has(key);
    const classes = ["calendar-day"];
    if (hasEvents) classes.push("has-events");
    if (key === todayKey) classes.push("is-today");
    if (key === state.selectedDate) classes.push("is-selected");
    const label = `${calendarMonthName(state.month)} ${day}${hasEvents ? ", has events" : ""}`;
    cells.push(`<button type="button" class="${classes.join(" ")}" data-calendar-date="${key}" aria-label="${escapeHTML(label)}"${hasEvents ? ' aria-pressed="' + String(key === state.selectedDate) + '"' : ' disabled'}>${day}</button>`);
  }
  while (cells.length % 7) cells.push('<span class="calendar-day is-outside" aria-hidden="true"></span>');

  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const anyMonthEvents = eventsByDate.size > 0;
  let selectedEvents = [];
  if (state.selectedDate) selectedEvents = eventsByDate.get(state.selectedDate) || [];
  const selectedList = selectedEvents.length
    ? `<div class="selected-day-events"><h3>${escapeHTML(formatCalendarDate(state.selectedDate))}</h3>${selectedEvents
      .sort((first, second) => first.start - second.start)
      .map((event) => `<a href="TeacherAllEvent.html?eventId=${encodeURIComponent(event.id)}"><span>${escapeHTML(event.title)}</span><small>${escapeHTML(formatTime(event.start))}</small></a>`)
      .join("")}</div>`
    : "";
  const monthEmpty = anyMonthEvents ? "" : '<p class="empty-state calendar-empty">No events scheduled this month.</p>';

  dom.calendar.innerHTML = `
    <div class="calendar-weekdays" aria-hidden="true">${weekdays.map((day) => `<span>${day}</span>`).join("")}</div>
    <div class="calendar-grid">${cells.join("")}</div>
    ${monthEmpty}${selectedList}`;
}

function parseStoredArray(key) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || "[]");
    return Array.isArray(value) ? value : [];
  } catch (error) {
    debug("Could not read saved notification state:", error);
    return [];
  }
}

function belongsToUid(item, uid) {
  const identifiers = [
    item.userId,
    item.recipientUid,
    item.teacherId,
    item.teacherUid,
    item.recipientId,
    item.ownerId,
    item.email,
    item.recipientEmail,
  ].filter(Boolean).map((value) => String(value).trim().toLowerCase());
  return identifiers.includes(String(uid || "").toLowerCase());
}

function readStoredState(key, uid) {
  const scopedKey = `${key}:${uid}`;
  try {
    if (uid && localStorage.getItem(scopedKey) !== null) return parseStoredArray(scopedKey);
  } catch (error) {
    debug("Could not check scoped notification state:", error);
  }
  return parseStoredArray(key).filter((item) => !uid || belongsToUid(item, uid));
}

function notificationType(item) {
  const text = `${item.type || ""} ${item.title || ""} ${item.status || ""} ${item.action || ""}`
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
  if (text.includes("cancel")) return "cancelled";
  if (text.includes("resched")) return "rescheduled";
  if (text.includes("reminder") || text.includes("upcoming") || text.includes("starts")) return "reminder";
  if (text.includes("publish") || text.includes("newevent")) return "published";
  return "default";
}

function eventDerivedNotifications() {
  const now = Date.now();
  const items = [];
  state.records.forEach(({ id, data }) => {
    try {
      const status = normalizeStatus(data);
      const title = String(data.title || data.name || data.eventName || "Event");
      const description = String(data.description || data.summary || "").trim();
      const publishedAt = toMillis(data.publishedAt) || toMillis(data.updatedAt) || toMillis(data.createdAt);
      const cancelled = status === "cancelled" || status === "canceled";

      if (status === "published" && publishedAt > 0 && publishedAt <= now && now - publishedAt <= RECENT_MS) {
        items.push({
          id: `published-${id}-${publishedAt}`,
          eventId: id,
          type: "published",
          title: "New event",
          message: description ? `${title}. ${description}` : `${title} is now available.`,
          createdAtMillis: publishedAt,
          read: false,
        });
      }

      if ((cancelled || status === "rescheduled") && toMillis(data.updatedAt) > 0) {
        const updatedAt = toMillis(data.updatedAt);
        if (updatedAt <= now && now - updatedAt <= RECENT_MS) {
          items.push({
            id: `${cancelled ? "cancelled" : "rescheduled"}-${id}-${updatedAt}`,
            eventId: id,
            type: cancelled ? "cancelled" : "rescheduled",
            title: cancelled ? `${title} was cancelled` : `${title} was rescheduled`,
            message: cancelled ? "The organizer cancelled this event." : "The event schedule has changed.",
            createdAtMillis: updatedAt,
            read: false,
          });
        }
      }

      if (cancelled || ["draft", "pending", "rejected"].includes(status)) return;
      const event = normalizeEvent(id, data);
      if (!event || event.start <= now || event.start - now > DAY_MS) return;
      const tomorrowKey = dateKey(getManilaParts(now + DAY_MS));
      const isTomorrow = event.date === tomorrowKey;
      const hours = Math.max(1, Math.ceil((event.start - now) / HOUR_MS));
      items.push({
        id: `reminder-${id}-${event.start}`,
        eventId: id,
        type: "reminder",
        title: isTomorrow ? `${title} starts tomorrow` : `${title} starts in ${hours} ${hours === 1 ? "hour" : "hours"}`,
        message: "An event is coming up.",
        createdAtMillis: Math.max(1, event.start - DAY_MS),
        read: false,
      });
    } catch (error) {
      debug(`Could not create an event notification for ${id}:`, error);
    }
  });
  return items;
}

function mergedNotifications() {
  const merged = new Map();
  state.notificationItems.forEach((item) => {
    if (!item || !item.id) return;
    merged.set(String(item.id), {
      ...item,
      id: String(item.id),
      title: String(item.title || item.eventTitle || item.eventName || "Notification"),
      message: String(item.message || item.body || ""),
      type: notificationType(item),
      createdAtMillis: Number(item.createdAtMillis) || toMillis(item.createdAt) ||
        toMillis(item.timestamp) || toMillis(item.time),
      eventId: String(item.eventId || item.event_id || ""),
    });
  });

  const coverage = new Set();
  merged.forEach((item) => {
    if (item.eventId) coverage.add(`${item.eventId}:${item.type}`);
  });
  eventDerivedNotifications().forEach((item) => {
    if (merged.has(item.id) || coverage.has(`${item.eventId}:${item.type}`)) return;
    merged.set(item.id, item);
  });

  const stored = readStoredState(NOTIFICATION_KEY, state.uid);
  const deleted = readStoredState(DELETED_KEY, state.uid);
  const readById = new Map(stored.map((item) => [String(item.id || ""), item.read === true]));
  const deletedIds = new Set(deleted.map((item) => String(item.id || "")));
  return [...merged.values()]
    .filter((item) => !deletedIds.has(item.id))
    .map((item) => ({
      ...item,
      read: readById.has(item.id) ? readById.get(item.id) : item.read === true,
    }))
    .sort((first, second) => {
      const firstTime = Number(first.createdAtMillis) || 0;
      const secondTime = Number(second.createdAtMillis) || 0;
      if (!firstTime && !secondTime) return 0;
      if (!firstTime) return 1;
      if (!secondTime) return -1;
      return secondTime - firstTime;
    });
}

function relativeTime(timestamp) {
  if (!timestamp || !Number.isFinite(timestamp)) return "";
  const elapsed = Math.max(0, Date.now() - timestamp);
  if (elapsed < HOUR_MS) return `${Math.max(1, Math.ceil(elapsed / 60000))}m`;
  if (elapsed < DAY_MS) return `${Math.ceil(elapsed / HOUR_MS)}h`;

  const itemKey = dateKey(getManilaParts(timestamp));
  const todayKey = dateKey(getManilaParts(Date.now()));
  const yesterdayKey = dateKey(getManilaParts(Date.now() - DAY_MS));
  if (itemKey === yesterdayKey) return "Yesterday";
  if (itemKey === todayKey) return "Today";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    month: "short",
    day: "numeric",
  }).format(new Date(timestamp));
}

function notificationIcon(type) {
  const icons = {
    published: "✦",
    cancelled: "×",
    rescheduled: "↻",
    reminder: "◷",
    default: "•",
  };
  return icons[type] || icons.default;
}

function renderNotifications() {
  if (state.notificationLoading) return;
  if (state.notificationError) {
    dom.notifications.innerHTML = renderError(state.notificationError, "notifications");
    return;
  }

  const items = mergedNotifications();
  const unread = items.filter((item) => !item.read).length;
  dom.unreadCount.textContent = unread > 9 ? "9+" : String(unread);
  dom.unreadCount.hidden = unread === 0;
  dom.notificationBadge.textContent = unread > 9 ? "9+" : String(unread);
  dom.notificationBadge.hidden = unread === 0;
  dom.notificationBadge.setAttribute(
    "aria-label",
    unread ? `${unread} unread notifications` : "No unread notifications",
  );

  const warning = state.notificationSourceErrors.length
    ? `<div class="notification-source-warning"><span>${escapeHTML(state.notificationSourceErrors.join(" "))} Some sources may be unavailable.</span><button type="button" data-retry="notifications">Retry</button></div>`
    : "";
  if (!items.length) {
    dom.notifications.innerHTML = `${warning}<div class="empty-state">No recent notifications.</div>`;
    return;
  }

  dom.notifications.innerHTML = `${warning}${items.slice(0, 4).map((item) => {
    const unreadClass = item.read ? "" : " is-unread";
    const time = relativeTime(Number(item.createdAtMillis) || 0);
    return `<article class="notification-item${unreadClass}">
      <span class="notification-icon" aria-hidden="true">${notificationIcon(item.type)}</span>
      <div class="notification-copy">
        <strong>${escapeHTML(item.title)}</strong>
        <p>${escapeHTML(item.message || "There is an update about an event.")}</p>
      </div>
      ${time ? `<time class="notification-time">${escapeHTML(time)}</time>` : ""}
      ${item.read ? "" : '<span class="unread-dot" aria-label="Unread"></span>'}
    </article>`;
  }).join("")}`;
}

function renderHeader() {
  const now = Date.now();
  const parts = getManilaParts(now);
  const greeting = parts.hour >= 5 && parts.hour < 12
    ? "Good morning"
    : parts.hour >= 12 && parts.hour < 18
      ? "Good afternoon"
      : "Good evening";
  const firstName = String(
    state.profile.firstName ||
    state.profile.fullName ||
    state.profile.name ||
    state.profile.displayName ||
    "",
  ).trim().split(/\s+/)[0] || "there";
  dom.greeting.textContent = `${greeting}, ${firstName}`;
  dom.today.textContent = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(new Date(now));
  debug("Greeting hour (Asia/Manila):", parts.hour);

  if (state.eventsLoading || state.eventsError) return;
  const happening = state.events.filter((event) => event.start <= now && event.end >= now).length;
  const tomorrowKey = dateKey(getManilaParts(now + DAY_MS));
  const tomorrow = state.events.filter((event) => event.date === tomorrowKey && event.start > now).length;
  dom.subtitle.textContent = happening
    ? `${happening} ${happening === 1 ? "event is" : "events are"} happening now`
    : tomorrow
      ? `${tomorrow} ${tomorrow === 1 ? "event starts" : "events start"} tomorrow`
      : "No events coming up";
}

function renderAll() {
  renderHeader();
  renderComingUp();
  renderCalendar();
  renderNotifications();
}

function recordEvents(snapshot) {
  const records = [];
  const events = [];
  snapshot.docs.forEach((item) => {
    try {
      const data = item.data();
      if (!data || typeof data !== "object") throw new Error("Event data is not an object.");
      records.push({ id: item.id, data });
      const event = normalizeEvent(item.id, data);
      if (event) events.push(event);
    } catch (error) {
      debug(`Skipped malformed event ${item.id}:`, error);
    }
  });
  state.records = records;
  state.events = events;
  state.eventsLoading = false;
  state.eventsError = "";
  if (eventsTimeout) clearTimeout(eventsTimeout);
  eventsTimeout = null;
  debug("Event snapshot:", { total: snapshot.size, visible: events.length });
  renderAll();
}

function stopEvents() {
  eventsUnsubscribe?.();
  eventsUnsubscribe = null;
  if (eventsTimeout) clearTimeout(eventsTimeout);
  eventsTimeout = null;
}

function subscribeEvents(uid) {
  stopEvents();
  state.events = [];
  state.records = [];
  state.eventsLoading = true;
  state.eventsError = "";
  if (!db || !uid || auth?.currentUser?.uid !== uid) {
    state.eventsLoading = false;
    state.eventsError = "Sign in to view events.";
    renderAll();
    return;
  }

  eventsTimeout = setTimeout(() => {
    if (!state.eventsLoading) return;
    state.eventsLoading = false;
    state.eventsError = "Events are taking longer than expected to load.";
    renderAll();
  }, 5000);
  const uidAtRead = auth.currentUser?.uid;
  const filters = teacherEventReadFilters(uid);
  debug("Firestore read started:", {
    path: "events",
    filters,
    uid: uidAtRead,
  });
  try {
    eventsUnsubscribe = onSnapshot(
      teacherEventsQuery(db, uid),
      recordEvents,
      (error) => {
        if (eventsTimeout) clearTimeout(eventsTimeout);
        eventsTimeout = null;
        state.eventsLoading = false;
        state.eventsError = error?.code === "permission-denied"
          ? "You don't have permission to view events. Ask an administrator to check the Firestore events read rule."
          : error?.message || "Events could not be loaded.";
        debug("Firestore read failed:", {
          path: "events",
          filters,
          code: error?.code || "unknown",
          message: error?.message || String(error),
          uid: uidAtRead,
        });
        renderAll();
      },
    );
  } catch (error) {
    if (eventsTimeout) clearTimeout(eventsTimeout);
    eventsTimeout = null;
    state.eventsLoading = false;
    state.eventsError = error?.code === "permission-denied"
      ? "You don't have permission to view events. Ask an administrator to check the Firestore events read rule."
      : error?.message || "Events could not be loaded.";
    debug("Firestore read failed:", {
      path: "events",
      filters,
      code: error?.code || "unknown",
      message: error?.message || String(error),
      uid: uidAtRead,
    });
    renderAll();
  }
}

async function loadProfile(user) {
  const cached = readCachedProfile();
  state.profile = cached;
  if (user?.displayName) state.profile.displayName = user.displayName;
  updateSidebarProfile();
  if (!user?.uid || !db) return;

  const uidAtRead = auth.currentUser?.uid;
  try {
    debug("Firestore read started:", {
      path: `users/${user.uid}`,
      filters: [],
      uid: uidAtRead,
    });
    const profileSnapshot = await getDoc(doc(db, "users", user.uid));
    if (state.uid !== user.uid || !profileSnapshot.exists()) return;
    state.profile = { ...cached, ...profileSnapshot.data() };
    updateSidebarProfile();
    renderHeader();
  } catch (error) {
    debug("Firestore read failed:", {
      path: `users/${user.uid}`,
      filters: [],
      code: error?.code || "unknown",
      message: error?.message || String(error),
      uid: uidAtRead,
    });
  }
}

function updateSidebarProfile() {
  const name = String(
    state.profile.fullName ||
    state.profile.name ||
    state.profile.displayName ||
    "Teacher",
  ).trim();
  dom.userName.textContent = name || "Teacher";
  dom.userAvatar.textContent = (name || "Teacher")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join("") || "T";
}

function resolveIdentity(user) {
  if (!user?.uid) {
    state.uid = "";
    stopEvents();
    window.location.replace("TeacherLogin.html");
    return;
  }
  const cached = readCachedProfile();
  const uid = user.uid;
  if (uid === state.uid && eventsUnsubscribe) return;
  state.uid = uid;
  subscribeEvents(uid);
  loadProfile(user);
}

function startAuthListener() {
  const generation = ++authGeneration;
  if (!auth || !isFirebaseConfigured) {
    window.location.replace("TeacherLogin.html");
    return;
  }
  if (eventsTimeout) clearTimeout(eventsTimeout);
  eventsTimeout = setTimeout(() => {
    if (!active || generation !== authGeneration || !state.eventsLoading) return;
    state.eventsLoading = false;
    state.eventsError = "Authentication is taking longer than expected to load dashboard events.";
    renderAll();
  }, 5000);
  Promise.resolve(authReady).then(() => {
    if (!active || generation !== authGeneration || authUnsubscribe) return;
    authUnsubscribe = onAuthStateChanged(auth, (user) => {
      if (active && generation === authGeneration) resolveIdentity(user);
    });
  }).catch((error) => {
    if (eventsTimeout) clearTimeout(eventsTimeout);
    eventsTimeout = null;
    debug("Could not initialize teacher authentication:", error);
    window.location.replace("TeacherLogin.html");
  });
}

function onNotificationData(data) {
  if (!auth?.currentUser?.uid || data.uid !== auth.currentUser.uid) return;
  state.notificationItems = Array.isArray(data.items) ? data.items : [];
  state.notificationLoading = Boolean(data.loading);
  state.notificationRetry = data.retry;
  state.notificationSourceErrors = Object.values(data.sourceErrors || {})
    .filter(Boolean)
    .map((message) => String(message));
  state.notificationError = data.allFailed
    ? data.error || "Notifications could not be loaded."
    : "";
  if (!state.notificationLoading) renderNotifications();
}

function setSidebarOpen(open) {
  dom.sidebar.classList.toggle("is-open", open);
  dom.sidebarScrim.hidden = !open;
  dom.sidebarToggle.setAttribute("aria-expanded", String(open));
  document.body.classList.toggle("sidebar-open", open);
}

dom.sidebarToggle.addEventListener("click", () => setSidebarOpen(true));
dom.sidebarClose.addEventListener("click", () => setSidebarOpen(false));
dom.sidebarScrim.addEventListener("click", () => setSidebarOpen(false));
dom.sidebar.querySelectorAll(".nav-link").forEach((link) => {
  link.addEventListener("click", () => setSidebarOpen(false));
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") setSidebarOpen(false);
});
dom.calendarPrevious.addEventListener("click", () => {
  state.month -= 1;
  if (state.month < 0) {
    state.month = 11;
    state.year -= 1;
  }
  state.selectedDate = "";
  renderCalendar();
});
dom.calendarNext.addEventListener("click", () => {
  state.month += 1;
  if (state.month > 11) {
    state.month = 0;
    state.year += 1;
  }
  state.selectedDate = "";
  renderCalendar();
});
dom.calendar.addEventListener("click", (event) => {
  const day = event.target.closest("[data-calendar-date]");
  if (!day) return;
  state.selectedDate = state.selectedDate === day.dataset.calendarDate
    ? ""
    : day.dataset.calendarDate;
  renderCalendar();
});
document.addEventListener("click", (event) => {
  const retry = event.target.closest("[data-retry]");
  if (!retry) return;
  if (retry.dataset.retry === "events") subscribeEvents(state.uid);
  if (retry.dataset.retry === "notifications" && state.notificationRetry) state.notificationRetry();
});

document.getElementById("teacherLogout").addEventListener("click", () => {
  localStorage.removeItem("recovibeCurrentTeacher");
  localStorage.removeItem("recovibeTeacherId");
});

function onPageHide() {
  active = false;
  authGeneration += 1;
  authUnsubscribe?.();
  authUnsubscribe = null;
  stopEvents();
  clearTimeout(nextMinuteTimeout);
  clearInterval(minuteInterval);
}

function onPageShow(event) {
  if (!event.persisted) return;
  active = true;
  startAuthListener();
  scheduleMinuteUpdates();
}

function onStorageChange(event) {
  if (
    !event.key ||
    event.key === NOTIFICATION_KEY ||
    event.key === DELETED_KEY ||
    event.key === `${NOTIFICATION_KEY}:${state.uid}` ||
    event.key === `${DELETED_KEY}:${state.uid}`
  ) {
    renderNotifications();
  }
}

function scheduleMinuteUpdates() {
  clearTimeout(nextMinuteTimeout);
  clearInterval(minuteInterval);
  const delay = 60000 - (Date.now() % 60000);
  nextMinuteTimeout = setTimeout(() => {
    renderHeader();
    renderComingUp();
    renderNotifications();
    minuteInterval = setInterval(() => {
      renderHeader();
      renderComingUp();
      renderNotifications();
    }, 60000);
  }, delay);
}

window.addEventListener("pagehide", onPageHide);
window.addEventListener("pageshow", onPageShow);
window.addEventListener("storage", onStorageChange);
window.addEventListener("focus", renderNotifications);

updateSidebarProfile();
renderHeader();
renderComingUp();
renderCalendar();
renderNotifications();
startTeacherNotificationData(onNotificationData, { includeEvents: false });
startAuthListener();
scheduleMinuteUpdates();
