import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { inflateSync } from "node:zlib";

import { describe, expect, it } from "vitest";

const assetsRoot = new URL("../../../packages/ui/src/assets/", import.meta.url);
const demoAssetsRoot = new URL(
  "../../../docs/design-system/assets/demo/",
  import.meta.url,
);

const collectSvgFiles = async (directory: URL): Promise<URL[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: URL[] = [];
  for (const entry of entries) {
    const url = new URL(
      entry.name + (entry.isDirectory() ? "/" : ""),
      directory,
    );
    if (entry.isDirectory()) files.push(...(await collectSvgFiles(url)));
    else if (entry.name.endsWith(".svg")) files.push(url);
  }
  return files;
};

const collectRasterFiles = async (directory: URL): Promise<URL[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: URL[] = [];
  for (const entry of entries) {
    const url = new URL(
      entry.name + (entry.isDirectory() ? "/" : ""),
      directory,
    );
    if (entry.isDirectory()) {
      files.push(...(await collectRasterFiles(url)));
    } else if (/\.(?:png|jpe?g|webp|gif)$/i.test(entry.name)) {
      files.push(url);
    }
  }
  return files;
};

const readPng = async (file: URL) => {
  const png = await readFile(file);
  expect(png.subarray(0, 8)).toEqual(
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  );
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const bitDepth = png[24];
  const colorType = png[25];
  const idat: Buffer[] = [];
  let offset = 8;
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    if (type === "IDAT") {
      idat.push(png.subarray(offset + 8, offset + 8 + length));
    }
    offset += length + 12;
  }
  const packed = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const rows: Buffer[] = [];
  const paeth = (left: number, up: number, upperLeft: number) => {
    const prediction = left + up - upperLeft;
    const leftDistance = Math.abs(prediction - left);
    const upDistance = Math.abs(prediction - up);
    const upperLeftDistance = Math.abs(prediction - upperLeft);
    if (leftDistance <= upDistance && leftDistance <= upperLeftDistance) {
      return left;
    }
    return upDistance <= upperLeftDistance ? up : upperLeft;
  };
  for (let y = 0; y < height; y += 1) {
    const sourceOffset = y * (stride + 1);
    const filter = packed[sourceOffset];
    const row = Buffer.alloc(stride);
    const previous = rows[y - 1];
    for (let x = 0; x < stride; x += 1) {
      const raw = packed[sourceOffset + 1 + x] ?? 0;
      const left = x >= 4 ? (row[x - 4] ?? 0) : 0;
      const up = previous?.[x] ?? 0;
      const upperLeft = x >= 4 ? (previous?.[x - 4] ?? 0) : 0;
      const predictor =
        filter === 1
          ? left
          : filter === 2
            ? up
            : filter === 3
              ? Math.floor((left + up) / 2)
              : filter === 4
                ? paeth(left, up, upperLeft)
                : 0;
      row[x] = (raw + predictor) & 255;
    }
    rows.push(row);
  }
  return { bitDepth, colorType, height, rows, width };
};

describe("SVG assets", () => {
  it("are self-contained, safe, and use viewBox", async () => {
    const files = await collectSvgFiles(assetsRoot);
    expect(files.length).toBeGreaterThanOrEqual(24);

    for (const file of files) {
      const svg = await readFile(file, "utf8");
      expect(svg, file.pathname).toContain("viewBox=");
      expect(svg, file.pathname).not.toMatch(
        /base64|<image\b|<foreignObject\b/i,
      );
      expect(svg, file.pathname).not.toMatch(
        /(?:href|xlink:href)="(?:https?:\/\/|file:)|\/Users\//i,
      );
      expect(svg, file.pathname).not.toMatch(/font-family|<text\b/i);
    }
  });

  it("does not publish documentation demo images from the UI package", async () => {
    const entries = await readdir(assetsRoot);
    expect(entries).not.toContain("demo");
  });

  it("keeps all icons themeable with currentColor", async () => {
    const iconDirectory = new URL("icons/", assetsRoot);
    const icons = (await collectSvgFiles(iconDirectory)).filter(
      (file) => !file.pathname.endsWith("README.md"),
    );
    expect(icons).toHaveLength(30);
    for (const icon of icons) {
      expect(await readFile(icon, "utf8"), icon.pathname).toContain(
        "currentColor",
      );
    }
  });

  it("preserves approved linear artwork and corrected Nearby viewport bounds", async () => {
    const expectedHashes: Record<string, string> = {
      "home.svg":
        "e9273d0ad3923611970593046872ef21439c8bd666a498179f09833d7019c5ec",
      "inscriptions.svg":
        "671209be8eeb555d45c39c202a0bc11b6104ee8a315211e0262e8b9fc7cc2b86",
      "calligraphy.svg":
        "f6183bf0ac78d8d6544de1e5d627f93f7c08f2bb97bf3bf8bc8f3da30ea2acba",
      "search.svg":
        "81331e6be09b05b6c632cdda9fa9899de50e21586d5def182ba871bff72e7ed1",
      "back.svg":
        "a3c3c4caa65ef56dce6f4c4c7f6f9a38d907563b89fe1b3ce8fc895129c5b799",
      "menu.svg":
        "d2b6388b44e64553edcaa20a56825b6cf91f84c8a075a4fb3b928d54387745be",
      "close.svg":
        "12f27442546b14fbb963a0dcc5fe3bad9830422fc9e858f71ceb1ce67b49173b",
      "filter.svg":
        "f28fed7134e50bd4b6f449ca2ad16317fbc196b6d8580d416ca5849696715204",
      "category.svg":
        "5e0be9fe42417c305b15b608b246d7ad36595892431e4d8a6602d35b6fcd6fda",
      "location.svg":
        "fbdfff7b1cc3b54524f6893188a97b981afa9f4ce6d32d442159faad83305ae4",
      "nearby.svg":
        "92802c7be0c935279134e6331b2cbd3b8fcf056d3937d71cce5458ff753b432b",
      "image.svg":
        "1fbedc6c2c6fa9a308f644bff7a0a9c032f0c2d779f3137155221ca112018f61",
      "loading.svg":
        "7b0cec88bb7361d2543742ef2df15632b14d11583680de1eb53866d55c860321",
      "error.svg":
        "6663e5d2bb5926dd697dfcedfb415ef4ac20c262c12318fc1ab963675be5da19",
      "empty.svg":
        "b8599724d3a08f2e5a6572cbf1ca69289a99cbe49bc9927baa41c1f49dbadb00",
      "previous.svg":
        "3d9b3fb377c07e21c64c38c84241df7bd224419db987f7c83b47bec2642c1040",
      "next.svg":
        "482f92b2e4b86353f750b292d74c215b98d4efd78f8013aed68c527a066cd58b",
    };
    for (const [name, hash] of Object.entries(expectedHashes)) {
      const icon = await readFile(new URL(`icons/${name}`, assetsRoot));
      // The Owner's phone feedback requires the Nearby outer strokes to fit.
      // Normalize only its viewport when proving the original artwork remains.
      const original =
        name === "nearby.svg"
          ? icon
              .toString("utf8")
              .replace('viewBox="-2 0 28 24"', 'viewBox="0 0 24 24"')
          : icon;
      if (name === "nearby.svg")
        expect(icon.toString("utf8")).toContain('viewBox="-2 0 28 24"');
      expect(createHash("sha256").update(original).digest("hex"), name).toBe(
        hash,
      );
      expect(icon.toString("utf8"), name).toContain('stroke="currentColor"');
    }
  });

  it("adds a self-contained linear settings icon", async () => {
    const settings = await readFile(
      new URL("icons/settings.svg", assetsRoot),
      "utf8",
    );
    expect(settings).toContain("<title>设置</title>");
    expect(settings).toContain('stroke="currentColor"');
    expect(settings).toContain('stroke-width="1.7"');
    expect(settings).not.toMatch(
      /<text\b|<image\b|base64|(?:href|xlink:href)="https?:\/\/|\/Users\//i,
    );
  });

  it("adds linear theme and layout toggle icons with a shared stroke", async () => {
    const icons: Record<string, string> = {
      "theme-light.svg": "浅色",
      "theme-dark.svg": "深色",
      "theme-system.svg": "跟随系统",
      "layout-single.svg": "单列",
      "layout-double.svg": "双列",
    };
    for (const [name, title] of Object.entries(icons)) {
      const svg = await readFile(new URL(`icons/${name}`, assetsRoot), "utf8");
      expect(svg, name).toContain(`<title>${title}</title>`);
      expect(svg, name).toContain('viewBox="0 0 24 24"');
      expect(svg, name).toContain('stroke="currentColor"');
      expect(svg, name).toContain('stroke-width="1.7"');
      expect(svg, name).toContain('stroke-linecap="round"');
      expect(svg, name).toContain('stroke-linejoin="round"');
      expect(svg, name).not.toMatch(
        /<text\b|<image\b|base64|(?:href|xlink:href)="https?:\/\/|\/Users\//i,
      );
    }
  });

  it("uses the three normalized transparent PNG navigation marks", async () => {
    const labelDirectory = new URL("labels/", assetsRoot);
    const rasterFiles = await collectRasterFiles(assetsRoot);
    const labels = rasterFiles.map((file) => file.pathname.split("/").at(-1));
    const expectedHashes: Record<string, string> = {
      "nav-home.png":
        "d66caaed4e6ca1035c38f0330e8a18b523364f6acc8dc45c8a9e886ff143e7cc",
      "nav-inscriptions.png":
        "7864c22fb411b8ebb20015f11434c590098d82c8bfdd6b1a3fd5b86bdb279f35",
      "nav-calligraphy.png":
        "8892d62fa16435896a142c345d65400037d1a8330011b470fe0d99995fffdec8",
    };
    expect(labels).toHaveLength(3);
    expect(labels.sort()).toEqual([
      "nav-calligraphy.png",
      "nav-home.png",
      "nav-inscriptions.png",
    ]);
    for (const label of labels) {
      if (!label) throw new Error("missing PNG filename");
      const bytes = await readFile(new URL(label, labelDirectory));
      expect(createHash("sha256").update(bytes).digest("hex"), label).toBe(
        expectedHashes[label],
      );
      const png = await readPng(new URL(label, labelDirectory));
      expect(png.width, label).toBe(264);
      expect(png.height, label).toBe(120);
      expect(png.bitDepth, label).toBe(8);
      expect(png.colorType, label).toBe(6);
      const alpha = png.rows.flatMap((row) =>
        Array.from({ length: png.width }, (_, x) => row[x * 4 + 3] ?? 0),
      );
      expect(Math.min(...alpha), label).toBe(0);
      expect(Math.max(...alpha), label).toBe(255);
      expect(
        png.rows[0]?.every(
          (channel, index) => index % 4 !== 3 || channel === 0,
        ),
        label,
      ).toBe(true);
      expect(
        png.rows
          .at(-1)
          ?.every((channel, index) => index % 4 !== 3 || channel === 0),
        label,
      ).toBe(true);
      expect(
        png.rows.every((row) => row[3] === 0),
        label,
      ).toBe(true);
      expect(
        png.rows.every((row) => row[(png.width - 1) * 4 + 3] === 0),
        label,
      ).toBe(true);
    }
  });

  it("preserves the current Owner-approved ArtVenn mark", async () => {
    const logo = await readFile(new URL("brand/yoyi-logo.svg", assetsRoot));
    const hash = createHash("sha256").update(logo).digest("hex");
    expect(hash).toBe(
      "a611503f5256a806cf11d66efcc0b34817b7bb5017a9743152337cadac0bb5d4",
    );
    expect(logo.toString("utf8").match(/<path\b/g)).toHaveLength(2);
  });

  it("keeps paper texture opacity below the readability ceiling", async () => {
    const textureDirectory = new URL("textures/", assetsRoot);
    const textures = await collectSvgFiles(textureDirectory);
    expect(textures).toHaveLength(4);
    const expectedOpacity: Record<string, number> = {
      "paper-subtle.svg": 0.048,
      "paper-visible.svg": 0.068,
      "paper-dark-subtle.svg": 0.045,
      "paper-dark-visible.svg": 0.065,
    };
    for (const texture of textures) {
      const svg = await readFile(texture, "utf8");
      const opacity = Number(svg.match(/opacity="([0-9.]+)"/)?.[1]);
      expect(opacity, texture.pathname).toBeLessThanOrEqual(0.07);
      expect(opacity, texture.pathname).toBe(
        expectedOpacity[texture.pathname.split("/").at(-1) ?? ""],
      );
      expect(svg).toContain('viewBox="0 0 384 512"');
      expect(svg).toContain('baseFrequency="0.16 0.008"');
      expect(svg).toContain('baseFrequency="0.006 0.012"');
      expect(svg).toContain('stitchTiles="stitch"');
    }
  });
});

describe("documentation demo assets", () => {
  it("preserves all eleven fixtures byte-for-byte outside the UI package", async () => {
    const expectedHashes: Record<string, string> = {
      "calligraphy-sheet.svg":
        "313d8971b4d885ffbd635caedadda8faa1834814cfb9275d604e5a6ab19e53c6",
      "cliff-gate.svg":
        "1457ff8f7f534908a64bc47f04e6c92d822ff1d131b599a172834fac9c36b966",
      "discovery-stone.svg":
        "370827ce58001a1673dbdd43a3e75d02be783f04bd4852e38daacc374459292b",
      "ink-album.svg":
        "e60d38b4c822a2ce377e7346306987c1932cbc24ed95580ff05f00d9b405ac7e",
      "inscription-rubbing.svg":
        "5150fdd47a9a269fcf4046cdff033b745fd7eb6eebfcdfac56589dc39480fa8f",
      "qa-visual-square.svg":
        "ec46a4e2a97f5fb231f77312696f804dc4bdd95b8ee83b65422897c7e82b05f2",
      "qa-visual-ultrawide.svg":
        "1e484333f256758bcccefec08032f8046fcc87d8dc6610457402d23fa8d5a18b",
      "rubbing-fragment.svg":
        "1e112e783bef1e688b575d1495d11f9516ea273cb8d9da4a3c430b07412bb72c",
      "stele-shadow.svg":
        "cb1cf9b3e3d38cfd077a700890a1ce07c1c1ec6c234c800b7df6c8f2540e297f",
      "stone-detail.svg":
        "daa46229a4de1a8314ca97303aaab2d381d7d9f21ce906b169e0fba2444f629a",
      "valley-wall.svg":
        "25735a88b90beb5a72e84bb43b36d7bf4742a67d600693b9ab5a7fb902ccc50c",
    };
    const files = await collectSvgFiles(demoAssetsRoot);
    expect(files).toHaveLength(11);
    for (const file of files) {
      const name = file.pathname.split("/").at(-1) ?? "";
      const bytes = await readFile(file);
      expect(createHash("sha256").update(bytes).digest("hex"), name).toBe(
        expectedHashes[name],
      );
    }
  });
});
