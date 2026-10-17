export const NAME_REGEX = /^[a-zA-Z\s.\-']+$/;
export const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Indian mobile numbers start with 6, 7, 8 or 9.
export const PHONE_REGEX = /^(?:\+91)?[6-9]\d{9}$/;

// Mirrors the validation the client already performs, enforced again here
// since the server is the actual trust boundary now.
export const validateUserFields = ({ name, email, phone }) => {
  if (!name || !name.trim()) return 'Full name is required.';
  if (!NAME_REGEX.test(name.trim())) return 'Full name contains invalid characters.';
  if (!email || !email.trim()) return 'Email address is required.';
  if (!EMAIL_REGEX.test(email.trim())) return 'Invalid email format.';
  if (!phone || !phone.trim()) return 'Phone number is required.';
  if (!PHONE_REGEX.test(phone.trim())) return 'Invalid Indian mobile number (must be a 10-digit number, optionally starting with +91).';
  return null;
};

// Request bodies are untrusted JSON: a field can arrive as a number, object or
// array. Anything that isn't a string is treated as empty instead of being
// passed to .trim() (which would throw).
export const USER_ROLES = ['Main Admin', 'Sub Admin', 'Employee'];
export const MIN_PASSWORD_LENGTH = 6; // matches the app's isPasswordStrong()

export const validatePassword = (password) => (
  password.length < MIN_PASSWORD_LENGTH ? `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` : null
);

export const asText = (value) => (typeof value === 'string' ? value.trim() : '');
