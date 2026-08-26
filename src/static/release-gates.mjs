const explicitlyEnabled = (value) => value === 'true';

export const BILLING_CLOSED_MESSAGE =
  'Billing is not open yet. Dominion is currently in invite-only early access.';
export const PUBLIC_SIGNUP_CLOSED_MESSAGE =
  'Account creation is not open yet. Dominion is currently invite-only.';
export const RELEASE_MODES = Object.freeze({
  INVITE_ONLY: 'invite-only',
  SIGNUP_EARLY_ACCESS: 'signup-early-access',
  INVITED_MEMBERSHIP: 'invited-membership',
  PUBLIC_MEMBERSHIP: 'public-membership',
});

export function resolveReleaseGates(environment = {}) {
  const mocksEnabled = explicitlyEnabled(environment.VITE_ENABLE_MOCKS);
  return Object.freeze({
    mocksEnabled,
    billingEnabled: mocksEnabled || explicitlyEnabled(environment.VITE_ENABLE_BILLING),
    publicSignupEnabled: mocksEnabled
      || explicitlyEnabled(environment.VITE_ENABLE_PUBLIC_SIGNUP),
  });
}

const clientEnvironment = typeof import.meta.env === 'object' && import.meta.env
  ? import.meta.env
  : {};

export const RELEASE_GATES = resolveReleaseGates(clientEnvironment);

export function resolveReleaseMode({ billingEnabled = false, publicSignupEnabled = false } = {}) {
  if (billingEnabled && publicSignupEnabled) return RELEASE_MODES.PUBLIC_MEMBERSHIP;
  if (billingEnabled) return RELEASE_MODES.INVITED_MEMBERSHIP;
  if (publicSignupEnabled) return RELEASE_MODES.SIGNUP_EARLY_ACCESS;
  return RELEASE_MODES.INVITE_ONLY;
}

export function runReleaseGatedAction({ enabled, message, action }) {
  if (!enabled) throw new Error(message);
  if (typeof action !== 'function') throw new TypeError('A release-gated action is required.');
  return action();
}

export function runOptionalReleaseQuery({ enabled, query }) {
  if (!enabled) return Promise.resolve({ data: [], error: null });
  if (typeof query !== 'function') throw new TypeError('A release-gated query is required.');
  return query();
}
