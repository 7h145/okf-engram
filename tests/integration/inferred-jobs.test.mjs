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

const parse = (result) => JSON.parse(result.stdout);

async function project(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "engram inferred jobs Ω "));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  assert.equal(
    (await run(["corpus", "initialize", "--corpus-context", "project", "--project-root-path", root])).code,
    0,
  );
  return root;
}

async function enable(root) {
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

async function setKnowledgeMode(root, mode) {
  const result = await run([
    "policy",
    "project",
    "sensitive-data",
    mode === "unguarded" ? "allow" : "deny",
    "--corpus-context",
    "project",
    "--project-root-path",
    root,
  ]);
  assert.equal(result.code, 0, result.stderr);
  return parse(result);
}

async function fakePi(t, source) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "engram inferred fake pi "));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const executable = path.join(directory, "pi");
  await fs.writeFile(executable, `#!/usr/bin/env node\n${source}\n`, { mode: 0o755 });
  return { PATH: `${directory}${path.delimiter}${process.env.PATH}` };
}

async function enqueueCandidate(
  root,
  generation,
  {
    claim = "The project uses SQLite for durable local state.",
    evidence = "The user approved SQLite as the durable local state store.",
    contextRefs = ["session:test/entry:42"],
    origin,
  } = {},
) {
  const args = [
    "jobs",
    "enqueue",
    "inferred-memory",
    "--corpus-context",
    "project",
    "--memory-claim",
    claim,
    "--memory-evidence",
    evidence,
    "--automatic-memory-policy-generation",
    String(generation),
    "--project-root-path",
    root,
  ];
  for (const ref of contextRefs) args.push("--conversation-context-reference", ref);
  if (origin) args.push("--candidate-origin", origin);
  return run(args);
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

const storedWorker = String.raw`
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const cp = require("node:child_process");
const prompt = process.argv[process.argv.indexOf("-p") + 1];
const capsule = JSON.parse(prompt.match(/<engram-job-capsule>\n([\s\S]*?)\n<\/engram-job-capsule>/)[1]);
const reportPath = prompt.match(/<engram-worker-report-path>\n([\s\S]*?)\n<\/engram-worker-report-path>/)[1];
const id = "memories/sqlite-durable-state";
const draft = path.join(os.tmpdir(), "engram-inferred-draft-" + capsule.jobId + ".md");
const source = capsule.request.source;
fs.writeFileSync(draft, [
  "---", "type: Memory", "title: SQLite durable state", "description: SQLite is the approved durable local state store.",
  "capture: inferred", "sources:", "  - id: candidate-evidence", "    resource: " + source.resource,
  "    digest: " + source.digest, "---", "# SQLite durable state", "",
  "SQLite is the approved durable local state store.[^candidate-evidence]", "",
  "[^candidate-evidence]: Concise evidence supplied with the inferred-memory candidate.", "",
].join("\n"));
const writeResult = JSON.parse(cp.execFileSync(process.execPath, [
  process.env.OKF_ENGRAM_HELPER, "concepts", "write", "--concept-id", id,
  "--document-file-path", draft, "--write-mode", "automatic-inferred-memory",
  "--automatic-memory-policy-generation", String(capsule.policy.generation),
  "--corpus-context", "project", "--project-root-path", capsule.corpus.projectRootPath,
], { encoding: "utf8" }));
fs.writeFileSync(reportPath, JSON.stringify({
  version: 1, jobId: capsule.jobId,
  candidate: { status: "stored", conceptIds: [id], note: "Stored one durable project memory." },
  outcomes: [{ id, status: "created", hash: writeResult.hash }], warnings: [],
}) + "\n", { mode: 0o600, flag: "wx" });
`;

const missingCandidateProvenanceWorker = String.raw`
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const cp = require("node:child_process");
const prompt = process.argv[process.argv.indexOf("-p") + 1];
const capsule = JSON.parse(prompt.match(/<engram-job-capsule>\n([\s\S]*?)\n<\/engram-job-capsule>/)[1]);
const reportPath = prompt.match(/<engram-worker-report-path>\n([\s\S]*?)\n<\/engram-worker-report-path>/)[1];
const id = "memories/missing-candidate-provenance";
const draft = path.join(os.tmpdir(), "engram-inferred-missing-source-" + capsule.jobId + ".md");
fs.writeFileSync(draft, [
  "---", "type: Memory", "title: Missing candidate provenance",
  "description: A candidate write with incorrect evidence provenance.", "capture: inferred",
  "sources:", "  - id: wrong-candidate-evidence", "    resource: urn:okf-engram:conversation:wrong",
  "---", "# Missing candidate provenance", "", "A durable claim.[^wrong-candidate-evidence]", "",
  "[^wrong-candidate-evidence]: Incorrect candidate evidence.", "",
].join("\n"));
const writeResult = JSON.parse(cp.execFileSync(process.execPath, [
  process.env.OKF_ENGRAM_HELPER, "concepts", "write", "--concept-id", id,
  "--document-file-path", draft, "--write-mode", "automatic-inferred-memory",
  "--automatic-memory-policy-generation", String(capsule.policy.generation),
  "--corpus-context", "project", "--project-root-path", capsule.corpus.projectRootPath,
], { encoding: "utf8" }));
fs.writeFileSync(reportPath, JSON.stringify({
  version: 1, jobId: capsule.jobId,
  candidate: { status: "stored", conceptIds: [id] },
  outcomes: [{ id, status: "created", hash: writeResult.hash }], warnings: [],
}) + "\n", { mode: 0o600, flag: "wx" });
`;

const decisionWorker = (status, reason) => String.raw`
const fs = require("node:fs");
const prompt = process.argv[process.argv.indexOf("-p") + 1];
const capsule = JSON.parse(prompt.match(/<engram-job-capsule>\n([\s\S]*?)\n<\/engram-job-capsule>/)[1]);
const reportPath = prompt.match(/<engram-worker-report-path>\n([\s\S]*?)\n<\/engram-worker-report-path>/)[1];
fs.writeFileSync(reportPath, JSON.stringify({
  version: 1, jobId: capsule.jobId,
  candidate: { status: "${status}", conceptIds: [], reason: "${reason}", note: "Bounded candidate disposition." },
  outcomes: [], warnings: [],
}) + "\n", { mode: 0o600, flag: "wx" });
`;

const unguardedDecisionWorker = String.raw`
const fs = require("node:fs");
const prompt = process.argv[process.argv.indexOf("-p") + 1];
if (!prompt.includes("Project knowledge mode is unguarded")) process.exit(23);
if (!prompt.includes("credentials, and secret values may be stored when relevant")) process.exit(24);
const capsule = JSON.parse(prompt.match(/<engram-job-capsule>\n([\s\S]*?)\n<\/engram-job-capsule>/)[1]);
const reportPath = prompt.match(/<engram-worker-report-path>\n([\s\S]*?)\n<\/engram-worker-report-path>/)[1];
fs.writeFileSync(reportPath, JSON.stringify({
  version: 1, jobId: capsule.jobId,
  candidate: { status: "discarded", conceptIds: [], reason: "duplicate-existing", note: "Tested unguarded worker policy." },
  outcomes: [], warnings: [],
}) + "\n", { mode: 0o600, flag: "wx" });
`;

test("M3b1 candidate acceptance is default-off and bound to a visible policy generation", async (t) => {
  const root = await project(t);
  let result = await enqueueCandidate(root, 0);
  assert.equal(result.code, 4);
  assert.match(result.stderr, /AUTOMATIC_MEMORY_DISABLED/);

  const first = await enable(root);
  assert.equal(first.automaticMemory, "on");
  assert.equal(first.generation, 1);

  assert.equal(
    (
      await run([
        "policy",
        "project",
        "automatic-memory",
        "disable",
        "--corpus-context",
        "project",
        "--project-root-path",
        root,
      ])
    ).code,
    0,
  );
  const second = await enable(root);
  assert.equal(second.generation, 3);

  result = await enqueueCandidate(root, first.generation);
  assert.equal(result.code, 4);
  assert.match(result.stderr, /AUTOMATIC_MEMORY_DISABLED/);
  assert.match(result.stderr, /generation/i);

  result = await enqueueCandidate(root, second.generation);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(parse(result).state, "queued");
});

test("M3b1 writes a bounded private candidate capsule with stable cross-origin identity", async (t) => {
  const root = await project(t);
  const policy = await enable(root);
  const first = await enqueueCandidate(root, policy.generation, { origin: "foreground" });
  assert.equal(first.code, 0, first.stderr);
  const queued = parse(first);
  const capsulePath = path.join(queued.jobDirectoryPath, "capsule.json");
  const capsule = JSON.parse(await fs.readFile(capsulePath, "utf8"));
  assert.equal(capsule.kind, "inferred-memory");
  assert.equal(capsule.policy.generation, policy.generation);
  assert.match(capsule.request.candidateId, /^candidate-sha256:[0-9a-f]{64}$/);
  assert.match(capsule.request.source.resource, /^urn:okf-engram:conversation:[0-9a-f]{32}$/);
  assert.match(capsule.request.source.digest, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(capsule.request.contextRefs, ["session:test/entry:42"]);
  assert.equal((await fs.stat(queued.jobDirectoryPath)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(capsulePath)).mode & 0o777, 0o600);

  const duplicate = await enqueueCandidate(root, policy.generation, {
    origin: "automatic-review",
    evidence: "SQLite was approved for local durability in the completed exchange.",
  });
  assert.equal(duplicate.code, 0, duplicate.stderr);
  assert.equal(parse(duplicate).duplicate, true);
  assert.equal(parse(duplicate).jobId, queued.jobId);

  let result = await enqueueCandidate(root, policy.generation, { claim: "x".repeat(1_001) });
  assert.equal(result.code, 4);
  result = await enqueueCandidate(root, policy.generation, { evidence: "x".repeat(2_001) });
  assert.equal(result.code, 4);
  result = await enqueueCandidate(root, policy.generation, { contextRefs: ["x".repeat(257)] });
  assert.equal(result.code, 4);
});

test("M3b1 rejects obvious secrets and coordinator relabeling before persistence", async (t) => {
  const root = await project(t);
  const policy = await enable(root);
  let result = await enqueueCandidate(root, policy.generation, {
    evidence: "api_key=sk-abcdefghijklmnopqrstuvwxyz012345",
  });
  assert.equal(result.code, 4);
  assert.match(result.stderr, /credential|secret/i);

  const draft = path.join(root, "relabel.md");
  await fs.writeFile(
    draft,
    [
      "---",
      "type: Memory",
      "title: Relabeled candidate",
      "description: A worker attempted to relabel inferred content as explicit.",
      "capture: explicit",
      "sources:",
      "  - resource: urn:okf-engram:conversation:test",
      "---",
      "# Relabeled candidate",
      "",
    ].join("\n"),
  );
  result = await run(
    [
      "concepts",
      "write",
      "--concept-id",
      "memories/relabelled",
      "--corpus-context",
      "project",
      "--document-file-path",
      draft,
      "--project-root-path",
      root,
    ],
    { env: { OKF_ENGRAM_JOB_POLICY_GENERATION: String(policy.generation) } },
  );
  assert.equal(result.code, 4);
  assert.match(result.stderr, /AUTOMATIC_MEMORY_DISABLED/);
  assert.equal(
    (
      await run([
        "concepts",
        "read",
        "--concept-id",
        "memories/relabelled",
        "--corpus-context",
        "project",
        "--project-root-path",
        root,
      ])
    ).code,
    7,
  );
});

test("unguarded mode admits sensitive inferred candidates and is explicit in the worker prompt", async (t) => {
  const root = await project(t);
  const policy = await enable(root);
  await setKnowledgeMode(root, "unguarded");
  const secret = "api_key=sk-abcdefghijklmnopqrstuvwxyz012345";
  const queued = parse(
    await enqueueCandidate(root, policy.generation, {
      claim: "The project records a customer API credential for integration work.",
      evidence: secret,
    }),
  );
  assert.equal(queued.state, "queued");

  const env = await fakePi(t, unguardedDecisionWorker);
  const result = await run(
    ["jobs", "run", "--job-id", queued.jobId, "--corpus-context", "project", "--project-root-path", root],
    { env },
  );
  assert.equal(result.code, 0, result.stderr);
  assert.equal(parse(result).processed[0].state, "completed");
});

test("returning to guarded mode discards a queued sensitive candidate before model execution", async (t) => {
  const root = await project(t);
  const policy = await enable(root);
  await setKnowledgeMode(root, "unguarded");
  const queued = parse(
    await enqueueCandidate(root, policy.generation, {
      claim: "A second integration credential is currently used by the project.",
      evidence: "api_key=sk-abcdefghijklmnopqrstuvwxyz012345",
    }),
  );
  await setKnowledgeMode(root, "guarded");

  const result = await run([
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
  assert.equal(parse(result).processed[0].state, "cancelled");
  const inspected = parse(
    await run(["jobs", "show", "--job-id", queued.jobId, "--corpus-context", "project", "--project-root-path", root]),
  ).job;
  assert.equal(inspected.result.reason, "guarded-before-start");
  assert.equal(inspected.result.candidate.reason, "sensitive");
});

test("M3b1 compiler stores only a verified inferred Memory through the generation gate", async (t) => {
  const root = await project(t);
  const policy = await enable(root);
  const queued = parse(await enqueueCandidate(root, policy.generation));
  const env = await fakePi(t, storedWorker);
  const result = await run(
    ["jobs", "run", "--job-id", queued.jobId, "--corpus-context", "project", "--project-root-path", root],
    { env },
  );
  assert.equal(result.code, 0, result.stderr);
  assert.equal(parse(result).processed[0].state, "completed");

  const inspected = parse(
    await run(["jobs", "show", "--job-id", queued.jobId, "--corpus-context", "project", "--project-root-path", root]),
  ).job;
  assert.equal(inspected.result.candidate.status, "stored");
  assert.equal(inspected.result.changes[0].id, "memories/sqlite-durable-state");
  const concept = parse(
    await run([
      "concepts",
      "read",
      "--concept-id",
      "memories/sqlite-durable-state",
      "--corpus-context",
      "project",
      "--project-root-path",
      root,
    ]),
  );
  assert.equal(concept.data.type, "Memory");
  assert.equal(concept.data.capture, "inferred");
  assert.equal(concept.data.sources[0].resource, inspected.capsule.request.source.resource);
});

test("M3b1 rejects wrong candidate provenance and the observed missing-note worker defect", async (t) => {
  const root = await project(t);
  const policy = await enable(root);
  const queued = parse(await enqueueCandidate(root, policy.generation));
  const env = await fakePi(t, missingCandidateProvenanceWorker);
  const result = await run(
    ["jobs", "run", "--job-id", queued.jobId, "--corpus-context", "project", "--project-root-path", root],
    { env },
  );
  assert.equal(result.code, 0, result.stderr);
  assert.equal(parse(result).processed[0].state, "needs-review");
  const inspected = parse(
    await run(["jobs", "show", "--job-id", queued.jobId, "--corpus-context", "project", "--project-root-path", root]),
  ).job;
  assert.match(inspected.result.review.problems.join("\n"), /invalid candidate disposition/i);
  assert.match(inspected.result.review.problems.join("\n"), /exact candidate provenance/i);
  assert.equal(inspected.result.changes[0].id, "memories/missing-candidate-provenance");
});

test("M3b1 compiler preserves deterministic discard and review dispositions", async (t) => {
  const root = await project(t);
  const policy = await enable(root);
  let queued = parse(await enqueueCandidate(root, policy.generation));
  let env = await fakePi(t, decisionWorker("discarded", "not-durable"));
  let result = await run(
    ["jobs", "run", "--job-id", queued.jobId, "--corpus-context", "project", "--project-root-path", root],
    { env },
  );
  assert.equal(result.code, 0, result.stderr);
  assert.equal(parse(result).processed[0].state, "completed");
  let inspected = parse(
    await run(["jobs", "show", "--job-id", queued.jobId, "--corpus-context", "project", "--project-root-path", root]),
  ).job;
  assert.equal(inspected.result.candidate.status, "discarded");
  assert.equal(inspected.result.candidate.reason, "not-durable");

  result = await run([
    "jobs",
    "tidy",
    "--corpus-context",
    "project",
    "--confirm-private-job-metadata-deletion",
    "--project-root-path",
    root,
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(parse(result).protectedJobs, [
    { jobId: queued.jobId, state: "completed", reason: "unacknowledged-result" },
  ]);
  assert.ok(await fs.stat(queued.jobDirectoryPath));

  const second = await enqueueCandidate(root, policy.generation, {
    claim: "A conflicting storage choice may have been approved.",
    evidence: "The exchange contains conflicting statements about storage.",
  });
  assert.equal(second.code, 0, second.stderr);
  queued = parse(second);
  env = await fakePi(t, decisionWorker("needs-review", "conflicting-evidence"));
  result = await run(
    ["jobs", "run", "--job-id", queued.jobId, "--corpus-context", "project", "--project-root-path", root],
    { env },
  );
  assert.equal(result.code, 0, result.stderr);
  assert.equal(parse(result).processed[0].state, "needs-review");
  inspected = parse(
    await run(["jobs", "show", "--job-id", queued.jobId, "--corpus-context", "project", "--project-root-path", root]),
  ).job;
  assert.equal(inspected.result.changes.length, 0);

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
  assert.equal(result.code, 8);
  assert.match(result.stderr, /unacknowledged/i);
  assert.equal(
    (
      await run([
        "jobs",
        "results",
        "acknowledge",
        "--job-id",
        queued.jobId,
        "--corpus-context",
        "project",
        "--project-root-path",
        root,
      ])
    ).code,
    0,
  );
  assert.equal(
    (
      await run([
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
      ])
    ).code,
    0,
  );
});

test("M3b1 opt-out invalidates queued inferred work but leaves explicit ingest queued", async (t) => {
  const root = await project(t);
  await fs.mkdir(path.join(root, "docs"));
  await fs.writeFile(path.join(root, "docs", "a.md"), "# Explicit artifact\n");
  const policy = await enable(root);
  const inferred = parse(await enqueueCandidate(root, policy.generation));
  const explicitResult = await run([
    "jobs",
    "enqueue",
    "artifact-ingest",
    "--corpus-context",
    "project",
    "--source-resource",
    "project:docs/a.md",
    "--ingest-instruction",
    "Compile durable knowledge from the explicit artifact.",
    "--project-root-path",
    root,
  ]);
  assert.equal(explicitResult.code, 0, explicitResult.stderr);
  const explicit = parse(explicitResult);

  const disabled = await run([
    "policy",
    "project",
    "automatic-memory",
    "disable",
    "--corpus-context",
    "project",
    "--project-root-path",
    root,
  ]);
  assert.equal(disabled.code, 0, disabled.stderr);
  assert.equal(parse(disabled).generation, 2);
  const inferredState = await waitForState(root, inferred.jobId, "cancelled");
  assert.equal(inferredState.result.reason, "automatic-memory-disabled");
  assert.equal((await waitForState(root, explicit.jobId, "queued")).state.state, "queued");
});

test("M3b1 stale running work cannot write after off and re-enable", async (t) => {
  const root = await project(t);
  const policy = await enable(root);
  const queued = parse(await enqueueCandidate(root, policy.generation));
  const marker = path.join(root, "late-write.txt");
  const lateWorker = String.raw`
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const cp = require("node:child_process");
process.on("SIGTERM", () => {});
const prompt = process.argv[process.argv.indexOf("-p") + 1];
const capsule = JSON.parse(prompt.match(/<engram-job-capsule>\n([\s\S]*?)\n<\/engram-job-capsule>/)[1]);
const reportPath = prompt.match(/<engram-worker-report-path>\n([\s\S]*?)\n<\/engram-worker-report-path>/)[1];
setTimeout(() => {
  const draft = path.join(os.tmpdir(), "engram-late-" + capsule.jobId + ".md");
  fs.writeFileSync(draft, "---\ntype: Memory\ntitle: Late memory\ndescription: A stale late inferred write.\ncapture: inferred\nsources:\n  - resource: urn:okf-engram:conversation:late\n---\n# Late\n");
  const writeResult = cp.spawnSync(process.execPath, [process.env.OKF_ENGRAM_HELPER,
    "concepts", "write", "--concept-id", "memories/late", "--document-file-path", draft,
    "--write-mode", "automatic-inferred-memory",
    "--automatic-memory-policy-generation", String(capsule.policy.generation),
    "--corpus-context", "project", "--project-root-path", capsule.corpus.projectRootPath], { encoding: "utf8" });
  fs.writeFileSync(process.env.LATE_MARKER, JSON.stringify({ code: writeResult.status, stderr: writeResult.stderr }));
  fs.writeFileSync(reportPath, JSON.stringify({ version: 1, jobId: capsule.jobId,
    candidate: { status: "discarded", conceptIds: [], reason: "policy-disabled", note: "Late result discarded." },
    outcomes: [], warnings: [] }) + "\n", { mode: 0o600, flag: "wx" });
  process.exit(0);
}, 2300);
setInterval(() => {}, 1000);
`;
  const env = { ...(await fakePi(t, lateWorker)), LATE_MARKER: marker };
  const flushing = run(
    ["jobs", "run", "--job-id", queued.jobId, "--corpus-context", "project", "--project-root-path", root],
    { env },
  );
  await waitForState(root, queued.jobId, "running");
  assert.equal(
    (
      await run([
        "policy",
        "project",
        "automatic-memory",
        "disable",
        "--corpus-context",
        "project",
        "--project-root-path",
        root,
      ])
    ).code,
    0,
  );
  const newPolicy = await enable(root);
  assert.equal(newPolicy.generation, 3);
  const flushed = await flushing;
  assert.equal(flushed.code, 0, flushed.stderr);
  assert.equal(parse(flushed).processed[0].state, "cancelled");
  const late = JSON.parse(await fs.readFile(marker, "utf8"));
  assert.equal(late.code, 4);
  assert.match(late.stderr, /AUTOMATIC_MEMORY_DISABLED/);
  assert.equal(
    (
      await run([
        "concepts",
        "read",
        "--concept-id",
        "memories/late",
        "--corpus-context",
        "project",
        "--project-root-path",
        root,
      ])
    ).code,
    7,
  );
});

test("M3b1 unacknowledged job result is compact, durable, and explicitly acknowledged", async (t) => {
  const root = await project(t);
  const policy = await enable(root);
  const queued = parse(await enqueueCandidate(root, policy.generation));
  const env = await fakePi(t, storedWorker);
  assert.equal(
    (
      await run(["jobs", "run", "--job-id", queued.jobId, "--corpus-context", "project", "--project-root-path", root], {
        env,
      })
    ).code,
    0,
  );

  let result = await run([
    "jobs",
    "results",
    "list",
    "--acknowledgement-state",
    "unacknowledged",
    "--corpus-context",
    "project",
    "--project-root-path",
    root,
  ]);
  assert.equal(result.code, 0, result.stderr);
  const pending = parse(result);
  assert.equal(pending.results.length, 1);
  assert.equal(pending.results[0].jobId, queued.jobId);
  assert.equal(pending.results[0].acknowledgementState, "unacknowledged");
  assert.equal(pending.results[0].candidate.status, "stored");
  assert.equal(JSON.stringify(pending).includes("The user approved SQLite"), false);
  const acknowledgementPath = path.join(queued.jobDirectoryPath, "result-acknowledgement.json");
  await assert.rejects(() => fs.access(acknowledgementPath), { code: "ENOENT" });

  result = await run([
    "jobs",
    "results",
    "acknowledge",
    "--job-id",
    queued.jobId,
    "--corpus-context",
    "project",
    "--project-root-path",
    root,
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(parse(result).acknowledgementState, "acknowledged");
  assert.equal((await fs.stat(acknowledgementPath)).mode & 0o777, 0o600);
  result = await run([
    "jobs",
    "results",
    "list",
    "--acknowledgement-state",
    "unacknowledged",
    "--corpus-context",
    "project",
    "--project-root-path",
    root,
  ]);
  assert.equal(parse(result).results.length, 0);
  result = await run([
    "jobs",
    "results",
    "list",
    "--acknowledgement-state",
    "acknowledged",
    "--corpus-context",
    "project",
    "--project-root-path",
    root,
  ]);
  assert.equal(parse(result).results[0].jobId, queued.jobId);
  assert.equal(parse(result).results[0].acknowledgementState, "acknowledged");

  result = await run([
    "jobs",
    "results",
    "acknowledge",
    "--job-id",
    queued.jobId,
    "--corpus-context",
    "project",
    "--project-root-path",
    root,
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(parse(result).alreadyAcknowledged, true);
});
