import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const WILDCARD_PATTERN = /[*?\[\]]/;
const PLATFORM_PRESENCE_KEY_PREFIX = 'platform-relation-presence/';
const OPTIONAL_PLATFORM_RELATIONS = new Set([
  'storage.iceberg_namespaces',
  'storage.iceberg_tables',
]);
const NON_ALLOWLISTABLE_KEY_PATTERNS = [
  /^storage-row-inventory\//u,
  /^data\/storage\.[^/]+\/all-rows$/u,
];

export function isOptionalPlatformRelationStructureKey(key) {
  return [...OPTIONAL_PLATFORM_RELATIONS].some((identity) => (
    key === `platform-relation/${identity}`
    || key.startsWith(`direct-acl/platform-relation-acl/${identity}/`)
    || key.startsWith(`direct-acl/platform-column-acl/${identity}.`)
    || key.startsWith(`effective-acl/relation/${identity}/`)
    || key.startsWith(`effective-acl/column/${identity}.`)
    || key.startsWith(`platform-trigger/${identity}/`)
  ));
}

export function stableStringify(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${stableStringify(value[key])}`
  )).join(',')}}`;
}

export function recordSha256(record) {
  return createHash('sha256').update(stableStringify(record)).digest('hex');
}

export function parseManifestText(text, source = '<manifest>') {
  const records = new Map();
  let previousKey = null;
  const lines = text.split(/\r?\n/u);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;

    let record;
    try {
      record = JSON.parse(line);
    } catch (error) {
      throw new Error(`${source}:${index + 1}: invalid JSON: ${error.message}`);
    }

    if (!record || Array.isArray(record) || typeof record !== 'object') {
      throw new Error(`${source}:${index + 1}: each line must be a JSON object.`);
    }
    const exactKeys = Object.keys(record).sort().join(',');
    if (exactKeys !== 'definition,identity,key,kind') {
      throw new Error(
        `${source}:${index + 1}: records must contain exactly definition, identity, key, and kind.`,
      );
    }
    for (const field of ['key', 'kind', 'identity']) {
      if (typeof record[field] !== 'string' || !record[field]) {
        throw new Error(`${source}:${index + 1}: ${field} must be a non-empty string.`);
      }
    }
    if (!record.definition || Array.isArray(record.definition) || typeof record.definition !== 'object') {
      throw new Error(`${source}:${index + 1}: definition must be a JSON object.`);
    }
    if (records.has(record.key)) {
      throw new Error(`${source}:${index + 1}: duplicate record key ${record.key}.`);
    }
    if (previousKey !== null && Buffer.compare(Buffer.from(previousKey), Buffer.from(record.key)) >= 0) {
      throw new Error(`${source}:${index + 1}: records are not strictly byte-sorted by key.`);
    }
    records.set(record.key, record);
    previousKey = record.key;
  }

  if (records.size === 0) {
    throw new Error(`${source}: manifest is empty.`);
  }
  return records;
}

export function compareManifests(expectedRecords, actualRecords) {
  const differences = [];
  const keys = [...new Set([...expectedRecords.keys(), ...actualRecords.keys()])]
    .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));

  for (const key of keys) {
    const expected = expectedRecords.get(key) ?? null;
    const actual = actualRecords.get(key) ?? null;
    const expectedSha256 = expected ? recordSha256(expected) : null;
    const actualSha256 = actual ? recordSha256(actual) : null;
    if (expectedSha256 !== actualSha256) {
      differences.push({ key, expectedSha256, actualSha256, expected, actual });
    }
  }
  return differences;
}

function hasExactKeys(value, keys) {
  return Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

export function platformPresenceSuppressionRule(difference) {
  if (!difference?.expected || !difference.actual) return null;

  const { expected, actual, key } = difference;
  if (
    expected.kind !== 'platform-relation-presence'
    || actual.kind !== 'platform-relation-presence'
    || expected.identity !== actual.identity
    || key !== `platform-relation-presence/${expected.identity}`
    || !OPTIONAL_PLATFORM_RELATIONS.has(expected.identity)
    || !hasExactKeys(expected.definition, ['present', 'required'])
    || !hasExactKeys(actual.definition, ['present', 'required'])
    || expected.definition.required !== false
    || actual.definition.required !== false
    || typeof expected.definition.present !== 'boolean'
    || typeof actual.definition.present !== 'boolean'
    || expected.definition.present === actual.definition.present
  ) {
    return null;
  }

  return {
    identity: expected.identity,
    absentSide: expected.definition.present ? 'actual' : 'expected',
  };
}

function isRelatedPlatformRecord(record, key, identity) {
  if (!record) return false;
  if (key === `platform-relation/${identity}`) {
    return record.kind === 'platform-relation' && record.identity === identity;
  }
  if (key.startsWith(`direct-acl/platform-relation-acl/${identity}/`)) {
    return record.kind === 'direct-acl'
      && record.identity === identity
      && record.definition?.objectKind === 'platform-relation-acl';
  }
  if (key.startsWith(`direct-acl/platform-column-acl/${identity}.`)) {
    return record.kind === 'direct-acl'
      && record.identity.startsWith(`${identity}.`)
      && record.definition?.objectKind === 'platform-column-acl';
  }
  if (key.startsWith(`effective-acl/relation/${identity}/`)) {
    return record.kind === 'effective-acl'
      && record.identity === identity
      && record.definition?.objectKind === 'relation';
  }
  if (key.startsWith(`effective-acl/column/${identity}.`)) {
    return record.kind === 'effective-acl'
      && record.identity.startsWith(`${identity}.`)
      && record.definition?.objectKind === 'column';
  }
  if (key.startsWith(`platform-trigger/${identity}/`)) {
    return record.kind === 'platform-trigger'
      && record.identity.startsWith(`${identity}.`);
  }
  return false;
}

function isPresenceDependentDifference(difference, rule) {
  const absentRecord = difference[rule.absentSide];
  const presentSide = rule.absentSide === 'expected' ? 'actual' : 'expected';
  const presentRecord = difference[presentSide];
  return absentRecord === null
    && isRelatedPlatformRecord(presentRecord, difference.key, rule.identity);
}

export function validateAllowlist(allowlist, postgresImage, source = '<allowlist>') {
  if (!allowlist || Array.isArray(allowlist) || typeof allowlist !== 'object') {
    throw new Error(`${source}: allowlist must be a JSON object.`);
  }
  const exactKeys = Object.keys(allowlist).sort().join(',');
  if (exactKeys !== 'differences,postgresImage,schemaVersion') {
    throw new Error(`${source}: allowlist must contain exactly schemaVersion, postgresImage, and differences.`);
  }
  if (allowlist.schemaVersion !== 1) {
    throw new Error(`${source}: schemaVersion must be 1.`);
  }
  if (allowlist.postgresImage !== postgresImage) {
    throw new Error(
      `${source}: expected Postgres image ${postgresImage}, found ${allowlist.postgresImage}.`,
    );
  }
  if (!Array.isArray(allowlist.differences)) {
    throw new Error(`${source}: differences must be an array.`);
  }

  const entries = new Map();
  let previousKey = null;
  for (const [index, entry] of allowlist.differences.entries()) {
    if (!entry || Array.isArray(entry) || typeof entry !== 'object') {
      throw new Error(`${source}: differences[${index}] must be an object.`);
    }
    const entryKeys = Object.keys(entry).sort().join(',');
    if (entryKeys !== 'actualSha256,expectedSha256,key,reason') {
      throw new Error(
        `${source}: differences[${index}] must contain exactly key, expectedSha256, actualSha256, and reason.`,
      );
    }
    if (typeof entry.key !== 'string' || !entry.key || WILDCARD_PATTERN.test(entry.key)) {
      throw new Error(`${source}: differences[${index}].key must be exact and contain no wildcard syntax.`);
    }
    if (NON_ALLOWLISTABLE_KEY_PATTERNS.some((pattern) => pattern.test(entry.key))) {
      throw new Error(
        `${source}: differences[${index}].key is a Storage row inventory and cannot be allowlisted.`,
      );
    }
    if (
      entry.key.startsWith(PLATFORM_PRESENCE_KEY_PREFIX)
      && !OPTIONAL_PLATFORM_RELATIONS.has(entry.key.slice(PLATFORM_PRESENCE_KEY_PREFIX.length))
    ) {
      throw new Error(
        `${source}: differences[${index}].key is not an optional platform relation presence record.`,
      );
    }
    if (isOptionalPlatformRelationStructureKey(entry.key)) {
      throw new Error(
        `${source}: differences[${index}].key is optional platform relation structure; `
        + 'only its exact presence transition can be allowlisted.',
      );
    }
    if (previousKey !== null && Buffer.compare(Buffer.from(previousKey), Buffer.from(entry.key)) >= 0) {
      throw new Error(`${source}: differences must be strictly byte-sorted by key.`);
    }
    for (const hashField of ['expectedSha256', 'actualSha256']) {
      if (entry[hashField] !== null && !SHA256_PATTERN.test(entry[hashField])) {
        throw new Error(`${source}: differences[${index}].${hashField} must be null or a lowercase SHA-256.`);
      }
    }
    if (entry.expectedSha256 === entry.actualSha256) {
      throw new Error(`${source}: differences[${index}] does not describe a difference.`);
    }
    if (typeof entry.reason !== 'string' || entry.reason.trim().length < 20) {
      throw new Error(`${source}: differences[${index}].reason must be at least 20 characters.`);
    }
    if (entries.has(entry.key)) {
      throw new Error(`${source}: duplicate allowlist key ${entry.key}.`);
    }
    entries.set(entry.key, entry);
    previousKey = entry.key;
  }
  return entries;
}

export function applyAllowlist(differences, entries) {
  const unmatched = [];
  const used = new Set();
  const presenceRules = [];
  for (const difference of differences) {
    const entry = entries.get(difference.key);
    if (
      entry
      && entry.expectedSha256 === difference.expectedSha256
      && entry.actualSha256 === difference.actualSha256
    ) {
      used.add(difference.key);
      const presenceRule = platformPresenceSuppressionRule(difference);
      if (difference.key.startsWith(PLATFORM_PRESENCE_KEY_PREFIX) && !presenceRule) {
        throw new Error(
          `allowlist entry ${difference.key} is not an exact optional absent/present transition.`,
        );
      }
      if (presenceRule) presenceRules.push(presenceRule);
    } else {
      unmatched.push(difference);
    }
  }

  const remaining = unmatched.filter((difference) => !presenceRules.some(
    (rule) => isPresenceDependentDifference(difference, rule),
  ));

  const unused = [...entries.keys()].filter((key) => !used.has(key));
  if (unused.length > 0) {
    throw new Error(`allowlist contains unused entries: ${unused.join(', ')}`);
  }
  return remaining;
}

function formatDifference(difference) {
  return [
    `- ${difference.key}`,
    `  expected: ${difference.expectedSha256 ?? '<absent>'}`,
    `  actual:   ${difference.actualSha256 ?? '<absent>'}`,
  ].join('\n');
}

async function readManifest(path) {
  return parseManifestText(await readFile(path, 'utf8'), path);
}

async function main(argv) {
  if (argv[0] === '--validate') {
    if (argv.length !== 2) {
      throw new Error('usage: compare-database-manifests.mjs --validate <manifest.jsonl>');
    }
    const records = await readManifest(argv[1]);
    process.stdout.write(`Validated ${records.size} canonical manifest records.\n`);
    return;
  }

  const options = { allowlist: null, postgresImage: null };
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--allowlist' || argument === '--postgres-image') {
      const value = argv[index + 1];
      if (!value) throw new Error(`${argument} requires a value.`);
      options[argument === '--allowlist' ? 'allowlist' : 'postgresImage'] = value;
      index += 1;
    } else {
      positional.push(argument);
    }
  }

  if (positional.length !== 2) {
    throw new Error(
      'usage: compare-database-manifests.mjs <expected.jsonl> <actual.jsonl> '
      + '[--allowlist <allowlist.json> --postgres-image <version>]',
    );
  }
  if (Boolean(options.allowlist) !== Boolean(options.postgresImage)) {
    throw new Error('--allowlist and --postgres-image must be provided together.');
  }

  const expected = await readManifest(positional[0]);
  const actual = await readManifest(positional[1]);
  let differences = compareManifests(expected, actual);
  if (options.allowlist) {
    const allowlist = JSON.parse(await readFile(options.allowlist, 'utf8'));
    const entries = validateAllowlist(allowlist, options.postgresImage, options.allowlist);
    differences = applyAllowlist(differences, entries);
  }

  if (differences.length > 0) {
    throw new Error(
      `database manifests differ in ${differences.length} record(s):\n`
      + differences.map(formatDifference).join('\n'),
    );
  }
  process.stdout.write(`Database manifests match exactly (${expected.size} records).\n`);
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`Database manifest comparison: ${error.message}\n`);
    process.exitCode = 1;
  });
}
