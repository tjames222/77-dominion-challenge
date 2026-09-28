import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  CONFIGURE_EARLY_ACCESS_WORKERS_QUERY,configureProductionEarlyAccessWorkers,
  EARLY_ACCESS_WORKER_COMMANDS,EARLY_ACCESS_WORKER_EXTENSION_QUERY,EARLY_ACCESS_WORKER_SCHEDULE,
  EARLY_ACCESS_WORKER_TIMEOUT_MS,FREE_EMAIL_QUOTA_SOURCE_MD5,parseEarlyAccessWorkerVerification,
  VERIFY_EARLY_ACCESS_WORKERS_QUERY,
} from './configure-production-early-access-workers.mjs';
import { PRODUCTION_SUPABASE_PROJECT_REF } from './production-auth-canary-policy.mjs';
const projectRef=PRODUCTION_SUPABASE_PROJECT_REF;
const projectUrl=`https://${projectRef}.supabase.co`;
const accessToken='SYNTHETIC_PRIVATE_MANAGEMENT_TOKEN';
const feedbackWorkerSecret='SYNTHETIC_PRIVATE_FEEDBACK_WORKER_SECRET_0001';
const invitationWorkerSecret='SYNTHETIC_PRIVATE_INVITATION_WORKER_SECRET_0002';
const MESSAGE='Production Early Access worker scheduling could not be verified.';
const verification=(patch={})=>({extensions_match:true,quota_policy_matches:true,worker_fences_match:true,queue_permissions_match:true,
  secret_count:3,secret_values_match:true,job_count:2,job_policy_matches:true,no_embedded_credentials:true,...patch});
const denied=promise=>assert.rejects(promise,error=>{assert.equal(error.message,MESSAGE);assert.equal(error.cause,undefined);return true;});
function fixture(){
  const calls=[];const replies=[[],[{configured:true}],[verification()]];
  const options={accessToken,projectRef,projectUrl,feedbackWorkerSecret,invitationWorkerSecret,requestTimeoutMs:100,
    fetchImplementation:async(url,init)=>{calls.push({url,init});return Response.json(replies[calls.length-1],{status:201});}};
  return{calls,replies,options};
}
test('operator prepares extensions then parameterized Vault/two jobs and strict privileged read-back',async()=>{
  const f=fixture();assert.deepEqual(await configureProductionEarlyAccessWorkers(f.options),{
    configured:true,jobs:2,schedule:'*/5 * * * *',workerTimeoutMs:55000});assert.equal(f.calls.length,3);
  const expectedQueries=[EARLY_ACCESS_WORKER_EXTENSION_QUERY,CONFIGURE_EARLY_ACCESS_WORKERS_QUERY,VERIFY_EARLY_ACCESS_WORKERS_QUERY];
  for(const [index,{url,init}] of f.calls.entries()){
    assert.equal(url,`https://api.supabase.com/v1/projects/${projectRef}/database/query`);
    assert.equal(init.method,'POST');assert.equal(init.headers.Authorization,`Bearer ${accessToken}`);
    assert.equal(init.redirect,'error');assert.equal(init.cache,'no-store');assert(init.signal instanceof AbortSignal);
    assert.deepEqual(JSON.parse(init.body),{query:expectedQueries[index],parameters:index?[projectUrl,feedbackWorkerSecret,invitationWorkerSecret]:[],read_only:false});
  }
});
test('fixed commands contain only owned Vault references, exact worker paths, empty body and a 55-second bound',()=>{
  assert.equal(EARLY_ACCESS_WORKER_SCHEDULE,'*/5 * * * *');assert.equal(EARLY_ACCESS_WORKER_TIMEOUT_MS,55000);
  assert.equal(EARLY_ACCESS_WORKER_COMMANDS.length,2);
  for(const [index,command] of EARLY_ACCESS_WORKER_COMMANDS.entries()){
    assert.equal((command.match(/vault\.decrypted_secrets/g)||[]).length,2);
    assert.match(command,/early_access_project_url/);assert.match(command,/x-dominion-worker-key/);
    assert.match(command,index===0?/early_access_feedback_worker_secret/:/early_access_invitation_worker_secret/);
    assert.match(command,index===0?/\/functions\/v1\/process-early-access-feedback/:/\/functions\/v1\/process-early-access-invitations/);
    assert.match(command,/body := '\{\}'::jsonb/);assert.match(command,/timeout_milliseconds := 55000/);
    assert.doesNotMatch(command,/https?:\/\/|Authorization|Bearer|service_role|re_/);
  }
});
test('SQL preserves the shared 90-per-day / 2,900-per-month quota and service-only fences without queue grants or Auth writes',()=>{
  const migration=readFileSync(new URL('../supabase/migrations/20260922000815_early_access_feedback_outbox.sql',import.meta.url),'utf8');
  const body=migration.slice(migration.indexOf('create function private.reserve_transactional_email(')).split('$$')[1];
  assert.match(body,/>= 90/);assert.match(body,/>= 2900/);assert.match(body,/transactional-email-free-quota/);
  assert.equal(createHash('md5').update(body).digest('hex'),FREE_EMAIL_QUOTA_SOURCE_MD5);
  assert.match(EARLY_ACCESS_WORKER_EXTENSION_QUERY,/pg_catalog\.md5\(p\.prosrc\)/);
  assert.match(EARLY_ACCESS_WORKER_EXTENSION_QUERY,/mark_early_access_feedback_dispatched/);
  assert.match(EARLY_ACCESS_WORKER_EXTENSION_QUERY,/mark_early_access_invitation_dispatched/);
  assert.match(EARLY_ACCESS_WORKER_EXTENSION_QUERY,/mark_early_access_account_setup_dispatched/);
  for(const sql of [EARLY_ACCESS_WORKER_EXTENSION_QUERY,CONFIGURE_EARLY_ACCESS_WORKERS_QUERY,VERIFY_EARLY_ACCESS_WORKERS_QUERY]){
    assert.doesNotMatch(sql,/\b(?:grant|revoke|truncate|delete|drop)\s/i);
    assert.doesNotMatch(sql,/\b(?:insert\s+into|update)\s+(?:auth\.|private\.|cron\.job)/i);
    assert(!sql.includes(accessToken));assert(!sql.includes(projectUrl));assert(!sql.includes(feedbackWorkerSecret));assert(!sql.includes(invitationWorkerSecret));
  }
  assert.match(EARLY_ACCESS_WORKER_EXTENSION_QUERY,/create extension if not exists pg_cron with schema pg_catalog/);
  assert.match(EARLY_ACCESS_WORKER_EXTENSION_QUERY,/create extension if not exists pg_net with schema extensions/);
  assert.match(EARLY_ACCESS_WORKER_EXTENSION_QUERY,/'supabase_vault','vault'/);
  assert.match(CONFIGURE_EARLY_ACCESS_WORKERS_QUERY,/vault\.update_secret/);assert.match(CONFIGURE_EARLY_ACCESS_WORKERS_QUERY,/vault\.create_secret/);
  assert.match(CONFIGURE_EARLY_ACCESS_WORKERS_QUERY,/cron\.schedule/);assert.match(CONFIGURE_EARLY_ACCESS_WORKERS_QUERY,/cron\.alter_job/);
  assert.match(VERIFY_EARLY_ACCESS_WORKERS_QUERY,/j\.username=current_user and j\.database=current_database\(\)/);
});
for(const patch of [{projectRef:'another-project'},{projectUrl:'https://another.supabase.co'},{projectUrl:projectUrl+'/'},
  {accessToken:''},{accessToken:accessToken+'\n'},{accessToken:'x'.repeat(4097)},
  {feedbackWorkerSecret:'short'},{invitationWorkerSecret:invitationWorkerSecret+'\r\n'},{feedbackWorkerSecret:'x'.repeat(513)},
  {invitationWorkerSecret:feedbackWorkerSecret},{requestTimeoutMs:0},{requestTimeoutMs:30001},{requestTimeoutMs:NaN}]){
  test(`invalid operator setting ${Object.keys(patch)[0]} fails before network`,async()=>{
    const f=fixture();await denied(configureProductionEarlyAccessWorkers({...f.options,...patch}));assert.equal(f.calls.length,0);
  });
}
test('extension or configuration failures stop before any subsequent operation',async()=>{
  for(const [index,value] of [[0,null],[0,[{}]],[1,[{configured:false}]],[1,[{configured:true,secret:feedbackWorkerSecret}]]]){
    const f=fixture();f.replies[index]=value;await denied(configureProductionEarlyAccessWorkers(f.options));assert.equal(f.calls.length,index+1);
  }
});
test('verification accepts only exact fixed booleans/counts and no secret-bearing additions',()=>{
  assert.equal(parseEarlyAccessWorkerVerification([verification()]),true);
  for(const key of Object.keys(verification())){
    assert.throws(()=>parseEarlyAccessWorkerVerification([verification({[key]:key.endsWith('_count')?0:false})]),{message:MESSAGE});
    assert.throws(()=>parseEarlyAccessWorkerVerification([verification({[key]:'true'})]),{message:MESSAGE});
  }
  for(const value of [null,{},[],[verification(),verification()],[verification({secret:feedbackWorkerSecret})]])assert.throws(()=>parseEarlyAccessWorkerVerification(value),{message:MESSAGE});
  let reads=0;const value=verification();Object.defineProperty(value,'job_count',{get(){reads++;throw new Error(feedbackWorkerSecret);}});
  assert.throws(()=>parseEarlyAccessWorkerVerification([value]),{message:MESSAGE});assert.equal(reads,0);
});
test('HTTP status, redirects, throw, malformed JSON and huge responses have fixed secret-safe errors',async()=>{
  for(const makeResponse of [()=>Response.json({secret:feedbackWorkerSecret},{status:403}),()=>new Response('not json',{status:201}),
    ()=>new Response('x'.repeat(65537),{status:201}),()=>Promise.reject(new Error(invitationWorkerSecret)),
    ()=>{const response=Response.json([],{status:201});Object.defineProperty(response,'redirected',{value:true});return response;}]){
    const f=fixture();f.options.fetchImplementation=makeResponse;await denied(configureProductionEarlyAccessWorkers(f.options));
  }
});
test('deadline bounds stalled fetch or body even if an injected transport ignores abort',async()=>{
  let firstSignal;const f=fixture();f.options.requestTimeoutMs=5;
  f.options.fetchImplementation=async(_url,init)=>{firstSignal=init.signal;return new Promise(()=>{});};
  await denied(configureProductionEarlyAccessWorkers(f.options));assert.equal(firstSignal.aborted,true);
  let cancelled=false;const g=fixture();g.options.requestTimeoutMs=5;
  g.options.fetchImplementation=async()=>new Response(new ReadableStream({start(){},cancel(){cancelled=true;}}),{status:201});
  await denied(configureProductionEarlyAccessWorkers(g.options));assert.equal(cancelled,true);
});
test('unknown late management response cannot schedule after a timed-out preflight',async()=>{
  let resolve;const f=fixture();f.options.requestTimeoutMs=5;
  f.options.fetchImplementation=(_url,init)=>{f.calls.push(init);return new Promise(done=>{resolve=done;});};
  await denied(configureProductionEarlyAccessWorkers(f.options));resolve(Response.json([],{status:201}));
  await new Promise(done=>setTimeout(done,5));assert.equal(f.calls.length,1);
});
