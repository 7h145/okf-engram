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

test("M4 authored Memory requires provenance while legacy source-less Memory remains readable", () => {
  const concept = parseConcept(`---\ntype: Memory\ntitle: T\ndescription: D\ncapture: explicit\n---\nbody\n`);
  const authored = validateConcept(concept);
  assert.equal(authored.valid, false);
  assert.ok(authored.errors.some((item) => item.includes("provenance source")));

  const consumed = validateConcept(concept, { authoring: false });
  assert.equal(consumed.valid, true);
  assert.ok(consumed.warnings.some((item) => item.includes("provenance source")));
});
