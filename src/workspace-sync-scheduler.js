import { access, constants, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "./process.js";

const launchLabel = "com.factory-ai.workspace-sync";
const systemdName = "factory-ai-workspace-sync";
const trustedGitCandidates = ["/usr/bin/git", "/opt/homebrew/bin/git", "/opt/local/bin/git", "/usr/local/bin/git"];

function xml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function unitArgument(value) { return `"${String(value).replaceAll("%", "%%").replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`; }

function safePath(value, label) {
  if (typeof value !== "string" || /[\0\r\n]/.test(value)) throw new Error(`Invalid ${label} path`);
  const resolved = path.resolve(value);
  if (!path.isAbsolute(resolved)) throw new Error(`Invalid ${label} path`);
  return resolved;
}

function safeSearchPath(value) {
  return String(value).split(path.delimiter).filter((entry) => path.isAbsolute(entry) && !/[\0\r\n%]/.test(entry)).join(path.delimiter);
}

async function atomicWrite(file, content) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, content, { mode: 0o600 });
  await rename(temporary, file);
}

export class WorkspaceSyncScheduler {
  constructor({
    home = os.homedir(),
    platform = process.platform,
    uid = process.getuid?.(),
    nodePath = process.execPath,
    cliPath = fileURLToPath(new URL("./workspace-cli.js", import.meta.url)),
    pathValue = process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    execute = run,
  } = {}) {
    this.home = path.resolve(home);
    this.platform = platform;
    this.uid = uid;
    this.nodePath = safePath(nodePath, "Node executable");
    this.cliPath = safePath(cliPath, "workspace CLI");
    this.pathValue = safeSearchPath(pathValue);
    this.execute = execute;
  }

  launchAgentPath() { return path.join(this.home, "Library", "LaunchAgents", `${launchLabel}.plist`); }
  systemdDirectory() { return path.join(this.home, ".config", "systemd", "user"); }

  async gitPath() {
    for (const candidate of trustedGitCandidates) {
      try { await access(candidate, constants.X_OK); return await realpath(candidate); } catch {}
    }
    throw new Error("Unable to locate a trusted absolute Git executable");
  }

  async enable() {
    if (this.platform === "darwin") {
      if (!Number.isInteger(this.uid)) throw new Error("Unable to determine user ID for workspace sync");
      const logDirectory = path.join(this.home, ".config", "factory-ai");
      await mkdir(logDirectory, { recursive: true, mode: 0o700 });
      const gitPath = await this.gitPath();
      const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${launchLabel}</string>
<key>ProgramArguments</key><array><string>${xml(this.nodePath)}</string><string>${xml(this.cliPath)}</string><string>sync</string><string>run</string></array>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(this.pathValue)}</string><key>FACTORY_GIT_PATH</key><string>${xml(gitPath)}</string></dict>
<key>RunAtLoad</key><true/><key>StartInterval</key><integer>60</integer>
<key>ProcessType</key><string>Background</string>
<key>StandardOutPath</key><string>/dev/null</string>
<key>StandardErrorPath</key><string>/dev/null</string>
</dict></plist>
`;
      const file = this.launchAgentPath();
      const previous = await readFile(file, "utf8").catch((error) => { if (error.code === "ENOENT") return undefined; throw error; });
      await atomicWrite(file, plist);
      const domain = `gui/${this.uid}`;
      try {
        await this.execute("launchctl", ["bootout", `${domain}/${launchLabel}`], { allowExitCodes: [0, 3, 113] });
        await this.execute("launchctl", ["bootstrap", domain, file]);
        await this.execute("launchctl", ["kickstart", "-k", `${domain}/${launchLabel}`]);
      } catch (error) {
        await this.execute("launchctl", ["bootout", `${domain}/${launchLabel}`], { allowExitCodes: [0, 3, 113] }).catch(() => {});
        if (previous === undefined) await rm(file, { force: true }); else await atomicWrite(file, previous);
        if (previous !== undefined) await this.execute("launchctl", ["bootstrap", domain, file], { allowExitCodes: [0, 5] }).catch(() => {});
        throw error;
      }
      return { enabled: true, scheduler: "launchd", file };
    }
    if (this.platform === "linux") {
      const directory = this.systemdDirectory();
      const gitPath = await this.gitPath();
      const service = path.join(directory, `${systemdName}.service`);
      const timer = path.join(directory, `${systemdName}.timer`);
      const previousService = await readFile(service, "utf8").catch((error) => { if (error.code === "ENOENT") return undefined; throw error; });
      const previousTimer = await readFile(timer, "utf8").catch((error) => { if (error.code === "ENOENT") return undefined; throw error; });
      const previousEnabled = previousTimer !== undefined && (await this.execute("systemctl", ["--user", "is-enabled", `${systemdName}.timer`], { allowExitCodes: [0, 1, 3, 4] })).code === 0;
      await atomicWrite(service, `[Unit]\nDescription=Factory AI workspace synchronization\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=oneshot\nExecStart=${unitArgument(this.nodePath)} ${unitArgument(this.cliPath)} sync run\nEnvironment=${unitArgument(`PATH=${this.pathValue}`)}\nEnvironment=${unitArgument(`FACTORY_GIT_PATH=${gitPath}`)}\nStandardOutput=null\n`);
      await atomicWrite(timer, `[Unit]\nDescription=Run Factory AI workspace synchronization\n\n[Timer]\nOnBootSec=30s\nOnUnitActiveSec=60s\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n`);
      try {
        await this.execute("systemctl", ["--user", "daemon-reload"]);
        await this.execute("systemctl", ["--user", "enable", "--now", `${systemdName}.timer`]);
      } catch (error) {
        await this.execute("systemctl", ["--user", "disable", "--now", `${systemdName}.timer`], { allowExitCodes: [0, 1, 5] }).catch(() => {});
        if (previousService === undefined) await rm(service, { force: true }); else await atomicWrite(service, previousService);
        if (previousTimer === undefined) await rm(timer, { force: true }); else await atomicWrite(timer, previousTimer);
        await this.execute("systemctl", ["--user", "daemon-reload"], { allowExitCodes: [0, 1] }).catch(() => {});
        if (previousEnabled) await this.execute("systemctl", ["--user", "enable", "--now", `${systemdName}.timer`], { allowExitCodes: [0, 1] }).catch(() => {});
        throw error;
      }
      return { enabled: true, scheduler: "systemd", file: timer };
    }
    throw new Error(`Automatic workspace sync is unsupported on ${this.platform}`);
  }

  async disable() {
    if (this.platform === "darwin") {
      const domain = `gui/${this.uid}`;
      await this.execute("launchctl", ["bootout", `${domain}/${launchLabel}`], { allowExitCodes: [0, 3, 113] });
      await rm(this.launchAgentPath(), { force: true });
      return { enabled: false, scheduler: "launchd" };
    }
    if (this.platform === "linux") {
      await this.execute("systemctl", ["--user", "disable", "--now", `${systemdName}.timer`], { allowExitCodes: [0, 1, 5] });
      await rm(path.join(this.systemdDirectory(), `${systemdName}.service`), { force: true });
      await rm(path.join(this.systemdDirectory(), `${systemdName}.timer`), { force: true });
      await this.execute("systemctl", ["--user", "daemon-reload"]);
      return { enabled: false, scheduler: "systemd" };
    }
    throw new Error(`Automatic workspace sync is unsupported on ${this.platform}`);
  }

  async status() {
    if (this.platform === "darwin") {
      const result = await this.execute("launchctl", ["print", `gui/${this.uid}/${launchLabel}`], { allowExitCodes: [0, 3, 113] });
      return { enabled: result.code === 0, scheduler: "launchd" };
    }
    if (this.platform === "linux") {
      const result = await this.execute("systemctl", ["--user", "is-enabled", `${systemdName}.timer`], { allowExitCodes: [0, 1, 3, 4] });
      return { enabled: result.code === 0, scheduler: "systemd" };
    }
    return { enabled: false, scheduler: "unsupported" };
  }
}
