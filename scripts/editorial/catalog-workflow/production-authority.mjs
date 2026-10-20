import { CATALOG_DELIVERY_CONTRACT_SHA256 } from "./delivery-contract.mjs";
import { digest, fail, validateManifest } from "./identity.mjs";

const positive = (n) => Number.isSafeInteger(n) && n > 0;
export const PRODUCTION_COMMANDS = ["upload", "run", "publish", "withdraw"];

/** An execution authorization record, never a credential or a substitute for /users/me. */
export function normalizeProductionAuthority(
  manifest,
  value,
  now = Date.now(),
) {
  validateManifest(manifest);
  const record = manifest.records[0];
  if (
    manifest.target.instance !== "production" ||
    manifest.records.length !== 1 ||
    value?.version !== 1 ||
    value.kind !== "production-native" ||
    value.origin !== manifest.target.origin ||
    value.actorId !== manifest.target.actorId ||
    value.role !== manifest.target.role ||
    value.manifestSha256 !== digest(manifest) ||
    !/^[a-f0-9]{64}$/.test(value.inputSha256 ?? "") ||
    value.catalogId !== record.catalogId ||
    !positive(value.nativeId) ||
    !Array.isArray(value.actions) ||
    value.actions.length === 0 ||
    new Set(value.actions).size !== value.actions.length ||
    value.actions.some((a) => !PRODUCTION_COMMANDS.includes(a)) ||
    !/^[a-f0-9]{64}$/.test(value.authorityReferenceSha256 ?? "") ||
    !/^[a-f0-9]{40,64}$/.test(value.serverDeploymentReference ?? "") ||
    value.contractSha256 !== CATALOG_DELIVERY_CONTRACT_SHA256 ||
    ![value.expiresAt, value.credentialExpiresAt].every(
      (v) => Number.isFinite(Date.parse(v)) && Date.parse(v) > now,
    ) ||
    value.credentialSaved !== true ||
    value.permissionsConfirmed !== true ||
    value.serverDeploymentConfirmed !== true ||
    !value.caps ||
    ![
      "requests",
      "requestBodyPerRequest",
      "acceptedRequestBodyTotal",
      "responseBodyTotal",
    ].every((key) => positive(value.caps[key])) ||
    value.caps.requests > 2048 ||
    value.caps.requestBodyPerRequest > 1048576 ||
    value.caps.acceptedRequestBodyTotal > 134217728 ||
    value.caps.responseBodyTotal > 33554432
  )
    fail("PRODUCTION_AUTHORITY_NOT_CONFIRMED");
  return {
    version: 1,
    kind: value.kind,
    origin: value.origin,
    actorId: value.actorId,
    role: value.role,
    manifestSha256: value.manifestSha256,
    inputSha256: value.inputSha256,
    catalogId: value.catalogId,
    nativeId: value.nativeId,
    actions: [...value.actions],
    authorityReferenceSha256: value.authorityReferenceSha256,
    serverDeploymentReference: value.serverDeploymentReference,
    contractSha256: value.contractSha256,
    expiresAt: value.expiresAt,
    credentialExpiresAt: value.credentialExpiresAt,
    credentialSaved: true,
    permissionsConfirmed: true,
    serverDeploymentConfirmed: true,
    caps: { ...value.caps },
  };
}

export function assertProductionCommand(binding, command, manifest) {
  if (
    !PRODUCTION_COMMANDS.includes(command) ||
    !binding.actions.includes(command)
  )
    fail("PRODUCTION_ACTION_NOT_AUTHORIZED");
  const record = manifest?.records?.[0];
  if (command === "publish" && record?.disposition !== "publish")
    fail("DRAFT_ONLY");
  if (
    command === "run" &&
    (!record ||
      (record.disposition === "publish" &&
        !binding.actions.includes("publish")) ||
      (!record.reuseOnly && !binding.actions.includes("upload")))
  )
    fail("PRODUCTION_ACTION_NOT_AUTHORIZED");
  if (
    ["publish", "withdraw", "run"].includes(command) &&
    binding.role !== "owner"
  )
    fail("OWNER_AUTHORITY_REQUIRED");
}
