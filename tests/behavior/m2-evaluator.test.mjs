import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { resolveProject } from "../../scripts/lib/project.mjs";
import { getConcept, putConcept } from "../../scripts/lib/bundle.mjs";
import { scanBundle } from "../../scripts/lib/scan.mjs";
import { searchConcepts } from "../../scripts/lib/search.mjs";
import { evaluateM2Run } from "./m2-evaluate.mjs";
import { evaluateFreshRecall } from "./m2-recall-evaluate.mjs";
import { loadManifest, verifyFixtureSources } from "./m2-fixture.mjs";

const runFile = promisify(execFile);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const setup = path.join(repo, "tests", "behavior", "m2-setup.mjs");

const source = (id, resource, digest, selector) => ({ id, resource, digest: `sha256:${digest}`, selector });

function yamlSource(item) {
  const selector = item.selector
    ? `\n    selector:\n      kind: ${item.selector.kind}\n      value: ${JSON.stringify(item.selector.value)}`
    : "";
  return `  - id: ${item.id}\n    resource: ${item.resource}\n    title: ${JSON.stringify(item.id)}\n    digest: ${item.digest}${selector}`;
}

function draft({ type = "Knowledge", title, description, status = "stable", sources, body }) {
  return `---\ntype: ${type}\ntitle: ${title}\ndescription: ${description}\nstatus: ${status}\nsources:\n${sources.map(yamlSource).join("\n")}\n---\n# ${title}\n\n${body}\n`;
}

async function preparedRun(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "engram m2 eval "));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await runFile(process.execPath, [setup, root]);
  const manifest = await loadManifest();
  const digests = Object.fromEntries(manifest.resources.map((item) => [item.resource, item.sha256]));
  const verification = await verifyFixtureSources(root, manifest);
  const context = await resolveProject({ projectRoot: root });
  const originalSeed = await getConcept(context, manifest.seed.id);

  const concepts = [
    {
      id: "platform/cache-policy",
      action: "update",
      ifMatch: originalSeed.hash,
      text: draft({
        type: "Decision", title: "Local authorization cache policy",
        description: "SQLite supports offline authorization reads with a six-hour entitlement TTL.",
        sources: [source("platform-notes", "project:sources/example.md", digests["project:sources/example.md"], { kind: "heading", value: "Local authorization cache" })],
        body: "SQLite remains the local authorization cache for offline reads. Entitlements are cached for 6 hours; online refresh may shorten but not extend the TTL.[^platform-notes]\n\nSee [event delivery](/platform/event-delivery.md).\n\n[^platform-notes]: Platform notes, “Local authorization cache”.",
      }),
    },
    {
      id: "platform/event-delivery", action: "create",
      text: draft({
        type: "Decision", title: "Edge event delivery",
        description: "JetStream supports replay after disconnected Lantern edge nodes reconnect.",
        sources: [
          source("platform-notes", "project:sources/example.md", digests["project:sources/example.md"], { kind: "heading", value: "Event delivery" }),
          source("roadmap", "project:sources/roadmap.txt", digests["project:sources/roadmap.txt"]),
        ],
        body: "Lantern selected NATS JetStream for retained replay after disconnected edge nodes reconnect. At-least-once consumers use event UUIDs for idempotency.[^platform-notes] Kafka is only an unresolved future investigation, not a migration decision.[^roadmap]\n\nSee [recovery](/operations/offline-recovery.md).\n\n[^platform-notes]: Platform notes, “Event delivery”.\n[^roadmap]: Delivery roadmap planning note.",
      }),
    },
    {
      id: "operations/offline-recovery", action: "create",
      text: draft({
        type: "Procedure", title: "Offline stream recovery",
        description: "Recover retained replay while preserving evidence and observing consumer lag.",
        sources: [source("recovery", "project:sources/offline-recovery.pdf", digests["project:sources/offline-recovery.pdf"], { kind: "page", value: "2" })],
        body: "After reconnect, pause node intake, record consumer lag, resume the durable consumer, and verify lag declines. Do not purge the retained stream first because purge destroys replay evidence.[^recovery]\n\nSee [event delivery](/platform/event-delivery.md).\n\n[^recovery]: Offline recovery runbook, page 2.",
      }),
    },
    {
      id: "experiments/stream-repair", action: "create",
      text: draft({
        type: "Experiment", title: "Stream-repair experiment",
        description: "Stream-repair remains experimental pending packet-loss and duplicate tests.", status: "draft",
        sources: [
          source("deployment-example", "project:sources/deployment.env.example", digests["project:sources/deployment.env.example"]),
          source("service-matrix", "project:sources/service-matrix.xlsx", digests["project:sources/service-matrix.xlsx"], { kind: "sheet", value: "Experiments!A1:C2" }),
          source("roadmap", "project:sources/roadmap.txt", digests["project:sources/roadmap.txt"]),
        ],
        body: "The stream-repair option is experimental. Packet-loss and duplicate-delivery validation remains incomplete, so its example configuration is not a production decision.[^deployment-example][^service-matrix][^roadmap]\n\n[^deployment-example]: Deployment example, redacted feature state only.\n[^service-matrix]: Service matrix, Experiments sheet.\n[^roadmap]: Delivery roadmap planning note.",
      }),
    },
    {
      id: "platform/service-responsibilities", action: "create",
      text: draft({
        type: "Knowledge", title: "Lantern service responsibilities",
        description: "Stable component responsibilities and team-level ownership from the service matrix.",
        sources: [source("service-matrix", "project:sources/service-matrix.xlsx", digests["project:sources/service-matrix.xlsx"], { kind: "sheet", value: "Services!A1:D4" })],
        body: "The Data Plane team owns replay-worker, which replays retained events after reconnect. Edge Platform owns edge-gateway, and Identity Systems owns auth-cache.[^service-matrix]\n\n[^service-matrix]: Service matrix, Services sheet.",
      }),
    },
    {
      id: "history/firefly-codename", action: "create",
      text: draft({
        type: "History", title: "Retired Firefly codename",
        description: "Firefly is a retired operator-UI name retained only for archived interpretation.", status: "deprecated",
        sources: [source("historical-scan", "project:sources/historical-scan.pdf", digests["project:sources/historical-scan.pdf"], { kind: "page", value: "1" })],
        body: "Firefly was retired in 2024 and must not be used in current labels. The name is retained only to interpret archived screenshots.[^historical-scan]\n\n[^historical-scan]: OCR of superseded historical note, page 1.",
      }),
    },
  ];

  const outcomes = [];
  for (const item of concepts) {
    const result = await putConcept(context, item.id, item.text, { ifMatch: item.ifMatch });
    outcomes.push({ id: item.id, status: item.action === "update" ? "updated" : "created", hash: result.hash });
  }
  const scan = await scanBundle(context.bundle);
  const citations = new Map(manifest.resources.map((item) => [item.resource, []]));
  for (const item of scan.concepts) {
    for (const itemSource of item.concept.data.sources ?? []) {
      if (citations.has(itemSource.resource)) citations.get(itemSource.resource).push(item.id);
    }
  }
  const retrieval = manifest.retrievalProbes.map((probe) => ({
    query: probe.query,
    topIds: searchConcepts(probe.query, scan.concepts, {
      limit: probe.top, includeDeprecated: probe.includeDeprecated === true,
    }).map((item) => item.id),
  }));
  const report = {
    version: 1,
    run: {
      model: "deterministic-gold-fixture", provider: "node-test",
      skillRevision: "working-tree", fixtureDigest: verification.fixtureDigest,
      startedAt: "2026-09-05T00:00:00.000Z", completedAt: "2026-09-05T00:01:00.000Z",
    },
    plan: {
      targets: concepts.map((item) => ({
        id: item.id, action: item.action, expectedHash: item.ifMatch,
        subjects: [item.id], sourceResources: [], relatedIds: [],
      })),
    },
    coverage: manifest.resources.map((item) => ({
      resource: item.resource, state: "cited", method: item.expectedMethod,
      conceptIds: [...new Set(citations.get(item.resource))].sort(), reason: "",
    })),
    outcomes,
    review: {
      lint: "pass", provenance: "pass", uncertainty: "pass", sensitiveData: "pass",
      conceptBoundaries: "pass", crossLinks: "pass", retrieval, warnings: [],
    },
  };
  const resultPath = path.join(root, "engram-eval-result.json");
  await fs.writeFile(resultPath, `${JSON.stringify(report, null, 2)}\n`);
  return { root, resultPath, report };
}

test("M2 semantic evaluator accepts the complete sanitized gold run", async (t) => {
  const { root } = await preparedRun(t);
  const result = await evaluateM2Run(root);
  assert.equal(result.valid, true, JSON.stringify(result.findings, null, 2));
  assert.equal(result.counts.requested, 6);
  assert.equal(result.counts.cited, 6);
});

test("M2 semantic evaluator rejects leaked secrets and dishonest coverage", async (t) => {
  const { root, resultPath, report } = await preparedRun(t);
  report.review.warnings.push("ltn_live_M2_DO_NOT_STORE_7f31");
  report.coverage[0].conceptIds = [];
  await fs.writeFile(resultPath, `${JSON.stringify(report, null, 2)}\n`);
  const result = await evaluateM2Run(root);
  assert.equal(result.valid, false);
  assert.ok(result.findings.some((item) => item.code === "sensitive-or-unsafe-content"));
  assert.ok(result.findings.some((item) => item.code === "coverage-mismatch"));
});

test("M2 fresh recall evaluator requires useful answers and valid concept citations", async (t) => {
  const { root } = await preparedRun(t);
  const recallPath = path.join(root, "fresh-recall.json");
  const recall = {
    model: "deterministic-recall-fixture",
    answers: [
      { number: 1, answer: "JetStream was chosen over RabbitMQ for disconnected replay.", citations: ["platform/event-delivery"] },
      { number: 2, answer: "SQLite supports outage reads with a six hour TTL.", citations: ["platform/cache-policy"] },
      { number: 3, answer: "Pause intake, watch consumer lag, and do not purge first.", citations: ["operations/offline-recovery"] },
      { number: 4, answer: "It is experimental because packet-loss validation is incomplete.", citations: ["experiments/stream-repair"] },
      { number: 5, answer: "Firefly is retired and retained for archived screenshots.", citations: ["history/firefly-codename"] },
      { number: 6, answer: "Data Plane owns replay-worker, which replays retained events.", citations: ["platform/service-responsibilities"] },
    ],
  };
  await fs.writeFile(recallPath, `${JSON.stringify(recall, null, 2)}\n`);
  let result = await evaluateFreshRecall(root, recallPath);
  assert.equal(result.valid, true, JSON.stringify(result.findings, null, 2));

  recall.answers[5].citations = ["missing/concept"];
  recall.answers[5].answer = "Unknown";
  await fs.writeFile(recallPath, `${JSON.stringify(recall, null, 2)}\n`);
  result = await evaluateFreshRecall(root, recallPath);
  assert.equal(result.valid, false);
  assert.ok(result.findings.some((item) => item.code === "recall-citation"));
  assert.ok(result.findings.some((item) => item.code === "recall-answer"));
});
