#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "./config.js";
import { createBus, sendMessage } from "./bus.js";
import { parseObjective } from "./validation.js";

function argumentsFrom(argv) {
  const options = { baseBranch: "main", wait: false, timeoutMs: 3_600_000, words: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--repo") options.repository = argv[++index];
    else if (value === "--base") options.baseBranch = argv[++index];
    else if (value === "--wait") options.wait = true;
    else if (value === "--timeout-ms") options.timeoutMs = Number(argv[++index]);
    else if (value.startsWith("--")) throw new Error(`Unknown option: ${value}`);
    else options.words.push(value);
  }
  if (!options.repository || options.words.length === 0) {
    throw new Error('Usage: agent-factory-ceo --repo <https-url> [--base main] [--wait] "objective"');
  }
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1000 || options.timeoutMs > 86_400_000) {
    throw new Error("--timeout-ms must be between 1000 and 86400000");
  }
  return options;
}

async function waitForResult(file, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await readFile(file, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`Timed out waiting for result after ${timeoutMs}ms`);
}

try {
  const options = argumentsFrom(process.argv.slice(2));
  const config = loadConfig();
  const objective = parseObjective({
    id: randomUUID(),
    type: "objective",
    objective: options.words.join(" "),
    repository: options.repository,
    baseBranch: options.baseBranch,
    createdAt: new Date().toISOString(),
  });
  const bus = createBus(config, config.controlQueue, config.controlQueue);
  await sendMessage(bus.sender, objective, objective.id);
  await bus.sender.close();
  await bus.receiver.close();
  await bus.client.close();
  if (options.wait) {
    const result = await waitForResult(path.join(config.stateDir, objective.id, "result.json"), options.timeoutMs);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`${JSON.stringify({ objectiveId: objective.id, status: "queued" })}\n`);
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
