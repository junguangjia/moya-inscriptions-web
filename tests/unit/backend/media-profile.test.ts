import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { FilesystemPublishingMediaStore } from "@moya/backend-production/internal/publishing-media-store";
import {
  bufferByteReader,
  currentRecipe,
  probeWebp,
} from "@moya/backend-production/internal/publishing-processing";
import {
  PROFILE_STORE_OWNER,
  PROFILE_SWEEP_BATCH,
  PROFILE_SWEEP_INTERVAL_MS,
  PROFILE_SWEEP_MAX_OPEN,
  createProfileRenderer,
  createProfileSweep,
  profileAnchorIdentities,
  profileRenditionRequests,
} from "@moya/backend-production/internal/publishing-profile";
import {
  createSandboxRunner,
  defaultSandboxAppDist,
} from "@moya/backend-production/internal/publishing-sandbox";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { inProcessSandbox } from "./publishing-sandbox-fixture.js";

import type { ProfileWorkerRenderPlan } from "@moya/backend-production/internal/publishing-profile";

/*
 * Profile image processing in the media worker (unified media pipeline,
 * increment 3a): the stored PNG is checked against its row (size, PNG
 * signature, SHA-256) before any decoder sees it, rendered in the same
 * sandbox as works with the `profile` plan (real renderer, real sharp, in
 * process), checked against the row's dimensions and written to the
 * publishing store as owner-less WebP renditions; and the paced sweep that
 * has the store queue the jobs.
 */

const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const MEDIA_ID = `user-media-${"e".repeat(32)}`;

let base: string;

beforeEach(async () => {
  base = await realpath(await mkdtemp(path.join(tmpdir(), "media-profile-")));
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const png = (
  width: number,
  height: number,
  background: { r: number; g: number; b: number; alpha?: number },
) =>
  sharp({
    create: { width, height, channels: background.alpha ? 4 : 3, background },
  })
    .withExif({ IFD0: { Copyright: "synthetic-private-marker" } })
    .png()
    .toBuffer();

describe("profile rendering in the media sandbox", () => {
  const setup = async (
    sandboxOptions: Parameters<typeof inProcessSandbox>[0] = {},
  ) => {
    const root = await mkdtemp(path.join(base, "setup-"));
    const store = path.join(root, "store");
    const work = path.join(root, "work");
    for (const directory of [store, work]) {
      await mkdir(directory, { mode: 0o700 });
      await chmod(directory, 0o700);
    }
    const publishingStore = await FilesystemPublishingMediaStore.open(store, {
      temporaryRoots: [],
    });
    const writes = vi.spyOn(publishingStore, "writeStream");
    const sandbox = inProcessSandbox(sandboxOptions);
    const errors: string[] = [];
    const renderer = createProfileRenderer({
      store: publishingStore,
      sandbox: await createSandboxRunner({
        image: "yoyi-work-publishing-media-tools:v2",
        workDirectory: work,
        appDist: defaultSandboxAppDist().appDist,
        spawn: sandbox.spawn,
        temporaryRoots: [],
        environment: {},
      }),
      logger: { error: (line) => errors.push(line) },
    });
    const blobs = async () =>
      (await publishingStore.listBlobs({ limit: 10 })).entries;
    const read = async (storageKey: string) => {
      const opened = await publishingStore.openRead(storageKey);
      if (opened?.status !== "ok") throw new Error("missing blob");
      const chunks: Buffer[] = [];
      for await (const chunk of opened.body) chunks.push(chunk as Buffer);
      await opened.close();
      return Buffer.concat(chunks);
    };
    return { renderer, sandbox, blobs, read, writes, errors };
  };

  const planFor = async (
    bytes: Buffer,
    families: ProfileWorkerRenderPlan["families"],
    overrides: Partial<ProfileWorkerRenderPlan> = {},
  ): Promise<ProfileWorkerRenderPlan> => {
    const metadata = await sharp(bytes).metadata();
    return {
      userMediaId: MEDIA_ID,
      sha256: sha256(bytes),
      width: metadata.width,
      height: metadata.height,
      byteSize: bytes.byteLength,
      families,
      ...overrides,
    };
  };

  it("renders an avatar family from an RGBA PNG: WebP with alpha, no metadata, owner-less store writes", async () => {
    const { renderer, sandbox, blobs, read, writes } = await setup();
    const avatar = await png(512, 512, { r: 200, g: 10, b: 10, alpha: 0.5 });
    const result = await renderer.render(
      await planFor(avatar, ["avatar"]),
      avatar,
    );
    if (result.status !== "rendered") throw new Error(JSON.stringify(result));
    expect(result.outcome.sourceSha256).toBe(sha256(avatar));
    expect(
      result.outcome.renditions.map((rendition) => [
        rendition.role,
        rendition.width,
        rendition.height,
        rendition.contentType,
        rendition.recipeVersion,
        rendition.recipeDigest,
      ]),
    ).toEqual(
      (
        [
          ["avatar-128", 128],
          ["avatar-512", 512],
        ] as const
      ).map(([role, edge]) => [
        role,
        edge,
        edge,
        "image/webp",
        1,
        currentRecipe(role).digest,
      ]),
    );
    for (const rendition of result.outcome.renditions) {
      const bytes = await read(rendition.storageKey);
      expect([bytes.byteLength, sha256(bytes)]).toEqual([
        rendition.byteSize,
        rendition.sha256,
      ]);
      expect(await probeWebp(bufferByteReader(bytes))).toMatchObject({
        width: rendition.width,
        height: rendition.height,
        hasAlpha: true,
      });
      const metadata = await sharp(bytes).metadata();
      expect([metadata.format, metadata.exif, metadata.xmp]).toEqual([
        "webp",
        undefined,
        undefined,
      ]);
      expect(bytes.includes("synthetic-private-marker")).toBe(false);
    }
    // An unedited static derive with the profile plan, from the PNG as stored.
    expect(sandbox.jobs).toHaveLength(1);
    expect(sandbox.jobs[0]).toMatchObject({
      operation: "derive",
      item: {
        kind: "static",
        qualityMode: "standard",
        inputs: [
          {
            role: "still",
            declaredType: "image/png",
            byteSize: avatar.byteLength,
            sha256: sha256(avatar),
          },
        ],
        clientPairing: null,
        edit: { rotation: 0, crop: null },
        coverCrop: null,
        plan: "profile",
        renditions: profileRenditionRequests(["avatar"]),
        motion: false,
        placeholder: false,
      },
    });
    expect(writes.mock.calls.map((call) => call.slice(0, 3))).toEqual([
      [PROFILE_STORE_OWNER, "derivative", "image/webp"],
      [PROFILE_STORE_OWNER, "derivative", "image/webp"],
    ]);
    expect(await blobs()).toHaveLength(2);
  });

  it("renders an opaque background family and both families of one image", async () => {
    const { renderer, blobs } = await setup();
    const cover = await png(1600, 1200, { r: 30, g: 90, b: 60 });
    const covers = await renderer.render(
      await planFor(cover, ["background"]),
      cover,
    );
    if (covers.status !== "rendered") throw new Error(JSON.stringify(covers));
    expect(
      covers.outcome.renditions.map((rendition) => [
        rendition.role,
        rendition.width,
        rendition.height,
      ]),
    ).toEqual([
      ["background-960", 960, 720],
      ["background-1600", 1600, 1200],
    ]);
    // One image that is both the avatar and the background renders both
    // families in one run; equal sizes skip the larger role of a family.
    const both = await png(512, 384, { r: 30, g: 90, b: 60 });
    const result = await renderer.render(
      await planFor(both, ["avatar", "background"]),
      both,
    );
    if (result.status !== "rendered") throw new Error(JSON.stringify(result));
    expect(
      result.outcome.renditions.map((rendition) => [
        rendition.role,
        rendition.width,
        rendition.height,
      ]),
    ).toEqual([
      ["avatar-128", 128, 96],
      ["avatar-512", 512, 384],
      ["background-960", 512, 384],
    ]);
    expect(await blobs()).toHaveLength(5);
  });

  it("rejects a source that is not the row's image before any sandbox run", async () => {
    const { renderer, sandbox, blobs } = await setup();
    const avatar = await png(64, 64, { r: 1, g: 2, b: 3 });
    const plan = await planFor(avatar, ["avatar"]);
    const jpeg = await sharp(avatar).jpeg().toBuffer();
    for (const [source, overrides, failureCode] of [
      [avatar, { byteSize: avatar.byteLength + 1 }, "size_mismatch"],
      [
        Buffer.alloc(4 * 1024 * 1024 + 1, 1),
        { byteSize: 4 * 1024 * 1024 + 1 },
        "size_mismatch",
      ],
      [
        jpeg,
        { byteSize: jpeg.byteLength, sha256: sha256(jpeg) },
        "unsupported_type",
      ],
      [avatar, { sha256: "0".repeat(64) }, "source_mismatch"],
    ] as const) {
      expect(await renderer.render({ ...plan, ...overrides }, source)).toEqual({
        status: "rejected",
        failureCode,
      });
    }
    expect(sandbox.calls).toEqual([]);
    expect(await blobs()).toHaveLength(0);
  });

  it("rejects bytes that decode to other dimensions than the row's, keeping nothing", async () => {
    const { renderer, sandbox, blobs } = await setup();
    const avatar = await png(300, 200, { r: 1, g: 2, b: 3 });
    expect(
      await renderer.render(
        await planFor(avatar, ["avatar"], { width: 200, height: 300 }),
        avatar,
      ),
    ).toEqual({ status: "rejected", failureCode: "source_mismatch" });
    expect(sandbox.jobs).toHaveLength(1);
    expect(await blobs()).toHaveLength(0);
  });

  it("passes the sandbox's content rejection through and maps protocol violations to processing_failed", async () => {
    const { renderer, blobs } = await setup();
    const avatar = await png(64, 64, { r: 1, g: 2, b: 3 });
    // A PNG signature over a truncated body.
    const truncated = avatar.subarray(0, 40);
    const result = await renderer.render(
      await planFor(avatar, ["avatar"], {
        byteSize: truncated.byteLength,
        sha256: sha256(truncated),
      }),
      truncated,
    );
    expect(result).toEqual({
      status: "rejected",
      failureCode: "decode_failed",
    });
    const tampered = await setup({
      tamper: (manifest) => ({
        ...manifest,
        outputs: manifest.outputs.map((output) => ({
          ...output,
          width: output.width + 1,
        })),
      }),
    });
    expect(
      await tampered.renderer.render(await planFor(avatar, ["avatar"]), avatar),
    ).toEqual({ status: "rejected", failureCode: "processing_failed" });
    expect(tampered.errors).toEqual([
      "[media-sandbox] sandbox_protocol_violation code=dimensions_mismatch",
    ]);
    expect(await blobs()).toHaveLength(0);
    expect(await tampered.blobs()).toHaveLength(0);
  });

  it("retries sandbox outages and aborts, and refuses a malformed plan", async () => {
    const avatar = await png(64, 64, { r: 1, g: 2, b: 3 });
    const outage = await setup({
      exitCode: 125,
      stream: async () => Buffer.alloc(0),
    });
    await expect(
      outage.renderer.render(await planFor(avatar, ["avatar"]), avatar),
    ).rejects.toMatchObject({ code: "sandbox_unavailable" });
    const controller = new AbortController();
    const aborting = await setup({
      hang: true,
      onRun: () => controller.abort(),
    });
    await expect(
      aborting.renderer.render(
        await planFor(avatar, ["avatar"]),
        avatar,
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: "MediaToolError", code: "aborted" });
    expect(await aborting.blobs()).toHaveLength(0);
    const { renderer, sandbox } = await setup();
    const plan = await planFor(avatar, ["avatar"]);
    for (const malformed of [
      { ...plan, families: [] },
      { ...plan, families: ["avatar", "avatar"] },
      { ...plan, families: ["cover"] },
      { ...plan, width: 0 },
      { ...plan, sha256: "x" },
    ] as ProfileWorkerRenderPlan[])
      await expect(renderer.render(malformed, avatar)).rejects.toMatchObject({
        name: "MediaProcessingInputError",
      });
    expect(sandbox.calls).toEqual([]);
  });
});

describe("profile render identities and sweep", () => {
  it("names each family's anchor and every role of a family at its current recipe", () => {
    expect(profileAnchorIdentities()).toEqual(
      (["avatar-128", "background-960"] as const).map((role) => ({
        role,
        version: 1,
        digest: currentRecipe(role).digest,
      })),
    );
    expect(
      profileRenditionRequests(["background", "avatar"]).map(
        (request) => request.role,
      ),
    ).toEqual([
      "avatar-128",
      "avatar-512",
      "background-960",
      "background-1600",
    ]);
    expect(profileRenditionRequests(["background"])).toEqual(
      (["background-960", "background-1600"] as const).map((role) => ({
        role,
        version: 1,
        digest: currentRecipe(role).digest,
      })),
    );
  });

  it("queues at most two jobs a minute with at most two open, logging content-free counts when they change", async () => {
    expect([
      PROFILE_SWEEP_INTERVAL_MS,
      PROFILE_SWEEP_BATCH,
      PROFILE_SWEEP_MAX_OPEN,
    ]).toEqual([60_000, 2, 2]);
    const counts = {
      missing: 5,
      blocked: 1,
      enqueued: 2,
      requeued: 0,
      paused: false,
    };
    const port = { enqueueProfileRenders: vi.fn(async () => ({ ...counts })) };
    const lines: string[] = [];
    const sweep = createProfileSweep({
      port,
      logger: {
        info: (line) => lines.push(line),
        error: (line) => lines.push(line),
      },
    });
    const now = new Date("2026-10-14T01:00:00.000Z");
    await sweep.run(now);
    expect(port.enqueueProfileRenders).toHaveBeenCalledWith(now, {
      limit: 2,
      maxOpen: 2,
      anchors: profileAnchorIdentities(),
    });
    // The same counts again (a steady state of blocked images) log nothing.
    await sweep.run(now);
    Object.assign(counts, { missing: 1, enqueued: 0, paused: true });
    await sweep.run(now);
    Object.assign(counts, { missing: 0, blocked: 0, paused: false });
    await sweep.run(now);
    await sweep.run(now);
    expect(lines).toEqual([
      "[media-worker] profile sweep missing=5 blocked=1 enqueued=2 requeued=0 paused=no",
      "[media-worker] profile sweep missing=1 blocked=1 enqueued=0 requeued=0 paused=yes",
      "[media-worker] profile sweep missing=0 blocked=0 enqueued=0 requeued=0 paused=no",
    ]);
    expect(port.enqueueProfileRenders).toHaveBeenCalledTimes(5);
    // Nothing missing from the start logs nothing.
    const quiet: string[] = [];
    await createProfileSweep({
      port,
      logger: { info: (line) => quiet.push(line), error: () => undefined },
    }).run(now);
    expect(quiet).toEqual([]);
  });
});
