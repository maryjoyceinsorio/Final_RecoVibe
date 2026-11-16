(() => {
  const DEBUG = false;
  const allEvents = getOrganizerEvents();
  const organizerId = localStorage.getItem("recovibeOrganizerId");
  const actionRows = document.getElementById("organizerActionRows");
  const upcomingEventsList = document.getElementById("upcomingEventsList");
  const happeningNowList = document.getElementById("happeningNowList");
  const eventDetailsModal = document.getElementById("eventDetailsModal");
  const eventDetailsTitle = document.getElementById("eventDetailsTitle");
  const eventDetailsHeadingMeta = document.getElementById(
    "eventDetailsHeadingMeta",
  );
  const eventDetailsContent = document.getElementById("eventDetailsContent");
  const eventDetailsDescription = document.getElementById(
    "eventDetailsDescription",
  );
  const eventDetailsSections = document.getElementById("eventDetailsSections");

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

  function toMillis(value) {
    if (value === null || value === undefined) return null;
    if (value instanceof Date) {
      const millis = value.getTime();
      return Number.isFinite(millis) ? millis : null;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) return null;
      const millis = Math.abs(value) < 100000000000 ? value * 1000 : value;
      return Number.isFinite(millis) ? millis : null;
    }
    if (typeof value === "string") {
      const text = value.trim();
      let dateText = "";
      const dateParts = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
      if (dateParts) {
        const calendarDate = new Date(0);
        calendarDate.setUTCFullYear(
          Number(dateParts[1]),
          Number(dateParts[2]) - 1,
          Number(dateParts[3]),
        );
        if (
          calendarDate.getUTCFullYear() !== Number(dateParts[1]) ||
          calendarDate.getUTCMonth() !== Number(dateParts[2]) - 1 ||
          calendarDate.getUTCDate() !== Number(dateParts[3])
        ) {
          return null;
        }
      }
      if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
        dateText = `${text}T00:00:00+08:00`;
      } else if (
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/i.test(text)
      ) {
        dateText = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)
          ? text
          : `${text}+08:00`;
      } else {
        return null;
      }
      const millis = Date.parse(dateText);
      return Number.isFinite(millis) ? millis : null;
    }
    if (typeof value.toMillis === "function") {
      try {
        const millis = value.toMillis();
        return Number.isFinite(millis) ? millis : null;
      } catch {
        return null;
      }
    }
    const seconds = value.seconds ?? value._seconds;
    if (typeof seconds === "number" && Number.isFinite(seconds)) {
      const nanos = Number(value.nanoseconds ?? value._nanoseconds ?? 0);
      const millis = seconds * 1000 + (Number.isFinite(nanos) ? nanos / 1000000 : 0);
      return Number.isFinite(millis) ? millis : null;
    }
    return null;
  }

  function formatCreatedDate(value) {
    const millis = toMillis(value);
    if (millis === null) return "—";
    const dayKey = (timestamp) =>
      new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Manila",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date(timestamp));
    const today = Date.now();
    if (dayKey(millis) === dayKey(today)) return "Today";
    if (dayKey(millis) === dayKey(today - 86400000)) return "Yesterday";
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Manila",
      month: "short",
      day: "numeric",
      year: "numeric",
    }).format(new Date(millis));
  }

  window.RecovibeOrganizerDashboardDates = Object.freeze({
    toMillis,
    formatCreatedDate,
  });

  const organizerEvents = allEvents.filter(
    (event) => organizerId && String(event.organizerId) === String(organizerId),
  );

  function readOrganizerProfile() {
    const storedProfile = localStorage.getItem("recovibeOrganizerProfile");

    if (!storedProfile) {
      return null;
    }

    try {
      const profile = JSON.parse(storedProfile);
      return profile && typeof profile === "object" ? profile : null;
    } catch (error) {
      console.error("Unable to read organizer profile:", error);
      return null;
    }
  }

  function updateOrganizerAccount() {
    const profile = readOrganizerProfile();
    const name = String(profile?.name || "Event Organizer");
    const firstName = String(profile?.firstName || "").trim() ||
      String(profile?.fullName || profile?.name || profile?.displayName || "")
        .trim()
        .split(/\s+/)[0] || "";
    const organizerDashboardHeading = document.getElementById(
      "organizerDashboardHeading",
    );
    const greeting = `Good ${getGreeting()}${firstName ? `, ${firstName}!` : "!"}`;
    if (organizerDashboardHeading && organizerDashboardHeading.textContent.trim() !== greeting) {
      organizerDashboardHeading.textContent = greeting;
    }
    if (!profile) return;

    const organization = String(profile?.organization || "IBITS");
    const initials =
      name
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((part) => part[0].toUpperCase())
        .join("") || "EO";

    const organizerName = document.getElementById("organizerName");
    const organizerRole = document.getElementById("organizerRole");
    const organizerAvatar = document.getElementById("organizerAvatar");
    if (organizerName) organizerName.textContent = name;
    if (organizerRole) organizerRole.textContent = profile ? `${organization} account` : "";
    if (organizerAvatar) organizerAvatar.textContent = initials;
  }

  function getGreeting() {
    const hour = new Date().getHours();

    if (hour < 12) {
      return "Morning";
    }

    if (hour < 18) {
      return "Noon";
    }

    return "Evening";
  }

  function formatDate(dateISO, fallback = "Date TBA") {
    if (!dateISO) {
      return fallback;
    }

    const dateValue = String(dateISO);
    const date = new Date(
      dateValue.includes("T") ? dateValue : `${dateValue}T00:00:00`,
    );

    if (Number.isNaN(date.getTime())) {
      return fallback;
    }

    return date.toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  }

  function getEventCreatedAt(event) {
    for (const field of ["createdAt", "submittedAt", "dateCreated", "createdAtMs", "updatedAt"]) {
      const millis = toMillis(event[field]);
      if (millis !== null) return millis;
    }
    if (DEBUG) {
      console.info("[OrganizerDashboard] No usable creation date for event:", event.eventId || event.id);
    }
    return null;
  }

  function getDateParts(
    dateISO,
    fallback = { month: "TBA", day: "", year: "" },
  ) {
    if (!dateISO) {
      return fallback;
    }

    const dateValue = String(dateISO);
    const date = new Date(
      dateValue.includes("T") ? dateValue : `${dateValue}T00:00:00`,
    );

    if (Number.isNaN(date.getTime())) {
      return fallback;
    }

    return {
      month: date.toLocaleDateString("en-US", { month: "short" }).toUpperCase(),
      day: String(date.getDate()).padStart(2, "0"),
      year: String(date.getFullYear()),
    };
  }

  function getApprovalStatus(event) {
    const raw = String(event.status || "Draft").trim();
    const norm = raw.toLowerCase().replace(/[ _-]+/g, " ");
    if (norm === "cancelled" || norm === "canceled") return "Cancelled";
    if (["rejected", "reject"].includes(norm)) return "Rejected";
    if (["needs revision", "revision requested", "changes requested", "revision", "rev"].includes(norm)) return "Needs Revision";
    if (norm === "draft") return "Draft";
    if (["published", "live", "published live"].includes(norm)) return "Published";
    if (norm === "upcoming") return "Upcoming";
    if (["pending", "pending approval", "under review", "in review", "reviewing", "submitted"].includes(norm)) return "Pending";
    if (norm === "completed") return "Unknown";
    if (["approved", "approve", "fully approved", "ready to publish", "ok"].includes(norm)) return "Approved";

    const approvalGroups = [
      Array.isArray(event.approvalStages)
        ? event.approvalStages
        : Object.values(event.approvalStages || {}),
      Object.values(event.approval?.members || {}),
      Object.values(event.approvalData?.members || {}),
    ];
    if (approvalGroups.some((members) => {
      const required = members.filter((member) => member && member.required !== false && member.enabled !== false);
      return required.length === 4 && required.every((member) =>
        ["approved", "ok"].includes(String(member.status || member.approvalStatus || member.state || member.decision || "").trim().toLowerCase()),
      );
    })) return "Approved";

    const hap1 = isOrganizerEventHapApproved(event, 1);
    const hap2 = isOrganizerEventHapApproved(event, 2);
    const hap3 = isOrganizerEventHapApproved(event, 3);
    const checkCount = (hap1 ? 1 : 0) + (hap2 ? 1 : 0) + (hap3 ? 1 : 0);

    return checkCount === 3 ? "Approved" : "Pending";
  }

  function hasEventEnded(event) {
    const endDateValue = event.endDateISO || event.dateEnd || event.endDate || event.dateISO || event.date;
    if (!endDateValue) return false;
    const dateText = String(endDateValue).trim().slice(0, 10);
    const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateText);
    if (!dateMatch) return false;
    const endDate = new Date(
      Number(dateMatch[1]),
      Number(dateMatch[2]) - 1,
      Number(dateMatch[3]),
    );
    if (Number.isNaN(endDate.getTime())) return false;

    const endTime = String(event.endTime || event.timeEnd || "").trim();
    if (!endTime) {
      endDate.setHours(23, 59, 59, 999);
    } else {
      const timeMatch = /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?$/i.exec(endTime);
      if (!timeMatch) return false;
      let hours = Number(timeMatch[1]);
      const minutes = Number(timeMatch[2]);
      const seconds = Number(timeMatch[3] || 0);
      const meridiem = String(timeMatch[4] || "").toUpperCase();
      if (meridiem) {
        if (hours < 1 || hours > 12) return false;
        if (hours === 12) hours = 0;
        if (meridiem === "PM") hours += 12;
      } else if (hours > 23) {
        return false;
      }
      if (minutes > 59 || seconds > 59) return false;
      endDate.setHours(hours, minutes, seconds, 0);
    }

    return endDate.getTime() <= Date.now();
  }

  function getStatus(event) {
    const status = getApprovalStatus(event);
    return status === "Published" && hasEventEnded(event) ? "Completed" : status;
  }

  function getStatusClass(status) {
    return status.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  }

  function isHoliday(event) {
    if (!event) return true;
    const id = String(event.id || event.eventId || "");
    const src = String(event.source || event.organizerName || "").toLowerCase();
    const cat = String(event.category || "").toLowerCase();
    const title = String(event.title || "").toLowerCase();
    return (
      event.isHoliday === true ||
      id.startsWith("holiday:") ||
      src.includes("holiday") ||
      cat.includes("holiday") ||
      title.includes("holiday")
    );
  }

  function openEventDetails(event) {
    if (!eventDetailsModal || !event || isHoliday(event)) return;
    window.RecovibeEventDetails?.open(event, { showApprovalDocuments: true });
  }

  function closeEventDetails() {
    if (!eventDetailsModal) return;
    eventDetailsModal.hidden = true;
    document.body.classList.remove("modal-open");
  }

  function getCounts() {
    return {
      active: organizerEvents.filter((event) =>
        ["Draft", "Pending", "Approved", "Upcoming"].includes(getStatus(event)),
      ).length,
      pending: organizerEvents.filter((event) =>
        ["Pending", "Needs Revision"].includes(getStatus(event)) &&
        !["Approved", "Published"].includes(getStatus(event)),
      ).length,
      approved: organizerEvents.filter(
        (event) => getStatus(event) === "Approved",
      ).length,
      completed: organizerEvents.filter(
        (event) => getStatus(event) === "Completed",
      ).length,
    };
  }

  function renderStatistics() {
    const counts = getCounts();

    document.getElementById("activeEventsCount").textContent = counts.active;
    document.getElementById("pendingApprovalCount").textContent =
      counts.pending;
    document.getElementById("approvedEventsCount").textContent =
      counts.approved;
    document.getElementById("completedEventsCount").textContent =
      counts.completed;
  }

  function renderActionRequired() {
    const actionableEvents = organizerEvents
      .filter((event) =>
        ["Draft", "Pending", "Needs Revision", "Rejected", "Approved"].includes(getStatus(event)),
      )
      .sort((first, second) => {
        const firstCreated = getEventCreatedAt(first);
        const secondCreated = getEventCreatedAt(second);
        if (firstCreated === null) return secondCreated === null ? 0 : 1;
        if (secondCreated === null) return -1;
        return secondCreated - firstCreated;
      });

    if (!actionableEvents.length) {
      actionRows.innerHTML = `
        <tr>
          <td colspan="3">
            <div class="dashboard-empty-state">
              <strong>Nothing needs your action right now.</strong>
            </div>
          </td>
        </tr>`;
      return;
    }

    actionRows.innerHTML = actionableEvents
      .map((event) => {
        const status = getStatus(event);
        const statusClass = getStatusClass(status);
        const createdAt = getEventCreatedAt(event);

        return `
        <tr data-event-id="${escapeHtml(event.eventId)}" style="cursor: pointer;">
          <td>
            <strong>${escapeHtml(event.title || "Untitled event")}</strong>
            <small>${escapeHtml(event.category || "General")}</small>
          </td>
          <td>${escapeHtml(createdAt === null ? "—" : formatCreatedDate(createdAt))}</td>
          <td>
            <span class="organizer-status ${statusClass}">
              ${escapeHtml(status)}
            </span>
          </td>
        </tr>`;
      })
      .join("");
  }

  function renderHappeningNow() {
    if (!happeningNowList) return;
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    const todayISO = `${year}-${month}-${day}`;

    const happeningEvents = organizerEvents
      .filter((event) => {
        if (!event.dateISO) return false;
        const startISO = String(event.dateISO).slice(0, 10);
        const endISO = String(event.endDateISO || event.endDate || event.dateEnd || startISO).slice(0, 10);
        const status = getStatus(event);
        if (status === "Cancelled" || status === "Rejected") return false;
        return startISO <= todayISO && endISO >= todayISO;
      })
      .sort((first, second) => first.dateISO.localeCompare(second.dateISO));

    if (!happeningEvents.length) {
      happeningNowList.innerHTML = `
        <div class="dashboard-empty-state compact">
          <strong>No events happening today</strong>
          <span>Events scheduled for today will appear here.</span>
        </div>`;
      return;
    }

    happeningNowList.innerHTML = happeningEvents
      .map((event) => {
        const dateParts = getDateParts(event.dateISO);

        return `
        <article class="upcoming-event" data-event-id="${escapeHtml(event.eventId)}" style="cursor: pointer;">
          <div class="upcoming-event-date">
            <span class="upcoming-event-month">${escapeHtml(dateParts.month)}</span>
            <strong>${escapeHtml(dateParts.day)}</strong>
            <small>${escapeHtml(dateParts.year)}</small>
          </div>
          <div class="upcoming-event-content">
            <strong>${escapeHtml(event.title || "Untitled event")}</strong>
            <span>${escapeHtml(event.time || "Time TBA")}</span>
            <span>${escapeHtml(event.location || event.venue || "Location TBA")}</span>
          </div>
        </article>`;
      })
      .join("");
  }

  function renderUpcomingEvents() {
    if (!upcomingEventsList) return;
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    const todayISO = `${year}-${month}-${day}`;

    const upcomingEvents = organizerEvents
      .filter((event) => {
        if (!event.dateISO) return false;
        const startISO = String(event.dateISO).slice(0, 10);
        const status = getStatus(event);
        if (status === "Cancelled" || status === "Rejected") return false;
        return startISO > todayISO;
      })
      .sort((first, second) => first.dateISO.localeCompare(second.dateISO))
      .slice(0, 4);

    if (!upcomingEvents.length) {
      upcomingEventsList.innerHTML = `
        <div class="dashboard-empty-state compact">
          <strong>No upcoming events</strong>
          <span>Future events you create will appear here.</span>
        </div>`;
      return;
    }

    upcomingEventsList.innerHTML = upcomingEvents
      .map((event) => {
        const dateParts = getDateParts(event.dateISO);

        return `
        <article class="upcoming-event" data-event-id="${escapeHtml(event.eventId)}" style="cursor: pointer;">
          <div class="upcoming-event-date">
            <span class="upcoming-event-month">${escapeHtml(dateParts.month)}</span>
            <strong>${escapeHtml(dateParts.day)}</strong>
            <small>${escapeHtml(dateParts.year)}</small>
          </div>
          <div class="upcoming-event-content">
            <strong>${escapeHtml(event.title || "Untitled event")}</strong>
            <span>${escapeHtml(event.time || "Time TBA")}</span>
            <span>${escapeHtml(event.location || event.venue || "Location TBA")}</span>
          </div>
        </article>`;
      })
      .join("");
  }

  const organizerToday = document.getElementById("organizerToday");
  function updateTodayDate() {
    const currentDate = new Date();
    if (organizerToday) {
      organizerToday.textContent = currentDate.toLocaleDateString("en-US", {
        month: "long",
        day: "numeric",
        year: "numeric",
      });
    }
    updateOrganizerAccount();
  }
  if (organizerToday) {
    updateTodayDate();
  }

  setInterval(updateTodayDate, 60000);

  const organizerDashboardHeading = document.getElementById("organizerDashboardHeading");
  if (organizerDashboardHeading) {
    new MutationObserver(() => {
      updateOrganizerAccount();
    }).observe(organizerDashboardHeading, {
      childList: true,
      characterData: true,
      subtree: true,
    });
  }

  window.addEventListener("storage", (event) => {
    if (event.key === "recovibeOrganizerEvents") window.location.reload();
  });

  actionRows.addEventListener("click", (event) => {
    const item = event.target.closest("[data-event-id]");
    if (!item) return;
    const selectedEvent = organizerEvents.find(
      (entry) => String(entry.eventId) === item.dataset.eventId,
    );
    if (selectedEvent) openEventDetails(selectedEvent);
  });

  [happeningNowList, upcomingEventsList].forEach((container) => {
    container?.addEventListener("click", (event) => {
      const item = event.target.closest("[data-event-id]");
      if (!item) return;
      const selectedEvent = organizerEvents.find(
        (entry) => String(entry.eventId) === item.dataset.eventId,
      );
      if (selectedEvent) openEventDetails(selectedEvent);
    });
  });

  if (eventDetailsModal) {
    eventDetailsModal.addEventListener("click", (event) => {
      if (event.target.hasAttribute("data-modal-close")) closeEventDetails();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !eventDetailsModal.hidden)
        closeEventDetails();
    });
  }

  document.getElementById("organizerLogout").addEventListener("click", () => {
    localStorage.removeItem("recovibeCurrentOrganizer");
  });
})();
