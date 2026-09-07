import { createPrivateKey, createPublicKey, KeyObject, sign, verify } from 'node:crypto';

export const PRIOR_PRODUCTION_CANARY_RELEASE_SHA = '0507c5e3b63d03f5e8ce7781aad463134d992871';
export const PRODUCTION_CANARY_RESTART_PROOF_CONTRACT = 'dominion-production-canary-restart-proof/v1';
export const PRODUCTION_CANARY_RESTART_PROOF_DOMAIN = 'dominion-production-canary-restart-recovery/v1\0';
const fields = Object.freeze(['schemaVersion', 'artifactContract', 'priorReleaseSha', 'releaseSha',
  'backupRunId', 'backupRunAttempt', 'artifactId', 'encryptedSha256', 'publicKeySha256', 'createdAt']);
const hex = /^[0-9a-f]{64}$/u;
function fail() { throw new Error('Production canary restart recovery proof is invalid.'); }
function exact(value, names) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...names].sort())) fail();
}
export function validateRestartMetadata(metadata) {
  exact(metadata, fields);
  if (metadata.schemaVersion !== 1 || metadata.artifactContract !== PRODUCTION_CANARY_RESTART_PROOF_CONTRACT
    || metadata.priorReleaseSha !== PRIOR_PRODUCTION_CANARY_RELEASE_SHA
    || typeof metadata.releaseSha !== 'string' || !/^[0-9a-f]{40}$/u.test(metadata.releaseSha)
    || metadata.releaseSha === PRIOR_PRODUCTION_CANARY_RELEASE_SHA
    || !Number.isSafeInteger(metadata.backupRunAttempt) || metadata.backupRunAttempt < 1) fail();
  for (const key of ['backupRunId', 'artifactId']) {
    if (typeof metadata[key] !== 'string' || !/^[1-9][0-9]{0,15}$/u.test(metadata[key])) fail();
  }
  for (const key of ['encryptedSha256', 'publicKeySha256']) {
    if (typeof metadata[key] !== 'string' || !hex.test(metadata[key])) fail();
  }
  if (typeof metadata.createdAt !== 'string' || !Number.isFinite(Date.parse(metadata.createdAt))
    || new Date(metadata.createdAt).toISOString() !== metadata.createdAt) fail();
  return Object.fromEntries(fields.map(key => [key, metadata[key]]));
}
function fingerprint(value) {
  exact(value, ['count', 'sha256']);
  if (value.count !== 1 || typeof value.sha256 !== 'string' || !hex.test(value.sha256)) fail();
  return { count: 1, sha256: value.sha256 };
}
function signingBytes(metadata, entitlementsFingerprint) {
  return Buffer.from(PRODUCTION_CANARY_RESTART_PROOF_DOMAIN + JSON.stringify({
    metadata: validateRestartMetadata(metadata), entitlementsFingerprint: fingerprint(entitlementsFingerprint),
  }), 'utf8');
}
function requireKey(value, type) {
  let key;
  try {
    key = value instanceof KeyObject ? value : type === 'private' ? createPrivateKey(value) : createPublicKey(value);
  } catch { fail(); }
  if (key.type !== type || key.asymmetricKeyType !== 'ed25519') fail();
  if (type === 'public' && !(value instanceof KeyObject)) {
    if (typeof value !== 'string' && !Buffer.isBuffer(value)) fail();
    const pem = Buffer.isBuffer(value) ? value.toString('utf8') : value;
    if (pem.trim() !== key.export({ type: 'spki', format: 'pem' }).trim()) fail();
  }
  return key;
}
export function createRestartProof({ metadata, entitlementsFingerprint, signingPrivateKey }) {
  const canonical = validateRestartMetadata(metadata);
  const key = requireKey(signingPrivateKey, 'private');
  const signature = sign(null, signingBytes(canonical, entitlementsFingerprint), key).toString('base64');
  // The table fingerprint is deliberately only in the signed preimage, never the public receipt.
  return { ...canonical, signature };
}
export function verifyRestartProof({ proof, entitlementsFingerprint, signingPublicKey, expectedMetadata, nowMs = Date.now() }) {
  exact(proof, [...fields, 'signature']);
  const metadata = validateRestartMetadata(Object.fromEntries(fields.map(key => [key, proof[key]])));
  const expected = validateRestartMetadata(expectedMetadata);
  if (JSON.stringify(metadata) !== JSON.stringify(expected) || !Number.isSafeInteger(nowMs) || nowMs < 0) fail();
  const created = Date.parse(metadata.createdAt);
  if (created > nowMs + 300_000 || nowMs - created > 86_400_000) fail();
  if (typeof proof.signature !== 'string') fail();
  const signature = Buffer.from(proof.signature, 'base64');
  if (signature.length !== 64 || signature.toString('base64') !== proof.signature) fail();
  const key = requireKey(signingPublicKey, 'public');
  if (!verify(null, signingBytes(metadata, entitlementsFingerprint), key, signature)) fail();
  return { verified: true };
}
