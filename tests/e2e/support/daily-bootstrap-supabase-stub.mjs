import { DAILY_ACTOR as A } from '../../fixtures/daily-action-bootstrap.mjs';
import { dailyBootstrapV2Fixture, rewardCatalogV2Fixture } from '../../fixtures/daily-action-bootstrap-v2.mjs';
const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
export async function installDailyBootstrapStub(context, { status = 'active', appAccess = true,
  theme = 'dark', enrolled = false, aal = 'aal1', completed = [] } = {}) {
  const requests = []; let bootstrapGate = null; let failNext = false; let version = 2;
  let userGate = null; let userGateActive = false; let heldUserRequests = 0;
  let savedCompleted = completed;
  const user = (id) => ({ id, aud: 'authenticated', role: 'authenticated', email: 'daily.synthetic@example.test',
    user_metadata: { name: 'Synthetic Daily Member' }, factors: enrolled ? [{ id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', factor_type: 'totp', status: 'verified' }] : [] });
  const sessionFor = (id = A, sid = '11111111-1111-4111-8111-111111111111', level = aal) => {
    const now = Math.floor(Date.now()/1000);
    return { access_token: `${encode({ alg:'HS256',typ:'JWT' })}.${encode({ sub:id,session_id:sid,aal:level,exp:now+3600,iat:now,role:'authenticated',amr:[{method:'password',timestamp:now}] })}.${encode('synthetic-signature')}`,
      refresh_token:'synthetic-only',expires_in:3600,expires_at:now+3600,token_type:'bearer',user:user(id) };
  };
  await context.addInitScript(({ session, theme }) => {
    if (!localStorage.getItem('sb-127-auth-token')) localStorage.setItem('sb-127-auth-token', JSON.stringify(session));
    localStorage.setItem('dominion:theme', theme);
  }, { session:sessionFor(), theme });
  const json = (route, data, statusCode=200) => route.fulfill({ status:statusCode,contentType:'application/json',
    headers:{'Cache-Control':'private, no-store'},body:JSON.stringify(data) });
  await context.route('**/__daily_fixture__/**', async (route) => {
    const request=route.request();const path=new URL(request.url()).pathname.replace('/__daily_fixture__','');
    const args=request.postData()?request.postDataJSON():{};
    let claims={};try{claims=JSON.parse(Buffer.from((request.headers().authorization||'').split('.')[1], 'base64url').toString());}catch{}
    const actorId=claims.sub||A;
    requests.push({path,method:request.method(),args,actorId});
    const payload=()=>dailyBootstrapV2Fixture({actorId,status,appAccess,completed:savedCompleted,version});
    if(path==='/auth/v1/user'){
      // A concurrent shell read must not consume the hold before the focused
      // bootstrap's own post-response verification reaches Auth.
      if(userGateActive&&userGate){heldUserRequests+=1;await userGate;}
      return json(route,user(actorId));
    }
    if(path==='/auth/v1/token')return json(route,sessionFor(actorId));
    if(path==='/auth/v1/logout')return json(route,{});
    if(path==='/rest/v1/rpc/get_daily_action_bootstrap_v2'){
      const held=payload();if(bootstrapGate)await bootstrapGate;
      if(failNext){failNext=false;return json(route,{message:'Synthetic unavailable'},503);}
      if(userGate)userGateActive=true;
      return json(route,held);
    }
    if(path==='/rest/v1/rpc/get_challenge_activation_v2')return json(route,payload().activation);
    if(path==='/rest/v1/rpc/get_site_admin_context')return json(route,{schemaVersion:1,actorId,role:'member',adminReady:false});
    if(path==='/rest/v1/rpc/get_theme_preference'||path==='/rest/v1/rpc/set_theme_preference')return json(route,{theme_key:theme});
    if(path==='/rest/v1/rpc/get_reward_catalog_v2')return json(route,rewardCatalogV2Fixture(
      dailyBootstrapV2Fixture({actorId,status,appAccess:true}).activation,{ownedThemes:true}));
    if(path==='/rest/v1/rpc/record_app_visit')return json(route,[{total_points:0,current_app_streak:1,best_app_streak:1,new_badges:[]}]);
    if(path==='/rest/v1/user_game_stats')return json(route,{current_app_streak:1,best_app_streak:1,last_seen_date:'2026-09-12'});
    if(path==='/rest/v1/rpc/bootstrap_daily_standard_time_zone')return json(route,'America/Los_Angeles');
    if(path==='/rest/v1/rpc/mutate_daily_standard_draft_v2'){
      if(args.target_expected_actor_id!==actorId||args.target_expected_instance_id!==payload().instanceId)return json(route,{message:'Synthetic stale actor or instance'},409);
      savedCompleted=args.target_completed?[...new Set([...savedCompleted,args.target_action_id])]:savedCompleted.filter(id=>id!==args.target_action_id);version+=1;return json(route,payload().draft);
    }
    if(path==='/rest/v1/rpc/get_daily_standard_draft_v2')return json(route,payload().draft);
    if(path==='/rest/v1/entitlements')return json(route,appAccess?[{entitlement_key:'membership_active',status:'active',ends_at:null}]:[]);
    if(path==='/rest/v1/rpc/get_member_access_context'){
      if(args.target_expected_actor_id!==actorId)return json(route,{code:'PT401',message:'member_authentication_required'},401);
      if(enrolled&&claims.aal!=='aal2')return json(route,{code:'PT403',message:'member_mfa_required'},403);
      return json(route,{schemaVersion:1,actorId,asOf:new Date().toISOString(),appAccess,
        legacyMembershipActive:appAccess,paidSubscriptionActive:false,earlyAccessActive:false,
        earlyAccessProgram:null,earlyAccessEndsAt:null,betaPriceEligible:false});
    }
    if(path==='/rest/v1/profiles')return json(route,{user_id:actorId,name:'Synthetic Daily Member',email:user(actorId).email,time_zone:'UTC'});
    if(path.startsWith('/rest/')||path.startsWith('/functions/'))return json(route,[]);
    return json(route,{message:'Unexpected synthetic endpoint'},500);
  });
  return {requests, sessionFor,
    bootstrapRequests:()=>requests.filter(r=>r.path.endsWith('/get_daily_action_bootstrap_v2')),
    completed(value){savedCompleted=[...value];},
    enrolled(value){enrolled=value;},
    heldUserRequests:()=>heldUserRequests,
    holdPostBootstrapUser(){let release;userGate=new Promise(r=>{release=r;});return()=>{release();userGate=null;userGateActive=false;};},
    failNext(){failNext=true;},
    hold(){let release;bootstrapGate=new Promise(r=>{release=r;});return()=>{release();bootstrapGate=null;};},
  };
}
