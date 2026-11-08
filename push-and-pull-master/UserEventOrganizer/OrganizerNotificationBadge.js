(() => {
  const eventsKey = "recovibeOrganizerEvents";
  const notificationsKey = "recovibeOrganizerNotifications";
  const statusSnapshotKey = "recovibeOrganizerEventStatusSnapshot";

  function readJson(key, fallback) {
    try {
      const value = JSON.parse(localStorage.getItem(key) || "null");
      return value === null ? fallback : value;
    } catch {
      return fallback;
    }
  }

  function currentOrganizerEvents() {
    const organizerId = localStorage.getItem("recovibeOrganizerId");
    const events = readJson(eventsKey, []);
    if (!Array.isArray(events)) return [];
    return events.filter(
      (event) =>
        !organizerId || String(event.organizerId) === String(organizerId),
    );
  }

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
    const sources = [currentOrganizerEvents()];
    ["recovibeEventsCache", "recovibeTeacherEvents"].forEach((key) => {
      const cached = readJson(key, []);
      if (Array.isArray(cached)) sources.push(cached);
    });
    return sources.flat().find(
      (event) => String(event.id || event.eventId || "") === String(eventId),
    ) || null;
  }

  function normalizeOrganization(value) {
    const normalized = String(value || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (normalized === "PIEE" || normalized === "PIIE" || normalized.includes("INDUSTRIALENG")) return "PIIE";
    if (normalized === "IBITS" || normalized.includes("INFORMATIONTECH")) return "IBITS";
    if (normalized === "ACES" || normalized.includes("COMPUTERENG")) return "ACES";
    if (normalized === "SMS" || normalized.includes("MANAGEMENT")) return "SMS";
    if (normalized === "HRSS" || normalized.includes("HUMANRESOURCE")) return "HRSS";
    if (normalized === "YES" || normalized.includes("YOUNGEDUC")) return "YES";
    return normalized;
  }

  function normalizeDepartment(value) {
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

  function isNotificationVisibleToOrganizer(notification) {
    const event = notificationEvent(notification.eventId) || {};
    const audience = String(
      notification.targetAudience || notification.audience || event.targetAudience || event.audience || "",
    ).toLowerCase().replace(/[^a-z0-9]/g, "");
    if (notification.openForAll === true || event.openForAll === true ||
        audience.startsWith("opentoall") || audience.startsWith("openforall")) return true;

    let profile = {};
    try {
      profile = readJson("recovibeOrganizerProfile", {}) || {};
    } catch {}
    const scoped = { ...event, ...notification };
    const targetOrganizations = [
      ...notificationValues(scoped.organizationCodes),
      ...notificationValues(scoped.targetOrganizations),
      ...notificationValues(scoped.targetOrganization),
      ...notificationValues(scoped.audienceOrganizations),
      ...notificationValues(scoped.coOrganizerOrganizations),
      ...notificationValues(scoped.coOrganizerOrgIds),
      ...notificationValues(scoped.coOrganizerOrganization),
      ...notificationValues(scoped.collaboratorOrganizations),
      ...notificationValues(scoped.collaboratorOrgIds),
      ...notificationValues(scoped.collaboratorOrganization),
      ...notificationValues(scoped.collaborationOrganizations),
      ...notificationValues(scoped.collaborationOrgIds),
      ...notificationValues(scoped.collaboratingOrganizations),
      ...notificationValues(scoped.coOrganizers),
      ...notificationValues(scoped.coOrganizer),
      ...notificationValues(scoped.collaborators),
      ...notificationValues(scoped.collaborator),
      ...notificationValues(scoped.partnerOrganizations),
      ...notificationValues(scoped.organizationCode),
      ...notificationValues(scoped.organizationId),
      ...notificationValues(scoped.organizerOrganization),
      ...notificationValues(scoped.orgCode),
      ...notificationValues(scoped.orgId),
      ...notificationValues(scoped.organization),
      ...notificationValues(scoped.organizationName),
      ...notificationValues(scoped.orgName),
    ].map(normalizeOrganization).filter(Boolean);
    const organizerOrganizations = [
      ...notificationValues(profile.organization),
      ...notificationValues(profile.organizationCode),
      ...notificationValues(profile.organizationId),
      ...notificationValues(profile.orgCode),
      ...notificationValues(profile.orgId),
      ...notificationValues(profile.organizations),
      ...notificationValues(profile.courseOrganizations),
    ].map(normalizeOrganization).filter(Boolean);
    const targetDepartments = [
      ...notificationValues(scoped.departmentCodes),
      ...notificationValues(scoped.targetDepartments),
      ...notificationValues(scoped.targetDepartment),
      ...notificationValues(scoped.targetDepartmentIds),
      ...notificationValues(scoped.departments),
      ...notificationValues(scoped.departmentIds),
      ...notificationValues(scoped.departmentCode),
      ...notificationValues(scoped.departmentId),
      ...notificationValues(scoped.department),
    ].map(normalizeDepartment).filter(Boolean);
    const organizerDepartments = [
      ...notificationValues(profile.departmentCode),
      ...notificationValues(profile.departmentId),
      ...notificationValues(profile.department),
      ...notificationValues(profile.departments),
      ...notificationValues(profile.departmentIds),
    ].map(normalizeDepartment).filter(Boolean);

    return targetOrganizations.some((organization) =>
      organizerOrganizations.includes(organization),
    ) || targetDepartments.some((department) =>
      organizerDepartments.includes(department),
    );
  }

  function notifyStatusChanges() {
    const events = readJson(eventsKey, []);
    if (!Array.isArray(events)) return;

    const previous = readJson(statusSnapshotKey, null);
    const next = {};
    const organizerId = localStorage.getItem("recovibeOrganizerId");

    events.forEach((event) => {
      if (!event || !event.eventId) return;
      const status = String(event.status || "Draft");
      const old = previous && previous[event.eventId];
      next[event.eventId] = {
        status,
        updatedAt: event.updatedAt || event.createdAt || "",
      };

      if (
        (old && old.status === status) ||
        !organizerId ||
        String(event.organizerId) !== String(organizerId)
      )
        return;
      if (!["Approved", "Rejected"].includes(status)) return;

      const notificationId = `event-status-${organizerId}-${event.eventId}-${status.toLowerCase()}-${event.updatedAt || Date.now()}`;
      const notifications = readJson(notificationsKey, []);
      if (
        !Array.isArray(notifications) ||
        notifications.some((item) => item.id === notificationId)
      )
        return;

      const decision = status === "Approved" ? "approved" : "rejected";
      notifications.unshift({
        id: notificationId,
        title: status === "Approved" ? "Event Approved" : "Event Rejected",
        message: `Your event "${event.title || "Untitled event"}" was ${decision}.`,
        time: new Date().toLocaleString("en-US", {
          dateStyle: "medium",
          timeStyle: "short",
        }),
        type: status === "Approved" ? "green" : "red",
        organizerId,
        eventId: event.eventId,
        eventTitle: event.title || "Untitled event",
        eventStatus: status,
        reason: event.statusReason || event.rejectionReason || "",
        read: false,
        createdAt: new Date().toISOString(),
      });
      localStorage.setItem(notificationsKey, JSON.stringify(notifications));
      window.dispatchEvent(new Event("recovibeOrganizerNotificationsChanged"));
    });

    localStorage.setItem(statusSnapshotKey, JSON.stringify(next));
  }

  function renderBadge() {
    const stored = readJson(notificationsKey, []);
    const organizerId = localStorage.getItem("recovibeOrganizerId");
    const notifications = Array.isArray(stored)
      ? stored.filter(
          (item) =>
            item.eventId &&
            ["Approved", "Rejected"].includes(item.eventStatus) &&
            isNotificationVisibleToOrganizer(item),
        )
      : [];
    if (!Array.isArray(stored) || notifications.length !== stored.length) {
      localStorage.setItem(notificationsKey, JSON.stringify(notifications));
    }
    const unread = notifications.filter(
      (item) =>
        !item.read &&
        (!item.organizerId ||
          !organizerId ||
          String(item.organizerId) === String(organizerId)),
    ).length;

    document.querySelectorAll("#navNotifBadge").forEach((badge) => {
      badge.textContent = unread ? String(unread) : "";
      badge.hidden = unread === 0;
    });
  }

  function refresh() {
    notifyStatusChanges();
    renderBadge();
  }

  refresh();
  window.addEventListener("storage", (event) => {
    if ([eventsKey, "recovibeOrganizerId"].includes(event.key)) refresh();
    if (event.key === notificationsKey) {
      renderBadge();
      window.dispatchEvent(new Event("recovibeOrganizerNotificationsChanged"));
    }
  });
  window.addEventListener("recovibeOrganizerEventsChanged", refresh);
  window.addEventListener("recovibeOrganizerNotificationsChanged", renderBadge);

  // Real-time RTDB notifications listener
  (async () => {
    try {
      const config = await import("../UserStudent/firebaseConfig.js");
      const authModule = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js");
      const rtdbModule = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js");

      if (config.auth && config.rtdb) {
        authModule.onAuthStateChanged(config.auth, (user) => {
          if (!user) return;
          const notifRef = rtdbModule.ref(config.rtdb, `notifications/${user.uid}`);
          rtdbModule.onValue(notifRef, (snapshot) => {
            const data = snapshot.val();
            let unreadCount = 0;
            if (data && typeof data === "object") {
              const notifications = [];
              Object.entries(data).forEach(([id, val]) => {
                if (val && typeof val === "object") {
                  const notification = {
                    id,
                    ...val,
                    time: val.createdAt ? new Date(val.createdAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }) : "Recently",
                  };
                  if (!isNotificationVisibleToOrganizer(notification)) return;
                  if (!val.read) unreadCount++;
                  notifications.push(notification);
                }
              });
              localStorage.setItem("recovibeOrganizerNotifications", JSON.stringify(notifications));
              window.dispatchEvent(new Event("recovibeOrganizerNotificationsChanged"));
            }
            document.querySelectorAll("#navNotifBadge").forEach((badge) => {
              badge.textContent = unreadCount ? String(unreadCount) : "";
              badge.hidden = unreadCount === 0;
            });
          });
        });
      }
    } catch (err) {
      // Offline or fallback to localStorage
    }
  })();
})();
