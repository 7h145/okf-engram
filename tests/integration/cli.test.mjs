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

function run(args, { cwd = repo } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd });
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
  assert.ok(Buffer.byteLength(concise.stdout) < 2_048);
  assert.match(concise.stdout, /\/engram — status of the project knowledge base/);
  assert.match(concise.stdout, /durable project knowledge and user-global memories/);
  assert.match(concise.stdout, /\/engram global ls/);
  assert.match(concise.stdout, /\/engram both recall QUESTION/);
  assert.match(concise.stdout, /\/engram --help/);
  assert.doesNotMatch(concise.stdout, /--automatic-memory-policy-generation/);
  assert.ok(detailed.stdout.length > concise.stdout.length * 2);
  assert.match(detailed.stdout, /Corpus —/);
  assert.match(detailed.stdout, /Job results —/);
});

function artifactDraft(digest) {
  return `---\ntype: Architecture Decision\ntitle: Python runtime\ndescription: The architecture document defines the supported Python runtime.\nsources:\n  - resource: project:docs/architecture.md\n    title: Architecture document\n    digest: ${digest}\n---\n# Runtime\n\nSee [the remembered version](/memories/python-version.md).\n`;
}

test("project vertical slice: initialize, write, search, replace, source drift, validate, deprecate, delete", async (t) => {
  const root = await tempProject(t);
  await fs.mkdir(path.join(root, "docs"));
  await fs.writeFile(path.join(root, "docs", "architecture.md"), "Python 3.13\n");

  let result = await run(["corpus", "initialize", "--corpus-context", "project", "--project-root-path", root]);
  assert.equal(result.code, 0, result.stderr);
  const initialized = JSON.parse(result.stdout);
  assert.equal(initialized.corpusContext, "project");
  assert.equal(initialized.created, true);
  assert.equal(initialized.projectRootPath, root);
  assert.match(initialized.bundlePath, /\.agents\/data\/okf-engram\/bundle$/);
  assert.equal(initialized.projectRoot, undefined);
  assert.equal(initialized.bundle, undefined);

  result = await run(["corpus", "initialize", "--corpus-context", "project", "--project-root-path", root]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).created, false);

  result = await run([
    "sources",
    "digest",
    "--source-resource",
    "project:docs/architecture.md",
    "--corpus-context",
    "project",
    "--project-root-path",
    root,
  ]);
  assert.equal(result.code, 0, result.stderr);
  const digested = JSON.parse(result.stdout);
  const digest = digested.digest;
  assert.match(digest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(digested.sourceFilePath, path.join(root, "docs", "architecture.md"));

  const draft = path.join(root, "memory.md");
  await fs.writeFile(draft, memoryDraft("This project targets Python 3.13."));
  result = await run([
    "concepts",
    "write",
    "--concept-id",
    "memories/python-version",
    "--corpus-context",
    "project",
    "--document-file-path",
    draft,
    "--project-root-path",
    root,
  ]);
  assert.equal(result.code, 0, result.stderr);
  const created = JSON.parse(result.stdout);
  assert.equal(created.corpusContext, "project");
  assert.match(created.conceptFilePath, /memories\/python-version\.md$/);
  assert.equal(created.path, undefined);

  const artifact = path.join(root, "artifact.md");
  await fs.writeFile(artifact, artifactDraft(digest));
  result = await run([
    "concepts",
    "write",
    "--concept-id",
    "decisions/python-runtime",
    "--corpus-context",
    "project",
    "--document-file-path",
    artifact,
    "--project-root-path",
    root,
  ]);
  assert.equal(result.code, 0, result.stderr);
  result = await run([
    "sources",
    "check",
    "--corpus-context",
    "project",
    "--concept-id",
    "decisions/python-runtime",
    "--project-root-path",
    root,
  ]);
  assert.equal(JSON.parse(result.stdout).sourceClaims[0].state, "unchanged");
  await fs.writeFile(path.join(root, "docs", "architecture.md"), "Python 3.14\n");
  result = await run([
    "sources",
    "check",
    "--corpus-context",
    "project",
    "--concept-id",
    "decisions/python-runtime",
    "--project-root-path",
    root,
  ]);
  assert.equal(JSON.parse(result.stdout).sourceClaims[0].state, "changed");
  result = await run(["corpus", "status", "--corpus-context", "project", "--project-root-path", root]);
  assert.equal(JSON.parse(result.stdout).sourceStates.changed, 1);

  result = await run([
    "concepts",
    "write",
    "--concept-id",
    "memories/python-version",
    "--corpus-context",
    "project",
    "--document-file-path",
    draft,
    "--project-root-path",
    root,
  ]);
  assert.equal(result.code, 5);
  assert.match(result.stderr, /already exists/);

  result = await run([
    "concepts",
    "search",
    "--query",
    "Python version",
    "--corpus-context",
    "project",
    "--project-root-path",
    root,
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).results[0].id, "memories/python-version");

  await fs.writeFile(draft, memoryDraft("This project targets Python 3.14.", "This project targets Python 3.14."));
  result = await run([
    "concepts",
    "write",
    "--concept-id",
    "memories/python-version",
    "--corpus-context",
    "project",
    "--document-file-path",
    draft,
    "--expected-current-sha256",
    created.hash,
    "--project-root-path",
    root,
  ]);
  assert.equal(result.code, 0, result.stderr);
  const replaced = JSON.parse(result.stdout);

  result = await run([
    "concepts",
    "write",
    "--concept-id",
    "memories/python-version",
    "--corpus-context",
    "project",
    "--document-file-path",
    draft,
    "--expected-current-sha256",
    created.hash,
    "--project-root-path",
    root,
  ]);
  assert.equal(result.code, 5);
  assert.match(result.stderr, /changed since/);

  const rootIndex = path.join(root, ".agents", "data", "okf-engram", "bundle", "index.md");
  const managedIndex = await fs.readFile(rootIndex, "utf8");
  await fs.writeFile(
    rootIndex,
    managedIndex.replace(
      /<!-- engram:index:start -->[\s\S]*<!-- engram:index:end -->/,
      "<!-- engram:index:start -->\nSTALE\n<!-- engram:index:end -->",
    ),
  );
  result = await run(["corpus", "validate", "--corpus-context", "project", "--project-root-path", root]);
  assert.equal(result.code, 0, result.stderr);
  assert.ok(JSON.parse(result.stdout).issues.some((issue) => issue.code === "index-drift"));
  result = await run(["corpus", "repair-indexes", "--corpus-context", "project", "--project-root-path", root]);
  assert.equal(result.code, 0, result.stderr);
  assert.ok(!JSON.parse(result.stdout).issues.some((issue) => issue.code === "index-drift"));
  const fixedIndex = await fs.readFile(rootIndex, "utf8");
  assert.match(fixedIndex, /okf_version: "0.2"/);
  assert.doesNotMatch(fixedIndex, /\nSTALE\n/);

  result = await run([
    "concepts",
    "deprecate",
    "--concept-id",
    "memories/python-version",
    "--corpus-context",
    "project",
    "--reason",
    "Python 3.15 supersedes it",
    "--expected-current-sha256",
    replaced.hash,
    "--project-root-path",
    root,
  ]);
  assert.equal(result.code, 0, result.stderr);
  const deprecated = JSON.parse(result.stdout);

  result = await run([
    "concepts",
    "search",
    "--query",
    "Python",
    "--corpus-context",
    "project",
    "--project-root-path",
    root,
  ]);
  const activeResults = JSON.parse(result.stdout).results;
  assert.ok(activeResults.some((item) => item.id === "decisions/python-runtime"));
  assert.ok(!activeResults.some((item) => item.id === "memories/python-version"));

  result = await run([
    "concepts",
    "delete",
    "--concept-id",
    "memories/python-version",
    "--corpus-context",
    "project",
    "--expected-current-sha256",
    deprecated.hash,
    "--project-root-path",
    root,
  ]);
  assert.equal(result.code, 8);

  result = await run([
    "concepts",
    "delete",
    "--concept-id",
    "memories/python-version",
    "--corpus-context",
    "project",
    "--expected-current-sha256",
    deprecated.hash,
    "--confirm-current-tree-deletion",
    "--project-root-path",
    root,
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).deleted, true);
});

test("M4 concept write rejects newly authored source-less Memory provenance", async (t) => {
  const root = await tempProject(t, "engram memory provenance ");
  let result = await run(["corpus", "initialize", "--corpus-context", "project", "--project-root-path", root]);
  assert.equal(result.code, 0, result.stderr);
  const draft = path.join(root, "source-less.md");
  await fs.writeFile(
    draft,
    `---
type: Memory
title: Source-less memory
description: A body label cannot replace source frontmatter.
capture: explicit
---
# Source-less memory

Source: urn:okf-engram:conversation:body-only
`,
  );
  result = await run([
    "concepts",
    "write",
    "--concept-id",
    "memories/source-less",
    "--corpus-context",
    "project",
    "--document-file-path",
    draft,
    "--project-root-path",
    root,
  ]);
  assert.equal(result.code, 4);
  assert.match(result.stderr, /provenance source/i);
  result = await run([
    "concepts",
    "read",
    "--concept-id",
    "memories/source-less",
    "--corpus-context",
    "project",
    "--project-root-path",
    root,
  ]);
  assert.equal(result.code, 7);
});

test("supports a symlinked .agents data root but rejects bundle-internal symlinks", async (t) => {
  const root = await tempProject(t, "engram symlink ");
  await fs.mkdir(path.join(root, ".pi"));
  await fs.symlink(".pi", path.join(root, ".agents"), "dir");
  let result = await run(["corpus", "initialize", "--corpus-context", "project", "--project-root-path", root]);
  assert.equal(result.code, 0, result.stderr);
  const initialized = JSON.parse(result.stdout);
  assert.match(initialized.bundlePath, /\.pi\/data\/okf-engram\/bundle$/);

  assert.equal((await git(root, ["init", "-q"])).code, 0);
  assert.equal((await git(root, ["add", ".agents", ".pi/data/okf-engram/bundle"])).code, 0);
  result = await run(["corpus", "status", "--corpus-context", "project", "--project-root-path", root]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).git, { repository: true, tracked: true, ignored: false });

  const outside = path.join(root, "outside");
  await fs.mkdir(outside);
  const memories = path.join(initialized.bundlePath, "memories");
  await fs.rm(memories, { recursive: true });
  await fs.symlink(outside, memories, "dir");
  const draft = path.join(root, "memory.md");
  await fs.writeFile(draft, memoryDraft("Unsafe target"));
  result = await run([
    "concepts",
    "write",
    "--concept-id",
    "memories/unsafe",
    "--corpus-context",
    "project",
    "--document-file-path",
    draft,
    "--project-root-path",
    root,
  ]);
  assert.equal(result.code, 9);
  assert.match(result.stderr, /Symlink inside/);
  result = await run(["corpus", "repair-indexes", "--corpus-context", "project", "--project-root-path", root]);
  assert.equal(result.code, 9);
  assert.match(result.stderr, /Symlink inside/);
});
