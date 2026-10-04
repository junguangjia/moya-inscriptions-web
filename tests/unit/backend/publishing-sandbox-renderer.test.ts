import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  STILL_INPUT_LIMITS,
  bufferByteReader,
  currentRecipe,
  expectedStillSize,
  inspectStaticSource,
  placeholderColour,
  probeWebp,
  renderStaticDerivative,
} from "@moya/backend-production/internal/publishing-processing";
import {
  SANDBOX_JOB_LIMITS,
  configureSandboxSharp,
  loaderAllowlistHolds,
  renderSandboxJob,
} from "@moya/backend-production/internal/publishing-sandbox";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { StillRole } from "@moya/backend-production/internal/publishing-processing";
import type {
  SandboxJob,
  SandboxRenderBody,
} from "@moya/backend-production/internal/publishing-sandbox";

/*
 * The sandboxed renderer, run in-process with the real sharp on small
 * synthetic fixtures: colour management (Display P3 → untagged sRGB), EXIF
 * orientation, alpha, long scrolls, the viewer skip rule, metadata stripping,
 * the placeholder colour and the decode bounds. The pre-task still chain must
 * stay byte-identical for every recipe version 1.
 */

let base: string;
let paths: { input: string; work: string; output: string };

beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), "sandbox-renderer-"));
  paths = {
    input: path.join(base, "in"),
    work: path.join(base, "work"),
    output: path.join(base, "out"),
  };
  for (const directory of Object.values(paths)) await mkdir(directory);
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const noTools = {
  run: async () => {
    throw new Error("no media tool for stills");
  },
};

const ALL_STILLS: readonly StillRole[] = [
  "thumb",
  "cover",
  "display",
  "viewer",
  "full",
];

const deriveJob = (
  bytes: Buffer,
  declaredType: "image/jpeg" | "image/png" | "image/webp",
  extra: Partial<NonNullable<SandboxJob["item"]>> = {},
  limits: Partial<SandboxJob["limits"]> = {},
): SandboxJob => ({
  protocol: 1,
  nonce: "a".repeat(32),
  operation: "derive",
  item: {
    kind: "static",
    qualityMode: "standard",
    inputs: [
      {
        role: "still",
        declaredType,
        byteSize: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    ],
    clientPairing: null,
    edit: { rotation: 0, crop: null },
    coverCrop: null,
    renditions: ALL_STILLS.map((role) => {
      const recipe = currentRecipe(role);
      return { role, version: recipe.version, digest: recipe.digest };
    }),
    motion: false,
    placeholder: true,
    ...extra,
  },
  limits: { ...SANDBOX_JOB_LIMITS, ...limits },
});

const render = async (job: SandboxJob, bytes: Buffer) => {
  await writeFile(path.join(paths.input, "still"), bytes);
  return renderSandboxJob(job, paths, noTools);
};

const derived = (body: SandboxRenderBody) => {
  if (body.status !== "derived") {
    throw new Error(`expected derived, got ${JSON.stringify(body)}`);
  }
  return body;
};

const outputFile = (name: string) => readFile(path.join(paths.output, name));

const pixel = async (image: Buffer, x: number, y: number) => {
  const { data, info } = await sharp(image)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const offset = (y * info.width + x) * info.channels;
  return [...data.subarray(offset, offset + info.channels)];
};

/** Asserts a WebP rendition has no metadata chunk and returns its size. */
const plainWebp = async (image: Buffer) => {
  const probe = await probeWebp(bufferByteReader(image));
  expect(probe).not.toBeNull();
  const metadata = await sharp(image).metadata();
  expect([metadata.format, metadata.exif, metadata.xmp, metadata.icc]).toEqual([
    "webp",
    undefined,
    undefined,
    undefined,
  ]);
  expect(metadata.orientation).toBeUndefined();
  return probe!;
};

const RED = { r: 255, g: 0, b: 0 };
const BLUE = { r: 0, g: 0, b: 255 };

/** 300×200 JPEG (left half red) displayed with EXIF orientation 6 (portrait). */
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

/**
 * A Display P3 JPEG of the most saturated sRGB green: its P3 code values are
 * well inside the P3 gamut, so ignoring the profile would wash it out.
 */
const p3Jpeg = () =>
  sharp({
    create: {
      width: 96,
      height: 64,
      channels: 3,
      background: { r: 0, g: 255, b: 0 },
    },
  })
    .withIccProfile("p3")
    .jpeg({ quality: 98, chromaSubsampling: "4:4:4" })
    .toBuffer();

describe("media sandbox renderer (in-process, real sharp)", () => {
  it("converts a Display P3 source to untagged sRGB, honouring its profile", async () => {
    const input = await p3Jpeg();
    expect((await sharp(input).metadata()).icc).toBeDefined();
    const body = derived(await render(deriveJob(input, "image/jpeg"), input));
    const display = await outputFile("display.webp");
    await plainWebp(display);
    const [r, g, b] = await pixel(display, 48, 32);
    // Colour-managed: the green stays sRGB green.
    expect(g).toBeGreaterThan(240);
    expect(r).toBeLessThan(20);
    expect(b).toBeLessThan(20);
    // Rendering the same code values as if they were sRGB is visibly different.
    const naive = await sharp(input, { ignoreIcc: true }).webp().toBuffer();
    const [naiveRed, , naiveBlue] = await pixel(naive, 48, 32);
    expect(
      Math.abs(naiveRed! - r!) + Math.abs(naiveBlue! - b!),
    ).toBeGreaterThan(60);
    expect(body.inspection).toEqual({ width: 96, height: 64, hasAlpha: false });
  });

  it("bakes EXIF orientation 6, strips every metadata chunk and frames card roles with the cover crop", async () => {
    const input = await orientedJpeg();
    const job = deriveJob(input, "image/jpeg", {
      edit: { rotation: 90, crop: null },
      coverCrop: { x: 0.5, y: 0, width: 0.5, height: 1 },
      placeholder: false,
    });
    const body = derived(await render(job, input));
    expect(body.inspection).toEqual({
      width: 200,
      height: 300,
      hasAlpha: false,
    });
    expect(
      body.outputs.map((output) => [output.role, output.width, output.height]),
    ).toEqual([
      ["thumb", 150, 200],
      ["cover", 150, 200],
      ["display", 300, 200],
      ["full", 300, 200],
    ]);
    for (const output of body.outputs) {
      const bytes = await outputFile(output.name);
      expect(output.bytes).toBe(bytes.byteLength);
      expect(output.sha256).toBe(
        createHash("sha256").update(bytes).digest("hex"),
      );
      expect(await plainWebp(bytes)).toMatchObject({
        width: output.width,
        height: output.height,
      });
      expect(
        expectedStillSize(
          output.role as StillRole,
          body.inspection!,
          job.item!.edit,
          job.item!.coverCrop,
        ),
      ).toEqual({ width: output.width, height: output.height });
    }
    // Orientation 6 puts red on top; rotating 90° clockwise puts it on the right.
    const [r, , b] = await pixel(await outputFile("display.webp"), 280, 100);
    expect(r).toBeGreaterThan(200);
    expect(b).toBeLessThan(60);
    // The card roles show the right half (red) only.
    expect(
      (await pixel(await outputFile("cover.webp"), 75, 100))[0],
    ).toBeGreaterThan(200);
    expect(body.placeholderColor).toBeNull();
  });

  it("keeps alpha, and has no placeholder colour for a transparent image", async () => {
    const translucent = await sharp({
      create: {
        width: 120,
        height: 80,
        channels: 4,
        background: { r: 200, g: 10, b: 10, alpha: 0.5 },
      },
    })
      .png()
      .toBuffer();
    const body = derived(
      await render(deriveJob(translucent, "image/png"), translucent),
    );
    for (const output of body.outputs) {
      const probe = await plainWebp(await outputFile(output.name));
      expect(probe.hasAlpha).toBe(true);
      expect(
        (await sharp(await outputFile(output.name)).metadata()).hasAlpha,
      ).toBe(true);
    }
    expect(body.placeholderColor).toBeNull();
  });

  it("computes the placeholder colour from the opaque thumb", async () => {
    const opaque = await sharp({
      create: {
        width: 64,
        height: 64,
        channels: 3,
        background: { r: 200, g: 100, b: 50 },
      },
    })
      .png()
      .toBuffer();
    const body = derived(await render(deriveJob(opaque, "image/png"), opaque));
    expect(body.placeholderColor).toMatch(/^#[0-9a-f]{6}$/);
    const [r, g, b] = [1, 3, 5].map((index) =>
      parseInt(body.placeholderColor!.slice(index, index + 2), 16),
    );
    expect(
      Math.abs(r! - 200) + Math.abs(g! - 100) + Math.abs(b! - 50),
    ).toBeLessThan(8);
    expect(await placeholderColour(path.join(paths.output, "thumb.webp"))).toBe(
      body.placeholderColor,
    );
  });

  it("renders a long scroll with the short-edge rules and a viewer between display and full", async () => {
    const tall = await sharp({
      create: {
        width: 1300,
        height: 3400,
        channels: 3,
        background: { r: 30, g: 60, b: 90 },
      },
    })
      .jpeg({ quality: 80 })
      .toBuffer();
    const body = derived(
      await render(deriveJob(tall, "image/jpeg", { placeholder: false }), tall),
    );
    expect(
      body.outputs.map((output) => [output.role, output.width, output.height]),
    ).toEqual([
      ["thumb", 184, 480],
      ["cover", 413, 1080],
      ["display", 1280, 3348],
      ["viewer", 1300, 3400],
      ["full", 1300, 3400],
    ]);
  });

  it("skips the viewer when it would equal display", async () => {
    const input = await sharp({
      create: { width: 640, height: 480, channels: 3, background: BLUE },
    })
      .jpeg()
      .toBuffer();
    const body = derived(await render(deriveJob(input, "image/jpeg"), input));
    expect(body.outputs.map((output) => output.role)).toEqual([
      "thumb",
      "cover",
      "display",
      "full",
    ]);
  });

  it("refuses decoded sizes, truncated bytes and mislabelled formats with precise codes", async () => {
    const input = await sharp({
      create: { width: 64, height: 64, channels: 3, background: RED },
    })
      .png()
      .toBuffer();
    // 64 × 64 × 3 bytes = 12,288 decoded bytes.
    expect(
      await render(
        deriveJob(input, "image/png", {}, { maxDecodedBytes: 12_287 }),
        input,
      ),
    ).toMatchObject({ status: "rejected", failureCode: "dimensions_exceeded" });
    await rm(path.join(paths.input, "still"));
    expect(
      await render(
        deriveJob(input, "image/png", {}, { maxPixels: 4095 }),
        input,
      ),
    ).toMatchObject({ status: "rejected", failureCode: "dimensions_exceeded" });
    await rm(path.join(paths.input, "still"));
    const jpeg = await orientedJpeg();
    const truncated = jpeg.subarray(0, Math.floor(jpeg.byteLength / 2));
    expect(
      await render(deriveJob(truncated, "image/jpeg"), truncated),
    ).toMatchObject({ status: "rejected", failureCode: "decode_failed" });
    await rm(path.join(paths.input, "still"));
    const gif = await sharp({
      create: { width: 8, height: 8, channels: 3, background: RED },
    })
      .gif()
      .toBuffer();
    expect(await render(deriveJob(gif, "image/jpeg"), gif)).toMatchObject({
      status: "rejected",
      failureCode: "unsupported_type",
    });
    expect(
      await inspectStaticSource(
        { input, autoOrient: true, expectedFormat: "png" },
        { maxDecodedBytes: 12_288 },
      ),
    ).toMatchObject({ width: 64, height: 64 });
  });

  it("keeps the pre-task still chain byte-identical for every version 1 role", async () => {
    const fixtures = {
      p3: { bytes: await p3Jpeg(), format: "jpeg" as const },
      oriented: { bytes: await orientedJpeg(), format: "jpeg" as const },
      alpha: {
        bytes: await sharp({
          create: {
            width: 90,
            height: 60,
            channels: 4,
            background: { r: 9, g: 99, b: 199, alpha: 0.3 },
          },
        })
          .png()
          .toBuffer(),
        format: "png" as const,
      },
      grey: {
        bytes: await sharp({
          create: {
            width: 70,
            height: 50,
            channels: 3,
            background: { r: 90, g: 90, b: 90 },
          },
        })
          .greyscale()
          .jpeg()
          .toBuffer(),
        format: "jpeg" as const,
      },
      wide16: {
        bytes: await sharp({
          create: {
            width: 80,
            height: 50,
            channels: 3,
            background: { r: 10, g: 200, b: 30 },
          },
        })
          .toColourspace("rgb16")
          .png()
          .toBuffer(),
        format: "png" as const,
      },
    };
    const qualities = { thumb: 80, cover: 86, display: 86, full: 90 } as const;
    for (const [name, fixture] of Object.entries(fixtures)) {
      const source = {
        input: fixture.bytes,
        autoOrient: true,
        expectedFormat: fixture.format,
      };
      const inspection = await inspectStaticSource(source);
      for (const role of ["thumb", "cover", "display", "full"] as const) {
        const target = expectedStillSize(
          role,
          inspection,
          { rotation: 0, crop: null },
          null,
        )!;
        // The pre-task chain: decode limits, resize when smaller, WebP quality.
        let legacy = sharp(fixture.bytes, {
          limitInputPixels: STILL_INPUT_LIMITS.limitInputPixels,
          failOn: STILL_INPUT_LIMITS.failOn,
          pages: STILL_INPUT_LIMITS.pages,
          autoOrient: true,
        });
        if (
          target.width !== inspection.width ||
          target.height !== inspection.height
        )
          legacy = legacy.resize(target.width, target.height, { fit: "fill" });
        const expected = await legacy
          .webp({ quality: qualities[role] })
          .toBuffer();
        const rendered = await renderStaticDerivative(
          source,
          inspection,
          role,
          { rotation: 0, crop: null },
          null,
        );
        expect(rendered.buffer.equals(expected), `${name} ${role}`).toBe(true);
      }
    }
  });

  it("allows only the JPEG, PNG and WebP file loaders once configured for the sandbox", async () => {
    configureSandboxSharp();
    try {
      expect(await loaderAllowlistHolds(base)).toBe(true);
      const png = await sharp({
        create: { width: 4, height: 4, channels: 3, background: RED },
      })
        .png()
        .toBuffer();
      // Buffer loaders are blocked too: the renderer reads job files only.
      await expect(sharp(png).metadata()).rejects.toThrow();
    } finally {
      sharp.unblock({ operation: ["VipsForeignLoad"] });
      sharp.cache({ memory: 50, files: 20, items: 100 });
      sharp.concurrency(0);
    }
  });
});
