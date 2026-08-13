const DAILY_ACTION_COPY_REPLACEMENTS = [
  [/\bDaily Standards\b/g, 'Daily Actions'], // customer-copy-compatibility
  [/\bDaily Standard\b/g, 'Daily Action'], // customer-copy-compatibility
];

export function naturalizeDailyActionError(error) {
  if (!error || typeof error.message !== 'string') return error;

  const message = DAILY_ACTION_COPY_REPLACEMENTS.reduce(
    (copy, [legacy, replacement]) => copy.replace(legacy, replacement),
    error.message,
  );
  if (message === error.message) return error;

  try {
    error.message = message;
    if (error.message === message) return error;
  } catch {
    // Some browser-provided error objects expose a read-only message.
  }

  const translated = Object.assign(new Error(message), error);
  translated.message = message;
  return translated;
}
