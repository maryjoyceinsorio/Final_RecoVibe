import { signInWithEmailAndPassword, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  doc,
  getDoc,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { auth, authReady, db, isFirebaseConfigured } from "../UserStudent/firebaseConfig.js";

(() => {
  const emailInput = document.getElementById("login-email");
  const passwordInput = document.getElementById("login-pass");
  const loginButton = document.getElementById("login-submit");
  const banner = document.getElementById("login-banner");
  const profileCollections = ["adminUser", "users"];

  document
    .querySelector('.link-btn[href*="ForgetPassword"]')
    ?.setAttribute("href", "AdminForgetPassword.html");

  const setInvalid = (id, invalid) =>
    document.getElementById(id).classList.toggle("invalid", invalid);

  function clearStoredProfiles() {
    [
      "recovibeAdminProfile",
      "recovibeAdminId",
      "recovibeOrganizerProfile",
      "recovibeOrganizerId",
    ].forEach((key) => localStorage.removeItem(key));
  }

  function showError(message) {
    banner.textContent = message;
    banner.classList.add("show");
  }

  function authErrorMessage(error) {
    switch (error?.code) {
      case "auth/user-not-found":
      case "auth/wrong-password":
      case "auth/invalid-credential":
      case "auth/invalid-email":
        return "Incorrect email or password.";
      case "auth/too-many-requests":
        return "Too many sign-in attempts. Please try again later.";
      default:
        return "Unable to sign in right now. Please try again.";
    }
  }

  function normalizeRole(value) {
    return String(value || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "");
  }

  function resolveRole(profiles) {
    const priorities = [
      { role: "Super Admin", normalized: "superadmin" },
      { role: "Admin", normalized: "admin" },
      { role: "Event Organizer", normalized: "eventorganizer" },
      { role: "Student", normalized: "student" },
    ];
    for (const priority of priorities) {
      const profileRecord = profiles.find(
        (candidate) =>
          normalizeRole(candidate.data.role || candidate.data.userRole) ===
          priority.normalized,
      );
      if (profileRecord) return { ...profileRecord, resolvedRole: priority.role };
    }
    return profiles[0]
      ? {
          ...profiles[0],
          resolvedRole: String(
            profiles[0].data.role || profiles[0].data.userRole || "",
          ).trim(),
        }
      : null;
  }

  async function findProfile(uid) {
    const reads = await Promise.allSettled(
      profileCollections.map(async (collectionName) => {
        const profileSnapshot = await getDoc(doc(db, collectionName, uid));
        return profileSnapshot.exists()
          ? { collectionName, data: profileSnapshot.data() }
          : null;
      }),
    );
    const lookupErrors = reads
      .filter((read) => read.status === "rejected")
      .map((read) => read.reason);
    const profiles = reads
      .filter((read) => read.status === "fulfilled" && read.value)
      .map((read) => read.value);
    const resolution = resolveRole(profiles);
    if (resolution?.resolvedRole === "Super Admin") {
      console.info("[AdminLogin] Role resolution:", {
        uid,
        candidates: profiles.map((candidate) => ({
          col: candidate.collectionName,
          role: candidate.data.role,
        })),
        finalRole: "Super Admin",
      });
      return { ...resolution, candidates: profiles };
    }
    if (lookupErrors.length) {
      console.error("[AdminLogin] Could not verify all administrator profiles:", lookupErrors);
      throw lookupErrors[0];
    }
    if (resolution) return { ...resolution, candidates: profiles };

    const studentSnapshot = await getDoc(doc(db, "users", uid));
    if (!studentSnapshot.exists()) return null;
    const studentProfile = {
      collectionName: "users",
      data: studentSnapshot.data(),
    };
    return {
      ...resolveRole([studentProfile]),
      candidates: [studentProfile],
    };
  }

  function profileName(profile, email) {
    const nameParts = [profile.firstName, profile.middleName, profile.lastName]
      .map((part) => String(part || "").trim())
      .filter(Boolean);
    return (
      profile.fullName ||
      profile.name ||
      profile.displayName ||
      nameParts.join(" ") ||
      email.split("@")[0]
    );
  }

  async function handleSignIn() {
    const normalizedEmail = emailInput.value.trim().toLowerCase();
    const password = passwordInput.value;
    const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail);
    setInvalid("field-email", !validEmail);
    setInvalid("field-pass", !password);
    banner.classList.remove("show");

    if (!validEmail || !password) return;
    if (!isFirebaseConfigured || !auth || !db) {
      showError("Firebase authentication is unavailable. Please try again later.");
      return;
    }

    loginButton.disabled = true;
    loginButton.textContent = "Signing in...";
    clearStoredProfiles();
    let authenticated = false;

    try {
      await authReady;
      const credential = await signInWithEmailAndPassword(
        auth,
        normalizedEmail,
        password,
      );
      authenticated = true;
      const profileRecord = await findProfile(credential.user.uid);

      if (!profileRecord) {
        await signOut(auth);
        showError(
          `Your account signed in, but no profile was found for UID ${credential.user.uid}. Contact an administrator.`,
        );
        return;
      }

      const profile = profileRecord.data;
      if (String(profile.status || "").trim().toLowerCase() === "suspended") {
        await signOut(auth);
        showError("This account is suspended. Contact an administrator for help.");
        return;
      }

      const role = profileRecord.resolvedRole;
      const normalizedRole = normalizeRole(role);
      const name = profileName(profile, normalizedEmail);
      const authenticatedProfile = {
        ...profile,
        uid: credential.user.uid,
        name,
        email: normalizedEmail,
      };

      if (normalizedRole !== "superadmin") {
        try {
          const sys = JSON.parse(localStorage.getItem("recovibeSystemSettings") || "{}");
          if (sys && sys.loginEnabled === false) {
            await signOut(auth);
            clearStoredProfiles();
            showError("System maintenance is in progress. User login is temporarily disabled. Only super administrators can sign in at this time.");
            return;
          }
        } catch (_) {}
      }

      if (normalizedRole === "superadmin") {
        localStorage.setItem(
          "recovibeAdminProfile",
          JSON.stringify({ ...authenticatedProfile, role: "Super Admin" }),
        );
        localStorage.setItem("recovibeAdminId", normalizedEmail);
        window.location.assign("../UserSuperAdmin/SuperAdminDashboard.html");
        return;
      }

      if (normalizedRole === "admin") {
        localStorage.setItem(
          "recovibeAdminProfile",
          JSON.stringify({ ...authenticatedProfile, role: "Admin" }),
        );
        localStorage.setItem("recovibeAdminId", normalizedEmail);
        window.location.assign("AdminDashboard.html");
        return;
      }

      if (normalizedRole === "eventorganizer") {
        localStorage.setItem(
          "recovibeOrganizerProfile",
          JSON.stringify({ ...authenticatedProfile, role: "Event Organizer" }),
        );
        localStorage.setItem("recovibeOrganizerId", normalizedEmail);
        window.location.assign("../UserEventOrganizer/EventOrganizerDashBoard.html");
        return;
      }

      if (normalizedRole === "student") {
        localStorage.setItem(
          "recovibeCurrentUser",
          JSON.stringify({ ...authenticatedProfile, role: "Student" }),
        );
        window.location.assign("../UserStudent/Dashboard.html");
        return;
      }

      await signOut(auth);
      showError(
        `This account is authenticated but its role (${role || "not set"}) cannot access this portal.`,
      );
    } catch (error) {
      if (authenticated) {
        try {
          await signOut(auth);
        } catch (signOutError) {
          console.error("[AdminLogin] Unable to clear unverified Auth session:", signOutError);
        }
      }
      console.error("[AdminLogin] Firebase sign-in/profile lookup failed:", {
        code: error?.code || "unknown",
        message: error?.message || String(error),
      });
      if (error?.code?.startsWith("auth/")) {
        showError(authErrorMessage(error));
      } else {
        showError(
          "Sign-in succeeded, but the account profile could not be verified. Check the Firestore rules and try again.",
        );
      }
    } finally {
      loginButton.disabled = false;
      loginButton.textContent = "Sign in";
    }
  }

  loginButton.addEventListener("click", handleSignIn);
  passwordInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") handleSignIn();
  });
  document.getElementById("pass-toggle").addEventListener("click", function () {
    const visible = passwordInput.type === "password";
    passwordInput.type = visible ? "text" : "password";
    this.setAttribute("aria-label", visible ? "Hide password" : "Show password");
    this.setAttribute("aria-pressed", String(visible));
  });
})();
