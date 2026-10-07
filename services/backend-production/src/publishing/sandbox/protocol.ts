import {
  RENDITION_PLANS,
  isCurrentRecipe,
  isRenditionPlan,
  isStillRole,
} from "../processing/recipes.js";

import type { MediaEdit, NormalizedCrop } from "../processing/edits.js";
import type { MediaFailureCode } from "../processing/errors.js";
import type { RenditionPlan, StillRole } from "../processing/recipes.js";

/*
 * The private wire protocol between the media worker's coordinator and the
 * sandboxed renderer (one workspace, two processes, same release). The
 * coordinator writes `job.json` into the read-only job input; the renderer
 * answers on stdout with one manifest line, then one hashed frame per output
 * file and an end frame. Every object is strict: an unknown key, a wrong type
 * or an out-of-range value is a violation. Hand-written validators keep the
 * workspace free of a schema dependency; messages are content-free.
 */

export const SANDBOX_PROTOCOL_VERSION = 1;

/** Fixed paths inside the sandbox container. */
export const SANDBOX_PATHS = {
  input: "/job/in",
  work: "/job/work",
  output: "/job/out",
  tmp: "/tmp",
  app: "/opt/renderer/app/dist",
  node: "/usr/local/bin/node",
  timeout: "/usr/bin/timeout",
  renderer: "/opt/renderer/app/dist/publishing/sandbox/renderer-main.js",
} as const;

/** Job description file name inside the job input. */
export const SANDBOX_JOB_FILE = "job.json";

/** Container names; the worker removes leftovers with this prefix at start. */
export const SANDBOX_CONTAINER_PREFIX = "yoyi-wp-media-";

/** Renderer exit codes besides 0 (manifest written). */
export const SANDBOX_EXIT_CODES = {
  invalidJob: 64,
  internal: 70,
} as const;

/** Environment keys the sandbox may see (Docker adds PATH, HOME, HOSTNAME). */
export const SANDBOX_ENVIRONMENT = {
  TMPDIR: "/tmp",
  VIPS_BLOCK_UNTRUSTED: "1",
  MALLOC_ARENA_MAX: "2",
  UV_THREADPOOL_SIZE: "2",
} as const;
export const SANDBOX_ALLOWED_ENVIRONMENT_KEYS: readonly string[] = [
  "HOME",
  "HOSTNAME",
  "PATH",
  ...Object.keys(SANDBOX_ENVIRONMENT),
].sort();

export type SandboxOperation = "process" | "derive" | "self-check" | "bounds";

/**
 * Active bound probes (W11, acceptance only): each drives one resource to
 * its sandbox bound so the coordinator can observe the refusal or kill.
 */
export const SANDBOX_BOUNDS_PROBES = [
  "memory",
  "pids",
  "time",
  "disk",
  "stdout",
] as const;
export type SandboxBoundsProbe = (typeof SANDBOX_BOUNDS_PROBES)[number];
export type SandboxInputRole = "still" | "motion" | "package";
export type SandboxDeclaredType =
  | "image/jpeg"
  | "image/png"
  | "image/webp"
  | "image/heic"
  | "image/heif"
  | "video/quicktime"
  | "video/mp4";
export type SandboxPairingMethod =
  "apple-content-identifier" | "motion-photo-container" | "none";

/** One still rendition the job asks for; the renderer looks the recipe up. */
export interface SandboxRenditionRequest {
  readonly role: StillRole;
  readonly version: number;
  readonly digest: string;
}

export interface SandboxInput {
  readonly role: SandboxInputRole;
  readonly declaredType: SandboxDeclaredType;
  readonly byteSize: number;
  readonly sha256: string;
}

export interface SandboxItemRequest {
  readonly kind: "static" | "live";
  readonly qualityMode: "standard" | "original";
  /** Staged at `/job/in/<role>`, sha256-verified by the coordinator. */
  readonly inputs: readonly SandboxInput[];
  readonly clientPairing: {
    readonly method: SandboxPairingMethod;
    readonly identifierSha256: string | null;
    readonly stillTimeMs?: number;
  } | null;
  readonly edit: MediaEdit;
  /** Applied to card roles (`thumb`, `cover`) only. */
  readonly coverCrop: NormalizedCrop | null;
  /**
   * What the job renders for: `work` (an item edit) or `catalog` (never asks
   * for `full`). Decides with the recipe whether `viewer` is rendered.
   */
  readonly plan: RenditionPlan;
  /** Still renditions; `viewer` may be skipped by its recipe or the plan. */
  readonly renditions: readonly SandboxRenditionRequest[];
  /** Render the motion derivative (Live items only). */
  readonly motion: boolean;
  /** Compute the placeholder colour from the `thumb` output (base edit only). */
  readonly placeholder: boolean;
}

export interface SandboxLimits {
  readonly maxPixels: number;
  readonly maxDecodedBytes: number;
  readonly renditionTimeoutSeconds: number;
  readonly tools: {
    readonly heifDecodeMs: number;
    readonly ffprobeMs: number;
    readonly ffmpegMotionMs: number;
  };
}

/** `/job/in/job.json`, written by the coordinator (at most 64 KiB). */
export interface SandboxJob {
  readonly protocol: 1;
  /** 32 hex; echoed in the manifest so the stream binds to this run. */
  readonly nonce: string;
  readonly operation: SandboxOperation;
  /** Present exactly for `process` and `derive`. */
  readonly item: SandboxItemRequest | null;
  /** Present exactly for `bounds`. */
  readonly probe?: SandboxBoundsProbe;
  readonly limits: SandboxLimits;
}

export interface SandboxOutput {
  /** `<role>.webp` or `motion.mp4`. */
  readonly name: string;
  readonly role: StillRole | "motion";
  readonly contentType: "image/webp" | "video/mp4";
  readonly width: number;
  readonly height: number;
  /** Motion only. */
  readonly durationMs: number | null;
  readonly bytes: number;
  readonly sha256: string;
}

export interface SandboxPairing {
  readonly method: SandboxPairingMethod;
  readonly verifiedBy: "server" | "client";
  readonly identifierSha256: string | null;
  readonly stillTimeMs?: number;
}

export interface SandboxPresentation {
  readonly width: number;
  readonly height: number;
  readonly durationMs?: number;
  readonly hasAudio?: boolean;
  readonly displayRotation?: 0 | 90 | 180 | 270;
}

/** Content-free facts the in-container isolation probe reports. */
export interface SandboxIsolationFacts {
  readonly uid: number;
  readonly gid: number;
  readonly noNewPrivileges: boolean;
  readonly effectiveCapabilities: string;
  readonly seccomp: number;
  /** Interfaces that are up (only `lo` in an isolated sandbox). */
  readonly networkInterfaces: readonly string[];
  readonly routes: number;
  readonly tcpConnect: string;
  readonly readOnly: {
    readonly root: boolean;
    readonly app: boolean;
    readonly input: boolean;
  };
  readonly writable: {
    readonly tmp: boolean;
    readonly work: boolean;
    readonly output: boolean;
  };
  readonly environmentKeys: readonly string[];
  readonly memoryMax: string | null;
  readonly swapMax: string | null;
  readonly pidsMax: string | null;
  readonly cpuMax: string | null;
  readonly oomScoreAdj: number | null;
  readonly coreLimit: string | null;
  readonly openFilesLimit: string | null;
  readonly visibleProcesses: number;
  readonly loaderAllowlist: boolean;
}

export interface SandboxRuntime {
  readonly node: string;
  readonly sharp: string;
  readonly vips: string;
}

/**
 * What a bound probe that was not killed reports: how far it got (child
 * processes started, or MiB written or allocated) and the error code that
 * stopped it, if any. Content-free.
 */
export interface SandboxBoundsFacts {
  readonly probe: SandboxBoundsProbe;
  readonly count: number;
  readonly errorCode: string | null;
}

/** The first stdout line (at most 256 KiB). */
export interface SandboxManifest {
  readonly protocol: 1;
  readonly nonce: string;
  readonly runtime: SandboxRuntime;
  readonly status:
    "processed" | "derived" | "rejected" | "self-check" | "bounds";
  /** Non-null exactly when `rejected`. */
  readonly failureCode: MediaFailureCode | null;
  /** The decoded still (after source orientation, unedited), when one was. */
  readonly inspection: {
    readonly width: number;
    readonly height: number;
    readonly hasAlpha: boolean;
  } | null;
  /** Exactly when `processed`. */
  readonly detectedTypes:
    | readonly {
        readonly role: SandboxInputRole;
        readonly contentType: SandboxDeclaredType;
      }[]
    | null;
  readonly pairing: SandboxPairing | null;
  readonly presentation: SandboxPresentation | null;
  readonly stillExifOrientation: number | null;
  readonly placeholderColor: string | null;
  readonly outputs: readonly SandboxOutput[];
  readonly selfCheck: SandboxIsolationFacts | null;
  /** Present exactly when `bounds`. */
  readonly bounds?: SandboxBoundsFacts;
}

/** A job the renderer refuses (a coordinator bug); content-free. */
export class SandboxJobError extends TypeError {
  constructor() {
    super("Invalid media sandbox job");
    this.name = "SandboxJobError";
  }
}

export type SandboxViolation =
  | "manifest_invalid"
  | "manifest_too_large"
  | "nonce_mismatch"
  | "runtime_mismatch"
  | "status_mismatch"
  | "outputs_mismatch"
  | "dimensions_mismatch"
  | "frame_invalid"
  | "frame_too_large"
  | "hash_mismatch"
  | "output_invalid"
  | "stream_incomplete"
  | "stream_trailing_bytes"
  | "stderr_limit"
  | "exit_after_manifest"
  | "resource_exceeded";

/**
 * The sandbox broke the protocol or its bounds. Content-free: the code names
 * the rule, never the data.
 */
export class SandboxProtocolError extends Error {
  constructor(readonly violation: SandboxViolation) {
    super(`Media sandbox protocol violation: ${violation}`);
    this.name = "SandboxProtocolError";
  }
}

const HEX32 = /^[0-9a-f]{32}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const COLOR = /^#[0-9a-f]{6}$/;
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[0-9A-Za-z.]{1,32})?$/;
const INTERFACE_NAME = /^[A-Za-z0-9_.@-]{1,32}$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const ERRNO = /^[A-Za-z_]{1,32}$/;
const LIMIT_VALUE = /^[0-9a-z ]{1,32}$/;
const MAX_STILL_TIME_MS = 60_000;
const MAX_RENDITIONS = 16;

const FAILURE_CODES: ReadonlySet<string> = new Set([
  "unsupported_type",
  "decode_failed",
  "dimensions_exceeded",
  "duration_exceeded",
  "stream_layout_unsupported",
  "animated_image_unsupported",
  "pairing_mismatch",
  "size_mismatch",
  "processing_timeout",
  "processing_failed",
] satisfies readonly MediaFailureCode[]);
const DECLARED_TYPES: ReadonlySet<string> = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
  "video/quicktime",
  "video/mp4",
]);
const INPUT_ROLES: ReadonlySet<string> = new Set([
  "still",
  "motion",
  "package",
]);
const PAIRING_METHODS: ReadonlySet<string> = new Set([
  "apple-content-identifier",
  "motion-photo-container",
  "none",
]);

type Fields = Record<string, unknown>;

/** A plain object whose keys are exactly `required` plus some of `optional`. */
const strict = (
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Fields | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) return null;
  const keys = Object.keys(value);
  if (!required.every((key) => keys.includes(key))) return null;
  if (keys.some((key) => !required.includes(key) && !optional.includes(key))) {
    return null;
  }
  return value as Fields;
};

const integer = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value >= min &&
  value <= max;

const unit = (value: unknown) =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= 1;

const crop = (value: unknown): NormalizedCrop | null | undefined => {
  if (value === null) return null;
  const fields = strict(value, ["x", "y", "width", "height"]);
  if (
    !fields ||
    !unit(fields.x) ||
    !unit(fields.y) ||
    !unit(fields.width) ||
    !unit(fields.height)
  )
    return undefined;
  return fields as unknown as NormalizedCrop;
};

const edit = (value: unknown): MediaEdit | undefined => {
  const fields = strict(value, ["rotation", "crop"]);
  if (
    !fields ||
    ![0, 90, 180, 270].includes(fields.rotation as number) ||
    crop(fields.crop) === undefined
  )
    return undefined;
  return fields as unknown as MediaEdit;
};

const renditionRequest = (value: unknown): boolean => {
  const fields = strict(value, ["role", "version", "digest"]);
  return (
    fields !== null &&
    isStillRole(fields.role) &&
    integer(fields.version, 1, 65_535) &&
    typeof fields.digest === "string"
  );
};

const clientPairing = (value: unknown): boolean => {
  if (value === null) return true;
  const fields = strict(value, ["method", "identifierSha256"], ["stillTimeMs"]);
  return (
    fields !== null &&
    PAIRING_METHODS.has(fields.method as string) &&
    (fields.identifierSha256 === null ||
      (typeof fields.identifierSha256 === "string" &&
        SHA256.test(fields.identifierSha256))) &&
    (fields.stillTimeMs === undefined ||
      integer(fields.stillTimeMs, 0, MAX_STILL_TIME_MS))
  );
};

/** The sorted input role layout of a well-formed item request, else null. */
const itemLayout = (value: unknown): string | null => {
  const fields = strict(value, [
    "kind",
    "qualityMode",
    "inputs",
    "clientPairing",
    "edit",
    "coverCrop",
    "plan",
    "renditions",
    "motion",
    "placeholder",
  ]);
  if (
    !fields ||
    (fields.kind !== "static" && fields.kind !== "live") ||
    (fields.qualityMode !== "standard" && fields.qualityMode !== "original") ||
    !Array.isArray(fields.inputs) ||
    fields.inputs.length < 1 ||
    fields.inputs.length > 2 ||
    !clientPairing(fields.clientPairing) ||
    edit(fields.edit) === undefined ||
    crop(fields.coverCrop) === undefined ||
    !isRenditionPlan(fields.plan) ||
    !Array.isArray(fields.renditions) ||
    fields.renditions.length > MAX_RENDITIONS ||
    !fields.renditions.every(renditionRequest) ||
    typeof fields.motion !== "boolean" ||
    typeof fields.placeholder !== "boolean"
  )
    return null;
  const roles = fields.renditions.map((entry) => (entry as Fields).role);
  if (new Set(roles).size !== roles.length) return null;
  // A plan without `full` never asks for it.
  if (!RENDITION_PLANS[fields.plan].full && roles.includes("full")) return null;
  if (fields.placeholder && !roles.includes("thumb")) return null;
  if (fields.renditions.length === 0 && !fields.motion) return null;
  const inputRoles = fields.inputs.map((input) => {
    const entry = strict(input, ["role", "declaredType", "byteSize", "sha256"]);
    return entry &&
      INPUT_ROLES.has(entry.role as string) &&
      DECLARED_TYPES.has(entry.declaredType as string) &&
      integer(entry.byteSize, 1, Number.MAX_SAFE_INTEGER) &&
      typeof entry.sha256 === "string" &&
      SHA256.test(entry.sha256)
      ? (entry.role as string)
      : null;
  });
  if (
    inputRoles.includes(null) ||
    new Set(inputRoles).size !== inputRoles.length
  )
    return null;
  return [...inputRoles].sort().join(",");
};

/**
 * Component layouts per operation: a static item has its still; a Live item
 * being processed has its pair or its package; an edit stages only the
 * components its renditions need.
 */
const layoutAllowed = (
  operation: "process" | "derive",
  item: SandboxItemRequest,
  layout: string,
): boolean => {
  const stills = item.renditions.length > 0;
  if (item.kind === "static") return layout === "still" && !item.motion;
  if (layout === "package") return true;
  if (operation === "process") return layout === "motion,still";
  if (layout === "motion,still") return stills && item.motion;
  if (layout === "still") return stills && !item.motion;
  return layout === "motion" && !stills && item.motion;
};

const limits = (value: unknown): boolean => {
  const fields = strict(value, [
    "maxPixels",
    "maxDecodedBytes",
    "renditionTimeoutSeconds",
    "tools",
  ]);
  const tools = fields
    ? strict(fields.tools, ["heifDecodeMs", "ffprobeMs", "ffmpegMotionMs"])
    : null;
  return (
    fields !== null &&
    tools !== null &&
    integer(fields.maxPixels, 1, 1_000_000_000) &&
    integer(fields.maxDecodedBytes, 1, 8 * 1024 * 1024 * 1024) &&
    integer(fields.renditionTimeoutSeconds, 1, 3600) &&
    integer(tools.heifDecodeMs, 1, 3_600_000) &&
    integer(tools.ffprobeMs, 1, 3_600_000) &&
    integer(tools.ffmpegMotionMs, 1, 3_600_000)
  );
};

/**
 * Renderer side: validates `job.json`. A rendition whose version or digest
 * is not the current recipe of its role in this release is refused.
 */
export function parseSandboxJob(value: unknown): SandboxJob {
  const fields = strict(
    value,
    ["protocol", "nonce", "operation", "item", "limits"],
    ["probe"],
  );
  if (
    !fields ||
    fields.protocol !== SANDBOX_PROTOCOL_VERSION ||
    typeof fields.nonce !== "string" ||
    !HEX32.test(fields.nonce) ||
    (fields.operation !== "process" &&
      fields.operation !== "derive" &&
      fields.operation !== "self-check" &&
      fields.operation !== "bounds") ||
    !limits(fields.limits) ||
    (fields.operation === "bounds") !== (fields.probe !== undefined)
  )
    throw new SandboxJobError();
  if (fields.operation === "bounds") {
    if (
      fields.item !== null ||
      !(SANDBOX_BOUNDS_PROBES as readonly unknown[]).includes(fields.probe)
    )
      throw new SandboxJobError();
    return fields as unknown as SandboxJob;
  }
  if (fields.operation === "self-check") {
    if (fields.item !== null) throw new SandboxJobError();
    return fields as unknown as SandboxJob;
  }
  const layout = itemLayout(fields.item);
  const item = fields.item as SandboxItemRequest;
  if (
    layout === null ||
    !layoutAllowed(fields.operation, item, layout) ||
    !item.renditions.every((request) => isCurrentRecipe(request))
  )
    throw new SandboxJobError();
  return fields as unknown as SandboxJob;
}

const runtime = (value: unknown): boolean => {
  const fields = strict(value, ["node", "sharp", "vips"]);
  return (
    fields !== null &&
    [fields.node, fields.sharp, fields.vips].every(
      (entry) => typeof entry === "string" && VERSION.test(entry),
    )
  );
};

const inspection = (value: unknown): boolean => {
  if (value === null) return true;
  const fields = strict(value, ["width", "height", "hasAlpha"]);
  return (
    fields !== null &&
    integer(fields.width, 1, 1_000_000) &&
    integer(fields.height, 1, 1_000_000) &&
    typeof fields.hasAlpha === "boolean"
  );
};

const detectedTypes = (value: unknown): boolean => {
  if (value === null) return true;
  if (!Array.isArray(value) || value.length < 1 || value.length > 2) {
    return false;
  }
  return value.every((entry) => {
    const fields = strict(entry, ["role", "contentType"]);
    return (
      fields !== null &&
      INPUT_ROLES.has(fields.role as string) &&
      DECLARED_TYPES.has(fields.contentType as string)
    );
  });
};

const pairing = (value: unknown): boolean => {
  if (value === null) return true;
  const fields = strict(
    value,
    ["method", "verifiedBy", "identifierSha256"],
    ["stillTimeMs"],
  );
  return (
    fields !== null &&
    PAIRING_METHODS.has(fields.method as string) &&
    (fields.verifiedBy === "server" || fields.verifiedBy === "client") &&
    (fields.identifierSha256 === null ||
      (typeof fields.identifierSha256 === "string" &&
        SHA256.test(fields.identifierSha256))) &&
    (fields.stillTimeMs === undefined ||
      integer(fields.stillTimeMs, 0, MAX_STILL_TIME_MS))
  );
};

const presentation = (value: unknown): boolean => {
  if (value === null) return true;
  const fields = strict(
    value,
    ["width", "height"],
    ["durationMs", "hasAudio", "displayRotation"],
  );
  return (
    fields !== null &&
    integer(fields.width, 1, 1_000_000) &&
    integer(fields.height, 1, 1_000_000) &&
    (fields.durationMs === undefined ||
      integer(fields.durationMs, 1, 3_600_000)) &&
    (fields.hasAudio === undefined || typeof fields.hasAudio === "boolean") &&
    (fields.displayRotation === undefined ||
      [0, 90, 180, 270].includes(fields.displayRotation as number))
  );
};

const output = (value: unknown): boolean => {
  const fields = strict(value, [
    "name",
    "role",
    "contentType",
    "width",
    "height",
    "durationMs",
    "bytes",
    "sha256",
  ]);
  if (!fields) return false;
  const still = isStillRole(fields.role);
  return (
    (still || fields.role === "motion") &&
    fields.name === (still ? `${String(fields.role)}.webp` : "motion.mp4") &&
    fields.contentType === (still ? "image/webp" : "video/mp4") &&
    integer(fields.width, 1, 16_383) &&
    integer(fields.height, 1, 16_383) &&
    (still
      ? fields.durationMs === null
      : integer(fields.durationMs, 1, 3_600_000)) &&
    integer(fields.bytes, 1, Number.MAX_SAFE_INTEGER) &&
    typeof fields.sha256 === "string" &&
    SHA256.test(fields.sha256)
  );
};

const stringList = (value: unknown, pattern: RegExp, max: number) =>
  Array.isArray(value) &&
  value.length <= max &&
  value.every((entry) => typeof entry === "string" && pattern.test(entry));

const nullableLimit = (value: unknown) =>
  value === null || (typeof value === "string" && LIMIT_VALUE.test(value));

const isolation = (value: unknown): boolean => {
  if (value === null) return true;
  const fields = strict(value, [
    "uid",
    "gid",
    "noNewPrivileges",
    "effectiveCapabilities",
    "seccomp",
    "networkInterfaces",
    "routes",
    "tcpConnect",
    "readOnly",
    "writable",
    "environmentKeys",
    "memoryMax",
    "swapMax",
    "pidsMax",
    "cpuMax",
    "oomScoreAdj",
    "coreLimit",
    "openFilesLimit",
    "visibleProcesses",
    "loaderAllowlist",
  ]);
  if (!fields) return false;
  const readOnly = strict(fields.readOnly, ["root", "app", "input"]);
  const writable = strict(fields.writable, ["tmp", "work", "output"]);
  return (
    integer(fields.uid, 0, 4_294_967_295) &&
    integer(fields.gid, 0, 4_294_967_295) &&
    typeof fields.noNewPrivileges === "boolean" &&
    typeof fields.effectiveCapabilities === "string" &&
    /^[0-9a-f]{1,16}$/.test(fields.effectiveCapabilities) &&
    integer(fields.seccomp, 0, 2) &&
    stringList(fields.networkInterfaces, INTERFACE_NAME, 64) &&
    integer(fields.routes, 0, 100_000) &&
    typeof fields.tcpConnect === "string" &&
    ERRNO.test(fields.tcpConnect) &&
    readOnly !== null &&
    Object.values(readOnly).every((entry) => typeof entry === "boolean") &&
    writable !== null &&
    Object.values(writable).every((entry) => typeof entry === "boolean") &&
    stringList(fields.environmentKeys, ENV_KEY, 256) &&
    nullableLimit(fields.memoryMax) &&
    nullableLimit(fields.swapMax) &&
    nullableLimit(fields.pidsMax) &&
    nullableLimit(fields.cpuMax) &&
    (fields.oomScoreAdj === null || integer(fields.oomScoreAdj, -1000, 1000)) &&
    nullableLimit(fields.coreLimit) &&
    nullableLimit(fields.openFilesLimit) &&
    integer(fields.visibleProcesses, 0, 1_000_000) &&
    typeof fields.loaderAllowlist === "boolean"
  );
};

const boundsFacts = (value: unknown): boolean => {
  if (value === undefined) return true;
  const fields = strict(value, ["probe", "count", "errorCode"]);
  return (
    fields !== null &&
    (SANDBOX_BOUNDS_PROBES as readonly unknown[]).includes(fields.probe) &&
    integer(fields.count, 0, 1_000_000) &&
    (fields.errorCode === null ||
      (typeof fields.errorCode === "string" && ERRNO.test(fields.errorCode)))
  );
};

/**
 * Coordinator side: parses and strictly validates the manifest line (without
 * its newline). Throws `SandboxProtocolError("manifest_invalid")`.
 */
export function parseSandboxManifest(line: string): SandboxManifest {
  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch {
    throw new SandboxProtocolError("manifest_invalid");
  }
  const fields = strict(
    value,
    [
      "protocol",
      "nonce",
      "runtime",
      "status",
      "failureCode",
      "inspection",
      "detectedTypes",
      "pairing",
      "presentation",
      "stillExifOrientation",
      "placeholderColor",
      "outputs",
      "selfCheck",
    ],
    ["bounds"],
  );
  if (
    !fields ||
    fields.protocol !== SANDBOX_PROTOCOL_VERSION ||
    typeof fields.nonce !== "string" ||
    !HEX32.test(fields.nonce) ||
    !runtime(fields.runtime) ||
    !["processed", "derived", "rejected", "self-check", "bounds"].includes(
      fields.status as string,
    ) ||
    (fields.failureCode !== null &&
      !FAILURE_CODES.has(fields.failureCode as string)) ||
    (fields.failureCode !== null) !== (fields.status === "rejected") ||
    !inspection(fields.inspection) ||
    !detectedTypes(fields.detectedTypes) ||
    !pairing(fields.pairing) ||
    !presentation(fields.presentation) ||
    (fields.stillExifOrientation !== null &&
      !integer(fields.stillExifOrientation, 1, 8)) ||
    (fields.placeholderColor !== null &&
      (typeof fields.placeholderColor !== "string" ||
        !COLOR.test(fields.placeholderColor))) ||
    !Array.isArray(fields.outputs) ||
    fields.outputs.length > MAX_RENDITIONS + 1 ||
    !fields.outputs.every(output) ||
    !isolation(fields.selfCheck) ||
    (fields.selfCheck !== null) !== (fields.status === "self-check") ||
    !boundsFacts(fields.bounds) ||
    (fields.bounds !== undefined) !== (fields.status === "bounds")
  )
    throw new SandboxProtocolError("manifest_invalid");
  const names = (fields.outputs as SandboxOutput[]).map((entry) => entry.name);
  if (new Set(names).size !== names.length) {
    throw new SandboxProtocolError("manifest_invalid");
  }
  if (
    (fields.status === "rejected" ||
      fields.status === "self-check" ||
      fields.status === "bounds") &&
    names.length > 0
  )
    throw new SandboxProtocolError("manifest_invalid");
  return fields as unknown as SandboxManifest;
}

/** One frame header line: `{"name","bytes","sha256"}` then a newline. */
export const encodeFrameHeader = (
  name: string,
  bytes: number,
  sha256: string,
): Buffer => Buffer.from(`${JSON.stringify({ name, bytes, sha256 })}\n`);

/** The end frame: `{"end":true,"count":<k>}` then a newline. */
export const encodeEndFrame = (count: number): Buffer =>
  Buffer.from(`${JSON.stringify({ end: true, count })}\n`);

export type SandboxFrameHeader =
  | {
      readonly kind: "file";
      readonly name: string;
      readonly bytes: number;
      readonly sha256: string;
    }
  | { readonly kind: "end"; readonly count: number };

/** Parses one frame header line (without its newline). */
export function parseFrameHeader(line: string): SandboxFrameHeader {
  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch {
    throw new SandboxProtocolError("frame_invalid");
  }
  const end = strict(value, ["end", "count"]);
  if (end) {
    if (end.end !== true || !integer(end.count, 0, MAX_RENDITIONS + 1))
      throw new SandboxProtocolError("frame_invalid");
    return { kind: "end", count: end.count };
  }
  const file = strict(value, ["name", "bytes", "sha256"]);
  if (
    !file ||
    typeof file.name !== "string" ||
    file.name.length > 64 ||
    !integer(file.bytes, 1, Number.MAX_SAFE_INTEGER) ||
    typeof file.sha256 !== "string" ||
    !SHA256.test(file.sha256)
  )
    throw new SandboxProtocolError("frame_invalid");
  return {
    kind: "file",
    name: file.name,
    bytes: file.bytes,
    sha256: file.sha256,
  };
}
