import { useState } from "react";
import { createManagedUser } from "../users/userProvisioning.js";

const roles = [
  { value: "admin", label: "Admin" },
  { value: "organizer", label: "EO" },
  { value: "teacher", label: "Teacher" },
];

export default function UserManagementDashboard() {
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState("admin");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);

  async function handleSubmit(event) {
    event.preventDefault();
    setError("");
    setNotice("");
    setSaving(true);
    try {
      const uid = await createManagedUser({ displayName, email, password, role });
      setNotice(`User account created successfully (UID: ${uid}).`);
      setDisplayName("");
      setEmail("");
      setPassword("");
      setRole("admin");
    } catch (createError) {
      console.error("[UserManagement] Could not create account:", {
        code: createError?.code || "unknown",
        message: createError?.message || String(createError),
      });
      setError(
        createError.code === "permission-denied"
          ? "Firestore denied profile creation. Confirm the current account is a superadmin and the deployed rules allow superadmin provisioning."
          : createError.message || "Could not create the user account.",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="form-card">
      <p className="eyebrow">Superadmin</p>
      <h1>User management</h1>
      <p className="muted">
        Create accounts for staff. Their authentication account and role
        profile are saved separately under the same UID.
      </p>
      {error && <p className="notice error" role="alert">{error}</p>}
      {notice && <p className="notice success" role="status">{notice}</p>}
      <form className="stack-form" onSubmit={handleSubmit}>
        <div className="field-row">
          <label>
            Name
            <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} required maxLength={100} />
          </label>
          <label>
            Email
            <input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
          </label>
        </div>
        <div className="field-row">
          <label>
            Temporary password
            <input type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} required minLength={8} />
          </label>
          <label>
            Role
            <select value={role} onChange={(event) => setRole(event.target.value)}>
              {roles.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
            </select>
          </label>
        </div>
        <button className="primary-button" disabled={saving} type="submit">
          {saving ? "Creating account…" : "Create user"}
        </button>
      </form>
    </section>
  );
}
