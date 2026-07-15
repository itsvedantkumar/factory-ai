const allowed = new Set(["git", "node", "npm", "npx", "pnpm", "yarn"]);
const denied = new Set(["publish", "unpublish", "login", "logout", "token", "config", "dlx", "global", "-g", "--global", "push", "remote", "credential"]);
const readOnlyGit = new Set(["status", "diff", "log", "show", "grep", "ls-files", "rev-parse"]);

export function validateLocalCommand(command) {
  if (!Array.isArray(command) || command.length === 0 || !allowed.has(command[0])) throw new Error(`Command not allowed: ${command?.[0] ?? "empty"}`);
  if (command.slice(1).some((item) => denied.has(item))) throw new Error("Unsafe command operation");
  if (command[0] === "npx" && command[1] !== "--no-install") throw new Error("npx requires --no-install");
  if (command[0] === "git" && !readOnlyGit.has(command[1])) throw new Error("Only read-only Git commands are allowed");
  return command;
}

export function dockerRunArguments({ image, workspaceVolume, volume, network, uid, gid, command, preview }) {
  validateLocalCommand(command);
  return [
    "run", "--rm", "-i",
    "--read-only",
    "--user", `${uid}:${gid}`,
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--pids-limit", "512",
    "--memory", "8g",
    "--cpus", "2",
    "--network", network,
    "--tmpfs", `/tmp:rw,exec,nosuid,size=1g,uid=${uid},gid=${gid}`,
    "--volume", `${workspaceVolume}:/workspace:rw`,
    "--volume", `${volume}:/workspace/node_modules:rw`,
    "--workdir", "/workspace",
    "--env", "HOME=/tmp",
    "--env", "CI=false",
    "--env", "NO_COLOR=1",
    ...(preview ? ["--env", "HOST=0.0.0.0"] : []),
    ...(preview ? ["--publish", "127.0.0.1:3000:3000", "--publish", "127.0.0.1:5173:5173"] : []),
    image,
    ...command,
  ];
}
