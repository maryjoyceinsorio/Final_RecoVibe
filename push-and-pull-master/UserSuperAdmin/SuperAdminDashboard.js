import {
  collection,
  limit,
  onSnapshot,
  orderBy,
  query,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { db, isFirebaseConfigured } from "../UserStudent/firebaseConfig.js";

(() => {
  "use strict";

  const tables = [
    {
      table: document.getElementById("recent-audit-table"),
      tbody: document.getElementById("recent-audit-tbody"),
      limit: 8,
    },
    {
      table: document.getElementById("audit-activity-table"),
      tbody: document.getElementById("audit-activity-rows"),
      limit: 0,
    },
  ].filter((entry) => entry.table && entry.tbody);
  const modal =
    document.getElementById("audit-modal-backdrop") ||
    document.getElementById("audit-detail-modal");
  const viewEventLink = document.getElementById("audit-view-event");
  const payloadElement = document.getElementById("audit-detail-payload");
  const recordsById = new Map();
  const fieldIds = {
    action: "audit-detail-action",
    performedBy: "audit-detail-performed-by",
    dateTime: "audit-detail-date-time",
    eventName: "audit-detail-event",
    organizer: "audit-detail-organizer",
    organizerRole: "audit-detail-organizer-role",
    previousStatus: "audit-detail-previous-status",
    newStatus: "audit-detail-new-status",
    details: "audit-detail-description",
  };

  function dateFrom(value) {
    if (value?.toDate) return value.toDate();
    const date = value ? new Date(value) : null;
    return date && !Number.isNaN(date.getTime()) ? date : null;
  }

  function formatRowTimestamp(value) {
    const date = dateFrom(value);
    if (!date) return { date: "Date unavailable", time: "" };
    return {
      date: new Intl.DateTimeFormat("en-US", {
        timeZone: "Asia/Manila",
        month: "2-digit",
        day: "2-digit",
        year: "2-digit",
      }).format(date),
      time: new Intl.DateTimeFormat("en-US", {
        timeZone: "Asia/Manila",
        hour: "numeric",
        minute: "2-digit",
      }).format(date),
    };
  }

  function formatDetailTimestamp(value) {
    const date = dateFrom(value);
    if (!date) return "Date unavailable";
    const dateLabel = new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Manila",
      month: "long",
      day: "numeric",
      year: "numeric",
    }).format(date);
    const timeLabel = new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Manila",
      hour: "numeric",
      minute: "2-digit",
    }).format(date);
    return `${dateLabel} — ${timeLabel}`;
  }

  function normalizeRecord(documentSnapshot) {
    const data = documentSnapshot.data();
    const user = data.user || data.actorName || data.performedBy || "System";
    const action = data.action || data.actionHeader || "Activity recorded";
    const isUserAction = data.category === "User Management";
    return {
      ...data,
      rawData: data,
      id: documentSnapshot.id,
      user,
      action,
      actionHeader: data.actionHeader || action,
      performedBy: data.user || data.performedBy || data.actorName || user,
      timestamp: data.timestamp || data.createdAt || null,
      eventName: isUserAction ? "Not applicable" : data.eventName || "Not applicable",
      organizer: isUserAction
        ? "Not applicable"
        : data.organizer || data.organization || "Not applicable",
      organizerRole: isUserAction
        ? ""
        : data.organizerRole || data.eventOrganizerRole || data.contactRole || "",
      previousStatus: data.previousStatus || "Not applicable",
      newStatus: data.newStatus || "Not applicable",
      details: data.details || action,
      hasEvent: !isUserAction && Boolean(data.eventId || data.eventName),
    };
  }

  function appendCell(row, label, content) {
    const cell = document.createElement("td");
    cell.dataset.label = label;
    cell.append(content);
    row.append(cell);
  }

  function renderTable({ tbody, limit }, records) {
    tbody.replaceChildren();
    const visibleRecords = limit ? records.slice(0, limit) : records;
    if (!visibleRecords.length) {
      const row = document.createElement("tr");
      const cell = document.createElement("td");
      cell.className = "user-table-empty";
      cell.colSpan = 4;
      cell.textContent = "No audit activity yet.";
      row.append(cell);
      tbody.append(row);
      return;
    }

    visibleRecords.forEach((record) => {
      const row = document.createElement("tr");
      row.id = `audit-row-${record.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
      row.dataset.auditId = record.id;
      row.tabIndex = 0;

      const timestamp = document.createElement("time");
      const date = dateFrom(record.timestamp);
      if (date) timestamp.dateTime = date.toISOString();
      const labels = formatRowTimestamp(record.timestamp);
      const dateText = document.createElement("strong");
      dateText.textContent = labels.date;
      const timeText = document.createElement("span");
      timeText.textContent = labels.time;
      timestamp.append(dateText, timeText);
      appendCell(row, "Timestamp", timestamp);

      const user = document.createElement("strong");
      user.textContent = record.user;
      appendCell(row, "User", user);
      const action = document.createElement("span");
      action.textContent = record.action;
      appendCell(row, "Action", action);

      const arrow = document.createElement("button");
      arrow.className = "audit-detail-button";
      arrow.type = "button";
      arrow.setAttribute("aria-label", `View audit record by ${record.user}`);
      const icon = document.createElement("span");
      icon.setAttribute("aria-hidden", "true");
      icon.textContent = "▶";
      arrow.append(icon);
      const actionCell = document.createElement("td");
      actionCell.className = "audit-action-cell";
      actionCell.append(arrow);
      row.append(actionCell);
      tbody.append(row);
    });
  }

  function showRecord(record) {
    const modalTitle = document.getElementById("audit-modal-title");
    if (modalTitle) {
      modalTitle.textContent = record.actionHeader || record.action || "Activity Details";
    }

    const actionEl = document.getElementById("audit-detail-action");
    const performedByEl = document.getElementById("audit-detail-performed-by");
    const dateTimeEl = document.getElementById("audit-detail-date-time");
    const categoryEl = document.getElementById("audit-detail-category");
    const eventEl = document.getElementById("audit-detail-event");
    const organizerEl = document.getElementById("audit-detail-organizer");
    const organizerRoleEl = document.getElementById("audit-detail-organizer-role");
    const prevStatusEl = document.getElementById("audit-detail-previous-status");
    const newStatusEl = document.getElementById("audit-detail-new-status");
    const descSection = document.getElementById("audit-description-section");
    const descText = document.getElementById("audit-detail-description");

    if (actionEl) actionEl.textContent = record.action || "Not specified";
    if (performedByEl) performedByEl.textContent = record.performedBy || record.user || "System";
    if (dateTimeEl) dateTimeEl.textContent = formatDetailTimestamp(record.timestamp);
    if (categoryEl) categoryEl.textContent = record.category || (record.hasEvent ? "Event Management" : "User Management");

    const rowCategory = document.getElementById("row-category");
    const rowEvent = document.getElementById("row-event");
    const rowOrganizer = document.getElementById("row-organizer");
    const rowPrevStatus = document.getElementById("row-previous-status");
    const rowNewStatus = document.getElementById("row-new-status");

    if (record.hasEvent) {
      if (rowEvent) rowEvent.hidden = false;
      if (rowOrganizer) rowOrganizer.hidden = false;
      if (rowPrevStatus) rowPrevStatus.hidden = !record.previousStatus || record.previousStatus === "Not applicable";
      if (rowNewStatus) rowNewStatus.hidden = !record.newStatus || record.newStatus === "Not applicable";

      if (eventEl) eventEl.textContent = record.eventName;
      if (organizerEl) organizerEl.textContent = record.organizer || "Not specified";
      if (organizerRoleEl) organizerRoleEl.textContent = record.organizerRole ? ` (${record.organizerRole})` : "";
      if (prevStatusEl) prevStatusEl.textContent = record.previousStatus || "";
      if (newStatusEl) newStatusEl.textContent = record.newStatus || "";
    } else {
      if (rowEvent) rowEvent.hidden = true;
      if (rowOrganizer) rowOrganizer.hidden = true;
      if (rowPrevStatus) rowPrevStatus.hidden = true;
      if (rowNewStatus) rowNewStatus.hidden = true;
    }

    if (descSection && descText) {
      if (record.details && record.details !== record.action && record.details !== "Not applicable") {
        descText.textContent = record.details;
        descSection.hidden = false;
      } else {
        descSection.hidden = true;
      }
    }

    if (payloadElement) {
      payloadElement.textContent = "";
      payloadElement.hidden = true;
    }

    if (viewEventLink) {
      if (record.hasEvent) {
        viewEventLink.href = `../UserAdmin/AdminAllEvents.html?q=${encodeURIComponent(record.eventName)}`;
        viewEventLink.hidden = false;
        viewEventLink.style.display = "inline-flex";
      } else {
        viewEventLink.href = "#";
        viewEventLink.hidden = true;
        viewEventLink.style.display = "none";
      }
    }
    if (modal?.showModal) modal.showModal();
  }

  function resetModal() {
    const modalTitle = document.getElementById("audit-modal-title");
    if (modalTitle) modalTitle.textContent = "Audit Activity Details";
    Object.values(fieldIds).forEach((id) => {
      const element = document.getElementById(id);
      if (element) element.textContent = "";
    });
    const categoryEl = document.getElementById("audit-detail-category");
    if (categoryEl) categoryEl.textContent = "";
    const descSection = document.getElementById("audit-description-section");
    if (descSection) descSection.hidden = true;
    if (payloadElement) {
      payloadElement.textContent = "";
      payloadElement.hidden = true;
    }
    if (viewEventLink) {
      viewEventLink.href = "#";
      viewEventLink.hidden = true;
      viewEventLink.style.display = "none";
    }
  }

  function setDashboardDate() {
    const dateElement = document.getElementById("dashboard-today-date");
    if (!dateElement) return;
    const now = new Date();
    const dateText = dateElement.querySelector("span");
    if (dateText) {
      dateText.textContent = new Intl.DateTimeFormat("en-US", {
        month: "long",
        day: "numeric",
        year: "numeric",
      }).format(now);
    }
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    dateElement.dateTime = `${year}-${month}-${day}`;
  }

  function greetingForCurrentHour() {
    const hour = new Date().getHours();
    return hour < 12
      ? "Good Morning"
      : hour < 17
        ? "Good Afternoon"
        : "Good Evening";
  }

  function nameInitials(name) {
    const nameParts = String(name || "").trim().split(/\s+/).filter(Boolean);
    if (!nameParts.length) return "SA";
    if (nameParts.length === 1) return nameParts[0].slice(0, 2).toUpperCase();
    return `${nameParts[0][0]}${nameParts[nameParts.length - 1][0]}`.toUpperCase();
  }

  function fullNameFromProfile(profile, user) {
    const firstLastName = [profile.firstName, profile.middleName, profile.lastName]
      .map((part) => String(part || "").trim())
      .filter(Boolean)
      .join(" ");
    return String(
      firstLastName ||
      profile.fullName ||
      profile.name ||
      profile.displayName ||
      user.displayName ||
      user.email ||
      "Super Admin",
    );
  }

  function renderAuthenticatedProfile(profile, user) {
    const fullName = fullNameFromProfile(profile, user);
    const lastName =
      String(profile.lastName || "").trim() ||
      (fullName === "Super Admin" ? fullName : fullName.trim().split(/\s+/).at(-1));
    const role = "Super Admin account";
    const greeting = document.getElementById("dashboard-greeting");
    const sidebarName = document.getElementById("sidebar-user-name");
    const sidebarRole = document.getElementById("sidebar-user-role");
    const sidebarAvatar = document.getElementById("sidebar-user-avatar");

    if (greeting) greeting.textContent = `${greetingForCurrentHour()}, ${lastName}!`;
    if (sidebarName) sidebarName.textContent = fullName;
    if (sidebarRole) sidebarRole.textContent = role;
    if (sidebarAvatar) sidebarAvatar.textContent = fullName.trim().charAt(0).toUpperCase() || "S";
  }

  function renderTableError(table, message) {
    if (!table?.tbody) return;
    console.info(`[SuperAdminDashboard] ${message}; retaining static audit rows.`);
  }

  try {
  setDashboardDate();

  tables.forEach(({ table }) => {
    table.addEventListener("click", (event) => {
      const row = event.target.closest("tr[data-audit-id]");
      if (!row || !table.contains(row)) return;
      const record = recordsById.get(row.dataset.auditId);
      if (record) showRecord(record);
    });
    table.addEventListener("keydown", (event) => {
      if (
        !event.target.matches("tr[data-audit-id]") ||
        !["Enter", " "].includes(event.key)
      ) {
        return;
      }
      event.preventDefault();
      const record = recordsById.get(event.target.dataset.auditId);
      if (record) showRecord(record);
    });
  });

  if (modal) {
    document
      .getElementById("audit-close-modal")
      ?.addEventListener("click", () => modal.close());
    modal.addEventListener("click", (event) => {
      if (event.target === modal) modal.close();
    });
    modal.addEventListener("close", resetModal);
    viewEventLink?.addEventListener("click", (event) => {
      if (viewEventLink.getAttribute("aria-disabled") === "true") event.preventDefault();
    });
  }

  window.addEventListener("superadmin-profile-authorized", (event) => {
    const { profile, user } = event.detail || {};
    renderAuthenticatedProfile(profile || {}, user || {});
  });

  try {
    const storedProfile = JSON.parse(localStorage.getItem("recovibeAdminProfile") || "null");
    renderAuthenticatedProfile(storedProfile || {}, {});
  } catch (error) {
    renderAuthenticatedProfile({}, {});
  }

  if (!isFirebaseConfigured || !db) {
    console.info("[SuperAdminDashboard] Firebase unavailable; retaining static dashboard content.");
    return;
  }

  const unsubscribers = [];
  /* ── Accounts Overview panel ──────────────────────── */

  const aoPanel = document.getElementById("accounts-overview-panel");
  const aoErrorEl = document.getElementById("ao-error");
  const aoRetryBtn = document.getElementById("ao-retry");
  const aoCountsRegion = document.getElementById("accounts-overview-counts");

  const aoRoleMap = {
    student:  { totalEl: "ao-student-total",  activeEl: "ao-student-active" },
    teacher:  { totalEl: "ao-teacher-total",  activeEl: "ao-teacher-active" },
    eo:       { totalEl: "ao-eo-total",       activeEl: "ao-eo-active" },
    admin:    { totalEl: "ao-admin-total",    activeEl: "ao-admin-active" },
  };

  // Map a Firestore role value to our panel keys
  function classifyRole(role) {
    const r = String(role || "").trim().toLowerCase().replace(/\s+/g, "");
    if (r === "student") return "student";
    if (r === "teacher") return "teacher";
    if (r === "eventorganizer") return "eo";
    if (r === "admin") return "admin";
    if (r === "superadmin") return "admin"; // Super Admins count under Admin column
    return null;
  }

  function formatCount(n) {
    return Number(n).toLocaleString("en-US");
  }

  // Apply a brief fade transition when a number changes
  function setCountText(element, text) {
    if (!element || element.textContent === text) return;
    element.classList.add("ao-updating");
    requestAnimationFrame(() => {
      element.textContent = text;
      requestAnimationFrame(() => element.classList.remove("ao-updating"));
    });
  }

  // Render counts into the DOM
  function renderAccountCounts(totals, actives, totalActiveUsers) {
    Object.entries(aoRoleMap).forEach(([key, { totalEl, activeEl }]) => {
      const tEl = document.getElementById(totalEl);
      const aEl = document.getElementById(activeEl);
      const total = totals[key] || 0;
      const active = actives[key] || 0;

      setCountText(tEl, formatCount(total));

      if (aEl) {
        aEl.innerHTML = "";
        const dot = document.createElement("span");
        dot.className = "accounts-active-dot";
        dot.setAttribute("aria-hidden", "true");
        const label = document.createTextNode(`${formatCount(active)} active now`);
        aEl.append(dot, label);
      }
    });

    const activeTotalEl = document.getElementById("ao-active-total");
    const activeStatusEl = document.getElementById("ao-active-status");

    if (activeTotalEl) {
      setCountText(activeTotalEl, formatCount(totalActiveUsers));
    }
    if (activeStatusEl) {
      activeStatusEl.innerHTML = "";
      const dot = document.createElement("span");
      dot.className = "accounts-active-dot";
      dot.setAttribute("aria-hidden", "true");
      const label = document.createTextNode("Actively logged in");
      activeStatusEl.append(dot, label);
    }
  }

  // Show error, hide counts
  function showAoError() {
    if (aoErrorEl) aoErrorEl.hidden = false;
  }

  function hideAoError() {
    if (aoErrorEl) aoErrorEl.hidden = true;
  }

  // Data from both collections; we merge and recount on every snapshot
  let studentDocs = [];
  let adminUserDocs = [];

  function recomputeAndRender() {
    const totals = { student: 0, teacher: 0, eo: 0, admin: 0 };
    const actives = { student: 0, teacher: 0, eo: 0, admin: 0 };
    let totalActiveUsers = 0;

    const allDocs = [...studentDocs, ...adminUserDocs];
    allDocs.forEach((data) => {
      const key = classifyRole(data.role);
      if (!key) return;
      totals[key]++;
      // Use the existing status/isActive field to determine "active"
      const status = String(data.status || "").toLowerCase();
      const isActive = status === "active" || (status === "" && data.isActive === true);
      if (isActive) {
        actives[key]++;
        totalActiveUsers++;
      }
    });

    renderAccountCounts(totals, actives, totalActiveUsers);
    hideAoError();
  }

  // Subscribe to both user collections with real-time listeners
  let unsubStudents = null;
  let unsubStaff = null;

  function subscribeAccountsOverview() {
    // Clear existing listeners
    if (unsubStudents) { unsubStudents(); unsubStudents = null; }
    if (unsubStaff) { unsubStaff(); unsubStaff = null; }

    unsubStudents = onSnapshot(
      collection(db, "users"),
      (snapshot) => {
        studentDocs = snapshot.docs
          .map((d) => d.data())
          .filter(
            (data) =>
              String(data.role || data.userRole || "")
                .trim()
                .toLowerCase() === "student",
          );
        recomputeAndRender();
      },
      (error) => {
        console.info("[SuperAdminDashboard] users student-profile listener failed:", error);
        showAoError();
      },
    );

    unsubStaff = onSnapshot(
      collection(db, "adminUser"),
      (snapshot) => {
        adminUserDocs = snapshot.docs.map((d) => d.data());
        recomputeAndRender();
      },
      (error) => {
        console.info("[SuperAdminDashboard] adminUser listener failed:", error);
        showAoError();
      },
    );

    unsubscribers.push(
      () => { if (unsubStudents) unsubStudents(); },
      () => { if (unsubStaff) unsubStaff(); },
    );
  }

  if (aoPanel) {
    subscribeAccountsOverview();

    // Retry button
    if (aoRetryBtn) {
      aoRetryBtn.addEventListener("click", () => {
        hideAoError();
        // Reset skeletons
        Object.values(aoRoleMap).forEach(({ totalEl, activeEl }) => {
          const tEl = document.getElementById(totalEl);
          const aEl = document.getElementById(activeEl);
          if (tEl) tEl.innerHTML = '<span class="ao-skeleton"></span>';
          if (aEl) aEl.innerHTML = '<span class="ao-skeleton ao-skeleton-sm"></span>';
        });
        const activeTotalEl = document.getElementById("ao-active-total");
        const activeStatusEl = document.getElementById("ao-active-status");
        if (activeTotalEl) activeTotalEl.innerHTML = '<span class="ao-skeleton"></span>';
        if (activeStatusEl) activeStatusEl.innerHTML = '<span class="ao-skeleton ao-skeleton-sm"></span>';
        subscribeAccountsOverview();
      });
    }

    // Refetch when tab regains focus
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && aoPanel) {
        // Listeners are persistent (onSnapshot), so no action needed.
        // Firestore automatically re-syncs when the tab becomes visible.
      }
    });
  }

  /* ── End Accounts Overview ────────────────────────── */

  const recentTable = tables.find(({ table }) => table.id === "recent-audit-table");
  const allAuditTable = tables.find(
    ({ table }) => table.id === "audit-activity-table",
  );

  if (recentTable) {
    unsubscribers.push(
      onSnapshot(
        query(
          collection(db, "audit_logs"),
          orderBy("timestamp", "desc"),
          limit(8),
        ),
        (snapshot) => {
          const records = snapshot.docs.map(normalizeRecord);
          recordsById.clear();
          records.forEach((record) => recordsById.set(record.id, record));
          renderTable(recentTable, records);
        },
        (error) => {
          console.info("[SuperAdminDashboard] Recent audit listener failed.", error);
          renderTableError(recentTable, "Could not load recent audit activity.");
        },
      ),
    );
  }

  if (allAuditTable) {
    unsubscribers.push(
      onSnapshot(
        query(collection(db, "audit_logs"), orderBy("timestamp", "desc")),
        (snapshot) => {
          const records = snapshot.docs.map(normalizeRecord);
          recordsById.clear();
          records.forEach((record) => recordsById.set(record.id, record));
          renderTable(allAuditTable, records);
        },
        (error) => {
          console.info("[SuperAdminDashboard] Audit log listener failed.", error);
          renderTableError(allAuditTable, "Could not load audit activity.");
        },
      ),
    );
  }

  window.addEventListener(
    "beforeunload",
    () => unsubscribers.forEach((unsubscribe) => unsubscribe()),
    { once: true },
  );
  } catch (error) {
    console.info("[SuperAdminDashboard] Initialization failed; static UI remains mounted.", error);
  }
})();
