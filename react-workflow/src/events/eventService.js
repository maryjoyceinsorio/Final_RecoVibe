import { doc, serverTimestamp, updateDoc } from "firebase/firestore";
import { db } from "../../../firebase.js";

export function approveEvent(eventId, adminUid) {
  if (!eventId || !adminUid) throw new Error("An event ID and admin UID are required.");
  return updateDoc(doc(db, "events", eventId), {
    status: "approved",
    approvedBy: adminUid,
    approvedAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
}
