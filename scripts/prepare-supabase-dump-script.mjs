#!/usr/bin/env node

import assert from "node:assert/strict";
import { lstat, readFile, writeFile } from "node:fs/promises";

function fail(message) {
  throw new Error(message);
}

function parseArguments(tokens) {
  const options = {};
  for (let index = 0; index < tokens.length; index += 2) {
    const flag = tokens[index];
    const value = tokens[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      fail(`invalid argument near ${flag ?? "end of command"}`);
    }
    const name = flag.slice(2);
    if (Object.hasOwn(options, name)) fail(`duplicate option --${name}`);
    options[name] = value;
  }
  assert.deepEqual(
    Object.keys(options).sort(),
    ["database-url-file", "input", "output", "ssl-root-cert-file"],
    "expected exactly --database-url-file, --input, --output, and --ssl-root-cert-file",
  );
  return options;
}

async function readRegular(filename, label) {
  const metadata = await lstat(filename);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    fail(`${label} must be a regular, non-symlink file`);
  }
  return readFile(filename, "utf8");
}

const options = parseArguments(process.argv.slice(2));
const rawUrl = (await readRegular(options["database-url-file"], "database URL file"))
  .replace(/\r?\n$/u, "");
if (/[\r\n]/u.test(rawUrl)) fail("database URL file must contain exactly one line");
let databaseUrl;
try {
  databaseUrl = new URL(rawUrl);
} catch {
  fail("database URL file is invalid");
}
if (!['postgres:', 'postgresql:'].includes(databaseUrl.protocol) || databaseUrl.password) {
  fail("database URL must be a passwordless PostgreSQL URL");
}
const username = decodeURIComponent(databaseUrl.username);
const database = decodeURIComponent(databaseUrl.pathname.slice(1));
const port = databaseUrl.port || "5432";
const sslRootCertFile = options["ssl-root-cert-file"];
if (!sslRootCertFile.startsWith("/") || /['\r\n\u0000]/u.test(sslRootCertFile)) {
  fail("TLS root certificate path must be absolute and single-quote safe");
}
for (const [value, label] of [
  [databaseUrl.hostname, "host"],
  [port, "port"],
  [username, "username"],
  [database, "database"],
]) {
  if (!/^[A-Za-z0-9_.-]+$/u.test(value)) fail(`database ${label} is not shell-safe`);
}

const source = await readRegular(options.input, "Supabase dry-run script");
if (!source.startsWith("#!/usr/bin/env bash\nset -euo pipefail\n")) {
  fail("Supabase dry-run script header does not match the pinned contract");
}
if (/[^\u0009\u000a\u0020-\u007e]/u.test(source)) {
  fail("Supabase dry-run script contains unsupported characters");
}
for (const forbidden of ["PGPASSFILE", "PGSERVICE", "PGSERVICEFILE"]) {
  if (source.includes(forbidden)) fail(`Supabase dry-run script unexpectedly sets ${forbidden}`);
}
const expectedEnvironment = [
  `export PGHOST="${databaseUrl.hostname}"`,
  `export PGPORT="${port}"`,
  `export PGUSER="${username}"`,
  'export PGPASSWORD=""',
  `export PGDATABASE="${database}"`,
];
const actualPgEnvironment = source.split("\n").filter((line) => line.startsWith("export PG"));
assert.deepEqual(
  actualPgEnvironment,
  expectedEnvironment,
  "Supabase dry-run script contains an unexpected libpq environment override",
);
for (const line of expectedEnvironment) {
  if (source.split("\n").filter((candidate) => candidate === line).length !== 1) {
    fail(`Supabase dry-run script does not contain one exact ${line.split("=")[0]} assignment`);
  }
}
if (!/\npg_dump(?:all)? \\\n/u.test(source)) {
  fail("Supabase dry-run script contains no pinned dump command");
}

const executable = source.replace(
  'export PGPASSWORD=""',
  `unset PGPASSWORD\nexport PGPASSFILE="/tmp/dominion/pgpass"\nexport PGSSLMODE="verify-full"\nexport PGSSLROOTCERT="/tmp/dominion/supabase-ca.crt"\nexport PGOPTIONS="-c jit=on"\nexport PGCONNECT_TIMEOUT="15"`,
);
if (executable === source) fail("Supabase dry-run credential boundary was not replaced");
await writeFile(options.output, executable, { flag: "wx", mode: 0o600 });
