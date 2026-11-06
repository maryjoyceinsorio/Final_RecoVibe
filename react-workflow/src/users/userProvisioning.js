import { deleteApp, getApp, getApps, initializeApp } from "firebase/app";
import {
  createUserWithEmailAndPassword,
  deleteUser,
  getAuth,
  signInWithEmailAndPassword,
  signOut,
  sendEmailVerification,
} from "firebase/auth";
import {
  doc,
  getFirestore,
  runTransaction,
  serverTimestamp,
  setDoc,
} from "firebase/firestore";
import { auth, db, ensureAuthPersistence } from "../../../firebase.js";

const BOOTSTRAP_APP_NAME = "recovibe-superadmin-bootstrap";

function getSecondaryApp(appName) {
  const existingApp = getApps().find((candidate) => candidate.name === appName);
  return existingApp || initializeApp(getApp().options, appName);
}

async function removeCreatedAccount(user, context) {
  if (!user) return;
  try {
    await deleteUser(user);
    return true;
  } catch (cleanupError) {
    console.error(`[${context}] Could not remove Auth account after profile failure:`, {
      code: cleanupError?.code || "unknown",
      message: cleanupError?.message || String(cleanupError),
      uid: user.uid,
    });
    return false;
  }
}

export async function beginFirstSuperAdminSetup({ displayName, email, password }) {
  await ensureAuthPersistence();
  if (auth.currentUser) {
    throw new Error("Sign out before starting first superadmin setup.");
  }
  const secondaryApp = getSecondaryApp(BOOTSTRAP_APP_NAME);
  const secondaryAuth = getAuth(secondaryApp);
  let user = secondaryAuth.currentUser;
  let createdDuringThisAttempt = false;

  try {
    if (!user) {
      try {
        const credential = await createUserWithEmailAndPassword(
          secondaryAuth,
          email.trim().toLowerCase(),
          password,
        );
        user = credential.user;
        createdDuringThisAttempt = true;
      } catch (error) {
        if (error.code !== "auth/email-already-in-use") throw error;
        user = (
          await signInWithEmailAndPassword(
            secondaryAuth,
            email.trim().toLowerCase(),
            password,
          )
        ).user;
      }
    } else if (user.email?.toLowerCase() !== email.trim().toLowerCase()) {
      throw new Error("A different setup account is already signed in. Sign it out and retry.");
    }

    await sendEmailVerification(user);
    return {
      user,
      displayName: displayName.trim(),
      secondaryApp,
      secondaryAuth,
      createdDuringThisAttempt,
    };
  } catch (error) {
    if (createdDuringThisAttempt) {
      error.setupAccountRemoved = await removeCreatedAccount(
        user,
        "FirstSuperAdminSetup",
      );
    }
    try {
      await signOut(secondaryAuth);
    } catch (signOutError) {
      console.error("[FirstSuperAdminSetup] Could not sign out setup account:", {
        code: signOutError?.code || "unknown",
        message: signOutError?.message || String(signOutError),
      });
    }
    throw error;
  }
}

export async function finishFirstSuperAdminSetup({
  user,
  displayName,
  secondaryApp,
  secondaryAuth,
  createdDuringThisAttempt,
}) {
  let profileWriteAttempted = false;
  try {
    await user.reload();
    if (!user.emailVerified) {
      throw new Error("Verify your email before completing superadmin setup.");
    }
    await user.getIdToken(true);

    const bootstrapDb = getFirestore(secondaryApp);
    const profileRef = doc(bootstrapDb, "users", user.uid);
    const bootstrapLockRef = doc(bootstrapDb, "system", "bootstrap");
    profileWriteAttempted = true;
    await runTransaction(bootstrapDb, async (transaction) => {
      const bootstrapSnapshot = await transaction.get(bootstrapLockRef);
      if (bootstrapSnapshot.exists()) {
        throw new Error("First superadmin setup has already been completed.");
      }

      transaction.set(profileRef, {
        displayName,
        email: user.email,
        role: "superadmin",
        uid: user.uid,
        createdAt: serverTimestamp(),
      });
      transaction.set(bootstrapLockRef, {
        uid: user.uid,
        email: user.email,
        createdAt: serverTimestamp(),
      });
    });
  } catch (error) {
    if (profileWriteAttempted && createdDuringThisAttempt) {
      error.setupAccountRemoved = await removeCreatedAccount(user, "FirstSuperAdminSetup");
    }
    throw error;
  } finally {
    try {
      await signOut(secondaryAuth);
    } catch (signOutError) {
      console.error("[FirstSuperAdminSetup] Could not sign out setup account:", {
        code: signOutError?.code || "unknown",
        message: signOutError?.message || String(signOutError),
      });
    }
    if (getApps().some((candidate) => candidate.name === secondaryApp.name)) {
      try {
        await deleteApp(secondaryApp);
      } catch (cleanupError) {
        console.error("[FirstSuperAdminSetup] Could not dispose setup app:", {
          code: cleanupError?.code || "unknown",
          message: cleanupError?.message || String(cleanupError),
        });
      }
    }
  }
}

export async function createManagedUser({ displayName, email, password, role }) {
  await ensureAuthPersistence();
  if (!auth.currentUser) {
    throw new Error("Sign in as a superadmin before creating accounts.");
  }

  const appName = `recovibe-user-provision-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const secondaryApp = getSecondaryApp(appName);
  const secondaryAuth = getAuth(secondaryApp);
  let user;

  try {
    const credential = await createUserWithEmailAndPassword(
      secondaryAuth,
      email.trim().toLowerCase(),
      password,
    );
    user = credential.user;
    await setDoc(doc(db, "users", user.uid), {
      displayName: displayName.trim(),
      email: user.email,
      role,
      uid: user.uid,
      status: "Active",
      createdBy: auth.currentUser.uid,
      createdAt: serverTimestamp(),
    });
    return user.uid;
  } catch (error) {
    await removeCreatedAccount(user, "UserManagement");
    throw error;
  } finally {
    try {
      await signOut(secondaryAuth);
    } catch (signOutError) {
      console.error("[UserManagement] Could not sign out provisioned account:", {
        code: signOutError?.code || "unknown",
        message: signOutError?.message || String(signOutError),
      });
    }
    try {
      await deleteApp(secondaryApp);
    } catch (cleanupError) {
      console.error("[UserManagement] Could not dispose provisioning app:", {
        code: cleanupError?.code || "unknown",
        message: cleanupError?.message || String(cleanupError),
      });
    }
  }
}
