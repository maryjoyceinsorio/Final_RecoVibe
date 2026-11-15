import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  collection,
  onSnapshot,
  query,
  where,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { onValue, off, ref } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import { auth, db, isFirebaseConfigured, rtdb } from "../UserStudent/firebaseConfig.js";

const loginPath = "EventOrganizerLogin.html";
const actionRows = document.getElementById("organizerActionRows");
const actionTable = document.getElementById("actionRequiredTable");
const upcomingEventsList = document.getElementById("upcomingEventsList");
const happeningNowList = document.getElementById("happeningNowList");
const logoutButton = document.getElementById("organizerLogout");
let unsubscribeEvents = [];
let unsubscribeAuth = null;
let organizerEvents = [];
let signingOut = false;
const eventsById = new Map();
const eventsBySource = new Map();
const approvalListeners = new Map();
const approvalsById = new Map();

const escapeHtml = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character],
  );

function normalizeEvent(documentSnapshot) {
  const data = documentSnapshot.data();
  const normalizeTimestamp = (value) => {
    if (!value) return "";
    const date = value?.toDate
      ? value.toDate()
      : value?.seconds != null
        ? new Date(Number(value.seconds) * 1000)
        : value?._seconds != null
          ? new Date(Number(value._seconds) * 1000)
          : typeof value === "number"
            ? new Date(value < 100000000000 ? value * 1000 : value)
            : new Date(String(value));
    return Number.isNaN(date.getTime()) ? "" : date.toISOString();
  };
  const createdAt = [
    data.approvalSubmittedAt, data.submittedAt, data.submitted_at,
    data.dateSubmitted, data.date_submitted, data.createdAt, data.created_at,
  ].map(normalizeTimestamp).find(Boolean) || "";
  const dateISO = data.eventDate || data.dateISO || data.dateStart || data.date || "";
  const endDateISO = data.endDateISO || data.dateEnd || data.endDate || dateISO;
  const startTime = data.timeStart || data.startTime || "";
  const endTime = data.timeEnd || data.endTime || "";

  return {
    ...data,
    id: documentSnapshot.id,
    eventId: documentSnapshot.id,
    title: data.eventName || data.title || "Untitled event",
    dateISO,
    endDateISO,
    startTime,
    endTime,
    time: data.time || [startTime, endTime].filter(Boolean).join(" - "),
    location: data.venue || data.location || "Location TBA",
    venue: data.venue || data.location || "Location TBA",
    description: data.eventDescription || data.description || "",
    status: displayStatus(data.status),
    createdAt,
  };
}

function formatDate(value, options = {}) {
  if (!value) return "Date TBA";
  const dateText = String(value);
  const date = new Date(`${dateText.slice(0, 10)}T00:00:00`);
  if (Number.isNaN(date.getTime())) return "Date TBA";
  return date.toLocaleDateString("en-US", options);
}

function formatCreatedDate(value) {
  if (!value) return "TBA";
  const dateText = String(value);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(dateText)
    ? new Date(`${dateText}T00:00:00`)
    : new Date(dateText);
  if (Number.isNaN(date.getTime())) return "TBA";
  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function statusClass(status) {
  return String(status || "Upcoming")
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-");
}

  function displayStatus(status) {
    const normalized = String(status || "Pending")
      .trim()
      .toLowerCase()
      .replace(/[\s_-]+/g, " ");
    if (normalized.includes("reject")) return "Rejected";
    if (normalized.includes("revision")) return "Needs Revision";
    if (normalized.includes("cancel")) return "Cancelled";
    if (normalized.includes("complet")) return "Completed";
    if (normalized.includes("publish")) return "Published";
    if (normalized.includes("pending")) return "Pending";
    if (normalized.includes("approv")) return "Approved";
    if (normalized === "draft") return "Draft";
    if (normalized === "unknown") return "Unknown";
    return status || "Pending";
  }

function setCount(id, count) {
  const element = document.getElementById(id);
  if (element) element.textContent = String(count);
}

function normalizeStatus(status) {
  const raw = String(status ?? "").trim().toLowerCase().replace(/[\s_-]+/g, " ");
  if (["pending approval", "under review", "in review", "reviewing", "submitted"].includes(raw)) return "pending";
  if (["needs revision", "revision requested", "changes requested", "revision", "rev"].includes(raw)) return "revision";
  if (["rejected", "reject", "rej"].includes(raw)) return "rejected";
  if (["approve", "fully approved", "ready to publish", "ok"].includes(raw)) return "approved";
  if (["live", "published live"].includes(raw)) return "published";
  if (raw === "canceled") return "cancelled";
  return raw;
}

function hasTrueFlag(value) {
  return value === true || value === 1 || ["true", "yes", "1"].includes(String(value ?? "").trim().toLowerCase());
}

function getEventStatusValues(event) {
  return [
    event.status, event.approvalStatus, event.approval_status, event.adminStatus,
    event.admin_status, event.adminApprovalStatus, event.approvalState,
    event.approval_state, event.reviewStatus, event.publicationStatus,
    event.moderationStatus, event.eventStatus, event.isApproved, event.approved,
    event.published, event.approval?.approvalStatus, event.approval?.status,
    event.approval?.state, event.admin?.status, event.review?.status,
    event.moderation?.status, event.approvalData?.status,
  ].filter((status) => status !== null && status !== undefined && status !== "").map(normalizeStatus);
}

function getEffectiveStatus(event) {
  const firestoreStatuses = getEventStatusValues(event);
  const eventStatus = firestoreStatuses[0] || "";
  if (eventStatus === "draft") return "draft";
  const isPublished = ["published", "cancelled"].find((value) => firestoreStatuses.includes(value));
  if (isPublished) return isPublished;
  if ([event.published, event.isPublished, event.isLive].some(hasTrueFlag)) return "published";
  const approval = approvalsById.get(String(event.eventId || event.id)) || event.approval;
  if (normalizeStatus(approval?.status) === "published") return "published";
  const stageEntries = Array.isArray(event.approvalStages) ? event.approvalStages : Object.values(event.approvalStages || {});
  const requiredStageStatuses = stageEntries
    .filter((stage) => !stage || typeof stage !== "object" || (stage.required !== false && stage.enabled !== false))
    .map((stage) => normalizeStatus(typeof stage === "string" ? stage : stage?.status || stage?.approvalStatus || stage?.state || stage?.decision));
  if (firestoreStatuses.includes("rejected")) return "rejected";
  if (firestoreStatuses.includes("revision")) return "revision";
  if (firestoreStatuses.includes("approved")) return "approved";
  if ([event.isApproved, event.approved].some(hasTrueFlag)) return "approved";
  const members = Object.values(approval?.members || {});
  const approvalStatus = normalizeStatus(approval?.status);
  if (approvalStatus === "rejected" || approvalStatus === "revision" || approvalStatus === "approved") return approvalStatus;
  if (members.length > 0 && members.every((member) => ["approved", "ok"].includes(normalizeStatus(member.status)))) return "approved";
  if (requiredStageStatuses.includes("rejected")) return "rejected";
  if (requiredStageStatuses.includes("revision")) return "revision";
  if (requiredStageStatuses.length > 0 && requiredStageStatuses.every((status) => status === "approved")) return "approved";
  const fallbackStatus = firestoreStatuses.find((status) => status === "pending") || eventStatus || "pending";
  return fallbackStatus === "completed" ? "unknown" : fallbackStatus;
}

function hasEventEnded(event, now = Date.now()) {
  const endDateValue = event.endDateISO || event.dateEnd || event.endDate || event.dateISO || event.date;
  if (!endDateValue) return false;
  const dateText = String(endDateValue).trim().slice(0, 10);
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateText);
  if (!dateMatch) return false;
  const endDate = new Date(
    Number(dateMatch[1]),
    Number(dateMatch[2]) - 1,
    Number(dateMatch[3]),
  );
  if (Number.isNaN(endDate.getTime())) return false;

  const endTime = String(event.endTime || event.timeEnd || "").trim();
  if (!endTime) {
    endDate.setHours(23, 59, 59, 999);
  } else {
    const timeMatch = /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?$/i.exec(endTime);
    if (!timeMatch) return false;
    let hours = Number(timeMatch[1]);
    const minutes = Number(timeMatch[2]);
    const seconds = Number(timeMatch[3] || 0);
    const meridiem = String(timeMatch[4] || "").toUpperCase();
    if (meridiem) {
      if (hours < 1 || hours > 12) return false;
      if (hours === 12) hours = 0;
      if (meridiem === "PM") hours += 12;
    } else if (hours > 23) {
      return false;
    }
    if (minutes > 59 || seconds > 59) return false;
    endDate.setHours(hours, minutes, seconds, 0);
  }

  return endDate.getTime() <= now;
}

function getDashboardStatus(event) {
  const status = getEffectiveStatus(event);
  return status === "published" && hasEventEnded(event) ? "completed" : status;
}

function renderStatistics() {
  const status = (event) =>
    String(event.status || "Upcoming")
      .trim()
      .toLowerCase()
      .replace(/[\s_-]+/g, " ");
  setCount(
    "activeEventsCount",
    organizerEvents.filter((event) =>
      [
        "upcoming",
        "pending",
        "pending approval",
        "approved",
        "draft",
      ].includes(getDashboardStatus(event)),
    ).length,
  );
  setCount(
    "pendingApprovalCount",
    organizerEvents.filter((event) =>
      ["pending", "pending approval", "needs revision"].includes(status(event)) &&
      !["approved", "published"].includes(getEffectiveStatus(event)),
    ).length,
  );
  setCount("approvedEventsCount", organizerEvents.filter((event) => getEffectiveStatus(event) === "approved").length);
  setCount(
    "completedEventsCount",
    organizerEvents.filter((event) => getDashboardStatus(event) === "completed").length,
  );
}

function renderActionRows() {
  if (!actionRows) return;
  const actionableStatuses = ["pending", "revision", "rejected", "approved", "draft"];
  const actionableEvents = organizerEvents.filter((event) =>
    actionableStatuses.includes(getDashboardStatus(event)),
  );
  if (!actionableEvents.length) {
    actionRows.innerHTML = `<tr><td colspan="3"><div class="dashboard-empty-state"><strong>Nothing needs your action right now.</strong></div></td></tr>`;
    return;
  }

  actionRows.innerHTML = actionableEvents
    .map(
      (event) => {
        const status = displayStatus(getDashboardStatus(event));
        return `<tr data-firestore-event-id="${escapeHtml(event.eventId)}" style="cursor: pointer;">
        <td><strong>${escapeHtml(event.title)}</strong><small>${escapeHtml(event.category || event.eventType || "General")}</small></td>
        <td>${escapeHtml(formatCreatedDate(event.createdAt))}</td>
        <td><span class="organizer-status ${statusClass(status)}">${escapeHtml(status)}</span></td>
      </tr>`;
      },
    )
    .join("");
}

function renderHappeningNow() {
  if (!happeningNowList) return;
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const todayISO = `${year}-${month}-${day}`;

  const happeningNow = organizerEvents
    .filter((event) => {
      if (!event.dateISO) return false;
      const startISO = String(event.dateISO).slice(0, 10);
      const endISO = String(event.endDateISO || event.endDate || event.dateEnd || startISO).slice(0, 10);
      const status = (event.status || "").toLowerCase();
      if (status.includes("reject") || status.includes("cancel")) return false;
      return startISO <= todayISO && endISO >= todayISO;
    })
    .sort((first, second) => first.dateISO.localeCompare(second.dateISO));

  if (!happeningNow.length) {
    happeningNowList.innerHTML = `<div class="dashboard-empty-state compact"><strong>No events happening today</strong><span>Events scheduled for today will appear here.</span></div>`;
    return;
  }

  happeningNowList.innerHTML = happeningNow
    .map((event) => {
      const month = formatDate(event.dateISO, { month: "short" }).toUpperCase();
      const day = formatDate(event.dateISO, { day: "2-digit" });
      const year = formatDate(event.dateISO, { year: "numeric" });
      return `<article class="upcoming-event" data-firestore-event-id="${escapeHtml(event.eventId)}" style="cursor: pointer;">
        <div class="upcoming-event-date"><span class="upcoming-event-month">${escapeHtml(month)}</span><strong>${escapeHtml(day)}</strong><small>${escapeHtml(year)}</small></div>
        <div class="upcoming-event-content"><strong>${escapeHtml(event.title)}</strong><span>${escapeHtml(event.time || "Time TBA")}</span><span>${escapeHtml(event.venue || "Location TBA")}</span></div>
      </article>`;
    })
    .join("");
}

function renderUpcomingEvents() {
  if (!upcomingEventsList) return;
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const todayISO = `${year}-${month}-${day}`;

  const upcoming = organizerEvents
    .filter((event) => {
      if (!event.dateISO) return false;
      const startISO = String(event.dateISO).slice(0, 10);
      const status = (event.status || "").toLowerCase();
      if (status.includes("reject") || status.includes("cancel")) return false;
      return startISO > todayISO;
    })
    .sort((first, second) => first.dateISO.localeCompare(second.dateISO))
    .slice(0, 4);

  if (!upcoming.length) {
    upcomingEventsList.innerHTML = `<div class="dashboard-empty-state compact"><strong>No upcoming events</strong><span>Future events you create will appear here.</span></div>`;
    return;
  }

  upcomingEventsList.innerHTML = upcoming
    .map((event) => {
      const month = formatDate(event.dateISO, { month: "short" }).toUpperCase();
      const day = formatDate(event.dateISO, { day: "2-digit" });
      const year = formatDate(event.dateISO, { year: "numeric" });
      return `<article class="upcoming-event" data-firestore-event-id="${escapeHtml(event.eventId)}" style="cursor: pointer;">
        <div class="upcoming-event-date"><span class="upcoming-event-month">${escapeHtml(month)}</span><strong>${escapeHtml(day)}</strong><small>${escapeHtml(year)}</small></div>
        <div class="upcoming-event-content"><strong>${escapeHtml(event.title)}</strong><span>${escapeHtml(event.time || "Time TBA")}</span><span>${escapeHtml(event.venue || "Location TBA")}</span></div>
      </article>`;
    })
    .join("");
}

function renderEvents() {
  organizerEvents.sort((first, second) => {
    const firstCreated = new Date(first.createdAt || 0).getTime();
    const secondCreated = new Date(second.createdAt || 0).getTime();
    return secondCreated - firstCreated;
  });
  renderStatistics();
  renderActionRows();
  renderHappeningNow();
  renderUpcomingEvents();
}

function syncApprovalListeners() {
  if (!rtdb) return;
  const eventIds = new Set(organizerEvents.map((event) => String(event.eventId || event.id)));
  approvalListeners.forEach((approvalRef, eventId) => {
    if (eventIds.has(eventId)) return;
    off(approvalRef);
    approvalListeners.delete(eventId);
    approvalsById.delete(eventId);
  });
  organizerEvents.forEach((event) => {
    const eventId = String(event.eventId || event.id);
    if (!eventId || approvalListeners.has(eventId)) return;
    const approvalRef = ref(rtdb, `approvals/${eventId}`);
    onValue(approvalRef, (snapshot) => {
      if (snapshot.exists()) approvalsById.set(eventId, snapshot.val());
      else approvalsById.delete(eventId);
      renderEvents();
    });
    approvalListeners.set(eventId, approvalRef);
  });
}

function showLoadError(message) {
  if (actionRows) actionRows.innerHTML = `<tr><td colspan="3">${escapeHtml(message)}</td></tr>`;
  if (upcomingEventsList) upcomingEventsList.textContent = message;
  if (happeningNowList) happeningNowList.textContent = message;
}

const actionHead = actionTable?.querySelector("thead");
if (actionHead) {
  const headerRow = document.createElement("tr");
  ["EVENT NAME", "DATE CREATED", "STATUS"].forEach((label) => {
    const heading = document.createElement("th");
    heading.textContent = label;
    headerRow.append(heading);
  });
  actionHead.replaceChildren(headerRow);
}
renderEvents();
const dashboardRefreshTimer = window.setInterval(renderEvents, 60000);

actionRows?.addEventListener("click", (event) => {
  const item = event.target.closest("[data-firestore-event-id]");
  if (!item) return;
  const selectedEvent = organizerEvents.find(
    (eventItem) => eventItem.eventId === item.dataset.firestoreEventId,
  );
  if (selectedEvent) {
    window.RecovibeEventDetails?.open(selectedEvent, {
      showApprovalDocuments: true,
    });
  }
});

[happeningNowList, upcomingEventsList].forEach((container) => {
  container?.addEventListener("click", (event) => {
    const item = event.target.closest("[data-firestore-event-id]");
    if (!item) return;
    const selectedEvent = organizerEvents.find(
      (eventItem) => eventItem.eventId === item.dataset.firestoreEventId,
    );
    if (selectedEvent) {
      window.RecovibeEventDetails?.open(selectedEvent, {
        showApprovalDocuments: true,
      });
    }
  });
});

if (!isFirebaseConfigured || !auth || !db) {
  showLoadError("Event data is unavailable. Please contact support.");
} else {
  auth
    .authStateReady()
    .then(() => {
      unsubscribeAuth = onAuthStateChanged(
        auth,
        (user) => {
          unsubscribeEvents.forEach((unsubscribe) => unsubscribe());
          unsubscribeEvents = [];
          approvalListeners.forEach((approvalRef) => off(approvalRef));
          approvalListeners.clear();
          approvalsById.clear();
          eventsById.clear();
          eventsBySource.clear();
          organizerEvents = [];

          if (!user) {
            window.location.replace(loginPath);
            return;
          }

          console.log("Organizer UID:", user.uid);
          renderEvents();

          const q = query(
            collection(db, "events"),
            where("createdBy", "==", user.uid),
          );
          console.info("[OrganizerDashboard] Firestore query:", {
            collection: "events",
            field: "createdBy",
            value: user.uid,
          });
          const legacyOrganizerQuery = query(
            collection(db, "events"),
            where("organizerId", "==", user.uid),
          );
          console.info("[OrganizerDashboard] Legacy query:", {
            collection: "events",
            field: "organizerId",
            value: user.uid,
          });

          function subscribeToEvents(eventsQuery, sourceField) {
            return onSnapshot(
              eventsQuery,
              (snapshot) => {
                console.log("Fetched Events Count:", snapshot.docs.length);
                console.info(
                  "[OrganizerDashboard] Retrieved document IDs:",
                  snapshot.docs.map((eventDocument) => eventDocument.id),
                );
                console.info(`[OrganizerDashboard] Snapshot source: ${sourceField}`);
                const sourceEvents = new Map(
                  snapshot.docs.map((eventDocument) => [
                    eventDocument.id,
                    normalizeEvent(eventDocument),
                  ]),
                );
                eventsBySource.set(sourceField, sourceEvents);
                eventsById.clear();
                ["organizerId", "createdBy"].forEach((source) => {
                  eventsBySource.get(source)?.forEach((event, eventId) => {
                    eventsById.set(eventId, event);
                  });
                });
                organizerEvents = [...eventsById.values()];
                syncApprovalListeners();
                console.log(
                  ">> LOGGED IN AS UID:",
                  user.uid,
                  "MATCHING EVENTS FOUND:",
                  organizerEvents.length,
                );
                renderEvents();
              },
              (error) => {
                console.error(`Unable to load organizer events by ${sourceField}:`, error);
                if (!eventsById.size) {
                  showLoadError("Could not load events. Please try again later.");
                }
              },
            );
          }

          try {
            unsubscribeEvents = [
              subscribeToEvents(q, "createdBy"),
              subscribeToEvents(legacyOrganizerQuery, "organizerId"),
            ];
          } catch (error) {
            console.error("Unable to start organizer event listeners:", error);
            showLoadError("Could not load events. Please try again later.");
          }
        },
        (error) => {
          console.error("Unable to observe organizer authentication state:", error);
          showLoadError("Could not verify your session. Check your connection and try again.");
        },
      );
    })
    .catch((error) => {
      console.error("Unable to initialize organizer authentication state:", error);
      showLoadError("Could not verify your session. Check your connection and try again.");
    });
}

logoutButton?.addEventListener("click", async (event) => {
  event.preventDefault();
  if (signingOut) return;
  signingOut = true;
  logoutButton.disabled = true;
  try {
    if (auth) {
      await auth.authStateReady();
      await signOut(auth);
    }
    localStorage.removeItem("recovibeOrganizerId");
    localStorage.removeItem("recovibeOrganizerProfile");
    window.location.assign(loginPath);
  } catch (error) {
    console.error("Unable to sign out organizer:", error);
    showLoadError("Could not sign out. Your session is still active; please try again.");
    signingOut = false;
    logoutButton.disabled = false;
  }
});

window.addEventListener("beforeunload", () => {
  window.clearInterval(dashboardRefreshTimer);
  unsubscribeAuth?.();
  unsubscribeEvents.forEach((unsubscribe) => unsubscribe());
});
