export const STUDENT_EVENT_STATUSES = Object.freeze([
  "approved",
  "published",
  "completed",
  "rescheduled",
  "cancelled",
  "canceled",
]);

export function isStudentEventStatus(status) {
  const normalized = String(status || "")
    .trim()
    .toLowerCase()
    .replace(/[ _-]+/g, " ");
  return STUDENT_EVENT_STATUSES.includes(normalized);
}

export function toCleanList(value) {
  const cleanValues = [];
  const seenValues = new Set();
  const visitedObjects = new Set();
  const objectValueKeys = [
    "organizationCode",
    "organizationId",
    "orgCode",
    "orgId",
    "departmentCode",
    "departmentId",
    "code",
    "id",
    "value",
    "name",
    "label",
    "subtitle",
  ];

  function visit(entry) {
    if (typeof entry === "string") {
      entry.split(",").forEach((value) => {
        const cleaned = value.trim().toLowerCase();
        if (cleaned && !seenValues.has(cleaned)) {
          seenValues.add(cleaned);
          cleanValues.push(cleaned);
        }
      });
      return;
    }
    if (typeof entry === "number" && Number.isFinite(entry)) {
      visit(String(entry));
      return;
    }
    if (!entry || typeof entry !== "object" || visitedObjects.has(entry)) return;
    visitedObjects.add(entry);

    if (Array.isArray(entry) || entry instanceof Set) {
      entry.forEach(visit);
      return;
    }

    const values = objectValueKeys
      .filter((key) => Object.prototype.hasOwnProperty.call(entry, key))
      .map((key) => entry[key]);
    (values.length ? values : Object.values(entry)).forEach(visit);
  }

  visit(value);
  return cleanValues;
}

const audienceWarnings = new Set();
const isDevelopment = () => {
  const nodeEnvironment = globalThis.process?.env?.NODE_ENV;
  return nodeEnvironment
    ? nodeEnvironment !== "production"
    : import.meta.env?.DEV === true ||
      ["localhost", "127.0.0.1", "::1"].includes(globalThis.location?.hostname);
};

function normalizeOrganization(value) {
  const raw = String(value || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (raw === "PIEE" || raw === "PIIE" || raw.includes("INDUSTRIALENG")) return "PIIE";
  if (raw.includes("IBITS") || raw.includes("INFORMATIONTECH")) return "IBITS";
  if (raw === "ACES" || raw.includes("COMPUTERENG")) return "ACES";
  if (raw === "SMS" || raw.includes("MANAGEMENT")) return "SMS";
  if (raw === "HRSS" || raw.includes("HUMANRESOURCE")) return "HRSS";
  if (raw === "YES" || raw.includes("YOUNGEDUC")) return "YES";
  return raw;
}

function normalizeDepartment(value) {
  const raw = String(value || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (raw === "BSIT" || raw.includes("INFORMATIONTECH")) return "BSIT";
  if (raw === "BSCPE" || raw.includes("COMPUTERENG")) return "BSCPE";
  if (raw === "BSIE" || raw === "PIIE" || raw.includes("INDUSTRIALENG")) return "BSIE";
  if (raw === "BSBAHRM" || raw === "BSBSHRM" || raw.includes("HUMANRESOURCE")) return "BSBAHRM";
  if (raw === "BSBA" || raw === "SMS" || raw === "YES" || raw.includes("BUSINESSADMINISTRATION")) return "BSBA";
  if (raw === "BSHM" || raw.includes("HOSPITALITY")) return "BSHM";
  if (raw === "BSOA" || raw.includes("OFFICEADMINISTRATION")) return "BSOA";
  if (raw.includes("PSYCHOLOGY")) return "BSPSYCHOLOGY";
  if (raw.includes("SECONDARY")) return "BSEDSECONDARY";
  if (raw.includes("ELEMENTARY")) return "BSEDELEMENTARY";
  if (raw.includes("SOCIALSCIENCE")) return "BSEDSOCIALSCIENCE";
  return raw;
}

function explicitEventOrganizationTargets(event) {
  return toCleanList([
    event.targetOrganizations,
    event.target_organizations,
    event.targetOrg,
    event.target_org,
    event.targetOrgCode,
    event.target_org_code,
    event.targetOrganizationCodes,
    event.target_organization_codes,
    event.targetOrganizationNames,
    event.target_organization_names,
    event.targetOrgs,
    event.target_orgs,
    event.studentOrgs,
    event.student_orgs,
    event.TargetOrgs,
    event.targetOrganization,
    event.target_organization,
    event.audienceOrganizations,
    event.audience_organizations,
    event.coOrganizerOrganizations,
    event.coOrganizerOrgIds,
    event.coOrganizerOrganization,
    event.collaboratorOrganizations,
    event.collaboratorOrgIds,
    event.collaboratorOrganization,
    event.collaborationOrganizations,
    event.collaborationOrgIds,
    event.collaborationOrganization,
    event.collaboratingOrganizations,
    event.collaboratingOrganization,
    event.coOrganizer,
    event.collaborator,
    event.coOrganizers,
    event.collaborators,
  ]);
}

export function isEventVisibleToStudent(eventData, studentProfile) {
  let eventIdForError = "unknown";
  try {
    const event = eventData?.raw || eventData || {};
    const eventId = String(event.id || event.eventId || event.eventName || event.title || "");
    eventIdForError = eventId || "unknown";
    const audienceValue = String(
      event.targetAudience ||
      event.target_audience ||
      event.audienceType ||
      event.audience_type ||
      event.audience ||
      "",
    ).trim().toLowerCase();
    const audienceKey = audienceValue.replace(/[^a-z0-9]/g, "");
    const audienceType = audienceKey.includes("mixed")
      ? "mixed"
      : audienceKey.includes("organizationmembers")
        ? "organization"
        : audienceKey === "all" ||
            audienceKey.startsWith("openforall") ||
            audienceKey.startsWith("opentoall") ||
            audienceKey.startsWith("pupstudentsonly")
          ? "all"
          : "targeted";
    const logKey = eventId || JSON.stringify([audienceKey, event.name || ""]);
    const targetOrganizations = new Set(
      toCleanList(explicitEventOrganizationTargets(event))
        .map(normalizeOrganization)
        .map((value) => value.toLowerCase())
        .filter(Boolean),
    );
    const targetDepartments = new Set(
      toCleanList([
        event.targetDepartments,
        event.targetDepartment,
        event.target_departments,
        event.target_department,
        event.departments,
      ])
        .map(normalizeDepartment)
        .map((value) => value.toLowerCase())
        .filter(Boolean),
    );
    const studentOrganizations = new Set(
      toCleanList([
        studentProfile?.organization,
        studentProfile?.courseOrg,
        studentProfile?.courseOrganization,
        studentProfile?.StudentOrgs,
        studentProfile?.studentOrgs,
        studentProfile?.course,
        studentProfile?.organizationCode,
        studentProfile?.organizationId,
        studentProfile?.organizationName,
        studentProfile?.organizerOrganization,
        studentProfile?.orgCode,
        studentProfile?.orgId,
        studentProfile?.orgName,
        studentProfile?.organizations,
        studentProfile?.courseOrganizations,
      ])
        .map(normalizeOrganization)
        .map((value) => value.toLowerCase())
        .filter(Boolean),
    );
    const studentDepartments = new Set(
      toCleanList([
        studentProfile?.departments,
        studentProfile?.departmentCodes,
        studentProfile?.department,
        studentProfile?.departmentCode,
        studentProfile?.course,
        studentProfile?.program,
      ])
        .map(normalizeDepartment)
        .map((value) => value.toLowerCase())
        .filter(Boolean),
    );

    for (const organization of studentOrganizations) {
      const derivedDepartment = {
        ibits: "bsit",
        aces: "bscpe",
        piie: "bsie",
        hrss: "bsbahrm",
        sms: "bsba",
        yes: "bsba",
      }[organization];
      if (derivedDepartment) studentDepartments.add(derivedDepartment);
    }

    if (audienceType === "all") return true;

    const hasTargets = targetOrganizations.size > 0 || targetDepartments.size > 0;
    if (audienceType === "mixed" && !hasTargets) {
      if (isDevelopment() && !audienceWarnings.has(logKey)) {
        audienceWarnings.add(logKey);
        console.warn(
          `[Audience Filter] Mixed-audience event "${event.eventName || event.title || eventId}" has no organization or department targets; treating as open to all students.`,
        );
      }
      return true;
    }

    const isVisible =
      [...targetOrganizations].some((target) => studentOrganizations.has(target)) ||
      [...targetDepartments].some((target) => studentDepartments.has(target));
    return isVisible;
  } catch (error) {
    if (!audienceWarnings.has(`error:${eventIdForError}`)) {
      audienceWarnings.add(`error:${eventIdForError}`);
      console.warn(
        `[Audience Filter] Skipping event "${eventIdForError}" because its audience or student profile data is invalid.`,
        error,
      );
    }
    return false;
  }
}
