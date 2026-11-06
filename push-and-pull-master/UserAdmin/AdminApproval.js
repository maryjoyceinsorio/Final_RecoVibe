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
    event_head: { key: "event_head", label: "Event Head", stage: 1, defaultOn: true, required: true },
    vp_doc: { key: "vp_doc", label: "VP for Documentation", stage: 2, defaultOn: true, required: true },
    vp_ext: { key: "vp_ext", label: "VP for External", stage: 3, defaultOn: false, required: false, suggestIf: "outsideGuests" },
    org_pres: { key: "org_pres", label: "Org President", stage: 4, defaultOn: true, required: true },
    org_adv: { key: "org_adv", label: "Organization Adviser", stage: 5, defaultOn: true, required: true },
    sir_abelida: { key: "sir_abelida", label: "Laboratory Head, Property Custodian, Administrative Officer", stage: 6, defaultOn: true, required: false },
    hap: { key: "hap", label: "Head of Academic Programs, QAC Coordinator", stage: 7, defaultOn: true, required: false },
    osas: { key: "osas", label: "OSAS", stage: 8, defaultOn: true, required: true },
  };
  const APPROVAL_ACCOUNT_STAGES = [
    { key: "org_adv", label: "Organization Adviser", step: 1, required: true, aliases: ["org_adv", "org adviser", "organization adviser", "organization adviser review"] },
    { key: "sir_abelida", label: "Laboratory Head, Property Custodian, Administrative Officer", step: 2, required: false, aliases: ["sir_abelida", "laboratory head", "property custodian", "administrative officer"] },
    { key: "hap", label: "Head of Academic Programs, QAC Coordinator", step: 3, required: false, aliases: ["hap", "head of academic programs", "qac coordinator"] },
    { key: "osas", label: "OSAS", step: 4, required: true, aliases: ["osas"] },
  ];
  const DEFAULT_FIRESTORE_APPROVAL_STAGES = [
    { id: "stage-1", name: "Organization President", reviewer: "Organization President", required: true },
    { id: "stage-2", name: "Organization Adviser Review", reviewer: "Organization Adviser", required: true },
    { id: "stage-3", name: "OSAS Review", reviewer: "OSAS", required: true },
    { id: "stage-4", name: "Director Review", reviewer: "Director", required: true },
    { id: "stage-5", name: "Final Approval & Publishing", reviewer: "Authorized approver(s)", required: true },
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
  const getApprovalStageForProfile = (profile) => {
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
      profile?.accountNumber,
      profile?.accountNo,
      profile?.position,
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

  let queueListenerRef = null;
  let decisionsListenerRef = null;
  let activeEventRef = null;
  let activeApprovalRef = null;
  let firestorePendingEventsUnsubscribe = null;
  let activeFirestoreEventUnsubscribe = null;
  let toastTimer = null;
  let firestorePendingEventsTimeout = null;

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

    let timeoutId;
    try {
      const snapshot = await Promise.race([
        getDoc(doc(db, "adminUser", user.uid)),
        new Promise((_, reject) => {
          timeoutId = setTimeout(
            () => reject(new Error("Timed out loading the administrator profile.")),
            2500,
          );
        }),
      ]);
      if (!snapshot.exists()) return cachedProfile;
      return {
        ...cachedProfile,
        ...snapshot.data(),
        uid: user.uid,
        email: user.email || cachedProfile.email || "",
      };
    } finally {
      clearTimeout(timeoutId);
    }
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
    const stageKey = normalizeApprovalKey(stage.key);
    return entries.find(([id, source]) =>
      [id, source.key, source.id].some((value) => normalizeApprovalKey(value) === stageKey),
    )?.[1];
  }

  function getConfiguredFirestoreStages(event) {
    const entries = getFirestoreStageEntries(event);
    const sourceEntries = entries.length
      ? entries
      : DEFAULT_FIRESTORE_APPROVAL_STAGES.map((stage, index) => [stage.id, stage, index]);
    return sourceEntries
      .map(([id, source, sourceIndex], index) => ({
        key: String(source.key || source.id || id),
        label: String(source.name || source.label || source.reviewer || id),
        name: String(source.name || source.label || source.reviewer || id),
        reviewer: String(source.reviewer || source.name || source.label || ""),
        configuredStep: Number(source.step || source.stage) || (sourceIndex ?? index) + 1,
        sourceIndex: sourceIndex ?? index,
        required: source.required !== false,
        source,
      }))
      .filter((stage) => stage.required || entries.length)
      .sort((first, second) =>
        first.configuredStep - second.configuredStep || first.sourceIndex - second.sourceIndex,
      )
      .map((stage, index) => {
        const { configuredStep, sourceIndex, ...normalizedStage } = stage;
        return { ...normalizedStage, step: index + 1 };
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
    if (!stage) return null;
    const assignedUid = String(stage.source?.reviewerUid || stage.source?.uid || "");
    if (assignedUid && assignedUid !== String(auth?.currentUser?.uid || "")) return null;
    return stage.key;
  }

  async function applyFirestoreDecisionLocally(eventId, decision, note, stage, user) {
    const eventRef = doc(db, "events", eventId);
    return runTransaction(db, async (transaction) => {
      const snapshot = await transaction.get(eventRef);
      if (!snapshot.exists()) throw new Error("This proposal no longer exists.");

      const event = snapshot.data() || {};
      if (
        isOrgAdviserReviewer(stage) &&
        getEventOrganizationCode(event) !== getCurrentAdminOrganizationCode()
      ) {
        throw new Error("This proposal is outside your assigned organization.");
      }

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
      const assignedUid = String(stageSource?.reviewerUid || stageSource?.uid || "");
      if (assignedUid && assignedUid !== user.uid) {
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
          updates.status = "ready_to_publish";
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

    let storedProfile = {};
    try {
      storedProfile = JSON.parse(localStorage.getItem("recovibeAdminProfile") || "{}");
    } catch (error) {
      console.warn("Could not read the cached administrator profile:", error);
    }
    if (user && storedProfile.uid && storedProfile.uid !== user.uid) storedProfile = {};
    currentAdminProfile = storedProfile;
    if (user && db) {
      try {
        currentAdminProfile = await loadAdminProfileSafely(user, storedProfile);
      } catch (error) {
        console.warn("Could not load the signed-in administrator profile; using available account details:", error);
        currentAdminProfile = storedProfile;
      }
    }

    const profileRole = String(currentAdminProfile.role || currentAdminProfile.userRole || "")
      .trim()
      .toLowerCase()
      .replace(/[\s_-]+/g, "");
    if (user && profileRole && !["admin", "superadmin"].includes(profileRole)) {
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
    await loadApproverDirectory();
    findOrAssignAdminKey();
    const assignedStage = getAccountStage();
    // Check URL parameters for direct review link: ?review={eventId}
    const urlParams = new URLSearchParams(window.location.search);
    const reviewId = urlParams.get("review") || urlParams.get("event") || urlParams.get("id");

    subscribeFirestorePendingEvents();
    subscribeRecentDecisions();

    if (reviewId) {
      openReviewScreen(reviewId);
    } else {
      renderReviewQueue();
    }

    if (!auth?.currentUser) {
      subscribeReviewQueue();
      return;
    }

    try {
      if (!functions) {
        throw new Error("Approval access could not be verified.");
      }
      if (
        isOrgAdviserReviewer(assignedStage || { key: currentAdminKey }) &&
        !getCurrentAdminOrganizationCode()
      ) {
        throw new Error("Your adviser profile must have an organization assigned.");
      }
      await httpsCallable(functions, "syncApproverOrganization")({});
      subscribeReviewQueue();
    } catch (error) {
      queueItems = [];
      updateQueueBadge(0);
      console.error("Could not verify administrator proposal access:", error);
      showToast(error?.message || "Could not verify your proposal access.");
      if (!activeReviewEventId) renderReviewQueue();
    }
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
    if (isOrganizationAdviser && !assignedOrganizationCode) {
      firestorePendingEventsLoaded = true;
      firestorePendingEventsError = "Your adviser profile must have an organization assigned before proposals can be loaded.";
      if (!activeReviewEventId) renderReviewQueue();
      return;
    }
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
      if (isOrganizationAdviser) {
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
            firestorePendingEvents = pendingEvents.flatMap((event) => {
              if (
                isOrganizationAdviser &&
                getEventOrganizationCode(event) !== assignedOrganizationCode
              ) return [];
              const currentStageKey = getFirestoreCurrentStageKey(event);
              const currentStage = getConfiguredFirestoreStages(event)
                .find((stage) => stage.key === currentStageKey);
              const assignedUid = String(currentStage?.source?.reviewerUid || currentStage?.source?.uid || "");
              if (
                !currentStage ||
                (assignedUid && assignedUid !== String(auth?.currentUser?.uid || ""))
              ) return [];
              return [{
                ...event,
                currentApprovalStage: currentStageKey,
                pipelineStatus: "action-required",
              }];
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
    let timeoutId;
    try {
      const snap = await Promise.race([
        get(ref(rtdb, "approverDirectory")),
        new Promise((_, reject) => {
          timeoutId = setTimeout(
            () => reject(new Error("Timed out loading the approver directory.")),
            1500,
          );
        }),
      ]);
      const data = snap.val();
      if (data && typeof data === "object") {
        approverDirectory = { ...APPROVER_DIRECTORY_DEFAULTS, ...data };
      }
    } catch (err) {
      console.warn("Could not load approver directory:", err);
    } finally {
      clearTimeout(timeoutId);
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
            const currentStage = getStageLabel(event.currentApprovalStage);
            return `
              <article class="queue-card queue-card--${incoming ? "incoming" : "action"}" data-firestore-event-id="${esc(event.id)}" tabindex="0" aria-label="Open approval tracker for ${esc(eventName)}">
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
                  <button type="button" class="btn-queue-review" data-action="review-firestore" data-id="${esc(event.id)}">${incoming ? "View tracker" : "Review proposal"}</button>
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
              : `<section class="approval-pipeline-group" aria-label="Proposals requiring a decision">
                  <div class="approval-pipeline-heading">
                    <span class="approval-pipeline-count">${actionableFirestoreEvents.length}</span>
                  </div>
                  ${renderFirestoreProposalCards(actionableFirestoreEvents, false)}
                </section>
                <section class="approval-pipeline-group approval-pipeline-group--incoming" aria-label="Incoming proposals">
                  <div class="approval-pipeline-heading">
                    <span class="approval-pipeline-count">${incomingFirestoreEvents.length}</span>
                  </div>
                  ${renderFirestoreProposalCards(incomingFirestoreEvents, true)}
                </section>`
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
    if (activeFirestoreEventUnsubscribe) {
      activeFirestoreEventUnsubscribe();
      activeFirestoreEventUnsubscribe = null;
    }
    activeFirestoreReview = false;
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

  function openFirestoreProposalReview(eventId) {
    const event = firestorePendingEvents.find((item) => item.id === eventId);
    if (!event || !db) return;
    if (activeEventRef) off(activeEventRef);
    if (activeApprovalRef) off(activeApprovalRef);
    if (activeFirestoreEventUnsubscribe) activeFirestoreEventUnsubscribe();

    activeReviewEventId = eventId;
    activeFirestoreReview = true;
    window.history.pushState(null, "", `AdminApproval.html?review=${encodeURIComponent(eventId)}`);

    const renderFirestoreEvent = (eventData) => {
      if (
        isOrgAdviserReviewer(getAccountStage() || { key: currentAdminKey }) &&
        getEventOrganizationCode(eventData) !==
          getCurrentAdminOrganizationCode()
      ) {
        showToast("This proposal is outside your assigned organization.");
        closeReviewScreen();
        return;
      }
      activeEvent = {
        ...eventData,
        name: eventData.eventName || eventData.name || eventData.title || "Untitled Event",
        venue: eventData.venue || eventData.location || eventData.venueName || "Venue TBA",
        startAt: eventData.startAt || eventData.date || eventData.dateStart || "Date TBA",
        source: eventData.source || eventData.eventSource || eventData.campus || eventData.office || "Firestore submission",
      };
      activeApproval = getFirestoreApproval(eventData);
      renderReviewScreen();
    };
    renderFirestoreEvent(event);
    activeFirestoreEventUnsubscribe = onSnapshot(
      doc(db, "events", eventId),
      (snapshot) => {
        if (!snapshot.exists()) {
          activeEvent = null;
          activeApproval = null;
          renderReviewScreen();
          return;
        }
        renderFirestoreEvent(snapshot.data());
      },
      (error) => {
        console.error("Could not load Firestore proposal details:", error);
        showToast("Could not refresh this proposal. Check your connection.");
      },
    );
  }

  function closeReviewScreen() {
    if (activeFirestoreEventUnsubscribe) {
      activeFirestoreEventUnsubscribe();
      activeFirestoreEventUnsubscribe = null;
    }
    activeFirestoreReview = false;
    activeReviewEventId = null;
    activeEvent = null;
    activeApproval = null;

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
          <div class="admin-loading">Loading proposal details...</div>
        </div>
      `;
      root.querySelector("#btnBackToQueue")?.addEventListener("click", closeReviewScreen);
      return;
    }

    const members = activeApproval.members || {};
    const sortedMembers = Object.values(members).sort(
      (a, b) => (a.stage || 0) - (b.stage || 0) || (a.step || 0) - (b.step || 0)
    );

    // Identify current admin's member entry
    const firestoreStageKey = activeFirestoreReview
      ? getCurrentFirestoreStage(activeEvent)
      : null;
    const myMember = members[activeFirestoreReview ? firestoreStageKey : currentAdminKey];
    const isMyTurn = myMember && myMember.status === "review" && activeApproval.status !== "revision" &&
      (!activeFirestoreReview ||
        Boolean(firestoreStageKey));

    // Header Tag
    let turnTagHtml = "";
    if (isMyTurn) {
      turnTagHtml = `<span class="turn-badge">Your turn: Step ${myMember.step}</span>`;
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
      const isOwnStep = m.key === (activeFirestoreReview ? firestoreStageKey : currentAdminKey);
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
      const nextStage = sortedMembers.find((member) => Number(member.step) > Number(myMember.step));
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
