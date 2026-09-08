#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function run(file, args, { cwd = repo, env = {}, maxBytes = 2 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    const append = (current, chunk) => {
      if (current.length + chunk.length > maxBytes) {
        child.kill("SIGKILL");
        reject(new Error(`${file} output exceeded ${maxBytes} bytes`));
        return current;
      }
      return Buffer.concat([current, chunk]);
    };
    child.stdout.on("data", (chunk) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = append(stderr, chunk);
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      const result = { code, signal, stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8") };
      if (code === 0) resolve(result);
      else reject(new Error(`${file} ${args.join(" ")} failed (${code ?? signal}): ${result.stderr.slice(-2_000)}`));
    });
  });
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "okf-engram verification smoke "));
  try {
    const pack = await run("npm", ["pack", "--json", "--pack-destination", root]);
    const packed = JSON.parse(pack.stdout)[0];
    const tarball = path.join(root, packed.filename);
    const bytes = await fs.readFile(tarball);
    const consumer = path.join(root, "consumer");
    const project = path.join(root, "project");
    const agentDir = path.join(root, "agent");
    await fs.mkdir(consumer);
    await fs.mkdir(project);
    await fs.mkdir(agentDir);
    await fs.writeFile(path.join(consumer, "package.json"), '{"private":true}\n');

    await run(
      "npx",
      [
        "--yes",
        "--package=node@20.0.0",
        "--package=npm@9.9.4",
        "-c",
        'npm --prefix "$CONSUMER" install --engine-strict "$TARBALL"',
      ],
      { env: { CONSUMER: consumer, TARBALL: tarball } },
    );

    const installed = path.join(consumer, "node_modules", "okf-engram");
    const cli = path.join(installed, "scripts", "engram.mjs");
    const version = (await run("npx", ["--yes", "node@20.0.0", cli, "--version"])).stdout.trim();
    if (version !== packed.version) throw new Error(`packed version mismatch: ${version} != ${packed.version}`);
    await run("npx", [
      "--yes",
      "node@20.0.0",
      cli,
      "corpus",
      "initialize",
      "--corpus-context",
      "project",
      "--project-root-path",
      project,
    ]);
    const wiring = JSON.parse(
      (
        await run("npx", [
          "--yes",
          "node@20.0.0",
          cli,
          "wiring",
          "project",
          "install",
          "--corpus-context",
          "project",
          "--project-root-path",
          project,
        ])
      ).stdout,
    );
    if (!wiring.installed || !wiring.changed) throw new Error("packed wiring install did not persist");
    await run("npx", [
      "--yes",
      "node@20.0.0",
      cli,
      "wiring",
      "project",
      "remove",
      "--corpus-context",
      "project",
      "--project-root-path",
      project,
    ]);

    const packageRoot = path.join(consumer, "node_modules", "okf-engram");
    await run("pi", ["install", packageRoot], { env: { PI_CODING_AGENT_DIR: agentDir } });
    const npmRoot = (await run("npm", ["root", "-g"])).stdout.trim();
    const piRoot = path.join(npmRoot, "@earendil-works", "pi-coding-agent", "dist");
    const { DefaultResourceLoader } = await import(pathToFileURL(path.join(piRoot, "index.js")).href);
    const { expandPromptTemplate } = await import(pathToFileURL(path.join(piRoot, "core", "prompt-templates.js")).href);
    const loader = new DefaultResourceLoader({ cwd: project, agentDir });
    await loader.reload();
    const skills = loader.getSkills();
    const prompts = loader.getPrompts();
    const matchingSkills = skills.skills.filter((item) => item.name === "okf-engram");
    const matchingPrompts = prompts.prompts.filter((item) => item.name === "engram");
    const diagnostics = [...skills.diagnostics, ...prompts.diagnostics].filter((item) =>
      String(item.path ?? item.filePath ?? item.message).includes("engram"),
    );
    if (matchingSkills.length !== 1 || matchingPrompts.length !== 1 || diagnostics.length) {
      throw new Error("packed Pi skill/prompt discovery failed");
    }
    if (!matchingPrompts[0].argumentHint?.includes("wire") || matchingPrompts[0].argumentHint.includes("forget")) {
      throw new Error("packed /engram prompt does not expose the strict safe human subset");
    }
    const expandedPrompt = expandPromptTemplate("/engram ls", matchingPrompts);
    if (!expandedPrompt.includes("Engram request: ls") || expandedPrompt.includes("$ARGUMENTS")) {
      throw new Error("packed /engram prompt does not expand all request arguments");
    }

    console.log(
      JSON.stringify({
        version,
        artifact: packed.filename,
        artifactSha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
        artifactBytes: bytes.length,
        entryCount: packed.entryCount,
        node: "v20.0.0",
        npm: "9.9.4",
        engineStrictInstall: true,
        wiring: true,
        piSkill: matchingSkills[0].name,
        piPrompt: matchingPrompts[0].name,
        promptArguments: true,
        diagnostics: diagnostics.length,
      }),
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack ?? String(error));
  process.exitCode = 1;
});
