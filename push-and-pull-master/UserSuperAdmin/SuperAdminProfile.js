(() => {
  const storageKey = "recovibeAdminProfile";
  const fallback = {
    firstName: "Super",
    middleName: "",
    lastName: "Admin",
    name: "Super Admin",
    role: "Super Admin",
    email: "",
    contactNumber: "",
    accountNumber: "",
    department: "",
    organization: "",
    campus: "PUP Biñan Campus",
  };

  let profile = { ...fallback };
  try {
    const stored = JSON.parse(localStorage.getItem(storageKey) || "null");
    if (stored && typeof stored === "object") profile = { ...profile, ...stored };
  } catch (error) {
    console.warn("Unable to read Super Admin profile:", error);
  }

  const text = (id, value) => {
    const element = document.getElementById(id);
    if (element) element.textContent = value || "Not set";
  };

  function showFeedback(message) {
    text("profileFeedbackText", message);
    const alert = document.getElementById("profileFeedbackAlert");
    if (alert) alert.hidden = false;
  }

  function saveProfile() {
    localStorage.setItem(storageKey, JSON.stringify(profile));
  }

  function updateDisplay() {
    const first = String(profile.firstName || "").trim();
    const middle = String(profile.middleName || "").trim();
    const last = String(profile.lastName || "").trim();
    const fullName = [first, middle, last].filter(Boolean).join(" ") || profile.name || "Super Admin";
    profile.name = fullName;
    const initial = (first || fullName || "S").charAt(0).toUpperCase();
    const office = profile.department || profile.organization || "PUP Biñan Campus";
    const accountId = profile.accountNumber || profile.accountNo || profile.employeeId || profile.uid || "Not set";
    text("heroAvatar", initial);
    text("sidebar-user-avatar", initial);
    text("heroUserName", fullName);
    text("sidebar-user-name", fullName);
    text("heroAdminId", accountId);
    text("heroOfficeName", office);
    text("heroOfficeBadge", office === "PUP Biñan Campus" ? "OSAS" : office);
    text("viewFirstName", first);
    const middleEl = document.getElementById("viewMiddleName");
    if (middleEl) middleEl.innerHTML = middle ? middle : '<span class="empty-muted">Not set</span>';
    text("viewLastName", last);
    text("viewEmail", profile.email);
    const contactEl = document.getElementById("viewContact");
    if (contactEl) contactEl.innerHTML = profile.contactNumber || '<span class="empty-muted">Not set</span>';
    text("viewAdminId", accountId);
    const departmentEl = document.getElementById("viewDepartment");
    if (departmentEl) departmentEl.innerHTML = profile.department || profile.organization || '<span class="empty-muted">Not set</span>';
    const designationEl = document.getElementById("viewDesignation");
    if (designationEl) designationEl.innerHTML = profile.designation || profile.role || '<span class="empty-muted">Not set</span>';
    text("viewCampus", profile.campus || "PUP Biñan Campus");
  }

  const detailsView = document.getElementById("detailsCardView");
  const detailsEdit = document.getElementById("detailsCardEdit");
  document.getElementById("btnEditDetails")?.addEventListener("click", () => {
    document.getElementById("inputDepartment").value = profile.department || profile.organization || "";
    document.getElementById("inputDesignation").value = profile.designation || profile.role || "";
    document.getElementById("inputCampus").value = profile.campus || "";
    document.getElementById("editAdminId").textContent = profile.accountNumber || profile.accountNo || profile.employeeId || profile.uid || "Not set";
    detailsView.hidden = true;
    detailsEdit.hidden = false;
  });
  document.getElementById("detailsCancelBtn")?.addEventListener("click", () => {
    detailsEdit.hidden = true;
    detailsView.hidden = false;
  });
  detailsEdit?.addEventListener("submit", (event) => {
    event.preventDefault();
    profile.department = document.getElementById("inputDepartment").value.trim();
    profile.designation = document.getElementById("inputDesignation").value.trim();
    profile.campus = document.getElementById("inputCampus").value.trim();
    saveProfile();
    updateDisplay();
    detailsEdit.hidden = true;
    detailsView.hidden = false;
    showFeedback("Super Admin details updated successfully.");
  });

  const nameView = document.getElementById("nameCardView");
  const nameEdit = document.getElementById("nameCardEdit");
  document.getElementById("btnEditName")?.addEventListener("click", () => {
    document.getElementById("inputFirstName").value = profile.firstName || "";
    document.getElementById("inputMiddleName").value = profile.middleName || "";
    document.getElementById("inputLastName").value = profile.lastName || "";
    nameView.hidden = true;
    nameEdit.hidden = false;
  });
  document.getElementById("nameCancelBtn")?.addEventListener("click", () => {
    nameEdit.hidden = true;
    nameView.hidden = false;
  });
  nameEdit?.addEventListener("submit", (event) => {
    event.preventDefault();
    profile.firstName = document.getElementById("inputFirstName").value.trim();
    profile.middleName = document.getElementById("inputMiddleName").value.trim();
    profile.lastName = document.getElementById("inputLastName").value.trim();
    if (!profile.firstName || !profile.lastName) return;
    saveProfile();
    updateDisplay();
    nameEdit.hidden = true;
    nameView.hidden = false;
    showFeedback("Profile name updated successfully.");
  });

  const contactView = document.getElementById("contactCardView");
  const contactEdit = document.getElementById("contactCardEdit");
  document.getElementById("btnEditContact")?.addEventListener("click", () => {
    document.getElementById("inputContactEmail").value = profile.email || "";
    document.getElementById("inputContactPhone").value = profile.contactNumber || "";
    contactView.hidden = true;
    contactEdit.hidden = false;
  });
  document.getElementById("contactCancelBtn")?.addEventListener("click", () => {
    contactEdit.hidden = true;
    contactView.hidden = false;
  });
  contactEdit?.addEventListener("submit", (event) => {
    event.preventDefault();
    profile.email = document.getElementById("inputContactEmail").value.trim().toLowerCase();
    profile.contactNumber = document.getElementById("inputContactPhone").value.trim();
    if (!profile.email) return;
    saveProfile();
    updateDisplay();
    contactEdit.hidden = true;
    contactView.hidden = false;
    showFeedback("Contact details updated successfully.");
  });

  const passwordModal = document.getElementById("passwordFormModal");
  document.getElementById("changePassword")?.addEventListener("click", () => { passwordModal.hidden = false; });
  document.getElementById("closePasswordModal")?.addEventListener("click", () => { passwordModal.hidden = true; });
  document.getElementById("passwordForm")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const password = document.getElementById("newPassword").value;
    const status = document.getElementById("passwordFormStatus");
    if (password.length < 6 || password !== document.getElementById("confirmPassword").value) {
      status.textContent = "Use at least 6 characters and matching passwords.";
      return;
    }
    localStorage.setItem("recovibeSuperAdminPassword", password);
    passwordModal.hidden = true;
    showFeedback("Password changed successfully.");
  });

  document.getElementById("btnDismissFeedback")?.addEventListener("click", () => {
    document.getElementById("profileFeedbackAlert").hidden = true;
  });

  window.addEventListener("superadmin-profile-authorized", (event) => {
    if (event.detail?.profile) profile = { ...profile, ...event.detail.profile };
    updateDisplay();
  });
  updateDisplay();
})();
