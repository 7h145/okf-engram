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
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function tempProject(t, prefix = "engram auto-memory ") {
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

test("R1 auto-memory defaults off, persists opt-in, and gates automatic writes", async (t) => {
  const root = await tempProject(t);
  const draft = path.join(root, "inferred.md");
  await fs.writeFile(draft, inferredDraft());

  let result = await run(["auto-memory", "status", "--project-root", root, "--json"]);
  assert.equal(result.code, 3, result.stderr);

  result = await run(["init", "--project-root", root, "--json"]);
  assert.equal(result.code, 0, result.stderr);

  result = await run(["auto-memory", "status", "--project-root", root, "--json"]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    projectRoot: root,
    settings: path.join(root, ".agents", "data", "okf-engram", "settings.json"),
    autoMemory: "off",
    configured: false,
    valid: true,
  });

  result = await run([
    "put", "memories/blocked", "--from", draft, "--automatic-memory",
    "--project-root", root, "--json",
  ]);
  assert.equal(result.code, 4);
  assert.match(result.stderr, /AUTO_MEMORY_DISABLED/);
  assert.match(result.stderr, /disabled/i);

  result = await run(["auto-memory", "on", "--project-root", root, "--json"]);
  assert.equal(result.code, 0, result.stderr);
  const enabled = JSON.parse(result.stdout);
  assert.equal(enabled.autoMemory, "on");
  assert.equal(enabled.configured, true);

  const settings = path.join(root, ".agents", "data", "okf-engram", "settings.json");
  assert.deepEqual(JSON.parse(await fs.readFile(settings, "utf8")), { version: 1, autoMemory: "on" });
  assert.equal((await fs.stat(settings)).mode & 0o777, 0o600);

  result = await run([
    "put", "memories/allowed", "--from", draft, "--automatic-memory",
    "--project-root", root, "--json",
  ]);
  assert.equal(result.code, 0, result.stderr);

  result = await run(["status", "--project-root", root, "--json"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).autoMemory.autoMemory, "on");

  result = await run(["auto-memory", "off", "--project-root", root, "--json"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).autoMemory, "off");

  await fs.writeFile(draft, inferredDraft("Blocked after opt-out"));
  result = await run([
    "put", "memories/blocked-after-off", "--from", draft, "--automatic-memory",
    "--project-root", root, "--json",
  ]);
  assert.equal(result.code, 4);

  const explicit = path.join(root, "explicit.md");
  await fs.writeFile(explicit, explicitDraft());
  result = await run(["put", "memories/explicit", "--from", explicit, "--project-root", root, "--json"]);
  assert.equal(result.code, 0, result.stderr);
});

test("R1 auto is an exact shorthand for auto-memory", async (t) => {
  const root = await tempProject(t, "engram auto alias ");
  assert.equal((await run(["init", "--project-root", root])).code, 0);

  let result = await run(["auto", "on", "--project-root", root, "--json"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).autoMemory, "on");

  result = await run(["auto", "status", "--project-root", root, "--json"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).autoMemory, "on");

  result = await run(["auto", "off", "--project-root", root, "--json"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).autoMemory, "off");
});

test("R1 invalid settings fail closed without being overwritten", async (t) => {
  const root = await tempProject(t);
  assert.equal((await run(["init", "--project-root", root])).code, 0);
  const settings = path.join(root, ".agents", "data", "okf-engram", "settings.json");
  const invalid = "{ not json\n";
  await fs.writeFile(settings, invalid);

  let result = await run(["auto-memory", "status", "--project-root", root, "--json"]);
  assert.equal(result.code, 0, result.stderr);
  const status = JSON.parse(result.stdout);
  assert.equal(status.autoMemory, "off");
  assert.equal(status.configured, true);
  assert.equal(status.valid, false);
  assert.match(status.issue, /disabled/i);

  result = await run(["auto-memory", "on", "--project-root", root, "--json"]);
  assert.equal(result.code, 4);
  assert.equal(await fs.readFile(settings, "utf8"), invalid);

  const draft = path.join(root, "inferred.md");
  await fs.writeFile(draft, inferredDraft());
  result = await run([
    "put", "memories/blocked-invalid", "--from", draft, "--automatic-memory",
    "--project-root", root, "--json",
  ]);
  assert.equal(result.code, 4);
  assert.equal(await fs.readFile(settings, "utf8"), invalid);
});

test("R1 setting follows a canonical .agents root and rejects a settings symlink", async (t) => {
  const root = await tempProject(t, "engram auto-memory symlink ");
  await fs.mkdir(path.join(root, ".pi"));
  await fs.symlink(".pi", path.join(root, ".agents"), "dir");
  assert.equal((await run(["init", "--project-root", root])).code, 0);

  let result = await run(["auto-memory", "on", "--project-root", root, "--json"]);
  assert.equal(result.code, 0, result.stderr);
  const status = JSON.parse(result.stdout);
  assert.equal(status.settings, path.join(root, ".agents", "data", "okf-engram", "settings.json"));
  assert.equal(JSON.parse(await fs.readFile(path.join(root, ".pi", "data", "okf-engram", "settings.json"), "utf8")).autoMemory, "on");

  const outside = path.join(root, "outside.json");
  await fs.writeFile(outside, '{"version":1,"autoMemory":"on"}\n');
  await fs.unlink(path.join(root, ".pi", "data", "okf-engram", "settings.json"));
  await fs.symlink(outside, path.join(root, ".pi", "data", "okf-engram", "settings.json"));
  result = await run(["auto-memory", "status", "--project-root", root, "--json"]);
  assert.equal(result.code, 9);
  assert.match(result.stderr, /symlink/i);
});

test("R1 automatic-write marker only accepts inferred Memory and no explicit bundle", async (t) => {
  const root = await tempProject(t);
  assert.equal((await run(["init", "--project-root", root])).code, 0);
  assert.equal((await run(["auto-memory", "on", "--project-root", root])).code, 0);

  const explicit = path.join(root, "explicit.md");
  await fs.writeFile(explicit, explicitDraft());
  let result = await run([
    "put", "memories/not-inferred", "--from", explicit, "--automatic-memory",
    "--project-root", root, "--json",
  ]);
  assert.equal(result.code, 2);

  const bundle = path.join(root, ".agents", "data", "okf-engram", "bundle");
  result = await run(["auto-memory", "status", "--bundle", bundle, "--json"]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /default project context/i);
});
