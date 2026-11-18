import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  auth,
  authReady,
  db,
  isFirebaseConfigured,
} from "../UserStudent/firebaseConfig.js";
import {
  CORRECTION_FIELDS_BY_ROLE,
  submitCorrectionRequest,
  subscribeMyCorrectionRequests,
} from "../correctionRequests.js";

(() => {
  const profileStorageKey = "recovibeOrganizerProfile";
  const organizerIdKey = "recovibeOrganizerId";
  let profilePageLoadSignaled = false;

  function signalProfilePageReady() {
    if (profilePageLoadSignaled) return;
    profilePageLoadSignaled = true;
    window.dispatchEvent(new Event("page-data-ready"));
  }

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

  const DEFAULT_ORGANIZER = {
    firstName: "",
    middleName: "",
    lastName: "",
    name: "",
    email: "",
    contactNumber: "",
    organizerId: "",
    organization: "",
    role: "Event Organizer",
    campus: "",
  };

  let profile = { ...DEFAULT_ORGANIZER };

  try {
    const stored = JSON.parse(localStorage.getItem(profileStorageKey) || "null");
    if (stored && typeof stored === "object") {
      profile = { ...DEFAULT_ORGANIZER, ...stored };
      if (!profile.firstName && profile.name) {
        const parts = profile.name.trim().split(/\s+/).filter(Boolean);
        profile.firstName = parts[0] || "";
        profile.lastName = parts.length > 1 ? parts[parts.length - 1] : "";
        profile.middleName = parts.length > 2 ? parts.slice(1, -1).join(" ") : "";
      }
    }
  } catch (error) {
    console.warn("Unable to read organizer profile:", error);
  }

  const storedOrganizerId = localStorage.getItem(organizerIdKey);
  if (storedOrganizerId && storedOrganizerId.includes("@")) {
    profile.email = profile.email || storedOrganizerId;
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
    const org = profile.organization || "";
    const storedOrganizerId = [
      profile.accountNumber,
      profile.accountNo,
      profile.organizerNumber,
      profile.organizerNo,
      profile.eoId,
      profile.organizerId,
      localStorage.getItem(organizerIdKey),
    ].map((value) => String(value || "").trim()).find(Boolean) || "";
    const organizationCode = String(
      profile.organizationCode || profile.orgCode || profile.organization || profile.organizationName || "",
    ).trim().replace(/\s+/g, "-").toUpperCase();
    const organizerId = /^EO-\d{3}-.+/i.test(storedOrganizerId)
      ? storedOrganizerId.toUpperCase()
      : /^\d+$/.test(storedOrganizerId) && organizationCode
        ? `EO-${storedOrganizerId.padStart(3, "0")}-${organizationCode}`
        : storedOrganizerId;

    // Hero Banner
    const heroAvatar = document.getElementById("heroAvatar");
    if (heroAvatar) heroAvatar.textContent = initials;
    const heroUserName = document.getElementById("heroUserName");
    if (heroUserName) heroUserName.textContent = fullName;
    const heroRoleBadge = document.getElementById("heroRoleBadge");
    if (heroRoleBadge) heroRoleBadge.textContent = "Organizer";

    // Sidebar
    const organizerAvatar = document.getElementById("organizerAvatar");
    if (organizerAvatar) organizerAvatar.textContent = initials;
    const organizerName = document.getElementById("organizerName");
    if (organizerName) organizerName.textContent = fullName;
    const organizerRole = document.getElementById("organizerRole");
    if (organizerRole) organizerRole.textContent = org ? `${org} account` : "Event Organizer";

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
    if (viewEmail) viewEmail.textContent = profile.email || "Not set";
    const viewContact = document.getElementById("viewContact");
    if (viewContact) {
      if (profile.contactNumber) {
        viewContact.textContent = formatPhilippinePhone(profile.contactNumber);
      } else {
        viewContact.innerHTML = '<span class="empty-muted">Not set</span>';
      }
    }

    // Organizer Details Card View
    const viewOrganizerId = document.getElementById("viewOrganizerId");
    if (viewOrganizerId) viewOrganizerId.textContent = organizerId || "Not set";
    const viewOrganization = document.getElementById("viewOrganization");
    if (viewOrganization) viewOrganization.textContent = org || "Not set";
    const viewRole = document.getElementById("viewRole");
    if (viewRole) viewRole.textContent = profile.role || "Event Organizer";
    const viewCampus = document.getElementById("viewCampus");
    if (viewCampus) viewCampus.textContent = profile.campus || "Not set";
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

      localStorage.setItem(profileStorageKey, JSON.stringify(profile));
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

      localStorage.setItem(profileStorageKey, JSON.stringify(profile));
      localStorage.setItem(organizerIdKey, emailVal);

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

      localStorage.setItem("recovibeOrganizerPassword", nw);
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
  const correctionMessageInput = document.getElementById("correctionMessageInput");
  const correctionReasonInput = document.getElementById("correctionReasonInput");
  const errCorrectionField = document.getElementById("errCorrectionField");
  const errCorrectionMessage = document.getElementById("errCorrectionMessage");
  const errCorrectionReason = document.getElementById("errCorrectionReason");
  const correctionReasonCount = document.getElementById("correctionReasonCount");
  const correctionSubmitStatus = document.getElementById("correctionSubmitStatus");
  const correctionRequestsContent = document.getElementById("correctionRequestsContent");
  const correctionFields = CORRECTION_FIELDS_BY_ROLE.eventorganizer;
  const correctionFieldElements = {
    organization: "viewOrganization",
    position: "viewRole",
  };
  let correctionRequests = [];
  let correctionRequestsLoading = true;
  let correctionRequestsError = "";
  let correctionRequestsUnsubscribe = null;
  let correctionAuthUnsubscribe = null;
  let correctionRequestsTimeout = null;
  let correctionAuthGeneration = 0;
  let correctionAuthUser = null;
  let correctionSubmitInFlight = false;
  let correctionActive = true;

  function escapeCorrectionHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[character]);
  }

  function correctionCurrentValueFor(field) {
    return document.getElementById(correctionFieldElements[field])?.textContent?.trim() || "";
  }

  function correctionTimestamp(value) {
    if (value && typeof value.toMillis === "function") return value.toMillis();
    if (value && typeof value.toDate === "function") return value.toDate().getTime();
    if (value && typeof value.seconds === "number") return value.seconds * 1000;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    return null;
  }

  function updateCorrectionSubmitButton() {
    const btnSendCorrection = document.getElementById("btnSendCorrection");
    if (!btnSendCorrection) return;
    btnSendCorrection.disabled = correctionSubmitInFlight;
    btnSendCorrection.textContent = correctionSubmitInFlight ? "Sending..." : "Send request";
  }

  function updatePendingCorrectionFields() {
    if (!correctionFieldSelect) return;
    const pending = new Set(correctionRequests
      .filter((request) => String(request.status || "").trim().toLowerCase() === "pending")
      .map((request) => request.field));
    [...correctionFieldSelect.options].forEach((option) => {
      if (!option.value) return;
      const field = correctionFields.find((item) => item.field === option.value);
      option.disabled = pending.has(option.value);
      option.textContent = option.disabled ? `${field.label} - Request pending` : field.label;
    });
  }

  function renderCorrectionRequests() {
    if (!correctionRequestsContent) return;
    if (correctionRequestsLoading) {
      correctionRequestsContent.innerHTML = '<p class="cr-state" role="status">Loading your requests...</p>';
      updateCorrectionSubmitButton();
      return;
    }
    if (correctionRequestsError) {
      correctionRequestsContent.innerHTML = `<p class="cr-state" role="alert">${escapeCorrectionHtml(correctionRequestsError)}</p><button class="cr-retry-button" type="button" data-retry-correction-requests>Retry</button>`;
      updateCorrectionSubmitButton();
      return;
    }
    if (!correctionRequests.length) {
      correctionRequestsContent.innerHTML = '<p class="cr-state">No correction requests yet.</p>';
      updateCorrectionSubmitButton();
      return;
    }
    correctionRequestsContent.innerHTML = correctionRequests.map((request) => {
      const rawStatus = String(request.status || "").trim().toLowerCase();
      const status = rawStatus === "rejected"
        ? "rejected"
        : ["approved", "resolved"].includes(rawStatus) ? "approved" : "pending";
      const statusClass = status === "pending" ? "" : ` cr-is-${status}`;
      const timestamp = correctionTimestamp(request.createdAt);
      const date = timestamp
        ? new Intl.DateTimeFormat("en-US", {
            timeZone: "Asia/Manila",
            month: "short",
            day: "numeric",
            year: "numeric",
          }).format(new Date(timestamp))
        : "Date unavailable";
      const label = request.fieldLabel
        || correctionFields.find((item) => item.field === request.field)?.label
        || "Organizer detail";
      const reviewerNote = String(request.reviewNote || "").trim();
      return `<article class="cr-request-item">
        <p class="cr-request-field">${escapeCorrectionHtml(label)}</p>
        <span class="cr-status-pill${statusClass}">${status[0].toUpperCase()}${status.slice(1)}</span>
        <p class="cr-request-values">${escapeCorrectionHtml(request.currentValue)} &rarr; ${escapeCorrectionHtml(request.requestedValue)}</p>
        <p class="cr-request-date">${escapeCorrectionHtml(date)}</p>
        ${reviewerNote ? `<p class="cr-request-note"><strong>Reviewer note:</strong> ${escapeCorrectionHtml(reviewerNote)}</p>` : ""}
      </article>`;
    }).join("");
    updatePendingCorrectionFields();
    updateCorrectionSubmitButton();
  }

  function stopCorrectionRequests() {
    correctionRequestsUnsubscribe?.();
    correctionRequestsUnsubscribe = null;
    clearTimeout(correctionRequestsTimeout);
    correctionRequestsTimeout = null;
  }

  function startCorrectionRequests(user) {
    stopCorrectionRequests();
    correctionRequests = [];
    correctionRequestsLoading = true;
    correctionRequestsError = "";
    renderCorrectionRequests();
    updatePendingCorrectionFields();
    if (!user?.uid || auth?.currentUser?.uid !== user.uid || !db) {
      correctionRequestsLoading = false;
      correctionRequestsError = "Sign in to view your correction requests.";
      renderCorrectionRequests();
      signalProfilePageReady();
      return;
    }

    correctionRequestsTimeout = setTimeout(() => {
      if (!correctionRequestsLoading) return;
      correctionRequestsLoading = false;
      correctionRequestsError = "Requests are taking longer than expected to load.";
      renderCorrectionRequests();
      signalProfilePageReady();
    }, 5000);
    try {
      correctionRequestsUnsubscribe = subscribeMyCorrectionRequests(
        user.uid,
        (requests) => {
          correctionRequests = requests;
          correctionRequestsLoading = false;
          correctionRequestsError = "";
          clearTimeout(correctionRequestsTimeout);
          correctionRequestsTimeout = null;
          updatePendingCorrectionFields();
          renderCorrectionRequests();
          signalProfilePageReady();
        },
        (error) => {
          correctionRequestsLoading = false;
          correctionRequestsError = error?.code === "permission-denied"
            ? "You don't have permission to view your correction requests."
            : "Couldn't load your requests. Check your connection and retry.";
          clearTimeout(correctionRequestsTimeout);
          correctionRequestsTimeout = null;
          renderCorrectionRequests();
          signalProfilePageReady();
        },
      );
    } catch (error) {
      correctionRequestsLoading = false;
      correctionRequestsError = error?.message || "Couldn't load your requests. Check your connection and retry.";
      clearTimeout(correctionRequestsTimeout);
      correctionRequestsTimeout = null;
      renderCorrectionRequests();
      signalProfilePageReady();
    }
  }

  async function startCorrectionAuth() {
    const generation = ++correctionAuthGeneration;
    correctionRequestsLoading = true;
    correctionRequestsError = "";
    renderCorrectionRequests();
    correctionRequestsTimeout = setTimeout(() => {
      if (!correctionRequestsLoading) return;
      correctionRequestsLoading = false;
      correctionRequestsError = "Authentication is taking longer than expected.";
      renderCorrectionRequests();
      signalProfilePageReady();
    }, 5000);
    try {
      await authReady;
      if (!correctionActive || generation !== correctionAuthGeneration) return;
      if (!auth || !isFirebaseConfigured) {
        clearTimeout(correctionRequestsTimeout);
        correctionRequestsTimeout = null;
        correctionRequestsLoading = false;
        correctionRequestsError = "Correction requests are unavailable.";
        renderCorrectionRequests();
        signalProfilePageReady();
        return;
      }
      correctionAuthUnsubscribe = onAuthStateChanged(auth, (user) => {
        if (!correctionActive || generation !== correctionAuthGeneration) return;
        clearTimeout(correctionRequestsTimeout);
        correctionRequestsTimeout = null;
        if (!user?.uid) {
          stopCorrectionRequests();
          correctionAuthUser = null;
          correctionRequestsLoading = false;
          correctionRequestsError = "Sign in to view your correction requests.";
          renderCorrectionRequests();
          signalProfilePageReady();
          window.location.replace("EventOrganizerLogin.html");
          return;
        }
        correctionAuthUser = user;
        startCorrectionRequests(user);
      });
    } catch (error) {
      clearTimeout(correctionRequestsTimeout);
      correctionRequestsTimeout = null;
      correctionRequestsLoading = false;
      correctionRequestsError = error?.message || "Couldn't initialize your correction requests.";
      renderCorrectionRequests();
      signalProfilePageReady();
    }
  }

  function stopCorrectionAuth() {
    correctionActive = false;
    correctionAuthGeneration += 1;
    correctionAuthUnsubscribe?.();
    correctionAuthUnsubscribe = null;
    stopCorrectionRequests();
  }

  function openCorrectionModal() {
    if (!correctionModal) return;
    if (correctionForm) correctionForm.reset();
    if (errCorrectionField) errCorrectionField.classList.remove("is-visible");
    if (errCorrectionMessage) errCorrectionMessage.classList.remove("is-visible");
    if (errCorrectionReason) errCorrectionReason.classList.remove("is-visible");
    if (correctionCurrentValue) correctionCurrentValue.value = "";
    if (correctionReasonCount) correctionReasonCount.textContent = "0";
    if (correctionSubmitStatus) correctionSubmitStatus.textContent = "";
    correctionSubmitStatus?.classList.remove("cr-is-error");
    updatePendingCorrectionFields();
    const availableField = [...(correctionFieldSelect?.options || [])]
      .find((option) => option.value && !option.disabled);
    if (availableField) correctionFieldSelect.value = availableField.value;
    if (correctionCurrentValue) {
      correctionCurrentValue.value = correctionCurrentValueFor(correctionFieldSelect?.value || "");
    }
    correctionModal.hidden = false;
    if (correctionFieldSelect) correctionFieldSelect.focus();
  }

  function closeCorrectionModalHandler() {
    if (!correctionModal || correctionSubmitInFlight) return;
    correctionModal.hidden = true;
  }

  correctionFields.forEach(({ field, label }) => {
    const option = document.createElement("option");
    option.value = field;
    option.textContent = label;
    correctionFieldSelect?.append(option);
  });
  correctionFieldSelect?.addEventListener("change", () => {
    if (correctionCurrentValue) {
      correctionCurrentValue.value = correctionCurrentValueFor(correctionFieldSelect.value);
    }
    errCorrectionField?.classList.remove("is-visible");
  });
  correctionReasonInput?.addEventListener("input", () => {
    if (correctionReasonCount) correctionReasonCount.textContent = String(correctionReasonInput.value.length);
    errCorrectionReason?.classList.remove("is-visible");
  });
  if (btnRequestCorrection) btnRequestCorrection.addEventListener("click", openCorrectionModal);
  if (closeCorrectionModal) closeCorrectionModal.addEventListener("click", closeCorrectionModalHandler);
  if (btnCancelCorrection) btnCancelCorrection.addEventListener("click", closeCorrectionModalHandler);
  if (correctionModal) {
    correctionModal.addEventListener("click", (e) => {
      if (e.target === correctionModal || e.target.classList.contains("correction-modal-backdrop")) {
        closeCorrectionModalHandler();
      }
    });
  }

  correctionForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const field = correctionFieldSelect?.value || "";
    const currentValue = correctionCurrentValueFor(field);
    const requestedValue = correctionMessageInput?.value.trim() || "";
    const reason = correctionReasonInput?.value.trim() || "";
    const isPending = !correctionRequestsLoading && !correctionRequestsError && correctionRequests.some((request) =>
      request.field === field && String(request.status || "").trim().toLowerCase() === "pending",
    );
    const fieldError = !field || isPending;
    const valueError = !requestedValue || requestedValue.length > 200 || requestedValue === currentValue;
    const reasonError = reason.length < 10 || reason.length > 500;

    if (errCorrectionField) {
      errCorrectionField.textContent = isPending
        ? "A request is already pending for this detail."
        : "Select a read-only detail to correct.";
      errCorrectionField.classList.toggle("is-visible", fieldError);
    }
    if (errCorrectionMessage) {
      errCorrectionMessage.textContent = valueError
        ? "Enter a different requested value (1-200 characters)."
        : "";
      errCorrectionMessage.classList.toggle("is-visible", valueError);
    }
    if (errCorrectionReason) {
      errCorrectionReason.textContent = reasonError
        ? "Explain the reason in 10-500 characters."
        : "";
      errCorrectionReason.classList.toggle("is-visible", reasonError);
    }
    if (fieldError || valueError || reasonError) return;
    if (!auth?.currentUser?.uid || auth.currentUser.uid !== correctionAuthUser?.uid) {
      if (correctionSubmitStatus) {
        correctionSubmitStatus.textContent = "Sign in again before submitting.";
        correctionSubmitStatus.classList.add("cr-is-error");
      }
      return;
    }

    correctionSubmitInFlight = true;
    updateCorrectionSubmitButton();
    if (correctionSubmitStatus) {
      correctionSubmitStatus.textContent = "";
      correctionSubmitStatus.classList.remove("cr-is-error");
    }
    try {
      const requesterName = [
        profile.firstName,
        profile.middleName,
        profile.lastName,
      ].filter(Boolean).join(" ") || profile.name || auth.currentUser.displayName || "Event Organizer";
      const requesterEmail = auth.currentUser.email || profile.email || "";
      await submitCorrectionRequest({
        field,
        currentValue,
        requestedValue,
        reason,
        requesterRole: "eventorganizer",
        requesterName,
        requesterEmail,
        organization: profile.organization || "",
      });
      correctionSubmitInFlight = false;
      updateCorrectionSubmitButton();
      closeCorrectionModalHandler();
      showToast("Correction request sent to OSAS.");
      showFeedback("Correction request submitted. OSAS will review it.");
    } catch (error) {
      if (correctionSubmitStatus) {
        correctionSubmitStatus.textContent = error?.code === "permission-denied"
          ? "You don't have permission to submit this request."
          : error?.message || "Couldn't send your request. Please try again.";
        correctionSubmitStatus.classList.add("cr-is-error");
      }
    } finally {
      correctionSubmitInFlight = false;
      updateCorrectionSubmitButton();
    }
  });

  correctionRequestsContent?.addEventListener("click", (event) => {
    if (!event.target.closest("[data-retry-correction-requests]")) return;
    if (correctionAuthUser?.uid) startCorrectionRequests(correctionAuthUser);
    else startCorrectionAuth();
  });

  window.addEventListener("pagehide", stopCorrectionAuth);
  window.addEventListener("pageshow", (event) => {
    if (!event.persisted) return;
    correctionActive = true;
    startCorrectionAuth();
  });
  startCorrectionAuth();

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
      localStorage.removeItem("recovibeOrganizerId");
    });
  }

  // Keyboard escape handler for modals
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (passwordModal && !passwordModal.hidden) closePasswordModalHandler();
      if (correctionModal && !correctionModal.hidden) closeCorrectionModalHandler();
    }
  });

  updateDisplay();
})();
