import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const helper = path.join(repository, "scripts", "engram.mjs");

function run(args, { cwd = repository, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [helper, ...args], {
      cwd,
      env: { ...process.env, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "engram linked "));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const active = path.join(root, "active");
  const first = path.join(root, "first");
  const second = path.join(root, "second");
  const xdg = path.join(root, "xdg");
  await Promise.all([active, first, second].map((directory) => fs.mkdir(directory)));
  const env = { XDG_DATA_HOME: xdg };
  for (const project of [active, first, second]) {
    const initialized = await run([
      "corpus", "initialize", "--corpus-context", "project", "--project-root-path", project,
    ], { env });
    assert.equal(initialized.code, 0, initialized.stderr);
  }
  return {
    root,
    active,
    first,
    second,
    env,
    linksFile: path.join(active, ".agents", "data", "okf-engram", "links.json"),
    bundle: (project) => path.join(project, ".agents", "data", "okf-engram", "bundle"),
  };
}

function projectOptions(project) {
  return ["--corpus-context", "project", "--project-root-path", project];
}

function linkedOptions(project, name) {
  return ["--linked-corpus-name", name, "--project-root-path", project];
}

async function writeConcept(f, project, id, title, body) {
  const draft = path.join(f.root, `${title.replaceAll(" ", "-")}.md`);
  await fs.writeFile(
    draft,
    `---\ntype: Note\ntitle: ${title}\ndescription: ${body}\n---\n# ${title}\n\n${body}\n`,
  );
  const result = await run([
    "concepts", "write", ...projectOptions(project), "--concept-id", id,
    "--document-file-path", draft,
  ], { env: f.env });
  assert.equal(result.code, 0, result.stderr);
  return JSON.parse(result.stdout);
}

async function addLink(f, name, target) {
  return run([
    "corpus", "links", "add", ...projectOptions(f.active),
    "--link-name", name, "--linked-corpus-path", target,
  ], { env: f.env });
}

test("M6 links lifecycle and context-qualified N-way reads stay read-only", async (t) => {
  const f = await fixture(t);
  await writeConcept(f, f.active, "decisions/database", "Project database", "The project uses PostgreSQL.");
  await writeConcept(f, f.first, "decisions/database", "Shared database", "Shared guidance prefers SQLite.");
  await writeConcept(f, f.first, "guides/release", "Release guide", "Use the bounded release checklist.");

  let result = await addLink(f, "shared", f.first);
  assert.equal(result.code, 0, result.stderr);
  let output = JSON.parse(result.stdout);
  assert.equal(output.name, "shared");
  assert.equal(output.address, "@shared");
  assert.equal(output.targetKind, "project");
  assert.equal(output.available, true);
  assert.equal(output.policy.knowledgeMode, "guarded");
  assert.deepEqual(output.warnings, []);

  result = await run(["corpus", "links", "list", ...projectOptions(f.active)], { env: f.env });
  assert.equal(result.code, 0, result.stderr);
  output = JSON.parse(result.stdout);
  assert.equal(output.maximumLinks, 32);
  assert.equal(output.linksFilePath, f.linksFile);
  assert.deepEqual(output.links.map((link) => link.address), ["@shared"]);

  result = await run([
    "concepts", "search", ...projectOptions(f.active), "--linked-corpus-name", "shared",
    "--query", "database", "--result-limit", "10",
  ], { env: f.env });
  assert.equal(result.code, 0, result.stderr);
  output = JSON.parse(result.stdout);
  assert.deepEqual(output.corpora, [
    { corpusContext: "project" },
    { corpusContext: "linked", corpusLinkName: "shared" },
  ]);
  assert.deepEqual(output.results.map((item) => [item.corpusContext, item.corpusLinkName, item.id]), [
    ["project", undefined, "decisions/database"],
    ["linked", "shared", "decisions/database"],
  ]);

  result = await run([
    "concepts", "search", ...linkedOptions(f.active, "shared"), "--query", "release",
  ], { env: f.env });
  assert.equal(result.code, 0, result.stderr);
  output = JSON.parse(result.stdout);
  assert.equal(output.results[0].corpusContext, "linked");
  assert.equal(output.results[0].corpusLinkName, "shared");

  result = await run([
    "concepts", "list", ...projectOptions(f.active), "--linked-corpus-name", "shared",
  ], { env: f.env });
  assert.equal(result.code, 0, result.stderr);
  output = JSON.parse(result.stdout);
  assert.ok(output.concepts.every((concept) => concept.corpusContext));
  assert.ok(output.concepts.some((concept) => concept.corpusLinkName === "shared"));

  result = await run([
    "concepts", "read", ...projectOptions(f.active), "--linked-corpus-name", "shared",
    "--concept-id", "decisions/database",
  ], { env: f.env });
  assert.equal(result.code, 4);
  assert.match(JSON.parse(result.stderr).message, /ambiguous across/);

  result = await run([
    "concepts", "read", ...linkedOptions(f.active, "shared"),
    "--concept-id", "guides/release",
  ], { env: f.env });
  assert.equal(result.code, 0, result.stderr);
  output = JSON.parse(result.stdout);
  assert.equal(output.corpusContext, "linked");
  assert.equal(output.corpusLinkName, "shared");

  const targetIndexBefore = await fs.readFile(path.join(f.bundle(f.first), "index.md"), "utf8");
  const draft = path.join(f.root, "blocked.md");
  await fs.writeFile(draft, "---\ntype: Note\ntitle: Blocked\ndescription: Blocked.\n---\n# Blocked\n");
  result = await run([
    "concepts", "write", ...linkedOptions(f.active, "shared"), "--concept-id", "blocked",
    "--document-file-path", draft,
  ], { env: f.env });
  assert.equal(result.code, 2);
  assert.match(JSON.parse(result.stderr).message, /read-only/);
  assert.equal(await fs.readFile(path.join(f.bundle(f.first), "index.md"), "utf8"), targetIndexBefore);

  result = await run([
    "corpus", "links", "remove", ...projectOptions(f.active), "--link-name", "shared",
  ], { env: f.env });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).removed, true);
  result = await run([
    "concepts", "search", ...linkedOptions(f.active, "shared"), "--query", "release",
  ], { env: f.env });
  assert.equal(result.code, 7);
});

test("M6 follows a configured boundary symlink and reports broken or unsafe links", async (t) => {
  const f = await fixture(t);
  await writeConcept(f, f.first, "deployment/first", "First deployment", "Blue deployment knowledge.");
  await writeConcept(f, f.second, "deployment/second", "Second deployment", "Green deployment knowledge.");
  const current = path.join(f.root, "current-knowledge");
  await fs.symlink(f.first, current, "dir");

  let result = await addLink(f, "deployment", current);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).configuredPath, current);
  assert.equal(JSON.parse(result.stdout).resolvedBundlePath, f.bundle(f.first));

  result = await run([
    "concepts", "search", ...linkedOptions(f.active, "deployment"), "--query", "Blue",
  ], { env: f.env });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).results[0].id, "deployment/first");

  const replacement = path.join(f.root, "replacement-link");
  await fs.symlink(f.second, replacement, "dir");
  await fs.rename(replacement, current);
  result = await run([
    "concepts", "search", ...linkedOptions(f.active, "deployment"), "--query", "Green",
  ], { env: f.env });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).results[0].id, "deployment/second");

  result = await run(["corpus", "links", "list", ...projectOptions(f.active)], { env: f.env });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).links[0].resolvedBundlePath, f.bundle(f.second));

  await fs.rm(f.second, { recursive: true });
  result = await run(["corpus", "links", "list", ...projectOptions(f.active)], { env: f.env });
  assert.equal(result.code, 0, result.stderr);
  const listed = JSON.parse(result.stdout).links[0];
  assert.equal(listed.available, false);
  assert.match(listed.issue, /unavailable/);
  result = await run([
    "concepts", "search", ...linkedOptions(f.active, "deployment"), "--query", "Green",
  ], { env: f.env });
  assert.equal(result.code, 4);

  await fs.symlink(path.join(f.root, "outside"), path.join(f.bundle(f.first), "unsafe"));
  result = await addLink(f, "unsafe", f.first);
  assert.equal(result.code, 4);
  assert.match(JSON.parse(result.stderr).message, /malformed or unsafe|Symlink/);
});

test("M6 rejects self/global/duplicate targets, warns on privacy, and enforces 32 links", async (t) => {
  const f = await fixture(t);
  let result = await addLink(f, "self", f.active);
  assert.equal(result.code, 4);
  assert.match(JSON.parse(result.stderr).message, /own corpus/);

  result = await addLink(f, "one", f.first);
  assert.equal(result.code, 0, result.stderr);
  result = await addLink(f, "duplicate", f.bundle(f.first));
  assert.equal(result.code, 5);
  assert.match(JSON.parse(result.stderr).message, /duplicates @one/);

  const globalInit = await run(["corpus", "initialize", "--corpus-context", "global"], { env: f.env });
  assert.equal(globalInit.code, 0, globalInit.stderr);
  result = await addLink(f, "global-copy", path.join(f.env.XDG_DATA_HOME, "okf-engram", "bundle"));
  assert.equal(result.code, 4);
  assert.match(JSON.parse(result.stderr).message, /global corpus/);

  result = await run([
    "policy", "project", "sensitive-data", "allow", ...projectOptions(f.second),
  ], { env: f.env });
  assert.equal(result.code, 0, result.stderr);
  result = await addLink(f, "private-notes", f.second);
  assert.equal(result.code, 0, result.stderr);
  const privateLink = JSON.parse(result.stdout);
  assert.equal(privateLink.policy.knowledgeMode, "unguarded");
  assert.ok(privateLink.warnings.some((warning) => /model provider/.test(warning)));

  const links = Array.from({ length: 32 }, (_, index) => ({
    name: `link-${String(index).padStart(2, "0")}`,
    path: path.join(f.root, `missing-${index}`),
    targetKind: "bundle",
  }));
  await fs.writeFile(f.linksFile, `${JSON.stringify({ version: 1, links }, null, 2)}\n`);
  result = await addLink(f, "overflow", f.first);
  assert.equal(result.code, 4);
  assert.match(JSON.parse(result.stderr).message, /at most 32/);
});
