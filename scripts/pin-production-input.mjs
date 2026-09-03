#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

function fail(message) {
  throw new Error(message);
}

function parse(tokens) {
  const options = {};
  for (let index = 0; index < tokens.length; index += 2) {
    const flag = tokens[index];
    const value = tokens[index + 1];
    if (!flag?.startsWith("--") || value === undefined) fail(`invalid argument near ${flag ?? "end"}`);
    const name = flag.slice(2);
    if (Object.hasOwn(options, name)) fail(`duplicate option --${name}`);
    options[name] = value;
  }
  assert.deepEqual(
    Object.keys(options).sort(),
    ["destination", "kind", "sha256", "source"],
    "expected exactly --source, --sha256, --destination, and --kind",
  );
  return options;
}

function sameFileState(before, after) {
  return before.dev === after.dev
    && before.ino === after.ino
    && before.mode === after.mode
    && before.uid === after.uid
    && before.gid === after.gid
    && before.nlink === after.nlink
    && before.size === after.size
    && before.mtimeNs === after.mtimeNs
    && before.ctimeNs === after.ctimeNs;
}

function sameDirectoryIdentity(before, after) {
  return before.dev === after.dev
    && before.ino === after.ino
    && before.mode === after.mode
    && before.uid === after.uid
    && before.gid === after.gid;
}

function hasExpectedParentLinkDelta(before, after) {
  return after.nlink === before.nlink || after.nlink === before.nlink + 1n;
}

function requireNoExtendedAcl(filename, label) {
  if (process.platform !== "darwin") return;
  const result = spawnSync("/bin/ls", ["-lde", "--", filename], {
    encoding: "utf8",
    env: { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
  });
  if (result.status !== 0) fail(`could not inspect ${label} extended ACL`);
  const lines = result.stdout.replace(/\n$/u, "").split("\n");
  const mode = lines[0]?.split(/\s+/u)[0] ?? "";
  if (lines.length !== 1 || mode.includes("+")) {
    fail(`${label} must not have an extended ACL`);
  }
}

async function pathMetadata(filename, label) {
  try {
    return await lstat(filename, { bigint: true });
  } catch {
    fail(`${label} path became unavailable while it was being pinned`);
  }
}

function currentUid(metadata) {
  return typeof process.getuid === "function"
    ? BigInt(process.getuid())
    : metadata.uid;
}

function validateParentMetadata(metadata) {
  if (
    !metadata.isDirectory()
    || metadata.isSymbolicLink()
    || metadata.uid !== currentUid(metadata)
    || (Number(metadata.mode) & 0o777) !== 0o700
  ) {
    fail("destination parent must be a current-user-owned mode 0700 real directory");
  }
}

async function revalidateParentPath(parent, parentHandle, expected, label, {
  requireFullState = true,
} = {}) {
  const handleMetadata = await parentHandle.stat({ bigint: true });
  const pathnameMetadata = await pathMetadata(parent, "destination parent");
  validateParentMetadata(handleMetadata);
  validateParentMetadata(pathnameMetadata);
  const compare = requireFullState ? sameFileState : sameDirectoryIdentity;
  if (
    !compare(expected, handleMetadata)
    || !compare(handleMetadata, pathnameMetadata)
    || await realpath(parent) !== parent
  ) {
    fail(`destination parent changed ${label}`);
  }
  requireNoExtendedAcl(parent, "destination parent");
  return handleMetadata;
}

async function revalidateSourcePath(source, sourceHandle, expected, label) {
  const handleMetadata = await sourceHandle.stat({ bigint: true });
  const pathnameMetadata = await pathMetadata(source, "source");
  if (
    !sameFileState(expected, handleMetadata)
    || !sameFileState(handleMetadata, pathnameMetadata)
    || await realpath(source) !== source
  ) {
    fail(`source changed ${label}`);
  }
  requireNoExtendedAcl(source, "source");
  return handleMetadata;
}

async function readExact(handle, size) {
  const output = Buffer.alloc(size);
  let offset = 0;
  while (offset < output.length) {
    const { bytesRead } = await handle.read(
      output,
      offset,
      output.length - offset,
      offset,
    );
    if (bytesRead === 0) {
      fail("pinned destination ended before its approved byte length");
    }
    offset += bytesRead;
  }
  return output;
}

function validateDestinationMetadata(metadata, expectedMode, expectedSize) {
  if (
    !metadata.isFile()
    || metadata.isSymbolicLink()
    || metadata.uid !== currentUid(metadata)
    || (Number(metadata.mode) & 0o777) !== expectedMode
    || metadata.size !== expectedSize
    || metadata.nlink !== 1n
  ) {
    fail("pinned destination metadata is invalid");
  }
}

async function revalidateDestinationPath(
  destination,
  destinationHandle,
  expected,
  expectedMode,
  expectedSize,
  label,
) {
  const handleMetadata = await destinationHandle.stat({ bigint: true });
  const pathnameMetadata = await pathMetadata(destination, "pinned destination");
  validateDestinationMetadata(handleMetadata, expectedMode, expectedSize);
  validateDestinationMetadata(pathnameMetadata, expectedMode, expectedSize);
  if (
    !sameFileState(expected, handleMetadata)
    || !sameFileState(handleMetadata, pathnameMetadata)
  ) {
    fail(`pinned destination path changed ${label}`);
  }
  requireNoExtendedAcl(destination, "pinned destination");
  return handleMetadata;
}

async function captureParentInventory(parent) {
  const inventory = [];
  for (const name of (await readdir(parent)).sort()) {
    const filename = path.join(parent, name);
    const metadata = await pathMetadata(filename, `destination parent entry ${name}`);
    if (
      metadata.isSymbolicLink()
      || (!metadata.isFile() && !metadata.isDirectory())
      || metadata.uid !== currentUid(metadata)
      || (Number(metadata.mode) & 0o077) !== 0
      || (metadata.isFile() && metadata.nlink !== 1n)
    ) {
      fail(`destination parent entry ${name} is not sealed and current-user-owned`);
    }
    requireNoExtendedAcl(filename, `destination parent entry ${name}`);
    inventory.push({ metadata, name });
  }
  return inventory;
}

function requireExactInventory(before, after, destinationName) {
  const beforeNames = before.map(({ name }) => name);
  const afterNames = after.map(({ name }) => name);
  if (beforeNames.includes(destinationName)) {
    fail("pinned destination already exists in its parent inventory");
  }
  const expectedNames = [...beforeNames, destinationName].sort();
  if (JSON.stringify(afterNames) !== JSON.stringify(expectedNames)) {
    fail("destination parent inventory changed while the input was being pinned");
  }
  const afterByName = new Map(after.map((entry) => [entry.name, entry.metadata]));
  for (const entry of before) {
    if (!sameFileState(entry.metadata, afterByName.get(entry.name))) {
      fail(`destination parent entry ${entry.name} changed while the input was being pinned`);
    }
  }
}

export async function pinProductionInput({ source, destination, kind, sha256 }) {
  if (!["executable", "private", "tls-root-cert"].includes(kind)) {
    fail("kind must be executable, private, or tls-root-cert");
  }
  if (!/^[a-f0-9]{64}$/u.test(sha256)) fail("approved SHA-256 is invalid");
  if (!path.isAbsolute(source) || !path.isAbsolute(destination)) {
    fail("source and destination must be absolute");
  }
  if (/\p{Cc}/u.test(source) || /\p{Cc}/u.test(destination)) {
    fail("source and destination must not contain control characters");
  }
  const parent = path.dirname(destination);
  const destinationName = path.basename(destination);
  if (path.join(parent, destinationName) !== destination) {
    fail("destination path must already be canonical");
  }
  const initialParentPathMetadata = await pathMetadata(parent, "destination parent");
  validateParentMetadata(initialParentPathMetadata);
  if (await realpath(parent) !== parent) {
    fail("destination parent path must already be canonical");
  }
  requireNoExtendedAcl(parent, "destination parent");

  if (await realpath(source) !== source) fail("source path must already be canonical");
  requireNoExtendedAcl(source, "source");

  const parentHandle = await open(
    parent,
    fsConstants.O_RDONLY
      | (fsConstants.O_DIRECTORY ?? 0)
      | (fsConstants.O_NOFOLLOW ?? 0),
  );
  let sourceHandle;
  let destinationHandle;
  try {
    const parentBefore = await parentHandle.stat({ bigint: true });
    validateParentMetadata(parentBefore);
    if (!sameFileState(initialParentPathMetadata, parentBefore)) {
      fail("destination parent changed before it could be opened");
    }
    await revalidateParentPath(
      parent,
      parentHandle,
      parentBefore,
      "before inventory capture",
    );
    const inventoryBefore = await captureParentInventory(parent);
    if (inventoryBefore.some(({ name }) => name === destinationName)) {
      fail("pinned destination already exists in its parent inventory");
    }
    await revalidateParentPath(
      parent,
      parentHandle,
      parentBefore,
      "during inventory capture",
    );

    sourceHandle = await open(
      source,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    );
    const sourceBefore = await sourceHandle.stat({ bigint: true });
    if (!sourceBefore.isFile()) fail("source must be a regular file");
    if (sourceBefore.nlink !== 1n) fail("source must have exactly one hard link");
    const mode = Number(sourceBefore.mode) & 0o777;
    const uid = Number(sourceBefore.uid);
    const localUid = typeof process.getuid === "function" ? process.getuid() : uid;
    if (kind === "private") {
      if (![0o400, 0o600].includes(mode) || uid !== localUid) {
        fail("private source must be current-user owned with mode 0400 or 0600");
      }
    } else if (kind === "tls-root-cert" && ((mode & 0o022) !== 0 || ![0, localUid].includes(uid))) {
      fail("TLS root certificate must be non-writable by group/other and owned by root or current user");
    } else if (
      kind === "executable"
      && ((mode & 0o111) === 0 || (mode & 0o022) !== 0 || ![0, localUid].includes(uid))
    ) {
      fail("executable source must be executable, non-writable by group/other, and owned by root or current user");
    }
    await revalidateSourcePath(source, sourceHandle, sourceBefore, "before it was read");
    const bytes = await sourceHandle.readFile();
    if (bytes.length === 0) fail("source must not be empty");
    await revalidateSourcePath(source, sourceHandle, sourceBefore, "while it was being pinned");
    if (BigInt(bytes.length) !== sourceBefore.size) {
      fail("source changed while it was being pinned");
    }
    const actualSha256 = createHash("sha256").update(bytes).digest("hex");
    if (actualSha256 !== sha256) fail("source SHA-256 does not match the approved value");

    await revalidateParentPath(
      parent,
      parentHandle,
      parentBefore,
      "immediately before destination creation",
    );
    await revalidateSourcePath(
      source,
      sourceHandle,
      sourceBefore,
      "immediately before destination creation",
    );
    destinationHandle = await open(
      destination,
      fsConstants.O_RDWR
        | fsConstants.O_CREAT
        | fsConstants.O_EXCL
        | (fsConstants.O_NOFOLLOW ?? 0),
      kind === "executable" ? 0o700 : 0o600,
    );
    const expectedMode = kind === "executable" ? 0o700 : 0o600;
    const parentAfterDestinationOpen = await revalidateParentPath(
      parent,
      parentHandle,
      parentBefore,
      "at destination creation",
      { requireFullState: false },
    );
    if (!hasExpectedParentLinkDelta(parentBefore, parentAfterDestinationOpen)) {
      fail("destination parent link count changed unexpectedly during destination creation");
    }
    await destinationHandle.writeFile(bytes);
    await destinationHandle.chmod(expectedMode);
    await destinationHandle.sync();

    const pinned = await destinationHandle.stat({ bigint: true });
    validateDestinationMetadata(pinned, expectedMode, sourceBefore.size);
    const pinnedBytes = await readExact(destinationHandle, bytes.length);
    if (!pinnedBytes.equals(bytes)) {
      fail("pinned destination bytes do not match the approved source");
    }
    await revalidateDestinationPath(
      destination,
      destinationHandle,
      pinned,
      expectedMode,
      sourceBefore.size,
      "after it was written",
    );

    const parentAfterCreate = await parentHandle.stat({ bigint: true });
    validateParentMetadata(parentAfterCreate);
    if (
      !sameFileState(parentAfterDestinationOpen, parentAfterCreate)
      || !sameDirectoryIdentity(parentBefore, parentAfterCreate)
    ) {
      fail("destination parent identity changed while the input was being pinned");
    }
    const inventoryAfter = await captureParentInventory(parent);
    requireExactInventory(inventoryBefore, inventoryAfter, destinationName);
    await revalidateParentPath(
      parent,
      parentHandle,
      parentAfterCreate,
      "after destination creation",
    );
    await revalidateDestinationPath(
      destination,
      destinationHandle,
      pinned,
      expectedMode,
      sourceBefore.size,
      "during final validation",
    );
    const finalInventory = await captureParentInventory(parent);
    requireExactInventory(inventoryBefore, finalInventory, destinationName);
    await revalidateParentPath(
      parent,
      parentHandle,
      parentAfterCreate,
      "during final inventory validation",
    );
    await revalidateSourcePath(source, sourceHandle, sourceBefore, "during final validation");
    await revalidateDestinationPath(
      destination,
      destinationHandle,
      pinned,
      expectedMode,
      sourceBefore.size,
      "before returning its identity",
    );
    return actualSha256;
  } finally {
    await destinationHandle?.close();
    await sourceHandle?.close();
    await parentHandle.close();
  }
}

async function main() {
  const digest = await pinProductionInput(parse(process.argv.slice(2)));
  process.stdout.write(`PINNED_INPUT_SHA256=${digest}\n`);
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : "";
if (import.meta.url === invokedPath) await main();
