#!/usr/bin/env node
import { DefaultAzureCredential } from "@azure/identity";
import { BlobServiceClient } from "@azure/storage-blob";
import { createDecipheriv } from "node:crypto";

const [account, blob, encodedKey, encodedIV, encodedTag, format] = process.argv.slice(2);
if (!/^[a-z0-9]{3,24}$/.test(account ?? "") || !/^agent-diffs\/[a-f0-9-]{36}\.bin$/.test(blob ?? "") || !/^[A-Za-z0-9_-]+$/.test(encodedKey ?? "") || !/^[A-Za-z0-9_-]+$/.test(encodedIV ?? "") || !/^[A-Za-z0-9_-]+$/.test(encodedTag ?? "")) throw new Error("Invalid agent diff reference");
const client = new BlobServiceClient(`https://${account}.blob.core.windows.net`, new DefaultAzureCredential());
const blobClient = client.getContainerClient("operator").getBlockBlobClient(blob);
let result;
const response = await blobClient.download();
if ((response.contentLength ?? 0) > 600_000) throw new Error("Agent diff exceeds the download limit");
const chunks = [];
for await (const chunk of response.readableStreamBody) chunks.push(chunk);
const decipher = createDecipheriv("aes-256-gcm", Buffer.from(encodedKey, "base64url"), Buffer.from(encodedIV, "base64url"));
decipher.setAuthTag(Buffer.from(encodedTag, "base64url"));
result = JSON.parse(Buffer.concat([decipher.update(Buffer.concat(chunks)), decipher.final()]).toString("utf8"));
if (format === "--json") process.stdout.write(`${JSON.stringify(result)}\n`);
else process.stdout.write(`${result.patch}\n`);
