#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_MAX_LOG_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_SECONDS = 600;

const PROFILES = {
  "self-pass": [
    { name: "self-pass", file: process.execPath, args: ["-e", "console.log('self pass')"] },
  ],
  "self-fail": [
    { name: "self-fail", file: process.execPath, args: ["-e", "console.error('SELF_FAIL_PRIVATE_OUTPUT');process.exit(7)"] },
  ],
  "self-timeout": [
    { name: "self-timeout", file: process.execPath, args: ["-e", "setInterval(()=>{},1000)"] },
  ],
  "self-overflow": [
    { name: "self-overflow", file: process.execPath, args: ["-e", "process.stdout.write('x'.repeat(1024*1024))"] },
  ],
  quick: [
    { name: "current-node-check", file: "npm", args: ["run", "check"] },
  ],
  full: [
    { name: "current-node-check", file: "npm", args: ["run", "check"] },
    { name: "node-20-runtime", file: "npx", args: ["--yes", "node@20.0.0", "--test"] },
    { name: "production-audit", file: "npm", args: ["audit", "--omit=dev"] },
    { name: "agent-skill-validation", file: "npx", args: ["--yes", "skills-ref@0.1.5", "validate", "."] },
    { name: "packed-install-and-pi-smoke", file: process.execPath, args: ["tests/verification/smoke.mjs"] },
  ],
};

function parseArgs(raw) {
  const args = [...raw];
  const take = (name) => {
    const index = args.indexOf(name);
    if (index < 0) return undefined;
    args.splice(index, 1);
    if (index >= args.length) throw new Error(`${name} requires a value`);
    return args.splice(index, 1)[0];
  };
  const flag = (name) => {
    const index = args.indexOf(name);
    if (index < 0) return false;
    args.splice(index, 1);
    return true;
  };
  const profile = take("--profile") ?? "quick";
  const outputDir = take("--output-dir");
  const timeoutSeconds = Number(take("--timeout-seconds") ?? DEFAULT_TIMEOUT_SECONDS);
  const maxLogBytes = Number(take("--max-log-bytes") ?? DEFAULT_MAX_LOG_BYTES);
  const allowDirty = flag("--allow-dirty");
  if (args.length) throw new Error(`Unexpected arguments: ${args.join(" ")}`);
  if (!outputDir) throw new Error("--output-dir is required");
  if (!PROFILES[profile]) throw new Error(`Unknown profile: ${profile}`);
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 3_600) {
    throw new Error("--timeout-seconds must be an integer from 1 through 3600");
  }
  if (!Number.isInteger(maxLogBytes) || maxLogBytes < 1_024 || maxLogBytes > 64 * 1024 * 1024) {
    throw new Error("--max-log-bytes must be from 1024 through 67108864");
  }
  return { profile, outputDir: path.resolve(outputDir), timeoutSeconds, maxLogBytes, allowDirty };
}

function now() {
  return new Date().toISOString();
}

async function gitSnapshot() {
  const run = (args) => new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(stdout.trimEnd()) : reject(new Error(stderr.trim())));
  });
  const commit = await run(["rev-parse", "HEAD"]);
  const status = await run(["status", "--porcelain=v1"]);
  const entries = status === "" ? [] : status.split("\n");
  return {
    commit,
    dirty: entries.length > 0,
    statusEntries: entries.length,
    statusSha256: `sha256:${createHash("sha256").update(status).digest("hex")}`,
    statusSample: entries.slice(0, 20),
  };
}

async function atomicJson(file, value) {
  const temporary = `${file}.tmp-${process.pid}`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, file);
}

function stopProcess(child, signal = "SIGTERM") {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The process already exited between checks.
    }
  }
}

async function runCommand(command, options, index) {
  const safeName = command.name.replace(/[^a-zA-Z0-9_.-]/g, "-");
  const logName = `${String(index + 1).padStart(2, "0")}-${safeName}.log`;
  const logPath = path.join(options.outputDir, logName);
  const handle = await fs.open(logPath, "wx", 0o600);
  const startedAt = now();
  const started = Date.now();
  let bytes = 0;
  let timedOut = false;
  let outputExceeded = false;
  let stopping = false;
  const hash = createHash("sha256");

  const child = spawn(command.file, command.args, {
    cwd: repo,
    env: { ...process.env, CI: "1", NO_COLOR: "1" },
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });

  const stop = (reason) => {
    if (stopping) return;
    stopping = true;
    if (reason === "timeout") timedOut = true;
    if (reason === "output") outputExceeded = true;
    stopProcess(child);
    setTimeout(() => stopProcess(child, "SIGKILL"), 2_000).unref();
  };
  const append = async (chunk) => {
    if (outputExceeded) return;
    const remaining = options.maxLogBytes - bytes;
    if (remaining <= 0) {
      stop("output");
      return;
    }
    const accepted = chunk.subarray(0, remaining);
    bytes += accepted.length;
    hash.update(accepted);
    await handle.write(accepted);
    if (accepted.length < chunk.length) stop("output");
  };
  let writes = Promise.resolve();
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => { writes = writes.then(() => append(chunk)); });
  }

  const timer = setTimeout(() => stop("timeout"), options.timeoutSeconds * 1_000);
  const outcome = await new Promise((resolve) => {
    child.on("error", (error) => resolve({ exitCode: null, signal: null, spawnError: error.message }));
    child.on("close", (exitCode, signal) => resolve({ exitCode, signal, spawnError: null }));
  });
  clearTimeout(timer);
  await writes;
  await handle.sync();
  await handle.close();
  const passed = outcome.exitCode === 0 && !timedOut && !outputExceeded && !outcome.spawnError;
  return {
    name: command.name,
    command: { executable: path.basename(command.file), argumentCount: command.args.length },
    startedAt,
    finishedAt: now(),
    durationMs: Date.now() - started,
    passed,
    ...outcome,
    timedOut,
    outputExceeded,
    log: logName,
    logBytes: bytes,
    logSha256: `sha256:${hash.digest("hex")}`,
  };
}

async function writeResult(outputDir, summary) {
  const lines = [
    `# Engram verification: ${summary.overall}`,
    "",
    `- Profile: \`${summary.profile}\``,
    `- Commit: \`${summary.start.commit}\``,
    `- Dirty input: ${summary.start.dirty ? "yes" : "no"}`,
    `- Source changed during run: ${summary.sourceChanged ? "yes" : "no"}`,
    `- Commands: ${summary.commands.filter((item) => item.passed).length}/${summary.commands.length} passed`,
    "",
    "| Command | Result | Duration | Private log |",
    "|---|---:|---:|---|",
    ...summary.commands.map((item) => (
      `| ${item.name} | ${item.passed ? "pass" : "FAIL"} | ${item.durationMs} ms | \`${item.log}\` |`
    )),
    "",
  ];
  if (summary.error) lines.push(`Runner error: ${summary.error}`, "");
  await fs.writeFile(path.join(outputDir, "result.md"), `${lines.join("\n")}\n`, { mode: 0o600 });
  await atomicJson(path.join(outputDir, "summary.json"), summary);
  await fs.writeFile(path.join(outputDir, "done"), "", { flag: "wx", mode: 0o600 });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await fs.mkdir(options.outputDir, { recursive: false, mode: 0o700 });
  const start = await gitSnapshot();
  const summary = {
    version: 1,
    profile: options.profile,
    repository: repo,
    startedAt: now(),
    finishedAt: null,
    start,
    end: null,
    sourceChanged: false,
    commands: [],
    overall: "failed",
  };

  if (start.dirty && !options.allowDirty) {
    summary.error = "Refusing to verify a dirty source tree without --allow-dirty";
  } else {
    for (const [index, command] of PROFILES[options.profile].entries()) {
      const result = await runCommand(command, options, index);
      summary.commands.push(result);
      if (!result.passed) break;
    }
  }

  summary.end = await gitSnapshot();
  summary.finishedAt = now();
  summary.sourceChanged = summary.start.commit !== summary.end.commit
    || summary.start.statusSha256 !== summary.end.statusSha256;
  const allPassed = summary.commands.length === PROFILES[options.profile].length
    && summary.commands.every((item) => item.passed);
  summary.overall = !summary.error && !summary.sourceChanged && allPassed ? "passed" : "failed";
  await writeResult(options.outputDir, summary);
  return summary.overall === "passed" ? 0 : 1;
}

main().then(
  (code) => { process.exitCode = code; },
  (error) => {
    console.error(error.stack ?? String(error));
    process.exitCode = 2;
  },
);
