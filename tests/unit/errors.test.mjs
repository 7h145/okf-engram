import test from "node:test";
import assert from "node:assert/strict";
import { errors } from "../../scripts/lib/errors.mjs";

test("unexpected failures become bounded internal errors without raw messages or stacks", () => {
  const cause = Object.assign(new Error("secret path /tmp/private"), { code: "EACCES" });
  const error = errors.internal(cause);

  assert.equal(error.name, "EngramError");
  assert.equal(error.code, "INTERNAL_ERROR");
  assert.equal(error.exitCode, 1);
  assert.equal(error.message, "Unexpected internal Engram failure");
  assert.deepEqual(error.details, { causeCode: "EACCES" });
  assert.doesNotMatch(error.message, /secret|\/tmp|at /);

  const unclassified = errors.internal(new Error("private implementation detail"));
  assert.equal(unclassified.details, undefined);
  assert.doesNotMatch(unclassified.message, /private implementation detail/);
});
