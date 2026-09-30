import { BADGE_CATALOG, appVisitBadgeFacts, badgeCatalogOrder, checkInBadgeFacts, evaluateBadgeEvent, original77CompletionBadgeFacts } from './badge-evaluation.mjs';
import { badgeAwardIdentity } from './badge-data-contract.mjs';
import { previewOriginal77Progress } from './original-77-progress.mjs';

export { PREVIEW_BADGE_STATE_KEY } from './badge-data-contract.mjs';
export { evaluateBadgeEvent } from './badge-evaluation.mjs';
export function normalizePreviewBadgeState(value, legacy=[]) {
  const isAward = (row) => row && typeof row === 'object' && typeof (row.key || row.badge_key) === 'string';
  const isEvent = (row) => row && typeof row === 'object' && typeof row.localDate === 'string' && typeof row.sourceId === 'string';
  if(value?.schemaVersion===1&&Array.isArray(value.awards)&&Array.isArray(value.checkIns)&&Array.isArray(value.visits)) return {
    schemaVersion:1,awards:structuredClone(value.awards.filter(isAward)),
    checkIns:structuredClone(value.checkIns),visits:structuredClone(value.visits.filter(isEvent)),
    completionEvents:structuredClone(value.completionEvents ?? []),
  };
  return {schemaVersion:1,checkIns:[],visits:[],completionEvents:[],awards:(Array.isArray(legacy)?legacy:[]).filter(isAward).map(award=>({...award,
    scopeKey:award.scopeKey||award.scope_key||'lifetime',awardId:award.awardId||award.id||`legacy:${badgeAwardIdentity(award)}`,
    legacy:true,celebrationSeenAt:award.earnedAt||'legacy'}))};
}
export function recordPreviewBadgeEvent(state,event,completionContext) {
  if (!['check_in', 'app_visit'].includes(event?.source)) throw new Error('A supported posted badge event is required.');
  const history=event.source==='check_in'?state.checkIns:state.visits;
  if(history.some(row=>row?.localDate===event.localDate)) return [];
  let completionEvent = null; let completionAwards = [];
  if (event.source === 'check_in' && completionContext) {
    const { userId, startDate, createEventId = () => crypto.randomUUID(), now = () => new Date().toISOString() } = completionContext;
    const progress = previewOriginal77Progress(state, { userId, startDate });
    if (progress.completionState !== 'in_progress') throw new Error('The original challenge cannot accept another Check-In.');
    // Validate the actual new row before changing any state. Existing history
    // alone never creates a completion or even an unacknowledged award.
    const nextProgress = previewOriginal77Progress({ ...state, checkIns: [...history, event] }, { userId, startDate });
    if (nextProgress.completionState === 'invalid_evidence') throw new Error('The posted Check-In could not be verified.');
    if (progress.submittedCount === 76) {
      completionEvent = { id: createEventId(), userId, startDate, sourceId: event.sourceId,
        localDate: event.localDate, recordedAt: event.occurredAt, persistedAt: now() };
      const completionFacts = original77CompletionBadgeFacts({ userId, startDate, event, priorEvents: history, completionEvent });
      if (!completionFacts) throw new Error('The completion event could not be verified.');
      completionAwards = evaluateBadgeEvent(completionFacts, state.awards);
    }
  }
  const facts=event.source==='check_in'?checkInBadgeFacts(event,history):appVisitBadgeFacts(event,history);
  if(!facts) throw new Error('A complete posted badge event is required.');
  const awards=[...evaluateBadgeEvent(facts,state.awards), ...completionAwards].map(award=>({...award,awardId:`preview:${award.key}:${award.scopeKey}`}));
  history.push(structuredClone(event));state.awards.push(...awards);
  if (completionEvent) state.completionEvents.push(completionEvent);
  return awards;
}
export function claimPreviewBadgeCelebrations(state,token,now=Date.now()) {
  const candidates=state.awards.filter(award=>award.legacy===false&&!award.celebrationSeenAt
    &&(award.celebrationClaimToken===token||!award.celebrationClaimUntil||Date.parse(award.celebrationClaimUntil)<=now))
    .sort(badgeCatalogOrder).slice(0,8);
  for(const award of candidates){award.celebrationClaimToken=token;award.celebrationClaimUntil=new Date(now+120000).toISOString();}
  return structuredClone(candidates);
}
export function acknowledgePreviewBadgeCelebrations(state,token,ids,now=Date.now()) {
  if(!Array.isArray(ids)||ids.length>8)throw new Error('Invalid badge acknowledgment.');
  for(const award of state.awards)if(ids.includes(award.awardId)&&award.celebrationClaimToken===token&&!award.celebrationSeenAt){
    award.celebrationSeenAt=new Date(now).toISOString();award.celebrationClaimUntil=null;
  }
  return state.awards.filter(award=>ids.includes(award.awardId)&&award.celebrationSeenAt).map(award=>award.awardId);
}

export function previewBadgeCollection(state,activation,today) {
  const scopeKey=activation?.startDate?`original77:${activation.startDate}`:null;
  const latest=[...state.checkIns].sort((a,b)=>b.localDate.localeCompare(a.localDate))[0];
  const facts=latest?checkInBadgeFacts(latest,state.checkIns)||{}:{};
  if (!scopeKey || facts.instanceId !== scopeKey) {
    facts.instance_check_in_count = 0;
    facts.perfect_streak = 0;
  }
  const yesterday=new Date(Date.parse(`${today}T00:00:00Z`)-86400000).toISOString().slice(0,10);
  if(latest?.localDate<yesterday)facts.perfect_streak=0;
  const latestVisit=[...state.visits].sort((a,b)=>b.localDate.localeCompare(a.localDate))[0];
  facts.app_streak=latestVisit?.localDate>=yesterday?appVisitBadgeFacts(latestVisit,state.visits)?.app_streak||0:0;
  const items=BADGE_CATALOG.filter(rule=>(rule.status!=='retired'&&rule.visibility==='public')||state.awards.some(a=>a.key===rule.key)).map(rule=>{
    const earnedInCurrentScope=state.awards.some(a=>a.key===rule.key&&a.scopeKey===(rule.scope==='lifetime'?'lifetime':scopeKey));
    return {key:rule.key,name:rule.name,description:rule.description,requirement:rule.requirement,series:rule.series,
      tier:rule.tier,tierRank:rule.tierRank,icon:rule.icon,displayOrder:rule.displayOrder,status:rule.status,scope:rule.scope,
      criteriaVersion:rule.criteriaVersion,sourceEvent:rule.source,visibility:rule.visibility,showProgress:rule.showProgress,
      earnedInCurrentScope,progress:{metric:rule.metric,current:earnedInCurrentScope?(rule.threshold||0):Math.max(facts[rule.metric]||0,0),target:rule.threshold}};
  });
  return {catalogVersion:1,scopeKey,items};
}
