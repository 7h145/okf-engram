import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cli = path.join(repo, "scripts", "engram.mjs");

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args]);
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

const draft = (title) =>
  `---\ntype: Memory\ntitle: ${title}\ndescription: Concurrent test memory.\ncapture: inferred\nsources:\n  - resource: urn:okf-engram:conversation:concurrency\n---\n# Memory\n\nConcurrent write.\n`;

function projectArgs(root) {
  return ["--project-root-path", root];
}

test("concurrent creates serialize and do not clobber", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "engram-concurrency-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  assert.equal(
    (await run(["corpus", "initialize", "--corpus-context", "project", "--project-root-path", root])).code,
    0,
  );
  const a = path.join(root, "a.md");
  const b = path.join(root, "b.md");
  await fs.writeFile(a, draft("Writer A"));
  await fs.writeFile(b, draft("Writer B"));

  const results = await Promise.all([
    run([
      "concepts",
      "write",
      "--concept-id",
      "memories/race",
      "--corpus-context",
      "project",
      "--document-file-path",
      a,
      "--project-root-path",
      root,
    ]),
    run([
      "concepts",
      "write",
      "--concept-id",
      "memories/race",
      "--corpus-context",
      "project",
      "--document-file-path",
      b,
      "--project-root-path",
      root,
    ]),
  ]);
  assert.deepEqual(results.map((result) => result.code).sort(), [0, 5]);

  const readResult = await run([
    "concepts",
    "read",
    "--concept-id",
    "memories/race",
    "--corpus-context",
    "project",
    "--project-root-path",
    root,
  ]);
  assert.equal(readResult.code, 0, readResult.stderr);
  const stored = JSON.parse(readResult.stdout).text;
  assert.ok(stored.includes("Writer A") || stored.includes("Writer B"));
});

test("R1 opt-out and automatic writes share one ordering lock", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "engram-policy-race-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  assert.equal((await run(["corpus", "initialize", "--corpus-context", "project", ...projectArgs(root)])).code, 0);
  assert.equal(
    (
      await run([
        "policy",
        "project",
        "automatic-memory",
        "enable",
        "--corpus-context",
        "project",
        ...projectArgs(root),
      ])
    ).code,
    0,
  );

  const candidate = path.join(root, "candidate.md");
  await fs.writeFile(candidate, draft("Policy race"));
  const [disabled, writeResult] = await Promise.all([
    run(["policy", "project", "automatic-memory", "disable", "--corpus-context", "project", ...projectArgs(root)]),
    run([
      "concepts",
      "write",
      "--concept-id",
      "memories/policy-race",
      "--corpus-context",
      "project",
      "--document-file-path",
      candidate,
      "--write-mode",
      "automatic-inferred-memory",
      "--automatic-memory-policy-generation",
      "1",
      ...projectArgs(root),
    ]),
  ]);

  assert.equal(disabled.code, 0, disabled.stderr);
  assert.ok([0, 4].includes(writeResult.code), writeResult.stderr);
  const status = await run([
    "policy",
    "project",
    "automatic-memory",
    "status",
    "--corpus-context",
    "project",
    ...projectArgs(root),
  ]);
  assert.equal(status.code, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).automaticMemory, "off");

  const after = await run([
    "concepts",
    "write",
    "--concept-id",
    "memories/after-off",
    "--corpus-context",
    "project",
    "--document-file-path",
    candidate,
    "--write-mode",
    "automatic-inferred-memory",
    "--automatic-memory-policy-generation",
    "1",
    ...projectArgs(root),
  ]);
  assert.equal(after.code, 4, after.stderr);
  assert.match(after.stderr, /AUTOMATIC_MEMORY_DISABLED/);
});
