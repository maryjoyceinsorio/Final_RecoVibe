export const EVENT_APPROVAL_STAGES = Object.freeze([
  Object.freeze({ key: "org_adv", label: "Organization Adviser" }),
  Object.freeze({
    key: "sir_abelida",
    label: "Laboratory Head, Property Custodian, Administrative Officer",
  }),
  Object.freeze({
    key: "hap",
    label: "Head of Academic Programs, QAC Coordinator (HAP)",
  }),
  Object.freeze({ key: "osas", label: "OSAS" }),
]);

const normalizeStageKey = (value) =>
  String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");

const normalizeDecision = (value) =>
  String(value || "").trim().toLowerCase().replace(/[\s_-]+/g, " ");

const STAGE_KEY_ALIASES = new Map([
  ["adviser", "org_adv"],
  ["organizationadviser", "org_adv"],
  ["organizationadvisor", "org_adv"],
  ["labhead", "sir_abelida"],
  ["laboratoryhead", "sir_abelida"],
  ["propertycustodian", "sir_abelida"],
  ["administrativeofficer", "sir_abelida"],
  ["qaccoordinator", "hap"],
  ["headofacademicprograms", "hap"],
]);

function canonicalStageKey(value) {
  const normalized = normalizeStageKey(value);
  return EVENT_APPROVAL_STAGES.find((stage) =>
    normalizeStageKey(stage.key) === normalized ||
    normalizeStageKey(stage.label) === normalized,
  )?.key || STAGE_KEY_ALIASES.get(normalized) || null;
}

export function getStages(proposal) {
  if (!proposal || !Object.prototype.hasOwnProperty.call(proposal, "approvalSteps")) {
    return EVENT_APPROVAL_STAGES.map((stage) => stage.key);
  }
  if (!Array.isArray(proposal.approvalSteps)) return [];

  const seen = new Set();
  return proposal.approvalSteps
    .map(canonicalStageKey)
    .filter((stageKey) => {
      if (!stageKey || seen.has(stageKey)) return false;
      seen.add(stageKey);
      return true;
    });
}

export function getCurrentStageKey(proposal) {
  const stageKeys = getStages(proposal);
  if (!stageKeys.length) return null;

  const explicitStageKey = canonicalStageKey(proposal?.approvalCurrentStage);
  if (explicitStageKey && stageKeys.includes(explicitStageKey)) {
    return explicitStageKey;
  }

  const history = Array.isArray(proposal?.approvalHistory) ? proposal.approvalHistory : [];
  if (history.some((entry) => {
    const entryStage = [entry?.stage, entry?.stageKey, entry?.key]
      .find((value) => String(value || "").trim());
    return Boolean(canonicalStageKey(entryStage));
  })) {
    return getEventStage(proposal).currentStageKey;
  }

  const rawStep = proposal?.approvalCurrentStep ??
    proposal?.currentApprovalStep ??
    proposal?.currentStep ??
    proposal?.approval?.approvalCurrentStep ??
    proposal?.approval?.currentStep;
  const step = rawStep === "" || rawStep === null || rawStep === undefined
    ? NaN
    : Number(rawStep);
  return Number.isInteger(step) && step >= 0 && step < stageKeys.length
    ? stageKeys[step]
    : getEventStage(proposal).currentStageKey;
}

function getStageHistoryEntries(event, stageKey) {
  const normalizedKey = normalizeStageKey(stageKey);
  return (Array.isArray(event?.approvalHistory) ? event.approvalHistory : [])
    .filter((entry) => {
      if (!entry || typeof entry !== "object") return false;
      const entryStage = [entry.stage, entry.stageKey, entry.key]
        .find((value) => String(value || "").trim());
      return normalizeStageKey(entryStage) === normalizedKey;
    });
}

export function getEventStage(event) {
  const stages = getStages(event).map((stageKey, index) => {
    const stage = EVENT_APPROVAL_STAGES.find((candidate) => candidate.key === stageKey);
    const approvedEntries = getStageHistoryEntries(event, stage.key)
      .filter((entry) => normalizeDecision(entry.decision) === "approved");
    const approvedEntry = approvedEntries[approvedEntries.length - 1] || null;
    return {
      ...stage,
      index,
      step: index + 1,
      approved: Boolean(approvedEntry),
      approvedEntry,
    };
  });
  const currentStageIndex = stages.findIndex((stage) => !stage.approved);
  const firstIncompleteIndex = currentStageIndex < 0
    ? stages.length - 1
    : currentStageIndex;

  return {
    stages: stages.map((stage) => ({
      ...stage,
      state: stage.approved
        ? "approved"
        : stage.index === currentStageIndex
          ? "current"
          : "pending",
    })),
    currentStageIndex: firstIncompleteIndex,
    currentStageKey: currentStageIndex < 0 ? null : stages[currentStageIndex].key,
    isFullyApproved: stages.length > 0 && currentStageIndex < 0,
  };
}

export function isFullyApproved(event) {
  return getEventStage(event).isFullyApproved;
}

export function buildApprovalUpdate(event, {
  stageKey,
  decidedBy,
  decidedByName = "",
  now = Date.now(),
}) {
  const workflow = getEventStage(event);
  const activeStageKeys = getStages(event);
  const stage = EVENT_APPROVAL_STAGES.find(
    (candidate) => normalizeStageKey(candidate.key) === normalizeStageKey(stageKey),
  );
  if (!stage) throw new Error(`Unknown approval stage: ${stageKey}`);
  if (!activeStageKeys.length || !activeStageKeys.includes(stage.key)) {
    throw new Error(`Approval stage is not active for this proposal: ${stage.key}.`);
  }
  if (workflow.isFullyApproved) throw new Error("This proposal is already fully approved.");
  const currentStageKey = getCurrentStageKey(event) || workflow.currentStageKey;
  if (workflow.currentStageKey !== stage.key || currentStageKey !== stage.key) {
    throw new Error(`Approval must be completed in order. Current stage: ${currentStageKey || workflow.currentStageKey}.`);
  }

  const currentIndex = activeStageKeys.indexOf(stage.key);
  const nextStage = activeStageKeys[currentIndex + 1] || null;
  const nextIndex = nextStage ? currentIndex + 1 : currentIndex;
  const complete = nextStage === null;
  const history = Array.isArray(event?.approvalHistory)
    ? event.approvalHistory
    : [];

  return {
    approvalHistory: [
      ...history,
      {
        stage: stage.key,
        stageLabel: stage.label,
        decision: "approved",
        note: "",
        decidedBy,
        decidedByName,
        timestamp: now,
      },
    ],
    approvalCurrentStage: nextStage,
    approvalCurrentStep: nextIndex,
    approvalStatus: complete ? "approved" : "pending",
    status: complete ? "approved" : "pending",
    updatedAt: now,
  };
}
