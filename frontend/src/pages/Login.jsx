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
            <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-gradient-to-b from-navy-mid to-navy flex items-center justify-center shadow-card">
              <svg className="w-8 h-8 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.53 16.122a3 3 0 00-5.78 1.128 2.25 2.25 0 01-2.4 2.245 4.5 4.5 0 008.4-2.245c0-.399-.078-.78-.22-1.128zm0 0a15.998 15.998 0 003.388-1.62m-5.043-.025a15.994 15.994 0 011.622-3.395m3.42 3.42a15.995 15.995 0 004.764-4.648l3.876-5.814a1.151 1.151 0 00-1.597-1.597L14.146 6.32a15.996 15.996 0 00-4.649 4.763m3.42 3.42a6.776 6.776 0 00-3.42-3.42" />
              </svg>
            </div>
            <h1 className="text-xl font-semibold text-textdark tracking-tight">Dacia Static Gen</h1>
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
