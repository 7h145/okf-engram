#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { loadConfig, runTriage } from "./lib.mjs";

const directory = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(raw) {
  const args = [...raw];
  const take = (name) => {
    const index = args.indexOf(name);
    if (index < 0) return undefined;
    args.splice(index, 1);
    if (index >= args.length) throw new Error(`${name} requires a value`);
    return args.splice(index, 1)[0];
  };
  const verificationDir = take("--verification-dir");
  const outputDir = take("--output-dir");
  const configPath = path.resolve(take("--config") ?? path.join(directory, "config.json"));
  const model = take("--model") ?? process.env.ENGRAM_TRIAGE_MODEL;
  const thinking = take("--thinking") ?? process.env.ENGRAM_TRIAGE_THINKING;
  if (args.length) throw new Error(`Unexpected arguments: ${args.join(" ")}`);
  if (!verificationDir) throw new Error("--verification-dir is required");
  if (!outputDir) throw new Error("--output-dir is required");
  return {
    verificationDir: path.resolve(verificationDir),
    outputDir: path.resolve(outputDir),
    configPath,
    model,
    thinking,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const config = await loadConfig(options.configPath, {
    model: options.model,
    thinking: options.thinking,
  });
  const summary = await runTriage({
    verificationDir: options.verificationDir,
    outputDir: options.outputDir,
    promptPath: path.join(directory, "prompt.md"),
    config,
    environment: process.env,
  });
  return summary.overall === "completed" ? 0 : 1;
}

main().then(
  (code) => { process.exitCode = code; },
  (error) => {
    console.error(error.stack ?? String(error));
    process.exitCode = 2;
  },
);
