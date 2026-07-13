import { createHash, timingSafeEqual, verify as verifySignature } from "node:crypto";
import { isIP } from "node:net";
import { z } from "zod";
import { ROLES } from "./routing.js";

const identifier = z.string().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
const semanticVersion = z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);

function unique(values) {
  return new Set(values).size === values.length;
}

const uniqueIdentifiers = z.array(identifier).max(64).refine(unique, "Values must be unique");
const networkDestination = z.string().max(2048).url().refine((value) => {
  const parsed = new URL(value);
  const hostname = parsed.hostname.toLowerCase();
  const publicDnsName = hostname.includes(".")
    && isIP(hostname) === 0
    && /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(hostname)
    && !hostname.split(".").some((label) => label.length === 0 || label.length > 63 || label.startsWith("-") || label.endsWith("-"))
    && !hostname.endsWith(".local")
    && !hostname.endsWith(".internal");
  return parsed.protocol === "https:"
    && parsed.username === ""
    && parsed.password === ""
    && parsed.origin === value
    && publicDnsName;
}, "Network destinations must be explicit public HTTPS origins");

const unsignedManifestSchema = z.object({
  name: identifier,
  version: semanticVersion,
  digest,
  roles: z.array(z.enum(ROLES)).min(1).max(ROLES.length).refine(unique, "Roles must be unique"),
  tools: uniqueIdentifiers,
  networkDestinations: z.array(networkDestination).max(32).refine(unique, "Network destinations must be unique"),
  requiredSecrets: uniqueIdentifiers,
}).strict();

const signatureSchema = z.object({
  algorithm: z.literal("ed25519"),
  keyId: identifier,
  value: z.string().min(1).max(256).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
}).strict();

const manifestSchema = unsignedManifestSchema.extend({ signature: signatureSchema }).strict();

export function extensionManifestPayload(value) {
  const manifest = unsignedManifestSchema.parse(value);
  return Buffer.from(JSON.stringify(manifest), "utf8");
}

export function validateExtensionManifest(value) {
  return manifestSchema.parse(value);
}

export function verifyExtensionManifest(value, { publicKey, artifact } = {}) {
  const manifest = validateExtensionManifest(value);
  if (!publicKey) throw new Error("Extension public key is required");
  if (!Buffer.isBuffer(artifact) && !(artifact instanceof Uint8Array)) throw new Error("Extension artifact bytes are required");

  const { signature, ...unsigned } = manifest;
  let signatureValid = false;
  try {
    signatureValid = verifySignature(null, extensionManifestPayload(unsigned), publicKey, Buffer.from(signature.value, "base64"));
  } catch {
    signatureValid = false;
  }
  if (!signatureValid) throw new Error("Extension signature is invalid");

  const expectedDigest = Buffer.from(manifest.digest.slice("sha256:".length), "hex");
  const actualDigest = createHash("sha256").update(artifact).digest();
  if (!timingSafeEqual(expectedDigest, actualDigest)) throw new Error("Extension artifact digest does not match manifest");
  return manifest;
}
