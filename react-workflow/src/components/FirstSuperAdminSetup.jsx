import { useState } from "react";
import { Link } from "react-router-dom";
import {
  beginFirstSuperAdminSetup,
  finishFirstSuperAdminSetup,
} from "../users/userProvisioning.js";

export default function FirstSuperAdminSetup() {
  const [setup, setSetup] = useState(null);
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);

  async function handleBegin(event) {
    event.preventDefault();
    setError("");
    setNotice("");
    setSaving(true);
    try {
      const pendingSetup = await beginFirstSuperAdminSetup({
        displayName,
        email,
        password,
      });
      setSetup(pendingSetup);
      setNotice(`Verification email sent to ${pendingSetup.user.email}. Verify it, then continue here.`);
    } catch (setupError) {
      console.error("[FirstSuperAdminSetup] Could not start setup:", {
        code: setupError?.code || "unknown",
        message: setupError?.message || String(setupError),
      });
      const cleanupMessage = setupError.setupAccountRemoved === false
        ? " The Auth account could not be removed; retry setup with the same email and password."
        : "";
      setError(`${setupError.message || "Could not start superadmin setup."}${cleanupMessage}`);
    } finally {
      setSaving(false);
    }
  }

  async function handleFinish() {
    if (!setup) return;
    setError("");
    setSaving(true);
    try {
      await finishFirstSuperAdminSetup(setup);
      setNotice("First superadmin setup is complete. Sign in with the verified account.");
      setSetup(null);
      setPassword("");
    } catch (setupError) {
      console.error("[FirstSuperAdminSetup] Could not finish setup:", {
        code: setupError?.code || "unknown",
        message: setupError?.message || String(setupError),
      });
      if (setupError.message !== "Verify your email before completing superadmin setup.") {
        setSetup(null);
      }
      const cleanupMessage = setupError.setupAccountRemoved === false
        ? " The Auth account could not be removed; retry setup with the same email and password."
        : "";
      setError(`${setupError.message || "Could not complete superadmin setup."}${cleanupMessage}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="form-card narrow-card">
      <p className="eyebrow">One-time initialization</p>
      <h1>Set up first superadmin</h1>
      <p className="muted">
        This can be completed only once. The initial account must use the email
        allowlisted in the deployed Firestore rules.
      </p>
      {error && <p className="notice error" role="alert">{error}</p>}
      {notice && <p className="notice success" role="status">{notice}</p>}
      {!setup ? (
        <form className="stack-form" onSubmit={handleBegin}>
          <label>
            Name
            <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} required maxLength={100} />
          </label>
          <label>
            Allowlisted email
            <input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
          </label>
          <label>
            Password
            <input type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} required minLength={8} />
          </label>
          <button className="primary-button" disabled={saving} type="submit">
            {saving ? "Creating setup account…" : "Create first superadmin"}
          </button>
        </form>
      ) : (
        <button className="primary-button" disabled={saving} type="button" onClick={handleFinish}>
          {saving ? "Checking verification…" : "I verified my email — finish setup"}
        </button>
      )}
      <p className="form-footnote"><Link to="/signin">Return to sign in</Link></p>
    </section>
  );
}
