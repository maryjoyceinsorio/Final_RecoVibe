import { auth, authReady, db, rtdb, functions, isFirebaseConfigured, isRtdbConfigured } from "../UserStudent/firebaseConfig.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { ref, onValue, off, get, child, set } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import { collection, getDocs, doc, getDoc, query, where } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js";

// DOM Element References
const organizerTodayDate = document.getElementById("organizerTodayDate");
const organizerAvatar = document.getElementById("organizerAvatar");
const organizerName = document.getElementById("organizerName");
const organizerRole = document.getElementById("organizerRole");
const organizerLogout = document.getElementById("organizerLogout");

const eventSelect = document.getElementById("eventSelect");
const metaDateTime = document.getElementById("metaDateTime");
const metaVenue = document.getElementById("metaVenue");
const metaCount = document.getElementById("metaCount");

const scanResultBanner = document.getElementById("scanResultBanner");
const bannerIconCol = document.getElementById("bannerIconCol");
const bannerStatusTitle = document.getElementById("bannerStatusTitle");
const bannerStudentName = document.getElementById("bannerStudentName");
const bannerStudentMeta = document.getElementById("bannerStudentMeta");
const bannerExtraNote = document.getElementById("bannerExtraNote");
const bannerActions = document.getElementById("bannerActions");
const btnWalkInConfirm = document.getElementById("btnWalkInConfirm");
const btnDismissBanner = document.getElementById("btnDismissBanner");

const walkInToggle = document.getElementById("walkInToggle");
const scannerLiveDot = document.getElementById("scannerLiveDot");
const btnToggleCamera = document.getElementById("btnToggleCamera");
const btnToggleCameraLabel = document.getElementById("btnToggleCameraLabel");
const btnSwitchCamera = document.getElementById("btnSwitchCamera");
const cameraPausedBox = document.getElementById("cameraPausedBox");
const btnResumePausedCamera = document.getElementById("btnResumePausedCamera");
const cameraErrorBox = document.getElementById("cameraErrorBox");
const cameraErrorTitle = document.getElementById("cameraErrorTitle");
const cameraErrorMessage = document.getElementById("cameraErrorMessage");
const btnRetryCamera = document.getElementById("btnRetryCamera");

const manualCheckInForm = document.getElementById("manualCheckInForm");
const manualStudentNo = document.getElementById("manualStudentNo");
const btnManualSubmit = document.getElementById("btnManualSubmit");
const manualValidationError = document.getElementById("manualValidationError");

const btnCompleteEvent = document.getElementById("btnCompleteEvent");
const scanEmptyEventsBox = document.getElementById("scanEmptyEventsBox");
const scanCompletedBanner = document.getElementById("scanCompletedBanner");
const completedBannerSummary = document.getElementById("completedBannerSummary");

const completeConfirmModalOverlay = document.getElementById("completeConfirmModalOverlay");
const btnCancelCompleteModal = document.getElementById("btnCancelCompleteModal");
const btnConfirmCompleteModal = document.getElementById("btnConfirmCompleteModal");
const confirmModalEventName = document.getElementById("confirmModalEventName");
const confirmModalWarning = document.getElementById("confirmModalWarning");
const confirmModalCheckedIn = document.getElementById("confirmModalCheckedIn");
const confirmModalWalkIns = document.getElementById("confirmModalWalkIns");
const confirmModalAbsent = document.getElementById("confirmModalAbsent");

const walkInConfirmModalOverlay = document.getElementById("walkInConfirmModalOverlay");
const walkInModalHeading = document.getElementById("walkInModalHeading");
const walkInModalDescription = document.getElementById("walkInModalDescription");
const btnCancelWalkInModal = document.getElementById("btnCancelWalkInModal");
const btnConfirmWalkInModal = document.getElementById("btnConfirmWalkInModal");

const manualConfirmModalOverlay = document.getElementById("manualConfirmModalOverlay");
const manualConfirmStudentNo = document.getElementById("manualConfirmStudentNo");
const manualConfirmWalkInNotice = document.getElementById("manualConfirmWalkInNotice");
const btnCancelManualConfirm = document.getElementById("btnCancelManualConfirm");
const btnAcceptManualConfirm = document.getElementById("btnAcceptManualConfirm");

const rosterTabsRow = document.getElementById("rosterTabsRow");
const tabCheckedIn = document.getElementById("tabCheckedIn");
const tabAbsent = document.getElementById("tabAbsent");
const tabCountCheckedIn = document.getElementById("tabCountCheckedIn");
const tabCountAbsent = document.getElementById("tabCountAbsent");
const rosterCountSubtitle = document.getElementById("rosterCountSubtitle");
const rosterTableHead = document.getElementById("rosterTableHead");
const rosterTableBody = document.getElementById("rosterTableBody");
const btnExportCsv = document.getElementById("btnExportCsv");

// Application State
let currentEvents = [];
let currentEventId = null;
const scanUrlParams = new URLSearchParams(window.location.search);
const requestedEventId = scanUrlParams.get("eventId")?.trim() || "";
const requestedEventContext = {
  id: requestedEventId,
  name: scanUrlParams.get("eventName")?.trim() || "",
  dateISO: scanUrlParams.get("eventDate")?.trim() || "",
  startAt: scanUrlParams.get("eventTime")?.trim() || "",
  venue: scanUrlParams.get("eventVenue")?.trim() || "",
  status: "published",
  allowWalkIn: false,
};
if (requestedEventContext.id && requestedEventContext.name) {
  const dateLabel = requestedEventContext.dateISO ? ` (${requestedEventContext.dateISO})` : "";
  eventSelect?.replaceChildren(new Option(
    `${requestedEventContext.name}${dateLabel}`,
    requestedEventContext.id,
    true,
    true,
  ));
  if (metaDateTime) {
    metaDateTime.textContent = requestedEventContext.dateISO
      ? `${requestedEventContext.dateISO}${requestedEventContext.startAt ? ` · ${requestedEventContext.startAt}` : ""}`
      : requestedEventContext.startAt || "Date TBA";
  }
  if (metaVenue) metaVenue.textContent = requestedEventContext.venue || "PUP Biñan Campus";
}
let activeAttendanceRef = null;
let currentAttendanceRows = [];
let currentAbsentRows = [];
let currentRosterTab = "checkedIn"; // "checkedIn" | "absent"
let html5QrCodeInstance = null;
let cameraStatus = "uninitialized"; // 'uninitialized' | 'running' | 'paused' | 'stopped'
let currentFacingMode = "environment"; // 'environment' | 'user'

let lastScannedText = "";
let lastScannedTime = 0;
let isScanThrottled = false;
let isWalkInAllowed = false;
let pendingWalkInToken = null;
let pendingWalkInState = null;
let pendingManualStudentNo = null;

// Initialize Date & Profile
(() => {
  if (organizerTodayDate) {
    organizerTodayDate.textContent = new Date().toLocaleDateString("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
    });
  }

  try {
    const orgProfile = JSON.parse(localStorage.getItem("recovibeOrganizerProfile") || "{}");
    const name = orgProfile.fullName || orgProfile.name ||
      [orgProfile.firstName, orgProfile.middleName, orgProfile.lastName].filter(Boolean).join(" ") || "Event Organizer";
    const isTeacher = false;
    /*
    const orgName = `${orgProfile.organization || "PUP Biñan"} account`;
    */
    const legacyOrgName = isTeacher
      ? (teacherProfile.department || teacherProfile.role || "Faculty")
      : `${orgProfile.organization || "PUP Biñan"} organizer`;
    if (organizerName) organizerName.textContent = name;
    if (organizerRole) organizerRole.textContent = "";
    if (organizerAvatar) {
      const initials = name.split(/\s+/).filter(Boolean).map(p => p[0]).slice(0, 2).join("").toUpperCase() || "EO";
      organizerAvatar.textContent = initials;
    }

    // Adapt sidebar links for Teacher session
    if (isTeacher) {
      const navLinks = document.querySelectorAll(".organizer-sidebar .nav-item");
      navLinks.forEach((link) => {
        const text = link.querySelector(".nav-label")?.textContent?.trim();
        if (text === "Dashboard") link.href = "../UserTeacher/TeacherDashBoard.html";
        else if (text === "All Events") link.href = "../UserTeacher/TeacherAllEvent.html";
        else if (text === "Calendar") link.href = "../UserTeacher/TeacherCalendar.html";
        else if (text === "Create Event") link.href = "../UserTeacher/TeacherCreate.html";
        else if (text === "My Events") {
          link.href = "../UserTeacher/TeacherMyEvent.html";
          link.classList.add("is-active");
        }
        else if (text === "Notifications") link.href = "../UserTeacher/TeacherNotification.html";
        else if (text === "Profile") link.href = "../UserTeacher/TeacherProfile.html";
        else if (text === "Scan Attendance" || text === "Activity Summary") {
          link.style.display = "none";
        }
      });
      if (organizerLogout) organizerLogout.href = "../UserTeacher/TeacherLogin.html";
      const emptyBtn = scanEmptyEventsBox?.querySelector("a");
      if (emptyBtn) emptyBtn.href = "../UserTeacher/TeacherMyEvent.html";
    }
    const orgName = `${orgProfile.organization || "PUP BiÃ±an"} account · ${orgProfile.accountNumber || orgProfile.accountNo || orgProfile.organizerNumber || orgProfile.organizerNo || "EO"}`;
    if (organizerName) organizerName.textContent = name;
    if (organizerRole) organizerRole.textContent = orgName;
    if (organizerAvatar) {
      const initials = name.split(/\s+/).filter(Boolean).map(p => p[0]).slice(0, 2).join("").toUpperCase() || "EO";
      organizerAvatar.textContent = initials;
    }
  } catch (err) {
    console.warn("Could not read profile:", err);
  }
})();

// Task 1: Auth & Role Guard (Must be event_organizer, teacher, or admin)
authReady.then(() => onAuthStateChanged(auth, async (user) => {
  if (!user) {
    // If running in development / demo mode with localStorage session, allow preview
    const localOrganizer = localStorage.getItem("recovibeOrganizerId");
    if (!localOrganizer && isFirebaseConfigured) {
      window.location.replace("EventOrganizerLogin.html");
      return;
    }
  } else if (rtdb) {
    try {
      const roleSnap = await get(ref(rtdb, `roles/${user.uid}`));
      const roleVal = roleSnap.val();
      const allowedRoles = ["event_organizer", "admin", "teacher"];
      if (roleVal && !allowedRoles.includes(roleVal)) {
        console.warn("Unauthorized role for scan attendance:", roleVal);
        window.location.replace("EventOrganizerLogin.html");
        return;
      }
    } catch (roleErr) {
      console.warn("Role check notice:", roleErr);
    }
  }

  initApp().catch((error) => {
    console.error("Could not initialize attendance events:", error);
    if (eventSelect) {
      eventSelect.replaceChildren(new Option("Couldn't load events. Please refresh.", ""));
    }
  });
})).catch((error) => {
  console.error("Could not restore organizer authentication state:", error);
});

if (organizerLogout) {
  organizerLogout.addEventListener("click", async (e) => {
    e.preventDefault();
    cleanupCamera();
    try {
      if (auth) await signOut(auth);
    } catch {}
    localStorage.removeItem("recovibeOrganizerId");
    localStorage.removeItem("recovibeOrganizerProfile");
    localStorage.removeItem("recovibeCurrentOrganizer");
    localStorage.removeItem("recovibeTeacherId");
    window.location.href = "EventOrganizerLogin.html";
  });
}

// Audio Feedback (Web Audio API)
function playSuccessChime() {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = "sine";
    osc.frequency.setValueAtTime(587.33, ctx.currentTime); // D5
    osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.12); // A5

    gain.gain.setValueAtTime(0.25, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.35);
  } catch (e) {
    console.warn("Web audio chime error:", e);
  }
}

function playWarningBuzz() {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = "triangle";
    osc.frequency.setValueAtTime(320, ctx.currentTime);
    osc.frequency.setValueAtTime(260, ctx.currentTime + 0.15);

    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.35);
  } catch (e) {
    console.warn("Web audio buzz error:", e);
  }
}

function playErrorTone() {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(180, ctx.currentTime);
    osc.frequency.setValueAtTime(140, ctx.currentTime + 0.15);

    gain.gain.setValueAtTime(0.35, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.4);
  } catch (e) {
    console.warn("Web audio error tone:", e);
  }
}

function triggerVibration(pattern) {
  try {
    if (navigator.vibrate) {
      navigator.vibrate(pattern);
    }
  } catch {}
}

// Task 4: Arm's-length Result Banner
function showResultBanner({ type, title, name, meta, note, allowWalkInAction, token }) {
  if (!scanResultBanner) return;

  scanResultBanner.hidden = false;
  scanResultBanner.className = `scan-result-banner banner-${type}`;

  if (bannerStatusTitle) bannerStatusTitle.textContent = title;
  if (bannerStudentName) {
    bannerStudentName.textContent = name;
    bannerStudentName.hidden = !name;
  }
  if (bannerStudentMeta) {
    bannerStudentMeta.textContent = meta;
    bannerStudentMeta.hidden = !meta;
  }
  if (bannerExtraNote) {
    if (note) {
      bannerExtraNote.textContent = note;
      bannerExtraNote.hidden = false;
    } else {
      bannerExtraNote.hidden = true;
    }
  }

  // Icons based on state
  let iconSvg = "";
  if (type === "ok") {
    iconSvg = `
      <svg viewBox="0 0 24 24" fill="none" stroke="#15803d" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
        <polyline points="22 4 12 14.01 9 11.01"/>
      </svg>
    `;
    playSuccessChime();
    triggerVibration([80]);
  } else if (type === "already") {
    iconSvg = `
      <svg viewBox="0 0 24 24" fill="none" stroke="#b45309" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="10"/>
        <polyline points="12 6 12 12 14 14"/>
      </svg>
    `;
    playWarningBuzz();
    triggerVibration([100, 50, 100]);
  } else if (type === "not-registered") {
    iconSvg = `
      <svg viewBox="0 0 24 24" fill="none" stroke="#b45309" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="10"/>
        <line x1="12" y1="8" x2="12" y2="12"/>
        <line x1="12" y1="16" x2="12.01" y2="16"/>
      </svg>
    `;
    playWarningBuzz();
    triggerVibration([100, 50, 100]);
  } else {
    // replaced or error
    iconSvg = `
      <svg viewBox="0 0 24 24" fill="none" stroke="#b91c1c" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="10"/>
        <line x1="15" y1="9" x2="9" y2="15"/>
        <line x1="9" y1="9" x2="15" y2="15"/>
      </svg>
    `;
    playErrorTone();
    triggerVibration([120, 60, 120]);
  }
  if (bannerIconCol) bannerIconCol.innerHTML = iconSvg;

  // Walk-in action button for "not_registered"
  if (allowWalkInAction && token) {
    pendingWalkInToken = token;
    if (bannerActions) bannerActions.hidden = false;
  } else {
    pendingWalkInToken = null;
    if (bannerActions) bannerActions.hidden = true;
  }
}

function dismissBanner() {
  if (scanResultBanner) {
    scanResultBanner.hidden = true;
  }
  pendingWalkInToken = null;
}

if (btnDismissBanner) {
  btnDismissBanner.addEventListener("click", dismissBanner);
}

if (btnWalkInConfirm) {
  btnWalkInConfirm.addEventListener("click", async () => {
    if (!pendingWalkInToken || !currentEventId) return;
    const tokenToProcess = pendingWalkInToken;
    const confirmed = window.confirm("Are you sure you want to check in this student as a walk-in attendee?");
    if (!confirmed) return;
    dismissBanner();
    await processAttendance({
      eventId: currentEventId,
      token: tokenToProcess,
      allowWalkIn: true,
    });
  });
}


// Task 2: Event Selector & Default to Today / Next Upcoming
async function loadEventsList() {
  const eventsMap = new Map();

  // Start the realtime load without blocking the Firestore event list.
  const realtimeEventsPromise = (async () => {
    if (!rtdb) return;
    try {
      const snap = await get(ref(rtdb, "events"));
      const rtdbEvents = snap.val();
      if (rtdbEvents && typeof rtdbEvents === "object") {
        Object.entries(rtdbEvents).forEach(([id, val]) => {
          if (val && typeof val === "object") {
            const status = String(val.status || "published").trim().toLowerCase();
            if (status === "published" || status === "completed") {
              eventsMap.set(String(id), {
                id: String(id),
                name: val.name || val.title || `Event #${id}`,
                startAt: val.startAt || val.dateISO || val.date || "",
                endAt: val.endAt || "",
                venue: val.venue || val.location || "PUP Biñan Campus",
                dateISO: val.dateISO || (val.startAt ? String(val.startAt).slice(0, 10) : ""),
                status: status,
                completedAt: val.completedAt || null,
                allowWalkIn: Boolean(val.allowWalkIn),
              });
            }
          }
        });
      }
    } catch (e) {
      console.warn("RTDB events fetch notice:", e);
    }
  })();

  // Load Firestore events and tolerate an unavailable query without discarding
  // results from the other queries.
  if (db) {
    const eventsRef = collection(db, "events");
    const eventRequests = [
      getDocs(query(eventsRef, where("status", "in", ["published", "completed"]))),
      getDocs(query(eventsRef, where("published", "==", true))),
      getDocs(query(eventsRef, where("isPublished", "==", true))),
    ];
    if (requestedEventId) {
      eventRequests.push(getDoc(doc(db, "events", requestedEventId)));
    }

    const eventResults = await Promise.allSettled(eventRequests);
    const eventDocuments = new Map();
    eventResults.forEach((result, index) => {
      if (result.status === "rejected") {
        console.warn("Firestore attendance event query notice:", result.reason);
        return;
      }

      const resultValue = result.value;
      if (Array.isArray(resultValue.docs)) {
        resultValue.docs.forEach((document) => {
          eventDocuments.set(document.id, document);
        });
      } else if (index === eventRequests.length - 1 && resultValue.exists()) {
        eventDocuments.set(resultValue.id, resultValue);
      }
    });

    eventDocuments.forEach((document) => {
      const data = document.data();
      const id = document.id;
      let status = String(data.status || "").trim().toLowerCase();
      if (!["published", "completed"].includes(status) &&
          (data.published === true || data.isPublished === true)) {
        status = "published";
      }
      if (status === "published" || status === "completed") {
        eventsMap.set(String(id), {
          id: String(id),
          name: data.eventName || data.title || `Event #${id}`,
          startAt: data.startTime || data.dateISO || data.eventDate || "",
          endAt: data.endTime || "",
          venue: data.venue || data.location || "PUP Biñan Campus",
          dateISO: data.eventDate || data.dateISO || "",
          status: status,
          completedAt: data.completedAt || null,
          allowWalkIn: Boolean(data.allowWalkIn),
        });
      }
    });
  }

  // Load local events before rendering so Firestore results can be supplemented.
  ["recovibeOrganizerEvents", "recovibeTeacherEvents", "recovibeEvents"].forEach((storageKey) => {
    try {
      const stored = JSON.parse(localStorage.getItem(storageKey) || "[]");
      if (Array.isArray(stored)) {
        stored.forEach((ev) => {
          const id = String(ev.id || ev.eventId);
          const rawStatus = String(ev.status || "published").toLowerCase();
          const isEligible = ["published", "approved", "completed"].includes(rawStatus);
          const normStatus = rawStatus === "completed" ? "completed" : "published";
          if (id && !eventsMap.has(id) && isEligible) {
            eventsMap.set(id, {
              id,
              name: ev.title || ev.eventName || `Event #${id}`,
              startAt: ev.time || ev.startTime || "",
              endAt: ev.endTime || "",
              venue: ev.venue || ev.location || "PUP Biñan Campus",
              dateISO: ev.dateISO || ev.date || "",
              status: normStatus,
              completedAt: ev.completedAt || null,
              allowWalkIn: Boolean(ev.allowWalkIn),
            });
          }
        });
      }
    } catch {}
  });

  if (requestedEventContext.id && !eventsMap.has(requestedEventContext.id) && requestedEventContext.name) {
    eventsMap.set(requestedEventContext.id, requestedEventContext);
  }

  currentEvents = Array.from(eventsMap.values());
  populateEventDropdown();

  await realtimeEventsPromise;
  currentEvents = Array.from(eventsMap.values());
  populateEventDropdown();
}

function populateEventDropdown() {
  const scanEventCard = document.querySelector(".scan-event-card");
  const scanLayoutGrid = document.querySelector(".scan-layout-grid");
  const scanRosterSection = document.querySelector(".scan-attendance-list-section");

  // Empty state when no events are published or completed
  if (currentEvents.length === 0) {
    if (scanEmptyEventsBox) scanEmptyEventsBox.hidden = false;
    if (scanEventCard) scanEventCard.style.display = "none";
    if (scanLayoutGrid) scanLayoutGrid.style.display = "none";
    if (scanRosterSection) scanRosterSection.style.display = "none";
    return;
  }

  if (scanEmptyEventsBox) scanEmptyEventsBox.hidden = true;
  if (scanEventCard) scanEventCard.style.display = "";
  if (scanLayoutGrid) scanLayoutGrid.style.display = "";
  if (scanRosterSection) scanRosterSection.style.display = "";

  if (!eventSelect) return;
  eventSelect.innerHTML = "";

  let bestMatchEvent = null;

  if (requestedEventId) {
    bestMatchEvent = currentEvents.find((e) => String(e.id) === requestedEventId);
  }

  const todayStr = new Date().toISOString().slice(0, 10);

  // 1. Look for event happening today
  if (!bestMatchEvent) {
    bestMatchEvent = currentEvents.find((e) => e.dateISO === todayStr && e.status === "published");
  }

  // 2. Otherwise find next upcoming published event
  if (!bestMatchEvent) {
    const upcoming = currentEvents
      .filter((e) => e.dateISO && e.dateISO >= todayStr && e.status === "published")
      .sort((a, b) => a.dateISO.localeCompare(b.dateISO));
    if (upcoming.length > 0) bestMatchEvent = upcoming[0];
  }

  // 3. Fallback to any published or first event
  if (!bestMatchEvent) {
    bestMatchEvent = currentEvents.find((e) => e.status === "published") || currentEvents[0];
  }

  currentEvents.forEach((event) => {
    const opt = document.createElement("option");
    opt.value = event.id;
    const dateLabel = event.dateISO ? ` (${event.dateISO})` : "";
    const statusLabel = event.status === "completed" ? " [Completed]" : "";
    opt.textContent = `${event.name}${dateLabel}${statusLabel}`;
    eventSelect.appendChild(opt);
  });

  if (bestMatchEvent) {
    eventSelect.value = bestMatchEvent.id;
    if (String(currentEventId) !== String(bestMatchEvent.id)) {
      selectEvent(bestMatchEvent.id);
    }
  }

  eventSelect.onchange = (e) => {
    selectEvent(e.target.value);
  };
}

async function selectEvent(eventId) {
  if (!eventId) return;
  currentEventId = eventId;
  const ev = currentEvents.find((e) => String(e.id) === String(eventId));
  if (!ev) return;

  const todayStr = new Date().toISOString().slice(0, 10);
  const dateFormatted = ev.dateISO || "Date TBA";
  const timeFormatted = ev.startAt ? ` · ${ev.startAt}` : "";
  if (metaDateTime) metaDateTime.textContent = `${dateFormatted}${timeFormatted}`;
  if (metaVenue) metaVenue.textContent = ev.venue || "PUP Biñan Campus";

  const isCompleted = ev.status === "completed";
  const scanLayoutGrid = document.querySelector(".scan-layout-grid");

  if (isCompleted) {
    if (btnCompleteEvent) btnCompleteEvent.hidden = true;
    if (walkInToggle) walkInToggle.disabled = true;

    if (scanLayoutGrid) scanLayoutGrid.style.display = "none";
    if (scanCompletedBanner) scanCompletedBanner.hidden = false;
    if (rosterTabsRow) rosterTabsRow.hidden = false;

    await stopCameraScanner();
  } else {
    if (btnCompleteEvent) btnCompleteEvent.hidden = false;
    if (walkInToggle) walkInToggle.disabled = false;
    if (scanLayoutGrid) scanLayoutGrid.style.display = "";
    if (scanCompletedBanner) scanCompletedBanner.hidden = true;
    if (rosterTabsRow) rosterTabsRow.hidden = true;

    // Reset tab to checked in
    currentRosterTab = "checkedIn";
    if (tabCheckedIn) tabCheckedIn.classList.add("is-active");
    if (tabAbsent) tabAbsent.classList.remove("is-active");

    if (cameraStatus !== "running") {
      startCameraScanner();
    }
  }

  // Restore walk-in policy for selected event
  const savedWalkIn = localStorage.getItem(`recovibe_walkin_${eventId}`);
  if (savedWalkIn !== null) {
    applyWalkInState(savedWalkIn === "true");
  } else {
    applyWalkInState(Boolean(ev.allowWalkIn));
  }

  // Subscribe to real-time attendance for selected event (Task 7 & 8)
  subscribeAttendance(eventId, isCompleted);
}

// Tasks 7 & 8: Real-time Attendance Listener & Table
function subscribeAttendance(eventId, isCompleted) {
  if (activeAttendanceRef) {
    off(activeAttendanceRef);
    activeAttendanceRef = null;
  }

  currentAttendanceRows = [];
  currentAbsentRows = [];
  updateRosterDisplay();

  if (!rtdb) {
    try {
      const saved = JSON.parse(localStorage.getItem(`recovibe_attendance_${eventId}`) || "[]");
      currentAttendanceRows = saved;
      updateRosterDisplay();
    } catch {}
    return;
  }

  activeAttendanceRef = ref(rtdb, `attendance/${eventId}`);
  onValue(activeAttendanceRef, async (snapshot) => {
    const data = snapshot.val();
    const rows = [];
    if (data && typeof data === "object") {
      Object.entries(data).forEach(([uid, row]) => {
        if (row && typeof row === "object") {
          rows.push({
            uid,
            scannedAt: row.scannedAt || Date.now(),
            scannedBy: row.scannedBy || "Event Organizer",
            walkIn: Boolean(row.walkIn),
            name: row.name || row.studentName || row.student?.name || "Student",
            studentNo: row.studentNo || row.studentNumber || row.student?.studentNo || uid,
            organization: row.organization || row.student?.organization || "PUP Biñan",
          });
        }
      });
    }

    // Sort newest first
    rows.sort((a, b) => Number(b.scannedAt) - Number(a.scannedAt));
    currentAttendanceRows = rows;

    await refreshAbsentRows(eventId, rows);
    updateRosterDisplay();
  }, (err) => {
    console.warn("RTDB attendance listener notice:", err);
  });
}

async function refreshAbsentRows(eventId, checkedInRows) {
  if (!rtdb) return;
  try {
    const absSnap = await get(ref(rtdb, `absences/${eventId}`));
    const absData = absSnap.val();
    if (absData && typeof absData === "object" && Object.keys(absData).length > 0) {
      currentAbsentRows = Object.entries(absData).map(([uid, r]) => ({
        uid,
        name: r.name || "Student",
        studentNo: r.studentNo || uid,
        organization: r.organization || "PUP Biñan",
      }));
    } else {
      const regSnap = await get(ref(rtdb, `registrations/${eventId}`));
      const regData = regSnap.val() || {};
      const checkedUids = new Set(checkedInRows.map((r) => r.uid));
      currentAbsentRows = [];
      Object.entries(regData).forEach(([uid, r]) => {
        if (!checkedUids.has(uid)) {
          currentAbsentRows.push({
            uid,
            name: r.name || r.studentName || "Student",
            studentNo: r.studentNo || r.studentNumber || uid,
            organization: r.organization || "PUP Biñan",
          });
        }
      });
    }
  } catch (e) {
    console.warn("Error refreshing absent rows:", e);
  }
}

function updateRosterDisplay() {
  const countCheckedIn = currentAttendanceRows.length;
  const countWalkIns = currentAttendanceRows.filter((r) => r.walkIn).length;
  const countAbsent = currentAbsentRows.length;

  if (metaCount) metaCount.textContent = `${countCheckedIn} checked in`;
  if (tabCountCheckedIn) tabCountCheckedIn.textContent = countCheckedIn;
  if (tabCountAbsent) tabCountAbsent.textContent = countAbsent;

  if (completedBannerSummary) {
    completedBannerSummary.textContent = `Checked in: ${countCheckedIn} · Walk-ins: ${countWalkIns} · Absent: ${countAbsent}`;
  }

  if (rosterCountSubtitle) {
    if (currentRosterTab === "checkedIn") {
      rosterCountSubtitle.textContent = `${countCheckedIn} student${countCheckedIn === 1 ? "" : "s"} checked in`;
    } else {
      rosterCountSubtitle.textContent = `${countAbsent} student${countAbsent === 1 ? "" : "s"} absent`;
    }
  }

  if (!rosterTableBody) return;

  if (currentRosterTab === "checkedIn") {
    if (rosterTableHead) {
      rosterTableHead.innerHTML = `
        <tr>
          <th scope="col">Time</th>
          <th scope="col">Student Name</th>
          <th scope="col">Student Number</th>
          <th scope="col">Organization</th>
          <th scope="col">Type</th>
          <th scope="col">Scanned By</th>
        </tr>
      `;
    }
    if (countCheckedIn === 0) {
      rosterTableBody.innerHTML = `
        <tr class="empty-state-row">
          <td colspan="6">
            <div class="empty-table-placeholder">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="32" height="32" aria-hidden="true">
                <circle cx="12" cy="12" r="10"/>
                <path d="M12 8v4M12 16h.01"/>
              </svg>
              <p>No check-ins recorded yet for this event.</p>
            </div>
          </td>
        </tr>
      `;
      return;
    }

    rosterTableBody.innerHTML = currentAttendanceRows
      .map((row) => {
        const date = new Date(row.scannedAt);
        const timeStr = !Number.isNaN(date.getTime())
          ? date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit" })
          : "Just now";
        const typeBadge = row.walkIn
          ? `<span class="badge-tag badge-walkin">Walk-in</span>`
          : `<span class="badge-tag badge-registered">Registered</span>`;

        return `
          <tr>
            <td><strong>${timeStr}</strong></td>
            <td>${escapeHtml(row.name)}</td>
            <td><code>${escapeHtml(row.studentNo)}</code></td>
            <td>${escapeHtml(row.organization)}</td>
            <td>${typeBadge}</td>
            <td><small>${escapeHtml(row.scannedBy)}</small></td>
          </tr>
        `;
      })
      .join("");
  } else {
    if (rosterTableHead) {
      rosterTableHead.innerHTML = `
        <tr>
          <th scope="col">Time</th>
          <th scope="col">Student Name</th>
          <th scope="col">Student Number</th>
          <th scope="col">Organization</th>
          <th scope="col">Status</th>
          <th scope="col">Scanned By</th>
        </tr>
      `;
    }
    if (countAbsent === 0) {
      rosterTableBody.innerHTML = `
        <tr class="empty-state-row">
          <td colspan="6">
            <div class="empty-table-placeholder">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="32" height="32" aria-hidden="true">
                <circle cx="12" cy="12" r="10"/>
                <path d="M12 8v4M12 16h.01"/>
              </svg>
              <p>No absent students recorded for this event.</p>
            </div>
          </td>
        </tr>
      `;
      return;
    }

    rosterTableBody.innerHTML = currentAbsentRows
      .map((row) => {
        return `
          <tr>
            <td><strong>—</strong></td>
            <td>${escapeHtml(row.name)}</td>
            <td><code>${escapeHtml(row.studentNo)}</code></td>
            <td>${escapeHtml(row.organization)}</td>
            <td><span class="badge-tag" style="background:#fee2e2;color:#991b1b;border:1px solid #fca5a5;">Absent</span></td>
            <td><small>—</small></td>
          </tr>
        `;
      })
      .join("");
  }
}

function escapeHtml(str) {
  return String(str || "").replace(/[&<>"']/g, (m) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[m]));
}

// Roster Tabs
if (tabCheckedIn) {
  tabCheckedIn.addEventListener("click", () => {
    currentRosterTab = "checkedIn";
    tabCheckedIn.classList.add("is-active");
    if (tabAbsent) tabAbsent.classList.remove("is-active");
    updateRosterDisplay();
  });
}

if (tabAbsent) {
  tabAbsent.addEventListener("click", () => {
    currentRosterTab = "absent";
    tabAbsent.classList.add("is-active");
    if (tabCheckedIn) tabCheckedIn.classList.remove("is-active");
    updateRosterDisplay();
  });
}

// Complete Event Button & Modal Validation
if (btnCompleteEvent) {
  btnCompleteEvent.addEventListener("click", async () => {
    // 1. Validation: check if an event is selected
    if (!currentEventId) {
      alert("Please select an active event first.");
      return;
    }

    const ev = currentEvents.find((e) => String(e.id) === String(currentEventId));
    if (!ev) {
      alert("Selected event could not be found. Please choose an event from the list.");
      return;
    }

    // 2. Validation: check if event is already completed
    if (ev.status === "completed") {
      alert(`"${ev.name || "This event"}" has already been marked as completed.`);
      btnCompleteEvent.hidden = true;
      return;
    }

    btnCompleteEvent.disabled = true;
    btnCompleteEvent.textContent = "Validating...";

    try {
      let regSnap = null;
      let attSnap = null;
      if (rtdb) {
        [regSnap, attSnap] = await Promise.all([
          get(ref(rtdb, `registrations/${currentEventId}`)),
          get(ref(rtdb, `attendance/${currentEventId}`)),
        ]);
      }
      const regData = regSnap?.val() || {};
      const attData = attSnap?.val() || {};

      let totalCheckedIn = 0;
      let totalWalkIns = 0;
      Object.values(attData).forEach((row) => {
        if (row) {
          totalCheckedIn++;
          if (row.walkIn) totalWalkIns++;
        }
      });

      let totalAbsent = 0;
      Object.keys(regData).forEach((uid) => {
        if (!attData[uid]) totalAbsent++;
      });

      // Populate counts in modal
      if (confirmModalCheckedIn) confirmModalCheckedIn.textContent = totalCheckedIn;
      if (confirmModalWalkIns) confirmModalWalkIns.textContent = totalWalkIns;
      if (confirmModalAbsent) confirmModalAbsent.textContent = totalAbsent;

      // Populate event name
      if (confirmModalEventName) {
        confirmModalEventName.textContent = ev.name || ev.title || "this event";
      }

      // Validation warnings: zero attendees or future date
      const todayStr = new Date().toISOString().slice(0, 10);
      const isFuture = Boolean(ev.dateISO && ev.dateISO > todayStr);
      const hasZeroCheckIns = totalCheckedIn === 0;

      if (confirmModalWarning) {
        if (hasZeroCheckIns && isFuture) {
          confirmModalWarning.textContent = `Caution: This event is scheduled for a future date (${ev.dateISO}) and has 0 attendees checked in. Completing it will immediately finalize attendance and record all registered attendees as absent.`;
          confirmModalWarning.hidden = false;
        } else if (hasZeroCheckIns) {
          confirmModalWarning.textContent = "Notice: 0 attendees have checked in so far. Completing this event will record all registered students as absent.";
          confirmModalWarning.hidden = false;
        } else if (isFuture) {
          confirmModalWarning.textContent = `Notice: This event is scheduled for a future date (${ev.dateISO}). Completing it will close attendance immediately.`;
          confirmModalWarning.hidden = false;
        } else {
          confirmModalWarning.hidden = true;
        }
      }

      if (completeConfirmModalOverlay) completeConfirmModalOverlay.hidden = false;
      btnCancelCompleteModal?.focus();
    } catch (e) {
      console.warn("Complete event precheck notice:", e);
      if (confirmModalCheckedIn) confirmModalCheckedIn.textContent = currentAttendanceRows.length;
      if (confirmModalWalkIns) confirmModalWalkIns.textContent = currentAttendanceRows.filter((r) => r.walkIn).length;
      if (confirmModalAbsent) confirmModalAbsent.textContent = currentAbsentRows.length;
      if (confirmModalEventName) confirmModalEventName.textContent = ev.name || ev.title || "this event";
      if (completeConfirmModalOverlay) completeConfirmModalOverlay.hidden = false;
      btnCancelCompleteModal?.focus();
    } finally {
      btnCompleteEvent.disabled = false;
      btnCompleteEvent.textContent = "Complete event";
    }
  });
}

function closeCompleteModal() {
  if (completeConfirmModalOverlay) {
    completeConfirmModalOverlay.hidden = true;
    btnCompleteEvent?.focus();
  }
}

if (btnCancelCompleteModal) {
  btnCancelCompleteModal.addEventListener("click", closeCompleteModal);
}

if (completeConfirmModalOverlay) {
  completeConfirmModalOverlay.addEventListener("click", (e) => {
    if (e.target === completeConfirmModalOverlay) {
      closeCompleteModal();
    }
  });
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (completeConfirmModalOverlay && !completeConfirmModalOverlay.hidden) {
      closeCompleteModal();
    }
    if (walkInConfirmModalOverlay && !walkInConfirmModalOverlay.hidden) {
      if (typeof closeWalkInModal === "function") closeWalkInModal();
      else walkInConfirmModalOverlay.hidden = true;
    }
    if (manualConfirmModalOverlay && !manualConfirmModalOverlay.hidden) {
      if (typeof closeManualConfirmModal === "function") closeManualConfirmModal();
      else manualConfirmModalOverlay.hidden = true;
    }
  }
});

if (btnConfirmCompleteModal) {
  btnConfirmCompleteModal.addEventListener("click", async () => {
    if (!currentEventId) return;

    const ev = currentEvents.find((e) => String(e.id) === String(currentEventId));
    if (!ev) return;

    btnConfirmCompleteModal.disabled = true;
    btnConfirmCompleteModal.textContent = "Completing...";

    try {
      if (functions && navigator.onLine) {
        const compFn = httpsCallable(functions, "completeEvent");
        await compFn({ eventId: currentEventId });
      } else if (rtdb) {
        await set(ref(rtdb, `events/${currentEventId}/status`), "completed");
        await set(ref(rtdb, `events/${currentEventId}/completedAt`), Date.now());
      }

      ev.status = "completed";
      ev.completedAt = Date.now();

      // Persist to localStorage across all relevant lists
      ["recovibeOrganizerEvents", "recovibeTeacherEvents", "recovibeEvents"].forEach((key) => {
        try {
          const list = JSON.parse(localStorage.getItem(key) || "[]");
          if (Array.isArray(list)) {
            let updated = false;
            list.forEach((item) => {
              if (String(item.id || item.eventId) === String(currentEventId)) {
                item.status = "completed";
                item.completedAt = Date.now();
                updated = true;
              }
            });
            if (updated) {
              localStorage.setItem(key, JSON.stringify(list));
            }
          }
        } catch (e) {}
      });

      if (completeConfirmModalOverlay) completeConfirmModalOverlay.hidden = true;
      selectEvent(currentEventId);
    } catch (err) {
      alert("Could not complete event: " + (err.message || err));
    } finally {
      btnConfirmCompleteModal.disabled = false;
      btnConfirmCompleteModal.textContent = "Confirm & Complete";
    }
  });
}

// Task 9: CSV Export (Exports active tab: Checked in or Absent)
if (btnExportCsv) {
  btnExportCsv.addEventListener("click", () => {
    const ev = currentEvents.find((e) => String(e.id) === String(currentEventId));
    const eventTitle = ev ? ev.name : "Event";
    const dateStamp = new Date().toISOString().slice(0, 10);
    const safeName = eventTitle.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 30);

    if (currentRosterTab === "checkedIn") {
      if (!currentAttendanceRows || currentAttendanceRows.length === 0) {
        alert("No attendance records to export yet.");
        return;
      }
      const headers = ["Timestamp", "Check-in Time", "Student Name", "Student Number", "Organization", "Attendance Type", "Scanned By"];
      const csvLines = [headers.join(",")];
      currentAttendanceRows.forEach((row) => {
        const d = new Date(row.scannedAt);
        const timeStr = !Number.isNaN(d.getTime()) ? d.toLocaleTimeString("en-US") : "";
        const dateStr = !Number.isNaN(d.getTime()) ? d.toISOString() : "";
        const typeStr = row.walkIn ? "Walk-in" : "Registered";
        csvLines.push([
          `"${dateStr}"`,
          `"${timeStr}"`,
          `"${(row.name || "").replace(/"/g, '""')}"`,
          `"${(row.studentNo || "").replace(/"/g, '""')}"`,
          `"${(row.organization || "").replace(/"/g, '""')}"`,
          `"${typeStr}"`,
          `"${(row.scannedBy || "").replace(/"/g, '""')}"`,
        ].join(","));
      });
      downloadCsv(csvLines.join("\r\n"), `attendance-${safeName}-${dateStamp}.csv`);
    } else {
      if (!currentAbsentRows || currentAbsentRows.length === 0) {
        alert("No absent records to export.");
        return;
      }
      const headers = ["Event", "Student Name", "Student Number", "Organization", "Status"];
      const csvLines = [headers.join(",")];
      currentAbsentRows.forEach((row) => {
        csvLines.push([
          `"${eventTitle.replace(/"/g, '""')}"`,
          `"${(row.name || "").replace(/"/g, '""')}"`,
          `"${(row.studentNo || "").replace(/"/g, '""')}"`,
          `"${(row.organization || "").replace(/"/g, '""')}"`,
          `"Absent"`,
        ].join(","));
      });
      downloadCsv(csvLines.join("\r\n"), `absent-${safeName}-${dateStamp}.csv`);
    }
  });
}

function downloadCsv(content, filename) {
  const csvContent = "\uFEFF" + content; // UTF-8 BOM
  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.download = filename;
  a.href = url;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// Task 3: Camera Scanner with html5-qrcode
async function startCameraScanner() {
  if (typeof window.Html5Qrcode === "undefined") {
    console.warn("html5-qrcode library is not loaded yet.");
    return;
  }

  const readerElement = document.getElementById("qrReader");
  if (!readerElement) return;

  if (cameraErrorBox) cameraErrorBox.hidden = true;
  if (cameraPausedBox) cameraPausedBox.hidden = true;

  try {
    if (!html5QrCodeInstance) {
      html5QrCodeInstance = new window.Html5Qrcode("qrReader");
    }

    const config = {
      fps: 10,
      qrbox: (viewfinderWidth, viewfinderHeight) => {
        const edge = Math.min(viewfinderWidth, viewfinderHeight) * 0.75;
        return { width: Math.max(220, Math.floor(edge)), height: Math.max(220, Math.floor(edge)) };
      },
      aspectRatio: 1.0,
    };

    cameraStatus = "starting";
    await html5QrCodeInstance.start(
      { facingMode: currentFacingMode },
      config,
      onScanSuccess,
      onScanFailure,
    );

    cameraStatus = "running";
    if (scannerLiveDot) scannerLiveDot.classList.remove("dot-paused", "dot-error");
    if (btnToggleCameraLabel) btnToggleCameraLabel.textContent = "Pause camera";
  } catch (err) {
    console.error("Camera start error:", err);
    cameraStatus = "stopped";
    if (scannerLiveDot) scannerLiveDot.classList.add("dot-paused", "dot-error");
    if (btnToggleCameraLabel) btnToggleCameraLabel.textContent = "Start camera";

    if (cameraErrorBox) {
      cameraErrorBox.hidden = false;
      const isDenied = err && (err.name === "NotAllowedError" || String(err).includes("denied") || String(err).includes("Permission"));
      if (cameraErrorTitle) {
        cameraErrorTitle.textContent = isDenied ? "Camera permission denied" : "Camera unavailable";
      }
      if (cameraErrorMessage) {
        cameraErrorMessage.textContent = isDenied
          ? "Please allow camera access in your browser settings to scan attendance QR codes at the door."
          : "Could not access the camera. Please check device permissions or use manual student number check-in.";
      }
    }
  }
}

async function pauseCameraScanner() {
  if (html5QrCodeInstance && cameraStatus === "running") {
    try {
      if (typeof html5QrCodeInstance.pause === "function") {
        html5QrCodeInstance.pause(true);
      } else {
        await html5QrCodeInstance.stop();
      }
    } catch (e) {
      console.warn("Error pausing camera:", e);
    }
  }
  cameraStatus = "paused";
  if (scannerLiveDot) scannerLiveDot.classList.add("dot-paused");
  if (cameraPausedBox) cameraPausedBox.hidden = false;
  if (btnToggleCameraLabel) btnToggleCameraLabel.textContent = "Resume camera";
}

async function resumeCameraScanner() {
  if (cameraPausedBox) cameraPausedBox.hidden = true;
  if (html5QrCodeInstance && cameraStatus === "paused") {
    try {
      if (typeof html5QrCodeInstance.resume === "function") {
        html5QrCodeInstance.resume();
        cameraStatus = "running";
        if (scannerLiveDot) scannerLiveDot.classList.remove("dot-paused", "dot-error");
        if (btnToggleCameraLabel) btnToggleCameraLabel.textContent = "Pause camera";
        return;
      }
    } catch (e) {
      console.warn("Resume failed, restarting:", e);
    }
  }
  await startCameraScanner();
}

async function stopCameraScanner() {
  if (html5QrCodeInstance && (cameraStatus === "running" || cameraStatus === "paused")) {
    try {
      await html5QrCodeInstance.stop();
    } catch (e) {
      console.warn("Error stopping camera:", e);
    }
  }
  cameraStatus = "stopped";
  if (cameraPausedBox) cameraPausedBox.hidden = true;
  if (scannerLiveDot) scannerLiveDot.classList.add("dot-paused");
  if (btnToggleCameraLabel) btnToggleCameraLabel.textContent = "Start camera";
}

function cleanupCamera() {
  if (html5QrCodeInstance) {
    try {
      html5QrCodeInstance.stop().catch(() => {});
    } catch {}
  }
}

window.addEventListener("beforeunload", cleanupCamera);

if (btnRetryCamera) {
  btnRetryCamera.addEventListener("click", async () => {
    btnRetryCamera.disabled = true;
    const oldText = btnRetryCamera.textContent;
    btnRetryCamera.textContent = "Connecting...";
    try {
      await startCameraScanner();
    } finally {
      btnRetryCamera.disabled = false;
      btnRetryCamera.textContent = oldText;
    }
  });
}

if (btnResumePausedCamera) {
  btnResumePausedCamera.addEventListener("click", async () => {
    await resumeCameraScanner();
  });
}

if (btnToggleCamera) {
  btnToggleCamera.addEventListener("click", async () => {
    if (cameraStatus === "running") {
      await pauseCameraScanner();
    } else if (cameraStatus === "paused") {
      await resumeCameraScanner();
    } else {
      await startCameraScanner();
    }
  });
}

if (btnSwitchCamera) {
  btnSwitchCamera.addEventListener("click", async () => {
    if (cameraStatus !== "running" && cameraStatus !== "paused") {
      alert("Please start the camera before switching camera views.");
      return;
    }
    currentFacingMode = currentFacingMode === "environment" ? "user" : "environment";
    await stopCameraScanner();
    await startCameraScanner();
  });
}

// Walk-in Toggle with Confirmation Modal
function stripStudentNo(val) {
  return String(val || "").replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
}

function applyWalkInState(newState) {
  isWalkInAllowed = Boolean(newState);
  if (walkInToggle) {
    walkInToggle.checked = isWalkInAllowed;
    walkInToggle.setAttribute("aria-checked", String(isWalkInAllowed));
  }
  if (currentEventId) {
    try {
      localStorage.setItem(`recovibe_walkin_${currentEventId}`, isWalkInAllowed ? "true" : "false");
    } catch {}
    if (rtdb) {
      try {
        set(ref(rtdb, `events/${currentEventId}/allowWalkIn`), isWalkInAllowed);
      } catch {}
    }
  }
}

function openWalkInModal(targetState) {
  pendingWalkInState = targetState;

  if (walkInModalHeading) {
    walkInModalHeading.textContent = targetState
      ? "Allow Walk-In Attendance?"
      : "Disable Walk-In Attendance?";
  }
  if (walkInModalDescription) {
    walkInModalDescription.innerHTML = targetState
      ? "Are you sure you want to <strong>allow walk-ins</strong>? Students who are not registered in advance will be permitted to check in at the entrance."
      : "Are you sure you want to <strong>disable walk-ins</strong>? Only students who are pre-registered will be permitted to check in.";
  }
  if (btnConfirmWalkInModal) {
    btnConfirmWalkInModal.textContent = targetState
      ? "Yes, Allow Walk-ins"
      : "Yes, Restrict Walk-ins";
  }
  if (walkInConfirmModalOverlay) {
    walkInConfirmModalOverlay.hidden = false;
  }
  btnConfirmWalkInModal?.focus();
}

function closeWalkInModal() {
  if (walkInConfirmModalOverlay) {
    walkInConfirmModalOverlay.hidden = true;
  }
  pendingWalkInState = null;
  // Always synchronize toggle visual to actual confirmed state
  if (walkInToggle) {
    walkInToggle.checked = isWalkInAllowed;
    walkInToggle.setAttribute("aria-checked", String(isWalkInAllowed));
  }
}

if (walkInToggle) {
  walkInToggle.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (walkInToggle.disabled) return;
    const targetState = !isWalkInAllowed;
    openWalkInModal(targetState);
  });
}

if (btnCancelWalkInModal) {
  btnCancelWalkInModal.addEventListener("click", closeWalkInModal);
}

if (btnConfirmWalkInModal) {
  btnConfirmWalkInModal.addEventListener("click", () => {
    if (pendingWalkInState !== null) {
      applyWalkInState(pendingWalkInState);
    }
    closeWalkInModal();
  });
}

if (walkInConfirmModalOverlay) {
  walkInConfirmModalOverlay.addEventListener("click", (e) => {
    if (e.target === walkInConfirmModalOverlay) {
      closeWalkInModal();
    }
  });
}

// QR Code Scanned Callback
async function onScanSuccess(decodedText) {
  if (isScanThrottled) return;

  const now = Date.now();
  // Task 3: Ignore repeat reads of the same code for 5 seconds
  if (decodedText === lastScannedText && now - lastScannedTime < 5000) {
    return;
  }

  // Task 3: Pause 1.5 seconds between scans
  isScanThrottled = true;
  lastScannedText = decodedText;
  lastScannedTime = now;

  setTimeout(() => {
    isScanThrottled = false;
  }, 1500);

  const allowWalkIn = isWalkInAllowed;
  await processAttendance({
    eventId: currentEventId,
    token: decodedText.trim(),
    allowWalkIn,
  });
}

function onScanFailure() {
  // Ignored per-frame failures during standard viewfinder scanning
}

// Attendance Processor (Callable with Local Fallback)
async function processAttendance({ eventId, token, allowWalkIn }) {
  if (!eventId) {
    alert("Please select an active event first.");
    return;
  }

  try {
    let result = null;

    if (functions && navigator.onLine) {
      try {
        const recordCallable = httpsCallable(functions, "recordAttendance");
        const resp = await recordCallable({
          eventId,
          token,
          allowWalkIn: Boolean(allowWalkIn),
        });
        result = resp.data;
      } catch (callErr) {
        // Inspect callable error
        const msg = callErr.message || "";
        const code = callErr.code || "";

        if (code === "functions/failed-precondition" || msg.toLowerCase().includes("replaced")) {
          showResultBanner({
            type: "replaced",
            title: "Replaced QR code",
            name: "",
            meta: "",
            note: "This QR code was replaced. Ask the student to download their new one.",
          });
          return;
        }

        if (code === "functions/permission-denied") {
          showResultBanner({
            type: "error",
            title: "Permission denied",
            name: "",
            meta: "",
            note: "Only event organizers and administrators can record attendance.",
          });
          return;
        }

        // Rethrow other errors to handle below
        throw callErr;
      }
    }

    // Fallback simulation / processing if callable returned or was offline
    if (!result) {
      result = await handleLocalAttendanceProcessing(eventId, token, allowWalkIn);
    }

    handleAttendanceResult(result, token);

  } catch (err) {
    console.error("Attendance scan error:", err);
    const msg = err.message || "An unexpected error occurred during check-in.";
    showResultBanner({
      type: "error",
      title: "Check-in failed",
      name: "",
      meta: "",
      note: msg,
    });
  }
}

// Local Fallback Processor (for offline / client-direct RTDB mode)
async function handleLocalAttendanceProcessing(eventId, token, allowWalkIn) {
  // Token format: <uid>.<version>.<signature>
  const parts = String(token || "").split(".");
  const uid = parts[0] || "student";
  const tokenVersion = Number(parts[1] || 1);

  // Check version against qrVersions/{uid} if RTDB is connected
  if (rtdb) {
    try {
      const vSnap = await get(ref(rtdb, `qrVersions/${uid}`));
      const liveV = vSnap.val();
      if (liveV && liveV.v && Number(liveV.v) !== tokenVersion) {
        return {
          status: "replaced",
          message: "This QR code was replaced. Ask the student to download their new one.",
        };
      }
    } catch {}
  }

  // Check if student is already checked in
  const existingRow = currentAttendanceRows.find((r) => r.uid === uid || r.studentNo === uid);
  if (existingRow) {
    return {
      status: "already",
      student: {
        name: existingRow.name,
        studentNo: existingRow.studentNo,
        organization: existingRow.organization,
      },
      scannedAt: existingRow.scannedAt,
    };
  }

  // Lookup student details from Firestore or local storage
  let studentData = {
    name: "Student",
    studentNo: uid.includes("-") ? uid : "2023-00000-BN-0",
    organization: "PUP Biñan",
  };

  if (db) {
    try {
      const snap = await getDoc(doc(db, "users", uid));
      if (snap.exists()) {
        const d = snap.data();
        studentData = {
          name: d.fullName || `${d.firstName || ""} ${d.lastName || ""}`.trim() || "Student",
          studentNo: d.studentNumber || d.studentId || uid,
          organization: d.organization || "PUP Biñan",
        };
      }
    } catch {}
  }

  // Check registration: Check currentAbsentRows, RTDB, and local storage
  const cleanUid = stripStudentNo(uid);
  const cleanStudentNo = stripStudentNo(studentData.studentNo);

  let isRegistered = false;

  // 1. Check currentAbsentRows (loaded from registrations for this event)
  if (currentAbsentRows.some((r) => {
    const s = stripStudentNo(r.studentNo);
    const u = stripStudentNo(r.uid);
    return s === cleanStudentNo || s === cleanUid || u === cleanUid;
  })) {
    isRegistered = true;
  }

  // 2. Check RTDB registrations/{eventId}/{uid} or search by studentNo
  if (!isRegistered && rtdb) {
    try {
      const regSnap = await get(ref(rtdb, `registrations/${eventId}/${uid}`));
      if (regSnap.exists() && regSnap.val()) {
        isRegistered = true;
      } else {
        const allRegSnap = await get(ref(rtdb, `registrations/${eventId}`));
        const allReg = allRegSnap.val();
        if (allReg && typeof allReg === "object") {
          isRegistered = Object.entries(allReg).some(([rUid, rVal]) => {
            const s = stripStudentNo(rVal?.studentNo || rVal?.studentNumber);
            const u = stripStudentNo(rUid);
            return s === cleanStudentNo || s === cleanUid || u === cleanUid;
          });
        }
      }
    } catch {}
  }

  // 3. Fallback: check localStorage participations or registered events if any
  if (!isRegistered) {
    try {
      const participations = JSON.parse(localStorage.getItem("recovibeParticipations") || "[]");
      if (Array.isArray(participations)) {
        isRegistered = participations.some((p) => {
          const matchEvent = String(p.eventId || p.id) === String(eventId);
          const matchStudent = !p.studentNo || stripStudentNo(p.studentNo) === cleanStudentNo;
          return matchEvent && matchStudent;
        });
      }
    } catch {}
  }

  if (!isRegistered && !allowWalkIn) {
    return {
      status: "not_registered",
      student: studentData,
    };
  }

  // Record attendance
  const now = Date.now();
  const organizerProfile = JSON.parse(localStorage.getItem("recovibeOrganizerProfile") || "{}");
  const scannedBy = organizerProfile.name || auth?.currentUser?.email || "Event Organizer";

  const isWalkIn = !isRegistered;
  const attendanceRow = {
    scannedAt: now,
    scannedBy,
    walkIn: isWalkIn,
    name: studentData.name,
    studentNo: studentData.studentNo,
    organization: studentData.organization,
  };

  if (rtdb) {
    try {
      await set(ref(rtdb, `attendance/${eventId}/${uid}`), attendanceRow);
    } catch (setErr) {
      console.warn("RTDB write notice:", setErr);
    }
  }

  // If registered student checked in, remove from absent rows
  if (!isWalkIn) {
    currentAbsentRows = currentAbsentRows.filter((r) => {
      const s = stripStudentNo(r.studentNo);
      const u = stripStudentNo(r.uid);
      return s !== cleanStudentNo && s !== cleanUid && u !== cleanUid;
    });
  }

  // Update local list
  currentAttendanceRows.unshift({ uid, ...attendanceRow });
  updateRosterDisplay();
  try {
    localStorage.setItem(`recovibe_attendance_${eventId}`, JSON.stringify(currentAttendanceRows));
  } catch {}

  return {
    status: "ok",
    walkIn: isWalkIn,
    student: studentData,
  };
}

// Result Dispatcher (Task 4)
function handleAttendanceResult(result, originalToken) {
  if (!result) return;

  const student = result.student || {};
  const sName = student.name || "Student";
  const sNum = student.studentNo || student.studentNumber || "—";
  const sOrg = student.organization || "PUP Biñan";
  const metaText = `${sNum} · ${sOrg}`;

  if (result.status === "ok") {
    const isWalkIn = Boolean(result.walkIn);
    showResultBanner({
      type: "ok",
      title: isWalkIn ? "Checked in (Walk-in)" : "Checked in",
      name: sName,
      meta: metaText,
      note: "Attendance recorded successfully.",
    });
  } else if (result.status === "already") {
    const earlierDate = result.scannedAt ? new Date(result.scannedAt) : null;
    const earlierTimeStr = earlierDate && !Number.isNaN(earlierDate.getTime())
      ? earlierDate.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
      : "earlier";
    showResultBanner({
      type: "already",
      title: "Already checked in",
      name: sName,
      meta: metaText,
      note: `This student was already checked in at ${earlierTimeStr}.`,
    });
  } else if (result.status === "not_registered") {
    showResultBanner({
      type: "not-registered",
      title: "Not registered",
      name: sName,
      meta: metaText,
      note: "This student is not registered for this event.",
      allowWalkInAction: true,
      token: originalToken,
    });
  } else if (result.status === "replaced") {
    showResultBanner({
      type: "replaced",
      title: "Replaced QR code",
      name: sName,
      meta: metaText,
      note: "This QR code was replaced. Ask the student to download their new one.",
    });
  } else {
    showResultBanner({
      type: "error",
      title: "Check-in notice",
      name: sName,
      meta: metaText,
      note: result.message || "Could not process this QR code.",
    });
  }
}

// Task 6: Manual Lookup Fallback with Input Validation & Confirmation Modal
const STUDENT_NO_REGEX = /^(20\d{2})[-\s]?(\d{4,5})[-\s]?([A-Za-z]{2})[-\s]?(\d)$/i;

function formatStudentNo(val) {
  const clean = String(val || "").trim().toUpperCase();
  const match = clean.match(/^(20\d{2})[-\s]?(\d{4,5})[-\s]?([A-Za-z]{2})[-\s]?(\d)$/i);
  if (match) {
    return `${match[1]}-${match[2]}-${match[3]}-${match[4]}`;
  }
  return clean;
}

if (manualStudentNo) {
  manualStudentNo.addEventListener("input", () => {
    if (manualValidationError) {
      manualValidationError.hidden = true;
      manualValidationError.textContent = "";
    }
    manualStudentNo.classList.remove("input-error");
  });
}

function closeManualConfirmModal() {
  if (manualConfirmModalOverlay) manualConfirmModalOverlay.hidden = true;
  pendingManualStudentNo = null;
}

if (btnCancelManualConfirm) {
  btnCancelManualConfirm.addEventListener("click", closeManualConfirmModal);
}

if (manualConfirmModalOverlay) {
  manualConfirmModalOverlay.addEventListener("click", (e) => {
    if (e.target === manualConfirmModalOverlay) {
      closeManualConfirmModal();
    }
  });
}

if (manualCheckInForm) {
  manualCheckInForm.addEventListener("submit", (e) => {
    e.preventDefault();

    if (!currentEventId) {
      if (manualValidationError) {
        manualValidationError.textContent = "Please select an active event first.";
        manualValidationError.hidden = false;
      }
      return;
    }

    const currentEv = currentEvents.find((ev) => String(ev.id) === String(currentEventId));
    if (currentEv && currentEv.status === "completed") {
      if (manualValidationError) {
        manualValidationError.textContent = "This event is marked as completed. Attendance is closed.";
        manualValidationError.hidden = false;
      }
      return;
    }

    const rawVal = (manualStudentNo?.value || "").trim();
    if (!rawVal) {
      if (manualValidationError) {
        manualValidationError.textContent = "Please enter a student number.";
        manualValidationError.hidden = false;
      }
      manualStudentNo?.classList.add("input-error");
      manualStudentNo?.focus();
      return;
    }

    const formattedNo = formatStudentNo(rawVal);
    const isValidFormat = STUDENT_NO_REGEX.test(formattedNo) || /^[0-9A-Z]{2,4}[-\s]?[0-9A-Z]{3,6}[-\s]?[0-9A-Z]{1,4}[-\s]?[0-9A-Z]?$/i.test(formattedNo);
    if (!isValidFormat && formattedNo.length < 8) {
      if (manualValidationError) {
        manualValidationError.textContent = "Please enter a valid student number format (e.g. 2023-00123-BN-0).";
        manualValidationError.hidden = false;
      }
      manualStudentNo?.classList.add("input-error");
      manualStudentNo?.focus();
      return;
    }

    // Check if student is already checked in
    const cleanFormatted = stripStudentNo(formattedNo);
    const alreadyChecked = currentAttendanceRows.find((r) => {
      return stripStudentNo(r.studentNo) === cleanFormatted || stripStudentNo(r.uid) === cleanFormatted;
    });
    if (alreadyChecked) {
      if (manualValidationError) {
        manualValidationError.textContent = `Student ${formattedNo} is already checked in (${alreadyChecked.name || "Student"}).`;
        manualValidationError.hidden = false;
      }
      manualStudentNo?.classList.add("input-error");
      return;
    }

    // Check pre-registration vs walk-in
    const allowWalkIn = isWalkInAllowed;
    const isPreRegistered = currentAbsentRows.some((r) => {
      return stripStudentNo(r.studentNo) === cleanFormatted || stripStudentNo(r.uid) === cleanFormatted;
    });

    if (!isPreRegistered && !allowWalkIn) {
      if (manualValidationError) {
        manualValidationError.textContent = `Student ${formattedNo} is not pre-registered, and walk-ins are disabled. Turn on "Allow walk-ins" to proceed.`;
        manualValidationError.hidden = false;
      }
      manualStudentNo?.classList.add("input-error");
      return;
    }

    // Clear validation error and open confirmation modal
    if (manualValidationError) {
      manualValidationError.hidden = true;
      manualValidationError.textContent = "";
    }
    manualStudentNo?.classList.remove("input-error");

    pendingManualStudentNo = formattedNo;
    if (manualConfirmStudentNo) manualConfirmStudentNo.textContent = formattedNo;
    if (manualConfirmWalkInNotice) {
      manualConfirmWalkInNotice.hidden = isPreRegistered;
    }
    if (manualConfirmModalOverlay) manualConfirmModalOverlay.hidden = false;
    btnAcceptManualConfirm?.focus();
  });
}

if (btnAcceptManualConfirm) {
  btnAcceptManualConfirm.addEventListener("click", async () => {
    if (!pendingManualStudentNo || !currentEventId) return;
    const studentNo = pendingManualStudentNo;
    closeManualConfirmModal();

    const allowWalkIn = isWalkInAllowed;
    if (btnManualSubmit) {
      btnManualSubmit.disabled = true;
      btnManualSubmit.textContent = "Checking in...";
    }

    try {
      let result = null;

      if (functions && navigator.onLine) {
        try {
          const manualCallable = httpsCallable(functions, "recordAttendanceByStudentNo");
          const resp = await manualCallable({
            eventId: currentEventId,
            studentNo,
            allowWalkIn,
          });
          result = resp.data;
        } catch (fnErr) {
          console.warn("recordAttendanceByStudentNo callable notice:", fnErr);
        }
      }

      if (!result) {
        // Fallback local lookup
        result = await handleLocalAttendanceProcessing(currentEventId, studentNo, allowWalkIn);
      }

      handleAttendanceResult(result, studentNo);
      if (manualStudentNo) manualStudentNo.value = "";
    } catch (err) {
      console.error("Manual check-in error:", err);
      showResultBanner({
        type: "error",
        title: "Lookup failed",
        name: studentNo,
        meta: "",
        note: err.message || "Could not record attendance for this student number.",
      });
    } finally {
      if (btnManualSubmit) {
        btnManualSubmit.disabled = false;
        btnManualSubmit.textContent = "Check In";
      }
    }
  });
}

// App Initialization
async function initApp() {
  await loadEventsList();
  if (currentEvents.length > 0) {
    const active = currentEvents.find((e) => String(e.id) === String(currentEventId));
    if (active && active.status !== "completed") {
      await startCameraScanner();
    }
  }
}
