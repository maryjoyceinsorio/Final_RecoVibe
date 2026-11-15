import {
  browserLocalPersistence,
  browserSessionPersistence,
  setPersistence,
  signInWithEmailAndPassword,
  signOut,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  query,
  where,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { auth, authReady, db, isFirebaseConfigured } from "./firebaseConfig.js";
import { clearCachedStudentProfile, loadStudentProfile } from "./studentIdentity.js";

const studentNumberInput = document.getElementById("student-number");
const passwordInput = document.getElementById("student-pass");
const submitButton = document.getElementById("login-submit");
const rememberMe = document.getElementById("remember-me");
const rememberMessage = document.getElementById("remember-message");
const studentNumberPattern = /^(\d{4})-(\d{5})-BN-([01])$/;
let studentNumberValidationShown = false;
let studentNumberPasteError = "";

function setInvalid(fieldId, invalid, message = "") {
  const field = document.getElementById(fieldId);
  field.classList.toggle("invalid", invalid);
  const error = field.querySelector(".error-msg");
  if (error) error.textContent = message;
}

function normalizeStudentNumber(value) {
  return String(value || "")
    .replace(/\s/g, "")
    .toUpperCase()
    .replace(/[^0-9BN-]/g, "")
    .slice(0, 16);
}

function studentNumberValidationMessage(value) {
  const normalized = String(value || "").trim().toUpperCase();
  if (!normalized) return "Student number is required.";
  const parts = /^(\d{4})-(\d{5})-([A-Z]{2})-(\d+)$/.exec(normalized);
  if (!parts) return "Student number must follow the format 2025-12345-BN-0.";
  const year = Number(parts[1]);
  const currentYear = new Date().getFullYear();
  if (year < 2000 || year > currentYear) {
    return `Enter a valid year in the first 4 digits (2000 to ${currentYear}).`;
  }
  if (parts[2] === "00000") return "Enter a valid 5-digit student number.";
  if (parts[3] !== "BN") return "Campus code must be BN (PUP Biñan).";
  if (!/^[01]$/.test(parts[4])) return "The last digit must be 0 or 1.";
  return studentNumberPattern.test(normalized)
    ? ""
    : "Student number must follow the format 2025-12345-BN-0.";
}

function setStudentNumberError(message) {
  setInvalid("field-student-number", Boolean(message), message);
  if (message) studentNumberInput.setAttribute("aria-invalid", "true");
  else studentNumberInput.removeAttribute("aria-invalid");
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
    case "student/profile-mismatch":
      return "Incorrect student number or password.";
    case "auth/too-many-requests":
      return "Too many sign-in attempts. Please wait and try again.";
    default:
      return "Unable to sign in right now. Please try again.";
  }
}

async function signIn() {
  if (submitButton.disabled) return;
  studentNumberValidationShown = true;
  const studentNumber = normalizeStudentNumber(studentNumberInput.value);
  studentNumberInput.value = studentNumber;
  const password = passwordInput.value;
  const banner = document.getElementById("login-banner");
  const studentNumberError = studentNumberPasteError ||
    studentNumberValidationMessage(studentNumber);
  const passwordError = password ? "" : "Password is required.";

  setStudentNumberError(studentNumberError);
  setInvalid("field-pass", Boolean(passwordError), passwordError);
  banner.classList.remove("show");
  if (studentNumberError || passwordError) {
    if (studentNumberError) studentNumberInput.focus();
    else passwordInput.focus();
    return;
  }

  if (!isFirebaseConfigured || !auth || !db) {
    setStudentNumberError("Unable to sign in right now. Please try again.");
    passwordInput.value = "";
    return;
  }

  submitButton.disabled = true;
  submitButton.setAttribute("aria-busy", "true");

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
      }
    }
    if (!loginAllowed) {
      showBanner("System maintenance is in progress. Student sign-in is temporarily disabled. Only super administrators can sign in at this time.");
      return;
    }

    await authReady;
    if (auth.currentUser) await signOut(auth);
    const matches = await getDocs(
      query(
        collection(db, "users"),
        where("studentNumber", "==", studentNumber),
        limit(1),
      ),
    );
    if (!matches.size) {
      setStudentNumberError("Incorrect student number or password.");
      passwordInput.value = "";
      studentNumberInput.focus();
      return;
    }
    const matchingUser = matches.docs[0];
    const email = String(matchingUser.get("email") || "").trim().toLowerCase();
    const role = String(matchingUser.get("role") || "").trim().toLowerCase();
    if (!email || role !== "student") {
      setStudentNumberError("Incorrect student number or password.");
      passwordInput.value = "";
      studentNumberInput.focus();
      return;
    }

    await setPersistence(auth, rememberMe.checked ? browserLocalPersistence : browserSessionPersistence);
    const credential = await signInWithEmailAndPassword(auth, email, password);
    const profile = await loadStudentProfile(credential.user, {
      storage: rememberMe.checked ? "local" : "session",
      createIfMissing: true,
    });
    const profileRole = String(profile.role || "").trim().toLowerCase();
    if (
      String(profile.email || "").trim().toLowerCase() !==
        String(credential.user.email || email).trim().toLowerCase() ||
      (profile.uid && profile.uid !== credential.user.uid) ||
      (profileRole && profileRole !== "student")
    ) {
      await signOut(auth);
      clearCachedStudentProfile();
      throw Object.assign(new Error("Student profile identity mismatch."), {
        code: "student/profile-mismatch",
      });
    }
    window.location.assign("Dashboard.html");
  } catch (error) {
    if (auth.currentUser) {
      try {
        await signOut(auth);
      } catch (signOutError) {
        console.warn("[StudentLogin] Could not clear failed sign-in:", signOutError?.code || "unknown");
      }
    }
    clearCachedStudentProfile();
    setStudentNumberError(loginErrorMessage(error));
    passwordInput.value = "";
    studentNumberInput.focus();
  } finally {
    submitButton.disabled = false;
    submitButton.removeAttribute("aria-busy");
  }
}

document.getElementById("student-login-form").addEventListener("submit", (event) => {
  event.preventDefault();
  signIn();
});
studentNumberInput.addEventListener("input", () => {
  studentNumberPasteError = "";
  const start = studentNumberInput.selectionStart ?? studentNumberInput.value.length;
  const end = studentNumberInput.selectionEnd ?? start;
  const rawValue = studentNumberInput.value;
  const value = normalizeStudentNumber(rawValue);
  if (rawValue !== value) {
    studentNumberInput.value = value;
    studentNumberInput.setSelectionRange(
      normalizeStudentNumber(rawValue.slice(0, start)).length,
      normalizeStudentNumber(rawValue.slice(0, end)).length,
    );
  }
  if (studentNumberValidationShown) {
    setStudentNumberError(studentNumberValidationMessage(value));
  }
});
studentNumberInput.addEventListener("blur", () => {
  studentNumberValidationShown = true;
  const value = normalizeStudentNumber(studentNumberInput.value);
  studentNumberInput.value = value;
  setStudentNumberError(
    studentNumberPasteError || studentNumberValidationMessage(value),
  );
});
studentNumberInput.addEventListener("paste", (event) => {
  event.preventDefault();
  studentNumberValidationShown = true;
  const pasted = String(event.clipboardData?.getData("text") || "")
    .trim()
    .toUpperCase()
    .replace(/\s/g, "");
  const message = studentNumberValidationMessage(pasted);
  if (message) {
    studentNumberPasteError = message;
    setStudentNumberError(message);
    return;
  }
  studentNumberPasteError = "";
  const start = studentNumberInput.selectionStart ?? studentNumberInput.value.length;
  const end = studentNumberInput.selectionEnd ?? start;
  const value = normalizeStudentNumber(studentNumberInput.value);
  studentNumberInput.value = normalizeStudentNumber(
    value.slice(0, start) + pasted + value.slice(end),
  );
  const caret = Math.min(start + pasted.length, studentNumberInput.value.length);
  studentNumberInput.setSelectionRange(caret, caret);
  setStudentNumberError(studentNumberValidationMessage(studentNumberInput.value));
});
passwordInput.addEventListener("input", () => {
  if (document.getElementById("field-pass").classList.contains("invalid")) {
    const message = passwordInput.value ? "" : "Password is required.";
    setInvalid("field-pass", Boolean(message), message);
  }
});
passwordInput.addEventListener("blur", () => {
  const message = passwordInput.value ? "" : "Password is required.";
  setInvalid("field-pass", Boolean(message), message);
});
rememberMe.addEventListener("change", () => {
  rememberMessage.hidden = !rememberMe.checked;
});
rememberMessage.hidden = !rememberMe.checked;

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
