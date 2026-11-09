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

  const dateText = (event) => {
    const value = event.dateISO || event.date;
    if (!value) return "";
    const format = (dateValue) => {
      const date =
        dateValue instanceof Date
          ? dateValue
          : new Date(`${String(dateValue).slice(0, 10)}T00:00:00`);
      return Number.isNaN(date.getTime())
        ? String(dateValue)
        : date.toLocaleDateString("en-US", {
          month: "long",
          day: "numeric",
          year: "numeric",
        });
    };
    const start = format(value);
    const endValue = event.eventEndDate || event.endDate;
    return endValue && String(endValue).slice(0, 10) !== String(value).slice(0, 10)
      ? `${start} – ${format(endValue)}`
      : start;
  };

  const safeHttpUrl = (value) => {
    try {
      const url = new URL(String(value));
      return ["http:", "https:"].includes(url.protocol) ? url.href : "";
    } catch {
      return "";
    }
  };

  const listMarkup = (items) =>
    items.length
      ? `<ul>${items.map((item) => `<li>${escapeHTML(typeof item === "object" ? item.name || item.title || "" : item)}</li>`).join("")}</ul>`
      : "";

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
        const label = `<span>${escapeHTML(name)}</span><b aria-hidden="true">&#8595;</b>`;
        if (!href || !/^(https?:|blob:|\.\.?\/|\/)/i.test(href)) {
          return `<div class="event-details-document">${label}</div>`;
        }
        return `<a class="event-details-document" href="${escapeHTML(href)}" download>${label}</a>`;
      })
      .join("");

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

  function section(title, content) {
    return content
      ? `<section class="event-details-section"><h3>${title}</h3>${content}</section>`
      : "";
  }

  function createModal() {
    const overlay = document.createElement("div");
    overlay.className = "event-details-overlay";
    overlay.setAttribute("aria-hidden", "true");
    overlay.innerHTML = `
      <article class="event-details-dialog" role="dialog" aria-modal="true" aria-labelledby="sharedEventDetailsTitle" tabindex="-1">
        <header class="event-details-header">
          <button class="event-details-close" type="button" aria-label="Close event details">&times;</button>
          <p class="event-details-source" data-field="source"></p>
          <h2 id="sharedEventDetailsTitle" data-field="title"></h2>
          <div class="event-details-meta" data-field="meta"></div>
        </header>
        <div class="event-details-content">
          <div class="event-details-grid">
            <div class="event-details-column" data-column="left"></div>
            <div class="event-details-column" data-column="right"></div>
          </div>
        </div>
        <footer class="event-details-footer" hidden><button type="button" class="event-details-action"></button></footer>
      </article>`;
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
    const source =
      event.source ||
      event.organizerName ||
      event.organizer ||
      event.organization ||
      "";
    const date = dateText(event);
    const time =
      event.time ||
      [event.startTime, event.endTime].filter(Boolean).join(" - ");
    const location = [
      ...new Set([event.location, event.room || event.venue].filter(Boolean)),
    ].join(" · ");
    const description = event.description || event.desc || event.about || "";
    const requirements = getRequirements(event);
    const rules = asList(
      event.participationRules || event.rules || event.reminders,
    );
    const focusAreas = asList(
      event.focusAreas || event.detailedInfo || event.tags,
    );
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
    const capacity = event.capacity ?? event.maxSlots ?? event.slots;
    const openSlots = event.slotsOpen ?? event.availableSlots;
    const contactName =
      event.contactName || event.organizerName || event.contactPerson || "";
    const contactEmail = event.contactEmail || event.email || "";
    const contactPhone = event.contactPhone || event.phone || "";
    const bannerUrl =
      typeof event.bannerImage === "string" &&
      /^data:image\/(?:png|jpeg|webp);base64,/i.test(event.bannerImage)
        ? event.bannerImage
        : safeHttpUrl(event.bannerImage || event.bannerUrl);
    const left = [
      section(
        "Event Banner",
        bannerUrl
          ? `<img class="event-details-banner" src="${escapeHTML(bannerUrl)}" alt="${escapeHTML(event.bannerFileName || event.title || "Event banner")}">`
          : "",
      ),
      section(
        "About the Event",
        description ? `<p>${escapeHTML(description)}</p>` : "",
      ),
      section("Requirements", listMarkup(requirements)),
      section("Participation Rules", listMarkup(rules)),
      section(
        "Participant Documents",
        participantDocuments.length
          ? `<div class="event-details-documents">${documentMarkup(participantDocuments)}</div>`
          : "",
      ),
    ].join("");
    const right = [
      section(
        "Detailed Event Information",
        [
          event.category || event.tag
            ? `<p><strong>Event Category:</strong> ${escapeHTML(event.category || event.tag)}</p>`
            : "",
          capacity != null
            ? `<p><strong>Event Capacity:</strong> ${escapeHTML(capacity)}${typeof capacity === "number" ? " participants" : ""}</p>`
            : "",
          event.status
            ? `<p><strong>Status:</strong> ${escapeHTML(event.status)}</p>`
            : "",
        ].join(""),
      ),
      section(
        "Registration Details",
        [
          event.registrationDeadline
            ? `<p><strong>Registration Deadline:</strong> ${escapeHTML(event.registrationDeadline)}</p>`
            : "",
          event.registrationInfo || event.registrationStatus
            ? `<p><strong>Registration:</strong> ${escapeHTML(event.registrationInfo || event.registrationStatus)}</p>`
            : "",
          safeHttpUrl(event.platformLink)
            ? `<p><strong>Platform:</strong> <a href="${escapeHTML(safeHttpUrl(event.platformLink))}" target="_blank" rel="noopener noreferrer">Join event online</a></p>`
            : "",
          openSlots != null
            ? `<p><strong>Availability:</strong> ${escapeHTML(openSlots)}${capacity != null ? ` of ${escapeHTML(capacity)}` : ""} slots open</p>`
            : "",
        ].join(""),
      ),
      section("Focus Areas", listMarkup(focusAreas)),
      section(
        "Contact Person",
        [
          contactName
            ? `<p><strong>${escapeHTML(contactName)}</strong></p>`
            : "",
          contactEmail ? `<p>${escapeHTML(contactEmail)}</p>` : "",
          contactPhone ? `<p>${escapeHTML(contactPhone)}</p>` : "",
        ].join(""),
      ),
      section(
        "Approval Documents",
        approvalDocuments.length
          ? `<div class="event-details-documents">${documentMarkup(approvalDocuments)}</div>`
          : "",
      ),
    ].join("");

    const modal = getOverlay();
    modal.querySelector('[data-field="source"]').textContent = source
      ? `Event Source: ${source}`
      : "";
    modal.querySelector('[data-field="title"]').textContent =
      event.title || "Untitled event";
    modal.querySelector('[data-field="meta"]').innerHTML = [
      date,
      time,
      location,
    ]
      .filter(Boolean)
      .map((value) => `<span>${escapeHTML(value)}</span>`)
      .join("");
    modal.querySelector('[data-column="left"]').innerHTML =
      left ||
      '<p class="event-details-empty">No additional details are available.</p>';
    modal.querySelector('[data-column="right"]').innerHTML = right;

    const footer = modal.querySelector(".event-details-footer");
    const action = modal.querySelector(".event-details-action");
    footer.hidden = typeof options.onAction !== "function";
    action.textContent = options.actionLabel || "Continue";
    action.disabled = Boolean(options.actionDisabled);
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
        <button class="student-event-close" type="button" aria-label="Close event details">&times;</button>
        <div class="student-event-content"></div>
        <footer class="student-event-footer"><p class="student-event-notice" role="status"></p><button class="student-event-action" type="button"></button></footer>
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
    const detailContent = detailOverlay.querySelector(".student-event-content");
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
            Number(event.maxSlots ?? event.capacity ?? event.slots ?? 0) || 0,
          );
    const openSlots = (event) => {
      if (event.capacityMode === "N/A") return Infinity;
      const stored = readObject(slotsKey)[String(event.id || event.eventId)];
      return Math.max(
        0,
        Number(
          stored !== undefined
            ? stored
            : (event.slotsOpen ??
                event.availableSlots ??
                event.slots ??
                capacity(event)),
        ) || 0,
      );
    };
    const text = (item) =>
      typeof item === "object"
        ? item.name ||
          item.title ||
          item.label ||
          item.filename ||
          item.fileName ||
          ""
        : item;
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
      return items.length
        ? `<ul class="student-event-list">${items.map((item) => `<li>${escapeHTML(item)}</li>`).join("")}</ul>`
        : "<p>Not specified</p>";
    };
    const dateText = (value) => {
      if (!value) return "Not specified";
      const date = new Date(`${String(value).slice(0, 10)}T00:00:00`);
      return Number.isNaN(date.getTime())
        ? String(value)
        : `${String(date.getMonth() + 1).padStart(2, "0")} / ${String(date.getDate()).padStart(2, "0")} / ${date.getFullYear()}`;
    };
    const dateTimeText = (value) => {
      if (!value) return "Not specified";
      const [date, time] = String(value).split(/[T ]/, 2);
      const formattedTime = time ? timeText(time.slice(0, 5)) : "";
      return `${dateText(date)}${formattedTime ? ` · ${formattedTime}` : ""}`;
    };
    const timeText = (value) => {
      const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || "").trim());
      if (!match) return String(value || "").trim();
      const hour = Number(match[1]);
      return `${String(hour % 12 || 12).padStart(2, "0")}:${match[2]} ${hour >= 12 ? "PM" : "AM"}`;
    };
    const eventTimes = (event) => {
      if (event.startTime || event.endTime)
        return [
          timeText(event.startTime) || "Not specified",
          timeText(event.endTime) || "Not specified",
        ];
      const parts = String(event.time || "").split(/\s*[-–]\s*/);
      return [parts[0] || "Not specified", parts[1] || "Not specified"];
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
      const iso = String(event.dateISO || event.date || "").slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
      const now = new Date();
      const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
      if (iso < today) return true;
      if (iso > today) return false;
      const [start, end] = eventTimes(event);
      const current = now.getHours() * 60 + now.getMinutes();
      const startMinutes = minuteOfDay(start);
      const endMinutes = minuteOfDay(end);
      return (
        (startMinutes !== null && current >= startMinutes) ||
        (endMinutes !== null && current >= endMinutes)
      );
    };
    const blockReason = (event, action) => {
      const deadline = event.registrationDeadline
        ? new Date(String(event.registrationDeadline).replace(/[—–]/g, " "))
        : null;
      if (
        deadline &&
        !Number.isNaN(deadline.getTime()) &&
        Date.now() > deadline.getTime()
      )
        return "The registration deadline has passed.";
      if (
        action === "join" &&
        event.capacityMode !== "N/A" &&
        openSlots(event) <= 0
      )
        return "This event is full.";
      if (hasStartedOrEnded(event))
        return "This event has already started or ended.";
      return "";
    };
    const categoryTone = (value) => {
      const category = String(value || "").toLowerCase();
      if (/social|arts|culture/.test(category)) return "purple";
      if (/university|campus|community/.test(category)) return "green";
      if (/academic|tech|innovation/.test(category)) return "blue";
      if (/sport|fitness/.test(category)) return "orange";
      return "maroon";
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
      if (!files.length) return "<p>No files attached.</p>";
      return `<div class="student-event-attachments">${files
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
        .join("")}</div>`;
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
      const categories = entries(
        event.categories || event.category || event.tag,
      );
      const times = eventTimes(event);
      const total = event.maxCapacity ?? capacity(event);
      const available = openSlots(event);
      const participants = Number(
        event.expectedParticipants ??
          event.registeredCount ??
          (total === null ? 0 : Math.max(0, total - available)),
      );
      const slotsLeft = total === null
        ? null
        : Math.max(
            0,
            Number(
              event.slotsLeft ??
                event.availableSlots ??
                event.slotsOpen ??
                total - Number(event.registeredCount || 0),
            ) || 0,
          );
      const dateStart = event.dateStart || event.dateISO || event.date;
      const dateEnd =
        event.dateEnd || event.endDate || event.eventEndDate || dateStart;
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
        "Not specified";
      const venueType =
        event.venueType || event.weatherContingency || "Not specified";
      const source = [
        event.source || event.eventSource || event.campus || event.office,
        event.sourceOther,
      ]
        .filter(Boolean)
        .join(" · ") || "Not specified";
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
          : event.attendanceRequired || "Not specified";
      const description = String(
        event.description || event.desc || event.about || "Not specified",
      )
        .split(/\n\s*\n/)
        .map((item) => item.trim())
        .filter(Boolean);
      const contactInfo =
        event.contactPerson && typeof event.contactPerson === "object"
          ? event.contactPerson
          : {};
      const contactParts = (typeof event.contactPerson === "string"
        ? event.contactPerson
        : event.contactName || "")
        .split(/[\n,|]+/)
        .map((item) => item.trim())
        .filter(Boolean);
      const email =
        contactInfo.email ||
        event.contactEmail ||
        contactParts.find((item) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(item)) ||
        "";
      const phone =
        contactInfo.phone ||
        event.contactPhone ||
        contactParts.find(
          (item) => /\+?[\d() -]{7,}/.test(item) && /\d{7}/.test(item),
        ) ||
        "";
      const person =
        contactInfo.name ||
        event.contactName ||
        contactParts.find((item) => item !== email && item !== phone) ||
        event.organizerName ||
        "Not specified";
      const role =
        contactInfo.role ||
        event.contactRole ||
        contactParts.find(
          (item) => item !== person && item !== email && item !== phone,
        ) ||
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
        `<div class="student-event-info-card${className ? ` ${className}` : ""}"><strong>${escapeHTML(label)}</strong><span>${escapeHTML(value || "Not specified")}</span></div>`;
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
          return `<div class="student-event-daily-row"><strong>${escapeHTML(scheduleLabel)}</strong><span>${escapeHTML(dateText(scheduleDate))}</span><strong>Time Start</strong><span>${escapeHTML(timeText(schedule.timeStart) || "Not specified")}</span><strong>Time End</strong><span>${escapeHTML(timeText(schedule.timeEnd) || "Not specified")}</span></div>`;
        })
        .join("");
      detailContent.innerHTML = `
        <header class="student-event-top">
          <div class="student-event-heading">
            <h2 class="student-event-title" id="studentEventTitle">${escapeHTML(event.title || event.eventName || "Untitled event")}</h2>
            <p><strong>Event Organizer:</strong> ${escapeHTML(event.organizerName || event.organizer || event.organization || "Not specified")}</p>
            <p><strong>Event Source:</strong> ${escapeHTML(source)}</p>
          </div>
          <div class="student-event-header-meta">
            <div><strong>Categories:</strong><div class="student-event-categories">${badgeList.map((category) => `<span class="student-event-pill student-event-pill--${categoryTone(text(category))}">${escapeHTML(text(category))}</span>`).join("")}</div></div>
            <p><strong>Target Audience:</strong> ${escapeHTML(targetAudience)}</p>
            <p><strong>Attendance:</strong> ${escapeHTML(attendanceRequired)}</p>
          </div>
        </header>
        <section class="student-event-info" aria-label="Event schedule and capacity">
          ${infoCard("Date Start", dateText(dateStart))}
          ${infoCard("Date End", dateText(dateEnd))}
          ${differentTimesByDay ? "" : infoCard("Time Start", times[0])}
          ${differentTimesByDay ? "" : infoCard("Time End", times[1])}
          ${infoCard("Venue", [venue, event.room || event.roomNumber].filter(Boolean).join(" · "))}
          ${infoCard("Venue Type", venueType)}
          ${infoCard("Max Capacity", total === null ? "No limit" : `${total} People`)}
          ${infoCard("Expected Participants", String(participants))}
          ${infoCard("Slots Left", total === null ? "Open registration" : `${slotsLeft} of ${total}`)}
        </section>
        ${differentTimesByDay ? `<section class="student-event-daily-schedule"><h3>Different Time Per Day</h3><div>${scheduleRows}</div></section>` : ""}
        <section class="student-event-section student-event-registration">
          <h3>Registration Information</h3>
          <div class="student-event-registration-grid">
            <p><strong>Registration Start:</strong> ${escapeHTML(dateTimeText(event.registrationStart))}</p>
            <p><strong>Registration End:</strong> ${escapeHTML(dateTimeText(event.registrationEnd || event.registrationDeadline))}</p>
            ${event.registrationInfo ? `<p>${escapeHTML(event.registrationInfo)}</p>` : ""}
          </div>
        </section>
        <section class="student-event-section student-event-description"><h3>Event Description</h3>${description.map((paragraph) => `<p>${escapeHTML(paragraph)}</p>`).join("")}</section>
        <section class="student-event-section"><h3>Rationale</h3>${event.rationale ? `<p>${escapeHTML(event.rationale)}</p>` : "<p>Not specified</p>"}</section>
        <section class="student-event-section"><h3>Objectives</h3>${bullets(objectives)}</section>
        <section class="student-event-section"><h3>Rules &amp; Reminders</h3>${bullets(rules)}</section>
        <div class="student-event-bottom-grid">
          <section class="student-event-section student-event-contact"><h3>Contact Person</h3><p><strong>Name:</strong> ${escapeHTML(person)}</p>${role ? `<p><strong>Role:</strong> ${escapeHTML(role)}</p>` : ""}${email ? `<p><strong>Email:</strong> <a href="mailto:${escapeHTML(email)}">${escapeHTML(email)}</a></p>` : ""}${phone ? `<p><strong>Number:</strong> ${escapeHTML(phone)}</p>` : ""}</section>
          <section class="student-event-section student-event-documents"><h3>Participant Documents</h3><p>Open the Google Drive links to download the required files.</p>${attachmentsMarkup(event)}<small>(Make sure to download and fill up these files. Its needed for participation)</small></section>
        </div>`;
    }

    function updateAction() {
      const registered = readIds().has(
        String(selectedEvent && (selectedEvent.id || selectedEvent.eventId)),
      );
      selectedAction = registered ? "cancel" : "join";
      const reason = blockReason(selectedEvent, selectedAction);
      actionButton.textContent = pending
        ? "Processing..."
        : registered
          ? "Cancel Participation"
          : "Register";
      actionButton.classList.toggle("is-cancel", registered);
      actionButton.disabled = pending || Boolean(reason);
      actionButton.title = reason;
      actionButton.setAttribute(
        "aria-label",
        reason
          ? `${actionButton.textContent}. ${reason}`
          : actionButton.textContent,
      );
      noticeElement.textContent = reason;
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
    }

    function openConfirmation() {
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
        closeConfirmation(false);
        renderEvent(selectedEvent);
        updateAction();
        const verb =
          action === "join"
            ? "registered for"
            : "cancelled your participation in";
        const toast = document.getElementById("toast");
        if (toast) {
          toast.textContent = `You ${verb} ${selectedEvent.title}.`;
          toast.classList.add("is-visible");
          window.clearTimeout(toast._studentEventTimer);
          toast._studentEventTimer = window.setTimeout(
            () => toast.classList.remove("is-visible"),
            2600,
          );
        }
        document.dispatchEvent(
          new CustomEvent("recovibeParticipationChanged", {
            detail: { eventId: id, action, slotsOpen: savedSlots[id] },
          }),
        );
      } catch (error) {
        errorElement.textContent = [
          "QuotaExceededError",
          "SecurityError",
        ].includes(error.name)
          ? "Your request could not be saved in this browser. Check storage availability and try again."
          : error.message ||
            "Your request could not be saved. Please try again.";
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
      open(event) {
        if (!event || isHoliday(event)) return;
        selectedEvent = event;
        previousFocus = document.activeElement;
        bodyOverflow = document.body.style.overflow;
        renderEvent(event);
        updateAction();
        document.body.style.overflow = "hidden";
        detailOverlay.setAttribute("aria-hidden", "false");
        detailOverlay.classList.add("is-open");
        detailDialog.focus();
      },
      close: closeDetails,
    };
  }

  window.RecovibeStudentEventDetails = createStudentRegistrationModal();
})();
