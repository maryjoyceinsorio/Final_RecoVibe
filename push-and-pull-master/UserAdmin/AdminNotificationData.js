import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  collection,
  doc,
  getDoc,
  limit,
  onSnapshot,
  query,
  updateDoc,
  where,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { off, onValue, ref, update } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import { auth, authReady, db, isRtdbConfigured, rtdb } from "../UserStudent/firebaseConfig.js";
import { getCurrentStageKey, getEventStage, getStages } from "../eventWorkflow.js";

const DEBUG = false;
const MAX_EVENTS = 300;
const MAX_REGISTRATION_EVENTS = 15;
const MAX_REGISTRATIONS = 100;
const DAY_MS = 86400000;

function log(...args) {
  if (DEBUG) console.debug("[admin-notifications]", ...args);
}

function normalize(value) {
  return String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

function dateValue(value) {
  if (value && typeof value.toDate === "function") return value.toDate();
  if (value && typeof value.toMillis === "function") return new Date(value.toMillis());
  if (value && typeof value.seconds === "number") return new Date(value.seconds * 1000);
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
  if (typeof value === "number" && Number.isFinite(value)) {
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed : null;
  }
  if (typeof value === "string" && value.trim()) {
    const dateOnly = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
    const parsed = dateOnly
      ? new Date(`${dateOnly[1]}-${dateOnly[2]}-${dateOnly[3]}T00:00:00+08:00`)
      : new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed : null;
  }
  return null;
}

function valuesFrom(source, keys) {
  const found = [];
  keys.forEach((key) => {
    const value = source?.[key];
    (Array.isArray(value) ? value : [value]).forEach((entry) => {
      if (typeof entry === "string" || typeof entry === "number") {
        found.push(String(entry));
      } else if (entry && typeof entry === "object") {
        [
          entry.organizationCode,
          entry.organizationId,
          entry.organizationName,
          entry.orgCode,
          entry.orgId,
          entry.orgName,
          entry.organizerOrg,
          entry.organizerOrganization,
          entry.departmentCode,
          entry.departmentId,
          entry.code,
          entry.id,
          entry.name,
          entry.label,
        ].filter((item) => item != null && item !== "").forEach((item) => found.push(String(item)));
      }
    });
  });
  return found;
}

const PROFILE_ORG_FIELDS = [
  "organizationCode", "organizationId", "orgCode", "orgId", "organization",
  "organizationName", "orgName", "organizations", "orgIds", "assignedOrgs",
  "adviserOf", "courseOrganization", "courseOrganizations",
];
const APPROVER_ORG_FIELDS = PROFILE_ORG_FIELDS.filter((field) =>
  !["courseOrganization", "courseOrganizations"].includes(field),
);
const EVENT_ORG_FIELDS = [
  "orgId", "organizationId", "organizationCode", "organizerOrg", "organizerOrganization",
  "organization", "organizationName", "orgName",
];

function organizationValues(item) {
  const values = valuesFrom(item, EVENT_ORG_FIELDS);
  valuesFrom(item, ["organizationCodes", "orgIds", "targetOrganizations", "partnerOrganizations"])
    .forEach((value) => values.push(value));
  return [...new Set(values.map(normalize).filter(Boolean))];
}

function openToAll(item) {
  const audienceValues = [item?.targetAudience, item?.audience, item?.visibility]
    .map(normalize);
  const targetYear = normalize(item?.targetYear ?? "");
  const allOrganizations = normalize(item?.allOrganizations ?? "");
  return item?.openToAll === true ||
    item?.openForAll === true ||
    item?.allOrganizations === true ||
    ["all", "allorganizations", "opentoall", "openforall"].includes(allOrganizations) ||
    audienceValues.some((audience) => ["all", "allorganizations", "opentoall", "openforall", "public"].includes(audience)) ||
    ["all", "allorganizations", "opentoall", "openforall"].includes(targetYear);
}

function isSystemAnnouncement(item) {
  const audiences = [
    item?.audience, item?.targetAudience, item?.recipientRole,
    item?.targetRole, item?.audienceType,
  ].flatMap((value) => Array.isArray(value) ? value : [value]).map(normalize);
  return item?.systemWide === true ||
    item?.forAllAdmins === true ||
    item?.forAllAdvisers === true ||
    item?.allAdmins === true ||
    item?.allAdvisers === true ||
    audiences.some((audience) => ["alladmins", "alladvisers", "allorganizationadvisers", "systemwide"].includes(audience));
}

function isSystemWideAdmin(profile) {
  const role = normalize(profile?.role ?? profile?.userRole ?? "");
  const title = normalize([
    profile?.adminRole, profile?.roleName, profile?.position, profile?.title,
  ].filter(Boolean).join(" "));
  return ["superadmin", "systemadmin", "systemwideadmin"].includes(role) ||
    profile?.isSuperAdmin === true ||
    profile?.isSystemAdmin === true ||
    title.includes("superadmin") ||
    title.includes("systemwideadmin");
}

function profileRole(profile) {
  return String(
    profile?.approvalStage || profile?.approvalStageKey || profile?.assignedApprovalStage ||
    profile?.approverStage || profile?.approverKey || profile?.approvalRole ||
    profile?.approverRole || profile?.assignedRole || profile?.assignedApprover ||
    profile?.adminRole || profile?.roleName || profile?.stageKey || profile?.position ||
    profile?.role || profile?.userRole || "",
  ).trim();
}

async function loadIdentity(user) {
  const profileResults = await Promise.allSettled([
    getDoc(doc(db, "adminUser", user.uid)),
    getDoc(doc(db, "users", user.uid)),
    getDoc(doc(db, "approverOrganizations", user.uid)),
  ]);
  const adminProfile = profileResults[0].status === "fulfilled" && profileResults[0].value.exists()
    ? profileResults[0].value.data() || {}
    : {};
  const userProfile = profileResults[1].status === "fulfilled" && profileResults[1].value.exists()
    ? profileResults[1].value.data() || {}
    : {};
  const approverProfile = profileResults[2].status === "fulfilled" && profileResults[2].value.exists()
    ? profileResults[2].value.data() || {}
    : {};
  if (profileResults.every((result) => result.status === "rejected")) {
    throw profileResults[0].reason;
  }
  const profile = { ...userProfile, ...adminProfile };
  const accountRole = normalize(profile.role || profile.userRole || "");
  const approvalRole = normalize(profileRole(profile));
  const allowedRoles = [
    "admin", "superadmin", "systemadmin", "systemwideadmin", "orgadv",
    "orgadviser", "orgadvisor", "organizationadviser", "organizationadvisor",
    "adviser", "advisor", "sirabelida", "labhead", "laboratoryhead",
    "propertycustodian", "administrativeofficer", "hap",
    "headofacademicprograms", "qaccoordinator", "osas",
  ];
  if (!allowedRoles.includes(accountRole) && !allowedRoles.includes(approvalRole) &&
      !profileApprovalStageKeys(profile).size &&
      profile.isSuperAdmin !== true && profile.isSystemAdmin !== true) {
    throw new Error("The signed-in account is not an Admin.");
  }
  const rawOrgs = [
    ...valuesFrom(approverProfile, APPROVER_ORG_FIELDS),
    ...valuesFrom(adminProfile, PROFILE_ORG_FIELDS),
    ...valuesFrom(userProfile, PROFILE_ORG_FIELDS),
  ].filter(Boolean);
  const myOrgs = new Set(rawOrgs.map(normalize).filter(Boolean));
  const orgQueryValues = [...new Set(rawOrgs.flatMap((value) => [
    value.trim(),
    value.trim().toLowerCase(),
    value.trim().toUpperCase(),
    normalize(value),
  ]).filter(Boolean))];
  return {
    profile,
    myOrgs,
    orgQueryValues,
    systemWide: isSystemWideAdmin(profile),
    role: profileRole(profile),
    approverStageKey: approvalStageKey(profileRole(profile)) ||
      [...profileApprovalStageKeys(profile)][0] ||
      null,
  };
}

function isRelevantForMe(item, context) {
  if (context.systemWide) return true;
  if (item.openToAll === true) return true;
  if (isCurrentStageApprover(item, context.profile, context.uid)) return true;
  const orgValues = [
    item.orgId,
    ...(Array.isArray(item.orgIds) ? item.orgIds : []),
    ...(Array.isArray(item.organizationCodes) ? item.organizationCodes : []),
  ].map(normalize).filter(Boolean);
  if (orgValues.length) return orgValues.some((value) => context.myOrgs.has(value));
  return [item.recipientUid, item.userId].some((value) => String(value || "") === context.uid) ||
    isSystemAnnouncement(item);
}

function normalizeNotification(item, context) {
  const orgs = organizationValues(item);
  const sourceValues = Array.isArray(item.sources)
    ? item.sources
    : item.source ? [item.source] : [];
  return {
    ...item,
    id: String(item.id ?? ""),
    title: item.title || "Notification",
    type: item.type || "default",
    message: item.message || "",
    createdAt: item.createdAt ?? item.timestamp ?? null,
    read: item.read === true || item.isRead === true,
    orgId: orgs[0] || normalize(item.orgId) || null,
    orgIds: orgs,
    openToAll: openToAll(item),
    sources: [...new Set(sourceValues)],
    recipientUid: item.recipientUid || "",
    userId: item.userId || "",
    _ownerUid: context.uid,
  };
}

function getLocalState(key) {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function chunks(values, size) {
  const result = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function eventStatus(event) {
  return normalize(event.approvalStatus || event.status || "");
}

function stageEntries(event) {
  const stages = event.approvalStages;
  if (Array.isArray(stages)) return stages.map((entry, index) => [String(entry?.id || index), entry || {}]);
  return stages && typeof stages === "object"
    ? Object.entries(stages).map(([id, entry]) => [id, entry && typeof entry === "object" ? entry : {}])
    : [];
}

function approvalStageKey(value) {
  return getStages({ approvalSteps: [value] })[0] || null;
}

function profileApprovalStageKeys(profile) {
  const values = [
    profileRole(profile),
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
    profile?.accountNumber,
    profile?.accountNo,
    profile?.account_number,
    profile?.account_no,
  ];
  const stageKeys = new Set(values.map(approvalStageKey).filter(Boolean));
  const aliases = {
    org_adv: ["orgadv", "orgadviser", "orgadvisor", "organizationadviser", "organizationadvisor", "adviser", "advisor"],
    sir_abelida: ["sirabelida", "abelida", "laboratoryhead", "propertycustodian", "administrativeofficer", "labhead"],
    hap: ["hap", "headofacademicprograms", "qaccoordinator"],
    osas: ["osas"],
  };
  values.map(normalize).filter(Boolean).forEach((value) => {
    Object.entries(aliases).forEach(([stageKey, stageAliases]) => {
      if (stageAliases.some((alias) => value === alias || value.includes(alias))) {
        stageKeys.add(stageKey);
      }
    });
  });
  return stageKeys;
}

function currentApprovalStageKey(event) {
  const stages = getStages(event);
  if (!stages.length) return null;
  const declaredStage = [
    event.approvalCurrentStage,
    event.currentApproverStage,
    event.currentApprovalStage,
    event.approverStage,
    event.currentStage,
  ].map(approvalStageKey).find((stageKey) => stageKey && stages.includes(stageKey));
  if (declaredStage) return declaredStage;

  const rawStep = event.approvalCurrentStep ??
    event.currentApprovalStep ??
    event.currentStep ??
    event.approval?.approvalCurrentStep ??
    event.approval?.currentStep;
  const step = rawStep === "" || rawStep === null || rawStep === undefined
    ? NaN
    : Number(rawStep);
  if (Number.isInteger(step) && step >= 0 && step < stages.length) {
    return stages[step];
  }
  return getCurrentStageKey(event);
}

function stageEntryFor(event, stageKey) {
  return stageEntries(event).find(([key, entry]) => [
    key,
    entry.key,
    entry.roleKey,
    entry.id,
    entry.name,
    entry.label,
  ].some((value) => approvalStageKey(value) === stageKey))?.[1] || null;
}

function isCurrentStageApprover(event, profile, uid) {
  const stages = getStages(event);
  const currentStage = currentApprovalStageKey(event);
  if (!currentStage || !stages.includes(currentStage)) return false;
  if (["approved", "rejected", "revision", "cancelled", "canceled"].includes(eventStatus(event))) {
    return false;
  }

  const workflowStage = getEventStage(event).stages.find((stage) => stage.key === currentStage);
  if (workflowStage?.approved) return false;
  const stage = stageEntryFor(event, currentStage);
  if (["approved", "ok", "complete", "completed", "rejected", "revision"].includes(normalize(stage?.status))) {
    return false;
  }

  const assignments = event.approverAssignments?.[currentStage] || {};
  const stageUidFields = {
    org_adv: ["orgAdviserUid", "organizationAdviserUid", "adviserUid"],
    sir_abelida: ["labHeadUid", "laboratoryHeadUid", "propertyCustodianUid", "sirAbelidaUid"],
    hap: ["hapUid", "qacCoordinatorUid"],
    osas: ["osasUid"],
  };
  const stageEmailFields = {
    org_adv: ["orgAdviserEmail", "organizationAdviserEmail", "adviserEmail"],
    sir_abelida: ["labHeadEmail", "laboratoryHeadEmail", "propertyCustodianEmail", "sirAbelidaEmail"],
    hap: ["hapEmail", "qacCoordinatorEmail"],
    osas: ["osasEmail"],
  };
  const assignedUid = String(
    stage?.reviewerUid ||
    stage?.assignedReviewerUid ||
    stage?.approverUid ||
    stage?.assignedUid ||
    stage?.uid ||
    assignments.reviewerUid ||
    assignments.approverUid ||
    assignments.uid ||
    stageUidFields[currentStage]?.map((field) => event[field]).find(Boolean) ||
    event[`${currentStage}ReviewerUid`] ||
    event[`${currentStage}ApproverUid`] ||
    "",
  ).trim();
  const assignedEmail = String(
    stage?.reviewerEmail ||
    stage?.assignedReviewerEmail ||
    stage?.approverEmail ||
    stage?.assignedEmail ||
    assignments.reviewerEmail ||
    assignments.approverEmail ||
    assignments.email ||
    stageEmailFields[currentStage]?.map((field) => event[field]).find(Boolean) ||
    event[`${currentStage}ReviewerEmail`] ||
    "",
  ).trim().toLowerCase();
  if (assignedUid) return assignedUid === uid;
  if (assignedEmail) return assignedEmail === String(profile.email || "").trim().toLowerCase();
  return profileApprovalStageKeys(profile).has(currentStage);
}

function isAdviserProfile(profile) {
  return profileApprovalStageKeys(profile).has("org_adv");
}

function isApprovalRelatedNotification(item) {
  const type = normalize(item.type);
  const content = normalize(`${item.title || ""} ${item.message || ""}`);
  return type === "decision" ||
    type === "eventapproved" ||
    type === "eventrejected" ||
    type.includes("approval") ||
    type.includes("stage") ||
    content.includes("approvalneeded") ||
    content.includes("wasapproved") ||
    content.includes("wasrejected") ||
    content.includes("forwardedto");
}

function hasActiveRejection(event) {
  const activeStageKeys = getStages(event);
  return (Array.isArray(event.approvalHistory) ? event.approvalHistory : [])
    .some((entry) =>
      activeStageKeys.includes(approvalStageKey(entry?.stage || entry?.stageKey || entry?.key)) &&
      normalize(entry?.decision || entry?.action) === "rejected",
    ) || activeStageKeys.some((stageKey) =>
      normalize(stageEntryFor(event, stageKey)?.status) === "rejected",
    );
}

function shouldSuppressApprovalNotification(item, context, proposalsById) {
  if (!isApprovalRelatedNotification(item)) return false;
  const eventId = String(item.eventId || item.proposalId || "");
  const type = normalize(item.type);
  const content = normalize(`${item.title || ""} ${item.message || ""}`);
  const isApprovalNeeded = type === "approvalneeded" || content.includes("approvalneeded");
  if (!eventId) return isApprovalNeeded;
  const knownProposal = proposalsById.get(eventId);
  if (
    isAdviserProfile(context.profile) &&
    !knownProposal &&
    !Object.prototype.hasOwnProperty.call(item, "approvalSteps")
  ) return true;
  const proposal = knownProposal || item;
  const hasApprovalStepsSnapshot = Object.prototype.hasOwnProperty.call(proposal, "approvalSteps");

  if (
    isAdviserProfile(context.profile) &&
    hasApprovalStepsSnapshot &&
    !getStages(proposal).includes("org_adv")
  ) return true;
  if (isApprovalNeeded) {
    return !isCurrentStageApprover(proposal, context.profile, context.uid);
  }
  if (
    hasApprovalStepsSnapshot &&
    (type === "eventapproved" || content.includes("wasapproved")) &&
    !getEventStage(proposal).isFullyApproved
  ) return true;
  if (
    hasApprovalStepsSnapshot &&
    (type === "eventrejected" || content.includes("wasrejected")) &&
    !hasActiveRejection(proposal)
  ) return true;
  return false;
}

function eventOrgMetadata(event) {
  const orgIds = organizationValues(event);
  const audience = {
    ...event,
    openToAll: openToAll(event),
    orgId: orgIds[0] || null,
    orgIds,
  };
  return audience;
}

function eventStart(event) {
  const direct = dateValue(event.startAt || event.startsAt);
  if (direct) return direct;
  const eventDate = dateValue(event.dateStart || event.dateISO || event.date || event.eventDate);
  const day = eventDate
    ? new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila" }).format(eventDate)
    : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const time = String(event.timeStart || event.startTime || String(event.time || "").split(/\s*[-–]\s*/)[0] || "00:00").trim();
  const clock = time.match(/^(\d{1,2}):(\d{2})(?:\s*(AM|PM))?$/i);
  if (!clock) return dateValue(`${day}T${time}+08:00`);
  let hour = Number(clock[1]);
  if (clock[3]) hour = (hour % 12) + (clock[3].toUpperCase() === "PM" ? 12 : 0);
  return dateValue(`${day}T${String(hour).padStart(2, "0")}:${clock[2]}:00+08:00`);
}

function manilaDay(value) {
  const date = dateValue(value);
  return date
    ? new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila" }).format(date)
    : "";
}

function eventTitle(event) {
  return event.title || event.eventTitle || "Untitled event";
}

function derivedItem(type, event, stamp, title, message) {
  const eventId = String(event.id || event.eventId || "");
  const date = dateValue(stamp);
  if (!eventId || !date) return null;
  const org = eventOrgMetadata(event);
  return {
    id: `${type}-${eventId}-${date.toISOString()}`,
    eventId,
    proposalId: eventId,
    type,
    title: title || "Notification",
    message: message || "",
    createdAt: date.toISOString(),
    read: false,
    source: "derived",
    ...org,
  };
}

function hasEventConflict(event, events) {
  const day = String(event.dateISO || event.date || event.eventDate || "").slice(0, 10);
  const venue = event.venue || event.location;
  if (!day || !venue) return false;
  const parseMinutes = (value) => {
    const text = String(value || "");
    let match = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(text);
    if (match) return ((Number(match[1]) % 12) + (match[3].toUpperCase() === "PM" ? 12 : 0)) * 60 + Number(match[2]);
    match = /^(\d{1,2}):(\d{2})$/.exec(text);
    return match ? Number(match[1]) * 60 + Number(match[2]) : null;
  };
  const timeParts = String(event.time || "").split(/\s*[-–]\s*/);
  const start = parseMinutes(event.startTime || timeParts[0]);
  const end = parseMinutes(event.endTime || timeParts[1]);
  if (start == null || end == null) return false;
  return events.some((other) => {
    if (String(other.id || other.eventId) === String(event.id || event.eventId)) return false;
    if (["draft", "rejected", "cancelled", "canceled"].includes(eventStatus(other))) return false;
    if (String(other.dateISO || other.date || other.eventDate || "").slice(0, 10) !== day) return false;
    if ((other.venue || other.location) !== venue) return false;
    const otherParts = String(other.time || "").split(/\s*[-–]\s*/);
    const otherStart = parseMinutes(other.startTime || otherParts[0]);
    const otherEnd = parseMinutes(other.endTime || otherParts[1]);
    return otherStart != null && otherEnd != null && start < otherEnd && end > otherStart;
  });
}

function deriveEventNotifications(event, context, now, allEvents = []) {
  const items = [];
  const state = normalize(event.status || event.approvalStatus || "");
  const title = eventTitle(event);
  const approvalStatus = normalize(event.approvalStatus || "");
  const statusStamp = event.reviewedAt || event.updatedAt;
  const eventId = String(event.id || event.eventId || "");
  const isPending = ["pending", "pendingapproval"].includes(state);

  if (isPending && isCurrentStageApprover(event, context.profile, context.uid)) {
    const stamp = event.submittedAt || event.createdAt || event.updatedAt;
    const item = derivedItem("approval-needed", event, stamp, `Approval needed: ${title}`, `${title} is waiting for your approval.`);
    if (item) items.push(item);
  }
  if (state === "finaldocumentssubmitted") {
    const item = derivedItem(
      "final-documents",
      event,
      event.submittedAt || event.updatedAt || event.createdAt,
      "Final Documents Submitted",
      `Final documents are ready for review for “${title}”.`,
    );
    if (item) items.push(item);
  }
  if (normalize(event.rescheduleRequest?.status) === "pending") {
    const item = derivedItem(
      "reschedule",
      event,
      event.rescheduleRequest.updatedAt || event.rescheduleRequest.submittedAt || event.updatedAt,
      "Reschedule Requested",
      `A reschedule was requested for “${title}”.`,
    );
    if (item) items.push(item);
  }
  if (["cancelled", "canceled"].includes(state) &&
      event.cancellation?.cancelledAt && !event.cancellation?.acknowledgedAt) {
    const item = derivedItem(
      "cancellation",
      event,
      event.cancellation.cancelledAt,
      "Event Cancelled",
      `The organizer cancelled “${title}”.`,
    );
    if (item) items.push(item);
  }
  if (isPending && hasEventConflict(event, allEvents)) {
    const item = derivedItem(
      "conflict",
      event,
      event.submittedAt || event.createdAt || event.updatedAt,
      "Venue Conflict Detected",
      `“${title}” overlaps another event at the same venue.`,
    );
    if (item) items.push(item);
  }
  (Array.isArray(event.reviewHistory) ? event.reviewHistory : [])
    .filter((entry) => [context.uid, String(context.profile.email || "").toLowerCase()]
      .includes(String(entry.by || "").toLowerCase()))
    .forEach((entry) => {
      const item = derivedItem(
        "decision",
        event,
        entry.at,
        "Review Decision Recorded",
        `${String(entry.action || "review").replace(/_/g, " ")} for “${title}”.`,
      );
      if (item) items.push(item);
    });
  const activeStageKeys = getStages(event);
  const workflow = getEventStage(event);
  const hasApprovalStepsSnapshot = Object.prototype.hasOwnProperty.call(event, "approvalSteps");
  const rejectedInActiveStage = hasActiveRejection(event);
  const statusType = (state.includes("approved") || approvalStatus === "approved") &&
      (!hasApprovalStepsSnapshot || workflow.isFullyApproved)
    ? "event-approved"
    : (["rejected", "revision", "needsrevision"].includes(state) ||
        ["rejected", "revision", "needsrevision"].includes(approvalStatus)) &&
    (!hasApprovalStepsSnapshot || rejectedInActiveStage)
      ? "event-rejected"
      : ["cancelled", "canceled"].includes(state)
        ? "event-cancelled"
        : state.includes("rescheduled")
          ? "event-rescheduled"
          : "";
  if (statusType && statusStamp) {
    const label = {
      "event-approved": "was approved",
      "event-rejected": "was rejected",
      "event-cancelled": "was cancelled",
      "event-rescheduled": "was rescheduled",
    }[statusType];
    const item = derivedItem(statusType, event, statusStamp, `${title} ${label}`, `${title} ${label}.`);
    if (item) items.push(item);
  }
  const publishedAt = dateValue(event.publishedAt || event.updatedAt || event.createdAt);
  if (state === "published" && publishedAt && now - publishedAt.getTime() <= 14 * DAY_MS && now >= publishedAt.getTime()) {
    const item = derivedItem("event-published", event, event.publishedAt || event.updatedAt || event.createdAt, `New event published: ${title}`, `${title} is now published.`);
    if (item) items.push(item);
  }
  if (state === "published") {
    const start = eventStart(event);
    const diff = start ? start.getTime() - now : -1;
    if (start && diff > 0 && diff <= DAY_MS) {
      const hours = Math.max(1, Math.ceil(diff / 3600000));
      const message = diff <= 24 * 3600000 && manilaDay(start) !== manilaDay(new Date(now))
        ? `${title} starts tomorrow.`
        : `${title} starts in ${hours} ${hours === 1 ? "hour" : "hours"}.`;
      const item = derivedItem("event-reminder", event, start.toISOString(), `${title} ${message.replace(`${title} `, "")}`, message);
      if (item) items.push(item);
    }
  }
  return items;
}

function registrationName(data) {
  return data.studentName || data.name || data.fullName || "";
}

function registrationTime(data) {
  return data.registeredAt || data.createdAt || data.timestamp || null;
}

function dedupeFilteredItems(candidates, localList, permanentIds) {
  const saved = new Map(localList.map((item) => [String(item.id), item]));
  const byId = new Map();
  candidates.forEach((raw) => {
    const item = raw;
    if (!item.id) return;
    const stored = saved.get(item.id);
    const merged = {
      ...stored,
      ...item,
      read: stored && typeof stored.read === "boolean" ? stored.read : item.read,
      sources: [...new Set([...(stored?.sources || []), ...(item.sources || [])])],
    };
    const previous = byId.get(item.id);
    byId.set(item.id, {
      ...previous,
      ...merged,
      sources: [...new Set([...(previous?.sources || []), ...(merged.sources || [])])],
    });
  });
  const allItems = [...byId.values()].filter((item) => !permanentIds.has(item.id));
  allItems.sort((a, b) => (dateValue(b.createdAt)?.getTime() || 0) - (dateValue(a.createdAt)?.getTime() || 0));
  return allItems;
}

export function subscribeAdminNotifications(onChange) {
  let stopped = false;
  let activeUid = "";
  let authUnsubscribe = null;
  let safetyTimer = null;
  let subscriptions = [];
  let rtdbRef = null;
  let context = null;
  let controllerState = {
    uid: "",
    role: "",
    myOrgs: [],
    items: [],
    allItems: [],
    trash: [],
    unreadCount: 0,
    loading: true,
    error: "",
    sourceCounts: {},
    correctionRequests: [],
    correctionRequestsLoading: false,
    correctionRequestsError: "",
  };
  let firestoreItems = [];
  let rtdbItems = [];
  let eventItems = [];
  let registrationItems = [];
  let correctionItems = [];
  let correctionRequests = [];
  let correctionRequestsUnsubscribe = null;
  let correctionRequestsTimer = null;
  let events = [];
  let cachedEvents = [];
  let sourceState = {};
  let regUnsubs = new Map();
  let registrationErrorLogged = false;

  const publish = (patch = {}) => {
    if (stopped) return;
    controllerState = { ...controllerState, ...patch };
    onChange?.(controllerState);
  };

  const unsubscribeSources = () => {
    clearTimeout(safetyTimer);
    safetyTimer = null;
    subscriptions.forEach((unsubscribe) => {
      try { unsubscribe(); } catch (error) { log("unsubscribe failed", error); }
    });
    subscriptions = [];
    if (rtdbRef) {
      try { off(rtdbRef); } catch (error) { log("RTDB unsubscribe failed", error); }
      rtdbRef = null;
    }
    regUnsubs.forEach((unsubscribe) => {
      try { unsubscribe(); } catch (error) { log("registration unsubscribe failed", error); }
    });
    regUnsubs = new Map();
    if (correctionRequestsUnsubscribe) {
      try { correctionRequestsUnsubscribe(); } catch (error) { log("correction request unsubscribe failed", error); }
      correctionRequestsUnsubscribe = null;
    }
    clearTimeout(correctionRequestsTimer);
    correctionRequestsTimer = null;
  };

  const refresh = () => {
    if (!context || stopped) return;
    const key = `recovibeAdminNotifications:${context.uid}`;
    const trashKey = `recovibeAdminDeletedNotifications:${context.uid}`;
    const permanentKey = `recovibeAdminPermanentlyDeleted:${context.uid}`;
    const localList = getLocalState(key);
    const activeCorrectionIds = new Set(correctionItems.map((item) => item.id));
    const localCandidates = localList.filter((item) =>
      item.type !== "correction-request" || activeCorrectionIds.has(String(item.id)),
    );
    const trashList = getLocalState(trashKey).filter((item) => Number(item.expiresAt) > Date.now());
    const permanentIds = new Set(getLocalState(permanentKey).map(String));
    const candidates = [
      ...localCandidates,
      ...firestoreItems,
      ...rtdbItems,
      ...eventItems,
      ...registrationItems,
      ...correctionItems,
    ];
    const proposalsById = new Map(
      [...events, ...cachedEvents]
        .map((event) => [String(event.id || event.eventId || ""), event])
        .filter(([id]) => id),
    );
    const filteredCandidates = [];
    const dropped = [];
    candidates.forEach((candidate) => {
      const item = normalizeNotification(candidate, context);
      if (
        item.id &&
        isRelevantForMe(item, context) &&
        !shouldSuppressApprovalNotification(item, context, proposalsById)
      ) {
        filteredCandidates.push(item);
      } else {
        dropped.push({ id: item.id, orgId: item.orgId });
      }
    });
    const allItems = dedupeFilteredItems(filteredCandidates, localList, permanentIds);
    const deletedIds = new Set(trashList.map((item) => String(item.id)));
    const visibleTrash = trashList
      .map((item) => normalizeNotification(item, context))
      .filter((item) => item.id && isRelevantForMe(item, context) && !permanentIds.has(item.id))
      .filter((item) => item.expiresAt > Date.now())
      .sort((a, b) => (dateValue(b.deletedAt)?.getTime() || 0) - (dateValue(a.deletedAt)?.getTime() || 0));
    const merged = {
      allItems,
      items: allItems.filter((item) => !deletedIds.has(item.id)),
      trash: visibleTrash,
    };
    const unreadCount = merged.items.filter((item) => !item.read).length;
    const failures = Object.values(sourceState).filter((entry) => entry === "error").length;
    const settled = Object.values(sourceState).filter((entry) => entry === "success" || entry === "error").length;
    const sourceCount = Object.keys(sourceState).length;
    const allFailed = sourceCount > 0 && settled === sourceCount && failures === sourceCount;
    const firestoreAfterFilter = filteredCandidates.filter((item) => item.sources.includes("firestore")).length;
    const rtdbAfterFilter = filteredCandidates.filter((item) => item.sources.includes("rtdb")).length;
    const derivedAfterFilter = filteredCandidates.filter((item) => item.source === "derived").length;
    const registrationAfterFilter = filteredCandidates.filter((item) => item.type === "registration").length;
    const counts = {
      firestore: { beforeFilter: firestoreItems.length, afterFilter: firestoreAfterFilter },
      rtdb: { beforeFilter: rtdbItems.length, afterFilter: rtdbAfterFilter },
      events: { beforeFilter: eventItems.length, afterFilter: Math.max(0, derivedAfterFilter - registrationAfterFilter) },
      registrations: { beforeFilter: registrationItems.length, afterFilter: registrationAfterFilter },
      merged: merged.items.length,
      unread: unreadCount,
    };
    log("uid", context.uid, "role", context.role, "myOrgs", [...context.myOrgs], "counts", counts);
    log("loading", controllerState.loading, "merged", merged.items.length, "unread", unreadCount);
    if (dropped.length) log("dropped items", dropped);
    if (merged.items[0]) log("first", merged.items[0]);
    publish({
      items: merged.items,
      allItems: merged.allItems,
      trash: merged.trash,
      unreadCount,
      sourceCounts: counts,
      error: allFailed ? "Notifications could not be loaded. Please retry." : "",
      correctionRequests,
    });
  };

  const canReviewCorrections = (identity) => {
    const role = normalize(identity.profile.role || identity.profile.userRole || "");
    return identity.systemWide ||
      ["admin", "superadmin", "systemadmin", "systemwideadmin"].includes(role) ||
      identity.profile.isSuperAdmin === true ||
      identity.profile.isSystemAdmin === true ||
      profileApprovalStageKeys(identity.profile).has("osas") ||
      approvalStageKey(profileRole(identity.profile)) === "osas";
  };

  const subscribeCorrectionRequests = (user) => {
    if (!db || !context || !canReviewCorrections(context)) {
      correctionRequests = [];
      correctionItems = [];
      publish({
        correctionRequests,
        correctionRequestsLoading: false,
        correctionRequestsError: "",
      });
      return;
    }
    if (correctionRequestsUnsubscribe) {
      correctionRequestsUnsubscribe();
      correctionRequestsUnsubscribe = null;
    }
    clearTimeout(correctionRequestsTimer);
    correctionRequests = [];
    correctionItems = [];
    publish({
      correctionRequests,
      correctionRequestsLoading: true,
      correctionRequestsError: "",
    });
    correctionRequestsTimer = setTimeout(() => {
      if (controllerState.correctionRequestsLoading) {
        publish({
          correctionRequestsLoading: false,
          correctionRequestsError: "Correction requests are taking too long to load.",
        });
      }
    }, 5000);
    try {
      correctionRequestsUnsubscribe = onSnapshot(
        collection(db, "correctionRequests"),
        (snapshot) => {
          if (stopped || auth.currentUser?.uid !== user.uid) return;
          correctionRequests = snapshot.docs.map((requestSnapshot) => ({
            ...requestSnapshot.data(),
            id: requestSnapshot.id,
          }));
          correctionItems = correctionRequests
            .filter((request) => normalize(request.status) === "pending")
            .map((request) => ({
              id: `correction-${request.id}`,
              correctionRequestId: request.id,
              type: "correction-request",
              title: `Correction request from ${request.requesterName || "Teacher"}`,
              message: `${request.fieldLabel || request.field || "Detail"}: ${request.currentValue ?? ""} -> ${request.requestedValue ?? ""}`,
              createdAt: request.createdAtMs ?? request.createdAt ?? null,
              read: false,
              source: "derived",
              openToAll: true,
            }));
          clearTimeout(correctionRequestsTimer);
          correctionRequestsTimer = null;
          publish({
            correctionRequests,
            correctionRequestsLoading: false,
            correctionRequestsError: "",
          });
          refresh();
        },
        (error) => {
          if (stopped || auth.currentUser?.uid !== user.uid) return;
          log("correction requests listener failed", error.code || error);
          clearTimeout(correctionRequestsTimer);
          correctionRequestsTimer = null;
          correctionRequests = [];
          correctionItems = [];
          publish({
            correctionRequests,
            correctionRequestsLoading: false,
            correctionRequestsError: error.code === "permission-denied"
              ? "You don't have permission to view correction requests."
              : "Couldn't load correction requests. Check your connection and try again.",
          });
          refresh();
        },
      );
    } catch (error) {
      log("correction requests listener could not start", error.code || error);
      clearTimeout(correctionRequestsTimer);
      correctionRequestsTimer = null;
      correctionRequests = [];
      correctionItems = [];
      publish({
        correctionRequests,
        correctionRequestsLoading: false,
        correctionRequestsError: "Couldn't load correction requests. Check your connection and try again.",
      });
      refresh();
    }
  };

  const markSource = (name, status) => {
    sourceState[name] = status;
    settleLoading();
    refresh();
  };

  const settleLoading = () => {
    if (controllerState.loading) {
      controllerState.loading = false;
      clearTimeout(safetyTimer);
      safetyTimer = null;
      publish({ loading: false });
    }
  };

  const addRegistrationListeners = () => {
    if (!db || !context) return;
    const eligible = events
      .filter((event) => {
        const status = eventStatus(event);
        return ["published", "approved"].includes(status);
      })
      .filter((event) => isRelevantForMe(eventOrgMetadata(event), context))
      .sort((a, b) => {
        const aStart = eventStart(a)?.getTime() || 0;
        const bStart = eventStart(b)?.getTime() || 0;
        const now = Date.now();
        const aRank = aStart
          ? aStart >= now ? aStart - now : DAY_MS + now - aStart
          : 2 * DAY_MS + now - (dateValue(a.updatedAt || a.createdAt)?.getTime() || 0);
        const bRank = bStart
          ? bStart >= now ? bStart - now : DAY_MS + now - bStart
          : 2 * DAY_MS + now - (dateValue(b.updatedAt || b.createdAt)?.getTime() || 0);
        return aRank - bRank;
      })
      .slice(0, MAX_REGISTRATION_EVENTS);
    const wanted = new Set(eligible.map((event) => String(event.id)));
    regUnsubs.forEach((unsubscribe, id) => {
      if (!wanted.has(id)) {
        unsubscribe();
        regUnsubs.delete(id);
        delete sourceState[`registrations:${id}`];
      }
    });
    eligible.forEach((event) => {
      const eventId = String(event.id);
      if (regUnsubs.has(eventId)) return;
      try {
        const registrationQuery = query(
          collection(db, "events", eventId, "registrations"),
          limit(MAX_REGISTRATIONS),
        );
        const unsubscribe = onSnapshot(
          registrationQuery,
          (snapshot) => {
            if (stopped || auth.currentUser?.uid !== context?.uid) return;
            const groups = new Map();
            snapshot.docs.forEach((registration) => {
              const data = registration.data() || {};
              const registeredAt = registrationTime(data);
              const day = manilaDay(registeredAt);
              if (!day) return;
              const entry = groups.get(day) || { count: 0, latest: null, names: [] };
              entry.count += 1;
              const date = dateValue(registeredAt);
              if (date && (!entry.latest || date > entry.latest)) entry.latest = date;
              const name = registrationName(data);
              if (name) entry.names.push(name);
              groups.set(day, entry);
            });
            registrationItems = registrationItems.filter((item) => item.eventId !== eventId);
            groups.forEach((group, day) => {
              const stamp = group.latest?.toISOString();
              if (!stamp || !group.count) return;
              const title = eventTitle(event);
              const registeredName = group.count === 1
                ? (group.names[0] || "A student")
                : "";
              registrationItems.push({
                id: `registrations-${eventId}-${day}-${group.count}`,
                eventId,
                type: "registration",
                title: group.count === 1
                  ? `New registration for ${title}`
                  : `${group.count} students registered for ${title}`,
                message: group.count === 1
                  ? `${registeredName} registered for ${title}.`
                  : `${group.count} students registered for ${title}.`,
                createdAt: stamp,
                read: false,
                source: "derived",
                ...eventOrgMetadata(event),
              });
            });
            markSource(`registrations:${eventId}`, "success");
          },
          (error) => {
            if (stopped || auth.currentUser?.uid !== context?.uid) return;
            registrationItems = registrationItems.filter((item) => item.eventId !== eventId);
            if (!registrationErrorLogged) {
              registrationErrorLogged = true;
              log("registration reads failed; skipping registration notifications", error);
            }
            markSource(`registrations:${eventId}`, "error");
          },
        );
        regUnsubs.set(eventId, unsubscribe);
      } catch (error) {
        if (!registrationErrorLogged) {
          registrationErrorLogged = true;
          log("registration listener could not start", error);
        }
      }
    });
  };

  const startSources = async (user) => {
    unsubscribeSources();
    activeUid = user.uid;
    context = null;
    safetyTimer = setTimeout(() => {
      if (controllerState.loading) publish({ loading: false });
    }, 5000);
    publish({
      uid: user.uid,
      items: [],
      allItems: [],
      trash: [],
      unreadCount: 0,
      loading: true,
      error: "",
      sourceCounts: {},
    });
    const loaded = await loadIdentity(user);
    if (stopped || auth.currentUser?.uid !== user.uid) return;
    context = { uid: user.uid, ...loaded };
    if (!context.systemWide && !context.myOrgs.size) {
      log("no organization assignment resolved; showing personal and open-for-all items only");
    }
    firestoreItems = [];
    rtdbItems = [];
    eventItems = [];
    registrationItems = [];
    correctionItems = [];
    correctionRequests = [];
    events = [];
    cachedEvents = [];
    sourceState = {
      firestoreRecipientUid: "pending",
      firestoreUserId: "pending",
      events: "pending",
    };
    if (isRtdbConfigured && rtdb) sourceState.rtdb = "pending";
    registrationErrorLogged = false;
    publish({
      uid: user.uid,
      role: loaded.role,
      myOrgs: [...loaded.myOrgs],
      items: [],
      allItems: [],
      trash: [],
      unreadCount: 0,
      error: "",
      sourceCounts: {},
      correctionRequests,
      correctionRequestsLoading: false,
      correctionRequestsError: "",
    });

    subscribeCorrectionRequests(user);

    if (!db) {
      sourceState.firestoreRecipientUid = "error";
      sourceState.firestoreUserId = "error";
      sourceState.events = "error";
      markSource("firestoreRecipientUid", "error");
      markSource("firestoreUserId", "error");
      markSource("events", "error");
    } else {
      [
        ["firestoreRecipientUid", "recipientUid"],
        ["firestoreUserId", "userId"],
      ].forEach(([sourceName, field]) => {
        try {
          const sourceQuery = query(collection(db, "notifications"), where(field, "==", user.uid));
          const unsubscribe = onSnapshot(
            sourceQuery,
            (snapshot) => {
              if (stopped || auth.currentUser?.uid !== user.uid) return;
              const docs = snapshot.docs.map((snap) => {
                const data = snap.data() || {};
                return {
                  ...data,
                  id: snap.id,
                  eventId: data.proposalId || data.eventId || "",
                  proposalId: data.proposalId || data.eventId || "",
                  type: data.type || "default",
                  title: data.title || "Notification",
                  createdAt: data.createdAt ?? null,
                  read: data.read === true || data.isRead === true,
                  source: "firestore",
                  sources: ["firestore"],
                  recipientUid: data.recipientUid || (field === "recipientUid" ? user.uid : ""),
                  userId: data.userId || (field === "userId" ? user.uid : ""),
                  orgId: data.orgId || data.organizationId || data.organizationCode || data.organization || null,
                  organizationCodes: data.organizationCodes || [],
                  departmentCodes: data.departmentCodes || [],
                  openToAll: openToAll(data),
                };
              });
              firestoreItems = [
                ...firestoreItems.filter((item) => item._queryField !== field),
                ...docs.map((item) => ({ ...item, _queryField: field })),
              ];
              markSource(sourceName, "success");
            },
            (error) => {
              if (stopped || auth.currentUser?.uid !== user.uid) return;
              log(`${field} notifications query failed`, error);
              markSource(sourceName, "error");
            },
          );
          subscriptions.push(unsubscribe);
        } catch (error) {
          log(`${field} notifications subscription failed`, error);
          markSource(sourceName, "error");
        }
      });

      const eventSnapshots = new Map();
      const eventQueryStates = new Map();
      const eventQueries = [];
      if (loaded.systemWide) {
        eventQueries.push([
          "events:system",
          () => query(collection(db, "events"), limit(MAX_EVENTS)),
        ]);
      } else {
        const organizationFields = [
          "orgId", "organizationId", "organizationCode", "organizerOrg",
          "organizerOrganization", "organization", "organizationName", "orgName",
        ];
        organizationFields.forEach((field) => {
          chunks(loaded.orgQueryValues, 30).forEach((values, index) => {
            eventQueries.push([
              `events:${field}:${index}`,
              () => query(collection(db, "events"), where(field, "in", values), limit(MAX_EVENTS)),
            ]);
          });
        });
        ["organizationCodes", "orgIds", "targetOrganizations", "partnerOrganizations"].forEach((field) => {
          chunks(loaded.orgQueryValues, 30).forEach((values, index) => {
            eventQueries.push([
              `events:${field}:${index}`,
              () => query(collection(db, "events"), where(field, "array-contains-any", values), limit(MAX_EVENTS)),
            ]);
          });
        });
        eventQueries.push(
          ["events:openForAll", () => query(collection(db, "events"), where("openForAll", "==", true), limit(MAX_EVENTS))],
          ["events:allOrganizations", () => query(collection(db, "events"), where("allOrganizations", "==", true), limit(MAX_EVENTS))],
          ["events:targetAudience", () => query(collection(db, "events"), where("targetAudience", "in", ["Open to All", "open to all", "OPEN TO ALL"]), limit(MAX_EVENTS))],
          ["events:allOrganizationsText", () => query(collection(db, "events"), where("allOrganizations", "in", ["all", "All", "ALL", "Open to All"]), limit(MAX_EVENTS))],
          ["events:visibility", () => query(collection(db, "events"), where("visibility", "in", ["all", "All", "ALL", "Open to All", "open to all", "OPEN TO ALL"]), limit(MAX_EVENTS))],
          ["events:audience", () => query(collection(db, "events"), where("audience", "in", ["all", "All", "ALL", "Open to All", "open to all", "OPEN TO ALL", "public"]), limit(MAX_EVENTS))],
          ["events:targetYear", () => query(collection(db, "events"), where("targetYear", "in", ["Open to All", "open to all", "OPEN TO ALL"]), limit(MAX_EVENTS))],
        );
        if (loaded.approverStageKey) {
          eventQueries.push([
            `events:approval-stage:${loaded.approverStageKey}`,
            () => query(
              collection(db, "events"),
              where("approvalCurrentStage", "==", loaded.approverStageKey),
              limit(MAX_EVENTS),
            ),
          ]);
        }
      }

      const updateEvents = () => {
        const byId = new Map();
        eventSnapshots.forEach((documents) => documents.forEach((event) => byId.set(event.id, event)));
        events = [...byId.values()]
          .sort((a, b) =>
            (dateValue(b.updatedAt || b.createdAt)?.getTime() || 0) -
            (dateValue(a.updatedAt || a.createdAt)?.getTime() || 0),
          )
          .slice(0, MAX_EVENTS);
        const now = Date.now();
        const derived = events.flatMap((event) => {
          const normalized = eventOrgMetadata(event);
          return isRelevantForMe(normalized, context)
            ? deriveEventNotifications(event, context, now, events)
            : [];
        });
        cachedEvents = ["recovibeTeacherEvents", "recovibeOrganizerEvents"]
          .flatMap((key) => getLocalState(key))
          .map((event) => ({ ...event, id: String(event.eventId || event.id || "") }))
          .filter((event) => event.id && !events.some((source) => source.id === event.id));
        const cachedDerived = cachedEvents.flatMap((event) => {
          const normalized = eventOrgMetadata(event);
          return isRelevantForMe(normalized, context)
            ? deriveEventNotifications(event, context, now, [...events, ...cachedEvents])
            : [];
        });
        eventItems = [...derived, ...cachedDerived];
        addRegistrationListeners();
        markSource("events", "success");
      };

      const failEventQuery = (name, error) => {
        eventQueryStates.set(name, "error");
        log(`${name} query failed`, error);
        settleLoading();
        if ([...eventQueryStates.values()].every((status) => status === "error")) {
          markSource("events", "error");
        } else {
          refresh();
        }
      };

      eventQueries.forEach(([name, makeEventQuery]) => {
        eventQueryStates.set(name, "pending");
        try {
          const eventQuery = makeEventQuery();
          const unsubscribe = onSnapshot(
            eventQuery,
            (snapshot) => {
              if (stopped || auth.currentUser?.uid !== user.uid) return;
              try {
                eventSnapshots.set(
                  name,
                  snapshot.docs.map((snap) => ({ ...snap.data(), id: snap.id })),
                );
                eventQueryStates.set(name, "success");
                updateEvents();
              } catch (error) {
                failEventQuery(name, error);
              }
            },
            (error) => {
              if (stopped || auth.currentUser?.uid !== user.uid) return;
              failEventQuery(name, error);
            },
          );
          subscriptions.push(unsubscribe);
        } catch (error) {
          failEventQuery(name, error);
        }
      });
    }

    if (isRtdbConfigured && rtdb) {
      try {
        rtdbRef = ref(rtdb, `notifications/${user.uid}`);
        const unsubscribe = onValue(
          rtdbRef,
          (snapshot) => {
            if (stopped || auth.currentUser?.uid !== user.uid) return;
            const data = snapshot.val() || {};
            rtdbItems = Object.entries(data).map(([id, value]) => ({
              ...(value || {}),
              id,
              eventId: value?.eventId || "",
              type: value?.type || "default",
              title: value?.title || "Notification",
              message: value?.message || "",
              createdAt: value?.createdAt ?? null,
              read: value?.read === true,
              recipientUid: value?.recipientUid || user.uid,
              source: "rtdb",
              sources: ["rtdb"],
              orgId: value?.orgId || value?.organizationId || value?.organizationCode || null,
              openToAll: openToAll(value),
            }));
            markSource("rtdb", "success");
          },
          (error) => {
            if (stopped || auth.currentUser?.uid !== user.uid) return;
            log("RTDB notifications failed", error);
            markSource("rtdb", "error");
          },
        );
        subscriptions.push(unsubscribe);
      } catch (error) {
        log("RTDB notification subscription failed", error);
        markSource("rtdb", "error");
      }
    } else {
      log("RTDB source skipped: RTDB is not configured");
    }
  };

  const begin = () => {
    if (stopped) return;
    unsubscribeSources();
    authUnsubscribe?.();
    authUnsubscribe = null;
    (async () => {
      try {
        await authReady;
        await auth?.authStateReady?.();
        if (stopped) return;
        if (!auth) throw new Error("Firebase Auth is unavailable.");
        authUnsubscribe = onAuthStateChanged(auth, async (user) => {
          if (stopped) return;
          if (!user) {
            unsubscribeSources();
            activeUid = "";
            context = null;
            publish({
              uid: "",
              items: [],
              allItems: [],
              trash: [],
              unreadCount: 0,
              loading: false,
              error: "",
            });
            return;
          }
          if (user.uid === activeUid && context) return;
          try {
            await startSources(user);
          } catch (error) {
            log("notification initialization failed", error);
            publish({
              uid: user.uid,
              items: [],
              allItems: [],
              trash: [],
              unreadCount: 0,
              loading: false,
              error: "Notifications could not be loaded. Please retry.",
            });
          }
        });
      } catch (error) {
        log("auth startup failed", error);
        publish({ loading: false, error: "Notifications are unavailable." });
      }
    })();
  };

  const updateBadge = () => {
    document.querySelectorAll("[data-notification-count]").forEach((badge) => {
      const count = controllerState.error ? 0 : controllerState.unreadCount || 0;
      badge.textContent = count > 9 ? "9+" : String(count);
      badge.hidden = count === 0;
    });
  };

  const originalOnChange = onChange;
  onChange = (state) => {
    updateBadge();
    originalOnChange?.(state);
  };

  const handlePageHide = () => {
    unsubscribeSources();
    authUnsubscribe?.();
    authUnsubscribe = null;
    activeUid = "";
  };
  const handlePageShow = (event) => {
    if (event.persisted) begin();
  };
  const handleStorage = (event) => {
    if (!event.key || event.key.startsWith("recovibeAdmin")) refresh();
  };
  window.addEventListener("pagehide", handlePageHide);
  window.addEventListener("pageshow", handlePageShow);
  window.addEventListener("storage", handleStorage);

  const controller = {
    getState: () => controllerState,
    refresh,
    retry: () => {
      activeUid = "";
      begin();
    },
    retryCorrectionRequests: () => {
      if (context && auth.currentUser?.uid === context.uid) {
        subscribeCorrectionRequests({ uid: context.uid });
      }
    },
    async setReadState(item, readState) {
      if (!context || !item) return;
      const sources = item.sources || (item.source ? [item.source] : []);
      const errors = [];
      for (const source of sources) {
        try {
          if (source === "firestore" && db) {
            await updateDoc(doc(db, "notifications", item.id), { read: readState });
          } else if (source === "rtdb" && rtdb && context.uid) {
            await update(ref(rtdb, `notifications/${context.uid}/${item.id}`), { read: readState });
          }
        } catch (error) {
          errors.push(error);
        }
      }
      const key = `recovibeAdminNotifications:${context.uid}`;
      const local = getLocalState(key);
      const byId = new Map(local.map((entry) => [String(entry.id), entry]));
      byId.set(String(item.id), { ...byId.get(String(item.id)), ...item, read: readState });
      localStorage.setItem(key, JSON.stringify([...byId.values()]));
      refresh();
      if (errors.length) throw errors[0];
    },
    stop() {
      stopped = true;
      handlePageHide();
      window.removeEventListener("pagehide", handlePageHide);
      window.removeEventListener("pageshow", handlePageShow);
      window.removeEventListener("storage", handleStorage);
    },
  };
  begin();
  return controller;
}

export function startAdminNotificationBadge() {
  return subscribeAdminNotifications(() => {});
}
