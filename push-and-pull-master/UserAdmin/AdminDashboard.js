import {
  collection,
  doc,
  getDoc,
  onSnapshot,
  query,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  onAuthStateChanged,
  signOut,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  ref,
  onValue,
  off,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import {
  auth,
  authReady,
  db,
  rtdb,
  isFirebaseConfigured,
  isRtdbConfigured,
} from "../UserStudent/firebaseConfig.js";

(() => {
  "use strict";
  let profile = {};
  const root = document.getElementById("dashboardRoot");
  let firestoreEvents = [];
  let unsubscribeEvents;
  let toastTimer;
  let waitingOnYouCount = 0;
  let queueListenerRef = null;
  let currentAdminUid = "";
  let adminNotificationController = null;
  let sharedNotificationItems = [];
  let dashboardLoadTimer;
  let dashboardLoadExpired = false;
  const dashboardTableState = {
    query: "",
    status: "",
    organization: "",
    sort: "asc",
    shown: 10,
  };
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila",
  }).format(new Date());
  document.querySelector(".admin-logout").addEventListener("click", async (event) => {
    event.preventDefault();
    try {
      await signOut(auth);
    } finally {
      localStorage.removeItem("recovibeAdminId");
      localStorage.removeItem("recovibeAdminProfile");
      location.replace("AdminLogin.html");
    }
  });
  function read(key, fallback) {
    try {
      return JSON.parse(localStorage.getItem(key) || "null") ?? fallback;
    } catch {
      return fallback;
    }
  }
  function initials(value) {
    return (
      value
        .trim()
        .split(/\s+/)
        .slice(0, 2)
        .map((part) => part[0])
        .join("")
        .toUpperCase()
    );
  }
  function records() {
    return firestoreEvents;
  }
  function waitForAuthState() {
    return new Promise((resolve, reject) => {
      let unsubscribe = () => {};
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        callback(value);
        unsubscribe();
      };
      unsubscribe = onAuthStateChanged(
        auth,
        (user) => finish(resolve, user),
        (error) => finish(reject, error),
      );
      if (settled) unsubscribe();
    });
  }
  function showDashboardError(message, error, uid = auth?.currentUser?.uid || "") {
    clearTimeout(dashboardLoadTimer);
    dashboardLoadTimer = null;
    dashboardLoadExpired = false;
    if (error) {
      console.error("Unable to load Admin Dashboard data:", {
        code: error.code || "unknown",
        message: error.message || String(error),
        uid,
      });
    }
    root.innerHTML = `<div class="admin-error" role="alert">${message} <button class="admin-row-action" id="retryDashboardData" type="button">Try again</button></div>`;
    root.querySelector("#retryDashboardData")?.addEventListener("click", init);
  }
  function getCurrentAdminStage(adminProfile) {
    const normalize = (value) => String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
    const accountValues = [
      adminProfile?.accountNumber, adminProfile?.accountNo,
      adminProfile?.account_number, adminProfile?.account_no,
    ].map(normalize);
    if (accountValues.some((value) => value.includes("administrative"))) return "sir_abelida";
    if (accountValues.some((value) => value.includes("orgadviser") || value.includes("orgadvisor"))) return "org_adv";
    if (accountValues.some((value) => value.includes("hap"))) return "hap";
    if (accountValues.some((value) => value.includes("osas"))) return "osas";
    const values = [
      adminProfile?.approvalStage, adminProfile?.approvalStageKey, adminProfile?.assignedApprovalStage,
      adminProfile?.approverStage, adminProfile?.approverKey, adminProfile?.approvalRole,
      adminProfile?.approverRole, adminProfile?.assignedRole, adminProfile?.assignedApprover,
      adminProfile?.adminRole, adminProfile?.roleName, adminProfile?.stageKey, adminProfile?.position,
      adminProfile?.role, adminProfile?.userRole,
    ].map(normalize);
    const aliases = {
      org_adv: ["orgadv", "orgadviser", "orgadvisor", "organizationadviser", "organizationadvisor", "organizationadviserreview", "adviser"],
      sir_abelida: ["sirabelida", "abelida", "abelidas", "laboratoryhead", "propertycustodian", "administrativeofficer", "labhead", "lab_head"],
      hap: ["hap", "headofacademicprograms", "qaccoordinator", "headofacademicprogramsqaccoordinator"],
      osas: ["osas", "osasreview"],
    };
    return Object.keys(aliases).find((key) =>
      aliases[key].some((alias) => values.includes(alias)),
    ) || null;
  }
  function getApprovalPosition(adminProfile) {
    const labels = {
      org_adv: "Organization Adviser",
      sir_abelida: "Laboratory Head, Property Custodian, Administrative Officer",
      hap: "Head of Academic Programs, QAC Coordinator (HAP)",
      osas: "OSAS",
    };
    return labels[getCurrentAdminStage(adminProfile)] ||
      [adminProfile?.position, adminProfile?.title, adminProfile?.role_title, adminProfile?.approver_role, adminProfile?.approverRole]
        .map((value) => String(value || "").trim()).find(Boolean) || "";
  }
  function isActionRequiredForCurrentAdmin(event) {
    const terminal = ["approved", "revision", "rejected", "cancelled"].includes(
      String(event.approvalStatus || event.status || "").trim().toLowerCase().replace(/[\s_-]+/g, " "),
    );
    if (terminal || statusOf(event) !== "pending_approval" || !auth?.currentUser) return false;
    const stageOrder = ["org_adv", "sir_abelida", "hap", "osas"];
    const aliases = {
      org_adv: ["orgadv", "orgadviser", "orgadvisor", "organizationadviser", "organizationadvisor", "organizationadviserreview"],
      sir_abelida: ["sirabelida", "abelida", "laboratoryhead", "propertycustodian", "administrativeofficer", "labhead"],
      hap: ["hap", "headofacademicprograms", "qaccoordinator"],
      osas: ["osas"],
    };
    const normalize = (value) => String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
    const resolveStage = (values) => stageOrder.find((key) =>
      values.some((value) => aliases[key].includes(normalize(value))),
    );
    const rawStages = event.approvalStages;
    const entries = Array.isArray(rawStages)
      ? rawStages.map((stage, index) => [String(stage?.id || index), stage || {}])
      : rawStages && typeof rawStages === "object" ? Object.entries(rawStages) : [];
    const stages = stageOrder.map((key, index) => {
      const source = entries.find(([id, stage]) =>
        resolveStage([id, stage?.key, stage?.roleKey, stage?.id, stage?.name, stage?.label, stage?.reviewer]) === key,
      )?.[1] || { status: index === 0 ? "review" : "waiting" };
      return { key, step: Number(source.step) || index + 1, source };
    });
    const explicitStep = Number(event.currentStep ?? event.approvalCurrentStep ?? event.approval?.currentStep ?? event.approval?.approvalCurrentStep);
    const requestedStep = Number(event.approvalCurrentStep);
    const currentStageKey = Number.isInteger(requestedStep) && requestedStep >= 1
      ? stages.find((stage) => stage.step === requestedStep)?.key || null
      : stages.find((stage) => !["ok", "approved", "complete", "completed"].includes(
          String(stage.source.status || "").trim().toLowerCase().replace(/[\s_-]+/g, " "),
        ))?.key || null;
    const currentStage = stages.find((stage) => stage.key === currentStageKey);
    const activeStage = stages.find((stage) => {
      const status = String(stage.source.status || "").trim().toLowerCase().replace(/[\s_-]+/g, " ");
      return !["ok", "approved", "complete", "completed"].includes(status);
    });
    if (
      !currentStage ||
      !activeStage ||
      currentStage.key !== activeStage.key ||
      currentStage.key !== getCurrentAdminStage(profile) ||
      !["review", "reviewing", "in review", "in progress", "", "pending", "waiting", "wait"].includes(
        String(currentStage.source.status || "").trim().toLowerCase().replace(/[\s_-]+/g, " "),
      ) ||
      (Number.isInteger(explicitStep) && explicitStep > 0 && explicitStep !== activeStage.step)
    ) return false;
    const assignment = event.approverAssignments?.[currentStage.key] || {};
    const assignedUid = String(
      currentStage.source.reviewerUid || currentStage.source.assignedReviewerUid ||
      currentStage.source.approverUid || currentStage.source.assignedUid ||
      currentStage.source.uid || assignment.reviewerUid || assignment.approverUid ||
      assignment.uid || event[`${currentStage.key}ReviewerUid`] ||
      event[`${currentStage.key}ApproverUid`] ||
      ({
        org_adv: event.orgAdviserUid || event.organizationAdviserUid || event.adviserUid,
        sir_abelida: event.labHeadUid || event.laboratoryHeadUid || event.propertyCustodianUid || event.sirAbelidaUid,
        hap: event.hapUid || event.qacCoordinatorUid,
        osas: event.osasUid,
      })[currentStage.key] || "",
    ).trim();
    const assignedEmail = String(
      currentStage.source.reviewerEmail || currentStage.source.assignedReviewerEmail ||
      currentStage.source.approverEmail || currentStage.source.assignedEmail ||
      assignment.reviewerEmail || assignment.assignedEmail ||
      assignment.approverEmail || assignment.email ||
      event[`${currentStage.key}ReviewerEmail`] || event[`${currentStage.key}ApproverEmail`] ||
      ({
        org_adv: event.orgAdviserEmail || event.organizationAdviserEmail || event.adviserEmail,
        sir_abelida: event.labHeadEmail || event.laboratoryHeadEmail || event.propertyCustodianEmail || event.sirAbelidaEmail,
        hap: event.hapEmail || event.qacCoordinatorEmail,
        osas: event.osasEmail,
      })[currentStage.key] || "",
    ).trim().toLowerCase();
    return assignedUid ? assignedUid === auth.currentUser.uid
      : assignedEmail ? assignedEmail === String(auth.currentUser.email || "").trim().toLowerCase()
      : currentAdminUid === auth.currentUser.uid &&
        getCurrentAdminStage(profile) === currentStage.key;
  }
  function normalizeEvent(eventDocument) {
    const data = eventDocument.data();
    const eventDate = data.eventDate || data.dateISO || data.date || "";
    return {
      ...data,
      id: eventDocument.id,
      eventId: eventDocument.id,
      title: data.eventName || data.title || "Untitled event",
      date: eventDate,
      dateISO: eventDate,
      venue: data.venue || data.location || data.venueOther || "",
      location: data.venue || data.location || data.venueOther || "",
      organization: data.organization || data.organizerName || "",
      createdAt: data.createdAt?.toDate
        ? data.createdAt.toDate().toISOString()
        : data.createdAt || "",
    };
  }
  function statusOf(event) {
    const value = String(event.status || "")
      .toLowerCase()
      .replace(/[ -]+/g, "_");
    return value === "pending" ? "pending_approval" : value;
  }
  function openItems(events) {
    return events
      .flatMap((event) => {
        const status = statusOf(event);
        const issues = [];
        if (status === "pending_approval" || status === "pending")
          issues.push(
            hasConflict(event, events)
              ? { label: "Venue Conflict", type: "venue_conflict" }
              : { label: "Pending Approval", type: "pending_approval" },
          );
        if (status === "final_documents_submitted")
          issues.push({
            label: "Final Documents Submitted",
            type: "final_documents_submitted",
          });
        if (event.rescheduleRequest?.status === "pending")
          issues.push({
            label: "Reschedule Request",
            type: "reschedule_request",
          });
        if (
          (status === "cancelled" || status === "canceled") &&
          !(
            event.cancellation?.acknowledgedAt ||
            event.cancellation?.acknowledgedBy
          )
        )
          issues.push({ label: "Cancellation", type: "cancellation" });
        return issues.map((issue) => ({
          event,
          ...issue,
          at: event.submittedAt || event.createdAt || event.updatedAt || "",
        }));
      })
      .sort((a, b) => new Date(a.at || 0) - new Date(b.at || 0));
  }
  function hasConflict(event, all) {
    const date = (event.dateISO || event.date || "").slice(0, 10),
      venue = event.venue || event.location || "",
      parts = String(event.time || "").split(/\s*[-–]\s*/),
      mins = (value) => {
        const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(String(value || ""));
        return m
          ? ((Number(m[1]) % 12) + (m[3].toUpperCase() === "PM" ? 12 : 0)) *
              60 +
              Number(m[2])
          : null;
      },
      start = mins(event.startTime || parts[0]),
      end = mins(event.endTime || parts[1]);
    if (
      !date ||
      !venue ||
      venue.startsWith("Others |") ||
      start === null ||
      end === null
    )
      return false;
    const rooms = [
      "AVR2-1Room | PUP Biñan",
      "AVR2-2Room | PUP Biñan",
      "AVR2-3Room | PUP Biñan",
    ];
    return all.some((other) => {
      if (
        other === event ||
        ["draft", "rejected", "cancelled", "canceled"].includes(
          statusOf(other),
        ) ||
        (other.dateISO || other.date || "").slice(0, 10) !== date
      )
        return false;
      const otherVenue = other.venue || other.location || "",
        same =
          venue === otherVenue ||
          (venue === "AVR2 | PUP Biñan" && rooms.includes(otherVenue)) ||
          (otherVenue === "AVR2 | PUP Biñan" && rooms.includes(venue));
      if (!same) return false;
      const range = String(other.time || "").split(/\s*[-–]\s*/),
        a = mins(other.startTime || range[0]),
        b = mins(other.endTime || range[1]);
      return a !== null && b !== null && start < b && end > a;
    });
  }
  function render() {
    try {
      root.innerHTML =
        `<div class="dashboard-greeting"><div><p class="dashboard-greeting-title">${esc(greeting())}</p><p class="dashboard-greeting-date">${esc(localDateLabel())}</p></div></div><div class="admin-metrics"></div><section class="admin-section"><div class="admin-section-heading"><div><h2>Event Submissions</h2><p class="admin-section-description"><strong>Source</strong> is the publishing channel, <strong>Category</strong> is the event topic, and <strong>EO (Event Organizer)</strong> is the responsible person or group. Organizer roles are shown beneath the EO.</p></div><a href="AdminApproval.html">Open Review Queue</a></div><div class="dashboard-table-controls"><label>Search by event name<input type="search" id="dashboardEventSearch" placeholder="Search event name..." value="${esc(dashboardTableState.query)}"></label><label>Status<select id="dashboardStatusFilter"><option value="">All statuses</option></select></label><label for="dashboardOrganizationFilter">Organization<select id="dashboardOrganizationFilter"><option value="">All organizations</option></select></label><label>Sort by schedule<select id="dashboardScheduleSort"><option value="asc">Earliest first</option><option value="desc">Latest first</option></select></label><button type="button" class="admin-link-button" id="resetDashboardFilters">Reset</button></div><div class="admin-table-wrap"><table class="admin-table"><thead><tr><th scope="col">Event</th><th scope="col">Source</th><th scope="col">Category</th><th scope="col">Event Organizer (EO)</th><th scope="col">Schedule</th><th scope="col">Venue</th><th scope="col">Status</th><th scope="col">Actions</th></tr></thead><tbody id="eventRows"></tbody></table></div><div id="eventsEmpty" class="admin-empty" hidden>No event submissions yet.</div><div class="dashboard-show-more-wrap"><button type="button" class="admin-row-action" id="showMoreEvents" hidden>Show more</button></div></section>`;
      const events = records();
      waitingOnYouCount = events.filter(isActionRequiredForCurrentAdmin).length;
      const all = openItems(events);
      const published = events.filter(isDashboardPublishedEvent);
      const metrics = [
        [
          "Waiting on you",
          waitingOnYouCount,
        ],
        [
          "Finalization Pending",
          events.filter((e) => statusOf(e) === "final_documents_submitted")
            .length,
        ],
        [
          "Upcoming Events",
          published.filter((event) => dashboardEventStatus(event) === "Upcoming").length,
        ],
        [
          "Events Today",
          published.filter(
            (e) =>
              dashboardEventDateKey(e) === today,
          ).length,
        ],
      ];
      root.querySelector(".admin-metrics").innerHTML = metrics
        .map(
          ([label, count]) =>
            `<div class="admin-metric ${count ? "has-items" : "is-empty"}"><strong>${count}</strong><span>${label}</span></div>`,
        )
        .join("");
      const statusFilter = root.querySelector("#dashboardStatusFilter");
      const statuses = [...new Set(events.map((event) => statusOf(event)).filter(Boolean))].sort();
      statusFilter.innerHTML += statuses.map((status) =>
        `<option value="${esc(status)}">${esc(statusLabel(status))}</option>`,
      ).join("");
      statusFilter.value = dashboardTableState.status;
      const organizationFilter = root.querySelector("#dashboardOrganizationFilter");
      const organizations = new Map();
      events.forEach((event) => {
        const organization = eventOrganizerName(event).replace(/\s+/g, " ").trim();
        if (organization) {
          const key = organization.toLocaleLowerCase();
          if (!organizations.has(key)) organizations.set(key, organization);
        }
      });
      const organizationOptions = [...organizations.entries()].sort((a, b) =>
        a[1].localeCompare(b[1], undefined, { sensitivity: "base" }),
      );
      if (!organizationOptions.some(([key]) => key === dashboardTableState.organization)) {
        dashboardTableState.organization = "";
      }
      organizationFilter.innerHTML =
        '<option value="">All organizations</option>' +
        organizationOptions.map(([key, label]) =>
          `<option value="${esc(key)}">${esc(label)}</option>`,
        ).join("");
      organizationFilter.value = dashboardTableState.organization;
      root.querySelector("#dashboardScheduleSort").value = dashboardTableState.sort;
      root.querySelector("#dashboardEventSearch").addEventListener("input", (event) => {
        dashboardTableState.query = event.target.value;
        dashboardTableState.shown = 10;
        updateDashboardRows(events);
      });
      statusFilter.addEventListener("change", (event) => {
        dashboardTableState.status = event.target.value;
        dashboardTableState.shown = 10;
        updateDashboardRows(events);
      });
      organizationFilter.addEventListener("change", (event) => {
        dashboardTableState.organization = event.target.value;
        dashboardTableState.shown = 10;
        updateDashboardRows(events);
      });
      root.querySelector("#dashboardScheduleSort").addEventListener("change", (event) => {
        dashboardTableState.sort = event.target.value;
        updateDashboardRows(events);
      });
      root.querySelector("#resetDashboardFilters").addEventListener("click", () => {
        dashboardTableState.query = "";
        dashboardTableState.status = "";
        dashboardTableState.organization = "";
        dashboardTableState.sort = "asc";
        dashboardTableState.shown = 10;
        root.querySelector("#dashboardEventSearch").value = "";
        statusFilter.value = "";
        organizationFilter.value = "";
        root.querySelector("#dashboardScheduleSort").value = "asc";
        updateDashboardRows(events);
      });
      root.querySelector("#showMoreEvents").addEventListener("click", () => {
        dashboardTableState.shown += 10;
        updateDashboardRows(events);
      });
      updateDashboardRows(events);
      document.querySelectorAll("[data-queue-count]").forEach((badge) => {
        badge.textContent = String(waitingOnYouCount);
        badge.hidden = waitingOnYouCount === 0;
      });
    } catch (error) {
      root.innerHTML = `<div class="admin-error">Could not load dashboard data. <button class="admin-row-action" id="retryDashboard">Retry</button></div>`;
      root.querySelector("#retryDashboard").onclick = render;
    }
  }
  function greeting() {
    const hour = new Date().getHours();
    const timeOfDay = hour < 12 ? "Morning" : hour < 18 ? "Afternoon" : "Evening";
    const fullName = profile.firstName || profile.name ||
      [profile.firstName, profile.middleName, profile.lastName].filter(Boolean).join(" ") ||
      auth?.currentUser?.displayName || auth?.currentUser?.email?.split("@")[0] || "Admin";
    return `Good ${timeOfDay}, ${String(fullName).trim().split(/\s+/)[0]}`;
  }
  function localDateLabel() {
    return new Intl.DateTimeFormat("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
    }).format(new Date());
  }
  function statusLabel(value) {
    const normalized = String(value || "").replace(/[_-]+/g, " ").trim();
    return normalized ? normalized[0].toUpperCase() + normalized.slice(1) : "Status unavailable";
  }
  function updateDashboardRows(events) {
    const queryText = dashboardTableState.query.trim().toLowerCase();
    const filtered = events.filter((event) =>
      (!queryText || String(event.eventName || event.title || "").toLowerCase().includes(queryText)) &&
      (!dashboardTableState.status || statusOf(event) === dashboardTableState.status) &&
      (!dashboardTableState.organization ||
        eventOrganizerName(event).replace(/\s+/g, " ").trim().toLocaleLowerCase() ===
          dashboardTableState.organization),
    ).sort((a, b) => {
      return (dashboardScheduleValue(a) - dashboardScheduleValue(b)) *
        (dashboardTableState.sort === "asc" ? 1 : -1);
    });
    const visible = filtered.slice(0, dashboardTableState.shown);
    const rows = root.querySelector("#eventRows");
    rows.innerHTML = visible.map(eventRow).join("");
    const empty = root.querySelector("#eventsEmpty");
    empty.hidden = filtered.length > 0;
    empty.textContent = events.length &&
      (queryText || dashboardTableState.status || dashboardTableState.organization)
      ? "No matching events."
      : "No event submissions yet.";
    const more = root.querySelector("#showMoreEvents");
    more.hidden = filtered.length <= visible.length;
  }
  function eventOrganizerName(event) {
    return String(
      event.organizerName ||
      event.eventOrganizer ||
      event.organizer ||
      event.organization ||
      "",
    ).replace(/\s+/g, " ").trim();
  }
  function eventRow(event) {
    const categories = event.categories || event.category || "General";
    const category = (Array.isArray(categories) ? categories : [categories])
      .map((value) =>
        typeof value === "object"
          ? value.name || value.title || value.label || ""
          : value,
      )
      .filter(Boolean);
    const categoryLabels = category.length ? category : ["General"];
    const categoryDisplay = `<span class="dashboard-category-pill" title="${esc(categoryLabels.join(", "))}">${esc(categoryLabels[0])}</span>${categoryLabels.length > 1 ? `<span class="dashboard-category-more" title="${esc(categoryLabels.slice(1).join(", "))}">+${categoryLabels.length - 1}</span>` : ""}`;
    const source = normalizeSource(
      event.source ||
        event.eventSource ||
        event.organizationType,
      event._role,
    );
    const organizer = eventOrganizerName(event) || "—";
    const organizerRole =
      event.organizerRole ||
      event.eventOrganizerRole ||
      event.contactRole ||
      "";
    const pending = isActionRequiredForCurrentAdmin(event);
    const eventId = event.eventId || event.id;
    const scheduleDate = formatDashboardDate(event.eventDate || event.dateISO || event.date);
    const [startTime, endTime] = dashboardTimes(event);
    const status = statusOf(event);
    const statusClass = status.replace(/[^a-z0-9]+/g, "-");
    return `<tr><td data-label="Event"><span class="admin-item-title" title="${esc(event.eventName || event.title || "Untitled event")}">${esc(event.eventName || event.title || "Untitled event")}</span></td><td data-label="Source"><span title="${esc(source)}">${esc(source)}</span></td><td data-label="Category"><div class="dashboard-category-list">${categoryDisplay}</div></td><td data-label="Event Organizer (EO)"><span class="admin-item-title" title="${esc(organizer)}">${esc(organizer)}</span>${organizerRole ? `<small class="admin-organizer-role">EO role: ${esc(organizerRole)}</small>` : ""}</td><td data-label="Schedule">${esc(scheduleDate)}<small>${esc(startTime)} - ${esc(endTime)}</small></td><td data-label="Venue"><span title="${esc(event.venue || "—")}">${esc(event.venue || "—")}</span></td><td data-label="Status"><span class="event-status status-${esc(statusClass)}">${esc(statusLabel(status))}</span></td><td data-label="Actions">${pending ? `<a class="admin-row-action" href="AdminApproval.html?review=${encodeURIComponent(eventId)}">Review</a>` : "—"}</td></tr>`;
  }
  function formatDashboardDate(value) {
    const dateValue = value?.toDate ? value.toDate() : value;
    if (!dateValue) return "Date TBA";
    const date = dateValue instanceof Date
      ? dateValue
      : /^\d{4}-\d{2}-\d{2}$/.test(String(dateValue))
        ? new Date(`${dateValue}T00:00:00+08:00`)
        : new Date(dateValue);
    return Number.isNaN(date.getTime())
      ? "Date TBA"
      : new Intl.DateTimeFormat("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
          timeZone: "Asia/Manila",
        }).format(date);
  }
  function formatDashboardTime(value) {
    if (!value) return "";
    const dateValue = value?.toDate ? value.toDate() : value;
    if (dateValue instanceof Date) {
      return new Intl.DateTimeFormat("en-US", {
        hour: "numeric",
        minute: "2-digit",
        timeZone: "Asia/Manila",
      }).format(dateValue);
    }
    const text = String(dateValue).trim();
    const match = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(text);
    if (match) {
      const hours = Number(match[1]);
      return `${hours % 12 || 12}:${match[2]} ${hours >= 12 ? "PM" : "AM"}`;
    }
    const parsedDate = new Date(text);
    if (/^\d{4}-\d{2}-\d{2}T/.test(text) && !Number.isNaN(parsedDate.getTime())) {
      return new Intl.DateTimeFormat("en-US", {
        hour: "numeric",
        minute: "2-digit",
        timeZone: "Asia/Manila",
      }).format(parsedDate);
    }
    return text;
  }
  function dashboardTimes(event) {
    const range = String(event.time || "").split(/\s*[-–]\s*/);
    return [
      formatDashboardTime(event.startTime || event.timeStart || event.startAt || range[0]) || "Time TBA",
      formatDashboardTime(event.endTime || event.timeEnd || event.endAt || range[1]) || "Time TBA",
    ];
  }
  function dashboardScheduleValue(event) {
    const dateText = dashboardEventDateKey(event);
    if (!dateText) return Number.MAX_SAFE_INTEGER;
    const day = new Date(`${dateText}T00:00:00+08:00`).getTime();
    const [startTime] = dashboardTimes(event);
    const time = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(startTime);
    const minutes = time
      ? (Number(time[1]) % 12 + (time[3].toUpperCase() === "PM" ? 12 : 0)) * 60 +
        Number(time[2])
      : 0;
    return Number.isNaN(day) ? Number.MAX_SAFE_INTEGER : day + minutes * 60000;
  }
  function dashboardEventDateKey(event) {
    const rawDate = event.eventDate || event.dateISO || event.date;
    const dateValue = rawDate?.toDate ? rawDate.toDate() : rawDate;
    if (!dateValue) return "";
    if (dateValue instanceof Date) {
      const parts = new Intl.DateTimeFormat("en-CA", {
          timeZone: "Asia/Manila",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
      }).formatToParts(dateValue);
      const part = (type) => parts.find((item) => item.type === type)?.value || "";
      return `${part("year")}-${part("month")}-${part("day")}`;
    }
    return String(dateValue).slice(0, 10);
  }
  function dashboardEventStatus(event) {
    const rawStatus = String(event.status || "").trim().toLowerCase().replace(/[ _-]+/g, " ");
    if (["cancelled", "canceled"].includes(rawStatus)) return "Cancelled";
    const parts = String(event.time || "").split(/\s*[-–]\s*/);
    const toInstant = (time) => {
      const text = String(time || "").trim();
      let match = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(text);
      let minutes;
      if (match) {
        minutes = ((Number(match[1]) % 12) + (match[3].toUpperCase() === "PM" ? 12 : 0)) * 60 +
          Number(match[2]);
      } else {
        match = /^(\d{1,2}):(\d{2})$/.exec(text);
        minutes = match ? Number(match[1]) * 60 + Number(match[2]) : null;
      }
      if (minutes === null) return null;
      const date = dashboardEventDateKey(event);
      const value = new Date(`${date}T${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}:00+08:00`);
      return Number.isNaN(value.getTime()) ? null : value;
    };
    const end = toInstant(event.endTime || parts[1]);
    const start = toInstant(event.startTime || parts[0]);
    const now = new Date();
    if (end && end < now) return "Completed";
    if (event.isRescheduled) return "Rescheduled";
    if (start && end && start <= now && now <= end) return "Happening";
    return "Upcoming";
  }
  function isDashboardPublishedEvent(event) {
    const status = String(event.status || "").trim().toLowerCase().replace(/[ _-]+/g, " ");
    return ["published", "approved", "available to join", "rescheduled"].includes(status) ||
      event.isPublished === true ||
      event.published === true;
  }
  function normalizeSource(value, role = "") {
    const source = String(value || "").trim().toLowerCase();
    if (!source && role === "Teacher") return "Teacher / Faculty";
    if (/\bcsc\b/.test(source)) return "CSC";
    if (/teacher|faculty/.test(source)) return "Teacher / Faculty";
    if (/ibits|organiz|event.?organizer/.test(source)) return "Organizational";
    if (/external|other/.test(source)) return "Others / External";
    if (/pup|campus|cite|polytechnic/.test(source)) return "PUP Official";
    return "Others / External";
  }
  function age(value) {
    if (!value) return "Submitted date unavailable";
    const days = Math.max(
      0,
      Math.floor((Date.now() - new Date(value).getTime()) / 86400000),
    );
    return `Submitted ${days ? `${days} day${days === 1 ? "" : "s"} ago` : "today"}`;
  }
  function esc(value) {
    return String(value ?? "").replace(
      /[&<>"']/g,
      (ch) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[ch],
    );
  }
  function showToast(message) {
    const toast = document.querySelector(".admin-toast");
    toast.textContent = message;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toast.hidden = true), 3200);
  }
  window.addEventListener("storage", (event) => {
    if (
      !event.key ||
      (event.key.startsWith("recovibe") && event.key.endsWith("Events"))
    )
      render();
  });
  window.addEventListener("focus", render);
  window.addEventListener("recovibeAdminEventsChanged", render);
  function updateQueueBadge(count) {
    document.querySelectorAll("[data-queue-count]").forEach((badge) => {
      badge.textContent = String(count);
      badge.hidden = count === 0;
    });
  }

  function subscribeToQueue(uid) {
    if (!isRtdbConfigured || !rtdb || !uid) return;
    if (queueListenerRef) {
      off(queueListenerRef);
      queueListenerRef = null;
    }
    queueListenerRef = ref(rtdb, `approverQueue/${uid}`);
    onValue(
      queueListenerRef,
      (snapshot) => {
        const data = snapshot.val() || {};
        const items = Object.values(data);
        const activeItems = items.filter(
          (it) => it && it.status !== "paused_for_revision",
        );
        if (!firestoreEvents.length) waitingOnYouCount = activeItems.length;
        updateQueueBadge(waitingOnYouCount);
      },
      (err) => {
        console.warn("approverQueue listener error:", err);
      },
    );
  }

  function renderNotificationMenu(combined) {
    const menu = document.querySelector("[data-notification-menu]");
    if (!menu) return;
    menu.innerHTML = `<div class="dashboard-notification-heading"><strong>Notifications</strong><a href="AdminNotification.html">View all</a></div>${
      combined.length
        ? combined
            .slice(0, 8)
            .map(
              (item) =>
                `<button type="button" class="dashboard-notification ${!item.read ? "is-unread" : ""}" data-notification-id="${esc(item.id)}" data-event-id="${esc(item.eventId || "")}" data-source="${esc(item.source || "rtdb")}"><strong>${esc(item.title || "Notification")}</strong><span>${esc(item.message || "")}</span></button>`,
            )
            .join("")
        : '<p class="dashboard-notification-empty">No notifications yet.</p>'
    }`;
  }

  import("./AdminNotificationData.js")
    .then(({ subscribeAdminNotifications }) => {
      adminNotificationController = subscribeAdminNotifications((state) => {
        sharedNotificationItems = state.items;
        renderNotificationMenu(state.items);
      });
    })
    .catch(() => {
      document.querySelectorAll("[data-notification-count]").forEach((badge) => { badge.hidden = true; });
      renderNotificationMenu([]);
    });

  async function init() {
    clearTimeout(dashboardLoadTimer);
    unsubscribeEvents?.();
    unsubscribeEvents = null;
    if (!isFirebaseConfigured || !db) {
      root.innerHTML =
        '<div class="admin-error">Event data is unavailable. Please contact support.</div>';
      return;
    }
    root.innerHTML = '<div class="admin-loading">Loading event activity…</div>';
    dashboardLoadExpired = false;
    dashboardLoadTimer = setTimeout(() => {
      dashboardLoadExpired = true;
      unsubscribeEvents?.();
      root.innerHTML = '<div class="admin-error" role="alert">Could not load dashboard data in time. <button class="admin-row-action" id="retryDashboardData" type="button">Try again</button></div>';
      root.querySelector("#retryDashboardData")?.addEventListener("click", init);
    }, 15000);

    try {
      await authReady;
      if (dashboardLoadExpired) return;
      if (!auth) throw new Error("Please sign in with an Admin account.");
      const user = await waitForAuthState();
      if (dashboardLoadExpired) return;
      if (!user) {
        clearTimeout(dashboardLoadTimer);
        dashboardLoadTimer = null;
        location.replace("AdminLogin.html");
        return;
      }
      currentAdminUid = user.uid;
      const [adminResult, userResult] = await Promise.allSettled([
        getDoc(doc(db, "adminUser", user.uid)),
        getDoc(doc(db, "users", user.uid)),
      ]);
      if (dashboardLoadExpired) return;
      if (adminResult.status === "rejected") throw adminResult.reason;
      if (!adminResult.value.exists()) {
        location.replace("AdminLogin.html");
        return;
      }
      const adminProfile = adminResult.value.data() || {};
      const userProfile = userResult.status === "fulfilled" && userResult.value.exists()
        ? userResult.value.data()
        : {};
      if (userResult.status === "rejected") {
        console.warn("Could not load the optional users profile for the Admin Dashboard:", {
          code: userResult.reason?.code || "unknown",
          message: userResult.reason?.message || String(userResult.reason),
          uid: user.uid,
        });
      }
      const verifiedProfile = { ...userProfile, ...adminProfile };
      const roleValue = Object.prototype.hasOwnProperty.call(adminProfile, "role")
        ? adminProfile.role
        : adminProfile.userRole;
      const role = String(roleValue || "").trim().toLowerCase().replace(/[\s_.-]+/g, "");
      const status = String(adminProfile.status || "Active")
        .trim()
        .toLowerCase()
        .replace(/[\s_.-]+/g, "");
      if (
        !["admin", "superadmin", "osas"].includes(role)
        || ["disabled", "inactive", "suspended"].includes(status)
      ) {
        clearTimeout(dashboardLoadTimer);
        dashboardLoadTimer = null;
        location.replace("AdminLogin.html");
        return;
      }
      profile = { ...verifiedProfile, uid: user.uid, email: user.email || "" };
      const name = profile.name || [profile.firstName, profile.middleName, profile.lastName].filter(Boolean).join(" ") || user.displayName || user.email?.split("@")[0] || "";
      document.querySelector("[data-name]").textContent = name.toUpperCase();
      document.querySelector("[data-avatar]").textContent = initials(name);
      const roleElement = document.querySelector("[data-role]");
      roleElement.textContent = getApprovalPosition(profile);
      roleElement.title = roleElement.textContent;
      subscribeToQueue(user.uid);
      unsubscribeEvents?.();
      const eventsQuery = query(collection(db, "events"));
      unsubscribeEvents = onSnapshot(
        eventsQuery,
        (snapshot) => {
          clearTimeout(dashboardLoadTimer);
          dashboardLoadTimer = null;
          dashboardLoadExpired = false;
          firestoreEvents = snapshot.docs.map(normalizeEvent);
          render();
        },
        (error) => {
          unsubscribeEvents?.();
          unsubscribeEvents = null;
          showDashboardError(
            error?.code === "permission-denied"
              ? "You don't have permission to view this."
              : "Could not load dashboard events.",
            error,
            user.uid,
          );
        },
      );
    } catch (error) {
      showDashboardError(
        error?.code === "permission-denied"
          ? "You don't have permission to view this."
          : "Could not verify your Admin or OSAS access.",
        error,
      );
    }
  }

  const notificationToggle = document.querySelector("[data-notification-toggle]");
  notificationToggle.addEventListener("click", () => {
    const menu = document.querySelector("[data-notification-menu]");
    menu.hidden = !menu.hidden;
    notificationToggle.setAttribute("aria-expanded", String(!menu.hidden));
  });

  document.addEventListener("click", async (event) => {
    const item = event.target.closest("[data-notification-id]");
    if (item) {
      const notifId = item.dataset.notificationId;
      const eventId = item.dataset.eventId;
      const notification = sharedNotificationItems.find((entry) => entry.id === notifId);
      if (item.classList.contains("is-unread") && notification) {
        try {
          await adminNotificationController?.setReadState(notification, true);
        } catch (error) {
          console.error("Unable to mark notification as read:", error);
        }
      }
      document.querySelector("[data-notification-menu]").hidden = true;
      notificationToggle.setAttribute("aria-expanded", "false");
      if (eventId) {
        location.href = `AdminApproval.html?review=${encodeURIComponent(eventId)}`;
      }
      return;
    }
    if (!event.target.closest(".dashboard-notifications")) {
      const menu = document.querySelector("[data-notification-menu]");
      if (menu) menu.hidden = true;
      notificationToggle.setAttribute("aria-expanded", "false");
    }
  });

  window.addEventListener("pagehide", () => {
    clearTimeout(dashboardLoadTimer);
    unsubscribeEvents?.();
    if (queueListenerRef) off(queueListenerRef);
  });
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) init();
  });
  init();
})();
