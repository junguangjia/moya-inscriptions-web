import { EventEmitter } from "node:events";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { crc32, deflateSync } from "node:zlib";

import { cosFixture } from "./publishing-cos-fixture.js";
import { inProcessSandbox } from "./publishing-sandbox-fixture.js";

import { FilesystemPublishingMediaStore } from "@moya/backend-production/internal/publishing-media-store";
import {
  MOTION_DERIVATIVE,
  MediaProcessingInputError,
  MediaProcessingUnavailableError,
  MediaRejectedError,
  MediaToolError,
  contentIdentifierSha256,
  createPublishingMediaProcessor,
  editRegion,
  ffmpegColorFilters,
  ffmpegEditFilters,
  ffmpegMotionArguments,
  ffprobeJson,
  heifDecodeToPng,
  inspectStaticSource,
  isEditKey,
  isIdentityEdit,
  parseEdit,
  pixelRegion,
  renderStaticDerivative,
  validateMotionProbe,
} from "@moya/backend-production/internal/publishing-processing";
import {
  createLocalToolRunner,
  createSandboxRunner,
  defaultSandboxAppDist,
} from "@moya/backend-production/internal/publishing-sandbox";
import {
  mediaFailureCodeSchema,
  mediaPresentationSchema,
} from "@moya/contracts/schemas";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  PublishingMediaFailureCode,
  PublishingMediaProcessorPort,
  PublishingProcessInput,
  PublishingProcessOutcome,
} from "@moya/api";
import type {
  MediaFailureCode,
  MediaToolRunner,
  ProcessorInput,
  MotionColor,
} from "@moya/backend-production/internal/publishing-processing";
import type {
  LocalToolProcess,
  LocalToolSpawn,
  LocalToolSpawnOptions,
} from "@moya/backend-production/internal/publishing-sandbox";
import type { MediaFailureCode as ContractMediaFailureCode } from "@moya/contracts";

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
// Processor, port and contracts failure codes are one list (type-level).
const failureCodesMatchContracts: Same<
  MediaFailureCode,
  ContractMediaFailureCode
> &
  Same<PublishingMediaFailureCode, ContractMediaFailureCode> = true;

const IMAGE = "yoyi-work-publishing-media-tools:v2";
let base: string;
let work: string;
let storeRoot: string;

beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), "publishing-tools-"));
  work = path.join(base, "work");
  storeRoot = path.join(base, "store");
  for (const directory of [work, storeRoot]) {
    await mkdir(directory, { mode: 0o700 });
    await chmod(directory, 0o700);
  }
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

/** Injected stand-in for `child_process.spawn` of an in-sandbox tool. */
class FakeToolProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly signals: string[] = [];

  kill(signal: NodeJS.Signals = "SIGTERM") {
    this.signals.push(signal);
    if (signal === "SIGKILL") this.exit(null);
    return true;
  }

  exit(code: number | null) {
    if (this.stdout.writableEnded) return;
    this.stdout.end();
    this.stderr.end();
    setImmediate(() => this.emit("close", code, null));
  }
}

interface ToolCall {
  readonly command: string;
  readonly args: string[];
  readonly options: LocalToolSpawnOptions;
  readonly process: FakeToolProcess;
}

/** A fake `spawn` for the in-sandbox tool runner. */
const fakeToolSpawn = (
  onRun: (call: ToolCall) => void | Promise<void>,
  options: { throwOnSpawn?: boolean } = {},
) => {
  const calls: ToolCall[] = [];
  const spawn: LocalToolSpawn = (command, args, spawnOptions) => {
    if (options.throwOnSpawn) throw new Error("spawn EACCES");
    const child = new FakeToolProcess();
    const call = { command, args, options: spawnOptions, process: child };
    calls.push(call);
    setImmediate(() => void onRun(call));
    return child as unknown as LocalToolProcess;
  };
  return { spawn, calls };
};

const toolFailure = async (run: () => Promise<unknown>) => {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(MediaToolError);
    return [(error as MediaToolError).code, (error as MediaToolError).exitCode];
  }
  throw new Error("expected a tool failure");
};

const rejection = async (run: () => Promise<unknown>) => {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(MediaRejectedError);
    return (error as MediaRejectedError).failureCode;
  }
  throw new Error("expected a rejection");
};

describe("publishing in-sandbox tool runner", () => {
  it("spawns the tool by absolute path with an argument array, no shell and an empty environment", async () => {
    const { spawn, calls } = fakeToolSpawn(async (call) => {
      await writeFile(call.args.at(-1)!, "png");
      call.process.exit(0);
    });
    const tools = createLocalToolRunner({ spawn });
    const decoded = await heifDecodeToPng(
      tools,
      path.join(base, "still"),
      work,
    );
    expect(decoded.byteSize).toBe(3);
    // A fresh directory per decode, below the scratch directory.
    expect(path.dirname(path.dirname(decoded.path))).toBe(work);
    expect(path.basename(decoded.path)).toBe("still.png");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe("/usr/bin/heif-dec");
    expect(calls[0]!.args).toEqual([
      "--quiet",
      path.join(base, "still"),
      decoded.path,
    ]);
    expect(calls[0]!.options).toEqual({
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
      env: {},
    });
  });

  it("refuses multi-image, auxiliary, symlinked, directory and empty decoder output", async () => {
    const cases: ((target: string) => Promise<void>)[] = [
      async (target) => {
        await writeFile(path.join(path.dirname(target), "still-1.png"), "a");
        await writeFile(path.join(path.dirname(target), "still-2.png"), "b");
      },
      async (target) => {
        await writeFile(target, "a");
        await writeFile(`${target}-depth.png`, "b");
      },
      (target) => symlink("/etc/hosts", target),
      (target) => mkdir(target),
      (target) => writeFile(target, ""),
      async () => undefined,
    ];
    for (const produce of cases) {
      const tools = createLocalToolRunner({
        spawn: fakeToolSpawn(async (call) => {
          await produce(call.args.at(-1)!);
          call.process.exit(0);
        }).spawn,
      });
      expect(
        await toolFailure(() =>
          heifDecodeToPng(tools, path.join(base, "still"), work),
        ),
      ).toEqual(["tool_failed", null]);
    }
  });

  it("runs ffprobe with the pinned demuxer and parses its JSON", async () => {
    const { spawn, calls } = fakeToolSpawn((call) => {
      call.process.stdout.write(JSON.stringify({ streams: [], format: {} }));
      call.process.exit(0);
    });
    const tools = createLocalToolRunner({ spawn });
    expect(await ffprobeJson(tools, "/job/in/motion")).toEqual({
      streams: [],
      format: {},
    });
    expect([calls[0]!.command, ...calls[0]!.args]).toEqual([
      "/usr/bin/ffprobe",
      "-v",
      "error",
      "-f",
      "mov",
      "-show_streams",
      "-show_format",
      "-of",
      "json",
      "/job/in/motion",
    ]);
  });

  it("kills the tool when stdout or stderr exceed their caps", async () => {
    const flood = fakeToolSpawn((call) => {
      call.process.stdout.write(Buffer.alloc(1024 * 1024 + 1, 0x7b));
    });
    expect(
      await toolFailure(() =>
        ffprobeJson(createLocalToolRunner({ spawn: flood.spawn }), "/x"),
      ),
    ).toEqual(["output_limit", null]);
    expect(flood.calls[0]!.process.signals).toEqual(["SIGKILL"]);
    const noisy = fakeToolSpawn((call) => {
      call.process.stderr.write(Buffer.alloc(64 * 1024 + 1, 0x20));
    });
    expect(
      await toolFailure(() =>
        createLocalToolRunner({ spawn: noisy.spawn }).run("ffmpeg", [], {
          timeoutMs: 5000,
        }),
      ),
    ).toEqual(["output_limit", null]);
  });

  it("kills a tool at its deadline or on abort and classifies exits", async () => {
    const hanging = fakeToolSpawn(() => undefined);
    const started = Date.now();
    expect(
      await toolFailure(() =>
        createLocalToolRunner({ spawn: hanging.spawn }).run(
          "ffmpeg",
          ["-version"],
          { timeoutMs: 20 },
        ),
      ),
    ).toEqual(["timeout", null]);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(hanging.calls[0]!.process.signals).toEqual(["SIGKILL"]);
    const controller = new AbortController();
    const aborting = fakeToolSpawn(() => controller.abort());
    expect(
      await toolFailure(() =>
        createLocalToolRunner({ spawn: aborting.spawn }).run("ffmpeg", [], {
          timeoutMs: 5000,
          signal: controller.signal,
        }),
      ),
    ).toEqual(["aborted", null]);
    const failing = fakeToolSpawn((call) => call.process.exit(1));
    expect(
      await toolFailure(() =>
        createLocalToolRunner({ spawn: failing.spawn }).run("ffprobe", [], {
          timeoutMs: 1000,
        }),
      ),
    ).toEqual(["tool_failed", 1]);
    expect(
      await toolFailure(() =>
        createLocalToolRunner({
          spawn: fakeToolSpawn(() => undefined, { throwOnSpawn: true }).spawn,
        }).run("ffprobe", [], { timeoutMs: 1000 }),
      ),
    ).toEqual(["spawn_failed", null]);
    const erroring = fakeToolSpawn((call) => {
      call.process.emit("error", new Error("ENOENT"));
    });
    expect(
      await toolFailure(() =>
        createLocalToolRunner({ spawn: erroring.spawn }).run("ffprobe", [], {
          timeoutMs: 1000,
        }),
      ),
    ).toEqual(["spawn_failed", null]);
  });

  it("rejects unknown tools and unsafe arguments without spawning", async () => {
    const { spawn, calls } = fakeToolSpawn(() => undefined);
    const tools = createLocalToolRunner({ spawn });
    for (const run of [
      () => tools.run("sh" as "ffmpeg", ["-c", "id"], { timeoutMs: 1000 }),
      () => tools.run("ffmpeg", ["a\0b"], { timeoutMs: 1000 }),
      () => tools.run("ffmpeg", [], { timeoutMs: 0 }),
    ])
      await expect(run()).rejects.toThrow("Invalid media tool invocation");
    expect(calls).toEqual([]);
  });
});

const SDR_709: MotionColor = {
  primaries: "bt709",
  transfer: "bt709",
  matrix: "bt709",
  range: "tv",
  dynamicRange: "sdr",
  pixelFormat: "yuv420p",
};

describe("publishing motion derivative arguments", () => {
  it("bakes rotation, crops in exact pixels, strips metadata and tags BT.709", () => {
    const args = ffmpegMotionArguments(
      "/job/in/motion",
      "/job/out/motion.mp4",
      { rotation: 90, crop: { x: 0.1, y: 0.2, width: 0.5, height: 0.25 } },
      { width: 1440, height: 1920, color: SDR_709 },
    );
    expect(args).toEqual([
      "-nostdin",
      "-hide_banner",
      "-loglevel",
      "error",
      "-n",
      "-f",
      "mov",
      "-i",
      "/job/in/motion",
      "-map",
      "0:v:0",
      "-map",
      "0:a:0?",
      "-map_metadata",
      "-1",
      "-map_chapters",
      "-1",
      "-dn",
      "-sn",
      "-vf",
      "setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv,transpose=clock,crop=w=960:h=360:x=192:y=288:exact=1,scale=w=min(1920\\,iw):h=min(1920\\,ih):force_original_aspect_ratio=decrease:force_divisible_by=2,format=yuv420p",
      "-c:v",
      "libx264",
      "-profile:v",
      "high",
      "-preset",
      "veryfast",
      "-crf",
      "21",
      "-pix_fmt",
      "yuv420p",
      "-color_primaries",
      "bt709",
      "-color_trc",
      "bt709",
      "-colorspace",
      "bt709",
      "-color_range",
      "tv",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-movflags",
      "+faststart",
      "-f",
      "mp4",
      "/job/out/motion.mp4",
    ]);
    expect(args).not.toContain("-noautorotate");
    expect(MOTION_DERIVATIVE.maxLongEdge).toBe(1920);
  });

  it("tone-maps HLG and PQ, converts other SDR colour spaces and passes BT.709 8-bit through", () => {
    const hdrTail = [
      "zscale=transfer=linear:npl=100",
      "format=gbrpf32le",
      "zscale=primaries=709",
      "tonemap=tonemap=hable:desat=0",
      "zscale=transfer=709:matrix=709:range=tv",
      "format=yuv420p",
    ];
    expect(
      ffmpegColorFilters({
        primaries: "bt2020",
        transfer: "arib-std-b67",
        matrix: "bt2020nc",
        range: "tv",
        dynamicRange: "hlg",
        pixelFormat: "yuv420p10le",
      }),
    ).toEqual({
      head: [
        "setparams=color_primaries=bt2020:color_trc=arib-std-b67:colorspace=bt2020nc:range=tv",
      ],
      tail: hdrTail,
    });
    expect(
      ffmpegColorFilters({
        ...SDR_709,
        primaries: "bt2020",
        transfer: "smpte2084",
        matrix: "bt2020nc",
        dynamicRange: "pq",
      }).tail,
    ).toEqual(hdrTail);
    const converted = [
      "zscale=primaries=709:transfer=709:matrix=709:range=tv",
      "format=yuv420p",
    ];
    expect(
      ffmpegColorFilters({
        ...SDR_709,
        primaries: "smpte170m",
        transfer: "smpte170m",
        matrix: "smpte170m",
      }).tail,
    ).toEqual(converted);
    expect(
      ffmpegColorFilters({ ...SDR_709, pixelFormat: "yuv420p10le" }).tail,
    ).toEqual(converted);
    expect(ffmpegColorFilters({ ...SDR_709, range: "pc" }).tail).toEqual(
      converted,
    );
    expect(ffmpegColorFilters(SDR_709).tail).toEqual(["format=yuv420p"]);
  });
});

const videoStream = (extra: Record<string, unknown> = {}) => ({
  codec_type: "video",
  codec_name: "hevc",
  width: 1920,
  height: 1440,
  duration: "2.900000",
  pix_fmt: "yuv420p",
  ...extra,
});
const probe = (
  streams: unknown[],
  format: Record<string, unknown> = { duration: "2.900000" },
) => ({
  streams,
  format,
});

describe("publishing motion probe validation", () => {
  it("accepts one video, one audio and metadata data streams, reporting clockwise rotation and colour", () => {
    expect(
      validateMotionProbe(
        probe([
          videoStream({
            side_data_list: [
              { side_data_type: "Display Matrix", rotation: -90 },
            ],
          }),
          { codec_type: "audio", codec_name: "aac" },
          { codec_type: "data" },
          { codec_type: "data" },
        ]),
      ),
    ).toEqual({
      durationMs: 2900,
      codedWidth: 1920,
      codedHeight: 1440,
      width: 1440,
      height: 1920,
      rotation: 90,
      hasAudio: true,
      videoCodec: "hevc",
      audioCodec: "aac",
      colorTags: { primaries: null, transfer: null, matrix: null, range: null },
      color: SDR_709,
    });
    expect(
      validateMotionProbe(
        probe([videoStream({ side_data_list: [{ rotation: 90 }] })]),
      ).rotation,
    ).toBe(270);
    expect(
      validateMotionProbe(probe([videoStream({ tags: { rotate: "180" } })]))
        .rotation,
    ).toBe(180);
    expect(validateMotionProbe(probe([videoStream()], {})).durationMs).toBe(
      2900,
    );
    const hdr = (transfer: string) =>
      validateMotionProbe(
        probe([
          videoStream({
            color_primaries: "bt2020",
            color_transfer: transfer,
            color_space: "bt2020nc",
            color_range: "tv",
            pix_fmt: "yuv420p10le",
          }),
        ]),
      ).color;
    expect(hdr("arib-std-b67")).toEqual({
      primaries: "bt2020",
      transfer: "arib-std-b67",
      matrix: "bt2020nc",
      range: "tv",
      dynamicRange: "hlg",
      pixelFormat: "yuv420p10le",
    });
    expect(hdr("smpte2084").dynamicRange).toBe("pq");
    expect(hdr("bt2020-10").dynamicRange).toBe("sdr");
    expect(
      validateMotionProbe(
        probe([videoStream({ color_primaries: "unknown", color_range: "pc" })]),
      ).color,
    ).toEqual({ ...SDR_709, range: "pc" });
  });

  it.each([
    [
      "two video streams",
      probe([videoStream(), videoStream()]),
      "stream_layout_unsupported",
    ],
    [
      "no video stream",
      probe([{ codec_type: "audio" }]),
      "stream_layout_unsupported",
    ],
    [
      "two audio streams",
      probe([videoStream(), { codec_type: "audio" }, { codec_type: "audio" }]),
      "stream_layout_unsupported",
    ],
    [
      "a subtitle stream",
      probe([videoStream(), { codec_type: "subtitle" }]),
      "stream_layout_unsupported",
    ],
    [
      "too many data streams",
      probe([
        videoStream(),
        ...Array.from({ length: 9 }, () => ({ codec_type: "data" })),
      ]),
      "stream_layout_unsupported",
    ],
    [
      "a duration over 30 s",
      probe([videoStream()], { duration: "30.001" }),
      "duration_exceeded",
    ],
    [
      "a missing duration",
      probe([videoStream({ duration: undefined })], {}),
      "decode_failed",
    ],
    [
      "a non-numeric duration",
      probe([videoStream({ duration: "NaN" })], { duration: "1e3" }),
      "decode_failed",
    ],
    [
      "an oversized dimension",
      probe([videoStream({ width: 8193 })]),
      "dimensions_exceeded",
    ],
    [
      "missing dimensions",
      probe([videoStream({ height: undefined })]),
      "decode_failed",
    ],
    [
      "a non-right-angle rotation",
      probe([videoStream({ side_data_list: [{ rotation: 45 }] })]),
      "stream_layout_unsupported",
    ],
    [
      "unlisted primaries",
      probe([videoStream({ color_primaries: "film" })]),
      "stream_layout_unsupported",
    ],
    [
      "an unlisted transfer",
      probe([videoStream({ color_transfer: "log100" })]),
      "stream_layout_unsupported",
    ],
    [
      "a constant-luminance matrix",
      probe([videoStream({ color_space: "bt2020c" })]),
      "stream_layout_unsupported",
    ],
    [
      "a malformed codec name",
      probe([videoStream({ codec_name: "Not A Name!" })]),
      "stream_layout_unsupported",
    ],
    ["a non-object document", "[]", "decode_failed"],
  ])("rejects %s", async (_name, json, code) => {
    expect(await rejection(async () => validateMotionProbe(json))).toBe(code);
  });
});

describe("publishing edits", () => {
  it("validates edits strictly as processing input", () => {
    expect(
      parseEdit({ rotation: 270, crop: { x: 0, y: 0, width: 1, height: 1 } }),
    ).toEqual({
      rotation: 270,
      crop: { x: 0, y: 0, width: 1, height: 1 },
    });
    for (const edit of [
      { rotation: 45, crop: null },
      { rotation: 90 },
      { rotation: 0, crop: null, filter: "sepia" },
      { rotation: 0, crop: { x: 0.6, y: 0, width: 0.5, height: 1 } },
      { rotation: 0, crop: { x: -0.1, y: 0, width: 0.5, height: 1 } },
      { rotation: 0, crop: { x: 0, y: 0, width: 0, height: 1 } },
      { rotation: 0, crop: { x: 0, y: 0, width: Number.NaN, height: 1 } },
      null,
    ]) {
      expect(() => parseEdit(edit)).toThrow(MediaProcessingInputError);
    }
    expect(isIdentityEdit({ rotation: 0, crop: null })).toBe(true);
    expect(
      isIdentityEdit({
        rotation: 0,
        crop: { x: 0, y: 0, width: 1, height: 1 },
      }),
    ).toBe(false);
    expect(isEditKey("base")).toBe(true);
    expect(isEditKey("a".repeat(32))).toBe(true);
    expect(isEditKey("A".repeat(32))).toBe(false);
  });

  it("maps normalized crops to bounded pixel regions and composes cover crops", () => {
    expect(
      pixelRegion({ x: 0.1, y: 0.2, width: 0.5, height: 0.5 }, 1000, 500),
    ).toEqual({
      left: 100,
      top: 100,
      width: 500,
      height: 250,
    });
    expect(
      pixelRegion(
        { x: 0.9999, y: 0.9999, width: 0.0001, height: 0.0001 },
        10,
        10,
      ),
    ).toEqual({
      left: 9,
      top: 9,
      width: 1,
      height: 1,
    });
    expect(
      editRegion(
        { width: 2000, height: 1000 },
        { rotation: 90, crop: { x: 0, y: 0.5, width: 1, height: 0.5 } },
        { x: 0.5, y: 0, width: 0.5, height: 1 },
      ),
    ).toEqual({
      frame: { width: 1000, height: 2000 },
      region: { left: 500, top: 1000, width: 500, height: 1000 },
    });
    expect(
      ffmpegEditFilters(
        { rotation: 180, crop: null },
        { width: 1920, height: 1080 },
        1920,
      ),
    ).toEqual([
      "hflip",
      "vflip",
      "scale=w=min(1920\\,iw):h=min(1920\\,ih):force_original_aspect_ratio=decrease:force_divisible_by=2",
    ]);
  });

  it("crops still and motion frames with the same pixel rounding (L10)", () => {
    const crop = {
      x: 0.1234567,
      y: 0.3333333,
      width: 0.4567891,
      height: 0.3333333,
    };
    for (const [width, height] of [
      [1920, 1080],
      [1441, 1921],
      [1000, 999],
    ] as const) {
      const still = editRegion(
        { width, height },
        { rotation: 0, crop },
        null,
      ).region;
      expect(still).toEqual(pixelRegion(crop, width, height));
      expect(
        ffmpegEditFilters({ rotation: 0, crop }, { width, height }, 8192)[0],
      ).toBe(
        `crop=w=${still.width}:h=${still.height}:x=${still.left}:y=${still.top}:exact=1`,
      );
    }
    const rotatedStill = editRegion(
      { width: 1440, height: 1920 },
      { rotation: 270, crop },
      null,
    ).region;
    expect(
      ffmpegEditFilters(
        { rotation: 270, crop },
        { width: 1440, height: 1920 },
        1920,
      )[1],
    ).toBe(
      `crop=w=${rotatedStill.width}:h=${rotatedStill.height}:x=${rotatedStill.left}:y=${rotatedStill.top}:exact=1`,
    );
    // A degenerate crop grows to the 2×2 an encoder needs, inside the frame.
    expect(
      ffmpegEditFilters(
        { rotation: 0, crop: { x: 0.9999, y: 0, width: 0.0001, height: 1 } },
        { width: 100, height: 100 },
        1920,
      )[0],
    ).toBe("crop=w=2:h=100:x=98:y=0:exact=1");
  });
});

const RED = { r: 255, g: 0, b: 0 };
const BLUE = { r: 0, g: 0, b: 255 };

/** 300×200 JPEG (left half red, right half blue) displayed with EXIF orientation 6. */
const orientedJpeg = async () => {
  const red = await sharp({
    create: { width: 150, height: 200, channels: 3, background: RED },
  })
    .png()
    .toBuffer();
  return sharp({
    create: { width: 300, height: 200, channels: 3, background: BLUE },
  })
    .composite([{ input: red, left: 0, top: 0 }])
    .jpeg({ quality: 95 })
    .withExif({ IFD0: { Copyright: "synthetic-private-marker" } })
    .withMetadata({ orientation: 6 })
    .toBuffer();
};

const centerPixel = async (image: Buffer) => {
  const { data, info } = await sharp(image)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const offset =
    (Math.floor(info.height / 2) * info.width + Math.floor(info.width / 2)) *
    info.channels;
  return [data[offset]!, data[offset + 1]!, data[offset + 2]!];
};

const pngChunk = (type: string, data: Buffer) => {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
};

const pngFile = (
  width: number,
  height: number,
  beforeImageData: Buffer[] = [],
) => {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    ...beforeImageData,
    pngChunk("IDAT", deflateSync(Buffer.alloc(64))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
};

describe("publishing static processor", () => {
  it("orients, rotates, then crops and strips metadata from WebP derivatives; card variants use the cover crop", async () => {
    const input = await orientedJpeg();
    const source = { input, autoOrient: true, expectedFormat: "jpeg" as const };
    const inspection = await inspectStaticSource(source);
    expect(inspection).toEqual({
      width: 200,
      height: 300,
      hasAlpha: false,
      orientation: 6,
    });
    const derivative = await renderStaticDerivative(
      source,
      inspection,
      "display",
      {
        rotation: 90,
        crop: { x: 0, y: 0, width: 0.5, height: 1 },
      },
    );
    expect([
      derivative.width,
      derivative.height,
      derivative.contentType,
    ]).toEqual([150, 200, "image/webp"]);
    const metadata = await sharp(derivative.buffer).metadata();
    expect(metadata.format).toBe("webp");
    expect(metadata.exif).toBeUndefined();
    expect(metadata.xmp).toBeUndefined();
    expect(metadata.orientation).toBeUndefined();
    // Orientation 6 puts red on top; rotating 90° clockwise puts it on the right.
    const [r, , b] = await centerPixel(derivative.buffer);
    expect(b).toBeGreaterThan(200);
    expect(r).toBeLessThan(60);
    const coverCrop = { x: 0.5, y: 0, width: 0.5, height: 1 };
    for (const variant of ["cover", "thumb"] as const) {
      const card = await renderStaticDerivative(
        source,
        inspection,
        variant,
        { rotation: 90, crop: null },
        coverCrop,
      );
      expect([card.width, card.height]).toEqual([150, 200]);
      expect((await centerPixel(card.buffer))[0]).toBeGreaterThan(200);
    }
    const full = await renderStaticDerivative(
      source,
      inspection,
      "full",
      { rotation: 90, crop: null },
      coverCrop,
    );
    expect([full.width, full.height]).toEqual([300, 200]);
  });

  it("rejects format mismatches, undecodable bytes, oversized headers and animation", async () => {
    const jpegBytes = await orientedJpeg();
    expect(
      await rejection(() =>
        inspectStaticSource({
          input: jpegBytes,
          autoOrient: true,
          expectedFormat: "png",
        }),
      ),
    ).toBe("unsupported_type");
    expect(
      await rejection(() =>
        inspectStaticSource({
          input: Buffer.from("not an image"),
          autoOrient: true,
          expectedFormat: "jpeg",
        }),
      ),
    ).toBe("decode_failed");
    expect(
      await rejection(() =>
        inspectStaticSource({
          input: pngFile(12000, 12000),
          autoOrient: true,
          expectedFormat: "png",
        }),
      ),
    ).toBe("dimensions_exceeded");
    const frame = (background: typeof RED) =>
      sharp({ create: { width: 8, height: 8, channels: 3, background } })
        .png()
        .toBuffer();
    const animated = await sharp([await frame(RED), await frame(BLUE)], {
      join: { animated: true },
    })
      .webp()
      .toBuffer();
    expect(
      await rejection(() =>
        inspectStaticSource({
          input: animated,
          autoOrient: true,
          expectedFormat: "webp",
        }),
      ),
    ).toBe("animated_image_unsupported");
  });
});

// ---- End-to-end processor orchestration over a real store and a fake sandbox ----

const u8 = (...values: number[]) => Uint8Array.from(values);
const concat = (...parts: Uint8Array[]) => Buffer.concat(parts);
const u16 = (v: number) => u8((v >>> 8) & 255, v & 255);
const u32 = (v: number) =>
  u8((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
const ascii = (text: string) => Buffer.from(text, "latin1");
const zeros = (length: number) => Buffer.alloc(length);
const box = (type: string, ...payload: Uint8Array[]) => {
  const body = concat(...payload);
  return concat(u32(8 + body.length), ascii(type), body);
};
const fullBox = (type: string, version: number, ...payload: Uint8Array[]) =>
  box(type, u8(version, 0, 0, 0), ...payload);
const identity = concat(
  u32(0x10000),
  u32(0),
  u32(0),
  u32(0),
  u32(0x10000),
  u32(0),
  u32(0),
  u32(0),
  u32(0x40000000),
);

const IDENTIFIER = "7A1C2B3D-4E5F-4061-8273-94A5B6C7D8E9";
const OTHER_IDENTIFIER = "11111111-2222-4333-8444-555555555555";

const movieBox = (...extra: Uint8Array[]) => {
  const handler = fullBox("hdlr", 0, u32(0), ascii("vide"), zeros(12), u8(0));
  return box(
    "moov",
    fullBox(
      "mvhd",
      0,
      u32(0),
      u32(0),
      u32(600),
      u32(1740),
      u32(0x10000),
      u16(0x100),
      zeros(10),
      identity,
      zeros(24),
      u32(2),
    ),
    box(
      "trak",
      fullBox(
        "tkhd",
        0,
        u32(0),
        u32(0),
        u32(1),
        u32(0),
        u32(1740),
        zeros(16),
        identity,
        u32(64 << 16),
        u32(48 << 16),
      ),
      box("mdia", handler),
    ),
    ...extra,
  );
};

const quickTime = (identifier: string | null) => {
  const handler = (type: string) =>
    fullBox("hdlr", 0, u32(0), ascii(type), zeros(12), u8(0));
  const key = "com.apple.quicktime.content.identifier";
  const meta = identifier
    ? [
        box(
          "meta",
          handler("mdta"),
          fullBox(
            "keys",
            0,
            u32(1),
            concat(u32(8 + key.length), ascii("mdta"), ascii(key)),
          ),
          box(
            "ilst",
            (() => {
              const data = box("data", u32(1), u32(0), ascii(identifier));
              return concat(u32(8 + data.length), u32(1), data);
            })(),
          ),
        ),
      ]
    : [];
  return concat(
    box("ftyp", ascii("qt  "), u32(0), ascii("qt  ")),
    box("mdat", zeros(16)),
    movieBox(...meta),
  );
};

const appleExifSegment = (identifier: string) => {
  const value = concat(ascii(identifier), u8(0));
  const makerNote = concat(
    ascii("Apple iOS\0"),
    u16(1),
    ascii("MM"),
    u16(1),
    u16(0x0011),
    u16(2),
    u32(value.length),
    u32(32),
    u32(0),
    value,
  );
  const tiff = concat(
    ascii("MM"),
    u16(42),
    u32(8),
    u16(1),
    u16(0x8769),
    u16(4),
    u32(1),
    u32(26),
    u32(0),
    u16(1),
    u16(0x927c),
    u16(7),
    u32(makerNote.length),
    u32(44),
    u32(0),
    makerNote,
  );
  const payload = concat(ascii("Exif\0\0"), tiff);
  return concat(u8(0xff, 0xe1), u16(payload.length + 2), payload);
};

const liveStillJpeg = async (identifier: string | null) => {
  const image = await sharp({
    create: { width: 64, height: 48, channels: 3, background: RED },
  })
    .jpeg()
    .toBuffer();
  return identifier
    ? concat(
        image.subarray(0, 2),
        appleExifSegment(identifier),
        image.subarray(2),
      )
    : image;
};

/** JPEG Motion Photo: primary JPEG with a Container directory XMP, then an MP4. */
const motionPhoto = async (lengthDelta = 0) => {
  const video = concat(
    box("ftyp", ascii("isom"), u32(0), ascii("isom")),
    movieBox(),
    box("mdat", zeros(32)),
  );
  const xmp =
    '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
    '<rdf:Description xmlns:GContainer="http://ns.google.com/photos/1.0/container/" xmlns:Item="http://ns.google.com/photos/1.0/container/item/">' +
    "<GContainer:Directory><rdf:Seq>" +
    '<rdf:li rdf:parseType="Resource"><GContainer:Item Item:Mime="image/jpeg" Item:Semantic="Primary"/></rdf:li>' +
    `<rdf:li rdf:parseType="Resource"><GContainer:Item Item:Mime="video/mp4" Item:Semantic="MotionPhoto" Item:Length="${video.length + lengthDelta}"/></rdf:li>` +
    "</rdf:Seq></GContainer:Directory></rdf:Description></rdf:RDF></x:xmpmeta>";
  const payload = concat(
    ascii("http://ns.adobe.com/xap/1.0/\0"),
    Buffer.from(xmp, "utf8"),
  );
  const image = await liveStillJpeg(null);
  return concat(
    image.subarray(0, 2),
    u8(0xff, 0xe1),
    u16(payload.length + 2),
    payload,
    image.subarray(2),
    video,
  );
};

/** A HEIC-branded still without an Exif item (decoded by the fake heif-dec). */
const heicStill = () =>
  concat(
    box("ftyp", ascii("heic"), u32(0), ascii("mif1"), ascii("heic")),
    box("mdat", zeros(16)),
  );

const motionProbeJson = (output: boolean) =>
  JSON.stringify({
    streams: [
      {
        codec_type: "video",
        codec_name: output ? "h264" : "hevc",
        width: 64,
        height: 48,
        duration: "2.900000",
        pix_fmt: "yuv420p",
        ...(output
          ? {
              color_primaries: "bt709",
              color_transfer: "bt709",
              color_space: "bt709",
              color_range: "tv",
            }
          : { side_data_list: [{ rotation: 0 }] }),
      },
      { codec_type: "audio", codec_name: "aac" },
      ...(output ? [] : [{ codec_type: "data" }]),
    ],
    format: { duration: "2.900000" },
  });

/** A minimal ISO BMFF file the coordinator's header probe accepts. */
const syntheticMp4 = () =>
  concat(
    box("ftyp", ascii("isom"), u32(0), ascii("isom")),
    box("mdat", zeros(8)),
  );

/**
 * In-sandbox tool stand-in: ffprobe prints fixed JSON, heif-dec and FFmpeg
 * write their output files. Records the tools run in order.
 */
const fakeTools = (
  options: {
    ffmpegFailure?: MediaToolError;
    decodedPng?: Buffer;
  } = {},
) => {
  const runs: { tool: string; args: readonly string[] }[] = [];
  const tools: MediaToolRunner = {
    async run(tool, args) {
      runs.push({ tool, args });
      if (tool === "ffprobe") {
        return Buffer.from(
          motionProbeJson(path.basename(args.at(-1)!) === "motion.mp4"),
        );
      }
      if (tool === "ffmpeg") {
        if (options.ffmpegFailure) throw options.ffmpegFailure;
        await writeFile(args.at(-1)!, syntheticMp4());
        return Buffer.alloc(0);
      }
      if (tool === "heif-dec" && options.decodedPng) {
        await writeFile(args.at(-1)!, options.decodedPng);
        return Buffer.alloc(0);
      }
      throw new MediaToolError("tool_failed", 1);
    },
  };
  return { tools, runs };
};

const OWNER = `user-${"2".repeat(32)}`;

let processorStoreKind: "filesystem" | "cos" = "filesystem";

const silentLogger = { error: () => undefined };

const sandboxRunner = (sandbox: ReturnType<typeof inProcessSandbox>) =>
  createSandboxRunner({
    image: IMAGE,
    workDirectory: work,
    appDist: defaultSandboxAppDist().appDist,
    spawn: sandbox.spawn,
    temporaryRoots: [],
    environment: { PATH: "/usr/bin" },
    killGraceMs: 10,
    logger: silentLogger,
  });

const setup = async (
  toolFake: ReturnType<typeof fakeTools> = fakeTools(),
  sandboxOptions: Parameters<typeof inProcessSandbox>[0] = {},
) => {
  const store =
    processorStoreKind === "cos"
      ? cosFixture().store
      : await FilesystemPublishingMediaStore.open(storeRoot, {
          temporaryRoots: [],
        });
  const sandbox = inProcessSandbox({
    tools: toolFake.tools,
    ...sandboxOptions,
  });
  const runner = await sandboxRunner(sandbox);
  const processor: PublishingMediaProcessorPort =
    createPublishingMediaProcessor({
      store,
      sandbox: runner,
      logger: silentLogger,
    });
  const put = async (bytes: Buffer) => {
    const written = await store.writeStream(
      OWNER,
      "original",
      "image/jpeg",
      bytes.length,
      (async function* () {
        yield bytes;
      })(),
    );
    return {
      storageKey: written.storageKey,
      byteSize: written.byteSize,
      sha256: written.sha256,
    };
  };
  const blobCount = async () =>
    (await store.listBlobs({ limit: 1000 })).entries.length;
  const toolsRun = () => toolFake.runs.map((run) => run.tool);
  return { store, runner, processor, put, blobCount, toolsRun, sandbox };
};

const baseInput = {
  mode: "process",
  itemId: `media-item-${"a".repeat(32)}`,
  ownerId: OWNER,
  clientPairing: null,
  editKey: "base",
  edit: { rotation: 0, crop: null },
  coverCrop: null,
} as const;

/** Asserts a contracts-valid rejection code. */
const expectRejected = (
  outcome: PublishingProcessOutcome,
  failureCode: PublishingMediaFailureCode,
) => {
  expect(outcome).toEqual({ status: "rejected", failureCode });
  expect(mediaFailureCodeSchema.options).toContain(failureCode);
};

const processed = (outcome: PublishingProcessOutcome) => {
  if (outcome.status !== "processed") {
    throw new Error(`expected processed, got ${JSON.stringify(outcome)}`);
  }
  return outcome;
};

const processorCases = () => {
  it("keeps processor, port and contracts failure codes identical", () => {
    expect(failureCodesMatchContracts).toBe(true);
  });

  it("processes a static JPEG in one sandbox job and commits WebP derivatives", async () => {
    const { store, processor, put, toolsRun, sandbox } = await setup();
    const still = await put(await orientedJpeg());
    const outcome = processed(
      await processor.process({
        ...baseInput,
        kind: "static",
        qualityMode: "original",
        components: [{ role: "still", declaredType: "image/jpeg", ...still }],
        variants: ["thumb", "display", "full"],
      }),
    );
    expect(outcome.presentation).toEqual({ width: 200, height: 300 });
    expect(mediaPresentationSchema.parse(outcome.presentation)).toEqual(
      outcome.presentation,
    );
    expect(outcome.pairing).toBeNull();
    expect(outcome.stillExifOrientation).toBe(6);
    expect(outcome).not.toHaveProperty("processingProfile");
    expect(outcome.detectedTypes).toEqual([
      { role: "still", contentType: "image/jpeg" },
    ]);
    // `viewer` would equal `display` at this size, so its recipe skips it.
    expect(
      outcome.derivatives.map((d) => [
        d.variant,
        d.editKey,
        d.contentType,
        d.width,
        d.height,
        d.recipeVersion,
      ]),
    ).toEqual([
      ["thumb", "base", "image/webp", 200, 300, 1],
      ["display", "base", "image/webp", 200, 300, 1],
      ["full", "base", "image/webp", 200, 300, 1],
    ]);
    expect(outcome.derivatives.map((d) => d.recipeDigest)).toEqual([
      "02deba84f648b4c8",
      "fa0cc28bb9865f16",
      "acb3027f6e2affec",
    ]);
    // Red over blue: the mean colour of the base thumb.
    expect(outcome.placeholderColor).toMatch(/^#[0-9a-f]{6}$/);
    expect(
      sandbox.jobs.map((job) => job.item?.renditions.map((r) => r.role)),
    ).toEqual([["thumb", "display", "viewer", "full"]]);
    // A work item edit: its viewer never repeats its full.
    expect(sandbox.jobs.map((job) => job.item?.plan)).toEqual(["work"]);
    const read = await store.openRead(outcome.derivatives[0]!.storageKey);
    if (read?.status !== "ok") throw new Error("expected derivative");
    const parts: Buffer[] = [];
    for await (const part of read.body) parts.push(part as Buffer);
    expect((await sharp(Buffer.concat(parts)).metadata()).format).toBe("webp");
    expect(toolsRun()).toEqual([]);
    expect(await readdir(work)).toEqual([]);
  });

  it.each([
    [
      "a declared type that differs from the bytes",
      async () => orientedJpeg(),
      "image/png" as const,
      "unsupported_type",
    ],
    [
      "an animated PNG",
      async () =>
        pngFile(8, 8, [
          pngChunk("acTL", Buffer.from([0, 0, 0, 2, 0, 0, 0, 0])),
        ]),
      "image/png" as const,
      "animated_image_unsupported",
    ],
    [
      "a HEIF image sequence that also lists still brands",
      async () =>
        concat(
          box(
            "ftyp",
            ascii("msf1"),
            u32(0),
            ascii("mif1"),
            ascii("heic"),
            ascii("msf1"),
          ),
          box("mdat", zeros(8)),
        ),
      "image/heic" as const,
      "animated_image_unsupported",
    ],
    [
      "a HEIF still carrying a movie box",
      async () => concat(heicStill(), movieBox()),
      "image/heic" as const,
      "animated_image_unsupported",
    ],
    [
      "a truncated PNG",
      async () => pngFile(8, 8).subarray(0, 40),
      "image/png" as const,
      "decode_failed",
    ],
  ])(
    "rejects %s before any tool runs and leaves no derivative behind",
    async (_name, bytes, declaredType, code) => {
      const { processor, put, blobCount, toolsRun } = await setup();
      const still = await put(await bytes());
      expectRejected(
        await processor.process({
          ...baseInput,
          kind: "static",
          qualityMode: "original",
          components: [{ role: "still", declaredType, ...still }],
          variants: ["thumb", "full"],
        }),
        code as PublishingMediaFailureCode,
      );
      expect(await blobCount()).toBe(1);
      expect(toolsRun()).toEqual([]);
    },
  );

  it("throws input errors for impossible layouts, base keys with edits and malformed pairing", async () => {
    const { processor, put } = await setup();
    const still = await put(await orientedJpeg());
    const staticInput: PublishingProcessInput = {
      ...baseInput,
      kind: "static",
      qualityMode: "original",
      components: [{ role: "still", declaredType: "image/jpeg", ...still }],
      variants: ["display"],
    };
    const coverCrop = { x: 0, y: 0, width: 0.5, height: 0.5 };
    for (const input of [
      { ...staticInput, kind: "live" as const },
      { ...staticInput, variants: ["motion" as const] },
      { ...staticInput, edit: { rotation: 90 as const, crop: null } },
      { ...staticInput, coverCrop, variants: ["thumb" as const] },
      { ...staticInput, editKey: "not-a-key" },
      { ...staticInput, mode: "validate" as "process" },
      {
        ...staticInput,
        kind: "live" as const,
        clientPairing: {
          method: "apple-content-identifier" as const,
          identifierSha256: null,
        },
      },
    ]) {
      await expect(processor.process(input)).rejects.toBeInstanceOf(
        MediaProcessingInputError,
      );
    }
    // `base` stays valid when the cover crop does not shape any variant.
    expect(
      (await processor.process({ ...staticInput, coverCrop })).status,
    ).toBe("processed");
  });

  it("verifies an Apple Live Photo pair on the server, keeps the client still time and produces the motion derivative", async () => {
    const { processor, put, toolsRun, blobCount, sandbox } = await setup();
    const still = await put(await liveStillJpeg(IDENTIFIER.toLowerCase()));
    const motion = await put(quickTime(IDENTIFIER));
    const outcome = processed(
      await processor.process({
        ...baseInput,
        kind: "live",
        qualityMode: "original",
        components: [
          { role: "still", declaredType: "image/jpeg", ...still },
          { role: "motion", declaredType: "video/quicktime", ...motion },
        ],
        clientPairing: {
          method: "apple-content-identifier",
          identifierSha256: contentIdentifierSha256(IDENTIFIER),
          stillTimeMs: 1500,
        },
        variants: ["thumb", "motion"],
      }),
    );
    expect(outcome.pairing).toEqual({
      method: "apple-content-identifier",
      verifiedBy: "server",
      identifierSha256: contentIdentifierSha256(IDENTIFIER),
      stillTimeMs: 1500,
    });
    expect(outcome.presentation).toEqual({
      width: 64,
      height: 48,
      durationMs: 2900,
      hasAudio: true,
      displayRotation: 0,
    });
    // The public mapper drops the private display rotation.
    const publicPresentation = { ...outcome.presentation };
    delete publicPresentation.displayRotation;
    expect(mediaPresentationSchema.parse(publicPresentation)).toEqual(
      publicPresentation,
    );
    expect(() => mediaPresentationSchema.parse(outcome.presentation)).toThrow();
    expect(outcome.stillExifOrientation).toBeNull();
    expect(
      outcome.derivatives.map((d) => [d.variant, d.contentType, d.durationMs]),
    ).toEqual([
      ["thumb", "image/webp", null],
      ["motion", "video/mp4", 2900],
    ]);
    expect(toolsRun()).toEqual(["ffprobe", "ffmpeg", "ffprobe"]);
    // One sandbox job does all of it.
    expect(sandbox.jobs).toHaveLength(1);
    expect(await blobCount()).toBe(4);
  });

  it("rejects pairing contradictions before any tool runs and trusts only a consistent client proof in Standard mode", async () => {
    const { processor, put, blobCount, toolsRun } = await setup();
    const still = await put(await liveStillJpeg(IDENTIFIER));
    const matching = await put(quickTime(IDENTIFIER));
    const other = await put(quickTime(OTHER_IDENTIFIER));
    const bare = await put(quickTime(null));
    const plainStill = await put(await liveStillJpeg(null));
    const live = (
      stillComponent: typeof still,
      motionComponent: typeof still,
      extra: Partial<PublishingProcessInput> = {},
    ): PublishingProcessInput => ({
      ...baseInput,
      kind: "live",
      qualityMode: "original",
      components: [
        { role: "still", declaredType: "image/jpeg", ...stillComponent },
        {
          role: "motion",
          declaredType: "video/quicktime",
          ...motionComponent,
        },
      ],
      variants: ["thumb"],
      ...extra,
    });
    const appleProof = {
      method: "apple-content-identifier" as const,
      identifierSha256: contentIdentifierSha256(IDENTIFIER),
    };
    const containerClaim = {
      method: "motion-photo-container" as const,
      identifierSha256: null,
    };
    for (const input of [
      live(still, other),
      live(still, bare),
      live(plainStill, bare, { qualityMode: "standard" }),
      live(plainStill, other, {
        qualityMode: "standard",
        clientPairing: appleProof,
      }),
      live(still, bare, {
        qualityMode: "standard",
        clientPairing: containerClaim,
      }),
      live(still, matching, {
        clientPairing: {
          ...appleProof,
          identifierSha256: contentIdentifierSha256(OTHER_IDENTIFIER),
        },
      }),
    ]) {
      expectRejected(await processor.process(input), "pairing_mismatch");
    }
    expect(toolsRun()).toEqual([]);
    // A still time beyond the motion is known only after probing.
    expectRejected(
      await processor.process(
        live(still, matching, {
          clientPairing: { ...appleProof, stillTimeMs: 5000 },
        }),
      ),
      "pairing_mismatch",
    );
    expect(toolsRun()).toEqual(["ffprobe"]);
    const accepted = processed(
      await processor.process(
        live(plainStill, bare, {
          qualityMode: "standard",
          clientPairing: appleProof,
        }),
      ),
    );
    expect(accepted.pairing).toEqual({ ...appleProof, verifiedBy: "client" });
    const container = processed(
      await processor.process(
        live(plainStill, bare, {
          qualityMode: "standard",
          clientPairing: { ...containerClaim, stillTimeMs: 800 },
        }),
      ),
    );
    expect(container.pairing).toEqual({
      method: "motion-photo-container",
      verifiedBy: "client",
      identifierSha256: null,
      stillTimeMs: 800,
    });
    expect(await blobCount()).toBe(7);
  });

  it("splits a Motion Photo package on the server without an identifier digest and rejects inconsistent directories", async () => {
    const { processor, put, blobCount, toolsRun } = await setup();
    const packaged = await put(await motionPhoto());
    const input: PublishingProcessInput = {
      ...baseInput,
      kind: "live",
      qualityMode: "original",
      components: [
        { role: "package", declaredType: "image/jpeg", ...packaged },
      ],
      variants: ["thumb", "motion"],
    };
    const outcome = processed(await processor.process(input));
    expect(outcome.detectedTypes).toEqual([
      { role: "package", contentType: "image/jpeg" },
    ]);
    expect(outcome.pairing).toEqual({
      method: "motion-photo-container",
      verifiedBy: "server",
      identifierSha256: null,
    });
    expect(outcome.presentation).toMatchObject({
      width: 64,
      height: 48,
      durationMs: 2900,
    });
    expect(outcome.derivatives.map((d) => d.variant)).toEqual([
      "thumb",
      "motion",
    ]);
    expect(toolsRun()).toEqual(["ffprobe", "ffmpeg", "ffprobe"]);
    const inconsistent = await put(await motionPhoto(1));
    expectRejected(
      await processor.process({
        ...input,
        components: [
          { role: "package", declaredType: "image/jpeg", ...inconsistent },
        ],
      }),
      "decode_failed",
    );
    const plain = await put(await liveStillJpeg(null));
    expectRejected(
      await processor.process({
        ...input,
        components: [{ role: "package", declaredType: "image/jpeg", ...plain }],
      }),
      "unsupported_type",
    );
    expect(await blobCount()).toBe(5);
  });

  it("decodes HEIC with heif-dec inside the sandbox, into its scratch directory", async () => {
    const decodedPng = await sharp({
      create: { width: 40, height: 30, channels: 3, background: BLUE },
    })
      .png()
      .toBuffer();
    const toolFake = fakeTools({ decodedPng });
    const { processor, put, toolsRun } = await setup(toolFake);
    const still = await put(heicStill());
    const motion = await put(quickTime(null));
    const outcome = processed(
      await processor.process({
        ...baseInput,
        kind: "live",
        qualityMode: "standard",
        components: [
          { role: "still", declaredType: "image/heic", ...still },
          { role: "motion", declaredType: "video/quicktime", ...motion },
        ],
        clientPairing: {
          method: "apple-content-identifier",
          identifierSha256: contentIdentifierSha256(IDENTIFIER),
        },
        variants: ["thumb", "motion"],
      }),
    );
    expect(toolsRun()).toEqual(["heif-dec", "ffprobe", "ffmpeg", "ffprobe"]);
    // heif-dec reads the read-only staged still and writes to the scratch
    // directory; FFmpeg writes the motion output directly to the output tmpfs.
    const [heif, , ffmpeg] = toolFake.runs;
    expect(path.basename(heif!.args.at(-2)!)).toBe("still");
    expect(path.basename(heif!.args.at(-1)!)).toBe("still.png");
    expect(path.dirname(heif!.args.at(-1)!)).not.toBe(
      path.dirname(heif!.args.at(-2)!),
    );
    expect(path.basename(ffmpeg!.args.at(-1)!)).toBe("motion.mp4");
    expect(outcome.detectedTypes).toEqual([
      { role: "still", contentType: "image/heic" },
      { role: "motion", contentType: "video/quicktime" },
    ]);
    expect(outcome.presentation).toMatchObject({ width: 40, height: 30 });
    expect(outcome.stillExifOrientation).toBeNull();
  });

  it("derives an edit from only the components its variants need, without re-verifying pairing", async () => {
    const { store, runner, put, toolsRun } = await setup();
    const reads: string[] = [];
    const countingStore = {
      openRead: (key: string) => {
        reads.push(key);
        return store.openRead(key);
      },
      writeStream: store.writeStream.bind(store),
      remove: store.remove.bind(store),
    };
    const processor: PublishingMediaProcessorPort =
      createPublishingMediaProcessor({
        store: countingStore,
        sandbox: runner,
        logger: silentLogger,
      });
    const still = await put(await orientedJpeg());
    const motion = await put(quickTime(OTHER_IDENTIFIER));
    const input: PublishingProcessInput = {
      ...baseInput,
      mode: "derive",
      kind: "live",
      qualityMode: "original",
      components: [
        { role: "still", declaredType: "image/jpeg", ...still },
        { role: "motion", declaredType: "video/quicktime", ...motion },
      ],
      editKey: "e".repeat(32),
      edit: { rotation: 90, crop: null },
      coverCrop: { x: 0.5, y: 0, width: 0.5, height: 1 },
      variants: ["cover"],
    };
    const cover = await processor.process(input);
    expect(cover.status).toBe("derived");
    if (cover.status !== "derived") throw new Error("expected derived");
    expect(
      cover.derivatives.map((d) => [d.variant, d.editKey, d.width, d.height]),
    ).toEqual([["cover", "e".repeat(32), 150, 200]]);
    expect(reads).toEqual([still.storageKey]);
    expect(toolsRun()).toEqual([]);
    const moving = await processor.process({
      ...input,
      variants: ["motion"],
    });
    expect(moving.status).toBe("derived");
    expect(reads.slice(1)).toEqual([motion.storageKey]);
    expect(toolsRun()).toEqual(["ffprobe", "ffmpeg", "ffprobe"]);
    expect(await readdir(work)).toEqual([]);
  });

  it("rejects a timeout during processing but retries it for an edit derivation, cleaning derivatives", async () => {
    const { processor, put, blobCount } = await setup(
      fakeTools({ ffmpegFailure: new MediaToolError("timeout") }),
    );
    const still = await put(await liveStillJpeg(IDENTIFIER));
    const motion = await put(quickTime(IDENTIFIER));
    const input: PublishingProcessInput = {
      ...baseInput,
      kind: "live",
      qualityMode: "original",
      components: [
        { role: "still", declaredType: "image/jpeg", ...still },
        { role: "motion", declaredType: "video/quicktime", ...motion },
      ],
      variants: ["thumb", "motion"],
    };
    expectRejected(await processor.process(input), "processing_timeout");
    await expect(
      processor.process({ ...input, mode: "derive" }),
    ).rejects.toMatchObject({ name: "MediaToolError", code: "timeout" });
    expect(await blobCount()).toBe(2);
  });

  it("maps a failing transcoder to a rejection and a sandbox outage to a retryable failure, cleaning derivatives", async () => {
    const failing = await setup(
      fakeTools({ ffmpegFailure: new MediaToolError("tool_failed", 1) }),
    );
    const still = await failing.put(await liveStillJpeg(IDENTIFIER));
    const motion = await failing.put(quickTime(IDENTIFIER));
    const input: PublishingProcessInput = {
      ...baseInput,
      kind: "live",
      qualityMode: "original",
      components: [
        { role: "still", declaredType: "image/jpeg", ...still },
        { role: "motion", declaredType: "video/quicktime", ...motion },
      ],
      variants: ["thumb", "motion"],
    };
    expectRejected(await failing.processor.process(input), "processing_failed");
    expect(await failing.blobCount()).toBe(2);

    await rm(storeRoot, { recursive: true, force: true });
    await mkdir(storeRoot, { mode: 0o700 });
    // A tool that cannot start is the renderer's internal failure (exit 70).
    const broken = await setup(
      fakeTools({ ffmpegFailure: new MediaToolError("spawn_failed") }),
    );
    const again = {
      ...input,
      components: [
        {
          role: "still" as const,
          declaredType: "image/jpeg" as const,
          ...(await broken.put(await liveStillJpeg(IDENTIFIER))),
        },
        {
          role: "motion" as const,
          declaredType: "video/quicktime" as const,
          ...(await broken.put(quickTime(IDENTIFIER))),
        },
      ],
    };
    await expect(broken.processor.process(again)).rejects.toBeInstanceOf(
      MediaProcessingUnavailableError,
    );
    // A missing image or daemon (`docker run` exit 125) is retried too.
    const outage = await setup(fakeTools(), {
      exitCode: 125,
      stream: async () => Buffer.alloc(0),
    });
    await expect(
      outage.processor.process({
        ...input,
        components: [
          {
            role: "still",
            declaredType: "image/jpeg",
            ...(await outage.put(await liveStillJpeg(IDENTIFIER))),
          },
          {
            role: "motion",
            declaredType: "video/quicktime",
            ...(await outage.put(quickTime(IDENTIFIER))),
          },
        ],
      }),
    ).rejects.toMatchObject({
      name: "MediaToolError",
      code: "sandbox_unavailable",
    });
    // Only the components remain in each store; no rendition was written.
    expect(await outage.blobCount()).toBe(processorStoreKind === "cos" ? 2 : 4);
    expect(await readdir(work)).toEqual([]);
  });

  it("wraps unexpected infrastructure errors without paths", async () => {
    const { store, runner, put } = await setup();
    const still = await put(await orientedJpeg());
    const brokenStore = {
      openRead: async () => {
        throw Object.assign(
          new Error(`EIO: i/o error, open '${storeRoot}/blobs/secret'`),
          { code: "EIO", path: `${storeRoot}/blobs/secret` },
        );
      },
      writeStream: store.writeStream.bind(store),
      remove: store.remove.bind(store),
    };
    const processor = createPublishingMediaProcessor({
      store: brokenStore,
      sandbox: runner,
      logger: silentLogger,
    });
    const failure = await processor
      .process({
        ...baseInput,
        kind: "static",
        qualityMode: "original",
        components: [{ role: "still", declaredType: "image/jpeg", ...still }],
        variants: ["thumb"],
      })
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(failure).toBeInstanceOf(MediaProcessingUnavailableError);
    expect(failure).toMatchObject({ systemCode: "EIO" });
    expect(JSON.stringify(failure)).not.toContain(storeRoot);
    expect((failure as Error).message).not.toContain(storeRoot);
    expect(await readdir(work)).toEqual([]);
  });
};

describe.each(["filesystem", "cos"] as const)(
  "publishing media processor (%s)",
  (kind) => {
    beforeEach(() => {
      processorStoreKind = kind;
    });
    processorCases();
  },
);

describe("publishing media processor legacy user media stills", () => {
  const LEGACY_MEDIA_ID = `user-media-${"3".repeat(32)}`;
  const translucentPng = () =>
    sharp({
      create: {
        width: 40,
        height: 20,
        channels: 4,
        background: { r: 200, g: 10, b: 10, alpha: 0.5 },
      },
    })
      .png()
      .toBuffer();
  const legacyInput = (
    bytes: Buffer,
    extra: Partial<ProcessorInput> = {},
  ): ProcessorInput => ({
    ...baseInput,
    mode: "derive",
    kind: "static",
    qualityMode: "standard",
    source: {
      kind: "legacy_user_media",
      legacyMediaId: LEGACY_MEDIA_ID,
      byteSize: bytes.byteLength,
      contentType: "image/png",
    },
    legacyStill: bytes,
    components: [],
    editKey: "f".repeat(32),
    edit: { rotation: 90, crop: null },
    coverCrop: { x: 0, y: 0, width: 1, height: 0.5 },
    variants: ["thumb", "display", "cover"],
    ...extra,
  });
  const storedBlobs = async (count: () => Promise<number>) =>
    count().catch(() => 0);
  const legacyProcessor = (
    store: Awaited<ReturnType<typeof setup>>["store"],
    runner: Awaited<ReturnType<typeof setup>>["runner"],
  ) =>
    createPublishingMediaProcessor({
      store,
      sandbox: runner,
      logger: silentLogger,
    });

  it("derives an edited legacy PNG from the job input and stores only its derivatives", async () => {
    const { store, runner, blobCount, toolsRun } = await setup();
    const processor = legacyProcessor(store, runner);
    const png = await translucentPng();
    const untouched = Buffer.from(png);
    const outcome = await processor.process(legacyInput(png));
    if (outcome.status !== "derived") {
      throw new Error(`expected derived, got ${JSON.stringify(outcome)}`);
    }
    // Rotated to 20 × 40; the card variants take the upper half.
    expect(
      outcome.derivatives.map((d) => [
        d.variant,
        d.editKey,
        d.contentType,
        d.width,
        d.height,
      ]),
    ).toEqual([
      ["thumb", "f".repeat(32), "image/webp", 20, 20],
      ["cover", "f".repeat(32), "image/webp", 20, 20],
      ["display", "f".repeat(32), "image/webp", 20, 40],
    ]);
    // An edit key other than `base` never carries a placeholder colour.
    expect(outcome).not.toHaveProperty("placeholderColor");
    const read = await store.openRead(outcome.derivatives[2]!.storageKey);
    if (read?.status !== "ok") throw new Error("expected derivative");
    const parts: Buffer[] = [];
    for await (const part of read.body) parts.push(part as Buffer);
    const metadata = await sharp(Buffer.concat(parts)).metadata();
    expect([metadata.format, metadata.hasAlpha]).toEqual(["webp", true]);
    // Only derivatives were stored; the source never enters the media store.
    expect(await storedBlobs(blobCount)).toBe(3);
    expect(png.equals(untouched)).toBe(true);
    expect(toolsRun()).toEqual([]);
    expect(await readdir(work)).toEqual([]);
  });

  it("rejects legacy bytes that are not a still PNG without storing anything", async () => {
    const { store, runner, blobCount, toolsRun } = await setup();
    const processor = legacyProcessor(store, runner);
    const jpeg = await orientedJpeg();
    expectRejected(
      await processor.process(legacyInput(jpeg)),
      "unsupported_type",
    );
    const animated = pngFile(8, 8, [
      pngChunk("acTL", Buffer.from([0, 0, 0, 2, 0, 0, 0, 0])),
    ]);
    expectRejected(
      await processor.process(legacyInput(animated)),
      "animated_image_unsupported",
    );
    expect(await storedBlobs(blobCount)).toBe(0);
    expect(toolsRun()).toEqual([]);
    expect(await readdir(work)).toEqual([]);
  });

  it("throws input errors for legacy sources outside an edit of a static item", async () => {
    const { store, runner, put } = await setup();
    const processor = legacyProcessor(store, runner);
    const png = await translucentPng();
    const valid = legacyInput(png);
    const source = valid.source as Extract<
      ProcessorInput["source"],
      { kind: "legacy_user_media" }
    >;
    const still = await put(await orientedJpeg());
    const upload: ProcessorInput = {
      ...baseInput,
      mode: "derive",
      kind: "static",
      qualityMode: "original",
      components: [{ role: "still", declaredType: "image/jpeg", ...still }],
      variants: ["display"],
    };
    for (const input of [
      { ...valid, mode: "process" as const },
      { ...valid, kind: "live" as const, variants: ["display" as const] },
      { ...valid, components: upload.components },
      { ...valid, legacyStill: png.subarray(1) },
      // A legacy source without the bytes the worker reads for it.
      { ...valid, legacyStill: undefined } as unknown as ProcessorInput,
      { ...valid, source: { ...source, byteSize: 4 * 1024 * 1024 + 1 } },
      { ...valid, source: { ...source, legacyMediaId: "user-media-1" } },
      {
        ...valid,
        source: { ...source, contentType: "image/jpeg" as "image/png" },
      },
      { ...upload, legacyStill: png },
      // Legacy edits carry the standard quality mode; no other mode exists.
      { ...valid, qualityMode: "legacy" as unknown as "standard" },
    ]) {
      await expect(processor.process(input)).rejects.toBeInstanceOf(
        MediaProcessingInputError,
      );
    }
    expect((await processor.process(upload)).status).toBe("derived");
    expect(
      (await processor.process({ ...upload, source: { kind: "upload" } }))
        .status,
    ).toBe("derived");
    expect(await readdir(work)).toEqual([]);
  });
});
