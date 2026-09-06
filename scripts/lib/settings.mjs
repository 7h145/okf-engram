import fs from "node:fs/promises";
import path from "node:path";
import { errors, EngramError } from "./errors.mjs";
import { atomicWrite, pathExists } from "./io.mjs";
import { rejectInternalSymlinks } from "./paths.mjs";
import { withBundleLock } from "./lock.mjs";

const SETTINGS_FILE = "settings.json";
const SETTINGS_VERSION = 2;
const VALID_AUTO_MEMORY = new Set(["on", "off"]);

async function assertInitialized(context) {
  if (!context.initialized || !(await pathExists(context.bundle))) {
    throw errors.notInitialized(context.logicalBundle);
  }
  const stat = await fs.stat(context.bundle);
  if (!stat.isDirectory()) throw errors.validation(`Bundle is not a directory: ${context.bundle}`);
}

function pathsFor(context) {
  const stateRoot = path.dirname(context.bundle);
  return {
    stateRoot,
    file: path.join(stateRoot, SETTINGS_FILE),
    logicalFile: path.join(path.dirname(context.logicalBundle), SETTINGS_FILE),
  };
}

function assertDefaultProjectContext(context) {
  if (context.method === "explicit-bundle") {
    throw errors.usage("auto-memory is available only for the default project context, not --bundle");
  }
}

function validateSettings(value, file) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw errors.validation(`Auto-memory is disabled because settings are invalid: ${file}`, {
      path: file, effective: "off", reason: "settings must be a JSON object",
    });
  }
  const keys = Object.keys(value).sort();
  const legacy = value.version === 1 && keys.length === 2
    && keys[0] === "autoMemory" && keys[1] === "version";
  const current = value.version === SETTINGS_VERSION && keys.length === 3
    && keys[0] === "autoMemory" && keys[1] === "generation" && keys[2] === "version";
  if ((!legacy && !current) || !VALID_AUTO_MEMORY.has(value.autoMemory)
      || (current && (!Number.isSafeInteger(value.generation) || value.generation < 0))) {
    throw errors.validation(`Auto-memory is disabled because settings are invalid: ${file}`, {
      path: file, effective: "off",
      reason: "expected version 2 with autoMemory on or off and a non-negative generation",
    });
  }
  return { autoMemory: value.autoMemory, generation: legacy ? 0 : value.generation };
}

async function readSettings(context) {
  const paths = pathsFor(context);
  await rejectInternalSymlinks(paths.stateRoot, paths.file);
  let text;
  try {
    text = await fs.readFile(paths.file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return {
      paths, configured: false, autoMemory: "off", generation: 0,
    };
    throw errors.validation(`Auto-memory is disabled because settings cannot be read: ${paths.logicalFile}`, {
      path: paths.logicalFile, effective: "off", reason: error.message,
    });
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw errors.validation(`Auto-memory is disabled because settings are invalid: ${paths.logicalFile}`, {
      path: paths.logicalFile, effective: "off", reason: error.message,
    });
  }
  const validated = validateSettings(value, paths.logicalFile);
  return { paths, configured: true, ...validated };
}

function publicStatus(context, state) {
  return {
    projectRoot: context.projectRoot,
    settings: state.paths.logicalFile,
    autoMemory: state.autoMemory,
    generation: state.generation,
    configured: state.configured,
    valid: true,
  };
}

export async function getAutoMemoryStatus(context, {
  tolerateInvalid = false,
  allowExplicitBundle = false,
} = {}) {
  await assertInitialized(context);
  if (context.method === "explicit-bundle") {
    if (!allowExplicitBundle) assertDefaultProjectContext(context);
    const paths = pathsFor(context);
    return {
      projectRoot: context.projectRoot,
      settings: paths.logicalFile,
      autoMemory: "off",
      generation: 0,
      configured: false,
      valid: true,
      available: false,
      issue: "Explicit bundle contexts do not inherit project automatic-memory opt-in",
    };
  }
  try {
    return publicStatus(context, await readSettings(context));
  } catch (error) {
    if (!tolerateInvalid || !(error instanceof EngramError) || error.code !== "VALIDATION_ERROR") throw error;
    const paths = pathsFor(context);
    return {
      projectRoot: context.projectRoot,
      settings: paths.logicalFile,
      autoMemory: "off",
      generation: undefined,
      configured: await pathExists(paths.file),
      valid: false,
      issue: error.message,
    };
  }
}

export async function setAutoMemory(context, value, { afterPersistLocked } = {}) {
  await assertInitialized(context);
  assertDefaultProjectContext(context);
  if (!VALID_AUTO_MEMORY.has(value)) throw errors.usage("auto-memory requires status, on, or off");
  return withBundleLock(context.bundle, async () => {
    const current = await readSettings(context);
    const generation = current.autoMemory === value ? current.generation : current.generation + 1;
    const rendered = `${JSON.stringify({
      version: SETTINGS_VERSION, autoMemory: value, generation,
    }, null, 2)}\n`;
    await rejectInternalSymlinks(current.paths.stateRoot, current.paths.file);
    await atomicWrite(current.paths.file, rendered);
    const status = publicStatus(context, {
      ...current, configured: true, autoMemory: value, generation,
    });
    if (afterPersistLocked) await afterPersistLocked(status);
    return status;
  });
}

export async function requireAutoMemoryEnabledLocked(context, expectedGeneration) {
  assertDefaultProjectContext(context);
  let state;
  try {
    state = await readSettings(context);
  } catch (error) {
    if (error instanceof EngramError && error.code === "VALIDATION_ERROR") {
      throw errors.autoMemoryDisabled(pathsFor(context).logicalFile, error.message);
    }
    throw error;
  }
  if (state.autoMemory !== "on") {
    throw errors.autoMemoryDisabled(state.paths.logicalFile);
  }
  if (expectedGeneration !== undefined && state.generation !== expectedGeneration) {
    throw errors.autoMemoryDisabled(
      state.paths.logicalFile,
      `policy generation changed from ${expectedGeneration} to ${state.generation}`,
      { expectedGeneration, generation: state.generation },
    );
  }
  return publicStatus(context, state);
}
