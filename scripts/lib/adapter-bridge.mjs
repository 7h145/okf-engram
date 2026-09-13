import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { VERSION } from "./constants.mjs";
import { errors } from "./errors.mjs";
import {
  acknowledgeJobResult,
  cancelJob,
  cleanJob,
  enqueueInferredMemoryJob,
  inspectJobResults,
  inspectJobs,
  retryJob,
  runJobs,
} from "./jobs.mjs";
import { getAutomaticMemoryPolicyStatus, getSensitiveDataPolicyStatus } from "./settings.mjs";

export const ADAPTER_BRIDGE_PROTOCOL = "okf-engram.adapter-bridge";
export const ADAPTER_BRIDGE_PROTOCOL_VERSION = 1;
export const ADAPTER_BRIDGE_SUPPORTED_PROTOCOL_VERSIONS = Object.freeze([ADAPTER_BRIDGE_PROTOCOL_VERSION]);
export const ADAPTER_BRIDGE_CAPABILITIES = Object.freeze([
  "project.policy.status",
  "project.inferred-memory.enqueue",
  "project.inferred-memory.jobs.list",
  "project.inferred-memory.jobs.show",
  "project.inferred-memory.jobs.run",
  "project.inferred-memory.jobs.cancel",
  "project.inferred-memory.jobs.retry",
  "project.inferred-memory.jobs.clean",
  "project.inferred-memory.results.list",
  "project.inferred-memory.results.acknowledge",
]);

const helperPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../engram.mjs");
const ADAPTER_COLLECTION_LIMIT = 100;

function envelope(operation, value = {}) {
  return {
    bridgeProtocol: ADAPTER_BRIDGE_PROTOCOL,
    bridgeProtocolVersion: ADAPTER_BRIDGE_PROTOCOL_VERSION,
    operation,
    ...value,
  };
}

export function assertAdapterBridgeProtocolVersion(value) {
  if (value !== ADAPTER_BRIDGE_PROTOCOL_VERSION) {
    throw errors.adapterBridgeIncompatible(value, ADAPTER_BRIDGE_SUPPORTED_PROTOCOL_VERSIONS);
  }
}

export function adapterBridgeError(error, rawArgs = []) {
  const operation = rawArgs[0] === "adapter" && rawArgs[1] === "bridge" ? rawArgs[2] : undefined;
  return {
    bridgeProtocol: ADAPTER_BRIDGE_PROTOCOL,
    bridgeProtocolVersion: ADAPTER_BRIDGE_PROTOCOL_VERSION,
    supportedProtocolVersions: [...ADAPTER_BRIDGE_SUPPORTED_PROTOCOL_VERSIONS],
    operation: typeof operation === "string" && /^[a-z-]{1,64}$/.test(operation) ? operation : null,
    error: {
      code: error.code ?? "ENGRAM_ERROR",
      message: String(error.message ?? error).slice(0, 4_096),
    },
  };
}

export function describeAdapterBridge() {
  return envelope("handshake", {
    supportedProtocolVersions: [...ADAPTER_BRIDGE_SUPPORTED_PROTOCOL_VERSIONS],
    package: { name: "okf-engram", version: VERSION },
    transport: { kind: "node-cli-json" },
    target: {
      corpusContext: "project",
      fallback: false,
      automaticMemoryOptInRequired: true,
      candidateOrigin: "automatic-review",
    },
    capabilities: [...ADAPTER_BRIDGE_CAPABILITIES],
    limits: {
      memoryClaimCharacters: 1_000,
      memoryEvidenceCharacters: 2_000,
      conversationContextReferences: 8,
      conversationContextReferenceCharacters: 256,
      collectionResults: ADAPTER_COLLECTION_LIMIT,
      workerRuntimeSeconds: { minimum: 30, maximum: 1_200, default: 900 },
    },
  });
}

function target(context) {
  return { corpusContext: "project", projectRootPath: context.projectRoot };
}

function policyIssue(status, label) {
  return status.valid ? null : `${label} is unavailable or invalid and is using its fail-closed value`;
}

export async function adapterProjectPolicyStatus(context) {
  const [automaticMemory, sensitiveData] = await Promise.all([
    getAutomaticMemoryPolicyStatus(context, { tolerateInvalid: true }),
    getSensitiveDataPolicyStatus(context, { tolerateInvalid: true }),
  ]);
  return envelope("project-policy-status", {
    target: target(context),
    automaticMemory: {
      state: automaticMemory.automaticMemory,
      generation: automaticMemory.generation ?? null,
      configured: automaticMemory.configured,
      valid: automaticMemory.valid,
      issue: policyIssue(automaticMemory, "Automatic-memory policy"),
    },
    sensitiveData: {
      mode: sensitiveData.knowledgeMode,
      previouslyUnguarded: sensitiveData.previouslyUnguarded,
      configured: sensitiveData.configured,
      valid: sensitiveData.valid,
      issue: policyIssue(sensitiveData, "Sensitive-data policy"),
    },
  });
}

function runnerCommand(context, jobId) {
  return [
    process.execPath,
    helperPath,
    "adapter",
    "bridge",
    "inferred-job-run",
    "--adapter-bridge-protocol-version",
    String(ADAPTER_BRIDGE_PROTOCOL_VERSION),
    "--project-working-directory",
    context.projectRoot,
    "--job-id",
    jobId,
  ];
}

export async function adapterEnqueueInferredMemory(context, candidate, options) {
  const result = await enqueueInferredMemoryJob(context, candidate, {
    ...options,
    origin: "automatic-review",
  });
  return envelope("inferred-memory-enqueue", {
    target: target(context),
    job: {
      jobId: result.jobId,
      state: result.state,
      duplicate: result.duplicate,
      retryRequired: result.retryRequired ?? false,
      reviewRequired: result.reviewRequired ?? false,
    },
    runnerCommand: result.state === "queued" ? runnerCommand(context, result.jobId) : null,
  });
}

function listJobSummary(job) {
  return {
    jobId: job.jobId,
    state: job.state,
    displayState: job.displayState,
    queuePosition: job.queuePosition ?? null,
    attempt: job.attempt,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    stale: job.stale,
    result: job.result
      ? {
          state: job.result.state,
          reason: job.result.reason ?? null,
          changes: job.result.changes,
          finishedAt: job.result.finishedAt,
        }
      : null,
  };
}

function shownJobSummary(job) {
  return listJobSummary({
    jobId: job.capsule.jobId,
    state: job.state.state,
    displayState: job.state.state === "queued" ? "waiting" : job.state.state,
    attempt: job.state.attempt,
    createdAt: job.capsule.createdAt,
    updatedAt: job.state.updatedAt,
    stale: job.stale,
    result: job.result
      ? {
          state: job.result.state,
          reason: job.result.reason,
          changes: job.result.changes?.length ?? 0,
          finishedAt: job.result.finishedAt,
        }
      : undefined,
  });
}

function requireInferredMemoryJob(job) {
  if (job.capsule.kind !== "inferred-memory") {
    throw errors.validation(`Job ${job.capsule.jobId} is not an inferred-memory job`);
  }
  return job;
}

function knowledgeReference(conceptId) {
  return { corpusContext: "project", conceptId };
}

function bridgeCandidate(candidate) {
  if (!candidate) return null;
  return {
    status: candidate.status,
    knowledgeReferences: (candidate.conceptIds ?? []).map(knowledgeReference),
    reason: candidate.reason ?? null,
    note: candidate.note ?? null,
  };
}

function bridgeResult(result) {
  return {
    jobId: result.jobId,
    jobState: result.jobState,
    acknowledgementState: result.acknowledgementState,
    acknowledgedAt: result.acknowledgedAt ?? null,
    finishedAt: result.finishedAt,
    reason: result.reason ?? null,
    candidate: bridgeCandidate(result.candidate),
    changes: (result.changes ?? []).map((change) => ({
      knowledgeReference: knowledgeReference(change.id),
      status: change.status,
      sha256: change.hash ?? null,
    })),
    review: result.review ?? null,
  };
}

export async function adapterListInferredJobs(context, { state } = {}) {
  const result = await inspectJobs(context, undefined, { state });
  const allJobs = result.jobs.filter((job) => job.kind === "inferred-memory").map(listJobSummary);
  return envelope("inferred-jobs-list", {
    target: target(context),
    jobs: allJobs.slice(0, ADAPTER_COLLECTION_LIMIT),
    total: allJobs.length,
    truncated: allJobs.length > ADAPTER_COLLECTION_LIMIT,
    issueCount: result.issues.length,
  });
}

export async function adapterShowInferredJob(context, jobId) {
  const result = await inspectJobs(context, jobId);
  const job = requireInferredMemoryJob(result.job);
  return envelope("inferred-job-show", {
    target: target(context),
    job: shownJobSummary(job),
  });
}

function bridgeJobMutation(operation, context, result, { includeRunner = false } = {}) {
  return envelope(operation, {
    target: target(context),
    job: {
      jobId: result.jobId,
      state: result.state ?? null,
      attempt: result.attempt ?? null,
      reason: result.reason ?? null,
      changes: result.changes ?? null,
      cancellation: result.cancellation ?? null,
      cleaned: result.cleaned ?? false,
    },
    ...(includeRunner ? { runnerCommand: result.state === "queued" ? runnerCommand(context, result.jobId) : null } : {}),
  });
}

export async function adapterRunInferredJob(context, jobId) {
  const result = await runJobs(context, { jobId, requiredKind: "inferred-memory" });
  const job = result.processed[0] ?? { jobId, state: null, reason: "not-processed", changes: 0 };
  return bridgeJobMutation("inferred-job-run", context, job);
}

export async function adapterCancelInferredJob(context, jobId) {
  const result = await cancelJob(context, jobId, { requiredKind: "inferred-memory" });
  return bridgeJobMutation("inferred-job-cancel", context, result);
}

export async function adapterRetryInferredJob(context, jobId) {
  const result = await retryJob(context, jobId, { requiredKind: "inferred-memory" });
  return bridgeJobMutation("inferred-job-retry", context, result, { includeRunner: true });
}

export async function adapterCleanInferredJob(context, jobId, { confirmJobStateDeletion = false } = {}) {
  const result = await cleanJob(context, jobId, {
    confirmJobStateDeletion,
    requiredKind: "inferred-memory",
  });
  return bridgeJobMutation("inferred-job-clean", context, result);
}

export async function adapterListInferredResults(context, options = {}) {
  const result = await inspectJobResults(context, options);
  const allResults = result.results.map(bridgeResult);
  return envelope("inferred-results-list", {
    target: target(context),
    results: allResults.slice(0, ADAPTER_COLLECTION_LIMIT),
    total: allResults.length,
    truncated: allResults.length > ADAPTER_COLLECTION_LIMIT,
    issueCount: result.issues.length,
  });
}

export async function adapterAcknowledgeInferredResult(context, jobId) {
  const result = await acknowledgeJobResult(context, jobId);
  return envelope("inferred-result-acknowledge", {
    target: target(context),
    acknowledgement: {
      jobId: result.jobId,
      state: result.acknowledgementState,
      acknowledgedAt: result.acknowledgedAt,
      alreadyAcknowledged: result.alreadyAcknowledged,
    },
  });
}
