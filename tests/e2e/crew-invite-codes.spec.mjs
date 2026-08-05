import { createRequire } from 'node:module';

import { expect, test, expectNoHorizontalOverflow } from './support/app-test.mjs';
import { FIXED_USER_ID } from './support/fixtures.mjs';
import { ROUTE_BY_ID } from './support/routes.mjs';
import {
  analyzeAccessibility,
  assertNoBlockingAxeViolations,
} from './support/quality-gates.mjs';

const require = createRequire(import.meta.url);
const JS_QR_PATH = require.resolve('jsqr');
const ACTIVE_SUBSCRIPTION_KEY = 'dominion:mockSubscription';
const OWNER_STATE_KEY = 'dominion:previewUserStateByOwner';

async function installShareHarness(page) {
  await page.addInitScript(() => {
    window.__dominionShareMode = 'success';
    window.__dominionSharePayload = null;
    Object.defineProperty(navigator, 'canShare', {
      configurable: true,
      value: ({ files } = {}) => Array.isArray(files)
        && files.length === 1
        && files[0] instanceof File
        && files[0].type === 'image/png',
    });
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: async (payload = {}) => {
        if (window.__dominionShareMode === 'cancel') {
          throw new DOMException('Canceled by the user.', 'AbortError');
        }
        if (window.__dominionShareMode === 'fail') {
          throw new DOMException('Sharing is unavailable.', 'DataError');
        }
        window.__dominionSharePayload = {
          title: payload.title || '',
          text: payload.text || '',
          url: payload.url || '',
          files: Array.from(payload.files || [], (file) => ({
            name: file.name,
            type: file.type,
            size: file.size,
          })),
        };
      },
    });
  });
}

async function openInviteDialog(page, app, { theme = 'dark', state = 'member' } = {}) {
  await app.open(ROUTE_BY_ID.community, { theme, state });
  const trigger = page.getByRole('button', { name: 'Invite People' });
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: 'Invite People' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Generate invitation' })).toBeEnabled();
  return dialog;
}

async function generateInvite(dialog) {
  await dialog.getByRole('button', { name: 'Generate invitation' }).click();
  await expect(dialog.getByRole('tab', { name: 'Link' })).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'One invitation is active' })).toBeVisible();
  await expect(dialog.getByRole('status')).toContainText('Invitation ready');
}

async function decodeQr(page) {
  await page.addScriptTag({ path: JS_QR_PATH });
  return page.locator('#crewInviteQrCanvas').evaluate((canvas) => {
    const context = canvas.getContext('2d', { willReadFrequently: true });
    const image = context.getImageData(0, 0, canvas.width, canvas.height);
    return window.jsQR(image.data, image.width, image.height, {
      inversionAttempts: 'dontInvert',
    })?.data || '';
  });
}

test('one issue action creates matching Link, Code, and locally decodable QR representations', async ({ context, page, app }) => {
  await installShareHarness(page);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const dialog = await openInviteDialog(page, app);
  const externalRequests = [];
  const localOrigin = new URL(page.url()).origin;
  page.on('request', (request) => {
    const url = request.url();
    if (/^https?:/.test(url) && new URL(url).origin !== localOrigin) externalRequests.push(url);
  });

  await generateInvite(dialog);
  expect(externalRequests).toEqual([]);

  const link = await dialog.getByLabel('Private crew join link').inputValue();
  const parsedLink = new URL(link);
  expect(parsedLink.pathname).toBe('/invite.html');
  expect(parsedLink.search).toBe('');
  expect(parsedLink.hash).toMatch(/^#invite=[A-Za-z0-9_-]{16,256}$/);

  await dialog.getByRole('button', { name: 'Copy link' }).first().click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(link);

  await dialog.getByRole('button', { name: 'Share link' }).click();
  await expect(dialog.getByRole('status')).toContainText('Invitation shared');
  expect(await page.evaluate(() => window.__dominionSharePayload)).toMatchObject({
    title: 'Join Steady Hands',
    url: link,
    files: [],
  });

  await dialog.getByRole('tab', { name: 'Code' }).click();
  const code = (await dialog.locator('#crewInviteCodeValue').textContent()).trim();
  expect(code).toMatch(/^[34679ACDEFGHJKMNPQRTUVWXY]{4}(?:-[34679ACDEFGHJKMNPQRTUVWXY]{4}){3}$/);
  await dialog.getByRole('button', { name: 'Copy code' }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(code);

  const storage = await page.evaluate(async ({ groupedCode, inviteLink }) => {
    const invitesText = localStorage.getItem('dominion:mockCrewInvites') || '{}';
    const invites = JSON.parse(invitesText);
    const invite = Object.values(invites)[0];
    const normalized = groupedCode.replaceAll('-', '');
    const digestBytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalized));
    const digest = [...new Uint8Array(digestBytes)]
      .map((value) => value.toString(16).padStart(2, '0'))
      .join('');
    const token = new URL(inviteLink).hash.slice('#invite='.length);
    return { invite, invitesText, digest, token };
  }, { groupedCode: code, inviteLink: link });
  expect(storage.invite.code_hash).toBe(storage.digest);
  expect(storage.invite.code_hint).toBe(code.replaceAll('-', '').slice(-4));
  expect(storage.invite.token).toBeUndefined();
  expect(storage.invite.code).toBeUndefined();
  expect(storage.invitesText).not.toContain(storage.token);
  expect(storage.invitesText).not.toContain(code.replaceAll('-', ''));

  await dialog.getByRole('tab', { name: 'QR' }).click();
  const qrSize = await dialog.locator('#crewInviteQrCanvas').evaluate((canvas) => ({
    width: canvas.width,
    height: canvas.height,
  }));
  // qrcode aligns the requested 512 CSS pixels to a whole module grid.
  expect(qrSize.width).toBeGreaterThanOrEqual(500);
  expect(qrSize.height).toBe(qrSize.width);
  expect(await decodeQr(page)).toBe(link);

  await dialog.getByRole('button', { name: 'Share QR code' }).click();
  expect(await page.evaluate(() => window.__dominionSharePayload)).toMatchObject({
    files: [{ name: 'dominion-crew-invite.png', type: 'image/png' }],
  });

  const downloadPromise = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Download QR code' }).click();
  expect((await downloadPromise).suggestedFilename()).toBe('dominion-crew-invite.png');
  expect(externalRequests).toEqual([]);
  app.assertNoRuntimeErrors();
});

test('share cancellation and lifecycle cancellation preserve the active invitation until explicit revocation', async ({ page, app }) => {
  await installShareHarness(page);
  const dialog = await openInviteDialog(page, app);
  await generateInvite(dialog);
  const originalLink = await dialog.getByLabel('Private crew join link').inputValue();

  await page.evaluate(() => { window.__dominionShareMode = 'cancel'; });
  await dialog.getByRole('button', { name: 'Share link' }).click();
  await expect(dialog.getByRole('status')).toContainText('Share canceled');
  await expect(dialog.getByLabel('Private crew join link')).toHaveValue(originalLink);

  await dialog.getByRole('button', { name: 'Replace invitation' }).click();
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog.getByLabel('Private crew join link')).toHaveValue(originalLink);

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.locator('#crewInviteDialog .crew-invite-link-value')).toHaveValue('');
  await page.getByRole('button', { name: 'Invite People' }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'One invitation is active' })).toBeVisible();
  await expect(dialog.getByRole('tab', { name: 'Link' })).toBeHidden();

  await dialog.getByRole('button', { name: 'Revoke invitation' }).click();
  await dialog.getByRole('button', { name: 'Revoke invitation' }).last().click();
  await expect(dialog.getByRole('status')).toContainText('Invitation revoked');
  await expect(dialog.getByRole('button', { name: 'Generate invitation' })).toBeVisible();
  await expect(dialog.getByRole('tab', { name: 'Link' })).toBeHidden();
  const revoked = await page.evaluate(() => Object.values(
    JSON.parse(localStorage.getItem('dominion:mockCrewInvites') || '{}'),
  )[0]);
  expect(revoked.revoked_at).toBeTruthy();
});

test('a signed-out recipient can enter the code, authenticate through the fixed continuation, and explicitly join once', async ({ page, app }) => {
  const dialog = await openInviteDialog(page, app);
  await generateInvite(dialog);
  await dialog.getByRole('tab', { name: 'Code' }).click();
  const code = (await dialog.locator('#crewInviteCodeValue').textContent()).trim();

  await page.evaluate(() => {
    localStorage.removeItem('dominion:user');
    localStorage.removeItem('dominion:mockUserId');
  });
  await page.goto(`/invite.html#code=${encodeURIComponent(code.toLowerCase().replaceAll('-', ' '))}`, {
    waitUntil: 'networkidle',
  });
  await expect(page).toHaveURL(/\/invite\.html$/);
  await expect(page.locator('#inviteTitle')).toHaveText('Join Steady Hands?');
  await expect(page.locator('#invitePreview')).toContainText('Jordan');
  await expect(page.getByRole('button', { name: /confirm and join/i })).toBeHidden();
  const beforeLogin = await page.evaluate(() => (
    JSON.parse(localStorage.getItem('dominion:mockCrewMembers') || '{}').crew_e2e_alpha
  ));
  expect(beforeLogin).toHaveLength(2);

  const loginLink = page.getByRole('link', { name: 'Log in to continue' });
  await expect(loginLink).toHaveAttribute('href', './login.html?returnTo=.%2Finvite.html');
  await loginLink.click();
  await app.stable();
  expect(page.url()).not.toContain(code.replaceAll('-', ''));
  await page.getByLabel('Email').fill('recipient@example.test');
  await page.getByLabel('Password').fill('correct-horse-battery-staple');
  await page.getByRole('button', { name: 'Go to Dashboard' }).click();
  await expect(page).toHaveURL(/\/invite\.html$/);
  await expect(page.locator('#inviteTitle')).toHaveText('Activate membership to join.');

  const recipientId = await page.evaluate(({ ownerStateKey, subscriptionKey }) => {
    const actorId = localStorage.getItem('dominion:mockUserId');
    const subscription = JSON.parse(localStorage.getItem(subscriptionKey) || 'null');
    const owners = JSON.parse(localStorage.getItem(ownerStateKey) || '{}');
    owners[actorId] = { ...(owners[actorId] || {}), [subscriptionKey]: subscription };
    localStorage.setItem(ownerStateKey, JSON.stringify(owners));
    return actorId;
  }, { ownerStateKey: OWNER_STATE_KEY, subscriptionKey: ACTIVE_SUBSCRIPTION_KEY });
  expect(recipientId).toBeTruthy();
  expect(recipientId).not.toBe(FIXED_USER_ID);

  await page.reload({ waitUntil: 'networkidle' });
  const confirm = page.getByRole('button', { name: 'Confirm and join group' });
  await expect(confirm).toBeVisible();
  await confirm.click();
  await expect(page.locator('#inviteTitle')).toHaveText('You joined Steady Hands.');

  const after = await page.evaluate((actorId) => ({
    memberships: JSON.parse(localStorage.getItem('dominion:mockCrewMembers') || '{}')
      .crew_e2e_alpha.filter((member) => member.userId === actorId),
    attributions: Object.values(JSON.parse(
      localStorage.getItem('dominion:mockCrewInviteAttributions') || '{}',
    )).filter((item) => item.recipient_user_id === actorId),
    continuation: sessionStorage.getItem('dominion:crewInviteContinuation'),
  }), recipientId);
  expect(after.memberships).toHaveLength(1);
  expect(after.attributions).toHaveLength(1);
  expect(after.continuation).toBeNull();

  await page.evaluate(() => {
    localStorage.removeItem('dominion:user');
    localStorage.removeItem('dominion:mockUserId');
  });
  // A query marker forces a fresh document instead of a same-document hash
  // navigation; the invite capture strips credentials but preserves this safe marker.
  await page.goto(`/invite.html?attempt=2#code=${encodeURIComponent(code)}`, { waitUntil: 'networkidle' });
  await expect(page.locator('#inviteTitle')).toHaveText('This invitation is not valid.');
  await expect(page.locator('#invitePreview')).toBeHidden();
});

test('the no-crew Join action opens a focused code form with mobile-size targets', async ({ page, app }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await app.open(ROUTE_BY_ID.community, { state: 'communityEmpty' });
  const join = page.getByRole('button', { name: 'Join a Crew' });
  const joinBox = await join.boundingBox();
  expect(joinBox.height).toBeGreaterThanOrEqual(44);
  await join.click();
  await expect(page).toHaveURL(/\/invite\.html$/);
  await expect(page.getByLabel('16-character crew join code')).toBeFocused();
  const inputBox = await page.getByLabel('16-character crew join code').boundingBox();
  expect(inputBox.height).toBeGreaterThanOrEqual(44);
  await expectNoHorizontalOverflow(page);
});

for (const theme of ['light', 'dark', 'dominion-night']) {
  test(`the generated invitation dialog is accessible and responsive in ${theme}`, async ({ page, app }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const dialog = await openInviteDialog(page, app, { theme });
    await generateInvite(dialog);
    await dialog.getByRole('tab', { name: 'QR' }).click();
    await expect(dialog.locator('#crewInviteQrCanvas')).toBeVisible();
    for (const button of await dialog.getByRole('button').all()) {
      if (!await button.isVisible()) continue;
      const box = await button.boundingBox();
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
    assertNoBlockingAxeViolations(await analyzeAccessibility(page));
    await expectNoHorizontalOverflow(page);
  });
}
