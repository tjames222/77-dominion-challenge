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
  buildTemporaryDatabaseCredentials,
  buildTemporaryLoginProbeArguments,
  buildTemporaryLoginProbeEnvironment,
  EXISTING_SUPABASE_PROJECT_REF,
  EXPECTED_POSTGRES_VERSION,
  normalizePrimaryPoolerConfig,
  prepareExistingSupabaseCliState,
  requireCleanNodeRuntimeEnvironment,
  verifyProjectResponse,
  waitForTemporaryDatabaseLogin,
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

async function makeCredentialDirectory() {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "existing-cli-credentials-test-"),
  );
  await chmod(directory, 0o700);
  return realpath(directory);
}

function managementFetch({
  login = {
    password: "temporary-password",
    role: "cli_login_role",
    ttl_seconds: 3600,
  },
  loginStatus = 201,
  pooler = [primaryPooler()],
  project = healthyProject(),
} = {}) {
  const requests = [];
  const fetchImplementation = async (url, options) => {
    requests.push({ url, options });
    const loginRequest = url.endsWith("/cli/login-role");
    return {
      body: { cancel: async () => {} },
      status: loginRequest ? loginStatus : 200,
      redirected: false,
      json: async () =>
        loginRequest
          ? login
          : url.endsWith("/config/database/pooler")
            ? pooler
            : project,
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
      ],
    );
    for (const { options, url } of first.requests) {
      assert.equal(options.method, "GET");
      assert.equal(options.redirect, "error");
      assert.equal(options.headers.Authorization, `Bearer ${token}`);
      assert.equal(url.includes("api-keys"), false);
      assert.equal(url.includes("network-bans"), false);
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
    assert.deepEqual(verified, {
      credentialsPrepared: false,
      projectRef: ref,
      verified: true,
    });
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

test("mints isolated temporary credentials without persisting or returning the password", async () => {
  const stage = await makeStage();
  const credentials = await makeCredentialDirectory();
  const supabaseHome = await makeCredentialDirectory();
  const password = "temp:password\\with-specials";
  const readinessCalls = [];
  try {
    await prepareExistingSupabaseCliState({
      accessToken: token,
      fetchImplementation: managementFetch().fetchImplementation,
      projectRef: ref,
      stageDirectory: stage,
    });
    const management = managementFetch({
      login: {
        password,
        role: "cli_login_role",
        ttl_seconds: 3600,
      },
    });
    const result = await prepareExistingSupabaseCliState({
      accessToken: token,
      credentialDirectory: credentials,
      fetchImplementation: management.fetchImplementation,
      projectRef: ref,
      readinessProbe: async (options) => {
        readinessCalls.push(options);
        return true;
      },
      stageDirectory: stage,
      supabaseHome,
      verifyOnly: true,
    });

    assert.deepEqual(result, {
      credentialsPrepared: true,
      projectRef: ref,
      verified: true,
    });
    assert.equal(JSON.stringify(result).includes(password), false);
    assert.equal(readinessCalls.length, 1);
    assert.equal(readinessCalls[0].databaseUrl.includes(password), false);
    assert.equal(
      readinessCalls[0].passfilePath,
      path.join(credentials, "database-passfile"),
    );
    assert.equal(readinessCalls[0].stageDirectory, stage);
    assert.equal(readinessCalls[0].supabaseHome, supabaseHome);
    assert.deepEqual(
      management.requests.map(({ url }) => url),
      [
        `https://api.supabase.com/v1/projects/${ref}`,
        `https://api.supabase.com/v1/projects/${ref}/config/database/pooler`,
        `https://api.supabase.com/v1/projects/${ref}/cli/login-role`,
      ],
    );
    const loginRequest = management.requests[2];
    assert.equal(loginRequest.options.method, "POST");
    assert.equal(loginRequest.options.headers["Content-Type"], "application/json");
    assert.equal(loginRequest.options.body, JSON.stringify({ read_only: false }));
    assert.equal(loginRequest.url.includes("network-bans"), false);

    const databaseUrl = await readFile(
      path.join(credentials, "database-url"),
      "utf8",
    );
    const passfile = await readFile(
      path.join(credentials, "database-passfile"),
      "utf8",
    );
    assert.equal(
      databaseUrl,
      `postgresql://cli_login_role.${ref}@aws-1-us-west-2.pooler.supabase.com:5432/postgres?sslmode=require&connect_timeout=10`,
    );
    assert.equal(databaseUrl.includes(password), false);
    assert.equal(
      passfile,
      `aws-1-us-west-2.pooler.supabase.com:5432:postgres:cli_login_role.${ref}:temp\\:password\\\\with-specials\n`,
    );
    assert.equal(
      await readFile(path.join(credentials, "credential-ready"), "utf8"),
      ref,
    );
    for (const name of [
      "database-url",
      "database-passfile",
      "credential-ready",
    ]) {
      assert.equal((await stat(path.join(credentials, name))).mode & 0o777, 0o600);
    }
  } finally {
    await removeStage(stage);
    await rm(credentials, { recursive: true, force: true });
    await rm(supabaseHome, { recursive: true, force: true });
  }
});

test("the readiness probe receives a strict allowlist with no API or ambient database credentials", () => {
  const environment = buildTemporaryLoginProbeEnvironment({
    passfilePath: "/private/credentials/database-passfile",
    runtimePath: "/usr/local/bin:/usr/bin:/bin",
    supabaseHome: "/private/supabase-home",
  });
  assert.deepEqual(Object.keys(environment).sort(), [
    "HOME",
    "LANG",
    "PATH",
    "PGPASSFILE",
    "SUPABASE_HOME",
    "SUPABASE_NO_KEYRING",
    "SUPABASE_PROFILE",
    "SUPABASE_TELEMETRY_DISABLED",
    "TMPDIR",
  ]);
  for (const forbidden of [
    "DATABASE_URL",
    "PGPASSWORD",
    "SUPABASE_ACCESS_TOKEN",
    "SUPABASE_DB_PASSWORD",
    "SUPABASE_DB_URL",
    "SUPABASE_PROJECT_REF",
  ]) {
    assert.equal(Object.hasOwn(environment, forbidden), false);
  }
});

test("the readiness probe retries only an explicit read-only SQL query with no linked target", async () => {
  const databaseUrl =
    `postgresql://cli_login_role.${ref}@aws-1-us-west-2.pooler.supabase.com:5432/postgres?sslmode=require&connect_timeout=10`;
  const stageDirectory = "/private/execution-stage";
  const argumentsList = buildTemporaryLoginProbeArguments({
    databaseUrl,
    stageDirectory,
  });
  assert.deepEqual(argumentsList, [
    "--profile=supabase",
    `--workdir=${stageDirectory}`,
    "--output-format=text",
    "--agent=no",
    "db",
    "query",
    `--db-url=${databaseUrl}`,
    "select 1",
  ]);
  assert.equal(argumentsList.includes("--linked"), false);

  const attempts = [];
  const delays = [];
  await waitForTemporaryDatabaseLogin({
    databaseUrl,
    delayImplementation: async (milliseconds) => delays.push(milliseconds),
    passfilePath: "/private/credentials/database-passfile",
    probeAttempt: async (options) => {
      attempts.push(options);
      return attempts.length === 3;
    },
    stageDirectory,
    supabaseHome: "/private/supabase-home",
  });
  assert.equal(attempts.length, 3);
  assert.deepEqual(delays, [1_000, 2_000]);
  for (const options of attempts) {
    assert.equal(options.databaseUrl, databaseUrl);
    assert.equal(options.stageDirectory, stageDirectory);
  }
});

test("rejects malformed or short-lived temporary login credentials", () => {
  const poolerUrl =
    `postgresql://postgres.${ref}@aws-1-us-west-2.pooler.supabase.com:5432/postgres?sslmode=require`;
  for (const login of [
    { password: "temporary-password", role: "other_login_role", ttl_seconds: 3600 },
    { password: "temporary-password", role: "role.with.dot", ttl_seconds: 3600 },
    { password: "short", role: "cli_login_role", ttl_seconds: 3600 },
    { password: "temporary-password\n", role: "cli_login_role", ttl_seconds: 3600 },
    { password: "temporary-password ", role: "cli_login_role", ttl_seconds: 3600 },
    { password: "temporary-password", role: "cli_login_role", ttl_seconds: 299 },
    { password: "temporary-password", role: "cli_login_role", ttl_seconds: 7201 },
  ]) {
    assert.throws(
      () => buildTemporaryDatabaseCredentials({ login, poolerUrl, projectRef: ref }),
      /temporary login-role response/u,
    );
  }
});

test("temporary login API failures never inspect or expose the response body", async () => {
  const stage = await makeStage();
  const credentials = await makeCredentialDirectory();
  const supabaseHome = await makeCredentialDirectory();
  let bodyRead = false;
  try {
    await prepareExistingSupabaseCliState({
      accessToken: token,
      fetchImplementation: managementFetch().fetchImplementation,
      projectRef: ref,
      stageDirectory: stage,
    });
    const management = managementFetch({ loginStatus: 403 });
    management.fetchImplementation = async (url, options) => {
      if (!url.endsWith("/cli/login-role")) {
        return managementFetch().fetchImplementation(url, options);
      }
      return {
        body: { cancel: async () => {} },
        status: 403,
        redirected: false,
        json: async () => {
          bodyRead = true;
          return { secret: "must-not-leak" };
        },
      };
    };
    await assert.rejects(
      () => prepareExistingSupabaseCliState({
        accessToken: token,
        credentialDirectory: credentials,
        fetchImplementation: management.fetchImplementation,
        projectRef: ref,
        stageDirectory: stage,
        supabaseHome,
        verifyOnly: true,
      }),
      /temporary database login request returned HTTP 403/u,
    );
    assert.equal(bodyRead, false);
  } finally {
    await removeStage(stage);
    await rm(credentials, { recursive: true, force: true });
    await rm(supabaseHome, { recursive: true, force: true });
  }
});

test("a failed readiness probe leaves no consumable credential marker", async () => {
  const stage = await makeStage();
  const credentials = await makeCredentialDirectory();
  const supabaseHome = await makeCredentialDirectory();
  const password = "temporary-password";
  try {
    await prepareExistingSupabaseCliState({
      accessToken: token,
      fetchImplementation: managementFetch().fetchImplementation,
      projectRef: ref,
      stageDirectory: stage,
    });
    await assert.rejects(
      () => prepareExistingSupabaseCliState({
        accessToken: token,
        credentialDirectory: credentials,
        fetchImplementation: managementFetch({
          login: {
            password,
            role: "cli_login_role",
            ttl_seconds: 3600,
          },
        }).fetchImplementation,
        projectRef: ref,
        readinessProbe: async () => {
          throw new Error(`never expose ${password}`);
        },
        stageDirectory: stage,
        supabaseHome,
        verifyOnly: true,
      }),
      (error) => {
        assert.match(error.message, /did not become ready/u);
        assert.equal(error.message.includes(password), false);
        return true;
      },
    );
    await assert.rejects(
      () => readFile(path.join(credentials, "credential-ready"), "utf8"),
      /ENOENT/u,
    );
  } finally {
    await removeStage(stage);
    await rm(credentials, { recursive: true, force: true });
    await rm(supabaseHome, { recursive: true, force: true });
  }
});

test("a nonempty credential directory is rejected before a login role is minted", async () => {
  const stage = await makeStage();
  const credentials = await makeCredentialDirectory();
  const supabaseHome = await makeCredentialDirectory();
  try {
    await prepareExistingSupabaseCliState({
      accessToken: token,
      fetchImplementation: managementFetch().fetchImplementation,
      projectRef: ref,
      stageDirectory: stage,
    });
    await writeFile(path.join(credentials, "unexpected"), "occupied", {
      mode: 0o600,
    });
    const management = managementFetch();
    await assert.rejects(
      () => prepareExistingSupabaseCliState({
        accessToken: token,
        credentialDirectory: credentials,
        fetchImplementation: management.fetchImplementation,
        projectRef: ref,
        readinessProbe: async () => {},
        stageDirectory: stage,
        supabaseHome,
        verifyOnly: true,
      }),
      /credential directory must be empty/u,
    );
    assert.deepEqual(
      management.requests.map(({ url }) => url),
      [
        `https://api.supabase.com/v1/projects/${ref}`,
        `https://api.supabase.com/v1/projects/${ref}/config/database/pooler`,
      ],
    );
  } finally {
    await removeStage(stage);
    await rm(credentials, { recursive: true, force: true });
    await rm(supabaseHome, { recursive: true, force: true });
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
