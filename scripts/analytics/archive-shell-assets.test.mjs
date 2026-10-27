import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
// Only a local test override: integrated CI reads its own canonical workspace.
const canonicalRoot = process.env.ADMIN_SHELL_CANONICAL_ROOT
  ? path.resolve(process.env.ADMIN_SHELL_CANONICAL_ROOT)
  : repositoryRoot;
const directory = path.join(repositoryRoot, "infra/production/umami");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const targets = {
  "archive-theme.css": "src/app/archive-theme.css",
  "archive-navigation.json": "src/data/archive-navigation.json",
  "archive-icons.svg": "public/archive-icons.svg",
};
let snapshots;
const readSnapshots = () =>
  (snapshots ??= (async () => {
    const { workspaces } = await import(
      pathToFileURL(
        path.join(canonicalRoot, "apps/admin/src/workspace/routes.ts"),
      )
    );
    const needed = [
      ...new Set([
        ...workspaces.map(({ icon }) => icon),
        "menu",
        "close",
        "theme-light",
        "theme-dark",
        "user",
        "loading",
        "back",
      ]),
    ];
    const sources = new Map();
    for (const name of [
      "packages/design-tokens/src/theme.css",
      "apps/admin/src/workspace/routes.ts",
      ...needed.map((name) => `packages/ui/src/assets/icons/${name}.svg`),
    ])
      sources.set(name, await readFile(path.join(canonicalRoot, name)));
    const generated = new Map();
    for (const name of Object.keys(targets))
      generated.set(name, await readFile(path.join(directory, name)));
    return { workspaces, needed, sources, generated };
  })());

test("archive theme and navigation snapshots match the canonical Admin sources", async () => {
  const { workspaces, sources, generated } = await readSnapshots();
  assert.deepEqual(
    generated.get("archive-theme.css"),
    sources.get("packages/design-tokens/src/theme.css"),
  );
  const navigation = JSON.parse(generated.get("archive-navigation.json"));
  const items = workspaces.map(({ id, label, icon, pages }) => ({
    id,
    label,
    icon,
    href: pages[0].href,
  }));
  const dataLinks = workspaces.find(({ id }) => id === "analytics").pages;
  assert.equal(items.length, 8);
  assert.equal(dataLinks.length, 4);
  assert.deepEqual(navigation, {
    brandLabel: "由艺",
    caption: "管理后台",
    homeHref: "/admin",
    brandAssetHref: "/admin/brand.svg",
    accountHref: "/admin/account",
    themeCookieName: "payload-theme",
    items,
    dataLinks,
  });
  assert.equal(
    generated.get("archive-navigation.json").toString(),
    `${JSON.stringify(navigation, null, 2)}\n`,
  );
});

test("every archive sprite symbol is the canonical artwork without duplicate or extra icons", async () => {
  const { needed, sources, generated } = await readSnapshots();
  const actual = generated.get("archive-icons.svg").toString();
  const symbols = [
    ...actual.matchAll(
      /<symbol id="([^"]+)" viewBox="([^"]+)">([\s\S]*?)<\/symbol>/gu,
    ),
  ];
  assert.deepEqual(
    symbols.map((match) => match[1]),
    needed,
  );
  assert.equal(new Set(symbols.map((match) => match[1])).size, needed.length);
  const expected = needed.map((name, index) => {
    const svg = sources
      .get(`packages/ui/src/assets/icons/${name}.svg`)
      .toString();
    const viewBox = /viewBox="([^"]+)"/u.exec(svg)?.[1];
    const artwork = svg
      .replace(/^<svg[^>]*>/u, "")
      .replace(/<\/svg>\s*$/u, "")
      .replace(/<title>[\s\S]*?<\/title>/gu, "");
    assert.ok(viewBox && artwork);
    assert.equal(symbols[index][2], viewBox);
    assert.equal(symbols[index][3], artwork);
    return `<symbol id="${name}" viewBox="${viewBox}">${artwork}</symbol>`;
  });
  assert.equal(
    actual,
    `<svg xmlns="http://www.w3.org/2000/svg">${expected.join("")}</svg>\n`,
  );
});

test("archive source hashes, generated hashes and checksum targets are all bound", async () => {
  const { sources, generated } = await readSnapshots();
  const manifest = JSON.parse(
    await readFile(path.join(directory, "archive-assets.json"), "utf8"),
  );
  assert.deepEqual(manifest, {
    version: 1,
    sources: Object.fromEntries(
      [...sources].map(([name, bytes]) => [name, hash(bytes)]),
    ),
    generated: Object.fromEntries(
      [...generated].map(([name, bytes]) => [
        name,
        { sha256: hash(bytes), target: targets[name] },
      ]),
    ),
  });
  assert.equal(
    await readFile(path.join(directory, "archive-assets.sha256"), "utf8"),
    [...generated]
      .map(([name, bytes]) => `${hash(bytes)}  ${targets[name]}`)
      .join("\n") + "\n",
  );
});

test("both Docker builders copy and verify the archive snapshots before building the pinned UI", async () => {
  const { generated } = await readSnapshots();
  const dockerfile = await readFile(path.join(directory, "Dockerfile"), "utf8");
  const stages = new Map(
    dockerfile
      .split(/^FROM /mu)
      .slice(1)
      .map((body) => [/^\S+ AS (\S+)\n/u.exec(body)?.[1], body]),
  );
  for (const name of ["builder", "standalone-builder"]) {
    const body = stages.get(name);
    assert.ok(body, `Missing ${name} stage`);
    const instructions = body.replace(/[ \t]*\\\n[ \t]*/gu, " ").split("\n");
    const checksum = "RUN sha256sum -c /tmp/archive-assets.sha256";
    const copies = [
      ...Object.entries(targets).map(
        ([source, target]) => `COPY ${source} /app/${target}`,
      ),
      "COPY archive-assets.sha256 /tmp/archive-assets.sha256",
    ];
    for (const copy of copies) {
      assert.equal(
        instructions.filter((line) => line === copy).length,
        1,
        `${name}: ${copy}`,
      );
      assert.ok(
        body.indexOf(copy) < body.indexOf(checksum),
        `${name}: COPY precedes verification`,
      );
    }
    assert.equal(instructions.filter((line) => line === checksum).length, 1);
    assert.ok(body.indexOf(checksum) < body.indexOf("pnpm build:docker"));
  }
  const patch = await readFile(
    path.join(directory, "chinese-workspace.patch"),
    "utf8",
  );
  const helper = patch
    .split(/(?=^--- )/mu)
    .find((block) => block.includes("\n+++ b/src/lib/archive-admin.ts\n"));
  assert.ok(helper, "Archive runtime helper must be part of the pinned patch");
  for (const bytes of generated.values())
    assert.ok(
      helper.includes(hash(bytes)),
      "Runtime helper binds every snapshot hash into the patch identity",
    );
});
