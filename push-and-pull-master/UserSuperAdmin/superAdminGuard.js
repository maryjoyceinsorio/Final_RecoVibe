import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { auth, db, isFirebaseConfigured } from "../UserStudent/firebaseConfig.js";

(() => {
  "use strict";

  function normalizedRole(profile) {
    return String(profile?.role || profile?.userRole || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "");
  }

  async function inspectProfiles(user) {
    const collections = ["users", "adminUser"];
    const results = await Promise.allSettled(
      collections.map(async (collectionName) => {
        const snapshot = await getDoc(doc(db, collectionName, user.uid));
        return snapshot.exists()
          ? {
              collectionName,
              documentId: snapshot.id,
              data: snapshot.data(),
            }
          : null;
      }),
    );
    const profiles = results
      .filter((result) => result.status === "fulfilled" && result.value)
      .map((result) => result.value);
    const readErrors = results
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason);
    const priorities = ["superadmin", "admin", "eventorganizer", "student"];
    const selectedProfile = priorities
      .map((priority) =>
        profiles.find((candidate) => normalizedRole(candidate.data) === priority),
      )
      .find(Boolean);

    console.info("[SuperAdminGuard] Profile diagnostics:", {
      uid: user.uid,
      email: user.email || "(no email)",
      profiles: profiles.map((profile) => ({
        path: `${profile.collectionName}/${profile.documentId}`,
        claims: profile.data,
        role: profile.data.role,
        userRole: profile.data.userRole,
      })),
      resolvedRole: selectedProfile
        ? selectedProfile.data.role || selectedProfile.data.userRole || ""
        : "(no matching profile)",
      readErrors,
    });

    if (selectedProfile) {
      const profile = selectedProfile.data;
      const fullName = [profile.firstName, profile.middleName, profile.lastName]
        .filter(Boolean)
        .join(" ") || profile.name || profile.fullName || user.displayName || "Super Admin";
      document.querySelectorAll("#sidebar-user-name").forEach((element) => { element.textContent = fullName; });
      document.querySelectorAll("#sidebar-user-avatar").forEach((element) => { element.textContent = fullName.charAt(0).toUpperCase() || "S"; });
      document.querySelectorAll("#sidebar-user-role").forEach((element) => { element.textContent = "Super Admin account"; });
      window.dispatchEvent(
        new CustomEvent("superadmin-profile-authorized", {
          detail: {
            user,
            profile: selectedProfile.data,
            collectionName: selectedProfile.collectionName,
            documentId: selectedProfile.documentId,
          },
        }),
      );
    }
  }

  document.querySelectorAll(".logout-link").forEach((logoutLink) => {
    logoutLink.addEventListener("click", async (event) => {
      event.preventDefault();
      try {
        if (auth) await signOut(auth);
        console.info("[SuperAdminGuard] Logout completed; redirect suppressed in diagnostic mode.");
      } catch (error) {
        console.info("[SuperAdminGuard] Logout diagnostic:", error);
      }
    });
  });

  try {
    const savedProfile = JSON.parse(localStorage.getItem("recovibeAdminProfile") || "null");
    if (savedProfile) {
      const fullName = [savedProfile.firstName, savedProfile.middleName, savedProfile.lastName]
        .filter(Boolean)
        .join(" ") || savedProfile.name || savedProfile.fullName || "Super Admin";
      document.querySelectorAll("#sidebar-user-name").forEach((element) => { element.textContent = fullName; });
      document.querySelectorAll("#sidebar-user-avatar").forEach((element) => { element.textContent = fullName.charAt(0).toUpperCase() || "S"; });
      document.querySelectorAll("#sidebar-user-role").forEach((element) => { element.textContent = "Super Admin account"; });
    }
  } catch (error) {
    console.info("[SuperAdminGuard] Sidebar profile unavailable.");
  }

  if (!isFirebaseConfigured || !auth || !db) {
    console.info("[SuperAdminGuard] Firebase is unavailable; dashboard remains mounted.");
    return;
  }

  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      console.info("[SuperAdminGuard] No authenticated user; redirect suppressed in diagnostic mode.");
      return;
    }

    console.info("[SuperAdminGuard] Auth state:", {
      uid: user.uid,
      email: user.email || "(no email)",
    });
    try {
      await inspectProfiles(user);
    } catch (error) {
      console.info("[SuperAdminGuard] Profile inspection diagnostic:", error);
    }
  });
})();
