import { auth, db, rtdb, functions, isFirebaseConfigured, isRtdbConfigured } from "./firebaseConfig.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  collectionGroup,
  doc,
  getDoc,
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
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js";

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
let authResolved = false;
let profileResolved = false;
let participationLoading = true;
let firestoreEventsLoaded = false;
let publicEventsLoaded = false;
const pendingInitialRegistrationSnapshots = new Set();
const registrationLogIds = new Set();
const loggedUnmatchedRegistrationIds = new Set();
const isDevelopment = () =>
  globalThis.process?.env?.NODE_ENV
    ? globalThis.process.env.NODE_ENV !== "production"
    : import.meta.env?.DEV === true ||
      ["localhost", "127.0.0.1", "::1"].includes(globalThis.location?.hostname);

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
const rtdbRegistrationsMap = new Map();
const firestoreRegistrationsMap = new Map();
const attendanceMap = new Map(); // id -> { scannedAt, scannedBy, walkIn }
const attendanceListeners = new Map(); // id -> unsub

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
let firestoreRegistrationGeneration = 0;
let rtdbRegistrationsUnsubscribe = null;
let serverTimeOffsetUnsubscribe = null;
let authUnsubscribe = null;
let statusRefreshInterval = null;
let firestoreParticipationError = false;
let firestoreParticipationErrorMessage = "";

/* ---------------------------------------------------------
   TIME & DATE UTILITIES (Philippine Time Asia/Manila)
--------------------------------------------------------- */
function getNow() {
  return Date.now() + (serverTimeOffset || 0);
}

function toPhDateStr(timestamp) {
  const d = new Date(timestamp);
  if (!Number.isFinite(d.getTime())) return "";
  return d.toLocaleDateString("en-CA", { timeZone: "Asia/Manila" });
}

function dateValueToMillis(value, timeValue = "", useEndOfDay = false) {
  if (value == null || value === "") return 0;
  if (typeof value === "number") return value;
  if (value instanceof Date) return value.getTime();
  if (typeof value?.toMillis === "function") return value.toMillis();
  if (typeof value?.toDate === "function") return value.toDate().getTime();
  if (Number.isFinite(value?.seconds)) return value.seconds * 1000;
  if (Number.isFinite(value?._seconds)) return value._seconds * 1000;

  const text = String(value).trim();
  const dateMatch = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const localDateTimeMatch = text.match(
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?$/,
  );
  const hasTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text);
  if (localDateTimeMatch) {
    const [, year, month, day, hour, minute, second = "0"] = localDateTimeMatch;
    return Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour) - 8,
      Number(minute),
      Number(second),
    );
  }
  if (!dateMatch && hasTimezone) {
    const parsed = Date.parse(text);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  if (!dateMatch) {
    const parsed = Date.parse(text);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  const [, year, month, day] = dateMatch;
  let hour = useEndOfDay ? 23 : 0;
  let minute = useEndOfDay ? 59 : 0;
  let second = useEndOfDay ? 59 : 0;
  let millisecond = useEndOfDay ? 999 : 0;
  const timeMatch = String(timeValue || "").trim().match(
    /^(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?\s*(AM|PM)?$/i,
  );
  if (timeMatch) {
    hour = Number(timeMatch[1]);
    minute = Number(timeMatch[2] || 0);
    second = Number(timeMatch[3] || 0);
    const meridiem = String(timeMatch[4] || "").toUpperCase();
    if (meridiem === "PM" && hour < 12) hour += 12;
    if (meridiem === "AM" && hour === 12) hour = 0;
    millisecond = 0;
  }
  return Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    hour - 8,
    minute,
    second,
    millisecond,
  );
}

function formatPhDatePretty(isoStr) {
  if (!isoStr) return "";
  const [y, m, d] = isoStr.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function formatTimeShort(ms) {
  if (!ms) return "";
  const d = new Date(dateValueToMillis(ms));
  if (!Number.isFinite(d.getTime())) return "";
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
function readCachedProfile() {
  try {
    return JSON.parse(
      localStorage.getItem("recovibeCurrentUser") ||
      sessionStorage.getItem("recovibeCurrentUser") ||
      "null",
    ) || {};
  } catch (error) {
    console.warn("Could not read the cached student profile:", error);
    return {};
  }
}

function applyStudentProfile(profile, authUser = null) {
  const storedFirstName = String(profile.firstName || "").trim();
  const storedFullName = String(profile.fullName || profile.name || "").trim();
  const nameFromProfile = [
    storedFirstName,
    profile.middleName,
    profile.lastName,
  ]
    .map((part) => String(part || "").trim())
    .filter(Boolean)
    .join(" ");
  const displayName =
    storedFullName ||
    nameFromProfile ||
    String(authUser?.displayName || "").trim() ||
    "Student";
  const firstName =
    storedFirstName || displayName.split(/\s+/).filter(Boolean)[0] || "Student";

  studentProfile.firstName = firstName;
  studentProfile.middleName = String(profile.middleName || "").trim();
  studentProfile.lastName = String(profile.lastName || "").trim();
  studentProfile.fullName = displayName;
  studentProfile.studentNo = String(
    profile.studentNumber ||
    profile.studentId ||
    profile.username ||
    "2025-00790-BN-1",
  ).trim();
  studentProfile.organization = String(
    profile.organization ||
    profile.courseOrganization ||
    profile.courseOrg ||
    profile.organizationCode ||
    profile.organizationName ||
    "",
  ).trim();
  studentProfile.courseOrganization = String(
    profile.courseOrganization || profile.courseOrg || studentProfile.organization,
  ).trim();
  studentProfile.courseOrg = String(profile.courseOrg || studentProfile.organization).trim();
  studentProfile.department = String(profile.department || profile.departmentCode || "").trim();
  studentProfile.departmentCode = String(profile.departmentCode || profile.department || "").trim();

  const avatarFallback = [
    profile.username,
    profile.studentNumber,
    profile.studentId,
    profile.email,
    authUser?.email,
  ]
    .map((value) => String(value || "").trim())
    .find(Boolean) || "";
  const avatarLetter =
    Array.from(firstName || avatarFallback)[0]?.toLocaleUpperCase() || "S";
  const role =
    studentProfile.organization && studentProfile.organization.toLowerCase() !== "none"
      ? studentProfile.organization
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

async function hydrateUserProfile(authUser) {
  const cachedProfile = readCachedProfile();
  let profile = cachedProfile;
  if (db && authUser?.uid) {
    try {
      const profileSnapshot = await getDoc(doc(db, "users", authUser.uid));
      if (profileSnapshot.exists()) {
        profile = { ...cachedProfile, ...profileSnapshot.data() };
        try {
          localStorage.setItem(
            "recovibeCurrentUser",
            JSON.stringify({ ...profile, uid: authUser.uid }),
          );
        } catch (error) {
          console.warn("Could not cache the Firestore student profile:", error);
        }
      }
    } catch (error) {
      console.error("Could not load the Firestore student profile:", error);
      profile = cachedProfile;
    }
  }
  applyStudentProfile(profile, authUser);
  profileResolved = true;
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

  if (filterState.status && filterState.status !== "participating") {
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
  const rawDate =
    raw.eventDate ||
    raw.dateISO ||
    raw.start_date ||
    raw.startDate ||
    raw.date ||
    raw.dateStart ||
    raw.schedule?.date ||
    raw.schedule?.startDate ||
    "";
  const rawDateText = String(rawDate || "");
  const rawDateMillis = Date.parse(rawDateText);
  const rawDateIsTimestamp =
    rawDate instanceof Date ||
    typeof rawDate?.toDate === "function" ||
    typeof rawDate?.toMillis === "function" ||
    Number.isFinite(rawDate?.seconds) ||
    Number.isFinite(rawDate?._seconds);
  const dateISO = rawDateIsTimestamp
    ? toPhDateStr(dateValueToMillis(rawDate))
    : /T.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(rawDateText) && Number.isFinite(rawDateMillis)
      ? toPhDateStr(rawDateMillis)
      : rawDateText.slice(0, 10);
  const timeStr =
    raw.time ||
    [raw.timeStart || raw.startTime, raw.timeEnd || raw.endTime]
      .filter(Boolean)
      .join(" - ") ||
    "08:00 AM";
  const startTime = raw.timeStart || raw.startTime || String(timeStr).split(/\s+-\s+/)[0];
  const endTime = raw.timeEnd || raw.endTime || String(timeStr).split(/\s+-\s+/)[1] || "";
  const startValue =
    raw.startAt ||
    raw.start_at ||
    raw.startDateTime ||
    raw.start_date_time ||
    raw.schedule?.startAt ||
    raw.schedule?.startDateTime ||
    (/T.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(rawDateText) ? rawDateText : dateISO);
  const startAt = dateValueToMillis(startValue, startTime);
  const rawEndDate =
    raw.endDate ||
    raw.end_date ||
    raw.dateEnd ||
    raw.date_end ||
    raw.schedule?.endDate ||
    raw.schedule?.end_date;
  const rawEndDateIsTimestamp =
    rawEndDate instanceof Date ||
    typeof rawEndDate?.toDate === "function" ||
    typeof rawEndDate?.toMillis === "function" ||
    Number.isFinite(rawEndDate?.seconds) ||
    Number.isFinite(rawEndDate?._seconds);
  const endDateValue = rawEndDateIsTimestamp
    ? toPhDateStr(dateValueToMillis(rawEndDate))
    : rawEndDate || dateISO;
  const explicitEndValue =
    raw.endAt ||
    raw.end_at ||
    raw.endDateTime ||
    raw.end_date_time ||
    raw.schedule?.endAt ||
    raw.schedule?.endDateTime;
  let endAt = explicitEndValue
    ? dateValueToMillis(explicitEndValue, endTime, !endTime)
    : endDateValue
      ? dateValueToMillis(endDateValue, endTime, !endTime)
      : 0;
  if (!endAt && startAt) {
    endAt = endTime
      ? dateValueToMillis(toPhDateStr(startAt), endTime)
      : startAt + 2 * 3600 * 1000;
    if (endAt <= startAt && endTime) endAt += 24 * 3600 * 1000;
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
    organizerName: raw.organizerName || raw.orgName || raw.org || raw.organizer || "Event Organizer",
    tag: raw.tag || "",
  };
}

function getRegistrationStatus(registration = {}) {
  return String(registration.status || registration.registrationStatus || "registered")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
}

function isActiveRegistration(registration) {
  return ["registered", "active", "confirmed"].includes(
    getRegistrationStatus(registration),
  );
}

function getParticipationStatus(registration, event, now) {
  const eventId = String(event?.id || registration?.eventId || "unknown");
  const eventStatus = String(event?.status || "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
  const registrationStatus = getRegistrationStatus(registration);
  const attendance = attendanceMap.get(eventId) || {};
  const attended =
    Boolean(
      attendance.scannedAt ||
      attendance.checkedInAt ||
      attendance.checkInAt ||
      attendance.attended,
    ) ||
    Boolean(
      registration.scannedAt ||
      registration.checkedInAt ||
      registration.checkInAt ||
      registration.attended ||
      ["attended", "completed", "checkedin"].includes(registrationStatus),
    );
  let status;
  if (
    ["cancelled", "canceled"].includes(eventStatus) ||
    ["cancelled", "canceled"].includes(registrationStatus)
  ) {
    status = "cancelled";
  } else if (!event?.endAt || now < event.endAt) {
    status = "upcoming";
  } else {
    status = attended ? "completed" : "absent";
  }

  const logKey = `${eventId}:${registration.uid || currentUid || "student"}`;
  if (isDevelopment() && !registrationLogIds.has(logKey)) {
    registrationLogIds.add(logKey);
    console.log({
      eventId,
      title: event?.title || registration.title || "Unmatched registration",
      status,
    });
  }
  return status;
}

function refreshUserRegistrations() {
  userRegistrationsMap.clear();
  for (const [eventId, registration] of rtdbRegistrationsMap) {
    userRegistrationsMap.set(eventId, registration);
  }
  for (const [eventId, registration] of firestoreRegistrationsMap) {
    userRegistrationsMap.set(eventId, registration);
  }
  syncAttendanceListeners();
  reportUnmatchedRegistrations();
  updateParticipationLoadingState();
  render();
}

function stopFirestoreRegistrationListeners() {
  if (firestoreEventsUnsubscribe) {
    firestoreEventsUnsubscribe();
    firestoreEventsUnsubscribe = null;
  }
  firestoreRegistrationGeneration += 1;
  firestoreRegistrationsMap.clear();
  pendingInitialRegistrationSnapshots.clear();
  firestoreEventsLoaded = false;
}

function updateParticipationLoadingState() {
  participationLoading =
    !authResolved ||
    !profileResolved ||
    (!firestoreEventsLoaded && Boolean(db && isFirebaseConfigured)) ||
    pendingInitialRegistrationSnapshots.size > 0;
}

function maybeFinishInitialLoad() {
  updateParticipationLoadingState();
  render();
}

function reportUnmatchedRegistrations() {
  if (!firestoreEventsLoaded || !publicEventsLoaded || pendingInitialRegistrationSnapshots.size) return;
  for (const [eventId, registration] of userRegistrationsMap) {
    if (rawEventsMap.has(eventId) || loggedUnmatchedRegistrationIds.has(eventId)) continue;
    loggedUnmatchedRegistrationIds.add(eventId);
    console.warn(
      `[My Participation] Registration could not be joined to an event document: ${eventId}`,
      registration,
    );
  }
}

function listenForFirestoreRegistrations(uid) {
  stopFirestoreRegistrationListeners();
  if (!db || !isFirebaseConfigured || !uid) {
    firestoreEventsLoaded = true;
    updateParticipationLoadingState();
    return;
  }

  const generation = firestoreRegistrationGeneration;
  firestoreEventsUnsubscribe = onFirestoreSnapshot(
    firestoreQuery(
      collectionGroup(db, "registrations"),
      where("uid", "==", uid),
    ),
    async (snapshot) => {
      if (generation !== firestoreRegistrationGeneration) return;
      firestoreParticipationError = false;
      firestoreParticipationErrorMessage = "";
      firestoreRegistrationsMap.clear();
      const eventSnapshots = [];
      pendingInitialRegistrationSnapshots.clear();
      snapshot.forEach((eventSnapshot) => {
        const registration = eventSnapshot.data();
        const eventRef = eventSnapshot.ref.parent.parent;
        if (!eventRef) {
          console.warn(
            `[My Participation] Could not resolve parent event for registration ${eventSnapshot.ref.path}.`,
          );
          return;
        }
        const eventId = eventRef.id;
        firestoreRegistrationsMap.set(eventId, {
          ...registration,
          eventId,
          uid: registration.uid || uid,
          status: registration.status || "registered",
          at: registration.registeredAt || registration.at || 0,
        });
        if (!rawEventsMap.has(eventId)) {
          pendingInitialRegistrationSnapshots.add(eventId);
          eventSnapshots.push({ eventId, eventRef });
        }
      });

      firestoreEventsLoaded = true;
      updateParticipationLoadingState();
      refreshUserRegistrations();

      const eventReadResults = await Promise.allSettled(
        eventSnapshots.map(async ({ eventId, eventRef }) => {
          const eventSnapshot = await getDoc(eventRef);
          if (!eventSnapshot.exists()) {
            throw new Error(`Event document ${eventId} no longer exists.`);
          }
          rawEventsMap.set(
            eventId,
            normalizeEventData(eventId, eventSnapshot.data()),
          );
          pendingInitialRegistrationSnapshots.delete(eventId);
        }),
      );
      if (generation !== firestoreRegistrationGeneration) return;
      eventReadResults.forEach((result, index) => {
        if (result.status === "rejected") {
          const { eventId } = eventSnapshots[index];
          pendingInitialRegistrationSnapshots.delete(eventId);
          if (result.reason?.code === "permission-denied") {
            console.info(
              `[My Participation] Skipping event ${eventId}; student event-read rules exclude it.`,
            );
          } else {
            firestoreParticipationError = true;
            firestoreParticipationErrorMessage =
              "Could not load one or more events linked to your registrations. Retry the request.";
            console.error(
              `Could not load event ${eventId} for the student's registration:`,
              result.reason,
            );
          }
        }
      });
      updateParticipationLoadingState();
      refreshUserRegistrations();
    },
    (error) => {
      console.error("Could not load the student's Firestore registrations:", error);
      firestoreParticipationError = true;
      firestoreParticipationErrorMessage =
        error?.code === "permission-denied"
          ? "Firestore denied access to your registration records. Ask an administrator to deploy the student registration rules."
          : "Could not load your registrations. Check your connection and retry.";
      firestoreEventsLoaded = true;
      pendingInitialRegistrationSnapshots.clear();
      updateParticipationLoadingState();
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

function stopAttendanceListeners() {
  attendanceListeners.forEach((unsubscribe) => unsubscribe());
  attendanceListeners.clear();
  attendanceMap.clear();
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

  refreshUserRegistrations();

  // RTDB Public Events Query
  if (isRtdbConfigured) {
    if (!activePublicEventsRef || !activePublicEventsListener) {
      const eventsRoot = ref(rtdb, "publicEvents");
      const q = query(eventsRoot, orderByChild("startAt"));

      activePublicEventsRef = q;
      activePublicEventsListener = onValue(
        q,
        (snapshot) => {
          if (snapshot.exists()) {
            snapshot.forEach((child) => {
              try {
                const ev = normalizeEventData(child.key, child.val());
                rawEventsMap.set(ev.id, ev);
              } catch (error) {
                console.warn(`[My Participation] Skipping invalid public event ${child.key}:`, error);
              }
            });
          }
          firestoreParticipationError = false;
          firestoreParticipationErrorMessage = "";
          publicEventsLoaded = true;
          reportUnmatchedRegistrations();
          render();
        },
        (error) => {
          console.error("Could not load public events for participation:", error);
          firestoreParticipationError = true;
          publicEventsLoaded = true;
          reportUnmatchedRegistrations();
          render();
        },
      );
    }
  } else {
    publicEventsLoaded = true;
    reportUnmatchedRegistrations();
    render();
  }
}

/* ---------------------------------------------------------
   SUMMARY METRICS & FILTERED RENDERING
--------------------------------------------------------- */
function render() {
  const listEl = document.getElementById("participationList");
  const countEl = document.getElementById("participationCount");
  if (!listEl) return;

  if (participationLoading) {
    if (countEl) countEl.textContent = "";
    listEl.innerHTML = `
      <div class="empty-participation" role="status">
        <p style="margin:0 0 6px; font-weight:600; color:var(--ink-700);">Loading participation...</p>
        <span style="font-size:12.5px; color:var(--ink-500);">Checking your account and registrations.</span>
      </div>`;
    return;
  }

  if (!currentUid) {
    if (countEl) countEl.textContent = "";
    listEl.innerHTML = `
      <div class="empty-participation" role="alert">
        <p style="margin:0 0 6px; font-weight:600; color:var(--ink-700);">Sign in to view your participation.</p>
        <a href="StudentLogin.html">Go to sign in</a>
      </div>`;
    return;
  }

  const participationRows = [...userRegistrationsMap.entries()]
    .map(([eventId, registration]) => {
      const event = rawEventsMap.get(eventId);
      if (!event) return null;
      return {
        event,
        registration,
        status: getParticipationStatus(registration, event, getNow()),
      };
    })
    .filter(Boolean);

  let completedCount = 0;
  let absentCount = 0;
  let upcomingCount = 0;
  for (const row of participationRows) {
    if (row.status === "completed") completedCount++;
    else if (row.status === "absent") absentCount++;
    else if (row.status === "upcoming") upcomingCount++;
  }
  const attendanceDenominator = completedCount + absentCount;
  const attendanceRate = attendanceDenominator
    ? `${Math.round((completedCount / attendanceDenominator) * 100)}%`
    : "—";

  const completedEl =
    document.getElementById("metricAttended") ||
    document.getElementById("metricCompleted");
  if (completedEl) completedEl.textContent = String(completedCount);
  const absentEl = document.getElementById("metricAbsent");
  const upcomingEl = document.getElementById("metricUpcoming");
  const rateEl = document.getElementById("metricRate");
  if (absentEl) absentEl.textContent = String(absentCount);
  if (upcomingEl) upcomingEl.textContent = String(upcomingCount);
  if (rateEl) rateEl.textContent = attendanceRate;

  const queryText = filterState.search.trim().toLowerCase();
  const visibleRows = participationRows.filter(({ event, status }) => {
    if (filterState.from && filterState.to) {
      const startDay = toPhDateStr(event.startAt);
      if (!startDay || startDay < filterState.from || startDay > filterState.to) return false;
    }

    if (filterState.status !== "all") {
      const expectedStatus =
        filterState.status === "participating" || filterState.status === "registered"
          ? "upcoming"
          : filterState.status === "attended"
            ? "completed"
            : filterState.status;
      if (expectedStatus === "rescheduled") {
        if (!String(event.status || "").toLowerCase().includes("resched")) return false;
      } else if (status !== expectedStatus) {
        return false;
      }
    }

    if (queryText) {
      const searchable = [
        event.title,
        event.organizerName,
        event.location,
        event.source,
        event.category,
        event.room,
      ]
        .join(" ")
        .toLowerCase();
      if (!searchable.includes(queryText)) return false;
    }
    return true;
  });
  visibleRows.sort((a, b) => (b.event.startAt || 0) - (a.event.startAt || 0));

  if (countEl) {
    countEl.textContent = `${visibleRows.length} event${visibleRows.length === 1 ? "" : "s"}`;
  }

  if (visibleRows.length === 0) {
    if (firestoreParticipationError) {
      listEl.innerHTML = `
        <div class="empty-participation" role="alert">
          <p style="margin:0 0 6px; font-weight:600; color:var(--ink-700);">Could not sync participation records.</p>
          <span style="font-size:12.5px; color:var(--ink-500);">${escapeHTML(firestoreParticipationErrorMessage || "Check your connection and try again.")}</span>
          <button type="button" class="btn-view-details" data-action="retry-participation">Retry</button>
        </div>`;
      renderActiveChips(participationRows.length, visibleRows.length);
      return;
    }
    listEl.innerHTML = `
      <div class="empty-participation">
        <p style="margin:0 0 6px; font-weight:600; color:var(--ink-700);">No events match your filters.</p>
        <button type="button" class="btn-view-details" data-action="clear-participation-filters">Clear filters</button>
      </div>`;
    renderActiveChips(participationRows.length, visibleRows.length);
    return;
  }

  listEl.innerHTML = visibleRows
    .map(({ event, registration, status }) => {
      const att = attendanceMap.get(event.id);

      const startDateObj = new Date(event.startAt || getNow());
      const monthShort = startDateObj.toLocaleDateString("en-US", { timeZone: "Asia/Manila", month: "short" });
      const dayNum = startDateObj.toLocaleDateString("en-US", { timeZone: "Asia/Manila", day: "numeric" });
      const yearNum = startDateObj.toLocaleDateString("en-US", { timeZone: "Asia/Manila", year: "numeric" });

      const startTimeStr = formatTimeShort(event.startAt);
      const endTimeStr = formatTimeShort(event.endAt);
      const timeDisplay = startTimeStr && endTimeStr ? `${startTimeStr} - ${endTimeStr}` : (startTimeStr || "TBA");

      let statusBadgeHtml = "";
      if (status === "completed") {
        const timeScanned = att?.scannedAt ? formatTimeShort(att.scannedAt) : "";
        statusBadgeHtml = `
          <span class="attendance-tag is-checked-in">
            Completed${timeScanned ? ` · checked in ${escapeHTML(timeScanned)}` : ""}
          </span>`;
      } else if (status === "absent") {
        statusBadgeHtml = `<span class="attendance-tag is-absent">Absent</span>`;
      } else if (status === "cancelled") {
        statusBadgeHtml = `<span class="attendance-tag is-cancelled">Cancelled</span>`;
      } else {
        statusBadgeHtml = `<span class="attendance-tag is-registered">Upcoming</span>`;
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
            <p class="participation-source">${escapeHTML(event.organizerName || "Event Organizer")}</p>
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
            ${
              status === "upcoming" && isActiveRegistration(registration)
                ? `<button type="button" class="btn-show-qr" data-qr-event-title="${escapeHTML(event.title)}">
                    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" width="14" height="14" aria-hidden="true">
                      <rect x="3" y="3" width="5" height="5" rx="1"/>
                      <rect x="12" y="3" width="5" height="5" rx="1"/>
                      <rect x="3" y="12" width="5" height="5" rx="1"/>
                      <path d="M12 12h2v2h-2zM15 15h2v2h-2zM15 12h2v1h-2zM12 15h1v2h-1z"/>
                    </svg>
                    Show QR
                  </button>`
                : ""
            }
            <button type="button" class="btn-view-details" data-action="details" data-event-id="${escapeHTML(event.id)}">
              View Details
            </button>
          </div>
        </article>`;
    })
    .join("");

  renderActiveChips(participationRows.length, visibleRows.length);
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
        filterState.status = "all";
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
        filterState.status = "all";
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
    all: "All statuses",
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
      const isActive =
        val === filterState.status ||
        (val === "participating" && filterState.status === "registered");
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
  const allStatusMenu = document.getElementById("statusFilterMenu");
  if (allStatusMenu && !allStatusMenu.querySelector("[data-value='all']")) {
    const allOption = document.createElement("button");
    allOption.type = "button";
    allOption.className = "filter-option";
    allOption.dataset.value = "all";
    allOption.textContent = "All statuses";
    allStatusMenu.prepend(allOption);
  }

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
      const retryButton = e.target.closest("[data-action='retry-participation']");
      if (retryButton) {
        firestoreParticipationError = false;
        participationLoading = true;
        if (activePublicEventsRef && activePublicEventsListener) {
          off(activePublicEventsRef, "value", activePublicEventsListener);
          activePublicEventsRef = null;
          activePublicEventsListener = null;
        }
        publicEventsLoaded = !isRtdbConfigured;
        listenForFirestoreRegistrations(currentUid);
        loadParticipationData();
        render();
        return;
      }

      const clearButton = e.target.closest("[data-action='clear-participation-filters']");
      if (clearButton) {
        filterState.search = "";
        filterState.status = "all";
        filterState.from = "";
        filterState.to = "";
        filterState.quickPreset = "all";
        const searchInput = document.getElementById("participationSearch");
        if (searchInput) searchInput.value = "";
        updateStatusButtonLabel();
        updateDateRangeButtonLabel();
        syncUrlParams();
        render();
        return;
      }

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
function cleanupParticipationListeners() {
  if (authUnsubscribe) {
    authUnsubscribe();
    authUnsubscribe = null;
  }
  if (rtdbRegistrationsUnsubscribe) {
    rtdbRegistrationsUnsubscribe();
    rtdbRegistrationsUnsubscribe = null;
  }
  if (activePublicEventsRef && activePublicEventsListener) {
    off(activePublicEventsRef, "value", activePublicEventsListener);
    activePublicEventsRef = null;
    activePublicEventsListener = null;
  }
  if (serverTimeOffsetUnsubscribe) {
    off(ref(rtdb, ".info/serverTimeOffset"), "value", serverTimeOffsetUnsubscribe);
    serverTimeOffsetUnsubscribe = null;
  }
  if (firestoreEventsUnsubscribe) {
    firestoreEventsUnsubscribe();
    firestoreEventsUnsubscribe = null;
  }
  firestoreRegistrationGeneration += 1;
  stopAttendanceListeners();
  if (statusRefreshInterval) {
    clearInterval(statusRefreshInterval);
    statusRefreshInterval = null;
  }
}

(function init() {
  applyStudentProfile(readCachedProfile());
  initCommon();
  readUrlParams();
  updateStatusButtonLabel();
  updateDateRangeButtonLabel();
  initDateRangePicker();
  bindFilterControls();
  setupModalEventListeners();

  // Server time offset
  if (isRtdbConfigured) {
    const offsetRef = ref(rtdb, ".info/serverTimeOffset");
    serverTimeOffsetUnsubscribe = onValue(offsetRef, (snap) => {
      serverTimeOffset = snap.val() || 0;
      render();
    });
  }

  // Auth State
  if (auth) {
    authUnsubscribe = onAuthStateChanged(auth, async (user) => {
      authResolved = true;
      if (user) {
        const uidChanged = currentUid !== user.uid;
        if (uidChanged) {
          stopFirestoreRegistrationListeners();
          stopAttendanceListeners();
          rtdbRegistrationsMap.clear();
          firestoreRegistrationsMap.clear();
          userRegistrationsMap.clear();
          loggedUnmatchedRegistrationIds.clear();
          firestoreParticipationError = false;
        }
        currentUid = user.uid;
        profileResolved = false;
        participationLoading = true;
        render();
        await hydrateUserProfile(user);
        profileResolved = true;

        if (rtdbRegistrationsUnsubscribe) {
          rtdbRegistrationsUnsubscribe();
          rtdbRegistrationsUnsubscribe = null;
        }
        listenForFirestoreRegistrations(currentUid);

        // RTDB registration mirror keyed by student UID, then event ID.
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
          }, (error) => {
            console.error("Could not load RTDB student registrations:", error);
            firestoreParticipationError = true;
            render();
          });
        }

        loadParticipationData();
        maybeFinishInitialLoad();
      } else {
        currentUid = null;
        profileResolved = true;
        if (rtdbRegistrationsUnsubscribe) {
          rtdbRegistrationsUnsubscribe();
          rtdbRegistrationsUnsubscribe = null;
        }
        stopFirestoreRegistrationListeners();
        stopAttendanceListeners();
        rtdbRegistrationsMap.clear();
        firestoreRegistrationsMap.clear();
        userRegistrationsMap.clear();
        firestoreEventsLoaded = true;
        publicEventsLoaded = true;
        participationLoading = false;
        render();
      }
    }, (error) => {
      console.error("Could not resolve student authentication state:", error);
      authResolved = true;
      profileResolved = true;
      firestoreEventsLoaded = true;
      publicEventsLoaded = true;
      participationLoading = false;
      firestoreParticipationError = true;
      render();
    });
  } else {
    authResolved = true;
    profileResolved = true;
    firestoreEventsLoaded = true;
    publicEventsLoaded = true;
    participationLoading = false;
    render();
  }

  // 30-second interval automatic status refresh (e.g. event end detection)
  statusRefreshInterval = setInterval(() => {
    render();
  }, 30000);

  window.addEventListener("pagehide", cleanupParticipationListeners, { once: true });
})();
