import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const CLASSIFICATIONS = new Set([
  "test-assertion",
  "runtime-compatibility",
  "dependency",
  "environment",
  "timeout",
  "output-overflow",
  "product-defect",
  "test-defect",
  "unknown",
]);
const CONFIDENCE = new Set(["low", "medium", "high"]);
const REVIEW_KEYS = [
  "classification",
  "summary",
  "firstCausalLine",
  "likelyOwner",
  "hypotheses",
  "focusedCommand",
  "requiresStrongerReview",
  "uncertainty",
];

export class TriageError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "TriageError";
    this.code = code;
  }
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function boundedInteger(value, name, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new TriageError("invalid-config", `${name} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

export async function loadConfig(configPath, overrides = {}) {
  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(configPath, "utf8"));
  } catch (error) {
    throw new TriageError("invalid-config", `Cannot load triage config: ${error.message}`);
  }
  const config = {
    ...parsed,
    ...(overrides.model ? { model: overrides.model } : {}),
    ...(overrides.thinking ? { thinking: overrides.thinking } : {}),
  };
  if (config.version !== 1) throw new TriageError("invalid-config", "Triage config version must be 1");
  if (typeof config.model !== "string" || !config.model.trim() || config.model.length > 300) {
    throw new TriageError("invalid-config", "Triage model must be a non-empty bounded string");
  }
  if (!THINKING_LEVELS.has(config.thinking)) {
    throw new TriageError("invalid-config", `Unsupported thinking level: ${config.thinking}`);
  }
  boundedInteger(config.timeoutSeconds, "timeoutSeconds", 1, 3_600);
  boundedInteger(config.maxModelOutputBytes, "maxModelOutputBytes", 1_024, 1024 * 1024);
  boundedInteger(config.maxRequestBytes, "maxRequestBytes", 4_096, 1024 * 1024);
  boundedInteger(config.maxSourceLogBytes, "maxSourceLogBytes", 1_024, 64 * 1024 * 1024);
  boundedInteger(config.maxExcerptLinesPerLog, "maxExcerptLinesPerLog", 20, 2_000);
  boundedInteger(config.contextBefore, "contextBefore", 0, 500);
  boundedInteger(config.contextAfter, "contextAfter", 1, 1_000);
  boundedInteger(config.maximumFailedLogs, "maximumFailedLogs", 1, 10);
  return config;
}

function secretValues(environment) {
  return Object.entries(environment)
    .filter(([name, value]) => /(?:TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL|AUTH)/i.test(name)
      && typeof value === "string" && value.length >= 4)
    .map(([, value]) => value)
    .sort((left, right) => right.length - left.length);
}

export function redactText(input, environment = process.env) {
  let text = String(input).replaceAll("\0", "�");
  for (const secret of secretValues(environment)) text = text.split(secret).join("[REDACTED_ENV]");
  return text
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b/g, "[REDACTED_TOKEN]")
    .replace(/\b(api[_-]?key|token|password|secret)(\s*[=:]\s*)([^\s,;]+)/gi, "$1$2[REDACTED]");
}

function selectedIndexes(lines, config) {
  const signal = /(?:^|\b)(?:not ok|error|exception|assert(?:ion)?|failed?|ERR_[A-Z_]+|timed?\s*out)(?:\b|:)/i;
  const signalIndex = lines.findIndex((line) => signal.test(line));
  const center = signalIndex < 0 ? Math.max(0, lines.length - config.contextAfter) : signalIndex;
  const start = Math.max(0, center - config.contextBefore);
  const end = Math.min(lines.length, center + config.contextAfter + 1);
  const primary = Array.from({ length: end - start }, (_, index) => start + index);
  const tailLength = Math.min(40, Math.max(0, config.maxExcerptLinesPerLog - primary.length));
  const tail = Array.from({ length: tailLength }, (_, index) => lines.length - tailLength + index);
  return [...new Set([...primary, ...tail])]
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)
    .slice(0, config.maxExcerptLinesPerLog);
}

export function extractLogExcerpt(logName, text, config, startId = 1, environment = process.env) {
  const lines = redactText(text, environment).split(/\r?\n/);
  return selectedIndexes(lines, config).map((index, offset) => ({
    id: startId + offset,
    log: logName,
    originalLine: index + 1,
    text: lines[index],
  }));
}

async function regularFile(file, label) {
  let stat;
  try {
    stat = await fs.lstat(file);
  } catch (error) {
    throw new TriageError("invalid-input", `Cannot inspect ${label}: ${error.message}`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new TriageError("invalid-input", `${label} must be a regular non-symlink file`);
  }
  return stat;
}

async function git(repository, args) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd: repository, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout.trimEnd());
      else reject(new TriageError("git-state", `Git state check failed: ${stderr.trim()}`));
    });
  });
}

export async function gitSnapshot(repository) {
  const commit = await git(repository, ["rev-parse", "HEAD"]);
  const status = await git(repository, ["status", "--porcelain=v1"]);
  return {
    commit,
    dirty: status !== "",
    statusSha256: sha256(status),
    statusEntries: status === "" ? 0 : status.split("\n").length,
  };
}

async function loadVerification(verificationDir, config, environment) {
  const directoryStat = await fs.lstat(verificationDir).catch(() => null);
  if (!directoryStat?.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new TriageError("invalid-input", "Verification path must be a non-symlink directory");
  }
  await regularFile(path.join(verificationDir, "done"), "done");
  const summaryStat = await regularFile(path.join(verificationDir, "summary.json"), "summary.json");
  if (summaryStat.size > 256 * 1024) {
    throw new TriageError("input-limit", "Verification summary exceeds 262144 bytes");
  }
  let verification;
  try {
    verification = JSON.parse(await fs.readFile(path.join(verificationDir, "summary.json"), "utf8"));
  } catch (error) {
    throw new TriageError("invalid-input", `Cannot parse verification summary: ${error.message}`);
  }
  if (verification.overall !== "failed" || verification.sourceChanged !== false) {
    throw new TriageError("not-triageable", "Only completed failed runs with stable source are triageable");
  }
  if (typeof verification.repository !== "string" || !path.isAbsolute(verification.repository)) {
    throw new TriageError("invalid-input", "Verification summary has no absolute repository path");
  }
  const failed = (Array.isArray(verification.commands) ? verification.commands : [])
    .filter((command) => command?.passed === false);
  if (!failed.length) throw new TriageError("not-triageable", "Verification summary has no failed command");
  if (failed.length > config.maximumFailedLogs) {
    throw new TriageError("input-limit", `Failed log count exceeds ${config.maximumFailedLogs}`);
  }

  const entries = [];
  const failedCommands = [];
  for (const command of failed) {
    if (typeof command.name !== "string" || typeof command.log !== "string"
        || path.basename(command.log) !== command.log) {
      throw new TriageError("invalid-input", "Failed command has an invalid name or log path");
    }
    const logPath = path.join(verificationDir, command.log);
    const logStat = await regularFile(logPath, `failed log ${command.log}`);
    if (logStat.size > config.maxSourceLogBytes) {
      throw new TriageError("input-limit", `Failed log ${command.log} exceeds maxSourceLogBytes`);
    }
    const bytes = await fs.readFile(logPath);
    if (typeof command.logSha256 !== "string" || command.logSha256 !== sha256(bytes)) {
      throw new TriageError("invalid-input", `Failed log ${command.log} does not match its verification digest`);
    }
    const excerpt = extractLogExcerpt(command.log, bytes.toString("utf8"), config, entries.length + 1, environment);
    entries.push(...excerpt);
    failedCommands.push({
      name: command.name,
      exitCode: command.exitCode ?? null,
      signal: command.signal ?? null,
      timedOut: command.timedOut === true,
      outputExceeded: command.outputExceeded === true,
      log: command.log,
      excerptLines: excerpt.length,
    });
  }
  return { verification, failedCommands, entries, repository: path.resolve(verification.repository) };
}

function renderRequest(template, input, config) {
  const header = [
    template.trimEnd(),
    "",
    "## Verification metadata",
    "",
    `Profile: ${input.verification.profile ?? "unknown"}`,
    `Commit: ${input.verification.start?.commit ?? "unknown"}`,
    `Failed commands: ${JSON.stringify(input.failedCommands)}`,
    "",
    "## Untrusted failed-log excerpts",
    "",
  ].join("\n");
  const entries = [...input.entries];
  const render = () => `${header}${entries.map((entry) => (
    `L${entry.id} [${entry.log}:${entry.originalLine}]: ${entry.text}`
  )).join("\n")}\n`;
  let request = render();
  while (Buffer.byteLength(request) > config.maxRequestBytes && entries.length > 20) {
    entries.pop();
    request = render();
  }
  if (Buffer.byteLength(request) > config.maxRequestBytes) {
    throw new TriageError("input-limit", "Triage prompt and minimum excerpt exceed maxRequestBytes");
  }
  return { request, entries };
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
      // Process already exited.
    }
  }
}

export async function invokePiReviewer({ prompt, repository, config }) {
  const args = [
    "--print",
    "--no-session",
    "--no-tools",
    "--no-context-files",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--model", config.model,
    "--thinking", config.thinking,
    "Review the failed-log triage request supplied on stdin and return only the required JSON.",
  ];
  const child = spawn("pi", args, {
    cwd: repository,
    env: { ...process.env, PI_SKIP_VERSION_CHECK: "1" },
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
  });
  const started = Date.now();
  const stdout = [];
  const stderr = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let timedOut = false;
  let outputExceeded = false;
  let stopping = false;
  const stop = (reason) => {
    if (stopping) return;
    stopping = true;
    if (reason === "timeout") timedOut = true;
    if (reason === "output") outputExceeded = true;
    stopProcess(child);
    setTimeout(() => stopProcess(child, "SIGKILL"), 2_000).unref();
  };
  child.stdout.on("data", (chunk) => {
    const remaining = config.maxModelOutputBytes - stdoutBytes;
    const accepted = chunk.subarray(0, Math.max(0, remaining));
    if (accepted.length) stdout.push(accepted);
    stdoutBytes += accepted.length;
    if (accepted.length < chunk.length) stop("output");
  });
  child.stderr.on("data", (chunk) => {
    const remaining = config.maxModelOutputBytes - stderrBytes;
    const accepted = chunk.subarray(0, Math.max(0, remaining));
    if (accepted.length) stderr.push(accepted);
    stderrBytes += accepted.length;
    if (accepted.length < chunk.length) stop("output");
  });
  child.stdin.on("error", () => {});
  child.stdin.end(prompt);
  const timer = setTimeout(() => stop("timeout"), config.timeoutSeconds * 1_000);
  const outcome = await new Promise((resolve) => {
    child.on("error", (error) => resolve({ exitCode: null, signal: null, spawnError: error.message }));
    child.on("close", (exitCode, signal) => resolve({ exitCode, signal, spawnError: null }));
  });
  clearTimeout(timer);
  return {
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
    exitCode: outcome.exitCode,
    signal: outcome.signal,
    spawnError: outcome.spawnError,
    timedOut,
    outputExceeded,
    durationMs: Date.now() - started,
    stdoutBytes,
    stderrBytes,
  };
}

function oneLine(value, name, maximum, nullable = false) {
  if (nullable && value === null) return;
  if (typeof value !== "string" || !value.trim() || value.length > maximum || /[\r\n]/.test(value)) {
    throw new TriageError("invalid-review", `${name} must be a non-empty single-line string of at most ${maximum} characters`);
  }
}

export function parseAndValidateReview(raw, exposedLines) {
  let text = String(raw).trim();
  if (text.startsWith("```")) {
    text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  }
  let review;
  try {
    review = JSON.parse(text);
  } catch (error) {
    throw new TriageError("invalid-review", `Reviewer did not return JSON: ${error.message}`);
  }
  if (!review || typeof review !== "object" || Array.isArray(review)) {
    throw new TriageError("invalid-review", "Reviewer result must be an object");
  }
  const keys = Object.keys(review).sort();
  if (JSON.stringify(keys) !== JSON.stringify([...REVIEW_KEYS].sort())) {
    throw new TriageError("invalid-review", "Reviewer result fields do not match the required schema");
  }
  if (!CLASSIFICATIONS.has(review.classification)) {
    throw new TriageError("invalid-review", "Reviewer classification is unsupported");
  }
  oneLine(review.summary, "summary", 500);
  oneLine(review.likelyOwner, "likelyOwner", 300, true);
  oneLine(review.focusedCommand, "focusedCommand", 500, true);
  if (typeof review.uncertainty !== "string" || review.uncertainty.length > 500 || /[\r\n]/.test(review.uncertainty)) {
    throw new TriageError("invalid-review", "uncertainty must be a single-line string of at most 500 characters");
  }
  if (typeof review.requiresStrongerReview !== "boolean") {
    throw new TriageError("invalid-review", "requiresStrongerReview must be boolean");
  }
  const visible = new Set(exposedLines);
  if (review.firstCausalLine !== null
      && (!Number.isInteger(review.firstCausalLine) || !visible.has(review.firstCausalLine))) {
    throw new TriageError("invalid-review", "firstCausalLine does not cite a visible line");
  }
  if (!Array.isArray(review.hypotheses) || review.hypotheses.length > 3) {
    throw new TriageError("invalid-review", "hypotheses must contain at most three entries");
  }
  for (const [index, hypothesis] of review.hypotheses.entries()) {
    if (!hypothesis || typeof hypothesis !== "object" || Array.isArray(hypothesis)) {
      throw new TriageError("invalid-review", `hypotheses[${index}] must be an object`);
    }
    const hypothesisKeys = Object.keys(hypothesis).sort();
    if (JSON.stringify(hypothesisKeys) !== JSON.stringify(["confidence", "evidenceLines", "summary"])) {
      throw new TriageError("invalid-review", `hypotheses[${index}] fields are invalid`);
    }
    oneLine(hypothesis.summary, `hypotheses[${index}].summary`, 500);
    if (!CONFIDENCE.has(hypothesis.confidence)) {
      throw new TriageError("invalid-review", `hypotheses[${index}].confidence is invalid`);
    }
    if (!Array.isArray(hypothesis.evidenceLines) || hypothesis.evidenceLines.length < 1
        || hypothesis.evidenceLines.length > 12
        || hypothesis.evidenceLines.some((line) => !Number.isInteger(line) || !visible.has(line))) {
      throw new TriageError("invalid-review", `hypotheses[${index}] cites unavailable lines`);
    }
  }
  return review;
}

function sanitizedReview(review, environment) {
  return {
    ...review,
    summary: redactText(review.summary, environment),
    likelyOwner: review.likelyOwner === null ? null : redactText(review.likelyOwner, environment),
    focusedCommand: review.focusedCommand === null ? null : redactText(review.focusedCommand, environment),
    uncertainty: redactText(review.uncertainty, environment),
    hypotheses: review.hypotheses.map((hypothesis) => ({
      ...hypothesis,
      summary: redactText(hypothesis.summary, environment),
    })),
  };
}

async function atomicJson(file, value) {
  const temporary = `${file}.tmp-${process.pid}`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, file);
}

function resultMarkdown(summary) {
  const lines = [
    `# Failed-log triage: ${summary.overall}`,
    "",
    `- Model: \`${summary.model}\``,
    `- Thinking: \`${summary.thinking}\``,
    `- Verification commit: \`${summary.verification?.commit ?? "unknown"}\``,
    `- Source changed during triage: ${summary.sourceChanged ? "yes" : "no"}`,
  ];
  if (summary.review) {
    lines.push(
      `- Classification: **${summary.review.classification}**`,
      `- Stronger review required: ${summary.review.requiresStrongerReview ? "yes" : "no"}`,
      "",
      summary.review.summary,
      "",
      `First causal evidence: ${summary.review.firstCausalLine === null ? "not established" : `L${summary.review.firstCausalLine}`}`,
      `Likely owner: ${summary.review.likelyOwner ?? "not established"}`,
      `Focused reproduction: ${summary.review.focusedCommand ? `\`${summary.review.focusedCommand}\`` : "not established"}`,
      "",
      "## Hypotheses",
      "",
      ...summary.review.hypotheses.map((item) => (
        `- **${item.confidence}:** ${item.summary} (evidence ${item.evidenceLines.map((line) => `L${line}`).join(", ")})`
      )),
      "",
      `Uncertainty: ${summary.review.uncertainty || "none stated"}`,
    );
  } else {
    lines.push("", `Triage failed: ${summary.error?.message ?? "unknown error"}`);
  }
  return `${lines.join("\n")}\n`;
}

export async function runTriage(options, dependencies = {}) {
  const reviewer = dependencies.reviewer ?? invokePiReviewer;
  await fs.mkdir(options.outputDir, { recursive: false, mode: 0o700 });
  const startedAt = new Date().toISOString();
  const summary = {
    version: 1,
    overall: "failed",
    startedAt,
    finishedAt: null,
    model: options.config.model,
    thinking: options.config.thinking,
    verification: null,
    sourceStart: null,
    sourceEnd: null,
    sourceChanged: false,
    reviewer: null,
    review: null,
  };
  let repository;
  try {
    const template = await fs.readFile(options.promptPath, "utf8");
    const input = await loadVerification(options.verificationDir, options.config, options.environment);
    repository = input.repository;
    summary.verification = {
      directory: options.verificationDir,
      profile: input.verification.profile ?? null,
      commit: input.verification.start?.commit ?? null,
      failedCommands: input.failedCommands,
    };
    summary.sourceStart = await gitSnapshot(repository);
    const expected = input.verification.end;
    if (!expected || summary.sourceStart.commit !== expected.commit
        || summary.sourceStart.statusSha256 !== expected.statusSha256) {
      throw new TriageError("source-mismatch", "Repository no longer matches the completed verification run");
    }
    const rendered = renderRequest(template, input, options.config);
    await fs.writeFile(path.join(options.outputDir, "request.md"), rendered.request, { mode: 0o600, flag: "wx" });
    const reviewerResult = await reviewer({
      prompt: rendered.request,
      repository,
      config: options.config,
    });
    await fs.writeFile(path.join(options.outputDir, "model-output.txt"), reviewerResult.stdout, { mode: 0o600, flag: "wx" });
    await fs.writeFile(path.join(options.outputDir, "reviewer.stderr.log"), reviewerResult.stderr, { mode: 0o600, flag: "wx" });
    summary.reviewer = {
      exitCode: reviewerResult.exitCode,
      signal: reviewerResult.signal,
      spawnError: reviewerResult.spawnError,
      timedOut: reviewerResult.timedOut,
      outputExceeded: reviewerResult.outputExceeded,
      durationMs: reviewerResult.durationMs,
      stdoutBytes: reviewerResult.stdoutBytes,
      stderrBytes: reviewerResult.stderrBytes,
      outputSha256: sha256(reviewerResult.stdout),
    };
    if (reviewerResult.exitCode !== 0 || reviewerResult.spawnError
        || reviewerResult.timedOut || reviewerResult.outputExceeded) {
      throw new TriageError("reviewer-failed", "Reviewer process failed; inspect its private stderr log if needed");
    }
    const exposedLines = rendered.entries.map((entry) => entry.id);
    const review = parseAndValidateReview(reviewerResult.stdout, exposedLines);
    summary.review = sanitizedReview(review, options.environment);
    parseAndValidateReview(JSON.stringify(summary.review), exposedLines);
    summary.overall = "completed";
  } catch (error) {
    summary.error = {
      code: error instanceof TriageError ? error.code : "triage-failed",
      message: error instanceof Error ? error.message : String(error),
    };
  }
  if (repository) {
    try {
      summary.sourceEnd = await gitSnapshot(repository);
      summary.sourceChanged = summary.sourceStart?.commit !== summary.sourceEnd.commit
        || summary.sourceStart?.statusSha256 !== summary.sourceEnd.statusSha256;
      if (summary.sourceChanged) {
        summary.overall = "failed";
        summary.error = { code: "source-changed", message: "Repository changed while triage was running" };
      }
    } catch (error) {
      summary.overall = "failed";
      summary.error = { code: "git-state", message: error.message };
    }
  }
  summary.finishedAt = new Date().toISOString();
  await fs.writeFile(path.join(options.outputDir, "result.md"), resultMarkdown(summary), { mode: 0o600 });
  await atomicJson(path.join(options.outputDir, "summary.json"), summary);
  await fs.writeFile(path.join(options.outputDir, "done"), "", { mode: 0o600, flag: "wx" });
  return summary;
}
