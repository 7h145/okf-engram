import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import { sha256 } from "../../scripts/lib/hash.mjs";

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

async function tempProject(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "engram source summary "));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const initialized = await run(["init", "--project-root", root, "--json"]);
  assert.equal(initialized.code, 0, initialized.stderr);
  return root;
}

function draft(title, sources) {
  return `---\n${stringify({
    type: "Knowledge",
    title,
    description: "Source-summary integration fixture.",
    sources,
  }).trimEnd()}\n---\n# ${title}\n\nFixture knowledge.\n`;
}

async function put(root, id, text) {
  const file = path.join(root, `${id.replaceAll("/", "-")}.md`);
  await fs.writeFile(file, text);
  const result = await run(["put", id, "--from", file, "--project-root", root, "--json"]);
  assert.equal(result.code, 0, result.stderr);
}

function digest(text) {
  return `sha256:${sha256(text)}`;
}

function byResource(summary, resource) {
  const item = summary.resources.find((candidate) => candidate.resource === resource);
  assert.ok(item, `missing summary resource ${JSON.stringify(resource)}`);
  return item;
}

test("M4 source summary groups every resource and preserves status conflicts without network access", async (t) => {
  const root = await tempProject(t);
  const docs = path.join(root, "docs");
  await fs.mkdir(docs);
  const files = {
    shared: "shared bytes\n",
    changed: "captured bytes\n",
    conflict: "current conflict bytes\n",
    digestless: "digestless bytes\n",
    invalid: "invalid metadata bytes\n",
  };
  await Promise.all(Object.entries(files).map(([name, text]) => (
    fs.writeFile(path.join(docs, `${name}.md`), text)
  )));

  let requests = 0;
  const server = http.createServer((_request, response) => {
    requests += 1;
    response.end("must not be fetched");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const remote = `http://127.0.0.1:${address.port}/reference\nFORGED`;

  const sharedDigest = digest(files.shared);
  const changedDigest = digest(files.changed);
  const conflictDigest = digest(files.conflict);
  await put(root, "evidence/one", draft("Evidence one", [
    {
      id: "shared-one", resource: "project:docs/shared.md", digest: sharedDigest,
      selector: { kind: "heading", value: "Shared" },
    },
    { id: "changed", resource: "project:docs/changed.md", digest: changedDigest },
    { id: "remote", resource: remote },
    { id: "conversation", resource: "urn:okf-engram:conversation:summary-test" },
    { id: "digestless", resource: "project:docs/digestless.md" },
    { id: "missing", resource: "project:docs/missing.md", digest: digest("missing bytes\n") },
    { id: "unsafe", resource: "project:../escape.md", digest: digest("escape bytes\n") },
  ]));
  await put(root, "evidence/two", draft("Evidence two", [
    {
      id: "shared-two", resource: "project:docs/shared.md", digest: sharedDigest,
      selector: { value: "Shared", kind: "heading" },
    },
    { id: "conflict-current", resource: "project:docs/conflict.md", digest: conflictDigest },
  ]));
  await put(root, "evidence/three", draft("Evidence three", [
    { id: "conflict-old", resource: "project:docs/conflict.md", digest: digest("older bytes\n") },
  ]));
  await fs.writeFile(path.join(docs, "changed.md"), "changed live bytes\n");

  const bundle = path.join(root, ".agents", "data", "okf-engram", "bundle");
  await fs.writeFile(path.join(bundle, "malformed-sources.md"), `---
type: Knowledge
title: Malformed sources
description: Source metadata that remains inspectable despite profile diagnostics.
sources:
  - id: invalid-digest
    resource: project:docs/invalid.md
    digest: sha256:not-a-digest
  - scalar-claim
  - resource: " "
---
# Malformed sources

Fixture knowledge.
`);
  await fs.writeFile(path.join(bundle, "malformed-list.md"), `---
type: Knowledge
title: Malformed source list
description: A malformed source-list shape remains inspectable.
sources: { resource: project:docs/shared.md }
---
# Malformed source list

Fixture knowledge.
`);

  const result = await run(["check-sources", "--summary", "--project-root", root, "--json"]);
  assert.equal(result.code, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(summary), ["resources", "invalidClaims", "totals"]);
  assert.equal(summary.resources.length, 9);
  assert.equal(summary.totals.resources, 9);
  assert.equal(summary.totals.references, 11);
  assert.equal(summary.totals.invalidClaims, 3);
  assert.deepEqual(summary.totals.states, {
    unchanged: 1,
    changed: 1,
    missing: 1,
    unresolvable: 1,
    "not-checkable": 3,
    conflicting: 1,
    invalid: 1,
  });

  const shared = byResource(summary, "project:docs/shared.md");
  assert.equal(shared.state, "unchanged");
  assert.equal(shared.referenceCount, 2);
  assert.equal(shared.digestReferenceCount, 2);
  assert.equal(shared.digestlessReferenceCount, 0);
  assert.equal(shared.gitReferenceCount, 0);
  assert.deepEqual(shared.conceptIds, ["evidence/one", "evidence/two"]);
  assert.deepEqual(shared.sourceIds, ["shared-one", "shared-two"]);
  assert.deepEqual(shared.expectedDigests, [sharedDigest]);
  assert.deepEqual(shared.selectors, [{ kind: "heading", value: "Shared" }]);
  assert.equal(shared.actual, sharedDigest);
  assert.equal(shared.gitState, "none");

  assert.equal(byResource(summary, "project:docs/changed.md").state, "changed");
  assert.equal(byResource(summary, "project:docs/missing.md").state, "missing");
  assert.equal(byResource(summary, "project:../escape.md").state, "unresolvable");
  assert.deepEqual(byResource(summary, "project:docs/digestless.md"), {
    resource: "project:docs/digestless.md",
    referenceCount: 1,
    digestReferenceCount: 0,
    digestlessReferenceCount: 1,
    gitReferenceCount: 0,
    conceptIds: ["evidence/one"],
    sourceIds: ["digestless"],
    expectedDigests: [],
    selectors: [],
    state: "not-checkable",
    reason: "digest-missing",
    gitState: "none",
    gitStates: [],
    issues: [],
  });

  const nonLocal = byResource(summary, remote);
  assert.equal(nonLocal.state, "not-checkable");
  assert.equal(nonLocal.reason, "non-local");
  assert.equal(byResource(summary, "urn:okf-engram:conversation:summary-test").state, "not-checkable");
  assert.equal(requests, 0, "summary must not fetch URL resources");

  const conflict = byResource(summary, "project:docs/conflict.md");
  assert.equal(conflict.state, "conflicting");
  assert.deepEqual(conflict.expectedDigests, [conflictDigest, digest("older bytes\n")].sort());
  assert.equal(conflict.actual, conflictDigest);

  const invalid = byResource(summary, "project:docs/invalid.md");
  assert.equal(invalid.state, "invalid");
  assert.match(invalid.issues[0].error, /digest/i);
  assert.deepEqual(summary.invalidClaims.map((item) => item.conceptId), [
    "malformed-list", "malformed-sources", "malformed-sources",
  ]);

  const human = await run(["check-sources", "--summary", "--project-root", root]);
  assert.equal(human.code, 0, human.stderr);
  assert.match(human.stdout, /^STATE\tGIT\tREFS\tRESOURCE\tCONCEPTS\n/);
  assert.match(human.stdout, /unchanged\tnone\t2\t"project:docs\/shared.md"\t\["evidence\/one","evidence\/two"\]/);
  assert.match(human.stdout, /9 resources; 11 references; 3 invalid claims/);
  assert.doesNotMatch(human.stdout, /\nFORGED/);
  assert.match(human.stdout, /\\nFORGED/);
  assert.equal(requests, 0, "human summary must not fetch URL resources");
});

test("M4 bare check-sources stays claim-level and --summary accepts one concept ID", async (t) => {
  const root = await tempProject(t);
  await fs.mkdir(path.join(root, "docs"));
  await fs.writeFile(path.join(root, "docs", "shared.md"), "shared\n");
  const expected = digest("shared\n");
  await put(root, "evidence/one", draft("Evidence one", [
    { id: "one", resource: "project:docs/shared.md", digest: expected },
    { id: "conversation", resource: "urn:okf-engram:conversation:one" },
  ]));
  await put(root, "evidence/two", draft("Evidence two", [
    { id: "two", resource: "project:docs/shared.md", digest: expected },
    { id: "two-digestless", resource: "project:docs/shared.md" },
  ]));

  const bare = await run(["check-sources", "--project-root", root, "--json"]);
  assert.equal(bare.code, 0, bare.stderr);
  const claims = JSON.parse(bare.stdout);
  assert.ok(Array.isArray(claims));
  assert.equal(claims.length, 2);
  assert.deepEqual(claims.map((item) => item.id), ["evidence/one", "evidence/two"]);

  const grouped = await run(["check-sources", "--summary", "--project-root", root, "--json"]);
  assert.equal(grouped.code, 0, grouped.stderr);
  const groupedShared = byResource(JSON.parse(grouped.stdout), "project:docs/shared.md");
  assert.equal(groupedShared.referenceCount, 3);
  assert.equal(groupedShared.digestReferenceCount, 2);
  assert.equal(groupedShared.digestlessReferenceCount, 1);
  assert.equal(groupedShared.state, "unchanged");

  const selected = await run([
    "check-sources", "evidence/one", "--summary", "--project-root", root, "--json",
  ]);
  assert.equal(selected.code, 0, selected.stderr);
  const summary = JSON.parse(selected.stdout);
  assert.equal(summary.resources.length, 2);
  const selectedShared = byResource(summary, "project:docs/shared.md");
  assert.equal(selectedShared.referenceCount, 1);
  assert.equal(selectedShared.digestlessReferenceCount, 0);
  assert.equal(byResource(summary, "urn:okf-engram:conversation:one").state, "not-checkable");

  const missing = await run([
    "check-sources", "evidence/absent", "--summary", "--project-root", root, "--json",
  ]);
  assert.equal(missing.code, 7);
  assert.match(missing.stderr, /not found/i);
});
