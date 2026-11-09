import {
  createUserWithEmailAndPassword,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  arrayUnion,
  doc,
  getDocs,
  collection,
  serverTimestamp,
  setDoc,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { auth, db, isFirebaseConfigured } from "./firebaseConfig.js";

const form = document.getElementById("student-registration-form");
const submitButton = document.getElementById("create-account");
const fields = {
  lastName: document.getElementById("reg-lastname"),
  firstName: document.getElementById("reg-firstname"),
  middleName: document.getElementById("reg-middlename"),
  studentId: document.getElementById("reg-student-id"),
  email: document.getElementById("reg-email"),
  contact: document.getElementById("reg-contact"),
  year: document.getElementById("reg-year"),
  department: document.getElementById("reg-department"),
  courseOrganization: document.getElementById("reg-course-organization"),
  gender: document.getElementById("reg-gender"),
  password: document.getElementById("reg-pass"),
  confirmation: document.getElementById("reg-confirm"),
};

window.enhanceDropdownSelects?.(
  "#reg-department, #reg-course-organization, #reg-gender",
);
const noMiddleNameBox = document.getElementById("no-middle-name");
const namePattern = /^[\p{L}\p{M}]+(?:[ .'-][\p{L}\p{M}]+)*\.?$/u;
const emailPattern =
  /^(?=.{1,254}$)(?!.*\.\.)[A-Z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?\.)+[A-Z]{2,}$/i;
const studentNumberPattern = /^\d{4}-\d{5}-BN-\d$/;
const contactPattern = /^09[0-9]{9}$/;
const yearPattern = /^[1-5]-[1-5]$/;
const touchedFields = new Set();
let submitted = false;
const defaultPreferences = {
  categories: ["Academic & Learning", "Tech & Innovation"],
  sources: [
    "PUP Official",
    "CSC",
    "Organizational",
    "Others / External",
  ],
};

function setInvalid(fieldId, invalid, message = "") {
  const field = document.getElementById(fieldId);
  const control = field.querySelector("input, select");
  const error =
    field.querySelector(".error-msg") ||
    document.getElementById(`${fieldId.replace("field-", "")}-error`);
  field.classList.toggle("invalid", invalid);
  error.classList.toggle("visible", invalid);
  error.textContent = invalid ? message : "";
  if (invalid) control.setAttribute("aria-invalid", "true");
  else control.removeAttribute("aria-invalid");

  const customButton = field.querySelector(
    ".native-filter-dropdown .filter-button",
  );
  if (customButton) {
    if (invalid) {
      customButton.setAttribute("aria-invalid", "true");
      customButton.setAttribute("aria-describedby", error.id);
    } else {
      customButton.removeAttribute("aria-invalid");
      customButton.removeAttribute("aria-describedby");
    }
    if (control.title) customButton.title = control.title;
  }
}

function valueOf(control) {
  return control.value.trim();
}

function normalizeName(value) {
  return value
    .replace(/ {2,}/g, " ")
    .replace(/^ /, "")
    .replace(/(^|[ '-])(\p{L})/gu, (_, separator, letter) =>
      separator + letter.toUpperCase(),
    );
}

function normalizeYear(value) {
  const allowed = value.replace(/[^0-9-]/g, "");
  const first = allowed[0];
  if (!first || !/[1-5]/.test(first)) return "";

  const rest = allowed.slice(1);
  if (rest.startsWith("-")) {
    const second = rest.slice(1).match(/[0-9]/)?.[0];
    return second && /[1-5]/.test(second) ? `${first}-${second}` : `${first}-`;
  }

  const second = rest.match(/[0-9]/)?.[0];
  return second && /[1-5]/.test(second) ? `${first}-${second}` : first;
}

function normalizePhone(value) {
  const digits = value.replace(/\D/g, "");
  if (digits.startsWith("09")) return digits.slice(0, 11);
  if (digits.startsWith("639")) return `0${digits.slice(2, 12)}`;
  if (digits.startsWith("9")) return `0${digits.slice(0, 10)}`;
  return `09${digits.replace(/^0+/, "").slice(0, 9)}`;
}

function normalizeStudentNumber(value) {
  return value.trim().toUpperCase();
}

function normalizeWithCaret(control, normalize) {
  const value = control.value;
  const start = control.selectionStart ?? value.length;
  const end = control.selectionEnd ?? start;
  const nextValue = normalize(value);
  if (nextValue !== value) {
    const nextStart = normalize(value.slice(0, start)).length;
    const nextEnd = normalize(value.slice(0, end)).length;
    control.value = nextValue;
    control.setSelectionRange(
      Math.min(nextStart, nextValue.length),
      Math.min(nextEnd, nextValue.length),
    );
  }
}

const passwordRules = [
  ["length", (value) => value.length >= 8],
  ["uppercase", (value) => /[A-Z]/.test(value)],
  ["lowercase", (value) => /[a-z]/.test(value)],
  ["number", (value) => /\d/.test(value)],
  ["special", (value) => /[^\p{L}\p{N}\s]/u.test(value)],
];

function updatePasswordChecklist() {
  const password = fields.password.value;
  passwordRules.forEach(([rule, test]) => {
    const item = document.querySelector(
      `#reg-pass-checklist [data-rule="${rule}"]`,
    );
    const met = test(password);
    item.classList.toggle("met", met);
    item.setAttribute("aria-label", `${item.textContent.trim()}${met ? " met" : " required"}`);
  });
}

function isValidName(value) {
  const normalized = value.normalize("NFC");
  const length = Array.from(normalized).length;
  return length >= 2 && length <= 50 && namePattern.test(normalized);
}

function isValidEmail(value) {
  if (value.length > 254 || /\s/.test(value) || (value.match(/@/g) || []).length !== 1) {
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

function validateField(name) {
  const value = valueOf(fields[name]);

  if (name === "lastName" || name === "firstName") {
    const label = name === "lastName" ? "Last name" : "First name";
    const fieldId =
      name === "lastName" ? "field-reg-lastname" : "field-reg-firstname";
    if (!value) {
      setInvalid(fieldId, true, `Enter your ${label.toLowerCase()}.`);
      return false;
    }
    const valid = isValidName(value);
    setInvalid(
      fieldId,
      !valid,
      "Use 2–50 valid name characters.",
    );
    return valid;
  }

  if (name === "middleName") {
    if (noMiddleNameBox.checked) {
      setInvalid("field-reg-middlename", false);
      return true;
    }
    const valid = isValidName(value);
    setInvalid(
      "field-reg-middlename",
      !valid,
      value
        ? "Use 2–50 valid name characters."
        : "Enter middle name or check box.",
    );
    return valid;
  }

  if (name === "email") {
    const email = value.toLowerCase();
    const valid = Boolean(email) && isValidEmail(email);
    setInvalid(
      "field-reg-email",
      !valid,
      email ? "Enter a valid email address." : "Email is required.",
    );
    return valid;
  }

  if (name === "studentId") {
    const valid = studentNumberPattern.test(value.trim().toUpperCase());
    setInvalid(
      "field-reg-student-id",
      !valid,
      "Student number must follow the format 2023-00123-BN-0.",
    );
    return valid;
  }

  if (name === "contact") {
    const valid = value !== "09" && contactPattern.test(value);
    setInvalid(
      "field-reg-contact",
      !valid,
      "Enter a valid 11-digit contact number.",
    );
    return valid;
  }

  if (name === "year") {
    const valid = yearPattern.test(value);
    setInvalid("field-reg-year", !valid, "Enter year and section like 2-3.");
    return valid;
  }

  if (["department", "courseOrganization", "gender"].includes(name)) {
    const fieldIds = {
      department: "field-reg-department",
      courseOrganization: "field-reg-course-organization",
      gender: "field-reg-gender",
    };
    const valid = Boolean(fields[name].value);
    const label = name === "courseOrganization" ? "course organization" : name;
    setInvalid(fieldIds[name], !valid, `Select your ${label}.`);
    return valid;
  }

  if (name === "password") {
    const rawValue = fields.password.value;
    const valid =
      rawValue.length >= 8 &&
      rawValue.length <= 64 &&
      !/\s/.test(rawValue) &&
      passwordRules.every(([, test]) => test(rawValue));
    setInvalid(
      "field-reg-pass",
      !valid,
      "",
    );
    updatePasswordChecklist();
    return valid;
  }

  if (name === "confirmation") {
    const valid = Boolean(fields.confirmation.value) &&
      fields.confirmation.value === fields.password.value;
    setInvalid("field-reg-confirm", !valid, "Passwords do not match.");
    return valid;
  }

  return true;
}

const fieldOrder = [
  "lastName",
  "firstName",
  "middleName",
  "email",
  "studentId",
  "contact",
  "department",
  "year",
  "courseOrganization",
  "gender",
  "password",
  "confirmation",
];

function validateAll() {
  const results = fieldOrder.map((name) => ({
    name,
    valid: validateField(name),
  }));
  const invalidName = results.find((result) => !result.valid)?.name;
  if (!invalidName) return true;

  const field = fields[invalidName].closest(".field");
  const focusTarget =
    field.querySelector(".native-filter-dropdown .filter-button") ||
    fields[invalidName];
  focusTarget.scrollIntoView({ behavior: "smooth", block: "center" });
  focusTarget.focus();
  return false;
}

function updateLiveValidation(name) {
  if (
    submitted ||
    touchedFields.has(name) ||
    fields[name].closest(".field").classList.contains("invalid")
  ) {
    validateField(name);
  }
  if (
    name === "password" &&
    (submitted ||
      touchedFields.has("confirmation") ||
    Boolean(fields.confirmation.value) ||
      fields.confirmation.closest(".field").classList.contains("invalid"))
  ) {
    validateField("confirmation");
  }
}

fields.contact.value = normalizePhone(fields.contact.value || "09");

fields.contact.addEventListener("focus", () => {
  if (!fields.contact.value.startsWith("09")) {
    fields.contact.value = normalizePhone(fields.contact.value);
  }
  const start = fields.contact.selectionStart ?? fields.contact.value.length;
  const end = fields.contact.selectionEnd ?? start;
  if (start < 2) {
    fields.contact.setSelectionRange(2, Math.max(2, end));
  }
});

fields.contact.addEventListener("click", () => {
  const start = fields.contact.selectionStart ?? 0;
  const end = fields.contact.selectionEnd ?? start;
  if (start < 2) fields.contact.setSelectionRange(2, Math.max(2, end));
});

fields.contact.addEventListener("keydown", (event) => {
  const start = fields.contact.selectionStart ?? 0;
  const end = fields.contact.selectionEnd ?? start;
  const fullSelection = start === 0 && end === fields.contact.value.length;
  if (event.key === "Home") {
    event.preventDefault();
    fields.contact.setSelectionRange(2, 2);
    return;
  }
  if (event.key === "ArrowLeft" && start <= 2) {
    event.preventDefault();
    fields.contact.setSelectionRange(2, 2);
    return;
  }
  if (["Backspace", "Delete"].includes(event.key)) {
    if (fullSelection) {
      event.preventDefault();
      fields.contact.value = "09";
      fields.contact.setSelectionRange(2, 2);
      fields.contact.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }
    if (start < 2) {
      if (end > 2) fields.contact.setSelectionRange(2, end);
      else {
        event.preventDefault();
        fields.contact.setSelectionRange(2, 2);
      }
      return;
    }
    if (start === 2 && end === 2) {
      event.preventDefault();
      return;
    }
  }
  if (
    start < 2 &&
    event.key.length === 1 &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey
  ) {
    fields.contact.setSelectionRange(2, Math.max(2, end));
  }
});

fields.contact.addEventListener("paste", (event) => {
  event.preventDefault();
  fields.contact.value = normalizePhone(
    event.clipboardData?.getData("text") || "",
  );
  fields.contact.setSelectionRange(
    fields.contact.value.length,
    fields.contact.value.length,
  );
  fields.contact.dispatchEvent(new Event("input", { bubbles: true }));
});

fields.year.addEventListener("paste", (event) => {
  const pasted = event.clipboardData?.getData("text") || "";
  if (!/^[1-5](?:-?[1-5])?$/.test(pasted)) {
    event.preventDefault();
    return;
  }
  event.preventDefault();
  fields.year.value = normalizeYear(pasted);
  fields.year.setSelectionRange(
    fields.year.value.length,
    fields.year.value.length,
  );
  fields.year.dispatchEvent(new Event("input", { bubbles: true }));
});

Object.entries(fields).forEach(([name, control]) => {
  const normalize = () => {
    if (
      name === "lastName" ||
      name === "firstName" ||
      name === "middleName"
    ) {
      normalizeWithCaret(control, normalizeName);
    } else if (name === "email") {
      normalizeWithCaret(control, (value) => value.toLowerCase());
    } else if (name === "studentId") {
      normalizeWithCaret(control, normalizeStudentNumber);
    } else if (name === "contact") {
      normalizeWithCaret(control, normalizePhone);
    } else if (name === "year") {
      normalizeWithCaret(control, normalizeYear);
    }
  };

  if (control.tagName === "SELECT") {
    control.addEventListener("change", () => {
      touchedFields.add(name);
      const selected = control.selectedOptions[0];
      control.title = selected?.title || selected?.textContent.trim() || "";
      updateLiveValidation(name);
    });
    control.addEventListener("blur", () => {
      touchedFields.add(name);
      updateLiveValidation(name);
    });
  } else {
    control.addEventListener("input", () => {
      normalize();
      if (name === "password") updatePasswordChecklist();
      updateLiveValidation(name);
    });
    control.addEventListener("blur", () => {
      normalize();
      if (
        name === "lastName" ||
        name === "firstName" ||
        name === "middleName" ||
        name === "email" ||
        name === "studentId"
      ) {
        control.value = control.value.trim();
      }
      if (name === "email") control.value = control.value.toLowerCase();
      touchedFields.add(name);
      updateLiveValidation(name);
    });
  }

  const customButton = control
    .closest(".field")
    .querySelector(".native-filter-dropdown .filter-button");
  if (customButton) {
    customButton.addEventListener("blur", () => {
      touchedFields.add(name);
      updateLiveValidation(name);
    });

    customButton.title =
      control.selectedOptions[0]?.title ||
      control.selectedOptions[0]?.textContent.trim() ||
      "";
  }
});

noMiddleNameBox.addEventListener("change", () => {
  fields.middleName.disabled = noMiddleNameBox.checked;
  fields.middleName.setAttribute(
    "aria-disabled",
    String(noMiddleNameBox.checked),
  );
  if (noMiddleNameBox.checked) {
    fields.middleName.value = "";
    touchedFields.add("middleName");
    setInvalid("field-reg-middlename", false);
  } else if (submitted || touchedFields.has("middleName")) {
    fields.middleName.focus();
    validateField("middleName");
  }
});

fields.middleName.setAttribute("aria-disabled", "false");
updatePasswordChecklist();

document.querySelectorAll(".toggle-password").forEach((button) => {
  button.addEventListener("click", () => {
    const input = document.getElementById(button.dataset.target);
    const showing = input.type === "text";
    input.type = showing ? "password" : "text";
    button.querySelector(".icon-eye").style.display = showing ? "" : "none";
    button.querySelector(".icon-eye-off").style.display = showing ? "none" : "";
    button.setAttribute(
      "aria-label",
      showing ? "Show password" : "Hide password",
    );
  });
});

function registrationErrorMessage(error) {
  switch (error.code) {
    case "auth/email-already-in-use":
      return "This email is already registered.";
    case "auth/weak-password":
      return "Use a stronger password that meets the listed requirements.";
    case "auth/invalid-email":
      return "Enter a valid email address.";
    case "auth/operation-not-allowed":
      return "Student registration is unavailable right now. Please contact support.";
    case "auth/network-request-failed":
      return "A network error occurred. Check your connection and try again.";
    case "permission-denied":
    case "firestore/permission-denied":
      return "Your sign-in account was created, but Firestore denied saving users/{uid}. Do not create another account. Ask an administrator to allow the signed-in user to create their own student profile, then submit this form again.";
    default:
      return "We couldn't create your account right now. Please try again.";
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  submitted = true;
  document.getElementById("registration-form-error").textContent = "";
  fields.lastName.value = fields.lastName.value.trim();
  fields.firstName.value = fields.firstName.value.trim();
  fields.lastName.value = normalizeName(fields.lastName.value);
  fields.firstName.value = normalizeName(fields.firstName.value);
  fields.middleName.value = normalizeName(fields.middleName.value.trim());
  fields.email.value = fields.email.value.trim().toLowerCase();
  fields.studentId.value = normalizeStudentNumber(
    fields.studentId.value.trim(),
  );
  fields.contact.value = normalizePhone(fields.contact.value);
  fields.year.value = normalizeYear(fields.year.value);
  if (!validateAll()) return;

  if (!isFirebaseConfigured || !auth || !db) {
    document.getElementById("registration-form-error").textContent =
      "Student registration is not configured yet. Please contact support.";
    return;
  }

  const lastName = valueOf(fields.lastName);
  const firstName = valueOf(fields.firstName);
  const middleName = noMiddleNameBox.checked ? "" : valueOf(fields.middleName);
  const email = valueOf(fields.email).toLowerCase();
  const studentNumber = valueOf(fields.studentId);
  const contactNumber = valueOf(fields.contact);
  const department = fields.department.selectedOptions?.[0]?.textContent.trim() || valueOf(fields.department);
  const departmentCode = fields.department.value;
  const year = valueOf(fields.year);
  const organization = String(fields.courseOrganization.value || "").trim();
  const gender = fields.gender.value;

  // 1:1 Form Layout mapping
  const profile = {
    // Row 1
    lastName,
    firstName,
    middleName,

    // Row 2
    email,
    studentNumber,
    contactNumber,

    // Row 3
    department,
    departmentCode,
    departments: arrayUnion(department, departmentCode),
    departmentCodes: arrayUnion(departmentCode),
    year,
    organization,
    courseOrganization: organization,
    StudentOrgs: arrayUnion(organization),
    studentOrgs: arrayUnion(organization),
    organizations: arrayUnion(organization),
    courseOrganizations: arrayUnion(organization),
    gender,
    preferences: defaultPreferences,

    // Metadata
    fullName: [firstName, middleName, lastName].filter(Boolean).join(" "),
    name: [firstName, middleName, lastName].filter(Boolean).join(" "),
    uid: "",
    role: "student",
    status: "Active",
    createdAt: serverTimestamp(),
  };

  submitButton.disabled = true;
  submitButton.setAttribute("aria-busy", "true");
  submitButton.textContent = "Creating account...";

  try {
    const existingUsers = await getDocs(collection(db, "users"));
    const duplicateEmail = existingUsers.docs.some((userDoc) =>
      String(userDoc.data()?.email || "").trim().toLowerCase() === email,
    );
    if (duplicateEmail) {
      setInvalid("field-reg-email", true, "This email is already registered.");
      fields.email.focus();
      return;
    }
    const duplicateStudentNumber = existingUsers.docs.some((userDoc) =>
      String(userDoc.data()?.studentNumber || userDoc.data()?.studentId || "")
        .trim()
        .toUpperCase() === studentNumber,
    );
    if (duplicateStudentNumber) {
      setInvalid("field-reg-student-id", true, "This Student Number is already registered.");
      fields.studentId.focus();
      return;
    }
    const user = (
      await createUserWithEmailAndPassword(
        auth,
        email,
        fields.password.value,
      )
    ).user;
    profile.uid = user.uid;
    await setDoc(doc(db, "users", user.uid), profile);

    alert("Your student account has been created! Redirecting...");
    window.location.assign("StudentLogin.html");
  } catch (error) {
    console.error("[StudentRegistration] Account/profile write failed:", {
      code: error?.code || "unknown",
      message: error?.message || String(error),
      uid: auth.currentUser?.uid || null,
      profilePath: auth.currentUser?.uid
        ? `users/${auth.currentUser.uid}`
        : null,
    });
    const message = registrationErrorMessage(error);
    if (error.code === "auth/email-already-in-use") {
      setInvalid("field-reg-email", true, message);
      fields.email.focus();
    } else if (error.code === "auth/weak-password") {
      setInvalid("field-reg-pass", true, message);
      fields.password.focus();
    } else if (error.code === "auth/invalid-email") {
      setInvalid("field-reg-email", true, message);
      fields.email.focus();
    } else {
      document.getElementById("registration-form-error").textContent =
        message;
    }
  } finally {
    submitButton.disabled = false;
    submitButton.removeAttribute("aria-busy");
    submitButton.textContent = "Create account";
  }
});
