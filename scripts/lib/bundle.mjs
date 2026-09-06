import fs from "node:fs/promises";
import path from "node:path";
import { parseConcept, normalizeGenerated, renderConcept, appendDeprecation } from "./document.mjs";
import { validateConcept } from "./validate.mjs";
import { conceptPath, rejectInternalSymlinks } from "./paths.mjs";
import { atomicWrite, pathExists } from "./io.mjs";
import { errors } from "./errors.mjs";
import { sha256 } from "./hash.mjs";
import { withBundleLock } from "./lock.mjs";
import { scanBundle } from "./scan.mjs";
import {
  indexDrift, inspectExistingIndexes, inspectExistingLogs, validateRootIndex, writeIndexes,
} from "./index.mjs";
import { searchConcepts } from "./search.mjs";
import { digestResource } from "./sources.mjs";
import { resolvePinnedSource } from "./git-sources.mjs";
import { gitTrackingState } from "./project.mjs";
import { getAutoMemoryStatus, requireAutoMemoryEnabledLocked } from "./settings.mjs";

async function assertBundle(context) {
  if (!context.initialized || !(await pathExists(context.bundle))) {
    throw errors.notInitialized(context.logicalBundle);
  }
  const stat = await fs.stat(context.bundle);
  if (!stat.isDirectory()) throw errors.validation(`Bundle is not a directory: ${context.bundle}`);
}

export async function initializeBundle(context) {
  await fs.mkdir(context.bundle, { recursive: true, mode: 0o700 });
  const canonicalBundle = await fs.realpath(context.bundle);
  context.bundle = canonicalBundle;
  context.initialized = true;

  return withBundleLock(context.bundle, async () => {
    const entries = await fs.readdir(context.bundle);
    if (entries.length) {
      const rootIndex = path.join(context.bundle, "index.md");
      if (!(await pathExists(rootIndex))) {
        throw errors.validation(`Refusing to initialize non-empty non-OKF directory: ${context.bundle}`);
      }
      await rejectInternalSymlinks(context.bundle, rootIndex);
      validateRootIndex(await fs.readFile(rootIndex, "utf8"), rootIndex);
      const { issues: conceptIssues } = await scanBundle(context.bundle);
      const indexIssues = await inspectExistingIndexes(context.bundle);
      const logIssues = await inspectExistingLogs(context.bundle);
      const errorsFound = [...conceptIssues, ...indexIssues, ...logIssues].filter((issue) => (
        issue.severity === "error" || issue.code === "symlink"
      ));
      if (errorsFound.length) {
        throw errors.validation(`Refusing to initialize invalid existing bundle: ${context.bundle}`, {
          issues: errorsFound,
        });
      }
      return {
        created: false,
        projectRoot: context.projectRoot,
        logicalBundle: context.logicalBundle,
        bundle: context.bundle,
      };
    }
    const { concepts } = await scanBundle(context.bundle);
    await writeIndexes(concepts, context.bundle);
    return {
      created: true,
      projectRoot: context.projectRoot,
      logicalBundle: context.logicalBundle,
      bundle: context.bundle,
    };
  });
}

export async function getConcept(context, id) {
  await assertBundle(context);
  const file = conceptPath(context.bundle, id);
  await rejectInternalSymlinks(context.bundle, file);
  let text;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") throw errors.notFound(`Concept ${id}`);
    throw error;
  }
  const concept = parseConcept(text, id);
  return { id, path: file, hash: sha256(text), text, data: concept.data, body: concept.body };
}

function assertValid(concept) {
  const result = validateConcept(concept);
  if (!result.valid) {
    throw errors.validation(`Concept validation failed: ${result.errors.join("; ")}`, result);
  }
  return result;
}

async function writeConceptLocked(context, id, concept, {
  ifMatch,
  operation = "put",
  testHooks,
} = {}) {
  const file = conceptPath(context.bundle, id);
  await rejectInternalSymlinks(context.bundle, file);
  let current;
  try {
    current = await fs.readFile(file, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  if (current !== undefined) {
    if (!ifMatch) throw errors.conflict(`Concept ${id} already exists; replacement requires --if-match`);
    const currentHash = sha256(current);
    if (currentHash !== ifMatch) {
      throw errors.conflict(`Concept ${id} changed since it was read`, {
        expected: ifMatch, actual: currentHash,
      });
    }
  } else if (ifMatch) {
    throw errors.conflict(`Concept ${id} no longer exists`, { expected: ifMatch });
  }

  normalizeGenerated(concept);
  const validation = assertValid(concept);
  const rendered = renderConcept(concept);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await rejectInternalSymlinks(context.bundle, file);
  await testHooks?.beforeConceptWrite?.();
  await atomicWrite(file, rendered);
  const hash = sha256(rendered);
  await testHooks?.afterConceptWrite?.();
  let indexResult;
  try {
    const { concepts } = await scanBundle(context.bundle);
    indexResult = await writeIndexes(concepts, context.bundle);
  } catch (error) {
    throw errors.persistedIndexStale({ operation, id, path: file, hash }, error);
  }
  return {
    id,
    path: file,
    hash,
    warnings: [...validation.warnings, ...indexResult.issues.map((issue) => issue.message)],
  };
}

export async function putConcept(context, id, draftText, options = {}) {
  await assertBundle(context);
  const concept = parseConcept(draftText, options.source ?? "draft");
  assertValid(concept);
  if (options.automaticMemory && !(concept.data.type === "Memory" && concept.data.capture === "inferred")) {
    throw errors.usage("--automatic-memory requires a Memory concept with capture: inferred");
  }
  return withBundleLock(context.bundle, async () => {
    if (options.automaticMemory) await requireAutoMemoryEnabledLocked(context);
    return writeConceptLocked(context, id, concept, options);
  });
}

export async function listConcepts(context, { type } = {}) {
  await assertBundle(context);
  const { concepts, issues } = await scanBundle(context.bundle);
  return {
    concepts: concepts.filter((item) => !type || item.envelope.type === type).map((item) => item.envelope),
    issues,
  };
}

export async function searchBundle(context, query, options = {}) {
  await assertBundle(context);
  const { concepts, issues } = await scanBundle(context.bundle);
  return { results: searchConcepts(query, concepts, options), issues };
}

function markdownLinks(body) {
  const links = [];
  const regex = /(?<!!)\[[^\]]*\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g;
  for (const match of body.matchAll(regex)) links.push(match[1]);
  return links;
}

async function linkIssues(bundle, concepts) {
  const issues = [];
  for (const item of concepts) {
    for (const rawLink of markdownLinks(item.concept.body)) {
      const link = rawLink.split("#")[0];
      if (!link || /^[a-z][a-z0-9+.-]*:/i.test(link)) continue;
      let decoded;
      try {
        decoded = decodeURIComponent(link);
      } catch {
        issues.push({
          severity: "warning", category: "profile", code: "invalid-link", id: item.id,
          message: `Invalid percent encoding in link: ${rawLink}`,
        });
        continue;
      }
      const target = decoded.startsWith("/")
        ? path.join(bundle, decoded.slice(1))
        : path.resolve(path.dirname(item.path), decoded);
      const relative = path.relative(bundle, target);
      if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
      if (!(await pathExists(target))) issues.push({
        severity: "warning", category: "profile", code: "broken-link", id: item.id,
        message: `Broken bundle link: ${rawLink}`,
      });
    }
  }
  return issues;
}

export async function checkSources(context, id) {
  await assertBundle(context);
  const { concepts } = await scanBundle(context.bundle);
  const selected = id ? concepts.filter((item) => item.id === id) : concepts;
  if (id && !selected.length) throw errors.notFound(`Concept ${id}`);
  const results = [];
  for (const item of selected) {
    const sources = item.concept.data.sources;
    if (sources === undefined) continue;
    if (!Array.isArray(sources)) {
      results.push({ id: item.id, state: "invalid", error: "sources must be a list" });
      continue;
    }
    for (const source of sources) {
      if (!source || typeof source !== "object" || Array.isArray(source)) {
        results.push({ id: item.id, state: "invalid", error: "source entry must be a mapping" });
        continue;
      }
      if (typeof source.resource !== "string" || !source.resource.trim()) {
        results.push({ id: item.id, state: "invalid", error: "source resource must be a non-empty string" });
        continue;
      }
      if (!source.digest || !/^(?:project:|file:)/.test(source.resource)) continue;
      if (!/^sha256:[0-9a-f]{64}$/.test(source.digest)) {
        results.push({
          id: item.id, resource: source.resource, expected: source.digest,
          state: "invalid", error: "source digest must be sha256:<64 lowercase hex characters>",
        });
        continue;
      }
      let gitState;
      let gitError;
      if (source.git !== undefined) {
        const immutable = await resolvePinnedSource(context, source, { verifyOnly: true });
        gitState = immutable.state === "resolved" ? "verified" : immutable.reason;
        gitError = immutable.error;
      }
      try {
        const actual = (await digestResource(source.resource, context.projectRoot)).digest;
        results.push({
          id: item.id, sourceId: source.id, resource: source.resource,
          expected: source.digest, actual,
          state: actual === source.digest ? "unchanged" : "changed",
          gitState, gitError,
        });
      } catch (error) {
        results.push({
          id: item.id, sourceId: source.id, resource: source.resource,
          expected: source.digest,
          state: error.code === "NOT_FOUND" ? "missing" : "unresolvable",
          error: error.message, gitState, gitError,
        });
      }
    }
  }
  return results;
}

export async function lintBundle(context, { fix = false } = {}) {
  await assertBundle(context);
  const inspect = async () => {
    const { concepts, issues: scanIssues } = await scanBundle(context.bundle);
    const issues = [
      ...scanIssues,
      ...await linkIssues(context.bundle, concepts),
      ...await inspectExistingLogs(context.bundle),
    ];
    const { drift, issues: indexIssues } = await indexDrift(concepts, context.bundle);
    issues.push(...indexIssues);
    drift.forEach(({ file, reason }) => issues.push({
      severity: "warning", category: "derived", code: "index-drift", path: file,
      message: `Generated index is ${reason}`,
    }));
    const sources = await checkSources(context);
    sources.filter((item) => item.state !== "unchanged").forEach((item) => issues.push({
      severity: "warning",
      category: "profile",
      code: item.state === "invalid" ? "source-invalid" : "source-drift",
      id: item.id,
      message: item.state === "invalid"
        ? item.error
        : `${item.resource} is ${item.state}`,
    }));
    sources.filter((item) => item.gitState && item.gitState !== "verified").forEach((item) => issues.push({
      severity: "warning",
      category: "profile",
      code: "source-git-unavailable",
      id: item.id,
      message: `${item.resource} immutable Git source is ${item.gitState}`,
    }));
    return { concepts, drift, issues };
  };
  const run = async () => {
    let report = await inspect();
    let fixed = [];
    if (fix && report.drift.length && !report.issues.some((issue) => issue.severity === "error")) {
      const result = await writeIndexes(report.concepts, context.bundle);
      fixed = result.files;
      report = await inspect();
    }
    return {
      valid: !report.issues.some((issue) => issue.severity === "error"),
      counts: {
        concepts: report.concepts.length,
        errors: report.issues.filter((issue) => issue.severity === "error").length,
        warnings: report.issues.filter((issue) => issue.severity === "warning").length,
      },
      issues: report.issues,
      fixed,
    };
  };
  return fix ? withBundleLock(context.bundle, run) : run();
}

export async function reindexBundle(context) {
  await assertBundle(context);
  return withBundleLock(context.bundle, async () => {
    const { concepts } = await scanBundle(context.bundle);
    return writeIndexes(concepts, context.bundle);
  });
}

export async function statusBundle(context) {
  await assertBundle(context);
  const { concepts, issues } = await scanBundle(context.bundle);
  const { drift, issues: indexIssues } = await indexDrift(concepts, context.bundle);
  const git = await gitTrackingState(context);
  const sources = await checkSources(context);
  const autoMemory = await getAutoMemoryStatus(context, {
    tolerateInvalid: true,
    allowExplicitBundle: true,
  });
  const sourceStates = {};
  const gitSourceStates = {};
  for (const item of sources) {
    sourceStates[item.state] = (sourceStates[item.state] ?? 0) + 1;
    if (item.gitState) gitSourceStates[item.gitState] = (gitSourceStates[item.gitState] ?? 0) + 1;
  }
  const byType = {};
  for (const item of concepts) byType[item.envelope.type] = (byType[item.envelope.type] ?? 0) + 1;
  return {
    projectRoot: context.projectRoot,
    logicalBundle: context.logicalBundle,
    bundle: context.bundle,
    concepts: concepts.length,
    byType,
    parseErrors: issues.filter((issue) => issue.severity === "error").length,
    indexDrift: drift.length,
    indexIssues,
    sourceStates,
    gitSourceStates,
    autoMemory,
    git,
  };
}

export async function deprecateConcept(context, id, { reason, ifMatch }) {
  await assertBundle(context);
  if (!reason) throw errors.usage("deprecate requires --reason");
  return withBundleLock(context.bundle, async () => {
    const file = conceptPath(context.bundle, id);
    await rejectInternalSymlinks(context.bundle, file);
    let text;
    try {
      text = await fs.readFile(file, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") throw errors.notFound(`Concept ${id}`);
      throw error;
    }
    const concept = appendDeprecation(parseConcept(text, id), reason);
    return writeConceptLocked(context, id, concept, { ifMatch, operation: "deprecate" });
  });
}

export async function deleteConcept(context, id, { ifMatch, yes = false }) {
  await assertBundle(context);
  if (!yes) throw errors.confirmation(
    "Deletion requires --yes; current-tree removal cannot erase Git history, sessions, backups, remotes, or clones",
  );
  if (!ifMatch) throw errors.conflict("Deletion requires --if-match with the current concept hash");
  return withBundleLock(context.bundle, async () => {
    const file = conceptPath(context.bundle, id);
    await rejectInternalSymlinks(context.bundle, file);
    let text;
    try {
      text = await fs.readFile(file, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") throw errors.notFound(`Concept ${id}`);
      throw error;
    }
    const actual = sha256(text);
    if (actual !== ifMatch) throw errors.conflict(`Concept ${id} changed since it was read`, {
      expected: ifMatch, actual,
    });
    await fs.unlink(file);
    let indexResult;
    try {
      const { concepts } = await scanBundle(context.bundle);
      indexResult = await writeIndexes(concepts, context.bundle);
    } catch (error) {
      throw errors.persistedIndexStale({
        operation: "delete", id, path: file, deleted: true,
      }, error);
    }
    return {
      id,
      deleted: true,
      warning: "Removed from current bundle only; history and external copies may retain content",
      indexWarnings: indexResult.issues,
    };
  });
}
