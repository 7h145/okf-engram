import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sha256File } from "../../scripts/lib/hash.mjs";

export const fixtureRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), "../fixtures/m2-semantic",
);

export async function loadManifest() {
  return JSON.parse(await fs.readFile(path.join(fixtureRoot, "manifest.json"), "utf8"));
}

export async function verifyFixtureSources(projectRoot, manifest) {
  const findings = [];
  const aggregate = createHash("sha256");
  for (const item of manifest.resources) {
    const relative = item.resource.slice("project:".length);
    const file = path.join(projectRoot, relative);
    let actual;
    try {
      actual = await sha256File(file);
    } catch (error) {
      findings.push({ code: "fixture-source-missing", resource: item.resource, message: error.message });
      continue;
    }
    if (actual !== item.sha256) {
      findings.push({
        code: "fixture-source-drift", resource: item.resource,
        expected: item.sha256, actual,
      });
    }
    aggregate.update(`${item.resource}\0${actual}\n`);
  }
  return { fixtureDigest: `sha256:${aggregate.digest("hex")}`, findings };
}
