import type { MediaFailureCode } from "@moya/contracts";

import type {
  PublishingBlobContentType,
  PublishingMediaWriteResult,
} from "./publishing-media-store-port.js";

export type PublishingMediaKind = "static" | "live";
export type PublishingQualityMode = "standard" | "original";
export type PublishingComponentRole = "still" | "motion" | "package";
export type PublishingDerivativeVariant =
  "thumb" | "display" | "full" | "motion" | "cover";
/**
 * Every role a recorded rendition may carry: the derivative variants plus the
 * bounded `viewer` image, which is optional everywhere (recorded and read,
 * never required for readiness or submission).
 */
export type PublishingRenditionRole = PublishingDerivativeVariant | "viewer";
export type PublishingPairingMethod =
  "apple-content-identifier" | "motion-photo-container" | "none";

/**
 * `process` runs job `process_item`: every component is validated, pairing is
 * verified and the requested derivatives are rendered. `derive` runs job
 * `derive_edit` for an item that is already ready: only the components the
 * requested variants need are decoded and pairing is not re-verified.
 */
export type PublishingProcessMode = "process" | "derive";

/** Normalized 0..1 rectangle relative to the frame it applies to. */
export interface PublishingNormalizedCrop {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Non-destructive item edit. Rotation is clockwise and applies after source
 * orientation; the crop is normalized against the rotated frame. Still and
 * motion derivatives round crop edges with the same rule.
 */
export interface PublishingMediaEdit {
  readonly rotation: 0 | 90 | 180 | 270;
  readonly crop: PublishingNormalizedCrop | null;
}

export interface PublishingProcessorComponent {
  readonly role: PublishingComponentRole;
  readonly storageKey: string;
  readonly byteSize: number;
  readonly sha256: string;
  readonly declaredType: PublishingBlobContentType;
}

/** Pairing facts the browser proved from source bytes (contracts `mediaClientPairingSchema`). */
export interface PublishingClientPairing {
  readonly method: PublishingPairingMethod;
  readonly identifierSha256: string | null;
  /** Still presentation time in the motion (L09); kept when the method is confirmed. */
  readonly stillTimeMs?: number;
}

export interface PublishingProcessInput {
  readonly mode: PublishingProcessMode;
  readonly itemId: string;
  readonly ownerId: string;
  readonly kind: PublishingMediaKind;
  readonly qualityMode: PublishingQualityMode;
  /** All received components of the item. */
  readonly components: readonly PublishingProcessorComponent[];
  readonly clientPairing: PublishingClientPairing | null;
  /**
   * Opaque derivative key computed upstream (`base` or 32 lowercase hex); the
   * processor never recomputes it. `base` is only valid for the identity edit
   * without a cover crop.
   */
  readonly editKey: string;
  readonly edit: PublishingMediaEdit;
  /**
   * Normalized against the edited frame; `null` covers the whole frame. It
   * shapes the card derivatives `thumb` and `cover` only (design §8.3, L10),
   * so the upstream edit key must distinguish cover crops.
   */
  readonly coverCrop: PublishingNormalizedCrop | null;
  readonly variants: readonly PublishingDerivativeVariant[];
  readonly signal?: AbortSignal;
}

/** Content-free rejection codes: exactly the contracts `mediaFailureCodeSchema`. */
export type PublishingMediaFailureCode = MediaFailureCode;

/**
 * Presentation facts for `media_items.presentation`. `width`, `height`,
 * `durationMs` and `hasAudio` are the public `mediaPresentationSchema` fields;
 * `displayRotation` is private and the public mapper must drop it (the
 * contracts schema is strict).
 */
export interface PublishingMediaPresentation {
  /** Display dimensions of the unedited still after source orientation. */
  readonly width: number;
  readonly height: number;
  readonly durationMs?: number;
  readonly hasAudio?: boolean;
  /** Clockwise display rotation recorded in the motion source (baked into the motion derivative). */
  readonly displayRotation?: 0 | 90 | 180 | 270;
}

/** Value for `media_items.pairing`; written as returned. */
export interface PublishingMediaPairing {
  readonly method: PublishingPairingMethod;
  readonly verifiedBy: "server" | "client";
  /** Only an `apple-content-identifier` pairing carries a digest. */
  readonly identifierSha256: string | null;
  /** Client-proven still time, carried from `clientPairing` (≤ motion duration). */
  readonly stillTimeMs?: number;
}

export interface PublishingDerivativeRecord extends PublishingMediaWriteResult {
  /** The rendition role. */
  readonly variant: PublishingRenditionRole;
  readonly editKey: string;
  readonly contentType: "image/webp" | "video/mp4";
  readonly width: number;
  readonly height: number;
  readonly durationMs: number | null;
  /**
   * The recipe the bytes were rendered with, as the one recipe registry
   * names it: version (integer >= 1) and digest (16 lowercase hex). Required:
   * the store never defaults an identity. A result of a newer version than
   * the slot's ready rendition supersedes it (the old row is kept, never
   * deleted; a pre-task blob behind it is held for the D7 follow-up); an
   * equal or older version is a duplicate.
   */
  readonly recipeVersion: number;
  readonly recipeDigest: string;
}

/**
 * `processed` (mode `process`) and `derived` (mode `derive`) list derivatives
 * already committed to the media store; remove them if they are not recorded.
 *
 * `rejected` in mode `process` fails the item. In mode `derive` it fails only
 * that edit key's derivatives: the item stays ready and its existing
 * derivatives are untouched. Mode `derive` never resolves
 * `processing_timeout`; a timeout rejects the promise so the job retries.
 */
export type PublishingProcessOutcome =
  | {
      readonly status: "processed";
      readonly detectedTypes: readonly {
        readonly role: PublishingComponentRole;
        readonly contentType: PublishingBlobContentType;
      }[];
      readonly presentation: PublishingMediaPresentation;
      readonly pairing: PublishingMediaPairing | null;
      /**
       * Private orientation evidence (L13): the still's EXIF Orientation 1..8
       * or `null`. JPEG/PNG/WebP derivatives apply it once; HEIF derivatives
       * apply `irot`/`imir` instead and never apply this value on top.
       */
      readonly stillExifOrientation: number | null;
      readonly derivatives: readonly PublishingDerivativeRecord[];
      /**
       * Mean colour (`#rrggbb`) of the base-edit `thumb`, or `null` when the
       * image has a non-opaque pixel; omitted leaves the stored value.
       */
      readonly placeholderColor?: string | null;
    }
  | {
      readonly status: "derived";
      readonly derivatives: readonly PublishingDerivativeRecord[];
      /**
       * As for `processed`; only with derivatives of edit key `base` (a
       * backfill of an existing item), never with an edit.
       */
      readonly placeholderColor?: string | null;
    }
  | {
      readonly status: "rejected";
      readonly failureCode: PublishingMediaFailureCode;
    };

/**
 * Validates received components and produces derivatives. Deterministic
 * content problems resolve as `rejected`. Malformed input (including an
 * impossible component layout or a `base` key with an edit) rejects the
 * promise with a TypeError; infrastructure failures reject it with a
 * content-free error so the job mechanism can retry.
 */
export interface PublishingMediaProcessorPort {
  process(input: PublishingProcessInput): Promise<PublishingProcessOutcome>;
}
