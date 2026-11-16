import {
  collection,
  or,
  query,
  where,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const PUBLISHED_STATUSES = [
  "approved", "Approved", "APPROVED",
  "published", "Published", "PUBLISHED",
  "completed", "Completed", "COMPLETED",
  "rescheduled", "Rescheduled", "RESCHEDULED",
];
const PUBLISHED_PUBLICATION_STATUSES = ["published", "Published", "PUBLISHED"];

export function teacherEventReadFilters(uid) {
  return {
    anyOf: [
      { field: "status", operator: "in", value: PUBLISHED_STATUSES },
      { field: "published", operator: "==", value: true },
      { field: "isPublished", operator: "==", value: true },
      {
        field: "publicationStatus",
        operator: "in",
        value: PUBLISHED_PUBLICATION_STATUSES,
      },
      { field: "organizerUid", operator: "==", value: uid },
      { field: "organizerId", operator: "==", value: uid },
      { field: "createdBy", operator: "==", value: uid },
    ],
  };
}

export function teacherEventsQuery(db, uid) {
  if (!uid) throw new Error("A signed-in teacher UID is required for event reads.");

  return query(
    collection(db, "events"),
    or(
      where("status", "in", PUBLISHED_STATUSES),
      where("published", "==", true),
      where("isPublished", "==", true),
      where("publicationStatus", "in", PUBLISHED_PUBLICATION_STATUSES),
      where("organizerUid", "==", uid),
      where("organizerId", "==", uid),
      where("createdBy", "==", uid),
    ),
  );
}
