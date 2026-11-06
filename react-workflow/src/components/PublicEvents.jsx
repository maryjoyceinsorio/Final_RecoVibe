import { useEffect, useState } from "react";
import { collection, onSnapshot, query, where } from "firebase/firestore";
import { db } from "../../../firebase.js";

export default function PublicEvents() {
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    const approvedEventsQuery = query(collection(db, "events"), where("status", "==", "approved"));
    return onSnapshot(
      approvedEventsQuery,
      (snapshot) => {
        const approvedEvents = snapshot.docs.map((eventDocument) => ({ id: eventDocument.id, ...eventDocument.data() }));
        approvedEvents.sort((first, second) => first.date.localeCompare(second.date));
        setEvents(approvedEvents);
        setError("");
        setLoading(false);
      },
      (snapshotError) => {
        console.error("Could not load public events:", snapshotError);
        setError(`Could not load events: ${snapshotError.message}`);
        setLoading(false);
      },
    );
  }, []);

  return (
    <section>
      <div className="hero">
        <p className="eyebrow">Find your next campus moment</p>
        <h1>Events worth showing up for.</h1>
        <p>Discover approved events from across the RecoVibe community.</p>
      </div>
      <div className="section-heading">
        <div><p className="eyebrow">The public calendar</p><h2>Upcoming events</h2></div>
        <span className="count-pill">{events.length} events</span>
      </div>
      {error && <p className="notice error" role="alert">{error}</p>}
      {loading ? (
        <p className="page-status">Loading events…</p>
      ) : events.length === 0 ? (
        <div className="empty-state"><h2>Nothing published yet</h2><p>Approved events will appear here automatically.</p></div>
      ) : (
        <div className="event-grid">
          {events.map((event) => (
            <article className="event-card" key={event.id}>
              <div className="event-meta"><span className="category-pill">{event.category}</span><span className="status-pill approved">Approved</span></div>
              <h2>{event.title}</h2>
              <p className="event-description">{event.description || "More details coming soon."}</p>
              <dl className="event-details">
                <div><dt>Date</dt><dd>{event.date}</dd></div>
                <div><dt>Location</dt><dd>{event.location}</dd></div>
                <div><dt>Organizer</dt><dd>{event.createdByName || "RecoVibe community"}</dd></div>
              </dl>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
