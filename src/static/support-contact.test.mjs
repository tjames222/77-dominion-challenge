import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { SUPPORT_EMAIL } from '../shared/support-contact.mjs';

test('Support page fallback and shared renderer destination use the same contact source', async () => {
  assert.equal(SUPPORT_EMAIL, 'support@77dominion.com');
  const page = await readFile(new URL('../../support.html', import.meta.url), 'utf8');
  const legal = await readFile(new URL('./legal.js', import.meta.url), 'utf8');
  const renderer = await readFile(new URL('../../supabase/functions/_shared/feedback_event_renderer.ts', import.meta.url), 'utf8');
  assert.ok(page.includes(`id="supportEmailLink" href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>`));
  assert.match(legal, /import \{ SUPPORT_EMAIL \} from '\.\.\/shared\/support-contact\.mjs'/);
  assert.match(legal, /supportEmailLink\.href = `mailto:\$\{SUPPORT_EMAIL\}`/);
  assert.match(renderer, /import \{ SUPPORT_EMAIL \}/);
  assert.match(renderer, /to: SUPPORT_EMAIL/);
});
