import { test as base, expect } from '@playwright/test';

export const HARNESS = '/tests/e2e/fixtures/preview-badges.html';
export const RUNTIME = /\/assets\/badge-preview-state-[^/]+\.js(?:\?.*)?$/;
export const deferred = () => {
  let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve };
};
export const test = base.extend({
  traffic: [async ({ context, baseURL }, use) => {
    const unexpected = []; const provider = []; const errors = []; const sockets = [];
    context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
    context.on('request', request => {
      const url = new URL(request.url());
      if (url.pathname.startsWith('/__fou_1452_supabase__/')) provider.push(request.method() + ' ' + url.pathname);
    });
    await context.route('**/*', async route => {
      const request = route.request(); const url = new URL(request.url());
      if (url.origin !== new URL(baseURL).origin) {
        unexpected.push(request.method() + ' ' + url.href); await route.abort(); return;
      }
      if (request.method() !== 'GET' || url.pathname.startsWith('/__fou_1452_supabase__/')) {
        unexpected.push(request.method() + ' ' + url.pathname); await route.abort(); return;
      }
      await route.continue();
    });
    await context.routeWebSocket('**/*', socket => {
      const url = new URL(socket.url()); const origin = new URL(baseURL);
      // Vite's local development HMR connection is unrelated to Auth. It is
      // closed locally, not forwarded; all other sockets remain a failure.
      if (!(url.hostname === origin.hostname && url.port === origin.port && url.searchParams.has('token'))) sockets.push(socket.url());
      socket.close();
    });
    await use({ provider });
    expect(unexpected, 'no hosted traffic or unhandled local provider route').toEqual([]);
    expect(sockets, 'no application WebSockets').toEqual([]);
    expect(errors, 'no unhandled browser errors').toEqual([]);
  }, { auto: true }],
});
export { expect };

export async function openHarness(page) {
  await page.goto(HARNESS);
  await expect.poll(() => page.evaluate(() => Boolean(window.__previewBadgeTest))).toBe(true);
}
export async function signInMock(page, email = 'alpha.badges@example.test') {
  return page.evaluate(email => window.__previewBadgeTest.api.saveLocalMockUser({ name: 'Badge Member', email }).userId, email);
}
export async function stateFor(page, owner) {
  return page.evaluate(owner => window.__previewBadgeTest.peekPreviewUserValue(localStorage, owner, 'dominion:badgeState:v1', null), owner);
}
export async function startCheckIn(page, owner, completed = ['walk']) {
  await page.evaluate(({ owner, completed }) => {
    window.pendingBadgeOperation = window.__previewBadgeTest.api.recordPreviewCheckInBadges({
      date: '2026-02-14', day: 14, completed, createdAt: '2026-02-14T17:30:00Z',
      workoutDifficultySelections: { two: 'hard' },
    }, { expectedUserId: owner }).then(value => ({ ok: true, value }), error => ({ ok: false, error: error.message }));
  }, { owner, completed });
}
export async function finishOperation(page) {
  return page.evaluate(() => window.pendingBadgeOperation);
}
