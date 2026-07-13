#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { DefaultAzureCredential } from "@azure/identity";
import { ServiceBusClient } from "@azure/service-bus";
import { translateAcpObjective } from "./acp-adapter.js";
import { sendMessage } from "./bus.js";

const file = process.argv[2];
if (!file) throw new Error("ACP request JSON file is required");
const objective = translateAcpObjective(JSON.parse(await readFile(file, "utf8")), { enabled: process.env.FACTORY_ACP_ENABLED === "true" });
const namespace = process.env.SERVICE_BUS_NAMESPACE;
if (!namespace) throw new Error("SERVICE_BUS_NAMESPACE is required");
const client = new ServiceBusClient(namespace.includes(".") ? namespace : `${namespace}.servicebus.windows.net`, new DefaultAzureCredential());
const sender = client.createSender(process.env.CONTROL_QUEUE ?? "control-events");
try { await sendMessage(sender, objective, objective.id); } finally { await sender.close(); await client.close(); }
process.stdout.write(`${JSON.stringify({ objectiveId: objective.id, status: "queued" })}\n`);
