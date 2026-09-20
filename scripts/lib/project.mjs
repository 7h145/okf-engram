import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { BUNDLE_NAME, STATE_PARTS } from "./constants.mjs";
import { errors } from "./errors.mjs";
import { pathExists } from "./io.mjs";

const execFileAsync = promisify(execFile);

async function realpathOrResolved(input) {
  const absolute = path.resolve(input);
  const missing = [];
  let cursor = absolute;

  while (!(await pathExists(cursor))) {
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    missing.unshift(path.basename(cursor));
    cursor = parent;
  }

  const realBase = await fs.realpath(cursor);
  return path.resolve(realBase, ...missing);
}

async function gitRoot(cwd) {
  try {
    const { stdout } = await execFileAsync(
      "git", ["rev-parse", "--show-toplevel"],
      { cwd, encoding: "utf8", timeout: 3_000 },
    );
    return fs.realpath(stdout.trim());
  } catch {
    return undefined;
  }
}

async function resolveExplicitProjectRoot(cwd, input) {
  const requested = path.resolve(cwd, input);
  let projectRoot;
  try {
    projectRoot = await fs.realpath(requested);
    if (!(await fs.stat(projectRoot)).isDirectory()) {
      throw errors.validation(`Project root is not a directory: ${requested}`, { path: requested });
    }
  } catch (error) {
    if (error?.name === "EngramError") throw error;
    if (error?.code === "ENOENT") throw errors.notFound(`Project root ${requested}`);
    if (error?.code === "ENOTDIR") {
      throw errors.validation(`Project root is not a directory: ${requested}`, { path: requested });
    }
    throw errors.validation(`Project root is unavailable: ${requested}`, {
      path: requested,
      reason: error?.code ?? "unknown",
    });
  }
  return projectRoot;
}

function defaultBundle(projectRoot) {
  return path.join(projectRoot, ...STATE_PARTS, BUNDLE_NAME);
}

function withCorpusContext(context, corpusContext) {
  Object.defineProperty(context, "corpusContext", {
    value: corpusContext,
    enumerable: false,
    writable: false,
  });
  return context;
}

function withProjectSourceResolution(context, available) {
  Object.defineProperty(context, "projectSourceRootAvailable", {
    value: available,
    enumerable: false,
    writable: false,
  });
  return context;
}

export async function resolveGlobal(options = {}) {
  const environment = options.env ?? process.env;
  const configuredDataHome = environment.XDG_DATA_HOME;
  if (configuredDataHome && !path.isAbsolute(configuredDataHome)) {
    throw errors.usage("XDG_DATA_HOME must be an absolute path when set");
  }
  const logicalDataHome = configuredDataHome || path.join(options.homeDirectory ?? os.homedir(), ".local", "share");
  const logicalStateRoot = path.join(logicalDataHome, "okf-engram");
  const logicalBundle = path.join(logicalStateRoot, BUNDLE_NAME);
  try {
    if ((await pathExists(logicalDataHome)) && !(await fs.stat(logicalDataHome)).isDirectory()) {
      throw errors.validation(`XDG data home is not a directory: ${logicalDataHome}`);
    }
    if ((await pathExists(logicalStateRoot)) && !(await fs.stat(logicalStateRoot)).isDirectory()) {
      throw errors.validation(`Global Engram state root is not a directory: ${logicalStateRoot}`);
    }
    const initialized = await pathExists(logicalBundle);
    if (initialized && !(await fs.stat(logicalBundle)).isDirectory()) {
      throw errors.validation(`Global Engram bundle is not a directory: ${logicalBundle}`);
    }
    return withCorpusContext(
      {
        dataHome: await realpathOrResolved(logicalDataHome),
        logicalStateRoot,
        stateRoot: await realpathOrResolved(logicalStateRoot),
        logicalBundle,
        bundle: await realpathOrResolved(logicalBundle),
        method: configuredDataHome ? "xdg-data-home" : "xdg-default",
        initialized,
      },
      "global",
    );
  } catch (error) {
    if (error?.name === "EngramError") throw error;
    throw errors.validation(`Global Engram location is unavailable: ${logicalStateRoot}`, {
      path: logicalStateRoot,
      reason: error.message,
    });
  }
}

async function nearestExistingBundle(cwd) {
  let cursor = await fs.realpath(cwd);
  for (;;) {
    const candidate = defaultBundle(cursor);
    if (await pathExists(candidate)) {
      return { projectRoot: cursor, logicalBundle: candidate, method: "ancestor" };
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) return undefined;
    cursor = parent;
  }
}

export async function resolveProject(options = {}) {
  const cwd = path.resolve(options.cwd ?? process.cwd());

  if (options.bundle) {
    const logicalBundle = path.resolve(cwd, options.bundle);
    const bundle = await realpathOrResolved(logicalBundle);
    const explicitProjectRoot = options.projectRoot
      ? await resolveExplicitProjectRoot(cwd, options.projectRoot)
      : undefined;
    const projectRoot = explicitProjectRoot ?? await gitRoot(cwd) ?? await fs.realpath(cwd);
    const defaultProjectBundle = await realpathOrResolved(defaultBundle(projectRoot));
    return withProjectSourceResolution(withCorpusContext({
      projectRoot,
      logicalBundle,
      bundle,
      method: "explicit-bundle",
      initialized: await pathExists(logicalBundle),
    }, "project"), Boolean(explicitProjectRoot) || bundle === defaultProjectBundle);
  }

  if (options.projectRoot) {
    const projectRoot = await resolveExplicitProjectRoot(cwd, options.projectRoot);
    const logicalBundle = defaultBundle(projectRoot);
    return withCorpusContext({
      projectRoot,
      logicalBundle,
      bundle: await realpathOrResolved(logicalBundle),
      method: "explicit-project-root",
      initialized: await pathExists(logicalBundle),
    }, "project");
  }

  const root = await gitRoot(cwd);
  if (root) {
    const logicalBundle = defaultBundle(root);
    return withCorpusContext({
      projectRoot: root,
      logicalBundle,
      bundle: await realpathOrResolved(logicalBundle),
      method: "git",
      initialized: await pathExists(logicalBundle),
    }, "project");
  }

  const nearest = await nearestExistingBundle(cwd);
  if (nearest) {
    return withCorpusContext({
      ...nearest,
      bundle: await fs.realpath(nearest.logicalBundle),
      initialized: true,
    }, "project");
  }

  const projectRoot = await fs.realpath(cwd);
  const logicalBundle = defaultBundle(projectRoot);
  return withCorpusContext({
    projectRoot,
    logicalBundle,
    bundle: await realpathOrResolved(logicalBundle),
    method: "cwd",
    initialized: false,
  }, "project");
}

export function requireInitialized(context) {
  if (!context.initialized) throw errors.notInitialized(context.logicalBundle, context.corpusContext);
}

function repositoryRelative(root, target) {
  const relative = path.relative(root, target);
  if (!relative || path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
    return undefined;
  }
  return relative.split(path.sep).join("/");
}

export async function gitTrackingState(context) {
  const relative = repositoryRelative(context.projectRoot, context.bundle)
    ?? repositoryRelative(context.projectRoot, context.logicalBundle);
  try {
    await execFileAsync("git", ["-C", context.projectRoot, "rev-parse", "--is-inside-work-tree"], {
      encoding: "utf8", timeout: 3_000,
    });
  } catch {
    return { repository: false, tracked: false, ignored: false };
  }

  if (!relative) return { repository: true, tracked: false, ignored: false };

  let tracked = false;
  let ignored = false;
  try {
    await execFileAsync("git", ["-C", context.projectRoot, "ls-files", "--error-unmatch", "--", relative], {
      encoding: "utf8", timeout: 3_000,
    });
    tracked = true;
  } catch {
    // Not tracked.
  }
  try {
    await execFileAsync("git", ["-C", context.projectRoot, "check-ignore", "-q", "--", relative], {
      timeout: 3_000,
    });
    ignored = true;
  } catch {
    // Not ignored.
  }
  return { repository: true, tracked, ignored };
}
