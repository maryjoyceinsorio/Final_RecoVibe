import { auth, db } from "./UserStudent/firebaseConfig.js";
import {
  addDoc,
  collection,
  onSnapshot,
  query,
  serverTimestamp,
  where,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

export const CORRECTION_FIELDS_BY_ROLE = Object.freeze({
  teacher: Object.freeze([
    Object.freeze({ field: "teacherId", label: "Teacher ID" }),
    Object.freeze({ field: "department", label: "Department" }),
    Object.freeze({ field: "designation", label: "Designation" }),
    Object.freeze({ field: "campus", label: "Campus" }),
  ]),
  student: Object.freeze([
    Object.freeze({ field: "studentNumber", label: "Student number" }),
    Object.freeze({ field: "program", label: "Course/program" }),
    Object.freeze({ field: "yearSection", label: "Year and section" }),
  ]),
  eventorganizer: Object.freeze([
    Object.freeze({ field: "organization", label: "Organization" }),
    Object.freeze({ field: "position", label: "Position" }),
  ]),
});

const ROLE_LABELS = Object.freeze({
  teacher: "Teacher",
  student: "Student",
  eventorganizer: "Event Organizer",
});
const DEBUG = false;

function correctionTimestamp(value) {
  if (value && typeof value.toMillis === "function") return value.toMillis();
  if (value && typeof value.toDate === "function") return value.toDate().getTime();
  if (value && typeof value.seconds === "number") return value.seconds * 1000;
  return null;
}

function sortCorrectionRequests(requests) {
  return requests.sort((a, b) => {
    const aTime = correctionTimestamp(a.createdAt);
    const bTime = correctionTimestamp(b.createdAt);
    if (aTime === null) return bTime === null ? 0 : 1;
    if (bTime === null) return -1;
    return bTime - aTime;
  });
}

function debugCorrectionError(message, error, uid) {
  if (!DEBUG) return;
  console.debug("[Correction Requests]", message, {
    path: "correctionRequests",
    filters: [{ field: "requesterUid", operator: "==", value: uid }],
    code: error?.code || "unknown",
    message: error?.message || String(error),
    uid: auth?.currentUser?.uid,
  });
}

export function subscribeMyCorrectionRequests(uid, onData, onError) {
  if (!uid || auth?.currentUser?.uid !== uid) {
    throw new Error("A matching signed-in user is required to read correction requests.");
  }
  if (!db) throw new Error("Firestore is unavailable.");
  if (typeof onData !== "function" || typeof onError !== "function") {
    throw new TypeError("Correction request listeners require data and error callbacks.");
  }

  if (DEBUG) {
    console.debug("[Correction Requests] Firestore read started", {
      path: "correctionRequests",
      filters: [{ field: "requesterUid", operator: "==", value: uid }],
      uid: auth.currentUser?.uid,
    });
  }

  try {
    return onSnapshot(
      query(collection(db, "correctionRequests"), where("requesterUid", "==", uid)),
      (snapshot) => {
        const requests = snapshot.docs.map((item) => ({
          id: item.id,
          ...item.data(),
        }));
        onData(sortCorrectionRequests(requests));
      },
      (error) => {
        debugCorrectionError("Firestore read failed", error, uid);
        onError(error);
      },
    );
  } catch (error) {
    debugCorrectionError("Firestore read could not start", error, uid);
    throw error;
  }
}

export async function submitCorrectionRequest({
  field,
  currentValue,
  requestedValue,
  reason,
  requesterRole,
  requesterName,
  requesterEmail,
  studentNumber,
  organization,
}) {
  const user = auth?.currentUser;
  if (!user?.uid || !db) throw new Error("Sign in before submitting a correction request.");

  const role = String(requesterRole || "").trim().toLowerCase();
  const fieldDefinition = CORRECTION_FIELDS_BY_ROLE[role]
    ?.find((candidate) => candidate.field === field);
  if (!fieldDefinition) throw new Error("Choose a valid read-only profile field.");

  if (typeof requestedValue !== "string" || typeof reason !== "string") {
    throw new TypeError("The requested value and reason must be text.");
  }
  const normalizedRequestedValue = requestedValue.trim();
  const normalizedReason = reason.trim();
  if (normalizedRequestedValue.length < 1 || normalizedRequestedValue.length > 200) {
    throw new Error("The requested value must be 1 to 200 characters.");
  }
  if (normalizedReason.length < 10 || normalizedReason.length > 500) {
    throw new Error("The reason must be 10 to 500 characters.");
  }

  const normalizedName = String(requesterName || user.displayName || "").trim();
  const normalizedEmail = String(requesterEmail || user.email || "").trim();
  const roleLabel = ROLE_LABELS[role];
  if (!roleLabel || !normalizedName || !normalizedEmail) {
    throw new Error("Your name and email must be available to submit a correction request.");
  }

  const request = {
    requesterUid: user.uid,
    requesterRole: role,
    requesterName: normalizedName,
    requesterEmail: normalizedEmail,
    role: roleLabel,
    field,
    fieldLabel: fieldDefinition.label,
    currentValue: String(currentValue ?? ""),
    requestedValue: normalizedRequestedValue,
    reason: normalizedReason,
    status: "pending",
    createdAt: serverTimestamp(),
  };
  if (role === "student") request.studentNumber = String(studentNumber || "");
  if (role === "eventorganizer") request.organization = String(organization || "");

  const writeUser = auth?.currentUser;
  if (!writeUser?.uid || writeUser.uid !== request.requesterUid) {
    throw new Error("Your sign-in changed. Sign in again before submitting.");
  }
  if (
    typeof request.requesterUid !== "string"
    || request.requesterUid !== writeUser.uid
    || request.status !== "pending"
    || typeof request.requestedValue !== "string"
    || request.requestedValue.length < 1
    || request.requestedValue.length > 200
    || request.requestedValue !== request.requestedValue.trim()
    || typeof request.reason !== "string"
    || request.reason.length < 10
    || request.reason.length > 500
    || request.reason !== request.reason.trim()
  ) {
    throw new Error("The correction request does not meet the submission requirements.");
  }

  const requestRef = await addDoc(collection(db, "correctionRequests"), request);
  return requestRef.id;
}
