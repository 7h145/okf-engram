import { errors } from "./errors.mjs";

const SELECTOR_KINDS = new Set(["heading", "lines", "page", "sheet"]);

function asText(bytes, kind) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw errors.validation(`${kind} selector requires UTF-8 text bytes`);
  }
}

function columnNumber(letters) {
  let number = 0;
  for (const character of letters) number = number * 26 + character.charCodeAt(0) - 64;
  return number;
}

function parseCellRange(value) {
  const match = /^([A-Z]+)([1-9]\d*):([A-Z]+)([1-9]\d*)$/i.exec(value);
  if (!match) throw errors.validation(`Invalid sheet selector range: ${value}`);
  const startColumn = columnNumber(match[1].toUpperCase());
  const startRow = Number(match[2]);
  const endColumn = columnNumber(match[3].toUpperCase());
  const endRow = Number(match[4]);
  if (startColumn > endColumn || startRow > endRow
      || (endColumn - startColumn + 1) * (endRow - startRow + 1) > 100_000) {
    throw errors.validation(`Invalid or oversized sheet selector range: ${value}`);
  }
  return { startColumn, startRow, endColumn, endRow, value: value.toUpperCase() };
}

function parseSheetSelector(value) {
  const match = /^(?:'((?:[^']|'')+)'|([^!]+?))(?:!([^!]+))?$/.exec(value);
  if (!match) throw errors.validation(`Invalid sheet selector: ${value}`);
  const sheet = (match[1] ? match[1].replaceAll("''", "'") : match[2]).trim();
  if (!sheet) throw errors.validation(`Invalid sheet selector: ${value}`);
  const range = match[3] ? parseCellRange(match[3].trim()) : undefined;
  return { sheet, range };
}

export function validateSelector(selector) {
  if (!selector || typeof selector !== "object" || Array.isArray(selector)) {
    throw errors.validation("selector must be a mapping with kind and value");
  }
  if (!SELECTOR_KINDS.has(selector.kind)) {
    throw errors.validation("selector kind must be heading, lines, page, or sheet");
  }
  if (typeof selector.value !== "string" || !selector.value.trim()) {
    throw errors.validation("selector value must be a non-empty string");
  }
  const value = selector.value.trim();
  if (value.length > 2048) throw errors.validation("selector value exceeds 2048 characters");
  if (selector.kind === "lines") {
    const match = /^([1-9]\d*)(?:-([1-9]\d*))?$/.exec(value);
    if (!match || (match[2] && Number(match[1]) > Number(match[2]))
        || Number(match[2] ?? match[1]) - Number(match[1]) + 1 > 100_000) {
      throw errors.validation(`Invalid or oversized line selector: ${value}`);
    }
    return { kind: "lines", value, startLine: Number(match[1]), endLine: Number(match[2] ?? match[1]) };
  }
  if (selector.kind === "page") {
    if (!/^[1-9]\d*$/.test(value)) throw errors.validation(`Invalid page selector: ${value}`);
    return { kind: "page", value, page: Number(value) };
  }
  if (selector.kind === "sheet") {
    return { kind: "sheet", value, ...parseSheetSelector(value) };
  }
  return { kind: "heading", value };
}

function selectHeading(bytes, selector) {
  const text = asText(bytes, "heading").replace(/\r\n/g, "\n");
  const lines = text.split("\n");
  const wanted = selector.value.normalize("NFKC").toLocaleLowerCase("en-US");
  let start = -1;
  let level;
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(lines[index]);
    if (!match) continue;
    const title = match[2].normalize("NFKC").toLocaleLowerCase("en-US");
    if (title === wanted) {
      start = index;
      level = match[1].length;
      break;
    }
  }
  if (start < 0) return { state: "not-found", kind: "heading", value: selector.value, text: "" };
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const match = /^(#{1,6})[ \t]+/.exec(lines[index]);
    if (match && match[1].length <= level) {
      end = index;
      break;
    }
  }
  while (end > start && !lines[end - 1].trim()) end -= 1;
  return {
    state: "selected", kind: "heading", value: selector.value,
    startLine: start + 1, endLine: end, text: lines.slice(start, end).join("\n"),
  };
}

function selectLines(bytes, selector) {
  const text = asText(bytes, "line").replace(/\r\n/g, "\n");
  const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
  if (selector.startLine > lines.length) {
    return { state: "not-found", kind: "lines", value: selector.value, text: "" };
  }
  const endLine = Math.min(selector.endLine, lines.length);
  return {
    state: "selected", kind: "lines", value: selector.value,
    startLine: selector.startLine, endLine,
    text: lines.slice(selector.startLine - 1, endLine).join("\n"),
  };
}

async function selectPdfPage(bytes, selector) {
  let document;
  try {
    if (!Promise.withResolvers) {
      Promise.withResolvers = () => {
        let resolve;
        let reject;
        const promise = new Promise((onResolve, onReject) => {
          resolve = onResolve;
          reject = onReject;
        });
        return { promise, resolve, reject };
      };
    }
    const { getDocument } = await import("pdfjs-dist/build/pdf.mjs");
    document = await getDocument({
      data: new Uint8Array(bytes),
      isEvalSupported: false,
      useSystemFonts: true,
    }).promise;
  } catch (error) {
    throw errors.validation(`Cannot parse PDF for page selector: ${error.message}`);
  }
  try {
    if (selector.page > document.numPages) {
      return { state: "not-found", kind: "page", value: selector.value, page: selector.page, text: "" };
    }
    const page = await document.getPage(selector.page);
    const content = await page.getTextContent();
    let text = "";
    for (const item of content.items) {
      if (!("str" in item)) continue;
      text += item.str;
      text += item.hasEOL ? "\n" : " ";
    }
    text = text.replace(/[ \t]+\n/g, "\n").replace(/[ \t]{2,}/g, " ").trim();
    return {
      state: text ? "selected" : "ocr-required",
      kind: "page", value: selector.value, page: selector.page, text,
    };
  } finally {
    await document.destroy();
  }
}

function cellText(value) {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  return String(value).replace(/[\t\r\n]+/g, " ");
}

async function selectSheet(bytes, selector) {
  let sheets;
  try {
    const { default: readXlsxFile } = await import("read-excel-file/node");
    sheets = await readXlsxFile(Buffer.from(bytes));
  } catch (error) {
    throw errors.validation(`Cannot parse XLSX for sheet selector: ${error.message}`);
  }
  const selected = sheets.find((item) => item.sheet === selector.sheet);
  if (!selected) {
    return { state: "not-found", kind: "sheet", value: selector.value, sheet: selector.sheet, text: "" };
  }
  const range = selector.range ?? {
    startColumn: 1,
    startRow: 1,
    endColumn: Math.max(1, ...selected.data.map((row) => row.length)),
    endRow: selected.data.length,
  };
  const rows = [];
  for (let row = range.startRow; row <= range.endRow; row += 1) {
    const values = [];
    for (let column = range.startColumn; column <= range.endColumn; column += 1) {
      values.push(cellText(selected.data[row - 1]?.[column - 1]));
    }
    while (values.length && !values.at(-1)) values.pop();
    rows.push(values.join("\t"));
  }
  while (rows.length && !rows.at(-1)) rows.pop();
  return {
    state: "selected", kind: "sheet", value: selector.value,
    sheet: selector.sheet, range: selector.range?.value, text: rows.join("\n"),
  };
}

export async function selectSourceRegion(bytes, inputSelector, options = {}) {
  const selector = validateSelector(inputSelector);
  if (selector.kind === "heading") return selectHeading(bytes, selector, options);
  if (selector.kind === "lines") return selectLines(bytes, selector, options);
  if (selector.kind === "page") return selectPdfPage(bytes, selector, options);
  return selectSheet(bytes, selector, options);
}
