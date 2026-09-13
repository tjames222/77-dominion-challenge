import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const metrics = ['lcpMs', 'cls', 'usableMs', 'fcpMs', 'ttfbMs', 'tbtMs', 'transferredBytes', 'initialJsBytes', 'initialCssBytes', 'requestCount', 'cacheHitCount'];
export function summarizeDeployedPerformance(before, after) {
  if (before.samples !== after.samples || JSON.stringify(before.profiles) !== JSON.stringify(after.profiles)
    || JSON.stringify(before.scenario) !== JSON.stringify(after.scenario) || before.browser !== after.browser) {
    throw new Error('Before and after must use identical samples, profiles, fixture state and browser.');
  }
  const median = (values) => {
    const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
    if (!sorted.length) return null;
    const middle = Math.floor(sorted.length / 2);
    const value = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
    return Number(value.toFixed(6));
  };
  const key = (row) => [row.profile, row.route, row.shape, row.cacheState].join('/');
  const keys = [...new Set(before.results.map(key))];
  if (after.results.some((row) => !keys.includes(key(row)))) throw new Error('Route matrices differ.');
  const runs = (data) => ({
    url: data.baseURL, sha: data.deployedSha, measuredAt: data.measuredAt,
    navigations: data.results.length,
    navigationErrors: data.results.filter((row) => row.error || row.status !== 200).length,
    lcpOver2500: data.results.filter((row) => row.lcpMs > 2500).length,
    clsOverPoint1: data.results.filter((row) => row.cls > .1).length,
    missingLcp: data.results.filter((row) => !Number.isFinite(row.lcpMs)).length,
  });
  const groups = keys.map((name) => {
    const values = (data) => data.results.filter((row) => key(row) === name);
    const left = values(before);
    const right = values(after);
    if (left.length !== before.samples || right.length !== after.samples) throw new Error(`Incomplete samples: ${name}`);
    return { group: name, before: metrics.map((metric) => median(left.map((row) => row[metric]))),
      after: metrics.map((metric) => median(right.map((row) => row[metric]))) };
  });
  return { schemaVersion: 1, before: runs(before), after: runs(after), browser: before.browser,
    profiles: before.profiles, samplesPerGroup: before.samples, scenario: before.scenario,
    inp: 'Not measured: navigation-only lab data is not interaction or real-user p75 INP.',
    completion: 'Asset/layout lab gates only; initial-JS, domain/API and RUM requirements remain open.',
    metrics, groups };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2] || !process.argv[3]) throw new Error('Pass the before and after measurement JSON paths.');
  const before = JSON.parse(await readFile(process.argv[2], 'utf8'));
  const after = JSON.parse(await readFile(process.argv[3], 'utf8'));
  console.log(JSON.stringify(summarizeDeployedPerformance(before, after), null, 2));
}
