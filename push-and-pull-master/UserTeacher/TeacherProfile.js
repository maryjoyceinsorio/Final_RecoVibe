(() => {
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

  const DEFAULT_TEACHER = {
    firstName: "Maria",
    middleName: "",
    lastName: "Santos",
    name: "Maria Santos",
    email: "santos.maria@pup.edu.ph",
    contactNumber: "0912 345 6789",
    teacherId: "2024-FAC-0102",
    department: "Department of Computer Studies",
    role: "Faculty Member",
    campus: "PUP Biñan Campus",
  };

  let profile = { ...DEFAULT_TEACHER };

  try {
    const stored = JSON.parse(localStorage.getItem(storageKey) || "null");
    if (stored && typeof stored === "object") {
      profile = { ...DEFAULT_TEACHER, ...stored };
      if (!profile.firstName && profile.name) {
        const parts = profile.name.trim().split(/\s+/).filter(Boolean);
        profile.firstName = parts[0] || "Maria";
        profile.lastName = parts.length > 1 ? parts[parts.length - 1] : "Santos";
        profile.middleName = parts.length > 2 ? parts.slice(1, -1).join(" ") : "";
      }
    }
  } catch (error) {
    console.warn("Unable to read teacher profile:", error);
  }

  profile.email = profile.email || localStorage.getItem(teacherIdKey) || DEFAULT_TEACHER.email;

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
    const fullName = [firstName, middleName, lastName].filter(Boolean).join(" ") || profile.name || "Teacher";
    profile.name = fullName;

    const initials = Array.from(firstName || fullName || "T")[0]?.toUpperCase() || "T";

    // Hero Banner
    const heroAvatar = document.getElementById("heroAvatar");
    if (heroAvatar) heroAvatar.textContent = initials;
    const heroUserName = document.getElementById("heroUserName");
    if (heroUserName) heroUserName.textContent = fullName;
    const heroRoleBadge = document.getElementById("heroRoleBadge");
    if (heroRoleBadge) heroRoleBadge.textContent = profile.role ? (profile.role.includes("Faculty") ? "Faculty" : profile.role) : "Faculty";

    // Sidebar
    const organizerAvatar = document.getElementById("organizerAvatar");
    if (organizerAvatar) organizerAvatar.textContent = initials;
    const organizerName = document.getElementById("organizerName");
    if (organizerName) organizerName.textContent = fullName;
    const organizerRole = document.getElementById("organizerRole");
    if (organizerRole) organizerRole.textContent = profile.department || "Faculty account";

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
    if (viewLastName) viewLastName.textContent = lastName || "Account";

    // Contact Card View
    const viewEmail = document.getElementById("viewEmail");
    if (viewEmail) viewEmail.textContent = profile.email || "teacher@pup.edu.ph";
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
    if (viewTeacherId) viewTeacherId.textContent = profile.teacherId || profile.employeeId || "2024-FAC-0102";
    const viewDepartment = document.getElementById("viewDepartment");
    if (viewDepartment) viewDepartment.textContent = profile.department || "Department of Computer Studies";
    const viewRole = document.getElementById("viewRole");
    if (viewRole) viewRole.textContent = profile.role || "Faculty Member";
    const viewCampus = document.getElementById("viewCampus");
    if (viewCampus) viewCampus.textContent = profile.campus || "PUP Biñan Campus";
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
  const correctionMessageInput = document.getElementById("correctionMessageInput");
  const errCorrectionField = document.getElementById("errCorrectionField");
  const errCorrectionMessage = document.getElementById("errCorrectionMessage");

  function openCorrectionModal() {
    if (!correctionModal) return;
    if (correctionForm) correctionForm.reset();
    if (errCorrectionField) errCorrectionField.classList.remove("is-visible");
    if (errCorrectionMessage) errCorrectionMessage.classList.remove("is-visible");
    correctionModal.hidden = false;
    if (correctionFieldSelect) correctionFieldSelect.focus();
  }

  function closeCorrectionModalHandler() {
    if (!correctionModal) return;
    correctionModal.hidden = true;
  }

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

  if (correctionForm) {
    correctionForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const selectedField = correctionFieldSelect.value;
      const message = correctionMessageInput.value.trim();

      let hasError = false;
      if (!selectedField) {
        if (errCorrectionField) errCorrectionField.classList.add("is-visible");
        hasError = true;
      } else {
        if (errCorrectionField) errCorrectionField.classList.remove("is-visible");
      }

      if (message.length < 10) {
        if (errCorrectionMessage) errCorrectionMessage.classList.add("is-visible");
        hasError = true;
      } else {
        if (errCorrectionMessage) errCorrectionMessage.classList.remove("is-visible");
      }

      if (hasError) return;

      const requests = JSON.parse(localStorage.getItem("recovibeTeacherCorrections") || "[]");
      requests.push({
        field: selectedField,
        message,
        timestamp: new Date().toISOString(),
        teacherEmail: profile.email,
        teacherName: profile.name,
      });
      localStorage.setItem("recovibeTeacherCorrections", JSON.stringify(requests));

      closeCorrectionModalHandler();
      showToast("Correction request sent to administration.");
      showFeedback("Correction request submitted. OSAS will review your request.");
    });
  }

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

  updateDisplay();
})();
