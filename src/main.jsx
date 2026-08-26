// Local session reset helper (?reset_db=true): clears this browser's cached
// session/token and any local UI overrides. Actual application data now
// lives in the backend's SQLite database, not localStorage, so this only
// ever affects this one browser's login state, never real data.
const urlParams = new URLSearchParams(window.location.search);
if (urlParams.get('reset_db') === 'true') {
  localStorage.removeItem("pms_auth_token");
  localStorage.removeItem("pms_current_user");
  localStorage.removeItem("pms_branding");
  localStorage.removeItem("pms_webhook_url");
  localStorage.removeItem("pms_notifications");
  window.location.href = window.location.origin + window.location.hash;
}

import { StrictMode, Component } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

// Without this, any render-time exception anywhere in the tree (e.g. a
// missing field on data returned by the API) unmounts the whole app and
// leaves the user staring at a blank page with no indication anything
// went wrong.
class ErrorBoundary extends Component {
  state = { error: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('Unhandled render error:', error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: '32px 20px', textAlign: 'center', fontFamily: 'sans-serif' }}>
          <h2 style={{ marginBottom: '8px' }}>Something went wrong</h2>
          <p style={{ color: '#666', marginBottom: '20px' }}>
            {this.state.error.message || 'The page hit an unexpected error.'}
          </p>
          <button
            onClick={() => { this.setState({ error: null }); window.location.hash = '#home'; }}
            style={{ padding: '10px 20px', cursor: 'pointer' }}
          >
            Back to Home
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
