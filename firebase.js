import { getApp, getApps, initializeApp } from "firebase/app";
import {
  browserLocalPersistence,
  getAuth,
  setPersistence,
} from "firebase/auth";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyDKozGFtnSiE6EzmSzpxe8-dZv7aH1HfnE",
  authDomain: "recovibe-v1.firebaseapp.com",
  projectId: "recovibe-v1",
  storageBucket: "recovibe-v1.firebasestorage.app",
  messagingSenderId: "79140044760",
  appId: "1:79140044760:web:8523fc92592e3555fefcad",
};

const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
export const auth = getAuth(app);
const authPersistenceResult = setPersistence(auth, browserLocalPersistence).then(
  () => null,
  (error) => {
    console.error("[Firebase] Could not enable browser-local auth persistence:", error);
    return error;
  },
);

export async function ensureAuthPersistence() {
  const error = await authPersistenceResult;
  if (error) throw error;
}

export const db = getFirestore(app);