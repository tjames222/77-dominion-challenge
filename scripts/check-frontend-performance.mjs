import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { measureFrontendBundles } from './measure-frontend-bundles.mjs';

export function checkFrontendPerformance(measured, budgets, { requireTargets = false } = {}) {
  const violations = [];
  const remainingTargets = [];
  const forbidden = /\/(?:share-composer(?!-loader)|site-training-ui)(?:-[\w-]+)?\.(?:js|css)$/;
  for (const [name, budget] of Object.entries(budgets.routes)) {
    const route = measured.routes[name];
    if (!route) { violations.push(`${name}: missing measured entry`); continue; }
    if (route.js.gzip > budget.maximumJsGzip) violations.push(`${name}: initial JS ${route.js.gzip} exceeds ${budget.maximumJsGzip}`);
    if (route.css.gzip > budget.maximumCssGzip) violations.push(`${name}: initial CSS ${route.css.gzip} exceeds ${budget.maximumCssGzip}`);
    if (route.requestCount > budget.maximumInitialRequests) violations.push(`${name}: ${route.requestCount} initial graph requests exceeds ${budget.maximumInitialRequests}`);
    if (route.assets.some((path) => forbidden.test(path))) violations.push(`${name}: optional presentation entered the initial graph`);
    if (route.js.gzip > budget.targetJsGzip) remainingTargets.push(`${name}: JS ${route.js.gzip} still exceeds completion target ${budget.targetJsGzip}`);
  }
  for (const asset of measured.assets) {
    if (asset.path.endsWith('.js') && asset.gzip > budgets.maximumSingleJsChunkGzip) {
      violations.push(`${asset.path}: single JS chunk ${asset.gzip} exceeds ${budgets.maximumSingleJsChunkGzip}`);
    }
  }
  if (requireTargets) violations.push(...remainingTargets);
  return { pass: violations.length === 0, targetsMet: remainingTargets.length === 0, violations, remainingTargets };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const budgets = JSON.parse(await readFile(new URL('../frontend-performance-budgets.json', import.meta.url), 'utf8'));
  const measured = await measureFrontendBundles();
  const result = checkFrontendPerformance(measured, budgets, { requireTargets: process.argv.includes('--require-targets') });
  console.log(JSON.stringify(result, null, 2));
  if (!result.pass) process.exitCode = 1;
}
