import { useState } from "react";
import { signInWithEmailAndPassword } from "firebase/auth";
import { Link, useNavigate } from "react-router-dom";
import { auth, ensureAuthPersistence } from "../../../firebase.js";

export default function SignIn() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function handleSubmit(event) {
    event.preventDefault();
    setError("");
    setSaving(true);
    try {
      await ensureAuthPersistence();
      await signInWithEmailAndPassword(auth, email.trim(), password);
      navigate("/");
    } catch (signInError) {
      console.error("[SignIn] Authentication failed:", {
        code: signInError?.code || "unknown",
        message: signInError?.message || String(signInError),
      });
      setError(signInError.message || "Could not sign in.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="form-card narrow-card">
      <p className="eyebrow">Welcome back</p>
      <h1>Sign in</h1>
      <form className="stack-form" onSubmit={handleSubmit}>
        <label>
          Email
          <input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
        </label>
        <label>
          Password
          <input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required />
        </label>
        {error && <p className="notice error" role="alert">{error}</p>}
        <button className="primary-button" disabled={saving} type="submit">
          {saving ? "Signing in…" : "Sign in"}
        </button>
      </form>
      <p className="form-footnote">New to RecoVibe? <Link to="/signup">Create an account</Link></p>
    </section>
  );
}
