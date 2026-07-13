#!/usr/bin/env node
import { DefaultAzureCredential } from "@azure/identity";
import { ServiceBusClient } from "@azure/service-bus";
import { sendMessage } from "./bus.js";

const [action, objectiveId, approvalId, ...reasonWords] = process.argv.slice(2);
const decision = action === "approve" ? "approved" : action === "deny" ? "denied" : null;
const reason = reasonWords.join(" ").trim();
if (!decision || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(objectiveId ?? "") || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(approvalId ?? "") || !reason) throw new Error("Usage: factory approval approve|deny OBJECTIVE_ID APPROVAL_ID REASON");
const namespace = process.env.SERVICE_BUS_NAMESPACE;
if (!namespace) throw new Error("SERVICE_BUS_NAMESPACE is required");
const client = new ServiceBusClient(namespace.includes(".") ? namespace : `${namespace}.servicebus.windows.net`, new DefaultAzureCredential());
const sender = client.createSender(process.env.CONTROL_QUEUE ?? "control-events");
const messageId = `approval-${objectiveId}-${approvalId}-${decision}`.slice(0, 64);
try { await sendMessage(sender, { type: "approval_decision", objectiveId, approvalId, decision, actor: "local-operator", reason: reason.slice(0, 1000), decidedAt: new Date().toISOString(), messageId }, messageId, objectiveId); }
finally { await sender.close(); await client.close(); }
process.stdout.write(`${JSON.stringify({ objectiveId, approvalId, decision })}\n`);
