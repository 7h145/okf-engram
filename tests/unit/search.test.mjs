import test from "node:test";
import assert from "node:assert/strict";
import { parseConcept, envelopeOf } from "../../scripts/lib/document.mjs";
import { searchConcepts } from "../../scripts/lib/search.mjs";

function item(id, title, description, body, status = "stable") {
  const concept = parseConcept(`---\ntype: Note\ntitle: ${title}\ndescription: ${description}\nstatus: ${status}\n---\n${body}\n`);
  return { id, concept, envelope: envelopeOf(id, concept) };
}

test("weights title above body and excludes deprecated concepts", () => {
  const concepts = [
    item("alpha", "SQLite architecture", "Storage decision", "body"),
    item("beta", "Other", "Misc", "SQLite architecture appears in the body"),
    item("old", "SQLite old", "Deprecated", "body", "deprecated"),
  ];
  const results = searchConcepts("SQLite architecture", concepts);
  assert.deepEqual(results.map((entry) => entry.id), ["alpha", "beta"]);
  assert.equal(searchConcepts("SQLite old", concepts, { includeDeprecated: true })[0].id, "old");
});
