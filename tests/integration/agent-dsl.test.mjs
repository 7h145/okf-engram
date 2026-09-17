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
    "Adapter bridge —",
  ])
    assert.match(result.stdout, new RegExp(definition));
  assert.match(result.stdout, /\[S\] knowledge ingest/);
  assert.match(result.stdout, /\[S\] memory remember/);
  assert.match(result.stdout, /\[D\] concepts write/);
  assert.match(result.stdout, /\[D\] sources list/);
  assert.match(result.stdout, /\[D\] jobs enqueue artifact-ingest-batch/);
  assert.match(result.stdout, /\[D\] policy project sensitive-data status\|allow\|deny/);
  assert.match(result.stdout, /\[D\] policy global sensitive-data status\|allow\|deny/);
  assert.match(result.stdout, /\[D\] adapter bridge handshake\|project-policy-status/);
  assert.match(result.stdout, /The bridge is JSON-only and intrinsically project-targeted/);
  assert.match(result.stdout, /--corpus-context project\|global/);
  assert.match(result.stdout, /corpus links add/);
  assert.match(result.stdout, /--linked-corpus-name NAME/);
  assert.doesNotMatch(result.stdout, / \| /);
  assert.match(result.stdout, /unsupported context combinations are rejected/);
  assert.doesNotMatch(result.stdout, /\b(?:put|flush|check-sources|capture-source)\b/);
  assert.doesNotMatch(result.stdout, /--(?:from|to|if-match|yes|json)(?:\s|$)/m);
});

test("human help is bounded and exposes only a guarded destructive shortcut", async () => {
  const result = await run(["help"]);
  const noArguments = await run([]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(noArguments.stdout, result.stdout);
  assert.ok(Buffer.byteLength(result.stdout) < 2_048);
  assert.match(result.stdout, /\/engram wire\|unwire/);
  assert.match(result.stdout, /\/engram auto status\|on\|off/);
  assert.match(result.stdout, /\/engram \[@P\|@G\] mode status\|guarded\|unguarded/);
  assert.doesNotMatch(result.stdout, / \| /);
  assert.match(result.stdout, /Agent-maintained knowledge bases for durable project knowledge and explicit memories\./);
  assert.match(result.stdout, /@P or @project/);
  assert.match(result.stdout, /@G or @global/);
  assert.match(result.stdout, /@L or @linked/);
  assert.match(result.stdout, /@A or @all/);
  assert.match(result.stdout, /\/engram @P @docs recall QUESTION/);
  assert.match(result.stdout, /\/engram @G remember STATEMENT/);
  assert.match(result.stdout, /\/engram links — list link status and privacy mode/);
  assert.match(result.stdout, /\/engram link NAME PATH/);
  assert.match(result.stdout, /\/engram unlink NAME/);
  assert.match(result.stdout, /\/engram sources — list referenced project files/);
  assert.match(result.stdout, /\/engram inventory — inspect project source references/);
  assert.match(result.stdout, /\/engram remember STATEMENT/);
  assert.match(result.stdout, /\/engram \[@ADDRESS \.\.\.\] ls — list concepts/);
  assert.match(result.stdout, /\/engram jobs \[JOB_ID\]/);
  assert.match(result.stdout, /\/engram \[@P\|@G\] remove CONCEPT_ID — delete after confirmation/);
  assert.match(result.stdout, /Common work:/);
  assert.match(result.stdout, /Further actions:/);
  assert.match(result.stdout, /Setup and policy:/);
  assert.ok(result.stdout.indexOf("Common work:") < result.stdout.indexOf("Further actions:"));
  assert.ok(result.stdout.indexOf("Further actions:") < result.stdout.indexOf("Setup and policy:"));
  assert.ok(result.stdout.indexOf("/engram queue FILE...") < result.stdout.indexOf("Links:"));
  assert.ok(result.stdout.indexOf("/engram queue FILE...") < result.stdout.indexOf("/engram ingest FILE..."));
  assert.ok(result.stdout.indexOf("/engram inventory") < result.stdout.indexOf("/engram jobs"));
  assert.match(result.stdout, /ingest project data asynchronously/);
  assert.match(result.stdout, /ingest project data in the foreground/);
  assert.match(result.stdout, /show CONCEPT_ID — show one unambiguous concept/);
  assert.match(result.stdout, /\/engram \[@P\|@G\] init/);
  assert.match(result.stdout, /Commands are strict/);
  assert.match(result.stdout, /See \/engram --help for the complete agent interface\./);
  assert.doesNotMatch(result.stdout, /\bforget\b/i);
});

test("Pi prompt keeps only a proven pre-activation guard over portable routing", async () => {
  const prompt = await fs.readFile(path.join(repository, "prompts", "engram.md"), "utf8");
  const skill = await fs.readFile(path.join(repository, "SKILL.md"), "utf8");
  assert.ok(Buffer.byteLength(prompt) < 896, "Pi prompt must remain a thin adapter");
  assert.match(prompt, /argument-hint: "\[request\]"/);
  assert.match(prompt, /Before skill activation or tools/);
  assert.match(prompt, /exact short built-ins are `@P`, `@G`, `@L`, and `@A`/);
  assert.match(prompt, /long built-ins\s+are `@project`, `@global`, `@linked`, and `@all`/);
  assert.match(prompt, /`@A`\/`@all` must be the only address/);
  assert.match(prompt, /reject obsolete leading `global` or `both` forms/);
  assert.match(prompt, /Respond only:\s+`Unsupported \/engram route; no action was taken\. See \/engram help\.`/);
  assert.match(prompt, /Otherwise activate and follow `okf-engram`/i);
  assert.match(prompt, /apply its \*\*Strict request preflight\*\*\s+and routing table/i);
  assert.match(prompt, /`SKILL\.md` is normative; this repeats only the thin Pi guard/);
  assert.match(prompt, /Engram request:\s+\$ARGUMENTS/);
  assert.doesNotMatch(prompt, /\$\{ARGUMENTS\}/);
  assert.doesNotMatch(prompt, /concepts search|corpus status|project-only|current project working directory|user purpose/);
  assert.ok(skill.indexOf("## Strict request preflight") < skill.indexOf("## Command layers"));
  assert.match(skill, /\| Human request \| Canonical intent \| User purpose \|/);
  assert.match(skill, /\| `queue FILE\.\.\.` \| `jobs enqueue artifact-ingest-batch/);
  assert.match(skill, /\| `\[@P\\\|@G\] mode status\\\|guarded\\\|unguarded` \| selected `policy/);
  assert.match(skill, /`sources` is the project data-file analogue of `ls`/);
  assert.match(skill, /Repeated addresses form an explicit read set|repeated addresses form an explicit read set/i);
  assert.match(skill, /Every linked operation is read-only/);
  assert.match(skill, /The bridge is intrinsically project-targeted/);
  assert.match(skill, /Loading or discovering the bridge is not consent/);
  assert.match(skill, /background-else-foreground/);
  assert.match(skill, /Unguarded mode relaxes only the sensitivity filter/);
  assert.match(skill, /Previously unguarded: yes — stored knowledge may still contain sensitive data/);
  assert.match(skill, /render the policy\s+line exactly as `Automatic memory: unavailable`, with no appended explanation/);
  assert.match(skill, /Launch the single returned `runnerCommand`/);
  assert.match(skill, /Never launch one runner per partition/);
  assert.match(skill, /A raw `tmux` executable alone is not a managed\s+runner/);
  assert.match(skill, /do not sleep,\s+read runner logs, or inspect jobs after launch/);
  assert.match(skill, /preserve the agent\s+client's current project working directory/);
  assert.match(skill, /never invoke them as helper commands/);
  assert.match(skill, /top-level frontmatter fields—never a nested `concept` object/);
  assert.match(skill, /\| `sources` \| `sources list --corpus-context project` \|/);
  assert.match(skill, /\| `inventory` \| `sources inventory --corpus-context project` \|/);
  assert.match(skill, /\| `\[@P\\\|@G\] remove CONCEPT_ID` \| guided selected `concepts delete/);
  assert.match(skill, /\| `\[ADDR\.\.\.\] ls` \| composed `concepts list` \|/);
  assert.match(skill, /\| `\[@P\\\|@G\] remember STATEMENT` \| selected `memory remember/);
  assert.match(skill, /\| `link NAME PATH` \| `corpus links add/);
  assert.match(skill, /classify its complete\s+argument string against the routing table below before making any tool call/);
  assert.match(skill, /matching prefix is not a route/);
  assert.match(skill, /`@all`\/`@A` must be the only address/);
  assert.match(skill, /Do not\s+read or write a corpus, enqueue a job/);
  assert.match(skill, /Respond only:\s+`Unsupported \/engram route; no action was taken\. See \/engram help\.`/);
  assert.match(skill, /never silently continue with another corpus/);
  assert.match(skill, /mandatory two-turn\s+confirmation/);
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
  assert.match(parseError(result).message, /At least one corpus context or linked corpus name/);

  result = await run(["corpus", "locate", "--corpus-context", "global", "--project-root-path", root]);
  assert.equal(result.code, 2);
  assert.match(parseError(result).message, /does not accept --project-root-path/);

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
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).corpora.map((item) => item.corpusContext), ["project", "global"]);

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
