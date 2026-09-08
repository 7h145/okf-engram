import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cli = path.join(repo, "scripts", "engram.mjs");

function run(args, { cwd = repo } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd });
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

async function tempProject(t, prefix = "engram automatic memory ") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

function inferredDraft(title = "Inferred decision") {
  return `---\ntype: Memory\ntitle: ${title}\ndescription: A durable inferred project decision.\ncapture: inferred\nsources:\n  - resource: urn:okf-engram:conversation:test\n---\n# Memory\n\nUse SQLite.\n`;
}

function explicitDraft() {
  return `---\ntype: Memory\ntitle: Explicit decision\ndescription: A directly requested project memory.\ncapture: explicit\nsources:\n  - resource: urn:okf-engram:conversation:test\n---\n# Memory\n\nUse SQLite.\n`;
}

test("R1 automatic-memory policy defaults off, persists opt-in, and gates automatic writes", async (t) => {
  const root = await tempProject(t);
  const draft = path.join(root, "inferred.md");
  await fs.writeFile(draft, inferredDraft());

  let result = await run([
    "policy",
    "project",
    "automatic-memory",
    "status",
    "--corpus-context",
    "project",
    "--project-root-path",
    root,
  ]);
  assert.equal(result.code, 3, result.stderr);

  result = await run(["corpus", "initialize", "--corpus-context", "project", "--project-root-path", root]);
  assert.equal(result.code, 0, result.stderr);

  result = await run([
    "policy",
    "project",
    "automatic-memory",
    "status",
    "--corpus-context",
    "project",
    "--project-root-path",
    root,
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    corpusContext: "project",
    projectRootPath: root,
    settingsFilePath: path.join(root, ".agents", "data", "okf-engram", "settings.json"),
    automaticMemory: "off",
    generation: 0,
    configured: false,
    valid: true,
  });

  result = await run([
    "concepts",
    "write",
    "--concept-id",
    "memories/blocked",
    "--corpus-context",
    "project",
    "--document-file-path",
    draft,
    "--write-mode",
    "automatic-inferred-memory",
    "--automatic-memory-policy-generation",
    "0",
    "--project-root-path",
    root,
  ]);
  assert.equal(result.code, 4);
  assert.match(result.stderr, /AUTOMATIC_MEMORY_DISABLED/);
  assert.match(result.stderr, /disabled/i);

  result = await run([
    "policy",
    "project",
    "automatic-memory",
    "enable",
    "--corpus-context",
    "project",
    "--project-root-path",
    root,
  ]);
  assert.equal(result.code, 0, result.stderr);
  const enabled = JSON.parse(result.stdout);
  assert.equal(enabled.automaticMemory, "on");
  assert.equal(enabled.generation, 1);
  assert.equal(enabled.configured, true);

  const settings = path.join(root, ".agents", "data", "okf-engram", "settings.json");
  assert.deepEqual(JSON.parse(await fs.readFile(settings, "utf8")), {
    version: 3,
    automaticMemory: "on",
    generation: 1,
  });
  assert.equal((await fs.stat(settings)).mode & 0o777, 0o600);

  result = await run([
    "concepts",
    "write",
    "--concept-id",
    "memories/missing-generation",
    "--corpus-context",
    "project",
    "--document-file-path",
    draft,
    "--write-mode",
    "automatic-inferred-memory",
    "--project-root-path",
    root,
  ]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /policy-generation/i);

  result = await run([
    "concepts",
    "write",
    "--concept-id",
    "memories/allowed",
    "--corpus-context",
    "project",
    "--document-file-path",
    draft,
    "--write-mode",
    "automatic-inferred-memory",
    "--automatic-memory-policy-generation",
    "1",
    "--project-root-path",
    root,
  ]);
  assert.equal(result.code, 0, result.stderr);

  result = await run(["corpus", "status", "--corpus-context", "project", "--project-root-path", root]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).automaticMemory.automaticMemory, "on");

  result = await run([
    "policy",
    "project",
    "automatic-memory",
    "disable",
    "--corpus-context",
    "project",
    "--project-root-path",
    root,
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).automaticMemory, "off");
  assert.equal(JSON.parse(result.stdout).generation, 2);

  await fs.writeFile(draft, inferredDraft("Blocked after opt-out"));
  result = await run([
    "concepts",
    "write",
    "--concept-id",
    "memories/blocked-after-off",
    "--corpus-context",
    "project",
    "--document-file-path",
    draft,
    "--write-mode",
    "automatic-inferred-memory",
    "--automatic-memory-policy-generation",
    "1",
    "--project-root-path",
    root,
  ]);
  assert.equal(result.code, 4);

  const explicit = path.join(root, "explicit.md");
  await fs.writeFile(explicit, explicitDraft());
  result = await run([
    "concepts",
    "write",
    "--concept-id",
    "memories/explicit",
    "--corpus-context",
    "project",
    "--document-file-path",
    explicit,
    "--project-root-path",
    root,
  ]);
  assert.equal(result.code, 0, result.stderr);
});

test("R1 canonical automatic-memory policy actions share one state", async (t) => {
  const root = await tempProject(t, "engram auto alias ");
  assert.equal(
    (await run(["corpus", "initialize", "--corpus-context", "project", "--project-root-path", root])).code,
    0,
  );

  let result = await run([
    "policy",
    "project",
    "automatic-memory",
    "enable",
    "--corpus-context",
    "project",
    "--project-root-path",
    root,
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).automaticMemory, "on");

  result = await run([
    "policy",
    "project",
    "automatic-memory",
    "status",
    "--corpus-context",
    "project",
    "--project-root-path",
    root,
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).automaticMemory, "on");

  result = await run([
    "policy",
    "project",
    "automatic-memory",
    "disable",
    "--corpus-context",
    "project",
    "--project-root-path",
    root,
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).automaticMemory, "off");
});

test("R1 invalid settings fail closed without being overwritten", async (t) => {
  const root = await tempProject(t);
  assert.equal(
    (await run(["corpus", "initialize", "--corpus-context", "project", "--project-root-path", root])).code,
    0,
  );
  const settings = path.join(root, ".agents", "data", "okf-engram", "settings.json");
  const invalid = "{ not json\n";
  await fs.writeFile(settings, invalid);

  let result = await run([
    "policy",
    "project",
    "automatic-memory",
    "status",
    "--corpus-context",
    "project",
    "--project-root-path",
    root,
  ]);
  assert.equal(result.code, 0, result.stderr);
  const status = JSON.parse(result.stdout);
  assert.equal(status.automaticMemory, "off");
  assert.equal(status.configured, true);
  assert.equal(status.valid, false);
  assert.match(status.issue, /disabled/i);

  result = await run([
    "policy",
    "project",
    "automatic-memory",
    "enable",
    "--corpus-context",
    "project",
    "--project-root-path",
    root,
  ]);
  assert.equal(result.code, 4);
  assert.equal(await fs.readFile(settings, "utf8"), invalid);

  const draft = path.join(root, "inferred.md");
  await fs.writeFile(draft, inferredDraft());
  result = await run([
    "concepts",
    "write",
    "--concept-id",
    "memories/blocked-invalid",
    "--corpus-context",
    "project",
    "--document-file-path",
    draft,
    "--write-mode",
    "automatic-inferred-memory",
    "--automatic-memory-policy-generation",
    "0",
    "--project-root-path",
    root,
  ]);
  assert.equal(result.code, 4);
  assert.equal(await fs.readFile(settings, "utf8"), invalid);
});

test("R1 setting follows a canonical .agents root and rejects a settings symlink", async (t) => {
  const root = await tempProject(t, "engram automatic memory symlink ");
  await fs.mkdir(path.join(root, ".pi"));
  await fs.symlink(".pi", path.join(root, ".agents"), "dir");
  assert.equal(
    (await run(["corpus", "initialize", "--corpus-context", "project", "--project-root-path", root])).code,
    0,
  );

  let result = await run([
    "policy",
    "project",
    "automatic-memory",
    "enable",
    "--corpus-context",
    "project",
    "--project-root-path",
    root,
  ]);
  assert.equal(result.code, 0, result.stderr);
  const status = JSON.parse(result.stdout);
  assert.equal(status.settingsFilePath, path.join(root, ".agents", "data", "okf-engram", "settings.json"));
  assert.equal(
    JSON.parse(await fs.readFile(path.join(root, ".pi", "data", "okf-engram", "settings.json"), "utf8"))
      .automaticMemory,
    "on",
  );

  const outside = path.join(root, "outside.json");
  await fs.writeFile(outside, '{"version":3,"automaticMemory":"on","generation":1}\n');
  await fs.unlink(path.join(root, ".pi", "data", "okf-engram", "settings.json"));
  await fs.symlink(outside, path.join(root, ".pi", "data", "okf-engram", "settings.json"));
  result = await run([
    "policy",
    "project",
    "automatic-memory",
    "status",
    "--corpus-context",
    "project",
    "--project-root-path",
    root,
  ]);
  assert.equal(result.code, 9);
  assert.match(result.stderr, /symlink/i);
});

test("R1 automatic-write marker only accepts inferred Memory and no explicit bundle", async (t) => {
  const root = await tempProject(t);
  assert.equal(
    (await run(["corpus", "initialize", "--corpus-context", "project", "--project-root-path", root])).code,
    0,
  );
  assert.equal(
    (
      await run([
        "policy",
        "project",
        "automatic-memory",
        "enable",
        "--corpus-context",
        "project",
        "--project-root-path",
        root,
      ])
    ).code,
    0,
  );

  const explicit = path.join(root, "explicit.md");
  await fs.writeFile(explicit, explicitDraft());
  let result = await run([
    "concepts",
    "write",
    "--concept-id",
    "memories/not-inferred",
    "--corpus-context",
    "project",
    "--document-file-path",
    explicit,
    "--write-mode",
    "automatic-inferred-memory",
    "--automatic-memory-policy-generation",
    "1",
    "--project-root-path",
    root,
  ]);
  assert.equal(result.code, 2);

  const bundle = path.join(root, ".agents", "data", "okf-engram", "bundle");
  result = await run(["policy", "project", "automatic-memory", "status", "--corpus-bundle-path", bundle]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /does not accept --corpus-bundle-path/i);
});
