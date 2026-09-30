import { expect, test } from "@playwright/test";
import sharp from "sharp";
import type { Page } from "@playwright/test";

/**
 * Profile cover upload, crop and preview (#171). Community requests are
 * served by page routes with synthetic data; the uploaded bytes are captured
 * and served back, so the editor, the live header and the reloaded header can
 * be compared pixel for pixel. Browser emulation, not physical-device QA.
 */
const ownerId = `user-${"5".repeat(32)}`;
const identity = {
  id: ownerId,
  handle: "synthetic-cover",
  displayName: "封面测试作者",
};
const ALLOWED_CHUNKS = new Set([
  "IHDR",
  "IDAT",
  "IEND",
  "sRGB",
  "gAMA",
  "pHYs",
  "cHRM",
]);

interface Media {
  id: string;
  src: string;
  width: number;
  height: number;
}
interface State {
  background: Media | null;
  uploads: { requestId: string; bytes: Buffer }[];
  saves: { requestId: string; mediaId: string | null }[];
  media: Map<string, Buffer>;
  /** Fail the next N background saves with 503. */
  failSaves: number;
  /** Fail the next N uploads with 503. */
  failUploads: number;
  holdUpload: Promise<void> | null;
  holdMedia: Promise<void> | null;
}

const pngInfo = (bytes: Buffer) => {
  expect(bytes.subarray(1, 4).toString("latin1")).toBe("PNG");
  const chunks: string[] = [];
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const size = bytes.readUInt32BE(offset);
    chunks.push(bytes.subarray(offset + 4, offset + 8).toString("latin1"));
    offset += size + 12;
  }
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
    depth: bytes[24],
    colorType: bytes[25],
    chunks,
  };
};

async function fixture(page: Page, background: Media | null = null) {
  const state: State = {
    background,
    uploads: [],
    saves: [],
    media: new Map(),
    failSaves: 0,
    failUploads: 0,
    holdUpload: null,
    holdMedia: null,
  };
  let counter = 0;
  // WebKit does not expose a Blob request body to routes: keep a copy of the
  // uploaded PNG in the page (test instrumentation only).
  await page.addInitScript(() => {
    const original = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (
        url.endsWith("/api/community/media") &&
        init?.method === "POST" &&
        init.body instanceof Blob
      ) {
        const bytes = new Uint8Array(await init.body.arrayBuffer());
        let binary = "";
        for (let index = 0; index < bytes.length; index += 8192)
          binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
        (window as unknown as { __coverUpload: string }).__coverUpload =
          btoa(binary);
      }
      return original(input, init);
    };
  });
  await page.route("**/api/community/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/community/me") return route.fulfill({ json: identity });
    if (path === `/api/community/authors/${ownerId}`)
      return route.fulfill({
        json: {
          ...identity,
          bio: "",
          avatar: null,
          background: state.background,
          isOwner: true,
          following: false,
          privacy: {
            following: "public",
            followers: "public",
            favorites: "public",
            likes: "public",
          },
          totals: {
            works: 0,
            following: 0,
            followers: 0,
            favorites: 0,
            likes: 0,
          },
          nextAvatarChangeAt: null,
        },
      });
    if (/\/authors\/[^/]+\/(works|favorites|likes)$/u.test(path))
      return route.fulfill({
        json: { items: [], total: 0, page: 1, pageSize: 12 },
      });
    if (path === "/api/community/media" && request.method() === "POST") {
      if (state.holdUpload) await state.holdUpload;
      const bytes =
        request.postDataBuffer() ??
        Buffer.from(
          await page.evaluate(
            () =>
              (window as unknown as { __coverUpload: string }).__coverUpload,
          ),
          "base64",
        );
      state.uploads.push({
        requestId: request.headers()["x-request-id"] ?? "",
        bytes,
      });
      if (state.failUploads > 0) {
        state.failUploads -= 1;
        return route.fulfill({ status: 503, json: { error: {} } });
      }
      const info = pngInfo(bytes);
      counter += 1;
      const id = `user-media-${String(counter).padStart(32, "0")}`;
      state.media.set(id, bytes);
      return route.fulfill({
        status: 201,
        json: {
          id,
          src: `/api/community/media/${id}`,
          width: info.width,
          height: info.height,
        },
      });
    }
    if (path.startsWith("/api/community/media/")) {
      if (state.holdMedia) await state.holdMedia;
      const bytes = state.media.get(path.split("/").pop()!);
      return bytes
        ? route.fulfill({ body: bytes, contentType: "image/png" })
        : route.fulfill({ status: 404, json: { error: {} } });
    }
    if (path === "/api/community/me/background") {
      const body = request.postDataJSON() as {
        requestId: string;
        mediaId: string | null;
      };
      state.saves.push(body);
      if (state.failSaves > 0) {
        state.failSaves -= 1;
        return route.fulfill({ status: 503, json: { error: {} } });
      }
      const bytes = body.mediaId ? state.media.get(body.mediaId) : null;
      state.background =
        body.mediaId && bytes
          ? {
              id: body.mediaId,
              src: `/api/community/media/${body.mediaId}`,
              width: pngInfo(bytes).width,
              height: pngInfo(bytes).height,
            }
          : null;
      return route.fulfill({ json: { saved: true } });
    }
    return route.fulfill({
      json: { items: [], total: 0, page: 1, pageSize: 12 },
    });
  });
  return state;
}

async function openProfile(page: Page) {
  await page.goto("/");
  await expect(page.locator("[data-product-boot]")).toHaveCount(0);
  await page
    .getByRole("navigation", { name: "主要内容" })
    .getByRole("button", { name: "用户", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: identity.displayName, exact: true }),
  ).toBeVisible();
}

async function openEditor(page: Page) {
  await page.getByRole("button", { name: "编辑主页背景" }).click();
  await expect(page.locator('[data-cover-editor="overview"]')).toBeVisible();
}

async function choose(
  page: Page,
  file: { name: string; buffer: Buffer; mimeType: string },
) {
  const chooser = page.waitForEvent("filechooser");
  await page
    .locator("[data-cover-editor]")
    .getByRole("button", { name: /更换照片|选择照片|重新选择/u })
    .click();
  await (await chooser).setFiles(file);
}

/** R encodes x and G encodes y across the whole picture. */
async function calibration(width: number, height: number) {
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 3;
      raw[at] = Math.round((x / (width - 1)) * 255);
      raw[at + 1] = Math.round((y / (height - 1)) * 255);
      raw[at + 2] = 128;
    }
  return sharp(raw, { raw: { width, height, channels: 3 } })
    .jpeg({ quality: 95 })
    .toBuffer();
}

const jpeg = async (buffer: Buffer, name = "cover.jpg") => ({
  name,
  buffer,
  mimeType: "image/jpeg",
});

/** Master coordinates read back from calibration pixels at header fractions. */
async function decode(
  page: Page,
  selector: string,
  points: readonly (readonly [number, number])[],
) {
  const target = page.locator(selector).first();
  const box = (await target.boundingBox())!;
  const shot = await page.screenshot({ clip: box, scale: "css" });
  const { data, info } = await sharp(shot)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return points.map(([fx, fy]) => {
    const x = Math.min(info.width - 1, Math.round(fx * info.width));
    const y = Math.min(info.height - 1, Math.round(fy * info.height));
    const at = (y * info.width + x) * info.channels;
    return [data[at]! / 255, data[at + 1]! / 255] as const;
  });
}

/** The crop photo's zoom, read from its CSS transform. */
async function mediaScale(page: Page) {
  return page
    .locator("[data-cover-stage] img")
    .evaluate((node) => new DOMMatrix(getComputedStyle(node).transform).a);
}

/** Header fractions inside the clear top band, away from the pencil. */
const HEADER_POINTS = [
  [0.3, 0.08],
  [0.5, 0.18],
  [0.65, 0.28],
] as const;

async function headerWindow(page: Page) {
  return page.evaluate(() => {
    const section = document.querySelector<HTMLElement>(
      "[data-author-profile] [data-profile-background-slot]",
    )!;
    const { width, height } = section.getBoundingClientRect();
    const aspect = width / height;
    const master = 4 / 3;
    return aspect <= master
      ? { x: (1 - aspect / master) / 2, y: 0, w: aspect / master, h: 1, aspect }
      : { x: 0, y: 0, w: 1, h: master / aspect, aspect };
  });
}

test("Crop frame, saved bytes and the reloaded header show the same framing", async ({
  page,
}) => {
  const state = await fixture(page);
  await openProfile(page);
  const window = await headerWindow(page);
  await openEditor(page);
  await choose(page, await jpeg(await calibration(1600, 1200)));
  const stage = page.locator("[data-cover-stage]");
  await expect(stage).toBeVisible();
  expect(state.uploads).toHaveLength(0);
  expect(state.saves).toHaveLength(0);
  // The overlay window has the owner's header shape.
  const shown = (await page.locator("[data-cover-window]").boundingBox())!;
  expect(Math.abs(shown.width / shown.height - window.aspect)).toBeLessThan(
    0.02 * window.aspect,
  );
  // The editor shows master pixels exactly where the header will.
  const expected = HEADER_POINTS.map(
    ([fx, fy]) => [window.x + fx * window.w, window.y + fy * window.h] as const,
  );
  await page.getByRole("button", { name: "参考线" }).click();
  const inEditor = await decode(page, "[data-cover-stage]", expected);
  await page.getByRole("button", { name: "参考线" }).click();
  for (const [index, [x, y]] of inEditor.entries()) {
    expect(Math.abs(x - expected[index]![0])).toBeLessThan(0.02);
    expect(Math.abs(y - expected[index]![1])).toBeLessThan(0.02);
  }
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  await expect(page.getByText("主页背景已更新")).toBeVisible();
  expect(state.uploads).toHaveLength(1);
  const info = pngInfo(state.uploads[0]!.bytes);
  expect(info.depth).toBe(8);
  expect([2, 6]).toContain(info.colorType);
  expect(info.chunks.every((type) => ALLOWED_CHUNKS.has(type))).toBe(true);
  expect(Math.abs(info.width / info.height - 4 / 3)).toBeLessThan(0.01);
  expect(info.width).toBe(1600);
  expect(state.uploads[0]!.bytes.length).toBeLessThanOrEqual(4 * 1024 * 1024);
  const cover = "[data-author-profile] [data-profile-background-slot]";
  for (const readBack of [
    await decode(page, cover, HEADER_POINTS),
    await (async () => {
      await openProfile(page);
      return decode(page, cover, HEADER_POINTS);
    })(),
  ])
    for (const [index, [x, y]] of readBack.entries()) {
      expect(Math.abs(x - expected[index]![0])).toBeLessThan(0.02);
      expect(Math.abs(y - expected[index]![1])).toBeLessThan(0.02);
    }
});

test("Uploads keep orientation, never upscale and step down under 4 MiB", async ({
  page,
}) => {
  const state = await fixture(page);
  await openProfile(page);
  await openEditor(page);
  // A camera JPEG stored landscape with EXIF orientation 6 (shown portrait).
  const stored = await calibration(1200, 900);
  const rotated = await sharp(stored)
    .jpeg({ quality: 95 })
    .withMetadata({ orientation: 6 })
    .toBuffer();
  await choose(page, await jpeg(rotated, "rotated.jpg"));
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  const oriented = pngInfo(state.uploads[0]!.bytes);
  // Portrait 900×1200 cropped to 4:3 at zoom 1: 900×675, not upscaled.
  expect(oriented.width).toBe(900);
  expect(oriented.height).toBe(675);
  const expected = await sharp(rotated)
    .rotate()
    .extract({ left: 0, top: 263, width: 900, height: 675 })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const actual = await sharp(state.uploads[0]!.bytes)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  for (const [fx, fy] of [
    [0.1, 0.1],
    [0.9, 0.2],
    [0.5, 0.8],
  ] as const) {
    const at =
      (Math.round(fy * 674) * 900 + Math.round(fx * 899)) *
      expected.info.channels;
    for (const channel of [0, 1])
      expect(
        Math.abs(expected.data[at + channel]! - actual.data[at + channel]!),
      ).toBeLessThan(12);
  }

  // A noisy photo whose widest PNG exceeds the limit steps down.
  await openEditor(page);
  const raw = Buffer.alloc(2000 * 1500 * 3);
  let seed = 0x9e3779b9;
  for (let index = 0; index < raw.length; index++) {
    // xorshift32: incompressible noise.
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    raw[index] = seed & 0xff;
  }
  const noise = await sharp(raw, {
    raw: { width: 2000, height: 1500, channels: 3 },
  })
    .png({ compressionLevel: 1 })
    .toBuffer();
  await choose(page, {
    name: "noise.png",
    buffer: noise,
    mimeType: "image/png",
  });
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  const stepped = state.uploads[1]!;
  expect(stepped.bytes.length).toBeLessThanOrEqual(4 * 1024 * 1024);
  expect(pngInfo(stepped.bytes).width).toBeLessThan(1600);
});

test("A 24 MP phone photo is accepted; unsupported files explain why", async ({
  page,
}) => {
  const state = await fixture(page);
  await openProfile(page);
  await openEditor(page);
  await choose(page, {
    name: "IMG_0001.HEIC",
    buffer: Buffer.from("heic"),
    mimeType: "image/heic",
  });
  await expect(page.locator("[data-cover-editor] [role=alert]")).toContainText(
    "暂不支持 HEIC",
  );
  await choose(page, {
    name: "moving.gif",
    buffer: Buffer.from("GIF89a"),
    mimeType: "image/gif",
  });
  await expect(page.locator("[data-cover-editor] [role=alert]")).toContainText(
    "仅支持 JPG、PNG 或 WebP",
  );
  const large = await sharp({
    create: {
      width: 5712,
      height: 4284,
      channels: 3,
      background: { r: 90, g: 110, b: 140 },
    },
  })
    .jpeg({ quality: 90 })
    .toBuffer();
  await choose(page, await jpeg(large, "IMG_0002.jpg"));
  await expect(page.locator("[data-cover-stage]")).toBeVisible({
    timeout: 20_000,
  });
  expect(state.uploads).toHaveLength(0);
});

test("Save is single, retryable with the same identity and truthful while the header loads", async ({
  page,
}) => {
  const state = await fixture(page);
  await openProfile(page);
  await openEditor(page);
  await choose(page, await jpeg(await calibration(800, 600)));
  await expect(page.locator("[data-cover-stage]")).toBeVisible();
  state.failSaves = 1;
  const save = page.getByRole("button", { name: "保存", exact: true });
  await save.dblclick();
  await expect(page.locator("[data-cover-editor] [role=alert]")).toContainText(
    "无法确认是否已保存",
  );
  expect(state.uploads).toHaveLength(1);
  expect(state.saves).toHaveLength(1);
  let release!: () => void;
  state.holdMedia = new Promise((done) => {
    release = done;
  });
  await page.getByRole("button", { name: "重试保存" }).click();
  await expect(page.getByText("正在更新主页…")).toBeVisible();
  expect(state.uploads).toHaveLength(1);
  expect(state.saves[1]).toEqual(state.saves[0]);
  // No success claim over the previous (blank) header.
  await expect(page.getByText("主页背景已更新")).toHaveCount(0);
  release();
  state.holdMedia = null;
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  await expect(page.getByText("主页背景已更新")).toBeVisible();
});

test("Cancel, Back and repeated reselection never write and always settle", async ({
  page,
}) => {
  const state = await fixture(page);
  await openProfile(page);
  const url = page.url();
  const photo = await jpeg(await calibration(800, 600));
  for (let round = 0; round < 3; round++) {
    await openEditor(page);
    await choose(page, photo);
    await expect(page.locator("[data-cover-stage]")).toBeVisible();
    await choose(page, photo);
    await expect(page.locator("[data-cover-stage]")).toBeVisible();
    if (round % 2) await page.getByRole("button", { name: "取消" }).click();
    else await page.goBack();
    await expect(page.locator('[data-cover-editor="overview"]')).toBeVisible();
    await page.goBack();
    await expect(page.locator("dialog[open]")).toHaveCount(0);
  }
  expect(page.url()).toBe(url);
  expect(state.uploads).toHaveLength(0);
  expect(state.saves).toHaveLength(0);
});

test("Removing the background needs an explicit confirmation", async ({
  page,
}) => {
  const existing = await sharp(await calibration(400, 300))
    .png()
    .toBuffer();
  const id = `user-media-${"e".repeat(32)}`;
  const state = await fixture(page, {
    id,
    src: `/api/community/media/${id}`,
    width: 400,
    height: 300,
  });
  state.media.set(id, existing);
  await openProfile(page);
  await openEditor(page);
  await page.getByRole("button", { name: "移除背景" }).click();
  await expect(page.locator('[data-cover-editor="remove"]')).toBeVisible();
  await page.getByRole("button", { name: "取消" }).click();
  await expect(page.locator('[data-cover-editor="overview"]')).toBeVisible();
  expect(state.saves).toHaveLength(0);
  await page.getByRole("button", { name: "移除背景" }).click();
  await page.getByRole("button", { name: "确认移除" }).click();
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  await expect(page.getByText("主页背景已移除")).toBeVisible();
  expect(state.saves).toEqual([
    { requestId: expect.any(String), mediaId: null },
  ]);
  await expect(
    page.locator("[data-author-profile] [data-profile-background-slot] img"),
  ).toHaveCount(0);
});

test("Narrow phones reach every crop control without scrolling", async ({
  page,
}) => {
  await fixture(page);
  const photo = await jpeg(await calibration(800, 600));
  for (const size of [
    { width: 360, height: 640 },
    { width: 375, height: 667 },
    { width: 393, height: 659 },
  ]) {
    await page.setViewportSize(size);
    await openProfile(page);
    await openEditor(page);
    await choose(page, photo);
    await expect(page.locator("[data-cover-stage]")).toBeVisible();
    for (const control of [
      page.getByRole("button", { name: "保存", exact: true }),
      page.getByRole("button", { name: "重新选择" }),
      page.getByRole("button", { name: "重置" }),
      page.getByRole("button", { name: "参考线" }),
    ]) {
      const box = (await control.boundingBox())!;
      expect(box.y + box.height).toBeLessThanOrEqual(size.height);
      expect(box.height).toBeGreaterThanOrEqual(40);
    }
    await page.goBack();
    await page.goBack();
    await expect(page.locator("dialog[open]")).toHaveCount(0);
  }
});

test("An upload keeps going when the window regains focus mid-save", async ({
  page,
}) => {
  const state = await fixture(page);
  await openProfile(page);
  await openEditor(page);
  await choose(page, await jpeg(await calibration(800, 600)));
  await expect(page.locator("[data-cover-stage]")).toBeVisible();
  let release!: () => void;
  state.holdUpload = new Promise((done) => {
    release = done;
  });
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByText("正在上传…")).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  release();
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  expect(state.saves).toHaveLength(1);
  expect(state.saves[0]!.mediaId).toMatch(/^user-media-/u);
});

test("Ordinary wheel scrolling does not zoom; Ctrl wheel (trackpad pinch) does", async ({
  page,
}) => {
  test.skip(
    Boolean(test.info().project.use.hasTouch),
    "pointer wheel only on desktop projects",
  );
  await fixture(page);
  await openProfile(page);
  await openEditor(page);
  await choose(page, await jpeg(await calibration(800, 600)));
  const stage = page.locator("[data-cover-stage]");
  await expect(stage).toBeVisible();
  const box = (await stage.boundingBox())!;
  // There is no zoom bar; the photo's own transform carries the zoom.
  await expect(page.getByRole("slider")).toHaveCount(0);
  const zoom = () => mediaScale(page);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -200);
  await page.waitForTimeout(300);
  expect(await zoom()).toBeCloseTo(1, 3);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -200);
  await page.keyboard.up("Control");
  await expect.poll(zoom).toBeGreaterThan(1);
});

test("A cancelled touch does not leave the photo following later touches", async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "touch cancellation needs CDP");
  await fixture(page);
  await openProfile(page);
  await openEditor(page);
  await choose(page, await jpeg(await calibration(1600, 1200)));
  const stage = page.locator("[data-cover-stage]");
  await expect(stage).toBeVisible();
  // Zoom (keyboard fallback) so the photo can move.
  await stage.locator('[tabindex="0"]').focus();
  await page.keyboard.press("+");
  await page.keyboard.press("+");
  await expect.poll(() => mediaScale(page)).toBeGreaterThan(1.1);
  const image = stage.locator("img");
  const transform = () =>
    image.evaluate((node) => getComputedStyle(node).transform);
  const box = (await stage.boundingBox())!;
  const cx = box.x + box.width / 2,
    cy = box.y + box.height / 2;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setTouchEmulationEnabled", {
    enabled: true,
    maxTouchPoints: 5,
  });
  const touch = (
    type: "touchStart" | "touchMove" | "touchEnd" | "touchCancel",
    x: number,
    y: number,
  ) =>
    cdp.send("Input.dispatchTouchEvent", {
      type,
      touchPoints:
        type === "touchEnd" || type === "touchCancel" ? [] : [{ x, y }],
    });
  await touch("touchStart", cx, cy);
  await touch("touchMove", cx + 20, cy);
  await touch("touchCancel", cx + 20, cy);
  await page.waitForTimeout(150);
  const settled = await transform();
  // A later touch outside the frame must not drag the photo.
  const outside = (await page
    .getByRole("button", { name: "取消" })
    .boundingBox())!;
  await touch("touchStart", outside.x + 5, outside.y + 5);
  await touch("touchMove", outside.x + 60, outside.y + 5);
  await touch("touchEnd", outside.x + 60, outside.y + 5);
  expect(await transform()).toBe(settled);
});
