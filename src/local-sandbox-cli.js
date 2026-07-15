#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { dockerRunArguments, validateLocalCommand } from "./local-sandbox.js";
import { WorkspaceCatalog } from "./workspace-catalog.js";

function execute(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: options.inherit ? "inherit" : "ignore", env: { PATH: process.env.PATH }, shell: false });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`${command} exited ${code ?? signal}`)));
  });
}

const args = process.argv.slice(2);
const reference = args.shift();
const previewIndex = args.indexOf("--preview");
const preview = previewIndex >= 0;
if (preview) args.splice(previewIndex, 1);
if (args[0] === "--") args.shift();
if (!reference || args.length === 0) throw new Error("Usage: factory sandbox run WORKSPACE [--preview] -- COMMAND [ARGS]");
validateLocalCommand(args);
const workspace = await new WorkspaceCatalog().resolve(reference);
if (!workspace.localPath) throw new Error("Sandbox execution requires an imported local workspace");
const root = process.env.FACTORY_ROOT;
if (!root) throw new Error("FACTORY_ROOT is required");
const packageValue = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const image = `factory-ai-local-run:${packageValue.version}`;
try { await execute("docker", ["image", "inspect", image]); } catch {
  process.stdout.write("Preparing the local Factory sandbox (one-time build)...\n");
  await execute("docker", ["build", "--file", path.join(root, "Dockerfile.local"), "--tag", image, root], { inherit: true });
}
const volume = `factory-ai-deps-${createHash("sha256").update(workspace.repository).digest("hex").slice(0, 16)}`;
const workspaceVolume = `factory-ai-run-${randomUUID()}`;
const network = "factory-ai-local-isolated";
await execute("docker", ["volume", "create", volume]);
await execute("docker", ["volume", "create", workspaceVolume]);
await execute("docker", ["run", "--rm", "--user", "0:0", "--volume", `${volume}:/deps`, "--entrypoint", "/bin/chown", image, `${process.getuid()}:${process.getgid()}`, "/deps"]);
await execute("docker", ["run", "--rm", "--user", "0:0", "--volume", `${workspaceVolume}:/workspace`, "--entrypoint", "/bin/chown", image, `${process.getuid()}:${process.getgid()}`, "/workspace"]);
try { await execute("docker", ["network", "inspect", network]); } catch { await execute("docker", ["network", "create", "--internal", network]); }
await execute("docker", ["run", "--rm", "--read-only", "--user", "0:0", "--security-opt", "no-new-privileges", "--tmpfs", "/tmp:rw,nosuid,size=256m", "--env", `FACTORY_TARGET_UID=${process.getuid()}`, "--env", `FACTORY_TARGET_GID=${process.getgid()}`, "--volume", `${workspace.localPath}:/source:ro`, "--volume", `${workspaceVolume}:/workspace:rw`, image, "true"], { inherit: true });
if (preview) process.stdout.write("Preview URLs: http://localhost:3000 or http://localhost:5173\nPress Ctrl+C to stop the preview and return to Factory AI.\n");
try {
  await execute("docker", dockerRunArguments({ image, workspaceVolume, volume, network, uid: process.getuid(), gid: process.getgid(), command: args, preview }), { inherit: true });
} finally {
  await execute("docker", ["volume", "rm", "--force", workspaceVolume]).catch(() => {});
}
