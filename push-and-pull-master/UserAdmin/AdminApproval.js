import { auth, db, rtdb, functions, isFirebaseConfigured } from "../UserStudent/firebaseConfig.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { ref, onValue, off, get } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js";
import {
  collection,
  doc,
  getDoc,
  onSnapshot,
  query,
  runTransaction,
  where,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

(() => {
  "use strict";

  const APPROVER_DIRECTORY_DEFAULTS = {
    org_adv: { key: "org_adv", label: "Organization Adviser", stage: 1, defaultOn: true, required: true },
    sir_abelida: { key: "sir_abelida", label: "Laboratory Head, Property Custodian, Administrative Officer", stage: 2, defaultOn: true, required: true },
    hap: { key: "hap", label: "Head of Academic Programs, QAC Coordinator (HAP)", stage: 3, defaultOn: true, required: true },
    osas: { key: "osas", label: "OSAS", stage: 4, defaultOn: true, required: true },
  };
  const APPROVAL_ACCOUNT_STAGES = [
    { key: "org_adv", label: "Organization Adviser", step: 1, required: true, aliases: ["org_adv", "org adviser", "organization adviser", "organization adviser review", "adviser"] },
    { key: "sir_abelida", label: "Laboratory Head, Property Custodian, Administrative Officer", step: 2, required: true, aliases: ["sir_abelida", "abelida", "abelidas", "laboratory head", "property custodian", "administrative officer", "lab head", "lab_head"] },
    { key: "hap", label: "Head of Academic Programs, QAC Coordinator (HAP)", step: 3, required: true, aliases: ["hap", "head of academic programs", "qac coordinator", "head of academic programs qac coordinator"] },
    { key: "osas", label: "OSAS", step: 4, required: true, aliases: ["osas", "osas review"] },
  ];
  const DEFAULT_FIRESTORE_APPROVAL_STAGES = [
    { id: "org_adv", key: "org_adv", step: 1, name: "Organization Adviser", reviewer: "Organization Adviser", required: true },
    { id: "sir_abelida", key: "sir_abelida", step: 2, name: "Laboratory Head, Property Custodian, Administrative Officer", reviewer: "Laboratory Head, Property Custodian, Administrative Officer", required: true },
    { id: "hap", key: "hap", step: 3, name: "Head of Academic Programs, QAC Coordinator (HAP)", reviewer: "Head of Academic Programs, QAC Coordinator (HAP)", required: true },
    { id: "osas", key: "osas", step: 4, name: "OSAS", reviewer: "OSAS", required: true },
  ];
  const normalizeApprovalKey = (value) => String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  const normalizeOrganizationCode = (value) => String(value || "").trim().replace(/\s+/g, " ").toUpperCase();
  const isOrganizationAdviserStage = (value) => {
    const values = value && typeof value === "object"
      ? [value.roleKey, value.key, value.id, value.name, value.label, value.reviewer]
      : [value];
    const adviserKeys = new Set(["orgadv", "orgadviser", "orgadvisor", "organizationadviser", "organizationadvisor", "organizationadviserreview"]);
    return values.some((item) => adviserKeys.has(normalizeApprovalKey(item)));
  };
  const getProfileOrganizationCode = (profile) => normalizeOrganizationCode(
    profile?.organizationCode ||
    profile?.orgCode ||
    profile?.organization ||
    profile?.organizationName ||
    profile?.orgName ||
    "",
  );
  const getCurrentAdminOrganizationCode = () => getProfileOrganizationCode(currentAdminProfile);
  const isOrgAdviserReviewer = (stage) => isOrganizationAdviserStage(stage);
  const getApprovalStageFromAccountNumber = (profile) => {
    const accountNumbers = [
      profile?.accountNumber,
      profile?.accountNo,
      profile?.account_number,
      profile?.account_no,
    ].map(normalizeApprovalKey).filter(Boolean);
    if (accountNumbers.some((accountNumber) => accountNumber.includes("administrative"))) {
      return APPROVAL_ACCOUNT_STAGES.find((stage) => stage.key === "sir_abelida");
    }
    if (accountNumbers.some((accountNumber) =>
      accountNumber.includes("orgadviser") || accountNumber.includes("orgadvisor"),
    )) {
      return APPROVAL_ACCOUNT_STAGES.find((stage) => stage.key === "org_adv");
    }
    if (accountNumbers.some((accountNumber) => accountNumber.includes("hap"))) {
      return APPROVAL_ACCOUNT_STAGES.find((stage) => stage.key === "hap");
    }
    if (accountNumbers.some((accountNumber) => accountNumber.includes("osas"))) {
      return APPROVAL_ACCOUNT_STAGES.find((stage) => stage.key === "osas");
    }
    return null;
  };
  const getApprovalStageForProfile = (profile) => {
    const accountStage = getApprovalStageFromAccountNumber(profile);
    if (accountStage) return accountStage;

    const identityValues = [
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
      profile?.role,
      profile?.userRole,
    ].map(normalizeApprovalKey).filter(Boolean);
    const matches = APPROVAL_ACCOUNT_STAGES.filter((stage) =>
      [stage.key, ...stage.aliases].some((alias) => identityValues.includes(normalizeApprovalKey(alias))),
    );
    return matches.length === 1 ? matches[0] : null;
  };
  const getEventOrganizationCode = (event) => normalizeOrganizationCode(
    event?.organizationCode ||
    event?.organizerOrganization ||
    event?.organization ||
    event?.organizationName ||
    "",
  );
  const resolveApprovalStage = (value) => {
    const normalized = normalizeApprovalKey(value);
    return APPROVAL_ACCOUNT_STAGES.find((stage) =>
      [stage.key, stage.label, ...stage.aliases]
        .some((candidate) => normalizeApprovalKey(candidate) === normalized),
    ) || null;
  };

  const root = document.getElementById("approvalRoot");
  const pageHeadingTitle = document.getElementById("pageHeadingTitle");
  const toastElement = document.querySelector(".admin-toast");
  if (!document.querySelector("[data-admin-event-details-styles]")) {
    const detailsStyles = document.createElement("link");
    detailsStyles.rel = "stylesheet";
    detailsStyles.href = new URL("../EventDetailsModal.css", import.meta.url).href;
    detailsStyles.dataset.adminEventDetailsStyles = "true";
    document.head.appendChild(detailsStyles);
  }

  // Application State
  let currentAdminUid = null;
  let currentAdminProfile = null;
  let verifiedAdminProfileUid = null;
  let currentAdminKey = null; // e.g. "org_adv"
  let approverDirectory = { ...APPROVER_DIRECTORY_DEFAULTS };

  let queueItems = [];
  let firestorePendingEvents = [];
  let firestorePendingEventsError = "";
  let firestorePendingEventsLoaded = false;
  let recentDecisions = [];
  let activeReviewEventId = null;
  let activeEvent = null;
  let activeApproval = null;
  let activeFirestoreReview = false;
  let firestoreProposalLoadError = "";

  let queueListenerRef = null;
  let decisionsListenerRef = null;
  let activeEventRef = null;
  let activeApprovalRef = null;
  let firestorePendingEventsUnsubscribe = null;
  let activeFirestoreEventUnsubscribe = null;
  let toastTimer = null;
  let firestorePendingEventsTimeout = null;
  let firestoreProposalLoadTimeout = null;

  // Initialize Page Header Today's Date
  const todayElement = document.querySelector("[data-today]");
  if (todayElement) {
    todayElement.textContent = new Date().toLocaleDateString("en-US", {
      timeZone: "Asia/Manila",
      month: "long",
      day: "numeric",
      year: "numeric",
    });
  }

  // Logout Handler
  const logoutBtn = document.querySelector(".admin-logout");
  if (logoutBtn) {
    logoutBtn.addEventListener("click", async (e) => {
      e.preventDefault();
      try {
        if (auth) await signOut(auth);
      } catch (error) {
        console.error("Could not sign out administrator:", error);
      }
      localStorage.removeItem("recovibeAdminId");
      location.href = "AdminLogin.html";
    });
  }

  function esc(value) {
    return String(value ?? "").replace(
      /[&<>"']/g,
      (ch) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[ch]
    );
  }

  function getAccountStage() {
    const profileStage = getApprovalStageForProfile(currentAdminProfile);
    if (profileStage) return profileStage;

    const directoryEntry = approverDirectory[currentAdminKey];
    const knownStage = resolveApprovalStage(currentAdminKey || directoryEntry?.key);
    if (knownStage) return knownStage;
    if (!directoryEntry || !currentAdminKey) return null;
    return {
      ...directoryEntry,
      key: currentAdminKey,
      label: String(directoryEntry.label || directoryEntry.name || currentAdminKey),
      roleKey: currentAdminKey === "org_adv" ? "org_adv" : "",
    };
  }

  function getStageLabel(key) {
    return resolveApprovalStage(key)?.label ||
      approverDirectory[key]?.label || key || "Approval role not assigned";
  }

  function getProfileName(profile, fallback = "") {
    if (!profile || typeof profile !== "object") return fallback;
    const nameParts = [profile.firstName, profile.middleName, profile.lastName]
      .map((part) => String(part || "").trim())
      .filter(Boolean);
    return String(profile.fullName || profile.name || profile.displayName || nameParts.join(" ") || fallback).trim();
  }

  async function loadAdminProfileSafely(user, cachedProfile) {
    if (!user || !db) return cachedProfile;
    const [adminProfileResult, userProfileResult] = await Promise.allSettled([
      getDoc(doc(db, "adminUser", user.uid)),
      getDoc(doc(db, "users", user.uid)),
    ]);
    const adminProfile = adminProfileResult.status === "fulfilled" && adminProfileResult.value.exists()
      ? adminProfileResult.value.data()
      : null;
    const userProfile = userProfileResult.status === "fulfilled" && userProfileResult.value.exists()
      ? userProfileResult.value.data()
      : null;
    const profile = adminProfile || userProfile
      ? { ...(userProfile || {}), ...(adminProfile || {}) }
      : null;
    if (!profile) {
      const readError = [adminProfileResult, userProfileResult]
        .find((result) => result.status === "rejected")?.reason;
      if (readError) throw readError;
      return cachedProfile;
    }
    verifiedAdminProfileUid = user.uid;
    return {
      ...cachedProfile,
      ...profile,
      uid: user.uid,
      email: user.email || cachedProfile.email || "",
    };
  }

  function getFirestoreStageEntries(event) {
    const stageData = event?.approvalStages;
    return Array.isArray(stageData)
      ? stageData.map((stage, index) => [String(stage?.id || index), stage && typeof stage === "object" ? stage : {}])
      : stageData && typeof stageData === "object"
        ? Object.entries(stageData).map(([id, stage]) => [id, stage && typeof stage === "object" ? stage : {}])
        : [];
  }

  function findFirestoreStageSource(entries, stage) {
    return entries.find(([id, source]) => {
      const values = [id, source.key, source.roleKey, source.id, source.name, source.label, source.reviewer];
      return values.some((value) => {
        const resolvedStage = resolveApprovalStage(value);
        return resolvedStage?.key === stage.key;
      });
    })?.[1];
  }

  function getConfiguredFirestoreStages(event) {
    const entries = getFirestoreStageEntries(event);
    return APPROVAL_ACCOUNT_STAGES.map((stage, index) => {
      const source = findFirestoreStageSource(entries, stage) || DEFAULT_FIRESTORE_APPROVAL_STAGES[index];
      return {
        key: stage.key,
        label: stage.key === "hap"
          ? "Head of Academic Programs, QAC Coordinator (HAP)"
          : stage.label,
        name: stage.key === "hap"
          ? "Head of Academic Programs, QAC Coordinator (HAP)"
          : stage.label,
        reviewer: source.reviewer || stage.label,
        step: stage.step,
        required: true,
        source,
      };
    });
  }

  function getFirestoreCurrentStageKey(event) {
    if (!event || typeof event !== "object") return null;
    if (["approved", "revision", "rejected", "cancelled"].includes(String(event.approvalStatus || event.status || "").trim().toLowerCase().replace(/[\s_-]+/g, " "))) return null;

    const orderedStages = getConfiguredFirestoreStages(event);
    const explicitStep = Number(event.approvalCurrentStep);
    if (Number.isInteger(explicitStep) && explicitStep >= 1) {
      const currentStage = orderedStages.find(({ step }) => step === explicitStep);
      if (currentStage) return currentStage.key;
    }

    const currentStage = orderedStages.find(({ source }) => {
      const status = String(source.status || "").trim().toLowerCase().replace(/[\s_-]+/g, " ");
      return !["ok", "approved", "complete", "completed"].includes(status);
    });
    return currentStage?.key || null;
  }

  function getFirestoreApprovalStages(event, currentStep) {
    const stages = {};
    getConfiguredFirestoreStages(event).forEach((stage) => {
      const rawStatus = String(stage.source?.status || "").trim().toLowerCase().replace(/[\s_-]+/g, " ");
      const status = ["ok", "approved", "complete", "completed"].includes(rawStatus)
        ? "ok"
        : ["review", "reviewing", "in review", "in progress"].includes(rawStatus) ||
            (stage.step === currentStep && ["", "pending", "waiting", "wait"].includes(rawStatus))
          ? "review"
          : ["rev", "revision", "changes requested"].includes(rawStatus)
            ? "rev"
            : ["rej", "rejected"].includes(rawStatus)
              ? "rej"
              : ["wait", "waiting", "pending", ""].includes(rawStatus)
                ? "wait"
                : "wait";
      stages[stage.key] = {
        ...stage.source,
        key: stage.key,
        label: stage.label,
        step: stage.step,
        status,
        note: stage.source?.note || "",
        updatedAt: stage.source?.updatedAt || stage.source?.approvedAt || null,
        approvedByName: stage.source?.approvedByName || stage.source?.decidedBy || stage.source?.rejectedByName || "",
      };
    });
    return stages;
  }

  function getCurrentFirestoreStage(event) {
    const stageKey = getFirestoreCurrentStageKey(event);
    const stage = getConfiguredFirestoreStages(event).find((candidate) => candidate.key === stageKey);
    return stage && isCurrentUserAssignedToStage(event, stage) ? stage.key : null;
  }

  function getStageAssignment(event, stage) {
    const configuredStage = stage?.source
      ? stage
      : getConfiguredFirestoreStages(event).find((candidate) => candidate.key === stage?.key);
    const source = configuredStage?.source || stage || {};
    const keyAssignments = {
      org_adv: ["orgAdviserUid", "organizationAdviserUid", "adviserUid"],
      sir_abelida: ["labHeadUid", "laboratoryHeadUid", "propertyCustodianUid", "sirAbelidaUid"],
      hap: ["hapUid", "qacCoordinatorUid"],
      osas: ["osasUid"],
    };
    const keyEmails = {
      org_adv: ["orgAdviserEmail", "organizationAdviserEmail", "adviserEmail"],
      sir_abelida: ["labHeadEmail", "laboratoryHeadEmail", "propertyCustodianEmail", "sirAbelidaEmail"],
      hap: ["hapEmail", "qacCoordinatorEmail"],
      osas: ["osasEmail"],
    };
    const assignments = event?.approverAssignments?.[stage?.key];
    const directAssignment = assignments && typeof assignments === "object" ? assignments : {};
    const uid = String(
      source.reviewerUid ||
      source.assignedReviewerUid ||
      source.approverUid ||
      source.assignedUid ||
      source.uid ||
      directAssignment.reviewerUid ||
      directAssignment.approverUid ||
      directAssignment.uid ||
      keyAssignments[stage?.key]?.map((field) => event?.[field]).find(Boolean) ||
      event?.[`${stage?.key}ReviewerUid`] ||
      event?.[`${stage?.key}ApproverUid`] ||
      approverDirectory[stage?.key]?.uid ||
      "",
    ).trim();
    const email = String(
      source.reviewerEmail ||
      source.assignedReviewerEmail ||
      source.approverEmail ||
      source.assignedEmail ||
      directAssignment.reviewerEmail ||
      directAssignment.approverEmail ||
      directAssignment.email ||
      keyEmails[stage?.key]?.map((field) => event?.[field]).find(Boolean) ||
      event?.[`${stage?.key}ReviewerEmail`] ||
      event?.[`${stage?.key}ApproverEmail`] ||
      approverDirectory[stage?.key]?.email ||
      approverDirectory[stage?.key]?.reviewerEmail ||
      "",
    ).trim().toLowerCase();
    return { uid, email };
  }

  function isCurrentUserAssignedToStage(event, stage) {
    const user = auth?.currentUser;
    if (!user || !stage) return false;
    const assignment = getStageAssignment(event, stage);
    if (assignment.uid) return assignment.uid === user.uid;
    if (assignment.email && user.email) {
      return assignment.email === user.email.trim().toLowerCase();
    }
    return verifiedAdminProfileUid === user.uid &&
      getApprovalStageForProfile(currentAdminProfile)?.key === stage.key;
  }

  async function applyFirestoreDecisionLocally(eventId, decision, note, stage, user) {
    const eventRef = doc(db, "events", eventId);
    return runTransaction(db, async (transaction) => {
      const snapshot = await transaction.get(eventRef);
      if (!snapshot.exists()) throw new Error("This proposal no longer exists.");

      const event = snapshot.data() || {};
      const entries = getFirestoreStageEntries(event);
      const configuredEntries = entries.length
        ? entries
        : DEFAULT_FIRESTORE_APPROVAL_STAGES.map((defaultStage, index) => [
            defaultStage.id,
            {
              ...defaultStage,
              step: index + 1,
              status: index === 0 ? "Reviewing" : "Waiting",
            },
          ]);
      const stageSource = findFirestoreStageSource(configuredEntries, stage);
      if (!isCurrentUserAssignedToStage(event, stage)) {
        throw new Error("This proposal is assigned to a different reviewer account.");
      }
      const stageStatus = String(stageSource?.status || "").trim().toLowerCase().replace(/[\s_-]+/g, " ");
      const alreadyApplied = decision === "approve"
        ? ["ok", "approved", "complete", "completed"].includes(stageStatus) ||
          String(event.approvalStatus || event.status || "").toLowerCase() === "approved"
        : stageStatus === "rejected" ||
          String(event.approvalStatus || event.status || "").toLowerCase() === "rejected";
      const currentStageKey = getFirestoreCurrentStageKey(event);
      if (currentStageKey !== stage.key) {
        if (alreadyApplied) {
          return {
            complete: String(event.approvalStatus || event.status || "").toLowerCase() === "approved",
            alreadyProcessed: true,
          };
        }
        throw new Error("This proposal is no longer waiting at your approval stage. Refresh the queue and try again.");
      }

      const now = Date.now();
      const adminName = getProfileName(
        currentAdminProfile,
        user.displayName || user.email || "Administrator",
      );
      const stagePatch = decision === "approve"
        ? {
            status: "Approved",
            approvedAt: now,
            approvedBy: user.uid,
            approvedByName: adminName,
            note: "",
            updatedAt: now,
          }
        : {
            status: "Rejected",
            rejectedAt: now,
            rejectedBy: user.uid,
            rejectedByName: adminName,
            note,
            updatedAt: now,
          };
      const approvalStages = Array.isArray(event.approvalStages)
        ? [...event.approvalStages]
        : entries.length
          ? { ...(event.approvalStages || {}) }
          : Object.fromEntries(configuredEntries);

      if (Array.isArray(approvalStages)) {
        const stageIndex = approvalStages.findIndex((entry) => entry === stageSource);
        if (stageIndex >= 0) {
          approvalStages[stageIndex] = { ...approvalStages[stageIndex], ...stagePatch };
        } else {
          approvalStages.push({ id: stage.key, key: stage.key, name: stage.label, ...stagePatch });
        }
      } else {
        const stageEntry = configuredEntries.find(([, source]) => source === stageSource);
        const stageId = stageEntry?.[0] || stage.key;
        approvalStages[stageId] = { ...(stageSource || {}), ...stagePatch };
      }

      const history = Array.isArray(event.approvalHistory) ? [...event.approvalHistory] : [];
      history.push({
        stage: stage.key,
        stageLabel: stage.label,
        decision: decision === "approve" ? "Approved" : "Rejected",
        note: decision === "reject" ? note : "",
        decidedBy: user.uid,
        decidedByName: adminName,
        timestamp: now,
      });

      const updates = {
        approvalStages,
        approvalHistory: history,
        updatedAt: now,
      };
      if (decision === "reject") {
        updates.status = "rejected";
        updates.approvalStatus = "rejected";
      } else {
        const configuredStages = getConfiguredFirestoreStages({
          ...event,
          approvalStages,
        }).sort((a, b) => a.step - b.step);
        const stageIndex = configuredStages.findIndex((item) => item.key === stage.key);
        const nextStage = configuredStages[stageIndex + 1];
        if (nextStage) {
          const nextSource = findFirestoreStageSource(
            getFirestoreStageEntries({ approvalStages }),
            nextStage,
          );
          const nextStatus = String(nextSource?.status || "").trim().toLowerCase().replace(/[\s_-]+/g, " ");
          if (!["ok", "approved", "complete", "completed"].includes(nextStatus)) {
            const nextPatch = { status: "Reviewing", startedAt: now, updatedAt: now };
            if (Array.isArray(approvalStages)) {
              const nextIndex = approvalStages.findIndex((entry) => entry === nextSource);
              if (nextIndex >= 0) {
                approvalStages[nextIndex] = { ...approvalStages[nextIndex], ...nextPatch };
              } else {
                approvalStages.push({
                  id: nextStage.key,
                  key: nextStage.key,
                  name: nextStage.label,
                  step: nextStage.step,
                  ...nextPatch,
                });
              }
            } else {
              const nextEntry = getFirestoreStageEntries({ approvalStages })
                .find(([, source]) => source === nextSource);
              const nextId = nextEntry?.[0] || nextStage.key;
              approvalStages[nextId] = {
                ...(nextSource || {}),
                id: nextSource?.id || nextStage.key,
                key: nextSource?.key || nextStage.key,
                name: nextSource?.name || nextStage.label,
                step: nextSource?.step || nextStage.step,
                ...nextPatch,
              };
            }
          }
          updates.approvalCurrentStep = nextStage.step;
          updates.approvalStatus = "pending";
          updates.status = "pending";
        } else {
          updates.approvalCurrentStep = null;
          updates.approvalStatus = "approved";
          updates.status = "approved";
        }
      }

      transaction.update(eventRef, updates);
      return { complete: updates.approvalStatus === "approved", alreadyProcessed: false };
    });
  }

  function showToast(message) {
    if (!toastElement) return;
    toastElement.textContent = message;
    toastElement.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastElement.hidden = true;
    }, 4000);
  }

  // 1. Auth Guard (Must be admin)
  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      const localAdminId = localStorage.getItem("recovibeAdminId");
      if (!localAdminId && isFirebaseConfigured) {
        location.replace("AdminLogin.html");
        return;
      }
      currentAdminUid = localAdminId || "admin-demo-uid";
    } else {
      currentAdminUid = user.uid;
    }
    verifiedAdminProfileUid = null;

    let storedProfile = {};
    try {
      storedProfile = JSON.parse(localStorage.getItem("recovibeAdminProfile") || "{}");
    } catch (error) {
      console.warn("Could not read the cached administrator profile:", error);
    }
    if (user && storedProfile.uid && storedProfile.uid !== user.uid) storedProfile = {};
    currentAdminProfile = {
      ...storedProfile,
      ...(user ? { uid: user.uid, email: user.email || storedProfile.email || "" } : {}),
    };

    const profileRole = String(currentAdminProfile.role || currentAdminProfile.userRole || "")
      .trim()
      .toLowerCase()
      .replace(/[\s_-]+/g, "");
    if (
      user &&
      profileRole &&
      !["admin", "superadmin"].includes(profileRole) &&
      !getApprovalStageForProfile(currentAdminProfile)
    ) {
      alert("Access restricted to administrators.");
      location.replace("AdminLogin.html");
      return;
    }

    const assignedStage = getAccountStage();
    if (assignedStage && !getProfileName(currentAdminProfile)) {
      currentAdminProfile.name = assignedStage.name || assignedStage.label;
    }
    const adminName = getProfileName(
      currentAdminProfile,
      assignedStage?.name || assignedStage?.label || auth?.currentUser?.displayName || "Administrator",
    );
    const nameEl = document.querySelector("[data-name]");
    const avatarEl = document.querySelector("[data-avatar]");

    if (nameEl) nameEl.textContent = adminName.toUpperCase();
    if (avatarEl) {
      avatarEl.textContent = adminName
        .trim()
        .split(/\s+/)
        .slice(0, 2)
        .map((p) => p[0])
        .join("")
        .toUpperCase() || "AD";
    }

    try {
      await initAdminData();
    } catch (error) {
      showDashboardLoadError(error);
    }

    if (user && db) {
      loadAdminProfileSafely(user, storedProfile)
        .then((profile) => {
          currentAdminProfile = profile;
          if (getApprovalStageForProfile(profile)) {
            findOrAssignAdminKey();
            subscribeFirestorePendingEvents();
            if (activeReviewEventId) renderReviewScreen();
            else renderReviewQueue();
          }
        })
        .catch((error) => {
          console.warn("Could not load the signed-in administrator profile; using assigned event reviewer identity:", error);
        });
    }
  });

  function showDashboardLoadError(error) {
    console.error("Could not initialize the admin approval dashboard:", error);
    if (!root) return;
    root.innerHTML = `
      <div class="queue-empty-box" role="alert">
        <h3>Couldn't load the approval dashboard</h3>
        <p>Your sign-in is still active. Check your connection and try again.</p>
        <button type="button" class="btn-queue-review" id="retryApprovalDashboard">Try again</button>
      </div>
    `;
    root.querySelector("#retryApprovalDashboard")?.addEventListener("click", async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      try {
        await initAdminData();
      } catch (retryError) {
        showDashboardLoadError(retryError);
      }
    });
  }

  async function initAdminData() {
    findOrAssignAdminKey();
    const assignedStage = getAccountStage();
    loadApproverDirectory().then(() => {
      findOrAssignAdminKey();
      subscribeFirestorePendingEvents();
      if (activeReviewEventId) renderReviewScreen();
      else renderReviewQueue();
    });
    // Check URL parameters for direct review link: ?review={eventId}
    const urlParams = new URLSearchParams(window.location.search);
    const reviewId = urlParams.get("review") || urlParams.get("event") || urlParams.get("id");
    const reviewSource = urlParams.get("source");

    subscribeFirestorePendingEvents();
    subscribeRecentDecisions();

    if (reviewId) {
      if (reviewSource === "firestore") openFirestoreProposalReview(reviewId);
      else openReviewScreen(reviewId);
    } else {
      renderReviewQueue();
    }

    if (!auth?.currentUser) {
      subscribeReviewQueue();
      return;
    }

    subscribeReviewQueue();
  }

  function subscribeFirestorePendingEvents() {
    if (firestorePendingEventsUnsubscribe) {
      firestorePendingEventsUnsubscribe();
      firestorePendingEventsUnsubscribe = null;
    }
    if (firestorePendingEventsTimeout) {
      clearTimeout(firestorePendingEventsTimeout);
      firestorePendingEventsTimeout = null;
    }

    if (!db) {
      firestorePendingEvents = [];
      firestorePendingEventsLoaded = true;
      firestorePendingEventsError = "Firestore is not configured; submitted event proposals cannot be loaded.";
      if (!activeReviewEventId) renderReviewQueue();
      return;
    }

    firestorePendingEvents = [];
    firestorePendingEventsLoaded = false;
    firestorePendingEventsError = "";
    const assignedStage = getAccountStage();
    const isOrganizationAdviser = isOrgAdviserReviewer(assignedStage);
    const assignedOrganizationCode = isOrganizationAdviser
      ? getCurrentAdminOrganizationCode()
      : "";
    firestorePendingEventsTimeout = setTimeout(() => {
      firestorePendingEventsTimeout = null;
      if (firestorePendingEventsLoaded) return;
      console.warn("Timed out waiting for pending Firestore event proposals.");
      firestorePendingEventsLoaded = true;
      firestorePendingEventsError = "Couldn't load proposals in time. Check your connection and permissions, then refresh.";
      if (!activeReviewEventId) renderReviewQueue();
    }, 5000);

    try {
      const pendingEventConstraints = [where("status", "==", "pending")];
      if (isOrganizationAdviser && assignedOrganizationCode) {
        pendingEventConstraints.push(
          where("organizationCode", "==", assignedOrganizationCode),
        );
      }
      const pendingEventsQuery = query(
        collection(db, "events"),
        ...pendingEventConstraints,
      );
      console.log("[AdminApproval] Fetching pending Firestore proposals.", {
        organizationScoped: isOrganizationAdviser,
        hasOrganizationCode: Boolean(assignedOrganizationCode),
      });
      firestorePendingEventsUnsubscribe = onSnapshot(
        pendingEventsQuery,
        (snapshot) => {
          try {
            console.log("[AdminApproval] Pending Firestore snapshot received.", {
              count: snapshot.size,
            });
            const pendingEvents = snapshot.docs.map((eventSnapshot) => ({
              ...(eventSnapshot.data() || {}),
              id: eventSnapshot.id,
            }));
            firestorePendingEvents = pendingEvents.map((event) => {
              const currentStageKey = getFirestoreCurrentStageKey(event) ||
                getConfiguredFirestoreStages(event).find((stage) => {
                  const status = String(stage.source?.status || "")
                    .trim()
                    .toLowerCase()
                    .replace(/[\s_-]+/g, " ");
                  return !["ok", "approved", "complete", "completed"].includes(status);
                })?.key;
              return {
                ...event,
                currentApprovalStage: currentStageKey || null,
                pipelineStatus: isFirestoreActionRequired(event) ? "action-required" : "incoming",
              };
            });
            firestorePendingEventsError = "";
          } catch (error) {
            console.error("Could not process pending Firestore event proposals:", error);
            firestorePendingEvents = [];
            firestorePendingEventsError = "Couldn't load proposals. Check your connection and permissions, then refresh.";
          }
          if (firestorePendingEventsTimeout) {
            clearTimeout(firestorePendingEventsTimeout);
            firestorePendingEventsTimeout = null;
          }
          firestorePendingEventsLoaded = true;
          if (!activeReviewEventId) renderReviewQueue();
        },
        (error) => {
          console.log("[AdminApproval] Pending Firestore query failed.", {
            code: error?.code || "unknown",
            message: error?.message || String(error),
          });
          console.error("Could not load pending Firestore event proposals:", error);
          if (firestorePendingEventsTimeout) {
            clearTimeout(firestorePendingEventsTimeout);
            firestorePendingEventsTimeout = null;
          }
          firestorePendingEvents = [];
          firestorePendingEventsLoaded = true;
          firestorePendingEventsError = "Couldn't load proposals. Check your connection and permissions, then refresh.";
          if (!activeReviewEventId) renderReviewQueue();
        },
      );
    } catch (error) {
      console.error("Could not subscribe to pending Firestore event proposals:", error);
      if (firestorePendingEventsTimeout) {
        clearTimeout(firestorePendingEventsTimeout);
        firestorePendingEventsTimeout = null;
      }
      firestorePendingEvents = [];
      firestorePendingEventsLoaded = true;
      firestorePendingEventsError = "Couldn't load proposals. Check your connection and permissions, then refresh.";
      if (!activeReviewEventId) renderReviewQueue();
    }
  }

  async function loadApproverDirectory() {
    if (!rtdb) return;
    try {
      const snap = await get(ref(rtdb, "approverDirectory"));
      const data = snap.val();
      if (data && typeof data === "object") {
        approverDirectory = { ...APPROVER_DIRECTORY_DEFAULTS, ...data };
      }
    } catch (err) {
      console.warn("Could not load approver directory:", err);
    }
  }

  function findOrAssignAdminKey() {
    const assignedStage = getAccountStage();
    if (assignedStage) {
      currentAdminKey = assignedStage.key;
      localStorage.setItem("recovibeAdminKey", currentAdminKey);
      const roleEl = document.querySelector("[data-role]");
      if (roleEl) roleEl.textContent = assignedStage.label;
      return;
    }

    const uidMatch = Object.entries(approverDirectory).find(([, item]) => item?.uid === currentAdminUid);
    currentAdminKey = resolveApprovalStage(uidMatch?.[0] || uidMatch?.[1]?.key)?.key || uidMatch?.[0] || null;
    const roleEl = document.querySelector("[data-role]");
    if (currentAdminKey) {
      localStorage.setItem("recovibeAdminKey", currentAdminKey);
      if (roleEl) roleEl.textContent = getStageLabel(currentAdminKey);
    } else {
      localStorage.removeItem("recovibeAdminKey");
      if (roleEl) roleEl.textContent = "Approval role not assigned";
    }
  }

  // 2. Real-time Subscription to approverQueue/{uid}
  function subscribeReviewQueue() {
    if (queueListenerRef) {
      off(queueListenerRef);
      queueListenerRef = null;
    }

    if (!rtdb || !currentAdminUid) {
      // Demo fallback
      queueItems = [];
      updateQueueBadge(0);
      return;
    }

    queueListenerRef = ref(rtdb, `approverQueue/${currentAdminUid}`);
    onValue(queueListenerRef, (snap) => {
      const data = snap.val();
      const items = [];
      if (data && typeof data === "object") {
        Object.entries(data).forEach(([eventId, item]) => {
          if (item && typeof item === "object") {
            const assignedStageKey = getAccountStage()?.key || currentAdminKey;
            if (
              isOrgAdviserReviewer(getAccountStage() || { key: assignedStageKey }) &&
              normalizeOrganizationCode(item.organizationCode) !==
                getCurrentAdminOrganizationCode()
            ) return;
            items.push({
              eventId: item.eventId || eventId,
              name: item.name || item.title || `Event #${eventId}`,
              date: item.date || item.startAt || "Date TBA",
              venue: item.venue || item.location || "PUP Biñan Campus",
              category: item.category || "Academic & Learning",
              step: item.step || (approverDirectory[currentAdminKey]?.stage || 1),
              status: item.status || "pending",
              paused: Boolean(item.paused || item.status === "paused"),
              updatedAt: item.updatedAt || Date.now(),
            });
          }
        });
      }

      // Sort newest first
      items.sort((a, b) => Number(b.updatedAt) - Number(a.updatedAt));
      queueItems = items;

      const activeWaitingCount = items.filter((it) => !it.paused).length;
      updateQueueBadge(activeWaitingCount);

      if (!activeReviewEventId) {
        renderReviewQueue();
      }
    }, (err) => {
      console.warn("approverQueue listener error:", err);
    });
  }

  function updateQueueBadge(count) {
    document.querySelectorAll("[data-queue-count]").forEach((badge) => {
      badge.textContent = count ? String(count) : "";
      badge.hidden = count === 0;
    });
  }

  function getAdminDocumentsLink(value) {
    const findLink = (candidate) => {
      if (typeof candidate === "string") {
        try {
          const parsed = new URL(candidate);
          return parsed.protocol === "https:" &&
            ["drive.google.com", "docs.google.com"].includes(parsed.hostname.toLowerCase())
            ? parsed.href
            : "";
        } catch {
          return "";
        }
      }
      if (Array.isArray(candidate)) return candidate.map(findLink).find(Boolean) || "";
      if (!candidate || typeof candidate !== "object") return "";
      const directLink = findLink(candidate.url || candidate.href || candidate.path || candidate.downloadURL || candidate.downloadUrl);
      return directLink || Object.values(candidate).map(findLink).find(Boolean) || "";
    };
    return findLink(value);
  }

  function renderEventDetails(event, approvalFiles = []) {
    const values = (value) => {
      if (value == null || value === "") return [];
      return (Array.isArray(value) ? value : [value]).flatMap((item) =>
        typeof item === "string"
          ? item.split(/\r?\n/).map((part) => part.trim()).filter(Boolean)
          : item == null
            ? []
            : [item],
      );
    };
    const valueText = (value) => {
      if (value == null || value === "") return "";
      if (typeof value !== "object") return String(value);
      return String(value.name || value.title || value.label || value.displayName || "");
    };
    const safeDriveUrl = (value) => {
      try {
        const url = new URL(String(value || ""));
        return url.protocol === "https:" &&
          ["drive.google.com", "docs.google.com"].includes(url.hostname.toLowerCase())
          ? url.href
          : "";
      } catch {
        return "";
      }
    };
    const collectDriveDocuments = (sources, defaultName) => {
      const documents = new Map();
      const visit = (value, label) => {
        if (typeof value === "string") {
          value.split(/\r?\n/).forEach((line) => {
            const href = safeDriveUrl(line.trim());
            if (href && !documents.has(href)) documents.set(href, { name: label || defaultName, href });
          });
          return;
        }
        if (Array.isArray(value)) {
          value.forEach((item, index) => visit(item, item?.name || item?.title || `${label || defaultName} ${index + 1}`));
          return;
        }
        if (!value || typeof value !== "object") return;
        const name = value.name || value.title || value.fileName || label || defaultName;
        const href = safeDriveUrl(value.url || value.href || value.path || value.downloadURL || value.downloadUrl || value.fileUrl);
        if (href) {
          if (!documents.has(href)) documents.set(href, { name, href });
          return;
        }
        Object.entries(value).forEach(([key, item]) => visit(item, item?.name || item?.title || key));
      };
      sources.forEach((source) => visit(source, defaultName));
      return [...documents.values()];
    };
    const documentLinks = (documents) => documents.length
      ? `<div class="student-event-attachments">${documents.map(({ name, href }) => `
          <div class="student-event-attachment">
            <span>${esc(name)}</span>
            <a href="${esc(href)}" target="_blank" rel="noopener noreferrer" aria-label="Open ${esc(name)} in Google Drive">Open in Google Drive</a>
          </div>`).join("")}</div>`
      : `<p>Not specified</p>`;
    const listMarkup = (value) => {
      const list = values(value).map(valueText).filter(Boolean);
      return list.length
        ? `<ul class="student-event-list">${list.map((item) => `<li>${esc(item)}</li>`).join("")}</ul>`
        : "<p>Not specified</p>";
    };
    const dateText = (value) => {
      const text = String(value || "").trim();
      const datePart = text.match(/\d{4}-\d{2}-\d{2}/)?.[0] || text;
      if (!datePart) return "Not specified";
      const date = new Date(`${datePart.slice(0, 10)}T00:00:00`);
      return Number.isNaN(date.getTime())
        ? datePart
        : `${String(date.getMonth() + 1).padStart(2, "0")} / ${String(date.getDate()).padStart(2, "0")} / ${date.getFullYear()}`;
    };
    const timeText = (value) => {
      const time = String(value || "").trim();
      const match = /^(\d{1,2}):(\d{2})$/.exec(time);
      if (!match) return time || "Not specified";
      const hour = Number(match[1]);
      return `${String(hour % 12 || 12).padStart(2, "0")}:${match[2]} ${hour >= 12 ? "PM" : "AM"}`;
    };
    const dateTimeText = (value) => {
      const text = String(value || "").trim();
      if (!text) return "Not specified";
      const [date, time] = text.split(/[T ]/, 2);
      return `${dateText(date)}${time ? ` · ${timeText(time.slice(0, 5))}` : ""}`;
    };
    const dateStart = event.dateStart || event.dateISO || event.date || event.eventDate || event.startAt;
    const dateEnd = event.dateEnd || event.endDate || event.eventEndDate || event.endAt || dateStart;
    const dailySchedules = Array.isArray(event.dailySchedules) ? event.dailySchedules : [];
    const differentTimesByDay = dailySchedules.length > 0 &&
      (/different\s+time/i.test(String(event.dailySchedule || "")) || dailySchedules.length > 1);
    const startTime = event.timeStart || event.startTime || String(event.startAt || "").split(/[T ]/, 2)[1]?.slice(0, 5);
    const endTime = event.timeEnd || event.endTime || String(event.endAt || "").split(/[T ]/, 2)[1]?.slice(0, 5);
    const timeParts = String(event.time || "").split(/\s*[-–]\s*/);
    const times = [
      timeText(startTime || timeParts[0]),
      timeText(endTime || timeParts[1]),
    ];
    const capacity = event.maxCapacity ?? event.capacity ?? event.maxSlots ?? event.slots;
    const noCapacityLimit = event.capacityMode === "N/A" || capacity == null || capacity === "";
    const parsedCapacity = noCapacityLimit ? null : Number(capacity);
    const total = parsedCapacity == null || Number.isNaN(parsedCapacity) ? null : parsedCapacity;
    const registered = Number(event.registeredCount || event.participantCount || 0);
    const expected = event.expectedParticipants ?? event.expectedAttendees ?? registered;
    const slotsLeft = event.slotsLeft ?? event.availableSlots ?? event.slotsOpen ?? event.openSlots ??
      (total === null ? null : Math.max(0, total - registered));
    const dateInfo = (label, value) =>
      `<div class="student-event-info-card"><strong>${esc(label)}</strong><span>${esc(value || "Not specified")}</span></div>`;
    const categories = values(event.categories || event.category || event.tag).map(valueText).filter(Boolean);
    const categoryTone = (value) => {
      const category = String(value || "").toLowerCase();
      if (/social|arts|culture/.test(category)) return "purple";
      if (/university|campus|community/.test(category)) return "green";
      if (/academic|tech|innovation/.test(category)) return "blue";
      if (/sport|fitness/.test(category)) return "orange";
      return "maroon";
    };
    const source = [
      event.source || event.eventSource || event.campus || event.office,
      event.sourceOther,
    ].filter(Boolean).join(" · ") || "Not specified";
    const audience = [
      ...values(event.targetAudience || event.targetYear).map(valueText),
      ...(values(event.targetDepartments).length ? [`Departments: ${values(event.targetDepartments).map(valueText).join(", ")}`] : []),
      ...(values(event.targetYearLevels).length ? [`Year Levels: ${values(event.targetYearLevels).map(valueText).join(", ")}`] : []),
      ...(values(event.targetSections).length ? [`Sections: ${values(event.targetSections).map(valueText).join(", ")}`] : []),
    ].join(" · ") || "Open to All";
    const organizer = valueText(event.organizerName || event.organizer || event.organization) || "Not specified";
    const organizerRole = valueText(event.organizerRole || event.creatorRole);
    const organizerEmail = event.organizerEmail || event.createdByEmail || "";
    const contact = event.contactPerson && typeof event.contactPerson === "object" ? event.contactPerson : {};
    const contactParts = (typeof event.contactPerson === "string" ? event.contactPerson : event.contactName || "")
      .split(/[\n,|]+/)
      .map((part) => part.trim())
      .filter(Boolean);
    const contactEmail = contact.email || event.contactEmail || contactParts.find((part) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(part)) || "";
    const contactPhone = contact.phone || event.contactPhone || contactParts.find((part) => /\+?[\d() -]{7,}/.test(part) && /\d{7}/.test(part)) || "";
    const contactName = valueText(contact.name || event.contactName || contactParts.find((part) => part !== contactEmail && part !== contactPhone)) || "Not specified";
    const contactRole = valueText(contact.role || event.contactRole || contactParts.find((part) => part !== contactName && part !== contactEmail && part !== contactPhone));
    const objectives = event.objectives || event.keyDetails || event.detailedInfo || event.focusAreas;
    const requirements = event.requirements && typeof event.requirements === "object" && !Array.isArray(event.requirements)
      ? [...values(event.requirements.required), ...values(event.requirements.recommended)]
      : values(event.requirements);
    const rules = [
      ...values(event.participationRules || event.rules),
      ...values(event.reminders),
      ...requirements,
    ];
    const adminDocuments = collectDriveDocuments(
      [event.adminDocuments, event.adminDocsLink, event.approvalDocuments, event.approvalDocs, event.organizerDocuments, approvalFiles],
      "Admin review document",
    );
    const participantDocuments = collectDriveDocuments(
      [event.participantDocuments, event.attachments, event.participantDocs, event.participantDocumentLink, event.participantDocsLink, event.registrationDocuments],
      "Participant document",
    );
    const schedulesMarkup = dailySchedules.map((schedule, index) => {
      const label = schedule.label || (index === 0 ? "First Day" : index === dailySchedules.length - 1 ? "Last Day" : `Day ${index + 1}`);
      return `<div class="student-event-daily-row"><strong>${esc(label)}</strong><span>${esc(dateText(schedule.date || schedule.dateISO))}</span><strong>Time Start</strong><span>${esc(timeText(schedule.timeStart))}</span><strong>Time End</strong><span>${esc(timeText(schedule.timeEnd))}</span></div>`;
    }).join("");
    const description = String(event.description || event.desc || event.about || "").split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean);
    const attendance = typeof event.attendanceRequired === "boolean"
      ? event.attendanceRequired ? "Required" : "Not Required"
      : event.attendanceRequired || "Not specified";

    return `
      <header class="student-event-top">
        <div class="student-event-heading">
          <h2 class="student-event-title">${esc(event.eventName || event.title || event.name || "Untitled Event")}</h2>
          <p><strong>Event Organizer:</strong> ${esc(organizer)}</p>
          ${organizerRole ? `<p><strong>Organizer Role:</strong> ${esc(organizerRole)}</p>` : ""}
          ${organizerEmail ? `<p><strong>Organizer Email:</strong> <a href="mailto:${esc(organizerEmail)}">${esc(organizerEmail)}</a></p>` : ""}
          <p><strong>Event Source:</strong> ${esc(source)}</p>
        </div>
        <div class="student-event-header-meta">
          <div><strong>Categories:</strong><div class="student-event-categories">${(categories.length ? categories : ["General"]).map((category) => `<span class="student-event-pill student-event-pill--${categoryTone(category)}">${esc(category)}</span>`).join("")}</div></div>
          <p><strong>Target Audience:</strong> ${esc(audience)}</p>
          <p><strong>Attendance:</strong> ${esc(attendance)}</p>
        </div>
      </header>
      <section class="student-event-info" aria-label="Event schedule and capacity">
        ${dateInfo("Date Start", dateText(dateStart))}
        ${dateInfo("Date End", dateText(dateEnd))}
        ${differentTimesByDay ? "" : dateInfo("Time Start", times[0])}
        ${differentTimesByDay ? "" : dateInfo("Time End", times[1])}
        ${dateInfo("Venue", [event.venue || event.location || event.venueName, event.room || event.roomNumber || event.venueAddress].filter(Boolean).join(" · "))}
        ${dateInfo("Venue Type", event.venueType || event.weatherContingency || "Not specified")}
        ${dateInfo("Max Capacity", total === null || Number.isNaN(total) ? "No limit" : `${total} People`)}
        ${dateInfo("Expected Participants", String(expected))}
        ${dateInfo("Slots Left", slotsLeft == null ? "Open registration" : `${slotsLeft}${total === null ? "" : ` of ${total}`}`)}
      </section>
      ${differentTimesByDay ? `<section class="student-event-daily-schedule"><h3>Different Time Per Day</h3><div>${schedulesMarkup}</div></section>` : ""}
      <section class="student-event-section student-event-registration">
        <h3>Registration Information</h3>
        <div class="student-event-registration-grid">
          <p><strong>Registration Start:</strong> ${esc(dateTimeText(event.registrationStart))}</p>
          <p><strong>Registration End:</strong> ${esc(dateTimeText(event.registrationEnd || event.registrationDeadline))}</p>
          ${event.registrationInfo ? `<p>${esc(event.registrationInfo)}</p>` : ""}
        </div>
      </section>
      <section class="student-event-section student-event-description"><h3>Event Description</h3>${description.length ? description.map((part) => `<p>${esc(part)}</p>`).join("") : "<p>Not specified</p>"}</section>
      <section class="student-event-section"><h3>Rationale</h3><p>${esc(event.rationale || "Not specified")}</p></section>
      <section class="student-event-section"><h3>Objectives</h3>${listMarkup(objectives)}</section>
      <section class="student-event-section"><h3>Rules &amp; Reminders</h3>${listMarkup(rules)}</section>
      <section class="student-event-section student-event-documents"><h3>Documents for Admin Review</h3><p>Open the Google Drive links to review the submitted requirements.</p>${documentLinks(adminDocuments)}</section>
      <div class="student-event-bottom-grid">
        <section class="student-event-section student-event-contact"><h3>Contact Person</h3><p><strong>Name:</strong> ${esc(contactName)}</p>${contactRole ? `<p><strong>Role:</strong> ${esc(contactRole)}</p>` : ""}${contactEmail ? `<p><strong>Email:</strong> <a href="mailto:${esc(contactEmail)}">${esc(contactEmail)}</a></p>` : ""}${contactPhone ? `<p><strong>Number:</strong> ${esc(contactPhone)}</p>` : ""}</section>
        <section class="student-event-section student-event-documents"><h3>Participant Documents</h3><p>Open the Google Drive links to download the required files.</p>${documentLinks(participantDocuments)}</section>
      </div>`;
  }

  // 3. Real-time Subscription to approverDecisions/{uid}
  function subscribeRecentDecisions() {
    if (decisionsListenerRef) {
      off(decisionsListenerRef);
      decisionsListenerRef = null;
    }

    if (!rtdb || !currentAdminUid) return;

    decisionsListenerRef = ref(rtdb, `approverDecisions/${currentAdminUid}`);
    onValue(decisionsListenerRef, (snap) => {
      const data = snap.val();
      const list = [];
      if (data && typeof data === "object") {
        Object.entries(data).forEach(([eventId, row]) => {
          if (row && typeof row === "object") {
            list.push({
              eventId,
              name: row.name || "Event",
              decision: row.decision || "Approved",
              note: row.note || "",
              decidedAt: row.decidedAt || Date.now(),
            });
          }
        });
      }
      list.sort((a, b) => Number(b.decidedAt) - Number(a.decidedAt));
      recentDecisions = list.slice(0, 10);

      if (!activeReviewEventId) {
        renderReviewQueue();
      }
    });
  }

  // =========================================================================
  // VIEW 1: REVIEW QUEUE
  // =========================================================================
  function renderReviewQueue() {
    if (!root) return;
    if (pageHeadingTitle) pageHeadingTitle.textContent = "Review Queue";

    let cardsHtml = "";
    if (queueItems.length === 0) {
      cardsHtml = `
        <div class="queue-empty-box">
          <svg viewBox="0 0 24 24" fill="none" stroke="#a8a29e" stroke-width="1.5" width="40" height="40" style="margin-bottom:12px;">
            <circle cx="12" cy="12" r="10"/>
            <path d="M12 6v6l4 2"/>
          </svg>
          <h3>Nothing waiting on you</h3>
          <p>You have no event proposals currently awaiting your review.</p>
        </div>
      `;
    } else {
      cardsHtml = `
        <div class="queue-cards-grid">
          ${queueItems
            .map((item) => {
              const isPaused = item.paused || item.status === "paused";
              return `
                <article class="queue-card" data-event-id="${esc(item.eventId)}" tabindex="0" aria-label="Open proposal review for ${esc(item.name)}">
                  <div>
                    <div class="queue-card-header">
                      <span class="queue-step-tag">Step ${item.step}</span>
                      ${
                        isPaused
                          ? `<span class="queue-paused-badge">Paused for revision</span>`
                          : ""
                      }
                    </div>
                    <h3 class="queue-card-title">${esc(item.name)}</h3>
                    <div class="queue-card-meta">
                      <div class="queue-card-meta-item">
                        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" width="14" height="14">
                          <rect x="2.5" y="3.5" width="15" height="13.5" rx="1.6"/>
                          <path d="M2.5 8H17.5M6 2v3M14 2v3"/>
                        </svg>
                        <span>${esc(item.date)}</span>
                      </div>
                      <div class="queue-card-meta-item">
                        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" width="14" height="14">
                          <path d="M10 2a6 6 0 0 0-6 6c0 4.5 6 10 6 10s6-5.5 6-10a6 6 0 0 0-6-6Z"/>
                          <circle cx="10" cy="8" r="2"/>
                        </svg>
                        <span>${esc(item.venue)}</span>
                      </div>
                      <div class="queue-card-meta-item">
                        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" width="14" height="14">
                          <circle cx="10" cy="10" r="7"/>
                          <path d="M10 6v4l3 2"/>
                        </svg>
                        <span>${esc(item.category)}</span>
                      </div>
                    </div>
                  </div>
                  <div class="queue-card-footer">
                    ${
                      isPaused
                        ? `<span style="font-size:12px; color:#92400e; font-style:italic;">Awaiting organizer updates</span>`
                        : `<button type="button" class="btn-queue-review" data-action="review" data-id="${esc(item.eventId)}">Review Proposal</button>`
                    }
                  </div>
                </article>
              `;
            })
            .join("")}
        </div>
      `;
    }

    const renderFirestoreProposalCards = (events, incoming) => events.length
      ? `<div class="queue-cards-grid">
          ${events.map((event) => {
            const eventName = event.eventName || event.title || "Untitled Event";
            const eventDate = event.date || event.dateStart || event.startAt || "Date TBA";
            const eventVenue = event.venue || event.location || "Venue TBA";
            const adminDocumentsLink = getAdminDocumentsLink(event.adminDocuments);
            const currentStage = event.currentApprovalStage
              ? getStageLabel(event.currentApprovalStage)
              : "Approval status unavailable";
            return `
              <article class="queue-card queue-card--${incoming ? "incoming" : "action"}" data-firestore-event-id="${esc(event.id)}" tabindex="0" aria-label="${incoming ? "Preview" : "Review"} proposal ${esc(eventName)}">
                <div>
                  <div class="queue-card-header">
                    <span class="queue-step-tag">Currently with ${esc(currentStage)}</span>
                    <span class="queue-pipeline-status queue-pipeline-status--${incoming ? "incoming" : "action"}">${incoming ? "Incoming" : "Action required"}</span>
                  </div>
                  <h3 class="queue-card-title">${esc(eventName)}</h3>
                  <div class="queue-card-meta">
                    <div class="queue-card-meta-item"><span>${esc(eventDate)}</span></div>
                    <div class="queue-card-meta-item"><span>${esc(eventVenue)}</span></div>
                  </div>
                </div>
                <div class="queue-card-footer">
                  <button type="button" class="btn-queue-review" data-action="review-firestore" data-id="${esc(event.id)}">${incoming ? "Preview proposal" : "Review proposal"}</button>
                  ${
                    adminDocumentsLink
                      ? `<a class="btn-queue-review" href="${esc(adminDocumentsLink)}" target="_blank" rel="noopener noreferrer">Review admin documents</a>`
                      : `<span role="status">No valid Google Drive link was provided.</span>`
                  }
                </div>
              </article>
            `;
          }).join("")}
        </div>`
      : `<div class="queue-empty-box"><span>${incoming ? "No incoming proposals." : "No proposals require a decision."}</span></div>`;

    const actionableFirestoreEvents = firestorePendingEvents.filter((event) => event.pipelineStatus === "action-required");
    const incomingFirestoreEvents = firestorePendingEvents.filter((event) => event.pipelineStatus === "incoming");
    const firestoreProposalsHtml = `
      <section class="recent-decisions-section approval-pipeline-section">
        ${
          !firestorePendingEventsLoaded
            ? `<div class="admin-loading">Loading pending Firestore proposals…</div>`
            : firestorePendingEventsError
              ? `<div class="queue-empty-box" role="alert"><p>${esc(firestorePendingEventsError)}</p></div>`
              : `
                <section class="approval-pipeline-group" aria-label="Proposals requiring your action">
                  <div class="approval-pipeline-heading">
                    <div>
                      <h4>Require Your Action</h4>
                      <p>Proposals currently at your approval step.</p>
                    </div>
                    <span class="approval-pipeline-count">${actionableFirestoreEvents.length}</span>
                  </div>
                  ${renderFirestoreProposalCards(actionableFirestoreEvents, false)}
                </section>
                <section class="approval-pipeline-group approval-pipeline-group--incoming" aria-label="Incoming and pending review proposals">
                  <div class="approval-pipeline-heading">
                    <div>
                      <h4>Incoming / Pending Review</h4>
                      <p>Preview submitted proposals not currently assigned to your approval step.</p>
                    </div>
                    <span class="approval-pipeline-count">${incomingFirestoreEvents.length}</span>
                  </div>
                  ${renderFirestoreProposalCards(incomingFirestoreEvents, true)}
                </section>
              `
        }
      </section>
    `;

    // Recent Decisions HTML
    let recentHtml = "";
    if (recentDecisions.length > 0) {
      recentHtml = `
        <section class="recent-decisions-section">
          <h3>Your Recent Decisions</h3>
          <div class="recent-decisions-list">
            ${recentDecisions
              .map((d) => {
                const badgeClass =
                  d.decision === "Approved"
                    ? "approved"
                    : d.decision === "Asked for changes"
                    ? "asked-for-changes"
                    : "rejected";
                const dDate = new Date(d.decidedAt).toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                  hour: "numeric",
                  minute: "2-digit",
                });
                return `
                  <div class="recent-decision-item">
                    <div>
                      <strong>${esc(d.name)}</strong>
                      <small style="display:block; color:#786f70; font-size:11.5px; margin-top:2px;">${dDate}${d.note ? ` · "${esc(d.note)}"` : ""}</small>
                    </div>
                    <span class="decision-badge ${badgeClass}">${esc(d.decision)}</span>
                  </div>
                `;
              })
              .join("")}
          </div>
        </section>
      `;
    }

    root.innerHTML = `
      <div class="queue-header-row">
        <div class="queue-title-block">
          <h2>Review queue</h2>
        </div>
        <div class="approver-role-switcher">
          <span>Acting as:</span>
          <strong>${esc(currentAdminKey ? getStageLabel(currentAdminKey) : "Approval role not assigned")}</strong>
        </div>
      </div>

      ${cardsHtml}
      ${firestoreProposalsHtml}
      ${recentHtml}
    `;

    // Hook up review buttons
    root.querySelectorAll('[data-action="review"]').forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.id;
        if (id) openReviewScreen(id);
      });
    });
    root.querySelectorAll('[data-action="review-firestore"]').forEach((btn) => {
      btn.addEventListener("click", () => {
        const event = firestorePendingEvents.find((item) => item.id === btn.dataset.id);
        if (event) openFirestoreProposalReview(event.id);
      });
    });

    root.querySelectorAll(".queue-card").forEach((card) => {
      const openCard = () => {
        if (card.dataset.firestoreEventId) {
          openFirestoreProposalReview(card.dataset.firestoreEventId);
        } else if (card.dataset.eventId) {
          openReviewScreen(card.dataset.eventId);
        }
      };
      card.addEventListener("click", (event) => {
        if (event.target.closest("a, button")) return;
        openCard();
      });
      card.addEventListener("keydown", (event) => {
        if (event.target !== card || !["Enter", " "].includes(event.key)) return;
        event.preventDefault();
        openCard();
      });
    });
  }

  // =========================================================================
  // VIEW 2: REVIEW SCREEN
  // =========================================================================
  function openReviewScreen(eventId) {
    if (firestoreProposalLoadTimeout) {
      clearTimeout(firestoreProposalLoadTimeout);
      firestoreProposalLoadTimeout = null;
    }
    if (activeFirestoreEventUnsubscribe) {
      activeFirestoreEventUnsubscribe();
      activeFirestoreEventUnsubscribe = null;
    }
    activeFirestoreReview = false;
    firestoreProposalLoadError = "";
    activeReviewEventId = eventId;
    window.history.pushState(null, "", `AdminApproval.html?review=${encodeURIComponent(eventId)}`);

    if (activeEventRef) off(activeEventRef);
    if (activeApprovalRef) off(activeApprovalRef);

    if (!rtdb) return;

    activeEventRef = ref(rtdb, `events/${eventId}`);
    onValue(activeEventRef, (snap) => {
      activeEvent = snap.val();
      if (
        isOrgAdviserReviewer(getAccountStage() || { key: currentAdminKey }) &&
        activeEvent &&
        getEventOrganizationCode(activeEvent) !==
          getCurrentAdminOrganizationCode()
      ) {
        showToast("This proposal is outside your assigned organization.");
        closeReviewScreen();
        return;
      }
      renderReviewScreen();
    });

    activeApprovalRef = ref(rtdb, `approvals/${eventId}`);
    onValue(activeApprovalRef, (snap) => {
      activeApproval = snap.val();
      renderReviewScreen();
    });
  }

  function getFirestoreApproval(event) {
    const requestedStep = Number(event.approvalCurrentStep);
    const configuredStages = getConfiguredFirestoreStages(event);
    const currentStageKey = getFirestoreCurrentStageKey(event);
    const currentStep = configuredStages.find((stage) => stage.key === currentStageKey)?.step ||
      (requestedStep >= 1 ? requestedStep : 1);
    const members = {};
    configuredStages.forEach((stage) => {
      const source = stage.source;
      const rawStatus = String(source?.status || "").trim().toLowerCase().replace(/[\s_-]+/g, " ");
      const status = ["ok", "approved", "complete", "completed"].includes(rawStatus)
        ? "ok"
        : ["review", "reviewing", "in review", "in progress"].includes(rawStatus) ||
            (stage.step === currentStep && ["", "pending", "waiting", "wait"].includes(rawStatus))
          ? "review"
          : ["rev", "revision", "changes requested"].includes(rawStatus)
            ? "rev"
            : ["rej", "rejected"].includes(rawStatus)
              ? "rej"
              : ["wait", "waiting", "pending", ""].includes(rawStatus)
                ? "wait"
                : "wait";
      members[stage.key] = {
        key: stage.key,
        label: stage.label,
        step: stage.step,
        stage: stage.step,
        status,
        note: source?.note || "",
        updatedAt: source?.updatedAt || source?.approvedAt || null,
        approvedByName: source?.approvedByName || source?.decidedBy || source?.rejectedByName || "",
      };
    });

    const files = {};
    (Array.isArray(event.approvalDocuments) ? event.approvalDocuments : []).forEach((file, index) => {
      const id = file.id || `approval-file-${index}`;
      files[id] = { ...file, id, name: file.name || "Attached document", status: file.status || "ok" };
    });
    if (event.adminDocuments) {
      files.adminDocuments = { id: "adminDocuments", name: "Admin documents", path: event.adminDocuments, status: "ok" };
    }

    return {
      status: event.approvalStatus || event.status || "pending",
      submittedAt: event.approvalSubmittedAt || event.createdAt || null,
      members,
      files,
      history: Array.isArray(event.approvalHistory) ? event.approvalHistory : [],
    };
  }

  function isFirestoreActionRequired(event) {
    const approval = getFirestoreApproval(event);
    const members = Object.values(approval.members || {});
    const activeStage = members.find((member) => member.status !== "ok");
    const currentStageKey = getFirestoreCurrentStageKey(event);
    const explicitCurrentStep = Number(
      event.currentStep ??
      event.approvalCurrentStep ??
      approval.currentStep ??
      approval.approvalCurrentStep,
    );
    const declaredStageKey = currentStageKey ||
      members.find((member) => Number(member.step) === explicitCurrentStep)?.key ||
      members.find((member) => member.status === "review")?.key ||
      null;
    const assignedRole = getApprovalStageForProfile(currentAdminProfile);

    return Boolean(
      activeStage &&
      activeStage.status === "review" &&
      approval.status !== "revision" &&
      (!assignedRole || assignedRole.key === activeStage.key) &&
      (!declaredStageKey || declaredStageKey === activeStage.key) &&
      (!Number.isInteger(explicitCurrentStep) || explicitCurrentStep < 1 ||
        explicitCurrentStep === activeStage.step) &&
      isCurrentUserAssignedToStage(event, activeStage) &&
      currentStageKey === activeStage.key
    );
  }

  function openFirestoreProposalReview(eventId) {
    if (firestoreProposalLoadTimeout) {
      clearTimeout(firestoreProposalLoadTimeout);
      firestoreProposalLoadTimeout = null;
    }
    if (activeEventRef) {
      off(activeEventRef);
      activeEventRef = null;
    }
    if (activeApprovalRef) {
      off(activeApprovalRef);
      activeApprovalRef = null;
    }
    if (activeFirestoreEventUnsubscribe) {
      activeFirestoreEventUnsubscribe();
      activeFirestoreEventUnsubscribe = null;
    }

    activeReviewEventId = eventId;
    activeFirestoreReview = true;
    activeEvent = null;
    activeApproval = null;
    firestoreProposalLoadError = "";
    const reviewUrl = new URL("AdminApproval.html", window.location.href);
    reviewUrl.searchParams.set("review", eventId);
    reviewUrl.searchParams.set("source", "firestore");
    window.history.pushState(null, "", reviewUrl.href);

    if (!db) {
      firestoreProposalLoadError = "Proposal details could not be loaded. Please try again.";
      renderReviewScreen();
      return;
    }
    const renderFirestoreEvent = (eventData) => {
      activeEvent = {
        ...eventData,
        name: eventData.eventName || eventData.name || eventData.title || "Untitled Event",
        venue: eventData.venue || eventData.location || eventData.venueName || "Venue TBA",
        startAt: eventData.startAt || eventData.date || eventData.dateStart || "Date TBA",
        source: eventData.source || eventData.eventSource || eventData.campus || eventData.office || "Firestore submission",
      };
      activeApproval = getFirestoreApproval(eventData);
      firestoreProposalLoadError = "";
      renderReviewScreen();
    };
    renderReviewScreen();
    firestoreProposalLoadTimeout = setTimeout(() => {
      firestoreProposalLoadTimeout = null;
      if (activeReviewEventId !== eventId || activeEvent) return;
      firestoreProposalLoadError = "Proposal details could not be loaded. Please try again.";
      if (activeFirestoreEventUnsubscribe) {
        activeFirestoreEventUnsubscribe();
        activeFirestoreEventUnsubscribe = null;
      }
      renderReviewScreen();
    }, 12000);
    try {
      activeFirestoreEventUnsubscribe = onSnapshot(
        doc(db, "events", eventId),
        (snapshot) => {
          if (firestoreProposalLoadTimeout) {
            clearTimeout(firestoreProposalLoadTimeout);
            firestoreProposalLoadTimeout = null;
          }
          if (!snapshot.exists()) {
            activeEvent = null;
            activeApproval = null;
            firestoreProposalLoadError = "Proposal details not found.";
            renderReviewScreen();
            return;
          }
          try {
            renderFirestoreEvent(snapshot.data());
          } catch (error) {
            console.error("Could not load Firestore proposal details:", error);
            activeEvent = null;
            activeApproval = null;
            firestoreProposalLoadError = "Proposal details could not be loaded. Please try again.";
            renderReviewScreen();
          }
        },
        (error) => {
          if (firestoreProposalLoadTimeout) {
            clearTimeout(firestoreProposalLoadTimeout);
            firestoreProposalLoadTimeout = null;
          }
          console.error("Could not load Firestore proposal details:", error);
          activeEvent = null;
          activeApproval = null;
          firestoreProposalLoadError = "Proposal details could not be loaded. Please try again.";
          renderReviewScreen();
        },
      );
    } catch (error) {
      if (firestoreProposalLoadTimeout) {
        clearTimeout(firestoreProposalLoadTimeout);
        firestoreProposalLoadTimeout = null;
      }
      console.error("Could not load Firestore proposal details:", error);
      firestoreProposalLoadError = "Proposal details could not be loaded. Please try again.";
      renderReviewScreen();
    }
  }

  function closeReviewScreen() {
    if (firestoreProposalLoadTimeout) {
      clearTimeout(firestoreProposalLoadTimeout);
      firestoreProposalLoadTimeout = null;
    }
    if (activeFirestoreEventUnsubscribe) {
      activeFirestoreEventUnsubscribe();
      activeFirestoreEventUnsubscribe = null;
    }
    activeFirestoreReview = false;
    activeReviewEventId = null;
    activeEvent = null;
    activeApproval = null;
    firestoreProposalLoadError = "";

    if (activeEventRef) {
      off(activeEventRef);
      activeEventRef = null;
    }
    if (activeApprovalRef) {
      off(activeApprovalRef);
      activeApprovalRef = null;
    }

    window.history.pushState(null, "", "AdminApproval.html");
    renderReviewQueue();
  }

  function renderReviewScreen() {
    if (!root || !activeReviewEventId) return;
    if (pageHeadingTitle) pageHeadingTitle.textContent = "Proposal Review";

    if (!activeEvent || !activeApproval) {
      root.innerHTML = `
        <div class="review-screen-container">
          <div class="review-screen-top-bar">
            <button type="button" class="btn-back-queue" id="btnBackToQueue">
              ← Back to queue
            </button>
          </div>
          <div class="admin-loading">${firestoreProposalLoadError || "Loading proposal details..."}</div>
        </div>
      `;
      root.querySelector("#btnBackToQueue")?.addEventListener("click", closeReviewScreen);
      return;
    }

    const sourceMembers = activeApproval.members || {};
    const members = Object.fromEntries(APPROVAL_ACCOUNT_STAGES.map((stage) => {
      const sourceEntry = Object.entries(sourceMembers).find(([key, member]) =>
        [key, member.key, member.roleKey, member.id, member.label, member.name, member.reviewer]
          .some((value) => resolveApprovalStage(value)?.key === stage.key),
      );
      const source = sourceEntry?.[1] || {};
      return [stage.key, {
        ...source,
        key: stage.key,
        label: stage.key === "hap"
          ? "Head of Academic Programs, QAC Coordinator (HAP)"
          : stage.label,
        step: stage.step,
        stage: stage.step,
        status: source.status || "wait",
      }];
    }));
    const sortedMembers = Object.values(members);

    // Identify current admin's member entry
    const firestoreCurrentStageKey = activeFirestoreReview
      ? getFirestoreCurrentStageKey(activeEvent)
      : null;
    const activeStage = sortedMembers.find((member) => member.status !== "ok") || null;
    const activeStageKey = activeStage?.key || null;
    const explicitCurrentStep = Number(
      activeEvent.currentStep ??
      activeEvent.approvalCurrentStep ??
      activeApproval.currentStep ??
      activeApproval.approvalCurrentStep,
    );
    const declaredStageKey = firestoreCurrentStageKey ||
      sortedMembers.find((member) => Number(member.step) === explicitCurrentStep)?.key ||
      sortedMembers.find((member) => member.status === "review")?.key ||
      null;
    const assignedRole = getApprovalStageForProfile(currentAdminProfile);
    const isMyTurn = activeFirestoreReview
      ? isFirestoreActionRequired(activeEvent)
      : Boolean(
          activeStage &&
          activeStage.status === "review" &&
          activeApproval.status !== "revision" &&
          (!assignedRole || assignedRole.key === activeStage.key) &&
          (!declaredStageKey || declaredStageKey === activeStage.key) &&
          (!Number.isInteger(explicitCurrentStep) || explicitCurrentStep < 1 ||
            explicitCurrentStep === activeStage.step) &&
          isCurrentUserAssignedToStage(activeEvent, activeStage)
        );

    // Header Tag
    let turnTagHtml = "";
    if (isMyTurn) {
      turnTagHtml = `<span class="turn-badge">Your turn: Step ${activeStage.step}</span>`;
    } else if (activeStage && !["approved", "rejected", "cancelled"].includes(
      String(activeApproval.status || "").toLowerCase(),
    )) {
      turnTagHtml = `<div class="not-waiting-notice">${activeFirestoreReview ? "Preview only · " : ""}Waiting for the assigned approver for Step ${activeStage.step}: ${esc(activeStage.label)}.</div>`;
    } else if (activeFirestoreReview) {
      turnTagHtml = `<div class="not-waiting-notice">Approval tracker · review actions are available from the assigned approver queue.</div>`;
    } else {
      turnTagHtml = `<div class="not-waiting-notice">This proposal is not waiting on you right now.</div>`;
    }

    // Tracker Track Items
    const totalSteps = sortedMembers.length;
    let trackItemsHtml = "";

    // 1. Submitted Step
    trackItemsHtml += `
      <div class="admin-tracker-step">
        <div class="admin-step-connector is-green"></div>
        <div class="admin-step-dot dot-ok">✓</div>
        <span class="admin-step-num">Start</span>
        <span class="admin-step-label">Submitted</span>
        <span class="admin-step-status">${activeApproval.submittedAt ? new Date(activeApproval.submittedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "Done"}</span>
      </div>
    `;

    // 2. Intermediate Steps
    sortedMembers.forEach((m, idx) => {
      const isLast = idx === sortedMembers.length - 1;
      const isOwnStep = m.key === (activeFirestoreReview ? activeStageKey : currentAdminKey);
      let dotClass = "dot-wait";
      let dotIcon = "–";
      let statusText = "Waiting";
      let connectorGreen = false;

      if (m.status === "ok") {
        dotClass = "dot-ok";
        dotIcon = "✓";
        const dateStr = m.updatedAt
          ? new Date(m.updatedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })
          : "Approved";
        statusText = `Approved ${dateStr}`;
        connectorGreen = true;
      } else if (m.status === "review") {
        dotClass = "dot-review";
        dotIcon = "⏱";
        statusText = "In review";
      } else if (m.status === "rev") {
        dotClass = "dot-rev";
        dotIcon = "✎";
        statusText = "Asked for changes";
      } else if (m.status === "rej") {
        dotClass = "dot-rej";
        dotIcon = "✕";
        statusText = "Rejected";
      }

      trackItemsHtml += `
        <div class="admin-tracker-step ${isOwnStep ? "is-own" : ""}" id="trackerStep_${esc(m.key)}">
          ${!isLast ? `<div class="admin-step-connector ${connectorGreen ? "is-green" : ""}"></div>` : `<div class="admin-step-connector ${connectorGreen ? "is-green" : ""}"></div>`}
          <div class="admin-step-dot ${dotClass}" title="${esc(m.label)}: ${statusText}">${dotIcon}</div>
          <span class="admin-step-num">STEP ${m.step}</span>
          <span class="admin-step-label">${esc(m.label)}</span>
          <span class="admin-step-status">${statusText}</span>
        </div>
      `;
    });

    // 3. Finish Step
    const isAllApproved = activeApproval.status === "approved" || (sortedMembers.length > 0 && sortedMembers.every((m) => m.status === "ok"));
    trackItemsHtml += `
      <div class="admin-tracker-step">
        <div class="admin-step-dot ${isAllApproved ? "dot-ok" : "dot-wait"}">${isAllApproved ? "✓" : "★"}</div>
        <span class="admin-step-num">End</span>
        <span class="admin-step-label">Finish</span>
        <span class="admin-step-status">${isAllApproved ? "Approved" : "Waiting"}</span>
      </div>
    `;

    // Notes List
    const actedMembers = sortedMembers;
    let notesListHtml = "";
    if (actedMembers.length === 0) {
      notesListHtml = `<p style="font-size:13px; color:#78716c; margin:0;">No actions recorded yet.</p>`;
    } else {
      notesListHtml = actedMembers
        .map((m) => {
          const statusText = m.status === "ok" ? "Approved" : m.status === "review" ? "Reviewing now" : m.status === "rev" ? "Changes requested" : m.status === "rej" ? "Rejected" : "Waiting";
          const statusClass = m.status === "ok" ? "approved" : m.status === "review" ? "reviewing" : m.status === "rev" ? "revision" : m.status === "rej" ? "rejected" : "waiting";
          const statusIcon = m.status === "ok" ? "✓" : m.status === "review" ? "◷" : m.status === "rev" ? "!" : m.status === "rej" ? "×" : "–";
          const updatedAt = m.updatedAt
            ? new Date(Number(m.updatedAt)).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
            : "";
          const noteText = m.status === "ok" && m.approvedByName
            ? `Approved by ${m.approvedByName}.`
            : m.note || statusText;
          return `
            <article class="admin-note-row is-${statusClass}">
              <div class="admin-note-avatar" aria-hidden="true">${statusIcon}</div>
              <div class="admin-note-body">
                <strong>Step ${m.step} · ${esc(m.label)}</strong>
                <span class="admin-stage-status">${statusText}${updatedAt ? ` · ${updatedAt}` : ""}</span>
                <p>${esc(noteText)}</p>
              </div>
            </article>
          `;
        })
        .join("");
    }

    // Next approver line
    const nextWaiting = sortedMembers.find((m) => m.status === "wait" || m.status === "review");
    const nextLineHtml = nextWaiting
      ? `<div class="next-approver-line">Next: ${esc(nextWaiting.label)} (Step ${nextWaiting.step} of ${totalSteps})</div>`
      : `<div class="next-approver-line">Next: None (Final approval reached)</div>`;

    // Documents List
    const files = activeApproval.files || {};
    const filesList = Object.values(files);
    let filesHtml = "";
    if (filesList.length === 0) {
      filesHtml = `<p style="font-size:13px; color:#78716c; margin:0;">No documents attached to this proposal.</p>`;
    } else {
      filesHtml = filesList
        .map((f) => {
          const hasRevision = f.status === "rev" || f.note;
          const driveLink = getAdminDocumentsLink(f.url || f.href || f.path || f.downloadURL || f.downloadUrl);
          return `
            <div class="review-doc-row">
              <div class="review-doc-left">
                <div class="review-doc-icon">📄</div>
                <div>
                  <div class="review-doc-name">${esc(f.name)}</div>
                  <div class="review-doc-status ${hasRevision ? "has-note" : ""}">
                    ${hasRevision ? `Changes requested: "${esc(f.note)}"` : "No changes requested"}
                  </div>
                  ${driveLink ? `<a href="${esc(driveLink)}" target="_blank" rel="noopener noreferrer">Open Google Drive document</a>` : ""}
                </div>
              </div>
            </div>
          `;
        })
        .join("");
    }

    // Decision Card HTML
    let decisionCardHtml = "";
    if (isMyTurn) {
      const nextStage = sortedMembers.find((member) => Number(member.step) > Number(activeStage.step));
      const fileOptions = filesList
        .map((f) => `<option value="${esc(f.id)}">${esc(f.name)}</option>`)
        .join("");

      decisionCardHtml = `
        <section class="review-decision-card">
          <h3>Decision</h3>
          ${activeFirestoreReview
            ? `<p>${nextStage
              ? `Approve this step to send the proposal to ${esc(nextStage.label)}.`
              : "Approve this step to complete the approval process."}</p>`
            : ""}
          <div class="decision-field-group">
            <label for="decisionNote">${activeFirestoreReview ? "Note to organizer, required when rejecting" : "Note to organizer, needed for Request changes or Reject"}</label>
            <textarea id="decisionNote" class="decision-textarea" placeholder="Provide feedback or specify required revisions..."></textarea>
          </div>

          ${activeFirestoreReview ? "" : `
              <div class="decision-field-group" id="decisionFileGroup">
                <label for="decisionFileSelect">If you request changes, which file?</label>
                <select id="decisionFileSelect" class="decision-select">
                  <option value="" disabled selected>Select document...</option>
                  ${fileOptions}
                </select>
              </div>
            `}

          <div id="decisionError" class="decision-validation-error" hidden></div>

          <div class="decision-buttons-row">
            <button type="button" class="btn-decision-approve" id="btnApprove">Approve</button>
            ${activeFirestoreReview ? "" : `
              <button type="button" class="btn-decision-revise" id="btnRevise">Request changes</button>
            `}
            <button type="button" class="btn-decision-reject" id="btnReject">Reject</button>
          </div>
        </section>
      `;
    } else if (activeStage && !["approved", "rejected", "cancelled"].includes(
      String(activeApproval.status || "").toLowerCase(),
    )) {
      decisionCardHtml = `
        <section class="review-decision-card">
          <h3>Decision</h3>
          <p>Waiting for the assigned approver for Step ${activeStage.step}: ${esc(activeStage.label)}.</p>
        </section>
      `;
    }

    // Admin Tools HTML (Remove approver who hasn't decided yet, Add approver not yet on chain)
    const canRemoveApprovers = sortedMembers.filter((m) => m.status !== "ok" && totalSteps > 1);
    const existingKeys = new Set(Object.keys(members));
    const availableToAdd = Object.entries(approverDirectory).filter(([k]) => !existingKeys.has(k));

    let adminToolsHtml = activeFirestoreReview ? "" : `
      <section class="admin-tools-card">
        <h4>Admin Tools</h4>
        <div style="font-size:13px; color:#57534e; margin-bottom:12px;">Manage approval chain steps for this event proposal.</div>

        <div class="admin-tools-approvers-list">
          ${canRemoveApprovers
            .map((m) => `
              <div class="admin-tool-row">
                <span>Step ${m.step}: <strong>${esc(m.label)}</strong> (${esc(m.status)})</span>
                <button type="button" class="btn-tool-remove" data-remove-key="${esc(m.key)}" data-remove-label="${esc(m.label)}">Remove</button>
              </div>
            `)
            .join("")}
        </div>

        ${
          availableToAdd.length > 0
            ? `
              <div class="admin-tools-add-row">
                <select id="addApproverSelect">
                  <option value="" disabled selected>Add another approver to chain...</option>
                  ${availableToAdd.map(([k, it]) => `<option value="${esc(k)}">${esc(it.label)} (Stage ${it.stage})</option>`).join("")}
                </select>
                <button type="button" class="btn-tool-add" id="btnAddApprover">Add to chain</button>
              </div>
            `
            : `<div style="font-size:12.5px; color:#78716c;">All available approver positions are included in this chain.</div>`
        }
      </section>
    `;

    root.innerHTML = `
      <div class="review-screen-container">
        <div class="review-screen-top-bar">
          <button type="button" class="btn-back-queue" id="btnBackToQueue">
            ← Back to queue
          </button>
        </div>

        <section class="review-header-card">
          <div class="review-title-row">${turnTagHtml}</div>
          <div class="student-event-content">${renderEventDetails(activeEvent, filesList)}</div>
        </section>

        <!-- Approval Tracker -->
        <section class="review-tracker-card">
          <h3>Approval Tracker</h3>
          <div class="admin-tracker-track" id="adminTrackerTrack">
            ${trackItemsHtml}
          </div>

          <div class="admin-notes-wrap">
            ${notesListHtml}
            ${nextLineHtml}
          </div>
        </section>

        <!-- Documents List -->
        <section class="review-docs-card">
          <h3>Attached Documents</h3>
          ${filesHtml}
        </section>

        <!-- Decision Card -->
        ${decisionCardHtml}

        <!-- Admin Tools -->
        ${adminToolsHtml}
      </div>
    `;

    // Hook Back Button
    root.querySelector("#btnBackToQueue")?.addEventListener("click", closeReviewScreen);

    // Scroll active step into view
    setTimeout(() => {
      const ownStepEl = root.querySelector(".admin-tracker-step.is-own");
      if (ownStepEl) {
        ownStepEl.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
      }
    }, 150);

    // Decision Handlers
    if (isMyTurn) {
      const btnApprove = root.querySelector("#btnApprove");
      const btnRevise = root.querySelector("#btnRevise");
      const btnReject = root.querySelector("#btnReject");
      const noteInput = root.querySelector("#decisionNote");
      const fileSelect = root.querySelector("#decisionFileSelect");
      const errorEl = root.querySelector("#decisionError");

      const handleDecision = async (decision) => {
        if (errorEl) errorEl.hidden = true;
        const note = (noteInput?.value || "").trim();
        const fileId = fileSelect?.value || "";

        if ((decision === "revise" || decision === "reject") && note.length < 3) {
          if (errorEl) {
            errorEl.textContent = "Please enter a note of at least 3 characters explaining your decision to the organizer.";
            errorEl.hidden = false;
          }
          noteInput?.focus();
          return;
        }

        if (decision === "revise" && !fileId) {
          if (errorEl) {
            errorEl.textContent = "Please select which attached document requires changes.";
            errorEl.hidden = false;
          }
          fileSelect?.focus();
          return;
        }

        const confirmMsg =
          decision === "approve"
            ? "Approve this proposal and advance to the next step?"
            : decision === "revise"
            ? "Request changes from the organizer for this proposal?"
            : "Reject this event proposal?";
        if (!confirm(confirmMsg)) return;

        // Disable buttons
        [btnApprove, btnRevise, btnReject].forEach((b) => {
          if (b) b.disabled = true;
        });

        try {
          let firestoreResult = null;
          if (activeFirestoreReview) {
            const user = auth?.currentUser;
            const stage = activeFirestoreReview
              ? getConfiguredFirestoreStages(activeEvent).find(
                  (candidate) => candidate.key === getCurrentFirestoreStage(activeEvent),
                )
              : getAccountStage() || resolveApprovalStage(currentAdminKey);
            const currentStageKey = getFirestoreCurrentStageKey(activeEvent);
            if (!db || !user || !stage) {
              throw new Error("Your administrator account could not be verified. Sign in again and retry.");
            }
            if (currentStageKey !== stage.key) {
              throw new Error("This proposal is no longer waiting at your approval stage. Refresh the queue and try again.");
            }
            if (
              isOrgAdviserReviewer(stage) &&
              getEventOrganizationCode(activeEvent) !==
                getCurrentAdminOrganizationCode()
            ) {
              throw new Error("This proposal is outside your assigned organization.");
            }

            if (decision === "revise") {
              if (!functions || !navigator.onLine) {
                throw new Error("Requesting changes is unavailable while the approval service is offline.");
              }
              const reviseResult = await httpsCallable(functions, "requestFirestoreEventRevision")({
                eventId: activeReviewEventId,
                note,
                fileId,
              });
              firestoreResult = reviseResult.data;
            } else {
              let backendError = null;
              if (functions && navigator.onLine) {
                try {
                  const callableName = decision === "approve"
                    ? "approveFirestoreEvent"
                    : "rejectFirestoreEvent";
                  const result = await httpsCallable(functions, callableName)({
                    eventId: activeReviewEventId,
                    ...(decision === "reject" ? { note } : {}),
                  });
                  firestoreResult = result.data;
                } catch (error) {
                  backendError = error;
                  console.warn(
                    `Cloud Function ${decision} failed; applying the decision directly in Firestore.`,
                    error,
                  );
                }
              }

              if (backendError || !functions || !navigator.onLine) {
                try {
                  firestoreResult = await applyFirestoreDecisionLocally(
                    activeReviewEventId,
                    decision,
                    note,
                    stage,
                    user,
                  );
                  firestoreResult.localFallback = true;
                } catch (fallbackError) {
                  console.error("Could not save the approval decision directly in Firestore:", fallbackError);
                  if (backendError) {
                    throw new Error(
                      `The approval service failed (${backendError.message || backendError}). ` +
                      `The Firestore fallback also failed: ${fallbackError.message || fallbackError}`,
                    );
                  }
                  throw fallbackError;
                }
              }
            }
          } else if (functions && navigator.onLine) {
            const decideFn = httpsCallable(functions, "decideApproval");
            await decideFn({
              eventId: activeReviewEventId,
              key: currentAdminKey,
              decision,
              note,
              fileId: decision === "revise" ? fileId : undefined,
            });
          }

          const toastMsg =
            decision === "approve"
              ? firestoreResult?.complete
                ? "Final approval completed. The event is now approved."
                : firestoreResult?.localFallback
                  ? "Approved. The proposal moved to the next reviewer and was saved directly."
                  : "Approved. The proposal moved to the next reviewer."
              : decision === "reject"
              ? firestoreResult?.localFallback
                ? "Proposal rejected and saved directly."
                : "Proposal rejected."
              : decision === "revise"
              ? "Changes requested. The proposal was marked for revision."
              : "Proposal rejected.";

          showToast(toastMsg);
          closeReviewScreen();
        } catch (err) {
          console.error("Could not process approval decision:", err);
          console.error("Approval decision context:", {
            eventId: activeReviewEventId,
            decision,
            code: err?.code || "unknown",
            message: err?.message || String(err),
            details: err?.details || null,
          });
          const errorCode = err?.code ? ` (${err.code})` : "";
          const errorMessage = err?.details?.message || err?.message || String(err);
          alert(`Could not process decision${errorCode}: ${errorMessage}`);
          [btnApprove, btnRevise, btnReject].forEach((b) => {
            if (b) b.disabled = false;
          });
        }
      };

      btnApprove?.addEventListener("click", () => handleDecision("approve"));
      btnRevise?.addEventListener("click", () => handleDecision("revise"));
      btnReject?.addEventListener("click", () => handleDecision("reject"));
    }

    // Admin Tools Handlers
    root.querySelectorAll("[data-remove-key]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const key = btn.dataset.removeKey;
        const label = btn.dataset.removeLabel || key;
        if (!confirm(`Are you sure you want to remove "${label}" from the approval chain?`)) return;

        btn.disabled = true;
        try {
          if (functions && navigator.onLine) {
            const removeFn = httpsCallable(functions, "removeApprover");
            await removeFn({ eventId: activeReviewEventId, key });
          }
          showToast(`Removed ${label} from chain.`);
        } catch (err) {
          alert("Could not remove approver: " + (err.message || err));
          btn.disabled = false;
        }
      });
    });

    const btnAddApprover = root.querySelector("#btnAddApprover");
    const addSelect = root.querySelector("#addApproverSelect");
    if (btnAddApprover && addSelect) {
      btnAddApprover.addEventListener("click", async () => {
        const key = addSelect.value;
        if (!key) return;

        btnAddApprover.disabled = true;
        try {
          if (functions && navigator.onLine) {
            const addFn = httpsCallable(functions, "addApprover");
            await addFn({ eventId: activeReviewEventId, key });
          }
          showToast(`Added ${approverDirectory[key]?.label || key} to chain.`);
        } catch (err) {
          alert("Could not add approver: " + (err.message || err));
          btnAddApprover.disabled = false;
        }
      });
    }
  }

  // Cleanup on leaving page
  window.addEventListener("beforeunload", () => {
    if (queueListenerRef) off(queueListenerRef);
    if (decisionsListenerRef) off(decisionsListenerRef);
    if (activeEventRef) off(activeEventRef);
    if (activeApprovalRef) off(activeApprovalRef);
    if (activeFirestoreEventUnsubscribe) activeFirestoreEventUnsubscribe();
  });
})();
