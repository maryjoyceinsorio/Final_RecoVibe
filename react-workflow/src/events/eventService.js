import { doc, serverTimestamp, updateDoc } from "firebase/firestore";
import { db } from "../../../firebase.js";

export const EVENT_STATUSES = Object.freeze({
  PENDING_ADVISER: "Pending Adviser Approval",
  PENDING_HAP: "Pending HAP Approval",
  PENDING_OSAS: "Pending OSAS Approval",
  APPROVED: "approved",
});

const APPROVAL_TRANSITIONS = {
  adviser: {
    from: EVENT_STATUSES.PENDING_ADVISER,
    to: EVENT_STATUSES.PENDING_HAP,
  },
  hap: {
    from: EVENT_STATUSES.PENDING_HAP,
    to: EVENT_STATUSES.PENDING_OSAS,
  },
  osas: {
    from: EVENT_STATUSES.PENDING_OSAS,
    to: EVENT_STATUSES.APPROVED,
  },
};

export function approveEvent(eventId, approverUid, approverRole, event) {
  if (!eventId || !approverUid || !approverRole) {
    throw new Error("An event ID, approver UID, and approval role are required.");
  }
  const transition = APPROVAL_TRANSITIONS[approverRole];
  if (!transition) throw new Error("Your account is not assigned to an approval stage.");
  if (event?.status !== transition.from) {
    throw new Error("This event is not waiting at your approval stage.");
  }
  if (approverRole === "adviser" && event.adviserUid !== approverUid) {
    throw new Error("Only the assigned adviser can approve this event.");
  }

  return updateDoc(doc(db, "events", eventId), {
    status: transition.to,
    [`${approverRole}ApprovedBy`]: approverUid,
    [`${approverRole}ApprovedAt`]: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
}
