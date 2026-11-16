import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  collection,
  onSnapshot,
  or,
  query,
  where,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { auth, db, isFirebaseConfigured } from "../UserStudent/firebaseConfig.js";

const { toMillis, formatCreatedDate } = window.RecovibeOrganizerDashboardDates;
const CREATION_DATE_FIELDS = [
  "createdAt",
  "submittedAt",
  "dateCreated",
  "createdAtMs",
  "updatedAt",
];
const loginPath = "EventOrganizerLogin.html";
const actionRows = document.getElementById("organizerActionRows");
const actionTable = document.getElementById("actionRequiredTable");
const upcomingEventsList = document.getElementById("upcomingEventsList");
const happeningNowList = document.getElementById("happeningNowList");
const logoutButton = document.getElementById("organizerLogout");
const dashboardStatus = document.getElementById("dashboardStatusMessage");
const notificationsBadge = document.getElementById("navNotifBadge");
let unsubscribeEvents = null;
let unsubscribeNotifications = null;
let unsubscribeAuth = null;
let organizerEvents = [];
let signingOut = false;
const dashboardMessages = new Map();
if (notificationsBadge) notificationsBadge.hidden = true;

function setDashboardMessage(source, message) {
  if (!dashboardStatus) return;
  if (message) dashboardMessages.set(source, message);
  else dashboardMessages.delete(source);
  dashboardStatus.textContent = [...dashboardMessages.values()].join(" ");
  dashboardStatus.hidden = dashboardMessages.size === 0;
}

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
  const createdAt = CREATION_DATE_FIELDS
    .map((field) => ({ field, millis: toMillis(data[field]) }))
    .find((candidate) => candidate.millis !== null);
  const hasUnresolvedCreatedAt = !createdAt &&
    documentSnapshot.metadata?.hasPendingWrites === true &&
    CREATION_DATE_FIELDS.some((field) =>
      Object.prototype.hasOwnProperty.call(data, field) && data[field] == null,
    );
  const dateISO = data.eventDate || data.dateISO || data.dateStart || data.date || "";
  const endDateISO = data.endDateISO || data.dateEnd || data.endDate || dateISO;
  const startTime = data.timeStart || data.startTime || "";
  const endTime = data.timeEnd || data.endTime || "";
  const categories = Array.isArray(data.categories)
    ? data.categories.filter(Boolean).join(", ")
    : data.categories;

  return {
    ...data,
    id: documentSnapshot.id,
    eventId: documentSnapshot.id,
    title: data.eventName || data.title || "Untitled event",
    category: categories || data.category || data.eventType || "General",
    dateISO,
    endDateISO,
    startTime,
    endTime,
    time: data.time || [startTime, endTime].filter(Boolean).join(" - "),
    location: data.venue || data.location || "Location TBA",
    venue: data.venue || data.location || "Location TBA",
    description: data.eventDescription || data.description || "",
    status: displayStatus(data.status),
    createdAt: createdAt?.millis ?? null,
    creationTimestampPending: hasUnresolvedCreatedAt,
  };
}

function formatDate(value, options = {}) {
  const date = toEventDate(value);
  if (!date) return "Date TBA";
  return date.toLocaleDateString("en-US", options);
}

function toEventDate(value) {
  if (!value) return null;
  const dateValue = value && typeof value.toDate === "function"
    ? value.toDate()
    : value;
  if (dateValue instanceof Date) {
    return Number.isNaN(dateValue.getTime()) ? null : dateValue;
  }
  const dateText = String(dateValue).trim();
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateText);
  const date = dateOnly
    ? new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]))
    : new Date(dateText);
  return Number.isNaN(date.getTime()) ? null : date;
}

function eventBoundaryMillis(event, isEnd = false) {
  const rawDate = isEnd
    ? event.endDateISO || event.dateEnd || event.endDate || event.dateISO || event.date
    : event.dateISO || event.dateStart || event.date;
  const date = toEventDate(rawDate);
  if (!date) return null;

  const timeValue = String(
    isEnd
      ? event.endTime || event.timeEnd || ""
      : event.startTime || event.timeStart || "",
  ).trim();
  const timeMatch = /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?$/i.exec(timeValue);
  if (timeValue && !timeMatch) return null;

  if (timeMatch) {
    let hours = Number(timeMatch[1]);
    const minutes = Number(timeMatch[2]);
    const seconds = Number(timeMatch[3] || 0);
    const meridiem = String(timeMatch[4] || "").toUpperCase();
    if (meridiem) {
      if (hours < 1 || hours > 12) return null;
      if (hours === 12) hours = 0;
      if (meridiem === "PM") hours += 12;
    } else if (hours > 23) {
      return null;
    }
    if (minutes > 59 || seconds > 59) return null;
    date.setHours(hours, minutes, seconds, 0);
  } else if (isEnd) {
    date.setHours(23, 59, 59, 999);
  } else {
    date.setHours(0, 0, 0, 0);
  }
  return date.getTime();
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
  if (!element) return;
  const nextCount = String(count);
  if (element.textContent !== nextCount) {
    const card = element.closest(".organizer-stat");
    if (card && element.textContent.trim() !== "") {
      card.classList.remove("stat-highlight");
      void card.offsetWidth;
      card.classList.add("stat-highlight");
    }
    element.textContent = nextCount;
  }
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
  const approval = event.approval;
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
  const end = eventBoundaryMillis(event, true);
  return end !== null && end <= now;
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
  ).sort((first, second) => {
    const firstCreated = toMillis(first.createdAt);
    const secondCreated = toMillis(second.createdAt);
    if (firstCreated === null) return secondCreated === null ? 0 : 1;
    if (secondCreated === null) return -1;
    return secondCreated - firstCreated;
  });
  if (!actionableEvents.length) {
    actionRows.innerHTML = `<tr><td colspan="3"><div class="dashboard-empty-state"><strong>Nothing needs your action right now.</strong></div></td></tr>`;
    return;
  }

  actionRows.innerHTML = actionableEvents
    .map(
      (event) => {
        const status = displayStatus(getDashboardStatus(event));
        const createdAt = toMillis(event.createdAt);
        const createdAtText = createdAt === null
          ? event.creationTimestampPending ? "" : "—"
          : formatCreatedDate(createdAt);
        return `<tr data-firestore-event-id="${escapeHtml(event.eventId)}" style="cursor: pointer;">
        <td><strong>${escapeHtml(event.title)}</strong><small>${escapeHtml(event.category || event.eventType || "General")}</small></td>
        <td>${escapeHtml(createdAtText)}</td>
        <td><span class="organizer-status ${statusClass(status)}">${escapeHtml(status)}</span></td>
      </tr>`;
      },
    )
    .join("");
}

function renderHappeningNow() {
  if (!happeningNowList) return;
  const now = Date.now();

  const happeningNow = organizerEvents
    .filter((event) => {
      const start = eventBoundaryMillis(event);
      const end = eventBoundaryMillis(event, true);
      const status = getDashboardStatus(event);
      return start !== null && end !== null && now >= start && now <= end &&
        status !== "rejected" && status !== "cancelled";
    })
    .sort((first, second) => eventBoundaryMillis(first) - eventBoundaryMillis(second));

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
  const now = Date.now();

  const upcoming = organizerEvents
    .filter((event) => {
      const start = eventBoundaryMillis(event);
      const status = getDashboardStatus(event);
      return start !== null && start > now &&
        status !== "rejected" && status !== "cancelled";
    })
    .sort((first, second) => eventBoundaryMillis(first) - eventBoundaryMillis(second))
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

function renderDashboard() {
  organizerEvents.sort((first, second) => {
    const firstCreated = toMillis(first.createdAt) ?? 0;
    const secondCreated = toMillis(second.createdAt) ?? 0;
    return secondCreated - firstCreated;
  });
  renderStatistics();
  renderActionRows();
  renderHappeningNow();
  renderUpcomingEvents();
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
renderDashboard();
const dashboardRefreshTimer = window.setInterval(renderDashboard, 60000);

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

function stopDashboardListeners() {
  unsubscribeEvents?.();
  unsubscribeEvents = null;
  unsubscribeNotifications?.();
  unsubscribeNotifications = null;
}

function startDashboardListeners(user) {
  try {
    const eventsQuery = query(
      collection(db, "events"),
      or(
        where("organizerUid", "==", user.uid),
        where("organizerId", "==", user.uid),
        where("createdBy", "==", user.uid),
      ),
    );
    unsubscribeEvents = onSnapshot(
      eventsQuery,
      (snapshot) => {
        organizerEvents = snapshot.docs.map(normalizeEvent);
        setDashboardMessage("events", "");
        renderDashboard();
      },
      (error) => {
        console.error("Unable to load organizer dashboard events:", error.code, error.message);
        setDashboardMessage(
          "events",
          error.code === "permission-denied"
            ? "You don't have permission to view your organizer events."
            : "Could not load your events. Check your connection and try again.",
        );
      },
    );
  } catch (error) {
    console.error("Unable to start organizer event listener:", error.code, error.message);
    setDashboardMessage("events", "Could not start loading your events. Please try again.");
  }

  try {
    const notificationsQuery = query(
      collection(db, "notifications"),
      where("recipientUid", "==", user.uid),
    );
    unsubscribeNotifications = onSnapshot(
      notificationsQuery,
      (snapshot) => {
        const unreadCount = snapshot.docs.filter((notification) => {
          const data = notification.data();
          return data.read !== true && data.isRead !== true;
        }).length;
        if (notificationsBadge) {
          notificationsBadge.textContent = unreadCount > 9 ? "9+" : unreadCount ? String(unreadCount) : "";
          notificationsBadge.hidden = unreadCount === 0;
        }
        setDashboardMessage("notifications", "");
      },
      (error) => {
        console.error("Unable to load organizer notifications:", error.code, error.message);
        setDashboardMessage(
          "notifications",
          error.code === "permission-denied"
            ? "You don't have permission to view your notification count."
            : "Could not update your notification count.",
        );
      },
    );
  } catch (error) {
    console.error("Unable to start organizer notification listener:", error.code, error.message);
    setDashboardMessage("notifications", "Could not update your notification count.");
  }
}

if (!isFirebaseConfigured || !auth || !db) {
  setDashboardMessage("events", "Event data is unavailable. Please contact support.");
} else {
  auth
    .authStateReady()
    .then(() => {
      unsubscribeAuth = onAuthStateChanged(
        auth,
        (user) => {
          stopDashboardListeners();
          organizerEvents = [];
          if (!user) {
            window.location.replace(loginPath);
            return;
          }
          setDashboardMessage("events", "Loading your dashboard...");
          startDashboardListeners(user);
          renderDashboard();
        },
        (error) => {
          console.error("Unable to observe organizer authentication state:", error.code, error.message);
          setDashboardMessage("events", "Could not verify your session. Check your connection and try again.");
        },
      );
    })
    .catch((error) => {
      console.error("Unable to initialize organizer authentication state:", error.code, error.message);
      setDashboardMessage("events", "Could not verify your session. Check your connection and try again.");
    });
}

logoutButton?.addEventListener("click", async (event) => {
  event.preventDefault();
  if (signingOut) return;
  signingOut = true;
  logoutButton.disabled = true;
  stopDashboardListeners();
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
    setDashboardMessage("events", "Could not sign out. Your session is still active; please try again.");
    signingOut = false;
    logoutButton.disabled = false;
    if (auth?.currentUser) startDashboardListeners(auth.currentUser);
  }
});

window.addEventListener("beforeunload", () => {
  window.clearInterval(dashboardRefreshTimer);
  unsubscribeAuth?.();
  stopDashboardListeners();
});
