import fs from "node:fs/promises";
import path from "node:path";
import { parseDocument as parseYamlDocument } from "yaml";
import { atomicWrite, pathExists } from "./io.mjs";
import { rejectInternalSymlinks } from "./paths.mjs";
import { splitFrontmatter } from "./document.mjs";
import { errors } from "./errors.mjs";

const START = "<!-- engram:index:start -->";
const END = "<!-- engram:index:end -->";

function markdownPath(value) {
  return value.split("/").map(encodeURIComponent).join("/");
}

function markdownText(value) {
  return String(value ?? "").replace(/\[|\]/g, "\\$&").replace(/\s+/g, " ").trim();
}

function directoryData(concepts) {
  const directories = new Map();
  directories.set("", { direct: [], children: new Set(["memories"]), total: 0 });
  directories.set("memories", { direct: [], children: new Set(), total: 0 });

  for (const item of concepts) {
    const parts = item.id.split("/");
    const directory = parts.slice(0, -1).join("/");
    if (!directories.has(directory)) directories.set(directory, { direct: [], children: new Set(), total: 0 });
    directories.get(directory).direct.push(item);

    for (let i = 0; i <= parts.length - 1; i += 1) {
      const ancestor = parts.slice(0, i).join("/");
      if (!directories.has(ancestor)) directories.set(ancestor, { direct: [], children: new Set(), total: 0 });
      directories.get(ancestor).total += 1;
      if (i < parts.length - 1) directories.get(ancestor).children.add(parts[i]);
    }
  }
  return directories;
}

function renderIndex(directory, data, directories) {
  const title = directory ? directory.split("/").at(-1) : "Engram";
  const lines = [];
  if (!directory) lines.push("---", 'okf_version: "0.2"', "---");
  lines.push(`# ${title}`, "", START);

  if (data.direct.length) {
    lines.push("", "## Concepts", "");
    for (const item of data.direct.sort((a, b) => a.id.localeCompare(b.id))) {
      const filename = `${item.id.split("/").at(-1)}.md`;
      const description = item.envelope.description ? ` — ${markdownText(item.envelope.description)}` : "";
      lines.push(`- [${markdownText(item.envelope.title ?? item.id)}](${markdownPath(filename)})${description}`);
    }
  }

  if (data.children.size) {
    lines.push("", "## Groups", "");
    for (const child of [...data.children].sort()) {
      const childId = directory ? `${directory}/${child}` : child;
      const count = directories.get(childId)?.total ?? 0;
      lines.push(`- [${child}](${markdownPath(child)}/) — ${count} concept${count === 1 ? "" : "s"}`);
    }
  }

  if (!data.direct.length && !data.children.size) lines.push("", "No concepts yet.");
  lines.push("", END, "");
  return `${lines.join("\n")}\n`;
}

function markerState(text) {
  const starts = [...text.matchAll(new RegExp(START, "g"))].map((match) => match.index);
  const ends = [...text.matchAll(new RegExp(END, "g"))].map((match) => match.index);
  if (!starts.length && !ends.length) return { kind: "unmanaged" };
  if (starts.length !== 1 || ends.length !== 1 || starts[0] >= ends[0]) return { kind: "malformed" };
  return { kind: "managed", start: starts[0], end: ends[0] + END.length };
}

function managedSection(text) {
  const state = markerState(text);
  if (state.kind !== "managed") throw new Error("Generated index template lacks one marker pair");
  return text.slice(state.start, state.end);
}

export function validateRootIndex(text, file = "index.md") {
  let yamlText;
  try {
    ({ yamlText } = splitFrontmatter(text, file));
  } catch (error) {
    throw errors.validation(`Invalid Engram root index ${file}: ${error.message}`);
  }
  const yaml = parseYamlDocument(yamlText, { prettyErrors: true, strict: true, uniqueKeys: true });
  if (yaml.errors.length) {
    throw errors.validation(`Invalid Engram root index ${file}: ${yaml.errors[0].message}`);
  }
  let data;
  try {
    data = yaml.toJS({ maxAliasCount: 50 });
  } catch (error) {
    throw errors.validation(`Invalid Engram root index ${file}: ${error.message}`);
  }
  if (!data || typeof data !== "object" || Array.isArray(data) || data.okf_version !== "0.2") {
    throw errors.validation(`Existing index does not declare string okf_version "0.2": ${file}`);
  }
  return data;
}

function ownershipIssue(file, state) {
  if (state.kind === "unmanaged") return {
    severity: "warning", category: "derived", code: "index-unmanaged", path: file,
    message: "Index has no Engram marker pair; user-owned content was preserved",
  };
  if (state.kind === "malformed") return {
    severity: "warning", category: "conformance", code: "index-markers", path: file,
    message: "Index has malformed Engram markers; content was preserved",
  };
  return undefined;
}

async function existingNamedFiles(bundle, filename) {
  const files = [];
  async function walk(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        if (entry.name === filename) files.push({ file, symlink: true });
        continue;
      }
      if (entry.isDirectory()) {
        if (!entry.name.startsWith(".")) await walk(file);
      } else if (entry.isFile() && entry.name === filename) {
        files.push({ file, symlink: false });
      }
    }
  }
  await walk(bundle);
  return files;
}

async function existingIndexFiles(bundle) {
  return existingNamedFiles(bundle, "index.md");
}

export async function inspectExistingLogs(bundle) {
  const issues = [];
  for (const item of await existingNamedFiles(bundle, "log.md")) {
    if (item.symlink) {
      issues.push({
        severity: "error", category: "safety", code: "log-symlink", path: item.file,
        message: "Log symlink is unsafe",
      });
      continue;
    }
    const text = await fs.readFile(item.file, "utf8");
    const lines = text.split(/\r?\n/);
    const headings = [];
    lines.forEach((line, index) => {
      const match = /^##\s+(.+?)\s*$/.exec(line);
      if (match) headings.push({ value: match[1], index });
    });
    let reason;
    if (/^---[ \t]*\r?\n/.test(text)) reason = "log.md must not contain frontmatter";
    else if (!headings.length) reason = "log.md requires date-group headings";
    else {
      const dates = headings.map((heading) => heading.value);
      if (dates.some((date) => {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return true;
        const parsed = new Date(`${date}T00:00:00Z`);
        return Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== date;
      })) {
        reason = "log.md headings must use valid YYYY-MM-DD dates";
      } else if (dates.some((date, index) => index > 0 && dates[index - 1] < date)) {
        reason = "log.md date groups must be newest first";
      } else if (headings.some((heading, index) => {
        const end = headings[index + 1]?.index ?? lines.length;
        return !lines.slice(heading.index + 1, end).some((line) => /^\s*[-*]\s+\S/.test(line));
      })) {
        reason = "each log.md date group requires a list entry";
      }
    }
    if (reason) issues.push({
      severity: "error", category: "conformance", code: "invalid-log",
      path: item.file, message: reason,
    });
  }
  return issues;
}

export async function inspectExistingIndexes(bundle) {
  const issues = [];
  const root = path.join(bundle, "index.md");
  for (const item of await existingIndexFiles(bundle)) {
    if (item.symlink) {
      issues.push({
        severity: "error", category: "safety", code: "index-symlink", path: item.file,
        message: "Index symlink is unsafe",
      });
      continue;
    }
    const text = await fs.readFile(item.file, "utf8");
    if (item.file === root) {
      try {
        validateRootIndex(text, item.file);
      } catch (error) {
        issues.push({
          severity: "error", category: "conformance", code: "invalid-root-index",
          path: item.file, message: error.message,
        });
        continue;
      }
    } else if (/^---[ \t]*\r?\n/.test(text)) {
      issues.push({
        severity: "error", category: "conformance", code: "subdirectory-index-frontmatter",
        path: item.file, message: "Subdirectory index must not contain frontmatter",
      });
      continue;
    }
    const issue = ownershipIssue(item.file, markerState(text));
    if (issue?.code === "index-markers") issues.push({ ...issue, severity: "error" });
  }
  return issues;
}

export function desiredIndexes(concepts, bundle) {
  const directories = directoryData(concepts);
  const desired = new Map();
  for (const [directory, data] of directories) {
    const file = path.join(bundle, ...(directory ? directory.split("/") : []), "index.md");
    desired.set(file, renderIndex(directory, data, directories));
  }
  return desired;
}

function emptyIndex(file, bundle) {
  const directory = path.relative(bundle, path.dirname(file)).split(path.sep).join("/");
  return renderIndex(directory, { direct: [], children: new Set(), total: 0 }, new Map());
}

async function obsoleteIndexFiles(bundle, desired) {
  return (await existingIndexFiles(bundle))
    .filter((item) => !desired.has(item.file))
    .sort((left, right) => right.file.split(path.sep).length - left.file.split(path.sep).length);
}

async function isPrunableGeneratedIndex(file, current, bundle) {
  const state = markerState(current);
  if (state.kind !== "managed") return false;
  const canonical = emptyIndex(file, bundle);
  const canonicalState = markerState(canonical);
  const currentShell = `${current.slice(0, state.start)}${current.slice(state.end)}`;
  const canonicalShell = `${canonical.slice(0, canonicalState.start)}${canonical.slice(canonicalState.end)}`;
  if (currentShell !== canonicalShell) return false;
  const entries = await fs.readdir(path.dirname(file), { withFileTypes: true });
  return entries.length === 1 && entries[0].name === "index.md" && entries[0].isFile();
}

export async function indexDrift(concepts, bundle) {
  const desired = desiredIndexes(concepts, bundle);
  const drift = [];
  const issues = await inspectExistingIndexes(bundle);
  const addIssue = (issue) => {
    if (!issues.some((existing) => existing.code === issue.code && existing.path === issue.path)) {
      issues.push(issue);
    }
  };
  const unsafe = new Set(issues.filter((issue) => issue.category === "safety").map((issue) => issue.path));
  for (const [file, content] of desired) {
    if (unsafe.has(file)) continue;
    if (!(await pathExists(file))) {
      drift.push({ file, reason: "missing" });
      continue;
    }
    const current = await fs.readFile(file, "utf8");
    const state = markerState(current);
    const issue = ownershipIssue(file, state);
    if (issue) {
      addIssue(issue);
      continue;
    }
    if (current.slice(state.start, state.end) !== managedSection(content)) {
      drift.push({ file, reason: "stale" });
    }
  }
  for (const item of await obsoleteIndexFiles(bundle, desired)) {
    if (item.symlink) {
      addIssue({
        severity: "error", category: "safety", code: "index-symlink", path: item.file,
        message: "Obsolete index symlink is unsafe",
      });
      continue;
    }
    const current = await fs.readFile(item.file, "utf8");
    const state = markerState(current);
    const issue = ownershipIssue(item.file, state);
    if (issue) {
      addIssue(issue);
      continue;
    }
    if (await isPrunableGeneratedIndex(item.file, current, bundle)) {
      drift.push({ file: item.file, reason: "obsolete" });
    } else if (current.slice(state.start, state.end) !== managedSection(emptyIndex(item.file, bundle))) {
      drift.push({ file: item.file, reason: "stale" });
    }
  }
  return { desired, drift, issues };
}

export async function writeIndexes(concepts, bundle) {
  const desired = desiredIndexes(concepts, bundle);
  const files = [];
  const issues = [];
  const root = path.join(bundle, "index.md");
  for (const [file, content] of desired) {
    await rejectInternalSymlinks(bundle, file);
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await rejectInternalSymlinks(bundle, file);
    if (!(await pathExists(file))) {
      await atomicWrite(file, content);
      files.push(file);
      continue;
    }
    const current = await fs.readFile(file, "utf8");
    if (file === root) validateRootIndex(current, file);
    const state = markerState(current);
    const issue = ownershipIssue(file, state);
    if (issue) {
      issues.push(issue);
      continue;
    }
    const updated = `${current.slice(0, state.start)}${managedSection(content)}${current.slice(state.end)}`;
    if (updated !== current) {
      await atomicWrite(file, updated);
      files.push(file);
    }
  }
  for (const item of await obsoleteIndexFiles(bundle, desired)) {
    if (item.symlink) {
      issues.push({
        severity: "error", category: "safety", code: "index-symlink", path: item.file,
        message: "Obsolete index symlink is unsafe and was preserved",
      });
      continue;
    }
    const current = await fs.readFile(item.file, "utf8");
    const state = markerState(current);
    const issue = ownershipIssue(item.file, state);
    if (issue) {
      issues.push(issue);
      continue;
    }
    if (await isPrunableGeneratedIndex(item.file, current, bundle)) {
      await rejectInternalSymlinks(bundle, item.file);
      await fs.unlink(item.file);
      await fs.rmdir(path.dirname(item.file));
      files.push(item.file);
      continue;
    }
    const content = emptyIndex(item.file, bundle);
    const updated = `${current.slice(0, state.start)}${managedSection(content)}${current.slice(state.end)}`;
    if (updated !== current) {
      await atomicWrite(item.file, updated);
      files.push(item.file);
    }
  }
  return { files, issues };
}
