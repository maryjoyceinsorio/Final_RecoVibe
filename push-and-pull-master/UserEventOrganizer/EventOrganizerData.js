const organizerEventStorageKey = "recovibeOrganizerEvents";

window.enhanceDropdownSelects =
  window.enhanceDropdownSelects ||
  function (selector) {
    const selects = [...document.querySelectorAll(selector)].filter(
      (select) => !select.dataset.dropdownEnhanced,
    );
    const wrappers = [];

    function closeMenus(except) {
      wrappers.forEach(({ wrapper, button, menu }) => {
        if (wrapper === except) return;
        menu.classList.remove("show");
        button.setAttribute("aria-expanded", "false");
      });
    }

    selects.forEach((select) => {
      const wrapper = document.createElement("div");
      const button = document.createElement("button");
      const menu = document.createElement("div");
      const menuId = `${select.id || "dropdown"}Menu`;
      const originalStyle = getComputedStyle(select);
      wrapper.className =
        `filter-dropdown native-filter-dropdown ${select.classList.contains("cal-select") ? "cal-filter-dropdown" : ""} ${select.classList.contains("cal-year-select") ? "year-filter-dropdown" : ""}`.trim();
      button.className = "filter-button";
      button.type = "button";
      button.id = `${menuId}Button`;
      button.setAttribute("aria-haspopup", "listbox");
      button.setAttribute("aria-expanded", "false");
      button.setAttribute(
        "aria-label",
        select.getAttribute("aria-label") ||
          select.labels?.[0]?.textContent.trim() ||
          "Choose an option",
      );
      button.setAttribute("aria-controls", menuId);
      const associatedLabel = select.labels?.[0];
      if (associatedLabel) {
        if (!associatedLabel.id) associatedLabel.id = `${menuId}Label`;
        button.setAttribute("aria-labelledby", associatedLabel.id);
      }
      button.style.minWidth = originalStyle.minWidth;
      menu.className = "filter-menu";
      menu.id = menuId;
      menu.setAttribute("role", "listbox");
      menu.setAttribute("aria-labelledby", button.id);

      function syncOptions() {
        const selected = select.options[select.selectedIndex];
        button.childNodes[0]?.remove();
        button.insertBefore(
          document.createTextNode(selected ? selected.textContent.trim() : ""),
          button.firstChild,
        );
        menu.replaceChildren();
        if (select.getAttribute("aria-invalid") === "true")
          button.setAttribute("aria-invalid", "true");
        else button.removeAttribute("aria-invalid");
        [...select.options].forEach((option) => {
          const item = document.createElement("button");
          item.className = `filter-option${option.selected ? " active" : ""}`;
          item.type = "button";
          item.disabled = option.disabled;
          item.setAttribute("role", "option");
          item.setAttribute("aria-selected", String(option.selected));
          item.dataset.value = option.value;
          item.textContent = option.textContent.trim();
          menu.appendChild(item);
        });
      }

      syncOptions();
      select.dataset.dropdownEnhanced = "true";
      select.hidden = true;
      select.setAttribute("aria-hidden", "true");
      select.tabIndex = -1;
      if (select.parentElement.matches(".my-events-filter"))
        select.parentElement.classList.add("native-filter-parent");
      select.parentNode.insertBefore(wrapper, select);
      wrapper.append(button, menu, select);
      wrappers.push({ wrapper, button, menu });
      associatedLabel?.addEventListener("click", (event) => {
        if (event.target.closest(".native-filter-dropdown")) return;
        event.preventDefault();
        button.focus();
      });
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        const wasOpen = menu.classList.contains("show");
        closeMenus();
        if (!wasOpen) {
          menu.classList.add("show");
          button.setAttribute("aria-expanded", "true");
        }
      });
      menu.addEventListener("click", (event) => {
        const item = event.target.closest(".filter-option");
        if (!item || item.disabled) return;
        event.stopPropagation();
        select.value = item.dataset.value;
        select.dispatchEvent(new Event("change", { bubbles: true }));
        syncOptions();
        closeMenus();
        button.focus();
      });
      select.addEventListener("change", syncOptions);
      new MutationObserver(syncOptions).observe(select, {
        childList: true,
        attributes: true,
        attributeFilter: ["aria-invalid"],
      });
    });

    if (!window.dropdownMenusCloseHandler) {
      window.dropdownMenusCloseHandler = true;
      document.addEventListener("click", (event) => {
        if (event.target.closest(".native-filter-dropdown")) return;
        document
          .querySelectorAll(".native-filter-dropdown .filter-menu.show")
          .forEach((menu) => menu.classList.remove("show"));
        document
          .querySelectorAll(
            '.native-filter-dropdown .filter-button[aria-expanded="true"]',
          )
          .forEach((button) => button.setAttribute("aria-expanded", "false"));
      });
      document.addEventListener("keydown", (event) => {
        if (event.key !== "Escape") return;
        document
          .querySelectorAll(".native-filter-dropdown .filter-menu.show")
          .forEach((menu) => menu.classList.remove("show"));
        document
          .querySelectorAll(
            '.native-filter-dropdown .filter-button[aria-expanded="true"]',
          )
          .forEach((button) => button.setAttribute("aria-expanded", "false"));
      });
    }
  };

function readOrganizerEvents() {
  const storedEvents = localStorage.getItem(organizerEventStorageKey);
  if (!storedEvents) {
    return [];
  }

  try {
    const events = JSON.parse(storedEvents);
    if (Array.isArray(events)) {
      return events.filter(
        (e) => !String(e.eventId || e.id || "").startsWith("demo-event-"),
      );
    }
    return [];
  } catch (error) {
    console.error("Unable to read organizer events:", error);
    return [];
  }
}

const organizerEvents = readOrganizerEvents();

function getOrganizerEvents() {
  return [...organizerEvents];
}

function saveOrganizerEvent(event) {
  organizerEvents.push(event);
  localStorage.setItem(
    organizerEventStorageKey,
    JSON.stringify(organizerEvents),
  );
}

function updateOrganizerEvent(eventId, changes) {
  const index = organizerEvents.findIndex((event) => event.eventId === eventId);
  if (index === -1) return false;
  organizerEvents[index] = {
    ...organizerEvents[index],
    ...changes,
    updatedAt: new Date().toISOString(),
  };
  localStorage.setItem(
    organizerEventStorageKey,
    JSON.stringify(organizerEvents),
  );
  window.dispatchEvent(new Event("recovibeOrganizerEventsChanged"));
  return true;
}

function removeOrganizerEvent(eventId) {
  const index = organizerEvents.findIndex((event) => event.eventId === eventId);
  if (index === -1) return false;
  organizerEvents.splice(index, 1);
  localStorage.setItem(
    organizerEventStorageKey,
    JSON.stringify(organizerEvents),
  );
  return true;
}

function isOrganizerEventHapApproved(event, hapNumber) {
  if (!event) return false;

  const approvalKey = `hap${hapNumber}Approved`;
  const statusKey = `hap_${hapNumber}_status`;
  const legacyKey = `hap${hapNumber}`;
  const nestedApproval = event.approvals?.[`hap${hapNumber}`];

  if (event[approvalKey] === true) return true;
  if (nestedApproval === true) return true;
  if (
    typeof nestedApproval === "string" &&
    nestedApproval.toLowerCase() === "approved"
  ) {
    return true;
  }
  if (
    typeof event[statusKey] === "string" &&
    event[statusKey].toLowerCase() === "approved"
  ) {
    return true;
  }
  if (event[legacyKey] === true) return true;

  const hasSpecificHapTracking =
    event.hap1Approved === true ||
    event.hap2Approved === true ||
    event.hap3Approved === true ||
    Boolean(
      event.approvals?.hap1 || event.approvals?.hap2 || event.approvals?.hap3,
    ) ||
    Boolean(event.hap_1_status || event.hap_2_status || event.hap_3_status);

  if (hasSpecificHapTracking) {
    return false;
  }

  const normStatus = String(event.status || "").trim().toLowerCase();
  if (["approved", "published", "completed"].includes(normStatus)) {
    return true;
  }

  return false;
}


function canPublishOrganizerEvent(event) {
  const stages = Array.isArray(event?.approvalStages)
    ? event.approvalStages
    : Object.values(event?.approvalStages || {});
  const approvalMembers = Object.values(event?.approval?.members || event?.approvalData?.members || {});
  const fourStagesApproved = [stages, approvalMembers].some((group) =>
    group.length === 4 && group.every((stage) =>
      ["approved", "ok"].includes(String(stage?.status || stage?.approvalStatus || stage?.state || stage?.decision || "").trim().toLowerCase()),
    ),
  );
  return (
    fourStagesApproved &&
    event.status === "Approved" &&
    event.published !== true &&
    event.cancelled !== true
  );
}

function publishOrganizerEvent(eventId, currentOrganizerId) {
  const event = organizerEvents.find((item) => item.eventId === eventId);

  if (!event || String(event.organizerId) !== String(currentOrganizerId)) {
    return {
      success: false,
      message: "You do not have permission to publish this event.",
    };
  }

  if (!canPublishOrganizerEvent(event)) {
    return {
      success: false,
      message:
        "Event cannot be published until all three HAP approvals are completed.",
    };
  }

  const updated = updateOrganizerEvent(eventId, {
    status: "Published",
    published: true,
  });

  return {
    success: updated,
    message: updated ? "" : "Unable to publish the event.",
  };
}

function organizerEventToFeed(event) {
  return {
    id: event.eventId,
    eventId: event.eventId,
    dateISO: event.dateISO,
    title: event.title,
    location: event.location,
    room: event.room,
    time: event.time,
    source: "Event Organizer",
    tag: event.category,
    category: event.category,
    capacity: Number(event.capacity),
    maxSlots: Number(event.capacity),
    slots: Number(event.capacity),
    slotsOpen: Number(event.capacity),
    status: event.status,
    desc: event.description,
    organizerId: event.organizerId,
  };
}

function mergeOrganizerEventsIntoFeed() {
  if (!Array.isArray(window.RECOVIBE_EVENTS)) return;
  const existingIds = new Set(window.RECOVIBE_EVENTS.map((event) => event.id));
  getOrganizerEvents()
    .map(organizerEventToFeed)
    .forEach((event) => {
      if (!existingIds.has(event.id)) window.RECOVIBE_EVENTS.push(event);
    });
}
