import { useState } from "react";
import { addDoc, collection, serverTimestamp } from "firebase/firestore";
import { db } from "../../../firebase.js";
import { useAuth } from "../auth/AuthProvider.jsx";
import { EVENT_STATUSES } from "../events/eventService.js";

const CATEGORIES = ["Academic", "Arts & Culture", "Career", "Community", "Sports", "Other"];

export default function EventForm() {
  const { user, profile } = useAuth();
  const [form, setForm] = useState({
    title: "",
    description: "",
    category: CATEGORIES[0],
    date: "",
    location: "",
  });
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [saving, setSaving] = useState(false);

  function updateField(event) {
    setForm((current) => ({ ...current, [event.target.name]: event.target.value }));
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setError("");
    setSuccess("");

    const eventData = {
      title: form.title.trim(),
      description: form.description.trim(),
      category: form.category,
      date: form.date,
      location: form.location.trim(),
    };
    if (eventData.title.length < 3 || eventData.title.length > 120) {
      setError("Title must be between 3 and 120 characters.");
      return;
    }
    if (eventData.description.length > 3000) {
      setError("Description must be 3,000 characters or fewer.");
      return;
    }
    if (typeof profile.adviserUid !== "string" || !profile.adviserUid.trim()) {
      setError("Your account does not have an assigned adviser. Contact an administrator before submitting an event.");
      return;
    }

    setSaving(true);
    try {
      await addDoc(collection(db, "events"), {
        ...eventData,
        status: EVENT_STATUSES.PENDING_ADVISER,
        adviserUid: profile.adviserUid.trim(),
        createdBy: user.uid,
        createdByName: profile.displayName || user.displayName || user.email,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      setForm({ title: "", description: "", category: CATEGORIES[0], date: "", location: "" });
      setSuccess("Event submitted for Adviser approval. It will appear in the public feed after all approval stages are complete.");
    } catch (submitError) {
      console.error("Could not submit event:", submitError);
      setError(
        submitError.code === "permission-denied"
          ? "Firestore denied this submission. Check that the signed-in profile and Firestore rules allow event creation."
          : `Could not submit the event: ${submitError.message || "Please try again."}`,
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="form-card">
      <p className="eyebrow">Share something happening</p>
      <h1>Submit an event</h1>
      <p className="muted">New events go through Adviser, HAP, and OSAS review before they are published.</p>
      <form className="stack-form" onSubmit={handleSubmit}>
        <label>
          Event title
          <input name="title" value={form.title} onChange={updateField} required minLength={3} maxLength={120} />
        </label>
        <label>
          Description
          <textarea name="description" value={form.description} onChange={updateField} rows={5} maxLength={3000} />
        </label>
        <div className="field-row">
          <label>
            Category
            <select name="category" value={form.category} onChange={updateField}>
              {CATEGORIES.map((category) => <option key={category}>{category}</option>)}
            </select>
          </label>
          <label>
            Date
            <input name="date" type="date" value={form.date} onChange={updateField} required />
          </label>
        </div>
        <label>
          Location
          <input name="location" value={form.location} onChange={updateField} required maxLength={200} />
        </label>
        {error && <p className="notice error" role="alert">{error}</p>}
        {success && <p className="notice success" role="status">{success}</p>}
        <button className="primary-button" type="submit" disabled={saving}>
          {saving ? "Submitting…" : "Submit for Adviser approval"}
        </button>
      </form>
    </section>
  );
}
