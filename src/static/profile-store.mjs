export const PROFILE_COLUMNS =
  'user_id, name, email, avatar_url, challenge_start_date, time_zone, created_at, updated_at';
export const LEGACY_PROFILE_COLUMNS =
  'user_id, name, email, challenge_start_date, time_zone, created_at, updated_at';

export function isMissingProfilePhotoSchemaError(error) {
  const code = String(error?.code || '');
  const message = String(error?.message || '');
  return ['42703', 'PGRST204'].includes(code)
    && /\bavatar_url\b/i.test(message)
    && /(profiles|schema cache|column)/i.test(message);
}

export async function readProfileRecord(client, userId) {
  const fullResult = await client
    .from('profiles')
    .select(PROFILE_COLUMNS)
    .eq('user_id', userId)
    .maybeSingle();
  if (!fullResult.error) {
    return {
      data: fullResult.data
        ? { ...fullResult.data, profile_photo_available: true }
        : null,
      profilePhotoAvailable: true,
    };
  }
  if (!isMissingProfilePhotoSchemaError(fullResult.error)) throw fullResult.error;

  const legacyResult = await client
    .from('profiles')
    .select(LEGACY_PROFILE_COLUMNS)
    .eq('user_id', userId)
    .maybeSingle();
  if (legacyResult.error) throw legacyResult.error;
  return {
    data: legacyResult.data
      ? {
          ...legacyResult.data,
          avatar_url: '',
          profile_photo_available: false,
        }
      : null,
    profilePhotoAvailable: false,
  };
}

export async function ensureProfileRecord(client, seed) {
  const existing = await readProfileRecord(client, seed.user_id);
  if (existing.data) return existing;

  const { error } = await client.from('profiles').insert(seed);
  if (error && error.code !== '23505') throw error;

  const created = await readProfileRecord(client, seed.user_id);
  if (!created.data) throw new Error('Unable to create your profile.');
  return created;
}

export function buildProfilePatch(profile, { nextName, nextEmail } = {}) {
  const patch = {};
  if (!profile.avatarOnly && profile.name !== undefined) patch.name = nextName;
  if (!profile.avatarOnly && profile.email !== undefined) patch.email = nextEmail;
  if (!profile.avatarOnly && profile.challengeStartDate !== undefined) {
    patch.challenge_start_date = profile.challengeStartDate || null;
  }
  return patch;
}
