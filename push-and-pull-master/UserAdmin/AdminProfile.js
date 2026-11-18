import {
  EmailAuthProvider,
  reauthenticateWithCredential,
  signOut,
  updatePassword,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { push, ref, set } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import { auth, authReady, db, isRtdbConfigured, rtdb } from "../UserStudent/firebaseConfig.js";

(async () => {
  "use strict";
  import("./AdminNotificationData.js")
    .then(({ startAdminNotificationBadge }) => startAdminNotificationBadge())
    .catch(() => document.querySelectorAll("[data-notification-count]").forEach((badge) => { badge.hidden = true; }));
  let profile = {};
  let firebaseUser = null;
  const cachedProfile = read("recovibeAdminProfile", {}),
    identity = localStorage.getItem("recovibeAdminId") || "";
  const root = document.getElementById("profileRoot"),
    toastElement = document.querySelector(".admin-toast"),
    namePattern = /^[A-Z][a-z]*(?: [A-Z][a-z]*)*$/,
    phonePattern = /^(09\d{9}|\+639\d{9})$/;
  let profileLoadExpired = false;
  let pageLoadSignaled = false;
  const signalProfilePageReady = () => {
    if (pageLoadSignaled) return;
    pageLoadSignaled = true;
    window.dispatchEvent(new Event("page-data-ready"));
  };
  const profileLoadTimer = setTimeout(() => {
    profileLoadExpired = true;
    root.innerHTML = '<div class="admin-error" role="alert">Could not load your verified Admin profile in time. <button class="admin-row-action" type="button" id="retryAdminProfile">Try again</button></div>';
    root.querySelector("#retryAdminProfile").addEventListener("click", () => window.location.reload());
    signalProfilePageReady();
  }, 9000);
  try {
    await authReady;
    if (profileLoadExpired) return;
    if (!auth || !db) throw new Error("Firebase authentication is unavailable.");
    await auth.authStateReady();
    if (profileLoadExpired) return;
    const user = auth.currentUser;
    if (!user) {
      clearTimeout(profileLoadTimer);
      location.replace("AdminLogin.html");
      return;
    }
    firebaseUser = user;
    const [adminResult, userResult] = await Promise.allSettled([
      getDoc(doc(db, "adminUser", user.uid)),
      getDoc(doc(db, "users", user.uid)),
    ]);
    if (profileLoadExpired) return;
    const adminProfile = adminResult.status === "fulfilled" && adminResult.value.exists()
      ? adminResult.value.data()
      : {};
    const userProfile = userResult.status === "fulfilled" && userResult.value.exists()
      ? userResult.value.data()
      : {};
    if (adminResult.status === "rejected" && userResult.status === "rejected") {
      throw adminResult.reason;
    }
    const sameAccountCache = cachedProfile.uid === user.uid ? cachedProfile : {};
    profile = {
      ...userProfile,
      ...adminProfile,
      firstName: sameAccountCache.firstName || userProfile.firstName || adminProfile.firstName,
      middleName: sameAccountCache.middleName ?? userProfile.middleName ?? adminProfile.middleName,
      lastName: sameAccountCache.lastName || userProfile.lastName || adminProfile.lastName,
      name: sameAccountCache.name || userProfile.name || adminProfile.name,
      contactNumber: sameAccountCache.contactNumber ?? userProfile.contactNumber ?? adminProfile.contactNumber,
      uid: user.uid,
      email: user.email || userProfile.email || adminProfile.email || "",
    };
    const verifiedRole = String(profile.role || profile.userRole || "").trim().toLowerCase().replace(/[\s_-]+/g, "");
    if (verifiedRole !== "admin") {
      clearTimeout(profileLoadTimer);
      location.replace("AdminLogin.html");
      return;
    }
    clearTimeout(profileLoadTimer);
  } catch (error) {
    clearTimeout(profileLoadTimer);
    if (profileLoadExpired) return;
    console.error("Could not verify the signed-in Admin profile:", error);
    root.innerHTML = '<div class="admin-error" role="alert">Could not load your verified Admin profile. <button class="admin-row-action" type="button" id="retryAdminProfile">Try again</button></div>';
    root.querySelector("#retryAdminProfile").addEventListener("click", () => window.location.reload());
    signalProfilePageReady();
    return;
  }
  let editing = false,
    dirty = false;
  const fullName =
    profile.fullName ||
    profile.name ||
    [profile.firstName, profile.middleName, profile.lastName]
      .filter(Boolean)
      .join(" ") ||
    firebaseUser.displayName ||
    (firebaseUser.email || identity).split("@")[0];
  const nameParts = fullName.trim().split(/\s+/);
  profile.firstName = profile.firstName || nameParts[0] || "";
  profile.lastName =
    profile.lastName || nameParts.length > 1
      ? profile.lastName || nameParts.at(-1)
      : "";
  profile.middleName =
    profile.middleName ||
    (nameParts.length > 2 ? nameParts.slice(1, -1).join(" ") : "");
  document.querySelector("[data-name]").textContent = fullName.toUpperCase();
  document.querySelector("[data-avatar]").textContent = fullName
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
  document.querySelector(".admin-logout").onclick = async (event) => {
    event.preventDefault();
    try {
      await signOut(auth);
    } finally {
      ["recovibeAdminId", "recovibeAdminProfile"].forEach((key) => localStorage.removeItem(key));
      location.replace("AdminLogin.html");
    }
  };
  root.innerHTML = `<section class="admin-profile-card"><h2>Personal Information</h2><div class="profile-summary-grid" id="profileSummary"></div><div class="admin-profile-actions"><button class="admin-button" id="editProfile" type="button">Edit Profile</button><button class="admin-button" id="changePassword" type="button">Change Password</button></div><form class="admin-profile-form" id="profileForm" hidden novalidate><div class="admin-field"><label for="firstName">First Name</label><input id="firstName" autocomplete="given-name"></div><div class="admin-field"><label for="middleName">Middle Name</label><input id="middleName" autocomplete="additional-name"></div><label class="admin-checkbox"><input id="noMiddleName" type="checkbox"> I don't have a middle name</label><div class="admin-field"><label for="lastName">Last Name</label><input id="lastName" autocomplete="family-name"></div><div class="admin-field"><label for="emailAddress">Email Address</label><input id="emailAddress" type="email" readonly></div><div class="admin-field"><label for="contactNumber">Contact Number</label><input id="contactNumber" type="tel" autocomplete="tel" placeholder="09XXXXXXXXX or +639XXXXXXXXX"></div><p class="admin-error-text" id="profileError" role="alert"></p><div class="admin-profile-actions"><button class="admin-button green" type="submit">Save</button><button class="admin-button" id="cancelEdit" type="button">Cancel</button></div></form></section><div class="admin-modal-backdrop" id="passwordLayer" hidden style="display:none"><section class="admin-dialog admin-password-dialog" role="dialog" aria-modal="true" aria-labelledby="passwordTitle" tabindex="-1"><button class="admin-close" id="passwordClose" type="button" aria-label="Close password dialog">×</button><h2 id="passwordTitle">Change Password</h2><form id="passwordForm" novalidate><div class="admin-field"><label for="currentPassword">Current Password</label><div class="password-control"><input id="currentPassword" type="password" autocomplete="current-password"><button type="button" data-toggle="currentPassword" aria-label="Show current password">◉</button></div></div><div class="admin-field"><label for="newPassword">New Password</label><div class="password-control"><input id="newPassword" type="password" autocomplete="new-password"><button type="button" data-toggle="newPassword" aria-label="Show new password">◉</button></div></div><p class="password-rules">At least 8 characters, including uppercase, lowercase, and a number.</p><div class="admin-field"><label for="confirmPassword">Confirm New Password</label><div class="password-control"><input id="confirmPassword" type="password" autocomplete="new-password"><button type="button" data-toggle="confirmPassword" aria-label="Show confirmation password">◉</button></div></div><p class="admin-error-text" id="passwordError" role="alert"></p><div class="admin-dialog-actions"><button class="admin-button green" type="submit">Update Password</button><button class="admin-button" id="cancelPassword" type="button">Cancel</button></div></form></section></div>`;
  const passwordLayerMarkup = root.querySelector("#passwordLayer").outerHTML;
  const adminId = String(profile.accountNumber || profile.accountNo || profile.adminId || profile.admin_id || profile.approverId || profile.approver_id || profile.employeeId || profile.employee_id || "").trim();
  const stageLabels = {
    org_adv: "Organization Adviser",
    sir_abelida: "Laboratory Head, Property Custodian, Administrative Officer",
    hap: "Head of Academic Programs, QAC Coordinator (HAP)",
    osas: "OSAS",
  };
  const normalizeStageValue = (value) => String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  const stageIdentity = [
    profile.accountNumber, profile.accountNo, profile.account_number, profile.account_no,
    profile.approvalStage, profile.approvalStageKey, profile.assignedApprovalStage,
    profile.approverStage, profile.approverKey, profile.approvalRole,
    profile.approverRole, profile.assignedRole, profile.assignedApprover,
    profile.adminRole, profile.roleName, profile.stageKey, profile.position,
  ].map(normalizeStageValue);
  const stageAliases = {
    org_adv: ["orgadv", "orgadviser", "organizationadviser", "organizationadviserreview", "adviser"],
    sir_abelida: ["sirabelida", "abelida", "abelidas", "laboratoryhead", "propertycustodian", "administrativeofficer", "labhead"],
    hap: ["hap", "headofacademicprograms", "qaccoordinator", "headofacademicprogramsqaccoordinator"],
    osas: ["osas", "osasreview"],
  };
  const accountStageValues = [
    profile.accountNumber, profile.accountNo, profile.account_number, profile.account_no,
  ].map(normalizeStageValue);
  const accountStageKey = accountStageValues.some((value) => value.includes("administrative"))
    ? "sir_abelida"
    : accountStageValues.some((value) => value.includes("orgadviser") || value.includes("orgadvisor"))
      ? "org_adv"
      : accountStageValues.some((value) => value.includes("hap"))
        ? "hap"
        : accountStageValues.some((value) => value.includes("osas"))
          ? "osas"
          : null;
  const currentStageKey = accountStageKey || Object.keys(stageAliases).find((key) =>
    stageAliases[key].some((alias) => stageIdentity.includes(alias)),
  );
  const position = stageLabels[currentStageKey] ||
    String(profile.position || profile.title || profile.role_title || profile.approver_role || profile.approverRole || "").trim();
  const role = String(profile.role || profile.userRole || "").trim();
  const campus = String(profile.campus || "PUP Biñan Campus").trim();
  document.querySelector("[data-role]").textContent = position;
  document.querySelector("[data-role]").title = position;
  root.innerHTML = `<section class="content-container"><header class="hero-banner"><div class="hero-left"><div class="hero-avatar" id="heroAvatar" aria-hidden="true"></div><div class="hero-info"><h1 class="hero-name" id="heroUserName"></h1><div class="hero-badges"><span class="hero-badge" id="heroRoleBadge"></span></div></div></div><div class="hero-actions"><button type="button" class="btn-outlined-hero" id="changePassword">Change password</button></div></header><section class="profile-cards-grid"><article class="profile-card"><div class="card-header-flex"><h2 class="card-title">Name</h2><button type="button" class="btn-outlined-card" id="editProfile" data-edit-profile>Edit</button></div><div class="card-view-mode" id="profileSummary"><div class="fields-grid cols-3"><div class="field-item"><span class="field-label">First Name</span><span class="field-value" id="viewFirstName"></span></div><div class="field-item"><span class="field-label">Middle Name</span><span class="field-value" id="viewMiddleName"></span></div><div class="field-item"><span class="field-label">Last Name</span><span class="field-value" id="viewLastName"></span></div></div></div><form class="admin-profile-form card-edit-mode" id="profileForm" hidden novalidate><div class="admin-field"><label for="firstName">First Name</label><input id="firstName" autocomplete="given-name"></div><div class="admin-field"><label for="middleName">Middle Name</label><input id="middleName" autocomplete="additional-name"></div><label class="admin-checkbox"><input id="noMiddleName" type="checkbox"> I don't have a middle name</label><div class="admin-field"><label for="lastName">Last Name</label><input id="lastName" autocomplete="family-name"></div><p class="admin-error-text" id="profileError" role="alert"></p><div class="admin-profile-actions"><button class="admin-button green" type="submit">Save</button><button class="admin-button" id="cancelEdit" type="button">Cancel</button></div></form></article><article class="profile-card"><div class="card-header-flex"><h2 class="card-title">Contact</h2><button type="button" class="btn-outlined-card" data-edit-profile>Edit</button></div><div class="card-view-mode" id="contactSummary"><div class="fields-grid cols-2"><div class="field-item"><span class="field-label">Email Address</span><span class="field-value" id="viewEmail"></span></div><div class="field-item"><span class="field-label">Contact Number</span><span class="field-value" id="viewContact"></span></div></div></div></article><article class="profile-card full-width-card"><div class="card-header-flex card-title-locked-row"><h2 class="card-title">Admin details</h2><span class="badge-locked"><svg class="label-lock" viewBox="0 0 20 20" fill="currentColor" width="12" height="12" aria-hidden="true"><path fill-rule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clip-rule="evenodd" /></svg> Locked</span></div><div class="fields-grid cols-4-responsive"><div class="field-item"><span class="field-label"><svg class="label-lock" viewBox="0 0 20 20" fill="currentColor" width="11" height="11" aria-hidden="true"><path fill-rule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clip-rule="evenodd"/></svg> Admin ID</span><span class="field-value" id="viewAdminId"></span></div><div class="field-item"><span class="field-label"><svg class="label-lock" viewBox="0 0 20 20" fill="currentColor" width="11" height="11" aria-hidden="true"><path fill-rule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clip-rule="evenodd"/></svg> Position</span><span class="field-value" id="viewPosition"></span></div><div class="field-item"><span class="field-label"><svg class="label-lock" viewBox="0 0 20 20" fill="currentColor" width="11" height="11" aria-hidden="true"><path fill-rule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clip-rule="evenodd"/></svg> Role</span><span class="field-value" id="viewRole"></span></div><div class="field-item"><span class="field-label"><svg class="label-lock" viewBox="0 0 20 20" fill="currentColor" width="11" height="11" aria-hidden="true"><path fill-rule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clip-rule="evenodd"/></svg> Campus</span><span class="field-value" id="viewCampus"></span></div></div><div class="locked-note-box"><p class="locked-note-text">These details come from school records, so you cannot change them here. If something is wrong, ask OSAS to correct it.</p><button type="button" class="btn-outlined-card" id="btnRequestCorrection">Request a correction</button></div></article></section></section>${passwordLayerMarkup}`;
  root.querySelector("#heroAvatar").textContent = fullName.split(/\s+/).map((part) => part[0]).filter(Boolean).slice(0, 1).join("").toUpperCase();
  root.querySelector("#heroUserName").textContent = fullName;
  root.querySelector("#heroRoleBadge").textContent = role || "Not set";
  root.querySelector("#viewAdminId").textContent = adminId || "Not set";
  root.querySelector("#viewPosition").textContent = position || "Not set";
  root.querySelector("#viewRole").textContent = role || "Not set";
  root.querySelector("#viewCampus").textContent = campus || "Not set";
  root.querySelector("#profileError").insertAdjacentHTML("beforebegin", '<div class="admin-field"><label for="emailAddress">Email Address</label><input id="emailAddress" type="email" readonly></div><div class="admin-field"><label for="contactNumber">Contact Number</label><input id="contactNumber" type="tel" autocomplete="tel" placeholder="09XXXXXXXXX or +639XXXXXXXXX"></div>');
  root.insertAdjacentHTML("beforeend", '<div class="admin-correction-overlay" id="correctionModal" hidden><div class="admin-correction-dialog" role="dialog" aria-modal="true" aria-labelledby="correctionTitle"><button type="button" class="admin-close" id="closeCorrection" aria-label="Close dialog">×</button><h2 id="correctionTitle">Request a correction</h2><p>Tell OSAS which admin record detail needs to be updated and what it should say.</p><form id="correctionForm"><div class="admin-field"><label for="correctionField">Which detail is wrong?</label><select id="correctionField" required><option value="">Select a detail</option><option>Admin ID</option><option>Position</option><option>Role</option><option>Campus</option></select></div><div class="admin-field"><label for="correctionMessage">Tell OSAS what it should say</label><textarea id="correctionMessage" required minlength="10" rows="4"></textarea></div><p class="admin-error-text" id="correctionError" role="alert"></p><div class="admin-dialog-actions"><button class="admin-button" id="cancelCorrection" type="button">Cancel</button><button class="admin-button green" type="submit">Send request</button></div></form></div></div>');
  const correctionModal = root.querySelector("#correctionModal");
  root.querySelector("#btnRequestCorrection").onclick = () => {
    correctionModal.hidden = false;
    root.querySelector("#correctionField").focus();
  };
  const closeCorrection = () => { correctionModal.hidden = true; root.querySelector("#correctionForm").reset(); root.querySelector("#correctionError").textContent = ""; };
  root.querySelector("#closeCorrection").onclick = closeCorrection;
  root.querySelector("#cancelCorrection").onclick = closeCorrection;
  root.querySelector("#correctionForm").onsubmit = async (event) => {
    event.preventDefault();
    const field = root.querySelector("#correctionField").value;
    const message = root.querySelector("#correctionMessage").value.trim();
    const submitButton = event.currentTarget.querySelector('[type="submit"]');
    if (!field || message.length < 10) {
      root.querySelector("#correctionError").textContent = "Select a detail and provide at least 10 characters.";
      return;
    }
    if (!isRtdbConfigured || !rtdb || !firebaseUser) {
      root.querySelector("#correctionError").textContent = "Correction requests are unavailable. Please try again later.";
      return;
    }
    submitButton.disabled = true;
    submitButton.textContent = "Sending...";
    try {
      const requestRef = push(ref(rtdb, "correctionRequests"));
      await set(requestRef, {
        uid: firebaseUser.uid,
        adminId,
        adminName: profile.name || fullName,
        field,
        message,
        status: "open",
        createdAt: Date.now(),
      });
      closeCorrection();
      toast("Correction request sent.");
    } catch (error) {
      console.error("Could not submit Admin correction request:", error);
      root.querySelector("#correctionError").textContent = "Could not send your request. Please try again.";
    } finally {
      submitButton.disabled = false;
      submitButton.textContent = "Send request";
    }
  };

  function read(key, fallback) {
    try {
      return JSON.parse(localStorage.getItem(key) || "null") ?? fallback;
    } catch {
      return fallback;
    }
  }
  function toast(message) {
    toastElement.textContent = message;
    toastElement.hidden = false;
    clearTimeout(toastElement._timer);
    toastElement._timer = setTimeout(() => (toastElement.hidden = true), 3000);
  }
  function display() {
    root.querySelector("#viewFirstName").textContent = profile.firstName || "Not set";
    root.querySelector("#viewMiddleName").textContent = profile.middleName || "Not set";
    root.querySelector("#viewMiddleName").classList.toggle("empty-muted", !profile.middleName);
    root.querySelector("#viewLastName").textContent = profile.lastName || "Not set";
    root.querySelector("#viewEmail").textContent = profile.email || identity || "Not set";
    root.querySelector("#viewContact").textContent = profile.contactNumber || "Not set";
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
        })[ch],
    );
  }
  function setEditing(value) {
    editing = value;
    dirty = false;
    root.querySelector("#profileSummary").hidden = value;
    root.querySelector("#contactSummary").hidden = value;
    root.querySelectorAll("[data-edit-profile]").forEach((button) => (button.hidden = value));
    root.querySelector("#profileForm").hidden = !value;
    const form = root.querySelector("#profileForm");
    form.firstName.value = profile.firstName;
    form.middleName.value = profile.middleName;
    form.lastName.value = profile.lastName;
    form.emailAddress.value = profile.email || identity;
    form.contactNumber.value = profile.contactNumber || "";
    form.noMiddleName.checked = !profile.middleName;
    form.middleName.disabled = form.noMiddleName.checked;
    root.querySelector("#profileError").textContent = "";
    if (value) form.firstName.focus();
  }
  function changed() {
    dirty = true;
  }
  root.querySelectorAll("[data-edit-profile]").forEach((button) => {
    button.onclick = () => setEditing(true);
  });
  root.querySelector("#profileForm").addEventListener("input", changed);
  root.querySelector("#noMiddleName").addEventListener("change", (event) => {
    const middle = root.querySelector("#middleName");
    middle.disabled = event.target.checked;
    if (event.target.checked) middle.value = "";
    else middle.focus();
    changed();
  });
  root.querySelector("#cancelEdit").onclick = () => {
    if (dirty && !confirm("Discard your unsaved profile changes?")) return;
    setEditing(false);
  };
  root.querySelector("#profileForm").onsubmit = (event) => {
    event.preventDefault();
    const form = event.currentTarget,
      first = form.firstName.value.trim(),
      middle = form.noMiddleName.checked ? "" : form.middleName.value.trim(),
      last = form.lastName.value.trim(),
      phone = form.contactNumber.value.trim(),
      normalizedPhone = phone.replace(/[\s-]/g, ""),
      error = root.querySelector("#profileError");
    if (
      !first ||
      !last ||
      !namePattern.test(first) ||
      !namePattern.test(last) ||
      (!form.noMiddleName.checked && (!middle || !namePattern.test(middle)))
    ) {
      error.textContent =
        "Enter valid first and last names; middle name is required unless you select the checkbox.";
      return;
    }
    if (phone && !phonePattern.test(normalizedPhone)) {
      error.textContent = "Use 09XXXXXXXXX or +639XXXXXXXXX.";
      form.contactNumber.focus();
      return;
    }
    profile.firstName = first;
    profile.middleName = middle;
    profile.lastName = last;
    profile.name = [first, middle, last].filter(Boolean).join(" ");
    profile.contactNumber = normalizedPhone;
    profile.email = profile.email || identity;
    localStorage.setItem("recovibeAdminProfile", JSON.stringify(profile));
    document.querySelector("[data-name]").textContent =
      profile.name.toUpperCase();
    document.querySelector("[data-avatar]").textContent = profile.name
      .split(/\s+/)
      .slice(0, 2)
      .map((p) => p[0])
      .join("")
      .toUpperCase();
    root.querySelector("#heroAvatar").textContent = profile.name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 1)
      .map((p) => p[0])
      .join("")
      .toUpperCase();
    root.querySelector("#heroUserName").textContent = profile.name;
    display();
    setEditing(false);
    toast("Profile saved.");
  };
  const layer = root.querySelector("#passwordLayer");
  function closePassword() {
    layer.hidden = true;
    layer.style.display = "none";
    document.body.style.overflow = "";
    root.querySelector("#changePassword").focus();
    root.querySelector("#passwordError").textContent = "";
    root.querySelector("#passwordForm").reset();
  }
  root.querySelector("#changePassword").onclick = () => {
    layer.hidden = false;
    layer.style.display = "grid";
    document.body.style.overflow = "hidden";
    root.querySelector("#currentPassword").focus();
  };
  root.querySelectorAll("[data-toggle]").forEach(
    (button) =>
      (button.onclick = () => {
        const input = document.getElementById(button.dataset.toggle),
          visible = input.type === "password";
        input.type = visible ? "text" : "password";
        button.setAttribute(
          "aria-label",
          `${visible ? "Hide" : "Show"} ${input.labels[0]?.textContent.toLowerCase() || "password"}`,
        );
      }),
  );
  root.querySelector("#passwordClose").onclick = closePassword;
  root.querySelector("#cancelPassword").onclick = closePassword;
  layer.addEventListener("click", (event) => {
    if (event.target === layer) closePassword();
  });
  root.querySelector("#passwordForm").onsubmit = async (event) => {
    event.preventDefault();
    const current = root.querySelector("#currentPassword").value,
      next = root.querySelector("#newPassword").value,
      confirmValue = root.querySelector("#confirmPassword").value,
      error = root.querySelector("#passwordError"),
      button = event.submitter || event.currentTarget.querySelector('[type="submit"]');
    error.textContent = "";
    if (
      !current ||
      next.length < 8 ||
      !/[A-Z]/.test(next) ||
      !/[a-z]/.test(next) ||
      !/[0-9]/.test(next)
    ) {
      error.textContent =
        "Use at least 8 characters with uppercase, lowercase, and a number.";
      return;
    }
    if (next !== confirmValue) {
      error.textContent = "The new passwords do not match.";
      return;
    }
    button.disabled = true;
    button.textContent = "Updating…";
    try {
      if (!firebaseUser?.email) throw new Error("Your signed-in account could not be verified.");
      const credential = EmailAuthProvider.credential(firebaseUser.email, current);
      await reauthenticateWithCredential(firebaseUser, credential);
      await updatePassword(firebaseUser, next);
      closePassword();
      toast("Password changed successfully.");
    } catch (failure) {
      error.textContent =
        failure.code === "auth/wrong-password" || failure.code === "auth/invalid-credential"
          ? "Current password is incorrect."
          : failure.code === "auth/requires-recent-login"
            ? "Please sign in again before changing your password."
            : "Password could not be changed. Please try again.";
    } finally {
      button.disabled = false;
      button.textContent = "Update Password";
    }
  };
  layer.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closePassword();
      return;
    }
    if (event.key === "Tab") {
      const controls = [
        ...layer.querySelectorAll("button:not(:disabled),input:not(:disabled)"),
      ];
      if (event.shiftKey && document.activeElement === controls[0]) {
        event.preventDefault();
        controls.at(-1).focus();
      } else if (
        !event.shiftKey &&
        document.activeElement === controls.at(-1)
      ) {
        event.preventDefault();
        controls[0].focus();
      }
    }
  });
  window.addEventListener("beforeunload", (event) => {
    if (dirty) {
      event.preventDefault();
      event.returnValue = "";
    }
  });
  display();
  signalProfilePageReady();
})();
