import { Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import { useState, useEffect, createContext, useContext, lazy, Suspense } from 'react';
import { api } from './api';
import { ToastProvider } from './components/Toast';
import ErrorBoundary from './components/ErrorBoundary';
import Login from './pages/Login';

// ─── Lazy Import with Retry ─────────────────────────────────────────────────
// After a deploy, old chunk hashes no longer exist on the server.
// If a user's browser still has the old index.html cached (or an open tab),
// dynamic imports will 404. This wrapper retries once, then forces a full
// page reload so the browser fetches the new index.html with correct hashes.
function lazyWithRetry(importFn) {
  return lazy(() =>
    importFn().catch((err) => {
      // Only handle chunk load failures, not other import errors
      const isChunkError =
        err.message?.includes('Failed to fetch dynamically imported module') ||
        err.message?.includes('Importing a module script failed') ||
        err.message?.includes('error loading dynamically imported module') ||
        err.name === 'ChunkLoadError';

      if (!isChunkError) throw err;

      // Check if we already tried reloading (prevent infinite reload loops)
      const reloadKey = 'chunk-reload-' + Date.now().toString().slice(0, -4); // ~10s window
      const lastReload = sessionStorage.getItem('chunk-reload-ts');
      const now = Date.now();

      if (lastReload && now - parseInt(lastReload, 10) < 10000) {
        // Already reloaded within the last 10 seconds — don't loop
        throw err;
      }

      // Mark that we're reloading and do a hard refresh
      sessionStorage.setItem('chunk-reload-ts', now.toString());
      window.location.reload();

      // Return a never-resolving promise so React doesn't try to render
      return new Promise(() => {});
    })
  );
}

// Lazy-load all pages — only the visited page's code is downloaded
const Dashboard = lazyWithRetry(() => import('./pages/Dashboard'));
const Projects = lazyWithRetry(() => import('./pages/Projects'));
const ProjectSetup = lazyWithRetry(() => import('./pages/ProjectSetup'));
const ProjectDetail = lazyWithRetry(() => import('./pages/ProjectDetail'));
const Settings = lazyWithRetry(() => import('./pages/Settings'));
const AgentDashboard = lazyWithRetry(() => import('./pages/AgentDashboard'));

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
              <Route path="/agents" element={<ProtectedRoute roles={['admin', 'manager']}><AgentDashboard /></ProtectedRoute>} />
              <Route path="/settings" element={<ProtectedRoute roles={['admin']}><Settings /></ProtectedRoute>} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </Suspense>
        </AuthProvider>
      </ToastProvider>
    </ErrorBoundary>
  );
}
