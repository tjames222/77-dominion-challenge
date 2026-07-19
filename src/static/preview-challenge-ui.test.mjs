import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const profileHtml = readFileSync(new URL('../../profile.html', import.meta.url), 'utf8');
const profileJs = readFileSync(new URL('./profile.js', import.meta.url), 'utf8');
const dashboardHtml = readFileSync(new URL('../../dashboard.html', import.meta.url), 'utf8');
const todayActionsHtml = readFileSync(new URL('../../today-actions.html', import.meta.url), 'utf8');
const dashboardJs = readFileSync(new URL('./dashboard.js', import.meta.url), 'utf8');

describe('preview challenge controls', () => {
  it('keeps the Profile switch hidden by default and gates it on local preview mode', () => {
    assert.match(profileHtml, /id=["']profilePreviewTools["'][^>]*hidden/);
    assert.match(profileHtml, /id=["']profilePreviewChallengeSwitch["'][^>]*role=["']switch["']/);
    assert.match(profileJs, /profilePreviewTools\.hidden = !localPreviewMode/);
  });

  it('shares simulated action state across Dashboard and Today’s Actions', () => {
    [dashboardHtml, todayActionsHtml].forEach((html) => {
      assert.match(html, /src=["']\.\/src\/static\/dashboard\.js["']/);
    });
    assert.match(dashboardJs, /isPreviewChallengeActive\(localDemoMode, previewChallengeState\)/);
  });
});
