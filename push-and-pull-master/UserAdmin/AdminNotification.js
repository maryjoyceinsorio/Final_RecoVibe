import {
  ref,
  onValue,
  off,
  update,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  collection,
  doc,
  getDoc,
  onSnapshot as onFirestoreSnapshot,
  query,
  updateDoc,
  where,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { auth, db, rtdb, isRtdbConfigured } from "../UserStudent/firebaseConfig.js";

(() => {
  "use strict";
  const profile = read("recovibeAdminProfile", null),
    identity = localStorage.getItem("recovibeAdminId");
  if (
    !profile ||
    String(profile.role || "").toLowerCase() !== "admin" ||
    !identity
  ) {
    location.replace("AdminLogin.html");
    return;
  }
  const root = document.getElementById("notificationRoot"),
    key = "recovibeAdminNotifications",
    trashKey = "recovibeAdminDeletedNotifications",
    lifetime = 30 * 86400000;
  let filter = "all",
    deleted = false,
    search = "",
    undoSnapshot = null,
    undoTimer,
    currentAdminUid = null,
    currentAdminOrganizationCodes = [],
    currentAdminDepartmentCodes = [],
    rtdbNotifications = [],
    firestoreNotifications = [],
    firestoreNotificationsLoading = false,
    firestoreNotificationsError = "",
    notifListenerRef = null,
    queueListenerRef = null,
    firestoreNotifUnsubscribe = null;
  document.querySelector("[data-name]").textContent = (
    profile.name || identity
  ).toUpperCase();
  document.querySelector("[data-avatar]").textContent = (profile.name || "HA")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0])
    .join("")
    .toUpperCase();
  document.querySelector("[data-role]").textContent =
    "Head of Academic Programs";
  document.querySelector("[data-today]").textContent =
    new Date().toLocaleDateString("en-US", {
      timeZone: "Asia/Manila",
      month: "long",
      day: "numeric",
      year: "numeric",
    });
  document.querySelector(".admin-logout").onclick = () =>
    localStorage.removeItem("recovibeAdminId");
  function read(name, fallback) {
    try {
      return JSON.parse(localStorage.getItem(name) || "null") ?? fallback;
    } catch {
      return fallback;
    }
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
        .filter((entry) => String(entry.by) === String(identity))
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
    next.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    localStorage.setItem(key, JSON.stringify(next));
    return next.filter(notificationVisibleToAdmin);
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
          createdAt: val.createdAt
            ? new Date(val.createdAt).toISOString()
            : new Date().toISOString(),
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
    if (firestoreNotifUnsubscribe) {
      firestoreNotifUnsubscribe();
      firestoreNotifUnsubscribe = null;
    }
    if (!db || !uid) {
      firestoreNotifications = [];
      firestoreNotificationsLoading = false;
      firestoreNotificationsError = db
        ? ""
        : "Proposal notifications are unavailable because Firestore is not configured.";
      render();
      return;
    }

    firestoreNotificationsLoading = true;
    firestoreNotificationsError = "";
    render();
    try {
      const notificationQuery = query(
        collection(db, "notifications"),
        where("recipientUid", "==", uid),
      );
      firestoreNotifUnsubscribe = onFirestoreSnapshot(
        notificationQuery,
        (snapshot) => {
          try {
            firestoreNotifications = snapshot.docs.map((notification) => {
              const data = notification.data() || {};
              const timestamp = data.createdAt?.toDate
                ? data.createdAt.toDate()
                : new Date(data.createdAt || Date.now());
              return {
                id: notification.id,
                eventId: data.proposalId || data.eventId || "",
                proposalId: data.proposalId || data.eventId || "",
                type: data.type || "approval",
                title: data.title || "Proposal Update",
                message: data.message || "",
                createdAt: Number.isNaN(timestamp.getTime())
                  ? new Date().toISOString()
                  : timestamp.toISOString(),
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
            firestoreNotificationsLoading = false;
            firestoreNotificationsError = "";
            render();
          } catch (error) {
            console.error("Could not process Firestore admin notifications:", error);
            firestoreNotificationsLoading = false;
            firestoreNotificationsError =
              "Could not display proposal notifications. Please retry.";
            render();
          }
        },
        (error) => {
          console.error("Could not load Firestore admin notifications:", error);
          firestoreNotificationsLoading = false;
          firestoreNotificationsError =
            "Could not load proposal notifications. Check your connection and permissions.";
          render();
        },
      );
    } catch (error) {
      console.error("Could not subscribe to Firestore admin notifications:", error);
      firestoreNotificationsLoading = false;
      firestoreNotificationsError =
        "Could not load proposal notifications. Check your connection and permissions.";
      render();
    }
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
  function age(value) {
    const date = new Date(value || 0);
    if (!value || Number.isNaN(date.getTime())) return "Just now";
    const mins = Math.max(0, Math.floor((Date.now() - date) / 60000));
    if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
    const days = Math.floor(hours / 24);
    return `${days} day${days === 1 ? "" : "s"} ago`;
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
      root.innerHTML = `<div class="notification-controls"><input class="admin-search" id="notificationSearch" type="search" placeholder="Search notifications" aria-label="Search notifications" value="${esc(search)}"><div class="notification-filters">${[
        ["all", "All Notifs"],
        ["read", "Read"],
        ["unread", "Unread"],
      ]
        .map(
          ([value, label]) =>
            `<button type="button" data-filter="${value}" class="${filter === value ? "active" : ""}" aria-pressed="${filter === value}">${label}</button>`,
        )
        .join(
          "",
        )}</div><div class="notification-actions"><button type="button" id="toggleTrash">${deleted ? "All Notifications" : "Recently Deleted"}</button><button type="button" id="markRead">${deleted ? "Delete All Permanently" : "Mark All As Read"}</button></div></div><section class="admin-section"><div class="admin-section-heading"><h2>${deleted ? "Recently Deleted" : "All Notifications"}</h2></div><div class="admin-cards">${visible.map((item) => (deleted ? `<article class="admin-notification-card" data-notification="${esc(item.id)}"><h2>${esc(item.title)}</h2><p>${esc(item.message)}</p><small>${age(item.createdAt)}</small><div class="admin-card-actions"><button data-restore="${esc(item.id)}">Restore</button><button data-permanent="${esc(item.id)}">Delete permanently</button></div></article>`         : `<article class="admin-notification-card ${item.read ? "is-read" : "is-unread"}" data-type="${esc(item.type)}" data-notification="${esc(item.id)}" tabindex="0"><h2>${esc(item.title)}</h2><p>${esc(item.message)}</p><div class="admin-notification-time" title="${esc(new Date(item.createdAt).toLocaleString("en-US", { timeZone: "Asia/Manila", dateStyle: "full", timeStyle: "short" }))}">${age(item.createdAt)}</div><span class="admin-notification-status ${item.read ? "is-read" : "is-unread"}">${item.read ? "Read" : "Unread"}</span>${item.source === "firestore" ? "" : `<div class="admin-card-actions"><button data-delete="${esc(item.id)}">Delete</button></div>`}</article>`)).join("") || `<div class="admin-empty">${deleted ? "Recently Deleted is empty." : "You have no notifications."}</div>`}</div></section>`;
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
      document.querySelector("[data-notification-count]").textContent = String(
        live.filter((item) => !item.read).length,
      );
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
    root.querySelector("#toggleTrash").onclick = () => {
      deleted = !deleted;
      render();
    };
    root.querySelector("#markRead").onclick = async () => {
      if (deleted) {
        saveTrash([]);
        render();
        return;
      }
      const list = snapshots();
      undoSnapshot = list.map((item) => ({ ...item }));
      if (currentAdminUid && rtdb) {
        const updates = {};
        rtdbNotifications.forEach((it) => {
          if (!it.read) updates[`notifications/${currentAdminUid}/${it.id}/read`] = true;
        });
        if (Object.keys(updates).length > 0) {
          try {
            await update(ref(rtdb), updates);
          } catch (e) {
            console.warn("Unable to update read state in RTDB:", e);
          }
        }
      }
      if (db && currentAdminUid) {
        try {
          await Promise.all(
            firestoreNotifications
              .filter((item) => !item.read)
              .map((item) => updateDoc(doc(db, "notifications", item.id), { read: true })),
          );
        } catch (error) {
          console.error("Could not mark Firestore notifications as read:", error);
          window.alert("Some proposal notifications could not be marked as read. Please try again.");
          return;
        }
      }
      const localList = read(key, []);
      save(localList.map((item) => ({ ...item, read: true })));
      toastUndo("All notifications marked as read.");
      render();
    };
    root.querySelectorAll("[data-delete]").forEach(
      (button) =>
        (button.onclick = (event) => {
          event.stopPropagation();
          const list = read(key, []),
            item = list.find((note) => note.id === button.dataset.delete);
          if (!item) return;
          save(
            list.filter((note) => note.id !== item.id),
          );
          const trash = read(trashKey, []);
          trash.unshift({
            ...item,
            deletedAt: Date.now(),
            expiresAt: Date.now() + lifetime,
          });
          saveTrash(trash);
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
          list.unshift(rest);
          save(list);
          saveTrash(trash.filter((note) => note.id !== item.id));
          render();
        }),
    );
    root.querySelectorAll("[data-permanent]").forEach(
      (button) =>
        (button.onclick = () => {
          saveTrash(
            read(trashKey, []).filter(
              (item) => item.id !== button.dataset.permanent,
            ),
          );
          render();
        }),
    );
    root.querySelectorAll("[data-notification]").forEach((card) => {
      card.onclick = async (event) => {
        if (event.target.closest("button")) return;
        const list = snapshots(),
          item = list.find((note) => note.id === card.dataset.notification);
        if (!item) return;
        item.read = true;
        if (item.source === "firestore" && db && currentAdminUid) {
          try {
            await updateDoc(doc(db, "notifications", item.id), { read: true });
          } catch (error) {
            console.error("Could not mark Firestore notification as read:", error);
            window.alert("This notification could not be marked as read. Please try again.");
            return;
          }
        }
        if (item.source === "rtdb" && currentAdminUid && rtdb) {
          try {
            await update(ref(rtdb, `notifications/${currentAdminUid}/${item.id}`), {
              read: true,
            });
          } catch (e) {
            console.warn("Unable to mark notification read in RTDB:", e);
          }
        }
        const localList = read(key, []);
        const localItem = localList.find((note) => note.id === item.id);
        if (localItem) {
          localItem.read = true;
          save(localList);
        }
        const proposalId = item.proposalId || item.eventId;
        if (proposalId) {
          const reviewUrl = new URL("AdminApproval.html", window.location.href);
          reviewUrl.searchParams.set("review", proposalId);
          if (item.source === "firestore") {
            reviewUrl.searchParams.set("source", "firestore");
          }
          location.href = reviewUrl.href;
        } else {
          render();
        }
      };
      card.onkeydown = (event) => {
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
      if (undoSnapshot) {
        try {
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
    undoTimer = setTimeout(() => (toast.hidden = true), 6000);
  }
  window.addEventListener("storage", (event) => {
    if (!event.key || event.key === key || event.key.includes("Events"))
      render();
  });
  window.addEventListener("focus", render);

  if (auth) {
    onAuthStateChanged(auth, async (user) => {
      if (user) {
        currentAdminUid = user.uid;
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
            console.error("Could not load the signed-in admin's organization profile:", error);
          }
        }
        if (auth.currentUser?.uid !== user.uid) return;
        render();
        subscribeToRtdbNotifications(user.uid);
        subscribeToFirestoreNotifications(user.uid);
        subscribeToQueue(user.uid);
      } else {
        currentAdminUid = null;
        currentAdminOrganizationCodes = [];
        currentAdminDepartmentCodes = [];
        if (notifListenerRef) off(notifListenerRef);
        notifListenerRef = null;
        if (queueListenerRef) off(queueListenerRef);
        queueListenerRef = null;
        rtdbNotifications = [];
        if (firestoreNotifUnsubscribe) firestoreNotifUnsubscribe();
        firestoreNotifUnsubscribe = null;
        firestoreNotifications = [];
        firestoreNotificationsLoading = false;
        firestoreNotificationsError = "";
        render();
      }
    });
  }
  window.addEventListener("beforeunload", () => {
    if (notifListenerRef) off(notifListenerRef);
    if (queueListenerRef) off(queueListenerRef);
    if (firestoreNotifUnsubscribe) firestoreNotifUnsubscribe();
  });

  render();
})();
