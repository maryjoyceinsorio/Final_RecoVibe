function listValues(value) {
  const values = Array.isArray(value) ? value : [value];
  return values.flatMap((entry) => {
    if (typeof entry === "string") {
      return entry.split(",").map((item) => item.trim()).filter(Boolean);
    }
    if (entry && typeof entry === "object") {
      return [
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
        entry.subtitle,
      ]
        .filter((item) => typeof item === "string" && item.trim())
        .map((item) => item.trim());
    }
    return [];
  });
}

function normalizeOrganization(value) {
  const raw = String(value || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (raw === "PIEE" || raw === "PIIE" || raw.includes("INDUSTRIALENG")) return "PIIE";
  if (raw === "IBITS" || raw.includes("INFORMATIONTECH")) return "IBITS";
  if (raw === "ACES" || raw.includes("COMPUTERENG")) return "ACES";
  if (raw === "SMS" || raw.includes("MANAGEMENT")) return "SMS";
  if (raw === "HRSS" || raw.includes("HUMANRESOURCE")) return "HRSS";
  if (raw === "YES" || raw.includes("YOUNGEDUC")) return "YES";
  return raw;
}

function normalizeDepartment(value) {
  const label = String(value || "").trim().toLowerCase();
  const normalized = label.replace(/[^a-z0-9]/g, "");
  if (
    normalized === "bsit" ||
    label.includes("information technology")
  ) return "bsit";
  if (
    normalized === "bscpe" ||
    label.includes("computer engineering")
  ) return "bscpe";
  if (
    normalized === "bsie" ||
    label.includes("industrial education")
  ) return "bsie";
  if (
    normalized === "bsbahrm" ||
    label.includes("human resource management") ||
    (label.includes("hrm") && !label.includes("hospitality"))
  ) return "bsbahrm";
  if (label.includes("elementary") || normalized.includes("bselementary") || normalized.includes("bsedelement")) {
    return "bselementaryeducation";
  }
  if (label.includes("secondary") || normalized === "bssecondary") return "bssecondary";
  if (label.includes("psychology") || normalized === "bspsychology") return "bspsychology";
  return normalized;
}

function eventOrganizationTargets(event) {
  const explicitTargets = [
    ...listValues(event.targetOrganizations),
    ...listValues(event.targetOrganization),
    ...listValues(event.audienceOrganizations),
    ...listValues(event.coOrganizerOrganizations),
    ...listValues(event.coOrganizerOrgIds),
    ...listValues(event.coOrganizerOrganization),
    ...listValues(event.collaboratorOrganizations),
    ...listValues(event.collaboratorOrgIds),
    ...listValues(event.collaboratorOrganization),
    ...listValues(event.collaborationOrganizations),
    ...listValues(event.collaborationOrgIds),
    ...listValues(event.collaborationOrganization),
    ...listValues(event.collaboratingOrganizations),
    ...listValues(event.collaboratingOrganization),
    ...listValues(event.coOrganizer),
    ...listValues(event.collaborator),
    ...listValues(event.coOrganizers),
    ...listValues(event.collaborators),
  ];

  const ownerOrganizations = [
    event.organizationCode,
    event.organizationId,
    event.organizerOrganization,
    event.orgCode,
    event.orgId,
    event.organization,
    event.organizationName,
    event.orgName,
  ].filter((value) => typeof value === "string" && value.trim());
  return [...explicitTargets, ...ownerOrganizations];
}

export function isEventVisibleToStudent(eventData, studentProfile) {
  const event = eventData?.raw || eventData || {};
  const audienceValue = String(event.targetAudience || "").trim().toLowerCase();
  const audienceKey = audienceValue.replace(/[^a-z0-9]/g, "");
  if (audienceKey.startsWith("opentoall") || audienceKey.startsWith("openforall")) return true;

  const targetDepartments = [
    ...listValues(event.targetDepartments),
    ...listValues(event.targetDepartment),
    ...listValues(event.targetDepartmentIds),
    ...listValues(event.departments),
    ...listValues(event.departmentCode),
    ...listValues(event.departmentId),
    ...listValues(event.department),
  ].map(normalizeDepartment).filter(Boolean);
  const studentDepartments = [
    ...listValues(studentProfile?.departmentCode),
    ...listValues(studentProfile?.departmentId),
    ...listValues(studentProfile?.department),
    ...listValues(studentProfile?.departments),
    ...listValues(studentProfile?.departmentIds),
    ...listValues(studentProfile?.course),
  ].map(normalizeDepartment).filter(Boolean);
  const matchesDepartment = targetDepartments.some((target) =>
    studentDepartments.includes(target),
  );

  const targetOrganizations = eventOrganizationTargets(event)
    .map(normalizeOrganization)
    .filter(Boolean);
  const studentOrganizations = [
    ...listValues(studentProfile?.organization),
    ...listValues(studentProfile?.courseOrganization),
    ...listValues(studentProfile?.organizationCode),
    ...listValues(studentProfile?.organizationId),
    ...listValues(studentProfile?.organizationName),
    ...listValues(studentProfile?.organizerOrganization),
    ...listValues(studentProfile?.orgCode),
    ...listValues(studentProfile?.orgId),
    ...listValues(studentProfile?.orgName),
    ...listValues(studentProfile?.organizations),
    ...listValues(studentProfile?.courseOrganizations),
  ].map(normalizeOrganization).filter(Boolean);
  const matchesOrganization = targetOrganizations.some((target) =>
    studentOrganizations.includes(target),
  );

  const isVisible = matchesDepartment || matchesOrganization;

  console.log(
    `[Audience Filter] Event: "${event.eventName || event.title || event.name || event.id}" | Audience: "${event.targetAudience || 'Default'}" | TargetOrgs: [${targetOrganizations.join(', ')}] | StudentOrgs: [${studentOrganizations.join(', ')}] => Visible: ${isVisible}`
  );

  return isVisible;
}
