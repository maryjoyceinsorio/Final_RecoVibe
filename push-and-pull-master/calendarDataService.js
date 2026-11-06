import { fetchMonthHolidays } from "./holidayService.js";

let approvedEventsPromise;

function getStudentPreferences() {
  try {
    const user =
      JSON.parse(localStorage.getItem("recovibeCurrentUser") || "null") || {};
    const preferenceKey = "recovibePreferences";
    const accountPreferenceKey = `recovibePreferences:${user.uid || user.email || "student"}`;
    const defaultSources = [
      "PUP Official",
      "CSC",
      "Teacher / Faculty",
      "Organizational",
      "Others / External",
    ];
    const defaults = {
      categories: ["Academic & Learning", "Tech & Innovation"],
      sources: defaultSources,
    };
    let preferences =
      user.preferences ||
      JSON.parse(localStorage.getItem(accountPreferenceKey) || "null") ||
      JSON.parse(localStorage.getItem(preferenceKey) || "null") ||
      defaults;
    if (
      !preferences ||
      !Array.isArray(preferences.categories) ||
      !Array.isArray(preferences.sources)
    ) {
      preferences = defaults;
    }
    return {
      categories: preferences.categories
        .map((c) => String(c).trim().toLowerCase())
        .filter(Boolean),
      sources: preferences.sources
        .map((s) => String(s).trim().toLowerCase())
        .filter(Boolean),
    };
  } catch {
    return {
      categories: ["academic & learning", "tech & innovation"],
      sources: [
        "pup official",
        "csc",
        "teacher / faculty",
        "organizational",
        "others / external",
      ],
    };
  }
}

function normalizeCategory(category) {
  const cat = String(category || "").trim().toLowerCase();
  if (cat.includes("academic") || cat.includes("learning"))
    return "Academic & Learning";
  if (cat.includes("tech") || cat.includes("innovation"))
    return "Tech & Innovation";
  if (
    cat.includes("leadership") ||
    cat.includes("career") ||
    cat.includes("student development")
  )
    return "Leadership & Career";
  if (cat.includes("sport") || cat.includes("fitness"))
    return "Sports & Fitness";
  if (cat.includes("music") || cat.includes("entertainment"))
    return "Music & Entertainment";
  if (cat.includes("org") || cat.includes("student act"))
    return "Orgs & Student Acts";
  if (cat.includes("social")) return "Social Events";
  if (cat.includes("community") || cat.includes("outreach"))
    return "Community & Outreach";
  if (cat.includes("competition") || cat.includes("hackathon"))
    return "Competitions";
  if (cat.includes("seminar") || cat.includes("workshop"))
    return "Seminars & Workshops";
  if (cat.includes("art") || cat.includes("culture")) return "Arts & Culture";
  if (cat.includes("university") || cat.includes("campus"))
    return "University & Campuses";
  return category || "Academic & Learning";
}

function normalizeSource(source) {
  const norm = String(source || "").trim().toLowerCase();
  if (norm.includes("holiday")) return "Holiday";
  if (
    norm === "csc" ||
    norm.includes("central student council") ||
    norm.includes("council")
  )
    return "CSC";
  if (norm.includes("teacher") || norm.includes("faculty"))
    return "Teacher / Faculty";
  if (
    norm.includes("organizer") ||
    norm.includes("organization") ||
    norm.includes("organizational") ||
    /^(ibits|aces|jpcs|pice|iie|jma|jphia|pasoa|chrms|cites)\b/i.test(norm)
  )
    return "Organizational";
  if (
    norm.includes("pup") ||
    norm.includes("official") ||
    norm.includes("campus") ||
    norm.includes("cite")
  )
    return "PUP Official";
  return "Others / External";
}

function matchesStudentPreferences(event, preferences) {
  const id = String(event.eventId || event.id || "");
  if (
    id.startsWith("holiday:") ||
    String(event.source || "").toLowerCase().includes("holiday") ||
    String(event.category || "").toLowerCase().includes("holiday")
  ) {
    return true;
  }
  const eventCat = String(
    event.category || event.categories || event.tag || "",
  )
    .trim()
    .toLowerCase();
  const normalizedCat = normalizeCategory(eventCat).toLowerCase();
  const catMatches =
    preferences.categories.length === 0 ||
    preferences.categories.some(
      (c) =>
        c === eventCat ||
        c === normalizedCat ||
        eventCat.includes(c) ||
        c.includes(eventCat),
    );

  const eventSrc = String(
    event.source || event.eventSource || "Organizational",
  )
    .trim()
    .toLowerCase();
  const normalizedSrc = normalizeSource(eventSrc).toLowerCase();
  const srcMatches =
    preferences.sources.length === 0 ||
    preferences.sources.some(
      (s) =>
        s === eventSrc ||
        s === normalizedSrc ||
        eventSrc.includes(s) ||
        s.includes(eventSrc),
    );

  return catMatches && srcMatches;
}

function isPublicCalendarEvent(event) {
  const id = String(event.eventId || event.id || "");
  if (id.startsWith("demo-event-")) return false;
  if (
    id.startsWith("holiday:") ||
    event.isHoliday ||
    String(event.source || "").toLowerCase().includes("holiday") ||
    String(event.category || "").toLowerCase().includes("holiday")
  ) {
    return true;
  }
  const status = String(event.status || "")
    .trim()
    .toLowerCase()
    .replace(/[ _-]+/g, " ");
  const unpublishedStatuses = [
    "draft",
    "unpublished",
    "pending",
    "rejected",
    "canceled",
    "cancelled",
    "private",
    "deleted",
  ];
  if (unpublishedStatuses.includes(status) || event.published === false) {
    return false;
  }
  return (
    ["approved", "published", "rescheduled"].includes(status) ||
    event.published === true
  );
}

export function loadApprovedFirestoreEvents() {
  if (!approvedEventsPromise) {
    let request;
    request = (async () => {
      try {
        const [{ db, isFirebaseConfigured }, firestore] = await Promise.all([
          import("./UserStudent/firebaseConfig.js"),
          import(
            "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js"
          ),
        ]);

        if (!isFirebaseConfigured || !db) return [];

        const eventsRef = firestore.collection(db, "events");
        const publicSnapshots = await Promise.all([
          firestore.getDocs(
            firestore.query(
              eventsRef,
              firestore.where("status", "in", [
                "approved", "Approved", "APPROVED",
                "published", "Published", "PUBLISHED",
                "rescheduled", "Rescheduled", "RESCHEDULED",
              ]),
            ),
          ),
          firestore.getDocs(
            firestore.query(eventsRef, firestore.where("published", "==", true)),
          ),
        ]);
        const publicDocuments = new Map();
        publicSnapshots.forEach((snapshot) => {
          snapshot.docs.forEach((eventDocument) => {
            publicDocuments.set(eventDocument.id, eventDocument);
          });
        });
        return Array.from(publicDocuments.values())
          .map((eventDocument) => {
            const data = eventDocument.data();
            if (!isPublicCalendarEvent(data)) return null;

            return {
              ...data,
              id: eventDocument.id,
              eventId: eventDocument.id,
              title: data.eventName || data.title || "Untitled event",
              dateISO: data.eventDate || data.dateISO || data.date || "",
              time:
                data.time ||
                [data.startTime, data.endTime].filter(Boolean).join(" - ") ||
                "Time TBA",
              source:
                data.source ||
                data.eventSource ||
                data.category ||
                data.organization ||
                data.organizerName ||
                "Others / External",
              location: data.venue || data.location || data.venueOther || "",
              description:
                data.eventDescription || data.description || data.desc || "",
            };
          })
          .filter(Boolean);
      } catch (error) {
        console.warn("Approved Firestore calendar events are unavailable:", error);
        if (approvedEventsPromise === request) {
          approvedEventsPromise = undefined;
        }
        return [];
      }
    })();
    approvedEventsPromise = request;
  }
  return approvedEventsPromise;
}

export async function loadCalendarData(currentEvents, year, monthIndex) {
  const [firestoreEvents, holidays] = await Promise.all([
    loadApprovedFirestoreEvents(),
    fetchMonthHolidays(year, monthIndex),
  ]);
  const preferences = getStudentPreferences();
  const seen = new Set();
  const isStudent =
    typeof window !== "undefined" &&
    window.location.pathname.toLowerCase().includes("userstudent");
  const events = [...firestoreEvents, ...currentEvents].filter((event) => {
    if (!isPublicCalendarEvent(event)) return false;
    const id = String(event.eventId || event.id || "");
    if (!id || seen.has(id)) return false;
    if (isStudent && !matchesStudentPreferences(event, preferences)) return false;
    seen.add(id);
    return true;
  });
  return { events, holidays };
}
