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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "engram validation "));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bundle = path.join(root, ".agents", "data", "okf-engram", "bundle");
  assert.equal(
    (await run(["corpus", "initialize", "--corpus-context", "project", "--project-root-path", root])).code,
    0,
  );
  return { root, bundle };
}

test("R4 malformed source metadata yields structured diagnostics without crashing readers", async (t) => {
  const { root, bundle } = await project(t);
  await fs.writeFile(
    path.join(bundle, "bad-sources.md"),
    `---
type: Note
title: Bad sources
description: Hand-edited malformed source metadata.
sources: { resource: project:missing.md }
---
# Note

Still searchable.
`,
  );

  let result = await run(["corpus", "validate", "--corpus-context", "project", "--project-root-path", root]);
  assert.equal(result.code, 0, result.stderr);
  let parsed = JSON.parse(result.stdout);
  assert.equal(parsed.valid, true);
  assert.ok(
    parsed.issues.some(
      (issue) => issue.code === "sources-shape" && issue.category === "profile" && issue.id === "bad-sources",
    ),
  );

  result = await run(["corpus", "status", "--corpus-context", "project", "--project-root-path", root]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).sourceStates.invalid, 1);

  result = await run([
    "sources",
    "check",
    "--corpus-context",
    "project",
    "--concept-id",
    "bad-sources",
    "--project-root-path",
    root,
  ]);
  assert.equal(result.code, 0, result.stderr);
  parsed = JSON.parse(result.stdout);
  assert.equal(parsed.sourceClaims[0].state, "invalid");
  assert.match(parsed.sourceClaims[0].error, /sources must be a list/i);

  result = await run([
    "concepts",
    "search",
    "--query",
    "bad sources",
    "--corpus-context",
    "project",
    "--project-root-path",
    root,
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).results[0].id, "bad-sources");
});

test("R4 malformed root index is a conformance error and fix never overwrites it", async (t) => {
  const { root, bundle } = await project(t);
  const index = path.join(bundle, "index.md");
  const malformed =
    "---\nokf_version: [broken\n---\n# Valuable user text\n\n<!-- engram:index:start -->\nSTALE\n<!-- engram:index:end -->\n";
  await fs.writeFile(index, malformed);

  let result = await run(["corpus", "validate", "--corpus-context", "project", "--project-root-path", root]);
  assert.equal(result.code, 4, result.stderr);
  let parsed = JSON.parse(result.stdout);
  assert.equal(parsed.valid, false);
  assert.ok(parsed.issues.some((issue) => issue.code === "invalid-root-index" && issue.category === "conformance"));

  result = await run(["corpus", "repair-indexes", "--corpus-context", "project", "--project-root-path", root]);
  assert.equal(result.code, 4, result.stderr);
  assert.equal(await fs.readFile(index, "utf8"), malformed);
});

test("R4 reserved index and log structure are validated as conformance", async (t) => {
  const { root, bundle } = await project(t);
  const group = path.join(bundle, "group");
  await fs.mkdir(group);
  await fs.writeFile(path.join(group, "index.md"), "---\ntitle: forbidden\n---\n# Group\n");
  await fs.writeFile(path.join(group, "log.md"), "# Log\n\n## someday\nNot a dated bullet.\n");

  const result = await run(["corpus", "validate", "--corpus-context", "project", "--project-root-path", root]);
  assert.equal(result.code, 4, result.stderr);
  const issues = JSON.parse(result.stdout).issues;
  assert.ok(
    issues.some((issue) => issue.code === "subdirectory-index-frontmatter" && issue.category === "conformance"),
  );
  assert.ok(issues.some((issue) => issue.code === "invalid-log" && issue.category === "conformance"));
});

test("R4 type-only OKF concepts remain consumable while Engram-authored puts stay strict", async (t) => {
  const { root, bundle } = await project(t);
  const minimal = "---\ntype: Note\ncustom: preserve\n---\nBody.\n";
  await fs.writeFile(path.join(bundle, "minimal.md"), minimal);

  let result = await run(["corpus", "validate", "--corpus-context", "project", "--project-root-path", root]);
  assert.equal(result.code, 0, result.stderr);
  let parsed = JSON.parse(result.stdout);
  assert.equal(parsed.valid, true);
  assert.ok(
    parsed.issues.some(
      (issue) => issue.code === "title-required" && issue.category === "profile" && issue.severity === "warning",
    ),
  );

  result = await run(["concepts", "list", "--corpus-context", "project", "--project-root-path", root]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).concepts.find((item) => item.id === "minimal").title, "minimal");

  result = await run([
    "concepts",
    "search",
    "--query",
    "minimal",
    "--corpus-context",
    "project",
    "--project-root-path",
    root,
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).results[0].id, "minimal");

  const draft = path.join(root, "minimal.md");
  await fs.writeFile(draft, minimal);
  result = await run([
    "concepts",
    "write",
    "--concept-id",
    "authored-minimal",
    "--corpus-context",
    "project",
    "--document-file-path",
    draft,
    "--project-root-path",
    root,
  ]);
  assert.equal(result.code, 4);
});

test("R4 invalid used timestamps are profile diagnostics and block authored puts", async (t) => {
  const { root, bundle } = await project(t);
  const invalid = `---
type: Note
title: Invalid timestamps
description: Invalid timestamp fixture.
generated: { by: test/1, at: yesterday }
stale_after: soon
sources:
  - resource: https://example.invalid/source
    last_modified: recently
---
# Note

Body.
`;
  await fs.writeFile(path.join(bundle, "invalid-time.md"), invalid);

  let result = await run(["corpus", "validate", "--corpus-context", "project", "--project-root-path", root]);
  assert.equal(result.code, 0, result.stderr);
  const issues = JSON.parse(result.stdout).issues;
  for (const code of ["generated-at", "stale-after", "source-last-modified"]) {
    assert.ok(
      issues.some((issue) => issue.code === code && issue.category === "profile"),
      code,
    );
  }

  const draft = path.join(root, "invalid.md");
  await fs.writeFile(draft, invalid);
  result = await run([
    "concepts",
    "write",
    "--concept-id",
    "authored-invalid-time",
    "--corpus-context",
    "project",
    "--document-file-path",
    draft,
    "--project-root-path",
    root,
  ]);
  assert.equal(result.code, 4);
});

test("M2b malformed selectors, Git identities, and duplicate source IDs are profile diagnostics", async (t) => {
  const { root, bundle } = await project(t);
  const invalid = `---
type: Note
title: Invalid source identity
description: Malformed M2b source metadata.
sources:
  - id: duplicate
    resource: project:source.md
    digest: sha256:${"1".repeat(64)}
    selector: { kind: lines, value: 0-2 }
    git:
      repository: project:.
      remote: https://example.invalid/repository.git
      commit: { algorithm: sha1, oid: ${"2".repeat(40)} }
      path: ../escape.md
      blob: { algorithm: sha256, oid: ${"3".repeat(64)} }
  - id: duplicate
    resource: project:other.md
---
# Note

Body.
`;
  await fs.writeFile(path.join(bundle, "invalid-source-identity.md"), invalid);

  let result = await run(["corpus", "validate", "--corpus-context", "project", "--project-root-path", root]);
  assert.equal(result.code, 0, result.stderr);
  const issues = JSON.parse(result.stdout).issues;
  for (const code of ["source-selector", "source-git", "source-id-duplicate"]) {
    assert.ok(
      issues.some((issue) => issue.code === code && issue.category === "profile" && issue.severity === "warning"),
      code,
    );
  }

  const draft = path.join(root, "invalid-source.md");
  await fs.writeFile(draft, invalid);
  result = await run([
    "concepts",
    "write",
    "--concept-id",
    "invalid-authored-source",
    "--corpus-context",
    "project",
    "--document-file-path",
    draft,
    "--project-root-path",
    root,
  ]);
  assert.equal(result.code, 4);
  assert.equal(JSON.parse(result.stderr).error, "VALIDATION_ERROR");
});
