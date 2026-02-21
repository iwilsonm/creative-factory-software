import { useState } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { api } from '../api';

export default function Layout({ children }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const handleLogout = async () => {
    await api.logout();
    navigate('/login');
  };

  const navLinks = [
    { to: '/', label: 'Dashboard' },
    { to: '/projects', label: 'Projects' },
    { to: '/settings', label: 'Settings' }
  ];

  // Check if we're on any project-specific page (e.g. /projects/abc-123)
  const isProjectSubPage = location.pathname.startsWith('/projects/');
  const isProjectsActive = location.pathname === '/projects' || isProjectSubPage;

  return (
    <div className="min-h-screen bg-offwhite">
      <nav className="glass-nav sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between h-14">
            <div className="flex items-center gap-8">
              <Link to="/" className="flex items-center">
                <img src="/logo.png" alt="Dacia Automation" className="h-11" />
              </Link>
              <div className="segmented-control hidden md:inline-flex">
                {navLinks.map(link => {
                  const isActive = link.to === '/projects'
                    ? isProjectsActive
                    : location.pathname === link.to;
                  return (
                    <Link
                      key={link.to}
                      to={link.to}
                      className={isActive ? 'active' : ''}
                    >
                      {link.label}
                    </Link>
                  );
                })}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={handleLogout}
                className="text-[13px] text-textlight hover:text-textdark transition-colors duration-200 hidden md:block"
              >
                Sign Out
              </button>
              {/* Mobile hamburger */}
              <button
                onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
                className="md:hidden w-8 h-8 flex items-center justify-center rounded-lg hover:bg-black/5 transition-colors"
              >
                {mobileMenuOpen ? (
                  <svg className="w-5 h-5 text-textmid" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                ) : (
                  <svg className="w-5 h-5 text-textmid" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
                  </svg>
                )}
              </button>
            </div>
          </div>
        </div>

        {/* Mobile dropdown menu */}
        {mobileMenuOpen && (
          <div className="md:hidden border-t border-black/5 bg-white fade-in">
            <div className="px-4 py-3 space-y-1">
              {navLinks.map(link => {
                const isActive = link.to === '/projects'
                  ? isProjectsActive
                  : location.pathname === link.to;
                return (
                  <Link
                    key={link.to}
                    to={link.to}
                    onClick={() => setMobileMenuOpen(false)}
                    className={`block px-3 py-2 rounded-xl text-[14px] font-medium transition-colors ${
                      isActive
                        ? 'bg-navy/10 text-navy'
                        : 'text-textmid hover:bg-black/3'
                    }`}
                  >
                    {link.label}
                  </Link>
                );
              })}
              <button
                onClick={() => { setMobileMenuOpen(false); handleLogout(); }}
                className="block w-full text-left px-3 py-2 rounded-xl text-[14px] font-medium text-red-500 hover:bg-red-50/50 transition-colors"
              >
                Sign Out
              </button>
            </div>
          </div>
        )}
      </nav>
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {children}
      </main>
    </div>
  );
}
