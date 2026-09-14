# OKF Engram
<!-- vim: set textwidth=80 expandtab: -->

This is an Agent Skill implementing a version of [Andrej Karpathy's LLM Wiki
idea](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f).
The goal is to give agents working on a project effective access to possibly large
amounts of documentation by compiling durable information into an interlinked
index of concepts with references back to the original sources. Engram can also
treat explicitly stated memories—and, when enabled for a project, useful knowledge
noticed in the current conversation—as source material. Explicit user-global
memories live in a separate, deliberately selected memory-only knowledge base.

The resulting project knowledge base is a collection of Markdown files following
[Open Knowledge Format (OKF)](https://github.com/GoogleCloudPlatform/open-knowledge-format).
It lives with the project in `.agents/data/okf-engram/bundle/` and remains
inspectable with ordinary file and Git tools.

Engram aims to be a portable Agent Skill. The examples below use
[Pi](https://pi.dev/) because that is the currently tested target; operation in
other Agent Skills clients is intended but not yet tested.

## Why this exists

An agent can read the current project tree, but useful knowledge is often spread
across architecture documents, issue notes, runbooks, old decisions, and previous
conversations. Feeding all of that into every new session is noisy, expensive, and
still does not turn it into maintained knowledge.

Engram builds a smaller knowledge layer around the durable concepts: what the
project does, why a decision was made, which constraints still apply, how things
relate, and where the supporting information came from. The agent can retrieve a
few relevant concepts when needed instead of reopening the complete source set for
every question.

## What it can do

Engram can:

- compile project documents into linked concepts and update those concepts as new
  information is accepted;
- track evidence and attribute claims to their sources;
- retain explicit project or user-global memories and recall either scope—or both—
  only when selected;
- browse and search the resulting knowledge without loading the whole corpus;
- queue larger document-ingest requests and continue the conversation while one
  ordered background runner processes them;
- detect changed local source material and, where available, reopen the exact
  committed Git version used as evidence;
- coordinate concurrent agents with deterministic locking and conditional
  writes; and
- provide a versioned, package-discoverable machine bridge through which a
  separately installed optional adapter can submit policy-gated project-memory
  candidates without reading Engram's private state.

Sources stay untouched. Engram records references and digests, while compiled
project knowledge goes into its project-local bundle. Explicit global memories go
to `${XDG_DATA_HOME:-~/.local/share}/okf-engram/bundle/`; project and global
operations never silently fall back to one another.

## How it works

The agent does the semantic work: understanding a document, deciding what is
useful beyond the current task, relating it to existing knowledge, and answering a
question from the relevant concepts.

A Node.js helper takes care of the mechanical work: locating and validating the
bundle, searching, hashing sources and concepts, coordinating writers, replacing
files atomically, maintaining indexes, and managing background jobs and project
policy.

```text
project documents       project memory       explicit global memory
        │                     │                         │
        └── semantic compilation ──┐                   │
                                   ▼                   ▼
                          project OKF bundle    global Memory bundle
                                   └──── selected bounded recall ────┘
```

This division is important: the model gets the work which needs language and
judgment; deterministic code handles storage integrity and concurrent updates.
See [DEVELOPMENT.md](DEVELOPMENT.md) for the command contract, data handling,
source provenance, job lifecycle, recovery behavior, and test setup.

## Install

Engram requires Node.js 20 or newer. Follow the installation documentation for
your agent harness. For example, for the [Pi coding agent](https://pi.dev/), see
the [skills documentation](https://pi.dev/docs/latest/skills) and
[package management documentation](https://pi.dev/docs/latest/packages).

Agent skills run with the agent's permissions and can instruct it to execute
programs, so review third-party skills before installing them. Engram starts no
daemon and changes project instructions only when you explicitly ask it to wire
the project.

### Pi example: install from GitHub

Install the Git package globally with:

```bash
pi install git:github.com/7h145/okf-engram
```

Pi clones Git packages and installs their npm dependencies. The command above
follows the repository's default branch; append a reviewed tag such as
`@v0.1.3` if you prefer a pinned release.

Start or restart Pi in the project where you want to use Engram. The package adds
the strict `/engram` prompt command; Pi can also activate the skill from an
ordinary request.

### Pi example: local checkout

Pi does not install dependencies for local-path packages. For a reviewed local
checkout:

```bash
cd /path/to/okf-engram
npm ci
pi install /path/to/okf-engram
```

## Usage

Follow the skill-loading and invocation documentation for your agent harness. Once
loaded, an agent can activate `okf-engram` when a request involves project
knowledge, prior rationale, artifact ingest, or explicit memory.

For the [Pi coding agent](https://pi.dev/), see the
[skills documentation](https://pi.dev/docs/latest/skills). The examples below use
Pi's `/engram` prompt command.

### Pi example: a first session

Engram does not create anything merely because the skill is installed. Initialize
the knowledge base deliberately from the intended project directory:

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

Explicit remember and recall work while automatic memory is off. You can also ask
normally—“remember why we chose SQLite” or “what did we decide about the
cache?”—when a slash command would just get in the way.

To compile existing project documents without blocking the conversation:

```text
/engram queue README.md docs/architecture.md docs/runbook.md
/engram jobs
```

Engram uses managed background execution when one is available and clearly falls
back to foreground ingest otherwise, rather than leaving a job without a runner.

### Pi example: everyday use

```text
/engram                         knowledge-base status
/engram recall QUESTION         answer from retained knowledge
/engram remember STATEMENT      retain established project knowledge
/engram queue FILE...           ingest documents in the background
/engram ls                      browse concepts
/engram find WORDS              search concepts
/engram show CONCEPT_ID         read one concept
/engram sources                 list referenced local source files
/engram jobs [JOB_ID]           inspect background work
```

`/engram help` shows the complete human command summary, including setup and policy
controls. `/engram --help` shows the canonical agent interface. The slash grammar
is intentionally strict; ask the agent normally for free-form work outside it.

Optional `/engram wire` adds a short reminder after the project's own `AGENTS.md`
instructions so later agents know when to use the skill. Initialization never does
this implicitly.

Global memory is separate and explicit:

```text
/engram global init
/engram global remember prefer concise status updates across projects
/engram global ls
/engram global recall how should status updates be written?
/engram both recall which status conventions apply here?
```

The global corpus accepts only explicitly authored `Memory` concepts. It cannot
ingest project files, run jobs or inference, receive adapter writes, or initialize
itself as a side effect. Existing unqualified shortcuts remain project-scoped.

## Privacy and current scope

Engram stores project knowledge as plaintext. Concepts may be versioned, backed
up, read by tools, or sent to your configured model provider when relevant. The
default guarded mode tells the model not to retain sensitive data, but this is a
content policy rather than encryption, access control, or a secrets vault.

Automatic memory is a separate project opt-in and defaults off. When enabled, the
active skill may notice and queue a useful memory candidate; it may also miss one.
A package-level adapter bridge now exposes that same guarded project-candidate
path to independently installed integrations. No automatic-review adapter ships
with Engram: systematic conversation observation, scheduling, and notifications
remain separate optional integration work, and installing anything never enables
automatic memory. Adapter authors can use the
[bridge protocol](references/adapter-bridge.md).

Project and global knowledge modes are independent and guarded by default. During
explicit mixed recall, each supplying corpus retains its own policy; invalid or
unavailable policy is treated as guarded. Global unguarded mode has a wider cross-
project disclosure radius and never overrides project policy.

Removing a concept affects only the selected corpus tree; it cannot erase copies
in Git history, sessions, backups, remotes, or clones. The detailed trust
boundaries and policy controls are in [DEVELOPMENT.md](DEVELOPMENT.md).

## Development

See [DEVELOPMENT.md](DEVELOPMENT.md) for architecture, canonical commands,
persistence and concurrency behavior, tests, and release verification. The
normative agent contract is [SKILL.md](SKILL.md).

The short version is:

```bash
npm ci
npm run check
```

## Acknowledgements

Andrej Karpathy's [LLM Wiki
idea](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)
was the main inspiration for Engram. Storage follows
[Open Knowledge Format v0.2](https://github.com/GoogleCloudPlatform/open-knowledge-format).
The implementation is original.

## Authors and license

- thias <github.attic@typedef.net>
- OpenAI Codex (5.6)

OKF Engram is released under the [MIT License](LICENSE).
