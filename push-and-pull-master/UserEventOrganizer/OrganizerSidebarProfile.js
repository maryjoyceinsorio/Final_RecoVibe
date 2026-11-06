import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { auth, db } from "../UserStudent/firebaseConfig.js";

function firstValue(...values) {
  return values
    .map((value) => String(value || "").trim())
    .find((value) => value && !["event organizer", "alex rivera"].includes(value.toLowerCase())) || "";
}

function ensureSidebarProfileCard() {
  const sidebar = document.querySelector(".organizer-sidebar");
  if (!sidebar || sidebar.querySelector(".user-card, .organizer-account")) return;
  const footer = sidebar.querySelector(".organizer-sidebar-footer, .sidebar-bottom");
  if (!footer) return;

  const card = document.createElement("div");
  card.className = "organizer-account organizer-shared-profile-card";
  card.innerHTML = `
    <div class="organizer-avatar" id="organizerAvatar">EO</div>
    <div class="organizer-account-copy">
      <strong id="organizerName">Event Organizer</strong>
      <small id="organizerRole">Event Organizer account</small>
    </div>`;
  footer.prepend(card);

  if (!document.getElementById("organizerSidebarProfileStyles")) {
    const style = document.createElement("style");
    style.id = "organizerSidebarProfileStyles";
    style.textContent = `
      .organizer-shared-profile-card { display:flex; align-items:center; gap:10px; padding:12px 10px; }
      .organizer-shared-profile-card .organizer-avatar { display:grid; place-items:center; flex:0 0 38px; width:38px; height:38px; border-radius:50%; background:#d4a72c; color:#fff; font-weight:700; }
      .organizer-shared-profile-card .organizer-account-copy { display:grid; min-width:0; gap:2px; }
      .organizer-shared-profile-card .organizer-account-copy strong,
      .organizer-shared-profile-card .organizer-account-copy small { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    `;
    document.head.append(style);
  }
}

function renderOrganizerProfile(user, profile = {}, preferAuth = false) {
  ensureSidebarProfileCard();
  const cachedProfileName = [
    profile.fullName,
    [profile.firstName, profile.middleName, profile.lastName].filter(Boolean).join(" "),
    profile.name,
    profile.displayName,
  ];
  const nameCandidates = preferAuth
    ? [user.displayName, ...cachedProfileName, user.email]
    : [...cachedProfileName, user.displayName, user.email];
  const name = firstValue(...nameCandidates) || "Event Organizer";
  const organization = firstValue(
    profile.organization,
    profile.orgName,
    profile.department,
    profile.organizationName,
  );
  const accountNumber = firstValue(
    profile.accountNumber,
    profile.accountNo,
    profile.organizerNumber,
    profile.organizerNo,
  );
  const accountDetails = [
    organization ? `${organization} account` : "",
    accountNumber,
  ].filter(Boolean).join(" · ") || user.email || "Event Organizer account";
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join("") || "EO";

  ["userName", "organizerName"].forEach((id) => {
    const element = document.getElementById(id);
    if (element) element.textContent = name;
  });
  ["userRole", "organizerRole"].forEach((id) => {
    const element = document.getElementById(id);
    if (element) element.textContent = accountDetails;
  });
  ["userAvatar", "organizerAvatar"].forEach((id) => {
    const element = document.getElementById(id);
    if (element) element.textContent = initials;
  });
  document.querySelectorAll(".organizer-account").forEach((account) => {
    const avatar = account.querySelector(".organizer-avatar");
    const nameElement = account.querySelector(".organizer-account-copy strong");
    const detailsElement = account.querySelector(".organizer-account-copy small");
    if (avatar) avatar.textContent = initials;
    if (nameElement) nameElement.textContent = name;
    if (detailsElement) detailsElement.textContent = accountDetails;
  });

  const dashboardHeading = document.getElementById("organizerDashboardHeading");
  if (dashboardHeading) {
    const hour = new Date().getHours();
    const greeting = hour < 12 ? "Morning" : hour < 18 ? "Noon" : "Evening";
    dashboardHeading.textContent = `Good ${greeting}, ${name}!`;
  }
}

onAuthStateChanged(auth, async (user) => {
  if (!user) return;

  let cachedProfile = {};
  try {
    const value = JSON.parse(localStorage.getItem("recovibeOrganizerProfile") || "{}");
    if (value && typeof value === "object") cachedProfile = value;
  } catch (error) {
    console.warn("[OrganizerSidebarProfile] Unable to read cached profile:", error);
  }
  renderOrganizerProfile(user, cachedProfile, true);

  if (!db) return;
  const results = await Promise.allSettled([
    getDoc(doc(db, "users", user.uid)),
    getDoc(doc(db, "adminUser", user.uid)),
  ]);
  if (auth.currentUser?.uid !== user.uid) return;

  results.forEach((result, index) => {
    if (result.status === "rejected") {
      console.warn(
        `[OrganizerSidebarProfile] Unable to load ${index === 0 ? "users" : "adminUser"} profile:`,
        result.reason,
      );
    }
  });

  const userProfile = results[0].status === "fulfilled" && results[0].value.exists()
    ? results[0].value.data()
    : {};
  const adminProfile = results[1].status === "fulfilled" && results[1].value.exists()
    ? results[1].value.data()
    : {};
  renderOrganizerProfile(user, { ...cachedProfile, ...userProfile, ...adminProfile });
});
