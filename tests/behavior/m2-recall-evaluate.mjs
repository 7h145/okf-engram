#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { resolveProject } from "../../scripts/lib/project.mjs";
import { scanBundle } from "../../scripts/lib/scan.mjs";
import { loadManifest } from "./m2-fixture.mjs";

function normalized(value) {
  return String(value ?? "").toLocaleLowerCase("en-US").replace(/\s+/g, " ");
}

export async function evaluateFreshRecall(projectRoot, recallPath) {
  const findings = [];
  const manifest = await loadManifest();
  const context = await resolveProject({ projectRoot });
  const scan = await scanBundle(context.bundle);
  const byId = new Map(scan.concepts.map((item) => [item.id, item]));
  let recall;
  try {
    recall = JSON.parse(await fs.readFile(recallPath, "utf8"));
  } catch (error) {
    return {
      valid: false,
      findings: [{ code: "recall-report", message: `Cannot read fresh recall report: ${error.message}` }],
    };
  }
  if (typeof recall.model !== "string" || !recall.model.trim()) {
    findings.push({ code: "recall-model", message: "Fresh recall report must identify its model" });
  }
  const answers = Array.isArray(recall.answers) ? recall.answers : [];
  if (answers.length !== manifest.recallQuestions.length) {
    findings.push({ code: "recall-count", message: `Expected ${manifest.recallQuestions.length} answers, found ${answers.length}` });
  }
  const seen = new Set();
  for (const expected of manifest.recallQuestions) {
    const answer = answers.find((item) => item?.number === expected.number);
    if (!answer) {
      findings.push({ code: "recall-missing", message: `Missing answer ${expected.number}` });
      continue;
    }
    if (seen.has(answer.number)) findings.push({ code: "recall-duplicate", message: `Duplicate answer ${answer.number}` });
    seen.add(answer.number);
    const answerText = normalized(answer.answer);
    for (const term of expected.requiredTerms) {
      if (!answerText.includes(normalized(term))) {
        findings.push({ code: "recall-answer", message: `Answer ${expected.number} is missing ${JSON.stringify(term)}` });
      }
    }
    for (const alternatives of expected.requiredAny ?? []) {
      if (!alternatives.some((term) => answerText.includes(normalized(term)))) {
        findings.push({ code: "recall-answer", message: `Answer ${expected.number} is missing one of ${JSON.stringify(alternatives)}` });
      }
    }
    const citations = Array.isArray(answer.citations) ? answer.citations : [];
    if (!citations.length) findings.push({ code: "recall-citation", message: `Answer ${expected.number} has no concept citation` });
    let hasDeprecated = false;
    for (const id of citations) {
      const concept = byId.get(id);
      if (!concept) findings.push({ code: "recall-citation", message: `Answer ${expected.number} cites missing concept ${JSON.stringify(id)}` });
      if (concept?.envelope.status === "deprecated") hasDeprecated = true;
    }
    if (expected.requiresDeprecatedCitation && !hasDeprecated) {
      findings.push({ code: "recall-deprecated", message: `Answer ${expected.number} must cite the deprecated historical concept` });
    }
  }
  const retained = normalized(JSON.stringify(recall));
  for (const literal of manifest.prohibitedLiterals) {
    if (retained.includes(normalized(literal))) {
      findings.push({ code: "recall-sensitive", message: `Fresh recall leaked prohibited text ${JSON.stringify(literal)}` });
    }
  }
  return {
    valid: findings.length === 0,
    model: recall.model,
    answers: answers.length,
    findings,
  };
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  const projectRoot = process.argv[2] ? path.resolve(process.argv[2]) : undefined;
  const recallPath = process.argv[3] ? path.resolve(process.argv[3]) : undefined;
  if (!projectRoot || !recallPath) {
    console.error("Usage: node tests/behavior/m2-recall-evaluate.mjs PROJECT_ROOT RECALL_JSON");
    process.exit(2);
  }
  const result = await evaluateFreshRecall(projectRoot, recallPath);
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.valid ? 0 : 1;
}
