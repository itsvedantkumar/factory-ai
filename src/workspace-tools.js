import { lstat, mkdir, readFile, readdir, realpath, rename, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import path from "node:path";
import { run } from "./process.js";

const ALLOWED_COMMANDS = new Set(["git", "ls", "node", "npm", "npx", "pwd", "rg"]);
const DENIED_GIT_OPERATIONS = new Set(["credential", "push", "remote"]);

function lexicalPath(root, requested) {
  const target = path.resolve(root, requested);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error("Path is outside workspace");
  return target;
}

async function existingPath(root, requested) {
  const target = lexicalPath(root, requested);
  const resolved = await realpath(target);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new Error("Path is outside workspace");
  return resolved;
}

async function writeTarget(root, requested) {
  const target = lexicalPath(root, requested);
  await mkdir(path.dirname(target), { recursive: true });
  const parent = await realpath(path.dirname(target));
  if (parent !== root && !parent.startsWith(`${root}${path.sep}`)) throw new Error("Path is outside workspace");
  try {
    const metadata = await lstat(target);
    if (metadata.isSymbolicLink()) throw new Error("Symbolic link writes are not allowed");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return target;
}

async function walk(directory, root, output, limit) {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === ".git" || output.length >= limit) continue;
    const absolute = path.join(directory, entry.name);
    const relative = path.relative(root, absolute);
    if (entry.isDirectory()) await walk(absolute, root, output, limit);
    else if (entry.isFile()) output.push(relative);
  }
}

export function createWorkspaceTools(rootInput, { execute = run } = {}) {
  const root = realpathSync(path.resolve(rootInput));
  return {
    read_file: {
      description: "Read a UTF-8 file inside the assigned workspace.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      },
      execute: async ({ path: requested }) => {
        const value = await readFile(await existingPath(root, requested), "utf8");
        if (Buffer.byteLength(value) > 512_000) throw new Error("File exceeds 512000 bytes");
        return value;
      },
    },
    write_file: {
      description: "Atomically replace a UTF-8 file inside the assigned workspace.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
        additionalProperties: false,
      },
      execute: async ({ path: requested, content }) => {
        if (Buffer.byteLength(content) > 1_000_000) throw new Error("Content exceeds 1000000 bytes");
        const target = await writeTarget(root, requested);
        const temporary = `${target}.${process.pid}.tmp`;
        await writeFile(temporary, content, { mode: 0o640 });
        await rename(temporary, target);
        return "written";
      },
    },
    list_files: {
      description: "List files recursively inside the assigned workspace.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      },
      execute: async ({ path: requested }) => {
        const directory = await existingPath(root, requested);
        const output = [];
        await walk(directory, root, output, 2000);
        return JSON.stringify(output);
      },
    },
    run_command: {
      description: "Run an allowlisted noninteractive development command in the assigned workspace.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", enum: [...ALLOWED_COMMANDS] },
          args: { type: "array", items: { type: "string" }, maxItems: 100 },
        },
        required: ["command", "args"],
        additionalProperties: false,
      },
      execute: async ({ command, args }) => {
        if (!ALLOWED_COMMANDS.has(command)) throw new Error(`Command not allowed: ${command}`);
        if (command === "git" && DENIED_GIT_OPERATIONS.has(args[0])) throw new Error(`Git operation not allowed: ${args[0]}`);
        if (command === "npx" && args[0] !== "--no-install") throw new Error("npx requires --no-install");
        const result = await execute(command, args, {
          cwd: root,
          timeoutMs: 900_000,
          maxOutputBytes: 2_000_000,
          inheritEnv: false,
          env: { PATH: process.env.PATH, HOME: "/tmp/agent-home", CI: "true", NO_COLOR: "1" },
        });
        return `${result.stdout}${result.stderr ? `\nSTDERR:\n${result.stderr}` : ""}`.slice(-2_000_000);
      },
    },
  };
}
