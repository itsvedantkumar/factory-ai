import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import {
  extensionManifestPayload,
  validateExtensionManifest,
  verifyExtensionManifest,
} from "../src/extension-manifest.js";

const artifact = Buffer.from("immutable extension artifact");
const digest = "sha256:f38e3f569bfa407318497bd7aa5aecad67365c04eeef091f7f6661f24bd92c80";

function signedManifest(overrides = {}) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const unsigned = {
    name: "source-search",
    version: "1.2.3",
    digest,
    roles: ["scout", "builder"],
    tools: ["source_search"],
    networkDestinations: ["https://api.example.com"],
    requiredSecrets: ["SEARCH_API_TOKEN"],
    ...overrides,
  };
  const signature = sign(null, extensionManifestPayload(unsigned), privateKey).toString("base64");
  return { manifest: { ...unsigned, signature: { algorithm: "ed25519", keyId: "factory-root-1", value: signature } }, publicKey };
}

test("activates a strict signed manifest with a matching immutable digest", () => {
  const { manifest, publicKey } = signedManifest();
  assert.deepEqual(verifyExtensionManifest(manifest, { publicKey, artifact }), manifest);
});

test("rejects invalid signatures and artifact digest mismatches", () => {
  const { manifest, publicKey } = signedManifest();
  assert.throws(() => verifyExtensionManifest({ ...manifest, version: "1.2.4" }, { publicKey, artifact }), /signature/);
  assert.throws(() => verifyExtensionManifest(manifest, { publicKey, artifact: Buffer.from("changed") }), /digest/);
  assert.throws(() => verifyExtensionManifest(manifest, { publicKey }), /artifact/);
});

test("requires exact sha256 digests, known roles, and identifier-only tools and secrets", () => {
  const base = signedManifest().manifest;
  for (const digestValue of ["latest", "sha256:abc", `sha256:${"A".repeat(64)}`]) {
    assert.throws(() => validateExtensionManifest({ ...base, digest: digestValue }));
  }
  assert.throws(() => validateExtensionManifest({ ...base, roles: ["administrator"] }));
  assert.throws(() => validateExtensionManifest({ ...base, tools: ["sh -c anything"] }));
  assert.throws(() => validateExtensionManifest({ ...base, requiredSecrets: ["TOKEN=value"] }));
  assert.throws(() => validateExtensionManifest({ ...base, roles: ["scout", "scout"] }), /unique/);
});

test("allows only explicit public HTTPS origins as network destinations", () => {
  const base = signedManifest().manifest;
  for (const destination of [
    "http://api.example.com",
    "https://*.example.com",
    "https://localhost",
    "https://127.0.0.1",
    "https://169.254.169.254",
    "https://api.example.com/path",
    "unix:///var/run/docker.sock",
  ]) {
    assert.throws(() => validateExtensionManifest({ ...base, networkDestinations: [destination] }));
  }
});

test("rejects Docker socket, host mounts, arbitrary environment, and commands", () => {
  const base = signedManifest().manifest;
  for (const extra of [
    { mounts: ["/var/run/docker.sock:/var/run/docker.sock"] },
    { hostMounts: ["/tmp:/workspace"] },
    { environment: { PATH: "/tmp/bin" } },
    { env: ["TOKEN"] },
    { command: ["/bin/sh", "-c", "anything"] },
  ]) {
    assert.throws(() => validateExtensionManifest({ ...base, ...extra }));
  }
});
