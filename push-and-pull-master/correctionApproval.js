import { doc, runTransaction, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const TARGETS = Object.freeze({
  student: Object.freeze({
    collection: "users",
    fields: Object.freeze({
      studentNumber: "studentNumber",
      program: "department",
      yearSection: "yearSection",
    }),
  }),
  teacher: Object.freeze({
    collection: "adminUser",
    fields: Object.freeze({
      teacherId: "teacherId",
      department: "department",
      campus: "campus",
    }),
  }),
  eventorganizer: Object.freeze({
    collection: "adminUser",
    fields: Object.freeze({
      organization: "organization",
    }),
  }),
});

const PROTECTED_PROFILE_FIELDS = new Set([
  "role",
  "status",
  "email",
  "uid",
  "permission",
  "permissions",
  "adminRole",
  "userRole",
]);

function getReviewer(auth) {
  const user = auth?.currentUser;
  if (!user?.uid) throw new Error("A signed-in reviewer is required.");
  return {
    uid: user.uid,
    name: String(user.displayName || user.email || ""),
  };
}

function getRequestReference(db, requestId) {
  if (!db) throw new Error("Firestore is unavailable.");
  const id = String(requestId || "").trim();
  if (!id) throw new Error("A correction request ID is required.");
  return doc(db, "correctionRequests", id);
}

function assertPendingRequest(snapshot) {
  if (!snapshot.exists()) throw new Error("Correction request not found.");
  const request = snapshot.data();
  if (request.status !== "pending") {
    throw new Error("This correction request is no longer pending.");
  }
  return request;
}

function reviewerFields(reviewer, status, note) {
  return {
    status,
    reviewedBy: reviewer.uid,
    reviewedByName: reviewer.name,
    reviewedAt: serverTimestamp(),
    reviewNote: String(note || "").trim(),
    updatedAt: serverTimestamp(),
  };
}

export async function approveCorrectionRequest(db, auth, requestId, note) {
  const reviewer = getReviewer(auth);
  const requestRef = getRequestReference(db, requestId);

  await runTransaction(db, async (transaction) => {
    const requestSnapshot = await transaction.get(requestRef);
    const request = assertPendingRequest(requestSnapshot);
    const role = String(request.requesterRole || "").trim().toLowerCase();
    const target = Object.prototype.hasOwnProperty.call(TARGETS, role)
      ? TARGETS[role]
      : null;
    const hasMappedField = typeof request.field === "string" &&
      target &&
      Object.prototype.hasOwnProperty.call(target.fields, request.field);
    const profileField = hasMappedField ? target.fields[request.field] : "";

    if (!profileField || PROTECTED_PROFILE_FIELDS.has(profileField)) {
      throw new Error("This field can't be updated automatically.");
    }

    if (typeof request.requesterUid !== "string" || !request.requesterUid.trim()) {
      throw new Error("The requester profile could not be identified.");
    }

    if (typeof request.requestedValue !== "string") {
      throw new Error("The requested value must be text.");
    }
    const value = request.requestedValue.trim();
    if (value.length < 1 || value.length > 200) {
      throw new Error("The requested value must be 1 to 200 characters.");
    }

    const profileRef = doc(db, target.collection, request.requesterUid);
    transaction.update(profileRef, {
      [profileField]: value,
      lastCorrectionRequestId: requestSnapshot.id,
      updatedAt: serverTimestamp(),
    });
    transaction.update(
      requestRef,
      reviewerFields(reviewer, "approved", note),
    );
  });
}

export async function rejectCorrectionRequest(db, auth, requestId, note) {
  const reviewer = getReviewer(auth);
  const requestRef = getRequestReference(db, requestId);

  await runTransaction(db, async (transaction) => {
    const requestSnapshot = await transaction.get(requestRef);
    assertPendingRequest(requestSnapshot);
    transaction.update(
      requestRef,
      reviewerFields(reviewer, "rejected", note),
    );
  });
}
