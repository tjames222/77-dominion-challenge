const RECOVERY_SIGN_OUT_ERROR =
  'Your password was changed, but this browser could not be signed out. Close this window, then sign in again before continuing.';

export async function revokeRecoverySessions(auth) {
  if (!auth || typeof auth.signOut !== 'function') {
    throw new TypeError('A Supabase Auth client is required.');
  }

  const { error: globalError } = await auth.signOut();
  if (!globalError) return { scope: 'global' };

  const { error: localError } = await auth.signOut({ scope: 'local' });
  if (localError) {
    throw new AggregateError(
      [globalError, localError],
      RECOVERY_SIGN_OUT_ERROR,
    );
  }

  return { scope: 'local', globalError };
}

