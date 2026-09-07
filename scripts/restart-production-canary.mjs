#!/usr/bin/env node
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PRODUCTION_SUPABASE_PROJECT_REF, verifyProductionAuthCanary } from './production-auth-canary-policy.mjs';
import { requireCleanNodeRuntimeEnvironment } from './prepare-existing-supabase-cli-state.mjs';
import { reconciledHistoryVersions } from './verify-production-migration-cutover-plan.mjs';
import { grantVerificationQuery, verifyGrantResponse } from './manage-production-canary-entitlement.mjs';
import { verifyBackupRun, selectBackupArtifact, verifyBackupManifest } from './verify-free-production-backup-evidence.mjs';
import { PRIOR_PRODUCTION_CANARY_RELEASE_SHA, PRODUCTION_CANARY_RESTART_PROOF_CONTRACT,
  validateRestartMetadata, verifyRestartProof } from './production-canary-restart-proof.mjs';

const repository = 'tjames222/77-dominion-challenge';
const releaseSentinel = '__RESTART_RELEASE_SHA__';
const fingerprintSentinel = '__RESTART_ENTITLEMENTS_SHA256__';
const uuidPattern = '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
const historyExpression = `(select coalesce(pg_catalog.array_agg(h.version::text order by h.version::text collate "C"), array[]::text[])
  from supabase_migrations.schema_migrations h) = array[${reconciledHistoryVersions.map(v => `'${v}'`).join(', ')}]::text[]`;

// Byte-for-byte serialization algorithm from free-backup-inventory.sql. All row
// columns participate; only this private hash crosses the read-only API boundary.
export const entitlementsFingerprintExpression = `(select pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
  coalesce(pg_catalog.string_agg(pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.to_jsonb(t)::text, 'UTF8')), 'hex'),
  '' order by pg_catalog.to_jsonb(t)::text collate "C"), ''), 'UTF8')), 'hex') from public.entitlements t)`;
const oldRowPredicate = `e.entitlement_key = 'membership_active'
  and e.status = 'revoked' and e.source_type = 'production_canary'
  and e.source_id ~ '${uuidPattern}'
  and e.starts_at is not null and e.ends_at is not null
  and e.ends_at > e.starts_at and e.ends_at - e.starts_at <= interval '2 hours'
  and e.ends_at <= pg_catalog.statement_timestamp()
  and e.metadata = pg_catalog.jsonb_build_object('release_sha', '${PRIOR_PRODUCTION_CANARY_RELEASE_SHA}')
  and exists (select 1 from auth.users u inner join public.profiles p on p.user_id = u.id
    where u.id = e.user_id and u.is_anonymous is false)`;
const invariantExpression = `(${historyExpression})
  and (select pg_catalog.count(*) from auth.users) = 1
  and (select pg_catalog.count(*) from auth.users where is_anonymous is false) = 1
  and (select pg_catalog.count(*) from public.profiles) = 1
  and (select pg_catalog.count(*) from auth.users u inner join public.profiles p on p.user_id = u.id where u.is_anonymous is false) = 1
  and (select pg_catalog.count(*) from public.entitlements) = 1
  and (select pg_catalog.count(*) from public.entitlements e where ${oldRowPredicate}) = 1
  and not exists (select 1 from public.billing_customers)
  and not exists (select 1 from public.subscriptions)
  and pg_catalog.to_regclass('public.purchases') is null`;

export const restartPreflightQuery = `select
  ($1::text ~ '^[0-9a-f]{40}$' and $1::text <> '${PRIOR_PRODUCTION_CANARY_RELEASE_SHA}') as release_sha_is_canonical,
  (pg_catalog.current_setting('TimeZone') = 'UTC' and pg_catalog.current_setting('DateStyle') in ('ISO, MDY', 'ISO, DMY', 'ISO, YMD')) as serialization_settings_match,
  (${invariantExpression}) as restart_invariants_match,
  (select pg_catalog.count(*)::text from public.entitlements) as entitlements_count,
  ${entitlementsFingerprintExpression} as entitlements_sha256;`;

export const restartCanaryQuery = `do $production_canary_restart$
declare
  target_release constant text := '${releaseSentinel}';
  expected_fingerprint constant text := '${fingerprintSentinel}';
  target_user uuid;
  grant_start timestamptz;
  changed_rows integer;
begin
  perform pg_catalog.set_config('lock_timeout', '5s', true);
  perform pg_catalog.set_config('statement_timeout', '30s', true);
  perform pg_catalog.set_config('search_path', 'pg_catalog, pg_temp', true);
  perform pg_catalog.set_config('TimeZone', 'UTC', true);
  perform pg_catalog.set_config('DateStyle', 'ISO, YMD', true);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('77-dominion:production-canary-entitlement', 0));
  if target_release !~ '^[0-9a-f]{40}$' or target_release = '${PRIOR_PRODUCTION_CANARY_RELEASE_SHA}'
    or expected_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'The restart bindings are invalid.';
  end if;
  lock table supabase_migrations.schema_migrations in share mode;
  lock table auth.users in share mode;
  lock table public.profiles, public.entitlements, public.billing_customers, public.subscriptions in share row exclusive mode;
  if not (${invariantExpression}) then
    raise exception 'The exact revoked prior-release checkpoint is required.';
  end if;
  if ${entitlementsFingerprintExpression} <> expected_fingerprint then
    raise exception 'The live checkpoint changed after recovery verification.';
  end if;
  select u.id into strict target_user from auth.users u
    inner join public.profiles p on p.user_id = u.id
    where u.is_anonymous is false for key share of u;
  grant_start := pg_catalog.clock_timestamp();
  update public.entitlements e set status = 'active', source_type = 'production_canary',
    source_id = pg_catalog.gen_random_uuid()::text, starts_at = grant_start,
    ends_at = grant_start + interval '2 hours',
    metadata = pg_catalog.jsonb_build_object('release_sha', target_release), updated_at = grant_start
  where e.user_id = target_user and ${oldRowPredicate};
  get diagnostics changed_rows = row_count;
  if changed_rows <> 1 then raise exception 'Expected exactly one audited canary replacement.'; end if;
end
$production_canary_restart$;`;

function fail() { throw new Error('Audited production canary restart failed; private details suppressed.'); }
function requireRelease(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/u.test(value) || value === PRIOR_PRODUCTION_CANARY_RELEASE_SHA) fail();
  return value;
}
export function buildRestartCanaryQuery(releaseSha, entitlementsSha256) {
  requireRelease(releaseSha);
  if (typeof entitlementsSha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(entitlementsSha256)) fail();
  return restartCanaryQuery.replace(releaseSentinel, releaseSha).replace(fingerprintSentinel, entitlementsSha256);
}
export function verifyRestartPreflightResponse(value) {
  const keys = ['release_sha_is_canonical', 'serialization_settings_match', 'restart_invariants_match', 'entitlements_count', 'entitlements_sha256'];
  if (!Array.isArray(value) || value.length !== 1 || !value[0] || typeof value[0] !== 'object'
    || JSON.stringify(Object.keys(value[0]).sort()) !== JSON.stringify(keys.sort())) fail();
  const row = value[0];
  if (row.release_sha_is_canonical !== true || row.serialization_settings_match !== true
    || row.restart_invariants_match !== true || row.entitlements_count !== '1'
    || typeof row.entitlements_sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(row.entitlements_sha256)) fail();
  return { count: 1, sha256: row.entitlements_sha256 };
}
export function parseRestartCanaryArguments(args) {
  if (!Array.isArray(args) || args.length !== 2 || args[0] !== '--backup-directory'
    || typeof args[1] !== 'string' || args[1].length === 0 || args[1].startsWith('-')) fail();
  return { backupDirectory: path.resolve(args[1]) };
}
async function loadBackup(directory) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) fail();
  const dir = await lstat(directory);
  if (!dir.isDirectory() || dir.isSymbolicLink() || await realpath(directory) !== directory
    || (dir.mode & 0o022) !== 0 || dir.uid !== process.getuid()) fail();
  if (JSON.stringify((await readdir(directory)).sort()) !== JSON.stringify(['backup-manifest.json', 'backup.enc'])) fail();
  const values = [];
  for (const [name, limit] of [['backup-manifest.json', 16384], ['backup.enc', 50 * 1024 * 1024]]) {
    const handle = await open(path.join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size < 1 || stat.size > limit
        || stat.uid !== process.getuid() || (stat.mode & 0o022) !== 0) fail();
      const bytes = await handle.readFile();
      if (bytes.length !== stat.size) fail();
      values.push(bytes);
    } finally { await handle.close(); }
  }
  return { manifest: JSON.parse(values[0].toString('utf8')), encrypted: values[1] };
}
async function discard(response) { try { await response?.body?.cancel(); } catch { /* Never inspect private error bodies. */ } }

export async function restartProductionCanary({ backupDirectory, environment = process.env,
  fetchImpl = globalThis.fetch, authVerifier = verifyProductionAuthCanary, now = Date.now,
  signalFactory = () => AbortSignal.timeout(30_000) } = {}) {
  try {
    requireCleanNodeRuntimeEnvironment(environment);
    for (const name of ['NODE_DEBUG', 'NODE_DEBUG_NATIVE', 'NODE_USE_ENV_PROXY']) {
      if (typeof environment[name] === 'string' && environment[name].length > 0) fail();
    }
    const releaseSha = requireRelease(environment.GITHUB_SHA), runId = environment.BACKUP_RUN_ID;
    if (typeof runId !== 'string' || !/^[1-9][0-9]{0,15}$/u.test(runId)
      || environment.SUPABASE_PROJECT_REF !== PRODUCTION_SUPABASE_PROJECT_REF) fail();
    for (const token of [environment.GH_TOKEN, environment.SUPABASE_ACCESS_TOKEN]) {
      if (typeof token !== 'string' || !token || /[\u0000-\u0020\u007f]/u.test(token)) fail();
    }
    if (typeof fetchImpl !== 'function' || typeof authVerifier !== 'function' || typeof now !== 'function' || typeof signalFactory !== 'function') fail();
    const proof = JSON.parse(environment.PRODUCTION_CANARY_RESTART_RECOVERY_PROOF);
    const { manifest, encrypted } = await loadBackup(backupDirectory);
    const githubJson = async endpoint => {
      const response = await fetchImpl(`https://api.github.com/repos/${repository}${endpoint}`, {
        method: 'GET', headers: { Authorization: `Bearer ${environment.GH_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
        cache: 'no-store', redirect: 'error', signal: signalFactory(),
      });
      if (response?.status !== 200 || response.redirected) { await discard(response); fail(); }
      return response.json();
    };
    const run = verifyBackupRun(await githubJson(`/actions/runs/${runId}`), { runId, releaseCommit: releaseSha, nowMs: now() });
    const artifact = selectBackupArtifact(await githubJson(`/actions/runs/${runId}/artifacts?per_page=100`), { runId, releaseCommit: releaseSha, nowMs: now() });
    const mainRef = await githubJson('/git/ref/heads/main');
    if (mainRef?.ref !== 'refs/heads/main' || mainRef.object?.type !== 'commit' || mainRef.object.sha !== releaseSha) fail();
    if (![run.id, run.repository.id, run.head_repository.id].every(id => Number.isSafeInteger(id) && id > 0)
      || artifact.workflow_run?.id !== run.id || artifact.workflow_run?.head_sha !== releaseSha
      || artifact.workflow_run?.head_branch !== 'main' || artifact.workflow_run?.repository_id !== run.repository.id
      || artifact.workflow_run?.head_repository_id !== run.head_repository.id || manifest.runAttempt !== run.run_attempt) fail();
    verifyBackupManifest(manifest, encrypted, { runId, releaseCommit: releaseSha, publicKey: environment.PRODUCTION_BACKUP_PUBLIC_KEY, nowMs: now() });
    const metadata = validateRestartMetadata({ schemaVersion: 1, artifactContract: PRODUCTION_CANARY_RESTART_PROOF_CONTRACT,
      priorReleaseSha: PRIOR_PRODUCTION_CANARY_RELEASE_SHA, releaseSha, backupRunId: runId, backupRunAttempt: run.run_attempt,
      artifactId: String(artifact.id), encryptedSha256: manifest.encryptedSha256,
      publicKeySha256: manifest.publicKeySha256, createdAt: manifest.createdAt });
    await authVerifier({ accessToken: environment.SUPABASE_ACCESS_TOKEN, projectRef: PRODUCTION_SUPABASE_PROJECT_REF, fetchImpl, signalFactory });
    const query = async (sql, readOnly) => {
      const response = await fetchImpl(`https://api.supabase.com/v1/projects/${PRODUCTION_SUPABASE_PROJECT_REF}/database/query${readOnly ? '/read-only' : ''}`, {
        method: 'POST', headers: { Authorization: `Bearer ${environment.SUPABASE_ACCESS_TOKEN}`, Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: sql, parameters: readOnly ? [releaseSha] : [] }), cache: 'no-store', redirect: 'error', signal: signalFactory(),
      });
      if (response?.status !== 201 || response.redirected) { await discard(response); fail(); }
      if (!readOnly) { await discard(response); return undefined; }
      return response.json();
    };
    const entitlementsFingerprint = verifyRestartPreflightResponse(await query(restartPreflightQuery, true));
    verifyRestartProof({ proof, entitlementsFingerprint, signingPublicKey: environment.PRODUCTION_CANARY_RESTART_PUBLIC_KEY,
      expectedMetadata: metadata, nowMs: now() });
    await query(buildRestartCanaryQuery(releaseSha, entitlementsFingerprint.sha256), false);
    verifyGrantResponse(await query(grantVerificationQuery, true));
    return { operation: 'restart', verified: true };
  } catch { fail(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  Promise.resolve().then(() => restartProductionCanary(parseRestartCanaryArguments(process.argv.slice(2))))
    .then(() => console.log('Verified one audited, backup-bound production canary restart for this release.'))
    .catch(() => { console.error('Audited production canary restart failed; private details suppressed.'); process.exitCode = 1; });
}
