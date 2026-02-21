import { useState, useEffect, useContext } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { AuthContext } from '../App';

export default function Login() {
  const navigate = useNavigate();
  const { setAuthenticated } = useContext(AuthContext);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [isSetup, setIsSetup] = useState(false);
  const [checkingSession, setCheckingSession] = useState(true);

  useEffect(() => {
    api.getSession().then(data => {
      if (data.authenticated) {
        navigate('/');
      } else {
        setIsSetup(!data.setupComplete);
      }
      setCheckingSession(false);
    }).catch(() => setCheckingSession(false));
  }, [navigate]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      if (isSetup) {
        await api.setup(username, password);
      } else {
        await api.login(username, password);
      }
      setAuthenticated(true);
      navigate('/');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  if (checkingSession) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-offwhite">
        <div className="text-textlight text-sm">Loading...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-offwhite">
      <div className="w-full max-w-sm fade-in">
        <div className="card p-8">
          {/* App icon */}
          <div className="text-center mb-6">
            <img src="/logo.png" alt="Dacia Automation" className="h-14 mx-auto mb-4" />
            <p className="text-[13px] text-textmid mt-1">
              {isSetup ? 'Create your account to get started' : 'Sign in to continue'}
            </p>
          </div>

          {error && (
            <div className="bg-red-50/80 border border-red-200/60 text-red-600 text-[13px] rounded-xl p-3 mb-4">
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-[13px] font-medium text-textmid mb-1.5">Username</label>
              <input
                type="text"
                value={username}
                onChange={e => setUsername(e.target.value)}
                className="input-apple"
                required
              />
            </div>
            <div>
              <label className="block text-[13px] font-medium text-textmid mb-1.5">Password</label>
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                className="input-apple"
                required
                minLength={6}
              />
            </div>
            <button
              type="submit"
              disabled={loading}
              className="btn-primary w-full py-2.5"
            >
              {loading ? 'Please wait...' : isSetup ? 'Create Account' : 'Sign In'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
