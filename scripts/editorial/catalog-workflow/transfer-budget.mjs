import { digest, fail } from "./identity.mjs";

const clone = (value) => JSON.parse(JSON.stringify(value));
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const hash = (value) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const exact = (value, keys) =>
  value &&
  Object.getPrototypeOf(value) === Object.prototype &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const LIMIT_KEYS = [
  "maxRequests",
  "maxUploadBytes",
  "maxDownloadBytes",
  "maxAttempts",
  "concurrency",
  "chunkBytes",
];
const REQUEST_KEYS = [
  "requestSha256",
  "maximumUploadBytes",
  "maximumDownloadBytes",
];
function limitsValid(limits) {
  return (
    exact(limits, LIMIT_KEYS) &&
    LIMIT_KEYS.every((key) => integer(limits[key])) &&
    ["maxAttempts", "concurrency", "chunkBytes"].every((key) => limits[key] > 0)
  );
}

/** Offline accounting only. This does not configure transport or authorize retry. */
export function createTransferBudget(
  scopeSha256,
  limits,
  configuredTransport,
  executionKind = "offline-fake",
) {
  if (
    !["offline-fake", "local-http", "native-https"].includes(executionKind) ||
    !hash(scopeSha256) ||
    !limitsValid(limits) ||
    !exact(configuredTransport, ["maxAttempts", "concurrency", "chunkBytes"]) ||
    Object.keys(configuredTransport).some(
      (key) =>
        !integer(configuredTransport[key]) ||
        configuredTransport[key] < 1 ||
        limits[key] > configuredTransport[key],
    ) ||
    limits.chunkBytes !== configuredTransport.chunkBytes
  )
    fail("TRANSFER_LIMITS_INVALID");
  return {
    version: 1,
    executionKind,
    scopeSha256,
    limits: clone(limits),
    configuredTransport: clone(configuredTransport),
    requests: [],
  };
}

function validAttempt(value) {
  return (
    exact(value, [
      "requestSha256",
      "maximumUploadBytes",
      "maximumDownloadBytes",
      "attempt",
      "status",
      "actualUploadBytes",
      "actualDownloadBytes",
      "evidenceSha256",
      "drainEvidenceSha256",
    ]) &&
    hash(value.requestSha256) &&
    integer(value.maximumUploadBytes) &&
    integer(value.maximumDownloadBytes) &&
    integer(value.attempt) &&
    value.attempt > 0 &&
    ["PENDING", "COMPLETE", "FAILED", "UNKNOWN"].includes(value.status) &&
    ["actualUploadBytes", "actualDownloadBytes"].every(
      (key) => value[key] === null || integer(value[key]),
    ) &&
    (value.evidenceSha256 === null || hash(value.evidenceSha256)) &&
    (value.drainEvidenceSha256 === null || hash(value.drainEvidenceSha256)) &&
    (value.status !== "PENDING" ||
      (value.actualUploadBytes === null &&
        value.actualDownloadBytes === null &&
        value.evidenceSha256 === null &&
        value.drainEvidenceSha256 === null)) &&
    (value.status !== "COMPLETE" ||
      (integer(value.actualUploadBytes) &&
        integer(value.actualDownloadBytes) &&
        hash(value.evidenceSha256)))
  );
}
export function openTransferBudget(
  saved,
  scopeSha256,
  limits,
  configuredTransport,
  executionKind = "offline-fake",
) {
  const expected = createTransferBudget(
    scopeSha256,
    limits,
    configuredTransport,
    executionKind,
  );
  if (
    !exact(saved, Object.keys(expected)) ||
    saved.version !== 1 ||
    saved.executionKind !== executionKind ||
    saved.scopeSha256 !== scopeSha256 ||
    digest(saved.limits) !== digest(limits) ||
    digest(saved.configuredTransport) !== digest(configuredTransport) ||
    !Array.isArray(saved.requests)
  )
    fail("TRANSFER_BUDGET_SCOPE_CHANGED");
  const seen = new Map();
  for (const request of saved.requests) {
    if (!validAttempt(request)) fail("TRANSFER_LEDGER_INVALID");
    const prior = seen.get(request.requestSha256) ?? [];
    if (
      request.attempt !== prior.length + 1 ||
      request.attempt > limits.maxAttempts ||
      prior.some(
        (row) =>
          row.status === "COMPLETE" ||
          row.status === "PENDING" ||
          row.status === "UNKNOWN" ||
          row.maximumUploadBytes !== request.maximumUploadBytes ||
          row.maximumDownloadBytes !== request.maximumDownloadBytes,
      )
    )
      fail("TRANSFER_LEDGER_INVALID");
    prior.push(request);
    seen.set(request.requestSha256, prior);
  }
  return clone(saved);
}

export function transferUsage(ledger) {
  let uploadBytes = 0,
    downloadBytes = 0,
    actualUploadBytes = 0,
    actualDownloadBytes = 0;
  let incompleteMeasurements = 0;
  for (const request of ledger.requests) {
    const uncertain = ["PENDING", "UNKNOWN"].includes(request.status);
    uploadBytes += uncertain
      ? Math.max(request.actualUploadBytes ?? 0, request.maximumUploadBytes)
      : (request.actualUploadBytes ?? request.maximumUploadBytes);
    downloadBytes += uncertain
      ? Math.max(request.actualDownloadBytes ?? 0, request.maximumDownloadBytes)
      : (request.actualDownloadBytes ?? request.maximumDownloadBytes);
    actualUploadBytes += request.actualUploadBytes ?? 0;
    actualDownloadBytes += request.actualDownloadBytes ?? 0;
    if (
      request.actualUploadBytes === null ||
      request.actualDownloadBytes === null
    )
      incompleteMeasurements++;
  }
  return {
    requests: ledger.requests.length,
    chargedUploadBytes: uploadBytes,
    chargedDownloadBytes: downloadBytes,
    knownActualUploadBytes: actualUploadBytes,
    knownActualDownloadBytes: actualDownloadBytes,
    incompleteMeasurements,
    overBudget:
      ledger.requests.length > ledger.limits.maxRequests ||
      uploadBytes > ledger.limits.maxUploadBytes ||
      downloadBytes > ledger.limits.maxDownloadBytes ||
      ledger.requests.some(
        (row) =>
          row.actualUploadBytes > row.maximumUploadBytes ||
          row.actualDownloadBytes > row.maximumDownloadBytes,
      ),
  };
}

// Persist this reservation using the existing locked atomic writer before dispatch.
// Unknown outcomes retain their full reservation and cannot automatically retry.
export function reserveTransfer(ledger, descriptor) {
  if (
    !exact(descriptor, REQUEST_KEYS) ||
    !hash(descriptor.requestSha256) ||
    !integer(descriptor.maximumUploadBytes) ||
    !integer(descriptor.maximumDownloadBytes)
  )
    fail("TRANSFER_REQUEST_INVALID");
  const prior = ledger.requests.filter(
    (row) => row.requestSha256 === descriptor.requestSha256,
  );
  if (
    prior.some(
      (row) =>
        row.maximumUploadBytes !== descriptor.maximumUploadBytes ||
        row.maximumDownloadBytes !== descriptor.maximumDownloadBytes,
    )
  )
    fail("TRANSFER_REQUEST_CHANGED");
  const complete = prior.find((row) => row.status === "COMPLETE");
  if (complete)
    return {
      status: "REUSE_VERIFIED",
      evidenceSha256: complete.evidenceSha256,
      attempt: complete.attempt,
    };
  if (prior.some((row) => row.status === "PENDING" || row.status === "UNKNOWN"))
    fail("TRANSFER_RECONCILIATION_REQUIRED");
  if (prior.length >= ledger.limits.maxAttempts) fail("TRANSFER_RETRY_LIMIT");
  const usage = transferUsage(ledger);
  if (
    usage.overBudget ||
    usage.requests + 1 > ledger.limits.maxRequests ||
    usage.chargedUploadBytes + descriptor.maximumUploadBytes >
      ledger.limits.maxUploadBytes ||
    usage.chargedDownloadBytes + descriptor.maximumDownloadBytes >
      ledger.limits.maxDownloadBytes
  )
    fail("TRANSFER_BUDGET_EXCEEDED");
  if (
    ledger.requests.filter(
      (row) =>
        ["PENDING", "UNKNOWN"].includes(row.status) &&
        row.drainEvidenceSha256 === null,
    ).length >= ledger.limits.concurrency
  )
    fail("TRANSFER_CONCURRENCY_LIMIT");
  const request = {
    ...descriptor,
    attempt: prior.length + 1,
    status: "PENDING",
    actualUploadBytes: null,
    actualDownloadBytes: null,
    evidenceSha256: null,
    drainEvidenceSha256: null,
  };
  ledger.requests.push(request);
  return clone(request);
}

// Counts are measured caller observations, never estimated from success counts.
// If a counter is unavailable, retain null and charge the reservation.
export function settleTransfer(ledger, observation) {
  if (
    !exact(observation, [
      "requestSha256",
      "attempt",
      "status",
      "actualUploadBytes",
      "actualDownloadBytes",
      "evidenceSha256",
    ])
  )
    fail("TRANSFER_OBSERVATION_INVALID");
  const row = ledger.requests.find(
    (value) =>
      value.requestSha256 === observation.requestSha256 &&
      value.attempt === observation.attempt,
  );
  if (
    !row ||
    !["PENDING", "UNKNOWN"].includes(row.status) ||
    (row.status === "UNKNOWN" && observation.status === "FAILED") ||
    !["COMPLETE", "FAILED", "UNKNOWN"].includes(observation.status) ||
    !validAttempt({ ...row, ...observation })
  )
    fail("TRANSFER_OBSERVATION_INVALID");
  if (
    ["actualUploadBytes", "actualDownloadBytes"].some(
      (key) =>
        row[key] !== null &&
        (observation[key] === null || observation[key] < row[key]),
    )
  )
    fail("TRANSFER_OBSERVATION_INVALID");
  Object.assign(row, clone(observation));
  return transferUsage(ledger);
}

/** Request-close observation frees a connection slot, never unknown byte cost. */
export function markTransferDrained(ledger, requestSha256, evidenceSha256) {
  const row = ledger.requests.findLast(
    (value) => value.requestSha256 === requestSha256,
  );
  if (!row || row.status !== "UNKNOWN" || !hash(evidenceSha256))
    fail("TRANSFER_OBSERVATION_INVALID");
  row.drainEvidenceSha256 = evidenceSha256;
}

/** Exact prior hash/byte/dimension proof may skip binary transfer. Never count-only. */
export function reusableMediaProof(
  record,
  asset,
  proof,
  freshSourceObservation = null,
) {
  const identity = digest({
    catalogId: record.catalogId,
    sourceId: record.sourceId,
    mediaId: asset.mediaId,
    uploadedSha256: asset.uploadedSha256,
    bytes: asset.bytes,
    width: asset.width,
    height: asset.height,
  });
  const binding = proof?.sourceBinding;
  const bindingValid =
    binding?.verified === true &&
    binding.identitySha256 === identity &&
    hash(binding.evidenceSha256) &&
    ((binding.kind === "IMMUTABLE_SOURCE" &&
      exact(binding, [
        "kind",
        "verified",
        "identitySha256",
        "evidenceSha256",
      ])) ||
      (binding.kind === "REMOTE_VERSION" &&
        exact(binding, [
          "kind",
          "verified",
          "identitySha256",
          "versionSha256",
          "evidenceSha256",
        ]) &&
        hash(binding.versionSha256) &&
        freshSourceObservation?.verified === true &&
        freshSourceObservation.fresh === true &&
        freshSourceObservation.identitySha256 === identity &&
        freshSourceObservation.versionSha256 === binding.versionSha256 &&
        hash(freshSourceObservation.evidenceSha256)));
  return (
    bindingValid === true &&
    proof?.verified === true &&
    hash(proof.evidenceSha256) &&
    ["catalogId", "sourceId"].every((key) => proof[key] === record[key]) &&
    [
      "mediaId",
      "sourceSha256",
      "uploadedSha256",
      "bytes",
      "width",
      "height",
    ].every((key) => proof[key] === asset[key])
  );
}

// Trusted adapter observations only; no COS feature is assumed or probed here.
export function selectIntegrityVerification(expected, capabilities) {
  if (
    !exact(expected, ["scopeSha256", "uploadedSha256", "bytes"]) ||
    !hash(expected.scopeSha256) ||
    !hash(expected.uploadedSha256) ||
    !integer(expected.bytes) ||
    !exact(capabilities, [
      "existingProofMatched",
      "serverChecksum",
      "sameRegionVerification",
      "fullReadbackBudgetBytes",
    ]) ||
    typeof capabilities.existingProofMatched !== "boolean" ||
    (capabilities.fullReadbackBudgetBytes !== null &&
      !integer(capabilities.fullReadbackBudgetBytes))
  )
    fail("INTEGRITY_CAPABILITY_INVALID");
  if (capabilities.existingProofMatched) return "REUSE_EXACT_PROOF";
  for (const [key, strategy] of [
    ["serverChecksum", "SERVER_SHA256"],
    ["sameRegionVerification", "SAME_REGION_SHA256"],
  ]) {
    const proof = capabilities[key];
    if (
      proof?.status === "VERIFIED" &&
      exact(proof, [
        "status",
        "scopeSha256",
        "algorithm",
        "sha256",
        "evidenceSha256",
      ]) &&
      proof.scopeSha256 === expected.scopeSha256 &&
      proof.algorithm === "SHA256" &&
      proof.sha256 === expected.uploadedSha256 &&
      hash(proof.evidenceSha256)
    )
      return strategy;
  }
  if (
    capabilities.fullReadbackBudgetBytes !== null &&
    capabilities.fullReadbackBudgetBytes >= expected.bytes
  )
    return "EXPLICITLY_BUDGETED_FULL_READBACK";
  fail("INTEGRITY_CAPABILITY_UNVERIFIED");
}

/** Fake-only request port; not bound to workflow or a real HTTP transport. */
export async function runBudgetedOfflineRequest(options) {
  if (
    options.executionKind !== "offline-fake" ||
    options.port?.kind !== "offline-fake"
  )
    fail("LIVE_ADAPTER_NOT_BOUND");
  if (
    typeof options.persist !== "function" ||
    typeof options.port.dispatch !== "function" ||
    !Number.isFinite(options.deadline)
  )
    fail("TRANSFER_REQUEST_INVALID");
  const active = () => {
    if (options.signal?.aborted) fail("WORKFLOW_CANCELLED");
    if ((options.now ?? Date.now)() >= options.deadline)
      fail("WORKFLOW_DEADLINE_EXCEEDED");
  };
  active();
  const reserved = reserveTransfer(options.ledger, options.descriptor);
  if (reserved.status === "REUSE_VERIFIED")
    return { ...reserved, liveE2E: false };
  await options.persist(clone(options.ledger));
  active();
  let measured;
  try {
    measured = await options.port.dispatch(clone(reserved));
  } catch {
    measured = {
      status: "UNKNOWN",
      actualUploadBytes: null,
      actualDownloadBytes: null,
      evidenceSha256: null,
    };
  }
  const usage = settleTransfer(options.ledger, {
    ...measured,
    requestSha256: reserved.requestSha256,
    attempt: reserved.attempt,
  });
  await options.persist(clone(options.ledger));
  return {
    status: measured.status,
    usage,
    evidenceSha256: measured.evidenceSha256,
    liveE2E: false,
  };
}
