import { getApp, getApps, initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  browserLocalPersistence,
  getAuth,
  setPersistence,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getDatabase } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import { getFunctions } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js";

const firebaseConfig = {
  apiKey: "AIzaSyDKozGFtnSiE6EzmSzpxe8-dZv7aH1HfnE",
  authDomain: "recovibe-v1.firebaseapp.com",
  projectId: "recovibe-v1",
  databaseURL: "https://recovibe-v1-default-rtdb.firebaseio.com/",
  storageBucket: "recovibe-v1.firebasestorage.app",
  messagingSenderId: "79140044760",
  appId: "1:79140044760:web:8523fc92592e3555fefcad",
};

export const isFirebaseConfigured = Object.values(firebaseConfig).every(
  (value) => value && !value.startsWith("YOUR_")
);

export const app = isFirebaseConfigured
  ? getApps().length
    ? getApp()
    : initializeApp(firebaseConfig)
  : null;

export const auth = app ? getAuth(app) : null;
const authPersistenceReady = auth
  ? setPersistence(auth, browserLocalPersistence).catch((error) => {
    console.error("[Firebase] Could not enable browser-local auth persistence:", {
      code: error?.code || "unknown",
      message: error?.message || String(error),
    });
  })
  : Promise.resolve();
export const authReady = auth
  ? Promise.all([auth.authStateReady(), authPersistenceReady]).then(() => undefined)
  : Promise.resolve();
export const db = app ? getFirestore(app) : null;

let rtdbInstance = null;
if (app) {
  try {
    rtdbInstance = firebaseConfig.databaseURL
      ? getDatabase(app, firebaseConfig.databaseURL)
      : getDatabase(app);
  } catch (error) {
    console.error("[Firebase] Realtime Database initialization failed:", {
      code: error?.code || "unknown",
      message: error?.message || String(error),
    });
  }
}
export const rtdb = rtdbInstance;
export const isRtdbConfigured = Boolean(rtdbInstance);

let functionsInstance = null;
if (app) {
  try {
    functionsInstance = getFunctions(app, "asia-southeast1");
  } catch (err) {
    console.warn("Functions initialization error:", err);
  }
}
export const functions = functionsInstance;