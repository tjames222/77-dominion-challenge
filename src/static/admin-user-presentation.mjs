// Presentation only: fixed fields from the existing, authorized account list.
// No access, current-day, streak-expiry, or subscription-validity decisions.
const missing = 'Not recorded';
const text = (value) => typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))
  ? String(value).slice(0, 2000) : missing;
const timestamp = (value) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return missing;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? `${date.toISOString().replace('T', ' ').slice(0, 19)} UTC` : missing;
};
const roles = { member: 'Member', site_admin: 'Site admin' };
const crewRoles = { member: 'Member', admin: 'Admin', owner: 'Owner' };
const subscriptionStatuses = {
  incomplete: 'Incomplete', incomplete_expired: 'Incomplete expired', trialing: 'Trialing', active: 'Active',
  past_due: 'Past due', canceled: 'Canceled', unpaid: 'Unpaid', paused: 'Paused', unknown: 'Unknown',
};
const label = (labels, value) => value == null ? missing : Object.hasOwn(labels, value) ? labels[value] : 'Unknown';

export function adminUserListFacts(item) {
  const progress = item.statsSnapshot;
  const subscription = item.subscriptionSnapshot;
  return {
    account: [
      ['Site role', label(roles, item.role)], ['Created', timestamp(item.createdAt)],
      ['Email confirmed', timestamp(item.emailConfirmedAt)], ['Last sign-in', timestamp(item.lastSignInAt)],
    ],
    crew: item.crew ? [['Name', text(item.crew.name)], ['Crew-local role', label(crewRoles, item.crew.role)]] : null,
    snapshotSummary: [
      ['Stored points', text(progress?.totalPoints)],
      ['Stored subscription', label(subscriptionStatuses, subscription?.status)],
    ],
    snapshots: [
      { title: 'Stored progress snapshot', fields: progress ? [
        ['Stored total points', text(progress.totalPoints)], ['Stored app streak', text(progress.storedAppStreak)],
        ['Stored perfect-day streak', text(progress.storedPerfectDayStreak)], ['Last seen local date', text(progress.lastSeenLocalDate)],
        ['Recorded', timestamp(progress.recordedAt)],
      ] : null },
      { title: 'Stored subscription snapshot', fields: subscription ? [
        ['Stored status', label(subscriptionStatuses, subscription.status)], ['Period end', timestamp(subscription.currentPeriodEnd)],
        ['Cancel at period end', subscription.cancelAtPeriodEnd === true ? 'Yes' : subscription.cancelAtPeriodEnd === false ? 'No' : missing],
        ['Recorded', timestamp(subscription.recordedAt)],
      ] : null },
    ],
  };
}
