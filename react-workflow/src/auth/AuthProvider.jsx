import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { onAuthStateChanged } from "firebase/auth";
import { doc, getDoc } from "firebase/firestore";
import { auth, db, ensureAuthPersistence } from "../../../firebase.js";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [profileError, setProfileError] = useState("");
  const profileLoadId = useRef(0);

  async function loadProfile(authUser) {
    const currentLoadId = ++profileLoadId.current;
    if (!authUser) {
      setProfile(null);
      setProfileError("");
      return;
    }

    try {
      const profileSnapshot = await getDoc(doc(db, "users", authUser.uid));
      if (currentLoadId !== profileLoadId.current) return;
      if (!profileSnapshot.exists()) {
        setProfile(null);
        setProfileError("Your account profile is missing. Contact an administrator.");
        return;
      }

      setProfile(profileSnapshot.data());
      setProfileError("");
    } catch (error) {
      if (currentLoadId !== profileLoadId.current) return;
      console.error("Could not load account profile:", error);
      setProfile(null);
      setProfileError(`Could not load your account profile: ${error.message}`);
    }
  }

  useEffect(() => {
    let cancelled = false;
    let unsubscribe;

    ensureAuthPersistence()
      .then(() => {
        if (cancelled) return;
        unsubscribe = onAuthStateChanged(auth, async (nextUser) => {
          setUser(nextUser);
          await loadProfile(nextUser);
          setLoading(false);
        });
      })
      .catch((error) => {
        if (cancelled) return;
        console.error("[AuthProvider] Could not initialize authentication:", error);
        setProfileError(`Could not initialize authentication: ${error.message}`);
        setLoading(false);
      });

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  const value = useMemo(
    () => ({
      user,
      profile,
      loading,
      profileError,
      refreshProfile: () => loadProfile(auth.currentUser),
    }),
    [user, profile, loading, profileError],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used within AuthProvider.");
  return context;
}
