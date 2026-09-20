import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { inflateSync } from 'node:zlib';

const snapshotRoot = 'tests/e2e/__snapshots__';
const stateRoot = '.browser-quality';
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const json = (file) => JSON.parse(readFileSync(file, 'utf8'));
let pngDecoder;
const crcTable = Uint32Array.from({ length: 256 }, (_, byte) => {
  let value = byte;
  for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value >>> 0;
});
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255];
  return (crc ^ 0xffffffff) >>> 0;
}
function validatePng(bytes, path) {
  assert.ok(bytes.length > 45 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
    && bytes.readUInt32BE(8) === 13 && bytes.subarray(12, 16).toString() === 'IHDR'
    && bytes.subarray(-12).equals(Buffer.from('0000000049454e44ae426082', 'hex')), `Invalid PNG: ${path}`);
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  assert.ok(width > 0 && width <= 8192 && height > 0 && height <= 65536
    && width * height <= 64_000_000 && bytes.length <= 32 * 1024 * 1024, `PNG exceeds decode bounds: ${path}`);
  const color = bytes[25];
  // Browser screenshot artifacts, not arbitrary uploaded images: the current
  // 325 baselines are all RGB8/non-interlaced; RGBA8 is also emitted by browsers.
  assert.ok(bytes[24] === 8 && [2, 6].includes(color) && bytes[26] === 0
    && bytes[27] === 0 && bytes[28] === 0, `Unsupported screenshot PNG header: ${path}`);
  const channels = color === 2 ? 3 : 4;
  let offset = 8;
  let dataState = 'before';
  let ended = false;
  const compressed = [];
  while (offset < bytes.length) {
    assert.ok(offset + 12 <= bytes.length, `Truncated PNG chunk: ${path}`);
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    assert.ok(end <= bytes.length, `Truncated PNG chunk data: ${path}`);
    const type = bytes.subarray(offset + 4, offset + 8).toString('latin1');
    assert.match(type, /^[A-Za-z]{2}[A-Z][A-Za-z]$/);
    assert.equal(bytes.readUInt32BE(end - 4), crc32(bytes.subarray(offset + 4, end - 4)), `PNG CRC mismatch: ${path}`);
    assert.ok((offset === 8) === (type === 'IHDR'), `Duplicate/misplaced PNG header: ${path}`);
    if (type === 'IDAT') {
      assert.notEqual(dataState, 'after', `Noncontiguous PNG image data: ${path}`);
      dataState = 'during';
      compressed.push(bytes.subarray(offset + 8, end - 4));
    } else if (dataState === 'during') dataState = 'after';
    if (type === 'IEND') {
      assert.ok(length === 0 && end === bytes.length, `Misplaced PNG end: ${path}`);
      ended = true;
    }
    offset = end;
  }
  assert.ok(ended && compressed.length > 0, `Missing PNG image data/end: ${path}`);
  // pngjs pads an underfilled scanline, so independently require the exact
  // bounded inflated length before decoding pixels. One filter byte per row.
  const rowSize = 1 + width * channels;
  const inflatedSize = height * rowSize;
  assert.ok(inflatedSize <= 256 * 1024 * 1024, `PNG exceeds scanline bounds: ${path}`);
  const inflated = inflateSync(Buffer.concat(compressed), { maxOutputLength: inflatedSize });
  assert.equal(inflated.length, inflatedSize, `Incomplete PNG scanlines: ${path}`);
  for (let offset = 0; offset < inflated.length; offset += rowSize) assert.ok(inflated[offset] <= 4, `Invalid PNG filter: ${path}`);
  // Reuse the exact decoder already pinned by Playwright; do not trust header
  // markers alone. Loading is lazy so the fail-closed needs check is dependency-free.
  if (!pngDecoder) {
    const require = createRequire(import.meta.url);
    const fromPlaywright = createRequire(require.resolve('@playwright/test/package.json'));
    pngDecoder = fromPlaywright('playwright-core/lib/utilsBundle').PNG;
  }
  const decoded = pngDecoder.sync.read(bytes, { checkCRC: true });
  assert.equal(decoded.width, width);
  assert.equal(decoded.height, height);
  assert.equal(decoded.data.length, width * height * 4, `Incomplete PNG scanlines: ${path}`);
}
const writeJson = (file, value) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
};

export function safePath(value) {
  assert.equal(typeof value, 'string');
  assert.ok(value && !value.includes('\\') && !value.includes('\0'), 'Unsafe artifact path');
  assert.ok(value.split('/').every((part) => part && part !== '.' && part !== '..'), 'Unsafe artifact path');
  assert.ok(!/^[A-Za-z]:/.test(value), 'Unsafe artifact path');
  return value;
}

// Never follow artifact symlinks, including a symlink used as the root directory.
export function files(root, prefix = '') {
  const stat = lstatSync(root, { throwIfNoEntry: false });
  if (!stat) return [];
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), 'Artifact root must be a real directory');
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const relative = safePath(prefix ? `${prefix}/${entry.name}` : entry.name);
    assert.ok(!entry.isSymbolicLink(), 'Artifact symlinks are forbidden');
    if (entry.isDirectory()) return files(join(root, entry.name), relative);
    assert.ok(entry.isFile(), 'Artifact must contain only regular files');
    return [relative];
  }).sort();
}

export function pngInventory(root) {
  return files(root).filter((file) => file.endsWith('.png')).map((path) => {
    const bytes = readFileSync(join(root, path));
    validatePng(bytes, path);
    return { path, bytes: bytes.length, sha256: digest(bytes) };
  });
}

export function reportTests(report, completed = false) {
  assert.deepEqual(report.errors, [], 'Playwright global errors');
  const rows = [];
  function visit(suite) {
    for (const spec of suite.specs || []) {
      for (const entry of spec.tests || []) {
        assert.ok(spec.id && entry.projectId, 'Missing test identity');
        const row = { id: `${entry.projectId}:${spec.id}` };
        if (completed) {
          const statuses = entry.results.map((result) => result.status);
          assert.ok(statuses.length > 0 && statuses.length <= 2, `Incomplete/excess retries: ${row.id}`);
          assert.ok(['expected', 'flaky', 'skipped'].includes(entry.status), `Failed test: ${row.id}`);
          assert.ok(['passed', 'skipped'].includes(statuses.at(-1)), `Incomplete outcome: ${row.id}`);
          assert.equal(entry.expectedStatus, statuses.at(-1), `Unexpected terminal status: ${row.id}`);
          row.outcome = entry.status;
        }
        rows.push(row);
      }
    }
    for (const child of suite.suites || []) visit(child);
  }
  visit(report);
  assert.ok(rows.length, 'Empty test inventory');
  assert.equal(new Set(rows.map((row) => row.id)).size, rows.length, 'Duplicate test identity');
  return rows.sort((a, b) => a.id.localeCompare(b.id));
}

export function identity(env = process.env) {
  assert.match(env.GITHUB_SHA || '', /^[a-f0-9]{40}$/);
  for (const key of ['GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT']) assert.match(env[key] || '', /^[1-9]\d*$/);
  return { sha: env.GITHUB_SHA, run: env.GITHUB_RUN_ID, attempt: env.GITHUB_RUN_ATTEMPT };
}

export function validatePlan(plan, expectedIdentity) {
  assert.equal(plan.version, 1);
  assert.deepEqual(plan.identity, expectedIdentity, 'Wrong SHA/run/attempt');
  assert.equal(plan.total, 2);
  assert.equal(typeof plan.generate, 'boolean');
  assert.ok(Array.isArray(plan.baselines));
  assert.deepEqual(plan.baselines, [...new Set(plan.baselines)].sort(), 'Duplicate/unsorted baseline paths');
  plan.baselines.forEach((path) => assert.ok(safePath(path).endsWith('.png')));
  assert.equal(plan.shards.length, 2);
  assert.deepEqual(plan.shards.map((shard) => shard.index), [1, 2]);
  const union = plan.shards.flatMap((shard) => shard.tests);
  assert.ok(plan.tests.length && plan.shards.every((shard) => shard.tests.length));
  assert.equal(new Set(union).size, union.length, 'Overlapping shard tests');
  assert.deepEqual([...union].sort(), plan.tests, 'Incomplete shard partition');
  return plan;
}

export function assertNeeds(needs) {
  assert.deepEqual(Object.keys(needs).sort(), ['browser-shards', 'preflight']);
  for (const [name, job] of Object.entries(needs)) assert.equal(job.result, 'success', `${name} did not succeed`);
}

export function validateManifest(plan, manifest, shardRoot) {
  assert.equal(manifest.version, 1);
  assert.deepEqual(manifest.identity, plan.identity, 'Wrong SHA/run/attempt');
  assert.equal(manifest.total, plan.total);
  assert.equal(manifest.generate, plan.generate);
  assert.ok([1, 2].includes(manifest.index), 'Unexpected shard');
  const expected = plan.shards.find((shard) => shard.index === manifest.index).tests;
  assert.deepEqual(manifest.tests.map((test) => test.id).sort(), expected, 'Missing/duplicate/unexpected test');
  assert.ok(manifest.tests.every((test) => ['expected', 'flaky', 'skipped'].includes(test.outcome)), 'Unsuccessful test');
  assert.deepEqual(manifest.pngs, pngInventory(join(shardRoot, 'snapshots')), 'PNG inventory/hash mismatch');
  if (!plan.generate) assert.deepEqual(manifest.pngs, [], 'Comparison runs must not upload baselines');
  const allowed = ['manifest.json', ...manifest.pngs.map((png) => `snapshots/${png.path}`)].sort();
  assert.deepEqual(files(shardRoot), allowed, 'Unexpected or missing artifact files');
}

export function mergeShards(plan, inputRoot, outputRoot) {
  assert.ok(!lstatSync(outputRoot, { throwIfNoEntry: false }), 'Refusing to overwrite adoption output');
  files(inputRoot);
  const entries = readdirSync(inputRoot).sort();
  assert.deepEqual(entries, ['shard-1', 'shard-2'], 'Missing/extra shard artifact');
  const seen = new Map();
  const manifests = [];
  for (const index of [1, 2]) {
    const root = join(inputRoot, `shard-${index}`);
    // Scan before reading JSON so symlinked manifests cannot escape the artifact.
    files(root);
    const manifest = json(join(root, 'manifest.json'));
    assert.equal(manifest.index, index, 'Wrong shard directory');
    validateManifest(plan, manifest, root);
    manifests.push(manifest);
    for (const png of manifest.pngs) {
      const previous = seen.get(png.path);
      if (previous) assert.ok(readFileSync(previous.source).equals(readFileSync(join(root, 'snapshots', png.path))), `Conflicting PNG: ${png.path}`);
      else seen.set(png.path, { ...png, source: join(root, 'snapshots', png.path) });
    }
  }
  if (plan.generate) {
    assert.ok(seen.size, 'No generated baselines');
    for (const path of plan.baselines) assert.ok(seen.has(path), `Missing regenerated baseline: ${path}`);
  }
  // Nothing is written until BOTH manifests, their complete inventories and all pixels pass.
  const verification = { version: 1, identity: plan.identity, generate: plan.generate, tests: plan.tests.length,
    shards: manifests.map((manifest) => ({ index: manifest.index, tests: manifest.tests.length })),
    pngs: [...seen.values()].map(({ source, ...png }) => png).sort((a, b) => a.path.localeCompare(b.path)) };
  writeJson(join(outputRoot, 'verification.json'), verification);
  for (const png of seen.values()) {
    const target = join(outputRoot, 'snapshots', png.path);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(png.source, target);
  }
  return verification;
}

function main(command, shardText) {
  const planFile = join(stateRoot, 'plan.json');
  if (command === 'needs') return assertNeeds(JSON.parse(process.env.BROWSER_NEEDS));
  if (command === 'plan') {
    const discover = (shard) => JSON.parse(execFileSync(process.execPath, [
      'node_modules/@playwright/test/cli.js', 'test', '--list', '--reporter=json', ...(shard ? [`--shard=${shard}/2`] : []),
    ], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));
    const baselines = pngInventory(snapshotRoot).map((png) => png.path);
    const generate = process.env.BROWSER_REQUEST_GENERATION === 'true' || baselines.length === 0;
    const plan = { version: 1, identity: identity(), total: 2, generate, baselines,
      tests: reportTests(discover()).map((test) => test.id).sort(),
      shards: [1, 2].map((index) => ({ index, tests: reportTests(discover(index)).map((test) => test.id).sort() })) };
    validatePlan(plan, identity());
    writeJson(planFile, plan);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `generate=${generate}\npresent=${baselines.length > 0}\n`);
    console.log(`Verified ${plan.tests.length} tests partitioned into ${plan.shards.map((shard) => shard.tests.length).join(' + ')}.`);
    return;
  }
  files(stateRoot);
  const plan = validatePlan(json(planFile), identity());
  if (command === 'merge') {
    const result = mergeShards(plan, join(stateRoot, 'received'), join(stateRoot, 'verified'));
    console.log(`Verified ${result.tests} test outcomes and ${result.pngs.length} generated PNGs.`);
    return;
  }
  const index = Number(shardText);
  assert.ok([1, 2].includes(index), 'Expected shard 1 or 2');
  if (command === 'prepare') {
    if (plan.generate && existsSync(snapshotRoot)) {
      const target = join(stateRoot, 'committed-snapshots');
      assert.ok(!existsSync(target), 'Already prepared');
      files(snapshotRoot);
      renameSync(snapshotRoot, target);
    }
    return;
  }
  assert.equal(command, 'pack', 'Unknown command');
  const report = json(join(stateRoot, 'result.json'));
  assert.deepEqual(report.config.shard, { current: index, total: 2 });
  const tests = reportTests(report, true);
  const pngs = plan.generate ? pngInventory(snapshotRoot) : [];
  const root = join(stateRoot, `shard-${index}`);
  assert.ok(!existsSync(root), 'Refusing to overwrite shard output');
  const manifest = { version: 1, identity: plan.identity, total: 2, index, generate: plan.generate, tests, pngs };
  assert.deepEqual(tests.map((test) => test.id).sort(), plan.shards[index - 1].tests, 'Incomplete shard result');
  writeJson(join(root, 'manifest.json'), manifest);
  for (const png of pngs) {
    const target = join(root, 'snapshots', png.path);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(snapshotRoot, png.path), target);
  }
  validateManifest(plan, manifest, root);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(...process.argv.slice(2));
}
