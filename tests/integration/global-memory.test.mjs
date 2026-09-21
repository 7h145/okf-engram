import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveGlobal } from "../../scripts/lib/project.mjs";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const helper = path.join(repository, "scripts", "engram.mjs");

function run(args, { cwd = repository, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [helper, ...args], { cwd, env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function fixture(t, prefix = "engram global ") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const xdg = path.join(root, "xdg data");
  return {
    root,
    project: path.join(root, "project"),
    xdg,
    env: { XDG_DATA_HOME: xdg },
    state: path.join(xdg, "okf-engram"),
    bundle: path.join(xdg, "okf-engram", "bundle"),
  };
}

function memoryDraft(title, body, { capture = "explicit", resource = "urn:okf-engram:conversation:test", artifact = false } = {}) {
  return `---\ntype: Memory\ntitle: ${title}\ndescription: ${body}\ncapture: ${capture}\nsources:\n  - resource: ${resource}${artifact ? "\n    digest: sha256:" + "0".repeat(64) : ""}\n---\n# ${title}\n\n${body}\n`;
}

async function writeDraft(root, name, text) {
  const file = path.join(root, `${name}.md`);
  await fs.writeFile(file, text);
  return file;
}

async function initializeGlobal(f) {
  return run(["corpus", "initialize", "--corpus-context", "global"], { env: f.env });
}

test("M5 default global location follows the XDG fallback without mutation", async (t) => {
  const f = await fixture(t, "engram global default ");
  const context = await resolveGlobal({ env: {}, homeDirectory: f.root });
  assert.equal(context.corpusContext, "global");
  assert.equal(context.logicalBundle, path.join(f.root, ".local", "share", "okf-engram", "bundle"));
  assert.equal(context.initialized, false);
  await assert.rejects(() => fs.access(path.join(f.root, ".local")));
});

async function writeGlobal(f, id, draft) {
  return run([
    "concepts", "write", "--corpus-context", "global", "--concept-id", id,
    "--document-file-path", draft,
  ], { env: f.env });
}

test("M5 global resolution is XDG-scoped, explicit, restrictive, and project-independent", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(f.project);

  let result = await run(["corpus", "locate", "--corpus-context", "global"], { env: f.env });
  assert.equal(result.code, 0, result.stderr);
  let output = JSON.parse(result.stdout);
  assert.equal(output.corpusContext, "global");
  assert.equal(output.initialized, false);
  assert.equal(output.logicalBundlePath, f.bundle);
  assert.equal(output.projectRootPath, undefined);
  await assert.rejects(() => fs.access(f.state));

  result = await run([
    "corpus", "locate", "--corpus-context", "global", "--project-root-path", f.project,
  ], { env: f.env });
  assert.equal(result.code, 2);
  assert.match(JSON.parse(result.stderr).message, /does not accept --project-root-path/);

  result = await run(["corpus", "locate", "--corpus-context", "global"], {
    env: { XDG_DATA_HOME: "relative/data" },
  });
  assert.equal(result.code, 2);
  assert.match(JSON.parse(result.stderr).message, /XDG_DATA_HOME must be an absolute path/);
  const blockedDataHome = path.join(f.root, "not-a-directory");
  await fs.writeFile(blockedDataHome, "blocked\n");
  result = await run(["corpus", "locate", "--corpus-context", "global"], {
    env: { XDG_DATA_HOME: blockedDataHome },
  });
  assert.equal(result.code, 4);
  assert.match(JSON.parse(result.stderr).message, /not a directory/);

  result = await initializeGlobal(f);
  assert.equal(result.code, 0, result.stderr);
  output = JSON.parse(result.stdout);
  assert.equal(output.created, true);
  assert.equal(output.dataHomePath, f.xdg);
  assert.equal(output.logicalBundlePath, f.bundle);
  assert.equal(output.readmeCreated, true);
  assert.equal(output.readmeFilePath, path.join(f.state, "README.md"));
  assert.equal(output.gitignoreSuggestions, undefined);
  assert.equal((await fs.stat(f.state)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(f.bundle)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(path.join(f.bundle, "index.md"))).mode & 0o777, 0o600);
  await assert.rejects(() => fs.access(path.join(f.state, "settings.json")));

  result = await initializeGlobal(f);
  assert.equal(result.code, 0, result.stderr);
  output = JSON.parse(result.stdout);
  assert.equal(output.created, false);
  assert.equal(output.readmeCreated, false);

  result = await run(["corpus", "status", "--corpus-context", "global"], { env: f.env });
  assert.equal(result.code, 0, result.stderr);
  output = JSON.parse(result.stdout);
  assert.equal(output.corpusContext, "global");
  assert.equal(output.automaticMemory.available, false);
  assert.equal(output.automaticMemory.automaticMemory, "off");
  assert.equal(output.automaticMemory.issue, undefined);
  assert.equal(output.sensitiveData.knowledgeMode, "guarded");
  assert.equal(output.sensitiveData.previouslyUnguarded, false);
  assert.equal(output.git, undefined);

  const projectResult = await run([
    "corpus", "initialize", "--corpus-context", "project", "--project-root-path", f.project,
  ], { env: f.env });
  assert.equal(projectResult.code, 0, projectResult.stderr);
  assert.equal((await fs.readdir(path.join(f.project, ".agents", "data", "okf-engram", "bundle"))).length > 0, true);
  assert.equal(JSON.parse((await run([
    "corpus", "status", "--corpus-context", "global",
  ], { env: f.env })).stdout).concepts, 0);
});

test("M5 global writes enforce explicit Memory-only provenance at the storage boundary", async (t) => {
  const f = await fixture(t);
  assert.equal((await initializeGlobal(f)).code, 0);

  const valid = await writeDraft(f.root, "valid", memoryDraft("Editor preference", "The user prefers Neovim."));
  let result = await writeGlobal(f, "memories/editor", valid);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).corpusContext, "global");

  const inferred = await writeDraft(
    f.root,
    "inferred",
    memoryDraft("Inferred", "This must not be global.", { capture: "inferred" }),
  );
  result = await writeGlobal(f, "memories/inferred", inferred);
  assert.equal(result.code, 4);
  assert.match(JSON.parse(result.stderr).message, /capture: explicit/);

  const localSource = await writeDraft(
    f.root,
    "local-source",
    memoryDraft("Local source", "This source is project data.", { resource: "project:README.md" }),
  );
  result = await writeGlobal(f, "memories/local-source", localSource);
  assert.equal(result.code, 4);
  assert.match(JSON.parse(result.stderr).message, /provenance sources must be URNs/);

  const artifactSource = await writeDraft(
    f.root,
    "artifact-source",
    memoryDraft("Artifact source", "Digest metadata is not global memory provenance.", { artifact: true }),
  );
  result = await writeGlobal(f, "memories/artifact-source", artifactSource);
  assert.equal(result.code, 4);
  assert.match(JSON.parse(result.stderr).message, /artifact metadata/);

  const note = await writeDraft(
    f.root,
    "note",
    "---\ntype: Note\ntitle: Note\ndescription: Not a Memory.\n---\n# Note\n\nBody.\n",
  );
  result = await writeGlobal(f, "notes/no", note);
  assert.equal(result.code, 4);
  assert.match(JSON.parse(result.stderr).message, /only Memory concepts/);

  for (const args of [
    ["sources", "digest", "--source-resource", "file:/tmp/no", "--corpus-context", "global"],
    ["knowledge", "ingest", "--source-resource", "file:/tmp/no", "--corpus-context", "global"],
    ["jobs", "list", "--corpus-context", "global"],
    ["policy", "global", "automatic-memory", "status", "--corpus-context", "global"],
  ]) {
    result = await run(args, { env: f.env });
    assert.equal(result.code, 2, `${args.join(" ")}\n${result.stderr}`);
  }

  result = await run(["corpus", "validate", "--corpus-context", "global"], { env: f.env });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).counts, { concepts: 1, errors: 0, warnings: 0 });
});

test("M5 global sensitive-data policy is independent and conservatively sticky", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(f.project);
  assert.equal((await initializeGlobal(f)).code, 0);
  assert.equal((await run([
    "corpus", "initialize", "--corpus-context", "project", "--project-root-path", f.project,
  ], { env: f.env })).code, 0);

  let result = await run([
    "policy", "global", "sensitive-data", "allow", "--corpus-context", "global",
  ], { env: f.env });
  assert.equal(result.code, 0, result.stderr);
  let status = JSON.parse(result.stdout);
  assert.equal(status.knowledgeMode, "unguarded");
  assert.equal(status.previouslyUnguarded, true);
  const settings = path.join(f.state, "settings.json");
  assert.equal((await fs.stat(settings)).mode & 0o777, 0o600);

  result = await run([
    "policy", "global", "sensitive-data", "deny", "--corpus-context", "global",
  ], { env: f.env });
  assert.equal(result.code, 0, result.stderr);
  status = JSON.parse(result.stdout);
  assert.equal(status.knowledgeMode, "guarded");
  assert.equal(status.previouslyUnguarded, true);

  result = await run([
    "policy", "project", "sensitive-data", "status", "--corpus-context", "project",
    "--project-root-path", f.project,
  ], { env: f.env });
  assert.equal(result.code, 0, result.stderr);
  status = JSON.parse(result.stdout);
  assert.equal(status.knowledgeMode, "guarded");
  assert.equal(status.previouslyUnguarded, false);

  result = await run([
    "policy", "global", "sensitive-data", "status", "--corpus-context", "project",
    "--project-root-path", f.project,
  ], { env: f.env });
  assert.equal(result.code, 2);
  assert.match(JSON.parse(result.stderr).message, /requires --corpus-context global/);

  const invalid = "{ invalid settings\n";
  await fs.writeFile(settings, invalid);
  result = await run([
    "policy", "global", "sensitive-data", "status", "--corpus-context", "global",
  ], { env: f.env });
  assert.equal(result.code, 0, result.stderr);
  status = JSON.parse(result.stdout);
  assert.equal(status.valid, false);
  assert.equal(status.knowledgeMode, "guarded");
  assert.equal(status.previouslyUnguarded, "unknown");
  result = await run([
    "policy", "global", "sensitive-data", "allow", "--corpus-context", "global",
  ], { env: f.env });
  assert.equal(result.code, 4);
  assert.equal(await fs.readFile(settings, "utf8"), invalid);
});

test("M5 N-capable search keeps contexts distinct, bounded, explicit, and fail-closed", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(f.project);
  assert.equal((await initializeGlobal(f)).code, 0);
  assert.equal((await run([
    "corpus", "initialize", "--corpus-context", "project", "--project-root-path", f.project,
  ], { env: f.env })).code, 0);

  const globalDraft = await writeDraft(
    f.root,
    "global-database",
    memoryDraft("Global database preference", "The user generally prefers SQLite."),
  );
  const projectDraft = await writeDraft(
    f.root,
    "project-database",
    memoryDraft("Project database", "This project specifically uses PostgreSQL."),
  );
  assert.equal((await writeGlobal(f, "memories/database", globalDraft)).code, 0);
  assert.equal((await run([
    "concepts", "write", "--corpus-context", "project", "--project-root-path", f.project,
    "--concept-id", "memories/database", "--document-file-path", projectDraft,
  ], { env: f.env })).code, 0);

  let result = await run([
    "concepts", "search", "--corpus-context", "project", "--corpus-context", "global",
    "--project-root-path", f.project, "--query", "database", "--result-limit", "10",
  ], { env: f.env });
  assert.equal(result.code, 0, result.stderr);
  let output = JSON.parse(result.stdout);
  assert.deepEqual(output.corpusContexts, ["project", "global"]);
  assert.deepEqual(output.results.map((item) => [item.corpusContext, item.id]), [
    ["project", "memories/database"],
    ["global", "memories/database"],
  ]);

  result = await run([
    "concepts", "search", "--corpus-context", "project", "--corpus-context", "global",
    "--project-root-path", f.project, "--query", "database", "--result-limit", "1",
  ], { env: f.env });
  assert.equal(result.code, 0, result.stderr);
  output = JSON.parse(result.stdout);
  assert.equal(output.results.length, 1);
  assert.equal(output.results[0].corpusContext, "project");

  result = await run([
    "concepts", "search", "--corpus-context", "global", "--corpus-context", "global", "--query", "database",
  ], { env: f.env });
  assert.equal(result.code, 2);
  assert.match(JSON.parse(result.stderr).message, /contexts must be unique/i);

  const missing = await fixture(t, "engram missing global ");
  await fs.mkdir(missing.project);
  assert.equal((await run([
    "corpus", "initialize", "--corpus-context", "project", "--project-root-path", missing.project,
  ], { env: missing.env })).code, 0);
  result = await run([
    "concepts", "search", "--corpus-context", "project", "--corpus-context", "global",
    "--project-root-path", missing.project, "--query", "anything",
  ], { env: missing.env });
  assert.equal(result.code, 3);
  assert.match(JSON.parse(result.stderr).message, /not initialized/i);
  assert.match(JSON.parse(result.stderr).message, /\/engram @G init/);
});

test("M5 global conditional writes share one lock and preserve index closure", async (t) => {
  const f = await fixture(t, "engram global concurrent writes ");
  assert.equal((await initializeGlobal(f)).code, 0);
  const drafts = await Promise.all([
    writeDraft(f.root, "one", memoryDraft("First preference", "The user prefers the first option.")),
    writeDraft(f.root, "two", memoryDraft("Second preference", "The user prefers the second option.")),
  ]);
  const writes = await Promise.all([
    writeGlobal(f, "memories/first", drafts[0]),
    writeGlobal(f, "memories/second", drafts[1]),
  ]);
  for (const result of writes) assert.equal(result.code, 0, result.stderr);
  const validation = await run(["corpus", "validate", "--corpus-context", "global"], { env: f.env });
  assert.equal(validation.code, 0, validation.stderr);
  assert.deepEqual(JSON.parse(validation.stdout).counts, { concepts: 2, errors: 0, warnings: 0 });
  const index = await fs.readFile(path.join(f.bundle, "memories", "index.md"), "utf8");
  assert.match(index, /First preference/);
  assert.match(index, /Second preference/);
});

test("M5 rejects invalid adopted global content and concurrent initialization converges", async (t) => {
  const f = await fixture(t);
  const results = await Promise.all(Array.from({ length: 4 }, () => initializeGlobal(f)));
  for (const result of results) assert.equal(result.code, 0, result.stderr);
  assert.equal(results.filter((result) => JSON.parse(result.stdout).created).length, 1);
  assert.equal(results.filter((result) => JSON.parse(result.stdout).readmeCreated).length, 1);

  await fs.writeFile(
    path.join(f.bundle, "invalid.md"),
    "---\ntype: Note\ntitle: Invalid\ndescription: Invalid global type.\n---\n# Invalid\n\nBody.\n",
  );
  let result = await run(["corpus", "validate", "--corpus-context", "global"], { env: f.env });
  assert.equal(result.code, 4, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.ok(report.issues.some((issue) => issue.code === "global-memory-type" && issue.severity === "error"));
  result = await run([
    "concepts", "search", "--corpus-context", "global", "--query", "invalid",
  ], { env: f.env });
  assert.equal(result.code, 4);
  assert.match(JSON.parse(result.stderr).message, /memory-only profile/);

  result = await initializeGlobal(f);
  assert.equal(result.code, 4);
  assert.match(JSON.parse(result.stderr).message, /invalid existing bundle/i);
});
