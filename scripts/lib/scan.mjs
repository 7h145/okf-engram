import fs from "node:fs/promises";
import path from "node:path";
import { parseConcept, envelopeOf } from "./document.mjs";
import { idFromConceptPath } from "./paths.mjs";
import { validateConcept } from "./validate.mjs";

export async function scanBundle(bundle) {
  const concepts = [];
  const issues = [];

  async function walk(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        issues.push({
          severity: "warning", category: "safety", code: "symlink",
          path: full, message: "symlink ignored",
        });
        continue;
      }
      if (entry.isDirectory()) {
        if (!entry.name.startsWith(".")) await walk(full);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      if (entry.name === "index.md" || entry.name === "log.md") continue;
      const id = idFromConceptPath(bundle, full);
      try {
        const text = await fs.readFile(full, "utf8");
        const concept = parseConcept(text, id);
        const validation = validateConcept(concept, { authoring: false });
        validation.issues.forEach((item) => issues.push({
          severity: item.severity,
          category: item.category,
          code: item.code,
          id,
          path: full,
          message: item.message,
        }));
        concepts.push({ id, path: full, concept, envelope: envelopeOf(id, concept) });
      } catch (error) {
        issues.push({
          severity: "error", category: "conformance", code: "parse-error",
          id, path: full, message: error.message,
        });
      }
    }
  }

  await walk(bundle);
  concepts.sort((a, b) => a.id.localeCompare(b.id));
  return { concepts, issues };
}
