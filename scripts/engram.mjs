#!/usr/bin/env node
import fs from "node:fs/promises";
import process from "node:process";
import { stringify as stringifyYaml } from "yaml";
import { resolveGlobal, resolveProject } from "./lib/project.mjs";
import {
  initializeCorpus,
  readConcept,
  writeConcept,
  listCorpora,
  readCorpora,
  searchCorpora,
  validateCorpus,
  inspectCorpusStatus,
  inspectSourceClaims,
  listSourceFiles,
  inventorySources,
  deprecateConcept,
  deleteConcept,
} from "./lib/bundle.mjs";
import { digestResource } from "./lib/sources.mjs";
import { captureSource, resolvePinnedSource } from "./lib/git-sources.mjs";
import { EngramError, errors } from "./lib/errors.mjs";
import { VERSION } from "./lib/constants.mjs";
import {
  addCorpusLink,
  configuredCorpusLinkNames,
  listCorpusLinks,
  removeCorpusLink,
  resolveCorpusLinks,
} from "./lib/links.mjs";
import {
  getAutomaticMemoryPolicyStatus,
  getSensitiveDataPolicyStatus,
  setSensitiveDataPolicy,
} from "./lib/settings.mjs";
import { inspectProjectWiring, installProjectWiring, removeProjectWiring } from "./lib/wiring.mjs";
import {
  enqueueArtifactIngestJob,
  enqueueArtifactIngestBatch,
  enqueueInferredMemoryJob,
  inspectJobs,
  cleanJob,
  cancelJob,
  retryJob,
  runJobs,
  setProjectAutomaticMemoryPolicy,
  inspectJobResults,
  acknowledgeJobResult,
} from "./lib/jobs.mjs";
import {
  adapterAcknowledgeInferredResult,
  adapterBridgeError,
  adapterCancelInferredJob,
  adapterCleanInferredJob,
  adapterEnqueueInferredMemory,
  adapterListInferredJobs,
  adapterListInferredResults,
  adapterProjectPolicyStatus,
  adapterRetryInferredJob,
  adapterRunInferredJob,
  adapterShowInferredJob,
  assertAdapterBridgeProtocolVersion,
  describeAdapterBridge,
} from "./lib/adapter-bridge.mjs";

const HUMAN_HELP = `okf-engram ${VERSION} — linked project and personal knowledge

Agent-maintained knowledge bases for durable project knowledge and explicit memories.
No address means this project. Prefix knowledge work with:
  @P or @project       this project
  @G or @global        global memory
  @NAME                one linked knowledge base
  @L or @linked        every link
  @A or @all           project, global memory when initialized, and every link
Repeat addresses for a read subset, for example: /engram @P @docs recall QUESTION

Common work:
  /engram — status of the project knowledge base
  /engram [@ADDRESS ...] recall QUESTION — answer from selected knowledge
  /engram [@ADDRESS ...] ls — list concepts
  /engram [@ADDRESS ...] find WORDS — search concepts
  /engram [@ADDRESS ...] show CONCEPT_ID — show one unambiguous concept
  /engram remember STATEMENT — retain project knowledge
  /engram @G remember STATEMENT — retain global memory
  /engram queue FILE... — ingest project data asynchronously
  /engram sources — list referenced project files

Links:
  /engram links — list link status and privacy mode
  /engram link NAME PATH — link an existing local knowledge base
  /engram unlink NAME — remove a link without changing its target

Further actions:
  /engram ingest FILE... — ingest project data in the foreground
  /engram inventory — inspect project source references
  /engram jobs [JOB_ID] — inspect jobs
  /engram cancel JOB_ID — cancel deferred work
  /engram [@P|@G] remove CONCEPT_ID — delete after confirmation

Setup and policy:
  /engram [@P|@G] init — initialize the selected writable knowledge base
  /engram [@P|@G] mode status|guarded|unguarded — manage sensitive data
  /engram wire|unwire — manage the project reminder
  /engram auto status|on|off — manage project automatic memory
  /engram help — this help

Commands are strict. Linked knowledge is always read-only.
See /engram --help for the complete agent interface.`;

const AGENT_HELP = `okf-engram ${VERSION} — canonical agent DSL

Usage:
  /engram <domain> <operation> [descriptive long options]

Operation kinds:
  [S] semantic workflow interpreted by the active Engram skill
  [D] deterministic helper operation

Corpus — the OKF knowledge aggregate: location, health, validation, indexes, and links.
  [D] corpus initialize       --corpus-context CONTEXT
      Creates a missing adjacent read-only discovery README; never overwrites one.
  [D] corpus locate           --corpus-context CONTEXT... [--linked-corpus-name NAME]...
                              [--corpus-read-set all|linked]
  [D] corpus status           --corpus-context CONTEXT... [--linked-corpus-name NAME]...
                              [--corpus-read-set all|linked]
  [D] corpus validate         --corpus-context CONTEXT... [--linked-corpus-name NAME]...
                              [--corpus-read-set all|linked]
  [D] corpus repair-indexes   --corpus-context CONTEXT
  [D] corpus links list       --corpus-context project
  [D] corpus links add        --corpus-context project --link-name NAME
                              --linked-corpus-path PATH
  [D] corpus links remove     --corpus-context project --link-name NAME

Knowledge — semantic incorporation of external artifacts into a corpus.
  [S] knowledge ingest        --corpus-context CONTEXT
                              --source-resource RESOURCE...
                              [--ingest-instruction TEXT]

Memory — semantic remembering and selective retrieval from corpora.
  [S] memory remember         --corpus-context CONTEXT
                              --memory-statement TEXT
  [S] memory recall           --corpus-context CONTEXT...
                              [--linked-corpus-name NAME]...
                              [--corpus-read-set all|linked]
                              --recall-question TEXT

Concepts — deterministic operations on individual OKF concept documents.
  [D] concepts list           --corpus-context CONTEXT...
                              [--linked-corpus-name NAME]...
                              [--corpus-read-set all|linked] [--concept-type TYPE]
      TYPE is an exact, case-sensitive, open OKF value (for example Concept or Memory).
  [D] concepts search         --corpus-context CONTEXT...
                              [--linked-corpus-name NAME]...
                              [--corpus-read-set all|linked]
                              --query TEXT [--result-limit INTEGER]
                              [--include-deprecated]
  [D] concepts read           --corpus-context CONTEXT...
                              [--linked-corpus-name NAME]...
                              [--corpus-read-set all|linked] --concept-id ID
  [D] concepts write          --corpus-context CONTEXT --concept-id ID
                              --document-file-path PATH
                              [--expected-current-sha256 SHA256]
                              [--write-mode explicit|automatic-inferred-memory]
                              [--automatic-memory-policy-generation INTEGER]
  [D] concepts deprecate      --corpus-context CONTEXT --concept-id ID
                              --reason TEXT --expected-current-sha256 SHA256
  [D] concepts delete         --corpus-context CONTEXT --concept-id ID
                              --expected-current-sha256 SHA256
                              --confirm-current-tree-deletion

Sources — project/explicit-bundle evidence capture, reopening, and freshness checks.
  [D] sources digest          --corpus-context CONTEXT --source-resource RESOURCE
  [D] sources capture         --corpus-context CONTEXT --source-resource RESOURCE
                              --output-file-path PATH
                              [--source-selector-kind KIND
                               --source-selector-value VALUE]
                              [--selected-region-output-file-path PATH]
                              [--git-revision REVISION]
  [D] sources resolve         --corpus-context CONTEXT --concept-id ID
                              --source-id ID --output-file-path PATH
                              [--selected-region-output-file-path PATH]
  [D] sources list            --corpus-context CONTEXT [--concept-id ID]
  [D] sources check           --corpus-context CONTEXT [--concept-id ID]
  [D] sources inventory       --corpus-context CONTEXT [--concept-id ID]
      project:PATH is contained by the project root. file:///ABSOLUTE/PATH is an
      explicit external, non-portable local-file locator and may be outside it.
      Capture preserves exact selected bytes; guarded mode governs retained knowledge,
      not source-file access or deterministic redaction.

Jobs — durable lifecycle management for deferred semantic work.
  [D] jobs enqueue artifact-ingest
                              --corpus-context project
                              --source-resource RESOURCE... (1–16)
                              --ingest-instruction TEXT
                              [--worker-model-id PROVIDER/MODEL]
                              [--worker-thinking-level LEVEL]
                              [--worker-timeout-seconds INTEGER]
  [D] jobs enqueue artifact-ingest-batch
                              --corpus-context project
                              --source-resource RESOURCE... (1–256)
                              --ingest-instruction TEXT
                              [--worker-model-id PROVIDER/MODEL]
                              [--worker-thinking-level LEVEL]
                              [--worker-timeout-seconds INTEGER]
  [D] jobs enqueue inferred-memory
                              --corpus-context project
                              --memory-claim TEXT --memory-evidence TEXT
                              --automatic-memory-policy-generation INTEGER
                              [--conversation-context-reference REF]...
                              [--candidate-origin foreground|automatic-review]
                              [--worker-model-id PROVIDER/MODEL]
                              [--worker-thinking-level LEVEL]
                              [--worker-timeout-seconds INTEGER]
  [D] jobs list               --corpus-context project [--job-state STATE]
  [D] jobs show               --corpus-context project --job-id ID
  [D] jobs run                --corpus-context project --job-id ID
  [D] jobs run-all-queued     --corpus-context project --confirm-run-all-queued
  [D] jobs cancel             --corpus-context project --job-id ID
  [D] jobs retry              --corpus-context project --job-id ID
  [D] jobs clean              --corpus-context project --job-id ID
                              --confirm-job-state-deletion [--confirm-reconciled]
  [D] jobs discard-invalid    --corpus-context project --job-id ID
                              --confirm-invalid-job-deletion

Job results — completed outcomes with presentation tracking (currently inferred-memory).
  [D] jobs results list       --corpus-context project
                              [--job-id ID]
                              [--acknowledgement-state acknowledged|unacknowledged]
  [D] jobs results acknowledge
                              --corpus-context project --job-id ID

Policy — explicit controls governing optional skill behavior.
  [D] policy project automatic-memory status|enable|disable
                              --corpus-context project
  [D] policy project sensitive-data status|allow|deny
                              --corpus-context project
  [D] policy global sensitive-data status|allow|deny
                              --corpus-context global

Wiring — optional project/client reminders that help activate Engram.
  [D] wiring project status|preview|install|remove
                              --corpus-context project

Adapter bridge — package-discovered machine interface for optional adapters.
  [D] adapter bridge handshake|project-policy-status
  [D] adapter bridge inferred-memory-enqueue
  [D] adapter bridge inferred-jobs-list|inferred-job-show
  [D] adapter bridge inferred-job-run|inferred-job-cancel|inferred-job-retry
  [D] adapter bridge inferred-job-clean
  [D] adapter bridge inferred-results-list|inferred-result-acknowledge
      Every operation requires --adapter-bridge-protocol-version INTEGER.
      Project operations also require --project-working-directory PATH.
      The bridge is JSON-only and intrinsically project-targeted.

Context and output:
  --corpus-context project|global
      Select a built-in corpus. Mutations select exactly one writable context;
      knowledge reads may repeat it. Selection never falls back.
  --linked-corpus-name NAME
      Select a project-configured read-only corpus link; knowledge reads may repeat it.
      Link selection uses the active project registry and accepts --project-root-path.
  --corpus-read-set all|linked
      Deterministic aggregate selection, mutually exclusive with explicit selectors.
      all includes project, global only when initialized, and every configured link;
      linked includes every configured link. Unavailable configured links still fail.
      Aggregate corpus operations always return a corpora array, including for 0 or 1 result.
  --project-root-path PATH
      Resolve project context from an explicit project root; invalid for global-only operations.
      With an expert bundle override, identify the owning root for project: source checks.
  --corpus-bundle-path PATH
      Deterministic expert override, mutually exclusive with managed corpus/link selection.
      It never inherits project automatic-memory or sensitive-data policy. If it is not the
      current project's managed bundle and no owning project root is given, project: sources
      are reported as not checkable instead of being resolved against the current directory.
  --output-format json|text
      Deterministic operations default to JSON. Text uses concise operation views
      or YAML for direct debugging; it never silently falls back to JSON.
      Failures use the selected stderr format without raw stack traces.

Exit codes:
  1 INTERNAL_ERROR; 2 USAGE; 3 NOT_INITIALIZED; 4 validation-class;
  5 WRITE_CONFLICT; 6 LOCK_TIMEOUT; 7 NOT_FOUND; 8 CONFIRMATION_REQUIRED;
  9 UNSAFE_PATH; 10 PERSISTED_INDEX_STALE; 11 ADAPTER_BRIDGE_INCOMPATIBLE.
  Validation-class errors include VALIDATION_ERROR, WIRING_*, and
  AUTOMATIC_MEMORY_DISABLED. Parse the structured error field for the exact code.

Unknown commands, positional identifiers, obsolete command forms, ambiguous
options, and unsupported context combinations are rejected.`;

function takeOption(args, name, { boolean = false } = {}) {
  const indexes = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name) indexes.push(index);
  }
  if (indexes.length > 1) throw errors.usage(`${name} may be supplied only once`);
  if (!indexes.length) return boolean ? false : undefined;
  const index = indexes[0];
  args.splice(index, 1);
  if (boolean) return true;
  if (index >= args.length || args[index].startsWith("--")) {
    throw errors.usage(`${name} requires a value`);
  }
  return args.splice(index, 1)[0];
}

function takeOptions(args, name) {
  const values = [];
  for (;;) {
    const index = args.indexOf(name);
    if (index < 0) return values;
    args.splice(index, 1);
    if (index >= args.length || args[index].startsWith("--")) {
      throw errors.usage(`${name} requires a value`);
    }
    values.push(args.splice(index, 1)[0]);
  }
}

function requireNoArguments(args) {
  if (args.length) throw errors.usage(`Unexpected arguments: ${args.join(" ")}`);
}

function requireOperation(args, domain, allowed) {
  const operation = args.shift();
  if (!operation || !allowed.includes(operation)) {
    throw errors.usage(`${domain} requires one of: ${allowed.join(", ")}`);
  }
  return operation;
}

function parseInteger(value, optionName, { minimum, maximum } = {}) {
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    (minimum !== undefined && parsed < minimum) ||
    (maximum !== undefined && parsed > maximum)
  ) {
    const range =
      minimum !== undefined && maximum !== undefined
        ? ` from ${minimum} through ${maximum}`
        : minimum !== undefined
          ? ` of at least ${minimum}`
          : "";
    throw errors.usage(`${optionName} must be a safe integer${range}`);
  }
  return parsed;
}

function takeOutputFormat(args) {
  const outputFormat = takeOption(args, "--output-format") ?? "json";
  if (!["json", "text"].includes(outputFormat)) {
    throw errors.usage("--output-format must be json or text");
  }
  return outputFormat;
}

async function resolveCorpora(
  args,
  { projectOnly = false, allowBundleOverride = true, allowMultiple = false } = {},
) {
  const corpusContexts = takeOptions(args, "--corpus-context");
  const corpusLinkNames = takeOptions(args, "--linked-corpus-name");
  const corpusReadSet = takeOption(args, "--corpus-read-set");
  const projectRootPath = takeOption(args, "--project-root-path");
  const corpusBundlePath = takeOption(args, "--corpus-bundle-path");
  const selectedCount = corpusContexts.length + corpusLinkNames.length;

  if (corpusReadSet !== undefined) {
    if (!allowMultiple) {
      throw errors.usage("--corpus-read-set is available only for composable read operations");
    }
    if (!new Set(["all", "linked"]).has(corpusReadSet)) {
      throw errors.usage("--corpus-read-set must be all or linked");
    }
    if (selectedCount || corpusBundlePath !== undefined) {
      throw errors.usage(
        "--corpus-read-set is mutually exclusive with explicit corpus, link, and bundle selection",
      );
    }
    const projectContext = await resolveProject({ projectRoot: projectRootPath });
    const descriptors = [];
    if (corpusReadSet === "all") {
      descriptors.push({ corpusContext: "project", context: projectContext });
      const globalContext = await resolveGlobal();
      if (globalContext.initialized) {
        descriptors.push({ corpusContext: "global", context: globalContext });
      }
    }
    const names = await configuredCorpusLinkNames(projectContext);
    descriptors.push(...await resolveCorpusLinks(projectContext, names));
    return descriptors;
  }

  if (corpusBundlePath !== undefined) {
    if (!allowBundleOverride) {
      throw errors.usage("This operation does not accept --corpus-bundle-path");
    }
    if (selectedCount) {
      throw errors.usage(
        "--corpus-bundle-path is mutually exclusive with --corpus-context and --linked-corpus-name",
      );
    }
    const context = await resolveProject({ projectRoot: projectRootPath, bundle: corpusBundlePath });
    return [{ context, corpusContext: "explicit-bundle" }];
  }

  if (!selectedCount || (!allowMultiple && selectedCount !== 1)) {
    throw errors.usage(
      allowMultiple
        ? "At least one corpus context or linked corpus name is required for this operation"
        : "Exactly one corpus context or linked corpus name is required for this operation",
    );
  }
  if (new Set(corpusContexts).size !== corpusContexts.length) {
    throw errors.usage("Corpus contexts must be unique");
  }
  if (new Set(corpusLinkNames).size !== corpusLinkNames.length) {
    throw errors.usage("Linked corpus names must be unique");
  }
  if (corpusContexts.some((value) => !new Set(["project", "global"]).has(value))) {
    throw errors.usage("--corpus-context must be project or global");
  }
  if (projectOnly && (corpusContexts.some((value) => value !== "project") || corpusLinkNames.length)) {
    throw errors.usage("This operation is available only in project corpus context");
  }
  if (!corpusContexts.includes("project") && !corpusLinkNames.length && projectRootPath) {
    throw errors.usage("Global corpus context does not accept --project-root-path");
  }

  const projectContext = corpusContexts.includes("project") || corpusLinkNames.length
    ? await resolveProject({ projectRoot: projectRootPath })
    : undefined;
  const descriptors = [];
  for (const corpusContext of corpusContexts) {
    descriptors.push({
      corpusContext,
      context: corpusContext === "project" ? projectContext : await resolveGlobal(),
    });
  }
  if (corpusLinkNames.length) {
    descriptors.push(...await resolveCorpusLinks(projectContext, corpusLinkNames));
  }
  const bundlePaths = descriptors.map((descriptor) => descriptor.context.bundle);
  if (new Set(bundlePaths).size !== bundlePaths.length) {
    throw errors.validation("Selected knowledge bases resolve to a duplicate canonical bundle", {
      corpora: descriptors.map((descriptor) => ({
        corpusContext: descriptor.corpusContext,
        ...(descriptor.corpusLinkName ? { corpusLinkName: descriptor.corpusLinkName } : {}),
        bundlePath: descriptor.context.bundle,
      })),
    });
  }
  return descriptors;
}

async function resolveCorpus(args, options = {}) {
  const corpora = await resolveCorpora(args, options);
  return corpora[0];
}

function renameResultField(result, oldName, newName) {
  if (!Object.hasOwn(result, oldName)) return;
  result[newName] = result[oldName];
  delete result[oldName];
}

function canonicalizeResultFields(value, operation) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const result = { ...value };
  renameResultField(result, "projectRoot", "projectRootPath");
  renameResultField(result, "logicalBundle", "logicalBundlePath");
  renameResultField(result, "bundle", "bundlePath");
  renameResultField(result, "settings", "settingsFilePath");
  renameResultField(result, "linksFile", "linksFilePath");
  renameResultField(result, "dataHome", "dataHomePath");
  renameResultField(result, "logicalStateRoot", "logicalStateRootPath");
  renameResultField(result, "stateRoot", "stateRootPath");
  renameResultField(result, "readmeFile", "readmeFilePath");
  if (result.automaticMemory && typeof result.automaticMemory === "object") {
    result.automaticMemory = canonicalizeResultFields(result.automaticMemory, "policy.project.automatic-memory.status");
  }
  if (result.sensitiveData && typeof result.sensitiveData === "object") {
    result.sensitiveData = canonicalizeResultFields(result.sensitiveData, "policy.project.sensitive-data.status");
  }
  if (operation.startsWith("concepts.")) renameResultField(result, "path", "conceptFilePath");
  if (operation.startsWith("wiring.project.")) renameResultField(result, "path", "projectInstructionsFilePath");
  if (operation === "sources.digest" || operation === "sources.capture") {
    renameResultField(result, "path", "sourceFilePath");
  }
  if (operation === "sources.capture" || operation === "sources.resolve") {
    renameResultField(result, "output", "outputFilePath");
    if (result.region && typeof result.region === "object") {
      result.region = { ...result.region };
      renameResultField(result.region, "output", "outputFilePath");
    }
    renameResultField(result, "size", "sizeBytes");
  }
  if (operation === "corpus.repair-indexes") {
    renameResultField(result, "fixed", "repairedIndexFilePaths");
  }
  return result;
}

function attachCorpusContext(
  result,
  corpusContext,
  operation,
  { arrayProperty = "items", corpusLinkName } = {},
) {
  const reference = { corpusContext, ...(corpusLinkName ? { corpusLinkName } : {}) };
  if (Array.isArray(result)) return { ...reference, [arrayProperty]: result };
  const canonical = canonicalizeResultFields(result, operation);
  if (canonical && typeof canonical === "object") return { ...reference, ...canonical };
  return { ...reference, value: canonical };
}

function printCorpusLocation(result) {
  console.log(`Corpus context: ${result.corpusContext}`);
  if (result.corpusLinkName) console.log(`Corpus link: @${result.corpusLinkName}`);
  if (result.projectRootPath) console.log(`Project root: ${result.projectRootPath}`);
  if (result.dataHomePath) console.log(`XDG data home: ${result.dataHomePath}`);
  if (result.configuredPath) console.log(`Configured path: ${result.configuredPath}`);
  console.log(`Bundle: ${result.logicalBundlePath}`);
  if (result.bundlePath !== result.logicalBundlePath) console.log(`Canonical bundle: ${result.bundlePath}`);
  console.log(`Discovery: ${result.method}`);
  console.log(`Initialized: ${result.initialized ? "yes" : "no"}`);
}

function printText(result, operation) {
  if (operation === "concepts.read") {
    process.stdout.write(result.text);
    console.error(`SHA-256: ${result.hash}`);
    return;
  }
  if (operation === "concepts.search") {
    if (!result.results.length) console.log("No matching concepts.");
    for (const item of result.results) {
      const context = item.corpusContext ? `${item.corpusContext}\t` : "";
      console.log(`${context}${item.id}\t${item.type}\t${item.title}\t${item.description} [${item.score}]`);
    }
    return;
  }
  if (operation === "concepts.list") {
    for (const item of result.concepts) console.log(`${item.id}\t${item.type}\t${item.title}`);
    return;
  }
  if (operation === "corpus.locate") {
    if (!Array.isArray(result.corpora)) {
      printCorpusLocation(result);
      return;
    }
    if (!result.corpora.length) {
      console.log("No knowledge bases selected.");
      return;
    }
    result.corpora.forEach((corpus, index) => {
      if (index) console.log();
      printCorpusLocation(corpus);
    });
    return;
  }
  if (operation === "corpus.initialize") {
    console.log(`${result.created ? "Initialized" : "Found existing"} Engram corpus: ${result.logicalBundlePath}`);
    if (result.bundlePath !== result.logicalBundlePath) console.log(`Canonical bundle: ${result.bundlePath}`);
    if (result.readmeCreated) console.log(`Created read-only discovery guide: ${result.readmeFilePath}`);
    if (result.corpusContext === "project") {
      console.log("Optional: run /engram wire to add the project reminder; this does not enable automatic memory.");
    } else {
      console.log("Global memory remains explicit; initialization enables no automatic inference or fallback.");
    }
    return;
  }
  if (operation.startsWith("wiring.project.")) {
    if (result.action === "preview") {
      console.log(`Project AGENTS.md: ${result.projectInstructionsFilePath}`);
      console.log(result.block);
      return;
    }
    console.log(`Project AGENTS.md: ${result.projectInstructionsFilePath}`);
    console.log(`Wiring: ${result.state}`);
    if (result.action === "install")
      console.log(result.changed ? "Canonical reminder installed." : "Canonical reminder already installed.");
    if (result.action === "remove")
      console.log(result.changed ? "Canonical reminder removed." : "No canonical reminder installed.");
    return;
  }
  if (operation === "jobs.list") {
    console.log(`Runner: ${result.runner.state}${result.runner.jobId ? ` (${result.runner.jobId})` : ""}`);
    console.log("STATE\tPOSITION\tBATCH\tPART\tSOURCES\tJOB");
    for (const job of result.jobs) {
      console.log(
        [
          job.displayState,
          job.queuePosition ?? "-",
          job.batchId ?? "-",
          job.batchPart ? `${job.batchPart}/${job.batchSize}` : "-",
          job.sourceCount ?? "-",
          job.jobId,
        ].join("\t"),
      );
    }
    return;
  }
  if (operation === "sources.list") {
    console.log("STATE\tFILE\tRESOURCE\tCONCEPTS");
    for (const item of result.sourceFiles) {
      console.log(
        [
          item.state,
          JSON.stringify(item.sourceFilePath ?? null),
          JSON.stringify(item.resource),
          JSON.stringify(item.conceptIds),
        ].join("\t"),
      );
    }
    console.log(
      `${result.totals.sourceFiles} source file${result.totals.sourceFiles === 1 ? "" : "s"}; ${result.totals.omittedNonFileResources} non-file resource${result.totals.omittedNonFileResources === 1 ? "" : "s"} omitted; ${result.totals.invalidClaims} invalid claim${result.totals.invalidClaims === 1 ? "" : "s"}`,
    );
    return;
  }
  if (operation === "sources.inventory") {
    console.log("STATE\tGIT\tREFS\tRESOURCE\tCONCEPTS");
    for (const item of result.resources) {
      console.log(
        [
          item.state,
          item.gitState,
          item.referenceCount,
          JSON.stringify(item.resource),
          JSON.stringify(item.conceptIds),
        ].join("\t"),
      );
    }
    console.log(
      `${result.totals.resources} resources; ${result.totals.references} references; ${result.totals.invalidClaims} invalid claims`,
    );
    return;
  }
  if (typeof result === "string") console.log(result);
  else process.stdout.write(stringifyYaml(result));
}

function printResult(
  result,
  { outputFormat, operation, corpusContext, corpusLinkName, arrayProperty } = {},
) {
  const contextualResult = corpusContext
    ? attachCorpusContext(result, corpusContext, operation, { arrayProperty, corpusLinkName })
    : result;
  if (outputFormat === "json") {
    console.log(JSON.stringify(contextualResult, null, 2));
    return;
  }
  printText(contextualResult, operation);
}

function semanticOperationError(operation) {
  throw errors.usage(
    `${operation} is a semantic skill operation; invoke it through /engram with the Engram skill active`,
  );
}

async function main(rawArgs = process.argv.slice(2)) {
  const args = [...rawArgs];
  if (!args.length || args[0] === "help") {
    if (args.length > 1) throw errors.usage("help accepts no arguments");
    console.log(HUMAN_HELP);
    return 0;
  }
  if (args.includes("--help")) {
    if (args.length !== 1) throw errors.usage("--help accepts no other arguments");
    console.log(AGENT_HELP);
    return 0;
  }
  if (args.includes("--version")) {
    if (args.length !== 1) throw errors.usage("--version accepts no other arguments");
    console.log(VERSION);
    return 0;
  }

  const domain = args.shift();
  const outputFormat = takeOutputFormat(args);
  let result;
  let operation;
  let resolved;
  let arrayProperty;

  switch (domain) {
    case "adapter": {
      if (args.shift() !== "bridge") throw errors.usage("adapter requires the bridge scope");
      const bridgeOperation = requireOperation(args, "adapter bridge", [
        "handshake",
        "project-policy-status",
        "inferred-memory-enqueue",
        "inferred-jobs-list",
        "inferred-job-show",
        "inferred-job-run",
        "inferred-job-cancel",
        "inferred-job-retry",
        "inferred-job-clean",
        "inferred-results-list",
        "inferred-result-acknowledge",
      ]);
      operation = `bridge.${bridgeOperation}`;
      if (outputFormat !== "json") throw errors.usage("The adapter bridge supports only JSON output");
      const protocolVersionRaw = takeOption(args, "--adapter-bridge-protocol-version");
      if (protocolVersionRaw === undefined) {
        throw errors.usage("Adapter bridge operations require --adapter-bridge-protocol-version");
      }
      const protocolVersion = parseInteger(protocolVersionRaw, "--adapter-bridge-protocol-version", { minimum: 1 });
      assertAdapterBridgeProtocolVersion(protocolVersion);

      if (bridgeOperation === "handshake") {
        requireNoArguments(args);
        result = describeAdapterBridge();
        break;
      }

      const projectWorkingDirectory = takeOption(args, "--project-working-directory");
      if (!projectWorkingDirectory) {
        throw errors.usage("Adapter bridge project operations require --project-working-directory");
      }
      const jobId = takeOption(args, "--job-id");
      const jobState = takeOption(args, "--job-state");
      const acknowledgementState = takeOption(args, "--acknowledgement-state");
      const confirmJobStateDeletion = takeOption(args, "--confirm-job-state-deletion", { boolean: true });
      const memoryClaim = takeOption(args, "--memory-claim");
      const memoryEvidence = takeOption(args, "--memory-evidence");
      const contextReferences = takeOptions(args, "--conversation-context-reference");
      const generationRaw = takeOption(args, "--automatic-memory-policy-generation");
      const workerModelId = takeOption(args, "--worker-model-id");
      const workerThinkingLevel = takeOption(args, "--worker-thinking-level");
      const timeoutRaw = takeOption(args, "--worker-timeout-seconds");
      requireNoArguments(args);

      const adapterContext = await resolveProject({ cwd: projectWorkingDirectory });
      if (bridgeOperation === "project-policy-status") {
        if (
          jobId ||
          jobState ||
          acknowledgementState ||
          confirmJobStateDeletion ||
          memoryClaim ||
          memoryEvidence ||
          contextReferences.length ||
          generationRaw !== undefined ||
          workerModelId ||
          workerThinkingLevel ||
          timeoutRaw !== undefined
        ) {
          throw errors.usage("adapter bridge project-policy-status accepts only bridge and project options");
        }
        result = await adapterProjectPolicyStatus(adapterContext);
      } else if (bridgeOperation === "inferred-memory-enqueue") {
        if (
          !memoryClaim ||
          !memoryEvidence ||
          generationRaw === undefined ||
          jobId ||
          jobState ||
          acknowledgementState ||
          confirmJobStateDeletion
        ) {
          throw errors.usage(
            "adapter bridge inferred-memory-enqueue requires --memory-claim, --memory-evidence, and --automatic-memory-policy-generation",
          );
        }
        const policyGeneration = parseInteger(generationRaw, "--automatic-memory-policy-generation", { minimum: 0 });
        const workerTimeoutSeconds =
          timeoutRaw === undefined
            ? undefined
            : parseInteger(timeoutRaw, "--worker-timeout-seconds", { minimum: 30, maximum: 1_200 });
        result = await adapterEnqueueInferredMemory(
          adapterContext,
          { claim: memoryClaim, evidence: memoryEvidence },
          {
            contextRefs: contextReferences,
            policyGeneration,
            model: workerModelId,
            thinking: workerThinkingLevel,
            runtimeSeconds: workerTimeoutSeconds,
          },
        );
      } else if (bridgeOperation === "inferred-jobs-list") {
        if (
          jobId ||
          acknowledgementState ||
          confirmJobStateDeletion ||
          memoryClaim ||
          memoryEvidence ||
          contextReferences.length ||
          generationRaw !== undefined ||
          workerModelId ||
          workerThinkingLevel ||
          timeoutRaw !== undefined
        ) {
          throw errors.usage("adapter bridge inferred-jobs-list accepts only optional --job-state");
        }
        result = await adapterListInferredJobs(adapterContext, { state: jobState });
      } else if (bridgeOperation === "inferred-results-list") {
        if (
          jobState ||
          confirmJobStateDeletion ||
          memoryClaim ||
          memoryEvidence ||
          contextReferences.length ||
          generationRaw !== undefined ||
          workerModelId ||
          workerThinkingLevel ||
          timeoutRaw !== undefined
        ) {
          throw errors.usage(
            "adapter bridge inferred-results-list accepts only optional --job-id and --acknowledgement-state",
          );
        }
        result = await adapterListInferredResults(adapterContext, { jobId, acknowledgementState });
      } else {
        if (
          !jobId ||
          jobState ||
          acknowledgementState ||
          memoryClaim ||
          memoryEvidence ||
          contextReferences.length ||
          generationRaw !== undefined ||
          workerModelId ||
          workerThinkingLevel ||
          timeoutRaw !== undefined ||
          (confirmJobStateDeletion && bridgeOperation !== "inferred-job-clean")
        ) {
          throw errors.usage(`adapter bridge ${bridgeOperation} requires only --job-id and bridge/project options`);
        }
        if (bridgeOperation === "inferred-job-show") result = await adapterShowInferredJob(adapterContext, jobId);
        else if (bridgeOperation === "inferred-job-run") result = await adapterRunInferredJob(adapterContext, jobId);
        else if (bridgeOperation === "inferred-job-cancel") result = await adapterCancelInferredJob(adapterContext, jobId);
        else if (bridgeOperation === "inferred-job-retry") result = await adapterRetryInferredJob(adapterContext, jobId);
        else if (bridgeOperation === "inferred-job-clean") {
          result = await adapterCleanInferredJob(adapterContext, jobId, { confirmJobStateDeletion });
        } else result = await adapterAcknowledgeInferredResult(adapterContext, jobId);
      }
      break;
    }
    case "knowledge": {
      operation = requireOperation(args, domain, ["ingest"]);
      const corpusContexts = takeOptions(args, "--corpus-context");
      const sourceResources = takeOptions(args, "--source-resource");
      takeOption(args, "--ingest-instruction");
      takeOption(args, "--project-root-path");
      if (
        corpusContexts.length !== 1 ||
        !["project", "global"].includes(corpusContexts[0]) ||
        !sourceResources.length ||
        new Set(sourceResources).size !== sourceResources.length
      ) {
        throw errors.usage("knowledge ingest requires one valid --corpus-context and unique --source-resource values");
      }
      if (corpusContexts[0] === "global") {
        throw errors.usage("Artifact ingest is unavailable in global memory context");
      }
      requireNoArguments(args);
      semanticOperationError("knowledge ingest");
      break;
    }
    case "memory": {
      operation = requireOperation(args, domain, ["remember", "recall"]);
      const corpusContexts = takeOptions(args, "--corpus-context");
      const corpusLinkNames = takeOptions(args, "--linked-corpus-name");
      const corpusReadSet = takeOption(args, "--corpus-read-set");
      const projectRootPath = takeOption(args, "--project-root-path");
      const selectedCount = corpusContexts.length + corpusLinkNames.length + (corpusReadSet ? 1 : 0);
      if (operation === "remember") {
        const statement = takeOption(args, "--memory-statement");
        if (selectedCount !== 1 || corpusLinkNames.length || corpusReadSet || !statement) {
          throw errors.usage(
            "memory remember requires one writable --corpus-context and --memory-statement",
          );
        }
      } else {
        const question = takeOption(args, "--recall-question");
        if (!selectedCount || !question) {
          throw errors.usage(
            "memory recall requires one or more corpus contexts or linked corpus names and --recall-question",
          );
        }
        if (
          new Set(corpusContexts).size !== corpusContexts.length ||
          new Set(corpusLinkNames).size !== corpusLinkNames.length ||
          (corpusReadSet && !new Set(["all", "linked"]).has(corpusReadSet)) ||
          (corpusReadSet && selectedCount !== 1)
        ) {
          throw errors.usage("memory recall corpus selections must be unique and non-conflicting");
        }
      }
      if (corpusContexts.some((value) => !["project", "global"].includes(value))) {
        throw errors.usage("--corpus-context must be project or global");
      }
      if (!corpusContexts.includes("project") && !corpusLinkNames.length && projectRootPath) {
        throw errors.usage("Global-only memory operations do not accept --project-root-path");
      }
      requireNoArguments(args);
      semanticOperationError(`memory ${operation}`);
      break;
    }
    case "corpus": {
      const corpusOperation = requireOperation(
        args,
        domain,
        ["initialize", "locate", "status", "validate", "repair-indexes", "links"],
      );
      if (corpusOperation === "links") {
        const action = requireOperation(args, "corpus links", ["list", "add", "remove"]);
        operation = `links.${action}`;
        const linkName = takeOption(args, "--link-name");
        const linkedCorpusPath = takeOption(args, "--linked-corpus-path");
        resolved = await resolveCorpus(args, { projectOnly: true, allowBundleOverride: false });
        requireNoArguments(args);
        if (action === "list") {
          if (linkName || linkedCorpusPath) {
            throw errors.usage("corpus links list accepts only project corpus options");
          }
          result = await listCorpusLinks(resolved.context);
        } else if (action === "add") {
          if (!linkName || !linkedCorpusPath) {
            throw errors.usage("corpus links add requires --link-name and --linked-corpus-path");
          }
          result = await addCorpusLink(resolved.context, linkName, linkedCorpusPath);
        } else {
          if (!linkName || linkedCorpusPath) {
            throw errors.usage("corpus links remove requires only --link-name and project corpus options");
          }
          result = await removeCorpusLink(resolved.context, linkName);
        }
        break;
      }

      operation = corpusOperation;
      const allowMultiple = ["locate", "status", "validate"].includes(operation);
      const aggregateReadSet = args.includes("--corpus-read-set");
      const selectedCorpora = await resolveCorpora(args, { allowMultiple });
      if (selectedCorpora.length === 1) [resolved] = selectedCorpora;
      requireNoArguments(args);
      if (operation === "initialize") result = await initializeCorpus(resolved.context);
      else if (operation === "repair-indexes") result = await validateCorpus(resolved.context, { fix: true });
      else {
        const values = await Promise.all(selectedCorpora.map(async (descriptor) => {
          let value;
          if (operation === "locate") value = descriptor.context;
          else if (operation === "status") value = await inspectCorpusStatus(descriptor.context);
          else value = await validateCorpus(descriptor.context);
          return {
            corpusContext: descriptor.corpusContext,
            ...(descriptor.corpusLinkName ? { corpusLinkName: descriptor.corpusLinkName } : {}),
            ...canonicalizeResultFields(value, `corpus.${operation}`),
          };
        }));
        result = !aggregateReadSet && selectedCorpora.length === 1
          ? values[0]
          : {
              ...(operation === "validate" ? { valid: values.every((value) => value.valid) } : {}),
              corpora: values,
            };
        resolved = undefined;
      }
      break;
    }
    case "wiring": {
      if (args.shift() !== "project") throw errors.usage("wiring requires the project scope");
      const action = requireOperation(args, "wiring project", ["status", "preview", "install", "remove"]);
      operation = `project.${action}`;
      resolved = await resolveCorpus(args, { projectOnly: true, allowBundleOverride: false });
      requireNoArguments(args);
      if (action === "status") result = await inspectProjectWiring(resolved.context);
      else if (action === "preview") result = await inspectProjectWiring(resolved.context, { preview: true });
      else if (action === "install") result = await installProjectWiring(resolved.context);
      else result = await removeProjectWiring(resolved.context);
      break;
    }
    case "policy": {
      const scope = args.shift();
      if (!new Set(["project", "global"]).has(scope)) {
        throw errors.usage("policy requires the project or global scope and a supported policy");
      }
      const policy = args.shift();
      if (policy === "automatic-memory") {
        if (scope !== "project") {
          throw errors.usage("Automatic-memory policy is available only for project corpus context");
        }
        const action = requireOperation(args, "policy project automatic-memory", ["status", "enable", "disable"]);
        operation = `project.automatic-memory.${action}`;
        resolved = await resolveCorpus(args, { projectOnly: true, allowBundleOverride: false });
        requireNoArguments(args);
        result =
          action === "status"
            ? await getAutomaticMemoryPolicyStatus(resolved.context, { tolerateInvalid: true })
            : await setProjectAutomaticMemoryPolicy(resolved.context, action === "enable" ? "on" : "off");
      } else if (policy === "sensitive-data") {
        const action = requireOperation(args, `policy ${scope} sensitive-data`, ["status", "allow", "deny"]);
        operation = `${scope}.sensitive-data.${action}`;
        resolved = await resolveCorpus(args, {
          projectOnly: scope === "project",
          allowBundleOverride: false,
        });
        if (resolved.corpusContext !== scope) {
          throw errors.usage(`policy ${scope} sensitive-data requires --corpus-context ${scope}`);
        }
        requireNoArguments(args);
        result =
          action === "status"
            ? await getSensitiveDataPolicyStatus(resolved.context, { tolerateInvalid: true })
            : await setSensitiveDataPolicy(resolved.context, action);
      } else {
        throw errors.usage("policy supports project automatic-memory and project or global sensitive-data");
      }
      break;
    }
    case "concepts": {
      operation = requireOperation(args, domain, ["list", "search", "read", "write", "deprecate", "delete"]);
      const conceptId = takeOption(args, "--concept-id");
      const conceptType = takeOption(args, "--concept-type");
      const query = takeOption(args, "--query");
      const resultLimitRaw = takeOption(args, "--result-limit");
      const includeDeprecated = takeOption(args, "--include-deprecated", { boolean: true });
      const documentFilePath = takeOption(args, "--document-file-path");
      const expectedCurrentSha256 = takeOption(args, "--expected-current-sha256");
      const writeMode = takeOption(args, "--write-mode") ?? "explicit";
      const policyGenerationRaw = takeOption(args, "--automatic-memory-policy-generation");
      const reason = takeOption(args, "--reason");
      const confirmDeletion = takeOption(args, "--confirm-current-tree-deletion", { boolean: true });
      const selectedCorpora = await resolveCorpora(args, {
        allowMultiple: ["list", "search", "read"].includes(operation),
      });
      if (selectedCorpora.length === 1) [resolved] = selectedCorpora;
      requireNoArguments(args);

      if (operation === "list") {
        if (
          conceptId ||
          query ||
          resultLimitRaw ||
          includeDeprecated ||
          documentFilePath ||
          expectedCurrentSha256 ||
          policyGenerationRaw ||
          reason ||
          confirmDeletion ||
          writeMode !== "explicit"
        ) {
          throw errors.usage("concepts list accepts only --concept-type and corpus options");
        }
        result = await listCorpora(selectedCorpora, { type: conceptType });
        resolved = undefined;
      } else if (operation === "search") {
        if (
          !query ||
          conceptId ||
          conceptType ||
          documentFilePath ||
          expectedCurrentSha256 ||
          policyGenerationRaw ||
          reason ||
          confirmDeletion ||
          writeMode !== "explicit"
        ) {
          throw errors.usage("concepts search requires --query and accepts only search options");
        }
        const resultLimit =
          resultLimitRaw === undefined
            ? 10
            : parseInteger(resultLimitRaw, "--result-limit", { minimum: 1, maximum: 100 });
        result = await searchCorpora(selectedCorpora, query, { limit: resultLimit, includeDeprecated });
        resolved = undefined;
      } else if (operation === "read") {
        if (
          !conceptId ||
          conceptType ||
          query ||
          resultLimitRaw ||
          includeDeprecated ||
          documentFilePath ||
          expectedCurrentSha256 ||
          policyGenerationRaw ||
          reason ||
          confirmDeletion ||
          writeMode !== "explicit"
        ) {
          throw errors.usage("concepts read requires only --concept-id and corpus options");
        }
        result = await readCorpora(selectedCorpora, conceptId);
        resolved = undefined;
      } else if (operation === "write") {
        if (
          !conceptId ||
          !documentFilePath ||
          conceptType ||
          query ||
          resultLimitRaw ||
          includeDeprecated ||
          reason ||
          confirmDeletion ||
          !["explicit", "automatic-inferred-memory"].includes(writeMode)
        ) {
          throw errors.usage(
            "concepts write requires --concept-id and --document-file-path with supported write options",
          );
        }
        const automaticMemory = writeMode === "automatic-inferred-memory";
        const policyGeneration =
          policyGenerationRaw === undefined
            ? undefined
            : parseInteger(policyGenerationRaw, "--automatic-memory-policy-generation", { minimum: 0 });
        if (automaticMemory !== (policyGeneration !== undefined)) {
          throw errors.usage(
            "automatic-inferred-memory write mode requires --automatic-memory-policy-generation, and explicit mode rejects it",
          );
        }
        const coordinatedGenerationRaw = process.env.OKF_ENGRAM_JOB_POLICY_GENERATION;
        if (coordinatedGenerationRaw !== undefined) {
          const coordinatedGeneration = Number(coordinatedGenerationRaw);
          if (!automaticMemory || policyGeneration !== coordinatedGeneration) {
            throw errors.automaticMemoryDisabled(
              resolved.context.logicalBundle,
              "inferred-memory worker writes must use their coordinator policy generation",
              { expectedGeneration: coordinatedGeneration, generation: policyGeneration },
            );
          }
        }
        const draftText = await fs.readFile(documentFilePath, "utf8").catch((error) => {
          if (error.code === "ENOENT") throw errors.notFound(`Draft ${documentFilePath}`);
          throw error;
        });
        result = await writeConcept(resolved.context, conceptId, draftText, {
          expectedCurrentSha256: expectedCurrentSha256,
          source: documentFilePath,
          automaticMemory,
          policyGeneration,
        });
      } else if (operation === "deprecate") {
        if (
          !conceptId ||
          !reason ||
          !expectedCurrentSha256 ||
          conceptType ||
          query ||
          resultLimitRaw ||
          includeDeprecated ||
          documentFilePath ||
          policyGenerationRaw ||
          confirmDeletion ||
          writeMode !== "explicit"
        ) {
          throw errors.usage("concepts deprecate requires --concept-id, --reason, and --expected-current-sha256");
        }
        result = await deprecateConcept(resolved.context, conceptId, {
          reason,
          expectedCurrentSha256: expectedCurrentSha256,
        });
      } else {
        if (
          !conceptId ||
          !expectedCurrentSha256 ||
          conceptType ||
          query ||
          resultLimitRaw ||
          includeDeprecated ||
          documentFilePath ||
          policyGenerationRaw ||
          reason ||
          writeMode !== "explicit"
        ) {
          throw errors.usage(
            "concepts delete requires --concept-id and --expected-current-sha256 with deletion options",
          );
        }
        if (!confirmDeletion) {
          throw errors.confirmation("Concept deletion requires --confirm-current-tree-deletion");
        }
        result = await deleteConcept(resolved.context, conceptId, {
          expectedCurrentSha256,
          confirmCurrentTreeDeletion: confirmDeletion,
        });
      }
      break;
    }
    case "sources": {
      operation = requireOperation(args, domain, ["digest", "capture", "resolve", "list", "check", "inventory"]);
      const sourceResource = takeOption(args, "--source-resource");
      const conceptId = takeOption(args, "--concept-id");
      const sourceId = takeOption(args, "--source-id");
      const outputFilePath = takeOption(args, "--output-file-path");
      const selectedRegionOutputFilePath = takeOption(args, "--selected-region-output-file-path");
      const selectorKind = takeOption(args, "--source-selector-kind");
      const selectorValue = takeOption(args, "--source-selector-value");
      const gitRevision = takeOption(args, "--git-revision");
      resolved = await resolveCorpus(args);
      if (resolved.corpusContext === "global" || resolved.corpusContext === "linked") {
        throw errors.usage("Source-file operations are unavailable in global or linked corpus context");
      }
      requireNoArguments(args);

      if (operation === "digest") {
        if (
          !sourceResource ||
          conceptId ||
          sourceId ||
          outputFilePath ||
          selectedRegionOutputFilePath ||
          selectorKind ||
          selectorValue ||
          gitRevision
        ) {
          throw errors.usage("sources digest requires only --source-resource and corpus options");
        }
        result = await digestResource(sourceResource, resolved.context.projectRoot);
      } else if (operation === "capture") {
        if (
          !sourceResource ||
          !outputFilePath ||
          conceptId ||
          sourceId ||
          Boolean(selectorKind) !== Boolean(selectorValue)
        ) {
          throw errors.usage(
            "sources capture requires --source-resource and --output-file-path; selector kind/value must be supplied together",
          );
        }
        if (selectedRegionOutputFilePath && !selectorKind) {
          throw errors.usage("--selected-region-output-file-path requires a source selector");
        }
        result = await captureSource(resolved.context, sourceResource, {
          output: outputFilePath,
          gitRevision,
          regionOutput: selectedRegionOutputFilePath,
          selector: selectorKind ? { kind: selectorKind, value: selectorValue } : undefined,
        });
      } else if (operation === "resolve") {
        if (
          !conceptId ||
          !sourceId ||
          !outputFilePath ||
          sourceResource ||
          selectorKind ||
          selectorValue ||
          gitRevision
        ) {
          throw errors.usage("sources resolve requires --concept-id, --source-id, and --output-file-path");
        }
        const concept = await readConcept(resolved.context, conceptId);
        const matches = Array.isArray(concept.data.sources)
          ? concept.data.sources.filter((item) => item?.id === sourceId)
          : [];
        if (matches.length !== 1) {
          throw matches.length
            ? errors.validation(`Concept ${conceptId} has duplicate source ID ${sourceId}`)
            : errors.notFound(`Source ${sourceId} in concept ${conceptId}`);
        }
        if (selectedRegionOutputFilePath && matches[0].selector === undefined) {
          throw errors.usage("--selected-region-output-file-path requires selector metadata on the chosen source");
        }
        result = await resolvePinnedSource(resolved.context, matches[0], {
          output: outputFilePath,
          regionOutput: selectedRegionOutputFilePath,
        });
      } else if (["list", "check", "inventory"].includes(operation)) {
        if (
          sourceResource ||
          sourceId ||
          outputFilePath ||
          selectedRegionOutputFilePath ||
          selectorKind ||
          selectorValue ||
          gitRevision
        ) {
          throw errors.usage(`sources ${operation} accepts only optional --concept-id and corpus options`);
        }
        if (operation === "list") result = await listSourceFiles(resolved.context, conceptId);
        else if (operation === "inventory") result = await inventorySources(resolved.context, conceptId);
        else {
          result = await inspectSourceClaims(resolved.context, conceptId);
          arrayProperty = "sourceClaims";
        }
      }
      break;
    }
    case "jobs": {
      const first = args.shift();
      if (!first) throw errors.usage("jobs requires an operation");
      if (first === "enqueue") {
        const kind = requireOperation(args, "jobs enqueue", [
          "artifact-ingest",
          "artifact-ingest-batch",
          "inferred-memory",
        ]);
        operation = `enqueue.${kind}`;
        const sourceResources = takeOptions(args, "--source-resource");
        const ingestInstruction = takeOption(args, "--ingest-instruction");
        const workerModelId = takeOption(args, "--worker-model-id");
        const workerThinkingLevel = takeOption(args, "--worker-thinking-level");
        const timeoutRaw = takeOption(args, "--worker-timeout-seconds");
        const workerTimeoutSeconds =
          timeoutRaw === undefined ? undefined : parseInteger(timeoutRaw, "--worker-timeout-seconds");
        const memoryClaim = takeOption(args, "--memory-claim");
        const memoryEvidence = takeOption(args, "--memory-evidence");
        const contextReferences = takeOptions(args, "--conversation-context-reference");
        const candidateOrigin = takeOption(args, "--candidate-origin");
        const generationRaw = takeOption(args, "--automatic-memory-policy-generation");
        resolved = await resolveCorpus(args, { projectOnly: true, allowBundleOverride: false });
        requireNoArguments(args);
        if (kind === "artifact-ingest" || kind === "artifact-ingest-batch") {
          if (
            !sourceResources.length ||
            !ingestInstruction ||
            memoryClaim ||
            memoryEvidence ||
            contextReferences.length ||
            candidateOrigin ||
            generationRaw !== undefined
          ) {
            throw errors.usage(
              `jobs enqueue ${kind} requires --source-resource and --ingest-instruction with worker options`,
            );
          }
          const enqueue = kind === "artifact-ingest-batch" ? enqueueArtifactIngestBatch : enqueueArtifactIngestJob;
          result = await enqueue(resolved.context, sourceResources, {
            instruction: ingestInstruction,
            model: workerModelId,
            thinking: workerThinkingLevel,
            runtimeSeconds: workerTimeoutSeconds,
          });
        } else {
          if (
            sourceResources.length ||
            ingestInstruction ||
            !memoryClaim ||
            !memoryEvidence ||
            generationRaw === undefined
          ) {
            throw errors.usage(
              "jobs enqueue inferred-memory requires --memory-claim, --memory-evidence, and --automatic-memory-policy-generation",
            );
          }
          const policyGeneration = parseInteger(generationRaw, "--automatic-memory-policy-generation", { minimum: 0 });
          result = await enqueueInferredMemoryJob(
            resolved.context,
            {
              claim: memoryClaim,
              evidence: memoryEvidence,
            },
            {
              contextRefs: contextReferences,
              origin: candidateOrigin,
              policyGeneration,
              model: workerModelId,
              thinking: workerThinkingLevel,
              runtimeSeconds: workerTimeoutSeconds,
            },
          );
        }
      } else if (first === "results") {
        const action = requireOperation(args, "jobs results", ["list", "acknowledge"]);
        operation = `results.${action}`;
        const jobId = takeOption(args, "--job-id");
        const acknowledgementState = takeOption(args, "--acknowledgement-state");
        resolved = await resolveCorpus(args, { projectOnly: true, allowBundleOverride: false });
        requireNoArguments(args);
        if (action === "list") {
          result = await inspectJobResults(resolved.context, { jobId, acknowledgementState });
        } else {
          if (!jobId || acknowledgementState) {
            throw errors.usage("jobs results acknowledge requires only --job-id and corpus options");
          }
          result = await acknowledgeJobResult(resolved.context, jobId);
        }
      } else {
        operation = first;
        if (
          !["list", "show", "run", "run-all-queued", "cancel", "retry", "clean", "discard-invalid"].includes(operation)
        ) {
          throw errors.usage("Unknown jobs operation");
        }
        const jobId = takeOption(args, "--job-id");
        const jobState = takeOption(args, "--job-state");
        const confirmRunAll = takeOption(args, "--confirm-run-all-queued", { boolean: true });
        const confirmDeletion = takeOption(args, "--confirm-job-state-deletion", { boolean: true });
        const confirmReconciled = takeOption(args, "--confirm-reconciled", { boolean: true });
        const confirmInvalidDeletion = takeOption(args, "--confirm-invalid-job-deletion", { boolean: true });
        resolved = await resolveCorpus(args, { projectOnly: true, allowBundleOverride: false });
        requireNoArguments(args);
        if (operation === "list") {
          if (jobId || confirmRunAll || confirmDeletion || confirmReconciled || confirmInvalidDeletion) {
            throw errors.usage("jobs list accepts only --job-state and corpus options");
          }
          result = await inspectJobs(resolved.context, undefined, { state: jobState });
        } else if (operation === "show") {
          if (!jobId || jobState || confirmRunAll || confirmDeletion || confirmReconciled || confirmInvalidDeletion) {
            throw errors.usage("jobs show requires only --job-id and corpus options");
          }
          result = await inspectJobs(resolved.context, jobId);
        } else if (operation === "run") {
          if (!jobId || jobState || confirmRunAll || confirmDeletion || confirmReconciled || confirmInvalidDeletion) {
            throw errors.usage("jobs run requires only --job-id and corpus options");
          }
          result = await runJobs(resolved.context, { jobId });
        } else if (operation === "run-all-queued") {
          if (jobId || jobState || confirmDeletion || confirmReconciled || confirmInvalidDeletion) {
            throw errors.usage("jobs run-all-queued accepts only its confirmation and corpus options");
          }
          if (!confirmRunAll) throw errors.confirmation("Running all queued jobs requires --confirm-run-all-queued");
          result = await runJobs(resolved.context, { waitForWorker: true });
        } else if (operation === "cancel" || operation === "retry") {
          if (!jobId || jobState || confirmRunAll || confirmDeletion || confirmReconciled || confirmInvalidDeletion) {
            throw errors.usage(`jobs ${operation} requires only --job-id and corpus options`);
          }
          result =
            operation === "cancel" ? await cancelJob(resolved.context, jobId) : await retryJob(resolved.context, jobId);
        } else if (operation === "clean") {
          if (!jobId || jobState || confirmRunAll || confirmInvalidDeletion) {
            throw errors.usage("jobs clean requires --job-id; --confirm-reconciled is optional");
          }
          if (!confirmDeletion) {
            throw errors.confirmation("Job cleanup requires --confirm-job-state-deletion after inspecting its result");
          }
          result = await cleanJob(resolved.context, jobId, {
            confirmJobStateDeletion: confirmDeletion,
            confirmReconciled,
          });
        } else {
          if (!jobId || jobState || confirmRunAll || confirmDeletion || confirmReconciled) {
            throw errors.usage("jobs discard-invalid requires --job-id with its confirmation option");
          }
          if (!confirmInvalidDeletion) {
            throw errors.confirmation("Invalid-job deletion requires --confirm-invalid-job-deletion");
          }
          result = await cleanJob(resolved.context, jobId, {
            confirmJobStateDeletion: confirmInvalidDeletion,
            discardInvalid: true,
          });
        }
      }
      break;
    }
    default:
      throw errors.usage(`Unknown command domain: ${domain}`);
  }

  const operationPath = [domain, operation].filter(Boolean).join(".");
  printResult(result, {
    outputFormat,
    operation: operationPath,
    corpusContext: resolved?.corpusContext,
    corpusLinkName: resolved?.corpusLinkName,
    arrayProperty,
  });
  return ["corpus.validate", "corpus.repair-indexes"].includes(operationPath) && !result.valid ? 4 : 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    const rawArgs = process.argv.slice(2);
    const bridgeInvocation = rawArgs[0] === "adapter" && rawArgs[1] === "bridge";
    if (bridgeInvocation) {
      console.error(JSON.stringify(adapterBridgeError(error, rawArgs)));
      process.exitCode = error instanceof EngramError ? error.exitCode : 1;
      return;
    }
    const outputFormatIndex = process.argv.indexOf("--output-format");
    const outputFormat = outputFormatIndex >= 0 ? process.argv[outputFormatIndex + 1] : "json";
    const failure = error instanceof EngramError ? error : errors.internal(error);
    if (outputFormat !== "text") {
      console.error(JSON.stringify({ error: failure.code, message: failure.message, details: failure.details }));
    } else {
      console.error(`engram: ${failure.message}`);
    }
    process.exitCode = failure.exitCode;
  },
);
