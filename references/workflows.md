# Engram workflows

## Ingest

Search first, read the artifact, then integrate durable knowledge into existing
concepts where possible. Add source resource and digest metadata. A source does
not automatically deserve its own summary page. Validate after writing.

## Explicit memory

Search for an existing concept, then create or update `memories/<slug>` with
`type: Memory`, `capture: explicit`, and a short evidence quote. Report the
stored concept ID.

## Inferred memory — project opt-in only

Skill activation and store initialization are not consent. Query `auto-memory
status --json` before considering inferred capture. Missing, off, invalid, or
unavailable policy means no candidate detection or inferred write; explicit
remember/recall and user-requested maintenance remain available.

When enabled, capture only established, durable, project-scoped, non-sensitive
knowledge. Use `capture: inferred` and pass `--automatic-memory` to `put` so the
helper rechecks policy under the bundle lock. Never omit the flag for an automatic
write. Announce successful writes and offer undo. Ask/review when uncertain and
discard sensitive candidates. Do not claim passive observation while the skill
is inactive. Global automatic inference remains disabled.

## Recall

Search returns envelopes. Open only likely concepts, follow useful links, and
cite bundle-relative concept paths. Current project files remain primary for
current implementation and configuration; surface disagreement with Engram.

## Correction and forgetting

Replace only with the current content hash. Use canonical `status: deprecated`
when knowledge is superseded but historically useful. Current-tree deletion is
explicit and cannot erase Git history, backups, transcripts, remotes, or clones.
