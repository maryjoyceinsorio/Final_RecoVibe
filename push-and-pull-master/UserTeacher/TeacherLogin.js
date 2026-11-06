import { signInWithEmailAndPassword, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { auth, authReady, db, isFirebaseConfigured } from "../UserStudent/firebaseConfig.js";

(() => {
  const emailInput = document.getElementById("login-email");
  const passwordInput = document.getElementById("login-pass");
  const banner = document.getElementById("login-banner");
  const loginButton = document.getElementById("login-submit");
  const setInvalid = (id, invalid) =>
    document.getElementById(id).classList.toggle("invalid", invalid);

  async function handleSignIn() {
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

    loginButton.disabled = true;
    loginButton.textContent = "Signing in...";
    let authenticated = false;
    try {
      await authReady;
      const credential = await signInWithEmailAndPassword(auth, email, password);
      authenticated = true;
      const profileSnapshot = await getDoc(
        doc(db, "adminUser", credential.user.uid),
      );
      if (!profileSnapshot.exists()) {
        throw Object.assign(new Error("Teacher profile was not found."), {
          code: "profile/not-found",
        });
      }

      const profile = profileSnapshot.data();
      if (
        String(profile.role || profile.userRole || "")
          .trim()
          .toLowerCase() !== "teacher"
      ) {
        throw Object.assign(new Error("Account is not a teacher account."), {
          code: "profile/role-mismatch",
        });
      }

      const teacher = {
        ...profile,
        uid: credential.user.uid,
        email: credential.user.email || email,
        name:
          profile.fullName ||
          profile.name ||
          [profile.firstName, profile.lastName].filter(Boolean).join(" ") ||
          email.split("@")[0],
      };
      localStorage.setItem("recovibeCurrentTeacher", JSON.stringify(teacher));
      localStorage.setItem("recovibeTeacherId", email);
      window.location.assign("TeacherDashBoard.html");
    } catch (error) {
      if (
        authenticated &&
        ["profile/not-found", "profile/role-mismatch"].includes(error?.code)
      ) {
        try {
          await signOut(auth);
        } catch (signOutError) {
          console.error("[TeacherLogin] Unable to clear unverified session:", {
            code: signOutError?.code || "unknown",
            message: signOutError?.message || String(signOutError),
          });
        }
      }
      console.error("[TeacherLogin] Sign-in/profile verification failed:", {
        code: error?.code || "unknown",
        message: error?.message || String(error),
      });
      banner.textContent =
        error?.code?.startsWith("auth/")
          ? ["auth/invalid-credential", "auth/wrong-password", "auth/user-not-found"].includes(error.code)
            ? "Incorrect email or password."
            : "Unable to sign in right now. Please try again."
          : ["unavailable", "firestore/unavailable", "auth/network-request-failed"].includes(error?.code)
            ? "A network error prevented account verification. Check your connection and try again."
            : "Your account could not be verified for the teacher portal. Contact an administrator.";
      banner.classList.add("show");
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
