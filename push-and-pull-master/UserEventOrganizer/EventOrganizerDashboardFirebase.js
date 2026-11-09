import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  collection,
  onSnapshot,
  query,
  where,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { auth, db, isFirebaseConfigured } from "../UserStudent/firebaseConfig.js";

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
  const rawCreatedAt = data.createdAt;
  const createdAt = rawCreatedAt?.toDate
    ? rawCreatedAt.toDate().toISOString()
    : rawCreatedAt?.seconds != null
      ? new Date(Number(rawCreatedAt.seconds) * 1000).toISOString()
      : typeof rawCreatedAt === "number"
        ? new Date(rawCreatedAt).toISOString()
        : rawCreatedAt || "";
  const dateISO = data.eventDate || data.dateISO || data.date || "";
  const startTime = data.startTime || "";
  const endTime = data.endTime || "";

  return {
    ...data,
    id: documentSnapshot.id,
    eventId: documentSnapshot.id,
    title: data.eventName || data.title || "Untitled event",
    dateISO,
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
  const date = new Date(`${String(value).slice(0, 10)}T00:00:00`);
  if (Number.isNaN(date.getTime())) return "Date TBA";
  return date.toLocaleDateString("en-US", options);
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
    if (normalized.includes("publish")) return "Published";
    if (normalized.includes("pending")) return "Pending";
    if (normalized.includes("approv")) return "Approved";
    return status || "Pending";
  }

function setCount(id, count) {
  const element = document.getElementById(id);
  if (element) element.textContent = String(count);
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
      ].includes(
        status(event),
      ),
    ).length,
  );
  setCount(
    "pendingApprovalCount",
    organizerEvents.filter((event) =>
      ["pending", "pending approval", "needs revision"].includes(
        status(event),
      ),
    ).length,
  );
  const fullyApproved = (event) => {
    const normalizedStatus = status(event);
    const published = event.published === true || event.isPublished === true ||
      ["published", "completed"].includes(normalizedStatus);
    if (published || ["rejected", "pending", "needs revision", "draft"].includes(normalizedStatus)) return false;
    const approvalGroups = [
      Array.isArray(event.approvalStages) ? event.approvalStages : Object.values(event.approvalStages || {}),
      Object.values(event.approval?.members || {}),
      Object.values(event.approvalData?.members || {}),
    ];
    return approvalGroups.some((members) => {
      const required = members.filter((member) => member && member.required !== false && member.enabled !== false);
      return required.length === 4 && required.every((member) =>
        ["approved", "ok"].includes(String(member.status || member.approvalStatus || member.state || member.decision || "").trim().toLowerCase()),
      );
    });
  };
  setCount("approvedEventsCount", organizerEvents.filter(fullyApproved).length);
  setCount(
    "completedEventsCount",
    organizerEvents.filter((event) => status(event) === "completed").length,
  );
}

function renderActionRows() {
  if (!actionRows) return;
  if (!organizerEvents.length) {
    actionRows.innerHTML = `<tr><td colspan="3"><div class="dashboard-empty-state"><strong>No events created yet.</strong><span>Click “Create Event” to start.</span><a class="organizer-button" href="EventOrganizerCreateEvent.html">+ Create Event</a></div></td></tr>`;
    return;
  }

  actionRows.innerHTML = organizerEvents
    .map(
      (event) => `<tr data-firestore-event-id="${escapeHtml(event.eventId)}" style="cursor: pointer;">
        <td><strong>${escapeHtml(event.title)}</strong><small>${escapeHtml(event.category || event.eventType || "General")}</small></td>
        <td>${escapeHtml(formatDate(event.createdAt, { year: "numeric", month: "numeric", day: "numeric" }))}</td>
        <td><span class="organizer-status ${statusClass(event.status)}">${escapeHtml(event.status || "Upcoming")}</span></td>
      </tr>`,
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
  unsubscribeAuth?.();
  unsubscribeEvents.forEach((unsubscribe) => unsubscribe());
});
