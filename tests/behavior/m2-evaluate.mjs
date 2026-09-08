#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { resolveProject } from "../../scripts/lib/project.mjs";
import { validateCorpus } from "../../scripts/lib/bundle.mjs";
import { scanBundle } from "../../scripts/lib/scan.mjs";
import { searchConcepts } from "../../scripts/lib/search.mjs";
import { loadManifest, verifyFixtureSources } from "./m2-fixture.mjs";

function finding(code, message, details = {}) {
  return { severity: "error", code, message, ...details };
}

function sourceItems(concept) {
  return Array.isArray(concept.data.sources)
    ? concept.data.sources.filter((item) => item && typeof item === "object" && !Array.isArray(item))
    : [];
}

function textOf(item) {
  return `${item.id}\n${item.envelope.title}\n${item.envelope.description}\n${item.concept.body}`;
}

function reportValue(value) {
  return typeof value === "string" && value && !value.startsWith("REQUIRED");
}

function internalLinks(body) {
  return [...body.matchAll(/\]\(\/([a-z0-9][a-z0-9/_-]*?)\.md(?:#[^)]+)?\)/g)].map((match) => match[1]);
}

export async function evaluateM2Run(projectRoot, { resultPath } = {}) {
  const findings = [];
  const manifest = await loadManifest();
  const verification = await verifyFixtureSources(projectRoot, manifest);
  findings.push(...verification.findings.map((item) => ({ severity: "error", ...item })));

  const context = await resolveProject({ projectRoot });
  const scan = await scanBundle(context.bundle);
  const lint = await validateCorpus(context);
  for (const issue of scan.issues.filter((item) => item.severity === "error")) {
    findings.push(finding("bundle-invalid", issue.message, { id: issue.id, issueCode: issue.code }));
  }
  if (!lint.valid) findings.push(finding("lint-failed", "Engram lint reports errors"));

  const byId = new Map(scan.concepts.map((item) => [item.id, item]));
  const allBundleText = scan.concepts.map(textOf).join("\n");
  if (
    scan.concepts.length < manifest.limits.minimumConcepts ||
    scan.concepts.length > manifest.limits.maximumConcepts
  ) {
    findings.push(
      finding(
        "concept-boundary-count",
        `Expected ${manifest.limits.minimumConcepts}-${manifest.limits.maximumConcepts} focused concepts, found ${scan.concepts.length}`,
      ),
    );
  }

  let report;
  const reportFile = resultPath ?? path.join(projectRoot, "engram-eval-result.json");
  try {
    report = JSON.parse(await fs.readFile(reportFile, "utf8"));
  } catch (error) {
    findings.push(finding("result-report", `Cannot read result report: ${error.message}`));
    report = {};
  }

  if (report.version !== 1) findings.push(finding("result-version", "Result report version must be 1"));
  for (const key of ["model", "provider", "skillRevision", "startedAt", "completedAt"]) {
    if (!reportValue(report.run?.[key])) findings.push(finding("run-metadata", `Missing run.${key}`));
  }
  if (report.run?.fixtureDigest !== verification.fixtureDigest) {
    findings.push(finding("fixture-digest", "Result report fixture digest does not match inspected source bytes"));
  }

  const coverageRows = Array.isArray(report.coverage) ? report.coverage : [];
  const coverageByResource = new Map();
  for (const row of coverageRows) {
    if (!row || typeof row.resource !== "string") continue;
    if (coverageByResource.has(row.resource)) {
      findings.push(finding("coverage-duplicate", `Duplicate coverage row for ${row.resource}`));
    } else coverageByResource.set(row.resource, row);
  }

  const actualCitations = new Map(manifest.resources.map((item) => [item.resource, []]));
  const manifestByResource = new Map(manifest.resources.map((item) => [item.resource, item]));
  for (const concept of scan.concepts) {
    for (const source of sourceItems(concept.concept)) {
      if (!actualCitations.has(source.resource)) continue;
      actualCitations.get(source.resource).push(concept.id);
      const expected = manifestByResource.get(source.resource);
      if (source.digest !== `sha256:${expected.sha256}`) {
        findings.push(finding("source-digest", `${concept.id} has a missing or wrong digest for ${source.resource}`));
      }
      if (!reportValue(source.id)) {
        findings.push(finding("source-id", `${concept.id} source ${source.resource} needs a source ID`));
      } else if (!concept.concept.body.includes(`[^${source.id}]`)) {
        findings.push(finding("claim-footnote", `${concept.id} does not reference source ID ${source.id} in its body`));
      }
      if (
        expected.selectorRequired &&
        (!source.selector || !reportValue(source.selector.kind) || !reportValue(source.selector.value))
      ) {
        findings.push(finding("source-selector", `${concept.id} needs a selector for ${source.resource}`));
      }
    }
  }

  for (const expected of manifest.resources) {
    const row = coverageByResource.get(expected.resource);
    if (!row) {
      findings.push(finding("coverage-missing", `No coverage row for ${expected.resource}`));
      continue;
    }
    if (row.state !== "cited") {
      findings.push(
        finding(
          "coverage-incomplete",
          `${expected.resource} is ${row.state}; this readable fixture requires cited coverage`,
        ),
      );
    }
    if (row.method !== expected.expectedMethod) {
      findings.push(
        finding(
          "extraction-method",
          `${expected.resource} expected method ${expected.expectedMethod}, got ${row.method}`,
        ),
      );
    }
    const cited = [...new Set(actualCitations.get(expected.resource))].sort();
    if (!cited.length)
      findings.push(finding("provenance-missing", `${expected.resource} is not cited by a persisted concept`));
    const reported = Array.isArray(row.conceptIds) ? [...new Set(row.conceptIds)].sort() : [];
    if (JSON.stringify(reported) !== JSON.stringify(cited)) {
      findings.push(
        finding("coverage-mismatch", `${expected.resource} report IDs do not match persisted citations`, {
          reported,
          actual: cited,
        }),
      );
    }
  }
  for (const resource of coverageByResource.keys()) {
    if (!manifestByResource.has(resource))
      findings.push(finding("coverage-extra", `Unexpected coverage resource ${resource}`));
  }

  const multi = actualCitations.get(manifest.oneSourceToMany.resource) ?? [];
  if (new Set(multi).size < manifest.oneSourceToMany.minimumConcepts) {
    findings.push(
      finding(
        "one-source-many",
        `${manifest.oneSourceToMany.resource} must support at least ${manifest.oneSourceToMany.minimumConcepts} concepts`,
      ),
    );
  }

  const seed = byId.get(manifest.seed.id);
  if (!seed) findings.push(finding("seed-update", `Seed concept ${manifest.seed.id} was removed or renamed`));
  else {
    for (const text of manifest.seed.mustContainAfter) {
      if (!seed.concept.text.includes(text))
        findings.push(finding("seed-update", `${manifest.seed.id} must contain ${JSON.stringify(text)}`));
    }
    for (const alternatives of manifest.seed.mustContainAnyAfter ?? []) {
      if (!alternatives.some((text) => seed.concept.text.includes(text))) {
        findings.push(
          finding("seed-update", `${manifest.seed.id} must contain one of ${JSON.stringify(alternatives)}`),
        );
      }
    }
    for (const text of manifest.seed.mustNotContainAfter) {
      if (seed.concept.text.includes(text))
        findings.push(finding("seed-update", `${manifest.seed.id} retained obsolete text ${JSON.stringify(text)}`));
    }
  }

  for (const rule of manifest.statusRules) {
    for (const id of actualCitations.get(rule.resource) ?? []) {
      const concept = byId.get(id);
      if (concept?.concept.body.includes(rule.bodyTerm) && !rule.allowed.includes(concept.envelope.status)) {
        findings.push(
          finding("status-calibration", `${id} mentions ${rule.bodyTerm} but has status ${concept.envelope.status}`),
        );
      }
    }
  }

  const retainedText = `${allBundleText}\n${JSON.stringify(report)}`.toLocaleLowerCase("en-US");
  for (const literal of [...manifest.prohibitedLiterals, ...manifest.prohibitedClaims]) {
    if (retainedText.includes(literal.toLocaleLowerCase("en-US"))) {
      findings.push(
        finding(
          "sensitive-or-unsafe-content",
          `Bundle or result report retained prohibited fixture text: ${JSON.stringify(literal)}`,
        ),
      );
    }
  }

  const planTargets = Array.isArray(report.plan?.targets) ? report.plan.targets : [];
  const planIds = new Set();
  for (const target of planTargets) {
    if (!reportValue(target?.id) || !["create", "update", "unchanged"].includes(target.action)) {
      findings.push(finding("write-inventory", "Every planned target needs an ID and create/update/unchanged action"));
      continue;
    }
    if (planIds.has(target.id)) findings.push(finding("write-inventory", `Duplicate planned target ${target.id}`));
    planIds.add(target.id);
  }
  const seedTarget = planTargets.find((item) => item.id === manifest.seed.id);
  if (!seedTarget || seedTarget.action !== "update" || !reportValue(seedTarget.expectedHash)) {
    findings.push(
      finding("write-inventory", `Seed ${manifest.seed.id} must be planned as an update with its prior hash`),
    );
  }

  const outcomes = Array.isArray(report.outcomes) ? report.outcomes : [];
  const outcomeIds = new Set();
  for (const outcome of outcomes) {
    const outcomeStatus = outcome?.status ?? outcome?.outcome ?? outcome?.action;
    const outcomeHash = outcome?.hash ?? outcome?.actualHash;
    if (
      !reportValue(outcome?.id) ||
      !["created", "updated", "unchanged", "conflicted", "failed"].includes(outcomeStatus)
    ) {
      findings.push(finding("outcome", "Every outcome needs an ID and a supported status"));
      continue;
    }
    outcomeIds.add(outcome.id);
    if (["created", "updated"].includes(outcomeStatus)) {
      const actual = byId.get(outcome.id);
      if (!actual || outcomeHash !== actual.concept.hash) {
        findings.push(finding("outcome-hash", `${outcome.id} outcome hash does not match persisted content`));
      }
    }
  }
  for (const id of planIds) {
    if (!outcomeIds.has(id))
      findings.push(finding("outcome-missing", `No actual outcome recorded for planned target ${id}`));
  }

  const reviewKeys = ["lint", "provenance", "uncertainty", "sensitiveData", "conceptBoundaries", "crossLinks"];
  for (const key of reviewKeys) {
    if (report.review?.[key] !== "pass")
      findings.push(finding("semantic-review", `review.${key} must record pass for this gate`));
  }

  const existingIds = new Set(byId.keys());
  const linkMap = new Map(scan.concepts.map((concept) => [concept.id, new Set(internalLinks(concept.concept.body))]));
  let linkCount = 0;
  for (const [id, targets] of linkMap) {
    for (const target of targets) {
      linkCount += 1;
      if (!existingIds.has(target)) findings.push(finding("broken-concept-link", `${id} links to missing ${target}`));
    }
  }
  if (linkCount < 2) findings.push(finding("cross-links", "Expected at least two meaningful internal concept links"));
  const plannedPairs = new Set();
  for (const target of planTargets) {
    for (const related of Array.isArray(target.relatedIds) ? target.relatedIds : []) {
      if (!existingIds.has(target.id) || !existingIds.has(related)) continue;
      const pair = [target.id, related].sort().join("\0");
      if (plannedPairs.has(pair)) continue;
      plannedPairs.add(pair);
      if (!linkMap.get(target.id)?.has(related) && !linkMap.get(related)?.has(target.id)) {
        findings.push(
          finding(
            "planned-link-missing",
            `Planned relationship ${target.id} ↔ ${related} has no persisted Markdown link`,
          ),
        );
      }
    }
  }

  const reportedRetrieval = Array.isArray(report.review?.retrieval) ? report.review.retrieval : [];
  for (const probe of manifest.retrievalProbes) {
    const results = searchConcepts(probe.query, scan.concepts, {
      limit: probe.top,
      includeDeprecated: probe.includeDeprecated === true,
    });
    if (probe.requiredId && !results.some((item) => item.id === probe.requiredId)) {
      findings.push(
        finding(
          "retrieval-probe",
          `${JSON.stringify(probe.query)} did not retrieve ${probe.requiredId} in top ${probe.top}`,
        ),
      );
    }
    if (probe.requiredTerms) {
      const matched = results.some((result) => {
        const candidate = byId.get(result.id);
        const haystack = textOf(candidate).toLocaleLowerCase("en-US").replace(/\s+/g, " ");
        return probe.requiredTerms.every((term) =>
          haystack.includes(term.toLocaleLowerCase("en-US").replace(/\s+/g, " ")),
        );
      });
      if (!matched)
        findings.push(
          finding(
            "retrieval-probe",
            `${JSON.stringify(probe.query)} did not retrieve all expected terms in one top-${probe.top} concept`,
          ),
        );
    }
    const reportProbe = reportedRetrieval.find((item) => item?.query === probe.query);
    if (!reportProbe || !Array.isArray(reportProbe.topIds)) {
      findings.push(
        finding("retrieval-report", `Result report is missing retrieval probe ${JSON.stringify(probe.query)}`),
      );
    }
  }

  const counts = {
    concepts: scan.concepts.length,
    requested: manifest.resources.length,
    cited: [...actualCitations.values()].filter((ids) => ids.length).length,
    findings: findings.length,
    errors: findings.filter((item) => item.severity === "error").length,
  };
  return {
    valid: counts.errors === 0,
    fixture: manifest.name,
    fixtureDigest: verification.fixtureDigest,
    projectRoot,
    counts,
    findings,
  };
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  const projectRoot = process.argv[2] ? path.resolve(process.argv[2]) : undefined;
  if (!projectRoot) {
    console.error("Usage: node tests/behavior/m2-evaluate.mjs PROJECT_ROOT [RESULT_JSON]");
    process.exit(2);
  }
  const result = await evaluateM2Run(projectRoot, {
    resultPath: process.argv[3] ? path.resolve(process.argv[3]) : undefined,
  });
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.valid ? 0 : 1;
}
