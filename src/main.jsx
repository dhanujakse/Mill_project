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

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
