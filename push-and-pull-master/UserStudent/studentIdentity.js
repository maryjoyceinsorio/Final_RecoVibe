import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  query,
  where,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { auth, db } from "./firebaseConfig.js";

const currentUserStorageKey = "recovibeCurrentUser";

function normalizedEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function readStoredProfile(email) {
  for (const storage of [localStorage, sessionStorage]) {
    try {
      const value = JSON.parse(storage.getItem(currentUserStorageKey) || "null");
      if (
        value &&
        typeof value === "object" &&
        normalizedEmail(value.email) === normalizedEmail(email)
      ) return value;
    } catch (error) {
      console.warn("[Student Identity] Could not read cached profile:", error);
    }
  }
  return null;
}

export function clearCachedStudentProfile() {
  localStorage.removeItem(currentUserStorageKey);
  sessionStorage.removeItem(currentUserStorageKey);
}

function cacheStudentProfile(uid, profile, preferredStorage) {
  const cached = {
    ...profile,
    uid,
  };
  const storage = preferredStorage === "session"
    ? sessionStorage
    : preferredStorage === "local"
      ? localStorage
      : localStorage.getItem(currentUserStorageKey)
        ? localStorage
        : sessionStorage.getItem(currentUserStorageKey)
          ? sessionStorage
          : localStorage;
  clearCachedStudentProfile();
  storage.setItem(currentUserStorageKey, JSON.stringify(cached));
}

export async function loadStudentProfile(user, { storage, createIfMissing = false } = {}) {
  if (!user?.uid || !db) throw new Error("A signed-in student and Firestore are required.");
  if (auth?.currentUser?.uid !== user.uid) {
    throw new Error("The authenticated student changed before their profile could be loaded.");
  }

  const profileRef = doc(db, "users", user.uid);
  const profileSnapshot = await getDoc(profileRef);
  let profile = profileSnapshot.exists() ? profileSnapshot.data() : null;

  if (profile && profile.uid && profile.uid !== user.uid) {
    throw new Error("The profile document UID does not match the authenticated user.");
  }
  if (
    profile &&
    normalizedEmail(profile.email) &&
    normalizedEmail(user.email) &&
    normalizedEmail(profile.email) !== normalizedEmail(user.email)
  ) {
    throw new Error("The profile email does not match the authenticated user.");
  }

  if (!profile && normalizedEmail(user.email)) {
    const emailQuery = query(
      collection(db, "users"),
      where("email", "==", normalizedEmail(user.email)),
      limit(2),
    );
    const matches = await getDocs(emailQuery);
    if (matches.size > 1) {
      throw new Error("More than one student profile matches this authenticated email.");
    }
    if (matches.size === 1) {
      profile = matches.docs[0].data();
    }
  }

  if (!profile) {
    const cached = readStoredProfile(user.email);
    if (cached) {
      profile = cached;
    }
  }

  if (!profile) {
    if (!createIfMissing) {
      throw new Error("No student profile matches this authenticated account.");
    }
    profile = {
      email: user.email || "",
      fullName: user.displayName || "",
      name: user.displayName || "",
      role: "student",
      status: "Active",
    };
  }

  const role = String(profile.role || profile.userRole || "").trim().toLowerCase();
  if (role !== "student") {
    throw new Error(`The authenticated account is not a student profile (role: ${role}).`);
  }

  const canonicalProfile = {
    ...profile,
    uid: user.uid,
    email: profile.email || user.email || "",
  };
  if (auth?.currentUser?.uid !== user.uid) {
    throw new Error("The authenticated student changed while their profile was being saved.");
  }
  cacheStudentProfile(user.uid, canonicalProfile, storage);
  return canonicalProfile;
}

export function renderStudentSidebar(profile = {}) {
  const fullName = String(
    profile.fullName ||
      profile.name ||
      [profile.firstName, profile.middleName, profile.lastName]
        .filter(Boolean)
        .join(" ") ||
      "",
  ).trim();
  const nameParts = fullName.split(/\s+/).filter(Boolean);
  const firstName = String(profile.firstName || nameParts[0] || "");
  const initials = [
    firstName,
    profile.lastName || (nameParts.length > 1 ? nameParts[nameParts.length - 1] : ""),
  ]
    .filter(Boolean)
    .map((part) => Array.from(String(part))[0]?.toLocaleUpperCase() || "")
    .join("");
  const program = String(
    profile.program ||
      profile.course ||
      profile.department ||
      profile.departmentCode ||
      "",
  ).trim();
  const studentNumber = String(
    profile.studentNumber || profile.studentNo || profile.studentId || "",
  ).trim();
  const subtitle = [program, studentNumber].filter(Boolean).join(" · ");
  document.querySelectorAll(".user-name, #userName").forEach((element) => {
    element.textContent = fullName;
  });
  document.querySelectorAll(".user-role, #userRole").forEach((element) => {
    element.textContent = subtitle;
  });
  document.querySelectorAll(".avatar, #userAvatar").forEach((element) => {
    element.textContent = initials;
  });
  document.querySelectorAll("#userFirstName").forEach((element) => {
    element.textContent = firstName;
  });
  const greeting = document.getElementById("dashboardGreeting");
  if (greeting) {
    const hour = new Date().getHours();
    const salutation = hour < 12 ? "Good Morning" : hour < 18 ? "Good Afternoon" : "Good Evening";
    greeting.textContent = `${salutation}${firstName ? `, ${firstName}` : ""}`;
  }
}
