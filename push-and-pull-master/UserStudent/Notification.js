import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  collection,
  collectionGroup,
  deleteDoc,
  doc,
  getDoc,
  onSnapshot,
  query,
  updateDoc,
  where,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  onValue,
  ref as databaseRef,
  remove as removeRtdbValue,
  update as updateRtdbValue,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import { auth, authReady, db, isRtdbConfigured, rtdb } from "./firebaseConfig.js";
import { isEventVisibleToStudent } from "./eventAudience.js";
import {
  clearCachedStudentProfile,
  loadStudentProfile,
  renderStudentSidebar,
} from "./studentIdentity.js";

const DEBUG = false;
const TWO_WEEKS = 14 * 24 * 60 * 60 * 1000;
const ONE_DAY = 24 * 60 * 60 * 1000;
const TRASH_LIFETIME = 30 * ONE_DAY;
const STORAGE_PREFIX = "recovibeStudentNotifications:";
const notificationRoot = document.getElementById("notificationMain");

let currentUid = "";
let studentProfile = {};
let notificationItems = [];
let notificationsLoading = true;
let notificationError = "";
let activeFilter = "all";
let showingTrash = false;
let searchQuery = "";
let toastTimer = null;
let undoDelete = null;
let statusMessage = "";
let pendingNotificationWrites = new Set();
let state = { read: {}, deleted: {}, restored: {}, purged: {} };
let unsubscribeAuth = null;
let unsubscribeFirestore = [];
let unsubscribeEvents = null;
let unsubscribeRegistrations = null;
let unsubscribeRtdb = null;
let rtdbRef = null;
let derivedRefreshInterval = null;
let subscriptionVersion = 0;
let firestoreReady = new Set();
let sourceErrors = new Map();
let eventDocuments = new Map();
let registrationDocuments = new Map();
let firestoreNotifications = new Map();
let rtdbNotifications = new Map();
let detailEventLoads = new Set();
let publishedEventsTimeout = null;
let initialLoadPending = new Set();
let pageLoadSignaled = false;

function settleInitialLoadSource(source) {
  initialLoadPending.delete(source);
  if (!pageLoadSignaled && initialLoadPending.size === 0) {
    pageLoadSignaled = true;
    window.dispatchEvent(new Event("page-data-ready"));
  }
}

function debug(...args) {
  if (DEBUG) console.debug("[Student Notifications]", ...args);
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

function toMillis(value) {
  if (value && typeof value.toMillis === "function") return value.toMillis();
  if (value && typeof value.toDate === "function") return value.toDate().getTime();
  if (value && typeof value.seconds === "number") return value.seconds * 1000;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const dateOnly = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (dateOnly) {
      return new Date(
        Number(dateOnly[1]),
        Number(dateOnly[2]) - 1,
        Number(dateOnly[3]),
      ).getTime();
    }
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function formatRelativeTime(timestamp) {
  if (!timestamp) return "";
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return "";
  const difference = Math.max(0, Date.now() - timestamp);
  if (difference < 60000) return "Just now";
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  if (difference < 60 * 60000) return `${Math.floor(difference / 60000)} minutes ago`;
  if (difference < ONE_DAY) return `${Math.floor(difference / 3600000)} hours ago`;
  if (difference < 7 * ONE_DAY) return `${Math.floor(difference / ONE_DAY)} days ago`;
  const days = Math.floor(difference / ONE_DAY);
  if (days < 30) return `${Math.floor(days / 7)} weeks ago`;
  return `${Math.floor(days / 30)} months ago`;
}

function notificationDate(timestamp) {
  const date = new Date(timestamp);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(date)
    : "";
}

function notificationWeekStart(date) {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  start.setDate(start.getDate() - start.getDay());
  return start;
}

function notificationGroup(item) {
  const date = new Date(item.createdAtMillis);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return "Today";
  if (date >= notificationWeekStart(now)) return "This week";
  return "Earlier";
}

function readState(uid) {
  try {
    const parsed = JSON.parse(localStorage.getItem(`${STORAGE_PREFIX}${uid}`) || "{}");
    const savedRead = parsed?.read && typeof parsed.read === "object" ? parsed.read : {};
    const savedDeleted = parsed?.deleted && typeof parsed.deleted === "object"
      ? parsed.deleted
      : {};
    const savedRestored = parsed?.restored && typeof parsed.restored === "object"
      ? parsed.restored
      : {};
    const cutoff = Date.now() - TRASH_LIFETIME;
    const deleted = Object.fromEntries(
      Object.entries(savedDeleted).filter(([, value]) =>
        toMillis(value?.deletedAt ?? value) >= cutoff,
      ),
    );
    const savedPurged = parsed?.purged && typeof parsed.purged === "object"
      ? parsed.purged
      : {};
    state = { read: savedRead, deleted, restored: savedRestored, purged: savedPurged };
    if (Object.keys(deleted).length !== Object.keys(savedDeleted).length) saveState();
  } catch (error) {
    debug("Could not read notification state:", error);
    state = { read: {}, deleted: {}, restored: {}, purged: {} };
  }
}

async function emptyTrash() {
  const items = notificationItems.filter((item) => item.deletedAt);
  const ids = new Set(items.map((item) => item.id));
  pendingNotificationWrites = new Set([...pendingNotificationWrites, ...ids]);
  renderNotifications();
  const results = await Promise.all(items.map(async (item) => {
    try {
      if (item.source === "firestore") await deleteDoc(doc(db, "notifications", item.id));
      if (item.source === "rtdb") {
        await removeRtdbValue(databaseRef(rtdb, `notifications/${currentUid}/${item.id}`));
      }
      state.purged[item.id] = true;
      delete state.deleted[item.id];
      delete state.restored[item.id];
      delete state.read[item.id];
      return true;
    } catch (error) {
      console.error("[Student Notifications] Could not permanently delete notification:", error);
      return false;
    } finally {
      pendingNotificationWrites.delete(item.id);
    }
  }));
  saveState();
  if (results.some((result) => !result)) {
    notificationError = "Some deleted notifications could not be removed. Please try again.";
  }
  renderNotifications();
}

function saveState() {
  if (!currentUid) return;
  try {
    localStorage.setItem(`${STORAGE_PREFIX}${currentUid}`, JSON.stringify(state));
  } catch (error) {
    debug("Could not save notification state:", error);
  }
}

function normalizedType(value, data = {}) {
  const type = `${value || ""} ${data.title || ""} ${data.status || ""} ${data.action || ""}`
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
  if (type.includes("publish") || type.includes("newevent")) return "published";
  if (type.includes("register") || type.includes("participat")) return "registered";
  if (type.includes("reminder") || type.includes("upcoming")) return "reminder";
  if (type.includes("cancel")) return "cancelled";
  if (type.includes("resched")) return "rescheduled";
  if (type.includes("approv")) return "approved";
  if (type.includes("reject") || type.includes("denied")) return "rejected";
  return "default";
}

function normalizeItem(id, data, source) {
  const createdAt = toMillis(data.createdAt ?? data.createdAtMillis);
  const readOverride = Object.prototype.hasOwnProperty.call(state.read, id)
    ? state.read[id]
    : undefined;
  return {
    ...data,
    id: String(id),
    eventId: String(data.eventId || ""),
    title: String(data.title || data.eventTitle || data.eventName || "Notification"),
    message: String(data.message || data.body || ""),
    type: normalizedType(data.type, data),
    createdAtMillis: createdAt,
    read: readOverride === undefined
      ? data.read === true || data.isRead === true
      : readOverride === true,
    source,
    deletedAt: toMillis(state.deleted[id]?.deletedAt ?? state.deleted[id]),
  };
}

function eventStatus(event) {
  return String(event?.status || event?.publicationStatus || "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
}

function eventTitle(event) {
  return String(event?.title || event?.name || event?.eventName || "Untitled event");
}

function eventStartMillis(event) {
  const rawStart = event.startAt ?? event.start_at;
  if (typeof rawStart === "string" && /^\d{4}-\d{2}-\d{2}$/.test(rawStart)) {
    return Date.parse(`${rawStart}T00:00:00+08:00`) || 0;
  }
  if (typeof rawStart === "string" && /^\d{4}-\d{2}-\d{2}[T ]\d{1,2}:\d{2}/.test(rawStart)) {
    if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(rawStart)) {
      return Date.parse(`${rawStart.replace(" ", "T")}+08:00`) || 0;
    }
  }
  const direct = toMillis(rawStart);
  if (direct) return direct;
  const fullDateTime = String(event.startDateTime || event.start_date_time || "").trim();
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{1,2}:\d{2}/.test(fullDateTime)) {
    return Date.parse(
      `${fullDateTime.replace(" ", "T")}${/(?:Z|[+-]\d{2}:?\d{2})$/i.test(fullDateTime) ? "" : "+08:00"}`,
    ) || 0;
  }
  const dateValue = event.dateISO || event.date || event.startDate || "";
  const date = String(dateValue).slice(0, 10);
  const time = String(event.startTime || event.schedule?.startTime || event.time || "")
    .split(/\s*[-–—]\s*/)[0]
    .trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return 0;
  const match = /^(\d{1,2}):(\d{2})(?:\s*(AM|PM))?$/i.exec(time);
  if (!match) return Date.parse(`${date}T00:00:00+08:00`) || 0;
  let hour = Number(match[1]);
  if (match[3]) {
    hour %= 12;
    if (match[3].toUpperCase() === "PM") hour += 12;
  }
  return Date.parse(`${date}T${String(hour).padStart(2, "0")}:${match[2]}:00+08:00`) || 0;
}

function manilaDate(timestamp) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(timestamp));
}

function deterministicId(type, eventId, timestamp) {
  return `${type}-${eventId}-${timestamp}`;
}

function derivedItems() {
  const now = Date.now();
  const derived = [];
  eventDocuments.forEach((event, eventId) => {
    const status = eventStatus(event);
    const published =
      status === "published" || event.published === true || event.isPublished === true;
    const publishedAt = toMillis(event.publishedAt) ||
      toMillis(event.updatedAt) ||
      toMillis(event.createdAt);
    if (
      published &&
      publishedAt &&
      publishedAt <= now &&
      now - publishedAt <= TWO_WEEKS &&
      isEventVisibleToStudent({ ...event, id: eventId }, studentProfile)
    ) {
      const title = eventTitle(event);
      derived.push({
        id: deterministicId("published", eventId, publishedAt),
        eventId,
        type: "published",
        title: `New event: ${title}`,
        message: String(event.description || event.summary || "A new event is available."),
        createdAtMillis: publishedAt,
        read: false,
        source: "derived",
      });
    }
  });

  registrationDocuments.forEach((registration, eventId) => {
    const registrationStatus = String(registration.status || registration.registrationStatus || "registered")
      .trim()
      .toLowerCase()
      .replace(/[\s_-]+/g, "");
    if (
      ["cancelled", "canceled", "withdrawn", "unregistered"].includes(registrationStatus) ||
      registration.cancelledAt
    ) return;
    const event = eventDocuments.get(eventId);
    if (!event) return;
    const title = eventTitle(event);
    const registeredAt = toMillis(registration.registeredAt);
    derived.push({
      id: deterministicId("registered", eventId, registeredAt),
      eventId,
      type: "registered",
      title: `You're registered for ${title}`,
      message: "Your registration is confirmed.",
      createdAtMillis: registeredAt,
      read: false,
      source: "derived",
      target: "participation",
    });
    const startAt = eventStartMillis(event);
    if (startAt > now && startAt - now <= ONE_DAY) {
      const tomorrow = new Date(now + ONE_DAY);
      const isTomorrow = manilaDate(startAt) === manilaDate(tomorrow.getTime());
      const hours = Math.max(1, Math.ceil((startAt - now) / (60 * 60 * 1000)));
      derived.push({
        id: deterministicId("reminder", eventId, startAt),
        eventId,
        type: "reminder",
        title: isTomorrow ? `${title} starts tomorrow` : `${title} starts in ${hours} ${hours === 1 ? "hour" : "hours"}`,
        message: "Your registered event is coming up.",
        createdAtMillis: now,
        read: false,
        source: "derived",
        target: "participation",
      });
    }
    const status = eventStatus(event);
    if (["cancelled", "canceled"].includes(status) || status === "rescheduled") {
      const updatedAt = toMillis(event.updatedAt);
      if (!updatedAt) return;
      const type = status === "rescheduled" ? "rescheduled" : "cancelled";
      derived.push({
        id: deterministicId(type, eventId, updatedAt),
        eventId,
        type,
        title: status === "rescheduled" ? `${title} was rescheduled` : `${title} was cancelled`,
        message: status === "rescheduled"
          ? "The event schedule has changed."
          : "The organizer cancelled this event.",
        createdAtMillis: updatedAt,
        read: false,
        source: "derived",
        target: "participation",
      });
    }
  });
  return derived;
}

function mergedItems() {
  const merged = new Map();
  firestoreNotifications.forEach((item, id) => merged.set(id, normalizeItem(id, item, "firestore")));
  rtdbNotifications.forEach((item, id) => {
    if (!merged.has(id)) merged.set(id, normalizeItem(id, item, "rtdb"));
  });
  derivedItems().forEach((item) => {
    if (!merged.has(item.id)) {
      merged.set(item.id, normalizeItem(item.id, item, "derived"));
    }
  });
  Object.entries(state.restored).forEach(([id, item]) => {
    if (!merged.has(id)) merged.set(id, normalizeItem(id, item, item.source || "derived"));
  });
  Object.entries(state.deleted).forEach(([id, value]) => {
    if (!merged.has(id) && value?.item) {
      merged.set(id, normalizeItem(id, value.item, value.item.source || "derived"));
    }
  });
  return [...merged.values()]
    .filter((item) => !state.purged?.[item.id])
    .sort((a, b) => b.createdAtMillis - a.createdAtMillis);
}

function updateBadge() {
  const badge = document.getElementById("navNotifBadge");
  if (!badge) return;
  const unreadCount = notificationItems.filter((item) => !item.read && !item.deletedAt).length;
  badge.textContent = unreadCount > 9 ? "9+" : unreadCount ? String(unreadCount) : "";
  badge.hidden = unreadCount === 0;
}

function iconForType(type) {
  const icons = {
    published: '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="3" y="4" width="14" height="13" rx="1.5"/><path d="M3 8h14M7 2.5v3M13 2.5v3"/></svg>',
    registered: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m4 10 4 4 8-8"/></svg>',
    reminder: "◷",
    cancelled: "×",
    rescheduled: "↻",
    approved: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m4 10 4 4 8-8"/></svg>',
    rejected: "!",
    default: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M16 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M8 20a2 2 0 0 0 4 0"/></svg>',
  };
  return icons[type] || icons.default;
}

function renderRow(item, inTrash = false) {
  const relativeTime = formatRelativeTime(item.createdAtMillis);
  const date = notificationDate(item.createdAtMillis);
  const typeLabel = {
    published: "New event",
    registered: "Registered",
    reminder: "Reminder",
    cancelled: "Cancelled",
    rescheduled: "Rescheduled",
    approved: "Approved",
    rejected: "Rejected",
  }[item.type] || item.tag || "";
  const controls = inTrash
    ? `<button type="button" data-action="restore" data-id="${escapeHTML(item.id)}" ${pendingNotificationWrites.has(item.id) ? "disabled" : ""}>Restore</button><button type="button" data-action="delete-forever" data-id="${escapeHTML(item.id)}" ${pendingNotificationWrites.has(item.id) ? "disabled" : ""}>Delete forever</button><small>Removed in ${Math.max(0, Math.ceil((item.deletedAt + TRASH_LIFETIME - Date.now()) / ONE_DAY))} days</small>`
    : `<button class="notification-read-toggle" type="button" data-action="${item.read ? "unread" : "read"}" data-id="${escapeHTML(item.id)}" aria-label="Mark as ${item.read ? "unread" : "read"}" title="Mark as ${item.read ? "unread" : "read"}" ${pendingNotificationWrites.has(item.id) ? "disabled" : ""}><span aria-hidden="true"></span></button><button class="notification-trash-toggle" type="button" data-action="delete" data-id="${escapeHTML(item.id)}" aria-label="Move to Recently Deleted" title="Move to Recently Deleted" ${pendingNotificationWrites.has(item.id) ? "disabled" : ""}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 6h12M8 6V4.5h4V6m-6.5 0 .7 10h7.6l.7-10M8.5 9v4m3-4v4" /></svg></button>`;
  return `<li class="notification-card-item"><article class="notification-row${item.read ? "" : " is-unread"}" data-notification-id="${escapeHTML(item.id)}" tabindex="0" aria-label="${escapeHTML(item.title)}, ${item.read ? "read" : "unread"}">
    <span class="notification-icon type-${escapeHTML(item.type)}" aria-hidden="true">${iconForType(item.type)}</span>
    <span class="notification-copy"><strong class="notification-title">${escapeHTML(item.title)}</strong><span class="notification-message">${escapeHTML(item.message)}</span>
      <span class="notification-meta">${typeLabel ? `<span class="notification-tag">${escapeHTML(typeLabel)}</span>` : ""}${date ? `<time>${escapeHTML(date)}</time>` : ""}${relativeTime ? `<span>${escapeHTML(relativeTime)}</span>` : ""}</span>
      ${inTrash ? `<span class="notification-trash-actions">${controls}</span>` : ""}
    </span>
    ${inTrash ? "" : `<span class="notification-card-actions">${controls}</span>`}
  </article></li>`;
}

function renderNotifications() {
  if (!notificationRoot) return;
  notificationItems = mergedItems();
  updateBadge();
  const activeItems = notificationItems.filter((item) => !item.deletedAt);
  const trashItems = notificationItems.filter((item) => item.deletedAt && Date.now() - item.deletedAt <= TRASH_LIFETIME);
  const unreadCount = activeItems.filter((item) => !item.read).length;
  const search = searchQuery.trim().toLowerCase();
  const visible = (showingTrash ? trashItems : activeItems).filter((item) =>
    (!search || `${item.title} ${item.message}`.toLowerCase().includes(search)) &&
    (showingTrash || activeFilter === "all" ||
      (activeFilter === "unread" ? !item.read : item.read)),
  );
  const groups = ["Today", "This week", "Earlier"].map((name) => [
    name,
    visible.filter((item) => notificationGroup(item) === name),
  ]);
  const emptyTitle = showingTrash
    ? "Recently Deleted is empty"
    : activeFilter === "unread"
      ? "No unread notifications"
      : activeFilter === "read"
        ? "You have no notifications"
        : "You have no notifications";
  const emptyMessage = showingTrash
    ? "Notifications you delete will wait here for 30 days before they are removed."
    : activeFilter === "unread"
      ? "Everything has been read. Nice work."
      : "New notifications will show up here.";
  let content = "";
  if (notificationsLoading && !notificationItems.length) {
    content = "";
  } else if (notificationError && !notificationItems.length) {
    content = `<div class="notification-state" role="alert"><strong>Notifications couldn’t be loaded.</strong><p>${escapeHTML(notificationError)}</p><button type="button" class="notification-retry">Retry</button></div>`;
  } else if (!visible.length) {
    content = `<div class="notification-state"><span class="notification-state-icon" aria-hidden="true">${iconForType("default")}</span><strong>${emptyTitle}</strong><p>${emptyMessage}</p>${notificationError ? `<button type="button" class="notification-retry">Try again</button>` : ""}</div>`;
  } else {
    content = groups.filter(([, items]) => items.length).map(([name, items]) =>
      `<section class="notification-group"><h2>${name.toUpperCase()}</h2><ul class="notification-list">${items.map((item) => renderRow(item, showingTrash)).join("")}</ul></section>`,
    ).join("");
  }
  notificationRoot.innerHTML = `<section class="student-notifications" aria-labelledby="studentNotificationsTitle">
    <header class="notifications-header">
      <div><h1 id="studentNotificationsTitle">Notifications</h1>${notificationError ? `<p class="notification-source-warning">${escapeHTML(notificationError)} <button type="button" class="notification-retry-inline">Retry</button></p>` : ""}</div>
    </header>
    <div class="notification-toolbar">
      <div class="notification-toolbar-left">
        <nav class="notification-tabs" aria-label="Notification filter">
          <button type="button" data-filter="all" aria-pressed="${!showingTrash && activeFilter !== "unread"}" class="${!showingTrash && activeFilter !== "unread" ? "is-active" : ""}">All</button>
          <button type="button" data-filter="unread" aria-pressed="${!showingTrash && activeFilter === "unread"}" class="${!showingTrash && activeFilter === "unread" ? "is-active" : ""}">Unread <span>${unreadCount}</span></button>
        </nav>
        <label class="notification-read-filter">Show <select data-read-filter aria-label="Filter read notifications">${activeFilter === "read" ? '<option value="all">All</option><option value="read" selected>Read</option>' : '<option value="all" selected>All</option><option value="read">Read</option>'}</select></label>
      </div>
      <div class="notification-toolbar-actions">
        ${showingTrash ? `<button type="button" class="notification-empty-trash" ${trashItems.length ? "" : "disabled"}>Empty trash</button>` : `<button type="button" class="mark-all-read" ${unreadCount ? "" : "disabled"}>Mark all as read</button>`}
        <button type="button" class="notification-trash-button${showingTrash ? " is-active" : ""}" data-view-trash aria-label="${showingTrash ? "Return to notifications" : "Open Recently Deleted"}" title="${showingTrash ? "Return to notifications" : "Recently Deleted"}"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 6h12M8 6V4.5h4V6m-6.5 0 .7 10h7.6l.7-10M8.5 9v4m3-4v4" /></svg></button>
      </div>
    </div>
    ${showingTrash ? '<p class="notification-trash-info"><span aria-hidden="true">i</span> Deleted notifications stay here for 30 days, then they are removed for good.</p>' : ""}
    ${searchQuery ? "" : ""}
    <label class="notification-search"><span class="visually-hidden">Search notifications</span><input type="search" data-search value="${escapeHTML(searchQuery)}" placeholder="Search notifications" aria-label="Search notifications"></label>
    <div class="notification-feed" aria-live="polite">${content}</div>
    <div class="notification-toast" role="status" aria-live="polite">${undoDelete ? 'Moved to Recently Deleted <button type="button" data-action="undo-delete">Undo</button>' : escapeHTML(statusMessage)}</div>
  </section>`;
  const searchInput = notificationRoot.querySelector("[data-search]");
  searchInput.addEventListener("input", (event) => {
    searchQuery = event.target.value;
    const position = event.target.selectionStart;
    renderNotifications();
    const updatedSearch = notificationRoot.querySelector("[data-search]");
    updatedSearch.focus();
    updatedSearch.setSelectionRange(position, position);
  });
}

async function persistRead(item, read) {
  const previousRead = state.read[item.id];
  state.read[item.id] = Boolean(read);
  saveState();
  if (item.source === "firestore" || item.source === "rtdb") {
    pendingNotificationWrites.add(item.id);
    renderNotifications();
    try {
      if (item.source === "firestore") await markFirestoreRead(item.id, read);
      else {
        await updateRtdbValue(
          databaseRef(rtdb, `notifications/${currentUid}/${item.id}`),
          { read: Boolean(read) },
        );
      }
    } catch (error) {
      if (previousRead === undefined) delete state.read[item.id];
      else state.read[item.id] = previousRead;
      notificationError = "Could not update this notification. Please try again.";
      console.error("[Student Notifications] Could not update notification read state:", error);
      return false;
    } finally {
      pendingNotificationWrites.delete(item.id);
      saveState();
    }
  }
  renderNotifications();
  return true;
}

async function markFirestoreRead(id, read = true) {
  await updateDoc(doc(db, "notifications", id), { read });
}

async function deleteForever(item) {
  if (!window.confirm("Permanently delete this notification? This cannot be undone.")) return;
  pendingNotificationWrites.add(item.id);
  renderNotifications();
  try {
    if (item.source === "firestore") await deleteDoc(doc(db, "notifications", item.id));
    if (item.source === "rtdb") {
      await removeRtdbValue(databaseRef(rtdb, `notifications/${currentUid}/${item.id}`));
    }
    state.purged[item.id] = true;
    delete state.deleted[item.id];
    delete state.restored[item.id];
    delete state.read[item.id];
    saveState();
  } catch (error) {
    notificationError = "Could not permanently delete this notification. Please try again.";
    console.error("[Student Notifications] Could not permanently delete notification:", error);
  } finally {
    pendingNotificationWrites.delete(item.id);
    renderNotifications();
  }
}

function handleItemAction(action, id) {
  const item = notificationItems.find((candidate) => candidate.id === id);
  if (!item) return;
  if (action === "read" || action === "unread") {
    void persistRead(item, action === "read");
  } else if (action === "delete") {
    delete state.restored[id];
    state.deleted[id] = {
      deletedAt: Date.now(),
      item: {
        id: item.id,
        eventId: item.eventId,
        type: item.type,
        title: item.title,
        message: item.message,
        createdAt: item.createdAtMillis,
        read: item.read,
        source: item.source,
        target: item.target || "",
      },
    };
    saveState();
    undoDelete = id;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      undoDelete = null;
      renderNotifications();
    }, 6000);
    renderNotifications();
  } else if (action === "restore") {
    const savedItem = state.deleted[id]?.item;
    if (savedItem) state.restored[id] = savedItem;
    delete state.deleted[id];
    saveState();
    renderNotifications();
  } else if (action === "delete-forever") {
    void deleteForever(item);
  }
}

function openItem(item) {
  if (!item) return;
  if (!item.read) persistRead(item, true);
  if (!item.eventId) return;
  const target = item.target === "participation" || item.type === "registered" || item.type === "reminder"
    ? "Student-Participation.html"
    : "Events.html";
  window.location.assign(`${target}?eventId=${encodeURIComponent(item.eventId)}`);
}

function bindPageInteractions() {
  notificationRoot?.addEventListener("click", (event) => {
    const target = event.target;
    const filterButton = target.closest("[data-filter]");
    if (filterButton) {
      activeFilter = filterButton.dataset.filter;
      renderNotifications();
      return;
    }
    if (target.closest("[data-view-trash]")) {
      showingTrash = !showingTrash;
      renderNotifications();
      return;
    }
    if (target.closest(".notification-empty-trash")) {
      const count = notificationItems.filter((item) => item.deletedAt).length;
      if (!count || !window.confirm(`Permanently delete all ${count} notifications? This cannot be undone.`)) return;
      void emptyTrash();
      return;
    }
    if (target.closest(".mark-all-read")) {
      const unread = notificationItems.filter((item) => !item.read && !item.deletedAt);
      if (unread.length) {
        void Promise.all(unread.map((item) => persistRead(item, true))).then((results) => {
          statusMessage = results.every(Boolean)
            ? "All notifications marked as read."
            : "Some notifications could not be updated.";
          renderNotifications();
          window.setTimeout(() => {
            statusMessage = "";
            renderNotifications();
          }, 3000);
        });
      }
      return;
    }
    if (target.closest("[data-action='undo-delete']")) {
      event.stopPropagation();
      if (undoDelete && state.deleted[undoDelete]) {
        state.restored[undoDelete] = state.deleted[undoDelete].item;
        delete state.deleted[undoDelete];
        saveState();
      }
      undoDelete = null;
      clearTimeout(toastTimer);
      renderNotifications();
      return;
    }
    if (target.closest(".notification-retry")) {
      restartSubscriptions();
      return;
    }
    if (target.closest(".notification-retry-inline")) {
      restartSubscriptions();
      return;
    }
    const menuToggle = target.closest(".notification-menu-toggle");
    if (menuToggle) {
      const row = menuToggle.closest(".notification-row");
      const menu = row.querySelector(".notification-menu");
      const open = !menu.hidden;
      notificationRoot.querySelectorAll(".notification-menu").forEach((entry) => {
        entry.hidden = true;
      });
      notificationRoot.querySelectorAll(".notification-menu-toggle").forEach((button) => {
        button.setAttribute("aria-expanded", "false");
      });
      menu.hidden = open;
      menuToggle.setAttribute("aria-expanded", String(!open));
      event.stopPropagation();
      return;
    }
    const action = target.closest("[data-action]");
    if (action) {
      event.stopPropagation();
      handleItemAction(action.dataset.action, action.dataset.id);
      return;
    }
    const row = target.closest("[data-notification-id]");
    if (row && !showingTrash)
      openItem(notificationItems.find((item) => item.id === row.dataset.notificationId));
  });
  notificationRoot?.addEventListener("keydown", (event) => {
    if ((event.key === "Enter" || event.key === " ") && event.target.matches(".notification-row")) {
      event.preventDefault();
      openItem(notificationItems.find((item) => item.id === event.target.dataset.notificationId));
    }
  });
  notificationRoot?.addEventListener("change", (event) => {
    if (!event.target.matches("[data-read-filter]")) return;
    activeFilter = event.target.value === "read" ? "read" : "all";
    renderNotifications();
  });
}

function stopSubscriptions() {
  unsubscribeFirestore.forEach((unsubscribe) => unsubscribe());
  unsubscribeFirestore = [];
  if (publishedEventsTimeout) {
    clearTimeout(publishedEventsTimeout);
    publishedEventsTimeout = null;
  }
  unsubscribeEvents?.();
  unsubscribeEvents = null;
  unsubscribeRegistrations?.();
  unsubscribeRegistrations = null;
  unsubscribeRtdb?.();
  unsubscribeRtdb = null;
  if (derivedRefreshInterval) {
    clearInterval(derivedRefreshInterval);
    derivedRefreshInterval = null;
  }
  rtdbRef = null;
  firestoreReady = new Set();
  sourceErrors.clear();
  eventDocuments.clear();
  registrationDocuments.clear();
  firestoreNotifications.clear();
  rtdbNotifications.clear();
  detailEventLoads.clear();
  initialLoadPending.clear();
}

function syncItems(version) {
  if (version !== subscriptionVersion) return;
  notificationItems = mergedItems();
  const everyFirestoreQuerySettled = firestoreReady.size === 2;
  notificationsLoading = !everyFirestoreQuerySettled && !eventDocuments.size &&
    !registrationDocuments.size && !sourceErrors.has("published-events");
  notificationError = [...sourceErrors.values()].join(" ");
  renderNotifications();
}

function subscribeToFirestoreNotifications(uid, version) {
  const queryResults = new Map([["userId", new Map()], ["recipientUid", new Map()]]);
  const queryFields = ["userId", "recipientUid"];
  queryFields.forEach((field) => {
    const unsubscribe = onSnapshot(
      query(collection(db, "notifications"), where(field, "==", uid)),
      (snapshot) => {
        if (version !== subscriptionVersion || currentUid !== uid) return;
        const values = queryResults.get(field);
        values.clear();
        snapshot.docs.forEach((item) => values.set(item.id, item.data()));
        firestoreNotifications.clear();
        queryResults.forEach((items) => items.forEach((data, id) => firestoreNotifications.set(id, data)));
        firestoreReady.add(field);
        sourceErrors.delete(`notification-${field}`);
        syncItems(version);
        settleInitialLoadSource(`notification-${field}`);
      },
      (error) => {
        if (version !== subscriptionVersion || currentUid !== uid) return;
        firestoreReady.add(field);
        sourceErrors.set(
          `notification-${field}`,
          error?.code === "permission-denied"
            ? `The ${field} notification source is unavailable.`
            : "A notification source could not be loaded.",
        );
        debug(`Firestore notification query (${field}) failed:`, error);
        syncItems(version);
        settleInitialLoadSource(`notification-${field}`);
      },
    );
    unsubscribeFirestore.push(unsubscribe);
  });
}

function loadMissingRegistrationEvents(version) {
  registrationDocuments.forEach((registration, eventId) => {
    if (
      eventDocuments.has(eventId) ||
      detailEventLoads.has(eventId) ||
      version !== subscriptionVersion
    ) return;
    detailEventLoads.add(eventId);
    getDoc(doc(db, "events", eventId)).then((snapshot) => {
      if (version !== subscriptionVersion || !snapshot.exists()) return;
      eventDocuments.set(eventId, snapshot.data());
      syncItems(version);
    }).catch((error) => {
      debug("Could not join registration to event:", eventId, error);
    });
  });
}

function subscribeToDerivedSources(uid, version) {
  publishedEventsTimeout = setTimeout(() => {
    if (version !== subscriptionVersion || eventDocuments.size || sourceErrors.has("published-events")) return;
    sourceErrors.set("published-events", "Published event notifications are temporarily unavailable.");
    syncItems(version);
    settleInitialLoadSource("published-events");
  }, 8000);
  unsubscribeEvents = onSnapshot(
    collection(db, "events"),
    (snapshot) => {
      if (version !== subscriptionVersion || currentUid !== uid) return;
      clearTimeout(publishedEventsTimeout);
      publishedEventsTimeout = null;
      eventDocuments = new Map(snapshot.docs.map((item) => [item.id, item.data()]));
      sourceErrors.delete("published-events");
      syncItems(version);
      settleInitialLoadSource("published-events");
    },
    (error) => {
      if (version !== subscriptionVersion) return;
      clearTimeout(publishedEventsTimeout);
      publishedEventsTimeout = null;
      debug("Published event listener failed:", error);
      sourceErrors.set("published-events", "Published event notifications are temporarily unavailable.");
      syncItems(version);
      settleInitialLoadSource("published-events");
    },
  );
  unsubscribeRegistrations = onSnapshot(
    query(collectionGroup(db, "registrations"), where("uid", "==", uid)),
    (snapshot) => {
      if (version !== subscriptionVersion || currentUid !== uid) return;
      registrationDocuments.clear();
      snapshot.docs.forEach((item) => {
        const eventId = item.ref.parent.parent?.id;
        if (eventId) registrationDocuments.set(eventId, item.data());
      });
      sourceErrors.delete("registrations");
      loadMissingRegistrationEvents(version);
      syncItems(version);
      settleInitialLoadSource("registrations");
    },
    (error) => {
      if (version !== subscriptionVersion) return;
      debug("Student registration listener failed:", error);
      sourceErrors.set("registrations", "Registration-based notifications are temporarily unavailable.");
      syncItems(version);
      settleInitialLoadSource("registrations");
    },
  );
}

function subscribeToRtdb(uid, version) {
  if (!isRtdbConfigured || !rtdb) return;
  try {
    rtdbRef = databaseRef(rtdb, `notifications/${uid}`);
    unsubscribeRtdb = onValue(
      rtdbRef,
      (snapshot) => {
        if (version !== subscriptionVersion || currentUid !== uid) return;
        rtdbNotifications.clear();
        Object.entries(snapshot.val() || {}).forEach(([id, data]) => {
          if (data && typeof data === "object") rtdbNotifications.set(id, data);
        });
        syncItems(version);
        settleInitialLoadSource("rtdb");
      },
      (error) => {
        debug("Realtime Database notification listener failed:", error);
        settleInitialLoadSource("rtdb");
      },
    );
  } catch (error) {
    debug("Could not subscribe to Realtime Database notifications:", error);
    rtdbRef = null;
    unsubscribeRtdb = null;
  }
}

function startSubscriptions(uid, includeDerivedSources = true) {
  stopSubscriptions();
  const version = ++subscriptionVersion;
  pageLoadSignaled = false;
  initialLoadPending = new Set([
    "profile",
    "notification-userId",
    "notification-recipientUid",
  ]);
  notificationsLoading = true;
  notificationError = "";
  renderNotifications();
  if (!db) {
    notificationsLoading = false;
    notificationError = "Notifications are unavailable because Firebase is not configured.";
    renderNotifications();
    initialLoadPending.clear();
    settleInitialLoadSource("unavailable");
    return null;
  }
  subscribeToFirestoreNotifications(uid, version);
  if (includeDerivedSources) subscribeToDerivedSources(uid, version);
  subscribeToRtdb(uid, version);
  derivedRefreshInterval = setInterval(() => syncItems(version), 60000);
  return version;
}

function restartSubscriptions() {
  if (currentUid) startSubscriptions(currentUid);
}

async function initializeStudent(user) {
  if (!user?.uid) return;
  currentUid = user.uid;
  readState(currentUid);
  try {
    const cachedProfile = JSON.parse(
      localStorage.getItem("recovibeCurrentUser") ||
      sessionStorage.getItem("recovibeCurrentUser") ||
      "null",
    );
    if (
      cachedProfile &&
      user.email &&
      String(cachedProfile.email || "").trim().toLowerCase() ===
        String(user.email || "").trim().toLowerCase()
    ) {
      studentProfile = cachedProfile;
      renderStudentSidebar(studentProfile);
    }
  } catch (error) {
    debug("Could not read cached student profile:", error);
  }
  const version = startSubscriptions(currentUid, false);
  try {
    studentProfile = await loadStudentProfile(user);
    renderStudentSidebar(studentProfile);
  } catch (error) {
    debug("Could not load student profile for event visibility:", error);
    studentProfile = {};
  }
  if (auth?.currentUser?.uid !== user.uid) return;
  if (version !== null) {
    subscribeToDerivedSources(currentUid, version);
    settleInitialLoadSource("profile");
  }
}

function initializePage() {
  if (!notificationRoot) return;
  notificationRoot.innerHTML = "";
  document.querySelectorAll(".nav-item").forEach((item) => {
    const label = item.querySelector(".nav-label");
    if (label) item.title = label.textContent.trim();
  });
  try {
    localStorage.removeItem("sidebarCollapsed");
    document.getElementById("sidebar")?.classList.remove("is-collapsed");
  } catch (error) {
    debug("Could not initialize sidebar state:", error);
  }
  document.querySelector(".nav-item.logout")?.addEventListener("click", clearCachedStudentProfile);
  bindPageInteractions();
  renderNotifications();
  if (!auth) {
    notificationsLoading = false;
    notificationError = "Sign in to view your notifications.";
    renderNotifications();
    window.dispatchEvent(new Event("page-data-ready"));
    return;
  }
  authReady.then(() => {
    unsubscribeAuth = onAuthStateChanged(auth, (user) => {
      stopSubscriptions();
      if (!user) {
        currentUid = "";
        notificationItems = [];
        notificationsLoading = false;
        notificationError = "Sign in to view your notifications.";
        renderNotifications();
        initialLoadPending.clear();
        settleInitialLoadSource("unauthenticated");
        return;
      }
      initializeStudent(user);
    });
  }).catch((error) => {
    debug("Could not initialize authenticated notifications:", error);
    notificationsLoading = false;
    notificationError = "Notifications could not be initialized. Please retry.";
    renderNotifications();
    window.dispatchEvent(new Event("page-data-ready"));
  });
  window.addEventListener("pagehide", () => {
    stopSubscriptions();
    unsubscribeAuth?.();
    unsubscribeAuth = null;
  }, { once: true });
}

initializePage();
