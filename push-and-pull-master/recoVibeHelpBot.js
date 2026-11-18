// RecoVibe built-in help chatbot. Client-side only: no Firebase, no network, no API keys.
// Usage: import { mountHelpBot } from "./recoVibeHelpBot.js"; mountHelpBot({ role: "student" });

const FAQ = [
  {
    id: "hello", q: "Hello",
    keywords: ["hello", "hi", "hey", "good morning", "good afternoon", "help"],
    a: "Hi! I'm the RecoVibe helper. Ask me about registering for events, attendance, profile corrections, the calendar, notifications, or what each role can do."
  },
  {
    id: "register", q: "How do I register for an event?",
    keywords: ["register", "registration", "join event", "sign up", "enroll event", "participate"],
    a: "To register for an event:\n1. Open the Events page and pick a published event.\n2. Open its details and press Register.\n3. You will see your status as Registered, and the event appears in your registered list.\nYou can only register for events that are published. Teachers do not register for or participate in events."
  },
  {
    id: "cancel", q: "How do I cancel my registration?",
    keywords: ["cancel registration", "unregister", "withdraw", "cancel event", "cancel my"],
    a: "Open the event you registered for and press Cancel registration. Your status changes to Cancelled. If the event is still open you can register again later."
  },
  {
    id: "attendance", q: "How does attendance scanning work?",
    keywords: ["attendance", "scan", "scanning", "qr", "check in", "check-in", "time in", "present"],
    // EDIT: describe your real flow (QR on the student's phone, organizer scanner, etc.).
    a: "Attendance is recorded at the event:\n1. Register for the event beforehand.\n2. At the venue, show your QR code or ID to the organizer.\n3. The organizer scans it and your attendance is recorded.\nOnly registered students can be marked present."
  },
  {
    id: "attendance-missing", q: "My attendance was not recorded",
    keywords: ["attendance missing", "not recorded", "not counted", "absent", "wasn't scanned", "scan failed", "scan not working"],
    a: "If your attendance is not showing:\n• Make sure your registration status was Registered before the event.\n• Refresh the page and check again after a few minutes.\n• If it is still missing, tell the event organizer on the day, with your name and student number, so they can check the scan list."
  },
  {
    id: "correction-how", q: "How do I request a profile correction?",
    keywords: ["correction", "request correction", "correct", "wrong", "mistake", "change my", "edit profile", "update profile", "wrong department", "wrong student number", "typo"],
    a: "Profile details such as department, student number, year and section, teacher ID or organization cannot be edited directly. To fix one:\n1. Open your Profile.\n2. Press Request a correction.\n3. Choose the field, enter the correct value, and write a reason (10 to 500 characters).\n4. Submit. Your request shows up under My correction requests."
  },
  {
    id: "correction-rules", q: "What are the correction request rules?",
    keywords: ["correction rules", "correction rule", "rules", "same value", "different value", "reason", "how long", "limit"],
    a: "Correction rules:\n• The new value must be different from your current value.\n• The reason must be 10 to 500 characters.\n• The new value can be up to 200 characters.\n• Only OSAS can review requests. Nobody else can approve them.\n• When OSAS approves, your profile is updated automatically. If rejected, your profile stays the same and you can send a new request with a better reason."
  },
  {
    id: "correction-status", q: "Where can I see my correction request status?",
    keywords: ["correction status", "my correction requests", "pending", "approved", "rejected", "track request", "status of request"],
    a: "Open your Profile and look at My correction requests. Each request shows Pending, Approved or Rejected, along with any note from OSAS. You also receive a notification when it is reviewed."
  },
  {
    id: "who-approves", q: "Who approves correction requests?",
    keywords: ["who approves", "who approve", "approver", "osas", "who reviews", "review request"],
    a: "Only the OSAS office reviews correction requests. Teachers, event organizers, advisers and other admins cannot approve or reject them.",
    roles: ["osas", "admin"]
  },
  {
    id: "roles", q: "What can each role do?",
    keywords: ["role", "roles", "permission", "permissions", "access", "who can", "allowed", "what can i do", "can i"],
    a: "Roles in RecoVibe:\n• Student: browse and register for published events, view the calendar, request profile corrections.\n• Event Organizer: create and manage events for their own organization.\n• Adviser / Admin: review and manage events for their organization.\n• OSAS: reviews correction requests and manages the academic calendar.\n• Teacher: views events, the calendar and notifications. Teachers do not participate in events or approve anything.\n• Super Admin: manages system settings and accounts."
  },
  {
    id: "create-event", q: "How do I create an event?",
    keywords: ["create event", "new event", "add event", "make event", "organize", "organizer", "post event", "submit event"],
    a: "Event Organizers can create events from the Events page using Create event. Fill in the title, date, venue and details, then submit. Events are reviewed before they are published to students, and you are notified of the result.",
    roles: ["eventorganizer"]
  },
  {
    id: "event-status", q: "Why can't I see an event?",
    keywords: ["can't see event", "cannot see event", "event missing", "event not showing", "hidden event", "not published", "draft"],
    a: "Students only see published events. An event that is still pending, rejected or in draft is visible only to its organizer and reviewers. If an event should be visible, ask the organizer to check its status."
  },
  {
    id: "calendar", q: "What do the calendar colors mean?",
    keywords: ["calendar", "holiday", "holidays", "official date", "colors", "colour", "dot", "academic calendar", "semester dates", "deadline"],
    a: "The calendar shows events together with official academic dates from OSAS. Holidays are orange; other official dates (exams, enrollment, deadlines, breaks and so on) use their own colors. Click a day to see everything on that date."
  },
  {
    id: "calendar-import", q: "How do I add the academic calendar?",
    keywords: ["import calendar", "add calendar", "upload calendar", "paste calendar", "parse calendar", "academic calendar import", "save calendar"],
    a: "OSAS can paste the official calendar text in Admin Calendar, review the preview table, fix any warnings, and press Save. Importing the same semester again overwrites the old entries instead of duplicating them.",
    roles: ["osas"]
  },
  {
    id: "notifications", q: "How do notifications work?",
    keywords: ["notification", "notifications", "alert", "bell", "unread", "mark as read", "delete notification", "reminder"],
    a: "The Notifications page lists updates about your events, correction requests and upcoming or ongoing academic dates. Mark items as read or remove them from the list. These actions only affect your own view."
  },
  {
    id: "login", q: "I can't log in",
    keywords: ["login", "log in", "sign in", "password", "forgot password", "reset password", "can't login", "cannot login", "locked", "account disabled"],
    a: "Check that you are using your registered email and the correct password. If you forgot it, use Forgot password on the login page. If your account says it is disabled or inactive, contact the OSAS office or your administrator."
  },
  {
    id: "support", q: "Who do I contact for more help?",
    keywords: ["contact", "support", "help desk", "report problem", "bug", "issue", "human", "email"],
    // EDIT: put your real office / email here.
    a: "For anything I can't answer, visit the PUP Biñan OSAS office or contact your event organizer or adviser. Please include your name, student number and a screenshot of the problem."
  }
];

const SUGGESTIONS = {
  student: ["register", "attendance", "correction-how", "calendar"],
  teacher: ["correction-how", "roles", "calendar", "notifications"],
  eventorganizer: ["create-event", "attendance", "correction-how", "roles"],
  osas: ["who-approves", "calendar-import", "correction-rules", "roles"],
  admin: ["roles", "event-status", "calendar", "notifications"],
  default: ["register", "correction-how", "attendance", "roles"]
};

// ---------- matching ----------
const STOP = new Set("a an the is are am to of in on for and or my me i do does can how what why where when it this that with be there any".split(" "));
const stem = (w) => (w.length > 4 ? w.replace(/(ing|ed|es|s)$/, "") : w);
const words = (s) => String(s).toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean).map(stem);
const meaningful = (s) => words(s).filter((w) => !STOP.has(w));

const INDEX = FAQ.map((f) => ({
  f,
  phrases: f.keywords.map((k) => " " + words(k).join(" ") + " "),
  title: new Set(meaningful(f.q))
}));

function findAnswer(text) {
  const all = " " + words(text).join(" ") + " ";
  const tokens = new Set(meaningful(text));
  let best = null, bestScore = 0;
  for (const it of INDEX) {
    let s = 0;
    for (const p of it.phrases) if (all.includes(p)) s += p.trim().includes(" ") ? 4 : 3;
    for (const t of it.title) if (tokens.has(t)) s += 1;
    if (s > bestScore) { bestScore = s; best = it.f; }
  }
  return bestScore >= 3 ? best : null;
}

// ---------- UI ----------
const CSS = `
.rv-hb{--rv-main:var(--maroon,#7a1f2b);--rv-bg:#fffdf8;--rv-line:#e6dcc9;font-family:inherit;font-size:14px;color:#2b2320}
.rv-hb *{box-sizing:border-box}
.rv-hb-fab{position:fixed;right:20px;bottom:80px;z-index:9998;width:56px;height:56px;border-radius:50%;border:0;background:var(--rv-main);color:#fff;font-size:26px;cursor:pointer;box-shadow:0 6px 18px rgba(0,0,0,.28)}
.rv-hb-fab:focus-visible,.rv-hb button:focus-visible,.rv-hb input:focus-visible{outline:2px solid #2563eb;outline-offset:2px}
.rv-hb-panel{position:fixed;right:20px;bottom:150px;z-index:9999;width:340px;max-width:calc(100vw - 24px);height:480px;max-height:calc(100vh - 110px);display:none;flex-direction:column;background:var(--rv-bg);border:1px solid var(--rv-line);border-radius:14px;box-shadow:0 12px 36px rgba(0,0,0,.28);overflow:hidden}
.rv-hb-panel.open{display:flex}
.rv-hb-head{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;background:var(--rv-main);color:#fff}
.rv-hb-head b{font-size:15px}.rv-hb-head small{display:block;opacity:.85;font-size:11px}
.rv-hb-x{background:none;border:0;color:#fff;font-size:20px;cursor:pointer;line-height:1}
.rv-hb-msgs{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px}
.rv-hb-m{max-width:88%;padding:9px 11px;border-radius:12px;line-height:1.4;word-wrap:break-word}
.rv-hb-m div+div{margin-top:4px}
.rv-hb-m.bot{align-self:flex-start;background:#f3ece0;border-bottom-left-radius:4px}
.rv-hb-m.me{align-self:flex-end;background:var(--rv-main);color:#fff;border-bottom-right-radius:4px}
.rv-hb-chips{display:flex;flex-wrap:wrap;gap:6px;padding:0 12px 8px}
.rv-hb-chip{border:1px solid var(--rv-main);color:var(--rv-main);background:#fff;border-radius:999px;padding:5px 10px;font-size:12px;cursor:pointer}
.rv-hb-chip:hover{background:var(--rv-main);color:#fff}
.rv-hb-form{display:flex;gap:6px;padding:10px;border-top:1px solid var(--rv-line);background:#fff}
.rv-hb-form input{flex:1;min-width:0;border:1px solid var(--rv-line);border-radius:8px;padding:8px 10px;font:inherit}
.rv-hb-form button{border:0;background:var(--rv-main);color:#fff;border-radius:8px;padding:0 14px;cursor:pointer;font:inherit}
.rv-hb-typing{opacity:.6;font-style:italic}
@media (max-width:480px){.rv-hb-panel{right:12px;bottom:150px;height:70vh}}
@media (prefers-reduced-motion:no-preference){.rv-hb-panel.open{animation:rvhb .18s ease-out}@keyframes rvhb{from{opacity:0;transform:translateY(8px)}}}
`;

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text; // always textContent: no HTML injection
  return n;
};

export function mountHelpBot({ role = "default", onUnanswered } = {}) {
  if (typeof document === "undefined" || document.getElementById("rv-hb")) return () => {};
  const roleKey = String(role).toLowerCase().replace(/[^a-z]/g, "");

  const style = el("style", null, CSS);
  const root = el("div", "rv-hb");
  root.id = "rv-hb";

  const fab = el("button", "rv-hb-fab", "\u{1F4AC}");
  fab.type = "button";
  fab.setAttribute("aria-label", "Open help chat");
  fab.setAttribute("aria-expanded", "false");

  const panel = el("div", "rv-hb-panel");
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "RecoVibe help chat");

  const head = el("div", "rv-hb-head");
  const title = el("div");
  title.append(el("b", null, "RecoVibe Help"), el("small", null, "Quick answers about the system"));
  const close = el("button", "rv-hb-x", "\u00d7");
  close.type = "button";
  close.setAttribute("aria-label", "Close help chat");
  head.append(title, close);

  const msgs = el("div", "rv-hb-msgs");
  msgs.setAttribute("aria-live", "polite");
  const chips = el("div", "rv-hb-chips");
  const form = el("form", "rv-hb-form");
  const input = el("input");
  input.type = "text"; input.maxLength = 200; input.placeholder = "Type your question...";
  input.setAttribute("aria-label", "Your question");
  const send = el("button", null, "Send");
  send.type = "submit";
  form.append(input, send);

  panel.append(head, msgs, chips, form);
  root.append(fab, panel);
  document.head.appendChild(style);
  document.body.appendChild(root);

  function addMsg(text, who) {
    const m = el("div", "rv-hb-m " + who);
    String(text).split("\n").forEach((line) => m.appendChild(el("div", null, line)));
    msgs.appendChild(m);
    msgs.scrollTop = msgs.scrollHeight;
    return m;
  }

  function showChips(ids) {
    chips.replaceChildren();
    ids.map((id) => FAQ.find((f) => f.id === id)).filter(Boolean).forEach((f) => {
      const c = el("button", "rv-hb-chip", f.q);
      c.type = "button";
      c.addEventListener("click", () => ask(f.q, f));
      chips.appendChild(c);
    });
  }

  function ask(text, known) {
    const q = text.trim();
    if (!q) return;
    addMsg(q, "me");
    const typing = addMsg("Typing...", "bot");
    typing.classList.add("rv-hb-typing");
    setTimeout(() => {
      typing.remove();
      const hit = known || findAnswer(q);
      if (hit) {
        addMsg(hit.a, "bot");
        showChips(SUGGESTIONS[roleKey] || SUGGESTIONS.default);
      } else {
        addMsg("I'm not sure about that one. Try one of these topics, or rephrase with words like register, attendance, correction, calendar or role.", "bot");
        showChips(SUGGESTIONS[roleKey] || SUGGESTIONS.default);
        if (typeof onUnanswered === "function") onUnanswered(q); // optional hook; nothing is stored by default
      }
    }, 250);
  }

  let greeted = false;
  function open(v) {
    panel.classList.toggle("open", v);
    fab.setAttribute("aria-expanded", String(v));
    if (v) {
      if (!greeted) {
        greeted = true;
        addMsg("Hi! I can help with events, attendance, profile corrections, the calendar and roles. What do you need?", "bot");
        showChips(SUGGESTIONS[roleKey] || SUGGESTIONS.default);
      }
      input.focus();
    } else fab.focus();
  }

  const onFab = () => open(!panel.classList.contains("open"));
  const onClose = () => open(false);
  const onSubmit = (e) => { e.preventDefault(); const v = input.value; input.value = ""; ask(v); };
  const onKey = (e) => { if (e.key === "Escape" && panel.classList.contains("open")) open(false); };

  fab.addEventListener("click", onFab);
  close.addEventListener("click", onClose);
  form.addEventListener("submit", onSubmit);
  document.addEventListener("keydown", onKey);

  return function unmount() {
    document.removeEventListener("keydown", onKey);
    root.remove();
    style.remove();
  };
}
