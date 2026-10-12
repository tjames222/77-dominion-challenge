import { test, expect } from '@playwright/test';
import { createIntegrationBuildHarness, installIntegrationFixture } from './support/group-integration-build-harness.mjs';

test.describe('compiled group integration flags', () => {
  test.describe.configure({ mode: 'default' });
  let disabled, enabled;
  test.beforeAll(async () => {
    disabled = await createIntegrationBuildHarness('false');
    enabled = await createIntegrationBuildHarness('true');
  });
  test.afterAll(async () => { await disabled?.close(); await enabled?.close(); });

  async function open(page, harness, route, fragment = '', fixture = {}) {
    const errors = [];
    const remote = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
      if (new URL(route.request().url()).origin === harness.origin) return route.continue();
      remote.push(route.request().url()); return route.abort('blockedbyclient');
    });
    await installIntegrationFixture(page, fixture);
    await page.goto(`${harness.origin}/${route}.html?keep=1${fragment}`);
    await expect(page.locator(route === 'community' ? '#crewTitle' : '#groupSettingsOverviewTitle')).toHaveText('Synthetic Group');
    return async () => {
      expect(errors).toEqual([]);
      expect(remote).toEqual([]);
      expect(await page.evaluate(() => window.__integrationFixture.network)).toEqual([]);
    };
  }

  for (const fragment of ['#integration-setup=synthetic%2Btoken', '#integration-error=authorization_denied']) {
    test(`disabled Group Settings scrubs ${fragment.split('=')[0]} without integration calls`, async ({ page }) => {
      const verify = await open(page, disabled, 'group-settings', fragment);
      await expect(page).toHaveURL(`${disabled.origin}/group-settings.html?keep=1`);
      await expect(page.locator('#groupIntegrations')).toBeHidden();
      await expect(page.locator('#integrationPrivacy')).toBeHidden();
      // Even a programmatically dispatched hidden form cannot start setup or consent.
      await page.locator('#integrationConfirmForm').dispatchEvent('submit');
      await page.locator('#integrationConsentForm').dispatchEvent('submit');
      expect(await page.evaluate(() => window.__integrationFixture.calls.filter(call =>
        /Integration|Outbound/.test(call.name)))).toEqual([]);
      await verify();
    });
  }

  test('disabled Group Settings leaves unrelated fragments intact', async ({ page }) => {
    const verify = await open(page, disabled, 'group-settings', '#unrelated=keep');
    await expect(page).toHaveURL(`${disabled.origin}/group-settings.html?keep=1#unrelated=keep`);
    await verify();
  });

  for (const flag of ['false', 'true']) test(`Community keeps its existing settings link and no integration requests with flag=${flag}`, async ({ page }) => {
    const verify = await open(page, flag === 'false' ? disabled : enabled, 'community');
    await expect(page.getByRole('link', { name: 'Group settings' })).toHaveAttribute('href', './group-settings.html');
    expect(await page.evaluate(() => window.__integrationFixture.calls.filter(call => /Integration|Outbound/.test(call.name)))).toEqual([]);
    await verify();
  });

  for (const provider of ['slack', 'discord']) test(`enabled ${provider} setup, consent, configuration, test and disconnect stay functional`, async ({ page }) => {
    const verify = await open(page, enabled, 'group-settings', '#integration-setup=synthetic%2Btoken', { provider });
    await expect(page).toHaveURL(`${enabled.origin}/group-settings.html?keep=1`);
    await expect(page.locator('#integrationConfirmForm')).toBeVisible();
    expect(await page.evaluate(() => window.__integrationFixture.calls.find(call => call.name === 'manageGroupIntegration' && call.args[0] === 'channels').args[1]))
      .toEqual({ setupToken: 'synthetic+token' });
    await page.locator('#integrationConfirmForm button[type="submit"]').click();
    await expect(page.locator('#integrationConfirmForm')).toBeHidden();
    await expect(page.locator('#groupSettingsFeedback')).toContainText('channel connected');
    await page.locator('#integrationUpdatesEnabled').check();
    await page.locator('#integrationShareCheckIns').check();
    await page.locator('#saveIntegrationConsent').click();
    await expect(page.locator('#integrationConsentFeedback')).toContainText('Privacy choices saved');
    await page.locator('[data-integration-settings] select[name="recapCadence"]').selectOption('weekly');
    await page.locator('[data-integration-settings] button[type="submit"]').click();
    await expect(page.locator('#groupSettingsFeedback')).toHaveText('Channel settings saved.');
    await page.locator('[data-test-integration]').click();
    await expect(page.locator('#groupSettingsFeedback')).toContainText('Test update delivered');
    await page.locator('[data-disconnect-integration]').click();
    await page.getByRole('alertdialog', { name: 'Disconnect this channel?' }).getByRole('button', { name: 'Disconnect', exact: true }).click();
    await expect(page.locator('#groupSettingsFeedback')).toHaveText('Channel disconnected.');
    const calls = await page.evaluate(() => window.__integrationFixture.calls);
    expect(calls.filter(call => call.name === 'manageGroupIntegration').map(call => call.args[0]))
      .toEqual(['list', 'channels', 'confirm', 'list', 'configure', 'list', 'test', 'list', 'disconnect', 'list']);
    expect(calls.find(call => call.name === 'manageGroupIntegration' && call.args[0] === 'configure').args[1].recapCadence).toBe('weekly');
    expect(calls.find(call => call.name === 'updateOutboundUpdateConsent').args[1].events.checkIns).toBe(true);
    await verify();
  });

  test('enabled provider authorization still rejects an off-provider redirect', async ({ page }) => {
    const verify = await open(page, enabled, 'group-settings');
    await page.getByRole('button', { name: 'Connect Slack', exact: true }).click();
    await expect(page.locator('#groupSettingsFeedback')).toHaveText('The provider returned an invalid authorization page.');
    await expect(page).toHaveURL(`${enabled.origin}/group-settings.html?keep=1`);
    await verify();
  });
});
