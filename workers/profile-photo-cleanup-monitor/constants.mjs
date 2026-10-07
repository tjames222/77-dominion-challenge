export const ACCOUNT_ID = '458dff367f845e8295be4cfb1af8633a';
export const HEALTH_URL = 'https://mimolwojppbtsbvtqwpo.supabase.co/functions/v1/process-profile-photo-cleanup';
export const SENDER = 'alerts@77dominion.com';
export const RECIPIENT = 'tjames@cablueprinting.com';
export const CRON = '2,7,12,17,22,27,32,37,42,47,52,57 * * * *';
export const OBJECT_NAME = 'profile-photo-cleanup-v1';
export const TICK_URL = 'https://cleanup-monitor.internal/tick';
export const STATE_KEY = 'monitor-v1';
export const SELF_TEST_KEY = 'owner-acceptance-v1';
export const SELF_TEST_ID = 'owner-acceptance-2026-10-07';
export const INTERVAL_MS = 300_000;
export const MAX_SNAPSHOT_AGE_MS = 120_000;
export const MAX_FUTURE_MS = 5_000;
export const MAX_GAP_MS = 450_000;
export const DAILY_LIMIT = 6;
export const CONDITIONS = Object.freeze([
  'health_unavailable', 'cron_unavailable', 'cron_inactive', 'cron_schedule',
  'cron_stale', 'cron_failed', 'stale_leases', 'ready_backlog', 'oldest_ready', 'cleanup_failures',
]);
export const CONDITION_TEXT = Object.freeze({
  health_unavailable: 'Two consecutive health observations failed.',
  cron_unavailable: 'The exact cleanup schedule is missing, unavailable or ambiguous.',
  cron_inactive: 'The cleanup schedule is inactive.',
  cron_schedule: 'The cleanup schedule differs from its five-minute policy.',
  cron_stale: 'Cleanup Cron start history is absent or older than fifteen minutes.',
  cron_failed: 'Two distinct consecutive observed cleanup Cron runs failed.',
  stale_leases: 'Stale cleanup leases remained observed for more than ten minutes.',
  ready_backlog: 'The ready cleanup queue exceeds one hundred items.',
  oldest_ready: 'The oldest ready cleanup item is more than fifteen minutes old.',
  cleanup_failures: 'More than five cleanup failures occurred in the last hour.',
});
