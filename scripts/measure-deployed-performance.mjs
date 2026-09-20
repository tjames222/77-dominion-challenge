import { chromium } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PRODUCTION_ROUTES } from '../tests/e2e/support/routes.mjs';
import { fixtureFor, FIXED_NOW } from '../tests/e2e/support/fixtures.mjs';

const options = Object.fromEntries(process.argv.slice(2).map((value) => {
  const [key, ...rest] = value.replace(/^--/, '').split('=');
  return [key, rest.join('=')];
}));
const base = new URL(options['base-url'] || 'http://invalid');
if (base.protocol !== 'https:' || !/^(?:[a-f0-9]{8}|develop)\.77-dominion-live\.pages\.dev$/.test(base.hostname)
  || base.pathname !== '/' || base.search || base.hash) {
  throw new Error('Use the exact approved develop/immutable preview URL on 77-dominion-live.pages.dev.');
}
if (!/^[a-f0-9]{40}$/.test(options.sha || '')) throw new Error('Record the verified deployed 40-character source SHA.');
const samples = Number(options.samples || 1);
if (!Number.isInteger(samples) || samples < 1 || samples > 5) throw new Error('Use 1–5 samples.');
const selectedRoutes = ['landing', 'login', 'dashboard', 'badgesRewards', 'community', 'profile', 'bibleReading'];
const profiles = [
  { name: 'desktop', viewport: { width: 1440, height: 1000 }, latency: 40, download: 10_000_000 / 8, upload: 5_000_000 / 8, cpu: 1 },
  { name: 'mobile', viewport: { width: 390, height: 844 }, latency: 150, download: 1_600_000 / 8, upload: 750_000 / 8, cpu: 4 },
].filter((profile) => !options.profile || profile.name === options.profile);
const results = [];
const browser = await chromium.launch();
const safeUrl = (value) => {
  const url = new URL(value);
  return ['http:', 'https:'].includes(url.protocol) ? url.origin + url.pathname : `${url.protocol}[omitted]`;
};
try {
  for (const profile of profiles) {
    for (const route of PRODUCTION_ROUTES.filter((route) => selectedRoutes.includes(route.id)
      && (!options.route || route.id === options.route))) {
      for (const shape of ['clean', 'html']) {
        for (let sample = 1; sample <= samples; sample += 1) {
          const context = await browser.newContext({ viewport: profile.viewport, colorScheme: 'dark',
            locale: 'en-US', timezoneId: 'UTC', reducedMotion: 'reduce', serviceWorkers: 'block' });
          const fixture = fixtureFor(route.defaultState, 'dark');
          await context.addInitScript(({ fixture, fixedNow }) => {
            if (!sessionStorage.getItem('dominion:performance-fixture')) {
              localStorage.clear();
              for (const [key, value] of Object.entries(fixture.json)) localStorage.setItem(key, JSON.stringify(value));
              for (const [key, value] of Object.entries(fixture.raw)) {
                if (value !== null && value !== undefined) localStorage.setItem(key, String(value));
              }
              sessionStorage.setItem('dominion:performance-fixture', 'true');
            }
            const NativeDate = Date;
            class FixtureDate extends NativeDate {
              constructor(...args) { super(...(args.length ? args : [fixedNow])); }
              static now() { return NativeDate.parse(fixedNow); }
            }
            window.Date = FixtureDate;
            const metrics = { lcp: null, cls: 0, longTasks: [], inp: null };
            window.__performanceMeasurement = metrics;
            const observe = (type, callback, extra = {}) => {
              if (PerformanceObserver.supportedEntryTypes.includes(type)) {
                new PerformanceObserver((list) => list.getEntries().forEach(callback)).observe({ type, buffered: true, ...extra });
              }
            };
            observe('largest-contentful-paint', (entry) => { metrics.lcp = entry.startTime; });
            let shiftStart = 0; let shiftLast = 0; let shiftValue = 0;
            observe('layout-shift', (entry) => {
              if (entry.hadRecentInput) return;
              if (entry.startTime - shiftLast > 1000 || entry.startTime - shiftStart > 5000) {
                shiftStart = entry.startTime; shiftValue = 0;
              }
              shiftLast = entry.startTime; shiftValue += entry.value;
              metrics.cls = Math.max(metrics.cls, shiftValue);
            });
            observe('longtask', (entry) => metrics.longTasks.push({ start: entry.startTime, duration: entry.duration }));
            observe('event', (entry) => {
              if (entry.interactionId) metrics.inp = Math.max(metrics.inp || 0, entry.duration);
            }, { durationThreshold: 16 });
          }, { fixture, fixedNow: FIXED_NOW });
          const page = await context.newPage();
          const session = await context.newCDPSession(page);
          await session.send('Network.enable');
          await session.send('Network.emulateNetworkConditions', { offline: false, latency: profile.latency,
            downloadThroughput: profile.download, uploadThroughput: profile.upload });
          await session.send('Emulation.setCPUThrottlingRate', { rate: profile.cpu });
          let requests = new Map();
          let redirects = [];
          const addResponse = (record, response) => {
            const headers = Object.fromEntries(Object.entries(response.headers).map(([key, value]) => [key.toLowerCase(), value]));
            Object.assign(record, { status: response.status, fromCache: record.fromCache || response.fromDiskCache,
              cacheControl: headers['cache-control'] || null, contentEncoding: headers['content-encoding'] || null,
              contentType: headers['content-type'] || null, etag: headers.etag || null });
          };
          session.on('Network.requestWillBeSent', (event) => {
            if (event.redirectResponse && requests.has(event.requestId)) {
              const previous = requests.get(event.requestId);
              addResponse(previous, event.redirectResponse);
              Object.assign(previous, { encodedBytes: event.redirectResponse.encodedDataLength || 0,
                durationMs: (event.timestamp - previous.start) * 1000, redirect: true });
              redirects.push(previous);
            }
            requests.set(event.requestId, {
              url: safeUrl(event.request.url), method: event.request.method, type: event.type,
              start: event.timestamp, encodedBytes: 0, fromCache: false,
            });
          });
          session.on('Network.requestServedFromCache', (event) => {
            if (requests.has(event.requestId)) requests.get(event.requestId).fromCache = true;
          });
          session.on('Network.responseReceived', (event) => {
            const record = requests.get(event.requestId);
            if (!record) return;
            addResponse(record, event.response);
          });
          session.on('Network.loadingFinished', (event) => {
            const record = requests.get(event.requestId);
            if (record) Object.assign(record, { encodedBytes: event.encodedDataLength, durationMs: (event.timestamp - record.start) * 1000 });
          });
          const path = shape === 'html' ? route.path : route.path === '/index.html' ? '/' : route.path.replace(/\.html$/, '');
          for (const cacheState of ['cold', 'warm']) {
            requests = new Map();
            redirects = [];
            const response = await page.goto(new URL(path, base).href, { waitUntil: 'domcontentloaded', timeout: 60_000 });
            let error = null;
            try { await page.locator(route.ready).first().waitFor({ state: 'visible', timeout: 45_000 }); }
            catch { error = 'Primary route content did not become usable.'; }
            const usableMs = await page.evaluate(() => performance.now());
            await page.waitForLoadState('networkidle', { timeout: 60_000 }).catch(() => { error ||= 'Network did not settle within 60 seconds.'; });
            const metrics = await page.evaluate(() => {
              const navigation = performance.getEntriesByType('navigation')[0];
              const fcp = performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null;
              const measured = window.__performanceMeasurement;
              return { lcpMs: measured.lcp, cls: measured.cls, inpMs: measured.inp, fcpMs: fcp,
                ttfbMs: navigation?.responseStart ?? null,
                tbtMs: measured.longTasks.filter((task) => task.start >= (fcp || 0)).reduce((sum, task) => sum + Math.max(0, task.duration - 50), 0) };
            });
            const waterfall = [...redirects, ...requests.values()].sort((a, b) => a.start - b.start);
            const assets = waterfall.filter((request) => /\/(?:assets\/|theme-bootstrap\.js)/.test(request.url));
            const total = (rows) => rows.reduce((sum, row) => sum + row.encodedBytes, 0);
            results.push({ route: route.id, shape, sample, profile: profile.name, cacheState,
              url: safeUrl(page.url()), status: response?.status(), error, usableMs, ...metrics,
              transferredBytes: total(waterfall), initialJsBytes: total(assets.filter((request) => request.type === 'Script')),
              initialCssBytes: total(assets.filter((request) => request.type === 'Stylesheet')),
              requestCount: waterfall.length, cacheHitCount: waterfall.filter((request) => request.fromCache).length, waterfall });
            console.log(`${profile.name} ${route.id} ${shape} ${cacheState}: usable ${Math.round(usableMs)}ms, LCP ${Math.round(metrics.lcpMs || 0)}ms, ${total(waterfall)} bytes${error ? ' FAILED' : ''}`);
          }
          await context.close();
        }
      }
    }
  }
} finally { await browser.close(); }
await writeFile(resolve(options.output || 'deployed-performance.json'), JSON.stringify({ schemaVersion: 1,
  measuredAt: new Date().toISOString(), baseURL: base.origin, deployedSha: options.sha, browser: 'Chromium',
  profiles, samples, scenario: 'Deployed mock-only develop build; browser-local disposable fixtures; real CDN resources, no request interception; fixed app calendar, real performance clock.',
  inpNote: 'No interaction is synthesized during navigation timing; null is unavailable, not zero. Production p75 INP requires real-user observations.', results }, null, 2) + '\n');
if (results.some((result) => result.error)) process.exitCode = 1;
