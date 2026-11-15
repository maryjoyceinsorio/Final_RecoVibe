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
  updateDoc,
  where,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { auth, authReady, db, rtdb, isRtdbConfigured } from "../UserStudent/firebaseConfig.js";

(() => {
  "use strict";
  let profile = {};
  const root = document.getElementById("notificationRoot"),
    lifetime = 30 * 86400000;
  let filter = "all",
    deleted = false,
    search = "",
    undoSnapshot = null,
    undoTimer,
    currentAdminUid = null,
    currentAdminEmail = "",
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
    pendingWrites = new Set();
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
  function snapshots() {
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

  function subscribeToRtdbNotifications(uid) {
    if (!isRtdbConfigured || !rtdb || !uid) return;
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
      },
      (err) => {
        console.warn("RTDB queue error:", err);
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
    if (typeof value === "number" && Number.isFinite(value)) return new Date(value);
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
        trash = read(trashKey, []);
      trash = Array.isArray(trash)
        ? trash.filter((item) => item.expiresAt > Date.now())
        : [];
      localStorage.setItem(trashKey, JSON.stringify(trash));
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
      const unreadCount = live.filter((item) => !item.read).length;
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
      root.innerHTML = `<section class="admin-notifications"><header class="notifications-header"><h1>Notifications</h1></header><div class="notification-controls"><nav class="notification-tabs" aria-label="Notification view"><button type="button" data-filter="all" class="${filter !== "unread" ? "is-active" : ""}" aria-pressed="${filter !== "unread"}">All</button><button type="button" data-filter="unread" class="${filter === "unread" ? "is-active" : ""}" aria-pressed="${filter === "unread"}">Unread <span>${unreadCount}</span></button></nav><label class="notification-read-filter">Show <select id="notificationReadFilter" aria-label="Show notifications"><option value="all" ${filter === "all" || filter === "unread" ? "selected" : ""}>All</option><option value="read" ${filter === "read" ? "selected" : ""}>Read</option></select></label><div class="notification-actions"><button type="button" id="markRead" ${deleted ? (trash.length ? "" : "disabled") : (unreadCount ? "" : "disabled")}>${deleted ? "Empty trash" : "Mark all as read"}</button><button type="button" id="toggleTrash" class="notification-trash-button${deleted ? " is-active" : ""}" aria-label="${deleted ? "Return to notifications" : "Open Recently Deleted"}" aria-pressed="${deleted}" title="Recently Deleted"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 6h12M8 6V4.5h4V6m-6.5 0 .7 10h7.6l-.7-10M8.5 9v4m3-4v4"/></svg></button></div></div><label class="notification-search"><span>Search notifications</span><input id="notificationSearch" type="search" placeholder="Search notifications" aria-label="Search notifications" value="${esc(search)}"></label><section class="admin-section"><div class="admin-cards">${visibleMarkup || emptyMarkup}</div></section></section>`;
      if (firestoreNotificationsError) {
        root.insertAdjacentHTML(
          "afterbegin",
          `<div class="admin-error" role="alert">${esc(firestoreNotificationsError)}${currentAdminUid ? ' <button class="admin-row-action" id="retryFirestoreNotifications">Retry</button>' : ""}</div>`,
        );
      } else if (firestoreNotificationsLoading) {
        root.insertAdjacentHTML(
          "afterbegin",
          '<div class="admin-loading" role="status">Loading proposal notifications...</div>',
        );
      }
      document.querySelector("[data-notification-count]").textContent = String(unreadCount);
      document.querySelector("[data-notification-count]").hidden = !live.some(
        (item) => !item.read,
      );
      wire();
    } catch (error) {
      root.innerHTML =
        '<div class="admin-error">Could not load notifications. <button class="admin-row-action" id="retryNotifications">Retry</button></div>';
      root.querySelector("#retryNotifications").onclick = render;
    }
  }
  function save(list) {
    localStorage.setItem(key, JSON.stringify(list));
  }
  function saveTrash(list) {
    localStorage.setItem(trashKey, JSON.stringify(list));
  }
  function rememberPermanentDeletion(ids) {
    const storageKey = `recovibeAdminPermanentlyDeleted:${currentAdminUid}`;
    const saved = read(storageKey, []);
    const values = new Set(Array.isArray(saved) ? saved.map(String) : []);
    ids.forEach((id) => values.add(String(id)));
    localStorage.setItem(storageKey, JSON.stringify([...values]));
  }
  async function setReadState(item, readState) {
    if (!item || pendingWrites.has(item.id)) return false;
    pendingWrites.add(item.id);
    render();
    try {
      if (item.source === "firestore") {
        await updateDoc(doc(db, "notifications", item.id), { read: readState });
        firestoreNotifications = firestoreNotifications.map((entry) =>
          entry.id === item.id ? { ...entry, read: readState } : entry,
        );
      } else if (item.source === "rtdb" && currentAdminUid && rtdb) {
        await update(ref(rtdb, `notifications/${currentAdminUid}/${item.id}`), {
          read: readState,
        });
        rtdbNotifications = rtdbNotifications.map((entry) =>
          entry.id === item.id ? { ...entry, read: readState } : entry,
        );
      }
      const localList = read(key, []);
      const localItem = localList.find((entry) => entry.id === item.id);
      if (localItem) {
        localItem.read = readState;
        save(localList);
      }
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
    const retryFirestoreNotifications = root.querySelector(
      "#retryFirestoreNotifications",
    );
    if (retryFirestoreNotifications) {
      retryFirestoreNotifications.onclick = () =>
        subscribeToFirestoreNotifications(currentAdminUid);
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
        const trash = read(trashKey, []);
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
        if (currentAdminUid && rtdb) {
        const updates = {};
        rtdbNotifications.forEach((it) => {
          if (!it.read) updates[`notifications/${currentAdminUid}/${it.id}/read`] = true;
        });
        if (Object.keys(updates).length > 0) {
            await update(ref(rtdb), updates);
          }
        }
        if (db && currentAdminUid) {
          await Promise.all(
            firestoreNotifications
              .filter((item) => !item.read)
              .map((item) => updateDoc(doc(db, "notifications", item.id), { read: true })),
          );
        }
        const localList = read(key, []);
        save(localList.map((item) => ({ ...item, read: true })));
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
  }, 15000);
  let stopAuthListener = null;
  if (auth) {
    stopAuthListener = onAuthStateChanged(auth, async (user) => {
      if (authStartupExpired) return;
      if (user) {
        try {
          await authReady;
          if (authStartupExpired) return;
          await auth.authStateReady();
          if (authStartupExpired) return;
          if (auth.currentUser?.uid !== user.uid || !db) return;
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
          if (role !== "admin") {
            clearTimeout(authStartupTimer);
            authStartupTimer = null;
            await signOut(auth);
            location.replace("AdminLogin.html");
            return;
          }
          const name = profile.name || [profile.firstName, profile.middleName, profile.lastName].filter(Boolean).join(" ") || user.displayName || user.email?.split("@")[0] || "";
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
          return;
        }
        currentAdminUid = user.uid;
        currentAdminEmail = String(user.email || "").trim().toLowerCase();
        key = `recovibeAdminNotifications:${currentAdminUid}`;
        trashKey = `recovibeAdminDeletedNotifications:${currentAdminUid}`;
        currentAdminOrganizationCodes = getNotificationProfileValues(profile, [
          "organizationCode",
          "organizationId",
          "orgCode",
          "orgId",
          "organization",
          "organizationName",
          "orgName",
          "organizations",
          "courseOrganization",
          "courseOrganizations",
        ]);
        currentAdminDepartmentCodes = getNotificationProfileValues(profile, [
          "departmentCode",
          "departmentId",
          "department",
          "departments",
          "departmentIds",
          "course",
        ]);
        if (db) {
          try {
            const [adminProfileSnapshot, approverOrganizationSnapshot] =
              await Promise.all([
                getDoc(doc(db, "adminUser", user.uid)),
                getDoc(doc(db, "approverOrganizations", user.uid)),
              ]);
            if (authStartupExpired) return;
            if (auth.currentUser?.uid !== user.uid) return;
            const adminProfile = adminProfileSnapshot.exists()
              ? adminProfileSnapshot.data() || {}
              : {};
            const approverOrganization = approverOrganizationSnapshot.exists()
              ? approverOrganizationSnapshot.data() || {}
              : {};
            currentAdminOrganizationCodes = [
              ...new Set([
                ...currentAdminOrganizationCodes,
                ...getNotificationProfileValues(adminProfile, [
                  "organizationCode",
                  "organizationId",
                  "orgCode",
                  "orgId",
                  "organization",
                  "organizationName",
                  "orgName",
                  "organizations",
                  "courseOrganization",
                  "courseOrganizations",
                ]),
                ...getNotificationProfileValues(approverOrganization, [
                  "organizationCode",
                  "organizationId",
                  "orgCode",
                  "orgId",
                  "organization",
                  "organizationName",
                  "orgName",
                  "organizations",
                ]),
              ]),
            ];
            currentAdminDepartmentCodes = [
              ...new Set([
                ...currentAdminDepartmentCodes,
                ...getNotificationProfileValues(adminProfile, [
                  "departmentCode",
                  "departmentId",
                  "department",
                  "departments",
                  "departmentIds",
                  "course",
                ]),
              ]),
            ];
          } catch (error) {
            if (authStartupExpired) return;
            console.error("Could not load the signed-in admin's organization profile:", error);
          }
        }
        clearTimeout(authStartupTimer);
        authStartupTimer = null;
        if (auth.currentUser?.uid !== user.uid) return;
        render();
        subscribeToRtdbNotifications(user.uid);
        subscribeToFirestoreNotifications(user.uid);
        subscribeToQueue(user.uid);
      } else {
        clearTimeout(authStartupTimer);
        authStartupTimer = null;
        location.replace("AdminLogin.html");
      }
    });
  } else {
    clearTimeout(authStartupTimer);
    authStartupTimer = null;
    location.replace("AdminLogin.html");
  }
  window.addEventListener("beforeunload", () => {
    clearTimeout(authStartupTimer);
    clearTimeout(firestoreLoadTimer);
    if (notifListenerRef) off(notifListenerRef);
    if (queueListenerRef) off(queueListenerRef);
    firestoreNotifUnsubscribes.forEach((unsubscribe) => unsubscribe());
    stopAuthListener?.();
  });
})();
