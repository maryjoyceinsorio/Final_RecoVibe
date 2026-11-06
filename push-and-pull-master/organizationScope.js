import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { auth, db } from "./UserStudent/firebaseConfig.js";
import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js";

function normalizeOrganizationCode(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toUpperCase();
}

function isOrganizerRole(value) {
  return ["eventorganizer", "organizer", "eo"].includes(
    String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, ""),
  );
}

async function getOrganizerOrganizationFromProfile() {
  const uid = auth?.currentUser?.uid;
  if (!db || !uid) {
    throw new Error("Sign in before loading organization events.");
  }

  const reads = await Promise.allSettled([
    getDoc(doc(db, "adminUser", uid)),
    getDoc(doc(db, "users", uid)),
    getDoc(doc(db, "eventOrganizations", uid)),
  ]);
  const profiles = reads.slice(0, 2)
    .filter((result) => result.status === "fulfilled" && result.value.exists())
    .map((result) => result.value.data());
  const organizerProfile = profiles.find((profile) =>
    isOrganizerRole(profile.role || profile.userRole),
  );
  const organizationSnapshot = reads[2];
  const organizationRecord = organizationSnapshot.status === "fulfilled" &&
    organizationSnapshot.value.exists()
    ? organizationSnapshot.value.data()
    : {};
  const hasConflictingRole = profiles.some((profile) =>
    String(profile.role || profile.userRole || "").trim(),
  );

  if (!organizerProfile && (hasConflictingRole || !organizationRecord.organizationCode)) {
    const readError = reads.find((result) => result.status === "rejected")?.reason;
    if (readError) throw readError;
    throw new Error("Your organizer account does not have a verified organization.");
  }

  const profile = organizerProfile || organizationRecord;
  const organizationCode = normalizeOrganizationCode(
    organizationRecord.organizationCode ||
    profile.organizationCode ||
    profile.orgCode ||
    profile.organization ||
    profile.organizationName ||
    profile.orgName,
  );
  if (!organizationCode) {
    throw new Error("Your organizer profile must have an organization assigned.");
  }
  return organizationCode;
}

export async function syncOrganizerOrganization(functions) {
  if (functions) {
    try {
      const result = await httpsCallable(functions, "syncOrganizerOrganization")({});
      const organizationCode = normalizeOrganizationCode(result.data?.organizationCode);
      if (organizationCode) return organizationCode;
      console.warn("Organizer organization callable returned no organization code; using the verified profile.");
    } catch (error) {
      console.warn("Organizer organization callable unavailable; using the verified profile:", error);
    }
  }
  return getOrganizerOrganizationFromProfile();
}

export async function syncApproverOrganization(functions) {
  if (!functions) {
    throw new Error("Approval organization verification is unavailable.");
  }
  const result = await httpsCallable(functions, "syncApproverOrganization")({});
  const organizationCode = String(result.data?.organizationCode || "")
    .trim()
    .replace(/\s+/g, " ")
    .toUpperCase();
  if (!organizationCode) {
    throw new Error("Your approval role does not have an organization assigned.");
  }
  return organizationCode;
}
