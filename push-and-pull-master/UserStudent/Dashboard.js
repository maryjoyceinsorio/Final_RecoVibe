/**
 * RecoVibe - Student Dashboard
 * PUP Biñan Campus Student Platform
 *
 * Implements:
 * - Server-time aligned schedule (.info/serverTimeOffset)
 * - Happening now section with live badge, progress bar, checked-in counter, and inline QR
 * - Upcoming events section with starts-in countdown and quick registration
 * - Recommended for you section matching student preferences
 * - PUP Connect! universal search with text highlighting
 * - Interactive Calendar preview with glowing live dots, registered dots, and day details
 * - 30-second interval automatic state transition without page reload
 * - Live screen reader announcements and offline support
 */

import {
  auth,
  db,
  rtdb,
  functions,
  isFirebaseConfigured,
  isRtdbConfigured,
} from "./firebaseConfig.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  collection,
  doc,
  getDoc,
  onSnapshot,
  query,
  runTransaction,
  where,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  ref,
  onValue,
  off,
  set,
  remove,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js";
import { fetchMonthHolidays } from "../holidayService.js";
import { isEventVisibleToStudent } from "./eventAudience.js";

/* ---------------------------------------------------------
   STATE
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
  StudentOrgs: [],
  departments: [],
};

function uniqueProfileValues(...values) {
  const seen = new Set();
  return values
    .flatMap((value) => Array.isArray(value) ? value : value == null ? [] : [value])
    .filter((value) => typeof value === "string" || typeof value === "number")
    .map((value) => String(value).trim())
    .filter((value) => {
      const key = value.toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

const studentPreferences = {
  categories: [],
  sources: [],
  tags: [],
  organizations: [],
};

let rawEventsMap = new Map(); // id -> normalized event
let realtimeEventsMap = new Map();
let firestoreEventsMap = new Map();
let unsubscribeFirestoreEvents = null;
let retryEventFetch = null;
let eventFetchLoading = true;
let eventFetchError = null;
let registeredEventIds = new Set();
const firestoreRegistrationListeners = new Map();
let firestoreRegistrationListenerUid = null;
const attendanceMap = new Map(); // eventId -> { scannedAt, scannedBy, walkIn }
const attendanceListeners = new Map(); // eventId -> unsub function
const registrationSyncIds = new Set();
const pendingRegistrationIds = new Set();
let openQrEventId = null; // Event ID whose inline QR is displayed
const openDetailsEventIds = new Set(); // Set of event IDs whose details are open

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const nowInitial = new Date();
const state = {
  query: "",
  calMonth: nowInitial.getMonth(),
  calYear: nowInitial.getFullYear(),
  calSelectedDate: new Date(nowInitial.getFullYear(), nowInitial.getMonth(), nowInitial.getDate()),
};

const activeCleanups = [];
let tickInterval = null;


let currentMonthHolidays = [];
let lastFetchedHolidayMonth = -1;
let lastFetchedHolidayYear = -1;

function isHolidayEvent(ev) {
  if (!ev) return false;
  const id = String(ev.id || ev.eventId || "");
  const src = String(ev.source || "").toLowerCase();
  const cat = String(ev.category || "").toLowerCase();
  return (
    ev.isHoliday === true ||
    id.startsWith("holiday:") ||
    src.includes("holiday") ||
    cat.includes("holiday")
  );
}

async function syncMonthHolidays() {
  const y = state.calYear;
  const m = state.calMonth;
  if (lastFetchedHolidayYear === y && lastFetchedHolidayMonth === m) return;
  lastFetchedHolidayYear = y;
  lastFetchedHolidayMonth = m;
  try {
    const list = await fetchMonthHolidays(y, m);
    if (state.calYear === y && state.calMonth === m) {
      currentMonthHolidays = Array.isArray(list) ? list : [];
      renderCalendar();
    }
  } catch (err) {
    console.warn("Could not load month holidays for calendar preview:", err);
  }
}

/* ---------------------------------------------------------
   TIME HELPERS
--------------------------------------------------------- */
function getNow() {
  return Date.now() + serverTimeOffset;
}

function getGreetingPrefix(now) {
  const hour = new Date(now).getHours();
  if (hour < 12) return "Good Morning";
  if (hour === 12) return "Good Noon";
  if (hour < 18) return "Good Afternoon";
  return "Good Evening";
}

function formatTime(val) {
  if (!val) return "";
  const d = typeof val === "number" ? new Date(val) : new Date(String(val));
  if (isNaN(d.getTime())) return String(val);
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
}

function formatDate(val) {
  if (!val) return "";
  const d = typeof val === "number" ? new Date(val) : new Date(String(val));
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function formatTimeRange(startMs, endMs) {
  return `${formatTime(startMs)} – ${formatTime(endMs)}`;
}

function formatRemainingTime(ms) {
  if (ms <= 0) return "Ending now";
  const totalMins = Math.floor(ms / 60000);
  const hours = Math.floor(totalMins / 60);
  const mins = totalMins % 60;
  if (hours > 0) {
    return mins > 0 ? `Ends in ${hours}h ${mins}m` : `Ends in ${hours}h`;
  }
  return mins > 0 ? `Ends in ${mins}m` : "Ends in <1m";
}

function formatStartsIn(ms) {
  if (ms <= 0) return "Starting now";
  const totalMins = Math.floor(ms / 60000);
  const hours = Math.floor(totalMins / 60);
  const mins = totalMins % 60;
  if (hours > 0) {
    return mins > 0 ? `Starts in ${hours}h ${mins}m` : `Starts in ${hours}h`;
  }
  return `Starts in ${Math.max(1, mins)}m`;
}

function escapeHtml(str) {
  if (str == null) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getPublicDocumentLinks(event) {
  const documents = [];
  const addDocument = (entry, fallbackName) => {
    if (typeof entry === "string") {
      documents.push({ name: fallbackName, url: entry });
      return;
    }
    if (!entry || typeof entry !== "object") return;
    const url = entry.url || entry.downloadURL || entry.downloadUrl || entry.fileUrl || entry.path;
    if (url) documents.push({ name: entry.name || entry.fileName || fallbackName, url });
  };

  [event.participantDocuments].forEach((list) => {
    if (Array.isArray(list)) list.forEach((entry, index) => addDocument(entry, `Event document ${index + 1}`));
  });
  const seen = new Set();
  return documents.filter(({ url }) => {
    try {
      const parsed = new URL(String(url));
      if (parsed.protocol !== "https:" || seen.has(parsed.href)) return false;
      seen.add(parsed.href);
      return true;
    } catch {
      return false;
    }
  });
}

function renderPublicDocumentLinks(event) {
  const documents = getPublicDocumentLinks(event);
  if (!documents.length) return "";
  return `
    <div class="inline-details-row">
      <span class="inline-details-label">Attached documents</span>
      <div class="inline-details-desc">${documents.map((document) =>
        `<a href="${escapeHtml(document.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(document.name)}</a>`,
      ).join("<br>")}</div>
    </div>
  `;
}

function highlightMatch(text, query) {
  if (!query || !text) return escapeHtml(text);
  const q = query.trim();
  if (!q) return escapeHtml(text);
  const str = String(text);
  const regex = new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi");
  const parts = str.split(regex);
  return parts
    .map((part) => {
      if (part.toLowerCase() === q.toLowerCase()) {
        return `<mark class="search-highlight">${escapeHtml(part)}</mark>`;
      }
      return escapeHtml(part);
    })
    .join("");
}

function categoryClass(cat) {
  const c = String(cat || "").toLowerCase();
  if (c.includes("tech") || c.includes("innovation")) return "tech";
  if (c.includes("sport") || c.includes("fitness")) return "sports";
  if (c.includes("art") || c.includes("culture")) return "arts";
  if (c.includes("academic") || c.includes("learn")) return "academic";
  if (c.includes("leader") || c.includes("career")) return "leadership-career";
  return "academic";
}

function eventMetaIconClock() {
  return '<svg width="13" height="13" viewBox="0 0 20 20" fill="none" aria-hidden="true"><circle cx="10" cy="10" r="7" stroke="currentColor" stroke-width="1.4"/><path d="M10 6v4l2.5 2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
}

function eventMetaIconPin() {
  return '<svg width="13" height="13" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M10 17.5S15.5 12.8 15.5 8.5a5.5 5.5 0 1 0-11 0c0 4.3 5.5 9 5.5 9Z" stroke="currentColor" stroke-width="1.4"/><circle cx="10" cy="8.3" r="2" stroke="currentColor" stroke-width="1.4"/></svg>';
}

/* ---------------------------------------------------------
   EVENT NORMALIZATION & CLASSIFICATION
--------------------------------------------------------- */
function calendarDateToISO(value) {
  if (!value) return "";
  if (typeof value === "object" && typeof value.toDate === "function") {
    return calendarDateToISO(value.toDate());
  }
  if (typeof value === "object" && Number.isFinite(value.seconds)) {
    return calendarDateToISO(new Date(value.seconds * 1000));
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return "";
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Manila",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(value);
    const dateParts = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${dateParts.year}-${dateParts.month}-${dateParts.day}`;
  }
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split("-").map(Number);
    const date = new Date(year, month - 1, day);
    return date.getFullYear() === year &&
      date.getMonth() === month - 1 &&
      date.getDate() === day
      ? value
      : "";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return calendarDateToISO(date);
}

function calendarEventDateRange(event) {
  const start =
    [
      event.dateISO,
      event.eventDate,
      event.date,
      event.startDate,
      event.start_date,
      event.event_date,
      event.dateStart,
      event.schedule?.date,
      event.schedule?.startDate,
    ].map(calendarDateToISO).find(Boolean) || "";
  const end =
    [
      event.endDateISO,
      event.eventEndDate,
      event.endDate,
      event.end_date,
      event.dateEnd,
      event.end,
      start,
    ].map(calendarDateToISO).find(Boolean) || start;
  return start ? { start, end: end && end >= start ? end : start } : null;
}

function calendarEventOccursOn(event, isoDate) {
  const range = calendarEventDateRange(event);
  return Boolean(range && range.start <= isoDate && isoDate <= range.end);
}

function normalizeEvent(id, data) {
  const name = data.name || data.title || data.eventName || "Untitled Event";
  const dateISO = calendarDateToISO(
    data.dateISO || data.eventDate || data.event_date || data.date ||
    data.startDate || data.start_date || data.dateStart || data.startDateTime ||
    data.schedule?.date || data.schedule?.startDate,
  );
  const endDateISO = calendarDateToISO(
    data.endDateISO || data.eventEndDate || data.endDate || data.end_date ||
    data.dateEnd || data.end || data.schedule?.endDate,
  );
  const toMillis = (value) => {
    if (typeof value === "number") return value;
    if (value instanceof Date) return value.getTime();
    if (typeof value?.toMillis === "function") return value.toMillis();
    if (typeof value?.toDate === "function") return value.toDate().getTime();
    if (Number.isFinite(value?.seconds)) return value.seconds * 1000;
    const parsed = new Date(value).getTime();
    return Number.isFinite(parsed) ? parsed : 0;
  };
  const timeToManilaMillis = (isoDate, timeValue, useEndOfDay = false) => {
    if (!isoDate) return 0;
    const [year, month, day] = isoDate.split("-").map(Number);
    if (useEndOfDay) {
      return Date.UTC(year, month - 1, day + 1, -8, 0, 0, -1);
    }
    const time = String(timeValue || "").trim();
    const match = time.match(/(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?/i);
    if (!match) return Date.UTC(year, month - 1, day, -8, 0);
    let hours = Number(match[1]);
    const minutes = Number(match[2] || 0);
    if (match[3]?.toUpperCase() === "PM" && hours < 12) hours += 12;
    if (match[3]?.toUpperCase() === "AM" && hours === 12) hours = 0;
    return Date.UTC(year, month - 1, day, hours - 8, minutes);
  };
  const eventTimes = String(data.time || "").split(/\s*[-–—]\s*/);
  const startTime = eventTimes[0] || data.timeStart || data.startTime;
  const endTime = eventTimes[1] || data.timeEnd || data.endTime;
  let startMs = 0;
  if (data.startAt) {
    startMs = toMillis(data.startAt);
  }
  if (!startMs && dateISO) {
    startMs = timeToManilaMillis(dateISO, startTime);
  }
  if (isNaN(startMs) || startMs === 0) startMs = Date.now();

  let endMs = 0;
  if (data.endAt) {
    endMs = toMillis(data.endAt);
  }
  if (!endMs && endDateISO) {
    endMs = timeToManilaMillis(endDateISO, endTime, !endTime);
  }
  if (!endMs && dateISO) {
    endMs = timeToManilaMillis(dateISO, "", true);
  }
  if (isNaN(endMs) || endMs <= 0) {
    endMs = startMs;
  }

  return {
    id: String(id),
    name: name,
    title: name,
    venue: data.venue || data.location || "PUP Biñan Campus",
    location: data.venue || data.location || "PUP Biñan Campus",
    category: data.category || data.categories || data.tag || "Academic & Learning",
    tags: data.tags || data.eventTags || [],
    tag: data.tag || "",
    source: data.source || "PUP Official",
    startAt: data.startAt || new Date(startMs).toISOString(),
    endAt: data.endAt || new Date(endMs).toISOString(),
    startMs: startMs,
    endMs: endMs,
    dateISO,
    endDateISO,
    status: String(
      data.status ||
      data.publicationStatus ||
      (data.published === true || data.isPublished === true ? "published" : ""),
    ).trim().toLowerCase(),
    organizerUid: data.organizerUid || "",
    organizerName: data.organizerName || data.organizer || "Event Organizer",
    targetAudience: data.targetAudience || data.target_audience ||
      data.audienceType || data.audience_type || data.audience || "",
    targetDepartments: [
      data.targetDepartments,
      data.target_departments,
      data.targetDepartment,
      data.target_department,
      data.departments,
    ].flatMap((departments) =>
      Array.isArray(departments) ? departments : departments ? [departments] : [],
    ),
    targetDepartmentIds: data.targetDepartmentIds || data.target_department_ids || [],
    targetOrganizations: [
      data.targetOrganizations,
      data.target_organizations,
      data.targetOrg,
      data.target_org,
      data.targetOrgCode,
      data.target_org_code,
      data.targetOrganization,
      data.target_organization,
      data.targetOrganizationCodes,
      data.target_organization_codes,
      data.targetOrganizationNames,
      data.target_organization_names,
      data.targetOrgs,
      data.target_orgs,
      data.TargetOrgs,
      data.StudentOrgs,
      data.studentOrgs,
      data.student_orgs,
      data.audienceOrganizations,
      data.audience_organizations,
    ].flatMap((targets) =>
      Array.isArray(targets) ? targets : targets ? [targets] : [],
    ),
    targetOrgs: [
      data.targetOrgs,
      data.target_orgs,
      data.targetOrganizations,
      data.target_organizations,
      data.targetOrg,
      data.target_org,
      data.targetOrgCode,
      data.target_org_code,
      data.targetOrganization,
      data.target_organization,
    ].flatMap((targets) =>
      Array.isArray(targets) ? targets : targets ? [targets] : [],
    ),
    studentOrgs: data.studentOrgs || data.student_orgs || [],
    TargetOrgs: [
      data.TargetOrgs,
      data.targetOrgs,
      data.target_orgs,
    ].flatMap((targets) =>
      Array.isArray(targets) ? targets : targets ? [targets] : [],
    ),
    audienceOrganizations: data.audienceOrganizations || [],
    coOrganizerOrganizations: data.coOrganizerOrganizations || [],
    coOrganizerOrgIds: data.coOrganizerOrgIds || [],
    coOrganizerOrganization: data.coOrganizerOrganization || "",
    collaboratorOrganizations: data.collaboratorOrganizations || [],
    collaboratorOrgIds: data.collaboratorOrgIds || [],
    collaboratorOrganization: data.collaboratorOrganization || "",
    collaborationOrganizations: data.collaborationOrganizations || [],
    collaborationOrgIds: data.collaborationOrgIds || [],
    collaborationOrganization: data.collaborationOrganization || "",
    collaboratingOrganizations: data.collaboratingOrganizations || [],
    collaboratingOrganization: data.collaboratingOrganization || "",
    coOrganizer: data.coOrganizer || "",
    collaborator: data.collaborator || "",
    coOrganizers: data.coOrganizers || [],
    collaborators: data.collaborators || [],
    organizationCode: data.organizationCode || "",
    organizationId: data.organizationId || "",
    organizerOrganization: data.organizerOrganization || "",
    orgCode: data.orgCode || "",
    orgId: data.orgId || "",
    organization: data.organization || "",
    organizationName: data.organizationName || "",
    orgName: data.orgName || "",
    creatorRole: data.creatorRole || data.createdByRole || "",
    eventSource: data.eventSource || "",
    organizer: data.organizer || "",
    capacity: Number(data.capacity ?? data.maxCapacity ?? data.maxSlots ?? 0),
    registeredCount: Number(data.registeredCount ?? 0),
    checkedInCount: Number(data.checkedInCount ?? 0),
    description: data.description || data.desc || "No additional description provided.",
    adminDocuments: data.adminDocuments || "",
    approvalDocuments: Array.isArray(data.approvalDocuments) ? data.approvalDocuments : [],
    participantDocuments: Array.isArray(data.participantDocuments) ? data.participantDocuments : [],
    attachments: Array.isArray(data.attachments) ? data.attachments : [],
  };
}

function rebuildStudentEvents() {
  const allEventsMap = new Map([...realtimeEventsMap, ...firestoreEventsMap]);
  try {
    localStorage.setItem(
      "recovibeEventsCache",
      JSON.stringify(Array.from(allEventsMap.values())),
    );
  } catch (error) {
    console.warn("Could not cache public events:", error);
  }

  rawEventsMap = new Map(
    [...allEventsMap].filter(([, event]) =>
      isEventVisibleToStudent(event, studentProfile),
    ),
  );
  const eventsList = Array.from(rawEventsMap.values());
  syncRegistrationsFromRtdb(eventsList);
  syncRegistrationsFromFirestore(eventsList);
  renderHappeningNow();
  renderUpcoming();
  renderRecommended();
  renderCalendar();
}

function isFirestorePublishedEvent(data) {
  const status = String(data.status || "")
    .trim()
    .toLowerCase()
    .replace(/[ _-]+/g, " ");
  const publicationStatus = String(data.publicationStatus || "")
    .trim()
    .toLowerCase()
    .replace(/[ _-]+/g, " ");
  return (
    ["approved", "published", "completed", "rescheduled"].includes(status) ||
    publicationStatus === "published" ||
    data.isPublished === true ||
    data.published === true
  );
}

function normalizeFirestoreStudentEvent(documentSnapshot) {
  const data = documentSnapshot.data();
  if (!isFirestorePublishedEvent(data)) return null;

  const rawDate =
    data.eventDate ||
    data.event_date ||
    data.dateISO ||
    data.date ||
    data.startDate ||
    data.start_date ||
    data.dateStart ||
    data.schedule?.date ||
    data.schedule?.startDate ||
    "";
  const dateISO = calendarDateToISO(rawDate);
  const timestampToIso = (value) =>
    value?.toDate ? value.toDate().toISOString() : value;
  const time =
    data.time ||
    [data.timeStart || data.startTime, data.timeEnd || data.endTime]
      .filter(Boolean)
      .join(" - ") ||
    "Time TBA";
  return normalizeEvent(documentSnapshot.id, {
    ...data,
    name: data.eventName || data.title || data.name || "Untitled Event",
    dateISO,
    time,
    startAt: timestampToIso(data.startAt),
    endAt: timestampToIso(data.endAt),
    venue: data.venue || data.location || data.venueOther,
    description: data.eventDescription || data.description || data.desc,
    status: ["approved", "published", "completed", "rescheduled"].includes(
      String(data.status || "").trim().toLowerCase(),
    )
      ? data.status
      : "published",
    organizerUid: data.organizerUid || data.organizerId || data.createdBy || "",
  });
}

function getEventClassification(ev, now) {
  if (["completed", "cancelled", "canceled"].includes(ev.status) || now > ev.endMs) {
    return "past";
  }
  if (["approved", "published", "rescheduled"].includes(ev.status)) {
    if (ev.startMs <= now && now <= ev.endMs) {
      return "live";
    }
    if (ev.startMs > now) {
      return "upcoming";
    }
  }
  return "past";
}

/* ---------------------------------------------------------
   STORAGE & CACHE
--------------------------------------------------------- */
function loadStudentProfileFromStorage() {
  try {
    const raw = localStorage.getItem("recovibeCurrentUser") || sessionStorage.getItem("recovibeCurrentUser");
    if (raw) {
      const u = JSON.parse(raw);
      if (u) {
        studentProfile.firstName = u.firstName || u.name?.split(" ")[0] || "Student";
        studentProfile.middleName = u.middleName || "";
        studentProfile.lastName = u.lastName || "";
        studentProfile.fullName =
          u.fullName ||
          u.name ||
          [u.firstName, u.lastName].filter(Boolean).join(" ") ||
          "Student";
        studentProfile.studentNo =
          u.studentNumber || u.studentNo || u.studentId || "2025-00790-BN-1";
        studentProfile.organization =
          u.organization || u.courseOrganization || u.courseOrg ||
          u.organizationCode || u.organizationName || "";
        studentProfile.courseOrganization =
          u.courseOrganization || u.courseOrg || studentProfile.organization;
        studentProfile.courseOrg = u.courseOrg || studentProfile.organization;
        studentProfile.StudentOrgs = uniqueProfileValues(
          u.StudentOrgs,
          u.studentOrgs,
          u.organizations,
          studentProfile.organization,
        );
        studentProfile.department = u.department || u.departmentCode || "";
        studentProfile.departmentCode = u.departmentCode || u.department || "";
        studentProfile.departments = uniqueProfileValues(
          u.departments,
          u.departmentCodes,
          u.department,
          u.departmentCode,
          u.course,
          u.program,
        );

        // Infer organization from department or course if blank
        if (!studentProfile.organization && studentProfile.department) {
          const dept = String(studentProfile.department).toUpperCase();
          if (dept.includes("IT") || dept.includes("INFORMATION")) {
            studentProfile.organization = "IBITS";
            studentProfile.courseOrganization = "IBITS";
          } else if (dept.includes("CPE") || dept.includes("COMPUTER")) {
            studentProfile.organization = "ACES";
            studentProfile.courseOrganization = "ACES";
          } else if (dept.includes("IE") || dept.includes("INDUSTRIAL")) {
            studentProfile.organization = "PIIE";
            studentProfile.courseOrganization = "PIIE";
          } else if (dept.includes("HRM") || dept.includes("HRSS")) {
            studentProfile.organization = "HRSS";
            studentProfile.courseOrganization = "HRSS";
          }
        }
        if (!studentProfile.StudentOrgs.length && studentProfile.organization) {
          studentProfile.StudentOrgs = [studentProfile.organization];
        }
      }
    }
  } catch (e) {
    console.warn("Could not read student profile:", e);
  }
}

function loadStudentPreferences() {
  try {
    const raw =
      localStorage.getItem("recovibeUserPreferences") ||
      localStorage.getItem("recovibeStudentPreferences");
    if (raw) {
      const p = JSON.parse(raw);
      if (Array.isArray(p.categories)) studentPreferences.categories = p.categories;
      else if (Array.isArray(p)) studentPreferences.categories = p;
      if (Array.isArray(p.sources)) studentPreferences.sources = p.sources;
      if (Array.isArray(p.tags)) studentPreferences.tags = p.tags;
      if (Array.isArray(p.organizations)) studentPreferences.organizations = p.organizations;
    }
  } catch (e) {
    console.warn("Could not read preferences:", e);
  }
}

function readParticipationsFromStorage() {
  try {
    const raw = localStorage.getItem("recovibeParticipations");
    if (!raw) return [];
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return [];
    return list
      .map((item) => (typeof item === "string" ? item : String(item.id || item.eventId || "")))
      .filter(Boolean);
  } catch (e) {
    return [];
  }
}

function saveParticipationsToStorage() {
  try {
    const arr = Array.from(registeredEventIds);
    localStorage.setItem("recovibeParticipations", JSON.stringify(arr));
  } catch (e) {
    console.warn("Could not save participations:", e);
  }
}

function loadFallbackEvents() {
  try {
    const cached = localStorage.getItem("recovibeEventsCache");
    if (cached) {
      const list = JSON.parse(cached);
      if (Array.isArray(list) && list.length > 0) {
        list.forEach((item) => {
          if (!isFirestorePublishedEvent(item)) return;
          const ev = normalizeEvent(item.id || item.eventId, item);
          realtimeEventsMap.set(ev.id, ev);
        });
        rebuildStudentEvents();
        return;
      }
    }
  } catch (e) {}

  if (Array.isArray(window.RECOVIBE_EVENTS) && window.RECOVIBE_EVENTS.length > 0) {
    window.RECOVIBE_EVENTS.forEach((item) => {
      if (!isFirestorePublishedEvent(item)) return;
      const ev = normalizeEvent(item.id || item.eventId, item);
      realtimeEventsMap.set(ev.id, ev);
    });
  }
  rebuildStudentEvents();
}

/* ---------------------------------------------------------
   QR GENERATION (Offline Fallback & Cloud Functions)
--------------------------------------------------------- */
async function getQRCodeLib() {
  if (window.QRCode) return window.QRCode;
  try {
    const mod = await import("https://esm.sh/qrcode@1.5.4");
    return mod.default || mod;
  } catch (err) {
    if (window.QRCode) return window.QRCode;
    throw err;
  }
}

async function getStudentQrToken() {
  if (permanentQrToken) return permanentQrToken;
  const cached = localStorage.getItem("recovibe_permanent_qr_token");
  if (cached) {
    permanentQrToken = cached;
    return cached;
  }

  if (functions && currentUid && isFirebaseConfigured) {
    try {
      const getMyQrTokenCallable = httpsCallable(functions, "getMyQrToken");
      const res = await getMyQrTokenCallable();
      if (res?.data?.token) {
        permanentQrToken = res.data.token;
        localStorage.setItem("recovibe_permanent_qr_token", permanentQrToken);
        return permanentQrToken;
      }
    } catch (err) {
      console.warn("getMyQrToken notice:", err);
    }
  }

  // Fallback permanent token
  const fallback = `${currentUid || studentProfile.studentNo}.1.fallback_signed_token`;
  permanentQrToken = fallback;
  localStorage.setItem("recovibe_permanent_qr_token", fallback);
  return fallback;
}

async function renderQrToCanvas(canvas, token) {
  if (!canvas || !token) return;
  try {
    const QRCodeLib = await getQRCodeLib();
    await QRCodeLib.toCanvas(canvas, token, {
      width: 150,
      margin: 2,
      color: {
        dark: "#000000",
        light: "#ffffff",
      },
      errorCorrectionLevel: "M",
    });
  } catch (err) {
    console.error("renderQrToCanvas error:", err);
  }
}

/* ---------------------------------------------------------
   ACCESSIBILITY & TOASTS
--------------------------------------------------------- */
function announce(message) {
  const el = document.getElementById("dashboardLiveAnnouncer");
  if (!el) return;
  el.textContent = "";
  setTimeout(() => {
    el.textContent = message;
  }, 40);
}

function showToast(message) {
  const toast = document.getElementById("toast");
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add("is-visible");
  setTimeout(() => {
    toast.classList.remove("is-visible");
  }, 3200);
}

/* ---------------------------------------------------------
   ATTENDANCE LISTENERS (Scoped strictly to live registered events)
--------------------------------------------------------- */
function syncAttendanceListeners(liveEvents) {
  if (!currentUid || !isRtdbConfigured) return;

  const activeLiveIds = new Set();
  liveEvents.forEach((ev) => {
    if (registeredEventIds.has(ev.id)) {
      activeLiveIds.add(ev.id);
    }
  });

  // Cleanup listeners no longer needed
  attendanceListeners.forEach((unsub, eventId) => {
    if (!activeLiveIds.has(eventId)) {
      unsub();
      attendanceListeners.delete(eventId);
    }
  });

  // Attach listeners for registered live events
  activeLiveIds.forEach((eventId) => {
    if (!attendanceListeners.has(eventId)) {
      const attRef = ref(rtdb, `attendance/${eventId}/${currentUid}`);
      const onValCallback = (snap) => {
        if (snap.exists()) {
          const val = snap.val();
          if (val && val.scannedAt) {
            attendanceMap.set(eventId, val);
            // Auto-close QR if currently open
            if (openQrEventId === eventId) {
              openQrEventId = null;
            }
            const ev = rawEventsMap.get(eventId);
            const evName = ev ? ev.name : "Event";
            const timeStr = formatTime(val.scannedAt);
            announce(`Checked in to ${evName} at ${timeStr}.`);
            showToast(`Checked in to ${evName}!`);
            renderHappeningNow();
            renderCalendarDayEvents();
          }
        }
      };
      onValue(attRef, onValCallback);
      attendanceListeners.set(eventId, () => off(attRef, "value", onValCallback));
    }
  });
}

/* ---------------------------------------------------------
   RENDERING
--------------------------------------------------------- */

// 1. Top Bar Greeting & Date
function renderGreeting() {
  const now = getNow();
  const greetingEl = document.getElementById("dashboardGreeting");
  const greetingNameEl = document.getElementById("greetingName");
  const todayDateEl = document.getElementById("todayDate");

  const prefix = getGreetingPrefix(now);
  const firstName = studentProfile.firstName || "Student";

  if (greetingEl) {
    greetingEl.innerHTML = `${prefix}, <span id="greetingName">${escapeHtml(firstName)}</span>`;
  } else if (greetingNameEl) {
    greetingNameEl.textContent = firstName;
  }

  if (todayDateEl) {
    todayDateEl.textContent = new Date(now).toLocaleDateString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  }
}

// 2. Recommended for you (Matches preferences, soonest first)
function renderRecommended() {
  const container = document.getElementById("recGrid");
  if (!container) return;

  const now = getNow();
  const normalizePreference = (value) => String(value || "").toLowerCase().trim();
  const userPreferences = new Set([
    ...(studentPreferences.categories || []),
    ...(studentPreferences.sources || []),
    ...(studentPreferences.tags || []),
    ...(studentPreferences.organizations || []),
    studentProfile.organization,
    studentProfile.courseOrganization,
    studentProfile.courseOrg,
  ].map(normalizePreference).filter(Boolean));
  const upcoming = Array.from(rawEventsMap.values())
    .filter((ev) => getEventClassification(ev, now) === "upcoming")
    .sort((a, b) => a.startMs - b.startMs);
  const preferred = upcoming.filter((ev) => {
    const eventPreferences = [
      ev.category,
      ev.organizerName,
      ev.source,
      ev.organization,
      ev.targetOrgs,
      ev.targetOrganizations,
      ev.TargetOrgs,
      ev.studentOrgs,
      ev.StudentOrgs,
      ev.tags,
      ev.tag,
    ];
    return eventPreferences.some((value) =>
      (Array.isArray(value) ? value : [value])
        .map(normalizePreference)
        .some((value) => userPreferences.has(value))
    );
  });
  const matched = (preferred.length
    ? preferred
    : upcoming.filter((ev) => !registeredEventIds.has(ev.id))
  ).slice(0, 3);

  if (matched.length === 0) {
    container.innerHTML = `
      <div class="empty-state" style="width: 100%;">
        <div class="empty-state-title">No upcoming events at this time.</div>
        <div class="empty-state-sub">Update your <a href="StudentProfile.html#preferencesPanel" style="color: var(--maroon-700); text-decoration: underline;">preferences</a> to get personalized recommendations.</div>
      </div>
    `;
    return;
  }

  container.innerHTML = matched
    .map((ev) => {
      const isRegistered = registeredEventIds.has(ev.id);
      const isLive = getEventClassification(ev, now) === "live";

      let actionBtn = "";
      if (isRegistered) {
        actionBtn = `<button type="button" class="btn-cancel-sm btn-cancel-reg" data-event-id="${ev.id}">Cancel registration</button>`;
      } else {
        if (ev.capacity > 0 && ev.registeredCount >= ev.capacity) {
          actionBtn = `<span class="btn-disabled-sm">Full</span>`;
        } else {
          const isRegistering = pendingRegistrationIds.has(ev.id);
          actionBtn = `<button type="button" class="btn-primary-sm btn-register" data-event-id="${ev.id}" ${isRegistering ? "disabled aria-busy=\"true\"" : ""}>${isRegistering ? "Registering..." : "Register"}</button>`;
        }
      }

      return `
        <article class="rec-card" id="rec-card-${ev.id}" data-event-id="${ev.id}">
          <div style="display:flex; justify-content:space-between; align-items:center; gap:6px;">
            <span class="rec-tag tag-matches">Matches ${escapeHtml(ev.category)}</span>
            ${isLive ? '<span class="tag-live"><span class="pulse-dot" aria-hidden="true"></span>Live</span>' : ''}
          </div>
          <h3>${highlightMatch(ev.name, state.query)}</h3>
          <div class="rec-source">${escapeHtml(ev.organizerName || ev.source || "PUP Biñan Campus")}</div>
          <div class="rec-when">${formatDate(ev.startMs)} · ${formatTime(ev.startMs)}</div>
          <div class="rec-match">${escapeHtml(ev.venue)}</div>
          <div style="margin-top:auto; padding-top:8px;">
            ${actionBtn}
          </div>
        </article>
      `;
    })
    .join("");
}

function renderEventFetchState(container) {
  if (eventFetchError) {
    container.innerHTML = `
      <div class="empty-state" role="alert">
        <div class="empty-state-title">Events could not be loaded.</div>
        <div class="empty-state-sub">${escapeHtml(eventFetchError)}</div>
        <button type="button" class="btn-outline btn-retry-event-fetch">Retry</button>
      </div>
    `;
    return true;
  }
  if (eventFetchLoading && rawEventsMap.size === 0) {
    container.textContent = "Loading events...";
    return true;
  }
  return false;
}

// 3. Happening Now Section
function renderHappeningNow() {
  const container = document.getElementById("happeningNowList");
  const badge = document.getElementById("happeningLiveBadge");
  if (!container) return;
  if (renderEventFetchState(container)) {
    if (badge) badge.hidden = true;
    return;
  }

  const now = getNow();
  const allEvents = Array.from(rawEventsMap.values());
  const liveEvents = allEvents.filter((ev) => getEventClassification(ev, now) === "live");

  // Keep attendance listeners in sync
  syncAttendanceListeners(liveEvents);

  // Update header badge
  if (badge) {
    if (liveEvents.length > 0) {
      badge.textContent = `${liveEvents.length} live`;
      badge.hidden = false;
    } else {
      badge.hidden = true;
    }
  }

  // Filter by search query
  const q = state.query.toLowerCase();
  const filtered = liveEvents.filter((ev) => {
    if (!q) return true;
    return (
      ev.name.toLowerCase().includes(q) ||
      ev.venue.toLowerCase().includes(q) ||
      ev.category.toLowerCase().includes(q) ||
      ev.description.toLowerCase().includes(q)
    );
  });

  if (liveEvents.length === 0) {
    const upcoming = allEvents
      .filter((ev) => getEventClassification(ev, now) === "upcoming")
      .sort((a, b) => a.startMs - b.startMs);
    let nextMsg = "Check back soon.";
    if (upcoming.length > 0) {
      const nextDiff = upcoming[0].startMs - now;
      nextMsg = `Next event starts in ${formatStartsIn(nextDiff).replace("Starts in ", "")}.`;
    }
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-title">Nothing is happening right now.</div>
        <div class="empty-state-sub">${nextMsg}</div>
      </div>
    `;
    return;
  }

  if (filtered.length === 0 && q) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-title">No live events match “${escapeHtml(state.query)}”.</div>
      </div>
    `;
    return;
  }

  container.innerHTML = filtered
    .map((ev) => {
      const isRegistered = registeredEventIds.has(ev.id);
      const att = attendanceMap.get(ev.id);
      const isCheckedIn = Boolean(att && att.scannedAt);
      const isQrOpen = openQrEventId === ev.id;
      const isDetailsOpen = openDetailsEventIds.has(ev.id);

      // Progress bar
      const duration = Math.max(1, ev.endMs - ev.startMs);
      const elapsed = Math.max(0, now - ev.startMs);
      const pct = Math.min(100, Math.max(0, Math.round((elapsed / duration) * 100)));

      // Checked-in counter
      let checkedInText = "Be the first to check in";
      if (ev.checkedInCount > 0) {
        if (ev.capacity > 0) {
          checkedInText = `${ev.checkedInCount} / ${ev.capacity} checked in`;
        } else {
          checkedInText = `${ev.checkedInCount} student${ev.checkedInCount === 1 ? "" : "s"} checked in`;
        }
      }

      // Action button
      let actionHtml = "";
      if (isCheckedIn) {
        actionHtml = `<span class="tag-checked-in"><svg width="12" height="12" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"/></svg> Checked in at ${formatTime(att.scannedAt)}</span>`;
      } else if (isRegistered) {
        actionHtml = `<button type="button" class="btn-primary-sm btn-toggle-qr" data-event-id="${ev.id}" aria-expanded="${isQrOpen}">${isQrOpen ? "Hide QR" : "Show my QR"}</button>`;
      } else {
        if (ev.capacity > 0 && ev.registeredCount >= ev.capacity) {
          actionHtml = `<span class="btn-disabled-sm">Full</span>`;
        } else {
          const isRegistering = pendingRegistrationIds.has(ev.id);
          actionHtml = `<button type="button" class="btn-primary-sm btn-register" data-event-id="${ev.id}" ${isRegistering ? "disabled aria-busy=\"true\"" : ""}>${isRegistering ? "Registering..." : "Register"}</button>`;
        }
      }

      // Inline QR Panel
      let qrPanelHtml = "";
      if (isQrOpen && !isCheckedIn) {
        qrPanelHtml = `
          <div class="inline-qr-panel" id="inlineQrPanel_${ev.id}" role="region" aria-label="Attendance QR Code">
            <div class="inline-qr-canvas-wrap">
              <canvas id="inlineQrCanvas_${ev.id}" width="150" height="150" aria-label="Attendance QR Code"></canvas>
            </div>
            <div class="inline-qr-name">${escapeHtml(studentProfile.fullName)}</div>
            <div class="inline-qr-sub">${escapeHtml(studentProfile.studentNo)} · ${escapeHtml(studentProfile.organization || "PUP Biñan")}</div>
            <div class="inline-qr-note">Show this at the entrance.</div>
            <button type="button" class="btn-hide-qr btn-toggle-qr" data-event-id="${ev.id}">Hide QR</button>
          </div>
        `;
      }

      // Inline Details Panel
      let detailsPanelHtml = "";
      if (isDetailsOpen) {
        detailsPanelHtml = `
          <div class="inline-details-panel" id="inlineDetails_${ev.id}">
            <div class="inline-details-row">
              <span class="inline-details-label">About</span>
              <div class="inline-details-desc">${escapeHtml(ev.description)}</div>
            </div>
            <div class="inline-details-row">
              <span class="inline-details-label">Organizer</span>
              <div>${escapeHtml(ev.organizerName || "PUP Biñan Campus")} (${escapeHtml(ev.source || "Official")})</div>
            </div>
            ${renderPublicDocumentLinks(ev)}
            ${ev.capacity > 0 ? `<div class="inline-details-row"><span class="inline-details-label">Capacity</span><div>${ev.capacity} attendees (${ev.registeredCount} registered)</div></div>` : ""}
          </div>
        `;
      }

      return `
        <article class="event-card event-card--live" id="live-card-${ev.id}" data-event-id="${ev.id}">
          <div class="event-body">
            <div class="event-top-row">
              <span class="tag-live"><span class="pulse-dot" aria-hidden="true"></span>Live</span>
              <span class="live-ends-in">${formatRemainingTime(ev.endMs - now)}</span>
              ${isRegistered && !isCheckedIn ? '<span class="tag-registered-small">Registered</span>' : ''}
            </div>
            <h3 class="event-title">${highlightMatch(ev.name, state.query)}</h3>
            <div class="event-meta">
              <span>${eventMetaIconClock()} ${formatTimeRange(ev.startMs, ev.endMs)}</span>
              <span>${eventMetaIconPin()} ${highlightMatch(ev.venue, state.query)}</span>
            </div>
            <div class="progress-bar-wrap" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100" aria-label="Event progress (${pct}%)">
              <div class="progress-bar-fill" style="width: ${pct}%"></div>
            </div>
            <div class="event-foot">
              <span class="checked-in-count">
                <svg width="13" height="13" viewBox="0 0 20 20" fill="none"><path d="M10 10a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM3 18a7 7 0 0 1 14 0" stroke="currentColor" stroke-width="1.5"/></svg>
                ${checkedInText}
              </span>
              <div class="event-actions">
                ${actionHtml}
                <button type="button" class="btn-outline btn-toggle-details" data-event-id="${ev.id}" aria-expanded="${isDetailsOpen}">Details</button>
              </div>
            </div>
            ${qrPanelHtml}
            ${detailsPanelHtml}
          </div>
        </article>
      `;
    })
    .join("");

  // Trigger canvas drawing for active QR panel
  if (openQrEventId) {
    const canvas = document.getElementById(`inlineQrCanvas_${openQrEventId}`);
    if (canvas) {
      getStudentQrToken().then((token) => renderQrToCanvas(canvas, token));
    }
  }
}

// 4. Upcoming Events Section
function renderUpcoming() {
  const container = document.getElementById("upcomingEventsList");
  if (!container) return;
  if (renderEventFetchState(container)) return;

  const now = getNow();
  const allEvents = Array.from(rawEventsMap.values());
  const upcomingEvents = allEvents
    .filter((ev) =>
      ["approved", "published", "rescheduled"].includes(
        String(ev.status || "").toLowerCase(),
      ) &&
      Number.isFinite(ev.startMs) &&
      ev.startMs > now
    )
    .sort((a, b) => a.startMs - b.startMs);

  const q = state.query.toLowerCase();
  const filtered = upcomingEvents.filter((ev) => {
    if (!q) return true;
    return (
      ev.name.toLowerCase().includes(q) ||
      ev.venue.toLowerCase().includes(q) ||
      ev.category.toLowerCase().includes(q) ||
      ev.description.toLowerCase().includes(q)
    );
  });

  if (upcomingEvents.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-title">No upcoming events.</div>
        <div class="empty-state-sub">Check back later for new events.</div>
      </div>
    `;
    return;
  }

  if (filtered.length === 0 && q) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-title">No events match “${escapeHtml(state.query)}”.</div>
      </div>
    `;
    return;
  }

  container.innerHTML = filtered
    .slice(0, 10)
    .map((ev) => {
      const isRegistered = registeredEventIds.has(ev.id);
      const isDetailsOpen = openDetailsEventIds.has(ev.id);

      const evDate = new Date(ev.startMs);
      const nowDate = new Date(now);
      const isToday =
        evDate.getFullYear() === nowDate.getFullYear() &&
        evDate.getMonth() === nowDate.getMonth() &&
        evDate.getDate() === nowDate.getDate();

      const timeLabel = isToday
        ? formatStartsIn(ev.startMs - now)
        : `${formatDate(ev.startMs)} · ${formatTime(ev.startMs)}`;

      const dateParts = {
        month: evDate.toLocaleDateString("en-US", { month: "short" }).toUpperCase(),
        day: evDate.getDate(),
        year: evDate.getFullYear(),
      };

      let actionBtn = "";
      if (isRegistered) {
        actionBtn = `<button type="button" class="btn-cancel-sm btn-cancel-reg" data-event-id="${ev.id}">Cancel registration</button>`;
      } else {
        if (ev.capacity > 0 && ev.registeredCount >= ev.capacity) {
          actionBtn = `<span class="btn-disabled-sm">Full</span>`;
        } else {
          const isRegistering = pendingRegistrationIds.has(ev.id);
          actionBtn = `<button type="button" class="btn-primary-sm btn-register" data-event-id="${ev.id}" ${isRegistering ? "disabled aria-busy=\"true\"" : ""}>${isRegistering ? "Registering..." : "Register"}</button>`;
        }
      }

      let detailsPanelHtml = "";
      if (isDetailsOpen) {
        detailsPanelHtml = `
          <div class="inline-details-panel" id="inlineDetails_${ev.id}">
            <div class="inline-details-row">
              <span class="inline-details-label">About</span>
              <div class="inline-details-desc">${escapeHtml(ev.description)}</div>
            </div>
            <div class="inline-details-row">
              <span class="inline-details-label">Organizer</span>
              <div>${escapeHtml(ev.organizerName || "PUP Biñan Campus")} (${escapeHtml(ev.source || "Official")})</div>
            </div>
            ${renderPublicDocumentLinks(ev)}
            ${ev.capacity > 0 ? `<div class="inline-details-row"><span class="inline-details-label">Capacity</span><div>${ev.capacity} attendees (${ev.registeredCount} registered)</div></div>` : ""}
          </div>
        `;
      }

      return `
        <article class="event-card" id="upcoming-card-${ev.id}" data-event-id="${ev.id}">
          <div class="event-date">
            <span class="mon">${dateParts.month}</span>
            <span class="day">${dateParts.day}</span>
            <span class="year">${dateParts.year}</span>
          </div>
          <div class="event-body">
            <div class="event-top-row">
              <span class="category category-${categoryClass(ev.category)}">${escapeHtml(ev.category)}</span>
              ${isRegistered ? '<span class="tag-registered-small">Registered</span>' : ''}
            </div>
            <h3 class="event-title">${highlightMatch(ev.name, state.query)}</h3>
            <div class="event-meta">
              <span>${eventMetaIconClock()} ${timeLabel}</span>
              <span>${eventMetaIconPin()} ${highlightMatch(ev.venue, state.query)}</span>
            </div>
            <div class="event-foot">
              <span class="slots">${ev.capacity > 0 ? `${Math.max(0, ev.capacity - ev.registeredCount)} slots open` : "Open registration"}</span>
              <div class="event-actions">
                ${actionBtn}
                <button type="button" class="btn-outline btn-toggle-details" data-event-id="${ev.id}" aria-expanded="${isDetailsOpen}">Details</button>
              </div>
            </div>
            ${detailsPanelHtml}
          </div>
        </article>
      `;
    })
    .join("");
}

// 5. Calendar Preview Grid & Day Events
function renderCalendar() {
  const calMonthLabel = document.getElementById("calMonthLabel");
  const calDays = document.getElementById("calDays");
  if (!calDays || !calMonthLabel) return;

  calDays.innerHTML = "";
  syncMonthHolidays();

  const now = getNow();
  const year = state.calYear;
  const month = state.calMonth;
  calMonthLabel.textContent = `${MONTH_NAMES[month]} ${year}`;

  const firstDay = new Date(year, month, 1).getDay(); // 0 is Sunday
  const lastDate = new Date(year, month + 1, 0).getDate();
  const prevMonthLastDate = new Date(year, month, 0).getDate();

  const nowDate = new Date(now);
  const isCurrentMonth = nowDate.getFullYear() === year && nowDate.getMonth() === month;
  const todayDateNum = nowDate.getDate();

  const selYear = state.calSelectedDate.getFullYear();
  const selMonth = state.calSelectedDate.getMonth();
  const selDateNum = state.calSelectedDate.getDate();

  const allEvents = Array.from(rawEventsMap.values());

  let html = "";

  // Trailing days from previous month
  for (let i = firstDay - 1; i >= 0; i--) {
    const d = prevMonthLastDate - i;
    html += `<button type="button" class="cal-day is-muted" tabindex="-1" disabled aria-hidden="true"><span class="cal-day-number">${d}</span></button>`;
  }

  // Days of current month
  for (let d = 1; d <= lastDate; d++) {
    const isToday = isCurrentMonth && d === todayDateNum;
    const isSelected = selYear === year && selMonth === month && selDateNum === d;

    const classes = ["cal-day"];
    if (isToday) classes.push("is-today");
    if (isSelected) classes.push("is-selected");

    const isoStr = `${year}-${String(month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const holidaysOnDay = currentMonthHolidays.filter((h) => h.date === isoStr);
    const eventsOnDay = allEvents.filter(
      (ev) => calendarEventDateRange(ev)?.start === isoStr,
    );
    let dotsHtml = "";
    if (eventsOnDay.length > 0 || holidaysOnDay.length > 0) {
      const liveEvents = eventsOnDay.filter((ev) => getEventClassification(ev, now) === "live");
      const registeredEvents = eventsOnDay.filter((ev) => registeredEventIds.has(ev.id));
      const hasHoliday = holidaysOnDay.length > 0 || eventsOnDay.some(isHolidayEvent);
      const hasOther = eventsOnDay.some((ev) => !registeredEventIds.has(ev.id) && !isHolidayEvent(ev));
      const eventTitles = (events) =>
        events.map((ev) => ev.name || ev.title || "Untitled event").join(", ");

      const indicators = [];
      if (liveEvents.length) {
        indicators.push(`<span class="cal-event-dot dot-live" title="${escapeHtml(`Live: ${eventTitles(liveEvents)}`)}"></span>`);
      }
      if (registeredEvents.length) {
        indicators.push(`<span class="cal-event-dot dot-registered" title="${escapeHtml(`Registered: ${eventTitles(registeredEvents)}`)}"></span>`);
      }
      if (hasHoliday && indicators.length < 3) {
        const holidayTitles = [
          ...holidaysOnDay.map((holiday) => holiday.title),
          ...eventsOnDay.filter(isHolidayEvent).map((ev) => ev.name || ev.title || "Holiday"),
        ];
        indicators.push(`<span class="cal-event-dot dot-holiday" title="${escapeHtml(`Holiday: ${holidayTitles.join(", ")}`)}"></span>`);
      }
      if (hasOther && indicators.length < 3) {
        const otherEvents = eventsOnDay.filter((ev) => !registeredEventIds.has(ev.id) && !isHolidayEvent(ev));
        indicators.push(`<span class="cal-event-dot dot-other" title="${escapeHtml(`Event: ${eventTitles(otherEvents)}`)}"></span>`);
      }

      dotsHtml = `<span class="cal-day-indicators">${indicators.slice(0, 3).join("")}</span>`;
    } else {
      dotsHtml = '<span class="cal-day-indicators"></span>';
    }
    html += `
      <button
        type="button"
        class="${classes.join(" ")}"
        data-date="${isoStr}"
        data-day="${d}"
        aria-label="${d} ${MONTH_NAMES[month]} ${year}${eventsOnDay.length ? `, ${eventsOnDay.length} events` : ""}"
        aria-pressed="${isSelected}"
      >
        <span class="cal-day-number">${d}</span>
        ${dotsHtml}
      </button>
    `;
  }

  // Trailing days into next month to complete row of 7
  const totalDaysRendered = firstDay + lastDate;
  const nextDays = (7 - (totalDaysRendered % 7)) % 7;
  for (let d = 1; d <= nextDays; d++) {
    html += `<button type="button" class="cal-day is-muted" tabindex="-1" disabled aria-hidden="true"><span class="cal-day-number">${d}</span></button>`;
  }

  calDays.innerHTML = html;
  renderCalendarDayEvents();
}

function renderCalendarDayEvents() {
  const container = document.getElementById("calDayEvents");
  if (!container) return;
  container.innerHTML = "";

  const now = getNow();
  const selDate = state.calSelectedDate;
  const year = selDate.getFullYear();
  const month = selDate.getMonth();
  const day = selDate.getDate();
  const selIso = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

  const dateLabel = selDate.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  const holidaysOnDay = currentMonthHolidays.filter((h) => h.date === selIso);
  const allEvents = Array.from(rawEventsMap.values());
  const matching = allEvents.filter(
    (ev) => calendarEventDateRange(ev)?.start === selIso,
  );

  // Render Holidays (No Event Details modal, just the name of the Holiday)
  const holidayRowsHtml = holidaysOnDay
    .map(
      (h) => `
        <div class="cal-selected-event cal-selected-event--holiday" style="cursor: default;" aria-label="${escapeHtml(h.title)} (Holiday)">
          <span class="cal-event-marker dot-holiday"></span>
          <div class="cal-selected-event-copy" style="flex:1;">
            <strong>${escapeHtml(h.title)}</strong>
            <small>Holiday</small>
          </div>
        </div>
      `,
    )
    .join("");

  // Render events (and handle any events that are holidays without action buttons)
  const eventRowsHtml = matching
    .map((ev) => {
      if (isHolidayEvent(ev)) {
        return `
          <div class="cal-selected-event cal-selected-event--holiday" style="cursor: default;" aria-label="${escapeHtml(ev.name)} (Holiday)">
            <span class="cal-event-marker dot-holiday"></span>
            <div class="cal-selected-event-copy" style="flex:1;">
              <strong>${escapeHtml(ev.name)}</strong>
              <small>Holiday</small>
            </div>
          </div>
        `;
      }

      const isRegistered = registeredEventIds.has(ev.id);
      const classification = getEventClassification(ev, now);

      let tagClass = "dot-other";
      if (classification === "live") {
        tagClass = "dot-live";
      }

      let actionBtn = "";
      if (classification !== "past") {
        if (isRegistered) {
          actionBtn = `<button type="button" class="btn-cancel-sm btn-cancel-reg" data-event-id="${ev.id}" style="padding: 3px 8px; font-size: 11px;">Cancel</button>`;
        } else {
          const isRegistering = pendingRegistrationIds.has(ev.id);
          actionBtn = `<button type="button" class="btn-primary-sm btn-register" data-event-id="${ev.id}" ${isRegistering ? "disabled aria-busy=\"true\"" : ""} style="padding: 3px 8px; font-size: 11px;">${isRegistering ? "Registering..." : "Register"}</button>`;
        }
      }

      return `
        <div class="cal-selected-event">
          <span class="cal-event-marker ${tagClass}"></span>
          <div class="cal-selected-event-copy" style="flex:1;">
            <strong>${escapeHtml(ev.name)}</strong>
            <small>${formatTime(ev.startMs)} · ${escapeHtml(ev.venue)}</small>
          </div>
          <div style="display:flex; align-items:center; gap:4px;">
            ${actionBtn}
          </div>
        </div>
      `;
    })
    .join("");

  let eventsHtml = "";
  if (holidaysOnDay.length === 0 && matching.length === 0) {
    eventsHtml = '<p class="cal-day-empty">No events on this day.</p>';
  } else {
    eventsHtml = `${holidayRowsHtml}${eventRowsHtml}`;
  }

  const isoStr = selIso;

  container.innerHTML = `
    <div class="cal-day-events-heading" style="display:flex; justify-content:space-between; align-items:center;">
      <span>${dateLabel}</span>
      <a href="Events.html?from=${isoStr}&to=${isoStr}" class="cal-open-day-link" style="font-size: 11.5px; font-weight: 600; color: var(--maroon-700); text-decoration: underline;" title="View this day in Events">Open day</a>
    </div>
    <div class="cal-selected-events">${eventsHtml}</div>
  `;
}

/* ---------------------------------------------------------
   USER ACTIONS: Register & Cancel Registration
--------------------------------------------------------- */
async function handleRegister(eventId) {
  if (!eventId || pendingRegistrationIds.has(eventId)) return;

  try {
    const sys = JSON.parse(localStorage.getItem("recovibeSystemSettings") || "{}");
    if (sys && sys.registrationEnabled === false) {
      showToast("Event registration is temporarily disabled by system administration.");
      announce("Event registration is disabled.");
      return;
    }
  } catch (_) {}

  const ev = rawEventsMap.get(eventId);
  if (!ev) {
    showToast("This event is no longer available. Refresh and try again.");
    return;
  }
  if (!auth?.currentUser) {
    showToast("Please sign in again before registering.");
    announce("Sign in is required to register for events.");
    return;
  }
  if (!isFirebaseConfigured || (!functions && !firestoreEventsMap.has(eventId))) {
    showToast("Registration is unavailable right now. Please try again later.");
    announce("Registration is unavailable.");
    return;
  }

  pendingRegistrationIds.add(eventId);
  renderHappeningNow();
  renderUpcoming();
  renderRecommended();
  renderCalendar();
  announce(`Registering for ${ev.name}...`);

  try {
    let registeredCount;
    if (firestoreEventsMap.has(eventId) && db) {
      const eventRef = doc(db, "events", eventId);
      const registrationRef = doc(db, "events", eventId, "registrations", auth.currentUser.uid);
      registeredCount = await runTransaction(db, async (transaction) => {
        const [eventSnapshot, registrationSnapshot] = await Promise.all([
          transaction.get(eventRef),
          transaction.get(registrationRef),
        ]);
        if (!eventSnapshot.exists()) {
          throw new Error("This event is no longer available.");
        }

        const eventData = eventSnapshot.data();
        const status = String(eventData.status || eventData.publicationStatus || "")
          .trim()
          .toLowerCase()
          .replace(/[ _-]+/g, " ");
        if (
          status !== "published" &&
          eventData.published !== true &&
          eventData.isPublished !== true
        ) {
          throw new Error("Registration is closed because this event is not published.");
        }
        if (ev.endMs && getNow() >= ev.endMs) {
          throw new Error("Registration is closed because this event has ended.");
        }
        if (
          registrationSnapshot.exists() &&
          registrationSnapshot.data().status === "registered"
        ) {
          const alreadyRegisteredError = new Error(
            "You are already registered for this event.",
          );
          alreadyRegisteredError.code = "already-registered";
          throw alreadyRegisteredError;
        }

        const capacity = Number(eventData.capacity ?? eventData.maxCapacity);
        const count = Math.max(0, Number(eventData.registeredCount) || 0);
        if (capacity > 0 && count >= capacity) {
          throw new Error("This event is full.");
        }

        const nextCount = count + 1;
        const now = Date.now();
        transaction.update(eventRef, {
          registeredCount: nextCount,
          updatedAt: now,
        });
        transaction.set(registrationRef, {
          uid: auth.currentUser.uid,
          status: "registered",
          registeredAt: now,
          at: now,
        });
        return nextCount;
      });
    } else {
      const registerFn = httpsCallable(functions, "registerForEvent");
      const response = await registerFn({ eventId });
      if (response.data?.success !== true) {
        throw new Error("The registration could not be completed. Please try again.");
      }
      registeredCount = response.data.registeredCount;
    }

    registeredEventIds.add(eventId);
    if (Number.isFinite(Number(registeredCount))) {
      ev.registeredCount = Number(registeredCount);
    }
    saveParticipationsToStorage();
    const now = getNow();
    if (getEventClassification(ev, now) === "live") {
      syncAttendanceListeners([ev]);
    }
    announce(`Registered for ${ev.name}.`);
    showToast(`Registered for ${ev.name}`);
  } catch (err) {
    console.error("registerForEvent failed:", err);
    const errorCode = String(err?.code || "").toLowerCase();
    const errorText = String(err?.message || "").toLowerCase();
    const message =
      errorCode === "already-registered" ||
      errorCode.includes("already-exists") ||
      errorText.includes("already registered")
        ? "You are already registered for this event."
        : errorCode.includes("permission-denied")
          ? "Registration was denied by Firestore security rules. Please contact an administrator."
          : errorCode.includes("resource-exhausted") ||
              errorText.includes("full")
            ? "This event is full."
            : err?.message || "Could not register for this event. Please try again.";
    showToast(message);
    announce(message);
    return false;
  } finally {
    pendingRegistrationIds.delete(eventId);
    renderHappeningNow();
    renderUpcoming();
    renderRecommended();
    renderCalendar();
  }
  return true;
}

async function handleCancelRegistration(eventId) {
  const ev = rawEventsMap.get(eventId);
  const evName = ev ? ev.name : "event";

  // Optimistic update
  registeredEventIds.delete(eventId);
  saveParticipationsToStorage();

  if (openQrEventId === eventId) {
    openQrEventId = null;
  }

  if (attendanceListeners.has(eventId)) {
    const unsub = attendanceListeners.get(eventId);
    unsub();
    attendanceListeners.delete(eventId);
  }
  attendanceMap.delete(eventId);

  renderHappeningNow();
  renderUpcoming();
  renderRecommended();
  renderCalendar();

  announce(`Cancelled registration for ${evName}.`);
  showToast(`Cancelled registration for ${evName}`);

  // Server-enforced cancellation via Cloud Function
  if (isFirebaseConfigured && (functions || firestoreEventsMap.has(eventId))) {
    try {
      if (firestoreEventsMap.has(eventId) && db && auth?.currentUser) {
        const eventRef = doc(db, "events", eventId);
        const registrationRef = doc(
          db,
          "events",
          eventId,
          "registrations",
          auth.currentUser.uid,
        );
        const registeredCount = await runTransaction(db, async (transaction) => {
          const [eventSnapshot, registrationSnapshot] = await Promise.all([
            transaction.get(eventRef),
            transaction.get(registrationRef),
          ]);
          if (!eventSnapshot.exists()) {
            throw new Error("This event is no longer available.");
          }

          const eventData = eventSnapshot.data();
          const registrationData = registrationSnapshot.exists()
            ? registrationSnapshot.data()
            : null;
          if (registrationData?.status !== "registered") {
            return Math.max(0, Number(eventData.registeredCount) || 0);
          }
          if (ev?.endMs && getNow() >= ev.endMs) {
            throw new Error("Registration can't be cancelled after the event ends.");
          }

          const nextCount = Math.max(0, Number(eventData.registeredCount) || 0) - 1;
          const now = Date.now();
          transaction.update(eventRef, {
            registeredCount: nextCount,
            updatedAt: now,
          });
          transaction.set(registrationRef, {
            ...registrationData,
            uid: auth.currentUser.uid,
            status: "cancelled",
            cancelledAt: now,
            at: now,
          });
          return nextCount;
        });
        if (ev) ev.registeredCount = registeredCount;
      } else {
        const cancelFn = httpsCallable(functions, "cancelRegistration");
        await cancelFn({ eventId });
      }
    } catch (err) {
      console.warn("cancelRegistration notice:", err);
      // Revert optimistic update
      registeredEventIds.add(eventId);
      saveParticipationsToStorage();
      renderHappeningNow();
      renderUpcoming();
      renderRecommended();
      renderCalendar();
      const msg = err.message || "Could not cancel registration.";
      showToast(msg);
      announce(msg);
    }
  }
}

window.recovibeRegisterForEvent = handleRegister;
window.recovibeCancelRegistration = handleCancelRegistration;

/* ---------------------------------------------------------
   REALTIME DATABASE LISTENERS & SYNC
--------------------------------------------------------- */
function syncRegistrationsFromRtdb(eventsList) {
  if (!currentUid || !isRtdbConfigured) return;
  eventsList.forEach((ev) => {
    if (registrationSyncIds.has(ev.id)) return;
    registrationSyncIds.add(ev.id);
    const regRef = ref(rtdb, `registrations/${ev.id}/${currentUid}`);
    onValue(
      regRef,
      (snap) => {
        if (snap.exists() && snap.val() === true) {
          if (!registeredEventIds.has(ev.id)) {
            registeredEventIds.add(ev.id);
            saveParticipationsToStorage();
            renderHappeningNow();
            renderUpcoming();
            renderRecommended();
            renderCalendar();
          }
        }
      },
      { onlyOnce: true }
    );
  });
}

function syncRegistrationsFromFirestore(eventsList) {
  if (!currentUid || !db || !isFirebaseConfigured) return;
  if (firestoreRegistrationListenerUid !== currentUid) {
    firestoreRegistrationListeners.forEach((unsubscribe) => unsubscribe());
    firestoreRegistrationListeners.clear();
    firestoreRegistrationListenerUid = currentUid;
  }

  eventsList.forEach((ev) => {
    if (!firestoreEventsMap.has(ev.id)) return;
    const listenerKey = `${currentUid}:${ev.id}`;
    if (firestoreRegistrationListeners.has(listenerKey)) return;
    const registrationRef = doc(db, "events", ev.id, "registrations", currentUid);
    const unsubscribe = onSnapshot(
      registrationRef,
      (snapshot) => {
        const isRegistered =
          snapshot.exists() &&
          String(snapshot.data().status || "").toLowerCase() === "registered";
        const hadRegistration = registeredEventIds.has(ev.id);
        if (isRegistered) registeredEventIds.add(ev.id);
        else registeredEventIds.delete(ev.id);
        if (hadRegistration !== isRegistered) {
          saveParticipationsToStorage();
          renderHappeningNow();
          renderUpcoming();
          renderRecommended();
          renderCalendar();
        }
      },
      (error) => console.error("Registration Lookup Error:", error),
    );
    firestoreRegistrationListeners.set(listenerKey, unsubscribe);
  });
}

function initDataListeners(authenticatedUser = auth?.currentUser) {
  unsubscribeFirestoreEvents?.();
  unsubscribeFirestoreEvents = null;
  if (!authenticatedUser) {
    eventFetchLoading = false;
    eventFetchError = "Sign in to load student events.";
    renderHappeningNow();
    renderUpcoming();
  }
  if (isFirebaseConfigured && db && authenticatedUser) {
    eventFetchLoading = true;
    eventFetchError = null;
    const handleEventsSnapshot = (snapshot) => {
      eventFetchLoading = false;
      eventFetchError = null;
      const publishedEvents = new Map();
      snapshot.docs.forEach((eventDocument) => {
        const event = normalizeFirestoreStudentEvent(eventDocument);
        if (!event) return;
        const realtimeEvent = realtimeEventsMap.get(event.id);
        if (realtimeEvent) {
          event.registeredCount = realtimeEvent.registeredCount ?? event.registeredCount;
          event.checkedInCount = realtimeEvent.checkedInCount ?? event.checkedInCount;
        }
        publishedEvents.set(event.id, event);
      });
      firestoreEventsMap = publishedEvents;
      rebuildStudentEvents();
    };
    const listenForEvents = (eventsQuery) => {
      try {
        unsubscribeFirestoreEvents = onSnapshot(
          eventsQuery,
          handleEventsSnapshot,
          (error) => {
            console.error("Event Fetch Error:", error);
            eventFetchLoading = false;
            eventFetchError = error?.code === "permission-denied"
              ? "Your account cannot read published events. Check your sign-in and Firestore access."
              : "Check your connection and try again.";
            renderHappeningNow();
            renderUpcoming();
          },
        );
      } catch (error) {
        console.error("Event Fetch Error:", error);
        eventFetchLoading = false;
        eventFetchError = error?.code === "permission-denied"
          ? "Your account cannot read published events. Check your sign-in and Firestore access."
          : "Check your connection and try again.";
        renderHappeningNow();
        renderUpcoming();
      }
    };
    const publishedEventsQuery = () =>
      query(
        collection(db, "events"),
        where("status", "in", [
          "published",
          "completed",
          "rescheduled",
          "cancelled",
          "canceled",
        ]),
      );
    retryEventFetch = () => {
      unsubscribeFirestoreEvents?.();
      listenForEvents(publishedEventsQuery());
    };
    try {
      listenForEvents(publishedEventsQuery());
    } catch (error) {
      console.error("Event Fetch Error:", error);
      eventFetchLoading = false;
      eventFetchError = error?.code === "permission-denied"
        ? "Your account cannot read published events. Check your sign-in and Firestore access."
        : "Check your connection and try again.";
      renderHappeningNow();
      renderUpcoming();
    }
    activeCleanups.push(() => unsubscribeFirestoreEvents?.());
  }

  // 1. Server time offset
  if (isRtdbConfigured) {
    const offsetRef = ref(rtdb, ".info/serverTimeOffset");
    const onOffset = (snap) => {
      serverTimeOffset = Number(snap.val() || 0);
      renderGreeting();
      renderHappeningNow();
      renderUpcoming();
      renderRecommended();
      renderCalendar();
    };
    onValue(offsetRef, onOffset);
    activeCleanups.push(() => off(offsetRef, "value", onOffset));
  }

  // 2. Public Events query
  if (isRtdbConfigured) {
    const eventsQuery = ref(rtdb, "publicEvents");

    const onEvents = (snap) => {
      const data = snap.val() || {};
      const newMap = new Map();
      Object.entries(data).forEach(([id, item]) => {
        if (item && isFirestorePublishedEvent(item)) {
          newMap.set(id, normalizeEvent(id, item));
        }
      });
      realtimeEventsMap = newMap;
      rebuildStudentEvents();
    };

    onValue(eventsQuery, onEvents);
    activeCleanups.push(() => off(eventsQuery, "value", onEvents));
  } else {
    loadFallbackEvents();
    renderHappeningNow();
    renderUpcoming();
    renderRecommended();
    renderCalendar();
  }
}

/* ---------------------------------------------------------
   INTERACTION WIRING
--------------------------------------------------------- */
function wireEvents() {
  // Search input: filters Happening now and Upcoming events together
  const searchInput = document.getElementById("searchInput");
  if (searchInput) {
    searchInput.addEventListener("input", (e) => {
      state.query = e.target.value.trim();
      renderHappeningNow();
      renderUpcoming();
      renderRecommended();
    });
  }

  // Calendar prev/next navigation
  const calPrev = document.getElementById("calPrev");
  const calNext = document.getElementById("calNext");
  if (calPrev) {
    calPrev.addEventListener("click", () => {
      if (state.calMonth === 0) {
        state.calMonth = 11;
        state.calYear -= 1;
      } else {
        state.calMonth -= 1;
      }
      renderCalendar();
    });
  }
  if (calNext) {
    calNext.addEventListener("click", () => {
      if (state.calMonth === 11) {
        state.calMonth = 0;
        state.calYear += 1;
      } else {
        state.calMonth += 1;
      }
      renderCalendar();
    });
  }

  // Calendar day selection
  const calDays = document.getElementById("calDays");
  if (calDays) {
    calDays.addEventListener("click", (e) => {
      const btn = e.target.closest(".cal-day:not(.is-muted)");
      if (!btn) return;
      const dayNum = Number(btn.getAttribute("data-day"));
      if (dayNum) {
        state.calSelectedDate = new Date(state.calYear, state.calMonth, dayNum);
        renderCalendar();
      }
    });
  }

  // Event delegation for actions (Register, Cancel, QR toggle, Details toggle)
  document.addEventListener("click", (e) => {
    const retryBtn = e.target.closest(".btn-retry-event-fetch");
    if (retryBtn) {
      e.preventDefault();
      eventFetchError = null;
      eventFetchLoading = true;
      renderHappeningNow();
      renderUpcoming();
      if (retryEventFetch && auth?.currentUser) {
        retryEventFetch();
      } else {
        eventFetchLoading = false;
        eventFetchError = auth?.currentUser
          ? "Event fetching is not available. Reload the dashboard and try again."
          : "Sign in to load student events.";
        renderHappeningNow();
        renderUpcoming();
      }
      return;
    }

    // Register
    const regBtn = e.target.closest(".btn-register");
    if (regBtn) {
      e.preventDefault();
      const eventId = regBtn.getAttribute("data-event-id");
      if (eventId) handleRegister(eventId);
      return;
    }

    // Cancel Registration
    const cancelBtn = e.target.closest(".btn-cancel-reg");
    if (cancelBtn) {
      e.preventDefault();
      const eventId = cancelBtn.getAttribute("data-event-id");
      if (eventId) handleCancelRegistration(eventId);
      return;
    }

    // Toggle Inline QR
    const qrBtn = e.target.closest(".btn-toggle-qr");
    if (qrBtn) {
      e.preventDefault();
      const eventId = qrBtn.getAttribute("data-event-id");
      if (eventId) {
        openQrEventId = openQrEventId === eventId ? null : eventId;
        renderHappeningNow();
      }
      return;
    }

    // Toggle Details
    const detailsBtn = e.target.closest(".btn-toggle-details");
    if (detailsBtn) {
      e.preventDefault();
      const eventId = detailsBtn.getAttribute("data-event-id");
      if (eventId) {
        const event = rawEventsMap.get(eventId);
        if (event && window.RecovibeStudentEventDetails) {
          window.RecovibeStudentEventDetails.open(event);
          return;
        }
        if (openDetailsEventIds.has(eventId)) {
          openDetailsEventIds.delete(eventId);
        } else {
          openDetailsEventIds.add(eventId);
        }
        renderHappeningNow();
        renderUpcoming();
      }
      return;
    }
  });

  // Preferences updated event
  window.addEventListener("recovibe:preferences-updated", () => {
    loadStudentPreferences();
    renderRecommended();
  });
  window.addEventListener("storage", (e) => {
    if (
      e.key === "recovibeUserPreferences" ||
      e.key === "recovibeStudentPreferences"
    ) {
      loadStudentPreferences();
      renderRecommended();
    }
    if (e.key === "recovibeParticipations") {
      registeredEventIds = new Set(readParticipationsFromStorage());
      renderHappeningNow();
      renderUpcoming();
      renderRecommended();
      renderCalendar();
    }
  });
}

function initSidebar() {
  const sidebar = document.getElementById("sidebar");
  if (!sidebar) return;

  try {
    localStorage.removeItem("sidebarCollapsed");
    sidebar.classList.remove("is-collapsed");
  } catch {}

  const userAvatar = document.getElementById("userAvatar");
  const userName = document.getElementById("userName");
  const userRole = document.getElementById("userRole");

  if (userAvatar) {
    const initial = (studentProfile.firstName || "S")[0].toUpperCase();
    userAvatar.textContent = initial;
  }
  if (userName) {
    userName.textContent = studentProfile.fullName || "Student";
  }
  if (userRole) {
    userRole.textContent = "Student";
  }
}

function initOfflineSupport() {
  window.addEventListener("offline", () => {
    showToast("You are offline. Showing cached events.");
  });
}

/* ---------------------------------------------------------
   LIFECYCLE & CLEANUP
--------------------------------------------------------- */
function setupCleanup() {
  const cleanupAll = () => {
    if (tickInterval) clearInterval(tickInterval);
    attendanceListeners.forEach((unsub) => unsub());
    attendanceListeners.clear();
    firestoreRegistrationListeners.forEach((unsub) => unsub());
    firestoreRegistrationListeners.clear();
    activeCleanups.forEach((cleanup) => {
      try {
        cleanup();
      } catch (e) {}
    });
  };

  window.addEventListener("beforeunload", cleanupAll);
  window.addEventListener("pagehide", cleanupAll);
}

/* ---------------------------------------------------------
   INIT
--------------------------------------------------------- */
function init() {
  loadStudentProfileFromStorage();
  loadStudentPreferences();
  registeredEventIds = new Set(readParticipationsFromStorage());

  initSidebar();
  renderGreeting();
  initOfflineSupport();
  wireEvents();
  setupCleanup();

  // Evaluate event state every 30 seconds
  tickInterval = setInterval(() => {
    renderGreeting();
    renderHappeningNow();
    renderUpcoming();
    renderRecommended();
    renderCalendar();
  }, 30000);

  // Auth state listener
  if (auth) {
    onAuthStateChanged(auth, async (user) => {
      if (user) {
        currentUid = user.uid;
        if (db) {
          try {
            const userSnap = await getDoc(doc(db, "users", user.uid));
            if (userSnap.exists()) {
              const u = userSnap.data();
              const organization =
                u.organization ||
                u.courseOrganization ||
                u.courseOrg ||
                u.organizationCode ||
                u.organizationName;
              if (organization) {
                studentProfile.organization = organization;
                studentProfile.courseOrganization =
                  u.courseOrganization || u.courseOrg || organization;
                studentProfile.courseOrg = u.courseOrg || organization;
              }
              studentProfile.StudentOrgs = uniqueProfileValues(
                u.StudentOrgs,
                u.studentOrgs,
                u.organizations,
                organization,
              );
              studentProfile.departments = uniqueProfileValues(
                u.departments,
                u.departmentCodes,
                u.department,
                u.departmentCode,
                u.course,
                u.program,
              );
              if (u.department || u.departmentCode) {
                studentProfile.department = u.department || u.departmentCode || studentProfile.department;
                studentProfile.departmentCode = u.departmentCode || u.department || studentProfile.departmentCode;
              }

              if (!studentProfile.organization && studentProfile.department) {
                const dept = String(studentProfile.department).toUpperCase();
                if (dept.includes("IT") || dept.includes("INFORMATION")) {
                  studentProfile.organization = "IBITS";
                  studentProfile.courseOrganization = "IBITS";
                } else if (dept.includes("CPE") || dept.includes("COMPUTER")) {
                  studentProfile.organization = "ACES";
                  studentProfile.courseOrganization = "ACES";
                } else if (dept.includes("IE") || dept.includes("INDUSTRIAL")) {
                  studentProfile.organization = "PIIE";
                  studentProfile.courseOrganization = "PIIE";
                } else if (dept.includes("HRM") || dept.includes("HRSS")) {
                  studentProfile.organization = "HRSS";
                  studentProfile.courseOrganization = "HRSS";
                }
              }
              if (!studentProfile.StudentOrgs.length && studentProfile.organization) {
                studentProfile.StudentOrgs = [studentProfile.organization];
              }
              if (u.firstName || u.fullName || u.name) {
                studentProfile.fullName = u.fullName || u.name || [u.firstName, u.lastName].filter(Boolean).join(" ");
                studentProfile.firstName = u.firstName || studentProfile.fullName.split(" ")[0];
              }
              console.log(
                `[Student Dashboard] Verified student profile from Firestore for UID ${user.uid}: Organization = "${studentProfile.organization}", CourseOrg = "${studentProfile.courseOrganization}", Department = "${studentProfile.department}"`
              );
              renderGreeting();
              initSidebar();
              rebuildStudentEvents();
            }
          } catch (profileErr) {
            console.warn("[Student Dashboard] Could not fetch Firestore user doc:", profileErr);
          }
        }
        if (user.displayName && studentProfile.fullName === "Student") {
          studentProfile.fullName = user.displayName;
          studentProfile.firstName = user.displayName.split(" ")[0];
          renderGreeting();
          initSidebar();
        }
      }
      initDataListeners(user);
    });
  } else {
    initDataListeners();
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
