import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { auth, authReady, db, isFirebaseConfigured } from "../UserStudent/firebaseConfig.js";
import {
  CORRECTION_FIELDS_BY_ROLE,
  submitCorrectionRequest,
  subscribeMyCorrectionRequests,
} from "../correctionRequests.js";

(() => {
  const DEBUG = false;
  const TIME_ZONE = "Asia/Manila";
  const storageKey = "recovibeCurrentTeacher";
  const teacherIdKey = "recovibeTeacherId";

  function formatPhilippinePhone(raw) {
    const digits = String(raw || "").replace(/\D/g, "");
    let clean = digits;
    if (digits.startsWith("639")) {
      clean = "0" + digits.slice(2);
    } else if (digits.startsWith("9")) {
      clean = "0" + digits;
    }
    clean = clean.slice(0, 11);
    if (clean.length <= 4) return clean;
    if (clean.length <= 7) return `${clean.slice(0, 4)} ${clean.slice(4)}`;
    return `${clean.slice(0, 4)} ${clean.slice(4, 7)} ${clean.slice(7, 11)}`;
  }

  let profile = {};

  try {
    const stored = JSON.parse(localStorage.getItem(storageKey) || "null");
    if (stored && typeof stored === "object") {
      profile = { ...stored };
      if (!profile.firstName && profile.name) {
        const parts = profile.name.trim().split(/\s+/).filter(Boolean);
        profile.firstName = parts[0] || "";
        profile.lastName = parts.length > 1 ? parts[parts.length - 1] : "";
        profile.middleName = parts.length > 2 ? parts.slice(1, -1).join(" ") : "";
      }
    }
  } catch (error) {
    console.warn("Unable to read teacher profile:", error);
  }

  profile.email = profile.email || localStorage.getItem(teacherIdKey) || "";

  let profileDisplayReady = false;
  let correctionRequestsSettled = false;
  let pageLoadSignaled = false;

  function signalPageReadyIfLoaded() {
    if (pageLoadSignaled || !profileDisplayReady || !correctionRequestsSettled) return;
    pageLoadSignaled = true;
    window.dispatchEvent(new Event("page-data-ready"));
  }

  function showFeedback(message, isError = false) {
    const alert = document.getElementById("profileFeedbackAlert");
    const alertText = document.getElementById("profileFeedbackText");
    if (!alert || !alertText) return;
    alertText.textContent = message;
    alert.classList.toggle("error", isError);
    alert.hidden = false;
  }

  function showToast(message) {
    const toast = document.getElementById("toast");
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add("show");
    setTimeout(() => {
      toast.classList.remove("show");
    }, 3500);
  }

  function updateDisplay() {
    const firstName = String(profile.firstName || "").trim();
    const middleName = String(profile.middleName || "").trim();
    const lastName = String(profile.lastName || "").trim();
    const fullName = [firstName, middleName, lastName].filter(Boolean).join(" ") || profile.name || "";
    profile.name = fullName;

    const initials = Array.from(firstName || fullName)[0]?.toUpperCase() || "";

    // Hero Banner
    const heroAvatar = document.getElementById("heroAvatar");
    if (heroAvatar) heroAvatar.textContent = initials;
    const heroUserName = document.getElementById("heroUserName");
    if (heroUserName) heroUserName.textContent = fullName;
    const heroRoleBadge = document.getElementById("heroRoleBadge");
    if (heroRoleBadge) heroRoleBadge.textContent = profile.role ? (profile.role.includes("Faculty") ? "Faculty" : profile.role) : "";

    // Sidebar
    const organizerAvatar = document.getElementById("organizerAvatar");
    if (organizerAvatar) organizerAvatar.textContent = initials;
    const organizerName = document.getElementById("organizerName");
    if (organizerName) organizerName.textContent = fullName;
    const organizerRole = document.getElementById("organizerRole");
    if (organizerRole) organizerRole.textContent = "Teacher";

    // Name Card View
    const viewFirstName = document.getElementById("viewFirstName");
    if (viewFirstName) viewFirstName.textContent = firstName || fullName;
    const viewMiddleName = document.getElementById("viewMiddleName");
    if (viewMiddleName) {
      if (middleName) {
        viewMiddleName.textContent = middleName;
      } else {
        viewMiddleName.innerHTML = '<span class="empty-muted">Not set</span>';
      }
    }
    const viewLastName = document.getElementById("viewLastName");
    if (viewLastName) viewLastName.textContent = lastName;

    // Contact Card View
    const viewEmail = document.getElementById("viewEmail");
    if (viewEmail) viewEmail.textContent = profile.email || "";
    const viewContact = document.getElementById("viewContact");
    if (viewContact) {
      if (profile.contactNumber) {
        viewContact.textContent = formatPhilippinePhone(profile.contactNumber);
      } else {
        viewContact.innerHTML = '<span class="empty-muted">Not set</span>';
      }
    }

    // Teacher Details Card View
    const viewTeacherId = document.getElementById("viewTeacherId");
    if (viewTeacherId) viewTeacherId.textContent = profile.teacherId || profile.employeeId || "";
    const viewDepartment = document.getElementById("viewDepartment");
    if (viewDepartment) viewDepartment.textContent = profile.department || "";
    const viewRole = document.getElementById("viewRole");
    if (viewRole) viewRole.textContent = profile.role || "";
    const viewCampus = document.getElementById("viewCampus");
    if (viewCampus) viewCampus.textContent = profile.campus || "";
  }

  /* -------------------------------------------------------------
     NAME CARD EDITING
  ------------------------------------------------------------- */
  const btnEditName = document.getElementById("btnEditName");
  const nameCardView = document.getElementById("nameCardView");
  const nameCardEdit = document.getElementById("nameCardEdit");
  const inputFirstName = document.getElementById("inputFirstName");
  const inputMiddleName = document.getElementById("inputMiddleName");
  const inputLastName = document.getElementById("inputLastName");
  const nameUnsavedCount = document.getElementById("nameUnsavedCount");
  const nameCancelBtn = document.getElementById("nameCancelBtn");
  const nameSaveBtn = document.getElementById("nameSaveBtn");
  const errFirstName = document.getElementById("errFirstName");
  const errLastName = document.getElementById("errLastName");

  function setNameEditMode(editing) {
    if (!nameCardView || !nameCardEdit) return;
    if (editing) {
      inputFirstName.value = profile.firstName || "";
      inputMiddleName.value = profile.middleName || "";
      inputLastName.value = profile.lastName || "";
      inputFirstName.classList.remove("is-invalid");
      inputLastName.classList.remove("is-invalid");
      if (errFirstName) errFirstName.classList.remove("is-visible");
      if (errLastName) errLastName.classList.remove("is-visible");
      checkNameDirty();
      nameCardView.hidden = true;
      nameCardEdit.hidden = false;
      inputFirstName.focus();
    } else {
      nameCardEdit.hidden = true;
      nameCardView.hidden = false;
    }
  }

  function checkNameDirty() {
    const origFirst = (profile.firstName || "").trim();
    const origMid = (profile.middleName || "").trim();
    const origLast = (profile.lastName || "").trim();
    const curFirst = inputFirstName.value.trim();
    const curMid = inputMiddleName.value.trim();
    const curLast = inputLastName.value.trim();

    let changes = 0;
    if (curFirst !== origFirst) changes++;
    if (curMid !== origMid) changes++;
    if (curLast !== origLast) changes++;

    const isValid = Boolean(curFirst && curLast);
    const isDirty = changes > 0;

    nameSaveBtn.disabled = !isDirty || !isValid;
    nameUnsavedCount.classList.toggle("is-dirty", isDirty);
    if (!isDirty) {
      nameUnsavedCount.textContent = "No changes yet";
    } else {
      nameUnsavedCount.textContent = `${changes} unsaved ${changes === 1 ? "change" : "changes"}`;
    }
  }

  if (btnEditName) {
    btnEditName.addEventListener("click", () => setNameEditMode(true));
  }
  if (nameCancelBtn) {
    nameCancelBtn.addEventListener("click", () => setNameEditMode(false));
  }
  if (inputFirstName) inputFirstName.addEventListener("input", checkNameDirty);
  if (inputMiddleName) inputMiddleName.addEventListener("input", checkNameDirty);
  if (inputLastName) inputLastName.addEventListener("input", checkNameDirty);

  if (nameCardEdit) {
    nameCardEdit.addEventListener("submit", (e) => {
      e.preventDefault();
      const first = inputFirstName.value.trim();
      const mid = inputMiddleName.value.trim();
      const last = inputLastName.value.trim();

      let hasError = false;
      if (!first) {
        inputFirstName.classList.add("is-invalid");
        if (errFirstName) errFirstName.classList.add("is-visible");
        hasError = true;
      } else {
        inputFirstName.classList.remove("is-invalid");
        if (errFirstName) errFirstName.classList.remove("is-visible");
      }

      if (!last) {
        inputLastName.classList.add("is-invalid");
        if (errLastName) errLastName.classList.add("is-visible");
        hasError = true;
      } else {
        inputLastName.classList.remove("is-invalid");
        if (errLastName) errLastName.classList.remove("is-visible");
      }

      if (hasError) return;

      profile.firstName = first;
      profile.middleName = mid;
      profile.lastName = last;
      profile.name = [first, mid, last].filter(Boolean).join(" ");

      localStorage.setItem(storageKey, JSON.stringify(profile));
      updateDisplay();
      setNameEditMode(false);
      showFeedback("Profile name updated successfully.");
    });

  }

  /* -------------------------------------------------------------
     CONTACT CARD EDITING
  ------------------------------------------------------------- */
  const btnEditContact = document.getElementById("btnEditContact");
  const contactCardView = document.getElementById("contactCardView");
  const contactCardEdit = document.getElementById("contactCardEdit");
  const inputContactEmail = document.getElementById("inputContactEmail");
  const inputContactPhone = document.getElementById("inputContactPhone");
  const contactUnsavedCount = document.getElementById("contactUnsavedCount");
  const contactCancelBtn = document.getElementById("contactCancelBtn");
  const contactSaveBtn = document.getElementById("contactSaveBtn");
  const errContactEmail = document.getElementById("errContactEmail");
  const errContactPhone = document.getElementById("errContactPhone");

  function setContactEditMode(editing) {
    if (!contactCardView || !contactCardEdit) return;
    if (editing) {
      inputContactEmail.value = profile.email || "";
      inputContactPhone.value = formatPhilippinePhone(profile.contactNumber || "");
      inputContactEmail.classList.remove("is-invalid");
      inputContactPhone.classList.remove("is-invalid");
      if (errContactEmail) errContactEmail.classList.remove("is-visible");
      if (errContactPhone) errContactPhone.classList.remove("is-visible");
      checkContactDirty();
      contactCardView.hidden = true;
      contactCardEdit.hidden = false;
      inputContactEmail.focus();
    } else {
      contactCardEdit.hidden = true;
      contactCardView.hidden = false;
    }
  }

  function checkContactDirty() {
    const origEmail = (profile.email || "").trim().toLowerCase();
    const origPhone = (profile.contactNumber || "").replace(/\D/g, "");
    const curEmail = inputContactEmail.value.trim().toLowerCase();
    const curPhone = inputContactPhone.value.replace(/\D/g, "");

    let changes = 0;
    if (curEmail !== origEmail) changes++;
    if (curPhone !== origPhone) changes++;

    const isEmailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(curEmail);
    const isPhoneValid = curPhone.length === 11 && curPhone.startsWith("09");
    const isValid = isEmailValid && (curPhone.length === 0 || isPhoneValid);
    const isDirty = changes > 0;

    contactSaveBtn.disabled = !isDirty || !isValid;
    contactUnsavedCount.classList.toggle("is-dirty", isDirty);
    if (!isDirty) {
      contactUnsavedCount.textContent = "No changes yet";
    } else {
      contactUnsavedCount.textContent = `${changes} unsaved ${changes === 1 ? "change" : "changes"}`;
    }
  }

  if (btnEditContact) {
    btnEditContact.addEventListener("click", () => setContactEditMode(true));
  }
  if (contactCancelBtn) {
    contactCancelBtn.addEventListener("click", () => setContactEditMode(false));
  }
  if (inputContactEmail) inputContactEmail.addEventListener("input", checkContactDirty);
  if (inputContactPhone) {
    inputContactPhone.addEventListener("input", (e) => {
      const formatted = formatPhilippinePhone(e.target.value);
      e.target.value = formatted;
      checkContactDirty();
    });
  }

  if (contactCardEdit) {
    contactCardEdit.addEventListener("submit", (e) => {
      e.preventDefault();
      const emailVal = inputContactEmail.value.trim().toLowerCase();
      const rawPhone = inputContactPhone.value.replace(/\D/g, "");

      let hasError = false;
      if (!emailVal || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailVal)) {
        inputContactEmail.classList.add("is-invalid");
        if (errContactEmail) errContactEmail.classList.add("is-visible");
        hasError = true;
      } else {
        inputContactEmail.classList.remove("is-invalid");
        if (errContactEmail) errContactEmail.classList.remove("is-visible");
      }

      if (rawPhone && (rawPhone.length !== 11 || !rawPhone.startsWith("09"))) {
        inputContactPhone.classList.add("is-invalid");
        if (errContactPhone) errContactPhone.classList.add("is-visible");
        hasError = true;
      } else {
        inputContactPhone.classList.remove("is-invalid");
        if (errContactPhone) errContactPhone.classList.remove("is-visible");
      }

      if (hasError) return;

      profile.email = emailVal;
      profile.contactNumber = rawPhone ? formatPhilippinePhone(rawPhone) : "";

      localStorage.setItem(storageKey, JSON.stringify(profile));
      localStorage.setItem(teacherIdKey, emailVal);

      updateDisplay();
      setContactEditMode(false);
      showFeedback("Contact details updated successfully.");
    });
  }

  /* -------------------------------------------------------------
     PASSWORD MODAL
  ------------------------------------------------------------- */
  const changePasswordBtn = document.getElementById("changePassword");
  const passwordModal = document.getElementById("passwordFormModal");
  const passwordForm = document.getElementById("passwordForm");
  const closePasswordModal = document.getElementById("closePasswordModal");
  const cancelPasswordChange = document.getElementById("cancelPasswordChange");
  const currentPasswordInput = document.getElementById("currentPassword");
  const newPasswordInput = document.getElementById("newPassword");
  const confirmPasswordInput = document.getElementById("confirmPassword");
  const passwordStatus = document.getElementById("passwordFormStatus");

  function openPasswordModal() {
    if (!passwordModal) return;
    if (passwordForm) passwordForm.reset();
    if (passwordStatus) passwordStatus.textContent = "";
    passwordModal.hidden = false;
    if (currentPasswordInput) currentPasswordInput.focus();
  }

  function closePasswordModalHandler() {
    if (!passwordModal) return;
    passwordModal.hidden = true;
  }

  if (changePasswordBtn) changePasswordBtn.addEventListener("click", openPasswordModal);
  if (closePasswordModal) closePasswordModal.addEventListener("click", closePasswordModalHandler);
  if (cancelPasswordChange) cancelPasswordChange.addEventListener("click", closePasswordModalHandler);
  if (passwordModal) {
    passwordModal.addEventListener("click", (e) => {
      if (e.target === passwordModal || e.target.classList.contains("modal-backdrop")) {
        closePasswordModalHandler();
      }
    });
  }

  if (passwordForm) {
    passwordForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const cur = currentPasswordInput.value;
      const nw = newPasswordInput.value;
      const conf = confirmPasswordInput.value;

      if (!cur) {
        passwordStatus.textContent = "Please enter your current password.";
        currentPasswordInput.focus();
        return;
      }
      if (nw.length < 6) {
        passwordStatus.textContent = "New password must be at least 6 characters.";
        newPasswordInput.focus();
        return;
      }
      if (nw !== conf) {
        passwordStatus.textContent = "New passwords do not match.";
        confirmPasswordInput.focus();
        return;
      }

      localStorage.setItem("recovibeTeacherPassword", nw);
      closePasswordModalHandler();
      showToast("Password updated successfully.");
      showFeedback("Password changed successfully.");
    });
  }

  /* -------------------------------------------------------------
     REQUEST A CORRECTION MODAL
  ------------------------------------------------------------- */
  const btnRequestCorrection = document.getElementById("btnRequestCorrection");
  const correctionModal = document.getElementById("correctionModalOverlay");
  const closeCorrectionModal = document.getElementById("closeCorrectionModal");
  const btnCancelCorrection = document.getElementById("btnCancelCorrection");
  const correctionForm = document.getElementById("correctionForm");
  const correctionFieldSelect = document.getElementById("correctionFieldSelect");
  const correctionCurrentValue = document.getElementById("correctionCurrentValue");
  const correctionRequestedValue = document.getElementById("correctionRequestedValue");
  const correctionReason = document.getElementById("correctionReason");
  const correctionReasonCount = document.getElementById("correctionReasonCount");
  const errCorrectionField = document.getElementById("errCorrectionField");
  const errCorrectionValue = document.getElementById("errCorrectionValue");
  const errCorrectionReason = document.getElementById("errCorrectionReason");
  const correctionSubmitStatus = document.getElementById("correctionSubmitStatus");
  const correctionRetryButton = document.getElementById("correctionRetryButton");
  const btnSendCorrection = document.getElementById("btnSendCorrection");
  const correctionRequestsContent = document.getElementById("correctionRequestsContent");
  const correctionFieldLabels = Object.fromEntries(
    CORRECTION_FIELDS_BY_ROLE.teacher.map(({ field, label }) => [field, label]),
  );
  const correctionFieldElements = {
    teacherId: document.getElementById("viewTeacherId"),
    department: document.getElementById("viewDepartment"),
    designation: document.getElementById("viewRole"),
    campus: document.getElementById("viewCampus"),
  };
  let correctionRequests = [];
  let correctionRequestsLoading = true;
  let correctionRequestsError = "";
  let correctionRequestsUnsubscribe = null;
  let correctionAuthUnsubscribe = null;
  let correctionRequestsTimeout = null;
  let correctionActive = true;
  let correctionAuthGeneration = 0;
  let correctionUid = "";
  let correctionSubmitInFlight = false;
  const locallyPendingFields = new Set();

  function correctionDebug(message, error) {
    if (DEBUG) console.debug("[Teacher Profile Corrections]", message, {
      code: error?.code || "unknown",
      message: error?.message || String(error),
      uid: auth?.currentUser?.uid,
      error,
    });
  }

  function correctionCurrentValueFor(field) {
    return correctionFieldElements[field]?.textContent?.trim() || "";
  }

  function updatePendingFieldOptions() {
    const pendingFields = new Set([
      ...locallyPendingFields,
      ...correctionRequests
        .filter((request) => normalizeCorrectionStatus(request.status) === "pending")
        .map((request) => request.field),
    ]);
    [...correctionFieldSelect.options].forEach((option) => {
      if (!option.value) return;
      const baseLabel = correctionFieldLabels[option.value];
      option.disabled = pendingFields.has(option.value);
      option.textContent = option.disabled
        ? `${baseLabel} — A request is already pending`
        : baseLabel;
    });
  }

  function updateCorrectionSubmitButton() {
    btnSendCorrection.disabled =
      correctionSubmitInFlight;
    btnSendCorrection.textContent = correctionSubmitInFlight ? "Sending..." : "Submit request";
  }

  function normalizeCorrectionStatus(status) {
    return String(status || "").trim().toLowerCase().replace(/[\s_-]+/g, "");
  }

  function renderCorrectionRequests() {
    if (!correctionRequestsContent) return;
    if (correctionRequestsLoading) {
      correctionRequestsContent.innerHTML = '<p role="status">Loading correction requests...</p>';
      updateCorrectionSubmitButton();
      return;
    }
    if (correctionRequestsError) {
      correctionRequestsContent.innerHTML = `<div class="correction-request-error"><span>${escapeCorrectionHTML(correctionRequestsError)}</span><button type="button" id="retryCorrectionRequests">Retry</button></div>`;
      updateCorrectionSubmitButton();
      return;
    }
    if (!correctionRequests.length) {
      correctionRequestsContent.innerHTML = '<p class="correction-request-empty">No correction requests yet.</p>';
      updateCorrectionSubmitButton();
      return;
    }
    const sorted = [...correctionRequests].sort((a, b) => {
      const byMillis = (Number(b.createdAtMs) || 0) - (Number(a.createdAtMs) || 0);
      return byMillis || correctionTimestamp(b.createdAt) - correctionTimestamp(a.createdAt);
    });
    correctionRequestsContent.innerHTML = `<div class="correction-request-list">${sorted.map((request) => {
      const status = normalizeCorrectionStatus(request.status);
      const statusLabel = status === "resolved" ? "Resolved" : status === "rejected" ? "Rejected" : "Pending";
      const statusClass = status === "resolved" ? "is-resolved" : status === "rejected" ? "is-rejected" : "is-pending";
      const currentValue = String(request.currentValue ?? "");
      const requestedValue = String(request.requestedValue ?? "");
      const label = String(request.fieldLabel || correctionFieldLabels[request.field] || "Teacher detail");
      const reviewNote = String(request.reviewNote || "").trim();
      const timestamp = Number(request.createdAtMs) || correctionTimestamp(request.createdAt);
      return `<article class="correction-request-item">
        <p class="correction-request-field">${escapeCorrectionHTML(label)}</p>
        <span class="correction-request-status ${statusClass}">${statusLabel}</span>
        <p class="correction-request-values">${escapeCorrectionHTML(currentValue)} &rarr; ${escapeCorrectionHTML(requestedValue)}</p>
        <p class="correction-request-date">${timestamp ? escapeCorrectionHTML(formatCorrectionDate(timestamp)) : "Date unavailable"}</p>
        ${reviewNote ? `<p class="correction-request-note"><strong>Reviewer note:</strong> ${escapeCorrectionHTML(reviewNote)}</p>` : ""}
      </article>`;
    }).join("")}</div>`;
    updateCorrectionSubmitButton();
  }

  function escapeCorrectionHTML(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[character]);
  }

  function correctionTimestamp(value) {
    if (value && typeof value.toMillis === "function") return value.toMillis();
    if (value && typeof value.toDate === "function") return value.toDate().getTime();
    if (value && typeof value.seconds === "number") return value.seconds * 1000;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    return 0;
  }

  function formatCorrectionDate(timestamp) {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: TIME_ZONE,
      month: "short",
      day: "numeric",
      year: "numeric",
    }).format(new Date(timestamp));
  }

  function stopCorrectionRequests() {
    correctionRequestsUnsubscribe?.();
    correctionRequestsUnsubscribe = null;
    clearTimeout(correctionRequestsTimeout);
    correctionRequestsTimeout = null;
  }

  function startCorrectionRequests(uid) {
    stopCorrectionRequests();
    correctionUid = uid;
    correctionRequests = [];
    correctionRequestsError = "";
    correctionRequestsLoading = true;
    renderCorrectionRequests();
    updatePendingFieldOptions();
    if (!uid || !db || !isFirebaseConfigured || auth?.currentUser?.uid !== uid) {
      correctionRequestsLoading = false;
      correctionRequestsError = "Sign in to view your correction requests.";
      renderCorrectionRequests();
      correctionRequestsSettled = true;
      signalPageReadyIfLoaded();
      return;
    }
    correctionRequestsTimeout = setTimeout(() => {
      if (!correctionRequestsLoading) return;
      correctionRequestsLoading = false;
      correctionRequestsError = "Requests are taking longer than expected to load.";
      renderCorrectionRequests();
      correctionRequestsSettled = true;
      signalPageReadyIfLoaded();
    }, 5000);
    try {
      correctionRequestsUnsubscribe = subscribeMyCorrectionRequests(
        uid,
        (requests) => {
          correctionRequests = requests;
          correctionRequestsLoading = false;
          correctionRequestsError = "";
          clearTimeout(correctionRequestsTimeout);
          correctionRequestsTimeout = null;
          correctionRequestsSettled = true;
          correctionRequests.forEach((request) => {
            if (normalizeCorrectionStatus(request.status) !== "pending") {
              locallyPendingFields.delete(request.field);
            }
          });
          updatePendingFieldOptions();
          renderCorrectionRequests();
          signalPageReadyIfLoaded();
        },
        (error) => {
          correctionDebug("Firestore read failed", error);
          correctionRequestsLoading = false;
          correctionRequestsError = error?.code === "permission-denied"
            ? "You don't have permission to view your correction requests. Ask an administrator to check the correctionRequests read rule."
            : "Couldn't load your requests. Check your connection and retry.";
          clearTimeout(correctionRequestsTimeout);
          correctionRequestsTimeout = null;
          renderCorrectionRequests();
          correctionRequestsSettled = true;
          signalPageReadyIfLoaded();
        },
      );
    } catch (error) {
      correctionDebug("Firestore read could not start", error);
      correctionRequestsLoading = false;
      correctionRequestsError = "Couldn't load your requests. Check your connection and retry.";
      clearTimeout(correctionRequestsTimeout);
      correctionRequestsTimeout = null;
      renderCorrectionRequests();
      correctionRequestsSettled = true;
      signalPageReadyIfLoaded();
    }
  }

  function openCorrectionModal() {
    if (!correctionModal) return;
    if (correctionForm) correctionForm.reset();
    clearCorrectionErrors();
    correctionSubmitStatus.textContent = "";
    correctionRetryButton.hidden = true;
    correctionRequestedValue.value = "";
    correctionReasonCount.textContent = "0";
    updatePendingFieldOptions();
    if (correctionRequestsLoading) {
      correctionSubmitStatus.textContent = "Loading your pending requests. Please wait before submitting.";
    } else if (correctionRequestsError) {
      correctionSubmitStatus.textContent = "Retry loading your requests before submitting.";
    }
    const firstAvailableOption = [...correctionFieldSelect.options]
      .find((option) => option.value && !option.disabled);
    correctionFieldSelect.value = firstAvailableOption?.value || "";
    updateCorrectionCurrentValue();
    correctionModal.hidden = false;
    correctionFieldSelect.focus();
  }

  function closeCorrectionModalHandler() {
    if (!correctionModal || correctionSubmitInFlight) return;
    correctionModal.hidden = true;
    btnRequestCorrection?.focus();
  }

  function clearCorrectionErrors() {
    [errCorrectionField, errCorrectionValue, errCorrectionReason].forEach((error) => {
      error?.classList.remove("is-visible");
    });
    [correctionFieldSelect, correctionRequestedValue, correctionReason].forEach((input) => {
      input?.classList.remove("is-invalid");
    });
  }

  function updateCorrectionCurrentValue() {
    correctionCurrentValue.value = correctionCurrentValueFor(correctionFieldSelect.value);
  }

  function validateCorrectionForm() {
    clearCorrectionErrors();
    const field = correctionFieldSelect.value;
    const currentValue = correctionCurrentValueFor(field);
    const requestedValue = correctionRequestedValue.value.trim();
    const reason = correctionReason.value.trim();
    let valid = true;
    const alreadyPending = Boolean(field) && (
      locallyPendingFields.has(field) ||
      correctionRequests.some((request) =>
        request.field === field && normalizeCorrectionStatus(request.status) === "pending",
      )
    );
    if (!field || alreadyPending) {
      errCorrectionField.textContent = alreadyPending
        ? "A request is already pending for this detail."
        : "Please select which detail is wrong.";
      errCorrectionField.classList.add("is-visible");
      correctionFieldSelect.classList.add("is-invalid");
      valid = false;
    }
    if (!requestedValue || requestedValue.length > 200 || requestedValue === currentValue) {
      errCorrectionValue.classList.add("is-visible");
      correctionRequestedValue.classList.add("is-invalid");
      valid = false;
    }
    if (reason.length < 10 || reason.length > 500) {
      errCorrectionReason.classList.add("is-visible");
      correctionReason.classList.add("is-invalid");
      valid = false;
    }
    return valid ? { field, currentValue, requestedValue, reason } : null;
  }

  if (btnRequestCorrection) btnRequestCorrection.addEventListener("click", openCorrectionModal);
  if (closeCorrectionModal) closeCorrectionModal.addEventListener("click", closeCorrectionModalHandler);
  if (btnCancelCorrection) btnCancelCorrection.addEventListener("click", closeCorrectionModalHandler);
  if (correctionModal) {
    correctionModal.addEventListener("click", (e) => {
      if (e.target === correctionModal || e.target === document.getElementById("correctionModalBackdrop")) {
        closeCorrectionModalHandler();
      }
    });
  }

  correctionFieldSelect.addEventListener("change", () => {
    updateCorrectionCurrentValue();
    clearCorrectionErrors();
    errCorrectionField.textContent = "Please select which detail is wrong.";
    correctionSubmitStatus.textContent = "";
  });
  correctionReason.addEventListener("input", () => {
    correctionReasonCount.textContent = String(correctionReason.value.length);
    errCorrectionReason.classList.remove("is-visible");
    correctionReason.classList.remove("is-invalid");
  });
  correctionRequestedValue.addEventListener("input", () => {
    errCorrectionValue.classList.remove("is-visible");
    correctionRequestedValue.classList.remove("is-invalid");
  });

  if (correctionForm) {
    correctionForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (correctionSubmitInFlight) return;
      const requestValues = validateCorrectionForm();
      if (!requestValues) return;
      if (!correctionUid || !auth?.currentUser?.uid) {
        correctionSubmitStatus.textContent = "Sign in again before sending a correction request.";
        return;
      }

      correctionSubmitInFlight = true;
      updateCorrectionSubmitButton();
      correctionSubmitStatus.textContent = "";
      correctionRetryButton.hidden = true;
      try {
        const user = auth.currentUser;
        const requesterName = String(
          user.displayName ||
          profile.fullName ||
          profile.name ||
          [profile.firstName, profile.middleName, profile.lastName].filter(Boolean).join(" ") ||
          "Teacher",
        ).trim();
        const requesterEmail = String(user.email || profile.email || "").trim();
        const fieldLabel = correctionFieldLabels[requestValues.field];
        const createdAtMs = Date.now();
        const payload = {
          requesterUid: user.uid,
          requesterRole: "teacher",
          requesterName,
          requesterEmail,
          role: "Teacher",
          field: requestValues.field,
          fieldLabel,
          currentValue: requestValues.currentValue,
          requestedValue: requestValues.requestedValue,
          reason: requestValues.reason,
          status: "pending",
          createdAtMs,
        };
        Object.keys(payload).forEach((key) => {
          if (payload[key] === undefined) delete payload[key];
        });
        const requestId = await submitCorrectionRequest({
          field: requestValues.field,
          currentValue: requestValues.currentValue,
          requestedValue: requestValues.requestedValue,
          reason: requestValues.reason,
          requesterRole: "teacher",
          requesterName,
          requesterEmail,
        });
        locallyPendingFields.add(requestValues.field);
        if (!correctionRequests.some((request) => request.id === requestId)) {
          correctionRequests.unshift({ ...payload, id: requestId, createdAtMs });
        }
        correctionRequestsLoading = false;
        correctionRequestsError = "";
        updateCorrectionSubmitButton();
        renderCorrectionRequests();
        updatePendingFieldOptions();
        correctionSubmitInFlight = false;
        btnSendCorrection.disabled = false;
        btnSendCorrection.textContent = "Submit request";
        correctionModal.hidden = true;
        btnRequestCorrection.focus();
        showToast("Request sent. OSAS will review it.");
      } catch (error) {
        correctionDebug("Correction request submission failed", error);
        if (error?.code === "permission-denied") {
          correctionSubmitStatus.textContent = "You don't have permission to send requests";
        } else if (/unavailable|deadline-exceeded|network|failed-precondition/i.test(String(error?.code || ""))) {
          correctionSubmitStatus.textContent = "Couldn't send. Check your connection and try again";
        } else {
          correctionSubmitStatus.textContent = "Couldn't send your request. Please try again.";
        }
        correctionRetryButton.hidden = false;
      } finally {
        correctionSubmitInFlight = false;
        updateCorrectionSubmitButton();
      }
    });
  }

  correctionRetryButton.addEventListener("click", () => {
    correctionForm.requestSubmit();
  });

  correctionRequestsContent.addEventListener("click", (event) => {
    if (event.target.closest("#retryCorrectionRequests") && correctionUid) {
      startCorrectionRequests(correctionUid);
    }
  });

  function stopCorrectionListeners() {
    correctionActive = false;
    correctionAuthGeneration += 1;
    correctionAuthUnsubscribe?.();
    correctionAuthUnsubscribe = null;
    stopCorrectionRequests();
  }

  async function startCorrectionAuth() {
    const generation = ++correctionAuthGeneration;
    correctionRequestsLoading = true;
    correctionRequestsError = "";
    renderCorrectionRequests();
    correctionRequestsTimeout = setTimeout(() => {
      if (!correctionRequestsLoading) return;
      correctionRequestsLoading = false;
      correctionRequestsError = "Requests are taking longer than expected to load.";
      renderCorrectionRequests();
      correctionRequestsSettled = true;
      signalPageReadyIfLoaded();
    }, 5000);
    try {
      await authReady;
      if (!correctionActive || generation !== correctionAuthGeneration) return;
      if (correctionAuthUnsubscribe || !auth || !isFirebaseConfigured) {
        clearTimeout(correctionRequestsTimeout);
        correctionRequestsTimeout = null;
        if (!auth || !isFirebaseConfigured) {
          correctionRequestsLoading = false;
          correctionRequestsError = "Sign in to view your correction requests.";
          renderCorrectionRequests();
          correctionRequestsSettled = true;
          signalPageReadyIfLoaded();
          window.location.replace("TeacherLogin.html");
        }
        return;
      }
      correctionAuthUnsubscribe = onAuthStateChanged(auth, (user) => {
        if (!correctionActive || generation !== correctionAuthGeneration) return;
        clearTimeout(correctionRequestsTimeout);
        correctionRequestsTimeout = null;
        if (!user?.uid) {
          stopCorrectionRequests();
          correctionRequestsLoading = false;
          correctionRequestsError = "Sign in to view your correction requests.";
          renderCorrectionRequests();
          window.location.replace("TeacherLogin.html");
          return;
        }
        startCorrectionRequests(user.uid);
      });
    } catch (error) {
      clearTimeout(correctionRequestsTimeout);
      correctionRequestsTimeout = null;
      correctionDebug("Teacher authentication initialization failed", error);
      correctionRequestsLoading = false;
      correctionRequestsError = "Couldn't load your requests. Check your connection and retry.";
      renderCorrectionRequests();
      correctionRequestsSettled = true;
      signalPageReadyIfLoaded();
    }
  }

  window.addEventListener("pagehide", stopCorrectionListeners);
  window.addEventListener("pageshow", (event) => {
    if (!event.persisted) return;
    correctionActive = true;
    startCorrectionAuth();
  });

  /* -------------------------------------------------------------
     FEEDBACK ALERT DISMISS & LOGOUT
  ------------------------------------------------------------- */
  const btnDismissFeedback = document.getElementById("btnDismissFeedback");
  if (btnDismissFeedback) {
    btnDismissFeedback.addEventListener("click", () => {
      const alert = document.getElementById("profileFeedbackAlert");
      if (alert) alert.hidden = true;
    });
  }

  const organizerLogout = document.getElementById("organizerLogout");
  if (organizerLogout) {
    organizerLogout.addEventListener("click", () => {
      localStorage.removeItem(storageKey);
      localStorage.removeItem(teacherIdKey);
    });
  }

  // Keyboard escape handler for modals
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (passwordModal && !passwordModal.hidden) closePasswordModalHandler();
      if (correctionModal && !correctionModal.hidden) closeCorrectionModalHandler();
    }
  });

  startCorrectionAuth();
  updateDisplay();
  profileDisplayReady = true;
  signalPageReadyIfLoaded();
})();
