import fs from "node:fs/promises";
import path from "node:path";
import { atomicWrite, pathExists } from "./io.mjs";
import { errors } from "./errors.mjs";
import { withBundleLock } from "./lock.mjs";

export const PROJECT_WIRING_START = "<!-- okf-engram:project-wiring:start -->";
export const PROJECT_WIRING_END = "<!-- okf-engram:project-wiring:end -->";
export const PROJECT_WIRING_BLOCK = `${PROJECT_WIRING_START}
## Engram project memory

Use the \`okf-engram\` skill when work requires project knowledge, prior rationale,
explicit memory, or establishes a durable project decision worth retaining.
Follow the skill’s policy before inferring memory. Using the skill is not
permission to initialize Engram or enable automatic memory; do either only on an
explicit user request.
${PROJECT_WIRING_END}`;

function countOccurrences(text, value) {
  let count = 0;
  let offset = 0;
  for (;;) {
    const index = text.indexOf(value, offset);
    if (index < 0) return count;
    count += 1;
    offset = index + value.length;
  }
}

function classify(text) {
  const starts = countOccurrences(text, PROJECT_WIRING_START);
  const ends = countOccurrences(text, PROJECT_WIRING_END);
  if (starts === 0 && ends === 0) {
    return { state: "not-installed", installed: false };
  }
  if (starts !== 1 || ends !== 1) {
    return { state: "malformed", installed: false, starts, ends };
  }
  const blockOffset = text.indexOf(PROJECT_WIRING_BLOCK);
  const suffix = blockOffset === 0 ? text.slice(PROJECT_WIRING_BLOCK.length) : undefined;
  if (blockOffset !== 0 || !(suffix === "" || suffix === "\n" || suffix.startsWith("\n\n"))) {
    return { state: "modified", installed: false, starts, ends };
  }
  return { state: "installed", installed: true, starts, ends, blockOffset };
}

async function readWiringFile(context) {
  const file = path.join(context.projectRoot, "AGENTS.md");
  let stat;
  try {
    stat = await fs.lstat(file);
  } catch (error) {
    if (error.code === "ENOENT") {
      return {
        projectRoot: context.projectRoot,
        path: file,
        exists: false,
        text: "",
        mode: 0o644,
        ...classify(""),
      };
    }
    throw error;
  }
  if (stat.isSymbolicLink()) {
    throw errors.unsafePath(`Project AGENTS.md must not be a symlink: ${file}`, { path: file });
  }
  if (!stat.isFile()) {
    throw errors.unsafePath(`Project AGENTS.md must be a regular file: ${file}`, { path: file });
  }
  const bytes = await fs.readFile(file);
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) throw errors.wiringEncoding(file);
  return {
    projectRoot: context.projectRoot,
    path: file,
    exists: true,
    text,
    mode: stat.mode & 0o777,
    ...classify(text),
  };
}

function publicStatus(status) {
  const result = { ...status };
  delete result.text;
  delete result.mode;
  delete result.blockOffset;
  return result;
}

function assertCanonicalOrAbsent(status) {
  if (status.state === "modified") throw errors.wiringModified(status.path);
  if (status.state === "malformed") {
    throw errors.wiringMalformed(status.path, { starts: status.starts, ends: status.ends });
  }
}

async function requireInitializedBundle(context) {
  if (!context.initialized || !(await pathExists(context.bundle))) {
    throw errors.notInitialized(context.logicalBundle);
  }
  const stat = await fs.stat(context.bundle);
  if (!stat.isDirectory()) throw errors.validation(`Bundle is not a directory: ${context.bundle}`);
}

export async function inspectProjectWiring(context, { preview = false } = {}) {
  const status = await readWiringFile(context);
  return {
    action: preview ? "preview" : "status",
    ...publicStatus(status),
    ...(preview ? {
      block: PROJECT_WIRING_BLOCK,
      canInstall: ["not-installed", "installed"].includes(status.state),
      wouldChange: status.state === "not-installed",
    } : {}),
  };
}

export async function installProjectWiring(context) {
  await requireInitializedBundle(context);
  return withBundleLock(context.bundle, async () => {
    const status = await readWiringFile(context);
    assertCanonicalOrAbsent(status);
    if (status.installed) {
      return { action: "install", changed: false, created: false, ...publicStatus(status) };
    }
    const text = status.exists
      ? `${PROJECT_WIRING_BLOCK}\n\n${status.text}`
      : `${PROJECT_WIRING_BLOCK}\n`;
    await atomicWrite(status.path, text, { mode: status.mode });
    return {
      action: "install",
      changed: true,
      created: !status.exists,
      ...publicStatus(await readWiringFile(context)),
    };
  });
}

export async function removeProjectWiring(context) {
  const remove = async () => {
    const status = await readWiringFile(context);
    assertCanonicalOrAbsent(status);
    if (!status.installed) {
      return {
        action: "remove", changed: false, deletedFile: false, ...publicStatus(status),
      };
    }

    const suffix = status.text.slice(PROJECT_WIRING_BLOCK.length);
    const text = suffix.startsWith("\n\n") ? suffix.slice(2) : suffix;
    if (text === "" || text === "\n") {
      await fs.unlink(status.path);
      return {
        action: "remove",
        changed: true,
        deletedFile: true,
        ...publicStatus(await readWiringFile(context)),
      };
    }
    await atomicWrite(status.path, text, { mode: status.mode });
    return {
      action: "remove",
      changed: true,
      deletedFile: false,
      ...publicStatus(await readWiringFile(context)),
    };
  };

  if (context.initialized && await pathExists(context.bundle)) {
    const stat = await fs.stat(context.bundle);
    if (!stat.isDirectory()) throw errors.validation(`Bundle is not a directory: ${context.bundle}`);
    return withBundleLock(context.bundle, remove);
  }
  return remove();
}
