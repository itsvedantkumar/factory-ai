#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { DefaultAzureCredential } from "@azure/identity";
import { ServiceBusClient } from "@azure/service-bus";
import { sendMessage } from "./bus.js";
import { loadRepositoryInstructions } from "./instructions.js";
import { routePrompt } from "./prompt-routing.js";
import { submissionId } from "./submission-id.js";
import { parseObjective, parseQuickAction } from "./validation.js";
import { WorkspaceCatalog } from "./workspace-catalog.js";

const [reference, ...words] = process.argv.slice(2);
if (!reference || words.length === 0) throw new Error("Usage: factory prompt WORKSPACE text");
const workspace = await new WorkspaceCatalog().resolve(reference);
const routed = routePrompt(words.join(" "));
const workspaceContext = workspace.localPath ? await loadRepositoryInstructions(workspace.localPath, { maxCharacters: 16_000 }) : "";
const createdAt = new Date().toISOString();
const message = routed.kind === "objective"
  ? parseObjective({ id: submissionId(workspace.repository, routed.text), type: "objective", objective: routed.text, repository: workspace.url, baseBranch: workspace.baseBranch, ...(workspaceContext ? { workspaceContext } : {}), createdAt })
  : parseQuickAction({ id: `action-${randomUUID()}`, type: "quick_action", kind: "prompt", prompt: routed.text, workspace: workspace.name, repository: workspace.url, baseBranch: workspace.baseBranch, createdAt });
const namespace = process.env.SERVICE_BUS_NAMESPACE;
if (!namespace) throw new Error("SERVICE_BUS_NAMESPACE is required");
const client = new ServiceBusClient(namespace.includes(".") ? namespace : `${namespace}.servicebus.windows.net`, new DefaultAzureCredential());
const sender = client.createSender(process.env.CONTROL_QUEUE ?? "control-events");
try { await sendMessage(sender, message, message.id); } finally { await sender.close(); await client.close(); }
process.stdout.write(`${JSON.stringify({ kind: routed.kind, id: message.id, workspace: workspace.name, status: "queued", reason: routed.reason })}\n`);
