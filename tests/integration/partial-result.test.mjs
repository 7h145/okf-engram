import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cli = path.join(repo, "scripts", "engram.mjs");

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args]);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function project(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "engram partial result "));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bundle = path.join(root, ".agents", "data", "okf-engram", "bundle");
  assert.equal((await run(["init", "--project-root", root])).code, 0);
  return { root, bundle };
}

const draft = (title = "Partial result") => `---
type: Note
title: ${title}
description: Partial-result fixture.
---
# Note

Complete concept body.
`;

async function blockIndex(bundle, root) {
  const target = path.join(root, "outside-index.md");
  await fs.writeFile(target, "outside must remain unchanged\n");
  const index = path.join(bundle, "memories", "index.md");
  await fs.unlink(index);
  await fs.symlink(target, index);
  return { index, target };
}

function partialError(result, operation) {
  assert.equal(result.code, 10, result.stderr);
  assert.equal(result.stdout, "");
  const error = JSON.parse(result.stderr);
  assert.equal(error.error, "PERSISTED_INDEX_STALE");
  assert.match(error.message, /DID persist/);
  assert.equal(error.details.operation, operation);
  assert.equal(error.details.persisted, true);
  assert.match(error.details.recovery, /reindex/i);
  return error.details;
}

test("R5 put reports persisted concept when generated-index maintenance fails", async (t) => {
  const { root, bundle } = await project(t);
  const file = path.join(root, "draft.md");
  await fs.writeFile(file, draft());
  const blocked = await blockIndex(bundle, root);

  let result = await run(["put", "partial", "--from", file, "--project-root", root, "--json"]);
  const details = partialError(result, "put");
  assert.equal(details.id, "partial");
  assert.match(details.hash, /^[0-9a-f]{64}$/);
  assert.equal(await fs.readFile(blocked.target, "utf8"), "outside must remain unchanged\n");

  result = await run(["get", "partial", "--project-root", root, "--json"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).hash, details.hash);

  result = await run(["put", "partial", "--from", file, "--project-root", root, "--json"]);
  assert.equal(result.code, 5);
  assert.match(result.stderr, /already exists/);

  await fs.unlink(blocked.index);
  result = await run(["reindex", "--project-root", root, "--json"]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(await fs.readFile(path.join(bundle, "index.md"), "utf8"), /\[Partial result\]\(partial\.md\)/);
});

test("R5 deprecate reports new hash when concept persisted before index failure", async (t) => {
  const { root, bundle } = await project(t);
  const file = path.join(root, "draft.md");
  await fs.writeFile(file, draft("Deprecate partial"));
  let result = await run(["put", "deprecate-partial", "--from", file, "--project-root", root, "--json"]);
  assert.equal(result.code, 0, result.stderr);
  const original = JSON.parse(result.stdout);
  await blockIndex(bundle, root);

  result = await run([
    "deprecate", "deprecate-partial", "--reason", "Superseded",
    "--if-match", original.hash, "--project-root", root, "--json",
  ]);
  const details = partialError(result, "deprecate");
  assert.match(details.hash, /^[0-9a-f]{64}$/);
  assert.notEqual(details.hash, original.hash);

  result = await run(["get", "deprecate-partial", "--project-root", root, "--json"]);
  assert.equal(JSON.parse(result.stdout).data.status, "deprecated");
  assert.equal(JSON.parse(result.stdout).hash, details.hash);
});

test("R5 delete reports completed deletion when index maintenance fails", async (t) => {
  const { root, bundle } = await project(t);
  const file = path.join(root, "draft.md");
  await fs.writeFile(file, draft("Delete partial"));
  let result = await run(["put", "delete-partial", "--from", file, "--project-root", root, "--json"]);
  assert.equal(result.code, 0, result.stderr);
  const original = JSON.parse(result.stdout);
  await blockIndex(bundle, root);

  result = await run([
    "delete", "delete-partial", "--if-match", original.hash, "--yes",
    "--project-root", root, "--json",
  ]);
  const details = partialError(result, "delete");
  assert.equal(details.deleted, true);

  result = await run(["get", "delete-partial", "--project-root", root, "--json"]);
  assert.equal(result.code, 7);
});

test("R5 failures before concept replacement never claim persistence", async (t) => {
  const { root, bundle } = await project(t);
  const outside = path.join(root, "outside.md");
  await fs.writeFile(outside, draft("Outside"));
  await fs.symlink(outside, path.join(bundle, "blocked.md"));
  const file = path.join(root, "draft.md");
  await fs.writeFile(file, draft());

  const result = await run(["put", "blocked", "--from", file, "--project-root", root, "--json"]);
  assert.equal(result.code, 9);
  const error = JSON.parse(result.stderr);
  assert.equal(error.error, "UNSAFE_PATH");
  assert.notEqual(error.error, "PERSISTED_INDEX_STALE");
  assert.equal(await fs.readFile(outside, "utf8"), draft("Outside"));
});
