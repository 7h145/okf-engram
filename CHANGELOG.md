# Changelog

## Unreleased

- Add M5 explicit global memory: a deliberately initialized, restrictive-mode XDG
  corpus that accepts only explicit Memory concepts with URN provenance; independent
  guarded/unguarded policy; explicit global-memory browsing and project/global/both
  recall; and an N-capable, context-qualified, bounded read-composition path with
  no fallback. Artifact
  ingest, inferred memory, jobs, wiring, source-file operations, and adapters remain
  unable to target global memory.
- Present global automatic memory tersely as unavailable; keep the rationale for
  its absent capability in contributor documentation rather than routine status.
- Harden cross-harness shortcut routing after smaller-model dogfood: put complete-
  request preflight in the portable skill, keep only a proven pre-activation guard
  in the thin Pi adapter, reject unsupported `global`/`both` forms without reads,
  writes, jobs, or fallback, and prevent mixed recall from silently degrading to
  one corpus.
- Add package-level adapter bridge protocol v1: client-provenance discovery through
  a machine-readable manifest, explicit capability/version negotiation, fixed
  project-only policy and inferred-memory operations, sanitized context-qualified
  JSON results, and local/Git installed-package contract tests. No automatic-
  review adapter is bundled or implicitly enabled.

## 0.1.3 — 2026-09-12

- Rewrite the public README around the human problem, capabilities, broad design,
  and harness-neutral install/usage guidance with clearly labelled Pi examples;
  move detailed command, persistence, recovery, and contributor material into
  `DEVELOPMENT.md`.
- Keep semantic operations in the skill workflow and preserve the client's current
  project directory; require flat memory frontmatter, and treat bare tmux as
  unavailable rather than improvising collision-prone sessions or public temporary
  logs for `/engram queue`.
- Address boxed verification windows by tmux ID so release-style run IDs containing
  dots work as documented.

## 0.1.2 — 2026-09-09

- Sanitize private-provider identities from public test evidence, make failed-log
  triage use Pi's configured model by default, and add public repository,
  authorship, and CI metadata.
- Standardize help-output disjunctions on the compact `a|b` form.
- Fix `/engram` prompt argument forwarding by using Pi's supported `$ARGUMENTS`
  token and contract-testing expansion from the packed prompt.
- Add `sources list` plus `/engram sources` for a concise referenced-local-file
  view, while `/engram inventory` exposes the complete grouped source inventory.
- Add deliberate `/engram remove CONCEPT_ID` as a guided two-turn deletion that
  preserves canonical SHA-256 concurrency and confirmation guards.
- Make `/engram queue` accept large user batches: deterministically partition up
  to 256 sources into ordered 16-source jobs, return one serial queue runner, and
  expose running/waiting positions plus batch progress through `jobs list`.
- Append optional Engram wiring after existing `AGENTS.md` project instructions
  instead of placing a tool reminder before the project's primary material.
- Give every human shortcut an explicit user purpose, require collection commands
  to surface their entities, and reorder concise help around common work, further
  actions, then setup/policy; introduce Engram in human terms, call inputs data,
  and prefer queued ingest with a foreground fallback.
- Add explicit project `guarded|unguarded` knowledge modes. Guarded remains the
  fail-closed default; unguarded permits relevant sensitive data without relaxing
  trust/provenance rules, and returning to guarded preserves a monotonic history
  warning rather than claiming old content was sanitized.
- Prune wholly generated empty group indexes/directories while preserving any
  human or additional content, and distinguish a misplaced canonical wiring block
  with actionable manual-reconciliation guidance.

## 0.1.1 — 2026-09-08

- Replace the pre-stability helper grammar with the canonical agent DSL: domain
  subcommands, explicit corpus context, descriptive typed long options, JSON by
  default, context-qualified results, semantic-operation declarations, and strict
  rejection of obsolete/ambiguous forms.
- Add a strict sub-1-KiB human `/engram` subset with memorable safe shortcuts and
  no destructive aliases; detailed help defines every agent domain and labels
  semantic workflows versus deterministic helper operations.
- Align source, tests, prompts, documentation, private job records, settings, and
  errors with the canonical corpus/concepts/sources/jobs/policy vocabulary.
  Completed inferred-memory outcomes are `jobs results`; acknowledgement records
  presentation and never deletes the result, job, or knowledge.
- Use automatic-memory settings schema version 3 and private job-record schema
  version 2. Invalid private pre-release state fails closed and can be discarded
  explicitly; no compatibility branches are retained.
- Let multiple pre-enqueued artifact jobs run serially against a fresh execution-
  time corpus baseline while retaining frozen source digests and conditional
  writes; later jobs no longer misreport an earlier job's corpus changes as their
  own never-run result.
- Raise new worker event capture from 1 MiB to 10 MiB after dogfood measured a
  successful 11-source job at about 2 MiB; retain a hard 16 MiB capsule bound and
  validate each capsule's frozen limit instead of equating it with today's default.
- Add explicit fail-closed cleanup for structurally unreadable private jobs with
  `jobs discard-invalid --job-id ID --confirm-invalid-job-deletion`; valid jobs
  and symlinked content cannot bypass terminal, reconciliation, or result checks.
- Report Git tracking through the canonical physical bundle path so a committed
  `.agents` symlink does not hide files tracked under its in-repository target.
- State that normal deferred ingest returns control without foreground polling,
  preserve one-to-sixteen-source jobs without artificial splitting guidance, and
  document local-path dependency setup plus safe bundle-only Git tracking.
- Add explicit `/engram wire` support for an optional canonical project-root
  `AGENTS.md` reminder, with preview/status/removal, idempotent managed markers,
  preservation of existing content and mode, malformed-marker and symlink refusal,
  no implicit initialization, and no change to automatic-memory policy.
- Suggest the separate wire command in human-readable initialization output
  without modifying project instructions.

## 0.1.0 — 2026-09-06

- Reject newly authored source-less Memory concepts while retaining warning-only
  consumption of legacy/hand-edited entries. This closes a defect observed in a
  packed-install Gemma control where provenance appeared only in the body.
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
