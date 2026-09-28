import { pathToFileURL } from 'node:url';
import { PRODUCTION_SUPABASE_PROJECT_REF } from './production-auth-canary-policy.mjs';

export const EARLY_ACCESS_WORKER_SCHEDULE = '*/5 * * * *';
export const EARLY_ACCESS_WORKER_TIMEOUT_MS = 55000;
export const FREE_EMAIL_QUOTA_SOURCE_MD5 = '4fef160b1726aede6a9777bb3097ee04';
const PROJECT_SECRET = 'early_access_project_url';
const FEEDBACK_SECRET = 'early_access_feedback_worker_secret';
const INVITATION_SECRET = 'early_access_invitation_worker_secret';
const LOCK = "pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('77-dominion:early-access-workers-cron',0))";
const JOBS = Object.freeze([
  Object.freeze({ name: 'process-early-access-feedback', secret: FEEDBACK_SECRET }),
  Object.freeze({ name: 'process-early-access-invitations', secret: INVITATION_SECRET }),
]);
const TABLES = "'transactional_email_reservations','early_access_feedback_deliveries','early_access_invitation_deliveries','early_access_account_bootstraps','early_access_account_setup_deliveries'";
// Fingerprint the reviewed existing quota function, not merely the presence of
// numbers in its source. The operator never replaces it or raises its allowance.
const QUOTA_POLICY = `exists(select 1 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
  where n.nspname='private' and p.proname='reserve_transactional_email'
    and pg_catalog.pg_get_function_identity_arguments(p.oid)='target_delivery_id uuid'
    and p.prosecdef and p.proconfig @> array['search_path=""']
    and pg_catalog.md5(p.prosrc)='${FREE_EMAIL_QUOTA_SOURCE_MD5}'
    and not pg_catalog.has_function_privilege('anon',p.oid,'EXECUTE')
    and not pg_catalog.has_function_privilege('authenticated',p.oid,'EXECUTE')
    and not pg_catalog.has_function_privilege('service_role',p.oid,'EXECUTE'))`;
const WORKER_FENCES = `(select count(*)=3 and bool_and(p.prosecdef
    and pg_catalog.strpos(p.prosrc,'private.reserve_transactional_email(')>0
    and not pg_catalog.has_function_privilege('anon',p.oid,'EXECUTE')
    and not pg_catalog.has_function_privilege('authenticated',p.oid,'EXECUTE')
    and pg_catalog.has_function_privilege('service_role',p.oid,'EXECUTE'))
  from pg_catalog.pg_proc p where p.oid in (
    pg_catalog.to_regprocedure('public.mark_early_access_feedback_dispatched(uuid,uuid,text)'),
    pg_catalog.to_regprocedure('public.mark_early_access_invitation_dispatched(uuid,uuid,text,text)'),
    pg_catalog.to_regprocedure('public.mark_early_access_account_setup_dispatched(uuid,uuid,text)')))`;
const QUEUE_PERMISSIONS = `(select count(*)=5 and bool_and(c.relrowsecurity
    and not pg_catalog.has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    and not pg_catalog.has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    and not pg_catalog.has_table_privilege('service_role',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))
  from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
  where n.nspname='private' and c.relname in (${TABLES}))`;
const EXTENSIONS = `(select count(*)=3 from pg_catalog.pg_extension e join pg_catalog.pg_namespace n on n.oid=e.extnamespace
  where (e.extname,n.nspname) in (('pg_cron','pg_catalog'),('pg_net','extensions'),('supabase_vault','vault')))`;
export const EARLY_ACCESS_WORKER_EXTENSION_QUERY = `do $early_access_extensions$
begin
  perform pg_catalog.set_config('lock_timeout','5s',true);
  perform pg_catalog.set_config('statement_timeout','30s',true);
  perform ${LOCK};
  if not coalesce(${QUOTA_POLICY} and ${WORKER_FENCES} and ${QUEUE_PERMISSIONS},false) then
    raise exception 'Early Access delivery authority is not ready'; end if;
  execute 'create extension if not exists pg_cron with schema pg_catalog';
  execute 'create extension if not exists pg_net with schema extensions';
  if not ${EXTENSIONS} then raise exception 'Early Access Cron extensions do not match'; end if;
end
$early_access_extensions$;`;

function cronCommand(job) {
  return `select net.http_post(
  url := pg_catalog.rtrim((select decrypted_secret from vault.decrypted_secrets where name='${PROJECT_SECRET}'),'/') || '/functions/v1/${job.name}',
  headers := pg_catalog.jsonb_build_object('Content-Type','application/json','x-dominion-worker-key',
    (select decrypted_secret from vault.decrypted_secrets where name='${job.secret}')),
  body := '{}'::jsonb,
  timeout_milliseconds := ${EARLY_ACCESS_WORKER_TIMEOUT_MS}
) as request_id;`;
}
export const EARLY_ACCESS_WORKER_COMMANDS = Object.freeze(JOBS.map(cronCommand));
function secretCtes(prefix, name, parameter, previous) {
  const description = `Production Early Access ${prefix} Cron configuration`;
  return `${prefix}_existing as materialized (
  select s.id,s.decrypted_secret,s.description from vault.decrypted_secrets s cross join ${previous} where s.name='${name}'
), ${prefix}_updated as materialized (
  select vault.update_secret(id,$${parameter}::text,'${name}','${description}') as result from ${prefix}_existing
  where decrypted_secret is distinct from $${parameter}::text or description is distinct from '${description}'
), ${prefix}_inserted as materialized (
  select vault.create_secret($${parameter}::text,'${name}','${description}') as id from ${previous}
  where not exists(select 1 from ${prefix}_existing)
), ${prefix}_complete as materialized (
  select (select count(*) from ${prefix}_updated)+(select count(*) from ${prefix}_inserted) as writes
)`;
}
const JOB_VALUES = JOBS.map((job, index) => `('${job.name}',$early_access_job$${EARLY_ACCESS_WORKER_COMMANDS[index]}$early_access_job$)`).join(',\n');
export const CONFIGURE_EARLY_ACCESS_WORKERS_QUERY = `with settings as materialized (
  select pg_catalog.set_config('lock_timeout','5s',true),pg_catalog.set_config('statement_timeout','30s',true)
), locked as materialized (select ${LOCK} from settings),
${secretCtes('project', PROJECT_SECRET, 1, 'locked')},
${secretCtes('feedback', FEEDBACK_SECRET, 2, 'project_complete')},
${secretCtes('invitation', INVITATION_SECRET, 3, 'feedback_complete')},
scheduled as materialized (
  select cron.schedule(j.name,'${EARLY_ACCESS_WORKER_SCHEDULE}',j.command) as job_id from (values
${JOB_VALUES}
  ) as j(name,command) cross join invitation_complete
), activated as materialized (
  select cron.alter_job(job_id:=scheduled.job_id,active:=true) from scheduled
)
select (select count(*) from activated)=2 and count(*)=2 and min(job_id)>0 as configured from scheduled;`;

export const VERIFY_EARLY_ACCESS_WORKERS_QUERY = `with expected_secrets(name,value) as (values
  ('${PROJECT_SECRET}',$1::text),('${FEEDBACK_SECRET}',$2::text),('${INVITATION_SECRET}',$3::text)
), expected_jobs(name,command) as (values
${JOB_VALUES}
), secrets as (
  select count(*) as secret_count,count(distinct s.name)=3 and coalesce(bool_and(s.decrypted_secret=e.value),false) as secret_values_match
  from vault.decrypted_secrets s join expected_secrets e on e.name=s.name
), jobs as (
  select count(*) as job_count,coalesce(bool_and(j.schedule='${EARLY_ACCESS_WORKER_SCHEDULE}' and j.active and j.command=e.command
    and j.username=current_user and j.database=current_database()),false) as job_policy_matches,
    coalesce(bool_and(j.command !~* 'https?://' and not exists(select 1 from expected_secrets s where pg_catalog.strpos(j.command,s.value)>0)),false) as no_embedded_credentials
  from cron.job j join expected_jobs e on e.name=j.jobname
)
select ${EXTENSIONS} as extensions_match,${QUOTA_POLICY} as quota_policy_matches,${WORKER_FENCES} as worker_fences_match,
  ${QUEUE_PERMISSIONS} as queue_permissions_match,secrets.secret_count::integer,secrets.secret_values_match,
  jobs.job_count::integer,jobs.job_policy_matches,jobs.no_embedded_credentials from secrets cross join jobs;`;
const VERIFICATION_KEYS = ['extensions_match','quota_policy_matches','worker_fences_match','queue_permissions_match',
  'secret_count','secret_values_match','job_count','job_policy_matches','no_embedded_credentials'].sort();
const fail = () => new Error('Production Early Access worker scheduling could not be verified.');
function exactRecord(value, keys) {
  if (!value || typeof value !== 'object' || ![Object.prototype,null].includes(Object.getPrototypeOf(value))
    || Reflect.ownKeys(value).length !== keys.length) throw fail();
  const result = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value,key);
    if (!descriptor || !Object.hasOwn(descriptor,'value')) throw fail();
    result[key] = descriptor.value;
  }
  return result;
}
export function parseEarlyAccessWorkerVerification(value) {
  try {
    if (!Array.isArray(value) || value.length !== 1) throw fail();
    const row = exactRecord(value[0],VERIFICATION_KEYS);
    if (row.secret_count !== 3 || row.job_count !== 2
      || VERIFICATION_KEYS.some(key => !key.endsWith('_count') && row[key] !== true)) throw fail();
    return true;
  } catch { throw fail(); }
}
async function managementQuery({ accessToken, fetchImplementation, query, parameters, requestTimeoutMs }) {
  const controller = new AbortController(); let reader; let timer;
  const deadline = new Promise((resolve,reject) => { timer = setTimeout(() => { controller.abort(); reject(fail()); },requestTimeoutMs); });
  const work = async () => {
    const response = await fetchImplementation(`https://api.supabase.com/v1/projects/${PRODUCTION_SUPABASE_PROJECT_REF}/database/query`, {
      method:'POST',headers:{ Authorization:`Bearer ${accessToken}`,Accept:'application/json','Content-Type':'application/json' },
      body:JSON.stringify({ query,parameters,read_only:false }),cache:'no-store',redirect:'error',signal:controller.signal,
    });
    if (controller.signal.aborted || response?.status !== 201 || response.redirected || !response.body) {
      void response?.body?.cancel().catch(() => {}); throw fail();
    }
    reader=response.body.getReader(); const chunks=[];let bytes=0;
    while (true) {
      if (controller.signal.aborted) throw fail();
      const { done,value }=await reader.read();if(done)break;
      bytes+=value.byteLength;if(bytes>65536)throw fail();chunks.push(value);
    }
    if (controller.signal.aborted) throw fail();
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  };
  try { return await Promise.race([work(),deadline]); }
  catch { throw fail(); }
  finally { clearTimeout(timer);controller.abort();if(reader){void reader.cancel().catch(()=>{});reader.releaseLock();} }
}
export async function configureProductionEarlyAccessWorkers({
  accessToken=process.env.SUPABASE_ACCESS_TOKEN,projectRef=process.env.SUPABASE_PROJECT_REF,
  projectUrl=process.env.VITE_SUPABASE_URL,feedbackWorkerSecret=process.env.FEEDBACK_WORKER_SECRET,
  invitationWorkerSecret=process.env.EARLY_ACCESS_INVITATION_WORKER_SECRET,
  fetchImplementation=globalThis.fetch,requestTimeoutMs=30000,
}={}) {
  const secret=value=>typeof value==='string' && /^[\x21-\x7e]{32,512}$/.test(value);
  if(projectRef!==PRODUCTION_SUPABASE_PROJECT_REF || projectUrl!==`https://${PRODUCTION_SUPABASE_PROJECT_REF}.supabase.co`
    || typeof accessToken!=='string' || !/^[\x21-\x7e]{1,4096}$/.test(accessToken)
    || !secret(feedbackWorkerSecret) || !secret(invitationWorkerSecret) || feedbackWorkerSecret===invitationWorkerSecret
    || typeof fetchImplementation!=='function' || !Number.isInteger(requestTimeoutMs) || requestTimeoutMs<1 || requestTimeoutMs>30000)throw fail();
  const call=(query,parameters)=>managementQuery({accessToken,fetchImplementation,query,parameters,requestTimeoutMs});
  const extensions=await call(EARLY_ACCESS_WORKER_EXTENSION_QUERY,[]);
  if(!Array.isArray(extensions)||extensions.length!==0)throw fail();
  const parameters=[projectUrl,feedbackWorkerSecret,invitationWorkerSecret];
  const configured=await call(CONFIGURE_EARLY_ACCESS_WORKERS_QUERY,parameters);
  if(!Array.isArray(configured)||configured.length!==1||exactRecord(configured[0],['configured']).configured!==true)throw fail();
  // Keep the privileged connection for this fixed SELECT; read_only changes to
  // a role that must not be granted access to decrypt Vault or read queues.
  parseEarlyAccessWorkerVerification(await call(VERIFY_EARLY_ACCESS_WORKERS_QUERY,parameters));
  return Object.freeze({ configured:true,jobs:2,schedule:EARLY_ACCESS_WORKER_SCHEDULE,workerTimeoutMs:EARLY_ACCESS_WORKER_TIMEOUT_MS });
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  configureProductionEarlyAccessWorkers().then(()=>console.log('Two Early Access workers scheduled every five minutes; Vault, authority and free-quota policy verified.'))
    .catch(()=>{console.error('Production Early Access worker scheduling could not be verified.');process.exitCode=1;});
}
