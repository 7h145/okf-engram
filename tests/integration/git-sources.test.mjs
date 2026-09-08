import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stringify } from "yaml";
import { resolveProject } from "../../scripts/lib/project.mjs";
import { initializeCorpus, writeConcept } from "../../scripts/lib/bundle.mjs";
import { captureSource } from "../../scripts/lib/git-sources.mjs";

const execFileAsync = promisify(execFile);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cli = path.join(repo, "scripts", "engram.mjs");

function run(args, { env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      env: env ? { ...process.env, ...env } : process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function git(cwd, ...args) {
  return execFileAsync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

async function gitProject(t, { attributes } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "engram git source ü "));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await git(root, "init", "-q");
  await git(root, "config", "user.email", "fixture@example.invalid");
  await git(root, "config", "user.name", "Fixture");
  if (attributes) {
    await fs.writeFile(path.join(root, ".gitattributes"), attributes);
    await git(root, "add", ".gitattributes");
    await git(root, "commit", "-qm", "fixture attributes");
  }
  await fs.mkdir(path.join(root, "docs"));
  const source = path.join(root, "docs", "guide ü.md");
  const text = "# Guide\n\nIntro\n\n## Details\n\nPinned evidence line.\n\n## Next\n\nOther.\n";
  await fs.writeFile(source, text);
  await git(root, "add", ".");
  await git(root, "commit", "-qm", "fixture source");
  const context = await resolveProject({ projectRoot: root });
  await initializeCorpus(context);
  return { root, context, source, text };
}

function parse(result) {
  assert.equal(result.code, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function conceptDraft(sourceEntry) {
  return `---\n${stringify({
    type: "Knowledge",
    title: "Pinned guide evidence",
    description: "A source-resolution fixture.",
    sources: [sourceEntry],
  }).trimEnd()}\n---\n# Evidence\n\nPinned evidence line.[^guide]\n\n[^guide]: Guide details.\n`;
}

test("M2b captures clean committed bytes with immutable Git identity and a selector", async (t) => {
  const { root, source, text } = await gitProject(t);
  const raw = path.join(root, "tmp", "captured.bin");
  const region = path.join(root, "tmp", "region.txt");
  const before = (await git(root, "status", "--porcelain=v1", "--", "docs/guide ü.md")).stdout;
  const result = parse(
    await run([
      "sources",
      "capture",
      "--source-resource",
      "project:docs/guide ü.md",
      "--corpus-context",
      "project",
      "--output-file-path",
      raw,
      "--source-selector-kind",
      "heading",
      "--source-selector-value",
      "Details",
      "--selected-region-output-file-path",
      region,
      "--project-root-path",
      root,
    ]),
  );
  assert.equal(result.state, "captured");
  assert.equal(result.git.state, "pinned");
  assert.equal(result.git.identity.repository, "project:.");
  assert.equal(result.git.identity.path, "docs/guide ü.md");
  assert.match(result.git.identity.commit.oid, /^[0-9a-f]{40}$/);
  assert.match(result.git.identity.blob.oid, /^[0-9a-f]{40}$/);
  assert.equal(result.git.identity.commit.algorithm, "sha1");
  assert.equal(await fs.readFile(raw, "utf8"), text);
  assert.equal(await fs.readFile(region, "utf8"), "## Details\n\nPinned evidence line.");
  assert.equal((await git(root, "status", "--porcelain=v1", "--", "docs/guide ü.md")).stdout, before);
  assert.equal(await fs.readFile(source, "utf8"), text);
});

test("M2b dirty, untracked, filtered, non-Git, and no-Git-command captures remain digest-only", async (t) => {
  const dirty = await gitProject(t);
  await fs.appendFile(dirty.source, "dirty bytes\n");
  let result = parse(
    await run([
      "sources",
      "capture",
      "--source-resource",
      "project:docs/guide ü.md",
      "--corpus-context",
      "project",
      "--output-file-path",
      path.join(dirty.root, "dirty.bin"),
      "--project-root-path",
      dirty.root,
    ]),
  );
  assert.equal(result.git.state, "digest-only");
  assert.equal(result.git.reason, "working-bytes-differ");
  assert.equal(result.git.identity, undefined);

  const untracked = path.join(dirty.root, "docs", "new.txt");
  await fs.writeFile(untracked, "new source\n");
  result = parse(
    await run([
      "sources",
      "capture",
      "--source-resource",
      "project:docs/new.txt",
      "--corpus-context",
      "project",
      "--output-file-path",
      path.join(dirty.root, "new.bin"),
      "--project-root-path",
      dirty.root,
    ]),
  );
  assert.equal(result.git.reason, "path-not-in-commit");

  const filtered = await gitProject(t, { attributes: "*.md text eol=crlf\n" });
  const lfBlob = (await git(filtered.root, "show", "HEAD:docs/guide ü.md")).stdout;
  await fs.writeFile(filtered.source, lfBlob.replaceAll("\n", "\r\n"));
  await git(filtered.root, "diff", "--quiet", "--", "docs/guide ü.md");
  result = parse(
    await run([
      "sources",
      "capture",
      "--source-resource",
      "project:docs/guide ü.md",
      "--corpus-context",
      "project",
      "--output-file-path",
      path.join(filtered.root, "filtered.bin"),
      "--project-root-path",
      filtered.root,
    ]),
  );
  assert.equal(result.git.reason, "working-bytes-differ");

  const plain = await fs.mkdtemp(path.join(os.tmpdir(), "engram non git "));
  t.after(() => fs.rm(plain, { recursive: true, force: true }));
  await fs.writeFile(path.join(plain, "source.txt"), "plain\n");
  result = parse(
    await run([
      "sources",
      "capture",
      "--source-resource",
      "project:source.txt",
      "--corpus-context",
      "project",
      "--output-file-path",
      path.join(plain, "plain.bin"),
      "--project-root-path",
      plain,
    ]),
  );
  assert.equal(result.git.reason, "not-a-repository");

  result = parse(
    await run(
      [
        "sources",
        "capture",
        "--source-resource",
        "project:source.txt",
        "--corpus-context",
        "project",
        "--output-file-path",
        path.join(plain, "nogit.bin"),
        "--project-root-path",
        plain,
      ],
      { env: { PATH: "" } },
    ),
  );
  assert.equal(result.git.reason, "git-unavailable");
});

test("M2b external file resources use explicit non-portable repository hints", async (t) => {
  const external = await gitProject(t);
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "engram external source project "));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  const context = await resolveProject({ projectRoot });
  await initializeCorpus(context);
  const resource = pathToFileURL(external.source).href;
  const capture = await captureSource(context, resource, {
    output: path.join(projectRoot, "external-capture.bin"),
  });
  assert.equal(capture.git.state, "pinned");
  assert.equal(capture.git.identity.repository, pathToFileURL(external.root).href);
  await writeConcept(
    context,
    "evidence/external",
    conceptDraft({
      id: "guide",
      resource,
      title: "External guide",
      digest: capture.digest,
      git: capture.git.identity,
    }),
  );
  const resolved = parse(
    await run([
      "sources",
      "resolve",
      "--concept-id",
      "evidence/external",
      "--source-id",
      "guide",
      "--corpus-context",
      "project",
      "--output-file-path",
      path.join(projectRoot, "external-resolved.bin"),
      "--project-root-path",
      projectRoot,
    ]),
  );
  assert.equal(resolved.state, "resolved");
  assert.equal(resolved.liveState, "unchanged");
});

test("M2b an explicit revision captures commit bytes without checkout", async (t) => {
  const { root, source, text } = await gitProject(t);
  const oldCommit = (await git(root, "rev-parse", "HEAD")).stdout.trim();
  await fs.writeFile(source, "# Changed live source\n");
  await git(root, "add", ".");
  await git(root, "commit", "-qm", "change source");
  const currentHead = (await git(root, "rev-parse", "HEAD")).stdout.trim();

  const output = path.join(root, "old.bin");
  const result = parse(
    await run([
      "sources",
      "capture",
      "--source-resource",
      "project:docs/guide ü.md",
      "--corpus-context",
      "project",
      "--git-revision",
      oldCommit,
      "--output-file-path",
      output,
      "--project-root-path",
      root,
    ]),
  );
  assert.equal(result.git.state, "pinned");
  assert.equal(result.git.identity.commit.oid, oldCommit);
  assert.equal(result.liveState, "changed");
  assert.equal(await fs.readFile(output, "utf8"), text);
  assert.equal((await git(root, "rev-parse", "HEAD")).stdout.trim(), currentHead);
  assert.equal(await fs.readFile(source, "utf8"), "# Changed live source\n");

  const unavailableOutput = path.join(root, "unavailable-ref.bin");
  const unavailable = parse(
    await run([
      "sources",
      "capture",
      "--source-resource",
      "project:docs/guide ü.md",
      "--corpus-context",
      "project",
      "--git-revision",
      "0".repeat(40),
      "--output-file-path",
      unavailableOutput,
      "--project-root-path",
      root,
    ]),
  );
  assert.equal(unavailable.state, "unavailable");
  assert.equal(unavailable.git.reason, "git-revision-unavailable");
  await assert.rejects(() => fs.access(unavailableOutput), { code: "ENOENT" });
});

test("M2b resolves a recorded blob, verifies every identity component, and reports live drift", async (t) => {
  const { root, context, source } = await gitProject(t);
  const capture = await captureSource(context, "project:docs/guide ü.md", {
    output: path.join(root, "capture.bin"),
    selector: { kind: "heading", value: "Details" },
  });
  const entry = {
    id: "guide",
    resource: capture.resource,
    title: "Guide",
    digest: capture.digest,
    selector: capture.selector,
    git: capture.git.identity,
  };
  await writeConcept(context, "evidence/guide", conceptDraft(entry));
  await fs.writeFile(source, "# Live drift\n");

  const raw = path.join(root, "resolved.bin");
  const region = path.join(root, "resolved-region.txt");
  const result = parse(
    await run([
      "sources",
      "resolve",
      "--concept-id",
      "evidence/guide",
      "--source-id",
      "guide",
      "--corpus-context",
      "project",
      "--output-file-path",
      raw,
      "--selected-region-output-file-path",
      region,
      "--project-root-path",
      root,
    ]),
  );
  assert.equal(result.state, "resolved");
  assert.equal(result.gitState, "verified");
  assert.equal(result.liveState, "changed");
  assert.equal(await fs.readFile(raw, "utf8"), capture.bytes.toString("utf8"));
  assert.equal(await fs.readFile(region, "utf8"), "## Details\n\nPinned evidence line.");

  const checked = parse(
    await run([
      "sources",
      "check",
      "--corpus-context",
      "project",
      "--concept-id",
      "evidence/guide",
      "--project-root-path",
      root,
    ]),
  );
  assert.equal(checked.sourceClaims[0].state, "changed");
  assert.equal(checked.sourceClaims[0].gitState, "verified");
  const summary = parse(
    await run([
      "sources",
      "inventory",
      "--corpus-context",
      "project",
      "--concept-id",
      "evidence/guide",
      "--project-root-path",
      root,
    ]),
  );
  assert.equal(summary.resources[0].state, "changed");
  assert.equal(summary.resources[0].gitState, "verified");
  assert.equal(summary.resources[0].gitReferenceCount, 1);
  assert.deepEqual(summary.resources[0].gitStates, ["verified"]);

  await writeConcept(context, "evidence/live-only", conceptDraft({ ...entry, git: undefined }));
  const aggregate = parse(
    await run(["sources", "inventory", "--corpus-context", "project", "--project-root-path", root]),
  ).resources[0];
  assert.equal(aggregate.referenceCount, 2);
  assert.equal(aggregate.gitReferenceCount, 1);
  assert.equal(aggregate.gitState, "partial");
  assert.deepEqual(aggregate.gitStates, ["verified"]);

  await fs.rm(source);
  const missingLive = parse(
    await run([
      "sources",
      "resolve",
      "--concept-id",
      "evidence/guide",
      "--source-id",
      "guide",
      "--corpus-context",
      "project",
      "--output-file-path",
      path.join(root, "resolved-missing-live.bin"),
      "--project-root-path",
      root,
    ]),
  );
  assert.equal(missingLive.state, "resolved");
  assert.equal(missingLive.gitState, "verified");
  assert.equal(missingLive.liveState, "missing");
  const checkedMissing = parse(
    await run([
      "sources",
      "check",
      "--corpus-context",
      "project",
      "--concept-id",
      "evidence/guide",
      "--project-root-path",
      root,
    ]),
  );
  assert.equal(checkedMissing.sourceClaims[0].state, "missing");
  assert.equal(checkedMissing.sourceClaims[0].gitState, "verified");
});

test("M2b missing repositories, objects, and identity mismatches never produce source bytes", async (t) => {
  const { root, context } = await gitProject(t);
  const capture = await captureSource(context, "project:docs/guide ü.md", {
    output: path.join(root, "capture.bin"),
  });
  const base = {
    id: "guide",
    resource: capture.resource,
    title: "Guide",
    digest: capture.digest,
    git: capture.git.identity,
  };
  const cases = [
    [
      "missing-object",
      { ...base, git: { ...base.git, blob: { ...base.git.blob, oid: "0".repeat(40) } } },
      "object-unavailable",
    ],
    ["mismatch", { ...base, git: { ...base.git, path: "docs/other.md" } }, "identity-mismatch"],
    ["missing-repo", { ...base, git: { ...base.git, repository: "project:absent-repo" } }, "repository-unavailable"],
  ];
  for (const [id, entry, reason] of cases) {
    await writeConcept(context, `evidence/${id}`, conceptDraft(entry));
    const output = path.join(root, `${id}.out`);
    const result = parse(
      await run([
        "sources",
        "resolve",
        "--concept-id",
        `evidence/${id}`,
        "--source-id",
        "guide",
        "--corpus-context",
        "project",
        "--output-file-path",
        output,
        "--project-root-path",
        root,
      ]),
    );
    assert.equal(result.state, "unavailable");
    assert.equal(result.reason, reason);
    await assert.rejects(() => fs.access(output), { code: "ENOENT" });
  }
});

test("M2b SHA-256 repositories tag commit and blob algorithms explicitly", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "engram sha256 repo "));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  try {
    await execFileAsync("git", ["init", "-q", "--object-format=sha256", root]);
  } catch {
    t.skip("installed Git does not support SHA-256 repositories");
    return;
  }
  await git(root, "config", "user.email", "fixture@example.invalid");
  await git(root, "config", "user.name", "Fixture");
  await fs.writeFile(path.join(root, "source.txt"), "sha256 repository bytes\n");
  await git(root, "add", "source.txt");
  await git(root, "commit", "-qm", "sha256 source");
  const context = await resolveProject({ projectRoot: root });
  await initializeCorpus(context);
  const result = parse(
    await run([
      "sources",
      "capture",
      "--source-resource",
      "project:source.txt",
      "--corpus-context",
      "project",
      "--output-file-path",
      path.join(root, "captured.bin"),
      "--project-root-path",
      root,
    ]),
  );
  assert.equal(result.git.state, "pinned");
  assert.deepEqual([result.git.identity.commit.algorithm, result.git.identity.blob.algorithm], ["sha256", "sha256"]);
  assert.match(result.git.identity.commit.oid, /^[0-9a-f]{64}$/);
  assert.match(result.git.identity.blob.oid, /^[0-9a-f]{64}$/);
});

test("M2b shallow clones report unavailable historical objects without fetching", async (t) => {
  const origin = await gitProject(t);
  const capture = await captureSource(origin.context, "project:docs/guide ü.md", {
    output: path.join(origin.root, "old-capture.bin"),
  });
  await fs.writeFile(origin.source, "# New shallow tip\n");
  await git(origin.root, "add", "docs/guide ü.md");
  await git(origin.root, "commit", "-qm", "new tip");

  const clone = await fs.mkdtemp(path.join(os.tmpdir(), "engram shallow clone "));
  await fs.rm(clone, { recursive: true, force: true });
  t.after(() => fs.rm(clone, { recursive: true, force: true }));
  await execFileAsync("git", ["clone", "-q", "--depth=1", pathToFileURL(origin.root).href, clone]);
  const context = await resolveProject({ projectRoot: clone });
  await initializeCorpus(context);
  await writeConcept(
    context,
    "evidence/shallow",
    conceptDraft({
      id: "guide",
      resource: "project:docs/guide ü.md",
      title: "Guide",
      digest: capture.digest,
      git: capture.git.identity,
    }),
  );
  const output = path.join(clone, "old.out");
  const result = parse(
    await run([
      "sources",
      "resolve",
      "--concept-id",
      "evidence/shallow",
      "--source-id",
      "guide",
      "--corpus-context",
      "project",
      "--output-file-path",
      output,
      "--project-root-path",
      clone,
    ]),
  );
  assert.equal(result.state, "unavailable");
  assert.equal(result.reason, "object-unavailable");
  await assert.rejects(() => fs.access(output), { code: "ENOENT" });
  assert.equal((await git(clone, "rev-parse", "--is-shallow-repository")).stdout.trim(), "true");
});

test("M2b LFS pointer blobs are never returned as artifact payloads", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "engram lfs fixture "));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await git(root, "init", "-q");
  await git(root, "config", "user.email", "fixture@example.invalid");
  await git(root, "config", "user.name", "Fixture");
  const pointer = "version https://git-lfs.github.com/spec/v1\noid sha256:" + "1".repeat(64) + "\nsize 1234\n";
  await fs.writeFile(path.join(root, "asset.pdf"), pointer);
  await git(root, "add", "asset.pdf");
  await git(root, "commit", "-qm", "pointer");
  const output = path.join(root, "captured.pdf");
  const result = parse(
    await run([
      "sources",
      "capture",
      "--source-resource",
      "project:asset.pdf",
      "--corpus-context",
      "project",
      "--output-file-path",
      output,
      "--project-root-path",
      root,
    ]),
  );
  assert.equal(result.state, "unavailable");
  assert.equal(result.git.reason, "lfs-pointer");
  await assert.rejects(() => fs.access(output), { code: "ENOENT" });
});

test("M2b capture uses one byte snapshot across hashing, Git comparison, and selection", async (t) => {
  const { context, source, text, root } = await gitProject(t);
  const output = path.join(root, "snapshot.bin");
  const region = path.join(root, "snapshot-region.txt");
  const result = await captureSource(context, "project:docs/guide ü.md", {
    output,
    regionOutput: region,
    selector: { kind: "heading", value: "Details" },
    testHooks: {
      afterRead: () => fs.writeFile(source, "# Mutated after capture read\n"),
    },
  });
  assert.equal(result.git.state, "pinned");
  assert.equal(await fs.readFile(output, "utf8"), text);
  assert.equal(await fs.readFile(region, "utf8"), "## Details\n\nPinned evidence line.");
  assert.notEqual(await fs.readFile(source, "utf8"), text);
});

test("M2b capture rejects a separate Git administrative directory", async (t) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "engram separate git dir "));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, "worktree");
  const admin = path.join(parent, "administration");
  await execFileAsync("git", ["init", "-q", `--separate-git-dir=${admin}`, root]);
  await git(root, "config", "user.email", "fixture@example.invalid");
  await git(root, "config", "user.name", "Fixture");
  await fs.writeFile(path.join(root, "source.txt"), "source\n");
  await git(root, "add", "source.txt");
  await git(root, "commit", "-qm", "source");
  const result = await run([
    "sources",
    "capture",
    "--source-resource",
    "project:source.txt",
    "--corpus-context",
    "project",
    "--output-file-path",
    path.join(admin, "engram-output"),
    "--project-root-path",
    root,
  ]);
  assert.equal(result.code, 9, result.stderr);
  await assert.rejects(() => fs.access(path.join(admin, "engram-output")), { code: "ENOENT" });
});

test("M2b output paths cannot overwrite sources, bundle files, symlinks, or existing files", async (t) => {
  const { root, source } = await gitProject(t);
  const existing = path.join(root, "existing.bin");
  await fs.writeFile(existing, "keep");
  const linked = path.join(root, "linked.bin");
  await fs.symlink(existing, linked);
  for (const output of [
    source,
    path.join(root, ".agents", "data", "okf-engram", "bundle", "raw.bin"),
    path.join(root, ".git", "engram-output"),
    existing,
    linked,
  ]) {
    const result = await run([
      "sources",
      "capture",
      "--source-resource",
      "project:docs/guide ü.md",
      "--corpus-context",
      "project",
      "--output-file-path",
      output,
      "--project-root-path",
      root,
    ]);
    assert.notEqual(result.code, 0);
  }
  assert.equal(await fs.readFile(existing, "utf8"), "keep");
});
