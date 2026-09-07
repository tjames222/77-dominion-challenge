import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { test } from 'node:test';
import { createRestartProof, verifyRestartProof, PRIOR_PRODUCTION_CANARY_RELEASE_SHA,
  PRODUCTION_CANARY_RESTART_PROOF_CONTRACT } from './production-canary-restart-proof.mjs';

const keys = generateKeyPairSync('ed25519');
const other = generateKeyPairSync('ed25519');
const nowMs = Date.parse('2026-09-10T12:00:00.000Z');
const metadata = { schemaVersion: 1, artifactContract: PRODUCTION_CANARY_RESTART_PROOF_CONTRACT,
  priorReleaseSha: PRIOR_PRODUCTION_CANARY_RELEASE_SHA, releaseSha: 'a'.repeat(40), backupRunId: '12345',
  backupRunAttempt: 2, artifactId: '23456', encryptedSha256: 'b'.repeat(64), publicKeySha256: 'c'.repeat(64),
  createdAt: '2026-09-10T11:00:00.000Z' };
const entitlementsFingerprint = { count: 1, sha256: 'd'.repeat(64) };
const proof = createRestartProof({ metadata, entitlementsFingerprint, signingPrivateKey: keys.privateKey });
const verifyProof = (changes = {}) => verifyRestartProof({ proof, entitlementsFingerprint,
  signingPublicKey: keys.publicKey, expectedMetadata: metadata, nowMs, ...changes });

test('separate Ed25519 receipt verifies without publishing the private table fingerprint', () => {
  assert.deepEqual(verifyProof(), { verified: true });
  assert.deepEqual(Object.keys(proof), [...Object.keys(metadata), 'signature']);
  assert.equal(JSON.stringify(proof).includes(entitlementsFingerprint.sha256), false);
  assert.equal(JSON.stringify(proof).includes('entitlementsFingerprint'), false);
  assert.deepEqual(verifyProof({ proof: Object.fromEntries(Object.entries(proof).reverse()) }), { verified: true });
});
test('every public binding and the private whole-table fingerprint is authenticated', () => {
  for (const key of Object.keys(metadata)) {
    const value = typeof metadata[key] === 'number' ? metadata[key] + 1 : `${metadata[key]}x`;
    assert.throws(() => verifyProof({ proof: { ...proof, [key]: value } }), /proof is invalid/u, key);
    assert.throws(() => verifyProof({ expectedMetadata: { ...metadata, [key]: value } }), /proof is invalid/u, key);
  }
  for (const sha256 of ['e'.repeat(64), 'D'.repeat(64), 'not-a-hash']) {
    assert.throws(() => verifyProof({ entitlementsFingerprint: { count: 1, sha256 } }), /proof is invalid/u);
  }
  for (const count of [0, 2, '1', null]) assert.throws(() => verifyProof({ entitlementsFingerprint: { count, sha256: 'd'.repeat(64) } }));
  for (const [key, value] of Object.entries({ releaseSha: 'e'.repeat(40), backupRunId: '12346',
    backupRunAttempt: 3, artifactId: '23457', encryptedSha256: 'e'.repeat(64), publicKeySha256: 'e'.repeat(64),
    createdAt: '2026-09-10T11:01:00.000Z' })) {
    // Still well-formed and expected by the caller, but not the signed receipt.
    assert.throws(() => verifyProof({ proof: { ...proof, [key]: value }, expectedMetadata: { ...metadata, [key]: value } }));
  }
});
test('rejects wrong keys, signature malleation and a non-domain-separated signature', () => {
  assert.throws(() => verifyProof({ signingPublicKey: other.publicKey }));
  assert.throws(() => verifyProof({ signingPublicKey: keys.privateKey }));
  assert.throws(() => verifyProof({ signingPublicKey: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }) }));
  assert.deepEqual(verifyProof({ signingPublicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }) }), { verified: true });
  for (const signature of [proof.signature.trimEnd() + '\n', proof.signature.replace(/=+$/u, ''),
    Buffer.alloc(64).toString('base64'), sign(null, Buffer.from(JSON.stringify({ metadata, entitlementsFingerprint })), keys.privateKey).toString('base64')]) {
    assert.throws(() => verifyProof({ proof: { ...proof, signature } }));
  }
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  assert.throws(() => createRestartProof({ metadata, entitlementsFingerprint, signingPrivateKey: rsa.privateKey }));
  assert.throws(() => verifyProof({ signingPublicKey: rsa.publicKey }));
});
test('rejects stale/future receipts, reused release, wrong types and extra private fields', () => {
  assert.throws(() => verifyProof({ nowMs: nowMs + 86_400_000 }));
  assert.throws(() => verifyProof({ nowMs: Date.parse(metadata.createdAt) - 300_001 }));
  assert.throws(() => verifyProof({ nowMs: NaN }));
  for (const change of [{ releaseSha: PRIOR_PRODUCTION_CANARY_RELEASE_SHA }, { backupRunId: 12345 },
    { artifactId: '023456' }, { backupRunAttempt: '2' }, { createdAt: '2026-09-10T11:00:00Z' },
    { entitlementsFingerprint }]) {
    assert.throws(() => createRestartProof({ metadata: { ...metadata, ...change }, entitlementsFingerprint, signingPrivateKey: keys.privateKey }));
  }
  assert.throws(() => verifyProof({ proof: { ...proof, entitlementsFingerprint } }));
  assert.throws(() => verifyProof({ entitlementsFingerprint: { ...entitlementsFingerprint, uuid: 'private' } }));
});

test('new one-time approval is fixed to the exact revoked f2472a2 predecessor', () => {
  assert.equal(PRIOR_PRODUCTION_CANARY_RELEASE_SHA, 'f2472a26aad529b5dccc3d60f5b6970e1372b501');
  assert.deepEqual(verifyProof(), { verified: true });
});

for (const spentPredecessor of [
  '877942113f1d18e73f2e51e6b467915b37b0c67b',
  '0507c5e3b63d03f5e8ce7781aad463134d992871',
]) {
  test(`new approval rejects the spent ${spentPredecessor.slice(0, 7)} predecessor contract`, () => {
    const earlierMetadata = { ...metadata, priorReleaseSha: spentPredecessor };
    assert.throws(() => createRestartProof({ metadata: earlierMetadata, entitlementsFingerprint, signingPrivateKey: keys.privateKey }));
    assert.throws(() => verifyProof({ proof: { ...proof, priorReleaseSha: spentPredecessor }, expectedMetadata: earlierMetadata }));
  });
}
