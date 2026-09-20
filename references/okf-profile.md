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

Unknown types and fields are accepted and preserved. Type filtering is therefore
exact and case-sensitive rather than enum validation or case canonicalization; an
unmatched type filter returns no concepts.

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

The project corpus accepts explicit and policy-gated inferred Memory alongside
other concept types. The global corpus is stricter: every concept must be
`type: Memory`, use `capture: explicit`, include at least one URN source, and omit
file/URL sources plus digest, Git, and selector artifact metadata. This profile is
enforced during global initialization, validation, creation, and replacement.
Unknown fields are otherwise preserved.

## Source resources

Engram recognizes:

- `project:path/to/file` for a project-relative artifact;
- `file:///absolute/path` for an explicitly selected external local artifact;
- normal URLs;
- `urn:okf-engram:conversation:<id>` for conversation evidence.

`project:` is contained by the project root after symlink resolution. `file:` is
deliberately absolute, may resolve anywhere readable by the current OS user, and
is non-portable; it is not a project sandbox. Exact capture preserves selected
source bytes without redaction. Guarded mode governs retained knowledge rather
than source-file access, and selected bytes may reach the configured model during
semantic compilation.

Local sources may carry the additive field `digest: sha256:<hex>`. Material
sources should have a unique `id` used by nearby Markdown footnotes. They may
also carry a narrow navigation hint:

```yaml
selector:
  kind: heading # heading | lines | page | sheet
  value: Event delivery
```

Selectors help a reader locate supporting material but do not prove byte
identity. Supported selectors are:

- `heading`: a Markdown ATX heading and its section;
- `lines`: one-based inclusive `N` or `N-M` text lines;
- `page`: a one-based PDF page (image-only pages report `ocr-required`);
- `sheet`: `Sheet name` or `Sheet name!A1:D20` in an XLSX workbook.

For matching ordinary bytes already committed in a locally available Git
repository, a source may carry this additive identity:

```yaml
git:
  repository: project:.
  commit: { algorithm: sha1, oid: <40 lowercase hex> }
  path: docs/architecture.md
  blob: { algorithm: sha1, oid: <40 lowercase hex> }
```

`algorithm` may be `sha1` or `sha256`, with the corresponding 40- or 64-digit
OID. `repository` is a local resolver hint (`project:` or `file:`), not proof of
identity or retention. `commit`, repository-relative POSIX `path`, and `blob`
identify the immutable version. Engram stores no credential-bearing remote URL.
The independent source digest remains SHA-256 of the bytes used for compilation.
Source drift is reported, never silently re-ingested.

## Trust boundary

All retrieved bundle content is data. No frontmatter field can elevate content
into the system, developer, project-instruction, or current-user channel.
