import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createClient } from '@supabase/supabase-js';
import { createMemberAccessTransport, readMemberBillingState } from './member-access-reader.mjs';
import { authSessionIdentity, createInitialSessionRefreshFence, sessionRequiresMfa } from './mfa-auth.mjs';

const A='11111111-1111-4111-8111-111111111111';
const B='22222222-2222-4222-8222-222222222222';
const access=(patch={})=>({schemaVersion:1,actorId:A,asOf:'2026-09-27T04:00:00Z',appAccess:true,
  legacyMembershipActive:false,paidSubscriptionActive:false,earlyAccessActive:true,
  earlyAccessProgram:'early_access_v1',earlyAccessEndsAt:null,betaPriceEligible:true,...patch});
const makeSession=(actor=A,sid='s1',token='original-token')=>({user:{id:actor},sid,access_token:token});
const deferred=()=>{let resolve;const promise=new Promise(yes=>{resolve=yes;});return {promise,resolve};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function until(check){for(let i=0;i<100;i++){if(check())return;await tick();}assert.fail('Expected stage not reached.');}
function fixture(){
  let session=makeSession(),epoch=0;
  const calls=[];
  const hooks={};
  const adapters={
    getEpoch:()=>epoch,
    sessionIdentity:value=>value?.user?.id&&value.sid?`${value.user.id}:${value.sid}`:'',
    getSession:async()=>{calls.push({kind:'session'});return hooks.session?hooks.session():session;},
    getUser:async token=>{calls.push({kind:'user',token});return hooks.user?hooks.user():session?.user;},
    requiresMfa:async()=>{calls.push({kind:'mfa'});return hooks.mfa?hooks.mfa():false;},
    request:async(kind,options)=>{calls.push({kind,options});return hooks[kind]?hooks[kind]():kind==='access'?access():[];},
  };
  return {adapters,calls,hooks,read:options=>readMemberBillingState(adapters,options),
    change:(actor=A,sid='s2',token='new-token',emit=true)=>{session=actor?makeSession(actor,sid,token):null;if(emit)epoch++;},
    invalidate:()=>epoch++,get session(){return session;}};
}
const remoteCalls=f=>f.calls.filter(row=>['access','entitlements','subscriptions'].includes(row.kind));
const SID='33333333-3333-4333-8333-333333333333';
const realSession=(actor=A,sid=SID,expiry=Math.floor(Date.now()/1000)+3600)=>({
  access_token:`${Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url')}.${Buffer.from(JSON.stringify({sub:actor,session_id:sid,exp:expiry,aal:'aal1'})).toString('base64url')}.${Buffer.from('synthetic-signature').toString('base64url')}`,
  refresh_token:'synthetic-refresh',expires_at:expiry,expires_in:3600,token_type:'bearer',
  user:{id:actor,aud:'authenticated',factors:[]},
});
function refreshObserver(){
  const fence=createInitialSessionRefreshFence();let epoch=0,observed;
  return {
    getEpoch:()=>epoch,
    invalidate:()=>epoch++,
    canStabilizeInitialSession:(expected,session)=>fence.permits(expected,epoch,session),
    observe(event,session){
      const identity=authSessionIdentity(session),before=epoch;
      if(['SIGNED_OUT','TOKEN_REFRESHED','USER_UPDATED','PASSWORD_RECOVERY','MFA_CHALLENGE_VERIFIED'].includes(event)
        ||(observed!==undefined&&identity!==observed))epoch++;
      fence.observe(event,session,before,epoch);observed=identity;
    },
  };
}

for(const mode of ['during acquisition','during lazy import']){
  test(`real SDK expired-session restoration stabilizes one initialization refresh ${mode}`,async()=>{
    const observer=refreshObserver(),events=[],calls=[],refresh=deferred();
    let stored=JSON.stringify(realSession(A,SID,Math.floor(Date.now()/1000)-60));
    const renewed=realSession();
    const client=createClient('https://synthetic.invalid','synthetic-public',{
      auth:{storageKey:`synthetic-member-${mode}`,persistSession:true,autoRefreshToken:true,detectSessionInUrl:false,
        storage:{getItem:()=>stored,setItem:(key,value)=>{stored=value;},removeItem:()=>{stored=null;}}},
      global:{fetch:async url=>{
        const path=new URL(url).pathname;calls.push(path);
        if(path==='/auth/v1/token'){await refresh.promise;return new Response(JSON.stringify(renewed));}
        if(path==='/auth/v1/user')return new Response(JSON.stringify(renewed.user));
        assert.fail(`Unexpected synthetic request: ${path}`);
      }},
    });
    const {data:{subscription}}=client.auth.onAuthStateChange((event,session)=>{
      events.push(event);observer.observe(event,session);
    });
    const options={expectedEpoch:observer.getEpoch(),timeoutMs:2000};
    const adapters={...observer,sessionIdentity:authSessionIdentity,
      getSession:async()=>(await client.auth.getSession()).data.session,
      getUser:async token=>(await client.auth.getUser(token)).data.user,
      requiresMfa:()=>sessionRequiresMfa(client.auth),
      request:async(kind,{token})=>{assert.equal(token,renewed.access_token);calls.push(kind);return kind==='access'?access():[];},
    };
    try{
      let reading;
      if(mode==='during acquisition')reading=readMemberBillingState(adapters,options);
      await until(()=>calls.includes('/auth/v1/token'));refresh.resolve();
      if(mode==='during lazy import'){
        await client.auth.initialize();await until(()=>events.includes('INITIAL_SESSION'));
        reading=readMemberBillingState(adapters,options);
      }
      assert.equal((await reading).context.appAccess,true);
      assert.deepEqual(events,['TOKEN_REFRESHED','INITIAL_SESSION']);
      assert.equal(observer.getEpoch(),1);
      assert.equal(calls.filter(path=>path==='/auth/v1/token').length,1);
      assert.deepEqual(calls.filter(path=>!path.startsWith('/')),['entitlements','access']);
    }finally{refresh.resolve();subscription.unsubscribe();await client.auth.stopAutoRefresh();}
  });
}

test('startup refresh evidence never adopts a replacement owner, lifecycle invalidation or multiple refreshes',async()=>{
  for(const mode of ['actor','session','aba','signed-out','assurance','user-update','recovery','storage','pagehide','twice','silent-bearer']){
    const observer=refreshObserver(),calls=[];let session=realSession(A,SID,100),acquisitions=0;
    observer.observe('INITIAL_SESSION',session);
    const expectedEpoch=observer.getEpoch();
    const replace=(event,next)=>{session=next;observer.observe(event,session);};
    const adapters={...observer,sessionIdentity:authSessionIdentity,
      getSession:async()=>{
        acquisitions++;
        replace('TOKEN_REFRESHED',mode==='actor'?realSession(B):mode==='session'
          ?realSession(A,'44444444-4444-4444-8444-444444444444'):realSession());
        if(mode==='aba'){replace('SIGNED_IN',realSession(B));replace('SIGNED_IN',realSession());}
        if(mode==='signed-out')replace('SIGNED_OUT',null);
        if(mode==='assurance')replace('MFA_CHALLENGE_VERIFIED',session);
        if(mode==='user-update')replace('USER_UPDATED',session);
        if(mode==='recovery')replace('PASSWORD_RECOVERY',session);
        if(mode==='storage'||mode==='pagehide')observer.invalidate();
        if(mode==='twice')replace('TOKEN_REFRESHED',realSession());
        if(mode==='silent-bearer')session={...session,access_token:`${session.access_token}-changed`};
        return session;
      },
      getUser:async()=>{calls.push('user');return session?.user;},requiresMfa:async()=>false,
      request:async kind=>{calls.push(kind);return kind==='access'?access():[];},
    };
    await assert.rejects(readMemberBillingState(adapters,{expectedEpoch}),{code:'MEMBER_ACCESS_CHANGED'},mode);
    assert.equal(acquisitions,1);assert.deepEqual(calls,[]);
  }
});

test('stabilized initial refresh still verifies MFA and rejects every later refresh',async()=>{
  for(const mode of ['mfa','after-user','after-details','after-context']){
    const observer=refreshObserver(),calls=[];let session=realSession(A,SID,100),acquisitions=0;
    observer.observe('INITIAL_SESSION',session);
    const refresh=()=>{session=realSession();observer.observe('TOKEN_REFRESHED',session);};
    const result=readMemberBillingState({...observer,sessionIdentity:authSessionIdentity,
      getSession:async()=>{if(++acquisitions===1)refresh();return session;},
      getUser:async()=>{calls.push('user');if(mode==='after-user')refresh();return session.user;},
      requiresMfa:async()=>mode==='mfa',
      request:async kind=>{calls.push(kind);if((mode==='after-details'&&kind==='entitlements')||(mode==='after-context'&&kind==='access'))refresh();return kind==='access'?access():[];},
    });
    await assert.rejects(result,{code:mode==='mfa'?'MEMBER_ACCESS_MFA_REQUIRED':'MEMBER_ACCESS_CHANGED'});
    if(['mfa','after-user'].includes(mode))assert.deepEqual(calls,['user']);
  }
});

test('initial refresh stabilization stays inside the original deadline and cannot dispatch after cancellation',async()=>{
  for(const mode of ['deadline','cancel']){
    const observer=refreshObserver(),held=deferred(),calls=[],controller=new AbortController();
    let session=realSession(A,SID,100);observer.observe('INITIAL_SESSION',session);
    const result=readMemberBillingState({...observer,sessionIdentity:authSessionIdentity,
      getSession:async()=>{session=realSession();observer.observe('TOKEN_REFRESHED',session);calls.push('session');return held.promise;},
      getUser:async()=>{calls.push('user');return session.user;},requiresMfa:async()=>false,
      request:async kind=>{calls.push(kind);return kind==='access'?access():[];},
    },{signal:controller.signal,timeoutMs:mode==='deadline'?8:2000});
    const rejected=assert.rejects(result);await until(()=>calls.length===1);
    if(mode==='cancel')controller.abort();await rejected;
    held.resolve(session);await tick();assert.deepEqual(calls,['session']);
  }
});

test('canonical server authority is separate from raw billing details and all requests pin the original bearer',async()=>{
  const f=fixture();f.hooks.entitlements=()=>[{entitlement_key:'membership_active',status:'expired'}];
  const result=await f.read();assert.deepEqual(result.context,access());
  assert.equal(result.context.paidSubscriptionActive,false);
  assert.deepEqual(result.entitlements,[{entitlement_key:'membership_active',status:'expired'}]);
  assert.deepEqual(result.subscriptions,[]);
  assert.deepEqual(remoteCalls(f).map(row=>row.kind),['entitlements','access']);
  assert.equal(f.calls.filter(row=>row.kind==='user').length,1);
  assert.equal(f.calls.filter(row=>row.kind==='mfa').length,2);
  for(const row of remoteCalls(f)){
    assert.equal(row.options.actorId,A);assert.equal(row.options.token,'original-token');assert.ok(row.options.signal instanceof AbortSignal);
  }
  assert.doesNotMatch(JSON.stringify(result),/original-token|session_id|s1/);
});

test('billing-closed never starts a subscription request; billing-open keeps its raw snapshots',async()=>{
  const f=fixture();f.hooks.subscriptions=()=>[{id:'sub-fixture',status:'active'}];
  assert.deepEqual((await f.read()).subscriptions,[]);
  assert.equal(f.calls.some(row=>row.kind==='subscriptions'),false);
  assert.deepEqual((await f.read({billingEnabled:true})).subscriptions,[{id:'sub-fixture',status:'active'}]);
});

test('no read caches authority and neither a raw entitlement nor lifetime price eligibility grants access',async()=>{
  const f=fixture();await f.read();
  f.hooks.entitlements=()=>[{entitlement_key:'membership_active',status:'active'}];
  f.hooks.access=()=>access({earlyAccessActive:false,earlyAccessProgram:null,appAccess:false});
  const next=await f.read();assert.equal(next.context.appAccess,false);assert.equal(next.context.betaPriceEligible,true);
  assert.equal(f.calls.filter(row=>row.kind==='access').length,2);
  assert.equal(f.calls.filter(row=>row.kind==='user').length,2);
});

test('signed-out state performs no private reads',async()=>{
  const f=fixture();f.change(null);assert.equal(await f.read(),null);assert.equal(f.calls.length,1);
});

test('missing or mismatched authoritative Auth user denies every detail/context request',async()=>{
  for(const user of [null,{}, {id:B}]){
    const f=fixture();f.hooks.user=()=>user;
    await assert.rejects(f.read(),{code:user?.id?'MEMBER_ACCESS_CHANGED':'MEMBER_ACCESS_SIGNED_OUT'});
    assert.equal(remoteCalls(f).length,0);
  }
});

test('MFA is fail-closed before private reads and rechecked before publishing state',async()=>{
  for(const mfa of [true,undefined,null,'false']){
    const f=fixture();f.hooks.mfa=()=>mfa;
    await assert.rejects(f.read(),{code:mfa===true?'MEMBER_ACCESS_MFA_REQUIRED':'MEMBER_ACCESS_UNAVAILABLE'});
    assert.equal(remoteCalls(f).length,0);
  }
  const f=fixture();let count=0;f.hooks.mfa=()=>++count>1;
  await assert.rejects(f.read(),{code:'MEMBER_ACCESS_MFA_REQUIRED'});
});

test('malformed context cannot publish permissions, unknown fields or a foreign actor',async()=>{
  for(const patch of [{actorId:B},{schemaVersion:2},{secret:'private'},{appAccess:false},{paidSubscriptionActive:true},
    {earlyAccessActive:'true'},{betaPriceEligible:1},{asOf:'tomorrow'}]){
    const f=fixture();f.hooks.access=()=>access(patch);
    await assert.rejects(f.read(),{code:'MEMBER_ACCESS_UNAVAILABLE'});
  }
});

test('raw detail failures and malformed lists never become a permissive default',async()=>{
  for(const rows of [null,{},[null],['text']]){
    const f=fixture();f.hooks.entitlements=()=>rows;
    await assert.rejects(f.read(),{code:'MEMBER_ACCESS_UNAVAILABLE'});
    assert.equal(f.calls.some(row=>row.kind==='access'),false);
  }
});

for(const stage of ['user','entitlements','access']){
  test(`${stage}: silent actor, session and bearer replacements fence the original read`,async()=>{
    for(const [actor,sid,token] of [[B,'s1','original-token'],[A,'s2','original-token'],[A,'s1','replacement-token']]){
      const f=fixture(),held=deferred();f.hooks[stage]=()=>held.promise;
      const result=f.read();const rejected=assert.rejects(result,{code:'MEMBER_ACCESS_CHANGED'});
      await until(()=>f.calls.some(row=>row.kind===stage));
      f.change(actor,sid,token,false);held.resolve(stage==='user'?{id:A}:stage==='access'?access():[]);
      await rejected;
    }
  });
}

test('shared epoch fences A-to-B-to-A, same-session assurance updates and pre-import ownership changes',async()=>{
  for(const mode of ['aba','invalidate','before']){
    const f=fixture(),held=deferred();
    if(mode==='before'){
      f.invalidate();await assert.rejects(f.read({expectedEpoch:0}),{code:'MEMBER_ACCESS_CHANGED'});
      assert.equal(f.calls.length,0);continue;
    }
    f.hooks.entitlements=()=>held.promise;
    const result=f.read();const rejected=assert.rejects(result,{code:'MEMBER_ACCESS_CHANGED'});
    await until(()=>f.calls.some(row=>row.kind==='entitlements'));
    if(mode==='aba'){f.change(B);f.change(A,'s1','original-token');}else f.invalidate();
    held.resolve([]);await rejected;assert.equal(f.calls.some(row=>row.kind==='access'),false);
  }
});

test('a bounded deadline covers Auth, MFA, details, context and the final session check without late dispatch',async()=>{
  for(const stage of ['session','user','mfa','entitlements','access','final-session']){
    const f=fixture(),held=deferred();
    if(stage==='final-session'){
      let count=0;f.hooks.session=()=>++count===4?held.promise:f.session;
    }else f.hooks[stage]=()=>held.promise;
    await assert.rejects(f.read({timeoutMs:8}),{code:'MEMBER_ACCESS_UNAVAILABLE'});
    const count=f.calls.length;
    held.resolve(stage==='session'||stage==='final-session'?f.session:stage==='user'?{id:A}:stage==='mfa'?false:stage==='access'?access():[]);
    await tick();assert.equal(f.calls.length,count);
  }
});

test('caller cancellation settles hung reads, aborts transports and blocks late continuation',async()=>{
  const f=fixture(),held=deferred(),controller=new AbortController();f.hooks.entitlements=()=>held.promise;
  const result=f.read({signal:controller.signal});const rejected=assert.rejects(result,{code:'MEMBER_ACCESS_CANCELLED'});
  await until(()=>remoteCalls(f).length===1);controller.abort();await rejected;
  assert.equal(remoteCalls(f)[0].options.signal.aborted,true);held.resolve([]);await tick();
  assert.equal(remoteCalls(f).length,1);
  const g=fixture();await assert.rejects(g.read({signal:AbortSignal.abort()}),{code:'MEMBER_ACCESS_CANCELLED'});assert.equal(g.calls.length,0);
});

test('known member failures map to safe messages; provider payloads are never surfaced',async()=>{
  for(const [error,code] of [
    [{code:'PT401',message:'member_authentication_required'},'MEMBER_ACCESS_SIGNED_OUT'],
    [{code:'PT403',message:'member_mfa_required'},'MEMBER_ACCESS_MFA_REQUIRED'],
    [{code:'PT403',message:'member_origin_forbidden'},'MEMBER_ACCESS_UNAVAILABLE'],
    [{code:'private',message:'secret token internal trace'},'MEMBER_ACCESS_UNAVAILABLE'],
  ]){
    const f=fixture();f.hooks.access=()=>{throw error;};
    await assert.rejects(f.read(),failure=>failure.code===code&&!/secret|trace|member_origin/.test(failure.message));
  }
});

test('fixed transport sends pinned bearer and self-only filters, with no cookies, cache or redirects',async()=>{
  const calls=[];const controller=new AbortController();
  const request=createMemberAccessTransport({url:'https://project.supabase.co',key:'public-key',fetch:async(url,options)=>{
    calls.push({url:new URL(url),options});return new Response(JSON.stringify(url.includes('/rpc/')?access():[]));
  }});
  for(const kind of ['entitlements','subscriptions','access'])await request(kind,{actorId:A,token:'pinned',signal:controller.signal});
  for(const {url,options} of calls){
    assert.equal(url.origin,'https://project.supabase.co');assert.equal(options.headers.Authorization,'Bearer pinned');
    assert.equal(options.headers.apikey,'public-key');assert.equal(options.credentials,'omit');assert.equal(options.cache,'no-store');
    assert.equal(options.redirect,'error');assert.equal(options.signal,controller.signal);
  }
  assert.equal(calls[0].url.searchParams.get('user_id'),`eq.${A}`);assert.equal(calls[1].url.searchParams.get('order'),'created_at.desc');
  assert.deepEqual(JSON.parse(calls[2].options.body),{target_expected_actor_id:A});assert.equal(calls[2].options.method,'POST');
  assert.equal(calls[2].url.search,'');assert.equal(calls[0].options.method,'GET');
  await assert.rejects(request('private',{actorId:A,token:'pinned',signal:controller.signal}));assert.equal(calls.length,3);
});

test('transport bounds response bytes, cancels oversize streams and rejects malformed JSON',async()=>{
  let cancelled=false;
  const large=new ReadableStream({pull(controller){controller.enqueue(new Uint8Array(4097));},cancel(){cancelled=true;}});
  const request=createMemberAccessTransport({url:'https://project.supabase.co',key:'key',fetch:async()=>new Response(large)});
  await assert.rejects(request('access',{actorId:A,token:'t',signal:new AbortController().signal}));assert.equal(cancelled,true);
  const malformed=createMemberAccessTransport({url:'https://project.supabase.co',key:'key',fetch:async()=>new Response('not-json')});
  await assert.rejects(malformed('access',{actorId:A,token:'t',signal:new AbortController().signal}));
});

test('transport keeps configured local fixture prefixes and rejects credential-bearing or unsafe URLs',async()=>{
  let url;
  const request=createMemberAccessTransport({url:'http://127.0.0.1:4815/__admin_fixture__',key:'public',fetch:async target=>{
    url=target;return new Response(JSON.stringify(access()));
  }});
  await request('access',{actorId:A,token:'pinned',signal:new AbortController().signal});
  assert.equal(url,'http://127.0.0.1:4815/__admin_fixture__/rest/v1/rpc/get_member_access_context');
  for(const unsafe of ['http://not-local.invalid','https://user:password@example.invalid','https://example.invalid?token=bad','https://example.invalid#bad','file:///tmp/fixture']){
    assert.throws(()=>createMemberAccessTransport({url:unsafe,key:'key'}));
  }
});

test('browser integration is lazy, reuses the Auth singleton and leaves mock paths ahead of live access',()=>{
  const read=name=>readFileSync(new URL(name,import.meta.url),'utf8');
  const api=read('./api.js');const billing=api.slice(api.indexOf('export async function getBillingState()'),api.indexOf('async function invokeSupabaseAction'));
  assert.ok(billing.indexOf('isLocalDemoMode()')<billing.indexOf("import('./member-access-reader.mjs')"));
  assert.match(billing,/getUser\(token\)/);assert.match(billing,/getEpoch: \(\) => previewBadgeEpoch/);
  assert.match(billing,/canStabilizeInitialSession,/);
  assert.match(read('./auth-runtime-core.mjs'),/initialSessionRefreshFence\.observe\(event, session, beforeEpoch, previewBadgeEpoch\)/);
  assert.match(billing,/appAccess: context.appAccess/);assert.match(billing,/subscriptionActive: context.paidSubscriptionActive/);
  assert.match(api,/pagehide', \(\) => \{ invalidatePreviewBadgeOwner\(\)/);
  assert.doesNotMatch(read('./member-access-reader.mjs'),/createClient|onAuthStateChange|localStorage|sessionStorage|feedback-client|api\.js/);
  assert.doesNotMatch(read('./auth-runtime-core.mjs'),/member-access-reader|member-access-context/);
  for(const page of ['./billing.js','./profile.js']){
    assert.match(read(page),/state\.earlyAccessActive/);assert.match(read(page),/state\.betaPriceEligible/);assert.match(read(page),/\$3\.50\/month/);
  }
});
