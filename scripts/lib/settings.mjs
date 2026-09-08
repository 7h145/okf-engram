import fs from "node:fs/promises";
import path from "node:path";
import { errors, EngramError } from "./errors.mjs";
import { atomicWrite, pathExists } from "./io.mjs";
import { rejectInternalSymlinks } from "./paths.mjs";
import { withBundleLock } from "./lock.mjs";

const SETTINGS_FILE = "settings.json";
const SETTINGS_VERSION = 3;
const AUTOMATIC_MEMORY_STATES = new Set(["on", "off"]);

async function assertInitialized(context) {
  if (!context.initialized || !(await pathExists(context.bundle))) {
    throw errors.notInitialized(context.logicalBundle);
  }
  const stat = await fs.stat(context.bundle);
  if (!stat.isDirectory()) throw errors.validation(`Bundle is not a directory: ${context.bundle}`);
}

function settingsPaths(context) {
  const stateRoot = path.dirname(context.bundle);
  return {
    stateRoot,
    file: path.join(stateRoot, SETTINGS_FILE),
    logicalFile: path.join(path.dirname(context.logicalBundle), SETTINGS_FILE),
  };
}

function assertDefaultProjectCorpus(context) {
  if (context.method === "explicit-bundle") {
    throw errors.usage("Project automatic-memory policy is unavailable for an explicit corpus bundle path");
  }
}

function validateSettings(value, file) {
  const keys = value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value).sort() : [];
  const valid =
    value?.version === SETTINGS_VERSION &&
    keys.length === 3 &&
    keys[0] === "automaticMemory" &&
    keys[1] === "generation" &&
    keys[2] === "version" &&
    AUTOMATIC_MEMORY_STATES.has(value.automaticMemory) &&
    Number.isSafeInteger(value.generation) &&
    value.generation >= 0;
  if (!valid) {
    throw errors.validation(`Automatic memory is disabled because settings are invalid: ${file}`, {
      path: file,
      effective: "off",
      reason: "expected version 3 with automaticMemory on or off and a non-negative generation",
    });
  }
  return { automaticMemory: value.automaticMemory, generation: value.generation };
}

async function readSettings(context) {
  const paths = settingsPaths(context);
  await rejectInternalSymlinks(paths.stateRoot, paths.file);
  let text;
  try {
    text = await fs.readFile(paths.file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return { paths, configured: false, automaticMemory: "off", generation: 0 };
    }
    throw errors.validation(`Automatic memory is disabled because settings cannot be read: ${paths.logicalFile}`, {
      path: paths.logicalFile,
      effective: "off",
      reason: error.message,
    });
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw errors.validation(`Automatic memory is disabled because settings are invalid: ${paths.logicalFile}`, {
      path: paths.logicalFile,
      effective: "off",
      reason: error.message,
    });
  }
  return { paths, configured: true, ...validateSettings(value, paths.logicalFile) };
}

function publicPolicyStatus(context, state) {
  return {
    projectRoot: context.projectRoot,
    settings: state.paths.logicalFile,
    automaticMemory: state.automaticMemory,
    generation: state.generation,
    configured: state.configured,
    valid: true,
  };
}

export async function getAutomaticMemoryPolicyStatus(
  context,
  { tolerateInvalid = false, allowExplicitBundle = false } = {},
) {
  await assertInitialized(context);
  if (context.method === "explicit-bundle") {
    if (!allowExplicitBundle) assertDefaultProjectCorpus(context);
    const paths = settingsPaths(context);
    return {
      projectRoot: context.projectRoot,
      settings: paths.logicalFile,
      automaticMemory: "off",
      generation: 0,
      configured: false,
      valid: true,
      available: false,
      issue: "Explicit corpus bundles do not inherit project automatic-memory policy",
    };
  }
  try {
    return publicPolicyStatus(context, await readSettings(context));
  } catch (error) {
    if (!tolerateInvalid || !(error instanceof EngramError) || error.code !== "VALIDATION_ERROR") throw error;
    const paths = settingsPaths(context);
    return {
      projectRoot: context.projectRoot,
      settings: paths.logicalFile,
      automaticMemory: "off",
      generation: undefined,
      configured: await pathExists(paths.file),
      valid: false,
      issue: error.message,
    };
  }
}

export async function setAutomaticMemoryPolicy(context, value, { afterPersistLocked } = {}) {
  await assertInitialized(context);
  assertDefaultProjectCorpus(context);
  if (!AUTOMATIC_MEMORY_STATES.has(value)) {
    throw errors.usage("Automatic-memory policy value must be on or off");
  }
  return withBundleLock(context.bundle, async () => {
    const current = await readSettings(context);
    const generation = current.automaticMemory === value ? current.generation : current.generation + 1;
    const rendered = `${JSON.stringify(
      {
        version: SETTINGS_VERSION,
        automaticMemory: value,
        generation,
      },
      null,
      2,
    )}\n`;
    await rejectInternalSymlinks(current.paths.stateRoot, current.paths.file);
    await atomicWrite(current.paths.file, rendered);
    const status = publicPolicyStatus(context, {
      ...current,
      configured: true,
      automaticMemory: value,
      generation,
    });
    if (afterPersistLocked) await afterPersistLocked(status);
    return status;
  });
}

export async function requireAutomaticMemoryEnabledLocked(context, expectedGeneration) {
  assertDefaultProjectCorpus(context);
  let state;
  try {
    state = await readSettings(context);
  } catch (error) {
    if (error instanceof EngramError && error.code === "VALIDATION_ERROR") {
      throw errors.automaticMemoryDisabled(settingsPaths(context).logicalFile, error.message);
    }
    throw error;
  }
  if (state.automaticMemory !== "on") {
    throw errors.automaticMemoryDisabled(state.paths.logicalFile);
  }
  if (expectedGeneration !== undefined && state.generation !== expectedGeneration) {
    throw errors.automaticMemoryDisabled(
      state.paths.logicalFile,
      `policy generation changed from ${expectedGeneration} to ${state.generation}`,
      { expectedGeneration, generation: state.generation },
    );
  }
  return publicPolicyStatus(context, state);
}
