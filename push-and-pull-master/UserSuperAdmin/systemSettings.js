import {
  addDoc,
  collection,
  doc,
  onSnapshot,
  serverTimestamp,
  setDoc,
  updateDoc,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { db, isFirebaseConfigured } from "../UserStudent/firebaseConfig.js";

(() => {
  "use strict";

  const settingsRef = db ? doc(db, "system_settings", "global_config") : null;

  // General settings controls
  const mainOrgSelect = document.getElementById("setting-main-org");
  const maxUploadInput = document.getElementById("setting-max-upload");
  const allowedDocsInput = document.getElementById("setting-allowed-docs");

  // Organization directory controls
  const addOrgBtn = document.getElementById("add-organization-btn");
  const orgListEl = document.getElementById("organization-directory-list");

  // Approval stages controls
  const stagesList = document.getElementById("approval-stages-list");
  const addStageBtn = document.getElementById("add-stage-btn");
  const saveStagesBtn = document.getElementById("save-stages-btn");
  const saveStagesBottomBtn = document.getElementById("save-stages-bottom-btn");
  const saveGeneralBtn = document.getElementById("save-general-btn");
  const stagesErrorEl = document.getElementById("approval-stages-error");

  // Confirmation dialog controls
  const confirmDialog = document.getElementById("settings-confirm-dialog");
  const confirmCancelBtn = document.getElementById("settings-confirm-cancel-btn");
  const confirmCloseBtn = document.getElementById("settings-confirm-close-btn");
  const confirmYesBtn = document.getElementById("settings-confirm-yes-btn");
  const statusMessage = document.getElementById("settings-status");

  // Access and registration controls
  const registrationToggle = document.getElementById("toggle-registration");
  const loginToggle = document.getElementById("toggle-login");
  const userLoginBadge = document.getElementById("badge-user-login");
  const eventRegBadge = document.getElementById("badge-event-registration");
  const modal = document.getElementById("settings-modal-backdrop");
  const modalForm = document.getElementById("settings-modal-form");
  const modalTitle = document.getElementById("settings-modal-title");
  const itemField = document.getElementById("settings-item-field");
  const itemLabel = document.getElementById("settings-item-label");
  const itemInput = document.getElementById("settings-item-input");
  const itemList = document.getElementById("settings-item-list");
  const submitButton = document.getElementById("settings-item-submit");

  const defaultOrganizations = [
    { code: "IBITS", name: "Information Technology and Business Intelligence Society", adviserEmail: "" },
    { code: "ACES", name: "Association of Computer Engineering Students", adviserEmail: "" },
    { code: "CSC", name: "College Student Council", adviserEmail: "" },
  ];

  const defaultApprovalStages = [
    {
      id: "stage-1",
      name: "Organization Adviser",
      reviewer: "Organization Adviser",
      reviewerEmail: "",
      required: true,
    },
    {
      id: "stage-2",
      name: "Laboratory Head, Property Custodian, Administrative Officer",
      reviewer: "Laboratory Head, Property Custodian, Administrative Officer",
      reviewerEmail: "",
      required: true,
    },
    {
      id: "stage-3",
      name: "Head of Academic Programs, QAC Coordinator (HAP)",
      reviewer: "Head of Academic Programs, QAC Coordinator (HAP)",
      reviewerEmail: "",
      required: true,
    },
    {
      id: "stage-4",
      name: "OSAS",
      reviewer: "OSAS",
      reviewerEmail: "",
      required: true,
    },
  ];

  const defaultSettings = {
    mainOrganization: "IBITS",
    maxUploadSizeMb: 15,
    allowedDocumentTypes: "PDF, DOCX, JPG, PNG",
    organizations: defaultOrganizations,
    approvalStages: defaultApprovalStages,
    registrationEnabled: true,
    loginEnabled: true,
    venues: [],
    categories: [],
    eventSources: [],
  };

  let currentSettings = { ...defaultSettings };
  let workingOrganizations = JSON.parse(JSON.stringify(defaultOrganizations));
  let workingApprovalStages = JSON.parse(JSON.stringify(defaultApprovalStages));
  let workingMainOrg = "IBITS";

  let settingsReady = false;
  let initializingDocument = false;
  let backfillingDefaults = null;
  let pendingSettingsSync = null;
  let unsubscribeSettings = null;
  const pendingSettingsKey = "recovibe_system_settings_pending";

  // Cache loading
  try {
    const cachedSettings = localStorage.getItem("recovibeSystemSettings");
    if (cachedSettings) {
      currentSettings = normalizedSettings(JSON.parse(cachedSettings));
      workingApprovalStages = JSON.parse(JSON.stringify(currentSettings.approvalStages));
      workingOrganizations = JSON.parse(JSON.stringify(currentSettings.organizations));
      workingMainOrg = currentSettings.mainOrganization;
    }

    const cachedStages = localStorage.getItem("recovibe_approval_stages");
    if (cachedStages) {
      const parsed = JSON.parse(cachedStages);
      if (Array.isArray(parsed) && parsed.length > 0) {
        workingApprovalStages = normalizeApprovalStages(parsed);
        currentSettings.approvalStages = workingApprovalStages;
      }
    }
    const cachedOrgs = localStorage.getItem("recovibe_organizations");
    if (cachedOrgs) {
      const parsed = JSON.parse(cachedOrgs);
      if (Array.isArray(parsed) && parsed.length > 0) {
        workingOrganizations = normalizeOrganizations(parsed);
        currentSettings.organizations = workingOrganizations;
      }
    }
    const cachedMainOrg = localStorage.getItem("recovibe_main_org");
    if (cachedMainOrg) {
      workingMainOrg = cachedMainOrg;
      currentSettings.mainOrganization = cachedMainOrg;
    }
    const cachedMaxUpload = localStorage.getItem("recovibe_max_upload_size");
    if (cachedMaxUpload) {
      currentSettings.maxUploadSizeMb = Number(cachedMaxUpload) || 15;
    }
    const cachedAllowedDocs = localStorage.getItem("recovibe_allowed_doc_types");
    if (cachedAllowedDocs) {
      currentSettings.allowedDocumentTypes = cachedAllowedDocs;
    }
  } catch (error) {
    console.warn("Could not restore cached system settings:", error);
  }

  function showMessage(message, isError = false) {
    if (!statusMessage) return;
    statusMessage.textContent = message;
    statusMessage.dataset.state = isError ? "error" : "success";
    statusMessage.hidden = false;
    setTimeout(() => {
      if (statusMessage) statusMessage.hidden = true;
    }, 4500);
  }

  function flagValidationError(inputElement, errorMessage) {
    if (inputElement) {
      inputElement.classList.add("is-invalid");
      try {
        inputElement.scrollIntoView({ behavior: "smooth", block: "center" });
      } catch (_) {}
      try {
        inputElement.focus();
      } catch (_) {}
    }
    if (stagesErrorEl) {
      stagesErrorEl.textContent = errorMessage;
      stagesErrorEl.hidden = false;
    }
    showMessage(errorMessage, true);
  }

  function actorTag() {
    return document.querySelector(".account-badge")?.textContent.trim() || "SA1";
  }

  function actorIdentifier() {
    const name =
      document.getElementById("superadmin-name")?.textContent.trim() ||
      "Super Admin";
    return `${actorTag()} – ${name}`;
  }

  async function appendAudit(action) {
    if (!db) return;
    await addDoc(collection(db, "audit_logs"), {
      timestamp: serverTimestamp(),
      user: actorIdentifier(),
      action,
      category: "System Settings",
    });
  }

  function setReady(ready) {
    settingsReady = ready;
    if (mainOrgSelect) mainOrgSelect.disabled = !ready;
    if (maxUploadInput) maxUploadInput.disabled = !ready;
    if (allowedDocsInput) allowedDocsInput.disabled = !ready;
    if (addOrgBtn) addOrgBtn.disabled = !ready;
    if (addStageBtn) addStageBtn.disabled = !ready;
    if (saveStagesBtn) saveStagesBtn.disabled = !ready;
    if (saveStagesBottomBtn) saveStagesBottomBtn.disabled = !ready;
    if (saveGeneralBtn) saveGeneralBtn.disabled = !ready;

    if (orgListEl) {
      orgListEl.querySelectorAll("input, button").forEach((el) => {
        el.disabled = !ready;
      });
    }
    if (stagesList) {
      stagesList.querySelectorAll("input, button").forEach((el) => {
        el.disabled = !ready;
      });
    }
    if (registrationToggle) registrationToggle.disabled = !ready;
    if (loginToggle) loginToggle.disabled = !ready;
  }

  function escapeHtml(str) {
    return String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function normalizeOrganizations(rawList) {
    if (!Array.isArray(rawList) || !rawList.length) {
      return JSON.parse(JSON.stringify(defaultOrganizations));
    }
    const defaultNameMap = {
      IBITS: "Information Technology and Business Intelligence Society",
      ACES: "Association of Computer Engineering Students",
      CSC: "College Student Council",
      JPCS: "Junior Philippine Computer Society",
      JPIA: "Junior Philippine Institute of Accountants",
    };
    return rawList.map((item) => {
      if (typeof item === "string") {
        return {
          code: item.trim(),
          name: defaultNameMap[item.trim()] || `${item.trim()} Student Organization`,
          adviserEmail: "",
        };
      }
      return {
        code: item && item.code ? String(item.code).trim() : (item.name ? String(item.name).trim() : "ORG"),
        name: item && item.name && item.name !== item.code ? String(item.name).trim() : (defaultNameMap[item?.code] || String(item?.name || item?.code || "Organization")),
        adviserEmail: String(item?.adviserEmail || item?.adviser?.email || "").trim().toLowerCase(),
      };
    });
  }

  function normalizeApprovalStages(rawStages) {
    let stages = defaultApprovalStages;
    if (Array.isArray(rawStages) && rawStages.length > 0) {
      stages = rawStages.map((stage, idx) => ({
        id: stage && stage.id ? String(stage.id) : `stage-${idx + 1}`,
        name: stage && typeof stage.name === "string" ? stage.name : `Stage ${idx + 1}`,
        reviewer: stage && typeof stage.reviewer === "string" ? stage.reviewer : "",
        reviewerEmail: String(stage?.reviewerEmail || stage?.email || "").trim().toLowerCase(),
        required: stage && typeof stage.required === "boolean" ? stage.required : true,
      }));
    }
    return stages;
  }

  function cacheSettings(settings, markPending = false) {
    try {
      localStorage.setItem("recovibeSystemSettings", JSON.stringify(settings));
      localStorage.setItem("recovibe_approval_stages", JSON.stringify(settings.approvalStages));
      localStorage.setItem("recovibe_organizations", JSON.stringify(settings.organizations));
      localStorage.setItem("recovibe_main_org", settings.mainOrganization || "");
      localStorage.setItem("recovibe_max_upload_size", String(settings.maxUploadSizeMb));
      localStorage.setItem("recovibe_allowed_doc_types", settings.allowedDocumentTypes || "");
      if (markPending) {
        const savedAt = Date.now();
        localStorage.setItem(pendingSettingsKey, JSON.stringify({
          settings,
          savedAt,
          revision: `${savedAt}-${Math.random().toString(36).slice(2)}`,
        }));
      }
      return true;
    } catch (error) {
      console.error("Could not cache system settings locally:", error);
      return false;
    }
  }

  function applySettingsToControls(settings) {
    currentSettings = normalizedSettings(settings);
    workingMainOrg = currentSettings.mainOrganization;
    workingOrganizations = JSON.parse(JSON.stringify(currentSettings.organizations));
    workingApprovalStages = JSON.parse(JSON.stringify(currentSettings.approvalStages));
    if (maxUploadInput) maxUploadInput.value = currentSettings.maxUploadSizeMb;
    if (allowedDocsInput) allowedDocsInput.value = currentSettings.allowedDocumentTypes;
    if (registrationToggle) {
      registrationToggle.checked = currentSettings.registrationEnabled !== false;
      updateToggleBadge("registration", currentSettings.registrationEnabled !== false);
    }
    if (loginToggle) {
      loginToggle.checked = currentSettings.loginEnabled !== false;
      updateToggleBadge("login", currentSettings.loginEnabled !== false);
    }
    renderOrganizations();
    renderApprovalStages();
  }

  async function syncPendingSettings() {
    if (!settingsRef || !db || !navigator.onLine) return false;
    if (pendingSettingsSync) return pendingSettingsSync;

    pendingSettingsSync = (async () => {
      let synced = false;
      while (navigator.onLine) {
        let pending;
        try {
          pending = JSON.parse(localStorage.getItem(pendingSettingsKey) || "null");
        } catch (error) {
          console.error("Could not read pending system settings:", error);
          return false;
        }
        if (!pending?.settings) return synced;

        const revision = pending.revision || pending.savedAt;
        await setDoc(settingsRef, {
          ...normalizedSettings(pending.settings),
          updatedAt: serverTimestamp(),
          updatedBy: actorIdentifier(),
        }, { merge: true });
        synced = true;

        let latestPending;
        try {
          latestPending = JSON.parse(localStorage.getItem(pendingSettingsKey) || "null");
        } catch (error) {
          console.error("Could not verify pending system settings:", error);
          return false;
        }
        if (!latestPending?.settings) return true;
        if ((latestPending.revision || latestPending.savedAt) !== revision) continue;

        localStorage.removeItem(pendingSettingsKey);
        applySettingsToControls(pending.settings);
        cacheSettings(currentSettings);
        showMessage("Pending system settings synced to the cloud.");
        return true;
      }
      return synced;
    })();

    try {
      return await pendingSettingsSync;
    } catch (error) {
      console.error("Could not sync pending system settings:", error);
      showMessage("Changes are saved locally; cloud sync is still pending.", true);
      return false;
    } finally {
      pendingSettingsSync = null;
    }
  }

  window.addEventListener("online", () => {
    void syncPendingSettings();
  });

  function normalizedSettings(data) {
    return {
      mainOrganization: typeof data.mainOrganization === "string" ? data.mainOrganization : "IBITS",
      maxUploadSizeMb: typeof data.maxUploadSizeMb === "number" ? data.maxUploadSizeMb : 15,
      allowedDocumentTypes: typeof data.allowedDocumentTypes === "string" ? data.allowedDocumentTypes : "PDF, DOCX, JPG, PNG",
      organizations: normalizeOrganizations(data.organizations),
      approvalStages: normalizeApprovalStages(data.approvalStages),
      registrationEnabled: typeof data.registrationEnabled === "boolean" ? data.registrationEnabled : true,
      loginEnabled: typeof data.loginEnabled === "boolean" ? data.loginEnabled : true,
      venues: Array.isArray(data.venues) ? data.venues.filter((item) => typeof item === "string") : [],
      categories: Array.isArray(data.categories) ? data.categories.filter((item) => typeof item === "string") : [],
      eventSources: Array.isArray(data.eventSources) ? data.eventSources.filter((item) => typeof item === "string") : [],
    };
  }

  // --- Render Functions ---

  function renderMainOrgSelect() {
    if (!mainOrgSelect) return;
    const currentVal = mainOrgSelect.value || workingMainOrg || "IBITS";
    mainOrgSelect.innerHTML = "";

    const validCodes = (workingOrganizations || [])
      .map((o) => (o.code || "").trim())
      .filter(Boolean);

    if (!validCodes.length) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "No organizations available";
      mainOrgSelect.appendChild(opt);
      workingMainOrg = "";
      return;
    }

    validCodes.forEach((code) => {
      const opt = document.createElement("option");
      opt.value = code;
      opt.textContent = code;
      if (code === currentVal || code === workingMainOrg) {
        opt.selected = true;
      }
      mainOrgSelect.appendChild(opt);
    });

    if (validCodes.includes(workingMainOrg)) {
      mainOrgSelect.value = workingMainOrg;
    } else {
      mainOrgSelect.value = validCodes[0];
      workingMainOrg = validCodes[0];
    }
  }

  function renderOrganizations() {
    if (!orgListEl) return;
    orgListEl.replaceChildren();

    const orgs = workingOrganizations || [];
    if (!orgs.length) {
      const emptyDiv = document.createElement("div");
      emptyDiv.className = "settings-stage-empty";
      emptyDiv.textContent = "No organizations in directory. Click '+ Add organization' above to add one.";
      orgListEl.appendChild(emptyDiv);
      renderMainOrgSelect();
      return;
    }

    orgs.forEach((org, index) => {
      const row = document.createElement("div");
      row.className = "settings-org-row";
      row.dataset.index = String(index);

      const initialChar = org.code && org.code.trim() ? org.code.trim()[0].toUpperCase() : "?";

      row.innerHTML = `
        <span class="settings-org-badge">${escapeHtml(initialChar)}</span>
        <input
          type="text"
          class="settings-org-code-input"
          value="${escapeHtml(org.code || "")}"
          placeholder="Code"
          aria-label="Organization Code"
          ${!settingsReady ? "disabled" : ""}
        />
        <input
          type="text"
          class="settings-org-name-input"
          value="${escapeHtml(org.name || "")}"
          placeholder="Full Organization Name"
          aria-label="Full Organization Name"
          ${!settingsReady ? "disabled" : ""}
        />
        <input
          type="email"
          class="settings-org-adviser-input"
          value="${escapeHtml(org.adviserEmail || "")}"
          placeholder="Adviser email"
          aria-label="${escapeHtml(org.code || "Organization")} adviser email"
          ${!settingsReady ? "disabled" : ""}
        />
        <button class="settings-org-remove-btn" type="button" aria-label="Remove ${escapeHtml(org.code || "organization")}" ${!settingsReady ? "disabled" : ""}>
          ✕
        </button>
      `;

      const badge = row.querySelector(".settings-org-badge");
      const codeInput = row.querySelector(".settings-org-code-input");
      const nameInput = row.querySelector(".settings-org-name-input");
      const adviserInput = row.querySelector(".settings-org-adviser-input");
      const removeBtn = row.querySelector(".settings-org-remove-btn");

      if (codeInput) {
        codeInput.addEventListener("input", (e) => {
          org.code = e.target.value.trim();
          const char = org.code ? org.code[0].toUpperCase() : "?";
          if (badge) badge.textContent = char;
          codeInput.classList.remove("is-invalid");
          document.querySelectorAll(".settings-org-code-input.is-invalid").forEach((el) => el.classList.remove("is-invalid"));
          if (stagesErrorEl) stagesErrorEl.hidden = true;
          renderMainOrgSelect();
        });
      }

      if (nameInput) {
        nameInput.addEventListener("input", (e) => {
          org.name = e.target.value;
          nameInput.classList.remove("is-invalid");
          document.querySelectorAll(".settings-org-name-input.is-invalid").forEach((el) => el.classList.remove("is-invalid"));
          if (stagesErrorEl) stagesErrorEl.hidden = true;
        });
      }

      if (adviserInput) {
        adviserInput.addEventListener("input", (e) => {
          org.adviserEmail = e.target.value.trim().toLowerCase();
          adviserInput.classList.remove("is-invalid");
          if (stagesErrorEl) stagesErrorEl.hidden = true;
        });
      }

      if (removeBtn) {
        removeBtn.addEventListener("click", () => {
          removeOrganization(index);
        });
      }

      orgListEl.appendChild(row);
    });

    renderMainOrgSelect();
  }

  function addOrganization() {
    if (!settingsReady) return;
    workingOrganizations.push({ code: "", name: "", adviserEmail: "" });
    renderOrganizations();
    if (orgListEl) {
      const lastRow = orgListEl.lastElementChild;
      const codeInp = lastRow?.querySelector(".settings-org-code-input");
      if (codeInp) {
        codeInp.focus();
      }
    }
    if (stagesErrorEl) stagesErrorEl.hidden = true;
  }

  function removeOrganization(index) {
    if (!settingsReady) return;
    if (index < 0 || index >= workingOrganizations.length) return;
    workingOrganizations.splice(index, 1);
    renderOrganizations();
    if (stagesErrorEl) stagesErrorEl.hidden = true;
  }

  function renderApprovalStages() {
    if (!stagesList) return;
    stagesList.replaceChildren();

    const stages = workingApprovalStages || [];
    if (!stages.length) {
      const emptyDiv = document.createElement("div");
      emptyDiv.className = "settings-stage-empty";
      emptyDiv.textContent = "No approval stages configured. Click '+ Add stage' above to add one.";
      stagesList.appendChild(emptyDiv);
      return;
    }

    stages.forEach((stage, index) => {
      const isFirst = index === 0;
      const isLast = index === stages.length - 1;

      const card = document.createElement("div");
      card.className = "settings-stage-card";
      card.dataset.stageId = stage.id;
      card.dataset.index = String(index);

      card.innerHTML = `
        <div class="settings-stage-reorder">
          <button class="settings-reorder-btn settings-reorder-up" type="button" aria-label="Move stage up" ${isFirst || !settingsReady ? "disabled" : ""}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v16m0-16l-5 5m5-5l5 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
          <span class="settings-stage-number">${index + 1}</span>
          <button class="settings-reorder-btn settings-reorder-down" type="button" aria-label="Move stage down" ${isLast || !settingsReady ? "disabled" : ""}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20V4m0 16l-5-5m5 5l5-5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
        </div>

        <div class="settings-stage-body">
          <div class="settings-stage-col-name">
            <label class="settings-stage-field-label">
              <span>Stage name</span>
              <input
                type="text"
                class="settings-stage-input settings-stage-name-input"
                data-field="name"
                value="${escapeHtml(stage.name)}"
                placeholder="Stage name"
                aria-label="Stage name"
                ${!settingsReady ? "disabled" : ""}
              />
            </label>
            <label class="settings-stage-required-label">
              <input
                type="checkbox"
                class="settings-stage-required-checkbox"
                ${stage.required ? "checked" : ""}
                ${!settingsReady ? "disabled" : ""}
              />
              <span>Required</span>
            </label>
          </div>

          <div class="settings-stage-col-reviewer">
            <label class="settings-stage-field-label">
              <span>Reviewer display name</span>
              <input
                type="text"
                class="settings-stage-input settings-stage-reviewer-input"
                data-field="reviewer"
                value="${escapeHtml(stage.reviewer)}"
                placeholder="Reviewer name"
                aria-label="Reviewer display name"
                ${!settingsReady ? "disabled" : ""}
              />
            </label>
            <label class="settings-stage-field-label">
              <span>Reviewer account email (optional)</span>
              <input
                type="email"
                class="settings-stage-input settings-stage-reviewer-email-input"
                data-field="reviewerEmail"
                value="${escapeHtml(stage.reviewerEmail || "")}"
                placeholder="name@example.com"
                aria-label="Reviewer account email for ${escapeHtml(stage.name)} (optional)"
                ${!settingsReady ? "disabled" : ""}
              />
            </label>
          </div>
        </div>

        <button class="settings-stage-remove-btn" type="button" aria-label="Remove ${escapeHtml(stage.name)}" ${!settingsReady ? "disabled" : ""}>
          ✕
        </button>
      `;

      const upBtn = card.querySelector(".settings-reorder-up");
      const downBtn = card.querySelector(".settings-reorder-down");
      const nameInput = card.querySelector(".settings-stage-name-input");
      const reviewerInput = card.querySelector(".settings-stage-reviewer-input");
      const reviewerEmailInput = card.querySelector(".settings-stage-reviewer-email-input");
      const reqCheckbox = card.querySelector(".settings-stage-required-checkbox");
      const removeBtn = card.querySelector(".settings-stage-remove-btn");

      if (upBtn) {
        upBtn.addEventListener("click", () => moveStage(index, -1));
      }
      if (downBtn) {
        downBtn.addEventListener("click", () => moveStage(index, 1));
      }
      if (nameInput) {
        nameInput.addEventListener("input", (e) => {
          stage.name = e.target.value;
          nameInput.classList.remove("is-invalid");
          document.querySelectorAll(".settings-stage-name-input.is-invalid").forEach((el) => el.classList.remove("is-invalid"));
          if (stagesErrorEl) stagesErrorEl.hidden = true;
        });
      }
      if (reviewerInput) {
        reviewerInput.addEventListener("input", (e) => {
          stage.reviewer = e.target.value;
          reviewerInput.classList.remove("is-invalid");
          document.querySelectorAll(".settings-stage-reviewer-input.is-invalid").forEach((el) => el.classList.remove("is-invalid"));
          if (stagesErrorEl) stagesErrorEl.hidden = true;
        });
      }
      if (reviewerEmailInput) {
        reviewerEmailInput.addEventListener("input", (e) => {
          stage.reviewerEmail = e.target.value.trim().toLowerCase();
          reviewerEmailInput.classList.remove("is-invalid");
          if (stagesErrorEl) stagesErrorEl.hidden = true;
        });
      }
      if (reqCheckbox) {
        reqCheckbox.addEventListener("change", (e) => {
          stage.required = e.target.checked;
          document.querySelectorAll(".settings-stage-required-checkbox.is-invalid").forEach((el) => el.classList.remove("is-invalid"));
          if (stagesErrorEl) stagesErrorEl.hidden = true;
        });
      }
      if (removeBtn) {
        removeBtn.addEventListener("click", () => removeStage(index));
      }

      stagesList.appendChild(card);
    });
  }

  function addApprovalStage() {
    if (!settingsReady) return;
    const newIndex = workingApprovalStages.length + 1;
    const newStage = {
      id: `stage-${Date.now()}`,
      name: `Stage ${newIndex}`,
      reviewer: "",
      reviewerEmail: "",
      required: true,
    };
    workingApprovalStages.push(newStage);
    renderApprovalStages();
    if (stagesList) {
      const addedInput = stagesList.querySelector(`[data-stage-id="${newStage.id}"] .settings-stage-name-input`);
      if (addedInput) {
        addedInput.focus();
        addedInput.select();
      }
    }
    if (stagesErrorEl) stagesErrorEl.hidden = true;
  }

  function removeStage(index) {
    if (!settingsReady) return;
    if (index < 0 || index >= workingApprovalStages.length) return;
    workingApprovalStages.splice(index, 1);
    renderApprovalStages();
    if (stagesErrorEl) stagesErrorEl.hidden = true;
  }

  function moveStage(index, delta) {
    if (!settingsReady) return;
    const targetIndex = index + delta;
    if (targetIndex < 0 || targetIndex >= workingApprovalStages.length) return;
    const moved = workingApprovalStages[index];
    workingApprovalStages[index] = workingApprovalStages[targetIndex];
    workingApprovalStages[targetIndex] = moved;
    renderApprovalStages();
  }

  // --- Save Validation and Confirmation ---

  function handleSaveSettingsClick() {
    if (!settingsReady) return;
    if (stagesErrorEl) {
      stagesErrorEl.hidden = true;
      stagesErrorEl.textContent = "";
    }

    document.querySelectorAll(".is-invalid").forEach((el) => el.classList.remove("is-invalid"));

    // 1. Validate Organizations Directory first
    if (!workingOrganizations || !workingOrganizations.length) {
      flagValidationError(addOrgBtn, "At least one organization is required in the directory.");
      return;
    }

    for (let i = 0; i < workingOrganizations.length; i++) {
      const o = workingOrganizations[i];
      const row = orgListEl?.querySelector(`[data-index="${i}"]`);
      const code = (o.code || "").trim();
      const name = (o.name || "").trim();

      if (!code) {
        const inp = row?.querySelector(".settings-org-code-input");
        flagValidationError(inp, `Please enter an organization code for Row ${i + 1}.`);
        return;
      }
      if (code.length > 25) {
        const inp = row?.querySelector(".settings-org-code-input");
        flagValidationError(inp, `Organization code "${code}" exceeds the 25-character limit.`);
        return;
      }
      if (!name) {
        const inp = row?.querySelector(".settings-org-name-input");
        flagValidationError(inp, `Please enter an organization name for "${code}".`);
        return;
      }
      const adviserEmail = String(o.adviserEmail || "").trim();
      if (adviserEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adviserEmail)) {
        const inp = row?.querySelector(".settings-org-adviser-input");
        flagValidationError(inp, `Enter a valid adviser email for "${code}", or leave it blank.`);
        return;
      }
    }

    // Check duplicate organization codes (case-insensitive)
    const seenOrgCodes = new Map();
    for (let i = 0; i < workingOrganizations.length; i++) {
      const codeKey = (workingOrganizations[i].code || "").trim().toLowerCase();
      if (seenOrgCodes.has(codeKey)) {
        const firstIdx = seenOrgCodes.get(codeKey);
        const row = orgListEl?.querySelector(`[data-index="${i}"]`);
        const firstRow = orgListEl?.querySelector(`[data-index="${firstIdx}"]`);
        const inp = row?.querySelector(".settings-org-code-input");
        firstRow?.querySelector(".settings-org-code-input")?.classList.add("is-invalid");
        flagValidationError(
          inp,
          `Duplicate organization code "${workingOrganizations[i].code.trim()}". Each organization must have a unique code.`
        );
        return;
      }
      seenOrgCodes.set(codeKey, i);
    }

    // Check duplicate organization names (case-insensitive)
    const seenOrgNames = new Map();
    for (let i = 0; i < workingOrganizations.length; i++) {
      const nameKey = (workingOrganizations[i].name || "").trim().toLowerCase();
      if (seenOrgNames.has(nameKey)) {
        const firstIdx = seenOrgNames.get(nameKey);
        const row = orgListEl?.querySelector(`[data-index="${i}"]`);
        const firstRow = orgListEl?.querySelector(`[data-index="${firstIdx}"]`);
        const inp = row?.querySelector(".settings-org-name-input");
        firstRow?.querySelector(".settings-org-name-input")?.classList.add("is-invalid");
        flagValidationError(
          inp,
          `Duplicate organization name "${workingOrganizations[i].name.trim()}". Each organization must have a unique name.`
        );
        return;
      }
      seenOrgNames.set(nameKey, i);
    }

    const seenAdviserEmails = new Map();
    for (let i = 0; i < workingOrganizations.length; i++) {
      const email = String(workingOrganizations[i].adviserEmail || "").trim().toLowerCase();
      if (!email) continue;
      if (seenAdviserEmails.has(email)) {
        const row = orgListEl?.querySelector(`[data-index="${i}"]`);
        const firstRow = orgListEl?.querySelector(`[data-index="${seenAdviserEmails.get(email)}"]`);
        const input = row?.querySelector(".settings-org-adviser-input");
        firstRow?.querySelector(".settings-org-adviser-input")?.classList.add("is-invalid");
        flagValidationError(input, "An adviser email can only be assigned to one organization.");
        return;
      }
      seenAdviserEmails.set(email, i);
    }

    // 2. Validate General Settings
    const selectedMainOrg = (mainOrgSelect?.value || workingMainOrg || "").trim();
    if (!selectedMainOrg) {
      flagValidationError(mainOrgSelect, "Please select a main organizing organization.");
      return;
    }

    const orgExists = workingOrganizations.some(
      (o) => (o.code || "").trim().toLowerCase() === selectedMainOrg.toLowerCase()
    );
    if (!orgExists) {
      flagValidationError(
        mainOrgSelect,
        `Selected main organization "${selectedMainOrg}" is not present in the organization directory. Please select an active organization.`
      );
      return;
    }
    workingMainOrg = selectedMainOrg;

    const rawUpload = (maxUploadInput?.value || "").trim();
    const maxUploadVal = Number(rawUpload);
    if (!rawUpload || isNaN(maxUploadVal) || !Number.isInteger(maxUploadVal) || maxUploadVal < 1 || maxUploadVal > 100) {
      flagValidationError(maxUploadInput, "Maximum upload size must be a whole number between 1 and 100 MB.");
      return;
    }

    const allowedDocsVal = (allowedDocsInput?.value || "").trim();
    if (!allowedDocsVal || !/[a-zA-Z0-9]/.test(allowedDocsVal)) {
      flagValidationError(allowedDocsInput, "Please enter valid allowed document types (e.g. PDF, DOCX, JPG, PNG).");
      return;
    }

    // 3. Validate Approval Stages
    if (!workingApprovalStages || !workingApprovalStages.length) {
      flagValidationError(addStageBtn, "At least one approval stage is required.");
      return;
    }

    for (let i = 0; i < workingApprovalStages.length; i++) {
      const s = workingApprovalStages[i];
      const card = stagesList?.querySelector(`[data-index="${i}"]`);
      const sName = (s.name || "").trim();
      const sRev = (s.reviewer || "").trim();

      if (!sName) {
        const inp = card?.querySelector(".settings-stage-name-input");
        flagValidationError(inp, `Please enter a stage name for Step ${i + 1}.`);
        return;
      }
      if (!sRev) {
        const inp = card?.querySelector(".settings-stage-reviewer-input");
        flagValidationError(inp, `Please assign a reviewer for Step ${i + 1} ("${sName}").`);
        return;
      }
      const reviewerEmail = String(s.reviewerEmail || "").trim();
      if (reviewerEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(reviewerEmail)) {
        const inp = card?.querySelector(".settings-stage-reviewer-email-input");
        flagValidationError(inp, `Enter a valid reviewer email for Step ${i + 1}, or leave it blank.`);
        return;
      }
    }

    const seenReviewerEmails = new Map();
    for (let i = 0; i < workingApprovalStages.length; i++) {
      const email = String(workingApprovalStages[i].reviewerEmail || "").trim().toLowerCase();
      if (!email) continue;
      if (seenReviewerEmails.has(email)) {
        const card = stagesList?.querySelector(`[data-index="${i}"]`);
        const firstCard = stagesList?.querySelector(`[data-index="${seenReviewerEmails.get(email)}"]`);
        const input = card?.querySelector(".settings-stage-reviewer-email-input");
        firstCard?.querySelector(".settings-stage-reviewer-email-input")?.classList.add("is-invalid");
        flagValidationError(input, "A reviewer email can only be assigned to one approval stage.");
        return;
      }
      seenReviewerEmails.set(email, i);
    }

    // Check duplicate stage names (case-insensitive)
    const seenStageNames = new Map();
    for (let i = 0; i < workingApprovalStages.length; i++) {
      const nameKey = (workingApprovalStages[i].name || "").trim().toLowerCase();
      if (seenStageNames.has(nameKey)) {
        const firstIdx = seenStageNames.get(nameKey);
        const card = stagesList?.querySelector(`[data-index="${i}"]`);
        const firstCard = stagesList?.querySelector(`[data-index="${firstIdx}"]`);
        const inp = card?.querySelector(".settings-stage-name-input");
        firstCard?.querySelector(".settings-stage-name-input")?.classList.add("is-invalid");
        flagValidationError(
          inp,
          `Duplicate stage name "${workingApprovalStages[i].name.trim()}". Each approval stage must have a unique name.`
        );
        return;
      }
      seenStageNames.set(nameKey, i);
    }

    // Check at least one stage is marked as required
    const hasRequired = workingApprovalStages.some((s) => s.required);
    if (!hasRequired) {
      const card = stagesList?.querySelector(`[data-index="0"]`);
      const chk = card?.querySelector(".settings-stage-required-checkbox");
      flagValidationError(chk, "At least one approval stage must be marked as Required.");
      return;
    }

    openConfirmationDialog({
      title: "Save System Settings?",
      text: `Are you sure you want to save changes to the system settings? These updates (General settings, ${workingOrganizations.length} organization(s) in directory, and ${workingApprovalStages.length} sequential approval stages) will apply to new proposals. Existing proposals keep their current approval workflow.`,
      yesText: "Yes, Save",
      cancelText: "No, Cancel",
      onConfirm: async () => {
        return await persistAllSettings();
      },
      onCancel: () => {},
    });
  }

  async function persistAllSettings() {
    const nextMainOrg = workingMainOrg;
    const nextMaxUpload = Number(maxUploadInput?.value) || 15;
    const nextAllowedDocs = allowedDocsInput?.value.trim() || "PDF, DOCX, JPG, PNG";
    const nextOrgs = JSON.parse(JSON.stringify(workingOrganizations));
    const nextStages = JSON.parse(JSON.stringify(workingApprovalStages));

    currentSettings.mainOrganization = nextMainOrg;
    currentSettings.maxUploadSizeMb = nextMaxUpload;
    currentSettings.allowedDocumentTypes = nextAllowedDocs;
    currentSettings.organizations = nextOrgs;
    currentSettings.approvalStages = nextStages;

    if (!cacheSettings(currentSettings, Boolean(settingsRef))) {
      showMessage("Could not save system settings to the local cache.", true);
      return false;
    }

    renderOrganizations();
    renderApprovalStages();

    if (!settingsRef) {
      localStorage.removeItem(pendingSettingsKey);
      showMessage("System settings saved locally.");
      return true;
    }

    try {
      await setDoc(
        settingsRef,
        {
          mainOrganization: nextMainOrg,
          maxUploadSizeMb: nextMaxUpload,
          allowedDocumentTypes: nextAllowedDocs,
          organizations: nextOrgs,
          approvalStages: nextStages,
          registrationEnabled: currentSettings.registrationEnabled ?? true,
          loginEnabled: currentSettings.loginEnabled ?? true,
          venues: currentSettings.venues || [],
          categories: currentSettings.categories || [],
          eventSources: currentSettings.eventSources || [],
          updatedAt: serverTimestamp(),
          updatedBy: actorIdentifier(),
        },
        { merge: true }
      );

      try {
        await appendAudit(`${actorTag()} updated system settings (General, Organization Directory, and Approval Stages)`);
      } catch (auditErr) {
        console.warn("Audit log notice:", auditErr);
      }

      localStorage.removeItem(pendingSettingsKey);
      showMessage("System settings saved successfully.");
      return true;
    } catch (err) {
      console.error("Unable to save system settings:", err);
      showMessage("Saved locally. Cloud sync is pending and will retry when the connection is available.", true);
      return true;
    }
  }

  function backfillMissingFields(data) {
    if (backfillingDefaults) return backfillingDefaults;
    const missingFields = {};
    Object.entries(defaultSettings).forEach(([field, defaultValue]) => {
      if (!(field in data)) missingFields[field] = defaultValue;
    });
    if (!Object.keys(missingFields).length) return Promise.resolve();

    backfillingDefaults = updateDoc(settingsRef, {
      ...missingFields,
      updatedAt: serverTimestamp(),
    })
      .catch((error) => {
        console.error("Unable to initialize missing system settings:", error);
      })
      .finally(() => {
        backfillingDefaults = null;
      });
    return backfillingDefaults;
  }

  // --- Initial Render from Cache ---
  renderOrganizations();
  renderApprovalStages();
  if (maxUploadInput) maxUploadInput.value = currentSettings.maxUploadSizeMb;
  if (allowedDocsInput) allowedDocsInput.value = currentSettings.allowedDocumentTypes;

  // --- Event Listeners Setup ---
  if (mainOrgSelect) {
    mainOrgSelect.addEventListener("change", (e) => {
      workingMainOrg = e.target.value;
      mainOrgSelect.classList.remove("is-invalid");
      if (stagesErrorEl) stagesErrorEl.hidden = true;
    });
  }

  if (maxUploadInput) {
    maxUploadInput.addEventListener("input", () => {
      maxUploadInput.classList.remove("is-invalid");
      if (stagesErrorEl) stagesErrorEl.hidden = true;
    });
  }

  if (allowedDocsInput) {
    allowedDocsInput.addEventListener("input", () => {
      allowedDocsInput.classList.remove("is-invalid");
      if (stagesErrorEl) stagesErrorEl.hidden = true;
    });
  }

  if (addOrgBtn) {
    addOrgBtn.addEventListener("click", addOrganization);
  }

  if (addStageBtn) {
    addStageBtn.addEventListener("click", addApprovalStage);
  }

  if (saveStagesBtn) {
    saveStagesBtn.addEventListener("click", handleSaveSettingsClick);
  }

  if (saveStagesBottomBtn) {
    saveStagesBottomBtn.addEventListener("click", handleSaveSettingsClick);
  }

  if (saveGeneralBtn) {
    saveGeneralBtn.addEventListener("click", handleSaveSettingsClick);
  }

  let pendingConfirmAction = null;
  let pendingCancelAction = null;

  function openConfirmationDialog({
    title = "Confirm Action",
    text = "Are you sure?",
    yesText = "Yes, Save",
    cancelText = "No, Cancel",
    onConfirm = null,
    onCancel = null,
  }) {
    if (!confirmDialog) return;
    const titleEl = document.getElementById("settings-confirm-title");
    const textEl = document.getElementById("settings-confirm-text");
    if (titleEl) titleEl.textContent = title;
    if (textEl) textEl.textContent = text;
    if (confirmYesBtn) confirmYesBtn.textContent = yesText;
    if (confirmCancelBtn) confirmCancelBtn.textContent = cancelText;

    pendingConfirmAction = onConfirm;
    pendingCancelAction = onCancel;
    confirmDialog.showModal();
  }

  function dismissConfirmation(runCancel = true) {
    if (runCancel && typeof pendingCancelAction === "function") {
      try {
        pendingCancelAction();
      } catch (e) {
        console.error("Cancel callback error:", e);
      }
    }
    pendingConfirmAction = null;
    pendingCancelAction = null;
    if (confirmDialog && confirmDialog.open) {
      confirmDialog.close();
    }
  }

  if (confirmCloseBtn) {
    confirmCloseBtn.addEventListener("click", () => dismissConfirmation(true));
  }

  if (confirmCancelBtn) {
    confirmCancelBtn.addEventListener("click", () => dismissConfirmation(true));
  }

  if (confirmDialog) {
    confirmDialog.addEventListener("cancel", () => dismissConfirmation(true));
    confirmDialog.addEventListener("click", (event) => {
      if (event.target === confirmDialog) dismissConfirmation(true);
    });
  }

  if (confirmYesBtn) {
    confirmYesBtn.addEventListener("click", async () => {
      confirmYesBtn.disabled = true;
      try {
        if (typeof pendingConfirmAction === "function") {
          const action = pendingConfirmAction;
          pendingConfirmAction = null;
          pendingCancelAction = null;
          const ok = await action();
          if (ok !== false) {
            confirmDialog?.close();
          }
        } else {
          const ok = await persistAllSettings();
          if (ok) {
            confirmDialog?.close();
          }
        }
      } catch (err) {
        console.error("Confirmation action error:", err);
      } finally {
        confirmYesBtn.disabled = false;
      }
    });
  }

  function updateToggleBadge(type, isEnabled) {
    const badge = type === "login" ? userLoginBadge : eventRegBadge;
    if (!badge) return;
    if (isEnabled) {
      badge.textContent = "On";
      badge.classList.remove("is-off");
      badge.classList.add("is-on");
    } else {
      badge.textContent = "Off";
      badge.classList.remove("is-on");
      badge.classList.add("is-off");
    }
  }

  async function persistSystemToggles() {
    if (!cacheSettings(currentSettings, Boolean(settingsRef))) {
      showMessage("Could not save access settings to the local cache.", true);
      return false;
    }

    if (!settingsRef) {
      localStorage.removeItem(pendingSettingsKey);
      showMessage("Access and registration settings updated locally.");
      return true;
    }

    try {
      await setDoc(
        settingsRef,
        {
          loginEnabled: currentSettings.loginEnabled ?? true,
          registrationEnabled: currentSettings.registrationEnabled ?? true,
          updatedAt: serverTimestamp(),
          updatedBy: actorIdentifier(),
        },
        { merge: true }
      );

      try {
        await appendAudit(
          `${actorTag()} updated Access and Registration settings (Login: ${
            currentSettings.loginEnabled ? "ON" : "OFF"
          }, Registration: ${currentSettings.registrationEnabled ? "ON" : "OFF"})`
        );
      } catch (auditErr) {
        console.warn("Audit log notice:", auditErr);
      }

      localStorage.removeItem(pendingSettingsKey);
      showMessage("Access and registration settings saved.");
      return true;
    } catch (err) {
      console.error("Unable to save access settings:", err);
      showMessage("Saved locally. Cloud sync is pending and will retry when the connection is available.", true);
      return true;
    }
  }

  if (loginToggle) {
    loginToggle.addEventListener("change", () => {
      if (!settingsReady) {
        loginToggle.checked = currentSettings.loginEnabled ?? true;
        showMessage("System settings are still loading. Please wait...", true);
        return;
      }

      const nextVal = loginToggle.checked;

      if (!nextVal) {
        // Turning OFF: confirmation required!
        openConfirmationDialog({
          title: "Turn off User Login?",
          text: "When off, only super admins can sign in. Everyone else sees a maintenance message. Are you sure you want to turn off user login?",
          yesText: "Yes, Turn Off",
          cancelText: "No, Keep On",
          onConfirm: async () => {
            currentSettings.loginEnabled = false;
            loginToggle.checked = false;
            updateToggleBadge("login", false);
            return await persistSystemToggles();
          },
          onCancel: () => {
            loginToggle.checked = true;
            updateToggleBadge("login", true);
          },
        });
      } else {
        // Turning ON: confirm enabling
        openConfirmationDialog({
          title: "Turn on User Login?",
          text: "Are you sure you want to turn on user login? Students, teachers, and organizers will be able to sign in normally.",
          yesText: "Yes, Turn On",
          cancelText: "No, Keep Off",
          onConfirm: async () => {
            currentSettings.loginEnabled = true;
            loginToggle.checked = true;
            updateToggleBadge("login", true);
            return await persistSystemToggles();
          },
          onCancel: () => {
            loginToggle.checked = false;
            updateToggleBadge("login", false);
          },
        });
      }
    });
  }

  if (registrationToggle) {
    registrationToggle.addEventListener("change", () => {
      if (!settingsReady) {
        registrationToggle.checked = currentSettings.registrationEnabled ?? true;
        showMessage("System settings are still loading. Please wait...", true);
        return;
      }

      const nextVal = registrationToggle.checked;

      if (!nextVal) {
        // Turning OFF: confirmation required!
        openConfirmationDialog({
          title: "Turn off Event Registration?",
          text: "When off, students cannot register for any event, including ones that are open now. Are you sure you want to turn off event registration?",
          yesText: "Yes, Turn Off",
          cancelText: "No, Keep On",
          onConfirm: async () => {
            currentSettings.registrationEnabled = false;
            registrationToggle.checked = false;
            updateToggleBadge("registration", false);
            return await persistSystemToggles();
          },
          onCancel: () => {
            registrationToggle.checked = true;
            updateToggleBadge("registration", true);
          },
        });
      } else {
        // Turning ON: confirm enabling
        openConfirmationDialog({
          title: "Turn on Event Registration?",
          text: "Are you sure you want to turn on event registration? Students will be able to register for events.",
          yesText: "Yes, Turn On",
          cancelText: "No, Keep Off",
          onConfirm: async () => {
            currentSettings.registrationEnabled = true;
            registrationToggle.checked = true;
            updateToggleBadge("registration", true);
            return await persistSystemToggles();
          },
          onCancel: () => {
            registrationToggle.checked = false;
            updateToggleBadge("registration", false);
          },
        });
      }
    });
  }

  if (registrationToggle) {
    registrationToggle.checked = currentSettings.registrationEnabled !== false;
    updateToggleBadge("registration", currentSettings.registrationEnabled !== false);
  }
  if (loginToggle) {
    loginToggle.checked = currentSettings.loginEnabled !== false;
    updateToggleBadge("login", currentSettings.loginEnabled !== false);
  }

  if (!isFirebaseConfigured || !db) {
    setReady(true);
    return;
  }

  setReady(false);

  unsubscribeSettings = onSnapshot(
    settingsRef,
    (snapshot) => {
      if (!snapshot.exists()) {
        if (initializingDocument) return;
        initializingDocument = true;
        const initialSettings = normalizedSettings(currentSettings);
        cacheSettings(initialSettings, true);
        syncPendingSettings()
          .finally(() => {
            initializingDocument = false;
          });
        return;
      }

      if (localStorage.getItem(pendingSettingsKey)) {
        setReady(true);
        void syncPendingSettings();
        return;
      }

      const data = snapshot.data();
      currentSettings = normalizedSettings(data);

      const activeEl = document.activeElement;
      const isEditingOrg = activeEl && activeEl.closest("#organization-directory-list");
      const isEditingStage = activeEl && activeEl.closest("#approval-stages-list");
      const isEditingGeneral = activeEl && (activeEl === maxUploadInput || activeEl === allowedDocsInput || activeEl === mainOrgSelect);

      if (!isEditingGeneral) {
        workingMainOrg = currentSettings.mainOrganization;
        if (maxUploadInput) maxUploadInput.value = currentSettings.maxUploadSizeMb;
        if (allowedDocsInput) allowedDocsInput.value = currentSettings.allowedDocumentTypes;
      }

      if (!isEditingOrg) {
        workingOrganizations = JSON.parse(JSON.stringify(currentSettings.organizations || defaultOrganizations));
        renderOrganizations();
      }

      if (!isEditingStage) {
        workingApprovalStages = JSON.parse(JSON.stringify(currentSettings.approvalStages || defaultApprovalStages));
        renderApprovalStages();
      }

      if (registrationToggle) {
        registrationToggle.checked = currentSettings.registrationEnabled !== false;
        updateToggleBadge("registration", currentSettings.registrationEnabled !== false);
      }
      if (loginToggle) {
        loginToggle.checked = currentSettings.loginEnabled !== false;
        updateToggleBadge("login", currentSettings.loginEnabled !== false);
      }
      cacheSettings(currentSettings);

      const hasMissingFields = Object.keys(defaultSettings).some(
        (field) => !(field in data),
      );
      if (hasMissingFields) {
        setReady(false);
        backfillMissingFields(data).finally(() => setReady(true));
      } else {
        setReady(true);
      }
    },
    (error) => {
      console.error("Unable to subscribe to system settings:", error);
      setReady(true);
      showMessage("Could not load system settings from cloud. Local cache active.", true);
    }
  );

  window.addEventListener("beforeunload", () => unsubscribeSettings?.(), { once: true });
})();
