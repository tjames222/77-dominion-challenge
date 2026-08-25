export const FALLBACK_DAILY_VERSE = Object.freeze({
  text: 'His mercies never come to an end; they are new every morning.',
  reference: 'Lamentations 3:22-23',
});

export const WORSHIP_PLAYLISTS = Object.freeze([
  Object.freeze({ label: 'Morning worship focus', url: 'https://open.spotify.com/search/morning%20worship%20playlist' }),
  Object.freeze({ label: 'Acoustic worship reset', url: 'https://open.spotify.com/search/acoustic%20worship%20playlist' }),
  Object.freeze({ label: 'Praise and worship lift', url: 'https://open.spotify.com/search/praise%20and%20worship%20playlist' }),
  Object.freeze({ label: 'Instrumental worship flow', url: 'https://open.spotify.com/search/instrumental%20worship%20playlist' }),
  Object.freeze({ label: 'Gospel worship strength', url: 'https://open.spotify.com/search/gospel%20worship%20playlist' }),
  Object.freeze({ label: 'Evening worship surrender', url: 'https://open.spotify.com/search/evening%20worship%20playlist' }),
  Object.freeze({ label: 'Christian worship today', url: 'https://open.spotify.com/search/christian%20worship%20playlist' }),
]);

export function dayIndexForDate(dateKey) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateKey || ''));
  if (!match) return 0;
  return Math.floor(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / 86400000);
}

export function pickDailyForDate(items, dateKey, offset = 0) {
  if (!Array.isArray(items) || items.length === 0) return null;
  const index = ((dayIndexForDate(dateKey) + Number(offset || 0)) % items.length + items.length) % items.length;
  return items[index];
}

export function verseFromPayload(data, fallback = FALLBACK_DAILY_VERSE) {
  return {
    text:
      data?.verse?.text
      || data?.data?.verse?.text
      || data?.data?.attributes?.text
      || data?.text
      || fallback.text,
    reference:
      data?.verse?.reference
      || data?.data?.verse?.reference
      || data?.data?.attributes?.reference
      || data?.reference
      || fallback.reference,
  };
}

export async function loadDailyVerse(url, fetchImpl = globalThis.fetch) {
  if (!url || typeof fetchImpl !== 'function') return FALLBACK_DAILY_VERSE;
  try {
    const response = await fetchImpl(url, { headers: { Accept: 'application/json' } });
    if (!response?.ok) return FALLBACK_DAILY_VERSE;
    return verseFromPayload(await response.json());
  } catch {
    return FALLBACK_DAILY_VERSE;
  }
}
