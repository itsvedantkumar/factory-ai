import { run } from "./process.js";
import { evaluateReleaseGate } from "./release-gate.js";

export { evaluateReleaseGate } from "./release-gate.js";

export function requiredChecksPass(exitCode, checks) {
  if (checks.length === 0) return exitCode === 0 || exitCode === 1;
  return exitCode === 0 && checks.every((check) => ["pass", "skipping"].includes(check.bucket));
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export class GitHubRelease {
  constructor(timeoutMs, execute = run, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {
    this.timeoutMs = timeoutMs;
    this.execute = execute;
    this.sleep = sleep;
  }

  async requiredChecks(directory, branch) {
    const deadline = Date.now() + this.timeoutMs;
    let command;
    do {
      command = await this.execute("gh", [
        "pr", "checks", branch, "--required", "--json", "name,state,link,bucket",
      ], { cwd: directory, timeoutMs: 60_000, allowExitCodes: [0, 1, 8] });
      if (command.code !== 8 || Date.now() >= deadline) break;
      await this.sleep(Math.min(15_000, Math.max(0, deadline - Date.now())));
    } while (Date.now() < deadline);
    return command;
  }

  async publish({ directory, objective, task, branch, results }) {
    const commits = Object.entries(results)
      .filter(([, result]) => result.commit)
      .map(([id, result]) => `- ${id}: \`${result.commit}\` - ${result.summary}`)
      .join("\n");
    const body = [
      `Automated delivery for CEO objective \`${objective.id}\`.`,
      "",
      "## Validated checkpoints",
      commits || "- No prior checkpoints",
      "",
      "Human review and repository branch protections remain authoritative.",
    ].join("\n");
    const title = `[Agent Factory] ${task.title}`;
    const create = await this.execute("gh", [
      "pr", "create", "--base", objective.baseBranch, "--head", branch,
      "--title", title, "--body", body,
    ], { cwd: directory, timeoutMs: 120_000, allowExitCodes: [0, 1] });
    if (create.code !== 0) {
      await this.execute("gh", ["pr", "edit", branch, "--title", title, "--body", body], {
        cwd: directory,
        timeoutMs: 120_000,
      });
    }
    const view = await this.execute("gh", [
      "pr", "view", branch, "--json", "url,number,reviewDecision,mergeStateStatus",
    ], { cwd: directory, timeoutMs: 60_000 });
    const pullRequest = parseJson(view.stdout, {});
    const repository = await this.execute("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], {
      cwd: directory,
      timeoutMs: 60_000,
    });
    const policy = await this.execute("gh", ["api", `repos/${repository.stdout.trim()}`, "--jq", ".allow_auto_merge"], {
      cwd: directory,
      timeoutMs: 60_000,
    });
    const checksCommand = await this.requiredChecks(directory, branch);
    const checks = parseJson(checksCommand.stdout, []);
    const checksPass = requiredChecksPass(checksCommand.code, checks);
    const gate = evaluateReleaseGate([], {}, {
      approvals: true,
      policyAllows: policy.stdout.trim() === "true",
      checksPass,
    });
    if (gate.autoMerge) {
      await this.execute("gh", ["pr", "merge", branch, "--auto", "--merge"], {
        cwd: directory,
        timeoutMs: 60_000,
      });
    }
    return {
      url: pullRequest.url,
      number: pullRequest.number,
      checks,
      reviewDecision: pullRequest.reviewDecision,
      mergeStateStatus: pullRequest.mergeStateStatus,
      autoMergeEnabled: gate.autoMerge,
      blockers: [
        ...(gate.autoMerge || policy.stdout.trim() === "true" ? [] : ["Repository auto-merge policy is disabled"]),
        ...(checksPass ? [] : ["Required checks are pending or failing"]),
      ],
    };
  }
}
