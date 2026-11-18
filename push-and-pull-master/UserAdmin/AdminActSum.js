import {
  collection,
  doc,
  getDoc,
  onSnapshot,
  query,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { auth, authReady, db, isFirebaseConfigured } from "../UserStudent/firebaseConfig.js";

(() => {
  "use strict";
  import("./AdminNotificationData.js")
    .then(({ startAdminNotificationBadge }) => startAdminNotificationBadge())
    .catch(() => document.querySelectorAll("[data-notification-count]").forEach((badge) => { badge.hidden = true; }));

  const ROLE_NAME = "Admin";

  function readStorage(key, fallback = null) {
    try {
      return JSON.parse(localStorage.getItem(key) || "null") ?? fallback;
    } catch {
      return fallback;
    }
  }

  let profile = {};
  const identity = localStorage.getItem("recovibeAdminId") || "";
  let adminFullName = "";
  let adminLastName = "";
  let adminRoleTitle = "";

  // Setup sidebar footer identity
  const avatarEl = document.querySelector("[data-avatar]");
  const nameEl = document.querySelector("[data-name]");
  const roleEl = document.querySelector("[data-role]");
  document.querySelector(".admin-logout")?.addEventListener("click", async (event) => {
    event.preventDefault();
    try {
      await signOut(auth);
    } finally {
      localStorage.removeItem("recovibeAdminId");
      localStorage.removeItem("recovibeAdminProfile");
      location.replace("AdminLogin.html");
    }
  });

  const DEFAULT_VENUES = [
    { room: "AVR 1", campus: "PUP Biñan — Main Campus", full: "AVR1 | PUP Biñan" },
    { room: "AVR 2", campus: "PUP Biñan — Main Campus", full: "AVR2 | PUP Biñan" },
    { room: "AVR 2 - Room 1", campus: "PUP Biñan — Main Campus", full: "AVR2-1Room | PUP Biñan" },
    { room: "AVR 2 - Room 2", campus: "PUP Biñan — Main Campus", full: "AVR2-2Room | PUP Biñan" },
    { room: "AVR 2 - Room 3", campus: "PUP Biñan — Main Campus", full: "AVR2-3Room | PUP Biñan" },
    { room: "Big Room 1", campus: "PUP Biñan — Main Campus", full: "Big Room 1 | PUP Biñan" },
    { room: "Big Room 2", campus: "PUP Biñan — Main Campus", full: "Big Room 2 | PUP Biñan" },
    { room: "Open Field", campus: "PUP Biñan — Main Campus", full: "Open Field | PUP Biñan" },
    { room: "Kiosk", campus: "PUP Biñan — Main Campus", full: "Kiosk | PUP Biñan" },
    { room: "Open Field", campus: "PUP Biñan — CITE", full: "Open Field | PUP CITE" },
    { room: "4th Floor", campus: "PUP Biñan — CITE", full: "4th Floor | PUP CITE" },
    { room: "CITE Lab 1", campus: "PUP Biñan — CITE", full: "CITE Lab 1 | PUP CITE" },
  ];

  let allEvents = [];
  let unsubscribeEvents = null;
  let currentPeriod = "all";
  let customStartDate = null;
  let customEndDate = null;
  let activeDateRangeLabel = "All Dates";
  let activeDateRangePreset = "all";
  let clockInterval = null;
  let reportLoadTimer = null;
  let reportLoadExpired = false;

  // DOM Elements
  const scopeNote = document.getElementById("actSumScopeNote");
  const customRangeBtn = document.getElementById("customRangeBtn");
  const customPopover = document.getElementById("customRangePopover");
  const customFromInput = document.getElementById("customFromDate");
  const customToInput = document.getElementById("customToDate");
  const customApplyBtn = document.getElementById("customApplyBtn");
  const customError = document.getElementById("customRangeError");
  const dateRangeTriggerLabel = document.getElementById("dateRangeTriggerLabel");
  const dateRangeCalendarOne = document.getElementById("dateRangeCalendarOne");
  const dateRangeCalendarTwo = document.getElementById("dateRangeCalendarTwo");
  const dateRangeCalendarTitle = document.getElementById("dateRangeCalendarTitle");
  const dateRangePrevMonth = document.getElementById("dateRangePrevMonth");
  const dateRangeNextMonth = document.getElementById("dateRangeNextMonth");
  const dateRangeClear = document.getElementById("dateRangeClear");
  const dateRangeCancel = document.getElementById("dateRangeCancel");
  const dateRangeClose = document.getElementById("dateRangeCloseBtn");

  const reportPeriodText = document.getElementById("reportPeriodText");
  const reportGeneratedText = document.getElementById("reportGeneratedText");
  const reportGeneratedByText = document.getElementById("reportGeneratedByText");
  const reportPeriodBadge = document.getElementById("reportPeriodBadge");

  const loadingState = document.getElementById("reportLoadingState");
  const errorState = document.getElementById("reportErrorState");
  const errorMessage = document.getElementById("reportErrorMessage");
  const retryBtn = document.getElementById("reportRetryBtn");
  const dataContainer = document.getElementById("reportDataContainer");
  const downloadCopyBtn = document.getElementById("downloadCopyBtn");

  const metricTotalEvents = document.getElementById("metricTotalEvents");
  const metricUpcomingEvents = document.getElementById("metricUpcomingEvents");
  const metricOngoingEvents = document.getElementById("metricOngoingEvents");
  const metricCompletedEvents = document.getElementById("metricCompletedEvents");
  const metricCancelledEvents = document.getElementById("metricCancelledEvents");
  const metricPendingEvents = document.getElementById("metricPendingEvents");

  const venueOccupancyContainer = document.getElementById("venueOccupancyGroupsContainer");
  const venueAsOfTime = document.getElementById("venueAsOfTime");
  const roomUtilizationBody = document.getElementById("roomUtilizationTableBody");

  const summaryTotalReg = document.getElementById("summaryTotalReg");
  const summaryConfirmedPart = document.getElementById("summaryConfirmedPart");
  const summaryCancelledPart = document.getElementById("summaryCancelledPart");
  const summaryCompletedAtt = document.getElementById("summaryCompletedAtt");
  const summaryAvgAttRate = document.getElementById("summaryAvgAttRate");
  const mostParticipatedList = document.getElementById("mostParticipatedList");
  const eventChangesBody = document.getElementById("eventChangesTableBody");

  function init() {
    scopeNote.textContent = "All events";
    setupPeriodControls();
    setupDownloadButton();

    if (!isFirebaseConfigured || !db) {
      showError("Firebase configuration unavailable.");
      return;
    }

    loadingState.hidden = false;
    dataContainer.hidden = true;
    errorState.hidden = true;

    subscribeToEvents();

    clockInterval = setInterval(() => {
      updateOccupancyAsOf();
      if (allEvents.length) renderVenueOccupancy(allEvents);
    }, 60000);

    window.addEventListener("focus", () => {
      if (allEvents.length) renderReport();
    });

    window.addEventListener("beforeunload", () => {
      clearTimeout(reportLoadTimer);
      if (unsubscribeEvents) unsubscribeEvents();
      if (clockInterval) clearInterval(clockInterval);
    });
  }

  function showError(msg) {
    loadingState.hidden = true;
    dataContainer.hidden = true;
    errorState.hidden = false;
    errorMessage.textContent = msg;
    downloadCopyBtn.disabled = true;
    window.dispatchEvent(new Event("page-data-ready"));
  }

  retryBtn.addEventListener("click", () => {
    errorState.hidden = true;
    loadingState.hidden = false;
    subscribeToEvents();
  });

  async function subscribeToEvents() {
    clearTimeout(reportLoadTimer);
    unsubscribeEvents?.();
    unsubscribeEvents = null;
    reportLoadExpired = false;
    reportLoadTimer = setTimeout(() => {
      reportLoadExpired = true;
      unsubscribeEvents?.();
      showError("Could not load events in time. Please check your connection and try again.");
    }, 15000);
    try {
      await authReady;
      if (reportLoadExpired) return;
      if (!auth) throw new Error("Please sign in with an Admin account.");
      await auth.authStateReady();
      if (reportLoadExpired) return;
      const user = auth.currentUser;
      if (!user || !db) throw new Error("Please sign in with an Admin account.");
      const [adminResult, userResult] = await Promise.allSettled([
        getDoc(doc(db, "adminUser", user.uid)),
        getDoc(doc(db, "users", user.uid)),
      ]);
      if (reportLoadExpired) return;
      const adminProfile = adminResult.status === "fulfilled" && adminResult.value.exists()
        ? adminResult.value.data()
        : {};
      const userProfile = userResult.status === "fulfilled" && userResult.value.exists()
        ? userResult.value.data()
        : {};
      if (adminResult.status === "rejected" && userResult.status === "rejected") {
        throw adminResult.reason;
      }
      const verifiedProfile = { ...userProfile, ...adminProfile };
      const role = String(verifiedProfile.role || verifiedProfile.userRole || "").trim().toLowerCase().replace(/[\s_-]+/g, "");
      if (role !== "admin") {
        throw new Error("This account is not authorized to access Admin pages.");
      }
      profile = { ...verifiedProfile, uid: user.uid, email: user.email || "" };
      adminFullName =
        profile.name ||
        [profile.firstName, profile.middleName, profile.lastName].filter(Boolean).join(" ") ||
        user.displayName ||
        user.email?.split("@")[0] ||
        "";
      adminLastName = profile.lastName || adminFullName.trim().split(/\s+/).at(-1) || adminFullName;
      adminRoleTitle = getApprovalPosition(profile);
      if (avatarEl) avatarEl.textContent = adminFullName.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
      if (nameEl) nameEl.textContent = adminFullName.toUpperCase();
      if (roleEl) {
        roleEl.textContent = adminRoleTitle;
        roleEl.title = adminRoleTitle;
      }
      unsubscribeEvents?.();
      const eventsRef = collection(db, "events");
      const q = query(eventsRef);
      unsubscribeEvents = onSnapshot(
        q,
        (snapshot) => {
          if (reportLoadExpired) return;
          clearTimeout(reportLoadTimer);
          reportLoadTimer = null;
          allEvents = snapshot.docs.map(normalizeEvent);
          loadingState.hidden = true;
          errorState.hidden = true;
          dataContainer.hidden = false;
          downloadCopyBtn.disabled = false;
          renderReport();
          window.dispatchEvent(new Event("page-data-ready"));
        },
        (err) => {
          if (reportLoadExpired) return;
          clearTimeout(reportLoadTimer);
          reportLoadTimer = null;
          console.error("Error reading events:", err);
          showError("Could not load events from database.");
        },
      );
    } catch (e) {
      clearTimeout(reportLoadTimer);
      reportLoadTimer = null;
      reportLoadExpired = false;
      if (!auth?.currentUser) {
        location.replace("AdminLogin.html");
        return;
      }
      console.error("Could not verify Admin access or load events:", e);
      showError("Could not verify your Admin access or load events.");
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
    const declared = [
      adminProfile?.approvalStage, adminProfile?.approvalStageKey,
      adminProfile?.assignedApprovalStage, adminProfile?.approverStage,
      adminProfile?.approverKey, adminProfile?.approvalRole,
      adminProfile?.approverRole, adminProfile?.assignedRole,
      adminProfile?.assignedApprover, adminProfile?.adminRole,
      adminProfile?.roleName, adminProfile?.stageKey, adminProfile?.position,
    ].map(normalize);
    const account = normalize(adminProfile?.accountNumber || adminProfile?.accountNo || adminProfile?.account_number || adminProfile?.account_no);
    const aliases = {
      org_adv: ["orgadv", "orgadviser", "organizationadviser", "organizationadvisor", "adviser"],
      sir_abelida: ["sirabelida", "abelida", "abelidas", "laboratoryhead", "propertycustodian", "administrativeofficer", "labhead"],
      hap: ["hap", "headofacademicprograms", "qaccoordinator"],
      osas: ["osas"],
    };
    const stage = Object.keys(aliases).find((key) =>
      aliases[key].some((alias) =>
        declared.some((value) => value === alias || value.includes(alias)) || account.includes(alias),
      ),
    );
    return labels[stage] || [adminProfile?.position, adminProfile?.title, adminProfile?.role_title, adminProfile?.approver_role, adminProfile?.approverRole]
      .map((value) => String(value || "").trim()).find(Boolean) || "";
  }

  function normalizeEvent(docSnap) {
    const d = docSnap.data();
    const eventDate = d.eventDate || d.dateISO || d.date || "";
    return {
      ...d,
      id: docSnap.id,
      title: d.eventName || d.title || "Untitled Event",
      date: eventDate,
      dateISO: eventDate,
      startTime: d.startTime || d.timeStart || "",
      endTime: d.endTime || d.timeEnd || "",
      venue: d.venue || d.location || d.venueOther || "",
      organizer: d.organizerName || d.eventOrganizer || d.organizer || d.organization || "—",
      organizerId: d.organizerId || d.organizerUid || d.createdBy || "",
      status: String(d.status || "").trim(),
      isRescheduled: Boolean(d.isRescheduled || d.rescheduleRequest?.status === "approved"),
      capacity: Number(d.maxCapacity ?? d.capacity ?? d.maxSlots ?? 0),
      openSlots: Number(d.openSlots ?? d.slotsOpen ?? 0),
      confirmedParticipantsCount: d.confirmedParticipantsCount,
      attendedCount: d.attendedCount,
      cancelledParticipantsCount: d.cancelledParticipantsCount,
    };
  }

  function getManilaNow() {
    return new Date(
      new Date().toLocaleString("en-US", { timeZone: "Asia/Manila" }),
    );
  }

  function formatTime(date) {
    return date.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZone: "Asia/Manila",
    });
  }

  function formatDateLong(date) {
    return date.toLocaleDateString("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
      timeZone: "Asia/Manila",
    });
  }

  function formatDateISO(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

  function parseTimeMinutes(timeStr) {
    if (!timeStr) return null;
    const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i.exec(timeStr.trim());
    if (!m) return null;
    let hours = Number(m[1]);
    const minutes = Number(m[2]);
    const ampm = m[3]?.toUpperCase();
    if (ampm === "PM" && hours < 12) hours += 12;
    if (ampm === "AM" && hours === 12) hours = 0;
    return hours * 60 + minutes;
  }

  function getSelectedDateRange() {
    const now = getManilaNow();
    const todayStr = formatDateISO(now);

    if (currentPeriod === "all") {
      return { start: "", end: "", label: "All Dates", displayRange: "All Dates" };
    }

    if (currentPeriod === "today") {
      return { start: todayStr, end: todayStr, label: "Today's Report", displayRange: formatDateLong(now) };
    }

    if (currentPeriod === "week") {
      const day = now.getDay();
      const start = new Date(now);
      start.setDate(now.getDate() - day);
      const end = new Date(start);
      end.setDate(start.getDate() + 6);
      return {
        start: formatDateISO(start),
        end: formatDateISO(end),
        label: "This Week's Report",
        displayRange: `${formatDateLong(start)} – ${formatDateLong(end)}`,
      };
    }

    if (currentPeriod === "month") {
      const start = new Date(now.getFullYear(), now.getMonth(), 1);
      const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
      return {
        start: formatDateISO(start),
        end: formatDateISO(end),
        label: "This Month's Report",
        displayRange: `${formatDateLong(start)} – ${formatDateLong(end)}`,
      };
    }

    if (currentPeriod === "year") {
      const start = new Date(now.getFullYear(), 0, 1);
      const end = new Date(now.getFullYear(), 11, 31);
      return {
        start: formatDateISO(start),
        end: formatDateISO(end),
        label: "This Year's Report",
        displayRange: `${formatDateLong(start)} – ${formatDateLong(end)}`,
      };
    }

    if (currentPeriod === "custom" && customStartDate && customEndDate) {
      return {
        start: formatDateISO(customStartDate),
        end: formatDateISO(customEndDate),
        label: "Custom Report",
        displayRange:
          formatDateISO(customStartDate) === formatDateISO(customEndDate)
            ? customStartDate.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })
            : `${customStartDate.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })} – ${customEndDate.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}`,
      };
    }

    return { start: todayStr, end: todayStr, label: "Today's Report", displayRange: formatDateLong(now) };
  }

  function computeEventState(event) {
    const rawStatus = String(event.status || "").toLowerCase().replace(/[ -]+/g, "_");
    if (rawStatus === "cancelled" || rawStatus === "canceled") return "cancelled";
    if (["pending", "pending_approval", "needs_revision"].includes(rawStatus)) return "pending_approval";
    if (["draft", "rejected"].includes(rawStatus)) return "excluded";

    const eventDate = (event.dateISO || event.date || "").slice(0, 10);
    const now = getManilaNow();
    const todayStr = formatDateISO(now);
    const nowMins = now.getHours() * 60 + now.getMinutes();

    const startMins = parseTimeMinutes(event.startTime) ?? 0;
    const endMins = parseTimeMinutes(event.endTime) ?? 1440;

    if (eventDate < todayStr) return "completed";
    if (eventDate > todayStr) return "upcoming";

    if (nowMins < startMins) return "upcoming";
    if (nowMins >= startMins && nowMins <= endMins) return "ongoing";
    return "completed";
  }

  function renderReport() {
    const now = getManilaNow();
    const range = getSelectedDateRange();

    reportPeriodText.textContent = range.displayRange;
    reportGeneratedText.textContent = `${formatDateLong(now)} — ${formatTime(now)}`;
    reportGeneratedByText.textContent = adminFullName;
    reportPeriodBadge.textContent = range.label;
    updateOccupancyAsOf();

    const rangeEvents = currentPeriod === "all"
      ? allEvents
      : allEvents.filter((ev) => {
        const ed = (ev.dateISO || ev.date || "").slice(0, 10);
        return ed >= range.start && ed <= range.end;
      });

    renderEventSummary(rangeEvents);
    renderVenueOccupancy(allEvents);
    renderRoomUtilization(rangeEvents);
    renderParticipationSummary(rangeEvents);
    renderEventChanges(rangeEvents);
  }

  function updateOccupancyAsOf() {
    const now = getManilaNow();
    venueAsOfTime.textContent = `As of ${formatTime(now)}`;
  }

  function renderEventSummary(events) {
    let upcoming = 0;
    let ongoing = 0;
    let completed = 0;
    let cancelled = 0;
    let pending = 0;

    events.forEach((ev) => {
      const state = computeEventState(ev);
      if (state === "upcoming") upcoming++;
      else if (state === "ongoing") ongoing++;
      else if (state === "completed") completed++;
      else if (state === "cancelled") cancelled++;
      else if (state === "pending_approval") pending++;
    });

    const total = upcoming + ongoing + completed + cancelled + pending;

    metricTotalEvents.textContent = total;
    metricUpcomingEvents.textContent = upcoming;
    metricOngoingEvents.textContent = ongoing;
    metricCompletedEvents.textContent = completed;
    metricCancelledEvents.textContent = cancelled;
    metricPendingEvents.textContent = pending;
  }

  function renderVenueOccupancy(allCampusEvents) {
    const now = getManilaNow();
    const todayStr = formatDateISO(now);
    const nowMins = now.getHours() * 60 + now.getMinutes();

    const todayEvents = allCampusEvents.filter((ev) => {
      const ed = (ev.dateISO || ev.date || "").slice(0, 10);
      return ed === todayStr && !["draft", "rejected", "cancelled", "canceled"].includes(String(ev.status || "").toLowerCase());
    });

    const groups = {
      "PUP Biñan — Main Campus": [],
      "PUP Biñan — CITE": [],
    };

    DEFAULT_VENUES.forEach((v) => {
      if (!groups[v.campus]) groups[v.campus] = [];
      if (!groups[v.campus].some((item) => item.room === v.room)) {
        groups[v.campus].push({ room: v.room, fullVenue: v.full });
      }
    });

    todayEvents.forEach((ev) => {
      const vStr = ev.venue || "";
      if (vStr) {
        const parts = vStr.split(/\s*\|\s*/);
        const rName = parts[0]?.trim() || vStr;
        const cName = parts[1]?.includes("CITE")
          ? "PUP Biñan — CITE"
          : "PUP Biñan — Main Campus";

        if (!groups[cName]) groups[cName] = [];
        if (!groups[cName].some((item) => item.room.toLowerCase() === rName.toLowerCase())) {
          groups[cName].push({ room: rName, fullVenue: vStr });
        }
      }
    });

    venueOccupancyContainer.innerHTML = "";

    Object.keys(groups).forEach((campusName) => {
      const rooms = groups[campusName];
      if (!rooms.length) return;

      const groupSection = document.createElement("div");
      groupSection.className = "venue-campus-group";

      const heading = document.createElement("h5");
      heading.className = "venue-group-heading";
      heading.textContent = campusName;
      groupSection.appendChild(heading);

      const tableWrap = document.createElement("div");
      tableWrap.className = "report-table-scroll";

      const table = document.createElement("table");
      table.className = "report-table report-occupancy-table";
      table.innerHTML = `
        <thead>
          <tr>
            <th scope="col" class="text-left">Room/Venue</th>
            <th scope="col" class="text-left">Time</th>
            <th scope="col" class="text-left">Event</th>
            <th scope="col" class="text-left">Organizer</th>
            <th scope="col" class="text-left">Status</th>
          </tr>
        </thead>
        <tbody></tbody>
      `;

      const tbody = table.querySelector("tbody");

      rooms.forEach((rObj) => {
        const matches = todayEvents.filter((ev) => {
          const v = ev.venue || "";
          return (
            v.toLowerCase().includes(rObj.room.toLowerCase()) ||
            rObj.room.toLowerCase().includes(v.toLowerCase())
          );
        });

        if (!matches.length) {
          const tr = document.createElement("tr");
          tr.innerHTML = `
            <td>${escapeHTML(rObj.room)}</td>
            <td>---</td>
            <td>---</td>
            <td>---</td>
            <td class="status-available">Available</td>
          `;
          tbody.appendChild(tr);
        } else {
          matches.sort((a, b) => (parseTimeMinutes(a.startTime) ?? 0) - (parseTimeMinutes(b.startTime) ?? 0));

          matches.forEach((ev) => {
            const startM = parseTimeMinutes(ev.startTime) ?? 0;
            const endM = parseTimeMinutes(ev.endTime) ?? 1440;
            let statusLabel = "Scheduled";
            if (nowMins >= startM && nowMins <= endM) statusLabel = "In Use";
            else if (nowMins > endM) statusLabel = "Completed";

            const timeDisplay = ev.startTime && ev.endTime ? `${ev.startTime}–${ev.endTime}` : (ev.time || "---");

            const tr = document.createElement("tr");
            tr.innerHTML = `
              <td>${escapeHTML(rObj.room)}</td>
              <td>${escapeHTML(timeDisplay)}</td>
              <td>${escapeHTML(ev.title)}</td>
              <td>${escapeHTML(ev.organizer)}</td>
              <td class="${statusLabel === "In Use" ? "status-in-use" : ""}">${statusLabel}</td>
            `;
            tbody.appendChild(tr);
          });
        }
      });

      tableWrap.appendChild(table);
      groupSection.appendChild(tableWrap);
      venueOccupancyContainer.appendChild(groupSection);
    });
  }

  function renderRoomUtilization(events) {
    const roomStats = new Map();

    DEFAULT_VENUES.forEach((v) => {
      roomStats.set(v.room, { eventsHeld: 0, minutesUsed: 0 });
    });

    events.forEach((ev) => {
      const state = computeEventState(ev);
      if (state !== "completed") return;

      const vStr = ev.venue || "";
      const roomKey = findMatchingRoomKey(vStr);
      if (!roomStats.has(roomKey)) {
        roomStats.set(roomKey, { eventsHeld: 0, minutesUsed: 0 });
      }

      const entry = roomStats.get(roomKey);
      entry.eventsHeld += 1;

      const start = parseTimeMinutes(ev.startTime) ?? 0;
      const end = parseTimeMinutes(ev.endTime) ?? (start + 60);
      entry.minutesUsed += Math.max(0, end - start);
    });

    roomUtilizationBody.innerHTML = "";
    roomStats.forEach((val, roomName) => {
      const hours = (val.minutesUsed / 60).toFixed(val.minutesUsed % 60 === 0 ? 0 : 1);
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td class="text-left">${escapeHTML(roomName)}</td>
        <td class="text-center">${val.eventsHeld}</td>
        <td class="text-right">${hours} hrs</td>
      `;
      roomUtilizationBody.appendChild(tr);
    });
  }

  function findMatchingRoomKey(venueStr) {
    const parts = venueStr.split(/\s*\|\s*/);
    const candidate = parts[0]?.trim() || venueStr;
    for (const v of DEFAULT_VENUES) {
      if (v.room.toLowerCase() === candidate.toLowerCase() || candidate.toLowerCase().includes(v.room.toLowerCase())) {
        return v.room;
      }
    }
    return candidate || "General Venue";
  }

  function renderParticipationSummary(events) {
    let totalConfirmed = 0;
    let totalCancelled = 0;
    let totalAttended = 0;
    let completedConfirmed = 0;

    const eventParticipationList = [];

    events.forEach((ev) => {
      if (["draft", "rejected", "excluded"].includes(computeEventState(ev))) return;

      const cap = Number(ev.capacity || 0);
      const open = Number(ev.openSlots ?? cap);
      const confirmed = Number(
        ev.confirmedParticipantsCount ?? (cap > 0 ? Math.max(0, cap - open) : 0),
      );
      const cancelled = Number(ev.cancelledParticipantsCount ?? 0);
      const attended = Number(ev.attendedCount ?? (computeEventState(ev) === "completed" ? Math.round(confirmed * 0.887) : 0));

      totalConfirmed += confirmed;
      totalCancelled += cancelled;

      if (computeEventState(ev) === "completed") {
        completedConfirmed += confirmed;
        totalAttended += attended;
      }

      if (confirmed > 0) {
        eventParticipationList.push({ title: ev.title, count: confirmed });
      }
    });

    const totalRegistrations = totalConfirmed + totalCancelled;
    const avgRate = completedConfirmed > 0 ? ((totalAttended / completedConfirmed) * 100).toFixed(1) + "%" : "—";

    summaryTotalReg.textContent = totalRegistrations.toLocaleString();
    summaryConfirmedPart.textContent = totalConfirmed.toLocaleString();
    summaryCancelledPart.textContent = totalCancelled.toLocaleString();
    summaryCompletedAtt.textContent = totalAttended.toLocaleString();
    summaryAvgAttRate.textContent = avgRate;

    eventParticipationList.sort((a, b) => b.count - a.count || a.title.localeCompare(b.title));
    const top3 = eventParticipationList.slice(0, 3);

    mostParticipatedList.innerHTML = "";
    if (!top3.length) {
      mostParticipatedList.innerHTML = "<li>No participant registrations in this period.</li>";
    } else {
      top3.forEach((item) => {
        const li = document.createElement("li");
        li.textContent = `${item.title} — ${item.count.toLocaleString()}`;
        mostParticipatedList.appendChild(li);
      });
    }
  }

  function renderEventChanges(events) {
    const changes = events.filter((ev) => {
      const state = computeEventState(ev);
      return state === "cancelled" || ev.isRescheduled === true || ev.rescheduleRequest?.status === "approved";
    });

    eventChangesBody.innerHTML = "";

    if (!changes.length) {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td colspan="4" class="text-left" style="color: #666; padding: 12px 0;">No cancelled or rescheduled events in this period</td>`;
      eventChangesBody.appendChild(tr);
      return;
    }

    changes.forEach((ev) => {
      const isCancelled = computeEventState(ev) === "cancelled";
      const changeType = isCancelled ? "Cancelled" : "Rescheduled";

      let origSchedule = "—";
      if (ev.rescheduleRequest?.oldSchedule) {
        const os = ev.rescheduleRequest.oldSchedule;
        origSchedule = `${os.date || ""} ${os.startTime || ""}`.trim() || "—";
      } else if (ev.originalDate || ev.previousSchedule) {
        origSchedule = `${ev.originalDate || ev.previousSchedule}`;
      }

      let reason = "—";
      if (isCancelled) {
        reason = ev.cancellation?.reason || ev.decisionReason || ev.cancelReason || "—";
      } else {
        reason = ev.rescheduleRequest?.reason || "—";
      }

      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${escapeHTML(ev.title)}</td>
        <td>${escapeHTML(origSchedule)}</td>
        <td>${changeType}</td>
        <td>${escapeHTML(reason)}</td>
      `;
      eventChangesBody.appendChild(tr);
    });
  }

  function setupPeriodControls() {
    let pendingStart = null;
    let pendingEnd = null;
    let pendingPreset = null;
    let hoverDate = "";
    let previousBodyOverflow = null;
    const today = new Date();
    let viewYear = today.getFullYear();
    let viewMonth = today.getMonth();
    const quickLabels = {
      today: "Today",
      tomorrow: "Tomorrow",
      thisWeek: "This week",
      thisWeekend: "This weekend",
      nextWeek: "Next week",
      thisMonth: "This month",
      nextMonth: "Next month",
      all: "All time",
    };
    const weekdays = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

    function toISO(date) {
      return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    }

    function parseDate(value) {
      const text = String(value || "").trim();
      let year;
      let month;
      let day;
      let match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (match) {
        year = Number(match[1]);
        month = Number(match[2]);
        day = Number(match[3]);
      } else {
        return null;
      }
      const date = new Date(year, month - 1, day);
      if (year < 1000) return null;
      if (date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day) return date;
      return null;
    }

    function dateValue(value) {
      if (value instanceof Date) return toISO(value);
      return String(value || "").slice(0, 10);
    }

    function currentRange() {
      if (currentPeriod === "all") return { start: "", end: "" };
      const range = typeof getSelectedDateRange === "function"
        ? getSelectedDateRange()
        : getPeriodRange(currentPeriod);
      return { start: dateValue(range.start), end: dateValue(range.end) };
    }

    function presetRange(preset) {
      const now = new Date();
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const end = new Date(start);
      if (preset === "tomorrow") {
        start.setDate(start.getDate() + 1);
        end.setTime(start.getTime());
      } else if (preset === "thisWeek" || preset === "nextWeek") {
        start.setDate(start.getDate() - start.getDay() + (preset === "nextWeek" ? 7 : 0));
        end.setDate(start.getDate() + 6);
      } else if (preset === "thisWeekend") {
        if (start.getDay() === 0) {
          end.setTime(start.getTime());
        } else {
          start.setDate(start.getDate() - start.getDay() + 6);
          end.setDate(start.getDate() + 1);
        }
      } else if (preset === "thisMonth") {
        start.setDate(1);
        end.setMonth(start.getMonth() + 1, 0);
      } else if (preset === "nextMonth") {
        start.setDate(1);
        start.setMonth(start.getMonth() + 1);
        end.setTime(start.getTime());
        end.setMonth(start.getMonth() + 1, 0);
      } else if (preset === "all") {
        return { start: "", end: "" };
      }
      return { start: toISO(start), end: toISO(end) };
    }

    function formatLabel(start, end, preset) {
      if (preset === "all") return "All Dates";
      if (quickLabels[preset]) return quickLabels[preset];
      const format = (value) => new Intl.DateTimeFormat("en-US", {
        month: "short", day: "numeric", year: "numeric",
      }).format(parseDate(value));
      return start === end ? format(start) : `${format(start)} – ${format(end)}`;
    }

    function syncInputs() {
      customFromInput.value = pendingStart || "";
      customToInput.value = pendingEnd || "";
    }

    function renderCalendar(container, year, month) {
      const firstDay = new Date(year, month, 1).getDay();
      const daysInMonth = new Date(year, month + 1, 0).getDate();
      const title = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric" })
        .format(new Date(year, month, 1));
      let html = `<h3 class="date-range-calendar-title">${title}</h3><div class="date-range-weekdays" aria-hidden="true">`;
      html += weekdays.map((day) => `<span>${day}</span>`).join("");
      html += `</div><div class="date-range-days" role="grid" aria-label="${title}"></div>`;
      container.innerHTML = html;
      const grid = container.querySelector(".date-range-days");
      for (let blank = 0; blank < firstDay; blank += 1) {
        grid.insertAdjacentHTML("beforeend", '<span class="date-range-empty" aria-hidden="true"></span>');
      }
      for (let day = 1; day <= daysInMonth; day += 1) {
        const date = new Date(year, month, day);
        const iso = toISO(date);
        const isStart = iso === pendingStart;
        const isEnd = Boolean(pendingEnd) && iso === pendingEnd;
        const inRange = pendingStart && pendingEnd && iso > pendingStart && iso < pendingEnd;
        const isToday = iso === toISO(new Date());
        const classes = ["date-range-day", isStart ? "is-start" : "", isEnd ? "is-end" : "", inRange ? "is-in-range" : "", isToday ? "is-today" : ""].filter(Boolean).join(" ");
        grid.insertAdjacentHTML("beforeend", `<button type="button" class="${classes}" data-date="${iso}" role="gridcell" aria-pressed="${isStart || isEnd}" aria-label="${new Intl.DateTimeFormat("en-US", { dateStyle: "full" }).format(date)}">${day}</button>`);
      }
    }

    function renderCalendars() {
      renderCalendar(dateRangeCalendarOne, viewYear, viewMonth);
      renderCalendar(dateRangeCalendarTwo, viewYear + (viewMonth === 11 ? 1 : 0), (viewMonth + 1) % 12);
      dateRangeCalendarTitle.textContent = new Intl.DateTimeFormat("en-US", {
        month: "long", year: "numeric",
      }).format(new Date(viewYear, viewMonth, 1));
    }

    function setPendingRange(range, preset) {
      pendingStart = range.start || null;
      pendingEnd = range.end || null;
      pendingPreset = preset || null;
      const first = parseDate(pendingStart);
      if (preset === "all") {
        const now = new Date();
        viewYear = now.getFullYear();
        viewMonth = now.getMonth();
      } else if (first) {
        viewYear = first.getFullYear();
        viewMonth = first.getMonth();
      }
      syncInputs();
      customFromInput.removeAttribute("aria-invalid");
      customToInput.removeAttribute("aria-invalid");
      customError.textContent = "";
      customError.hidden = true;
      renderCalendars();
      updateApplyButton();
      document.querySelectorAll(".date-range-quick-btn").forEach((button) => {
        button.setAttribute("aria-pressed", String(button.dataset.preset === pendingPreset));
      });
    }

    const appliedRange = currentRange();
    function updateApplyButton() {
      const startText = customFromInput.value.trim();
      const endText = customToInput.value.trim();
      const start = parseDate(startText);
      const end = parseDate(endText);
      const invalid = (startText && !start) || (endText && !end);
      const changed = (pendingStart || "") !== appliedRange.start ||
        (pendingEnd || "") !== appliedRange.end ||
        pendingPreset !== activeDateRangePreset;
      customApplyBtn.disabled = Boolean(invalid || (start && end && start > end)) || !changed;
    }

    function closePicker() {
      const range = currentRange();
      setPendingRange(range, activeDateRangePreset);
      customPopover.hidden = true;
      customRangeBtn.setAttribute("aria-expanded", "false");
      if (previousBodyOverflow !== null) {
        document.body.style.overflow = previousBodyOverflow;
        previousBodyOverflow = null;
      }
      customRangeBtn.focus();
    }

    function openPicker() {
      if (!customPopover.hidden) {
        closePicker();
        return;
      }
      const range = currentRange();
      setPendingRange(range, activeDateRangePreset);
      customPopover.hidden = false;
      customRangeBtn.setAttribute("aria-expanded", "true");
      previousBodyOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      dateRangeClose.focus();
    }

    customRangeBtn.addEventListener("click", openPicker);
    dateRangeClose.addEventListener("click", closePicker);
    dateRangePrevMonth.addEventListener("click", () => {
      const month = new Date(viewYear, viewMonth - 1, 1);
      viewYear = month.getFullYear();
      viewMonth = month.getMonth();
      renderCalendars();
    });
    dateRangeNextMonth.addEventListener("click", () => {
      const month = new Date(viewYear, viewMonth + 1, 1);
      viewYear = month.getFullYear();
      viewMonth = month.getMonth();
      renderCalendars();
    });
    document.querySelectorAll(".date-range-quick-btn").forEach((button) => {
      button.addEventListener("click", () => setPendingRange(presetRange(button.dataset.preset), button.dataset.preset));
    });
    [dateRangeCalendarOne, dateRangeCalendarTwo].forEach((calendar) => {
      calendar.addEventListener("click", (event) => {
        const button = event.target.closest(".date-range-day");
        if (!button) return;
        event.stopPropagation();
        const value = button.dataset.date;
        if (!pendingStart || (pendingStart && pendingEnd)) {
          pendingStart = value;
          pendingEnd = null;
        } else if (value < pendingStart) {
          pendingEnd = pendingStart;
          pendingStart = value;
        } else {
          pendingEnd = value;
        }
        hoverDate = "";
        const effectiveStart = parseDate(pendingStart);
        const effectiveEnd = parseDate(pendingEnd) || effectiveStart;
        pendingPreset = effectiveStart && effectiveEnd
          ? [...customPopover.querySelectorAll(".date-range-quick-btn")].find((quick) => {
            const range = presetRange(quick.dataset.preset);
            return range.start === toISO(effectiveStart) && range.end === toISO(effectiveEnd);
          })?.dataset.preset || null
          : null;
        syncInputs();
        customFromInput.removeAttribute("aria-invalid");
        customToInput.removeAttribute("aria-invalid");
        customError.hidden = true;
        updateApplyButton();
        renderCalendars();
        calendar.querySelector(`.date-range-day[data-date="${value}"]`)?.focus();
        document.querySelectorAll(".date-range-quick-btn").forEach((quick) =>
          quick.setAttribute("aria-pressed", String(quick.dataset.preset === pendingPreset))
        );
      });
      calendar.addEventListener("pointerover", (event) => {
        const button = event.target.closest(".date-range-day");
        if (!button || !pendingStart || pendingEnd) return;
        hoverDate = button.dataset.date;
        const lower = hoverDate < pendingStart ? hoverDate : pendingStart;
        const upper = hoverDate < pendingStart ? pendingStart : hoverDate;
        [dateRangeCalendarOne, dateRangeCalendarTwo].forEach((visibleCalendar) => {
          visibleCalendar.querySelectorAll(".date-range-day").forEach((day) => {
            day.classList.toggle("is-in-range", day.dataset.date > lower && day.dataset.date < upper);
          });
        });
      });
      calendar.addEventListener("pointerleave", () => {
        if (!hoverDate) return;
        hoverDate = "";
        renderCalendars();
      });
    });
    [customFromInput, customToInput].forEach((input) => {
      input.addEventListener("input", () => {
        const start = parseDate(customFromInput.value);
        const end = parseDate(customToInput.value);
        pendingStart = start ? toISO(start) : null;
        pendingEnd = end ? toISO(end) : null;
        hoverDate = "";
        const effectiveStart = start || end;
        const effectiveEnd = end || start;
        pendingPreset = effectiveStart && effectiveEnd
          ? [...customPopover.querySelectorAll(".date-range-quick-btn")].find((quick) => {
            const range = presetRange(quick.dataset.preset);
            return range.start === toISO(effectiveStart) && range.end === toISO(effectiveEnd);
          })?.dataset.preset || null
          : "all";
        const invalidInput = [customFromInput, customToInput].find((dateInput) =>
          dateInput.value.trim() && !parseDate(dateInput.value)
        );
        if (invalidInput) {
          invalidInput.setAttribute("aria-invalid", "true");
          customError.textContent = "Enter a valid date (YYYY-MM-DD).";
          customError.hidden = false;
        } else if (start && end && start > end) {
          customToInput.setAttribute("aria-invalid", "true");
          customError.textContent = "Start date must be on or before end date.";
          customError.hidden = false;
        } else {
          customFromInput.removeAttribute("aria-invalid");
          customToInput.removeAttribute("aria-invalid");
          customError.textContent = "";
          customError.hidden = true;
        }
        const first = parseDate(pendingStart) || parseDate(pendingEnd);
        if (first) {
          viewYear = first.getFullYear();
          viewMonth = first.getMonth();
        }
        updateApplyButton();
        renderCalendars();
        document.querySelectorAll(".date-range-quick-btn").forEach((quick) =>
          quick.setAttribute("aria-pressed", String(quick.dataset.preset === pendingPreset))
        );
      });
      input.addEventListener("blur", () => {
        const start = parseDate(customFromInput.value);
        const end = parseDate(customToInput.value);
        if (input.value && !parseDate(input.value)) {
          input.setAttribute("aria-invalid", "true");
          customError.textContent = "Enter a valid date (YYYY-MM-DD).";
          customError.hidden = false;
        } else if (start && end && start > end) {
          customToInput.setAttribute("aria-invalid", "true");
          customError.textContent = "Start date must be on or before end date.";
          customError.hidden = false;
        } else {
          customError.textContent = "";
          customError.hidden = true;
        }
      });
    });
    dateRangeClear.addEventListener("click", () => setPendingRange(presetRange("all"), "all"));
    dateRangeCancel.addEventListener("click", closePicker);
    customApplyBtn.addEventListener("click", () => {
      const startText = customFromInput.value.trim();
      const endText = customToInput.value.trim();
      const parsedStart = parseDate(startText);
      const parsedEnd = parseDate(endText);
      if ((startText && !parsedStart) || (endText && !parsedEnd) ||
        (parsedStart && parsedEnd && parsedStart > parsedEnd)) {
        customError.textContent = (startText && !parsedStart) || (endText && !parsedEnd)
          ? "Enter a valid date (YYYY-MM-DD)."
          : "Start date must be on or before end date.";
        customError.hidden = false;
        if (startText && !parsedStart) {
          customFromInput.setAttribute("aria-invalid", "true");
          customFromInput.focus();
        } else if (endText && !parsedEnd) {
          customToInput.setAttribute("aria-invalid", "true");
          customToInput.focus();
        } else {
          customToInput.setAttribute("aria-invalid", "true");
          customToInput.focus();
        }
        return;
      }
      const start = parsedStart || parsedEnd;
      const end = parsedEnd || parsedStart;
      if (!start || !end) {
        currentPeriod = "all";
        customStartDate = null;
        customEndDate = null;
        activeDateRangePreset = "all";
        activeDateRangeLabel = "All Dates";
        appliedRange.start = "";
        appliedRange.end = "";
        dateRangeTriggerLabel.textContent = activeDateRangeLabel;
        customRangeBtn.setAttribute("aria-label", `Date range: ${activeDateRangeLabel}`);
        if (typeof setPeriod === "function") setPeriod(currentPeriod);
        else renderReport();
        closePicker();
        return;
      }
      const startISO = toISO(start);
      const endISO = toISO(end);
      const preset = pendingPreset;
      customStartDate = start;
      customEndDate = end;
      customFromInput.removeAttribute("aria-invalid");
      customToInput.removeAttribute("aria-invalid");
      currentPeriod = "custom";
      activeDateRangePreset = preset;
      activeDateRangeLabel = formatLabel(startISO, endISO, preset);
      appliedRange.start = startISO;
      appliedRange.end = endISO;
      dateRangeTriggerLabel.textContent = activeDateRangeLabel;
      customRangeBtn.setAttribute("aria-label", `Date range: ${activeDateRangeLabel}`);
      if (typeof setPeriod === "function") setPeriod(currentPeriod);
      else renderReport();
      closePicker();
    });
    customPopover.addEventListener("keydown", (event) => {
      const button = event.target.closest(".date-range-day");
      if (!button) return;
      const current = parseDate(button.dataset.date);
      let target = null;
      if (event.key === "ArrowLeft") target = new Date(current.getFullYear(), current.getMonth(), current.getDate() - 1);
      else if (event.key === "ArrowRight") target = new Date(current.getFullYear(), current.getMonth(), current.getDate() + 1);
      else if (event.key === "ArrowUp") target = new Date(current.getFullYear(), current.getMonth(), current.getDate() - 7);
      else if (event.key === "ArrowDown") target = new Date(current.getFullYear(), current.getMonth(), current.getDate() + 7);
      else if (event.key === "Home") target = new Date(current.getFullYear(), current.getMonth(), current.getDate() - current.getDay());
      else if (event.key === "End") target = new Date(current.getFullYear(), current.getMonth(), current.getDate() + 6 - current.getDay());
      else if (event.key === "PageUp" || event.key === "PageDown") {
        const offset = event.key === "PageUp" ? -1 : 1;
        const month = new Date(current.getFullYear(), current.getMonth() + offset, 1);
        const lastDay = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
        target = new Date(month.getFullYear(), month.getMonth(), Math.min(current.getDate(), lastDay));
      }
      if (!target) return;
      event.preventDefault();
      const firstVisibleMonth = new Date(viewYear, viewMonth, 1);
      const secondVisibleMonth = new Date(viewYear, viewMonth + 1, 1);
      const visibleMonths = window.matchMedia("(max-width: 760px)").matches
        ? [firstVisibleMonth]
        : [firstVisibleMonth, secondVisibleMonth];
      const targetIsVisible = visibleMonths.some((month) =>
        month.getFullYear() === target.getFullYear() && month.getMonth() === target.getMonth()
      );
      if (!targetIsVisible) {
        viewYear = target.getFullYear();
        viewMonth = target.getMonth();
        renderCalendars();
      }
      customPopover.querySelector(`.date-range-day[data-date="${toISO(target)}"]`)?.focus();
    });
    document.addEventListener("click", (event) => {
      if (!customPopover.hidden && !customPopover.contains(event.target) && !customRangeBtn.contains(event.target)) {
        closePicker();
      }
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !customPopover.hidden) closePicker();
    });
    renderCalendars();
    updateApplyButton();
  }

  function setupDownloadButton() {
    downloadCopyBtn.addEventListener("click", () => {
      const range = getSelectedDateRange();
      const oldTitle = document.title;
      const titleRange = range.start && range.end ? `${range.start}_to_${range.end}` : "All_Dates";
      document.title = `RECOVIBE_Activity_Summary_${titleRange}`;
      window.print();
      document.title = oldTitle;
    });
  }

  function escapeHTML(str) {
    return String(str ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[c]);
  }

  init();
})();
