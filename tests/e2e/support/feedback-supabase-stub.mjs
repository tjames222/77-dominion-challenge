import { installAdminStub } from './admin-supabase-stub.mjs';
import { dailyBootstrapFixture } from '../../fixtures/daily-action-bootstrap.mjs';
const json = (route, value, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'Cache-Control': 'private, no-store' }, body: JSON.stringify(value) });
// Same real SDK/Auth transport as the established Admin suite. Only these two
// new RPCs are modeled; this is not a claim about SQL's independently tested
// authorization or delivery. Actors/tokens must be explicitly issued here.
export async function installFeedbackStub(context, { active = true, malformed = false, aal = 'aal2', memberPages = false } = {}) {
  const auth = await installAdminStub(context, { role: 'member', aal });
  const tokens = new Map([[auth.firstSession.access_token, auth.A]]);
  const calls = [], receipts = new Map(); let mode = ''; let hold = null;
  if (memberPages) await context.route(/\/__admin_fixture__\/rest\/v1\/(?:entitlements|rpc\/(?:get_daily_action_bootstrap|get_challenge_activation|get_daily_standard_draft|bootstrap_daily_standard_time_zone))(?:\?|$)/, async route => {
    const actor = tokens.get(route.request().headers().authorization?.replace(/^Bearer /, ''));
    if (!actor) return json(route, { code: 'PT401', message: 'member_authentication_required' }, 401);
    const path = new URL(route.request().url()).pathname; const data = dailyBootstrapFixture({ actorId: actor, status: 'active', appAccess: true });
    if (path.endsWith('/entitlements')) return json(route, [{ entitlement_key: 'membership_active', status: 'active', ends_at: null }]);
    if (path.endsWith('/get_challenge_activation')) return json(route, data.activation);
    if (path.endsWith('/get_daily_standard_draft')) return json(route, data.draft);
    if (path.endsWith('/bootstrap_daily_standard_time_zone')) return json(route, 'UTC');
    return json(route, data);
  });
  await context.route(/\/__admin_fixture__\/rest\/v1\/rpc\/(?:get_member_access_context|submit_early_access_feedback)$/, async route => {
    const request = route.request(); const body = request.postDataJSON(); const token = request.headers().authorization?.replace(/^Bearer /, '');
    const actor = tokens.get(token); const name = new URL(request.url()).pathname.split('/').at(-1);
    calls.push({ name, body, actor, method: request.method() });
    if (request.method() !== 'POST' || !actor || body.target_expected_actor_id !== actor) return json(route, { code: 'PT401', message: 'member_authentication_required' }, 401);
    if (aal !== 'aal2') return json(route, { code: 'PT403', message: 'member_mfa_required' }, 403);
    if (name === 'get_member_access_context') return json(route, { schemaVersion: 1, actorId: malformed ? auth.B : actor, asOf: new Date().toISOString(),
      appAccess: active || memberPages, legacyMembershipActive: memberPages, paidSubscriptionActive: false, earlyAccessActive: active,
      earlyAccessProgram: active ? 'early_access_v1' : null, earlyAccessEndsAt: null, betaPriceEligible: true });
    const fingerprint = JSON.stringify(body); const existing = receipts.get(body.target_operation_id);
    if (existing && existing.fingerprint !== fingerprint) return json(route, { code: 'PT409', message: 'feedback_conflict' }, 409);
    if (!existing && !active) return json(route, { code: 'PT403', message: 'feedback_not_eligible' }, 403);
    const result = existing?.result || { schemaVersion: 1, actorId: actor, operationId: body.target_operation_id,
      feedbackId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', status: 'saved' };
    receipts.set(body.target_operation_id, { fingerprint, result });
    if (hold) await hold;
    if (mode === 'lost') { mode = ''; return json(route, { message: 'PRIVATE PROVIDER SENTINEL' }, 502); }
    return json(route, result);
  });
  return { ...auth, calls, receipts,
    active(value) { active = value; }, mode(value) { mode = value; },
    writes() { return calls.filter(call => call.name === 'submit_early_access_feedback'); },
    replacement(id = auth.A) { const value = auth.session(id, 'aal2', '22222222-2222-4222-8222-222222222222'); tokens.set(value.access_token, id); return value; },
    hold() { let release; hold = new Promise(resolve => { release = resolve; }); return () => { release(); hold = null; }; },
  };
}
