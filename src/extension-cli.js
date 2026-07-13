#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { verifyExtensionManifest } from "./extension-manifest.js";

const [manifestFile, artifactFile, publicKeyFile] = process.argv.slice(2);
if (!manifestFile || !artifactFile || !publicKeyFile) throw new Error("Usage: factory extension verify MANIFEST ARTIFACT PUBLIC_KEY");
const manifest = verifyExtensionManifest(JSON.parse(await readFile(manifestFile, "utf8")), {
  artifact: await readFile(artifactFile),
  publicKey: await readFile(publicKeyFile, "utf8"),
});
process.stdout.write(`${JSON.stringify({ name: manifest.name, version: manifest.version, digest: manifest.digest, verified: true })}\n`);
