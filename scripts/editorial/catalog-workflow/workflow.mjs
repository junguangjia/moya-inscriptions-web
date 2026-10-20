import {
  digest,
  fail,
  validateManifest,
  verifyPrincipal,
} from "./identity.mjs";
import { validateLocalFixture } from "./local-native-http.mjs";
import {
  beginAction,
  latchProtections,
  markPhase,
  openCheckpoint,
  protectionCode,
  safeCode,
  validateAction,
} from "./checkpoint.mjs";

const clone = (value) => JSON.parse(JSON.stringify(value));
const sha = (value) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const positive = (value) => Number.isSafeInteger(value) && value > 0;
const same = (left, right) => digest(left) === digest(right);
function freeze(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

export function nativeProof(value, record) {
  if (
    !value ||
    !positive(value.id) ||
    !positive(value.revision) ||
    !["draft", "published"].includes(value.status) ||
    value.catalogId !== record.catalogId ||
    value.sourceId !== record.sourceId ||
    !sha(value.fingerprint) ||
    !sha(value.contentSha256) ||
    !sha(value.mediaSha256)
  )
    fail("NATIVE_PROOF_INVALID");
  return Object.fromEntries(
    [
      "id",
      "revision",
      "status",
      "catalogId",
      "sourceId",
      "fingerprint",
      "contentSha256",
      "mediaSha256",
    ].map((key) => [key, value[key]]),
  );
}
const matchesRecord = (proof, record) =>
  proof &&
  proof.contentSha256 === record.contentSha256 &&
  proof.mediaSha256 === digest(record.media);
function mediaProof(value, record) {
  if (
    !value ||
    value.verified !== true ||
    value.mediaSha256 !== digest(record.media) ||
    !sha(value.evidenceSha256)
  )
    fail("EXISTING_MEDIA_NOT_VERIFIED");
  return {
    verified: true,
    mediaSha256: value.mediaSha256,
    evidenceSha256: value.evidenceSha256,
  };
}
function draftProof(value, record, binding = null) {
  const native = nativeProof(value?.native, record);
  if (native.status !== "draft" || !matchesRecord(native, record))
    fail("DRAFT_PROOF_MISMATCH");
  const prior = binding?.before.draft ?? binding?.before.main;
  if (
    prior &&
    (native.id !== prior.id || native.revision !== prior.revision + 1)
  )
    fail("DRAFT_PROOF_MISMATCH");
  return { native, mediaEvidence: mediaProof(value.mediaEvidence, record) };
}
function nativeResult(value, before, kind, record) {
  const result = nativeProof(value, record);
  if (
    result.id !== before.id ||
    result.revision !== before.revision + 1 ||
    result.fingerprint !== before.fingerprint ||
    result.contentSha256 !== before.contentSha256 ||
    result.mediaSha256 !== before.mediaSha256 ||
    result.status !== (kind === "release-intent" ? "published" : "draft")
  )
    fail("MUTATION_PROOF_MISMATCH");
  return result;
}
function hold(state, code) {
  state.state = "HOLD";
  state.code = code;
}

async function context(options) {
  const executionKind = options.executionKind ?? "offline-fake";
  if (!["offline-fake", "local-http"].includes(executionKind))
    fail("LIVE_ADAPTER_NOT_BOUND");
  const localFixture =
    executionKind === "local-http"
      ? validateLocalFixture(options.manifest, options.localFixture)
      : null;
  if (
    typeof options.createAdapter !== "function" ||
    typeof options.persist !== "function" ||
    !Number.isFinite(options.deadline)
  )
    fail("WORKFLOW_ARGUMENTS_INVALID");
  const manifest = freeze(clone(validateManifest(options.manifest)));
  const opened = openCheckpoint(
    manifest,
    options.checkpoint ? clone(options.checkpoint) : undefined,
    executionKind,
  );
  const { checkpoint } = opened;
  let adapter;
  const save = async () => {
    try {
      if (typeof adapter?.getLatchedProtections === "function") {
        for (const record of manifest.records)
          latchProtections(
            checkpoint.records[record.recordId],
            await adapter.getLatchedProtections(record),
          );
      }
      await options.persist(clone(checkpoint));
    } catch {
      fail("CHECKPOINT_PERSIST_FAILED");
    }
  };
  const active = () => {
    if (options.signal?.aborted) fail("WORKFLOW_CANCELLED");
    if ((options.now ?? Date.now)() >= options.deadline)
      fail("WORKFLOW_DEADLINE_EXCEEDED");
  };
  if (!opened.inputMatches) {
    Object.values(checkpoint.records).forEach((state) =>
      hold(state, "CHECKPOINT_INPUT_CHANGED"),
    );
    await save();
    return { manifest, checkpoint, save, active, adapter: null };
  }
  active();
  adapter = await options.createAdapter();
  if (
    adapter?.kind !== executionKind ||
    (localFixture && adapter.boundarySha256 !== digest(localFixture))
  )
    fail("LIVE_ADAPTER_NOT_BOUND");
  verifyPrincipal(manifest, await adapter.verifyPrincipal());
  active();
  return { manifest, checkpoint, save, active, adapter };
}

async function inspect(ctx, record, state) {
  ctx.active();
  const raw = await ctx.adapter.inspectRecord(record);
  latchProtections(state, raw.protections);
  const observation = {
    draft: raw.draft ? nativeProof(raw.draft, record) : null,
    main: raw.main ? nativeProof(raw.main, record) : null,
    protections: { ...state.protections },
    mediaEvidence: raw.mediaEvidence
      ? mediaProof(raw.mediaEvidence, record)
      : null,
  };
  await ctx.save();
  return observation;
}

async function invoke(ctx, record, state, kind, action, call, normalize) {
  ctx.active();
  action.attempts += 1;
  await ctx.save();
  ctx.active();
  try {
    if (typeof call !== "function") fail("ADAPTER_CAPABILITY_MISSING");
    const normalized = normalize(
      await call({ record, action: freeze(clone(action)) }),
    );
    action.status = "VERIFIED";
    action.result = normalized;
    action.code = null;
    await ctx.save();
    return normalized;
  } catch (error) {
    if (error.code === "CHECKPOINT_PERSIST_FAILED") throw error;
    action.status = error.definitivelyRejected === true ? "FAILED" : "UNKNOWN";
    action.code = safeCode(error);
    await ctx.save();
    state.state =
      kind === "stage-draft"
        ? "DRAFT_OUTCOME_UNKNOWN"
        : "NATIVE_OUTCOME_UNKNOWN";
    state.code = action.code;
    await ctx.save();
    return null;
  }
}

/** Offline draft composition; the port delegates binary work to the existing client. */
async function runDraftWorkflow(options) {
  const ctx = await context(options);
  if (!ctx.adapter) return result(ctx.checkpoint);
  for (const record of ctx.manifest.records) {
    const state = ctx.checkpoint.records[record.recordId];
    try {
      const deny = protectionCode(record, state);
      if (deny) {
        hold(state, deny);
        await ctx.save();
        continue;
      }
      let observed = await inspect(ctx, record, state);
      const freshDeny = protectionCode(record, state);
      if (freshDeny) {
        hold(state, freshDeny);
        await ctx.save();
        continue;
      }
      if (state.draft && !same(state.draft, observed.draft))
        fail("CURRENT_DRAFT_CHANGED");
      let prepared;
      const action = state.actions["stage-draft"];
      if (action) {
        validateAction(ctx.checkpoint, record.recordId, "stage-draft", action);
        if (action.status === "VERIFIED")
          prepared = draftProof(action.result, record, action.binding);
        else {
          const recovered = await ctx.adapter.reconcileAction({
            record,
            kind: "stage-draft",
            action: freeze(clone(action)),
          });
          if (recovered?.outcome === "applied") {
            prepared = draftProof(recovered.result, record, action.binding);
            action.status = "VERIFIED";
            action.result = prepared;
            action.code = null;
            await ctx.save();
          } else if (
            recovered?.outcome === "resumable" &&
            recovered.requestIdentityVerified === true &&
            (!record.reuseOnly ||
              (observed.mediaEvidence &&
                typeof ctx.adapter.saveRegisteredDraft === "function"))
          ) {
            prepared = await invoke(
              ctx,
              record,
              state,
              "stage-draft",
              action,
              record.reuseOnly
                ? ctx.adapter.saveRegisteredDraft
                : ctx.adapter.stageDraft,
              (value) => draftProof(value, record, action.binding),
            );
          }
        }
        if (!prepared) {
          state.state = "DRAFT_OUTCOME_UNKNOWN";
          state.code = "ACTION_RECONCILIATION_PENDING";
          await ctx.save();
          continue;
        }
        observed = await inspect(ctx, record, state);
      } else if (matchesRecord(observed.draft, record)) {
        prepared = draftProof(
          { native: observed.draft, mediaEvidence: observed.mediaEvidence },
          record,
        );
      } else {
        const call = record.reuseOnly
          ? ctx.adapter.saveRegisteredDraft
          : ctx.adapter.stageDraft;
        if (record.reuseOnly) {
          if (!observed.mediaEvidence) fail("REUSE_ONLY_PROOF_MISSING");
          mediaProof(observed.mediaEvidence, record);
          if (typeof call !== "function") fail("ADAPTER_CAPABILITY_MISSING");
        }
        const pending = beginAction(
          ctx.checkpoint,
          record.recordId,
          "stage-draft",
          {
            contentSha256: record.contentSha256,
            mediaSha256: digest(record.media),
            before: observed,
          },
        );
        await ctx.save();
        prepared = await invoke(
          ctx,
          record,
          state,
          "stage-draft",
          pending,
          call,
          (value) => draftProof(value, record, pending.binding),
        );
        if (!prepared) continue;
        observed = await inspect(ctx, record, state);
      }
      if (protectionCode(record, state)) fail("PROTECTION_CHANGED");
      if (!same(observed.draft, prepared.native)) fail("CURRENT_DRAFT_CHANGED");
      state.draft = prepared.native;
      markPhase(
        state,
        "upload",
        "VERIFIED",
        prepared.mediaEvidence.evidenceSha256,
      );
      markPhase(state, "native-draft", "VERIFIED", digest(prepared.native));
      state.state =
        record.disposition === "publish"
          ? "WAITING_PRIVATE_PREPARATION_BINDING"
          : "DRAFT_VERIFIED";
      state.code =
        record.disposition === "publish"
          ? "PRIVATE_PREPARATION_NOT_BOUND"
          : null;
      await ctx.save();
    } catch (error) {
      if (error.code === "CHECKPOINT_PERSIST_FAILED") throw error;
      hold(state, safeCode(error, "WORKFLOW_OBSERVATION_FAILED"));
      await ctx.save();
    }
  }
  return result(ctx.checkpoint);
}

/**
 * An isolated fake-only single-Owner-CAS model, not an executable publication
 * pipeline. A release exercise requires an injected fake private-ready receipt
 * bound to B. No real preparation capability or production adapter exists here.
 */
export async function runOfflineNativeAction(options) {
  if (
    options.executionKind !== undefined &&
    options.executionKind !== "offline-fake"
  )
    fail("LIVE_ADAPTER_NOT_BOUND");
  if (!["release-intent", "withdraw-intent"].includes(options.kind))
    fail("ACTION_INVALID");
  const ctx = await context(options);
  if (!ctx.adapter) return result(ctx.checkpoint);
  const record = ctx.manifest.records.find(
    (row) => row.recordId === options.recordId,
  );
  if (!record) fail("ACTION_RECORD_NOT_IN_SCOPE");
  const state = ctx.checkpoint.records[record.recordId];
  try {
    if (ctx.manifest.target.role !== "owner")
      fail("OWNER_NATIVE_ACTION_REQUIRED");
    if (options.kind === "release-intent" && record.disposition !== "publish")
      fail("DRAFT_ONLY");
    const deny = protectionCode(record, state);
    if (deny && options.kind === "release-intent") fail(deny);
    const observed = await inspect(ctx, record, state);
    const freshDeny = protectionCode(record, state);
    if (freshDeny && options.kind === "release-intent") fail(freshDeny);
    const before = nativeProof(options.before, record);
    if (!matchesRecord(before, record)) fail("ACTION_CONTENT_MISMATCH");
    const existing = state.actions[options.kind];
    let confirmed;
    if (existing) {
      validateAction(ctx.checkpoint, record.recordId, options.kind, existing);
      if (!same(existing.binding.native, before))
        fail("ACTION_BINDING_CHANGED");
      if (existing.status === "VERIFIED")
        confirmed = nativeResult(existing.result, before, options.kind, record);
      else if (existing.status === "FAILED") fail("ACTION_PREVIOUSLY_REJECTED");
      else {
        const reconciled = await ctx.adapter.reconcileAction({
          record,
          kind: options.kind,
          action: freeze(clone(existing)),
        });
        if (reconciled?.outcome !== "applied") {
          existing.status = "UNKNOWN";
          existing.code = "ACTION_RECONCILIATION_PENDING";
          state.state = "NATIVE_OUTCOME_UNKNOWN";
          state.code = existing.code;
          await ctx.save();
          return result(ctx.checkpoint);
        }
        confirmed = nativeResult(
          reconciled.result,
          before,
          options.kind,
          record,
        );
        existing.status = "VERIFIED";
        existing.result = confirmed;
        existing.code = null;
        await ctx.save();
      }
      if (!same(observed.main, confirmed)) {
        if (
          options.kind === "release-intent" &&
          observed.main?.status === "draft"
        )
          latchProtections(state, { ...state.protections, withdrawn: true });
        fail("CURRENT_NATIVE_STATE_CHANGED");
      }
    } else {
      if (
        before.status !==
        (options.kind === "release-intent" ? "draft" : "published")
      )
        fail("CURRENT_NATIVE_STATE_CHANGED");
      const selected =
        options.kind === "release-intent" ? observed.draft : observed.main;
      if (!same(selected, before)) fail("CURRENT_NATIVE_STATE_CHANGED");
      if (options.kind === "release-intent") {
        const ready = options.privateReadyReceipt;
        if (
          ready?.executionKind !== "offline-fake" ||
          ready.nativeSha256 !== digest(before) ||
          ready.status !== "VERIFIED" ||
          !sha(ready.evidenceSha256) ||
          ready.phaseEvidenceSha256 !== privatePhaseBinding(state) ||
          ["asset", "rendition", "public-copy"].some(
            (phase) => state.phases[phase].status !== "VERIFIED",
          )
        )
          fail("PRIVATE_PREPARATION_NOT_BOUND");
      }
      const authority = await ctx.adapter.authorizeAction({
        record,
        kind: options.kind,
        native: before,
      });
      if (
        authority?.verified !== true ||
        authority.mode !== "owner-native" ||
        authority.nativeSha256 !== digest(before) ||
        !sha(authority.referenceSha256)
      )
        fail("OWNER_AUTHORITY_NOT_VERIFIED");
      const fresh = await inspect(ctx, record, state);
      if (options.kind === "release-intent" && protectionCode(record, state))
        fail("PROTECTION_CHANGED");
      if (!same(fresh, observed)) fail("NATIVE_PREFLIGHT_CHANGED");
      const action = beginAction(
        ctx.checkpoint,
        record.recordId,
        options.kind,
        {
          native: before,
          before: observed,
          authorityReferenceSha256: authority.referenceSha256,
          preparationEvidenceSha256:
            options.kind === "release-intent"
              ? options.privateReadyReceipt.evidenceSha256
              : null,
        },
      );
      await ctx.save();
      confirmed = await invoke(
        ctx,
        record,
        state,
        options.kind,
        action,
        ctx.adapter.mutateNative,
        (value) => nativeResult(value, before, options.kind, record),
      );
      if (!confirmed) return result(ctx.checkpoint);
    }
    if (options.kind === "release-intent") {
      state.intent = confirmed;
      markPhase(state, "native-intent", "VERIFIED", digest(confirmed));
      state.state = "NATIVE_RELEASE_CONFIRMED_NOT_DELIVERY";
    } else {
      state.withdrawn = confirmed;
      latchProtections(state, { ...state.protections, withdrawn: true });
      state.state = "WITHDRAWAL_PENDING";
    }
    state.code = null;
    await ctx.save();
  } catch (error) {
    if (error.code === "CHECKPOINT_PERSIST_FAILED") throw error;
    hold(state, safeCode(error, "WORKFLOW_OBSERVATION_FAILED"));
    await ctx.save();
  }
  return result(ctx.checkpoint);
}

// References to separately retained fake observations only. Job state is not
// evidence, and these helpers neither aggregate E2E success nor authorize CAS.
export function privatePhaseBinding(state) {
  return digest(
    Object.fromEntries(
      ["asset", "rendition", "public-copy"].map((phase) => [
        phase,
        state.phases[phase],
      ]),
    ),
  );
}

export function recordOfflinePhase(checkpoint, recordId, phase, observation) {
  if (checkpoint.executionKind !== "offline-fake")
    fail("LIVE_ADAPTER_NOT_BOUND");
  const state = checkpoint.records[recordId];
  const expectedNative = phase === "DTO-edge" ? state?.intent : state?.draft;
  if (
    !state ||
    !["asset", "rendition", "public-copy", "DTO-edge"].includes(phase) ||
    !expectedNative ||
    observation?.executionKind !== "offline-fake" ||
    observation.bindingSha256 !== digest(expectedNative)
  )
    fail("PHASE_EVIDENCE_SCOPE_MISMATCH");
  if (phase === "DTO-edge" && Object.values(state.protections).some(Boolean))
    fail("PROTECTED_RECORD_EVIDENCE_REJECTED");
  markPhase(
    state,
    phase,
    observation.status,
    observation.evidenceSha256 ?? null,
    observation.code ?? null,
  );
}

export function recordOfflineWithdrawal(checkpoint, recordId, observation) {
  const state = checkpoint.records[recordId];
  if (
    checkpoint.executionKind !== "offline-fake" ||
    !state?.withdrawn ||
    observation?.executionKind !== "offline-fake" ||
    observation.bindingSha256 !== digest(state.withdrawn)
  )
    fail("WITHDRAWAL_EVIDENCE_SCOPE_MISMATCH");
  const complete =
    observation.nativeDraft === true &&
    observation.listAbsent === true &&
    observation.detailAbsent === true &&
    observation.searchAbsent === true &&
    observation.originDenied === true &&
    observation.purgeConfirmed === true &&
    observation.warmedEdgeDenied === true &&
    positive(observation.expectedWarmedTargets) &&
    observation.verifiedWarmedTargets === observation.expectedWarmedTargets;
  markPhase(
    state,
    "withdrawal",
    complete ? "VERIFIED" : "PENDING",
    complete ? observation.evidenceSha256 : null,
    complete ? null : "WARMED_WITHDRAWAL_PENDING",
  );
  state.state = complete ? "WITHDRAWN_VERIFIED" : "WITHDRAWAL_PENDING";
  state.code = complete ? null : "WARMED_WITHDRAWAL_PENDING";
}
function result(checkpoint) {
  return {
    executionKind: checkpoint.executionKind,
    liveE2E: false,
    checkpoint,
    records: Object.entries(checkpoint.records).map(([recordId, state]) => ({
      recordId,
      state: state.state,
      code: state.code,
    })),
  };
}

export async function runOfflineDraftWorkflow(options) {
  if (
    options.executionKind !== undefined &&
    options.executionKind !== "offline-fake"
  )
    fail("LIVE_ADAPTER_NOT_BOUND");
  return runDraftWorkflow(options);
}

export async function runLocalHTTPDraftWorkflow(options) {
  if (options.executionKind !== "local-http") fail("LIVE_ADAPTER_NOT_BOUND");
  return runDraftWorkflow(options);
}
