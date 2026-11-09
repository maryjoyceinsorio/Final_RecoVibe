import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  collection,
  deleteDoc,
  doc,
  onSnapshot,
  query,
  updateDoc,
  where,
  writeBatch,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  onValue,
  ref as databaseRef,
  remove as removeDatabase,
  update as updateDatabase,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import { auth, authReady, db, rtdb } from "./firebaseConfig.js";
import {
  clearCachedStudentProfile,
  loadStudentProfile,
  renderStudentSidebar,
} from "./studentIdentity.js";

let notifications = [];
let deletedNotifications = [];
let notificationsLoading = true;
let notificationLoadError = "";
let notificationUnsubscribes = [];
let currentUid = "";
let recipientIds = [];
let notificationSubscriptionVersion = 0;
let activeFilter = "all";
let pendingDeleteId = null;
const LOCAL_NOTIFICATIONS_KEY = "recovibeNotifications";
const NOTIFICATION_RECIPIENT_FIELDS = [
  "recipientUid",
  "recipientUserId",
  "recipientId",
  "userId",
  "organizerUid",
  "organizerId",
];

function logNotificationStep(step, details = {}) {
  console.log(`[Student Notifications] ${step}`, details);
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

function notificationMillis(value) {
  if (value && typeof value.toMillis === "function") return value.toMillis();
  if (value && typeof value.toDate === "function") return value.toDate().getTime();
  if (value && typeof value.seconds === "number") return value.seconds * 1000;
  if (typeof value === "number") return value;
  const parsed = value ? new Date(value).getTime() : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeNotification(snapshot) {
  const data = snapshot.data();
  const createdAt = notificationMillis(
    data.createdAt ?? data.at ?? data.timestamp,
  );
  const deletedAt = notificationMillis(data.deletedAt);
  const statusLabels = {
    cancelled: "Cancelled",
    canceled: "Cancelled",
    event_cancelled: "Cancelled",
    unpublished: "Unpublished",
    event_unpublished: "Unpublished",
    updated: "Updated",
    event_updated: "Updated",
    deleted: "Removed",
    event_deleted: "Removed",
  };
  return {
    ...data,
    id: snapshot.id,
    title: String(data.title || data.eventTitle || data.eventName || "Notification"),
    message: String(data.message || data.body || ""),
    type: String(data.type || "event").toLowerCase(),
    eventId: String(data.eventId || ""),
    statusLabel: String(
      data.statusLabel || statusLabels[String(data.status || "").toLowerCase()] || "",
    ),
    createdAtMillis: createdAt,
    time: createdAt
      ? new Date(createdAt).toLocaleString("en-PH", {
          timeZone: "Asia/Manila",
          dateStyle: "medium",
          timeStyle: "short",
        })
      : "Just now",
    read: data.read === true || data.isRead === true,
    deletedAt,
  };
}

function notificationReference(id) {
  return doc(db, "notifications", id);
}

function getRecipientIds(user, profile = {}) {
  const ids = new Set([
    user?.uid,
    profile.studentId,
    profile.studentNumber,
    profile.studentNo,
  ]
    .filter(Boolean)
    .map((value) => String(value).trim()));
  try {
    const cached = JSON.parse(
      localStorage.getItem("recovibeCurrentUser") || "null",
    );
    if (
      cached?.uid === user?.uid ||
      (cached?.email &&
        String(cached.email).toLowerCase() === String(user?.email || "").toLowerCase())
    ) {
      [cached.studentId, cached.studentNumber, cached.studentNo]
        .filter(Boolean)
        .forEach((id) => ids.add(String(id).trim()));
    }
  } catch (error) {
    console.warn("[Student Notifications] Could not read cached recipient IDs:", error);
  }
  return [...ids];
}

function readLocalNotifications(ids) {
  try {
    const stored = JSON.parse(
      localStorage.getItem(LOCAL_NOTIFICATIONS_KEY) || "[]",
    );
    if (!Array.isArray(stored)) return [];
    return stored
        .filter((item) =>
          NOTIFICATION_RECIPIENT_FIELDS.some((field) =>
            ids.includes(String(item[field] || "")),
          ),
        )
      .map((item, index) => {
        const data = {
          ...item,
          id: String(item.id || `local-${index}`),
        };
        const createdAt = notificationMillis(
          data.createdAt ?? data.at ?? data.timestamp,
        );
        const normalized = normalizeNotification({
          id: data.id,
          data: () => data,
        });
        return { ...normalized, createdAtMillis: createdAt, localOnly: true };
      });
  } catch (error) {
    console.warn("[Student Notifications] Could not read local notifications:", error);
    return [];
  }
}

function subscribeToNotifications(uid, ids = [uid]) {
  notificationUnsubscribes.forEach((unsubscribe) => unsubscribe());
  notificationUnsubscribes = [];
  const subscriptionVersion = ++notificationSubscriptionVersion;
  recipientIds = [...new Set([uid, ...ids].filter(Boolean).map(String))];
  const firestoreDocuments = new Map();
  const realtimeDocuments = new Map();
  let firestoreSnapshotReceived = false;
  let firestoreError = null;
  const generationUid = currentUid;
  notificationsLoading = true;
  notificationLoadError = "";
  renderNotifications();

  function renderSnapshotResults() {
    if (
      currentUid !== generationUid ||
      subscriptionVersion !== notificationSubscriptionVersion
    ) return;
    const firestoreItems = [...firestoreDocuments.values()];
    const realtimeItems = [...realtimeDocuments.values()];
    const raw = [...firestoreItems, ...realtimeItems];
    let matched = raw
      .filter(({ data }) =>
        NOTIFICATION_RECIPIENT_FIELDS.some((field) =>
          recipientIds.includes(String(data[field] || "")),
        ),
      )
      .map(({ data, id }) => normalizeNotification({ id, data: () => data }));
    const cloudCount = firestoreItems.length;
    let localFallbackCount = 0;
    if (firestoreSnapshotReceived && cloudCount === 0) {
      const localNotifications = readLocalNotifications(recipientIds);
      localFallbackCount = localNotifications.length;
      matched = [...matched, ...localNotifications];
    }
    matched.sort((left, right) => right.createdAtMillis - left.createdAtMillis);
    const active = matched.filter((item) => !item.deletedAt);
    const deleted = matched.filter((item) => Boolean(item.deletedAt));
    notifications = active;
    deletedNotifications = deleted;

    // TEMP-DEBUG: Keep until the notification recipient and filtering issue is resolved.
    console.debug("[Student Notifications] recipient IDs used:", recipientIds);
    console.debug("[Student Notifications] document counts:", {
      rawFirestore: cloudCount,
      rawRealtimeDatabase: realtimeItems.length,
      localFallback: localFallbackCount,
      recipientMatch: matched.length,
      activeAfterDeletedAtFilter: active.length,
      deleted: deleted.length,
      afterUiFilters: active.filter((item) => {
        const search = document.getElementById("notificationSearch").value.trim().toLowerCase();
        const matchesFilter = activeFilter === "all" ||
          (activeFilter === "read" ? item.read : !item.read);
        return matchesFilter &&
          (!search || `${item.title} ${item.message}`.toLowerCase().includes(search));
      }).length,
    });
    console.table(raw.map(({ id, data }) => ({
      id,
      recipientUid: data.recipientUid || "",
      type: data.type || "",
      deleted: Boolean(data.deletedAt || data.deleted || data.isDeleted),
      createdAt: data.createdAt || data.at || data.timestamp || null,
    })));

    notificationsLoading = !firestoreSnapshotReceived;
    notificationLoadError = firestoreError
      ? firestoreError.code === "permission-denied"
        ? "You do not have permission to read notifications."
        : "Notifications could not be loaded. Please retry."
      : "";
    if (firestoreSnapshotReceived) {
      logNotificationStep("query-success", {
        uid: generationUid,
        projectId: auth.app.options.projectId,
        count: cloudCount + realtimeItems.length,
        firestoreCount: cloudCount,
        realtimeDatabaseCount: realtimeItems.length,
        localFallbackCount,
      });
    }
    renderNotifications();
  }

  logNotificationStep("query-start", {
    collection: "notifications",
    recipientField: "recipientUid",
    recipientUid: uid,
    projectId: auth.app.options.projectId,
  });
  const firestoreUnsubscribe = onSnapshot(
    query(
      collection(db, "notifications"),
      where("recipientUid", "==", uid),
    ),
    (snapshot) => {
      if (
        currentUid !== generationUid ||
        subscriptionVersion !== notificationSubscriptionVersion
      ) return;
      firestoreSnapshotReceived = true;
      firestoreError = null;
      firestoreDocuments.clear();
      snapshot.docs.forEach((item) => {
        firestoreDocuments.set(item.id, { id: item.id, data: item.data() });
      });
      renderSnapshotResults();
    },
    (error) => {
      if (
        currentUid !== generationUid ||
        subscriptionVersion !== notificationSubscriptionVersion
      ) return;
      firestoreSnapshotReceived = true;
      firestoreError = error;
      console.error("[Student Notifications] query-error", {
        uid,
        code: error?.code || "",
        message: error?.message || String(error),
      });
      renderSnapshotResults();
    },
  );
  notificationUnsubscribes.push(firestoreUnsubscribe);

  if (rtdb && currentUid) {
    const legacyNotificationsRef = databaseRef(
      rtdb,
      `notifications/${currentUid}`,
    );
    const unsubscribe = onValue(
      legacyNotificationsRef,
      (snapshot) => {
        if (
          currentUid !== generationUid ||
          subscriptionVersion !== notificationSubscriptionVersion
        ) return;
        realtimeDocuments.clear();
        const values = snapshot.val() || {};
        Object.entries(values).forEach(([id, data]) => {
          if (!data || typeof data !== "object") return;
          realtimeDocuments.set(`rtdb:${id}`, {
            id: `rtdb:${id}`,
            data: {
              ...data,
              recipientUid: currentUid,
              rtdbOnly: true,
              rtdbId: id,
            },
            source: "rtdb",
            sourceId: id,
          });
        });
        if (firestoreSnapshotReceived) renderSnapshotResults();
      },
      (error) => {
        console.error("[Student Notifications] Realtime Database query error:", {
          uid: currentUid,
          code: error?.code || "",
          message: error?.message || String(error),
        });
      },
    );
    notificationUnsubscribes.push(unsubscribe);
  }
}

function writeLocalNotificationChanges(item, changes) {
  try {
    const stored = JSON.parse(
      localStorage.getItem(LOCAL_NOTIFICATIONS_KEY) || "[]",
    );
    if (!Array.isArray(stored)) return false;
    const index = stored.findIndex((notification, itemIndex) =>
      String(notification.id || `local-${itemIndex}`) === item.id &&
      NOTIFICATION_RECIPIENT_FIELDS.some((field) =>
        recipientIds.includes(String(notification[field] || "")),
      ),
    );
    if (index < 0) return false;
    const serializableChanges = Object.fromEntries(
      Object.entries(changes).map(([key, value]) => [
        key,
        value && typeof value === "object" ? Date.now() : value,
      ]),
    );
    stored[index] = { ...stored[index], ...serializableChanges };
    localStorage.setItem(LOCAL_NOTIFICATIONS_KEY, JSON.stringify(stored));
    const updated = normalizeNotification({
      id: item.id,
      data: () => stored[index],
    });
    notifications = notifications.filter((notification) => notification.id !== item.id);
    deletedNotifications = deletedNotifications.filter(
      (notification) => notification.id !== item.id,
    );
    if (updated.deletedAt) deletedNotifications.push({ ...updated, localOnly: true });
    else notifications.push({ ...updated, localOnly: true });
    notifications.sort((left, right) => right.createdAtMillis - left.createdAtMillis);
    deletedNotifications.sort((left, right) => right.createdAtMillis - left.createdAtMillis);
    renderNotifications();
    return true;
  } catch (error) {
    console.error("[Student Notifications] Could not update local notification:", error);
    return false;
  }
}

async function updateNotification(id, changes) {
  const localItem = [...notifications, ...deletedNotifications]
    .find((item) => item.id === id && item.localOnly);
  if (localItem) {
    writeLocalNotificationChanges(localItem, changes);
    return;
  }
  const realtimeItem = [...notifications, ...deletedNotifications]
    .find((item) => item.id === id && item.rtdbOnly);
  if (realtimeItem) {
    try {
      const updates = Object.fromEntries(
        Object.entries(changes).map(([key, value]) => [
          key,
          value && typeof value === "object" ? Date.now() : value,
        ]),
      );
      await updateDatabase(
        databaseRef(rtdb, `notifications/${currentUid}/${realtimeItem.rtdbId}`),
        updates,
      );
    } catch (error) {
      console.error("[Student Notifications] Could not update Realtime Database notification:", error);
    }
    return;
  }
  try {
    await updateDoc(notificationReference(id), changes);
  } catch (error) {
    console.error("[Student Notifications] Could not update notification:", error);
  }
}

function deleteLocalNotification(item) {
  try {
    const stored = JSON.parse(
      localStorage.getItem(LOCAL_NOTIFICATIONS_KEY) || "[]",
    );
    if (!Array.isArray(stored)) return;
    const filtered = stored.filter((notification, index) =>
      String(notification.id || `local-${index}`) !== item.id ||
      !NOTIFICATION_RECIPIENT_FIELDS.some((field) =>
        recipientIds.includes(String(notification[field] || "")),
      ),
    );
    localStorage.setItem(LOCAL_NOTIFICATIONS_KEY, JSON.stringify(filtered));
    deletedNotifications = deletedNotifications.filter(
      (notification) => notification.id !== item.id,
    );
    notifications = notifications.filter(
      (notification) => notification.id !== item.id,
    );
    renderNotifications();
  } catch (error) {
    console.error("[Student Notifications] Could not delete local notification:", error);
  }
}

async function permanentlyDeleteNotification(item) {
  try {
    if (item.localOnly) {
      deleteLocalNotification(item);
    } else if (item.rtdbOnly) {
      await removeDatabase(
        databaseRef(rtdb, `notifications/${currentUid}/${item.rtdbId}`),
      );
    } else {
      await deleteDoc(notificationReference(item.id));
    }
  } catch (error) {
    console.error("[Student Notifications] Could not permanently delete notification:", error);
  }
}

function renderDeletedNotifications() {
  const list = document.getElementById("deletedNotificationList");
  list.innerHTML = notificationsLoading
    ? '<div class="empty-notifications">Loading notifications...</div>'
    : notificationLoadError
      ? `<div class="empty-notifications">${escapeHTML(notificationLoadError)}</div>`
      : deletedNotifications.length
    ? deletedNotifications
        .map(
          (item) => `
    <article class="notification-card deleted-notification-card type-${escapeHTML(item.type)}" data-deleted-notification-id="${escapeHTML(item.id)}">
      <h3 class="notification-title">${escapeHTML(item.title)}</h3>
      <p class="notification-message">${escapeHTML(item.message)}</p>
      <div class="notification-meta">${escapeHTML(item.statusLabel || "Recently Deleted")} · ${escapeHTML(item.time)}</div>
      <div class="deleted-notification-actions">
        <button type="button" data-deleted-action="restore">Restore</button>
        <button type="button" data-deleted-action="delete-permanently">Delete Permanently</button>
      </div>
    </article>`,
        )
        .join("")
    : '<div class="empty-notifications">Trash bin is empty.</div>';
}

function renderNotifications() {
  const query = document
    .getElementById("notificationSearch")
    .value.trim()
    .toLowerCase();
  const visible = notifications.filter((item) => {
    const filterMatch =
      activeFilter === "all" ||
      (activeFilter === "read" ? item.read : !item.read);
    const textMatch =
      !query || `${item.title} ${item.message}`.toLowerCase().includes(query);
    return filterMatch && textMatch;
  });
  const list = document.getElementById("notificationList");
  list.innerHTML = notificationsLoading
    ? '<div class="empty-notifications">Loading notifications...</div>'
    : notificationLoadError
      ? `<div class="empty-notifications">${escapeHTML(notificationLoadError)}</div>`
      : visible.length
    ? visible
        .map(
          (item) => `
    <article class="notification-card type-${escapeHTML(item.type)} ${item.read ? "is-read" : ""}" id="notification-card-${escapeHTML(item.id)}" data-notification-id="${escapeHTML(item.id)}" tabindex="0" aria-label="${escapeHTML(item.title)}, ${item.read ? "read" : "unread"}">
      <div class="notification-actions">
        <button class="notification-menu-toggle" type="button" aria-label="More actions for ${escapeHTML(item.title)}" aria-expanded="false">
          <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><circle cx="4" cy="10" r="1.5"/><circle cx="10" cy="10" r="1.5"/><circle cx="16" cy="10" r="1.5"/></svg>
        </button>
        <div class="notification-menu" hidden>
          <button type="button" data-notification-action="read">Read</button>
          <button type="button" data-notification-action="unread">Unread</button>
          <button type="button" data-notification-action="delete">Delete</button>
        </div>
      </div>
      <h3 class="notification-title" id="notification-title-${escapeHTML(item.id)}" data-notification-field="title">${escapeHTML(item.title)}</h3>
      <p class="notification-message" id="notification-message-${escapeHTML(item.id)}" data-notification-field="message">${escapeHTML(item.message)}</p>
      <div class="notification-meta" id="notification-time-${escapeHTML(item.id)}" data-notification-field="time"><svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M10 3.5a4.5 4.5 0 0 0-4.5 4.5v2.4c0 .5-.2 1-.5 1.4L4 13h12l-1-1.2c-.3-.4-.5-.9-.5-1.4V8A4.5 4.5 0 0 0 10 3.5Z" stroke="currentColor" stroke-width="1.3"/><path d="M8.3 16a1.7 1.7 0 0 0 3.4 0" stroke="currentColor" stroke-width="1.3"/></svg>${item.statusLabel ? `${escapeHTML(item.statusLabel)} · ` : ""}${escapeHTML(item.time)}</div>
    </article>`,
        )
        .join("")
    : `<div class="empty-notifications">${
        notifications.length
          ? "No notifications match your filters."
          : "No notifications yet."
      }</div>`;
  const unread = notifications.filter((item) => !item.read).length;
  document.getElementById("navNotifBadge").textContent = unread;
  document.getElementById("navNotifBadge").hidden = unread === 0;
  renderDeletedNotifications();
}

async function markAllRead() {
  const unread = notifications.filter((item) => !item.read);
  for (const item of unread.filter((notification) => notification.localOnly)) {
    await updateNotification(item.id, {
      read: true,
      readAt: Date.now(),
    });
  }
  for (const item of unread.filter((notification) => notification.rtdbOnly)) {
    await updateNotification(item.id, {
      read: true,
      readAt: Date.now(),
    });
  }
  const cloudUnread = unread.filter((item) => !item.localOnly && !item.rtdbOnly);
  for (let index = 0; index < cloudUnread.length; index += 450) {
    const batch = writeBatch(db);
    cloudUnread.slice(index, index + 450).forEach((item) => {
      batch.update(notificationReference(item.id), {
        read: true,
        readAt: serverTimestamp(),
      });
    });
    try {
      await batch.commit();
    } catch (error) {
      console.error("[Student Notifications] Could not mark notifications as read:", error);
      return;
    }
  }
}

async function deleteAllNotifications() {
  if (!deletedNotifications.length) return;
  if (!window.confirm("Permanently delete all recently deleted notifications?"))
    return;
  const nonFirestoreItems = deletedNotifications.filter(
    (item) => item.localOnly || item.rtdbOnly,
  );
  if (nonFirestoreItems.length) {
    for (const item of nonFirestoreItems.filter((notification) => notification.rtdbOnly)) {
      await permanentlyDeleteNotification(item);
    }
    try {
      const localIds = new Set(
        nonFirestoreItems.filter((item) => item.localOnly).map((item) => item.id),
      );
      const stored = JSON.parse(
        localStorage.getItem(LOCAL_NOTIFICATIONS_KEY) || "[]",
      );
      if (Array.isArray(stored)) {
        localStorage.setItem(
          LOCAL_NOTIFICATIONS_KEY,
          JSON.stringify(stored.filter((notification, index) =>
            !localIds.has(String(notification.id || `local-${index}`)) ||
            !NOTIFICATION_RECIPIENT_FIELDS.some((field) =>
              recipientIds.includes(String(notification[field] || "")),
            ),
          )),
        );
      }
      deletedNotifications = deletedNotifications.filter(
        (item) => !item.localOnly && !item.rtdbOnly,
      );
      renderNotifications();
    } catch (error) {
      console.error("[Student Notifications] Could not permanently delete local notifications:", error);
    }
  }
  for (const item of deletedNotifications.filter((notification) => !notification.localOnly)) {
    try {
      await deleteDoc(notificationReference(item.id));
    } catch (error) {
      console.error("[Student Notifications] Could not permanently delete notification:", error);
    }
  }
}

function updateNotificationPanelControls(showingDeletedNotifications) {
  const toggle = document.getElementById("showDeletedNotifications");
  const label = document.getElementById("showDeletedNotificationsLabel");
  const icon = document.getElementById("showDeletedNotificationsIcon");
  const action = document.getElementById("markAllRead");
  toggle.setAttribute("aria-pressed", String(showingDeletedNotifications));
  label.textContent = showingDeletedNotifications
    ? "All Notifications"
    : "Recently Deleted";
  action.textContent = showingDeletedNotifications
    ? "Delete All"
    : "Mark All As Read";
  icon.innerHTML = showingDeletedNotifications
    ? '<path d="M3.5 5.5h13M5 5.5v10h10v-10M7.5 3.5h5l1 2h-7l1-2M8 8v5m4-5v5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>'
    : '<path d="M4 6h12M8 6V4.5h4V6m-6.5 0 .7 10h7.6l.7-10M8.5 9v4m3-4v4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>';
}

function swapNotificationPanels() {
  const panels = document.getElementById("notificationPanels");
  const allPanel = document.getElementById("allNotificationsPanel");
  const deletedPanel = document.getElementById("deletedNotificationsPanel");
  const firstPanel = panels.querySelector(":scope > .notifications-panel");
  const showingDeletedNotifications =
    firstPanel.id !== "deletedNotificationsPanel";
  if (showingDeletedNotifications) panels.insertBefore(deletedPanel, allPanel);
  else panels.insertBefore(allPanel, deletedPanel);
  updateNotificationPanelControls(showingDeletedNotifications);
}

document.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll(".nav-item").forEach((item) => {
    const label = item.querySelector(".nav-label");
    if (label) item.title = label.textContent.trim();
  });
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
    const sidebar = document.getElementById("sidebar");
    if (sidebar) sidebar.classList.remove("is-collapsed");
  } catch {}
  document
    .querySelector(".nav-item.logout")
    .addEventListener("click", () =>
      clearCachedStudentProfile(),
    );
  document
    .getElementById("notificationSearch")
    .addEventListener("input", renderNotifications);
  document.getElementById("markAllRead").addEventListener("click", () => {
    const firstPanel = document
      .getElementById("notificationPanels")
      .querySelector(":scope > .notifications-panel");
    const showingDeletedNotifications =
      firstPanel.id === "deletedNotificationsPanel";
    if (showingDeletedNotifications) deleteAllNotifications();
    else markAllRead();
  });
  document
    .getElementById("showDeletedNotifications")
    .addEventListener("click", () => {
      swapNotificationPanels();
    });
  window.enhanceDropdownSelects?.("#notificationFilter");
  document
    .getElementById("notificationFilter")
    .addEventListener("change", (event) => {
      activeFilter = event.target.value;
      renderNotifications();
    });
  document
    .getElementById("notificationList")
    .addEventListener("click", (event) => {
      const card = event.target.closest("[data-notification-id]");
      if (!card) return;
      const item = notifications.find(
        (notification) => notification.id === card.dataset.notificationId,
      );
      const menuToggle = event.target.closest(".notification-menu-toggle");
      const menuAction = event.target.closest("[data-notification-action]");
      if (menuToggle) {
        const menu = card.querySelector(".notification-menu");
        const isOpen = !menu.hidden;
        document.querySelectorAll(".notification-menu").forEach((itemMenu) => {
          itemMenu.hidden = true;
        });
        document
          .querySelectorAll(".notification-menu-toggle")
          .forEach((toggle) => toggle.setAttribute("aria-expanded", "false"));
        menu.hidden = isOpen;
        menuToggle.setAttribute("aria-expanded", String(!isOpen));
        return;
      }
      if (menuAction) {
        event.stopPropagation();
        if (!item) return;
        if (menuAction.dataset.notificationAction === "delete") {
          document
            .querySelectorAll(".notification-menu")
            .forEach((itemMenu) => {
              itemMenu.hidden = true;
            });
          openDeleteConfirmation(item.id);
          return;
        } else {
          item.read = menuAction.dataset.notificationAction === "read";
          updateNotification(item.id, {
            read: item.read,
            readAt: item.read ? serverTimestamp() : null,
          });
        }
        renderNotifications();
        return;
      }
      if (item) {
        item.read = true;
        updateNotification(item.id, {
          read: true,
          readAt: serverTimestamp(),
        });
        renderNotifications();
        openNotificationDetails(item);
      }
    });
  document
    .getElementById("deletedNotificationList")
    .addEventListener("click", (event) => {
      const action = event.target.closest("[data-deleted-action]");
      const card = event.target.closest("[data-deleted-notification-id]");
      if (!action || !card) return;
      const item = deletedNotifications.find(
        (notification) =>
          notification.id === card.dataset.deletedNotificationId,
      );
      if (!item) return;
      if (action.dataset.deletedAction === "restore") {
        updateNotification(item.id, { deletedAt: null });
      } else {
        permanentlyDeleteNotification(item);
      }
    });
  document
    .getElementById("notificationList")
    .addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      if (event.target.closest(".notification-menu")) return;
      const card = event.target.closest("[data-notification-id]");
      if (!card) return;
      event.preventDefault();
      const item = notifications.find(
        (notification) => notification.id === card.dataset.notificationId,
      );
      if (item) {
        item.read = true;
        updateNotification(item.id, {
          read: true,
          readAt: serverTimestamp(),
        });
        renderNotifications();
        openNotificationDetails(item);
      }
    });
  document
    .getElementById("notificationModalClose")
    .addEventListener("click", closeNotificationDetails);
  document
    .getElementById("notificationModalOverlay")
    .addEventListener("click", (event) => {
      if (event.target.id === "notificationModalOverlay")
        closeNotificationDetails();
    });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeNotificationDetails();
  });
  document
    .getElementById("notificationViewEvent")
    .addEventListener("click", () => {
      const eventId = document.getElementById("notificationViewEvent").dataset
        .eventId;
      const event = (window.RECOVIBE_EVENTS || []).find(
        (item) => String(item.id || item.eventId) === String(eventId),
      );
      if (!event) return;
      const notificationId = document.querySelector(
        "#notificationModalOverlay .notification-modal",
      ).dataset.notificationId;
      closeNotificationDetails();
      document.getElementById(`notification-card-${notificationId}`)?.focus();
      window.RecovibeStudentEventDetails?.open(event);
    });
  document
    .getElementById("confirmDeleteNotification")
    .addEventListener("click", deletePendingNotification);
  document
    .getElementById("deleteConfirmClose")
    .addEventListener("click", closeDeleteConfirmation);
  document
    .getElementById("cancelDeleteNotification")
    .addEventListener("click", closeDeleteConfirmation);
  document
    .getElementById("deleteConfirmOverlay")
    .addEventListener("click", (event) => {
      if (event.target.id === "deleteConfirmOverlay") closeDeleteConfirmation();
    });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeDeleteConfirmation();
  });
  updateNotificationPanelControls(false);
  renderNotifications();
  if (!auth || !db) {
    notificationsLoading = false;
    notificationLoadError = "Notifications are unavailable because Firebase is not configured.";
    renderNotifications();
    return;
  }
  logNotificationStep("auth-wait-start");
  authReady
    .then(() => {
      onAuthStateChanged(
        auth,
        async (user) => {
          notificationUnsubscribes.forEach((unsubscribe) => unsubscribe());
          notificationUnsubscribes = [];
          notificationSubscriptionVersion += 1;
          if (currentUid && currentUid !== (user?.uid || "")) {
            renderStudentSidebar({});
            notifications = [];
            deletedNotifications = [];
            renderNotifications();
          }
          currentUid = user?.uid || "";
          logNotificationStep("auth-wait-success", {
            authenticated: Boolean(user),
            uid: currentUid,
            appName: auth.app.name,
            projectId: auth.app.options.projectId,
          });
          if (!user) {
            clearCachedStudentProfile();
            notifications = [];
            deletedNotifications = [];
            recipientIds = [];
            notificationsLoading = false;
            notificationLoadError = "Sign in to view your notifications.";
            renderStudentSidebar({});
            renderNotifications();
            return;
          }
          notificationsLoading = true;
          notificationLoadError = "";
          renderNotifications();
          logNotificationStep("profile-fetch-start", {
            uid: user.uid,
            projectId: auth.app.options.projectId,
          });
          try {
            const profile = await loadStudentProfile(user);
            if (currentUid !== user.uid) return;
            renderStudentSidebar(profile);
            const ids = getRecipientIds(user, profile);
            subscribeToNotifications(user.uid, ids);
            logNotificationStep("profile-fetch-success", {
              uid: user.uid,
              projectId: auth.app.options.projectId,
              found: true,
              recipientIds,
            });
          } catch (error) {
            console.error("[Student Notifications] profile-fetch-error", {
              uid: user.uid,
              projectId: auth.app.options.projectId,
              code: error?.code || "",
              message: error?.message || String(error),
            });
            if (currentUid === user.uid) {
              subscribeToNotifications(user.uid, [user.uid]);
              renderStudentSidebar({});
            }
          }
        },
        (error) => {
          notificationsLoading = false;
          notificationLoadError = "Your sign-in could not be verified.";
          console.error("[Student Notifications] auth-wait-error", error);
          renderNotifications();
        },
      );
    })
    .catch((error) => {
      notificationsLoading = false;
      notificationLoadError = "Firebase authentication could not be initialized.";
      console.error("[Student Notifications] auth initialization failed:", error);
      renderNotifications();
    });
});

function openNotificationDetails(item) {
  const eventItem = (window.RECOVIBE_EVENTS || []).find(
    (event) => String(event.id || event.eventId) === String(item.eventId),
  );
  const modal = document.querySelector(
    "#notificationModalOverlay .notification-modal",
  );
  modal.id = `notification-details-${item.id}`;
  modal.dataset.notificationId = item.id;
  const field = (name) =>
    modal.querySelector(`[data-notification-field="${name}"]`);
  field("title").id = `notification-detail-title-${item.id}`;
  field("from").id = `notification-detail-from-${item.id}`;
  field("time").id = `notification-detail-time-${item.id}`;
  field("message").id = `notification-detail-message-${item.id}`;
  field("title").textContent = item.title;
  field("from").textContent = item.from ? `From ${item.from}` : "";
  field("time").textContent = item.time;
  field("message").textContent = item.message;
  modal.setAttribute("aria-labelledby", `notification-detail-title-${item.id}`);
  const reason = document.getElementById("notificationModalReason");
  reason.textContent = item.reason ? `Reason: ${item.reason}` : "";
  reason.hidden = !item.reason;
  const eventDetails = document.getElementById("notificationModalEvent");
  const viewEvent = document.getElementById("notificationViewEvent");
  if (eventItem) {
    document.getElementById("notificationEventLocation").textContent =
      eventItem.location;
    document.getElementById("notificationEventTime").textContent =
      eventItem.time;
    document.getElementById("notificationEventRoom").textContent =
      eventItem.room;
    let savedSlots = {};
    try {
      savedSlots = JSON.parse(
        localStorage.getItem("recovibeEventSlots") || "{}",
      );
    } catch (error) {
      savedSlots = {};
    }
    const slotsOpen =
      savedSlots[String(eventItem.id || eventItem.eventId)] ??
      eventItem.slotsOpen ??
      eventItem.slots ??
      0;
    document.getElementById("notificationEventSlots").textContent =
      eventItem.capacityMode === "N/A"
        ? "No capacity limit"
        : `${slotsOpen} of ${eventItem.maxSlots ?? eventItem.capacity ?? slotsOpen} slots open`;
    eventDetails.hidden = false;
    viewEvent.hidden = false;
    viewEvent.dataset.eventId = eventItem.id;
  } else {
    eventDetails.hidden = true;
    viewEvent.hidden = true;
  }
  document.getElementById("notificationModalOverlay").hidden = false;
}

function closeNotificationDetails() {
  document.getElementById("notificationModalOverlay").hidden = true;
}

function openDeleteConfirmation(id) {
  pendingDeleteId = id;
  document.getElementById("deleteConfirmOverlay").hidden = false;
}

function closeDeleteConfirmation() {
  pendingDeleteId = null;
  document.getElementById("deleteConfirmOverlay").hidden = true;
}

function deletePendingNotification() {
  const item = notifications.find(
    (notification) => notification.id === pendingDeleteId,
  );
  if (!item) return closeDeleteConfirmation();
  updateNotification(item.id, {
    deletedAt: serverTimestamp(),
  });
  closeDeleteConfirmation();
}
