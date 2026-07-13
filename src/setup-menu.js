#!/usr/bin/env node
import { confirm, input, select } from "@inquirer/prompts";
import { writeFile } from "node:fs/promises";

const output = process.argv[2];
if (!output) throw new Error("Setup result path is required");

const factoryName = await input({ message: "What should your factory be called?", default: "Factory AI" });
const factoryPurpose = await input({ message: "What should this factory build or optimize for?", default: "Ship secure, reviewed software continuously" });
const provider = await select({
  message: "Which model provider should the factory configure?",
  choices: [
    { name: "Azure AI Foundry (recommended)", value: "azure" },
    { name: "AWS Bedrock", value: "bedrock" },
    { name: "Azure + Bedrock", value: "both" },
  ],
});
const location = await input({ message: "Azure infrastructure region", default: "centralindia" });
const githubOrg = await input({ message: "GitHub Enterprise organization (optional; Enter for personal repos)", default: "" });
let awsRegion = "us-east-1";
let bedrockBuilderModel = "";
if (provider !== "azure") {
  awsRegion = await input({ message: "AWS Bedrock region", default: "us-east-1" });
  bedrockBuilderModel = await input({ message: "Bedrock builder model ID", default: "us.anthropic.claude-sonnet-4-6-v1:0" });
}
const deployNow = await confirm({ message: "Deploy and start the runtime after storing credentials?", default: true });
const telegram = await confirm({ message: "Enable Telegram remote objective intake?", default: false });
await writeFile(output, `${JSON.stringify({ factoryName, factoryPurpose, provider, location, githubOrg, awsRegion, bedrockBuilderModel, deployNow, telegram })}\n`, { mode: 0o600 });
