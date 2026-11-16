import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  collection,
  doc,
  limit,
  onSnapshot,
  query,
  updateDoc,
  where,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  onValue,
  ref as databaseRef,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import {
  auth,
  authReady,
  db,
  isFirebaseConfigured,
  isRtdbConfigured,
  rtdb,
} from "../UserStudent/firebaseConfig.js";
import { teacherEventReadFilters, teacherEventsQuery } from "./TeacherEventQuery.js";

const DEBUG = false;
const TWO_WEEKS = 14 * 24 * 60 * 60 * 1000;
const ONE_DAY = 24 * 60 * 60 * 1000;
const EVENT_LIMIT = 500;

let onChange = () => {};
let currentUid = "";
let isAuthenticated = false;
let authUnsubscribe = null;
let firestoreUnsubscribes = [];
let eventsUnsubscribe = null;
let rtdbUnsubscribe = null;
let refreshTimer = null;
let loadingTimer = null;
let subscriptionVersion = 0;
let hasSettledSource = false;
let timedOut = false;
let sourceStates = new Map();
let sourceErrors = new Map();
let eventDocuments = new Map();
let includeEventsSource = true;
let firestoreQueries = new Map();
let firestoreNotifications = new Map();
let rtdbNotifications = new Map();

function debug(...args) {
  if (DEBUG) console.debug("[Teacher Notifications]", ...args);
}

function toMillis(value) {
  if (value && typeof value.toMillis === "function") return value.toMillis();
  if (value && typeof value.toDate === "function") return value.toDate().getTime();
  if (value && typeof value.seconds === "number") return value.seconds * 1000;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const dateOnly = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (dateOnly) {
      return Date.parse(`${dateOnly[1]}-${dateOnly[2]}-${dateOnly[3]}T00:00:00+08:00`) || 0;
    }
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function normalizedType(data = {}) {
  const value = `${data.type || ""} ${data.title || ""} ${data.status || ""} ${data.action || ""}`
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
  if (value.includes("cancel")) return "cancelled";
  if (value.includes("resched")) return "rescheduled";
  if (value.includes("reminder") || value.includes("upcoming") || value.includes("starts")) return "reminder";
  if (value.includes("publish") || value.includes("newevent")) return "published";
  return "default";
}

function normalizeItem(id, data = {}, source, uid) {
  const createdAtMillis = toMillis(data.createdAt) ||
    toMillis(data.createdAtMillis) ||
    toMillis(data.timestamp) ||
    toMillis(data.time);
  return {
    ...data,
    id: String(id),
    eventId: String(data.eventId || data.event_id || ""),
    title: String(data.title || data.eventTitle || data.eventName || "Notification"),
    message: String(data.message || data.body || ""),
    type: normalizedType(data),
    createdAtMillis,
    read: data.read === true,
    source,
    userId: String(data.userId || uid),
    recipientUid: String(data.recipientUid || uid),
  };
}

function eventStatus(event) {
  return String(event?.status || "")
    .trim()
    .toLowerCase()
    .replace(/[ _-]+/g, " ");
}

function isVisibleToTeacher(event) {
  const status = eventStatus(event);
  if (["draft", "pending", "rejected"].includes(status)) return false;
  return ["approved", "published", "rescheduled", "cancelled", "canceled"].includes(status) ||
    event.published === true;
}

function eventTitle(event) {
  return String(event.title || event.name || event.eventName || "Notification");
}

function eventStartMillis(event) {
  const rawStart = event.startAt ?? event.start_at;
  if (typeof rawStart === "string" && /^\d{4}-\d{2}-\d{2}$/.test(rawStart)) {
    return Date.parse(`${rawStart}T00:00:00+08:00`) || 0;
  }
  if (typeof rawStart === "string" && /^\d{4}-\d{2}-\d{2}[T ]\d{1,2}:\d{2}/.test(rawStart)) {
    return Date.parse(
      `${rawStart.replace(" ", "T")}${/(?:Z|[+-]\d{2}:?\d{2})$/i.test(rawStart) ? "" : "+08:00"}`,
    ) || 0;
  }
  const direct = toMillis(rawStart);
  if (direct) return direct;
  const dateTime = String(event.startDateTime || event.start_date_time || "").trim();
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{1,2}:\d{2}/.test(dateTime)) {
    return Date.parse(
      `${dateTime.replace(" ", "T")}${/(?:Z|[+-]\d{2}:?\d{2})$/i.test(dateTime) ? "" : "+08:00"}`,
    ) || 0;
  }
  const date = String(event.dateISO || event.date || event.startDate || "").slice(0, 10);
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

function manilaTomorrow(timestamp) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(timestamp));
  const part = (type) => parts.find((value) => value.type === type)?.value;
  const startOfManilaDay = Date.parse(`${part("year")}-${part("month")}-${part("day")}T00:00:00+08:00`);
  return manilaDate(startOfManilaDay + ONE_DAY);
}

function isWithinRecentWindow(timestamp, now) {
  return timestamp > 0 && timestamp <= now && now - timestamp <= TWO_WEEKS;
}

function derivedItems(uid) {
  const now = Date.now();
  const derived = [];
  eventDocuments.forEach((event, eventId) => {
    if (!isVisibleToTeacher(event)) return;
    const title = eventTitle(event);
    const status = eventStatus(event);
    const published =
      status === "published" ||
      (event.published === true &&
        !["cancelled", "canceled", "rejected", "draft", "pending"].includes(status));
    const publishedAt = toMillis(event.publishedAt) ||
      toMillis(event.updatedAt) ||
      toMillis(event.createdAt);
    if (published && isWithinRecentWindow(publishedAt, now)) {
      derived.push({
        id: `published-${eventId}-${publishedAt}`,
        eventId,
        type: "published",
        title: `New event: ${title}`,
        message: String(event.description || event.summary || "A new event is available."),
        createdAtMillis: publishedAt,
        read: false,
        source: "derived",
        userId: uid,
        recipientUid: uid,
      });
    }

    if (["cancelled", "canceled"].includes(status) || status === "rescheduled") {
      const updatedAt = toMillis(event.updatedAt);
      if (isWithinRecentWindow(updatedAt, now)) {
        const type = status === "rescheduled" ? "rescheduled" : "cancelled";
        derived.push({
          id: `${type}-${eventId}-${updatedAt}`,
          eventId,
          type,
          title: status === "rescheduled" ? `${title} was rescheduled` : `${title} was cancelled`,
          message: status === "rescheduled"
            ? "The event schedule has changed."
            : "The organizer cancelled this event.",
          createdAtMillis: updatedAt,
          read: false,
          source: "derived",
          userId: uid,
          recipientUid: uid,
        });
      }
    }

    if (["cancelled", "canceled", "rejected", "draft", "pending"].includes(status)) return;
    const startsAt = eventStartMillis(event);
    if (startsAt <= now || startsAt - now > ONE_DAY) return;
    const isTomorrow = manilaDate(startsAt) === manilaTomorrow(now);
    const hours = Math.max(1, Math.ceil((startsAt - now) / (60 * 60 * 1000)));
    derived.push({
      id: `reminder-${eventId}-${startsAt}`,
      eventId,
      type: "reminder",
      title: isTomorrow ? `${title} starts tomorrow` : `${title} starts in ${hours} ${hours === 1 ? "hour" : "hours"}`,
      message: "An event is coming up.",
      createdAtMillis: now,
      read: false,
      source: "derived",
      userId: uid,
      recipientUid: uid,
    });
  });
  return derived;
}

function mergeItems(uid) {
  const merged = new Map();
  firestoreNotifications.forEach((data, id) => {
    merged.set(id, normalizeItem(id, data, "firestore", uid));
  });
  rtdbNotifications.forEach((data, id) => {
    if (!merged.has(id)) merged.set(id, normalizeItem(id, data, "rtdb", uid));
  });

  const firestoreCoverage = new Set(
    [...firestoreNotifications.values()]
      .map((data) => ({
        eventId: String(data.eventId || data.event_id || ""),
        type: normalizedType(data),
      }))
      .filter((item) => item.eventId)
      .map((item) => `${item.eventId}:${item.type}`),
  );
  derivedItems(uid).forEach((item) => {
    if (firestoreCoverage.has(`${item.eventId}:${item.type}`)) return;
    if (!merged.has(item.id)) merged.set(item.id, item);
  });
  return [...merged.values()].sort((a, b) => b.createdAtMillis - a.createdAtMillis);
}

function publish(version) {
  if (version !== subscriptionVersion) return;
  const allFailed = sourceStates.size > 0 &&
    [...sourceStates.values()].every((state) => state === "error");
  const sourcesSettled = [...sourceStates.values()].every((state) => state !== "pending");
  const items = mergeItems(currentUid);
  const unreadCount = items.filter((item) => !item.read).length;
  const counts = {
    firestoreUserId: firestoreQueries.get("userId")?.size || 0,
    firestoreRecipientUid: firestoreQueries.get("recipientUid")?.size || 0,
    events: eventDocuments.size,
    rtdb: rtdbNotifications.size,
  };
  debug("Notification state", {
    uid: currentUid,
    loading: !hasSettledSource && !timedOut,
    counts,
    mergedCount: items.length,
    unreadCount,
    firstItem: items[0] || null,
    errors: Object.fromEntries(sourceErrors),
  });
  onChange({
    uid: currentUid,
    isAuthenticated,
    items,
    loading: !hasSettledSource && !timedOut,
    allFailed,
    sourcesSettled,
    error: allFailed ? [...sourceErrors.values()].join(" ") : "",
    sourceStates: Object.fromEntries(sourceStates),
    sourceErrors: Object.fromEntries(sourceErrors),
    counts,
    retry: retrySubscriptions,
  });
}

function retrySubscriptions() {
  if (currentUid) {
    startSubscriptions(currentUid);
    return;
  }
  authUnsubscribe?.();
  authUnsubscribe = null;
  attachAuthListener();
}

function markSource(name, error, version) {
  if (version !== subscriptionVersion) return;
  if (!hasSettledSource && loadingTimer) {
    clearTimeout(loadingTimer);
    loadingTimer = null;
  }
  hasSettledSource = true;
  sourceStates.set(name, error ? "error" : "ok");
  if (error) {
    sourceErrors.set(name, error);
    debug(`Source ${name} failed:`, error);
  } else {
    sourceErrors.delete(name);
  }
  publish(version);
}

function stopSubscriptions() {
  subscriptionVersion += 1;
  firestoreUnsubscribes.forEach((unsubscribe) => {
    try {
      unsubscribe();
    } catch (error) {
      debug("Could not stop a Firestore notification listener:", error);
    }
  });
  firestoreUnsubscribes = [];
  try {
    eventsUnsubscribe?.();
  } catch (error) {
    debug("Could not stop the event notification listener:", error);
  }
  eventsUnsubscribe = null;
  try {
    rtdbUnsubscribe?.();
  } catch (error) {
    debug("Could not stop the Realtime Database notification listener:", error);
  }
  rtdbUnsubscribe = null;
  if (refreshTimer) clearInterval(refreshTimer);
  if (loadingTimer) clearTimeout(loadingTimer);
  refreshTimer = null;
  loadingTimer = null;
  sourceStates.clear();
  sourceErrors.clear();
  eventDocuments.clear();
  firestoreQueries.clear();
  firestoreNotifications.clear();
  rtdbNotifications.clear();
  hasSettledSource = false;
  timedOut = false;
}

function subscribeToFirestoreNotifications(uid, version) {
  firestoreQueries = new Map([["userId", new Map()], ["recipientUid", new Map()]]);
  ["userId", "recipientUid"].forEach((field) => {
    sourceStates.set(`notifications:${field}`, "pending");
    const filters = [{ field, operator: "==", value: uid }, { limit: 200 }];
    const uidAtRead = auth?.currentUser?.uid;
    debug("Firestore read started:", {
      path: "notifications",
      filters,
      uid: uidAtRead,
    });
    try {
      const unsubscribe = onSnapshot(
        query(collection(db, "notifications"), where(field, "==", uid), limit(200)),
        (snapshot) => {
          if (version !== subscriptionVersion || currentUid !== uid) return;
          const results = firestoreQueries.get(field);
          results.clear();
          snapshot.docs.forEach((item) => results.set(item.id, item.data()));
          firestoreNotifications.clear();
          firestoreQueries.forEach((items) => {
            items.forEach((data, id) => firestoreNotifications.set(id, data));
          });
          markSource(`notifications:${field}`, null, version);
        },
        (error) => {
          debug("Firestore read failed:", {
            path: "notifications",
            filters,
            code: error?.code || "unknown",
            message: error?.message || String(error),
            uid: uidAtRead,
          });
          markSource(`notifications:${field}`, error?.code === "permission-denied"
            ? "You don't have permission to read notifications."
            : error?.message || "A Firestore notification query failed.", version);
        },
      );
      firestoreUnsubscribes.push(unsubscribe);
    } catch (error) {
      debug("Firestore read failed:", {
        path: "notifications",
        filters,
        code: error?.code || "unknown",
        message: error?.message || String(error),
        uid: uidAtRead,
      });
      markSource(`notifications:${field}`, error?.message || String(error), version);
    }
  });
}

function subscribeToEvents(uid, version) {
  sourceStates.set("events", "pending");
  const filters = teacherEventReadFilters(uid);
  const uidAtRead = auth?.currentUser?.uid;
  debug("Firestore read started:", {
    path: "events",
    filters,
    uid: uidAtRead,
  });
  try {
    const eventsQuery = query(teacherEventsQuery(db, uid), limit(EVENT_LIMIT));
    eventsUnsubscribe = onSnapshot(
      eventsQuery,
      (snapshot) => {
        if (version !== subscriptionVersion || currentUid !== uid) return;
        eventDocuments = new Map(
          snapshot.docs.map((item) => [item.id, item.data()]),
        );
        markSource("events", null, version);
      },
      (error) => {
        debug("Firestore read failed:", {
          path: "events",
          filters,
          code: error?.code || "unknown",
          message: error?.message || String(error),
          uid: uidAtRead,
        });
        markSource("events", error?.code === "permission-denied"
          ? "You don't have permission to read events."
          : error?.message || "The event notification source failed.", version);
      },
    );
  } catch (error) {
    debug("Firestore read failed:", {
      path: "events",
      filters,
      code: error?.code || "unknown",
      message: error?.message || String(error),
      uid: uidAtRead,
    });
    markSource("events", error?.message || String(error), version);
  }
}

function subscribeToRtdb(uid, version) {
  if (!isRtdbConfigured || !rtdb) return;
  sourceStates.set("rtdb", "pending");
  try {
    rtdbUnsubscribe = onValue(
      databaseRef(rtdb, `notifications/${uid}`),
      (snapshot) => {
        if (version !== subscriptionVersion || currentUid !== uid) return;
        rtdbNotifications.clear();
        Object.entries(snapshot.val() || {}).forEach(([id, data]) => {
          if (data && typeof data === "object") rtdbNotifications.set(id, data);
        });
        markSource("rtdb", null, version);
      },
      (error) => markSource(
        "rtdb",
        error?.message || "The Realtime Database notification source failed.",
        version,
      ),
    );
  } catch (error) {
    markSource("rtdb", error?.message || String(error), version);
  }
}

function startSubscriptions(uid) {
  stopSubscriptions();
  currentUid = auth?.currentUser?.uid === uid ? uid : "";
  const version = ++subscriptionVersion;
  if (!currentUid || !db) {
    hasSettledSource = true;
    sourceStates.set("identity", "error");
    sourceErrors.set("identity", uid && !db
      ? "Firebase is not configured."
      : "Sign in to view notifications.");
    publish(version);
    return;
  }
  sourceErrors.clear();
  subscribeToFirestoreNotifications(currentUid, version);
  if (includeEventsSource) subscribeToEvents(currentUid, version);
  subscribeToRtdb(currentUid, version);
  publish(version);
  refreshTimer = setInterval(() => publish(version), 60 * 1000);
  loadingTimer = setTimeout(() => {
    if (version !== subscriptionVersion) return;
    timedOut = true;
    publish(version);
  }, 5000);
}

function attachAuthListener() {
  if (authUnsubscribe) return;
  try {
    if (!auth || !isFirebaseConfigured) {
      startSubscriptions("");
      return;
    }
    if (!loadingTimer) {
      loadingTimer = setTimeout(() => {
        loadingTimer = null;
        if (authUnsubscribe) return;
        hasSettledSource = true;
        timedOut = true;
        sourceStates.set("auth", "error");
        sourceErrors.set("auth", "Authentication is taking longer than expected.");
        publish(subscriptionVersion);
      }, 5000);
    }
    Promise.resolve(authReady).then(() => {
      if (authUnsubscribe) return;
      authUnsubscribe = onAuthStateChanged(auth, (user) => {
        try {
          isAuthenticated = Boolean(user?.uid);
          startSubscriptions(user?.uid || "");
        } catch (error) {
          reportStartupError(error);
        }
      });
    }).catch(reportStartupError);
  } catch (error) {
    reportStartupError(error);
  }
}

function reportStartupError(error) {
  const message = error?.message || String(error);
  debug("Could not start teacher notification data:", error);
  try {
    authUnsubscribe?.();
  } catch (cleanupError) {
    debug("Could not stop the teacher Auth listener:", cleanupError);
  }
  authUnsubscribe = null;
  stopSubscriptions();
  currentUid = "";
  isAuthenticated = Boolean(auth?.currentUser?.uid);
  hasSettledSource = true;
  timedOut = false;
  sourceStates.set("startup", "error");
  sourceErrors.set("startup", message);
  try {
    onChange({
      uid: auth?.currentUser?.uid || "",
      isAuthenticated,
      items: [],
      loading: false,
      allFailed: true,
      sourcesSettled: true,
      error: message,
      sourceStates: Object.fromEntries(sourceStates),
      sourceErrors: Object.fromEntries(sourceErrors),
      counts: {
        firestoreUserId: 0,
        firestoreRecipientUid: 0,
        events: 0,
        rtdb: 0,
      },
      retry: retrySubscriptions,
    });
  } catch (callbackError) {
    console.error("[Teacher Notifications] Startup error callback failed:", callbackError);
  }
}

export function startTeacherNotificationData(callback, options = {}) {
  onChange = typeof callback === "function" ? callback : () => {};
  const cleanup = () => {
    window.removeEventListener("pagehide", stopForPageHide);
    window.removeEventListener("pageshow", resumeFromPageShow);
    try {
      authUnsubscribe?.();
    } catch (error) {
      debug("Could not stop the teacher Auth listener:", error);
    }
    authUnsubscribe = null;
    stopSubscriptions();
  };
  try {
    includeEventsSource = options.includeEvents !== false;
    attachAuthListener();
    window.addEventListener("pagehide", stopForPageHide);
    window.addEventListener("pageshow", resumeFromPageShow);
  } catch (error) {
    reportStartupError(error);
  }
  return cleanup;
}

function stopForPageHide() {
  authUnsubscribe?.();
  authUnsubscribe = null;
  stopSubscriptions();
}

function resumeFromPageShow(event) {
  if (!event.persisted) return;
  attachAuthListener();
}

export async function markTeacherNotificationRead(id) {
  if (!db || !currentUid || !firestoreNotifications.has(String(id))) {
    throw new Error("This notification is no longer available to mark as read.");
  }
  try {
    await updateDoc(doc(db, "notifications", String(id)), { read: true });
  } catch (error) {
    debug("Could not update Firestore notification read state:", error);
    throw error;
  }
}
