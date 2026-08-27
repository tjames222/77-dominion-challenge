import assert from "node:assert/strict";
import test from "node:test";
import {
  authoritativeMigrationHistoryQuery,
  fetchRawMigrationHistory,
  parseRawMigrationHistoryResponse,
  verifyRawMigrationHistory,
} from "./verify-production-raw-migration-history.mjs";

const versions = ["20260707170000", "20260708154000"];
const responseRows = versions.map((version) => ({ version }));

test("parses an exact ordered raw migration inventory", () => {
  assert.deepEqual(parseRawMigrationHistoryResponse(responseRows), versions);
  assert.deepEqual(
    verifyRawMigrationHistory({ rawResponse: responseRows, cliRemote: versions }),
    versions,
  );
});

test("rejects nonnumeric records that the CLI table can omit", () => {
  assert.throws(
    () => verifyRawMigrationHistory({
      rawResponse: [...responseRows, { version: "legacy" }],
      cliRemote: versions,
    }),
    /noncanonical migration version/u,
  );
});

test("rejects response envelopes, extra fields, duplicates, and unordered rows", () => {
  for (const rawResponse of [
    { data: responseRows },
    [{ version: versions[0], name: "baseline" }],
    [{ version: versions[0] }, { version: versions[0] }],
    [...responseRows].reverse(),
  ]) {
    assert.throws(
      () => parseRawMigrationHistoryResponse(rawResponse),
      /array|exactly one|string version|duplicate|canonical version order/u,
    );
  }
});

test("requires the raw table and strict CLI remote inventory to match exactly", () => {
  assert.throws(
    () => verifyRawMigrationHistory({
      rawResponse: responseRows,
      cliRemote: versions.slice(0, 1),
    }),
    /does not exactly match/u,
  );
});

test("queries the schema-qualified history table through the read-only Management API", async () => {
  const calls = [];
  const rawResponse = await fetchRawMigrationHistory({
    projectRef: "abcdefghijklmnopqrst",
    accessToken: "test-token-never-printed",
    fetchImplementation: async (...arguments_) => {
      calls.push(arguments_);
      return { status: 201, json: async () => responseRows };
    },
  });

  assert.deepEqual(rawResponse, responseRows);
  assert.equal(calls.length, 1);
  const [url, options] = calls[0];
  assert.equal(
    url,
    "https://api.supabase.com/v1/projects/abcdefghijklmnopqrst/database/query/read-only",
  );
  assert.equal(options.method, "POST");
  assert.equal(options.redirect, "error");
  assert.equal(options.headers.Authorization, "Bearer test-token-never-printed");
  assert.deepEqual(JSON.parse(options.body), {
    query: authoritativeMigrationHistoryQuery,
    parameters: [],
  });
  assert.match(
    authoritativeMigrationHistoryQuery,
    /from supabase_migrations\.schema_migrations/u,
  );
});

test("API failures expose only status, never response content or credentials", async () => {
  const secret = "test-token-secret-sentinel";
  let cancelled = false;
  await assert.rejects(
    () => fetchRawMigrationHistory({
      projectRef: "abcdefghijklmnopqrst",
      accessToken: secret,
      fetchImplementation: async () => ({
        status: 403,
        body: {
          cancel: async () => {
            cancelled = true;
          },
        },
        json: async () => {
          throw new Error("the failure body must not be read");
        },
      }),
    }),
    (error) => {
      assert.match(error.message, /HTTP 403/u);
      assert.doesNotMatch(error.message, /secret-sentinel/u);
      return true;
    },
  );
  assert.equal(cancelled, true);
});

test("rejects redirects and network failures with stable credential-free errors", async () => {
  let redirectCancelled = false;
  await assert.rejects(
    () => fetchRawMigrationHistory({
      projectRef: "abc123def456ghi789jk",
      accessToken: "redirect-token-secret-sentinel",
      fetchImplementation: async () => ({
        status: 302,
        redirected: false,
        body: {
          cancel: async () => {
            redirectCancelled = true;
          },
        },
      }),
    }),
    /returned a redirect/u,
  );
  assert.equal(redirectCancelled, true);

  await assert.rejects(
    () => fetchRawMigrationHistory({
      projectRef: "abc123def456ghi789jk",
      accessToken: "network-token-secret-sentinel",
      fetchImplementation: async () => {
        throw new Error("network-response-secret-sentinel");
      },
    }),
    (error) => {
      assert.match(error.message, /Management API request failed/u);
      assert.doesNotMatch(error.message, /secret-sentinel/u);
      return true;
    },
  );
});
