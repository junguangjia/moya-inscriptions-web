/**
 * Server processing profiles for work publishing (design §3.5–3.6, §8) and
 * the media sandbox bounds (unified media pipeline, increment 1). Still
 * rendition recipes and their geometry live in `recipes.ts`; motion, tool and
 * sandbox numbers here are the single documented source.
 * `media_items.processing_profile` records the browser Standard profile,
 * never these.
 */

/**
 * ffprobe validation bounds for motion components: one video stream, at most
 * one audio stream, ≤ 30 s, each dimension ≤ 8192. Timed metadata tracks
 * (`codec_type` data, e.g. the Live Photo still-image-time track) are allowed
 * up to `maxDataStreams`; they are never mapped into the derivative.
 */
export const MOTION_INPUT_LIMITS = {
  maxVideoStreams: 1,
  maxAudioStreams: 1,
  maxDataStreams: 8,
  maxStreams: 16,
  maxDurationMs: 30_000,
  maxDimension: 8192,
} as const;

/**
 * Motion derivative: H.264 High, CRF 21, preset veryfast, 8-bit yuv420p,
 * AAC-LC 128 kbps (source channels), fast start, all container metadata
 * dropped and display rotation baked into pixels. The long edge is capped at
 * 1920 to match the browser Standard Live profile.
 */
export const MOTION_DERIVATIVE = {
  videoCodec: "libx264",
  outputVideoCodecName: "h264",
  videoProfile: "high",
  preset: "veryfast",
  crf: 21,
  pixelFormat: "yuv420p",
  audioCodec: "aac",
  outputAudioCodecName: "aac",
  audioBitrate: "128k",
  maxLongEdge: 1920,
} as const;

/**
 * Output duration may differ from the source by encoder priming and one audio
 * frame (AAC frames are ≤ 64 ms at ≥ 16 kHz).
 */
export const MOTION_DURATION_TOLERANCE_MS = 100;

/**
 * Motion colour handling (M05). Every derivative is SDR BT.709 limited range
 * and says so in its stream tags. Untagged sources are treated as BT.709.
 * Other SDR colour spaces are converted with zscale. HLG and PQ sources are
 * tone-mapped to SDR (linearize at `nominalPeakNits`, convert primaries,
 * `tonemap` operator, BT.709 transfer). Originals keep their HDR; derivatives
 * never claim it.
 */
export const MOTION_COLOR = {
  outputPrimaries: "bt709",
  outputTransfer: "bt709",
  outputMatrix: "bt709",
  outputRange: "tv",
  nominalPeakNits: 100,
  toneMapOperator: "hable",
  /** ffprobe primaries accepted (after `unknown` → bt709). */
  primaries: [
    "bt709",
    "smpte170m",
    "bt470bg",
    "bt470m",
    "smpte240m",
    "bt2020",
    "smpte431",
    "smpte432",
  ],
  /** SDR transfers accepted (after `unknown` → bt709). */
  sdrTransfers: [
    "bt709",
    "smpte170m",
    "bt470bg",
    "bt470m",
    "smpte240m",
    "iec61966-2-1",
    "bt2020-10",
    "bt2020-12",
  ],
  /** HDR transfers that are tone-mapped. */
  hdrTransfers: ["arib-std-b67", "smpte2084"],
  /** Matrices accepted (after `unknown` → bt709). */
  matrices: ["bt709", "smpte170m", "bt470bg", "smpte240m", "bt2020nc"],
  ranges: ["tv", "pc"],
} as const;

/** Hard wall-clock limits per tool invocation inside the sandbox (killed after). */
export const MEDIA_TOOL_TIMEOUTS_MS = {
  heifDecode: 60_000,
  ffprobe: 20_000,
  ffmpegMotion: 180_000,
} as const;

/**
 * The sandbox container also runs under `timeout --signal=KILL` for the
 * coordinator's limit plus this grace, so it ends even if the coordinator
 * lost track of it.
 */
export const MEDIA_TOOL_CONTAINER_TIMEOUT_GRACE_MS = 10_000;

/** Captured tool output ceilings (stdout parsed, stderr discarded). */
export const MEDIA_TOOL_OUTPUT_LIMITS = {
  ffprobeStdoutBytes: 1024 * 1024,
  defaultStdoutBytes: 64 * 1024,
  stderrBytes: 64 * 1024,
} as const;

/** Largest file a tool may write inside the sandbox work directory. */
export const MEDIA_TOOL_MAX_OUTPUT_FILE_BYTES = 1024 * 1024 * 1024;

/** Exact sharp version of the sandbox runtime (the workspace pin). */
export const SANDBOX_SHARP_VERSION = "0.35.4";
/** Node major of the sandbox runtime (the image pins 24.21.0). */
export const SANDBOX_NODE_MAJOR = 24;

/**
 * Docker flags of the one sandbox container a job runs in. Memory equals
 * memory plus swap (no swap); one CPU leaves the other for request serving;
 * core dumps are off; the sandbox is the host's preferred OOM victim. Every
 * writable path is a size-capped tmpfs owned by the sandbox user.
 */
export const SANDBOX_LIMITS = {
  memory: "1536m",
  memorySwap: "1536m",
  cpus: "1",
  pidsLimit: "256",
  user: "10001:10001",
  nofile: "nofile=1024:1024",
  core: "core=0",
  oomScoreAdj: "1000",
  tmpTmpfs: "/tmp:rw,nosuid,nodev,noexec,size=64m",
  workTmpfs:
    "/job/work:rw,nosuid,nodev,noexec,size=768m,uid=10001,gid=10001,mode=0700",
  outputTmpfs:
    "/job/out:rw,nosuid,nodev,noexec,size=256m,uid=10001,gid=10001,mode=0700",
  /** V8 heap of the renderer; pixel buffers are off-heap. */
  nodeOldSpaceMb: 384,
} as const;

/** Input bounds: staged bytes per job and decoded pixels and bytes per still. */
export const SANDBOX_INPUT_LIMITS = {
  maxInputBytes: 512 * 1024 * 1024,
  maxPixels: 120_000_000,
  /** width × height × channels × bytes per sample, before any pixel decode. */
  maxDecodedBytes: 512 * 1024 * 1024,
} as const;

/** Bounds of the framed stdout stream the coordinator accepts. */
export const SANDBOX_OUTPUT_LIMITS = {
  manifestBytes: 256 * 1024,
  frameHeaderBytes: 1024,
  fileBytes: 128 * 1024 * 1024,
  totalBytes: 256 * 1024 * 1024,
  files: 32,
  stderrBytes: 64 * 1024,
  jobFileBytes: 64 * 1024,
} as const;

/**
 * Container wall clock per job kind (killed after, by the coordinator and by
 * the in-container `timeout` with the grace below), and per still rendition.
 */
export const SANDBOX_TIMEOUTS_MS = {
  static: 300_000,
  live: 600_000,
  selfCheck: 30_000,
  rendition: 120_000,
} as const;

/** Largest Catalog source object read into a job. */
export const CATALOG_SOURCE_MAX_BYTES = 128 * 1024 * 1024;

/** Leading bytes read for Exif/XMP scanning of JPEG stills and packages. */
export const METADATA_HEAD_BYTES = 4 * 1024 * 1024;

/**
 * Largest legacy user media still (a Phase 4 work PNG kept in PostgreSQL) the
 * worker reads into a job for edit derivatives; the same bound as user media.
 */
export const LEGACY_USER_MEDIA_MAX_BYTES = 4 * 1024 * 1024;
