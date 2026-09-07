import test from 'node:test';
import assert from 'node:assert/strict';
import { constants, createCipheriv, createHash, generateKeyPairSync, publicEncrypt, randomBytes } from 'node:crypto';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createProofFromEncryptedBackup, inspectRestartTar, parseRestartProofArguments, readOwnerFile,
  requirePrivateDirectory, restartSubprocessEnvironment, verifyRestartBackupMetadata, writeNewRestartProof } from './prepare-production-canary-restart-proof.mjs';
import { PRIOR_PRODUCTION_CANARY_RELEASE_SHA, verifyRestartProof } from './production-canary-restart-proof.mjs';
import { reconciledHistoryVersions } from './verify-production-migration-cutover-plan.mjs';

const rsa = generateKeyPairSync('rsa', { modulusLength: 4096 });
const ed = generateKeyPairSync('ed25519');
const pem = (key) => key.export({ type: key.type === 'private' ? 'pkcs8' : 'spki', format: 'pem' });
const digest = (value) => createHash('sha256').update(value).digest('hex');
const privateFingerprint = '1234567890abcdef'.repeat(4);
const nowMs = Date.parse('2026-09-06T12:00:00.000Z');
const createdAt = new Date(nowMs - 60000).toISOString();
const releaseSha = 'a'.repeat(40), runId = '45', artifactId = '46';

const inventoryRecords = () => [
  { kind: 'boundary', serverVersion: '170006', encoding: 'UTF8', bootstrapRole: 'postgres', foreignTables: 0, reservedRoleExists: false },
  ...[['public', 'profiles'], ['auth', 'users'], ['storage', 'objects'], ['storage', 's3_multipart_uploads'], ['storage', 's3_multipart_uploads_parts'], ['supabase_migrations', 'schema_migrations']]
    .map(([schema, name]) => ({ kind: 'table', schema, name, count: 0, sha256: 'b'.repeat(64) })),
  { kind: 'table', schema: 'public', name: 'entitlements', count: 1, sha256: privateFingerprint },
  { kind: 'history', versions: reconciledHistoryVersions },
  { kind: 'eventTriggers', entries: [] },
];

// Independent POSIX ustar fixture construction: numeric fields are octal; the
// unsigned header checksum treats its own eight-byte field as ASCII spaces.
// Only synthetic text is used. No production plaintext or keys enter fixtures.
function checksumHeader(header) {
  header.fill(32, 148, 156);
  const sum = header.reduce((total, byte) => total + byte, 0);
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
}
function tar(entries) {
  const chunks = [];
  for (const [name, bytes] of entries) {
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, 'ascii');
    header.write('0000600\0', 100, 8, 'ascii');
    header.write('0000000\0', 108, 8, 'ascii');
    header.write('0000000\0', 116, 8, 'ascii');
    header.write(`${bytes.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
    header.write('00000000000\0', 136, 12, 'ascii');
    header[156] = 48;
    header.write('ustar\0', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');
    checksumHeader(header);
    chunks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  return Buffer.concat([...chunks, Buffer.alloc(1024)]);
}
function archive(records = inventoryRecords()) {
  return tar([['roles.sql', Buffer.from('-- synthetic roles fixture\n')], ['database.dump', Buffer.from('PGDMP\x01synthetic archive')],
    ['inventory.jsonl', Buffer.from(records.map((record) => JSON.stringify(record)).join('\n') + '\n')]]);
}
function fixture(plaintext = archive()) {
  const key = randomBytes(32), iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const manifest = {
    schemaVersion: 1, artifactContract: 'dominion-free-production-backup/v1', projectRef: 'mimolwojppbtsbvtqwpo',
    releaseCommit: releaseSha, runId, runAttempt: 2, postgresImage: 'public.ecr.aws/supabase/postgres:17.6.1.141',
    postgresImageId: 'sha256:ba10e934f0a59990379f78ab9ed93926f1c291dd61a12fe4026f4202f1b89770', restoreVerified: true,
    storageObjects: 0, migrationVersions: reconciledHistoryVersions, createdAt,
    publicKeySha256: digest(rsa.publicKey.export({ type: 'spki', format: 'der' })), encryptedBytes: encrypted.length,
    encryptedSha256: digest(encrypted), encryption: { algorithm: 'AES-256-GCM', keyWrap: 'RSA-OAEP-SHA256',
      iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'),
      wrappedKey: publicEncrypt({ key: rsa.publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, key).toString('base64') },
  };
  key.fill(0);
  const run = { id: Number(runId), head_sha: releaseSha, head_branch: 'main', event: 'workflow_dispatch',
    path: '.github/workflows/production-backup.yml', status: 'completed', conclusion: 'success', run_attempt: 2, created_at: createdAt,
    repository: { id: 1, full_name: 'tjames222/77-dominion-challenge' }, head_repository: { id: 1, full_name: 'tjames222/77-dominion-challenge' } };
  const artifact = { id: Number(artifactId), name: `production-backup-${releaseSha}-${runId}`, expired: false,
    size_in_bytes: encrypted.length + 512, created_at: createdAt, expires_at: new Date(nowMs + 86400000).toISOString(),
    workflow_run: { id: Number(runId), head_sha: releaseSha, head_branch: 'main', repository_id: 1, head_repository_id: 1 } };
  return { run, artifacts: { total_count: 1, artifacts: [artifact] }, releaseSha, runId, artifactId, manifest, encrypted,
    rsaPrivatePem: pem(rsa.privateKey), signingPrivatePem: pem(ed.privateKey), backupPublicKey: pem(rsa.publicKey), signingPublicKey: pem(ed.publicKey), nowMs };
}

test('authenticated local recovery signs only the public envelope and privately binds the entitlements fingerprint', () => {
  const input = fixture();
  const proof = createProofFromEncryptedBackup(input);
  const { signature, ...expectedMetadata } = proof;
  assert.equal(proof.backupRunAttempt, 2);
  assert.equal(proof.priorReleaseSha, PRIOR_PRODUCTION_CANARY_RELEASE_SHA);
  assert.equal(proof.artifactId, artifactId);
  assert.equal(proof.createdAt, createdAt);
  assert.equal(Buffer.from(signature, 'base64').length, 64);
  assert(!JSON.stringify(proof).includes(privateFingerprint));
  assert(!JSON.stringify(proof).includes('entitlements'));
  assert(!JSON.stringify(proof).includes('PRIVATE KEY'));
  verifyRestartProof({ proof, expectedMetadata, entitlementsFingerprint: { count: 1, sha256: privateFingerprint }, signingPublicKey: ed.publicKey, nowMs });
  assert.throws(() => verifyRestartProof({ proof, expectedMetadata, entitlementsFingerprint: { count: 1, sha256: 'f'.repeat(64) }, signingPublicKey: ed.publicKey, nowMs }));
});

test('metadata rejects wrong release, path, event, attempt, repository, artifact association, expiry and inventory', () => {
  const mutations = [
    (v) => { v.releaseSha = 'f2472a26aad529b5dccc3d60f5b6970e1372b501'; },
    (v) => { v.run.head_sha = 'b'.repeat(40); }, (v) => { v.run.head_branch = 'develop'; },
    (v) => { v.run.path = '.github/workflows/deploy.yml'; }, (v) => { v.run.event = 'pull_request'; },
    (v) => { v.run.status = 'in_progress'; }, (v) => { v.run.conclusion = 'failure'; },
    (v) => { v.run.run_attempt = 0; }, (v) => { v.run.repository.full_name = 'wrong/repository'; },
    (v) => { delete v.run.repository.id; delete v.artifacts.artifacts[0].workflow_run.repository_id; },
    (v) => { v.run.head_repository.id = 0; v.artifacts.artifacts[0].workflow_run.head_repository_id = 0; },
    (v) => { v.run.created_at = new Date(nowMs - 86400001).toISOString(); },
    (v) => { v.artifactId = '99'; }, (v) => { v.artifacts.total_count = 2; },
    (v) => { v.artifacts.artifacts[0].expired = true; },
    (v) => { v.artifacts.artifacts[0].expires_at = createdAt; },
    (v) => { v.artifacts.artifacts[0].workflow_run.head_sha = 'b'.repeat(40); },
    (v) => { v.artifacts.artifacts[0].workflow_run.repository_id = 2; },
    (v) => { v.artifacts.artifacts[0].workflow_run.head_repository_id = 2; },
    (v) => { v.artifacts.artifacts[0].workflow_run.id = 47; },
    (v) => { delete v.artifacts.artifacts[0].workflow_run; },
    (v) => { v.artifacts.artifacts.push(structuredClone(v.artifacts.artifacts[0])); v.artifacts.total_count = 2; },
  ];
  const base = fixture();
  for (const mutate of mutations) {
    const value = structuredClone(base); mutate(value);
    assert.throws(() => verifyRestartBackupMetadata(value), /^Error: Local restart proof verification failed; private details suppressed\.$/u);
  }
});

test('manifest, RSA recipient, Ed25519 signer, ciphertext and authentication tampering fail closed without leaking input', () => {
  const otherEd = generateKeyPairSync('ed25519');
  const weakRsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const mutations = [
    (v) => { v.manifest.runAttempt = 3; }, (v) => { v.manifest.releaseCommit = 'b'.repeat(40); },
    (v) => { v.manifest.createdAt = createdAt.replace('.000Z', 'Z'); },
    (v) => { v.manifest.migrationVersions = reconciledHistoryVersions.slice(1); },
    (v) => { v.manifest.restoreVerified = false; }, (v) => { v.manifest.storageObjects = 1; },
    (v) => { v.manifest.encryption.tag = Buffer.alloc(16).toString('base64'); },
    (v) => { v.manifest.encryption.iv = Buffer.alloc(12).toString('base64'); },
    (v) => { v.manifest.encryption.wrappedKey = Buffer.alloc(512).toString('base64'); },
    (v) => { v.manifest.encryption.wrappedKey += '\n'; },
    (v) => { v.manifest.publicKeySha256 = 'c'.repeat(64); },
    (v) => { v.encrypted[0] ^= 1; },
    (v) => { v.encrypted[0] ^= 1; v.manifest.encryptedSha256 = digest(v.encrypted); },
    (v) => { v.rsaPrivatePem = pem(weakRsa.privateKey); },
    (v) => { v.rsaPrivatePem = pem(rsa.publicKey); },
    (v) => { v.signingPrivatePem = pem(rsa.privateKey); },
    (v) => { v.signingPrivatePem = pem(otherEd.privateKey); },
    (v) => { v.signingPublicKey = pem(otherEd.publicKey); },
    (v) => { v.backupPublicKey = pem(weakRsa.publicKey); },
    (v) => { v.backupPublicKey = pem(rsa.privateKey); },
    (v) => { v.signingPublicKey = pem(ed.privateKey); },
    (v) => { v.rsaPrivatePem = 'PRIVATE FIXTURE DO NOT LEAK'; },
  ];
  const base = fixture();
  for (const mutate of mutations) {
    const value = { ...structuredClone(base), encrypted: Buffer.from(base.encrypted) }; mutate(value);
    assert.throws(() => createProofFromEncryptedBackup(value), /^Error: Local restart proof verification failed; private details suppressed\.$/u);
  }
});

test('strict tar requires checksums, three regular unique names, bounded complete bytes and PGDMP', () => {
  const good = archive(); assert.equal(inspectRestartTar(good).size, 3);
  const badHeader = (mutate) => {
    const value = Buffer.from(good); mutate(value.subarray(0, 512)); checksumHeader(value.subarray(0, 512)); return value;
  };
  for (const value of [
    good.subarray(0, good.length - 1024), good.subarray(0, good.length - 1), Buffer.concat([good, Buffer.from('junk')]),
    badHeader((h) => { h.write('../secret', 0, 100); }),
    badHeader((h) => { h[156] = 50; h.write('/private/target', 157, 100); }),
    badHeader((h) => { h[156] = 53; }), badHeader((h) => { h.write('prefix', 345, 155); }),
    badHeader((h) => { h.write('77777777777\0', 124, 12); }),
    badHeader((h) => { h.write('00000000000\0', 124, 12); }),
    tar([['roles.sql', Buffer.from('a')], ['roles.sql', Buffer.from('b')], ['database.dump', Buffer.from('PGDMP')]]),
    tar([['roles.sql', Buffer.from('a')], ['database.dump', Buffer.from('WRONG')], ['inventory.jsonl', Buffer.from('{}')]]),
  ]) assert.throws(() => inspectRestartTar(value));
  const checksum = Buffer.from(good); checksum[100] ^= 1; assert.throws(() => inspectRestartTar(checksum));
  const padding = Buffer.from(good); padding[1023] = 1; assert.throws(() => inspectRestartTar(padding));
  const trailing = Buffer.from(good); trailing[trailing.length - 1] = 1; assert.throws(() => inspectRestartTar(trailing));
});

test('authenticated inventory must prove exact13 and exactly one public.entitlements table with count1', () => {
  for (const mutate of [
    (rows) => rows.filter((r) => r.name !== 'entitlements'),
    (rows) => [...rows, structuredClone(rows.find((r) => r.name === 'entitlements'))],
    (rows) => { rows.find((r) => r.name === 'entitlements').count = 0; return rows; },
    (rows) => { rows.find((r) => r.name === 'entitlements').count = 2; return rows; },
    (rows) => { rows.find((r) => r.name === 'entitlements').count = '1'; return rows; },
    (rows) => { rows.find((r) => r.name === 'entitlements').schema = 'private'; return rows; },
    (rows) => { rows.find((r) => r.name === 'entitlements').sha256 = 'private-row-fixture'; return rows; },
    (rows) => { rows.find((r) => r.kind === 'history').versions = reconciledHistoryVersions.slice(0, 12); return rows; },
    (rows) => { rows.find((r) => r.name === 'objects').count = 1; return rows; },
  ]) assert.throws(() => createProofFromEncryptedBackup(fixture(archive(mutate(inventoryRecords())))), /private details suppressed/u);
});

test('private file and output boundaries reject symlinks, hardlinks, permissions, oversized files and overwrite', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'restart-proof-files-'));
  try {
    await chmod(directory, 0o700);
    assert.equal(await requirePrivateDirectory(directory), await import('node:fs/promises').then((fs) => fs.realpath(directory)));
    const key = path.join(directory, 'key.pem'); await writeFile(key, 'synthetic key', { mode: 0o600 });
    assert.equal((await readOwnerFile(key, 100)).toString(), 'synthetic key');
    await assert.rejects(readOwnerFile(key, 1));
    const keyLink = path.join(directory, 'key-link'); await symlink(key, keyLink); await assert.rejects(readOwnerFile(keyLink, 100));
    const hard = path.join(directory, 'hard'); await link(key, hard); await assert.rejects(readOwnerFile(key, 100)); await rm(hard);
    await chmod(key, 0o644); await assert.rejects(readOwnerFile(key, 100));
    await readOwnerFile(key, 100, { privateMode: false, makePrivate: true }); assert.equal((await lstat(key)).mode & 0o777, 0o600);
    const openDirectory = path.join(directory, 'open'); await mkdir(openDirectory, { mode: 0o755 }); await assert.rejects(requirePrivateDirectory(openDirectory));
    const dirLink = path.join(directory, 'dir-link'); await symlink(directory, dirLink); await assert.rejects(requirePrivateDirectory(dirLink));
    const output = path.join(directory, 'proof.json');
    const proof = createProofFromEncryptedBackup(fixture());
    await writeNewRestartProof(output, proof); assert.equal((await lstat(output)).mode & 0o777, 0o600);
    const original = await readFile(output); await assert.rejects(writeNewRestartProof(output, { changed: true })); assert.deepEqual(await readFile(output), original);
    const outputLink = path.join(directory, 'output-link'); await symlink(key, outputLink); await assert.rejects(writeNewRestartProof(outputLink, proof));
    await assert.rejects(writeNewRestartProof(path.join(openDirectory, 'proof.json'), proof));
    assert(!(await readdir(directory)).includes('plaintext'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('CLI permits only explicit fixed-scope arguments and subprocesses ignore unsafe ambient variables', () => {
  const args = ['--release-sha', releaseSha, '--backup-run-id', runId, '--artifact-id', artifactId,
    '--rsa-private-key', '/private/rsa.pem', '--signing-private-key', '/private/ed.pem', '--download-parent', '/private/downloads', '--output', '/private/proof.json'];
  assert.equal(parseRestartProofArguments(args)['backup-run-id'], runId);
  for (const bad of [args.slice(2), [...args, '--repository', 'wrong/repo'], ['--release-sha', releaseSha, ...args.slice(0, -2)],
    args.map((v) => v === runId ? '045' : v), args.map((v) => v === '/private/rsa.pem' ? 'relative.pem' : v)]) assert.throws(() => parseRestartProofArguments(bad));
  const env = restartSubprocessEnvironment({ GH_TOKEN: 'synthetic-github-token', NODE_OPTIONS: '--require=/evil', HTTPS_PROXY: 'https://evil', GH_HOST: 'evil', PATH: '/evil', BASH_ENV: '/evil', GIT_CONFIG_COUNT: '1' });
  assert.equal(env.GH_TOKEN, 'synthetic-github-token'); assert.equal(env.GH_HOST, 'github.com');
  for (const key of ['NODE_OPTIONS', 'HTTPS_PROXY', 'BASH_ENV', 'GIT_CONFIG_COUNT']) assert(!(key in env));
  assert(!env.PATH.includes('evil'));
});

test('entrypoint only downloads fixed-repository encrypted artifacts and checks main before exclusive proof publication', async () => {
  const source = await readFile(new URL('./prepare-production-canary-restart-proof.mjs', import.meta.url), 'utf8');
  assert.match(source, /const REPOSITORY = 'tjames222\/77-dominion-challenge'/u);
  assert.match(source, /mkdtemp\(path\.join\(parent, 'restart-backup-'\)\)/u);
  assert.match(source, /\['run', 'download', runId, '--repo', REPOSITORY, '--name', selected\.name, '--dir', directory\]/u);
  assert.match(source, /githubJson\('git\/ref\/heads\/main'\)/u);
  assert.match(source, /freshRun\.run_attempt === run\.run_attempt/u);
  assert.match(source, /mainRef\.object\?\.sha === releaseSha/u);
  assert(source.indexOf("githubJson('git/ref/heads/main')") < source.indexOf('const proofPath = await writeNewRestartProof'));
  assert(!/writeFile\([^\n]*(?:plaintext|inventory|roles|database)/u.test(source));
  assert.match(source, /for \(const bytes of \[rsaPrivatePem, signingPrivatePem\]\) bytes\?\.fill\(0\)/u);
  assert.match(source, /for \(const bytes of \[key, partial, final, plaintext\]\) bytes\?\.fill\(0\)/u);
});
