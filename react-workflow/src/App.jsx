import { useState } from "react";
import { Link, Navigate, Route, Routes, useNavigate } from "react-router-dom";
import { signOut } from "firebase/auth";
import { auth } from "../../firebase.js";
import { useAuth } from "./auth/AuthProvider.jsx";
import AdminDashboard from "./components/AdminDashboard.jsx";
import EventForm from "./components/EventForm.jsx";
import FirstSuperAdminSetup from "./components/FirstSuperAdminSetup.jsx";
import PublicEvents from "./components/PublicEvents.jsx";
import SignIn from "./components/SignIn.jsx";
import SignUp from "./components/SignUp.jsx";
import UserManagementDashboard from "./components/UserManagementDashboard.jsx";

const APPROVAL_ROLES = ["adviser", "hap", "osas"];

function ProtectedRoute({ children, allowedRoles }) {
  const { user, profile, profileError, loading } = useAuth();
  if (loading) return <p className="page-status">Loading your account…</p>;
  if (!user) return <Navigate to="/signin" replace />;
  if (profileError) return <p className="notice error">{profileError}</p>;
  if (!profile) return <p className="notice error">Your account profile is unavailable.</p>;
  if (allowedRoles && !allowedRoles.includes(profile.role)) {
    return <p className="notice error">You do not have permission to view this page.</p>;
  }
  return children;
}

export default function App() {
  const { user, profile } = useAuth();
  const navigate = useNavigate();
  const [navigationError, setNavigationError] = useState("");

  async function handleSignOut() {
    setNavigationError("");
    try {
      await signOut(auth);
      navigate("/");
    } catch (error) {
      console.error("Could not sign out:", error);
      setNavigationError(`Could not sign out: ${error.message}`);
    }
  }

  return (
    <div className="app-shell">
      <header className="site-header">
        <Link className="brand" to="/">RecoVibe</Link>
        <nav aria-label="Main navigation">
          <Link to="/">Events</Link>
          {user && <Link to="/submit">Submit event</Link>}
          {["admin", "superadmin", ...APPROVAL_ROLES].includes(profile?.role) && <Link to="/admin">Event approvals</Link>}
          {profile?.role === "superadmin" && <Link to="/user-management">User management</Link>}
          {!user ? (
            <>
              <Link to="/signin">Sign in</Link>
              <Link className="nav-cta" to="/signup">Create account</Link>
              <Link to="/setup-superadmin">First-time setup</Link>
            </>
          ) : (
            <button className="link-button" type="button" onClick={handleSignOut}>
              Sign out
            </button>
          )}
        </nav>
      </header>

      <main className="main-content">
        {navigationError && <p className="notice error" role="alert">{navigationError}</p>}
        <Routes>
          <Route path="/" element={<PublicEvents />} />
          <Route path="/signin" element={<SignIn />} />
          <Route path="/signup" element={<SignUp />} />
          <Route path="/setup-superadmin" element={<FirstSuperAdminSetup />} />
          <Route
            path="/submit"
            element={
              <ProtectedRoute allowedRoles={["user", "organizer"]}>
                <EventForm />
              </ProtectedRoute>
            }
          />
          <Route
            path="/admin"
            element={
              <ProtectedRoute allowedRoles={["admin", "superadmin", ...APPROVAL_ROLES]}>
                <AdminDashboard />
              </ProtectedRoute>
            }
          />
          <Route
            path="/user-management"
            element={
              <ProtectedRoute allowedRoles={["superadmin"]}>
                <UserManagementDashboard />
              </ProtectedRoute>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
      <footer className="site-footer">RecoVibe · Campus events, together.</footer>
    </div>
  );
}
