import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cli = path.join(repo, "scripts", "engram.mjs");

function run(args, { cwd = repo, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd, env: { ...process.env, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function project(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "engram jobs Ω "));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "docs"));
  await fs.writeFile(path.join(root, "docs", "decision.md"), "# Queue decision\n\nUse bounded workers.\n");
  const initialized = await run(["init", "--project-root", root, "--json"]);
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
const put = cp.execFileSync(process.execPath, [process.env.OKF_ENGRAM_HELPER, "put", "decisions/background-queue", "--from", draft, "--project-root", capsule.scope.projectRoot, "--json"], { encoding: "utf8" });
const result = JSON.parse(put);
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

const crashAfterWriteWorker = successWorker.replace(
  /fs\.writeFileSync\(reportPath,[\s\S]*?console\.log\(JSON\.stringify\(\{ type: "message_end"[\s\S]*?\}\)\);/,
  "process.exit(17);",
);

async function enqueue(root, extra = []) {
  return run([
    "enqueue", "ingest", "project:docs/decision.md",
    "--instruction", "Compile the durable queue decision.",
    "--project-root", root, "--json", ...extra,
  ]);
}

async function waitForState(root, jobId, expected, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await run(["jobs", jobId, "--project-root", root, "--json"]);
    if (result.code === 0 && parse(result).job.state.state === expected) return parse(result).job;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for job ${jobId} to reach ${expected}`);
}

test("M3a enqueue writes a bounded private capsule outside the OKF bundle and deduplicates active input", async (t) => {
  const root = await project(t);
  const first = await enqueue(root, ["--model", "openrouter/google/gemma-4-31b-it", "--runtime-seconds", "120"]);
  assert.equal(first.code, 0, first.stderr);
  const queued = parse(first);
  assert.equal(queued.state, "queued");
  assert.equal(queued.duplicate, false);
  assert.ok(!queued.jobDir.startsWith(path.join(root, ".agents", "data", "okf-engram", "bundle") + path.sep));

  const capsulePath = path.join(queued.jobDir, "capsule.json");
  const capsule = JSON.parse(await fs.readFile(capsulePath, "utf8"));
  assert.equal(capsule.version, 1);
  assert.equal(capsule.kind, "artifact-ingest");
  assert.equal(capsule.scope.projectRoot, await fs.realpath(root));
  assert.match(capsule.request.resources[0].digest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(capsule).includes("Use bounded workers."), false);
  assert.equal((await fs.stat(queued.jobDir)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(capsulePath)).mode & 0o777, 0o600);

  const duplicate = await enqueue(root, ["--model", "openrouter/google/gemma-4-31b-it", "--runtime-seconds", "120"]);
  assert.equal(duplicate.code, 0, duplicate.stderr);
  assert.equal(parse(duplicate).duplicate, true);
  assert.equal(parse(duplicate).jobId, queued.jobId);

  const oversized = await enqueue(root, ["--instruction", "x".repeat(4_001)]);
  assert.equal(oversized.code, 4);
});

test("M3a queued cancellation prevents execution and safe retry requeues unchanged input", async (t) => {
  const root = await project(t);
  const queued = parse(await enqueue(root));
  let result = await run(["cancel", queued.jobId, "--project-root", root, "--json"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(parse(result).state, "cancelled");

  const fake = await fakePi(t, "require('node:fs').writeFileSync(process.env.SHOULD_NOT_RUN, 'ran')");
  const marker = path.join(root, "ran");
  result = await run(["flush", "--job", queued.jobId, "--project-root", root, "--json"], {
    env: { ...fake.env, SHOULD_NOT_RUN: marker },
  });
  assert.equal(result.code, 0, result.stderr);
  await assert.rejects(() => fs.access(marker), { code: "ENOENT" });

  result = await run(["retry", queued.jobId, "--project-root", root, "--json"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(parse(result).state, "queued");
  assert.equal(parse(result).attempt, 2);
});

test("M3a flush runs one isolated Pi backend and exposes only compact verified results", async (t) => {
  const root = await project(t);
  const queued = parse(await enqueue(root));
  const fake = await fakePi(t, successWorker);
  const result = await run(["flush", "--job", queued.jobId, "--project-root", root, "--json"], { env: fake.env });
  assert.equal(result.code, 0, result.stderr);
  const flushed = parse(result);
  const inspected = parse(await run(["jobs", queued.jobId, "--project-root", root, "--json"])).job;
  assert.equal(flushed.processed[0].state, "completed", JSON.stringify(inspected.result));
  assert.equal(result.stdout.includes("SECRET_WORKER_TRACE"), false);

  assert.equal(inspected.state.state, "completed");
  assert.equal(inspected.result.changes[0].id, "decisions/background-queue");
  assert.match(inspected.result.changes[0].hash, /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(inspected.result).includes("SECRET_WORKER_TRACE"), false);
  assert.match(await fs.readFile(path.join(queued.jobDir, "events.jsonl"), "utf8"), /SECRET_WORKER_TRACE/);
});

test("M3a source drift before execution becomes needs-review without invoking Pi", async (t) => {
  const root = await project(t);
  const queued = parse(await enqueue(root));
  await fs.writeFile(path.join(root, "docs", "decision.md"), "changed after enqueue\n");
  const fake = await fakePi(t, "require('node:fs').writeFileSync(process.env.SHOULD_NOT_RUN, 'ran')");
  const marker = path.join(root, "ran");
  const result = await run(["flush", "--job", queued.jobId, "--project-root", root, "--json"], {
    env: { ...fake.env, SHOULD_NOT_RUN: marker },
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(parse(result).processed[0].state, "needs-review");
  assert.equal(parse(result).processed[0].reason, "source-drift");
  await assert.rejects(() => fs.access(marker), { code: "ENOENT" });
});

test("M3a running cancellation is acknowledged only after the worker exits", async (t) => {
  const root = await project(t);
  const queued = parse(await enqueue(root));
  const fake = await fakePi(t, sleepingWorker);
  const flush = run(["flush", "--job", queued.jobId, "--project-root", root, "--json"], { env: fake.env });
  await waitForState(root, queued.jobId, "running");

  let result = await run(["cancel", queued.jobId, "--project-root", root, "--json"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(parse(result).state, "running");
  assert.equal(parse(result).cancellation, "requested");

  result = await flush;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(parse(result).processed[0].state, "cancelled");
  const terminal = await waitForState(root, queued.jobId, "cancelled");
  assert.ok(terminal.state.cancelledAt);
});

test("M3a a worker crash after persistence becomes needs-review and cannot be blindly retried", async (t) => {
  const root = await project(t);
  const queued = parse(await enqueue(root));
  const fake = await fakePi(t, crashAfterWriteWorker);
  let result = await run(["flush", "--job", queued.jobId, "--project-root", root, "--json"], { env: fake.env });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(parse(result).processed[0].state, "needs-review");
  assert.equal(parse(result).processed[0].reason, "unreported-bundle-change");

  result = await run(["retry", queued.jobId, "--project-root", root, "--json"]);
  assert.equal(result.code, 4);
  assert.match(result.stderr, /manual reconciliation/i);
  const get = await run(["get", "decisions/background-queue", "--project-root", root, "--json"]);
  assert.equal(get.code, 0, get.stderr);
});

test("M3a malformed or symlinked job state is rejected without following it", async (t) => {
  const root = await project(t);
  const queued = parse(await enqueue(root));
  const outside = path.join(root, "outside.json");
  await fs.writeFile(outside, "not json\n");
  const statePath = path.join(queued.jobDir, "state.json");
  await fs.rm(statePath);
  await fs.symlink(outside, statePath);
  const result = await run(["jobs", queued.jobId, "--project-root", root, "--json"]);
  assert.equal(result.code, 9);
  assert.equal(await fs.readFile(outside, "utf8"), "not json\n");
});
