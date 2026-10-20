import { digest, fail, targetIdentity, validateManifest } from "./identity.mjs";

export const PHASES = [
  "upload",
  "asset",
  "rendition",
  "public-copy",
  "native-draft",
  "native-intent",
  "DTO-edge",
  "withdrawal",
];
export const PROTECTIONS = ["rightsHold", "explicitlyHidden", "withdrawn"];
const OUTCOMES = new Set([
  "NOT_RUN",
  "PENDING",
  "FAILED",
  "UNKNOWN",
  "VERIFIED",
]);
const STATES = new Set([
  "FROZEN",
  "HOLD",
  "DRAFT_OUTCOME_UNKNOWN",
  "DRAFT_VERIFIED",
  "WAITING_PRIVATE_PREPARATION_BINDING",
  "NATIVE_OUTCOME_UNKNOWN",
  "NATIVE_RELEASE_CONFIRMED_NOT_DELIVERY",
  "WITHDRAWAL_PENDING",
  "WITHDRAWN_VERIFIED",
]);
const KINDS = ["stage-draft", "release-intent", "withdraw-intent"];
const SHA = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const CODES = new Set([
  "OPERATION_OUTCOME_UNKNOWN",
  "WORKFLOW_OBSERVATION_FAILED",
  "RIGHTS_HELD",
  "EXPLICITLY_HIDDEN",
  "INTENTIONALLY_WITHDRAWN",
  "HELD_DISPOSITION",
  "CHECKPOINT_INPUT_CHANGED",
  "CHECKPOINT_ACTION_INVALID",
  "ACTION_RECONCILIATION_PENDING",
  "ACTION_PREVIOUSLY_REJECTED",
  "CURRENT_DRAFT_CHANGED",
  "REUSE_ONLY_PROOF_MISSING",
  "EXISTING_MEDIA_NOT_VERIFIED",
  "PROTECTION_CHANGED",
  "PRIVATE_PREPARATION_NOT_BOUND",
  "OWNER_NATIVE_ACTION_REQUIRED",
  "DRAFT_ONLY",
  "ACTION_CONTENT_MISMATCH",
  "ACTION_BINDING_CHANGED",
  "CURRENT_NATIVE_STATE_CHANGED",
  "OWNER_AUTHORITY_NOT_VERIFIED",
  "NATIVE_PREFLIGHT_CHANGED",
  "NATIVE_PROOF_INVALID",
  "DRAFT_PROOF_MISMATCH",
  "MUTATION_PROOF_MISMATCH",
  "WORKFLOW_CANCELLED",
  "WORKFLOW_DEADLINE_EXCEEDED",
  "ADAPTER_CAPABILITY_MISSING",
  "SOURCE_UNREADABLE",
  "CONVERSION_FAILED",
  "HASH_MISMATCH",
  "REVISION_CONFLICT",
  "NOT_AUTHORIZED",
  "TRANSPORT_UNCERTAIN",
  "PROCESSING_PENDING",
  "PUBLIC_DELIVERY_PENDING",
  "WARMED_WITHDRAWAL_PENDING",
  "EVIDENCE_UNAVAILABLE",
  "PHASE_EVIDENCE_SCOPE_MISMATCH",
  "PROTECTED_RECORD_EVIDENCE_REJECTED",
]);
const object = (value) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;
const exact = (value, keys) =>
  object(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const positive = (value) => Number.isSafeInteger(value) && value > 0;
const hash = (value) => typeof value === "string" && SHA.test(value);
const code = (value) => value === null || CODES.has(value);
const clone = (value) => JSON.parse(JSON.stringify(value));
function freeze(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
export const safeCode = (error, fallback = "OPERATION_OUTCOME_UNKNOWN") =>
  CODES.has(error?.code) ? error.code : fallback;

export function validNative(value, state) {
  return (
    exact(value, [
      "id",
      "revision",
      "status",
      "catalogId",
      "sourceId",
      "fingerprint",
      "contentSha256",
      "mediaSha256",
    ]) &&
    positive(value.id) &&
    positive(value.revision) &&
    ["draft", "published"].includes(value.status) &&
    value.catalogId === state.catalogId &&
    value.sourceId === state.sourceId &&
    hash(value.fingerprint) &&
    hash(value.contentSha256) &&
    hash(value.mediaSha256)
  );
}
function validProtections(value) {
  return (
    exact(value, PROTECTIONS) &&
    PROTECTIONS.every((key) => typeof value[key] === "boolean")
  );
}
function validMedia(value) {
  return (
    exact(value, ["verified", "mediaSha256", "evidenceSha256"]) &&
    value.verified === true &&
    hash(value.mediaSha256) &&
    hash(value.evidenceSha256)
  );
}
function validInspection(value, state) {
  return (
    exact(value, ["draft", "main", "protections", "mediaEvidence"]) &&
    (value.draft === null || validNative(value.draft, state)) &&
    (value.main === null || validNative(value.main, state)) &&
    validProtections(value.protections) &&
    (value.mediaEvidence === null || validMedia(value.mediaEvidence))
  );
}
function validBinding(kind, value, state) {
  if (kind === "stage-draft")
    return (
      exact(value, ["contentSha256", "mediaSha256", "before"]) &&
      hash(value.contentSha256) &&
      hash(value.mediaSha256) &&
      validInspection(value.before, state)
    );
  return (
    exact(value, [
      "native",
      "before",
      "authorityReferenceSha256",
      "preparationEvidenceSha256",
    ]) &&
    validNative(value.native, state) &&
    validInspection(value.before, state) &&
    value.native.status ===
      (kind === "release-intent" ? "draft" : "published") &&
    hash(value.authorityReferenceSha256) &&
    (kind === "release-intent"
      ? hash(value.preparationEvidenceSha256)
      : value.preparationEvidenceSha256 === null) &&
    digest(value.native) ===
      digest(kind === "release-intent" ? value.before.draft : value.before.main)
  );
}
function validPhase(value) {
  return (
    exact(value, ["status", "evidenceSha256", "code"]) &&
    OUTCOMES.has(value.status) &&
    (value.evidenceSha256 === null || hash(value.evidenceSha256)) &&
    (value.status !== "VERIFIED" || hash(value.evidenceSha256)) &&
    code(value.code)
  );
}
function actionKey(checkpoint, recordId, kind, bindingSha256) {
  return `workflow-${digest({
    manifestSha256: checkpoint.manifestSha256,
    targetIdentity: checkpoint.targetIdentity,
    recordId,
    kind,
    bindingSha256,
  })}`;
}
function validResult(kind, result, binding, state) {
  const priorDraft = binding.before.draft ?? binding.before.main;
  if (kind === "stage-draft")
    return (
      exact(result, ["native", "mediaEvidence"]) &&
      validNative(result.native, state) &&
      result.native.status === "draft" &&
      validMedia(result.mediaEvidence) &&
      result.native.contentSha256 === binding.contentSha256 &&
      result.native.mediaSha256 === binding.mediaSha256 &&
      result.mediaEvidence.mediaSha256 === binding.mediaSha256 &&
      (!priorDraft ||
        (result.native.id === priorDraft.id &&
          result.native.revision === priorDraft.revision + 1))
    );
  return (
    validNative(result, state) &&
    result.id === binding.native.id &&
    result.revision === binding.native.revision + 1 &&
    result.status === (kind === "release-intent" ? "published" : "draft") &&
    ["fingerprint", "contentSha256", "mediaSha256"].every(
      (key) => result[key] === binding.native[key],
    )
  );
}

export function validateAction(checkpoint, recordId, kind, action) {
  const state = checkpoint.records[recordId];
  if (
    !KINDS.includes(kind) ||
    !exact(action, [
      "operationKey",
      "bindingSha256",
      "binding",
      "status",
      "attempts",
      "result",
      "code",
    ]) ||
    !validBinding(kind, action.binding, state) ||
    !hash(action.bindingSha256) ||
    action.bindingSha256 !== digest(action.binding) ||
    action.operationKey !==
      actionKey(checkpoint, recordId, kind, action.bindingSha256) ||
    !["PENDING", "UNKNOWN", "FAILED", "VERIFIED"].includes(action.status) ||
    !Number.isSafeInteger(action.attempts) ||
    action.attempts < 0 ||
    (kind !== "stage-draft" && action.attempts > 1) ||
    !code(action.code) ||
    (action.status === "VERIFIED"
      ? !validResult(kind, action.result, action.binding, state)
      : action.result !== null)
  )
    fail("CHECKPOINT_ACTION_INVALID");
  return action;
}

export function createCheckpoint(manifest, executionKind = "offline-fake") {
  validateManifest(manifest);
  if (
    !["offline-fake", "local-http", "native-https"].includes(executionKind) ||
    (executionKind === "local-http" &&
      manifest.target.instance !== "development") ||
    (executionKind === "native-https" &&
      manifest.target.instance !== "production")
  )
    fail("CHECKPOINT_SCOPE_MISMATCH");
  return {
    version: 1,
    executionKind,
    manifestSha256: digest(manifest),
    targetIdentity: targetIdentity(manifest),
    records: Object.fromEntries(
      manifest.records.map((record) => [
        record.recordId,
        {
          catalogId: record.catalogId,
          sourceId: record.sourceId,
          state: "FROZEN",
          code: null,
          protections: { ...record.protections },
          draft: null,
          intent: null,
          withdrawn: null,
          actions: {},
          history: [],
          phases: Object.fromEntries(
            PHASES.map((phase) => [
              phase,
              { status: "NOT_RUN", evidenceSha256: null, code: null },
            ]),
          ),
        },
      ]),
    ),
  };
}

// Phase index only. Disk locking, fsync and atomic replacement remain the
// injected existing private writer's responsibility; this model claims none.
export function openCheckpoint(
  manifest,
  saved,
  executionKind = "offline-fake",
) {
  validateManifest(manifest);
  const expected = createCheckpoint(manifest, executionKind);
  const checkpoint = saved ?? expected;
  if (
    !exact(checkpoint, [
      "version",
      "executionKind",
      "manifestSha256",
      "targetIdentity",
      "records",
    ]) ||
    checkpoint.version !== 1 ||
    checkpoint.executionKind !== expected.executionKind ||
    !hash(checkpoint.manifestSha256) ||
    checkpoint.targetIdentity !== targetIdentity(manifest) ||
    !object(checkpoint.records)
  )
    fail("CHECKPOINT_SCOPE_MISMATCH");
  if (Object.keys(checkpoint.records).length !== manifest.records.length)
    fail("CHECKPOINT_INVALID");
  const inputMatches = checkpoint.manifestSha256 === digest(manifest);
  for (const record of manifest.records) {
    if (!Object.hasOwn(checkpoint.records, record.recordId))
      fail("CHECKPOINT_INVALID");
    const state = checkpoint.records[record.recordId];
    if (
      !exact(state, [
        "catalogId",
        "sourceId",
        "state",
        "code",
        "protections",
        "draft",
        "intent",
        "withdrawn",
        "actions",
        "history",
        "phases",
      ]) ||
      state.catalogId !== record.catalogId ||
      typeof state.sourceId !== "string" ||
      !ID.test(state.sourceId) ||
      (inputMatches && state.sourceId !== record.sourceId) ||
      !STATES.has(state.state) ||
      !code(state.code) ||
      !validProtections(state.protections) ||
      !exact(state.phases, PHASES) ||
      PHASES.some((phase) => !validPhase(state.phases[phase])) ||
      !object(state.actions) ||
      !Array.isArray(state.history) ||
      state.history.some(
        (item) =>
          !exact(item, ["phase", "status", "evidenceSha256", "code"]) ||
          !PHASES.includes(item.phase) ||
          !validPhase({
            status: item.status,
            evidenceSha256: item.evidenceSha256,
            code: item.code,
          }),
      ) ||
      ["draft", "intent", "withdrawn"].some(
        (key) => state[key] !== null && !validNative(state[key], state),
      )
    )
      fail("CHECKPOINT_INVALID");
    if (
      (state.draft && state.draft.status !== "draft") ||
      (state.intent && state.intent.status !== "published") ||
      (state.withdrawn && state.withdrawn.status !== "draft")
    )
      fail("CHECKPOINT_INVALID");
    for (const phase of PHASES) {
      const latest = state.history.findLast((item) => item.phase === phase);
      const expected = latest
        ? {
            status: latest.status,
            evidenceSha256: latest.evidenceSha256,
            code: latest.code,
          }
        : { status: "NOT_RUN", evidenceSha256: null, code: null };
      if (digest(expected) !== digest(state.phases[phase]))
        fail("CHECKPOINT_INVALID");
    }
    for (const [kind, action] of Object.entries(state.actions))
      validateAction(checkpoint, record.recordId, kind, action);
    const draftAction = state.actions["stage-draft"];
    if (
      state.draft &&
      (state.phases["native-draft"].status !== "VERIFIED" ||
        state.phases["native-draft"].evidenceSha256 !== digest(state.draft) ||
        (draftAction &&
          (draftAction.status !== "VERIFIED" ||
            digest(draftAction.result.native) !== digest(state.draft))))
    )
      fail("CHECKPOINT_INVALID");
    for (const [pointer, kind] of [
      ["intent", "release-intent"],
      ["withdrawn", "withdraw-intent"],
    ]) {
      if (
        state[pointer] &&
        (state.actions[kind]?.status !== "VERIFIED" ||
          digest(state.actions[kind].result) !== digest(state[pointer]))
      )
        fail("CHECKPOINT_INVALID");
    }
    if (state.phases["native-draft"].status === "VERIFIED" && !state.draft)
      fail("CHECKPOINT_INVALID");
    if (
      (state.intent && state.phases["native-intent"].status !== "VERIFIED") ||
      (state.phases["native-intent"].status === "VERIFIED" &&
        (!state.intent ||
          state.phases["native-intent"].evidenceSha256 !==
            digest(state.intent)))
    )
      fail("CHECKPOINT_INVALID");
    if (state.sourceId === record.sourceId)
      latchProtections(state, record.protections);
  }
  return { checkpoint, inputMatches };
}

export function latchProtections(state, observed) {
  if (!validProtections(observed)) fail("PROTECTION_EVIDENCE_INVALID");
  for (const key of PROTECTIONS) state.protections[key] ||= observed[key];
  return PROTECTIONS.some((key) => state.protections[key]);
}

export function protectionCode(record, state) {
  if (state.protections.rightsHold) return "RIGHTS_HELD";
  if (state.protections.explicitlyHidden) return "EXPLICITLY_HIDDEN";
  if (state.protections.withdrawn) return "INTENTIONALLY_WITHDRAWN";
  return record.disposition === "hold" ? "HELD_DISPOSITION" : null;
}

export function markPhase(
  state,
  phase,
  status,
  evidenceSha256 = null,
  errorCode = null,
) {
  const next = { status, evidenceSha256, code: errorCode };
  if (!PHASES.includes(phase) || !validPhase(next))
    fail("PHASE_EVIDENCE_INVALID");
  if (digest(state.phases[phase]) !== digest(next))
    state.history.push({ phase, ...next });
  state.phases[phase] = next;
}

export function beginAction(checkpoint, recordId, kind, binding) {
  if (!Object.hasOwn(checkpoint.records, recordId) || !KINDS.includes(kind))
    fail("ACTION_INVALID");
  const state = checkpoint.records[recordId];
  if (Object.hasOwn(state.actions, kind))
    fail("ACTION_RECONCILIATION_REQUIRED");
  if (!validBinding(kind, binding, state)) fail("ACTION_BINDING_INVALID");
  const frozen = freeze(clone(binding));
  const bindingSha256 = digest(frozen);
  const action = {
    operationKey: actionKey(checkpoint, recordId, kind, bindingSha256),
    bindingSha256,
    binding: frozen,
    status: "PENDING",
    attempts: 0,
    result: null,
    code: null,
  };
  state.actions[kind] = action;
  return action;
}
