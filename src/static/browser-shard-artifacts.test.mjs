import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { deflateSync } from 'node:zlib';
import test from 'node:test';
import { assertNeeds, files, identity, mergeShards, pngInventory, reportTests, safePath, validatePlan } from '../../scripts/browser-shard-artifacts.mjs';

const run = { sha: 'a'.repeat(40), run: '1234', attempt: '2' };
const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4AWP4DwQACfsD/c8LaHIAAAAASUVORK5CYII=', 'base64');
const otherPixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4AWMAgv8AAQQBAP8H9UQAAAAASUVORK5CYII=', 'base64');
const plan = () => ({ version: 1, identity: { ...run }, total: 2, generate: true,
  baselines: ['a/desktop/a.png', 'b/mobile/b.png'], tests: ['one', 'two'],
  shards: [{ index: 1, tests: ['one'] }, { index: 2, tests: ['two'] }] });

function fixture(t, mutate = () => {}) {
  const root = mkdtempSync(join(tmpdir(), 'browser-shard-check-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const input = join(root, 'received');
  const output = join(root, 'verified');
  const expected = plan();
  function save(index, images = [expected.baselines[index - 1]]) {
    const dir = join(input, `shard-${index}`);
    mkdirSync(dir, { recursive: true });
    for (const path of images) {
      mkdirSync(dirname(join(dir, 'snapshots', path)), { recursive: true });
      writeFileSync(join(dir, 'snapshots', path), pixel);
    }
    const manifest = { version: 1, identity: { ...run }, total: 2, index, generate: expected.generate,
      tests: [{ id: index === 1 ? 'one' : 'two', outcome: 'expected' }], pngs: pngInventory(join(dir, 'snapshots')) };
    mutate(manifest, index);
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
    return dir;
  }
  save(1); save(2);
  return { root, input, output, expected, save };
}

test('aggregate requires exactly all known dependencies to succeed', () => {
  const success = { preflight: { result: 'success' }, 'browser-shards': { result: 'success' } };
  assert.doesNotThrow(() => assertNeeds(success));
  for (const name of Object.keys(success)) {
    for (const result of ['failure', 'cancelled', 'skipped', '', undefined]) {
      assert.throws(() => assertNeeds({ ...success, [name]: { result } }));
    }
    const missing = { ...success }; delete missing[name];
    assert.throws(() => assertNeeds(missing));
  }
  assert.throws(() => assertNeeds({}));
  assert.throws(() => assertNeeds({ ...success, unknown: { result: 'success' } }));
});

test('identity binds full SHA, run and attempt without accepting empty values', () => {
  assert.deepEqual(identity({ GITHUB_SHA: run.sha, GITHUB_RUN_ID: run.run, GITHUB_RUN_ATTEMPT: run.attempt }), run);
  for (const key of ['GITHUB_SHA', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT']) {
    const env = { GITHUB_SHA: run.sha, GITHUB_RUN_ID: run.run, GITHUB_RUN_ATTEMPT: run.attempt, [key]: '' };
    assert.throws(() => identity(env));
  }
});

test('plan rejects missing, duplicated, overlapping or incomplete shard inventories', () => {
  assert.doesNotThrow(() => validatePlan(plan(), run));
  for (const alter of [
    (p) => { p.shards.pop(); }, (p) => { p.shards[1].index = 1; },
    (p) => { p.shards[1].tests = ['one']; }, (p) => { p.tests.push('three'); },
    (p) => { p.shards[1].tests = []; }, (p) => { p.identity.attempt = '1'; },
    (p) => { p.total = 3; }, (p) => { p.baselines.push('../outside.png'); },
  ]) {
    const candidate = plan(); alter(candidate);
    assert.throws(() => validatePlan(candidate, run));
  }
});

const report = (status = 'expected', results = ['passed'], expectedStatus = 'passed') => ({
  errors: [], suites: [{ specs: [{ id: 'id', tests: [{ projectId: 'chromium', status, expectedStatus,
    results: results.map((result) => ({ status: result })) }] }] }],
});

test('completed reports reject discovery-only, failed, interrupted, duplicate and empty outcomes', () => {
  assert.deepEqual(reportTests(report(), true), [{ id: 'chromium:id', outcome: 'expected' }]);
  assert.equal(reportTests(report('flaky', ['failed', 'passed']), true)[0].outcome, 'flaky');
  assert.equal(reportTests(report('skipped', ['skipped'], 'skipped'), true)[0].outcome, 'skipped');
  for (const candidate of [report('skipped', []), report('unexpected', ['failed']), report('expected', ['interrupted']),
    report('expected', ['passed', 'passed', 'passed']), report('skipped', ['skipped']), { errors: [], suites: [] },
    { ...report(), errors: [{ message: 'worker crashed' }] }]) assert.throws(() => reportTests(candidate, true));
  const duplicate = report(); duplicate.suites.push(duplicate.suites[0]);
  assert.throws(() => reportTests(duplicate, true), /Duplicate/);
});

test('complete fresh baseline union preserves relative project paths and source identity', (t) => {
  const f = fixture(t);
  const result = mergeShards(f.expected, f.input, f.output);
  assert.equal(result.tests, 2);
  assert.deepEqual(result.identity, run);
  assert.equal(result.pngs.length, 2);
  assert.deepEqual(files(f.output), ['snapshots/a/desktop/a.png', 'snapshots/b/mobile/b.png', 'verification.json']);
  assert.ok(readFileSync(join(f.output, 'snapshots/a/desktop/a.png')).equals(pixel));
  assert.throws(() => mergeShards(f.expected, f.input, f.output), /overwrite/);
});

for (const [label, mutate] of [
  ['wrong SHA', (m) => { m.identity.sha = 'b'.repeat(40); }],
  ['wrong run', (m) => { m.identity.run = '9'; }],
  ['wrong attempt', (m) => { m.identity.attempt = '1'; }],
  ['wrong total', (m) => { m.total = 3; }],
  ['wrong shard', (m) => { m.index = 1; }],
  ['missing test', (m) => { m.tests = []; }],
  ['duplicate test', (m) => { m.tests.push(m.tests[0]); }],
  ['failed test', (m) => { m.tests[0].outcome = 'unexpected'; }],
  ['wrong mode', (m) => { m.generate = false; }],
  ['path traversal', (m) => { m.pngs[0].path = '../escape.png'; }],
  ['changed hash', (m) => { m.pngs[0].sha256 = '0'.repeat(64); }],
]) {
  test(`rejects ${label} without creating adoption output`, (t) => {
    const f = fixture(t, (manifest, index) => { if (index === 2) mutate(manifest); });
    assert.throws(() => mergeShards(f.expected, f.input, f.output));
    assert.equal(existsSync(f.output), false);
  });
}

test('missing/extra shards and malformed manifests fail before output', (t) => {
  const f = fixture(t);
  mkdirSync(join(f.input, 'shard-3'));
  assert.throws(() => mergeShards(f.expected, f.input, f.output), /Missing\/extra/);
  rmSync(join(f.input, 'shard-3'), { recursive: true });
  writeFileSync(join(f.input, 'shard-2/manifest.json'), '{broken');
  assert.throws(() => mergeShards(f.expected, f.input, f.output));
  rmSync(join(f.input, 'shard-2'), { recursive: true });
  assert.throws(() => mergeShards(f.expected, f.input, f.output), /Missing\/extra/);
  assert.equal(existsSync(f.output), false);
});

test('same file count cannot replace a missing expected baseline', (t) => {
  const f = fixture(t);
  f.expected.baselines[1] = 'different/mobile/b.png';
  assert.throws(() => mergeShards(f.expected, f.input, f.output), /Missing regenerated baseline/);
  assert.equal(existsSync(f.output), false);
});

test('byte-identical duplicate snapshots are safe; conflicts fail in either shard', (t) => {
  const f = fixture(t);
  f.save(2, [f.expected.baselines[0], f.expected.baselines[1]]);
  assert.equal(mergeShards(f.expected, f.input, f.output).pngs.length, 2);
  for (const index of [1, 2]) {
    const path = join(f.input, `shard-${index}/snapshots/a/desktop/a.png`);
    writeFileSync(path, otherPixel);
    const manifestPath = join(f.input, `shard-${index}/manifest.json`);
    const manifest = JSON.parse(readFileSync(manifestPath));
    manifest.pngs = pngInventory(join(f.input, `shard-${index}/snapshots`));
    writeFileSync(manifestPath, JSON.stringify(manifest));
    assert.throws(() => mergeShards(f.expected, f.input, join(f.root, `conflict-${index}`)), /Conflicting PNG/);
    writeFileSync(path, pixel);
    manifest.pngs = pngInventory(join(f.input, `shard-${index}/snapshots`));
    writeFileSync(manifestPath, JSON.stringify(manifest));
  }
});

test('truncated PNGs, extra files, and symlinks cannot enter an adoption artifact', (t) => {
  const f = fixture(t);
  const path = join(f.input, 'shard-1/snapshots/a/desktop/a.png');
  writeFileSync(path, pixel.subarray(0, 32));
  assert.throws(() => mergeShards(f.expected, f.input, f.output), /Invalid PNG/);
  writeFileSync(path, pixel);
  writeFileSync(join(f.input, 'shard-1/unlisted.txt'), 'unexpected');
  assert.throws(() => mergeShards(f.expected, f.input, f.output), /Unexpected or missing/);
  rmSync(join(f.input, 'shard-1/unlisted.txt'));
  rmSync(path); symlinkSync(join(f.root, 'missing.png'), path);
  assert.throws(() => mergeShards(f.expected, f.input, f.output), /symlinks/);
  assert.equal(existsSync(f.output), false);
});

test('PNG validation decodes bounded scanlines and rejects forged structure, CRC and compressed payloads', (t) => {
  const f = fixture(t);
  const path = join(f.input, 'shard-1/snapshots/a/desktop/a.png');
  const crc32 = (bytes) => {
    let value = 0xffffffff;
    for (const byte of bytes) {
      value ^= byte;
      for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
    }
    return (value ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, payload) => {
    const chunk = Buffer.alloc(payload.length + 12);
    chunk.writeUInt32BE(payload.length, 0); chunk.write(type, 4); payload.copy(chunk, 8);
    chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
    return chunk;
  };
  const withIDAT = (payload) => Buffer.concat([pixel.subarray(0, 33), chunk('IDAT', payload), pixel.subarray(-12)]);
  const forged = Buffer.alloc(64);
  pixel.copy(forged, 0, 0, 8); forged.write('IHDR', 12); pixel.copy(forged, 52, pixel.length - 12);
  const badCRC = Buffer.from(pixel); badCRC[29] ^= 1;
  const excessiveDimensions = Buffer.from(pixel); excessiveDimensions.writeUInt32BE(65535, 16);
  const interlaced = Buffer.from(pixel); interlaced[28] = 1;
  const badAncillary = chunk('tEXt', Buffer.from('key\0value')); badAncillary[badAncillary.length - 1] ^= 1;
  const malformed = [forged, badCRC, excessiveDimensions,
    withIDAT(Buffer.from([0, 0, 0])), // Correct chunk CRC, invalid zlib stream.
    withIDAT(deflateSync(Buffer.from([5, 255, 255, 255, 255]))), // Invalid filter.
    withIDAT(deflateSync(Buffer.from([0, 255]))), // Incomplete decoded scanline.
    withIDAT(deflateSync(Buffer.from([0, 255, 255, 255, 255, 255]))), // Excess inflated data.
    interlaced,
    Buffer.concat([pixel.subarray(0, 33), pixel.subarray(8, 33), pixel.subarray(33)]), // Duplicate IHDR.
    Buffer.concat([pixel.subarray(0, 33), badAncillary, pixel.subarray(33)]), // Ancillary CRC.
    Buffer.concat([pixel.subarray(0, 33), chunk('IDAT', pixel.subarray(41, 45)),
      chunk('tEXt', Buffer.from('key\0value')), chunk('IDAT', pixel.subarray(45, 52)), pixel.subarray(-12)]),
  ];
  for (const [index, corrupt] of malformed.entries()) {
    writeFileSync(path, corrupt);
    assert.throws(() => pngInventory(join(f.input, 'shard-1/snapshots')), `Malformed PNG ${index} must fail`);
    assert.throws(() => mergeShards(f.expected, f.input, f.output));
    assert.equal(existsSync(f.output), false);
  }
  // Distinct valid images reach the independent duplicate-conflict check.
  writeFileSync(path, otherPixel);
  assert.equal(pngInventory(join(f.input, 'shard-1/snapshots')).length, 1);
});

test('unsafe relative paths and root directory symlinks are rejected', (t) => {
  for (const path of ['', '../x', '/tmp/x', 'a//b', 'a/./b', 'a/../b', 'a\\b', 'C:/x', 'a\0b']) assert.throws(() => safePath(path));
  const f = fixture(t);
  const link = join(f.root, 'link'); symlinkSync(f.input, link);
  assert.throws(() => files(link), /real directory/);
  assert.throws(() => mergeShards(f.expected, link, f.output), /real directory/);
});

test('zero-PNG shard is valid but all expected paths still require complete evidence', (t) => {
  const f = fixture(t);
  rmSync(join(f.input, 'shard-2/snapshots'), { recursive: true });
  f.save(2, []);
  f.expected.baselines = [f.expected.baselines[0]];
  assert.equal(mergeShards(f.expected, f.input, f.output).pngs.length, 1);
});

test('normal comparisons verify both manifests without staging duplicate screenshots', (t) => {
  const f = fixture(t);
  f.expected.generate = false;
  for (const index of [1, 2]) {
    rmSync(join(f.input, `shard-${index}/snapshots`), { recursive: true });
    f.save(index, []);
  }
  assert.equal(mergeShards(f.expected, f.input, f.output).pngs.length, 0);
  assert.deepEqual(files(f.output), ['verification.json']);
});

test('real Playwright reports and CLI transport preserve skips/retries and exclude stale baseline copies', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'browser-shard-reporter-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const require = createRequire(import.meta.url);
  const packageRoot = dirname(require.resolve('@playwright/test/package.json'));
  const importURL = pathToFileURL(join(packageRoot, 'index.mjs')).href;
  writeFileSync(join(root, 'playwright.config.mjs'), 'export default { testDir: ".", fullyParallel: true, workers: 2, retries: 1, reporter: "json", projects: [{ name: "reporter-contract" }] };');
  writeFileSync(join(root, 'reporter.spec.mjs'), `import {test,expect} from ${JSON.stringify(importURL)};
test('passes', () => expect(1).toBe(1));
test('dynamic skip', () => test.skip(true, 'Intentional coverage branch'));
test('one retry', ({}, info) => expect(info.retry).toBe(1));
test('also passes', () => expect(2).toBe(2));`);
  const runCLI = (...args) => JSON.parse(execFileSync(process.execPath, [join(packageRoot, 'cli.js'), 'test', ...args],
    { cwd: root, encoding: 'utf8', env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: '', PLAYWRIGHT_JSON_OUTPUT_FILE: '' } }));
  const expected = reportTests(runCLI('--list')).map((row) => row.id).sort();
  const reports = [1, 2].map((index) => {
    const actual = runCLI(`--shard=${index}/2`);
    assert.deepEqual(actual.config.shard, { current: index, total: 2 });
    return actual;
  });
  const observed = reports.flatMap((actual) => reportTests(actual, true));
  assert.deepEqual(observed.map((row) => row.id).sort(), expected);
  assert.deepEqual(observed.map((row) => row.outcome).sort(), ['expected', 'expected', 'flaky', 'skipped']);

  // Exercise the actual prepare/pack/merge CLI contract without a browser or
  // application data: the tiny PNGs here are synthetic transport fixtures.
  const sourcePlan = { ...plan(), tests: expected,
    shards: reports.map((actual, index) => ({ index: index + 1, tests: reportTests(actual).map((row) => row.id).sort() })) };
  const script = fileURLToPath(new URL('../../scripts/browser-shard-artifacts.mjs', import.meta.url));
  const cliEnv = { ...process.env, GITHUB_SHA: run.sha, GITHUB_RUN_ID: run.run, GITHUB_RUN_ATTEMPT: run.attempt };
  const runArtifactCLI = (cwd, ...args) => execFileSync(process.execPath, [script, ...args], { cwd, env: cliEnv, encoding: 'utf8' });
  mkdirSync(join(root, '.browser-quality'), { recursive: true });
  writeFileSync(join(root, '.browser-quality/plan.json'), JSON.stringify(sourcePlan));
  for (const index of [1, 2]) {
    const runner = join(root, `runner-${index}`);
    mkdirSync(join(runner, '.browser-quality'), { recursive: true });
    writeFileSync(join(runner, '.browser-quality/plan.json'), JSON.stringify(sourcePlan));
    for (const path of sourcePlan.baselines) {
      const target = join(runner, 'tests/e2e/__snapshots__', path);
      mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, pixel);
    }
    runArtifactCLI(runner, 'prepare', String(index));
    assert.equal(existsSync(join(runner, 'tests/e2e/__snapshots__')), false);
    assert.equal(pngInventory(join(runner, '.browser-quality/committed-snapshots')).length, 2);
    const fresh = join(runner, 'tests/e2e/__snapshots__', sourcePlan.baselines[index - 1]);
    mkdirSync(dirname(fresh), { recursive: true }); writeFileSync(fresh, pixel);
    writeFileSync(join(runner, '.browser-quality/result.json'), JSON.stringify(reports[index - 1]));
    runArtifactCLI(runner, 'pack', String(index));
    const staged = join(runner, `.browser-quality/shard-${index}`);
    assert.equal(JSON.parse(readFileSync(join(staged, 'manifest.json'))).pngs.length, 1);
    cpSync(staged, join(root, `.browser-quality/received/shard-${index}`), { recursive: true });
  }
  runArtifactCLI(root, 'merge');
  const result = JSON.parse(readFileSync(join(root, '.browser-quality/verified/verification.json')));
  assert.equal(result.tests, 4);
  assert.equal(result.pngs.length, 2);
});
