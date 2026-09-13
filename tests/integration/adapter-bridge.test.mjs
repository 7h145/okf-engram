import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const helper = path.join(repository, "scripts", "engram.mjs");
const protocol = ["--adapter-bridge-protocol-version", "1"];

function run(args, { cwd = repository, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [helper, ...args], {
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

const bridge = (operation, ...args) => run(["adapter", "bridge", operation, ...protocol, ...args]);
const projectOptions = (root) => ["--project-working-directory", root];
const parse = (result) => JSON.parse(result.stdout);
const parseError = (result) => JSON.parse(result.stderr);

async function temporaryProject(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "engram adapter bridge "));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const initialized = await run([
    "corpus",
    "initialize",
    "--corpus-context",
    "project",
    "--project-root-path",
    root,
  ]);
  assert.equal(initialized.code, 0, initialized.stderr);
  return root;
}

async function enableAutomaticMemory(root) {
  const result = await run([
    "policy",
    "project",
    "automatic-memory",
    "enable",
    "--corpus-context",
    "project",
    "--project-root-path",
    root,
  ]);
  assert.equal(result.code, 0, result.stderr);
  return parse(result);
}

async function fakePi(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "engram adapter fake pi "));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const executable = path.join(directory, "pi");
  await fs.writeFile(
    executable,
    `#!/usr/bin/env node
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const cp = require("node:child_process");
const prompt = process.argv[process.argv.indexOf("-p") + 1];
const capsule = JSON.parse(prompt.match(/<engram-job-capsule>\\n([\\s\\S]*?)\\n<\\/engram-job-capsule>/)[1]);
const reportPath = prompt.match(/<engram-worker-report-path>\\n([\\s\\S]*?)\\n<\\/engram-worker-report-path>/)[1];
const id = "memories/adapter-sqlite-state";
const draft = path.join(os.tmpdir(), "engram-adapter-draft-" + capsule.jobId + ".md");
const source = capsule.request.source;
fs.writeFileSync(draft, [
  "---", "type: Memory", "title: Adapter SQLite state",
  "description: SQLite is the approved durable project state store.", "capture: inferred",
  "sources:", "  - id: candidate-evidence", "    resource: " + source.resource,
  "    digest: " + source.digest, "---", "# Adapter SQLite state", "",
  "SQLite is the approved durable project state store.[^candidate-evidence]", "",
  "[^candidate-evidence]: Concise evidence supplied with the inferred-memory candidate.", ""
].join("\\n"));
const writeResult = JSON.parse(cp.execFileSync(process.execPath, [
  process.env.OKF_ENGRAM_HELPER, "concepts", "write", "--concept-id", id,
  "--document-file-path", draft, "--write-mode", "automatic-inferred-memory",
  "--automatic-memory-policy-generation", String(capsule.policy.generation),
  "--corpus-context", "project", "--project-root-path", capsule.corpus.projectRootPath
], { encoding: "utf8" }));
fs.rmSync(draft, { force: true });
fs.writeFileSync(reportPath, JSON.stringify({
  version: 1,
  jobId: capsule.jobId,
  candidate: {
    status: "stored",
    conceptIds: [id],
    note: "Stored one durable project memory."
  },
  outcomes: [{ id, status: "created", hash: writeResult.hash }],
  warnings: []
}) + "\\n", { mode: 0o600, flag: "wx" });
`,
    { mode: 0o755 },
  );
  return { PATH: `${directory}${path.delimiter}${process.env.PATH}` };
}

async function enqueue(root, generation, suffix = "") {
  return bridge(
    "inferred-memory-enqueue",
    ...projectOptions(root),
    "--memory-claim",
    `The project uses SQLite for durable state${suffix}.`,
    "--memory-evidence",
    "The user approved SQLite as the durable state store.",
    "--conversation-context-reference",
    "session:opaque/entry:opaque",
    "--automatic-memory-policy-generation",
    String(generation),
  );
}

test("P3 package manifest and handshake define one versioned project-only bridge", async () => {
  const packageDocument = JSON.parse(await fs.readFile(path.join(repository, "package.json"), "utf8"));
  assert.deepEqual(packageDocument.okfEngram.adapterBridge, {
    manifestVersion: 1,
    protocol: "okf-engram.adapter-bridge",
    supportedProtocolVersions: [1],
    transport: "node-cli-json",
    entrypoint: "./scripts/engram.mjs",
    commandPrefix: ["adapter", "bridge"],
    protocolVersionOption: "--adapter-bridge-protocol-version",
  });

  let result = await bridge("handshake");
  assert.equal(result.code, 0, result.stderr);
  const handshake = parse(result);
  assert.equal(handshake.bridgeProtocol, packageDocument.okfEngram.adapterBridge.protocol);
  assert.equal(handshake.bridgeProtocolVersion, 1);
  assert.deepEqual(handshake.supportedProtocolVersions, [1]);
  assert.deepEqual(handshake.package, { name: "okf-engram", version: packageDocument.version });
  assert.deepEqual(handshake.target, {
    corpusContext: "project",
    fallback: false,
    automaticMemoryOptInRequired: true,
    candidateOrigin: "automatic-review",
  });
  assert.ok(handshake.capabilities.includes("project.inferred-memory.enqueue"));
  assert.ok(handshake.capabilities.includes("project.inferred-memory.results.acknowledge"));
  assert.equal(JSON.stringify(handshake).includes("global"), false);
  assert.equal(JSON.stringify(handshake).includes("linked"), false);

  result = await run(["adapter", "bridge", "handshake"]);
  assert.equal(result.code, 2);
  assert.equal(parseError(result).error.code, "USAGE");

  result = await run([
    "adapter",
    "bridge",
    "handshake",
    "--adapter-bridge-protocol-version",
    "2",
  ]);
  assert.equal(result.code, 11);
  const incompatible = parseError(result);
  assert.equal(incompatible.error.code, "ADAPTER_BRIDGE_INCOMPATIBLE");
  assert.deepEqual(incompatible.supportedProtocolVersions, [1]);

  result = await run([
    "adapter",
    "bridge",
    "handshake",
    ...protocol,
    "--output-format",
    "text",
  ]);
  assert.equal(result.code, 2);
  assert.equal(parseError(result).error.code, "USAGE");
});

test("P3 bridge exposes bounded policy and inferred-memory lifecycle without private records", async (t) => {
  const root = await temporaryProject(t);
  let result = await bridge("project-policy-status", ...projectOptions(root));
  assert.equal(result.code, 0, result.stderr);
  const defaultPolicy = parse(result);
  assert.equal(defaultPolicy.target.corpusContext, "project");
  assert.equal(defaultPolicy.target.projectRootPath, root);
  assert.equal(defaultPolicy.automaticMemory.state, "off");
  assert.equal(defaultPolicy.automaticMemory.generation, 0);
  assert.equal(defaultPolicy.sensitiveData.mode, "guarded");
  assert.equal(defaultPolicy.sensitiveData.previouslyUnguarded, false);
  assert.equal(JSON.stringify(defaultPolicy).includes("settings.json"), false);
  assert.equal(JSON.stringify(defaultPolicy).includes("bundle"), false);

  const settingsFile = path.join(root, ".agents", "data", "okf-engram", "settings.json");
  await fs.writeFile(settingsFile, "{ invalid json\n");
  result = await bridge("project-policy-status", ...projectOptions(root));
  assert.equal(result.code, 0, result.stderr);
  const invalidPolicy = parse(result);
  assert.deepEqual(
    {
      state: invalidPolicy.automaticMemory.state,
      generation: invalidPolicy.automaticMemory.generation,
      valid: invalidPolicy.automaticMemory.valid,
      mode: invalidPolicy.sensitiveData.mode,
      previouslyUnguarded: invalidPolicy.sensitiveData.previouslyUnguarded,
    },
    { state: "off", generation: null, valid: false, mode: "guarded", previouslyUnguarded: "unknown" },
  );
  assert.equal(result.stdout.includes("settings.json"), false);
  await fs.rm(settingsFile);

  const policy = await enableAutomaticMemory(root);
  result = await enqueue(root, policy.generation);
  assert.equal(result.code, 0, result.stderr);
  const queued = parse(result);
  assert.equal(queued.job.state, "queued");
  assert.equal(queued.job.duplicate, false);
  assert.deepEqual(queued.runnerCommand.slice(2, 6), [
    "adapter",
    "bridge",
    "inferred-job-run",
    "--adapter-bridge-protocol-version",
  ]);
  assert.equal(queued.runnerCommand.includes("--corpus-context"), false);
  const publicEnqueue = JSON.stringify(queued);
  assert.equal(publicEnqueue.includes("The user approved"), false);
  assert.equal(publicEnqueue.includes("jobDirectoryPath"), false);
  assert.equal(publicEnqueue.includes("capsule"), false);

  const capsule = JSON.parse(
    await fs.readFile(
      path.join(root, ".agents", "data", "okf-engram", "jobs", queued.job.jobId, "capsule.json"),
      "utf8",
    ),
  );
  assert.equal(capsule.request.origin, "automatic-review");

  result = await bridge("inferred-jobs-list", ...projectOptions(root));
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(parse(result).jobs.map((job) => job.jobId), [queued.job.jobId]);
  assert.equal(result.stdout.includes("The user approved"), false);

  result = await bridge("inferred-job-show", ...projectOptions(root), "--job-id", queued.job.jobId);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(parse(result).job.state, "queued");
  assert.equal(result.stdout.includes("memory-claim"), false);
  assert.equal(result.stdout.includes("capsule"), false);

  const env = await fakePi(t);
  result = await run(
    [
      "adapter",
      "bridge",
      "inferred-job-run",
      ...protocol,
      ...projectOptions(root),
      "--job-id",
      queued.job.jobId,
    ],
    { env },
  );
  assert.equal(result.code, 0, result.stderr);
  assert.equal(parse(result).job.state, "completed");

  result = await bridge(
    "inferred-results-list",
    ...projectOptions(root),
    "--acknowledgement-state",
    "unacknowledged",
  );
  assert.equal(result.code, 0, result.stderr);
  const pending = parse(result);
  assert.equal(pending.results.length, 1);
  assert.equal(pending.results[0].jobId, queued.job.jobId);
  assert.equal(pending.results[0].candidate.status, "stored");
  assert.deepEqual(pending.results[0].candidate.knowledgeReferences, [
    { corpusContext: "project", conceptId: "memories/adapter-sqlite-state" },
  ]);
  assert.deepEqual(pending.results[0].changes[0].knowledgeReference, {
    corpusContext: "project",
    conceptId: "memories/adapter-sqlite-state",
  });
  assert.match(pending.results[0].changes[0].sha256, /^[0-9a-f]{64}$/);
  assert.equal(pending.results[0].acknowledgementState, "unacknowledged");

  result = await bridge(
    "inferred-result-acknowledge",
    ...projectOptions(root),
    "--job-id",
    queued.job.jobId,
  );
  assert.equal(result.code, 0, result.stderr);
  assert.equal(parse(result).acknowledgement.state, "acknowledged");

  result = await bridge(
    "inferred-job-clean",
    ...projectOptions(root),
    "--job-id",
    queued.job.jobId,
    "--confirm-job-state-deletion",
  );
  assert.equal(result.code, 0, result.stderr);
  assert.equal(parse(result).job.cleaned, true);
});

test("P3 bridge cannot target or mutate non-inferred project work", async (t) => {
  const root = await temporaryProject(t);
  const policy = await enableAutomaticMemory(root);

  let result = await run([
    "adapter",
    "bridge",
    "project-policy-status",
    ...protocol,
    ...projectOptions(root),
    "--corpus-context",
    "global",
  ]);
  assert.equal(result.code, 2);
  assert.equal(parseError(result).error.code, "USAGE");

  result = await run([
    "adapter",
    "bridge",
    "inferred-memory-enqueue",
    ...protocol,
    ...projectOptions(root),
    "--memory-claim",
    "A candidate that tries to relabel its origin.",
    "--memory-evidence",
    "The candidate supplied an unsupported origin option.",
    "--automatic-memory-policy-generation",
    String(policy.generation),
    "--candidate-origin",
    "foreground",
  ]);
  assert.equal(result.code, 2);
  assert.equal(parseError(result).error.code, "USAGE");

  await fs.mkdir(path.join(root, "docs"));
  await fs.writeFile(path.join(root, "docs", "artifact.md"), "# Artifact\n");
  result = await run([
    "jobs",
    "enqueue",
    "artifact-ingest",
    "--corpus-context",
    "project",
    "--project-root-path",
    root,
    "--source-resource",
    "project:docs/artifact.md",
    "--ingest-instruction",
    "Compile the artifact.",
  ]);
  assert.equal(result.code, 0, result.stderr);
  const artifactJobId = parse(result).jobId;

  for (const [operation, extra] of [
    ["inferred-job-show", []],
    ["inferred-job-run", []],
    ["inferred-job-cancel", []],
    ["inferred-job-retry", []],
    ["inferred-job-clean", ["--confirm-job-state-deletion"]],
  ]) {
    result = await bridge(operation, ...projectOptions(root), "--job-id", artifactJobId, ...extra);
    assert.equal(result.code, 4, `${operation}: ${result.stderr}`);
    assert.equal(parseError(result).error.code, "VALIDATION_ERROR");
    assert.match(parseError(result).error.message, /not an inferred-memory job/);
  }

  result = await run([
    "jobs",
    "show",
    "--corpus-context",
    "project",
    "--project-root-path",
    root,
    "--job-id",
    artifactJobId,
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(parse(result).job.state.state, "queued");

  result = await enqueue(root, policy.generation, " for cancellation");
  const inferredJobId = parse(result).job.jobId;
  result = await bridge("inferred-job-cancel", ...projectOptions(root), "--job-id", inferredJobId);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(parse(result).job.state, "cancelled");

  result = await bridge("inferred-job-retry", ...projectOptions(root), "--job-id", inferredJobId);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(parse(result).job.state, "queued");
  assert.ok(Array.isArray(parse(result).runnerCommand));

  result = await bridge("inferred-job-cancel", ...projectOptions(root), "--job-id", inferredJobId);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(parse(result).job.state, "cancelled");
});
