import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  BLOCK_RECIPE_DIGEST_V1,
  BLOCK_RECIPE_V1,
  blockCellRegion,
  blockGrid,
  bufferByteReader,
  probeJpegBlock,
  recipeDigest,
} from "@moya/backend-production/internal/publishing-processing";
import {
  SANDBOX_JOB_LIMITS,
  SANDBOX_PROTOCOL_VERSION,
  SandboxJobError,
  SandboxProtocolError,
  itemOutput,
  itemRejection,
  parseSandboxJob,
  parseSandboxManifest,
  renderSandboxBlocksJob,
  sandboxManifest,
} from "@moya/backend-production/internal/publishing-sandbox";
import { catalogBlockCell } from "@moya/community-postgres";
import {
  CATALOG_ZOOM_BLOCK_EDGE,
  CATALOG_ZOOM_BLOCK_OVERLAP,
  CATALOG_ZOOM_BLOCKS_MAXIMUM,
  CATALOG_ZOOM_MAX_LONG_EDGE,
} from "@moya/contracts/schemas";
import sharp from "sharp";
import { afterAll, describe, expect, it } from "vitest";

import type { SandboxJob } from "@moya/backend-production/internal/publishing-sandbox";

/*
 * catalog-deep-zoom-v1 (Issue #295) criterion 4 with real sharp: the `blocks`
 * operation of the sandboxed renderer, run in-process on synthetic masters.
 * Blocks cover the frame on the 1024 grid with up to 2 px more on the right
 * and bottom, are baseline JPEG q85 4:4:4 without APP1/APP2 (untagged sRGB,
 * also from a Display-P3 master), keep PSNR ≥ 38 dB against the frame, and a
 * transparent, shifted or different master is refused. The `block@1` digest
 * is pinned and the geometry matches the community store's.
 */

const roots: string[] = [];
afterAll(async () => {
  await Promise.all(
    roots.map((root) => rm(root, { recursive: true, force: true })),
  );
});

const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

/** A textured synthetic image: gradients plus a deterministic pattern. */
const texture = (
  width: number,
  height: number,
  channels: 3 | 4 = 3,
  shift = 0,
) => {
  const data = Buffer.alloc(width * height * channels);
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      const sx = x + shift;
      const sy = y + shift;
      const offset = (y * width + x) * channels;
      data[offset] = (sx * 255) / width;
      data[offset + 1] = (sy * 255) / height;
      data[offset + 2] = 128 + 100 * Math.sin(sx / 23) * Math.cos(sy / 31);
      if (channels === 4) data[offset + 3] = x < width / 2 ? 255 : 180;
    }
  return sharp(data, { raw: { width, height, channels } });
};

const display = (input: Buffer) =>
  sharp(input, { autoOrient: true })
    .toColourspace("srgb")
    .resize({ width: 2048, height: 2048, fit: "inside", kernel: "lanczos3" })
    .webp({ quality: 86, effort: 4, smartSubsample: false })
    .toBuffer({ resolveWithObject: true });

interface Setup {
  readonly paths: { input: string; work: string; output: string };
  readonly job: SandboxJob;
  readonly master: Buffer;
}

const setup = async (options: {
  readonly master: Buffer;
  readonly masterType?: "image/jpeg" | "image/png";
  readonly reference?: Buffer;
  readonly masterSize?: { width: number; height: number };
  /** The reference size the job records, when it differs from the file. */
  readonly referenceSize?: { width: number; height: number };
  readonly frameLongEdge?: number;
  readonly cells?: [number, number];
}): Promise<Setup> => {
  const root = await mkdtemp(path.join(tmpdir(), "catalog-blocks-"));
  roots.push(root);
  const paths = {
    input: path.join(root, "in"),
    work: path.join(root, "work"),
    output: path.join(root, "out"),
  };
  await Promise.all(Object.values(paths).map((directory) => mkdir(directory)));
  const meta = await sharp(options.master, { autoOrient: true }).metadata();
  const masterSize = options.masterSize ?? {
    width: meta.autoOrient.width,
    height: meta.autoOrient.height,
  };
  const long = Math.max(masterSize.width, masterSize.height);
  const limit = Math.min(
    long,
    options.frameLongEdge ?? CATALOG_ZOOM_MAX_LONG_EDGE,
  );
  const frame =
    masterSize.width >= masterSize.height
      ? { width: limit, height: Math.round((masterSize.height * limit) / long) }
      : { width: Math.round((masterSize.width * limit) / long), height: limit };
  const reference = options.reference ?? (await display(options.master)).data;
  const referenceMeta = await sharp(reference).metadata();
  await writeFile(path.join(paths.input, "master"), options.master);
  await writeFile(path.join(paths.input, "reference"), reference);
  const cells = options.cells ?? [
    0,
    blockGrid(frame.width, frame.height).cells - 1,
  ];
  const job = parseSandboxJob({
    protocol: SANDBOX_PROTOCOL_VERSION,
    nonce: "0".repeat(32),
    operation: "blocks",
    item: null,
    blocks: {
      inputs: [
        {
          role: "master",
          declaredType: options.masterType ?? "image/jpeg",
          byteSize: options.master.byteLength,
          sha256: sha(options.master),
        },
        {
          role: "reference",
          declaredType: "image/webp",
          byteSize: reference.byteLength,
          sha256: sha(reference),
        },
      ],
      master: masterSize,
      frame,
      reference: options.referenceSize ?? {
        width: referenceMeta.width,
        height: referenceMeta.height,
      },
      cells,
      recipe: {
        version: BLOCK_RECIPE_V1.version,
        digest: BLOCK_RECIPE_DIGEST_V1,
      },
    },
    limits: SANDBOX_JOB_LIMITS,
  });
  return { paths, job, master: options.master };
};

const psnr = (left: Buffer, right: Buffer) => {
  let squared = 0;
  for (let index = 0; index < left.length; index += 1)
    squared += (left[index]! - right[index]!) ** 2;
  const mse = squared / left.length;
  return mse === 0 ? 99 : 10 * Math.log10((255 * 255) / mse);
};

describe("Catalog block recipe and geometry", () => {
  it("pins block@1 and matches the public contract and the store's geometry", () => {
    expect(recipeDigest(BLOCK_RECIPE_V1)).toBe(BLOCK_RECIPE_DIGEST_V1);
    expect(BLOCK_RECIPE_V1.grid.edge).toBe(CATALOG_ZOOM_BLOCK_EDGE);
    expect(BLOCK_RECIPE_V1.grid.overlap).toBe(CATALOG_ZOOM_BLOCK_OVERLAP);
    expect(BLOCK_RECIPE_V1.grid.maxCells).toBe(CATALOG_ZOOM_BLOCKS_MAXIMUM);
    expect(BLOCK_RECIPE_V1.frame.maxLongEdge).toBe(CATALOG_ZOOM_MAX_LONG_EDGE);
    expect(BLOCK_RECIPE_V1.encoder).toMatchObject({
      format: "jpeg",
      quality: 85,
      chromaSubsampling: "4:4:4",
      progressive: false,
    });
    for (const [width, height] of [
      [8192, 5461],
      [5461, 8192],
      [6000, 4000],
      [2049, 1500],
    ] as const) {
      const { cells } = blockGrid(width, height);
      for (let cell = 0; cell < cells; cell += 1)
        expect(blockCellRegion(width, height, cell)).toEqual(
          catalogBlockCell(width, height, cell),
        );
    }
  });
});

describe("the sandbox renderer's blocks operation (real sharp)", () => {
  it("cuts baseline 4:4:4 JPEG blocks without metadata, covering the frame with the overlap", async () => {
    const master = await texture(3000, 2000).jpeg({ quality: 95 }).toBuffer();
    const { paths, job } = await setup({ master });
    const body = await renderSandboxBlocksJob(job, paths);
    expect(body.status).toBe("blocks");
    expect(body.outputs.map((output) => output.name)).toEqual([
      "block-00.jpg",
      "block-01.jpg",
      "block-02.jpg",
      "block-03.jpg",
      "block-04.jpg",
      "block-05.jpg",
    ]);
    const frame = await sharp(master).removeAlpha().raw().toBuffer();
    for (const [index, output] of body.outputs.entries()) {
      const region = blockCellRegion(3000, 2000, index);
      expect([output.width, output.height]).toEqual([
        region.width,
        region.height,
      ]);
      const bytes = await readFile(path.join(paths.output, output.name));
      expect(output.sha256).toBe(sha(bytes));
      expect(await probeJpegBlock(bufferByteReader(bytes))).toEqual({
        width: region.width,
        height: region.height,
      });
      const meta = await sharp(bytes).metadata();
      expect(meta.isProgressive).toBe(false);
      expect(meta.chromaSubsampling).toBe("4:4:4");
      expect(meta.icc).toBeUndefined();
      expect(meta.exif).toBeUndefined();
      const decoded = await sharp(bytes).raw().toBuffer();
      const reference = await sharp(frame, {
        raw: { width: 3000, height: 2000, channels: 3 },
      })
        .extract(region)
        .raw()
        .toBuffer();
      expect(psnr(decoded, reference)).toBeGreaterThanOrEqual(38);
    }
    expect(body.outputs[0]).toMatchObject({ width: 1026, height: 1026 });
    expect(body.outputs[2]).toMatchObject({ width: 952, height: 1026 });
    expect(body.outputs[5]).toMatchObject({ width: 952, height: 976 });
    // The manifest passes the coordinator's strict parse.
    const manifest = sandboxManifest(
      job,
      { node: "24.0.0", sharp: "0.35.4", vips: "8.17.0" },
      body,
    );
    expect(parseSandboxManifest(JSON.stringify(manifest)).outputs).toHaveLength(
      6,
    );
  });

  it("scales a larger master to the frame and converts Display-P3 to untagged sRGB", async () => {
    const master = await texture(4200, 2800)
      .withIccProfile("p3")
      .jpeg({ quality: 95 })
      .toBuffer();
    const { paths, job } = await setup({
      master,
      frameLongEdge: 3000,
      cells: [0, 1],
    });
    const body = await renderSandboxBlocksJob(job, paths);
    expect(body.status).toBe("blocks");
    expect(body.outputs).toHaveLength(2);
    const bytes = await readFile(path.join(paths.output, "block-00.jpg"));
    expect((await sharp(bytes).metadata()).icc).toBeUndefined();
    const expected = await sharp(master)
      .toColourspace("srgb")
      .resize(3000, 2000, { fit: "fill", kernel: "lanczos3" })
      .extract(blockCellRegion(3000, 2000, 0))
      .removeAlpha()
      .raw()
      .toBuffer();
    expect(
      psnr(await sharp(bytes).raw().toBuffer(), expected),
    ).toBeGreaterThanOrEqual(38);
  });

  it("refuses a master with alpha (zoom_blocks_alpha)", async () => {
    const master = await texture(2600, 1600, 4).png().toBuffer();
    const reference = (
      await display(
        await sharp(master).flatten({ background: "#ffffff" }).png().toBuffer(),
      )
    ).data;
    const { paths, job } = await setup({
      master,
      masterType: "image/png",
      reference,
    });
    const body = await renderSandboxBlocksJob(job, paths);
    expect(body).toMatchObject({
      status: "rejected",
      failureCode: "zoom_blocks_alpha",
      outputs: [],
    });
  });

  it("refuses a master that is not the approved image (master_mismatch)", async () => {
    const master = await texture(3000, 2000).jpeg({ quality: 95 }).toBuffer();
    const shifted = await texture(3000, 2000, 3, 15)
      .jpeg({ quality: 95 })
      .toBuffer();
    const misaligned = await setup({
      master,
      reference: (await display(shifted)).data,
    });
    expect(
      await renderSandboxBlocksJob(misaligned.job, misaligned.paths),
    ).toMatchObject({
      status: "rejected",
      failureCode: "master_mismatch",
    });
    const resized = await setup({
      master,
      masterSize: { width: 3000, height: 2001 },
    });
    expect(
      await renderSandboxBlocksJob(resized.job, resized.paths),
    ).toMatchObject({
      status: "rejected",
      failureCode: "master_mismatch",
    });
  });

  it("never blames the master for a bad display reference (processing_failed, review L2)", async () => {
    const master = await texture(3000, 2000).jpeg({ quality: 95 }).toBuffer();
    const sized = await setup({
      master,
      referenceSize: { width: 2048, height: 1366 },
    });
    expect(await renderSandboxBlocksJob(sized.job, sized.paths)).toMatchObject({
      status: "rejected",
      failureCode: "processing_failed",
    });
    const notWebp = await setup({
      master,
      reference: await texture(2048, 1365).png().toBuffer(),
    });
    expect(
      await renderSandboxBlocksJob(notWebp.job, notWebp.paths),
    ).toMatchObject({ status: "rejected", failureCode: "processing_failed" });
  });

  it("refuses an unreadable master (master_unreadable)", async () => {
    const master = Buffer.concat([
      await texture(3000, 2000).jpeg({ quality: 95 }).toBuffer(),
    ]).subarray(0, 4000);
    const reference = (
      await display(await texture(3000, 2000).jpeg().toBuffer())
    ).data;
    const { paths, job } = await setup({
      master,
      reference,
      masterSize: { width: 3000, height: 2000 },
    });
    expect(await renderSandboxBlocksJob(job, paths)).toMatchObject({
      status: "rejected",
      failureCode: "master_unreadable",
    });
  });
});

describe("the blocks protocol", () => {
  const valid = {
    protocol: SANDBOX_PROTOCOL_VERSION,
    nonce: "0".repeat(32),
    operation: "blocks",
    item: null,
    blocks: {
      inputs: [
        {
          role: "master",
          declaredType: "image/jpeg",
          byteSize: 10,
          sha256: "a".repeat(64),
        },
        {
          role: "reference",
          declaredType: "image/webp",
          byteSize: 10,
          sha256: "b".repeat(64),
        },
      ],
      master: { width: 9504, height: 6336 },
      frame: { width: 8192, height: 5461 },
      reference: { width: 2048, height: 1365 },
      cells: [0, 15],
      recipe: { version: 1, digest: BLOCK_RECIPE_DIGEST_V1 },
    },
    limits: SANDBOX_JOB_LIMITS,
  };
  const variant = (
    blocks: Record<string, unknown>,
    top: Record<string, unknown> = {},
  ) => ({
    ...valid,
    ...top,
    blocks: { ...valid.blocks, ...blocks },
  });

  it("accepts a current block job and refuses every other shape", () => {
    expect(parseSandboxJob(valid).operation).toBe("blocks");
    for (const bad of [
      variant({ cells: [0, 16] }),
      variant({ cells: [40, 48] }),
      variant({ cells: [5, 4] }),
      variant({ recipe: { version: 1, digest: "0".repeat(16) } }),
      variant({ frame: { width: 9600, height: 6400 } }),
      variant({
        frame: { width: 9600, height: 5461 },
        master: { width: 9504, height: 6336 },
      }),
      variant({ inputs: [valid.blocks.inputs[1], valid.blocks.inputs[0]] }),
      variant({
        inputs: [
          { ...valid.blocks.inputs[0], declaredType: "image/webp" },
          valid.blocks.inputs[1],
        ],
      }),
      variant({}, { item: {} }),
      { ...valid, blocks: undefined },
    ])
      expect(() => parseSandboxJob(bad)).toThrow(SandboxJobError);
  });

  it("keeps block outputs and codes out of item jobs", () => {
    const block = {
      name: "block-07.jpg",
      role: "block-07" as const,
      contentType: "image/jpeg" as const,
      width: 1026,
      height: 1026,
      durationMs: null,
      bytes: 10,
      sha256: "c".repeat(64),
    };
    expect(() => itemOutput(block)).toThrow(SandboxProtocolError);
    expect(() => itemRejection("master_mismatch")).toThrow(
      SandboxProtocolError,
    );
    expect(itemRejection("decode_failed").failureCode).toBe("decode_failed");
  });
});
