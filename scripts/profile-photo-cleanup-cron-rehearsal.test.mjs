import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const rehearsalPath = path.join(
  scriptDirectory,
  "rehearse-profile-photo-cleanup-cron.sh",
);
const bridgePath = path.join(
  scriptDirectory,
  "fixtures",
  "profile-photo-cleanup-supabase-bridge.ts",
);

test("the reset acknowledgement fails before any local-stack command", async () => {
  const result = spawnSync("bash", [rehearsalPath], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: {
      PATH: "/usr/bin:/bin",
    },
  });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /--confirm-local-reset/);
  assert.doesNotMatch(result.stdout + result.stderr, /resetting local database/i);
});

test("the rehearsal is pinned, local-only, one-shot, and self-cleaning", async () => {
  const source = await readFile(rehearsalPath, "utf8");

  const gateOffset = source.indexOf('"--confirm-local-reset"');
  const resetOffset = source.indexOf('bash "$script_directory/reset-local-database.sh"');
  assert.ok(gateOffset >= 0 && resetOffset > gateOffset);
  assert.match(source, /--database-only-runtime-check/);
  assert.match(source, /project_id="77-dominion-challenge"/);
  assert.match(source, /http:\/\/127\.0\.0\.1:54321/);
  assert.match(
    source,
    /container_api_origin="http:\/\/\$\{kong_container\}:8000"/,
  );
  assert.match(source, /edge-runtime:v1\.74\.2/);
  assert.match(source, /--pull=never/);
  assert.match(source, /--network "\$network_name"/);
  assert.match(source, /--network-alias "\$runtime_alias"/);
  assert.match(source, /--read-only/);
  assert.match(source, /create extension if not exists pg_cron/i);
  assert.match(source, /cron\.schedule\(/);
  assert.match(source, /net\.http_post\(/);
  assert.match(source, /cron\.job_run_details/);
  assert.match(source, /rehearsal\.worker_secret/);
  assert.match(source, /and rehearsal\.invoked_at is null/);
  assert.match(source, /return_message = 'UPDATE 1'/);
  assert.match(source, /wrong_identity/);
  assert.match(source, /account_erasure/);
  assert.match(source, /aggregate health entered an alerting state/);
  assert.match(source, /docker_cli" rm --force "\$runtime_container"/);
  assert.doesNotMatch(source, /supabase\s+functions\s+serve/);
  assert.doesNotMatch(source, /supabase\s+(?:link|db push)/);
  assert.doesNotMatch(source, /docker_cli" volume (?:rm|prune)/);
  assert.doesNotMatch(source, /rm\s+-rf\s+[^\n]*docker\/volumes/);
});

test("the local client bridge cannot address a hosted origin", async () => {
  const source = await readFile(bridgePath, "utf8");

  assert.match(
    source,
    /http:\/\/supabase_kong_77-dominion-challenge:8000/,
  );
  assert.match(source, /parsed\.origin !== allowedOrigin/);
  assert.match(source, /redirect: "error"/);
  assert.match(source, /bucket !== "profile-photos"/);
  assert.doesNotMatch(source, /https:\/\//);
  assert.doesNotMatch(source, /from\s+["'](?:jsr:|npm:|https?:)/);
});

test("package and runbook expose the acknowledged proof", async () => {
  const packageJson = JSON.parse(
    await readFile(path.join(repositoryRoot, "package.json"), "utf8"),
  );
  const runbook = await readFile(
    path.join(repositoryRoot, "docs", "profile-photo-cleanup-runbook.md"),
    "utf8",
  );

  assert.equal(
    packageJson.scripts["rehearse:profile-photo-cleanup-cron"],
    "bash scripts/rehearse-profile-photo-cleanup-cron.sh",
  );
  assert.equal(
    packageJson.scripts["test:profile-photo-cleanup-cron"],
    "node --test scripts/profile-photo-cleanup-cron-rehearsal.test.mjs",
  );
  assert.match(packageJson.scripts["check:backend"], /test:profile-photo-cleanup-cron/);
  assert.match(
    runbook,
    /rehearse:profile-photo-cleanup-cron -- --confirm-local-reset/,
  );
  assert.match(runbook, /never deletes a Docker volume/i);
  assert.match(runbook, /cannot address a hosted origin/i);
});
