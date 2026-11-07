import { useEffect, useState } from "react";
import { collection, onSnapshot, query, where } from "firebase/firestore";
import { db } from "../../../firebase.js";
import { approveEvent, EVENT_STATUSES } from "../events/eventService.js";
import { useAuth } from "../auth/AuthProvider.jsx";

export default function AdminDashboard() {
  const { user, profile } = useAuth();
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [approvingId, setApprovingId] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    const role = profile?.role;
    const stageStatus = {
      adviser: EVENT_STATUSES.PENDING_ADVISER,
      hap: EVENT_STATUSES.PENDING_HAP,
      osas: EVENT_STATUSES.PENDING_OSAS,
    }[role];

    setEvents([]);
    setError("");
    if (!stageStatus || !user?.uid) {
      setLoading(false);
      return undefined;
    }

    setLoading(true);
    const filters = [where("status", "==", stageStatus)];
    if (role === "adviser") filters.push(where("adviserUid", "==", user.uid));

    const pendingEventsQuery = query(collection(db, "events"), ...filters);
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
  }, [profile?.role, user?.uid]);

  function canApprove(event) {
    if (profile?.role === "adviser") {
      return event.status === EVENT_STATUSES.PENDING_ADVISER && event.adviserUid === user.uid;
    }
    if (profile?.role === "hap") return event.status === EVENT_STATUSES.PENDING_HAP;
    if (profile?.role === "osas") return event.status === EVENT_STATUSES.PENDING_OSAS;
    return false;
  }

  async function handleApprove(event) {
    setError("");
    setNotice("");
    setApprovingId(event.id);
    try {
      await approveEvent(event.id, user.uid, profile.role, event);
      setNotice(
        event.status === EVENT_STATUSES.PENDING_OSAS
          ? "Event approved and published to the public feed."
          : `Event approved. It is now ${event.status === EVENT_STATUSES.PENDING_ADVISER ? "waiting for HAP" : "waiting for OSAS"}.`,
      );
    } catch (approvalError) {
      console.error("Could not approve event:", approvalError);
      setError(
        approvalError.code === "permission-denied"
          ? "Firestore denied this approval. Confirm that your account is assigned to this approval stage."
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
          <h1>Pending event approvals</h1>
        </div>
        <span className="count-pill">{events.length} pending</span>
      </div>
      {error && <p className="notice error" role="alert">{error}</p>}
      {notice && <p className="notice success" role="status">{notice}</p>}
      {loading ? (
        <p className="page-status">Loading pending events…</p>
      ) : !["adviser", "hap", "osas"].includes(profile?.role) ? (
        <div className="empty-state"><h2>No approval stage assigned</h2><p>Your account is not assigned to an event approval stage.</p></div>
      ) : events.length === 0 ? (
        <div className="empty-state"><h2>All caught up</h2><p>No events are waiting at your approval stage.</p></div>
      ) : (
        <div className="event-grid">
          {events.map((event) => (
            <article className="event-card" key={event.id}>
              <div className="event-meta"><span className="category-pill">{event.category}</span><span className="status-pill pending">{event.status}</span></div>
              <h2>{event.title}</h2>
              <p className="event-description">{event.description || "No description provided."}</p>
              <dl className="event-details">
                <div><dt>Date</dt><dd>{event.date}</dd></div>
                <div><dt>Location</dt><dd>{event.location}</dd></div>
                <div><dt>Submitted by</dt><dd>{event.createdByName || "RecoVibe user"}</dd></div>
              </dl>
              {canApprove(event) ? (
                <button
                  className="primary-button"
                  type="button"
                  disabled={approvingId === event.id}
                  onClick={() => handleApprove(event)}
                >
                  {approvingId === event.id ? "Approving…" : "Approve"}
                </button>
              ) : (
                <p className="muted" role="status">This event is not assigned to your approval stage.</p>
              )}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
