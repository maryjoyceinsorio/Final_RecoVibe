const notificationStorageKey = "recovibeOrganizerNotifications";
const deletedNotificationStorageKey = "recovibeOrganizerDeletedNotifications";
const deletedNotificationLifetime = 30 * 24 * 60 * 60 * 1000;
const DEBUG = false;
let currentOrganizerUid = "";
let organizerIdentifiers = new Set();
const organizerProfile = {};
let firestoreNotificationError = "";
function debug(...args) {
  if (DEBUG) console.debug("[OrganizerNotifications]", ...args);
}
function readLocalArray(key) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || "[]");
    return Array.isArray(value) ? value : [];
  } catch (error) {
    debug(`Could not read ${key}:`, error);
    return [];
  }
}
let deletedNotifications = readLocalArray(deletedNotificationStorageKey).map((item) => {
  const deletedAt = Number(item.deletedAt) ||
    (item.expiresAt ? Number(item.expiresAt) - 7 * 86400000 : Date.now());
  return { ...item, deletedAt, expiresAt: deletedAt + deletedNotificationLifetime };
}).filter((item) => Date.now() - item.deletedAt <= deletedNotificationLifetime);
const normalizedNotificationStatus = (item) => {
  const statuses = [item.eventStatus, item.status, item.type, item.title, item.message]
    .filter(Boolean)
    .map((value) => String(value).trim().toLowerCase().replace(/[\s_-]+/g, " "));
  if (statuses.some((status) => status.includes("revision") || status.includes("revise"))) return "Needs Revision";
  if (statuses.some((status) => status.includes("resched"))) return "Rescheduled";
  if (statuses.some((status) => status.includes("cancel"))) return "Cancelled";
  if (statuses.some((status) => status.includes("publish"))) return "Published";
  if (statuses.some((status) => status.includes("approv"))) return "Approved";
  if (statuses.some((status) => status.includes("reject") || status.includes("denied"))) return "Rejected";
  return "";
};
const isEventStatusNotification = (item) =>
  Boolean(item.eventId && normalizedNotificationStatus(item));
const belongsToCurrentOrganizer = (item) => {
  const recipients = [
    item.ownerUid,
    item.organizerId,
    item.organizerUid,
    item.recipientUid,
    item.recipientId,
    item.recipientUserId,
    item.recipientUserId,
    item.userId,
    item.recipientEmail,
    item.email,
  ].filter(Boolean).map((value) => String(value).trim().toLowerCase());
  return recipients.some((identifier) => organizerIdentifiers.has(identifier));
};
const notificationValues = (value) => {
  const values = Array.isArray(value) ? value : [value];
  return values.flatMap((entry) => {
    if (typeof entry === "string") {
      return entry.split(",").map((item) => item.trim()).filter(Boolean);
    }
    if (entry && typeof entry === "object") {
      return [
        entry.organizationCode,
        entry.organizationId,
        entry.orgCode,
        entry.orgId,
        entry.departmentCode,
        entry.departmentId,
        entry.code,
        entry.id,
        entry.value,
        entry.name,
        entry.label,
      ].filter(Boolean).map(String);
    }
    return [];
  });

  document.getElementById("notificationMain").addEventListener("click", (event) => {
  if (!event.target.closest("[data-undo-delete]") || !undoDeletedItem) return;
  const { deletedAt, expiresAt, ...restoredItem } = undoDeletedItem;
  deletedNotifications = deletedNotifications.filter((item) => item.id !== undoDeletedItem.id);
  notifications.unshift(restoredItem);
  undoDeletedItem = null;
  clearTimeout(undoTimer);
  saveNotifications();
  renderNotifications();
  });
};
const findNotificationEvent = (eventId) => {
  if (!eventId) return null;
  const sources = [];
  ["recovibeOrganizerEvents", "recovibeEventsCache", "recovibeTeacherEvents"].forEach((key) => {
    try {
      const cached = JSON.parse(localStorage.getItem(key) || "[]");
      if (Array.isArray(cached)) sources.push(cached);
    } catch (error) {
      debug(`Could not read ${key} for audience filtering:`, error);
    }
  });
  return sources.flat().find(
    (event) => String(event.id || event.eventId || "") === String(eventId),
  ) || null;
};
const normalizeAudienceOrganization = (value) => {
  const normalized = String(value || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (normalized === "PIEE" || normalized === "PIIE" || normalized.includes("INDUSTRIALENG")) return "PIIE";
  if (normalized === "IBITS" || normalized.includes("INFORMATIONTECH")) return "IBITS";
  if (normalized === "ACES" || normalized.includes("COMPUTERENG")) return "ACES";
  if (normalized === "SMS" || normalized.includes("MANAGEMENT")) return "SMS";
  if (normalized === "HRSS" || normalized.includes("HUMANRESOURCE")) return "HRSS";
  if (normalized === "YES" || normalized.includes("YOUNGEDUC")) return "YES";
  return normalized;
};
const normalizeAudienceDepartment = (value) => {
  const label = String(value || "").trim().toLowerCase();
  const normalized = label.replace(/[^a-z0-9]/g, "");
  if (normalized === "bsit" || label.includes("information technology")) return "bsit";
  if (normalized === "bscpe" || label.includes("computer engineering")) return "bscpe";
  if (normalized === "bsie" || label.includes("industrial engineering")) return "bsie";
  if (normalized === "bsbahrm" || label.includes("human resource management")) return "bsbahrm";
  if (label.includes("elementary") || normalized.includes("bselementary")) return "bselementaryeducation";
  if (label.includes("secondary") || normalized === "bssecondary") return "bssecondary";
  if (label.includes("psychology") || normalized === "bspsychology") return "bspsychology";
  return normalized;
};
const isNotificationVisibleToOrganizer = (item) => {
  const event = findNotificationEvent(item.eventId) || {};
  const audience = String(
    item.targetAudience || item.audience || event.targetAudience || event.audience || "",
  ).toLowerCase().replace(/[^a-z0-9]/g, "");
  if (item.openForAll === true || event.openForAll === true ||
      audience.startsWith("opentoall") || audience.startsWith("openforall")) return true;

  const scopedNotification = { ...event, ...item };
  const targetOrganizations = [
    ...notificationValues(scopedNotification.organizationCodes),
    ...notificationValues(scopedNotification.targetOrganizations),
    ...notificationValues(scopedNotification.targetOrganization),
    ...notificationValues(scopedNotification.audienceOrganizations),
    ...notificationValues(scopedNotification.coOrganizerOrganizations),
    ...notificationValues(scopedNotification.coOrganizerOrgIds),
    ...notificationValues(scopedNotification.coOrganizerOrganization),
    ...notificationValues(scopedNotification.collaboratorOrganizations),
    ...notificationValues(scopedNotification.collaboratorOrgIds),
    ...notificationValues(scopedNotification.collaboratorOrganization),
    ...notificationValues(scopedNotification.collaborationOrganizations),
    ...notificationValues(scopedNotification.collaborationOrgIds),
    ...notificationValues(scopedNotification.collaboratingOrganizations),
    ...notificationValues(scopedNotification.coOrganizers),
    ...notificationValues(scopedNotification.coOrganizer),
    ...notificationValues(scopedNotification.collaborators),
    ...notificationValues(scopedNotification.collaborator),
    ...notificationValues(scopedNotification.partnerOrganizations),
    ...notificationValues(scopedNotification.organizationCode),
    ...notificationValues(scopedNotification.organizationId),
    ...notificationValues(scopedNotification.organizerOrganization),
    ...notificationValues(scopedNotification.orgCode),
    ...notificationValues(scopedNotification.orgId),
    ...notificationValues(scopedNotification.organization),
    ...notificationValues(scopedNotification.organizationName),
    ...notificationValues(scopedNotification.orgName),
  ].map(normalizeAudienceOrganization).filter(Boolean);
  const organizerOrganizations = [
    ...notificationValues(organizerProfile.organization),
    ...notificationValues(organizerProfile.organizationCode),
    ...notificationValues(organizerProfile.organizationId),
    ...notificationValues(organizerProfile.orgCode),
    ...notificationValues(organizerProfile.orgId),
    ...notificationValues(organizerProfile.organizations),
    ...notificationValues(organizerProfile.courseOrganizations),
  ].map(normalizeAudienceOrganization).filter(Boolean);
  const targetDepartments = [
    ...notificationValues(scopedNotification.departmentCodes),
    ...notificationValues(scopedNotification.targetDepartments),
    ...notificationValues(scopedNotification.targetDepartment),
    ...notificationValues(scopedNotification.targetDepartmentIds),
    ...notificationValues(scopedNotification.departments),
    ...notificationValues(scopedNotification.departmentIds),
    ...notificationValues(scopedNotification.departmentCode),
    ...notificationValues(scopedNotification.departmentId),
    ...notificationValues(scopedNotification.department),
  ].map(normalizeAudienceDepartment).filter(Boolean);
  const organizerDepartments = [
    ...notificationValues(organizerProfile.departmentCode),
    ...notificationValues(organizerProfile.departmentId),
    ...notificationValues(organizerProfile.department),
    ...notificationValues(organizerProfile.departments),
    ...notificationValues(organizerProfile.departmentIds),
  ].map(normalizeAudienceDepartment).filter(Boolean);

  return targetOrganizations.some((organization) =>
    organizerOrganizations.includes(organization),
  ) || targetDepartments.some((department) =>
    organizerDepartments.includes(department),
  );
};
const belongsToVisibleOrganizer = (item) =>
  Boolean(currentOrganizerUid) && String(item.ownerUid || "") === currentOrganizerUid;
const normalizeNotification = (item, id = item.id) => {
  const eventStatus = normalizedNotificationStatus(item);
  const createdAt = item.createdAt?.toDate
    ? item.createdAt.toDate().toISOString()
    : item.createdAt || "";
  return {
    ...item,
    id: String(id || item.id || ""),
    eventStatus,
    eventId: item.eventId || "",
    title: item.title || (eventStatus ? `Event ${eventStatus}` : "Notification"),
    message: item.message || "",
    type: item.type || (eventStatus ? eventStatus.toLowerCase() : "default"),
    read: item.read === true || item.isRead === true,
    ownerUid: item.ownerUid || currentOrganizerUid,
    organizerId: item.organizerId || currentOrganizerUid,
    createdAt,
    source: item.source || "derived",
  };
};
let notifications = [];
deletedNotifications = deletedNotifications.filter(
  (item) => item.expiresAt > Date.now(),
);
deletedNotifications = deletedNotifications.map((item) => normalizeNotification(item));

let activeFilter = "all";
let pendingDeleteId = null;
let undoDeletedItem = null;
let undoTimer = null;
let showingTrashView = false;
const pendingNotificationActions = new Set();

function escapeHtml(value) {
  return String(value ?? "").replace(
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
}

function notificationDate(value) {
  if (value && typeof value.toDate === "function") return value.toDate();
  if (value && typeof value.toMillis === "function") return new Date(value.toMillis());
  if (value && typeof value.seconds === "number") return new Date(value.seconds * 1000);
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value);
  if (typeof value === "string" && value.trim()) {
    const dateOnly = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (dateOnly) return new Date(+dateOnly[1], +dateOnly[2] - 1, +dateOnly[3]);
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date : null;
  }
  return null;
}

function notificationGroup(item) {
  const date = notificationDate(item.createdAt);
  if (!date) return "Earlier";
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return "Today";
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  start.setDate(start.getDate() - start.getDay());
  return date >= start ? "This week" : "Earlier";
}

function notificationTimeLabels(item) {
  const date = notificationDate(item.createdAt);
  if (!date) return { date: "", relative: "" };
  const now = new Date();
  const diff = Math.max(0, now.getTime() - date.getTime());
  let relative = "Just now";
  if (date.toDateString() !== now.toDateString()) {
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    if (date.toDateString() === yesterday.toDateString()) relative = "Yesterday";
    else {
      const days = Math.floor(diff / 86400000);
      relative = days < 7 ? `${days} days ago` : `${Math.floor(days / 7)} weeks ago`;
    }
  } else if (diff >= 60000) {
    const minutes = Math.floor(diff / 60000);
    relative = minutes < 60 ? `${minutes} minute${minutes === 1 ? "" : "s"} ago` : `${Math.floor(minutes / 60)} hours ago`;
  }
  return {
    date: new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(date),
    relative,
  };
}

function notificationIcon(item) {
  const type = String(item.type || "").toLowerCase();
  if (type.includes("register") || type.includes("confirm")) {
    return '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m4 10 4 4 8-8"/></svg>';
  }
  if (type.includes("event") || item.eventStatus) {
    return '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="3" y="4" width="14" height="13" rx="1.5"/><path d="M3 8h14M7 2.5v3M13 2.5v3"/></svg>';
  }
  return '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M16 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M8 20a2 2 0 0 0 4 0"/></svg>';
}

function renderNotificationCard(item, inTrash = false) {
  const { date, relative } = notificationTimeLabels(item);
  const tag = item.tag || item.eventStatus || "";
  const id = escapeHtml(item.id);
  const controls = inTrash
    ? `<button type="button" data-deleted-action="restore" ${pendingNotificationActions.has(item.id) ? "disabled" : ""}>Restore</button><button type="button" data-deleted-action="delete-permanently" ${pendingNotificationActions.has(item.id) ? "disabled" : ""}>Delete forever</button><small>Removed in ${Math.max(0, Math.ceil((item.expiresAt - Date.now()) / 86400000))} days</small>`
    : `<button class="notification-read-toggle" type="button" data-notification-action="${item.read ? "unread" : "read"}" aria-label="Mark as ${item.read ? "unread" : "read"}" title="Mark as ${item.read ? "unread" : "read"}" ${pendingNotificationActions.has(item.id) ? "disabled" : ""}><span aria-hidden="true"></span></button><button class="notification-trash-toggle" type="button" data-notification-action="delete" aria-label="Move to Recently Deleted" title="Move to Recently Deleted" ${pendingNotificationActions.has(item.id) ? "disabled" : ""}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 6h12M8 6V4.5h4V6m-6.5 0 .7 10h7.6l.7-10M8.5 9v4m3-4v4"/></svg></button>`;
  return `<li><article class="notification-card ${item.read ? "is-read" : "is-unread"}" ${inTrash ? `data-deleted-notification-id="${id}"` : `data-notification-id="${id}"`} tabindex="0" aria-label="${escapeHtml(item.title)}, ${item.read ? "read" : "unread"}">
    <span class="notification-icon" aria-hidden="true">${notificationIcon(item)}</span>
    <span class="notification-copy"><strong class="notification-title">${escapeHtml(item.title)}</strong><span class="notification-message">${escapeHtml(item.message)}</span><span class="notification-meta">${tag ? `<span class="notification-tag">${escapeHtml(tag)}</span>` : ""}${date ? `<time>${escapeHtml(date)}</time>` : ""}${relative ? `<span>${escapeHtml(relative)}</span>` : ""}</span>${inTrash ? `<span class="notification-trash-actions">${controls}</span>` : ""}</span>
    ${inTrash ? "" : `<span class="notification-card-actions">${controls}</span>`}
  </article></li>`;
}

async function updateOrganizerFirestoreRead(item, read) {
  if (item.source !== "firestore") return;
  const [config, firestoreModule] = await Promise.all([
    import("../UserStudent/firebaseConfig.js"),
    import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js"),
  ]);
  const user = config.auth?.currentUser;
  if (!user || user.uid !== currentOrganizerUid) {
    throw new Error("The signed-in organizer could not be verified.");
  }
  await firestoreModule.updateDoc(
    firestoreModule.doc(config.db, "notifications", item.id),
    { read: Boolean(read) },
  );
}

async function permanentlyDeleteOrganizerNotification(item) {
  if (item.source !== "firestore") return;
  const [config, firestoreModule] = await Promise.all([
    import("../UserStudent/firebaseConfig.js"),
    import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js"),
  ]);
  const user = config.auth?.currentUser;
  if (!user || user.uid !== currentOrganizerUid) {
    throw new Error("The signed-in organizer could not be verified.");
  }
  await firestoreModule.deleteDoc(
    firestoreModule.doc(config.db, "notifications", item.id),
  );
}

async function setOrganizerNotificationRead(item, read) {
  if (!item || pendingNotificationActions.has(item.id)) return false;
  pendingNotificationActions.add(item.id);
  renderNotifications();
  try {
    await updateOrganizerFirestoreRead(item, read);
    item.read = Boolean(read);
    window.OrganizerNotificationData?.setRead(item.id, read);
    saveNotifications();
    return true;
  } catch (error) {
    console.error("[OrganizerNotifications] Could not update notification read state:", error);
    window.alert("This notification could not be updated. Please try again.");
    return false;
  } finally {
    pendingNotificationActions.delete(item.id);
    renderNotifications();
  }
}

function refreshNotificationsFromStorage() {
  const stored = readLocalArray(notificationStorageKey);
  notifications = Array.isArray(stored)
    ? stored.filter(
        (item) => belongsToVisibleOrganizer(item) &&
          !deletedNotifications.some((deletedItem) => deletedItem.id === item.id),
      )
    : [];
  notifications = notifications.map((item) => normalizeNotification(item));
  notifications.sort((first, second) =>
    (notificationDate(second.createdAt)?.getTime() || 0) -
    (notificationDate(first.createdAt)?.getTime() || 0),
  );
  renderNotifications();
}

function saveNotifications() {
  const stored = readLocalArray(notificationStorageKey);
  const others = Array.isArray(stored)
    ? stored.filter((item) => item.ownerUid && item.ownerUid !== currentOrganizerUid)
    : [];
  notifications = notifications.map((item) => normalizeNotification(item));
  localStorage.setItem(
    notificationStorageKey,
    JSON.stringify([...others, ...notifications.map((item) => ({
      ...item,
      ownerUid: currentOrganizerUid,
    }))]),
  );
  saveDeletedNotifications();
  window.dispatchEvent(new Event("recovibeOrganizerNotificationsChanged"));
}

function saveDeletedNotifications() {
  const stored = readLocalArray(deletedNotificationStorageKey);
  const others = Array.isArray(stored)
    ? stored.filter((item) => item.ownerUid && item.ownerUid !== currentOrganizerUid)
    : [];
  localStorage.setItem(
    deletedNotificationStorageKey,
    JSON.stringify([...others, ...deletedNotifications.map((item) => ({
      ...item,
      ownerUid: currentOrganizerUid,
    }))]),
  );
}

function connectToSharedNotifications() {
  const service = window.OrganizerNotificationData;
  if (!service) {
    firestoreNotificationError = "Notifications could not be initialized. Please try again.";
    renderNotifications();
    return;
  }
  service.subscribe((state) => {
    currentOrganizerUid = state.uid || "";
    organizerIdentifiers = new Set(currentOrganizerUid ? [currentOrganizerUid.toLowerCase()] : []);
    firestoreNotificationError = state.error || "";
    notifications = (state.items || []).map((item) => normalizeNotification(item));
    notifications.sort((first, second) =>
      (notificationDate(second.createdAt)?.getTime() || 0) -
      (notificationDate(first.createdAt)?.getTime() || 0),
    );
    try {
      deletedNotifications = readLocalArray(deletedNotificationStorageKey)
        .filter((item) => item.ownerUid === currentOrganizerUid && item.expiresAt > Date.now())
        .map((item) => normalizeNotification(item));
    } catch (error) {
      console.error("[OrganizerNotifications] Could not restore deleted notifications:", error);
    }
    renderNotifications();
  });
}

function serviceRetryNotifications() {
  window.OrganizerNotificationData?.retry();
}

function renderDeletedNotifications() {
  const now = Date.now();
  const activeDeleted = deletedNotifications.filter(
    (item) => item.expiresAt > now && belongsToVisibleOrganizer(item),
  );
  if (activeDeleted.length !== deletedNotifications.length) {
    deletedNotifications = activeDeleted;
    saveDeletedNotifications();
  }

  const list = document.getElementById("deletedNotificationList");
  list.innerHTML = deletedNotifications.length
    ? `<ul class="notification-list">${deletedNotifications.map((item) => renderNotificationCard(item, true)).join("")}</ul>`
    : '<div class="notification-state"><span class="notification-state-icon" aria-hidden="true"><svg viewBox="0 0 20 20"><path d="M16 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M8 20a2 2 0 0 0 4 0"/></svg></span><strong>Recently Deleted is empty</strong><p>Notifications you delete will wait here for 30 days before they are removed.</p></div>';
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
    return belongsToVisibleOrganizer(item) && filterMatch && textMatch;
  });

  const list = document.getElementById("notificationList");
  const errorMarkup = firestoreNotificationError
    ? `<div class="notification-source-warning" role="alert">${escapeHtml(firestoreNotificationError)} <button type="button" data-retry-notifications>Try again</button></div>`
    : "";
  list.innerHTML = errorMarkup + (visible.length
    ? ["Today", "This week", "Earlier"].map((group) => {
        const items = visible.filter((item) => notificationGroup(item) === group);
        return items.length
          ? `<section class="notification-group"><h2>${group.toUpperCase()}</h2><ul class="notification-list">${items.map((item) => renderNotificationCard(item)).join("")}</ul></section>`
          : "";
      }).join("")
    : `<div class="notification-state"><span class="notification-state-icon" aria-hidden="true"><svg viewBox="0 0 20 20"><path d="M16 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M8 20a2 2 0 0 0 4 0"/></svg></span><strong>${activeFilter === "unread" ? "No unread notifications" : "No notifications yet"}</strong><p>${activeFilter === "unread" ? "Everything has been read. Nice work." : "New notifications will show up here."}</p></div>`);

  const unread = notifications.filter(
    (item) => !item.read && belongsToVisibleOrganizer(item),
  ).length;
  const badge = document.getElementById("navNotifBadge");
  if (badge) {
    badge.textContent = unread > 9 ? "9+" : unread ? String(unread) : "";
    badge.hidden = unread === 0;
  }

  const unreadCount = notifications.filter((item) => !item.read && belongsToVisibleOrganizer(item)).length;
  const unreadLabel = document.getElementById("notificationUnreadCount");
  if (unreadLabel) unreadLabel.textContent = String(unreadCount);
  document.querySelectorAll("[data-notification-filter]").forEach((button) => {
    const selected = button.dataset.notificationFilter === activeFilter ||
      (button.dataset.notificationFilter === "all" && activeFilter === "read");
    button.classList.toggle("is-active", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
  const firstPanel = document.getElementById("notificationPanels")?.querySelector(":scope > .notifications-panel");
  showingTrashView = firstPanel?.id === "deletedNotificationsPanel";
  document.getElementById("recentDeletedInfo").hidden = !showingTrashView;
  const action = document.getElementById("markAllRead");
  action.textContent = showingTrashView ? "Empty trash" : "Mark all as read";
  action.disabled = pendingNotificationActions.size > 0 ||
    (showingTrashView ? deletedNotifications.length === 0 : unreadCount === 0);
  document.getElementById("showDeletedNotifications").setAttribute(
    "aria-label",
    showingTrashView ? "Return to notifications" : "Open Recently Deleted",
  );
  renderDeletedNotifications();
}

async function markAllRead() {
  const unread = notifications.filter((item) => !item.read && belongsToVisibleOrganizer(item));
  const action = document.getElementById("markAllRead");
  if (action) action.disabled = true;
  const results = await Promise.all(unread.map(async (item) => {
    pendingNotificationActions.add(item.id);
    try {
      await updateOrganizerFirestoreRead(item, true);
      item.read = true;
      return true;
    } catch (error) {
      console.error("[OrganizerNotifications] Could not mark notification as read:", error);
      return false;
    } finally {
      pendingNotificationActions.delete(item.id);
    }
  }));
  saveNotifications();
  renderNotifications();
  const toast = document.getElementById("organizerNotificationToast");
  if (toast) {
    toast.textContent = results.every(Boolean)
      ? "All notifications marked as read."
      : "Some notifications could not be updated. Please try again.";
    toast.hidden = false;
    clearTimeout(undoTimer);
    undoTimer = setTimeout(() => { toast.hidden = true; }, 3000);
  }
}

async function deleteAllNotifications() {
  if (!deletedNotifications.length) return;
  const count = deletedNotifications.length;
  if (!window.confirm(`Permanently delete all ${count} notifications? This cannot be undone.`)) return;
  const action = document.getElementById("markAllRead");
  if (action) action.disabled = true;
  const items = [...deletedNotifications];
  items.forEach((item) => pendingNotificationActions.add(item.id));
  renderNotifications();
  const failed = [];
  for (const item of items) {
    try {
      await permanentlyDeleteOrganizerNotification(item);
      deletedNotifications = deletedNotifications.filter((entry) => entry.id !== item.id);
    } catch (error) {
      console.error("[OrganizerNotifications] Could not permanently delete notification:", error);
      failed.push(item);
    } finally {
      pendingNotificationActions.delete(item.id);
    }
  }
  saveDeletedNotifications();
  renderNotifications();
  if (failed.length) window.alert(`${failed.length} notifications could not be permanently deleted. Please try again.`);
}

function updateNotificationPanelControls(showingDeletedNotifications) {
  const toggle = document.getElementById("showDeletedNotifications");
  const label = document.getElementById("showDeletedNotificationsLabel");
  const icon = document.getElementById("showDeletedNotificationsIcon");
  const action = document.getElementById("markAllRead");

  if (!toggle || !label || !icon || !action) return;

  toggle.setAttribute("aria-pressed", String(showingDeletedNotifications));
  toggle.setAttribute("aria-label", showingDeletedNotifications ? "Return to notifications" : "Open Recently Deleted");
  label.textContent = showingDeletedNotifications
    ? "All Notifications"
    : "Recently Deleted";
  action.textContent = showingDeletedNotifications ? "Empty trash" : "Mark all as read";
  icon.innerHTML = showingDeletedNotifications
    ? '<path d="M3.5 5.5h13M5 5.5v10h10v-10M7.5 3.5h5l1 2h-7l1-2M8 8v5m4-5v5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>'
    : '<path d="M4 6h12M8 6V4.5h4V6m-6.5 0 .7 10h7.6l.7-10M8.5 9v4m3-4v4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>';
}

function swapNotificationPanels() {
  const panels = document.getElementById("notificationPanels");
  const allPanel = document.getElementById("allNotificationsPanel");
  const deletedPanel = document.getElementById("deletedNotificationsPanel");
  if (!panels || !allPanel || !deletedPanel) return;

  const firstPanel = panels.querySelector(":scope > .notifications-panel");
  const showingDeletedNotifications =
    firstPanel.id !== "deletedNotificationsPanel";
  if (showingDeletedNotifications) panels.insertBefore(deletedPanel, allPanel);
  else panels.insertBefore(allPanel, deletedPanel);
  updateNotificationPanelControls(showingDeletedNotifications);
}

function openDeleteConfirmation(id) {
  pendingDeleteId = id;
  const overlay = document.getElementById("deleteConfirmOverlay");
  if (overlay) overlay.hidden = false;
}

function closeDeleteConfirmation() {
  pendingDeleteId = null;
  const overlay = document.getElementById("deleteConfirmOverlay");
  if (overlay) overlay.hidden = true;
}

function deletePendingNotification() {
  if (!pendingDeleteId) return;
  const target = notifications.find((item) => item.id === pendingDeleteId);
  if (!target) return;

  const moved = {
    ...target,
    deletedAt: Date.now(),
    expiresAt: Date.now() + deletedNotificationLifetime,
  };
  notifications = notifications.filter((item) => item.id !== pendingDeleteId);
  deletedNotifications.unshift(moved);
  undoDeletedItem = moved;
  saveNotifications();
  closeDeleteConfirmation();
  renderNotifications();
  const toast = document.getElementById("organizerNotificationToast");
  if (toast) {
    toast.innerHTML = 'Moved to Recently Deleted <button type="button" data-undo-delete>Undo</button>';
    toast.hidden = false;
    clearTimeout(undoTimer);
    undoTimer = setTimeout(() => {
      undoDeletedItem = null;
      toast.hidden = true;
    }, 6000);
  }
}

function openNotificationDetails(item) {
  const eventItem =
    typeof getOrganizerEvents === "function"
      ? getOrganizerEvents().find(
          (event) => String(event.eventId) === String(item.eventId),
        )
      : null;
  const overlay = document.getElementById("notificationModalOverlay");
  const modal = overlay?.querySelector(".notification-modal");
  if (!overlay || !modal) return;

  const title = modal.querySelector('[data-notification-field="title"]');
  const from = modal.querySelector('[data-notification-field="from"]');
  const time = modal.querySelector('[data-notification-field="time"]');
  const message = modal.querySelector('[data-notification-field="message"]');

  if (title) title.textContent = item.title;
  if (from) from.textContent = item.from ? `From ${item.from}` : "";
  if (time) time.textContent = item.time;
  if (message) message.textContent = item.message;

  const reason = document.getElementById("notificationModalReason");
  if (reason) {
    reason.textContent = item.reason ? `Reason: ${item.reason}` : "";
    reason.hidden = !item.reason;
  }

  const eventDetails = document.getElementById("notificationModalEvent");
  const eventButton = document.getElementById("notificationViewEvent");
  if (eventItem) {
    document.getElementById("notificationEventLocation").textContent =
      eventItem.location;
    document.getElementById("notificationEventTime").textContent =
      eventItem.time;
    document.getElementById("notificationEventRoom").textContent =
      eventItem.room;
    document.getElementById("notificationEventSlots").textContent =
      `${eventItem.capacity ?? 0} total capacity`;
    if (eventDetails) eventDetails.hidden = false;
    if (eventButton) {
      eventButton.hidden = false;
      eventButton.dataset.eventId = eventItem.eventId;
    }
  } else {
    if (eventDetails) eventDetails.hidden = true;
    if (eventButton) {
      eventButton.hidden = true;
      delete eventButton.dataset.eventId;
    }
  }

  overlay.hidden = false;
}

function closeNotificationDetails() {
  const overlay = document.getElementById("notificationModalOverlay");
  if (overlay) overlay.hidden = true;
}

document.addEventListener("DOMContentLoaded", () => {
  const searchInput = document.getElementById("notificationSearch");
  const filterSelect = document.getElementById("notificationFilter");
  window.enhanceDropdownSelects?.("#notificationFilter");
  const list = document.getElementById("notificationList");
  const deletedList = document.getElementById("deletedNotificationList");
  const toggle = document.getElementById("showDeletedNotifications");
  const markReadButton = document.getElementById("markAllRead");
  const closeButton = document.getElementById("notificationModalClose");
  const overlay = document.getElementById("notificationModalOverlay");
  const deleteOverlay = document.getElementById("deleteConfirmOverlay");

  window.addEventListener(
    "recovibeOrganizerNotificationsChanged",
    refreshNotificationsFromStorage,
  );
  window.addEventListener("storage", (event) => {
    if (
      event.key === notificationStorageKey ||
      event.key === deletedNotificationStorageKey
    ) {
      refreshNotificationsFromStorage();
    }
  });

  if (searchInput) searchInput.addEventListener("input", renderNotifications);
  if (filterSelect)
    filterSelect.addEventListener("change", (event) => {
      activeFilter = event.target.value;
      renderNotifications();
    });
  document.querySelectorAll("[data-notification-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      filterSelect.value = button.dataset.notificationFilter;
      filterSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });
  });

  if (toggle)
    toggle.addEventListener("click", () => {
      swapNotificationPanels();
      renderNotifications();
    });

  if (markReadButton)
    markReadButton.addEventListener("click", () => {
      const firstPanel = document
        .getElementById("notificationPanels")
        ?.querySelector(":scope > .notifications-panel");
      const showingDeletedNotifications =
        firstPanel?.id === "deletedNotificationsPanel";
      if (showingDeletedNotifications) void deleteAllNotifications();
      else void markAllRead();
    });

  if (list)
    list.addEventListener("click", (event) => {
      if (event.target.closest("[data-retry-notifications]")) {
        firestoreNotificationError = "";
        renderNotifications();
        serviceRetryNotifications();
        return;
      }
      const card = event.target.closest("[data-notification-id]");
      if (!card) return;

      const menuToggle = event.target.closest(".notification-menu-toggle");
      const menuAction = event.target.closest("[data-notification-action]");
      const item = notifications.find(
        (notification) => notification.id === card.dataset.notificationId,
      );

      if (menuToggle) {
        const menu = card.querySelector(".notification-menu");
        if (!menu) return;
        const isOpen = !menu.hidden;
        document.querySelectorAll(".notification-menu").forEach((menuNode) => {
          menuNode.hidden = true;
        });
        document
          .querySelectorAll(".notification-menu-toggle")
          .forEach((button) => button.setAttribute("aria-expanded", "false"));
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
            .forEach((menuNode) => {
              menuNode.hidden = true;
            });
          openDeleteConfirmation(item.id);
          return;
        }
        void setOrganizerNotificationRead(item, menuAction.dataset.notificationAction === "read");
        return;
      }

      if (item) {
        void setOrganizerNotificationRead(item, true).then((success) => {
          if (success && item.eventId) {
            window.location.href = `EventOrganizerMyEvents.html?event=${encodeURIComponent(item.eventId)}`;
          }
        });
      }
    });
  if (list)
    list.addEventListener("keydown", (event) => {
      if (!["Enter", " "].includes(event.key) || event.target.closest("button, a, input, select")) return;
      const card = event.target.closest("[data-notification-id]");
      if (!card) return;
      const item = notifications.find((notification) => notification.id === card.dataset.notificationId);
      if (!item) return;
      event.preventDefault();
      void setOrganizerNotificationRead(item, true).then((success) => {
        if (success && item.eventId) {
          window.location.href = `EventOrganizerMyEvents.html?event=${encodeURIComponent(item.eventId)}`;
        }
      });
    });

  if (deletedList)
    deletedList.addEventListener("click", (event) => {
      const action = event.target.closest("[data-deleted-action]");
      const card = event.target.closest("[data-deleted-notification-id]");
      if (!action || !card) return;

      const item = deletedNotifications.find(
        (notification) =>
          notification.id === card.dataset.deletedNotificationId,
      );
      if (!item) return;

      if (action.dataset.deletedAction === "restore") {
        const { deletedAt, expiresAt, ...restoredItem } = item;
        notifications.unshift(restoredItem);
        deletedNotifications = deletedNotifications.filter(
          (notification) => notification.id !== item.id,
        );
        saveNotifications();
      } else {
        if (!window.confirm("Permanently delete this notification? This cannot be undone.")) return;
        if (pendingNotificationActions.has(item.id)) return;
        pendingNotificationActions.add(item.id);
        renderNotifications();
        void permanentlyDeleteOrganizerNotification(item)
          .then(() => {
            deletedNotifications = deletedNotifications.filter(
              (notification) => notification.id !== item.id,
            );
            saveDeletedNotifications();
          })
          .catch((error) => {
            console.error("[OrganizerNotifications] Could not permanently delete notification:", error);
            window.alert("This notification could not be permanently deleted. Please try again.");
          })
          .finally(() => {
            pendingNotificationActions.delete(item.id);
            renderNotifications();
          });
        return;
      }

      saveDeletedNotifications();
      renderNotifications();
    });

  if (closeButton)
    closeButton.addEventListener("click", closeNotificationDetails);
  if (overlay)
    overlay.addEventListener("click", (event) => {
      if (event.target.id === "notificationModalOverlay")
        closeNotificationDetails();
    });

  if (deleteOverlay)
    deleteOverlay.addEventListener("click", (event) => {
      if (event.target.id === "deleteConfirmOverlay") closeDeleteConfirmation();
    });

  const confirmDeleteButton = document.getElementById(
    "confirmDeleteNotification",
  );
  if (confirmDeleteButton)
    confirmDeleteButton.addEventListener("click", deletePendingNotification);

  const cancelDeleteButton = document.getElementById(
    "cancelDeleteNotification",
  );
  if (cancelDeleteButton)
    cancelDeleteButton.addEventListener("click", closeDeleteConfirmation);

  const deleteCloseButton = document.getElementById("deleteConfirmClose");
  if (deleteCloseButton)
    deleteCloseButton.addEventListener("click", closeDeleteConfirmation);

  connectToSharedNotifications();

  const viewEventButton = document.getElementById("notificationViewEvent");
  if (viewEventButton)
    viewEventButton.addEventListener("click", () => {
      const eventId = viewEventButton.dataset.eventId;
      if (eventId) {
        window.location.href = `EventOrganizerMyEvents.html?event=${encodeURIComponent(eventId)}`;
        return;
      }
      const event =
        typeof getOrganizerEvents === "function"
          ? getOrganizerEvents().find(
              (item) => String(item.eventId || item.id) === String(eventId),
            )
          : null;
      if (!event) return;
      closeNotificationDetails();
      window.RecovibeEventDetails?.open(event);
    });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeNotificationDetails();
      closeDeleteConfirmation();
    }
  });

  saveNotifications();
  updateNotificationPanelControls(false);
  renderNotifications();
});
