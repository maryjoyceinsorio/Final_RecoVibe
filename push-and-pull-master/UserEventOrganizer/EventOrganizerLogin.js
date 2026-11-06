import { signInWithEmailAndPassword, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { auth, authReady, db, isFirebaseConfigured } from "../UserStudent/firebaseConfig.js";

(() => {
  document
    .querySelector('.link-btn[href*="ForgetPassword"]')
    ?.setAttribute("href", "EventOrganizerForgetPassword.html");
  const emailInput = document.getElementById("login-email");
  const passwordInput = document.getElementById("login-pass");
  const loginButton = document.getElementById("login-submit");
  const banner = document.getElementById("login-banner");
  const setInvalid = (id, invalid) =>
    document.getElementById(id).classList.toggle("invalid", invalid);
  let signingIn = false;

  function normalizeRole(value) {
    return String(value || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "");
  }

  async function findOrganizerProfile(uid) {
    const reads = await Promise.allSettled([
      getDoc(doc(db, "adminUser", uid)),
      getDoc(doc(db, "users", uid)),
      getDoc(doc(db, "eventOrganizations", uid)),
    ]);
    const errors = reads
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason);
    const profiles = reads
      .slice(0, 2)
      .filter((result) => result.status === "fulfilled" && result.value.exists())
      .map((result) => result.value.data());
    const organizerProfile = profiles.find((profile) =>
      ["eventorganizer", "organizer", "eo"].includes(
        normalizeRole(profile.role || profile.userRole),
      ),
    );
    if (organizerProfile) return organizerProfile;

    const organizationSnapshot = reads[2];
    const hasOrganizationScope =
      organizationSnapshot.status === "fulfilled" &&
      organizationSnapshot.value.exists() &&
      Boolean(
        String(organizationSnapshot.value.data()?.organizationCode || "").trim(),
      );
    const hasConflictingRole = profiles.some((profile) =>
      normalizeRole(profile.role || profile.userRole),
    );
    if (hasOrganizationScope && !hasConflictingRole) {
      return {
        ...(profiles[0] || {}),
        ...organizationSnapshot.value.data(),
        role: "Event Organizer",
      };
    }

    if (errors.length) throw errors[0];
    if (profiles.length) {
      throw Object.assign(new Error("Account is not an organizer account."), {
        code: "profile/role-mismatch",
      });
    }
    throw Object.assign(new Error("Organizer profile was not found."), {
      code: "profile/not-found",
    });
  }

  async function handleSignIn() {
    if (signingIn) return;
    const email = emailInput.value.trim().toLowerCase();
    const password = passwordInput.value;
    const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    setInvalid("field-email", !validEmail);
    setInvalid("field-pass", !password);
    banner.classList.remove("show");
    if (!validEmail || !password) return;

    if (!isFirebaseConfigured || !auth || !db) {
      banner.textContent = "Sign in is unavailable. Please contact support.";
      banner.classList.add("show");
      return;
    }

    try {
      const settings = JSON.parse(
        localStorage.getItem("recovibeSystemSettings") || "{}",
      );
      if (settings.loginEnabled === false) {
        banner.textContent =
          "System maintenance is in progress. Organizer sign-in is temporarily disabled.";
        banner.classList.add("show");
        return;
      }
    } catch (error) {
      console.warn("[EventOrganizerLogin] Could not read cached settings:", {
        code: error?.code || "unknown",
        message: error?.message || String(error),
      });
    }

    loginButton.disabled = true;
    loginButton.textContent = "Signing in...";
    signingIn = true;
    let authenticated = false;
    try {
      await authReady;
      const credential = await signInWithEmailAndPassword(auth, email, password);
      authenticated = true;
      const profile = await findOrganizerProfile(credential.user.uid);

      const organizerProfile = {
        ...profile,
        uid: credential.user.uid,
        email: credential.user.email || email,
      };
      localStorage.setItem("recovibeOrganizerId", email);
      localStorage.setItem(
        "recovibeOrganizerProfile",
        JSON.stringify(organizerProfile),
      );
      window.location.assign("EventOrganizerDashBoard.html");
    } catch (error) {
      if (authenticated) {
        try {
          await signOut(auth);
        } catch (signOutError) {
          console.error("[EventOrganizerLogin] Unable to clear unverified session:", {
            code: signOutError?.code || "unknown",
            message: signOutError?.message || String(signOutError),
          });
        }
      }
      console.error("[EventOrganizerLogin] Sign-in/profile verification failed:", {
        code: error?.code || "unknown",
        message: error?.message || String(error),
      });
      if (
        ["auth/invalid-credential", "auth/user-not-found", "auth/wrong-password", "auth/invalid-email"].includes(
          error?.code,
        )
      ) {
        banner.textContent = "Incorrect email or password.";
      } else if (error?.code === "auth/too-many-requests") {
        banner.textContent = "Too many attempts. Please try again later.";
      } else if (
        error?.code === "auth/network-request-failed" ||
        error?.code === "unavailable" ||
        error?.code === "firestore/unavailable"
      ) {
        banner.textContent = "A network error prevented account verification. Check your connection and try again.";
      } else if (
        error?.code === "permission-denied" ||
        error?.code === "firestore/permission-denied"
      ) {
        banner.textContent = "Your account signed in, but its organizer profile could not be read. Ask an administrator to verify its profile access.";
      } else if (error?.code === "profile/not-found") {
        banner.textContent = "Your account signed in, but no organizer profile was found. Ask an administrator to verify your organizer account.";
      } else if (error?.code === "profile/role-mismatch") {
        banner.textContent = "This account is not assigned the Event Organizer role. Ask an administrator to check its role.";
      } else {
        banner.textContent =
          "Your account could not be verified for the organizer portal. Contact an administrator.";
      }
      banner.classList.add("show");
    } finally {
      signingIn = false;
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
