import { PROFILE_PHOTO_CLEANUP_CRON_COMMAND } from './configure-production-profile-photo-cleanup-cron.mjs';
import { EARLY_ACCESS_WORKER_COMMANDS } from './configure-production-early-access-workers.mjs';

export const POST_EARLY_ACCESS_BACKUP_MODE = 'post-early-access-66';
export const POST_EARLY_ACCESS_VAULT_NAMES = Object.freeze([
  'profile_photo_project_url', 'profile_photo_worker_secret', 'early_access_project_url',
  'early_access_feedback_worker_secret', 'early_access_invitation_worker_secret',
]);
const PROJECT_URL = 'https://mimolwojppbtsbvtqwpo.supabase.co';
const WORKER_DATABASE = 'dominion_backup_disabled';
const SECRET_FIELDS = ['feedbackWorkerSecret', 'invitationWorkerSecret', 'profilePhotoWorkerSecret'];
const fail = () => { throw Object.assign(new Error('Post-Early-Access backup Vault contract failed.'), { diagnosticCode: 'post-early-access-vault-contract' }); };
const base64 = value => Buffer.from(value, 'utf8').toString('base64');
function parameters(secrets) {
  if (!secrets || typeof secrets !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(secrets))
    || Reflect.ownKeys(secrets).length !== SECRET_FIELDS.length) fail();
  const values = {};
  for (const name of SECRET_FIELDS) {
    const descriptor = Object.getOwnPropertyDescriptor(secrets, name);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail();
    const value = descriptor.value;
    const pattern = name === 'profilePhotoWorkerSecret' ? /^[\x21-\x7e]{32,4096}$/ : /^[\x21-\x7e]{32,512}$/;
    if (typeof value !== 'string' || !pattern.test(value)) fail();
    values[name] = value;
  }
  if (values.feedbackWorkerSecret === values.invitationWorkerSecret) fail();
  // Only base64 characters reach psql meta-command arguments. Actual values
  // use the extended protocol, never SQL or psql-variable interpolation.
  return [PROJECT_URL, values.profilePhotoWorkerSecret, values.feedbackWorkerSecret, values.invitationWorkerSecret]
    .map(value => `'${base64(value)}'`).join(' ');
}
const expected = `values
  ('profile_photo_project_url',convert_from(decode($1,'base64'),'UTF8')),
  ('profile_photo_worker_secret',convert_from(decode($2,'base64'),'UTF8')),
  ('early_access_project_url',convert_from(decode($1,'base64'),'UTF8')),
  ('early_access_feedback_worker_secret',convert_from(decode($3,'base64'),'UTF8')),
  ('early_access_invitation_worker_secret',convert_from(decode($4,'base64'),'UTF8'))`;
const exactMetadata = `(select count(*)=5 and count(distinct name)=5
  and bool_and(name in ('profile_photo_project_url','profile_photo_worker_secret','early_access_project_url',
    'early_access_feedback_worker_secret','early_access_invitation_worker_secret') and key_id is null)
  from vault.secrets)`;
const exactValues = `(select count(*)=5 and coalesce(bool_and(s.decrypted_secret=e.value),false)
  from vault.decrypted_secrets s join expected e on e.name=s.name)`;
const settings = String.raw`\set ON_ERROR_STOP on
\set ECHO none
\set VERBOSITY terse
\pset format unaligned
\pset tuples_only on
\pset pager off
`;

/** Read-only source proof for this exact five-setting, three-job checkpoint. */
export function postEarlyAccessVaultProofSql(secrets, ciphertextInventorySha256) {
  if (typeof ciphertextInventorySha256 !== 'string' || !/^[a-f0-9]{64}$/.test(ciphertextInventorySha256)) fail();
  const bound = parameters(secrets);
  const commands = [PROFILE_PHOTO_CLEANUP_CRON_COMMAND, ...EARLY_ACCESS_WORKER_COMMANDS];
  return `${settings}BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL search_path=pg_catalog;
SET LOCAL statement_timeout='30s';
SET LOCAL timezone='UTC';
SET LOCAL datestyle='ISO, YMD';
WITH expected(name,value) AS MATERIALIZED (${expected}), expected_jobs(name,command) AS (values
  ('process-profile-photo-cleanup',convert_from(decode($6,'base64'),'UTF8')),
  ('process-early-access-feedback',convert_from(decode($7,'base64'),'UTF8')),
  ('process-early-access-invitations',convert_from(decode($8,'base64'),'UTF8')))
SELECT coalesce(current_user='postgres' and current_setting('transaction_read_only')='on'
  and ${exactMetadata} and ${exactValues}
  and not exists(select 1 from pg_constraint where contype='f' and confrelid='vault.secrets'::regclass)
  and (select encode(sha256(convert_to(coalesce(string_agg(encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex'),'' ORDER BY to_jsonb(t)::text COLLATE "C"),''),'UTF8')),'hex') from vault.secrets t)=$5
  and (select count(*)=3 and count(distinct j.jobname)=3 and coalesce(bool_and(e.name is not null
    and j.command=e.command and j.schedule='*/5 * * * *' and j.active
    and j.username='postgres' and j.database='postgres'),false)
    from cron.job j left join expected_jobs e on e.name=j.jobname),false)
\\bind ${bound} '${ciphertextInventorySha256}' ${commands.map(value => `'${base64(value)}'`).join(' ')}
\\g
ROLLBACK;
`;
}

/** Disposable-only fresh-key proof. Every fence precedes the first write. */
export function postEarlyAccessLocalVaultRecoverySql(secrets) {
  const bound = parameters(secrets);
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
    OR current_setting('max_worker_processes')<>'0'
    OR current_setting('pg_net.batch_size')<>'0'
    OR current_setting('pg_net.database_name')<>'${WORKER_DATABASE}'
    OR EXISTS(select 1 from pg_database where datname='${WORKER_DATABASE}')
    OR EXISTS(select 1 from pg_stat_activity where backend_type ilike '%pg_net%' or backend_type ilike '%cron%')
    OR NOT coalesce(${exactMetadata},false)
    OR EXISTS(select 1 from pg_constraint where contype='f' and confrelid='vault.secrets'::regclass) THEN
    RAISE EXCEPTION 'Refused non-isolated or unexpected Vault reconstruction';
  END IF;
END
$local_only$;
WITH expected(name,value) AS MATERIALIZED (${expected}), removed AS (
  DELETE FROM vault.secrets s USING expected e WHERE s.name=e.name
  RETURNING s.name,s.description
), recreated AS MATERIALIZED (
  SELECT vault.create_secret(e.value,s.name,s.description)
  FROM removed s JOIN expected e ON e.name=s.name
)
SELECT count(*) FROM recreated
\\bind ${bound}
\\g
WITH expected(name,value) AS MATERIALIZED (${expected})
SELECT coalesce(${exactMetadata} and ${exactValues},false)
\\bind ${bound}
\\g
ROLLBACK;
`;
}

export function requirePostEarlyAccessVaultProof(output) {
  if (output !== 't') fail();
}
export function requirePostEarlyAccessLocalVaultRecovery(output) {
  if (output !== '5\nt') fail();
}
export function postEarlyAccessVaultRecoveryManifest() {
  return {
    selfContained: false,
    source: 'protected-github-production-settings',
    requiredSettings: ['VITE_SUPABASE_URL', 'PROFILE_PHOTO_WORKER_SECRET', 'FEEDBACK_WORKER_SECRET', 'EARLY_ACCESS_INVITATION_WORKER_SECRET'],
    secretNames: [...POST_EARLY_ACCESS_VAULT_NAMES],
    originalCiphertextPreserved: true,
    freshKeyReconstructionVerified: true,
    recoveryRequiresProtectedSettings: true,
  };
}
