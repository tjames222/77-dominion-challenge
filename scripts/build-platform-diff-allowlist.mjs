import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import {
  applyAllowlist,
  compareManifests,
  isOptionalPlatformRelationStructureKey,
  parseManifestText,
  platformPresenceSuppressionRule,
} from './compare-database-manifests.mjs';

const ALLOWED_PLATFORM_KEY_PATTERNS = [
  /^platform-extension\//u,
  /^platform-function\//u,
  /^platform-event-trigger\//u,
  /^platform-trigger\//u,
  /^platform-relation\//u,
  /^direct-acl\/platform-(?:column|function|relation)-acl\//u,
  /^effective-acl\/(?:column\/storage\.|function\/(?:extensions|storage)\.|relation\/storage\.|sequence\/storage\.)/u,
  /^effective-acl\/function\/public\.rls_auto_enable\(\)\//u,
];

const PLATFORM_PRESENCE_KEY_PREFIX = 'platform-relation-presence/';

export function isPlatformDifferenceKey(key) {
  return ALLOWED_PLATFORM_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

function allowlistEntry(difference) {
  return {
    key: difference.key,
    expectedSha256: difference.expectedSha256,
    actualSha256: difference.actualSha256,
    reason: difference.key.startsWith(PLATFORM_PRESENCE_KEY_PREFIX)
      ? 'Exact reviewed optional Supabase platform relation presence difference on Postgres 17.6.1.141.'
      : 'Exact reviewed Supabase platform object difference on Postgres 17.6.1.141.',
  };
}

export function buildPlatformAllowlist(expected, actual, postgresImage) {
  if (postgresImage !== '17.6.1.141') {
    throw new Error(`only the reviewed Postgres image 17.6.1.141 is accepted, found ${postgresImage}.`);
  }

  const differences = compareManifests(expected, actual);
  const presenceDifferences = differences.filter((difference) => (
    platformPresenceSuppressionRule(difference) !== null
  ));
  const presenceEntries = new Map(presenceDifferences.map((difference) => [
    difference.key,
    allowlistEntry(difference),
  ]));
  const remainingDifferences = applyAllowlist(differences, presenceEntries);
  const applicationDifferences = remainingDifferences.filter(({ key }) => (
    key.startsWith(PLATFORM_PRESENCE_KEY_PREFIX)
    || isOptionalPlatformRelationStructureKey(key)
    || !isPlatformDifferenceKey(key)
  ));
  if (applicationDifferences.length > 0) {
    throw new Error(
      'refusing to allowlist application-owned or unsafe differences: '
      + applicationDifferences.map(({ key }) => key).join(', '),
    );
  }

  const candidateDifferences = [
    ...presenceDifferences,
    ...remainingDifferences,
  ].sort((left, right) => Buffer.compare(Buffer.from(left.key), Buffer.from(right.key)));

  return {
    schemaVersion: 1,
    postgresImage,
    differences: candidateDifferences.map(allowlistEntry),
  };
}

async function main(argv) {
  let output = '';
  let postgresImage = '';
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--output' || argument === '--postgres-image') {
      const value = argv[index + 1];
      if (!value) throw new Error(`${argument} requires a value.`);
      if (argument === '--output') output = value;
      else postgresImage = value;
      index += 1;
    } else {
      positional.push(argument);
    }
  }
  if (positional.length !== 2 || !output || !postgresImage) {
    throw new Error(
      'usage: build-platform-diff-allowlist.mjs <expected.jsonl> <actual.jsonl> '
      + '--postgres-image <version> --output <allowlist.json>',
    );
  }
  const expected = parseManifestText(await readFile(positional[0], 'utf8'), positional[0]);
  const actual = parseManifestText(await readFile(positional[1], 'utf8'), positional[1]);
  const allowlist = buildPlatformAllowlist(expected, actual, postgresImage);
  await writeFile(output, `${JSON.stringify(allowlist, null, 2)}\n`, { flag: 'wx' });
  process.stdout.write(
    `Wrote ${allowlist.differences.length} exact platform difference(s) to ${output}. Review every entry before use.\n`,
  );
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`Platform allowlist builder: ${error.message}\n`);
    process.exitCode = 1;
  });
}
