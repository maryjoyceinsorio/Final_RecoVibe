(() => {
  const DEBUG = false;
  const notificationStorageKey = "recovibeTeacherNotifications";
  const deletedStorageKey = "recovibeTeacherDeletedNotifications";
  const deletedLifetime = 30 * 24 * 60 * 60 * 1000;
  const hasNotificationPage = Boolean(document.getElementById("notificationList"));
  let teacherProfile = {};
  try {
    teacherProfile = JSON.parse(
      localStorage.getItem("recovibeCurrentTeacher") ||
      localStorage.getItem("recovibeTeacher") ||
      "{}",
    );
  } catch (error) {
    if (DEBUG) console.debug("[Teacher Notifications] Could not read the cached profile:", error);
  }
  const teacherIdentifiers = new Set([
    teacherProfile.uid,
    teacherProfile.userId,
    teacherProfile.id,
    teacherProfile.email,
    teacherProfile.teacherId,
    teacherProfile.employeeId,
  ].filter(Boolean).map((value) => String(value).trim().toLowerCase()));
  try {
    const cachedTeacherId = localStorage.getItem("recovibeTeacherId");
    if (cachedTeacherId) teacherIdentifiers.add(cachedTeacherId.trim().toLowerCase());
  } catch (error) {
    if (DEBUG) console.debug("[Teacher Notifications] Could not read the cached teacher id:", error);
  }
  let currentUid = "";
  let authenticated = false;
  let identityResolved = false;
  let notifications = [];
  let deletedNotifications = [];
  let dataModule = null;
  let retrySources = null;
  let notificationsLoading = true;
  let allSourcesFailed = false;
  let sourceError = "";
  let activeFilter = "all";
  let pendingDeleteId = null;
  let undoDeletedItem = null;
  let undoTimer = null;
  let pageLoadSignaled = false;

  function signalPageReady() {
    if (pageLoadSignaled) return;
    pageLoadSignaled = true;
    window.dispatchEvent(new Event("page-data-ready"));
  }

  function debug(...args) {
    if (DEBUG) console.debug("[Teacher Notifications]", ...args);
  }

  function belongsToCurrentTeacher(item) {
    const owners = [
      item.userId,
      item.recipientUid,
      item.teacherId,
      item.teacherUid,
      item.recipientId,
      item.ownerId,
      item.recipientEmail,
      item.email,
    ].filter(Boolean).map((value) => String(value).trim().toLowerCase());
    if (currentUid && owners.includes(currentUid.toLowerCase())) return true;
    if (authenticated) return false;
    return owners.some((owner) => teacherIdentifiers.has(owner));
  }

  function safeReadArray(key) {
    try {
      const value = JSON.parse(localStorage.getItem(key) || "[]");
      return Array.isArray(value) ? value : [];
    } catch {
      return [];
    }
  }

  function readCurrentArray(key) {
    if (!currentUid) return safeReadArray(key).filter(belongsToCurrentTeacher);
    const scopedKey = `${key}:${currentUid}`;
    try {
      if (localStorage.getItem(scopedKey) !== null) return safeReadArray(scopedKey);
    } catch (error) {
      debug("Could not check scoped notification state:", error);
    }
    return safeReadArray(key).filter(belongsToCurrentTeacher);
  }

  function notificationTime(item) {
    for (const value of [
      item.createdAt,
      item.createdAtMillis,
      item.timestamp,
      item.time,
    ]) {
      if (value && typeof value.toDate === "function") return value.toDate().getTime();
      if (value && typeof value.toMillis === "function") return value.toMillis();
      if (value && typeof value.seconds === "number") return value.seconds * 1000;
      if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
      if (typeof value === "string" && value.trim()) {
        const parsed = Date.parse(value);
        if (Number.isFinite(parsed)) return parsed;
      }
    }
    return 0;
  }

  function normalizeRenderedItem(item) {
    return {
      ...item,
      id: String(item.id || ""),
      title: String(item.title || item.eventTitle || item.eventName || "Notification"),
      message: String(item.message || item.body || ""),
      type: String(item.type || "default"),
      createdAtMillis: notificationTime(item),
      read: item.read === true,
    };
  }

  function loadStoredState() {
    if (!identityResolved) return;
    notifications = readCurrentArray(notificationStorageKey)
      .map(normalizeRenderedItem);
    deletedNotifications = readCurrentArray(deletedStorageKey)
      .map((item) => {
        const deletedAt = Number(item.deletedAt) ||
          (Number(item.expiresAt) ? Number(item.expiresAt) - 7 * 86400000 : Date.now());
        const expired = Date.now() - deletedAt > deletedLifetime;
        return {
          ...normalizeRenderedItem(item),
          deletedAt,
          expiresAt: item.purged || expired ? 0 : deletedAt + deletedLifetime,
          purged: item.purged === true || expired,
        };
      })
      .filter((item) => item.purged || Date.now() - item.deletedAt <= deletedLifetime);
  }

  function activeTrashItems() {
    return deletedNotifications.filter((item) => !item.purged && item.expiresAt > Date.now());
  }

  function updateUnreadBadge() {
    const badge = document.getElementById("navNotifBadge");
    if (!badge) return;
    try {
      const unreadCount = notifications.filter((item) => !item.read).length;
      badge.textContent = unreadCount > 9 ? "9+" : String(unreadCount);
      badge.hidden = unreadCount === 0;
      badge.setAttribute(
        "aria-label",
        unreadCount
          ? `${unreadCount} unread notifications`
          : "No unread notifications",
      );
    } catch (error) {
      badge.textContent = "";
      badge.hidden = true;
      debug("Could not update the notification badge:", error);
    }
  }

  function updateSourceState(state) {
    const uid = String(state.uid || "");
    const identityChanged =
      uid !== currentUid || Boolean(state.isAuthenticated) !== authenticated;
    if (identityChanged) {
      currentUid = uid;
      authenticated = Boolean(state.isAuthenticated);
      identityResolved = true;
      loadStoredState();
    }
    identityResolved = true;
    retrySources = state.retry;
    notificationsLoading = state.loading;
    allSourcesFailed = state.allFailed;
    sourceError = state.error || "";
    if (state.sourcesSettled || state.allFailed) signalPageReady();
    if (!state.items.length && (!state.sourcesSettled || state.allFailed)) {
      updateUnreadBadge();
      if (hasNotificationPage) renderNotifications();
      return;
    }
    const deletedById = new Map(deletedNotifications.map((item) => [item.id, item]));
    const previousById = new Map(notifications.map((item) => [item.id, item]));
    state.items.forEach((item) => {
      const old = previousById.get(String(item.id));
      const deleted = deletedById.get(String(item.id));
      if (deleted) {
        const wasPurged = deleted.purged;
        Object.assign(deleted, item, {
          read: old ? old.read : deleted.read,
          purged: wasPurged,
        });
        deletedById.set(String(item.id), deleted);
      }
    });
    deletedNotifications = [...deletedById.values()];
    notifications = state.items
      .filter((item) => !deletedById.has(String(item.id)))
      .map((item) => normalizeRenderedItem({
        ...item,
        userId: currentUid,
        recipientUid: currentUid,
        read: previousById.has(String(item.id))
          ? previousById.get(String(item.id)).read
          : item.read,
      }))
      .sort((a, b) => b.createdAtMillis - a.createdAtMillis);
    updateUnreadBadge();
    debug("Source update", {
      uid: currentUid,
      loading: notificationsLoading,
      counts: state.counts,
      mergedCount: notifications.length,
      unreadCount: notifications.filter((item) => !item.read).length,
      firstItem: notifications[0] || null,
    });
    if (hasNotificationPage) renderNotifications();
  }

  function startDataSource() {
    import("./TeacherNotificationData.js")
      .then((module) => {
        dataModule = module;
        module.startTeacherNotificationData(updateSourceState);
      })
      .catch((error) => {
        debug("Could not initialize notification sources:", error);
        notifications = [];
        notificationsLoading = false;
        allSourcesFailed = true;
        sourceError = "Notifications could not be loaded.";
        updateUnreadBadge();
        if (hasNotificationPage) renderNotifications();
        signalPageReady();
      });
  }

  window.addEventListener("storage", (event) => {
    if (
      !event.key ||
      [
        notificationStorageKey,
        deletedStorageKey,
        `${notificationStorageKey}:${currentUid}`,
        `${deletedStorageKey}:${currentUid}`,
      ].includes(event.key)
    ) {
      loadStoredState();
      updateUnreadBadge();
      if (hasNotificationPage) renderNotifications();
    }
  });
  window.addEventListener("focus", () => {
    loadStoredState();
    updateUnreadBadge();
    if (hasNotificationPage) renderNotifications();
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      loadStoredState();
      updateUnreadBadge();
      if (hasNotificationPage) renderNotifications();
    }
  });
  startDataSource();

  if (!hasNotificationPage) return;

  function escapeHTML(value) {
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

  const searchInput = document.getElementById("notificationSearch");
  const notificationList = document.getElementById("notificationList");
  const deletedList = document.getElementById("deletedNotificationList");
  const notificationPanels = document.getElementById("notificationPanels");
  const detailsOverlay = document.getElementById("notificationModalOverlay");
  const deleteOverlay = document.getElementById("deleteConfirmOverlay");

  function save() {
    if (!identityResolved) return;
    const storedNotifications = safeReadArray(notificationStorageKey);
    const otherNotifications = storedNotifications.filter(
      (item) => !belongsToCurrentTeacher(item),
    );
    const storedDeleted = safeReadArray(deletedStorageKey);
    const otherDeleted = storedDeleted.filter(
      (item) => !belongsToCurrentTeacher(item),
    );
    const currentNotifications = notifications.map((item) => ({
      ...item,
      userId: currentUid || item.userId,
    }));
    const currentDeleted = deletedNotifications.map((item) => ({
      ...item,
      userId: currentUid || item.userId,
    }));
    try {
      localStorage.setItem(notificationStorageKey, JSON.stringify([
        ...otherNotifications,
        ...currentNotifications,
      ]));
      localStorage.setItem(deletedStorageKey, JSON.stringify([
        ...otherDeleted,
        ...currentDeleted,
      ]));
      if (currentUid) {
        localStorage.setItem(`${notificationStorageKey}:${currentUid}`, JSON.stringify(currentNotifications));
        localStorage.setItem(`${deletedStorageKey}:${currentUid}`, JSON.stringify(currentDeleted));
      }
    } catch (error) {
      debug("Could not save notification state:", error);
    }
  }

  function notificationTimestamp(item) {
    const timestamp = notificationTime(item);
    return timestamp ? new Date(timestamp) : null;
  }

  function notificationGroup(item) {
    const date = notificationTimestamp(item);
    if (!date) return "Earlier";
    const today = new Date();
    if (date.toDateString() === today.toDateString()) return "Today";
    const weekStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    weekStart.setDate(weekStart.getDate() - weekStart.getDay());
    return date >= weekStart ? "This week" : "Earlier";
  }

  function notificationDateLabel(item) {
    const date = notificationTimestamp(item);
    return date
      ? new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(date)
      : "";
  }

  function notificationRelativeLabel(item) {
    const date = notificationTimestamp(item);
    if (!date) return "";
    const now = new Date();
    const difference = Math.max(0, now.getTime() - date.getTime());
    if (difference < 60000) return "Just now";
    if (date.toDateString() === now.toDateString()) {
      const minutes = Math.floor(difference / 60000);
      return minutes < 60 ? `${minutes} minute${minutes === 1 ? "" : "s"} ago` : `${Math.floor(minutes / 60)} hours ago`;
    }
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
    const days = Math.floor(difference / 86400000);
    return days < 7 ? `${days} days ago` : `${Math.floor(days / 7)} weeks ago`;
  }

  function notificationIcon(item) {
    const type = String(item.type || "").toLowerCase();
    if (type.includes("register") || type.includes("confirm")) {
      return '<svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><path d="m4 10 4 4 8-8"/></svg>';
    }
    if (type.includes("event") || type.includes("publish")) {
      return '<svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><rect x="3" y="4" width="14" height="13" rx="1.5"/><path d="M3 8h14M7 2.5v3M13 2.5v3"/></svg>';
    }
    return '<svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><path d="M16 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M8 20a2 2 0 0 0 4 0"/></svg>';
  }

  function renderNotificationCard(item, inTrash = false) {
    const timestamp = notificationDateLabel(item);
    const relative = notificationRelativeLabel(item);
    const tag = item.tag || (String(item.type || "").toLowerCase().includes("register") ? "Registered" : String(item.type || "").toLowerCase().includes("event") ? "New event" : "");
    const id = escapeHTML(item.id);
    const controls = inTrash
      ? `<button type="button" data-deleted-action="restore">Restore</button><button type="button" data-deleted-action="delete-permanently">Delete forever</button><small>Removed in ${Math.max(0, Math.ceil((item.expiresAt - Date.now()) / 86400000))} days</small>`
      : `<button class="notification-read-toggle" type="button" data-notification-action="${item.read ? "unread" : "read"}" aria-label="Mark as ${item.read ? "unread" : "read"}" title="Mark as ${item.read ? "unread" : "read"}"><span aria-hidden="true"></span></button><button class="notification-trash-toggle" type="button" data-notification-action="delete" aria-label="Move to Recently Deleted" title="Move to Recently Deleted"><svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true"><path d="M4 6h12M8 6V4.5h4V6m-6.5 0 .7 10h7.6l.7-10M8.5 9v4m3-4v4"/></svg></button>`;
    return `<li><article class="notification-card ${item.read ? "is-read" : "is-unread"}" ${inTrash ? `data-deleted-notification-id="${id}"` : `data-notification-id="${id}"`} tabindex="0" aria-label="${escapeHTML(item.title)}, ${item.read ? "read" : "unread"}">
      <span class="notification-icon" aria-hidden="true">${notificationIcon(item)}</span>
      <span class="notification-copy"><strong class="notification-title">${escapeHTML(item.title)}</strong><span class="notification-message">${escapeHTML(item.message)}</span><span class="notification-meta">${tag ? `<span class="notification-tag">${escapeHTML(tag)}</span>` : ""}${timestamp ? `<time>${escapeHTML(timestamp)}</time>` : ""}${relative ? `<span>${escapeHTML(relative)}</span>` : ""}</span>
      ${inTrash ? `<span class="notification-trash-actions">${controls}</span>` : ""}</span>${inTrash ? "" : `<span class="notification-card-actions">${controls}</span>`}
    </article></li>`;
  }

  function renderDeleted() {
    deletedNotifications = deletedNotifications.filter(
      (item) => (item.purged || item.expiresAt > Date.now()) && belongsToCurrentTeacher(item),
    );
    const trashItems = activeTrashItems();
    deletedList.innerHTML = trashItems.length
      ? `<ul class="notification-list">${trashItems.map((item) => renderNotificationCard(item, true)).join("")}</ul>`
      : '<div class="notification-state"><span class="notification-state-icon" aria-hidden="true"><svg width="20" height="20" viewBox="0 0 20 20"><path d="M16 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M8 20a2 2 0 0 0 4 0"/></svg></span><strong>Recently Deleted is empty</strong><p>Notifications you delete will wait here for 30 days before they are removed.</p></div>';
  }

  function renderNotifications() {
    notifications.sort(
      (a, b) => notificationTime(b) - notificationTime(a),
    );
    const query = searchInput.value.trim().toLowerCase();
    const visible = notifications.filter((item) => belongsToCurrentTeacher(item) && (() => {
      const stateMatches =
        activeFilter === "all" ||
        (activeFilter === "read" ? item.read : !item.read);
      return (
        stateMatches &&
        (!query ||
          `${item.title} ${item.message}`.toLowerCase().includes(query))
      );
    })());
    const groups = ["Today", "This week", "Earlier"].map((group) => [
      group,
      visible.filter((item) => notificationGroup(item) === group),
    ]);
    notificationList.innerHTML = visible.length
      ? groups.filter(([, items]) => items.length).map(([group, items]) =>
          `<section class="notification-group"><h2>${group.toUpperCase()}</h2><ul class="notification-list">${items.map((item) => renderNotificationCard(item)).join("")}</ul></section>`,
        ).join("")
      : `<div class="notification-state"><span class="notification-state-icon" aria-hidden="true"><svg width="20" height="20" viewBox="0 0 20 20"><path d="M16 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M8 20a2 2 0 0 0 4 0"/></svg></span><strong>${allSourcesFailed ? "Notifications unavailable" : notificationsLoading ? "Loading notifications..." : activeFilter === "unread" ? "No unread notifications" : "No notifications yet"}</strong><p>${allSourcesFailed ? escapeHTML(sourceError || "Notification sources could not be reached.") : activeFilter === "unread" ? "Everything has been read. Nice work." : "New notifications will show up here."}</p>${allSourcesFailed ? '<button type="button" data-notification-retry>Retry</button>' : ""}</div>`;

    renderDeleted();
    save();
    updateUnreadBadge();
    const unreadCount = notifications.filter((item) => !item.read).length;
    const unreadBadge = document.getElementById("notificationUnreadCount");
    if (unreadBadge) unreadBadge.textContent = String(unreadCount);
    document.querySelectorAll("[data-notification-filter]").forEach((button) => {
      const selected = button.dataset.notificationFilter === activeFilter ||
        (button.dataset.notificationFilter === "all" && activeFilter === "read");
      button.classList.toggle("is-active", selected);
      button.setAttribute("aria-pressed", String(selected));
    });
    document.getElementById("recentDeletedInfo").hidden = !showingDeleted();
    const primaryAction = document.getElementById("markAllRead");
    primaryAction.disabled = showingDeleted()
      ? activeTrashItems().length === 0
      : unreadCount === 0;
    primaryAction.textContent = showingDeleted() ? "Empty trash" : "Mark all as read";
  }

  function updatePanelControls(showingDeleted) {
    const button = document.getElementById("showDeletedNotifications");
    document.getElementById("showDeletedNotificationsLabel").textContent =
      showingDeleted ? "All Notifications" : "Recently Deleted";
    document.getElementById("markAllRead").textContent = showingDeleted
      ? "Empty trash"
      : "Mark all as read";
    button.setAttribute("aria-pressed", String(showingDeleted));
    button.setAttribute("aria-label", showingDeleted ? "Return to notifications" : "Open Recently Deleted");
    document.getElementById("showDeletedNotificationsIcon").innerHTML =
      showingDeleted
        ? '<path d="M3.5 5.5h13M5 5.5v10h10v-10M7.5 3.5h5l1 2h-7l1-2M8 8v5m4-5v5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>'
        : '<path d="M4 6h12M8 6V4.5h4V6m-6.5 0 .7 10h7.6l.7-10M8.5 9v4m3-4v4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>';
  }

  function showingDeleted() {
    return (
      notificationPanels.querySelector(":scope > .notifications-panel").id ===
      "deletedNotificationsPanel"
    );
  }

  function showNotification(item) {
    const eventItem = (window.RECOVIBE_EVENTS || []).find(
      (event) => String(event.id) === String(item.eventId),
    );
    const modal = detailsOverlay.querySelector(".notification-modal");
    document.getElementById("notificationModalTitle").textContent = item.title;
    document.getElementById("notificationModalFrom").textContent = item.from
      ? `From ${item.from}`
      : "";
    document.getElementById("notificationModalTime").textContent = item.time;
    document.getElementById("notificationModalMessage").textContent =
      item.message;
    const reason = document.getElementById("notificationModalReason");
    reason.textContent = item.reason ? `Reason: ${item.reason}` : "";
    reason.hidden = !item.reason;
    const eventPanel = document.getElementById("notificationModalEvent");
    const viewButton = document.getElementById("notificationViewEvent");
    if (eventItem) {
      document.getElementById("notificationEventLocation").textContent =
        eventItem.location || "Location TBA";
      document.getElementById("notificationEventTime").textContent =
        eventItem.time || "Time TBA";
      document.getElementById("notificationEventRoom").textContent =
        eventItem.room || "Room TBA";
      const capacity = Number(
        eventItem.capacity ?? eventItem.maxCapacity ?? eventItem.maxSlots,
      );
      if (!Number.isFinite(capacity) || capacity < 0) {
        document.getElementById("notificationEventSlots").textContent =
          "Availability not specified";
      } else {
        const totalSlots = Math.floor(capacity);
        const registeredCount = Math.max(
          0,
          Math.floor(Number(eventItem.registeredCount) || 0),
        );
        const openSlots = Math.max(
          0,
          Math.min(totalSlots, totalSlots - registeredCount),
        );
        document.getElementById("notificationEventSlots").textContent =
          `${openSlots} of ${totalSlots} slots open`;
      }
      eventPanel.hidden = false;
      viewButton.hidden = false;
      viewButton.dataset.eventId = eventItem.id;
    } else {
      eventPanel.hidden = true;
      viewButton.hidden = true;
      delete viewButton.dataset.eventId;
    }
    detailsOverlay.hidden = false;
    modal.querySelector(".notification-modal-close").focus();
  }

  function closeDetails() {
    detailsOverlay.hidden = true;
  }

  function closeDeleteConfirmation() {
    pendingDeleteId = null;
    deleteOverlay.hidden = true;
  }

  function deletePendingNotification() {
    const item = notifications.find(
      (notification) => notification.id === pendingDeleteId,
    );
    if (!item) return closeDeleteConfirmation();
    notifications = notifications.filter(
      (notification) => notification.id !== item.id,
    );
    deletedNotifications.unshift({
      ...item,
      deletedAt: Date.now(),
      expiresAt: Date.now() + deletedLifetime,
    });
    undoDeletedItem = deletedNotifications[0];
    closeDeleteConfirmation();
    renderNotifications();
    const toast = document.getElementById("teacherNotificationToast");
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

  function setRead(item, read) {
    item.read = read;
    save();
    if (!read || item.source !== "firestore" || !dataModule) return;
    dataModule.markTeacherNotificationRead(item.id).catch((error) => {
      debug("Could not sync notification read state:", error);
      const toast = document.getElementById("teacherNotificationToast");
      if (toast) {
        toast.textContent = "The read state was saved on this device but could not be synced.";
        toast.hidden = false;
      }
    });
  }

  const notificationFilter = document.getElementById("notificationFilter");
  const filterDropdown = document.createElement("div");
  const filterButton = document.createElement("button");
  const filterMenu = document.createElement("div");
  filterDropdown.className = "filter-dropdown";
  filterButton.className = "filter-button";
  filterButton.type = "button";
  filterButton.id = "notificationFilterDropdownButton";
  filterButton.setAttribute("aria-haspopup", "listbox");
  filterButton.setAttribute("aria-expanded", "false");
  filterButton.setAttribute(
    "aria-label",
    notificationFilter.getAttribute("aria-label") || "Filter notifications",
  );
  filterButton.setAttribute("aria-controls", "notificationFilterDropdown");
  filterMenu.className = "filter-menu";
  filterMenu.id = "notificationFilterDropdown";
  filterMenu.setAttribute("role", "listbox");
  filterMenu.setAttribute("aria-labelledby", filterButton.id);
  [...notificationFilter.options].forEach((option) => {
    const item = document.createElement("button");
    item.className = `filter-option${option.selected ? " active" : ""}`;
    item.type = "button";
    item.setAttribute("role", "option");
    item.setAttribute("aria-selected", String(option.selected));
    item.dataset.value = option.value;
    item.textContent = option.textContent.trim();
    filterMenu.appendChild(item);
  });

  function syncNotificationFilter() {
    const selected =
      notificationFilter.options[notificationFilter.selectedIndex];
    filterButton.childNodes[0]?.remove();
    filterButton.insertBefore(
      document.createTextNode(selected ? selected.textContent.trim() : ""),
      filterButton.firstChild,
    );
    filterMenu.querySelectorAll(".filter-option").forEach((item) => {
      const active = item.dataset.value === notificationFilter.value;
      item.classList.toggle("active", active);
      item.setAttribute("aria-selected", String(active));
    });
  }

  syncNotificationFilter();
  notificationFilter.classList.add("teacher-native-filter-select");
  notificationFilter.setAttribute("aria-hidden", "true");
  notificationFilter.tabIndex = -1;
  notificationFilter.hidden = true;
  notificationFilter.parentElement.classList.add("teacher-has-custom-filter");
  notificationFilter.parentNode.insertBefore(
    filterDropdown,
    notificationFilter,
  );
  filterDropdown.append(filterButton, filterMenu, notificationFilter);
  filterButton.addEventListener("click", (event) => {
    event.stopPropagation();
    const isOpen = filterMenu.classList.contains("show");
    filterMenu.classList.toggle("show", !isOpen);
    filterButton.setAttribute("aria-expanded", String(!isOpen));
  });
  filterMenu.addEventListener("click", (event) => {
    const item = event.target.closest(".filter-option");
    if (!item) return;
    event.stopPropagation();
    notificationFilter.value = item.dataset.value;
    notificationFilter.dispatchEvent(new Event("change", { bubbles: true }));
    syncNotificationFilter();
    filterMenu.classList.remove("show");
    filterButton.setAttribute("aria-expanded", "false");
    filterButton.focus();
  });
  notificationFilter.addEventListener("change", syncNotificationFilter);
  document.addEventListener("click", (event) => {
    if (!event.target.closest(".filter-select-wrap .filter-dropdown")) {
      filterMenu.classList.remove("show");
      filterButton.setAttribute("aria-expanded", "false");
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      filterMenu.classList.remove("show");
      filterButton.setAttribute("aria-expanded", "false");
    }
  });

  document
    .getElementById("notificationSearch")
    .addEventListener("input", renderNotifications);
  notificationFilter.addEventListener("change", (event) => {
    activeFilter = event.target.value;
    renderNotifications();
  });
  document.querySelectorAll("[data-notification-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      notificationFilter.value = button.dataset.notificationFilter;
      notificationFilter.dispatchEvent(new Event("change", { bubbles: true }));
    });
  });
  document.getElementById("markAllRead").addEventListener("click", () => {
    if (showingDeleted()) {
      const count = activeTrashItems().length;
      if (!count || !window.confirm(`Permanently delete all ${count} notifications? This cannot be undone.`)) return;
      const removedAt = Date.now();
      deletedNotifications = [
        ...deletedNotifications.filter((item) => item.purged),
        ...activeTrashItems().map((item) => ({
          ...item,
          deletedAt: removedAt,
          expiresAt: 0,
          purged: true,
        })),
      ];
      save();
    } else {
      notifications.forEach((item) => setRead(item, true));
      save();
      const toast = document.getElementById("teacherNotificationToast");
      if (toast) {
        toast.textContent = "All notifications marked as read.";
        toast.hidden = false;
        clearTimeout(undoTimer);
        undoTimer = setTimeout(() => {
          toast.hidden = true;
        }, 3000);
      }
    }
    renderNotifications();
  });
  document
    .getElementById("showDeletedNotifications")
    .addEventListener("click", () => {
      const allPanel = document.getElementById("allNotificationsPanel");
      const deletedPanel = document.getElementById("deletedNotificationsPanel");
      const isShowingDeleted = showingDeleted();
      notificationPanels.insertBefore(
        isShowingDeleted ? allPanel : deletedPanel,
        isShowingDeleted ? deletedPanel : allPanel,
      );
      updatePanelControls(!isShowingDeleted);
      renderNotifications();
    });
  notificationList.addEventListener("click", (event) => {
    if (event.target.closest("[data-notification-retry]")) {
      retrySources?.();
      return;
    }
    const card = event.target.closest("[data-notification-id]");
    if (!card) return;
    const item = notifications.find(
      (notification) => notification.id === card.dataset.notificationId,
    );
    const action = event.target.closest("[data-notification-action]");
    if (!item) return;
    if (action) {
      event.stopPropagation();
      if (action.dataset.notificationAction === "delete") {
        pendingDeleteId = item.id;
        deleteOverlay.hidden = false;
        document.getElementById("confirmDeleteNotification").focus();
      } else {
        setRead(item, action.dataset.notificationAction === "read");
        renderNotifications();
      }
      return;
    }
    setRead(item, true);
    renderNotifications();
    if (item.eventId) {
      window.location.href = `TeacherMyEvent.html?event=${encodeURIComponent(item.eventId)}`;
    }
  });
  notificationList.addEventListener("keydown", (event) => {
    if (
      !["Enter", " "].includes(event.key) ||
      event.target.closest("button, a, input, select")
    )
      return;
    const card = event.target.closest("[data-notification-id]");
    if (!card) return;
    event.preventDefault();
    const item = notifications.find(
      (notification) => notification.id === card.dataset.notificationId,
    );
    if (item) {
      setRead(item, true);
      renderNotifications();
      if (item.eventId) {
        window.location.href = `TeacherMyEvent.html?event=${encodeURIComponent(item.eventId)}`;
      }
    }
  });
  deletedList.addEventListener("click", (event) => {
    const action = event.target.closest("[data-deleted-action]");
    const card = event.target.closest("[data-deleted-notification-id]");
    if (!action || !card) return;
    const item = deletedNotifications.find(
      (notification) => notification.id === card.dataset.deletedNotificationId,
    );
    if (!item) return;
    if (action.dataset.deletedAction === "restore") {
      const { deletedAt, expiresAt, ...restoredItem } = item;
      notifications.unshift(restoredItem);
    } else if (action.dataset.deletedAction === "delete-permanently") {
      if (!window.confirm("Permanently delete this notification? This cannot be undone.")) return;
      deletedNotifications = deletedNotifications.map((notification) =>
        notification.id === item.id
          ? { ...notification, deletedAt: Date.now(), expiresAt: 0, purged: true }
          : notification,
      );
      renderNotifications();
      return;
    }
    deletedNotifications = deletedNotifications.filter(
      (notification) => notification.id !== item.id,
    );
    renderNotifications();
  });
  document.getElementById("notificationMain").addEventListener("click", (event) => {
    if (!event.target.closest("[data-undo-delete]") || !undoDeletedItem) return;
    const { deletedAt, expiresAt, ...restoredItem } = undoDeletedItem;
    deletedNotifications = deletedNotifications.filter((item) => item.id !== undoDeletedItem.id);
    notifications.unshift(restoredItem);
    undoDeletedItem = null;
    clearTimeout(undoTimer);
    renderNotifications();
  });
  document
    .getElementById("notificationModalClose")
    .addEventListener("click", closeDetails);
  detailsOverlay.addEventListener("click", (event) => {
    if (event.target === detailsOverlay) closeDetails();
  });
  document
    .getElementById("notificationViewEvent")
    .addEventListener("click", (event) => {
      const eventId = event.currentTarget.dataset.eventId;
      if (eventId) {
        window.location.href = `TeacherMyEvent.html?event=${encodeURIComponent(eventId)}`;
      }
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
  deleteOverlay.addEventListener("click", (event) => {
    if (event.target === deleteOverlay) closeDeleteConfirmation();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeDetails();
      closeDeleteConfirmation();
      document.querySelectorAll(".notification-menu").forEach((menu) => {
        menu.hidden = true;
      });
      document
        .querySelectorAll(".notification-menu-toggle")
        .forEach((toggle) => toggle.setAttribute("aria-expanded", "false"));
    }
  });

  let teacher = teacherProfile;
  try {
    teacher = JSON.parse(
      localStorage.getItem("recovibeCurrentTeacher") || "null",
    );
  } catch (error) {
    debug("Unable to read teacher account:", error);
  }
  if (teacher) {
    const name = teacher.name || teacher.fullName || "Teacher";
    document.getElementById("userName").textContent = name;
    document.getElementById("userRole").textContent = "Teacher";
    document.getElementById("userAvatar").textContent = name
      .split(/\s+/)
      .filter(Boolean)
      .map((part) => part[0])
      .slice(0, 2)
      .join("")
      .toUpperCase();
  }
  document.querySelector(".nav-item.logout").addEventListener("click", () => {
    localStorage.removeItem("recovibeCurrentTeacher");
    localStorage.removeItem("recovibeTeacherId");
  });

  renderNotifications();
  updatePanelControls(false);
})();
