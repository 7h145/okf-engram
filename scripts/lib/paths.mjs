import fs from "node:fs/promises";
import path from "node:path";
import { RESERVED_BASENAMES } from "./constants.mjs";
import { errors } from "./errors.mjs";

const MAX_PATH_COMPONENT_BYTES = 255;
const CONCEPT_FILE_SUFFIX_BYTES = Buffer.byteLength(".md", "utf8");

export function validateConceptId(id) {
  if (typeof id !== "string" || id.length === 0 || id.includes("\0")) {
    throw errors.unsafePath("Concept ID must be a non-empty string");
  }
  if (path.isAbsolute(id) || id.includes("\\")) {
    throw errors.unsafePath(`Unsafe concept ID: ${id}`);
  }
  const parts = id.split("/");
  const windowsDevice = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
  const unsafePart = parts.find((part, index) => (
    !part
    || part === "."
    || part === ".."
    || part.startsWith(".")
    || /[<>:"|?*]/u.test(part)
    || [...part].some((character) => character.codePointAt(0) < 32)
    || /[. ]$/.test(part)
    || windowsDevice.test(part)
    || Buffer.byteLength(part, "utf8") > (
      index === parts.length - 1
        ? MAX_PATH_COMPONENT_BYTES - CONCEPT_FILE_SUFFIX_BYTES
        : MAX_PATH_COMPONENT_BYTES
    )
  ));
  if (unsafePart !== undefined || Buffer.byteLength(id, "utf8") > 1024) {
    throw errors.unsafePath(`Unsafe concept ID: ${id}`);
  }
  if (parts.at(-1).endsWith(".md")) {
    throw errors.unsafePath("Concept IDs omit the .md suffix");
  }
  if (RESERVED_BASENAMES.has(parts.at(-1).toLowerCase())) {
    throw errors.unsafePath(`Reserved concept ID: ${id}`);
  }
  return parts;
}

function assertContained(bundle, target) {
  const relative = path.relative(bundle, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    if (!relative) throw errors.unsafePath("Concept target cannot be the bundle root");
    throw errors.unsafePath(`Target escapes bundle: ${target}`);
  }
}

export function conceptPath(bundle, id) {
  const parts = validateConceptId(id);
  const target = path.join(bundle, ...parts) + ".md";
  assertContained(bundle, target);
  return target;
}

export async function rejectInternalSymlinks(bundle, target) {
  assertContained(bundle, target);
  const relative = path.relative(bundle, target);
  const parts = relative.split(path.sep);
  let cursor = bundle;
  for (const part of parts) {
    cursor = path.join(cursor, part);
    try {
      const stat = await fs.lstat(cursor);
      if (stat.isSymbolicLink()) {
        throw errors.unsafePath(`Symlink inside Engram bundle blocks write: ${cursor}`);
      }
      if (!stat.isDirectory() && cursor !== target) {
        throw errors.unsafePath(`Non-directory in concept path: ${cursor}`);
      }
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
  }
}

export function idFromConceptPath(bundle, file) {
  const relative = path.relative(bundle, file).split(path.sep).join("/");
  if (!relative.endsWith(".md")) throw errors.unsafePath(`Not a Markdown concept: ${file}`);
  return relative.slice(0, -3);
}
