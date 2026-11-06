import { auth, db, rtdb, functions, isFirebaseConfigured, isRtdbConfigured } from "./firebaseConfig.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  collection,
  doc,
  onSnapshot as onFirestoreSnapshot,
  query as firestoreQuery,
  where,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  ref,
  onValue,
  off,
  query,
  orderByChild,
  startAt,
  endAt,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js";
import { isEventVisibleToStudent } from "./eventAudience.js";

/* ---------------------------------------------------------
   COMMON SIDEBAR & USER PROFILE INITIALIZATION
--------------------------------------------------------- */
function initCommon() {
  const sidebar = document.getElementById("sidebar");
  const todayDate = document.getElementById("todayDate");

  if (todayDate) {
    todayDate.textContent = new Date().toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  }

  try {
    localStorage.removeItem("sidebarCollapsed");
  } catch {}
  if (sidebar) {
    sidebar.classList.remove("is-collapsed");
    requestAnimationFrame(() => sidebar.classList.add("is-ready"));
  }
}

/* ---------------------------------------------------------
   STATE & DATA MAPS
--------------------------------------------------------- */
let currentUid = null;
let serverTimeOffset = 0;
let permanentQrToken = "";

const studentProfile = {
  firstName: "Student",
  middleName: "",
  lastName: "",
  fullName: "Student",
  studentNo: "2025-00790-BN-1",
  organization: "",
  department: "",
  departmentCode: "",
};

const rawEventsMap = new Map(); // id -> normalized event
const userRegistrationsMap = new Map(); // id -> { status, at }
const localRegistrationsMap = new Map();
const rtdbRegistrationsMap = new Map();
const firestoreRegistrationsMap = new Map();
const attendanceMap = new Map(); // id -> { scannedAt, scannedBy, walkIn }
const attendanceListeners = new Map(); // id -> unsub
const firestoreEventListeners = new Map(); // id -> unsub

const filterState = {
  search: "",
  status: "participating", // "participating" (default), "completed", "absent", "rescheduled", "cancelled"
  from: "", // YYYY-MM-DD
  to: "",   // YYYY-MM-DD
  quickPreset: "this_month",
};

const datePickerState = {
  viewYear: 0,
  viewMonth: 0,
  pendingStart: null,
  pendingEnd: null,
};

let activePublicEventsRef = null;
let activePublicEventsListener = null;
let firestoreEventsUnsubscribe = null;
let rtdbRegistrationsUnsubscribe = null;
let firestoreParticipationError = false;

/* ---------------------------------------------------------
   TIME & DATE UTILITIES (Philippine Time Asia/Manila)
--------------------------------------------------------- */
function getNow() {
  return Date.now() + (serverTimeOffset || 0);
}

function toPhDateStr(timestamp) {
  const d = new Date(timestamp);
  return d.toLocaleDateString("en-CA", { timeZone: "Asia/Manila" });
}

function phDayStart(phDateStr) {
  const [y, m, d] = phDateStr.split("-").map(Number);
  return Date.UTC(y, m - 1, d, 0, 0, 0, 0) - 8 * 3600 * 1000;
}

function phDayEnd(phDateStr) {
  const [y, m, d] = phDateStr.split("-").map(Number);
  return Date.UTC(y, m - 1, d, 23, 59, 59, 999) - 8 * 3600 * 1000;
}

function formatPhDatePretty(isoStr) {
  if (!isoStr) return "";
  const [y, m, d] = isoStr.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function formatTimeShort(ms) {
  if (!ms) return "";
  const d = new Date(ms);
  return d.toLocaleTimeString("en-US", {
    timeZone: "Asia/Manila",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function escapeHTML(value) {
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

function announce(msg) {
  const announcer = document.getElementById("filterLiveAnnouncer");
  if (announcer) announcer.textContent = msg;
}

/* ---------------------------------------------------------
   USER PROFILE HYDRATION
--------------------------------------------------------- */
function hydrateUserProfile() {
  const user =
    JSON.parse(localStorage.getItem("recovibeCurrentUser") || "null") || {};
  const storedFirstName = String(user.firstName || "").trim();
  const storedFullName = String(user.name || user.fullName || "").trim();
  const nameFromProfile = [
    storedFirstName,
    user.middleName,
    user.lastName,
  ]
    .map((part) => String(part || "").trim())
    .filter(Boolean)
    .join(" ");
  const displayName = storedFullName || nameFromProfile || "Student";
  const firstName =
    storedFirstName ||
    storedFullName.split(/\s+/).filter(Boolean)[0] ||
    nameFromProfile.split(/\s+/).filter(Boolean)[0] ||
    "Student";

  studentProfile.firstName = firstName;
  studentProfile.middleName = String(user.middleName || "").trim();
  studentProfile.lastName = String(user.lastName || "").trim();
  studentProfile.fullName = displayName;
  studentProfile.studentNo = String(
    user.studentNumber || user.studentId || user.username || "2025-00790-BN-1",
  ).trim();
  studentProfile.organization = String(user.organization || "").trim();
  studentProfile.courseOrganization = String(user.courseOrganization || "").trim();
  studentProfile.department = String(user.department || "").trim();
  studentProfile.departmentCode = String(user.departmentCode || "").trim();

  const avatarFallback = [
    user.username,
    user.studentNumber,
    user.studentId,
    user.email,
  ]
    .map((v) => String(v || "").trim())
    .find(Boolean) || "";
  const avatarLetter =
    Array.from(firstName || avatarFallback)[0]?.toLocaleUpperCase() || "S";
  const organization = String(user.organization || "").trim();
  const role =
    organization && organization.toLowerCase() !== "none"
      ? organization
      : "Student";

  document.querySelectorAll(".user-name").forEach((el) => {
    el.textContent = displayName;
  });
  document.querySelectorAll(".user-role").forEach((el) => {
    el.textContent = role;
  });
  document.querySelectorAll(".avatar").forEach((el) => {
    el.textContent = avatarLetter;
  });
  document.querySelectorAll("#userFirstName").forEach((el) => {
    el.textContent = firstName;
  });
}

/* ---------------------------------------------------------
   URL QUERY PARAMS & DEFAULT RANGE ("This month")
--------------------------------------------------------- */
function setDefaultDateRange() {
  filterState.from = "";
  filterState.to = "";
  filterState.quickPreset = "all";
}

function readUrlParams() {
  const params = new URLSearchParams(window.location.search);
  const fromParam = params.get("from");
  const toParam = params.get("to");
  const statusParam = params.get("status");

  if (fromParam && toParam && /^\d{4}-\d{2}-\d{2}$/.test(fromParam) && /^\d{4}-\d{2}-\d{2}$/.test(toParam)) {
    filterState.from = fromParam;
    filterState.to = toParam;
    filterState.quickPreset = "";
  } else {
    setDefaultDateRange();
  }

  if (statusParam && ["participating", "completed", "absent", "rescheduled", "cancelled", "attended", "registered", "all"].includes(statusParam)) {
    if (statusParam === "attended") filterState.status = "completed";
    else if (statusParam === "registered") filterState.status = "participating";
    else filterState.status = statusParam;
  } else {
    filterState.status = "participating";
  }
}

function syncUrlParams() {
  const url = new URL(window.location.href);
  if (filterState.from && filterState.to) {
    url.searchParams.set("from", filterState.from);
    url.searchParams.set("to", filterState.to);
  } else {
    url.searchParams.delete("from");
    url.searchParams.delete("to");
  }

  if (filterState.status && filterState.status !== "participating" && filterState.status !== "all") {
    url.searchParams.set("status", filterState.status);
  } else {
    url.searchParams.delete("status");
  }

  window.history.replaceState({}, "", url.toString());
}

/* ---------------------------------------------------------
   DATA NORMALIZATION & STATUS RESOLUTION
--------------------------------------------------------- */
function normalizeEventData(id, raw) {
  const toMillis = (value) => {
    if (typeof value === "number") return value;
    if (value?.toMillis) return value.toMillis();
    if (value?.toDate) return value.toDate().getTime();
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  const rawDate =
    raw.eventDate ||
    raw.dateISO ||
    raw.date ||
    raw.dateStart ||
    raw.schedule?.date ||
    raw.schedule?.startDate ||
    "";
  const dateISO = rawDate?.toDate
    ? rawDate.toDate().toISOString().slice(0, 10)
    : String(rawDate).slice(0, 10);
  const timeStr =
    raw.time ||
    [raw.timeStart || raw.startTime, raw.timeEnd || raw.endTime]
      .filter(Boolean)
      .join(" - ") ||
    "08:00 AM";
  let startAt = toMillis(raw.startAt);
  let endAt = toMillis(raw.endAt);

  if (!startAt && dateISO) {
    const [tPart, meridiem] = timeStr.split(/\s+/);
    let [hh, mm] = (tPart || "08:00").split(":").map(Number);
    if (meridiem === "PM" && hh < 12) hh += 12;
    if (meridiem === "AM" && hh === 12) hh = 0;
    const [y, m, d] = dateISO.split("-").map(Number);
    startAt = Date.UTC(y, m - 1, d, hh - 8, mm || 0, 0, 0);
    endAt = startAt + 2 * 3600 * 1000;
  }

  const capacity = raw.capacity !== undefined ? raw.capacity : (raw.slotsOpen ?? 100);
  const capacityMode = raw.capacityMode || (capacity === null || capacity === undefined ? "N/A" : "Limited");
  const registeredCount = Number(raw.registeredCount || 0);

  return {
    ...raw,
    id: String(id),
    title: raw.name || raw.title || raw.eventName || "Untitled Event",
    location: raw.venue || raw.location || raw.venueOther || "PUP Biñan Campus",
    room: raw.room || "",
    category: raw.category || "Academic & Learning",
    source: raw.source || "PUP Official",
    startAt,
    endAt,
    capacity,
    capacityMode,
    registeredCount,
    status: raw.status || "published",
    description: raw.description || "",
    organizerUid: raw.organizerUid || "",
    organizerName: raw.organizerName || raw.organizer || "Event Organizer",
    tag: raw.tag || "",
  };
}

function computeEventParticipationStatus(event) {
  const eventId = String(event.id);
  const userReg = userRegistrationsMap.get(eventId);
  const att = attendanceMap.get(eventId);

  // 1. If attendance row exists with scannedAt, user attended / completed
  if (att && att.scannedAt) {
    return "completed";
  }

  // 2. If event is cancelled or user cancelled registration
  const evStatus = String(event.status || "").toLowerCase();
  const isEvCancelled = evStatus === "cancelled" || evStatus === "canceled";
  if ((userReg && userReg.status === "cancelled") || isEvCancelled) {
    return "cancelled";
  }

  // 3. If event was rescheduled
  const isRescheduled = evStatus === "rescheduled" || Boolean(event.rescheduledFrom || event.rescheduledDate);
  if (isRescheduled) {
    return "rescheduled";
  }

  // 4. If event has ended and user was not scanned in -> absent
  const now = getNow();
  const hasEnded = event.endAt ? event.endAt < now : (event.startAt ? event.startAt + 3 * 3600 * 1000 < now : false);
  if (hasEnded) {
    return "absent";
  }

  // 5. Otherwise, user is actively participating
  return "participating";
}

function refreshUserRegistrations() {
  userRegistrationsMap.clear();
  for (const [eventId, registration] of localRegistrationsMap) {
    userRegistrationsMap.set(eventId, registration);
  }
  for (const [eventId, registration] of rtdbRegistrationsMap) {
    userRegistrationsMap.set(eventId, registration);
  }
  for (const [eventId, registration] of firestoreRegistrationsMap) {
    userRegistrationsMap.set(eventId, registration);
  }
  syncAttendanceListeners();
  render();
}

function stopFirestoreRegistrationListeners() {
  if (firestoreEventsUnsubscribe) {
    firestoreEventsUnsubscribe();
    firestoreEventsUnsubscribe = null;
  }
  firestoreEventListeners.forEach((unsubscribe) => unsubscribe());
  firestoreEventListeners.clear();
  firestoreRegistrationsMap.clear();
}

function listenForFirestoreRegistrations(uid) {
  stopFirestoreRegistrationListeners();
  if (!db || !isFirebaseConfigured || !uid) return;

  firestoreEventsUnsubscribe = onFirestoreSnapshot(
    firestoreQuery(
      collection(db, "events"),
      where("status", "in", [
        "approved", "Approved", "APPROVED",
        "published", "Published", "PUBLISHED",
        "completed", "Completed", "COMPLETED",
        "rescheduled", "Rescheduled", "RESCHEDULED",
      ]),
    ),
    (snapshot) => {
      const eventIds = new Set();
      firestoreParticipationError = false;
      snapshot.forEach((eventSnapshot) => {
        const eventId = eventSnapshot.id;
        const eventData = eventSnapshot.data();
        rawEventsMap.set(eventId, normalizeEventData(eventId, eventData));
        eventIds.add(eventId);

        if (!firestoreEventListeners.has(eventId)) {
          const unsubscribe = onFirestoreSnapshot(
            doc(db, "events", eventId, "registrations", uid),
            (registrationSnapshot) => {
              firestoreParticipationError = false;
              if (!registrationSnapshot.exists()) {
                firestoreRegistrationsMap.delete(eventId);
              } else {
                const registration = registrationSnapshot.data();
                firestoreRegistrationsMap.set(eventId, {
                  ...registration,
                  status: registration.status || "registered",
                  at: registration.registeredAt || registration.at || 0,
                });
              }
              refreshUserRegistrations();
            },
            (error) => {
              console.error(`Could not load registration for event ${eventId}:`, error);
              firestoreParticipationError = true;
              render();
            },
          );
          firestoreEventListeners.set(eventId, unsubscribe);
        }
      });

      firestoreEventListeners.forEach((unsubscribe, eventId) => {
        if (!eventIds.has(eventId)) {
          unsubscribe();
          firestoreEventListeners.delete(eventId);
          firestoreRegistrationsMap.delete(eventId);
          rawEventsMap.delete(eventId);
        }
      });
      refreshUserRegistrations();
    },
    (error) => {
      console.error("Could not load Firestore events for participation:", error);
      firestoreParticipationError = true;
      render();
    },
  );
}

/* ---------------------------------------------------------
   ATTENDANCE REAL-TIME LISTENERS
--------------------------------------------------------- */
function syncAttendanceListeners() {
  if (!isRtdbConfigured || !currentUid) return;

  const currentEventIds = new Set(userRegistrationsMap.keys());

  // Subscribe to newly registered events
  currentEventIds.forEach((eventId) => {
    if (!attendanceListeners.has(eventId)) {
      const attRef = ref(rtdb, `attendance/${eventId}/${currentUid}`);
      const unsub = onValue(attRef, (snap) => {
        const val = snap.val();
        if (val) {
          attendanceMap.set(eventId, val);
        } else {
          attendanceMap.delete(eventId);
        }
        render();
      });
      attendanceListeners.set(eventId, () => off(attRef, "value", unsub));
    }
  });

  // Clean up unsubscribed
  attendanceListeners.forEach((unsub, eventId) => {
    if (!currentEventIds.has(eventId)) {
      unsub();
      attendanceListeners.delete(eventId);
      attendanceMap.delete(eventId);
    }
  });
}

/* ---------------------------------------------------------
   LOAD EVENTS & REGISTRATIONS
--------------------------------------------------------- */
function loadParticipationData() {
  try {
    const cachedEvents = JSON.parse(localStorage.getItem("recovibeEventsCache") || "[]");
    if (Array.isArray(cachedEvents)) {
      cachedEvents.forEach((event) => {
        const id = event?.id || event?.eventId;
        if (id) rawEventsMap.set(String(id), normalizeEventData(id, event));
      });
    }
  } catch (error) {
    console.warn("Cached event data read notice:", error);
  }

  // Offline fallback from window.RECOVIBE_EVENTS
  if (Array.isArray(window.RECOVIBE_EVENTS)) {
    window.RECOVIBE_EVENTS.forEach((raw) => {
      if (raw && raw.id) {
        rawEventsMap.set(String(raw.id), normalizeEventData(raw.id, raw));
      }
    });
  }

  // Offline fallback from localStorage
  try {
    const saved = JSON.parse(localStorage.getItem("recovibeParticipations") || "[]");
    if (Array.isArray(saved)) {
      saved.forEach((id) => {
        if (!localRegistrationsMap.has(String(id))) {
          localRegistrationsMap.set(String(id), { status: "registered", at: Date.now() });
        }
      });
    }
  } catch (err) {
    console.warn("Local participations read notice:", err);
  }
  refreshUserRegistrations();

  // RTDB Public Events Query
  if (isRtdbConfigured) {
    if (activePublicEventsRef && activePublicEventsListener) {
      off(activePublicEventsRef, "value", activePublicEventsListener);
    }

    const eventsRoot = ref(rtdb, "publicEvents");
    let q;

    if (filterState.from && filterState.to) {
      const startMs = phDayStart(filterState.from);
      const endMs = phDayEnd(filterState.to);
      q = query(eventsRoot, orderByChild("startAt"), startAt(startMs), endAt(endMs));
    } else {
      q = query(eventsRoot, orderByChild("startAt"));
    }

    activePublicEventsRef = q;
    activePublicEventsListener = onValue(
      q,
      (snapshot) => {
        if (snapshot.exists()) {
          snapshot.forEach((child) => {
            const ev = normalizeEventData(child.key, child.val());
            rawEventsMap.set(ev.id, ev);
          });
        }
        render();
      },
      (error) => {
        console.warn("Public events fetch notice:", error);
        render();
      },
    );
  } else {
    render();
  }
}

/* ---------------------------------------------------------
   SUMMARY METRICS & FILTERED RENDERING
--------------------------------------------------------- */
function render() {
  const allEvents = Array.from(rawEventsMap.values());
  const registeredIds = new Set(userRegistrationsMap.keys());

  // Find all events associated with this user
  const userEvents = allEvents.filter((ev) => {
    if (!registeredIds.has(ev.id)) return false;
    const registration = userRegistrationsMap.get(ev.id);
    const registrationStatus = String(registration?.status || "")
      .trim()
      .toLowerCase()
      .replace(/[\s_-]+/g, "");
    const hasApprovedOrAttendedParticipation =
      ["approved", "attended", "completed", "checkedin"].includes(registrationStatus) ||
      Boolean(attendanceMap.get(ev.id)?.scannedAt);
    return (
      hasApprovedOrAttendedParticipation ||
      isEventVisibleToStudent(ev, studentProfile)
    );
  });

  // Range-matching events for summary metrics
  const rangeMatchedEvents = userEvents.filter((ev) => {
    if (!filterState.from || !filterState.to) return true;
    const startDay = toPhDateStr(ev.startAt || getNow());
    return startDay >= filterState.from && startDay <= filterState.to;
  });

  // Calculate Metrics
  let inRangeCount = 0;
  let attendedCount = 0;
  let absentCount = 0;
  let upcomingCount = 0;

  rangeMatchedEvents.forEach((ev) => {
    inRangeCount++;
    const st = computeEventParticipationStatus(ev);
    if (st === "attended" || st === "completed") attendedCount++;
    else if (st === "absent") absentCount++;
    else if (st === "registered" || st === "participating") upcomingCount++;
  });

  const totalFinished = attendedCount + absentCount;
  const attendanceRate = totalFinished > 0
    ? `${Math.round((attendedCount / totalFinished) * 100)}%`
    : (attendedCount > 0 ? "100%" : "0%");

  // Update Metrics DOM
  const attendedEl = document.getElementById("metricAttended") || document.getElementById("metricCompleted");
  const absentEl = document.getElementById("metricAbsent");
  const upcomingEl = document.getElementById("metricUpcoming");
  const rateEl = document.getElementById("metricRate");

  if (attendedEl) attendedEl.textContent = attendedCount;
  if (absentEl) absentEl.textContent = absentCount;
  if (upcomingEl) upcomingEl.textContent = upcomingCount;
  if (rateEl) rateEl.textContent = attendanceRate;

  // Filter list by Search, Status, and Date Range
  const queryText = filterState.search.trim().toLowerCase();

  const visibleEvents = userEvents.filter((ev) => {
    // 1. Date Range
    if (filterState.from && filterState.to) {
      const startDay = toPhDateStr(ev.startAt || getNow());
      if (startDay < filterState.from || startDay > filterState.to) return false;
    }

    // 2. Status Filter
    const st = computeEventParticipationStatus(ev);
    if (filterState.status !== "all") {
      if (filterState.status === "participating" || filterState.status === "registered") {
        if (st !== "participating" && st !== "registered") return false;
      } else if (filterState.status === "completed" || filterState.status === "attended") {
        if (st !== "completed" && st !== "attended") return false;
      } else if (st !== filterState.status) {
        return false;
      }
    }

    // 3. Search query
    if (queryText) {
      const searchable = `${ev.title} ${ev.location} ${ev.source} ${ev.category} ${ev.room}`.toLowerCase();
      if (!searchable.includes(queryText)) return false;
    }

    return true;
  });

  // Sort newest first
  visibleEvents.sort((a, b) => (b.startAt || 0) - (a.startAt || 0));

  // Render list
  const listEl = document.getElementById("participationList");
  const countEl = document.getElementById("participationCount");

  if (countEl) {
    countEl.textContent = `${visibleEvents.length} event${visibleEvents.length === 1 ? "" : "s"}`;
  }

  if (!listEl) return;

  if (visibleEvents.length === 0) {
    if (firestoreParticipationError) {
      listEl.innerHTML = `
        <div class="empty-participation">
          <p style="margin:0 0 6px; font-weight:600; color:var(--ink-700);">Could not sync participation records.</p>
          <span style="font-size:12.5px; color:var(--ink-500);">Check your connection and reload this page. If the problem continues, contact support.</span>
        </div>`;
      renderActiveChips(userEvents.length, visibleEvents.length);
      return;
    }
    listEl.innerHTML = `
      <div class="empty-participation">
        <p style="margin:0 0 6px; font-weight:600; color:var(--ink-700);">No participation records match your filters.</p>
        <span style="font-size:12.5px; color:var(--ink-500);">Try selecting "All time" or adjusting your search.</span>
      </div>`;
    renderActiveChips(userEvents.length, visibleEvents.length);
    return;
  }

  listEl.innerHTML = visibleEvents
    .map((event) => {
      const status = computeEventParticipationStatus(event);
      const att = attendanceMap.get(event.id);

      const startDateObj = new Date(event.startAt || getNow());
      const monthShort = startDateObj.toLocaleDateString("en-US", { timeZone: "Asia/Manila", month: "short" });
      const dayNum = startDateObj.toLocaleDateString("en-US", { timeZone: "Asia/Manila", day: "numeric" });
      const yearNum = startDateObj.toLocaleDateString("en-US", { timeZone: "Asia/Manila", year: "numeric" });

      const startTimeStr = formatTimeShort(event.startAt);
      const endTimeStr = formatTimeShort(event.endAt);
      const timeDisplay = startTimeStr && endTimeStr ? `${startTimeStr} - ${endTimeStr}` : (startTimeStr || "TBA");

      let statusBadgeHtml = "";
      if (status === "attended" || status === "completed") {
        const timeScanned = att?.scannedAt ? formatTimeShort(att.scannedAt) : "";
        statusBadgeHtml = `
          <span class="attendance-tag is-checked-in">
            <svg viewBox="0 0 16 16" fill="currentColor" width="12" height="12"><path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z"/></svg>
            Checked in ${timeScanned}
          </span>`;
      } else if (status === "absent") {
        statusBadgeHtml = `<span class="attendance-tag is-absent">Absent</span>`;
      } else if (status === "rescheduled") {
        statusBadgeHtml = `<span class="attendance-tag is-rescheduled">Rescheduled</span>`;
      } else if (status === "cancelled") {
        statusBadgeHtml = `<span class="attendance-tag is-cancelled">Cancelled</span>`;
      } else {
        statusBadgeHtml = `<span class="attendance-tag is-registered">Participating</span>`;
      }

      return `
        <article class="participation-card" data-event-id="${escapeHTML(event.id)}">
          <div class="participation-date">
            <span class="month">${escapeHTML(monthShort)}</span>
            <span class="day">${escapeHTML(dayNum)}</span>
            <span class="year">${escapeHTML(yearNum)}</span>
          </div>
          <div class="participation-body">
            <h3 class="participation-title">${escapeHTML(event.title)}</h3>
            <p class="participation-source">${escapeHTML(event.source)}</p>
            <div class="participation-meta">
              <span>
                <svg viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="7" stroke="currentColor" stroke-width="1.4"/><path d="M10 6v4l2.5 2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
                ${escapeHTML(timeDisplay)}
              </span>
              <span>
                <svg viewBox="0 0 20 20" fill="none"><path d="M10 17.5S15.5 12.8 15.5 8.5a5.5 5.5 0 1 0-11 0c0 4.3 5.5 9 5.5 9Z" stroke="currentColor" stroke-width="1.4"/><circle cx="10" cy="8.3" r="2" stroke="currentColor" stroke-width="1.4"/></svg>
                ${escapeHTML(event.location)}${event.room ? ` · ${escapeHTML(event.room)}` : ""}
              </span>
            </div>
            <span class="category participation-category">${escapeHTML(event.category)}</span>
          </div>
          <div class="participation-action">
            ${statusBadgeHtml}
            <button type="button" class="btn-show-qr" data-qr-event-title="${escapeHTML(event.title)}">
              <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" width="14" height="14" aria-hidden="true">
                <rect x="3" y="3" width="5" height="5" rx="1"/>
                <rect x="12" y="3" width="5" height="5" rx="1"/>
                <rect x="3" y="12" width="5" height="5" rx="1"/>
                <path d="M12 12h2v2h-2zM15 15h2v2h-2zM15 12h2v1h-2zM12 15h1v2h-1z"/>
              </svg>
              Show QR
            </button>
            <button type="button" class="btn-view-details" data-action="details" data-event-id="${escapeHTML(event.id)}">
              View Details
            </button>
          </div>
        </article>`;
    })
    .join("");

  renderActiveChips(userEvents.length, visibleEvents.length);
}

/* ---------------------------------------------------------
   ACTIVE FILTER CHIPS & BUTTON LABELS
--------------------------------------------------------- */
function renderActiveChips(totalEvents, visibleCount) {
  const chipsRow = document.getElementById("activeChipsRow");
  const chipsList = document.getElementById("activeChipsList");
  if (!chipsRow || !chipsList) return;

  const chips = [];

  // 1. Search Chip
  if (filterState.search.trim()) {
    chips.push({
      key: "search",
      label: `"${filterState.search.trim()}"`,
      onRemove: () => {
        filterState.search = "";
        const input = document.getElementById("participationSearch");
        if (input) input.value = "";
        render();
      },
    });
  }

  // 2. Status Chip
  if (filterState.status && filterState.status !== "participating" && filterState.status !== "all") {
    const statusLabels = {
      completed: "Completed",
      attended: "Completed",
      absent: "Absent",
      rescheduled: "Rescheduled",
      cancelled: "Cancelled",
    };
    chips.push({
      key: "status",
      label: `Status: ${statusLabels[filterState.status] || filterState.status}`,
      onRemove: () => {
        filterState.status = "participating";
        updateStatusButtonLabel();
        syncUrlParams();
        render();
      },
    });
  }

  // 3. Date Range Chip
  if (filterState.from && filterState.to) {
    let dateLabel = `${formatPhDatePretty(filterState.from)} - ${formatPhDatePretty(filterState.to)}`;
    if (filterState.quickPreset === "this_month") dateLabel = "This month";
    else if (filterState.quickPreset === "today") dateLabel = "Today";
    else if (filterState.quickPreset === "tomorrow") dateLabel = "Tomorrow";
    else if (filterState.quickPreset === "this_week") dateLabel = "This week";

    chips.push({
      key: "date",
      label: dateLabel,
      onRemove: () => {
        filterState.from = "";
        filterState.to = "";
        filterState.quickPreset = "all";
        updateDateRangeButtonLabel();
        syncUrlParams();
        loadParticipationData();
      },
    });
  }

  if (chips.length > 0) {
    chipsRow.style.display = "flex";
    chipsList.innerHTML = chips
      .map(
        (c) => `
        <span class="filter-chip">
          <span>${escapeHTML(c.label)}</span>
          <button type="button" class="filter-chip-remove" data-chip-key="${c.key}" aria-label="Remove ${escapeHTML(c.label)}">&times;</button>
        </span>`,
      )
      .join("");

    chipsList.querySelectorAll(".filter-chip-remove").forEach((btn) => {
      btn.addEventListener("click", () => {
        const key = btn.dataset.chipKey;
        const chip = chips.find((c) => c.key === key);
        if (chip) chip.onRemove();
      });
    });

    const clearBtn = document.getElementById("clearAllChipsBtn");
    if (clearBtn) {
      clearBtn.onclick = () => {
        filterState.search = "";
        filterState.status = "participating";
        filterState.from = "";
        filterState.to = "";
        filterState.quickPreset = "all";

        const input = document.getElementById("participationSearch");
        if (input) input.value = "";

        updateStatusButtonLabel();
        updateDateRangeButtonLabel();
        syncUrlParams();
        loadParticipationData();
      };
    }
  } else {
    chipsRow.style.display = "none";
  }

  announce(`Showing ${visibleCount} of ${totalEvents} participation records.`);
}

function updateStatusButtonLabel() {
  const btn = document.getElementById("statusFilterBtn");
  if (!btn) return;
  const statusLabels = {
    all: "Participating",
    participating: "Participating",
    registered: "Participating",
    completed: "Completed",
    attended: "Completed",
    absent: "Absent",
    rescheduled: "Rescheduled",
    cancelled: "Cancelled",
  };
  btn.textContent = statusLabels[filterState.status] || "Participating";

  const menu = document.getElementById("statusFilterMenu");
  if (menu) {
    menu.querySelectorAll(".filter-option").forEach((opt) => {
      const val = opt.dataset.value;
      const isActive = val === filterState.status || (val === "participating" && (filterState.status === "all" || filterState.status === "registered"));
      opt.classList.toggle("active", isActive);
    });
  }
}

function updateDateRangeButtonLabel() {
  const btn = document.getElementById("dateRangeBtn");
  if (!btn) return;

  if (filterState.from && filterState.to) {
    if (filterState.quickPreset === "this_month") {
      btn.textContent = "This month";
    } else if (filterState.quickPreset === "today") {
      btn.textContent = "Today";
    } else if (filterState.quickPreset === "tomorrow") {
      btn.textContent = "Tomorrow";
    } else if (filterState.quickPreset === "this_week") {
      btn.textContent = "This week";
    } else {
      btn.textContent = `${formatPhDatePretty(filterState.from)} - ${formatPhDatePretty(filterState.to)}`;
    }
  } else {
    btn.textContent = "All time";
  }
}

/* ---------------------------------------------------------
   DATE RANGE PICKER UI LOGIC
--------------------------------------------------------- */
function initDateRangePicker() {
  const btn = document.getElementById("dateRangeBtn");
  const panel = document.getElementById("dateRangePanel");
  const prevBtn = document.getElementById("calNavPrev");
  const nextBtn = document.getElementById("calNavNext");
  const clearBtn = document.getElementById("dateRangeClearBtn");
  const cancelBtn = document.getElementById("dateRangeCancelBtn");
  const applyBtn = document.getElementById("dateRangeApplyBtn");
  const inputStart = document.getElementById("dateRangeInputStart");
  const inputEnd = document.getElementById("dateRangeInputEnd");

  if (!btn || !panel) return;

  const now = new Date(getNow());
  datePickerState.viewYear = now.getFullYear();
  datePickerState.viewMonth = now.getMonth();

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const isOpen = !panel.hidden;
    if (isOpen) {
      closeDateRangePanel();
    } else {
      openDateRangePanel();
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !panel.hidden) {
      closeDateRangePanel();
      btn.focus();
    }
  });

  document.addEventListener("click", (e) => {
    if (!panel.hidden && !panel.contains(e.target) && !btn.contains(e.target)) {
      closeDateRangePanel();
    }
  });

  if (prevBtn) {
    prevBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      datePickerState.viewMonth--;
      if (datePickerState.viewMonth < 0) {
        datePickerState.viewMonth = 11;
        datePickerState.viewYear--;
      }
      renderDatePickerCalendars();
    });
  }

  if (nextBtn) {
    nextBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      datePickerState.viewMonth++;
      if (datePickerState.viewMonth > 11) {
        datePickerState.viewMonth = 0;
        datePickerState.viewYear++;
      }
      renderDatePickerCalendars();
    });
  }

  // Quick range buttons
  document.querySelectorAll(".date-range-quick-btn").forEach((qBtn) => {
    qBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const preset = qBtn.dataset.preset;
      applyQuickRange(preset);
    });
  });

  // Inputs
  if (inputStart && inputEnd) {
    inputStart.addEventListener("input", onDateInputChanged);
    inputEnd.addEventListener("input", onDateInputChanged);
  }

  // Actions
  if (clearBtn) {
    clearBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      datePickerState.pendingStart = null;
      datePickerState.pendingEnd = null;
      filterState.from = "";
      filterState.to = "";
      filterState.quickPreset = "all";
      updateDateRangeButtonLabel();
      syncUrlParams();
      closeDateRangePanel();
      announce("Date range cleared.");
      loadParticipationData();
    });
  }

  if (cancelBtn) {
    cancelBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      closeDateRangePanel();
    });
  }

  if (applyBtn) {
    applyBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!datePickerState.pendingStart || !datePickerState.pendingEnd) return;

      let s = datePickerState.pendingStart;
      let en = datePickerState.pendingEnd;
      if (s > en) {
        const tmp = s;
        s = en;
        en = tmp;
      }

      filterState.from = s;
      filterState.to = en;
      filterState.quickPreset = "";

      updateDateRangeButtonLabel();
      syncUrlParams();
      closeDateRangePanel();
      announce(`Applied date range: ${formatPhDatePretty(s)} to ${formatPhDatePretty(en)}.`);
      loadParticipationData();
    });
  }
}

function openDateRangePanel() {
  const btn = document.getElementById("dateRangeBtn");
  const panel = document.getElementById("dateRangePanel");
  if (!panel || !btn) return;

  panel.hidden = false;
  btn.setAttribute("aria-expanded", "true");

  datePickerState.pendingStart = filterState.from;
  datePickerState.pendingEnd = filterState.to;

  if (filterState.from) {
    const [y, m] = filterState.from.split("-").map(Number);
    datePickerState.viewYear = y;
    datePickerState.viewMonth = m - 1;
  } else {
    const now = new Date(getNow());
    datePickerState.viewYear = now.getFullYear();
    datePickerState.viewMonth = now.getMonth();
  }

  syncDateInputsFromPending();
  renderDatePickerCalendars();
}

function closeDateRangePanel() {
  const btn = document.getElementById("dateRangeBtn");
  const panel = document.getElementById("dateRangePanel");
  if (!panel || !btn) return;

  panel.hidden = true;
  btn.setAttribute("aria-expanded", "false");
}

function applyQuickRange(preset) {
  const now = new Date(getNow());
  const todayStr = toPhDateStr(getNow());
  const [ty, tm, td] = todayStr.split("-").map(Number);
  const curDate = new Date(ty, tm - 1, td);

  let startStr = "";
  let endStr = "";

  if (preset === "all") {
    filterState.from = "";
    filterState.to = "";
    filterState.quickPreset = "all";
    updateDateRangeButtonLabel();
    syncUrlParams();
    closeDateRangePanel();
    announce("Date range cleared.");
    loadParticipationData();
    return;
  }

  if (preset === "today") {
    startStr = todayStr;
    endStr = todayStr;
  } else if (preset === "tomorrow") {
    const tom = new Date(curDate);
    tom.setDate(tom.getDate() + 1);
    startStr = toPhDateStr(tom.getTime());
    endStr = startStr;
  } else if (preset === "this_week") {
    const day = curDate.getDay();
    const monday = new Date(curDate);
    monday.setDate(monday.getDate() - (day === 0 ? 6 : day - 1));
    const sunday = new Date(monday);
    sunday.setDate(sunday.getDate() + 6);
    startStr = toPhDateStr(monday.getTime());
    endStr = toPhDateStr(sunday.getTime());
  } else if (preset === "this_weekend") {
    const day = curDate.getDay();
    const sat = new Date(curDate);
    sat.setDate(sat.getDate() + (6 - day));
    const sun = new Date(sat);
    sun.setDate(sun.getDate() + 1);
    startStr = toPhDateStr(sat.getTime());
    endStr = toPhDateStr(sun.getTime());
  } else if (preset === "next_week") {
    const day = curDate.getDay();
    const nextMon = new Date(curDate);
    nextMon.setDate(nextMon.getDate() + (day === 0 ? 1 : 8 - day));
    const nextSun = new Date(nextMon);
    nextSun.setDate(nextSun.getDate() + 6);
    startStr = toPhDateStr(nextMon.getTime());
    endStr = toPhDateStr(nextSun.getTime());
  } else if (preset === "this_month") {
    startStr = `${ty}-${String(tm).padStart(2, "0")}-01`;
    const lastDay = new Date(ty, tm, 0).getDate();
    endStr = `${ty}-${String(tm).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
  } else if (preset === "next_month") {
    let nextY = ty;
    let nextM = tm + 1;
    if (nextM > 12) {
      nextM = 1;
      nextY++;
    }
    startStr = `${nextY}-${String(nextM).padStart(2, "0")}-01`;
    const lastDay = new Date(nextY, nextM, 0).getDate();
    endStr = `${nextY}-${String(nextM).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
  }

  filterState.from = startStr;
  filterState.to = endStr;
  filterState.quickPreset = preset;

  updateDateRangeButtonLabel();
  syncUrlParams();
  closeDateRangePanel();
  announce(`Applied quick range: ${preset}.`);
  loadParticipationData();
}

function renderDatePickerCalendars() {
  const y1 = datePickerState.viewYear;
  const m1 = datePickerState.viewMonth;

  let y2 = y1;
  let m2 = m1 + 1;
  if (m2 > 11) {
    m2 = 0;
    y2++;
  }

  renderSingleMonthCalendar("calTitle1", "calGrid1", y1, m1);
  renderSingleMonthCalendar("calTitle2", "calGrid2", y2, m2);

  // Quick range button highlight
  document.querySelectorAll(".date-range-quick-btn").forEach((btn) => {
    const preset = btn.dataset.preset;
    btn.classList.toggle("active", filterState.quickPreset === preset);
  });
}

function renderSingleMonthCalendar(titleId, gridId, year, month) {
  const titleEl = document.getElementById(titleId);
  const gridEl = document.getElementById(gridId);
  if (!titleEl || !gridEl) return;

  const dateObj = new Date(year, month, 1);
  titleEl.textContent = dateObj.toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
  });

  const firstDayOfWeek = dateObj.getDay();
  const totalDays = new Date(year, month + 1, 0).getDate();
  const todayStr = toPhDateStr(getNow());

  const start = datePickerState.pendingStart;
  const end = datePickerState.pendingEnd;

  let html = "";
  for (let i = 0; i < firstDayOfWeek; i++) {
    html += '<div class="date-cal-day empty"></div>';
  }

  for (let day = 1; day <= totalDays; day++) {
    const dateStr = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const classes = ["date-cal-day"];

    if (dateStr === todayStr) classes.push("today");

    let isStart = start === dateStr;
    let isEnd = end === dateStr;

    if (start && end) {
      let s = start;
      let e = end;
      if (s > e) {
        const tmp = s;
        s = e;
        e = tmp;
      }
      if (dateStr === s) isStart = true;
      if (dateStr === e) isEnd = true;
      if (dateStr > s && dateStr < e) classes.push("range-between");
    }

    if (isStart) classes.push("range-start");
    if (isEnd) classes.push("range-end");

    html += `
      <button type="button" class="${classes.join(" ")}" data-date="${dateStr}" aria-label="${dateStr}">
        ${day}
      </button>`;
  }

  gridEl.innerHTML = html;

  gridEl.querySelectorAll(".date-cal-day:not(.empty)").forEach((dayBtn) => {
    dayBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const clicked = dayBtn.dataset.date;
      onCalendarDayClicked(clicked);
    });
  });
}

function onCalendarDayClicked(dateStr) {
  if (!datePickerState.pendingStart || (datePickerState.pendingStart && datePickerState.pendingEnd)) {
    datePickerState.pendingStart = dateStr;
    datePickerState.pendingEnd = null;
  } else {
    datePickerState.pendingEnd = dateStr;
    if (datePickerState.pendingStart > datePickerState.pendingEnd) {
      const tmp = datePickerState.pendingStart;
      datePickerState.pendingStart = datePickerState.pendingEnd;
      datePickerState.pendingEnd = tmp;
    }
  }

  syncDateInputsFromPending();
  renderDatePickerCalendars();
}

function syncDateInputsFromPending() {
  const inputStart = document.getElementById("dateRangeInputStart");
  const inputEnd = document.getElementById("dateRangeInputEnd");
  const valMsg = document.getElementById("dateRangeValidationMsg");
  const applyBtn = document.getElementById("dateRangeApplyBtn");

  if (inputStart) inputStart.value = datePickerState.pendingStart || "";
  if (inputEnd) inputEnd.value = datePickerState.pendingEnd || "";
  if (valMsg) valMsg.textContent = "";
  if (applyBtn) {
    applyBtn.disabled = !datePickerState.pendingStart || !datePickerState.pendingEnd;
  }
}

function onDateInputChanged() {
  const inputStart = document.getElementById("dateRangeInputStart");
  const inputEnd = document.getElementById("dateRangeInputEnd");
  const valMsg = document.getElementById("dateRangeValidationMsg");
  const applyBtn = document.getElementById("dateRangeApplyBtn");

  const vStart = inputStart?.value.trim() || "";
  const vEnd = inputEnd?.value.trim() || "";

  const isValidFormat = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);

  if (vStart && !isValidFormat(vStart)) {
    if (valMsg) valMsg.textContent = "Start date must be YYYY-MM-DD";
    if (applyBtn) applyBtn.disabled = true;
    return;
  }

  if (vEnd && !isValidFormat(vEnd)) {
    if (valMsg) valMsg.textContent = "End date must be YYYY-MM-DD";
    if (applyBtn) applyBtn.disabled = true;
    return;
  }

  if (vStart && vEnd && vStart > vEnd) {
    if (valMsg) valMsg.textContent = "Start date must be before end date";
    if (applyBtn) applyBtn.disabled = true;
    return;
  }

  if (valMsg) valMsg.textContent = "";

  if (vStart) datePickerState.pendingStart = vStart;
  if (vEnd) datePickerState.pendingEnd = vEnd;

  if (applyBtn) {
    applyBtn.disabled = !datePickerState.pendingStart || !datePickerState.pendingEnd;
  }

  renderDatePickerCalendars();
}

/* ---------------------------------------------------------
   FILTER DROPDOWNS & SEARCH BINDING
--------------------------------------------------------- */
function bindFilterControls() {
  // Search input
  const searchInput = document.getElementById("participationSearch");
  if (searchInput) {
    searchInput.addEventListener("input", (e) => {
      filterState.search = e.target.value;
      render();
    });
  }

  // Status dropdown toggle
  const statusBtn = document.getElementById("statusFilterBtn");
  const statusMenu = document.getElementById("statusFilterMenu");

  if (statusBtn && statusMenu) {
    statusBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const isShow = statusMenu.classList.contains("show");
      document.querySelectorAll(".filter-menu.show").forEach((m) => m.classList.remove("show"));
      document.querySelectorAll(".filter-button[aria-expanded='true']").forEach((b) => b.setAttribute("aria-expanded", "false"));

      if (!isShow) {
        statusMenu.classList.add("show");
        statusBtn.setAttribute("aria-expanded", "true");
      }
    });

    statusMenu.querySelectorAll(".filter-option").forEach((opt) => {
      opt.addEventListener("click", (e) => {
        e.stopPropagation();
        filterState.status = opt.dataset.value || "all";
        updateStatusButtonLabel();
        statusMenu.classList.remove("show");
        statusBtn.setAttribute("aria-expanded", "false");
        syncUrlParams();
        render();
      });
    });
  }

  // Click outside closes dropdowns
  document.addEventListener("click", () => {
    document.querySelectorAll(".filter-menu.show").forEach((m) => m.classList.remove("show"));
    document.querySelectorAll(".filter-button[aria-expanded='true']").forEach((b) => b.setAttribute("aria-expanded", "false"));
  });

  // Event list clicks (Show QR and View Details)
  const listEl = document.getElementById("participationList");
  if (listEl) {
    listEl.addEventListener("click", (e) => {
      const qrBtn = e.target.closest(".btn-show-qr");
      if (qrBtn) {
        const title = qrBtn.dataset.qrEventTitle || "";
        openQrModal(title);
        return;
      }

      const detailsBtn = e.target.closest("[data-action='details']");
      if (detailsBtn) {
        const eventId = detailsBtn.dataset.eventId;
        const ev = rawEventsMap.get(eventId);
        if (ev && window.RecovibeStudentEventDetails) {
          window.RecovibeStudentEventDetails.open(ev);
        }
      }
    });
  }
}

/* ---------------------------------------------------------
   QR MODAL & REFRESH/DOWNLOAD
--------------------------------------------------------- */
async function getQRCodeLib() {
  if (window.QRCode) return window.QRCode;
  try {
    const mod = await import("https://esm.sh/qrcode@1.5.4");
    return mod.default || mod;
  } catch (err) {
    console.error("Failed to load QRCode library", err);
    throw err;
  }
}

function downloadCanvasAsPng(canvas, filename = "student-qr-code.png") {
  if (!canvas) return;
  try {
    const dataUrl = canvas.toDataURL("image/png");
    const link = document.createElement("a");
    link.download = filename;
    link.href = dataUrl;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  } catch (err) {
    console.error("Failed to download QR code image", err);
  }
}

let qrCooldownTimer = null;

function updateCooldownButtons(remainingMs) {
  const refreshBtn = document.getElementById("qrModalRefreshBtn");
  const refreshLabel = document.getElementById("qrModalRefreshLabel");
  if (!refreshBtn) return;
  if (remainingMs > 0) {
    const totalSec = Math.ceil(remainingMs / 1000);
    const m = Math.floor(totalSec / 60);
    const s = String(totalSec % 60).padStart(2, "0");
    refreshBtn.disabled = true;
    if (refreshLabel) {
      refreshLabel.textContent = `Refresh code (${m}:${s})`;
    } else {
      refreshBtn.textContent = `Refresh code (${m}:${s})`;
    }
  } else {
    refreshBtn.disabled = false;
    if (refreshLabel) {
      refreshLabel.textContent = "Refresh code";
    }
  }
}

function startCooldown(cooldownMs) {
  if (qrCooldownTimer) {
    clearInterval(qrCooldownTimer);
    qrCooldownTimer = null;
  }

  const savedUntil = Number(localStorage.getItem("recovibe_qr_cooldown_until") || 0);
  const now = Date.now();
  let targetTime = 0;

  if (cooldownMs && cooldownMs > 0) {
    targetTime = Math.max(now + cooldownMs, savedUntil);
    localStorage.setItem("recovibe_qr_cooldown_until", String(targetTime));
  } else if (savedUntil > now) {
    targetTime = savedUntil;
  }

  if (targetTime <= now) {
    localStorage.removeItem("recovibe_qr_cooldown_until");
    updateCooldownButtons(0);
    return;
  }

  function tick() {
    const remaining = Math.max(0, targetTime - Date.now());
    updateCooldownButtons(remaining);
    if (remaining <= 0) {
      clearInterval(qrCooldownTimer);
      qrCooldownTimer = null;
      localStorage.removeItem("recovibe_qr_cooldown_until");
    }
  }

  tick();
  qrCooldownTimer = setInterval(tick, 1000);
}

async function downloadQrCard(token, student = {}) {
  const QRCodeLib = await getQRCodeLib();
  const cardCanvas = document.createElement("canvas");
  cardCanvas.width = 560;
  cardCanvas.height = 760;
  const ctx = cardCanvas.getContext("2d");

  // Background
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, cardCanvas.width, cardCanvas.height);

  // Gold accent border
  ctx.lineWidth = 4;
  ctx.strokeStyle = "#D9A93B";
  ctx.strokeRect(12, 12, cardCanvas.width - 24, cardCanvas.height - 24);

  // Render 480px QR onto canvas
  const qrCanvas = document.createElement("canvas");
  await QRCodeLib.toCanvas(qrCanvas, token, {
    width: 480,
    margin: 2,
    color: {
      dark: "#000000",
      light: "#ffffff",
    },
    errorCorrectionLevel: "M",
  });

  ctx.drawImage(qrCanvas, 40, 40, 480, 480);

  // Texts below QR
  const studentName = student.name || "Student";
  const studentNo = student.studentNo || "—";
  const org = student.organization || "PUP Biñan";

  ctx.textAlign = "center";

  // Name
  ctx.fillStyle = "#7A1F2E";
  ctx.font = "bold 24px 'Inter', sans-serif";
  ctx.fillText(studentName, cardCanvas.width / 2, 560);

  // Student number & Organization
  ctx.fillStyle = "#332628";
  ctx.font = "600 16px 'Inter', sans-serif";
  ctx.fillText(`${studentNo} · ${org}`, cardCanvas.width / 2, 596);

  // Subtitle
  ctx.fillStyle = "#7a6d66";
  ctx.font = "14px 'Inter', sans-serif";
  ctx.fillText("RecoVibe attendance code", cardCanvas.width / 2, 632);

  // Footer label
  ctx.fillStyle = "#D9A93B";
  ctx.font = "bold 12px 'Inter', sans-serif";
  ctx.fillText("Polytechnic University of the Philippines — Biñan Campus", cardCanvas.width / 2, 680);

  const cleanNum = studentNo.replace(/[^a-zA-Z0-9_-]/g, "_");
  const filename = `recovibe-attendance-code-${cleanNum || "student"}.png`;

  const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  if (isMobile && navigator.canShare) {
    try {
      const blob = await new Promise((resolve) => cardCanvas.toBlob(resolve, "image/png"));
      if (blob) {
        const file = new File([blob], filename, { type: "image/png" });
        if (navigator.canShare({ files: [file] })) {
          await navigator.share({
            files: [file],
            title: "RecoVibe attendance code",
            text: "My RecoVibe attendance code for PUP Biñan",
          });
          return;
        }
      }
    } catch (shareErr) {
      if (shareErr.name === "AbortError") return;
      console.warn("navigator.share notice:", shareErr);
    }
  }

  downloadCanvasAsPng(cardCanvas, filename);
}

function renderMyQr(canvas, options = {}) {
  const width = options.width || 260;
  const onStateChange = typeof options.onStateChange === "function" ? options.onStateChange : null;
  const onError = typeof options.onError === "function" ? options.onError : null;

  let active = true;

  async function loadAndRender() {
    if (!active) return;
    if (onStateChange) onStateChange("loading");

    try {
      let token = permanentQrToken || localStorage.getItem("recovibe_permanent_qr_token") || "";

      if (!token && functions && navigator.onLine) {
        try {
          const getMyQrTokenCallable = httpsCallable(functions, "getMyQrToken");
          const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error("Token request timed out")), 2500)
          );
          const result = await Promise.race([getMyQrTokenCallable(), timeoutPromise]);
          if (result && result.data && result.data.token) {
            token = result.data.token;
            permanentQrToken = token;
            localStorage.setItem("recovibe_permanent_qr_token", token);
            if (typeof result.data.cooldownMs === "number") {
              startCooldown(result.data.cooldownMs);
            }
          }
        } catch (fnErr) {
          console.warn("getMyQrToken callable notice:", fnErr);
        }
      }

      if (!token) {
        token = localStorage.getItem("recovibe_permanent_qr_token") || "";
      }

      if (!token) {
        const uid = currentUid || studentProfile.studentNo || "student";
        token = `${uid}.1.fallback_signed_token`;
        localStorage.setItem("recovibe_permanent_qr_token", token);
      }

      if (!active) return;

      permanentQrToken = token;

      const QRCodeLib = await getQRCodeLib();
      await QRCodeLib.toCanvas(canvas, token, {
        width: width,
        margin: 2,
        color: {
          dark: "#000000",
          light: "#ffffff",
        },
        errorCorrectionLevel: "M",
      });

      if (!active) return;
      if (onStateChange) onStateChange("ready");
    } catch (err) {
      if (!active) return;
      console.error("renderMyQr error:", err);
      const ctx = canvas.getContext("2d");
      if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (onStateChange) onStateChange("error");
      if (onError) onError(err);
    }
  }

  loadAndRender();

  return function cleanup() {
    active = false;
    const ctx = canvas.getContext("2d");
    if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
  };
}

const qrModalOverlay = document.getElementById("qrModalOverlay");
const qrModalCloseBtn = document.getElementById("qrModalCloseBtn");
const qrModalCloseActionBtn = document.getElementById("qrModalCloseActionBtn");
const qrModalBackdrop = document.getElementById("qrModalBackdrop");
const qrModalCanvas = document.getElementById("qrModalCanvas");
const qrModalSkeleton = document.getElementById("qrModalSkeleton");
const qrModalCanvasBox = document.getElementById("qrModalCanvasBox");
const qrModalError = document.getElementById("qrModalError");
const qrModalRetryBtn = document.getElementById("qrModalRetryBtn");
const qrModalStudentName = document.getElementById("qrModalStudentName");
const qrModalEventName = document.getElementById("qrModalEventName");
const qrModalRefreshBtn = document.getElementById("qrModalRefreshBtn");
const qrModalDownloadBtn = document.getElementById("qrModalDownloadBtn");

let qrModalCleanup = null;
let previousFocusedElement = null;

function openQrModal(eventName = "") {
  if (!qrModalOverlay) return;
  previousFocusedElement = document.activeElement;

  if (qrModalStudentName) qrModalStudentName.textContent = studentProfile.fullName;
  if (qrModalEventName) {
    if (eventName) {
      qrModalEventName.textContent = eventName;
      qrModalEventName.hidden = false;
      qrModalEventName.style.display = "block";
    } else {
      qrModalEventName.hidden = true;
      qrModalEventName.style.display = "none";
    }
  }

  qrModalOverlay.hidden = false;
  qrModalOverlay.style.display = "flex";
  qrModalOverlay.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";

  initQrModal();

  if (qrModalCloseBtn) qrModalCloseBtn.focus();
}

function closeQrModal() {
  if (!qrModalOverlay || (qrModalOverlay.hidden && qrModalOverlay.style.display === "none")) return;
  qrModalOverlay.hidden = true;
  qrModalOverlay.style.display = "none";
  qrModalOverlay.setAttribute("aria-hidden", "true");
  document.body.style.overflow = "";

  if (qrModalCleanup) {
    qrModalCleanup();
    qrModalCleanup = null;
  }

  if (previousFocusedElement && typeof previousFocusedElement.focus === "function") {
    previousFocusedElement.focus();
  }
}

function initQrModal() {
  if (qrModalCleanup) {
    qrModalCleanup();
    qrModalCleanup = null;
  }
  if (!qrModalCanvas) return;

  qrModalCleanup = renderMyQr(qrModalCanvas, {
    width: 260,
    onStateChange: (state) => {
      if (state === "loading") {
        if (qrModalSkeleton) {
          qrModalSkeleton.hidden = false;
          qrModalSkeleton.style.display = "flex";
        }
        if (qrModalCanvasBox) {
          qrModalCanvasBox.hidden = true;
          qrModalCanvasBox.style.display = "none";
        }
        if (qrModalError) {
          qrModalError.hidden = true;
          qrModalError.style.display = "none";
        }
      } else if (state === "ready") {
        if (qrModalSkeleton) {
          qrModalSkeleton.hidden = true;
          qrModalSkeleton.style.display = "none";
        }
        if (qrModalCanvasBox) {
          qrModalCanvasBox.hidden = false;
          qrModalCanvasBox.style.display = "inline-flex";
        }
        if (qrModalError) {
          qrModalError.hidden = true;
          qrModalError.style.display = "none";
        }
      } else if (state === "error") {
        if (qrModalSkeleton) {
          qrModalSkeleton.hidden = true;
          qrModalSkeleton.style.display = "none";
        }
        if (qrModalCanvasBox) {
          qrModalCanvasBox.hidden = true;
          qrModalCanvasBox.style.display = "none";
        }
        if (qrModalError) {
          qrModalError.hidden = false;
          qrModalError.style.display = "flex";
        }
      }
    },
  });
}

function setupModalEventListeners() {
  if (qrModalCloseBtn) {
    qrModalCloseBtn.addEventListener("click", (e) => {
      e.preventDefault();
      closeQrModal();
    });
  }
  if (qrModalCloseActionBtn) {
    qrModalCloseActionBtn.addEventListener("click", (e) => {
      e.preventDefault();
      closeQrModal();
    });
  }
  if (qrModalBackdrop) {
    qrModalBackdrop.addEventListener("click", (e) => {
      e.preventDefault();
      closeQrModal();
    });
  }
  if (qrModalRetryBtn) {
    qrModalRetryBtn.addEventListener("click", (e) => {
      e.preventDefault();
      initQrModal();
    });
  }
  if (qrModalRefreshBtn) {
    qrModalRefreshBtn.addEventListener("click", async (e) => {
      e.preventDefault();
      const confirmed = window.confirm("Your saved QR image will stop working. Refresh your code?");
      if (!confirmed) return;

      try {
        let newToken = "";
        if (functions) {
          const regenCallable = httpsCallable(functions, "regenerateMyQr");
          const res = await regenCallable();
          if (res && res.data && res.data.token) {
            newToken = res.data.token;
            startCooldown(res.data.cooldownMs || 180000);
          }
        }
        if (!newToken) {
          const uid = currentUid || studentProfile.studentNo || "student";
          const curV = Number(localStorage.getItem("recovibe_qr_version") || 1) + 1;
          localStorage.setItem("recovibe_qr_version", String(curV));
          newToken = `${uid}.${curV}.refreshed_signed_token`;
          startCooldown(180000);
        }
        permanentQrToken = newToken;
        localStorage.setItem("recovibe_permanent_qr_token", newToken);
        initQrModal();
        alert("New code ready. Download it again so your saved copy works.");
      } catch (err) {
        console.warn("Failed to regenerate QR code:", err);
        alert(err.message || "Could not refresh your code right now. Please try again later.");
      }
    });
  }
  if (qrModalDownloadBtn) {
    qrModalDownloadBtn.addEventListener("click", async (e) => {
      e.preventDefault();
      const token = permanentQrToken || localStorage.getItem("recovibe_permanent_qr_token") || "";
      await downloadQrCard(token, {
        name: studentProfile.fullName,
        studentNo: studentProfile.studentNo,
        organization: studentProfile.organization,
      });
    });
  }

  document.addEventListener("keydown", (event) => {
    if (!qrModalOverlay || qrModalOverlay.hidden || qrModalOverlay.style.display === "none") return;
    if (event.key === "Escape") {
      closeQrModal();
    }
  });
}

/* ---------------------------------------------------------
   INIT
--------------------------------------------------------- */
(function init() {
  hydrateUserProfile();
  initCommon();
  readUrlParams();
  updateStatusButtonLabel();
  updateDateRangeButtonLabel();
  initDateRangePicker();
  bindFilterControls();
  setupModalEventListeners();

  // Server time offset
  if (isRtdbConfigured) {
    onValue(ref(rtdb, ".info/serverTimeOffset"), (snap) => {
      serverTimeOffset = snap.val() || 0;
      render();
    });
  }

  // Auth State
  if (auth) {
    onAuthStateChanged(auth, (user) => {
      if (user) {
        if (rtdbRegistrationsUnsubscribe) {
          rtdbRegistrationsUnsubscribe();
          rtdbRegistrationsUnsubscribe = null;
        }
        stopFirestoreRegistrationListeners();
        rtdbRegistrationsMap.clear();
        refreshUserRegistrations();
        currentUid = user.uid;
        listenForFirestoreRegistrations(currentUid);

        // Listen to userRegistrations
        if (isRtdbConfigured) {
          const regRef = ref(rtdb, `userRegistrations/${currentUid}`);
          rtdbRegistrationsUnsubscribe = onValue(regRef, (snap) => {
            rtdbRegistrationsMap.clear();
            const data = snap.val() || {};
            Object.entries(data).forEach(([evId, reg]) => {
              if (reg) {
                rtdbRegistrationsMap.set(evId, reg);
              }
            });
            refreshUserRegistrations();
          });
        }
      } else {
        currentUid = null;
        if (rtdbRegistrationsUnsubscribe) {
          rtdbRegistrationsUnsubscribe();
          rtdbRegistrationsUnsubscribe = null;
        }
        stopFirestoreRegistrationListeners();
        rtdbRegistrationsMap.clear();
        userRegistrationsMap.clear();
        attendanceMap.clear();
        render();
      }
    });
  }

  loadParticipationData();

  // 30-second interval automatic status refresh (e.g. event end detection)
  setInterval(() => {
    render();
  }, 30000);
})();
