import { useEffect, useState } from "react";
import { collection, doc, onSnapshot, serverTimestamp, updateDoc } from "firebase/firestore";
import { db } from "../../../firebase.js";
import { createManagedUser } from "../users/userProvisioning.js";

const roles = [
  { value: "admin", label: "Admin" },
  { value: "adviser", label: "Adviser" },
  { value: "hap", label: "HAP" },
  { value: "osas", label: "OSAS" },
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
  const [users, setUsers] = useState([]);
  const [usersError, setUsersError] = useState("");
  const [selectedUserUid, setSelectedUserUid] = useState("");
  const [selectedAdviserUid, setSelectedAdviserUid] = useState("");
  const [assigning, setAssigning] = useState(false);

  useEffect(() => onSnapshot(
    collection(db, "users"),
    (snapshot) => {
      setUsers(snapshot.docs.map((userDocument) => ({ uid: userDocument.id, ...userDocument.data() })));
      setUsersError("");
    },
    (loadError) => {
      console.error("[UserManagement] Could not load user profiles:", loadError);
      setUsersError(`Could not load user profiles: ${loadError.message}`);
    },
  ), []);

  const eventSubmitters = users.filter((account) => ["user", "organizer"].includes(account.role));
  const advisers = users.filter((account) => account.role === "adviser");

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

  async function handleAssignAdviser(event) {
    event.preventDefault();
    setError("");
    setNotice("");
    if (!selectedUserUid || !selectedAdviserUid) {
      setError("Choose both an event submitter and an Adviser.");
      return;
    }

    setAssigning(true);
    try {
      await updateDoc(doc(db, "users", selectedUserUid), {
        adviserUid: selectedAdviserUid,
        updatedAt: serverTimestamp(),
      });
      setNotice("Assigned Adviser updated successfully.");
    } catch (assignmentError) {
      console.error("[UserManagement] Could not assign Adviser:", assignmentError);
      setError(
        assignmentError.code === "permission-denied"
          ? "Firestore denied the Adviser assignment. Confirm that you are signed in as a superadmin and the deployed rules allow profile assignment."
          : `Could not assign the Adviser: ${assignmentError.message || "Please try again."}`,
      );
    } finally {
      setAssigning(false);
    }
  }

  return (
    <section className="form-card">
      <p className="eyebrow">Superadmin</p>
      <h1>User management</h1>
      <p className="muted">
        Create accounts for staff and approval-stage reviewers. Their
        authentication account and role profile are saved separately under the
        same UID.
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

      <hr />
      <h2>Assign an Adviser</h2>
      <p className="muted">Events submitted by an account will be routed to its assigned Adviser.</p>
      {usersError && <p className="notice error" role="alert">{usersError}</p>}
      <form className="stack-form" onSubmit={handleAssignAdviser}>
        <label>
          Event submitter
          <select
            value={selectedUserUid}
            onChange={(event) => {
              const nextUid = event.target.value;
              setSelectedUserUid(nextUid);
              setSelectedAdviserUid(users.find((account) => account.uid === nextUid)?.adviserUid || "");
            }}
            required
          >
            <option value="">Select an account</option>
            {eventSubmitters.map((account) => (
              <option key={account.uid} value={account.uid}>
                {account.displayName || account.email || account.uid}
                {account.adviserUid ? " (Adviser assigned)" : " (No Adviser assigned)"}
              </option>
            ))}
          </select>
        </label>
        <label>
          Adviser
          <select value={selectedAdviserUid} onChange={(event) => setSelectedAdviserUid(event.target.value)} required>
            <option value="">Select an Adviser</option>
            {advisers.map((adviser) => (
              <option key={adviser.uid} value={adviser.uid}>
                {adviser.displayName || adviser.email || adviser.uid}
              </option>
            ))}
          </select>
        </label>
        {advisers.length === 0 && <p className="muted">Create an Adviser account before assigning reviewers.</p>}
        <button className="primary-button" disabled={assigning || !eventSubmitters.length || !advisers.length} type="submit">
          {assigning ? "Assigning…" : "Save Adviser assignment"}
        </button>
      </form>
    </section>
  );
}
