# OKF Engram

Engram is an agent-maintained project knowledge corpus and memory stored as
[Open Knowledge Format (OKF)](https://github.com/GoogleCloudPlatform/open-knowledge-format)
Markdown.

The Agent Skill is `okf-engram`; Pi exposes the strict human command `/engram`.
The canonical agent interface is a descriptive domain-specific command language.
v0.1 is project-local. Automatic memory is off by default and explicit
remember/recall remains available while it is off.

Exact local Git source capture/reopening is read-only and opportunistic. Bounded
artifact-ingest and inferred-memory jobs are available. Automatic conversation
review belongs to a separately packaged optional Pi adapter and is not part of
the skill roadmap.

## Installation and first use

After publication, install a pinned Pi package:

```bash
pi install npm:okf-engram@<version>
```

For a reviewed local checkout, install dependencies there before pointing Pi at
its absolute directory. Pi does not install dependencies for local-path packages:

```bash
cd /path/to/okf-engram
npm ci
pi install /path/to/okf-engram
```

Pi packages and skills execute with the agent's permissions; review the package
before installation. Engram requires Node.js 20 or newer. It ships no Pi
extension and changes project instructions only on an explicit wiring request.

From the intended project directory:

```text
/engram init
/engram wire
/engram recall which Python version does this project target?
/engram remember this project targets Python 3.13
/engram queue docs/*.md
/engram jobs
/engram sources
```

Initialization creates `<project-root>/.agents/data/okf-engram/bundle/`. It does
not modify `AGENTS.md`, Git, ignore rules, automatic-memory policy, or
sensitive-data policy. `/engram`
without arguments reports the project knowledge-base status.

`/engram help` is a fixed, bounded one-screen human summary. `/engram --help`
presents the complete canonical agent DSL with a one-line definition for each
domain.

## Command model

The canonical shape is:

```text
/engram <domain> <operation> [descriptive long options]
```

The domains are `corpus`, `knowledge`, `memory`, `concepts`, `sources`, `jobs`,
`policy`, and `wiring`. Semantic operations such as `knowledge ingest` and
`memory remember` are interpreted by the active skill. Deterministic operations
map to `scripts/engram.mjs`.

Canonical operations explicitly identify their corpus context:

```text
--corpus-context project
```

Global context is reserved for v0.2 but unavailable in this release. Unsupported
or inaccessible contexts fail; project operations never fall back to global or
vice versa. Deterministic helper output defaults to JSON. Use
`--output-format text` only for direct debugging.

The human `/engram` grammar is strict and intentionally small. Its routing table
also states each shortcut's user purpose: collection requests surface their actual
entities rather than replacing them with an aggregate. Unknown forms are rejected
with concise help. Ask the agent normally outside `/engram` for free-form requests.
`/engram remove CONCEPT_ID` is the sole destructive shortcut: it reads
and identifies one concept, asks for yes/no confirmation in a separate turn, then
rechecks its SHA-256 before invoking the guarded canonical deletion.

## Optional project wiring

`/engram wire` appends a short canonical marker-delimited reminder to the end of
`<project-root>/AGENTS.md`, after the project's own instructions:

```md
<!-- okf-engram:project-wiring:start -->
## Engram project memory

Use the `okf-engram` skill when work requires project knowledge, prior rationale,
explicit memory, or establishes a durable project decision worth retaining.
Follow the skill’s policy before inferring memory. Using the skill is not
permission to initialize Engram or enable automatic memory; do either only on an
explicit user request.
<!-- okf-engram:project-wiring:end -->
```

The operation preserves existing bytes and mode and is idempotent. Treating the
project's instructions as primary keeps Engram in its proper role as one tool used
by the project. `/engram unwire` removes only the exact terminal canonical block.
An exact block in any other position is reported as `misplaced` with instructions
to move it to the end manually; Engram does not relocate it implicitly. Modified,
malformed, non-UTF-8, and unsafe symlink states are never overwritten. Wiring
never changes automatic-memory or sensitive-data policy.

Canonical inspection is available through:

```bash
node scripts/engram.mjs wiring project status --corpus-context project
node scripts/engram.mjs wiring project preview --corpus-context project
```

## Memory capture

Three paths are distinct:

1. **Explicit memory** — the user asks Engram to remember established knowledge.
2. **Opportunistic inference** — while Engram is active in an opted-in foreground
   turn, the model may notice and queue one durable project-memory candidate.
3. **Automatic conversation review** — a separately packaged optional Pi adapter
   may review eligible completed exchanges through the same bounded API.

The inference paths are project-only, omit transcripts/tool/thinking output,
share deduplication and policy gates, and never target global memory. A monotonic
policy generation prevents work accepted before an off/on boundary from writing
later.

Manage consent with:

```text
/engram auto status
/engram auto on
/engram auto off
```

The canonical operation is `policy project automatic-memory
status|enable|disable`.

## Sensitive data

Project knowledge is guarded by default. A human may explicitly allow relevant
sensitive data—including customer information, personal data, confidential
material, credentials, and secrets—with:

```text
/engram mode status
/engram mode unguarded
/engram mode guarded
```

The canonical operation is `policy project sensitive-data status|allow|deny`.
Unguarded mode relaxes only the sensitivity filter; provenance, durability,
project scope, uncertainty, prompt-injection resistance, and command/source/Git
safety remain mandatory. Automatic memory remains separate and default-off.

This is a model-facing content policy, not encryption, access control, or a
secrets vault. Knowledge is plaintext and may be indexed, versioned, backed up,
sent to configured model providers, or exposed through tools and logs. Returning
to guarded mode affects subsequent operations but does not remove existing
sensitive content. Policy status continues to report `Previously unguarded: yes`
after the mode has ever been enabled, warning that stored knowledge may still
contain sensitive data. Invalid or unavailable history is reported as unknown
with the same conservative warning.

## Development

Runtime support is Node.js 20+. Current ESLint tooling requires Node.js 20.19 or
newer.

```bash
npm install
npm test
node scripts/engram.mjs --help
```

Artifact ingest follows the mandatory
[concept-compilation protocol](references/compilation-protocol.md): complete
coverage accounting, mixed-format extraction, claim provenance, conservative
status, conditional integration, and retrieval review.

The project bundle is:

```text
<project-root>/.agents/data/okf-engram/bundle/
```

Private operational state is adjacent to, not inside, the OKF bundle.

### Deferred artifact ingest

```bash
node scripts/engram.mjs jobs enqueue artifact-ingest-batch \
  --corpus-context project \
  --source-resource project:docs/architecture.md \
  --source-resource project:docs/runbook.md \
  --ingest-instruction "Compile accepted architecture decisions." \
  --worker-model-id openrouter/google/gemma-4-31b-it \
  --worker-timeout-seconds 900

node scripts/engram.mjs jobs show \
  --corpus-context project --job-id <job-id>

# Explicit blocking fallback for the queue:
node scripts/engram.mjs jobs run-all-queued \
  --corpus-context project --confirm-run-all-queued

node scripts/engram.mjs jobs cancel \
  --corpus-context project --job-id <job-id>
```

The batch enqueue result contains one `runnerCommand` plus the batch ID and all
job IDs. The human `/engram queue` command is the preferred ingest experience: it
uses managed background execution when available and clearly falls back to
foreground semantic ingest otherwise, without leaving a stranded job. It accepts
up to 256 deterministically resolved local files
and partitions them into ordered jobs of at most sixteen sources. Launch exactly
one agent-owned runner for the batch, never one runner per partition. Each job
uses the sensitive-data mode effective when its model invocation begins. Normal
deferred work returns control without inline polling. Worker traces stay in
private job files. Foreground results contain only bounded state, concept
IDs/hashes, coverage, warnings, and review/error reasons.

Jobs are source- and corpus-bound, serialized per bundle, cancellable, and never
blindly replay `needs-review` changes. The queue runner drains jobs in FIFO order
against a fresh execution-time corpus baseline and discovers work enqueued while
it is active. `jobs list` reports the running job, waiting positions, batch parts,
and source counts. Source drift still stops only the affected job before worker
execution. Each internal job retains a frozen 1–16 MiB event limit; new jobs use
10 MiB.

Terminal state remains until explicit cleanup:

```bash
node scripts/engram.mjs jobs clean \
  --corpus-context project --job-id <job-id> \
  --confirm-job-state-deletion

node scripts/engram.mjs jobs discard-invalid \
  --corpus-context project --job-id <job-id> \
  --confirm-invalid-job-deletion
```

A `needs-review` job additionally requires `--confirm-reconciled`. Inferred-memory
results must be acknowledged before cleanup. Invalid-job discard refuses valid
jobs and symlinks. A worker is context-isolated, not an OS sandbox.

### Opportunistic inferred memory

```bash
node scripts/engram.mjs policy project automatic-memory status \
  --corpus-context project

node scripts/engram.mjs jobs enqueue inferred-memory \
  --corpus-context project \
  --memory-claim "SQLite is the approved durable local store." \
  --memory-evidence "The user approved SQLite for offline transactional updates." \
  --conversation-context-reference session:opaque/entry:opaque \
  --automatic-memory-policy-generation "$GENERATION"

node scripts/engram.mjs jobs results list \
  --corpus-context project \
  --acknowledgement-state unacknowledged

node scripts/engram.mjs jobs results acknowledge \
  --corpus-context project --job-id <job-id>
```

Acknowledgement means a result was presented; it does not delete the job, result,
or stored knowledge.

### Exact source capture

```bash
node scripts/engram.mjs sources capture \
  --corpus-context project \
  --source-resource project:docs/architecture.md \
  --output-file-path /tmp/architecture.snapshot \
  --source-selector-kind heading \
  --source-selector-value "Decision" \
  --selected-region-output-file-path /tmp/architecture.region

node scripts/engram.mjs sources resolve \
  --corpus-context project \
  --concept-id decisions/storage --source-id architecture \
  --output-file-path /tmp/architecture.pinned \
  --selected-region-output-file-path /tmp/architecture.pinned-region
```

Capture never fetches or alters Git. Outputs are exclusive mode-0600 temporary
files outside the corpus and must be removed after use.

## Source status

```bash
node scripts/engram.mjs sources list --corpus-context project
node scripts/engram.mjs sources check --corpus-context project
node scripts/engram.mjs sources inventory --corpus-context project
node scripts/engram.mjs sources inventory \
  --corpus-context project --concept-id decisions/storage
```

`list` returns distinct referenced local files and reports how many non-file
resources were omitted without hashing file contents. `check` reports each local
digest-bearing claim. `inventory` groups every exact resource string and reports
reference/concept IDs, digests, selectors, current-byte state, and immutable Git
state. URL, conversation-URN, and digestless resources are `not-checkable` in the
inventory; Engram never fetches them.

## Known limitations

- v0.1 has one project corpus and no global store, named-bundle registry,
  embeddings/vector search, or automatic contradiction detection.
- Opportunistic inference may miss useful knowledge. Systematic review requires a
  separately packaged optional Pi adapter.
- Deferred work needs an agent-owned runner or explicit blocking `jobs run`;
  Engram installs no daemon.
- Historical reopening depends on locally available ordinary Git objects.
- Source URLs are provenance labels, not a network retrieval service.
- Current-tree deletion cannot erase Git history, sessions, backups, remotes, or
  clones.

## Privacy and persistence

- Decide explicitly whether to version the project bundle. Engram never stages or
  commits it. Keep `settings.json`, private `jobs/`, and `.agents/run/` untracked
  unless a separate policy says otherwise.
- For a symlinked `.agents` root, use the canonical physical bundle path reported
  by `corpus locate` for Git operations.
- Original sources stay in place. Digests detect drift but cannot recover vanished
  bytes.
- Memories retain short evidence and opaque conversation URNs, not transcripts,
  thinking, or tool output.
- Private job records persist until explicit cleanup. Their configured model
  provider receives the bounded request and source content required for ingest.
- Project operations never fall back to global memory. Global explicit memory is
  planned for v0.2; global automatic inference is disabled.

## Recovery

- `NOT_INITIALIZED`: use `/engram init` only when you intend to create the shown
  project corpus.
- Invalid automatic-memory settings fail closed and are never overwritten
  implicitly. Repair or explicitly discard the local settings file before setting
  policy again.
- `PERSISTED_INDEX_STALE`: the concept mutation persisted but index maintenance
  failed. Inspect the current concept/hash or deletion and run `corpus
  repair-indexes`; do not repeat semantic synthesis blindly. Repair prunes an
  obsolete empty group only when its index and directory are entirely
  Engram-generated; any human-authored or additional content is preserved.
- Reconcile changed/missing source evidence before conditional updates.
- Use `jobs retry` only for unchanged failed/cancelled work. Reconcile
  `needs-review`, acknowledge inferred-memory results, then clean explicitly.
- Bundle-internal symlinks and unsafe paths are rejected. A symlinked project
  `.agents` root is canonicalized and supported.

v0.1 uses OKF v0.2 concepts, project-policy settings schema version 4, and
private job-record schema version 2. Unknown concept frontmatter is preserved.
There is no automatic content migration or raw-source archive.

## Authors

- thias <github.attic@typedef.net>
- OpenAI Codex (5.6)

## Acknowledgements

Inspired by Andrej Karpathy's LLM Wiki pattern. Storage follows Open Knowledge
Format v0.2. The implementation is original and released under MIT.
