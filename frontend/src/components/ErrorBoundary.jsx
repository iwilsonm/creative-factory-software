import { Component } from 'react';

/**
 * React error boundary — catches render errors in child components
 * and shows a recovery UI instead of a white screen.
 *
 * Usage:
 *   <ErrorBoundary>          — full-page fallback (for top-level)
 *   <ErrorBoundary level="tab">  — inline fallback (for tabs/sections)
 */
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, info) {
    console.error('[ErrorBoundary] Caught:', error, info?.componentStack);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (!this.state.hasError) return this.props.children;

    const { level = 'page' } = this.props;
    const message = this.state.error?.message || 'An unexpected error occurred';

    if (level === 'tab') {
      return (
        <div className="flex flex-col items-center justify-center py-20 px-6">
          <div className="w-12 h-12 rounded-xl bg-red-50 flex items-center justify-center mb-4">
            <svg className="w-6 h-6 text-red-400" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
            </svg>
          </div>
          <p className="text-[15px] font-medium text-textdark mb-1">Something went wrong</p>
          <p className="text-[13px] text-textmid mb-4 max-w-md text-center">{message}</p>
          <button onClick={this.handleReset} className="btn-secondary text-[13px]">
            Try Again
          </button>
        </div>
      );
    }

    // Full-page fallback
    return (
      <div className="min-h-screen flex items-center justify-center bg-offwhite">
        <div className="text-center px-6">
          <div className="w-16 h-16 rounded-2xl bg-red-50 flex items-center justify-center mx-auto mb-5">
            <svg className="w-8 h-8 text-red-400" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
            </svg>
          </div>
          <h1 className="text-xl font-semibold text-textdark mb-2">Something went wrong</h1>
          <p className="text-[14px] text-textmid mb-6 max-w-sm mx-auto">{message}</p>
          <div className="flex gap-3 justify-center">
            <button onClick={this.handleReset} className="btn-secondary text-[13px]">
              Try Again
            </button>
            <button onClick={() => window.location.reload()} className="btn-primary text-[13px]">
              Reload Page
            </button>
          </div>
        </div>
      </div>
    );
  }
}
