import { parseDocument as parseYamlDocument } from "yaml";
import { errors } from "./errors.mjs";
import { sha256 } from "./hash.mjs";
import { PRODUCER } from "./constants.mjs";
import { nowIso } from "./time.mjs";

export function splitFrontmatter(text, source = "document") {
  if (typeof text !== "string" || !text.startsWith("---")) {
    throw errors.validation(`${source}: missing YAML frontmatter`);
  }
  const opening = text.match(/^---[ \t]*\r?\n/);
  if (!opening) throw errors.validation(`${source}: malformed frontmatter opening`);
  const restStart = opening[0].length;
  const rest = text.slice(restStart);
  const closing = /(?:^|\n)---[ \t]*(?:\r?\n|$)/m.exec(rest);
  if (!closing) throw errors.validation(`${source}: missing frontmatter closing delimiter`);
  const delimiterStart = closing.index + (closing[0].startsWith("\n") ? 1 : 0);
  const delimiterEnd = closing.index + closing[0].length;
  const yamlText = rest.slice(0, delimiterStart).replace(/\r\n/g, "\n");
  const body = rest.slice(delimiterEnd).replace(/^\r?\n?/, "");
  return { yamlText, body };
}

export function parseConcept(text, source = "document") {
  const { yamlText, body } = splitFrontmatter(text, source);
  const yaml = parseYamlDocument(yamlText, {
    prettyErrors: true,
    strict: true,
    uniqueKeys: true,
  });
  if (yaml.errors.length) {
    throw errors.validation(`${source}: invalid YAML: ${yaml.errors[0].message}`, {
      errors: yaml.errors.map((error) => error.message),
    });
  }
  let data;
  try {
    data = yaml.toJS({ maxAliasCount: 50 });
  } catch (error) {
    throw errors.validation(`${source}: invalid YAML: ${error.message}`);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw errors.validation(`${source}: frontmatter must be a mapping`);
  }
  return { source, text, yaml, data, body, hash: sha256(text) };
}

export function normalizeGenerated(concept, { producer = PRODUCER, at = nowIso() } = {}) {
  concept.yaml.set("generated", { by: producer, at });
  concept.data = concept.yaml.toJS({ maxAliasCount: 50 });
  return concept;
}

export function renderConcept(concept) {
  const yamlText = String(concept.yaml).trimEnd();
  const body = concept.body.replace(/^\n+/, "").replace(/\s*$/, "");
  return `---\n${yamlText}\n---\n${body}${body ? "\n" : ""}`;
}

export function envelopeOf(id, concept) {
  const { data } = concept;
  const fallbackTitle = id.split("/").at(-1);
  return {
    id,
    type: typeof data.type === "string" && data.type.trim() ? data.type : "Unknown",
    title: typeof data.title === "string" && data.title.trim() ? data.title : fallbackTitle,
    description: typeof data.description === "string" ? data.description : "",
    tags: Array.isArray(data.tags) ? data.tags.filter((tag) => typeof tag === "string") : [],
    status: typeof data.status === "string" ? data.status : "stable",
    generated: data.generated,
  };
}

export function appendDeprecation(concept, reason, at = nowIso()) {
  concept.yaml.set("status", "deprecated");
  const section = `# Deprecation\n\n- ${at}: ${reason}`;
  const body = concept.body.replace(/\s*$/, "");
  concept.body = body.includes("\n# Deprecation\n") || body.startsWith("# Deprecation\n")
    ? `${body}\n- ${at}: ${reason}\n`
    : `${body}${body ? "\n\n" : ""}${section}\n`;
  return concept;
}
