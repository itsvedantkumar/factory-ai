#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const ignoredWrapperFlags = new Set(["--passWithNoTests", "--no-coverage"]);
const args = process.argv.slice(2).filter((argument) => !ignoredWrapperFlags.has(argument));
const result = spawnSync(process.execPath, ["--test", ...args], { stdio: "inherit" });
process.exitCode = result.status ?? 1;
