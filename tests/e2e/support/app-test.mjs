import { expect, test as base } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { fixtureFor, FIXED_NOW } from './fixtures.mjs';

const SCREENSHOT_STYLE = fileURLToPath(new URL('./screenshot.css', import.meta.url));
const SCREENSHOT_STYLE_MARKER = 'data-dominion-e2e-screenshot-style';
const EXTERNAL_IMAGE = [
  '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800" viewBox="0 0 1200 800">',
  '<rect width="1200" height="800" fill="#172019"/>',
  '<path d="M120 620 420 260l180 210 150-170 330 320Z" fill="#4b614f"/>',
  '<circle cx="940" cy="180" r="72" fill="#c8aa64"/>',
  '</svg>',
].join('');

function installExternalRequestIsolation(context) {
  return context.route('https://**/*', async (route) => {
    const request = route.request();
    if (request.resourceType() === 'image') {
      await route.fulfill({
        status: 200,
        contentType: 'image/svg+xml',
        body: EXTERNAL_IMAGE,
        headers: { 'cache-control': 'public, max-age=31536000, immutable' },
      });
      return;
    }

    if (request.resourceType() === 'stylesheet') {
      await route.fulfill({
        status: 200,
        contentType: 'text/css',
        body: '/* External styles are intentionally neutralized in browser fixtures. */',
        headers: { 'cache-control': 'public, max-age=31536000, immutable' },
      });
      return;
    }

    if (['fetch', 'xhr'].includes(request.resourceType())) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: null, e2e: true }),
      });
      return;
    }

    await route.abort('blockedbyclient');
  });
}

async function installScreenshotStyle(page) {
  const selector = `style[${SCREENSHOT_STYLE_MARKER}]`;
  if (await page.locator(selector).count() === 0) {
    const style = await page.addStyleTag({ path: SCREENSHOT_STYLE });
    await style.evaluate(
      (element, marker) => element.setAttribute(marker, 'true'),
      SCREENSHOT_STYLE_MARKER,
    );
  }

  await page.evaluate(async () => {
    if (!document.fonts) return;
    await Promise.all([
      document.fonts.load('400 16px "Dominion E2E Inter"'),
      document.fonts.load('900 16px "Dominion E2E Inter"'),
    ]);
    await document.fonts.ready;
  });
}

async function seedPage(page, stateName, theme) {
  const storage = fixtureFor(stateName, theme);

  await page.addInitScript(({ fixedNow, seededStorage, selectedTheme }) => {
    const storageSeedKey = 'dominion:e2e-storage-seeded';
    if (sessionStorage.getItem(storageSeedKey) !== 'true') {
      localStorage.clear();
      sessionStorage.clear();

      for (const [key, value] of Object.entries(seededStorage.json)) {
        localStorage.setItem(key, JSON.stringify(value));
      }
      for (const [key, value] of Object.entries(seededStorage.raw)) {
        if (value === null || value === undefined) localStorage.removeItem(key);
        else localStorage.setItem(key, String(value));
      }
      sessionStorage.setItem(storageSeedKey, 'true');
    }

    const NativeDate = Date;
    const fixedTimestamp = NativeDate.parse(fixedNow);
    class FixedDate extends NativeDate {
      constructor(...args) {
        super(...(args.length ? args : [fixedTimestamp]));
      }

      static now() {
        return fixedTimestamp;
      }
    }
    FixedDate.parse = NativeDate.parse;
    FixedDate.UTC = NativeDate.UTC;
    Object.setPrototypeOf(FixedDate, NativeDate);
    window.Date = FixedDate;
    Math.random = () => 0.4177;

    try {
      Object.defineProperty(globalThis.crypto, 'randomUUID', {
        configurable: true,
        value: () => '00000000-0000-4000-8000-000000000077',
      });
    } catch {
      // Some engines expose randomUUID as non-configurable; seeded IDs avoid it.
    }

    const root = document.documentElement;
    const readThemeState = () => ({
      theme: root?.getAttribute('data-theme') || '',
      colorScheme: root?.style.colorScheme || '',
      themeColor: document.querySelector('meta[name="theme-color"]')?.getAttribute('content') || '',
    });
    const probe = {
      requestedTheme: selectedTheme,
      initial: readThemeState(),
      mutations: [],
      firstContentfulPaint: null,
    };
    window.__dominionThemeProbe = probe;

    if (root) {
      new MutationObserver(() => {
        probe.mutations.push({
          at: performance.now(),
          ...readThemeState(),
        });
      }).observe(root, {
        attributes: true,
        attributeFilter: ['data-theme', 'style'],
      });
    }

    try {
      new PerformanceObserver((entries) => {
        for (const entry of entries.getEntries()) {
          if (entry.name === 'first-contentful-paint' && !probe.firstContentfulPaint) {
            probe.firstContentfulPaint = {
              at: entry.startTime,
              ...readThemeState(),
            };
          }
        }
      }).observe({ type: 'paint', buffered: true });
    } catch {
      // The final theme assertions still run if paint timing is unavailable.
    }

    window.__DOMINION_E2E__ = Object.freeze({
      enabled: true,
      fixedNow,
      requestedTheme: selectedTheme,
    });
  }, {
    fixedNow: FIXED_NOW,
    seededStorage: storage,
    selectedTheme: theme,
  });
}

async function waitForStablePage(page) {
  await page.waitForLoadState('domcontentloaded');
  await page.evaluate(async () => {
    const settleWithin = (promise, timeoutMs = 5_000) => Promise.race([
      promise,
      new Promise((resolve) => setTimeout(resolve, timeoutMs)),
    ]);

    if (document.fonts?.ready) await settleWithin(document.fonts.ready);

    const images = [...document.images];
    for (const image of images) {
      if (image.loading === 'lazy') image.loading = 'eager';
    }
    await settleWithin(Promise.all(images.map((image) => {
      if (image.complete) return Promise.resolve();
      return new Promise((resolve) => {
        image.addEventListener('load', resolve, { once: true });
        image.addEventListener('error', resolve, { once: true });
      });
    })));
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
}

export const test = base.extend({
  app: async ({ context, page }, use, testInfo) => {
    await installExternalRequestIsolation(context);
    const runtimeErrors = [];
    page.on('pageerror', (error) => runtimeErrors.push(error));
    page.on('console', (message) => {
      if (message.type() === 'error') runtimeErrors.push(new Error(message.text()));
    });

    const app = {
      runtimeErrors,
      async seed(stateName = 'member', theme = testInfo.project.metadata.theme || 'dark') {
        await seedPage(page, stateName, theme);
      },
      async open(route, options = {}) {
        const state = options.state || route.defaultState;
        const theme = options.theme || testInfo.project.metadata.theme || 'dark';
        await seedPage(page, state, theme);
        await page.goto(route.path, { waitUntil: options.waitUntil || 'networkidle' });
        await installScreenshotStyle(page);
        await expect(page.locator(route.ready).first()).toBeVisible();
        await expect(page).toHaveTitle(route.title);
        await waitForStablePage(page);
      },
      async stable() {
        await installScreenshotStyle(page);
        await waitForStablePage(page);
      },
      assertNoRuntimeErrors(allowedPatterns = []) {
        const unexpected = runtimeErrors.filter((error) => (
          !allowedPatterns.some((pattern) => pattern.test(String(error?.message || error)))
        ));
        expect(unexpected.map((error) => error.message)).toEqual([]);
      },
    };

    await use(app);
  },
});

export { expect };

export async function expectStableScreenshot(page, app, name, options = {}) {
  await app.stable();
  await expect(page).toHaveScreenshot(name, {
    fullPage: options.fullPage ?? true,
    ...options,
  });
}

export async function expectNoHorizontalOverflow(page) {
  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth,
  }));
  expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport + 1);
}
