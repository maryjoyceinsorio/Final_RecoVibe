import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  ref,
  onValue,
  off,
  get,
  remove,
  set,
  update,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js";
import {
  arrayUnion,
  collection,
  deleteDoc,
  doc,
  getDoc,
  onSnapshot,
  query,
  updateDoc,
  where,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  auth,
  authReady,
  db,
  rtdb,
  functions,
} from "../UserStudent/firebaseConfig.js";

(() => {
  "use strict";

  const eventTableBody = document.getElementById("eventTableBody");
  const todayElement = document.getElementById("organizerToday");
  let authResolving = true;
  let authUnauthenticated = false;
  let organizerId = "";
  let organizerEvents = [];
  let eventDataById = new Map();
  let firestoreEventsById = new Map();
  let draftsById = new Map();
  const firestoreEventUnsubscribers = [];
  const deletedFirestoreEventIds = new Set();
  let activeIndexListenerRef = null;
  let activeDraftsListenerRef = null;
  let indexLoaded = false;
  let draftsLoaded = false;
  let firestoreEventsLoaded = false;
  let loadErrorOccurred = false;
  let missingEventTimeout = null;
  const activeEventListeners = new Map();
  const approvalsMap = new Map();
  const firestoreApprovalsById = new Map();
  const activeApprovalListeners = new Map();
  let activeEventsListenerRef = null;
  const realtimeDatabaseConfigured = Boolean(rtdb?.app?.options?.databaseURL);
  const firestoreDb = db;

  const searchInput = document.getElementById("eventSearch");
  const dateFilter = document.getElementById("eventDateFilter");
  const eventResultsCount = document.getElementById("eventResultsCount");

  // Approval Tracker Modal DOM Elements
  const trackerModalOverlay = document.getElementById("trackerModalOverlay");
  const trackerBackdrop = document.getElementById("trackerBackdrop");
  const btnTrackerClose = document.getElementById("btnTrackerClose");
  const trackerHeaderTitle = document.getElementById("trackerHeaderTitle");
  const trackerSubmittedDate = document.getElementById("trackerSubmittedDate");
  const trackerTimeline = document.getElementById("trackerTimeline");
  const trackerNotesList = document.getElementById("trackerNotesList");
  const trackerHistoryList = document.getElementById("trackerHistoryList");
  const trackerNextLine = document.getElementById("trackerNextLine");
  const trackerDocsList = document.getElementById("trackerDocsList");
  const trackerReplaceForm = document.getElementById("trackerReplaceForm");
  const trackerReplaceDriveLink = document.getElementById("trackerReplaceDriveLink");
  const trackerReplaceDriveError = document.getElementById("trackerReplaceDriveError");
  const btnTrackerReplaceConfirm = document.getElementById("btnTrackerReplaceConfirm");
  const btnTrackerReplaceCancel = document.getElementById("btnTrackerReplaceCancel");
  const btnTrackerRemind = document.getElementById("btnTrackerRemind");
  const btnTrackerCancel = document.getElementById("btnTrackerCancel");
  const btnTrackerResubmit = document.getElementById("btnTrackerResubmit");
  const btnTrackerPublish = document.getElementById("btnTrackerPublish");

  let activeTrackingEventId = null;
  let activeReplacingFileId = null;

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

  function normalizeStatus(status) {
    const raw = String(status ?? "").trim().toLowerCase().replace(/[\s_-]+/g, " ");
    if (["pending approval", "under review", "in review", "reviewing", "submitted"].includes(raw)) return "pending";
    if (["needs revision", "revision requested", "changes requested", "revision", "rev"].includes(raw)) return "revision";
    if (["rejected", "reject", "rej"].includes(raw)) return "rejected";
    if (["approve", "fully approved", "ready to publish", "ok", "complete", "completed", "done"].includes(raw)) return "approved";
    if (["live", "published live"].includes(raw)) return "published";
    if (raw === "canceled") return "cancelled";
    return raw;
  }

  function isGoogleDriveLink(value) {
    try {
      const url = new URL(String(value || "").trim());
      return url.protocol === "https:" &&
        ["drive.google.com", "docs.google.com"].includes(url.hostname.toLowerCase()) &&
        url.pathname !== "/";
    } catch {
      return false;
    }
  }

  function hasTrueFlag(value) {
    return value === true || value === 1 || ["true", "yes", "1"].includes(String(value ?? "").trim().toLowerCase());
  }

  function getEventStatusValues(event) {
    return [
      event.status,
      event.approvalStatus,
      event.approval_status,
      event.adminStatus,
      event.admin_status,
      event.adminApprovalStatus,
      event.approvalState,
      event.approval_state,
      event.reviewStatus,
      event.publicationStatus,
      event.moderationStatus,
      event.eventStatus,
      event.isApproved,
      event.approved,
      event.published,
      event.approval?.approvalStatus,
      event.approval?.status,
      event.approval?.state,
      event.admin?.status,
      event.review?.status,
      event.moderation?.status,
      event.approvalData?.status,
    ]
      .filter((status) => status !== null && status !== undefined && status !== "")
      .map(normalizeStatus);
  }

  function buildFirestoreApproval(event) {
    const standardStages = [
      { key: "org_adv", label: "Organization Adviser", aliases: ["org_adv", "org adviser", "organization adviser", "organization adviser review", "migs", "michael anjelo miguel"] },
      { key: "sir_abelida", label: "Laboratory Head, Property Custodian, Administrative Officer", aliases: ["sir_abelida", "abelidads", "abelida", "sir abelida", "gerino abelida", "gerino abelida jr", "laboratory head", "property custodian", "administrative officer", "laboratory head property custodian administrative officer"] },
      { key: "hap", label: "Head of Academic Programs, QAC Coordinator", aliases: ["hap", "archong", "archie", "archie arevalo", "head of academic programs", "qac coordinator", "head of academic programs qac coordinator"] },
      { key: "osas", label: "OSAS", aliases: ["osas", "cheryl joyce jurado", "joyce"] },
    ];
    const sourceStages = event.approvalStages;
    const stageEntries = Array.isArray(sourceStages)
      ? sourceStages.map((stage, index) => [String(stage?.id || index), stage || {}])
      : Object.entries(sourceStages || {});
    const normalizeKey = (value) => String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    const overallStatusValues = getEventStatusValues(event);
    const isOverallApproved = overallStatusValues.some((status) =>
      ["approved", "published", "completed"].includes(status),
    );
    const approvalHistory = Array.isArray(event.approvalHistory) ? event.approvalHistory : [];
    const currentStep = Number(event.approvalCurrentStep);
    const historyByStage = new Map();
    approvalHistory.forEach((entry) => {
      if (!entry || typeof entry !== "object") return;
      const historyStage = [entry.stage, entry.stageKey, entry.key, entry.id, entry.stageLabel, entry.label]
        .map(normalizeKey)
        .find((value) => standardStages.some((stage) =>
          normalizeKey(stage.key) === value ||
          normalizeKey(stage.label) === value ||
          stage.aliases.some((alias) => normalizeKey(alias) === value),
        ));
      if (!historyStage) return;
      const stage = standardStages.find((candidate) =>
        normalizeKey(candidate.key) === historyStage ||
        normalizeKey(candidate.label) === historyStage ||
        candidate.aliases.some((alias) => normalizeKey(alias) === historyStage),
      );
      if (stage) historyByStage.set(stage.key, entry);
    });
    const members = {};

    standardStages.forEach((stage, index) => {
      const source = stageEntries.find(([id, candidate]) =>
        [id, candidate?.id, candidate?.key, candidate?.label, candidate?.name, candidate?.reviewer]
          .some((value) => stage.aliases.some((alias) => normalizeKey(alias) === normalizeKey(value)) ||
            normalizeKey(value) === normalizeKey(stage.key) ||
            normalizeKey(value) === normalizeKey(stage.label)),
      )?.[1];
      const historyEntry = historyByStage.get(stage.key);
      const sourceStatus = normalizeStatus(
        historyEntry?.decision || historyEntry?.status || historyEntry?.approvalStatus ||
        source?.status || source?.approvalStatus || source?.state || source?.decision,
      );
      const stepStatus = Number.isInteger(currentStep) && currentStep >= 1
        ? index + 1 < currentStep
          ? "approved"
          : index + 1 === currentStep
            ? "review"
            : "pending"
        : "";
      const status = sourceStatus === "approved"
        ? "ok"
        : ["review", "reviewing", "in review", "pending"].includes(sourceStatus)
          ? "review"
          : sourceStatus === "revision"
            ? "rev"
            : sourceStatus === "rejected"
              ? "rej"
              : ["wait", "waiting"].includes(sourceStatus)
                ? "wait"
                : stepStatus === "approved"
                  ? "ok"
                  : stepStatus === "review"
                    ? "review"
                    : isOverallApproved ? "ok" : index === 0 ? "review" : "wait";
      members[stage.key] = {
        key: stage.key,
        label: stage.label,
        step: index + 1,
        status,
        note: historyEntry?.note || source?.note || "",
        updatedAt: historyEntry?.timestamp || historyEntry?.at || historyEntry?.createdAt ||
          source?.updatedAt || source?.approvedAt || null,
        approvedByName: historyEntry?.decidedByName || historyEntry?.by ||
          source?.approvedByName || source?.decidedBy || "",
      };
    });
    const hasBlockedStage = Object.values(members).some((member) =>
      ["rev", "rej"].includes(member.status),
    );
    const explicitStepComplete = Number.isInteger(currentStep) &&
      currentStep >= standardStages.length && !hasBlockedStage;
    if (explicitStepComplete) {
      standardStages.forEach((stage) => {
        members[stage.key].status = "ok";
      });
    }
    const allStagesApproved = standardStages.every((stage) => members[stage.key].status === "ok");
    const hasUnpublishedTerminalStatus = overallStatusValues.some((status) =>
      ["cancelled", "rejected", "revision"].includes(status),
    );
    const allApprovalStepsComplete = !hasUnpublishedTerminalStatus &&
      (allStagesApproved || explicitStepComplete);

    const files = {};
    (Array.isArray(event.approvalDocuments) ? event.approvalDocuments : []).forEach((file, index) => {
      files[file.id || `firestore-file-${index}`] = {
        ...file,
        id: file.id || `firestore-file-${index}`,
        name: file.name || "Attached document",
        status: file.status || "ok",
      };
    });
    if (event.adminDocuments) {
      files.adminDocuments = {
        id: "adminDocuments",
        name: "Admin documents",
        path: event.adminDocuments,
        status: "ok",
      };
    }

    const status = allApprovalStepsComplete
      ? "approved"
      : overallStatusValues.find((value) =>
      ["published", "completed", "cancelled", "rejected", "revision", "approved"].includes(value),
    ) || overallStatusValues.find(Boolean) || "pending";

    return {
      submittedAt: event.approvalSubmittedAt || event.createdAt,
      members,
      files,
      history: approvalHistory,
      currentStep: Number.isInteger(currentStep) ? currentStep : null,
      status,
    };
  }

  function formatDisplayStatus(status) {
    const norm = normalizeStatus(status);
    if (norm === "pending") return "Pending";
    if (norm === "revision") return "Needs Revision";
    if (norm === "approved") return "Approved";
    if (norm === "published") return "Published";
    if (norm === "completed") return "Completed";
    if (norm === "cancelled") return "Cancelled";
    if (norm === "rejected") return "Rejected";
    if (norm === "draft") return "Draft";
    return status || "Draft";
  }

  function getStatusClass(status) {
    const norm = normalizeStatus(status);
    if (norm === "pending") return "pending";
    if (norm === "revision") return "needs-revision";
    if (norm === "approved") return "approved";
    if (norm === "published") return "published";
    if (norm === "completed") return "completed";
    if (norm === "cancelled") return "cancelled";
    if (norm === "rejected") return "rejected";
    return norm === "draft" ? "draft" : "pending";
  }

  function normalizeDateValue(value) {
    if (value?.toDate) return value.toDate().toISOString();
    if (value instanceof Date) return value.toISOString();
    return value || "";
  }

  function getEventDate(event) {
    return normalizeDateValue(
      event.dateISO ||
        event.eventDate ||
        event.date ||
        event.dateStart ||
        event.schedule?.date ||
        event.schedule?.startDate ||
        event.startAt,
    );
  }

  function getScheduleDisplay(event) {
    const schedule = event.schedule;
    const scheduleText = typeof schedule === "string" ? schedule : "";
    const timeText = typeof event.time === "string" ? event.time : "";
    const startTime =
      event.timeStart ||
      event.startTime ||
      schedule?.timeStart ||
      schedule?.startTime ||
      schedule?.start;
    const endTime =
      event.timeEnd ||
      event.endTime ||
      schedule?.timeEnd ||
      schedule?.endTime ||
      schedule?.end;
    return (
      timeText ||
      scheduleText ||
      [startTime, endTime].filter(Boolean).join(" - ") ||
      (typeof schedule?.time === "string" ? schedule.time : "") ||
      "Time TBA"
    );
  }

  function formatDate(dateValue, fallback = "Date TBA") {
    if (!dateValue) return fallback;
    const dateText = String(dateValue);
    const date = new Date(dateText.includes("T") ? dateText : `${dateText.substring(0, 10)}T00:00:00`);
    if (Number.isNaN(date.getTime())) return fallback;
    return date.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  }

  function formatDateTime(ts) {
    if (!ts) return "";
    const value = ts?.toDate ? ts.toDate() : ts;
    const date = new Date(typeof value === "number" ? value : String(value));
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  }

  function getEffectiveStatus(event) {
    const firestoreStatuses = getEventStatusValues(event);
    const eventStatus = firestoreStatuses[0] || "";
    if (eventStatus === "draft") return "draft";

    const eventKey = String(event.eventId || event.id);
    const approval = getApprovalForEvent(event);

    const isPublished = ["published", "completed", "cancelled"].find((status) =>
      firestoreStatuses.includes(status),
    );
    if (isPublished) return isPublished;
    if ([event.published, event.isPublished, event.isLive].some(hasTrueFlag)) {
      return "published";
    }
    if (normalizeStatus(approval?.status) === "published") return "published";

    const stageEntries = Array.isArray(event.approvalStages)
      ? event.approvalStages
      : Object.values(event.approvalStages || {});
    const requiredStageStatuses = stageEntries
      .filter((stage) => !stage || typeof stage !== "object" || (stage.required !== false && stage.enabled !== false))
      .map((stage) =>
        normalizeStatus(
          typeof stage === "string"
            ? stage
            : stage?.status || stage?.approvalStatus || stage?.state || stage?.decision,
        ),
      );
    if (firestoreStatuses.includes("rejected")) return "rejected";
    if (firestoreStatuses.includes("revision")) return "revision";
    if (firestoreStatuses.includes("approved")) return "approved";
    if ([event.isApproved, event.approved].some(hasTrueFlag)) return "approved";

    const members = Object.values(approval?.members || {});
    const approvalStatus = normalizeStatus(approval?.status);
    if (approvalStatus === "rejected") return "rejected";
    if (approvalStatus === "revision") return "revision";
    if (approvalStatus === "approved") return "approved";
    if (members.length > 0 && members.every((member) => normalizeStatus(member.status) === "approved" || normalizeStatus(member.status) === "ok")) {
      return "approved";
    }
    if (requiredStageStatuses.includes("rejected")) return "rejected";
    if (requiredStageStatuses.includes("revision")) return "revision";
    if (
      requiredStageStatuses.length > 0 &&
      requiredStageStatuses.every((status) => status === "approved")
    ) {
      return "approved";
    }
    if (
      typeof isOrganizerEventHapApproved === "function" &&
      [1, 2, 3].every((stage) => isOrganizerEventHapApproved(event, stage))
    ) {
      return "approved";
    }

    return firestoreStatuses.find((status) => status === "pending") || eventStatus || "pending";
  }

  function findOrganizerEvent(eventId) {
    return organizerEvents.find((event) =>
      [event.eventId, event.id, event.sourceEventId]
        .filter((id) => id !== null && id !== undefined)
        .some((id) => String(id) === String(eventId)),
    );
  }

  function getApprovalForEvent(event) {
    const eventId = String(event?.eventId || event?.id || "");
    return firestoreApprovalsById.get(eventId) || approvalsMap.get(eventId);
  }

  function isFullyApproved(event) {
    return normalizeStatus(getEffectiveStatus(event)) === "approved";
  }

  function getFilteredEvents() {
    const query = searchInput?.value.trim().toLowerCase() || "";
    const selectedDate = dateFilter?.value || "all";
    const currentDate = new Date();
    currentDate.setHours(0, 0, 0, 0);

    return organizerEvents.filter((event) => {
      const searchableText = `${event.title || event.eventName || event.name || ""} ${event.location || event.venue || ""} ${event.category || ""}`.toLowerCase();
      const eventDateValue = getEventDate(event);
      const eventDate = eventDateValue
        ? new Date(`${String(eventDateValue).substring(0, 10)}T00:00:00`)
        : null;

      const matchesSearch = !query || searchableText.includes(query);
      const matchesDate =
        selectedDate === "all" ||
        (eventDate &&
          !Number.isNaN(eventDate.getTime()) &&
          (selectedDate === "upcoming" ? eventDate >= currentDate : eventDate < currentDate));

      return matchesSearch && matchesDate;
    });
  }

  function renderStatistics(events) {
    const total = events.length;
    let pending = 0;
    let approved = 0;
    let needsRevision = 0;

    events.forEach((ev) => {
      const st = normalizeStatus(getEffectiveStatus(ev));
      if (st === "pending") pending++;
      if (["approved", "published"].includes(st)) approved++;
      if (st === "revision") needsRevision++;
    });

    const totalEl = document.getElementById("totalEventsCount");
    const pendingEl = document.getElementById("pendingEventsCount");
    const approvedEl = document.getElementById("approvedEventsCount");
    const revisionEl = document.getElementById("needsRevisionCount");

    if (totalEl) totalEl.textContent = total;
    if (pendingEl) pendingEl.textContent = pending;
    if (approvedEl) approvedEl.textContent = approved;
    if (revisionEl) revisionEl.textContent = needsRevision;
  }

  /**
   * Build the Approval column bar and status line (Task 1)
   */
  function buildApprovalColumnMarkup(event) {
    const eventId = String(event.eventId || event.id);
    const approval = getApprovalForEvent(event);
    const effStatus = normalizeStatus(getEffectiveStatus(event));

    if (effStatus === "cancelled") {
      return `
        <div class="approval-progress-wrap">
          <div class="approval-bar">
            <span class="approval-segment is-rejected" style="background:#a8a29e;"></span>
          </div>
          <span class="approval-text">Cancelled</span>
        </div>`;
    }

    if (!approval || !approval.members) {
      const step = Number(event.approvalCurrentStep);
      const complete = ["approved", "published", "completed"].includes(effStatus) ||
        (Number.isInteger(step) && step >= 4);
      const waitingStep = Number.isInteger(step) && step >= 1 && step < 4 ? step : 1;
      const fallbackStages = [
        "Organization Adviser",
        "Laboratory Head, Property Custodian, Administrative Officer",
        "Head of Academic Programs, QAC Coordinator",
        "OSAS",
      ];
      const segmentsMarkup = fallbackStages.map((label, index) => {
        const segmentClass = complete || index + 1 < waitingStep
          ? "is-approved"
          : index + 1 === waitingStep
            ? effStatus === "revision"
              ? "is-revision"
              : effStatus === "rejected"
                ? "is-rejected"
                : "is-current"
            : "is-waiting";
        return `<span class="approval-segment ${segmentClass}" title="Step ${index + 1} of 4: ${escapeHtml(label)}" aria-hidden="true"></span>`;
      }).join("");
      const approvalText = complete
        ? "All 4 steps approved"
        : effStatus === "revision"
          ? "Changes requested"
          : effStatus === "rejected"
            ? "Rejected"
            : `Step ${waitingStep} of 4: ${escapeHtml(fallbackStages[waitingStep - 1])}`;
      return `
        <div class="approval-progress-wrap">
          <div class="approval-bar" role="img" aria-label="${escapeHtml(approvalText)}">${segmentsMarkup}</div>
          <span class="approval-text">${escapeHtml(approvalText)}</span>
        </div>`;
    }

    const membersList = Object.values(approval.members)
      .sort((a, b) => (a.step || 0) - (b.step || 0))
      .slice(0, 4);
    const totalSteps = 4;

    let currentReviewer = null;
    let revisionRequester = null;
    let rejecter = null;
    let allApproved = true;

    const segmentsMarkup = Array.from({ length: totalSteps }, (_, index) => {
      const member = membersList.find((item) => item.step === index + 1);
      if (!member) {
        allApproved = false;
        return '<span class="approval-segment is-waiting" aria-hidden="true"></span>';
      }

      let segmentClass = "is-waiting";
      if (member.status === "ok") {
        segmentClass = "is-approved";
      } else if (member.status === "review") {
        segmentClass = "is-current";
        if (!currentReviewer) currentReviewer = member;
        allApproved = false;
      } else if (member.status === "rev") {
        segmentClass = "is-revision";
        if (!revisionRequester) revisionRequester = member;
        allApproved = false;
      } else if (member.status === "rej") {
        segmentClass = "is-rejected";
        if (!rejecter) rejecter = member;
        allApproved = false;
      } else {
        allApproved = false;
      }
      return `<span class="approval-segment ${segmentClass}" title="Step ${member.step} of ${totalSteps}: ${escapeHtml(member.label)} (${member.status})" aria-label="Step ${member.step} of ${totalSteps}: ${escapeHtml(member.label)}, ${escapeHtml(member.status)}"></span>`;
    })
      .join("");

    let statusLineText = "";
    if (rejecter) {
      statusLineText = `Rejected by ${escapeHtml(rejecter.label || "Reviewer")}`;
    } else if (revisionRequester || effStatus === "revision") {
      const who = revisionRequester ? revisionRequester.label : "Approver";
      statusLineText = `Changes requested by ${escapeHtml(who)}`;
    } else if (allApproved || effStatus === "approved" || effStatus === "published" || effStatus === "completed") {
      statusLineText = `All ${totalSteps} steps approved`;
    } else if (currentReviewer) {
      statusLineText = `Step ${currentReviewer.step} of ${totalSteps}: ${escapeHtml(currentReviewer.label)}`;
    } else {
      const nextStep = membersList.find((member) => member.status === "wait");
      statusLineText = nextStep
        ? `Step ${nextStep.step} of ${totalSteps}: ${escapeHtml(nextStep.label)}`
        : "Approval progress unavailable";
    }

    return `
      <div class="approval-progress-wrap">
        <div class="approval-bar" role="img" aria-label="${escapeHtml(statusLineText)}">
          ${segmentsMarkup}
        </div>
        <span class="approval-text">${statusLineText}</span>
      </div>`;
  }

  function getActionMarkup(event) {
    const eventId = escapeHtml(event.eventId || event.id);
    const effStatus = normalizeStatus(getEffectiveStatus(event));
    const isApproved = isFullyApproved(event);
    const isPublished = effStatus === "published";
    const isCompleted = effStatus === "completed";
    const isCancelled = effStatus === "cancelled";
    const scanParams = new URLSearchParams({
      eventId: String(event.eventId || event.id),
      eventName: String(event.title || event.eventName || event.name || "Untitled Event"),
      eventDate: String(getEventDate(event) || ""),
      eventTime: String(getScheduleDisplay(event) || ""),
      eventVenue: String(event.venue || event.location || "Venue TBA"),
    });

    return `
      <div class="event-actions">
        <button type="button" class="event-action" data-action="view" data-event-id="${eventId}">
          View
        </button>
        ${
          !isPublished && !isCompleted && !isCancelled
            ? `
          ${
            isApproved
              ? `<button
            type="button"
            class="event-action event-action-primary"
            data-action="publish"
            data-event-id="${eventId}"
            title="Publish this event to students"
          >
            Publish
          </button>`
              : ""
          }
          <button type="button" class="event-action event-action-danger" data-action="cancel" data-event-id="${eventId}">
            Cancel
          </button>
        `
            : ""
        }
        ${
          isPublished || isCompleted
            ? `
          <a class="event-action" href="EventOrganizerScanAttendance.html?${scanParams.toString()}">
            Scan attendance
          </a>
        `
            : ""
        }
      </div>`;
  }

  function renderEmptyState() {
    if (authResolving) {
      if (eventTableBody) {
        eventTableBody.innerHTML = `
          <tr>
            <td colspan="5"><div class="event-table-empty"><span>Checking authentication…</span></div></td>
          </tr>`;
      }
      return;
    }

    if (authUnauthenticated) {
      if (eventTableBody) {
        eventTableBody.innerHTML = `
          <tr>
            <td colspan="5">
              <div class="event-table-empty">
                <strong>Please log in as an Event Organizer.</strong>
                <span>You need an active organizer session to view your event submissions.</span>
                <a class="organizer-button" href="EventOrganizerLogin.html">Go to Login</a>
              </div>
            </td>
          </tr>`;
      }
      return;
    }

    const loadingEvents =
      !firestoreEventsLoaded ||
      (realtimeDatabaseConfigured && (!indexLoaded || !draftsLoaded));
    if (loadingEvents && !loadErrorOccurred) {
      if (eventTableBody) {
        eventTableBody.innerHTML = `
          <tr>
            <td colspan="5"><div class="event-table-empty"><span>Loading your event submissions…</span></div></td>
          </tr>`;
      }
      return;
    }

    if (loadErrorOccurred) {
      if (eventTableBody) {
        eventTableBody.innerHTML = `
          <tr>
            <td colspan="5">
              <div class="event-table-empty">
                <strong>Couldn't load your events</strong>
                <span>There was a problem loading your event submissions.</span>
                <button type="button" class="organizer-button" id="btnTryAgain">Try again</button>
              </div>
            </td>
          </tr>`;
      }
      return;
    }

    const hasEvents = organizerEvents.length > 0;
    const heading = !hasEvents
      ? "You haven't created any events yet."
      : "No events match your filters.";
    const message = hasEvents
      ? "Try changing or clearing your search or filters."
      : "Click '+ Create Event' to submit your first event proposal.";

    if (eventTableBody) {
      eventTableBody.innerHTML = `
        <tr>
          <td colspan="5">
            <div class="event-table-empty">
              <strong>${escapeHtml(heading)}</strong>
              <span>${escapeHtml(message)}</span>
              ${!hasEvents ? '<a class="organizer-button" href="EventOrganizerCreateEvent.html">+ Create Event</a>' : ""}
            </div>
          </td>
        </tr>`;
    }
  }

  function renderEvents() {
    const allEvents = organizerEvents;
    const filtered = getFilteredEvents();

    renderStatistics(allEvents);
    if (eventResultsCount) {
      eventResultsCount.textContent = `Showing ${filtered.length} of ${allEvents.length} events`;
    }

    if (!filtered.length) {
      renderEmptyState();
      return;
    }

    if (eventTableBody) {
      eventTableBody.innerHTML = filtered
        .map((event) => {
          const eventId = escapeHtml(event.eventId || event.id);
          const effStatus = getEffectiveStatus(event);
          const statusDisplay = formatDisplayStatus(effStatus);
          const statusClass = getStatusClass(effStatus);
          const eventDate = getEventDate(event);
          const schedule = getScheduleDisplay(event);
          const category = event.category || "Academic & Learning";

          const isDraft = normalizeStatus(event.status) === "draft";
          const canPublish = effStatus === "approved";
          const canDeleteEvent = !getEventStatusValues(event)
            .some((status) => ["pending", "published"].includes(status)) &&
            !["pending", "published"].includes(normalizeStatus(effStatus));
          const showAttendanceAction = ["published", "completed"].includes(
            normalizeStatus(effStatus),
          );
          const scanParams = new URLSearchParams({
            eventId: String(event.eventId || event.id),
            eventName: String(event.title || event.eventName || event.name || "Untitled Event"),
            eventDate: String(eventDate || ""),
            eventTime: String(schedule || ""),
            eventVenue: String(event.venue || event.location || "Venue TBA"),
          });
          return `
            <tr data-event-id="${eventId}" data-draft="${String(isDraft)}"${new URLSearchParams(location.search).get("new") === String(eventId) ? ' class="new-event-highlight"' : ""}>
              <td data-label="Event">
                <strong>${escapeHtml(event.title || event.eventName || event.name || "Untitled Event")}</strong>
                <small class="event-category-badge">${escapeHtml(category)}</small>
              </td>
              <td data-label="Approval progress">${isDraft ? '<span class="event-approval-progress">Not submitted</span>' : buildApprovalColumnMarkup(event)}</td>
              <td data-label="Date &amp; time">
                ${escapeHtml(formatDate(eventDate))}
                <small>${escapeHtml(event.venue || event.location || "Venue TBA")}</small>
                <small>${escapeHtml(schedule)}</small>
              </td>
              <td data-label="Status">
                <span class="organizer-status ${statusClass}" aria-label="Status: ${escapeHtml(statusDisplay)}">
                  ${escapeHtml(statusDisplay)}
                </span>
              </td>
              <td data-label="Actions">
                ${event.firestoreSubmission
                  ? `<div class="event-actions"><button type="button" class="event-action" data-action="view" data-event-id="${eventId}">View tracker</button>${canPublish ? `<button type="button" class="event-action event-action-primary" data-action="publish" data-event-id="${eventId}" title="Publish this event to students">Publish</button>` : ""}${showAttendanceAction ? `<a class="event-action" href="EventOrganizerScanAttendance.html?${scanParams.toString()}">Scan attendance</a>` : ""}${canDeleteEvent ? `<button type="button" class="event-action event-action-danger" data-action="delete-event" data-event-id="${eventId}">Delete</button>` : ""}</div>`
                  : isDraft
                    ? `<div class="event-actions"><a class="event-action" href="EventOrganizerCreateEvent.html?draft=${eventId}">Continue editing</a><button type="button" class="event-action event-action-danger" data-action="delete-draft" data-event-id="${eventId}">Delete</button></div>`
                    : getActionMarkup(event)}
              </td>
            </tr>`;
        })
        .join("");
    }
  }

  /* --------------------------------------------------------------------------
     TASK 2: APPROVAL TRACKER MODAL LOGIC
     -------------------------------------------------------------------------- */

  function openApprovalTracker(eventId) {
    const event = findOrganizerEvent(eventId);
    if (!event) return;

    const activeEventId = String(event.eventId || event.id);
    activeTrackingEventId = activeEventId;
    const approval = getApprovalForEvent(event) || buildFirestoreApproval(event);

    if (trackerSubmittedDate) {
      const subDate = approval.submittedAt || event.createdAt;
      trackerSubmittedDate.textContent = `Submitted ${formatDate(subDate)}`;
    }

    renderTrackerContent(event, approval);

    if (trackerModalOverlay) {
      trackerModalOverlay.hidden = false;
      trackerModalOverlay.removeAttribute("aria-hidden");
      document.body.style.overflow = "hidden";
    }
  }

  function closeApprovalTracker() {
    activeTrackingEventId = null;
    activeReplacingFileId = null;
    if (trackerModalOverlay) {
      trackerModalOverlay.hidden = true;
      trackerModalOverlay.setAttribute("aria-hidden", "true");
      document.body.style.overflow = "";
    }
  }

  function renderTrackerContent(event, approval) {
    const members = approval.members || {};
    const membersList = Object.values(members).sort((a, b) => (a.step || 0) - (b.step || 0));
    const files = approval.files || {};
    const history = Array.isArray(approval.history) ? approval.history : Object.values(approval.history || {});
    const effStatus = normalizeStatus(getEffectiveStatus(event));

    // 1. Horizontal Timeline Track
    let hasEncounteredReview = false;
    let anyChangesRequested = membersList.some((m) => m.status === "rev");

    const stepsMarkup = membersList
      .map((member, index) => {
        const isOk = member.status === "ok";
        const isReview = member.status === "review";
        const isRev = member.status === "rev";
        const isRej = member.status === "rej";
        const isPaused = anyChangesRequested && member.status === "wait";

        let dotClass = "is-wait";
        let dotContent = "—";
        let statusText = "Waiting";

        if (isOk) {
          dotClass = "is-ok";
          dotContent = `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.5" width="14" height="14"><polyline points="4 10 8 14 16 6"/></svg>`;
          statusText = member.updatedAt ? `Approved ${formatDate(member.updatedAt)}` : "Approved";
        } else if (isReview) {
          dotClass = "is-review";
          dotContent = `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><circle cx="10" cy="10" r="7"/><polyline points="10 6 10 10 13 12"/></svg>`;
          statusText = "In review";
        } else if (isRev) {
          dotClass = "is-rev";
          dotContent = `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M12 4l4 4L6 18H2v-4L12 4z"/></svg>`;
          statusText = "Asked for changes";
        } else if (isRej) {
          dotClass = "is-rej";
          dotContent = `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.5" width="14" height="14"><line x1="5" y1="5" x2="15" y2="15"/><line x1="15" y1="5" x2="5" y2="15"/></svg>`;
          statusText = "Rejected";
        } else if (isPaused) {
          dotClass = "is-wait";
          statusText = "Paused";
        }

        const isLineFinished = isOk;
        const isActive = isReview || isRev;

        return `
          <div class="timeline-step ${isActive ? "is-active" : ""}" id="trackerStep-${member.key || index}">
            <div class="timeline-line-connector ${isLineFinished ? "is-finished" : ""}"></div>
            <div class="timeline-dot ${dotClass}">
              ${dotContent}
            </div>
            <div class="timeline-content-col">
              <span class="timeline-step-tag">STEP ${member.step || index + 1}</span>
              <strong class="timeline-step-name">${escapeHtml(member.label)}</strong>
              <span class="timeline-step-status">${escapeHtml(statusText)}</span>
            </div>
          </div>`;
      })
      .join("");

    const allFinished = membersList.length > 0 && membersList.every((m) => m.status === "ok");

    if (trackerTimeline) {
      trackerTimeline.innerHTML = `
        <div class="timeline-step">
          <div class="timeline-line-connector is-finished"></div>
          <div class="timeline-dot is-ok">
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.5" width="14" height="14"><polyline points="4 10 8 14 16 6"/></svg>
          </div>
          <div class="timeline-content-col">
            <span class="timeline-step-tag">Start</span>
            <strong class="timeline-step-name">Submitted</strong>
            <span class="timeline-step-status">${formatDate(approval.submittedAt || event.createdAt)}</span>
          </div>
        </div>
        ${stepsMarkup}
        <div class="timeline-step">
          <div class="timeline-dot ${allFinished ? "is-ok" : "is-wait"}">
            ${allFinished ? '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.5" width="14" height="14"><polyline points="4 10 8 14 16 6"/></svg>' : "—"}
          </div>
          <div class="timeline-content-col">
            <span class="timeline-step-tag">End</span>
            <strong class="timeline-step-name">Finish</strong>
            <span class="timeline-step-status">${allFinished ? "Approved" : "Pending"}</span>
          </div>
        </div>
      `;

      // Auto-scroll the active step into view
      requestAnimationFrame(() => {
        const activeNode = trackerTimeline.querySelector(".timeline-step.is-active");
        if (activeNode) {
          activeNode.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
        }
      });
    }

    // 2. Notes List & Next Line
    let currentActiveMember = membersList.find((m) => m.status === "review" || m.status === "rev");
    let nextMember = null;
    if (currentActiveMember) {
      const activeIdx = membersList.indexOf(currentActiveMember);
      if (activeIdx >= 0 && activeIdx + 1 < membersList.length) {
        nextMember = membersList[activeIdx + 1];
      }
    }

    const notesMarkup = membersList
      .map((member) => {
        const status = member.status || "wait";
        const statusDetails = {
          ok: { label: "Approved", icon: "✓", className: "is-approved" },
          review: { label: "Reviewing now", icon: "◷", className: "is-reviewing" },
          rev: { label: "Changes requested", icon: "!", className: "is-revision" },
          rej: { label: "Rejected", icon: "×", className: "is-rejected" },
          wait: { label: "Waiting", icon: "–", className: "is-waiting" },
        }[status] || { label: "Waiting", icon: "–", className: "is-waiting" };
        const timestamp = status !== "wait" && member.updatedAt
          ? formatDateTime(member.updatedAt)
          : status === "wait" ? "Not started" : "";
        let detail = status === "ok" && member.approvedByName
          ? `Approved by ${member.approvedByName}.`
          : member.note || statusDetails.label;
        if (status === "rev" && !detail.toLowerCase().includes("change")) {
          detail = `Changes requested: ${detail}`;
        }

        return `
          <article class="tracker-note-item ${statusDetails.className}">
            <div class="tracker-note-avatar" aria-hidden="true">${statusDetails.icon}</div>
            <div class="tracker-note-body">
              <div class="tracker-note-header">
                <span class="tracker-note-title">Step ${member.step} · ${escapeHtml(member.label)}</span>
                <span class="tracker-note-date">${escapeHtml(timestamp)}</span>
              </div>
              <p class="tracker-note-text">${escapeHtml(detail)}</p>
            </div>
          </article>`;
      })
      .join("");

    if (trackerNotesList) {
      trackerNotesList.innerHTML = notesMarkup || `<p class="tracker-note-text">No approval stages are configured.</p>`;
    }

    const historyEntries = history
      .filter((entry) => entry && typeof entry === "object")
      .map((entry, index) => ({ ...entry, _index: index }))
      .sort((first, second) => {
        const firstValue = first.timestamp || first.at || first.createdAt || 0;
        const secondValue = second.timestamp || second.at || second.createdAt || 0;
        const firstAt = new Date(firstValue?.toDate ? firstValue.toDate() : firstValue).getTime() || 0;
        const secondAt = new Date(secondValue?.toDate ? secondValue.toDate() : secondValue).getTime() || 0;
        return firstAt - secondAt || first._index - second._index;
      });
    if (trackerHistoryList) {
      trackerHistoryList.innerHTML = historyEntries.length
        ? historyEntries.map((entry) => `
            <article class="tracker-history-item">
              <div class="tracker-history-marker" aria-hidden="true"></div>
              <div class="tracker-history-body">
                <div class="tracker-note-header">
                  <span class="tracker-note-title">${escapeHtml(entry.stageLabel || entry.label || entry.action || entry.stage || "Proposal update")}</span>
                  <span class="tracker-note-date">${escapeHtml(formatDateTime(entry.timestamp || entry.at || entry.createdAt))}</span>
                </div>
                <p class="tracker-note-text">${escapeHtml(entry.note || entry.decision || entry.decidedByName || entry.by || "Status updated.")}</p>
              </div>
            </article>`)
          .join("")
        : `<p class="tracker-note-text">No approval history yet.</p>`;
    }

    if (trackerNextLine) {
      if (nextMember) {
        trackerNextLine.hidden = false;
        trackerNextLine.textContent = `Next: ${nextMember.label}`;
      } else if (allFinished) {
        trackerNextLine.hidden = false;
        trackerNextLine.textContent = "All approvers have signed off. The event is ready to publish!";
      } else {
        trackerNextLine.hidden = true;
      }
    }

    // 3. Documents List
    const filesList = Object.values(files);
    let hasUnreplacedFiles = false;

    if (trackerDocsList) {
      if (filesList.length === 0) {
        trackerDocsList.innerHTML = `<p style="font-size:13px; color:#78716c; margin:0;">No attached documents.</p>`;
      } else {
        trackerDocsList.innerHTML = filesList
          .map((f) => {
            const isFlagged = f.status === "rev";
            if (isFlagged) hasUnreplacedFiles = true;
            return `
              <div class="tracker-doc-item ${isFlagged ? "is-flagged" : ""}">
                <div class="tracker-doc-left">
                  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" width="18" height="18" style="color:var(--maroon);">
                    <path d="M4 3h8l4 4v10H4z"/>
                    <path d="M12 3v4h4"/>
                  </svg>
                  <div>
                    <div class="tracker-doc-name">${escapeHtml(f.name || "Attachment")}</div>
                    <div class="tracker-doc-note">
                      ${isFlagged ? `Changes requested: ${escapeHtml(f.note || "Please upload a corrected version.")}` : "No changes requested"}
                    </div>
                  </div>
                </div>
                <div class="tracker-doc-right">
                  ${
                    isFlagged
                      ? `<button type="button" class="tracker-btn-replace" data-file-id="${escapeHtml(f.id)}">Replace link</button>`
                      : '<span style="font-size:12px; color:#16a34a; font-weight:600;">✓ Ready</span>'
                  }
                </div>
              </div>`;
          })
          .join("");
      }
    }

    // 4. Action Buttons State
    const activeReviewers = membersList.filter((m) => m.status === "review");
    if (btnTrackerRemind) {
      if (activeReviewers.length > 1) {
        btnTrackerRemind.textContent = `Remind ${activeReviewers.length} approvers`;
        btnTrackerRemind.disabled = false;
      } else if (activeReviewers.length === 1) {
        btnTrackerRemind.textContent = `Remind ${activeReviewers[0].label}`;
        btnTrackerRemind.disabled = false;
      } else {
        btnTrackerRemind.textContent = "Remind Approver";
        btnTrackerRemind.disabled = true;
      }
    }

    if (btnTrackerResubmit) {
      const isRevisionState = ["revision", "rejected"].includes(effStatus) || anyChangesRequested;
      btnTrackerResubmit.disabled = !isRevisionState || hasUnreplacedFiles;
      if (hasUnreplacedFiles) {
        btnTrackerResubmit.title = "Please replace every requested document before resubmitting.";
      } else {
        btnTrackerResubmit.title = "Resubmit proposal for review";
      }
    }

    if (btnTrackerPublish) {
      const canPublish = isFullyApproved(event);
      btnTrackerPublish.disabled = !canPublish;
      if (!canPublish) {
        btnTrackerPublish.title = "Publish unlocks after every approver signs off.";
      } else {
        btnTrackerPublish.title = "Publish this event to students";
      }
    }
  }

  /* --------------------------------------------------------------------------
     ACTION HANDLERS & FUNCTION CALLS
     -------------------------------------------------------------------------- */

  async function handlePublishEvent(eventId) {
    const event = findOrganizerEvent(eventId);
    if (!event) {
      window.alert("This event is no longer available. Refresh your submissions and try again.");
      return;
    }
    const effStatus = normalizeStatus(getEffectiveStatus(event));
    if (!isFullyApproved(event) && effStatus !== "published") {
      window.alert("Publish unlocks after every approver signs off.");
      return;
    }

    if (effStatus === "published" || normalizeStatus(event?.status) === "published") {
      window.alert("This event has already been published.");
      return;
    }

    const confirmed = window.confirm("Publish this event now? It will become publicly available for students to register.");
    if (!confirmed) return;

    try {
      const activeUser = auth?.currentUser;
      const activeEventId = String(event.eventId || event.id);
      if (!db || !activeUser || activeUser.uid !== organizerId) {
        throw new Error("Your sign-in session is unavailable. Please sign in again and retry.");
      }

      const eventRef = doc(db, "events", activeEventId);
      const latestSnapshot = await getDoc(eventRef);
      if (!latestSnapshot.exists()) {
        throw new Error("This event is no longer available. Refresh your submissions and try again.");
      }

      const latestEvent = {
        ...event,
        ...latestSnapshot.data(),
        id: activeEventId,
        eventId: activeEventId,
      };
      if (!isFullyApproved(latestEvent)) {
        throw new Error("Publish unlocks after every approver signs off.");
      }

      const publishedAt = Date.now();
      let orgCode = String(
        latestEvent.organizationCode ||
        latestEvent.organizerOrganization ||
        latestEvent.orgCode ||
        latestEvent.organization ||
        latestEvent.organizer ||
        ""
      ).trim().toUpperCase();

      if (!orgCode) {
        try {
          const orgProfileSnap = await getDoc(doc(db, "adminUser", activeUser.uid));
          if (orgProfileSnap.exists()) {
            const orgData = orgProfileSnap.data();
            orgCode = String(
              orgData.organizationCode ||
              orgData.orgCode ||
              orgData.organization ||
              orgData.organizationName ||
              ""
            ).trim().toUpperCase();
          }
        } catch (orgErr) {
          console.warn("[My Events] Could not fetch organizer profile for organizationCode:", orgErr);
        }
      }

      const updatePayload = {
        status: "published",
        approvalStatus: "approved",
        publicationStatus: "published",
        published: true,
        isPublished: true,
        publishedAt,
        updatedAt: publishedAt,
      };

      if (orgCode) {
        updatePayload.organizationCode = orgCode;
        updatePayload.organizerOrganization = orgCode;
        updatePayload.targetOrganization = latestEvent.targetOrganization || orgCode;
        updatePayload.targetOrganizations = Array.isArray(latestEvent.targetOrganizations) && latestEvent.targetOrganizations.length > 0
          ? latestEvent.targetOrganizations
          : [orgCode];
      }

      if (!latestEvent.targetAudience) {
        updatePayload.targetAudience = "Organization Members Only";
      }

      await updateDoc(eventRef, updatePayload);

      Object.assign(event, {
        ...updatePayload,
      });
      const approval = getApprovalForEvent(event);
      if (approval) {
        approval.status = "published";
      }
      renderEvents();
      if (activeTrackingEventId === activeEventId) {
        renderTrackerContent(event, approval);
      }
      window.alert("Event published successfully!");
    } catch (err) {
      console.error("Publish error:", err);
      const message =
        err?.code === "permission-denied"
          ? "You don't have permission to publish this event. Refresh the page and sign in again."
          : err.message || "Could not publish event. Please ensure all approvers have signed off.";
      window.alert(message);
    }
  }

  async function handleDeleteEvent(requestedEventId) {
    const event = findOrganizerEvent(requestedEventId);
    const activeUser = auth?.currentUser;
    if (!event || !event.firestoreSubmission || !firestoreDb || !activeUser ||
        activeUser.uid !== organizerId || String(event.organizerUid || "") !== activeUser.uid) {
      showEventNotice("Couldn't verify that you own this event. Refresh the page and try again.");
      return;
    }
    if (!window.confirm("Delete this event? This cannot be undone.")) return;

    const eventId = String(event.eventId || event.id);
    deletedFirestoreEventIds.add(eventId);
    organizerEvents = organizerEvents.filter((item) =>
      String(item.eventId || item.id) !== eventId,
    );
    if (activeTrackingEventId === eventId) closeApprovalTracker();
    renderEvents();

    try {
      const eventRef = doc(firestoreDb, "events", eventId);
      const latestSnapshot = await getDoc(eventRef);
      if (!latestSnapshot.exists()) {
        throw new Error("This event is no longer available.");
      }
      const latestEvent = latestSnapshot.data();
      const isOwner = [latestEvent.organizerUid, latestEvent.organizerId, latestEvent.createdBy]
        .some((ownerId) => String(ownerId || "") === activeUser.uid);
      if (!isOwner) {
        throw new Error("You don't have permission to delete this event.");
      }
      if (auth?.currentUser?.uid !== activeUser.uid || organizerId !== activeUser.uid) {
        throw new Error("Your sign-in session changed. Please refresh and try again.");
      }

      await deleteDoc(doc(firestoreDb, "events", eventId));
      firestoreEventsById.delete(eventId);
      firestoreApprovalsById.delete(eventId);
      showEventNotice("Event deleted.");
      renderOwnedEvents();
    } catch (error) {
      console.error("Could not delete event:", error);
      deletedFirestoreEventIds.delete(eventId);
      renderOwnedEvents();
      const message = error?.code === "permission-denied"
        ? "You don't have permission to delete this event."
        : error?.message || "Couldn't delete this event. Please try again.";
      showEventNotice(message);
    }
  }

  async function getOwnedFirestoreEvent(eventId) {
    const event = findOrganizerEvent(eventId);
    const activeUser = auth?.currentUser;
    if (!event || !event.firestoreSubmission || !firestoreDb || !activeUser ||
        activeUser.uid !== organizerId) {
      throw new Error("Couldn't verify that you own this event. Refresh the page and try again.");
    }

    const activeEventId = String(event.eventId || event.id);
    const eventRef = doc(firestoreDb, "events", activeEventId);
    const snapshot = await getDoc(eventRef);
    if (!snapshot.exists()) {
      throw new Error("This event is no longer available.");
    }
    const latestEvent = snapshot.data();
    const isOwner = [latestEvent.organizerUid, latestEvent.organizerId, latestEvent.createdBy]
      .some((ownerId) => String(ownerId || "") === activeUser.uid);
    if (!isOwner) {
      throw new Error("You don't have permission to update this event.");
    }
    if (auth?.currentUser?.uid !== activeUser.uid || organizerId !== activeUser.uid) {
      throw new Error("Your sign-in session changed. Please refresh and try again.");
    }

    return { event, eventRef, latestEvent, activeUser, activeEventId };
  }

  async function handleCancelEvent(eventId) {
    const event = findOrganizerEvent(eventId);
    if (!event) {
      window.alert("This event is no longer available. Refresh your submissions and try again.");
      return;
    }
    if (!window.confirm("Are you sure you want to cancel this event proposal?")) return;

    try {
      let activeEventId;
      if (event.firestoreSubmission) {
        const ownedEvent = await getOwnedFirestoreEvent(eventId);
        const { eventRef, latestEvent, activeUser } = ownedEvent;
        activeEventId = ownedEvent.activeEventId;
        if (normalizeStatus(latestEvent.status) === "completed") {
          throw new Error("Completed events cannot be cancelled.");
        }

        const now = Date.now();
        await updateDoc(eventRef, {
          status: "cancelled",
          approvalStatus: "cancelled",
          cancelledAt: now,
          updatedAt: now,
          approvalHistory: arrayUnion({
            action: "cancelled",
            by: activeUser.displayName || activeUser.email || "Event Organizer",
            at: now,
            note: "Cancelled by organizer.",
          }),
        });
        event.status = "cancelled";
        event.approvalStatus = "cancelled";
      } else {
        if (!functions) throw new Error("The cancellation service is unavailable. Try again later.");
        await httpsCallable(functions, "cancelEvent")({
          eventId,
          reason: "Cancelled by organizer.",
        });
        event.status = "cancelled";
        activeEventId = String(event.eventId || event.id);
      }

      const approval = getApprovalForEvent(event);
      if (approval) approval.status = "cancelled";
      renderEvents();
      if (String(activeTrackingEventId) === activeEventId) closeApprovalTracker();
      window.alert("Event proposal has been cancelled.");
    } catch (err) {
      console.error("Cancel event error:", err);
      window.alert(err.message || "Could not cancel event.");
    }
  }

  async function handleResubmitEvent(eventId) {
    const event = findOrganizerEvent(eventId);
    if (!event) {
      window.alert("This event is no longer available. Refresh your submissions and try again.");
      return;
    }
    if (!window.confirm("Review and update this proposal before submitting it again? Your existing proposal will remain unchanged.")) return;

    try {
      const { latestEvent, activeUser } = event.firestoreSubmission
        ? await getOwnedFirestoreEvent(eventId)
        : { latestEvent: event, activeUser: auth?.currentUser };
      if (!activeUser || activeUser.uid !== organizerId) {
        throw new Error("Your sign-in session is unavailable. Please sign in again and retry.");
      }

      const eventToEdit = {
        ...latestEvent,
        id: String(event.eventId || event.id),
        eventId: String(event.eventId || event.id),
        organizerId: activeUser.uid,
        organizerUid: activeUser.uid,
        createdBy: activeUser.uid,
        participantDocuments: [
          latestEvent.participantDocuments,
          latestEvent.attachments,
          Array.isArray(latestEvent.approvalDocuments)
            ? latestEvent.approvalDocuments
            : [],
        ].find((documents) => Array.isArray(documents) && documents.length)
          ?.map((document) => document && typeof document === "object"
            ? {
                ...document,
                url: document.url || document.href || document.path ||
                  document.downloadURL || document.downloadUrl || document.fileUrl || "",
              }
            : document) || [],
        partnerOrganizations: Array.isArray(latestEvent.partnerOrganizations) &&
          latestEvent.partnerOrganizations.length
          ? latestEvent.partnerOrganizations
          : (Array.isArray(latestEvent.targetOrganizations)
            ? latestEvent.targetOrganizations.map((organization) =>
                typeof organization === "string"
                  ? { id: organization, name: organization }
                  : organization,
              )
            : []),
      };
      sessionStorage.setItem("recovibeProposalResubmit", JSON.stringify(eventToEdit));
      window.location.href = `EventOrganizerCreateEvent.html?resubmit=${encodeURIComponent(eventToEdit.eventId)}`;
    } catch (err) {
      console.error("Could not prepare proposal for resubmission:", err);
      window.alert(err.message || "Could not prepare this proposal for resubmission.");
    }
  }

  async function handleRemindApprovers(eventId) {
    try {
      const event = findOrganizerEvent(eventId);
      if (!event) throw new Error("This event is no longer available. Refresh your submissions and try again.");
      let eventRef = null;
      let activeUser = null;
      let approval;
      if (event.firestoreSubmission) {
        const ownedEvent = await getOwnedFirestoreEvent(eventId);
        eventRef = ownedEvent.eventRef;
        activeUser = ownedEvent.activeUser;
        approval = buildFirestoreApproval(ownedEvent.latestEvent);
      } else {
        approval = getApprovalForEvent(event) || buildFirestoreApproval(event);
      }
      const activeReviewers = Object.values(approval.members || {})
        .filter((member) => member.status === "review");
      if (!activeReviewers.length) {
        window.alert("There are no active approvers to remind right now.");
        return;
      }

      const reviewerNames = activeReviewers.map((member) => member.label).join(", ");
      if (!window.confirm(`Send a reminder to ${reviewerNames}?`)) return;

      const now = Date.now();
      if (eventRef) {
        await updateDoc(eventRef, {
          updatedAt: now,
          approvalHistory: arrayUnion({
            action: "reminded",
            by: activeUser.displayName || activeUser.email || "Event Organizer",
            at: now,
            note: `Reminder sent to ${reviewerNames}.`,
            targetApprovers: activeReviewers.map(({ key, label }) => ({ key, label })),
          }),
        });
      } else {
        if (!functions) throw new Error("The reminder service is unavailable. Try again later.");
        await httpsCallable(functions, "remindApprovers")({
          eventId,
          keys: activeReviewers.map(({ key }) => key),
        });
      }
      window.alert(`Reminder logged for ${reviewerNames}.`);
    } catch (err) {
      console.error("Could not log approver reminder:", err);
      window.alert(err.message || "Could not send the approver reminder.");
    }
  }

  async function handleReplaceFile(eventId, fileId, driveUrl) {
    if (!isGoogleDriveLink(driveUrl)) {
      throw new Error("Provide a valid Google Drive link.");
    }
    try {
      const event = organizerEvents.find((item) => String(item.eventId || item.id) === String(eventId));
      if (!event) throw new Error("This event is no longer available.");
      const approval = getApprovalForEvent(event);
      const currentFile = approval?.files?.[fileId];
      if (!currentFile) throw new Error("This approval document could not be found.");
      const fileName = currentFile.name || "Attached document";
      if (functions) {
        const replaceFn = httpsCallable(functions, "replaceFile");
        await replaceFn({
          eventId,
          fileId,
          path: driveUrl,
          name: fileName,
        });
      }

      // Update local memory map
      if (approval && approval.files && approval.files[fileId]) {
        approval.files[fileId].status = "ok";
        approval.files[fileId].path = driveUrl;
        approval.files[fileId].note = "";
      }

      renderTrackerContent(event, approval);
      trackerReplaceForm.hidden = true;
      trackerReplaceDriveLink.value = "";
      window.alert(`The Google Drive link for "${fileName}" has replaced the flagged document.`);
    } catch (err) {
      console.error("Replace file error:", err);
      throw err;
    }
  }

  /* --------------------------------------------------------------------------
     EVENT LISTENERS & SUBSCRIPTIONS
     -------------------------------------------------------------------------- */

  function setupEventListeners() {
    // Search & Filter listeners
    searchInput?.addEventListener("input", renderEvents);
    dateFilter?.addEventListener("change", renderEvents);

    // Table action clicks
    eventTableBody?.addEventListener("click", (e) => {
      const tryAgainBtn = e.target.closest("#btnTryAgain");
      if (tryAgainBtn) {
        listenToMyEvents(organizerId);
        return;
      }

      const btn = e.target.closest("[data-action]");
      if (!btn) {
        if (e.target.closest("a")) return;
        const row = e.target.closest("tr[data-event-id]");
        if (row && row.dataset.draft !== "true") {
          openApprovalTracker(row.dataset.eventId);
        }
        return;
      }
      const action = btn.dataset.action;
      const eventId = btn.dataset.eventId;
      if (!eventId) return;

      if (action === "delete-draft") {
        if (!window.confirm("Delete this draft? This cannot be undone.")) return;
        remove(ref(rtdb, `drafts/${organizerId}/${eventId}`)).catch((error) => {
          console.error("Could not delete event draft:", error);
          showEventNotice("Couldn't delete this draft. Please try again.");
        });
      } else if (action === "delete-event") {
        handleDeleteEvent(eventId);
      } else if (action === "view") {
        openApprovalTracker(eventId);
      } else if (action === "publish") {
        handlePublishEvent(eventId);
      } else if (action === "cancel") {
        handleCancelEvent(eventId);
      }
    });

    // Tracker modal controls
    btnTrackerClose?.addEventListener("click", closeApprovalTracker);
    trackerBackdrop?.addEventListener("click", closeApprovalTracker);

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && trackerModalOverlay && !trackerModalOverlay.hidden) {
        closeApprovalTracker();
      }
    });

    btnTrackerPublish?.addEventListener("click", () => {
      if (activeTrackingEventId) handlePublishEvent(activeTrackingEventId);
    });

    btnTrackerCancel?.addEventListener("click", () => {
      if (activeTrackingEventId) handleCancelEvent(activeTrackingEventId);
    });

    btnTrackerResubmit?.addEventListener("click", () => {
      if (activeTrackingEventId) handleResubmitEvent(activeTrackingEventId);
    });

    btnTrackerRemind?.addEventListener("click", () => {
      if (activeTrackingEventId) handleRemindApprovers(activeTrackingEventId);
    });

    // Replace the flagged document with a validated Google Drive link.
    trackerDocsList?.addEventListener("click", (e) => {
      const replaceBtn = e.target.closest(".tracker-btn-replace");
      if (!replaceBtn) return;
      const fileId = replaceBtn.dataset.fileId;
      if (!fileId) return;
      activeReplacingFileId = fileId;
      trackerReplaceDriveLink.value = "";
      trackerReplaceDriveError.textContent = "";
      trackerReplaceDriveError.hidden = true;
      trackerReplaceForm.hidden = false;
      trackerReplaceDriveLink.focus();
    });

    btnTrackerReplaceCancel?.addEventListener("click", () => {
      trackerReplaceForm.hidden = true;
      activeReplacingFileId = null;
    });

    btnTrackerReplaceConfirm?.addEventListener("click", async () => {
      const driveUrl = trackerReplaceDriveLink.value.trim();
      if (!isGoogleDriveLink(driveUrl)) {
        trackerReplaceDriveError.textContent = "Enter a valid Google Drive link.";
        trackerReplaceDriveError.hidden = false;
        trackerReplaceDriveLink.focus();
        return;
      }
      if (!activeTrackingEventId || !activeReplacingFileId) return;
      btnTrackerReplaceConfirm.disabled = true;
      try {
        await handleReplaceFile(activeTrackingEventId, activeReplacingFileId, driveUrl);
        activeReplacingFileId = null;
      } catch (error) {
        trackerReplaceDriveError.textContent = error.message || "Could not replace the document link.";
        trackerReplaceDriveError.hidden = false;
      } finally {
        btnTrackerReplaceConfirm.disabled = false;
      }
    });

    // Logout
    const logoutBtn = document.getElementById("organizerLogout");
    logoutBtn?.addEventListener("click", async (e) => {
      e.preventDefault();
      try {
        if (auth) await signOut(auth);
      } finally {
        localStorage.removeItem("recovibeOrganizerId");
        localStorage.removeItem("recovibeCurrentOrganizer");
        window.location.assign("EventOrganizerLogin.html");
      }
    });
  }

  function subscribeEventApprovals(eventId) {
    if (activeApprovalListeners.has(eventId) || !realtimeDatabaseConfigured) return;

    const approvalRef = ref(rtdb, `approvals/${eventId}`);
    onValue(approvalRef, (snapshot) => {
      if (snapshot.exists()) {
        const data = snapshot.val();
        approvalsMap.set(eventId, data);
        renderEvents();
        if (activeTrackingEventId === eventId) {
          const event = organizerEvents.find((e) => String(e.eventId || e.id) === String(eventId));
          if (event) renderTrackerContent(event, getApprovalForEvent(event) || data);
        }
      }
    });
    activeApprovalListeners.set(eventId, approvalRef);
  }

  function getDashboardOwnedEvents() {
    let events;
    try {
      const storedEvents = localStorage.getItem("recovibeOrganizerEvents");
      events = storedEvents ? JSON.parse(storedEvents) : null;
    } catch (error) {
      console.error("Unable to read organizer event list:", error);
    }

    if (!Array.isArray(events) && typeof window.getOrganizerEvents === "function") {
      events = window.getOrganizerEvents();
    }
    if (!Array.isArray(events)) {
      console.error("Organizer event list must be an array.");
      return [];
    }

    const ownerIdentifiers = getCurrentOwnerIdentifiers();
    if (!ownerIdentifiers.ownerIds.size && !ownerIdentifiers.ownerEmails.size) {
      return [];
    }

    return events
      .filter(
        (event) =>
          event &&
          [
            event.organizerId,
            event.organizerUid,
            event.createdBy,
            event.createdByUid,
            event.authorId,
            event.uid,
          ].some((owner) => isCurrentOwner(owner, ownerIdentifiers)),
      )
      .map((event) => {
        const eventId = String(event.eventId || event.id || "");
        return {
          ...event,
          id: event.id || eventId,
          eventId: event.eventId || eventId,
          title: event.title || event.eventName || event.name || "Untitled Event",
          eventName:
            event.eventName || event.title || event.name || "Untitled Event",
          dateISO: getEventDate(event),
        };
      });
  }

  function getCurrentOwnerIdentifiers(currentUserId = auth.currentUser?.uid) {
    const profile = (() => {
      try {
        const storedProfile = JSON.parse(
          localStorage.getItem("recovibeOrganizerProfile") || "{}",
        );
        return storedProfile && typeof storedProfile === "object"
          ? storedProfile
          : {};
      } catch (error) {
        console.error("Unable to read organizer profile for event ownership:", error);
        return {};
      }
    })();
    const organizerIdentifier =
      localStorage.getItem("recovibeOrganizerId") || "";
    return {
      ownerIds: new Set(
        [
          currentUserId,
          profile.uid,
          profile.id,
          profile.userId,
          profile.organizerId,
          organizerIdentifier,
        ]
          .filter(Boolean)
          .map(String),
      ),
      ownerEmails: new Set(
        [
          auth.currentUser?.email,
          profile.email,
          profile.username,
          organizerIdentifier,
        ]
          .filter(Boolean)
          .map((email) => String(email).trim().toLowerCase()),
      ),
    };
  }

  function isCurrentOwner(value, ownership) {
    if (value === null || value === undefined) return false;
    const owner = String(value).trim();
    return (
      ownership.ownerIds.has(owner) ||
      ownership.ownerEmails.has(owner.toLowerCase())
    );
  }

  function getEventMatchKey(event) {
    const title = String(event.title || event.eventName || event.name || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ");
    const date = String(getEventDate(event) || "").slice(0, 10);
    return title && !["untitled", "untitled event"].includes(title) && date
      ? `${title}|${date}`
      : "";
  }

  function subscribeFirestoreEvents(userId = organizerId || auth.currentUser?.uid) {
    const currentUserId = userId || auth.currentUser?.uid;
    if (!db || !currentUserId) {
      loadErrorOccurred = true;
      firestoreEventsLoaded = true;
      renderOwnedEvents();
      return;
    }

    const ownerIdentifiers = getCurrentOwnerIdentifiers(currentUserId);
    console.log("[My Events] Logged-in user identifier (UID):", currentUserId);

    const ownerFields = ["organizerUid", "organizerId", "createdBy"];
    const snapshotsBySource = new Map();
    const successfulSources = new Set();
    const failedSources = new Set();
    const processSnapshots = () => {
      const eventSnapshots = new Map();
      ownerFields.forEach((source) => {
        snapshotsBySource.get(source)?.forEach((snapshot, eventId) => {
          eventSnapshots.set(eventId, snapshot);
        });
      });
      const events = new Map();
      eventSnapshots.forEach((eventSnapshot, eventId) => {
        const eventData = eventSnapshot.data();
        const isOwnedByCurrentUser = ownerFields.some((field) => {
          const val = eventData[field];
          return String(val || "") === currentUserId || isCurrentOwner(val, ownerIdentifiers);
        });
        if (!isOwnedByCurrentUser) {
          console.warn(
            `[My Events] Ignoring event ${eventId}: its owner fields do not match the signed-in user.`,
          );
          return;
        }
        const createdAt = eventData.createdAt?.toDate
          ? eventData.createdAt.toDate().toISOString()
          : eventData.createdAt || "";
        const dateISO = normalizeDateValue(
          eventData.eventDate ||
            eventData.dateISO ||
            eventData.date ||
            eventData.dateStart ||
            eventData.schedule?.date ||
            eventData.schedule?.startDate ||
            eventData.startAt,
        );
        const startTime =
          eventData.timeStart ||
          eventData.startTime ||
          eventData.schedule?.timeStart ||
          eventData.schedule?.startTime ||
          eventData.schedule?.start ||
          "";
        const endTime =
          eventData.timeEnd ||
          eventData.endTime ||
          eventData.schedule?.timeEnd ||
          eventData.schedule?.endTime ||
          eventData.schedule?.end ||
          "";
        const schedule =
          eventData.time ||
          (typeof eventData.schedule === "string" ? eventData.schedule : "") ||
          [startTime, endTime].filter(Boolean).join(" - ");
        const approvalStatus =
          eventData.approvalStatus ||
          eventData.approval_status ||
          eventData.adminStatus ||
          eventData.admin_status ||
          eventData.adminApprovalStatus ||
          eventData.approval?.approvalStatus ||
          eventData.approval?.status ||
          eventData.reviewStatus ||
          eventData.publicationStatus ||
          eventData.moderationStatus ||
          eventData.eventStatus ||
          eventData.admin?.status ||
          eventData.review?.status ||
          eventData.moderation?.status ||
          eventData.approvalData?.status ||
          "";
        const event = {
          ...eventData,
          id: eventId,
          eventId,
          sourceEventId: eventData.eventId || eventData.id || eventId,
          organizerUid:
            eventData.organizerUid ||
            eventData.organizerId ||
            eventData.createdBy ||
            eventData.authorId ||
            eventData.uid ||
            currentUserId,
          title: eventData.eventName || eventData.title || "Untitled",
          eventName: eventData.eventName || eventData.title || eventData.name || "Untitled",
          name: eventData.name || eventData.eventName || eventData.title || "Untitled Event",
          dateISO,
          time: schedule,
          startTime,
          endTime,
          venue: eventData.venue || eventData.location || eventData.venueOther || "Location TBA",
          location: eventData.venue || eventData.location || eventData.venueOther || "Location TBA",
          category: eventData.category || eventData.eventType || "General",
          source:
            eventData.source ||
            eventData.eventSource ||
            (eventData.organizerId
              ? "Organizational"
              : eventData.organization || eventData.organizerName || "Others / External"),
          description: eventData.eventDescription || eventData.description || "",
          firestoreSubmission: true,
          createdAt,
          updatedAt: eventData.updatedAt?.toDate
            ? eventData.updatedAt.toDate().toISOString()
            : eventData.updatedAt || "",
          approvalStatus,
          status: eventData.status || approvalStatus || "pending",
        };
        events.set(eventId, event);
        firestoreApprovalsById.set(eventId, buildFirestoreApproval(event));
        if (activeTrackingEventId === eventId) {
          renderTrackerContent(event, getApprovalForEvent(event));
        }
      });

      console.log(`[My Events] Unique Firestore events merged: ${events.size} for UID: ${currentUserId}`);
      firestoreEventsById = events;
      const retainedEventIds = new Set(events.keys());
      firestoreApprovalsById.forEach((_, eventId) => {
        if (!retainedEventIds.has(eventId)) firestoreApprovalsById.delete(eventId);
      });
      approvalsMap.forEach((_, eventId) => {
        if (!retainedEventIds.has(eventId) && !eventDataById.has(eventId) && !draftsById.has(eventId)) {
          approvalsMap.delete(eventId);
        }
      });
      firestoreEventsLoaded = true;
      renderOwnedEvents();
    };
    const subscribeToOwnedEvents = (field) => {
      const eventsQuery = query(
        collection(firestoreDb, "events"),
        where(field, "==", currentUserId),
      );
      const unsubscribe = onSnapshot(
        eventsQuery,
        (snapshot) => {
          console.log(
            `[My Events] Firestore query (${field} == ${currentUserId}) returned ${snapshot.size} doc(s)`,
          );
          snapshotsBySource.set(field, new Map(
            snapshot.docs.map((eventSnapshot) => [eventSnapshot.id, eventSnapshot]),
          ));
          successfulSources.add(field);
          processSnapshots();
        },
        (error) => {
          console.error(`Couldn't load Firestore events by ${field}:`, error);
          failedSources.add(field);
          if (successfulSources.size === 0 && failedSources.size === ownerFields.length) {
            firestoreEventsLoaded = true;
            loadErrorOccurred = true;
            renderOwnedEvents();
          }
        },
      );
      firestoreEventUnsubscribers.push(unsubscribe);
    };
    ownerFields.forEach(subscribeToOwnedEvents);
  }

  function cleanupListeners() {
    if (missingEventTimeout) clearTimeout(missingEventTimeout);
    if (activeEventsListenerRef && rtdb) off(activeEventsListenerRef);
    if (activeDraftsListenerRef && rtdb) off(activeDraftsListenerRef);
    activeEventsListenerRef = null;
    activeDraftsListenerRef = null;
    activeEventListeners.forEach((eventRef) => off(eventRef));
    activeEventListeners.clear();
    activeApprovalListeners.forEach((approvalRef) => {
      off(approvalRef);
    });
    activeApprovalListeners.clear();
    firestoreEventUnsubscribers.splice(0).forEach((unsubscribe) => unsubscribe());
    deletedFirestoreEventIds.clear();
    firestoreEventsById.clear();
    firestoreApprovalsById.clear();
    eventDataById.clear();
    draftsById.clear();
    approvalsMap.clear();
    indexLoaded = false;
    draftsLoaded = false;
    firestoreEventsLoaded = false;
  }

  window.addEventListener("beforeunload", cleanupListeners);
  window.addEventListener("recovibeOrganizerEventsChanged", renderOwnedEvents);
  window.addEventListener("storage", (event) => {
    if (event.key === "recovibeOrganizerEvents") renderOwnedEvents();
  });

  function listenToMyEvents(uid) {
    cleanupListeners();
    loadErrorOccurred = false;
    authResolving = false;
    authUnauthenticated = false;

    subscribeFirestoreEvents(uid);
    renderOwnedEvents();

    if (!realtimeDatabaseConfigured) {
      indexLoaded = true;
      draftsLoaded = true;
      firestoreEventsLoaded = true;
      if (!db) {
        loadErrorOccurred = true;
        showEventNotice("Couldn't load your events.");
      }
      renderOwnedEvents();
      return;
    }

    activeIndexListenerRef = ref(rtdb, `organizerEvents/${uid}`);
    activeEventsListenerRef = activeIndexListenerRef;
    onValue(
      activeEventsListenerRef,
      (snapshot) => {
        indexLoaded = true;
        const ids = new Set(Object.keys(snapshot.val() || {}));
        [...activeEventListeners.keys()].forEach((id) => {
          if (!ids.has(id)) {
            off(activeEventListeners.get(id));
            activeEventListeners.delete(id);
            eventDataById.delete(id);
            approvalsMap.delete(id);
          }
        });
        ids.forEach((id) => {
          if (activeEventListeners.has(id)) return;
          const eventRef = ref(rtdb, `events/${id}`);
          onValue(
            eventRef,
            (eventSnapshot) => {
              const event = eventSnapshot.val();
              // Defense in depth: drop if event.organizerUid is not the signed-in uid
              if (!event || event.organizerUid !== uid) {
                eventDataById.delete(id);
                activeEventListeners.delete(id);
                off(eventRef);
                renderOwnedEvents();
                return;
              }
              eventDataById.set(id, {
                ...event,
                id,
                eventId: id,
                title: event.title || event.eventName || event.name || "Untitled Event",
                eventName: event.eventName || event.title || event.name || "Untitled Event",
                dateISO: getEventDate(event),
              });
              subscribeEventApprovals(id);
              renderOwnedEvents();
            },
            (error) => {
              console.error("Couldn't load an owned event:", error);
              loadErrorOccurred = true;
              renderOwnedEvents();
            },
          );
          activeEventListeners.set(id, eventRef);
        });
        renderOwnedEvents();
      },
      (error) => {
        console.error("Couldn't load your event index:", error);
        indexLoaded = true;
        loadErrorOccurred = true;
        renderOwnedEvents();
      },
    );

    activeDraftsListenerRef = ref(rtdb, `drafts/${uid}`);
    onValue(
      activeDraftsListenerRef,
      (snapshot) => {
        draftsLoaded = true;
        draftsById = new Map(
          Object.entries(snapshot.val() || {})
            .filter(([, draft]) => {
              // Defense in depth for drafts
              if (!draft || draft.status !== "draft" || typeof draft.name !== "string") return false;
              if (draft.organizerUid && draft.organizerUid !== uid) return false;
              return true;
            })
            .map(([id, draft]) => [
              id,
              {
                ...draft,
                id,
                eventId: id,
                title: draft.eventName || draft.name,
                status: "draft",
                dateISO: draft.dateISO || draft.date || (draft.startAt ? String(draft.startAt).substring(0, 10) : ""),
              },
            ]),
        );
        renderOwnedEvents();
      },
      (error) => {
        console.error("Couldn't load event drafts:", error);
        draftsLoaded = true;
        loadErrorOccurred = true;
        renderOwnedEvents();
      },
    );
  }

  // Fast Authentication & Realtime Load
  function resolveOrganizerAuth() {
    let authResolved = false;

    // Helper to get fallback identifier from localStorage
    const getStoredIdentifier = () => {
      try {
        const storedProfile = JSON.parse(localStorage.getItem("recovibeOrganizerProfile") || "{}");
        return storedProfile?.uid || storedProfile?.id || localStorage.getItem("recovibeOrganizerId") || "";
      } catch {
        return localStorage.getItem("recovibeOrganizerId") || "";
      }
    };

    const handleUserFound = (user) => {
      if (authResolved) return;
      authResolved = true;
      authResolving = false;
      authUnauthenticated = false;
      organizerId = user.uid;
      console.log("[My Events] Fast auth resolved with UID:", organizerId);
      listenToMyEvents(organizerId);
    };

    const handleFallbackAuth = () => {
      if (authResolved) return;
      authResolved = true;
      authResolving = false;

      const fallbackId = getStoredIdentifier();
      if (fallbackId) {
        console.warn("[My Events] Auth timeout reached; using stored identifier:", fallbackId);
        organizerId = fallbackId;
        authUnauthenticated = false;
        listenToMyEvents(organizerId);
      } else {
        console.warn("[My Events] Auth timeout reached and no user session found.");
        authUnauthenticated = true;
        renderOwnedEvents();
      }
    };

    // 1. Immediately check if auth.currentUser is already present on page load
    if (auth?.currentUser) {
      handleUserFound(auth.currentUser);
      return;
    }

    // 2. Set up fallback timeout (1.5 seconds) so the UI never hangs indefinitely
    const authTimeout = setTimeout(() => {
      if (!authResolved) {
        handleFallbackAuth();
      }
    }, 1500);

    // 3. Listen for auth state change
    try {
      const unsubscribe = onAuthStateChanged(auth, (user) => {
        clearTimeout(authTimeout);
        if (user) {
          handleUserFound(user);
        } else if (!authResolved) {
          handleFallbackAuth();
        }
      });
      firestoreEventUnsubscribers.push(unsubscribe);
    } catch (err) {
      console.error("[My Events] Error attaching onAuthStateChanged:", err);
      clearTimeout(authTimeout);
      handleFallbackAuth();
    }
  }

  resolveOrganizerAuth();

  function showEventNotice(message) {
    let notice = document.getElementById("myEventsNotice");
    if (!notice) {
      notice = document.createElement("div");
      notice.id = "myEventsNotice";
      notice.setAttribute("role", "status");
      notice.tabIndex = -1;
      eventTableBody?.closest("table")?.before(notice);
    }
    notice.textContent = message;
  }

  function renderOwnedEvents() {
    const mergedEvents = new Map();
    [
      ...getDashboardOwnedEvents(),
      ...draftsById.values(),
      ...eventDataById.values(),
      ...firestoreEventsById.values(),
    ].forEach((event) => {
      const eventIds = [event.sourceEventId, event.eventId, event.id]
        .filter((id) => id !== null && id !== undefined && String(id))
        .map(String);
      let existingEntry = [...mergedEvents.entries()].find(([, existing]) =>
        [existing.sourceEventId, existing.eventId, existing.id]
          .filter((id) => id !== null && id !== undefined && String(id))
          .some((id) => eventIds.includes(String(id))),
      );
      if (!existingEntry && event.firestoreSubmission) {
        const matchKey = getEventMatchKey(event);
        const matches = matchKey
          ? [...mergedEvents.entries()].filter(([, existing]) => getEventMatchKey(existing) === matchKey)
          : [];
        if (matches.length === 1) existingEntry = matches[0];
      }
      const eventId = existingEntry?.[0] || eventIds[0];
      if (eventId) {
        const existingEvent = existingEntry?.[1] || {};
        const mergedEvent = {
          ...existingEvent,
          ...event,
        };
        const sourceEvents = [existingEvent, event];
        const hasPublishedSource = sourceEvents.some((source) =>
          getEventStatusValues(source).includes("published") ||
          [source.published, source.isPublished, source.isLive].some(hasTrueFlag),
        );
        const hasNonPublishedTerminalSource = sourceEvents.some((source) =>
          getEventStatusValues(source).some((status) =>
            ["cancelled", "rejected", "revision"].includes(status),
          ),
        );
        if (hasPublishedSource && !hasNonPublishedTerminalSource) {
          mergedEvent.status = "published";
        }
        mergedEvents.set(eventId, mergedEvent);
      }
    });
    organizerEvents = [...mergedEvents.entries()]
      .filter(([eventId]) => !deletedFirestoreEventIds.has(eventId))
      .map(([, event]) => event)
      .sort((a, b) => {
        const aIsDraft = normalizeStatus(a.status) === "draft";
        const bIsDraft = normalizeStatus(b.status) === "draft";
        if (aIsDraft !== bIsDraft) return aIsDraft ? -1 : 1;
        return new Date(b.createdAt || b.updatedAt || 0).getTime() -
          new Date(a.createdAt || a.updatedAt || 0).getTime();
      });
    renderEvents();
    const params = new URLSearchParams(location.search);
    const eventId = params.get("event") || params.get("openEvent");
    if (eventId && indexLoaded && !activeTrackingEventId) {
      const event = organizerEvents.find((item) =>
        String(item.eventId || item.id) === eventId || String(item.sourceEventId || "") === eventId,
      );
      if (event && event.organizerUid === organizerId) {
        openApprovalTracker(String(event.eventId || event.id));
      }
      else if (draftsLoaded && !document.getElementById("myEventMissingNotice")) {
        const notice = document.createElement("div");
        notice.id = "myEventMissingNotice";
        notice.setAttribute("role", "status");
        notice.textContent = "We couldn't find that event in your list.";
        eventTableBody?.closest("table")?.before(notice);
      }
    }
    const newId = params.get("new");
    if (newId && organizerEvents.some((event) =>
      String(event.eventId || event.id) === newId || String(event.sourceEventId || "") === newId,
    )) {
      const notice = document.getElementById("myEventsNotice");
      if (notice) notice.textContent = sessionStorage.getItem("recovibeEventNotice") || "";
      if (missingEventTimeout) clearTimeout(missingEventTimeout);
    } else if (newId && firestoreEventsLoaded && !missingEventTimeout) {
      missingEventTimeout = setTimeout(() => {
        if (!organizerEvents.some((event) =>
          String(event.eventId || event.id) === newId || String(event.sourceEventId || "") === newId,
        )) {
          showEventNotice("Your event was submitted but is taking a moment to appear. Refresh to check.");
          const refresh = document.createElement("button");
          refresh.type = "button";
          refresh.textContent = "Refresh";
          refresh.addEventListener("click", () => location.reload());
          document.getElementById("myEventsNotice")?.append(" ", refresh);
        }
      }, 5000);
    }
  }

  // Initialization
  function initializeMyEventsPage() {
    if (todayElement) {
      todayElement.textContent = new Date().toLocaleDateString("en-US", {
        month: "long",
        day: "numeric",
        year: "numeric",
      });
    }

    window.enhanceDropdownSelects?.("#eventDateFilter");
    setupEventListeners();
    renderOwnedEvents();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initializeMyEventsPage, {
      once: true,
    });
  } else {
    initializeMyEventsPage();
  }
})();
