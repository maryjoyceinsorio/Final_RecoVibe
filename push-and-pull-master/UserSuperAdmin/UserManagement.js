import { deleteApp, getApp, initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  createUserWithEmailAndPassword,
  deleteUser,
  getAuth,
  signOut,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  onSnapshot,
  serverTimestamp,
  setDoc,
  updateDoc,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { db, isFirebaseConfigured } from "../UserStudent/firebaseConfig.js";

(() => {
  "use strict";

  const tableBody = document.getElementById("user-table-tbody");
  const roleDialog = document.getElementById("account-type-dialog");
  const createDialog = document.getElementById("create-user-dialog");
  const detailsDialog = document.getElementById("user-details-modal-backdrop");
  const createForm = document.getElementById("create-user-form");
  const staffAuthFields = document.getElementById("staff-auth-fields");
  const passwordInput = document.getElementById("new-user-password");
  const passwordConfirmationInput = document.getElementById(
    "new-user-password-confirmation",
  );
  const statusButton = document.getElementById("toggle-user-status-button");
  const deleteButton = document.getElementById("delete-user-button");
  const editButton = document.getElementById("edit-user-button");
  const editDialog = document.getElementById("edit-user-dialog");
  const editForm = document.getElementById("edit-user-form");
  const confirmDialog = document.getElementById("confirm-edit-dialog");
  const confirmSaveButton = document.getElementById("confirm-save-edit-button");
  const cancelConfirmButton = document.getElementById(
    "cancel-confirm-edit-button",
  );
  const confirmSummary = document.getElementById("confirm-changes-summary");
  const confirmMessage = document.getElementById("confirm-edit-message");
  const statusConfirmDialog = document.getElementById("confirm-status-dialog");
  const statusConfirmTitle = document.getElementById("confirm-status-title");
  const statusConfirmMessage = document.getElementById("confirm-status-message");
  const statusConfirmActionButton = document.getElementById(
    "confirm-status-action-button",
  );
  const cancelStatusConfirmButton = document.getElementById(
    "cancel-confirm-status-button",
  );
  const deleteConfirmDialog = document.getElementById("confirm-delete-dialog");
  const deleteConfirmTitle = document.getElementById("confirm-delete-title");
  const deleteConfirmMessage = document.getElementById("confirm-delete-message");
  const deleteConfirmActionButton = document.getElementById(
    "confirm-delete-action-button",
  );
  const cancelDeleteConfirmButton = document.getElementById(
    "cancel-confirm-delete-button",
  );
  const toast = document.getElementById("user-management-status");
  const searchInput = document.getElementById("user-search-input");
  let searchQuery = "";
  let studentsList = [];
  let staffList = [];
  let selectedUserId = null;
  let selectedUserCollection = null;
  let pendingEditPayload = null;
  let pendingEditChanges = [];
  let unsubscribeStudents;
  let unsubscribeStaff;

  function showMessage(message, isError = false) {
    if (!toast) return;
    toast.textContent = message;
    toast.dataset.state = isError ? "error" : "success";
    toast.hidden = false;
  }

  function stringValue(value, fallback = "") {
    return value == null ? fallback : String(value);
  }

  function sanitizeOrgSuffix(val) {
    if (!val) return "";
    return String(val)
      .trim()
      .replace(/\s+/g, "-")
      .replace(/[^A-Za-z0-9-]/g, "")
      .toUpperCase();
  }

  function getNextAccountNumberForRole(role, orgValue = "") {
    const allUsers = [...studentsList, ...staffList];
    const roleLower = String(role || "").toLowerCase().trim();

    if (roleLower === "teacher") {
      let maxNum = 0;
      allUsers.forEach((u) => {
        const acc = String(
          u.accountNumber || u.accountNo || u.studentNumber || u.studentNo || "",
        ).trim();
        const match = acc.match(/^teacher\s*[-_]?\s*(\d+)/i);
        if (match) {
          const num = parseInt(match[1], 10);
          if (!isNaN(num) && num > maxNum) maxNum = num;
        }
      });
      return `Teacher-${String(maxNum + 1).padStart(3, "0")}`;
    }

    if (roleLower === "super admin") {
      let maxNum = 0;
      allUsers.forEach((u) => {
        const acc = String(
          u.accountNumber || u.accountNo || u.studentNumber || u.studentNo || "",
        ).trim();
        const match = acc.match(/^sa\s*[-_]?\s*(\d+)/i);
        if (match) {
          const num = parseInt(match[1], 10);
          if (!isNaN(num) && num > maxNum) maxNum = num;
        }
      });
      const numStr = String(maxNum + 1).padStart(3, "0");
      const suffix = sanitizeOrgSuffix(orgValue);
      return suffix ? `SA-${numStr}-${suffix}` : `SA-${numStr}`;
    }

    if (roleLower === "event organizer") {
      let maxNum = 0;
      allUsers.forEach((u) => {
        const acc = String(
          u.accountNumber || u.accountNo || u.studentNumber || u.studentNo || "",
        ).trim();
        const match = acc.match(/^eo\s*[-_]?\s*(\d+)/i);
        if (match) {
          const num = parseInt(match[1], 10);
          if (!isNaN(num) && num > maxNum) maxNum = num;
        }
      });
      const numStr = String(maxNum + 1).padStart(3, "0");
      const org = sanitizeOrgSuffix(orgValue);
      return org ? `EO-${numStr}-${org}` : `EO-${numStr}`;
    }

    if (roleLower === "admin") {
      let maxNum = 0;
      allUsers.forEach((u) => {
        const acc = String(
          u.accountNumber || u.accountNo || u.studentNumber || u.studentNo || "",
        ).trim();
        const match = acc.match(/^admin\s*[-_]?\s*(\d+)/i);
        if (match) {
          const num = parseInt(match[1], 10);
          if (!isNaN(num) && num > maxNum) maxNum = num;
        }
      });
      const numStr = String(maxNum + 1).padStart(3, "0");
      const org = sanitizeOrgSuffix(orgValue);
      return org ? `Admin-${numStr}-${org}` : `Admin-${numStr}`;
    }

    return "";
  }

  function setAccountCredentialFields(role) {
    const requiresAuth = Boolean(role);
    staffAuthFields.hidden = !requiresAuth;
    passwordInput.required = requiresAuth;
    passwordConfirmationInput.required = requiresAuth;
    if (!requiresAuth) {
      passwordInput.value = "";
      passwordConfirmationInput.value = "";
    }

    const orgField = document.getElementById("field-user-organization");
    if (orgField) {
      orgField.hidden = ["Teacher", "Super Admin"].includes(role);
    }

    const suffixField = document.getElementById("field-user-suffix");
    if (suffixField) {
      suffixField.hidden = !["Event Organizer", "Admin", "Super Admin"].includes(role);
    }

    const accountLabel = document.getElementById("new-user-account-label");
    if (accountLabel) {
      accountLabel.textContent = role === "Student" ? "Account / Student Number" : "Account Number";
    }

    const accountInput = document.getElementById("new-user-account");
    if (accountInput) {
      accountInput.readOnly = role !== "Student";
    }

    const contactInput = document.getElementById("new-user-contact");
    if (contactInput && !contactInput.value) {
      contactInput.value = "09";
    }
  }

  function authErrorMessage(error) {
    if (error?.code === "auth/email-already-in-use") {
      return "An account already exists with this email address.";
    }
    if (error?.code === "auth/weak-password") {
      return "Password must contain at least 6 characters.";
    }
    if (error?.code === "auth/invalid-email") {
      return "Enter a valid email address.";
    }
    return error?.message || "Could not create the account.";
  }

  async function provisionUserAccount(email, password, targetCollection, profile) {
    const appName = `recovibe-staff-provision-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}`;
    const provisioningApp = initializeApp(getApp().options, appName);
    const provisioningAuth = getAuth(provisioningApp);
    let userCredential;

    try {
      userCredential = await createUserWithEmailAndPassword(
        provisioningAuth,
        email,
        password,
      );
      await setDoc(
        doc(db, targetCollection, userCredential.user.uid),
        { ...profile, uid: userCredential.user.uid },
      );
      return userCredential.user.uid;
    } catch (error) {
      if (userCredential?.user) {
        try {
          await deleteUser(userCredential.user);
        } catch (cleanupError) {
          console.error("[UserManagement] Auth rollback after profile write failure failed:", {
            code: cleanupError?.code || "unknown",
            message: cleanupError?.message || String(cleanupError),
          });
        }
      }
      throw error;
    } finally {
      try {
        await signOut(provisioningAuth);
      } catch (signOutError) {
        console.warn("Unable to sign out provisioning Auth session:", signOutError);
      }
      try {
        await deleteApp(provisioningApp);
      } catch (cleanupError) {
        console.warn("Unable to clean up provisioning Firebase app:", cleanupError);
      }
    }
  }

  function normalizeUser(userId, data, collectionName) {
    const familyFirstName = [data.lastName, data.firstName]
      .map((value) => stringValue(value).trim())
      .filter(Boolean)
      .join(" ");
    const fullName =
      data.fullName || familyFirstName || data.name || data.displayName || "Unnamed User";
    const accountNumber =
      data.accountNumber ||
      data.studentNumber ||
      data.accountNo ||
      data.studentNo ||
      "—";
    const status = data.status || (data.isActive ? "Active" : "Inactive");

    return {
      ...data,
      id: userId,
      collectionName,
      fullName: stringValue(fullName, "Unnamed User"),
      accountNumber: stringValue(accountNumber, "—"),
      email: stringValue(data.email, "—"),
      role: stringValue(data.role || (collectionName === "users" ? "Student" : "Staff")),
      status,
      contactNumber: stringValue(data.contactNumber || data.phone),
      department: stringValue(data.department || data.course || data.program),
      yearSection: stringValue(data.yearSection || data.section),
      organization: stringValue(data.organization || data.org),
    };
  }

  function createCell(label, value, emphasize = false) {
    const cell = document.createElement("td");
    cell.dataset.label = label;
    if (emphasize) {
      const strong = document.createElement("strong");
      strong.textContent = value;
      cell.append(strong);
    } else {
      cell.textContent = value;
    }
    return cell;
  }

  function renderUsers() {
    const allUsers = [...studentsList, ...staffList];
    tableBody.replaceChildren();
    if (!allUsers.length) {
      const row = document.createElement("tr");
      const cell = document.createElement("td");
      cell.colSpan = 6;
      cell.className = "user-table-empty";
      cell.textContent = "No user accounts to display.";
      row.append(cell);
      tableBody.append(row);
      return;
    }

    const q = searchQuery.trim().toLowerCase();
    const filteredUsers = q
      ? allUsers.filter((user) => {
          return (
            String(user.fullName || "").toLowerCase().includes(q) ||
            String(user.accountNumber || "").toLowerCase().includes(q) ||
            String(user.email || "").toLowerCase().includes(q) ||
            String(user.role || "").toLowerCase().includes(q) ||
            String(user.status || "").toLowerCase().includes(q) ||
            String(user.department || "").toLowerCase().includes(q) ||
            String(user.organization || "").toLowerCase().includes(q)
          );
        })
      : allUsers;

    if (!filteredUsers.length) {
      const row = document.createElement("tr");
      const cell = document.createElement("td");
      cell.colSpan = 6;
      cell.className = "user-table-empty";
      cell.textContent = `No users found matching "${searchQuery.trim()}".`;
      row.append(cell);
      tableBody.append(row);
      return;
    }

    filteredUsers.forEach((user) => {
      const row = document.createElement("tr");
      row.id = `user-row-${user.collectionName}-${user.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
      row.dataset.id = user.id;
      row.dataset.collection = user.collectionName;
      row.append(
        createCell("User", user.fullName, true),
        createCell("Account No.", user.accountNumber, true),
        createCell("Email", user.email),
        createCell("Role", user.role === "student" ? "Student" : user.role),
      );
      const statusCell = document.createElement("td");
      statusCell.dataset.label = "Status";
      const statusPill = document.createElement("span");
      const statusClass = user.status.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      statusPill.className = `user-status-pill status-${statusClass}`;
      statusPill.textContent = user.status;
      statusCell.append(statusPill);
      row.append(statusCell);

      const actionCell = document.createElement("td");
      actionCell.dataset.label = "Action";
      const viewButton = document.createElement("button");
      viewButton.className = "user-view-button";
      viewButton.type = "button";
      viewButton.dataset.id = user.id;
      viewButton.dataset.collection = user.collectionName;
      viewButton.textContent = "View";
      viewButton.setAttribute("aria-label", `View ${user.fullName}`);
      actionCell.append(viewButton);
      row.append(actionCell);
      tableBody.append(row);
    });
  }

  function handleUsersSnapshot(collectionName, snapshot) {
    const mappedUsers = snapshot.docs
      .filter(
        (userDocument) =>
          collectionName !== "users" ||
          String(userDocument.data().role || userDocument.data().userRole || "")
            .trim()
            .toLowerCase() === "student",
      )
      .map((userDocument) =>
        normalizeUser(userDocument.id, userDocument.data(), collectionName),
      );
    if (collectionName === "users") {
      studentsList = mappedUsers;
    } else {
      staffList = mappedUsers;
    }
    renderUsers();

    const selectedUser = [...studentsList, ...staffList].find(
      (user) =>
        user.id === selectedUserId &&
        user.collectionName === selectedUserCollection,
    );
    if (selectedUser && detailsDialog.open) populateDetails(selectedUser);
  }

  function displayValue(value) {
    return value?.trim() || "Not provided";
  }

  function populateDetails(user) {
    document.getElementById("user-details-name").textContent = user.fullName;
    document.getElementById("user-details-role").textContent = user.role;
    document.getElementById("user-details-status").textContent = user.status;
    document.getElementById("user-detail-full-name").textContent = user.fullName;
    document.getElementById("user-detail-account-number").textContent = user.accountNumber;
    document.getElementById("user-detail-email").textContent = user.email;
    document.getElementById("user-detail-contact").textContent = displayValue(
      user.contactNumber,
    );
    document.getElementById("user-detail-department").textContent = displayValue(
      user.department,
    );
    document.getElementById("user-detail-year-section").textContent = displayValue(
      user.yearSection,
    );
    document.getElementById("user-detail-organization").textContent = displayValue(
      user.organization,
    );
    document.getElementById("user-detail-role").textContent = user.role;
    statusButton.textContent =
      user.status === "Active" ? "Suspend Account" : "Activate Account";
    document.getElementById("view-user-activity").href =
      `SuperAdminAuditLogs.html?user=${encodeURIComponent(user.id)}`;
  }

  async function openDetails(userId, collectionName) {
    try {
      const snapshot = await getDoc(doc(db, collectionName, userId));
      if (!snapshot.exists()) {
        showMessage("This user record no longer exists.", true);
        return;
      }
      const user = normalizeUser(snapshot.id, snapshot.data(), collectionName);
      selectedUserId = snapshot.id;
      selectedUserCollection = collectionName;
      populateDetails(user);
      detailsDialog.showModal();
    } catch (error) {
      console.error("Unable to fetch user document:", error);
      showMessage("Could not load user details. Please try again.", true);
    }
  }

  async function createUser(event) {
    event.preventDefault();
    const values = new FormData(createForm);
    const role = stringValue(values.get("role")).trim();
    const isAuthAccount = Boolean(role);
    setAccountCredentialFields(role);
    passwordConfirmationInput.setCustomValidity(
      isAuthAccount &&
        passwordConfirmationInput.value !== passwordInput.value
        ? "Passwords do not match."
        : "",
    );
    if (!createForm.reportValidity()) return;

    const firstName = stringValue(values.get("firstName")).trim();
    const lastName = stringValue(values.get("lastName")).trim();
    const noMiddleCheckbox = document.getElementById("new-user-no-middle-name");
    const noMiddle = Boolean(noMiddleCheckbox?.checked || values.get("noMiddleName"));
    const middleName = noMiddle ? "" : stringValue(values.get("middleName")).trim();
    const fullName = [firstName, middleName, lastName].filter(Boolean).join(" ");

    const roleSuffix = stringValue(values.get("roleSuffix")).trim().toUpperCase();
    const organization = stringValue(values.get("organizationDepartment")).trim();
    let accountNo = stringValue(values.get("accountNumber")).trim();
    if (!accountNo && role !== "Student") {
      accountNo = getNextAccountNumberForRole(role, roleSuffix || organization);
    }

    const email = stringValue(values.get("email")).trim().toLowerCase();
    const contactNumber = stringValue(values.get("contactNumber")).trim();
    const password = passwordInput.value;
    const targetCollection = role === "Student" ? "users" : "adminUser";

    const user = {
      fullName,
      name: fullName,
      firstName,
      lastName,
      middleName,
      email,
      contactNumber,
      organization: ["Teacher", "Super Admin"].includes(role) ? "" : organization,
      department: ["Teacher", "Super Admin"].includes(role) ? "" : organization,
      roleSuffix: ["Event Organizer", "Admin", "Super Admin"].includes(role) ? roleSuffix : "",
      role: role === "Student" ? "student" : role,
      uid: "",
      accountNo,
      accountNumber: accountNo,
      studentNumber: accountNo,
      status: "Active",
      isActive: true,
      createdAt: serverTimestamp(),
    };

    const submitButton = createForm.querySelector('[type="submit"]');
    submitButton.disabled = true;
    try {
      const createdUserId = await provisionUserAccount(
        email,
        password,
        targetCollection,
        user,
      );
      createForm.reset();
      createDialog.close();
      if (role !== "Student") {
        try {
          await appendUserAudit(
            `Created new ${role} account for ${fullName}`,
            createdUserId,
            targetCollection,
          );
          showMessage(`${role} account created.`);
        } catch (auditError) {
          console.error("Staff account created, but its audit log could not be saved:", auditError);
          showMessage("Account created, but its audit record could not be saved.", true);
        }
      } else {
        showMessage("Student account created.");
      }
    } catch (error) {
      console.error("[UserManagement] User account/profile creation failed:", {
        code: error?.code || "unknown",
        message: error?.message || String(error),
      });
      showMessage(
        isAuthAccount
          ? authErrorMessage(error)
          : "Could not create the user. Please try again.",
        true,
      );
    } finally {
      submitButton.disabled = false;
    }
  }

  function superAdminIdentifier() {
    const tag =
      document.querySelector(".account-badge")?.textContent.trim() || "SA1";
    const name =
      document.getElementById("superadmin-name")?.textContent.trim() ||
      "Super Admin";
    return `${tag} – ${name}`;
  }

  function escapeHTML(value) {
    return String(value ?? "").replace(
      /[&<>"']/g,
      (char) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[char],
    );
  }

  async function appendUserAudit(
    action,
    targetUserId,
    targetCollection,
    details = null,
  ) {
    await addDoc(collection(db, "audit_logs"), {
      timestamp: serverTimestamp(),
      user: superAdminIdentifier(),
      action,
      category: "User Management",
      targetUserId,
      ...(targetCollection ? { targetCollection } : {}),
      ...(details ? { details } : {}),
    });
  }

  function openEditUser() {
    const user = [...studentsList, ...staffList].find(
      (item) =>
        item.id === selectedUserId &&
        item.collectionName === selectedUserCollection,
    );
    if (!user) return;

    document.getElementById("edit-user-fullname").value = user.fullName || "";
    document.getElementById("edit-user-account-number").value =
      user.accountNumber !== "—" ? user.accountNumber : "";
    document.getElementById("edit-user-email").value =
      user.email !== "—" ? user.email : "";
    const existingContact =
      user.contactNumber && user.contactNumber !== "—"
        ? String(user.contactNumber).trim()
        : "";
    document.getElementById("edit-user-contact").value = existingContact
      ? (existingContact.startsWith("09")
          ? existingContact
          : "09" + existingContact.replace(/^0+/, ""))
      : "09";
    document.getElementById("edit-user-department").value =
      user.department || "";
    document.getElementById("edit-user-year-section").value =
      user.yearSection || "";
    document.getElementById("edit-user-organization").value =
      user.organization || "";

    const roleSelect = document.getElementById("edit-user-role");
    const currentRoleLower = String(user.role || "").toLowerCase().trim();
    let matched = false;
    for (const option of roleSelect.options) {
      if (option.value.toLowerCase() === currentRoleLower) {
        option.selected = true;
        matched = true;
        break;
      }
    }
    if (!matched && user.role) {
      roleSelect.value = user.role;
    }

    const statusSelect = document.getElementById("edit-user-status");
    const currentStatusLower = String(user.status || "").toLowerCase().trim();
    if (currentStatusLower === "suspended") {
      statusSelect.value = "Suspended";
    } else if (currentStatusLower === "inactive") {
      statusSelect.value = "Inactive";
    } else {
      statusSelect.value = "Active";
    }

    editDialog.showModal();
    document.getElementById("edit-user-fullname").focus();
  }

  function handleEditSubmit(event) {
    event.preventDefault();
    const user = [...studentsList, ...staffList].find(
      (item) =>
        item.id === selectedUserId &&
        item.collectionName === selectedUserCollection,
    );
    if (!user) return;

    if (!editForm.reportValidity()) return;

    const newFullName = stringValue(
      document.getElementById("edit-user-fullname").value,
    ).trim();
    const newAccountNumber = stringValue(
      document.getElementById("edit-user-account-number").value,
    ).trim();
    const newEmail = stringValue(
      document.getElementById("edit-user-email").value,
    )
      .trim()
      .toLowerCase();
    const newContact = stringValue(
      document.getElementById("edit-user-contact").value,
    ).trim();
    const newDepartment = stringValue(
      document.getElementById("edit-user-department").value,
    ).trim();
    const newYearSection = stringValue(
      document.getElementById("edit-user-year-section").value,
    ).trim();
    const newOrganization = stringValue(
      document.getElementById("edit-user-organization").value,
    ).trim();
    const newRole = document.getElementById("edit-user-role").value;
    const newStatus = document.getElementById("edit-user-status").value;

    const changes = [];
    if (newFullName !== user.fullName) {
      changes.push({
        field: "Full Name",
        old: user.fullName,
        next: newFullName,
      });
    }
    const currentAccount = user.accountNumber !== "—" ? user.accountNumber : "";
    if (newAccountNumber !== currentAccount) {
      changes.push({
        field: "Account Number",
        old: currentAccount || "Not provided",
        next: newAccountNumber || "Not provided",
      });
    }
    const currentEmail = user.email !== "—" ? user.email : "";
    if (newEmail !== currentEmail.toLowerCase()) {
      changes.push({
        field: "Email",
        old: currentEmail || "Not provided",
        next: newEmail || "Not provided",
      });
    }
    if (newContact !== (user.contactNumber || "")) {
      changes.push({
        field: "Contact Number",
        old: user.contactNumber || "Not provided",
        next: newContact || "Not provided",
      });
    }
    if (newDepartment !== (user.department || "")) {
      changes.push({
        field: "Department / Program",
        old: user.department || "Not provided",
        next: newDepartment || "Not provided",
      });
    }
    if (newYearSection !== (user.yearSection || "")) {
      changes.push({
        field: "Year & Section",
        old: user.yearSection || "Not provided",
        next: newYearSection || "Not provided",
      });
    }
    if (newOrganization !== (user.organization || "")) {
      changes.push({
        field: "Organization / Department",
        old: user.organization || "Not provided",
        next: newOrganization || "Not provided",
      });
    }
    if (newRole.toLowerCase() !== String(user.role || "").toLowerCase()) {
      changes.push({ field: "Role", old: user.role, next: newRole });
    }
    if (newStatus !== user.status) {
      changes.push({ field: "Status", old: user.status, next: newStatus });
    }

    pendingEditPayload = {
      newFullName,
      newAccountNumber,
      newEmail,
      newContact,
      newDepartment,
      newYearSection,
      newOrganization,
      newRole,
      newStatus,
      user,
    };
    pendingEditChanges = changes;

    confirmMessage.textContent = `Are you sure you want to save the changes made to ${user.fullName}'s account?`;
    if (changes.length === 0) {
      confirmSummary.innerHTML =
        '<p style="margin: 0; color: #51484a; text-align: center; font-style: italic;">No field values were changed. Click Confirm & Save to keep current information.</p>';
    } else {
      confirmSummary.innerHTML = changes
        .map(
          (item) => `
            <div class="confirm-change-item">
              <span class="confirm-change-field">${escapeHTML(item.field)}:</span>
              <span class="confirm-change-values">
                <del>${escapeHTML(item.old)}</del> → <strong>${escapeHTML(item.next)}</strong>
              </span>
            </div>`,
        )
        .join("");
    }

    confirmDialog.showModal();
  }

  async function confirmAndSaveEdit() {
    if (!pendingEditPayload || confirmSaveButton.disabled) return;
    const {
      newFullName,
      newAccountNumber,
      newEmail,
      newContact,
      newDepartment,
      newYearSection,
      newOrganization,
      newRole,
      newStatus,
      user,
    } = pendingEditPayload;

    confirmSaveButton.disabled = true;
    confirmSaveButton.textContent = "Saving...";
    if (cancelConfirmButton) cancelConfirmButton.disabled = true;

    try {
      const nameParts = newFullName.split(/\s+/).filter(Boolean);
      const firstName = nameParts[0] || "";
      const lastName =
        nameParts.length > 1 ? nameParts[nameParts.length - 1] : "";
      const middleName = nameParts.slice(1, -1).join(" ");

      const updatePayload = {
        fullName: newFullName,
        name: newFullName,
        firstName,
        lastName,
        middleName,
        email: newEmail,
        contactNumber: newContact,
        phone: newContact,
        department: newDepartment,
        course: newDepartment,
        program: newDepartment,
        yearSection: newYearSection,
        section: newYearSection,
        organization: newOrganization,
        org: newOrganization,
        role: newRole,
        status: newStatus,
        isActive: newStatus === "Active",
        updatedAt: serverTimestamp(),
      };

      if (user.collectionName === "users") {
        updatePayload.studentNumber = newAccountNumber;
        updatePayload.studentNo = newAccountNumber;
        updatePayload.accountNo = newAccountNumber;
      } else {
        updatePayload.accountNo = newAccountNumber;
      }

      await updateDoc(doc(db, user.collectionName, user.id), updatePayload);

      const changesSummary = pendingEditChanges
        .map((ch) => `${ch.field}: ${ch.old} → ${ch.next}`)
        .join("; ");
      const auditAction =
        pendingEditChanges.length > 0
          ? `Edited user information for ${newFullName} (${newRole}): ${changesSummary}`
          : `Edited user information for ${newFullName} (${newRole})`;

      try {
        await appendUserAudit(
          auditAction,
          user.id,
          user.collectionName,
          changesSummary || "Updated without field modifications",
        );
      } catch (auditError) {
        console.error(
          "User updated, but audit log could not be saved:",
          auditError,
        );
      }

      confirmDialog.close();
      editDialog.close();
      showMessage(`Updated account information for ${newFullName}.`);

      const updatedUser = normalizeUser(
        user.id,
        { ...user, ...updatePayload },
        user.collectionName,
      );
      populateDetails(updatedUser);
    } catch (error) {
      console.error("Unable to update user information:", error);
      showMessage("Could not update user information. Please try again.", true);
    } finally {
      confirmSaveButton.disabled = false;
      confirmSaveButton.textContent = "Confirm & Save";
      if (cancelConfirmButton) cancelConfirmButton.disabled = false;
      pendingEditPayload = null;
      pendingEditChanges = [];
    }
  }

  function openSuspendConfirmation() {
    const user = [...studentsList, ...staffList].find(
      (item) =>
        item.id === selectedUserId &&
        item.collectionName === selectedUserCollection,
    );
    if (!user || statusButton.disabled || deleteButton.disabled) return;
    const reactivating =
      String(user.status || "").toLowerCase() === "suspended";

    if (statusConfirmTitle) {
      statusConfirmTitle.textContent = reactivating
        ? "Reactivate Account"
        : "Suspend Account";
    }
    if (statusConfirmMessage) {
      statusConfirmMessage.textContent = reactivating
        ? `Are you sure you want to reactivate ${user.fullName}'s account? They will regain access to their account.`
        : `Are you sure you want to suspend ${user.fullName}'s account? They will temporarily be unable to log in or access the system.`;
    }
    if (statusConfirmActionButton) {
      statusConfirmActionButton.textContent = reactivating
        ? "Reactivate Account"
        : "Suspend Account";
      statusConfirmActionButton.className = reactivating
        ? "user-modal-button primary"
        : "user-modal-button danger";
    }
    statusConfirmDialog?.showModal();
  }

  async function confirmAndToggleUserStatus() {
    const user = [...studentsList, ...staffList].find(
      (item) =>
        item.id === selectedUserId &&
        item.collectionName === selectedUserCollection,
    );
    if (!user) return;
    const reactivating =
      String(user.status || "").toLowerCase() === "suspended";
    const nextStatus = reactivating ? "Active" : "Suspended";

    if (statusConfirmActionButton) {
      statusConfirmActionButton.disabled = true;
      statusConfirmActionButton.textContent = reactivating
        ? "Reactivating…"
        : "Suspending…";
    }
    if (cancelStatusConfirmButton) cancelStatusConfirmButton.disabled = true;
    statusButton.disabled = true;
    deleteButton.disabled = true;

    try {
      await updateDoc(doc(db, user.collectionName, user.id), {
        status: nextStatus,
        isActive: nextStatus === "Active",
        updatedAt: serverTimestamp(),
      });
      try {
        await appendUserAudit(
          `${reactivating ? "Reactivated" : "Suspended"} account of ${user.fullName}`,
          user.id,
          user.collectionName,
        );
        showMessage(
          `${user.fullName}'s account was ${reactivating ? "reactivated" : "suspended"}.`,
        );
      } catch (auditError) {
        console.error(
          "Status changed, but its audit log could not be saved:",
          auditError,
        );
        showMessage(
          "Status changed, but its audit log could not be saved.",
          true,
        );
      }
      statusConfirmDialog?.close();
      detailsDialog.close();
    } catch (error) {
      console.error("Unable to update user status:", error);
      showMessage("Could not update user status. Please try again.", true);
    } finally {
      statusButton.disabled = false;
      deleteButton.disabled = false;
      if (statusConfirmActionButton) {
        statusConfirmActionButton.disabled = false;
        statusConfirmActionButton.textContent = reactivating
          ? "Reactivate Account"
          : "Suspend Account";
      }
      if (cancelStatusConfirmButton)
        cancelStatusConfirmButton.disabled = false;
    }
  }

  function openDeleteConfirmation() {
    const user = [...studentsList, ...staffList].find(
      (item) =>
        item.id === selectedUserId &&
        item.collectionName === selectedUserCollection,
    );
    if (!user || statusButton.disabled || deleteButton.disabled) return;

    const identifier = user.email !== "—" ? user.email : user.accountNumber;
    if (deleteConfirmMessage) {
      deleteConfirmMessage.textContent = `Are you sure you want to permanently delete ${user.fullName}'s account (${identifier})? This action cannot be undone.`;
    }
    deleteConfirmDialog?.showModal();
  }

  async function confirmAndDeleteUser() {
    const user = [...studentsList, ...staffList].find(
      (item) =>
        item.id === selectedUserId &&
        item.collectionName === selectedUserCollection,
    );
    if (!user) return;

    if (deleteConfirmActionButton) {
      deleteConfirmActionButton.disabled = true;
      deleteConfirmActionButton.textContent = "Deleting…";
    }
    if (cancelDeleteConfirmButton) cancelDeleteConfirmButton.disabled = true;
    statusButton.disabled = true;
    deleteButton.disabled = true;

    try {
      await deleteDoc(doc(db, user.collectionName, user.id));
      const identifier = user.email !== "—" ? user.email : user.accountNumber;
      try {
        await appendUserAudit(
          `Permanently deleted account: ${user.fullName} (${identifier})`,
          user.id,
          user.collectionName,
        );
        showMessage(`${user.fullName}'s account was deleted.`);
      } catch (auditError) {
        console.error(
          "User deleted, but its audit log could not be saved:",
          auditError,
        );
        showMessage(
          "User deleted, but its audit log could not be saved.",
          true,
        );
      }
      deleteConfirmDialog?.close();
      detailsDialog.close();
    } catch (error) {
      console.error("Unable to delete user:", error);
      showMessage("Could not delete the user. Please try again.", true);
    } finally {
      statusButton.disabled = false;
      deleteButton.disabled = false;
      if (deleteConfirmActionButton) {
        deleteConfirmActionButton.disabled = false;
        deleteConfirmActionButton.textContent = "Delete Account";
      }
      if (cancelDeleteConfirmButton)
        cancelDeleteConfirmButton.disabled = false;
    }
  }

  let isAccountManuallyEdited = false;
  const newUserAccountInput = document.getElementById("new-user-account");
  const newUserOrgInput = document.getElementById("new-user-organization");
  const newUserSuffixInput = document.getElementById("new-user-role-suffix");
  const noMiddleCheckbox = document.getElementById("new-user-no-middle-name");
  const middleInput = document.getElementById("new-user-middle-name");

  function syncStaffAccountNumber() {
    const role =
      document.getElementById("new-user-role-value")?.value ||
      document.getElementById("new-user-role")?.value ||
      "";
    if (!["Event Organizer", "Admin", "Super Admin", "Teacher"].includes(role)) {
      return;
    }
    if (!newUserAccountInput) return;

    if (role === "Teacher") {
      newUserAccountInput.value = getNextAccountNumberForRole("Teacher", "");
      return;
    }

    const suffix =
      newUserSuffixInput?.value?.trim() ||
      newUserOrgInput?.value?.trim() ||
      "";
    newUserAccountInput.value = getNextAccountNumberForRole(role, suffix);
  }

  if (newUserAccountInput) {
    newUserAccountInput.addEventListener("input", () => {
      const role =
        document.getElementById("new-user-role-value")?.value ||
        document.getElementById("new-user-role")?.value;
      if (role === "Student") {
        isAccountManuallyEdited = true;
      }
    });
  }

  if (newUserSuffixInput) {
    newUserSuffixInput.addEventListener("input", () => {
      const cursor = newUserSuffixInput.selectionStart;
      newUserSuffixInput.value = newUserSuffixInput.value.toUpperCase();
      if (cursor != null) {
        newUserSuffixInput.setSelectionRange(cursor, cursor);
      }
      syncStaffAccountNumber();
    });
  }

  if (newUserOrgInput) {
    newUserOrgInput.addEventListener("input", () => {
      if (!newUserSuffixInput?.value?.trim()) {
        syncStaffAccountNumber();
      }
    });
  }

  function setupContactNumberField(input) {
    if (!input) return;
    if (!input.value) {
      input.value = "09";
    }

    input.addEventListener("focus", () => {
      if (!input.value) {
        input.value = "09";
      }
      setTimeout(() => {
        if (input.selectionStart < 2) {
          input.setSelectionRange(2, 2);
        }
      }, 0);
    });

    input.addEventListener("click", () => {
      if (input.selectionStart < 2) {
        input.setSelectionRange(2, 2);
      }
    });

    input.addEventListener("keydown", (event) => {
      const start = input.selectionStart ?? 0;
      const end = input.selectionEnd ?? start;
      if (event.key === "Backspace" && start <= 2 && end <= 2) {
        event.preventDefault();
        input.value = "09";
        input.setSelectionRange(2, 2);
      }
    });

    input.addEventListener("input", () => {
      let raw = input.value.replace(/\D/g, "");
      if (!raw.startsWith("09")) {
        if (raw.startsWith("9")) {
          raw = "0" + raw;
        } else if (raw.startsWith("0")) {
          raw = "09" + raw.slice(1);
        } else {
          raw = "09" + raw;
        }
      }
      if (raw.length > 11) {
        raw = raw.slice(0, 11);
      }
      input.value = raw;
    });
  }

  const newUserContactInput = document.getElementById("new-user-contact");
  const editUserContactInput = document.getElementById("edit-user-contact");
  setupContactNumberField(newUserContactInput);
  setupContactNumberField(editUserContactInput);

  if (noMiddleCheckbox && middleInput) {
    noMiddleCheckbox.addEventListener("change", () => {
      if (noMiddleCheckbox.checked) {
        middleInput.value = "";
        middleInput.disabled = true;
      } else {
        middleInput.disabled = false;
        middleInput.focus();
      }
    });
  }

  document.getElementById("create-user-button").addEventListener("click", () => {
    roleDialog.showModal();
    roleDialog.querySelector("[data-select-role]").focus();
  });

  roleDialog.querySelectorAll("[data-select-role]").forEach((button) => {
    button.addEventListener("click", () => {
      const role = button.dataset.selectRole;
      document.getElementById("new-user-role").value = role;
      document.getElementById("new-user-role-value").value = role;
      setAccountCredentialFields(role);
      isAccountManuallyEdited = false;
      if (newUserSuffixInput) newUserSuffixInput.value = "";
      if (newUserAccountInput) {
        newUserAccountInput.placeholder =
          role === "Student" ? "e.g. 2025-00760-BN-1" : "";
        if (role === "Student") {
          newUserAccountInput.value = "";
        }
      }
      syncStaffAccountNumber();
      if (newUserContactInput) {
        newUserContactInput.value = "09";
      }
      roleDialog.close();
      createDialog.showModal();
      (createForm.elements.firstName || createForm.elements.lastName)?.focus();
    });
  });

  if (searchInput) {
    searchInput.addEventListener("input", () => {
      searchQuery = searchInput.value;
      renderUsers();
    });
  }

  createForm.addEventListener("submit", createUser);
  tableBody.addEventListener("click", (event) => {
    const viewButton = event.target.closest("button[data-id]");
    if (viewButton) {
      openDetails(viewButton.dataset.id, viewButton.dataset.collection);
    }
  });
  if (editButton) editButton.addEventListener("click", openEditUser);
  if (editForm) editForm.addEventListener("submit", handleEditSubmit);
  if (confirmSaveButton)
    confirmSaveButton.addEventListener("click", confirmAndSaveEdit);
  if (cancelConfirmButton) {
    cancelConfirmButton.addEventListener("click", () => confirmDialog.close());
  }
  statusButton.addEventListener("click", openSuspendConfirmation);
  deleteButton.addEventListener("click", openDeleteConfirmation);
  if (statusConfirmActionButton)
    statusConfirmActionButton.addEventListener("click", confirmAndToggleUserStatus);
  if (deleteConfirmActionButton)
    deleteConfirmActionButton.addEventListener("click", confirmAndDeleteUser);

  document.querySelectorAll("[data-close-dialog]").forEach((button) => {
    button.addEventListener("click", () => button.closest("dialog").close());
  });

  [
    roleDialog,
    createDialog,
    detailsDialog,
    editDialog,
    confirmDialog,
    statusConfirmDialog,
    deleteConfirmDialog,
  ].forEach((dialog) => {
    dialog?.addEventListener("click", (event) => {
      if (event.target === dialog) dialog.close();
    });
  });

  editDialog?.addEventListener("close", () => {
    editForm.reset();
    pendingEditPayload = null;
    pendingEditChanges = [];
  });
  confirmDialog?.addEventListener("close", () => {
    confirmSummary.innerHTML = "";
  });

  createDialog.addEventListener("close", () => {
    createForm.reset();
    if (noMiddleCheckbox) noMiddleCheckbox.checked = false;
    if (middleInput) middleInput.disabled = false;
    isAccountManuallyEdited = false;
    if (newUserSuffixInput) newUserSuffixInput.value = "";
    if (newUserContactInput) newUserContactInput.value = "09";
    setAccountCredentialFields("");
    passwordConfirmationInput.setCustomValidity("");
  });
  detailsDialog.addEventListener("close", () => {
    selectedUserId = null;
    selectedUserCollection = null;
    [
      "user-details-name",
      "user-details-role",
      "user-details-status",
      "user-detail-full-name",
      "user-detail-account-number",
      "user-detail-email",
      "user-detail-contact",
      "user-detail-department",
      "user-detail-year-section",
      "user-detail-organization",
      "user-detail-role",
    ].forEach((id) => {
      document.getElementById(id).textContent = "";
    });
    statusButton.textContent = "Suspend Account";
    document.getElementById("view-user-activity").href =
      "SuperAdminAuditLogs.html";
  });

  if (!isFirebaseConfigured || !db) {
    tableBody.innerHTML =
      '<tr><td class="user-table-empty" colspan="6">User data is unavailable. Please check Firebase configuration.</td></tr>';
    return;
  }

  tableBody.innerHTML =
    '<tr><td class="user-table-empty" colspan="6">Loading user accounts…</td></tr>';
  unsubscribeStudents = onSnapshot(
    collection(db, "users"),
    (snapshot) => {
      console.info("[UserManagement] users snapshot size:", snapshot.size);
      handleUsersSnapshot("users", snapshot);
    },
    (error) => {
      console.error("Unable to load student accounts:", error);
      showMessage("Could not load student accounts.", true);
    },
  );

  unsubscribeStaff = onSnapshot(
    collection(db, "adminUser"),
    (snapshot) => {
      console.info("[UserManagement] adminUser snapshot size:", snapshot.size);
    handleUsersSnapshot("adminUser", snapshot);
    },
    (error) => {
      console.error("Unable to load adminUser accounts:", error);
      showMessage("Could not load staff accounts.", true);
    },
  );

  window.addEventListener("beforeunload", () => {
    unsubscribeStudents?.();
    unsubscribeStaff?.();
  });
})();
