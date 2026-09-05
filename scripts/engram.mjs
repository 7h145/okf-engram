#!/usr/bin/env node
import fs from "node:fs/promises";
import process from "node:process";
import { resolveProject } from "./lib/project.mjs";
import {
  initializeBundle, getConcept, putConcept, listConcepts, searchBundle,
  lintBundle, reindexBundle, statusBundle, checkSources, deprecateConcept,
  deleteConcept,
} from "./lib/bundle.mjs";
import { digestResource } from "./lib/sources.mjs";
import { EngramError, errors } from "./lib/errors.mjs";
import { VERSION } from "./lib/constants.mjs";
import { getAutoMemoryStatus, setAutoMemory } from "./lib/settings.mjs";

const HELP = `okf-engram ${VERSION}

Usage: engram <command> [options]

Commands:
  init                         initialize the project bundle explicitly
  where                        show project and bundle resolution
  status                       report bundle health and tracking
  auto-memory status|on|off    inspect or set project automatic-memory policy
  auto status|on|off           shorthand for auto-memory
  list [--type TYPE]           list concept envelopes
  search QUERY [--limit N]     search all concepts
  get ID                       read a concept and current hash
  put ID --from FILE           create or conditionally replace a concept
  digest RESOURCE              hash a project: or file: source
  check-sources [ID]           report local source drift
  lint [--fix]                 validate and optionally rebuild indexes
  reindex                      rebuild generated indexes
  deprecate ID --reason TEXT   mark a concept deprecated
  delete ID --yes              current-tree deletion

Common options:
  --project-root PATH          explicit project root
  --bundle PATH                explicit bundle path
  --if-match SHA256            required for replacement/deletion
  --automatic-memory           mark an inferred-memory write for policy gating
  --json                       machine-readable output
  --help                       show help
`;

function option(args, name, { boolean = false } = {}) {
  const index = args.indexOf(name);
  if (index < 0) return boolean ? false : undefined;
  args.splice(index, 1);
  if (boolean) return true;
  if (index >= args.length) throw errors.usage(`${name} requires a value`);
  return args.splice(index, 1)[0];
}

function printResult(result, { json = false, command } = {}) {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === "get") {
    process.stdout.write(result.text);
    console.error(`Hash: ${result.hash}`);
    return;
  }
  if (command === "search") {
    if (!result.results.length) console.log("No matching concepts.");
    for (const item of result.results) {
      console.log(`${item.id}\t${item.type}\t${item.title}\t${item.description} [${item.score}]`);
    }
    return;
  }
  if (command === "list") {
    for (const item of result.concepts) console.log(`${item.id}\t${item.type}\t${item.title}`);
    return;
  }
  if (command === "where") {
    console.log(`Project root: ${result.projectRoot}`);
    console.log(`Bundle: ${result.logicalBundle}`);
    if (result.bundle !== result.logicalBundle) console.log(`Canonical bundle: ${result.bundle}`);
    console.log(`Discovery: ${result.method}`);
    console.log(`Initialized: ${result.initialized ? "yes" : "no"}`);
    return;
  }
  if (typeof result === "string") console.log(result);
  else console.log(JSON.stringify(result, null, 2));
}

async function main(rawArgs = process.argv.slice(2)) {
  const args = [...rawArgs];
  if (!args.length || args.includes("--help") || args[0] === "help") {
    console.log(HELP);
    return 0;
  }
  if (args.includes("--version")) {
    console.log(VERSION);
    return 0;
  }

  const command = args.shift();
  const json = option(args, "--json", { boolean: true });
  const projectRoot = option(args, "--project-root");
  const bundle = option(args, "--bundle");
  const context = await resolveProject({ projectRoot, bundle });
  let result;

  switch (command) {
    case "where":
      if (args.length) throw errors.usage(`Unexpected arguments: ${args.join(" ")}`);
      result = context;
      break;
    case "init":
      if (args.length) throw errors.usage(`Unexpected arguments: ${args.join(" ")}`);
      result = await initializeBundle(context);
      break;
    case "status":
      if (args.length) throw errors.usage(`Unexpected arguments: ${args.join(" ")}`);
      result = await statusBundle(context);
      break;
    case "auto":
    case "auto-memory": {
      if (bundle) throw errors.usage("auto-memory is available only for the default project context, not --bundle");
      const action = args.shift();
      if (!action || args.length || !["status", "on", "off"].includes(action)) {
        throw errors.usage("auto-memory requires status, on, or off");
      }
      result = action === "status"
        ? await getAutoMemoryStatus(context, { tolerateInvalid: true })
        : await setAutoMemory(context, action);
      break;
    }
    case "list": {
      const type = option(args, "--type");
      if (args.length) throw errors.usage(`Unexpected arguments: ${args.join(" ")}`);
      result = await listConcepts(context, { type });
      break;
    }
    case "search": {
      const limitRaw = option(args, "--limit");
      const includeDeprecated = option(args, "--include-deprecated", { boolean: true });
      const query = args.join(" ").trim();
      if (!query) throw errors.usage("search requires a query");
      const limit = limitRaw === undefined ? 10 : Number(limitRaw);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw errors.usage("--limit must be an integer from 1 to 100");
      }
      result = await searchBundle(context, query, { limit, includeDeprecated });
      break;
    }
    case "get": {
      const id = args.shift();
      if (!id || args.length) throw errors.usage("get requires exactly one concept ID");
      result = await getConcept(context, id);
      break;
    }
    case "put": {
      const id = args.shift();
      const from = option(args, "--from");
      const ifMatch = option(args, "--if-match");
      const automaticMemory = option(args, "--automatic-memory", { boolean: true });
      if (!id || !from || args.length) throw errors.usage("put requires ID and --from FILE");
      const draftText = await fs.readFile(from, "utf8").catch((error) => {
        if (error.code === "ENOENT") throw errors.notFound(`Draft ${from}`);
        throw error;
      });
      result = await putConcept(context, id, draftText, {
        ifMatch, source: from, automaticMemory,
      });
      break;
    }
    case "digest": {
      const resource = args.shift();
      if (!resource || args.length) throw errors.usage("digest requires exactly one resource");
      result = await digestResource(resource, context.projectRoot);
      break;
    }
    case "check-sources": {
      const id = args.shift();
      if (args.length) throw errors.usage("check-sources accepts at most one concept ID");
      result = await checkSources(context, id);
      break;
    }
    case "lint": {
      const fix = option(args, "--fix", { boolean: true });
      if (args.length) throw errors.usage(`Unexpected arguments: ${args.join(" ")}`);
      result = await lintBundle(context, { fix });
      break;
    }
    case "reindex":
      if (args.length) throw errors.usage(`Unexpected arguments: ${args.join(" ")}`);
      result = await reindexBundle(context);
      break;
    case "deprecate": {
      const id = args.shift();
      const reason = option(args, "--reason");
      const ifMatch = option(args, "--if-match");
      if (!id || !reason || !ifMatch || args.length) {
        throw errors.usage("deprecate requires ID, --reason TEXT, and --if-match SHA256");
      }
      result = await deprecateConcept(context, id, { reason, ifMatch });
      break;
    }
    case "delete": {
      const id = args.shift();
      const ifMatch = option(args, "--if-match");
      const yes = option(args, "--yes", { boolean: true });
      if (!id || args.length) throw errors.usage("delete requires exactly one concept ID plus options");
      result = await deleteConcept(context, id, { ifMatch, yes });
      break;
    }
    default:
      throw errors.usage(`Unknown command: ${command}`);
  }

  printResult(result, { json, command });
  return command === "lint" && !result.valid ? 4 : 0;
}

main().then(
  (code) => { process.exitCode = code; },
  (error) => {
    const json = process.argv.includes("--json");
    if (error instanceof EngramError) {
      if (json) console.error(JSON.stringify({ error: error.code, message: error.message, details: error.details }));
      else console.error(`engram: ${error.message}`);
      process.exitCode = error.exitCode;
      return;
    }
    console.error(error.stack ?? String(error));
    process.exitCode = 1;
  },
);
