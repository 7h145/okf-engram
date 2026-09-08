import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fork, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import lockfile from "proper-lockfile";
import { withBundleLock } from "../../scripts/lib/lock.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cli = path.join(repo, "scripts", "engram.mjs");
const pausedMutation = path.join(repo, "tests", "helpers", "paused-mutation.mjs");

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

async function project(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "engram failure "));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bundle = path.join(root, ".agents", "data", "okf-engram", "bundle");
  assert.equal(
    (await run(["corpus", "initialize", "--corpus-context", "project", "--project-root-path", root])).code,
    0,
  );
  return { root, bundle };
}

const draft = (title, body) => `---
type: Note
title: ${title}
description: R8 process interruption fixture.
---
# Note

${body}
`;

function waitForPause(child, timeout = 5_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("mutation child did not pause")), timeout);
    child.once("message", (message) => {
      clearTimeout(timer);
      resolve(message);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`mutation child exited before pause: ${code}/${signal}`));
    });
  });
}

async function killPausedMutation(root, id, file, pauseAt, expectedCurrentSha256) {
  const child = fork(pausedMutation, [root, id, file, pauseAt, expectedCurrentSha256 ?? ""], {
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  const message = await waitForPause(child);
  assert.equal(message.paused, pauseAt);
  child.kill("SIGKILL");
  await new Promise((resolve) => child.once("exit", resolve));
}

test("R8 lock contention is bounded and diagnostic", async (t) => {
  const { bundle } = await project(t);
  const release = await lockfile.lock(bundle, { realpath: false, stale: 10_000 });
  t.after(() => release());
  const started = Date.now();
  await assert.rejects(
    () => withBundleLock(bundle, async () => {}, { retries: 1 }),
    (error) => error.code === "LOCK_TIMEOUT",
  );
  assert.ok(Date.now() - started < 1_000);
});

test("R8 a stale lock left by a killed process is recoverable", async (t) => {
  const { bundle } = await project(t);
  const holder = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import lockfile from ${JSON.stringify(path.join(repo, "node_modules", "proper-lockfile", "index.js"))};
    await lockfile.lock(${JSON.stringify(bundle)}, { realpath: false, stale: 2000, update: 1000 });
    process.stdout.write("locked\\n");
    setInterval(() => {}, 1000);
  `,
    ],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("lock holder did not start")), 5_000);
    holder.stdout.once("data", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  holder.kill("SIGKILL");
  await new Promise((resolve) => holder.once("exit", resolve));
  await fs.access(`${bundle}.lock`);

  const started = Date.now();
  const value = await withBundleLock(bundle, async () => "recovered", {
    stale: 2_000,
    update: 1_000,
    retries: 40,
  });
  assert.equal(value, "recovered");
  assert.ok(Date.now() - started < 5_000);
});

test("R8 simultaneous independent concept writes are both retained", async (t) => {
  const { root } = await project(t);
  const a = path.join(root, "a.md");
  const b = path.join(root, "b.md");
  await fs.writeFile(a, draft("Independent A", "A body"));
  await fs.writeFile(b, draft("Independent B", "B body"));
  const results = await Promise.all([
    run([
      "concepts",
      "write",
      "--concept-id",
      "independent/a",
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
      "independent/b",
      "--corpus-context",
      "project",
      "--document-file-path",
      b,
      "--project-root-path",
      root,
    ]),
  ]);
  assert.deepEqual(
    results.map((result) => result.code),
    [0, 0],
  );
  for (const id of ["independent/a", "independent/b"]) {
    assert.equal(
      (await run(["concepts", "read", "--concept-id", id, "--corpus-context", "project", "--project-root-path", root]))
        .code,
      0,
    );
  }
});

test("R8 kill before replacement retains old-complete concept", async (t) => {
  const { root, bundle } = await project(t);
  const oldFile = path.join(root, "old.md");
  const nextFile = path.join(root, "next.md");
  await fs.writeFile(oldFile, draft("Old complete", "OLD COMPLETE SENTINEL"));
  await fs.writeFile(nextFile, draft("New complete", "NEW COMPLETE SENTINEL"));
  let result = await run([
    "concepts",
    "write",
    "--concept-id",
    "replace",
    "--corpus-context",
    "project",
    "--document-file-path",
    oldFile,
    "--project-root-path",
    root,
  ]);
  const original = JSON.parse(result.stdout);

  await killPausedMutation(root, "replace", nextFile, "before", original.hash);
  await fs.rm(`${bundle}.lock`, { recursive: true, force: true });
  result = await run([
    "concepts",
    "read",
    "--concept-id",
    "replace",
    "--corpus-context",
    "project",
    "--project-root-path",
    root,
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(JSON.parse(result.stdout).text, /OLD COMPLETE SENTINEL/);
  assert.doesNotMatch(JSON.parse(result.stdout).text, /NEW COMPLETE SENTINEL/);
});

test("R8 kill after replacement leaves new-complete concept and repairable index", async (t) => {
  const { root, bundle } = await project(t);
  const file = path.join(root, "new.md");
  await fs.writeFile(file, draft("After-kill title", "NEW COMPLETE SENTINEL"));

  await killPausedMutation(root, "after-kill", file, "after");
  await fs.rm(`${bundle}.lock`, { recursive: true, force: true });
  let result = await run([
    "concepts",
    "read",
    "--concept-id",
    "after-kill",
    "--corpus-context",
    "project",
    "--project-root-path",
    root,
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(JSON.parse(result.stdout).text, /NEW COMPLETE SENTINEL/);

  result = await run(["corpus", "validate", "--corpus-context", "project", "--project-root-path", root]);
  assert.ok(JSON.parse(result.stdout).issues.some((issue) => issue.code === "index-drift"));
  result = await run(["corpus", "repair-indexes", "--corpus-context", "project", "--project-root-path", root]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(await fs.readFile(path.join(bundle, "index.md"), "utf8"), /After-kill title/);
});
