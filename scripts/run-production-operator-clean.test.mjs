import assert from "node:assert/strict";
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const dispatcherSource = join(
  scriptsDirectory,
  "run-production-operator-clean.sh",
);
const exactOrigin = "https://github.com/tjames222/77-dominion-challenge.git";
const packSha256 = "a".repeat(64);
const tcbSha256 = "b".repeat(64);

const operationMappings = new Map([
  ["capture", "capture-production-backup.sh"],
  ["restore", "rehearse-production-backup-restore.sh"],
  ["verify-evidence", "verify-production-backup-evidence.sh"],
  ["preflight", "verify-production-reconciliation-preflight.sh"],
  ["reconcile", "run-production-reconciliation-step.sh"],
]);

const childSource = `#!/bin/bash
set -euo pipefail
set +x

for environment_name in $(compgen -e); do
  case "$environment_name" in
    DOMINION_CLEAN_ENV_LAUNCHER|DOMINION_CLEAN_ENV_LAUNCHER_PATH|DOMINION_CLEAN_ENV_LAUNCHER_SHA256|DOMINION_ENTRYPOINT_SHA256|DOMINION_MACOS_TCB_ATTESTATION_SHA256|DOMINION_OPERATOR_PACK_LAUNCHER_SHA256|DOMINION_RELEASE_COMMIT|DOMINION_RELEASE_REPOSITORY|DOMINION_REPOSITORY_OPERATION|DOMINION_REPOSITORY_OPERATOR_CHILD|HOME|LANG|LC_ALL|NODE_ARCHIVE|NODE_ARCHIVE_SHA256|NODE_BIN|NODE_BIN_SHA256|PATH|PWD|SHLVL|TMPDIR|TZ|_)
      ;;
    *)
      /usr/bin/printf 'unexpected child environment: %s\n' "$environment_name" >&2
      exit 91
      ;;
  esac
done

/usr/bin/printf '%s\n' "\${BASH_SOURCE[0]##*/}" > "$HOME/child-name"
: > "$HOME/child-argv"
for argument in "$@"; do
  /usr/bin/printf '%s\\0' "$argument" >> "$HOME/child-argv"
done
/usr/bin/env | /usr/bin/sort > "$HOME/child-env"
`;

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function runGit(repository, root, arguments_) {
  const result = spawnSync("/usr/bin/git", ["-C", repository, ...arguments_], {
    encoding: "utf8",
    env: {
      HOME: root,
      LANG: "C",
      LC_ALL: "C",
      PATH: "/usr/bin:/bin",
      TZ: "UTC",
    },
  });
  assert.equal(
    result.status,
    0,
    `git ${arguments_.join(" ")} failed:\n${result.stderr}`,
  );
  return result.stdout.trim();
}

function makeFixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dominion-dispatcher-")));
  t.after(() => rmSync(root, { force: true, recursive: true }));

  const repository = join(root, "repository");
  const fixtureScripts = join(repository, "scripts");
  mkdirSync(fixtureScripts, { mode: 0o700, recursive: true });
  chmodSync(repository, 0o700);
  chmodSync(fixtureScripts, 0o700);

  const dispatcher = join(fixtureScripts, "run-production-operator-clean.sh");
  copyFileSync(dispatcherSource, dispatcher);
  chmodSync(dispatcher, 0o700);

  const common = join(fixtureScripts, "production-backup-common.sh");
  writeFileSync(common, "# fixture production helper\n", { mode: 0o600 });
  chmodSync(common, 0o600);

  for (const child of operationMappings.values()) {
    const childPath = join(fixtureScripts, child);
    writeFileSync(childPath, childSource, { mode: 0o700 });
    chmodSync(childPath, 0o700);
  }

  runGit(repository, root, ["init", "-q", "-b", "main"]);
  runGit(repository, root, ["config", "user.email", "dispatcher@test.invalid"]);
  runGit(repository, root, ["config", "user.name", "Dispatcher Test"]);
  runGit(repository, root, ["remote", "add", "origin", exactOrigin]);
  runGit(repository, root, ["add", "--", "scripts"]);
  runGit(repository, root, [
    "commit",
    "-q",
    "--no-gpg-sign",
    "-m",
    "fixture",
  ]);

  const nodeBin = join(root, "pinned-node");
  writeFileSync(nodeBin, "#!/bin/bash\nexit 0\n", { mode: 0o500 });
  chmodSync(nodeBin, 0o500);

  const nodeArchive = join(root, "pinned-node.tar.gz");
  writeFileSync(nodeArchive, "fixture pinned archive\n", { mode: 0o600 });
  chmodSync(nodeArchive, 0o600);

  const commit = runGit(repository, root, ["rev-parse", "HEAD"]);
  const dispatcherSha256 = sha256(dispatcher);
  assert.notEqual(
    dispatcherSha256,
    packSha256,
    "fixture must keep frozen-pack and repository-dispatcher roles distinct",
  );

  function makeRuntime(label) {
    const runtime = join(root, `runtime-${label}`);
    mkdirSync(runtime, { mode: 0o700 });
    chmodSync(runtime, 0o700);
    return realpathSync(runtime);
  }

  function environment(runtime, overrides = {}) {
    return {
      DOMINION_CLEAN_ENV_LAUNCHER: "dominion-production-operator/v1",
      DOMINION_CLEAN_ENV_LAUNCHER_SHA256: packSha256,
      DOMINION_ENTRYPOINT_SHA256: dispatcherSha256,
      DOMINION_MACOS_TCB_ATTESTATION_SHA256: tcbSha256,
      DOMINION_OPERATOR_PACK_LAUNCHER_SHA256: packSha256,
      DOMINION_RELEASE_COMMIT: commit,
      DOMINION_RELEASE_REPOSITORY: repository,
      DOMINION_REPOSITORY_OPERATOR_CHILD:
        "dominion-repository-operator-clean/v1",
      HOME: runtime,
      LANG: "C",
      LC_ALL: "C",
      NODE_ARCHIVE: nodeArchive,
      NODE_ARCHIVE_SHA256: sha256(nodeArchive),
      NODE_BIN: nodeBin,
      NODE_BIN_SHA256: sha256(nodeBin),
      PATH: "/usr/bin:/bin",
      TMPDIR: runtime,
      TZ: "UTC",
      ...overrides,
    };
  }

  function invoke(runtime, arguments_, overrides = {}) {
    return spawnSync(dispatcher, arguments_, {
      cwd: root,
      encoding: "utf8",
      env: environment(runtime, overrides),
    });
  }

  return {
    commit,
    common,
    dispatcher,
    dispatcherSha256,
    environment,
    invoke,
    makeRuntime,
    nodeArchive,
    nodeBin,
    repository,
    root,
    runGit: (arguments_) => runGit(repository, root, arguments_),
  };
}

function readEnvironment(file) {
  const environment = {};
  for (const line of readFileSync(file, "utf8").trimEnd().split("\n")) {
    const separator = line.indexOf("=");
    assert.notEqual(separator, -1, `invalid environment record: ${line}`);
    environment[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return environment;
}

function readNulList(file) {
  const contents = readFileSync(file);
  assert.equal(contents.at(-1), 0, "argument record must end in NUL");
  return contents.subarray(0, -1).toString("utf8").split("\0");
}

function assertNoChildExecuted(runtime) {
  for (const marker of ["child-name", "child-argv", "child-env", "legacy-ran"]) {
    assert.equal(
      existsSync(join(runtime, marker)),
      false,
      `rejected invocation unexpectedly created ${marker}`,
    );
  }
}

function assertRejected(
  fixture,
  runtime,
  arguments_,
  overrides = {},
  stderrPattern,
) {
  const result = fixture.invoke(runtime, arguments_, overrides);
  assert.equal(
    result.status,
    64,
    `invocation unexpectedly succeeded:\n${result.stdout}${result.stderr}`,
  );
  assertNoChildExecuted(runtime);
  assert.match(result.stderr, /^Production operator dispatcher:/m);
  if (stderrPattern) {
    assert.match(result.stderr, stderrPattern);
  }
  return result;
}

test("dispatches all five fixed operations with exact argv and clean environment", (t) => {
  const fixture = makeFixture(t);
  const tail = [
    "alpha",
    "",
    "two words",
    "--operation",
    "restore",
    "line\nbreak",
    "--flag=value",
  ];

  for (const [operation, expectedChild] of operationMappings) {
    const runtime = fixture.makeRuntime(operation);
    const result = fixture.invoke(runtime, ["--operation", operation, "--", ...tail]);
    assert.equal(
      result.status,
      0,
      `${operation} failed:\n${result.stdout}${result.stderr}`,
    );
    assert.equal(readFileSync(join(runtime, "child-name"), "utf8"), `${expectedChild}\n`);
    assert.deepEqual(readNulList(join(runtime, "child-argv")), tail);

    const childEnvironment = readEnvironment(join(runtime, "child-env"));
    delete childEnvironment._;
    assert.deepEqual(Object.keys(childEnvironment).sort(), [
      "DOMINION_CLEAN_ENV_LAUNCHER",
      "DOMINION_CLEAN_ENV_LAUNCHER_PATH",
      "DOMINION_CLEAN_ENV_LAUNCHER_SHA256",
      "DOMINION_ENTRYPOINT_SHA256",
      "DOMINION_MACOS_TCB_ATTESTATION_SHA256",
      "DOMINION_OPERATOR_PACK_LAUNCHER_SHA256",
      "DOMINION_RELEASE_COMMIT",
      "DOMINION_RELEASE_REPOSITORY",
      "DOMINION_REPOSITORY_OPERATION",
      "DOMINION_REPOSITORY_OPERATOR_CHILD",
      "HOME",
      "LANG",
      "LC_ALL",
      "NODE_ARCHIVE",
      "NODE_ARCHIVE_SHA256",
      "NODE_BIN",
      "NODE_BIN_SHA256",
      "PATH",
      "PWD",
      "SHLVL",
      "TMPDIR",
      "TZ",
    ]);
    assert.equal(
      childEnvironment.DOMINION_CLEAN_ENV_LAUNCHER,
      "dominion-production-operator/v1",
    );
    assert.equal(
      childEnvironment.DOMINION_REPOSITORY_OPERATOR_CHILD,
      "dominion-repository-operator-clean/v1",
    );
    assert.equal(
      childEnvironment.DOMINION_CLEAN_ENV_LAUNCHER_PATH,
      fixture.dispatcher,
    );
    assert.equal(
      childEnvironment.DOMINION_CLEAN_ENV_LAUNCHER_SHA256,
      fixture.dispatcherSha256,
    );
    assert.equal(
      childEnvironment.DOMINION_ENTRYPOINT_SHA256,
      fixture.dispatcherSha256,
    );
    assert.equal(
      childEnvironment.DOMINION_OPERATOR_PACK_LAUNCHER_SHA256,
      packSha256,
    );
    assert.equal(
      childEnvironment.DOMINION_MACOS_TCB_ATTESTATION_SHA256,
      tcbSha256,
    );
    assert.equal(childEnvironment.DOMINION_RELEASE_REPOSITORY, fixture.repository);
    assert.equal(childEnvironment.DOMINION_RELEASE_COMMIT, fixture.commit);
    assert.equal(childEnvironment.DOMINION_REPOSITORY_OPERATION, operation);
    assert.equal(childEnvironment.NODE_BIN, fixture.nodeBin);
    assert.equal(childEnvironment.NODE_BIN_SHA256, sha256(fixture.nodeBin));
    assert.equal(childEnvironment.NODE_ARCHIVE, fixture.nodeArchive);
    assert.equal(childEnvironment.NODE_ARCHIVE_SHA256, sha256(fixture.nodeArchive));
    assert.equal(childEnvironment.HOME, runtime);
    assert.equal(childEnvironment.TMPDIR, runtime);
    assert.equal(childEnvironment.PATH, "/usr/bin:/bin");
    assert.equal(childEnvironment.LANG, "C");
    assert.equal(childEnvironment.LC_ALL, "C");
    assert.equal(childEnvironment.TZ, "UTC");
    assert.equal(childEnvironment.PWD, fixture.repository);
  }
});

test("rejects the legacy arbitrary-entrypoint API without executing it", (t) => {
  const fixture = makeFixture(t);
  const runtime = fixture.makeRuntime("legacy-api");
  const legacyEntrypoint = join(fixture.root, "capture-production-backup.sh");
  writeFileSync(
    legacyEntrypoint,
    "#!/bin/bash\n/usr/bin/touch \"$HOME/legacy-ran\"\n",
    { mode: 0o700 },
  );
  chmodSync(legacyEntrypoint, 0o700);

  assertRejected(
    fixture,
    runtime,
    [
      "--entrypoint",
      legacyEntrypoint,
      "--entrypoint-sha256",
      sha256(legacyEntrypoint),
      "--node-bin",
      fixture.nodeBin,
      "--node-bin-sha256",
      sha256(fixture.nodeBin),
      "--launcher-sha256",
      fixture.dispatcherSha256,
      "--",
    ],
    {},
    /usage:/,
  );
});

test("rejects wrong repository, branch, origin, commit, dispatcher, and pack identities", async (t) => {
  await t.test("wrong repository", (nested) => {
    const fixture = makeFixture(nested);
    const runtime = fixture.makeRuntime("wrong-repository");
    const otherRepository = join(fixture.root, "other-repository");
    mkdirSync(otherRepository, { mode: 0o700 });
    assertRejected(
      fixture,
      runtime,
      ["--operation", "capture", "--"],
      { DOMINION_RELEASE_REPOSITORY: realpathSync(otherRepository) },
      /exact absolute file/,
    );
  });

  await t.test("wrong branch", (nested) => {
    const fixture = makeFixture(nested);
    const runtime = fixture.makeRuntime("wrong-branch");
    fixture.runGit(["switch", "-q", "-c", "not-main"]);
    assertRejected(
      fixture,
      runtime,
      ["--operation", "capture", "--"],
      {},
      /exact canonical clean main commit/,
    );
  });

  await t.test("wrong origin", (nested) => {
    const fixture = makeFixture(nested);
    const runtime = fixture.makeRuntime("wrong-origin");
    fixture.runGit([
      "remote",
      "set-url",
      "origin",
      "https://github.com/example/not-the-release.git",
    ]);
    assertRejected(
      fixture,
      runtime,
      ["--operation", "capture", "--"],
      {},
      /exact canonical clean main commit/,
    );
  });

  await t.test("wrong commit", (nested) => {
    const fixture = makeFixture(nested);
    const runtime = fixture.makeRuntime("wrong-commit");
    assertRejected(
      fixture,
      runtime,
      ["--operation", "capture", "--"],
      { DOMINION_RELEASE_COMMIT: "f".repeat(40) },
      /exact canonical clean main commit/,
    );
  });

  await t.test("wrong dispatcher hash", (nested) => {
    const fixture = makeFixture(nested);
    const runtime = fixture.makeRuntime("wrong-dispatcher");
    assertRejected(
      fixture,
      runtime,
      ["--operation", "capture", "--"],
      { DOMINION_ENTRYPOINT_SHA256: "f".repeat(64) },
      /dispatcher SHA-256/,
    );
  });

  await t.test("inconsistent frozen-pack hashes", (nested) => {
    const fixture = makeFixture(nested);
    const runtime = fixture.makeRuntime("inconsistent-pack");
    assertRejected(
      fixture,
      runtime,
      ["--operation", "capture", "--"],
      { DOMINION_OPERATOR_PACK_LAUNCHER_SHA256: "c".repeat(64) },
      /incoming frozen-pack environment/,
    );
  });

  await t.test("malformed frozen-pack hashes", (nested) => {
    const fixture = makeFixture(nested);
    const runtime = fixture.makeRuntime("malformed-pack");
    assertRejected(
      fixture,
      runtime,
      ["--operation", "capture", "--"],
      {
        DOMINION_CLEAN_ENV_LAUNCHER_SHA256: "not-a-sha256",
        DOMINION_OPERATOR_PACK_LAUNCHER_SHA256: "not-a-sha256",
      },
      /operator-pack launcher SHA-256 must be exactly 64 lowercase hexadecimal characters/,
    );
  });
});

test("rejects dirty tracked and untracked repository state", async (t) => {
  await t.test("dirty tracked common helper", (nested) => {
    const fixture = makeFixture(nested);
    const runtime = fixture.makeRuntime("dirty-tracked");
    appendFileSync(fixture.common, "# modified after commit\n");
    assertRejected(
      fixture,
      runtime,
      ["--operation", "capture", "--"],
      {},
      /exact canonical clean main commit/,
    );
  });

  await t.test("untracked repository file", (nested) => {
    const fixture = makeFixture(nested);
    const runtime = fixture.makeRuntime("untracked");
    writeFileSync(join(fixture.repository, "untracked.txt"), "untracked\n");
    assertRejected(
      fixture,
      runtime,
      ["--operation", "capture", "--"],
      {},
      /exact canonical clean main commit/,
    );
  });
});

test("rejects hidden modified common helper state", async (t) => {
  for (const [label, indexFlag] of [
    ["skip-worktree", "--skip-worktree"],
    ["assume-unchanged", "--assume-unchanged"],
  ]) {
    await t.test(label, (nested) => {
      const fixture = makeFixture(nested);
      const runtime = fixture.makeRuntime(label);
      fixture.runGit([
        "update-index",
        indexFlag,
        "--",
        "scripts/production-backup-common.sh",
      ]);
      appendFileSync(fixture.common, "# hidden post-commit modification\n");
      assert.equal(
        fixture.runGit(["status", "--porcelain=v1", "--untracked-files=all"]),
        "",
        `${label} fixture must demonstrate a clean porcelain status`,
      );
      assertRejected(
        fixture,
        runtime,
        ["--operation", "capture", "--"],
        {},
        /hidden, skipped, or (?:assume-unchanged|non-normal)/,
      );
    });
  }
});

test("rejects hostile ambient environment without executing a child", async (t) => {
  for (const [name, value] of [
    ["NODE_OPTIONS", "--require=/definitely/not/a/module"],
    ["BASH_ENV", "/dev/null"],
    ["HOSTILE_AMBIENT", "present"],
  ]) {
    await t.test(name, (nested) => {
      const fixture = makeFixture(nested);
      const runtime = fixture.makeRuntime(name.toLowerCase());
      assertRejected(
        fixture,
        runtime,
        ["--operation", "capture", "--"],
        { [name]: value },
        /unexpected ambient environment variable/,
      );
    });
  }
});
