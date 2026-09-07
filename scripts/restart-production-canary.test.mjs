import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, writeFile, chmod, realpath, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { restartProductionCanary, restartPreflightQuery, buildRestartCanaryQuery,
  verifyRestartPreflightResponse, parseRestartCanaryArguments } from './restart-production-canary.mjs';
import { createRestartProof, PRIOR_PRODUCTION_CANARY_RELEASE_SHA, PRODUCTION_CANARY_RESTART_PROOF_CONTRACT } from './production-canary-restart-proof.mjs';
import { reconciledHistoryVersions } from './verify-production-migration-cutover-plan.mjs';
import { CLOSED_AUTH_CONFIG_PATCH } from './production-auth-canary-policy.mjs';
import { grantVerificationQuery } from './manage-production-canary-entitlement.mjs';

const rsa = generateKeyPairSync('rsa', { modulusLength: 4096 });
const signing = generateKeyPairSync('ed25519');
const sha256 = value => createHash('sha256').update(value).digest('hex');
const nowMs = Date.parse('2026-09-10T12:00:00.000Z');
const createdAt = '2026-09-10T11:00:00.000Z';
const releaseSha = 'a'.repeat(40), runId = '12345', fingerprint = 'd'.repeat(64);
const encrypted = Buffer.from('synthetic encrypted artifact, no production data');
const manifest = { schemaVersion: 1, artifactContract: 'dominion-free-production-backup/v1',
  projectRef: 'mimolwojppbtsbvtqwpo', releaseCommit: releaseSha, runId, runAttempt: 2, createdAt,
  postgresImage: 'public.ecr.aws/supabase/postgres:17.6.1.141', postgresImageId: `sha256:${'b'.repeat(64)}`,
  encryptedSha256: sha256(encrypted), encryptedBytes: encrypted.length,
  publicKeySha256: sha256(rsa.publicKey.export({ type: 'spki', format: 'der' })),
  encryption: { algorithm: 'AES-256-GCM', keyWrap: 'RSA-OAEP-SHA256', wrappedKey: Buffer.alloc(512, 1).toString('base64'),
    iv: Buffer.alloc(12, 2).toString('base64'), tag: Buffer.alloc(16, 3).toString('base64') },
  restoreVerified: true, storageObjects: 0, migrationVersions: [...reconciledHistoryVersions] };
const run = { id: 12345, head_sha: releaseSha, head_branch: 'main', event: 'workflow_dispatch',
  path: '.github/workflows/production-backup.yml', status: 'completed', conclusion: 'success', run_attempt: 2,
  repository: { id: 777, full_name: 'tjames222/77-dominion-challenge' },
  head_repository: { id: 777, full_name: 'tjames222/77-dominion-challenge' }, created_at: createdAt };
const artifact = { id: 23456, name: `production-backup-${releaseSha}-${runId}`, expired: false,
  size_in_bytes: 4096, created_at: createdAt, expires_at: '2026-09-11T11:00:00.000Z',
  workflow_run: { id: run.id, head_sha: releaseSha, head_branch: 'main', repository_id: 777, head_repository_id: 777 } };
const metadata = { schemaVersion: 1, artifactContract: PRODUCTION_CANARY_RESTART_PROOF_CONTRACT,
  priorReleaseSha: PRIOR_PRODUCTION_CANARY_RELEASE_SHA, releaseSha, backupRunId: runId, backupRunAttempt: 2,
  artifactId: String(artifact.id), encryptedSha256: manifest.encryptedSha256,
  publicKeySha256: manifest.publicKeySha256, createdAt };
const proof = createRestartProof({ metadata, entitlementsFingerprint: { count: 1, sha256: fingerprint }, signingPrivateKey: signing.privateKey });
const preflight = [{ release_sha_is_canonical: true, serialization_settings_match: true, restart_invariants_match: true,
  entitlements_count: '1', entitlements_sha256: fingerprint }];
const verification = [{ migration_history_matches: true, nonanonymous_user_count: '1', matching_profile_count: '1',
  billing_customer_count: '0', subscription_count: '0', membership_count: '1', active_membership_count: '1',
  production_canary_count: '1', matching_canary_count: '1', legacy_purchases_table: null }];
const mainRef = { ref: 'refs/heads/main', object: { type: 'commit', sha: releaseSha } };
const environment = { GH_TOKEN: 'synthetic-github-token', SUPABASE_ACCESS_TOKEN: 'synthetic-supabase-token',
  SUPABASE_PROJECT_REF: manifest.projectRef, GITHUB_SHA: releaseSha, BACKUP_RUN_ID: runId,
  PRODUCTION_BACKUP_PUBLIC_KEY: rsa.publicKey.export({ type: 'spki', format: 'pem' }),
  PRODUCTION_CANARY_RESTART_PUBLIC_KEY: signing.publicKey.export({ type: 'spki', format: 'pem' }),
  PRODUCTION_CANARY_RESTART_RECOVERY_PROOF: JSON.stringify(proof) };
async function fixture(t, changes = {}) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), '77dc-restart-runtime-test-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, 'backup-manifest.json'), JSON.stringify(changes.manifest ?? manifest), { mode: 0o600 });
  await writeFile(path.join(directory, 'backup.enc'), changes.encrypted ?? encrypted, { mode: 0o600 });
  const calls = [], consumed = [];
  const fetchImpl = async (url, options) => {
    const kind = url.endsWith('/config/auth') ? 'auth' : url.endsWith('/database/query') ? 'write'
      : url.endsWith('/database/query/read-only') ? (JSON.parse(options.body).query === restartPreflightQuery ? 'preflight' : 'verification')
        : url.endsWith('/git/ref/heads/main') ? 'main' : url.includes('/artifacts?') ? 'artifacts' : 'run';
    calls.push({ kind, url, options });
    assert.equal(options.redirect, 'error'); assert.equal(options.cache, 'no-store');
    assert.ok(options.signal instanceof AbortSignal);
    if (changes.throwAt === kind) throw new Error(`private: ${fingerprint} synthetic-private-response`);
    const value = { run: changes.run ?? run, artifacts: changes.artifacts ?? { total_count: 1, artifacts: [artifact] },
      main: changes.main ?? mainRef, auth: changes.auth ?? CLOSED_AUTH_CONFIG_PATCH,
      preflight: changes.preflight ?? preflight, verification: changes.verification ?? verification }[kind];
    return { status: changes.failAt === kind ? 400 : ['write', 'preflight', 'verification'].includes(kind) ? 201 : 200,
      redirected: changes.redirectAt === kind, body: { cancel: async () => {} },
      json: async () => { consumed.push(kind); if (kind === 'write') assert.fail('Write response must not be read'); return value; } };
  };
  const invoke = () => restartProductionCanary({ backupDirectory: directory,
    environment: { ...environment, ...changes.environment }, fetchImpl, now: () => changes.nowMs ?? nowMs });
  return { directory, calls, consumed, invoke };
}

test('valid backup/proof/Auth/live checkpoint precede one fixed CAS and strict grant verification', async t => {
  const f = await fixture(t); assert.deepEqual(await f.invoke(), { operation: 'restart', verified: true });
  assert.deepEqual(f.calls.map(c => c.kind), ['run', 'artifacts', 'main', 'auth', 'preflight', 'write', 'verification']);
  const write = JSON.parse(f.calls.find(c => c.kind === 'write').options.body);
  assert.deepEqual(write, { query: buildRestartCanaryQuery(releaseSha, fingerprint), parameters: [] });
  assert.deepEqual(JSON.parse(f.calls.at(-1).options.body), { query: grantVerificationQuery, parameters: [releaseSha] });
  assert.equal(f.consumed.includes('write'), false);
});
test('closed Auth failures perform no SQL requests', async t => {
  for (const patch of [{ disable_signup: false }, { external_anonymous_users_enabled: true }, { site_url: 'https://wrong.invalid' }, { uri_allow_list: '*' }]) {
    const f = await fixture(t, { auth: { ...CLOSED_AUTH_CONFIG_PATCH, ...patch } });
    await assert.rejects(f.invoke, /private details suppressed/u);
    assert.equal(f.calls.some(c => ['write', 'preflight', 'verification'].includes(c.kind)), false);
  }
});
test('backup run/attempt/artifact/current-main and encrypted-byte tampering never permit a write', async t => {
  const cases = [{ run: { ...run, run_attempt: 3 } }, { manifest: { ...manifest, runAttempt: 1 } },
    { run: { ...run, repository: { full_name: run.repository.full_name } },
      artifacts: { total_count: 1, artifacts: [{ ...artifact, workflow_run: { ...artifact.workflow_run, repository_id: undefined } }] } },
    { run: { ...run, conclusion: 'failure' } }, { run: { ...run, head_branch: 'develop' } },
    { artifacts: { total_count: 1, artifacts: [{ ...artifact, id: 99 }] } },
    { artifacts: { total_count: 1, artifacts: [{ ...artifact, workflow_run: { ...artifact.workflow_run, id: 99 } }] } },
    { main: { ...mainRef, object: { type: 'commit', sha: 'e'.repeat(40) } } },
    { encrypted: Buffer.from('tampered') }, { manifest: { ...manifest, restoreVerified: false } },
    { nowMs: nowMs + 86_400_000 }];
  for (const change of cases) {
    const f = await fixture(t, change); await assert.rejects(f.invoke, /private details suppressed/u);
    assert.equal(f.calls.some(c => c.kind === 'write'), false);
  }
});
test('every preflight invariant and signed fingerprint mismatch stops before write', async t => {
  for (const [key, bad] of Object.entries({ release_sha_is_canonical: false, serialization_settings_match: false,
    restart_invariants_match: false, entitlements_count: '2', entitlements_sha256: 'e'.repeat(64) })) {
    const f = await fixture(t, { preflight: [{ ...preflight[0], [key]: bad }] });
    await assert.rejects(f.invoke, /private details suppressed/u); assert.equal(f.calls.some(c => c.kind === 'write'), false);
  }
  for (const bad of [[], [preflight[0], preflight[0]], [{ ...preflight[0], private_uuid: 'hidden' }]]) {
    assert.throws(() => verifyRestartPreflightResponse(bad));
  }
});
test('signature/replay/malformed environment rejection never performs a write', async t => {
  for (const change of [
    { PRODUCTION_CANARY_RESTART_RECOVERY_PROOF: JSON.stringify({ ...proof, signature: Buffer.alloc(64).toString('base64') }) },
    { PRODUCTION_CANARY_RESTART_RECOVERY_PROOF: JSON.stringify({ ...proof, releaseSha: 'e'.repeat(40) }) },
    { GITHUB_SHA: PRIOR_PRODUCTION_CANARY_RELEASE_SHA }, { SUPABASE_PROJECT_REF: 'another-project' },
    { NODE_DEBUG: 'http' }, { NODE_OPTIONS: '--inspect' }, { NODE_USE_ENV_PROXY: '1' }, { BACKUP_RUN_ID: '012345' },
  ]) {
    const f = await fixture(t, { environment: change }); await assert.rejects(f.invoke, /private details suppressed/u);
    assert.equal(f.calls.some(c => c.kind === 'write'), false);
  }
});
test('private API failures are suppressed, write is never retried, post-write uncertainty remains failure', async t => {
  for (const kind of ['run', 'artifacts', 'main', 'auth', 'preflight', 'write', 'verification']) {
    for (const key of ['throwAt', 'failAt', 'redirectAt']) {
      const f = await fixture(t, { [key]: kind });
      await assert.rejects(f.invoke, error => {
        assert.equal(error.message, 'Audited production canary restart failed; private details suppressed.');
        assert.equal(error.message.includes(fingerprint), false); return true;
      });
      assert.equal(f.calls.filter(c => c.kind === kind).length, 1);
      assert.equal(f.consumed.includes(kind), false);
      assert.equal(f.calls.some(c => c.kind === 'write'), ['write', 'verification'].includes(kind));
    }
  }
});
test('artifact files and CLI bindings reject extra files, symlinks, mutable permissions and injection', async t => {
  const extra = await fixture(t); await writeFile(path.join(extra.directory, 'unexpected'), 'x'); await assert.rejects(extra.invoke);
  const mutable = await fixture(t); await chmod(path.join(mutable.directory, 'backup.enc'), 0o666); await assert.rejects(mutable.invoke);
  const linked = await fixture(t); await rm(path.join(linked.directory, 'backup.enc')); await symlink('backup-manifest.json', path.join(linked.directory, 'backup.enc')); await assert.rejects(linked.invoke);
  for (const args of [[], ['--operation', 'grant'], ['--backup-directory'], ['--backup-directory', '/tmp', 'extra']]) assert.throws(() => parseRestartCanaryArguments(args));
  assert.equal(parseRestartCanaryArguments(['--backup-directory', '/tmp/example']).backupDirectory, '/tmp/example');
  assert.throws(() => buildRestartCanaryQuery("'; select 1; --", fingerprint));
  assert.throws(() => buildRestartCanaryQuery(releaseSha, "'; select 1; --"));
});
