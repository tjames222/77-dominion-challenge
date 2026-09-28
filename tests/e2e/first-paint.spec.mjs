import { test, expect } from './support/app-test.mjs';
import { PRODUCTION_ROUTES, expectedRouteTheme } from './support/routes.mjs';

const themes = [
  { id: 'light', colorScheme: 'light' },
  { id: 'dark', colorScheme: 'dark' },
  { id: 'dominion-night', colorScheme: 'dark', entitlementGated: true },
  { id: 'dominion-platinum', colorScheme: 'dark', entitlementGated: true },
];

const strictBootstrap = process.env.E2E_STRICT_THEME_BOOTSTRAP === 'true';

for (const theme of themes) {
  test.describe(theme.id + ' first-paint theme contract', () => {
    for (const route of PRODUCTION_ROUTES) {
      test(route.id + ' paints with the requested browser scheme', async ({ page, app }) => {
        await app.open(route, { theme: theme.id });
        const expectedTheme = expectedRouteTheme(route, theme.id);

        const state = await page.evaluate(() => ({
          finalTheme: document.documentElement.dataset.theme,
          finalInlineScheme: document.documentElement.style.colorScheme,
          finalComputedScheme: getComputedStyle(document.documentElement).colorScheme,
          probe: window.__dominionThemeProbe,
        }));

        expect(state.finalTheme).toBe(expectedTheme);
        expect(state.finalInlineScheme || state.finalComputedScheme).toBe(theme.colorScheme);

        const firstPaintAt = state.probe.firstContentfulPaint?.at;
        const mutationsAfterPaint = firstPaintAt === undefined
          ? []
          : state.probe.mutations.filter((mutation) => mutation.at > firstPaintAt);
        expect(
          mutationsAfterPaint.filter((mutation) => mutation.theme && mutation.theme !== expectedTheme),
        ).toEqual([]);

        if (strictBootstrap && (!theme.entitlementGated || route.themePolicy === 'public-only')) {
          expect(state.probe.firstContentfulPaint, 'first-contentful-paint probe').toBeTruthy();
          expect(state.probe.initial.theme).toBe(expectedTheme);
          expect(state.probe.initial.colorScheme).toBe(theme.colorScheme);
          expect(state.probe.firstContentfulPaint.theme).toBe(expectedTheme);
          expect(state.probe.firstContentfulPaint.colorScheme).toBe(theme.colorScheme);
        }
      });
    }
  });
}
