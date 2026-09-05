import fs from "node:fs/promises";
import writeFileAtomic from "write-file-atomic";

export async function atomicWrite(path, data, options = {}) {
  await writeFileAtomic(path, data, {
    encoding: "utf8",
    fsync: true,
    mode: 0o600,
    ...options,
  });
}

export async function readText(path) {
  return fs.readFile(path, "utf8");
}

export async function pathExists(path) {
  try {
    await fs.access(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
