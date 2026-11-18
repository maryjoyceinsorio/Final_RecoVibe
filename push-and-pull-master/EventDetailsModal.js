(function () {
  "use strict";

  if (window.RecovibeEventDetails) return;

  const stylesheet = document.createElement("link");
  stylesheet.rel = "stylesheet";
  stylesheet.href = new URL(
    "EventDetailsModal.css",
    document.currentScript.src,
  ).href;
  document.head.appendChild(stylesheet);

  const escapeHTML = (value) =>
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

  const asList = (value) => {
    if (value == null || value === "") return [];
    return (Array.isArray(value) ? value : [value]).filter(
      (item) => item != null && item !== "",
    );
  };

  const dateText = (value) => {
    if (!value) return "";
    const dateValue = value instanceof Date
      ? value
      : new Date(`${String(value).slice(0, 10)}T00:00:00`);
    return Number.isNaN(dateValue.getTime())
      ? String(value)
      : `${String(dateValue.getMonth() + 1).padStart(2, "0")} / ${String(dateValue.getDate()).padStart(2, "0")} / ${dateValue.getFullYear()}`;
  };

  const safeHttpUrl = (value) => {
    try {
      const url = new URL(String(value));
      return ["http:", "https:"].includes(url.protocol) ? url.href : "";
    } catch {
      return "";
    }
  };

  const listMarkup = (items) => {
    const values = normalizeList(items)
      .map((item) =>
        typeof item === "object"
          ? item.name || item.title || item.label || item.filename || item.fileName || ""
          : item,
      )
      .filter(Boolean);
    return `<ul class="student-event-list">${(values.length ? values : ["N/A"])
      .map((item) => `<li>${escapeHTML(item)}</li>`)
      .join("")}</ul>`;
  };

  const documentMarkup = (items) =>
    items
      .map((item) => {
        const name =
          typeof item === "object"
            ? item.name || item.title || item.fileName || ""
            : item;
        const href =
          typeof item === "object"
            ? item.url || item.href || item.downloadURL || item.downloadUrl || item.fileUrl || ""
            : "";
        if (!name) return "";
        const icon =
          '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2.5v10m0 0 3.5-3.5M10 12.5 6.5 9M3.5 13.5v3h13v-3"/></svg>';
        const link = href && /^(https?:|blob:|\.\.?\/|\/)/i.test(href)
          ? `<a href="${escapeHTML(href)}" download="${escapeHTML(name)}" aria-label="Download ${escapeHTML(name)}" title="Download ${escapeHTML(name)}">${icon}</a>`
          : `<span title="Download link unavailable" aria-label="Download unavailable">${icon}</span>`;
        return `<div class="student-event-attachment"><span>${escapeHTML(name)}</span>${link}</div>`;
      })
      .join("");

  const categoryTone = (value) => {
    const category = String(value || "").toLowerCase();
    if (/social|arts|culture/.test(category)) return "purple";
    if (/university|campus|community/.test(category)) return "green";
    if (/academic|tech|innovation/.test(category)) return "blue";
    if (/sport|fitness/.test(category)) return "orange";
    return "maroon";
  };

  function normalizeList(value) {
    const values = Array.isArray(value) ? value : [value];
    return values.flatMap((item) => {
      if (typeof item === "string")
        return item
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean);
      return item == null ? [] : [item];
    });
  }

  function getRequirements(event) {
    const requirements = event.requirements;
    if (Array.isArray(requirements) || typeof requirements === "string") {
      return normalizeList(requirements);
    }
    if (requirements && typeof requirements === "object") {
      return [
        ...normalizeList(requirements.required),
        ...normalizeList(requirements.recommended),
      ];
    }
    return normalizeList(event.requiredDocuments || event.requirementsList);
  }

  function createModal() {
    const overlay = document.createElement("div");
    overlay.className = "event-details-overlay student-event-overlay";
    overlay.setAttribute("aria-hidden", "true");
    overlay.innerHTML = `
      <section class="event-details-dialog student-event-dialog" role="dialog" aria-modal="true" aria-labelledby="sharedEventDetailsTitle" tabindex="-1">
        <header class="student-event-shell-header">
          <button class="student-event-close event-details-close" type="button" aria-label="Close event details">&times;</button>
          <div class="student-event-top" data-field="header"></div>
        </header>
        <div class="student-event-content">
          <div class="student-event-detail-content" data-field="content"></div>
        </div>
        <footer class="student-event-footer event-details-footer"><p class="student-event-notice" role="status"></p><button type="button" class="student-event-action event-details-action"></button></footer>
      </section>`;
    document.body.appendChild(overlay);
    return overlay;
  }

  let overlay;
  let previousFocus;
  let savedScrollY = 0;
  let savedBodyStyles;

  function getOverlay() {
    if (!overlay) overlay = createModal();
    return overlay;
  }

  function isHoliday(event) {
    if (!event) return true;
    const id = String(event.id || event.eventId || "");
    const src = String(
      event.source || event.eventSource || event.organizerName || "",
    ).toLowerCase();
    const cat = String(event.category || "").toLowerCase();
    const title = String(event.title || event.name || "").toLowerCase();
    return (
      event.isHoliday === true ||
      id.startsWith("holiday:") ||
      src.includes("holiday") ||
      cat.includes("holiday") ||
      title.includes("philippine holiday") ||
      title.includes("holiday")
    );
  }

  function render(event, options = {}) {
    if (!event || isHoliday(event)) return;
    const showFacultyInCharge = /\/User(?:EventOrganizer|Admin)\//i.test(location.pathname);
    const source = [
      event.source || event.eventSource || event.campus || event.office,
      event.sourceOther,
    ].filter(Boolean).join(" · ") || "N/A";
    const organizer =
      event.organizerName || event.organizer || event.organization || "N/A";
    const categories = normalizeList(event.categories || event.category || event.tag);
    const categoryNames = categories.map((item) =>
      typeof item === "object" ? item.name || item.title || item.label || "" : item,
    ).filter(Boolean);
    const badgeList = categoryNames.length ? categoryNames : ["General"];
    const targetAudience = normalizeList(event.targetAudience || event.targetYear)
      .map((item) => typeof item === "object" ? item.name || item.title || item.label || "" : item)
      .filter(Boolean)
      .join(", ") || "Open to All";
    const attendanceRequired =
      typeof event.attendanceRequired === "boolean"
        ? event.attendanceRequired ? "Required" : "Not Required"
        : event.attendanceRequired || "N/A";
    const dateStart = event.dateStart || event.dateISO || event.date;
    const dateEnd = event.dateEnd || event.endDate || event.eventEndDate || dateStart;
    const timeParts = event.startTime || event.endTime
      ? [event.startTime, event.endTime]
      : String(event.time || "").split(/\s*[-–]\s*/);
    const timeText = (value) => {
      const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || "").trim());
      if (!match) return String(value || "").trim() || "N/A";
      const hour = Number(match[1]);
      return `${String(hour % 12 || 12).padStart(2, "0")}:${match[2]} ${hour >= 12 ? "PM" : "AM"}`;
    };
    const dailySchedules = Array.isArray(event.dailySchedules)
      ? event.dailySchedules
      : [];
    const differentTimesByDay =
      dailySchedules.length > 0 &&
      (/different\s+time/i.test(String(event.dailySchedule || "")) ||
        dailySchedules.length > 1);
    const scheduleRows = dailySchedules
      .map((schedule, index) => {
        const scheduleDate = schedule.date || schedule.dateISO || "";
        const scheduleLabel =
          schedule.label ||
          (index === 0
            ? "First Day"
            : index === dailySchedules.length - 1
              ? "Last Day"
              : `Day ${index + 1}`);
        return `<div class="student-event-daily-row"><strong>${escapeHTML(scheduleLabel)}</strong><span>${escapeHTML(dateText(scheduleDate) || "N/A")}</span><strong>Time Start</strong><span>${escapeHTML(timeText(schedule.timeStart))}</span><strong>Time End</strong><span>${escapeHTML(timeText(schedule.timeEnd))}</span></div>`;
      })
      .join("");
    const dateTimeText = (value) => {
      if (!value) return "N/A";
      const [date, time] = String(value).split(/[T ]/, 2);
      return `${dateText(date) || "N/A"}${time ? ` · ${timeText(time.slice(0, 5))}` : ""}`;
    };
    const venue = [
      event.venue || event.location || event.venueOther || event.venueName,
      event.room || event.roomNumber,
    ].filter(Boolean).join(" · ") || "N/A";
    const venueType = event.venueType || event.weatherContingency || "N/A";
    const rawCapacity =
      event.capacity ?? event.maxCapacity ?? event.maxSlots ?? event.slots;
    const parsedCapacity = rawCapacity == null || rawCapacity === ""
      ? NaN
      : Number(rawCapacity);
    const capacityKnown =
      Number.isFinite(parsedCapacity) && parsedCapacity >= 0;
    const capacity = capacityKnown ? Math.floor(parsedCapacity) : null;
    const noCapacityLimit =
      capacity == null && event.capacityMode === "N/A";
    const registeredCount = Math.max(
      0,
      Math.floor(Number(event.registeredCount) || 0),
    );
    const slotsLeft =
      capacity == null
        ? Infinity
        : Math.max(0, Math.min(capacity, capacity - registeredCount));
    const openSlots = slotsLeft;
    const expectedParticipants =
      event.expectedParticipants ?? event.registeredCount ??
      (!capacityKnown ? "N/A" : Math.max(0, Number(capacity) - Number(slotsLeft || 0)));
    const availability = noCapacityLimit
      ? "Open registration"
      : !capacityKnown
        ? "N/A"
        : `${openSlots ?? slotsLeft}${capacity != null ? ` of ${capacity}` : ""} slots open`;
    const description = String(event.description || event.desc || event.about || "N/A")
      .split(/\n\s*\n/)
      .map((item) => item.trim())
      .filter(Boolean);
    const requirements = getRequirements(event);
    const rules = [
      ...asList(event.participationRules || event.rules),
      ...asList(event.reminders),
      ...requirements,
    ];
    const objectives = event.objectives || event.keyDetails || event.detailedInfo || event.focusAreas || event.tags;
    const participantDocuments = asList(
      event.participantDocuments ||
        event.participantDocs ||
        event.registrationDocuments,
    );
    const approvalDocuments = options.showApprovalDocuments
      ? asList(
          event.approvalDocuments ||
            event.approvalDocs ||
            event.organizerDocuments,
        )
      : [];
    const contactInfo =
      event.contactPerson && typeof event.contactPerson === "object"
        ? event.contactPerson
        : {};
    const contactParts = (typeof event.contactPerson === "string"
      ? event.contactPerson
      : event.contactName || ""
    ).split(/[\n,|]+/).map((item) => item.trim()).filter(Boolean);
    const contactEmail =
      contactInfo.email ||
      event.contactEmail ||
      contactParts.find((item) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(item)) ||
      "";
    const contactPhone =
      contactInfo.phone ||
      event.contactPhone ||
      contactParts.find((item) => /\+?[\d() -]{7,}/.test(item) && /\d{7}/.test(item)) ||
      "";
    const contactName =
      contactInfo.name ||
      event.contactName ||
      contactParts.find((item) => item !== contactEmail && item !== contactPhone) ||
      event.organizerName ||
      "";
    const contactRole =
      contactInfo.role ||
      event.contactRole ||
      contactParts.find((item) => item !== contactName && item !== contactEmail && item !== contactPhone) ||
      "";
    const facultyInChargeValue = event.facultyInCharge || event.faculty_in_charge || "";
    const facultyInChargeName = typeof facultyInChargeValue === "object"
      ? facultyInChargeValue.name || event.facultyInChargeName || facultyInChargeValue.id || ""
      : facultyInChargeValue || event.facultyInChargeName || event.facultyInChargeId || "";
    const bannerUrl =
      typeof event.bannerImage === "string" &&
      /^data:image\/(?:png|jpeg|webp);base64,/i.test(event.bannerImage)
        ? event.bannerImage
        : safeHttpUrl(event.bannerImage || event.bannerUrl);
    const modal = getOverlay();
    const header = modal.querySelector('[data-field="header"]');
    const title = event.title || event.eventName || "Untitled event";
    header.innerHTML = `
      <div class="student-event-heading">
        <h2 class="student-event-title" id="sharedEventDetailsTitle">${escapeHTML(title)}</h2>
        <p><strong>Event Organizer:</strong> ${escapeHTML(organizer)}</p>
        <p><strong>Event Source:</strong> ${escapeHTML(source)}</p>
      </div>
      <div class="student-event-header-meta">
        <div><strong>Categories:</strong><div class="student-event-categories" title="${escapeHTML(badgeList.join(", "))}">${badgeList.map((category) => `<span class="student-event-pill student-event-pill--${categoryTone(category)}" title="${escapeHTML(category)}">${escapeHTML(category)}</span>`).join("")}</div></div>
        <p><strong>Target Audience:</strong> ${escapeHTML(targetAudience)}</p>
        <p><strong>Attendance:</strong> ${escapeHTML(attendanceRequired)}</p>
      </div>`;
    const infoCard = (label, value) =>
      `<div class="student-event-info-card"><strong>${escapeHTML(label)}</strong><span>${escapeHTML(value || "N/A")}</span></div>`;
    const registrationEnd = event.registrationEnd || event.registrationDeadline;
    const platformUrl = safeHttpUrl(event.platformLink);
    const detailContent = [
      `<section class="student-event-info" aria-label="Event schedule and capacity">
        ${infoCard("Date Start", dateText(dateStart) || "N/A")}
        ${infoCard("Date End", dateText(dateEnd) || "N/A")}
        ${infoCard("Time Start", differentTimesByDay ? "N/A" : timeText(timeParts[0]))}
        ${infoCard("Time End", differentTimesByDay ? "N/A" : timeText(timeParts[1]))}
        ${infoCard("Venue", venue)}
        ${infoCard("Venue Type", venueType)}
        ${infoCard("Max Capacity", noCapacityLimit ? "No limit" : capacityKnown ? `${capacity} People` : "N/A")}
        ${infoCard("Expected Participants", String(expectedParticipants))}
        ${infoCard("Slots Left", noCapacityLimit ? "Open registration" : capacityKnown ? `${slotsLeft ?? Math.max(0, Number(capacity) - Number(event.registeredCount || 0))} of ${capacity}` : "N/A")}
      </section>`,
      `<section class="student-event-section student-event-registration">
        <h3>Registration Information</h3>
        <div class="student-event-registration-grid">
          <p><strong>Registration Start:</strong> ${escapeHTML(dateTimeText(event.registrationStart) || "N/A")}</p>
          <p><strong>Registration End:</strong> ${escapeHTML(dateTimeText(registrationEnd) || "N/A")}</p>
          <p><strong>Registration:</strong> ${escapeHTML(event.registrationInfo || event.registrationStatus || event.status || "N/A")}</p>
          ${platformUrl ? `<p><strong>Platform:</strong> <a href="${escapeHTML(platformUrl)}" target="_blank" rel="noopener noreferrer">Join event online</a></p>` : ""}
          <p><strong>Availability:</strong> ${escapeHTML(availability)}</p>
          ${differentTimesByDay ? `<div class="student-event-daily-schedule"><h3>Different Time Per Day</h3><div>${scheduleRows}</div></div>` : ""}
        </div>
      </section>`,
      `<section class="student-event-section student-event-description"><h3>Event Description</h3>${bannerUrl ? `<img class="event-details-banner student-event-banner" src="${escapeHTML(bannerUrl)}" alt="${escapeHTML(event.bannerFileName || title)}">` : ""}${description.map((paragraph) => `<p>${escapeHTML(paragraph)}</p>`).join("")}</section>`,
      `<section class="student-event-section"><h3>Rationale</h3><p>${escapeHTML(event.rationale || "N/A")}</p></section>`,
      `<section class="student-event-section"><h3>Objectives</h3>${listMarkup(asList(objectives).length ? asList(objectives) : ["N/A"])}</section>`,
      `<section class="student-event-section"><h3>Rules &amp; Reminders</h3>${listMarkup(rules.length ? rules : ["N/A"])}</section>`,
      `<div class="student-event-bottom-grid">
        <section class="student-event-section student-event-contact"><h3>Contact Person</h3><p><strong>Name:</strong> ${escapeHTML(contactName || "N/A")}</p><p><strong>Role:</strong> ${escapeHTML(contactRole || "N/A")}</p><p><strong>Email:</strong> ${contactEmail ? `<a href="mailto:${escapeHTML(contactEmail)}">${escapeHTML(contactEmail)}</a>` : "N/A"}</p><p><strong>Number:</strong> ${escapeHTML(contactPhone || "N/A")}</p><p><strong>Faculty In Charge:</strong> ${escapeHTML(showFacultyInCharge ? facultyInChargeName || "N/A" : "N/A")}</p></section>
        <section class="student-event-section student-event-documents"><h3>Participant Documents</h3><p>Open the Google Drive links to download the required files.</p><div class="student-event-attachments">${participantDocuments.length ? documentMarkup(participantDocuments) : '<p class="student-event-no-documents">No files attached.</p>'}</div><small>(Make sure to download and fill up these files. Its needed for participation)</small>${approvalDocuments.length ? `<div class="student-event-approval-documents"><p><strong>Approval Documents</strong></p><div class="student-event-attachments">${documentMarkup(approvalDocuments)}</div></div>` : ""}</section>
      </div>`,
    ].join("");
    modal.querySelector('[data-field="content"]').innerHTML = detailContent;

    const action = modal.querySelector(".event-details-action");
    action.textContent = options.actionLabel || "Continue";
    action.disabled =
      typeof options.onAction !== "function" || Boolean(options.actionDisabled);
    modal.querySelector(".student-event-notice").textContent =
      event.registrationStatus || event.status || "Registration status: N/A";
    action.onclick =
      typeof options.onAction === "function"
        ? () => {
            const response = options.onAction(event);
            if (typeof response === "string") action.textContent = response;
          }
        : null;

    previousFocus = document.activeElement;
    savedScrollY = window.scrollY;
    const pageWidth = document.documentElement.clientWidth;
    savedBodyStyles = {
      position: document.body.style.position,
      top: document.body.style.top,
      width: document.body.style.width,
      overflow: document.body.style.overflow,
    };
    document.body.classList.add("event-details-page-locked");
    document.body.style.position = "fixed";
    document.body.style.top = `-${savedScrollY}px`;
    document.body.style.width = `${pageWidth}px`;
    document.body.style.overflow = "hidden";
    modal.setAttribute("aria-hidden", "false");
    void modal.offsetWidth;
    modal.classList.add("is-open");
    modal.querySelector(".event-details-close").focus();
  }

  function close() {
    if (!overlay || overlay.getAttribute("aria-hidden") === "true") return;
    overlay.classList.remove("is-open");
    overlay.setAttribute("aria-hidden", "true");
    document.body.classList.remove("event-details-page-locked");
    document.body.style.position = savedBodyStyles.position;
    document.body.style.top = savedBodyStyles.top;
    document.body.style.width = savedBodyStyles.width;
    document.body.style.overflow = savedBodyStyles.overflow;
    window.scrollTo(0, savedScrollY);
    if (previousFocus && typeof previousFocus.focus === "function")
      previousFocus.focus();
  }

  document.addEventListener("click", (event) => {
    if (!overlay || overlay.getAttribute("aria-hidden") === "true") return;
    if (
      event.target.closest(".event-details-close") ||
      event.target === overlay
    )
      close();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close();
  });

  window.RecovibeEventDetails = { open: render, close };

  function createStudentRegistrationModal() {
    const detailOverlay = document.createElement("div");
    detailOverlay.className = "student-event-overlay";
    detailOverlay.setAttribute("aria-hidden", "true");
    detailOverlay.innerHTML = `
      <section class="student-event-dialog" id="studentEventDetailsDialog" role="dialog" aria-modal="true" aria-labelledby="studentEventTitle" tabindex="-1">
        <header class="student-event-shell-header">
          <button class="student-event-close" type="button" aria-label="Close event details">&times;</button>
          <div class="student-event-top"></div>
        </header>
        <div class="student-event-content"><div class="student-event-detail-content"></div></div>
        <footer class="student-event-footer event-details-footer"><p class="student-event-notice" role="status"></p><button class="student-event-action event-details-action" type="button"></button></footer>
      </section>`;

    const confirmOverlay = document.createElement("div");
    confirmOverlay.className =
      "student-event-overlay student-event-confirm-overlay";
    confirmOverlay.setAttribute("aria-hidden", "true");
    confirmOverlay.innerHTML = `
      <section class="student-event-confirm" role="dialog" aria-modal="true" aria-labelledby="studentEventConfirmTitle" tabindex="-1">
        <h2 id="studentEventConfirmTitle"></h2><p class="student-event-confirm-message"></p>
        <p class="student-event-error" role="alert"></p>
        <div class="student-event-confirm-actions"><button class="student-event-confirm-primary" type="button"></button><button class="student-event-confirm-cancel" type="button"></button></div>
      </section>`;
    document.body.append(detailOverlay, confirmOverlay);

    const detailDialog = detailOverlay.querySelector('[role="dialog"]');
    const confirmDialog = confirmOverlay.querySelector('[role="dialog"]');
    const detailContent = detailOverlay.querySelector(".student-event-detail-content");
    const detailHeader = detailOverlay.querySelector(".student-event-top");
    const actionButton = detailOverlay.querySelector(".student-event-action");
    const primaryButton = confirmOverlay.querySelector(
      ".student-event-confirm-primary",
    );
    const cancelButton = confirmOverlay.querySelector(
      ".student-event-confirm-cancel",
    );
    const titleElement = confirmOverlay.querySelector(
      "#studentEventConfirmTitle",
    );
    const messageElement = confirmOverlay.querySelector(
      ".student-event-confirm-message",
    );
    const errorElement = confirmOverlay.querySelector(".student-event-error");
    const noticeElement = detailOverlay.querySelector(".student-event-notice");
    const participationKey = "recovibeParticipations";
    const slotsKey = "recovibeEventSlots";
    let selectedEvent = null;
    let selectedAction = "join";
    let pending = false;
    let dashboardRegistrationConfirmation = false;
    let previousFocus = null;
    let bodyOverflow = "";

    const readObject = (key) => {
      try {
        const value = JSON.parse(localStorage.getItem(key) || "{}");
        return value && typeof value === "object" && !Array.isArray(value)
          ? value
          : {};
      } catch (error) {
        return {};
      }
    };
    const readIds = () => {
      try {
        const value = JSON.parse(
          localStorage.getItem(participationKey) || "[]",
        );
        return new Set(Array.isArray(value) ? value.map(String) : []);
      } catch (error) {
        return new Set();
      }
    };
    const capacity = (event) =>
      event.capacityMode === "N/A"
        ? null
        : Math.max(
            0,
            Math.floor(
              Number(
                event.capacity ??
                  event.maxCapacity ??
                  event.maxSlots ??
                  event.slots ??
                  0,
              ) || 0,
            ),
          );
    const openSlots = (event) => {
      if (event.capacityMode === "N/A") return Infinity;
      const eventCapacity = capacity(event);
      const registeredCount = Math.max(
        0,
        Math.floor(Number(event.registeredCount) || 0),
      );
      return Math.max(
        0,
        Math.min(eventCapacity, eventCapacity - registeredCount),
      );
    };
    const categoryTone = (value) => {
      const category = String(value || "").toLowerCase();
      if (/leadership|career/.test(category)) return "maroon";
      if (/academic|university/.test(category)) return "blue";
      if (/tech|innovation|org|seminar/.test(category)) return "purple";
      if (/sport|fitness|community/.test(category)) return "green";
      if (/social|art|culture|music|competition/.test(category)) return "orange";
      return "maroon";
    };
    const displayText = (value, fallback = "N/A", event = selectedEvent) => {
      let result = value;
      if (typeof result === "function") {
        try {
          result = result(event);
        } catch (error) {
          return fallback;
        }
      }
      if (typeof result === "string") {
        const normalized = result.trim();
        return !normalized ||
          /^(?:undefined|null|nan|infinity|\[object object\])$/i.test(normalized) ||
          /^(?:async\s+)?function\b|^(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/.test(normalized)
          ? fallback
          : normalized;
      }
      if (typeof result === "number") return Number.isFinite(result) ? String(result) : fallback;
      if (typeof result === "boolean") return result ? "Yes" : "No";
      if (result && typeof result === "object") {
        const label = result.name || result.title || result.label ||
          result.filename || result.fileName;
        return label === undefined ? fallback : displayText(label, fallback, event);
      }
      return fallback;
    };
    const text = (item) => displayText(item, "");
    const entries = (value) => {
      const values =
        value == null || value === ""
          ? []
          : Array.isArray(value)
            ? value
            : [value];
      return values.flatMap((item) =>
        typeof item === "string"
          ? item
              .split(/\r?\n/)
              .map((line) => line.trim())
              .filter(Boolean)
          : item == null
            ? []
            : [item],
      );
    };
    const bullets = (value) => {
      const items = entries(value).map(text).filter(Boolean);
      return `<ul class="student-event-list">${(items.length ? items : ["N/A"])
        .map((item) => `<li>${escapeHTML(item)}</li>`)
        .join("")}</ul>`;
    };
    const dateText = (value) => {
      let dateValue = value;
      if (typeof dateValue === "function") {
        try {
          dateValue = dateValue(selectedEvent);
        } catch (error) {
          return "N/A";
        }
      }
      if (typeof dateValue?.toDate === "function") dateValue = dateValue.toDate();
      const date = dateValue instanceof Date
        ? dateValue
        : typeof dateValue === "number"
          ? new Date(dateValue)
          : typeof dateValue === "string" && /^\d{4}-\d{2}-\d{2}/.test(dateValue)
            ? new Date(`${dateValue.slice(0, 10)}T00:00:00`)
            : null;
      return date && !Number.isNaN(date.getTime())
        ? `${String(date.getMonth() + 1).padStart(2, "0")} / ${String(date.getDate()).padStart(2, "0")} / ${date.getFullYear()}`
        : "N/A";
    };
    const dateTimeText = (value) => {
      if (!value) return "N/A";
      if (typeof value === "function") {
        try {
          value = value(selectedEvent);
        } catch (error) {
          return "N/A";
        }
      }
      if (value instanceof Date || typeof value?.toDate === "function") {
        return dateText(value);
      }
      const [date, time] = String(value).split(/[T ]/, 2);
      const formattedTime = time ? timeText(time.slice(0, 5)) : "";
      const formattedDate = dateText(date);
      return formattedDate === "N/A"
        ? "N/A"
        : `${formattedDate}${formattedTime ? ` · ${formattedTime}` : ""}`;
    };
    const timeText = (value) => {
      if (typeof value === "function") {
        try {
          value = value(selectedEvent);
        } catch (error) {
          return "N/A";
        }
      }
      if (typeof value !== "string" && typeof value !== "number") return "N/A";
      const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || "").trim());
      if (!match) return "N/A";
      const hour = Number(match[1]);
      return `${String(hour % 12 || 12).padStart(2, "0")}:${match[2]} ${hour >= 12 ? "PM" : "AM"}`;
    };
    const eventTimes = (event) => {
      if (event.startTime || event.endTime)
        return [
          timeText(event.startTime) || "N/A",
          timeText(event.endTime) || "N/A",
        ];
      const parts = String(event.time || "").split(/\s*[-–]\s*/);
      return [
        timeText(parts[0]) || "N/A",
        timeText(parts[1]) || "N/A",
      ];
    };
    const minuteOfDay = (value) => {
      const twelve = /(\d{1,2}):(\d{2})\s*(AM|PM)/i.exec(String(value || ""));
      if (twelve)
        return (
          ((Number(twelve[1]) % 12) +
            (twelve[3].toUpperCase() === "PM" ? 12 : 0)) *
            60 +
          Number(twelve[2])
        );
      const twentyFour = /^(\d{1,2}):(\d{2})$/.exec(String(value || "").trim());
      return twentyFour
        ? Number(twentyFour[1]) * 60 + Number(twentyFour[2])
        : null;
    };
    const hasStartedOrEnded = (event) => {
      const eventStartAt = Number(event.startAt);
      const eventEndAt = Number(event.endAt);
      if (Number.isFinite(eventStartAt) && eventStartAt > 0 && Date.now() >= eventStartAt)
        return true;
      if (Number.isFinite(eventEndAt) && eventEndAt > 0 && Date.now() >= eventEndAt)
        return true;
      const iso = String(event.dateISO || event.date || "").slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
      const now = new Date();
      const dateParts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Manila",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).formatToParts(now);
      const part = (type) => dateParts.find((item) => item.type === type)?.value;
      const today = `${part("year")}-${part("month")}-${part("day")}`;
      if (iso < today) return true;
      if (iso > today) return false;
      const [start, end] = eventTimes(event);
      const timeParts = new Intl.DateTimeFormat("en-GB", {
        timeZone: "Asia/Manila",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }).formatToParts(now);
      const current = Number(timeParts.find((item) => item.type === "hour")?.value) * 60 +
        Number(timeParts.find((item) => item.type === "minute")?.value);
      const startMinutes = minuteOfDay(start);
      const endMinutes = minuteOfDay(end);
      return (
        (startMinutes !== null && current >= startMinutes) ||
        (endMinutes !== null && current >= endMinutes)
      );
    };
    const blockReason = (event, action) => {
      const registrationEnd = event.registrationEnd || event.registrationDeadline;
      const deadlineText = String(registrationEnd || "").trim();
      const deadlineAt = registrationEnd instanceof Date
        ? registrationEnd.getTime()
        : typeof registrationEnd?.toDate === "function"
          ? registrationEnd.toDate().getTime()
          : Number.isFinite(registrationEnd?.seconds)
            ? registrationEnd.seconds * 1000
            : typeof registrationEnd === "number"
              ? registrationEnd
              : deadlineText
                ? Date.parse(
                    /^\d{4}-\d{2}-\d{2}$/.test(deadlineText)
                      ? `${deadlineText}T23:59:59.999+08:00`
                      : /^\d{4}-\d{2}-\d{2}[T ]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(deadlineText)
                        ? `${deadlineText.replace(" ", "T")}+08:00`
                        : deadlineText,
                  )
                : NaN;
      const registrationClosed =
        event.registrationClosed === true ||
        event.registrationEnabled === false ||
        String(event.status || event.publicationStatus || "").trim().toLowerCase() === "closed" ||
        String(event.registrationStatus || "").trim().toLowerCase() === "closed";
      if (
        action === "join" &&
        readIds().has(String(event.id || event.eventId))
      ) return "You are already registered for this event.";
      const status = String(event.status || event.publicationStatus || "").toLowerCase();
      if (
        ["cancelled", "canceled", "completed"].includes(status) ||
        hasStartedOrEnded(event)
      )
        return "This event is no longer open for registration.";
      if (
        action === "join" &&
        (registrationClosed ||
          Number.isFinite(deadlineAt) && Date.now() > deadlineAt)
      )
        return "Registration Closed";
      if (action === "join" && openSlots(event) <= 0) return "Fully Booked";
      return "";
    };
    const registrationState = (event) => {
      if (readIds().has(String(event.id || event.eventId))) return "Registered";
      return blockReason(event, "join") || "Open";
    };
    function attachmentsMarkup(event) {
      const files = entries(
        (Array.isArray(event.attachments) && event.attachments.length
          ? event.attachments
          : null) ||
          event.participantDocuments ||
          event.participantDocs ||
          event.registrationDocuments,
      );
      if (!files.length) return '<p class="student-event-no-documents">No files attached.</p>';
      return files
        .map((file) => {
          const name = text(file);
          const href =
            typeof file === "object"
              ? file.url ||
                file.href ||
                file.downloadUrl ||
                file.fileUrl ||
                file.dataUrl ||
                ""
              : /^(https?:|blob:|data:|\.\.?\/|\/)/i.test(String(file))
                ? file
                : "";
          let isDriveLink = false;
          try {
            const parsedUrl = new URL(String(href));
            isDriveLink = parsedUrl.protocol === "https:" &&
              ["drive.google.com", "docs.google.com"].includes(parsedUrl.hostname.toLowerCase());
          } catch {
            isDriveLink = false;
          }
          const icon =
            '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2.5v10m0 0 3.5-3.5M10 12.5 6.5 9M3.5 13.5v3h13v-3"/></svg>';
          const link = isDriveLink
            ? `<a href="${escapeHTML(href)}" target="_blank" rel="noopener noreferrer" aria-label="Open ${escapeHTML(name)} in Google Drive" title="Open in Google Drive">${icon}</a>`
            : /^(https?:|blob:|data:|\.\.?\/|\/)/i.test(String(href))
            ? `<a href="${escapeHTML(href)}" download="${escapeHTML(name)}" aria-label="Download ${escapeHTML(name)}" title="Download ${escapeHTML(name)}">${icon}</a>`
            : typeof file === "object" && (file.fileId || file.id)
              ? `<a href="#" data-event-file-id="${escapeHTML(file.fileId || file.id)}" download="${escapeHTML(name)}" aria-label="Download ${escapeHTML(name)}" title="Download ${escapeHTML(name)}">${icon}</a>`
              : `<span title="Download link unavailable" aria-label="Download unavailable">${icon}</span>`;
          return `<div class="student-event-attachment"><span>${escapeHTML(name)}</span>${link}</div>`;
        })
        .join("");
    }

    detailOverlay.addEventListener("click", async (event) => {
      const link = event.target.closest("[data-event-file-id]");
      if (!link) return;
      event.preventDefault();
      link.setAttribute("aria-busy", "true");
      try {
        const database = await new Promise((resolve, reject) => {
          const request = indexedDB.open("RecoVibeEventDocuments", 1);
          request.onupgradeneeded = () => {
            if (!request.result.objectStoreNames.contains("files"))
              request.result.createObjectStore("files", { keyPath: "id" });
          };
          request.onsuccess = () => resolve(request.result);
          request.onerror = () =>
            reject(
              request.error || new Error("Document storage is unavailable."),
            );
        });
        const stored = await new Promise((resolve, reject) => {
          const request = database
            .transaction("files")
            .objectStore("files")
            .get(link.dataset.eventFileId);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () =>
            reject(
              request.error || new Error("Could not read the attached file."),
            );
        });
        if (!stored) throw new Error("This file is no longer available.");
        const url = URL.createObjectURL(stored.blob);
        const download = document.createElement("a");
        download.href = url;
        download.download = stored.name || link.download;
        download.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 30000);
      } catch (error) {
        window.alert(`Unable to download ${link.download}: ${error.message}`);
      } finally {
        link.removeAttribute("aria-busy");
      }
    });

    function renderEvent(event) {
      const showFacultyInCharge = /\/User(?:EventOrganizer|Admin)\//i.test(location.pathname);
      const categories = entries(
        event.categories || event.category || event.tag,
      );
      const times = eventTimes(event);
      const total = event.maxCapacity ?? capacity(event);
      const savedCapacityValues = [
        event.maxCapacity,
        event.maxSlots,
        event.capacity,
        event.slots,
      ];
      const capacityKnown =
        total != null &&
        savedCapacityValues.some(
          (value) =>
            value != null &&
            String(value).trim() !== "" &&
            Number.isFinite(Number(value)) &&
            Number(value) >= 0,
        );
      const noCapacityLimit = total == null && event.capacityMode === "N/A";
      const available = openSlots(event);
      let availabilityValue = available;
      if (typeof availabilityValue === "function") {
        try {
          availabilityValue = availabilityValue(event);
        } catch (error) {
          availabilityValue = null;
        }
      }
      const availableNumber = typeof availabilityValue === "number"
        ? availabilityValue
        : typeof availabilityValue === "string" && availabilityValue.trim()
          ? Number(availabilityValue)
          : NaN;
      const totalNumber = Number(total);
      const displayedSlots = Number.isFinite(availableNumber)
        ? Math.max(0, Math.floor(availableNumber))
        : null;
      const availabilityText = noCapacityLimit || availableNumber === Infinity
        ? "Unlimited"
        : !capacityKnown || displayedSlots === null || !Number.isFinite(totalNumber)
          ? "Not specified"
          : `${displayedSlots} of ${Math.max(0, Math.floor(totalNumber))} slots left`;
      const participants =
        event.expectedParticipants ??
        event.registeredCount ??
        (!capacityKnown ? "N/A" : Math.max(0, total - available));
      const slotsLeft = displayedSlots;
      const dateStart = event.dateStart || event.dateISO || event.date;
      const dateEnd =
        event.dateEnd || event.endDate || event.eventEndDate || dateStart;
      const bannerUrl =
        typeof event.bannerImage === "string" &&
        /^data:image\/(?:png|jpeg|webp);base64,/i.test(event.bannerImage)
          ? event.bannerImage
          : safeHttpUrl(event.bannerImage || event.bannerUrl);
      const dailySchedules = Array.isArray(event.dailySchedules)
        ? event.dailySchedules
        : [];
      const differentTimesByDay =
        dailySchedules.length > 0 &&
        (/different\s+time/i.test(String(event.dailySchedule || "")) ||
          dailySchedules.length > 1);
      const venue =
        event.venue ||
        event.location ||
        event.venueOther ||
        event.venueName ||
        "N/A";
      const venueType =
        event.venueType || event.weatherContingency || "N/A";
      const source = [
        event.source || event.eventSource || event.campus || event.office,
        event.sourceOther,
      ]
        .filter((value) => value != null && value !== "")
        .map((value) => displayText(value, "", event))
        .filter(Boolean)
        .join(" · ") || "N/A";
      const targetAudienceValue =
        event.targetAudience || event.targetYear || "Open to All";
      const targetAudience = entries(targetAudienceValue)
        .map(text)
        .filter(Boolean)
        .join(", ") || "Open to All";
      const attendanceRequired =
        typeof event.attendanceRequired === "boolean"
          ? event.attendanceRequired
            ? "Required"
            : "Not Required"
          : displayText(event.attendanceRequired, "N/A", event);
      const description = displayText(
        event.description || event.desc || event.about || "N/A",
        "N/A",
        event,
      )
        .split(/\n\s*\n/)
        .map((item) => item.trim())
        .filter(Boolean);
      const contactPerson = typeof event.contactPerson === "function"
        ? displayText(event.contactPerson, "", event)
        : event.contactPerson;
      const contactInfo =
        contactPerson && typeof contactPerson === "object"
          ? contactPerson
          : {};
      const contactParts = (typeof contactPerson === "string"
        ? contactPerson
        : displayText(event.contactName, "", event))
        .split(/[\n,|]+/)
        .map((item) => item.trim())
        .filter(Boolean);
      const email =
        contactInfo.email ||
        displayText(event.contactEmail, "", event) ||
        contactParts.find((item) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(item)) ||
        "";
      const phone =
        contactInfo.phone ||
        displayText(event.contactPhone, "", event) ||
        contactParts.find(
          (item) => /\+?[\d() -]{7,}/.test(item) && /\d{7}/.test(item),
        ) ||
        "";
      const person =
        contactInfo.name ||
        displayText(event.contactName, "", event) ||
        contactParts.find((item) => item !== email && item !== phone) ||
        event.organizerName ||
        "N/A";
      const role =
        contactInfo.role ||
        displayText(event.contactRole, "", event) ||
        contactParts.find(
          (item) => item !== person && item !== email && item !== phone,
        ) ||
        "";
      const facultyInChargeValue =
        event.facultyInCharge || event.faculty_in_charge || "";
      const facultyInChargeName = typeof facultyInChargeValue === "object"
        ? facultyInChargeValue.name ||
          displayText(event.facultyInChargeName, "", event) ||
          facultyInChargeValue.id ||
          ""
        : facultyInChargeValue ||
          event.facultyInChargeName ||
          displayText(event.facultyInChargeId, "", event) ||
          "";
      const badgeList = categories.length ? categories : ["General"];
      const objectives =
        event.objectives || event.keyDetails || event.detailedInfo || event.focusAreas;
      const rules = [
        ...entries(event.participationRules || event.rules),
        ...entries(event.reminders),
        ...(event.requirements && typeof event.requirements === "object" && !Array.isArray(event.requirements)
          ? [
              ...entries(event.requirements.required),
              ...entries(event.requirements.recommended),
            ]
          : entries(event.requirements)),
      ];
      const infoCard = (label, value, className = "") =>
        `<div class="student-event-info-card${className ? ` ${className}` : ""}"><strong>${escapeHTML(label)}</strong><span>${escapeHTML(displayText(value, "N/A", event))}</span></div>`;
      const scheduleRows = dailySchedules
        .map((schedule, index) => {
          const scheduleDate = schedule.date || schedule.dateISO || "";
          const scheduleLabel =
            schedule.label ||
            (index === 0
              ? "First Day"
              : index === dailySchedules.length - 1
                ? "Last Day"
                : `Day ${index + 1}`);
          return `<div class="student-event-daily-row"><strong>${escapeHTML(displayText(scheduleLabel, "N/A", event))}</strong><span>${escapeHTML(dateText(scheduleDate))}</span><strong>Time Start</strong><span>${escapeHTML(timeText(schedule.timeStart) || "N/A")}</span><strong>Time End</strong><span>${escapeHTML(timeText(schedule.timeEnd) || "N/A")}</span></div>`;
        })
        .join("");
      detailHeader.innerHTML = `
        <div class="student-event-heading">
          <h2 class="student-event-title" id="studentEventTitle">${escapeHTML(displayText(event.title || event.eventName || "Untitled event", "Untitled event", event))}</h2>
          <p><strong>Event Organizer:</strong> ${escapeHTML(displayText(event.organizerName || event.organizer || event.organization || "N/A", "N/A", event))}</p>
          <p><strong>Event Source:</strong> ${escapeHTML(source)}</p>
        </div>
        <div class="student-event-header-meta">
          <div><strong>Categories:</strong><div class="student-event-categories" title="${escapeHTML(badgeList.map(text).join(", "))}">${badgeList.map((category) => `<span class="student-event-pill student-event-pill--${categoryTone(text(category))}" title="${escapeHTML(text(category))}">${escapeHTML(text(category))}</span>`).join("")}</div></div>
          <p><strong>Target Audience:</strong> ${escapeHTML(targetAudience)}</p>
          <p><strong>Attendance:</strong> ${escapeHTML(displayText(attendanceRequired, "N/A", event))}</p>
        </div>`;
      detailContent.innerHTML = `
        <section class="student-event-info" aria-label="Event schedule and capacity">
          ${infoCard("Date Start", dateText(dateStart))}
          ${infoCard("Date End", dateText(dateEnd))}
          ${infoCard("Time Start", differentTimesByDay ? "N/A" : times[0])}
          ${infoCard("Time End", differentTimesByDay ? "N/A" : times[1])}
          ${infoCard("Venue", [displayText(venue, "", event), displayText(event.room || event.roomNumber, "", event)].filter(Boolean).join(" · "))}
          ${infoCard("Venue Type", venueType)}
          ${infoCard("Max Capacity", noCapacityLimit ? "No limit" : capacityKnown && Number.isFinite(totalNumber) ? `${Math.max(0, Math.floor(totalNumber))} People` : "Not specified")}
          ${infoCard("Expected Participants", participants)}
          ${infoCard("Slots Left", noCapacityLimit ? "Unlimited" : capacityKnown && slotsLeft !== null && Number.isFinite(totalNumber) ? `${slotsLeft} of ${Math.max(0, Math.floor(totalNumber))}` : "Not specified")}
        </section>
        <section class="student-event-section student-event-registration">
          <h3>Registration Information</h3>
          <div class="student-event-registration-grid">
            <p><strong>Registration Start:</strong> ${escapeHTML(dateTimeText(event.registrationStart))}</p>
            <p><strong>Registration End:</strong> ${escapeHTML(dateTimeText(event.registrationEnd || event.registrationDeadline))}</p>
            <p><strong>Status:</strong> ${escapeHTML(registrationState(event))}</p>
            <p><strong>Availability:</strong> ${escapeHTML(availabilityText)}</p>
            ${safeHttpUrl(event.platformLink) ? `<p><strong>Platform:</strong> <a href="${escapeHTML(safeHttpUrl(event.platformLink))}" target="_blank" rel="noopener noreferrer">Join event online</a></p>` : ""}
            ${differentTimesByDay ? `<div class="student-event-daily-schedule"><h3>Different Time Per Day</h3><div>${scheduleRows}</div></div>` : ""}
          </div>
        </section>
        <section class="student-event-section student-event-description"><h3>Event Description</h3>${bannerUrl ? `<img class="event-details-banner student-event-banner" src="${escapeHTML(bannerUrl)}" alt="${escapeHTML(displayText(event.bannerFileName || event.title || "Event banner", "Event banner", event))}">` : ""}${description.map((paragraph) => `<p>${escapeHTML(paragraph)}</p>`).join("")}</section>
        <section class="student-event-section"><h3>Rationale</h3><p>${escapeHTML(displayText(event.rationale || "N/A", "N/A", event))}</p></section>
        <section class="student-event-section"><h3>Objectives</h3>${bullets(objectives)}</section>
        <section class="student-event-section"><h3>Rules &amp; Reminders</h3>${bullets(rules)}</section>
        <div class="student-event-bottom-grid">
          <section class="student-event-section student-event-contact"><h3>Contact Person</h3><p><strong>Name:</strong> ${escapeHTML(displayText(person || "N/A", "N/A", event))}</p><p><strong>Role:</strong> ${escapeHTML(displayText(role || "N/A", "N/A", event))}</p><p><strong>Email:</strong> ${email ? `<a href="mailto:${escapeHTML(displayText(email, "N/A", event))}">${escapeHTML(displayText(email, "N/A", event))}</a>` : "N/A"}</p><p><strong>Number:</strong> ${escapeHTML(displayText(phone || "N/A", "N/A", event))}</p><p><strong>Faculty In Charge:</strong> ${escapeHTML(displayText(showFacultyInCharge ? facultyInChargeName || "N/A" : "N/A", "N/A", event))}</p></section>
          <section class="student-event-section student-event-documents"><h3>Participant Documents</h3><p>Open the Google Drive links to download the required files.</p><div class="student-event-attachments">${attachmentsMarkup(event)}</div><small>(Make sure to download and fill up these files. Its needed for participation)</small></section>
        </div>`;
    }

    function updateAction() {
      const registered = readIds().has(
        String(selectedEvent && (selectedEvent.id || selectedEvent.eventId)),
      );
      selectedAction = registered ? "cancel" : "join";
      const reason = blockReason(selectedEvent, selectedAction);
      const state = registrationState(selectedEvent);
      actionButton.textContent = pending
        ? "Processing..."
        : registered
          ? "Cancel Participation"
          : reason || "Register";
      actionButton.classList.toggle("is-cancel", registered);
      actionButton.disabled = pending || Boolean(reason);
      actionButton.title = reason;
      actionButton.setAttribute(
        "aria-label",
        reason
          ? `${actionButton.textContent}. ${reason}`
          : actionButton.textContent,
      );
      noticeElement.textContent = state;
    }

    function closeConfirmation(restore = true) {
      confirmOverlay.classList.remove("is-open");
      confirmOverlay.setAttribute("aria-hidden", "true");
      errorElement.textContent = "";
      if (restore && detailOverlay.classList.contains("is-open"))
        actionButton.focus();
    }

    function closeDetails() {
      closeConfirmation(false);
      detailOverlay.classList.remove("is-open");
      detailOverlay.setAttribute("aria-hidden", "true");
      document.body.style.overflow = bodyOverflow;
      if (previousFocus && typeof previousFocus.focus === "function")
        previousFocus.focus();
      selectedEvent = null;
      dashboardRegistrationConfirmation = false;
    }

    function openConfirmation() {
      if (!selectedEvent || pending) return;
      updateAction();
      if (actionButton.disabled) return;
      selectedAction = readIds().has(
        String(selectedEvent.id || selectedEvent.eventId),
      )
        ? "cancel"
        : "join";
      titleElement.textContent =
        selectedAction === "join" ? "Join Event?" : "Cancel Participation?";
      messageElement.textContent =
        selectedAction === "join"
          ? `Are you sure you want to join the ${selectedEvent.title}? By confirming, you will be registered as a participant for this event.`
          : `Are you sure you want to cancel your participation in the ${selectedEvent.title}? Your slot may be made available to another student.`;
      primaryButton.textContent =
        selectedAction === "join" ? "Participate" : "Yes";
      cancelButton.textContent = selectedAction === "join" ? "Cancel" : "No";
      errorElement.textContent = "";
      confirmOverlay.setAttribute("aria-hidden", "false");
      confirmOverlay.classList.add("is-open");
      primaryButton.focus();
    }

    async function confirmAction() {
      if (!selectedEvent || pending) return;
      const action = selectedAction;
      pending = true;
      primaryButton.disabled = true;
      cancelButton.disabled = true;
      primaryButton.textContent = "Saving...";
      updateAction();
      try {
        await new Promise((resolve) => window.setTimeout(resolve, 0));
        const id = String(selectedEvent.id || selectedEvent.eventId);
        const registrations = readIds();
        const savedSlots = readObject(slotsKey);
        const previousSlots = { ...savedSlots };
        const available = openSlots(selectedEvent);
        const limit = capacity(selectedEvent);
        if (action === "join") {
          if (registrations.has(id))
            throw new Error("You are already registered for this event.");
          const blocked = blockReason(selectedEvent, "join");
          if (blocked) throw new Error(blocked);
          if (selectedEvent.capacityMode !== "N/A" && available <= 0)
            throw new Error("No slots are available for this event.");
          if (typeof window.recovibeRegisterForEvent === "function") {
            if ((await window.recovibeRegisterForEvent(id)) === false) {
              throw new Error("The registration could not be completed.");
            }
          }
          registrations.add(id);
          if (selectedEvent.capacityMode !== "N/A")
            savedSlots[id] = available - 1;
          else delete savedSlots[id];
        } else {
          if (!registrations.has(id))
            throw new Error("You are not registered for this event.");
          if (typeof window.recovibeCancelRegistration === "function") {
            if ((await window.recovibeCancelRegistration(id)) === false) {
              throw new Error("The registration could not be cancelled.");
            }
          }
          registrations.delete(id);
          if (limit !== null) savedSlots[id] = Math.min(limit, available + 1);
          else delete savedSlots[id];
        }
        localStorage.setItem(slotsKey, JSON.stringify(savedSlots));
        try {
          localStorage.setItem(
            participationKey,
            JSON.stringify([...registrations]),
          );
        } catch (error) {
          localStorage.setItem(slotsKey, JSON.stringify(previousSlots));
          throw error;
        }
        selectedEvent.slotsOpen =
          selectedEvent.capacityMode === "N/A" ? undefined : savedSlots[id];
        if (selectedEvent.capacityMode !== "N/A") {
          selectedEvent.slotsLeft = savedSlots[id];
          selectedEvent.availableSlots = savedSlots[id];
          selectedEvent.registeredCount = Math.max(
            0,
            Number(selectedEvent.registeredCount || 0) +
              (action === "join" ? 1 : -1),
          );
        }
        closeConfirmation(false);
        renderEvent(selectedEvent);
        updateAction();
        const successMessage = action === "cancel"
          ? `Cancelled registration to ${selectedEvent.title}.`
          : `You registered for ${selectedEvent.title}.`;
        const toast = document.getElementById("toast");
        if (toast) {
          toast.textContent = successMessage;
          toast.classList.add("is-visible");
          window.clearTimeout(toast._studentEventTimer);
          toast._studentEventTimer = window.setTimeout(
            () => toast.classList.remove("is-visible"),
            4000,
          );
        }
        document.dispatchEvent(
          new CustomEvent("recovibeParticipationChanged", {
            detail: { eventId: id, action, slotsOpen: savedSlots[id] },
          }),
        );
      } catch (error) {
        const message = String(error?.message || "");
        if (action === "cancel") {
          errorElement.textContent = "Could not cancel your registration. Please try again.";
        } else if (/already registered/i.test(message)) {
          errorElement.textContent = "You are already registered for this event.";
        } else if (/registration closed|deadline|registration is closed/i.test(message)) {
          errorElement.textContent = "Registration Closed";
        } else if (/fully booked|event is full|no slots/i.test(message)) {
          errorElement.textContent = "Fully Booked";
        } else if (/no longer open|started or ended|event has ended/i.test(message)) {
          errorElement.textContent = "This event is no longer open for registration.";
        } else {
          errorElement.textContent = "Could Not Register for this Event. Please try again.";
        }
      } finally {
        pending = false;
        primaryButton.disabled = false;
        cancelButton.disabled = false;
        primaryButton.textContent =
          selectedAction === "join" ? "Participate" : "Yes";
        updateAction();
      }
    }

    detailOverlay
      .querySelector(".student-event-close")
      .addEventListener("click", closeDetails);
    detailOverlay.addEventListener("click", (event) => {
      if (event.target === detailOverlay) closeDetails();
    });
    confirmOverlay.addEventListener("click", (event) => {
      if (event.target === confirmOverlay && !pending) closeConfirmation();
    });
    actionButton.addEventListener("click", openConfirmation);
    primaryButton.addEventListener("click", confirmAction);
    cancelButton.addEventListener("click", () => {
      if (!pending) closeConfirmation();
    });
    document.addEventListener("keydown", (event) => {
      if (!detailOverlay.classList.contains("is-open")) return;
      if (event.key === "Escape") {
        if (confirmOverlay.classList.contains("is-open")) closeConfirmation();
        else closeDetails();
        return;
      }
      if (event.key !== "Tab") return;
      const top = confirmOverlay.classList.contains("is-open")
        ? confirmDialog
        : detailDialog;
      const focusable = [
        ...top.querySelectorAll(
          'button:not(:disabled),a[href],[tabindex]:not([tabindex="-1"])',
        ),
      ].filter((element) => element.getClientRects().length);
      if (!focusable.length) {
        event.preventDefault();
        top.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (
        event.shiftKey &&
        (document.activeElement === first ||
          !top.contains(document.activeElement))
      ) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last ||
          !top.contains(document.activeElement))
      ) {
        event.preventDefault();
        first.focus();
      }
    });
    window.addEventListener("storage", (event) => {
      if (!selectedEvent || ![participationKey, slotsKey].includes(event.key))
        return;
      selectedEvent.slotsOpen = openSlots(selectedEvent);
      renderEvent(selectedEvent);
      updateAction();
    });

    return {
      open(event, options = {}) {
        if (!event || isHoliday(event)) return;
        selectedEvent = event;
        dashboardRegistrationConfirmation =
          options.dashboardRegistrationConfirmation === true;
        previousFocus = document.activeElement;
        bodyOverflow = document.body.style.overflow;
        renderEvent(event);
        updateAction();
        document.body.style.overflow = "hidden";
        detailOverlay.setAttribute("aria-hidden", "false");
        detailOverlay.classList.add("is-open");
        detailDialog.focus();
        if (dashboardRegistrationConfirmation) openConfirmation();
      },
      close: closeDetails,
    };
  }

  window.RecovibeStudentEventDetails = createStudentRegistrationModal();
})();
