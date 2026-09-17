import fs from "node:fs/promises";
import path from "node:path";
import { errors, EngramError } from "./errors.mjs";
import { atomicWrite, pathExists } from "./io.mjs";
import { rejectInternalSymlinks } from "./paths.mjs";
import { withBundleLock } from "./lock.mjs";

const SETTINGS_FILE = "settings.json";
const SETTINGS_VERSION = 4;
const AUTOMATIC_MEMORY_STATES = new Set(["on", "off"]);
const SENSITIVE_DATA_STATES = new Set(["allow", "deny"]);

async function assertInitialized(context) {
  if (!context.initialized || !(await pathExists(context.bundle))) {
    throw errors.notInitialized(context.logicalBundle, context.corpusContext);
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

function policyScope(context) {
  if (context.corpusContext === "global") return "Global";
  if (context.corpusContext === "linked") return "Linked";
  return "Project";
}

function assertManagedCorpus(context, policyName = `${policyScope(context)} policy`) {
  if (context.corpusContext === "linked") {
    throw errors.usage(`${policyName} cannot mutate a linked corpus`);
  }
  if (context.method === "explicit-bundle") {
    throw errors.usage(`${policyName} is unavailable for an explicit corpus bundle path`);
  }
}

function assertProjectCorpus(context, policyName = "Project policy") {
  assertManagedCorpus(context, policyName);
  if (context.corpusContext !== "project") {
    throw errors.usage(`${policyName} is available only in project corpus context`);
  }
}

function defaultSettings(paths) {
  return {
    paths,
    configured: false,
    automaticMemory: "off",
    generation: 0,
    sensitiveData: "deny",
    previouslyUnguarded: false,
  };
}

function validateSettings(value, file) {
  const keys = value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value).sort() : [];
  const valid =
    value?.version === SETTINGS_VERSION &&
    keys.length === 5 &&
    keys[0] === "automaticMemory" &&
    keys[1] === "generation" &&
    keys[2] === "previouslyUnguarded" &&
    keys[3] === "sensitiveData" &&
    keys[4] === "version" &&
    AUTOMATIC_MEMORY_STATES.has(value.automaticMemory) &&
    Number.isSafeInteger(value.generation) &&
    value.generation >= 0 &&
    SENSITIVE_DATA_STATES.has(value.sensitiveData) &&
    typeof value.previouslyUnguarded === "boolean" &&
    (value.sensitiveData !== "allow" || value.previouslyUnguarded);
  if (!valid) {
    throw errors.validation(`Stored policies are unavailable because settings are invalid: ${file}`, {
      path: file,
      automaticMemoryEffective: "off",
      sensitiveDataEffective: "deny",
      reason:
        "expected version 4 with automaticMemory on or off, a non-negative generation, sensitiveData allow or deny, and conservative previouslyUnguarded history",
    });
  }
  return {
    automaticMemory: value.automaticMemory,
    generation: value.generation,
    sensitiveData: value.sensitiveData,
    previouslyUnguarded: value.previouslyUnguarded,
  };
}

async function readSettings(context) {
  const paths = settingsPaths(context);
  await rejectInternalSymlinks(paths.stateRoot, paths.file);
  let text;
  try {
    text = await fs.readFile(paths.file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return defaultSettings(paths);
    throw errors.validation(`${policyScope(context)} policies are unavailable because settings cannot be read: ${paths.logicalFile}`, {
      path: paths.logicalFile,
      automaticMemoryEffective: "off",
      sensitiveDataEffective: "deny",
      reason: error.message,
    });
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw errors.validation(`${policyScope(context)} policies are unavailable because settings are invalid: ${paths.logicalFile}`, {
      path: paths.logicalFile,
      automaticMemoryEffective: "off",
      sensitiveDataEffective: "deny",
      reason: error.message,
    });
  }
  const validated = validateSettings(value, paths.logicalFile);
  if (context.corpusContext === "global" && (validated.automaticMemory !== "off" || validated.generation !== 0)) {
    throw errors.validation(`Global policies are unavailable because settings enable project-only automatic memory: ${paths.logicalFile}`, {
      path: paths.logicalFile,
      automaticMemoryEffective: "off",
      sensitiveDataEffective: "deny",
      reason: "global settings require automaticMemory off and generation 0",
    });
  }
  return { paths, configured: true, ...validated };
}

function commonPolicyStatus(context, state) {
  return {
    ...(context.corpusContext === "global" ? { dataHome: context.dataHome } : { projectRoot: context.projectRoot }),
    settings: state.paths.logicalFile,
    configured: state.configured,
    valid: true,
  };
}

function publicAutomaticMemoryStatus(context, state) {
  return {
    ...commonPolicyStatus(context, state),
    automaticMemory: state.automaticMemory,
    generation: state.generation,
  };
}

function publicSensitiveDataStatus(context, state) {
  return {
    ...commonPolicyStatus(context, state),
    sensitiveData: state.sensitiveData,
    knowledgeMode: state.sensitiveData === "allow" ? "unguarded" : "guarded",
    previouslyUnguarded: state.previouslyUnguarded,
  };
}

function settingsDocument(state) {
  return `${JSON.stringify(
    {
      version: SETTINGS_VERSION,
      automaticMemory: state.automaticMemory,
      generation: state.generation,
      sensitiveData: state.sensitiveData,
      previouslyUnguarded: state.previouslyUnguarded,
    },
    null,
    2,
  )}\n`;
}

async function writeSettings(state) {
  await rejectInternalSymlinks(state.paths.stateRoot, state.paths.file);
  await atomicWrite(state.paths.file, settingsDocument(state));
}

export async function getAutomaticMemoryPolicyStatus(
  context,
  { tolerateInvalid = false, allowExplicitBundle = false } = {},
) {
  await assertInitialized(context);
  if (context.corpusContext === "global") {
    throw errors.usage("Automatic-memory policy is unavailable in global corpus context");
  }
  if (context.method === "explicit-bundle") {
    if (!allowExplicitBundle) assertProjectCorpus(context, "Project automatic-memory policy");
    const state = defaultSettings(settingsPaths(context));
    return {
      ...publicAutomaticMemoryStatus(context, state),
      available: false,
      issue: "Explicit corpus bundles do not inherit project automatic-memory policy",
    };
  }
  try {
    return publicAutomaticMemoryStatus(context, await readSettings(context));
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

export async function getSensitiveDataPolicyStatus(
  context,
  { tolerateInvalid = false, allowExplicitBundle = false } = {},
) {
  await assertInitialized(context);
  if (context.method === "explicit-bundle" || context.method === "linked-bundle") {
    if (!allowExplicitBundle) assertManagedCorpus(context, "Project sensitive-data policy");
    const state = defaultSettings(settingsPaths(context));
    return {
      ...publicSensitiveDataStatus(context, state),
      ...(context.method === "linked-bundle" ? { knowledgeMode: "unknown" } : {}),
      previouslyUnguarded: "unknown",
      available: false,
      issue: "Explicit corpus bundles do not inherit managed sensitive-data policy",
    };
  }
  try {
    return publicSensitiveDataStatus(context, await readSettings(context));
  } catch (error) {
    if (!tolerateInvalid || !(error instanceof EngramError) || error.code !== "VALIDATION_ERROR") throw error;
    const paths = settingsPaths(context);
    return {
      ...(context.corpusContext === "global"
        ? { dataHome: context.dataHome }
        : context.projectRoot
          ? { projectRoot: context.projectRoot }
          : {}),
      settings: paths.logicalFile,
      sensitiveData: "deny",
      knowledgeMode: context.corpusContext === "linked" ? "unknown" : "guarded",
      previouslyUnguarded: "unknown",
      configured: await pathExists(paths.file),
      valid: false,
      issue: error.message,
    };
  }
}

export async function setAutomaticMemoryPolicy(context, value, { afterPersistLocked } = {}) {
  await assertInitialized(context);
  assertProjectCorpus(context, "Project automatic-memory policy");
  if (!AUTOMATIC_MEMORY_STATES.has(value)) {
    throw errors.usage("Automatic-memory policy value must be on or off");
  }
  return withBundleLock(context.bundle, async () => {
    const current = await readSettings(context);
    const generation = current.automaticMemory === value ? current.generation : current.generation + 1;
    const next = { ...current, configured: true, automaticMemory: value, generation };
    await writeSettings(next);
    const status = publicAutomaticMemoryStatus(context, next);
    if (afterPersistLocked) await afterPersistLocked(status);
    return status;
  });
}

export async function setSensitiveDataPolicy(context, value) {
  await assertInitialized(context);
  assertManagedCorpus(context, `${policyScope(context)} sensitive-data policy`);
  if (!SENSITIVE_DATA_STATES.has(value)) {
    throw errors.usage("Sensitive-data policy value must be allow or deny");
  }
  return withBundleLock(context.bundle, async () => {
    const current = await readSettings(context);
    const next = {
      ...current,
      configured: true,
      sensitiveData: value,
      previouslyUnguarded: current.previouslyUnguarded || value === "allow",
    };
    await writeSettings(next);
    return publicSensitiveDataStatus(context, next);
  });
}

export async function requireAutomaticMemoryEnabledLocked(context, expectedGeneration) {
  assertProjectCorpus(context, "Project automatic-memory policy");
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
  return publicAutomaticMemoryStatus(context, state);
}
