const admin = require("firebase-admin");

const DRY_RUN = process.argv.includes("--dry-run");
const REGION_PROJECT_ID = process.env.GCLOUD_PROJECT || "recovibe-v1";

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
    projectId: REGION_PROJECT_ID,
  });
}

function normalizeStatus(event) {
  const statuses = [
    event.status,
    event.approvalStatus,
    event.publicationStatus,
  ].map((value) =>
    String(value || "").trim().toLowerCase().replace(/[\s_-]+/g, " "),
  );
  if (
    statuses.some((status) => ["cancelled", "canceled"].includes(status)) ||
    event.cancelled === true ||
    event.canceled === true
  ) return "cancelled";
  if (
    statuses.some((status) => ["unpublished", "unpublish", "draft"].includes(status)) ||
    event.published === false ||
    event.isPublished === false
  ) return "unpublished";
  return "";
}

function statusDetails(status, eventTitle) {
  const statusLabel = status === "cancelled" ? "Cancelled" : "Unpublished";
  return {
    statusLabel,
    type: status === "cancelled" ? "event_cancelled" : "event_unpublished",
    title: `${statusLabel}: ${eventTitle}`,
    message: status === "cancelled"
      ? `“${eventTitle}” has been cancelled by the organizer.`
      : `“${eventTitle}” is no longer published.`,
  };
}

async function backfill() {
  const db = admin.firestore();
  const events = await db.collection("events").get();
  const counts = {
    cancelled: { events: 0, activeRegistrations: 0, alreadyNotified: 0, wouldCreate: 0, created: 0 },
    unpublished: { events: 0, activeRegistrations: 0, alreadyNotified: 0, wouldCreate: 0, created: 0 },
  };

  for (const eventSnapshot of events.docs) {
    const eventData = eventSnapshot.data() || {};
    const status = normalizeStatus(eventData);
    if (!status) continue;

    counts[status].events += 1;
    const eventTitle = String(
      eventData.eventName || eventData.title || eventData.name || "Untitled event",
    );
    const statusData = statusDetails(status, eventTitle);
    const registrations = await eventSnapshot.ref
      .collection("registrations")
      .where("status", "==", "registered")
      .get();
    counts[status].activeRegistrations += registrations.size;
    const existingNotifications = await db.collection("notifications")
      .where("eventId", "==", eventSnapshot.id)
      .get();
    const notifiedRecipients = new Set(
      existingNotifications.docs
        .map((notification) => notification.data() || {})
        .filter((notification) => notification.status === status)
        .map((notification) => notification.recipientUid),
    );

    for (const registration of registrations.docs) {
      const notificationId =
        `backfill_${eventSnapshot.id}_${status}_${registration.id}`;
      const notificationRef = db.collection("notifications").doc(notificationId);
      if (notifiedRecipients.has(registration.id)) {
        counts[status].alreadyNotified += 1;
        continue;
      }
      const existing = await notificationRef.get();
      if (existing.exists) {
        counts[status].alreadyNotified += 1;
        continue;
      }

      counts[status].wouldCreate += 1;
      if (DRY_RUN) continue;
      await notificationRef.create({
        recipientUid: registration.id,
        eventId: eventSnapshot.id,
        eventTitle,
        status,
        statusLabel: statusData.statusLabel,
        title: statusData.title,
        message: statusData.message,
        type: statusData.type,
        read: false,
        deletedAt: null,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      counts[status].created += 1;
    }
  }

  console.log(JSON.stringify({
    projectId: REGION_PROJECT_ID,
    dryRun: DRY_RUN,
    counts,
  }, null, 2));
}

backfill()
  .catch((error) => {
    console.error("Event status notification backfill failed:", error);
    process.exitCode = 1;
  })
  .finally(() => admin.app().delete());
