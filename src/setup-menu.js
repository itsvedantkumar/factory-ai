#!/usr/bin/env node
import { readSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { validateModelRoute } from "./routing.js";

const output = process.argv[2];
if (!output) throw new Error("Setup result path is required");
const stateFile = process.argv[3];
const reset = process.argv.includes("--reset");
const forceDeploy = process.argv.includes("--deploy");

async function atomicJson(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}

function validateChoices(choices) {
  if (typeof choices.factoryName !== "string" || choices.factoryName.length < 1 || choices.factoryName.length > 80) throw new Error("Saved factory name is invalid; run `factory setup --reset`");
  if (typeof choices.factoryPurpose !== "string" || choices.factoryPurpose.length < 1 || choices.factoryPurpose.length > 500) throw new Error("Saved factory purpose is invalid; run `factory setup --reset`");
  if (!["azure", "bedrock", "both"].includes(choices.provider)) throw new Error("Saved provider is invalid; run `factory setup --reset`");
  if (!/^[a-z0-9-]{2,50}$/.test(choices.location ?? "")) throw new Error("Saved Azure region is invalid; run `factory setup --reset`");
  if (choices.provider !== "azure") validateModelRoute(`bedrock/${choices.bedrockBuilderModel}`);
  return choices;
}

if (stateFile && !reset) {
  try {
    const state = JSON.parse(await readFile(stateFile, "utf8"));
    if (state.version === 1 && state.onboardingComplete === true && state.choices?.factoryName && state.choices?.factoryPurpose && state.choices?.provider) {
      const choices = validateChoices(forceDeploy ? { ...state.choices, deployNow: true } : state.choices);
      await atomicJson(output, choices);
      if (forceDeploy) await atomicJson(stateFile, { ...state, choices, updatedAt: new Date().toISOString() });
      process.stdout.write("Reusing saved onboarding answers. Use `factory setup --reset` to change them.\n");
      process.exit(0);
    }
  } catch (error) { if (error.code !== "ENOENT") throw error; }
}

function readLine(message) {
  process.stdout.write(message);
  const bytes = [];
  const buffer = Buffer.alloc(1);
  while (true) {
    const count = readSync(0, buffer, 0, 1, null);
    if (count === 0) throw new Error(`Input closed while answering: ${message.trim()}`);
    if (buffer[0] === 0x0a) break;
    if (buffer[0] !== 0x0d) bytes.push(buffer[0]);
    if (bytes.length > 2000) throw new Error(`Answer is too long: ${message.trim()}`);
  }
  return Buffer.from(bytes).toString("utf8");
}

async function ask(message, defaultValue = "", maxLength = 500) {
  const answer = readLine(`${message}${defaultValue ? ` [${defaultValue}]` : ""}: `).trim() || defaultValue;
  if (!answer || answer.length > maxLength || /[\r\n\0]/.test(answer)) throw new Error(`Invalid answer for: ${message}`);
  return answer;
}

async function optional(message) {
  const answer = readLine(`${message}: `).trim();
  if (answer.length > 200 || /[\r\n\0]/.test(answer)) throw new Error(`Invalid answer for: ${message}`);
  return answer;
}

async function confirm(message, defaultValue) {
  const hint = defaultValue ? "Y/n" : "y/N";
  const answer = (await optional(`${message} [${hint}]`)).toLowerCase();
  if (answer === "") return defaultValue;
  if (["y", "yes"].includes(answer)) return true;
  if (["n", "no"].includes(answer)) return false;
  throw new Error(`Enter yes or no for: ${message}`);
}

const factoryName = await ask("What should your factory be called?", "Factory AI", 80);
const factoryPurpose = await ask("What should this factory build or optimize for?", "Ship secure reviewed software continuously");
process.stdout.write("Which model provider should the factory configure?\n  1) Azure AI Foundry (recommended)\n  2) AWS Bedrock\n  3) Azure + Bedrock\n");
const providerChoice = await ask("Provider", "1");
const provider = { "1": "azure", "2": "bedrock", "3": "both" }[providerChoice];
if (!provider) throw new Error("Provider must be 1, 2, or 3");
const location = await ask("Azure infrastructure region", "centralindia");
if (!/^[a-z0-9-]{2,50}$/.test(location)) throw new Error("Azure infrastructure region must use lowercase letters, numbers, or dashes");
const githubOrg = await optional("GitHub Enterprise organization (optional; Enter for personal repos)");
if (githubOrg && !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(githubOrg)) throw new Error("Invalid GitHub organization name");
let awsRegion = "us-east-1";
let bedrockBuilderModel = "";
if (provider !== "azure") {
  awsRegion = await ask("AWS Bedrock region", "us-east-1");
  if (!/^[a-z]{2}(?:-gov)?-[a-z0-9-]+-\d$/.test(awsRegion)) throw new Error("Invalid AWS region");
  bedrockBuilderModel = await ask("Bedrock builder model ID", "us.anthropic.claude-sonnet-4-6-v1:0");
  validateModelRoute(`bedrock/${bedrockBuilderModel}`);
}
const deployNow = forceDeploy || await confirm("Deploy and start the runtime after storing credentials?", true);
const telegram = await confirm("Enable Telegram remote objective intake?", false);

const choices = { factoryName, factoryPurpose, provider, location, githubOrg, awsRegion, bedrockBuilderModel, deployNow, telegram };
validateChoices(choices);
await atomicJson(output, choices);
if (stateFile) await atomicJson(stateFile, { version: 1, onboardingComplete: true, phase: "onboarding", updatedAt: new Date().toISOString(), choices });
