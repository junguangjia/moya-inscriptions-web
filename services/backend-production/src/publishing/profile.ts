import { createHash } from "node:crypto";

import { PublishingMediaStoreError } from "../storage/publishing-media-store.js";
import {
  MediaProcessingInputError,
  MediaProcessingUnavailableError,
  MediaRejectedError,
  systemErrorCode,
} from "./processing/errors.js";
import {
  logSandboxFailure,
  outputRecipe,
  probeSandboxOutputs,
  storeOutputFile,
  validateSandboxManifest,
  writeJobStill,
} from "./processing/media-processor.js";
import { MediaToolError } from "./processing/media-tools.js";
import {
  LEGACY_USER_MEDIA_MAX_BYTES,
  SANDBOX_TIMEOUTS_MS,
} from "./processing/profiles.js";
import {
  PROFILE_FAMILIES,
  PROFILE_ROLES,
  currentRecipe,
  isProfileRole,
} from "./processing/recipes.js";
import { sniffSignature } from "./processing/signature.js";
import {
  SANDBOX_PROTOCOL_VERSION,
  SandboxProtocolError,
} from "./sandbox/protocol.js";
import { SANDBOX_JOB_LIMITS, sandboxNonce } from "./sandbox/sandbox-runner.js";

import type { ProcessorLogger } from "./processing/media-processor.js";
import type { ProfileFamily, ProfileRole } from "./processing/recipes.js";
import type {
  SandboxJob,
  SandboxRenditionRequest,
} from "./sandbox/protocol.js";
import type {
  SandboxJobDirectory,
  SandboxRunner,
} from "./sandbox/sandbox-runner.js";

/*
 * Profile image processing in the media worker (unified media pipeline,
 * increment 3a). A paced sweep, driven by the current avatar and background
 * pointers, has the store queue `profile_render` jobs; a job reads the
 * stored PNG of one profile image (`community.user_media`), checks it
 * against the row (size, PNG signature, SHA-256), renders every role of the
 * planned families in the same sandbox as works (`profile` plan, unedited,
 * complete framing), checks the decoded size against the row and writes
 * the renditions to the publishing store as owner-less profile
 * derivatives. The types below are structural mirrors of
 * `ProfileMediaAssetPort` in `@moya/api`; nothing here logs keys, ids or
 * media metadata.
 */

/** Mirror of `ProfileRenditionIdentity`. */
export interface ProfileWorkerRenditionIdentity {
  readonly role: ProfileRole;
  readonly version: number;
  readonly digest: string;
}

/** Mirror of `ProfileRenderPlan`. */
export interface ProfileWorkerRenderPlan {
  readonly userMediaId: string;
  readonly sha256: string;
  readonly width: number;
  readonly height: number;
  readonly byteSize: number;
  readonly families: readonly ProfileFamily[];
}

/** Mirror of `ProfileRenderOutcome`. */
export interface ProfileWorkerRenderOutcome {
  readonly sourceSha256: string;
  readonly renditions: readonly {
    readonly storageKey: string;
    readonly byteSize: number;
    readonly sha256: string;
    readonly role: ProfileRole;
    readonly recipeVersion: number;
    readonly recipeDigest: string;
    readonly contentType: "image/webp";
    readonly width: number;
    readonly height: number;
  }[];
}

export type ProfileRenderResult =
  | {
      readonly status: "rendered";
      readonly outcome: ProfileWorkerRenderOutcome;
    }
  | { readonly status: "rejected"; readonly failureCode: string };

/** Renders one profile image (implemented by {@link createProfileRenderer}). */
export interface ProfileRenderer {
  /** `source`: the stored PNG bytes the worker read for `plan`. */
  render(
    plan: ProfileWorkerRenderPlan,
    source: Uint8Array,
    signal?: AbortSignal,
  ): Promise<ProfileRenderResult>;
}

/** Owner label the publishing store sees for profile writes (never recorded). */
export const PROFILE_STORE_OWNER = "profile";

/**
 * The identities the anchor of each family (`avatar-128`, `background-960`)
 * must hold; the sweep and the job plan compare only these. A version bump
 * of a non-anchor role alone is therefore never rendered: it needs an
 * anchor version bump or an extension of the plan and the sweep.
 */
export const profileAnchorIdentities = (): ProfileWorkerRenditionIdentity[] =>
  Object.values(PROFILE_FAMILIES).map(({ anchor }) => {
    const recipe = currentRecipe(anchor);
    return { role: anchor, version: recipe.version, digest: recipe.digest };
  });

/**
 * Every role of the given families at its current recipe, in the order the
 * renderer renders them (the larger role of a family may be skipped by its
 * recipe). Unknown, repeated or no families are refused.
 */
export const profileRenditionRequests = (
  families: readonly ProfileFamily[],
): SandboxRenditionRequest[] => {
  if (
    families.length === 0 ||
    new Set(families).size !== families.length ||
    !families.every((family) => Object.hasOwn(PROFILE_FAMILIES, family))
  ) {
    throw new MediaProcessingInputError();
  }
  const roles = new Set<ProfileRole>(
    families.flatMap((family) => PROFILE_FAMILIES[family].roles),
  );
  return PROFILE_ROLES.filter((role) => roles.has(role)).map((role) => {
    const recipe = currentRecipe(role);
    return { role, version: recipe.version, digest: recipe.digest };
  });
};

const SHA256 = /^[0-9a-f]{64}$/;

const assertPlan = (plan: ProfileWorkerRenderPlan) => {
  const dimension = (value: number) => Number.isSafeInteger(value) && value > 0;
  if (
    !SHA256.test(plan.sha256) ||
    !dimension(plan.width) ||
    !dimension(plan.height) ||
    !dimension(plan.byteSize)
  ) {
    throw new MediaProcessingInputError();
  }
};

export interface ProfileRendererOptions {
  /** The publishing store (the UGC store in Production). */
  readonly store: {
    writeStream(
      ownerId: string,
      purpose: "derivative",
      contentType: "image/webp",
      maxBytes: number,
      source: AsyncIterable<Uint8Array>,
      options?: {
        readonly signal?: AbortSignal;
        readonly requireExactSize?: boolean;
      },
    ): Promise<{ storageKey: string; byteSize: number; sha256: string }>;
    remove(storageKey: string): Promise<void>;
  };
  readonly sandbox: Pick<SandboxRunner, "createJob" | "run">;
  readonly logger?: ProcessorLogger;
}

const withSignal = (signal: AbortSignal | undefined) =>
  signal ? { signal } : {};

const rejected = (failureCode: string): ProfileRenderResult => ({
  status: "rejected",
  failureCode,
});

export function createProfileRenderer(
  options: ProfileRendererOptions,
): ProfileRenderer {
  const { store, sandbox } = options;
  const logger = options.logger ?? console;
  return {
    async render(plan, source, signal) {
      assertPlan(plan);
      const renditions = profileRenditionRequests(plan.families);
      // The bytes must be the row's image before any decoder sees them.
      if (
        !(source instanceof Uint8Array) ||
        source.byteLength !== plan.byteSize ||
        source.byteLength > LEGACY_USER_MEDIA_MAX_BYTES
      ) {
        return rejected("size_mismatch");
      }
      if (sniffSignature(source.subarray(0, 8)).type !== "image/png") {
        return rejected("unsupported_type");
      }
      const sha256 = createHash("sha256").update(source).digest("hex");
      if (sha256 !== plan.sha256) return rejected("source_mismatch");
      const written: string[] = [];
      let job: SandboxJobDirectory | undefined;
      try {
        job = await sandbox.createJob();
        await writeJobStill(job, source, signal);
        const request: SandboxJob = {
          protocol: SANDBOX_PROTOCOL_VERSION,
          nonce: sandboxNonce(),
          operation: "derive",
          item: {
            kind: "static",
            qualityMode: "standard",
            inputs: [
              {
                role: "still",
                declaredType: "image/png",
                byteSize: source.byteLength,
                sha256,
              },
            ],
            clientPairing: null,
            edit: { rotation: 0, crop: null },
            coverCrop: null,
            plan: "profile",
            renditions,
            motion: false,
            placeholder: false,
          },
          limits: SANDBOX_JOB_LIMITS,
        };
        const result = await sandbox.run(job, request, {
          timeoutMs: SANDBOX_TIMEOUTS_MS.static,
          ...withSignal(signal),
        });
        const manifest = result.manifest;
        if (manifest.status === "rejected") {
          throw new MediaRejectedError(manifest.failureCode!);
        }
        validateSandboxManifest(manifest, request);
        await probeSandboxOutputs(result);
        // The row's dimensions describe the image the hash names; decoding
        // to another size means the row and its bytes disagree.
        if (
          manifest.inspection!.width !== plan.width ||
          manifest.inspection!.height !== plan.height
        ) {
          return rejected("source_mismatch");
        }
        const outputs: ProfileWorkerRenderOutcome["renditions"][number][] = [];
        for (const output of manifest.outputs) {
          if (
            output.contentType !== "image/webp" ||
            output.role === "motion" ||
            !isProfileRole(output.role)
          ) {
            throw new SandboxProtocolError("outputs_mismatch");
          }
          const file = result.files.get(output.name)!;
          const stored = await storeOutputFile(
            (body) =>
              store.writeStream(
                PROFILE_STORE_OWNER,
                "derivative",
                "image/webp",
                output.bytes,
                body,
                { requireExactSize: true, ...withSignal(signal) },
              ),
            file.path,
            output.bytes,
          );
          written.push(stored.storageKey);
          if (stored.sha256 !== output.sha256) {
            throw new SandboxProtocolError("hash_mismatch");
          }
          const recipe = outputRecipe(output);
          outputs.push({
            ...stored,
            role: output.role,
            recipeVersion: recipe.version,
            recipeDigest: recipe.digest,
            contentType: "image/webp",
            width: output.width,
            height: output.height,
          });
        }
        return {
          status: "rendered",
          outcome: { sourceSha256: sha256, renditions: outputs },
        };
      } catch (error) {
        await Promise.all(
          written.map((key) => store.remove(key).catch(() => undefined)),
        );
        if (signal?.aborted) throw new MediaToolError("aborted");
        if (error instanceof MediaRejectedError) {
          // A timeout is retried like an edit derivation, never a rejection.
          if (error.failureCode === "processing_timeout") {
            throw new MediaToolError("timeout");
          }
          return rejected(error.failureCode);
        }
        if (error instanceof SandboxProtocolError) {
          logSandboxFailure(logger, error);
          return rejected("processing_failed");
        }
        if (
          error instanceof MediaToolError ||
          error instanceof PublishingMediaStoreError ||
          error instanceof MediaProcessingInputError ||
          error instanceof MediaProcessingUnavailableError
        ) {
          throw error;
        }
        throw new MediaProcessingUnavailableError(systemErrorCode(error));
      } finally {
        await job?.dispose().catch(() => undefined);
      }
    },
  };
}

/** Mirror of `ProfileMediaAssetPort.enqueueProfileRenders`. */
export interface ProfileSweepPort {
  enqueueProfileRenders(
    now: Date,
    options: {
      readonly limit: number;
      readonly maxOpen: number;
      readonly anchors: readonly ProfileWorkerRenditionIdentity[];
    },
  ): Promise<{
    readonly missing: number;
    readonly blocked: number;
    readonly enqueued: number;
    readonly requeued: number;
    readonly paused: boolean;
  }>;
}

/** Sweep cadence in the worker maintenance (one pass a minute). */
export const PROFILE_SWEEP_INTERVAL_MS = 60 * 1000;
/** New or requeued `profile_render` jobs per pass. */
export const PROFILE_SWEEP_BATCH = 2;
/** No job is queued while this many `profile_render` jobs are open. */
export const PROFILE_SWEEP_MAX_OPEN = 2;

/**
 * One profile sweep pass for the worker maintenance; it is also the
 * backfill. The store queues nothing while uploads, edits or Catalog
 * renders wait, so a work upload waits behind at most `maxOpen` short
 * profile jobs. Logs a content-free count line when the counts change
 * (once more when nothing is missing any longer).
 */
export function createProfileSweep(options: {
  readonly port: ProfileSweepPort;
  readonly limit?: number;
  readonly maxOpen?: number;
  readonly logger?: {
    info(message: string): void;
    error(message: string): void;
  };
}): { run(now: Date): Promise<void> } {
  const logger = options.logger ?? console;
  const limit = options.limit ?? PROFILE_SWEEP_BATCH;
  const maxOpen = options.maxOpen ?? PROFILE_SWEEP_MAX_OPEN;
  let logged: string | null = null;
  return {
    async run(now) {
      const counts = await options.port.enqueueProfileRenders(now, {
        limit,
        maxOpen,
        anchors: profileAnchorIdentities(),
      });
      const line = `[media-worker] profile sweep missing=${counts.missing} blocked=${counts.blocked} enqueued=${counts.enqueued} requeued=${counts.requeued} paused=${counts.paused ? "yes" : "no"}`;
      if (line !== logged && (counts.missing > 0 || logged !== null)) {
        logger.info(line);
        logged = counts.missing > 0 ? line : null;
      }
    },
  };
}
