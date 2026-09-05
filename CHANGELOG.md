# Changelog

## 0.0.1 — unreleased prototype

- Add project-local `auto-memory status|on|off` with exact `auto` shorthand,
  default-off policy persistence, and lock-ordered gating for automatic inferred-
  memory writes.
- Align skill/workflow instructions and behavioral scenarios with explicit
  project opt-in; explicit remember and maintenance remain available while off.
- Clarify planned versus available capabilities and read-only runtime setup.
- Parse and validate existing bundle markers before initialization; never
  overwrite false/malformed stores or implicitly repair valid existing stores.
- Preserve user text and root metadata around generated index marker sections;
  leave markerless or malformed indexes intact with diagnostics.
- Clear generated summaries from nested indexes after their last concept is
  deleted; lint/reindex now discover stale managed indexes in empty groups while
  preserving obsolete user-owned indexes.
- Make validation resilient to malformed hand-edited metadata; separate OKF
  conformance, Engram profile, derived-state, and safety diagnostics; validate
  reserved indexes/logs and preserve type-only OKF concept consumption.
- Return explicit code-10 `PERSISTED_INDEX_STALE` results when put, deprecate, or
  delete persists but subsequent generated-index maintenance fails.
- Reject bundle-internal concept symlinks before direct reads and deprecation
  prereads, while preserving support for a canonicalized project `.agents` root.
- Restore the advertised Node 20 runtime contract by using a compatible
  `write-file-atomic` release and validating a clean packed install on Node 20.0.0.
- Add bounded lock-contention, SIGKILL stale-lock recovery, independent-writer,
  and kill-before/after-persistence tests with old/new-complete outcomes and
  repairable derived-state verification.
- Add project-local OKF bundle initialization and discovery.
- Add validated, conditional, atomic concept writes with bundle locking.
- Add unified concept search, generated indexes, lint, source drift, deprecation,
  and current-tree deletion.
- Add the `okf-engram` Agent Skill and Pi `/engram` prompt alias.
