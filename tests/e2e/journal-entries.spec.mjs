import {
  expect,
  expectNoHorizontalOverflow,
  test,
} from './support/app-test.mjs';
import { FIXED_TODAY } from './support/fixtures.mjs';
import {
  analyzeAccessibility,
  assertNoBlockingAxeViolations,
} from './support/quality-gates.mjs';
import { ROUTE_BY_ID } from './support/routes.mjs';

async function createEntry(page, { note, win, mood = 'Focused', energy = 'High' }) {
  const form = page.locator('#journalForm');
  await form.getByLabel('Date').fill(FIXED_TODAY);
  await form.getByLabel('Mood').selectOption(mood);
  await form.getByLabel('Energy').selectOption(energy);
  await form.getByLabel('What did today reveal?').fill(note);
  await form.getByLabel('Win').fill(win);
  await form.getByRole('button', { name: 'Save Private Entry' }).click();
  await expect(page.locator('#communityFeedback')).toHaveText('Private journal entry saved.');
}

test('multiple daily entries are grouped once and edited independently in a modal', async ({
  page,
  app,
}) => {
  await app.open(ROUTE_BY_ID.privateJournal);

  await createEntry(page, {
    note: 'Morning reflection stays independent.',
    win: 'Started with prayer',
  });
  await createEntry(page, {
    note: 'Evening reflection stays independent.',
    win: 'Finished with gratitude',
    mood: 'Grateful',
    energy: 'Medium',
  });

  const dateGroups = page.locator('.journal-date-group');
  await expect(dateGroups).toHaveCount(1);
  await expect(dateGroups.locator('.journal-date-heading')).toContainText('2 entries');
  await expect(dateGroups.locator('.timeline-note')).toHaveCount(2);
  await expect(dateGroups.locator('.journal-date-heading time')).toHaveCount(1);

  const morningEntry = page.locator('.timeline-note').filter({
    hasText: 'Morning reflection stays independent.',
  });
  await morningEntry.getByRole('button', { name: /Edit journal entry from/ }).click();

  const dialog = page.getByRole('dialog', { name: 'Edit entry' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Win')).toHaveValue('Started with prayer');
  await dialog.getByLabel('What did today reveal?').fill('Morning reflection was edited by id.');
  await dialog.getByRole('button', { name: 'Save Changes' }).click();

  await expect(dialog).toBeHidden();
  await expect(page.locator('#journalTimeline')).toContainText('Morning reflection was edited by id.');
  await expect(page.locator('#journalTimeline')).not.toContainText('Morning reflection stays independent.');
  await expect(page.locator('#journalTimeline')).toContainText('Evening reflection stays independent.');
  await expect(page.locator('#journalForm').getByLabel('What did today reveal?')).toHaveValue('');

  const eveningEntry = page.locator('.timeline-note').filter({
    hasText: 'Evening reflection stays independent.',
  });
  await eveningEntry.getByRole('button', { name: /Edit journal entry from/ }).click();
  await dialog.getByLabel('What did today reveal?').fill('This canceled change must not persist.');
  const modalResults = await analyzeAccessibility(page);
  assertNoBlockingAxeViolations(modalResults);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('#journalTimeline')).toContainText('Evening reflection stays independent.');
  await expect(page.locator('#journalTimeline')).not.toContainText('This canceled change must not persist.');

  await page.setViewportSize({ width: 390, height: 844 });
  await expectNoHorizontalOverflow(page);
  app.assertNoRuntimeErrors();
});
