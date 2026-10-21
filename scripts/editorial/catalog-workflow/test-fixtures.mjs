import { digest } from "./identity.mjs";
import { privatePhaseBinding, recordOfflinePhase } from "./workflow.mjs";

export const clone = (value) => JSON.parse(JSON.stringify(value));
export const hash = (letter) => letter.repeat(64);
export const protection = () => ({
  rightsHold: false,
  explicitlyHidden: false,
  withdrawn: false,
});
export function fixture({ reuseOnly = false, disposition = "publish" } = {}) {
  return {
    version: 1,
    batchId: "synthetic-offline-workflow",
    target: {
      instance: "development",
      origin: "http://127.0.0.1:12345",
      actorId: 1,
      role: "owner",
    },
    records: [
      {
        recordId: "SYNTHETIC-001",
        catalogId: "catalog-synthetic-1",
        sourceId: "source-synthetic-1",
        contentSha256: hash("a"),
        disposition,
        reuseOnly,
        protections: protection(),
        media: [
          {
            mediaId: "media-synthetic-1",
            sourceSha256: hash("b"),
            uploadedSha256: hash("c"),
            bytes: 100,
            width: 100,
            height: 200,
            position: 0,
            isRepresentative: true,
          },
        ],
      },
    ],
  };
}
export const native = (manifest, patch = {}) => ({
  id: 10,
  revision: 2,
  status: "draft",
  catalogId: manifest.records[0].catalogId,
  sourceId: manifest.records[0].sourceId,
  fingerprint: hash("d"),
  contentSha256: manifest.records[0].contentSha256,
  mediaSha256: digest(manifest.records[0].media),
  ...patch,
});
export const media = (manifest) => ({
  verified: true,
  mediaSha256: digest(manifest.records[0].media),
  evidenceSha256: hash("e"),
});
export const inspection = (manifest, draft = null) => ({
  draft,
  main: null,
  protections: protection(),
  mediaEvidence: draft ? media(manifest) : null,
});

/** Entirely in-memory fake. There are no network, filesystem or credential ports. */
export function harness(manifest = fixture()) {
  const h = {
    manifest,
    durable: null,
    now: 0,
    persistHook: null,
    inspectHook: null,
    authorizeHook: null,
    stageHook: null,
    mutateHook: null,
    reconcileHook: null,
    remote: inspection(manifest),
    calls: {
      factory: 0,
      principal: 0,
      inspect: 0,
      stage: 0,
      native: 0,
      reconcile: 0,
      authorize: 0,
      persist: 0,
    },
    principal: {
      ...manifest.target,
      verified: true,
      scopeCatalogIds: manifest.records.map((row) => row.catalogId),
    },
  };
  h.adapter = {
    kind: "offline-fake",
    verifyPrincipal: async () => {
      h.calls.principal++;
      return clone(h.principal);
    },
    inspectRecord: async () => {
      h.calls.inspect++;
      await h.inspectHook?.(h);
      return clone(h.remote);
    },
    stageDraft: async (input) => {
      h.calls.stage++;
      if (h.stageHook) return h.stageHook(input, h);
      h.remote.draft = native(manifest);
      h.remote.mediaEvidence = media(manifest);
      return {
        native: clone(h.remote.draft),
        mediaEvidence: clone(h.remote.mediaEvidence),
      };
    },
    authorizeAction: async (input) => {
      h.calls.authorize++;
      if (h.authorizeHook) return h.authorizeHook(input, h);
      return {
        verified: true,
        mode: "owner-native",
        nativeSha256: digest(input.native),
        referenceSha256: hash("f"),
      };
    },
    mutateNative: async (input) => {
      h.calls.native++;
      if (h.mutateHook) return h.mutateHook(input, h);
      const before = input.action.binding.native;
      h.remote.main = {
        ...before,
        revision: before.revision + 1,
        status: input.action.binding.preparationEvidenceSha256
          ? "published"
          : "draft",
      };
      return clone(h.remote.main);
    },
    reconcileAction: async (input) => {
      h.calls.reconcile++;
      if (h.reconcileHook) return h.reconcileHook(input, h);
      if (input.kind === "stage-draft" && h.remote.draft)
        return {
          outcome: "applied",
          result: {
            native: clone(h.remote.draft),
            mediaEvidence: clone(h.remote.mediaEvidence),
          },
        };
      if (
        input.kind !== "stage-draft" &&
        h.remote.main &&
        h.remote.main.revision === input.action.binding.native.revision + 1
      )
        return { outcome: "applied", result: clone(h.remote.main) };
      return { outcome: "unknown" };
    },
  };
  h.options = (patch = {}) => ({
    manifest: h.manifest,
    checkpoint: h.durable,
    executionKind: "offline-fake",
    deadline: 1000,
    now: () => h.now,
    createAdapter: async () => {
      h.calls.factory++;
      return h.adapter;
    },
    persist: async (value) => {
      h.calls.persist++;
      await h.persistHook?.(value, h);
      h.durable = clone(value);
    },
    ...patch,
  });
  return h;
}

export function prepareFakeReceipt(checkpoint, manifest) {
  const recordId = manifest.records[0].recordId,
    state = checkpoint.records[recordId];
  for (const phase of ["asset", "rendition", "public-copy"])
    recordOfflinePhase(checkpoint, recordId, phase, {
      executionKind: "offline-fake",
      bindingSha256: digest(state.draft),
      status: "VERIFIED",
      evidenceSha256: hash("e"),
    });
  return {
    executionKind: "offline-fake",
    nativeSha256: digest(state.draft),
    status: "VERIFIED",
    evidenceSha256: hash("f"),
    phaseEvidenceSha256: privatePhaseBinding(state),
  };
}
