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
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function project(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "engram index closure "));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bundle = path.join(root, ".agents", "data", "okf-engram", "bundle");
  assert.equal(
    (await run(["corpus", "initialize", "--corpus-context", "project", "--project-root-path", root])).code,
    0,
  );
  return { root, bundle };
}

const draft = `---
type: Note
title: Deleted title sentinel
description: Deleted description sentinel.
---
# Note

Deleted body sentinel.
`;

test("R3 deleting the last nested concept clears generated summaries in empty ancestors", async (t) => {
  const { root, bundle } = await project(t);
  const file = path.join(root, "draft.md");
  await fs.writeFile(file, draft);
  let result = await run([
    "concepts",
    "write",
    "--concept-id",
    "group/nested/test",
    "--corpus-context",
    "project",
    "--document-file-path",
    file,
    "--project-root-path",
    root,
  ]);
  assert.equal(result.code, 0, result.stderr);
  const created = JSON.parse(result.stdout);

  const nestedIndex = path.join(bundle, "group", "nested", "index.md");
  const customized = (await fs.readFile(nestedIndex, "utf8"))
    .replace("# nested\n", "# Human nested title\n\nHuman text remains.\n")
    .replace("<!-- engram:index:end -->", "<!-- engram:index:end -->\n\nHuman footer remains.");
  await fs.writeFile(nestedIndex, customized);

  result = await run([
    "concepts",
    "delete",
    "--concept-id",
    "group/nested/test",
    "--corpus-context",
    "project",
    "--expected-current-sha256",
    created.hash,
    "--confirm-current-tree-deletion",
    "--project-root-path",
    root,
  ]);
  assert.equal(result.code, 0, result.stderr);

  for (const index of [path.join(bundle, "group", "index.md"), nestedIndex]) {
    const text = await fs.readFile(index, "utf8");
    assert.doesNotMatch(text, /Deleted title sentinel|Deleted description sentinel|test\.md/);
    assert.match(text, /No concepts yet\./);
  }
  const nested = await fs.readFile(nestedIndex, "utf8");
  assert.match(nested, /Human nested title/);
  assert.match(nested, /Human text remains/);
  assert.match(nested, /Human footer remains/);
});

test("R3 generated-only empty group indexes and directories are pruned", async (t) => {
  const { root, bundle } = await project(t);
  const file = path.join(root, "draft.md");
  await fs.writeFile(file, draft);
  let result = await run([
    "concepts",
    "write",
    "--concept-id",
    "dogfood/nested/test",
    "--corpus-context",
    "project",
    "--document-file-path",
    file,
    "--project-root-path",
    root,
  ]);
  assert.equal(result.code, 0, result.stderr);
  const created = JSON.parse(result.stdout);

  result = await run([
    "concepts",
    "delete",
    "--concept-id",
    "dogfood/nested/test",
    "--corpus-context",
    "project",
    "--expected-current-sha256",
    created.hash,
    "--confirm-current-tree-deletion",
    "--project-root-path",
    root,
  ]);
  assert.equal(result.code, 0, result.stderr);
  await assert.rejects(() => fs.access(path.join(bundle, "dogfood")), { code: "ENOENT" });
  assert.equal((await fs.stat(path.join(bundle, "memories"))).isDirectory(), true);
  assert.doesNotMatch(await fs.readFile(path.join(bundle, "index.md"), "utf8"), /dogfood/);
});

test("R3 repair removes an existing generated-only orphan group", async (t) => {
  const { root, bundle } = await project(t);
  const directory = path.join(bundle, "dogfood");
  const index = path.join(directory, "index.md");
  await fs.mkdir(directory);
  await fs.writeFile(index, `# dogfood

<!-- engram:index:start -->

No concepts yet.

<!-- engram:index:end -->

`);

  let result = await run(["corpus", "validate", "--corpus-context", "project", "--project-root-path", root]);
  assert.equal(result.code, 0, result.stderr);
  assert.ok(JSON.parse(result.stdout).issues.some((issue) => issue.code === "index-drift" && issue.path === index));

  result = await run(["corpus", "repair-indexes", "--corpus-context", "project", "--project-root-path", root]);
  assert.equal(result.code, 0, result.stderr);
  assert.ok(JSON.parse(result.stdout).repairedIndexFilePaths.includes(index));
  await assert.rejects(() => fs.access(directory), { code: "ENOENT" });
});

test("R3 corpus validation discovers and index repair fixes stale managed indexes in empty groups", async (t) => {
  const { root, bundle } = await project(t);
  const staleDirectory = path.join(bundle, "old", "nested");
  await fs.mkdir(staleDirectory, { recursive: true });
  const stale = `# old

<!-- engram:index:start -->

## Concepts

- [Deleted title sentinel](test.md) — Deleted description sentinel.

<!-- engram:index:end -->
`;
  const oldIndex = path.join(bundle, "old", "index.md");
  const nestedIndex = path.join(staleDirectory, "index.md");
  await fs.writeFile(oldIndex, stale);
  await fs.writeFile(nestedIndex, `${stale}\nHuman tail.\n`);

  let result = await run(["corpus", "validate", "--corpus-context", "project", "--project-root-path", root]);
  assert.equal(result.code, 0, result.stderr);
  let parsed = JSON.parse(result.stdout);
  assert.equal(parsed.issues.filter((issue) => issue.code === "index-drift").length, 2);

  result = await run(["corpus", "repair-indexes", "--corpus-context", "project", "--project-root-path", root]);
  assert.equal(result.code, 0, result.stderr);
  parsed = JSON.parse(result.stdout);
  assert.ok(parsed.repairedIndexFilePaths.includes(oldIndex));
  assert.ok(parsed.repairedIndexFilePaths.includes(nestedIndex));

  for (const index of [oldIndex, nestedIndex]) {
    const text = await fs.readFile(index, "utf8");
    assert.doesNotMatch(text, /Deleted title sentinel|Deleted description sentinel|test\.md/);
    assert.match(text, /No concepts yet\./);
  }
  assert.match(await fs.readFile(nestedIndex, "utf8"), /Human tail/);

  result = await run(["corpus", "validate", "--corpus-context", "project", "--project-root-path", root]);
  assert.equal(JSON.parse(result.stdout).issues.filter((issue) => issue.code === "index-drift").length, 0);
});

test("R3 obsolete unmanaged indexes are preserved and reported", async (t) => {
  const { root, bundle } = await project(t);
  const directory = path.join(bundle, "human-only");
  await fs.mkdir(directory);
  const index = path.join(directory, "index.md");
  const content = "# Human-only index\n\nKeep this text.\n";
  await fs.writeFile(index, content);

  let result = await run(["corpus", "validate", "--corpus-context", "project", "--project-root-path", root]);
  assert.equal(result.code, 0, result.stderr);
  assert.ok(JSON.parse(result.stdout).issues.some((issue) => issue.code === "index-unmanaged" && issue.path === index));

  result = await run(["corpus", "repair-indexes", "--corpus-context", "project", "--project-root-path", root]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(await fs.readFile(index, "utf8"), content);
  assert.ok(JSON.parse(result.stdout).issues.some((issue) => issue.code === "index-unmanaged"));
});
