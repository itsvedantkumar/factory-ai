import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { run } from "./process.js";

async function defaultCheckout(message) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-release-"));
  await run("git", ["clone", "--branch", message.branch, "--single-branch", message.objective.repository, directory], { timeoutMs: 300_000 });
  return directory;
}

export class ReleaseBot {
  constructor({ checkout = defaultCheckout, publisher, sendControl, cleanup = (directory) => rm(directory, { recursive: true, force: true }) }) {
    this.checkout = checkout;
    this.publisher = publisher;
    this.sendControl = sendControl;
    this.cleanup = cleanup;
  }

  async process(message) {
    if (message?.type !== "publish_request") throw new Error(`Unsupported release message: ${message?.type}`);
    const directory = await this.checkout(message);
    try {
      const release = await this.publisher.publish({
        directory,
        objective: message.objective,
        task: { title: message.objective.objective },
        branch: message.branch,
        results: message.results,
      });
      await this.sendControl({ type: "release_result", objectiveId: message.objectiveId, release });
    } finally {
      await this.cleanup(directory);
    }
  }
}
