#!/usr/bin/env node
import fs from "node:fs/promises";
import process from "node:process";
import { resolveProject } from "./lib/project.mjs";
import {
  initializeCorpus,
  readConcept,
  writeConcept,
  listConcepts,
  searchCorpus,
  validateCorpus,
  inspectCorpusStatus,
  inspectSourceClaims,
  inventorySources,
  deprecateConcept,
  deleteConcept,
} from "./lib/bundle.mjs";
import { digestResource } from "./lib/sources.mjs";
import { captureSource, resolvePinnedSource } from "./lib/git-sources.mjs";
import { EngramError, errors } from "./lib/errors.mjs";
import { VERSION } from "./lib/constants.mjs";
import { getAutomaticMemoryPolicyStatus } from "./lib/settings.mjs";
import { inspectProjectWiring, installProjectWiring, removeProjectWiring } from "./lib/wiring.mjs";
import {
  enqueueArtifactIngestJob,
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

const HUMAN_HELP = `okf-engram ${VERSION} — project knowledge and memory

Common commands:
  /engram                         show project corpus status
  /engram help                    show this concise help
  /engram init                    initialize the project corpus
  /engram wire|unwire             add or remove the project reminder
  /engram auto status|on|off      manage automatic project memory
  /engram ls                      list concept envelopes
  /engram find WORDS              find concepts
  /engram show CONCEPT_ID         read one concept
  /engram remember STATEMENT      remember established knowledge
  /engram recall QUESTION         retrieve knowledge
  /engram ingest FILE...          ingest artifacts now
  /engram queue FILE...           queue artifact ingest
  /engram jobs [JOB_ID]           inspect deferred work
  /engram cancel JOB_ID           cancel deferred work

Commands are strict. Ask the agent normally for requests outside this list.
Run /engram --help for the canonical agent DSL.`;

const AGENT_HELP = `okf-engram ${VERSION} — canonical agent DSL

Usage:
  /engram <domain> <operation> [descriptive long options]

Operation kinds:
  [S] semantic workflow interpreted by the active Engram skill
  [D] deterministic helper operation

Corpus — the OKF knowledge aggregate: location, health, validation, and indexes.
  [D] corpus initialize       --corpus-context CONTEXT
  [D] corpus locate           --corpus-context CONTEXT
  [D] corpus status           --corpus-context CONTEXT
  [D] corpus validate         --corpus-context CONTEXT
  [D] corpus repair-indexes   --corpus-context CONTEXT

Knowledge — semantic incorporation of external artifacts into a corpus.
  [S] knowledge ingest        --corpus-context CONTEXT
                              --source-resource RESOURCE...
                              [--ingest-instruction TEXT]

Memory — semantic remembering and selective retrieval from corpora.
  [S] memory remember         --corpus-context CONTEXT
                              --memory-statement TEXT
  [S] memory recall           --corpus-context CONTEXT...
                              --recall-question TEXT

Concepts — deterministic operations on individual OKF concept documents.
  [D] concepts list           --corpus-context CONTEXT
                              [--concept-type TYPE]
  [D] concepts search         --corpus-context CONTEXT
                              --query TEXT [--result-limit INTEGER]
                              [--include-deprecated]
  [D] concepts read           --corpus-context CONTEXT --concept-id ID
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

Sources — evidence capture, provenance, exact reopening, and freshness checks.
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
  [D] sources check           --corpus-context CONTEXT [--concept-id ID]
  [D] sources inventory       --corpus-context CONTEXT [--concept-id ID]

Jobs — durable lifecycle management for deferred semantic work.
  [D] jobs enqueue artifact-ingest
                              --corpus-context project
                              --source-resource RESOURCE...
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

Wiring — optional project/client reminders that help activate Engram.
  [D] wiring project status|preview|install|remove
                              --corpus-context project

Context and output:
  --corpus-context project|global
      Required by the canonical DSL. Mutations select exactly one context;
      retrieval may repeat it where documented. This release supports project.
  --project-root-path PATH
      Resolve project context from an explicit project root.
  --corpus-bundle-path PATH
      Deterministic expert override, mutually exclusive with --corpus-context.
      It never inherits project automatic-memory policy.
  --output-format json|text
      Deterministic operations default to JSON; text is for direct debugging.

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

async function resolveCorpus(args, { projectOnly = false, allowBundleOverride = true } = {}) {
  const corpusContexts = takeOptions(args, "--corpus-context");
  const projectRootPath = takeOption(args, "--project-root-path");
  const corpusBundlePath = takeOption(args, "--corpus-bundle-path");

  if (corpusBundlePath !== undefined) {
    if (!allowBundleOverride) {
      throw errors.usage("This operation does not accept --corpus-bundle-path");
    }
    if (corpusContexts.length) {
      throw errors.usage("--corpus-bundle-path is mutually exclusive with --corpus-context");
    }
    const context = await resolveProject({ projectRoot: projectRootPath, bundle: corpusBundlePath });
    return { context, corpusContext: "explicit-bundle" };
  }

  if (corpusContexts.length !== 1) {
    throw errors.usage("Exactly one --corpus-context is required for this operation");
  }
  const [corpusContext] = corpusContexts;
  if (!new Set(["project", "global"]).has(corpusContext)) {
    throw errors.usage("--corpus-context must be project or global");
  }
  if (corpusContext === "global") {
    throw errors.usage("Global corpus context is not available in this release");
  }
  if (projectOnly && corpusContext !== "project") {
    throw errors.usage("This operation is available only in project corpus context");
  }
  const context = await resolveProject({ projectRoot: projectRootPath });
  return { context, corpusContext };
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
  if (result.automaticMemory && typeof result.automaticMemory === "object") {
    result.automaticMemory = canonicalizeResultFields(result.automaticMemory, "policy.project.automatic-memory.status");
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

function attachCorpusContext(result, corpusContext, operation, { arrayProperty = "items" } = {}) {
  if (Array.isArray(result)) return { corpusContext, [arrayProperty]: result };
  const canonical = canonicalizeResultFields(result, operation);
  if (canonical && typeof canonical === "object") return { corpusContext, ...canonical };
  return { corpusContext, value: canonical };
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
      console.log(`${item.id}\t${item.type}\t${item.title}\t${item.description} [${item.score}]`);
    }
    return;
  }
  if (operation === "concepts.list") {
    for (const item of result.concepts) console.log(`${item.id}\t${item.type}\t${item.title}`);
    return;
  }
  if (operation === "corpus.locate") {
    console.log(`Corpus context: ${result.corpusContext}`);
    console.log(`Project root: ${result.projectRootPath}`);
    console.log(`Bundle: ${result.logicalBundlePath}`);
    if (result.bundlePath !== result.logicalBundlePath) console.log(`Canonical bundle: ${result.bundlePath}`);
    console.log(`Discovery: ${result.method}`);
    console.log(`Initialized: ${result.initialized ? "yes" : "no"}`);
    return;
  }
  if (operation === "corpus.initialize") {
    console.log(`${result.created ? "Initialized" : "Found existing"} Engram corpus: ${result.logicalBundlePath}`);
    if (result.bundlePath !== result.logicalBundlePath) console.log(`Canonical bundle: ${result.bundlePath}`);
    console.log("Optional: run /engram wire to add the project reminder; this does not enable automatic memory.");
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
  else console.log(JSON.stringify(result, null, 2));
}

function printResult(result, { outputFormat, operation, corpusContext, arrayProperty } = {}) {
  const contextualResult = corpusContext
    ? attachCorpusContext(result, corpusContext, operation, { arrayProperty })
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
    case "knowledge": {
      operation = requireOperation(args, domain, ["ingest"]);
      const corpusContexts = takeOptions(args, "--corpus-context");
      const sourceResources = takeOptions(args, "--source-resource");
      takeOption(args, "--ingest-instruction");
      const projectRootPath = takeOption(args, "--project-root-path");
      if (
        corpusContexts.length !== 1 ||
        !["project", "global"].includes(corpusContexts[0]) ||
        !sourceResources.length ||
        new Set(sourceResources).size !== sourceResources.length
      ) {
        throw errors.usage("knowledge ingest requires one valid --corpus-context and unique --source-resource values");
      }
      if (corpusContexts[0] === "global" && projectRootPath) {
        throw errors.usage("Global corpus context does not accept --project-root-path");
      }
      requireNoArguments(args);
      semanticOperationError("knowledge ingest");
      break;
    }
    case "memory": {
      operation = requireOperation(args, domain, ["remember", "recall"]);
      const corpusContexts = takeOptions(args, "--corpus-context");
      const projectRootPath = takeOption(args, "--project-root-path");
      if (operation === "remember") {
        const statement = takeOption(args, "--memory-statement");
        if (corpusContexts.length !== 1 || !statement) {
          throw errors.usage("memory remember requires one --corpus-context and --memory-statement");
        }
      } else {
        const question = takeOption(args, "--recall-question");
        if (!corpusContexts.length || !question) {
          throw errors.usage("memory recall requires one or more --corpus-context values and --recall-question");
        }
        if (new Set(corpusContexts).size !== corpusContexts.length) {
          throw errors.usage("memory recall corpus contexts must be unique");
        }
      }
      if (corpusContexts.some((value) => !["project", "global"].includes(value))) {
        throw errors.usage("--corpus-context must be project or global");
      }
      if (!corpusContexts.includes("project") && projectRootPath) {
        throw errors.usage("Global-only memory operations do not accept --project-root-path");
      }
      requireNoArguments(args);
      semanticOperationError(`memory ${operation}`);
      break;
    }
    case "corpus": {
      operation = requireOperation(args, domain, ["initialize", "locate", "status", "validate", "repair-indexes"]);
      resolved = await resolveCorpus(args);
      requireNoArguments(args);
      if (operation === "initialize") result = await initializeCorpus(resolved.context);
      else if (operation === "locate") result = resolved.context;
      else if (operation === "status") result = await inspectCorpusStatus(resolved.context);
      else if (operation === "validate") result = await validateCorpus(resolved.context);
      else result = await validateCorpus(resolved.context, { fix: true });
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
      if (args.shift() !== "project" || args.shift() !== "automatic-memory") {
        throw errors.usage("policy requires project automatic-memory status, enable, or disable");
      }
      const action = requireOperation(args, "policy project automatic-memory", ["status", "enable", "disable"]);
      operation = `project.automatic-memory.${action}`;
      resolved = await resolveCorpus(args, { projectOnly: true, allowBundleOverride: false });
      requireNoArguments(args);
      result =
        action === "status"
          ? await getAutomaticMemoryPolicyStatus(resolved.context, { tolerateInvalid: true })
          : await setProjectAutomaticMemoryPolicy(resolved.context, action === "enable" ? "on" : "off");
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
      resolved = await resolveCorpus(args);
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
        result = await listConcepts(resolved.context, { type: conceptType });
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
        result = await searchCorpus(resolved.context, query, { limit: resultLimit, includeDeprecated });
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
        result = await readConcept(resolved.context, conceptId);
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
      operation = requireOperation(args, domain, ["digest", "capture", "resolve", "check", "inventory"]);
      const sourceResource = takeOption(args, "--source-resource");
      const conceptId = takeOption(args, "--concept-id");
      const sourceId = takeOption(args, "--source-id");
      const outputFilePath = takeOption(args, "--output-file-path");
      const selectedRegionOutputFilePath = takeOption(args, "--selected-region-output-file-path");
      const selectorKind = takeOption(args, "--source-selector-kind");
      const selectorValue = takeOption(args, "--source-selector-value");
      const gitRevision = takeOption(args, "--git-revision");
      resolved = await resolveCorpus(args);
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
      } else if (operation === "check" || operation === "inventory") {
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
        result =
          operation === "inventory"
            ? await inventorySources(resolved.context, conceptId)
            : await inspectSourceClaims(resolved.context, conceptId);
        if (operation === "check") arrayProperty = "sourceClaims";
      }
      break;
    }
    case "jobs": {
      const first = args.shift();
      if (!first) throw errors.usage("jobs requires an operation");
      if (first === "enqueue") {
        const kind = requireOperation(args, "jobs enqueue", ["artifact-ingest", "inferred-memory"]);
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
        if (kind === "artifact-ingest") {
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
              "jobs enqueue artifact-ingest requires --source-resource and --ingest-instruction with worker options",
            );
          }
          result = await enqueueArtifactIngestJob(resolved.context, sourceResources, {
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
          result = await runJobs(resolved.context);
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
    arrayProperty,
  });
  return ["corpus.validate", "corpus.repair-indexes"].includes(operationPath) && !result.valid ? 4 : 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    const outputFormatIndex = process.argv.indexOf("--output-format");
    const outputFormat = outputFormatIndex >= 0 ? process.argv[outputFormatIndex + 1] : "json";
    if (error instanceof EngramError) {
      if (outputFormat !== "text") {
        console.error(JSON.stringify({ error: error.code, message: error.message, details: error.details }));
      } else {
        console.error(`engram: ${error.message}`);
      }
      process.exitCode = error.exitCode;
      return;
    }
    console.error(error.stack ?? String(error));
    process.exitCode = 1;
  },
);
