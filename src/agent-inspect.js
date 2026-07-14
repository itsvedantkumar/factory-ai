import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { run } from "./process.js";

const identifier = /^[A-Za-z0-9_-]{1,64}$/;

export async function inspectAgentDiff({ workspaceRoot, objectiveId, taskId, workerImage = process.env.FACTORY_WORKER_IMAGE, execute = run, maxOutputBytes = 500_000 }) {
  if (!identifier.test(objectiveId)) throw new Error("Invalid objective ID");
  if (!identifier.test(taskId)) throw new Error("Invalid task ID");
  const root = await realpath(path.resolve(workspaceRoot));
  const expected = path.join(root, objectiveId, "tasks", taskId);
  const directory = await realpath(expected);
  const gitDirectory = await realpath(path.join(directory, ".git"));
  const directoryMetadata = await stat(directory);
  if (!directory.startsWith(`${root}${path.sep}`) || gitDirectory !== path.join(directory, ".git") || !(await stat(gitDirectory)).isDirectory()) throw new Error("Agent worktree is unavailable");
  if (!workerImage || !/^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,255}$/.test(workerImage)) throw new Error("Invalid worker image for diff sandbox");
  const result = await execute("/usr/bin/docker", ["run", "--rm", "--network", "none", "--read-only", "--tmpfs", "/tmp:rw,noexec,nosuid,size=16m", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "64", "--memory", "256m", "--cpus", "0.5", "--user", `${directoryMetadata.uid}:${directoryMetadata.gid}`, "--volume", `${directory}:/workspace:ro`, "--workdir", "/workspace", "--entrypoint", "node", workerImage, "/opt/agent-factory/app/src/sandbox-agent-diff.js", objectiveId, taskId, String(maxOutputBytes)], { timeoutMs: 90_000, maxOutputBytes: maxOutputBytes + 100_000, inheritEnv: false, env: {} });
  return JSON.parse(result.stdout);
}
