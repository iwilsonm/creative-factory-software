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
export const AuthContext = createContext({ authenticated: false, loading: true, setAuthenticated: () => {} });

function AuthProvider({ children }) {
  const [auth, setAuth] = useState({ authenticated: false, loading: true });

  useEffect(() => {
    api.getSession()
      .then(data => setAuth({ authenticated: !!data.authenticated, loading: false }))
      .catch(() => setAuth({ authenticated: false, loading: false }));
  }, []);

  const setAuthenticated = (value) => setAuth({ authenticated: value, loading: false });

  return <AuthContext.Provider value={{ ...auth, setAuthenticated }}>{children}</AuthContext.Provider>;
}

function ProtectedRoute({ children }) {
  const { authenticated, loading } = useContext(AuthContext);
  const navigate = useNavigate();

  useEffect(() => {
    if (!loading && !authenticated) navigate('/login');
  }, [loading, authenticated, navigate]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-gray-400">Loading...</div>
      </div>
    );
  }

  if (!authenticated) return null;
  return children;
}

// Page loading fallback
function PageLoader() {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="text-gray-300 text-sm">Loading page...</div>
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
              <Route path="/" element={<ProtectedRoute><Dashboard /></ProtectedRoute>} />
              <Route path="/projects" element={<ProtectedRoute><Projects /></ProtectedRoute>} />
              <Route path="/projects/new" element={<ProtectedRoute><ProjectSetup /></ProtectedRoute>} />
              <Route path="/projects/:id" element={<ProtectedRoute><ProjectDetail /></ProtectedRoute>} />
              <Route path="/settings" element={<ProtectedRoute><Settings /></ProtectedRoute>} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </Suspense>
        </AuthProvider>
      </ToastProvider>
    </ErrorBoundary>
  );
}
