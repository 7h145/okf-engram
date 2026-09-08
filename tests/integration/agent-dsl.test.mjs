import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const helper = path.join(repository, "scripts", "engram.mjs");

function run(args, { cwd = repository } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [helper, ...args], { cwd });
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

const parseError = (result) => JSON.parse(result.stderr);

async function temporaryProject(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "engram agent dsl "));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

const projectCorpus = (root) => ["--corpus-context", "project", "--project-root-path", root];

test("agent help defines every domain and distinguishes semantic workflows from helper operations", async () => {
  const result = await run(["--help"]);
  assert.equal(result.code, 0, result.stderr);
  for (const definition of [
    "Corpus —",
    "Knowledge —",
    "Memory —",
    "Concepts —",
    "Sources —",
    "Jobs —",
    "Job results —",
    "Policy —",
    "Wiring —",
  ])
    assert.match(result.stdout, new RegExp(definition));
  assert.match(result.stdout, /\[S\] knowledge ingest/);
  assert.match(result.stdout, /\[S\] memory remember/);
  assert.match(result.stdout, /\[D\] concepts write/);
  assert.match(result.stdout, /--corpus-context project\|global/);
  assert.doesNotMatch(result.stdout, / \| /);
  assert.match(result.stdout, /unsupported context combinations are rejected/);
  assert.doesNotMatch(result.stdout, /\b(?:put|flush|check-sources|capture-source)\b/);
  assert.doesNotMatch(result.stdout, /--(?:from|to|if-match|yes|json)(?:\s|$)/m);
});

test("human help is bounded, strict, and contains no destructive shortcut", async () => {
  const result = await run(["help"]);
  const noArguments = await run([]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(noArguments.stdout, result.stdout);
  assert.ok(Buffer.byteLength(result.stdout) < 1_024);
  assert.match(result.stdout, /\/engram wire\|unwire/);
  assert.match(result.stdout, /\/engram auto status\|on\|off/);
  assert.doesNotMatch(result.stdout, / \| /);
  assert.match(result.stdout, /\/engram remember STATEMENT/);
  assert.match(result.stdout, /\/engram jobs \[JOB_ID\]/);
  assert.match(result.stdout, /queue artifact for async ingest/);
  assert.match(result.stdout, /Commands are strict/);
  assert.doesNotMatch(result.stdout, /\b(?:delete|forget|remove concept)\b/i);
});

test("Pi prompt and skill define one strict human router without destructive shortcuts", async () => {
  const prompt = await fs.readFile(path.join(repository, "prompts", "engram.md"), "utf8");
  const skill = await fs.readFile(path.join(repository, "SKILL.md"), "utf8");
  for (const shortcut of [
    "help",
    "init",
    "wire",
    "unwire",
    "auto",
    "ls",
    "find",
    "show",
    "remember",
    "recall",
    "ingest",
    "queue",
    "jobs",
    "cancel",
  ])
    assert.match(prompt, new RegExp(`\\b${shortcut}\\b`));
  assert.match(prompt, /strict `\/engram`/);
  assert.match(prompt, /Engram request: \$ARGUMENTS/);
  assert.doesNotMatch(prompt, /\$\{ARGUMENTS\}/);
  assert.doesNotMatch(prompt, /\b(?:forget|delete)\b/);
  assert.match(skill, /\| `queue FILE\.\.\.` \| `jobs enqueue artifact-ingest/);
  assert.match(skill, /There is no destructive human\s+shortcut/);
  assert.match(skill, /Reject an unknown slash command with concise help/);
});

test("obsolete pre-stability command forms are rejected rather than retained as aliases", async () => {
  const removedCommands = [
    ["init"],
    ["where"],
    ["status"],
    ["auto-memory", "status"],
    ["auto", "status"],
    ["list"],
    ["search", "term"],
    ["get", "concept"],
    ["put", "concept"],
    ["digest", "project:a"],
    ["capture-source", "project:a"],
    ["resolve-source", "concept", "source"],
    ["check-sources"],
    ["enqueue", "ingest"],
    ["jobs"],
    ["cancel", "job-example"],
    ["retry", "job-example"],
    ["flush"],
    ["lint"],
    ["reindex"],
    ["deprecate", "concept"],
    ["delete", "concept"],
  ];
  for (const command of removedCommands) {
    const result = await run(command);
    assert.equal(result.code, 2, `${command.join(" ")}\n${result.stderr}`);
    assert.equal(parseError(result).error, "USAGE");
  }
});

test("canonical operations require an explicit supported corpus context and never fall back", async (t) => {
  const root = await temporaryProject(t);

  let result = await run(["corpus", "locate", "--project-root-path", root]);
  assert.equal(result.code, 2);
  assert.match(parseError(result).message, /Exactly one --corpus-context/);

  result = await run(["corpus", "locate", "--corpus-context", "global", "--project-root-path", root]);
  assert.equal(result.code, 2);
  assert.match(parseError(result).message, /Global corpus context is not available/);

  result = await run([
    "corpus",
    "locate",
    "--corpus-context",
    "project",
    "--corpus-context",
    "global",
    "--project-root-path",
    root,
  ]);
  assert.equal(result.code, 2);
  assert.match(parseError(result).message, /Exactly one --corpus-context/);

  const expectedBundle = path.join(root, ".agents", "data", "okf-engram", "bundle");
  await fs.mkdir(expectedBundle, { recursive: true });
  result = await run([
    "corpus",
    "locate",
    "--corpus-context",
    "project",
    "--corpus-bundle-path",
    expectedBundle,
    "--project-root-path",
    root,
  ]);
  assert.equal(result.code, 2);
  assert.match(parseError(result).message, /mutually exclusive/);
});

test("canonical helper output defaults to contextual JSON with explicit text as an opt-in", async (t) => {
  const root = await temporaryProject(t);
  let result = await run(["corpus", "initialize", ...projectCorpus(root)]);
  assert.equal(result.code, 0, result.stderr);
  const initialized = JSON.parse(result.stdout);
  assert.equal(initialized.corpusContext, "project");
  assert.equal(initialized.created, true);

  result = await run(["corpus", "locate", ...projectCorpus(root), "--output-format", "text"]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^Corpus context: project/m);
  assert.match(result.stdout, /^Bundle:/m);

  result = await run(["corpus", "status", ...projectCorpus(root), "--output-format", "yaml"]);
  assert.equal(result.code, 2);
  assert.match(parseError(result).message, /json or text/);
});

test("semantic DSL operations validate typed grammar but require the active skill", async () => {
  let result = await run([
    "memory",
    "remember",
    "--corpus-context",
    "global",
    "--memory-statement",
    "Prefer PostgreSQL for production systems.",
  ]);
  assert.equal(result.code, 2);
  assert.match(parseError(result).message, /semantic skill operation/);

  result = await run([
    "memory",
    "recall",
    "--corpus-context",
    "project",
    "--corpus-context",
    "global",
    "--recall-question",
    "Which database conventions apply?",
  ]);
  assert.equal(result.code, 2);
  assert.match(parseError(result).message, /semantic skill operation/);

  result = await run(["knowledge", "ingest", "--corpus-context", "project", "--source-resource", "project:README.md"]);
  assert.equal(result.code, 2);
  assert.match(parseError(result).message, /semantic skill operation/);

  result = await run([
    "memory",
    "recall",
    "--corpus-context",
    "project",
    "--corpus-context",
    "project",
    "--recall-question",
    "Duplicate contexts?",
  ]);
  assert.equal(result.code, 2);
  assert.match(parseError(result).message, /must be unique/);
});

test("typed options reject missing values, duplicates, positional identifiers, and old option names", async (t) => {
  const root = await temporaryProject(t);
  await run(["corpus", "initialize", ...projectCorpus(root)]);

  const invalidCommands = [
    ["concepts", "read", "concept-id", ...projectCorpus(root)],
    ["concepts", "read", "--concept-id", ...projectCorpus(root)],
    ["concepts", "read", "--concept-id", "one", "--concept-id", "two", ...projectCorpus(root)],
    ["concepts", "search", "--query", "term", "--limit", "2", ...projectCorpus(root)],
    ["concepts", "write", "--concept-id", "one", "--from", "draft.md", ...projectCorpus(root)],
    ["jobs", "show", "--job", "job-example", ...projectCorpus(root)],
  ];
  for (const command of invalidCommands) {
    const result = await run(command);
    assert.equal(result.code, 2, `${command.join(" ")}\n${result.stderr}`);
    assert.equal(parseError(result).error, "USAGE");
  }
});

test("destructive canonical operations use command-specific confirmation errors", async (t) => {
  const root = await temporaryProject(t);
  await run(["corpus", "initialize", ...projectCorpus(root)]);

  let result = await run([
    "concepts",
    "delete",
    "--concept-id",
    "memories/example",
    "--expected-current-sha256",
    "0".repeat(64),
    ...projectCorpus(root),
  ]);
  assert.equal(result.code, 8);
  assert.match(parseError(result).message, /--confirm-current-tree-deletion/);

  result = await run(["jobs", "run-all-queued", ...projectCorpus(root)]);
  assert.equal(result.code, 8);
  assert.match(parseError(result).message, /--confirm-run-all-queued/);

  result = await run(["jobs", "discard-invalid", "--job-id", "job-abcdefgh-0123456789ab", ...projectCorpus(root)]);
  assert.equal(result.code, 8);
  assert.match(parseError(result).message, /--confirm-invalid-job-deletion/);
});
