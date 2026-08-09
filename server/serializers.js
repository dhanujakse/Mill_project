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
    permissions: profile.permissions || {}
  };
};
