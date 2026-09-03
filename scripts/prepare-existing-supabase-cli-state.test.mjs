import assert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  EXISTING_SUPABASE_PROJECT_REF,
  EXPECTED_POSTGRES_VERSION,
  normalizePrimaryPoolerConfig,
  prepareExistingSupabaseCliState,
  requireCleanNodeRuntimeEnvironment,
  verifyProjectResponse,
} from "./prepare-existing-supabase-cli-state.mjs";

const ref = EXISTING_SUPABASE_PROJECT_REF;
const token = "test-token-never-printed";

function healthyProject(overrides = {}) {
  return {
    id: ref,
    ref,
    region: "us-west-2",
    status: "ACTIVE_HEALTHY",
    database: {
      host: `db.${ref}.supabase.co`,
      postgres_engine: "17",
      release_channel: "ga",
      version: EXPECTED_POSTGRES_VERSION,
    },
    ...overrides,
  };
}

function primaryPooler(overrides = {}) {
  const connectionString = overrides.connection_string
    ?? `postgresql://postgres.${ref}:[YOUR-PASSWORD]@aws-1-us-west-2.pooler.supabase.com:6543/postgres`;
  return {
    connectionString,
    connection_string: connectionString,
    database_type: "PRIMARY",
    default_pool_size: null,
    identifier: ref,
    is_using_scram_auth: true,
    max_client_conn: null,
    db_user: `postgres.${ref}`,
    db_host: "aws-1-us-west-2.pooler.supabase.com",
    db_port: 6543,
    db_name: "postgres",
    pool_mode: "transaction",
    ...overrides,
  };
}

async function makeStage() {
  const root = await mkdtemp(path.join(os.tmpdir(), "existing-cli-state-test-"));
  const supabase = path.join(root, "supabase");
  const temp = path.join(supabase, ".temp");
  await mkdir(temp, { recursive: true });
  await writeFile(
    path.join(temp, "postgres-version"),
    `${EXPECTED_POSTGRES_VERSION}\n`,
    { mode: 0o400 },
  );
  await chmod(path.join(temp, "postgres-version"), 0o400);
  await chmod(temp, 0o700);
  await chmod(supabase, 0o500);
  await chmod(root, 0o500);
  return realpath(root);
}

async function removeStage(stage) {
  await chmod(path.join(stage, "supabase"), 0o700).catch(() => {});
  await chmod(stage, 0o700).catch(() => {});
  await rm(stage, { recursive: true, force: true });
}

function managementFetch({
  networkBansStatus = 403,
  pooler = [primaryPooler()],
  project = healthyProject(),
} = {}) {
  const requests = [];
  const fetchImplementation = async (url, options) => {
    requests.push({ url, options });
    const networkBansRequest = url.endsWith("/network-bans/retrieve");
    return {
      body: { cancel: async () => {} },
      status: networkBansRequest ? networkBansStatus : 200,
      redirected: false,
      json: async () => url.endsWith("/config/database/pooler") ? pooler : project,
    };
  };
  return { fetchImplementation, requests };
}

test("prepares and re-verifies exact credential-free CLI state without API-key access", async () => {
  const stage = await makeStage();
  try {
    const first = managementFetch();
    await prepareExistingSupabaseCliState({
      accessToken: token,
      fetchImplementation: first.fetchImplementation,
      projectRef: ref,
      stageDirectory: stage,
    });

    assert.deepEqual(
      first.requests.map(({ url }) => url),
      [
        `https://api.supabase.com/v1/projects/${ref}`,
        `https://api.supabase.com/v1/projects/${ref}/config/database/pooler`,
        `https://api.supabase.com/v1/projects/${ref}/network-bans/retrieve`,
      ],
    );
    for (const { options, url } of first.requests) {
      assert.equal(
        options.method,
        url.endsWith("/network-bans/retrieve") ? "POST" : "GET",
      );
      assert.equal(options.redirect, "error");
      assert.equal(options.headers.Authorization, `Bearer ${token}`);
      assert.equal(url.includes("api-keys"), false);
    }

    const temp = path.join(stage, "supabase", ".temp");
    assert.equal(await readFile(path.join(temp, "project-ref"), "utf8"), ref);
    const poolerUrl = await readFile(path.join(temp, "pooler-url"), "utf8");
    assert.equal(
      poolerUrl,
      `postgresql://postgres.${ref}@aws-1-us-west-2.pooler.supabase.com:5432/postgres?sslmode=require`,
    );
    assert.equal(poolerUrl.includes(token), false);
    assert.equal((await stat(path.join(temp, "project-ref"))).mode & 0o777, 0o600);
    assert.equal((await stat(path.join(temp, "pooler-url"))).mode & 0o777, 0o600);

    const second = managementFetch();
    const verified = await prepareExistingSupabaseCliState({
      accessToken: token,
      fetchImplementation: second.fetchImplementation,
      projectRef: ref,
      stageDirectory: stage,
      verifyOnly: true,
    });
    assert.deepEqual(verified, { projectRef: ref, verified: true });
  } finally {
    await removeStage(stage);
  }
});

test("fails closed on any exact hosted-project contract mismatch", () => {
  for (const project of [
    healthyProject({ id: "abcdefghijklmnopqrst" }),
    healthyProject({ ref: "abcdefghijklmnopqrst" }),
    healthyProject({ status: "INACTIVE" }),
    healthyProject({ region: "us-east-1" }),
    healthyProject({
      database: {
        ...healthyProject().database,
        host: "db.abcdefghijklmnopqrst.supabase.co",
      },
    }),
    healthyProject({
      database: {
        ...healthyProject().database,
        postgres_engine: "16",
      },
    }),
    healthyProject({
      database: {
        ...healthyProject().database,
        release_channel: "beta",
      },
    }),
    healthyProject({ database: { version: "17.6.1.140" } }),
  ]) {
    assert.throws(
      () => verifyProjectResponse(project, ref),
      /identity, region, health, or PostgreSQL contract/u,
    );
  }
});

test("rejects Node runtime and TLS overrides without exposing their values", () => {
  for (const name of [
    "NODE_EXTRA_CA_CERTS",
    "NODE_OPTIONS",
    "NODE_TLS_REJECT_UNAUTHORIZED",
  ]) {
    const secretValue = `secret-${name}`;
    assert.throws(
      () => requireCleanNodeRuntimeEnvironment({ [name]: secretValue }),
      (error) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, new RegExp(`${name} must be unset`, "u"));
        assert.equal(error.message.includes(secretValue), false);
        return true;
      },
    );
  }
  assert.doesNotThrow(() => requireCleanNodeRuntimeEnvironment({
    NODE_EXTRA_CA_CERTS: "",
    NODE_OPTIONS: "",
    NODE_TLS_REJECT_UNAUTHORIZED: "",
  }));
});

test("accepts only one exact project-bound Supabase primary pooler", () => {
  assert.equal(
    normalizePrimaryPoolerConfig([primaryPooler()], ref),
    `postgresql://postgres.${ref}@aws-1-us-west-2.pooler.supabase.com:5432/postgres?sslmode=require`,
  );
  for (const response of [
    [],
    [primaryPooler(), primaryPooler()],
    [primaryPooler({ database_type: "READ_REPLICA" })],
    [primaryPooler({ identifier: "abcdefghijklmnopqrst" })],
    [primaryPooler({ db_user: "admin" })],
    [primaryPooler({ is_using_scram_auth: false })],
    [primaryPooler({ connectionString: "not-the-canonical-duplicate" })],
    [primaryPooler({ default_pool_size: "10" })],
    [primaryPooler({ max_client_conn: -1 })],
    [primaryPooler({ db_port: 5432 })],
    [primaryPooler({ db_host: "attacker.example" })],
    [primaryPooler({ connection_string: primaryPooler().connection_string.replace(ref, "abcdefghijklmnopqrst") })],
    [primaryPooler({
      connection_string: primaryPooler().connection_string.replace(
        "aws-1-us-west-2",
        "aws-0-us-east-1",
      ),
      db_host: "aws-0-us-east-1.pooler.supabase.com",
    })],
    [primaryPooler({ connection_string: primaryPooler().connection_string.replace("pooler.supabase.com", "example.com") })],
  ]) {
    assert.throws(
      () => normalizePrimaryPoolerConfig(response, ref),
      /pooler/u,
    );
  }
});

test("discards a real Management API database password without persisting or returning it", async () => {
  const stage = await makeStage();
  const realPassword = "sup3r-s3cret%2Fwith%40encoding";
  try {
    const management = managementFetch({
      pooler: [primaryPooler({
        connection_string:
          `postgresql://postgres.${ref}:${realPassword}@aws-1-us-west-2.pooler.supabase.com:6543/postgres`,
      })],
    });
    const result = await prepareExistingSupabaseCliState({
      accessToken: token,
      fetchImplementation: management.fetchImplementation,
      projectRef: ref,
      stageDirectory: stage,
    });

    const temp = path.join(stage, "supabase", ".temp");
    const persisted = [
      await readFile(path.join(temp, "pooler-url"), "utf8"),
      await readFile(path.join(temp, "project-ref"), "utf8"),
    ].join("\n");
    assert.equal(persisted.includes(realPassword), false);
    assert.equal(JSON.stringify(result).includes(realPassword), false);
    assert.equal(
      persisted,
      `postgresql://postgres.${ref}@aws-1-us-west-2.pooler.supabase.com:5432/postgres?sslmode=require\n${ref}`,
    );
  } finally {
    await removeStage(stage);
  }
});

test("never includes a Management API database password in validation errors", () => {
  const realPassword = "must-never-appear";
  let error;
  try {
    normalizePrimaryPoolerConfig([
      primaryPooler({
        db_host: "attacker.example",
        connection_string:
          `postgresql://postgres.${ref}:${realPassword}@aws-1-us-west-2.pooler.supabase.com:6543/postgres`,
      }),
    ], ref);
  } catch (caught) {
    error = caught;
  }
  assert.ok(error instanceof Error);
  assert.equal(error.message.includes(realPassword), false);
});

test("requires the scoped token to lack Network Bans read access", async () => {
  const stage = await makeStage();
  try {
    await assert.rejects(
      () => prepareExistingSupabaseCliState({
        accessToken: token,
        fetchImplementation: managementFetch({
          networkBansStatus: 201,
        }).fetchImplementation,
        projectRef: ref,
        stageDirectory: stage,
      }),
      /must return HTTP 403 for Network Bans read access/u,
    );
  } finally {
    await removeStage(stage);
  }
});

test("verification rejects local target-state tampering", async () => {
  const stage = await makeStage();
  try {
    const initial = managementFetch();
    await prepareExistingSupabaseCliState({
      accessToken: token,
      fetchImplementation: initial.fetchImplementation,
      projectRef: ref,
      stageDirectory: stage,
    });
    const projectRefPath = path.join(stage, "supabase", ".temp", "project-ref");
    await writeFile(projectRefPath, "abcdefghijklmnopqrst", { mode: 0o600 });
    await assert.rejects(
      () => prepareExistingSupabaseCliState({
        accessToken: token,
        fetchImplementation: managementFetch().fetchImplementation,
        projectRef: ref,
        stageDirectory: stage,
        verifyOnly: true,
      }),
      /saved CLI target state changed/u,
    );
  } finally {
    await removeStage(stage);
  }
});

test("Management API failures expose only status and never inspect response bodies", async () => {
  const stage = await makeStage();
  let bodyRead = false;
  try {
    await assert.rejects(
      () => prepareExistingSupabaseCliState({
        accessToken: token,
        fetchImplementation: async () => ({
          status: 403,
          redirected: false,
          body: { cancel: async () => {} },
          json: async () => {
            bodyRead = true;
            return { secret: "must-not-leak" };
          },
        }),
        projectRef: ref,
        stageDirectory: stage,
      }),
      /HTTP 403/u,
    );
    assert.equal(bodyRead, false);
  } finally {
    await removeStage(stage);
  }
});

test("refuses a second preparation rather than overwriting linked state", async () => {
  const stage = await makeStage();
  try {
    const first = managementFetch();
    await prepareExistingSupabaseCliState({
      accessToken: token,
      fetchImplementation: first.fetchImplementation,
      projectRef: ref,
      stageDirectory: stage,
    });
    await assert.rejects(
      () => prepareExistingSupabaseCliState({
        accessToken: token,
        fetchImplementation: managementFetch().fetchImplementation,
        projectRef: ref,
        stageDirectory: stage,
      }),
      /refused to overwrite pooler-url/u,
    );
  } finally {
    await removeStage(stage);
  }
});
