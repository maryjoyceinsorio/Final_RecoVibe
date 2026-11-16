import assert from "node:assert/strict";
import test from "node:test";
import {
  buildApprovalUpdate,
  EVENT_APPROVAL_STAGES,
  getCurrentStageKey,
  getEventStage,
  getStages,
  isFullyApproved,
} from "../eventWorkflow.js";

const approvedHistory = (stages) => stages.map((stage) => ({
  stage,
  decision: "approved",
}));

test("HAP approval leaves OSAS as the current stage", () => {
  const event = { approvalHistory: approvedHistory(["org_adv", "sir_abelida"]) };
  const update = buildApprovalUpdate(event, {
    stageKey: "hap",
    decidedBy: "hap-user",
    now: 100,
  });
  const nextWorkflow = getEventStage({ ...event, ...update });

  assert.equal(update.approvalCurrentStep, 3);
  assert.equal(update.status, "pending");
  assert.equal(nextWorkflow.stages[3].state, "current");
  assert.equal(nextWorkflow.stages[3].approved, false);
  assert.equal(isFullyApproved({ ...event, ...update }), false);
  assert.equal(Object.hasOwn(update, "approvalStages"), false);
  assert.throws(
    () => buildApprovalUpdate({ ...event, ...update }, {
      stageKey: "hap",
      decidedBy: "hap-user",
    }),
    /Current stage: osas/,
  );
});

test("OSAS approval is the only approval that makes the event ready to publish", () => {
  const event = { approvalHistory: approvedHistory(["org_adv", "sir_abelida", "hap"]) };
  const update = buildApprovalUpdate(event, {
    stageKey: "osas",
    decidedBy: "osas-user",
    now: 200,
  });

  assert.equal(update.approvalCurrentStep, 3);
  assert.equal(update.status, "approved");
  assert.equal(isFullyApproved({ ...event, ...update }), true);
});

test("out-of-order approval is rejected", () => {
  const event = { approvalHistory: approvedHistory(["org_adv"]) };

  assert.throws(
    () => buildApprovalUpdate(event, { stageKey: "hap", decidedBy: "hap-user" }),
    /Current stage: sir_abelida/,
  );
});

test("legacy step 4 does not approve OSAS without its history entry", () => {
  const workflow = getEventStage({
    status: "approved",
    approvalStages: {
      org_adv: { status: "Approved" },
      sir_abelida: { status: "Approved" },
      hap: { status: "Approved" },
      osas: { status: "Approved" },
    },
    hap1Approved: true,
    hap2Approved: true,
    hap3Approved: true,
    approvalCurrentStep: 4,
    approvalHistory: approvedHistory(["org_adv", "sir_abelida", "hap"]),
  });

  assert.equal(workflow.stages[3].state, "current");
  assert.equal(workflow.stages[3].approved, false);
  assert.equal(workflow.currentStageIndex, 3);
  assert.equal(workflow.isFullyApproved, false);
});

test("standard proposals retain the complete adviser-first chain", () => {
  const event = {
    approvalSteps: EVENT_APPROVAL_STAGES.map((stage) => stage.key),
    approvalCurrentStage: "org_adv",
    approvalCurrentStep: 0,
    approvalHistory: [],
  };
  const update = buildApprovalUpdate(event, {
    stageKey: "org_adv",
    decidedBy: "adviser-user",
    now: 300,
  });

  assert.deepEqual(getStages(event), ["org_adv", "sir_abelida", "hap", "osas"]);
  assert.equal(getCurrentStageKey(event), "org_adv");
  assert.equal(update.approvalCurrentStage, "sir_abelida");
  assert.equal(update.approvalCurrentStep, 1);
  assert.equal(update.status, "pending");
});

test("CSC snapshot skips the adviser and advances through active stages only", () => {
  let event = {
    approvalSteps: ["sir_abelida", "hap", "osas"],
    approvalCurrentStage: "sir_abelida",
    approvalCurrentStep: 0,
    approvalHistory: [],
  };

  assert.deepEqual(getStages(event), ["sir_abelida", "hap", "osas"]);
  assert.equal(getCurrentStageKey(event), "sir_abelida");
  assert.equal(getEventStage(event).stages.some((stage) => stage.key === "org_adv"), false);
  assert.throws(
    () => buildApprovalUpdate(event, { stageKey: "org_adv", decidedBy: "adviser-user" }),
    /not active/,
  );

  const labUpdate = buildApprovalUpdate(event, {
    stageKey: "sir_abelida",
    decidedBy: "lab-user",
    now: 400,
  });
  assert.equal(labUpdate.approvalCurrentStage, "hap");
  assert.equal(labUpdate.approvalCurrentStep, 1);
  event = { ...event, ...labUpdate };

  const hapUpdate = buildApprovalUpdate(event, {
    stageKey: "hap",
    decidedBy: "hap-user",
    now: 500,
  });
  assert.equal(hapUpdate.approvalCurrentStage, "osas");
  assert.equal(hapUpdate.approvalCurrentStep, 2);
  event = { ...event, ...hapUpdate };

  const osasUpdate = buildApprovalUpdate(event, {
    stageKey: "osas",
    decidedBy: "osas-user",
    now: 600,
  });
  assert.equal(osasUpdate.approvalCurrentStage, null);
  assert.equal(osasUpdate.approvalCurrentStep, 2);
  assert.equal(osasUpdate.status, "approved");
  assert.equal(osasUpdate.approvalHistory.length, 3);
  assert.equal(isFullyApproved({ ...event, ...osasUpdate }), true);
});

test("legacy proposals without approvalSteps keep the full chain and infer from history", () => {
  const event = {
    approvalCurrentStep: 4,
    approvalHistory: approvedHistory(["org_adv", "sir_abelida", "hap"]),
  };

  assert.deepEqual(getStages(event), ["org_adv", "sir_abelida", "hap", "osas"]);
  assert.equal(getCurrentStageKey(event), "osas");
  assert.equal(getEventStage(event).currentStageKey, "osas");
});
