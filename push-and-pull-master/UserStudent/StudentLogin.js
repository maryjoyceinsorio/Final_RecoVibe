import {
  browserLocalPersistence,
  browserSessionPersistence,
  setPersistence,
  signInWithEmailAndPassword,
  signOut,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { auth, authReady, db, isFirebaseConfigured } from "./firebaseConfig.js";

const currentUserStorageKey = "recovibeCurrentUser";
const emailInput = document.getElementById("student-id");
const passwordInput = document.getElementById("student-pass");
const submitButton = document.getElementById("login-submit");
const rememberMe = document.getElementById("remember-me");
const rememberMessage = document.getElementById("remember-message");

function setInvalid(fieldId, invalid) {
  document.getElementById(fieldId).classList.toggle("invalid", invalid);
}

function showBanner(message) {
  const banner = document.getElementById("login-banner");
  banner.textContent = message;
  banner.classList.add("show");
}

function loginErrorMessage(error) {
  switch (error?.code) {
    case "auth/invalid-credential":
    case "auth/wrong-password":
    case "auth/user-not-found":
      return "Incorrect email or password.";
    case "auth/too-many-requests":
      return "Too many sign-in attempts. Please wait and try again.";
    case "auth/network-request-failed":
      return "A network error occurred. Check your connection and try again.";
    case "student/profile-mismatch":
      return "The signed-in account does not match this student profile. Please contact support.";
    case "permission-denied":
    case "firestore/permission-denied":
      return "Your account signed in, but its profile could not be loaded. Please contact support.";
    default:
      return "We couldn't sign you in right now. Please try again.";
  }
}

async function signIn() {
  const email = emailInput.value.trim().toLowerCase();
  const password = passwordInput.value;
  const banner = document.getElementById("login-banner");

  setInvalid("field-id", !email);
  setInvalid("field-pass", !password);
  banner.classList.remove("show");
  if (!email || !password) return;

  if (!isFirebaseConfigured || !auth || !db) {
    showBanner("Sign in is not configured. Please contact support.");
    return;
  }

  try {
    let loginAllowed = true;
    const cached = localStorage.getItem("recovibeSystemSettings");
    if (cached) {
      try {
        const parsed = JSON.parse(cached);
        if (parsed && parsed.loginEnabled === false) loginAllowed = false;
      } catch (_) {}
    }
    if (loginAllowed && db) {
      try {
        const snap = await getDoc(doc(db, "systemSettings", "default"));
        if (snap.exists() && snap.data()?.loginEnabled === false) {
          loginAllowed = false;
        }
      } catch (sysErr) {
        if (sysErr?.code !== "permission-denied" && sysErr?.code !== "firestore/permission-denied") {
          throw sysErr;
        }
        console.warn("System settings verification notice: permission denied; continuing with sign-in.", sysErr);
      }
    }
    if (!loginAllowed) {
      showBanner("System maintenance is in progress. Student sign-in is temporarily disabled. Only super administrators can sign in at this time.");
      return;
    }
  } catch (sysErr) {
    console.warn("System settings verification notice:", sysErr);
  }

  submitButton.disabled = true;
  submitButton.setAttribute("aria-busy", "true");

  try {
    await setPersistence(auth, rememberMe.checked ? browserLocalPersistence : browserSessionPersistence);
    await authReady;
    const credential = await signInWithEmailAndPassword(auth, email, password);
    const profileSnapshot = await getDoc(
      doc(db, "users", credential.user.uid),
    );

    if (!profileSnapshot.exists()) {
      await signOut(auth);
      throw new Error("No student profile is associated with this account.");
    }

    const profile = profileSnapshot.data();
    const profileRole = String(profile.role || "").trim().toLowerCase();
    if (
      String(profile.email || "").trim().toLowerCase() !==
        String(credential.user.email || email).trim().toLowerCase() ||
      (profile.uid && profile.uid !== credential.user.uid) ||
      (profileRole && profileRole !== "student")
    ) {
      await signOut(auth);
      throw Object.assign(new Error("Student profile identity mismatch."), {
        code: "student/profile-mismatch",
      });
    }
    const currentUser = {
      ...profile,
      uid: credential.user.uid,
      email: profile.email || credential.user.email || email,
      studentId: profile.studentNumber || profile.studentId || "",
    };
    const serializedUser = JSON.stringify(currentUser);
    localStorage.removeItem(currentUserStorageKey);
    sessionStorage.removeItem(currentUserStorageKey);
    (rememberMe.checked ? localStorage : sessionStorage).setItem(currentUserStorageKey, serializedUser);
    window.location.assign("Dashboard.html");
  } catch (error) {
    console.error("[StudentLogin] Sign-in/profile lookup failed:", {
      code: error?.code || "unknown",
      message: error?.message || String(error),
    });
    if (
      error?.code === "auth/invalid-credential" ||
      error?.code === "auth/wrong-password"
    ) {
      setInvalid("field-pass", true);
    }
    showBanner(loginErrorMessage(error));
  } finally {
    submitButton.disabled = false;
    submitButton.removeAttribute("aria-busy");
  }
}

submitButton.addEventListener("click", signIn);
rememberMe.addEventListener("change", () => {
  rememberMessage.hidden = !rememberMe.checked;
});
rememberMessage.hidden = !rememberMe.checked;
passwordInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    signIn();
  }
});

(function () {
  const toggle = document.getElementById("pass-toggle");
  const icon = document.getElementById("eye-icon");
  const eyeOpen =
    '<path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7Z"/><circle cx="12" cy="12" r="3"/>';
  const eyeClosed =
    '<path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a19.93 19.93 0 0 1 4.22-5.94M9.9 4.24A10.4 10.4 0 0 1 12 4c7 0 11 8 11 8a19.86 19.86 0 0 1-2.16 3.19M14.12 14.12a3 3 0 1 1-4.24-4.24"/><path d="M1 1l22 22"/>';

  toggle.addEventListener("click", function () {
    const isHidden = passwordInput.type === "password";
    passwordInput.type = isHidden ? "text" : "password";
    icon.innerHTML = isHidden ? eyeClosed : eyeOpen;
    toggle.setAttribute(
      "aria-label",
      isHidden ? "Hide password" : "Show password",
    );
    toggle.setAttribute("aria-pressed", String(isHidden));
  });
})();
