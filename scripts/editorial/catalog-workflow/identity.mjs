import { createHash } from "node:crypto";
import { URL } from "node:url";

export class WorkflowError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

export const fail = (code) => {
  throw new WorkflowError(code);
};
const object = (value) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;
const sha = (value) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const id = (value) =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
const positive = (value) => Number.isSafeInteger(value) && value > 0;

function canonical(value, ancestors = new Set()) {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if ((!object(value) && !Array.isArray(value)) || ancestors.has(value))
    fail("NON_JSON_INPUT");
  const next = new Set(ancestors).add(value);
  return Array.isArray(value)
    ? Array.from(value, (item) => canonical(item, next))
    : Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((key) => [key, canonical(value[key], next)]),
      );
}

export const digest = (value) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");

function exactKeys(value, allowed) {
  if (
    !object(value) ||
    Object.keys(value).some((key) => !allowed.includes(key))
  )
    fail("MANIFEST_INVALID");
}

export function validateManifest(manifest) {
  exactKeys(manifest, ["version", "batchId", "target", "records"]);
  if (manifest.version !== 1 || !id(manifest.batchId)) fail("MANIFEST_INVALID");
  exactKeys(manifest.target, ["instance", "origin", "actorId", "role"]);
  const target = manifest.target;
  if (
    !["development", "production"].includes(target.instance) ||
    !positive(target.actorId) ||
    !["owner", "automation"].includes(target.role)
  )
    fail("TARGET_INVALID");
  let origin;
  try {
    origin = new URL(target.origin);
  } catch {
    fail("TARGET_INVALID");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(
    origin.hostname,
  );
  if (
    origin.origin !== target.origin ||
    origin.username ||
    origin.password ||
    (target.instance === "production"
      ? origin.protocol !== "https:" || loopback
      : !loopback || !["http:", "https:"].includes(origin.protocol))
  )
    fail("TARGET_INVALID");
  if (!Array.isArray(manifest.records) || manifest.records.length === 0)
    fail("MANIFEST_INVALID");
  const records = new Set();
  const identities = new Set();
  const mediaIds = new Set();
  for (const record of manifest.records) {
    exactKeys(record, [
      "recordId",
      "catalogId",
      "sourceId",
      "contentSha256",
      "disposition",
      "reuseOnly",
      "protections",
      "media",
    ]);
    if (
      !id(record.recordId) ||
      !id(record.catalogId) ||
      !id(record.sourceId) ||
      record.catalogId === record.sourceId ||
      records.has(record.recordId) ||
      identities.has(record.catalogId) ||
      identities.has(record.sourceId) ||
      !sha(record.contentSha256) ||
      !["draft", "publish", "hold"].includes(record.disposition) ||
      typeof record.reuseOnly !== "boolean"
    )
      fail("MANIFEST_INVALID");
    records.add(record.recordId);
    identities.add(record.catalogId);
    identities.add(record.sourceId);
    exactKeys(record.protections, [
      "rightsHold",
      "explicitlyHidden",
      "withdrawn",
    ]);
    if (
      ["rightsHold", "explicitlyHidden", "withdrawn"].some(
        (key) => typeof record.protections[key] !== "boolean",
      ) ||
      !Array.isArray(record.media) ||
      record.media.length === 0
    )
      fail("MANIFEST_INVALID");
    for (const [index, media] of record.media.entries()) {
      exactKeys(media, [
        "mediaId",
        "sourceSha256",
        "uploadedSha256",
        "bytes",
        "width",
        "height",
        "position",
        "isRepresentative",
      ]);
      if (
        !id(media.mediaId) ||
        mediaIds.has(media.mediaId) ||
        !sha(media.sourceSha256) ||
        !sha(media.uploadedSha256) ||
        !positive(media.bytes) ||
        !positive(media.width) ||
        !positive(media.height) ||
        !Number.isSafeInteger(media.position) ||
        media.position < 0 ||
        (index > 0 && record.media[index - 1].position >= media.position) ||
        typeof media.isRepresentative !== "boolean"
      )
        fail("MANIFEST_INVALID");
      mediaIds.add(media.mediaId);
    }
    if (record.media.filter((media) => media.isRepresentative).length !== 1)
      fail("MANIFEST_INVALID");
  }
  return manifest;
}

// The verified account and exact selected Catalog scope bind a resume. A token
// refresh is deliberately not part of this identity and never relaxes scope.
export function targetIdentity(manifest) {
  validateManifest(manifest);
  return digest({
    ...manifest.target,
    catalogIds: manifest.records.map((row) => row.catalogId).sort(),
  });
}

export function verifyPrincipal(manifest, actual) {
  validateManifest(manifest);
  if (
    !object(actual) ||
    actual.instance !== manifest.target.instance ||
    actual.origin !== manifest.target.origin ||
    actual.actorId !== manifest.target.actorId ||
    actual.role !== manifest.target.role ||
    actual.verified !== true ||
    !Array.isArray(actual.scopeCatalogIds) ||
    manifest.records.some(
      (row) => !actual.scopeCatalogIds.includes(row.catalogId),
    )
  )
    fail("PRINCIPAL_OR_SCOPE_CHANGED");
  return targetIdentity(manifest);
}
