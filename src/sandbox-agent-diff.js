#!/usr/bin/env node
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { run } from "./process.js";

const [objectiveId, taskId, requestedLimit] = process.argv.slice(2);
const maxOutputBytes = Math.min(Math.max(Number(requestedLimit) || 500_000, 10_000), 500_000);
const excludedPaths = [":(exclude)**/.env*", ":(exclude)**/.npmrc", ":(exclude)**/.netrc", ":(exclude)**/*.key", ":(exclude)**/*.pem", ":(exclude)**/*.p12", ":(exclude)**/*.pfx", ":(exclude)**/*.tfvars", ":(exclude)**/id_rsa*", ":(exclude)**/.aws/credentials", ":(exclude)**/*credentials*.json", ":(exclude)**/*secret*.json", ":(exclude)**/*secret*.yaml", ":(exclude)**/*secret*.yml"];
const ansi = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?)/g;
const secretPatterns = [
  /((?:api[_-]?key|token|password|secret|authorization)\s*[:=]\s*["']?)[^\s,"']+/gi,
  /(AWS_ACCESS_KEY_ID\s*=\s*)\S+/g,
  /(AWS_SECRET_ACCESS_KEY\s*=\s*)\S+/g,
  /(Bearer\s+)[A-Za-z0-9._~+/-]+/gi,
  /(-----BEGIN [A-Z ]*PRIVATE KEY-----)[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----)/g,
];
function sanitize(value) {
  let safe = value.replace(ansi, "").replaceAll(/[^\n\t\x20-\x7e]/g, "?");
  for (const pattern of secretPatterns) safe = safe.replace(pattern, "$1[REDACTED]$2");
  const bytes = Buffer.from(safe);
  return bytes.length <= maxOutputBytes ? { value: safe, truncated: false } : { value: `${bytes.subarray(0, maxOutputBytes).toString("utf8")}\n\n[diff truncated]`, truncated: true };
}
const directory = "/workspace";
const git = (...args) => run("/usr/bin/git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-C", directory, ...args], { timeoutMs: 45_000, maxOutputBytes: 550_000, inheritEnv: false, env: { HOME: "/tmp" } });
const pathspec = ["--", ".", ...excludedPaths];
const dirty = Boolean((await git("status", "--short", "--untracked-files=normal", ...pathspec)).stdout.trim());
const staged = (await git("diff", "--cached", "--no-ext-diff", "--no-textconv", "--no-color", "--unified=3", ...pathspec)).stdout;
const unstaged = (await git("diff", "--no-ext-diff", "--no-textconv", "--no-color", "--unified=3", ...pathspec)).stdout;
const untracked = (await git("ls-files", "--others", "--exclude-standard", "-z", ...pathspec)).stdout.split("\0").filter(Boolean).slice(0, 20);
const additions = [];
for (const file of untracked) {
  if (/[\0\r\n]/.test(file)) continue;
  const absolute = await realpath(path.join(directory, file));
  if (!absolute.startsWith(`${directory}/`)) continue;
  const metadata = await stat(absolute);
  if (!metadata.isFile() || metadata.size > 64_000) { additions.push(`diff --git a/${file} b/${file}\n[untracked file omitted]`); continue; }
  const content = await readFile(absolute);
  if (content.includes(0)) { additions.push(`diff --git a/${file} b/${file}\n[untracked binary file omitted]`); continue; }
  const lines = content.toString("utf8").split("\n");
  additions.push(`diff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join("\n")}`);
}
let patch = [staged, unstaged, ...additions].filter(Boolean).join("\n");
let source = "working-tree";
if (!patch.trim()) { patch = (await git("show", "--format=", "--no-ext-diff", "--no-textconv", "--no-color", "--unified=3", "HEAD", ...pathspec)).stdout; source = "latest-checkpoint"; }
const sanitized = sanitize(patch.trim() || "No code changes recorded for this agent.");
process.stdout.write(`${JSON.stringify({ objectiveId, taskId, source, status: dirty ? "working tree has changes" : "clean checkpoint", patch: sanitized.value, truncated: sanitized.truncated })}\n`);
