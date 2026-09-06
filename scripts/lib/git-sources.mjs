import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { errors } from "./errors.mjs";
import { sha256 } from "./hash.mjs";
import { resolveLocalResource, digestResource } from "./sources.mjs";
import { selectSourceRegion, validateSelector } from "./selectors.mjs";

const execFileAsync = promisify(execFile);
const MAX_SOURCE_BYTES = 64 * 1024 * 1024;
const GIT_TIMEOUT = 5_000;

function isContained(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function posixPath(value) {
  return value.split(path.sep).join("/");
}

function isLfsPointer(bytes) {
  if (bytes.length > 4096) return false;
  const text = bytes.toString("utf8");
  return text.startsWith("version https://git-lfs.github.com/spec/v1\n")
    && /^oid sha256:[0-9a-f]{64}$/m.test(text)
    && /^size [0-9]+$/m.test(text);
}

async function git(cwd, args, { encoding = "utf8" } = {}) {
  try {
    const result = await execFileAsync("git", ["-C", cwd, ...args], {
      encoding,
      timeout: GIT_TIMEOUT,
      maxBuffer: MAX_SOURCE_BYTES + 1024 * 1024,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_OPTIONAL_LOCKS: "0",
        GIT_NO_LAZY_FETCH: "1",
        GIT_NO_REPLACE_OBJECTS: "1",
      },
    });
    return { ok: true, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      ok: false,
      unavailable: error.code === "ENOENT",
      code: error.code,
      stdout: error.stdout,
      stderr: error.stderr,
      message: error.message,
    };
  }
}

async function repositoryFor(sourcePath) {
  const result = await git(path.dirname(sourcePath), ["rev-parse", "--show-toplevel"]);
  if (!result.ok) return { state: "unavailable", reason: result.unavailable ? "git-unavailable" : "not-a-repository" };
  return { state: "available", root: await fs.realpath(result.stdout.trim()) };
}

async function gitAdministrativeRoots(repositoryRoot) {
  const roots = [];
  for (const argument of ["--absolute-git-dir", "--git-common-dir"]) {
    const result = await git(repositoryRoot, ["rev-parse", argument]);
    if (!result.ok) continue;
    const absolute = path.resolve(repositoryRoot, result.stdout.trim());
    roots.push(await fs.realpath(absolute).catch(() => absolute));
  }
  return [...new Set(roots)];
}

function repositoryLocator(repositoryRoot, projectRoot) {
  if (isContained(projectRoot, repositoryRoot)) {
    const relative = posixPath(path.relative(projectRoot, repositoryRoot));
    return `project:${relative || "."}`;
  }
  return pathToFileURL(repositoryRoot).href;
}

async function commitOid(repositoryRoot, ref) {
  const result = await git(repositoryRoot, ["rev-parse", "--verify", `${ref}^{commit}`]);
  return result.ok ? result.stdout.trim() : undefined;
}

async function objectAlgorithm(repositoryRoot, oid) {
  const result = await git(repositoryRoot, ["rev-parse", "--show-object-format"]);
  if (result.ok && ["sha1", "sha256"].includes(result.stdout.trim())) return result.stdout.trim();
  return oid.length === 64 ? "sha256" : "sha1";
}

async function treeBlob(repositoryRoot, commit, gitPath) {
  const result = await git(repositoryRoot, ["ls-tree", "-z", commit, "--", gitPath], { encoding: "buffer" });
  if (!result.ok || !result.stdout.length) return undefined;
  const record = result.stdout.subarray(0, result.stdout.indexOf(0) < 0 ? undefined : result.stdout.indexOf(0)).toString("utf8");
  const match = /^(\d+) (\S+) ([0-9a-f]+)\t(.+)$/s.exec(record);
  if (!match || match[2] !== "blob" || match[4] !== gitPath) return undefined;
  return { mode: match[1], oid: match[3] };
}

async function blobBytes(repositoryRoot, oid) {
  const result = await git(repositoryRoot, ["cat-file", "blob", oid], { encoding: "buffer" });
  return result.ok ? Buffer.from(result.stdout) : undefined;
}

async function objectExists(repositoryRoot, oid, type) {
  const result = await git(repositoryRoot, ["cat-file", "-e", `${oid}^{${type}}`]);
  return result.ok;
}

function validateOid(object, field) {
  if (!object || typeof object !== "object" || Array.isArray(object)) {
    throw errors.validation(`${field} must contain algorithm and oid`);
  }
  if (!["sha1", "sha256"].includes(object.algorithm)) {
    throw errors.validation(`${field}.algorithm must be sha1 or sha256`);
  }
  const length = object.algorithm === "sha1" ? 40 : 64;
  if (typeof object.oid !== "string" || !new RegExp(`^[0-9a-f]{${length}}$`).test(object.oid)) {
    throw errors.validation(`${field}.oid must be ${length} lowercase hexadecimal characters`);
  }
}

export function validateGitIdentity(identity) {
  if (!identity || typeof identity !== "object" || Array.isArray(identity)) {
    throw errors.validation("source git identity must be a mapping");
  }
  if (identity.remote !== undefined) {
    throw errors.validation("source git identity must not retain a remote URL");
  }
  if (typeof identity.repository !== "string"
      || !(identity.repository.startsWith("project:") || identity.repository.startsWith("file:"))) {
    throw errors.validation("source git.repository must be a project: or file: locator");
  }
  if (identity.repository.startsWith("project:")) {
    const relative = identity.repository.slice("project:".length);
    if (!relative || path.posix.isAbsolute(relative) || relative.includes("\\")
        || relative.split("/").some((part) => !part || part === ".." || (part === "." && relative !== "."))) {
      throw errors.validation("source git.repository has an unsafe project locator");
    }
  } else {
    try {
      fileURLToPath(identity.repository);
    } catch {
      throw errors.validation("source git.repository has an invalid file URI");
    }
  }
  validateOid(identity.commit, "source git.commit");
  validateOid(identity.blob, "source git.blob");
  if (identity.commit.algorithm !== identity.blob.algorithm) {
    throw errors.validation("source git commit/blob algorithms must match");
  }
  if (typeof identity.path !== "string" || !identity.path || path.posix.isAbsolute(identity.path)
      || identity.path.split("/").some((part) => !part || part === "." || part === "..")
      || identity.path.includes("\\") || identity.path.includes("\0")) {
    throw errors.validation("source git.path must be a safe repository-relative POSIX path");
  }
  return identity;
}

async function readBounded(file) {
  const stat = await fs.stat(file);
  if (!stat.isFile()) throw errors.usage(`Source is not a regular file: ${file}`);
  if (stat.size > MAX_SOURCE_BYTES) {
    throw errors.usage(`Source exceeds the ${MAX_SOURCE_BYTES}-byte capture limit: ${file}`);
  }
  return fs.readFile(file);
}

async function safeOutputPath(context, output, sourcePath, otherOutput, protectedRoots = []) {
  if (!output) throw errors.usage("source capture requires --to FILE");
  const lexical = path.resolve(output);
  if (lexical === path.resolve(sourcePath) || (otherOutput && lexical === path.resolve(otherOutput))) {
    throw errors.unsafePath("Source output must not overwrite the source or another output");
  }
  if (lexical.split(path.sep).some((part) => part.toLocaleLowerCase("en-US") === ".git")
      || protectedRoots.some((root) => isContained(root, lexical))) {
    throw errors.unsafePath("Source output must not write inside Git administrative state");
  }
  if (isContained(context.bundle, lexical) || isContained(context.logicalBundle, lexical)) {
    throw errors.unsafePath("Captured source bytes must remain outside the Engram bundle");
  }
  await fs.mkdir(path.dirname(lexical), { recursive: true, mode: 0o700 });
  const parent = await fs.realpath(path.dirname(lexical));
  const target = path.join(parent, path.basename(lexical));
  if (target === sourcePath || isContained(context.bundle, target)
      || protectedRoots.some((root) => isContained(root, target))) {
    throw errors.unsafePath("Source output resolves to a protected source, bundle, or Git administrative path");
  }
  try {
    await fs.lstat(target);
    throw errors.unsafePath(`Source output already exists: ${target}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return target;
}

async function writeExclusive(file, bytes) {
  let handle;
  try {
    handle = await fs.open(file, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
  } catch (error) {
    if (error.code === "EEXIST") throw errors.unsafePath(`Source output already exists: ${file}`);
    if (handle) await handle.close().catch(() => {});
    await fs.rm(file, { force: true }).catch(() => {});
    throw error;
  }
  await handle.close();
}

async function prepareOutputs(context, sourcePath, output, regionOutput, protectedRoots) {
  const raw = await safeOutputPath(context, output, sourcePath, regionOutput, protectedRoots);
  const region = regionOutput
    ? await safeOutputPath(context, regionOutput, sourcePath, output, protectedRoots)
    : undefined;
  return { raw, region };
}

async function selectorResult(bytes, selector, sourcePath) {
  return selector ? selectSourceRegion(bytes, validateSelector(selector), { filename: sourcePath }) : undefined;
}

async function persistCapture(context, sourcePath, bytes, {
  output, regionOutput, selector, protectedRoots = [],
}) {
  const selected = await selectorResult(bytes, selector, sourcePath);
  const outputs = await prepareOutputs(context, sourcePath, output, regionOutput, protectedRoots);
  await writeExclusive(outputs.raw, bytes);
  if (outputs.region && selected?.state === "selected") {
    await writeExclusive(outputs.region, Buffer.from(selected.text, "utf8"));
  }
  return {
    output: outputs.raw,
    region: selected ? {
      ...selected,
      output: outputs.region && selected.state === "selected" ? outputs.region : undefined,
    } : undefined,
  };
}

async function pinnedCandidate(repositoryRoot, sourcePath, projectRoot, ref = "HEAD") {
  const commit = await commitOid(repositoryRoot, ref);
  if (!commit) return { state: "digest-only", reason: "ref-unavailable" };
  const gitPath = posixPath(path.relative(repositoryRoot, sourcePath));
  if (!gitPath || gitPath.startsWith("../")) return { state: "digest-only", reason: "source-outside-repository" };
  const blob = await treeBlob(repositoryRoot, commit, gitPath);
  if (!blob) return { state: "digest-only", reason: "path-not-in-commit" };
  const bytes = await blobBytes(repositoryRoot, blob.oid);
  if (!bytes) return { state: "digest-only", reason: "object-unavailable" };
  const algorithm = await objectAlgorithm(repositoryRoot, commit);
  return {
    state: "pinned",
    bytes,
    identity: {
      repository: repositoryLocator(repositoryRoot, projectRoot),
      commit: { algorithm, oid: commit },
      path: gitPath,
      blob: { algorithm, oid: blob.oid },
    },
  };
}

export async function captureSource(context, resource, options = {}) {
  if (options.ref !== undefined && (
    typeof options.ref !== "string" || !options.ref || options.ref.startsWith("-")
    || options.ref.length > 1024 || /[\0\r\n]/.test(options.ref)
  )) {
    throw errors.usage("--ref must be a bounded Git revision that does not start with '-'");
  }
  const sourcePath = await resolveLocalResource(resource, context.projectRoot);
  let bytes = await readBounded(sourcePath);
  const liveBytes = bytes;
  await options.testHooks?.afterRead?.();
  const repository = await repositoryFor(sourcePath);
  let gitResult;

  if (options.ref) {
    if (repository.state !== "available") {
      return { state: "unavailable", resource, git: { state: "unavailable", reason: repository.reason } };
    }
    const candidate = await pinnedCandidate(repository.root, sourcePath, context.projectRoot, options.ref);
    if (candidate.state !== "pinned") {
      return { state: "unavailable", resource, git: { state: "unavailable", reason: candidate.reason } };
    }
    bytes = candidate.bytes;
    gitResult = { state: "pinned", identity: candidate.identity };
  } else if (isLfsPointer(bytes)) {
    return { state: "unavailable", resource, git: { state: "unavailable", reason: "lfs-pointer" } };
  } else if (repository.state !== "available") {
    gitResult = { state: "digest-only", reason: repository.reason };
  } else {
    const candidate = await pinnedCandidate(repository.root, sourcePath, context.projectRoot);
    if (candidate.state === "pinned" && isLfsPointer(candidate.bytes)) {
      gitResult = { state: "digest-only", reason: "lfs-pointer" };
    } else if (candidate.state === "pinned" && candidate.bytes.equals(bytes)) {
      gitResult = { state: "pinned", identity: candidate.identity };
    } else {
      gitResult = {
        state: "digest-only",
        reason: candidate.state === "pinned" ? "working-bytes-differ" : candidate.reason,
      };
    }
  }

  if (isLfsPointer(bytes)) {
    return { state: "unavailable", resource, git: { state: "unavailable", reason: "lfs-pointer" } };
  }
  const protectedRoots = repository.state === "available"
    ? await gitAdministrativeRoots(repository.root)
    : [];
  const persisted = await persistCapture(context, sourcePath, bytes, { ...options, protectedRoots });
  const result = {
    state: "captured",
    resource,
    path: sourcePath,
    digest: `sha256:${sha256(bytes)}`,
    size: bytes.length,
    selector: options.selector,
    git: gitResult,
    liveState: options.ref ? (liveBytes.equals(bytes) ? "unchanged" : "changed") : undefined,
    ...persisted,
  };
  Object.defineProperty(result, "bytes", { value: bytes, enumerable: false });
  return result;
}

async function resolveRepository(locator, projectRoot) {
  let root;
  try {
    root = await resolveLocalResource(locator, projectRoot);
  } catch {
    return { state: "unavailable", reason: "repository-unavailable" };
  }
  const stat = await fs.stat(root).catch(() => undefined);
  if (!stat?.isDirectory()) return { state: "unavailable", reason: "repository-unavailable" };
  const detected = await repositoryFor(path.join(root, ".engram-probe"));
  if (detected.state !== "available") {
    return { state: "unavailable", reason: detected.reason === "git-unavailable" ? "git-unavailable" : "repository-unavailable" };
  }
  if (detected.root !== root) return { state: "unavailable", reason: "identity-mismatch" };
  return { state: "available", root };
}

export async function resolvePinnedSource(context, source, options = {}) {
  let identity;
  try {
    identity = validateGitIdentity(source?.git);
    if (typeof source.digest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(source.digest)) {
      throw errors.validation("Pinned source requires a sha256 digest");
    }
    if (source.selector !== undefined) validateSelector(source.selector);
  } catch (error) {
    return { state: "unavailable", reason: "invalid-identity", error: error.message };
  }
  const repository = await resolveRepository(identity.repository, context.projectRoot);
  if (repository.state !== "available") return { state: "unavailable", reason: repository.reason };

  if (!(await objectExists(repository.root, identity.blob.oid, "blob"))) {
    return { state: "unavailable", reason: "object-unavailable" };
  }
  if (!(await objectExists(repository.root, identity.commit.oid, "commit"))) {
    return { state: "unavailable", reason: "object-unavailable" };
  }
  const format = await objectAlgorithm(repository.root, identity.commit.oid);
  if (format !== identity.commit.algorithm || format !== identity.blob.algorithm) {
    return { state: "unavailable", reason: "identity-mismatch" };
  }
  const tree = await treeBlob(repository.root, identity.commit.oid, identity.path);
  if (!tree || tree.oid !== identity.blob.oid) {
    return { state: "unavailable", reason: "identity-mismatch" };
  }
  const bytes = await blobBytes(repository.root, identity.blob.oid);
  if (!bytes) return { state: "unavailable", reason: "object-unavailable" };
  if (isLfsPointer(bytes)) return { state: "unavailable", reason: "lfs-pointer" };
  if (`sha256:${sha256(bytes)}` !== source.digest) {
    return { state: "unavailable", reason: "identity-mismatch" };
  }

  const expectedSourcePath = path.resolve(repository.root, ...identity.path.split("/"));
  if (!isContained(repository.root, expectedSourcePath)) {
    return { state: "unavailable", reason: "identity-mismatch" };
  }
  let sourcePath = expectedSourcePath;
  try {
    const livePath = await resolveLocalResource(source.resource, context.projectRoot);
    if (livePath !== expectedSourcePath) {
      return { state: "unavailable", reason: "identity-mismatch" };
    }
    sourcePath = livePath;
  } catch {
    // Live source availability is reported below; immutable resolution can proceed.
  }
  const persisted = options.output
    ? await persistCapture(context, sourcePath, bytes, {
      output: options.output,
      regionOutput: options.regionOutput,
      selector: source.selector,
      protectedRoots: await gitAdministrativeRoots(repository.root),
    })
    : { region: options.verifyOnly ? undefined : await selectorResult(bytes, source.selector, sourcePath) };
  let liveState;
  try {
    const live = await digestResource(source.resource, context.projectRoot);
    liveState = live.digest === source.digest ? "unchanged" : "changed";
  } catch {
    liveState = "missing";
  }
  const result = {
    state: "resolved",
    gitState: "verified",
    liveState,
    resource: source.resource,
    digest: source.digest,
    git: identity,
    selector: source.selector,
    size: bytes.length,
    ...persisted,
  };
  Object.defineProperty(result, "bytes", { value: bytes, enumerable: false });
  return result;
}
