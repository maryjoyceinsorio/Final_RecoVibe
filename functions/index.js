const functions = require("firebase-functions");
const admin = require("firebase-admin");
const crypto = require("crypto");

if (!admin.apps.length) {
  admin.initializeApp();
}

const COOLDOWN_MS = 180000; // 3-minute refresh cooldown
const QR_SECRET = process.env.QR_SECRET || "recovibe-secret-pup-binan-qr-key-2026";

/**
 * Generate HMAC signature for <uid>.<version>
 * Signature is the first 22 characters of base64url(HMAC-SHA256(secret, "<uid>.<version>"))
 */
function createSignature(uid, version) {
  return crypto
    .createHmac("sha256", QR_SECRET)
    .update(`${uid}.${version}`)
    .digest("base64url")
    .slice(0, 22);
}

/**
 * Generate permanent token in <uid>.<version>.<signature> format
 */
function generateToken(uid, version) {
  const sig = createSignature(uid, version);
  return `${uid}.${version}.${sig}`;
}

/**
 * Verify token signature using crypto.timingSafeEqual
 */
function verifySignature(uid, version, signature) {
  if (!uid || !version || !signature) return false;
  const expectedSig = createSignature(uid, version);
  const sigBuf = Buffer.from(String(signature));
  const expBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expBuf.length) return false;
  return crypto.timingSafeEqual(sigBuf, expBuf);
}

/**
 * Verify caller has role 'event_organizer' or 'admin'
 */
async function verifyOrganizerRole(authData) {
  if (!authData || !authData.uid) {
    throw new functions.https.HttpsError("unauthenticated", "Caller must be authenticated.");
  }
  const roleSnap = await admin.database().ref(`roles/${authData.uid}`).once("value");
  const role = roleSnap.val();
  if (role !== "event_organizer" && role !== "admin") {
    throw new functions.https.HttpsError("permission-denied", "Only event organizers and admins can perform this action.");
  }
  return role;
}

/**
 * Helper to fetch student metadata from Firestore
 */
async function getStudentMetadata(uid, fallbackStudentNo = "") {
  try {
    const snap = await admin.firestore().collection("users").doc(uid).get();
    if (snap.exists) {
      const data = snap.data();
      const sName = data.fullName || `${data.firstName || ""} ${data.lastName || ""}`.trim() || "Student";
      const sNo = data.studentNumber || data.studentId || fallbackStudentNo || "—";
      const sOrg = data.organization || "PUP Biñan";
      return { name: sName, studentNo: sNo, organization: sOrg };
    }
  } catch (err) {
    console.warn("Firestore student profile lookup notice:", err);
  }
  return {
    name: "Student",
    studentNo: fallbackStudentNo || uid,
    organization: "PUP Biñan",
  };
}

/**
 * 1. getMyQrToken()
 * Returns permanent token, live version, and remaining cooldownMs (0 if none)
 */
exports.getMyQrToken = functions.region("asia-southeast1").https.onCall(async (data, context) => {
  if (!context.auth || !context.auth.uid) {
    throw new functions.https.HttpsError("unauthenticated", "You must be signed in to view your QR code.");
  }

  const uid = context.auth.uid;
  const versionRef = admin.database().ref(`qrVersions/${uid}`);
  const snap = await versionRef.once("value");
  const tokenData = snap.val() || { v: 1, at: 0 };
  const version = Number(tokenData.v) || 1;
  const lastAt = Number(tokenData.at) || 0;

  const now = Date.now();
  const cooldownMs = Math.max(0, COOLDOWN_MS - (now - lastAt));
  const token = generateToken(uid, version);

  return ({
    token,
    version,
    cooldownMs,
  });
});

/**
 * 2. regenerateMyQr()
 * Atomically bumps the student's QR version and returns the new token.
 * Enforces 3-minute cooldown inside a Realtime Database transaction.
 */
exports.regenerateMyQr = functions.region("asia-southeast1").https.onCall(async (data, context) => {
  if (!context.auth || !context.auth.uid) {
    throw new functions.https.HttpsError("unauthenticated", "You must be signed in to regenerate your QR code.");
  }

  const uid = context.auth.uid;
  const now = Date.now();
  const versionRef = admin.database().ref(`qrVersions/${uid}`);

  let updatedVersion = 1;
  const txResult = await versionRef.transaction((current) => {
    if (current) {
      const timeSinceLast = now - (Number(current.at) || 0);
      if (timeSinceLast < COOLDOWN_MS) {
        return undefined;
      }
      updatedVersion = (Number(current.v) || 1) + 1;
    } else {
      updatedVersion = 2;
    }
    return { v: updatedVersion, at: now };
  });

  if (!txResult.committed) {
    const snap = await versionRef.once("value");
    const currentData = snap.val() || {};
    const retryAfterMs = Math.max(0, COOLDOWN_MS - (now - (Number(currentData.at) || 0)));
    throw new functions.https.HttpsError(
      "resource-exhausted",
      "Please wait before refreshing your code again.",
      { retryAfterMs }
    );
  }

  const token = generateToken(uid, updatedVersion);
  return ({
    token,
    version: updatedVersion,
    cooldownMs: COOLDOWN_MS,
  });
});

/**
 * 3. recordAttendance({ eventId, token, allowWalkIn })
 */
exports.recordAttendance = functions.region("asia-southeast1").https.onCall(async (data, context) => {
  await verifyOrganizerRole(context.auth);

  const { eventId, token, allowWalkIn } = data || {};
  if (!eventId || !token) {
    throw new functions.https.HttpsError("invalid-argument", "Missing required parameters: eventId and token.");
  }

  const parts = String(token).trim().split(".");
  if (parts.length !== 3) {
    throw new functions.https.HttpsError("invalid-argument", "Malformed QR token structure.");
  }
  const [uid, versionStr, signature] = parts;
  const version = Number(versionStr);
  if (!uid || Number.isNaN(version) || version <= 0 || !signature) {
    throw new functions.https.HttpsError("invalid-argument", "Invalid QR token parameters.");
  }

  if (!verifySignature(uid, version, signature)) {
    throw new functions.https.HttpsError("invalid-argument", "Invalid QR code signature.");
  }

  const versionSnap = await admin.database().ref(`qrVersions/${uid}`).once("value");
  const liveVersionData = versionSnap.val() || { v: 1, at: 0 };
  const liveVersion = Number(liveVersionData.v) || 1;

  if (version !== liveVersion) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "This QR code was replaced. Ask the student to download their new one."
    );
  }

  const eventSnap = await admin.database().ref(`events/${eventId}`).once("value");
  const eventData = eventSnap.val();
  if (eventData) {
    const now = Date.now();
    if (eventData.endAt) {
      const endTime = new Date(eventData.endAt).getTime();
      if (!Number.isNaN(endTime) && now > endTime) {
        throw new functions.https.HttpsError("failed-precondition", "This event has already ended.");
      }
    }
    if (eventData.startAt) {
      const startTime = new Date(eventData.startAt).getTime();
      const windowOpen = startTime - 3 * 60 * 60 * 1000;
      if (!Number.isNaN(startTime) && now < windowOpen) {
        throw new functions.https.HttpsError("failed-precondition", "The check-in window for this event is not open yet.");
      }
    }
  }

  const student = await getStudentMetadata(uid);

  const regSnap = await admin.database().ref(`registrations/${eventId}/${uid}`).once("value");
  const isRegistered = Boolean(regSnap.val());

  if (!isRegistered && !allowWalkIn) {
    return ({
      status: "not_registered",
      student,
    });
    return;
  }

  const attendanceRef = admin.database().ref(`attendance/${eventId}/${uid}`);
  let alreadyScannedTime = null;
  const isWalkIn = !isRegistered;
  const scannedBy = context.auth.token.name || context.auth.token.email || "Event Organizer";

  const txResult = await attendanceRef.transaction((current) => {
    if (current) {
      alreadyScannedTime = current.scannedAt;
      return undefined;
    }
    return {
      scannedAt: Date.now(),
      scannedBy,
      walkIn: isWalkIn,
      name: student.name,
      studentNo: student.studentNo,
      organization: student.organization,
    };
  });

  if (!txResult.committed) {
    return ({
      status: "already",
      student,
      scannedAt: alreadyScannedTime,
    });
    return;
  }

  admin
    .database()
    .ref(`publicEvents/${eventId}/checkedInCount`)
    .transaction((cnt) => (cnt || 0) + 1)
    .catch(() => {});

  return ({
    status: "ok",
    walkIn: isWalkIn,
    student,
  });
});

/**
 * 4. recordAttendanceByStudentNo({ eventId, studentNo, allowWalkIn })
 */
exports.recordAttendanceByStudentNo = functions.region("asia-southeast1").https.onCall(async (data, context) => {
  await verifyOrganizerRole(context.auth);

  const { eventId, studentNo, allowWalkIn } = data || {};
  if (!eventId || !studentNo) {
    throw new functions.https.HttpsError("invalid-argument", "Missing required parameters: eventId and studentNo.");
  }

  const cleanNo = String(studentNo).trim();
  let studentUid = null;
  let studentData = null;

  const usersRef = admin.firestore().collection("users");
  let querySnap = await usersRef.where("studentNumber", "==", cleanNo).limit(1).get();
  if (querySnap.empty) {
    querySnap = await usersRef.where("studentId", "==", cleanNo).limit(1).get();
  }

  if (!querySnap.empty) {
    const docSnap = querySnap.docs[0];
    studentUid = docSnap.id;
    const d = docSnap.data();
    studentData = {
      name: d.fullName || `${d.firstName || ""} ${d.lastName || ""}`.trim() || "Student",
      studentNo: d.studentNumber || d.studentId || cleanNo,
      organization: d.organization || "PUP Biñan",
    };
  } else {
    studentUid = cleanNo.replace(/[^a-zA-Z0-9_-]/g, "_");
    studentData = {
      name: "Student",
      studentNo: cleanNo,
      organization: "PUP Biñan",
    };
  }

  const regSnap = await admin.database().ref(`registrations/${eventId}/${studentUid}`).once("value");
  const isRegistered = Boolean(regSnap.val());

  if (!isRegistered && !allowWalkIn) {
    return ({
      status: "not_registered",
      student: studentData,
    });
    return;
  }

  const attendanceRef = admin.database().ref(`attendance/${eventId}/${studentUid}`);
  let alreadyScannedTime = null;
  const isWalkIn = !isRegistered;
  const scannedBy = context.auth.token.name || context.auth.token.email || "Event Organizer";

  const txResult = await attendanceRef.transaction((current) => {
    if (current) {
      alreadyScannedTime = current.scannedAt;
      return undefined;
    }
    return {
      scannedAt: Date.now(),
      scannedBy,
      walkIn: isWalkIn,
      name: studentData.name,
      studentNo: studentData.studentNo,
      organization: studentData.organization,
    };
  });

  if (!txResult.committed) {
    return ({
      status: "already",
      student: studentData,
      scannedAt: alreadyScannedTime,
    });
    return;
  }

  admin
    .database()
    .ref(`publicEvents/${eventId}/checkedInCount`)
    .transaction((cnt) => (cnt || 0) + 1)
    .catch(() => {});

  return ({
    status: "ok",
    walkIn: isWalkIn,
    student: studentData,
  });
});

/* ==========================================================================
    EVENT ORGANIZER APPROVALS & ATTENDANCE BACKEND CONTRACT
   ========================================================================== */

const APPROVER_DIRECTORY = {
  org_adv: { key: "org_adv", label: "Organization Adviser", stage: 1, defaultOn: true, required: true },
  sir_abelida: { key: "sir_abelida", label: "Laboratory Head, Property Custodian, Administrative Officer", stage: 2, defaultOn: true, required: true },
  hap: { key: "hap", label: "Head of Academic Programs, QAC Coordinator (HAP)", stage: 3, defaultOn: true, required: true },
  osas: { key: "osas", label: "OSAS", stage: 4, defaultOn: true, required: true },
};

const DEFAULT_SYSTEM_APPROVAL_STAGES = [
  { id: "org_adv", name: "Organization Adviser", reviewer: "Organization Adviser", required: true },
  { id: "sir_abelida", name: "Laboratory Head, Property Custodian, Administrative Officer", reviewer: "Laboratory Head, Property Custodian, Administrative Officer", required: true },
  { id: "hap", name: "Head of Academic Programs, QAC Coordinator (HAP)", reviewer: "Head of Academic Programs, QAC Coordinator (HAP)", required: true },
  { id: "osas", name: "OSAS", reviewer: "OSAS", required: true },
];

const APPROVAL_ACCOUNT_STAGES = [
  {
    key: "org_adv",
    label: "Organization Adviser",
    step: 1,
    aliases: ["org_adv", "org adviser", "organization adviser", "organization adviser review"],
  },
  {
    key: "sir_abelida",
    label: "Laboratory Head, Property Custodian, Administrative Officer",
    step: 2,
    aliases: ["sir_abelida", "laboratory head", "property custodian", "administrative officer"],
  },
  {
    key: "hap",
    label: "Head of Academic Programs, QAC Coordinator",
    step: 3,
    aliases: ["hap", "head of academic programs", "qac coordinator"],
  },
  {
    key: "osas",
    label: "OSAS",
    step: 4,
    aliases: ["osas"],
  },
];

function normalizeApprovalKey(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isOrganizationAdviserStage(value) {
  const stageValues = value && typeof value === "object"
    ? [value.roleKey, value.key, value.id, value.name, value.label, value.reviewer]
    : [value];
  return stageValues.some((item) => {
    const normalized = normalizeApprovalKey(item);
    return normalized === "orgadv" ||
      normalized.includes("organizationadviser") ||
      normalized.includes("organizationadvisor") ||
      normalized.includes("orgadviser") ||
      normalized.includes("orgadvisor");
  });
}

async function getSystemSettingsData() {
  const snapshot = await admin.firestore()
    .collection("system_settings")
    .doc("global_config")
    .get();
  const data = snapshot.exists ? snapshot.data() || {} : {};
  const configuredStages = Array.isArray(data.approvalStages)
    ? data.approvalStages
    : [];
  const approvalStages = APPROVAL_ACCOUNT_STAGES.map((workflowStage, index) => {
    const defaultStage = DEFAULT_SYSTEM_APPROVAL_STAGES[index];
    const configuredStage = configuredStages.find((candidate) =>
      getWorkflowApprovalStage({
        id: candidate?.id || candidate?.key,
        label: candidate?.name || candidate?.label,
        reviewer: candidate?.reviewer,
      })?.key === workflowStage.key,
    );
    return {
      ...defaultStage,
      ...(configuredStage || {}),
      id: workflowStage.key,
      name: defaultStage.name,
      reviewer: defaultStage.reviewer,
      required: true,
    };
  });
  return {
    ...data,
    organizations: Array.isArray(data.organizations) ? data.organizations : [],
    approvalStages,
  };
}

function normalizeOrganizationCode(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toUpperCase();
}

function getOrganizationCode(profile) {
  const values = [
    profile?.organizationCode,
    profile?.orgCode,
    profile?.organization,
    profile?.organizationName,
    profile?.orgName,
    profile?.fallbackName,
  ];
  return normalizeOrganizationCode(values.find((value) => String(value || "").trim()));
}

function getEventOrganizationCode(event) {
  return getOrganizationCode({
    organizationCode: event?.organizationCode,
    organizerOrganization: event?.organizerOrganization,
    organization: event?.organization,
    organizationName: event?.organizationName,
    orgName: event?.orgName,
    fallbackName: event?.organizerName || event?.organizer,
  });
}

async function getProposalOrganizationCode(event) {
  const eventCode = getEventOrganizationCode(event);
  const organizerUid = String(event?.organizerUid || event?.organizerId || event?.createdBy || "");
  if (!organizerUid) return eventCode;

  const [adminProfileSnap, firestoreUserSnap, realtimeUserSnap, roleSnap] = await Promise.all([
    admin.firestore().collection("adminUser").doc(organizerUid).get(),
    admin.firestore().collection("users").doc(organizerUid).get(),
    admin.database().ref(`users/${organizerUid}`).once("value"),
    admin.database().ref(`roles/${organizerUid}`).once("value"),
  ]);
  const creatorProfile = {
    ...(realtimeUserSnap.val() || {}),
    ...(firestoreUserSnap.exists ? firestoreUserSnap.data() : {}),
    ...(adminProfileSnap.exists ? adminProfileSnap.data() : {}),
  };
  const creatorRole = normalizeApprovalKey(
    roleSnap.val() || creatorProfile.role || creatorProfile.userRole || event?.createdByRole || event?.creatorRole,
  );
  const isOrganizer = ["eventorganizer", "organizer", "eo"].includes(creatorRole);
  const creatorCode = isOrganizer ? getOrganizationCode(creatorProfile) : "";
  if (!isOrganizer || !creatorCode) return "";
  if (creatorCode && eventCode && creatorCode !== eventCode) return "";
  return creatorCode;
}

function assertOrganizationScopedApproval(identity, organizationCode) {
  if ((identity.stage?.roleKey || identity.stage?.key) !== "org_adv") return;
  if (!identity.organizationCode || !organizationCode ||
      identity.organizationCode !== normalizeOrganizationCode(organizationCode)) {
    throw new functions.https.HttpsError(
      "permission-denied",
      "Organization Advisers can only review proposals from their assigned organization.",
    );
  }
}

function getApprovalStageForProfile(profile) {
  const normalize = normalizeApprovalKey;
  const accountNumber = normalize(profile?.accountNumber || profile?.accountNo);
  const accountRole = accountNumber.replace(/^admin\d*/, "");
  const profileRoles = [
    profile?.approvalStage,
    profile?.approvalStageKey,
    profile?.assignedApprovalStage,
    profile?.approverStage,
    profile?.approverKey,
    profile?.approvalRole,
    profile?.approverRole,
    profile?.assignedRole,
    profile?.assignedApprover,
    profile?.adminRole,
    profile?.roleName,
    profile?.stageKey,
    profile?.position,
  ].map(normalize);
  const stage = APPROVAL_ACCOUNT_STAGES.find((candidate) => {
    const aliases = [candidate.key, candidate.label, ...candidate.aliases].map(normalize);
    return aliases.some((alias) =>
      (accountRole && accountRole.endsWith(alias)) ||
      profileRoles.includes(alias),
    );
  });
  const directoryStage = Object.values(APPROVER_DIRECTORY).find((candidate) => {
    const aliases = [candidate.key, candidate.label].map(normalize);
    return aliases.some((alias) => profileRoles.includes(alias));
  });
  if (!stage && directoryStage) {
    return {
      ...directoryStage,
      step: directoryStage.stage,
      roleKey: directoryStage.key === "org_adv" ? "org_adv" : "",
    };
  }
  const profileStep = Number(profile?.approvalStep || profile?.stage);
  const stageByStep = profileStep >= 1 && profileStep <= APPROVAL_ACCOUNT_STAGES.length
    ? APPROVAL_ACCOUNT_STAGES[profileStep - 1]
    : null;
  return stage || stageByStep;
}

async function getAdminApprovalIdentity(authData) {
  if (!authData?.uid) {
    throw new functions.https.HttpsError("unauthenticated", "Sign in before approving proposals.");
  }
  const snapshot = await admin.firestore().collection("adminUser").doc(authData.uid).get();
  const profile = snapshot.exists ? snapshot.data() : null;
  const profileRole = normalizeApprovalKey(profile?.role || profile?.userRole);
  const profileStatus = String(profile?.status || "active").trim().toLowerCase();
  if (!profile || !["admin", "superadmin"].includes(profileRole) ||
      ["disabled", "inactive", "suspended"].includes(profileStatus)) {
    throw new functions.https.HttpsError("permission-denied", "An active admin account profile is required for approval.");
  }
  const email = String(authData.token?.email || profile.email || profile.emailAddress || "").trim().toLowerCase();
  const nameParts = [profile.firstName, profile.middleName, profile.lastName]
    .map((part) => String(part || "").trim())
    .filter(Boolean);
  const profileOrganizationCode = getOrganizationCode(profile);
  let stage = getApprovalStageForProfile(profile);
  if (!stage) {
    const directorySnapshot = await admin.database().ref("approverDirectory").once("value");
    const directory = directorySnapshot.val() || {};
    const directoryEntry = Object.entries(directory).find(([, approver]) => approver?.uid === authData.uid);
    if (directoryEntry) {
      stage = getApprovalStageForProfile({
        approvalStageKey: directoryEntry[0],
        approvalRole: directoryEntry[1]?.label,
      });
    }
  }
  return {
    profile,
    stage,
    organizationCode: profileOrganizationCode,
    email,
    name: String(profile.fullName || profile.name || profile.displayName || nameParts.join(" ") || stage?.label || "Administrator").trim(),
  };
}

async function findOrganizationAdviserUid(organizationCode) {
  const expectedOrganizationCode = normalizeOrganizationCode(organizationCode);
  if (!expectedOrganizationCode) return "";

  const settings = await getSystemSettingsData();
  const organization = (Array.isArray(settings.organizations) ? settings.organizations : [])
    .find((item) => normalizeOrganizationCode(item?.code) === expectedOrganizationCode);
  const configuredUid = String(
    organization?.adviserUid || organization?.reviewerUid || organization?.uid || "",
  ).trim();
  if (configuredUid) return configuredUid;

  const directorySnapshot = await admin.database().ref("approverDirectory/org_adv/uid").once("value");
  return String(directorySnapshot.val() || "");
}

exports.syncApproverOrganization = functions.region("asia-southeast1").https.onCall(async (_data, context) => {
  const identity = await getAdminApprovalIdentity(context.auth);
  if ((identity.stage?.roleKey || identity.stage?.key) !== "org_adv") {
    await Promise.all([
      admin.database().ref(`approverOrganizations/${context.auth.uid}`).set("*"),
      admin.firestore().collection("approverOrganizations").doc(context.auth.uid).set({
        organizationCode: "*",
        updatedAt: Date.now(),
      }),
    ]);
    return { organizationCode: "*", organizationScoped: false };
  }
  if (!identity.organizationCode) {
    throw new functions.https.HttpsError("failed-precondition", "Your adviser profile must have an organization assigned.");
  }

  await Promise.all([
    admin.database().ref(`approverOrganizations/${context.auth.uid}`).set(identity.organizationCode),
    admin.firestore().collection("approverOrganizations").doc(context.auth.uid).set({
      organizationCode: identity.organizationCode,
      updatedAt: Date.now(),
    }),
  ]);
  const [pendingEvents, taggedEvents] = await Promise.all([
    admin.firestore().collection("events").where("status", "==", "pending").get(),
    admin.firestore().collection("events").where("organizationCode", "==", identity.organizationCode).get(),
  ]);
  const eventsToMigrate = new Map();
  [pendingEvents, taggedEvents].forEach((snapshot) => {
    snapshot.docs.forEach((eventSnapshot) => eventsToMigrate.set(eventSnapshot.id, eventSnapshot));
  });
  let migrationBatch = admin.firestore().batch();
  let migrationBatchSize = 0;
  for (const eventSnapshot of eventsToMigrate.values()) {
    const event = eventSnapshot.data() || {};
    const organizationCode = await getProposalOrganizationCode(event);
    if (organizationCode !== identity.organizationCode) continue;
    const organizerUid = String(event.organizerUid || event.organizerId || event.createdBy || "");
    if (!organizerUid) continue;
    migrationBatch.set(admin.firestore().collection("eventOrganizations").doc(organizerUid), {
      organizationCode,
      updatedAt: Date.now(),
    }, { merge: true });
    migrationBatch.set(eventSnapshot.ref, {
      organizationCode,
      organizerOrganization: organizationCode,
    }, { merge: true });
    migrationBatchSize += 2;
    if (migrationBatchSize >= 400) {
      await migrationBatch.commit();
      migrationBatch = admin.firestore().batch();
      migrationBatchSize = 0;
    }
  }
  if (migrationBatchSize) await migrationBatch.commit();

  const [realtimeEventsSnapshot, approvalsSnapshot, directorySnapshot] = await Promise.all([
    admin.database().ref("events").once("value"),
    admin.database().ref("approvals").once("value"),
    admin.database().ref("approverDirectory/org_adv").once("value"),
  ]);
  const realtimeEvents = realtimeEventsSnapshot.val() || {};
  const approvals = approvalsSnapshot.val() || {};
  const directoryUid = directorySnapshot.val()?.uid || "";
  const queueUpdates = {};
  for (const [eventId, approval] of Object.entries(approvals)) {
    const event = realtimeEvents[eventId];
    if (!approval || !event) continue;
    const members = approval.members || {};
    const adviserEntry = Object.entries(members).find(([key, member]) =>
      isOrganizationAdviserStage(key) ||
      isOrganizationAdviserStage(member?.key) ||
      isOrganizationAdviserStage(member?.label),
    );
    if (!adviserEntry) continue;
    const [, member] = adviserEntry;
    const eventOrganizationCode = await getProposalOrganizationCode(event);
    if (eventOrganizationCode !== identity.organizationCode) {
      queueUpdates[`approverQueue/${context.auth.uid}/${eventId}`] = null;
      if (directoryUid && directoryUid !== context.auth.uid) {
        queueUpdates[`approverQueue/${directoryUid}/${eventId}`] = null;
      }
      continue;
    }

    queueUpdates[`events/${eventId}/organizationCode`] = eventOrganizationCode;
    queueUpdates[`events/${eventId}/organizerOrganization`] = eventOrganizationCode;
    if (directoryUid && directoryUid !== context.auth.uid) {
      queueUpdates[`approverQueue/${directoryUid}/${eventId}`] = null;
    }
    if (["review", "rev"].includes(String(member.status || "").toLowerCase())) {
      queueUpdates[`approverQueue/${context.auth.uid}/${eventId}`] = {
        eventId,
        name: event.name || event.title || "Event",
        title: event.name || event.title || "Event",
        date: event.startAt || event.date || "",
        venue: event.venue || event.location || "",
        category: event.category || "",
        organizationCode: eventOrganizationCode,
        step: member.step || 1,
        status: member.status === "rev" ? "paused" : "pending",
        paused: member.status === "rev",
        updatedAt: member.updatedAt || Date.now(),
      };
    } else {
      queueUpdates[`approverQueue/${context.auth.uid}/${eventId}`] = null;
    }
  }
  if (Object.keys(queueUpdates).length) {
    await admin.database().ref().update(queueUpdates);
  }
  return { organizationCode: identity.organizationCode, organizationScoped: true };
});

exports.syncOrganizerOrganization = functions.region("asia-southeast1").https.onCall(async (_data, context) => {
  const role = await verifyEventCreator(context.auth);
  if (role !== "event_organizer") {
    throw new functions.https.HttpsError("permission-denied", "Only Event Organizers have an assigned organization.");
  }
  const identity = await getEventCreatorIdentity(context.auth.uid, role, context.auth);
  await admin.firestore().collection("eventOrganizations").doc(context.auth.uid).set({
    organizationCode: identity.organizationCode,
    updatedAt: Date.now(),
  });
  const ownedEventSnapshots = await Promise.all([
    admin.firestore().collection("events").where("organizerUid", "==", context.auth.uid).get(),
    admin.firestore().collection("events").where("organizerId", "==", context.auth.uid).get(),
    admin.firestore().collection("events").where("createdBy", "==", context.auth.uid).get(),
  ]);
  const ownedEvents = new Map();
  ownedEventSnapshots.forEach((snapshot) => {
    snapshot.docs.forEach((eventSnapshot) => ownedEvents.set(eventSnapshot.id, eventSnapshot));
  });
  let batch = admin.firestore().batch();
  let batchSize = 0;
  for (const eventSnapshot of ownedEvents.values()) {
    const event = eventSnapshot.data() || {};
    if (await getProposalOrganizationCode(event) === identity.organizationCode) {
      batch.set(eventSnapshot.ref, {
        organizationCode: identity.organizationCode,
        organizerOrganization: identity.organizationCode,
      }, { merge: true });
      batchSize += 1;
      if (batchSize === 400) {
        await batch.commit();
        batch = admin.firestore().batch();
        batchSize = 0;
      }
    }
  }
  if (batchSize) await batch.commit();
  return { organizationCode: identity.organizationCode };
});

function normalizeFirestoreApprovalStages(event, now) {
  const sourceStages = event?.approvalStages;
  let entries = Array.isArray(sourceStages)
    ? sourceStages.map((stage, index) => [
        String(stage && typeof stage === "object" ? stage.id || stage.key || index : index),
        stage && typeof stage === "object" ? stage : {},
      ])
    : sourceStages && typeof sourceStages === "object"
      ? Object.entries(sourceStages)
      : [];
  if (!entries.length) {
    entries = DEFAULT_SYSTEM_APPROVAL_STAGES.map((stage, index) => [
      stage.id,
      { ...stage, step: index + 1 },
    ]);
  }

  const approvalStages = {};
  const stages = entries
    .map(([id, value], index) => {
      const source = value && typeof value === "object" ? value : {};
      return {
        id: String(source.id || source.key || id),
        label: String(source.name || source.label || source.reviewer || `Stage ${index + 1}`),
        reviewer: String(source.reviewer || source.name || source.label || ""),
        required: source.required !== false,
        step: Number(source.step || source.stage) || index + 1,
        sourceIndex: index,
        source,
      };
    })
    .sort((first, second) =>
      first.step - second.step || first.sourceIndex - second.sourceIndex,
    )
    .map((stage, index) => {
      const { sourceIndex, ...normalizedStage } = stage;
      return { ...normalizedStage, step: index + 1 };
    });

  stages.forEach((stage, index) => {
    const safeSource = stage.source;
    const rawStatus = String(safeSource.status || "").trim().toLowerCase().replace(/[\s_-]+/g, " ");
    const status = ["ok", "approved", "complete", "completed"].includes(rawStatus)
      ? "approved"
      : ["review", "reviewing", "in review", "pending", "in progress"].includes(rawStatus)
        ? "review"
        : ["revision", "rev", "changes requested", "rejected", "rej", "cancelled"].includes(rawStatus)
          ? rawStatus === "rejected" || rawStatus === "rej" ? "rejected" : "revision"
          : index === 0 ? "review" : "waiting";

    approvalStages[stage.id] = {
      id: stage.id,
      key: stage.id,
      label: stage.label,
      name: stage.label,
      reviewer: stage.reviewer,
      reviewerUid: String(safeSource.reviewerUid || safeSource.uid || ""),
      required: stage.required,
      step: stage.step,
      status,
      assigneeName: stage.reviewer,
      ...(safeSource.approvedBy ? { approvedBy: safeSource.approvedBy } : {}),
      ...(safeSource.approvedByName || safeSource.decidedBy ? { approvedByName: safeSource.approvedByName || safeSource.decidedBy } : {}),
      ...(safeSource.approvedAt || safeSource.updatedAt ? { approvedAt: safeSource.approvedAt || safeSource.updatedAt } : {}),
      ...(safeSource.updatedAt ? { updatedAt: safeSource.updatedAt } : {}),
      ...(safeSource.note ? { note: String(safeSource.note) } : {}),
    };
  });

  const requestedStep = Number(event.approvalCurrentStep);
  const hasRequestedStep = requestedStep >= 1 && requestedStep <= stages.length;
  const terminalStatus = String(event.approvalStatus || event.status || "").trim().toLowerCase();
  const isTerminal = ["approved", "rejected", "revision", "cancelled"].includes(terminalStatus);
  const currentStep = hasRequestedStep
    ? requestedStep
    : isTerminal
      ? null
      : Math.max(1, stages.find((stage) => approvalStages[stage.id].status !== "approved")?.step || 1);
  if (hasRequestedStep) {
    stages.forEach((stage) => {
      if (stage.step < currentStep && ["review", "waiting"].includes(approvalStages[stage.id].status)) {
        approvalStages[stage.id].status = "approved";
      }
    });
  }
  if (currentStep !== null) {
    const currentStage = stages.find((stage) => stage.step === currentStep);
    if (currentStage && !["approved", "revision", "rejected"].includes(approvalStages[currentStage.id].status)) {
      approvalStages[currentStage.id].status = "review";
    }
    stages.forEach((stage) => {
      if (stage.step > currentStep && approvalStages[stage.id].status !== "approved") {
        approvalStages[stage.id].status = "waiting";
      }
    });
  }
  return { approvalStages, currentStep, stages, now };
}

function getWorkflowApprovalStage(stage) {
  const stageIdentity = {
    approvalStage: stage.id || stage.key,
    approvalRole: stage.label || stage.name,
    approverRole: stage.reviewer,
  };
  const exactMatch = getApprovalStageForProfile(stageIdentity);
  if (exactMatch) return exactMatch;

  const rawValues = [
    stageIdentity.approvalStage,
    stageIdentity.approvalRole,
    stageIdentity.approverRole,
  ].filter(Boolean).map(String);
  const normalizedValues = rawValues.map(normalizeApprovalKey);
  return APPROVAL_ACCOUNT_STAGES.find((workflowStage) =>
    [workflowStage.key, workflowStage.label, ...workflowStage.aliases].some((alias) => {
      const normalizedAlias = normalizeApprovalKey(alias);
      if (normalizedAlias.length <= 4) {
        const tokenPattern = new RegExp(`(^|[^a-z0-9])${normalizedAlias}([^a-z0-9]|$)`, "i");
        return rawValues.some((value) => tokenPattern.test(value));
      }
      return normalizedValues.some((value) => value.includes(normalizedAlias));
    }),
  ) || null;
}

function getCurrentFirestoreApprovalStage(normalized, uid) {
  const currentStage = normalized.stages.find(
    (stage) => stage.step === normalized.currentStep,
  );
  const stageRecord = currentStage && normalized.approvalStages[currentStage.id];
  if (!currentStage || !stageRecord || stageRecord.status !== "review") {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "This proposal is waiting on a different approval stage.",
    );
  }
  if (stageRecord.reviewerUid && stageRecord.reviewerUid !== uid) {
    throw new functions.https.HttpsError(
      "permission-denied",
      "This proposal is assigned to a different reviewer account.",
    );
  }
  return {
    stage: {
      key: currentStage.id,
      label: currentStage.label,
      step: currentStage.step,
    },
    stageRecord,
  };
}

function getEventTimestamp(value, date, time) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value instanceof Date) return value.getTime();
  if (value && typeof value.toMillis === "function") return value.toMillis();
  if (typeof value === "string" && /T.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) {
    const parsed = Date.parse(String(value));
    if (Number.isFinite(parsed)) return parsed;
  }

  const dateValue = String(date || value || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateValue)) return null;
  const timeValue = String(time || (typeof value === "string" ? value : "")).trim().split(/\s+-\s+/)[0];
  const match = timeValue.match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?$/i);
  if (match) {
    let hours = Number(match[1]);
    const minutes = Number(match[2] || 0);
    const meridiem = String(match[3] || "").toUpperCase();
    if (minutes <= 59 && hours <= 23 && (!meridiem || (hours >= 1 && hours <= 12))) {
      if (meridiem === "PM" && hours < 12) hours += 12;
      if (meridiem === "AM" && hours === 12) hours = 0;
      const timestamp = Date.parse(`${dateValue}T${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:00+08:00`);
      if (Number.isFinite(timestamp)) return timestamp;
    }
  }

  if (value) {
    const parsed = Date.parse(String(value));
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function getEventEndTimestamp(event) {
  const date = event.dateEnd || event.endDate || event.eventDate || event.date;
  const endAt = getEventTimestamp(
    event.endAt,
    date,
    event.timeEnd || event.endTime,
  );
  if (endAt) return endAt;

  const startAt = getEventTimestamp(
    event.startAt,
    event.dateStart || event.eventDate || event.date,
    event.timeStart || event.startTime,
  );
  return startAt ? startAt + 3 * 60 * 60 * 1000 : null;
}

function toRealtimeDatabaseValue(value) {
  if (value === undefined) return null;
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (value instanceof Date) return value.getTime();
  if (typeof value.toMillis === "function") return value.toMillis();
  if (Array.isArray(value)) return value.map(toRealtimeDatabaseValue);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .map(([key, entry]) => [key, toRealtimeDatabaseValue(entry)]),
    );
  }
  return null;
}

function buildPublishedEvent(eventId, event, publishedAt) {
  event = toRealtimeDatabaseValue(event) || {};
  const date = event.dateISO || event.date || event.dateStart || event.dateStartISO || "";
  const endDate = event.dateEnd || event.endDateISO || event.endDate || date;
  const timeParts = String(event.time || "").split(/\s+-\s+/);
  const timeStart = event.timeStart || timeParts[0] || "";
  const timeEnd = event.timeEnd || timeParts[1] || "";
  const startAt = getEventTimestamp(event.startAt, date, timeStart);
  const endAt = getEventTimestamp(event.endAt, endDate, timeEnd) ||
    (startAt ? startAt + 3 * 60 * 60 * 1000 : null);
  const eventName = event.eventName || event.name || event.title || "Untitled Event";
  const venue = event.venue || event.location || event.venueName || "PUP Biñan Campus";
  const approvalDocuments = Array.isArray(event.approvalDocuments) ? [...event.approvalDocuments] : [];
  if (typeof event.adminDocuments === "string" && event.adminDocuments.trim()) {
    const adminDocumentUrl = event.adminDocuments.trim();
    const alreadyIncluded = approvalDocuments.some((document) =>
      (typeof document === "string" ? document : document?.url || document?.downloadURL || document?.downloadUrl) === adminDocumentUrl,
    );
    if (!alreadyIncluded) approvalDocuments.push({ name: "Proposal documents", url: adminDocumentUrl });
  }

  return {
    ...event,
    id: eventId,
    eventId,
    name: eventName,
    title: eventName,
    eventName,
    date,
    dateISO: date,
    dateStart: date,
    dateEnd: endDate,
    eventEndDate: endDate,
    endDate,
    time: event.time || [timeStart, timeEnd].filter(Boolean).join(" - "),
    timeStart,
    timeEnd,
    ...(startAt ? { startAt } : {}),
    ...(endAt ? { endAt } : {}),
    venue,
    location: venue,
    category: event.category || event.categories || event.tag || "",
    description: event.description || event.eventDescription || "",
    organizerUid: event.organizerUid || event.organizerId || event.createdBy || "",
    organizerName: event.organizerName || event.organizer || "Event Organizer",
    source: event.source || event.eventSource || "Organizational",
    capacity: event.capacity !== undefined ? event.capacity : (event.maxCapacity || null),
    registeredCount: Number(event.registeredCount) || 0,
    approvalDocuments,
    participantDocuments: Array.isArray(event.participantDocuments)
      ? event.participantDocuments
      : (Array.isArray(event.attachments) ? event.attachments : []),
    status: "published",
    approvalStatus: "approved",
    published: true,
    isPublished: true,
    publishedAt,
  };
}

exports.approveFirestoreEvent = functions.region("asia-southeast1").https.onCall(async (data, context) => {
  try {
  if (!context.auth?.uid) {
    throw new functions.https.HttpsError("unauthenticated", "Sign in before approving proposals.");
  }

  const identity = await getAdminApprovalIdentity(context.auth);

  const eventId = String(data?.eventId || "").trim();
  if (!eventId || eventId.length > 150) {
    throw new functions.https.HttpsError("invalid-argument", "A valid event ID is required.");
  }

  const eventRef = admin.firestore().collection("events").doc(eventId);
  const historyRef = eventRef.collection("approvalHistory").doc();
  const now = Date.now();
  const caller = {
    uid: context.auth.uid,
    email: identity.email,
    name: identity.name,
  };

  const approvalResult = await admin.firestore().runTransaction(async (transaction) => {
    const eventSnapshot = await transaction.get(eventRef);
    if (!eventSnapshot.exists) {
      throw new functions.https.HttpsError("not-found", "The event proposal no longer exists.");
    }

    const event = eventSnapshot.data();
    assertOrganizationScopedApproval(
      identity,
      await getProposalOrganizationCode(event),
    );
    const rawStatus = String(event.status || "").trim().toLowerCase().replace(/[\s_-]+/g, " ");
    if (rawStatus !== "pending") {
      throw new functions.https.HttpsError("failed-precondition", "This proposal is no longer pending approval.");
    }
    const normalized = normalizeFirestoreApprovalStages(event, now);
    const { stage, stageRecord } = getCurrentFirestoreApprovalStage(normalized, caller.uid);

    stageRecord.status = "approved";
    stageRecord.approvedBy = caller.uid;
    stageRecord.approvedByName = caller.name;
    stageRecord.approvedByEmail = caller.email;
    stageRecord.approvedAt = now;
    stageRecord.updatedAt = now;
    stageRecord.note = "Approved.";

    const activeWorkflowStage = getWorkflowApprovalStage(stage);
    const workflowStages = normalized.stages.filter((candidate) =>
      candidate.required && getWorkflowApprovalStage(candidate),
    );
    const missingWorkflowStages = APPROVAL_ACCOUNT_STAGES.filter((workflowStage) =>
      !workflowStages.some((candidate) =>
        getWorkflowApprovalStage(candidate)?.key === workflowStage.key,
      ),
    );
    if (!activeWorkflowStage || missingWorkflowStages.length) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "This proposal does not have all four required approval stages configured.",
      );
    }
    const nextStage = workflowStages.find((candidate) => candidate.step > stageRecord.step);
    if (nextStage) {
      normalized.approvalStages[nextStage.id].status = "review";
      normalized.approvalStages[nextStage.id].updatedAt = now;
    }
    const isComplete = APPROVAL_ACCOUNT_STAGES.every((workflowStage) => {
      const configuredStage = workflowStages.find((candidate) =>
        getWorkflowApprovalStage(candidate)?.key === workflowStage.key,
      );
      return configuredStage &&
        normalized.approvalStages[configuredStage.id]?.status === "approved";
    });
    if (!isComplete && !nextStage) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "Earlier required approval stages must be completed before this proposal can advance.",
      );
    }
    const historyEntry = {
      action: "approved",
      stageId: stage.key,
      label: stage.label,
      by: caller.name,
      byEmail: caller.email,
      at: now,
      note: isComplete ? "Final approval completed." : "Approved and forwarded to the next reviewer.",
    };

    transaction.update(eventRef, {
      approvalSchemaVersion: 2,
      approvalStages: normalized.approvalStages,
      approvalStatus: isComplete ? "approved" : "pending",
      approvalCurrentStep: isComplete ? null : nextStage.step,
      approvalUpdatedAt: now,
      approvalHistory: admin.firestore.FieldValue.arrayUnion(historyEntry),
      status: isComplete ? "approved" : "pending",
      ...(isComplete
        ? {
            approvedBy: caller.uid,
            approvedByName: caller.name,
            approvedAt: now,
          }
        : {}),
      updatedAt: now,
    });
    transaction.set(historyRef, { ...historyEntry, eventId });

    return {
      success: true,
      eventId,
      approvedStage: stage.key,
      nextStage: nextStage?.id || null,
      complete: isComplete,
      event: isComplete
        ? {
            ...event,
            approvalStages: normalized.approvalStages,
            approvalStatus: "approved",
            approvalCurrentStep: null,
            status: "approved",
          }
        : null,
    };
  });

  const { event: _event, ...result } = approvalResult;
  return result;
  } catch (error) {
    if (error instanceof functions.https.HttpsError) throw error;
    console.error("[approveFirestoreEvent] Exact failure:", error);
    console.error("[approveFirestoreEvent] Failure context:", {
      uid: context.auth?.uid || null,
      eventId: String(data?.eventId || ""),
      code: error?.code || "unknown",
      message: error?.message || String(error),
      stack: error?.stack || null,
    });
    throw new functions.https.HttpsError(
      "internal",
      "Approval could not be completed. Please retry or contact support.",
    );
  }
});

exports.rejectFirestoreEvent = functions.region("asia-southeast1").https.onCall(async (data, context) => {
  if (!context.auth?.uid) {
    throw new functions.https.HttpsError("unauthenticated", "Sign in before rejecting proposals.");
  }

  const identity = await getAdminApprovalIdentity(context.auth);

  const eventId = String(data?.eventId || "").trim();
  const note = String(data?.note || "").trim();
  if (!eventId || eventId.length > 150) {
    throw new functions.https.HttpsError("invalid-argument", "A valid event ID is required.");
  }
  if (note.length < 3 || note.length > 1000) {
    throw new functions.https.HttpsError("invalid-argument", "A rejection note between 3 and 1000 characters is required.");
  }

  const eventRef = admin.firestore().collection("events").doc(eventId);
  const historyRef = eventRef.collection("approvalHistory").doc();
  const now = Date.now();
  const caller = { uid: context.auth.uid, email: identity.email, name: identity.name };

  return admin.firestore().runTransaction(async (transaction) => {
    const eventSnapshot = await transaction.get(eventRef);
    if (!eventSnapshot.exists) {
      throw new functions.https.HttpsError("not-found", "The event proposal no longer exists.");
    }

    const event = eventSnapshot.data();
    assertOrganizationScopedApproval(
      identity,
      await getProposalOrganizationCode(event),
    );
    if (String(event.status || "").trim().toLowerCase().replace(/[\s_-]+/g, " ") !== "pending") {
      throw new functions.https.HttpsError("failed-precondition", "This proposal is no longer pending approval.");
    }

    const normalized = normalizeFirestoreApprovalStages(event, now);
    const { stage, stageRecord } = getCurrentFirestoreApprovalStage(normalized, caller.uid);

    stageRecord.status = "rejected";
    stageRecord.rejectedBy = caller.uid;
    stageRecord.rejectedByName = caller.name;
    stageRecord.rejectedByEmail = caller.email;
    stageRecord.rejectedAt = now;
    stageRecord.updatedAt = now;
    stageRecord.note = note;
    const historyEntry = {
      action: "rejected",
      stageId: stage.key,
      label: stage.label,
      by: caller.name,
      byEmail: caller.email,
      at: now,
      note,
    };

    transaction.update(eventRef, {
      approvalSchemaVersion: 2,
      approvalStages: normalized.approvalStages,
      approvalStatus: "rejected",
      approvalCurrentStep: null,
      approvalUpdatedAt: now,
      approvalHistory: admin.firestore.FieldValue.arrayUnion(historyEntry),
      status: "rejected",
      rejectedBy: caller.uid,
      rejectedByName: caller.name,
      rejectedAt: now,
      rejectionNote: note,
      updatedAt: now,
    });
    transaction.set(historyRef, { ...historyEntry, eventId });

    return { success: true, eventId, rejectedStage: stage.key };
  });
});

exports.requestFirestoreEventRevision = functions.region("asia-southeast1").https.onCall(async (data, context) => {
  if (!context.auth?.uid) {
    throw new functions.https.HttpsError("unauthenticated", "Sign in before requesting proposal changes.");
  }

  const identity = await getAdminApprovalIdentity(context.auth);

  const eventId = String(data?.eventId || "").trim();
  const note = String(data?.note || "").trim();
  const fileId = String(data?.fileId || "").trim();
  if (!eventId || eventId.length > 150) {
    throw new functions.https.HttpsError("invalid-argument", "A valid event ID is required.");
  }
  if (note.length < 3 || note.length > 1000 || !fileId) {
    throw new functions.https.HttpsError("invalid-argument", "Select a document and provide a note between 3 and 1000 characters.");
  }

  const eventRef = admin.firestore().collection("events").doc(eventId);
  const historyRef = eventRef.collection("approvalHistory").doc();
  const now = Date.now();
  const caller = { uid: context.auth.uid, email: identity.email, name: identity.name };

  return admin.firestore().runTransaction(async (transaction) => {
    const eventSnapshot = await transaction.get(eventRef);
    if (!eventSnapshot.exists) {
      throw new functions.https.HttpsError("not-found", "The event proposal no longer exists.");
    }

    const event = eventSnapshot.data();
    assertOrganizationScopedApproval(
      identity,
      await getProposalOrganizationCode(event),
    );
    if (String(event.status || "").trim().toLowerCase().replace(/[\s_-]+/g, " ") !== "pending") {
      throw new functions.https.HttpsError("failed-precondition", "This proposal is no longer pending approval.");
    }

    const normalized = normalizeFirestoreApprovalStages(event, now);
    const { stage, stageRecord } = getCurrentFirestoreApprovalStage(normalized, caller.uid);

    stageRecord.status = "revision";
    stageRecord.revisionRequestedBy = caller.uid;
    stageRecord.revisionRequestedByName = caller.name;
    stageRecord.revisionRequestedByEmail = caller.email;
    stageRecord.revisionRequestedAt = now;
    stageRecord.updatedAt = now;
    stageRecord.note = note;
    stageRecord.fileId = fileId;
    const historyEntry = {
      action: "revision",
      stageId: stage.key,
      label: stage.label,
      by: caller.name,
      byEmail: caller.email,
      at: now,
      note,
      fileId,
    };

    transaction.update(eventRef, {
      approvalSchemaVersion: 2,
      approvalStages: normalized.approvalStages,
      approvalStatus: "revision",
      approvalCurrentStep: null,
      approvalUpdatedAt: now,
      approvalHistory: admin.firestore.FieldValue.arrayUnion(historyEntry),
      status: "revision",
      revisionRequestedBy: caller.uid,
      revisionRequestedByName: caller.name,
      revisionRequestedAt: now,
      revisionNote: note,
      revisionFileId: fileId,
      updatedAt: now,
    });
    transaction.set(historyRef, { ...historyEntry, eventId });

    return { success: true, eventId, revisionRequestedStage: stage.key };
  });
});

exports.syncApprovalStagesToFirestore = functions
  .region("asia-southeast1")
  .database.ref("/approvals/{eventId}")
  .onWrite(async (change, context) => {
    if (!change.after.exists()) return null;

    const approval = change.after.val() || {};
    const eventId = context.params.eventId;
    const eventSnapshot = await admin.database().ref(`events/${eventId}`).once("value");
    const event = eventSnapshot.val();
    if (!event) return null;
    const organizationCode = await getProposalOrganizationCode(event);

    const approvalStages = Object.fromEntries(
      Object.entries(approval.members || {}).map(([key, member]) => [
        key,
        {
        id: String(member.key || ""),
        key,
        label: String(member.label || member.key || "Approver"),
        step: Number(member.step) || 0,
        order: Number(member.stage) || Number(member.step) || 0,
        status: String(member.status || "wait"),
        note: String(member.note || ""),
        updatedAt: Number(member.updatedAt) || null,
        decidedBy: String(member.decidedBy || ""),
        },
      ]),
    );

    const eventRef = admin.firestore().collection("events").doc(eventId);
    await eventRef.set(
      {
        ...event,
        id: eventId,
        eventId,
        title: event.title || event.name || "Untitled Event",
        location: event.location || event.venue || "",
        createdBy: event.createdBy || event.organizerUid || event.organizerId || "",
        ...(organizationCode
          ? {
              organizationCode,
              organizerOrganization: organizationCode,
            }
          : {}),
        approvalSchemaVersion: 1,
        approvalStages,
        approvalStatus: String(approval.status || event.status || "pending"),
        approvalCurrentStep: Number(approval.currentStep) || null,
        approvalSubmittedAt: Number(approval.submittedAt) || null,
        approvalUpdatedAt: Date.now(),
        updatedAt: Date.now(),
      },
      { merge: true },
    );

    const history = approval.history || {};
    await Promise.all(
      Object.entries(history).map(([historyId, entry]) =>
        eventRef.collection("approvalHistory").doc(historyId).set({
          ...entry,
          eventId,
        }),
      ),
    );
    return null;
  });

async function ensureApproverDirectory() {
  try {
    const dirRef = admin.database().ref("approverDirectory");
    const snap = await dirRef.once("value");
    if (!snap.exists()) {
      await dirRef.set(APPROVER_DIRECTORY);
    }
  } catch (err) {
    console.warn("Could not seed approverDirectory:", err);
  }
}

async function verifyOrganizerEventOwnership(authData, eventId) {
  if (!authData || !authData.uid) {
    throw new functions.https.HttpsError("unauthenticated", "Caller must be authenticated.");
  }
  const roleSnap = await admin.database().ref(`roles/${authData.uid}`).once("value");
  const role = roleSnap.val();
  if (role !== "event_organizer" && role !== "teacher" && role !== "admin") {
    throw new functions.https.HttpsError("permission-denied", "You do not have permission to manage this event.");
  }
  const eventSnap = await admin.database().ref(`events/${eventId}`).once("value");
  const eventData = eventSnap.val();
  if (!eventData) {
    throw new functions.https.HttpsError("not-found", "The specified event does not exist.");
  }
  if (role !== "admin" && (eventData.organizerUid || eventData.organizerId) !== authData.uid) {
    throw new functions.https.HttpsError("permission-denied", "You can only view or manage your own events.");
  }
  if (role === "admin") {
    const identity = await getAdminApprovalIdentity(authData);
    assertOrganizationScopedApproval(
      identity,
      await getProposalOrganizationCode(eventData),
    );
  }
  return { role, eventData };
}

function getProposalNotificationAudience(eventData) {
  const audience = normalizeApprovalKey(eventData.targetAudience);
  const openForAll = eventData.openForAll === true || audience.startsWith("opentoall");
  const organizationCodes = new Set();
  const departmentCodes = new Set();
  getNotificationProfileValues(eventData, [
    "organizationCode",
    "organizationId",
    "orgCode",
    "orgId",
    "organizerOrganization",
    "organization",
    "organizationName",
    "orgName",
  ]).forEach((code) => organizationCodes.add(code));
  const addScopeValues = (target, values) => {
    (Array.isArray(values) ? values : values ? [values] : []).forEach((value) => {
      if (Array.isArray(value)) {
        addScopeValues(target, value);
        return;
      }
      if (typeof value === "string") {
        const code = value.trim().replace(/\s+/g, " ").toUpperCase();
        if (code) target.add(code);
      } else if (value && typeof value === "object") {
        [
          value.organizationCode,
          value.organizationId,
          value.orgCode,
          value.orgId,
          value.departmentCode,
          value.departmentId,
          value.code,
          value.id,
          value.value,
          value.name,
          value.label,
          value.subtitle,
        ].forEach((item) => {
          const code = String(item || "").trim().replace(/\s+/g, " ").toUpperCase();
          if (code) target.add(code);
        });
      }
    });
  };

  const partners = [
    ...(Array.isArray(eventData.partnerOrganizations) ? eventData.partnerOrganizations : []),
    ...(Array.isArray(eventData.targetOrganizations) ? eventData.targetOrganizations : []),
  ];
  if (eventData.isCollaboration === true || partners.length > 0) {
    addScopeValues(organizationCodes, partners);
  }

  addScopeValues(departmentCodes, [
    eventData.targetDepartments,
    eventData.targetDepartment,
    eventData.targetDepartmentIds,
    eventData.departments,
  ]);
  return {
    openForAll,
    organizationCodes: [...organizationCodes],
    departmentCodes: [...departmentCodes],
  };
}

function getNotificationProfileValues(profile, keys) {
  const values = [];
  keys.forEach((key) => {
    const value = profile?.[key];
    (Array.isArray(value) ? value : [value]).forEach((entry) => {
      if (typeof entry === "string") {
        values.push(entry);
      } else if (entry && typeof entry === "object") {
        [
          entry.organizationCode,
          entry.organizationId,
          entry.orgCode,
          entry.orgId,
          entry.departmentCode,
          entry.departmentId,
          entry.code,
          entry.id,
          entry.value,
          entry.name,
          entry.label,
        ].filter(Boolean).forEach((item) => values.push(item));
      }
    });
  });
  return [...new Set(values.map((value) => String(value).trim().replace(/\s+/g, " ").toUpperCase()).filter(Boolean))];
}

async function createAdminProposalNotifications(eventId, eventData, type, message, notificationKey) {
  const { openForAll, organizationCodes, departmentCodes } =
    getProposalNotificationAudience(eventData);
  const adminProfiles = await admin.firestore().collection("adminUser").get();
  const recipients = (await Promise.all(adminProfiles.docs.map(async (snapshot) => {
    const profile = snapshot.data() || {};
    const role = normalizeApprovalKey(profile.role || profile.userRole);
    const status = String(profile.status || "active").trim().toLowerCase();
    const activeAdmin = ["admin", "superadmin"].includes(role) &&
      !["disabled", "inactive", "suspended"].includes(status);
    if (!activeAdmin || openForAll) return activeAdmin ? snapshot : null;

    let profileOrganizationCodes = getNotificationProfileValues(profile, [
      "organizationCode",
      "organizationId",
      "orgCode",
      "orgId",
      "organization",
      "organizationName",
      "orgName",
      "organizations",
      "courseOrganization",
      "courseOrganizations",
    ]);
    let profileDepartmentCodes = getNotificationProfileValues(profile, [
      "departmentCode",
      "departmentId",
      "department",
      "departments",
      "course",
      "departmentIds",
    ]);
    if (!profileOrganizationCodes.length) {
      const approverOrganization = await admin.firestore()
        .collection("approverOrganizations")
        .doc(snapshot.id)
        .get();
      if (approverOrganization.exists) {
        profileOrganizationCodes = getNotificationProfileValues(
          approverOrganization.data(),
            [
              "organizationCode",
              "organizationId",
              "orgCode",
              "orgId",
              "organization",
              "organizationName",
              "orgName",
            ],
          );
      }
    }
    const matchesOrganization = organizationCodes.some((code) =>
      profileOrganizationCodes.includes(code),
    );
    const matchesDepartment = departmentCodes.some((code) =>
      profileDepartmentCodes.includes(code),
    );
    return (organizationCodes.length ? matchesOrganization : matchesDepartment)
      ? snapshot
      : null;
  }))).filter(Boolean);
  if (!recipients.length) return;

  const eventName = String(eventData.eventName || eventData.title || eventData.name || "Untitled event");
  await Promise.all(recipients.map(async (recipient) => {
    const notificationId = `${eventId}_${type}_${notificationKey}_${recipient.id}`
      .replace(/[^a-zA-Z0-9_-]/g, "_")
      .slice(0, 140);
    const notificationRef = admin.firestore().collection("notifications").doc(notificationId);
    try {
      await notificationRef.create({
        recipientUid: recipient.id,
        eventId: String(eventId),
        eventName,
        organizationCodes,
        departmentCodes,
        openForAll,
        type,
        title: ({
          "proposal-submitted": "New Event Proposal",
          "proposal-resubmitted": "Proposal Resubmitted",
          "proposal-reminder": "Approver Reminder",
          "proposal-cancelled": "Proposal Cancelled",
          "proposal-approved": "Proposal Approved",
        })[type] || "Proposal Update",
        message: String(message),
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        read: false,
      });
    } catch (error) {
      if (error.code !== 6 && error.code !== "already-exists") throw error;
    }
  }));
}

async function isEventOrganizerProposal(eventData) {
  const uid = String(eventData.organizerUid || eventData.organizerId || eventData.createdBy || "");
  const declaredRole = normalizeApprovalKey(
    eventData.createdByRole || eventData.creatorRole || "",
  );
  if (!uid) return false;
  if (["eventorganizer", "organizer", "eo"].includes(declaredRole)) return true;

  const [roleSnapshot, organizerProfile, adminProfile] = await Promise.all([
    admin.database().ref(`roles/${uid}`).once("value"),
    admin.firestore().collection("eventOrganizations").doc(uid).get(),
    admin.firestore().collection("adminUser").doc(uid).get(),
  ]);
  const profileRole = normalizeApprovalKey(
    (adminProfile.exists ? adminProfile.data()?.role || adminProfile.data()?.userRole : "") ||
    (organizerProfile.exists ? organizerProfile.data()?.role || organizerProfile.data()?.userRole : ""),
  );
  return ["eventorganizer", "organizer", "eo"].includes(normalizeApprovalKey(roleSnapshot.val())) ||
    ["eventorganizer", "organizer", "eo"].includes(profileRole) ||
    organizerProfile.exists;
}

exports.notifyAdminsOfProposalSubmission = functions.region("asia-southeast1")
  .firestore.document("events/{eventId}")
  .onCreate(async (snapshot, context) => {
    const eventData = snapshot.data() || {};
    if (!["pending", "pending approval", "pending_approval"].includes(
      String(eventData.status || eventData.approvalStatus || "").trim().toLowerCase(),
    )) return;
    if (!await isEventOrganizerProposal(eventData)) return;

    const eventName = String(eventData.eventName || eventData.title || eventData.name || "Untitled event");
    let resubmission = false;
    if (eventData.resubmissionOf) {
      const originalSnapshot = await admin.firestore()
        .collection("events")
        .doc(String(eventData.resubmissionOf))
        .get();
      const original = originalSnapshot.exists ? originalSnapshot.data() || {} : {};
      const originalStatuses = [
        original.status,
        original.approvalStatus,
        ...(Array.isArray(original.approvalStages)
          ? original.approvalStages
          : Object.values(original.approvalStages || {}))
          .flatMap((stage) => [stage?.status, stage?.approvalStatus, stage?.decision]),
      ].map((status) => String(status || "").trim().toLowerCase().replace(/[\s_-]+/g, " "));
      const originalOwner = String(original.organizerUid || original.organizerId || original.createdBy || "");
      const newOwner = String(eventData.organizerUid || eventData.organizerId || eventData.createdBy || "");
      resubmission = originalStatuses.some((status) =>
        ["rejected", "revision", "changes requested"].includes(status),
      ) &&
        originalOwner !== "" && originalOwner === newOwner;
    }
    const type = resubmission ? "proposal-resubmitted" : "proposal-submitted";
    const message = resubmission
      ? `“${eventName}” was resubmitted for review.`
      : `“${eventName}” was submitted for approval.`;
    await createAdminProposalNotifications(
      context.params.eventId,
      eventData,
      type,
      message,
      "submitted",
    );
  });

exports.notifyAdminsOfProposalUpdates = functions.region("asia-southeast1")
  .firestore.document("events/{eventId}")
  .onUpdate(async (change, context) => {
    const before = change.before.data() || {};
    const after = change.after.data() || {};
    if (!await isEventOrganizerProposal(after)) return;

    const beforeStatus = String(before.status || before.approvalStatus || "").trim().toLowerCase().replace(/[\s_-]+/g, " ");
    const afterStatus = String(after.status || after.approvalStatus || "").trim().toLowerCase().replace(/[\s_-]+/g, " ");
    const eventName = String(after.eventName || after.title || after.name || "Untitled event");
    const historyBefore = Array.isArray(before.approvalHistory) ? before.approvalHistory : [];
    const historyAfter = Array.isArray(after.approvalHistory) ? after.approvalHistory : [];
    const latestHistory = historyAfter[historyAfter.length - 1] || {};

    if (
      ["approved", "published"].includes(afterStatus) &&
      !["approved", "published"].includes(beforeStatus)
    ) {
      await createAdminProposalNotifications(
        context.params.eventId,
        after,
        "proposal-approved",
        `“${eventName}” was approved.`,
        String(change.after.updateTime.toMillis()),
      );
      return;
    }

    if (afterStatus === "cancelled" && beforeStatus !== "cancelled") {
      await createAdminProposalNotifications(
        context.params.eventId,
        after,
        "proposal-cancelled",
        `“${eventName}” was cancelled by the Event Organizer.`,
        after.cancelledAt || String(change.after.updateTime.toMillis()),
      );
      return;
    }

    if (
      historyAfter.length > historyBefore.length &&
      String(latestHistory.action || "").toLowerCase() === "reminded"
    ) {
      await createAdminProposalNotifications(
        context.params.eventId,
        after,
        "proposal-reminder",
        `The Event Organizer sent a reminder for “${eventName}”.`,
        latestHistory.at || String(change.after.updateTime.toMillis()),
      );
      return;
    }

    if (
      ["rejected", "revision", "changes requested"].includes(beforeStatus) &&
      ["pending", "pending approval", "pending_approval"].includes(afterStatus)
    ) {
      await createAdminProposalNotifications(
        context.params.eventId,
        after,
        "proposal-resubmitted",
        `“${eventName}” was resubmitted for review.`,
        String(change.after.updateTime.toMillis()),
      );
    }
  });

exports.getApproverDirectory = functions.region("asia-southeast1").https.onCall(async (data, context) => {
  await ensureApproverDirectory();
  const dirSnap = await admin.database().ref("approverDirectory").once("value");
  return (dirSnap.val() || APPROVER_DIRECTORY);
});

const PROPOSAL_VENUES = {
  "Open Field | PUP Biñan": { maxCapacity: 500, type: "outdoor" },
  "AVR1 | PUP Biñan": { maxCapacity: 150, type: "indoor" },
  "AVR2 | PUP Biñan": { maxCapacity: 100, type: "indoor" },
  "AVR2-1Room | PUP Biñan": { maxCapacity: 40, type: "indoor" },
  "AVR2-2Room | PUP Biñan": { maxCapacity: 40, type: "indoor" },
  "AVR2-3Room | PUP Biñan": { maxCapacity: 40, type: "indoor" },
  "Kiosk | PUP Biñan": { maxCapacity: 50, type: "outdoor" },
  "Open Field | PUP CITE": { maxCapacity: 500, type: "outdoor" },
  "4th Floor | PUP CITE": { maxCapacity: 200, type: "indoor" },
  "Others | Inside PUP": { maxCapacity: 100, type: "indoor" },
  "Others | Outside PUP": { maxCapacity: 200, type: "outdoor" },
  "Online / Virtual": { maxCapacity: 1000, type: "online" },
};

function manilaDateString(timestamp = Date.now()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(timestamp);
}

function parseTimeMinutes(value) {
  const match = /^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i.exec(String(value || "").trim());
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  if (minute > 59 || hour > 23) return null;
  if (match[3]) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (match[3].toUpperCase() === "PM" ? 12 : 0);
  }
  return hour * 60 + minute;
}

function manilaTimestamp(dateValue, timeValue) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateValue || ""))) return NaN;
  const minutes = parseTimeMinutes(timeValue);
  if (minutes === null) return NaN;
  return Date.parse(`${dateValue}T${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}:00+08:00`);
}

function parseStoredEventTime(value, dateFallback, timeFallback) {
  if (typeof value === "number") return value;
  const text = String(value || "").trim();
  if (!text) return dateFallback && timeFallback ? manilaTimestamp(dateFallback, timeFallback) : NaN;
  const fullMatch = /^(\d{4}-\d{2}-\d{2})[ T](.+)$/.exec(text);
  if (fullMatch) return manilaTimestamp(fullMatch[1], fullMatch[2]);
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? NaN : parsed;
}

function proposalFieldErrors(data, existingEvents, now = Date.now()) {
  const errors = [];
  const add = (field, message) => errors.push({ field, message });
  const name = String(data.eventName || data.name || data.title || "").trim();
  const categories = Array.isArray(data.categories)
    ? data.categories
    : String(data.category || "").split(",").map((item) => item.trim()).filter(Boolean);
  const date = String(data.date || data.dateISO || data.eventDate || "").slice(0, 10);
  const endDate = String(data.dateEnd || data.endDate || data.endDateISO || date).slice(0, 10);
  const timeStart = String(data.timeStart || "").trim();
  const timeEnd = String(data.timeEnd || "").trim();
  const startMinutes = parseTimeMinutes(timeStart);
  const endMinutes = parseTimeMinutes(timeEnd);
  const venue = String(data.venue || data.location || "").trim();
  const venueInfo = PROPOSAL_VENUES[venue];
  const registrationStart = Date.parse(`${String(data.registrationStart || "")}+08:00`);
  const registrationEndValue = data.registrationEnd || data.registrationDeadline || "";
  const registrationEnd = Date.parse(`${String(registrationEndValue).replace(" ", "T")}:00+08:00`);
  const approvalDocuments = Array.isArray(data.approvalDocuments) ? data.approvalDocuments : [];
  const capacity = Number(data.maxCapacity ?? data.capacity);

  if (name.length < 3 || name.length > 120) add("eventName", "Event name must be between 3 and 120 characters.");
  if (categories.length < 1 || categories.length > 3) add("category", "Choose between 1 and 3 event categories.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < manilaDateString(now)) {
    add("eventDate", "Choose an event date that is today or later.");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(endDate) || endDate < date) add("eventDateEnd", "The event end date cannot be before its start date.");
  if (startMinutes === null || startMinutes < 480 || startMinutes > 1200) add("timeStart", "Start time must be between 8:00 AM and 8:00 PM.");
  if (endMinutes === null || endMinutes < 480 || endMinutes > 1200) add("timeEnd", "End time must be between 8:00 AM and 8:00 PM.");
  const startAtMs = manilaTimestamp(date, timeStart);
  const endAtMs = manilaTimestamp(endDate, timeEnd);
  if (Number.isFinite(startAtMs) && startAtMs < now) add("timeStart", "Start time must be in the future.");
  if (Number.isFinite(startAtMs) && Number.isFinite(endAtMs) && endAtMs <= startAtMs) add("timeEnd", "End time must be after the start time.");
  if (!venueInfo) add("venue", "Choose a valid venue.");
  if (!Number.isInteger(capacity) || capacity < 1 || (venueInfo && capacity > venueInfo.maxCapacity)) {
    add("maxCapacity", venueInfo
      ? `Capacity must be a whole number from 1 to ${venueInfo.maxCapacity}.`
      : "Capacity must be a positive whole number.");
  }
  if (!data.registrationStart || !Number.isFinite(registrationStart)) add("registrationStart", "Enter a valid registration start date and time.");
  if (!registrationEndValue || !Number.isFinite(registrationEnd)) add("registrationEnd", "Enter a valid registration deadline.");
  if (Number.isFinite(registrationStart) && Number.isFinite(registrationEnd) && registrationStart >= registrationEnd) {
    add("registrationEnd", "Registration must end after it starts.");
  }
  const eventDayEnd = Date.parse(`${endDate}T23:59:59+08:00`);
  if (Number.isFinite(registrationEnd) && Number.isFinite(eventDayEnd) && registrationEnd > eventDayEnd) {
    add("registrationEnd", "Registration deadline cannot be after the event date.");
  }
  const partners = Array.isArray(data.partnerOrganizations) ? data.partnerOrganizations : [];
  if (data.isCollaboration && partners.length < 1) add("partnerOrganizations", "Choose at least one additional department for a collaboration.");
  if (String(data.targetYear || "") === "Specified" && (!Array.isArray(data.targetYears) || data.targetYears.length < 1)) {
    add("targetYear", "Choose at least one target year.");
  }
  if (venueInfo?.type === "outdoor" && !String(data.weatherContingency || "").trim()) {
    add("weatherContingency", "Add a weather contingency plan for this outdoor venue.");
  }
  const contactName = String(data.contactPerson?.name || data.contactName || "").trim();
  const contactEmail = String(data.contactPerson?.email || data.contactEmail || "").trim();
  if (!contactName) add("contactName", "Enter the contact person's name.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)) add("contactEmail", "Enter a valid contact email address.");
  if (!approvalDocuments.some((document) => document && String(document.name || "").trim())) {
    add("approvalDocs", "Attach at least one required approval document.");
  }

  if (venueInfo && Number.isFinite(startAtMs) && Number.isFinite(endAtMs)) {
    const newVenueKey = venue.startsWith("Others |")
      ? `${venue}|${String(data.customVenueName || "").trim().toLowerCase()}|${String(data.customVenueAddress || "").trim().toLowerCase()}`
      : venue.toLowerCase();
    const conflict = existingEvents.some((event) => {
      if (!event || ["draft", "cancelled", "canceled", "rejected"].includes(String(event.status || "").toLowerCase())) return false;
      const currentVenue = String(event.venue || event.location || "").trim();
      const currentVenueKey = currentVenue.startsWith("Others |")
        ? `${currentVenue}|${String(event.customVenueName || event.venueName || "").trim().toLowerCase()}|${String(event.customVenueAddress || event.venueAddress || "").trim().toLowerCase()}`
        : currentVenue.toLowerCase();
      if (!currentVenueKey || currentVenueKey !== newVenueKey) return false;
      const oldDate = String(event.date || event.dateISO || event.eventDate || "").slice(0, 10);
      const oldStart = parseStoredEventTime(event.startAt, oldDate, event.timeStart);
      const oldEnd = parseStoredEventTime(event.endAt, oldDate, event.timeEnd);
      return Number.isFinite(oldStart) && Number.isFinite(oldEnd) && startAtMs < oldEnd && endAtMs > oldStart;
    });
    if (conflict) add("venue", "This venue is already booked during the selected date and time.");
  }
  return errors;
}

async function getEventCreatorIdentity(uid, role, authData) {
  const [userSnap, adminProfileSnap, firestoreUserSnap, authUser] = await Promise.all([
    admin.database().ref(`users/${uid}`).once("value"),
    admin.firestore().collection("adminUser").doc(uid).get(),
    admin.firestore().collection("users").doc(uid).get(),
    admin.auth().getUser(uid),
  ]);
  const account = {
    ...(userSnap.val() || {}),
    ...(firestoreUserSnap.exists ? firestoreUserSnap.data() : {}),
    ...(adminProfileSnap.exists ? adminProfileSnap.data() : {}),
  };
  const fullName = [account.firstName, account.middleName, account.lastName].filter(Boolean).join(" ").trim();
  const organizationCode = role === "event_organizer" ? getOrganizationCode(account) : "";
  const organizerName = role === "event_organizer"
    ? String(account.organization || account.organizationName || account.orgName || "").trim()
    : String(account.fullName || account.name || fullName || authUser.displayName || authData.token?.name || "").trim();
  if (role === "event_organizer" && !organizationCode) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "Your organizer profile must have an organization assigned before submitting a proposal.",
    );
  }
  if (!organizerName) {
    throw new functions.https.HttpsError("failed-precondition", "Your account profile is missing the name required to create an event. Update your profile and try again.");
  }
  return {
    organizerName,
    organizationCode,
    source: role === "event_organizer" ? "Organizational" : "Teacher / Faculty",
  };
}

async function verifyEventCreator(authData) {
  if (!authData || !authData.uid) throw new functions.https.HttpsError("unauthenticated", "Sign in before creating an event.");
  const roleSnap = await admin.database().ref(`roles/${authData.uid}`).once("value");
  const role = roleSnap.val();
  if (role !== "event_organizer" && role !== "teacher") {
    throw new functions.https.HttpsError("permission-denied", "Only event organizers and teachers can create events.");
  }
  return role;
}

function validateDraftId(draftId) {
  return typeof draftId === "string" && /^[A-Za-z0-9_-]{1,120}$/.test(draftId);
}

exports.saveEventDraft = functions.region("asia-southeast1").https.onCall(async (data, context) => {
  const role = await verifyEventCreator(context.auth);
  data = data || {};
  const name = String(data.eventName || data.name || data.title || "").trim();
  if (name.length < 3 || name.length > 120) {
    throw new functions.https.HttpsError("invalid-argument", "Event name must be between 3 and 120 characters.", {
      fields: [{ field: "eventName", message: "Event name must be between 3 and 120 characters." }],
    });
  }
  const uid = context.auth.uid;
  const draftId = data.draftId ? data.draftId : `draft_${Date.now()}_${crypto.randomBytes(5).toString("hex")}`;
  if (!validateDraftId(draftId)) throw new functions.https.HttpsError("invalid-argument", "Draft ID is invalid.");
  const rootRef = admin.database().ref();
  const draftRef = rootRef.child(`drafts/${uid}/${draftId}`);
  const existing = await draftRef.once("value");
  if (!existing.exists()) {
    const draftsSnap = await rootRef.child(`drafts/${uid}`).once("value");
    if (Object.keys(draftsSnap.val() || {}).length >= 20) {
      throw new functions.https.HttpsError("resource-exhausted", "You can keep up to 20 drafts. Delete a draft before saving another.");
    }
  }
  const identity = await getEventCreatorIdentity(uid, role, context.auth);
  const draft = { ...data };
  delete draft.draftId;
  delete draft.organizerUid;
  delete draft.createdByRole;
  delete draft.organizerName;
  delete draft.organizerId;
  delete draft.createdBy;
  draft.name = name;
  draft.eventName = name;
  draft.status = "draft";
  draft.source = identity.source;
  draft.organizerName = identity.organizerName;
  draft.organizerUid = uid;
  draft.createdByRole = role;
  draft.updatedAt = Date.now();
  if (!existing.exists()) draft.createdAt = draft.updatedAt;
  await draftRef.set(draft);
  return ({ draftId });
});

exports.rebuildOrganizerEventsIndex = functions.region("asia-southeast1").https.onCall(async (data, context) => {
  if (!context.auth || !context.auth.uid) {
    throw new functions.https.HttpsError("unauthenticated", "Sign in before performing this action.");
  }
  const roleSnap = await admin.database().ref(`roles/${context.auth.uid}`).once("value");
  if (roleSnap.val() !== "admin") {
    throw new functions.https.HttpsError("permission-denied", "Only administrators can rebuild the organizer events index.");
  }
  const identity = await getAdminApprovalIdentity(context.auth);
  const { confirmed } = data || {};
  if (confirmed !== true) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "Action requires explicit confirmation. Pass { confirmed: true } to proceed."
    );
  }

  const rootRef = admin.database().ref();
  const eventsSnap = await rootRef.child("events").once("value");
  const events = eventsSnap.val() || {};
  const updates = {};
  let count = 0;

  for (const [eventId, event] of Object.entries(events)) {
    if (!event) continue;
    const uid = event.organizerUid || event.organizerId;
    if (uid && typeof uid === "string") {
        if (identity?.stage?.key === "org_adv" &&
            await getProposalOrganizationCode(event) !== identity.organizationCode) {
          continue;
        }
        updates[`organizerEvents/${uid}/${eventId}`] = true;
        count++;
      }
  }

  if (Object.keys(updates).length > 0) {
    await rootRef.update(updates);
  }

  return ({ success: true, indexedEventsCount: count });
});

/**
 * 6. createEventProposal({ clientRequestId, draftId?, ...form })
 */
exports.createEventProposal = functions.region("asia-southeast1").https.onCall(async (data, context) => {
  const role = await verifyEventCreator(context.auth);
  await ensureApproverDirectory();
  const uid = context.auth.uid;
  data = data || {};
  const requestId = String(data.clientRequestId || "").trim();
  if (!requestId || requestId.length > 120) {
    throw new functions.https.HttpsError("invalid-argument", "A submission request ID is required.");
  }
  const requestKey = crypto.createHash("sha256").update(requestId).digest("hex");
  const rootRef = admin.database().ref();
  const requestRef = rootRef.child(`eventRequestIds/${uid}/${requestKey}`);
  const priorEventId = (await requestRef.once("value")).val();
  if (typeof priorEventId === "string") {
    return ({ eventId: priorEventId });
  }

  const requestedEventId = String(data.eventId || "").trim();
  if (requestedEventId && !/^[A-Za-z0-9_-]{1,120}$/.test(requestedEventId)) {
    throw new functions.https.HttpsError("invalid-argument", "Event ID is invalid.");
  }

  const now = Date.now();
  const eventsSnap = await rootRef.child("events").once("value");
  const existingEvents = Object.entries(eventsSnap.val() || {});
  if (requestedEventId) {
    const directEvent = existingEvents.find(([eventId]) => eventId === requestedEventId)?.[1];
    if (
      !directEvent ||
      directEvent.organizerUid !== uid ||
      directEvent.status !== "pending" ||
      directEvent.clientRequestId !== requestId
    ) {
      throw new functions.https.HttpsError("failed-precondition", "The event could not be verified for submission.");
    }
  }
  const errors = proposalFieldErrors(
    data,
    existingEvents
      .filter(([eventId]) => eventId !== requestedEventId)
      .map(([, event]) => event),
    now,
  );
  if (errors.length) {
    throw new functions.https.HttpsError("invalid-argument", "Please fix the highlighted fields before submitting.", { fields: errors });
  }
  if (data.draftId && !validateDraftId(data.draftId)) {
    throw new functions.https.HttpsError("invalid-argument", "Draft ID is invalid.");
  }
  const draftRef = data.draftId ? rootRef.child(`drafts/${uid}/${data.draftId}`) : null;
  const draftSnap = draftRef ? await draftRef.once("value") : null;
  if (data.draftId && !draftSnap.exists()) {
    throw new functions.https.HttpsError("invalid-argument", "This draft is no longer available. Save it again before submitting.");
  }

  const limitRef = rootRef.child(`eventSubmissionLimits/${uid}`);
  const limitResult = await limitRef.transaction((current) => {
    const recent = (Array.isArray(current) ? current : []).filter((timestamp) => Number(timestamp) > now - 60 * 60 * 1000);
    if (recent.length >= 10) return;
    recent.push(now);
    return recent;
  });
  if (!limitResult.committed) {
    throw new functions.https.HttpsError("resource-exhausted", "You are submitting too fast. Try again in a few minutes.");
  }

  const identity = await getEventCreatorIdentity(uid, role, context.auth);
  const settings = await getSystemSettingsData();
  const configuredStages = settings.approvalStages;
  const directorySnap = await rootRef.child("approverDirectory").once("value");
  const directory = directorySnap.val() || APPROVER_DIRECTORY;
  const submittedApprovers = new Set(Array.isArray(data.approvers) ? data.approvers.map(String) : []);
  const stageList = configuredStages?.length
    ? configuredStages.map((stage, index) => ({
        id: String(stage.id || `stage-${index + 1}`),
        label: String(stage.name || `Stage ${index + 1}`),
        reviewer: String(stage.reviewer || stage.name || ""),
        required: stage.required !== false,
        order: index + 1,
        uid: stage.uid || stage.reviewerUid || stage.userId || "",
      })).filter((stage) => stage.required || submittedApprovers.has(stage.id))
      .sort((first, second) => first.order - second.order)
      .map((stage, index) => ({ ...stage, order: index + 1 }))
    : Object.entries(directory).map(([id, stage], index) => ({
        id,
        label: String(stage.label || stage.name || id),
        reviewer: String(stage.reviewer || stage.label || stage.name || id),
        required: Boolean(stage.required),
        order: Number(stage.stage) || index + 1,
        uid: stage.uid || stage.reviewerUid || "",
      })).filter((stage) => stage.required || stage.defaultOn || submittedApprovers.has(stage.id));
  if (!stageList.length) throw new functions.https.HttpsError("failed-precondition", "No approval stages are configured. Contact an administrator.");
  stageList.sort((first, second) => first.order - second.order);

  const firstStage = stageList[0];
  const firstStageApproval = getApprovalStageForProfile({
    approvalStage: firstStage.id,
    approvalRole: firstStage.reviewer,
  });
  if (firstStageApproval?.key === "org_adv") {
    firstStage.uid = await findOrganizationAdviserUid(identity.organizationCode);
    if (!firstStage.uid) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        `No active Organization Adviser is assigned to ${identity.organizationCode}.`,
      );
    }
  }

  const eventId = requestedEventId || `ev_${now}_${crypto.randomBytes(5).toString("hex")}`;
  const eventName = String(data.eventName || data.name || data.title).trim();
  const venue = String(data.venue || data.location).trim();
  const date = String(data.date || data.dateISO || data.eventDate).slice(0, 10);
  const dateEnd = String(data.dateEnd || data.endDate || data.endDateISO || date).slice(0, 10);
  const timeStart = String(data.timeStart).trim();
  const timeEnd = String(data.timeEnd).trim();
  const startAt = `${date} ${timeStart}`;
  const endAt = `${dateEnd} ${timeEnd}`;
  const eventPayload = {
    ...data,
    id: eventId,
    eventId,
    name: eventName,
    title: eventName,
    venue,
    location: venue,
    category: Array.isArray(data.categories) ? data.categories.join(", ") : String(data.category || ""),
    startAt,
    endAt,
    organizerUid: uid,
    createdByRole: role,
    organizerName: identity.organizerName,
    ...(identity.organizationCode
      ? {
          organizationCode: identity.organizationCode,
          organizerOrganization: identity.organizationCode,
        }
      : {}),
    source: identity.source,
    organizerId: uid,
    createdBy: uid,
    creatorRole: role === "event_organizer" ? "Event Organizer" : "Teacher",
    status: "pending",
    approvalStatus: "pending",
    approvalCurrentStep: 1,
    approvalStages: stageList.map((stage, index) => ({
      id: stage.id,
      key: stage.id,
      name: stage.label,
      label: stage.label,
      reviewer: stage.reviewer,
      ...(stage.uid ? { reviewerUid: stage.uid } : {}),
      required: stage.required,
      step: index + 1,
      status: index === 0 ? "review" : "waiting",
      updatedAt: now,
    })),
    createdAt: now,
    updatedAt: now,
  };
  delete eventPayload.clientRequestId;
  delete eventPayload.draftId;

  const members = {};
  stageList.forEach((stage, index) => {
    members[stage.id] = {
      key: stage.id,
      label: stage.reviewer || stage.label,
      stage: stage.order,
      step: index + 1,
      ...(stage.uid ? { uid: stage.uid } : {}),
      status: index === 0 ? "review" : "wait",
      note: index === 0 ? "Reviewing proposal." : "",
      updatedAt: now,
    };
  });
  const approvalFiles = {};
  (Array.isArray(data.approvalDocuments) ? data.approvalDocuments : []).forEach((file, index) => {
    if (!file || !String(file.name || "").trim()) return;
    const fileId = `file_${index + 1}_${crypto.randomBytes(2).toString("hex")}`;
    approvalFiles[fileId] = {
      id: fileId,
      name: String(file.name).slice(0, 255),
      path: String(file.path || file.url || "").slice(0, 2048),
      status: "ok",
      note: "",
      uploadedAt: now,
    };
  });
  const approvalPayload = {
    eventId,
    status: "pending",
    currentStep: 1,
    totalSteps: stageList.length,
    members,
    stages: [...new Set(stageList.map((stage) => stage.order))],
    files: approvalFiles,
    history: [{ action: "submitted", by: identity.organizerName, at: now, note: "Event proposal submitted." }],
    submittedAt: now,
  };

  const updates = {
    [`events/${eventId}`]: eventPayload,
    [`approvals/${eventId}`]: approvalPayload,
    [`organizerEvents/${uid}/${eventId}`]: true,
    [`eventRequestIds/${uid}/${requestKey}`]: eventId,
    [`notifications/${uid}/${eventId}_submitted`]: {
      eventId,
      type: "proposal_submitted",
      title: "Proposal Submitted",
      message: `Your event proposal "${eventName}" was submitted for review.`,
      read: false,
      createdAt: now,
    },
  };
  if (draftRef) updates[`drafts/${uid}/${data.draftId}`] = null;

  const assignedReviewerUids = new Set([firstStage.uid].filter(Boolean).map(String));
  if (!assignedReviewerUids.size) {
    const rolesSnap = await rootRef.child("roles").once("value");
    Object.entries(rolesSnap.val() || {}).forEach(([reviewerUid, reviewerRole]) => {
      if (reviewerRole === "admin") assignedReviewerUids.add(reviewerUid);
    });
  }
  assignedReviewerUids.forEach((reviewerUid) => {
    updates[`approverQueue/${reviewerUid}/${eventId}`] = {
      eventId,
      name: eventName,
      title: eventName,
      date: startAt,
      venue,
      category: eventPayload.category,
      ...(identity.organizationCode ? { organizationCode: identity.organizationCode } : {}),
      step: 1,
      status: "pending",
      updatedAt: now,
    };
    updates[`notifications/${reviewerUid}/${eventId}_first_turn`] = {
      eventId,
      type: "review_needed",
      title: "Your Review is Needed",
      message: `Your review is needed for "${eventName}" (${firstStage.label}).`,
      read: false,
      createdAt: now,
    };
  });

  await rootRef.update(updates);
  return ({ eventId, firstReviewer: firstStage.label });
});

/**
 * 7. replaceFile({ eventId, fileId, path, name })
 */
exports.replaceFile = functions.region("asia-southeast1").https.onCall(async (data, context) => {
  const { eventId, fileId, path, name } = data || {};
  if (!eventId || !fileId || !path) {
    throw new functions.https.HttpsError("invalid-argument", "Missing required parameters: eventId, fileId, path.");
  }
  let driveUrl;
  try {
    driveUrl = new URL(String(path).trim());
  } catch {
    throw new functions.https.HttpsError("invalid-argument", "Provide a valid Google Drive link.");
  }
  if (
    driveUrl.protocol !== "https:" ||
    !["drive.google.com", "docs.google.com"].includes(driveUrl.hostname.toLowerCase()) ||
    driveUrl.pathname === "/"
  ) {
    throw new functions.https.HttpsError("invalid-argument", "Provide a valid Google Drive link.");
  }
  await verifyOrganizerEventOwnership(context.auth, eventId);

  const fileRef = admin.database().ref(`approvals/${eventId}/files/${fileId}`);
  const snap = await fileRef.once("value");
  if (!snap.exists()) {
    throw new functions.https.HttpsError("not-found", "The specified document file does not exist.");
  }

  const callerName = context.auth.token.name || context.auth.token.email || "Event Organizer";
  const now = Date.now();

  await fileRef.update({
    path: driveUrl.href,
    name: name || snap.val().name,
    status: "ok",
    note: "",
    replacedAt: now,
  });

  const historyRef = admin.database().ref(`approvals/${eventId}/history`).push();
  await historyRef.set({
    action: "file_replaced",
    by: callerName,
    at: now,
    fileId,
    note: `Document replaced: ${name || snap.val().name}`,
  });

  return ({ success: true });
});

/**
 * 8. resubmitEvent({ eventId, note })
 */
exports.resubmitEvent = functions.region("asia-southeast1").https.onCall(async (data, context) => {
  const { eventId, note } = data || {};
  if (!eventId) {
    throw new functions.https.HttpsError("invalid-argument", "Event ID is required.");
  }
  const { role, eventData } = await verifyOrganizerEventOwnership(context.auth, eventId);

  const approvalRef = admin.database().ref(`approvals/${eventId}`);
  const approvalSnap = await approvalRef.once("value");
  const approvalData = approvalSnap.val() || {};

  if (approvalData.status !== "revision" && eventData.status !== "revision") {
    throw new functions.https.HttpsError("failed-precondition", "Only proposals with changes requested can be resubmitted.");
  }

  const files = approvalData.files || {};
  const hasUnreplacedFile = Object.values(files).some((f) => f && f.status === "rev");
  if (hasUnreplacedFile) {
    throw new functions.https.HttpsError("failed-precondition", "Please replace every requested document before resubmitting.");
  }

  const callerName = context.auth.token.name || context.auth.token.email || "Event Organizer";
  const now = Date.now();

  const members = approvalData.members || {};
  let revKey = null;
  Object.keys(members).forEach((key) => {
    if (members[key].status === "rev") {
      revKey = key;
      members[key].status = "review";
      members[key].updatedAt = now;
      members[key].note = note ? `Resubmitted: ${note}` : "Resubmitted for review.";
    }
  });

  const rootRef = admin.database().ref();
  const updates = {};
  const proposalOrganizationCode = await getProposalOrganizationCode(eventData);
  updates[`events/${eventId}/status`] = "pending";
  updates[`events/${eventId}/updatedAt`] = now;
  updates[`approvals/${eventId}/status`] = "pending";
  updates[`approvals/${eventId}/members`] = members;
  updates[`organizerEvents/${eventData.organizerId}/${eventId}/status`] = "pending";

  if (revKey) {
    const dirSnap = await admin.database().ref(`approverDirectory/${revKey}`).once("value");
    const dirItem = { ...(dirSnap.val() || APPROVER_DIRECTORY[revKey] || {}) };
    if (isOrganizationAdviserStage(revKey)) {
      dirItem.uid = await findOrganizationAdviserUid(proposalOrganizationCode);
      if (!dirItem.uid) {
        throw new functions.https.HttpsError(
          "failed-precondition",
          "No active Organization Adviser is assigned to this proposal's organization.",
        );
      }
    }
    if (dirItem.uid) {
      updates[`approverQueue/${dirItem.uid}/${eventId}`] = {
        eventId,
        name: eventData.name || "Event",
        title: eventData.name || "Event",
        date: eventData.startAt || "",
        venue: eventData.venue || "",
        category: eventData.category || "",
        ...(proposalOrganizationCode ? { organizationCode: proposalOrganizationCode } : {}),
        step: members[revKey].step,
        status: "pending",
        paused: false,
        updatedAt: now,
      };
      updates[`notifications/${dirItem.uid}/${eventId}_resubmit`] = {
        eventId,
        type: "review_resubmitted",
        title: "Proposal Resubmitted",
        message: `"${eventData.name || "Event"}" was resubmitted for your review.`,
        read: false,
        createdAt: now,
      };
    }
  }

  await rootRef.update(updates);

  const historyRef = admin.database().ref(`approvals/${eventId}/history`).push();
  await historyRef.set({
    action: "resubmitted",
    by: callerName,
    at: now,
    note: note || "Proposal resubmitted with requested updates.",
  });
  if (role === "event_organizer") {
    await createAdminProposalNotifications(
      eventId,
      eventData,
      "proposal-resubmitted",
      `“${eventData.name || "Untitled event"}” was resubmitted for review.`,
      now,
    );
  }

  return ({ success: true });
});

/**
 * 9. publishEvent({ eventId })
 */
exports.publishEvent = functions.region("asia-southeast1").https.onCall(async (data, context) => {
  const { eventId } = data || {};
  if (!eventId) {
    throw new functions.https.HttpsError("invalid-argument", "Event ID is required.");
  }

  if (!context.auth?.uid) {
    throw new functions.https.HttpsError("unauthenticated", "Caller must be authenticated.");
  }

  const firestoreEventRef = admin.firestore().collection("events").doc(String(eventId));
  const firestoreEventSnap = await firestoreEventRef.get();
  if (firestoreEventSnap.exists) {
    let role = "";
    try {
      const roleSnap = await admin.database().ref(`roles/${context.auth.uid}`).once("value");
      role = String(roleSnap.val() || "")
        .trim()
        .toLowerCase()
        .replace(/[\s_-]+/g, "");
    } catch (error) {
      console.warn("Could not verify publish role in Realtime Database; trying Firestore.", error);
    }
    if (!["eventorganizer", "organizer", "eo", "teacher", "admin", "superadmin"].includes(role)) {
      const profiles = await Promise.allSettled([
        admin.firestore().collection("adminUser").doc(context.auth.uid).get(),
        admin.firestore().collection("users").doc(context.auth.uid).get(),
      ]);
      role = profiles
        .filter((result) => result.status === "fulfilled" && result.value.exists)
        .map((result) => {
          const profile = result.value.data() || {};
          return String(profile.role || profile.userRole || "")
            .trim()
            .toLowerCase()
            .replace(/[\s_-]+/g, "");
        })
        .find((profileRole) =>
          ["eventorganizer", "organizer", "eo", "teacher", "admin", "superadmin"].includes(profileRole),
        ) || role;
    }
    if (!["eventorganizer", "organizer", "eo", "teacher", "admin", "superadmin"].includes(role)) {
      throw new functions.https.HttpsError("permission-denied", "You do not have permission to publish this event.");
    }

    const eventData = firestoreEventSnap.data() || {};
    if (["admin", "superadmin"].includes(role)) {
      const identity = await getAdminApprovalIdentity(context.auth);
      assertOrganizationScopedApproval(
        identity,
        await getProposalOrganizationCode(eventData),
      );
    }
    const organizerUid = eventData.organizerUid || eventData.organizerId || eventData.createdBy;
    if (!["admin", "superadmin"].includes(role) && organizerUid !== context.auth.uid) {
      throw new functions.https.HttpsError("permission-denied", "You can only publish your own events.");
    }

    const status = String(eventData.status || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
    if (!["ready_to_publish", "approved", "pending", "published"].includes(status)) {
      throw new functions.https.HttpsError("failed-precondition", "Publish unlocks after every approval stage is complete.");
    }

    const now = Date.now();
    const normalized = normalizeFirestoreApprovalStages(eventData, now);
    const allStagesApproved = APPROVAL_ACCOUNT_STAGES.every((workflowStage) => {
      const configuredStage = normalized.stages.find((stage) =>
        stage.required && getWorkflowApprovalStage(stage)?.key === workflowStage.key,
      );
      return configuredStage &&
        normalized.approvalStages[configuredStage.id]?.status === "approved";
    });
    if (!allStagesApproved) {
      throw new functions.https.HttpsError("failed-precondition", "Publish unlocks after every approval stage is complete.");
    }

    const publishedAt = Number(eventData.publishedAt) || now;
    if (
      status !== "published" ||
      eventData.published !== true ||
      eventData.isPublished !== true ||
      !eventData.publishedAt
    ) {
      await firestoreEventRef.update({
        status: "published",
        approvalStatus: "approved",
        published: true,
        isPublished: true,
        publishedAt,
        updatedAt: now,
      });
    }

    const publishedEvent = buildPublishedEvent(eventId, {
      ...eventData,
      status: "published",
      approvalStatus: "approved",
      published: true,
      isPublished: true,
      publishedAt,
    }, publishedAt);
    try {
      const rootRef = admin.database().ref();
      const updates = {
        [`publicEvents/${eventId}`]: publishedEvent,
      };
      const legacyEventSnap = await rootRef.child(`events/${eventId}`).once("value");
      if (legacyEventSnap.exists()) updates[`events/${eventId}`] = publishedEvent;
      const organizerEventRef = organizerUid
        ? rootRef.child(`organizerEvents/${organizerUid}/${eventId}`)
        : null;
      if (organizerEventRef && (await organizerEventRef.once("value")).exists()) {
        updates[`organizerEvents/${organizerUid}/${eventId}`] = publishedEvent;
      }

      await rootRef.update(updates);
      const historyRef = rootRef.child(`approvals/${eventId}/history`).push();
      await historyRef.set({
        action: "published",
        by: context.auth.token.name || context.auth.token.email || "Event Organizer",
        at: now,
        note: "Event published.",
      });
    } catch (error) {
      console.warn("Event was published in Firestore, but Realtime Database sync failed:", {
        eventId,
        code: error?.code || "unknown",
        message: error?.message || String(error),
      });
    }
    return { success: true };
  }

  const { eventData } = await verifyOrganizerEventOwnership(context.auth, eventId);

  const approvalSnap = await admin.database().ref(`approvals/${eventId}`).once("value");
  const approvalData = approvalSnap.val() || {};

  const members = Object.values(approvalData.members || {});
  const allSignedOff = members.length > 0 && members.every((m) => m && m.status === "ok");

  if (!allSignedOff && approvalData.status !== "approved" && eventData.status !== "approved") {
    throw new functions.https.HttpsError("failed-precondition", "Publish unlocks after every approver signs off.");
  }

  const callerName = context.auth.token.name || context.auth.token.email || "Event Organizer";
  const now = Date.now();

  const rootRef = admin.database().ref();
  const updates = {};
  updates[`events/${eventId}/status`] = "published";
  updates[`events/${eventId}/publishedAt`] = now;
  updates[`events/${eventId}/updatedAt`] = now;
  updates[`approvals/${eventId}/status`] = "published";
  updates[`organizerEvents/${eventData.organizerId}/${eventId}/status`] = "published";

  updates[`publicEvents/${eventId}`] = {
    ...eventData,
    description: eventData.description || eventData.eventDescription || "",
    organizerName: eventData.organizerName || callerName,
    organization: eventData.organization || eventData.department || eventData.organizerName || callerName,
    source: eventData.source || eventData.eventSource || "Organizational",
    capacity: eventData.capacity !== undefined ? eventData.capacity : (eventData.maxCapacity || null),
    registeredCount: typeof eventData.registeredCount === "number" ? eventData.registeredCount : 0,
    status: "published",
    publishedAt: now,
  };

  await rootRef.update(updates);

  const historyRef = admin.database().ref(`approvals/${eventId}/history`).push();
  await historyRef.set({
    action: "published",
    by: callerName,
    at: now,
    note: "Event published.",
  });

  return ({ success: true });
});

/**
 * 10. cancelEvent({ eventId, reason })
 */
exports.cancelEvent = functions.region("asia-southeast1").https.onCall(async (data, context) => {
  const { eventId, reason } = data || {};
  if (!eventId) {
    throw new functions.https.HttpsError("invalid-argument", "Event ID is required.");
  }
  const { role, eventData } = await verifyOrganizerEventOwnership(context.auth, eventId);

  if (eventData.status === "completed") {
    throw new functions.https.HttpsError("failed-precondition", "Completed events cannot be cancelled.");
  }

  const callerName = context.auth.token.name || context.auth.token.email || "Event Organizer";
  const now = Date.now();

  const rootRef = admin.database().ref();
  const updates = {};
  updates[`events/${eventId}/status`] = "cancelled";
  updates[`events/${eventId}/cancelledAt`] = now;
  updates[`events/${eventId}/updatedAt`] = now;
  updates[`approvals/${eventId}/status`] = "cancelled";
  updates[`organizerEvents/${eventData.organizerId}/${eventId}/status`] = "cancelled";
  updates[`publicEvents/${eventId}`] = null;

  await rootRef.update(updates);

  const historyRef = admin.database().ref(`approvals/${eventId}/history`).push();
  await historyRef.set({
    action: "cancelled",
    by: callerName,
    at: now,
    note: reason || "Event cancelled by organizer.",
  });
  if (role === "event_organizer") {
    await createAdminProposalNotifications(
      eventId,
      eventData,
      "proposal-cancelled",
      `“${eventData.name || "Untitled event"}” was cancelled by the Event Organizer.`,
      now,
    );
  }

  return ({ success: true });
});

/**
 * 11. completeEvent({ eventId })
 */
exports.completeEvent = functions.region("asia-southeast1").https.onCall(async (data, context) => {
  const { eventId } = data || {};
  if (!eventId) {
    throw new functions.https.HttpsError("invalid-argument", "Event ID is required.");
  }
  const { eventData } = await verifyOrganizerEventOwnership(context.auth, eventId);

  if (eventData.status !== "published" && eventData.status !== "approved") {
    throw new functions.https.HttpsError("failed-precondition", "Only published events can be marked completed.");
  }

  const callerName = context.auth.token.name || context.auth.token.email || "Event Organizer";
  const now = Date.now();

  const regSnap = await admin.database().ref(`registrations/${eventId}`).once("value");
  const registrations = regSnap.val() || {};

  const attSnap = await admin.database().ref(`attendance/${eventId}`).once("value");
  const attendance = attSnap.val() || {};

  let checkedInCount = 0;
  let walkInCount = 0;

  Object.values(attendance).forEach((row) => {
    if (row && row.scannedAt) {
      checkedInCount += 1;
      if (row.walkIn) {
        walkInCount += 1;
      }
    }
  });

  let absentCount = 0;
  const absenceUpdates = {};
  Object.keys(registrations).forEach((uid) => {
    if (registrations[uid] && (!attendance[uid] || !attendance[uid].scannedAt)) {
      absentCount += 1;
      absenceUpdates[`absences/${eventId}/${uid}`] = {
        studentUid: uid,
        markedAt: now,
        reason: "unscanned",
      };
    }
  });

  const rootRef = admin.database().ref();
  const updates = {
    ...absenceUpdates,
  };
  updates[`events/${eventId}/status`] = "completed";
  updates[`events/${eventId}/completedAt`] = now;
  updates[`events/${eventId}/updatedAt`] = now;
  updates[`approvals/${eventId}/status`] = "completed";
  updates[`organizerEvents/${eventData.organizerId}/${eventId}/status`] = "completed";
  updates[`publicEvents/${eventId}/status`] = "completed";

  await rootRef.update(updates);

  const totals = {
    checkedIn: checkedInCount,
    walkIns: walkInCount,
    absent: absentCount,
  };

  const historyRef = admin.database().ref(`approvals/${eventId}/history`).push();
  await historyRef.set({
    action: "completed",
    by: callerName,
    at: now,
    note: `Event completed. ${checkedInCount} checked in (${walkInCount} walk-ins), ${absentCount} absent.`,
    totals,
  });

  return ({
    success: true,
    totals,
  });
});

/**
 * 12. reopenEvent({ eventId })
 */
exports.reopenEvent = functions.region("asia-southeast1").https.onCall(async (data, context) => {
  const { eventId } = data || {};
  if (!eventId) {
    throw new functions.https.HttpsError("invalid-argument", "Event ID is required.");
  }
  const { eventData } = await verifyOrganizerEventOwnership(context.auth, eventId);

  if (eventData.status !== "completed") {
    throw new functions.https.HttpsError("failed-precondition", "Only completed events can be reopened.");
  }

  const completedAt = Number(eventData.completedAt) || 0;
  const now = Date.now();
  const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;

  if (role !== "admin" && now - completedAt > TWENTY_FOUR_HOURS) {
    throw new functions.https.HttpsError("failed-precondition", "Events can only be reopened within 24 hours of completion.");
  }

  const callerName = context.auth.token.name || context.auth.token.email || "Event Organizer";

  const rootRef = admin.database().ref();
  const updates = {};
  updates[`events/${eventId}/status`] = "published";
  updates[`events/${eventId}/completedAt`] = null;
  updates[`events/${eventId}/updatedAt`] = now;
  updates[`approvals/${eventId}/status`] = "published";
  updates[`organizerEvents/${eventData.organizerId}/${eventId}/status`] = "published";
  updates[`absences/${eventId}`] = null;

  await rootRef.update(updates);

  const historyRef = admin.database().ref(`approvals/${eventId}/history`).push();
  await historyRef.set({
    action: "reopened",
    by: callerName,
    at: now,
    note: "Event reopened for attendance check-in.",
  });

  return ({ success: true });
});

/**
 * 13. addApprover({ eventId, key })
 */
exports.addApprover = functions.region("asia-southeast1").https.onCall(async (data, context) => {
  const { eventId, key } = data || {};
  if (!eventId || !key) {
    throw new functions.https.HttpsError("invalid-argument", "Missing required parameters: eventId and key.");
  }
  const callerRole = await verifyOrganizerRole(context.auth);

  const dirSnap = await admin.database().ref("approverDirectory").once("value");
  const directory = dirSnap.val() || APPROVER_DIRECTORY;
  const dirItem = directory[key];
  if (!dirItem) {
    throw new functions.https.HttpsError("not-found", `Approver key "${key}" not found in approver directory.`);
  }

  const approvalRef = admin.database().ref(`approvals/${eventId}`);
  const snap = await approvalRef.once("value");
  if (!snap.exists()) {
    throw new functions.https.HttpsError("not-found", "Proposal approval record not found.");
  }
  const approval = snap.val() || {};
  const members = approval.members || {};
  const eventSnap = await admin.database().ref(`events/${eventId}`).once("value");
  const event = eventSnap.val() || {};
  const proposalOrganizationCode = await getProposalOrganizationCode(event);
  if (
    callerRole !== "admin" &&
    (event.organizerUid || event.organizerId) !== context.auth.uid
  ) {
    throw new functions.https.HttpsError("permission-denied", "You can only manage the approval chain for your own events.");
  }
  if (callerRole === "event_organizer" && !proposalOrganizationCode) {
    throw new functions.https.HttpsError("permission-denied", "This event does not match your assigned organization.");
  }
  let identity = null;
  if (callerRole === "admin") {
    identity = await getAdminApprovalIdentity(context.auth);
    assertOrganizationScopedApproval(identity, proposalOrganizationCode);
  }

  if (members[key]) {
    throw new functions.https.HttpsError("already-exists", "This approver is already in the approval chain.");
  }

  const now = Date.now();
  const callerName = identity?.name || context.auth.token.name || context.auth.token.email || "Administrator";

  members[key] = {
    key,
    label: dirItem.label,
    stage: dirItem.stage,
    status: "wait",
    note: "",
    updatedAt: now,
  };

  const memberKeys = Object.keys(members);
  memberKeys.sort((a, b) => (members[a].stage || 0) - (members[b].stage || 0));
  const updatedMembers = {};
  memberKeys.forEach((k, idx) => {
    updatedMembers[k] = {
      ...members[k],
      step: idx + 1,
    };
  });

  const distinctStages = [...new Set(memberKeys.map((k) => updatedMembers[k].stage))].sort((a, b) => a - b);

  await approvalRef.child("members").set(updatedMembers);
  await approvalRef.child("stages").set(distinctStages);
  await approvalRef.child("totalSteps").set(memberKeys.length);

  const historyRef = admin.database().ref(`approvals/${eventId}/history`).push();
  await historyRef.set({
    action: "approver_added",
    by: callerName,
    at: now,
    note: `Added ${dirItem.label} to approval chain.`,
  });

  return ({ success: true });
});

/**
 * 14. removeApprover({ eventId, key })
 */
exports.removeApprover = functions.region("asia-southeast1").https.onCall(async (data, context) => {
  if (!context.auth || !context.auth.uid) {
    throw new functions.https.HttpsError("unauthenticated", "You must be signed in.");
  }
  const callerUid = context.auth.uid;
  const roleSnap = await admin.database().ref(`roles/${callerUid}`).once("value");
  if (roleSnap.val() !== "admin") {
    throw new functions.https.HttpsError("permission-denied", "Only administrators can remove approvers.");
  }

  const { eventId, key } = data || {};
  if (!eventId || !key) {
    throw new functions.https.HttpsError("invalid-argument", "Missing required parameters: eventId and key.");
  }

  const approvalRef = admin.database().ref(`approvals/${eventId}`);
  const snap = await approvalRef.once("value");
  if (!snap.exists()) {
    throw new functions.https.HttpsError("not-found", "Approval record not found.");
  }

  const approval = snap.val();
  const members = approval.members || {};
  const eventSnap = await admin.database().ref(`events/${eventId}`).once("value");
  const event = eventSnap.val() || {};
  const identity = await getAdminApprovalIdentity(context.auth);
  const proposalOrganizationCode = await getProposalOrganizationCode(event);
  assertOrganizationScopedApproval(identity, proposalOrganizationCode);
  const targetMember = members[key];
  if (!targetMember) {
    throw new functions.https.HttpsError("not-found", `Approver "${key}" is not part of this proposal.`);
  }

  if (targetMember.status === "ok") {
    throw new functions.https.HttpsError("failed-precondition", "Cannot remove an approver who has already approved.");
  }

  const remainingKeys = Object.keys(members).filter((k) => k !== key);
  if (remainingKeys.length === 0) {
    throw new functions.https.HttpsError("failed-precondition", "An event proposal must have at least one approver.");
  }

  const now = Date.now();
  const callerName = identity.name || context.auth.token.name || context.auth.token.email || "Administrator";
  const wasInReview = targetMember.status === "review";

  const dirSnap = await admin.database().ref("approverDirectory").once("value");
  const directory = dirSnap.val() || APPROVER_DIRECTORY;

  remainingKeys.sort((a, b) => (members[a].stage || 0) - (members[b].stage || 0) || (members[a].step || 0) - (members[b].step || 0));

  const updatedMembers = {};
  remainingKeys.forEach((k, idx) => {
    updatedMembers[k] = {
      ...members[k],
      step: idx + 1,
    };
  });

  const distinctStages = [...new Set(remainingKeys.map((k) => updatedMembers[k].stage))].sort((a, b) => a - b);

  const rootRef = admin.database().ref();
  const updates = {};

  const targetDir = directory[key] || {};
  const targetUid = isOrganizationAdviserStage(key)
    ? await findOrganizationAdviserUid(proposalOrganizationCode)
    : targetDir.uid;
  if (targetUid) {
    updates[`approverQueue/${targetUid}/${eventId}`] = null;
  }

  if (wasInReview) {
    const nextWaitingKey = remainingKeys.find((k) => updatedMembers[k].status === "wait");
    if (nextWaitingKey) {
      updatedMembers[nextWaitingKey].status = "review";
      updatedMembers[nextWaitingKey].updatedAt = now;
      const nextDir = { ...(directory[nextWaitingKey] || {}) };
      if (isOrganizationAdviserStage(nextWaitingKey)) {
        nextDir.uid = await findOrganizationAdviserUid(proposalOrganizationCode);
        if (!nextDir.uid) {
          throw new functions.https.HttpsError(
            "failed-precondition",
            "No active Organization Adviser is assigned to this proposal's organization.",
          );
        }
      }
      if (nextDir.uid) {
        updates[`approverQueue/${nextDir.uid}/${eventId}`] = {
          eventId,
          name: event.name || "Event",
          title: event.name || "Event",
          date: event.startAt || "",
          venue: event.venue || "",
          category: event.category || "",
          ...(proposalOrganizationCode ? { organizationCode: proposalOrganizationCode } : {}),
          step: updatedMembers[nextWaitingKey].step,
          status: "pending",
          updatedAt: now,
        };
        updates[`notifications/${nextDir.uid}/${eventId}_turn`] = {
          eventId,
          type: "review_needed",
          title: "Your Review is Needed",
          message: `Your review is needed for "${event.name}". (Step ${updatedMembers[nextWaitingKey].step})`,
          read: false,
          createdAt: now,
        };
      }
    } else {
      const allOk = remainingKeys.every((k) => updatedMembers[k].status === "ok");
      if (allOk) {
        updates[`approvals/${eventId}/status`] = "approved";
        updates[`events/${eventId}/status`] = "approved";
      }
    }
  }

  updates[`approvals/${eventId}/members`] = updatedMembers;
  updates[`approvals/${eventId}/stages`] = distinctStages;
  updates[`approvals/${eventId}/totalSteps`] = remainingKeys.length;

  const historyKey = rootRef.child(`approvals/${eventId}/history`).push().key;
  updates[`approvals/${eventId}/history/${historyKey}`] = {
    action: "approver_removed",
    by: callerName,
    at: now,
    key,
    label: targetMember.label || key,
    note: `Removed ${targetMember.label || key} from approval chain.`,
  };

  await rootRef.update(updates);
  return ({ success: true });
});

/**
 * 15. decideApproval({ eventId, key, decision, note, fileId })
 */
exports.decideApproval = functions.region("asia-southeast1").https.onCall(async (data, context) => {
  if (!context.auth || !context.auth.uid) {
    throw new functions.https.HttpsError("unauthenticated", "You must be signed in.");
  }
  const callerUid = context.auth.uid;
  const identity = await getAdminApprovalIdentity(context.auth);
  const assignedStage = identity.stage;
  if (!assignedStage) {
    const roleSnap = await admin.database().ref(`roles/${callerUid}`).once("value");
    if (roleSnap.val() !== "admin") {
      throw new functions.https.HttpsError("permission-denied", "Only administrators can decide event approvals.");
    }
  }
  const { eventId, key, decision, note, fileId } = data || {};
  if (!eventId || !key || !decision) {
    throw new functions.https.HttpsError("invalid-argument", "Missing required parameters: eventId, key, decision.");
  }

  if (!["approve", "revise", "reject"].includes(decision)) {
    throw new functions.https.HttpsError("invalid-argument", "Invalid decision. Must be 'approve', 'revise', or 'reject'.");
  }
  if (assignedStage && normalizeApprovalKey(assignedStage.key) !== normalizeApprovalKey(key)) {
    throw new functions.https.HttpsError("permission-denied", `This account is assigned to ${assignedStage.label}.`);
  }

  const approvalRef = admin.database().ref(`approvals/${eventId}`);
  const snap = await approvalRef.once("value");
  if (!snap.exists()) {
    throw new functions.https.HttpsError("not-found", "Proposal approval record not found.");
  }
  const approval = snap.val();
  const members = approval.members || {};
  const member = members[key];

  if (!member) {
    throw new functions.https.HttpsError("not-found", `Approver step "${key}" not found on this proposal.`);
  }
  if (member.uid && member.uid !== callerUid) {
    throw new functions.https.HttpsError("permission-denied", "Only the reviewer assigned to this approval stage can decide it.");
  }

  const eventSnap = await admin.database().ref(`events/${eventId}`).once("value");
  const event = eventSnap.val() || {};
  const proposalOrganizationCode = await getProposalOrganizationCode(event);
  assertOrganizationScopedApproval(identity, proposalOrganizationCode);

  const dirSnap = await admin.database().ref(`approverDirectory/${key}`).once("value");
  const dirItem = dirSnap.val() || APPROVER_DIRECTORY[key] || {};
  if (dirItem.uid && dirItem.uid !== callerUid && (assignedStage?.roleKey || assignedStage?.key) !== "org_adv") {
    throw new functions.https.HttpsError("permission-denied", `Only the assigned administrator (${dirItem.label || key}) can decide this step.`);
  }

  if (member.status !== "review") {
    if (member.status === "wait") {
      throw new functions.https.HttpsError("failed-precondition", "It is not your turn yet. Earlier steps must approve first.");
    }
    if (member.status === "ok") {
      throw new functions.https.HttpsError("failed-precondition", "You have already approved this step.");
    }
    if (member.status === "rev") {
      throw new functions.https.HttpsError("failed-precondition", "This proposal is currently paused awaiting revisions from the organizer.");
    }
    if (member.status === "rej") {
      throw new functions.https.HttpsError("failed-precondition", "This proposal was already rejected.");
    }
    throw new functions.https.HttpsError("failed-precondition", "This proposal is not currently in review for your step.");
  }

  const cleanNote = String(note || "").trim();
  if ((decision === "revise" || decision === "reject") && cleanNote.length < 3) {
    throw new functions.https.HttpsError("invalid-argument", "A note of at least 3 characters is required when requesting changes or rejecting.");
  }

  if (decision === "revise" && !fileId) {
    throw new functions.https.HttpsError("invalid-argument", "Please select which document requires revision.");
  }

  const callerName = identity.name || context.auth.token.name || context.auth.token.email || dirItem.label || "Administrator";
  const now = Date.now();
  const rootRef = admin.database().ref();
  const updates = {};

  if (decision === "approve") {
    members[key].status = "ok";
    members[key].note = cleanNote || "Approved.";
    members[key].updatedAt = now;
    members[key].decidedBy = callerName;

    updates[`approverQueue/${callerUid}/${eventId}`] = null;

    const waitingKeys = Object.keys(members)
      .filter((k) => members[k].status === "wait")
      .sort((a, b) => (members[a].stage || 0) - (members[b].stage || 0) || (members[a].step || 0) - (members[b].step || 0));

    if (waitingKeys.length > 0) {
      const nextKey = waitingKeys[0];
      const nextMember = members[nextKey];
      nextMember.status = "review";
      nextMember.updatedAt = now;

      const nextDirSnap = await admin.database().ref(`approverDirectory/${nextKey}`).once("value");
      const nextDir = { ...(nextDirSnap.val() || APPROVER_DIRECTORY[nextKey] || {}) };
      nextDir.uid = nextDir.uid || nextMember.uid || "";
      if (isOrganizationAdviserStage(nextKey)) {
        nextDir.uid = await findOrganizationAdviserUid(
          await getProposalOrganizationCode(event),
        );
        if (!nextDir.uid) {
          throw new functions.https.HttpsError(
            "failed-precondition",
            "No active Organization Adviser is assigned to this proposal's organization.",
          );
        }
      }
      if (nextDir.uid) {
        updates[`approverQueue/${nextDir.uid}/${eventId}`] = {
          eventId,
          name: event.name || "Event",
          title: event.name || "Event",
          date: event.startAt || "",
          venue: event.venue || "",
          category: event.category || "",
          ...(proposalOrganizationCode ? { organizationCode: proposalOrganizationCode } : {}),
          step: nextMember.step,
          status: "pending",
          updatedAt: now,
        };
        updates[`notifications/${nextDir.uid}/${eventId}_turn`] = {
          eventId,
          type: "review_needed",
          title: "Your Review is Needed",
          message: `Your review is needed for "${event.name}". (Step ${nextMember.step})`,
          read: false,
          createdAt: now,
        };
      }
    } else {
      updates[`approvals/${eventId}/status`] = "approved";
      updates[`events/${eventId}/status`] = "approved";
      if (event.organizerId) {
        updates[`organizerEvents/${event.organizerId}/${eventId}/status`] = "approved";
        updates[`notifications/${event.organizerId}/${eventId}_approved`] = {
          eventId,
          type: "approved",
          title: "Event Proposal Approved",
          message: `Congratulations! Your event proposal "${event.name}" was approved by all approvers. You can now publish it.`,
          read: false,
          createdAt: now,
        };
      }
    }

    updates[`approvals/${eventId}/members`] = members;

    const historyKey = rootRef.child(`approvals/${eventId}/history`).push().key;
    updates[`approvals/${eventId}/history/${historyKey}`] = {
      action: "approved",
      by: callerName,
      at: now,
      key,
      label: dirItem.label || key,
      note: cleanNote || "Approved.",
    };

    updates[`approverDecisions/${callerUid}/${eventId}`] = {
      eventId,
      name: event.name || "Event",
      decision: "Approved",
      note: cleanNote,
      decidedAt: now,
    };

  } else if (decision === "revise") {
    members[key].status = "rev";
    members[key].note = cleanNote;
    members[key].updatedAt = now;
    members[key].decidedBy = callerName;

    if (fileId && approval.files && approval.files[fileId]) {
      updates[`approvals/${eventId}/files/${fileId}/status`] = "rev";
      updates[`approvals/${eventId}/files/${fileId}/note`] = cleanNote;
    }

    updates[`approvals/${eventId}/status`] = "revision";
    updates[`events/${eventId}/status`] = "revision";
    if (event.organizerId) {
      updates[`organizerEvents/${event.organizerId}/${eventId}/status`] = "revision";
      updates[`notifications/${event.organizerId}/${eventId}_revision`] = {
        eventId,
        type: "revision",
        title: "Revisions Requested",
        message: `${callerName} requested changes for "${event.name}": ${cleanNote}`,
        note: cleanNote,
        read: false,
        createdAt: now,
      };
    }

    updates[`approverQueue/${callerUid}/${eventId}`] = {
      eventId,
      name: event.name || "Event",
      title: event.name || "Event",
      date: event.startAt || "",
      venue: event.venue || "",
      category: event.category || "",
      ...(proposalOrganizationCode ? { organizationCode: proposalOrganizationCode } : {}),
      step: member.step,
      status: "paused",
      paused: true,
      updatedAt: now,
    };

    updates[`approvals/${eventId}/members`] = members;

    const historyKey = rootRef.child(`approvals/${eventId}/history`).push().key;
    updates[`approvals/${eventId}/history/${historyKey}`] = {
      action: "revision_requested",
      by: callerName,
      at: now,
      key,
      label: dirItem.label || key,
      note: cleanNote,
      fileId,
    };

    updates[`approverDecisions/${callerUid}/${eventId}`] = {
      eventId,
      name: event.name || "Event",
      decision: "Asked for changes",
      note: cleanNote,
      decidedAt: now,
    };

  } else if (decision === "reject") {
    members[key].status = "rej";
    members[key].note = cleanNote;
    members[key].updatedAt = now;
    members[key].decidedBy = callerName;

    updates[`approvals/${eventId}/status`] = "rejected";
    updates[`events/${eventId}/status`] = "rejected";
    if (event.organizerId) {
      updates[`organizerEvents/${event.organizerId}/${eventId}/status`] = "rejected";
      updates[`notifications/${event.organizerId}/${eventId}_rejected`] = {
        eventId,
        type: "rejected",
        title: "Event Proposal Rejected",
        message: `${callerName} rejected your proposal for "${event.name}": ${cleanNote}`,
        note: cleanNote,
        read: false,
        createdAt: now,
      };
    }

    updates[`approverQueue/${callerUid}/${eventId}`] = null;
    updates[`approvals/${eventId}/members`] = members;

    const historyKey = rootRef.child(`approvals/${eventId}/history`).push().key;
    updates[`approvals/${eventId}/history/${historyKey}`] = {
      action: "rejected",
      by: callerName,
      at: now,
      key,
      label: dirItem.label || key,
      note: cleanNote,
    };

    updates[`approverDecisions/${callerUid}/${eventId}`] = {
      eventId,
      name: event.name || "Event",
      decision: "Rejected",
      note: cleanNote,
      decidedAt: now,
    };
  }

  await rootRef.update(updates);
  if (
    decision === "approve" &&
    Object.values(members).length > 0 &&
    Object.values(members).every((member) => member.status === "ok") &&
    await isEventOrganizerProposal(event)
  ) {
    await createAdminProposalNotifications(
      eventId,
      event,
      "proposal-approved",
      `“${event.name || "Untitled event"}” was approved.`,
      now,
    );
  }
  return ({ success: true, decision });
});

/**
 * 16. linkAdminToApprover({ key })
 */
exports.linkAdminToApprover = functions.region("asia-southeast1").https.onCall(async (data, context) => {
  if (!context.auth || !context.auth.uid) {
    throw new functions.https.HttpsError("unauthenticated", "You must be signed in.");
  }
  const callerUid = context.auth.uid;
  const { key } = data || {};
  if (!key) {
    throw new functions.https.HttpsError("invalid-argument", "Approver key is required.");
  }
  const identity = await getAdminApprovalIdentity(context.auth);
  const assignedStage = identity.stage;
  if (assignedStage) {
    if (assignedStage.key !== key) {
      throw new functions.https.HttpsError("permission-denied", `This account can only be linked to ${assignedStage.label}.`);
    }
    await admin.database().ref(`roles/${callerUid}`).set("admin");
  } else {
    const roleSnap = await admin.database().ref(`roles/${callerUid}`).once("value");
    if (roleSnap.val() !== "admin") {
      throw new functions.https.HttpsError("permission-denied", "Only administrators can link to approver positions.");
    }
  }

  await ensureApproverDirectory();
  if (key === "org_adv" && assignedStage?.key !== "org_adv") {
    throw new functions.https.HttpsError(
      "permission-denied",
      "Organization Adviser accounts must be assigned to their own organization.",
    );
  }
  if (assignedStage?.key === "org_adv") {
    if (!identity.organizationCode) {
      throw new functions.https.HttpsError("failed-precondition", "Your adviser profile must have an organization assigned.");
    }
    await admin.database().ref(`approverOrganizations/${callerUid}`).set(identity.organizationCode);
  }
  const dirRef = admin.database().ref(`approverDirectory/${key}`);
  const snap = await dirRef.once("value");
  if (!snap.exists()) {
    throw new functions.https.HttpsError("not-found", `Approver position "${key}" not found.`);
  }

  if (assignedStage?.key !== "org_adv") {
    await dirRef.child("uid").set(callerUid);
  }

  const approvalsSnap = await admin.database().ref("approvals").once("value");
  const approvals = approvalsSnap.val() || {};
  const eventsSnap = await admin.database().ref("events").once("value");
  const events = eventsSnap.val() || {};

  const updates = {};
  const now = Date.now();

  for (const [eventId, app] of Object.entries(approvals)) {
    if (app && app.members && app.members[key]) {
      const member = app.members[key];
      const ev = events[eventId] || {};
      const eventOrganizationCode = await getProposalOrganizationCode(ev);
      if (
        assignedStage?.key === "org_adv" &&
        eventOrganizationCode !== identity.organizationCode
      ) continue;
      if (member.status === "review") {
        updates[`approverQueue/${callerUid}/${eventId}`] = {
          eventId,
          name: ev.name || ev.title || "Event",
          title: ev.name || ev.title || "Event",
          date: ev.startAt || "",
          venue: ev.venue || "",
          category: ev.category || "",
          ...(eventOrganizationCode ? { organizationCode: eventOrganizationCode } : {}),
          step: member.step,
          status: "pending",
          updatedAt: member.updatedAt || now,
        };
      } else if (member.status === "rev" || app.status === "revision") {
        updates[`approverQueue/${callerUid}/${eventId}`] = {
          eventId,
          name: ev.name || ev.title || "Event",
          title: ev.name || ev.title || "Event",
          date: ev.startAt || "",
          venue: ev.venue || "",
          category: ev.category || "",
          ...(eventOrganizationCode ? { organizationCode: eventOrganizationCode } : {}),
          step: member.step,
          status: "paused",
          paused: true,
          updatedAt: member.updatedAt || now,
        };
      }
    }
  }

  if (Object.keys(updates).length > 0) {
    await admin.database().ref().update(updates);
  }

  return ({ success: true, key, label: snap.val().label });
});

/**
 * 17. remindApprovers({ eventId, keys })
 */
exports.remindApprovers = functions.region("asia-southeast1").https.onCall(async (data, context) => {
  const { eventId, keys } = data || {};
  if (!eventId) {
    throw new functions.https.HttpsError("invalid-argument", "Event ID is required.");
  }
  const { role, eventData } = await verifyOrganizerEventOwnership(context.auth, eventId);

  const approvalSnap = await admin.database().ref(`approvals/${eventId}`).once("value");
  const approvalData = approvalSnap.val() || {};
  const members = approvalData.members || {};

  const targetKeys = Array.isArray(keys) && keys.length > 0 ? keys : Object.keys(members).filter((k) => members[k].status === "review");
  const callerName = context.auth.token.name || context.auth.token.email || "Event Organizer";
  const now = Date.now();

  const historyRef = admin.database().ref(`approvals/${eventId}/history`).push();
  await historyRef.set({
    action: "reminded",
    by: callerName,
    at: now,
    note: `Reminder sent to ${targetKeys.map((k) => members[k]?.label || k).join(", ")}.`,
  });
  if (role === "event_organizer") {
    await createAdminProposalNotifications(
      eventId,
      eventData,
      "proposal-reminder",
      `The Event Organizer sent a reminder for “${eventData.name || "Untitled event"}”.`,
      now,
    );
  }

  return ({ success: true, count: targetKeys.length });
});

/**
 * 18. submitCorrectionRequest({ field, message })
 */
exports.submitCorrectionRequest = functions.region("asia-southeast1").https.onCall(async (data, context) => {
  if (!context.auth || !context.auth.uid) {
    throw new functions.https.HttpsError("unauthenticated", "You must be signed in to submit a correction request.");
  }

  const { field, message } = data || {};
  if (!field || typeof field !== "string") {
    throw new functions.https.HttpsError("invalid-argument", "Please select which detail is wrong.");
  }
  const allowedFields = [
    "Student number",
    "Year and section",
    "Department",
    "Organization",
    "studentNo",
    "yearSection",
    "department",
    "organization",
  ];
  if (!allowedFields.includes(field.trim())) {
    throw new functions.https.HttpsError("invalid-argument", "Invalid field selected.");
  }

  const trimmedMessage = String(message || "").trim();
  if (trimmedMessage.length < 10) {
    throw new functions.https.HttpsError("invalid-argument", "Message must be at least 10 characters long.");
  }

  const uid = context.auth.uid;
  const reqRef = admin.database().ref("correctionRequests").push();
  const reqId = reqRef.key;
  const now = admin.database.ServerValue.TIMESTAMP;

  const requestData = {
    uid,
    field: field.trim(),
    message: trimmedMessage,
    status: "open",
    createdAt: now,
  };

  await reqRef.set(requestData);

  try {
    await admin.firestore().collection("correctionRequests").doc(reqId).set({
      ...requestData,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (fsErr) {
    console.warn("Firestore correctionRequests backup notice:", fsErr);
  }

  return ({ success: true, id: reqId });
});

/**
 * 19. syncUserEmail()
 */
exports.syncUserEmail = functions.region("asia-southeast1").https.onCall(async (data, context) => {
  if (!context.auth || !context.auth.uid) {
    throw new functions.https.HttpsError("unauthenticated", "You must be signed in to sync your email.");
  }

  const uid = context.auth.uid;
  const userRecord = await admin.auth().getUser(uid);
  const authEmail = userRecord.email;

  if (!authEmail) {
    throw new functions.https.HttpsError("failed-precondition", "No email associated with this account.");
  }

  await admin.database().ref(`users/${uid}/email`).set(authEmail);
  try {
    await admin.firestore().collection("users").doc(uid).set({ email: authEmail }, { merge: true });
  } catch (err) {
    console.warn("Firestore sync email notice:", err);
  }

  return ({ success: true, email: authEmail });
});

/**
 * 20. initializeStudentProfile({ uid, profile })
 */
exports.initializeStudentProfile = functions.region("asia-southeast1").https.onCall(async (data, context) => {
  if (!context.auth || !context.auth.uid) {
    throw new functions.https.HttpsError("unauthenticated", "Caller must be authenticated.");
  }

  const uid = context.auth.uid;
  data = data || {};

  const updates = {
    firstName: String(data.firstName || "").trim(),
    middleName: String(data.middleName || "").trim(),
    lastName: String(data.lastName || "").trim(),
    contactNumber: String(data.contactNumber || data.contact || "").trim(),
    studentNo: String(data.studentNo || data.studentNumber || data.studentId || "").trim(),
    yearSection: String(data.yearSection || data.year || "").trim(),
    department: String(data.department || "").trim(),
    organization: String(data.organization || "").trim(),
    email: String(data.email || context.auth.token?.email || "").trim().toLowerCase(),
    updatedAt: admin.database.ServerValue.TIMESTAMP,
  };

  await admin.database().ref(`users/${uid}`).update(updates);
  return ({ success: true });
});

/**
 * 21. registerForEvent({ eventId })
 */
exports.registerForEvent = functions.region("asia-southeast1").https.onCall(async (data, context) => {
  if (!context.auth || !context.auth.uid) {
    throw new functions.https.HttpsError("unauthenticated", "You must be signed in to register for an event.");
  }

  const { eventId } = data || {};
  if (!eventId || typeof eventId !== "string") {
    throw new functions.https.HttpsError("invalid-argument", "Event ID is required.");
  }

  const uid = context.auth.uid;
  const firestoreEventRef = admin.firestore().collection("events").doc(eventId);
  const firestoreEventSnapshot = await firestoreEventRef.get();
  if (firestoreEventSnapshot.exists) {
    const registrationRef = firestoreEventRef.collection("registrations").doc(uid);
    const now = Date.now();
    const result = await admin.firestore().runTransaction(async (transaction) => {
      const [eventSnapshot, registrationSnapshot] = await Promise.all([
        transaction.get(firestoreEventRef),
        transaction.get(registrationRef),
      ]);
      if (!eventSnapshot.exists) {
        throw new functions.https.HttpsError("not-found", "Event not found.");
      }

      const eventData = eventSnapshot.data() || {};
      const status = String(eventData.status || eventData.publicationStatus || "")
        .trim()
        .toLowerCase()
        .replace(/[ _-]+/g, " ");
      if (status !== "published" && eventData.published !== true && eventData.isPublished !== true) {
        throw new functions.https.HttpsError(
          "failed-precondition",
          "Registration is closed because this event is not published.",
        );
      }

      const eventEndAt = getEventEndTimestamp(eventData);
      if (eventEndAt && now >= eventEndAt) {
        throw new functions.https.HttpsError(
          "failed-precondition",
          "Registration is closed because this event has ended.",
        );
      }

      if (registrationSnapshot.exists && registrationSnapshot.data()?.status === "registered") {
        return {
          alreadyRegistered: true,
          registeredCount: Number(eventData.registeredCount) || 0,
          eventData,
        };
      }

      const capacityValue = Number(eventData.capacity ?? eventData.maxCapacity);
      const capacity = Number.isFinite(capacityValue) && capacityValue > 0
        ? capacityValue
        : null;
      const registeredCount = Math.max(0, Number(eventData.registeredCount) || 0);
      if (capacity !== null && registeredCount >= capacity) {
        throw new functions.https.HttpsError("failed-precondition", "This event is full.");
      }

      const nextCount = registeredCount + 1;
      transaction.update(firestoreEventRef, {
        registeredCount: nextCount,
        updatedAt: now,
      });
      transaction.set(registrationRef, {
        uid,
        status: "registered",
        registeredAt: now,
        at: now,
      });
      return {
        alreadyRegistered: false,
        registeredCount: nextCount,
        eventData,
      };
    });

    try {
      const rootRef = admin.database().ref();
      const updates = {
        [`registrations/${eventId}/${uid}`]: true,
        [`userRegistrations/${uid}/${eventId}`]: {
          status: "registered",
          at: now,
        },
        [`publicEvents/${eventId}/registeredCount`]: result.registeredCount,
        [`events/${eventId}/registeredCount`]: result.registeredCount,
      };
      const organizerUid =
        result.eventData.organizerUid ||
        result.eventData.organizerId ||
        result.eventData.createdBy;
      if (organizerUid) {
        updates[`organizerEvents/${organizerUid}/${eventId}/registeredCount`] =
          result.registeredCount;
      }
      await rootRef.update(updates);
    } catch (error) {
      console.warn("Firestore registration saved, but Realtime Database sync failed:", error);
    }

    return {
      success: true,
      alreadyRegistered: result.alreadyRegistered,
      registeredCount: result.registeredCount,
    };
  }

  const rootRef = admin.database().ref();

  const publicEventSnap = await rootRef.child(`publicEvents/${eventId}`).once("value");
  let eventData = publicEventSnap.val();
  if (!eventData) {
    const eventSnap = await rootRef.child(`events/${eventId}`).once("value");
    eventData = eventSnap.val();
  }

  if (!eventData) {
    throw new functions.https.HttpsError("not-found", "Event not found.");
  }

  if (eventData.status !== "published") {
    throw new functions.https.HttpsError("failed-precondition", "Registration is closed because this event is not published.");
  }

  const now = Date.now();
  let endAt = eventData.endAt;
  if (!endAt && eventData.startAt) {
    endAt = eventData.startAt + 3 * 60 * 60 * 1000;
  }
  if (endAt && now >= endAt) {
    throw new functions.https.HttpsError("failed-precondition", "Registration is closed because this event has ended.");
  }

  const userRegSnap = await rootRef.child(`userRegistrations/${uid}/${eventId}`).once("value");
  const existingUserReg = userRegSnap.val();
  const directRegSnap = await rootRef.child(`registrations/${eventId}/${uid}`).once("value");
  if ((existingUserReg && existingUserReg.status === "registered") || directRegSnap.val() === true) {
    return ({ success: true, message: "Already registered." });
  }

  const capacity = (typeof eventData.capacity === "number" && eventData.capacity > 0)
    ? eventData.capacity
    : (eventData.maxCapacity && Number(eventData.maxCapacity) > 0 ? Number(eventData.maxCapacity) : null);

  const countRef = rootRef.child(`publicEvents/${eventId}/registeredCount`);
  let newCount = 0;

  const txResult = await countRef.transaction((currentCount) => {
    const count = (currentCount === null || currentCount === undefined || currentCount < 0) ? 0 : currentCount;
    if (capacity !== null && count >= capacity) {
      return undefined;
    }
    return count + 1;
  });

  if (!txResult.committed) {
    throw new functions.https.HttpsError("failed-precondition", "This event is full.");
  }

  newCount = txResult.snapshot.val();

  try {
    const updates = {};
    updates[`registrations/${eventId}/${uid}`] = true;
    updates[`userRegistrations/${uid}/${eventId}`] = {
      status: "registered",
      at: now,
    };
    updates[`events/${eventId}/registeredCount`] = newCount;
    if (eventData.organizerId) {
      updates[`organizerEvents/${eventData.organizerId}/${eventId}/registeredCount`] = newCount;
    }
    await rootRef.update(updates);
  } catch (err) {
    console.error("Failed to commit user registration, rolling back count:", err);
    await countRef.transaction((curr) => (curr && curr > 0 ? curr - 1 : 0));
    throw new functions.https.HttpsError("internal", "Could not complete registration. Please try again.");
  }

  return ({ success: true, registeredCount: newCount });
});

/**
 * 22. cancelRegistration({ eventId })
 */
exports.cancelRegistration = functions.region("asia-southeast1").https.onCall(async (data, context) => {
  if (!context.auth || !context.auth.uid) {
    throw new functions.https.HttpsError("unauthenticated", "You must be signed in to cancel your registration.");
  }

  const { eventId } = data || {};
  if (!eventId || typeof eventId !== "string") {
    throw new functions.https.HttpsError("invalid-argument", "Event ID is required.");
  }

  const uid = context.auth.uid;
  const firestoreEventRef = admin.firestore().collection("events").doc(eventId);
  const firestoreEventSnapshot = await firestoreEventRef.get();
  if (firestoreEventSnapshot.exists) {
    const registrationRef = firestoreEventRef.collection("registrations").doc(uid);
    const now = Date.now();
    const result = await admin.firestore().runTransaction(async (transaction) => {
      const [eventSnapshot, registrationSnapshot] = await Promise.all([
        transaction.get(firestoreEventRef),
        transaction.get(registrationRef),
      ]);
      if (!eventSnapshot.exists) {
        throw new functions.https.HttpsError("not-found", "Event not found.");
      }

      const eventData = eventSnapshot.data() || {};
      if (!registrationSnapshot.exists || registrationSnapshot.data()?.status !== "registered") {
        return {
          alreadyCancelled: true,
          registeredCount: Math.max(0, Number(eventData.registeredCount) || 0),
          eventData,
        };
      }

      const eventEndAt = getEventEndTimestamp(eventData);
      if (eventEndAt && now >= eventEndAt) {
        throw new functions.https.HttpsError(
          "failed-precondition",
          "Registration is closed because this event has ended.",
        );
      }

      const nextCount = Math.max(0, Number(eventData.registeredCount) || 0) - 1;
      transaction.update(firestoreEventRef, {
        registeredCount: nextCount,
        updatedAt: now,
      });
      transaction.set(registrationRef, {
        uid,
        status: "cancelled",
        cancelledAt: now,
        at: now,
      });
      return {
        alreadyCancelled: false,
        registeredCount: nextCount,
        eventData,
      };
    });

    try {
      const rootRef = admin.database().ref();
      const updates = {
        [`registrations/${eventId}/${uid}`]: null,
        [`userRegistrations/${uid}/${eventId}`]: {
          status: "cancelled",
          at: now,
        },
        [`publicEvents/${eventId}/registeredCount`]: result.registeredCount,
        [`events/${eventId}/registeredCount`]: result.registeredCount,
      };
      const organizerUid =
        result.eventData.organizerUid ||
        result.eventData.organizerId ||
        result.eventData.createdBy;
      if (organizerUid) {
        updates[`organizerEvents/${organizerUid}/${eventId}/registeredCount`] =
          result.registeredCount;
      }
      await rootRef.update(updates);
    } catch (error) {
      console.warn("Firestore cancellation saved, but Realtime Database sync failed:", error);
    }

    return {
      success: true,
      alreadyCancelled: result.alreadyCancelled,
      registeredCount: result.registeredCount,
    };
  }

  const rootRef = admin.database().ref();

  const publicEventSnap = await rootRef.child(`publicEvents/${eventId}`).once("value");
  let eventData = publicEventSnap.val();
  if (!eventData) {
    const eventSnap = await rootRef.child(`events/${eventId}`).once("value");
    eventData = eventSnap.val();
  }

  const now = Date.now();
  if (eventData) {
    let endAt = eventData.endAt;
    if (!endAt && eventData.startAt) {
      endAt = eventData.startAt + 3 * 60 * 60 * 1000;
    }
    if (endAt && now >= endAt) {
      throw new functions.https.HttpsError("failed-precondition", "Registration is closed because this event has ended.");
    }
  }

  const userRegSnap = await rootRef.child(`userRegistrations/${uid}/${eventId}`).once("value");
  const existingUserReg = userRegSnap.val();
  const directRegSnap = await rootRef.child(`registrations/${eventId}/${uid}`).once("value");
  const isRegistered = (existingUserReg && existingUserReg.status === "registered") || directRegSnap.val() === true;

  if (!isRegistered) {
    return ({ success: true, message: "Not registered." });
  }

  const countRef = rootRef.child(`publicEvents/${eventId}/registeredCount`);
  let newCount = 0;
  try {
    const txResult = await countRef.transaction((currentCount) => {
      if (currentCount === null || currentCount === undefined || currentCount <= 0) {
        return 0;
      }
      return currentCount - 1;
    });
    newCount = txResult.snapshot ? (txResult.snapshot.val() || 0) : 0;
  } catch (txErr) {
    console.warn("Could not decrement registeredCount transaction:", txErr);
  }

  const updates = {};
  updates[`registrations/${eventId}/${uid}`] = null;
  updates[`userRegistrations/${uid}/${eventId}`] = {
    status: "cancelled",
    at: now,
  };
  updates[`events/${eventId}/registeredCount`] = newCount;
  if (eventData && eventData.organizerId) {
    updates[`organizerEvents/${eventData.organizerId}/${eventId}/registeredCount`] = newCount;
  }
  await rootRef.update(updates);

  return ({ success: true, registeredCount: newCount });
});

/**
 * 23. setFavorite({ eventId, favorite, replaceEventId, allowDuplicate, title })
 */
exports.setFavorite = functions.region("asia-southeast1").https.onCall(async (data, context) => {
  if (!context.auth || !context.auth.uid) {
    throw new functions.https.HttpsError("unauthenticated", "You must be signed in to manage favorites.");
  }

  const uid = context.auth.uid;
  const { eventId, favorite, replaceEventId, allowDuplicate, title: clientTitle } = data || {};

  if (!eventId || typeof eventId !== "string") {
    throw new functions.https.HttpsError("invalid-argument", "Event ID is required.");
  }

  const isFavorite = Boolean(favorite);
  const rootRef = admin.database().ref();

  const orgEventSnap = await rootRef.child(`organizerEvents/${uid}/${eventId}`).once("value");
  const eventSnap = await rootRef.child(`events/${eventId}`).once("value");
  const publicSnap = await rootRef.child(`publicEvents/${eventId}`).once("value");

  const orgEvent = orgEventSnap.val();
  const mainEvent = eventSnap.val();
  const pubEvent = publicSnap.val();

  const isOwned =
    Boolean(orgEvent) ||
    (mainEvent && (mainEvent.organizerId === uid || mainEvent.createdBy === uid || mainEvent.teacherId === uid)) ||
    (pubEvent && (pubEvent.organizerId === uid || pubEvent.createdBy === uid)) ||
    eventId.startsWith("seed-") ||
    eventId.startsWith("org-") ||
    eventId.startsWith("tch-");

  if (!isOwned) {
    throw new functions.https.HttpsError("permission-denied", "You can only manage favorites for your own events.");
  }

  let targetEventTitle = (
    clientTitle ||
    orgEvent?.name ||
    orgEvent?.title ||
    mainEvent?.name ||
    mainEvent?.title ||
    pubEvent?.name ||
    pubEvent?.title ||
    ""
  ).trim();

  if (replaceEventId) {
    if (typeof replaceEventId !== "string") {
      throw new functions.https.HttpsError("invalid-argument", "Replace Event ID must be a string.");
    }
    const repOrgSnap = await rootRef.child(`organizerEvents/${uid}/${replaceEventId}`).once("value");
    const repEventSnap = await rootRef.child(`events/${replaceEventId}`).once("value");
    const repMain = repEventSnap.val();
    const isRepOwned =
      Boolean(repOrgSnap.val()) ||
      (repMain && (repMain.organizerId === uid || repMain.createdBy === uid || repMain.teacherId === uid)) ||
      replaceEventId.startsWith("seed-") ||
      replaceEventId.startsWith("org-") ||
      replaceEventId.startsWith("tch-");

    if (!isRepOwned) {
      throw new functions.https.HttpsError("permission-denied", "You can only replace your own events.");
    }
  }

  const reuseRef = rootRef.child(`reuseLibrary/${uid}`);

  if (isFavorite && !allowDuplicate && targetEventTitle) {
    const reuseSnap = await reuseRef.once("value");
    const currentReuse = reuseSnap.val() || {};
    const lowerTarget = targetEventTitle.toLowerCase();

    for (const [key, data] of Object.entries(currentReuse)) {
      if (data && data.favorite === true && key !== eventId && key !== replaceEventId) {
        let existingTitle = "";
        const kOrgSnap = await rootRef.child(`organizerEvents/${uid}/${key}`).once("value");
        const kEventSnap = await rootRef.child(`events/${key}`).once("value");
        const kPubSnap = await rootRef.child(`publicEvents/${key}`).once("value");
        existingTitle = (
          kOrgSnap.val()?.name || kOrgSnap.val()?.title ||
          kEventSnap.val()?.name || kEventSnap.val()?.title ||
          kPubSnap.val()?.name || kPubSnap.val()?.title || ""
        ).trim();

        if (existingTitle && existingTitle.toLowerCase() === lowerTarget) {
          throw new functions.https.HttpsError("already-exists", "A favorite with this name already exists.");
        }
      }
    }
  }

  let txError = null;
  const txResult = await reuseRef.transaction((current) => {
    const data = current || {};
    const now = Date.now();

    if (isFavorite) {
      let favCount = 0;
      for (const [k, item] of Object.entries(data)) {
        if (item && item.favorite === true && k !== eventId && k !== replaceEventId) {
          favCount++;
        }
      }

      if (favCount >= 5) {
        txError = "Favorites are full.";
        return undefined;
      }

      if (replaceEventId && data[replaceEventId]) {
        data[replaceEventId] = {
          ...data[replaceEventId],
          favorite: false,
          updatedAt: now,
        };
      }

      data[eventId] = {
        ...(data[eventId] || {}),
        favorite: true,
        hidden: data[eventId]?.hidden || false,
        updatedAt: now,
      };
    } else {
      if (data[eventId]) {
        data[eventId] = {
          ...data[eventId],
          favorite: false,
          updatedAt: now,
        };
      } else {
        data[eventId] = {
          favorite: false,
          hidden: false,
          updatedAt: now,
        };
      }
    }

    return data;
  });

  if (!txResult.committed) {
    if (txError === "Favorites are full.") {
      throw new functions.https.HttpsError("failed-precondition", "Favorites are full.");
    }
    throw new functions.https.HttpsError("aborted", "Could not update favorites. Please try again.");
  }

  return ({
    success: true,
    eventId,
    favorite: isFavorite,
    replacedEventId: replaceEventId || null,
  });
});