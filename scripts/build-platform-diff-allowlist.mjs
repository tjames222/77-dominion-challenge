import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import {
  compareManifests,
  parseManifestText,
} from './compare-database-manifests.mjs';
import { readFile } from 'node:fs/promises';

const ALLOWED_PLATFORM_KEY_PATTERNS = [
  /^platform-function\//u,
  /^platform-relation\//u,
  /^direct-acl\/platform-(?:function|relation)-acl\//u,
  /^effective-acl\/(?:function\/storage\.|relation\/storage\.|sequence\/storage\.)/u,
];

export function isPlatformDifferenceKey(key) {
  return ALLOWED_PLATFORM_KEY_PATTERNS.some((pattern) => pattern.test(key));
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
  if (postgresImage !== '17.6.1.141') {
    throw new Error(`only the reviewed Postgres image 17.6.1.141 is accepted, found ${postgresImage}.`);
  }

  const expected = parseManifestText(await readFile(positional[0], 'utf8'), positional[0]);
  const actual = parseManifestText(await readFile(positional[1], 'utf8'), positional[1]);
  const differences = compareManifests(expected, actual);
  const applicationDifferences = differences.filter(({ key }) => !isPlatformDifferenceKey(key));
  if (applicationDifferences.length > 0) {
    throw new Error(
      'refusing to allowlist application-owned differences: '
      + applicationDifferences.map(({ key }) => key).join(', '),
    );
  }

  const allowlist = {
    schemaVersion: 1,
    postgresImage,
    differences: differences.map(({ key, expectedSha256, actualSha256 }) => ({
      key,
      expectedSha256,
      actualSha256,
      reason: 'Exact reviewed Supabase platform object difference on Postgres 17.6.1.141.',
    })),
  };
  await writeFile(output, `${JSON.stringify(allowlist, null, 2)}\n`, { flag: 'wx' });
  process.stdout.write(
    `Wrote ${differences.length} exact platform difference(s) to ${output}. Review every entry before use.\n`,
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
