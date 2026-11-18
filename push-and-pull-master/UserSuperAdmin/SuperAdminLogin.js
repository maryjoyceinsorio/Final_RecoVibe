import {
  browserLocalPersistence,
  browserSessionPersistence,
  setPersistence,
  signInWithEmailAndPassword,
  signOut,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { auth, authReady, db, isFirebaseConfigured } from "../UserStudent/firebaseConfig.js";

(() => {
  const emailInput = document.getElementById("login-email");
  const passwordInput = document.getElementById("login-pass");
  const loginButton = document.getElementById("login-submit");
  const banner = document.getElementById("login-banner");
  const rememberMe = document.getElementById("remember-me");
  const rememberedEmailKey = "rememberedEmail_super_admin";
  let signInVerified = false;
  const setInvalid = (id, invalid) =>
    document.getElementById(id).classList.toggle("invalid", invalid);

  function clearRememberedEmail() {
    try {
      localStorage.removeItem(rememberedEmailKey);
    } catch (error) {
      console.warn("[SuperAdminLogin] Could not clear remembered email:", error?.code || "unknown");
    }
  }

  function saveRememberedEmail(email) {
    if (!rememberMe.checked) {
      clearRememberedEmail();
      return;
    }
    try {
      localStorage.setItem(rememberedEmailKey, email);
    } catch (error) {
      console.warn("[SuperAdminLogin] Could not save remembered email:", error?.code || "unknown");
    }
  }

  try {
    const rememberedEmail = localStorage.getItem(rememberedEmailKey);
    if (rememberedEmail) {
      emailInput.value = rememberedEmail;
      rememberMe.checked = true;
    }
  } catch (error) {
    console.warn("[SuperAdminLogin] Could not read remembered email:", error?.code || "unknown");
  }
  rememberMe.addEventListener("change", () => {
    if (!rememberMe.checked) clearRememberedEmail();
  });

  async function handleSignIn() {
    const email = emailInput.value.trim().toLowerCase();
    const password = passwordInput.value;
    const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    setInvalid("field-email", !validEmail);
    setInvalid("field-pass", !password);
    banner.classList.remove("show");
    if (!validEmail || !password) {
      clearRememberedEmail();
      return;
    }

    if (!isFirebaseConfigured || !auth || !db) {
      clearRememberedEmail();
      banner.textContent = "Sign in is unavailable. Please contact support.";
      banner.classList.add("show");
      return;
    }

    loginButton.disabled = true;
    loginButton.textContent = "Signing in...";
    let authenticated = false;
    try {
      await authReady;
      try {
        await setPersistence(
          auth,
          rememberMe.checked ? browserLocalPersistence : browserSessionPersistence,
        );
      } catch (persistenceError) {
        console.warn(
          "[SuperAdminLogin] Could not set auth persistence; using the default:",
          persistenceError?.code || "unknown",
        );
      }
      const credential = await signInWithEmailAndPassword(auth, email, password);
      authenticated = true;
      let profileSnapshot = await getDoc(doc(db, "adminUser", credential.user.uid));
      if (!profileSnapshot.exists()) {
        profileSnapshot = await getDoc(doc(db, "users", credential.user.uid));
      }
      if (!profileSnapshot.exists()) {
        throw Object.assign(new Error("Super administrator profile was not found."), {
          code: "profile/not-found",
        });
      }

      const profile = profileSnapshot.data();
      const role = String(profile.role || profile.userRole || "")
        .trim()
        .toLowerCase()
        .replace(/\s+/g, "");
      if (role !== "superadmin") {
        throw Object.assign(new Error("Account is not a super administrator."), {
          code: "profile/role-mismatch",
        });
      }

      const authenticatedProfile = {
        ...profile,
        uid: credential.user.uid,
        email: credential.user.email || email,
        role: "Super Admin",
      };
      localStorage.setItem(
        "recovibeAdminProfile",
        JSON.stringify(authenticatedProfile),
      );
      localStorage.setItem("recovibeAdminId", email);
      saveRememberedEmail(email);
      signInVerified = true;
      window.location.assign("SuperAdminDashboard.html");
    } catch (error) {
      if (authenticated) {
        try {
          await signOut(auth);
        } catch (signOutError) {
          console.error("[SuperAdminLogin] Unable to clear unverified session:", {
            code: signOutError?.code || "unknown",
            message: signOutError?.message || String(signOutError),
          });
        }
      }
      console.error("[SuperAdminLogin] Sign-in/profile verification failed:", {
        code: error?.code || "unknown",
        message: error?.message || String(error),
      });
      banner.textContent =
        error?.code?.startsWith("auth/")
          ? ["auth/invalid-credential", "auth/wrong-password", "auth/user-not-found"].includes(error.code)
            ? "Incorrect email or password."
            : "Unable to sign in right now. Please try again."
          : "Your account could not be verified for the super administrator portal.";
      banner.classList.add("show");
    } finally {
      if (!signInVerified) clearRememberedEmail();
      loginButton.disabled = false;
      loginButton.textContent = "Sign in";
    }
  }

  loginButton.addEventListener("click", handleSignIn);
  passwordInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") handleSignIn();
  });
  const passwordToggle = document.getElementById("pass-toggle");
  let passwordVisible = false;
  let inputHadFocus = false;
  let selectionStart = null;
  let selectionEnd = null;
  let selectionDirection = "none";

  passwordInput.addEventListener("blur", () => {
    selectionStart = passwordInput.selectionStart;
    selectionEnd = passwordInput.selectionEnd;
    selectionDirection = passwordInput.selectionDirection;
  });
  passwordToggle.addEventListener("mousedown", (event) => {
    inputHadFocus = document.activeElement === passwordInput;
    selectionStart = passwordInput.selectionStart;
    selectionEnd = passwordInput.selectionEnd;
    selectionDirection = passwordInput.selectionDirection;
    if (inputHadFocus) event.preventDefault();
  });
  passwordToggle.addEventListener("click", () => {
    const restoreFocus = inputHadFocus;
    inputHadFocus = false;
    if (selectionStart === null || selectionEnd === null) {
      selectionStart = passwordInput.selectionStart;
      selectionEnd = passwordInput.selectionEnd;
      selectionDirection = passwordInput.selectionDirection;
    }
    passwordVisible = !passwordVisible;
    passwordInput.type = passwordVisible ? "text" : "password";
    passwordToggle.classList.toggle("is-visible", passwordVisible);
    passwordToggle.setAttribute("aria-label", passwordVisible ? "Hide password" : "Show password");
    passwordToggle.setAttribute("aria-pressed", String(passwordVisible));
    requestAnimationFrame(() => {
      if (restoreFocus) passwordInput.focus({ preventScroll: true });
      if (selectionStart !== null && selectionEnd !== null) {
        passwordInput.setSelectionRange(selectionStart, selectionEnd, selectionDirection);
      }
    });
  });
})();
