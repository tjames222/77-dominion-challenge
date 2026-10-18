// Synthetic aggregate-only preview input. No current account, runtime flag,
// private review record or provider state is inspected or changed.
export function previewActivationReviewHealth(observedAt) {
  return { coverage: 'legacy-activation-migration-reviews-only', counterLimit: 1000,
    unresolved: { count: 3, hasMore: false }, oldestRecordedState: 'known',
    oldestRecordedAt: new Date(Date.parse(observedAt) - 7200000).toISOString() };
}
