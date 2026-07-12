#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

function parts(value) {
  if (!/^\d+\.\d+\.\d+$/.test(value)) throw new Error(`Unsupported version: ${value}`);
  return value.split(".").map(Number);
}

export function compareVersions(left, right) {
  const a = parts(left);
  const b = parts(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

export function shouldAutoUpdate(current, latest) {
  const currentParts = parts(current);
  const latestParts = parts(latest);
  return currentParts[0] === latestParts[0] && compareVersions(latest, current) > 0;
}

async function main() {
  const packageFile = process.env.FACTORY_PACKAGE_FILE ?? "/opt/agent-factory/app/package.json";
  const current = JSON.parse(await readFile(packageFile, "utf8")).version;
  const response = await fetch("https://registry.npmjs.org/factory-ai/latest", { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`npm registry HTTP ${response.status}`);
  const latestPackage = await response.json();
  process.stdout.write(`${JSON.stringify({
    current,
    latest: latestPackage.version,
    gitHead: latestPackage.gitHead,
    updateAvailable: shouldAutoUpdate(current, latestPackage.version),
  })}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
