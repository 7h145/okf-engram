# OKF Engram

Engram is an agent-maintained project knowledge corpus and memory, stored as
[Open Knowledge Format (OKF)](https://github.com/GoogleCloudPlatform/open-knowledge-format)
Markdown.

The Agent Skill is `okf-engram`; the user-facing command is `/engram` on Pi.
The prototype is project-local and not yet release-ready. Automatic inference is
off by default and requires `/engram auto-memory on` for the resolved project;
explicit remember/recall remain available while off. Exact local Git source
capture/reopening is read-only and opportunistic; background jobs remain planned.

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

## Acknowledgements

Inspired by Andrej Karpathy's LLM Wiki pattern. Storage follows Open Knowledge
Format v0.2. The implementation is original and released under MIT.
