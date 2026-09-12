# OKF Engram
<!-- vim: set textwidth=80 expandtab: -->

Engram gives an AI agent a project notebook that survives individual chats and
working sessions. It turns project documents and things you explicitly ask it to
remember into a maintained collection of linked Markdown concepts, then uses that
knowledge when you ask about prior decisions, rationale, or project facts.

The notebook lives with the project in
`.agents/data/okf-engram/bundle/` and follows
[Open Knowledge Format (OKF)](https://github.com/GoogleCloudPlatform/open-knowledge-format).
It is plain text rather than a private service or vector database.

Engram is a portable Agent Skill, not a Pi extension. The examples below use
[Pi](https://pi.dev/) because that is the currently tested target; operation in
other Agent Skills clients is intended but not yet tested.

## What this is

Project agents can read the current tree, but useful knowledge is often spread
across design documents, issue notes, old decisions, and previous conversations.
Giving every new session the complete history is both noisy and expensive. A chat
archive also does not become maintained knowledge merely because it can be
searched.

Engram keeps one project-local knowledge corpus containing:

- concepts compiled from files such as architecture documents and runbooks;
- explicit memories, including enough evidence to explain why they were retained;
- links between related concepts;
- claim-level source references and digests where available; and
- generated indexes for browsing and deterministic lexical search.

The agent does the semantic work: deciding what a source says, what is durable,
and how new knowledge fits existing concepts. A Node.js helper does the boring
but important mechanical work: validation, path containment, hashes, locks,
conditional writes, atomic replacement, indexes, jobs, and policy state.

That split is intentional. Language models are useful for understanding a design
document. They are not the right mechanism for deciding whether a stale write may
overwrite another agent's work.

## What is different here

Engram is related to the “LLM wiki” idea, but it is deliberately less magical
than many things called agent memory:

| Concern | What Engram does |
|---|---|
| Storage | Uses an OKF v0.2 bundle of Markdown and YAML that you can inspect, version, move, or stop using. |
| Semantic work | Lets the active model compile and retrieve knowledge, while deterministic code enforces the storage contract. |
| Provenance | Records evidence on the claims it supports instead of presenting unattributed summaries as established fact. |
| Existing knowledge | Searches before writing and updates a matching concept through SHA-256 conditional writes rather than casually creating duplicates. |
| Retrieval | Starts with transparent lexical search and progressive disclosure; there are no embeddings or external retrieval services in v0.1. |
| Background work | Queues bounded artifact-ingest jobs without installing a daemon. One serial corpus runner prevents competing workers from writing blindly. |
| Multiple agents | Uses per-bundle locking, fresh execution-time baselines, and optimistic concurrency checks. |
| Consent | Keeps automatic memory off by default and separates it from the project's sensitive-data mode. |
| Sources | Digests local files and can reopen matching committed Git bytes without fetching, checking out, or modifying Git. |

This is not a general database, a transcript recorder, or a promise that a model
will notice every important fact. It is a fairly opinionated way to maintain the
small amount of project knowledge that should outlive the task which produced it.

## Installation with Pi

Engram requires Node.js 20 or newer. Install the Git package globally with:

```bash
pi install git:github.com/7h145/okf-engram
```

Pi clones Git packages and installs their npm dependencies. The command above
follows the repository's default branch; append a reviewed tag such as
`@v0.1.2` if you prefer a pinned release.

Pi packages and skills run with the agent's permissions. Skills can instruct the
agent to execute programs, so review third-party packages before installing them.
Engram ships no extension, starts no daemon, and changes project instructions only
when you explicitly ask it to wire the project.

Start or restart Pi in the project where you want to use Engram. The package adds
the strict `/engram` prompt command; Pi can also activate the skill from an
ordinary request.

### Local checkout

For a reviewed local checkout, install dependencies there before pointing Pi at
its absolute path. Pi does not install dependencies for local-path packages:

```bash
cd /path/to/okf-engram
npm ci
pi install /path/to/okf-engram
```

## A first session

Engram does not create anything merely because the skill is installed. From the
intended project directory, initialize its knowledge base deliberately:

```text
/engram init
```

This creates `.agents/data/okf-engram/bundle/`. It does not edit `AGENTS.md`,
initialize or change Git, add ignore rules, enable automatic memory, or change the
sensitive-data policy.

Now retain one real piece of project knowledge and ask for it again:

```text
/engram remember this project targets Python 3.13
/engram recall which Python version does this project target?
```

Explicit remember and recall work while automatic memory is off. You can also
write ordinary requests such as “remember why we chose SQLite” or “what did we
decide about the cache?”; the slash command is useful when you want the intent to
be unambiguous.

To compile existing project documents without blocking the conversation:

```text
/engram queue README.md docs/architecture.md docs/runbook.md
/engram jobs
```

Queued files are resolved before work is accepted. Engram uses managed background
execution when the client environment provides it and clearly falls back to
foreground ingest otherwise, rather than leaving a job with no runner.

Run `/engram` without arguments to see whether the current project knowledge base
is initialized and healthy. `/engram help` gives the short human command summary;
`/engram --help` gives the complete canonical agent interface.

## Everyday use

| I want to… | Request |
|---|---|
| Check the project knowledge base | `/engram` |
| Ask from retained project knowledge | `/engram recall QUESTION` |
| Retain an established fact or decision | `/engram remember STATEMENT` |
| Ingest several files in the background | `/engram queue FILE...` |
| Ingest files in the foreground | `/engram ingest FILE...` |
| Browse concepts | `/engram ls` |
| Search for likely concepts | `/engram find WORDS` |
| Read one concept | `/engram show CONCEPT_ID` |
| List referenced local data files | `/engram sources` |
| Inspect complete provenance and source state | `/engram inventory` |
| Inspect or cancel deferred work | `/engram jobs [JOB_ID]` / `/engram cancel JOB_ID` |
| Inspect or change sensitive-data handling | `/engram mode status|guarded|unguarded` |
| Inspect or change automatic-memory consent | `/engram auto status|on|off` |
| Add or remove the optional project reminder | `/engram wire|unwire` |
| Remove one concept after review and confirmation | `/engram remove CONCEPT_ID` |

The `/engram` grammar is intentionally strict. Unknown forms are rejected instead
of guessed. Ask the agent normally for free-form work outside this small command
surface.

`/engram remove` is deliberately not a quick delete: it reads and identifies one
concept, warns about the limits of deletion, asks for yes/no confirmation in a
separate turn, then rechecks the concept hash before removing it.

## How it works

```text
project files                         explicit project memory
     │                                          │
     └──────────── semantic compilation ────────┘
                         │
                         ▼
               linked OKF concept Markdown
                         │
             deterministic Node.js helper
       validation · hashes · locks · atomic writes
          indexes · search · jobs · policy gates
                         │
                         ▼
       .agents/data/okf-engram/bundle/
```

Artifact knowledge and conversation memories are ordinary concepts in the same
corpus. Retrieval first performs a bounded lexical search, then opens a small set
of likely concepts and follows relevant links or source references. Conversation
history is not injected wholesale into the model context.

Engram can capture the digest of the local file used as evidence. When those
bytes are also available as an ordinary local Git object, it can record and later
reopen that exact version without touching the worktree or network. URLs are
provenance labels only; Engram never fetches them.

## Privacy, trust, and limits

This is persistent project knowledge, not magic:

- Concepts are plaintext. They may be indexed, committed, backed up, read by
  tools, or sent to your configured model provider during relevant operations.
- Guarded mode is the default, but sensitive-data detection is model-facing and
  heuristic. It is not encryption, access control, provider isolation, log
  redaction, or a secrets vault.
- Unguarded mode permits relevant sensitive project data; it does not relax
  provenance, prompt-injection, source, path, Git, or concurrency safeguards.
- Returning to guarded mode affects subsequent work. It does not remove knowledge
  already stored while unguarded.
- Automatic memory is a separate, project-local opt-in and defaults off. Even when
  enabled, opportunistic inference may miss useful knowledge.
- Sources and stored concepts are untrusted data. Instructions found inside them
  are not instructions to the agent.
- A background compiler process is context-isolated, not an operating-system
  sandbox.
- Deleting a concept removes it only from the current corpus tree. It cannot erase
  Pi sessions, Git history, remotes, backups, logs, or clones.
- v0.1 has one project corpus. There is no global memory, vector search, automatic
  contradiction detection, mandatory daemon, or automatic conversation-review
  adapter.

Decide explicitly whether the OKF bundle belongs in project version control.
Engram never stages or commits it. Keep adjacent `settings.json`, private `jobs/`,
and `.agents/run/` state untracked unless a separate project policy says
otherwise.

Original source files stay where they are; a digest detects changed or vanished
bytes but cannot recover them. Exact historical reopening depends on the relevant
ordinary Git objects still being available locally. Memories retain short evidence
and opaque conversation references rather than transcripts, thinking, or tool
output. Private job records remain until explicit cleanup, and their configured
model provider receives the bounded source content required for the job. For a
symlinked `.agents` root, use the canonical physical bundle path reported by
`corpus locate` when inspecting Git state.

## Technical reference

### Command model

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
`/engram remove CONCEPT_ID` is the sole destructive shortcut: it reads and
identifies one concept, asks for yes/no confirmation in a separate turn, then
rechecks its SHA-256 before invoking the guarded canonical deletion.

### Optional project wiring

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

### Memory capture

Three paths are distinct:

1. **Explicit memory** — the user asks Engram to remember established knowledge.
2. **Opportunistic inference** — while Engram is active in an opted-in foreground
   turn, the model may notice and queue one durable project-memory candidate.
3. **Automatic conversation review** — a separately packaged optional Pi adapter
   may eventually review eligible completed exchanges through the same bounded
   API. This adapter does not exist yet.

The available inference path is project-only, omits transcripts, tool output, and
thinking, and shares deduplication and policy gates with the future adapter path.
It never targets global memory. A monotonic policy generation prevents work
accepted before an off/on boundary from writing later.

Manage consent with:

```text
/engram auto status
/engram auto on
/engram auto off
```

The canonical operation is `policy project automatic-memory
status|enable|disable`.

### Sensitive-data mode

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

Returning to guarded mode never removes existing sensitive content. Policy status
continues to report `Previously unguarded: yes` after the mode has ever been
enabled, warning that stored knowledge may still contain sensitive data. Invalid
or unavailable history is reported as unknown with the same conservative warning.

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
up to 256 deterministically resolved local files and partitions them into ordered
jobs of at most sixteen sources. Launch exactly one agent-owned runner for the
batch, never one runner per partition. Each job uses the sensitive-data mode
effective when its model invocation begins. Normal deferred work returns control
without inline polling. Worker traces stay in private job files. Foreground
results contain only bounded state, concept IDs and hashes, coverage, warnings,
and review or error reasons.

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

### Source status

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
reference and concept IDs, digests, selectors, current-byte state, and immutable
Git state. URL, conversation URN, and digestless resources are `not-checkable` in
the inventory; Engram never fetches them.

## Recovery

- `NOT_INITIALIZED`: use `/engram init` only when you intend to create the shown
  project corpus.
- Invalid automatic-memory settings fail closed and are never overwritten
  implicitly. Repair or explicitly discard the local settings file before setting
  policy again.
- `PERSISTED_INDEX_STALE`: the concept mutation persisted but index maintenance
  failed. Inspect the current concept and hash or deletion, then run `corpus
  repair-indexes`; do not repeat semantic synthesis blindly. Repair prunes an
  obsolete empty group only when its index and directory are entirely
  Engram-generated; any human-authored or additional content is preserved.
- Reconcile changed or missing source evidence before conditional updates.
- Use `jobs retry` only for unchanged failed or cancelled work. Reconcile
  `needs-review`, acknowledge inferred-memory results, then clean explicitly.
- Bundle-internal symlinks and unsafe paths are rejected. A symlinked project
  `.agents` root is canonicalized and supported.

v0.1 uses OKF v0.2 concepts, project-policy settings schema version 4, and private
job-record schema version 2. Unknown concept frontmatter is preserved. There is no
automatic content migration or raw-source archive.

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

See [SKILL.md](SKILL.md) for the complete agent contract and
[references/workflows.md](references/workflows.md) for detailed operational
workflows.

## Authors

- thias <github.attic@typedef.net>
- OpenAI Codex (5.6)

## Acknowledgements

Inspired by Andrej Karpathy's LLM Wiki pattern. Storage follows Open Knowledge
Format v0.2. The implementation is original and released under the
[MIT License](LICENSE).
