#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import http from "node:http";
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

async function serveDirectory(directory) {
  const root = await fs.realpath(directory);
  const server = http.createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://127.0.0.1").pathname);
      const target = path.resolve(root, pathname.replace(/^\/+/, ""));
      const relative = path.relative(root, target);
      if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
        response.writeHead(404).end();
        return;
      }
      const stat = await fs.stat(target);
      if (!stat.isFile()) {
        response.writeHead(404).end();
        return;
      }
      const content = await fs.readFile(target);
      response.writeHead(200, { "content-length": content.length });
      response.end(content);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server;
}

async function closeServer(server) {
  if (!server) return;
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

async function piCommandSourceInfo(agentDir, project, root, label) {
  const probe = path.join(root, `adapter-bridge-probe-${label}.mjs`);
  const output = path.join(root, `adapter-bridge-probe-${label}.json`);
  await fs.writeFile(
    probe,
    `import fs from "node:fs/promises";\nexport default function (pi) {\n  pi.registerCommand("engram-adapter-bridge-probe", {\n    description: "Verification-only package provenance probe",\n    async handler() {\n      await fs.writeFile(process.env.ENGRAM_ADAPTER_PROBE_OUTPUT, JSON.stringify(pi.getCommands()));\n    },\n  });\n}\n`,
  );
  await run("pi", ["--no-session", "-e", probe, "-p", "/engram-adapter-bridge-probe"], {
    cwd: project,
    env: { PI_CODING_AGENT_DIR: agentDir, ENGRAM_ADAPTER_PROBE_OUTPUT: output },
  });
  return JSON.parse(await fs.readFile(output, "utf8")).map((command) => command.sourceInfo);
}

async function discoverAdapterBridge(sourceInfos) {
  const roots = [
    ...new Set(
      sourceInfos
        .filter((source) => source?.origin === "package" && source.baseDir)
        .map((source) => source.baseDir),
    ),
  ];
  const candidates = [];
  for (const packageRoot of roots) {
    let packageDocument;
    try {
      packageDocument = JSON.parse(await fs.readFile(path.join(packageRoot, "package.json"), "utf8"));
    } catch {
      continue;
    }
    const bridge = packageDocument.okfEngram?.adapterBridge;
    if (packageDocument.name !== "okf-engram" || !bridge) continue;
    if (
      bridge.manifestVersion !== 1 ||
      bridge.protocol !== "okf-engram.adapter-bridge" ||
      bridge.transport !== "node-cli-json" ||
      !Array.isArray(bridge.supportedProtocolVersions) ||
      !bridge.supportedProtocolVersions.includes(1) ||
      !Array.isArray(bridge.commandPrefix) ||
      bridge.protocolVersionOption !== "--adapter-bridge-protocol-version"
    ) {
      throw new Error("invalid installed adapter bridge manifest");
    }
    const canonicalRoot = await fs.realpath(packageRoot);
    const entrypoint = await fs.realpath(path.resolve(canonicalRoot, bridge.entrypoint));
    const relative = path.relative(canonicalRoot, entrypoint);
    if (!relative || path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
      throw new Error("adapter bridge entrypoint escapes its package root");
    }
    candidates.push({ packageRoot: canonicalRoot, entrypoint, bridge });
  }
  if (candidates.length !== 1) throw new Error(`expected one installed adapter bridge, found ${candidates.length}`);
  return candidates[0];
}

async function handshakeAdapterBridge(discovered) {
  const result = await run("npx", [
    "--yes",
    "node@20.0.0",
    discovered.entrypoint,
    ...discovered.bridge.commandPrefix,
    "handshake",
    discovered.bridge.protocolVersionOption,
    "1",
  ]);
  const handshake = JSON.parse(result.stdout);
  if (
    handshake.bridgeProtocol !== discovered.bridge.protocol ||
    handshake.bridgeProtocolVersion !== 1 ||
    handshake.target?.corpusContext !== "project" ||
    handshake.target?.fallback !== false
  ) {
    throw new Error("installed adapter bridge handshake failed");
  }
  return handshake;
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "okf-engram verification smoke "));
  let gitServer;
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
    const localSourceInfo = await piCommandSourceInfo(agentDir, project, root, "local");
    const localBridge = await discoverAdapterBridge(localSourceInfo);
    const localHandshake = await handshakeAdapterBridge(localBridge);

    const gitSource = path.join(root, "git-source");
    const gitWebRoot = path.join(root, "git-web");
    const bareRepository = path.join(gitWebRoot, "owner", "okf-engram.git");
    const gitAgentDir = path.join(root, "git-agent");
    await fs.mkdir(gitSource);
    await fs.mkdir(path.dirname(bareRepository), { recursive: true });
    await fs.mkdir(gitAgentDir);
    await run("tar", ["-xzf", tarball, "--strip-components=1", "-C", gitSource]);
    await run("git", ["init", "-q"], { cwd: gitSource });
    await run("git", ["config", "user.name", "Engram verification"], { cwd: gitSource });
    await run("git", ["config", "user.email", "verification@example.invalid"], { cwd: gitSource });
    await run("git", ["add", "."], { cwd: gitSource });
    await run("git", ["commit", "-qm", "verification package"], { cwd: gitSource });
    await run("git", ["clone", "-q", "--bare", gitSource, bareRepository]);
    await run("git", [`--git-dir=${bareRepository}`, "update-server-info"]);
    gitServer = await serveDirectory(gitWebRoot);
    const address = gitServer.address();
    if (!address || typeof address === "string") throw new Error("failed to start local Git package server");
    const gitPackageUrl = `http://127.0.0.1:${address.port}/owner/okf-engram.git`;
    await run("pi", ["install", gitPackageUrl], {
      env: { PI_CODING_AGENT_DIR: gitAgentDir, GIT_TERMINAL_PROMPT: "0" },
    });
    const gitSourceInfo = await piCommandSourceInfo(gitAgentDir, project, root, "git");
    const gitBridge = await discoverAdapterBridge(gitSourceInfo);
    const gitHandshake = await handshakeAdapterBridge(gitBridge);
    if (gitBridge.packageRoot === localBridge.packageRoot) {
      throw new Error("local and Git bridge discovery unexpectedly resolved the same package root");
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
        adapterBridge: {
          protocol: localHandshake.bridgeProtocol,
          protocolVersion: localHandshake.bridgeProtocolVersion,
          localPackage: true,
          gitPackage: gitHandshake.bridgeProtocolVersion === 1,
        },
        diagnostics: diagnostics.length,
      }),
    );
  } finally {
    await closeServer(gitServer);
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack ?? String(error));
  process.exitCode = 1;
});
