// Keep the Badges deep-link parser independent of celebration delivery/recovery.
const safeKey = (value) => /^[a-z0-9][a-z0-9_.:-]*$/.test(String(value || '')) ? String(value) : '';

export function rewardKeyFromLocation(location) {
  try { return safeKey(new URL(location.href).searchParams.get('reward')); } catch { return ''; }
}
