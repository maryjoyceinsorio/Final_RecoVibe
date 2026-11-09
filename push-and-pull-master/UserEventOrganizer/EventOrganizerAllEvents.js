import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  collection,
  onSnapshot,
  query,
  where,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  auth,
  authReady,
  db,
  functions,
  isFirebaseConfigured,
} from "../UserStudent/firebaseConfig.js";
import { syncOrganizerOrganization } from "../organizationScope.js";

(() => {
  let events = [];
  let isLoading = true;
  let loadError = "";
  let unsubscribeEvents;
  const happeningNowRows = document.getElementById("happeningNowEvents");
  const upcomingRows = document.getElementById("upcomingEvents");
  const upcomingHeading = document.querySelector("#upcomingEventsSection h2");
  const search = document.getElementById("eventSearch");
  const status = document.getElementById("eventStatusFilter");
  const category = document.getElementById("eventCategoryFilter");
  let organizerId = "";
  const state = {
    view: "all",
    source: "All Sources",
    category: "all",
    date: "all",
    status: "all",
  };
  const initialEventId = new URLSearchParams(window.location.search).get(
    "eventId",
  );

  const organizerToday = document.getElementById("organizerToday");
  if (organizerToday) {
    organizerToday.textContent = new Date().toLocaleDateString("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
    });
  }

  const escape = (value) =>
    String(value ?? "").replace(
      /[&<>"']/g,
      (char) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[char],
    );
  const sourceMatches = {
    "PUP Official": ["pup official", "pup biñan", "pup biñan campus", "pup cite", "pup main"],
    CSC: ["csc"],
    Organizational: ["organizational", "organization", "event organizer", "ibits", "organizer"],
    "Others / External": ["others / external", "other / external", "others/external", "admin", "external"],
  };
  const categoryMatches = {
    "Academic & Learning": ["academic", "learning"],
    "Tech & Innovation": ["tech", "innovation"],
    "Leadership & Career": ["leadership", "career"],
    "Sports & Fitness": ["sport", "fitness"],
    "Music & Entertainment": ["music", "entertainment"],
    "Orgs & Student Acts": ["org", "organization", "student act"],
    "Social Events": ["social"],
    "Community & Outreach": ["community", "outreach"],
    Competitions: ["competition", "hackathon"],
    "Seminars & Workshops": ["seminar", "workshop"],
    "Arts & Culture": ["art", "culture"],
    "University & Campuses": ["university", "campus"],
  };
  function normalizeSource(source) {
    const value = String(source || "").trim().toLowerCase();
    return (
      Object.keys(sourceMatches).find((label) =>
        sourceMatches[label].includes(value),
      ) || "Others / External"
    );
  }
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  function matches(event) {
    const query = search.value.trim().toLowerCase();
    const eventDate = event.dateISO || event.eventDate;
    const date = eventDate
      ? new Date(`${String(eventDate).slice(0, 10)}T00:00:00`)
      : null;
    const categoryValues = categoryMatches[state.category] || [];
    const dateMatches =
      state.date === "all" ||
      (date && date.getMonth() === Number(state.date.replace("month-", "")));
    const eventStatus = String(event.status || "")
      .trim()
      .toLowerCase()
      .replace(/[ _-]+/g, " ");
    const isCancelled =
      event.cancelled === true ||
      event.canceled === true ||
      ["cancelled", "canceled"].includes(eventStatus);
    const isRescheduled =
      event.rescheduled === true || eventStatus === "rescheduled";
    const isCompleted = eventStatus === "completed" || event.completed === true;
    const eventDay = date
      ? new Date(date.getFullYear(), date.getMonth(), date.getDate())
      : null;
    const isHappening =
      eventDay &&
      eventDay.getTime() === today.getTime() &&
      !isCancelled &&
      !isCompleted &&
      !isRescheduled;
    const isUpcoming =
      eventDay &&
      eventDay > today &&
      !isCancelled &&
      !isCompleted &&
      !isRescheduled;
    const statusMatches =
      state.status === "all" ||
      (state.status === "upcoming" && isUpcoming) ||
      (state.status === "canceled" && isCancelled) ||
      (state.status === "completed" && isCompleted) ||
      (state.status === "rescheduled" && isRescheduled);

    return (
      (state.view === "all" ||
        String(event.organizerId || "") === String(organizerId)) &&
      (state.source === "All Sources" ||
        normalizeSource(event.source || event.eventSource) === state.source) &&
      (state.category === "all" ||
        categoryValues.some((value) =>
          String(event.category || event.eventType || "")
            .toLowerCase()
            .includes(value),
        )) &&
      dateMatches &&
      statusMatches &&
      (!query ||
        `${event.title} ${event.category} ${event.location}`
          .toLowerCase()
          .includes(query))
    );
  }

  function eventCard(event) {
    const eventDate = event.dateISO || event.eventDate;
    const date = eventDate
      ? new Date(`${String(eventDate).slice(0, 10)}T00:00:00`)
      : null;
    const dateLabel = date
      ? date.toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
        })
      : "Date TBA";
    const totalSlots = Number(event.capacity || 0);
    const openSlots = Number(event.slotsOpen ?? Math.round(totalSlots * 0.6));
    const eventId = escape(event.eventId || event.id || "");
    return `<article class="published-event-card" id="organizer-event-card-${eventId}" data-event-id="${eventId}"><div class="published-event-date" id="published-event-date-${eventId}" aria-label="${escape(dateLabel)}"><span class="published-event-month" id="published-event-month-${eventId}">${date ? date.toLocaleDateString("en-US", { month: "short" }) : "TBA"}</span><strong class="published-event-day" id="published-event-day-${eventId}">${date ? date.getDate() : ""}</strong><span class="published-event-year" id="published-event-year-${eventId}">${date ? date.getFullYear() : ""}</span></div><div class="published-event-content" id="published-event-content-${eventId}"><div class="published-event-heading"><div><h2 class="published-event-title" id="published-event-title-${eventId}">${escape(event.title)}</h2><p class="published-event-source" id="published-event-source-${eventId}">${escape(normalizeSource(event.source || event.eventSource))}</p></div></div><div class="published-event-meta" id="published-event-meta-${eventId}"><span id="published-event-date-label-${eventId}" class="visually-hidden">${escape(dateLabel)}</span><span class="published-event-meta-time" id="published-event-time-${eventId}">${escape(event.time || "Time TBA")}</span><span class="published-event-meta-location" id="published-event-location-${eventId}">${escape(event.location || "Location TBA")}${event.room ? `&nbsp;·&nbsp;${escape(event.room)}` : ""}</span></div><div class="published-event-footer"><div class="published-event-summary" id="published-event-summary-${eventId}"><div class="published-event-tags" id="published-event-category-group-${eventId}"><span id="published-event-category-${eventId}">${escape(event.category || "General")}</span></div><span class="published-event-capacity" id="published-event-capacity-${eventId}">${openSlots} of ${totalSlots} Slots Open</span></div><div class="published-event-actions"><button type="button" id="published-event-details-${eventId}" data-preview-id="${eventId}">View Details</button></div></div></div></article>`;
  }

  function renderList(element, list) {
    if (isLoading) {
      element.innerHTML = '<div class="organizer-empty">Loading events...</div>';
      return;
    }
    if (loadError) {
      element.innerHTML = `<div class="organizer-empty">${escape(loadError)}</div>`;
      return;
    }
    if (!events.length) {
      element.innerHTML =
        '<div class="organizer-empty">No events are available yet.</div>';
      return;
    }
    if (!list.length) {
      element.innerHTML =
        '<div class="organizer-empty">No events match your filters.</div>';
      return;
    }
    element.innerHTML = list
      .map((event) => eventCard(event))
      .join("");
  }

  function render() {
    const visible = events
      .filter(matches)
      .sort(
        (first, second) =>
          new Date(second.createdAt || 0).getTime() -
          new Date(first.createdAt || 0).getTime(),
      );
    const happeningNow = visible.filter((event) => {
      const eventDate = event.dateISO || event.eventDate;
      const date = eventDate
        ? new Date(`${String(eventDate).slice(0, 10)}T00:00:00`)
        : null;
      return date && date.getTime() === today.getTime();
    });
    const upcoming = visible.filter((event) => !happeningNow.includes(event));
    if (upcomingHeading) {
      const headingLabel = state.status === "all"
        ? "All Events"
        : state.status.charAt(0).toUpperCase() + state.status.slice(1);
      upcomingHeading.textContent = `${headingLabel} (${upcoming.length})`;
    }
    renderList(happeningNowRows, happeningNow);
    renderList(upcomingRows, upcoming);
  }

  function openDetails(eventId) {
    const event = events.find(
      (item) => String(item.eventId || item.id) === String(eventId),
    );
    if (!event) return;
    event.source = normalizeSource(event.source || event.eventSource);
    const canReview = String(event.organizerId) === String(organizerId);
    window.RecovibeEventDetails?.open(
      event,
      canReview
        ? {
            showApprovalDocuments: true,
            actionLabel: "Review Documents",
            onAction: () => "Document review is available for this event.",
          }
        : {},
    );
  }

  function closeDetails() {
    const modal = document.getElementById("organizerEventModal");
    modal.classList.remove("is-open");
    modal.setAttribute("aria-hidden", "true");
  }

  function closeMenus() {
    document
      .querySelectorAll(".filter-menu.show")
      .forEach((menu) => menu.classList.remove("show"));
    document
      .querySelectorAll('.filter-button[aria-expanded="true"]')
      .forEach((button) => button.setAttribute("aria-expanded", "false"));
  }

  function createDropdown(filter, label, options) {
    const wrapper = document.createElement("div");
    wrapper.className = `filter-dropdown filter-dropdown--${filter}`;
    wrapper.innerHTML = `<button type="button" class="filter-button" data-filter="${filter}" aria-expanded="false">${label}</button><div class="filter-menu" data-menu="${filter}">${options.map((option) => `<button type="button" class="filter-option${option.value === options[0].value ? " active" : ""}" data-value="${escape(option.value)}">${escape(option.label)}</button>`).join("")}</div>`;
    return wrapper;
  }

  function setupDropdowns() {
    const toolbar = search.parentElement;
    toolbar.querySelector(".organizer-button")?.remove();
    const filterBar = document.createElement("div");
    filterBar.className = "filter-bar";
    filterBar.append(
      createDropdown("events", "All Events", [
        { value: "all", label: "All Events" },
        { value: "mine", label: "My Events" },
      ]),
      createDropdown("sources", "All Sources", [
        "All Sources",
        "PUP Official",
        "CSC",
        "Organizational",
        "Others / External",
      ].map((value) => ({ value, label: value }))),
      createDropdown("category", "Category", [
        { value: "all", label: "All Categories" },
        ...Object.keys(categoryMatches).map((value) => ({
          value,
          label: value,
        })),
      ]),
      createDropdown("date", "All Dates", [
        { value: "all", label: "All Dates" },
        ...[
          "January",
          "February",
          "March",
          "April",
          "May",
          "June",
          "July",
          "August",
          "September",
          "October",
          "November",
          "December",
        ].map((label, index) => ({ value: `month-${index}`, label })),
      ]),
      createDropdown("status", "Event Status", [
        { value: "all", label: "All Statuses" },
        { value: "upcoming", label: "Upcoming" },
        { value: "canceled", label: "Canceled" },
        { value: "completed", label: "Completed" },
        { value: "rescheduled", label: "Rescheduled" },
      ]),
    );
    toolbar.insertBefore(filterBar, status);
    status.hidden = true;
    category.hidden = true;
    filterBar.addEventListener("click", (event) => {
      const button = event.target.closest(".filter-button");
      const option = event.target.closest(".filter-option");
      if (option) {
        const filter = option
          .closest(".filter-dropdown")
          .querySelector(".filter-button").dataset.filter;
        const stateKey =
          filter === "events"
            ? "view"
            : filter === "sources"
              ? "source"
              : filter;
        state[stateKey] = option.dataset.value;
        option.parentElement
          .querySelectorAll(".filter-option")
          .forEach((item) => item.classList.toggle("active", item === option));
        option
          .closest(".filter-dropdown")
          .querySelector(".filter-button").childNodes[0].textContent =
          option.textContent;
        closeMenus();
        render();
        return;
      }
      if (button) {
        const menu = button.nextElementSibling;
        const open = menu.classList.contains("show");
        closeMenus();
        if (!open) {
          menu.classList.add("show");
          button.setAttribute("aria-expanded", "true");
        }
      }
    });
  }

  search.addEventListener("input", render);
  document.addEventListener("click", (event) => {
    if (event.target.dataset.previewId)
      openDetails(event.target.dataset.previewId);
  });
  document.getElementById("modalClose").addEventListener("click", closeDetails);
  document
    .getElementById("modalReviewDocuments")
    .addEventListener("click", (event) => {
      const selectedEvent = events.find(
        (item) =>
          String(item.eventId || item.id) ===
          String(event.currentTarget.dataset.eventId),
      );
      if (
        !selectedEvent ||
        String(selectedEvent.organizerId) !== String(organizerId)
      ) {
        document.getElementById("modalReviewNotice").textContent =
          "Only the organizer who created this event can review its documents.";
        return;
      }
      document.getElementById("modalReviewNotice").textContent =
        "Document review is available for this event.";
    });
  document
    .getElementById("organizerEventModal")
    .addEventListener("click", (event) => {
      if (event.target.id === "organizerEventModal") closeDetails();
    });
  document.addEventListener("click", (event) => {
    if (!event.target.closest(".filter-dropdown")) closeMenus();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeMenus();
      closeDetails();
    }
  });
  setupDropdowns();
  render();

  if (!isFirebaseConfigured || !auth || !db) {
    isLoading = false;
    loadError = "Event data is unavailable. Please contact support.";
    render();
  } else {
    authReady.then(() => onAuthStateChanged(auth, async (user) => {
      unsubscribeEvents?.();
      if (!user) {
        window.location.replace("EventOrganizerLogin.html");
        return;
      }

      organizerId = user.uid;
      isLoading = true;
      loadError = "";
      render();
      let organizationCode;
      try {
        organizationCode = await syncOrganizerOrganization(functions);
      } catch (error) {
        console.error("Could not verify organizer organization:", error);
        isLoading = false;
        loadError = "Could not verify your organization. Please refresh and try again.";
        render();
        return;
      }
      unsubscribeEvents = onSnapshot(
        query(
          collection(db, "events"),
          where("organizationCode", "==", organizationCode),
        ),
        (snapshot) => {
          events = snapshot.docs
            .map((eventDocument) => {
              const data = eventDocument.data();
              const status = String(data.status || "")
                .trim()
                .toLowerCase()
                .replace(/[ _-]+/g, " ");
              const isPublished =
                ["approved", "published", "rescheduled"].includes(status) ||
                data.published === true;
              if (!isPublished) return null;
              const eventDate = data.eventDate || data.dateISO || data.date || "";
              const createdAt = data.createdAt?.toDate
                ? data.createdAt.toDate().toISOString()
                : data.createdAt || "";
              const startTime = data.startTime || "";
              const endTime = data.endTime || "";
              return {
                ...data,
                id: eventDocument.id,
                eventId: eventDocument.id,
                title: data.eventName || data.title || "Untitled",
                dateISO: eventDate,
                time:
                  data.time ||
                  [startTime, endTime].filter(Boolean).join(" - ") ||
                  "Time TBA",
                location: data.venue || data.location || data.venueOther || "",
                category: data.category || data.eventType || "General",
                source:
                  data.source ||
                  data.eventSource ||
                  (data.organizerId
                    ? "Organizational"
                    : data.organization || data.organizerName || "Others / External"),
                createdAt,
                organizerId: data.organizerId || "",
              };
            })
            .filter(Boolean);
          isLoading = false;
          loadError = "";
          render();
          if (initialEventId) openDetails(initialEventId);
        },
        (error) => {
          console.error("Unable to load All Events:", error);
          events = [];
          isLoading = false;
          loadError = "Could not load events. Please try again later.";
          render();
        },
      );
    })).catch((error) => {
      console.error("Could not restore organizer authentication state:", error);
      isLoading = false;
      loadError = "Could not verify your session. Please refresh and try again.";
      render();
    });
  }
})();
