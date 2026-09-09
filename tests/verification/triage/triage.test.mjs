import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import {
  extractLogExcerpt,
  gitSnapshot,
  loadConfig,
  parseAndValidateReview,
  redactText,
  runTriage,
} from "./lib.mjs";

const directory = path.dirname(fileURLToPath(import.meta.url));

function command(file, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr)));
  });
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "engram triage "));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repository = path.join(root, "repository");
  const verificationDir = path.join(root, "verification");
  const outputDir = path.join(root, "triage");
  await fs.mkdir(repository);
  await fs.mkdir(verificationDir);
  await command("git", ["init", "-q"], repository);
  await command("git", ["config", "user.email", "triage@example.invalid"], repository);
  await command("git", ["config", "user.name", "Triage Test"], repository);
  await fs.writeFile(path.join(repository, "source.txt"), "stable\n");
  await command("git", ["add", "source.txt"], repository);
  await command("git", ["commit", "-qm", "fixture"], repository);
  const snapshot = await gitSnapshot(repository);
  const log = [
    "starting focused fixture",
    "Error: assertion failed with token=fixture-private-value",
    "    at fixture.test.mjs:12:3",
    "not ok 1 - focused fixture",
  ].join("\n");
  await fs.writeFile(path.join(verificationDir, "01-tests.log"), log, { mode: 0o600 });
  await fs.writeFile(path.join(verificationDir, "summary.json"), `${JSON.stringify({
    version: 1,
    profile: "self-fail",
    repository,
    start: snapshot,
    end: snapshot,
    sourceChanged: false,
    commands: [{
      name: "tests",
      passed: false,
      exitCode: 1,
      signal: null,
      timedOut: false,
      outputExceeded: false,
      log: "01-tests.log",
      logSha256: `sha256:${createHash("sha256").update(log).digest("hex")}`,
    }],
    overall: "failed",
  }, null, 2)}\n`, { mode: 0o600 });
  await fs.writeFile(path.join(verificationDir, "done"), "", { mode: 0o600 });
  const config = await loadConfig(path.join(directory, "config.json"));
  return { root, repository, verificationDir, outputDir, config };
}

function validReview(overrides = {}) {
  return JSON.stringify({
    classification: "test-assertion",
    summary: "The focused fixture assertion failed.",
    firstCausalLine: 2,
    likelyOwner: "fixture.test.mjs",
    hypotheses: [{
      summary: "The fixture produced an unexpected value.",
      confidence: "high",
      evidenceLines: [2, 3],
    }],
    focusedCommand: "node --test fixture.test.mjs",
    requiresStrongerReview: false,
    uncertainty: "The excerpt does not show the compared values.",
    ...overrides,
  });
}

function reviewer(stdout, hook, overrides = {}) {
  return async ({ prompt }) => {
    await hook?.(prompt);
    return {
      stdout,
      stderr: "",
      exitCode: 0,
      signal: null,
      spawnError: null,
      timedOut: false,
      outputExceeded: false,
      durationMs: 12,
      stdoutBytes: Buffer.byteLength(stdout),
      stderrBytes: 0,
      ...overrides,
    };
  };
}

test("triage redacts common credentials and selects bounded error context", () => {
  const redacted = redactText("Bearer abcdefghijk token=visible-secret sk-example-abcdefgh SELF_FAIL_PRIVATE_OUTPUT", {
    SERVICE_PASSWORD: "visible-secret",
  });
  assert.doesNotMatch(redacted, /abcdefghijk|visible-secret|sk-example|SELF_FAIL_PRIVATE_OUTPUT/);
  const config = { contextBefore: 1, contextAfter: 1, maxExcerptLinesPerLog: 3 };
  const excerpt = extractLogExcerpt("failure.log", "noise\nnoise\nError: boom\ntail\nlast", config, 5, {});
  assert.deepEqual(excerpt.map((item) => item.id), [5, 6, 7]);
  assert.equal(excerpt[1].originalLine, 3);
});

test("triage validates only visible evidence lines", () => {
  assert.equal(parseAndValidateReview(validReview(), [1, 2, 3]).classification, "test-assertion");
  assert.throws(
    () => parseAndValidateReview(validReview({ firstCausalLine: 999 }), [1, 2, 3]),
    /does not cite a visible line/,
  );
});

test("triage writes compact private results after a valid bounded review", async (t) => {
  const item = await fixture(t);
  const summary = await runTriage({
    verificationDir: item.verificationDir,
    outputDir: item.outputDir,
    promptPath: path.join(directory, "prompt.md"),
    config: item.config,
    environment: { FIXTURE_TOKEN: "fixture-private-value" },
  }, {
    reviewer: reviewer(validReview(), async (prompt) => {
      assert.match(prompt, /\[REDACTED(?:_ENV)?\]/);
      assert.doesNotMatch(prompt, /fixture-private-value/);
      assert.match(prompt, /L2 \[01-tests\.log:2\]: Error:/);
    }),
  });
  assert.equal(summary.overall, "completed");
  assert.equal(summary.sourceChanged, false);
  assert.equal(summary.review.firstCausalLine, 2);
  assert.doesNotMatch(JSON.stringify(summary), /fixture-private-value/);
  for (const name of [
    "request.md",
    "model-output.txt",
    "reviewer.stderr.log",
    "result.md",
    "summary.json",
    "done",
  ]) {
    assert.equal((await fs.stat(path.join(item.outputDir, name))).mode & 0o777, 0o600);
  }
  assert.equal((await fs.stat(item.outputDir)).mode & 0o777, 0o700);
  assert.ok((await fs.stat(path.join(item.outputDir, "summary.json"))).size < 64 * 1024);
  const resultStat = await fs.stat(path.join(item.outputDir, "result.md"), { bigint: true });
  const summaryStat = await fs.stat(path.join(item.outputDir, "summary.json"), { bigint: true });
  const doneStat = await fs.stat(path.join(item.outputDir, "done"), { bigint: true });
  assert.ok(resultStat.mtimeNs <= doneStat.mtimeNs);
  assert.ok(summaryStat.mtimeNs <= doneStat.mtimeNs);
});

test("triage refuses a failed log changed after verification", async (t) => {
  const item = await fixture(t);
  await fs.appendFile(path.join(item.verificationDir, "01-tests.log"), "\ntampered");
  let called = false;
  const summary = await runTriage({
    verificationDir: item.verificationDir,
    outputDir: item.outputDir,
    promptPath: path.join(directory, "prompt.md"),
    config: item.config,
    environment: {},
  }, { reviewer: async () => { called = true; } });
  assert.equal(summary.overall, "failed");
  assert.equal(summary.error.code, "invalid-input");
  assert.equal(called, false);
});

test("triage fails closed on invalid reviewer evidence and still signals completion", async (t) => {
  const item = await fixture(t);
  const summary = await runTriage({
    verificationDir: item.verificationDir,
    outputDir: item.outputDir,
    promptPath: path.join(directory, "prompt.md"),
    config: item.config,
    environment: {},
  }, { reviewer: reviewer(validReview({ firstCausalLine: 999 })) });
  assert.equal(summary.overall, "failed");
  assert.equal(summary.error.code, "invalid-review");
  await fs.access(path.join(item.outputDir, "done"));
  assert.doesNotMatch(await fs.readFile(path.join(item.outputDir, "result.md"), "utf8"), /999/);
});

test("triage fails closed when the reviewer process is not bounded and successful", async (t) => {
  for (const [name, overrides] of [
    ["nonzero exit", { exitCode: 9 }],
    ["timeout", { exitCode: null, signal: "SIGTERM", timedOut: true }],
    ["output overflow", { exitCode: null, signal: "SIGTERM", outputExceeded: true }],
  ]) {
    await t.test(name, async (subtest) => {
      const item = await fixture(subtest);
      const summary = await runTriage({
        verificationDir: item.verificationDir,
        outputDir: item.outputDir,
        promptPath: path.join(directory, "prompt.md"),
        config: item.config,
        environment: {},
      }, { reviewer: reviewer(validReview(), undefined, overrides) });
      assert.equal(summary.overall, "failed");
      assert.equal(summary.error.code, "reviewer-failed");
      await fs.access(path.join(item.outputDir, "done"));
    });
  }
});

test("triage detects source mutation by a reviewer", async (t) => {
  const item = await fixture(t);
  const mutatingReviewer = reviewer(validReview(), async () => {
    await fs.writeFile(path.join(item.repository, "source.txt"), "changed\n");
  });
  const summary = await runTriage({
    verificationDir: item.verificationDir,
    outputDir: item.outputDir,
    promptPath: path.join(directory, "prompt.md"),
    config: item.config,
    environment: {},
  }, { reviewer: mutatingReviewer });
  assert.equal(summary.overall, "failed");
  assert.equal(summary.error.code, "source-changed");
});

test("documented review schema matches the manual validator contract", async () => {
  const schema = JSON.parse(await fs.readFile(path.join(directory, "review.schema.json"), "utf8"));
  assert.deepEqual(schema.required.sort(), [
    "classification",
    "firstCausalLine",
    "focusedCommand",
    "hypotheses",
    "likelyOwner",
    "requiresStrongerReview",
    "summary",
    "uncertainty",
  ]);
  assert.deepEqual(
    new Set(schema.properties.classification.enum),
    new Set([
      "test-assertion",
      "runtime-compatibility",
      "dependency",
      "environment",
      "timeout",
      "output-overflow",
      "product-defect",
      "test-defect",
      "unknown",
    ]),
  );
});

test("triage uses the configured Pi model by default and supports explicit overrides", async () => {
  const defaults = await loadConfig(path.join(directory, "config.json"));
  assert.equal(defaults.model, undefined);
  assert.equal(defaults.thinking, "high");
  const config = await loadConfig(path.join(directory, "config.json"), {
    model: "replacement-provider/replacement-model",
    thinking: "medium",
  });
  assert.equal(config.model, "replacement-provider/replacement-model");
  assert.equal(config.thinking, "medium");
});
