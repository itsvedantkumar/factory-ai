#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { DefaultAzureCredential } from "@azure/identity";
import { ServiceBusClient } from "@azure/service-bus";
import { sendMessage } from "./bus.js";
import { parseObjective } from "./validation.js";
import { WorkspaceCatalog } from "./workspace-catalog.js";
import { loadRepositoryInstructions } from "./instructions.js";

const [reference, ...words] = process.argv.slice(2);
if (!reference || words.length === 0) throw new Error("Usage: factory submit WORKSPACE objective");
const workspace = await new WorkspaceCatalog().resolve(reference);
const workspaceContext = workspace.localPath ? await loadRepositoryInstructions(workspace.localPath, { maxCharacters: 16_000 }) : "";
const objective = parseObjective({ id: randomUUID(), type: "objective", objective: words.join(" "), repository: workspace.url, baseBranch: workspace.baseBranch, ...(workspaceContext ? { workspaceContext } : {}), createdAt: new Date().toISOString() });
const namespace = process.env.SERVICE_BUS_NAMESPACE;
if (!namespace) throw new Error("SERVICE_BUS_NAMESPACE is required");
const client = new ServiceBusClient(namespace.includes(".") ? namespace : `${namespace}.servicebus.windows.net`, new DefaultAzureCredential());
const sender = client.createSender(process.env.CONTROL_QUEUE ?? "control-events");
try { await sendMessage(sender, objective, objective.id); } finally { await sender.close(); await client.close(); }
process.stdout.write(`${JSON.stringify({ objectiveId: objective.id, workspace: workspace.name, repository: workspace.repository, status: "queued" })}\n`);
