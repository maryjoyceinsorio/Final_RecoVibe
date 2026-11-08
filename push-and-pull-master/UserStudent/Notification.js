const notificationStorageKey = "recovibeNotifications";
const deletedNotificationStorageKey = "recovibeDeletedNotifications";
const notificationExpansionKey = "recovibeNotificationExpansionV1";
const deletedNotificationLifetime = 7 * 24 * 60 * 60 * 1000;

const defaultNotifications = [];

function notificationValues(value) {
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
}

function notificationEvent(eventId) {
  if (!eventId) return null;
  const sources = [window.RECOVIBE_EVENTS];
  ["recovibeEventsCache", "recovibeOrganizerEvents", "recovibeTeacherEvents"].forEach((key) => {
    try {
      const cached = JSON.parse(localStorage.getItem(key) || "[]");
      if (Array.isArray(cached)) sources.push(cached);
    } catch (error) {
      console.warn(`Could not read ${key} for notification audience filtering:`, error);
    }
  });
  return sources.flatMap((source) => Array.isArray(source) ? source : []).find(
    (event) => String(event.id || event.eventId || "") === String(eventId),
  ) || null;
}

function normalizeNotificationOrganization(value) {
  const normalized = String(value || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (normalized === "PIEE" || normalized === "PIIE" || normalized.includes("INDUSTRIALENG")) return "PIIE";
  if (normalized === "IBITS" || normalized.includes("INFORMATIONTECH")) return "IBITS";
  if (normalized === "ACES" || normalized.includes("COMPUTERENG")) return "ACES";
  if (normalized === "SMS" || normalized.includes("MANAGEMENT")) return "SMS";
  if (normalized === "HRSS" || normalized.includes("HUMANRESOURCE")) return "HRSS";
  if (normalized === "YES" || normalized.includes("YOUNGEDUC")) return "YES";
  return normalized;
}

function normalizeNotificationDepartment(value) {
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
}

function isNotificationVisibleToStudent(notification) {
  const event = notificationEvent(notification.eventId) || {};
  const audience = String(
    notification.targetAudience || notification.audience || event.targetAudience || event.audience || "",
  ).toLowerCase().replace(/[^a-z0-9]/g, "");
  if (notification.openForAll === true || event.openForAll === true ||
      audience.startsWith("opentoall") || audience.startsWith("openforall")) return true;

  let profile = {};
  try {
    profile = JSON.parse(localStorage.getItem("recovibeCurrentUser") || "null") || {};
  } catch (error) {
    console.warn("Could not read student profile for notification filtering:", error);
  }
  const scopedNotification = { ...event, ...notification };
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
  ].map(normalizeNotificationOrganization).filter(Boolean);
  const studentOrganizations = [
    ...notificationValues(profile.organization),
    ...notificationValues(profile.courseOrganization),
    ...notificationValues(profile.organizationCode),
    ...notificationValues(profile.organizationId),
    ...notificationValues(profile.orgCode),
    ...notificationValues(profile.orgId),
    ...notificationValues(profile.organizations),
    ...notificationValues(profile.courseOrganizations),
  ].map(normalizeNotificationOrganization).filter(Boolean);
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
  ].map(normalizeNotificationDepartment).filter(Boolean);
  const studentDepartments = [
    ...notificationValues(profile.departmentCode),
    ...notificationValues(profile.departmentId),
    ...notificationValues(profile.department),
    ...notificationValues(profile.departments),
    ...notificationValues(profile.departmentIds),
    ...notificationValues(profile.course),
  ].map(normalizeNotificationDepartment).filter(Boolean);

  return targetOrganizations.some((organization) => studentOrganizations.includes(organization)) ||
    targetDepartments.some((department) => studentDepartments.includes(department));
}

const savedNotifications = JSON.parse(
  localStorage.getItem(notificationStorageKey) || "null",
);
let deletedNotifications = JSON.parse(
  localStorage.getItem(deletedNotificationStorageKey) || "[]",
).map((item) => ({
  ...item,
  expiresAt: item.expiresAt || Date.now() + deletedNotificationLifetime,
}));
let notifications = (savedNotifications || []).filter(
  (item) =>
    item &&
    !String(item.eventId || "").includes("leadership-seminar") &&
    !String(item.eventId || "").includes("ibits-general-assembly") &&
    !String(item.id || "").includes("leadership-seminar")
);
const existingNotificationIds = new Set(notifications.map((item) => item.id));
defaultNotifications.forEach((item) => {
  if (!existingNotificationIds.has(item.id)) notifications.push({ ...item });
});
const shouldExpandNotifications = !localStorage.getItem(
  notificationExpansionKey,
);
if (shouldExpandNotifications) {
  const restoredIds = new Set(notifications.map((item) => item.id));
  deletedNotifications.forEach(({ deletedAt, ...item }) => {
    if (!restoredIds.has(item.id)) notifications.push({ ...item, read: false });
  });
  notifications = notifications.map((item) => ({ ...item, read: false }));
  deletedNotifications = [];
  localStorage.setItem(notificationExpansionKey, "complete");
}
let activeFilter = "all";
let pendingDeleteId = null;

function saveNotifications() {
  localStorage.setItem(notificationStorageKey, JSON.stringify(notifications));
  saveDeletedNotifications();
}

function saveDeletedNotifications() {
  localStorage.setItem(
    deletedNotificationStorageKey,
    JSON.stringify(deletedNotifications),
  );
}

function renderDeletedNotifications() {
  const now = Date.now();
  const activeDeleted = deletedNotifications.filter(
    (item) => !item.expiresAt || item.expiresAt > now,
  );
  if (activeDeleted.length !== deletedNotifications.length) {
    deletedNotifications = activeDeleted;
    saveDeletedNotifications();
  }
  const list = document.getElementById("deletedNotificationList");
  const visibleDeletedNotifications = deletedNotifications.filter(isNotificationVisibleToStudent);
  list.innerHTML = visibleDeletedNotifications.length
    ? visibleDeletedNotifications
        .map(
          (item) => `
    <article class="notification-card deleted-notification-card type-${item.type}" data-deleted-notification-id="${item.id}">
      <h3 class="notification-title">${item.title}</h3>
      <p class="notification-message">${item.message}</p>
      <div class="notification-meta">${item.expiresAt ? `${Math.max(1, Math.ceil((item.expiresAt - now) / 86400000))} day(s) left in trash` : "Deleted recently"}</div>
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
    if (!isNotificationVisibleToStudent(item)) return false;
    const filterMatch =
      activeFilter === "all" ||
      (activeFilter === "read" ? item.read : !item.read);
    const textMatch =
      !query || `${item.title} ${item.message}`.toLowerCase().includes(query);
    return filterMatch && textMatch;
  });
  const list = document.getElementById("notificationList");
  list.innerHTML = visible.length
    ? visible
        .map(
          (item) => `
    <article class="notification-card type-${item.type} ${item.read ? "is-read" : ""}" id="notification-card-${item.id}" data-notification-id="${item.id}" tabindex="0" aria-label="${item.title}, ${item.read ? "read" : "unread"}">
      <div class="notification-actions">
        <button class="notification-menu-toggle" type="button" aria-label="More actions for ${item.title}" aria-expanded="false">
          <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><circle cx="4" cy="10" r="1.5"/><circle cx="10" cy="10" r="1.5"/><circle cx="16" cy="10" r="1.5"/></svg>
        </button>
        <div class="notification-menu" hidden>
          <button type="button" data-notification-action="read">Read</button>
          <button type="button" data-notification-action="unread">Unread</button>
          <button type="button" data-notification-action="delete">Delete</button>
        </div>
      </div>
      <h3 class="notification-title" id="notification-title-${item.id}" data-notification-field="title">${item.title}</h3>
      <p class="notification-message" id="notification-message-${item.id}" data-notification-field="message">${item.message}</p>
      <div class="notification-meta" id="notification-time-${item.id}" data-notification-field="time"><svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M10 3.5a4.5 4.5 0 0 0-4.5 4.5v2.4c0 .5-.2 1-.5 1.4L4 13h12l-1-1.2c-.3-.4-.5-.9-.5-1.4V8A4.5 4.5 0 0 0 10 3.5Z" stroke="currentColor" stroke-width="1.3"/><path d="M8.3 16a1.7 1.7 0 0 0 3.4 0" stroke="currentColor" stroke-width="1.3"/></svg>${item.time}</div>
    </article>`,
        )
        .join("")
    : '<div class="empty-notifications">No notifications match your filters.</div>';
  const unread = notifications.filter(
    (item) => !item.read && isNotificationVisibleToStudent(item),
  ).length;
  document.getElementById("navNotifBadge").textContent = unread;
  document.getElementById("navNotifBadge").hidden = unread === 0;
  renderDeletedNotifications();
}

function markAllRead() {
  notifications = notifications.map((item) =>
    isNotificationVisibleToStudent(item) ? { ...item, read: true } : item,
  );
  saveNotifications();
  renderNotifications();
}

function deleteAllNotifications() {
  if (!deletedNotifications.length) return;
  if (!window.confirm("Permanently delete all recently deleted notifications?"))
    return;
  deletedNotifications = [];
  saveDeletedNotifications();
  renderDeletedNotifications();
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
      localStorage.removeItem("recovibeCurrentUser"),
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
        }
        saveNotifications();
        saveDeletedNotifications();
        renderNotifications();
        return;
      }
      if (item) {
        item.read = true;
        saveNotifications();
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
        const { deletedAt, expiresAt, ...restoredItem } = item;
        notifications.unshift(restoredItem);
        deletedNotifications = deletedNotifications.filter(
          (notification) => notification.id !== item.id,
        );
        saveNotifications();
      } else {
        deletedNotifications = deletedNotifications.filter(
          (notification) => notification.id !== item.id,
        );
      }
      saveDeletedNotifications();
      renderNotifications();
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
        saveNotifications();
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
  saveNotifications();
  updateNotificationPanelControls(false);
  renderNotifications();
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
  const now = Date.now();
  notifications = notifications.filter(
    (notification) => notification.id !== item.id,
  );
  deletedNotifications.unshift({
    ...item,
    deletedAt: now,
    expiresAt: now + deletedNotificationLifetime,
  });
  saveNotifications();
  renderNotifications();
  closeDeleteConfirmation();
}
