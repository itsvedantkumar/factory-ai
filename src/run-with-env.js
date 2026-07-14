#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { parseEnvironmentFile } from "./environment-file.js";

const [file, command, ...args] = process.argv.slice(2);
if (!file || !command) throw new Error("Usage: run-with-env ENV_FILE COMMAND [ARGS...]");
const environment = { ...process.env, ...parseEnvironmentFile(await readFile(file, "utf8")) };
const child = spawn(command, args, { env: environment, stdio: "inherit", shell: false });
child.once("error", (error) => { throw error; });
child.once("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
