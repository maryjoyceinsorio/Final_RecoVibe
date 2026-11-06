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
  collection,
  doc,
  getDoc,
  onSnapshot,
  updateDoc,
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
  let organizerId = "";
  let organizerEvents = [];
  let eventDataById = new Map();
  let firestoreEventsById = new Map();
  let draftsById = new Map();
  const firestoreEventUnsubscribers = [];
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
    const isOverallApproved = overallStatusValues.includes("approved");
    const members = {};

    standardStages.forEach((stage, index) => {
      const source = stageEntries.find(([id, candidate]) =>
        [id, candidate?.id, candidate?.key, candidate?.label, candidate?.name, candidate?.reviewer]
          .some((value) => stage.aliases.some((alias) => normalizeKey(alias) === normalizeKey(value)) ||
            normalizeKey(value) === normalizeKey(stage.key) ||
            normalizeKey(value) === normalizeKey(stage.label)),
      )?.[1];
      const sourceStatus = normalizeStatus(
        source?.status || source?.approvalStatus || source?.state || source?.decision,
      );
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
                : isOverallApproved ? "ok" : index === 0 ? "review" : "wait";
      members[stage.key] = {
        key: stage.key,
        label: stage.label,
        step: index + 1,
        status,
        note: source?.note || "",
        updatedAt: source?.updatedAt || source?.approvedAt || null,
        approvedByName: source?.approvedByName || source?.decidedBy || "",
      };
    });

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

    const status = overallStatusValues.find((value) =>
      ["published", "completed", "cancelled", "rejected", "revision", "approved"].includes(value),
    ) || overallStatusValues.find(Boolean) || "pending";

    return {
      submittedAt: event.approvalSubmittedAt || event.createdAt,
      members,
      files,
      history: Array.isArray(event.approvalHistory) ? event.approvalHistory : [],
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
    const date = new Date(typeof ts === "number" ? ts : String(ts));
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
      if (["pending", "revision"].includes(st)) pending++;
      if (st === "approved") approved++;
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
      const approvalText = ["approved", "published", "completed"].includes(effStatus)
        ? "All approval steps approved"
        : effStatus === "revision"
          ? "Changes requested"
          : effStatus === "rejected"
            ? "Rejected"
            : "Review pending";
      return `
        <div class="approval-progress-wrap">
          <div class="approval-bar">
            <span class="approval-segment is-current"></span>
          </div>
          <span class="approval-text">${escapeHtml(approvalText)}</span>
        </div>`;
    }

    const membersList = Object.values(approval.members).sort((a, b) => (a.step || 0) - (b.step || 0));
    const totalSteps = membersList.length || 8;

    let currentReviewer = null;
    let revisionRequester = null;
    let rejecter = null;
    let allApproved = true;

    const segmentsMarkup = membersList
      .map((m) => {
        let segClass = "is-waiting";
        if (m.status === "ok") {
          segClass = "is-approved";
        } else if (m.status === "review") {
          segClass = "is-current";
          if (!currentReviewer) currentReviewer = m;
          allApproved = false;
        } else if (m.status === "rev") {
          segClass = "is-revision";
          if (!revisionRequester) revisionRequester = m;
          allApproved = false;
        } else if (m.status === "rej") {
          segClass = "is-rejected";
          if (!rejecter) rejecter = m;
          allApproved = false;
        } else {
          allApproved = false;
        }
        return `<span class="approval-segment ${segClass}" title="Step ${m.step}: ${escapeHtml(m.label)} (${m.status})"></span>`;
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
      statusLineText = `Step 1 of ${totalSteps}: In review`;
    }

    return `
      <div class="approval-progress-wrap">
        <div class="approval-bar">
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
                  ? `<div class="event-actions"><button type="button" class="event-action" data-action="view" data-event-id="${eventId}">View tracker</button>${canPublish ? `<button type="button" class="event-action event-action-primary" data-action="publish" data-event-id="${eventId}" title="Publish this event to students">Publish</button>` : ""}${showAttendanceAction ? `<a class="event-action" href="EventOrganizerScanAttendance.html?${scanParams.toString()}">Scan attendance</a>` : ""}</div>`
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
      .map((entry, index) => ({ ...entry, _index: index }))
      .sort((first, second) => {
        const firstAt = Number(first.at) || 0;
        const secondAt = Number(second.at) || 0;
        return firstAt - secondAt || first._index - second._index;
      });
    if (trackerHistoryList) {
      trackerHistoryList.innerHTML = historyEntries.length
        ? historyEntries.map((entry) => `
            <article class="tracker-history-item">
              <div class="tracker-history-marker" aria-hidden="true"></div>
              <div class="tracker-history-body">
                <div class="tracker-note-header">
                  <span class="tracker-note-title">${escapeHtml(entry.label || entry.action || "Proposal update")}</span>
                  <span class="tracker-note-date">${escapeHtml(formatDateTime(entry.at))}</span>
                </div>
                <p class="tracker-note-text">${escapeHtml(entry.note || entry.by || "Status updated.")}</p>
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
      const isRevisionState = effStatus === "revision" || anyChangesRequested;
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
      await updateDoc(eventRef, {
        status: "published",
        approvalStatus: "approved",
        publicationStatus: "published",
        published: true,
        isPublished: true,
        publishedAt,
        updatedAt: publishedAt,
      });

      Object.assign(event, {
        status: "published",
        approvalStatus: "approved",
        publicationStatus: "published",
        published: true,
        isPublished: true,
        publishedAt,
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

  async function handleCancelEvent(eventId) {
    const confirmed = window.confirm("Are you sure you want to cancel this event proposal?");
    if (!confirmed) return;

    try {
      if (functions) {
        const cancelFn = httpsCallable(functions, "cancelEvent");
        await cancelFn({ eventId, reason: "Cancelled by organizer." });
      }
      const event = organizerEvents.find((e) => String(e.eventId || e.id) === String(eventId));
      if (event) event.status = "cancelled";
      const approval = getApprovalForEvent(event);
      if (approval) approval.status = "cancelled";

      renderEvents();
      if (activeTrackingEventId === eventId) {
        closeApprovalTracker();
      }
      window.alert("Event proposal has been cancelled.");
    } catch (err) {
      console.error("Cancel event error:", err);
      window.alert(err.message || "Could not cancel event.");
    }
  }

  async function handleResubmitEvent(eventId) {
    const note = window.prompt("Optional message for the reviewer regarding your updates:", "Changes updated as requested.");
    if (note === null) return; // User pressed cancel on prompt

    try {
      if (functions) {
        const resubmitFn = httpsCallable(functions, "resubmitEvent");
        await resubmitFn({ eventId, note });
      }
      const event = organizerEvents.find((e) => String(e.eventId || e.id) === String(eventId));
      if (event) event.status = "pending";
      const approval = getApprovalForEvent(event);
      if (approval) {
        approval.status = "pending";
        if (approval.members) {
          Object.values(approval.members).forEach((m) => {
            if (m.status === "rev") m.status = "review";
          });
        }
      }
      renderEvents();
      if (activeTrackingEventId === eventId) {
        renderTrackerContent(event, approval);
      }
      window.alert("Proposal resubmitted for review!");
    } catch (err) {
      console.error("Resubmit error:", err);
      window.alert(err.message || "Could not resubmit proposal.");
    }
  }

  async function handleRemindApprovers(eventId) {
    try {
      if (functions) {
        const remindFn = httpsCallable(functions, "remindApprovers");
        await remindFn({ eventId });
      }
      window.alert("Reminder notification sent to active approvers.");
    } catch (err) {
      console.warn("Remind approver notice:", err);
      window.alert("Reminder sent to approver.");
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

  function hasOwnedEventMatch(eventData) {
    const matchKey = getEventMatchKey(eventData);
    if (!matchKey) return false;
    const candidates = new Map();
    [
      ...getDashboardOwnedEvents(),
      ...eventDataById.values(),
    ]
      .filter((event) => getEventMatchKey(event) === matchKey)
      .forEach((event) => {
        const eventId = [event.sourceEventId, event.eventId, event.id]
          .find((id) => id !== null && id !== undefined && String(id));
        candidates.set(String(eventId || matchKey), event);
      });
    return candidates.size === 1;
  }

  function getEventOwnershipContext(currentUserId) {
    const identifiers = getCurrentOwnerIdentifiers(currentUserId);
    return {
      ...identifiers,
      dashboardEventIds: new Set(
        getDashboardOwnedEvents().flatMap((event) =>
          [event.id, event.eventId, event.sourceEventId]
            .filter(Boolean)
            .map(String),
        ),
      ),
    };
  }

  function isOwnedFirestoreEvent(eventData, documentId, ownership) {
    const ownerFields = [
      eventData.createdBy,
      eventData.createdByUid,
      eventData.organizerUid,
      eventData.organizerId,
      eventData.authorId,
      eventData.uid,
      eventData.ownerUid,
      eventData.userId,
    ].flatMap((value) => {
      if (Array.isArray(value)) return value;
      if (value && typeof value === "object") {
        return [value.uid, value.email, value.id, value.userId].filter(Boolean);
      }
      return [value];
    });

    if (ownerFields.some((value) => isCurrentOwner(value, ownership))) {
      return true;
    }

    return [documentId, eventData.id, eventData.eventId]
      .filter(Boolean)
      .some((eventId) => ownership.dashboardEventIds.has(String(eventId)));
  }

  function subscribeFirestoreEvents() {
    const currentUserId = auth.currentUser?.uid;
    if (!db || !currentUserId) {
      loadErrorOccurred = true;
      firestoreEventsLoaded = true;
      renderOwnedEvents();
      return;
    }

    const unsubscribe = onSnapshot(
      collection(db, "events"),
      (snapshot) => {
        const events = new Map();
        const ownership = getEventOwnershipContext(currentUserId);
        const eventSnapshots = [];
        snapshot.forEach((eventSnapshot) => eventSnapshots.push(eventSnapshot));
        const matchKeyCounts = new Map();
        eventSnapshots.forEach((eventSnapshot) => {
          const matchKey = getEventMatchKey(eventSnapshot.data());
          if (matchKey) matchKeyCounts.set(matchKey, (matchKeyCounts.get(matchKey) || 0) + 1);
        });
        eventSnapshots.forEach((eventSnapshot) => {
          const eventData = eventSnapshot.data();
          const eventId = eventSnapshot.id;
          const matchKey = getEventMatchKey(eventData);
          const hasUniqueOwnedMatch =
            matchKeyCounts.get(matchKey) === 1 && hasOwnedEventMatch(eventData);
          if (!isOwnedFirestoreEvent(eventData, eventId, ownership) && !hasUniqueOwnedMatch) return;
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
        loadErrorOccurred = false;
        renderOwnedEvents();
      },
      (error) => {
        console.error("Couldn't load Firestore events:", error);
        firestoreEventsLoaded = true;
        loadErrorOccurred = true;
        renderOwnedEvents();
      },
    );
    firestoreEventUnsubscribers.push(unsubscribe);
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

    subscribeFirestoreEvents();
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
        loadErrorOccurred = true;
        renderOwnedEvents();
      },
    );
  }

  // Authentication & Realtime Load
  authReady.then(() => onAuthStateChanged(auth, async (user) => {
    cleanupListeners();

    if (!user) {
      window.location.replace("EventOrganizerLogin.html");
      return;
    }

    try {
      if (!realtimeDatabaseConfigured && !db) {
        throw new Error("Firebase is not configured.");
      }

      let isOrganizer = false;
      if (realtimeDatabaseConfigured) {
        try {
          const roleSnapshot = await get(ref(rtdb, `roles/${user.uid}`));
          isOrganizer = roleSnapshot.val() === "event_organizer";
        } catch (error) {
          console.warn("Could not verify organizer role in Realtime Database; trying Firestore.", error);
        }
      }

      if (!isOrganizer && db) {
        const [adminProfileResult, userProfileResult] = await Promise.allSettled([
          getDoc(doc(db, "adminUser", user.uid)),
          getDoc(doc(db, "users", user.uid)),
        ]);
        const profiles = [adminProfileResult, userProfileResult]
          .filter((result) => result.status === "fulfilled" && result.value.exists())
          .map((result) => result.value.data());
        const roleAliases = new Set(["eo", "organizer", "eventorganizer"]);
        isOrganizer = profiles.some((profile) => {
          const role = String(profile.role || profile.userRole || "")
            .trim()
            .toLowerCase()
            .replace(/[\s_-]+/g, "");
          return roleAliases.has(role);
        });
        if (!profiles.length) {
          const profileError = [adminProfileResult, userProfileResult].find(
            (result) => result.status === "rejected",
          );
          if (profileError) throw profileError.reason;
        }
      }

      if (!isOrganizer) {
        window.location.replace("EventOrganizerLogin.html");
        return;
      }
    } catch (error) {
      console.error("Could not verify organizer role:", error);
      showEventNotice("Couldn't verify your account. Please sign in again.");
      return;
    }
    organizerId = user.uid;
    listenToMyEvents(organizerId);
  })).catch((error) => {
    console.error("Could not restore organizer authentication state:", error);
    showEventNotice("Couldn't verify your account. Please refresh and try again.");
  });

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
        mergedEvents.set(eventId, {
          ...(existingEntry?.[1] || {}),
          ...event,
        });
      }
    });
    organizerEvents = [...mergedEvents.values()].sort((a, b) => {
      const aIsDraft = normalizeStatus(a.status) === "draft";
      const bIsDraft = normalizeStatus(b.status) === "draft";
      if (aIsDraft !== bIsDraft) return aIsDraft ? -1 : 1;
      return new Date(b.createdAt || b.updatedAt || 0).getTime() - new Date(a.createdAt || a.updatedAt || 0).getTime();
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
