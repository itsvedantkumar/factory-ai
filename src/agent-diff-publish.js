#!/usr/bin/env node
import { inspectAgentDiff } from "./agent-inspect.js";
import { loadConfig } from "./config.js";
import { uploadOperatorBlob } from "./reporter.js";
import { createCipheriv, randomBytes, randomUUID } from "node:crypto";

const [objectiveId, taskId] = process.argv.slice(2);
const config = loadConfig();
const result = await inspectAgentDiff({ workspaceRoot: config.workspaceDir, objectiveId, taskId });
const key = randomBytes(32);
const iv = randomBytes(12);
const cipher = createCipheriv("aes-256-gcm", key, iv);
const encrypted = Buffer.concat([cipher.update(JSON.stringify(result)), cipher.final()]);
const tag = cipher.getAuthTag();
const blob = `agent-diffs/${randomUUID()}.bin`;
if (!(await uploadOperatorBlob(config, blob, encrypted, "application/octet-stream"))) throw new Error("Operator Blob storage is unavailable");
process.stdout.write(`${JSON.stringify({ blob, key: key.toString("base64url"), iv: iv.toString("base64url"), tag: tag.toString("base64url"), bytes: encrypted.length })}\n`);
