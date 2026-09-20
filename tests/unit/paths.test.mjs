import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { conceptPath, rejectInternalSymlinks, validateConceptId } from "../../scripts/lib/paths.mjs";

test("accepts safe nested IDs and rejects reserved or escaping IDs", () => {
  assert.deepEqual(validateConceptId("memories/python-version"), ["memories", "python-version"]);
  assert.deepEqual(validateConceptId("a".repeat(252)), ["a".repeat(252)]);
  assert.deepEqual(validateConceptId(`${"a".repeat(255)}/leaf`), ["a".repeat(255), "leaf"]);
  for (const id of [
    "../secret", "/absolute", "a\\b", "index", "group/log", "x.md", "a//b",
    ".git/config", "CON", "bad?name", "trailing.", "a".repeat(253),
  ]) {
    assert.throws(() => validateConceptId(id), /Unsafe|Reserved|omit/);
  }
});

test("rejects symlinks inside a canonical bundle", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "engram-path-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bundle = path.join(root, "bundle");
  const outside = path.join(root, "outside");
  await fs.mkdir(bundle);
  await fs.mkdir(outside);
  await fs.symlink(outside, path.join(bundle, "memories"), "dir");
  const target = conceptPath(bundle, "memories/test");
  await assert.rejects(() => rejectInternalSymlinks(bundle, target), /Symlink inside/);
});
