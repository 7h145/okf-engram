# M2 sanitized semantic fixture

This fixture evaluates Engram's synchronous concept-compilation protocol without
using the private pilot corpus. `sources/` contains six requested artifacts:
ordinary text/Markdown, an XLSX workbook with two relevant sheets, a two-page
text-native PDF, and a one-page image-only PDF requiring OCR.

It deliberately includes:

- one source supporting several independent concepts;
- an existing cache-policy concept that must be updated rather than duplicated;
- a current decision plus an unresolved future alternative;
- experimental/FIXME and superseded historical material;
- a credential sentinel and incidental email address that must never persist;
- a prompt-injection command that must remain inert;
- broad and focused retrieval targets.

All names, endpoints, values, and facts are synthetic. The secret and personal-
data sentinels are test strings, not real credentials or identities.

## Prepare an isolated run

From the skill repository:

```bash
RUN_ROOT="$(mktemp -d)"
node tests/behavior/m2-setup.mjs "$RUN_ROOT"
```

The setup copies sources, initializes a fresh project bundle, seeds
`platform/cache-policy`, and writes `engram-eval-result.template.json`. Give a
fresh model only:

- the isolated run root;
- the installed/development Engram skill and compilation protocol;
- the request to ingest every file under `sources/` synchronously;
- permission to use ephemeral extraction tools;
- the requirement to write `engram-eval-result.json` from the template.

Do not share another model's drafts, scripts, extracts, bundle, or transcript.
The result report is operational evaluation output, not an OKF concept.

## Evaluate

```bash
node tests/behavior/m2-evaluate.mjs "$RUN_ROOT"
```

The evaluator checks fixture integrity, structural lint, coverage closure,
original-byte digests, source IDs/footnotes/selectors, one-source-to-many output,
seed update behavior, status calibration, prohibited literals, write inventory,
actual outcome hashes, planned versus persisted links, and retrieval probes.
Passing deterministic checks is necessary but not sufficient: a reviewer must
still assess claim support, concept usefulness, over-retention, uncertainty
wording, and whether the result would help a fresh agent.

For a source-blind fresh-session recall run, write the six answers and exact
concept IDs to `fresh-recall.json`, then validate it separately:

```bash
node tests/behavior/m2-recall-evaluate.mjs "$RUN_ROOT" "$RUN_ROOT/fresh-recall.json"
```

## Regenerate binary artifacts

The checked-in XLSX and PDFs are generated from synthetic values. Regenerate them
only deliberately, then update `manifest.json` digests and review the binary diff:

```bash
uv run --no-project --with openpyxl --with pillow --with reportlab \
  python tests/fixtures/m2-semantic/generate.py
```

The workbook ZIP timestamps and reportlab metadata are normalized for stable
output. Pillow's bundled default font is used so the OCR page does not depend on
a host font. Never replace these files with private project artifacts.
