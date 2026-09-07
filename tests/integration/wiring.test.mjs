import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PROJECT_WIRING_BLOCK } from "../../scripts/lib/wiring.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cli = path.join(repo, "scripts", "engram.mjs");
const expectedBlock = `<!-- okf-engram:project-wiring:start -->
## Engram project memory

Use the \`okf-engram\` skill when work requires project knowledge, prior rationale,
explicit memory, or establishes a durable project decision worth retaining.
Follow the skill’s policy before inferring memory. Using the skill is not
permission to initialize Engram or enable automatic memory; do either only on an
explicit user request.
<!-- okf-engram:project-wiring:end -->`;

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

async function tempProject(t, prefix = "engram wiring ") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function init(root, { json = true } = {}) {
  return run(["init", "--project-root", root, ...(json ? ["--json"] : [])]);
}

function parse(result) {
  assert.equal(result.code, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("project wiring uses the approved minimal instruction", () => {
  assert.equal(PROJECT_WIRING_BLOCK, expectedBlock);
});

test("wiring status and preview are non-mutating; install requires initialization", async (t) => {
  const root = await tempProject(t);
  const agents = path.join(root, "AGENTS.md");

  let result = await run(["wiring", "status", "--project-root", root, "--json"]);
  let output = parse(result);
  assert.equal(output.state, "not-installed");
  assert.equal(output.installed, false);
  assert.equal(output.path, agents);
  await assert.rejects(() => fs.access(agents), { code: "ENOENT" });

  result = await run(["wiring", "preview", "--project-root", root, "--json"]);
  output = parse(result);
  assert.equal(output.block, expectedBlock);
  assert.equal(output.wouldChange, true);
  await assert.rejects(() => fs.access(agents), { code: "ENOENT" });

  result = await run(["wiring", "--project-root", root, "--json"]);
  assert.equal(result.code, 3);
  assert.match(result.stderr, /NOT_INITIALIZED/);
  await assert.rejects(() => fs.access(agents), { code: "ENOENT" });
});

test("bare wiring installs idempotently without enabling automatic memory", async (t) => {
  const root = await tempProject(t);
  const agents = path.join(root, "AGENTS.md");
  assert.equal((await init(root)).code, 0);

  let output = parse(await run(["wiring", "--project-root", root, "--json"]));
  assert.equal(output.action, "install");
  assert.equal(output.changed, true);
  assert.equal(output.created, true);
  assert.equal(await fs.readFile(agents, "utf8"), `${expectedBlock}\n`);
  assert.equal((await fs.stat(agents)).mode & 0o777, 0o644);

  const before = await fs.readFile(agents);
  output = parse(await run(["wiring", "install", "--project-root", root, "--json"]));
  assert.equal(output.changed, false);
  assert.equal(output.state, "installed");
  assert.deepEqual(await fs.readFile(agents), before);

  output = parse(await run(["wiring", "status", "--project-root", root, "--json"]));
  assert.equal(output.installed, true);
  const policy = parse(await run(["auto-memory", "status", "--project-root", root, "--json"]));
  assert.equal(policy.autoMemory, "off");
  assert.equal(policy.generation, 0);
});

test("wiring prepends to and removes from an existing AGENTS.md without changing its bytes", async (t) => {
  const root = await tempProject(t, "engram wiring preserve ");
  const agents = path.join(root, "AGENTS.md");
  const original = "# Existing instructions\r\n\r\nKeep this exact.\r\n";
  assert.equal((await init(root)).code, 0);
  await fs.writeFile(agents, original, { mode: 0o640 });

  let output = parse(await run(["wiring", "install", "--project-root", root, "--json"]));
  assert.equal(output.changed, true);
  assert.equal(output.created, false);
  assert.equal(await fs.readFile(agents, "utf8"), `${expectedBlock}\n\n${original}`);
  assert.equal((await fs.stat(agents)).mode & 0o777, 0o640);

  output = parse(await run(["wiring", "remove", "--project-root", root, "--json"]));
  assert.equal(output.changed, true);
  assert.equal(output.deletedFile, false);
  assert.equal(await fs.readFile(agents, "utf8"), original);
  assert.equal((await fs.stat(agents)).mode & 0o777, 0o640);
});

test("wiring remove deletes an AGENTS.md created solely for its block", async (t) => {
  const root = await tempProject(t, "engram wiring remove ");
  const agents = path.join(root, "AGENTS.md");
  assert.equal((await init(root)).code, 0);
  parse(await run(["wiring", "install", "--project-root", root, "--json"]));

  let output = parse(await run(["wiring", "remove", "--project-root", root, "--json"]));
  assert.equal(output.changed, true);
  assert.equal(output.deletedFile, true);
  await assert.rejects(() => fs.access(agents), { code: "ENOENT" });

  output = parse(await run(["wiring", "remove", "--project-root", root, "--json"]));
  assert.equal(output.changed, false);
  assert.equal(output.state, "not-installed");
});

test("wiring refuses modified, malformed, duplicate, and unsafe marker state", async (t) => {
  const cases = [
    ["modified", expectedBlock.replace("prior rationale", "changed rationale") + "\n"],
    ["misplaced", `# Existing\n\n${expectedBlock}\n`],
    ["start only", "<!-- okf-engram:project-wiring:start -->\nchanged\n"],
    ["duplicate", `${expectedBlock}\n\n${expectedBlock}\n`],
  ];
  for (const [name, content] of cases) {
    await t.test(name, async () => {
      const root = await tempProject(t, `engram wiring ${name} `);
      const agents = path.join(root, "AGENTS.md");
      assert.equal((await init(root)).code, 0);
      await fs.writeFile(agents, content);
      const before = await fs.readFile(agents);
      const status = parse(await run(["wiring", "status", "--project-root", root, "--json"]));
      assert.ok(["modified", "malformed"].includes(status.state));
      const preview = parse(await run(["wiring", "preview", "--project-root", root, "--json"]));
      assert.equal(preview.canInstall, false);
      assert.equal(preview.wouldChange, false);
      for (const action of ["install", "remove"]) {
        const result = await run(["wiring", action, "--project-root", root, "--json"]);
        assert.equal(result.code, 4);
        assert.match(result.stderr, /WIRING_(?:MODIFIED|MALFORMED)/);
        assert.deepEqual(await fs.readFile(agents), before);
      }
    });
  }

  await t.test("invalid UTF-8", async () => {
    const root = await tempProject(t, "engram wiring encoding ");
    const agents = path.join(root, "AGENTS.md");
    assert.equal((await init(root)).code, 0);
    const bytes = Buffer.from([0xff, 0xfe, 0x0a]);
    await fs.writeFile(agents, bytes);
    const result = await run(["wiring", "install", "--project-root", root, "--json"]);
    assert.equal(result.code, 4);
    assert.match(result.stderr, /WIRING_ENCODING/);
    assert.deepEqual(await fs.readFile(agents), bytes);
  });

  await t.test("directory", async () => {
    const root = await tempProject(t, "engram wiring directory ");
    const agents = path.join(root, "AGENTS.md");
    assert.equal((await init(root)).code, 0);
    await fs.mkdir(agents);
    const result = await run(["wiring", "install", "--project-root", root, "--json"]);
    assert.equal(result.code, 9);
    assert.match(result.stderr, /regular file/);
    assert.equal((await fs.stat(agents)).isDirectory(), true);
  });

  await t.test("symlink", async () => {
    const root = await tempProject(t, "engram wiring symlink ");
    const agents = path.join(root, "AGENTS.md");
    const outside = path.join(root, "outside.md");
    assert.equal((await init(root)).code, 0);
    await fs.writeFile(outside, "outside\n");
    await fs.symlink(outside, agents);
    const result = await run(["wiring", "install", "--project-root", root, "--json"]);
    assert.equal(result.code, 9);
    assert.match(result.stderr, /UNSAFE_PATH/);
    assert.equal(await fs.readFile(outside, "utf8"), "outside\n");
  });
});

test("wiring rejects explicit bundles and human init suggests without editing", async (t) => {
  const root = await tempProject(t, "engram wiring routing ");
  const agents = path.join(root, "AGENTS.md");
  const original = "# Existing project instructions\n";
  await fs.writeFile(agents, original);
  let result = await init(root, { json: false });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Optional.*\/engram wiring/s);
  assert.equal(await fs.readFile(agents, "utf8"), original);

  result = await run([
    "wiring", "status", "--bundle", path.join(root, ".agents", "data", "okf-engram", "bundle"),
    "--project-root", root, "--json",
  ]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /default project context/);
});
