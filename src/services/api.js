// Service layer for the Procurement & Order Tracking System.
// Talks to the real Express + SQLite backend in /server over HTTP - no more
// localStorage mock database and no client-side password hashing. Every
// exported function keeps the same name/shape the UI already calls, so
// components didn't need to change.

// Date difference utility in days
export const getDaysDifference = (dateStr1, dateStr2) => {
  try {
    const d1 = new Date(dateStr1);
    const d2 = new Date(dateStr2);
    d1.setHours(0, 0, 0, 0);
    d2.setHours(0, 0, 0, 0);
    const diffTime = d1 - d2;
    const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
    return diffDays;
  } catch (e) {
    return 0;
  }
};

// Delay start date utility (the day after due date)
export const getDelayStartDate = (dueDateStr) => {
  try {
    const d = new Date(dueDateStr);
    d.setDate(d.getDate() + 1);
    return d.toISOString().split('T')[0];
  } catch (e) {
    return dueDateStr;
  }
};

// ----------------------------------------------------
// HTTP client
// ----------------------------------------------------
const TOKEN_KEY = 'pms_auth_token';

// Attachments are either an inline data URL ("data:...") or, when the server has
// S3 storage enabled, a reference such as "s3:uploads/2026/09/<id>.pdf".
export const isStoredFile = (value) => typeof value === 'string' && value.startsWith('s3:');
let fileStorageMode = null; // 's3' | 'inline', asked from the server once per page load

// Runtime-overridable (via Settings / localStorage) so a packaged mobile
// build can point at a different backend without a rebuild; falls back to a
// build-time env var, then to same-origin /api for a standard web deploy.
const getApiBaseUrl = () => {
  const override = localStorage.getItem('pms_api_base_url');
  if (override) return override.replace(/\/$/, '');
  return (import.meta.env.VITE_API_BASE_URL || '/api').replace(/\/$/, '');
};

// Caches the signed-in user for the next app start. The server copy is the
// source of truth (refreshed from /auth/me on load), so this must never throw:
// a large profile photo used to exceed the WebView's storage quota, which
// made a successful profile save look failed and logged the user out on the
// next reload. If the full object doesn't fit, cache it without the photo.
export const cacheCurrentUser = (user) => {
  try {
    localStorage.setItem('pms_current_user', JSON.stringify(user));
  } catch {
    try {
      localStorage.setItem('pms_current_user', JSON.stringify({ ...user, avatar: '' }));
    } catch (err) {
      console.error('Could not cache the current user:', err);
    }
  }
};

export const getAuthToken = () => localStorage.getItem(TOKEN_KEY);
const setAuthToken = (token) => localStorage.setItem(TOKEN_KEY, token);
export const clearAuthToken = () => localStorage.removeItem(TOKEN_KEY);

// Registered by App.jsx so a 401 (expired/invalid session, or an account that
// was disabled while logged in) can drop the user back to the login screen
// instead of the UI silently failing every subsequent request.
let unauthorizedHandler = null;
export const onUnauthorized = (handler) => { unauthorizedHandler = handler; };

const apiFetch = async (path, { method = 'GET', body, skipAuth = false } = {}) => {
  const headers = { 'Content-Type': 'application/json' };
  const token = getAuthToken();
  if (token && !skipAuth) headers.Authorization = `Bearer ${token}`;

  let res;
  try {
    res = await fetch(`${getApiBaseUrl()}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
  } catch (networkErr) {
    throw new Error('Could not reach the server. Check your connection and try again.');
  }

  if (res.status === 401 && !skipAuth) {
    clearAuthToken();
    if (unauthorizedHandler) unauthorizedHandler();
  }

  if (res.status === 204) return null;

  let payload = null;
  try {
    payload = await res.json();
  } catch (e) {
    // No JSON body (e.g. a proxy error page) - fall through to status check below.
  }

  if (!res.ok) {
    throw new Error(payload?.error || `Request failed (${res.status})`);
  }

  return payload;
};

export const apiService = {
  // ------------------------------------------------
  // MATERIAL REQUESTS / ORDERS API
  // ------------------------------------------------
  async getRequests() {
    return apiFetch('/requests');
  },

  async createRequest(requestData) {
    return apiFetch('/requests', { method: 'POST', body: requestData });
  },

  async updateRequest(requestId, updatedData) {
    return apiFetch(`/requests/${encodeURIComponent(requestId)}`, { method: 'PUT', body: updatedData });
  },

  // ------------------------------------------------
  // WHATSAPP - SUPPLIER AVAILABILITY REQUESTS
  // ------------------------------------------------
  async askSupplierAvailability(requestId) {
    return apiFetch(`/whatsapp/ask/${encodeURIComponent(requestId)}`, { method: 'POST' });
  },

  // ------------------------------------------------
  // FILE STORAGE (attachments, LR copies, proof of receipt)
  // ------------------------------------------------
  // Uploads a data URL to the server's S3 storage and returns the short reference to
  // keep in the record. Returns the value unchanged when it is already a reference or
  // when the server keeps files inline (S3 not configured, or an older server).
  async storeFile(value, name) {
    if (typeof value !== 'string' || !value.startsWith('data:')) return value;

    if (fileStorageMode === null) {
      try {
        fileStorageMode = (await apiFetch('/files/config')).storage;
      } catch (err) {
        if (!/\(404\)/.test(err.message)) throw err;
        fileStorageMode = 'inline'; // older backend without the files API
      }
    }
    if (fileStorageMode !== 's3') return value;

    const { ref } = await apiFetch('/files', { method: 'POST', body: { dataUrl: value, name } });
    return ref;
  },

  // Turns a stored reference into a short-lived link the browser can open.
  async resolveFileUrl(value) {
    if (!isStoredFile(value)) return value;
    const { url } = await apiFetch(`/files/url?ref=${encodeURIComponent(value)}`);
    return url;
  },

  // ------------------------------------------------
  // SUPPLIER MANAGEMENT API
  // ------------------------------------------------
  async getSuppliers() {
    return apiFetch('/suppliers');
  },

  async addSupplier(supplierData) {
    return apiFetch('/suppliers', { method: 'POST', body: supplierData });
  },

  async updateSupplier(supplierId, updatedSupplier) {
    return apiFetch(`/suppliers/${encodeURIComponent(supplierId)}`, { method: 'PUT', body: updatedSupplier });
  },

  // ------------------------------------------------
  // AUDIT TRAIL LOGS API
  // ------------------------------------------------
  async getLogs() {
    return apiFetch('/logs');
  },

  async addLog(logData) {
    try {
      return await apiFetch('/logs', { method: 'POST', body: logData });
    } catch (err) {
      // Audit logging should never block the user-facing action that triggered
      // it (matches the previous mock behaviour, which also swallowed webhook/
      // log failures rather than surfacing them as UI errors).
      console.error('Failed to record audit log:', err);
      return logData;
    }
  },

  // ------------------------------------------------
  // USER MANAGEMENT & AUTHENTICATION API
  // ------------------------------------------------
  async getUsers() {
    return apiFetch('/users');
  },

  async createUser(userData, customPassword) {
    const result = await apiFetch('/users', {
      method: 'POST',
      body: { ...userData, password: customPassword || undefined }
    });
    return result.tempPassword;
  },

  async saveUser(userData) {
    return apiFetch(`/users/${encodeURIComponent(userData.id)}`, { method: 'PUT', body: userData });
  },

  async deleteUser(userId) {
    await apiFetch(`/users/${encodeURIComponent(userId)}`, { method: 'DELETE' });
    return true;
  },

  async authenticate(username, password) {
    const { token, user } = await apiFetch('/auth/login', {
      method: 'POST',
      body: { username, password },
      skipAuth: true
    });
    setAuthToken(token);
    return user;
  },

  async changePassword(userId, currentPassword, newPassword) {
    return apiFetch('/auth/change-password', { method: 'POST', body: { currentPassword, newPassword } });
  },

  async forceChangePassword(userId, newPassword) {
    return apiFetch('/auth/force-change-password', { method: 'POST', body: { newPassword } });
  },

  async resetUserPassword(userId, newTempPassword) {
    const result = await apiFetch(`/users/${encodeURIComponent(userId)}/reset-password`, {
      method: 'POST',
      body: { newPassword: newTempPassword }
    });
    return result.tempPassword;
  },

  async getCurrentUser() {
    return apiFetch('/auth/me');
  },

  async getDepartments() {
    return apiFetch('/departments');
  },

  async addDepartment(name) {
    return apiFetch('/departments', { method: 'POST', body: { name } });
  },

  async renameDepartment(oldName, newName) {
    return apiFetch(`/departments/${encodeURIComponent(oldName)}`, { method: 'PUT', body: { newName } });
  },

  async toggleDepartmentDisabled(name) {
    return apiFetch(`/departments/${encodeURIComponent(name)}/toggle`, { method: 'PATCH' });
  },

  // ------------------------------------------------
  // NOTIFICATIONS API (shared "team inbox" - see server/routes/notifications.js)
  // ------------------------------------------------
  async getNotifications() {
    return apiFetch('/notifications');
  },

  async createNotification(notification) {
    return apiFetch('/notifications', { method: 'POST', body: notification });
  },

  async markAllNotificationsRead() {
    return apiFetch('/notifications/mark-read', { method: 'PATCH' });
  },

  async clearAllNotifications() {
    return apiFetch('/notifications', { method: 'DELETE' });
  },

  // ------------------------------------------------
  // BRANDING & WEBHOOK SETTINGS API
  // ------------------------------------------------
  async getBranding() {
    return apiFetch('/settings/branding');
  },

  async saveBranding(branding) {
    return apiFetch('/settings/branding', { method: 'PUT', body: branding });
  },

  async getWebhookUrl() {
    const { webhookUrl } = await apiFetch('/settings/webhook-url');
    return webhookUrl;
  },

  async saveWebhookUrl(webhookUrl) {
    const result = await apiFetch('/settings/webhook-url', { method: 'PUT', body: { webhookUrl } });
    return result.webhookUrl;
  }
};
