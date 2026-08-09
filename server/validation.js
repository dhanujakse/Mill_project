export const NAME_REGEX = /^[a-zA-Z\s.\-']+$/;
export const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const PHONE_REGEX = /^(?:\+91)?\d{10}$/;

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
