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
  notInitialized: (path) => new EngramError(
    `Engram is not initialized at ${path}; run /engram init`,
    { code: "NOT_INITIALIZED", exitCode: 3, details: { path } },
  ),
  validation: (message, details) => new EngramError(message, {
    code: "VALIDATION_ERROR", exitCode: 4, details,
  }),
  autoMemoryDisabled: (path, reason = "project auto-memory is off", details = {}) => new EngramError(
    `Automatic inferred-memory write disabled: ${reason}`,
    { code: "AUTO_MEMORY_DISABLED", exitCode: 4, details: { path, effective: "off", ...details } },
  ),
  conflict: (message, details) => new EngramError(message, {
    code: "WRITE_CONFLICT", exitCode: 5, details,
  }),
  lockTimeout: (path) => new EngramError(
    `Another Engram process is writing ${path}`,
    { code: "LOCK_TIMEOUT", exitCode: 6, details: { path } },
  ),
  notFound: (what) => new EngramError(`${what} not found`, {
    code: "NOT_FOUND", exitCode: 7,
  }),
  confirmation: (message) => new EngramError(message, {
    code: "CONFIRMATION_REQUIRED", exitCode: 8,
  }),
  unsafePath: (message, details) => new EngramError(message, {
    code: "UNSAFE_PATH", exitCode: 9, details,
  }),
  persistedIndexStale: (details, cause) => new EngramError(
    `Concept mutation DID persist for ${details.id}, but generated-index maintenance failed; inspect current state and reindex before retrying`,
    {
      code: "PERSISTED_INDEX_STALE",
      exitCode: 10,
      details: {
        ...details,
        persisted: true,
        indexError: { code: cause?.code, message: cause?.message ?? String(cause) },
        recovery: "Inspect the current concept/hash or deletion, resolve the index error, then run engram reindex; do not blindly repeat synthesis",
      },
    },
  ),
};
