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
  const raw = String(value || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  // Standardize common student organization abbreviations and aliases
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

  let isVisible = true;
  if (audienceKey === "organizationmembersonly") {
    if (!targetOrganizations.length || !matchesOrganization) isVisible = false;
    else isVisible = !targetDepartments.length || matchesDepartment;
  } else if (audienceKey === "mixedaudience") {
    if (!targetDepartments.length && !targetOrganizations.length) isVisible = false;
    else isVisible = matchesDepartment || matchesOrganization;
  } else {
    if (!targetDepartments.length && !targetOrganizations.length) isVisible = true;
    else {
      isVisible =
        (!targetDepartments.length || matchesDepartment) &&
        (!targetOrganizations.length || matchesOrganization);
    }
  }

  console.log(
    `[Audience Filter] Event: "${event.eventName || event.title || event.name || event.id}" | Audience: "${event.targetAudience || 'Default'}" | TargetOrgs: [${targetOrganizations.join(', ')}] | StudentOrgs: [${studentOrganizations.join(', ')}] => Visible: ${isVisible}`
  );

  return isVisible;
}
