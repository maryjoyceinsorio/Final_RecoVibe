(function () {
  function readJson(key, fallback) {
    try {
      return JSON.parse(localStorage.getItem(key) || "null") ?? fallback;
    } catch {
      return fallback;
    }
  }

  function values(value) {
    return (Array.isArray(value) ? value : [value]).flatMap((entry) => {
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

  function isNotificationVisible(notification, profile, events) {
    const event = events.find(
      (item) => notification.eventId &&
        String(item.id || item.eventId || "") === String(notification.eventId),
    ) || {};
    const audience = String(
      notification.targetAudience || notification.audience || event.targetAudience || event.audience || "",
    ).toLowerCase().replace(/[^a-z0-9]/g, "");
    if (notification.openForAll === true || event.openForAll === true ||
        audience.startsWith("opentoall") || audience.startsWith("openforall")) return true;

    const scoped = { ...event, ...notification };
    const targetOrganizations = [
      ...values(scoped.organizationCodes),
      ...values(scoped.targetOrganizations),
      ...values(scoped.targetOrganization),
      ...values(scoped.audienceOrganizations),
      ...values(scoped.coOrganizerOrganizations),
      ...values(scoped.coOrganizerOrgIds),
      ...values(scoped.coOrganizerOrganization),
      ...values(scoped.collaboratorOrganizations),
      ...values(scoped.collaboratorOrgIds),
      ...values(scoped.collaboratorOrganization),
      ...values(scoped.collaborationOrganizations),
      ...values(scoped.collaborationOrgIds),
      ...values(scoped.collaboratingOrganizations),
      ...values(scoped.coOrganizers),
      ...values(scoped.coOrganizer),
      ...values(scoped.collaborators),
      ...values(scoped.collaborator),
      ...values(scoped.partnerOrganizations),
      ...values(scoped.organizationCode),
      ...values(scoped.organizationId),
      ...values(scoped.organizerOrganization),
      ...values(scoped.orgCode),
      ...values(scoped.orgId),
      ...values(scoped.organization),
      ...values(scoped.organizationName),
      ...values(scoped.orgName),
    ].map(normalizeOrganization).filter(Boolean);
    const studentOrganizations = [
      ...values(profile.organization),
      ...values(profile.courseOrganization),
      ...values(profile.organizationCode),
      ...values(profile.organizationId),
      ...values(profile.orgCode),
      ...values(profile.orgId),
      ...values(profile.organizations),
      ...values(profile.courseOrganizations),
    ].map(normalizeOrganization).filter(Boolean);
    const targetDepartments = [
      ...values(scoped.departmentCodes),
      ...values(scoped.targetDepartments),
      ...values(scoped.targetDepartment),
      ...values(scoped.targetDepartmentIds),
      ...values(scoped.departments),
      ...values(scoped.departmentIds),
      ...values(scoped.departmentCode),
      ...values(scoped.departmentId),
      ...values(scoped.department),
    ].map(normalizeDepartment).filter(Boolean);
    const studentDepartments = [
      ...values(profile.departmentCode),
      ...values(profile.departmentId),
      ...values(profile.department),
      ...values(profile.departments),
      ...values(profile.departmentIds),
      ...values(profile.course),
    ].map(normalizeDepartment).filter(Boolean);

    return targetOrganizations.some((organization) =>
      studentOrganizations.includes(organization),
    ) || targetDepartments.some((department) =>
      studentDepartments.includes(department),
    );
  }

  const profile = readJson("recovibeCurrentUser", {}) || {};
  const events = [
    ...(Array.isArray(window.RECOVIBE_EVENTS) ? window.RECOVIBE_EVENTS : []),
    ...["recovibeEventsCache", "recovibeOrganizerEvents", "recovibeTeacherEvents"]
      .map((key) => readJson(key, []))
      .filter(Array.isArray)
      .flat(),
  ];

  document.querySelectorAll("a.logout").forEach((link) => {
    link.addEventListener("click", async (event) => {
      if (link.dataset.customLogout === "true") return;
      event.preventDefault();
      if (link.getAttribute("aria-busy") === "true") return;

      link.setAttribute("aria-busy", "true");

      try {
        const { auth } = await import("./firebaseConfig.js");
        if (auth) {
          const { signOut } = await import(
            "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js"
          );
          await signOut(auth);
        }

        localStorage.removeItem("recovibeCurrentUser");
        sessionStorage.removeItem("recovibeCurrentUser");
        window.location.assign(new URL("StudentLogin.html", window.location.href));
      } catch (error) {
        console.error("Student logout failed:", error);
        link.removeAttribute("aria-busy");
        window.alert("Could not log out. Please try again.");
      }
    });
  });

  const storedNotifications = localStorage.getItem("recovibeNotifications");
  const notifications =
    storedNotifications === null
      ? Array.from({ length: 5 }, () => ({ read: false }))
      : JSON.parse(storedNotifications);
  const unreadCount = notifications.filter(
    (item) => !item.read && isNotificationVisible(item, profile, events),
  ).length;
  const badge = document.getElementById("navNotifBadge");
  if (!badge) return;
  badge.textContent = unreadCount;
  badge.hidden = unreadCount === 0;
})();
