import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cli = path.join(repo, "scripts", "engram.mjs");

function run(args, { cwd = repo, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd,
      env: { ...process.env, ...env },
    });
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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "engram jobs Ω "));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "docs"));
  await fs.writeFile(path.join(root, "docs", "decision.md"), "# Queue decision\n\nUse bounded workers.\n");
  const initialized = await run(["corpus", "initialize", "--corpus-context", "project", "--project-root-path", root]);
  assert.equal(initialized.code, 0, initialized.stderr);
  return root;
}

async function fakePi(t, source) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "engram fake pi "));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const executable = path.join(directory, "pi");
  await fs.writeFile(executable, `#!/usr/bin/env node\n${source}\n`, { mode: 0o755 });
  return { directory, env: { PATH: `${directory}${path.delimiter}${process.env.PATH}` } };
}

const parse = (result) => JSON.parse(result.stdout);
const hash = (value) => `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;

function rehashCapsule(capsule) {
  const requestIdentity =
    capsule.kind === "inferred-memory"
      ? {
          kind: capsule.kind,
          corpus: capsule.corpus,
          request: capsule.request,
          policy: capsule.policy,
          worker: capsule.worker,
          limits: capsule.limits,
        }
      : {
          kind: capsule.kind,
          corpus: capsule.corpus,
          request: capsule.request,
          worker: capsule.worker,
          limits: capsule.limits,
        };
  capsule.requestHash = hash(requestIdentity);
  const immutable = { ...capsule };
  delete immutable.version;
  delete immutable.jobId;
  delete immutable.createdAt;
  delete immutable.inputHash;
  capsule.inputHash = hash(immutable);
  return capsule;
}

const successWorker = String.raw`
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const cp = require("node:child_process");
const prompt = process.argv[process.argv.indexOf("-p") + 1];
const capsule = JSON.parse(prompt.match(/<engram-job-capsule>\n([\s\S]*?)\n<\/engram-job-capsule>/)[1]);
const reportPath = prompt.match(/<engram-worker-report-path>\n([\s\S]*?)\n<\/engram-worker-report-path>/)[1];
const draft = path.join(os.tmpdir(), "engram-worker-draft-" + capsule.jobId + ".md");
const source = capsule.request.resources[0];
fs.writeFileSync(draft, [
  "---", "type: Decision", "title: Background queue decision",
  "description: The project uses bounded background workers.", "status: stable", "sources:",
  "  - id: queued-source", "    resource: " + source.resource, "    digest: " + source.digest,
  "---", "# Background queue decision", "", "The project uses bounded background workers.[^queued-source]",
  "", "[^queued-source]: Queued decision source.", "",
].join("\n"));
const writeResult = cp.execFileSync(process.execPath, [process.env.OKF_ENGRAM_HELPER,
  "concepts", "write", "--concept-id", "decisions/background-queue",
  "--document-file-path", draft, "--corpus-context", "project",
  "--project-root-path", capsule.corpus.projectRootPath,
], { encoding: "utf8" });
const result = JSON.parse(writeResult);
fs.writeFileSync(reportPath, JSON.stringify({
  version: 1, jobId: capsule.jobId,
  coverage: capsule.request.resources.map((item) => ({ resource: item.resource, status: "cited", conceptIds: ["decisions/background-queue"] })),
  outcomes: [{ id: "decisions/background-queue", status: "created", hash: result.hash }], warnings: [],
}) + "\n", { mode: 0o600, flag: "wx" });
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "SECRET_WORKER_TRACE" }] } }));
`;

const sleepingWorker = String.raw`
console.log(JSON.stringify({ type: "agent_start" }));
setInterval(() => {}, 1000);
`;

const reportOnlyWorker = String.raw`
const fs = require("node:fs");
const prompt = process.argv[process.argv.indexOf("-p") + 1];
const capsule = JSON.parse(prompt.match(/<engram-job-capsule>\n([\s\S]*?)\n<\/engram-job-capsule>/)[1]);
const reportPath = prompt.match(/<engram-worker-report-path>\n([\s\S]*?)\n<\/engram-worker-report-path>/)[1];
fs.appendFileSync(process.env.WORKER_INVOCATIONS, capsule.jobId + "\n");
setTimeout(() => {
  fs.writeFileSync(reportPath, JSON.stringify({
    version: 1, jobId: capsule.jobId,
    coverage: capsule.request.resources.map((item) => ({
      resource: item.resource, status: "excluded", conceptIds: [], note: "No durable knowledge selected.",
    })),
    outcomes: [], warnings: [],
  }) + "\n", { mode: 0o600, flag: "wx" });
}, 1000);
`;

const missingProvenanceWorker = String.raw`
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const cp = require("node:child_process");
const prompt = process.argv[process.argv.indexOf("-p") + 1];
const capsule = JSON.parse(prompt.match(/<engram-job-capsule>\n([\s\S]*?)\n<\/engram-job-capsule>/)[1]);
const reportPath = prompt.match(/<engram-worker-report-path>\n([\s\S]*?)\n<\/engram-worker-report-path>/)[1];
const id = "decisions/missing-provenance";
const draft = path.join(os.tmpdir(), "engram-missing-provenance-" + capsule.jobId + ".md");
fs.writeFileSync(draft, [
  "---", "type: Decision", "title: Missing provenance", "description: Structurally valid but uncited.", "status: stable", "---",
  "# Missing provenance", "", "This claim has no frontmatter source entry.", "",
].join("\n"));
const writeResult = JSON.parse(cp.execFileSync(process.execPath, [
  process.env.OKF_ENGRAM_HELPER, "concepts", "write", "--concept-id", id,
  "--document-file-path", draft, "--corpus-context", "project",
  "--project-root-path", capsule.corpus.projectRootPath,
], { encoding: "utf8" }));
fs.writeFileSync(reportPath, JSON.stringify({
  version: 1, jobId: capsule.jobId,
  coverage: capsule.request.resources.map((item) => ({ resource: item.resource, status: "cited", conceptIds: [id] })),
  outcomes: [{ id, status: "created", hash: writeResult.hash }], warnings: [],
}) + "\n", { mode: 0o600, flag: "wx" });
`;

const malformedReportWorker = String.raw`
const fs = require("node:fs");
const prompt = process.argv[process.argv.indexOf("-p") + 1];
const reportPath = prompt.match(/<engram-worker-report-path>\n([\s\S]*?)\n<\/engram-worker-report-path>/)[1];
fs.writeFileSync(reportPath, "{malformed\n", { mode: 0o600, flag: "wx" });
`;

const overflowingWorker = String.raw`
process.stdout.write("x".repeat(10 * 1024 * 1024 + 4096));
setInterval(() => {}, 1000);
`;

const invalidBundleWorker = String.raw`
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const prompt = process.argv[process.argv.indexOf("-p") + 1];
const capsule = JSON.parse(prompt.match(/<engram-job-capsule>\n([\s\S]*?)\n<\/engram-job-capsule>/)[1]);
const reportPath = prompt.match(/<engram-worker-report-path>\n([\s\S]*?)\n<\/engram-worker-report-path>/)[1];
const id = "broken/direct-write";
const target = path.join(capsule.corpus.bundlePath, id + ".md");
fs.mkdirSync(path.dirname(target), { recursive: true });
const bytes = "---\ntitle: malformed without required type\n---\n# Broken\n";
fs.writeFileSync(target, bytes);
fs.writeFileSync(reportPath, JSON.stringify({
  version: 1, jobId: capsule.jobId,
  coverage: capsule.request.resources.map((item) => ({ resource: item.resource, status: "cited", conceptIds: [id] })),
  outcomes: [{ id, status: "created", hash: crypto.createHash("sha256").update(bytes).digest("hex") }], warnings: [],
}) + "\n", { mode: 0o600, flag: "wx" });
`;

const unguardedArtifactWorker = String.raw`
const fs = require("node:fs");
const prompt = process.argv[process.argv.indexOf("-p") + 1];
fs.writeFileSync(process.env.PROMPT_DUMP, prompt);
const capsule = JSON.parse(prompt.match(/<engram-job-capsule>\n([\s\S]*?)\n<\/engram-job-capsule>/)[1]);
const reportPath = prompt.match(/<engram-worker-report-path>\n([\s\S]*?)\n<\/engram-worker-report-path>/)[1];
fs.writeFileSync(reportPath, JSON.stringify({
  version: 1, jobId: capsule.jobId,
  coverage: capsule.request.resources.map((item) => ({ resource: item.resource, status: "excluded", conceptIds: [], note: "No durable knowledge in test fixture." })),
  outcomes: [], warnings: [],
}) + "\n", { mode: 0o600, flag: "wx" });
`;

const crashAfterWriteWorker = successWorker.replace(
  /fs\.writeFileSync\(reportPath,[\s\S]*?console\.log\(JSON\.stringify\(\{ type: "message_end"[\s\S]*?\}\)\);/,
  "process.exit(17);",
);

async function enqueue(root, extra = []) {
  const instruction = extra.includes("--ingest-instruction")
    ? []
    : ["--ingest-instruction", "Compile the durable queue decision."];
  return run([
    "jobs",
    "enqueue",
    "artifact-ingest",
    "--corpus-context",
    "project",
    "--source-resource",
    "project:docs/decision.md",
    ...instruction,
    "--project-root-path",
    root,
    ...extra,
  ]);
}

async function waitForState(root, jobId, expected, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await run([
      "jobs",
      "show",
      "--job-id",
      jobId,
      "--corpus-context",
      "project",
      "--project-root-path",
      root,
    ]);
    if (result.code === 0 && parse(result).job.state.state === expected) return parse(result).job;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for job ${jobId} to reach ${expected}`);
}

test("M3a enqueue writes a bounded private capsule outside the OKF bundle and deduplicates active input", async (t) => {
  const root = await project(t);
  const first = await enqueue(root, [
    "--worker-model-id",
    "openrouter/google/gemma-4-31b-it",
    "--worker-timeout-seconds",
    "120",
  ]);
  assert.equal(first.code, 0, first.stderr);
  const queued = parse(first);
  assert.equal(queued.state, "queued");
  assert.equal(queued.duplicate, false);
  assert.ok(!queued.jobDirectoryPath.startsWith(path.join(root, ".agents", "data", "okf-engram", "bundle") + path.sep));

  const capsulePath = path.join(queued.jobDirectoryPath, "capsule.json");
  const capsule = JSON.parse(await fs.readFile(capsulePath, "utf8"));
  assert.equal(capsule.version, 2);
  assert.equal(capsule.kind, "artifact-ingest");
  assert.equal(capsule.corpus.context, "project");
  assert.equal(capsule.corpus.projectRootPath, await fs.realpath(root));
  assert.equal(
    capsule.corpus.bundlePath,
    path.join(await fs.realpath(root), ".agents", "data", "okf-engram", "bundle"),
  );
  assert.match(capsule.request.resources[0].digest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(capsule.limits.maxEventBytes, 10 * 1024 * 1024);
  assert.equal(JSON.stringify(capsule).includes("Use bounded workers."), false);
  assert.equal((await fs.stat(queued.jobDirectoryPath)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(capsulePath)).mode & 0o777, 0o600);

  const duplicate = await enqueue(root, [
    "--worker-model-id",
    "openrouter/google/gemma-4-31b-it",
    "--worker-timeout-seconds",
    "120",
  ]);
  assert.equal(duplicate.code, 0, duplicate.stderr);
  assert.equal(parse(duplicate).duplicate, true);
  assert.equal(parse(duplicate).jobId, queued.jobId);

  const oversized = await enqueue(root, ["--ingest-instruction", "x".repeat(4_001)]);
  assert.equal(oversized.code, 4);

  const unsupported = await enqueue(root, ["--source-resource", "https://example.invalid/source"]);
  assert.equal(unsupported.code, 4);
  const unsupportedError = JSON.parse(unsupported.stderr);
  assert.match(unsupportedError.message, /project-contained/);
  assert.match(unsupportedError.message, /explicit external local file/);
  assert.doesNotMatch(unsupportedError.message, /bounded project: or file:/);
});

test("large artifact batches expose one running job and ordered waiting work under one queue runner", async (t) => {
  const root = await project(t);
  const resources = [];
  for (let index = 0; index < 17; index += 1) {
    const name = `batch-${String(index).padStart(2, "0")}.md`;
    await fs.writeFile(path.join(root, "docs", name), `# Batch source ${index}\n`);
    resources.push("--source-resource", `project:docs/${name}`);
  }
  const enqueued = await run([
    "jobs",
    "enqueue",
    "artifact-ingest-batch",
    "--corpus-context",
    "project",
    ...resources,
    "--ingest-instruction",
    "Compile the complete large batch.",
    "--project-root-path",
    root,
  ]);
  assert.equal(enqueued.code, 0, enqueued.stderr);
  const batch = parse(enqueued);
  assert.match(batch.batchId, /^batch-/);
  assert.equal(batch.sourceCount, 17);
  assert.equal(batch.jobCount, 2);
  assert.deepEqual(
    batch.jobs.map((job) => ({ part: job.part, total: job.total, sourceCount: job.sourceCount, state: job.state })),
    [
      { part: 1, total: 2, sourceCount: 16, state: "queued" },
      { part: 2, total: 2, sourceCount: 1, state: "queued" },
    ],
  );
  assert.deepEqual(batch.runnerCommand.slice(2, 5), ["jobs", "run-all-queued", "--confirm-run-all-queued"]);

  let listed = parse(
    await run(["jobs", "list", "--corpus-context", "project", "--project-root-path", root]),
  );
  assert.equal(listed.runner.state, "idle");
  assert.deepEqual(
    listed.jobs.map((job) => [job.displayState, job.queuePosition, job.batchPart, job.batchSize]),
    [
      ["waiting", 1, 1, 2],
      ["waiting", 2, 2, 2],
    ],
  );
  const textList = await run([
    "jobs",
    "list",
    "--corpus-context",
    "project",
    "--project-root-path",
    root,
    "--output-format",
    "text",
  ]);
  assert.match(textList.stdout, /Runner: idle/);
  assert.match(textList.stdout, new RegExp(`waiting\\t1\\t${batch.batchId}\\t1/2`));

  const fake = await fakePi(t, reportOnlyWorker);
  const invocations = path.join(root, "batch-worker-invocations.log");
  const draining = run(batch.runnerCommand.slice(2), {
    env: { ...fake.env, WORKER_INVOCATIONS: invocations },
  });
  await waitForState(root, batch.jobs[0].jobId, "running");
  listed = parse(await run(["jobs", "list", "--corpus-context", "project", "--project-root-path", root]));
  assert.deepEqual(
    listed.jobs.map((job) => [job.displayState, job.queuePosition]),
    [
      ["running", undefined],
      ["waiting", 1],
    ],
  );
  assert.equal(listed.runner.jobId, batch.jobs[0].jobId);

  const drained = await draining;
  assert.equal(drained.code, 0, drained.stderr);
  assert.deepEqual(
    parse(drained).processed.filter((job) => batch.jobs.some((item) => item.jobId === job.jobId)).map((job) => job.state),
    ["completed", "completed"],
  );
  assert.deepEqual((await fs.readFile(invocations, "utf8")).trim().split("\n"), batch.jobs.map((job) => job.jobId));
  listed = parse(await run(["jobs", "list", "--corpus-context", "project", "--project-root-path", root]));
  assert.deepEqual(listed.batches[0].states, { completed: 2 });

  const tooMany = [];
  for (let index = 0; index < 257; index += 1) {
    tooMany.push("--source-resource", `project:docs/too-many-${index}.md`);
  }
  const rejected = await run([
    "jobs",
    "enqueue",
    "artifact-ingest-batch",
    "--corpus-context",
    "project",
    ...tooMany,
    "--ingest-instruction",
    "Reject this oversized batch before reading sources.",
    "--project-root-path",
    root,
  ]);
  assert.equal(rejected.code, 4);
  assert.match(JSON.parse(rejected.stderr).message, /1 to 256 resources/);
});

test("the active queue runner discovers a batch enqueued while it is working", async (t) => {
  const root = await project(t);
  const first = parse(await enqueue(root));
  const fake = await fakePi(t, reportOnlyWorker);
  const invocations = path.join(root, "dynamic-batch-worker-invocations.log");
  const draining = run(
    ["jobs", "run-all-queued", "--confirm-run-all-queued", "--corpus-context", "project", "--project-root-path", root],
    { env: { ...fake.env, WORKER_INVOCATIONS: invocations } },
  );
  await waitForState(root, first.jobId, "running");

  await fs.writeFile(path.join(root, "docs", "later.md"), "# Later queue work\n");
  const later = await run([
    "jobs",
    "enqueue",
    "artifact-ingest-batch",
    "--corpus-context",
    "project",
    "--source-resource",
    "project:docs/later.md",
    "--ingest-instruction",
    "Compile later queued work.",
    "--project-root-path",
    root,
  ]);
  assert.equal(later.code, 0, later.stderr);
  const laterBatch = parse(later);
  const laterJob = laterBatch.jobs[0];
  const coalescedRunner = run(laterBatch.runnerCommand.slice(2), {
    env: { ...fake.env, WORKER_INVOCATIONS: invocations },
  });

  const [drained, coalesced] = await Promise.all([draining, coalescedRunner]);
  assert.equal(drained.code, 0, drained.stderr);
  assert.equal(coalesced.code, 0, coalesced.stderr);
  assert.deepEqual((await fs.readFile(invocations, "utf8")).trim().split("\n"), [first.jobId, laterJob.jobId]);
  assert.equal((await waitForState(root, laterJob.jobId, "completed")).state.state, "completed");
});

test("M3a queued cancellation prevents execution and safe retry requeues unchanged input", async (t) => {
  const root = await project(t);
  const queued = parse(await enqueue(root));
  let result = await run([
    "jobs",
    "cancel",
    "--job-id",
    queued.jobId,
    "--corpus-context",
    "project",
    "--project-root-path",
    root,
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(parse(result).state, "cancelled");

  const fake = await fakePi(t, "require('node:fs').writeFileSync(process.env.SHOULD_NOT_RUN, 'ran')");
  const marker = path.join(root, "ran");
  result = await run(
    ["jobs", "run", "--job-id", queued.jobId, "--corpus-context", "project", "--project-root-path", root],
    {
      env: { ...fake.env, SHOULD_NOT_RUN: marker },
    },
  );
  assert.equal(result.code, 0, result.stderr);
  await assert.rejects(() => fs.access(marker), { code: "ENOENT" });

  result = await run([
    "jobs",
    "retry",
    "--job-id",
    queued.jobId,
    "--corpus-context",
    "project",
    "--project-root-path",
    root,
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(parse(result).state, "queued");
  assert.equal(parse(result).attempt, 2);
});

test("M3a job run executes one isolated Pi backend and exposes only compact verified results", async (t) => {
  const root = await project(t);
  const queued = parse(await enqueue(root));
  const fake = await fakePi(t, successWorker);
  const result = await run(
    ["jobs", "run", "--job-id", queued.jobId, "--corpus-context", "project", "--project-root-path", root],
    { env: fake.env },
  );
  assert.equal(result.code, 0, result.stderr);
  const flushed = parse(result);
  const inspected = parse(
    await run(["jobs", "show", "--job-id", queued.jobId, "--corpus-context", "project", "--project-root-path", root]),
  ).job;
  assert.equal(flushed.processed[0].state, "completed", JSON.stringify(inspected.result));
  assert.equal(result.stdout.includes("SECRET_WORKER_TRACE"), false);

  assert.equal(inspected.state.state, "completed");
  assert.equal(inspected.result.changes[0].id, "decisions/background-queue");
  assert.match(inspected.result.changes[0].hash, /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(inspected.result).includes("SECRET_WORKER_TRACE"), false);
  assert.match(await fs.readFile(path.join(queued.jobDirectoryPath, "events.jsonl"), "utf8"), /SECRET_WORKER_TRACE/);
  assert.equal((await fs.stat(path.join(queued.jobDirectoryPath, "worker-report.json"))).mode & 0o777, 0o600);
});

test("artifact workers receive the sensitive-data mode effective when execution begins", async (t) => {
  const root = await project(t);
  const queued = parse(await enqueue(root));
  let result = await run([
    "policy",
    "project",
    "sensitive-data",
    "allow",
    "--corpus-context",
    "project",
    "--project-root-path",
    root,
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(parse(result).knowledgeMode, "unguarded");

  const fake = await fakePi(t, unguardedArtifactWorker);
  const promptDump = path.join(root, "worker-prompt.txt");
  result = await run(
    ["jobs", "run", "--job-id", queued.jobId, "--corpus-context", "project", "--project-root-path", root],
    { env: { ...fake.env, PROMPT_DUMP: promptDump } },
  );
  assert.equal(result.code, 0, result.stderr);
  const processed = parse(result).processed[0];
  const workerStderr = await fs.readFile(path.join(queued.jobDirectoryPath, "stderr.log"), "utf8");
  const inspected = parse(
    await run(["jobs", "show", "--job-id", queued.jobId, "--corpus-context", "project", "--project-root-path", root]),
  ).job;
  assert.equal(processed.state, "completed", `${JSON.stringify(inspected.result)}\n${workerStderr}`);
  const prompt = await fs.readFile(promptDump, "utf8");
  assert.match(prompt, /Project knowledge mode is unguarded/);
  assert.match(prompt, /credentials, and secret values may be stored when relevant/);
});

test("multiple pre-enqueued artifact jobs run sequentially against the current corpus", async (t) => {
  const root = await project(t);
  const first = parse(await enqueue(root, ["--ingest-instruction", "Create the durable queue decision."]));
  const second = parse(
    await enqueue(root, ["--ingest-instruction", "Review the current corpus after earlier queued work."]),
  );
  assert.notEqual(first.jobId, second.jobId);

  const writer = await fakePi(t, successWorker);
  let result = await run(
    ["jobs", "run", "--job-id", first.jobId, "--corpus-context", "project", "--project-root-path", root],
    { env: writer.env },
  );
  assert.equal(result.code, 0, result.stderr);
  assert.equal(parse(result).processed[0].state, "completed");

  const reporter = await fakePi(t, reportOnlyWorker);
  const invocations = path.join(root, "sequential-worker-invocations.log");
  result = await run(
    ["jobs", "run", "--job-id", second.jobId, "--corpus-context", "project", "--project-root-path", root],
    { env: { ...reporter.env, WORKER_INVOCATIONS: invocations } },
  );
  assert.equal(result.code, 0, result.stderr);
  assert.equal(parse(result).processed[0].state, "completed");
  assert.equal((await fs.readFile(invocations, "utf8")).trim(), second.jobId);

  const inspected = parse(
    await run(["jobs", "show", "--job-id", second.jobId, "--corpus-context", "project", "--project-root-path", root]),
  ).job;
  assert.equal(inspected.result.changes.length, 0);
  assert.notEqual(inspected.state.beforeSnapshot.digest, inspected.capsule.bundleSnapshot.digest);
});

test("M3a source drift before execution becomes needs-review without invoking Pi", async (t) => {
  const root = await project(t);
  const queued = parse(await enqueue(root));
  await fs.writeFile(path.join(root, "docs", "decision.md"), "changed after enqueue\n");
  const fake = await fakePi(t, "require('node:fs').writeFileSync(process.env.SHOULD_NOT_RUN, 'ran')");
  const marker = path.join(root, "ran");
  const result = await run(
    ["jobs", "run", "--job-id", queued.jobId, "--corpus-context", "project", "--project-root-path", root],
    {
      env: { ...fake.env, SHOULD_NOT_RUN: marker },
    },
  );
  assert.equal(result.code, 0, result.stderr);
  assert.equal(parse(result).processed[0].state, "needs-review");
  assert.equal(parse(result).processed[0].reason, "source-drift");
  await assert.rejects(() => fs.access(marker), { code: "ENOENT" });
});

test("M3a running cancellation is acknowledged only after the worker exits", async (t) => {
  const root = await project(t);
  const queued = parse(await enqueue(root));
  const fake = await fakePi(t, sleepingWorker);
  const jobRun = run(
    ["jobs", "run", "--job-id", queued.jobId, "--corpus-context", "project", "--project-root-path", root],
    { env: fake.env },
  );
  await waitForState(root, queued.jobId, "running");

  let result = await run([
    "jobs",
    "cancel",
    "--job-id",
    queued.jobId,
    "--corpus-context",
    "project",
    "--project-root-path",
    root,
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(parse(result).state, "running");
  assert.equal(parse(result).cancellation, "requested");

  result = await jobRun;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(parse(result).processed[0].state, "cancelled");
  const terminal = await waitForState(root, queued.jobId, "cancelled");
  assert.ok(terminal.state.cancelledAt);
});

test("M3a a worker crash after persistence becomes needs-review and cannot be blindly retried", async (t) => {
  const root = await project(t);
  const queued = parse(await enqueue(root));
  const fake = await fakePi(t, crashAfterWriteWorker);
  let result = await run(
    ["jobs", "run", "--job-id", queued.jobId, "--corpus-context", "project", "--project-root-path", root],
    { env: fake.env },
  );
  assert.equal(result.code, 0, result.stderr);
  assert.equal(parse(result).processed[0].state, "needs-review");
  assert.equal(parse(result).processed[0].reason, "unreported-bundle-change");

  result = await run([
    "jobs",
    "retry",
    "--job-id",
    queued.jobId,
    "--corpus-context",
    "project",
    "--project-root-path",
    root,
  ]);
  assert.equal(result.code, 4);
  assert.match(result.stderr, /manual reconciliation/i);
  const readResult = await run([
    "concepts",
    "read",
    "--concept-id",
    "decisions/background-queue",
    "--corpus-context",
    "project",
    "--project-root-path",
    root,
  ]);
  assert.equal(readResult.code, 0, readResult.stderr);
  const duplicate = await enqueue(root);
  assert.equal(duplicate.code, 0, duplicate.stderr);
  assert.equal(parse(duplicate).jobId, queued.jobId);
  assert.equal(parse(duplicate).reviewRequired, true);
});

test("M3a concurrent job runs serialize one semantic worker per bundle", async (t) => {
  const root = await project(t);
  const queued = parse(await enqueue(root));
  const fake = await fakePi(t, reportOnlyWorker);
  const invocations = path.join(root, "worker-invocations.log");
  const env = { ...fake.env, WORKER_INVOCATIONS: invocations };
  const results = await Promise.all([
    run(["jobs", "run", "--job-id", queued.jobId, "--corpus-context", "project", "--project-root-path", root], { env }),
    run(["jobs", "run", "--job-id", queued.jobId, "--corpus-context", "project", "--project-root-path", root], { env }),
  ]);
  assert.deepEqual(
    results.map((item) => item.code).sort((a, b) => a - b),
    [0, 6],
  );
  assert.equal((await fs.readFile(invocations, "utf8")).trim().split("\n").length, 1);
  const terminal = await waitForState(root, queued.jobId, "completed");
  assert.equal(terminal.result.bundleValidation.valid, true);
});

test("M3a orphaned running state is recovered without replay", async (t) => {
  const root = await project(t);
  const queued = parse(await enqueue(root));
  const capsule = JSON.parse(await fs.readFile(path.join(queued.jobDirectoryPath, "capsule.json"), "utf8"));
  const statePath = path.join(queued.jobDirectoryPath, "state.json");
  const state = JSON.parse(await fs.readFile(statePath, "utf8"));
  await fs.writeFile(
    statePath,
    `${JSON.stringify(
      {
        ...state,
        state: "running",
        startedAt: new Date().toISOString(),
        heartbeatAt: new Date(0).toISOString(),
        beforeSnapshot: capsule.bundleSnapshot,
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  const fake = await fakePi(t, "require('node:fs').writeFileSync(process.env.SHOULD_NOT_RUN, 'ran')");
  const marker = path.join(root, "ran");
  const result = await run(
    ["jobs", "run", "--job-id", queued.jobId, "--corpus-context", "project", "--project-root-path", root],
    {
      env: { ...fake.env, SHOULD_NOT_RUN: marker },
    },
  );
  assert.equal(result.code, 0, result.stderr);
  assert.equal(parse(result).processed[0].state, "failed");
  assert.equal(parse(result).processed[0].reason, "worker-disappeared");
  await assert.rejects(() => fs.access(marker), { code: "ENOENT" });
});

test("M3a result-first persistence recovers terminal state without replay", async (t) => {
  const root = await project(t);
  const queued = parse(await enqueue(root));
  const statePath = path.join(queued.jobDirectoryPath, "state.json");
  const state = JSON.parse(await fs.readFile(statePath, "utf8"));
  const finishedAt = new Date().toISOString();
  await fs.writeFile(
    path.join(queued.jobDirectoryPath, "result.json"),
    `${JSON.stringify(
      {
        version: 2,
        jobId: queued.jobId,
        state: "completed",
        attempt: state.attempt,
        finishedAt,
        changes: [],
        coverage: [],
        warnings: [],
        reason: "already-persisted",
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  const fake = await fakePi(t, "require('node:fs').writeFileSync(process.env.SHOULD_NOT_RUN, 'ran')");
  const marker = path.join(root, "ran");
  const result = await run(
    ["jobs", "run", "--job-id", queued.jobId, "--corpus-context", "project", "--project-root-path", root],
    {
      env: { ...fake.env, SHOULD_NOT_RUN: marker },
    },
  );
  assert.equal(result.code, 0, result.stderr);
  assert.equal(parse(result).processed[0].state, "completed");
  assert.equal(parse(result).processed[0].recovered, true);
  await assert.rejects(() => fs.access(marker), { code: "ENOENT" });
  const inspected = parse(
    await run(["jobs", "show", "--job-id", queued.jobId, "--corpus-context", "project", "--project-root-path", root]),
  ).job;
  assert.equal(inspected.state.state, "completed");
  assert.ok(inspected.state.recoveredAt);
  assert.equal(inspected.result.reason, "already-persisted");
});

test("M3a completed requires deterministic bundle and generated-index closure", async (t) => {
  const root = await project(t);
  const queued = parse(await enqueue(root));
  const fake = await fakePi(t, invalidBundleWorker);
  const result = await run(
    ["jobs", "run", "--job-id", queued.jobId, "--corpus-context", "project", "--project-root-path", root],
    { env: fake.env },
  );
  assert.equal(result.code, 0, result.stderr);
  assert.equal(parse(result).processed[0].state, "needs-review");
  const inspected = parse(
    await run(["jobs", "show", "--job-id", queued.jobId, "--corpus-context", "project", "--project-root-path", root]),
  ).job;
  assert.equal(inspected.result.bundleValidation.valid, false);
  assert.match(inspected.result.review.problems.join("\n"), /bundle validation|index closure/i);
});

test("M3a cited coverage requires exact frontmatter provenance and source-ID footnotes", async (t) => {
  const root = await project(t);
  const queued = parse(await enqueue(root));
  const fake = await fakePi(t, missingProvenanceWorker);
  const result = await run(
    ["jobs", "run", "--job-id", queued.jobId, "--corpus-context", "project", "--project-root-path", root],
    { env: fake.env },
  );
  assert.equal(result.code, 0, result.stderr);
  assert.equal(parse(result).processed[0].state, "needs-review");
  const inspected = parse(
    await run(["jobs", "show", "--job-id", queued.jobId, "--corpus-context", "project", "--project-root-path", root]),
  ).job;
  assert.match(inspected.result.review.problems.join("\n"), /frontmatter provenance/i);
  assert.equal(inspected.result.bundleValidation.valid, true);
});

test("M3a malformed reports and oversized event streams fail within bounded private output", async (t) => {
  const root = await project(t);
  let queued = parse(await enqueue(root));
  let fake = await fakePi(t, malformedReportWorker);
  let result = await run(
    ["jobs", "run", "--job-id", queued.jobId, "--corpus-context", "project", "--project-root-path", root],
    { env: fake.env },
  );
  assert.equal(result.code, 0, result.stderr);
  assert.equal(parse(result).processed[0].state, "failed");
  assert.equal(parse(result).processed[0].reason, "invalid-worker-report");

  result = await enqueue(root, ["--ingest-instruction", "A distinct bounded-output test."]);
  assert.equal(result.code, 0, result.stderr);
  queued = parse(result);
  fake = await fakePi(t, overflowingWorker);
  result = await run(
    ["jobs", "run", "--job-id", queued.jobId, "--corpus-context", "project", "--project-root-path", root],
    { env: fake.env },
  );
  assert.equal(result.code, 0, result.stderr);
  assert.equal(parse(result).processed[0].state, "failed");
  assert.equal(parse(result).processed[0].reason, "worker-output-limit");
  assert.equal((await fs.stat(path.join(queued.jobDirectoryPath, "events.jsonl"))).size, 10 * 1024 * 1024);
});

test("M3a capsule event limits are bounded job input rather than today's default", async (t) => {
  const root = await project(t);
  const queued = parse(await enqueue(root));
  const capsulePath = path.join(queued.jobDirectoryPath, "capsule.json");
  const capsule = JSON.parse(await fs.readFile(capsulePath, "utf8"));
  capsule.limits.maxEventBytes = 1024 * 1024;
  await fs.writeFile(capsulePath, `${JSON.stringify(rehashCapsule(capsule), null, 2)}\n`, { mode: 0o600 });
  let result = await run([
    "jobs",
    "show",
    "--job-id",
    queued.jobId,
    "--corpus-context",
    "project",
    "--project-root-path",
    root,
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(parse(result).job.capsule.limits.maxEventBytes, 1024 * 1024);

  capsule.limits.maxEventBytes = 16 * 1024 * 1024 + 1;
  await fs.writeFile(capsulePath, `${JSON.stringify(rehashCapsule(capsule), null, 2)}\n`, { mode: 0o600 });
  result = await run([
    "jobs",
    "show",
    "--job-id",
    queued.jobId,
    "--corpus-context",
    "project",
    "--project-root-path",
    root,
  ]);
  assert.equal(result.code, 4);
  assert.match(result.stderr, /invalid capsule/i);
});

test("M3a enqueue rejects sources beyond the explicit hashing bound", async (t) => {
  const root = await project(t);
  const oversized = path.join(root, "docs", "oversized.bin");
  await fs.writeFile(oversized, "x");
  await fs.truncate(oversized, 64 * 1024 * 1024 + 1);
  const result = await run([
    "jobs",
    "enqueue",
    "artifact-ingest",
    "--corpus-context",
    "project",
    "--source-resource",
    "project:docs/oversized.bin",
    "--ingest-instruction",
    "Do not hash beyond the bound.",
    "--project-root-path",
    root,
  ]);
  assert.equal(result.code, 4);
  assert.match(result.stderr, /exceeds/i);
});

test("M3a terminal records are retained until explicit safe cleanup", async (t) => {
  const root = await project(t);
  const queued = parse(await enqueue(root));
  await fs.writeFile(path.join(root, "docs", "decision.md"), "drift requiring review\n");
  let result = await run([
    "jobs",
    "run",
    "--job-id",
    queued.jobId,
    "--corpus-context",
    "project",
    "--project-root-path",
    root,
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(parse(result).processed[0].state, "needs-review");

  result = await run([
    "jobs",
    "clean",
    "--job-id",
    queued.jobId,
    "--corpus-context",
    "project",
    "--confirm-job-state-deletion",
    "--project-root-path",
    root,
  ]);
  assert.equal(result.code, 8);
  assert.match(result.stderr, /needs review/i);
  assert.ok(await fs.stat(queued.jobDirectoryPath));

  result = await run([
    "jobs",
    "clean",
    "--job-id",
    queued.jobId,
    "--corpus-context",
    "project",
    "--confirm-job-state-deletion",
    "--confirm-reconciled",
    "--project-root-path",
    root,
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(parse(result).cleaned, true);
  await assert.rejects(() => fs.access(queued.jobDirectoryPath), { code: "ENOENT" });
});

test("M3a invalid-job discard removes malformed jobs but cannot bypass normal cleanup policy", async (t) => {
  const root = await project(t);
  let queued = parse(await enqueue(root));
  let result = await run([
    "jobs",
    "discard-invalid",
    "--job-id",
    queued.jobId,
    "--corpus-context",
    "project",
    "--confirm-invalid-job-deletion",
    "--project-root-path",
    root,
  ]);
  assert.equal(result.code, 4);
  assert.match(result.stderr, /valid.*use jobs clean/i);
  assert.ok(await fs.stat(queued.jobDirectoryPath));

  queued = parse(await enqueue(root, ["--ingest-instruction", "A malformed cleanup fixture."]));
  await fs.writeFile(path.join(queued.jobDirectoryPath, "capsule.json"), "{malformed\n", { mode: 0o600 });
  result = await run([
    "jobs",
    "discard-invalid",
    "--job-id",
    queued.jobId,
    "--corpus-context",
    "project",
    "--project-root-path",
    root,
  ]);
  assert.equal(result.code, 8);
  assert.ok(await fs.stat(queued.jobDirectoryPath));

  result = await run([
    "jobs",
    "discard-invalid",
    "--job-id",
    queued.jobId,
    "--corpus-context",
    "project",
    "--confirm-invalid-job-deletion",
    "--project-root-path",
    root,
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(parse(result), {
    corpusContext: "project",
    jobId: queued.jobId,
    cleaned: true,
    discardedInvalidJob: true,
  });
  await assert.rejects(() => fs.access(queued.jobDirectoryPath), { code: "ENOENT" });
});

test("M3a immutable capsules are integrity-checked and bound to their canonical project", async (t) => {
  const root = await project(t);
  const queued = parse(await enqueue(root));
  const capsulePath = path.join(queued.jobDirectoryPath, "capsule.json");
  const capsule = JSON.parse(await fs.readFile(capsulePath, "utf8"));
  capsule.corpus.projectRootPath = os.tmpdir();
  capsule.request.instruction = "tampered corpus context and task";
  await fs.writeFile(capsulePath, `${JSON.stringify(capsule, null, 2)}\n`, { mode: 0o600 });
  const fake = await fakePi(t, "require('node:fs').writeFileSync(process.env.SHOULD_NOT_RUN, 'ran')");
  const marker = path.join(root, "ran");
  const result = await run(
    ["jobs", "run", "--job-id", queued.jobId, "--corpus-context", "project", "--project-root-path", root],
    {
      env: { ...fake.env, SHOULD_NOT_RUN: marker },
    },
  );
  assert.equal(result.code, 4);
  assert.match(result.stderr, /invalid capsule|integrity/i);
  await assert.rejects(() => fs.access(marker), { code: "ENOENT" });
});

test("M3a malformed or symlinked job state is rejected without following it", async (t) => {
  const root = await project(t);
  const queued = parse(await enqueue(root));
  const outside = path.join(root, "outside.json");
  await fs.writeFile(outside, "not json\n");
  const statePath = path.join(queued.jobDirectoryPath, "state.json");
  await fs.rm(statePath);
  await fs.symlink(outside, statePath);
  let result = await run([
    "jobs",
    "show",
    "--job-id",
    queued.jobId,
    "--corpus-context",
    "project",
    "--project-root-path",
    root,
  ]);
  assert.equal(result.code, 9);
  result = await run([
    "jobs",
    "discard-invalid",
    "--job-id",
    queued.jobId,
    "--corpus-context",
    "project",
    "--confirm-invalid-job-deletion",
    "--project-root-path",
    root,
  ]);
  assert.equal(result.code, 9);
  assert.ok(await fs.lstat(statePath));
  assert.equal(await fs.readFile(outside, "utf8"), "not json\n");
});
