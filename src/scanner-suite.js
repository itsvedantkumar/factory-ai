import path from "node:path";
import { run } from "./process.js";

const scanners = [
  {
    name: "trivy",
    image: "aquasec/trivy@sha256:cffe3f5161a47a6823fbd23d985795b3ed72a4c806da4c4df16266c02accdd6f",
    args: ["fs", "--scanners", "vuln,secret,misconfig", "--severity", "HIGH,CRITICAL", "--exit-code", "1", "--format", "table", "/workspace"],
  },
  {
    name: "gitleaks",
    image: "zricethezav/gitleaks@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f",
    args: ["detect", "--source", "/workspace", "--redact", "--no-banner", "--exit-code", "1"],
  },
  {
    name: "osv-scanner",
    image: "ghcr.io/google/osv-scanner@sha256:f7ba4be68bac8086b1f88fd598fdca1ca67239c79ad2c2b5c78e03a82e5187c4",
    args: ["scan", "--recursive", "/workspace", "--format", "json"],
  },
  {
    name: "semgrep",
    image: "semgrep/semgrep@sha256:183a149fb3e9700ab5294a7b4ab0241a826fd046bc8b721062fbea80fdfa438f",
    args: ["semgrep", "scan", "--config", "p/default", "--json", "/workspace"],
  },
];

function redact(value) {
  return String(value)
    .replaceAll(/\u001b\[[0-9;]*m/g, "")
    .replaceAll(/((?:api[_-]?key|token|secret|password)\s*[=:]\s*)\S+/gi, "$1[REDACTED]")
    .replaceAll(/\b[A-Za-z0-9+/_=-]{48,}\b/g, "[REDACTED]")
    .slice(-6000);
}

export class ScannerSuite {
  constructor({ execute = run } = {}) {
    this.execute = execute;
  }

  async scan(directory) {
    const workspace = path.resolve(directory);
    return Promise.all(scanners.map(async (scanner) => {
      const args = [
        "run", "--rm", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
        "--pids-limit", "512", "--memory", "4g", "--cpus", "1", "--tmpfs", "/tmp:rw,noexec,nosuid,size=3g",
        "--env", "HOME=/tmp",
        "--volume", `${workspace}:/workspace:ro`, scanner.image, ...scanner.args,
      ];
      try {
        const result = await this.execute("docker", args, { timeoutMs: 600_000, maxOutputBytes: 4_000_000, allowExitCodes: [0, 1, 2] });
        const output = redact(`${result.stdout}\n${result.stderr}`);
        const executionError = /(?:FATAL|Traceback|read-only file system|no space left on device)/i.test(output);
        return { scanner: scanner.name, status: executionError || result.code === 2 ? "error" : result.code === 1 ? "findings" : "passed", output };
      } catch (error) {
        return { scanner: scanner.name, status: "error", output: redact(error.message) };
      }
    }));
  }
}
