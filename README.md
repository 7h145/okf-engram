# OKF Engram

Engram is an agent-maintained project knowledge corpus and memory, stored as
[Open Knowledge Format (OKF)](https://github.com/GoogleCloudPlatform/open-knowledge-format)
Markdown.

The Agent Skill is `okf-engram`; the user-facing command is `/engram` on Pi.
The prototype is project-local and not yet release-ready. Automatic inference is
off by default and requires `/engram auto-memory on` for the resolved project;
explicit remember/recall remain available while off. Git-pinned source reopening
and background jobs are planned, not current capabilities.

## Development

The runtime supports Node.js 20+. Current ESLint development tooling requires
Node.js 20.19 or newer.

```bash
npm install
npm test
node scripts/engram.mjs --help
```

The default project bundle is:

```text
<project-root>/.agents/data/okf-engram/bundle/
```

Engram never initializes or commits Git repositories automatically.

## Acknowledgements

Inspired by Andrej Karpathy's LLM Wiki pattern. Storage follows Open Knowledge
Format v0.2. The implementation is original and released under MIT.
