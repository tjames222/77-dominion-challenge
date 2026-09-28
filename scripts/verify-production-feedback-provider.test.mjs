import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { FEEDBACK_PROVIDER_TARGET as target, verifyProductionFeedbackProvider } from './verify-production-feedback-provider.mjs';

const apiKey = `lin_api_${'fixture'.repeat(8)}`;
const privateSentinel = 'PRIVATE_PROVIDER_OR_CREDENTIAL_SENTINEL';
const denied = operation => assert.rejects(operation, error => error instanceof Error
  && error.message === 'Production feedback provider could not be verified.' && error.cause === undefined);
function body() {
  return { data: {
    team: { id: target.teamId, name: target.teamName, key: target.teamKey, archivedAt: null },
    project: { id: target.projectId, name: target.projectName, archivedAt: null, trashed: false,
      teams: { nodes: [{ id: target.teamId }], pageInfo: { hasNextPage: false } } },
    issueLabel: { id: target.labelId, name: target.labelName, archivedAt: null, isGroup: false, team: { id: target.teamId } },
  } };
}
function fixture(responseBody = body()) {
  const calls = [];return { calls, options: { apiKey, fetchImpl: async (url, init) => {
    calls.push({ url, init });return new Response(JSON.stringify(responseBody));
  } } };
}

test('probe uses only the dedicated key, fixed metadata-only query and exact production target', async () => {
  const f = fixture();const result = await verifyProductionFeedbackProvider(f.options);
  assert.deepEqual(result, { verified: true, readOnly: true, writePermissionVerified: false });assert(Object.isFrozen(result));
  assert.equal(f.calls.length, 1);const { url, init } = f.calls[0];assert.equal(url, 'https://api.linear.app/graphql');
  assert.equal(init.method, 'POST');assert.equal(init.redirect, 'error');assert.equal(init.cache, 'no-store');assert(init.signal instanceof AbortSignal);
  assert.deepEqual(init.headers, { Authorization: apiKey, 'Content-Type': 'application/json', Accept: 'application/json' });
  const request = JSON.parse(init.body);assert.match(request.query, /^query VerifyDominionFeedbackProvider\(/);
  assert.doesNotMatch(request.query, /\b(mutation|viewer|users|issues|description|email|issueCreate|commentCreate)\b/);
  assert.deepEqual(request.variables, { teamId: target.teamId, teamFilterId: target.teamId, projectId: target.projectId, labelId: target.labelId });
  assert(!JSON.stringify(result).includes(target.teamId));assert(!JSON.stringify(result).includes(apiKey));
});
test('probe pins the exact worker and renderer IDs without a second mutable configuration', async () => {
  const linear = await readFile(new URL('../supabase/functions/_shared/feedback_linear.ts', import.meta.url), 'utf8');
  const renderer = await readFile(new URL('../supabase/functions/_shared/feedback_event_renderer.ts', import.meta.url), 'utf8');
  assert.equal(linear.match(/export const FEEDBACK_LINEAR_TEAM\s*=\s*"([^"]+)";/)?.[1], target.teamId);
  assert.equal(linear.match(/export const FEEDBACK_LINEAR_PROJECT\s*=\s*"([^"]+)";/)?.[1], target.projectId);
  assert.equal(renderer.match(/export const EARLY_ACCESS_FEEDBACK_LABEL\s*=\s*"([^"]+)";/)?.[1], target.labelId);
  assert(Object.isFrozen(target));
});
test('a workspace-wide existing label remains valid for the fixed team', async () => {
  const b = body();b.data.issueLabel.team = null;b.data.project.trashed = null;
  assert.equal((await verifyProductionFeedbackProvider(fixture(b).options)).verified, true);
});
test('missing dedicated key, malformed input or fallback assistant credential cannot trigger network', async () => {
  for (const patch of [{ apiKey: '' }, { apiKey: 'short' }, { apiKey: ` ${apiKey}` }, { apiKey: `${apiKey}\n` },
    { apiKey: 'x'.repeat(513) }, { apiKey: `${apiKey}\u007f` }, { requestTimeoutMs: 0 }, { requestTimeoutMs: 10001 }, { requestTimeoutMs: 1.5 }]) {
    await denied(() => verifyProductionFeedbackProvider({ apiKey, ...patch, fetchImpl: () => assert.fail('Must not request') }));
  }
  const script = new URL('./verify-production-feedback-provider.mjs', import.meta.url);
  const result = spawnSync(process.execPath, [script.pathname], { encoding: 'utf8', timeout: 3000,
    env: { PATH: process.env.PATH, LINEAR_API_KEY: apiKey, LINEAR_ACCESS_TOKEN: apiKey, LINEAR_FEEDBACK_API_KEY: '' } });
  assert.equal(result.status, 1);assert.equal(result.stdout, '');
  assert.equal(result.stderr.trim(), 'Production feedback provider could not be verified.');
});
test('team/project/label drift, archive, wrong relation and malformed pagination fail closed', async () => {
  const changes = [
    b => { b.data.team = null; }, b => { b.data.team.id = target.projectId; }, b => { b.data.team.name = 'Other'; },
    b => { b.data.team.key = 'OTHER'; }, b => { b.data.team.archivedAt = '2026-01-01'; }, b => { delete b.data.team.archivedAt; },
    b => { b.data.project.id = target.teamId; }, b => { b.data.project.name = 'Other'; }, b => { b.data.project.archivedAt = '2026-01-01'; },
    b => { b.data.project.trashed = true; }, b => { delete b.data.project.trashed; },
    b => { b.data.project.teams.nodes = []; }, b => { b.data.project.teams.nodes.push({ id: target.teamId }); },
    b => { b.data.project.teams.nodes[0].id = target.projectId; }, b => { b.data.project.teams.pageInfo.hasNextPage = true; },
    b => { b.data.project.teams.pageInfo = {}; }, b => { b.data.issueLabel.id = target.projectId; },
    b => { b.data.issueLabel.name = 'Other'; }, b => { b.data.issueLabel.team.id = target.projectId; },
    b => { b.data.issueLabel.archivedAt = '2026-01-01'; }, b => { b.data.issueLabel.isGroup = true; },
    b => { delete b.data.issueLabel.team; }, b => { b.data = []; },
  ];
  for (const change of changes) { const b = body();change(b);const f = fixture(b);await denied(() => verifyProductionFeedbackProvider(f.options));assert.equal(f.calls.length, 1); }
});
test('partial GraphQL failures are rejected even with otherwise valid data and HTTP200', async () => {
  for (const errors of [[{ message: privateSentinel }], null, privateSentinel, {}]) {
    const b = body();b.errors = errors;await denied(() => verifyProductionFeedbackProvider(fixture(b).options));
  }
  const b = body();b.errors = [];assert.equal((await verifyProductionFeedbackProvider(fixture(b).options)).verified, true);
});
test('HTTP errors, redirects, malformed payloads and secret provider errors remain fixed', async () => {
  for (const status of [201, 204, 301, 401, 403, 429, 500]) {
    await denied(() => verifyProductionFeedbackProvider({ apiKey, fetchImpl: async () => new Response(status === 204 ? null : privateSentinel, { status }) }));
  }
  const redirected = new Response(JSON.stringify(body()));Object.defineProperty(redirected, 'redirected', { value: true });
  await denied(() => verifyProductionFeedbackProvider({ apiKey, fetchImpl: async () => redirected }));
  for (const value of ['not-json', 'null', '[]', JSON.stringify({ private: privateSentinel })]) {
    await denied(() => verifyProductionFeedbackProvider({ apiKey, fetchImpl: async () => new Response(value) }));
  }
  await denied(() => verifyProductionFeedbackProvider({ apiKey, fetchImpl: async () => { throw new Error(`${privateSentinel}:${apiKey}`); } }));
});
test('chunked and declared response sizes cannot bypass the32KiB memory bound', async () => {
  const oversized = JSON.stringify({ ...body(), extra: 'x'.repeat(32768) });
  for (const chunked of [false, true]) {
    let cancelled = false;const stream = new ReadableStream({
      start(controller) { for (let i = 0; i < oversized.length; i += 1024) controller.enqueue(new TextEncoder().encode(oversized.slice(i, i + 1024))); },
      cancel() { cancelled = true; },
    });
    await denied(() => verifyProductionFeedbackProvider({ apiKey, fetchImpl: async () => new Response(chunked ? stream : oversized, { headers: { 'Content-Length': '1' } }) }));
    if (chunked) assert(cancelled);
  }
});
test('transport and streamed body deadlines complete even when provider ignores abort', async () => {
  for (const streamed of [false, true]) {
    let signal;let cancelled = false;
    await denied(() => verifyProductionFeedbackProvider({ apiKey, requestTimeoutMs: 5, fetchImpl: async (_url, init) => {
      signal = init.signal;return streamed ? new Response(new ReadableStream({ cancel() { cancelled = true; } })) : new Promise(() => {});
    } }));
    assert.equal(signal.aborted, true);if (streamed) assert(cancelled);
  }
});
test('invalid UTF8 and abruptly failed response streams reveal no provider text', async () => {
  for (const response of [new Response(Uint8Array.of(0xff, 0xfe)), new Response(new ReadableStream({ start(controller) { controller.error(new Error(privateSentinel)); } }))]) {
    await denied(() => verifyProductionFeedbackProvider({ apiKey, fetchImpl: async () => response }));
  }
});
