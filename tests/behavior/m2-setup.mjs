#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { resolveProject } from "../../scripts/lib/project.mjs";
import { initializeCorpus, writeConcept } from "../../scripts/lib/bundle.mjs";
import { fixtureRoot, loadManifest, verifyFixtureSources } from "./m2-fixture.mjs";

const output = process.argv[2] ? path.resolve(process.argv[2]) : undefined;
if (!output) {
  console.error("Usage: node tests/behavior/m2-setup.mjs OUTPUT_PROJECT_ROOT");
  process.exit(2);
}

await fs.mkdir(output, { recursive: true, mode: 0o700 });
const entries = await fs.readdir(output);
if (entries.length) throw new Error(`Refusing to overwrite nonempty evaluation root: ${output}`);
await fs.cp(path.join(fixtureRoot, "sources"), path.join(output, "sources"), { recursive: true });
await fs.copyFile(path.join(fixtureRoot, "manifest.json"), path.join(output, "fixture-manifest.json"));

const manifest = await loadManifest();
const verification = await verifyFixtureSources(output, manifest);
if (verification.findings.length) throw new Error(JSON.stringify(verification.findings));

const context = await resolveProject({ projectRoot: output });
await initializeCorpus(context);
const seedDraft = await fs.readFile(path.join(fixtureRoot, manifest.seed.draft), "utf8");
const seed = await writeConcept(context, manifest.seed.id, seedDraft, {
  source: manifest.seed.draft,
});

const template = {
  version: 1,
  run: {
    model: "REQUIRED",
    provider: "REQUIRED",
    skillRevision: "REQUIRED",
    fixtureDigest: verification.fixtureDigest,
    startedAt: "REQUIRED-ISO-8601",
    completedAt: "REQUIRED-ISO-8601",
  },
  plan: {
    targets: [
      {
        id: manifest.seed.id,
        action: "update",
        expectedHash: seed.hash,
        subjects: ["authorization cache TTL"],
        sourceResources: ["project:sources/example.md"],
        relatedIds: [],
      },
    ],
  },
  coverage: manifest.resources.map((item) => ({
    resource: item.resource,
    state: "REQUIRED-cited|excluded|unreadable",
    method: item.expectedMethod,
    conceptIds: [],
    reason: "",
  })),
  outcomes: [
    {
      id: manifest.seed.id,
      status: "REQUIRED-created|updated|unchanged|conflicted|failed",
      hash: "REQUIRED-for-created-or-updated",
    },
  ],
  review: {
    lint: "REQUIRED-pass|fail",
    provenance: "REQUIRED-pass|fail",
    uncertainty: "REQUIRED-pass|fail",
    sensitiveData: "REQUIRED-pass|fail",
    conceptBoundaries: "REQUIRED-pass|fail",
    crossLinks: "REQUIRED-pass|fail",
    retrieval: manifest.retrievalProbes.map((probe) => ({
      query: probe.query,
      topIds: [],
    })),
    warnings: [],
  },
};
await fs.writeFile(path.join(output, "engram-eval-result.template.json"), `${JSON.stringify(template, null, 2)}\n`, {
  mode: 0o600,
});

console.log(
  JSON.stringify(
    {
      projectRoot: output,
      bundle: context.bundle,
      fixtureDigest: verification.fixtureDigest,
      seed: { id: manifest.seed.id, hash: seed.hash },
      resultPath: path.join(output, "engram-eval-result.json"),
    },
    null,
    2,
  ),
);
