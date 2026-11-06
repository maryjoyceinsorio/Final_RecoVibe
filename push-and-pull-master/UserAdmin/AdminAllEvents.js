import {
  collection,
  onSnapshot,
  orderBy,
  query,
  where,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { auth, authReady, db, functions, isFirebaseConfigured } from "../UserStudent/firebaseConfig.js";
import { syncApproverOrganization } from "../organizationScope.js";

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
  const root = document.getElementById("allEventsRoot"),
    params = new URLSearchParams(location.search),
    now = new Date(),
    today = manilaDate(now);
  let shown = 10,
    searchTimer;
  let firestoreEvents = [];
  const months = [
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
  ];
  const sources = [
    "PUP Official",
    "CSC",
    "Teacher / Faculty",
    "Organizational",
    "Others / External",
  ];
  const categories = [
    "Academic & Learning",
    "Tech & Innovation",
    "Leadership & Career",
    "Sports & Fitness",
    "Music & Entertainment",
    "Orgs & Student Acts",
    "Social Events",
    "Community & Outreach",
    "Competitions",
    "Seminars & Workshops",
    "Arts & Culture",
    "University & Campuses",
  ];
  const state = {
    q: params.get("q") || "",
    source: params.get("source") || "",
    category: params.get("category") || "",
    month: params.get("month") || "",
    year: Number(params.get("year")) || Number(today.slice(0, 4)),
    status: params.get("status") || "",
    availability: params.get("availability") || "",
  };
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
  function read(key, fallback) {
    try {
      return JSON.parse(localStorage.getItem(key) || "null") ?? fallback;
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
  function manilaDate(date) {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila" }).format(
      date,
    );
  }
  function normalizeSource(source, role = "") {
    const value = String(source || "").trim().toLowerCase();
    if (!value && role === "Teacher") return "Teacher / Faculty";
    if (/\bcsc\b/.test(value)) return "CSC";
    if (/teacher|faculty/.test(value)) return "Teacher / Faculty";
    if (/organization|organizational|ibits|event organizer|organizer/.test(value))
      return "Organizational";
    if (/external|admin|other/.test(value)) return "Others / External";
    if (/pup|campus|cite/.test(value)) return "PUP Official";
    return "Others / External";
  }
  function timeMins(value) {
    const text = String(value || "").trim();
    let match = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(text);
    if (match)
      return (
        ((Number(match[1]) % 12) + (match[3].toUpperCase() === "PM" ? 12 : 0)) *
          60 +
        Number(match[2])
      );
    match = /^(\d{1,2}):(\d{2})$/.exec(text);
    return match ? Number(match[1]) * 60 + Number(match[2]) : null;
  }
  function eventTimes(event) {
    const parts = String(event.time || "").split(/\s*[-–]\s*/);
    return [event.startTime || parts[0] || "", event.endTime || parts[1] || ""];
  }
  function instant(event, which) {
    const date = (event.dateISO || event.date || "").slice(0, 10),
      time = eventTimes(event)[which],
      mins = timeMins(time);
    if (!date || mins === null) return null;
    return new Date(
      `${date}T${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}:00+08:00`,
    );
  }
  function status(event) {
    const raw = String(event.status || "")
      .toLowerCase()
      .replace(/[ _-]+/g, " ");
    if (["cancelled", "canceled"].includes(raw)) return "Cancelled";
    const end = instant(event, 1),
      start = instant(event, 0);
    if (end && end < now) return "Completed";
    if (event.isRescheduled) return "Rescheduled";
    if (start && end && start <= now && now <= end) return "Happening";
    return "Upcoming";
  }
  function allEvents() {
    return firestoreEvents;
  }
  function capacity(event) {
    return event.capacityMode === "N/A" ||
      (event.maxCapacity == null && event.capacity == null)
      ? null
      : Number(event.maxCapacity ?? event.capacity ?? event.maxSlots);
  }
  function openSlots(event) {
    if (event.capacityMode === "N/A" || capacity(event) === null) return null;
    return Math.max(
      0,
      Number(
        event.openSlots ??
          event.slotsOpen ??
          event.availableSlots ??
          event.slots ??
          capacity(event),
      ) || 0,
    );
  }
  function matches(event) {
    const date = (event.dateISO || event.date || "").slice(0, 10),
      st = status(event),
      query = state.q.toLowerCase();
    const text =
      `${event.title || ""} ${event.organization || event.organizerName || event.organizer || ""} ${event.location || event.venue || ""}`.toLowerCase();
    const monthMatch =
      !state.month ||
      date.startsWith(
        `${state.year}-${String(Number(state.month) + 1).padStart(2, "0")}`,
      );
    const full = openSlots(event) === 0;
    const source = normalizeSource(event.source, event._role);
    return (
      (!query || text.includes(query)) &&
      (!state.source || source === normalizeSource(state.source)) &&
      (!state.category ||
        (event.categories || event.category || event.tag || "")
          .toString()
          .toLowerCase()
          .includes(state.category.toLowerCase())) &&
      monthMatch &&
      (!state.status || st === state.status) &&
      (!state.availability || (state.availability === "Full" ? full : !full))
    );
  }
  function dateStart(event) {
    return (
      instant(event, 0)?.getTime() ??
      new Date(
        `${(event.dateISO || event.date || "").slice(0, 10)}T00:00:00+08:00`,
      ).getTime()
    );
  }
  function render() {
    try {
      const selected = allEvents().filter(matches);
      const groupOrder = state.status
        ? [state.status]
        : ["Happening", "Upcoming", "Completed", "Cancelled"];
      const asc = (a, b) => dateStart(a) - dateStart(b);
      const sections = groupOrder
        .map((group) => {
          const list = selected
            .filter((event) => status(event) === group)
            .sort((a, b) =>
              ["Completed", "Cancelled"].includes(group)
                ? asc(b, a)
                : asc(a, b),
            );
          if (!list.length) return "";
          return `<section><h2 class="admin-group-title">${group === "Happening" ? "Happening Now" : group}</h2><div class="admin-event-grid">${list.slice(0, shown).map(card).join("")}</div></section>`;
        })
        .join("");
      root.innerHTML = `<div class="events-toolbar"><input class="admin-search" id="eventSearch" type="search" placeholder="Search events, organizer or venue" aria-label="Search events" value="${esc(state.q)}">${dropdown("source", "All Sources", ["All Sources", ...sources])}${dropdown("category", "All Categories", ["All Categories", ...categories])}${monthDropdown()}${dropdown("status", "Event Status", ["Event Status", "Happening", "Upcoming", "Cancelled", "Completed", "Rescheduled"])}${dropdown("availability", "Availability", ["Availability", "Available", "Full"])}<button type="button" id="clearEvents" class="admin-link-button" ${hasFilters() ? "" : "hidden"}>Clear filters</button></div>${sections || '<div class="admin-empty">No events match these filters.</div>'}${selected.length > shown ? '<div class="admin-section-heading"><button class="admin-row-action" id="loadMore" type="button">Load more</button></div>' : ""}`;
      wire();
      root.querySelectorAll("[data-event-view]").forEach(
        (button) =>
          (button.onclick = () => {
            const event = selected.find(
              (item) =>
                String(item.eventId || item.id) === button.dataset.eventView,
            );
            if (event) window.RecovibeEventDetails?.open(event);
          }),
      );
      document.querySelector("[data-queue-count]").hidden = true;
    } catch (error) {
      root.innerHTML =
        '<div class="admin-error">Could not load events. <button id="retryEvents" class="admin-row-action">Retry</button></div>';
      root.querySelector("#retryEvents").onclick = render;
    }
  }
  function hasFilters() {
    return Boolean(
      state.q ||
      state.source ||
      state.category ||
      state.month ||
      state.status ||
      state.availability,
    );
  }
  function isPublishedEvent(event) {
    const raw = String(event.status || "")
      .trim()
      .toLowerCase()
      .replace(/[ _-]+/g, " ");
    return (
      [
        "published",
        "approved",
        "available to join",
        "rescheduled",
      ].includes(raw) ||
      event.isPublished === true ||
      event.published === true
    );
  }
  function card(event) {
    const date = (event.dateISO || event.date || "").slice(0, 10),
      parts = date.split("-"),
      time = eventTimes(event),
      caps = capacity(event),
      open = openSlots(event),
      raw = String(event.status || "")
        .toLowerCase()
        .replace(/_/g, " "),
      st = status(event);
    const cats = Array.isArray(event.categories)
      ? event.categories
      : [event.category || event.tag || "General"];
    const chips = [
      st === "Happening" ? '<span class="admin-chip chip-happening">Happening</span>' : "",
      st === "Cancelled" ? '<span class="admin-chip chip-cancelled">Cancelled</span>' : "",
      st === "Completed" ? '<span class="admin-chip chip-completed">Completed</span>' : "",
      event.isRescheduled && st !== "Completed" ? '<span class="admin-chip">Rescheduled</span>' : "",
      open === 0 ? '<span class="admin-chip chip-full">Full</span>' : "",
    ].filter(Boolean);
    const organizer =
      event._role === "Teacher"
        ? `Teacher - ${event.organizer || event.organizerName || "Teacher"}`
        : event.organizerName || event.organizer || event.organization || "Event Organizer";
    const monthName = date ? new Date(`${date}T00:00:00`).toLocaleDateString("en-US", { month: "short", timeZone: "Asia/Manila" }) : "—";
    const dayNum = parts[2] ? parts[2].replace(/^0+/, '') || parts[2] : "—";
    return `<article class="admin-event-card"><div class="event-card-header"><div class="event-date-tile"><small>${esc(monthName)}</small><strong>${esc(parts[2] || "—")}</strong></div><div class="event-card-titles"><h3 class="event-card-title">${esc(event.title || "Untitled event")}</h3><p class="event-organizer-text"><strong>Event Organizer:</strong> ${esc(organizer)}</p><p class="event-source-text"><strong>Source:</strong> ${esc(normalizeSource(event.source, event._role))}</p></div></div><div class="event-card-meta"><span><strong>Date:</strong> ${esc(date || "—")}</span><span><strong>Start:</strong> ${esc(time[0] || "—")}</span><span><strong>End:</strong> ${esc(time[1] || "—")}</span><span><strong>Venue:</strong> ${esc(event.venueOther || event.location || event.venue || "—")}</span><span style="grid-column: 1 / -1;"><strong>Capacity:</strong> ${caps === null ? "No capacity limit" : `${open} out of ${caps} Slots are Open`}</span></div><div class="event-card-bottom"><div class="admin-pills">${cats.map((category) => `<span class="admin-category-pill">${esc(category)}</span>`).join("")} ${chips.join(" ")}</div><button class="admin-row-action" type="button" data-event-view="${esc(event.eventId || event.id)}">View Details</button></div></article>`;
  }
  function dropdown(key, label, options) {
    const current = state[key];
    const selected =
      options.find(
        (option) => option.toLowerCase() === String(current).toLowerCase(),
      ) || options[0];
    return `<div class="admin-filter" data-filter="${key}"><button type="button" aria-haspopup="listbox" aria-expanded="false">${esc(current || selected)}</button><div class="admin-filter-menu" role="listbox" hidden>${options.map((option) => `<button type="button" role="option" aria-selected="${option === selected}" data-value="${esc(option === options[0] ? "" : option)}">${esc(option)}</button>`).join("")}</div></div>`;
  }
  function monthDropdown() {
    const label = state.month
      ? `${months[Number(state.month)]} ${state.year}`
      : "Date";
    return `<div class="admin-filter" data-filter="month"><button type="button" aria-haspopup="listbox" aria-expanded="false">${esc(label)}</button><div class="admin-filter-menu" role="listbox" hidden><div class="admin-year-stepper"><button type="button" data-year="-1" aria-label="Previous year">‹</button><strong>${state.year}</strong><button type="button" data-year="1" aria-label="Next year">›</button></div>${months.map((month, index) => `<button type="button" role="option" aria-selected="${String(index) === state.month}" data-value="${index}">${month}</button>`).join("")}<button type="button" role="option" aria-selected="${!state.month}" data-value="">All months</button></div></div>`;
  }
  function pushState() {
    const next = new URL(location.href);
    Object.entries(state).forEach(([key, value]) => {
      if (value) next.searchParams.set(key, String(value));
      else next.searchParams.delete(key);
    });
    history.replaceState({}, "", next);
  }
  function wire() {
    const search = root.querySelector("#eventSearch");
    search.addEventListener("input", () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        state.q = search.value;
        shown = 10;
        pushState();
        render();
      }, 300);
    });
    root.querySelectorAll(".admin-filter").forEach((filter) => {
      const button = filter.querySelector("button[aria-haspopup]"),
        menu = filter.querySelector("[role=listbox]");
      button.onclick = () => {
        const open = menu.hidden;
        root
          .querySelectorAll(".admin-filter-menu")
          .forEach((item) => (item.hidden = true));
        root
          .querySelectorAll("[aria-haspopup=listbox]")
          .forEach((item) => item.setAttribute("aria-expanded", "false"));
        menu.hidden = !open;
        button.setAttribute("aria-expanded", String(open));
        if (open) menu.querySelector("[role=option]")?.focus();
      };
      menu.addEventListener("click", (event) => {
        const year = event.target.closest("[data-year]");
        if (year) {
          state.year += Number(year.dataset.year);
          pushState();
          render();
          root.querySelector("[data-filter=month]>button").click();
          return;
        }
        const option = event.target.closest("[role=option]");
        if (!option) return;
        const key = filter.dataset.filter;
        state[key] = option.dataset.value;
        if (key === "month" && option.dataset.value === "") state.month = "";
        shown = 10;
        pushState();
        render();
      });
      menu.addEventListener("keydown", (event) => {
        const options = [...menu.querySelectorAll("[role=option]")];
        const index = options.indexOf(document.activeElement);
        if (event.key === "Escape") {
          menu.hidden = true;
          button.setAttribute("aria-expanded", "false");
          button.focus();
        } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          options[
            Math.max(
              0,
              Math.min(
                options.length - 1,
                index + (event.key === "ArrowDown" ? 1 : -1),
              ),
            )
          ]?.focus();
        } else if (event.key === "Enter") document.activeElement.click();
      });
    });
    root.querySelector("#clearEvents").onclick = () => {
      Object.keys(state).forEach(
        (key) =>
          (state[key] =
            key === "year" ? Number(today.slice(0, 4)) : key === "q" ? "" : ""),
      );
      pushState();
      shown = 10;
      render();
    };
    root.querySelector("#loadMore")?.addEventListener("click", () => {
      shown += 10;
      render();
    });
    document.addEventListener(
      "click",
      (event) => {
        if (!event.target.closest(".admin-filter"))
          root
            .querySelectorAll(".admin-filter-menu")
            .forEach((menu) => (menu.hidden = true));
      },
      { once: true },
    );
  }
  root.addEventListener(
    "click",
    (event) => {
      const option = event.target.closest('[role="option"]');
      if (
        option?.getAttribute("aria-selected") === "true" &&
        option.dataset.value
      )
        option.dataset.value = "";
    },
    true,
  );
  root.addEventListener("keydown", (event) => {
    const button = event.target.closest('button[aria-haspopup="listbox"]');
    if (button && ["ArrowDown", "Enter", " "].includes(event.key)) {
      event.preventDefault();
      const menu = button.nextElementSibling;
      menu.hidden = false;
      button.setAttribute("aria-expanded", "true");
      menu.querySelector('[role="option"]')?.focus();
      return;
    }
    const menu = event.target.closest('[role="listbox"]');
    if (!menu) return;
    const options = [...menu.querySelectorAll('[role="option"]')];
    const index = options.indexOf(document.activeElement);
    if (event.key === "Escape") {
      menu.hidden = true;
      menu.previousElementSibling?.setAttribute("aria-expanded", "false");
      menu.previousElementSibling?.focus();
    } else if (event.key === "Home") {
      event.preventDefault();
      options[0]?.focus();
    } else if (event.key === "End") {
      event.preventDefault();
      options.at(-1)?.focus();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      options[
        Math.max(
          0,
          Math.min(
            options.length - 1,
            index + (event.key === "ArrowDown" ? 1 : -1),
          ),
        )
      ]?.focus();
    } else if (event.key === "Enter") {
      event.preventDefault();
      document.activeElement.click();
    }
  });
  document.addEventListener("click", (event) => {
    if (!event.target.closest(".admin-filter"))
      root.querySelectorAll(".admin-filter-menu").forEach((menu) => {
        menu.hidden = true;
        menu.previousElementSibling?.setAttribute("aria-expanded", "false");
      });
  });
  new MutationObserver(() => {
    const clear = root.querySelector("#clearEvents");
    if (clear) clear.style.display = hasFilters() ? "inline-flex" : "none";
  }).observe(root, { childList: true, subtree: true });
  async function init() {
    if (!isFirebaseConfigured || !db) {
      root.innerHTML =
        '<div class="admin-error">Event data is unavailable. Please contact support.</div>';
      return;
    }
    root.innerHTML = '<div class="admin-loading">Loading events…</div>';
    let organizationCode;
    try {
      await authReady;
      if (auth?.authStateReady) await auth.authStateReady();
      organizationCode = await syncApproverOrganization(functions);
    } catch (error) {
      console.error("Could not verify approval organization:", error);
      root.innerHTML = '<div class="admin-error">Could not verify your approval access. Please refresh and try again.</div>';
      return;
    }
    const eventsQuery = organizationCode === "*"
      ? query(collection(db, "events"), orderBy("createdAt", "desc"))
      : query(
          collection(db, "events"),
          where("organizationCode", "==", organizationCode),
        );
    const unsubscribe = onSnapshot(
      eventsQuery,
      (snapshot) => {
        firestoreEvents = snapshot.docs
          .map((eventDocument) => {
            const data = eventDocument.data();
            if (!isPublishedEvent(data)) return null;
            const eventDate = data.eventDate || data.dateISO || data.date || "";
            return {
              ...data,
              id: eventDocument.id,
              eventId: eventDocument.id,
              title: data.eventName || data.title || "Untitled event",
              date: eventDate,
              dateISO: eventDate,
              venue: data.venue || data.location || data.venueOther || "",
              location: data.venue || data.location || data.venueOther || "",
              organization: data.organization || data.organizerName || data.organizer || "",
            };
          })
          .filter(Boolean);
        render();
      },
      (error) => {
        console.error("Unable to load all events:", error);
        root.innerHTML = `<div class="admin-error">Could not load events. ${esc(error.message || "Please try again later.")}</div>`;
      },
    );
        window.addEventListener("beforeunload", unsubscribe, { once: true });
  }
  init();
})();
