import { useEffect, useState } from "react";
import { collection, onSnapshot, query, where } from "firebase/firestore";
import { db } from "../../../firebase.js";
import { approveEvent } from "../events/eventService.js";
import { useAuth } from "../auth/AuthProvider.jsx";

export default function AdminDashboard() {
  const { user } = useAuth();
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [approvingId, setApprovingId] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    const pendingEventsQuery = query(collection(db, "events"), where("status", "==", "pending"));
    return onSnapshot(
      pendingEventsQuery,
      (snapshot) => {
        setEvents(snapshot.docs.map((eventDocument) => ({ id: eventDocument.id, ...eventDocument.data() })));
        setError("");
        setLoading(false);
      },
      (snapshotError) => {
        console.error("Could not load pending events:", snapshotError);
        setError(`Could not load pending events: ${snapshotError.message}`);
        setLoading(false);
      },
    );
  }, []);

  async function handleApprove(eventId) {
    setError("");
    setNotice("");
    setApprovingId(eventId);
    try {
      await approveEvent(eventId, user.uid);
      setNotice("Event approved and published to the public feed.");
    } catch (approvalError) {
      console.error("Could not approve event:", approvalError);
      setError(
        approvalError.code === "permission-denied"
          ? "Firestore denied this approval. Confirm that your profile has the admin role."
          : `Could not approve the event: ${approvalError.message || "Please try again."}`,
      );
    } finally {
      setApprovingId("");
    }
  }

  return (
    <section>
      <div className="section-heading">
        <div>
          <p className="eyebrow">Administrator</p>
          <h1>Pending event review</h1>
        </div>
        <span className="count-pill">{events.length} pending</span>
      </div>
      {error && <p className="notice error" role="alert">{error}</p>}
      {notice && <p className="notice success" role="status">{notice}</p>}
      {loading ? (
        <p className="page-status">Loading pending events…</p>
      ) : events.length === 0 ? (
        <div className="empty-state"><h2>All caught up</h2><p>No events are waiting for review.</p></div>
      ) : (
        <div className="event-grid">
          {events.map((event) => (
            <article className="event-card" key={event.id}>
              <div className="event-meta"><span className="category-pill">{event.category}</span><span className="status-pill pending">Pending</span></div>
              <h2>{event.title}</h2>
              <p className="event-description">{event.description || "No description provided."}</p>
              <dl className="event-details">
                <div><dt>Date</dt><dd>{event.date}</dd></div>
                <div><dt>Location</dt><dd>{event.location}</dd></div>
                <div><dt>Submitted by</dt><dd>{event.createdByName || "RecoVibe user"}</dd></div>
              </dl>
              <button
                className="primary-button"
                type="button"
                disabled={approvingId === event.id}
                onClick={() => handleApprove(event.id)}
              >
                {approvingId === event.id ? "Approving…" : "Approve and publish"}
              </button>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
