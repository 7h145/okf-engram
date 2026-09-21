# OKF Engram
<!-- vim: set textwidth=80 expandtab: -->

OKF Engram gives agents a durable, source-backed knowledge base for project
documentation and remembered context. It is an Agent Skill implementing a version
of [Andrej Karpathy's LLM Wiki
idea](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f).

Engram compiles durable information from possibly large amounts of project
documentation into an interlinked index of concepts with references back to the
original sources. It can also retain memories you state explicitly and, when you
enable the feature for a project, useful knowledge noticed in the current
conversation. Memories meant to follow you across projects live in a separate,
deliberately selected global knowledge base. A project can also query named,
read-only links to existing local Engram knowledge bases without copying them.

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

- turn project documents into a connected knowledge base and keep it up to date;
- tie retained knowledge back to the sources that support it;
- remember what you tell it for this project or for use across projects;
- read from other local knowledge bases without copying them, on their own or
  together with this project's knowledge;
- browse and search retained knowledge without loading everything at once;
- process larger sets of documents in the background;
- notice when source files have changed and, when Git allows it, reopen the exact
  version used as evidence;
- safely coordinate several agents using the same knowledge base; and
- accept project-memory suggestions from optional agent-client add-ons while
  preserving your settings and safety rules.

Engram leaves source documents untouched. Project knowledge stays with its project,
global memory stays separate, and linked knowledge remains in its original
location.

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
`@v0.3.0` if you prefer a pinned release.

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

This creates `.agents/data/okf-engram/bundle/` and, when absent, an adjacent
`.agents/data/okf-engram/README.md` explaining read-only use for agents without
Engram. It never overwrites an existing README. Initialization does not edit
`AGENTS.md`, initialize or change Git, add ignore rules, enable automatic memory,
or change the sensitive-data policy.

Now retain one real piece of project knowledge and ask for it again:

```text
/engram remember this project targets Python 3.13
/engram recall which Python version does this project target?
```

Explicit remember and recall work while automatic memory is off. You can also ask
normally—“remember why we chose SQLite” or “what did we decide about the
cache?”—when a slash command would just get in the way.

Knowledge-base addresses name the source for a command. Without one, Engram uses
the current project. Add one or more when you want another source or a
combination:

```text
/engram @G init
/engram @G remember prefer concise status updates across projects
/engram @G ls
/engram @P @G recall which status conventions apply here?
```

`@P` means project knowledge and `@G` means global memory. Multiple addresses form
an explicit read set. Named links get their own `@NAME` address, as shown below.

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
/engram help                    show commands, setup, and policy controls
```

The same address prefixes work with browsing and retrieval commands. `/engram
--help` shows the canonical agent interface. The slash grammar is intentionally
strict; ask the agent normally for free-form work outside it.

Optional `/engram wire` adds a short reminder after the project's own `AGENTS.md`
instructions so later agents know when to use the skill. Initialization never does
this implicitly.

### Linked knowledge bases

A named link lets the current project read an already-compiled local Engram
project or bundle without copying it:

```text
/engram link skill-development /path/to/skill-development
/engram links
/engram @skill-development find command design
/engram @P @skill-development recall how should this interface be structured?
/engram @A recall where is the relevant guidance?
```

The link name becomes its address: `@skill-development` in this example. Repeated
addresses select an explicit combination; `@L` selects every configured link, and
`@A` selects the project, initialized global memory, and every configured link.
The long forms of the built-in addresses are `@project`, `@global`, `@linked`, and
`@all`. An unavailable configured link fails visibly instead of being omitted from
an aggregate.

Links are always read-only. Their configured path may be a stable symlink that is
retargeted during deployment; Engram resolves and validates the current target on
every operation. `/engram unlink NAME` removes only the relationship. A project
may configure at most 32 links.

### Global memory and persistence

Global memory is for memories you deliberately state, not for project documents.
Engram never copies project memories into it or adds global memories on its own.
If any explicitly selected knowledge base is unavailable, Engram reports it rather
than silently substituting another one. Containerized or otherwise
ephemeral clients must persist the resolved
`okf-engram/` XDG application directory—or a broader XDG data root according to
the harness's mount policy; Engram does not create or manage container mounts.

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
                                   ▲
                     named read-only bundle links
                                   └──── selected bounded recall ────┘
```

This division is important: the model gets the work which needs language and
judgment; deterministic code handles storage integrity and concurrent updates.
See [DEVELOPMENT.md](DEVELOPMENT.md) for the command contract, data handling,
source provenance, job lifecycle, recovery behavior, and test setup.

## Privacy and current scope

Engram stores project knowledge as plaintext. Concepts may be versioned, backed
up, read by tools, or sent to your configured model provider when relevant. The
default guarded mode tells the model not to retain sensitive data, but this is a
content policy rather than encryption, access control, source-file redaction, or a
secrets vault. Source artifacts explicitly selected for compilation may reach the
configured model so it can extract relevant knowledge; prefer project-contained
paths, and treat an absolute `file:` locator as a deliberate external-file choice.

Automatic memory is a separate project opt-in and defaults off. When enabled, the
active skill may notice and queue a useful memory candidate; it may also miss one.
An optional agent-client add-on can use the same narrow integration point to
suggest a project memory, but Engram still applies the user's opt-in and safety
settings. No such add-on ships with Engram: systematic conversation observation,
scheduling, and notifications remain separate, and installing anything never
enables automatic memory. The technical contract for integration authors is the
[adapter bridge protocol](references/adapter-bridge.md).

Project, global, and linked knowledge modes are independent. During composed
recall, each supplying corpus retains its own policy; invalid, unavailable, or
unknown linked policy is treated as guarded and shown visibly. Link creation warns
about unguarded or previously unguarded targets because selected content may reach
the active model provider. Global unguarded mode has a wider cross-project
disclosure radius and never overrides project policy.

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
