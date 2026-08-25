import { execFileSync } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';
import { expect, test } from '@playwright/test';

const supabaseUrl = process.env.LOCAL_SUPABASE_URL;
const anonKey = process.env.LOCAL_SUPABASE_ANON_KEY;
const serviceRoleKey = process.env.LOCAL_SUPABASE_SERVICE_ROLE_KEY;
const dockerBin = process.env.LOCAL_DOCKER_BIN;
const postgresContainer = process.env.LOCAL_POSTGRES_CONTAINER;
const runId = `${Date.now()}-${process.pid}`;
const password = 'Local-rehearsal-passphrase-77!';
const accountA = { email: `local-release-a-${runId}@example.test`, name: 'Local Release A' };
const accountB = { email: `local-release-b-${runId}@example.test`, name: 'Local Release B' };
const LOCAL_STATIC_IMAGE_URLS = new Set([
  'https://pub-53499389187a4de4984349b4f9b36b74.r2.dev/5317DC26-DA71-4E5E-8964-01B9EAF033AF.png',
  'https://pub-53499389187a4de4984349b4f9b36b74.r2.dev/photo_1783730958.105418.png',
  'https://pub-53499389187a4de4984349b4f9b36b74.r2.dev/photo_1783734046.5413918.png',
]);
const LOCAL_STATIC_IMAGE = [
  '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200" viewBox="0 0 300 200">',
  '<rect width="300" height="200" fill="#f5f1e8"/>',
  '<path d="M52 142 112 72l40 46 31-35 65 59Z" fill="#172019"/>',
  '<circle cx="224" cy="52" r="20" fill="#c8aa64"/>',
  '</svg>',
].join('');

const admin = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const createdUserIds = new Set();

function webSocketOrigin(httpOrigin) {
  const url = new URL(httpOrigin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.origin;
}

async function installLocalNetworkBoundary(context, { frontendOrigin, localSupabaseOrigin }) {
  const allowedHttpOrigins = new Set([frontendOrigin, localSupabaseOrigin]);
  const allowedWebSocketOrigins = new Set([
    webSocketOrigin(frontendOrigin),
    webSocketOrigin(localSupabaseOrigin),
  ]);
  const unexpectedHostedRequests = [];
  const locallyFulfilledStaticRequests = [];

  await context.route('**/*', async (route) => {
    const request = route.request();
    const requestUrl = new URL(request.url());
    if (allowedHttpOrigins.has(requestUrl.origin)) {
      await route.continue();
      return;
    }

    if (LOCAL_STATIC_IMAGE_URLS.has(requestUrl.href) && request.resourceType() === 'image') {
      locallyFulfilledStaticRequests.push(requestUrl.href);
      await route.fulfill({
        status: 200,
        contentType: 'image/svg+xml',
        body: LOCAL_STATIC_IMAGE,
        headers: { 'cache-control': 'no-store' },
      });
      return;
    }

    unexpectedHostedRequests.push(
      `${request.method()} ${request.resourceType()} ${requestUrl.href}`,
    );
    await route.abort('blockedbyclient');
  });

  await context.routeWebSocket(/^wss?:\/\//, async (webSocket) => {
    const requestUrl = new URL(webSocket.url());
    if (allowedWebSocketOrigins.has(requestUrl.origin)) {
      webSocket.connectToServer();
      return;
    }

    unexpectedHostedRequests.push(`WEBSOCKET websocket ${requestUrl.href}`);
    await webSocket.close({ code: 1008, reason: 'Blocked by local production rehearsal.' });
  });

  return { locallyFulfilledStaticRequests, unexpectedHostedRequests };
}

function runLocalSql(sql, variables = {}) {
  const variableArguments = [];
  for (const [name, value] of Object.entries(variables)) {
    if (!/^[a-z][a-z0-9_]*$/.test(name)) {
      throw new Error(`Unsafe local SQL variable name: ${name}`);
    }
    variableArguments.push('--set', `${name}=${value}`);
  }

  return execFileSync(dockerBin, [
    'exec', '-i', postgresContainer,
    'psql', '--username', 'postgres', '--dbname', 'postgres',
    '--set', 'ON_ERROR_STOP=1', '--tuples-only', '--no-align', '--quiet',
    ...variableArguments,
  ], {
    encoding: 'utf8',
    input: sql,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function findLocalUser(email) {
  const id = runLocalSql(
    "select id::text from auth.users where email = :'target_email' order by created_at desc limit 1;",
    { target_email: email },
  );
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    throw new Error(`Local Auth did not create ${email}.`);
  }
  return { id };
}

async function createAccount(account) {
  const { data, error } = await admin.auth.admin.createUser({
    email: account.email,
    password,
    email_confirm: true,
    user_metadata: { name: account.name },
  });
  if (error) throw error;
  createdUserIds.add(data.user.id);
  return data.user;
}

async function grantMembership(user, account, suffix) {
  const subscriptionId = `local-release-${runId}-${suffix}`;
  const membershipSql = `
    insert into public.profiles (user_id, name, email)
    values (:'target_user_id'::uuid, :'target_name', :'target_email')
    on conflict (user_id) do update
      set name = excluded.name, email = excluded.email;

    insert into public.subscriptions (
      user_id, product_key, status, stripe_subscription_id, stripe_price_id,
      current_period_start, current_period_end
    ) values (
      :'target_user_id'::uuid, 'dominion_membership', 'active',
      :'subscription_id', 'price_local_release_rehearsal', now(), now() + interval '30 days'
    );

    insert into public.entitlements (
      user_id, entitlement_key, status, source_type, source_id,
      starts_at, ends_at, metadata
    ) values (
      :'target_user_id'::uuid, 'membership_active', 'active', 'subscription',
      :'subscription_id', now(), now() + interval '30 days', '{"rehearsal":true}'::jsonb
    )
    on conflict (user_id, entitlement_key) do update
      set status = excluded.status,
          source_type = excluded.source_type,
          source_id = excluded.source_id,
          starts_at = excluded.starts_at,
          ends_at = excluded.ends_at,
          metadata = excluded.metadata;
  `;

  runLocalSql(membershipSql, {
    target_user_id: user.id,
    target_name: account.name,
    target_email: account.email,
    subscription_id: subscriptionId,
  });
}

async function userClient(account) {
  const client = createClient(supabaseUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error } = await client.auth.signInWithPassword({
    email: account.email,
    password,
  });
  if (error) throw error;
  return client;
}

async function saveJournalEntry(page, note, win) {
  const form = page.locator('#journalForm');
  await expect(form).toHaveAttribute('aria-busy', 'false');
  await expect(form.getByRole('button', { name: 'Save Private Entry' })).toBeEnabled();
  await form.getByLabel('Date').fill('2026-08-13');
  await form.getByLabel('Mood').selectOption('Focused');
  await form.getByLabel('Energy').selectOption('High');
  await form.getByLabel('What did today reveal?').fill(note);
  await form.getByLabel('Win').fill(win);
  await form.getByRole('button', { name: 'Save Private Entry' }).click();
  await expect(page.locator('#communityFeedback')).toHaveText('Private journal entry saved.');
}

test.beforeAll(async () => {
  const user = await createAccount(accountB);
  await grantMembership(user, accountB, 'b');
});

test.afterAll(async () => {
  for (const userId of createdUserIds) {
    const { error } = await admin.auth.admin.deleteUser(userId);
    if (error) throw error;
  }
});

test('production-shaped frontend uses real local Auth, Postgres, and account RLS with mocks off', async ({ context, page }, testInfo) => {
  const localOrigin = new URL(supabaseUrl).origin;
  const frontendOrigin = new URL(testInfo.project.use.baseURL).origin;
  const networkBoundary = await installLocalNetworkBoundary(context, {
    frontendOrigin,
    localSupabaseOrigin: localOrigin,
  });
  const localServiceRequests = [];
  page.on('request', (request) => {
    if (request.url().startsWith(localOrigin)) localServiceRequests.push(request.url());
  });

  await page.goto('/register.html');
  await page.getByLabel('Name').fill(accountA.name);
  await page.getByLabel('Email').fill(accountA.email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Create account and continue' }).click();
  await expect(page).toHaveURL(/\/billing\.html$/);

  const userA = findLocalUser(accountA.email);
  createdUserIds.add(userA.id);
  await grantMembership(userA, accountA, 'a');
  await page.reload();
  await expect(page.locator('#billingStatusTitle')).toHaveText('Your Dominion subscription is active.');
  await page.getByRole('link', { name: 'Go to dashboard' }).click();
  await expect(page).toHaveURL(/\/dashboard\.html$/);
  await expect(page.locator('.shared-header-share')).toBeVisible();
  await expect(page.locator('.shared-header-share')).toHaveAccessibleName(/Share/);
  await expect(page.locator('.shared-header-streak')).toHaveAccessibleName(/App streak/);
  await expect(page.locator('#challengeStartGate')).toBeVisible();

  const mockState = await page.evaluate(() => ({
    mockUserId: localStorage.getItem('dominion:mockUserId'),
    mockSubscription: localStorage.getItem('dominion:mockSubscription'),
    previewState: localStorage.getItem('dominion:previewUserStateByOwner'),
  }));
  expect(mockState).toEqual({ mockUserId: null, mockSubscription: null, previewState: null });

  await page.goto('/private-journal.html');
  const privateNote = `Only account A can read ${runId}`;
  await saveJournalEntry(page, privateNote, 'Account A journal proof');
  await expect(page.locator('#journalTimeline')).toContainText(privateNote);
  const clientA = await userClient(accountA);
  const { data: accountARows, error: accountAReadError } = await clientA
    .from('journal_entries')
    .select('id, user_id, entry_date, note, win, mood, energy')
    .eq('user_id', userA.id)
    .eq('note', privateNote);
  if (accountAReadError) throw accountAReadError;
  expect(accountARows).toEqual([{
    id: accountARows[0]?.id,
    user_id: userA.id,
    entry_date: '2026-08-13',
    note: privateNote,
    win: 'Account A journal proof',
    mood: 'Focused',
    energy: 'High',
  }]);

  await page.getByRole('button', { name: 'Open menu' }).click();
  await page.getByRole('button', { name: 'Log Out' }).click();
  await expect(page).toHaveURL(/\/index\.html$/);
  await page.goto('/login.html');
  await page.getByLabel('Email').fill(accountB.email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Go to dashboard' }).click();
  await expect(page).toHaveURL(/\/dashboard\.html$/);
  await expect(page.locator('.shared-header-share')).toHaveCount(1);
  await expect(page.locator('.shared-header-streak')).toHaveCount(1);

  await page.goto('/private-journal.html');
  await expect(page.locator('#journalTimeline')).not.toContainText(privateNote);
  const accountBNote = `Only account B can read ${runId}`;
  await saveJournalEntry(page, accountBNote, 'Account B journal proof');
  await expect(page.locator('#journalTimeline')).toContainText(accountBNote);
  await expect(page.locator('#journalTimeline')).not.toContainText(privateNote);

  const clientB = await userClient(accountB);
  const { data: forbiddenRows, error: forbiddenReadError } = await clientB
    .from('journal_entries')
    .select('id, note')
    .eq('id', accountARows[0].id);
  expect(forbiddenReadError).toBeNull();
  expect(forbiddenRows).toEqual([]);
  const { data: forbiddenUpdate, error: forbiddenUpdateError } = await clientB
    .from('journal_entries')
    .update({ note: 'Cross-account overwrite must not happen.' })
    .eq('id', accountARows[0].id)
    .select('id');
  expect(forbiddenUpdateError).toBeNull();
  expect(forbiddenUpdate).toEqual([]);

  expect(localServiceRequests.some((url) => url.includes('/auth/v1/'))).toBe(true);
  expect(localServiceRequests.some((url) => url.includes('/rest/v1/'))).toBe(true);
  expect(networkBoundary.unexpectedHostedRequests).toEqual([]);
  expect(networkBoundary.locallyFulfilledStaticRequests.length).toBeGreaterThan(0);
  expect(new Set(networkBoundary.locallyFulfilledStaticRequests)).toEqual(
    LOCAL_STATIC_IMAGE_URLS,
  );
});
