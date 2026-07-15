import { lstat, mkdir, readFile, readdir, realpath, rename, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import path from "node:path";
import { run } from "./process.js";

const ALLOWED_COMMANDS = new Set(["git", "ls", "node", "npm", "npx", "pnpm", "pwd", "rg", "yarn"]);
const DENIED_GIT_OPERATIONS = new Set(["credential", "push", "remote"]);
const DENIED_PACKAGE_OPERATIONS = new Set(["access", "adduser", "config", "create", "deprecate", "dist-tag", "dlx", "exec", "global", "hook", "init", "login", "logout", "org", "owner", "profile", "publish", "star", "stars", "team", "token", "unpublish", "whoami"]);
const READ_ONLY_GIT_OPERATIONS = new Set(["diff", "grep", "log", "ls-files", "rev-parse", "show", "status"]);

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

export function createWorkspaceTools(rootInput, { execute = run, mutable = true, allowTests = false } = {}) {
  const root = realpathSync(path.resolve(rootInput));
  const tools = {
    read_file: {
      parallelSafe: true,
      description: "Read a bounded UTF-8 line range inside the assigned workspace. Use offsetLine/limitLines instead of rereading large files.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          offsetLine: { type: "integer", minimum: 1 },
          limitLines: { type: "integer", minimum: 1, maximum: 2000 },
        },
        required: ["path"],
        additionalProperties: false,
      },
      execute: async ({ path: requested, offsetLine = 1, limitLines = 400 }) => {
        const value = await readFile(await existingPath(root, requested), "utf8");
        const lines = value.split("\n");
        const start = offsetLine - 1;
        let output = lines.slice(start, start + limitLines).join("\n");
        if (start + limitLines < lines.length) output += `\n[TRUNCATED: ${lines.length - start - limitLines} more lines; request the next range]`;
        if (Buffer.byteLength(output) > 256_000) output = `${output.slice(0, 256_000)}\n[TRUNCATED: byte limit]`;
        return output;
      },
    },
    write_file: {
      parallelSafe: false,
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
      parallelSafe: true,
      description: "List files recursively inside the assigned workspace.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 2000 } },
        required: ["path"],
        additionalProperties: false,
      },
      execute: async ({ path: requested, limit = 500 }) => {
        const directory = await existingPath(root, requested);
        const output = [];
        await walk(directory, root, output, limit);
        return JSON.stringify(output);
      },
    },
    run_command: {
      parallelSafe: false,
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
        const testCommand = allowTests && ((["npm", "pnpm", "yarn"].includes(command) && ["test", "run"].includes(args[0])) || (command === "node" && args[0] === "--test") || (command === "npx" && args[0] === "--no-install"));
        if (!mutable && !testCommand && !["git", "ls", "pwd", "rg"].includes(command)) throw new Error(`Command not allowed for read-only role: ${command}`);
        if (command === "git" && (args.some((item) => DENIED_GIT_OPERATIONS.has(item)) || args.some((item) => ["-c", "--config-env", "--exec-path"].includes(item)))) throw new Error("Git operation not allowed");
        if (!mutable && command === "git" && (args[0]?.startsWith("-") || !READ_ONLY_GIT_OPERATIONS.has(args[0]))) throw new Error(`Git operation not allowed for read-only role: ${args[0]}`);
        if (command === "npx" && args[0] !== "--no-install") throw new Error("npx requires --no-install");
        if (["npm", "pnpm", "yarn"].includes(command) && (args.some((item) => DENIED_PACKAGE_OPERATIONS.has(item)) || args.some((item) => ["-g", "--global"].includes(item)))) throw new Error("Package manager operation not allowed");
        const result = await execute(command, args, {
          cwd: root,
          timeoutMs: 900_000,
          maxOutputBytes: 500_000,
          inheritEnv: false,
          env: { PATH: process.env.PATH, HOME: "/tmp/agent-home", CI: "true", NO_COLOR: "1" },
        });
        const output = `${result.stdout}${result.stderr ? `\nSTDERR:\n${result.stderr}` : ""}`;
        return output.length > 120_000 ? `[TRUNCATED: showing final 120000 characters]\n${output.slice(-120_000)}` : output;
      },
    },
  };
  if (!mutable) delete tools.write_file;
  return tools;
}
