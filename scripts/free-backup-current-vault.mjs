import { PROFILE_PHOTO_CLEANUP_CRON_COMMAND } from './configure-production-profile-photo-cleanup-cron.mjs';

export const CURRENT_BACKUP_MODE = 'current-production-2026-09-27';
export const LEGACY_BACKUP_MODE = 'legacy-thirteen-migration-cutover';
export const CURRENT_BACKUP_VAULT_NAMES = Object.freeze(['profile_photo_project_url', 'profile_photo_worker_secret']);
const PROJECT_URL = 'https://mimolwojppbtsbvtqwpo.supabase.co';
const fail = () => { throw Object.assign(new Error('Current backup Vault contract failed.'), { diagnosticCode: 'current-vault-contract' }); };
const base64 = value => Buffer.from(value, 'utf8').toString('base64');
function parameters(workerSecret) {
  if (typeof workerSecret !== 'string' || !/^[\x21-\x7e]{32,4096}$/.test(workerSecret)) fail();
  // Only base64 characters reach psql meta-command arguments. The server uses
  // extended-protocol parameters, not SQL or psql-variable interpolation.
  return `'${base64(PROJECT_URL)}' '${base64(workerSecret)}'`;
}
const expected = `select convert_from(decode($1,'base64'),'UTF8') as project_url,
  convert_from(decode($2,'base64'),'UTF8') as worker_secret`;
const exactMetadata = `(select count(*)=2 and count(distinct name)=2
  and bool_and(name in ('profile_photo_project_url','profile_photo_worker_secret') and key_id is null)
  from vault.secrets)`;
const exactValues = `(select count(*)=2 and coalesce(bool_and(case name
  when 'profile_photo_project_url' then decrypted_secret=expected.project_url
  when 'profile_photo_worker_secret' then decrypted_secret=expected.worker_secret
  else false end),false) from vault.decrypted_secrets cross join expected)`;
const settings = String.raw`\set ON_ERROR_STOP on
\set ECHO none
\set VERBOSITY terse
\pset format unaligned
\pset tuples_only on
\pset pager off
`;

/** Read-only source proof, bound to the exact ciphertext inventory being saved. */
export function currentBackupVaultProofSql(workerSecret, ciphertextInventorySha256) {
  if (typeof ciphertextInventorySha256 !== 'string' || !/^[a-f0-9]{64}$/.test(ciphertextInventorySha256)) fail();
  const bound = parameters(workerSecret);
  return `${settings}BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL search_path=pg_catalog;
SET LOCAL statement_timeout='30s';
SET LOCAL timezone='UTC';
SET LOCAL datestyle='ISO, YMD';
WITH expected AS MATERIALIZED (${expected})
SELECT coalesce(current_user='postgres' and current_setting('transaction_read_only')='on'
  and ${exactMetadata} and ${exactValues}
  and not exists(select 1 from pg_constraint where contype='f' and confrelid='vault.secrets'::regclass)
  and (select encode(sha256(convert_to(coalesce(string_agg(encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex'),'' ORDER BY to_jsonb(t)::text COLLATE "C"),''),'UTF8')),'hex') from vault.secrets t)=$3
  and (select count(*)=1 and bool_and(jobname='process-profile-photo-cleanup'
    and command=convert_from(decode($4,'base64'),'UTF8') and schedule='*/5 * * * *'
    and active and username='postgres' and database='postgres') from cron.job),false)
\\bind ${bound} '${ciphertextInventorySha256}' '${base64(PROFILE_PHOTO_CLEANUP_CRON_COMMAND)}'
\\g
ROLLBACK;
`;
}

/** Never run on a hosted connection. This refuses before the first write unless
 * the exact disposable socket/admin/no-network/no-Cron runtime is present. */
export function currentBackupLocalVaultRecoverySql(workerSecret) {
  const bound = parameters(workerSecret);
  return `${settings}BEGIN;
SET LOCAL search_path=pg_catalog;
SET LOCAL statement_timeout='30s';
DO $local_only$
BEGIN
  IF current_user<>'backup_restore_admin' OR current_database()<>'postgres'
    OR inet_server_addr() IS NOT NULL
    OR current_setting('unix_socket_directories')<>'/restore'
    OR current_setting('listen_addresses')<>''
    OR current_setting('cron.launch_active_jobs')<>'off'
    OR NOT coalesce(${exactMetadata},false)
    OR EXISTS(select 1 from pg_constraint where contype='f' and confrelid='vault.secrets'::regclass) THEN
    RAISE EXCEPTION 'Refused non-isolated or unexpected Vault reconstruction';
  END IF;
END
$local_only$;
WITH expected AS MATERIALIZED (${expected}), removed AS (
  DELETE FROM vault.secrets s
  WHERE s.name IN ('profile_photo_project_url','profile_photo_worker_secret')
  RETURNING s.name,s.description
), recreated AS MATERIALIZED (
  SELECT vault.create_secret(case s.name when 'profile_photo_project_url'
    then expected.project_url else expected.worker_secret end,s.name,s.description)
  FROM removed s CROSS JOIN expected
)
SELECT count(*) FROM recreated
\\bind ${bound}
\\g
WITH expected AS MATERIALIZED (${expected})
SELECT coalesce(${exactMetadata} and ${exactValues},false)
\\bind ${bound}
\\g
ROLLBACK;
`;
}

export function requireCurrentBackupVaultProof(output) {
  if (output !== 't') fail();
}
export function requireCurrentBackupLocalVaultRecovery(output) {
  if (output !== '2\nt') fail();
}
export function currentBackupVaultRecoveryManifest() {
  return {
    selfContained: false,
    source: 'protected-github-production-settings',
    requiredSettings: ['VITE_SUPABASE_URL', 'PROFILE_PHOTO_WORKER_SECRET'],
    secretNames: [...CURRENT_BACKUP_VAULT_NAMES],
    originalCiphertextPreserved: true,
    freshKeyReconstructionVerified: true,
    recoveryRequiresProtectedSettings: true,
  };
}
