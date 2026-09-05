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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "engram read containment "));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bundle = path.join(root, ".agents", "data", "okf-engram", "bundle");
  assert.equal((await run(["init", "--project-root", root])).code, 0);
  return { root, bundle };
}

const concept = `---
type: Note
title: Outside sentinel
description: Must not be returned as an internal concept.
---
# Outside

EXTERNAL SECRET SENTINEL
`;

function assertUnsafe(result) {
  assert.equal(result.code, 9, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(JSON.parse(result.stderr).error, "UNSAFE_PATH");
}

test("R6 get rejects leaf, directory, and dangling symlinks inside the bundle", async (t) => {
  const { root, bundle } = await project(t);
  const outside = path.join(root, "outside.md");
  await fs.writeFile(outside, concept);
  await fs.symlink(outside, path.join(bundle, "leaf.md"));
  assertUnsafe(await run(["get", "leaf", "--project-root", root, "--json"]));

  const outsideDirectory = path.join(root, "outside-directory");
  await fs.mkdir(outsideDirectory);
  await fs.writeFile(path.join(outsideDirectory, "nested.md"), concept);
  await fs.symlink(outsideDirectory, path.join(bundle, "group"), "dir");
  assertUnsafe(await run(["get", "group/nested", "--project-root", root, "--json"]));

  await fs.symlink(path.join(root, "missing.md"), path.join(bundle, "dangling.md"));
  assertUnsafe(await run(["get", "dangling", "--project-root", root, "--json"]));
});

test("R6 deprecate rejects an external symlink before parsing its target", async (t) => {
  const { root, bundle } = await project(t);
  const outside = path.join(root, "malformed.md");
  const malformed = "not frontmatter\nEXTERNAL SECRET SENTINEL\n";
  await fs.writeFile(outside, malformed);
  await fs.symlink(outside, path.join(bundle, "linked.md"));

  const result = await run([
    "deprecate", "linked", "--reason", "Do not read it", "--if-match", "0".repeat(64),
    "--project-root", root, "--json",
  ]);
  assertUnsafe(result);
  assert.equal(await fs.readFile(outside, "utf8"), malformed);
});

test("R6 scanner skips concept symlinks and reports a safety diagnostic", async (t) => {
  const { root, bundle } = await project(t);
  const outside = path.join(root, "outside.md");
  await fs.writeFile(outside, concept);
  await fs.symlink(outside, path.join(bundle, "linked.md"));

  const result = await run(["lint", "--project-root", root, "--json"]);
  assert.equal(result.code, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.ok(parsed.issues.some((issue) => (
    issue.code === "symlink" && issue.category === "safety" && issue.path.endsWith("linked.md")
  )));
  assert.ok(!parsed.issues.some((issue) => issue.message?.includes("EXTERNAL SECRET SENTINEL")));
});
