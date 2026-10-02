import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { installFeedbackStub } from './support/feedback-supabase-stub.mjs';
import { FEEDBACK_ROUTES } from '../../src/static/feedback-route.mjs';
const widget = page => page.locator('[data-feedback-widget]');
const dialog = page => page.getByRole('dialog', { name: 'Send Feedback', exact: true });
const optional = /\/(?:feedback-(?:client|contract|context|dialog|widget))(?:-[\w-]+)?\.(?:mjs|js|css)(?:\?|$)/;
async function repeatSessionNotice(page, auth) {
  await page.waitForLoadState('networkidle');
  const before = auth.calls.filter(call => call.name === 'get_member_access_context').length;
  await page.evaluate(value => { const channel = new BroadcastChannel('sb-127-auth-token'); channel.postMessage({ event: 'SIGNED_IN', session: value }); channel.close(); }, auth.firstSession);
  await expect.poll(() => auth.calls.filter(call => call.name === 'get_member_access_context').length).toBeGreaterThan(before);
}
async function ready(page) {
  await page.goto('/profile.html'); await expect(widget(page)).toHaveCount(1);
  await reachableBottom(page);
}
async function reachableBottom(page) {
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  // The fixture can finish page hydration after feedback becomes eligible.
  // Model a user reaching the current bottom, not a smooth scroll to a stale
  // document height. Do not require network-idle: member pages can refresh.
  await expect.poll(async () => page.evaluate(async () => {
    window.scrollTo({ top: document.body.scrollHeight, left: 0, behavior: 'instant' });
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return Math.abs(document.documentElement.scrollHeight - (window.scrollY + window.innerHeight)) <= 1;
  })).toBe(true);
  await expect(widget(page)).toBeVisible();
}
async function fill(page) {
  await page.getByRole('combobox', { name: 'Feedback type', exact: true }).selectOption('bug');
  await page.getByLabel('What happened or what would you like to change?', { exact: false }).fill('  My explicit feedback\n');
  await page.getByLabel('Expected or desired behavior', { exact: false }).fill('Original expected behavior');
  await page.getByRole('combobox', { name: 'Impact', exact: true }).selectOption('minor');
}
async function expectVisibleReceipt(page) {
  const receipt = page.locator('.feedback-confirmation');
  await expect(receipt).toBeVisible(); await expect(receipt).toBeFocused();
  await expect(receipt.getByRole('heading', { name: 'Feedback submitted' })).toBeVisible();
  await expect(receipt).toContainText('Your feedback is saved.');
  await expect(receipt).toContainText('no need to submit it again');
  await expect(page.locator('.feedback-editor')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Close', exact: true })).toBeVisible();
  // No scroll helper here: success itself must reveal the complete receipt
  // and action, not merely leave them somewhere in the scrollable dialog.
  for (const element of [receipt, page.getByRole('button', { name: 'Close', exact: true })]) {
    await expect.poll(() => element.evaluate(node => {
      const rect = node.getBoundingClientRect();
      const viewport = window.visualViewport;
      const top = viewport?.offsetTop || 0; const left = viewport?.offsetLeft || 0;
      const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      return rect.top >= top && rect.left >= left
        && rect.bottom <= top + (viewport?.height || innerHeight)
        && rect.right <= left + (viewport?.width || innerWidth)
        && (hit === node || node.contains(hit));
    })).toBe(true);
  }
}
async function contactGeometry(page) {
  const check = page.getByRole('checkbox', { name: 'You may contact me about this feedback.', exact: true });
  const label = page.getByText('You may contact me about this feedback.', { exact: true });
  await label.scrollIntoViewIfNeeded();
  const control = await check.boundingBox(), text = await label.boundingBox(), panel = await dialog(page).boundingBox();
  expect(control.width).toBeGreaterThanOrEqual(16); expect(control.width).toBeLessThanOrEqual(24);
  expect(text.x).toBeGreaterThan(control.x + control.width);
  expect(text.x + text.width).toBeLessThanOrEqual(panel.x + panel.width - 8);
  expect(await page.locator('.feedback-form').evaluate(form => form.scrollWidth <= form.clientWidth + 1)).toBe(true);
}
test.beforeEach(async ({ context, page, baseURL }) => {
  const external = [], errors = [];
  await context.route('**/*', route => {
    if (new URL(route.request().url()).origin !== baseURL) { external.push(route.request().url()); return route.abort(); }
    return route.fallback();
  });
  await context.routeWebSocket(/.*/, ws => { external.push('websocket'); ws.close(); });
  page.on('pageerror', error => errors.push(error.message));
  page.__feedbackChecks = { external, errors };
});
test.afterEach(async ({ page }) => { expect(page.__feedbackChecks.external).toEqual([]); expect(page.__feedbackChecks.errors).toEqual([]); });
test('active EA saves exact explicit input and allowlisted context without collecting surrounding content', async ({ context, page }) => {
  const auth = await installFeedbackStub(context); await ready(page);
  await page.evaluate(() => { const text = document.createElement('textarea'); text.value = 'PRIVATE PAGE SENTINEL'; document.body.append(text); sessionStorage.setItem('private-sentinel', 'PRIVATE STORAGE SENTINEL'); });
  await widget(page).click(); await fill(page);
  await repeatSessionNotice(page, auth);
  await expect(page.getByLabel('What happened or what would you like to change?', { exact: false })).toHaveValue('  My explicit feedback\n');
  await page.getByRole('button', { name: 'Send feedback', exact: true }).click();
  await expect(dialog(page)).toContainText('Your feedback is saved.');
  await expectVisibleReceipt(page);
  expect(auth.writes()).toHaveLength(1); const body = auth.writes()[0].body;
  expect(body.target_input).toEqual({ type: 'bug', description: '  My explicit feedback\n', expectedBehavior: 'Original expected behavior', impact: 'minor', contactAllowed: false });
  expect(Object.keys(body.target_context).sort()).toEqual(['browser', 'buildSha', 'platform', 'route', 'theme', 'viewport']);
  expect(body.target_context.route).toBe('profile.html'); expect(body.target_context.buildSha).toBe('a'.repeat(40));
  expect(JSON.stringify(body)).not.toMatch(/PRIVATE PAGE|PRIVATE STORAGE|userAgent|email|url|referrer/);
  await page.getByRole('button', { name: 'Close', exact: true }).click(); await expect(widget(page)).toBeFocused();
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain('My explicit feedback');
});
for (const options of [{ active: false }, { malformed: true }, { aal: 'aal1' }]) test(`feedback stays hidden for ${JSON.stringify(options)}`, async ({ context, page }) => {
  const auth = await installFeedbackStub(context, options);
  await context.addInitScript(() => localStorage.setItem('dominion:earlyAccessActive', 'true'));
  await page.goto('/profile.html');
  if (options.aal === 'aal1') await expect(page.getByRole('heading', { name: 'Verify your login', exact: true })).toBeVisible();
  else { await expect(page.locator('.global-menu-button')).toBeVisible(); await expect.poll(() => auth.calls.length).toBeGreaterThan(0); }
  await expect(widget(page)).toHaveCount(0); expect(auth.writes()).toEqual([]);
});
test('public, login, Security, Admin and invite routes never load or submit feedback', async ({ context, page }) => {
  const auth = await installFeedbackStub(context); const requested = [];
  page.on('request', request => { if (optional.test(request.url())) requested.push(request.url()); });
  for (const route of ['/index.html', '/support.html', '/login.html', '/account-security.html', '/admin.html', '/invite.html']) {
    await page.goto(route); await page.waitForLoadState('networkidle'); await expect(widget(page)).toHaveCount(0);
  }
  // Signed-in navigation may use the shared, read-only access RPC to choose
  // its destination. It must not load feedback code or submit anything.
  expect(requested).toEqual([]); expect(auth.writes()).toEqual([]);
  for (const call of auth.calls) {
    expect(call.name).toBe('get_member_access_context'); expect(call.method).toBe('POST');
    expect(call.body).toEqual({ target_expected_actor_id: auth.A });
  }
});

test('accepted EA has free access and retained beta pricing without Stripe requests or paid labels', async ({ context, page }, testInfo) => {
  const auth = await installFeedbackStub(context);
  await ready(page);
  await expect(page.locator('#profileBillingTitle')).toHaveText('Early access active');
  await expect(page.locator('#profileBillingCopy')).toContainText('free until beta begins');
  await expect(page.locator('#profileBillingCopy')).toContainText('$3.50/month');
  await expect(page.locator('#profileBillingCopy')).toContainText('cancel and return');
  await page.locator('#profileBillingCopy').scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('early-access-profile.png') });
  await page.goto('/billing.html');
  await expect(page.locator('#billingStatusTitle')).toHaveText('This account has early access.');
  await expect(page.locator('#billingStatusCopy')).toContainText('You do not have a paid subscription through early access.');
  await expect(page.locator('#billingStatusCopy')).toContainText('$3.50/month');
  await expect(page.locator('#subscriptionCheckoutButton')).toHaveCount(1);
  await expect(page.locator('#subscriptionCheckoutButton')).toBeHidden();
  await expect(page.locator('#manageBillingButton')).toBeHidden();
  await page.locator('#billingStatusCopy').scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('early-access-billing.png') });
  expect(auth.requests.filter(request => /subscriptions|checkout|portal|cancel-membership/.test(request.path))).toEqual([]);
});
test('profile feedback stays reachable when content arrives during the first scroll', async ({ context, page }) => {
  const auth = await installFeedbackStub(context);
  await context.addInitScript(() => {
    function addLateContent() {
      if (!window.scrollY || !document.querySelector('[data-feedback-widget]')) return;
      window.removeEventListener('scroll', addLateContent);
      // Model late hydration after the first scroll target was measured. The
      // reserved placement keeps this new action separate without hiding feedback.
      const section = document.createElement('section');
      section.id = 'synthetic-late-profile-content'; section.style.height = '144px';
      const action = document.createElement('button');
      action.type = 'button'; action.textContent = 'Synthetic late profile action';
      Object.assign(action.style, { display: 'block', width: '100%', height: '56px', margin: '0' });
      section.append(action); document.querySelector('main').append(section);
    }
    window.addEventListener('scroll', addLateContent);
  });
  await ready(page);
  await expect(page.locator('#synthetic-late-profile-content')).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => Math.abs(document.documentElement.scrollHeight - (window.scrollY + window.innerHeight)))).toBeLessThanOrEqual(1);
  await expect(widget(page)).toBeVisible();
  await expect(widget(page)).not.toHaveAttribute('data-obstructed');
  const trigger = await widget(page).boundingBox();
  const action = await page.getByRole('button', { name: 'Synthetic late profile action', exact: true }).boundingBox();
  expect(action.x + action.width <= trigger.x || trigger.x + trigger.width <= action.x
    || action.y + action.height <= trigger.y || trigger.y + trigger.height <= action.y).toBe(true);
  expect(auth.writes()).toEqual([]);
});

async function launcherPlacement(page) {
  return widget(page).evaluate(node => {
    const rect = node.getBoundingClientRect();
    const viewport = window.visualViewport;
    const left = viewport?.offsetLeft || 0, top = viewport?.offsetTop || 0;
    const visible = getComputedStyle(node).visibility === 'visible' && !node.hidden;
    const points = [[rect.left + 4, rect.top + 4], [rect.right - 4, rect.top + 4],
      [rect.left + 4, rect.bottom - 4], [rect.right - 4, rect.bottom - 4],
      [rect.left + rect.width / 2, rect.top + rect.height / 2]];
    const hits = points.every(([x, y]) => { const hit = document.elementFromPoint(x, y); return hit === node || node.contains(hit); });
    const header = node.closest('.topbar');
    const headerBottom = header?.getBoundingClientRect().bottom || 0;
    const style = getComputedStyle(node);
    const inset = Number.parseFloat(style.getPropertyValue('--feedback-inset')) || 0;
    const safeRight = Number.parseFloat(style.getPropertyValue('--feedback-safe-right')) || 0;
    const safeBottom = Number.parseFloat(style.getPropertyValue('--feedback-safe-bottom')) || 0;
    const overlaps = [...document.querySelectorAll('main button, main a, main input, main select, main textarea, main summary, main [role="button"]')]
      .filter(control => {
        if (control === node || getComputedStyle(control).visibility !== 'visible') return false;
        // Scrolled content behind the existing sticky header is outside the
        // exposed page area. Every other header control must remain separate.
        return [...control.getClientRects()].some(other => {
          const exposedTop = header && !header.contains(control) ? Math.max(other.top, headerBottom) : other.top;
          return other.width > 0 && other.bottom > exposedTop && other.left < rect.right
            && other.right > rect.left && exposedTop < rect.bottom && other.bottom > rect.top;
        });
      }).length;
    return { visible, hits, overlaps, target: rect.width >= 44 && rect.height >= 44,
      inViewport: rect.left >= left && rect.top >= top && rect.right <= left + (viewport?.width || innerWidth)
        && rect.bottom <= top + (viewport?.height || innerHeight),
      overflow: document.documentElement.scrollWidth > innerWidth + 1,
      fixed: getComputedStyle(node).position === 'fixed', bodyChild: node.parentElement === document.body,
      rightGap: left + (viewport?.width || innerWidth) - rect.right,
      bottomGap: top + (viewport?.height || innerHeight) - rect.bottom,
      inset, safeRight, safeBottom,
      rightSafe: left + (viewport?.width || innerWidth) - rect.right + .5 >= inset + safeRight,
      bottomSafe: top + (viewport?.height || innerHeight) - rect.bottom + .5 >= inset + safeBottom,
      obstructed: node.hasAttribute('data-obstructed'), position: { x: rect.x, y: rect.y } };
  });
}
for (const width of [320, 375, 440, 600, 601, 768, 1440]) test(`launcher never disappears or covers actions while Dashboard scrolls at ${width}px`, async ({ context, page }, testInfo) => {
  await page.setViewportSize({ width, height: width === 320 ? 568 : width === 1440 ? 1000 : 764 });
  const auth = await installFeedbackStub(context, { memberPages: true });
  await page.goto('/dashboard.html'); await expect(widget(page)).toBeVisible();
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  if (width <= 600) {
    expect((await page.locator('main').boundingBox()).width).toBe(width);
    for (const selector of ['.topbar > .back-link', '.countdown-card']) {
      expect(await page.locator(selector).evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    }
  }
  let position;
  for (const fraction of [0, .15, .3, .5, .7, .9, 1, .5, 0]) {
    await page.evaluate(async fraction => {
      scrollTo({ top: (document.documentElement.scrollHeight - innerHeight) * fraction, behavior: 'instant' });
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }, fraction);
    await expect.poll(async () => {
      const result = await launcherPlacement(page);
      return { visible: result.visible, hits: result.hits, overlaps: result.overlaps, target: result.target,
        inViewport: result.inViewport, overflow: result.overflow, fixed: result.fixed, bodyChild: result.bodyChild,
        rightSafe: result.rightSafe, bottomSafe: result.bottomSafe, obstructed: result.obstructed };
    }).toEqual({ visible: true, hits: true, overlaps: 0, target: true, inViewport: true, overflow: false,
      fixed: true, bodyChild: true, rightSafe: true, bottomSafe: true, obstructed: false });
    const current = (await launcherPlacement(page)).position;
    position ||= current; expect(current.x).toBe(position.x);
  }
  await page.screenshot({ path: testInfo.outputPath(`dashboard-launcher-${width}.png`) });
  expect(auth.writes()).toEqual([]);
});
test('Billing restores an expired persisted session without requiring a manual reload', async ({ context, page }) => {
  const auth = await installFeedbackStub(context);
  const expired = structuredClone(auth.firstSession);
  const parts = expired.access_token.split('.');
  const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  expired.expires_at = claims.exp = Math.floor(Date.now() / 1000) - 60;
  parts[1] = Buffer.from(JSON.stringify(claims)).toString('base64url');
  expired.access_token = parts.join('.');
  await context.addInitScript(value => localStorage.setItem('sb-127-auth-token', JSON.stringify(value)), expired);
  let release; const held = new Promise(resolve => { release = resolve; }); let refreshes = 0;
  await context.route(/\/__admin_fixture__\/auth\/v1\/token(?:\?|$)/, async route => {
    refreshes += 1;
    expect(route.request().postDataJSON().refresh_token).toBe(expired.refresh_token);
    await held;
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(auth.firstSession) });
  });
  // The reader import starts only after getBillingState captures its epoch.
  // Keep Auth initialization pending until that original read is in flight.
  const readerRequested = page.waitForResponse(response => /\/member-access-reader-[\w-]+\.js$/.test(response.url()));
  const navigation = page.goto('/billing.html');
  try {
    await readerRequested;
    await expect.poll(() => refreshes).toBe(1);
  } finally { release(); }
  await navigation;
  await expect(page.locator('#billingStatusTitle')).toHaveText('This account has early access.');
  await expect(page.locator('#billingDashboardLink')).toBeVisible();
  expect(refreshes).toBe(1);
  expect(auth.calls.some(call => call.name === 'get_member_access_context')).toBe(true);
  expect(auth.writes()).toEqual([]);
});
test('uncertain receipt retry retains one intent across close, focus refresh and later EA lapse', async ({ context, page }) => {
  const auth = await installFeedbackStub(context); auth.mode('lost'); await ready(page); await widget(page).click(); await fill(page);
  await page.getByRole('button', { name: 'Send feedback', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retry same submission' })).toBeVisible();
  await repeatSessionNotice(page, auth);
  await expect(page.getByRole('button', { name: 'Retry same submission' })).toBeVisible();
  await page.getByRole('button', { name: 'Close for now' }).click(); auth.active(false);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(widget(page)).toHaveAccessibleName('Retry feedback submission'); await widget(page).click();
  await expect(page.getByLabel('What happened or what would you like to change?', { exact: false })).toHaveValue('  My explicit feedback\n');
  await page.getByRole('button', { name: 'Retry same submission' }).click(); await expect(dialog(page)).toContainText('Your feedback is saved.');
  expect(auth.writes()).toHaveLength(2); expect(auth.writes()[0].body).toEqual(auth.writes()[1].body); expect(auth.receipts.size).toBe(1);
  await page.getByRole('button', { name: 'Close', exact: true }).click(); await expect(widget(page)).toBeHidden();
});
test('same-user replacement session synchronously scrubs held submission and late receipt cannot publish', async ({ context, page }) => {
  const auth = await installFeedbackStub(context); await ready(page); await widget(page).click(); await fill(page);
  const release = auth.hold();
  try {
    await page.getByRole('button', { name: 'Send feedback', exact: true }).click(); await expect.poll(() => auth.writes().length).toBe(1);
    const next = auth.replacement();
    const result = await page.evaluate(session => {
      localStorage.setItem('sb-127-auth-token', JSON.stringify(session));
      window.dispatchEvent(new StorageEvent('storage', { key: 'sb-127-auth-token', newValue: JSON.stringify(session) }));
      return { widget: Boolean(document.querySelector('[data-feedback-widget]')), form: Boolean(document.querySelector('.feedback-form')) };
    }, next);
    expect(result).toEqual({ widget: false, form: false }); release();
    await expect(page.locator('body')).not.toHaveAttribute('data-feedback-mounted');
    await expect(page.locator('.feedback-header-slot')).toHaveCount(0);
    await expect(page.locator('.feedback-form')).toHaveCount(0); await expect(page.locator('body')).not.toContainText('Your feedback is saved.');
  } finally { release(); }
});
for (const width of [320, 601, 1440]) test(`all fourteen routes keep feedback reachable through scrolling and late normal-flow actions at ${width}px`, async ({ context, page }) => {
  await page.setViewportSize({ width, height: 764 });
  const auth = await installFeedbackStub(context, { memberPages: true });
  for (const route of FEEDBACK_ROUTES) await test.step(route, async () => {
    await page.goto(`/${route}`); await expect(widget(page)).toHaveCount(1);
    await page.evaluate(() => {
      const button = document.createElement('button'); button.id = 'synthetic-overlap-action'; button.textContent = 'Private synthetic action';
      Object.assign(button.style, { width: '100%', minHeight: '52px' });
      document.querySelector('main').append(button);
    });
    for (const fraction of [0, .5, 1]) {
      await page.evaluate(fraction => scrollTo({ top: (document.documentElement.scrollHeight - innerHeight) * fraction, behavior: 'instant' }), fraction);
      await expect.poll(async () => {
        const result = await launcherPlacement(page);
        return result.visible && result.hits && result.target && result.inViewport && result.overlaps === 0;
      }).toBe(true);
    }
    await page.locator('#synthetic-overlap-action').click();
    await expect(widget(page)).toBeVisible();
  });
  expect(auth.writes()).toEqual([]);
});
test('floating launcher clears a sticky footer and yields to reward or training overlays', async ({ context, page }, testInfo) => {
  const auth = await installFeedbackStub(context, { memberPages: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/dashboard.html'); await expect(widget(page)).toBeVisible();
  const baseline = await launcherPlacement(page);
  expect(Math.abs(baseline.rightGap - baseline.inset - baseline.safeRight)).toBeLessThan(1);
  expect(Math.abs(baseline.bottomGap - baseline.inset - baseline.safeBottom)).toBeLessThan(1);
  await page.evaluate(() => {
    const footer = document.createElement('footer'); footer.id = 'synthetic-sticky-footer';
    footer.dataset.feedbackObstruction = '';
    Object.assign(footer.style, { position: 'fixed', right: '0', bottom: '0', width: '220px', height: '76px', zIndex: '30' });
    const action = document.createElement('button'); action.type = 'button'; action.textContent = 'Sticky test action';
    action.addEventListener('click', () => { document.body.dataset.stickyActionClicked = 'true'; });
    Object.assign(action.style, { width: '100%', height: '100%' }); footer.append(action); document.body.append(footer);
  });
  await expect.poll(async () => {
    const trigger = await widget(page).boundingBox(); const footer = await page.locator('#synthetic-sticky-footer').boundingBox();
    return { clear: trigger.y + trigger.height + 8 <= footer.y, placement: await launcherPlacement(page) };
  }).toMatchObject({ clear: true, placement: { fixed: true, bodyChild: true, obstructed: false } });
  await page.getByRole('button', { name: 'Sticky test action', exact: true }).click();
  await expect(page.locator('body')).toHaveAttribute('data-sticky-action-clicked', 'true');
  await page.locator('#synthetic-sticky-footer').evaluate(node => { node.style.height = '180px'; });
  await expect.poll(async () => {
    const trigger = await widget(page).boundingBox(); const footer = await page.locator('#synthetic-sticky-footer').boundingBox();
    return trigger.y + trigger.height + 8 <= footer.y;
  }).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('floating-feedback-sticky-clearance.png') });
  await page.locator('#synthetic-sticky-footer').evaluate(node => node.remove());
  await expect.poll(async () => (await launcherPlacement(page)).bottomGap).toBe(baseline.bottomGap);
  await page.evaluate(() => {
    const obstruction = document.createElement('div'); obstruction.id = 'synthetic-full-obstruction';
    obstruction.dataset.feedbackObstruction = '';
    Object.assign(obstruction.style, { position: 'fixed', inset: '0', zIndex: '30' }); document.body.append(obstruction);
  });
  await expect(widget(page)).toBeHidden();
  await expect(widget(page)).toHaveAttribute('data-obstructed');
  await page.locator('#synthetic-full-obstruction').evaluate(node => node.remove());
  await expect(widget(page)).toBeVisible();
  await expect(widget(page)).not.toHaveAttribute('data-obstructed');
  await expect.poll(async () => (await launcherPlacement(page)).bottomGap).toBe(baseline.bottomGap);
  await page.evaluate(() => document.body.classList.add('challenge-finished'));
  await widget(page).click();
  const feedbackLayer = page.locator('.app-dialog-layer[data-pattern="feedback"]');
  await expect(feedbackLayer).toBeVisible();
  expect(await feedbackLayer.evaluate(node => getComputedStyle(node).zIndex)).toBe('1185');
  expect(await feedbackLayer.locator('.app-dialog-panel').evaluate(node => {
    const rect = node.getBoundingClientRect(); const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return hit === node || node.contains(hit);
  })).toBe(true);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.evaluate(() => document.body.classList.remove('challenge-finished'));
  for (const className of ['permanent-reward-celebration', 'reward-backdrop active', 'reward-toast active',
    'badge-celebration active', 'crew-training-layer', 'site-training-layer']) {
    await test.step(className, async () => {
      await page.evaluate(value => {
        const layer = document.createElement('div'); layer.id = 'synthetic-feedback-overlay'; layer.className = value; document.body.append(layer);
      }, className);
      await expect(widget(page)).toBeHidden();
      await page.locator('#synthetic-feedback-overlay').evaluate(node => node.remove());
      await expect(widget(page)).toBeVisible();
    });
  }
  await test.step('native modal dialog', async () => {
    await page.evaluate(() => {
      const layer = document.createElement('dialog'); layer.id = 'synthetic-native-dialog'; document.body.append(layer); layer.showModal();
    });
    await expect(widget(page)).toBeHidden();
    await page.locator('#synthetic-native-dialog').evaluate(node => node.close());
    await expect(widget(page)).toBeVisible();
    await page.locator('#synthetic-native-dialog').evaluate(node => node.remove());
  });
  expect(auth.writes()).toEqual([]);
});
test('rotation preserves one launcher, and menu/dialog closing restores the original scroll position', async ({ context, page, isMobile }) => {
  const auth = await installFeedbackStub(context, { memberPages: true });
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto('/dashboard.html'); await expect(widget(page)).toBeVisible();
  await expect(page.locator('#selectAllActionsButton')).toBeEnabled();
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  const pressVisible = async locator => {
    const box = await locator.boundingBox();
    expect(box).not.toBeNull();
    const x = box.x + box.width / 2, y = box.y + box.height / 2;
    expect(await locator.evaluate((node, point) => {
      const hit = document.elementFromPoint(point.x, point.y); return hit === node || node.contains(hit);
    }, { x, y })).toBe(true);
    // Locator.click scrolls sticky descendants before pointerdown in both
    // engines. A user touches the already-visible control without that driver
    // scroll; use its hit-tested coordinates to test the real restoration.
    if (isMobile) await page.touchscreen.tap(x, y);
    else await page.mouse.click(x, y);
  };
  for (const width of [320, 768, 440]) {
    await page.setViewportSize({ width, height: 764 });
    await expect(widget(page)).toHaveCount(1);
    await expect(page.locator('.feedback-header-slot')).toHaveCount(0);
    await expect.poll(async () => ({ fixed: (await launcherPlacement(page)).fixed,
      bodyChild: (await launcherPlacement(page)).bodyChild })).toEqual({ fixed: true, bodyChild: true });
    await page.evaluate(async () => {
      scrollTo({ top: 900, behavior: 'instant' });
      await Promise.all(document.getAnimations().filter(animation =>
        Number.isFinite(animation.effect?.getTiming().iterations)).map(animation => animation.finished.catch(() => {})));
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    // Resize/scroll anchoring can settle a few pixels from the requested
    // coordinate before either overlay opens. Restoration must match the
    // actual original position exactly, not an assumed scrollTo result.
    const originalScroll = await page.evaluate(() => scrollY);
    expect(originalScroll).toBeGreaterThan(800);
    await expect(widget(page)).toBeVisible();
    await pressVisible(widget(page)); await expect(dialog(page)).toBeVisible();
    await expect(widget(page)).toBeHidden();
    await page.keyboard.press('Escape'); await expect(widget(page)).toBeFocused();
    await expect.poll(() => page.evaluate(() => scrollY)).toBe(originalScroll);
    await pressVisible(page.locator('.global-menu-button'));
    await expect(page.locator('.global-menu')).toBeVisible(); await expect(widget(page)).toBeHidden();
    await page.keyboard.press('Escape'); await expect(page.locator('.global-menu')).toBeHidden();
    await expect(widget(page)).toBeVisible();
    await expect.poll(() => page.evaluate(() => scrollY)).toBe(originalScroll);
    expect((await launcherPlacement(page)).hits).toBe(true);
  }
  expect(auth.writes()).toEqual([]);
});
test('rotation and eligibility or owner teardown never change fresh header geometry', async ({ context, page }) => {
  const auth = await installFeedbackStub(context, { memberPages: true, active: false });
  const headerGeometry = target => target.locator('.topbar').evaluate(node => ({
    height: node.getBoundingClientRect().height,
    offset: Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--topbar-sticky-height')),
  }));
  const geometry = () => headerGeometry(page);
  const baseline = new Map();
  // Independent fresh documents avoid replacing a still-live Auth document
  // just to establish layout baselines; member reads need not become idle.
  const freshPhone = await context.newPage();
  freshPhone.on('pageerror', error => page.__feedbackChecks.errors.push(error.message));
  for (const [width, target] of [[440, freshPhone], [768, page]]) {
    await target.setViewportSize({ width, height: 764 }); await target.goto('/dashboard.html');
    await expect(target.locator('.authenticated-header-actions')).toBeVisible();
    await expect(target.locator('#selectAllActionsButton')).toBeEnabled();
    await target.evaluate(() => document.fonts.ready.then(() => undefined));
    await expect(widget(target)).toHaveCount(0);
    await expect.poll(async () => { const value = await headerGeometry(target); return Math.abs(value.height - value.offset) < .1; }).toBe(true);
    baseline.set(width, await headerGeometry(target));
  }
  await freshPhone.close();
  auth.active(true); await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(widget(page)).toBeVisible();
  for (const width of [440, 768, 440, 768, 440]) {
    await page.setViewportSize({ width, height: 764 });
    await expect(page.locator('.feedback-header-slot')).toHaveCount(0);
    await expect.poll(geometry).toEqual(baseline.get(width));
    expect((await launcherPlacement(page)).fixed).toBe(true);
  }
  auth.active(false); await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(widget(page)).toBeHidden();
  await expect(page.locator('body')).not.toHaveAttribute('data-feedback-mounted');
  await expect.poll(geometry).toEqual(baseline.get(440));
  // Session teardown also removes the hidden slot, with no lingering minimum.
  await page.evaluate(session => {
    localStorage.setItem('sb-127-auth-token', JSON.stringify(session));
    window.dispatchEvent(new StorageEvent('storage', { key: 'sb-127-auth-token', newValue: JSON.stringify(session) }));
  }, auth.replacement());
  await expect(page.locator('.feedback-header-slot')).toHaveCount(0);
  await expect.poll(geometry).toEqual(baseline.get(440));
  expect(auth.writes()).toEqual([]);
});
test('phone launcher label remains visible at 200% text with reduced motion and forced colors', async ({ context, page }, testInfo) => {
  const auth = await installFeedbackStub(context, { memberPages: true });
  await page.setViewportSize({ width: 320, height: 667 });
  await page.emulateMedia({ reducedMotion: 'reduce', forcedColors: 'active' });
  await page.goto('/dashboard.html'); await expect(widget(page)).toBeVisible();
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
  await expect.poll(() => widget(page).locator('span').evaluate(node => {
    const text = node.getBoundingClientRect(); const control = node.parentElement.getBoundingClientRect();
    return text.left >= control.left && text.right <= control.right && text.top >= control.top && text.bottom <= control.bottom;
  })).toBe(true);
  expect((await page.locator('main').boundingBox()).width).toBe(320);
  expect((await launcherPlacement(page)).fixed).toBe(true);
  await expect(page.locator('.feedback-header-slot')).toHaveCount(0);
  await expect(widget(page)).toHaveAccessibleName('Send Feedback');
  await widget(page).focus(); await expect(widget(page)).toBeFocused();
  expect(await widget(page).evaluate(node => getComputedStyle(node).outlineStyle)).not.toBe('none');
  // The shared reduced-motion rule uses .001ms rather than zero to preserve
  // transition-end behavior; either serialization must remain imperceptible.
  expect(await widget(page).evaluate(node => Math.max(...getComputedStyle(node).transitionDuration.split(',').map(parseFloat)))).toBeLessThanOrEqual(.000001);
  await page.screenshot({ path: testInfo.outputPath('phone-feedback-enlarged-forced-colors.png') });
  expect(auth.writes()).toEqual([]);
});
for (const theme of ['light', 'dark', 'dominion-night', 'dominion-platinum']) test(`${theme} native dialog focus, accessible form and viewport bounds`, async ({ context, page }, testInfo) => {
  const auth = await installFeedbackStub(context); await ready(page);
  await page.evaluate(value => document.documentElement.setAttribute('data-theme', value), theme);
  expect((await new AxeBuilder({ page }).include('[data-feedback-widget]').analyze()).violations).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath(`${theme}-feedback-launcher.png`) });
  const box = await widget(page).boundingBox(); const size = page.viewportSize();
  expect(box.width).toBeGreaterThanOrEqual(44); expect(box.height).toBeGreaterThanOrEqual(44);
  expect(box.x + box.width).toBeLessThanOrEqual(size.width); expect(box.y + box.height).toBeLessThanOrEqual(size.height);
  await widget(page).click(); await expect(page.getByRole('combobox', { name: 'Feedback type', exact: true })).toBeFocused();
  const panel = await dialog(page).boundingBox(); expect(panel.x).toBeGreaterThanOrEqual(0); expect(panel.x + panel.width).toBeLessThanOrEqual(size.width + 1);
  await contactGeometry(page);
  await page.getByRole('button', { name: 'Send feedback', exact: true }).scrollIntoViewIfNeeded();
  const action = await page.getByRole('button', { name: 'Send feedback', exact: true }).boundingBox();
  expect(action.y + action.height).toBeLessThanOrEqual(size.height + 1);
  expect((await new AxeBuilder({ page }).include('.app-dialog-layer[data-pattern="feedback"]').analyze()).violations).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath(`${theme}-feedback.png`) });
  await fill(page);
  await page.getByRole('button', { name: 'Send feedback', exact: true }).click();
  await expectVisibleReceipt(page);
  expect(auth.writes()).toHaveLength(1);
  expect((await new AxeBuilder({ page }).include('.app-dialog-layer[data-pattern="feedback"]').analyze()).violations).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath(`${theme}-feedback-saved.png`) });
  await page.keyboard.press('Escape'); await expect(widget(page)).toBeFocused();
});
test('short phone reveals the saved confirmation and Close without another scroll', async ({ context, page, isMobile }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  const auth = await installFeedbackStub(context); await ready(page); await widget(page).click(); await fill(page);
  const release = auth.hold();
  try {
    await page.getByRole('button', { name: 'Send feedback', exact: true }).click();
    await expect.poll(() => auth.writes().length).toBe(1);
    await expect(page.locator('.feedback-confirmation')).toBeHidden();
    await dialog(page).locator('.app-dialog-body').evaluate(body => { body.scrollTop = 0; });
  } finally { release(); }
  await expectVisibleReceipt(page);
  if (isMobile) {
    // The iPhone fixture uses native touch interaction; hardware-keyboard Tab
    // navigation depends on Safari's separate full-keyboard-access setting.
    await page.getByRole('button', { name: 'Close', exact: true }).tap();
  } else {
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Close', exact: true })).toBeFocused();
    await page.keyboard.press('Enter');
  }
  await expect(widget(page)).toBeFocused();
  await widget(page).click(); await expect(page.locator('.feedback-confirmation')).toBeHidden();
  await expect(page.getByRole('combobox', { name: 'Feedback type', exact: true })).toBeFocused();
  expect(auth.writes()).toHaveLength(1);
});
test('tablet contact permission remains fully readable and operable without inner overflow', async ({ context, page }, testInfo) => {
  await page.setViewportSize({ width: 768, height: 1024 }); await installFeedbackStub(context); await ready(page); await widget(page).click();
  await contactGeometry(page);
  await page.getByText('You may contact me about this feedback.', { exact: true }).click();
  await expect(page.getByRole('checkbox', { name: 'You may contact me about this feedback.', exact: true })).toBeChecked();
  await page.screenshot({ path: testInfo.outputPath('tablet-feedback.png') });
  await page.keyboard.press('Escape'); await expect(widget(page)).toBeFocused();
});
