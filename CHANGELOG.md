# Changelog

## 0.0.1 — unreleased prototype

- Add read-only `check-sources --summary`, grouping all referenced resource strings
  with claim counts/IDs, digest sets, selectors, current-byte and immutable Git
  state. Non-local/digestless, conflicting, and invalid claims remain visible;
  URLs are never fetched and bare `check-sources` remains claim-level compatible.
- Add the M3b1 extension-neutral inferred-memory candidate API on the M3a worker
  lifecycle: bounded claim/evidence capsules, stable cross-origin identity,
  policy generations, default-off acceptance and write gates, queued/running
  opt-out invalidation, verified stored/discarded/review dispositions, common-
  secret rejection, and durable compact pending/acknowledged delivery. Stale
  generations remain invalid after re-enable; process cancellation is cooperative.
- Distinguish included skill-only **opportunistic memory inference** from the
  optional post-v0.1 **automatic conversation review** Pi extension. Both use one
  project policy/corpus; extension installation never enables automatic memory.
- Add one explicit bounded artifact-ingest job lifecycle with versioned private
  capsules, source/bundle integrity binding, active/unresolved deduplication,
  per-bundle isolated Pi execution, compact verified results, cancellation,
  conservative retry/recovery, deterministic post-worker lint/index closure, and
  explicit terminal-record cleanup. Worker traces remain outside foreground
  results; automatic conversation observation is still deferred.
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
- Add the mandatory concept-compilation protocol covering inventory/coverage,
  mixed-format extraction, split/merge and stable IDs, claim provenance,
  conditional integration, uncertainty, sensitive-data handling, links, partial
  outcomes, and post-ingest semantic/retrieval review.
- Add a reproducible sanitized text/XLSX/text-PDF/OCR-PDF fixture, deterministic
  ingest and source-blind recall evaluators, manual rubric, and checked comparison
  evidence retaining both a strong-model pass and a smaller-model semantic failure.
- Record a second bounded, fully source-blind Gemma 4 recall attempt as honest
  negative operational evidence: the live local provider processed work but the Pi
  tool-use run timed out without stdout or a recall report; the bundle stayed intact.
  A same-model OpenRouter control completed in 80 seconds with six semantically
  correct cited answers, isolating the concern to the local serving/tool path rather
  than Gemma's recall capability; one redundant-word lexical rubric check remained.
- Add bounded exact-source capture, heading/line/PDF-page/XLSX-range selection,
  optional tagged SHA-1/SHA-256 Git commit/path/blob identities, immutable local
  reopening, and live-versus-pinned drift reporting without fetching or altering
  Git state. Dirty, untracked, filtered, shallow/missing-object, no-Git, and LFS
  cases fall back or fail honestly without producing false exact evidence.
- Add project-local OKF bundle initialization and discovery.
- Add validated, conditional, atomic concept writes with bundle locking.
- Add unified concept search, generated indexes, lint, source drift, deprecation,
  and current-tree deletion.
- Add the `okf-engram` Agent Skill and Pi `/engram` prompt alias.
