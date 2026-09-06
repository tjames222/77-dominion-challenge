import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import {
  grantCanaryQuery,
  grantPreflightQuery,
  grantVerificationQuery,
  revokeCanaryQuery,
  revokeVerificationQuery,
  verifyGrantPreflightResponse,
  verifyGrantResponse,
  verifyRevokeResponse,
} from "./manage-production-canary-entitlement.mjs";
import { reconciledHistoryVersions } from "./verify-production-migration-cutover-plan.mjs";

// This suite never accepts a database URL or an existing container. PostgreSQL
// has no network and stores its complete test cluster only in temporary memory.
const container = `77dc-canary-sql-${randomUUID()}`;
const image = "public.ecr.aws/supabase/postgres:17.6.1.143";
const releaseSha = "a".repeat(40);
const otherReleaseSha = "b".repeat(40);
const ownerId = "10000000-0000-4000-8000-000000000001";
const secondId = "20000000-0000-4000-8000-000000000002";
let fixture;
let created = false;

function docker(args, input) {
  return spawnSync("docker", args, {
    input,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
}

function psql(sql) {
  const result = docker([
    "exec", "-i", container, "psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1",
    "-h", "/tmp", "-U", "postgres", "-d", "postgres",
  ], sql);
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  return result.stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function boundWrite(query, sha = releaseSha) {
  return query.replace("__PRODUCTION_CANARY_RELEASE_SHA__", sha);
}

function jsonQuery(query, sha = releaseSha) {
  return `select row_to_json(result) from (${query.trim().replace(/;$/u, "").replaceAll("$1", `'${sha}'`)}) result;`;
}

function expectSqlFailure(statement, message) {
  const escapedMessage = message.replaceAll("'", "''");
  return `do $test$
    declare expected_failure boolean := false;
    begin
      begin
        ${statement}
      exception when others then
        if position('${escapedMessage}' in sqlerrm) = 0 then raise; end if;
        expected_failure := true;
      end;
      if not expected_failure then raise exception 'Expected SQL guard to reject'; end if;
    end $test$;`;
}

before(async () => {
  const baseline = await readFile(
    new URL("../supabase/migrations/20260707170000_baseline.sql", import.meta.url),
    "utf8",
  );
  const tables = ["profiles", "billing_customers", "subscriptions", "entitlements"]
    .map((table) => {
      const definition = baseline.match(new RegExp(
        `create table if not exists public\\.${table} \\([\\s\\S]*?\\n\\);`, "u",
      ));
      assert.ok(definition, `Missing real baseline definition for ${table}`);
      return definition[0];
    }).join("\n");
  fixture = `begin;
    create schema auth;
    create table auth.users (id uuid primary key, is_anonymous boolean not null default false);
    create schema supabase_migrations;
    create table supabase_migrations.schema_migrations (version text primary key);
    ${tables}
    insert into supabase_migrations.schema_migrations (version) values
      ${reconciledHistoryVersions.map((version) => `('${version}')`).join(",")};
    insert into auth.users (id) values ('${ownerId}');
    insert into public.profiles (user_id) values ('${ownerId}');`;

  const started = docker([
    "run", "--detach", "--name", container, "--network", "none", "--user", "postgres",
    "--tmpfs", "/tmp:rw", "--entrypoint", "/bin/sh", image, "-c",
    'initdb -D /tmp/canary-pgdata -A trust && exec postgres -D /tmp/canary-pgdata -k /tmp -h ""',
  ]);
  assert.equal(started.status, 0, started.error?.message ?? started.stderr);
  created = true;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const ready = docker(["exec", container, "pg_isready", "-h", "/tmp", "-U", "postgres"]);
    if (ready.status === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail("Isolated PostgreSQL did not become ready within 10 seconds");
});

after(() => {
  if (!created) return;
  const removed = docker(["rm", "--force", container]);
  assert.equal(removed.status, 0, removed.error?.message ?? removed.stderr);
});

test("real PostgreSQL grants, verifies, revokes, and preserves the exact two-hour audit row", () => {
  const rows = psql(`${fixture}
    ${jsonQuery(grantPreflightQuery)}
    ${boundWrite(grantCanaryQuery)}
    ${jsonQuery(grantVerificationQuery)}
    select row_to_json(entitlement) from public.entitlements entitlement;
    ${boundWrite(revokeCanaryQuery)}
    ${jsonQuery(revokeVerificationQuery)}
    select row_to_json(entitlement) from public.entitlements entitlement;
    rollback;`);
  verifyGrantPreflightResponse([rows[0]]);
  verifyGrantResponse([rows[1]]);
  verifyRevokeResponse([rows[3]]);
  const [granted, revoked] = [rows[2], rows[4]];
  assert.equal(granted.user_id, ownerId);
  assert.match(granted.source_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  assert.equal(Date.parse(granted.ends_at) - Date.parse(granted.starts_at), 7_200_000);
  assert.deepEqual(granted.metadata, { release_sha: releaseSha });
  for (const key of ["user_id", "source_id", "starts_at", "created_at", "metadata"]) {
    assert.deepEqual(revoked[key], granted[key], `${key} must survive revocation`);
  }
  assert.equal(revoked.status, "revoked");
  assert.ok(Date.parse(revoked.ends_at) <= Date.parse(granted.ends_at));
  assert.ok(Date.parse(revoked.ends_at) >= Date.parse(granted.starts_at));
});

for (const [name, change, error] of [
  ["missing history", "delete from supabase_migrations.schema_migrations;", "exact reconciled migration-13 history"],
  ["advanced history", "insert into supabase_migrations.schema_migrations values ('20990101000000');", "exact reconciled migration-13 history"],
  ["second Auth user", `insert into auth.users (id) values ('${secondId}');`, "Exactly one non-anonymous Auth user"],
  ["missing profile", "delete from public.profiles;", "Exactly one non-anonymous Auth user"],
  ["billing data", `insert into public.billing_customers (user_id, stripe_customer_id) values ('${ownerId}', 'cus_test');`, "globally empty billing tables"],
  ["legacy purchases", "create table public.purchases (id integer);", "removed public.purchases"],
]) {
  test(`real PostgreSQL refuses a grant with ${name} and inserts nothing`, () => {
    const rows = psql(`${fixture}
      ${change}
      ${expectSqlFailure(boundWrite(grantCanaryQuery), error)}
      select json_build_object('count', count(*)) from public.entitlements;
      rollback;`);
    assert.deepEqual(rows, [{ count: 0 }]);
  });
}

test("real PostgreSQL refuses replacement and a revoke for a different release", () => {
  const rows = psql(`${fixture}
    ${boundWrite(grantCanaryQuery)}
    ${expectSqlFailure(boundWrite(grantCanaryQuery), "zero existing membership entitlements")}
    ${expectSqlFailure(boundWrite(revokeCanaryQuery, otherReleaseSha), "one sole active production canary for this release")}
    ${jsonQuery(grantVerificationQuery)}
    rollback;`);
  verifyGrantResponse(rows);
});

test("real PostgreSQL permits emergency revocation after expiry and post-cutover history", () => {
  const rows = psql(`${fixture}
    ${boundWrite(grantCanaryQuery)}
    update public.entitlements set starts_at = starts_at - interval '3 hours', ends_at = ends_at - interval '3 hours';
    insert into supabase_migrations.schema_migrations values ('20990101000000');
    select row_to_json(entitlement) from public.entitlements entitlement;
    ${boundWrite(revokeCanaryQuery)}
    ${jsonQuery(revokeVerificationQuery)}
    select row_to_json(entitlement) from public.entitlements entitlement;
    rollback;`);
  verifyRevokeResponse([rows[1]]);
  assert.equal(rows[0].ends_at, rows[2].ends_at, "revocation must not extend an expired entitlement");
});
