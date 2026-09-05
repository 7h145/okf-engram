import test from "node:test";
import assert from "node:assert/strict";
import { parseConcept, normalizeGenerated, renderConcept } from "../../scripts/lib/document.mjs";
import { validateConcept } from "../../scripts/lib/validate.mjs";

const valid = `---
type: Memory
title: A decision
description: Durable project decision.
capture: explicit
custom_field: keep-me # preserve this
sources:
  - resource: urn:okf-engram:conversation:test
---
# Memory

Use SQLite.
`;

test("parses, normalizes, and preserves unknown fields and comments", () => {
  const concept = parseConcept(valid);
  normalizeGenerated(concept, { producer: "okf-engram/test", at: "2026-08-31T00:00:00Z" });
  const rendered = renderConcept(concept);
  assert.match(rendered, /custom_field: keep-me # preserve this/);
  const reparsed = parseConcept(rendered);
  assert.equal(reparsed.data.custom_field, "keep-me");
  assert.equal(reparsed.data.generated.by, "okf-engram/test");
  assert.equal(validateConcept(reparsed).valid, true);
});

test("rejects duplicate YAML keys", () => {
  assert.throws(() => parseConcept(`---\ntype: Note\ntype: Memory\n---\nbody\n`), /invalid YAML/);
});

test("Memory requires explicit or inferred capture", () => {
  const concept = parseConcept(`---\ntype: Memory\ntitle: T\ndescription: D\n---\nbody\n`);
  const result = validateConcept(concept);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((item) => item.includes("capture")));
});
