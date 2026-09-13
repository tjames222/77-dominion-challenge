export const EARLY_ACCESS_RECEIVED = 'Your request has been received. We’ll contact you by email when access is available. Submitting again won’t create a duplicate request.';

export function normalizeEarlyAccessRequest(input = {}) {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
  if (!name || name.length > 120 || /[\u0000-\u001f\u007f]/u.test(name)) {
    throw new Error('Enter your name using 120 characters or fewer.');
  }
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)
    || /[\u0000-\u001f\u007f]/u.test(email)) {
    throw new Error('Enter a valid email address.');
  }
  return { name, email, website: typeof input.website === 'string' ? input.website : '' };
}

export function assertEarlyAccessActor(user, expectedUserId) {
  const actor = user?.authenticated ? String(user.userId || '') : '';
  if (actor !== expectedUserId) throw new Error('The signed-in account changed. Please review the form and try again.');
}

export async function postEarlyAccessRequest(request, {
  endpoint, publicKey, accessToken = '', fetchImpl = globalThis.fetch,
} = {}) {
  const headers = { 'Content-Type': 'application/json', apikey: publicKey };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST', headers, body: JSON.stringify(request), cache: 'no-store',
      redirect: 'error', signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error('We couldn’t confirm your request. Your details are still here—please try again. Submitting again won’t create a duplicate.');
  }
  const data = await response.json().catch(() => null);
  if (!response.ok || data?.received !== true) {
    if (response.status === 429) throw new Error('Requests are busy right now. Please try again in an hour.');
    if (response.status === 401 || response.status === 403) throw new Error('Please sign in again and use your verified account email.');
    throw new Error('We couldn’t save your request. Your details are still here—please try again.');
  }
  return { received: true };
}
