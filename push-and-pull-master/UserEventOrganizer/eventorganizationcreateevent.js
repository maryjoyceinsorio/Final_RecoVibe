/**
 * RecoVibe - Unified Create Event Page (Teacher & Event Organizer)
 * Complies with strict role-based access, accessible design, live preview,
 * readiness checks, conflict checking, reusable past events, and robust input rules.
 * Keep in sync with the other role's create event page.
 */
import { app, auth, authReady, db, rtdb, functions, isFirebaseConfigured } from "../UserStudent/firebaseConfig.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js";
import { ref, onValue, off, update, get, push, set, remove } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import { addDoc, collection, doc, getDoc, getDocs, onSnapshot, serverTimestamp, updateDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { deleteObject, getDownloadURL, getStorage, ref as storageRef, uploadBytes } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";

const FAVORITES_LIMIT = 5;
const storage = app ? getStorage(app) : null;

function sanitizeRtdbValue(value) {
  if (Array.isArray(value)) {
    return value
      .filter((entry) => entry !== undefined)
      .map((entry) => sanitizeRtdbValue(entry));
  }
  if (value && typeof value === "object" && !(value instanceof Blob) && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .map(([key, entry]) => [key, sanitizeRtdbValue(entry)]),
    );
  }
  return value;
}

function dataUrlToBlob(dataUrl, mimeType) {
  const [header, encodedData] = String(dataUrl).split(",");
  if (!header || !encodedData) throw new Error("An attached file could not be decoded.");
  const inferredType = header.match(/^data:([^;]+)/)?.[1] || mimeType || "application/octet-stream";
  const binary = atob(encodedData);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: inferredType });
}

function sanitizeStorageFileName(name) {
  return String(name || "attachment")
    .replace(/[\\/:*?"<>|#%]+/g, "_")
    .slice(0, 120);
}

async function uploadEventAttachments(payload, uid) {
  const uploadedRefs = [];
  const uploadedById = new Map();
  const uploadedByFile = new WeakMap();

  async function cleanupUploadedFiles(refs) {
    const results = await Promise.allSettled(refs.map((objectRef) => deleteObject(objectRef)));
    results.forEach((result) => {
      if (result.status === "rejected") {
        console.error("[CreateEvent] Could not clean up an uploaded Storage file:", {
          code: result.reason?.code || "unknown",
          message: result.reason?.message || String(result.reason),
        });
      }
    });
  }

  async function uploadDescriptor(file) {
    const dataUrl = [file.dataUrl, file.url, file.path].find(
      (value) => typeof value === "string" && value.startsWith("data:"),
    );
    const fileBlob = file.fileRef instanceof Blob
      ? file.fileRef
      : dataUrl
        ? dataUrlToBlob(dataUrl, file.mime)
        : null;
    const existingUrl = [file.url, file.path].find(
      (value) => typeof value === "string" && /^(https?:|gs:)/i.test(value),
    );

    let downloadUrl = existingUrl || "";
    if (fileBlob) {
      if (!storage) throw new Error("Firebase Storage is not configured.");
      if (fileBlob.size > 10 * 1024 * 1024) {
        throw new Error(`"${file.name || "Attachment"}" exceeds the 10 MB upload limit.`);
      }
      const cached = file.fileRef instanceof Blob
        ? uploadedByFile.get(file.fileRef)
        : uploadedById.get(String(file.id || ""));
      if (cached) {
        downloadUrl = cached;
      } else {
        const uniqueName = `${Date.now()}-${crypto.randomUUID()}-${sanitizeStorageFileName(file.name)}`;
        const objectRef = storageRef(storage, `events/${uid}/attachments/${uniqueName}`);
        try {
          await uploadBytes(objectRef, fileBlob, {
            contentType: file.mime || fileBlob.type || "application/octet-stream",
          });
          uploadedRefs.push(objectRef);
          downloadUrl = await getDownloadURL(objectRef);
          if (file.fileRef instanceof Blob) uploadedByFile.set(file.fileRef, downloadUrl);
          if (file.id) uploadedById.set(String(file.id), downloadUrl);
        } catch (error) {
          console.error("[CreateEvent] Storage upload failed:", {
            code: error?.code || "unknown",
            message: error?.message || String(error),
            fileName: file.name || "",
          });
          throw new Error(`Could not upload "${file.name || "attachment"}": ${error.message || "Storage upload failed."}`, { cause: error });
        }
      }
    } else if (!downloadUrl && (file.fileRef || dataUrl)) {
      throw new Error(`Could not upload "${file.name || "attachment"}": file data is unavailable. Reattach the file and retry.`);
    }

    const cleanFile = { ...file };
    delete cleanFile.fileRef;
    delete cleanFile.dataUrl;
    delete cleanFile.thumbnail;
    if (downloadUrl) {
      cleanFile.url = downloadUrl;
      cleanFile.path = downloadUrl;
    } else {
      if (typeof cleanFile.path === "string" && cleanFile.path.startsWith("data:")) delete cleanFile.path;
      if (typeof cleanFile.url === "string" && cleanFile.url.startsWith("data:")) delete cleanFile.url;
    }
    return cleanFile;
  }

  async function visit(value) {
    if (Array.isArray(value)) {
      const result = [];
      for (const item of value) result.push(await visit(item));
      return result;
    }
    if (!value || typeof value !== "object" || value instanceof Date || value instanceof Blob) return value;
    if (value.fileRef || value.dataUrl || value.url || value.path) return uploadDescriptor(value);
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = await visit(item);
    }
    return result;
  }

  try {
    return { payload: await visit(payload), uploadedRefs };
  } catch (error) {
    await cleanupUploadedFiles(uploadedRefs);
    throw error;
  }
}

function redactSubmissionPayloadForLog(value, key = "") {
  if (/(email|phone|contact|organizer|createdBy|uid|path|url|token|auth)/i.test(key)) {
    return value == null || value === "" ? value : "[REDACTED]";
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactSubmissionPayloadForLog(entry));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        redactSubmissionPayloadForLog(entryValue, entryKey),
      ]),
    );
  }
  return value;
}

const DEFAULT_APPROVAL_STAGES = [
  { id: "stage-1", name: "Organization President", reviewer: "Organization President", required: true },
  { id: "stage-2", name: "Organization Adviser Review", reviewer: "Organization Adviser (Sir Migs)", required: true },
  { id: "stage-3", name: "OSAS Review", reviewer: "Ma'am Joyce - OSAS", required: true },
  { id: "stage-4", name: "Director Review", reviewer: "Ma'am Margarita - Director", required: true },
  { id: "stage-5", name: "Final Approval & Publishing", reviewer: "Authorized approver(s)", required: true },
];
function normalizeApprovalStages(stages) {
  const source = Array.isArray(stages) && stages.length ? stages : DEFAULT_APPROVAL_STAGES;
  return source
    .filter((stage) => stage && typeof stage === "object")
    .map((stage, index) => ({
      ...stage,
      id: String(stage.id || stage.key || `stage-${index + 1}`),
      name: String(stage.name || stage.label || `Stage ${index + 1}`),
      reviewer: String(stage.reviewer || stage.name || stage.label || ""),
      reviewerEmail: String(stage.reviewerEmail || stage.email || "").trim().toLowerCase(),
      required: stage.required !== false,
    }));
}

let systemApprovalStages = normalizeApprovalStages(DEFAULT_APPROVAL_STAGES);

function loadCachedApprovalStages() {
  try {
    const cached = localStorage.getItem("recovibe_approval_stages");
    if (cached) {
      const parsed = JSON.parse(cached);
      if (Array.isArray(parsed) && parsed.length > 0) {
        systemApprovalStages = normalizeApprovalStages(parsed);
      }
    }
  } catch {}
}
loadCachedApprovalStages();

const PARTNER_ORGS_POOL = [
  { id: "aces", name: "ACES", subtitle: "Association of Computer Engineering Students" },
  { id: "csc", name: "CSC", subtitle: "Central Student Council" },
  { id: "ibits", name: "IBITS", subtitle: "Institute of Bachelors in Information Technology Studies" },
  { id: "hrss", name: "HRSS", subtitle: "HRSS" },
  { id: "piie", name: "PIIE", subtitle: "Philippine Institute of Industrial Engineers" },
  { id: "sms", name: "SMS", subtitle: "SMS" },
  { id: "yes", name: "YES", subtitle: "YES" },
];

let partnerOrgsPool = [...PARTNER_ORGS_POOL];

function getCanonicalPartnerOrganization(value) {
  const key = String(value || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  const canonicalKey = key === "PIEE" ? "PIIE" : key;
  return PARTNER_ORGS_POOL.find(
    (organization) => organization.name === canonicalKey,
  ) || null;
}

function normalizePartnerOrganizations() {
  return [...PARTNER_ORGS_POOL];
}

function loadCachedOrganizations() {
  try {
    const cached = localStorage.getItem("recovibe_organizations");
    if (cached) {
      const parsed = JSON.parse(cached);
      if (Array.isArray(parsed) && parsed.length > 0) {
        partnerOrgsPool = normalizePartnerOrganizations(parsed);
      }
    }
  } catch {}
}
loadCachedOrganizations();

(function initCreateEventModule() {
  "use strict";

  // Ensure page explicitly runs in light theme matching Photo 3 & 4
  try {
    document.documentElement.setAttribute("data-theme", "light");
    if (document.body) {
      document.body.classList.remove("dark-mode");
    }
  } catch (e) {}

  // 1. Detect Context & Page
  const isOrganizerPage = /EventOrganizerCreateEvent\.html$/i.test(location.pathname);
  const root = document.getElementById("createEventRoot");
  if (!root) {
    console.error("Root element #createEventRoot not found.");
    return;
  }
  root.setAttribute("data-theme", "light");
  root.hidden = false;

  // Check URL parameters for explicit unauthorized testing (e.g. ?role=Student or ?role=Admin)
  const urlParams = new URLSearchParams(location.search);
  const queryRole = urlParams.get("role")?.toLowerCase();
  const queryUnauthorized = urlParams.get("unauthorized");

  if (queryUnauthorized === "true" || (queryRole && ["student", "admin", "superadmin"].includes(queryRole))) {
    renderUnauthorized("Access Restricted", "This page is strictly reserved for Teachers and Event Organizers. You do not have permission to create events.");
    return;
  }

  // 2. Identify Role & Profiles with Safe Fallbacks
  const teacherId = localStorage.getItem("recovibeTeacherId");
  const teacherProfile = readJSON("recovibeCurrentTeacher", null) || readJSON("recovibeTeacher", null) || {};
  const organizerId = localStorage.getItem("recovibeOrganizerId");
  const organizerProfile = readJSON("recovibeOrganizerProfile", null) || readJSON("recovibeOrganizer", null) || {};

  const currentRole = isOrganizerPage ? "Event Organizer" : "Teacher";

  const userIdentifier = isOrganizerPage
    ? String(organizerId || organizerProfile.id || organizerProfile.email || "organizer-ibits").trim()
    : String(teacherId || teacherProfile.id || teacherProfile.email || "teacher-faculty").trim();

  const teacherName = String(teacherProfile.name || teacherProfile.fullName || "Prof. Faculty").trim();
  const organizerOrgName = String(organizerProfile.organization || organizerProfile.orgName || organizerProfile.name || "IBITS").trim();

  const readOnlyOrganizerValue = isOrganizerPage ? organizerOrgName : teacherName;
  function getAutomaticEventSource() {
    if (isOrganizerPage) {
      if (/csc/i.test(organizerOrgName)) return "CSC";
      return "Organization";
    }
    return "Teachers / Faculty";
  }
  const defaultEventSource = getAutomaticEventSource();

  function normalizeEventSource(src) {
    if (!src) return defaultEventSource;
    if (["Academic Organization", "Non-Academic Organization", "Student Council", "Organization"].includes(src)) {
      return "Organization";
    }
    return src;
  }

  function normalizeTargetAudience(value) {
    const normalized = String(value || "").trim().toLowerCase().replace(/[^a-z]/g, "");
    if (normalized.includes("mixed")) return "Mixed Audience";
    if (normalized.includes("organizationmembers")) return "Organization Members Only";
    return "Open to All";
  }

  async function getOrganizerOrganizationCode(organizerUid) {
    const profileSnapshot = await getDoc(doc(db, "adminUser", organizerUid));
    if (!profileSnapshot.exists()) {
      throw new Error("Your organizer account profile could not be verified. Contact an administrator.");
    }
    const profile = profileSnapshot.data() || {};
    const role = String(profile.role || profile.userRole || "")
      .trim()
      .toLowerCase()
      .replace(/[\s_-]+/g, "");
    if (!["eventorganizer", "organizer", "eo"].includes(role)) {
      throw new Error("Your account is not authorized to submit events as an organizer.");
    }
    const organizationCode = String(
      profile.organizationCode ||
      profile.orgCode ||
      profile.organization ||
      profile.organizationName ||
      profile.orgName ||
      "",
    ).trim().replace(/\s+/g, " ").toUpperCase();
    if (!organizationCode) {
      throw new Error("Your organizer profile must have an organization assigned before submitting an event.");
    }
    return organizationCode;
  }

  const storageKeyEvents = isOrganizerPage ? "recovibeOrganizerEvents" : "recovibeTeacherEvents";
  const redirectListUrl = isOrganizerPage ? "EventOrganizerMyEvents.html" : "TeacherMyEvent.html";

  let currentAuthUid = auth?.currentUser?.uid || userIdentifier;

  function getEffectiveUid() {
    return auth?.currentUser?.uid || currentAuthUid || userIdentifier;
  }

  function getStoredReuseLibrary() {
    const uid = getEffectiveUid();
    const stored = readJSON(`recovibeReuseLibrary_${uid}`, null) ||
                   readJSON(`recovibeReuseLibrary_${userIdentifier}`, null) ||
                   {};
    return stored;
  }

  function saveStoredReuseLibrary(data) {
    const uid = getEffectiveUid();
    writeJSON(`recovibeReuseLibrary_${userIdentifier}`, data);
    if (uid && uid !== userIdentifier) {
      writeJSON(`recovibeReuseLibrary_${uid}`, data);
    }
  }

  let reuseLibrary = getStoredReuseLibrary();
  let activeReuseListenerRef = null;
  let activeConfirmationTriggerBtn = null;
  const undoTimeouts = new Map();

  // System Settings
  const systemSettings = readJSON("recovibeSystemSettings", {}) || {};
  const requireApproval = systemSettings.requireApprovalForNewEvents !== false;
  const registrationEnabled = systemSettings.registrationEnabled !== false;

  // Manila Date & Timezone Helpers (Never derive local day from toISOString)
  function getManilaDateInfo() {
    const now = new Date();
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Manila",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const dateStr = formatter.format(now); // e.g. "2026-10-13"
    const [year, month, day] = dateStr.split("-").map(Number);
    const currentYear = year;
    const maxYear = currentYear + 2;
    const lastDayOfMaxMonth = new Date(Date.UTC(maxYear, month, 0)).getUTCDate();
    const maxDateStr = [
      maxYear,
      String(month).padStart(2, "0"),
      String(Math.min(day, lastDayOfMaxMonth)).padStart(2, "0"),
    ].join("-");
    return {
      todayStr: dateStr,
      currentYear,
      maxYear,
      maxDateStr,
    };
  }

  function getManilaDateTimeString(timestamp = Date.now()) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Manila",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(timestamp));
    const value = (type) => parts.find((part) => part.type === type)?.value || "";
    return `${value("year")}-${value("month")}-${value("day")}T${value("hour")}:${value("minute")}`;
  }

  function getManilaCurrentMinutes() {
    const now = new Date();
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Manila",
      hour12: false,
      hour: "numeric",
      minute: "numeric",
    }).formatToParts(now);
    const h = parseInt(parts.find((p) => p.type === "hour").value, 10);
    const m = parseInt(parts.find((p) => p.type === "minute").value, 10);
    return h * 60 + m;
  }

  // 3. Dropdown & Constant Data
  const EVENT_SOURCES = [
    "PUP Official",
    "CSC",
    "Teachers / Faculty",
    "Organization",
    "External",
  ];

  // Helper: Registration end must strictly be 1 or 2 days before event date
  function calculateAutoRegistrationEnd(eventDateStr) {
    if (!eventDateStr) return "";
    const [y, m, d] = eventDateStr.split("-").map(Number);
    const evDate = new Date(Date.UTC(y, m - 1, d));
    const [todayYear, todayMonth, todayDay] = getManilaDateInfo().todayStr.split("-").map(Number);
    const today = new Date(Date.UTC(todayYear, todayMonth - 1, todayDay));
    const daysDiff = Math.round((evDate - today) / (1000 * 60 * 60 * 24));
    const daysBefore = daysDiff >= 3 ? 2 : 1;
    const targetDate = new Date(evDate);
    targetDate.setUTCDate(targetDate.getUTCDate() - daysBefore);
    const ty = targetDate.getUTCFullYear();
    const tm = String(targetDate.getUTCMonth() + 1).padStart(2, "0");
    const td = String(targetDate.getUTCDate()).padStart(2, "0");
    return `${ty}-${tm}-${td}T23:59`;
  }

  function calculateMaxRegistrationEnd(eventDateStr) {
    if (!eventDateStr) return "";
    const [y, m, d] = eventDateStr.split("-").map(Number);
    const maxDate = new Date(Date.UTC(y, m - 1, d));
    maxDate.setUTCDate(maxDate.getUTCDate() - 1);
    const my = maxDate.getUTCFullYear();
    const mm = String(maxDate.getUTCMonth() + 1).padStart(2, "0");
    const md = String(maxDate.getUTCDate()).padStart(2, "0");
    return `${my}-${mm}-${md}T23:59`;
  }

  function getDefaultEventDate(todayStr) {
    if (!todayStr) return "";
    const [y, m, d] = todayStr.split("-").map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() + 3);
    const ty = dt.getUTCFullYear();
    const tm = String(dt.getUTCMonth() + 1).padStart(2, "0");
    const td = String(dt.getUTCDate()).padStart(2, "0");
    return `${ty}-${tm}-${td}`;
  }

  const CATEGORIES = [
    "Academic & Learning",
    "Tech & Innovation",
    "Leadership & Career",
    "Sports & Fitness",
    "Music & Entertainment",
    "Orgs & Student Acts",
    "Social Events",
    "Community & Outreach",
    "Competitions",
    "Seminars & Workshops",
    "Arts & Culture",
    "University & Campuses",
  ];

  // Target Year Level: Default "All Levels"
  const TARGET_YEARS = [
    "1st Year",
    "2nd Year",
    "3rd Year",
    "4th Year",
    "Ladderize",
  ];
  const TARGET_DEPARTMENTS = [
    "BSIT",
    "BSCPE",
    "BSBA",
    "BSOA",
    "BSHM",
    "BSIE",
    "BS Psychology",
    "BSBA HRM",
    "BSED Secondary",
    "BSED Elementary (Elem)",
    "BSED Social Science",
  ];
  const ORGANIZATION_DEPARTMENT_MAP = {
    ibits: "BSIT",
    instituteofbachelorsininformationtechnologystudies: "BSIT",
    aces: "BSCPE",
    associationofcomputerengineeringstudents: "BSCPE",
    piie: "BSIE",
    piee: "BSIE",
    philippineinstituteofindustrialengineers: "BSIE",
    yes: "BSBA",
    youngentrepreneurssociety: "BSBA",
    sms: "BSBA",
    societyofmanagementstudents: "BSBA",
    hrss: "BSBA HRM",
    humanresourcestudentssociety: "BSBA HRM",
  };
  const normalizeDepartmentKey = (value) =>
    String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  const getOrganizationDepartment = (value) => {
    const key = normalizeDepartmentKey(value);
    if (!key) return "";
    const directMatch = ORGANIZATION_DEPARTMENT_MAP[key];
    if (directMatch) return directMatch;
    const alias = Object.keys(ORGANIZATION_DEPARTMENT_MAP).find(
      (organizationKey) => key.endsWith(organizationKey) ||
        (organizationKey.length > 8 && key.includes(organizationKey)),
    );
    return alias ? ORGANIZATION_DEPARTMENT_MAP[alias] : "";
  };
  const normalizeTargetDepartment = (value) => {
    const key = normalizeDepartmentKey(value);
    const directMatch = TARGET_DEPARTMENTS.find(
      (department) => normalizeDepartmentKey(department) === key,
    );
    if (directMatch) return directMatch;
    if (["bssecondary", "bsedsecondary"].includes(key)) return "BSED Secondary";
    if (["bselementaryeducation", "bsedelementary", "bsedelementaryelem"].includes(key)) {
      return "BSED Elementary (Elem)";
    }
    if (["bsbahrm", "bsbshrm"].includes(key) || key.includes("humanresourcemanagement")) {
      return "BSBA HRM";
    }
    if (key.includes("socialscience")) return "BSED Social Science";
    if (key.includes("psychology")) return "BS Psychology";
    if (key.includes("computerengineering")) return "BSCPE";
    if (key.includes("informationtechnology")) return "BSIT";
    if (key.includes("industrial")) return "BSIE";
    if (key.includes("officeadministration")) return "BSOA";
    if (key.includes("hospitality")) return "BSHM";
    if (key.includes("businessadministration")) return "BSBA";
    return "";
  };
  function getOrganizingDepartment() {
    const profile = isOrganizerPage ? organizerProfile : teacherProfile;
    const departmentValues = [
      profile.departmentCode,
      profile.department,
      profile.course,
    ];
    for (const value of departmentValues) {
      const department = normalizeTargetDepartment(value);
      if (department) return department;
    }
    const organizationValues = [
      profile.organizationCode,
      profile.orgCode,
      profile.organization,
      profile.organizationName,
      profile.orgName,
      isOrganizerPage ? organizerOrgName : "",
    ];
    for (const value of organizationValues) {
      const department = getOrganizationDepartment(value);
      if (department) return department;
    }
    return "";
  }

  // Venue Records with explicit type (indoor, outdoor, online)
  const VENUES_GROUPED = [
    {
      campus: "PUP Biñan",
      venues: [
        { name: "Open Field | PUP Biñan", maxCapacity: 500, type: "outdoor" },
        { name: "AVR1 | PUP Biñan", maxCapacity: 150, type: "indoor" },
        { name: "AVR2 | PUP Biñan", maxCapacity: 100, type: "indoor" },
        { name: "AVR2-1Room | PUP Biñan", maxCapacity: 40, type: "indoor" },
        { name: "AVR2-2Room | PUP Biñan", maxCapacity: 40, type: "indoor" },
        { name: "AVR2-3Room | PUP Biñan", maxCapacity: 40, type: "indoor" },
        { name: "Kiosk | PUP Biñan", maxCapacity: 50, type: "outdoor" },
      ],
    },
    {
      campus: "PUP CITE",
      venues: [
        { name: "Open Field | PUP CITE", maxCapacity: 500, type: "outdoor" },
        { name: "4th Floor | PUP CITE", maxCapacity: 200, type: "indoor" },
      ],
    },
    {
      campus: "Other",
      venues: [
        { name: "Others | Inside PUP", maxCapacity: 100, type: "indoor" },
        { name: "Others | Outside PUP", maxCapacity: 200, type: "outdoor" },
        { name: "Online / Virtual", maxCapacity: 1000, type: "online" },
      ],
    },
  ];

  const VENUES_FLAT_MAP = {};
  VENUES_GROUPED.forEach((group) => {
    group.venues.forEach((v) => {
      VENUES_FLAT_MAP[v.name] = { maxCapacity: v.maxCapacity, type: v.type };
    });
  });

  const manilaDateInfo = getManilaDateInfo();

  // 4. State Management
  const state = {
    mode: "new", // "new" (default) | "existing" — start on the Create New Event form
    searchQuery: "",
    isCopied: false,
    copiedFrom: null,
    editingEventId: null,
    draftId: null,
    clientRequestId: null,
    dirty: false,
    selectedCategories: [],
    participatingFaculty: [],
    participantDocs: [],
    legacyParticipantDocs: [],
    participantDocumentLink: "",
    adminDocsLink: "",
    adminDocumentLinks: {
      adminReview: "",
    },
    conflict: null,
    highlightedFields: new Set(),
    categoryDropdownOpen: false,
    deadlineManuallyEdited: false,
    targetAudience: "Open to All",
    targetDepartments: [],
    targetYearLevels: [],
    targetSections: [],
    isCollaboration: false,
    partnerOrganizations: [],
    collaborationNotes: "",
    externalGuests: [],
    outsideGuests: false,
    addAsFavorite: false,
    activeConfirm: null,
    isActionBusy: false,
    submissionEventId: null,
    reuseLoading: false,
    reuseError: null,
    selectedApprovers: systemApprovalStages.map((s) => s.id),
  };

  const autoPartnerTargetDepartments = new Set();
  function getPartnerOrganizationDepartment(organization) {
    const values = typeof organization === "string"
      ? [organization]
      : [
          organization?.id,
          organization?.code,
          organization?.organizationCode,
          organization?.orgCode,
          organization?.name,
          organization?.subtitle,
        ];
    for (const value of values) {
      const department = getOrganizationDepartment(value);
      if (department) return department;
    }
    return "";
  }
  function getAssociatedOrganizationDepartments() {
    return new Set([
      getOrganizingDepartment(),
      ...state.partnerOrganizations.map(getPartnerOrganizationDepartment),
    ].filter(Boolean));
  }
  function syncPartnerTargetDepartments() {
    const associatedDepartments = getAssociatedOrganizationDepartments();
    const partnerDepartments = new Set(
      state.partnerOrganizations.map(getPartnerOrganizationDepartment).filter(Boolean),
    );
    const primaryDepartment = getOrganizingDepartment();
    const inputs = [...document.querySelectorAll(".ce-target-department")];
    const organizationMembersOnly =
      normalizeTargetAudience(document.getElementById("targetAudience")?.value) ===
      "Organization Members Only";
    inputs.forEach((input) => {
      if (organizationMembersOnly) {
        input.checked = associatedDepartments.has(input.value);
        input.disabled = true;
        return;
      }
      input.disabled = false;
      if (associatedDepartments.has(input.value)) {
        if (partnerDepartments.has(input.value) && input.value !== primaryDepartment) {
          autoPartnerTargetDepartments.add(input.value);
        }
        input.checked = true;
      } else if (autoPartnerTargetDepartments.has(input.value)) {
        input.checked = false;
        autoPartnerTargetDepartments.delete(input.value);
      }
    });

    const audience = normalizeTargetAudience(document.getElementById("targetAudience")?.value);
    state.targetDepartments = audience === "Open to All"
      ? []
      : inputs.filter((input) => input.checked).map((input) => input.value);
  }

  Object.defineProperty(state, "participantFiles", {
    get() { return this.participantDocs; },
    set(val) { this.participantDocs = Array.isArray(val) ? val : []; }
  });
  // 5. Safe Utilities
  function readJSON(key, fallback) {
    try {
      const val = localStorage.getItem(key);
      return val ? JSON.parse(val) : fallback;
    } catch {
      return fallback;
    }
  }

  function writeJSON(key, data) {
    try {
      localStorage.setItem(key, JSON.stringify(data));
      return true;
    } catch {
      return false;
    }
  }

  function escapeHTML(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // 6. Toast Notification Helper
  function showToast(message) {
    const existing = document.querySelector(".ce-toast");
    if (existing) existing.remove();

    const toast = document.createElement("div");
    toast.className = "ce-toast";
    toast.setAttribute("role", "status");
    toast.textContent = message;
    document.body.appendChild(toast);

    setTimeout(() => {
      toast.classList.add("is-visible");
    }, 10);

    setTimeout(() => {
      toast.classList.remove("is-visible");
      setTimeout(() => toast.remove(), 250);
    }, 3000);
  }

  function setRequestBusy(button, busy, idleLabel) {
    if (!button) return;
    button.disabled = busy;
    button.setAttribute("aria-busy", String(busy));
    button.textContent = busy ? "Saving…" : idleLabel;
  }

  function showServerFieldErrors(error) {
    const fields = error?.details?.fields;
    if (!Array.isArray(fields) || fields.length === 0) return false;
    let firstControl = null;
    fields.forEach(({ field, message }) => {
      const control = document.getElementById(field) ||
        document.querySelector(`[name="${CSS.escape(field)}"]`);
      const wrapper = control?.closest(".ce-field") || document.getElementById(`wrap-${field}`);
      if (!wrapper) return;
      let errorNode = wrapper.querySelector(".ce-error");
      if (!errorNode) {
        errorNode = document.createElement("p");
        errorNode.className = "ce-error";
        wrapper.appendChild(errorNode);
      }
      errorNode.textContent = String(message || "Please check this field.");
      errorNode.hidden = false;
      wrapper.classList.add("has-error");
      control?.setAttribute("aria-invalid", "true");
      if (!firstControl) firstControl = control;
    });
    firstControl?.focus();
    return true;
  }

  function getFriendlyFunctionError(error, fallback) {
    const code = String(error?.code || "")
      .replace(/^functions\//i, "")
      .toLowerCase();
    const message = String(error?.message || "")
      .replace(/^FirebaseError:\s*/i, "")
      .replace(/^functions\/[a-z-]+:\s*/i, "")
      .trim();
    const genericError = /^(internal|unknown|unauthenticated|permission-denied|invalid-argument)$/i;
    if (!["internal", "unknown", "unauthenticated", "permission-denied", "invalid-argument"].includes(code) &&
      message && !genericError.test(message)) {
      return message;
    }
    return fallback;
  }

  // 7. Load Past Events for Current User
  function loadCurrentUserEvents() {
    const list = readJSON(storageKeyEvents, []);
    const filtered = list.filter((ev) => {
      if (!ev) return false;
      if (isOrganizerPage) {
        const orgMatch = (ev.organizer || ev.organizerName || "").toLowerCase().includes(organizerOrgName.toLowerCase()) ||
                         (ev.organizer || ev.organizerName || "").toLowerCase().includes("ibits") ||
                         (ev.organizer || ev.organizerName || "").toLowerCase().includes("organizer");
        const idMatch = String(ev.createdBy || ev.organizerId || "").toLowerCase() === userIdentifier.toLowerCase();
        return orgMatch || idMatch;
      } else {
        const creatorMatch = String(ev.createdBy || ev.teacherId || "").toLowerCase() === userIdentifier.toLowerCase();
        const facultyMatch = Array.isArray(ev.participatingFaculty) && ev.participatingFaculty.some((f) =>
          String(f.id || f.name || "").toLowerCase().includes(teacherName.toLowerCase()) ||
          String(f.id || "").toLowerCase() === userIdentifier.toLowerCase()
        );
        const nameMatch = (ev.organizer || ev.organizerName || "").toLowerCase().includes(teacherName.toLowerCase());
        return creatorMatch || facultyMatch || nameMatch;
      }
    });

    if (filtered.length === 0) {
      const sampleEvents = isOrganizerPage ? [
        {
          id: "seed-org-1",
          eventId: "seed-org-1",
          title: "IBITS General Assembly 2025",
          organizer: organizerOrgName,
          organizerName: organizerOrgName,
          source: "Organization",
          category: "Orgs & Student Acts, Leadership & Career",
          categories: ["Orgs & Student Acts", "Leadership & Career"],
          targetYear: "All Levels",
          date: "2025-09-18",
          dateISO: "2025-09-18",
          timeStart: "08:00 AM",
          timeEnd: "12:00 PM",
          venue: "AVR1 | PUP Biñan",
          maxCapacity: 120,
          description: "Annual general assembly for all IBITS members and computer studies students.",
          isCommon: true,
          participantDocuments: [{ name: "General_Assembly_Program.pdf", size: 245000, type: "PDF" }],
        },
        {
          id: "seed-org-2",
          eventId: "seed-org-2",
          title: "Web Development Bootcamp & Tech Talk",
          organizer: organizerOrgName,
          organizerName: organizerOrgName,
          source: "Organization",
          category: "Tech & Innovation, Academic & Learning",
          categories: ["Tech & Innovation", "Academic & Learning"],
          targetYear: "2nd Year",
          date: "2025-11-12",
          dateISO: "2025-11-12",
          timeStart: "01:00 PM",
          timeEnd: "05:00 PM",
          venue: "AVR2 | PUP Biñan",
          maxCapacity: 80,
          description: "Hands-on workshop covering modern web technologies and industry practices.",
          isCommon: true,
          participantDocuments: [{ name: "Bootcamp_Handout.docx", size: 180000, type: "DOCX" }],
        },
        {
          id: "seed-org-3",
          eventId: "seed-org-3",
          title: "CodeFest 2025: Hackathon Championship",
          organizer: organizerOrgName,
          organizerName: organizerOrgName,
          source: "Organization",
          category: "Competitions, Tech & Innovation",
          categories: ["Competitions", "Tech & Innovation"],
          targetYear: "All Levels",
          date: "2025-12-05",
          dateISO: "2025-12-05",
          timeStart: "08:00 AM",
          timeEnd: "06:00 PM",
          venue: "Open Field | PUP Biñan",
          maxCapacity: 250,
          description: "Inter-collegiate programming contest and development sprint.",
          isCommon: false,
          participantDocuments: [{ name: "Hackathon_Mechanics.pdf", size: 310000, type: "PDF" }],
        },
      ] : [
        {
          id: "seed-tch-1",
          eventId: "seed-tch-1",
          title: "Faculty Research & Curriculum Colloquium",
          organizer: teacherName,
          organizerName: teacherName,
          source: "Teachers / Faculty",
          category: "Academic & Learning, Seminars & Workshops",
          categories: ["Academic & Learning", "Seminars & Workshops"],
          targetYear: "All Levels",
          date: "2025-10-15",
          dateISO: "2025-10-15",
          timeStart: "09:00 AM",
          timeEnd: "12:00 PM",
          venue: "AVR1 | PUP Biñan",
          maxCapacity: 100,
          description: "Curriculum alignment and faculty research showcase.",
          isCommon: true,
          participatingFaculty: [{ id: userIdentifier, name: teacherName, email: "faculty@pup.edu.ph" }],
          participantDocuments: [{ name: "Research_Colloquium_Agenda.pdf", size: 320000, type: "PDF" }],
        },
        {
          id: "seed-tch-2",
          eventId: "seed-tch-2",
          title: "Midterm Review & Academic Consultation Session",
          organizer: teacherName,
          organizerName: teacherName,
          source: "Teachers / Faculty",
          category: "Academic & Learning",
          categories: ["Academic & Learning"],
          targetYear: "1st Year",
          date: "2025-11-20",
          dateISO: "2025-11-20",
          timeStart: "01:00 PM",
          timeEnd: "05:00 PM",
          venue: "AVR2 | PUP Biñan",
          maxCapacity: 80,
          description: "Departmental academic consultation and tutoring clinic.",
          isCommon: false,
          participatingFaculty: [{ id: userIdentifier, name: teacherName, email: "faculty@pup.edu.ph" }],
          participantDocuments: [{ name: "Consultation_Schedule.pdf", size: 150000, type: "PDF" }],
        },
      ];

      if (isOrganizerPage) {
        if (!readJSON("recovibeOrganizerEvents", null)) {
          writeJSON("recovibeOrganizerEvents", sampleEvents);
        }
      } else {
        if (!readJSON("recovibeTeacherEvents", null)) {
          writeJSON("recovibeTeacherEvents", sampleEvents);
        }
      }
      return sampleEvents;
    }

    return filtered;
  }

  // 8. Load Faculty Pool from Database (Firestore adminUser / users & RTDB)
  let dbFacultyPool = [];
  let isFacultyDbInitialized = false;

  function loadFacultyPool() {
    if (!isFacultyDbInitialized) {
      initFacultyDatabaseListener();
    }

    return Array.isArray(dbFacultyPool)
      ? dbFacultyPool.filter((faculty) => faculty && faculty.id && faculty.name)
      : [];
  }

  function initFacultyDatabaseListener() {
    if (isFacultyDbInitialized) return;
    isFacultyDbInitialized = true;

    if (isFirebaseConfigured && db) {
      try {
        onSnapshot(collection(db, "adminUser"), (snapshot) => {
          const loaded = [];
          snapshot.docs.forEach((docSnap) => {
            const data = docSnap.data() || {};
            const role = String(data.role || data.userRole || "").toLowerCase();
            if (role.includes("teach") || role.includes("facult") || role.includes("prof") || role.includes("instructor") || role.includes("adviser")) {
              const familyFirstName = [data.lastName, data.firstName].filter(Boolean).join(" ");
              const name = data.fullName || familyFirstName || data.name || data.displayName;
              if (name && typeof name === "string" && name.trim()) {
                const cleanName = name.trim();
                loaded.push({
                  id: docSnap.id,
                  name: cleanName,
                  email: data.email || `${cleanName.toLowerCase().replace(/\s+/g, ".")}@pup.edu.ph`,
                  department: data.department || "Faculty",
                });
              }
            }
          });

          const mergedMap = new Map(
            dbFacultyPool.map((faculty) => [faculty.name.toLowerCase(), faculty]),
          );
          loaded.forEach((faculty) => mergedMap.set(faculty.name.toLowerCase(), faculty));
          dbFacultyPool = Array.from(mergedMap.values());
        }, (err) => {
          console.warn("[CreateEvent] adminUser listener failed, trying getDocs fallback:", err);
          fetchDatabaseFacultyOnce();
        });
      } catch (err) {
        console.warn("[CreateEvent] Failed to listen to adminUser:", err);
        fetchDatabaseFacultyOnce();
      }

      try {
        onSnapshot(doc(db, "system_settings", "global_config"), (docSnap) => {
          if (docSnap.exists()) {
            const data = docSnap.data() || {};
            if (Array.isArray(data.approvalStages) && data.approvalStages.length > 0) {
              const stages = normalizeApprovalStages(data.approvalStages);
              systemApprovalStages = stages;
              try {
                localStorage.setItem("recovibe_approval_stages", JSON.stringify(stages));
              } catch {}
              renderApprovers();
            }

            if (Array.isArray(data.organizations) && data.organizations.length > 0) {
              partnerOrgsPool = normalizePartnerOrganizations(data.organizations);
              try {
                localStorage.setItem("recovibe_organizations", JSON.stringify(data.organizations));
              } catch {}
              renderPartnerOrgSelectOptions();
            }

            if (data.mainOrganization) {
              try {
                localStorage.setItem("recovibe_main_org", data.mainOrganization);
              } catch {}
              const hint = document.getElementById("targetAudienceHint");
              if (hint) {
                hint.textContent = `Organization members only refers to members of ${data.mainOrganization}.`;
              }
            }
          }
        });
      } catch (err) {
        console.warn("[CreateEvent] Failed to listen to system_settings/global_config:", err);
      }

  function renderPartnerOrgSelectOptions() {
    const select = document.getElementById("partnerOrgSelect");
    if (!select) return;
    const currentVal = select.value;
    select.innerHTML = `
      <option value="" disabled ${!currentVal ? "selected" : ""}>Select organization...</option>
      ${partnerOrgsPool.map(org => `<option value="${escapeHTML(org.id)}">${escapeHTML(org.name)} - ${escapeHTML(org.subtitle)}</option>`).join("")}
    `;
    if (currentVal && partnerOrgsPool.some(o => o.id === currentVal)) {
      select.value = currentVal;
    }
  }

      fetchDatabaseFacultyOnce();
    }
  }

  async function fetchDatabaseFacultyOnce() {
    if (!isFirebaseConfigured || !db) return;
    try {
      const usersSnap = await getDocs(collection(db, "users"));
      usersSnap.forEach((docSnap) => {
        const data = docSnap.data() || {};
        const role = String(data.role || data.userRole || "").toLowerCase();
        if (role.includes("teach") || role.includes("facult") || role.includes("prof") || role.includes("instructor")) {
          const familyFirstName = [data.lastName, data.firstName].filter(Boolean).join(" ");
          const name = data.fullName || familyFirstName || data.name || data.displayName;
          if (name && typeof name === "string" && name.trim()) {
            const cleanName = name.trim();
            const exists = dbFacultyPool.some((f) => f.name.toLowerCase() === cleanName.toLowerCase());
            if (!exists) {
              dbFacultyPool.push({
                id: docSnap.id,
                name: cleanName,
                email: data.email || `${cleanName.toLowerCase().replace(/\s+/g, ".")}@pup.edu.ph`,
                department: data.department || "Faculty",
              });
            }
          }
        }
      });
    } catch (e) {}
  }

  // 9. Render Unauthorized Message
  function renderUnauthorized(heading, message) {
    root.hidden = false;
    root.innerHTML = `
      <div class="ce-unauthorized-wrap">
        <div class="ce-unauthorized-card">
          <div class="ce-unauthorized-icon">
            <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="#701219" stroke-width="2">
              <circle cx="12" cy="12" r="10"></circle>
              <line x1="4.93" y1="4.93" x2="19.07" y2="19.07"></line>
            </svg>
          </div>
          <h2 class="ce-unauthorized-title">${escapeHTML(heading)}</h2>
          <p class="ce-unauthorized-text">${escapeHTML(message)}</p>
          <div class="ce-unauthorized-actions">
            <a href="javascript:history.back()" class="ce-btn-primary">Return to Previous Page</a>
          </div>
        </div>
      </div>
    `;
  }

  // 10. Main Rendering Controller
  function render() {
    const isEditMode = Boolean(state.editingEventId);
    const manilaInfo = getManilaDateInfo();

    root.innerHTML = `
      <div class="ce-container">
        <!-- Top Section: Mode Switch Segmented Toggle -->
        ${!isEditMode ? `
          <header class="ce-header">
            <div class="ce-mode-toggle" role="radiogroup" aria-label="Event Creation Mode">
              <button type="button"
                      class="ce-mode-btn ${state.mode === "existing" ? "is-active" : ""}"
                      data-mode="existing"
                      role="radio"
                      aria-checked="${state.mode === "existing"}">
                Create Existing Event
              </button>
              <button type="button"
                      class="ce-mode-btn ${state.mode === "new" ? "is-active" : ""}"
                      data-mode="new"
                      role="radio"
                      aria-checked="${state.mode === "new"}">
                Create New Event
              </button>
            </div>
          </header>
        ` : ""}

        <!-- Main Body: Existing View OR Form with Side Panel -->
        ${state.mode === "existing" && !isEditMode
          ? renderExistingEventsView()
          : renderCreateFormView(manilaInfo)}
      </div>
    `;

    setupEventHandlers();
    updateDescCounter();
    updateRationaleCounter();
    checkVenueCapacityHint();
    updateAllReadinessChecks();
    updateLivePreview();
  }

  // 11. "Create Existing Event" View & Favorites/Recently Logic
  let reuseLoadingTimeout = null;
  function attachReuseLibraryListener(uid) {
    if (!rtdb || !isFirebaseConfigured) return;
    if (activeReuseListenerRef) {
      try { off(activeReuseListenerRef); } catch (e) {}
    }
    const hasLocalData = (reuseLibrary && Object.keys(reuseLibrary).length > 0) || loadCurrentUserEvents().length > 0;
    if (!hasLocalData) {
      state.reuseLoading = true;
    }
    if (reuseLoadingTimeout) {
      clearTimeout(reuseLoadingTimeout);
      reuseLoadingTimeout = null;
    }
    reuseLoadingTimeout = setTimeout(() => {
      if (state.reuseLoading) {
        state.reuseLoading = false;
        if (state.mode === "existing") {
          refreshExistingEventsLists();
        }
      }
    }, 1500);

    activeReuseListenerRef = ref(rtdb, `reuseLibrary/${uid}`);
    onValue(
      activeReuseListenerRef,
      (snapshot) => {
        if (reuseLoadingTimeout) {
          clearTimeout(reuseLoadingTimeout);
          reuseLoadingTimeout = null;
        }
        state.reuseLoading = false;
        state.reuseError = null;
        const val = snapshot.val();
        if (val && typeof val === "object" && Object.keys(val).length > 0) {
          reuseLibrary = { ...reuseLibrary, ...val };
          saveStoredReuseLibrary(reuseLibrary);
        } else {
          const localVal = getStoredReuseLibrary();
          if (localVal && Object.keys(localVal).length > 0) {
            reuseLibrary = { ...localVal, ...reuseLibrary };
          }
        }
        if (state.mode === "existing") {
          refreshExistingEventsLists();
        }
      },
      (err) => {
        if (reuseLoadingTimeout) {
          clearTimeout(reuseLoadingTimeout);
          reuseLoadingTimeout = null;
        }
        console.warn("Could not load reuseLibrary from RTDB:", err);
        state.reuseLoading = false;
        reuseLibrary = getStoredReuseLibrary();
        if (state.mode === "existing") {
          refreshExistingEventsLists();
        }
      }
    );
  }

  // Keep in sync with the other role's page.
  authReady.then(() => onAuthStateChanged(auth, async (user) => {
    if (!user) {
      // If neither Firebase Auth nor local organizer session exists, redirect to login
      if (!organizerId && !organizerProfile?.email) {
        location.replace(isOrganizerPage ? "EventOrganizerLogin.html" : "../UserTeacher/TeacherLogin.html");
      }
      return;
    }

    if (rtdb) {
      try {
        const roleSnapshot = await get(ref(rtdb, `roles/${user.uid}`));
        const userRole = roleSnapshot.val();
        // Disallow students and non-creator roles
        if (userRole === "student") {
          renderUnauthorized("Access Restricted", "This page is available only to Event Organizers and Teachers. Students cannot create events.");
          return;
        }
      } catch (error) {
        console.warn("Could not verify event creator role from RTDB:", error);
      }
    }

    root.hidden = false;
    currentAuthUid = user.uid;
    const userStored = readJSON(`recovibeReuseLibrary_${user.uid}`, null);
    if (userStored && typeof userStored === "object") {
      reuseLibrary = { ...reuseLibrary, ...userStored };
      saveStoredReuseLibrary(reuseLibrary);
    }
    if (rtdb) {
      attachReuseLibraryListener(user.uid);
      await loadDraftForEditing(user.uid);
    }
  })).catch((error) => {
    console.error("Could not restore creator authentication state:", error);
    renderUnauthorized("Session Unavailable", "Please refresh the page and try again.");
  });

  function getEventTimestamp(ev) {
    if (!ev) return 0;
    const raw = ev.date || ev.dateISO || ev.eventDate || ev.startAt || "";
    if (!raw) return 0;
    const d = new Date(raw);
    return isNaN(d.getTime()) ? 0 : d.getTime();
  }

  function formatLastHeldDate(dateVal) {
    if (!dateVal) return "Date TBA";
    const str = String(dateVal);
    const d = new Date(str.includes("T") ? str : `${str.substring(0, 10)}T00:00:00`);
    if (isNaN(d.getTime())) return str;
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  let statusDismissTimer = null;
  function announceStatus(message, isError = false) {
    const el = document.getElementById("reuseStatusLine");
    if (el) {
      if (statusDismissTimer) {
        clearTimeout(statusDismissTimer);
        statusDismissTimer = null;
      }
      el.textContent = message;
      el.classList.toggle("is-error", isError);
      el.hidden = false;
      if (!isError) {
        statusDismissTimer = setTimeout(() => {
          if (el.textContent === message && !el.classList.contains("is-error")) {
            el.hidden = true;
          }
        }, 5000);
      }
    }
  }

  function getCategorizedPastEvents() {
    const past = loadCurrentUserEvents();
    const query = (state.searchQuery || "").trim().toLowerCase();

    const favoriteEvents = [];
    const recentEvents = [];

    past.forEach((ev) => {
      if (!ev) return;
      const id = String(ev.id || ev.eventId);
      const mark = reuseLibrary[id] || {};
      const isFav = mark.favorite === true;
      const isHidden = mark.hidden === true;

      if (isFav) {
        favoriteEvents.push(ev);
      } else if (!isHidden || undoTimeouts.has(id)) {
        recentEvents.push(ev);
      }
    });

    favoriteEvents.sort((a, b) => getEventTimestamp(b) - getEventTimestamp(a));
    recentEvents.sort((a, b) => getEventTimestamp(b) - getEventTimestamp(a));

    const filterFn = (ev) => {
      if (!query) return true;
      const title = (ev.title || ev.eventName || "").toLowerCase();
      const venue = (ev.venue || ev.location || "").toLowerCase();
      const cat = (ev.category || (Array.isArray(ev.categories) ? ev.categories.join(" ") : "")).toLowerCase();
      return title.includes(query) || venue.includes(query) || cat.includes(query);
    };

    return {
      allFavorites: favoriteEvents,
      allRecent: recentEvents,
      filteredFavorites: favoriteEvents.filter(filterFn),
      filteredRecent: recentEvents.filter(filterFn),
      query,
    };
  }

  function renderExistingColumnsHtml() {
    const { filteredFavorites, filteredRecent, query } = getCategorizedPastEvents();

    return `
      <div class="ce-existing-columns">
        <div class="ce-existing-col" data-col="favorites">
          <h3 class="ce-existing-col-title">Favorite Events (${filteredFavorites.length} of ${FAVORITES_LIMIT})</h3>
          <div class="ce-existing-col-list">
            ${filteredFavorites.length === 0
              ? `<div class="ce-existing-empty"><p>${query ? `No favorites match “${escapeHTML(query)}”.` : "No favorites yet. Add an event from Recently Events to keep it here."}</p></div>`
              : filteredFavorites.map((ev) => renderPastEventCard(ev, "favorite")).join("")}
          </div>
        </div>

        <div class="ce-existing-col" data-col="recent">
          <h3 class="ce-existing-col-title">Recently Events (${filteredRecent.length})</h3>
          <div class="ce-existing-col-list">
            ${filteredRecent.length === 0
              ? `<div class="ce-existing-empty"><p>${query ? `No recent events match “${escapeHTML(query)}”.` : "No recent events."}</p></div>`
              : filteredRecent.map((ev) => renderPastEventCard(ev, "recent")).join("")}
          </div>
        </div>
      </div>
    `;
  }

  function renderExistingEventsView() {
    return `
      <div class="ce-existing-view">
        <div class="ce-search-wrap">
          <input type="search"
                 id="searchPastEvents"
                 class="ce-search-input"
                 placeholder="Search past events by title, venue, or category..."
                 value="${escapeHTML(state.searchQuery || "")}"
                 aria-label="Search past events">
        </div>

        <div class="ce-status-line" id="reuseStatusLine" aria-live="polite" role="status" hidden></div>

        ${state.reuseLoading && Object.keys(reuseLibrary).length === 0 && loadCurrentUserEvents().length === 0
          ? `
            <div class="ce-existing-columns">
              <div class="ce-existing-col">
                <h3 class="ce-existing-col-title">Favorite Events (...)</h3>
                <div class="ce-existing-col-list">
                  <div class="ce-skeleton-card"></div>
                  <div class="ce-skeleton-card"></div>
                </div>
              </div>
              <div class="ce-existing-col">
                <h3 class="ce-existing-col-title">Recently Events (...)</h3>
                <div class="ce-existing-col-list">
                  <div class="ce-skeleton-card"></div>
                  <div class="ce-skeleton-card"></div>
                </div>
              </div>
            </div>
          `
          : state.reuseError && loadCurrentUserEvents().length === 0
          ? `
            <div class="ce-existing-error" role="alert">
              <p>Couldn't load events</p>
              <button type="button" class="ce-btn-secondary" id="btnRetryLoadEvents">Try again</button>
            </div>
          `
          : renderExistingColumnsHtml()}
      </div>
    `;
  }

  function renderPastEventCard(ev, listType) {
    const id = String(ev.id || ev.eventId || "ev-" + Math.random());
    const title = ev.title || ev.eventName || "Untitled Event";
    const date = formatLastHeldDate(ev.date || ev.dateISO || ev.eventDate);
    const venue = ev.venue || ev.location || "AVR1 | PUP Biñan";

    const isUndo = undoTimeouts.has(id);
    const isConfirmOpen = state.activeConfirm && state.activeConfirm.eventId === id;

    return `
      <div class="ce-existing-card" data-event-id="${escapeHTML(id)}" data-list-type="${escapeHTML(listType)}">
        <div class="ce-existing-card-body">
          <h4 class="ce-existing-title">${escapeHTML(title)}</h4>
          <div class="ce-existing-meta">
            <span>Last held ${escapeHTML(date)} · ${escapeHTML(venue)}</span>
          </div>
        </div>
        ${isUndo
          ? `
            <div class="ce-card-undo" role="status">
              <span>Removed “${escapeHTML(title)}” from Recently Events.</span>
              <button type="button" class="ce-undo-btn" data-undo-id="${escapeHTML(id)}" aria-label="Undo removing ${escapeHTML(title)}">Undo</button>
            </div>
          `
          : isConfirmOpen
          ? `
            <div class="ce-card-confirm ${state.activeConfirm.isDanger ? "is-danger" : ""}" role="alertdialog" aria-labelledby="confirm-msg-${escapeHTML(id)}">
              <p class="ce-confirm-msg" id="confirm-msg-${escapeHTML(id)}">${state.activeConfirm.message}</p>
              <div class="ce-card-confirm-actions">
                ${state.activeConfirm.buttonsHtml}
              </div>
            </div>
          `
          : listType === "favorite"
          ? `
            <div class="ce-existing-actions">
              <button type="button" class="ce-reuse-btn" data-action="reuse" data-event-id="${escapeHTML(id)}" aria-label="Reuse ${escapeHTML(title)}" ${state.isActionBusy ? "disabled" : ""}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/>
                </svg>
                Reuse
              </button>
              <button type="button" class="ce-btn-unfavorite" data-action="unfavorite" data-event-id="${escapeHTML(id)}" aria-label="Remove ${escapeHTML(title)} from favorites" ${state.isActionBusy ? "disabled" : ""}>
                Remove from favorites
              </button>
            </div>
          `
          : `
            <div class="ce-existing-actions">
              <button type="button" class="ce-reuse-btn" data-action="reuse" data-event-id="${escapeHTML(id)}" aria-label="Reuse ${escapeHTML(title)}" ${state.isActionBusy ? "disabled" : ""}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/>
                </svg>
                Reuse
              </button>
              <button type="button" class="ce-btn-favorite" data-action="favorite" data-event-id="${escapeHTML(id)}" aria-label="Add ${escapeHTML(title)} to favorites" ${state.isActionBusy ? "disabled" : ""}>
                Add to favorites
              </button>
              <button type="button" class="ce-btn-remove" data-action="remove" data-event-id="${escapeHTML(id)}" aria-label="Remove ${escapeHTML(title)}" ${state.isActionBusy ? "disabled" : ""}>
                Remove
              </button>
            </div>
          `
        }
      </div>
    `;
  }

  function closeActiveConfirmation() {
    if (activeConfirmationTriggerBtn) {
      try { activeConfirmationTriggerBtn.focus(); } catch (e) {}
      activeConfirmationTriggerBtn = null;
    }
    state.activeConfirm = null;
    refreshExistingEventsLists();
  }

  function focusFirstConfirmationButton(eventId) {
    setTimeout(() => {
      const card = root.querySelector(`.ce-existing-card[data-event-id="${eventId}"]`);
      if (card) {
        const firstBtn = card.querySelector(".ce-card-confirm-actions button, .ce-confirm-actions button");
        if (firstBtn) firstBtn.focus();
      }
    }, 10);
  }

  function handleCardActionClick(action, eventId, triggerBtn) {
    const past = loadCurrentUserEvents();
    const eventObj = past.find((x) => String(x.id || x.eventId) === String(eventId));
    if (!eventObj) return;

    // Clear previous error message if any
    const statusLine = document.getElementById("reuseStatusLine");
    if (statusLine && statusLine.classList.contains("is-error")) {
      statusLine.hidden = true;
      statusLine.textContent = "";
      statusLine.classList.remove("is-error");
    }

    activeConfirmationTriggerBtn = triggerBtn;
    const title = eventObj.title || eventObj.eventName || "this event";
    const date = formatLastHeldDate(eventObj.date || eventObj.dateISO || eventObj.eventDate);

    if (action === "reuse") {
      state.activeConfirm = {
        eventId,
        type: "reuse",
        message: `Reuse this event? Create another event like “${escapeHTML(title)}”. Its details are copied over, and you check the ones that usually change.`,
        buttonsHtml: `
          <button type="button" class="ce-btn-primary" data-confirm-action="do-reuse" data-event-id="${escapeHTML(eventId)}">Reuse event</button>
          <button type="button" class="ce-btn-secondary" data-confirm-action="cancel">Cancel</button>
        `,
        isDanger: false,
      };
      refreshExistingEventsLists();
      focusFirstConfirmationButton(eventId);
    } else if (action === "unfavorite") {
      state.activeConfirm = {
        eventId,
        type: "unfavorite",
        message: `Remove from Favorite Events? “${escapeHTML(title)}” moves back to Recently Events.`,
        buttonsHtml: `
          <button type="button" class="ce-btn-primary" data-confirm-action="do-unfavorite" data-event-id="${escapeHTML(eventId)}">Remove from favorites</button>
          <button type="button" class="ce-btn-secondary" data-confirm-action="cancel">Cancel</button>
        `,
        isDanger: false,
      };
      refreshExistingEventsLists();
      focusFirstConfirmationButton(eventId);
    } else if (action === "favorite") {
      // 1. Favorites limit validation (at most 5)
      const currentFavCount = Object.values(reuseLibrary).filter((m) => m && m.favorite === true).length;
      if (currentFavCount >= FAVORITES_LIMIT) {
        state.activeConfirm = {
          eventId,
          type: "limit-full",
          message: "Favorites are full. You can have up to 5 favorites. Remove one from Favorite Events first.",
          buttonsHtml: `
            <button type="button" class="ce-btn-primary" data-confirm-action="cancel">Got it</button>
          `,
          isDanger: false,
        };
        refreshExistingEventsLists();
        focusFirstConfirmationButton(eventId);
        return;
      }

      // 2. Duplicate favorite validation
      const targetLower = title.trim().toLowerCase();
      const duplicateFav = past.find((p) => {
        if (!p) return false;
        const pId = String(p.id || p.eventId);
        if (pId === eventId) return false;
        const isFav = reuseLibrary[pId]?.favorite === true;
        const pTitle = (p.title || p.eventName || "").trim().toLowerCase();
        return isFav && pTitle === targetLower;
      });

      if (duplicateFav) {
        const dupTitle = duplicateFav.title || duplicateFav.eventName || "existing favorite";
        const dupDate = formatLastHeldDate(duplicateFav.date || duplicateFav.dateISO || duplicateFav.eventDate);
        state.activeConfirm = {
          eventId,
          type: "duplicate",
          message: `A favorite named “${escapeHTML(dupTitle)}” already exists (last held ${escapeHTML(dupDate)}). Replace it with this one (last held ${escapeHTML(date)}), or keep both?`,
          buttonsHtml: `
            <button type="button" class="ce-btn-primary" data-confirm-action="do-replace" data-event-id="${escapeHTML(eventId)}" data-replace-id="${escapeHTML(duplicateFav.id || duplicateFav.eventId)}">Replace it</button>
            <button type="button" class="ce-btn-secondary" data-confirm-action="do-keepboth" data-event-id="${escapeHTML(eventId)}">Keep both</button>
            <button type="button" class="ce-btn-secondary" data-confirm-action="cancel">Cancel</button>
          `,
          isDanger: false,
        };
        refreshExistingEventsLists();
        focusFirstConfirmationButton(eventId);
        return;
      }

      // Standard favorite confirmation
      state.activeConfirm = {
        eventId,
        type: "favorite",
        message: `Add to Favorite Events? “${escapeHTML(title)}” moves from Recently Events to Favorite Events.`,
        buttonsHtml: `
          <button type="button" class="ce-btn-primary" data-confirm-action="do-favorite" data-event-id="${escapeHTML(eventId)}">Add to favorites</button>
          <button type="button" class="ce-btn-secondary" data-confirm-action="cancel">Cancel</button>
        `,
        isDanger: false,
      };
      refreshExistingEventsLists();
      focusFirstConfirmationButton(eventId);
    } else if (action === "remove") {
      state.activeConfirm = {
        eventId,
        type: "remove",
        message: "Remove from Recently Events? This only takes it off this list. The event and its records are not deleted. You can undo for a few seconds.",
        buttonsHtml: `
          <button type="button" class="ce-btn-danger" data-confirm-action="do-remove" data-event-id="${escapeHTML(eventId)}">Remove</button>
          <button type="button" class="ce-btn-secondary" data-confirm-action="cancel">Cancel</button>
        `,
        isDanger: true,
      };
      refreshExistingEventsLists();
      focusFirstConfirmationButton(eventId);
    }
  }

  async function executeSetFavorite({ eventId, favorite, replaceEventId, allowDuplicate, title }) {
    if (isFirebaseConfigured && functions) {
      try {
        const setFavFn = httpsCallable(functions, "setFavorite");
        const callPromise = setFavFn({ eventId, favorite, replaceEventId, allowDuplicate, title });
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Cloud Function timeout")), 2000)
        );
        const res = await Promise.race([callPromise, timeoutPromise]);
        return res?.data;
      } catch (err) {
        // If the Cloud Function returned a domain validation error (e.g. limit or duplicate), rethrow it
        const errMsg = err.details?.message || err.message || "";
        if (
          errMsg.includes("Favorites are full") ||
          errMsg.includes("already exists") ||
          err.code === "functions/failed-precondition" ||
          err.code === "functions/already-exists"
        ) {
          throw new Error(errMsg);
        }
        console.warn("Cloud Function setFavorite notice (offline/local fallback):", err);
      }
    }

    // Direct RTDB update if configured
    if (isFirebaseConfigured && rtdb) {
      const uid = getEffectiveUid();
      try {
        const itemRef = ref(rtdb, `reuseLibrary/${uid}/${eventId}`);
        const updatePromise = update(itemRef, { favorite: Boolean(favorite), updatedAt: Date.now() });
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error("RTDB timeout")), 1500)
        );
        await Promise.race([updatePromise, timeoutPromise]);
        if (replaceEventId) {
          const repRef = ref(rtdb, `reuseLibrary/${uid}/${replaceEventId}`);
          await Promise.race([
            update(repRef, { favorite: false, updatedAt: Date.now() }),
            new Promise((_, reject) => setTimeout(() => reject(new Error("RTDB timeout")), 1500))
          ]);
        }
      } catch (rtdbErr) {
        console.warn("RTDB update notice (using local storage fallback):", rtdbErr.message || rtdbErr);
      }
    }

    return { success: true };
  }

  async function executeSetHidden({ eventId, hidden }) {
    if (isFirebaseConfigured && rtdb) {
      const uid = getEffectiveUid();
      try {
        const itemRef = ref(rtdb, `reuseLibrary/${uid}/${eventId}`);
        const updatePromise = update(itemRef, { hidden: Boolean(hidden), updatedAt: Date.now() });
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error("RTDB timeout")), 1500)
        );
        await Promise.race([updatePromise, timeoutPromise]);
        return { success: true };
      } catch (err) {
        console.warn("Could not update hidden in RTDB:", err.message || err);
      }
    }
    return { success: true };
  }

  async function handleConfirmActionClick(btn) {
    const confirmAction = btn.dataset.confirmAction;
    const eventId = btn.dataset.eventId;

    if (confirmAction === "cancel") {
      closeActiveConfirmation();
      return;
    }

    const past = loadCurrentUserEvents();
    const eventObj = past.find((x) => String(x.id || x.eventId) === String(eventId));
    const title = eventObj ? (eventObj.title || eventObj.eventName || "Event") : "Event";

    if (confirmAction === "do-reuse") {
      closeActiveConfirmation();
      if (eventObj) {
        prefillFormFromEvent(eventObj);
      }
      return;
    }

    try {
      if (confirmAction === "do-unfavorite") {
        reuseLibrary[eventId] = {
          ...(reuseLibrary[eventId] || {}),
          favorite: false,
          updatedAt: Date.now(),
        };
        saveStoredReuseLibrary(reuseLibrary);
        closeActiveConfirmation();
        announceStatus(`“${title}” moved back to Recently Events.`);

        (async () => {
          try {
            await executeSetFavorite({ eventId, favorite: false, title });
          } catch (err) {
            reuseLibrary[eventId] = {
              ...(reuseLibrary[eventId] || {}),
              favorite: true,
              updatedAt: Date.now(),
            };
            saveStoredReuseLibrary(reuseLibrary);
            refreshExistingEventsLists();
            announceStatus(err.message || "Failed to update favorites.", true);
          }
        })();
      } else if (confirmAction === "do-favorite") {
        reuseLibrary[eventId] = {
          ...(reuseLibrary[eventId] || {}),
          favorite: true,
          hidden: reuseLibrary[eventId]?.hidden || false,
          updatedAt: Date.now(),
        };
        saveStoredReuseLibrary(reuseLibrary);
        closeActiveConfirmation();
        announceStatus(`Added “${title}” to Favorite Events.`);

        (async () => {
          try {
            await executeSetFavorite({ eventId, favorite: true, title });
          } catch (err) {
            if (reuseLibrary[eventId]) {
              reuseLibrary[eventId].favorite = false;
              reuseLibrary[eventId].updatedAt = Date.now();
            }
            saveStoredReuseLibrary(reuseLibrary);
            refreshExistingEventsLists();
            announceStatus(err.message || "Failed to add to favorites.", true);
          }
        })();
      } else if (confirmAction === "do-replace") {
        const replaceId = btn.dataset.replaceId;
        reuseLibrary[eventId] = {
          ...(reuseLibrary[eventId] || {}),
          favorite: true,
          hidden: reuseLibrary[eventId]?.hidden || false,
          updatedAt: Date.now(),
        };
        if (replaceId && reuseLibrary[replaceId]) {
          reuseLibrary[replaceId].favorite = false;
          reuseLibrary[replaceId].updatedAt = Date.now();
        }
        saveStoredReuseLibrary(reuseLibrary);
        closeActiveConfirmation();
        announceStatus(`Added “${title}” to Favorite Events.`);

        (async () => {
          try {
            await executeSetFavorite({ eventId, favorite: true, replaceEventId: replaceId, title });
          } catch (err) {
            if (reuseLibrary[eventId]) {
              reuseLibrary[eventId].favorite = false;
            }
            if (replaceId && reuseLibrary[replaceId]) {
              reuseLibrary[replaceId].favorite = true;
            }
            saveStoredReuseLibrary(reuseLibrary);
            refreshExistingEventsLists();
            announceStatus(err.message || "Failed to replace favorite.", true);
          }
        })();
      } else if (confirmAction === "do-keepboth") {
        reuseLibrary[eventId] = {
          ...(reuseLibrary[eventId] || {}),
          favorite: true,
          hidden: reuseLibrary[eventId]?.hidden || false,
          updatedAt: Date.now(),
        };
        saveStoredReuseLibrary(reuseLibrary);
        closeActiveConfirmation();
        announceStatus(`Added “${title}” to Favorite Events.`);

        (async () => {
          try {
            await executeSetFavorite({ eventId, favorite: true, allowDuplicate: true, title });
          } catch (err) {
            if (reuseLibrary[eventId]) {
              reuseLibrary[eventId].favorite = false;
            }
            saveStoredReuseLibrary(reuseLibrary);
            refreshExistingEventsLists();
            announceStatus(err.message || "Failed to add favorite.", true);
          }
        })();
      } else if (confirmAction === "do-remove") {
        reuseLibrary[eventId] = {
          ...(reuseLibrary[eventId] || {}),
          hidden: true,
          updatedAt: Date.now(),
        };
        saveStoredReuseLibrary(reuseLibrary);
        state.activeConfirm = null;

        if (undoTimeouts.has(eventId)) {
          clearTimeout(undoTimeouts.get(eventId));
        }
        const timerHandle = setTimeout(() => {
          undoTimeouts.delete(eventId);
          refreshExistingEventsLists();
        }, 8000);
        undoTimeouts.set(eventId, timerHandle);

        refreshExistingEventsLists();
        announceStatus(`Removed “${title}” from Recently Events.`);

        (async () => {
          try {
            await executeSetHidden({ eventId, hidden: true });
          } catch (err) {
            console.warn("Could not update hidden in RTDB:", err);
          }
        })();
      }
    } catch (err) {
      console.error("Action error:", err);
      announceStatus(err.message || "Action failed. Please try again.", true);
    }
  }

  function handleUndoClick(eventId) {
    if (undoTimeouts.has(eventId)) {
      clearTimeout(undoTimeouts.get(eventId));
      undoTimeouts.delete(eventId);
    }
    const past = loadCurrentUserEvents();
    const eventObj = past.find((x) => String(x.id || x.eventId) === String(eventId));
    const title = eventObj ? (eventObj.title || eventObj.eventName || "Event") : "Event";

    reuseLibrary[eventId] = { ...(reuseLibrary[eventId] || {}), hidden: false, updatedAt: Date.now() };
    saveStoredReuseLibrary(reuseLibrary);
    refreshExistingEventsLists();
    announceStatus(`Restored “${title}” to Recently Events.`);

    (async () => {
      try {
        await executeSetHidden({ eventId, hidden: false });
      } catch (err) {
        console.warn("Could not sync undo hidden to RTDB:", err);
      }
    })();
  }

  function updateConfirmationButtonsBusy(isBusy) {
    const confirmEl = root.querySelector(".ce-card-confirm");
    if (confirmEl) {
      confirmEl.querySelectorAll("button").forEach((b) => {
        b.disabled = isBusy;
      });
    }
  }

  function refreshExistingEventsLists() {
    const container = root.querySelector(".ce-existing-view");
    if (!container) return;

    const colsContainer = container.querySelector(".ce-existing-columns") || container.querySelector(".ce-existing-error");
    if (colsContainer) {
      colsContainer.outerHTML = renderExistingColumnsHtml();
      attachExistingViewCardListeners();
    }
  }

  function attachExistingViewCardListeners() {
    const container = root.querySelector(".ce-existing-view");
    if (!container) return;

    container.querySelectorAll("[data-action]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        handleCardActionClick(btn.dataset.action, btn.dataset.eventId, btn);
      });
    });

    container.querySelectorAll("[data-confirm-action]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        handleConfirmActionClick(btn);
      });
    });

    container.querySelectorAll("[data-undo-id]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        handleUndoClick(btn.dataset.undoId);
      });
    });

    const retryBtn = document.getElementById("btnRetryLoadEvents");
    if (retryBtn) {
      retryBtn.addEventListener("click", () => {
        attachReuseLibraryListener(currentAuthUid);
      });
    }
  }

  function attachExistingViewListeners() {
    const container = root.querySelector(".ce-existing-view");
    if (!container) return;

    const searchInput = document.getElementById("searchPastEvents");
    if (searchInput) {
      searchInput.addEventListener("input", () => {
        state.searchQuery = searchInput.value || "";
        refreshExistingEventsLists();
      });
    }

    attachExistingViewCardListeners();
  }

  async function handlePostSaveFavorite(eventObj) {
    if (!eventObj) return;
    const eventId = String(eventObj.id || eventObj.eventId);
    const title = eventObj.title || eventObj.eventName || "Event";

    const currentFavCount = Object.values(reuseLibrary).filter((m) => m && m.favorite === true).length;
    if (currentFavCount >= FAVORITES_LIMIT) {
      showToast("Favorites are full. You can have up to 5 favorites. Remove one from Favorite Events first.");
      return;
    }

    const past = loadCurrentUserEvents();
    const targetLower = title.trim().toLowerCase();
    const duplicateFav = past.find((p) => {
      if (!p) return false;
      const pId = String(p.id || p.eventId);
      if (pId === eventId) return false;
      const isFav = reuseLibrary[pId]?.favorite === true;
      const pTitle = (p.title || p.eventName || "").trim().toLowerCase();
      return isFav && pTitle === targetLower;
    });

    try {
      if (duplicateFav) {
        const dupTitle = duplicateFav.title || duplicateFav.eventName || "existing favorite";
        const dupDate = formatLastHeldDate(duplicateFav.date || duplicateFav.dateISO || duplicateFav.eventDate);
        return new Promise((resolve) => {
          showConfirmModal({
            title: "Duplicate Favorite Name",
            text: `A favorite named “${dupTitle}” already exists (last held ${dupDate}). Replace it with this one, or keep both?`,
            confirmText: "Replace it",
            cancelText: "Keep both",
            onConfirm: async () => {
              try {
                const repId = duplicateFav.id || duplicateFav.eventId;
                reuseLibrary[eventId] = { ...(reuseLibrary[eventId] || {}), favorite: true, hidden: false, updatedAt: Date.now() };
                if (reuseLibrary[repId]) {
                  reuseLibrary[repId].favorite = false;
                  reuseLibrary[repId].updatedAt = Date.now();
                }
                saveStoredReuseLibrary(reuseLibrary);
                showToast(`Added “${title}” to Favorite Events.`);
                await executeSetFavorite({ eventId, favorite: true, replaceEventId: repId, title });
              } catch (e) {
                showToast(e.message || "Failed to favorite event.");
              }
              resolve();
            },
            onCancel: async () => {
              try {
                reuseLibrary[eventId] = { ...(reuseLibrary[eventId] || {}), favorite: true, hidden: false, updatedAt: Date.now() };
                saveStoredReuseLibrary(reuseLibrary);
                showToast(`Added “${title}” to Favorite Events.`);
                await executeSetFavorite({ eventId, favorite: true, allowDuplicate: true, title });
              } catch (e) {
                showToast(e.message || "Failed to favorite event.");
              }
              resolve();
            },
          });
        });
      } else {
        reuseLibrary[eventId] = { ...(reuseLibrary[eventId] || {}), favorite: true, hidden: false, updatedAt: Date.now() };
        saveStoredReuseLibrary(reuseLibrary);
        showToast(`Added “${title}” to Favorite Events.`);
        await executeSetFavorite({ eventId, favorite: true, title });
      }
    } catch (err) {
      console.error("handlePostSaveFavorite error:", err);
      showToast(err.message || "Could not add to favorites.");
    }
  }

  function calculateNextLogicalDate(oldDateStr) {
    if (!oldDateStr) return getManilaDateInfo().todayStr;
    const parts = oldDateStr.split("-");
    if (parts.length !== 3) return getManilaDateInfo().todayStr;

    const month = parseInt(parts[1], 10);
    const day = parseInt(parts[2], 10);

    const now = new Date();
    const currentYear = now.getFullYear();

    let candidate = new Date(currentYear, month - 1, day);
    if (candidate <= now) {
      candidate = new Date(currentYear + 1, month - 1, day);
    }

    const y = candidate.getFullYear();
    const m = String(candidate.getMonth() + 1).padStart(2, "0");
    const d = String(candidate.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

  // 12. Create / Edit Form View (Left Form, Right Sticky Side Panel)
  function renderCreateFormView(manilaInfo) {
    const isEditMode = Boolean(state.editingEventId);
    const defaultEventDate = getDefaultEventDate(manilaInfo.todayStr);
    const initialRegStart = getManilaDateTimeString(Date.now() + 15 * 60 * 1000);
    const initialRegEnd = calculateAutoRegistrationEnd(defaultEventDate);
    const initialMaxRegEnd = calculateMaxRegistrationEnd(defaultEventDate);
    const organizingDepartment = getOrganizingDepartment();
    const savedTargetDepartments = state.targetDepartments
      .map(normalizeTargetDepartment)
      .filter(Boolean);
    const defaultTargetDepartments = savedTargetDepartments.length
      ? savedTargetDepartments
      : organizingDepartment
        ? [organizingDepartment]
        : [];

    return `
      ${state.isCopied && state.copiedFrom ? `
        <div class="ce-copied-banner" role="alert">
          <div class="ce-copied-banner-content">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10"></circle>
              <line x1="12" y1="8" x2="12" y2="12"></line>
              <line x1="12" y1="16" x2="12.01" y2="16"></line>
            </svg>
            <span>
              Copied from <strong>${escapeHTML(state.copiedFrom.title || "Past Event")}</strong>
              (last held ${escapeHTML(state.copiedFrom.date || "earlier")}). Review the highlighted date and time, and attach new approval documents.
            </span>
          </div>
          <button type="button" class="ce-banner-dismiss" id="btnDismissBanner" aria-label="Dismiss notice">✕</button>
        </div>
      ` : ""}

      <div class="ce-layout-grid ce-main-layout">
        <!-- Left Column: Form Cards -->
        <div class="ce-form-column ce-form-col">
          <form id="createEventMainForm" novalidate autocomplete="off">
            <!-- Card 1: Event Identity -->
            <section class="ce-card" id="card-identity">
              <div class="ce-card-header">
                <h2 class="ce-card-title">1. Event Identity</h2>
              </div>
              <div class="ce-fields-grid">
                <div class="ce-field ce-field--full ${state.highlightedFields.has("eventName") ? "is-copied-highlight" : ""}" id="wrap-eventName">
                  <label for="eventName">Event Name <span class="ce-req">*</span></label>
                  <input type="text"
                         id="eventName"
                         name="eventName"
                         minlength="5"
                         maxlength="150"
                         placeholder="e.g. Annual IT Tech Summit 2026"
                         required
                         aria-describedby="duplicateNotice error-eventName">
                  <p id="duplicateNotice" class="ce-warning-note" role="status" aria-live="polite" hidden></p>
                  <p class="ce-error" id="error-eventName" hidden></p>
                </div>

                <div class="ce-field" id="wrap-eventOrganizer">
                  <label for="eventOrganizer">Event Organizer <span class="ce-readonly-tag">(Auto-filled)</span></label>
                  <input type="text"
                         id="eventOrganizer"
                         name="eventOrganizer"
                         value="${escapeHTML(readOnlyOrganizerValue)}"
                         readonly
                         class="ce-input--readonly">
                </div>

                <div class="ce-field" id="wrap-eventSource">
                  <label for="eventSource">Event Source <span class="ce-readonly-tag">(Auto-linked)</span></label>
                  <input type="text"
                         id="eventSource"
                         name="eventSource"
                         value="${escapeHTML(defaultEventSource)}"
                         readonly
                         aria-readonly="true"
                         class="ce-input--readonly ce-input--auto-linked">
                </div>

                <!-- Category Multi-Select Dropdown with Checkboxes (1 to 3 allowed) -->
                <div class="ce-field ce-field--full ${state.highlightedFields.has("category") ? "is-copied-highlight" : ""}" id="wrap-category">
                  <label id="catLabel">Categories <span class="ce-req">*</span> <small>(Select 1 to 3)</small></label>
                  <div class="ce-cat-dropdown" id="catDropdownContainer">
                    <button type="button"
                            class="ce-cat-button"
                            id="catDropdownBtn"
                            aria-haspopup="listbox"
                            aria-expanded="false"
                            aria-labelledby="catLabel catDropdownBtn">
                      <span id="catBtnText">Select 1 to 3 categories...</span>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                        <polyline points="6 9 12 15 18 9"></polyline>
                      </svg>
                    </button>
                    <div class="ce-cat-menu" id="catDropdownMenu" role="listbox" aria-multiselectable="true">
                      ${CATEGORIES.map((cat, idx) => `
                        <label class="ce-cat-item">
                          <input type="checkbox"
                                 class="ce-cat-checkbox"
                                 value="${escapeHTML(cat)}"
                                 ${state.selectedCategories.includes(cat) ? "checked" : ""}>
                          <span>${escapeHTML(cat)}</span>
                        </label>
                      `).join("")}
                    </div>
                  </div>
                  <p class="ce-error" id="error-category" hidden></p>
                </div>

                <input type="hidden" id="targetYear" name="targetYear" value="All Levels">
              </div>
            </section>

            <!-- Card 2: Schedule & Venue -->
            <section class="ce-card" id="card-schedule">
              <div class="ce-card-header">
                <h2 class="ce-card-title">2. Schedule & Venue</h2>
              </div>
              <div class="ce-fields-grid">
                <!-- Date Start with Manila Min/Max -->
                <div class="ce-field ${state.highlightedFields.has("eventDate") ? "is-copied-highlight" : ""}" id="wrap-eventDate">
                  <label for="eventDate">Date Start <span class="ce-req">*</span></label>
                  <input type="date"
                         id="eventDate"
                         name="eventDate"
                         value="${escapeHTML(defaultEventDate)}"
                         min="${escapeHTML(manilaInfo.todayStr)}"
                         max="${escapeHTML(manilaInfo.maxDateStr)}"
                         required
                         aria-describedby="holidayNotice error-eventDate">
                  <p id="holidayNotice" class="ce-holiday-notice" role="status" aria-live="polite" hidden></p>
                  <p class="ce-error" id="error-eventDate" hidden></p>
                </div>

                <!-- Date End with Min locked to Date Start -->
                <div class="ce-field ${state.highlightedFields.has("eventDateEnd") ? "is-copied-highlight" : ""}" id="wrap-eventDateEnd">
                  <label for="eventDateEnd">Date End <span class="ce-req">*</span></label>
                  <input type="date"
                         id="eventDateEnd"
                         name="eventDateEnd"
                         value="${escapeHTML(defaultEventDate)}"
                         min="${escapeHTML(defaultEventDate || manilaInfo.todayStr)}"
                         max="${escapeHTML(manilaInfo.maxDateStr)}"
                         required
                         aria-describedby="error-eventDateEnd">
                  <p class="ce-error" id="error-eventDateEnd" hidden></p>
                </div>

                <!-- Daily Schedule Dropdown -->
                <div class="ce-field" id="wrap-dailySchedule">
                  <label for="dailySchedule">Daily schedule <span class="ce-req">*</span></label>
                  <select id="dailySchedule" name="dailySchedule" required aria-describedby="error-dailySchedule">
                    <option value="Same time each day">Same time each day</option>
                    <option value="Different time by day">Different time by day</option>
                  </select>
                  <p class="ce-error" id="error-dailySchedule" hidden></p>
                </div>

                <!-- Time Start: Default 8:00 AM, min 8:00 AM (for Same time each day) -->
                <div class="ce-field ${state.highlightedFields.has("timeStart") ? "is-copied-highlight" : ""}" id="wrap-timeStart">
                  <label for="timeStart">Time Start <span class="ce-req">*</span></label>
                  <div class="ce-timepicker-wrap" id="picker-wrap-timeStart">
                    <input type="text"
                           id="timeStart"
                           name="timeStart"
                           class="ce-timepicker-input"
                           value="08:00 AM"
                           min="08:00"
                           max="20:00"
                           readonly
                           required
                           aria-describedby="error-timeStart"
                           aria-expanded="false"
                           aria-haspopup="true">
                    <button type="button" class="ce-timepicker-btn" id="btnToggle-timeStart" aria-label="Choose start time" tabindex="-1">
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <circle cx="12" cy="12" r="10"></circle>
                        <polyline points="12 6 12 12 16 14"></polyline>
                      </svg>
                    </button>
                    <div class="ce-timepicker-dropdown" id="dropdown-timeStart" hidden>
                      <div class="ce-timepicker-cols">
                        <div class="ce-timepicker-col" data-col="hour" aria-label="Hours"></div>
                        <div class="ce-timepicker-col" data-col="minute" aria-label="Minutes"></div>
                        <div class="ce-timepicker-col" data-col="period" aria-label="Period"></div>
                      </div>
                    </div>
                  </div>
                  <p class="ce-error" id="error-timeStart" hidden></p>
                </div>

                <!-- Time End: Default 8:00 PM, max 8:00 PM (for Same time each day) -->
                <div class="ce-field ${state.highlightedFields.has("timeEnd") ? "is-copied-highlight" : ""}" id="wrap-timeEnd">
                  <label for="timeEnd">Time End <span class="ce-req">*</span></label>
                  <div class="ce-timepicker-wrap" id="picker-wrap-timeEnd">
                    <input type="text"
                           id="timeEnd"
                           name="timeEnd"
                           class="ce-timepicker-input"
                           value="08:00 PM"
                           min="08:00"
                           max="20:00"
                           readonly
                           required
                           aria-describedby="error-timeEnd"
                           aria-expanded="false"
                           aria-haspopup="true">
                    <button type="button" class="ce-timepicker-btn" id="btnToggle-timeEnd" aria-label="Choose end time" tabindex="-1">
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <circle cx="12" cy="12" r="10"></circle>
                        <polyline points="12 6 12 16 14"></polyline>
                      </svg>
                    </button>
                    <div class="ce-timepicker-dropdown" id="dropdown-timeEnd" hidden>
                      <div class="ce-timepicker-cols">
                        <div class="ce-timepicker-col" data-col="hour" aria-label="Hours"></div>
                        <div class="ce-timepicker-col" data-col="minute" aria-label="Minutes"></div>
                        <div class="ce-timepicker-col" data-col="period" aria-label="Period"></div>
                      </div>
                    </div>
                  </div>
                  <p class="ce-error" id="error-timeEnd" hidden></p>
                </div>

                <!-- Different time by day container (Photo 3) -->
                <div class="ce-field ce-field--full" id="wrap-dailyScheduleContainer" hidden>
                  <div class="ce-daily-schedule-card">
                    <p class="ce-daily-hint">Set a separate start and end time for each event date.</p>
                    <div class="ce-daily-schedule-list" id="dailyScheduleList">
                      <!-- Dynamic rows for each date -->
                    </div>
                  </div>
                  <p class="ce-error" id="error-dailySchedule" hidden></p>
                </div>

                <!-- Grouped Venue Dropdown -->
                <div class="ce-field" id="wrap-venue">
                  <label for="venue">Venue <span class="ce-req">*</span></label>
                  <select id="venue" name="venue" required aria-describedby="error-venue">
                    <option value="">Select venue...</option>
                    ${VENUES_GROUPED.map((grp) => `
                      <optgroup label="${escapeHTML(grp.campus)}">
                        ${grp.venues.map((v) => `
                          <option value="${escapeHTML(v.name)}" data-capacity="${v.maxCapacity}" data-type="${v.type || ""}">
                            ${escapeHTML(v.name)} (Max: ${v.maxCapacity})
                          </option>
                        `).join("")}
                      </optgroup>
                    `).join("")}
                  </select>
                  <p class="ce-error" id="error-venue" hidden></p>
                </div>

                <div class="ce-field" id="wrap-maxCapacity">
                  <label for="maxCapacity">Max Capacity <span class="ce-req">*</span></label>
                  <input type="number"
                         id="maxCapacity"
                         name="maxCapacity"
                         min="1"
                         step="1"
                         disabled
                         required
                         placeholder="Expected Participants"
                         aria-describedby="venueCapacityHint error-maxCapacity">
                  <small class="ce-hint" id="venueCapacityHint">Select a venue to view capacity limit.</small>
                  <p class="ce-error" id="error-maxCapacity" hidden></p>
                </div>

                <!-- Venue Type: Read-Only & Auto-Linked to Venue -->
                <div class="ce-field" id="wrap-weatherContingency">
                  <label for="weatherContingency">Venue Type <span class="ce-readonly-tag">(Auto-linked)</span></label>
                  <input type="text"
                         id="weatherContingency"
                         name="weatherContingency"
                         readonly
                         class="ce-input--readonly"
                         placeholder="Select a venue to determine venue type"
                         aria-describedby="error-weatherContingency">
                  <p class="ce-error" id="error-weatherContingency" hidden></p>
                </div>

                <!-- Outside PUP Additional Fields (Conditional) -->
                <div class="ce-field ce-field--full" id="wrap-customVenueName" hidden>
                  <label for="customVenueName">Venue Name <span class="ce-req">*</span></label>
                  <input type="text"
                         id="customVenueName"
                         name="customVenueName"
                         placeholder="e.g. Grand Ballroom, Tagaytay Country Hotel"
                         aria-describedby="error-customVenueName">
                  <p class="ce-error" id="error-customVenueName" hidden></p>
                </div>

                <div class="ce-field ce-field--full" id="wrap-customVenueAddress" hidden>
                  <label for="customVenueAddress">Exact Address <span class="ce-req">*</span></label>
                  <input type="text"
                         id="customVenueAddress"
                         name="customVenueAddress"
                         placeholder="e.g. Aguinaldo Highway, Silang Junction North, Tagaytay City, Cavite"
                         aria-describedby="error-customVenueAddress">
                  <p class="ce-error" id="error-customVenueAddress" hidden></p>
                </div>

                <!-- Online / Virtual Additional Field (Conditional) -->
                <div class="ce-field ce-field--full" id="wrap-onlineMeetingLink" hidden>
                  <label for="onlineMeetingLink">Meeting Link <span class="ce-req">*</span></label>
                  <input type="text"
                         id="onlineMeetingLink"
                         name="onlineMeetingLink"
                         placeholder="e.g. https://meet.google.com/abc-defg-hij or Zoom meeting link"
                         aria-describedby="error-onlineMeetingLink">
                  <small class="ce-hint">Provide the meeting link or virtual platform URL.</small>
                  <p class="ce-error" id="error-onlineMeetingLink" hidden></p>
                </div>
              </div>
            </section>

            <!-- Card 3: Approval Chain & Attendees (Task 3) -->
            <section class="ce-card" id="card-approval-chain">
              <div class="ce-card-header">
                <h2 class="ce-card-title">3. Approval Chain & Attendees</h2>
              </div>
              <div class="ce-fields-grid">
                <!-- Target Audience -->
                <div class="ce-field ce-field--full" id="wrap-targetAudience">
                  <label for="targetAudience" class="ce-label">
                    Target audience
                    <span class="ce-req" style="color: #dc2626; display: block; margin-top: -2px;">*</span>
                  </label>
                  <select id="targetAudience" name="targetAudience" class="ce-select" required aria-describedby="error-targetAudience">
                    <option value="Mixed Audience">Mixed Audience</option>
                    <option value="Organization Members Only">Organization Members Only</option>
                    <option value="Open to All" selected>Open to All (Default)</option>
                  </select>
                  <p class="ce-error" id="error-targetAudience" hidden></p>
                </div>

                <div class="ce-field ce-field--full" id="targetAudienceDetails" hidden>
                  <div class="ce-fields-grid">
                    <fieldset class="ce-field" id="wrap-targetDepartments">
                      <legend>Target Department</legend>
                      <div class="ce-audience-options">
                        ${[...new Set([...TARGET_DEPARTMENTS, ...defaultTargetDepartments])].map((department) => `
                          <label><input type="checkbox" class="ce-target-department" value="${escapeHTML(department)}" ${defaultTargetDepartments.includes(department) ? "checked" : ""}> ${escapeHTML(department)}</label>
                        `).join("")}
                      </div>
                      <p class="ce-error" id="error-targetDepartments" hidden></p>
                    </fieldset>
                    <fieldset class="ce-field" id="wrap-targetYearLevels">
                      <legend>Target Year Level</legend>
                      <div class="ce-audience-options">
                        <label><input type="checkbox" id="targetAllYears" value="all" ${state.targetYearLevels.length === 0 ? "checked" : ""}> All Year Level</label>
                        ${TARGET_YEARS.map((year) => `
                          <label><input type="checkbox" class="ce-target-year" value="${escapeHTML(year)}" ${state.targetYearLevels.includes(year) ? "checked" : ""}> ${escapeHTML(year)}</label>
                        `).join("")}
                      </div>
                    </fieldset>
                    <div class="ce-field" id="wrap-targetSections">
                      <label for="targetSections">Target Section</label>
                      <div class="ce-chips-container" id="targetSectionsContainer">
                        <div id="targetSectionsList" class="ce-chips-list"></div>
                        <input type="text" id="targetSections" name="targetSections" class="ce-chip-input" placeholder="e.g. 1-1" aria-describedby="error-targetSections" autocomplete="off">
                      </div>
                      <small class="ce-hint">Press Enter or comma to add each section.</small>
                      <p class="ce-error" id="error-targetSections" hidden></p>
                    </div>
                  </div>
                </div>

                <!-- Partner Organizations -->
                <div class="ce-field ce-field--full ce-partner-section" id="wrap-partnerOrgs">
                  <div class="ce-partner-header">
                    <div class="ce-partner-title-wrap">
                      <h3 class="ce-partner-title">Partner organizations</h3>
                      <p class="ce-partner-subtitle">Choose one or more registered organizations and assign each a role.</p>
                    </div>
                    <label class="ce-collab-checkbox-label">
                      <input type="checkbox" id="isCollaboration" name="isCollaboration" ${state.isCollaboration ? "checked" : ""}>
                      <span class="ce-collab-custom-box">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
                          <polyline points="20 6 9 17 4 12"></polyline>
                        </svg>
                      </span>
                      <span class="ce-collab-text">Collaboration</span>
                    </label>
                  </div>

                  <div class="ce-partner-body" id="partnerBody" ${state.isCollaboration ? "" : 'style="display:none;"'}>
                    <div class="ce-partner-add-row">
                      <select id="partnerOrgSelect" class="ce-select" aria-label="Select organization">
                        <option value="" disabled selected>Select organization...</option>
                        ${partnerOrgsPool.map(org => `<option value="${escapeHTML(org.id)}">${escapeHTML(org.name)} - ${escapeHTML(org.subtitle)}</option>`).join("")}
                      </select>
                      <select id="partnerRoleSelect" class="ce-select" aria-label="Role">
                        <option value="Co-Organizer" selected>Co-Organizer</option>
                        <option value="Sponsor">Sponsor</option>
                        <option value="Partner">Partner</option>
                      </select>
                      <button type="button" id="btnAddPartner" class="ce-btn-add-partner">+ Add</button>
                    </div>

                    <div class="ce-partner-list" id="partnerOrgList">
                      <!-- Dynamic partner item cards -->
                    </div>

                    <div class="ce-collab-notes-wrap">
                      <label for="collaborationNotes" class="ce-label">Collaboration notes</label>
                      <textarea id="collaborationNotes" name="collaborationNotes" rows="3" placeholder="Responsibilities, deliverables, cost sharing...">${escapeHTML(state.collaborationNotes || "")}</textarea>
                    </div>
                  </div>
                </div>

                <!-- External Guests or Speakers -->
                <div class="ce-field ce-field--full ce-guests-section" id="wrap-externalGuests">
                  <div class="ce-guests-header">
                    <div class="ce-guests-title-wrap">
                      <h3 class="ce-guests-title">External guests or speakers</h3>
                      <p class="ce-guests-subtitle">Add one entry per guest. Guests do not need RECOVIBE accounts.</p>
                    </div>
                    <button type="button" id="btnAddGuest" class="ce-btn-add-guest">+ Add guest</button>
                  </div>

                  <div class="ce-guests-list" id="externalGuestsList">
                    <!-- Dynamic guest cards -->
                  </div>
                  <p class="ce-error" id="error-externalGuests" hidden></p>
                </div>

                <!-- Hidden outside guests toggle input for sequential approver sync -->
                <input type="checkbox" id="outsideGuests" name="outsideGuests" style="display:none;" ${state.outsideGuests ? "checked" : ""}>

                <div class="ce-field ce-field--full" id="wrap-approverList">
                  <div class="ce-label-split" style="margin-bottom: 8px;">
                    <label id="approverListLabel">Sequential Approval Steps <span class="ce-req">*</span></label>
                    <span class="ce-counter" id="approverCountText">7 approvers selected</span>
                  </div>
                  <p class="ce-hint" style="margin-bottom: 12px;">
                    Approvals run sequentially in 8 steps. Each step opens only after the one before approves. Unticked approvers are skipped and the rest are numbered by position.
                  </p>
                  <div class="ce-approver-list" id="approverList">
                    <!-- Dynamic approver items -->
                  </div>
                  <p class="ce-error" id="error-approvers" hidden></p>
                </div>
              </div>
            </section>

            <!-- Card 4: Registration -->
            <section class="ce-card" id="card-registration">
              <div class="ce-card-header">
                <h2 class="ce-card-title">4. Registration Information</h2>
              </div>
              <div class="ce-fields-grid">
                <!-- Registration Start -->
                <div class="ce-field ${state.highlightedFields.has("registrationStart") ? "is-copied-highlight" : ""}" id="wrap-registrationStart">
                  <label for="registrationStart">Registration Start <span class="ce-req">*</span></label>
                  <input type="datetime-local"
                         id="registrationStart"
                         name="registrationStart"
                         value="${escapeHTML(initialRegStart)}"
                         min="${escapeHTML(getManilaDateTimeString())}"
                         required
                         aria-describedby="error-registrationStart">
                  <small class="ce-hint">Date and time when registration opens.</small>
                  <p class="ce-error" id="error-registrationStart" hidden></p>
                </div>

                <!-- Registration End (1-2 days before event date) -->
                <div class="ce-field ${state.highlightedFields.has("registrationEnd") || state.highlightedFields.has("registrationDeadline") ? "is-copied-highlight" : ""}" id="wrap-registrationEnd">
                  <div class="ce-label-split">
                    <label for="registrationEnd">Registration End <span class="ce-req">*</span></label>
                    <button type="button" class="ce-text-link" id="btnResetAutoDeadline" title="Reset to 1-2 days before event date">Reset to auto</button>
                  </div>
                  <input type="datetime-local"
                         id="registrationEnd"
                         name="registrationEnd"
                         value="${escapeHTML(initialRegEnd)}"
                         min="${escapeHTML(initialRegStart)}"
                         max="${escapeHTML(initialMaxRegEnd)}"
                         required
                         aria-describedby="error-registrationEnd">
                  <input type="hidden" id="registrationDeadline" name="registrationDeadline" value="${escapeHTML(initialRegEnd)}">
                  <small class="ce-hint">Must be 1 or 2 days before the event date.</small>
                  <p class="ce-error" id="error-registrationEnd" hidden></p>
                </div>

                <div class="ce-field ce-field--full ce-field--toggle" id="wrap-attendanceRequired">
                  <span class="ce-toggle-label">Attendance Required</span>
                  <label class="ce-switch">
                    <input type="checkbox" id="attendanceRequired" name="attendanceRequired" checked>
                    <span class="ce-slider"></span>
                  </label>
                </div>
              </div>
            </section>

            <!-- Card 5: Event Details -->
            <section class="ce-card" id="card-details">
              <div class="ce-card-header">
                <h2 class="ce-card-title">5. Event Details & Faculty</h2>
              </div>
              <div class="ce-fields-grid">
                <div class="ce-field ce-field--full" id="wrap-description">
                  <div class="ce-label-split">
                    <label for="description">Event Description <span class="ce-req">*</span></label>
                    <span class="ce-counter" id="descCharCounter">0 / 1500</span>
                  </div>
                  <textarea id="description"
                            name="description"
                            rows="4"
                            minlength="20"
                            maxlength="1500"
                            placeholder="Provide a comprehensive summary of the event objectives, agenda, and target outcomes..."></textarea>
                </div>

                <!-- Rationale: Just like Event Description -->
                <div class="ce-field ce-field--full" id="wrap-rationale">
                  <div class="ce-label-split">
                    <label for="rationale">Rationale <span class="ce-req">*</span></label>
                    <span class="ce-counter" id="rationaleCharCounter">0 / 1500</span>
                  </div>
                  <textarea id="rationale"
                            name="rationale"
                            rows="4"
                            minlength="20"
                            maxlength="1500"
                            placeholder="Provide the rationale, background, and justification for organizing this event..."></textarea>
                </div>

                <!-- Objectives (formerly Key Details) with bullet support -->
                <div class="ce-field ce-field--full" id="wrap-keyDetails">
                  <label for="keyDetails">Objectives <small>(1–10 items, 5–300 characters each)</small></label>
                  <textarea id="keyDetails"
                            name="keyDetails"
                            rows="3"
                            placeholder="• Event objective 1&#10;• Event objective 2&#10;• Expected learning outcome"></textarea>
                </div>

                <!-- Requirements & Reminders with bullet support -->
                <div class="ce-field ce-field--full" id="wrap-requirements">
                  <label for="requirements">Requirements & Reminders <small>(up to 20 items, 2–300 characters each)</small></label>
                  <textarea id="requirements"
                            name="requirements"
                            rows="3"
                            placeholder="• Bring valid school ID&#10;• Attire: Business casual&#10;• Install required software"></textarea>
                </div>

                <!-- Participating Faculty Members (Optional) with No Numbers in Names -->
                <div class="ce-field ce-field--full" id="wrap-facultyChips">
                  <label for="facultySearchInput">Participating Faculty Members <small>(Optional)</small></label>
                  <div class="ce-chips-container" id="facultyChipsContainer">
                    <div id="facultyChipsList" class="ce-chips-list"></div>
                    <input type="text"
                           id="facultySearchInput"
                           class="ce-chip-input"
                           placeholder="Type to search faculty (optional)..."
                           autocomplete="off">
                    <div class="ce-chip-suggestions" id="facultySuggestions" hidden></div>
                  </div>
                  <p class="ce-inline-hint" id="facultyNoNumbersHint" style="color: #b3261e; font-size: 12px; margin-top: 4px;" hidden></p>
                  <small class="ce-hint">Participating faculty members who will attend or facilitate (optional).</small>
                  <p class="ce-error" id="error-facultyChips" hidden></p>
                </div>

                <!-- Contact Person Section: Empty by default, No Numbers in Name, 09 Lock on Phone -->
                <div class="ce-field ce-field--full" id="wrap-contactPerson">
                  <h3 style="margin: 10px 0 6px; font-size: 15px; font-weight: 600; color: #241a17;">Contact Person</h3>
                  <div class="ce-fields-grid" style="margin-top: 6px;">
                    <div class="ce-field" id="wrap-contactName">
                      <label for="contactName">Name <span class="ce-req">*</span></label>
                      <input type="text"
                             id="contactName"
                             name="contactName"
                             placeholder="Contact person's full name"
                             value=""
                             maxlength="100"
                             autocomplete="off"
                             required
                             aria-describedby="contactNameNoNumbersHint error-contactName">
                      <p class="ce-inline-hint" id="contactNameNoNumbersHint" style="color: #b3261e; font-size: 12px; margin-top: 4px;" hidden></p>
                      <p class="ce-error" id="error-contactName" hidden></p>
                    </div>

                    <div class="ce-field" id="wrap-contactEmail">
                      <label for="contactEmail">Email <span class="ce-req">*</span></label>
                      <input type="email"
                             id="contactEmail"
                             name="contactEmail"
                             placeholder="name@pup.edu.ph"
                             value=""
                             autocomplete="off"
                             required
                             aria-describedby="error-contactEmail">
                      <p class="ce-error" id="error-contactEmail" hidden></p>
                    </div>

                    <div class="ce-field" id="wrap-contactPhone">
                      <label for="contactPhone">Contact Number <small>(Optional)</small></label>
                      <input type="tel"
                             id="contactPhone"
                             name="contactPhone"
                             placeholder="09XXXXXXXXX"
                             value=""
                             maxlength="11"
                             inputmode="numeric"
                             autocomplete="off"
                             aria-describedby="error-contactPhone">
                      <p class="ce-error" id="error-contactPhone" hidden></p>
                    </div>
                  </div>
                </div>
              </div>
            </section>

            <!-- Card 5: Documents -->
            <section class="ce-card" id="card-documents">
              <div class="ce-card-header">
                <h2 class="ce-card-title">5. Attached Documents</h2>
              </div>

              <!-- Documents for Admin review -->
              <div class="ce-admin-docs-container">
                <div class="ce-admin-docs-title-bar">
                  <h3 class="ce-admin-docs-title">Documents for Admin review</h3>
                </div>
                <div class="ce-admin-docs-list" id="adminDocsList">
                  <!-- Google Drive link input rendered here -->
                </div>
              </div>

              <!-- Participant Documents (Optional) -->
              <div class="ce-dropzone-group" id="wrap-participantDocs" style="margin-top: 24px;">
                <div class="ce-dropzone-title-bar">
                  <h3 class="ce-dropzone-title">Participant Documents <small>(Optional)</small></h3>
                </div>
                <label class="sr-only" for="participantDocsLinks">Participant document Google Drive link</label>
                <input id="participantDocsLinks"
                       name="participantDocsLinks"
                       type="url"
                       pattern="^https:\\/\\/(drive|docs)\\.google\\.com\\/.*$"
                       placeholder="https://drive.google.com/..."
                       aria-describedby="hint-participantDocsLinks error-participantDocs">
                <small class="ce-hint" id="hint-participantDocsLinks">Set access to “Anyone with the link can view”.</small>
                <p class="ce-error ce-dropzone-error" id="error-participantDocs" hidden></p>
              </div>
            </section>
          </form>
        </div>

        <!-- Right Column: Sticky Side Panel (Live Preview & Readiness Checklist) -->
        <aside class="ce-side-panel">
          <!-- Card A: Live Event Preview -->
          <div class="ce-preview-card" aria-live="polite">
            <div class="ce-preview-header-area">
              <span class="ce-preview-kicker">Live Event Preview</span>
              <div class="ce-preview-meta-row">
                <span class="ce-preview-type">Campus Event</span>
                <span class="ce-preview-status" id="previewStatus">Draft</span>
              </div>
            </div>

            <h3 class="ce-preview-title" id="previewTitle" title="Untitled Event">Untitled Event</h3>

            <div class="ce-preview-chips-row">
              <span class="ce-preview-source" id="previewSource">Source: ${escapeHTML(defaultEventSource || "Not specified")}</span>
              <div class="ce-preview-tags" id="previewTags">
                <span class="ce-preview-tag">General</span>
              </div>
            </div>

            <div class="ce-preview-details-list">
              <div class="ce-preview-detail">
                <svg class="ce-preview-icon" aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/>
                  <line x1="16" y1="2" x2="16" y2="6"/>
                  <line x1="8" y1="2" x2="8" y2="6"/>
                  <line x1="3" y1="10" x2="21" y2="10"/>
                </svg>
                <span class="ce-preview-text is-muted" id="previewDateTime">Date and time not set</span>
              </div>

              <div class="ce-preview-detail">
                <svg class="ce-preview-icon" aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/>
                  <circle cx="12" cy="10" r="3"/>
                </svg>
                <span class="ce-preview-text is-muted" id="previewVenue">Venue not set</span>
              </div>

              <div class="ce-preview-detail">
                <svg class="ce-preview-icon" aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
                  <circle cx="9" cy="7" r="4"/>
                  <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
                  <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
                </svg>
                <span class="ce-preview-text is-muted" id="previewCapacity">Capacity not specified</span>
              </div>

              <div class="ce-preview-detail">
                <svg class="ce-preview-icon" aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <circle cx="12" cy="12" r="10"></circle>
                  <polyline points="12 6 12 12 14 14"></polyline>
                </svg>
                <span class="ce-preview-text is-muted" id="previewDeadline">Deadline not set</span>
              </div>

              <div class="ce-preview-detail">
                <svg class="ce-preview-icon" aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <circle cx="12" cy="12" r="10"></circle>
                  <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"></path>
                  <path d="M2 12h20"></path>
                </svg>
                <div class="ce-preview-targets-wrap">
                  <span class="ce-preview-target-badge" id="previewTargetYear">Target: All Levels</span>
                  <span class="ce-preview-dot-sep">·</span>
                  <span class="ce-preview-org-badge" id="previewOrganizer">${escapeHTML(readOnlyOrganizerValue)}</span>
                </div>
              </div>
            </div>
          </div>

          <!-- Card B: Event Readiness Checklist -->
          <div class="ce-checks-card">
            <div class="ce-checks-header">
              <h2 class="ce-checks-title">Event Readiness</h2>
              <span class="ce-checks-badge" id="checksBadge" aria-live="polite">0 of 8 Ready</span>
            </div>
            <div class="ce-checks-progress-track" aria-hidden="true">
              <div class="ce-checks-progress-bar" id="checksProgressBar"></div>
            </div>
            <p class="ce-checks-subtitle">All requirements must be fulfilled before submission.</p>
            <ul class="ce-checks-list" id="checksList" aria-live="polite">
              <li class="ce-check-item is-failed" id="check-name">
                <span class="ce-check-icon" aria-hidden="true">✕</span>
                <span class="ce-check-status-sr sr-only">Not yet: </span>
                <span class="ce-check-label">Event name provided (5-150 chars)</span>
              </li>
              <li class="ce-check-item is-failed" id="check-category">
                <span class="ce-check-icon" aria-hidden="true">✕</span>
                <span class="ce-check-status-sr sr-only">Not yet: </span>
                <span class="ce-check-label">1 to 3 categories selected</span>
              </li>
              <li class="ce-check-item is-failed" id="check-times">
                <span class="ce-check-icon" aria-hidden="true">✕</span>
                <span class="ce-check-status-sr sr-only">Not yet: </span>
                <span class="ce-check-label">Time End is after Time Start</span>
              </li>
              <li class="ce-check-item is-failed" id="check-conflict">
                <span class="ce-check-icon" aria-hidden="true">✕</span>
                <span class="ce-check-status-sr sr-only">Not yet: </span>
                <span class="ce-check-label">No venue booking conflict</span>
              </li>
              <li class="ce-check-item is-failed" id="check-deadline">
                <span class="ce-check-icon" aria-hidden="true">✕</span>
                <span class="ce-check-status-sr sr-only">Not yet: </span>
                <span class="ce-check-label">Registration end is 1 or 2 days before event date</span>
              </li>
              <li class="ce-check-item is-failed" id="check-capacity">
                <span class="ce-check-icon" aria-hidden="true">✕</span>
                <span class="ce-check-status-sr sr-only">Not yet: </span>
                <span class="ce-check-label">Capacity is within venue limit</span>
              </li>
              <li class="ce-check-item is-failed" id="check-contact">
                <span class="ce-check-icon" aria-hidden="true">✕</span>
                <span class="ce-check-status-sr sr-only">Not yet: </span>
                <span class="ce-check-label">Contact person name and valid email</span>
              </li>
              <li class="ce-check-item is-failed" id="check-approvalDocs">
                <span class="ce-check-icon" aria-hidden="true">✕</span>
                <span class="ce-check-status-sr sr-only">Not yet: </span>
                <span class="ce-check-label">Admin proposal documents link</span>
              </li>
            </ul>
          </div>
        </aside>
      </div>

      <!-- Sticky Bottom Action Bar with Cancel, Save Draft, and Submit -->
      <footer class="ce-bottom-bar">
        <div class="ce-bottom-bar-inner">
          <div class="ce-bottom-status" id="bottomStatusMessage">
            <span id="bottomStatusText">Review your event information before submitting.</span>
          </div>
          <div class="ce-bottom-actions">
            <button type="button" class="ce-btn-secondary ${state.addAsFavorite ? "is-active" : ""}" id="btnAddAsFavorite" aria-pressed="${Boolean(state.addAsFavorite)}">
              ${state.addAsFavorite ? "★ Added as Favorite" : "☆ Add as Favorite"}
            </button>
            <button type="button" class="ce-btn-secondary" id="btnCancelEvent">
              Cancel
            </button>
            <button type="button" class="ce-btn-secondary" id="btnSaveDraft">
              Save Draft
            </button>
            <button type="button" class="ce-btn-primary" id="btnSubmitApproval">
              ${requireApproval ? "Submit for Approval" : "Publish Event"}
            </button>
          </div>
        </div>
      </footer>

      <!-- Confirmation Pop-Up Modal -->
      <div class="ce-dialog-layer" id="ceConfirmModal" role="alertdialog" aria-modal="true" aria-labelledby="confirmModalTitle" hidden>
        <div class="ce-confirm">
          <h2 id="confirmModalTitle">Confirm Action</h2>
          <p id="confirmModalText">Are you sure you want to proceed?</p>
          <div class="ce-confirm-summary" id="confirmModalSummary" style="display:none;"></div>
          <p class="ce-confirm-explainer" id="confirmModalExplainer" style="display:none;"></p>
          <div class="ce-confirm-checkbox-wrap" id="confirmModalCheckboxWrap" style="display:none;">
            <label class="ce-confirm-checkbox-label">
              <input type="checkbox" id="confirmModalCheckbox" class="ce-confirm-checkbox-input" />
              <span id="confirmModalCheckboxText" class="ce-confirm-checkbox-text">I confirm the details are accurate and ready for review.</span>
            </label>
          </div>
          <div class="ce-confirm-actions">
            <button type="button" class="ce-btn-secondary" id="confirmModalCancelBtn">Cancel</button>
            <button type="button" class="ce-btn-primary" id="confirmModalPrimaryBtn">Confirm</button>
          </div>
        </div>
      </div>
    `;
  }

  // 13. Mode Switch Handler
  function handleModeSwitch(newMode) {
    if (state.mode === newMode) return;
    if (state.dirty) {
      showConfirmModal({
        title: "Discard Changes?",
        text: "You have unsaved changes in this form. Switching modes will discard them. Continue?",
        confirmText: "Discard",
        cancelText: "Keep Editing",
        onConfirm: () => {
          state.dirty = false;
          state.isCopied = false;
          state.copiedFrom = null;
          state.editingEventId = null;
          state.activeConfirm = null;
          if (newMode === "existing") {
            state.reuseLoading = false;
          }
          state.mode = newMode;
          render();
        },
      });
      return;
    }
    if (newMode === "existing") {
      state.isCopied = false;
      state.copiedFrom = null;
      state.editingEventId = null;
      state.activeConfirm = null;
      state.reuseLoading = false;
    }
    state.mode = newMode;
    render();
  }

  // 14. Prefill Form from Copied/Existing Event
  function prefillFormFromEvent(ev, preserveDates = false) {
    state.isCopied = true;
    state.copiedFrom = ev;
    state.mode = "new";
    state.dirty = true;
    state.deadlineManuallyEdited = true;

    state.highlightedFields = new Set(["eventDate", "timeStart", "timeEnd", "category"]);

    if (Array.isArray(ev.categories) && ev.categories.length > 0) {
      state.selectedCategories = [...ev.categories.slice(0, 3)];
    } else if (ev.category) {
      state.selectedCategories = String(ev.category)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 3);
    } else {
      state.selectedCategories = [];
    }

    if (Array.isArray(ev.participatingFaculty)) {
      state.participatingFaculty = [...ev.participatingFaculty];
    } else {
      state.participatingFaculty = [];
    }

    state.adminDocsLink = getAdminDocsLink(ev);
    state.adminDocumentLinks = getAdminDocumentLinks(ev);
    const savedParticipantDocuments = Array.isArray(ev.participantDocuments)
      ? ev.participantDocuments
      : Array.isArray(ev.attachments)
        ? ev.attachments
        : [];
    const savedParticipantUrls = getParticipantDocumentUrls(savedParticipantDocuments);
    state.participantDocumentLink = savedParticipantUrls.find(isGoogleDriveLink) || "";
    state.legacyParticipantDocs = savedParticipantDocuments.filter((document) => {
      const url = typeof document === "string"
        ? document
        : document?.url || document?.path || document?.downloadURL || document?.downloadUrl || "";
      return url && !isGoogleDriveLink(url);
    });
    state.participantDocs = [
      ...state.legacyParticipantDocs,
      ...savedParticipantUrls.filter(isGoogleDriveLink).map((url, index) => ({
        name: `Participant Document ${index + 1}`,
        url,
        type: "Google Drive",
      })),
    ];

    state.targetAudience = normalizeTargetAudience(ev.targetAudience);
    state.targetDepartments = Array.isArray(ev.targetDepartments) ? [...ev.targetDepartments] : [];
    state.targetYearLevels = Array.isArray(ev.targetYearLevels)
      ? [...ev.targetYearLevels]
      : ev.targetYear && ev.targetYear !== "All Levels"
        ? String(ev.targetYear).split(",").map((year) => year.trim()).filter((year) => TARGET_YEARS.includes(year))
        : [];
    state.targetSections = Array.isArray(ev.targetSections)
      ? [...ev.targetSections]
      : ev.targetSections
        ? String(ev.targetSections).split(/[,\n]/).map((section) => section.trim()).filter(Boolean)
        : [];
    state.isCollaboration = ev.isCollaboration !== undefined ? Boolean(ev.isCollaboration) : Boolean(Array.isArray(ev.partnerOrganizations) && ev.partnerOrganizations.length > 0);
    state.partnerOrganizations = Array.isArray(ev.partnerOrganizations) ? [...ev.partnerOrganizations] : [];
    state.collaborationNotes = ev.collaborationNotes || "";
    state.externalGuests = Array.isArray(ev.externalGuests) ? [...ev.externalGuests] : [];
    state.outsideGuests = Boolean((state.externalGuests && state.externalGuests.length > 0) || ev.outsideGuests);

    render();

    const form = document.getElementById("createEventMainForm");
    if (form) {
      if (form.eventName) form.eventName.value = ev.title || ev.eventName || "";
      if (form.eventSource) form.eventSource.value = defaultEventSource;
      if (form.targetYear) form.targetYear.value = state.targetYearLevels.join(", ") || "All Levels";
      if (form.targetAudience) form.targetAudience.value = state.targetAudience;
      renderTargetSectionTags();
      if (form.isCollaboration) form.isCollaboration.checked = state.isCollaboration;
      if (form.collaborationNotes) form.collaborationNotes.value = state.collaborationNotes;
      const savedDate = ev.date || ev.dateISO || ev.eventDate || "";
      const nextDate = preserveDates ? savedDate : calculateNextLogicalDate(savedDate);
      if (form.eventDate) form.eventDate.value = nextDate;
      if (form.eventDateEnd) {
        const nextEndDate = ev.dateEnd || ev.endDate || ev.endDateISO || nextDate;
        form.eventDateEnd.value = nextEndDate >= nextDate ? nextEndDate : nextDate;
        form.eventDateEnd.min = nextDate;
      }
      if (form.dailySchedule) {
        form.dailySchedule.value = ev.dailySchedule || "Same time each day";
      }
      handleDailyScheduleToggle();
      if (form.dailySchedule && form.dailySchedule.value === "Different time by day" && Array.isArray(ev.dailySchedules)) {
        renderDailyScheduleRows();
        ev.dailySchedules.forEach((ds) => {
          const row = document.querySelector(`.ce-daily-schedule-row[data-date="${ds.date}"]`);
          if (row) {
            const s = row.querySelector(".ce-daily-start-input");
            const e = row.querySelector(".ce-daily-end-input");
            if (s && ds.timeStart) s.value = ds.timeStart;
            if (e && ds.timeEnd) e.value = ds.timeEnd;
          }
        });
      }
      const manilaInfo = getManilaDateInfo();
      if (form.registrationStart) {
        form.registrationStart.value = ev.registrationStart || getManilaDateTimeString(Date.now() + 15 * 60 * 1000);
        form.registrationStart.min = getManilaDateTimeString();
      }
      if (form.registrationEnd) {
        form.registrationEnd.value = preserveDates
          ? (ev.registrationEnd || ev.registrationDeadline || "")
          : calculateAutoRegistrationEnd(nextDate);
        form.registrationEnd.min = form.registrationStart?.value || getManilaDateTimeString();
        form.registrationEnd.max = calculateMaxRegistrationEnd(nextDate);
      }
      if (form.registrationDeadline) {
        form.registrationDeadline.value = form.registrationEnd ? form.registrationEnd.value : "";
      }
      if (form.attendanceRequired) {
        form.attendanceRequired.checked = ev.attendanceRequired !== false;
      }
      if (form.timeStart && ev.timeStart) form.timeStart.value = ev.timeStart;
      if (form.timeEnd && ev.timeEnd) form.timeEnd.value = ev.timeEnd;
      if (form.venue && ev.venue) form.venue.value = ev.venue;
      if (form.customVenueName) form.customVenueName.value = ev.customVenueName || ev.venueName || ev.building || "";
      if (form.customVenueAddress) form.customVenueAddress.value = ev.customVenueAddress || ev.venueAddress || ev.roomNumber || "";
      if (form.onlineMeetingLink) form.onlineMeetingLink.value = ev.onlineMeetingLink || ev.meetingLink || "";
      if (form.maxCapacity && ev.maxCapacity) form.maxCapacity.value = ev.maxCapacity;
      if (form.description && ev.description) form.description.value = ev.description;
      if (form.rationale && ev.rationale) form.rationale.value = ev.rationale;

      if (form.keyDetails) {
        if (Array.isArray(ev.keyDetails) && ev.keyDetails.length) {
          form.keyDetails.value = ev.keyDetails.map((k) => "• " + String(k).replace(/^[•\-\*]\s*/, "")).join("\n");
        } else if (typeof ev.keyDetails === "string" && ev.keyDetails) {
          form.keyDetails.value = ev.keyDetails;
        } else {
          form.keyDetails.value = "• ";
        }
      }

      async function loadDraftForEditing(uid) {
        const draftId = new URLSearchParams(location.search).get("draft");
        if (!draftId) return;
        try {
          const snapshot = await get(ref(rtdb, `drafts/${uid}/${draftId}`));
          const draft = snapshot.val();
          if (!draft || draft.status !== "draft") {
            showToast("We couldn't find that draft in your list.");
            return;
          }
          state.draftId = draftId;
          prefillFormFromEvent(draft, true);
          state.dirty = false;
        } catch (error) {
          console.error("Could not load event draft:", error);
          showToast("Couldn't load this draft. Please try again.");
        }
      }

      function serializeFormForServer(status) {
        const payload = serializeEvent(status);
        ["id", "eventId", "organizer", "organizerName", "organizerId", "organizerUid",
          "createdBy", "createdByRole", "creatorRole", "source"].forEach((key) => delete payload[key]);
        payload.status = status.toLowerCase();
        payload.approvers = [...state.selectedApprovers];
        if (state.draftId) payload.draftId = state.draftId;
        return payload;
      }

      if (form.requirements) {
        if (Array.isArray(ev.requirements) && ev.requirements.length) {
          form.requirements.value = ev.requirements.map((r) => "• " + String(r).replace(/^[•\-\*]\s*/, "")).join("\n");
        } else if (typeof ev.requirements === "string" && ev.requirements) {
          form.requirements.value = ev.requirements;
        } else {
          form.requirements.value = "• ";
        }
      }

      if (form.contactName && (ev.contactPerson?.name || ev.contactName)) {
        form.contactName.value = ev.contactPerson?.name || ev.contactName || "";
      }
      if (form.contactEmail && (ev.contactPerson?.email || ev.contactEmail)) {
        form.contactEmail.value = ev.contactPerson?.email || ev.contactEmail || "";
      }
      if (form.contactPhone) {
        const ph = ev.contactPerson?.phone || ev.contactPhone || "";
        form.contactPhone.value = ph.startsWith("09") ? ph.slice(0, 11) : "09";
      }

      checkVenueCapacityHint();
      updateAllReadinessChecks();
      updateLivePreview();
      updateDescCounter();
      updateRationaleCounter();

      const dateField = document.getElementById("wrap-eventDate");
      if (dateField) {
        dateField.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    }
  }

  // 15. Setup Event Listeners & Interactive Handlers
  function setupEventHandlers() {
    // Bind submission before the other form helpers so their setup cannot leave
    // the primary action without a click handler.
    const btnSubmit = document.getElementById("btnSubmitApproval");
    if (btnSubmit) {
      btnSubmit.addEventListener("click", async () => {
        try {
          if (!validateForm()) {
            const message = "Please resolve all marked errors before submitting.";
            showToast(message);
            alert(message);
            return;
          }

          showConfirmModal({
            title: "Save Event to Firestore?",
            text: "This saves the event directly to Firestore with pending status. It bypasses the server approval chain and does not notify reviewers.",
            confirmText: "Save Pending Event",
            cancelText: "No",
            checkboxText: "I confirm the details are accurate and ready to save.",
            isSubmittingRef: () => state.isActionBusy,
            onConfirm: async (closeModal) => {
              const confirmationCheckbox = document.getElementById("confirmModalCheckbox");
              if (!confirmationCheckbox?.checked) {
                alert("Please confirm that the event details are accurate before submitting.");
                confirmationCheckbox?.focus();
                return;
              }
              if (state.isActionBusy) return;
              state.isActionBusy = true;
              const confirmButton = document.getElementById("confirmModalPrimaryBtn");
              const confirmButtonText = confirmButton?.textContent || "";
              if (confirmButton) {
                confirmButton.textContent = requireApproval ? "Submitting…" : "Publishing…";
                confirmButton.setAttribute("aria-busy", "true");
              }
              const submitButtonText = btnSubmit.textContent;
              btnSubmit.disabled = true;
              btnSubmit.setAttribute("aria-busy", "true");
              let submissionStage = "form validation";
              try {
                const adminDocsValid = ADMIN_DOCUMENT_TYPES.every(({ key }) =>
                  isGoogleDriveLink(document.getElementById(`adminDoc-${key}`)?.value || ""),
                );
                if (!adminDocsValid) {
                  closeModal();
                  showToast("Provide a valid Google Drive link for admin review.");
                  document.querySelector("#adminDocsList input:not(:valid)")?.focus();
                  return;
                }
                if (!validateForm()) {
                  closeModal();
                  const message = "Please resolve all marked errors before submitting.";
                  showToast(message);
                  alert(message);
                  return;
                }
                submissionStage = "checking Firestore configuration";
                if (!db || !isFirebaseConfigured) {
                  throw new Error("Event submission is unavailable because Firestore is not configured.");
                }

                submissionStage = "checking signed-in user";
                const organizerUid = auth?.currentUser?.uid;
                if (!organizerUid) {
                  throw new Error("Sign in again before submitting your event.");
                }
                submissionStage = "verifying organizer organization";
                const organizerOrganizationCode = isOrganizerPage
                  ? await getOrganizerOrganizationCode(organizerUid)
                  : "";

                submissionStage = "building Firestore event";
                const formPayload = serializeEvent("pending");
                const submittedAt = new Date().toISOString();
                const eventPayload = sanitizeRtdbValue({
                  ...formPayload,
                  adminDocuments: state.adminDocsLink,
                  status: "pending",
                  organizerUid,
                  organizerId: organizerUid,
                  createdBy: organizerUid,
                  createdByRole: currentRole === "Event Organizer" ? "event_organizer" : "teacher",
                  creatorRole: currentRole,
                  ...(organizerOrganizationCode
                    ? {
                        organizationCode: organizerOrganizationCode,
                        organizerOrganization: organizerOrganizationCode,
                      }
                    : {}),
                  startAt: `${formPayload.date || ""} ${formPayload.timeStart || ""}`.trim(),
                  endAt: `${formPayload.dateEnd || formPayload.date || ""} ${formPayload.timeEnd || ""}`.trim(),
                  approvers: [...state.selectedApprovers],
                });
                eventPayload.createdAt = serverTimestamp();
                eventPayload.updatedAt = serverTimestamp();

                const { payload: firestorePayload, uploadedRefs } =
                  await uploadEventAttachments(eventPayload, organizerUid);
                submissionStage = "writing event to Firestore";
                let eventId = formPayload.id;
                try {
                  if (state.editingEventId) {
                    eventId = state.editingEventId;
                    delete firestorePayload.createdAt;
                    await updateDoc(doc(db, "events", eventId), firestorePayload);
                  } else {
                    const createdEvent = await addDoc(collection(db, "events"), firestorePayload);
                    eventId = createdEvent.id;
                  }
                } catch (writeError) {
                  const cleanupResults = await Promise.allSettled(
                    uploadedRefs.map((objectRef) => deleteObject(objectRef)),
                  );
                  cleanupResults.forEach((result) => {
                    if (result.status === "rejected") {
                      console.error("[CreateEvent] Could not clean up an uploaded Storage file:", {
                        code: result.reason?.code || "unknown",
                        message: result.reason?.message || String(result.reason),
                      });
                    }
                  });
                  throw writeError;
                }
                const localEvent = sanitizeRtdbValue({
                  ...firestorePayload,
                  id: eventId,
                  eventId,
                  organizerUid,
                  organizerId: organizerUid,
                  createdBy: organizerUid,
                  createdByRole: currentRole === "Event Organizer" ? "event_organizer" : "teacher",
                  creatorRole: currentRole,
                  startAt: `${formPayload.date || ""} ${formPayload.timeStart || ""}`.trim(),
                  endAt: `${formPayload.dateEnd || formPayload.date || ""} ${formPayload.timeEnd || ""}`.trim(),
                  status: "pending",
                  createdAt: submittedAt,
                  updatedAt: submittedAt,
                });
                const localSaveSucceeded = writeEventToLocalStorage(localEvent);
                if (!localSaveSucceeded) {
                  console.error(`Could not save event ${eventId} to localStorage key ${storageKeyEvents}.`);
                }
                state.dirty = false;
                const successNotice = "Event saved to Firestore as pending. The reviewer approval chain and notifications were not created.";
                submissionStage = "redirecting after successful Firestore write";
                window.setTimeout(() => {
                  window.location.href = `${redirectListUrl}?new=${encodeURIComponent(eventId)}`;
                }, 1000);
                closeModal();
                try {
                  sessionStorage.setItem("recovibeEventNotice", successNotice);
                } catch (storageError) {
                  console.warn("Could not save the event submission notice:", storageError);
                }
                showToast(successNotice);
              } catch (error) {
                console.error(error);
                console.error("Full error details:", error);
                console.error("Submission failure details:", {
                  stage: submissionStage,
                  code: error?.code || null,
                  message: error?.message || String(error),
                  details: error?.details || null,
                  stack: error?.stack || null,
                });
                const hasFieldErrors = showServerFieldErrors(error);
                const message = error?.code === "permission-denied"
                  ? submissionStage === "verifying organizer organization"
                    ? "Your organizer profile could not be verified. Contact an administrator."
                    : "Firebase denied the upload or event write. Check your published Storage/Firestore rules and account role."
                  : submissionStage === "verifying organizer organization"
                    ? error?.message || "Could not verify your organizer profile."
                  : getFriendlyFunctionError(
                    error,
                    hasFieldErrors
                      ? "Please correct the highlighted fields and try again."
                      : "Couldn't save your event. Your form is still here; please try again.",
                  );
                showToast(message);
              } finally {
                state.isActionBusy = false;
                if (confirmButton) {
                  confirmButton.removeAttribute("aria-busy");
                  if (!document.getElementById("ceConfirmModal")?.hidden) {
                    confirmButton.textContent = confirmButtonText;
                  }
                }
                btnSubmit.disabled = false;
                btnSubmit.removeAttribute("aria-busy");
                btnSubmit.textContent = submitButtonText;
              }
            },
          });
        } catch (error) {
          console.error("Could not start event submission:", error);
          alert(error?.message || String(error));
        }
      });
    } else {
      console.error("Submit button #btnSubmitApproval was not rendered.");
    }

    // Mode switch listeners
    root.querySelectorAll(".ce-mode-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        handleModeSwitch(btn.dataset.mode);
      });
    });

    // Dismiss banner
    const btnDismiss = document.getElementById("btnDismissBanner");
    if (btnDismiss) {
      btnDismiss.addEventListener("click", () => {
        state.isCopied = false;
        state.copiedFrom = null;
        state.highlightedFields.clear();
        const banner = document.querySelector(".ce-copied-banner");
        if (banner) banner.remove();
        root.querySelectorAll(".is-copied-highlight").forEach((el) => el.classList.remove("is-copied-highlight"));
      });
    }

    // Existing events view listeners
    attachExistingViewListeners();

    // Add as Favorite toggle button in Create New Event form
    const btnAddFav = document.getElementById("btnAddAsFavorite");
    if (btnAddFav) {
      btnAddFav.addEventListener("click", () => {
        state.addAsFavorite = !state.addAsFavorite;
        btnAddFav.classList.toggle("is-active", state.addAsFavorite);
        btnAddFav.setAttribute("aria-pressed", String(state.addAsFavorite));
        btnAddFav.innerHTML = state.addAsFavorite ? "★ Added as Favorite" : "☆ Add as Favorite";
      });
    }

    // Dismiss active confirmation on Escape key
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && state.activeConfirm) {
        e.preventDefault();
        closeActiveConfirmation();
      }
    });

    // Input change and dirty marking
    [
      "eventName",
      "eventSource",
      "targetYear",
      "eventDate",
      "eventDateEnd",
      "dailySchedule",
      "timeStart",
      "timeEnd",
      "venue",
      "customVenueName",
      "customVenueAddress",
      "onlineMeetingLink",
      "maxCapacity",
      "registrationStart",
      "registrationEnd",
      "registrationDeadline",
      "attendanceRequired",
      "weatherContingency",
      "description",
      "rationale",
      "keyDetails",
      "requirements",
      "contactName",
      "contactEmail",
      "contactPhone",
    ].forEach((id) => {
      const el = document.getElementById(id);
      if (el) {
        const handler = () => {
          const isInsidePupVenue = document.getElementById("venue")?.value.toLowerCase().includes("inside pup");
          if (id === "customVenueAddress" && isInsidePupVenue) {
            el.value = el.value.replace(/\D/g, "").slice(0, 3);
          }
          state.dirty = true;
          clearFieldError(id);
          removeHighlight(id);
          updateAllReadinessChecks();
          updateLivePreview();
          if (id === "description") updateDescCounter();
          if (id === "rationale") updateRationaleCounter();
          if (id === "venue" || id === "maxCapacity" || id === "customVenueName" || id === "customVenueAddress" || id === "onlineMeetingLink") checkVenueCapacityHint();
          if (id === "eventName") checkDuplicateNameWarning();
          if (id === "eventDate") {
            checkDateHolidayNotice();
            const dEnd = document.getElementById("eventDateEnd");
            if (dEnd) {
              dEnd.min = el.value;
              dEnd.max = getManilaDateInfo().maxDateStr;
              if (dEnd.value && dEnd.value < el.value) {
                dEnd.value = el.value;
              }
            }
            updateDailyScheduleAvailability();
            if (document.getElementById("dailySchedule")?.value === "Different time by day") {
              renderDailyScheduleRows();
            }
          }
          if (id === "eventDateEnd") {
            updateDailyScheduleAvailability();
            if (document.getElementById("dailySchedule")?.value === "Different time by day") {
              renderDailyScheduleRows();
            }
          }
          if (id === "dailySchedule") {
            handleDailyScheduleToggle();
          }
        };
        el.addEventListener("input", handler);
        el.addEventListener("change", handler);
      }
    });

    // Date Auto-Follow for Registration Start & End
    const dateInput = document.getElementById("eventDate");
    const regStartInput = document.getElementById("registrationStart");
    const regEndInput = document.getElementById("registrationEnd");
    const deadlineInput = document.getElementById("registrationDeadline");

    function syncDeadlineWithEnd() {
      if (regEndInput && deadlineInput) {
        deadlineInput.value = regEndInput.value;
      }
    }

    if (dateInput && regEndInput) {
      dateInput.addEventListener("change", () => {
        const dVal = dateInput.value;
        if (dVal) {
          const maxEnd = calculateMaxRegistrationEnd(dVal);
          regEndInput.max = maxEnd;
          if (!state.deadlineManuallyEdited || regEndInput.value > maxEnd) {
            regEndInput.value = calculateAutoRegistrationEnd(dVal);
            syncDeadlineWithEnd();
            regEndInput.dispatchEvent(new Event("input", { bubbles: true }));
          }
        }
      });

      regEndInput.addEventListener("input", () => {
        state.deadlineManuallyEdited = true;
        syncDeadlineWithEnd();
      });

      if (regStartInput) {
        regStartInput.addEventListener("input", () => {
          if (regEndInput) regEndInput.min = regStartInput.value || getManilaDateTimeString();
          updateAllReadinessChecks();
          updateLivePreview();
        });
      }

      const btnResetDeadline = document.getElementById("btnResetAutoDeadline");
      if (btnResetDeadline) {
        btnResetDeadline.addEventListener("click", () => {
          const dVal = dateInput.value || getDefaultEventDate(getManilaDateInfo().todayStr);
          const autoEnd = calculateAutoRegistrationEnd(dVal);
          regEndInput.max = calculateMaxRegistrationEnd(dVal);
          regEndInput.value = autoEnd;
          syncDeadlineWithEnd();
          state.deadlineManuallyEdited = false;
          clearFieldError("registrationEnd");
          clearFieldError("registrationDeadline");
          regEndInput.dispatchEvent(new Event("input", { bubbles: true }));
          regEndInput.dispatchEvent(new Event("change", { bubbles: true }));
          showToast("Registration end reset to 1-2 days before the event date.");
        });
      }
    }

    // Set up Input Rules Helpers
    setupCategoryDropdown();
    handleDailyScheduleToggle();
    setupFacultyChipsInput();
    setupCustomTimepickers();
    setupContactPhoneInput();
    setupBulletTextarea("keyDetails");
    setupBulletTextarea("requirements");
    setupNoNumbersInput("contactName", "contactNameNoNumbersHint");
    setupNoNumbersInput("facultySearchInput", "facultyNoNumbersHint");
    setupAudienceAndCollaboration();
    setupApproverChain();
    const participantDocsInput = document.getElementById("participantDocsLinks");
    if (participantDocsInput) {
      participantDocsInput.value = state.participantDocumentLink || "";
      participantDocsInput.addEventListener("input", () => {
        syncParticipantDocumentLinks();
        state.dirty = true;
        clearFieldError("participantDocs");
        updateAllReadinessChecks();
      });
    }
    renderAdminDocuments();

    // Cancel Button with Confirmation Modal
    const btnCancel = document.getElementById("btnCancelEvent");
    if (btnCancel) {
      btnCancel.addEventListener("click", () => {
        showConfirmModal({
          title: "Cancel Event Creation?",
          text: "Are you sure you want to cancel? Any unsaved changes will be discarded.",
          confirmText: "Yes, Discard",
          cancelText: "Keep Editing",
          onConfirm: () => {
            location.href = redirectListUrl;
          },
        });
      });
    }

    // Save Draft Button with Confirmation Modal
    const btnSaveDraft = document.getElementById("btnSaveDraft");
    if (btnSaveDraft) {
      btnSaveDraft.addEventListener("click", () => {
        const form = document.getElementById("createEventMainForm");
        const nameVal = form?.eventName?.value.trim() || "";
        if (!nameVal) {
          showToast("Please enter an event name before saving draft.");
          form?.eventName?.focus();
          return;
        }

        showConfirmModal({
          title: "Save as Draft?",
          text: "Save this event as a draft? You can return and continue editing it at any time.",
          confirmText: "Save Draft",
          cancelText: "Cancel",
          onConfirm: async () => {
            if (state.isActionBusy) return;
            state.isActionBusy = true;
            setRequestBusy(btnSaveDraft, true, "Save Draft");
            try {
              const saveDraftFn = httpsCallable(functions, "saveEventDraft");
              const result = await saveDraftFn(serializeFormForServer("draft"));
              const savedDraftId = result?.data?.draftId;
              if (!savedDraftId) throw new Error("The draft could not be saved.");
              state.draftId = savedDraftId;
              state.dirty = false;
              sessionStorage.setItem("recovibeEventNotice", "Draft saved.");
              location.href = `${redirectListUrl}?draft=${encodeURIComponent(savedDraftId)}`;
            } catch (error) {
              console.error("Could not save event draft:", error);
              showServerFieldErrors(error);
              showToast(getFriendlyFunctionError(error, "Couldn't save your draft. Please try again."));
            } finally {
              state.isActionBusy = false;
              setRequestBusy(btnSaveDraft, false, "Save Draft");
            }
          },
        });
      });
    }

    // Keep in sync with the other role's create event page.
    window.addEventListener("beforeunload", (e) => {
      if (state.dirty) {
        e.preventDefault();
        e.returnValue = "You have unsaved changes. Would you like to save as a draft before leaving?";
        return e.returnValue;
      }
    });

    document.addEventListener("click", (e) => {
      const link = e.target.closest("a[href]");
      if (!link) return;
      const href = link.getAttribute("href");
      if (!href || href.startsWith("#") || href.startsWith("javascript:") || href.startsWith("mailto:") || href.startsWith("tel:")) return;
      if (state.dirty && !state.isActionBusy) {
        e.preventDefault();
        const form = document.getElementById("createEventMainForm");
        const nameVal = form?.eventName?.value.trim() || "";
        showConfirmModal({
          title: "Unsaved Changes",
          text: "You have unsaved changes on this event. Would you like to save this as a draft before leaving?",
          confirmText: nameVal.length >= 3 ? "Save Draft" : "Discard",
          cancelText: "Keep Editing",
          onConfirm: async () => {
            if (nameVal.length >= 3) {
              try {
                if (functions) {
                  const saveDraftFn = httpsCallable(functions, "saveEventDraft");
                  const result = await saveDraftFn(serializeFormForServer("draft"));
                  if (result?.data?.draftId) {
                    sessionStorage.setItem("recovibeEventNotice", "Draft saved.");
                  }
                }
              } catch (err) {
                console.warn("Could not save draft before leaving:", err);
              }
            }
            state.dirty = false;
            location.href = href;
          },
        });
      }
    });
  }

  function renderApprovers() {
    const list = document.getElementById("approverList");
    const countText = document.getElementById("approverCountText");
    const hintText = document.getElementById("approverHintText");
    const errEl = document.getElementById("error-approvers");
    if (!list) return;

    // Ensure all required stages are included in state.selectedApprovers
    systemApprovalStages.forEach((stage) => {
      if (stage.required && !state.selectedApprovers.includes(stage.id)) {
        state.selectedApprovers.push(stage.id);
      }
    });

    function updateStepTags() {
      const checkedIds = systemApprovalStages
        .map((s) => s.id)
        .filter((id) => {
          const input = document.getElementById(`approver-${id}`);
          const stage = systemApprovalStages.find((s) => s.id === id);
          if (stage?.required) return true;
          return input ? input.checked : state.selectedApprovers.includes(id);
        });
      state.selectedApprovers = checkedIds;

      let currentStep = 1;
      systemApprovalStages.forEach((stage) => {
        const tag = document.getElementById(`stepTag-${stage.id}`);
        const item = document.getElementById(`approverItem-${stage.id}`);
        const isChecked = checkedIds.includes(stage.id);
        if (tag) {
          if (isChecked) {
            tag.textContent = `Step ${currentStep}`;
            tag.classList.remove("is-skipped");
            currentStep += 1;
          } else {
            tag.textContent = "Skipped";
            tag.classList.add("is-skipped");
          }
        }
        if (item) {
          item.classList.toggle("is-selected", isChecked);
        }
      });

      if (countText) {
        countText.textContent = `${checkedIds.length} approver${checkedIds.length === 1 ? "" : "s"} selected`;
      }

      if (errEl) {
        if (checkedIds.length === 0) {
          errEl.hidden = false;
          errEl.textContent = "At least one approver must be selected.";
        } else {
          errEl.hidden = true;
          errEl.textContent = "";
        }
      }
    }

    if (hintText) {
      hintText.textContent = `Approvals run sequentially in ${systemApprovalStages.length} steps. Each step opens only after the one before approves. Unticked approvers are skipped and the rest are numbered by position.`;
    }

    list.innerHTML = systemApprovalStages
      .map((stage) => {
        const isPreChecked = stage.required || state.selectedApprovers.includes(stage.id);
        const isReq = Boolean(stage.required);
        const reviewerExtra = stage.reviewer && stage.reviewer.trim() !== stage.name.trim()
          ? `<span style="font-size:12px;color:#6b7280;margin-left:6px;font-weight:normal;">(${escapeHTML(stage.reviewer)})</span>`
          : "";

        return `
          <div class="ce-approver-item ${isPreChecked ? "is-selected" : ""} ${isReq ? "is-disabled" : ""}" id="approverItem-${stage.id}">
            <div class="ce-approver-col-left">
              <span class="ce-step-tag" id="stepTag-${stage.id}">Step -</span>
              <span class="ce-approver-name">${escapeHTML(stage.name)} ${reviewerExtra}</span>
              ${isReq ? '<span class="ce-req-badge">Required</span>' : ""}
            </div>
            <div class="ce-approver-col-right">
              <input type="checkbox"
                     class="ce-approver-checkbox"
                     id="approver-${stage.id}"
                     data-key="${stage.id}"
                     ${isPreChecked ? "checked" : ""}
                     ${isReq ? "disabled" : ""}>
            </div>
          </div>
        `;
      })
      .join("");

    systemApprovalStages.forEach((stage) => {
      const input = document.getElementById(`approver-${stage.id}`);
      if (input && !stage.required) {
        input.addEventListener("change", () => {
          updateStepTags();
          state.dirty = true;
        });
      }
    });

    updateStepTags();
  }

  function setupApproverChain() {
    renderApprovers();
  }

  // 16. Custom 3-Column Scrollable Timepicker (Hour, Minute, AM/PM) & Daily Schedule
  const PICKER_HOURS = ["12", "01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11"];
  const PICKER_MINUTES = [];
  for (let i = 0; i < 60; i++) {
    PICKER_MINUTES.push(String(i).padStart(2, "0"));
  }
  const PICKER_PERIODS = ["AM", "PM"];

  function attachCustomTimepicker(fieldId, fallbackPeriod) {
    const input = document.getElementById(fieldId);
    const wrap = document.getElementById("picker-wrap-" + fieldId);
    const dropdown = document.getElementById("dropdown-" + fieldId);
    const toggleBtn = document.getElementById("btnToggle-" + fieldId);
    if (!input || !wrap || !dropdown) return;
    if (wrap.dataset.timepickerInit === "true") return;
    wrap.dataset.timepickerInit = "true";

    const hourCol = dropdown.querySelector('[data-col="hour"]');
    const minCol = dropdown.querySelector('[data-col="minute"]');
    const periodCol = dropdown.querySelector('[data-col="period"]');
    if (!hourCol || !minCol || !periodCol) return;

    hourCol.innerHTML = PICKER_HOURS.map((h) => `<div class="ce-timepicker-item" data-value="${h}" role="button" tabindex="0">${h}</div>`).join("");
    minCol.innerHTML = PICKER_MINUTES.map((m) => `<div class="ce-timepicker-item" data-value="${m}" role="button" tabindex="0">${m}</div>`).join("");
    periodCol.innerHTML = PICKER_PERIODS.map((p) => `<div class="ce-timepicker-item" data-value="${p}" role="button" tabindex="0">${p}</div>`).join("");

    function parseCurrent() {
      const val = (input.value || "").trim();
      const match = /^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i.exec(val);
      if (match) {
        return {
          h: match[1].padStart(2, "0"),
          m: match[2].padStart(2, "0"),
          p: (match[3] || "AM").toUpperCase(),
        };
      }
      return fallbackPeriod === "PM" ? { h: "08", m: "00", p: "PM" } : { h: "08", m: "00", p: "AM" };
    }

    function syncActiveClasses(scrollToCenter) {
      const cur = parseCurrent();
      hourCol.querySelectorAll(".ce-timepicker-item").forEach((el) => {
        const isMatch = el.dataset.value === cur.h;
        el.classList.toggle("is-selected", isMatch);
        if (isMatch && scrollToCenter) el.scrollIntoView({ block: "center", behavior: "auto" });
      });
      minCol.querySelectorAll(".ce-timepicker-item").forEach((el) => {
        const isMatch = el.dataset.value === cur.m;
        el.classList.toggle("is-selected", isMatch);
        if (isMatch && scrollToCenter) el.scrollIntoView({ block: "center", behavior: "auto" });
      });
      periodCol.querySelectorAll(".ce-timepicker-item").forEach((el) => {
        const isMatch = el.dataset.value === cur.p;
        el.classList.toggle("is-selected", isMatch);
        if (isMatch && scrollToCenter) el.scrollIntoView({ block: "center", behavior: "auto" });
      });
    }

    function openDropdown() {
      document.querySelectorAll(".ce-timepicker-dropdown").forEach((d) => {
        if (d !== dropdown) d.hidden = true;
      });
      document.querySelectorAll(".ce-timepicker-input").forEach((inp) => {
        if (inp !== input) inp.setAttribute("aria-expanded", "false");
      });
      dropdown.hidden = false;
      input.setAttribute("aria-expanded", "true");
      syncActiveClasses(true);
    }

    function closeDropdown() {
      dropdown.hidden = true;
      input.setAttribute("aria-expanded", "false");
    }

    function updateValue(newH, newM, newP) {
      const cur = parseCurrent();
      const h = newH !== undefined ? newH : cur.h;
      const m = newM !== undefined ? newM : cur.m;
      const p = newP !== undefined ? newP : cur.p;
      input.value = `${h}:${m} ${p}`;
      syncActiveClasses(false);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }

    hourCol.addEventListener("click", (e) => {
      const item = e.target.closest(".ce-timepicker-item");
      if (item) updateValue(item.dataset.value, undefined, undefined);
    });

    minCol.addEventListener("click", (e) => {
      const item = e.target.closest(".ce-timepicker-item");
      if (item) updateValue(undefined, item.dataset.value, undefined);
    });

    periodCol.addEventListener("click", (e) => {
      const item = e.target.closest(".ce-timepicker-item");
      if (item) updateValue(undefined, undefined, item.dataset.value);
    });

    input.addEventListener("click", () => {
      if (dropdown.hidden) openDropdown();
      else closeDropdown();
    });

    if (toggleBtn) {
      toggleBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (dropdown.hidden) openDropdown();
        else closeDropdown();
      });
    }

    wrap.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !dropdown.hidden) {
        closeDropdown();
        input.focus();
      }
    });

    document.addEventListener("click", (e) => {
      if (!wrap.contains(e.target)) {
        closeDropdown();
      }
    });
  }

  function setupCustomTimepickers() {
    attachCustomTimepicker("timeStart", "AM");
    attachCustomTimepicker("timeEnd", "PM");
  }

  function getDatesInRange(startDateStr, endDateStr) {
    if (!startDateStr) return [];
    const endStr = endDateStr || startDateStr;
    const [sy, sm, sd] = startDateStr.split("-").map(Number);
    const [ey, em, ed] = endStr.split("-").map(Number);
    const start = new Date(sy, sm - 1, sd);
    const end = new Date(ey, em - 1, ed);

    if (isNaN(start.getTime()) || isNaN(end.getTime()) || end < start) {
      return [startDateStr];
    }

    const dates = [];
    const curr = new Date(start);
    let count = 0;
    while (curr <= end && count < 60) {
      const y = curr.getFullYear();
      const m = String(curr.getMonth() + 1).padStart(2, "0");
      const d = String(curr.getDate()).padStart(2, "0");
      dates.push(`${y}-${m}-${d}`);
      curr.setDate(curr.getDate() + 1);
      count++;
    }
    return dates;
  }

  function renderDailyScheduleRows() {
    const listEl = document.getElementById("dailyScheduleList");
    if (!listEl) return;

    const form = document.getElementById("createEventMainForm");
    const dStart = form?.eventDate?.value;
    const dEnd = form?.eventDateEnd?.value || dStart;
    const dates = getDatesInRange(dStart, dEnd);

    if (dates.length === 0) {
      listEl.innerHTML = '<p class="ce-muted" style="padding: 12px 0;">Please select valid start and end dates.</p>';
      return;
    }

    const existing = {};
    listEl.querySelectorAll(".ce-daily-schedule-row").forEach((row) => {
      const dt = row.dataset.date;
      const s = row.querySelector(".ce-daily-start-input")?.value;
      const e = row.querySelector(".ce-daily-end-input")?.value;
      if (dt) existing[dt] = { start: s, end: e };
    });

    const defaultStart = form?.timeStart?.value || "08:00 AM";
    const defaultEnd = form?.timeEnd?.value || "08:00 PM";

    listEl.innerHTML = dates.map((dateStr, idx) => {
      const [y, m, d] = dateStr.split("-").map(Number);
      const dateObj = new Date(y, m - 1, d);
      const formattedDate = dateObj.toLocaleDateString("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
        year: "numeric"
      });

      const startVal = existing[dateStr]?.start || defaultStart;
      const endVal = existing[dateStr]?.end || defaultEnd;

      return `
        <div class="ce-daily-schedule-row" data-date="${dateStr}" id="dailyRow_${idx}">
          <div class="ce-daily-date-col">
            <span class="ce-daily-date-text">${escapeHTML(formattedDate)}</span>
          </div>

          <div class="ce-daily-time-col">
            <label for="dailyStart_${idx}" class="ce-daily-time-label">Start</label>
            <div class="ce-timepicker-wrap" id="picker-wrap-dailyStart_${idx}">
              <input type="text"
                     id="dailyStart_${idx}"
                     name="dailyStart_${idx}"
                     class="ce-timepicker-input ce-daily-start-input"
                     value="${escapeHTML(startVal)}"
                     readonly
                     required
                     placeholder="--:-- --"
                     aria-label="Start time for ${escapeHTML(formattedDate)}"
                     aria-expanded="false"
                     aria-haspopup="true">
              <button type="button" class="ce-timepicker-btn" id="btnToggle-dailyStart_${idx}" aria-label="Choose start time" tabindex="-1">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <circle cx="12" cy="12" r="10"></circle>
                  <polyline points="12 6 12 12 16 14"></polyline>
                </svg>
              </button>
              <div class="ce-timepicker-dropdown" id="dropdown-dailyStart_${idx}" hidden>
                <div class="ce-timepicker-cols">
                  <div class="ce-timepicker-col" data-col="hour" aria-label="Hours"></div>
                  <div class="ce-timepicker-col" data-col="minute" aria-label="Minutes"></div>
                  <div class="ce-timepicker-col" data-col="period" aria-label="Period"></div>
                </div>
              </div>
            </div>
          </div>

          <div class="ce-daily-time-col">
            <label for="dailyEnd_${idx}" class="ce-daily-time-label">End</label>
            <div class="ce-timepicker-wrap" id="picker-wrap-dailyEnd_${idx}">
              <input type="text"
                     id="dailyEnd_${idx}"
                     name="dailyEnd_${idx}"
                     class="ce-timepicker-input ce-daily-end-input"
                     value="${escapeHTML(endVal)}"
                     readonly
                     required
                     placeholder="--:-- --"
                     aria-label="End time for ${escapeHTML(formattedDate)}"
                     aria-expanded="false"
                     aria-haspopup="true">
              <button type="button" class="ce-timepicker-btn" id="btnToggle-dailyEnd_${idx}" aria-label="Choose end time" tabindex="-1">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <circle cx="12" cy="12" r="10"></circle>
                  <polyline points="12 6 12 16 14"></polyline>
                </svg>
              </button>
              <div class="ce-timepicker-dropdown" id="dropdown-dailyEnd_${idx}" hidden>
                <div class="ce-timepicker-cols">
                  <div class="ce-timepicker-col" data-col="hour" aria-label="Hours"></div>
                  <div class="ce-timepicker-col" data-col="minute" aria-label="Minutes"></div>
                  <div class="ce-timepicker-col" data-col="period" aria-label="Period"></div>
                </div>
              </div>
            </div>
          </div>
        </div>
      `;
    }).join("");

    dates.forEach((_, idx) => {
      attachCustomTimepicker(`dailyStart_${idx}`, "AM");
      attachCustomTimepicker(`dailyEnd_${idx}`, "PM");

      const sInp = document.getElementById(`dailyStart_${idx}`);
      const eInp = document.getElementById(`dailyEnd_${idx}`);
      if (sInp) sInp.addEventListener("input", () => {
        state.dirty = true;
        clearFieldError("dailySchedule");
        updateAllReadinessChecks();
        updateLivePreview();
      });
      if (eInp) eInp.addEventListener("input", () => {
        state.dirty = true;
        clearFieldError("dailySchedule");
        updateAllReadinessChecks();
        updateLivePreview();
      });
    });
  }

  function handleDailyScheduleToggle() {
    const sel = document.getElementById("dailySchedule");
    const wrapStart = document.getElementById("wrap-timeStart");
    const wrapEnd = document.getElementById("wrap-timeEnd");
    const wrapDaily = document.getElementById("wrap-dailyScheduleContainer");

    updateDailyScheduleAvailability();
    const isDifferent = sel?.value === "Different time by day";

    if (wrapStart) {
      wrapStart.hidden = isDifferent;
      wrapStart.style.display = isDifferent ? "none" : "";
    }
    if (wrapEnd) {
      wrapEnd.hidden = isDifferent;
      wrapEnd.style.display = isDifferent ? "none" : "";
    }
    if (wrapDaily) {
      wrapDaily.hidden = !isDifferent;
      wrapDaily.style.display = isDifferent ? "" : "none";
      if (isDifferent) {
        renderDailyScheduleRows();
      }
    }
    clearFieldError("dailySchedule");
    updateAllReadinessChecks();
    updateLivePreview();
  }

  function updateDailyScheduleAvailability() {
    const select = document.getElementById("dailySchedule");
    const startDate = document.getElementById("eventDate")?.value;
    const endDate = document.getElementById("eventDateEnd")?.value;
    if (!select) return;
    const isMultiDay = Boolean(startDate && endDate && endDate > startDate);
    select.disabled = !isMultiDay;
    select.classList.toggle("ce-input--auto-linked", !isMultiDay);
    if (!isMultiDay) select.value = "Same time each day";
  }

  function collectDailySchedules() {
    const list = [];
    const container = document.getElementById("dailyScheduleList");
    if (!container) return list;
    container.querySelectorAll(".ce-daily-schedule-row").forEach((row) => {
      const dt = row.dataset.date;
      const sInput = row.querySelector(".ce-daily-start-input");
      const eInput = row.querySelector(".ce-daily-end-input");
      const dtText = row.querySelector(".ce-daily-date-text")?.textContent || dt;
      if (dt) {
        list.push({
          date: dt,
          dateFormatted: dtText,
          timeStart: sInput?.value || "",
          timeEnd: eInput?.value || "",
        });
      }
    });
    return list;
  }

  // 17. Optional contact phone input
  function setupContactPhoneInput() {
    const input = document.getElementById("contactPhone");
    if (!input) return;

    input.addEventListener("input", () => {
      input.value = input.value.replace(/\D/g, "").slice(0, 11);
    });
  }

  // 18. Bullet Textarea Helper for Key Details and Requirements
  function setupBulletTextarea(id) {
    const textarea = document.getElementById(id);
    if (!textarea) return;

    if (!textarea.value.trim()) {
      textarea.value = "• ";
    }

    textarea.addEventListener("keydown", (e) => {
      const val = textarea.value;
      const selStart = textarea.selectionStart;
      const selEnd = textarea.selectionEnd;

      if (e.key === "Enter") {
        e.preventDefault();
        const before = val.substring(0, selStart);
        const after = val.substring(selEnd);
        const insert = "\n• ";
        textarea.value = before + insert + after;
        textarea.selectionStart = textarea.selectionEnd = selStart + insert.length;
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
      } else if (e.key === "Backspace") {
        const lineStart = val.lastIndexOf("\n", selStart - 1) + 1;
        const lineText = val.substring(lineStart, selStart);
        if (lineText === "• " && selStart === selEnd) {
          e.preventDefault();
          const before = val.substring(0, lineStart);
          const after = val.substring(selStart);
          textarea.value = before + after;
          textarea.selectionStart = textarea.selectionEnd = lineStart;
          textarea.dispatchEvent(new Event("input", { bubbles: true }));
        }
      }
    });

    textarea.addEventListener("paste", (e) => {
      e.preventDefault();
      const text = (e.clipboardData || window.clipboardData).getData("text") || "";
      const lines = text.split(/\r?\n/).map((l) => l.trim().replace(/^[•\-\*]\s*/, "")).filter(Boolean);
      const bulleted = lines.map((l) => "• " + l).join("\n");

      const val = textarea.value;
      const selStart = textarea.selectionStart;
      const selEnd = textarea.selectionEnd;

      if (val === "• " || !val.trim()) {
        textarea.value = bulleted || "• ";
        textarea.selectionStart = textarea.selectionEnd = textarea.value.length;
      } else {
        const before = val.substring(0, selStart);
        const after = val.substring(selEnd);
        textarea.value = before + (bulleted || "") + after;
        textarea.selectionStart = textarea.selectionEnd = selStart + (bulleted || "").length;
      }
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  // 19. No Numbers in Names Helper
  function setupNoNumbersInput(inputId, hintId) {
    const input = document.getElementById(inputId);
    const hint = document.getElementById(hintId);
    if (!input) return;

    let hintTimeout = null;
    function showBlockedHint() {
      if (!hint) return;
      hint.textContent = "Numbers are not allowed";
      hint.hidden = false;
      if (hintTimeout) clearTimeout(hintTimeout);
      hintTimeout = setTimeout(() => {
        hint.hidden = true;
      }, 2500);
    }

    input.addEventListener("beforeinput", (e) => {
      if (e.data && /\d/.test(e.data)) {
        e.preventDefault();
        showBlockedHint();
      }
    });

    input.addEventListener("input", () => {
      if (/\d/.test(input.value)) {
        input.value = input.value.replace(/\d+/g, "");
        showBlockedHint();
      }
    });

    input.addEventListener("paste", (e) => {
      const pasted = (e.clipboardData || window.clipboardData).getData("text") || "";
      if (/\d/.test(pasted)) {
        e.preventDefault();
        const cleaned = pasted.replace(/\d+/g, "");
        const start = input.selectionStart;
        const end = input.selectionEnd;
        const val = input.value;
        input.value = val.substring(0, start) + cleaned + val.substring(end);
        input.selectionStart = input.selectionEnd = start + cleaned.length;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        showBlockedHint();
      }
    });
  }

  // 20. Confirmation Modal Helper
  // Keep in sync with the other role's create event page.
  function showConfirmModal({ title, text, summaryHtml, explainerText, confirmText, cancelText, onConfirm, onCancel, checkboxText, requireCheckbox, triggerEl, isSubmittingRef }) {
    const modal = document.getElementById("ceConfirmModal");
    const titleEl = document.getElementById("confirmModalTitle");
    const textEl = document.getElementById("confirmModalText");
    const summaryEl = document.getElementById("confirmModalSummary");
    const explainerEl = document.getElementById("confirmModalExplainer");
    const primaryBtn = document.getElementById("confirmModalPrimaryBtn");
    const cancelBtn = document.getElementById("confirmModalCancelBtn");
    const checkboxWrap = document.getElementById("confirmModalCheckboxWrap");
    const checkbox = document.getElementById("confirmModalCheckbox");
    const checkboxTextEl = document.getElementById("confirmModalCheckboxText");

    if (!modal) return;

    if (titleEl) titleEl.textContent = title || "Confirm Action";
    if (textEl) {
      if (text) {
        textEl.textContent = text;
        textEl.style.display = "";
      } else {
        textEl.textContent = "";
        textEl.style.display = "none";
      }
    }

    if (summaryEl) {
      if (summaryHtml) {
        summaryEl.innerHTML = summaryHtml;
        summaryEl.style.display = "flex";
      } else {
        summaryEl.innerHTML = "";
        summaryEl.style.display = "none";
      }
    }

    if (explainerEl) {
      if (explainerText) {
        explainerEl.textContent = explainerText;
        explainerEl.style.display = "block";
      } else {
        explainerEl.textContent = "";
        explainerEl.style.display = "none";
      }
    }

    if (primaryBtn) primaryBtn.textContent = confirmText || "Confirm";
    if (cancelBtn) {
      if (cancelText === null) {
        cancelBtn.hidden = true;
      } else {
        cancelBtn.hidden = false;
        cancelBtn.textContent = cancelText || "Cancel";
      }
    }

    const needsCheckbox = Boolean(checkboxText || requireCheckbox);
    if (checkboxWrap) {
      if (needsCheckbox) {
        checkboxWrap.style.display = "block";
        if (checkbox) {
          checkbox.checked = false;
          checkbox.setAttribute("aria-required", "true");
        }
        if (checkboxTextEl && typeof checkboxText === "string") {
          checkboxTextEl.textContent = checkboxText;
        }
      } else {
        checkboxWrap.style.display = "none";
        if (checkbox) {
          checkbox.checked = false;
          checkbox.removeAttribute("aria-required");
        }
      }
    }
    if (primaryBtn) primaryBtn.disabled = false;

    modal.hidden = false;
    modal.classList.add("is-visible");

    // Keydown trap for focus and Escape
    const handleModalKeydown = (e) => {
      if (e.key === "Escape") {
        if (isSubmittingRef && isSubmittingRef()) return;
        e.preventDefault();
        e.stopPropagation();
        closeModal();
        if (typeof onCancel === "function") onCancel();
        return;
      }
      if (e.key === "Tab") {
        const focusable = modal.querySelectorAll('button:not([disabled]):not([hidden]), [href], input:not([disabled]):not([hidden]), [tabindex]:not([tabindex="-1"])');
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey) {
          if (document.activeElement === first) {
            e.preventDefault();
            last.focus();
          }
        } else {
          if (document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        }
      }
    };
    document.addEventListener("keydown", handleModalKeydown, true);

    if (needsCheckbox && checkbox) {
      checkbox.focus();
    } else if (cancelBtn && !cancelBtn.hidden) {
      cancelBtn.focus();
    } else {
      primaryBtn?.focus();
    }

    function closeModal() {
      document.removeEventListener("keydown", handleModalKeydown, true);
      modal.removeEventListener("click", handlePrimaryActionClick);
      modal.hidden = true;
      modal.classList.remove("is-visible");
      if (summaryEl) {
        summaryEl.innerHTML = "";
        summaryEl.style.display = "none";
      }
      if (explainerEl) {
        explainerEl.textContent = "";
        explainerEl.style.display = "none";
      }
      if (textEl) textEl.style.display = "";
      if (cancelBtn) cancelBtn.hidden = false;
      if (checkboxWrap) checkboxWrap.style.display = "none";
      if (checkbox) {
        checkbox.checked = false;
        checkbox.removeAttribute("aria-required");
        checkbox.onchange = null;
      }
      if (primaryBtn) {
        primaryBtn.disabled = false;
      }
      if (cancelBtn) cancelBtn.onclick = null;
      modal.onclick = null;
      if (triggerEl && typeof triggerEl.focus === "function") {
        try { triggerEl.focus(); } catch (e) {}
      }
    }

    if (checkbox && needsCheckbox) {
      checkbox.onchange = null;
    }

    let confirmationInProgress = false;
    const handlePrimaryActionClick = async (event) => {
      const clickedButton = event.target instanceof Element
        ? event.target.closest("#confirmModalPrimaryBtn")
        : null;
      if (clickedButton !== primaryBtn) return;
      event.preventDefault();
      if (confirmationInProgress) return;
      if (needsCheckbox && !checkbox?.checked) {
        alert("Please confirm that the event details are accurate before submitting.");
        checkbox?.focus();
        return;
      }

      confirmationInProgress = true;
      primaryBtn.disabled = true;
      try {
        if (typeof onConfirm === "function") {
          await onConfirm(closeModal);
        } else {
          closeModal();
        }
      } catch (error) {
        console.error("Could not complete confirmation action:", error);
        showToast(getFriendlyFunctionError(error, "Couldn't complete that action. Please try again."));
      } finally {
        if (!modal.hidden) {
          confirmationInProgress = false;
          primaryBtn.disabled = false;
        }
      }
    };
    modal.addEventListener("click", handlePrimaryActionClick);

    cancelBtn.onclick = () => {
      if (isSubmittingRef && isSubmittingRef()) return;
      closeModal();
      if (typeof onCancel === "function") onCancel();
    };

    modal.onclick = (e) => {
      if (e.target === modal) {
        if (isSubmittingRef && isSubmittingRef()) return;
        closeModal();
        if (typeof onCancel === "function") onCancel();
      }
    };
  }

  function removeHighlight(id) {
    if (state.highlightedFields.has(id)) {
      state.highlightedFields.delete(id);
      const wrap = document.getElementById(`wrap-${id}`);
      if (wrap) wrap.classList.remove("is-copied-highlight");
    }
  }

  function updateDescCounter() {
    const desc = document.getElementById("description");
    const counter = document.getElementById("descCharCounter");
    if (desc && counter) {
      counter.textContent = `${desc.value.length} / 1500`;
    }
  }

  function updateRationaleCounter() {
    const el = document.getElementById("rationale");
    const counter = document.getElementById("rationaleCharCounter");
    if (el && counter) {
      counter.textContent = `${el.value.length} / 1500`;
    }
  }

  function checkVenueCapacityHint() {
    const venueEl = document.getElementById("venue");
    const hint = document.getElementById("venueCapacityHint");
    const weatherEl = document.getElementById("weatherContingency");
    const capacityInput = document.getElementById("maxCapacity");
    if (!venueEl) return;

    const chosenVenue = (venueEl.value || "").trim();
    const venueRecord = VENUES_FLAT_MAP[chosenVenue];

    if (venueRecord && venueRecord.maxCapacity) {
      if (hint) hint.textContent = `Venue maximum capacity: ${venueRecord.maxCapacity} attendees.`;
      if (capacityInput) {
        capacityInput.disabled = false;
        capacityInput.max = String(venueRecord.maxCapacity);
      }
    } else {
      if (hint) hint.textContent = "Select a venue to view capacity limit.";
      if (capacityInput) {
        capacityInput.disabled = true;
        capacityInput.removeAttribute("max");
        capacityInput.value = "";
      }
    }

    if (weatherEl) {
      const type = venueRecord?.type ? String(venueRecord.type).toLowerCase() : "";
      if (type === "indoor") {
        weatherEl.value = "Indoor";
      } else if (type === "online") {
        weatherEl.value = "Online";
      } else if (type === "outdoor") {
        weatherEl.value = "Outdoor - It might rain or it might be too hot.";
      } else {
        weatherEl.value = "";
      }
      weatherEl.dispatchEvent(new Event("input", { bubbles: true }));
    }

    // Toggle conditional venue fields
    const wrapOutsideName = document.getElementById("wrap-customVenueName");
    const wrapOutsideAddr = document.getElementById("wrap-customVenueAddress");
    const wrapOnlineLink = document.getElementById("wrap-onlineMeetingLink");

    const vLower = chosenVenue.toLowerCase();
    const isOutside = vLower.includes("outside pup");
    const isInsideOther = vLower.includes("inside pup");
    const isCustomVenue = isOutside || isInsideOther;
    const isOnline = vLower.includes("online") || venueRecord?.type === "online";

    if (wrapOutsideName) {
      wrapOutsideName.hidden = !isCustomVenue;
      wrapOutsideName.style.display = isCustomVenue ? "" : "none";
      const lbl = wrapOutsideName.querySelector("label");
      const inp = document.getElementById("customVenueName");
      if (lbl) {
        lbl.innerHTML = isInsideOther ? 'Building <span class="ce-req">*</span>' : 'Venue Name <span class="ce-req">*</span>';
      }
      if (inp) {
        inp.placeholder = isInsideOther ? "e.g. Main Building" : "e.g. Grand Ballroom, Tagaytay Country Hotel";
      }
      if (!isCustomVenue) {
        clearFieldError("customVenueName");
      }
    }
    if (wrapOutsideAddr) {
      wrapOutsideAddr.hidden = !isCustomVenue;
      wrapOutsideAddr.style.display = isCustomVenue ? "" : "none";
      const lbl = wrapOutsideAddr.querySelector("label");
      const inp = document.getElementById("customVenueAddress");
      if (lbl) {
        lbl.innerHTML = isInsideOther ? 'Room Number <span class="ce-req">*</span>' : 'Exact Address <span class="ce-req">*</span>';
      }
      if (inp) {
        inp.placeholder = isInsideOther ? "e.g. Room 204" : "e.g. Aguinaldo Highway, Silang Junction North, Tagaytay City, Cavite";
      }
      if (!isCustomVenue) {
        clearFieldError("customVenueAddress");
      }
    }
    if (wrapOnlineLink) {
      wrapOnlineLink.hidden = !isOnline;
      wrapOnlineLink.style.display = isOnline ? "" : "none";
      if (!isOnline) {
        clearFieldError("onlineMeetingLink");
      }
    }

    renderAdminDocuments();
    updateAllReadinessChecks();
  }

  // 21. Check Duplicate Event Name against Past Events
  function checkDuplicateNameWarning() {
    const nameEl = document.getElementById("eventName");
    const notice = document.getElementById("duplicateNotice");
    if (!nameEl || !notice) return;

    const val = nameEl.value.trim().toLowerCase();
    if (val.length < 4) {
      notice.hidden = true;
      notice.textContent = "";
      return;
    }

    const past = loadCurrentUserEvents();
    const match = past.find((ev) => {
      const t = (ev.title || ev.eventName || "").toLowerCase().trim();
      return t === val && String(ev.id || ev.eventId) !== String(state.editingEventId || "");
    });

    if (match) {
      notice.textContent = `Note: You previously held an event titled "${match.title || match.eventName}". You may proceed or adjust the name.`;
      notice.hidden = false;
    } else {
      notice.hidden = true;
      notice.textContent = "";
    }
  }

  // 22. Check Holiday Notice on Selected Date
  async function checkDateHolidayNotice() {
    const dateEl = document.getElementById("eventDate");
    const notice = document.getElementById("holidayNotice");
    if (!dateEl || !notice) return;

    const val = dateEl.value;
    if (!val) {
      notice.hidden = true;
      notice.textContent = "";
      return;
    }

    try {
      let holidayFn = null;
      try {
        const mod = await import("../holidayService.js");
        holidayFn = mod.checkPhilippineHoliday;
      } catch (err) {
        // Fallback gracefully if module loading is restricted
      }
      if (holidayFn) {
        const res = await holidayFn(val);
        if (res && res.isHoliday) {
          notice.textContent = `Holiday Notice: ${res.holidayName || "Official Holiday"} falls on this date.`;
          notice.hidden = false;
          return;
        }
      }
      notice.hidden = true;
      notice.textContent = "";
    } catch {
      notice.hidden = true;
    }
  }

  // 23. Category Dropdown: Multi-Select with Checkboxes (1 to 3)
  function setupCategoryDropdown() {
    const btn = document.getElementById("catDropdownBtn");
    const menu = document.getElementById("catDropdownMenu");
    const textSpan = document.getElementById("catBtnText");
    if (!btn || !menu) return;

    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      state.categoryDropdownOpen = !state.categoryDropdownOpen;
      menu.classList.toggle("is-open", state.categoryDropdownOpen);
      btn.setAttribute("aria-expanded", String(state.categoryDropdownOpen));
    });

    document.addEventListener("click", (e) => {
      if (!menu.contains(e.target) && !btn.contains(e.target)) {
        state.categoryDropdownOpen = false;
        menu.classList.remove("is-open");
        btn.setAttribute("aria-expanded", "false");
      }
    });

    const checkboxes = menu.querySelectorAll(".ce-cat-checkbox");

    function updateLabelAndCount() {
      const selected = Array.from(checkboxes)
        .filter((c) => c.checked)
        .map((c) => c.value);

      state.selectedCategories = selected;

      checkboxes.forEach((cb) => {
        if (!cb.checked && selected.length >= 3) {
          cb.disabled = true;
          cb.parentElement.classList.add("is-disabled");
        } else {
          cb.disabled = false;
          cb.parentElement.classList.remove("is-disabled");
        }
      });

      if (selected.length === 0) {
        textSpan.textContent = "Select 1 to 3 categories...";
      } else {
        textSpan.textContent = `${selected.join(", ")} (${selected.length}/3)`;
      }

      state.dirty = true;
      clearFieldError("category");
      removeHighlight("category");
      updateAllReadinessChecks();
      updateLivePreview();
    }

    checkboxes.forEach((cb) => {
      cb.addEventListener("change", () => {
        updateLabelAndCount();
      });
    });

    updateLabelAndCount();
  }

  // 24. Participating Faculty Members: Searchable Chips (Optional)
  function setupFacultyChipsInput() {
    const input = document.getElementById("facultySearchInput");
    const suggestions = document.getElementById("facultySuggestions");
    if (!input || !suggestions) return;

    let activeSuggestionIndex = -1;

    function renderSuggestions(queryText) {
      const q = String(queryText || "").trim().toLowerCase();
      const allFaculty = loadFacultyPool();

      let matches = [];
      if (!q) {
        matches = allFaculty.filter((f) => {
          return !state.participatingFaculty.some((pf) => pf.id === f.id || pf.name.toLowerCase() === f.name.toLowerCase());
        }).slice(0, 8);
      } else {
        matches = allFaculty.filter((f) => {
          const notAdded = !state.participatingFaculty.some((pf) => pf.id === f.id || pf.name.toLowerCase() === f.name.toLowerCase());
          const matchName = f.name && f.name.toLowerCase().includes(q);
          const matchEmail = f.email && f.email.toLowerCase().includes(q);
          const matchDept = f.department && f.department.toLowerCase().includes(q);
          return notAdded && (matchName || matchEmail || matchDept);
        }).slice(0, 8);
      }

      activeSuggestionIndex = -1;

      if (matches.length === 0) {
        if (q) {
          suggestions.innerHTML = `
            <div class="ce-chip-suggestion-empty" style="padding: 10px 14px; color: #8a7c73; font-size: 13px;">
              No teachers found in database. Press Enter to add &ldquo;${escapeHTML(input.value.trim())}&rdquo;
            </div>
          `;
          suggestions.hidden = false;
          suggestions.classList.add("is-open");
        } else {
          suggestions.hidden = true;
          suggestions.classList.remove("is-open");
          suggestions.innerHTML = "";
        }
        return;
      }

      suggestions.innerHTML = matches.map((f, idx) => `
        <div class="ce-chip-suggestion-item" data-item-idx="${idx}" data-faculty-id="${escapeHTML(f.id)}" data-faculty-name="${escapeHTML(f.name)}" data-faculty-email="${escapeHTML(f.email || "")}" data-faculty-dept="${escapeHTML(f.department || "")}">
          <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px;">
            <strong>${escapeHTML(f.name)}</strong>
            <span style="font-size: 11px; padding: 2px 6px; border-radius: 4px; background: #f4efe4; color: #701219; font-weight: 600;">Faculty</span>
          </div>
          <small style="color: #6b7280; font-size: 12px; margin-top: 2px; display: block;">
            ${f.department ? escapeHTML(f.department) + " • " : ""}${escapeHTML(f.email || "Faculty")}
          </small>
        </div>
      `).join("");

      suggestions.hidden = false;
      suggestions.classList.add("is-open");

      suggestions.querySelectorAll(".ce-chip-suggestion-item").forEach((item) => {
        item.addEventListener("click", () => {
          addFacultyChip({
            id: item.dataset.facultyId,
            name: item.dataset.facultyName,
            email: item.dataset.facultyEmail,
            department: item.dataset.facultyDept,
          });
          input.value = "";
          suggestions.hidden = true;
          suggestions.classList.remove("is-open");
          suggestions.innerHTML = "";
          input.focus();
        });
      });
    }

    input.addEventListener("focus", () => {
      renderSuggestions(input.value);
    });

    input.addEventListener("input", () => {
      renderSuggestions(input.value);
    });

    input.addEventListener("keydown", (e) => {
      const items = suggestions.querySelectorAll(".ce-chip-suggestion-item");
      if (e.key === "ArrowDown") {
        e.preventDefault();
        if (items.length > 0) {
          activeSuggestionIndex = (activeSuggestionIndex + 1) % items.length;
          items.forEach((it, i) => it.classList.toggle("is-active", i === activeSuggestionIndex));
          items[activeSuggestionIndex]?.scrollIntoView({ block: "nearest" });
        }
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        if (items.length > 0) {
          activeSuggestionIndex = (activeSuggestionIndex - 1 + items.length) % items.length;
          items.forEach((it, i) => it.classList.toggle("is-active", i === activeSuggestionIndex));
          items[activeSuggestionIndex]?.scrollIntoView({ block: "nearest" });
        }
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (activeSuggestionIndex >= 0 && items[activeSuggestionIndex]) {
          items[activeSuggestionIndex].click();
        } else if (items.length > 0 && input.value.trim()) {
          items[0].click();
        } else if (input.value.trim()) {
          const customName = input.value.trim().replace(/\d+/g, "");
          if (customName) {
            addFacultyChip({
              id: "custom-" + Date.now(),
              name: customName,
              email: "Faculty Member",
              department: "Faculty",
            });
            input.value = "";
            suggestions.hidden = true;
            suggestions.classList.remove("is-open");
          }
        }
      } else if (e.key === "Escape") {
        suggestions.hidden = true;
        suggestions.classList.remove("is-open");
      }
    });

    document.addEventListener("click", (e) => {
      if (!input.contains(e.target) && !suggestions.contains(e.target)) {
        suggestions.hidden = true;
        suggestions.classList.remove("is-open");
      }
    });

    renderFacultyChipsList();
  }

  function addFacultyChip(facultyObj) {
    if (!facultyObj || !facultyObj.name) return;
    if (state.participatingFaculty.some((f) => f.name.toLowerCase() === facultyObj.name.toLowerCase())) {
      return;
    }
    state.participatingFaculty.push(facultyObj);
    state.dirty = true;
    renderFacultyChipsList();
    updateLivePreview();
  }

  function removeFacultyChip(index) {
    state.participatingFaculty.splice(index, 1);
    state.dirty = true;
    renderFacultyChipsList();
    updateLivePreview();
  }

  function renderFacultyChipsList() {
    const list = document.getElementById("facultyChipsList");
    if (!list) return;

    list.innerHTML = state.participatingFaculty.map((f, idx) => `
      <div class="ce-chip" data-chip-index="${idx}">
        <span class="ce-chip-label">${escapeHTML(f.name)}</span>
        <button type="button" class="ce-chip-remove" aria-label="Remove ${escapeHTML(f.name)}" data-remove-idx="${idx}">✕</button>
      </div>
    `).join("");

    list.querySelectorAll(".ce-chip-remove").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        removeFacultyChip(parseInt(btn.dataset.removeIdx, 10));
      });
    });
  }

  function renderTargetSectionTags() {
    const list = document.getElementById("targetSectionsList");
    if (!list) return;

    list.innerHTML = state.targetSections.map((section, index) => `
      <div class="ce-chip" data-section-index="${index}">
        <span class="ce-chip-label">${escapeHTML(section)}</span>
        <button type="button" class="ce-chip-remove" aria-label="Remove section ${escapeHTML(section)}" data-remove-section-idx="${index}">✕</button>
      </div>
    `).join("");

    list.querySelectorAll(".ce-chip-remove").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        const index = Number(button.dataset.removeSectionIdx);
        if (!Number.isInteger(index) || index < 0 || index >= state.targetSections.length) return;
        state.targetSections.splice(index, 1);
        state.dirty = true;
        clearFieldError("targetSections");
        renderTargetSectionTags();
        updateLivePreview();
      });
    });
  }

  function addTargetSectionTags(value) {
    const sections = String(value || "")
      .split(/[,\n]/)
      .map((section) => section.trim())
      .filter(Boolean);
    let added = false;
    sections.forEach((section) => {
      if (state.targetSections.some((existing) => existing.toLowerCase() === section.toLowerCase())) return;
      state.targetSections.push(section);
      added = true;
    });
    if (added) {
      state.dirty = true;
      clearFieldError("targetSections");
      renderTargetSectionTags();
      updateLivePreview();
    }
    return added;
  }

  // Helper to render partner organizations list
  function renderPartnerOrgList() {
    const list = document.getElementById("partnerOrgList");
    if (!list) return;

    if (!state.partnerOrganizations || state.partnerOrganizations.length === 0) {
      list.innerHTML = "";
      return;
    }

    list.innerHTML = state.partnerOrganizations.map((org) => {
      const initial = (org.name || "P").charAt(0).toUpperCase();
      const currentRole = org.role || "Co-Organizer";
      return `
        <div class="ce-partner-item" data-partner-id="${escapeHTML(org.id)}">
          <div class="ce-partner-info">
            <div class="ce-partner-avatar">${escapeHTML(initial)}</div>
            <div class="ce-partner-texts">
              <span class="ce-partner-name">${escapeHTML(org.name)}</span>
              <span class="ce-partner-subtitle-text">${escapeHTML(org.subtitle || "")}</span>
            </div>
          </div>
          <div class="ce-partner-actions">
            <select class="ce-partner-item-role" data-partner-id="${escapeHTML(org.id)}" aria-label="Change role for ${escapeHTML(org.name)}">
              <option value="Co-Organizer" ${currentRole === "Co-Organizer" ? "selected" : ""}>Co-Organizer</option>
              <option value="Sponsor" ${currentRole === "Sponsor" ? "selected" : ""}>Sponsor</option>
              <option value="Partner" ${currentRole === "Partner" ? "selected" : ""}>Partner</option>
            </select>
            <button type="button" class="ce-partner-remove-btn" data-partner-id="${escapeHTML(org.id)}" aria-label="Remove ${escapeHTML(org.name)}">✕</button>
          </div>
        </div>
      `;
    }).join("");

    list.querySelectorAll(".ce-partner-item-role").forEach((select) => {
      select.addEventListener("change", (e) => {
        const id = select.dataset.partnerId;
        const targetOrg = state.partnerOrganizations.find((o) => o.id === id);
        if (targetOrg) {
          targetOrg.role = e.target.value;
          state.dirty = true;
        }
      });
    });

    list.querySelectorAll(".ce-partner-remove-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.partnerId;
        state.partnerOrganizations = state.partnerOrganizations.filter((o) => o.id !== id);
        syncPartnerTargetDepartments();
        state.dirty = true;
        renderPartnerOrgList();
      });
    });
  }

  // Helper to render external guests list
  function renderExternalGuestCards() {
    const list = document.getElementById("externalGuestsList");
    if (!list) return;

    if (!state.externalGuests || state.externalGuests.length === 0) {
      list.innerHTML = "";
      updateOutsideGuestsStatus();
      return;
    }

    list.innerHTML = state.externalGuests.map((guest, idx) => `
      <div class="ce-guest-card" data-guest-idx="${idx}">
        <div class="ce-guest-card-header">
          <h4 class="ce-guest-card-title">Guest ${idx + 1}</h4>
          <button type="button" class="ce-guest-remove-btn" data-guest-idx="${idx}" aria-label="Remove Guest ${idx + 1}">✕</button>
        </div>
        <div class="ce-guest-card-grid">
          <div class="ce-field">
            <label class="ce-label">Full name <span class="ce-req" style="color:#dc2626;">*</span></label>
            <input type="text" class="ce-guest-input ce-guest-name" data-guest-idx="${idx}" value="${escapeHTML(guest.name || "")}" placeholder="" maxlength="100" required>
          </div>
          <div class="ce-field">
            <label class="ce-label">Organization / company</label>
            <input type="text" class="ce-guest-input ce-guest-org" data-guest-idx="${idx}" value="${escapeHTML(guest.organization || "")}" placeholder="Affiliation" maxlength="100">
          </div>
          <div class="ce-field">
            <label class="ce-label">Email / contact</label>
            <input type="text" class="ce-guest-input ce-guest-email" data-guest-idx="${idx}" value="${escapeHTML(guest.email || "")}" placeholder="Email or phone number" maxlength="100" required>
          </div>
          <div class="ce-field">
            <label class="ce-label">Role / topic</label>
            <input type="text" class="ce-guest-input ce-guest-role" data-guest-idx="${idx}" value="${escapeHTML(guest.role || "")}" placeholder="Keynote speaker, judge..." maxlength="50" required>
          </div>
          <div class="ce-field ce-field--full" style="grid-column: span 2;">
            <label class="ce-label">Guest access needs</label>
            <textarea class="ce-guest-input ce-guest-access" data-guest-idx="${idx}" rows="2" maxlength="500" placeholder="Visitor access, equipment, parking, etc.">${escapeHTML(guest.accessNeeds || "")}</textarea>
          </div>
        </div>
      </div>
    `).join("");

    list.querySelectorAll(".ce-guest-remove-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const idx = parseInt(btn.dataset.guestIdx, 10);
        if (!isNaN(idx) && idx >= 0 && idx < state.externalGuests.length) {
          state.externalGuests.splice(idx, 1);
          state.dirty = true;
          renderExternalGuestCards();
        }
      });
    });

    list.querySelectorAll(".ce-guest-name").forEach((input) => {
      input.addEventListener("input", (e) => {
        const idx = parseInt(input.dataset.guestIdx, 10);
        if (state.externalGuests[idx]) {
          state.externalGuests[idx].name = e.target.value;
          state.dirty = true;
        }
      });
    });

    list.querySelectorAll(".ce-guest-org").forEach((input) => {
      input.addEventListener("input", (e) => {
        const idx = parseInt(input.dataset.guestIdx, 10);
        if (state.externalGuests[idx]) {
          state.externalGuests[idx].organization = e.target.value;
          state.dirty = true;
        }
      });
    });

    list.querySelectorAll(".ce-guest-email").forEach((input) => {
      input.addEventListener("input", (e) => {
        const idx = parseInt(input.dataset.guestIdx, 10);
        if (state.externalGuests[idx]) {
          state.externalGuests[idx].email = e.target.value;
          state.dirty = true;
        }
      });
    });

    list.querySelectorAll(".ce-guest-role").forEach((input) => {
      input.addEventListener("input", (e) => {
        const idx = parseInt(input.dataset.guestIdx, 10);
        if (state.externalGuests[idx]) {
          state.externalGuests[idx].role = e.target.value;
          state.dirty = true;
        }
      });
    });

    list.querySelectorAll(".ce-guest-access").forEach((input) => {
      input.addEventListener("input", (e) => {
        const idx = parseInt(input.dataset.guestIdx, 10);
        if (state.externalGuests[idx]) {
          state.externalGuests[idx].accessNeeds = e.target.value;
          state.dirty = true;
        }
      });
    });

    updateOutsideGuestsStatus();
  }

  function updateOutsideGuestsStatus() {
    const hasExternal = Boolean(state.externalGuests && state.externalGuests.length > 0);
    state.outsideGuests = hasExternal;
    const outsideCheckbox = document.getElementById("outsideGuests");
    if (outsideCheckbox) {
      outsideCheckbox.checked = hasExternal;
    }
  }

  function setupAudienceAndCollaboration() {
    const targetAudienceSelect = document.getElementById("targetAudience");
    const targetAudienceDetails = document.getElementById("targetAudienceDetails");
    const targetSectionsInput = document.getElementById("targetSections");
    renderTargetSectionTags();
    if (targetSectionsInput) {
      const commitTargetSections = () => {
        if (!targetSectionsInput.value.trim()) return;
        addTargetSectionTags(targetSectionsInput.value);
        targetSectionsInput.value = "";
      };
      targetSectionsInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === ",") {
          event.preventDefault();
          commitTargetSections();
        }
      });
      targetSectionsInput.addEventListener("input", () => {
        if (/[,\n]/.test(targetSectionsInput.value)) commitTargetSections();
      });
      targetSectionsInput.addEventListener("blur", commitTargetSections);
    }
    if (targetAudienceSelect) {
      state.targetAudience = normalizeTargetAudience(state.targetAudience || targetAudienceSelect.value);
      targetAudienceSelect.value = state.targetAudience;
    }

    const isCollabCheckbox = document.getElementById("isCollaboration");
    const partnerBody = document.getElementById("partnerBody");
    const departmentInputs = [...document.querySelectorAll(".ce-target-department")];
    let previousDepartmentSelection = null;
    let lastAudience = "";
    const updateAudienceControls = () => {
      state.targetAudience = normalizeTargetAudience(targetAudienceSelect?.value);
      const needsAudienceDetails = state.targetAudience !== "Open to All";
      if (targetAudienceDetails) targetAudienceDetails.hidden = !needsAudienceDetails;

      const organizationMembersOnly = state.targetAudience === "Organization Members Only";
      if (organizationMembersOnly) {
        if (lastAudience !== "Organization Members Only") {
          previousDepartmentSelection = departmentInputs
            .filter((input) => input.checked)
            .map((input) => input.value);
        }
        const organizingDepartments = getAssociatedOrganizationDepartments();
        departmentInputs.forEach((input) => {
          if (organizingDepartments.has(input.value)) {
            if (state.partnerOrganizations.some(
              (organization) => getPartnerOrganizationDepartment(organization) === input.value,
            ) && input.value !== getOrganizingDepartment()) {
              autoPartnerTargetDepartments.add(input.value);
            }
            input.checked = true;
          } else if (autoPartnerTargetDepartments.has(input.value)) {
            input.checked = false;
            autoPartnerTargetDepartments.delete(input.value);
          }
          input.disabled = true;
        });
      } else {
        if (lastAudience === "Organization Members Only" && previousDepartmentSelection) {
          departmentInputs.forEach((input) => {
            input.checked = previousDepartmentSelection.includes(input.value);
          });
        }
        departmentInputs.forEach((input) => {
          input.disabled = false;
        });
        previousDepartmentSelection = null;
      }

      syncPartnerTargetDepartments();
      const departments = departmentInputs
        .filter((input) => input.checked)
        .map((input) => input.value);
      const yearLevels = [...document.querySelectorAll(".ce-target-year:checked")]
        .map((input) => input.value);
      state.targetDepartments = needsAudienceDetails ? departments : [];
      state.targetYearLevels = needsAudienceDetails ? yearLevels : [];
      if (!needsAudienceDetails) {
        state.targetSections = [];
        renderTargetSectionTags();
      }
      const allYears = document.getElementById("targetAllYears");
      if (allYears) allYears.checked = yearLevels.length === 0;
      const legacyYearField = document.getElementById("targetYear");
      if (legacyYearField) legacyYearField.value = needsAudienceDetails
        ? yearLevels.join(", ") || "All Levels"
        : "All Levels";

      if (state.targetAudience === "Mixed Audience" && isCollabCheckbox && !isCollabCheckbox.checked) {
        isCollabCheckbox.checked = true;
        state.isCollaboration = true;
      }
      if (isCollabCheckbox && partnerBody) {
        partnerBody.style.display = isCollabCheckbox.checked ? "" : "none";
      }
      updateOutsideGuestsStatus();
      lastAudience = state.targetAudience;
    };

    if (targetAudienceSelect) {
      targetAudienceSelect.addEventListener("change", () => {
        state.dirty = true;
        clearFieldError("targetDepartments");
        updateAudienceControls();
      });
    }

    document.querySelectorAll(".ce-target-department, .ce-target-year, #targetAllYears")
      .forEach((input) => {
        input.addEventListener("change", () => {
          if (input.id === "targetAllYears" && input.checked) {
            document.querySelectorAll(".ce-target-year").forEach((yearInput) => {
              yearInput.checked = false;
            });
          } else if (input.classList.contains("ce-target-year") && input.checked) {
            const allYears = document.getElementById("targetAllYears");
            if (allYears) allYears.checked = false;
          }
          state.dirty = true;
          updateAudienceControls();
        });
      });
    if (isCollabCheckbox) {
      isCollabCheckbox.checked = Boolean(state.isCollaboration);
      if (partnerBody) {
        partnerBody.style.display = isCollabCheckbox.checked ? "" : "none";
      }
      isCollabCheckbox.addEventListener("change", (e) => {
        if (state.targetAudience === "Mixed Audience" && !e.target.checked) {
          e.target.checked = true;
          state.isCollaboration = true;
          return;
        }
        state.isCollaboration = Boolean(e.target.checked);
        state.dirty = true;
        if (partnerBody) {
          partnerBody.style.display = state.isCollaboration ? "" : "none";
        }
      });
    }

    const btnAddPartner = document.getElementById("btnAddPartner");
    const partnerOrgSelect = document.getElementById("partnerOrgSelect");
    const partnerRoleSelect = document.getElementById("partnerRoleSelect");
    if (btnAddPartner && partnerOrgSelect) {
      btnAddPartner.addEventListener("click", () => {
        const orgInfo = getCanonicalPartnerOrganization(partnerOrgSelect.value);
        if (!orgInfo) return;
        const selectedId = orgInfo.id;

        const role = partnerRoleSelect?.value || "Co-Organizer";
        const existing = state.partnerOrganizations.find(
          (organization) =>
            getCanonicalPartnerOrganization(organization.id || organization.name)?.id === selectedId,
        );
        if (existing) {
          existing.id = orgInfo.id;
          existing.name = orgInfo.name;
          existing.subtitle = orgInfo.subtitle;
          existing.role = role;
        } else {
          state.partnerOrganizations.push({
            id: orgInfo.id,
            name: orgInfo.name,
            subtitle: orgInfo.subtitle,
            role,
          });
        }
        syncPartnerTargetDepartments();
        state.dirty = true;
        partnerOrgSelect.value = "";
        renderPartnerOrgList();
      });
    }

    const collabNotes = document.getElementById("collaborationNotes");
    if (collabNotes) {
      if (state.collaborationNotes) {
        collabNotes.value = state.collaborationNotes;
      }
      collabNotes.addEventListener("input", (e) => {
        state.collaborationNotes = e.target.value;
        state.dirty = true;
      });
    }

    const btnAddGuest = document.getElementById("btnAddGuest");
    if (btnAddGuest) {
      btnAddGuest.addEventListener("click", () => {
        state.externalGuests.push({
          id: `guest-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          name: "",
          organization: "",
          email: "",
          role: "",
          accessNeeds: "",
        });
        state.dirty = true;
        renderExternalGuestCards();
        const inputs = document.querySelectorAll("#externalGuestsList .ce-guest-name");
        if (inputs.length > 0) {
          inputs[inputs.length - 1].focus();
        }
      });
    }

    renderPartnerOrgList();
    renderExternalGuestCards();
    updateAudienceControls();
  }

  function collectExternalGuests() {
    const list = document.querySelectorAll("#externalGuestsList .ce-guest-card");
    if (!list || list.length === 0) return [...state.externalGuests];
    const results = [];
    list.forEach((card, idx) => {
      const name = card.querySelector(".ce-guest-name")?.value.trim() || "";
      const org = card.querySelector(".ce-guest-org")?.value.trim() || "";
      const email = card.querySelector(".ce-guest-email")?.value.trim() || "";
      const role = card.querySelector(".ce-guest-role")?.value.trim() || "";
      const access = card.querySelector(".ce-guest-access")?.value.trim() || "";
      results.push({
        id: state.externalGuests[idx]?.id || `guest-${idx + 1}`,
        name,
        organization: org,
        email,
        role,
        accessNeeds: access,
      });
    });
    state.externalGuests = results;
    return results;
  }

  const ADMIN_DOCUMENT_TYPES = [
    { key: "adminReview" },
  ];

  function isGoogleDriveLink(value) {
    try {
      const url = new URL(String(value || "").trim());
      if (url.protocol !== "https:") return false;
      const host = url.hostname.toLowerCase();
      const path = url.pathname;
      if (host === "drive.google.com") {
        return /\/(?:file\/d|folders)\/[^/]+/.test(path) ||
          /\/drive\/(?:u\/\d+\/)?folders\/[^/]+/.test(path) ||
          (/\/(?:open|uc)$/.test(path) && Boolean(url.searchParams.get("id")));
      }
      return host === "docs.google.com" &&
        (/\/(?:document|spreadsheets|presentation)\/(?:u\/\d+\/)?d\/[^/]+/.test(path) ||
          /\/forms\/(?:u\/\d+\/)?d\/(?:e\/)?[^/]+/.test(path));
    } catch {
      return false;
    }
  }

  function getAdminDocumentLinks(eventData) {
    return { adminReview: getAdminDocsLink(eventData) };
  }

  function getAdminDocsLink(eventData) {
    const sources = [
      eventData?.adminDocuments,
      eventData?.approvalDocuments,
      eventData?.adminDocsLink,
    ];
    const findLink = (value) => {
      if (typeof value === "string") return isGoogleDriveLink(value) ? value : "";
      if (Array.isArray(value)) return value.map(findLink).find(Boolean) || "";
      if (!value || typeof value !== "object") return "";
      const directLink = value.url || value.href || value.path || value.downloadURL || value.downloadUrl || "";
      if (isGoogleDriveLink(directLink)) return directLink;
      return Object.values(value).map(findLink).find(Boolean) || "";
    };
    return sources.map(findLink).find(Boolean) || "";
  }

  function getParticipantDocumentUrls(value) {
    const records = Array.isArray(value) ? value : value ? [value] : [];
    return records.flatMap((record) => {
      if (typeof record === "string") return record.split(/\r?\n/).map((url) => url.trim()).filter(Boolean);
      if (!record || typeof record !== "object") return [];
      const url = record.url || record.href || record.downloadURL || record.downloadUrl || record.fileUrl || "";
      return url ? [String(url).trim()] : [];
    });
  }

  function syncParticipantDocumentLinks() {
    const input = document.getElementById("participantDocsLinks");
    const url = input?.value.trim() || "";
    state.participantDocumentLink = input?.value || "";
    state.participantDocs = [
      ...state.legacyParticipantDocs,
      ...(url ? [{
        name: "Participant Documents",
        url,
        type: "Google Drive",
      }] : []),
    ];
  }

  function renderAdminDocuments() {
    const container = document.getElementById("adminDocsList");
    if (!container) return;

    container.innerHTML = ADMIN_DOCUMENT_TYPES.map(({ key }) => `
      <div class="ce-field ce-field--full" id="wrap-adminDoc-${key}">
        <label for="adminDoc-${key}">Google Drive folder/document link <span class="ce-req">*</span></label>
        <input id="adminDoc-${key}"
               name="adminDoc-${key}"
               type="url"
               pattern="^https:\\/\\/(drive|docs)\\.google\\.com\\/.*$"
               placeholder="https://drive.google.com/..."
               required
               aria-describedby="hint-adminDoc-${key} error-adminDoc-${key}">
        <small class="ce-hint" id="hint-adminDoc-${key}">Use one folder/document link for the Concept Paper, Program Flow, and Permission to Conduct Activity. Access: “Anyone with the link can view”.</small>
        <p class="ce-error" id="error-adminDoc-${key}" hidden></p>
      </div>
    `).join("");
    ADMIN_DOCUMENT_TYPES.forEach(({ key }) => {
      const input = document.getElementById(`adminDoc-${key}`);
      if (!input) return;
      input.value = state.adminDocumentLinks[key] || "";
      input.addEventListener("input", () => {
        state.adminDocumentLinks[key] = input.value.trim();
        state.adminDocsLink = state.adminDocumentLinks.adminReview;
        state.dirty = true;
        clearFieldError(`adminDoc-${key}`);
        updateAllReadinessChecks();
      });
    });
  }

  // 25. Reusable Drag & Drop File Upload Component
  const dropzoneInstances = new Map();

  function setupDropzone(configOrKey, dropzoneId, inputId, legacyIsRequired) {
    let config = {};
    if (typeof configOrKey === "string") {
      // Backward compatibility signature: (stateKey, dropzoneId, inputId, legacyIsRequired)
      config = {
        stateKey: configOrKey,
        dropzoneId,
        inputId,
        errorId: `error-${configOrKey}`,
        isRequired: Boolean(legacyIsRequired),
        reqMsgId: configOrKey === "approvalDocs" ? "reqMsgApproval" : null,
        reqStarId: configOrKey === "approvalDocs" ? "reqStarApproval" : null,
        maxFiles: 5,
        maxSizeBytes: 10 * 1024 * 1024,
        helperText: configOrKey === "approvalDocs"
          ? "Letter of request, activity approval, endorsements (min 1 required)"
          : "PDF, DOC, DOCX, JPG, PNG up to 10MB (max 5)",
      };
    } else {
      config = { ...configOrKey };
    }

    const {
      stateKey,
      dropzoneId: zId,
      inputId: inId,
      errorId,
      isRequired = false,
      reqMsgId = null,
      reqStarId = null,
      maxFiles = 5,
      maxSizeBytes = 10 * 1024 * 1024,
      allowedExtensions = [".pdf", ".doc", ".docx", ".jpg", ".jpeg", ".png"],
      helperText = "PDF, DOC, DOCX, JPG, PNG up to 10MB (max 5)",
    } = config;

    const zone = document.getElementById(zId);
    const input = document.getElementById(inId);
    const errorEl = document.getElementById(errorId);
    const reqMsgEl = reqMsgId ? document.getElementById(reqMsgId) : null;
    const reqStarEl = reqStarId ? document.getElementById(reqStarId) : null;
    const wrapEl = document.getElementById(`wrap-${stateKey}`);

    if (!zone || !input) return null;

    function getFiles() {
      if (!Array.isArray(state[stateKey])) {
        state[stateKey] = [];
      }
      return state[stateKey];
    }

    function setInlineError(msg) {
      if (errorEl) {
        errorEl.textContent = msg;
        errorEl.hidden = false;
      }
    }

    function clearInlineError() {
      if (errorEl) {
        errorEl.textContent = "";
        errorEl.hidden = true;
      }
      if (wrapEl) wrapEl.classList.remove("has-error");
      zone.classList.remove("has-error");
    }

    function updateRequiredIndicators() {
      if (!isRequired) return;
      const count = getFiles().length;
      const hasFiles = count >= 1;
      if (reqMsgEl) {
        reqMsgEl.hidden = hasFiles;
        reqMsgEl.style.display = hasFiles ? "none" : "block";
      }
      if (reqStarEl) {
        reqStarEl.hidden = hasFiles;
        reqStarEl.style.display = hasFiles ? "none" : "inline";
      }
    }

    function render() {
      updateRequiredIndicators();
      const files = getFiles();
      if (files.length === 0) {
        renderEmpty();
      } else {
        renderPopulated(files);
      }
    }

    function renderEmpty() {
      zone.classList.remove("has-files");
      zone.setAttribute("tabindex", "0");
      zone.setAttribute("role", "button");
      zone.setAttribute("aria-label", isRequired ? "Upload approval documents" : "Upload participant documents");

      zone.innerHTML = `
        <div class="ce-dropzone-empty">
          <svg class="ce-dropzone-icon" width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="17 8 12 3 7 8"/>
            <line x1="12" y1="3" x2="12" y2="15"/>
          </svg>
          <p class="ce-dropzone-text"><strong>Drag & drop</strong> or <span class="ce-link-browse">browse files</span></p>
          <p class="ce-dropzone-subtext">${escapeHTML(helperText)}</p>
        </div>
      `;

      const emptyArea = zone.querySelector(".ce-dropzone-empty");
      if (emptyArea) {
        emptyArea.addEventListener("click", () => {
          input.click();
        });
      }
    }

    function renderPopulated(files) {
      zone.classList.add("has-files");
      zone.removeAttribute("role");
      zone.removeAttribute("tabindex");

      const isMax = files.length >= maxFiles;
      const counterText = `${files.length} / ${maxFiles} files`;

      zone.innerHTML = `
        <div class="ce-dropzone-populated">
          <div class="ce-dropzone-header">
            <span class="ce-dropzone-counter ${isMax ? 'is-max' : ''}">
              ${counterText}${isMax ? ' (Maximum reached)' : ''}
            </span>
            ${!isMax ? '<span class="ce-dropzone-drag-hint">Drag & drop to add more</span>' : ''}
          </div>

          <div class="ce-files-inside-list" role="list">
            ${files.map((file) => renderRowHtml(file)).join("")}
          </div>

          <div class="ce-dropzone-actions">
            <button type="button"
                    class="ce-btn-add-more"
                    ${isMax ? 'disabled aria-disabled="true" style="display: none;"' : ''}
                    aria-label="Add more files">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                <path d="M8 2a.75.75 0 0 1 .75.75v4.5h4.5a.75.75 0 0 1 0 1.5h-4.5v4.5a.75.75 0 0 1-1.5 0v-4.5h-4.5a.75.75 0 0 1 0-1.5h4.5v-4.5A.75.75 0 0 1 8 2z"/>
              </svg>
              <span>+ Add more</span>
            </button>
          </div>
        </div>
      `;

      const addMoreBtn = zone.querySelector(".ce-btn-add-more");
      if (addMoreBtn && !isMax) {
        addMoreBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          input.click();
        });
      }

      zone.querySelectorAll(".ce-file-remove").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          const removeId = btn.dataset.removeId;
          removeFile(removeId);
        });
      });

      zone.querySelectorAll(".ce-file-retry-btn").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          const retryId = btn.dataset.retryId;
          retryFile(retryId);
        });
      });
    }

    function renderRowHtml(file) {
      const isImg = file.type === "JPG" || file.type === "JPEG" || file.type === "PNG" ||
        (file.mime && file.mime.startsWith("image/")) ||
        (file.thumbnail && file.thumbnail.length > 0);

      let preview = "";
      if (isImg && file.thumbnail) {
        preview = `<img class="ce-file-thumb" src="${file.thumbnail}" alt="" />`;
      } else if (isImg) {
        preview = `
          <span class="ce-file-badge ce-file-badge-image" title="Image file" aria-hidden="true">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
              <circle cx="8.5" cy="8.5" r="1.5"/>
              <polyline points="21 15 16 10 5 21"/>
            </svg>
          </span>`;
      } else if (file.type === "PDF") {
        preview = `
          <span class="ce-file-badge ce-file-badge-pdf" title="PDF document" aria-hidden="true">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
              <polyline points="14 2 14 8 20 8"/>
            </svg>
            PDF
          </span>`;
      } else {
        preview = `
          <span class="ce-file-badge ce-file-badge-doc" title="Document" aria-hidden="true">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
              <polyline points="14 2 14 8 20 8"/>
              <line x1="16" y1="13" x2="8" y2="13"/>
              <line x1="16" y1="17" x2="8" y2="17"/>
            </svg>
            ${escapeHTML(file.type || "DOC")}
          </span>`;
      }

      const isUploading = Boolean(file.uploading);
      const isError = Boolean(file.error);
      const progress = typeof file.progress === "number" ? file.progress : 100;

      return `
        <div class="ce-file-item ${isError ? 'is-error' : ''}" role="listitem" data-file-id="${escapeHTML(file.id)}">
          <div class="ce-file-preview">
            ${preview}
          </div>
          <div class="ce-file-details">
            <div class="ce-file-name-row">
              <span class="ce-file-name" title="${escapeHTML(file.name)}">${escapeHTML(file.name)}</span>
              <span class="ce-file-size">${formatFileSize(file.size)}</span>
            </div>
            ${isUploading ? `
              <div class="ce-file-progress-track" aria-label="Uploading file">
                <div class="ce-file-progress-bar" style="width: ${progress}%;"></div>
              </div>
            ` : ''}
            ${isError ? `
              <div class="ce-file-error-row">
                <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                  <path d="M8 15A7 7 0 1 1 8 1a7 7 0 0 1 0 14zm0-1A6 6 0 1 0 8 2a6 6 0 0 0 0 12zM7.25 4v5h1.5V4h-1.5zm.75 8a1 1 0 1 0 0-2 1 1 0 0 0 0 2z"/>
                </svg>
                <span class="ce-file-error-text">${escapeHTML(file.error)}</span>
                <button type="button" class="ce-file-retry-btn" data-retry-id="${escapeHTML(file.id)}" aria-label="Retry upload of ${escapeHTML(file.name)}">Retry</button>
              </div>
            ` : ''}
          </div>
          <button type="button"
                  class="ce-file-remove"
                  data-remove-id="${escapeHTML(file.id)}"
                  aria-label="Remove ${escapeHTML(file.name)}"
                  title="Remove ${escapeHTML(file.name)}">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true">
              <line x1="3" y1="3" x2="13" y2="13"/>
              <line x1="13" y1="3" x2="3" y2="13"/>
            </svg>
          </button>
        </div>
      `;
    }

    function removeFile(fileId) {
      const files = getFiles();
      const idx = files.findIndex((f) => f.id === fileId);
      if (idx !== -1) {
        if (files[idx].thumbnail && files[idx].thumbnail.startsWith("blob:")) {
          try { URL.revokeObjectURL(files[idx].thumbnail); } catch (e) {}
        }
        files.splice(idx, 1);
        state.dirty = true;
        clearInlineError();
        render();
        updateAllReadinessChecks();
      }
    }

    function retryFile(fileId) {
      const files = getFiles();
      const file = files.find((f) => f.id === fileId);
      if (file) {
        file.error = null;
        file.uploading = true;
        file.progress = 25;
        render();
        simulateUpload(file);
      }
    }

    function simulateUpload(docItem) {
      setTimeout(() => {
        docItem.progress = 75;
        const bar = zone.querySelector(`[data-file-id="${docItem.id}"] .ce-file-progress-bar`);
        if (bar) bar.style.width = "75%";
      }, 140);

      setTimeout(() => {
        docItem.progress = 100;
        docItem.uploading = false;
        const track = zone.querySelector(`[data-file-id="${docItem.id}"] .ce-file-progress-track`);
        if (track) {
          track.style.opacity = "0";
          setTimeout(() => track.remove(), 200);
        }
      }, 380);
    }

    function handleFiles(selectedFiles) {
      clearInlineError();
      const files = getFiles();
      const errMsgs = [];
      const validToAdd = [];

      Array.from(selectedFiles).forEach((file) => {
        const ext = "." + (file.name.split(".").pop() || "").toLowerCase();

        // 1. Check type
        if (!allowedExtensions.includes(ext)) {
          errMsgs.push(`"${file.name}" rejected: Only PDF, DOC, DOCX, JPG, PNG allowed.`);
          return;
        }

        // 2. Check size
        if (file.size > maxSizeBytes) {
          errMsgs.push(`"${file.name}" rejected: Exceeds 10MB limit (${formatFileSize(file.size)}).`);
          return;
        }

        // 3. Check duplicate
        const isDuplicate = files.some((f) => f.name === file.name && f.size === file.size) ||
          validToAdd.some((f) => f.name === file.name && f.size === file.size);
        if (isDuplicate) {
          errMsgs.push(`"${file.name}" is already added.`);
          return;
        }

        // 4. Check max limit
        if (files.length + validToAdd.length >= maxFiles) {
          errMsgs.push(`Maximum of ${maxFiles} files reached. "${file.name}" was not added.`);
          return;
        }

        let thumb = "";
        if (file instanceof File && (file.type.startsWith("image/") || /\.(jpe?g|png)$/i.test(file.name))) {
          try {
            thumb = URL.createObjectURL(file);
          } catch (e) {
            thumb = "";
          }
        }

        validToAdd.push({
          id: "doc-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7),
          name: file.name,
          size: file.size,
          type: ext.replace(".", "").toUpperCase(),
          mime: file.type || "",
          thumbnail: thumb,
          uploading: true,
          progress: 30,
          fileRef: file,
        });
      });

      // Add valid files without discarding them
      if (validToAdd.length > 0) {
        validToAdd.forEach((item) => {
          files.push(item);
          simulateUpload(item);
        });
        state.dirty = true;
      }

      if (errMsgs.length > 0) {
        setInlineError(errMsgs.join(" "));
      } else {
        clearInlineError();
      }

      render();
      updateAllReadinessChecks();
    }

    // Drag and Drop listeners on zone
    ["dragenter", "dragover"].forEach((evt) => {
      zone.addEventListener(evt, (e) => {
        e.preventDefault();
        e.stopPropagation();
        zone.classList.add("is-dragover");
      });
    });

    ["dragleave", "drop"].forEach((evt) => {
      zone.addEventListener(evt, (e) => {
        e.preventDefault();
        e.stopPropagation();
        zone.classList.remove("is-dragover");
      });
    });

    zone.addEventListener("drop", (e) => {
      const dtFiles = e.dataTransfer?.files;
      if (dtFiles && dtFiles.length) {
        handleFiles(dtFiles);
      }
    });

    // Native file input listener
    input.addEventListener("change", () => {
      if (input.files && input.files.length) {
        handleFiles(input.files);
        input.value = "";
      }
    });

    // Click support on empty dropzone
    zone.addEventListener("click", () => {
      if (getFiles().length === 0) {
        input.click();
      }
    });

    // Keyboard support on empty dropzone
    zone.addEventListener("keydown", (e) => {
      if (getFiles().length === 0 && (e.key === "Enter" || e.key === " ")) {
        e.preventDefault();
        input.click();
      }
    });

    // Initial render
    render();

    const instance = { render, clearInlineError, setInlineError };
    dropzoneInstances.set(stateKey, instance);
    return instance;
  }

  function renderFileList(stateKey) {
    const inst = dropzoneInstances.get(stateKey);
    if (inst) {
      inst.render();
    }
  }

  function formatFileSize(bytes) {
    if (!bytes || bytes <= 0) return "0 B";
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  }

  // 26. Live Event Preview Synchronizer
  function updateLivePreview() {
    const form = document.getElementById("createEventMainForm");
    if (!form) return;

    // Title
    const titleEl = document.getElementById("previewTitle");
    if (titleEl) {
      const titleText = form.eventName?.value.trim() || "Untitled Event";
      titleEl.textContent = titleText;
      titleEl.title = titleText;
    }

    // Event Source reflects directly under event name
    const srcEl = document.getElementById("previewSource");
    if (srcEl) {
      const srcVal = form.eventSource?.value;
      srcEl.textContent = srcVal ? `Source: ${srcVal}` : "Source: Not specified";
    }

    // Categories
    const tagsEl = document.getElementById("previewTags");
    if (tagsEl) {
      if (state.selectedCategories.length === 0) {
        tagsEl.innerHTML = '<span class="ce-preview-tag">General</span>';
      } else {
        tagsEl.innerHTML = state.selectedCategories.map((c) => `
          <span class="ce-preview-tag">${escapeHTML(c)}</span>
        `).join("");
      }
    }

    // Date & Time
    const dtEl = document.getElementById("previewDateTime");
    if (dtEl) {
      const d = form.eventDate?.value;
      const dEnd = form.eventDateEnd?.value;
      const isDiff = form.dailySchedule?.value === "Different time by day";
      const dateText = (d && dEnd && d !== dEnd)
        ? `${formatDatePreview(d)} - ${formatDatePreview(dEnd)}`
        : (d ? formatDatePreview(d) : "");

      if (isDiff) {
        if (dateText) {
          dtEl.textContent = `${dateText} · Schedule differs by day`;
          dtEl.classList.remove("is-muted");
        } else {
          dtEl.textContent = "Date and time not set";
          dtEl.classList.add("is-muted");
        }
      } else {
        const ts = form.timeStart?.value;
        const te = form.timeEnd?.value;
        if (dateText && ts && te) {
          dtEl.textContent = `${dateText} · ${ts} - ${te}`;
          dtEl.classList.remove("is-muted");
        } else if (dateText) {
          dtEl.textContent = dateText;
          dtEl.classList.remove("is-muted");
        } else {
          dtEl.textContent = "Date and time not set";
          dtEl.classList.add("is-muted");
        }
      }
    }

    // Venue
    const venueEl = document.getElementById("previewVenue");
    if (venueEl) {
      const v = form.venue?.value;
      const vLower = (v || "").toLowerCase();
      if (vLower.includes("outside pup") && form.customVenueName?.value.trim()) {
        venueEl.textContent = `${v} (${form.customVenueName.value.trim()})`;
      } else if (vLower.includes("inside pup") && (form.customVenueName?.value.trim() || form.customVenueAddress?.value.trim())) {
        const bldg = form.customVenueName?.value.trim() || "";
        const room = form.customVenueAddress?.value.trim() || "";
        const extra = [bldg, room].filter(Boolean).join(", ");
        venueEl.textContent = extra ? `${v} (${extra})` : v;
      } else if (vLower.includes("online") && form.onlineMeetingLink?.value.trim()) {
        venueEl.textContent = `${v} (${form.onlineMeetingLink.value.trim()})`;
      } else {
        venueEl.textContent = v || "Venue not set";
      }
      venueEl.classList.toggle("is-muted", !v);
    }

    // Capacity
    const capEl = document.getElementById("previewCapacity");
    if (capEl) {
      const c = form.maxCapacity?.value;
      capEl.textContent = c ? `Capacity: ${c} attendees` : "Capacity not specified";
      capEl.classList.toggle("is-muted", !c);
    }

    // Registration Schedule (Start & End)
    const dlineEl = document.getElementById("previewDeadline");
    if (dlineEl) {
      const regStartVal = form.registrationStart?.value;
      const regEndVal = form.registrationEnd?.value || form.registrationDeadline?.value;
      if (regEndVal) {
        try {
          const eObj = new Date(regEndVal);
          const endFormatted = `${eObj.toLocaleDateString("en-US", { month: "short", day: "numeric" })} ${eObj.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;
          if (regStartVal) {
            const sObj = new Date(regStartVal);
            const startFormatted = `${sObj.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
            dlineEl.textContent = `Reg: ${startFormatted} – ${endFormatted}`;
          } else {
            dlineEl.textContent = `Reg Ends: ${endFormatted}`;
          }
        } catch {
          dlineEl.textContent = `Reg Ends: ${regEndVal}`;
        }
        dlineEl.classList.remove("is-muted");
      } else {
        dlineEl.textContent = "Registration not set";
        dlineEl.classList.add("is-muted");
      }
    }

    // Target Year
    const yearEl = document.getElementById("previewTargetYear");
    if (yearEl) {
      yearEl.textContent = `Target: ${form.targetYear?.value || "All Levels"}`;
    }

    // Organizer
    const orgEl = document.getElementById("previewOrganizer");
    if (orgEl) {
      orgEl.textContent = readOnlyOrganizerValue;
    }
  }

  function formatDatePreview(isoStr) {
    try {
      const parts = isoStr.split("-");
      if (parts.length === 3) {
        const date = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
        return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
      }
    } catch {
      // fallback
    }
    return isoStr;
  }

  // 27. 8 Readiness Checks (Live Icons & Status)
  function parseTimeInMinutes(timeStr) {
    const match = /^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i.exec((timeStr || "").trim());
    if (!match) return null;
    let hour = parseInt(match[1], 10);
    const min = parseInt(match[2], 10);
    const period = (match[3] || "AM").toUpperCase();
    if (period === "PM" && hour < 12) hour += 12;
    if (period === "AM" && hour === 12) hour = 0;
    return hour * 60 + min;
  }

  function checkCrossEventConflict(date, venue, startTimeStr, endTimeStr) {
    if (!date || !venue || !startTimeStr || !endTimeStr) return null;
    if (venue.startsWith("Others |") || venue.includes("Online")) return null;

    const startMins = parseTimeInMinutes(startTimeStr);
    const endMins = parseTimeInMinutes(endTimeStr);
    if (startMins === null || endMins === null) return null;

    const allEvents = [
      ...readJSON("recovibeOrganizerEvents", []),
      ...readJSON("recovibeTeacherEvents", []),
    ];

    const conflicting = allEvents.find((ev) => {
      if (!ev) return false;
      const evId = String(ev.id || ev.eventId || "");
      if (state.editingEventId && evId === String(state.editingEventId)) return false;

      const st = String(ev.status || "").toLowerCase();
      if (!["approved", "published", "pending", "pending approval", "pending_approval"].includes(st)) {
        return false;
      }

      const evDate = String(ev.date || ev.dateISO || ev.eventDate || "").slice(0, 10);
      if (evDate !== date) return false;

      const evVenue = String(ev.venue || ev.location || "");
      if (evVenue !== venue) return false;

      const timeRange = String(ev.time || "").split(/\s*[-–]\s*/);
      const evStart = parseTimeInMinutes(ev.startTime ? formatTo12Hr(ev.startTime) : timeRange[0]);
      const evEnd = parseTimeInMinutes(ev.endTime ? formatTo12Hr(ev.endTime) : timeRange[1]);

      if (evStart === null || evEnd === null) return false;

      return startMins < evEnd && endMins > evStart;
    });

    return conflicting || null;
  }

  function formatTo12Hr(t24) {
    if (!t24) return "";
    const p = t24.split(":");
    if (p.length < 2) return t24;
    const h = parseInt(p[0], 10);
    const m = p[1];
    return `${String(h % 12 || 12).padStart(2, "0")}:${m} ${h < 12 ? "AM" : "PM"}`;
  }

  function updateAllReadinessChecks() {
    const form = document.getElementById("createEventMainForm");
    if (!form) return { readyCount: 0, total: 8, isReady: false, remainingCount: 8, failingChecks: [] };

    let readyCount = 0;
    const failingChecks = [];
    const manilaInfo = getManilaDateInfo();

    // 1. Event name provided (5-150 chars)
    const nameVal = form.eventName?.value.trim() || "";
    const namePass = nameVal.length >= 5 && nameVal.length <= 150 &&
      /^[\p{L}\p{N}\p{P}\p{Zs}]+$/u.test(nameVal);
    setCheckStatus("check-name", namePass, "Event name provided (5-150 chars)");
    if (namePass) {
      readyCount++;
    } else {
      failingChecks.push({
        id: "eventName",
        label: "Event name provided (5-150 chars)",
        message: nameVal.length === 0 ? "Event name is required (minimum 5 characters)." : "Event name must contain 5 to 150 valid characters.",
      });
    }

    // 2. At least 1 category selected (1 to 3)
    const catPass = state.selectedCategories.length >= 1 && state.selectedCategories.length <= 3;
    setCheckStatus("check-category", catPass, "1 to 3 categories selected");
    if (catPass) {
      readyCount++;
    } else {
      failingChecks.push({
        id: "category",
        label: "1 to 3 categories selected",
        message: state.selectedCategories.length === 0 ? "Please select 1 to 3 categories for this event." : "You can select at most 3 categories.",
      });
    }

    // 3. Time End is after Time Start & within 8 AM - 8 PM (or per-day schedule valid)
    const isDifferentDaily = form.dailySchedule?.value === "Different time by day";
    const dateVal = form.eventDate?.value || "";
    const currentMins = getManilaCurrentMinutes();
    let timesPass = false;
    let timesErrMsg = "Time End must be after Time Start (8 AM - 8 PM)";

    if (isDifferentDaily) {
      const rows = document.querySelectorAll("#dailyScheduleList .ce-daily-schedule-row");
      if (rows.length > 0) {
        let allRowsValid = true;
        rows.forEach((row) => {
          const rowDate = row.dataset.date;
          const sInp = row.querySelector(".ce-daily-start-input")?.value;
          const eInp = row.querySelector(".ce-daily-end-input")?.value;
          const sMins = parseTimeInMinutes(sInp);
          const eMins = parseTimeInMinutes(eInp);
          const passedRow = rowDate === manilaInfo.todayStr ? (sMins !== null && sMins > currentMins) : true;
          const limitsPass = sMins !== null && eMins !== null && sMins >= 480 && eMins <= 1200;
          if (!limitsPass || eMins <= sMins || !passedRow) {
            allRowsValid = false;
          }
        });
        timesPass = allRowsValid;
        if (!timesPass) timesErrMsg = "Please ensure all daily start/end times are between 8:00 AM and 8:00 PM with End after Start.";
      } else {
        timesErrMsg = "Please configure valid daily schedule dates and times.";
      }
    } else {
      const tStart = parseTimeInMinutes(form.timeStart?.value);
      const tEnd = parseTimeInMinutes(form.timeEnd?.value);
      const passedCheck = dateVal === manilaInfo.todayStr ? (tStart !== null && tStart > currentMins) : true;
      const timeLimitsPass = tStart !== null && tEnd !== null && tStart >= 480 && tEnd <= 1200;
      timesPass = timeLimitsPass && tEnd > tStart && passedCheck;
      if (!timesPass) {
        if (tStart === null || tEnd === null) timesErrMsg = "Time Start and Time End are required.";
        else if (tStart < 480) timesErrMsg = "Time Start cannot be earlier than 8:00 AM.";
        else if (tEnd > 1200) timesErrMsg = "Time End cannot be later than 8:00 PM.";
        else if (tEnd <= tStart) timesErrMsg = "Time End must be strictly after Time Start.";
        else if (!passedCheck) timesErrMsg = "Start time for today has already passed.";
      }
    }

    setCheckStatus(
      "check-times",
      timesPass,
      timesPass
        ? (isDifferentDaily ? "Daily schedule times valid" : "Time End is after Time Start")
        : "Time End must be after Time Start (8 AM - 8 PM)"
    );
    if (timesPass) {
      readyCount++;
    } else {
      failingChecks.push({
        id: isDifferentDaily ? "dailySchedule" : "timeEnd",
        label: "Time End is after Time Start",
        message: timesErrMsg,
      });
    }

    // 4. Cross-event venue conflict check
    const venueVal = form.venue?.value || "";
    let conflict = null;
    if (isDifferentDaily) {
      const rows = document.querySelectorAll("#dailyScheduleList .ce-daily-schedule-row");
      for (const row of rows) {
        const rowDate = row.dataset.date;
        const sInp = row.querySelector(".ce-daily-start-input")?.value;
        const eInp = row.querySelector(".ce-daily-end-input")?.value;
        conflict = checkCrossEventConflict(rowDate, venueVal, sInp, eInp);
        if (conflict) break;
      }
    } else {
      conflict = checkCrossEventConflict(dateVal, venueVal, form.timeStart?.value, form.timeEnd?.value);
    }
    state.conflict = conflict;
    const conflictPass = !conflict;
    setCheckStatus("check-conflict", conflictPass, conflict ? `Venue conflict with "${conflict.title || "another event"}"` : "No venue booking conflict");
    if (conflictPass) {
      readyCount++;
    } else {
      failingChecks.push({
        id: "venue",
        label: "No venue booking conflict",
        message: `Venue conflict with "${conflict?.title || "another event"}" at the selected schedule.`,
      });
    }

    // 5. Registration Start & End (end must strictly be 1-2 days before event date & start < end)
    let deadlinePass = false;
    let deadlineLabel = "Registration end must be 1 or 2 days before event date";
    let deadlineErrMsg = "Registration end must be 1 or 2 days before event date";
    const regStartVal = form.registrationStart?.value;
    const regEndVal = form.registrationEnd?.value || form.registrationDeadline?.value;

    if (regEndVal && dateVal) {
      const dlineDate = new Date(regEndVal);
      const isPast = dlineDate < new Date();
      const maxEndStr = calculateMaxRegistrationEnd(dateVal);
      const isNotBeforeEvent = regEndVal > maxEndStr;
      const startBeforeEnd = !regStartVal || (new Date(regStartVal) < dlineDate);

      if (!isPast && !isNotBeforeEvent && startBeforeEnd && !isNaN(dlineDate.getTime())) {
        deadlinePass = true;
        deadlineLabel = "Registration end is 1 or 2 days before event date";
      } else if (isNotBeforeEvent) {
        deadlineLabel = "Registration end cannot be on event date (must be 1-2 days before)";
        deadlineErrMsg = "Registration end cannot be on event date (must be 1-2 days before).";
      } else if (!startBeforeEnd) {
        deadlineLabel = "Registration start must be earlier than Registration end";
        deadlineErrMsg = "Registration start must be earlier than Registration end.";
      } else if (isPast) {
        deadlineLabel = "Registration end cannot be in the past";
        deadlineErrMsg = "Registration end cannot be in the past.";
      }
    } else {
      deadlineErrMsg = !dateVal ? "Please select Date Start first." : "Registration start and end dates are required.";
    }
    setCheckStatus("check-deadline", deadlinePass, deadlineLabel);
    if (deadlinePass) {
      readyCount++;
    } else {
      failingChecks.push({
        id: "registrationEnd",
        label: "Registration end is 1 or 2 days before event date",
        message: deadlineErrMsg,
      });
    }

    // 6. Capacity is within venue limit
    let capacityPass = true;
    let capErrMsg = "Capacity exceeds venue limit";
    const capValue = form.maxCapacity?.value.trim() || "";
    const capVal = capValue ? Number(capValue) : NaN;
    const venueRecord = VENUES_FLAT_MAP[venueVal];
    const maxVenueLimit = venueRecord?.maxCapacity;
    capacityPass = Number.isInteger(capVal) && capVal > 0;
    if (capacityPass && maxVenueLimit) {
      capacityPass = capVal <= maxVenueLimit;
      if (!capacityPass) capErrMsg = `Capacity cannot exceed venue maximum of ${maxVenueLimit}.`;
    } else if (!capacityPass) {
      capErrMsg = capValue ? "Enter a whole-number capacity greater than zero." : "Capacity is required.";
    }
    setCheckStatus("check-capacity", capacityPass, capacityPass ? "Capacity is within venue limit" : capErrMsg);
    if (capacityPass) {
      readyCount++;
    } else {
      failingChecks.push({
        id: "maxCapacity",
        label: "Capacity is within venue limit",
        message: capErrMsg,
      });
    }

    // 7. Contact person name and valid email (no numbers in name)
    const contactNameVal = form.contactName?.value.trim() || "";
    const contactEmailVal = form.contactEmail?.value.trim() || "";
    const noNumsInName = !/\d/.test(contactNameVal);
    const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmailVal);
    const contactPass = contactNameVal.length >= 2 && noNumsInName && emailValid;
    let contactErrMsg = "Provide contact person name and valid email";
    if (!contactPass) {
      if (contactNameVal.length < 2) contactErrMsg = "Contact person name is required (min 2 characters).";
      else if (!noNumsInName) contactErrMsg = "Contact person name cannot contain numbers.";
      else if (!emailValid) contactErrMsg = "A valid email address is required for the contact person.";
    }
    setCheckStatus("check-contact", contactPass, contactPass ? "Contact person name and email provided" : "Provide contact person name and valid email");
    if (contactPass) {
      readyCount++;
    } else {
      failingChecks.push({
        id: contactNameVal.length < 2 || !noNumsInName ? "contactName" : "contactEmail",
        label: "Contact person name and valid email",
        message: contactErrMsg,
      });
    }

    // 8. Admin review documents link
    const approvalPass = isGoogleDriveLink(state.adminDocumentLinks.adminReview || "");
    const checkMsg = approvalPass
      ? "Admin review document link provided"
      : "Provide one Google Drive folder or document link for admin review";
    setCheckStatus("check-approvalDocs", approvalPass, checkMsg);
    if (approvalPass) {
      readyCount++;
    } else {
      failingChecks.push({
        id: "adminDoc-adminReview",
        label: "Admin review document link",
        message: "Provide a valid Google Drive folder or document link for admin review.",
      });
    }

    // Summary Badge & Progress Bar in Side Panel & Bottom Bar
    const badge = document.getElementById("checksBadge");
    if (badge) {
      badge.textContent = `${readyCount} of 8 Ready`;
      badge.classList.toggle("is-complete", readyCount === 8);
    }

    const bar = document.getElementById("checksProgressBar");
    if (bar) {
      const pct = Math.round((readyCount / 8) * 100);
      bar.style.width = `${pct}%`;
      bar.classList.toggle("is-complete", readyCount === 8);
    }

    const bText = document.getElementById("bottomStatusText");
    if (bText) {
      if (readyCount === 8) {
        bText.textContent = "All 8 readiness checks passed. Ready for submission!";
        bText.style.color = "#15803d";
      } else {
        bText.textContent = `${8 - readyCount} check${8 - readyCount === 1 ? "" : "s"} remaining before submitting.`;
        bText.style.color = "#b91c1c";
      }
    }

    return {
      readyCount,
      total: 8,
      isReady: readyCount === 8,
      remainingCount: 8 - readyCount,
      failingChecks,
    };
  }

  function setCheckStatus(elementId, passed, labelText) {
    const el = document.getElementById(elementId);
    if (!el) return;
    el.classList.toggle("is-passed", passed);
    el.classList.toggle("is-failed", !passed);
    const icon = el.querySelector(".ce-check-icon");
    if (icon) {
      icon.textContent = passed ? "✓" : "✕";
    }
    const sr = el.querySelector(".ce-check-status-sr");
    if (sr) {
      sr.textContent = passed ? "Passed: " : "Not yet: ";
    }
    const label = el.querySelector(".ce-check-label");
    if (label && labelText) {
      label.textContent = labelText;
    }
  }

  // 28. Comprehensive Form Validation on Submit
  function validateForm() {
    const form = document.getElementById("createEventMainForm");
    if (!form) return false;

    let isValid = true;
    let firstErrorElement = null;

    function markError(id, msg) {
      isValid = false;
      const errEl = document.getElementById(`error-${id}`);
      const wrapEl = document.getElementById(`wrap-${id}`);
      let inputEl = document.getElementById(id);
      if (!inputEl) {
        if (id === "approvalDocs") inputEl = document.getElementById("dropzoneApproval");
        else if (id === "participantDocs") inputEl = document.getElementById("participantDocsLinks");
        else if (id === "targetDepartments") inputEl = document.querySelector(".ce-target-department");
        else if (id === "facultyChips") inputEl = document.getElementById("facultySearchInput");
      }
      if (errEl) {
        errEl.textContent = msg;
        errEl.hidden = false;
      }
      if (wrapEl) wrapEl.classList.add("has-error");
      if (inputEl) {
        inputEl.setAttribute("aria-invalid", "true");
        inputEl.classList.add("has-error");
      }
      if (!firstErrorElement && inputEl) {
        firstErrorElement = inputEl;
      }
    }

    // Clear old errors
    root.querySelectorAll(".ce-error").forEach((el) => {
      el.textContent = "";
      el.hidden = true;
    });
    root.querySelectorAll(".has-error").forEach((el) => el.classList.remove("has-error"));
    root.querySelectorAll("[aria-invalid]").forEach((el) => el.removeAttribute("aria-invalid"));

    const manilaInfo = getManilaDateInfo();

    // 1. Event Name
    const nameVal = form.eventName?.value.trim() || "";
    if (nameVal.length < 5 || nameVal.length > 150) {
      markError("eventName", "Event name must contain 5 to 150 characters.");
    } else if (!/^[\p{L}\p{N}\p{P}\p{Zs}]+$/u.test(nameVal)) {
      markError("eventName", "Use letters, numbers, spaces, and punctuation only; line breaks and emoji are not allowed.");
    }

    // 2. Categories
    if (state.selectedCategories.length < 1 || state.selectedCategories.length > 3) {
      markError("category", "Please select 1 to 3 categories for this event.");
    }

    // 3. Date Validation (Asia/Manila today through the same date two years ahead)
    const dateVal = form.eventDate?.value || "";
    if (!dateVal) {
      markError("eventDate", "Date Start is required.");
    } else if (dateVal < manilaInfo.todayStr || dateVal > manilaInfo.maxDateStr) {
      markError("eventDate", `Choose a date from today through ${manilaInfo.maxDateStr}.`);
    }

    const dateEndVal = form.eventDateEnd?.value || "";
    if (!dateEndVal) {
      markError("eventDateEnd", "Date End is required.");
    } else if (dateEndVal < dateVal) {
      markError("eventDateEnd", "Date End cannot be earlier than Date Start.");
    } else if (dateEndVal > manilaInfo.maxDateStr) {
      markError("eventDateEnd", `Date End cannot be later than ${manilaInfo.maxDateStr}.`);
    }

    // 4. Time Start & Time End / Daily Schedule
    const isDifferentDaily = form.dailySchedule?.value === "Different time by day";
    if (isDifferentDaily) {
      const rows = document.querySelectorAll("#dailyScheduleList .ce-daily-schedule-row");
      if (rows.length === 0) {
        markError("dailySchedule", "Please select valid start and end dates for daily schedule.");
      } else {
        let dailyError = null;
        rows.forEach((row) => {
          const rowDate = row.dataset.date;
          const sInp = row.querySelector(".ce-daily-start-input")?.value;
          const eInp = row.querySelector(".ce-daily-end-input")?.value;
          const sMins = parseTimeInMinutes(sInp);
          const eMins = parseTimeInMinutes(eInp);
          if (sMins === null || eMins === null) {
            dailyError = dailyError || "Start and End times are required for all dates.";
          } else if (sMins < 480) {
            dailyError = dailyError || "Daily start times cannot be earlier than 8:00 AM.";
          } else if (eMins > 1200) {
            dailyError = dailyError || "Daily end times cannot be later than 8:00 PM.";
          } else if (eMins <= sMins) {
            dailyError = dailyError || "Daily end time must be after start time.";
          } else if (rowDate === manilaInfo.todayStr && sMins <= getManilaCurrentMinutes()) {
            dailyError = dailyError || "Start time for today has already passed.";
          }
        });
        if (dailyError) {
          markError("dailySchedule", dailyError);
        }
      }
    } else {
      const tStart = parseTimeInMinutes(form.timeStart?.value);
      const tEnd = parseTimeInMinutes(form.timeEnd?.value);

      if (tStart === null) {
        markError("timeStart", "Time start is required.");
      } else if (tStart < 480) {
        markError("timeStart", "Time Start cannot be earlier than 8:00 AM.");
      } else if (dateVal === manilaInfo.todayStr && tStart <= getManilaCurrentMinutes()) {
        markError("timeStart", "Start time has already passed");
      }

      if (tEnd === null) {
        markError("timeEnd", "Time end is required.");
      } else if (tEnd > 1200) {
        markError("timeEnd", "Time End cannot be later than 8:00 PM.");
      } else if (tStart !== null && tEnd <= tStart) {
        markError("timeEnd", "Time End must be strictly after Time Start.");
      }
    }

    // 5. Venue & Conditional Fields
    const venueVal = form.venue?.value || "";
    const venueRecord = VENUES_FLAT_MAP[venueVal];
    if (!venueVal) {
      markError("venue", "Please select a venue for the event.");
    } else {
      const vLower = venueVal.toLowerCase();
      if (vLower.includes("outside pup")) {
        const customName = form.customVenueName?.value.trim() || "";
        const customAddr = form.customVenueAddress?.value.trim() || "";
        if (!customName) {
          markError("customVenueName", "Please enter the Venue Name for outside venue.");
        }
        if (!customAddr) {
          markError("customVenueAddress", "Please enter the Exact Address of the outside venue.");
        }
      } else if (vLower.includes("inside pup")) {
        const customName = form.customVenueName?.value.trim() || "";
        const customAddr = form.customVenueAddress?.value.trim() || "";
        if (!customName) {
          markError("customVenueName", "Please enter the Building name.");
        }
        if (!customAddr) {
          markError("customVenueAddress", "Please enter the Room Number.");
        } else if (!/^\d{1,3}$/.test(customAddr)) {
          markError("customVenueAddress", "Room Number must contain 1 to 3 digits only.");
        }
      } else if (vLower.includes("online") || venueRecord?.type === "online") {
        const link = form.onlineMeetingLink?.value.trim() || "";
        if (!link) {
          markError("onlineMeetingLink", "Please enter the Meeting Link for online events.");
        }
      }
    }

    // 6. Capacity
    const maxVenueLimit = venueRecord?.maxCapacity;
    const capValue = form.maxCapacity?.value.trim() || "";
    const cap = capValue ? Number(capValue) : NaN;
    if (!Number.isInteger(cap) || cap <= 0) {
      markError("maxCapacity", "Enter a whole-number capacity greater than zero.");
    } else if (maxVenueLimit && cap > maxVenueLimit) {
      markError("maxCapacity", `Capacity cannot exceed venue maximum of ${maxVenueLimit}.`);
    }

    // 7. Venue Conflict
    if (state.conflict) {
      markError("venue", `Conflict: Venue is already booked on this date/time for "${state.conflict.title || "another event"}".`);
    }

    // 8. Registration Start & Registration End
    const regStartVal = form.registrationStart?.value;
    const regEndVal = form.registrationEnd?.value || form.registrationDeadline?.value;

    if (!regStartVal) {
      markError("registrationStart", "Registration start date and time is required.");
    } else if (regStartVal < getManilaDateTimeString()) {
      markError("registrationStart", "Registration start cannot be in the past.");
    }

    if (!regEndVal) {
      markError("registrationEnd", "Registration end date and time is required.");
    } else {
      const regEndDate = new Date(regEndVal);
      if (isNaN(regEndDate.getTime())) {
        markError("registrationEnd", "Please enter a valid registration end date and time.");
      } else if (regEndVal < getManilaDateTimeString()) {
        markError("registrationEnd", "Registration end cannot be in the past.");
      } else if (dateVal) {
        const [ey, em, ed] = dateVal.split("-").map(Number);
        const eventDayStart = new Date(ey, em - 1, ed, 0, 0, 0);
        const maxEndStr = calculateMaxRegistrationEnd(dateVal);

        if (regEndVal > maxEndStr || regEndDate >= eventDayStart) {
          markError(
            "registrationEnd",
            "Registration end cannot be on the exact date of the event. It must be 1 or 2 days before the event."
          );
        }
      }
    }

    if (regStartVal && regEndVal) {
      const sDate = new Date(regStartVal);
      const eDate = new Date(regEndVal);
      if (!isNaN(sDate.getTime()) && !isNaN(eDate.getTime()) && sDate >= eDate) {
        markError("registrationStart", "Registration start must be earlier than Registration end.");
        markError("registrationEnd", "Registration end must be after Registration start.");
      }
    }

    // 9. Required event detail text and structured lists
    const descriptionVal = form.description?.value.trim() || "";
    if (descriptionVal.length < 20 || descriptionVal.length > 1500) {
      markError("description", "Event Description must contain 20 to 1,500 characters.");
    }
    const rationaleVal = form.rationale?.value.trim() || "";
    if (rationaleVal.length < 20 || rationaleVal.length > 1500) {
      markError("rationale", "Rationale must contain 20 to 1,500 characters.");
    }
    const getBulletEntries = (value) => String(value || "")
      .split(/\r?\n/)
      .map((entry) => entry.trim().replace(/^[•*–-]\s*/, "").trim())
      .filter(Boolean);
    const objectives = getBulletEntries(form.keyDetails?.value);
    if (objectives.length < 1 || objectives.length > 10 || objectives.some((item) => item.length < 5 || item.length > 300)) {
      markError("keyDetails", "Enter 1 to 10 objectives, each 5 to 300 characters.");
    }
    const requirements = getBulletEntries(form.requirements?.value);
    if (requirements.length > 20 || requirements.some((item) => item.length < 2 || item.length > 300)) {
      markError("requirements", "Enter no more than 20 reminders, each 2 to 300 characters.");
    }

    // 10. Contact Person Name
    const contactNameVal = form.contactName?.value.trim() || "";
    if (!/^[\p{L} .-]{2,100}$/u.test(contactNameVal)) {
      markError("contactName", "Enter a 2 to 100 character name using letters, spaces, periods, and hyphens only.");
    }

    // 11. Contact Person Email
    const contactEmailVal = form.contactEmail?.value.trim() || "";
    if (!contactEmailVal || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmailVal)) {
      markError("contactEmail", "A valid email address is required for the contact person.");
    }

    // 12. Optional Contact Phone
    const phoneVal = (form.contactPhone?.value || "").trim();
    if (phoneVal) {
      if (!/^09\d{9}$/.test(phoneVal)) {
        markError("contactPhone", "Enter exactly 11 digits starting with 09.");
      }
    }

    // 13. Admin and participant Google Drive documents
    const adminReviewLink = document.getElementById("adminDoc-adminReview")?.value.trim() || "";
    state.adminDocumentLinks.adminReview = adminReviewLink;
    state.adminDocsLink = adminReviewLink;
    if (!isGoogleDriveLink(adminReviewLink)) {
      markError("adminDoc-adminReview", "Provide a valid Google Drive folder or document link for admin review.");
    }
    syncParticipantDocumentLinks();
    const participantUrl = document.getElementById("participantDocsLinks")?.value.trim() || "";
    if (participantUrl && !isGoogleDriveLink(participantUrl)) {
      markError("participantDocs", "Enter a valid Google Drive link with viewing access enabled.");
    }

    const registeredFaculty = loadFacultyPool();
    const unregisteredFaculty = state.participatingFaculty.some((selected) =>
      !registeredFaculty.some((faculty) =>
        (selected.id && faculty.id === selected.id) ||
        String(faculty.name || "").trim().toLowerCase() === String(selected.name || "").trim().toLowerCase(),
      ),
    );
    if (unregisteredFaculty) {
      markError("facultyChips", "Select participating faculty from registered faculty members only.");
    }

    // 13. Sequential Approval Steps
    const requiredStages = systemApprovalStages.filter((s) => s.required);
    const missingReq = requiredStages.filter((s) => !state.selectedApprovers.includes(s.id) && !state.selectedApprovers.includes(s.name));
    if (missingReq.length > 0 || !state.selectedApprovers || state.selectedApprovers.length === 0) {
      markError("approvers", "All required approval steps must be included in the approval chain.");
    }

    // 14. Target Audience
    const targetAudienceVal = normalizeTargetAudience(form.targetAudience?.value || state.targetAudience || "");
    if (!targetAudienceVal) {
      markError("targetAudience", "Please select a target audience.");
    } else if (targetAudienceVal !== "Open to All") {
      const selectedDepartments = [...document.querySelectorAll(".ce-target-department:checked")];
      if (selectedDepartments.length === 0) {
        markError(
          "targetDepartments",
          targetAudienceVal === "Organization Members Only"
            ? "No department is mapped to this organizing body. Update the organizer profile or choose another target audience."
            : "Select at least one target department.",
        );
      }
      const sectionsInput = document.getElementById("targetSections");
      if (sectionsInput?.value.trim()) {
        addTargetSectionTags(sectionsInput.value);
        sectionsInput.value = "";
      }
      const sections = state.targetSections;
      if (sections.some((section) => !/^\d{1,2}-\d{1,2}$/.test(section)) ||
          new Set(sections.map((section) => section.toLowerCase())).size !== sections.length) {
        markError("targetSections", "Use unique section values such as 1-1 or 2-3.");
      }
    }

    // 15. External Guests validation if any added
    collectExternalGuests();
    if (state.externalGuests && state.externalGuests.length > 0) {
      const guestCards = document.querySelectorAll("#externalGuestsList .ce-guest-card");
      const seenGuests = new Set();
      const guestErrors = [];
      state.externalGuests.forEach((guest, idx) => {
        const card = guestCards[idx];
        const fields = {
          name: card?.querySelector(".ce-guest-name"),
          organization: card?.querySelector(".ce-guest-org"),
          contact: card?.querySelector(".ce-guest-email"),
          role: card?.querySelector(".ce-guest-role"),
          needs: card?.querySelector(".ce-guest-access"),
        };
        const fail = (field, message) => {
          const input = fields[field];
          if (input) {
            input.classList.add("has-error");
            input.setAttribute("aria-invalid", "true");
            if (!firstErrorElement) firstErrorElement = input;
          }
          guestErrors.push(`Guest ${idx + 1}: ${message}`);
          isValid = false;
        };
        if (!/^[\p{L} .-]{2,100}$/u.test(guest.name)) {
          fail("name", "enter a 2 to 100 character name using letters, spaces, periods, or hyphens.");
        }
        if (guest.organization && (!/^[\p{L}\p{N} .,&'()-]{1,100}$/u.test(guest.organization))) {
          fail("organization", "affiliation must be 1 to 100 characters and contain no markup.");
        }
        const contactIsValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(guest.email) ||
          /^\+?[\d ()-]{7,20}$/.test(guest.email);
        if (!contactIsValid) fail("contact", "provide a valid email address or phone number.");
        if (!/^[\p{L}\p{N} .,&'()/+-]{2,50}$/u.test(guest.role)) {
          fail("role", "role/topic is required and must be 2 to 50 characters.");
        }
        if (guest.accessNeeds.length > 500 || /[<>]/.test(guest.accessNeeds)) {
          fail("needs", "needs must be no more than 500 characters and contain no markup.");
        }
        const duplicateKey = `${guest.name.toLowerCase().replace(/\s+/g, " ")}|${guest.email.toLowerCase().replace(/\s+/g, "")}`;
        if (seenGuests.has(duplicateKey)) fail("name", "this guest duplicates another guest record.");
        seenGuests.add(duplicateKey);
      });
      if (guestErrors.length) {
        const errorElement = document.getElementById("error-externalGuests");
        if (errorElement) {
          errorElement.textContent = guestErrors.join(" ");
          errorElement.hidden = false;
        }
      }
    }

    if (!isValid && firstErrorElement) {
      firstErrorElement.focus();
      firstErrorElement.scrollIntoView({ behavior: "smooth", block: "center" });
    }

    return isValid;
  }

  function clearFieldError(id) {
    const errEl = document.getElementById(`error-${id}`);
    const wrapEl = document.getElementById(`wrap-${id}`);
    let inputEl = document.getElementById(id);
    if (!inputEl) {
      if (id === "approvalDocs") inputEl = document.getElementById("dropzoneApproval");
      else if (id === "participantDocs") inputEl = document.getElementById("participantDocsLinks");
      else if (id === "approvers") inputEl = document.getElementById("approverList");
      else if (id === "targetDepartments") inputEl = document.querySelector(".ce-target-department");
      else if (id === "facultyChips") inputEl = document.getElementById("facultySearchInput");
    }
    if (errEl) {
      errEl.textContent = "";
      errEl.hidden = true;
    }
    if (wrapEl) wrapEl.classList.remove("has-error");
    if (inputEl) {
      inputEl.removeAttribute("aria-invalid");
      inputEl.classList.remove("has-error");
    }
  }

  // 29. Save Draft & Submit Event Handlers
  function serializeEvent(status) {
    const form = document.getElementById("createEventMainForm");
    const id = state.editingEventId || `${isOrganizerPage ? "org" : "tch"}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const nowISO = new Date().toISOString();

    const title = form?.eventName?.value.trim() || "Untitled Event";
    const date = form?.eventDate?.value || "";
    const dateEnd = form?.eventDateEnd?.value || date;
    const dailyScheduleType = form?.dailySchedule?.value || "Same time each day";
    const dailySchedules = dailyScheduleType === "Different time by day" ? collectDailySchedules() : [];

    let effectiveTimeStart = form?.timeStart?.value || "";
    let effectiveTimeEnd = form?.timeEnd?.value || "";
    if (dailyScheduleType === "Different time by day" && dailySchedules.length > 0) {
      effectiveTimeStart = dailySchedules[0].timeStart || "";
      effectiveTimeEnd = dailySchedules[0].timeEnd || "";
    }

    const venue = form?.venue?.value || "";
    const capacityValue = form?.maxCapacity?.value.trim() || "";
    const maxCapacity = capacityValue ? Number(capacityValue) : null;
    const outsideGuests = Boolean(form?.outsideGuests?.checked);

    const cleanPhone = (form?.contactPhone?.value || "").trim();

    // Clean bulleted lists for Key Details and Requirements
    const cleanKeyDetails = form?.keyDetails?.value
      .split("\n")
      .map((s) => s.trim().replace(/^[•\-\*]\s*/, ""))
      .filter(Boolean) || [];

    const cleanRequirements = form?.requirements?.value
      .split("\n")
      .map((s) => s.trim().replace(/^[•\-\*]\s*/, ""))
      .filter(Boolean) || [];

    return {
      id,
      eventId: id,
      title,
      eventName: title,
      organizer: readOnlyOrganizerValue,
      organizerName: readOnlyOrganizerValue,
      organizerId: userIdentifier,
      createdBy: userIdentifier,
      creatorRole: currentRole,
      source: form?.eventSource?.value || defaultEventSource,
      eventSource: form?.eventSource?.value || defaultEventSource,
      categories: [...state.selectedCategories],
      category: state.selectedCategories.join(", "),
      targetYear: form?.targetYear?.value || "All Levels",
      targetYearLevels: [...state.targetYearLevels],
      targetDepartments: [...state.targetDepartments],
      targetSections: [...state.targetSections],
      date,
      dateISO: date,
      dateStart: date,
      dateEnd: dateEnd,
      endDate: dateEnd,
      endDateISO: dateEnd,
      dailySchedule: dailyScheduleType,
      dailySchedules,
      timeStart: effectiveTimeStart,
      timeEnd: effectiveTimeEnd,
      time: effectiveTimeStart && effectiveTimeEnd ? `${effectiveTimeStart} - ${effectiveTimeEnd}` : "",
      venue,
      location: venue,
      customVenueName: form?.customVenueName?.value.trim() || "",
      customVenueAddress: form?.customVenueAddress?.value.trim() || "",
      venueName: form?.customVenueName?.value.trim() || "",
      venueAddress: form?.customVenueAddress?.value.trim() || "",
      building: form?.customVenueName?.value.trim() || "",
      roomNumber: form?.customVenueAddress?.value.trim() || "",
      onlineMeetingLink: form?.onlineMeetingLink?.value.trim() || "",
      meetingLink: form?.onlineMeetingLink?.value.trim() || "",
      maxCapacity,
      capacity: maxCapacity,
      openSlots: maxCapacity,
      slots: maxCapacity,
      registrationStart: form?.registrationStart?.value || "",
      registrationEnd: form?.registrationEnd?.value || form?.registrationDeadline?.value || "",
      registrationDeadline: form?.registrationEnd?.value || form?.registrationDeadline?.value || "",
      registrationEnabled,
      attendanceRequired: form?.attendanceRequired?.checked ?? true,
      weatherContingency: form?.weatherContingency?.value || "",
      venueType: form?.weatherContingency?.value || "",
      description: form?.description?.value.trim() || "",
      rationale: form?.rationale?.value.trim() || "",
      keyDetails: cleanKeyDetails,
      objectives: cleanKeyDetails,
      requirements: cleanRequirements,
      participatingFaculty: [...state.participatingFaculty],
      contactPerson: {
        name: form?.contactName?.value.trim() || "",
        email: form?.contactEmail?.value.trim() || "",
        phone: cleanPhone,
      },
      contactName: form?.contactName?.value.trim() || "",
      contactEmail: form?.contactEmail?.value.trim() || "",
      contactPhone: cleanPhone,
      participantDocuments: [...state.participantDocs],
      attachments: [...state.participantDocs],
      approvalDocuments: state.adminDocsLink,
      adminDocuments: state.adminDocsLink,
      targetAudience: normalizeTargetAudience(form?.targetAudience?.value || state.targetAudience),
      isCollaboration: Boolean(state.isCollaboration),
      partnerOrganizations: [...(state.partnerOrganizations || [])],
      collaborationNotes: form?.collaborationNotes?.value.trim() || state.collaborationNotes || "",
      externalGuests: collectExternalGuests(),
      outsideGuests: Boolean((state.externalGuests && state.externalGuests.length > 0) || outsideGuests || state.outsideGuests),
      approvers: [...state.selectedApprovers],
      approvalStages: systemApprovalStages.filter((s) => state.selectedApprovers.includes(s.id) || s.required),
      status, // "Draft", "Pending Approval", or "Published"
      createdAt: nowISO,
      updatedAt: nowISO,
      hap1Approved: false,
      hap2Approved: false,
      hap3Approved: false,
    };
  }

  function persistEvent(eventObj) {
    writeEventToLocalStorage(eventObj);
  }

  function writeEventToLocalStorage(eventObj) {
    const list = readJSON(storageKeyEvents, []);
    const idx = list.findIndex((ev) => String(ev.id || ev.eventId) === String(eventObj.id));

    if (idx >= 0) {
      list[idx] = { ...list[idx], ...eventObj, updatedAt: new Date().toISOString() };
    } else {
      list.unshift(eventObj);
    }

    const saved = writeJSON(storageKeyEvents, list);

    // Also mirror to global RECOVIBE_EVENTS for student feed compatibility if approved/published
    if (eventObj.status === "Published") {
      const studentEvents = readJSON("recovibeEvents", []);
      const existingIndex = studentEvents.findIndex((ev) => String(ev.id || ev.eventId) === String(eventObj.id));
      if (existingIndex >= 0) {
        studentEvents[existingIndex] = { ...studentEvents[existingIndex], ...eventObj };
      } else {
        studentEvents.unshift(eventObj);
      }
      writeJSON("recovibeEvents", studentEvents);
    }
    return saved;
  }

  // 30. Check Query Param for Direct Edit Mode (?eventId=xxx)
  const queryEventId = urlParams.get("eventId");
  if (queryEventId) {
    const past = loadCurrentUserEvents();
    const target = past.find((ev) => String(ev.id || ev.eventId) === String(queryEventId));
    if (target) {
      state.editingEventId = queryEventId;
      state.mode = "new";
      state.selectedCategories = Array.isArray(target.categories) ? [...target.categories] : [];
      state.participatingFaculty = Array.isArray(target.participatingFaculty) ? [...target.participatingFaculty] : [];
      const savedParticipantDocuments = Array.isArray(target.participantDocuments)
        ? target.participantDocuments
        : Array.isArray(target.attachments)
          ? target.attachments
          : [];
      const savedParticipantUrls = getParticipantDocumentUrls(savedParticipantDocuments);
      state.participantDocumentLink = savedParticipantUrls.find(isGoogleDriveLink) || "";
      state.legacyParticipantDocs = savedParticipantDocuments.filter((document) => {
        const url = typeof document === "string"
          ? document
          : document?.url || document?.path || document?.downloadURL || document?.downloadUrl || "";
        return url && !isGoogleDriveLink(url);
      });
      state.participantDocs = [
        ...state.legacyParticipantDocs,
        ...savedParticipantUrls.filter(isGoogleDriveLink).map((url, index) => ({
          name: `Participant Document ${index + 1}`,
          url,
          type: "Google Drive",
        })),
      ];
      state.adminDocsLink = getAdminDocsLink(target);
      state.adminDocumentLinks = getAdminDocumentLinks(target);
      state.deadlineManuallyEdited = true;
      state.targetAudience = normalizeTargetAudience(target.targetAudience);
      state.targetDepartments = Array.isArray(target.targetDepartments) ? [...target.targetDepartments] : [];
      state.targetYearLevels = Array.isArray(target.targetYearLevels)
        ? [...target.targetYearLevels]
        : target.targetYear && target.targetYear !== "All Levels"
          ? String(target.targetYear).split(",").map((year) => year.trim()).filter((year) => TARGET_YEARS.includes(year))
          : [];
      state.targetSections = Array.isArray(target.targetSections)
        ? [...target.targetSections]
        : target.targetSections
          ? String(target.targetSections).split(/[,\n]/).map((section) => section.trim()).filter(Boolean)
          : [];
      state.isCollaboration = target.isCollaboration !== undefined ? Boolean(target.isCollaboration) : Boolean(Array.isArray(target.partnerOrganizations) && target.partnerOrganizations.length > 0);
      state.partnerOrganizations = Array.isArray(target.partnerOrganizations) ? [...target.partnerOrganizations] : [];
      state.collaborationNotes = target.collaborationNotes || "";
      state.externalGuests = Array.isArray(target.externalGuests) ? [...target.externalGuests] : [];
      state.outsideGuests = Boolean((state.externalGuests && state.externalGuests.length > 0) || target.outsideGuests);
      if (Array.isArray(target.approvers)) {
        state.selectedApprovers = [...target.approvers];
      }
    }
  }

  // Initial Run
  render();
  renderAdminDocuments();
  renderApprovers();

  if (state.editingEventId) {
    const past = loadCurrentUserEvents();
    const target = past.find((ev) => String(ev.id || ev.eventId) === String(state.editingEventId));
    if (target) {
      const form = document.getElementById("createEventMainForm");
      if (form) {
        if (form.eventName) form.eventName.value = target.title || target.eventName || "";
        if (form.eventSource) form.eventSource.value = normalizeEventSource(target.source);
        if (form.targetYear) form.targetYear.value = state.targetYearLevels.join(", ") || "All Levels";
        if (form.targetAudience) form.targetAudience.value = state.targetAudience;
        renderTargetSectionTags();
        if (form.attendanceRequired) form.attendanceRequired.checked = target.attendanceRequired !== false;
        if (form.isCollaboration) form.isCollaboration.checked = state.isCollaboration;
        if (form.collaborationNotes) form.collaborationNotes.value = state.collaborationNotes;
        renderPartnerOrgList();
        renderExternalGuestCards();
        if (form.eventDate) form.eventDate.value = target.date || target.dateISO || target.eventDate || "";
        if (form.eventDateEnd) {
          form.eventDateEnd.value = target.dateEnd || target.endDate || target.endDateISO || form.eventDate.value;
          form.eventDateEnd.min = form.eventDate.value;
        }
        if (form.dailySchedule) {
          form.dailySchedule.value = target.dailySchedule || "Same time each day";
        }
        handleDailyScheduleToggle();
        if (form.dailySchedule && form.dailySchedule.value === "Different time by day" && Array.isArray(target.dailySchedules)) {
          renderDailyScheduleRows();
          target.dailySchedules.forEach((ds) => {
            const row = document.querySelector(`.ce-daily-schedule-row[data-date="${ds.date}"]`);
            if (row) {
              const s = row.querySelector(".ce-daily-start-input");
              const e = row.querySelector(".ce-daily-end-input");
              if (s && ds.timeStart) s.value = ds.timeStart;
              if (e && ds.timeEnd) e.value = ds.timeEnd;
            }
          });
        }
        if (form.timeStart && target.timeStart) form.timeStart.value = target.timeStart;
        if (form.timeEnd && target.timeEnd) form.timeEnd.value = target.timeEnd;
        if (form.venue && target.venue) form.venue.value = target.venue;
        if (form.customVenueName && (target.customVenueName || target.venueName || target.building)) {
          form.customVenueName.value = target.customVenueName || target.venueName || target.building || "";
        }
        if (form.customVenueAddress && (target.customVenueAddress || target.venueAddress || target.roomNumber)) {
          form.customVenueAddress.value = target.customVenueAddress || target.venueAddress || target.roomNumber || "";
        }
        if (form.onlineMeetingLink && (target.onlineMeetingLink || target.meetingLink)) {
          form.onlineMeetingLink.value = target.onlineMeetingLink || target.meetingLink || "";
        }
        if (form.maxCapacity && target.maxCapacity) form.maxCapacity.value = target.maxCapacity;
        if (form.weatherContingency) form.weatherContingency.value = target.weatherContingency || target.venueType || "";
        if (form.registrationStart && target.registrationStart) form.registrationStart.value = target.registrationStart;
        if (form.registrationEnd) form.registrationEnd.value = target.registrationEnd || target.registrationDeadline || "";
        if (form.registrationDeadline) form.registrationDeadline.value = target.registrationEnd || target.registrationDeadline || "";
        if (form.description && target.description) form.description.value = target.description;
        if (form.rationale && target.rationale) form.rationale.value = target.rationale;

        if (form.keyDetails) {
          if (Array.isArray(target.keyDetails) && target.keyDetails.length) {
            form.keyDetails.value = target.keyDetails.map((k) => "• " + String(k).replace(/^[•\-\*]\s*/, "")).join("\n");
          } else if (typeof target.keyDetails === "string" && target.keyDetails) {
            form.keyDetails.value = target.keyDetails;
          } else {
            form.keyDetails.value = "• ";
          }
        }

        if (form.requirements) {
          if (Array.isArray(target.requirements) && target.requirements.length) {
            form.requirements.value = target.requirements.map((r) => "• " + String(r).replace(/^[•\-\*]\s*/, "")).join("\n");
          } else if (typeof target.requirements === "string" && target.requirements) {
            form.requirements.value = target.requirements;
          } else {
            form.requirements.value = "• ";
          }
        }

        if (form.contactName) form.contactName.value = target.contactPerson?.name || target.contactName || "";
        if (form.contactEmail) form.contactEmail.value = target.contactPerson?.email || target.contactEmail || "";
        if (form.contactPhone) {
          const ph = target.contactPerson?.phone || target.contactPhone || "";
          form.contactPhone.value = ph.startsWith("09") ? ph.slice(0, 11) : "09";
        }

        checkVenueCapacityHint();
        updateAllReadinessChecks();
        updateLivePreview();
        updateDescCounter();
        updateRationaleCounter();
        renderApprovers();
      }
    }
  }
})();
