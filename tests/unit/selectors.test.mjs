import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { selectSourceRegion, validateSelector } from "../../scripts/lib/selectors.mjs";

const fixture = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), "../fixtures/m2-semantic/sources",
);

test("M2b heading and line selectors navigate exact text bytes", async () => {
  const bytes = Buffer.from("# Intro\nA\n## Details\nfirst\n### Nested\nsecond\n## Next\nthird\n");
  const heading = await selectSourceRegion(bytes, { kind: "heading", value: "Details" }, { filename: "notes.md" });
  assert.equal(heading.state, "selected");
  assert.match(heading.text, /^## Details\nfirst\n### Nested\nsecond$/);
  assert.equal(heading.startLine, 3);
  assert.equal(heading.endLine, 6);

  const lines = await selectSourceRegion(bytes, { kind: "lines", value: "2-4" }, { filename: "notes.md" });
  assert.equal(lines.text, "A\n## Details\nfirst");
  assert.equal(lines.startLine, 2);
  assert.equal(lines.endLine, 4);
});

test("M2b PDF page selectors extract text and report OCR-required honestly", async () => {
  const textPdf = await fs.readFile(path.join(fixture, "offline-recovery.pdf"));
  const page = await selectSourceRegion(textPdf, { kind: "page", value: "2" }, { filename: "offline-recovery.pdf" });
  assert.equal(page.state, "selected");
  assert.match(page.text, /consumer lag/);
  assert.match(page.text, /purge/);
  assert.equal(page.page, 2);

  const imagePdf = await fs.readFile(path.join(fixture, "historical-scan.pdf"));
  const imagePage = await selectSourceRegion(imagePdf, { kind: "page", value: "1" }, { filename: "historical-scan.pdf" });
  assert.equal(imagePage.state, "ocr-required");
  assert.equal(imagePage.text, "");
  assert.equal(imagePage.page, 1);
});

test("M2b XLSX sheet/range selectors preserve useful row and column context", async () => {
  const workbook = await fs.readFile(path.join(fixture, "service-matrix.xlsx"));
  const region = await selectSourceRegion(
    workbook,
    { kind: "sheet", value: "Services!A1:D3" },
    { filename: "service-matrix.xlsx" },
  );
  assert.equal(region.state, "selected");
  assert.equal(region.sheet, "Services");
  assert.equal(region.range, "A1:D3");
  assert.match(region.text, /Owning team/);
  assert.match(region.text, /Data Plane/);
  assert.doesNotMatch(region.text, /stream-repair/);
});

test("M2b selector validation rejects malformed kinds, ranges, and values", () => {
  assert.throws(() => validateSelector({ kind: "lines", value: "0-2" }), /line selector/i);
  assert.throws(() => validateSelector({ kind: "page", value: "1-2" }), /page selector/i);
  assert.throws(() => validateSelector({ kind: "sheet", value: "Services!D3:A1" }), /sheet selector/i);
  assert.throws(() => validateSelector({ kind: "sheet", value: "Services!A1:XFD1048576" }), /sheet selector/i);
  assert.throws(() => validateSelector({ kind: "xpath", value: "/secret" }), /selector kind/i);
  assert.throws(() => validateSelector({ kind: "heading", value: "" }), /selector value/i);
});
