// Converts a users DB row (password_hash never included) into the flat shape
// the frontend already expects (matches the old mock user object shape).
export const serializeUser = (row) => {
  const profile = JSON.parse(row.profile || '{}');
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    disabled: !row.enabled,
    mustChangePassword: !!row.must_change_password,
    name: profile.name || '',
    email: profile.email || '',
    phone: profile.phone || '',
    department: profile.department || '',
    avatarType: profile.avatarType || 'initials',
    avatarSeed: profile.avatarSeed || (profile.name || row.username),
    avatar: profile.avatar || '',
    profileColor: profile.profileColor || profile.avatarColor || 'orange',
    avatarColor: profile.profileColor || profile.avatarColor || 'orange',
    whatsappAlerts: profile.whatsappAlerts !== false,
    permissions: profile.permissions || {}
  };
};

// Converts a requests DB row into the shape expected by the frontend.
// Merges dedicated table columns (dispatch_date, po_wamid, status, etc.)
// with the JSON data column so the frontend has a consistent single source of truth.
export const serializeRequest = (row) => {
  if (!row) return null;
  let data = {};
  try {
    data = typeof row.data === 'string' ? JSON.parse(row.data) : (row.data || {});
  } catch {
    data = {};
  }
  const dispatchDate = row.dispatch_date || data.dispatch_date || data.expectedDispatchDate || null;
  return {
    ...data,
    id: row.id,
    status: row.status || data.status || 'Pending',
    po_wamid: row.po_wamid || data.po_wamid || null,
    po_sent_at: row.po_sent_at || data.po_sent_at || null,
    dispatch_date: dispatchDate,
    expectedDispatchDate: dispatchDate,
    booking_status: row.booking_status || data.booking_status || null,
    needs_call: (row.needs_call !== undefined && row.needs_call !== null) ? row.needs_call : (data.needs_call || 0),
    lr_file_path: row.lr_file_path || data.lr_file_path || null,
    reminders_sent: (row.reminders_sent !== undefined && row.reminders_sent !== null) ? row.reminders_sent : (data.reminders_sent || 0),
    created_at: row.created_at || data.created_at,
    updated_at: row.updated_at || data.updated_at
  };
};
