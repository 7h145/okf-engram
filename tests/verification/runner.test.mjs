import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const runner = path.join(repo, "tests", "verification", "run.mjs");

function execute(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [runner, ...args], {
      cwd: repo,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function fixture(t, profile, options = []) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "engram verification runner "));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const output = path.join(parent, "result");
  const result = await execute([
    "--profile", profile,
    "--output-dir", output,
    "--allow-dirty",
    ...options,
  ]);
  return { output, result };
}

async function readResult(output) {
  const summary = JSON.parse(await fs.readFile(path.join(output, "summary.json"), "utf8"));
  const result = await fs.readFile(path.join(output, "result.md"), "utf8");
  await fs.access(path.join(output, "done"));
  return { summary, result };
}

async function assertPrivate(output, logs) {
  assert.equal((await fs.stat(output)).mode & 0o777, 0o700);
  for (const name of ["summary.json", "result.md", "done", ...logs]) {
    assert.equal((await fs.stat(path.join(output, name))).mode & 0o777, 0o600);
  }
  const summaryStat = await fs.stat(path.join(output, "summary.json"), { bigint: true });
  const resultStat = await fs.stat(path.join(output, "result.md"), { bigint: true });
  const doneStat = await fs.stat(path.join(output, "done"), { bigint: true });
  assert.ok(summaryStat.mtimeNs <= doneStat.mtimeNs);
  assert.ok(resultStat.mtimeNs <= doneStat.mtimeNs);
}

test("delegated runner writes compact private passing results before done", async (t) => {
  const before = await fs.readFile(path.join(repo, "package.json"));
  const { output, result: processResult } = await fixture(t, "self-pass");
  assert.equal(processResult.code, 0, processResult.stderr);
  assert.equal(processResult.stdout, "");
  const { summary, result } = await readResult(output);
  assert.equal(summary.overall, "passed");
  assert.equal(summary.commands.length, 1);
  assert.equal(summary.commands[0].passed, true);
  assert.equal(summary.sourceChanged, false);
  assert.match(result, /1\/1 passed/);
  assert.ok((await fs.stat(path.join(output, "summary.json"))).size < 64 * 1024);
  await assertPrivate(output, summary.commands.map((item) => item.log));
  assert.deepEqual(await fs.readFile(path.join(repo, "package.json")), before);
});

test("delegated runner propagates failure while keeping raw output private", async (t) => {
  const { output, result: processResult } = await fixture(t, "self-fail");
  assert.equal(processResult.code, 1, processResult.stderr);
  const { summary, result } = await readResult(output);
  assert.equal(summary.overall, "failed");
  assert.equal(summary.commands[0].exitCode, 7);
  assert.equal(summary.commands[0].passed, false);
  assert.doesNotMatch(JSON.stringify(summary), /SELF_FAIL_PRIVATE_OUTPUT/);
  assert.doesNotMatch(result, /SELF_FAIL_PRIVATE_OUTPUT/);
  assert.match(await fs.readFile(path.join(output, summary.commands[0].log), "utf8"), /SELF_FAIL_PRIVATE_OUTPUT/);
  await assertPrivate(output, summary.commands.map((item) => item.log));
});

test("delegated runner extracts bounded test metrics", async (t) => {
  const { output, result: processResult } = await fixture(t, "self-metrics");
  assert.equal(processResult.code, 0, processResult.stderr);
  const { summary } = await readResult(output);
  assert.deepEqual(summary.commands[0].metrics, { tests: 3, passed: 3, failed: 0 });
});

test("delegated runner bounds command runtime", async (t) => {
  const { output, result: processResult } = await fixture(t, "self-timeout", ["--timeout-seconds", "1"]);
  assert.equal(processResult.code, 1, processResult.stderr);
  const { summary } = await readResult(output);
  assert.equal(summary.overall, "failed");
  assert.equal(summary.commands[0].timedOut, true);
  assert.ok(summary.commands[0].durationMs < 5_000);
});

test("delegated runner bounds private log output", async (t) => {
  const { output, result: processResult } = await fixture(t, "self-overflow", ["--max-log-bytes", "1024"]);
  assert.equal(processResult.code, 1, processResult.stderr);
  const { summary } = await readResult(output);
  assert.equal(summary.overall, "failed");
  assert.equal(summary.commands[0].outputExceeded, true);
  assert.ok(summary.commands[0].logBytes <= 1_024);
  assert.ok((await fs.stat(path.join(output, summary.commands[0].log))).size <= 1_024);
});
