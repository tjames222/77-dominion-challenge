import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  buildPost13Contract,
  EXISTING_SUPABASE_PROJECT_REF,
  isPost13TargetRecord,
  parsePost13ContractResponse,
  POST13_CONTRACT_RECORD_COUNT,
  TARGET_MANIFEST_RECORD_COUNT,
  verifyPost13Effect,
  verifyReadOnlyContractQuery,
} from "./verify-existing-supabase-post13-effect.mjs";

const manifestPath = new URL(
  "../supabase/tests/reconciliation/migration-13.target.manifest.jsonl",
  import.meta.url,
);
const queryPath = new URL("./existing-supabase-post13-contract.sql", import.meta.url);
const workflowPath = new URL(
  "../.github/workflows/apply-existing-supabase-migrations.yml",
  import.meta.url,
);
const manifestContents = readFileSync(manifestPath, "utf8");
const queryContents = readFileSync(queryPath, "utf8");
const workflowContents = readFileSync(workflowPath, "utf8");

function matchingResponse(overrides = {}) {
  return [{
    expected_count: POST13_CONTRACT_RECORD_COUNT,
    actual_count: POST13_CONTRACT_RECORD_COUNT,
    expected_duplicate_key_count: 0,
    actual_duplicate_key_count: 0,
    missing_count: 0,
    unexpected_count: 0,
    changed_count: 0,
    contract_matches: true,
    ...overrides,
  }];
}

test("the contract is derived from the exact pinned migration-13 target", () => {
  const contract = buildPost13Contract(manifestContents);
  assert.equal(contract.length, POST13_CONTRACT_RECORD_COUNT);
  assert.equal(
    contract.filter((record) => ![
      "challenge-definition",
      "entitlement-summary",
      "row-count",
      "workout-config",
    ].includes(record.kind)).length,
    TARGET_MANIFEST_RECORD_COUNT + 4,
  );
  assert.equal(contract.filter((record) => record.kind === "relation").length, 22);
  assert.equal(contract.filter((record) => record.kind === "column").length, 184);
  assert.equal(contract.filter((record) => record.kind === "constraint").length, 84);
  assert.equal(contract.filter((record) => record.kind === "function").length, 27);
  assert.equal(contract.filter((record) => record.kind === "policy").length, 58);
  assert.equal(contract.filter((record) => record.kind === "direct-acl").length, 307);
  assert.equal(contract.filter((record) => record.kind === "effective-acl").length, 702);
  assert.equal(contract.filter((record) => record.kind === "badge").length, 30);
  assert.equal(contract.filter((record) => record.kind === "storage-bucket").length, 3);
  assert.equal(contract.filter((record) => record.kind === "workout-config").length, 4);
  assert.equal(contract.filter((record) => record.kind === "challenge-definition").length, 5);
  assert.equal(contract.filter((record) => record.kind === "entitlement-summary").length, 1);
  assert.equal(contract.filter((record) => record.kind === "row-count").length, 26);
  assert.deepEqual(
    contract.find((record) => record.key === "row-count/auth.users")?.definition,
    { rowCount: 1 },
  );
  assert.deepEqual(
    contract.find((record) => record.key === "row-count/public.entitlements")
      ?.definition,
    { rowCount: 0 },
  );
  assert.deepEqual(
    contract.find((record) =>
      record.key === "entitlement-summary/membership_active"
    )?.definition,
    {
      rowCount: 0,
      membershipActiveCount: 0,
      currentlyEffectiveCount: 0,
      unexpectedEntitlementKeyCount: 0,
    },
  );
  assert.deepEqual(
    contract.find((record) => record.key === "row-count/storage.objects")?.definition,
    { rowCount: 0 },
  );
  const hostedPlatformRoles = ["anon", "authenticated", "postgres", "service_role"];
  const hostedPlatformKeys = hostedPlatformRoles.map((role) =>
    `direct-acl/schema-acl/public/pg_database_owner/${role}/USAGE`
  );
  assert.deepEqual(
    contract
      .filter((record) => hostedPlatformKeys.includes(record.key))
      .map(({ key, definition }) => ({ key, definition })),
    hostedPlatformRoles.map((role) => ({
      key: `direct-acl/schema-acl/public/pg_database_owner/${role}/USAGE`,
      definition: {
        grantee: role,
        grantor: "pg_database_owner",
        grantable: false,
        privilege: "USAGE",
        objectKind: "schema-acl",
      },
    })),
  );
  assert.deepEqual(
    contract.map((record) => record.key),
    [...contract.map((record) => record.key)].sort((left, right) =>
      Buffer.compare(Buffer.from(left), Buffer.from(right))
    ),
  );
  assert.throws(
    () => buildPost13Contract(`${manifestContents}\n`),
    /SHA-256 does not match/u,
  );
});

test("only application-owned target records are selected", () => {
  assert.equal(isPost13TargetRecord({ kind: "relation", definition: {} }), true);
  assert.equal(isPost13TargetRecord({
    kind: "direct-acl",
    identity: "public.profiles",
    definition: { objectKind: "relation-acl" },
  }), true);
  assert.equal(isPost13TargetRecord({
    kind: "direct-acl",
    identity: "storage.objects",
    definition: { objectKind: "platform-relation-acl" },
  }), false);
  assert.equal(isPost13TargetRecord({
    kind: "effective-acl",
    identity: "storage.objects",
    definition: { objectKind: "relation" },
  }), false);
  assert.equal(isPost13TargetRecord({
    kind: "effective-acl",
    identity: "public.rls_auto_enable()",
    definition: { objectKind: "function" },
  }), false);
});

test("the catalog query is one parameterized read-only SELECT", () => {
  assert.equal(verifyReadOnlyContractQuery(queryContents), queryContents);
  assert.match(queryContents, /pg_catalog\.jsonb_array_elements\(\$1::jsonb\)/u);
  assert.match(
    queryContents,
    /pg_catalog\.set_config\(\s*'search_path',\s*'public, extensions',\s*true\s*\)/u,
  );
  assert.equal(
    queryContents.split("cross join canonical_deparse_context").length - 1,
    7,
  );
  assert.equal(
    (queryContents.match(/pinned_search_path = 'public, extensions'/gu) ?? []).length,
    17,
  );
  assert.match(queryContents, /from public\.badge_definitions/u);
  assert.match(queryContents, /from storage\.buckets/u);
  assert.match(queryContents, /from public\.workout_difficulty_point_values/u);
  assert.match(queryContents, /from public\.challenge_definitions/u);
  assert.match(queryContents, /from auth\.users/u);
  assert.match(queryContents, /from storage\.objects/u);
  assert.match(queryContents, /direct_object_acl_records/u);
  assert.match(queryContents, /effective_column_acl_records/u);
  assert.equal(
    queryContents.split("namespace.nspname::text as identity").length - 1,
    1,
  );
  assert.match(queryContents, /namespace\.nspname = 'storage' and relation\.relname = 'objects'/u);
  assert.throws(
    () => verifyReadOnlyContractQuery(`${queryContents.slice(0, -2)}; delete from public.profiles;`),
    /exactly one SQL statement|mutating SQL operation/u,
  );
  assert.throws(
    () => verifyReadOnlyContractQuery(
      queryContents.replace("'public, extensions'", "'public'"),
    ),
    /canonical deparse search_path/u,
  );
  assert.throws(
    () => verifyReadOnlyContractQuery(
      queryContents.replace(
        "namespace.nspname::text as identity",
        "namespace.nspname as identity",
      ),
    ),
    /unbounded text/u,
  );
});

test("only an exact aggregate success response passes", () => {
  assert.deepEqual(
    parsePost13ContractResponse(matchingResponse()),
    matchingResponse()[0],
  );
  assert.throws(
    () => parsePost13ContractResponse(matchingResponse({
      actual_count: POST13_CONTRACT_RECORD_COUNT - 1,
      missing_count: 1,
      contract_matches: false,
    })),
    new RegExp(`actual=${POST13_CONTRACT_RECORD_COUNT - 1}, missing=1`, "u"),
  );
  assert.throws(
    () => parsePost13ContractResponse([{ ...matchingResponse()[0], leaked_row: "secret" }]),
    /response is malformed/u,
  );
  assert.throws(
    () => parsePost13ContractResponse(matchingResponse({ changed_count: "0" })),
    /changed_count is not a nonnegative integer/u,
  );
});

test("the verifier uses only the exact project and the read-only Management API", async () => {
  const accessToken = "test-token-never-printed";
  let request;
  const result = await verifyPost13Effect({
    projectRef: EXISTING_SUPABASE_PROJECT_REF,
    accessToken,
    fetchImplementation: async (url, options) => {
      request = { url, options };
      return {
        status: 201,
        redirected: false,
        json: async () => matchingResponse(),
      };
    },
  });
  assert.equal(result.contract_matches, true);
  assert.equal(
    request.url,
    `https://api.supabase.com/v1/projects/${EXISTING_SUPABASE_PROJECT_REF}/database/query/read-only`,
  );
  assert.equal(request.options.method, "POST");
  assert.equal(request.options.headers.Authorization, `Bearer ${accessToken}`);
  const body = JSON.parse(request.options.body);
  assert.equal(body.query, queryContents);
  assert.equal(body.parameters.length, 1);
  assert.equal(JSON.parse(body.parameters[0]).length, POST13_CONTRACT_RECORD_COUNT);
  assert.equal(request.options.body.includes(accessToken), false);

  await assert.rejects(
    () => verifyPost13Effect({
      projectRef: "abcdefghijklmnopqrst",
      accessToken,
      fetchImplementation: async () => assert.fail("must not make a request"),
    }),
    new RegExp(EXISTING_SUPABASE_PROJECT_REF, "u"),
  );
});

test("Management API failures never inspect or expose the response body", async () => {
  let bodyRead = false;
  await assert.rejects(
    () => verifyPost13Effect({
      projectRef: EXISTING_SUPABASE_PROJECT_REF,
      accessToken: "test-token-never-printed",
      fetchImplementation: async () => ({
        status: 500,
        redirected: false,
        body: { cancel: async () => {} },
        json: async () => {
          bodyRead = true;
          return [{ production_row: "must-not-leak" }];
        },
      }),
    }),
    /HTTP 500/u,
  );
  assert.equal(bodyRead, false);
});

test("the workflow runs the effect gate only after a verified complete prefix", () => {
  const historyIndex = workflowContents.indexOf("--phase observe");
  const effectIndex = workflowContents.indexOf(
    "node scripts/verify-existing-supabase-post13-effect.mjs",
  );
  const enforcementIndex = workflowContents.indexOf(
    "Enforce successful application and exact verification",
  );
  assert.ok(historyIndex !== -1 && effectIndex > historyIndex);
  assert.ok(enforcementIndex > effectIndex);
  assert.match(
    workflowContents,
    /steps\.migration-apply\.outcome == 'success'[\s\S]*steps\.post-history\.outcome == 'success'[\s\S]*steps\.post-history\.outputs\.observed-count == '13'/u,
  );
  assert.match(workflowContents, /POST_EFFECT_OUTCOME:.*steps\.post-effect\.outcome/u);
  assert.match(workflowContents, /POST_EFFECT_OUTCOME[^\n]*!= "success"/u);
});
