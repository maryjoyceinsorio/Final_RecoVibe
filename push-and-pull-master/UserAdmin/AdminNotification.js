import {
  ref,
  onValue,
  off,
  remove,
  update,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  onSnapshot as onFirestoreSnapshot,
  query,
  serverTimestamp,
  updateDoc,
  where,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { auth, authReady, db, rtdb, isRtdbConfigured } from "../UserStudent/firebaseConfig.js";
import {
  approveCorrectionRequest,
  rejectCorrectionRequest,
} from "../correctionApproval.js";

(() => {
  "use strict";
  const DEBUG = false;
  let profile = {};
  const root = document.getElementById("notificationRoot"),
    correctionPanel = document.getElementById("correctionReviewPanel"),
    lifetime = 30 * 86400000;
  let filter = "all",
    deleted = false,
    search = "",
    undoSnapshot = null,
    undoTimer,
    currentAdminUid = null,
    currentAdminEmail = "",
    currentAdminName = "",
    key = "",
    trashKey = "",
    currentAdminOrganizationCodes = [],
    currentAdminDepartmentCodes = [],
    rtdbNotifications = [],
    firestoreNotifications = [],
    firestoreNotificationsLoading = false,
    firestoreNotificationsError = "",
    notifListenerRef = null,
    queueListenerRef = null,
    firestoreNotifUnsubscribes = [],
    firestoreRecipientUidDocs = [],
    firestoreRecipientRoleDocs = [],
    firestoreLoadTimer = null,
    firestoreLoadExpired = false,
    authStartupTimer = null,
    authStartupExpired = false,
    undoDeleteItem = null,
    pendingWrites = new Set(),
    correctionReviewNotes = new Map(),
    correctionReviewErrors = new Map(),
    correctionReviewPending = new Set(),
    correctionPanelOpen = false,
    correctionHistoryExpanded = false,
    correctionPanelReturnFocus = null,
    queueLoaded = !isRtdbConfigured || !rtdb,
    pageLoadSignaled = false;
  let notificationController = null,
    sharedNotificationState = {
      items: [],
      allItems: [],
      trash: [],
      unreadCount: 0,
      loading: true,
      error: "",
      correctionRequests: [],
      correctionRequestsLoading: true,
      correctionRequestsError: "",
    },
    authStateHandler = null;
  function signalNotificationsPageReady() {
    if (
      pageLoadSignaled ||
      sharedNotificationState.loading ||
      sharedNotificationState.correctionRequestsLoading ||
      !queueLoaded
    ) return;
    pageLoadSignaled = true;
    window.dispatchEvent(new Event("page-data-ready"));
  }
  document.querySelector(".admin-logout").onclick = async (event) => {
    event.preventDefault();
    try {
      await signOut(auth);
    } finally {
      localStorage.removeItem("recovibeAdminId");
      localStorage.removeItem("recovibeAdminProfile");
      location.replace("AdminLogin.html");
    }
  };
  function read(name, fallback) {
    try {
      return JSON.parse(localStorage.getItem(name) || "null") ?? fallback;
    } catch {
      return fallback;
    }
  }
  function getApprovalPosition(adminProfile) {
    const labels = {
      org_adv: "Organization Adviser",
      sir_abelida: "Laboratory Head, Property Custodian, Administrative Officer",
      hap: "Head of Academic Programs, QAC Coordinator (HAP)",
      osas: "OSAS",
    };
    const normalize = (value) => String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
    const accountValues = [
      adminProfile.accountNumber, adminProfile.accountNo,
      adminProfile.account_number, adminProfile.account_no,
    ].map(normalize);
    const values = [
      adminProfile.approvalStage, adminProfile.approvalStageKey,
      adminProfile.assignedApprovalStage, adminProfile.approverStage,
      adminProfile.approverKey, adminProfile.approvalRole,
      adminProfile.approverRole, adminProfile.assignedRole,
      adminProfile.assignedApprover, adminProfile.adminRole,
      adminProfile.roleName, adminProfile.stageKey, adminProfile.position,
    ].map(normalize);
    const aliases = {
      org_adv: ["orgadv", "orgadviser", "organizationadviser", "organizationadvisor", "adviser"],
      sir_abelida: ["sirabelida", "abelida", "abelidas", "laboratoryhead", "propertycustodian", "administrativeofficer", "labhead"],
      hap: ["hap", "headofacademicprograms", "qaccoordinator"],
      osas: ["osas"],
    };
    const key = accountValues.some((value) => value.includes("administrative"))
      ? "sir_abelida"
      : accountValues.some((value) => value.includes("orgadviser") || value.includes("orgadvisor"))
        ? "org_adv"
        : accountValues.some((value) => value.includes("hap"))
          ? "hap"
          : accountValues.some((value) => value.includes("osas"))
            ? "osas"
            : Object.keys(aliases).find((stage) => aliases[stage].some((alias) => values.includes(alias)));
    return labels[key] || String(adminProfile.position || adminProfile.title || adminProfile.role_title || adminProfile.approver_role || adminProfile.approverRole || "").trim();
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
  function getEvents() {
    return ["recovibeTeacherEvents", "recovibeOrganizerEvents"].flatMap(
      (storage) => {
        const list = read(storage, []);
        return Array.isArray(list)
          ? list.map((event) => ({ ...event, _store: storage }))
          : [];
      },
    );
  }
  function status(event) {
    return String(event.status || "")
      .toLowerCase()
      .replace(/[ _-]+/g, "_");
  }
  function getNotificationOrganizationCode(value) {
    return String(value || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "");
  }
  function getNotificationProfileValues(source, keys) {
    const values = [];
    keys.forEach((key) => {
      const value = source?.[key];
      (Array.isArray(value) ? value : [value]).forEach((entry) => {
        if (typeof entry === "string") {
          values.push(entry);
        } else if (entry && typeof entry === "object") {
          [
            entry.organizationCode,
            entry.organizationId,
            entry.orgCode,
            entry.orgId,
            entry.departmentCode,
            entry.departmentId,
            entry.code,
            entry.id,
            entry.name,
            entry.label,
          ]
            .filter(Boolean)
            .forEach((item) => values.push(item));
        }
      });
    });
    return [...new Set(values.map(getNotificationOrganizationCode).filter(Boolean))];
  }
  function getEventNotificationAudience(event) {
    const audience = String(event.targetAudience || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "");
    const openForAll = event.openForAll === true || audience.startsWith("opentoall");
    const organizationCodes = new Set(getNotificationProfileValues(event, [
      "organizationCode",
      "organizationId",
      "organizerOrganization",
      "orgId",
      "organization",
      "organizationName",
      "orgName",
    ]));
    const partners = [
      ...(Array.isArray(event.partnerOrganizations) ? event.partnerOrganizations : []),
      ...(Array.isArray(event.targetOrganizations) ? event.targetOrganizations : []),
    ];
    if (event.isCollaboration === true || partners.length > 0) {
      partners.forEach((organization) => {
        getNotificationProfileValues(
          typeof organization === "string" ? { organization } : organization,
          [
            "organizationCode",
            "organizationId",
            "orgCode",
            "orgId",
            "code",
            "id",
            "organizationName",
            "name",
            "subtitle",
          ],
        ).forEach((code) => organizationCodes.add(code));
      });
    }
    const departmentCodes = new Set(getNotificationProfileValues(event, [
      "targetDepartments",
      "targetDepartment",
      "departments",
      "departmentCode",
      "departmentId",
      "departmentIds",
    ]));
    return {
      openForAll,
      organizationCodes: [...organizationCodes],
      departmentCodes: [...departmentCodes],
    };
  }
  function notificationVisibleToAdmin(item) {
    if (!item.eventId && !String(item.type || "").startsWith("proposal-")) return true;
    if (item.openForAll === true) return true;
    let organizationCodes = Array.isArray(item.organizationCodes)
      ? item.organizationCodes.map(getNotificationOrganizationCode).filter(Boolean)
      : [];
    if (!organizationCodes.length && item.eventId) {
      const event = getEvents().find(
        (candidate) =>
          String(candidate.eventId || candidate.id) === String(item.eventId),
      );
      if (event) {
        const audience = getEventNotificationAudience(event);
        if (audience.openForAll) return true;
        organizationCodes = audience.organizationCodes;
      }
    }
    const departmentCodes = Array.isArray(item.departmentCodes)
      ? item.departmentCodes.map(getNotificationOrganizationCode).filter(Boolean)
      : [];
    if (organizationCodes.length) {
      return organizationCodes.some((code) =>
        currentAdminOrganizationCodes.includes(code),
      );
    }
    return departmentCodes.some((code) =>
      currentAdminDepartmentCodes.includes(code),
    );
  }
  function legacySnapshots() {
    const current = read(key, []),
      known = new Set(
        Array.isArray(current) ? current.map((item) => item.id) : [],
      ),
      next = Array.isArray(current) ? current : [];
    getEvents().forEach((event) => {
      const eventAudience = getEventNotificationAudience(event);
      if (!notificationVisibleToAdmin({
        eventId: event.eventId || event.id,
        type: "approval",
        ...eventAudience,
      })) return;
      const id = String(event.eventId || event.id);
      const add = (type, title, message) => {
        const stamp =
          event.updatedAt || event.submittedAt || event.createdAt || "";
        const noteId = `${type}-${id}-${stamp || status(event)}`;
        if (known.has(noteId)) return;
        next.unshift({
          id: noteId,
          eventId: id,
          type,
          title,
          message,
          createdAt: stamp || new Date().toISOString(),
          read: false,
          sourceStore: event._store,
          organizationCodes: eventAudience.organizationCodes,
          departmentCodes: eventAudience.departmentCodes,
          openForAll: eventAudience.openForAll,
        });
      };
      const state = status(event);
      if (["pending_approval", "pending"].includes(state))
        add(
          "approval",
          "New Event Submitted",
          `“${event.title || "Untitled event"}” was submitted for approval.`,
        );
      if (state === "final_documents_submitted")
        add(
          "final-documents",
          "Final Documents Submitted",
          `Final documents are ready for review for “${event.title || "Untitled event"}”.`,
        );
      if (event.rescheduleRequest?.status === "pending")
        add(
          "reschedule",
          "Reschedule Requested",
          `A reschedule was requested for “${event.title || "Untitled event"}”.`,
        );
      if (
        ["cancelled", "canceled"].includes(state) &&
        event.cancellation?.cancelledAt &&
        !event.cancellation?.acknowledgedAt
      )
        add(
          "cancellation",
          "Event Cancelled",
          `The organizer cancelled “${event.title || "Untitled event"}”.`,
        );
      if (["pending_approval", "pending"].includes(state) && hasConflict(event))
        add(
          "conflict",
          "Venue Conflict Detected",
          `“${event.title || "Untitled event"}” overlaps another event at the same venue.`,
        );
      (event.reviewHistory || [])
        .filter((entry) =>
          [currentAdminUid, currentAdminEmail].includes(String(entry.by || "")),
        )
        .forEach((entry) => {
          const entryId = `admin-decision-${id}-${entry.at}-${entry.action}`;
          if (!known.has(entryId))
            next.unshift({
              id: entryId,
              eventId: id,
              type: "decision",
              title: "Review Decision Recorded",
              message: `${entry.action.replaceAll("_", " ")} for “${event.title || "Untitled event"}”.`,
              createdAt: entry.at,
              read: false,
            });
        });
    });
    rtdbNotifications.forEach((item) => {
      const idx = next.findIndex((x) => x.id === item.id);
      if (idx !== -1) {
        next[idx] = { ...next[idx], ...item };
      } else {
        next.unshift(item);
      }
    });
    firestoreNotifications.forEach((item) => {
      const idx = next.findIndex((x) => x.id === item.id);
      if (idx !== -1) {
        next[idx] = { ...next[idx], ...item };
      } else {
        next.unshift(item);
      }
    });
    next.sort((a, b) => {
      const left = notificationDate(a.createdAt)?.getTime() || 0;
      const right = notificationDate(b.createdAt)?.getTime() || 0;
      return right - left;
    });
    localStorage.setItem(key, JSON.stringify(next));
    const deletedIds = new Set(read(trashKey, []).map((item) => String(item.id)));
    const permanentlyDeletedIds = new Set(
      read(`recovibeAdminPermanentlyDeleted:${currentAdminUid}`, []),
    );
    return next.filter(
      (item) => notificationVisibleToAdmin(item) &&
        !deletedIds.has(String(item.id)) &&
        !permanentlyDeletedIds.has(String(item.id)),
    );
  }

  function snapshots() {
    return sharedNotificationState.items;
  }

  async function startSharedNotificationData() {
    notificationController?.stop();
    try {
      const { subscribeAdminNotifications } = await import("./AdminNotificationData.js");
      notificationController = subscribeAdminNotifications((state) => {
        sharedNotificationState = state;
        firestoreNotificationsLoading = state.loading;
        firestoreNotificationsError = state.error;
        render();
        renderCorrectionPanel();
        signalNotificationsPageReady();
      });
    } catch (error) {
      sharedNotificationState = {
        ...sharedNotificationState,
        loading: false,
        error: "Notifications are unavailable. Please retry.",
        correctionRequestsLoading: false,
        correctionRequestsError: "Correction requests are unavailable. Please retry.",
      };
      document.querySelectorAll("[data-notification-count]").forEach((badge) => { badge.hidden = true; });
      render();
      signalNotificationsPageReady();
    }
  }

  function subscribeToRtdbNotifications(uid) {
    if (!isRtdbConfigured || !rtdb || !uid) {
      queueLoaded = true;
      signalNotificationsPageReady();
      return;
    }
    if (notifListenerRef) {
      off(notifListenerRef);
      notifListenerRef = null;
    }
    notifListenerRef = ref(rtdb, `notifications/${uid}`);
    onValue(
      notifListenerRef,
      (snapshot) => {
        const data = snapshot.val() || {};
        rtdbNotifications = Object.entries(data).map(([id, val]) => ({
          id,
          eventId: val.eventId || "",
          type: val.type || "approval",
          title: val.title || "Notification",
          message: val.message || "",
          createdAt: val.createdAt ?? new Date().toISOString(),
          read: val.read === true,
          source: "rtdb",
        }));
        render();
      },
      (err) => {
        console.warn("RTDB notifications error:", err);
      },
    );
  }

  function subscribeToFirestoreNotifications(uid) {
    clearTimeout(firestoreLoadTimer);
    firestoreLoadTimer = null;
    firestoreLoadExpired = false;
    firestoreNotifUnsubscribes.forEach((unsubscribe) => unsubscribe());
    firestoreNotifUnsubscribes = [];
    if (!db || !uid) {
      firestoreNotifications = [];
      firestoreRecipientUidDocs = [];
      firestoreRecipientRoleDocs = [];
      firestoreNotificationsLoading = false;
      firestoreNotificationsError = db
        ? ""
        : "Proposal notifications are unavailable because Firestore is not configured.";
      render();
      return;
    }

    firestoreNotificationsLoading = true;
    firestoreNotificationsError = "";
    firestoreLoadTimer = setTimeout(() => {
      firestoreLoadExpired = true;
      firestoreNotificationsLoading = false;
      firestoreNotificationsError = "Could not load notifications in time. Please check your connection and try again.";
      render();
    }, 15000);
    firestoreRecipientUidDocs = [];
    firestoreRecipientRoleDocs = [];
    const queryErrors = { recipientUid: "" };
    const settledQueries = new Set();
    const refreshFirestoreNotifications = () => {
      const merged = new Map();
      firestoreRecipientUidDocs.forEach((item) => {
        merged.set(item.id, { ...merged.get(item.id), ...item });
      });
      firestoreNotifications = [...merged.values()];
      firestoreNotificationsLoading = settledQueries.size < 1;
      firestoreNotificationsError = Object.values(queryErrors).find(Boolean) || "";
      render();
    };
    render();
    [
      ["recipientUid", query(collection(db, "notifications"), where("recipientUid", "==", uid))],
    ].forEach(([field, notificationQuery]) => {
      try {
        const unsubscribe = onFirestoreSnapshot(
          notificationQuery,
        (snapshot) => {
          if (firestoreLoadExpired) return;
          clearTimeout(firestoreLoadTimer);
          firestoreLoadTimer = null;
          try {
            const notifications = snapshot.docs.map((notification) => {
              const data = notification.data() || {};
              const timestamp = notificationDate(data.createdAt) || new Date();
              const dateOnly = typeof data.createdAt === "string" &&
                /^\d{4}-\d{2}-\d{2}$/.test(data.createdAt.trim());
              return {
                id: notification.id,
                eventId: data.proposalId || data.eventId || "",
                proposalId: data.proposalId || data.eventId || "",
                type: data.type || "approval",
                title: data.title || "Proposal Update",
                message: data.message || "",
                createdAt: dateOnly ? data.createdAt : timestamp.toISOString(),
                read: data.read === true,
                source: "firestore",
                organizationCodes: Array.isArray(data.organizationCodes)
                  ? data.organizationCodes
                  : [],
                departmentCodes: Array.isArray(data.departmentCodes)
                  ? data.departmentCodes
                  : [],
                openForAll: data.openForAll === true,
              };
            });
            if (field === "recipientUid") firestoreRecipientUidDocs = notifications;
            else firestoreRecipientRoleDocs = notifications;
            settledQueries.add(field);
            queryErrors[field] = "";
            refreshFirestoreNotifications();
          } catch (error) {
            console.error("Could not process Firestore admin notifications:", error);
            settledQueries.add(field);
            queryErrors[field] = "Could not display Firestore notifications. Please retry.";
            refreshFirestoreNotifications();
          }
        },
        (error) => {
          if (firestoreLoadExpired) return;
          clearTimeout(firestoreLoadTimer);
          firestoreLoadTimer = null;
          console.error("Could not load Firestore admin notifications:", error);
          settledQueries.add(field);
          queryErrors[field] = "Could not load all Firestore notifications. Check your connection and permissions.";
          refreshFirestoreNotifications();
        },
      );
        firestoreNotifUnsubscribes.push(unsubscribe);
      } catch (error) {
        console.error("Could not subscribe to Firestore admin notifications:", error);
        settledQueries.add(field);
        queryErrors[field] = "Could not load all Firestore notifications. Check your connection and permissions.";
        refreshFirestoreNotifications();
      }
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
        const count = Object.values(data).length;
        document.querySelectorAll("[data-queue-count]").forEach((b) => {
          b.textContent = String(count);
          b.hidden = count === 0;
        });
        queueLoaded = true;
        signalNotificationsPageReady();
      },
      (err) => {
        console.warn("RTDB queue error:", err);
        queueLoaded = true;
        signalNotificationsPageReady();
      },
    );
  }
  function hasConflict(event) {
    const date = (event.dateISO || event.date || "").slice(0, 10),
      venue = event.venue || event.location;
    if (!date || !venue || venue.startsWith("Others |")) return false;
    const parse = (value) => {
      const text = String(value || "");
      let m = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(text);
      if (m)
        return (
          ((+m[1] % 12) + (m[3].toUpperCase() === "PM" ? 12 : 0)) * 60 + +m[2]
        );
      m = /^(\d{1,2}):(\d{2})$/.exec(text);
      return m ? +m[1] * 60 + +m[2] : null;
    };
    const rooms = [
      "AVR2-1Room | PUP Biñan",
      "AVR2-2Room | PUP Biñan",
      "AVR2-3Room | PUP Biñan",
    ];
    const same = (a, b) =>
      a === b ||
      (a === "AVR2 | PUP Biñan" && rooms.includes(b)) ||
      (b === "AVR2 | PUP Biñan" && rooms.includes(a));
    const parts = String(event.time || "").split(/\s*[-–]\s*/),
      start = parse(event.startTime || parts[0]),
      end = parse(event.endTime || parts[1]);
    return getEvents().some((other) => {
      if (
        String(other.eventId || other.id) ===
          String(event.eventId || event.id) ||
        ["draft", "rejected", "cancelled", "canceled"].includes(status(other))
      )
        return false;
      if (
        (other.dateISO || other.date || "").slice(0, 10) !== date ||
        !same(venue, other.venue || other.location)
      )
        return false;
      const times = String(other.time || "").split(/\s*[-–]\s*/),
        a = parse(other.startTime || times[0]),
        b = parse(other.endTime || times[1]);
      return (
        start !== null &&
        end !== null &&
        a !== null &&
        b !== null &&
        start < b &&
        end > a
      );
    });
  }
  function notificationDate(value) {
    if (value && typeof value.toDate === "function") return value.toDate();
    if (value && typeof value.toMillis === "function") return new Date(value.toMillis());
    if (value && typeof value.seconds === "number") return new Date(value.seconds * 1000);
    if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
    if (typeof value === "number" && Number.isFinite(value)) {
      const date = new Date(value);
      return Number.isFinite(date.getTime()) ? date : null;
    }
    if (typeof value === "string" && value.trim()) {
      const dateOnly = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (dateOnly) return new Date(+dateOnly[1], +dateOnly[2] - 1, +dateOnly[3]);
      const parsed = new Date(value);
      return Number.isFinite(parsed.getTime()) ? parsed : null;
    }
    return null;
  }
  function age(value) {
    const date = notificationDate(value);
    if (!date) return "";
    const now = new Date();
    const diff = Math.max(0, now.getTime() - date.getTime());
    if (diff < 60000) return "Just now";
    if (date.toDateString() === now.toDateString()) {
      const minutes = Math.floor(diff / 60000);
      return minutes < 60 ? `${minutes} minute${minutes === 1 ? "" : "s"} ago` : `${Math.floor(minutes / 60)} hours ago`;
    }
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
    const days = Math.floor(diff / 86400000);
    return days < 7 ? `${days} days ago` : `${Math.floor(days / 7)} weeks ago`;
  }
  function correctionRequestTime(request) {
    const millis = Number(request.createdAtMs);
    if (Number.isFinite(millis)) return millis;
    return notificationDate(request.createdAt)?.getTime() || 0;
  }
  function sortedCorrectionRequests(requests) {
    return [...requests].sort((a, b) =>
      correctionRequestTime(b) - correctionRequestTime(a) ||
      (notificationDate(b.createdAt)?.getTime() || 0) - (notificationDate(a.createdAt)?.getTime() || 0),
    );
  }
  function correctionRequestDate(request) {
    const date = notificationDate(request.createdAtMs ?? request.createdAt);
    return date
      ? new Intl.DateTimeFormat("en-US", {
          timeZone: "Asia/Manila",
          month: "short",
          day: "numeric",
          year: "numeric",
        }).format(date)
      : "Date unavailable";
  }
  function renderCorrectionPanel() {
    if (!correctionPanel || !correctionPanelOpen) return;
    const requests = sortedCorrectionRequests(sharedNotificationState.correctionRequests || []);
    const pending = requests.filter((request) => String(request.status || "").trim().toLowerCase() === "pending");
    const history = requests.filter((request) => ["approved", "resolved", "rejected"].includes(String(request.status || "").trim().toLowerCase()));
    const reviewCards = pending.map((request) => {
      const id = esc(request.id);
      const isSaving = correctionReviewPending.has(request.id);
      const actionsDisabled = correctionReviewPending.size > 0;
      const error = correctionReviewErrors.get(request.id);
      const note = correctionReviewNotes.get(request.id) || "";
      return `<article class="correction-review-card">
        <header><div><h3>${esc(request.requesterName || "Teacher")}</h3><p>${esc(request.requesterEmail || "")}</p></div><span class="correction-status is-pending">Pending</span></header>
        <dl><div><dt>Role</dt><dd>${esc(request.role || "Teacher")}</dd></div><div><dt>Field</dt><dd>${esc(request.fieldLabel || request.field || "Detail")}</dd></div><div><dt>Current value</dt><dd>${esc(request.currentValue ?? "")}</dd></div><div><dt>Requested value</dt><dd>${esc(request.requestedValue ?? "")}</dd></div></dl>
        <p class="correction-review-reason"><strong>Why it is wrong</strong><span>${esc(request.reason || "")}</span></p>
        <label class="correction-review-note">Reviewer note (optional)<textarea maxlength="300" rows="2" data-review-note="${id}" ${actionsDisabled ? "disabled" : ""}>${esc(note)}</textarea></label>
        <p class="correction-review-hint">Approving applies ${esc(request.fieldLabel || request.field || "")}: ${esc(request.requestedValue ?? "")} to the profile automatically.</p>
        ${error ? `<p class="correction-review-error" role="alert">${esc(error.message)}</p>` : ""}
        <div class="correction-review-actions"><button type="button" data-review-action="approve" data-request-id="${id}" ${actionsDisabled ? "disabled" : ""}>${isSaving ? "Saving..." : "Approve and update profile"}</button><button type="button" class="is-reject" data-review-action="reject" data-request-id="${id}" ${actionsDisabled ? "disabled" : ""}>Reject</button>${error?.unmapped ? `<button type="button" data-review-action="manual-resolved" data-request-id="${id}" ${actionsDisabled ? "disabled" : ""}>Mark resolved without updating</button>` : ""}</div>
      </article>`;
    }).join("");
    const historyCards = history.map((request) => {
      const status = String(request.status || "").trim().toLowerCase();
      const statusLabel = status === "approved" ? "Approved" : status === "resolved" ? "Resolved" : "Rejected";
      const statusClass = status === "approved" ? "resolved" : status;
      return `<article class="correction-history-card"><div><strong>${esc(request.requesterName || "Teacher")} - ${esc(request.fieldLabel || request.field || "Detail")}</strong><span>${esc(request.currentValue ?? "")} -&gt; ${esc(request.requestedValue ?? "")}</span><small>${esc(correctionRequestDate(request))}</small>${request.reviewNote ? `<p>${esc(request.reviewNote)}</p>` : ""}</div><span class="correction-status is-${statusClass}">${statusLabel}</span></article>`;
    }).join("");
    const loadingMarkup = sharedNotificationState.correctionRequestsLoading
      ? '<div role="status">Loading correction requests...</div>'
      : "";
    const errorMarkup = sharedNotificationState.correctionRequestsError
      ? `<div class="correction-review-state" role="alert"><p>${esc(sharedNotificationState.correctionRequestsError)}</p><button type="button" data-retry-correction-requests>Retry</button></div>`
      : "";
    const body = sharedNotificationState.correctionRequestsLoading
      ? loadingMarkup
      : errorMarkup || (requests.length
        ? `<section class="correction-pending-list" aria-label="Pending correction requests">${reviewCards || '<p class="correction-review-empty">No pending correction requests.</p>'}</section>${history.length ? `<details class="correction-history"${correctionHistoryExpanded ? " open" : ""}><summary>History (${history.length})</summary><div>${historyCards}</div></details>` : ""}`
        : '<p class="correction-review-empty">No correction requests</p>');
    correctionPanel.innerHTML = `<div class="correction-review-dialog" role="dialog" aria-modal="true" aria-labelledby="correctionReviewTitle"><header class="correction-review-header"><div><h2 id="correctionReviewTitle">Teacher correction requests</h2><p>Review and record a decision.</p></div><button type="button" class="correction-review-close" data-close-correction-panel aria-label="Close review panel" ${correctionReviewPending.size ? "disabled" : ""}>&times;</button></header><div class="correction-review-content">${body}</div></div>`;
    correctionPanel.querySelector("[data-close-correction-panel]").onclick = closeCorrectionPanel;
    correctionPanel.onclick = (event) => {
      if (event.target === correctionPanel && !correctionReviewPending.size) closeCorrectionPanel();
    };
    correctionPanel.querySelectorAll("[data-review-note]").forEach((textarea) => {
      textarea.oninput = () => correctionReviewNotes.set(textarea.dataset.reviewNote, textarea.value);
    });
    correctionPanel.querySelectorAll("[data-review-action]").forEach((button) => {
      button.onclick = () => reviewCorrectionRequest(button.dataset.requestId, button.dataset.reviewAction);
    });
    correctionPanel.querySelectorAll("[data-retry-correction-requests]").forEach((button) => {
      button.onclick = () => notificationController
        ? notificationController.retryCorrectionRequests()
        : startSharedNotificationData();
    });
    const historyDetails = correctionPanel.querySelector(".correction-history");
    if (historyDetails) {
      historyDetails.ontoggle = () => { correctionHistoryExpanded = historyDetails.open; };
    }
  }
  function openCorrectionPanel() {
    correctionPanelReturnFocus = document.activeElement;
    correctionPanelOpen = true;
    correctionPanel.hidden = false;
    renderCorrectionPanel();
    correctionPanel.querySelector("[data-close-correction-panel]")?.focus();
  }
  function closeCorrectionPanel() {
    if (correctionReviewPending.size) return;
    correctionPanelOpen = false;
    correctionPanel.hidden = true;
    correctionPanelReturnFocus?.focus?.();
  }
  async function reviewCorrectionRequest(requestId, action) {
    const request = (sharedNotificationState.correctionRequests || []).find((item) => item.id === requestId);
    if (
      !request ||
      String(request.status || "").trim().toLowerCase() !== "pending" ||
      correctionReviewPending.size
    ) return;
    const previousError = correctionReviewErrors.get(requestId);
    if (action === "manual-resolved" && !previousError?.unmapped) return;
    if (action === "reject" && !window.confirm("Reject this correction request?")) return;
    const reviewNote = String(correctionReviewNotes.get(requestId) || "").trim().slice(0, 300);
    correctionReviewPending.add(requestId);
    correctionReviewErrors.delete(requestId);
    renderCorrectionPanel();
    try {
      if (action === "approve") {
        await approveCorrectionRequest(db, auth, requestId, reviewNote);
      } else if (action === "reject") {
        await rejectCorrectionRequest(db, auth, requestId, reviewNote);
      } else if (action === "manual-resolved") {
        await updateDoc(doc(db, "correctionRequests", requestId), {
          status: "resolved",
          reviewedBy: currentAdminUid,
          reviewedByName: currentAdminName,
          reviewedAt: serverTimestamp(),
          reviewNote: "Profile must be edited by hand.",
          updatedAt: serverTimestamp(),
        });
      } else {
        return;
      }
      correctionReviewNotes.delete(requestId);
      showCorrectionToast(
        action === "approve"
          ? "Correction approved and profile updated."
          : action === "manual-resolved"
            ? "Request marked resolved without updating the profile."
            : "Request rejected.",
      );
    } catch (error) {
      if (DEBUG) console.debug("[correction-review] update failed", error.code || error);
      const unmapped = action === "approve" &&
        error?.message === "This field can't be updated automatically.";
      const permissionDenied = error?.code === "permission-denied" ||
        error?.code === "firestore/permission-denied";
      const message = permissionDenied
        ? "Firestore rules do not allow this write. No changes were made."
        : error?.message || "Couldn't save the review. Check your connection and try again.";
      correctionReviewErrors.set(requestId, {
        message,
        unmapped: unmapped || (action === "manual-resolved" && previousError?.unmapped),
      });
    } finally {
      correctionReviewPending.delete(requestId);
      renderCorrectionPanel();
    }
  }
  function showCorrectionToast(message, retry) {
    const toast = document.querySelector(".admin-toast");
    if (!toast) return;
    toast.innerHTML = `${esc(message)}${retry ? ' <button type="button">Retry</button>' : ""}`;
    toast.hidden = false;
    const button = toast.querySelector("button");
    if (button) button.onclick = retry;
    if (!retry) setTimeout(() => { toast.hidden = true; }, 5000);
  }
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && correctionPanelOpen) closeCorrectionPanel();
  });
  function notificationGroup(item) {
    const date = notificationDate(item.createdAt);
    if (!date) return "Earlier";
    const today = new Date();
    if (date.toDateString() === today.toDateString()) return "Today";
    const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    start.setDate(start.getDate() - start.getDay());
    return date >= start ? "This week" : "Earlier";
  }
  function notificationTag(type) {
    return ({
      approval: "Approval",
      "final-documents": "Final documents",
      reschedule: "Reschedule request",
      cancellation: "Cancellation",
      conflict: "Venue conflict",
      decision: "Review decision",
      "correction-request": "Correction request",
    })[type] || "";
  }
  function notificationIcon(type) {
    if (type === "approval" || type === "decision") {
      return '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m4 10 4 4 8-8"/></svg>';
    }
    if (type === "final-documents" || type === "reschedule" || type === "cancellation" || type === "conflict") {
      return '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="3" y="4" width="14" height="13" rx="1.5"/><path d="M3 8h14M7 2.5v3M13 2.5v3"/></svg>';
    }
    return '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M16 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M8 20a2 2 0 0 0 4 0"/></svg>';
  }
  function renderAdminCard(item, inTrash = false) {
    const date = notificationDate(item.createdAt);
    const dateText = date ? new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(date) : "";
    const timeText = age(item.createdAt);
    const id = esc(item.id);
    const tag = notificationTag(item.type);
    const controls = inTrash
      ? `<button type="button" data-restore="${id}" ${pendingWrites.has(item.id) ? "disabled" : ""}>Restore</button><button type="button" data-permanent="${id}" ${pendingWrites.has(item.id) ? "disabled" : ""}>Delete forever</button><small>Removed in ${Math.max(0, Math.ceil((item.expiresAt - Date.now()) / lifetime))} days</small>`
      : `<button class="notification-read-toggle" type="button" data-toggle-read="${id}" aria-label="Mark as ${item.read ? "unread" : "read"}" title="Mark as ${item.read ? "unread" : "read"}" ${pendingWrites.has(item.id) ? "disabled" : ""}><span aria-hidden="true"></span></button><button class="notification-trash-toggle" type="button" data-delete="${id}" aria-label="Move to Recently Deleted" title="Move to Recently Deleted" ${pendingWrites.has(item.id) ? "disabled" : ""}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 6h12M8 6V4.5h4V6m-6.5 0 .7 10h7.6l-.7-10M8.5 9v4m3-4v4"/></svg></button>`;
    return `<article class="admin-notification-card notification-card ${item.read ? "is-read" : "is-unread"}" data-notification="${id}" ${inTrash ? "" : 'tabindex="0"'} aria-label="${esc(item.title)}, ${item.read ? "read" : "unread"}">
      <span class="notification-icon" aria-hidden="true">${notificationIcon(item.type)}</span>
      <span class="notification-copy"><strong class="notification-title">${esc(item.title)}</strong><span class="notification-message">${esc(item.message)}</span><span class="notification-meta">${tag ? `<span class="notification-tag">${esc(tag)}</span>` : ""}${dateText ? `<time>${esc(dateText)}</time>` : ""}${timeText ? `<span>${esc(timeText)}</span>` : ""}</span>${inTrash ? `<span class="notification-trash-actions">${controls}</span>` : ""}</span>
      ${inTrash ? "" : `<span class="notification-card-actions">${controls}</span>`}
    </article>`;
  }
  function render() {
    try {
      let live = snapshots(),
        trash = sharedNotificationState.trash.filter((item) => item.expiresAt > Date.now());
      const retainedTrash = read(trashKey, []).filter((item) => item.expiresAt > Date.now());
      localStorage.setItem(trashKey, JSON.stringify(retainedTrash));
      const source = deleted ? trash : live;
      const visible = source.filter(
        (item) =>
          (!search ||
            `${item.title} ${item.message}`
              .toLowerCase()
              .includes(search.toLowerCase())) &&
          (deleted ||
            filter === "all" ||
            (filter === "read" ? item.read : !item.read)),
      );
      const unreadCount = sharedNotificationState.unreadCount;
      const pendingCorrectionCount = (sharedNotificationState.correctionRequests || [])
        .filter((request) => String(request.status || "").trim().toLowerCase() === "pending").length;
      const correctionReviewButton = deleted
        ? ""
        : `<button type="button" class="correction-review-open" data-open-corrections>Review correction requests${pendingCorrectionCount ? ` (${pendingCorrectionCount})` : ""}</button>`;
      const visibleMarkup = deleted
        ? ["Today", "This week", "Earlier"].map((group) => {
            const items = visible.filter((item) => notificationGroup(item) === group);
            return items.length
              ? `<section class="notification-group"><h2>${group.toUpperCase()}</h2><ul class="notification-list">${items.map((item) => `<li>${renderAdminCard(item, true)}</li>`).join("")}</ul></section>`
              : "";
          }).join("")
        : ["Today", "This week", "Earlier"].map((group) => {
            const items = visible.filter((item) => notificationGroup(item) === group);
            return items.length
              ? `<section class="notification-group"><h2>${group.toUpperCase()}</h2><ul class="notification-list">${items.map((item) => `<li>${renderAdminCard(item)}</li>`).join("")}</ul></section>`
              : "";
          }).join("");
      const emptyMarkup = `<div class="notification-state"><span class="notification-state-icon" aria-hidden="true">${notificationIcon("default")}</span><strong>${deleted ? "Recently Deleted is empty" : filter === "unread" ? "No unread notifications" : "You have no notifications"}</strong><p>${deleted ? "Notifications you delete will wait here for 30 days before they are removed." : filter === "unread" ? "Everything has been read. Nice work." : "New notifications will show up here."}</p></div>`;
      root.innerHTML = `<section class="admin-notifications"><header class="notifications-header"><h1>Notifications</h1>${correctionReviewButton}</header><div class="notification-controls"><nav class="notification-tabs" aria-label="Notification view"><button type="button" data-filter="all" class="${filter !== "unread" ? "is-active" : ""}" aria-pressed="${filter !== "unread"}">All</button><button type="button" data-filter="unread" class="${filter === "unread" ? "is-active" : ""}" aria-pressed="${filter === "unread"}">Unread <span>${unreadCount}</span></button></nav><label class="notification-read-filter">Show <select id="notificationReadFilter" aria-label="Show notifications"><option value="all" ${filter === "all" || filter === "unread" ? "selected" : ""}>All</option><option value="read" ${filter === "read" ? "selected" : ""}>Read</option></select></label><div class="notification-actions"><button type="button" id="markRead" ${deleted ? (trash.length ? "" : "disabled") : (unreadCount ? "" : "disabled")}>${deleted ? "Empty trash" : "Mark all as read"}</button><button type="button" id="toggleTrash" class="notification-trash-button${deleted ? " is-active" : ""}" aria-label="${deleted ? "Return to notifications" : "Open Recently Deleted"}" aria-pressed="${deleted}" title="Recently Deleted"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 6h12M8 6V4.5h4V6m-6.5 0 .7 10h7.6l-.7-10M8.5 9v4m3-4v4"/></svg></button></div></div><label class="notification-search"><span>Search notifications</span><input id="notificationSearch" type="search" placeholder="Search notifications" aria-label="Search notifications" value="${esc(search)}"></label><section class="admin-section"><div class="admin-cards">${visibleMarkup || emptyMarkup}</div></section></section>`;
      if (sharedNotificationState.error) {
        root.insertAdjacentHTML(
          "afterbegin",
          `<div class="admin-error" role="alert">${esc(sharedNotificationState.error)}${currentAdminUid ? ' <button class="admin-row-action" id="retryFirestoreNotifications">Retry</button>' : ""}</div>`,
        );
      } else if (sharedNotificationState.loading) {
        root.insertAdjacentHTML(
          "afterbegin",
          '<div class="admin-loading" role="status">Loading notifications...</div>',
        );
      }
      wire();
      renderCorrectionPanel();
    } catch (error) {
      root.innerHTML =
        '<div class="admin-error">Could not load notifications. <button class="admin-row-action" id="retryNotifications">Retry</button></div>';
      root.querySelector("#retryNotifications").onclick = render;
    }
  }
  function save(list) {
    localStorage.setItem(key, JSON.stringify(list));
    notificationController?.refresh();
  }
  function saveTrash(list) {
    localStorage.setItem(trashKey, JSON.stringify(list));
    notificationController?.refresh();
  }
  function rememberPermanentDeletion(ids) {
    const storageKey = `recovibeAdminPermanentlyDeleted:${currentAdminUid}`;
    const saved = read(storageKey, []);
    const values = new Set(Array.isArray(saved) ? saved.map(String) : []);
    ids.forEach((id) => values.add(String(id)));
    localStorage.setItem(storageKey, JSON.stringify([...values]));
    notificationController?.refresh();
  }
  async function setReadState(item, readState) {
    if (!item || pendingWrites.has(item.id)) return false;
    pendingWrites.add(item.id);
    render();
    try {
      if (notificationController) await notificationController.setReadState(item, readState);
      return true;
    } catch (error) {
      console.error("Could not update notification read state:", error);
      window.alert("This notification could not be updated. Please try again.");
      return false;
    } finally {
      pendingWrites.delete(item.id);
      render();
    }
  }
  async function permanentlyDelete(item) {
    if (!item || pendingWrites.has(item.id)) return false;
    pendingWrites.add(item.id);
    render();
    try {
      if (item.source === "firestore") await deleteDoc(doc(db, "notifications", item.id));
      if (item.source === "rtdb" && currentAdminUid && rtdb) {
        await remove(ref(rtdb, `notifications/${currentAdminUid}/${item.id}`));
      }
      saveTrash(read(trashKey, []).filter((entry) => entry.id !== item.id));
      rememberPermanentDeletion([item.id]);
      return true;
    } catch (error) {
      console.error("Could not permanently delete notification:", error);
      window.alert("This notification could not be permanently deleted. Please try again.");
      return false;
    } finally {
      pendingWrites.delete(item.id);
      render();
    }
  }
  function wire() {
    const openCorrectionsButton = root.querySelector("[data-open-corrections]");
    if (openCorrectionsButton) openCorrectionsButton.onclick = openCorrectionPanel;
    const retryFirestoreNotifications = root.querySelector(
      "#retryFirestoreNotifications",
    );
    if (retryFirestoreNotifications) {
      retryFirestoreNotifications.onclick = () =>
        notificationController ? notificationController.retry() : startSharedNotificationData();
    }
    root.querySelector("#notificationSearch").oninput = (event) => {
      search = event.target.value;
      render();
    };
    root.querySelectorAll("[data-filter]").forEach(
      (button) =>
        (button.onclick = () => {
          filter = button.dataset.filter;
          render();
        }),
    );
    root.querySelector("#notificationReadFilter").onchange = (event) => {
      filter = event.target.value;
      render();
    };
    root.querySelector("#toggleTrash").onclick = () => {
      deleted = !deleted;
      render();
    };
    root.querySelector("#markRead").onclick = async () => {
      if (deleted) {
        const trash = sharedNotificationState.trash;
        const count = trash.length;
        if (!count || !window.confirm(`Permanently delete all ${count} notifications? This cannot be undone.`)) return;
        root.querySelector("#markRead").disabled = true;
        for (const item of trash) await permanentlyDelete(item);
        render();
        return;
      }
      const list = snapshots();
      const unread = list.filter((item) => !item.read);
      if (!unread.length) return;
      undoSnapshot = list.map((item) => ({ ...item }));
      undoDeleteItem = null;
      root.querySelector("#markRead").disabled = true;
      try {
        for (const item of unread) await setReadState(item, true);
        toastUndo("All notifications marked as read.");
      } catch (error) {
        console.error("Could not mark notifications as read:", error);
        window.alert("Some notifications could not be marked as read. Please try again.");
      }
      render();
    };
    root.querySelectorAll("[data-delete]").forEach(
      (button) =>
        (button.onclick = (event) => {
          event.stopPropagation();
          const item = snapshots().find((note) => note.id === button.dataset.delete);
          if (!item) return;
          const list = read(key, []);
          save(list.filter((note) => note.id !== item.id));
          const trash = read(trashKey, []);
          const moved = {
            ...item,
            deletedAt: Date.now(),
            expiresAt: Date.now() + lifetime,
          };
          trash.unshift(moved);
          saveTrash(trash);
          undoSnapshot = null;
          undoDeleteItem = moved;
          toastUndo("Moved to Recently Deleted.");
          render();
        }),
    );
    root.querySelectorAll("[data-restore]").forEach(
      (button) =>
        (button.onclick = () => {
          const trash = read(trashKey, []),
            item = trash.find((note) => note.id === button.dataset.restore);
          if (!item) return;
          const { deletedAt, expiresAt, ...rest } = item;
          const list = read(key, []);
          if (!list.some((entry) => entry.id === rest.id)) list.unshift(rest);
          save(list);
          saveTrash(trash.filter((note) => note.id !== item.id));
          render();
        }),
    );
    root.querySelectorAll("[data-permanent]").forEach(
      (button) =>
        (button.onclick = async () => {
          const item = read(trashKey, []).find((entry) => entry.id === button.dataset.permanent);
          if (!item || !window.confirm("Permanently delete this notification? This cannot be undone.")) return;
          await permanentlyDelete(item);
        }),
    );
    root.querySelectorAll("[data-toggle-read]").forEach((button) => {
      button.onclick = async (event) => {
        event.stopPropagation();
        const item = snapshots().find((entry) => entry.id === button.dataset.toggleRead);
        if (item) await setReadState(item, !item.read);
      };
    });
    root.querySelectorAll("[data-notification]").forEach((card) => {
      card.onclick = async (event) => {
        if (event.target.closest("button")) return;
        const item = snapshots().find((note) => note.id === card.dataset.notification);
        if (!item) return;
        const updated = await setReadState(item, true);
        if (!updated) return;
        if (item.type === "correction-request") {
          openCorrectionPanel();
          return;
        }
        const proposalId = item.proposalId || item.eventId;
        if (proposalId) {
          const reviewUrl = new URL("AdminApproval.html", window.location.href);
          reviewUrl.searchParams.set("review", proposalId);
          if (item.source === "firestore") {
            reviewUrl.searchParams.set("source", "firestore");
          }
          location.href = reviewUrl.href;
        }
      };
      card.onkeydown = (event) => {
        if (event.target.closest("button, a, input, select")) return;
        if (["Enter", " "].includes(event.key)) {
          event.preventDefault();
          card.click();
        }
      };
    });
  }
  function issueType(type) {
    return (
      {
        approval: "pending_approval",
        "final-documents": "final_documents_submitted",
        reschedule: "reschedule_request",
        cancellation: "cancellation",
        conflict: "venue_conflict",
      }[type] || "pending_approval"
    );
  }
  function toastUndo(message) {
    const toast = document.querySelector(".admin-toast");
    toast.innerHTML = `${esc(message)} <button type="button">Undo</button>`;
    toast.hidden = false;
    clearTimeout(undoTimer);
    toast.querySelector("button").onclick = async () => {
      if (undoDeleteItem) {
        const moved = undoDeleteItem;
        const trash = read(trashKey, []).filter((item) => item.id !== moved.id);
        const list = read(key, []);
        if (!list.some((item) => item.id === moved.id)) {
          const { deletedAt, expiresAt, ...restored } = moved;
          list.unshift(restored);
        }
        saveTrash(trash);
        save(list);
        undoDeleteItem = null;
        render();
      } else if (undoSnapshot) {
        try {
          if (currentAdminUid && rtdb) {
            const updates = {};
            undoSnapshot
              .filter((item) => item.source === "rtdb")
              .forEach((item) => {
                updates[`notifications/${currentAdminUid}/${item.id}/read`] = item.read === true;
              });
            if (Object.keys(updates).length) await update(ref(rtdb), updates);
          }
          await Promise.all(
            undoSnapshot
              .filter((item) => item.source === "firestore")
              .map((item) => updateDoc(doc(db, "notifications", item.id), { read: item.read })),
          );
        } catch (error) {
          console.error("Could not restore Firestore notification read states:", error);
          window.alert("Could not undo the notification read changes. Please refresh and try again.");
          return;
        }
        save(undoSnapshot);
        undoSnapshot = null;
        render();
      }
      toast.hidden = true;
    };
    undoTimer = setTimeout(() => {
      undoDeleteItem = null;
      toast.hidden = true;
    }, 6000);
  }
  window.addEventListener("storage", (event) => {
    if (!event.key || event.key === key || event.key.includes("Events"))
      render();
  });
  window.addEventListener("focus", render);

  root.innerHTML = '<div class="admin-loading" role="status">Verifying Admin access…</div>';
  authStartupTimer = setTimeout(() => {
    authStartupExpired = true;
    root.innerHTML = '<div class="admin-error" role="alert">Could not verify your Admin access in time. <button class="admin-row-action" type="button" id="retryNotifications">Try again</button></div>';
    root.querySelector("#retryNotifications").addEventListener("click", () => window.location.reload());
    if (!pageLoadSignaled) {
      pageLoadSignaled = true;
      window.dispatchEvent(new Event("page-data-ready"));
    }
  }, 9000);
  let stopAuthListener = null;
  if (auth) {
    authStateHandler = async (user) => {
      if (authStartupExpired) return;
      if (user) {
        try {
          await authReady;
          if (authStartupExpired) return;
          await auth.authStateReady();
          if (authStartupExpired) return;
          if (auth.currentUser?.uid !== user.uid || !db) return;
          try {
            const cachedProfile = JSON.parse(localStorage.getItem("recovibeAdminProfile") || "null");
            if (cachedProfile?.uid === user.uid) {
              const cachedName = String(
                cachedProfile.name ||
                  [cachedProfile.firstName, cachedProfile.middleName, cachedProfile.lastName].filter(Boolean).join(" "),
              ).trim();
              if (cachedName) {
                document.querySelector("[data-name]").textContent = cachedName.toUpperCase();
                document.querySelector("[data-avatar]").textContent = cachedName
                  .split(/\s+/)
                  .slice(0, 2)
                  .map((part) => part[0])
                  .join("")
                  .toUpperCase();
              }
              const cachedRole = getApprovalPosition(cachedProfile);
              if (cachedRole) {
                const roleElement = document.querySelector("[data-role]");
                roleElement.textContent = cachedRole;
                roleElement.title = cachedRole;
              }
            }
          } catch (error) {
            console.warn("Could not read the cached Admin profile for notifications:", error);
          }
          const [adminResult, userResult] = await Promise.allSettled([
            getDoc(doc(db, "adminUser", user.uid)),
            getDoc(doc(db, "users", user.uid)),
          ]);
          if (authStartupExpired) return;
          const adminProfile = adminResult.status === "fulfilled" && adminResult.value.exists()
            ? adminResult.value.data()
            : {};
          const userProfile = userResult.status === "fulfilled" && userResult.value.exists()
            ? userResult.value.data()
            : {};
          if (adminResult.status === "rejected" && userResult.status === "rejected") {
            throw adminResult.reason;
          }
          profile = { ...userProfile, ...adminProfile };
          const role = String(profile.role || profile.userRole || "").trim().toLowerCase().replace(/[\s_-]+/g, "");
          const canAccessNotifications = ["admin", "superadmin", "systemadmin", "systemwideadmin"].includes(role) ||
            profile.isSuperAdmin === true ||
            profile.isSystemAdmin === true ||
            role === "osas" ||
            getApprovalPosition(profile).toLowerCase().includes("osas");
          if (!canAccessNotifications) {
            clearTimeout(authStartupTimer);
            authStartupTimer = null;
            await signOut(auth);
            location.replace("AdminLogin.html");
            return;
          }
          const name = profile.name || [profile.firstName, profile.middleName, profile.lastName].filter(Boolean).join(" ") || user.displayName || user.email?.split("@")[0] || "";
          currentAdminName = String(name).trim();
          document.querySelector("[data-name]").textContent = name.toUpperCase();
          document.querySelector("[data-avatar]").textContent = name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
          const roleElement = document.querySelector("[data-role]");
          roleElement.textContent = getApprovalPosition(profile);
          roleElement.title = roleElement.textContent;
        } catch (error) {
          clearTimeout(authStartupTimer);
          authStartupTimer = null;
          console.error("Could not verify notification-page Admin access:", error);
          root.innerHTML = '<div class="admin-error" role="alert">Could not verify your Admin access. <button class="admin-row-action" type="button" id="retryNotifications">Try again</button></div>';
          root.querySelector("#retryNotifications").addEventListener("click", () => window.location.reload());
          if (!pageLoadSignaled) {
            pageLoadSignaled = true;
            window.dispatchEvent(new Event("page-data-ready"));
          }
          return;
        }
        currentAdminUid = user.uid;
        currentAdminEmail = String(user.email || "").trim().toLowerCase();
        key = `recovibeAdminNotifications:${currentAdminUid}`;
        trashKey = `recovibeAdminDeletedNotifications:${currentAdminUid}`;
        clearTimeout(authStartupTimer);
        authStartupTimer = null;
        if (auth.currentUser?.uid !== user.uid) return;
        if (!notificationController) await startSharedNotificationData();
        subscribeToQueue(user.uid);
      } else {
        clearTimeout(authStartupTimer);
        authStartupTimer = null;
        location.replace("AdminLogin.html");
      }
    };
    stopAuthListener = onAuthStateChanged(auth, authStateHandler);
  } else {
    clearTimeout(authStartupTimer);
    authStartupTimer = null;
    location.replace("AdminLogin.html");
  }
  const stopPageListeners = () => {
    clearTimeout(authStartupTimer);
    clearTimeout(firestoreLoadTimer);
    if (notifListenerRef) off(notifListenerRef);
    if (queueListenerRef) off(queueListenerRef);
    firestoreNotifUnsubscribes.forEach((unsubscribe) => unsubscribe());
    stopAuthListener?.();
    stopAuthListener = null;
  };
  window.addEventListener("pagehide", stopPageListeners);
  window.addEventListener("pageshow", (event) => {
    if (event.persisted && auth && !stopAuthListener) {
      stopAuthListener = onAuthStateChanged(auth, authStateHandler);
    }
  });
})();
