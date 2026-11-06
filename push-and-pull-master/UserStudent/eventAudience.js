function listValues(value) {
  const values = Array.isArray(value) ? value : [value];
  return values.flatMap((entry) => {
    if (typeof entry === "string") {
      return entry.split(",").map((item) => item.trim()).filter(Boolean);
    }
    if (entry && typeof entry === "object") {
      return [entry.code, entry.value, entry.name, entry.label]
        .filter((item) => typeof item === "string" && item.trim())
        .map((item) => item.trim());
    }
    return [];
  });
}

function normalizeOrganization(value) {
  return String(value || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
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

function eventOrganizationTargets(event, audienceKey) {
  const explicitTargets = [
    ...listValues(event.targetOrganizations),
    ...listValues(event.targetOrganization),
    ...listValues(event.audienceOrganizations),
  ];

  const creatorRole = String(event.creatorRole || event.createdByRole || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  const isOrganizationCreated =
    ["eventorganizer", "organizer", "eo"].includes(creatorRole) ||
    /organizational|organization/i.test(String(event.source || event.eventSource || ""));
  const shouldMatchOwnerOrganization =
    audienceKey === "organizationmembersonly" ||
    audienceKey === "mixedaudience" ||
    (!audienceKey && isOrganizationCreated);
  const ownerOrganizations = shouldMatchOwnerOrganization
    ? [
        event.organizationCode,
        event.organizerOrganization,
        event.orgCode,
        event.organization,
        event.organizationName,
        event.orgName,
        event.organizerName,
      ].filter((value) => typeof value === "string" && value.trim())
    : [];
  return [...explicitTargets, ...ownerOrganizations];
}

export function isEventVisibleToStudent(eventData, studentProfile) {
  const event = eventData?.raw || eventData || {};
  const audienceValue = String(event.targetAudience || "").trim().toLowerCase();
  const audienceKey = audienceValue.replace(/[^a-z0-9]/g, "");
  if (audienceKey.startsWith("opentoall")) return true;

  const targetDepartments = [
    ...listValues(event.targetDepartments),
    ...listValues(event.targetDepartment),
    ...listValues(event.departments),
  ].map(normalizeDepartment).filter(Boolean);
  const studentDepartments = [
    ...listValues(studentProfile?.departmentCode),
    ...listValues(studentProfile?.department),
    ...listValues(studentProfile?.course),
  ].map(normalizeDepartment).filter(Boolean);
  const matchesDepartment = targetDepartments.some((target) =>
    studentDepartments.includes(target),
  );

  const targetOrganizations = eventOrganizationTargets(event, audienceKey)
    .map(normalizeOrganization)
    .filter(Boolean);
  const studentOrganizations = [
    ...listValues(studentProfile?.organization),
    ...listValues(studentProfile?.courseOrganization),
    ...listValues(studentProfile?.organizationCode),
    ...listValues(studentProfile?.orgCode),
    ...listValues(studentProfile?.organizations),
    ...listValues(studentProfile?.courseOrganizations),
  ].map(normalizeOrganization).filter(Boolean);
  const matchesOrganization = targetOrganizations.some((target) =>
    studentOrganizations.includes(target),
  );

  if (audienceKey === "organizationmembersonly") {
    if (!targetOrganizations.length || !matchesOrganization) return false;
    return !targetDepartments.length || matchesDepartment;
  }
  if (audienceKey === "mixedaudience") {
    if (!targetDepartments.length && !targetOrganizations.length) return false;
    return matchesDepartment || matchesOrganization;
  }

  if (!targetDepartments.length && !targetOrganizations.length) return true;
  return (
    (!targetDepartments.length || matchesDepartment) &&
    (!targetOrganizations.length || matchesOrganization)
  );
}
