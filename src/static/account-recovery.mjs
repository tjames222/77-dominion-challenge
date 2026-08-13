export const PASSWORD_RECOVERY_PAGE = 'reset-password.html';
export const PASSWORD_MINIMUM_LENGTH = 12;

export function passwordRecoveryRedirectUrl(locationLike) {
  const href = String(locationLike?.href || '');
  const origin = String(locationLike?.origin || '');
  if (!href || !origin) throw new TypeError('A browser location is required.');

  const target = new URL(`./${PASSWORD_RECOVERY_PAGE}`, href);
  if (target.origin !== origin) throw new Error('Password recovery must stay on the same site.');
  target.search = '';
  target.hash = '';
  return target.href;
}

export function validateNewPassword(password, confirmation) {
  const value = String(password || '');
  if (value.length < PASSWORD_MINIMUM_LENGTH) {
    return `Use at least ${PASSWORD_MINIMUM_LENGTH} characters.`;
  }
  if (value !== String(confirmation || '')) return 'The passwords do not match.';
  return '';
}

export function passwordRecoveryErrorFromLocation(locationLike) {
  const query = new URLSearchParams(String(locationLike?.search || ''));
  const fragment = new URLSearchParams(String(locationLike?.hash || '').replace(/^#/, ''));
  return query.get('error_description') || fragment.get('error_description') || '';
}

export function cleanPasswordRecoveryUrl(locationLike) {
  const href = String(locationLike?.href || '');
  const origin = String(locationLike?.origin || '');
  if (!href || !origin) return '';
  const target = new URL(href);
  if (target.origin !== origin) return '';
  target.search = '';
  target.hash = '';
  return target.href;
}
