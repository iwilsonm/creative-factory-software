import { Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import { useState, useEffect, createContext, useContext, lazy, Suspense } from 'react';
import { api } from './api';
import { ToastProvider } from './components/Toast';
import ErrorBoundary from './components/ErrorBoundary';
import Login from './pages/Login';

// Lazy-load all pages — only the visited page's code is downloaded
const Dashboard = lazy(() => import('./pages/Dashboard'));
const Projects = lazy(() => import('./pages/Projects'));
const ProjectSetup = lazy(() => import('./pages/ProjectSetup'));
const ProjectDetail = lazy(() => import('./pages/ProjectDetail'));
const Settings = lazy(() => import('./pages/Settings'));

// ─── Auth Context ─────────────────────────────────────────────────────────────
// Checks session once on app mount, then shares state across all routes.
// Exposes setAuthenticated so Login can update state after successful login.
// Now includes user object with role, displayName for role-based access.
export const AuthContext = createContext({
  authenticated: false,
  loading: true,
  user: null,           // { username, role, displayName }
  setAuthenticated: () => {},
  setUser: () => {},
});

function AuthProvider({ children }) {
  const [auth, setAuth] = useState({ authenticated: false, loading: true, user: null });

  useEffect(() => {
    api.getSession()
      .then(data => setAuth({
        authenticated: !!data.authenticated,
        loading: false,
        user: data.user || null,
      }))
      .catch(() => setAuth({ authenticated: false, loading: false, user: null }));
  }, []);

  const setAuthenticated = (value) => setAuth(prev => ({ ...prev, authenticated: value, loading: false }));
  const setUser = (user) => setAuth(prev => ({ ...prev, user, authenticated: !!user, loading: false }));

  return (
    <AuthContext.Provider value={{ ...auth, setAuthenticated, setUser }}>
      {children}
    </AuthContext.Provider>
  );
}

function ProtectedRoute({ children, roles }) {
  const { authenticated, loading, user } = useContext(AuthContext);
  const navigate = useNavigate();

  useEffect(() => {
    if (!loading && !authenticated) navigate('/login');
  }, [loading, authenticated, navigate]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-textlight">Loading...</div>
      </div>
    );
  }

  if (!authenticated) return null;

  // Role-based access check
  if (roles && user && !roles.includes(user.role)) {
    // Redirect poster to projects (they'll see limited view)
    return <Navigate to="/projects" replace />;
  }

  return children;
}

// Page loading fallback
function PageLoader() {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="text-textlight text-sm">Loading page...</div>
    </div>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <ToastProvider>
        <AuthProvider>
          <Suspense fallback={<PageLoader />}>
            <Routes>
              <Route path="/login" element={<Login />} />
              <Route path="/" element={<ProtectedRoute roles={['admin', 'manager']}><Dashboard /></ProtectedRoute>} />
              <Route path="/projects" element={<ProtectedRoute><Projects /></ProtectedRoute>} />
              <Route path="/projects/new" element={<ProtectedRoute roles={['admin', 'manager']}><ProjectSetup /></ProtectedRoute>} />
              <Route path="/projects/:id" element={<ProtectedRoute><ProjectDetail /></ProtectedRoute>} />
              <Route path="/settings" element={<ProtectedRoute roles={['admin']}><Settings /></ProtectedRoute>} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </Suspense>
        </AuthProvider>
      </ToastProvider>
    </ErrorBoundary>
  );
}
