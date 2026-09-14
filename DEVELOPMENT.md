# OKF Engram development and technical reference
<!-- vim: set textwidth=80 expandtab: -->

This document describes Engram's implementation, canonical command interface,
persistence rules, and development workflow. Start with [README.md](README.md) for
the user-facing overview and first-use examples.

Engram aims to be a portable Agent Skill. Its skill contract, OKF corpus, and
Node.js helper do not depend on Pi, but Pi is the currently tested target and the
source of the client-specific installation, prompt-command, package, background
runner, and verification examples in this document. Operation in other Agent
Skills clients is intended but not yet tested.

The normative agent behavior is in [SKILL.md](SKILL.md). The detailed semantic
workflows and OKF authoring profile are in
[references/workflows.md](references/workflows.md),
[references/compilation-protocol.md](references/compilation-protocol.md), and
[references/okf-profile.md](references/okf-profile.md).

## Requirements and setup

The runtime supports Node.js 20 and newer. Current ESLint tooling requires Node.js
20.19 or newer.

```bash
npm ci
npm run check
node scripts/engram.mjs --help
```

`npm run check` runs ESLint, a syntax check of the CLI entry point, and the full
Node test suite. Run a focused test directly while developing, for example:

```bash
node --test tests/unit/search.test.mjs
node --test tests/integration/jobs.test.mjs
```

Pi installs npm dependencies automatically for Git and npm packages. It does not
install dependencies for a local-path package, so run `npm ci` in a local checkout
before `pi install /absolute/path/to/okf-engram`.

Installed skill files are treated as read-only runtime resources. Missing
installed dependencies are a setup error, not permission for the agent to mutate
a shared package installation.

## Repository layout

```text
SKILL.md                         normative semantic and safety contract
prompts/engram.md                Pi /engram prompt alias
scripts/engram.mjs               deterministic CLI entry point
scripts/lib/                     storage, policy, source, and job mechanics
references/okf-profile.md        Engram's OKF v0.2 profile
references/compilation-protocol.md
                                 mandatory artifact compilation protocol
references/workflows.md          detailed semantic workflows
references/adapter-bridge.md      package discovery and adapter protocol contract
tests/unit/                      format and algorithm tests
tests/integration/               command and lifecycle tests
tests/concurrency/               writer and interruption tests
tests/behavior/                  model-behavior fixtures and evaluation
tests/verification/              boxed release verification harness
```

The package root is also the Agent Skill directory. `package.json` registers
`SKILL.md` and `prompts/` with Pi; there is no Pi extension.

## Architecture

Engram has three layers:

1. **Agent Skill — semantic policy.** The active model decides what a source says,
   what deserves durable storage, how knowledge fits existing concepts, and which
   concepts answer a question.
2. **Deterministic helper — storage mechanics.** The Node.js CLI locates and
   validates the corpus, computes digests, captures sources, searches, locks,
   performs conditional atomic writes, updates indexes, stores policy, and manages
   deferred jobs. It does not summarize sources or decide what is true.
3. **OKF bundles — durable knowledge.** Artifact-derived concepts and Memory
   concepts are Markdown with YAML frontmatter. The project corpus contains both;
   the user-global corpus accepts only explicitly authored Memory concepts.

The managed bundle locations are:

```text
<project-root>/.agents/data/okf-engram/bundle/
${XDG_DATA_HOME:-~/.local/share}/okf-engram/bundle/
```

Private operational state is adjacent to the bundle, not inside it. A project
`.agents` directory may be a symlink; Engram canonicalizes the physical location
and rejects paths or bundle-internal symlinks that escape the intended scope.

Semantic compilation is model work. Parsing, containment, validation, locking,
optimistic concurrency, and atomic replacement do not depend on model discipline.
A worker subprocess isolates model context but is not an operating-system sandbox.

## Command model

The canonical interface is:

```text
/engram <domain> <operation> [descriptive long options]
```

The domains are `corpus`, `knowledge`, `memory`, `concepts`, `sources`, `jobs`,
`policy`, `wiring`, and the machine-only `adapter bridge`. Semantic operations such
as `knowledge ingest`, `memory
remember`, and `memory recall` are interpreted by the active skill and are
intentionally rejected by `scripts/engram.mjs`; the agent implements them through
the documented deterministic leaves. Deterministic operations map directly to the
helper.

Every canonical operation identifies its corpus context:

```text
--corpus-context project|global
```

Unsupported, uninitialized, malformed, or inaccessible contexts fail without
fallback. `--project-root-path PATH` selects a project root explicitly and is
invalid for a global-only operation. Without explicit project selection, the agent
preserves the client project cwd and discovers its containing Git worktree; it
must not change to an agent configuration or skill-installation directory. Global
resolution does no project discovery: it uses an absolute `XDG_DATA_HOME` when
set, otherwise `~/.local/share`. The deterministic expert override
`--corpus-bundle-path PATH` is mutually exclusive with `--corpus-context` and does
not inherit managed policy.

Mutations and concept reads select exactly one context. `memory recall` and
`concepts search` may select project, global, or both by repeating the context
option. No unqualified operation consults global memory.

Helper output defaults to bounded JSON. Use `--output-format text` only for direct
debugging. Run the complete generated reference with:

```bash
node scripts/engram.mjs --help
```

The human `/engram` grammar is a strict shortcut subset over the canonical
interface. The complete request is classified before tool use; unknown forms are
rejected rather than guessed, split, or rerouted, and make no corpus or job change.
Ordinary natural language remains available outside the slash grammar.
`/engram help` returns the bounded human summary; `/engram --help` returns the
complete agent interface.

Harness-specific configuration must remain a thin adapter. Duplicating portable
product grammar, safety policy, or workflows in a client prompt is unnecessary
feature creep and an anti-pattern; normative behavior belongs in `SKILL.md`, while
hard enforcement belongs in deterministic helper and storage boundaries. A client
adapter may repeat only a narrow pre-activation guard when dogfood demonstrates
that the client otherwise crosses that boundary; keep the skill authoritative and
cover the duplicate with parity and model controls.

`/engram remove CONCEPT_ID` is the sole destructive human shortcut and remains
project-scoped. It reads and identifies one concept, warns about current-tree-only
deletion, asks for yes/no confirmation in a separate turn, re-reads the concept,
and invokes canonical deletion only if the displayed SHA-256 is still current.
The explicit global shortcuts are `global`, `global init`, `global ls`, `global
mode ...`, `global remember ...`, `global recall ...`, and `both recall ...`.
`global ls` explicitly enumerates Memory envelopes without opening concept bodies;
ordinary unqualified `ls` remains project-scoped.

## Initialization and project wiring

Initialization creates exactly one selected bundle after explicit user intent. It
does not alter Git, `.gitignore`, `AGENTS.md`, automatic-memory policy, or
sensitive-data policy. Global initialization creates its state root and bundle at
mode 0700 where supported; generated files and policy settings use mode 0600. It
copies no project memory, enables no inference, and creates no global wiring.

Optional `/engram wire` appends a canonical marker-delimited reminder to the end
of `<project-root>/AGENTS.md`, after project-owned instructions:

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

The operation preserves existing bytes and mode and is idempotent. `/engram
unwire` removes only the exact terminal canonical block. An exact block elsewhere
is reported as `misplaced` with a manual relocation instruction; Engram does not
move it implicitly. Modified, malformed, duplicate, non-UTF-8, and unsafe symlink
states are never overwritten. Wiring never changes either project policy.

Canonical inspection is available through:

```bash
node scripts/engram.mjs wiring project status --corpus-context project
node scripts/engram.mjs wiring project preview --corpus-context project
```

## Retrieval and conditional writes

The retrieval path uses progressive disclosure:

1. resolve the explicitly selected read set to one or more corpus descriptors;
2. read sensitive-data policy independently for every selected corpus;
3. `concepts search` searches each corpus independently and returns one total-
   bounded, context-qualified metadata result set;
4. the agent chooses a small relevant set;
5. `concepts read` opens each chosen concept through its single supplying context;
6. the agent follows relevant project concept links and source selectors; and
7. the answer identifies corpus context and concept IDs or paths.

The composition layer accepts N descriptors even though v0.2 exposes only project,
global, and project-plus-global. Each constituent search is bounded by the total
result limit; merged results use score, requested-context order, and concept ID for
stable ordering before the total limit is applied. Equal concept IDs in separate
contexts remain distinct. Any selected-context failure aborts the operation rather
than returning a partial fallback. Deprecated concepts are excluded by default.
Generated indexes and private state are not searched as concepts.

Before a semantic write, the agent searches for related knowledge and integrates
into a matching concept where appropriate. Replacements require the current
SHA-256 returned by `concepts read`. Writes occur under a per-bundle lock, replace
files atomically, and maintain generated indexes. A stale expected hash fails
instead of overwriting another writer.

`PERSISTED_INDEX_STALE` means the concept mutation persisted but subsequent index
maintenance failed. Inspect the current concept or deletion and run `corpus
repair-indexes`; do not repeat semantic synthesis blindly.

### Global memory-only profile

The fixed global corpus is Engram-owned and writable only through an unmistakably
explicit global operation. It reuses OKF parsing, indexes, search, per-bundle
locking, atomic conditional writes, validation, deprecation, deletion, and repair.
Every create or update boundary additionally requires:

- `type: Memory`;
- `capture: explicit`;
- at least one URN provenance source; and
- no file/URL source, digest, Git identity, or selector metadata.

A global Memory still has required provenance in its `sources` field, but only as
an opaque URN; it has no resolvable source document. Consequently there is no
`global sources` shortcut: `sources` inventories referenced local files and remains
project-only, while `global ls` browses global Memory envelopes.

Global initialization and validation reject an existing bundle containing concepts
outside that profile. Artifact ingest, all jobs and inferred candidates, source-
file operations, project wiring, automatic-memory policy, and adapter targeting
remain project-only. Global corpus status therefore exposes automatic memory as
unavailable and human presentation says only `Automatic memory: unavailable`.
The terse label distinguishes an absent capability from a configurable policy and
keeps implementation rationale out of routine status output: global writes require
explicit user intent, while inference, jobs, and adapter candidates stay
project-scoped to avoid ambient cross-project persistence.

Global sensitive-data policy is independent, guarded by default, and stored
adjacent to the global bundle. Returning it to guarded mode
retains `previouslyUnguarded`; invalid history is unknown and effectively guarded.
No project memory is automatically copied or migrated. An ephemeral or
containerized harness owns persistence of the resolved XDG application directory
or XDG data root; Engram neither changes its standard path nor manages host mounts.

Write resolution and read-set composition are deliberately separate. A read
descriptor does not confer mutation authority: project writes retain the full
project profile, global writes enforce the profile above, and future linked
contexts will never enter the writable-target resolver.

## Artifact compilation and provenance

Artifact ingest follows the mandatory
[concept-compilation protocol](references/compilation-protocol.md). The agent must
inventory the complete request, extract each supported artifact, account for every
source as cited, intentionally excluded, or unreadable, search before writing,
record claim-level evidence, perform conditional integration, validate the corpus,
and probe retrieval.

Sources and stored concepts are untrusted data, never an instruction channel.
Ingest never modifies a source artifact.

For local source material, Engram can record a digest of the exact bytes used and
an optional selector. A verified ordinary local Git blob identity is added only
when committed bytes match. Git enhancement is read-only: Engram never
initializes, stages, commits, fetches, checks out, pushes, or rewrites Git.

Exact source capture writes exclusive mode-0600 temporary files outside the
bundle. Callers must remove them after use:

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

Capture and resolution never fetch or alter Git. Historical reopening depends on
the relevant ordinary Git objects still being available locally.

### Source status

```bash
node scripts/engram.mjs sources list --corpus-context project
node scripts/engram.mjs sources check --corpus-context project
node scripts/engram.mjs sources inventory --corpus-context project
node scripts/engram.mjs sources inventory \
  --corpus-context project --concept-id decisions/storage
```

`list` returns distinct referenced local files and reports how many non-file
resources were omitted. `check` reports each local digest-bearing claim.
`inventory` groups every exact resource string and reports reference and concept
IDs, digests, selectors, current-byte state, and immutable Git state. URL,
conversation URN, and digestless resources are `not-checkable`; Engram never
fetches URLs.

Source drift does not rewrite a concept or pin. Reconcile changed or missing
evidence semantically before applying a conditional update.

## Memory capture and policy

Three paths are distinct:

1. **Explicit memory** — the user asks Engram to remember established knowledge.
2. **Opportunistic inference** — while Engram is active in an opted-in foreground
   turn, the model may notice and queue one durable project-memory candidate.
3. **Automatic conversation review** — a separately packaged optional Pi adapter
   may eventually review eligible completed exchanges through the package-level
   adapter bridge. This adapter does not exist yet.

The available inference path is project-only and omits transcripts, tool output,
and thinking. It never targets the global corpus. A monotonic policy
generation prevents candidates accepted before an off/on boundary from writing
afterward. Explicit memories use the same flat OKF frontmatter profile as other
concepts: `type`, `title`, `description`, `capture`, and `sources` are top-level
fields, never members of a nested `concept` object.

```text
/engram auto status
/engram auto on
/engram auto off
```

The canonical operation is `policy project automatic-memory
status|enable|disable`. Explicit remember remains available while automatic memory
is off. Enabling the setting does not guarantee that the model will notice every
useful candidate.

### Sensitive-data mode

Project and global knowledge are independently guarded by default:

```text
/engram mode status
/engram global mode status
```

The canonical operations are `policy project sensitive-data status|allow|deny`
and `policy global sensitive-data status|allow|deny`. Unguarded mode permits
relevant customer information, personal data, confidential material, credentials,
and secrets in the selected corpus. It relaxes only the sensitivity filter;
provenance, durability, selected scope, uncertainty, prompt-injection resistance,
conditional writes, and command, source, and Git safety remain mandatory.
Automatic memory is independent, project-only, and default-off.

For mixed recall, policy follows the supplying corpus. A guarded project does not
silently guard an explicitly selected unguarded global corpus, and an unguarded
project does not override guarded global memory. Unknown policy is effectively
guarded. Returning either corpus to guarded mode affects subsequent operations but
never removes existing sensitive content. Policy status preserves `Previously
unguarded: yes` once enabled; invalid or unavailable history is unknown with the
same conservative warning.

This is a model-facing content policy, not encryption, access control, provider
isolation, log redaction, or a secrets vault. Detection and filtering are
heuristic and cannot be promised complete.

## Deferred artifact ingest

The human `/engram queue` command resolves, sorts, deduplicates, and freezes up to
256 local sources, partitions them into ordered jobs of at most sixteen sources,
and launches one returned runner command through an available agent-owned
background mechanism. A raw `tmux` executable does not establish such a mechanism:
tmux needs an active harness/skill contract for owned names, private output, and
cleanup. The agent must not improvise generic sessions or shared-temporary logs. If
no managed runner is available, it reports the fallback and performs foreground
semantic ingest rather than creating a stranded job.

Canonical enqueue and inspection examples:

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

node scripts/engram.mjs jobs run-all-queued \
  --corpus-context project --confirm-run-all-queued

node scripts/engram.mjs jobs cancel \
  --corpus-context project --job-id <job-id>
```

The enqueue result contains one `runnerCommand`, the batch ID, and all job IDs.
Launch exactly one runner for the batch, never one runner per partition. The
runner drains FIFO work through the corpus-wide worker lock, discovers newly
queued work, and gives each job a fresh execution-time corpus baseline while
preserving frozen source digests. Each worker uses the sensitive-data mode
effective when its model invocation begins.

Normal deferred work returns control without inline polling, including no
post-launch sleeps, log reads, or job inspection unless the user explicitly asks
to debug. Worker traces remain
in private job files. Foreground results contain only bounded state, concept IDs
and hashes, coverage, warnings, and review or error reasons. Source drift stops
only the affected job before worker execution. Jobs are cancellable and never
blindly replay `needs-review` changes.

Terminal state remains until explicit cleanup:

```bash
node scripts/engram.mjs jobs clean \
  --corpus-context project --job-id <job-id> \
  --confirm-job-state-deletion

node scripts/engram.mjs jobs discard-invalid \
  --corpus-context project --job-id <job-id> \
  --confirm-invalid-job-deletion
```

A `needs-review` job additionally requires `--confirm-reconciled`.
Inferred-memory results must be acknowledged before cleanup. Invalid-job discard
refuses valid jobs and symlinks.

### Opportunistic inferred-memory jobs

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

Acknowledgement records that a result was presented. It does not delete the job,
result, or stored knowledge.

## Package-level adapter bridge

Engram advertises a versioned `node-cli-json` adapter bridge in the package-level
`okfEngram.adapterBridge` manifest. A separately installed adapter discovers the
package through its client's canonical loaded-resource provenance, validates the
manifest, and negotiates protocol v1 with `adapter bridge handshake`. It does not
import Engram's private modules, inspect Pi settings, scan guessed install caches,
or depend on local/Git/npm directory layouts.

All bridge project operations require an explicit client working directory and are
intrinsically resolved to the primary project corpus. There is no generic target
parameter and no global, linked, explicit-bundle, or fallback route. Bridge
capabilities cover only effective project-policy status, bounded automatic-review
candidate enqueue, inferred-job list/show/run/cancel/retry/constrained cleanup,
and compact result list/acknowledgement. Policy mutation, initialization, wiring,
artifact work, arbitrary concept writes, and unrelated jobs are unavailable.

The bridge fixes candidate origin to `automatic-review`; project automatic-memory
opt-in and its generation still gate enqueue and eventual writes under the normal
locks. Public bridge responses omit settings, bundle, job-directory, capsule,
claim/evidence, trace, and private-result paths. Concept references are context-
qualified, collection responses are capped, and every operation returns a
versioned JSON success or error envelope. A returned runner command re-enters the
same versioned bridge and can run only the selected inferred-memory job.

The bridge is plumbing, not automatic conversation review. It observes nothing,
starts no daemon, stores no adapter cursor, presents no notification, and never
enables policy. Exact discovery, compatibility, command, response, and trust
contracts are in [references/adapter-bridge.md](references/adapter-bridge.md).

## Privacy and persistence details

- Concepts are plaintext and may be indexed, committed, backed up, read by tools,
  or sent to the configured model provider during relevant operations.
- Original source files stay in place. A digest detects changed or vanished bytes
  but cannot recover them.
- Memories retain short evidence and opaque conversation references, not
  transcripts, thinking, or tool output.
- Private job records persist until explicit cleanup. Their configured provider
  receives the bounded source content required for compilation.
- Keep project-adjacent `settings.json`, private `jobs/`, and `.agents/run/` state
  untracked unless a separate project policy says otherwise. Global settings and
  memory are plaintext under the user's XDG data home and are not a secrets vault.
- Engram never stages or commits either OKF bundle. Decide explicitly whether a
  project should version its own bundle; the global store is outside that project.
- For a symlinked `.agents` root, use the canonical physical bundle path reported
  by `corpus locate` when inspecting Git state.
- Current-tree deletion cannot erase Pi sessions, Git history, remotes, backups,
  logs, or clones.
- A same-user worker subprocess is context-isolated, not sandboxed against the
  filesystem or network.

## Recovery and data versions

- `NOT_INITIALIZED`: initialize only when the user intends to create the reported
  project or global corpus; never fall back to another initialized context.
- Invalid managed settings fail closed and are never overwritten implicitly.
  Repair or explicitly discard the selected corpus's settings file before setting
  policy again.
- `PERSISTED_INDEX_STALE`: inspect the persisted mutation and run `corpus
  repair-indexes`. Repair removes an obsolete empty group only when its index and
  directory are entirely Engram-generated; human or additional content is
  preserved.
- Reconcile changed or missing source evidence before conditional updates.
- Use `jobs retry` only for unchanged failed or cancelled work. Reconcile
  `needs-review`, acknowledge inferred-memory results, then clean explicitly.
- Bundle-internal symlinks and unsafe paths are rejected. A symlinked project
  `.agents` root is canonicalized and supported.

v0.2 uses OKF v0.2 concepts, managed-policy settings schema version 4, private
project job-record schema version 2, adapter-bridge manifest version 1, and
adapter-bridge protocol version 1. Existing project settings require no conversion;
global state is new and no project memory is copied automatically. Unknown concept
frontmatter is preserved subject to the global memory-only profile. There is no
automatic content migration or raw-source archive.

## Tests and release verification

The deterministic suite covers document parsing and validation, containment,
indexes, single- and multi-corpus lexical search, conditional writes, XDG global
resolution and profile enforcement, source and Git behavior, independent policy,
job lifecycle and recovery, wiring, concurrency, and interruption boundaries.
Behavior fixtures evaluate semantic coverage, provenance, uncertainty, recall,
sensitive data, and prompt-injection handling separately from deterministic
correctness.

CI runs on Node 20.x and 24.x:

```bash
npm ci
npm run check
npm audit --omit=dev
```

The development-only boxed harness keeps noisy output outside the foreground agent
context:

```bash
tests/verification/start-boxed.sh quick
tests/verification/start-boxed.sh full
```

`quick` runs the current-Node check. `full` also covers the minimum Node runtime,
production audit, Agent Skills validation, an engine-strict packed install,
project wiring, XDG global-memory/mixed-search smoke, and packed Pi skill and
prompt discovery. It requires a clean frozen
commit by default. See the
[verification harness documentation](https://github.com/7h145/okf-engram/blob/main/tests/verification/README.md)
for private output, timeout, cleanup, and optional failed-log-triage procedures.

Before a release, inspect the dry-run package and confirm that installed runtime
resources are present:

```bash
npm pack --dry-run
```

Passing deterministic tests do not substitute for fresh Pi discovery and semantic
behavior checks.
