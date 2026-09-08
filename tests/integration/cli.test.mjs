import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cli = path.join(repo, "scripts", "engram.mjs");

function runProcess(file, args, { cwd = repo } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function run(args, { cwd = repo } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

const git = (root, args) => runProcess("git", args, { cwd: root });

async function tempProject(t, prefix = "engram cli ") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

function memoryDraft(text, description = text) {
  return `---\ntype: Memory\ntitle: Python version\ndescription: ${description}\ncapture: explicit\nsources:\n  - resource: urn:okf-engram:conversation:test\n---\n# Memory\n\n${text}\n`;
}

test("help is concise for users while --help retains the detailed reference", async () => {
  const concise = await run(["help"]);
  const noArgs = await run([]);
  const detailed = await run(["--help"]);
  assert.equal(concise.code, 0, concise.stderr);
  assert.equal(noArgs.stdout, concise.stdout);
  assert.ok(Buffer.byteLength(concise.stdout) < 1_024);
  assert.match(concise.stdout, /engram status/);
  assert.match(concise.stdout, /engram --help/);
  assert.doesNotMatch(concise.stdout, /--automatic-memory/);
  assert.ok(detailed.stdout.length > concise.stdout.length * 2);
  assert.match(detailed.stdout, /Common options:/);
});

function artifactDraft(digest) {
  return `---\ntype: Architecture Decision\ntitle: Python runtime\ndescription: The architecture document defines the supported Python runtime.\nsources:\n  - resource: project:docs/architecture.md\n    title: Architecture document\n    digest: ${digest}\n---\n# Runtime\n\nSee [the remembered version](/memories/python-version.md).\n`;
}

test("project vertical slice: init, put, search, replace, drift, lint, deprecate, delete", async (t) => {
  const root = await tempProject(t);
  await fs.mkdir(path.join(root, "docs"));
  await fs.writeFile(path.join(root, "docs", "architecture.md"), "Python 3.13\n");

  let result = await run(["init", "--project-root", root, "--json"]);
  assert.equal(result.code, 0, result.stderr);
  const initialized = JSON.parse(result.stdout);
  assert.equal(initialized.created, true);

  result = await run(["init", "--project-root", root, "--json"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).created, false);

  result = await run(["digest", "project:docs/architecture.md", "--project-root", root, "--json"]);
  assert.equal(result.code, 0, result.stderr);
  const digest = JSON.parse(result.stdout).digest;
  assert.match(digest, /^sha256:[0-9a-f]{64}$/);

  const draft = path.join(root, "memory.md");
  await fs.writeFile(draft, memoryDraft("This project targets Python 3.13."));
  result = await run(["put", "memories/python-version", "--from", draft, "--project-root", root, "--json"]);
  assert.equal(result.code, 0, result.stderr);
  const created = JSON.parse(result.stdout);

  const artifact = path.join(root, "artifact.md");
  await fs.writeFile(artifact, artifactDraft(digest));
  result = await run(["put", "decisions/python-runtime", "--from", artifact, "--project-root", root, "--json"]);
  assert.equal(result.code, 0, result.stderr);
  result = await run(["check-sources", "decisions/python-runtime", "--project-root", root, "--json"]);
  assert.equal(JSON.parse(result.stdout)[0].state, "unchanged");
  await fs.writeFile(path.join(root, "docs", "architecture.md"), "Python 3.14\n");
  result = await run(["check-sources", "decisions/python-runtime", "--project-root", root, "--json"]);
  assert.equal(JSON.parse(result.stdout)[0].state, "changed");
  result = await run(["status", "--project-root", root, "--json"]);
  assert.equal(JSON.parse(result.stdout).sourceStates.changed, 1);

  result = await run(["put", "memories/python-version", "--from", draft, "--project-root", root, "--json"]);
  assert.equal(result.code, 5);
  assert.match(result.stderr, /already exists/);

  result = await run(["search", "Python version", "--project-root", root, "--json"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).results[0].id, "memories/python-version");

  await fs.writeFile(draft, memoryDraft("This project targets Python 3.14.", "This project targets Python 3.14."));
  result = await run([
    "put", "memories/python-version", "--from", draft,
    "--if-match", created.hash, "--project-root", root, "--json",
  ]);
  assert.equal(result.code, 0, result.stderr);
  const replaced = JSON.parse(result.stdout);

  result = await run([
    "put", "memories/python-version", "--from", draft,
    "--if-match", created.hash, "--project-root", root, "--json",
  ]);
  assert.equal(result.code, 5);
  assert.match(result.stderr, /changed since/);

  const rootIndex = path.join(root, ".agents", "data", "okf-engram", "bundle", "index.md");
  const managedIndex = await fs.readFile(rootIndex, "utf8");
  await fs.writeFile(rootIndex, managedIndex.replace(
    /<!-- engram:index:start -->[\s\S]*<!-- engram:index:end -->/,
    "<!-- engram:index:start -->\nSTALE\n<!-- engram:index:end -->",
  ));
  result = await run(["lint", "--project-root", root, "--json"]);
  assert.equal(result.code, 0, result.stderr);
  assert.ok(JSON.parse(result.stdout).issues.some((issue) => issue.code === "index-drift"));
  result = await run(["lint", "--fix", "--project-root", root, "--json"]);
  assert.equal(result.code, 0, result.stderr);
  assert.ok(!JSON.parse(result.stdout).issues.some((issue) => issue.code === "index-drift"));
  const fixedIndex = await fs.readFile(rootIndex, "utf8");
  assert.match(fixedIndex, /okf_version: "0.2"/);
  assert.doesNotMatch(fixedIndex, /\nSTALE\n/);

  result = await run([
    "deprecate", "memories/python-version", "--reason", "Python 3.15 supersedes it",
    "--if-match", replaced.hash, "--project-root", root, "--json",
  ]);
  assert.equal(result.code, 0, result.stderr);
  const deprecated = JSON.parse(result.stdout);

  result = await run(["search", "Python", "--project-root", root, "--json"]);
  const activeResults = JSON.parse(result.stdout).results;
  assert.ok(activeResults.some((item) => item.id === "decisions/python-runtime"));
  assert.ok(!activeResults.some((item) => item.id === "memories/python-version"));

  result = await run([
    "delete", "memories/python-version", "--if-match", deprecated.hash,
    "--project-root", root, "--json",
  ]);
  assert.equal(result.code, 8);

  result = await run([
    "delete", "memories/python-version", "--if-match", deprecated.hash, "--yes",
    "--project-root", root, "--json",
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).deleted, true);
});

test("M4 put rejects newly authored source-less Memory provenance", async (t) => {
  const root = await tempProject(t, "engram memory provenance ");
  let result = await run(["init", "--project-root", root, "--json"]);
  assert.equal(result.code, 0, result.stderr);
  const draft = path.join(root, "source-less.md");
  await fs.writeFile(draft, `---
type: Memory
title: Source-less memory
description: A body label cannot replace source frontmatter.
capture: explicit
---
# Source-less memory

Source: urn:okf-engram:conversation:body-only
`);
  result = await run([
    "put", "memories/source-less", "--from", draft, "--project-root", root, "--json",
  ]);
  assert.equal(result.code, 4);
  assert.match(result.stderr, /provenance source/i);
  result = await run(["get", "memories/source-less", "--project-root", root, "--json"]);
  assert.equal(result.code, 7);
});

test("supports a symlinked .agents data root but rejects bundle-internal symlinks", async (t) => {
  const root = await tempProject(t, "engram symlink ");
  await fs.mkdir(path.join(root, ".pi"));
  await fs.symlink(".pi", path.join(root, ".agents"), "dir");
  let result = await run(["init", "--project-root", root, "--json"]);
  assert.equal(result.code, 0, result.stderr);
  const initialized = JSON.parse(result.stdout);
  assert.match(initialized.bundle, /\.pi\/data\/okf-engram\/bundle$/);

  assert.equal((await git(root, ["init", "-q"])).code, 0);
  assert.equal((await git(root, ["add", ".agents", ".pi/data/okf-engram/bundle"])).code, 0);
  result = await run(["status", "--project-root", root, "--json"]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).git, { repository: true, tracked: true, ignored: false });

  const outside = path.join(root, "outside");
  await fs.mkdir(outside);
  const memories = path.join(initialized.bundle, "memories");
  await fs.rm(memories, { recursive: true });
  await fs.symlink(outside, memories, "dir");
  const draft = path.join(root, "memory.md");
  await fs.writeFile(draft, memoryDraft("Unsafe target"));
  result = await run(["put", "memories/unsafe", "--from", draft, "--project-root", root, "--json"]);
  assert.equal(result.code, 9);
  assert.match(result.stderr, /Symlink inside/);
  result = await run(["reindex", "--project-root", root, "--json"]);
  assert.equal(result.code, 9);
  assert.match(result.stderr, /Symlink inside/);
});
