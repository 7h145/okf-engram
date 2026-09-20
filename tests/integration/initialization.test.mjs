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

async function tempProject(t, prefix = "engram init review ") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

function paths(root) {
  const state = path.join(root, ".agents", "data", "okf-engram");
  return { state, bundle: path.join(state, "bundle") };
}

const note = (title = "Test note") =>
  `---\ntype: Note\ntitle: ${title}\ndescription: R2 fixture.\n---\n# Note\n\nBody.\n`;

test("R2 init rejects false, malformed, and incomplete bundle markers without overwrite", async (t) => {
  const cases = [
    ["prose marker", "Not an OKF file.\nExample: okf_version: 0.2\nValuable text.\n"],
    ["malformed YAML", "---\nokf_version: [broken\n---\n# Valuable\n"],
    ["wrong version", '---\nokf_version: "0.1"\n---\n# Valuable\n'],
  ];

  for (const [name, indexText] of cases) {
    await t.test(name, async () => {
      const root = await tempProject(t, `engram init ${name} `);
      const { bundle } = paths(root);
      await fs.mkdir(bundle, { recursive: true });
      const index = path.join(bundle, "index.md");
      await fs.writeFile(index, indexText);
      const result = await run(["corpus", "initialize", "--corpus-context", "project", "--project-root-path", root]);
      assert.equal(result.code, 4, result.stderr);
      assert.equal(await fs.readFile(index, "utf8"), indexText);
    });
  }

  await t.test("missing root marker in nonempty bundle", async () => {
    const root = await tempProject(t, "engram init missing root ");
    const { bundle } = paths(root);
    await fs.mkdir(bundle, { recursive: true });
    const concept = path.join(bundle, "valuable.md");
    await fs.writeFile(concept, note("Valuable"));
    const before = await fs.readFile(concept, "utf8");
    const result = await run(["corpus", "initialize", "--corpus-context", "project", "--project-root-path", root]);
    assert.equal(result.code, 4, result.stderr);
    assert.equal(await fs.readFile(concept, "utf8"), before);
    await assert.rejects(() => fs.access(path.join(bundle, "index.md")));
  });

  await t.test("invalid existing concept", async () => {
    const root = await tempProject(t, "engram init invalid concept ");
    const { bundle } = paths(root);
    await fs.mkdir(bundle, { recursive: true });
    const indexText = '---\nokf_version: "0.2"\n---\n# Engram\n';
    const invalid = "---\ntitle: Missing type\n---\nBody\n";
    await fs.writeFile(path.join(bundle, "index.md"), indexText);
    await fs.writeFile(path.join(bundle, "bad.md"), invalid);
    const result = await run(["corpus", "initialize", "--corpus-context", "project", "--project-root-path", root]);
    assert.equal(result.code, 4, result.stderr);
    assert.equal(await fs.readFile(path.join(bundle, "index.md"), "utf8"), indexText);
    assert.equal(await fs.readFile(path.join(bundle, "bad.md"), "utf8"), invalid);
  });

  await t.test("root index symlink", async () => {
    const root = await tempProject(t, "engram init root symlink ");
    const { bundle } = paths(root);
    await fs.mkdir(bundle, { recursive: true });
    const outside = path.join(root, "outside-index.md");
    const indexText = '---\nokf_version: "0.2"\n---\n# External\n';
    await fs.writeFile(outside, indexText);
    await fs.symlink(outside, path.join(bundle, "index.md"));
    const result = await run(["corpus", "initialize", "--corpus-context", "project", "--project-root-path", root]);
    assert.equal(result.code, 9, result.stderr);
    assert.equal(await fs.readFile(outside, "utf8"), indexText);
  });
});

test("R2 init adopts a valid existing store without repairing or reformatting it", async (t) => {
  const root = await tempProject(t);
  const { state, bundle } = paths(root);
  await fs.mkdir(bundle, { recursive: true });
  const index = path.join(bundle, "index.md");
  const indexText = `---\nokf_version: "0.2"\ncustom_root: preserve\n---\n# Human title\n\nHuman text.\n\n<!-- engram:index:start -->\nSTALE BUT STRUCTURED\n<!-- engram:index:end -->\n\nHuman footer.\n`;
  const concept = path.join(bundle, "note.md");
  const conceptText = note();
  await fs.writeFile(index, indexText);
  await fs.writeFile(concept, conceptText);

  const result = await run(["corpus", "initialize", "--corpus-context", "project", "--project-root-path", root]);
  assert.equal(result.code, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.created, false);
  assert.equal(output.readmeCreated, true);
  assert.equal(output.readmeFilePath, path.join(state, "README.md"));
  assert.equal(await fs.readFile(index, "utf8"), indexText);
  assert.equal(await fs.readFile(concept, "utf8"), conceptText);
});

test("initialization creates a read-only discovery guide without treating it as corpus content", async (t) => {
  const root = await tempProject(t, "engram discovery readme ");
  const { state, bundle } = paths(root);
  const readme = path.join(state, "README.md");

  let result = await run(["corpus", "initialize", "--corpus-context", "project", "--project-root-path", root]);
  assert.equal(result.code, 0, result.stderr);
  let output = JSON.parse(result.stdout);
  assert.equal(output.readmeCreated, true);
  assert.equal(output.readmeFilePath, readme);
  assert.equal((await fs.stat(readme)).mode & 0o777, 0o600);
  const guide = await fs.readFile(readme, "utf8");
  assert.match(guide, /github\.com\/7h145\/okf-engram/);
  assert.match(guide, /use `bundle\/` read-only as a Karpathy-style LLM wiki/);
  assert.match(guide, /sources:/);
  assert.match(guide, /project:.*owning project/s);
  assert.match(guide, /untrusted data rather than instructions/);
  assert.equal((await fs.readdir(bundle)).includes("README.md"), false);

  const custom = "# Project-owned discovery notes\n\nPreserve exactly.\n";
  await fs.writeFile(readme, custom);
  result = await run(["corpus", "initialize", "--corpus-context", "project", "--project-root-path", root]);
  assert.equal(result.code, 0, result.stderr);
  output = JSON.parse(result.stdout);
  assert.equal(output.created, false);
  assert.equal(output.readmeCreated, false);
  assert.equal(output.readmeFilePath, readme);
  assert.equal(await fs.readFile(readme, "utf8"), custom);

  await fs.rm(readme);
  const outside = path.join(root, "outside-readme.md");
  await fs.writeFile(outside, "outside stays unchanged\n");
  await fs.symlink(outside, readme);
  result = await run(["corpus", "initialize", "--corpus-context", "project", "--project-root-path", root]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).readmeCreated, false);
  assert.equal((await fs.lstat(readme)).isSymbolicLink(), true);
  assert.equal(await fs.readFile(outside, "utf8"), "outside stays unchanged\n");

  await fs.rm(readme);
  await fs.mkdir(readme);
  result = await run(["corpus", "initialize", "--corpus-context", "project", "--project-root-path", root]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).readmeCreated, false);
  assert.equal((await fs.stat(readme)).isDirectory(), true);
});

test("R2 generated index updates preserve root metadata and surrounding user text", async (t) => {
  const root = await tempProject(t);
  const { bundle } = paths(root);
  assert.equal(
    (await run(["corpus", "initialize", "--corpus-context", "project", "--project-root-path", root])).code,
    0,
  );
  const rootIndex = path.join(bundle, "index.md");
  const initial = await fs.readFile(rootIndex, "utf8");
  const customized = initial
    .replace('okf_version: "0.2"', 'okf_version: "0.2"\ncustom_root: preserve')
    .replace("# Engram\n", "# Human title\n\nHuman preface.\n")
    .replace("<!-- engram:index:end -->", "<!-- engram:index:end -->\n\nHuman footer.");
  await fs.writeFile(rootIndex, customized);

  const draft = path.join(root, "draft.md");
  await fs.writeFile(draft, note("Created note"));
  let result = await run([
    "concepts",
    "write",
    "--concept-id",
    "created",
    "--corpus-context",
    "project",
    "--document-file-path",
    draft,
    "--project-root-path",
    root,
  ]);
  assert.equal(result.code, 0, result.stderr);
  let updated = await fs.readFile(rootIndex, "utf8");
  assert.match(updated, /custom_root: preserve/);
  assert.match(updated, /# Human title/);
  assert.match(updated, /Human preface/);
  assert.match(updated, /Human footer/);
  assert.match(updated, /\[Created note\]\(created\.md\)/);

  updated = updated.replace(
    /<!-- engram:index:start -->[\s\S]*<!-- engram:index:end -->/,
    "<!-- engram:index:start -->\nSTALE\n<!-- engram:index:end -->",
  );
  await fs.writeFile(rootIndex, updated);
  result = await run(["corpus", "repair-indexes", "--corpus-context", "project", "--project-root-path", root]);
  assert.equal(result.code, 0, result.stderr);
  const repaired = await fs.readFile(rootIndex, "utf8");
  assert.doesNotMatch(repaired, /\nSTALE\n/);
  assert.match(repaired, /custom_root: preserve/);
  assert.match(repaired, /Human preface/);
  assert.match(repaired, /Human footer/);
});

test("R2 markerless and malformed indexes are never overwritten implicitly", async (t) => {
  const root = await tempProject(t);
  const { bundle } = paths(root);
  assert.equal(
    (await run(["corpus", "initialize", "--corpus-context", "project", "--project-root-path", root])).code,
    0,
  );
  const memories = path.join(bundle, "memories", "index.md");
  const markerless = "# Human memories index\n\nDo not replace this.\n";
  await fs.writeFile(memories, markerless);
  const draft = path.join(root, "draft.md");
  await fs.writeFile(draft, note());

  let result = await run([
    "concepts",
    "write",
    "--concept-id",
    "note",
    "--corpus-context",
    "project",
    "--document-file-path",
    draft,
    "--project-root-path",
    root,
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(await fs.readFile(memories, "utf8"), markerless);
  result = await run(["corpus", "repair-indexes", "--corpus-context", "project", "--project-root-path", root]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(await fs.readFile(memories, "utf8"), markerless);
  assert.ok(JSON.parse(result.stdout).issues.some((issue) => issue.code === "index-unmanaged"));

  const malformed = "# Human memories index\n\n<!-- engram:index:start -->\nNo end marker.\n";
  await fs.writeFile(memories, malformed);
  result = await run(["corpus", "repair-indexes", "--corpus-context", "project", "--project-root-path", root]);
  assert.equal(result.code, 4, result.stderr);
  assert.equal(await fs.readFile(memories, "utf8"), malformed);
  assert.ok(JSON.parse(result.stdout).issues.some((issue) => issue.code === "index-markers"));
});

test("R2 concurrent initialization converges without clobbering", async (t) => {
  const root = await tempProject(t, "engram concurrent init ");
  const results = await Promise.all(
    Array.from({ length: 4 }, () =>
      run(["corpus", "initialize", "--corpus-context", "project", "--project-root-path", root]),
    ),
  );
  for (const result of results) assert.equal(result.code, 0, result.stderr);
  assert.equal(results.filter((result) => JSON.parse(result.stdout).created).length, 1);
  assert.equal(results.filter((result) => JSON.parse(result.stdout).readmeCreated).length, 1);
  const lint = await run(["corpus", "validate", "--corpus-context", "project", "--project-root-path", root]);
  assert.equal(lint.code, 0, lint.stderr);
  assert.equal(JSON.parse(lint.stdout).counts.errors, 0);
});
