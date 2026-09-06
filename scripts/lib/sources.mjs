import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { errors } from "./errors.mjs";
import { sha256File } from "./hash.mjs";

function assertWithin(root, target) {
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw errors.unsafePath(`Project source escapes project root: ${target}`);
  }
}

export async function resolveLocalResource(resource, projectRoot) {
  if (resource.startsWith("project:")) {
    const relative = resource.slice("project:".length);
    if (!relative || path.isAbsolute(relative) || relative.split(/[\\/]/).includes("..")) {
      throw errors.unsafePath(`Unsafe project resource: ${resource}`);
    }
    const lexical = path.resolve(projectRoot, relative);
    assertWithin(projectRoot, lexical);
    const real = await fs.realpath(lexical).catch((error) => {
      if (error.code === "ENOENT") throw errors.notFound(`Source ${resource}`);
      throw error;
    });
    assertWithin(projectRoot, real);
    return real;
  }
  if (resource.startsWith("file:")) {
    return fs.realpath(fileURLToPath(resource)).catch((error) => {
      if (error.code === "ENOENT") throw errors.notFound(`Source ${resource}`);
      throw error;
    });
  }
  throw errors.usage(`Digest is supported only for project: and file: resources: ${resource}`);
}

export async function digestResource(resource, projectRoot, { maxBytes = Infinity } = {}) {
  const file = await resolveLocalResource(resource, projectRoot);
  const stat = await fs.stat(file);
  if (!stat.isFile()) throw errors.usage(`Source is not a regular file: ${resource}`);
  if (stat.size > maxBytes) throw errors.validation(`Source exceeds ${maxBytes} bytes: ${resource}`);
  try {
    return { resource, path: file, digest: `sha256:${await sha256File(file, { maxBytes })}` };
  } catch (error) {
    if (error.code === "FILE_TOO_LARGE") throw errors.validation(`Source exceeds ${maxBytes} bytes: ${resource}`);
    throw error;
  }
}
