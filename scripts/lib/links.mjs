import fs from "node:fs/promises";
import path from "node:path";
import { BUNDLE_NAME, STATE_PARTS } from "./constants.mjs";
import { errors, EngramError } from "./errors.mjs";
import { atomicWrite, pathExists } from "./io.mjs";
import { inspectExistingIndexes, inspectExistingLogs, validateRootIndex } from "./index.mjs";
import { withBundleLock } from "./lock.mjs";
import { rejectInternalSymlinks } from "./paths.mjs";
import { resolveGlobal } from "./project.mjs";
import { scanBundle } from "./scan.mjs";
import { getSensitiveDataPolicyStatus } from "./settings.mjs";

const LINKS_FILE = "links.json";
const LINKS_VERSION = 1;
export const MAX_CORPUS_LINKS = 32;
const LINK_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const RESERVED_LINK_NAMES = new Set(["project", "global", "linked", "all"]);

function withCorpusContext(context, corpusContext) {
  Object.defineProperty(context, "corpusContext", {
    value: corpusContext,
    enumerable: false,
    writable: false,
  });
  return context;
}

function assertProjectRegistryContext(context) {
  if (context.corpusContext !== "project" || context.method === "explicit-bundle") {
    throw errors.usage("Corpus links are configured only for a managed project corpus");
  }
  if (!context.initialized) throw errors.notInitialized(context.logicalBundle, "project");
}

export function validateCorpusLinkName(name) {
  if (!LINK_NAME.test(name ?? "") || RESERVED_LINK_NAMES.has(name)) {
    throw errors.usage(
      "Link names must be lowercase slugs of 1–32 characters and cannot be project, global, linked, or all",
    );
  }
  return name;
}

function registryPaths(projectContext) {
  const stateRoot = path.dirname(projectContext.bundle);
  return {
    stateRoot,
    file: path.join(stateRoot, LINKS_FILE),
    logicalFile: path.join(path.dirname(projectContext.logicalBundle), LINKS_FILE),
  };
}

function emptyRegistry() {
  return { version: LINKS_VERSION, links: [] };
}

function validateRegistry(value, file) {
  const validRoot =
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    value.version === LINKS_VERSION &&
    Array.isArray(value.links) &&
    Object.keys(value).sort().join(",") === "links,version" &&
    value.links.length <= MAX_CORPUS_LINKS;
  if (!validRoot) {
    throw errors.validation(`Stored corpus links are invalid: ${file}`, {
      path: file,
      reason: `expected version ${LINKS_VERSION} with at most ${MAX_CORPUS_LINKS} links`,
    });
  }
  const names = new Set();
  for (const link of value.links) {
    const keys = link && typeof link === "object" && !Array.isArray(link) ? Object.keys(link).sort() : [];
    const valid =
      keys.join(",") === "name,path,targetKind" &&
      LINK_NAME.test(link.name ?? "") &&
      !RESERVED_LINK_NAMES.has(link.name) &&
      typeof link.path === "string" &&
      path.isAbsolute(link.path) &&
      (link.targetKind === "project" || link.targetKind === "bundle") &&
      !names.has(link.name);
    if (!valid) {
      throw errors.validation(`Stored corpus links are invalid: ${file}`, {
        path: file,
        reason: "each link requires one unique lowercase name, absolute path, and project or bundle targetKind",
      });
    }
    names.add(link.name);
  }
  return { version: LINKS_VERSION, links: value.links.map((link) => ({ ...link })) };
}

async function readRegistry(projectContext) {
  assertProjectRegistryContext(projectContext);
  const paths = registryPaths(projectContext);
  await rejectInternalSymlinks(paths.stateRoot, paths.file);
  let text;
  try {
    text = await fs.readFile(paths.file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return { paths, registry: emptyRegistry() };
    throw errors.validation(`Stored corpus links cannot be read: ${paths.logicalFile}`, {
      path: paths.logicalFile,
      reason: error.message,
    });
  }
  try {
    return { paths, registry: validateRegistry(JSON.parse(text), paths.logicalFile) };
  } catch (error) {
    if (error instanceof EngramError) throw error;
    throw errors.validation(`Stored corpus links are invalid: ${paths.logicalFile}`, {
      path: paths.logicalFile,
      reason: error.message,
    });
  }
}

async function writeRegistry(paths, registry) {
  await rejectInternalSymlinks(paths.stateRoot, paths.file);
  await atomicWrite(paths.file, `${JSON.stringify(registry, null, 2)}\n`);
}

function managedBundle(projectRoot) {
  return path.join(projectRoot, ...STATE_PARTS, BUNDLE_NAME);
}

async function isDirectory(candidate) {
  try {
    return (await fs.stat(candidate)).isDirectory();
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function hasRootIndex(bundle) {
  return isDirectory(bundle) && pathExists(path.join(bundle, "index.md"));
}

async function identifyTarget(configuredPath) {
  const projectBundle = managedBundle(configuredPath);
  const [projectCandidate, bundleCandidate] = await Promise.all([
    hasRootIndex(projectBundle),
    hasRootIndex(configuredPath),
  ]);
  if (projectCandidate && bundleCandidate) {
    throw errors.validation(`Link path is ambiguous because it is both a bundle and a project root: ${configuredPath}`);
  }
  if (projectCandidate) return { targetKind: "project", logicalBundle: projectBundle };
  if (bundleCandidate) return { targetKind: "bundle", logicalBundle: configuredPath };
  throw errors.validation(`Link path does not identify an initialized Engram/OKF bundle or project: ${configuredPath}`);
}

async function validateCompiledBundle(bundle, displayPath) {
  let stat;
  try {
    stat = await fs.stat(bundle);
  } catch (error) {
    throw errors.validation(`Linked knowledge base is unavailable: ${displayPath}`, {
      path: displayPath,
      reason: error.message,
    });
  }
  if (!stat.isDirectory()) throw errors.validation(`Linked bundle is not a directory: ${displayPath}`);
  const rootIndex = path.join(bundle, "index.md");
  try {
    const rootStat = await fs.lstat(rootIndex);
    if (rootStat.isSymbolicLink()) throw errors.unsafePath(`Symlink inside linked bundle: ${rootIndex}`);
    validateRootIndex(await fs.readFile(rootIndex, "utf8"), rootIndex);
  } catch (error) {
    if (error instanceof EngramError) throw error;
    throw errors.validation(`Linked bundle root index is unavailable or invalid: ${displayPath}`, {
      path: displayPath,
      reason: error.message,
    });
  }
  const { issues: scanIssues } = await scanBundle(bundle);
  const issues = [
    ...scanIssues,
    ...(await inspectExistingIndexes(bundle)),
    ...(await inspectExistingLogs(bundle)),
  ];
  const blocking = issues.filter((issue) => issue.severity === "error" || issue.code === "symlink");
  if (blocking.length) {
    throw errors.validation(`Linked bundle is malformed or unsafe: ${displayPath}`, { issues: blocking });
  }
  return issues;
}

function unavailableLinkError(link, error) {
  return errors.validation(`Linked knowledge base @${link.name} is unavailable: ${error.message}`, {
    linkName: link.name,
    configuredPath: link.path,
    reason: error.message,
  });
}

async function resolveEntry(projectContext, link, { validate = true } = {}) {
  let logicalBundle;
  let projectRoot;
  try {
    if (!(await isDirectory(link.path))) {
      throw errors.validation(`Configured link path is not a directory: ${link.path}`);
    }
    if (link.targetKind === "project") {
      projectRoot = await fs.realpath(link.path);
      logicalBundle = managedBundle(link.path);
    } else {
      logicalBundle = link.path;
    }
    const bundle = await fs.realpath(logicalBundle);
    if (bundle === projectContext.bundle) {
      throw errors.validation("A project cannot link to its own corpus");
    }
    const globalContext = await resolveGlobal();
    if (bundle === globalContext.bundle) {
      throw errors.validation("A project cannot link to the fixed global corpus");
    }
    const context = withCorpusContext({
      ...(projectRoot ? { projectRoot } : {}),
      logicalBundle,
      bundle,
      method: link.targetKind === "project" ? "linked-project" : "linked-bundle",
      initialized: true,
      corpusLinkName: link.name,
      configuredPath: link.path,
    }, "linked");
    const issues = validate ? await validateCompiledBundle(bundle, logicalBundle) : [];
    return { context, issues };
  } catch (error) {
    if (error instanceof EngramError) throw unavailableLinkError(link, error);
    throw unavailableLinkError(link, errors.validation(error.message));
  }
}

function policyWarnings(policy) {
  const warnings = [];
  if (policy.knowledgeMode === "unguarded") {
    warnings.push("Linked knowledge base is unguarded and relevant content may reach the active model provider");
  }
  if (policy.previouslyUnguarded === true) {
    warnings.push("Linked knowledge base was previously unguarded and stored content may still contain sensitive data");
  }
  if (policy.knowledgeMode === "unknown" || policy.previouslyUnguarded === "unknown" || policy.valid === false) {
    warnings.push("Linked knowledge-base privacy history is unknown; retrieval treats it as guarded");
  }
  return warnings;
}

async function describeResolvedLink(projectContext, link) {
  try {
    const { context, issues } = await resolveEntry(projectContext, link);
    const policy = await getSensitiveDataPolicyStatus(context, {
      tolerateInvalid: true,
      allowExplicitBundle: true,
    });
    const normalizedPolicy = context.method === "linked-bundle" || policy.valid === false
      ? { ...policy, knowledgeMode: "unknown", previouslyUnguarded: "unknown" }
      : policy;
    return {
      name: link.name,
      address: `@${link.name}`,
      configuredPath: link.path,
      targetKind: link.targetKind,
      resolvedBundlePath: context.bundle,
      available: true,
      policy: {
        knowledgeMode: normalizedPolicy.knowledgeMode,
        previouslyUnguarded: normalizedPolicy.previouslyUnguarded,
        valid: normalizedPolicy.valid,
      },
      warnings: policyWarnings(normalizedPolicy),
      issues,
    };
  } catch (error) {
    return {
      name: link.name,
      address: `@${link.name}`,
      configuredPath: link.path,
      targetKind: link.targetKind,
      available: false,
      issue: error.message,
    };
  }
}

export async function listCorpusLinks(projectContext) {
  const { paths, registry } = await readRegistry(projectContext);
  const links = await Promise.all(registry.links.map((link) => describeResolvedLink(projectContext, link)));
  const groups = new Map();
  for (const link of links.filter((item) => item.available)) {
    const names = groups.get(link.resolvedBundlePath) ?? [];
    names.push(link.name);
    groups.set(link.resolvedBundlePath, names);
  }
  for (const link of links) {
    const names = link.available ? groups.get(link.resolvedBundlePath) : undefined;
    if (names?.length > 1) {
      link.available = false;
      link.issue = `Duplicate canonical linked target shared by: ${names.join(", ")}`;
    }
  }
  return {
    projectRoot: projectContext.projectRoot,
    linksFile: paths.logicalFile,
    maximumLinks: MAX_CORPUS_LINKS,
    links,
  };
}

export async function addCorpusLink(projectContext, name, inputPath, { cwd = process.cwd() } = {}) {
  validateCorpusLinkName(name);
  const configuredPath = path.resolve(cwd, inputPath);
  const identified = await identifyTarget(configuredPath);
  const candidate = { name, path: configuredPath, targetKind: identified.targetKind };
  const { context } = await resolveEntry(projectContext, candidate);

  return withBundleLock(projectContext.bundle, async () => {
    const { paths, registry } = await readRegistry(projectContext);
    if (registry.links.some((link) => link.name === name)) {
      throw errors.conflict(`Corpus link @${name} already exists`, { linkName: name });
    }
    if (registry.links.length >= MAX_CORPUS_LINKS) {
      throw errors.validation(`A project may configure at most ${MAX_CORPUS_LINKS} corpus links`);
    }
    for (const existing of registry.links) {
      try {
        const resolved = await resolveEntry(projectContext, existing);
        if (resolved.context.bundle === context.bundle) {
          throw errors.conflict(`Corpus link @${name} duplicates @${existing.name}`, {
            linkName: name,
            duplicateLinkName: existing.name,
            bundlePath: context.bundle,
          });
        }
      } catch (error) {
        if (error instanceof EngramError && error.code === "WRITE_CONFLICT") throw error;
        // Broken existing links remain visible and do not block a distinct addition.
      }
    }
    registry.links.push(candidate);
    registry.links.sort((left, right) => left.name.localeCompare(right.name));
    await writeRegistry(paths, registry);
    return describeResolvedLink(projectContext, candidate);
  });
}

export async function removeCorpusLink(projectContext, name) {
  validateCorpusLinkName(name);
  return withBundleLock(projectContext.bundle, async () => {
    const { paths, registry } = await readRegistry(projectContext);
    const index = registry.links.findIndex((link) => link.name === name);
    if (index < 0) throw errors.notFound(`Corpus link @${name}`);
    const [removed] = registry.links.splice(index, 1);
    await writeRegistry(paths, registry);
    return {
      projectRoot: projectContext.projectRoot,
      linksFile: paths.logicalFile,
      name: removed.name,
      address: `@${removed.name}`,
      configuredPath: removed.path,
      removed: true,
    };
  });
}

export async function resolveCorpusLinks(projectContext, names) {
  const { registry } = await readRegistry(projectContext);
  const byName = new Map(registry.links.map((link) => [link.name, link]));
  const descriptors = [];
  for (const name of names) {
    validateCorpusLinkName(name);
    const link = byName.get(name);
    if (!link) throw errors.notFound(`Corpus link @${name}`);
    const { context } = await resolveEntry(projectContext, link);
    descriptors.push({ context, corpusContext: "linked", corpusLinkName: name });
  }
  return descriptors;
}
