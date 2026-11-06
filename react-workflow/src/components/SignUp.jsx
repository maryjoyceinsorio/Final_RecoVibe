import { useState } from "react";
import { createUserWithEmailAndPassword, deleteUser, updateProfile } from "firebase/auth";
import { doc, serverTimestamp, setDoc } from "firebase/firestore";
import { Link, useNavigate } from "react-router-dom";
import { auth, db, ensureAuthPersistence } from "../../../firebase.js";
import { useAuth } from "../auth/AuthProvider.jsx";

export default function SignUp() {
  const navigate = useNavigate();
  const { refreshProfile } = useAuth();
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState("user");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function handleSubmit(event) {
    event.preventDefault();
    setError("");
    setSaving(true);
    let createdUser = null;
    let profileSaved = false;

    try {
      await ensureAuthPersistence();
      const normalizedEmail = email.trim().toLowerCase();
      createdUser = (
        await createUserWithEmailAndPassword(auth, normalizedEmail, password)
      ).user;
      await updateProfile(createdUser, { displayName: displayName.trim() });
      await setDoc(doc(db, "users", createdUser.uid), {
        displayName: displayName.trim(),
        email: createdUser.email,
        role,
        createdAt: serverTimestamp(),
      });
      profileSaved = true;
      await refreshProfile();
      navigate("/");
    } catch (submitError) {
      let cleanupFailed = false;
      if (createdUser && !profileSaved) {
        try {
          await deleteUser(createdUser);
        } catch (cleanupError) {
          cleanupFailed = true;
          console.error("[SignUp] Could not remove Auth account after profile failure:", {
            code: cleanupError?.code || "unknown",
            message: cleanupError?.message || String(cleanupError),
            uid: createdUser.uid,
          });
        }
      }
      console.error("[SignUp] Account/profile creation failed:", {
        code: submitError?.code || "unknown",
        message: submitError?.message || String(submitError),
      });
      setError(
        cleanupFailed
          ? `Could not save your Firestore profile, and Firebase could not remove the newly created Auth account. Contact an administrator before retrying. (${submitError.message})`
          : submitError.message || "Could not create your account.",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="form-card narrow-card">
      <p className="eyebrow">Join the community</p>
      <h1>Create your account</h1>
      <p className="muted">Choose a regular account or organizer account. Admin access is assigned separately.</p>
      <form className="stack-form" onSubmit={handleSubmit}>
        <label>
          Name
          <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} required maxLength={100} />
        </label>
        <label>
          Email
          <input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
        </label>
        <label>
          Password
          <input type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} required minLength={6} />
        </label>
        <label>
          Account type
          <select value={role} onChange={(event) => setRole(event.target.value)}>
            <option value="user">Regular user</option>
            <option value="organizer">Event organizer</option>
          </select>
        </label>
        {error && <p className="notice error" role="alert">{error}</p>}
        <button className="primary-button" disabled={saving} type="submit">
          {saving ? "Creating account…" : "Create account"}
        </button>
      </form>
      <p className="form-footnote">Already registered? <Link to="/signin">Sign in</Link></p>
    </section>
  );
}
