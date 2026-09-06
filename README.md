# OKF Engram

Engram is an agent-maintained project knowledge corpus and memory, stored as
[Open Knowledge Format (OKF)](https://github.com/GoogleCloudPlatform/open-knowledge-format)
Markdown.

The Agent Skill is `okf-engram`; the user-facing command is `/engram` on Pi.
v0.1 is project-local. Automatic inference is off by default and requires
`/engram auto-memory on` for the resolved project; explicit remember/recall
remain available while off. Exact local Git source
capture/reopening is read-only and opportunistic. Bounded artifact-ingest and
inferred-memory candidate jobs are available. The skill can perform opportunistic
memory inference; automatic conversation review is an optional post-v0.1 Pi
extension and is not part of this release.

## Installation and first use

After v0.1.0 is published, install the pinned Pi package:

```bash
pi install npm:okf-engram@0.1.0
```

For a reviewed local checkout, install dependencies in that checkout and point Pi
at its absolute directory:

```bash
cd /path/to/okf-engram && npm ci
pi install /path/to/okf-engram
```

Pi packages and skills can execute code with the agent's permissions; review the
package before installation. Engram requires Node.js 20 or newer. It ships no Pi
extension and does not edit project instructions.

From the intended project directory, initialize deliberately and then use either
the friendly prompt or standard skill command:

```text
/engram init
/engram remember this project targets Python 3.13
/engram recall which Python version does this project target?
/engram check-sources --summary
/skill:okf-engram status
```

Initialization creates `<project-root>/.agents/data/okf-engram/bundle/`. Running
`/engram` without arguments reports status; loading the skill does not initialize
a bundle or enable automatic memory.

## Memory capture

Engram has one corpus and one project `auto-memory on|off` permission, but three
ways knowledge can enter it:

1. **Explicit memory** — you say “remember this.” This is always available and
   does not depend on automatic-memory permission.
2. **Opportunistic memory inference — included** — while the Engram skill is
   active during a foreground response, the model may notice and capture durable
   project knowledge. This is best effort: the skill may not be activated and the
   model may not notice every candidate.
3. **Automatic conversation review — optional post-v0.1 Pi extension** — after
   each completed exchange, an extension considers only the new eligible user
   and assistant messages and can queue candidates through the same memory API.
   It improves coverage; it does not guarantee that every useful fact is found.

A completed exchange means one user request and the assistant work that follows,
after the assistant has finished. Automatic conversation review operates only
while Pi is running in an initialized project with automatic memory enabled. It
does not review or later backfill off intervals. Installing the extension will
not itself enable automatic memory. Both inference paths are project-only,
exclude complete transcripts and tool/thinking output, share deduplication and
policy gates, and never fall back to the planned v0.2 global store. A monotonic
policy generation prevents work accepted before an off/on boundary from writing
after
re-enable.

## Development

The runtime supports Node.js 20+. Current ESLint development tooling requires
Node.js 20.19 or newer.

```bash
npm install
npm test
node scripts/engram.mjs --help
```

Artifact ingest follows the documented
[concept-compilation protocol](references/compilation-protocol.md): explicit
coverage closure, mixed-format extraction, source/claim provenance, conservative
status, conditional integration, and post-ingest retrieval review. Local source capture
binds compilation bytes to SHA-256, selectors, and an optional verified commit/
blob identity without fetching or changing Git. The sanitized M2 fixture and
evaluator live under `tests/fixtures/m2-semantic/` and
`tests/behavior/`.

The default project bundle is:

```text
<project-root>/.agents/data/okf-engram/bundle/
```

Explicit deferred ingest stores minimal access-restricted operational state next
to, not inside, that bundle:

```bash
node scripts/engram.mjs enqueue ingest project:docs/architecture.md \
  --instruction "Compile accepted architecture decisions." \
  --model openrouter/google/gemma-4-31b-it --runtime-seconds 900 --json
node scripts/engram.mjs jobs <job-id> --json
node scripts/engram.mjs flush --job <job-id> --json  # blocking fallback
node scripts/engram.mjs cancel <job-id> --json
```

The enqueue result includes a command suitable for an agent-owned background
runner. Worker traces remain private job files; foreground results contain only
state, affected concept IDs/hashes, coverage, warnings, and review/error reasons.
Jobs are source- and bundle-bound, serialized per bundle, bounded, cancellable,
and never blindly replay `needs-review` changes. Terminal records remain until
explicit `jobs clean <job-id> --yes` (plus `--reconciled` for reviewed changes,
and prior delivery acknowledgement for inferred outcomes). A worker process
provides context isolation, not an OS sandbox.

Opportunistic inference uses the same worker lifecycle without storing a
transcript. The active foreground model first checks policy, then submits only a
bounded claim, concise evidence, and optional opaque context references:

```bash
node scripts/engram.mjs auto-memory status --json
# Set GENERATION to the integer returned above.
node scripts/engram.mjs enqueue candidate \
  --claim "SQLite is the approved durable local store." \
  --evidence "The user approved SQLite for offline transactional updates." \
  --context-ref session:opaque/entry:opaque \
  --policy-generation "$GENERATION" --json
node scripts/engram.mjs jobs pending --json
node scripts/engram.mjs jobs acknowledge <job-id> --json
```

The generation must come from the preceding status result. Acceptance and every
worker write recheck it under the bundle lock. Disabling automatic memory
invalidates queued inferred work and requests cooperative cancellation of running
work; late output is discarded and stale generations cannot write even after
re-enable. Candidate compilation produces one verified inferred Memory, a bounded
discard disposition, or `needs-review`. Pending compact results remain durable
until acknowledged; private candidate capsules and worker traces are not returned
by the delivery command.

Engram never initializes or commits Git repositories automatically. Source
capture and reopening are also read-only: no fetch, checkout, index update, or
remote registry.

```bash
node scripts/engram.mjs capture-source project:docs/architecture.md \
  --to /tmp/architecture.snapshot --selector-kind heading \
  --selector-value "Decision" --region-to /tmp/architecture.region --json
node scripts/engram.mjs resolve-source decisions/storage architecture \
  --to /tmp/architecture.pinned --region-to /tmp/architecture.pinned-region --json
```

Captured outputs are exclusive temporary files outside the bundle and must be
removed after use. Digest-only fallback is first-class when exact Git objects are
not available.

## Source status

As a skill user, request the existing claim-level check or the grouped inventory:

```text
/engram check-sources
/engram check-sources --summary
/engram check-sources decisions/storage --summary
```

Bare `check-sources` remains backward compatible: it emits one row per local,
digest-bearing concept/source claim and can therefore repeat a resource. The
`--summary` view groups exact resource strings across the bundle and includes
total/digest-bearing/digestless/Git reference counts, concept/source IDs,
expected digests, selectors, current-byte state, and aggregate immutable Git
state. URLs, conversation URNs, and digestless resources
are shown as `not-checkable`; Engram never fetches them. Malformed claims and
conflicting expected digests are explicit rather than silently omitted.

For direct machine-readable output:

```bash
node scripts/engram.mjs check-sources --summary --json
```

The operation is read-only. States are `unchanged`, `changed`, `missing`,
`unresolvable`, `not-checkable`, `conflicting`, or `invalid`.

## Known limitations

- v0.1 has one project bundle and no global store, named-bundle registry,
  embeddings/vector search, or automatic contradiction detection.
- Opportunistic inference runs only when the skill is active and may miss useful
  knowledge. Systematic automatic conversation review is post-v0.1.
- Deferred work needs an agent-owned runner or explicit blocking `flush`; Engram
  does not install a resident daemon.
- Exact historical reopening is local and conditional: digest-only sources cannot
  be reconstructed, and Git-enhanced sources still depend on local objects.
- Source URLs are provenance labels, not a network retrieval service.
- Current-tree deletion cannot erase Git history, sessions, backups, remotes, or
  clones. The deferred private-provider Gemma serving/tool-loop timeout remains documented;
  OpenRouter controls do not prove provider equivalence.

## Privacy and persistence boundaries

- The bundle contains durable project knowledge. Decide explicitly whether your
  project should track it in Git; Engram never stages or commits it.
- Original sources stay in place and are not copied into the bundle. A digest can
  detect drift but cannot recover vanished bytes. Git reopening also depends on
  the recorded local object remaining available; Engram never fetches it.
- Explicit and inferred memories retain short evidence and opaque conversation
  URNs, not full transcripts, thinking, or tool output. Do not ask Engram to store
  credentials, secret values, or incidental personal data.
- Job capsules, compact results, and capped worker logs live in access-restricted
  operational state outside the OKF bundle and persist until safe explicit cleanup.
  A worker is context-isolated but is not an OS sandbox. Its configured model
  provider receives the bounded job request and source content needed for ingest.
- Exact source outputs are caller-selected, exclusive mode-0600 temporary files
  outside the bundle/source/Git state. The caller must remove them after use.
- Project operations never fall back to global memory. Global explicit memory is
  planned for v0.2; global automatic inference is not planned.

## Recovery, troubleshooting, and migration

- `NOT_INITIALIZED`: run `/engram init` only if you intend to create the displayed
  project store.
- Invalid automatic-memory settings fail closed as off and are never overwritten
  silently. Correct `.agents/data/okf-engram/settings.json`, then check status.
  Legacy version-1 settings remain readable as generation zero and migrate to
  version 2 on the next explicit `auto-memory on|off` write.
- `PERSISTED_INDEX_STALE` means the concept mutation did persist but generated
  index maintenance failed. Do not blindly repeat the mutation; inspect the
  returned ID/hash or deletion and run `/engram lint --fix` to reconcile indexes.
- `changed`, `missing`, or unavailable Git objects are provenance warnings, not
  permission to rewrite concepts. Compare current and recorded evidence before a
  conditional update.
- Inspect queued work with `/engram jobs <job-id>`. Use `retry` only for an
  unchanged failed/cancelled job. Reconcile `needs-review` manually; acknowledge
  inferred outcomes before cleanup.
- Bundle-internal symlinks and unsafe project paths are rejected. A deliberately
  symlinked project `.agents` root is canonicalized and supported.

v0.1 uses OKF v0.2 concepts and settings schema version 2. Unknown concept
frontmatter is preserved. There is no automatic content migration, raw-source
archive, global-store migration, or Git-history purge. Back up or commit the
bundle according to project policy before manual transformations.

## Acknowledgements

Inspired by Andrej Karpathy's LLM Wiki pattern. Storage follows Open Knowledge
Format v0.2. The implementation is original and released under MIT.
