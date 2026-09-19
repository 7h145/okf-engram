export class EngramError extends Error {
  constructor(message, { code = "ENGRAM_ERROR", exitCode = 1, details } = {}) {
    super(message);
    this.name = "EngramError";
    this.code = code;
    this.exitCode = exitCode;
    this.details = details;
  }
}

export const errors = {
  usage: (message) => new EngramError(message, { code: "USAGE", exitCode: 2 }),
  notInitialized: (path, corpusContext = "project") =>
    new EngramError(
      `Engram is not initialized at ${path}; run ${corpusContext === "global" ? "/engram @G init" : "/engram init"}`,
      {
        code: "NOT_INITIALIZED",
        exitCode: 3,
        details: { path, corpusContext },
      },
    ),
  validation: (message, details) =>
    new EngramError(message, {
      code: "VALIDATION_ERROR",
      exitCode: 4,
      details,
    }),
  wiringModified: (path) =>
    new EngramError(`Engram project-wiring markers contain non-canonical text in ${path}; reconcile it manually`, {
      code: "WIRING_MODIFIED",
      exitCode: 4,
      details: { path, state: "modified" },
    }),
  wiringMisplaced: (path) =>
    new EngramError(
      `The canonical Engram project-wiring block is present but not at the end of ${path}; move the exact block to the end manually`,
      {
        code: "WIRING_MISPLACED",
        exitCode: 4,
        details: { path, state: "misplaced", requiredAction: "move-canonical-block-to-end-manually" },
      },
    ),
  wiringMalformed: (path, details = {}) =>
    new EngramError(`Engram project-wiring markers are partial or duplicated in ${path}; reconcile them manually`, {
      code: "WIRING_MALFORMED",
      exitCode: 4,
      details: { path, state: "malformed", ...details },
    }),
  wiringEncoding: (path) =>
    new EngramError(`Project AGENTS.md is not valid UTF-8: ${path}`, {
      code: "WIRING_ENCODING",
      exitCode: 4,
      details: { path },
    }),
  automaticMemoryDisabled: (path, reason = "project automatic-memory policy is off", details = {}) =>
    new EngramError(`Automatic inferred-memory write disabled: ${reason}`, {
      code: "AUTOMATIC_MEMORY_DISABLED",
      exitCode: 4,
      details: { path, effective: "off", ...details },
    }),
  conflict: (message, details) =>
    new EngramError(message, {
      code: "WRITE_CONFLICT",
      exitCode: 5,
      details,
    }),
  lockTimeout: (path) =>
    new EngramError(`Another Engram process is writing ${path}`, {
      code: "LOCK_TIMEOUT",
      exitCode: 6,
      details: { path },
    }),
  notFound: (what) =>
    new EngramError(`${what} not found`, {
      code: "NOT_FOUND",
      exitCode: 7,
    }),
  confirmation: (message) =>
    new EngramError(message, {
      code: "CONFIRMATION_REQUIRED",
      exitCode: 8,
    }),
  unsafePath: (message, details) =>
    new EngramError(message, {
      code: "UNSAFE_PATH",
      exitCode: 9,
      details,
    }),
  adapterBridgeIncompatible: (requestedVersion, supportedVersions) =>
    new EngramError(
      `Adapter bridge protocol version ${requestedVersion} is incompatible; supported versions: ${supportedVersions.join(", ")}`,
      {
        code: "ADAPTER_BRIDGE_INCOMPATIBLE",
        exitCode: 11,
        details: { requestedVersion, supportedVersions },
      },
    ),
  persistedIndexStale: (details, cause) =>
    new EngramError(
      `Concept mutation DID persist for ${details.id}, but generated-index maintenance failed; inspect current state and run corpus repair-indexes before retrying`,
      {
        code: "PERSISTED_INDEX_STALE",
        exitCode: 10,
        details: {
          ...details,
          persisted: true,
          indexError: { code: cause?.code, message: cause?.message ?? String(cause) },
          recovery:
            "Inspect the current concept/hash or deletion, resolve the index error, then run corpus repair-indexes; do not blindly repeat synthesis",
        },
      },
    ),
};
