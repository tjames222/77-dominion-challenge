import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");

export const RECONCILIATION_STAGE_SCHEMA =
  "77-dominion-reconciliation-stage/v1";
export const EXPECTED_SUPABASE_CLI_VERSION = "2.109.0";
export const EXPECTED_POSTGRES_IMAGE_VERSION = "17.6.1.141";
export const EXPECTED_RELEASE_MIGRATION_COUNT = 53;
export const HISTORICAL_RECONCILIATION_VERSIONS = Object.freeze([
  "20260707170000",
  "20260708154000",
  "20260708155500",
  "20260708160000",
  "20260709163000",
  "20260710120000",
  "20260710123000",
  "20260713120000",
  "20260714120000",
  "20260715190000",
  "20260716061500",
  "20260716153000",
  "20260716163000",
]);

function fail(message) {
  throw new Error(`Reconciliation stage: ${message}`);
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function compareAscii(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function runGit(argumentsList, root = repositoryRoot, encoding = "utf8") {
  const result = spawnSync("git", argumentsList, {
    cwd: root,
    encoding,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const stderr = Buffer.isBuffer(result.stderr)
      ? result.stderr.toString("utf8")
      : result.stderr;
    fail(`git ${argumentsList[0]} failed: ${(stderr || "unknown error").trim()}`);
  }
  return result.stdout;
}

function normalizeExactCommit(input, root = repositoryRoot) {
  if (!/^[0-9a-f]{40}$/u.test(input || "")) {
    fail("--release-commit must be an exact lowercase 40-character Git SHA.");
  }
  const resolved = runGit(["rev-parse", "--verify", `${input}^{commit}`], root)
    .trim();
  if (resolved !== input) {
    fail(`release commit resolved to ${resolved}, not the exact requested SHA.`);
  }
  return resolved;
}

function parseTreeRecord(record) {
  const separator = record.indexOf(0x09);
  if (separator < 0) fail("received an invalid Git tree record.");
  const header = record.subarray(0, separator).toString("utf8");
  const treePath = record.subarray(separator + 1).toString("utf8");
  const match = /^(\d+) (\w+) ([0-9a-f]{40})$/u.exec(header);
  if (!match) fail("received an invalid Git tree header.");
  return {
    mode: match[1],
    type: match[2],
    blobSha1: match[3],
    path: treePath,
  };
}

function listTree(commit, treePath, root = repositoryRoot) {
  const output = runGit(
    ["ls-tree", "-rz", commit, "--", treePath],
    root,
    null,
  );
  const records = [];
  let start = 0;
  for (let index = 0; index < output.length; index += 1) {
    if (output[index] !== 0) continue;
    if (index > start) records.push(parseTreeRecord(output.subarray(start, index)));
    start = index + 1;
  }
  if (start < output.length) fail("Git tree output was not NUL terminated.");
  return records;
}

function readBlob(blobSha1, root = repositoryRoot) {
  return runGit(["cat-file", "blob", blobSha1], root, null);
}

function migrationVersion(treePath) {
  const filename = path.posix.basename(treePath);
  const match = /^(\d{14})_[A-Za-z0-9][A-Za-z0-9_-]*\.sql$/u.exec(filename);
  if (!match) fail(`invalid migration filename at ${treePath}.`);
  return match[1];
}

function assertSafeTreeEntry(entry) {
  if (entry.type !== "blob" || entry.mode !== "100644") {
    fail(`${entry.path} must be a regular non-executable Git blob.`);
  }
  if (
    path.posix.isAbsolute(entry.path)
    || entry.path.split("/").some((part) => part === ".." || part === "")
  ) {
    fail(`unsafe Git tree path: ${entry.path}.`);
  }
}

function selectSingleEntry(entries, requestedPath) {
  const matches = entries.filter((entry) => entry.path === requestedPath);
  if (matches.length !== 1) {
    fail(`expected exactly one Git blob at ${requestedPath}.`);
  }
  assertSafeTreeEntry(matches[0]);
  return matches[0];
}

export function buildReconciliationStagePlan({
  releaseCommit,
  throughVersion,
  root = repositoryRoot,
} = {}) {
  const commit = normalizeExactCommit(releaseCommit, root);
  const targetIndex = HISTORICAL_RECONCILIATION_VERSIONS.indexOf(
    throughVersion,
  );
  if (targetIndex < 0) {
    fail(
      `--through-version must be one of the 13 historical reconciliation versions.`,
    );
  }

  const migrations = listTree(commit, "supabase/migrations", root)
    .filter((entry) => entry.path.endsWith(".sql"))
    .sort((left, right) => compareAscii(left.path, right.path));
  if (migrations.length !== EXPECTED_RELEASE_MIGRATION_COUNT) {
    fail(
      `release commit must contain exactly ${EXPECTED_RELEASE_MIGRATION_COUNT} migrations; found ${migrations.length}.`,
    );
  }
  for (const entry of migrations) assertSafeTreeEntry(entry);

  const versions = migrations.map((entry) => migrationVersion(entry.path));
  const uniqueVersions = new Set(versions);
  if (uniqueVersions.size !== versions.length) {
    fail("release commit contains duplicate migration versions.");
  }
  const historicalPrefix = versions.slice(
    0,
    HISTORICAL_RECONCILIATION_VERSIONS.length,
  );
  if (
    JSON.stringify(historicalPrefix)
    !== JSON.stringify(HISTORICAL_RECONCILIATION_VERSIONS)
  ) {
    fail("release commit does not contain the exact approved migrations 1–13.");
  }

  const supportingEntries = listTree(commit, "supabase", root);
  const config = selectSingleEntry(
    supportingEntries,
    "supabase/config.toml",
  );
  const postgresVersion = selectSingleEntry(
    supportingEntries,
    "supabase/.temp/postgres-version",
  );
  const postgresVersionBytes = readBlob(postgresVersion.blobSha1, root);
  if (postgresVersionBytes.toString("utf8").trim() !== EXPECTED_POSTGRES_IMAGE_VERSION) {
    fail(
      `release commit must pin PostgreSQL ${EXPECTED_POSTGRES_IMAGE_VERSION}.`,
    );
  }

  const selectedMigrations = migrations.slice(0, targetIndex + 1);
  const sourceEntries = [config, postgresVersion, ...selectedMigrations]
    .sort((left, right) => compareAscii(left.path, right.path))
    .map((entry) => {
      const contents = readBlob(entry.blobSha1, root);
      return {
        ...entry,
        bytes: contents.length,
        contents,
        sha256: sha256(contents),
      };
    });

  const manifest = {
    schema: RECONCILIATION_STAGE_SCHEMA,
    releaseCommit: commit,
    throughVersion,
    historicalStageNumber: targetIndex + 1,
    includedVersions: HISTORICAL_RECONCILIATION_VERSIONS.slice(
      0,
      targetIndex + 1,
    ),
    totalReleaseMigrationCount: migrations.length,
    supabaseCliVersion: EXPECTED_SUPABASE_CLI_VERSION,
    postgresImageVersion: EXPECTED_POSTGRES_IMAGE_VERSION,
    files: sourceEntries.map(
      ({ blobSha1, bytes, mode, path: entryPath, sha256: digest, type }) => ({
        path: entryPath,
        mode,
        type,
        blobSha1,
        sha256: digest,
        bytes,
      }),
    ),
  };

  return { manifest, sourceEntries };
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function requireSafeExternalOutput(outputPath, root) {
  if (!path.isAbsolute(outputPath || "")) {
    fail("--output must be an absolute path outside the repository.");
  }
  const parent = await realpath(path.dirname(outputPath));
  const resolvedRoot = await realpath(root);
  const resolvedOutput = path.join(parent, path.basename(outputPath));
  if (isWithin(resolvedRoot, resolvedOutput)) {
    fail("the reconciliation stage must be outside the repository.");
  }
  try {
    await lstat(resolvedOutput);
    fail("the output path already exists; use a new empty path.");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return resolvedOutput;
}

async function writeStageFile(stageRoot, sourcePath, contents) {
  const destination = path.join(stageRoot, ...sourcePath.split("/"));
  if (!isWithin(stageRoot, destination)) fail(`unsafe stage path: ${sourcePath}.`);
  await mkdir(path.dirname(destination), { mode: 0o700, recursive: true });
  await writeFile(destination, contents, { flag: "wx", mode: 0o600 });
}

export async function prepareReconciliationStage({
  output,
  releaseCommit,
  throughVersion,
  root = repositoryRoot,
} = {}) {
  const outputPath = await requireSafeExternalOutput(output, root);
  const { manifest, sourceEntries } = buildReconciliationStagePlan({
    releaseCommit,
    throughVersion,
    root,
  });
  const temporaryRoot = path.join(
    path.dirname(outputPath),
    `.${path.basename(outputPath)}.tmp-${process.pid}-${randomUUID()}`,
  );
  await mkdir(temporaryRoot, { mode: 0o700 });
  try {
    for (const entry of sourceEntries) {
      await writeStageFile(temporaryRoot, entry.path, entry.contents);
    }
    await writeStageFile(
      temporaryRoot,
      "reconciliation-stage.json",
      Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"),
    );
    await verifyReconciliationStage({
      stage: temporaryRoot,
      releaseCommit,
      throughVersion,
      root,
    });
    await rename(temporaryRoot, outputPath);
  } catch (error) {
    await rm(temporaryRoot, { force: true, recursive: true });
    throw error;
  }
  return { manifest, output: outputPath };
}

async function listStageFiles(stageRoot, current = stageRoot) {
  const files = [];
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(current, entry.name);
    const metadata = await lstat(entryPath);
    if (metadata.isSymbolicLink()) fail("stage must not contain symbolic links.");
    if (metadata.isDirectory()) {
      files.push(...await listStageFiles(stageRoot, entryPath));
      continue;
    }
    if (!metadata.isFile()) fail("stage may contain only directories and files.");
    files.push(path.relative(stageRoot, entryPath).split(path.sep).join("/"));
  }
  return files.sort(compareAscii);
}

export async function verifyReconciliationStage({
  stage,
  releaseCommit,
  throughVersion,
  root = repositoryRoot,
} = {}) {
  if (!path.isAbsolute(stage || "")) fail("--verify-stage must be absolute.");
  const stageMetadata = await lstat(stage);
  if (stageMetadata.isSymbolicLink() || !stageMetadata.isDirectory()) {
    fail("stage must be a real directory, not a symbolic link.");
  }
  const stageRoot = await realpath(stage);
  const resolvedRoot = await realpath(root);
  if (isWithin(resolvedRoot, stageRoot)) {
    fail("the reconciliation stage must be outside the repository.");
  }

  const expected = buildReconciliationStagePlan({
    releaseCommit,
    throughVersion,
    root,
  });
  const manifestPath = path.join(stageRoot, "reconciliation-stage.json");
  const manifestMetadata = await lstat(manifestPath);
  if (manifestMetadata.isSymbolicLink() || !manifestMetadata.isFile()) {
    fail("stage manifest must be a regular file.");
  }
  let actualManifest;
  try {
    actualManifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    fail("stage manifest is not valid JSON.");
  }
  if (JSON.stringify(actualManifest) !== JSON.stringify(expected.manifest)) {
    fail("stage manifest does not match the immutable release commit.");
  }

  const expectedPaths = [
    "reconciliation-stage.json",
    ...expected.manifest.files.map(({ path: filePath }) => filePath),
  ].sort(compareAscii);
  const actualPaths = await listStageFiles(stageRoot);
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
    fail("stage contains missing or unexpected files.");
  }
  for (const expectedFile of expected.manifest.files) {
    const filePath = path.join(stageRoot, ...expectedFile.path.split("/"));
    const metadata = await lstat(filePath);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      fail(`${expectedFile.path} must be a regular file.`);
    }
    const contents = await readFile(filePath);
    if (
      contents.length !== expectedFile.bytes
      || sha256(contents) !== expectedFile.sha256
    ) {
      fail(`${expectedFile.path} does not match the immutable Git blob.`);
    }
  }
  return expected.manifest;
}

function parseArguments(argumentsList) {
  const options = {};
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (
      argument === "--output"
      || argument === "--release-commit"
      || argument === "--through-version"
      || argument === "--verify-stage"
    ) {
      const value = argumentsList[index + 1];
      if (!value || value.startsWith("--")) fail(`${argument} requires a value.`);
      const key = argument.slice(2).replaceAll("-", "_");
      if (options[key]) fail(`${argument} may be supplied only once.`);
      options[key] = value;
      index += 1;
      continue;
    }
    fail(`unsupported argument: ${argument}`);
  }
  if (!options.release_commit) fail("--release-commit is required.");
  if (!options.through_version) fail("--through-version is required.");
  if (Boolean(options.output) === Boolean(options.verify_stage)) {
    fail("provide exactly one of --output or --verify-stage.");
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.output) {
    const result = await prepareReconciliationStage({
      output: options.output,
      releaseCommit: options.release_commit,
      throughVersion: options.through_version,
    });
    console.log(
      `Prepared immutable reconciliation stage ${result.manifest.historicalStageNumber}/13 at ${result.output}.`,
    );
    return;
  }
  const manifest = await verifyReconciliationStage({
    stage: options.verify_stage,
    releaseCommit: options.release_commit,
    throughVersion: options.through_version,
  });
  console.log(
    `Verified immutable reconciliation stage ${manifest.historicalStageNumber}/13 for ${manifest.releaseCommit}.`,
  );
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
