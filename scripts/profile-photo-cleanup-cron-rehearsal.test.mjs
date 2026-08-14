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
const handlerPath = path.join(
  repositoryRoot,
  "supabase",
  "functions",
  "process-profile-photo-cleanup",
  "index.ts",
);
const faultPhases = [
  "tracking_ready",
  "fixtures_ready",
  "first_upload_stored",
  "runtime_created",
  "readiness_queued",
  "cron_scheduled",
  "worker_completed",
  "health_queued",
  "teardown_started",
  "cleanup_queued",
];

async function externalImportsFromGraph(entryPath) {
  const pending = [entryPath];
  const visited = new Set();
  const external = new Set();
  const importPattern = /(?:\b(?:import|export)\s+(?:type\s+)?(?:[^"']*?\s+from\s*)?["']([^"']+)["'])|(?:\bimport\s*\(\s*["']([^"']+)["']\s*\))/g;

  while (pending.length > 0) {
    const currentPath = pending.pop();
    if (visited.has(currentPath)) continue;
    visited.add(currentPath);
    const source = await readFile(currentPath, "utf8");
    assert.doesNotMatch(source, /\brequire\s*\(/);
    assert.doesNotMatch(source, /\bimport\s*\(\s*[^"'\s]/);
    for (const match of source.matchAll(importPattern)) {
      const specifier = match[1] || match[2];
      if (!specifier.startsWith(".")) {
        external.add(specifier);
        continue;
      }
      const resolved = path.resolve(path.dirname(currentPath), specifier);
      pending.push(path.extname(resolved) ? resolved : `${resolved}.ts`);
    }
  }
  return [...external].sort();
}

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
  assert.match(source, /postgrest:v14\.14/);
  assert.match(source, /rest_container="supabase_rest_/);
  assert.match(source, /NetworkSettings\.Ports "8000\/tcp"/);
  assert.match(source, /--pull=never/);
  assert.match(source, /--network "\$network_name"/);
  assert.match(source, /--network-alias "\$runtime_alias"/);
  assert.match(source, /--read-only/);
  assert.match(source, /create extension pg_cron/i);
  assert.match(source, /cron_extension_state="unknown"/);
  assert.match(source, /cron_installed_by_rehearsal=false/);
  assert.match(source, /pg_cron_installed_by_rehearsal boolean not null/);
  assert.match(source, /cron\.schedule\(/);
  assert.match(source, /net\.http_post\(/);
  assert.match(source, /cron\.job_run_details/);
  assert.match(source, /status in \('starting', 'running'\)/);
  assert.match(source, /net\.http_request_queue/);
  assert.match(source, /rehearsal\.worker_secret/);
  assert.match(source, /and rehearsal\.invoked_at is null/);
  assert.match(source, /return_message = 'UPDATE 1'/);
  assert.match(source, /wrong_identity/);
  assert.match(source, /account_erasure/);
  assert.match(source, /aggregate health entered an alerting state/);
  assert.match(source, /body := '\{\\"mode\\":\\"health\\"\}'::jsonb/);
  assert.match(source, /health ->> 'oldestReadyAt' is null/);
  assert.match(source, /response_created_at is null/);
  assert.match(source, /interval '15 minutes'/);
  assert.match(source, /readiness_request_id bigint/);
  assert.match(source, /worker_request_id bigint/);
  assert.match(source, /health_request_id bigint/);
  assert.match(source, /cleanup_request_id bigint/);
  assert.match(source, /object_row\.bucket_id = 'profile-photos'/);
  assert.match(source, /object_row\.name = fixture\.storage_path/);
  assert.match(source, /--json "\{\\"prefixes\\"/);
  assert.match(source, /"\$curl_cli" --disable --config/);
  assert.match(source, /--noproxy '\*'/);
  assert.match(source, /--proxy ''/);
  assert.match(source, /--proto '=http'/);
  assert.match(source, /--proto-redir '=http'/);
  assert.match(source, /--max-redirs 0/);
  assert.match(source, /printf 'http_proxy=\\n'/);
  assert.match(source, /printf 'HTTP_PROXY=\\n'/);
  assert.match(source, /assert_pg_net_alias_bypasses_proxy/);
  assert.match(source, /grep -Fq -- "\$sensitive_value" "\$stdout_capture"/);
  assert.match(source, /grep -Fq -- "\$sensitive_value" "\$stderr_capture"/);
  assert.match(source, /for sensitive_value in "\$worker_secret" "\$service_role_key"/);
  assert.match(source, /mkdir "\$lock_directory"/);
  assert.ok(source.indexOf('mkdir "$lock_directory"') < resetOffset);
  assert.match(source, /docker_cli" rm --force "\$runtime_container"/);
  assert.doesNotMatch(source, /runtime_started=/);
  assert.doesNotMatch(source, /fixtures_created=/);
  assert.doesNotMatch(source, /cron_was_installed=/);
  assert.doesNotMatch(source, /insert into \$secret_table[^;]*\$worker_secret/is);
  assert.doesNotMatch(source, /set -e\n\}/);
  assert.doesNotMatch(source, /supabase\s+functions\s+serve/);
  assert.doesNotMatch(source, /supabase\s+(?:link|db push)/);
  assert.doesNotMatch(source, /docker_cli" volume (?:rm|prune)/);
  assert.doesNotMatch(source, /rm\s+-rf\s+[^\n]*docker\/volumes/);
});

test("every cleanup fault checkpoint executes before destructive test work", async () => {
  const source = await readFile(rehearsalPath, "utf8");
  for (const phase of faultPhases) {
    const result = spawnSync("bash", [rehearsalPath, phase], {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: {
        PATH: "/usr/bin:/bin",
        FOU802_REHEARSAL_FAULT_SELF_TEST: "1",
      },
    });
    assert.equal(result.status, 86, `${phase}: ${result.stderr}`);
    assert.match(result.stderr, new RegExp(`after ${phase}\\.`));
    assert.match(source, new RegExp(`maybe_inject_fault ${phase}(?:\\n|$)`));
  }
});

test("the real handler import graph has one pinned local bridge boundary", async () => {
  assert.deepEqual(
    await externalImportsFromGraph(handlerPath),
    ["jsr:@supabase/supabase-js@2.110.7"],
  );
  const rehearsal = await readFile(rehearsalPath, "utf8");
  assert.match(
    rehearsal,
    /"jsr:@supabase\/supabase-js@2\.110\.7": "\.\.\/_rehearsal\/supabase-js-bridge\.ts"/,
  );
  assert.match(rehearsal, /_shared\/supabase\.ts/);
  assert.match(rehearsal, /_shared\/http\.ts/);
  assert.doesNotMatch(rehearsal, /cp -R .*supabase\/functions\/_shared/);
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
