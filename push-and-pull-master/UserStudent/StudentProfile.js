import {
  EmailAuthProvider,
  onAuthStateChanged,
  reauthenticateWithCredential,
  updateEmail,
  updatePassword,
  verifyBeforeUpdateEmail,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  updateDoc,
  where,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { auth, db, rtdb, functions, isFirebaseConfigured, isRtdbConfigured } from "./firebaseConfig.js";
import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js";
import { ref, onValue, off, set, update, push } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";

const DEFAULT_STUDENT = {
  firstName: "Mc Joben",
  middleName: "",
  lastName: "Reyes",
  fullName: "Mc Joben Reyes",
  name: "Mc Joben Reyes",
  studentNumber: "2025-00790-BN-1",
  studentNo: "2025-00790-BN-1",
  studentId: "2025-00790-BN-1",
  yearSection: "1-1",
  year: "1-1",
  department: "Bachelor of Science in Information Technology",
  organization: "IBITS",
  email: "reyes.mcjoben@pup.edu.ph",
  contactNumber: "09123456789",
};

function getDepartmentShort(dept) {
  dept = String(dept || "").trim().replace(/[()]+$/g, "");
  if (!dept) return "BSIT";
  const map = {
    "Bachelor of Science in Information Technology": "BSIT",
    "Bachelor of Science in Computer Science": "BSCS",
    "Bachelor of Science in Computer Engineering": "BSCpE",
    "Bachelor of Science in Business Administration": "BSBA",
    "Bachelor of Science in Industrial Engineering": "BSIE",
    "Bachelor of Science in Electronics Engineering": "BSECE",
    "College of Computer and Information Sciences": "CCIS",
  };
  if (map[dept]) return map[dept];
  if (dept.length <= 6) return dept;
  const words = dept.split(/\s+/).filter((w) => !["of", "in", "and", "the"].includes(w.toLowerCase()));
  if (words.length > 1) {
    return words.map((w) => w[0].toUpperCase()).join("");
  }
  return dept.slice(0, 4).toUpperCase();
}

function formatPhilippinePhone(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  let cleanDigits = digits;
  if (digits.startsWith("639")) {
    cleanDigits = "0" + digits.slice(2);
  } else if (digits.startsWith("9")) {
    cleanDigits = "0" + digits;
  }
  cleanDigits = cleanDigits.slice(0, 11);
  if (cleanDigits.length <= 4) return cleanDigits;
  if (cleanDigits.length <= 7) return `${cleanDigits.slice(0, 4)} ${cleanDigits.slice(4)}`;
  return `${cleanDigits.slice(0, 4)} ${cleanDigits.slice(4, 7)} ${cleanDigits.slice(7, 11)}`;
}

function unformatPhone(formatted) {
  const digits = String(formatted || "").replace(/\D/g, "");
  if (digits.startsWith("639")) return "0" + digits.slice(2);
  if (digits.startsWith("9")) return "0" + digits;
  return digits.slice(0, 11);
}

function normalizeStudentNumber(value) {
  return String(value || "").trim().toUpperCase();
}

function hydrateUserProfile() {
  const local = JSON.parse(localStorage.getItem("recovibeCurrentUser") || sessionStorage.getItem("recovibeCurrentUser") || "null");
  const user =
    local && Object.keys(local).length > 0 ? { ...DEFAULT_STUDENT, ...local } : DEFAULT_STUDENT;
  const storedFirstName = String(user.firstName || "").trim();
  const storedMiddleName = String(user.middleName || "").trim();
  const storedLastName = String(user.lastName || "").trim();
  const storedFullName = String(user.name || user.fullName || "").trim();
  const nameFromProfile = [storedFirstName, storedMiddleName, storedLastName]
    .map((part) => String(part || "").trim())
    .filter(Boolean)
    .join(" ");
  const displayName = storedFullName || nameFromProfile || "Mc Joben Reyes";
  const firstName =
    storedFirstName ||
    storedFullName.split(/\s+/).filter(Boolean)[0] ||
    nameFromProfile.split(/\s+/).filter(Boolean)[0] ||
    "Mc Joben";
  const avatarFallback = [
    user.username,
    user.studentNumber,
    user.studentNo,
    user.studentId,
    user.email,
  ]
    .map((value) => String(value || "").trim())
    .find(Boolean) || "";
  const avatarLetter =
    Array.from(firstName || displayName || avatarFallback || "M")[0]?.toUpperCase() || "M";
  const organization = String(user.organization || "IBITS").trim() || "IBITS";
  const role = organization;
  const studentNo = normalizeStudentNumber(user.studentNo || user.studentNumber || user.studentId || "2025-00790-BN-1");
  const yearSec = String(user.yearSection || user.year || "1-1").replace(/^Year\s+/i, "").trim() || "1-1";
  const department = String(user.department || "Bachelor of Science in Information Technology").trim().replace(/[()]+$/g, "");
  const deptShort = getDepartmentShort(department);
  const email = String(user.email || "reyes.mcjoben@pup.edu.ph").trim().toLowerCase();
  const contact = String(user.contactNumber || user.contact || "09123456789").trim();

  // Header & sidebar elements
  document.querySelectorAll(".user-name, #userName, #heroUserName").forEach((element) => {
    element.textContent = displayName;
  });
  document.querySelectorAll(".user-role, #userRole").forEach((element) => {
    element.textContent = role;
  });
  document.querySelectorAll(".avatar, #userAvatar, #heroAvatar, .hero-avatar").forEach((element) => {
    element.textContent = avatarLetter;
  });
  document.querySelectorAll("#userFirstName").forEach((element) => {
    element.textContent = firstName;
  });
  const heroStudentEl = document.getElementById("heroStudentNumber");
  if (heroStudentEl) heroStudentEl.textContent = studentNo;
  const heroYearSecEl = document.getElementById("heroYearSection");
  if (heroYearSecEl) heroYearSecEl.textContent = yearSec;
  const heroDeptBadgeEl = document.getElementById("heroDeptBadge");
  if (heroDeptBadgeEl) heroDeptBadgeEl.textContent = deptShort;
  const heroOrgBadgeEl = document.getElementById("heroOrgBadge");
  if (heroOrgBadgeEl) heroOrgBadgeEl.textContent = organization;

  // Name Card View
  const viewFirst = document.getElementById("viewFirstName");
  if (viewFirst) viewFirst.textContent = storedFirstName || firstName;
  const viewMid = document.getElementById("viewMiddleName");
  if (viewMid) {
    if (storedMiddleName) {
      viewMid.textContent = storedMiddleName;
    } else {
      viewMid.innerHTML = '<span class="empty-muted">Not set</span>';
    }
  }
  const viewLast = document.getElementById("viewLastName");
  if (viewLast) viewLast.textContent = storedLastName || "Reyes";

  // Contact Card View
  const viewEm = document.getElementById("viewEmail");
  if (viewEm) viewEm.textContent = email;
  const viewPhone = document.getElementById("viewContact");
  if (viewPhone) viewPhone.textContent = formatPhilippinePhone(contact);

  // Student Details Card View
  const viewStudNo = document.getElementById("viewStudentNumber");
  if (viewStudNo) viewStudNo.textContent = studentNo;
  const viewYrSec = document.getElementById("viewYearSection");
  if (viewYrSec) viewYrSec.textContent = yearSec;
  const viewDept = document.getElementById("viewDepartment");
  if (viewDept) viewDept.textContent = department;
  const viewOrg = document.getElementById("viewOrganization");
  if (viewOrg) viewOrg.textContent = organization;

  // QR card summaries
  const qrName = document.getElementById("qrCardStudentName");
  if (qrName) qrName.textContent = displayName;
  const qrNo = document.getElementById("qrCardStudentNumber");
  if (qrNo) qrNo.textContent = studentNo;
  const qrOrg = document.getElementById("qrCardStudentOrg");
  if (qrOrg) qrOrg.textContent = organization;
  const qrModalName = document.getElementById("qrModalStudentName");
  if (qrModalName) qrModalName.textContent = displayName;

  // Pending verification notice
  const pendingRaw = localStorage.getItem("recovibe_pending_email_" + (user.uid || "me"));
  const pendingBox = document.getElementById("pendingVerificationBox");
  if (pendingRaw) {
    try {
      const pendingData = JSON.parse(pendingRaw);
      if (pendingData && pendingData.pendingEmail) {
        if (pendingBox) {
          pendingBox.hidden = false;
          const pendingEmailEl = document.getElementById("pendingVerificationEmail");
          const currentEmailEl = document.getElementById("currentSignInEmail");
          if (pendingEmailEl) pendingEmailEl.textContent = pendingData.pendingEmail;
          if (currentEmailEl) currentEmailEl.textContent = email;
        }
      } else if (pendingBox) {
        pendingBox.hidden = true;
      }
    } catch {
      if (pendingBox) pendingBox.hidden = true;
    }
  } else if (pendingBox) {
    pendingBox.hidden = true;
  }
}

(() => {
  hydrateUserProfile();
  const localUser = JSON.parse(localStorage.getItem("recovibeCurrentUser") || sessionStorage.getItem("recovibeCurrentUser") || "null");
  const user =
    localUser && Object.keys(localUser).length > 0 ? { ...DEFAULT_STUDENT, ...localUser } : DEFAULT_STUDENT;
  const preferenceKey = "recovibePreferences";
  const accountPreferenceKey = `recovibePreferences:${user.uid || user.email || "student"}`;
  const categories = [
    "Academic & Learning",
    "Tech & Innovation",
    "Seminars & Workshops",
    "Leadership & Career",
    "Orgs & Student Acts",
    "Social Events",
    "University & Campuses",
    "Community & Outreach",
    "Music & Entertainment",
    "Arts & Culture",
    "Sports & Fitness",
    "Competitions",
  ];
  const sources = [
    "PUP Official",
    "CSC",
    "Organizational",
    "Others / External",
  ];
  const defaults = {
    categories: ["Academic & Learning", "Tech & Innovation"],
    sources,
  };
  let preferences = user.preferences ||
    JSON.parse(localStorage.getItem(accountPreferenceKey) || "null") ||
    JSON.parse(localStorage.getItem(preferenceKey) || "null") ||
    defaults;
  if (!Array.isArray(preferences.categories) || !Array.isArray(preferences.sources)) {
    preferences = defaults;
  }

  function showToast(message, isError = false) {
    const toast = document.getElementById("toast");
    if (!toast) return;
    toast.textContent = message;
    toast.style.backgroundColor = isError ? "var(--maroon-primary)" : "var(--text-dark)";
    toast.classList.add("is-visible");
    window.clearTimeout(toast._timer);
    toast._timer = window.setTimeout(() => {
      toast.classList.remove("is-visible");
    }, 2800);
  }
  window.showToast = showToast;

  function showConfirmation({
    title = "Confirm Action",
    message = "Are you sure you want to proceed?",
    confirmText = "Confirm",
    cancelText = "Cancel",
    isDanger = false,
  } = {}) {
    return new Promise((resolve) => {
      const overlay = document.getElementById("confirmModalOverlay");
      const titleEl = document.getElementById("confirmModalTitle");
      const msgEl = document.getElementById("confirmModalMessage");
      const confirmBtn = document.getElementById("confirmModalConfirmBtn");
      const cancelBtn = document.getElementById("confirmModalCancelBtn");
      const backdrop = document.getElementById("confirmModalBackdrop");
      const iconEl = document.getElementById("confirmModalIcon");

      if (!overlay || !confirmBtn || !cancelBtn) {
        resolve(window.confirm(message));
        return;
      }

      if (titleEl) titleEl.textContent = title;
      if (msgEl) msgEl.textContent = message;
      confirmBtn.textContent = confirmText;
      cancelBtn.textContent = cancelText;

      if (iconEl) {
        iconEl.classList.toggle("danger", Boolean(isDanger));
      }
      if (isDanger) {
        confirmBtn.classList.add("btn-danger");
        confirmBtn.classList.remove("btn-primary");
      } else {
        confirmBtn.classList.remove("btn-danger");
        confirmBtn.classList.add("btn-primary");
      }

      overlay.hidden = false;
      overlay.style.display = "flex";
      confirmBtn.focus();

      const cleanup = (result) => {
        overlay.hidden = true;
        overlay.style.display = "none";
        confirmBtn.removeEventListener("click", onConfirm);
        cancelBtn.removeEventListener("click", onCancel);
        backdrop?.removeEventListener("click", onCancel);
        document.removeEventListener("keydown", onKeydown);
        resolve(result);
      };

      const onConfirm = () => cleanup(true);
      const onCancel = () => cleanup(false);
      const onKeydown = (e) => {
        if (e.key === "Escape") onCancel();
      };

      confirmBtn.addEventListener("click", onConfirm);
      cancelBtn.addEventListener("click", onCancel);
      backdrop?.addEventListener("click", onCancel);
      document.addEventListener("keydown", onKeydown);
    });
  }
  window.showConfirmation = showConfirmation;

  const setText = (id, value, fallback = "Not provided") => {
    const element = document.getElementById(id);
    if (element) element.textContent = String(value || "").trim() || fallback;
  };
  const storedName = String(user.fullName || user.name || "").trim();
  const nameParts = storedName.split(/\s+/).filter(Boolean);
  const firstName = String(user.firstName || "").trim() || nameParts[0] || "Mc Joben";
  const lastName =
    String(user.lastName || "").trim() ||
    (nameParts.length > 1 ? nameParts.at(-1) : "Reyes");
  setText("profileFirstName", firstName);
  setText(
    "profileMiddleName",
    String(user.middleName || "").trim() ||
      (nameParts.length > 2 ? nameParts.slice(1, -1).join(" ") : "—"),
  );
  setText("profileLastName", lastName);
  setText("profileStudentId", studentNo);
  setText("profileEmail", user.email || "reyes.mcjoben@pup.edu.ph");
  setText("profileContact", user.contactNumber || user.contact || "09123456789");
  setText("profileDepartment", department);
  setText("profileYear", user.year || "Year 1-2");
  setText("profileOrganization", user.organization || "IBITS");
  setText("profileStudentIdBanner", studentNo);
  setText("profileYearBanner", user.year || "Year 1-2");
  setText("profileDepartmentBanner", department);
  setText("heroOrgBadge", user.organization || "IBITS");
  setText("heroDeptBadge", user.department?.includes("Information Technology") ? "BSIT" : "BSIT");
  setText("qrCardStudentName", storedName || "Mc Joben Reyes");
  setText("qrCardStudentNumber", normalizeStudentNumber(user.studentNumber || user.studentId) || "2025-00790-BN-1");
  setText("qrCardStudentOrg", user.organization || "IBITS");
  setText(
    "todayDate",
    new Date().toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    }),
  );
  const renderSummary = (id, items, emptyMessage = "None chosen yet") => {
    const container = document.getElementById(id);
    if (!container) return;
    container.replaceChildren();
    if (!items || !items.length) {
      const emptyState = document.createElement("p");
      emptyState.className = "preference-empty";
      const emptySpan = document.createElement("span");
      emptySpan.className = "empty-muted";
      emptySpan.textContent = emptyMessage;
      emptyState.append(emptySpan);
      container.append(emptyState);
      return;
    }
    items.forEach((item) => {
      const chip = document.createElement("span");
      chip.className = id === "categorySummary" ? "chip chip-maroon" : "chip chip-gold";
      chip.textContent = item;
      container.append(chip);
    });
  };
  renderSummary(
    "categorySummary",
    preferences.categories,
    "None chosen yet",
  );
  renderSummary("sourceSummary", preferences.sources, "None chosen yet");

  const passwordFormModal = document.getElementById("passwordFormModal");
  const passwordForm = document.getElementById("passwordForm");
  const passwordFormStatus = document.getElementById("passwordFormStatus");

  /* ==========================================================================
     Feedback Alert Banner Controller
     ========================================================================== */
  let feedbackAlertTimer = null;
  function showFeedbackAlert(message, isError = false) {
    const alertEl = document.getElementById("profileFeedbackAlert");
    const textEl = document.getElementById("profileFeedbackText");
    if (!alertEl || !textEl) {
      showToast(message, isError);
      return;
    }
    textEl.textContent = message;
    alertEl.classList.toggle("error", Boolean(isError));
    alertEl.hidden = false;
    if (feedbackAlertTimer) clearTimeout(feedbackAlertTimer);
    feedbackAlertTimer = setTimeout(() => {
      alertEl.hidden = true;
      feedbackAlertTimer = null;
    }, 4000);
  }

  document.getElementById("btnDismissFeedback")?.addEventListener("click", () => {
    const alertEl = document.getElementById("profileFeedbackAlert");
    if (alertEl) alertEl.hidden = true;
    if (feedbackAlertTimer) clearTimeout(feedbackAlertTimer);
  });

  /* ==========================================================================
     Validation Helpers
     ========================================================================== */
  const namePattern = /^[\p{L}\p{M}]+(?:[ .'-][\p{L}\p{M}]+)*\.?$/u;
  const emailPattern =
    /^(?=.{1,254}$)(?!.*\.\.)[A-Z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?\.)+[A-Z]{2,}$/i;
  const contactPattern = /^09[0-9]{9}$/;

  function isValidName(value) {
    const normalized = value.normalize("NFC");
    const length = Array.from(normalized).length;
    return length >= 2 && length <= 50 && namePattern.test(normalized);
  }

  function isValidEmail(value) {
    if (
      value.length > 254 ||
      /\s/.test(value) ||
      (value.match(/@/g) || []).length !== 1
    ) {
      return false;
    }
    const [local, domain] = value.split("@");
    return (
      local.length <= 64 &&
      !local.startsWith(".") &&
      !local.endsWith(".") &&
      !domain.startsWith(".") &&
      !domain.endsWith(".") &&
      emailPattern.test(value)
    );
  }

  function normalizeName(value) {
    return value
      .replace(/ {2,}/g, " ")
      .replace(/^ /, "")
      .replace(/(^|[ '-])(\p{L})/gu, (_, separator, letter) =>
        separator + letter.toUpperCase(),
      );
  }

  /* ==========================================================================
     State & Single-Card Edit Coordination
     ========================================================================== */
  const savedState = {
    firstName: String(user.firstName || "").trim(),
    middleName: String(user.middleName || "").trim(),
    lastName: String(user.lastName || "").trim(),
    email: String(user.email || "").trim().toLowerCase(),
    contactNumber: unformatPhone(user.contactNumber || user.contact || "09123456789"),
  };

  let activeEditCard = null; // null | "name" | "contact" | "preferences"

  // 1. Name Card DOM
  const btnEditName = document.getElementById("btnEditName");
  const nameCardView = document.getElementById("nameCardView");
  const nameCardEdit = document.getElementById("nameCardEdit");
  const inputFirstName = document.getElementById("inputFirstName");
  const inputMiddleName = document.getElementById("inputMiddleName");
  const inputLastName = document.getElementById("inputLastName");
  const errFirstName = document.getElementById("errFirstName");
  const errMiddleName = document.getElementById("errMiddleName");
  const errLastName = document.getElementById("errLastName");
  const nameUnsavedCount = document.getElementById("nameUnsavedCount");
  const nameCancelBtn = document.getElementById("nameCancelBtn");
  const nameSaveBtn = document.getElementById("nameSaveBtn");

  // 2. Contact Card DOM
  const btnEditContact = document.getElementById("btnEditContact");
  const contactCardView = document.getElementById("contactCardView");
  const contactCardEdit = document.getElementById("contactCardEdit");
  const inputContactEmail = document.getElementById("inputContactEmail");
  const errContactEmail = document.getElementById("errContactEmail");
  const emailDifferentWarning = document.getElementById("emailDifferentWarning");
  const inputContactPhone = document.getElementById("inputContactPhone");
  const errContactPhone = document.getElementById("errContactPhone");
  const contactUnsavedCount = document.getElementById("contactUnsavedCount");
  const contactCancelBtn = document.getElementById("contactCancelBtn");
  const contactSaveBtn = document.getElementById("contactSaveBtn");
  const btnCancelEmailChange = document.getElementById("btnCancelEmailChange");

  // 3. Locked Student Details Card & Correction Modal DOM
  const btnRequestCorrection = document.getElementById("btnRequestCorrection");
  const correctionModalOverlay = document.getElementById("correctionModalOverlay");
  const correctionModalBackdrop = document.getElementById("correctionModalBackdrop");
  const closeCorrectionModal = document.getElementById("closeCorrectionModal");
  const btnCancelCorrection = document.getElementById("btnCancelCorrection");
  const correctionForm = document.getElementById("correctionForm");
  const correctionFieldSelect = document.getElementById("correctionFieldSelect");
  const errCorrectionField = document.getElementById("errCorrectionField");
  const correctionMessageInput = document.getElementById("correctionMessageInput");
  const errCorrectionMessage = document.getElementById("errCorrectionMessage");
  const btnSendCorrection = document.getElementById("btnSendCorrection");

  // 4. Preferences Card DOM
  const editPreferencesBtn = document.getElementById("editPreferences");
  const preferencesCardView = document.getElementById("preferencesCardView");
  const preferencesCardEdit = document.getElementById("preferencesCardEdit");
  const groupLearningCareer = document.getElementById("groupLearningCareer");
  const groupCampusLife = document.getElementById("groupCampusLife");
  const groupArtsSportsFun = document.getElementById("groupArtsSportsFun");
  const categoryCountBadge = document.getElementById("categoryCountBadge");
  const btnSelectAllCategories = document.getElementById("btnSelectAllCategories");
  const btnClearAllCategories = document.getElementById("btnClearAllCategories");
  const errCategories = document.getElementById("errCategories");
  const sourceCountBadge = document.getElementById("sourceCountBadge");
  const btnTurnAllSourcesOn = document.getElementById("btnTurnAllSourcesOn");
  const prefSourcesList = document.getElementById("prefSourcesList");
  const errSources = document.getElementById("errSources");
  const prefSummaryText = document.getElementById("prefSummaryText");
  const preferencesUnsavedCount = document.getElementById("preferencesUnsavedCount");
  const cancelPreferencesBtn = document.getElementById("cancelPreferencesBtn");
  const savePreferencesBtn = document.getElementById("savePreferencesBtn");

  let currentEditCategories = new Set(preferences.categories || []);
  let currentEditSources = new Set(preferences.sources || []);

  function isPreferencesEditing() {
    return Boolean(
      activeEditCard === "preferences" ||
      (preferencesCardEdit && !preferencesCardEdit.hidden && preferencesCardEdit.style.display !== "none")
    );
  }

  function getPreferencesDirtyCount() {
    const savedCats = new Set(preferences.categories || []);
    const savedSrcs = new Set(preferences.sources || []);
    let count = 0;
    for (const cat of categories) {
      if (savedCats.has(cat) !== currentEditCategories.has(cat)) {
        count++;
      }
    }
    for (const src of sources) {
      if (savedSrcs.has(src) !== currentEditSources.has(src)) {
        count++;
      }
    }
    return count;
  }

  function isNameEditing() {
    return Boolean(activeEditCard === "name" || (nameCardEdit && !nameCardEdit.hidden && nameCardEdit.style.display !== "none"));
  }

  function isContactEditing() {
    return Boolean(activeEditCard === "contact" || (contactCardEdit && !contactCardEdit.hidden && contactCardEdit.style.display !== "none"));
  }

  function getNameDirtyCount() {
    if (!inputFirstName || !inputMiddleName || !inputLastName) return 0;
    let count = 0;
    if (inputFirstName.value.trim() !== (savedState.firstName || "")) count++;
    if (inputMiddleName.value.trim() !== (savedState.middleName || "")) count++;
    if (inputLastName.value.trim() !== (savedState.lastName || "")) count++;
    return count;
  }

  function getContactDirtyCount() {
    if (!inputContactEmail || !inputContactPhone) return 0;
    let count = 0;
    if (inputContactEmail.value.trim().toLowerCase() !== (savedState.email || "").toLowerCase()) count++;
    if (unformatPhone(inputContactPhone.value) !== (savedState.contactNumber || "")) count++;
    return count;
  }

  function updateNameDirtyUI() {
    if (!nameUnsavedCount || !nameSaveBtn) return;
    const count = getNameDirtyCount();
    if (count === 0) {
      nameUnsavedCount.textContent = "No changes yet";
      nameUnsavedCount.classList.remove("is-dirty");
      nameSaveBtn.disabled = true;
    } else {
      nameUnsavedCount.textContent = `${count} unsaved ${count === 1 ? "change" : "changes"}`;
      nameUnsavedCount.classList.add("is-dirty");
      nameSaveBtn.disabled = false;
    }
  }

  function updateContactDirtyUI() {
    if (!contactUnsavedCount || !contactSaveBtn) return;
    const count = getContactDirtyCount();
    if (count === 0) {
      contactUnsavedCount.textContent = "No changes yet";
      contactUnsavedCount.classList.remove("is-dirty");
      contactSaveBtn.disabled = true;
    } else {
      contactUnsavedCount.textContent = `${count} unsaved ${count === 1 ? "change" : "changes"}`;
      contactUnsavedCount.classList.add("is-dirty");
      contactSaveBtn.disabled = false;
    }
  }

  /* ==========================================================================
     1. Name Card Controller
     ========================================================================== */
  function clearNameErrors() {
    [
      { input: inputFirstName, err: errFirstName },
      { input: inputMiddleName, err: errMiddleName },
      { input: inputLastName, err: errLastName },
    ].forEach(({ input, err }) => {
      if (input) input.classList.remove("is-invalid");
      if (err) {
        err.textContent = "";
        err.classList.remove("is-visible");
      }
    });
  }

  function validateNameField(field) {
    if (field === "firstName") {
      const val = inputFirstName.value.trim();
      if (!val) {
        inputFirstName.classList.add("is-invalid");
        errFirstName.textContent = "Enter your first name.";
        errFirstName.classList.add("is-visible");
        return false;
      }
      if (!isValidName(val)) {
        inputFirstName.classList.add("is-invalid");
        errFirstName.textContent = "Use 2–50 valid name characters.";
        errFirstName.classList.add("is-visible");
        return false;
      }
      inputFirstName.classList.remove("is-invalid");
      errFirstName.textContent = "";
      errFirstName.classList.remove("is-visible");
      return true;
    }
    if (field === "lastName") {
      const val = inputLastName.value.trim();
      if (!val) {
        inputLastName.classList.add("is-invalid");
        errLastName.textContent = "Enter your last name.";
        errLastName.classList.add("is-visible");
        return false;
      }
      if (!isValidName(val)) {
        inputLastName.classList.add("is-invalid");
        errLastName.textContent = "Use 2–50 valid name characters.";
        errLastName.classList.add("is-visible");
        return false;
      }
      inputLastName.classList.remove("is-invalid");
      errLastName.textContent = "";
      errLastName.classList.remove("is-visible");
      return true;
    }
    if (field === "middleName") {
      const val = inputMiddleName.value.trim();
      if (val && !isValidName(val)) {
        inputMiddleName.classList.add("is-invalid");
        errMiddleName.textContent = "Use 2–50 valid name characters.";
        errMiddleName.classList.add("is-visible");
        return false;
      }
      inputMiddleName.classList.remove("is-invalid");
      errMiddleName.textContent = "";
      errMiddleName.classList.remove("is-visible");
      return true;
    }
    return true;
  }

  function openNameEdit() {
    if (isPreferencesEditing()) {
      if (getPreferencesDirtyCount() > 0) {
        showFeedbackAlert("Save or cancel your changes to Preferences before editing Name.", true);
        return;
      }
      closePreferencesEdit(true);
    }
    if (isContactEditing()) {
      if (getContactDirtyCount() > 0) {
        showFeedbackAlert("Save or cancel your changes to Contact before editing Name.", true);
        return;
      }
      closeContactEdit(true);
    }
    inputFirstName.value = savedState.firstName || "";
    inputMiddleName.value = savedState.middleName || "";
    inputLastName.value = savedState.lastName || "";
    clearNameErrors();
    updateNameDirtyUI();
    nameCardView.hidden = true;
    nameCardEdit.hidden = false;
    activeEditCard = "name";
    inputFirstName.focus();
  }

  function closeNameEdit(force = false) {
    clearNameErrors();
    nameCardEdit.hidden = true;
    nameCardView.hidden = false;
    if (activeEditCard === "name") activeEditCard = null;
  }

  async function cancelNameEdit() {
    const count = getNameDirtyCount();
    if (count > 0) {
      const discard = await showConfirmation({
        title: "Discard changes?",
        message: `Discard your ${count} unsaved ${count === 1 ? "change" : "changes"}?`,
        confirmText: "Discard",
        cancelText: "Keep editing",
        isDanger: true,
      });
      if (!discard) return;
    }
    closeNameEdit();
  }

  btnEditName?.addEventListener("click", openNameEdit);
  nameCancelBtn?.addEventListener("click", cancelNameEdit);

  [inputFirstName, inputMiddleName, inputLastName].forEach((inp) => {
    if (!inp) return;
    inp.addEventListener("input", () => {
      updateNameDirtyUI();
    });
  });

  inputFirstName?.addEventListener("blur", () => {
    if (inputFirstName.value.trim()) {
      inputFirstName.value = normalizeName(inputFirstName.value.trim());
    }
    validateNameField("firstName");
    updateNameDirtyUI();
  });

  inputMiddleName?.addEventListener("blur", () => {
    if (inputMiddleName.value.trim()) {
      inputMiddleName.value = normalizeName(inputMiddleName.value.trim());
    }
    validateNameField("middleName");
    updateNameDirtyUI();
  });

  inputLastName?.addEventListener("blur", () => {
    if (inputLastName.value.trim()) {
      inputLastName.value = normalizeName(inputLastName.value.trim());
    }
    validateNameField("lastName");
    updateNameDirtyUI();
  });

  nameCardEdit?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const validFirst = validateNameField("firstName");
    const validLast = validateNameField("lastName");
    const validMid = validateNameField("middleName");
    if (!validFirst || !validLast || !validMid) return;

    const first = normalizeName(inputFirstName.value.trim());
    const mid = inputMiddleName.value.trim() ? normalizeName(inputMiddleName.value.trim()) : "";
    const last = normalizeName(inputLastName.value.trim());

    nameSaveBtn.disabled = true;
    nameSaveBtn.textContent = "Saving...";

    try {
      if (isFirebaseConfigured && rtdb && user.uid) {
        await update(ref(rtdb, `users/${user.uid}`), {
          firstName: first,
          middleName: mid,
          lastName: last,
        });
      }
      const fullName = [first, mid, last].filter(Boolean).join(" ");
      if (isFirebaseConfigured && db && user.uid) {
        await updateDoc(doc(db, "users", user.uid), {
          firstName: first,
          middleName: mid,
          lastName: last,
          fullName,
          name: fullName,
        });
      }
      savedState.firstName = first;
      savedState.middleName = mid;
      savedState.lastName = last;

      user.firstName = first;
      user.middleName = mid;
      user.lastName = last;
      user.fullName = fullName;
      user.name = fullName;
      localStorage.setItem("recovibeCurrentUser", JSON.stringify(user));

      hydrateUserProfile();
      closeNameEdit();
      showFeedbackAlert("Name updated.");
    } catch (err) {
      console.error("Failed to save name:", err);
      showFeedbackAlert(err.message || "Could not save name changes.", true);
    } finally {
      nameSaveBtn.disabled = false;
      nameSaveBtn.textContent = "Save";
    }
  });

  /* ==========================================================================
     2. Contact Card Controller
     ========================================================================== */
  function clearContactErrors() {
    inputContactEmail?.classList.remove("is-invalid");
    if (errContactEmail) {
      errContactEmail.textContent = "";
      errContactEmail.classList.remove("is-visible");
    }
    inputContactPhone?.classList.remove("is-invalid");
    if (errContactPhone) {
      errContactPhone.textContent = "";
      errContactPhone.classList.remove("is-visible");
    }
  }

  function validateContactField(field) {
    if (field === "phone") {
      const digits = unformatPhone(inputContactPhone.value);
      if (!digits || !contactPattern.test(digits)) {
        inputContactPhone.classList.add("is-invalid");
        errContactPhone.textContent = "Enter a valid 11-digit mobile number (e.g. 0912 345 6789).";
        errContactPhone.classList.add("is-visible");
        return false;
      }
      inputContactPhone.classList.remove("is-invalid");
      errContactPhone.textContent = "";
      errContactPhone.classList.remove("is-visible");
      return true;
    }
    if (field === "email") {
      const val = inputContactEmail.value.trim().toLowerCase();
      if (!val || !isValidEmail(val)) {
        inputContactEmail.classList.add("is-invalid");
        errContactEmail.textContent = "Enter a valid email address.";
        errContactEmail.classList.add("is-visible");
        return false;
      }
      inputContactEmail.classList.remove("is-invalid");
      errContactEmail.textContent = "";
      errContactEmail.classList.remove("is-visible");
      return true;
    }
    return true;
  }

  function openContactEdit() {
    if (isPreferencesEditing()) {
      if (getPreferencesDirtyCount() > 0) {
        showFeedbackAlert("Save or cancel your changes to Preferences before editing Contact.", true);
        return;
      }
      closePreferencesEdit(true);
    }
    if (isNameEditing()) {
      if (getNameDirtyCount() > 0) {
        showFeedbackAlert("Save or cancel your changes to Name before editing Contact.", true);
        return;
      }
      closeNameEdit(true);
    }
    inputContactEmail.value = savedState.email || "";
    inputContactPhone.value = formatPhilippinePhone(savedState.contactNumber || "");
    clearContactErrors();
    if (emailDifferentWarning) emailDifferentWarning.hidden = true;
    updateContactDirtyUI();
    contactCardView.hidden = true;
    contactCardEdit.hidden = false;
    activeEditCard = "contact";
    inputContactPhone.focus();
  }

  function closeContactEdit(force = false) {
    clearContactErrors();
    contactCardEdit.hidden = true;
    contactCardView.hidden = false;
    if (activeEditCard === "contact") activeEditCard = null;
  }

  async function cancelContactEdit() {
    const count = getContactDirtyCount();
    if (count > 0) {
      const discard = await showConfirmation({
        title: "Discard changes?",
        message: `Discard your ${count} unsaved ${count === 1 ? "change" : "changes"}?`,
        confirmText: "Discard",
        cancelText: "Keep editing",
        isDanger: true,
      });
      if (!discard) return;
    }
    closeContactEdit();
  }

  btnEditContact?.addEventListener("click", openContactEdit);
  contactCancelBtn?.addEventListener("click", cancelContactEdit);

  inputContactPhone?.addEventListener("input", (e) => {
    const rawVal = e.target.value;
    const digitsOnly = rawVal.replace(/\D/g, "");
    e.target.value = formatPhilippinePhone(digitsOnly);
    updateContactDirtyUI();
  });

  inputContactPhone?.addEventListener("blur", () => {
    validateContactField("phone");
    updateContactDirtyUI();
  });

  inputContactEmail?.addEventListener("input", () => {
    const val = inputContactEmail.value.trim().toLowerCase();
    if (val && val !== (savedState.email || "").toLowerCase() && isValidEmail(val)) {
      if (emailDifferentWarning) emailDifferentWarning.hidden = false;
    } else {
      if (emailDifferentWarning) emailDifferentWarning.hidden = true;
    }
    updateContactDirtyUI();
  });

  inputContactEmail?.addEventListener("blur", () => {
    validateContactField("email");
    updateContactDirtyUI();
  });

  contactCardEdit?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const validPhone = validateContactField("phone");
    const validEmail = validateContactField("email");
    if (!validPhone || !validEmail) return;

    const phoneDigits = unformatPhone(inputContactPhone.value);
    const newEmail = inputContactEmail.value.trim().toLowerCase();
    const phoneChanged = phoneDigits !== savedState.contactNumber;
    const emailChanged = newEmail !== (savedState.email || "").toLowerCase();

    contactSaveBtn.disabled = true;
    contactSaveBtn.textContent = "Saving...";

    try {
      if (phoneChanged) {
        if (isFirebaseConfigured && rtdb && user.uid) {
          await update(ref(rtdb, `users/${user.uid}`), {
            contactNumber: phoneDigits,
          });
        }
        if (isFirebaseConfigured && db && user.uid) {
          await updateDoc(doc(db, "users", user.uid), {
            contactNumber: phoneDigits,
            contact: phoneDigits,
          });
        }
        savedState.contactNumber = phoneDigits;
        user.contactNumber = phoneDigits;
        user.contact = phoneDigits;
      }

      if (emailChanged) {
        if (isFirebaseConfigured && auth && auth.currentUser) {
          await verifyBeforeUpdateEmail(auth.currentUser, newEmail);
        }
        localStorage.setItem(
          "recovibe_pending_email_" + (user.uid || "me"),
          JSON.stringify({
            pendingEmail: newEmail,
            oldEmail: savedState.email,
            timestamp: Date.now(),
          })
        );
      }

      localStorage.setItem("recovibeCurrentUser", JSON.stringify(user));
      hydrateUserProfile();
      closeContactEdit();
      showFeedbackAlert("Contact details updated.");
    } catch (err) {
      console.error("Failed to save contact:", err);
      if (err.code === "auth/email-already-in-use") {
        inputContactEmail.classList.add("is-invalid");
        errContactEmail.textContent = "This email is already registered.";
        errContactEmail.classList.add("is-visible");
      } else if (err.code === "auth/requires-recent-login") {
        showFeedbackAlert("Please log in again before changing your email address.", true);
      } else {
        showFeedbackAlert(err.message || "Could not save contact details.", true);
      }
    } finally {
      contactSaveBtn.disabled = false;
      contactSaveBtn.textContent = "Save";
    }
  });

  btnCancelEmailChange?.addEventListener("click", () => {
    localStorage.removeItem("recovibe_pending_email_" + (user.uid || "me"));
    const pendingBox = document.getElementById("pendingVerificationBox");
    if (pendingBox) pendingBox.hidden = true;
    showFeedbackAlert("Email change cancelled.");
  });

  /* ==========================================================================
     3. Student Details Card Correction Modal Controller
     ========================================================================== */
  function openCorrectionModal() {
    if (correctionFieldSelect) correctionFieldSelect.value = "";
    if (correctionMessageInput) correctionMessageInput.value = "";
    if (errCorrectionField) {
      errCorrectionField.textContent = "";
      errCorrectionField.classList.remove("is-visible");
    }
    if (errCorrectionMessage) {
      errCorrectionMessage.textContent = "";
      errCorrectionMessage.classList.remove("is-visible");
    }
    if (correctionModalOverlay) correctionModalOverlay.hidden = false;
    correctionFieldSelect?.focus();
  }

  function closeCorrectionModalDialog() {
    if (correctionModalOverlay) correctionModalOverlay.hidden = true;
  }

  btnRequestCorrection?.addEventListener("click", openCorrectionModal);
  closeCorrectionModal?.addEventListener("click", closeCorrectionModalDialog);
  btnCancelCorrection?.addEventListener("click", closeCorrectionModalDialog);
  correctionModalBackdrop?.addEventListener("click", closeCorrectionModalDialog);

  correctionForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const field = correctionFieldSelect?.value || "";
    const msg = correctionMessageInput?.value.trim() || "";
    let hasErr = false;

    if (!field) {
      if (errCorrectionField) {
        errCorrectionField.textContent = "Select a detail to correct.";
        errCorrectionField.classList.add("is-visible");
      }
      hasErr = true;
    } else if (errCorrectionField) {
      errCorrectionField.textContent = "";
      errCorrectionField.classList.remove("is-visible");
    }

    if (!msg || msg.length < 10) {
      if (errCorrectionMessage) {
        errCorrectionMessage.textContent = "Explain the correct details (at least 10 characters).";
        errCorrectionMessage.classList.add("is-visible");
      }
      hasErr = true;
    } else if (errCorrectionMessage) {
      errCorrectionMessage.textContent = "";
      errCorrectionMessage.classList.remove("is-visible");
    }

    if (hasErr) return;

    btnSendCorrection.disabled = true;
    btnSendCorrection.textContent = "Sending...";

    try {
      if (isFirebaseConfigured && functions) {
        try {
          const submitReq = httpsCallable(functions, "submitCorrectionRequest");
          await submitReq({ field, message: msg });
        } catch (fnErr) {
          console.warn("Function submitCorrectionRequest failed, writing directly to RTDB:", fnErr);
          if (rtdb && user.uid) {
            const reqRef = push(ref(rtdb, "correctionRequests"));
            await set(reqRef, {
              uid: user.uid,
              studentNo: user.studentNo || user.studentNumber || "",
              field,
              message: msg,
              status: "open",
              createdAt: Date.now(),
            });
          }
        }
      } else if (isFirebaseConfigured && rtdb && user.uid) {
        const reqRef = push(ref(rtdb, "correctionRequests"));
        await set(reqRef, {
          uid: user.uid,
          studentNo: user.studentNo || user.studentNumber || "",
          field,
          message: msg,
          status: "open",
          createdAt: Date.now(),
        });
      }
      closeCorrectionModalDialog();
      showFeedbackAlert("Correction request sent.");
    } catch (err) {
      console.error("Correction request error:", err);
      showFeedbackAlert(err.message || "Failed to send request.", true);
    } finally {
      btnSendCorrection.disabled = false;
      btnSendCorrection.textContent = "Send";
    }
  });

  /* ==========================================================================
     Real-Time Database Sync & Email Verification Sync
     ========================================================================== */
  if (isFirebaseConfigured && rtdb && user.uid) {
    const userRtdbRef = ref(rtdb, `users/${user.uid}`);
    onValue(userRtdbRef, (snap) => {
      const val = snap.val();
      if (val) {
        let changed = false;
        [
          "firstName", "middleName", "lastName", "contactNumber",
          "studentNo", "yearSection", "department", "organization", "email"
        ].forEach((k) => {
          if (val[k] !== undefined && val[k] !== user[k]) {
            user[k] = val[k];
            if (savedState[k] !== undefined && activeEditCard === null) {
              savedState[k] = val[k];
            }
            changed = true;
          }
        });
        if (changed) {
          localStorage.setItem("recovibeCurrentUser", JSON.stringify(user));
          hydrateUserProfile();
        }
        if (val.preferences && Array.isArray(val.preferences.categories) && Array.isArray(val.preferences.sources)) {
          if (!isPreferencesEditing()) {
            preferences = val.preferences;
            user.preferences = val.preferences;
            localStorage.setItem(preferenceKey, JSON.stringify(preferences));
            localStorage.setItem(accountPreferenceKey, JSON.stringify(preferences));
            renderSummary("categorySummary", preferences.categories, "None chosen yet");
            renderSummary("sourceSummary", preferences.sources, "None chosen yet");
          }
        }
      }
    });
  }

  if (isFirebaseConfigured && auth) {
    onAuthStateChanged(auth, async (authUser) => {
      if (authUser && authUser.emailVerified && functions) {
        const pendingRaw = localStorage.getItem("recovibe_pending_email_" + authUser.uid);
        if (pendingRaw) {
          try {
            const syncEmailFn = httpsCallable(functions, "syncUserEmail");
            await syncEmailFn();
            localStorage.removeItem("recovibe_pending_email_" + authUser.uid);
            user.email = authUser.email;
            savedState.email = authUser.email;
            localStorage.setItem("recovibeCurrentUser", JSON.stringify(user));
            hydrateUserProfile();
            showFeedbackAlert("Email address verified and updated.");
          } catch (e) {
            console.warn("syncUserEmail notice:", e);
          }
        }
      }
    });
  }

  window.cancelActiveCardEdit = () => {
    if (isPreferencesEditing()) {
      cancelPreferencesBtn?.click();
      return true;
    }
    if (isNameEditing()) {
      nameCancelBtn?.click();
      return true;
    }
    if (isContactEditing()) {
      contactCancelBtn?.click();
      return true;
    }
    return false;
  };

  window.addEventListener("beforeunload", (event) => {
    if (
      (isNameEditing() && getNameDirtyCount() > 0) ||
      (isContactEditing() && getContactDirtyCount() > 0) ||
      (isPreferencesEditing() && getPreferencesDirtyCount() > 0)
    ) {
      event.preventDefault();
      event.returnValue = "";
    }
  });

  function openPasswordModal() {
    passwordForm.reset();
    passwordFormStatus.textContent = "";
    passwordFormStatus.style.color = "";
    if (passwordFormModal) {
      passwordFormModal.hidden = false;
      passwordFormModal.style.display = "flex";
    }
    if (passwordForm) {
      passwordForm.hidden = false;
    }
    document.getElementById("currentPassword")?.focus();
  }
  window.openPasswordModal = openPasswordModal;

  function closePasswordModal() {
    if (passwordFormModal) {
      passwordFormModal.hidden = true;
      passwordFormModal.style.display = "none";
    }
    if (passwordForm) {
      passwordForm.hidden = true;
    }
    passwordFormStatus.textContent = "";
    passwordFormStatus.style.color = "";
  }
  window.closePasswordModal = closePasswordModal;

  document.getElementById("changePassword")?.addEventListener("click", openPasswordModal);
  document.getElementById("cancelPasswordChange")?.addEventListener("click", closePasswordModal);
  document.getElementById("closePasswordModal")?.addEventListener("click", closePasswordModal);
  passwordFormModal?.addEventListener("click", (event) => {
    if (event.target === passwordFormModal) {
      closePasswordModal();
    }
  });

  passwordForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    passwordFormStatus.textContent = "";
    const current = document.getElementById("currentPassword").value;
    const next = document.getElementById("newPassword").value;
    const confirmation = document.getElementById("confirmPassword").value;
    if (!current) {
      passwordFormStatus.style.color = "var(--red-500)";
      passwordFormStatus.textContent = "Enter your current password.";
      return;
    }
    if (
      next.length < 8 ||
      next.length > 64 ||
      /\s/.test(next) ||
      !/[A-Z]/.test(next) ||
      !/[a-z]/.test(next) ||
      !/\d/.test(next) ||
      !/[^\p{L}\p{N}\s]/u.test(next)
    ) {
      passwordFormStatus.style.color = "var(--red-500)";
      passwordFormStatus.textContent =
        "Use 8–64 characters with uppercase, lowercase, a number, and a special character, without spaces.";
      return;
    }
    if (next === current) {
      passwordFormStatus.style.color = "var(--red-500)";
      passwordFormStatus.textContent = "The new password must be different from the current password.";
      return;
    }
    if (next !== confirmation) {
      passwordFormStatus.style.color = "var(--red-500)";
      passwordFormStatus.textContent = "The new passwords do not match.";
      return;
    }

    const confirmed = await showConfirmation({
      title: "Change Password?",
      message: "Are you sure you want to change your account password? You will need your new password for future sign-ins.",
      confirmText: "Update Password",
      cancelText: "Cancel",
      isDanger: false,
    });
    if (!confirmed) return;

    const submit = passwordForm.querySelector('[type="submit"]');
    submit.disabled = true;
    try {
      const signedInUser = await requireSignedInStudent();
      if (!signedInUser.email) {
        throw new Error("This account does not have a sign-in email.");
      }
      await reauthenticateWithCredential(
        signedInUser,
        EmailAuthProvider.credential(signedInUser.email, current),
      );
      await updatePassword(signedInUser, next);
      passwordForm.reset();
      passwordFormStatus.style.color = "#1b6d43";
      passwordFormStatus.textContent = "Password changed successfully.";
      showToast("Password updated successfully.");
      window.setTimeout(() => {
        closePasswordModal();
      }, 1200);
    } catch (error) {
      console.error("Student password update failed:", error);
      passwordFormStatus.style.color = "var(--red-500)";
      passwordFormStatus.textContent =
        error.code === "auth/invalid-credential" ||
        error.code === "auth/wrong-password"
          ? "Current password is incorrect."
          : error.code === "auth/requires-recent-login"
            ? "Please sign in again, then retry changing your password."
            : error.message || "Password could not be changed.";
      showToast(passwordFormStatus.textContent, true);
    } finally {
      submit.disabled = false;
    }
  });
  const organization = String(user.organization || "").trim();
  const role =
    organization && organization.toLowerCase() !== "none"
      ? organization
      : "Student";
  setText("userRole", role);
  setText("userName", storedName || firstName);
  setText("heroUserName", storedName || firstName);
  hydrateUserProfile();

  const sidebar = document.getElementById("sidebar");
  try {
    localStorage.removeItem("sidebarCollapsed");
  } catch {}
  if (sidebar) {
    sidebar.classList.remove("is-collapsed");
    requestAnimationFrame(() => sidebar.classList.add("is-ready"));
  }
  const logoutBtn = document.querySelector(".logout");
  if (logoutBtn && !logoutBtn.dataset.wired) {
    logoutBtn.dataset.wired = "true";
    logoutBtn.addEventListener("click", async (event) => {
      event.preventDefault();
      const confirmed = await showConfirmation({
        title: "Log Out?",
        message: "Are you sure you want to log out of your RecoVibe account?",
        confirmText: "Log Out",
        cancelText: "Cancel",
        isDanger: true,
      });
      if (!confirmed) return;

      try {
        if (auth) {
          const { signOut } = await import(
            "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js"
          );
          await signOut(auth);
        }
      } catch (e) {
        console.warn("Sign out error", e);
      }
      localStorage.removeItem("recovibeCurrentUser");
      window.location.href = "StudentLogin.html";
    });
  }

  /* ==========================================================================
     4. Preferences Card Controller (Inline Editor)
     ========================================================================== */
  const CATEGORY_GROUPS = {
    "Learning and career": [
      "Academic & Learning",
      "Tech & Innovation",
      "Seminars & Workshops",
      "Leadership & Career",
    ],
    "Campus life": [
      "Orgs & Student Acts",
      "Social Events",
      "University & Campuses",
      "Community & Outreach",
    ],
    "Arts, sports, and fun": [
      "Music & Entertainment",
      "Arts & Culture",
      "Sports & Fitness",
      "Competitions",
    ],
  };

  const SOURCE_DESCRIPTIONS = {
    "PUP Official": "University offices and campuses",
    "CSC": "The campus student council",
    "Teacher / Faculty": "Events from your instructors",
    "Organizational": "Student organizations, including your own",
    "Others / External": "Partners and outside organizers",
  };

  const CHECK_ICON_SVG = `<svg class="chip-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 8.5l3 3 6-6"/></svg>`;
  const PLUS_ICON_SVG = `<svg class="chip-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9"/></svg>`;

  function updateChipElement(btn, isSelected) {
    btn.setAttribute("aria-pressed", String(isSelected));
    btn.classList.toggle("is-selected", isSelected);
    btn.innerHTML = `${isSelected ? CHECK_ICON_SVG : PLUS_ICON_SVG}<span>${btn.dataset.category}</span>`;
  }

  function updatePreferencesDirtyUI() {
    const catCount = currentEditCategories.size;
    const srcCount = currentEditSources.size;

    // 1. Live Counters
    if (categoryCountBadge) {
      categoryCountBadge.textContent = `- ${catCount} of ${categories.length} selected`;
    }
    if (sourceCountBadge) {
      sourceCountBadge.textContent = `- ${srcCount} of ${sources.length} on`;
    }

    // 2. Validation
    const hasValidCats = catCount >= 1;
    const hasValidSrcs = srcCount >= 1;

    if (errCategories) {
      errCategories.classList.toggle("is-visible", !hasValidCats);
    }
    if (errSources) {
      errSources.classList.toggle("is-visible", !hasValidSrcs);
    }

    // 3. Dynamic Summary Line
    if (prefSummaryText) {
      if (!hasValidCats || !hasValidSrcs) {
        prefSummaryText.textContent = "Choose at least one category and one source to get recommendations.";
        prefSummaryText.classList.add("is-warning");
      } else {
        const catWord = catCount === 1 ? "category" : "categories";
        const srcWord = srcCount === 1 ? "source" : "sources";
        prefSummaryText.textContent = `You will see ${catCount} ${catWord} of events from ${srcCount} ${srcWord}.`;
        prefSummaryText.classList.remove("is-warning");
      }
    }

    // 4. Footer Unsaved Count & Save Button
    const dirtyCount = getPreferencesDirtyCount();
    if (preferencesUnsavedCount) {
      if (dirtyCount === 0) {
        preferencesUnsavedCount.textContent = "No changes yet";
        preferencesUnsavedCount.classList.remove("is-dirty");
      } else {
        preferencesUnsavedCount.textContent = `${dirtyCount} unsaved ${dirtyCount === 1 ? "change" : "changes"}`;
        preferencesUnsavedCount.classList.add("is-dirty");
      }
    }

    if (savePreferencesBtn) {
      savePreferencesBtn.disabled = !(dirtyCount > 0 && hasValidCats && hasValidSrcs);
    }
  }

  function renderCategoryGroup(container, catList) {
    if (!container) return;
    container.replaceChildren();
    catList.forEach((cat) => {
      const isSelected = currentEditCategories.has(cat);
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `btn-pref-chip${isSelected ? " is-selected" : ""}`;
      btn.dataset.category = cat;
      btn.setAttribute("aria-pressed", String(isSelected));
      btn.innerHTML = `${isSelected ? CHECK_ICON_SVG : PLUS_ICON_SVG}<span>${cat}</span>`;

      const toggleChip = () => {
        const nextState = !currentEditCategories.has(cat);
        if (nextState) {
          currentEditCategories.add(cat);
        } else {
          currentEditCategories.delete(cat);
        }
        updateChipElement(btn, nextState);
        updatePreferencesDirtyUI();
      };

      btn.addEventListener("click", toggleChip);
      btn.addEventListener("keydown", (e) => {
        if (e.key === " " || e.key === "Enter") {
          e.preventDefault();
          toggleChip();
        }
      });
      container.append(btn);
    });
  }

  function renderCategoryChips() {
    renderCategoryGroup(groupLearningCareer, CATEGORY_GROUPS["Learning and career"]);
    renderCategoryGroup(groupCampusLife, CATEGORY_GROUPS["Campus life"]);
    renderCategoryGroup(groupArtsSportsFun, CATEGORY_GROUPS["Arts, sports, and fun"]);
  }

  function renderSourceRows() {
    if (!prefSourcesList) return;
    prefSourcesList.replaceChildren();

    sources.forEach((src) => {
      const isOn = currentEditSources.has(src);
      const desc = SOURCE_DESCRIPTIONS[src] || "";

      const row = document.createElement("div");
      row.className = "pref-source-row";
      row.tabIndex = 0;
      row.dataset.source = src;
      row.setAttribute("role", "button");
      row.setAttribute("aria-pressed", String(isOn));

      const info = document.createElement("div");
      info.className = "pref-source-info";

      const nameEl = document.createElement("span");
      nameEl.className = "pref-source-name";
      nameEl.textContent = src;

      const descEl = document.createElement("span");
      descEl.className = "pref-source-desc";
      descEl.textContent = desc;

      info.append(nameEl, descEl);

      const label = document.createElement("label");
      label.className = "pref-switch";

      const input = document.createElement("input");
      input.type = "checkbox";
      input.className = "pref-switch-input";
      input.setAttribute("role", "switch");
      input.setAttribute("aria-label", `Toggle ${src}`);
      input.checked = isOn;

      const slider = document.createElement("span");
      slider.className = "pref-switch-slider";

      label.append(input, slider);
      row.append(info, label);

      const toggleSource = (forcedValue) => {
        const nextVal = typeof forcedValue === "boolean" ? forcedValue : !input.checked;
        input.checked = nextVal;
        if (nextVal) {
          currentEditSources.add(src);
        } else {
          currentEditSources.delete(src);
        }
        row.setAttribute("aria-pressed", String(nextVal));
        updatePreferencesDirtyUI();
      };

      row.addEventListener("click", (e) => {
        if (e.target === input) return;
        e.preventDefault();
        toggleSource();
      });

      row.addEventListener("keydown", (e) => {
        if (e.key === " " || e.key === "Enter") {
          e.preventDefault();
          toggleSource();
        }
      });

      input.addEventListener("change", (e) => {
        e.stopPropagation();
        toggleSource(input.checked);
      });

      prefSourcesList.append(row);
    });
  }

  // Quick Action Buttons
  btnSelectAllCategories?.addEventListener("click", () => {
    categories.forEach((cat) => currentEditCategories.add(cat));
    [groupLearningCareer, groupCampusLife, groupArtsSportsFun].forEach((group) => {
      if (!group) return;
      group.querySelectorAll(".btn-pref-chip").forEach((btn) => {
        updateChipElement(btn, true);
      });
    });
    updatePreferencesDirtyUI();
  });

  btnClearAllCategories?.addEventListener("click", () => {
    currentEditCategories.clear();
    [groupLearningCareer, groupCampusLife, groupArtsSportsFun].forEach((group) => {
      if (!group) return;
      group.querySelectorAll(".btn-pref-chip").forEach((btn) => {
        updateChipElement(btn, false);
      });
    });
    updatePreferencesDirtyUI();
  });

  btnTurnAllSourcesOn?.addEventListener("click", () => {
    sources.forEach((src) => currentEditSources.add(src));
    if (prefSourcesList) {
      prefSourcesList.querySelectorAll(".pref-source-row").forEach((row) => {
        row.setAttribute("aria-pressed", "true");
        const chk = row.querySelector(".pref-switch-input");
        if (chk) chk.checked = true;
      });
    }
    updatePreferencesDirtyUI();
  });

  function openPreferencesEdit() {
    if (isNameEditing()) {
      if (getNameDirtyCount() > 0) {
        showFeedbackAlert("Save or cancel your changes to Name before editing Preferences.", true);
        return;
      }
      closeNameEdit(true);
    }
    if (isContactEditing()) {
      if (getContactDirtyCount() > 0) {
        showFeedbackAlert("Save or cancel your changes to Contact before editing Preferences.", true);
        return;
      }
      closeContactEdit(true);
    }

    currentEditCategories = new Set(preferences.categories || []);
    currentEditSources = new Set(preferences.sources || []);

    renderCategoryChips();
    renderSourceRows();
    updatePreferencesDirtyUI();

    preferencesCardView.hidden = true;
    preferencesCardEdit.hidden = false;
    activeEditCard = "preferences";
  }
  window.openPreferencesEditor = openPreferencesEdit;

  function closePreferencesEdit(force = false) {
    preferencesCardEdit.hidden = true;
    preferencesCardView.hidden = false;
    if (activeEditCard === "preferences") activeEditCard = null;
  }
  window.closePreferencesEditor = closePreferencesEdit;

  async function cancelPreferencesEdit() {
    const count = getPreferencesDirtyCount();
    if (count > 0) {
      const discard = await showConfirmation({
        title: "Discard changes?",
        message: `Discard your ${count} unsaved ${count === 1 ? "change" : "changes"}?`,
        confirmText: "Discard",
        cancelText: "Keep editing",
        isDanger: true,
      });
      if (!discard) return;
    }
    closePreferencesEdit();
  }

  editPreferencesBtn?.addEventListener("click", openPreferencesEdit);
  cancelPreferencesBtn?.addEventListener("click", cancelPreferencesEdit);

  preferencesCardEdit?.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (currentEditCategories.size === 0 || currentEditSources.size === 0) return;

    savePreferencesBtn.disabled = true;
    savePreferencesBtn.textContent = "Saving...";

    const newCategories = categories.filter((c) => currentEditCategories.has(c));
    const newSources = sources.filter((s) => currentEditSources.has(s));
    const newPreferences = {
      categories: newCategories,
      sources: newSources,
    };

    try {
      const preferenceWrites = [];
      if (isFirebaseConfigured && rtdb && user.uid) {
        preferenceWrites.push(update(ref(rtdb, `users/${user.uid}/preferences`), newPreferences));
      }
      if (isFirebaseConfigured && db && user.uid) {
        preferenceWrites.push(updateDoc(doc(db, "users", user.uid), { preferences: newPreferences }));
      }
      await Promise.all(preferenceWrites);

      preferences = newPreferences;
      user.preferences = newPreferences;
      localStorage.setItem(preferenceKey, JSON.stringify(newPreferences));
      localStorage.setItem(accountPreferenceKey, JSON.stringify(newPreferences));
      localStorage.setItem("recovibeCurrentUser", JSON.stringify(user));

      localStorage.setItem("recovibePreferencesUpdated", String(Date.now()));
      window.dispatchEvent(new CustomEvent("recovibe:preferences-updated", { detail: newPreferences }));
      try {
        const channel = new BroadcastChannel("recovibe_preferences");
        channel.postMessage({ type: "PREFERENCES_UPDATED", preferences: newPreferences, uid: user.uid });
        channel.close();
      } catch (err) {
        // BroadcastChannel unsupported or blocked
      }

      renderSummary("categorySummary", preferences.categories, "None chosen yet");
      renderSummary("sourceSummary", preferences.sources, "None chosen yet");

      closePreferencesEdit();
      showFeedbackAlert("Preferences saved. Your recommendations will update.");
    } catch (err) {
      console.error("Failed to save preferences:", err);
      showFeedbackAlert(err.message || "Could not save preferences.", true);
    } finally {
      savePreferencesBtn.disabled = false;
      savePreferencesBtn.textContent = "Save preferences";
      updatePreferencesDirtyUI();
    }
  });
})();

/* ==========================================================================
   Student QR Attendance: Card Component, Full-Screen Modal & renderMyQr
   ========================================================================== */

async function getQRCodeLib() {
  if (typeof window !== "undefined" && window.QRCode && typeof window.QRCode.toCanvas === "function") {
    return window.QRCode;
  }
  for (let i = 0; i < 20; i++) {
    if (typeof window !== "undefined" && window.QRCode && typeof window.QRCode.toCanvas === "function") {
      return window.QRCode;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  try {
    const mod = await import("https://esm.sh/qrcode@1.5.4");
    const lib = mod.default || mod;
    if (lib && typeof lib.toCanvas === "function") return lib;
    if (typeof window !== "undefined" && window.QRCode) return window.QRCode;
    return lib;
  } catch (err) {
    if (typeof window !== "undefined" && window.QRCode) return window.QRCode;
    console.error("Failed to load QRCode library", err);
    throw err;
  }
}

function formatScannedTime(scannedAt) {
  if (!scannedAt) return "Checked in";
  const date = new Date(typeof scannedAt === "number" ? scannedAt : String(scannedAt));
  if (Number.isNaN(date.getTime())) return "Checked in";
  const timeStr = date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  const isToday = new Date().toDateString() === date.toDateString();
  return isToday
    ? `Today at ${timeStr}`
    : `${date.toLocaleDateString("en-US", { month: "short", day: "numeric" })} at ${timeStr}`;
}

function downloadCanvasAsPng(canvas, filename = "student-qr-code.png") {
  if (!canvas) return;
  try {
    const dataUrl = canvas.toDataURL("image/png");
    const link = document.createElement("a");
    link.download = filename;
    link.href = dataUrl;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  } catch (err) {
    console.error("Failed to download QR code image", err);
  }
}

/**
 * renderMyQr(canvas, options)
 * Renders the student's signed QR attendance token onto the canvas.
 * Handles auto-refresh before expiry (~4 mins), visibility change refreshes,
 * live countdown updates, and cleanup on unmount.
 * Returns a cleanup function that cancels timers and listeners.
 */
let currentPermanentToken = localStorage.getItem("recovibe_permanent_qr_token") || "";
let qrCooldownTimer = null;

function updateCooldownButtons(remainingMs) {
  const refreshBtns = [
    document.getElementById("btnRefreshQrCode"),
    document.getElementById("qrModalRefreshBtn"),
  ].filter(Boolean);

  refreshBtns.forEach((btn) => {
    const labelSpan = btn.querySelector("[data-label]") || btn;
    if (remainingMs > 0) {
      btn.disabled = true;
      const totalSeconds = Math.ceil(remainingMs / 1000);
      const m = Math.floor(totalSeconds / 60);
      const s = String(totalSeconds % 60).padStart(2, "0");
      labelSpan.textContent = `Refresh code (${m}:${s})`;
    } else {
      btn.disabled = false;
      labelSpan.textContent = "Refresh code";
    }
  });
}

function startCooldown(cooldownMs) {
  if (qrCooldownTimer) {
    clearInterval(qrCooldownTimer);
    qrCooldownTimer = null;
  }

  const savedUntil = Number(localStorage.getItem("recovibe_qr_cooldown_until") || 0);
  const now = Date.now();
  let targetTime = 0;

  if (cooldownMs && cooldownMs > 0) {
    targetTime = Math.max(now + cooldownMs, savedUntil);
    localStorage.setItem("recovibe_qr_cooldown_until", String(targetTime));
  } else if (savedUntil > now) {
    targetTime = savedUntil;
  }

  if (targetTime <= now) {
    localStorage.removeItem("recovibe_qr_cooldown_until");
    updateCooldownButtons(0);
    return;
  }

  function tick() {
    const remaining = Math.max(0, targetTime - Date.now());
    updateCooldownButtons(remaining);
    if (remaining <= 0) {
      clearInterval(qrCooldownTimer);
      qrCooldownTimer = null;
      localStorage.removeItem("recovibe_qr_cooldown_until");
    }
  }

  tick();
  qrCooldownTimer = setInterval(tick, 1000);
}

// Check on script load if a cooldown was running
const initialCooldownUntil = Number(localStorage.getItem("recovibe_qr_cooldown_until") || 0);
if (initialCooldownUntil > Date.now()) {
  startCooldown(initialCooldownUntil - Date.now());
}

/**
 * downloadQrCard(token, student)
 * Builds a PNG card (QR at 480px plus name, student number,
 * organization, and "RecoVibe attendance code" below it).
 * Uses navigator.share with the file on mobile; downloads on desktop.
 */
async function downloadQrCard(token, student = {}) {
  const QRCodeLib = await getQRCodeLib();
  const cardCanvas = document.createElement("canvas");
  cardCanvas.width = 560;
  cardCanvas.height = 760;
  const ctx = cardCanvas.getContext("2d");

  // Background
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, cardCanvas.width, cardCanvas.height);

  // Gold accent border
  ctx.lineWidth = 4;
  ctx.strokeStyle = "#D9A93B";
  ctx.strokeRect(12, 12, cardCanvas.width - 24, cardCanvas.height - 24);

  // Render 480px QR onto canvas
  const qrCanvas = document.createElement("canvas");
  await QRCodeLib.toCanvas(qrCanvas, token, {
    width: 480,
    margin: 2,
    color: {
      dark: "#000000",
      light: "#ffffff",
    },
    errorCorrectionLevel: "M",
  });

  ctx.drawImage(qrCanvas, 40, 40, 480, 480);

  // Texts below QR
  const studentName = student.name || "Student";
  const studentNo = student.studentNo || "—";
  const org = student.organization || "PUP Biñan";

  ctx.textAlign = "center";

  // Name
  ctx.fillStyle = "#7A1F2E";
  ctx.font = "bold 24px 'Inter', sans-serif";
  ctx.fillText(studentName, cardCanvas.width / 2, 560);

  // Student number & Organization
  ctx.fillStyle = "#332628";
  ctx.font = "600 16px 'Inter', sans-serif";
  ctx.fillText(`${studentNo} · ${org}`, cardCanvas.width / 2, 596);

  // Subtitle
  ctx.fillStyle = "#7a6d66";
  ctx.font = "14px 'Inter', sans-serif";
  ctx.fillText("RecoVibe attendance code", cardCanvas.width / 2, 632);

  // Footer label
  ctx.fillStyle = "#D9A93B";
  ctx.font = "bold 12px 'Inter', sans-serif";
  ctx.fillText("Polytechnic University of the Philippines — Biñan Campus", cardCanvas.width / 2, 680);

  const cleanNum = studentNo.replace(/[^a-zA-Z0-9_-]/g, "_");
  const filename = `recovibe-attendance-code-${cleanNum || "student"}.png`;

  // Mobile: use navigator.share with File so Save Image saves to gallery
  const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  if (isMobile && navigator.canShare) {
    try {
      const blob = await new Promise((resolve) => cardCanvas.toBlob(resolve, "image/png"));
      if (blob) {
        const file = new File([blob], filename, { type: "image/png" });
        if (navigator.canShare({ files: [file] })) {
          await navigator.share({
            files: [file],
            title: "RecoVibe attendance code",
            text: "My RecoVibe attendance code for PUP Biñan",
          });
          return;
        }
      }
    } catch (shareErr) {
      if (shareErr.name === "AbortError") {
        return; // User dismissed share sheet
      }
      console.warn("navigator.share notice:", shareErr);
    }
  }

  // Desktop or fallback: standard download
  downloadCanvasAsPng(cardCanvas, filename);
}

function renderMyQr(canvas, options = {}) {
  if (!canvas) return () => {};

  const width = options.width || 180;
  const onStateChange = typeof options.onStateChange === "function" ? options.onStateChange : null;
  const onError = typeof options.onError === "function" ? options.onError : null;

  const skeleton =
    options.skeletonEl ||
    canvas.closest(".qr-code-box, .qr-modal-body, .qr-card, .qr-modal-container")?.querySelector(".qr-skeleton, .qr-modal-skeleton");
  const canvasBox = options.canvasBoxEl || canvas.parentElement;
  const errorBox =
    options.errorEl ||
    canvas.closest(".qr-code-box, .qr-modal-body, .qr-card, .qr-modal-container")?.querySelector(".qr-error, .qr-error-box, .qr-modal-error");

  function setUIState(state) {
    if (skeleton) {
      skeleton.hidden = state !== "loading";
      skeleton.style.display = state === "loading" ? "flex" : "none";
    }
    if (canvasBox) {
      canvasBox.hidden = state !== "ready";
      canvasBox.style.display = state === "ready" ? "flex" : "none";
    }
    if (errorBox) {
      errorBox.hidden = state !== "error";
      errorBox.style.display = state === "error" ? "flex" : "none";
    }
    if (onStateChange) onStateChange(state);
  }

  let active = true;

  async function loadAndRender() {
    if (!active) return;

    try {
      // 1. Resolve token immediately (cached, local user, or fallback)
      let token = currentPermanentToken || localStorage.getItem("recovibe_permanent_qr_token") || "";

      if (!token) {
        let u = {};
        try {
          const local = JSON.parse(localStorage.getItem("recovibeCurrentUser") || sessionStorage.getItem("recovibeCurrentUser") || "null");
          u = local && Object.keys(local).length > 0 ? { ...DEFAULT_STUDENT, ...local } : DEFAULT_STUDENT;
        } catch {
          u = DEFAULT_STUDENT;
        }
        const uid = auth?.currentUser?.uid || u.uid || u.studentNumber || u.studentId || "2025-00790-BN-1";
        token = `${uid}.1.fallback_signed_token`;
        localStorage.setItem("recovibe_permanent_qr_token", token);
      }

      currentPermanentToken = token;

      // 2. Render immediately onto canvas
      const QRCodeLib = await getQRCodeLib();
      if (!active) return;

      await QRCodeLib.toCanvas(canvas, token, {
        width: width,
        margin: 2,
        color: {
          dark: "#000000",
          light: "#ffffff",
        },
        errorCorrectionLevel: "M",
      });

      if (!active) return;
      setUIState("ready");

      // 3. If online and authenticated with Firebase Functions, sync authoritative token in background
      if (auth?.currentUser && functions && navigator.onLine) {
        try {
          const getMyQrTokenCallable = httpsCallable(functions, "getMyQrToken");
          const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error("Token request timed out")), 4000)
          );
          const result = await Promise.race([getMyQrTokenCallable(), timeoutPromise]);
          if (result?.data?.token && result.data.token !== token) {
            token = result.data.token;
            currentPermanentToken = token;
            localStorage.setItem("recovibe_permanent_qr_token", token);
            if (active) {
              await QRCodeLib.toCanvas(canvas, token, {
                width: width,
                margin: 2,
                color: {
                  dark: "#000000",
                  light: "#ffffff",
                },
                errorCorrectionLevel: "M",
              });
            }
          }
          if (typeof result?.data?.cooldownMs === "number") {
            startCooldown(result.data.cooldownMs);
          }
        } catch (fnErr) {
          console.warn("Background getMyQrToken notice:", fnErr);
        }
      }

    } catch (err) {
      if (!active) return;
      console.error("renderMyQr error:", err);
      const ctx = canvas.getContext("2d");
      if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
      setUIState("error");
      if (onError) onError(err);
    }
  }

  loadAndRender();

  return function cleanup() {
    active = false;
    const ctx = canvas.getContext("2d");
    if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
  };
}

window.renderMyQr = renderMyQr;

// Initialize QR Attendance Card and Modal on the Profile Page
(() => {
  const card = document.getElementById("studentQrCard");
  if (!card) return;

  // QR Card Elements
  const canvas = document.getElementById("studentQrCanvas");
  const skeleton = document.getElementById("qrCardSkeleton");
  const canvasBox = document.getElementById("qrCardCanvasBox");
  const errorBox = document.getElementById("qrCardError");
  const retryBtn = document.getElementById("qrCardRetryBtn");
  const countdownEl = document.getElementById("qrCardCountdown");
  const nameEl = document.getElementById("qrCardStudentName");
  const numberEl = document.getElementById("qrCardStudentNumber");
  const orgEl = document.getElementById("qrCardStudentOrg");
  const showFullBtn = document.getElementById("btnShowFullScreenQr");
  const refreshBtn = document.getElementById("btnRefreshQrCode");
  const downloadBtn = document.getElementById("btnDownloadQrCard");
  const checkedInBadge = document.getElementById("qrCardStatusBadge");
  const checkedInBanner = document.getElementById("qrCheckedInBanner");
  const checkedInEventName = document.getElementById("qrCheckedInEventName");
  const checkedInTime = document.getElementById("qrCheckedInTime");

  // Full-screen Modal Elements
  const modalOverlay = document.getElementById("qrModalOverlay");
  const modalCloseBtn = document.getElementById("qrModalCloseBtn");
  const modalCloseActionBtn = document.getElementById("qrModalCloseActionBtn");
  const modalBackdrop = document.getElementById("qrModalBackdrop");
  const modalCanvas = document.getElementById("qrModalCanvas");
  const modalSkeleton = document.getElementById("qrModalSkeleton");
  const modalCanvasBox = document.getElementById("qrModalCanvasBox");
  const modalError = document.getElementById("qrModalError");
  const modalRetryBtn = document.getElementById("qrModalRetryBtn");
  const modalCountdown = document.getElementById("qrModalCountdown");
  const modalStudentName = document.getElementById("qrModalStudentName");
  const modalEventName = document.getElementById("qrModalEventName");
  const modalRefreshBtn = document.getElementById("qrModalRefreshBtn");
  const modalDownloadBtn = document.getElementById("qrModalDownloadBtn");

  // Ensure modal is strictly hidden on initial page load
  if (modalOverlay) {
    modalOverlay.hidden = true;
    modalOverlay.style.display = "none";
    modalOverlay.setAttribute("aria-hidden", "true");
  }

  // Initial state: hide checked-in tags until confirmed by Realtime Database
  if (checkedInBadge) checkedInBadge.hidden = true;
  if (checkedInBanner) checkedInBanner.hidden = true;

  function updateStudentCardInfo(userObj) {
    let user = userObj;
    if (!user) {
      try {
        const local = JSON.parse(localStorage.getItem("recovibeCurrentUser") || sessionStorage.getItem("recovibeCurrentUser") || "null");
        user = local && Object.keys(local).length > 0 ? { ...DEFAULT_STUDENT, ...local } : DEFAULT_STUDENT;
      } catch {
        user = DEFAULT_STUDENT;
      }
    }

    const storedFirstName = String(user.firstName || "").trim();
    const storedFullName = String(user.name || user.fullName || "").trim();
    const nameFromProfile = [storedFirstName, user.middleName, user.lastName]
      .map((part) => String(part || "").trim())
      .filter(Boolean)
      .join(" ");
    const studentName = storedFullName || nameFromProfile || "Mc Joben Reyes";
    const studentNumber =
      normalizeStudentNumber(user.studentNumber || user.studentId || user.username) || "2025-00790-BN-1";
    const organization = String(user.organization || "IBITS").trim() || "IBITS";

    if (nameEl) nameEl.textContent = studentName;
    if (numberEl) numberEl.textContent = studentNumber;
    if (orgEl) orgEl.textContent = organization;
    if (modalStudentName) modalStudentName.textContent = studentName;
  }

  updateStudentCardInfo();

  let cardQrCleanup = null;

  function initCardQr() {
    if (cardQrCleanup) {
      cardQrCleanup();
      cardQrCleanup = null;
    }
    if (!canvas) return;

    cardQrCleanup = renderMyQr(canvas, {
      width: 180,
      skeletonEl: skeleton,
      canvasBoxEl: canvasBox,
      errorEl: errorBox,
      countdownEl: countdownEl,
    });
  }

  initCardQr();

  function getStudentDownloadInfo() {
    let u = {};
    try {
      const local = JSON.parse(localStorage.getItem("recovibeCurrentUser") || sessionStorage.getItem("recovibeCurrentUser") || "null");
      u = local && Object.keys(local).length > 0 ? { ...DEFAULT_STUDENT, ...local } : DEFAULT_STUDENT;
    } catch {
      u = DEFAULT_STUDENT;
    }
    const storedFirstName = String(u.firstName || "").trim();
    const storedFullName = String(u.name || u.fullName || "").trim();
    const nameFromProfile = [storedFirstName, u.middleName, u.lastName]
      .map((part) => String(part || "").trim())
      .filter(Boolean)
      .join(" ");
    return {
      name: storedFullName || nameFromProfile || "Mc Joben Reyes",
      studentNo: normalizeStudentNumber(u.studentNumber || u.studentId || u.username) || "2025-00790-BN-1",
      organization: String(u.organization || "IBITS").trim() || "IBITS",
    };
  }

  async function handleRefreshCode() {
    const confirmFn = window.showConfirmation || (typeof showConfirmation === "function" ? showConfirmation : null);
    const confirmed = confirmFn
      ? await confirmFn({
          title: "Refresh Attendance QR Code?",
          message:
            "Generating a new code will invalidate any previously downloaded or printed QR code. Are you sure you want to refresh it?",
          confirmText: "Refresh Code",
          cancelText: "Cancel",
          isDanger: true,
        })
      : window.confirm("Your saved QR image will stop working. Refresh your code?");
    if (!confirmed) return;

    try {
      let newToken = "";
      if (auth?.currentUser && functions) {
        try {
          const regenCallable = httpsCallable(functions, "regenerateMyQr");
          const res = await regenCallable();
          if (res && res.data && res.data.token) {
            newToken = res.data.token;
            const cooldownMs = res.data.cooldownMs || 180000;
            startCooldown(cooldownMs);
          }
        } catch (callErr) {
          console.warn("regenerateMyQr call failed, using local refresh:", callErr);
        }
      }

      if (!newToken) {
        let u = {};
        try {
          const local = JSON.parse(localStorage.getItem("recovibeCurrentUser") || sessionStorage.getItem("recovibeCurrentUser") || "null");
          u = local && Object.keys(local).length > 0 ? { ...DEFAULT_STUDENT, ...local } : DEFAULT_STUDENT;
        } catch {
          u = DEFAULT_STUDENT;
        }
        const uid = auth?.currentUser?.uid || u.uid || u.studentNumber || u.studentId || "2025-00790-BN-1";
        const currentV = Number(localStorage.getItem("recovibe_qr_version") || 1) + 1;
        localStorage.setItem("recovibe_qr_version", String(currentV));
        newToken = `${uid}.${currentV}.refreshed_signed_token`;
        startCooldown(180000);
      }

      currentPermanentToken = newToken;
      localStorage.setItem("recovibe_permanent_qr_token", newToken);

      initCardQr();
      if (modalOverlay && !modalOverlay.hidden && modalOverlay.style.display !== "none") {
        initModalQr();
      }

      const toastFn = window.showToast || (typeof showToast === "function" ? showToast : null);
      if (toastFn) {
        toastFn("QR code refreshed successfully.");
      } else {
        alert("New code ready. Download it again so your saved copy works.");
      }
    } catch (err) {
      console.warn("Failed to regenerate QR code:", err);
      const toastFn = window.showToast || (typeof showToast === "function" ? showToast : null);
      if (err.code === "functions/resource-exhausted" || err.message?.includes("wait")) {
        const retryAfterMs = err.details?.retryAfterMs || 180000;
        startCooldown(retryAfterMs);
        if (toastFn) toastFn("Please wait before refreshing your code again.", true);
        else alert("Please wait before refreshing your code again.");
      } else {
        const msg = err.message || "Could not refresh your code right now. Please try again later.";
        if (toastFn) toastFn(msg, true);
        else alert(msg);
      }
    }
  }

  async function handleDownloadCode() {
    if (!currentPermanentToken) {
      currentPermanentToken = localStorage.getItem("recovibe_permanent_qr_token") || "";
    }
    const studentInfo = getStudentDownloadInfo();
    await downloadQrCard(currentPermanentToken, studentInfo);
    const toastFn = window.showToast || (typeof showToast === "function" ? showToast : null);
    if (toastFn) toastFn("Attendance card downloaded.");
  }

  if (retryBtn) {
    retryBtn.addEventListener("click", (e) => {
      e.preventDefault();
      initCardQr();
    });
  }
  if (refreshBtn) {
    refreshBtn.addEventListener("click", (e) => {
      e.preventDefault();
      handleRefreshCode();
    });
  }
  if (downloadBtn) {
    downloadBtn.addEventListener("click", (e) => {
      e.preventDefault();
      handleDownloadCode();
    });
  }

  function getAllKnownEventIds() {
    const ids = new Set(["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]);
    try {
      const parts = JSON.parse(localStorage.getItem("recovibeParticipations") || "[]");
      if (Array.isArray(parts)) parts.forEach((id) => ids.add(String(id)));
    } catch {}
    try {
      const orgEvents = JSON.parse(localStorage.getItem("recovibeOrganizerEvents") || "[]");
      if (Array.isArray(orgEvents)) {
        orgEvents.forEach((e) => {
          const id = e.id || e.eventId;
          if (id) ids.add(String(id));
        });
      }
    } catch {}
    try {
      const teacherEvents = JSON.parse(localStorage.getItem("recovibeTeacherEvents") || "[]");
      if (Array.isArray(teacherEvents)) {
        teacherEvents.forEach((e) => {
          const id = e.id || e.eventId;
          if (id) ids.add(String(id));
        });
      }
    } catch {}
    if (Array.isArray(window.RECOVIBE_EVENTS)) {
      window.RECOVIBE_EVENTS.forEach((e) => {
        const id = e.id || e.eventId;
        if (id) ids.add(String(id));
      });
    }
    return Array.from(ids);
  }

  function getEventTitle(eventId) {
    try {
      if (Array.isArray(window.RECOVIBE_EVENTS)) {
        const ev = window.RECOVIBE_EVENTS.find((e) => String(e.id || e.eventId) === String(eventId));
        if (ev && ev.title) return ev.title;
      }
      const orgEvents = JSON.parse(localStorage.getItem("recovibeOrganizerEvents") || "[]");
      const orgEv = (orgEvents || []).find((e) => String(e.id || e.eventId) === String(eventId));
      if (orgEv && orgEv.title) return orgEv.title;

      const teacherEvents = JSON.parse(localStorage.getItem("recovibeTeacherEvents") || "[]");
      const teachEv = (teacherEvents || []).find((e) => String(e.id || e.eventId) === String(eventId));
      if (teachEv && teachEv.title) return teachEv.title;
    } catch {}
    return `Event #${eventId}`;
  }

  // Real-time checked-in state check across events (Task 5)
  function setupCheckedInWatcher() {
    if (!rtdb) return;
    let u = {};
    try {
      u = JSON.parse(localStorage.getItem("recovibeCurrentUser") || sessionStorage.getItem("recovibeCurrentUser") || "null") || {};
    } catch {}
    const uid = auth?.currentUser?.uid || u.uid;
    if (!uid) return;

    const eventIds = getAllKnownEventIds();

    eventIds.forEach((eventId) => {
      const attendanceRef = ref(rtdb, `attendance/${eventId}/${uid}`);
      onValue(attendanceRef, (snapshot) => {
        const val = snapshot.val();
        if (val && val.scannedAt) {
          const title = getEventTitle(eventId);
          const formatted = formatScannedTime(val.scannedAt);

          if (checkedInBadge) checkedInBadge.hidden = false;
          if (checkedInBanner) checkedInBanner.hidden = false;
          if (checkedInEventName) checkedInEventName.textContent = title;
          if (checkedInTime) checkedInTime.textContent = formatted;
        }
      }, (err) => {
        console.warn(`Attendance watcher notice for ${eventId}:`, err);
      });
    });
  }

  setupCheckedInWatcher();

  // Connect Firebase Auth to populate Profile and refresh QR
  onAuthStateChanged(auth, async (user) => {
    if (user && db) {
      try {
        const snap = await getDoc(doc(db, "users", user.uid));
        if (snap.exists()) {
          const profileData = snap.data();
          let current = {};
          try {
            current = JSON.parse(localStorage.getItem("recovibeCurrentUser") || sessionStorage.getItem("recovibeCurrentUser") || "null") || {};
          } catch {}
          const merged = {
            ...current,
            ...profileData,
            uid: user.uid,
            email: profileData.email || user.email || current.email || "",
            studentNumber: normalizeStudentNumber(profileData.studentNumber || profileData.studentId || current.studentNumber || current.studentId),
            studentId: normalizeStudentNumber(profileData.studentNumber || profileData.studentId || current.studentNumber || current.studentId),
          };
          const currentUserStorage = localStorage.getItem("recovibeCurrentUser")
            ? localStorage
            : sessionStorage;
          currentUserStorage.setItem("recovibeCurrentUser", JSON.stringify(merged));

          // Re-hydrate personal details
          hydrateUserProfile();
          const setText = (id, val) => {
            const el = document.getElementById(id);
            if (el) el.textContent = String(val || "").trim() || "Not provided";
          };
          const sName = String(merged.fullName || merged.name || "").trim();
          const nParts = sName.split(/\s+/).filter(Boolean);
          setText("profileFirstName", merged.firstName || nParts[0] || "");
          setText("profileMiddleName", merged.middleName || (nParts.length > 2 ? nParts.slice(1, -1).join(" ") : ""));
          setText("profileLastName", merged.lastName || (nParts.length > 1 ? nParts.at(-1) : ""));
          setText("profileStudentId", normalizeStudentNumber(merged.studentNumber || merged.studentId));
          setText("profileEmail", merged.email);
          setText("profileContact", merged.contactNumber || merged.contact);
          setText("profileDepartment", merged.department);
          setText("profileYear", merged.year);
          setText("profileOrganization", merged.organization);

          updateStudentCardInfo(merged);
        }
      } catch (err) {
        console.warn("Could not fetch user document:", err);
      }
      setupCheckedInWatcher();
    }
  });

  // Modal Component Setup (Task 2)
  let modalQrCleanup = null;
  let previousFocusedElement = null;

  function openModal(eventName = "") {
    if (!modalOverlay) return;
    previousFocusedElement = document.activeElement;

    let u = {};
    try {
      u = JSON.parse(localStorage.getItem("recovibeCurrentUser") || sessionStorage.getItem("recovibeCurrentUser") || "null") || {};
    } catch {}
    const sName = u.name || u.fullName || "Student";

    if (modalStudentName) modalStudentName.textContent = sName;
    if (modalEventName) {
      if (eventName) {
        modalEventName.textContent = eventName;
        modalEventName.hidden = false;
        modalEventName.style.display = "block";
      } else {
        modalEventName.hidden = true;
        modalEventName.style.display = "none";
      }
    }

    modalOverlay.hidden = false;
    modalOverlay.style.display = "flex";
    modalOverlay.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";

    initModalQr();

    if (modalCloseBtn) modalCloseBtn.focus();
  }

  function closeModal() {
    if (!modalOverlay || (modalOverlay.hidden && modalOverlay.style.display === "none")) return;
    modalOverlay.hidden = true;
    modalOverlay.style.display = "none";
    modalOverlay.setAttribute("aria-hidden", "true");
    document.body.style.overflow = "";

    if (modalQrCleanup) {
      modalQrCleanup();
      modalQrCleanup = null;
    }

    if (previousFocusedElement && typeof previousFocusedElement.focus === "function") {
      previousFocusedElement.focus();
    }
  }

  function initModalQr() {
    if (modalQrCleanup) {
      modalQrCleanup();
      modalQrCleanup = null;
    }
    if (!modalCanvas) return;

    modalQrCleanup = renderMyQr(modalCanvas, {
      width: 260,
      skeletonEl: modalSkeleton,
      canvasBoxEl: modalCanvasBox,
      errorEl: modalError,
      countdownEl: modalCountdown,
    });
  }

  if (showFullBtn) {
    showFullBtn.addEventListener("click", (e) => {
      e.preventDefault();
      openModal();
    });
  }
  if (modalCloseBtn) {
    modalCloseBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      closeModal();
    });
  }
  if (modalCloseActionBtn) {
    modalCloseActionBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      closeModal();
    });
  }
  if (modalBackdrop) {
    modalBackdrop.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      closeModal();
    });
  }
  if (modalOverlay) {
    modalOverlay.addEventListener("click", (e) => {
      if (e.target === modalOverlay) {
        e.preventDefault();
        closeModal();
      }
    });
  }
  if (modalRetryBtn) {
    modalRetryBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      initModalQr();
    });
  }
  if (modalRefreshBtn) {
    modalRefreshBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      handleRefreshCode();
    });
  }
  if (modalDownloadBtn) {
    modalDownloadBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      handleDownloadCode();
    });
  }

  // Close on Escape and manage Accessible Focus Trap
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      const confirmOverlay = document.getElementById("confirmModalOverlay");
      if (confirmOverlay && !confirmOverlay.hidden && confirmOverlay.style.display !== "none") {
        document.getElementById("confirmModalCancelBtn")?.click();
        return;
      }

      const correctionModal = document.getElementById("correctionModalOverlay");
      if (correctionModal && !correctionModal.hidden && correctionModal.style.display !== "none") {
        document.getElementById("btnCancelCorrection")?.click();
        return;
      }

      if (typeof window.cancelActiveCardEdit === "function" && window.cancelActiveCardEdit()) {
        return;
      }

      const passModal = document.getElementById("passwordFormModal");
      if (passModal && !passModal.hidden && passModal.style.display !== "none") {
        if (typeof window.closePasswordModal === "function") {
          window.closePasswordModal();
        } else {
          document.getElementById("cancelPasswordChange")?.click();
        }
        return;
      }

      if (modalOverlay && !modalOverlay.hidden && modalOverlay.style.display !== "none") {
        closeModal();
        return;
      }
    }

    if (!modalOverlay || modalOverlay.hidden || modalOverlay.style.display === "none") return;

    if (event.key === "Tab") {
      const focusable = modalOverlay.querySelectorAll(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      const focusableElements = Array.from(focusable).filter((el) => !el.hidden && el.offsetParent !== null);
      if (focusableElements.length === 0) return;

      const firstElement = focusableElements[0];
      const lastElement = focusableElements[focusableElements.length - 1];

      if (event.shiftKey) {
        if (document.activeElement === firstElement) {
          lastElement.focus();
          event.preventDefault();
        }
      } else {
        if (document.activeElement === lastElement) {
          firstElement.focus();
          event.preventDefault();
        }
      }
    }
  });
})();
