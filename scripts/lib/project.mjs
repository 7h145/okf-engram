import fs from "node:fs/promises";
import path from "node:path";
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

function defaultBundle(projectRoot) {
  return path.join(projectRoot, ...STATE_PARTS, BUNDLE_NAME);
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
    return {
      projectRoot: options.projectRoot
        ? await fs.realpath(path.resolve(cwd, options.projectRoot))
        : await gitRoot(cwd) ?? await fs.realpath(cwd),
      logicalBundle,
      bundle: await realpathOrResolved(logicalBundle),
      method: "explicit-bundle",
      initialized: await pathExists(logicalBundle),
    };
  }

  if (options.projectRoot) {
    const projectRoot = await fs.realpath(path.resolve(cwd, options.projectRoot));
    const logicalBundle = defaultBundle(projectRoot);
    return {
      projectRoot,
      logicalBundle,
      bundle: await realpathOrResolved(logicalBundle),
      method: "explicit-project-root",
      initialized: await pathExists(logicalBundle),
    };
  }

  const root = await gitRoot(cwd);
  if (root) {
    const logicalBundle = defaultBundle(root);
    return {
      projectRoot: root,
      logicalBundle,
      bundle: await realpathOrResolved(logicalBundle),
      method: "git",
      initialized: await pathExists(logicalBundle),
    };
  }

  const nearest = await nearestExistingBundle(cwd);
  if (nearest) {
    return {
      ...nearest,
      bundle: await fs.realpath(nearest.logicalBundle),
      initialized: true,
    };
  }

  const projectRoot = await fs.realpath(cwd);
  const logicalBundle = defaultBundle(projectRoot);
  return {
    projectRoot,
    logicalBundle,
    bundle: await realpathOrResolved(logicalBundle),
    method: "cwd",
    initialized: false,
  };
}

export function requireInitialized(context) {
  if (!context.initialized) throw errors.notInitialized(context.logicalBundle);
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
