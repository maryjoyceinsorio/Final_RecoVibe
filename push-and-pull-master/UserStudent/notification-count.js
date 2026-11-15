(function () {
  const DEBUG = false;
  const TWO_WEEKS = 14 * 24 * 60 * 60 * 1000;
  const ONE_DAY = 24 * 60 * 60 * 1000;
  const STORAGE_PREFIX = "recovibeStudentNotifications:";
  const badge = document.getElementById("navNotifBadge");
  let authUnsubscribe = null;
  let firestoreUnsubscribes = [];
  let eventsUnsubscribe = null;
  let registrationsUnsubscribe = null;
  let rtdbUnsubscribe = null;
  let rtdbNotificationsRef = null;
  let badgeRefreshInterval = null;
  let currentUid = "";
  let currentProfile = {};
  let isEventVisibleToStudent = null;
  let loadStudentProfile = null;
  let sources = new Map();
  let realtimeSources = new Map();
  let events = new Map();
  let registrations = new Map();
  let detailLoads = new Set();
  let generation = 0;
  let state = { read: {}, deleted: {}, restored: {} };

  function debug(...args) {
    if (DEBUG) console.debug("[Student notification badge]", ...args);
  }

  function toMillis(value) {
    if (value && typeof value.toMillis === "function") return value.toMillis();
    if (value && typeof value.toDate === "function") return value.toDate().getTime();
    if (value && typeof value.seconds === "number") return value.seconds * 1000;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim()) {
      const parsed = Date.parse(value);
      return Number.isFinite(parsed) ? parsed : 0;
    }
    return 0;
  }

  function loadState() {
    try {
      const saved = JSON.parse(localStorage.getItem(`${STORAGE_PREFIX}${currentUid}`) || "{}");
      state = {
        read: saved?.read && typeof saved.read === "object" ? saved.read : {},
        deleted: saved?.deleted && typeof saved.deleted === "object" ? saved.deleted : {},
        restored: saved?.restored && typeof saved.restored === "object" ? saved.restored : {},
      };
    } catch (error) {
      state = { read: {}, deleted: {}, restored: {} };
      debug("Could not read local notification state:", error);
    }
  }

  function statusOf(event) {
    return String(event?.status || event?.publicationStatus || "")
      .trim()
      .toLowerCase()
      .replace(/[\s_-]+/g, "");
  }

  function titleOf(event) {
    return String(event?.title || event?.name || event?.eventName || "Untitled event");
  }

  function startAtOf(event) {
    const rawStart = event.startAt ?? event.start_at;
    if (typeof rawStart === "string" && /^\d{4}-\d{2}-\d{2}$/.test(rawStart)) {
      return Date.parse(`${rawStart}T00:00:00+08:00`) || 0;
    }
    if (typeof rawStart === "string" && /^\d{4}-\d{2}-\d{2}[T ]\d{1,2}:\d{2}/.test(rawStart)) {
      if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(rawStart)) {
        return Date.parse(`${rawStart.replace(" ", "T")}+08:00`) || 0;
      }
    }
    const direct = toMillis(rawStart);
    if (direct) return direct;
    const fullDateTime = String(event.startDateTime || event.start_date_time || "").trim();
    if (/^\d{4}-\d{2}-\d{2}[T ]\d{1,2}:\d{2}/.test(fullDateTime)) {
      return Date.parse(
        `${fullDateTime.replace(" ", "T")}${/(?:Z|[+-]\d{2}:?\d{2})$/i.test(fullDateTime) ? "" : "+08:00"}`,
      ) || 0;
    }
    const date = String(event.dateISO || event.date || event.startDate || "").slice(0, 10);
    const time = String(event.startTime || event.schedule?.startTime || event.time || "")
      .split(/\s*[-–—]\s*/)[0]
      .trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return 0;
    const match = /^(\d{1,2}):(\d{2})(?:\s*(AM|PM))?$/i.exec(time);
    if (!match) return Date.parse(`${date}T00:00:00+08:00`) || 0;
    let hour = Number(match[1]);
    if (match[3]) {
      hour %= 12;
      if (match[3].toUpperCase() === "PM") hour += 12;
    }
    return Date.parse(`${date}T${String(hour).padStart(2, "0")}:${match[2]}:00+08:00`) || 0;
  }

  function manilaDate(timestamp) {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Manila",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(timestamp));
  }

  function derivedItems() {
    const now = Date.now();
    const items = [];
    events.forEach((event, eventId) => {
      const status = statusOf(event);
      const published = status === "published" || event.published === true || event.isPublished === true;
      const stamp = toMillis(event.publishedAt) || toMillis(event.updatedAt) || toMillis(event.createdAt);
      if (
        published && stamp && stamp <= now && now - stamp <= TWO_WEEKS &&
        isEventVisibleToStudent?.({ ...event, id: eventId }, currentProfile)
      ) {
        items.push({ id: `published-${eventId}-${stamp}`, read: false, createdAt: stamp });
      }
    });
    registrations.forEach((registration, eventId) => {
      const status = String(registration.status || registration.registrationStatus || "registered")
        .trim()
        .toLowerCase()
        .replace(/[\s_-]+/g, "");
      if (["cancelled", "canceled", "withdrawn", "unregistered"].includes(status) || registration.cancelledAt) return;
      const event = events.get(eventId);
      if (!event) return;
      const registeredAt = toMillis(registration.registeredAt ?? registration.at);
      items.push({ id: `registered-${eventId}-${registeredAt}`, read: false, createdAt: registeredAt });
      const startAt = startAtOf(event);
      if (startAt > now && startAt - now <= ONE_DAY) {
        items.push({ id: `reminder-${eventId}-${startAt}`, read: false, createdAt: startAt });
      }
      const eventStatus = statusOf(event);
      if (["cancelled", "canceled", "rescheduled"].includes(eventStatus)) {
        const updatedAt = toMillis(event.updatedAt);
        if (updatedAt) {
          const type = eventStatus === "rescheduled" ? "rescheduled" : "cancelled";
          items.push({ id: `${type}-${eventId}-${updatedAt}`, read: false, createdAt: updatedAt });
        }
      }
    });
    return items;
  }

  function updateBadge() {
    if (!badge) return;
    const merged = new Map();
    sources.forEach((item, id) => merged.set(id, item));
    realtimeSources.forEach((item, id) => {
      if (!merged.has(id)) merged.set(id, item);
    });
    derivedItems().forEach((item) => {
      if (!merged.has(item.id)) merged.set(item.id, item);
    });
    Object.entries(state.restored).forEach(([id, item]) => {
      if (!merged.has(id)) merged.set(id, item);
    });
    let unread = 0;
    merged.forEach((item, id) => {
      const deletedAt = toMillis(state.deleted[id]?.deletedAt ?? state.deleted[id]);
      if (deletedAt && Date.now() - deletedAt >= 30 * ONE_DAY) delete state.deleted[id];
      if (state.deleted[id]) return;
      const read = Object.prototype.hasOwnProperty.call(state.read, id)
        ? state.read[id] === true
        : item.read === true || item.isRead === true;
      if (!read) unread++;
    });
    badge.textContent = unread > 9 ? "9+" : unread ? String(unread) : "";
    badge.hidden = unread === 0;
  }

  function stopListeners() {
    firestoreUnsubscribes.forEach((unsubscribe) => unsubscribe());
    firestoreUnsubscribes = [];
    eventsUnsubscribe?.();
    eventsUnsubscribe = null;
    registrationsUnsubscribe?.();
    registrationsUnsubscribe = null;
    if (rtdbNotificationsRef && rtdbUnsubscribe) {
      rtdbUnsubscribe();
    }
    rtdbUnsubscribe = null;
    rtdbNotificationsRef = null;
    sources.clear();
    realtimeSources.clear();
    events.clear();
    registrations.clear();
    detailLoads.clear();
    if (badgeRefreshInterval) {
      clearInterval(badgeRefreshInterval);
      badgeRefreshInterval = null;
    }
  }

  function attachListeners(user, firebase, firestoreSdk, databaseSdk) {
    stopListeners();
    const version = ++generation;
    currentUid = user.uid;
    loadState();
    currentProfile = {};
    loadStudentProfile(user).then((profile) => {
      if (version !== generation) return;
      currentProfile = profile;
      updateBadge();
    }).catch((error) => debug("Could not load student profile for badge:", error));

    const notificationDocs = new Map([["userId", new Map()], ["recipientUid", new Map()]]);
    ["userId", "recipientUid"].forEach((field) => {
      const unsubscribe = firestoreSdk.onSnapshot(
        firestoreSdk.query(
          firestoreSdk.collection(firebase.db, "notifications"),
          firestoreSdk.where(field, "==", user.uid),
        ),
        (snapshot) => {
          if (version !== generation) return;
          const result = notificationDocs.get(field);
          result.clear();
          snapshot.docs.forEach((item) => result.set(item.id, item.data()));
          sources.clear();
          notificationDocs.forEach((docs) => docs.forEach((data, id) => sources.set(id, data)));
          updateBadge();
        },
        (error) => debug(`Notification badge query (${field}) failed:`, error),
      );
      firestoreUnsubscribes.push(unsubscribe);
    });

    eventsUnsubscribe = firestoreSdk.onSnapshot(
      firestoreSdk.collection(firebase.db, "events"),
      (snapshot) => {
        if (version !== generation) return;
        events = new Map(snapshot.docs.map((item) => [item.id, item.data()]));
        updateBadge();
      },
      (error) => debug("Published event badge listener failed:", error),
    );
    registrationsUnsubscribe = firestoreSdk.onSnapshot(
      firestoreSdk.query(
        firestoreSdk.collectionGroup(firebase.db, "registrations"),
        firestoreSdk.where("uid", "==", user.uid),
      ),
      (snapshot) => {
        if (version !== generation) return;
        registrations.clear();
        snapshot.docs.forEach((item) => {
          const eventId = item.ref.parent.parent?.id;
          if (eventId) registrations.set(eventId, item.data());
        });
        registrations.forEach((registration, eventId) => {
          if (events.has(eventId) || detailLoads.has(eventId)) return;
          detailLoads.add(eventId);
          firestoreSdk.getDoc(firestoreSdk.doc(firebase.db, "events", eventId))
            .then((eventSnapshot) => {
              if (version === generation && eventSnapshot.exists()) {
                events.set(eventId, eventSnapshot.data());
                updateBadge();
              }
            })
            .catch((error) => debug("Could not load event for registration badge:", error));
        });
        updateBadge();
      },
      (error) => debug("Registration badge listener failed:", error),
    );

    if (firebase.isRtdbConfigured && firebase.rtdb) {
      try {
        rtdbNotificationsRef = databaseSdk.ref(firebase.rtdb, `notifications/${user.uid}`);
        const unsubscribe = databaseSdk.onValue(
          rtdbNotificationsRef,
          (snapshot) => {
            if (version !== generation) return;
            realtimeSources.clear();
            Object.entries(snapshot.val() || {}).forEach(([id, item]) => {
              if (item && typeof item === "object") realtimeSources.set(id, item);
            });
            updateBadge();
          },
          (error) => debug("Realtime Database badge listener failed:", error),
        );
        rtdbUnsubscribe = unsubscribe;
      } catch (error) {
        debug("Could not initialize Realtime Database badge listener:", error);
        rtdbNotificationsRef = null;
        rtdbUnsubscribe = null;
      }
    }
    badgeRefreshInterval = setInterval(updateBadge, 60000);
    updateBadge();
  }

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
        debug("Student logout failed:", error);
        link.removeAttribute("aria-busy");
        window.alert("Could not log out. Please try again.");
      }
    });
  });

  if (/Notification\.html$/i.test(window.location.pathname)) return;
  if (!badge) return;
  badge.textContent = "";
  badge.hidden = true;
  const offAuth = (unsubscribe) => {
    stopListeners();
    unsubscribe?.();
    currentUid = "";
    if (badge) {
      badge.textContent = "";
      badge.hidden = true;
    }
  };
  Promise.all([
    import("./firebaseConfig.js"),
    import("https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js"),
    import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js"),
    import("https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js"),
    import("./eventAudience.js"),
  ]).then(([firebase, authSdk, firestoreSdk, databaseSdk, eventAudience]) => {
    if (!firebase.auth || !firebase.db) return;
    authUnsubscribe = authSdk.onAuthStateChanged(firebase.auth, (user) => {
      stopListeners();
      if (!user) {
        currentUid = "";
        badge.textContent = "";
        badge.hidden = true;
        return;
      }
      isEventVisibleToStudent = eventAudience.isEventVisibleToStudent;
      loadStudentProfile = async (authenticatedUser) => {
        const identity = await import("./studentIdentity.js");
        return identity.loadStudentProfile(authenticatedUser);
      };
      attachListeners(user, {
        ...firebase,
      }, firestoreSdk, databaseSdk);
    });
  }).catch((error) => debug("Could not initialize badge listeners:", error));

  window.addEventListener("storage", (event) => {
    if (event.key === `${STORAGE_PREFIX}${currentUid}`) {
      loadState();
      updateBadge();
    }
  });
  window.addEventListener("pagehide", () => offAuth(authUnsubscribe), { once: true });
})();
