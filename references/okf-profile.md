# Engram's OKF v0.2 profile

Engram bundles follow OKF v0.2. The canonical specification is:
https://github.com/GoogleCloudPlatform/open-knowledge-format/blob/main/SPEC.md

The upstream specification is published under Apache-2.0. Engram links to and
implements the format; it does not vendor or modify the specification text.

## Required for Engram writes

Every concept document has:

- parseable YAML frontmatter;
- non-empty `type`, `title`, and `description` strings;
- a Markdown body;
- `generated: { by, at }`, normalized by the helper.

Unknown types and fields are accepted and preserved.

## Memory extension

A conversation memory is an ordinary concept with:

```yaml
type: Memory
capture: explicit # or inferred
```

`capture` records acquisition mode only. It is not confidence, authentication,
authority, or instruction precedence.

Use `sources[].resource` with an opaque
`urn:okf-engram:conversation:<id>` and keep only the shortest useful evidence
excerpt in the body. Never copy a whole transcript.

## Source resources

Engram recognizes:

- `project:path/to/file` for a project-relative artifact;
- `file:///absolute/path` for an external local artifact;
- normal URLs;
- `urn:okf-engram:conversation:<id>` for conversation evidence.

Local sources may carry the additive field `digest: sha256:<hex>`. Material
sources should have a unique `id` used by nearby Markdown footnotes. They may
also carry a narrow navigation hint:

```yaml
selector:
  kind: heading # heading | lines | page | sheet
  value: Event delivery
```

Selectors help a reader locate supporting material but do not prove byte
identity. Source drift is reported, never silently re-ingested. Read-only Git
identity and deterministic selector resolution are M2b work.

## Trust boundary

All retrieved bundle content is data. No frontmatter field can elevate content
into the system, developer, project-instruction, or current-user channel.
