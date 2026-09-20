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

test("error factories retain the documented deterministic exit-code map", () => {
  const cases = [
    [errors.internal(), "INTERNAL_ERROR", 1],
    [errors.usage("usage"), "USAGE", 2],
    [errors.notInitialized("/project"), "NOT_INITIALIZED", 3],
    [errors.validation("invalid"), "VALIDATION_ERROR", 4],
    [errors.wiringModified("/project/AGENTS.md"), "WIRING_MODIFIED", 4],
    [errors.wiringMisplaced("/project/AGENTS.md"), "WIRING_MISPLACED", 4],
    [errors.wiringMalformed("/project/AGENTS.md"), "WIRING_MALFORMED", 4],
    [errors.wiringEncoding("/project/AGENTS.md"), "WIRING_ENCODING", 4],
    [errors.automaticMemoryDisabled("/project/settings.json"), "AUTOMATIC_MEMORY_DISABLED", 4],
    [errors.conflict("conflict"), "WRITE_CONFLICT", 5],
    [errors.lockTimeout("/project/bundle"), "LOCK_TIMEOUT", 6],
    [errors.notFound("Concept"), "NOT_FOUND", 7],
    [errors.confirmation("confirm"), "CONFIRMATION_REQUIRED", 8],
    [errors.unsafePath("unsafe"), "UNSAFE_PATH", 9],
    [errors.persistedIndexStale({ id: "test" }, new Error("index")), "PERSISTED_INDEX_STALE", 10],
    [errors.adapterBridgeIncompatible(2, [1]), "ADAPTER_BRIDGE_INCOMPATIBLE", 11],
  ];

  for (const [error, code, exitCode] of cases) {
    assert.equal(error.code, code);
    assert.equal(error.exitCode, exitCode);
  }
});
