const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const issuedRequestIds = new Set();
let collisionSequence = 0;


function randomRequestId(salt = 0) {
  const bytes = new Uint8Array(16);
  globalThis.crypto?.getRandomValues?.(bytes);
  if (!bytes.some(Boolean)) {
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  }
  bytes[15] = (bytes[15] + salt) & 0xff;
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function newSiteTrainingRequestId() {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const candidate = typeof globalThis.crypto?.randomUUID === 'function' && attempt === 0
      ? globalThis.crypto.randomUUID()
      : randomRequestId(++collisionSequence);
    if (UUID_V4_PATTERN.test(candidate) && !issuedRequestIds.has(candidate)) {
      issuedRequestIds.add(candidate);
      return candidate;
    }
  }
  throw new Error('Unable to create a fresh page training request ID.');
}

