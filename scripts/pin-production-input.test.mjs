import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { pinProductionInput } from "./pin-production-input.mjs";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "pin-production-input-")));
  const sources = path.join(root, "sources");
  const destinationParent = path.join(root, "runtime");
  await mkdir(sources, { mode: 0o700 });
  await mkdir(destinationParent, { mode: 0o700 });
  await chmod(root, 0o700);
  await chmod(sources, 0o700);
  await chmod(destinationParent, 0o700);
  t.after(() => rm(root, { force: true, recursive: true }));
  return { destinationParent, root, sources };
}

async function sourceFile(directory, name, contents, mode = 0o600) {
  const filename = path.join(directory, name);
  await writeFile(filename, contents, { flag: "wx", mode });
  await chmod(filename, mode);
  return { contents: Buffer.from(contents), filename };
}

async function instrumentedPin(root, {
  afterDestinationSync = "",
  afterSourceRead = "",
} = {}) {
  const productionSource = await readFile(
    new URL("./pin-production-input.mjs", import.meta.url),
    "utf8",
  );
  const sourceReadMarker =
    "    if (actualSha256 !== sha256) fail(\"source SHA-256 does not match the approved value\");";
  const destinationSyncMarker = "    await destinationHandle.sync();";
  assert.equal(productionSource.split(sourceReadMarker).length - 1, 1);
  assert.equal(productionSource.split(destinationSyncMarker).length - 1, 1);

  const indent = (code) => code
    .trim()
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
  let instrumentedSource = productionSource;
  if (afterSourceRead) {
    instrumentedSource = instrumentedSource.replace(
      sourceReadMarker,
      `${sourceReadMarker}\n${indent(afterSourceRead)}`,
    );
  }
  if (afterDestinationSync) {
    instrumentedSource = instrumentedSource.replace(
      destinationSyncMarker,
      `${destinationSyncMarker}\n${indent(afterDestinationSync)}`,
    );
  }

  const filename = path.join(root, "instrumented-pin-production-input.mjs");
  await writeFile(filename, instrumentedSource, { flag: "wx", mode: 0o600 });
  return (await import(pathToFileURL(filename).href)).pinProductionInput;
}

test("pins sequential inputs while authenticating a stable preexisting inventory", async (t) => {
  const { destinationParent, sources } = await fixture(t);
  const privateSource = await sourceFile(sources, "database-url", "postgresql://approved\n");
  const executableSource = await sourceFile(
    sources,
    "tool",
    "#!/bin/sh\nexit 0\n",
    0o700,
  );
  await writeFile(path.join(destinationParent, "preexisting-evidence"), "evidence\n", {
    flag: "wx",
    mode: 0o600,
  });
  await mkdir(path.join(destinationParent, "home"), { mode: 0o700 });

  const privateDestination = path.join(destinationParent, "database-url");
  const privateDigest = sha256(privateSource.contents);
  assert.equal(
    await pinProductionInput({
      destination: privateDestination,
      kind: "private",
      sha256: privateDigest,
      source: privateSource.filename,
    }),
    privateDigest,
  );

  const executableDestination = path.join(destinationParent, "tool");
  const executableDigest = sha256(executableSource.contents);
  assert.equal(
    await pinProductionInput({
      destination: executableDestination,
      kind: "executable",
      sha256: executableDigest,
      source: executableSource.filename,
    }),
    executableDigest,
  );

  assert.deepEqual(
    (await readdir(destinationParent)).sort(),
    ["database-url", "home", "preexisting-evidence", "tool"],
  );
  assert.deepEqual(await readFile(privateDestination), privateSource.contents);
  assert.deepEqual(await readFile(executableDestination), executableSource.contents);
  assert.equal((await stat(privateDestination)).mode & 0o777, 0o600);
  assert.equal((await stat(executableDestination)).mode & 0o777, 0o700);
});

test("rejects a destination pathname swapped after the handle is synced", async (t) => {
  const { destinationParent, root, sources } = await fixture(t);
  const source = await sourceFile(sources, "approved", "approved!\n");
  const destination = path.join(destinationParent, "pinned");
  const pin = await instrumentedPin(root, {
    afterDestinationSync: `
const { rename: fixtureRename, writeFile: fixtureWriteFile } = await import("node:fs/promises");
await fixtureRename(${JSON.stringify(destination)}, ${JSON.stringify(path.join(destinationParent, "original-pinned"))});
await fixtureWriteFile(${JSON.stringify(destination)}, "attacker!\\n", { flag: "wx", mode: 0o600 });
`,
  });

  await assert.rejects(
    pin({
      destination,
      kind: "private",
      sha256: sha256(source.contents),
      source: source.filename,
    }),
    /pinned destination path changed/u,
  );
});

test("rejects a source pathname replaced after its handle is read", async (t) => {
  const { destinationParent, root, sources } = await fixture(t);
  const source = await sourceFile(sources, "approved", "approved!\n");
  const originalSource = path.join(sources, "original-approved");
  const destination = path.join(destinationParent, "pinned");
  const pin = await instrumentedPin(root, {
    afterSourceRead: `
const { rename: fixtureRename, writeFile: fixtureWriteFile } = await import("node:fs/promises");
await fixtureRename(${JSON.stringify(source.filename)}, ${JSON.stringify(originalSource)});
await fixtureWriteFile(${JSON.stringify(source.filename)}, "attacker!\\n", { flag: "wx", mode: 0o600 });
`,
  });

  await assert.rejects(
    pin({
      destination,
      kind: "private",
      sha256: sha256(source.contents),
      source: source.filename,
    }),
    /source changed immediately before destination creation/u,
  );
  await assert.rejects(stat(destination), /ENOENT/u);
});

test("rejects a destination parent pathname swapped after the file is synced", async (t) => {
  const { destinationParent, root, sources } = await fixture(t);
  const source = await sourceFile(sources, "approved", "approved!\n");
  const destination = path.join(destinationParent, "pinned");
  const replacementParent = path.join(root, "replacement-runtime");
  const movedParent = path.join(root, "original-runtime");
  await mkdir(replacementParent, { mode: 0o700 });
  await writeFile(path.join(replacementParent, "pinned"), "attacker!\n", {
    flag: "wx",
    mode: 0o600,
  });
  const pin = await instrumentedPin(root, {
    afterDestinationSync: `
const { rename: fixtureRename } = await import("node:fs/promises");
await fixtureRename(${JSON.stringify(destinationParent)}, ${JSON.stringify(movedParent)});
await fixtureRename(${JSON.stringify(replacementParent)}, ${JSON.stringify(destinationParent)});
`,
  });

  await assert.rejects(
    pin({
      destination,
      kind: "private",
      sha256: sha256(source.contents),
      source: source.filename,
    }),
    /pinned destination path changed/u,
  );
});

test("rejects a hard link added to the pinned destination", async (t) => {
  const { destinationParent, root, sources } = await fixture(t);
  const source = await sourceFile(sources, "approved", "approved\n");
  const destination = path.join(destinationParent, "pinned");
  const pin = await instrumentedPin(root, {
    afterDestinationSync: `
const { link: fixtureLink } = await import("node:fs/promises");
await fixtureLink(${JSON.stringify(destination)}, ${JSON.stringify(path.join(destinationParent, "pinned-hardlink"))});
`,
  });

  await assert.rejects(
    pin({
      destination,
      kind: "private",
      sha256: sha256(source.contents),
      source: source.filename,
    }),
    /pinned destination metadata is invalid/u,
  );
});

test("rejects any concurrent parent inventory addition", async (t) => {
  const { destinationParent, root, sources } = await fixture(t);
  const source = await sourceFile(sources, "approved", "approved\n");
  const destination = path.join(destinationParent, "pinned");
  const pin = await instrumentedPin(root, {
    afterDestinationSync: `
const { writeFile: fixtureWriteFile } = await import("node:fs/promises");
await fixtureWriteFile(${JSON.stringify(path.join(destinationParent, "unexpected"))}, "unexpected\\n", { flag: "wx", mode: 0o600 });
`,
  });

  await assert.rejects(
    pin({
      destination,
      kind: "private",
      sha256: sha256(source.contents),
      source: source.filename,
    }),
    /destination parent (?:identity|inventory) changed/u,
  );
});
