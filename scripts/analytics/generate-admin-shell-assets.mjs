import { readFile, writeFile } from "node:fs/promises";
import { Buffer } from "node:buffer";
import console from "node:console";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const destination = path.join(root, "infra/production/umami");
const { workspaces } = await import(
  pathToFileURL(path.join(root, "apps/admin/src/workspace/routes.ts"))
);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sources = {};
const read = async (relative) => {
  const bytes = await readFile(path.join(root, relative));
  sources[relative] = hash(bytes);
  return bytes;
};
const theme = await read("packages/design-tokens/src/theme.css");
const navigation = {
  brandLabel: "由于艺",
  caption: "管理后台",
  homeHref: "/admin",
  brandAssetHref: "/admin/brand.svg",
  accountHref: "/admin/account",
  themeCookieName: "payload-theme",
  items: workspaces.map(({ id, label, icon, pages }) => ({
    id,
    label,
    icon,
    href: pages[0].href,
  })),
  dataLinks: workspaces.find(({ id }) => id === "analytics").pages,
};
sources["apps/admin/src/workspace/routes.ts"] = hash(
  await readFile(path.join(root, "apps/admin/src/workspace/routes.ts")),
);
const needed = [
  ...new Set([
    ...navigation.items.map(({ icon }) => icon),
    "menu",
    "close",
    "theme-light",
    "theme-dark",
    "user",
    "loading",
    "back",
  ]),
];
const symbols = [];
for (const name of needed) {
  const svg = (
    await read("packages/ui/src/assets/icons/" + name + ".svg")
  ).toString();
  const view = /viewBox="([^"]+)"/u.exec(svg)?.[1];
  const inner = svg
    .replace(/^<svg[^>]*>/u, "")
    .replace(/<\/svg>\s*$/u, "")
    .replace(/<title>[\s\S]*?<\/title>/gu, "");
  if (!view || !inner) throw new Error("CANONICAL_ICON_REQUIRED");
  symbols.push(`<symbol id="${name}" viewBox="${view}">${inner}</symbol>`);
}
const icons = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg">${symbols.join("")}</svg>\n`,
);
const outputs = {
  "archive-theme.css": theme,
  "archive-navigation.json": Buffer.from(
    JSON.stringify(navigation, null, 2) + "\n",
  ),
  "archive-icons.svg": icons,
};
for (const [name, bytes] of Object.entries(outputs))
  await writeFile(path.join(destination, name), bytes);
const targets = {
  "archive-theme.css": "src/app/archive-theme.css",
  "archive-navigation.json": "src/data/archive-navigation.json",
  "archive-icons.svg": "public/archive-icons.svg",
};
await writeFile(
  path.join(destination, "archive-assets.sha256"),
  Object.entries(outputs)
    .map(([name, bytes]) => `${hash(bytes)}  ${targets[name]}`)
    .join("\n") + "\n",
);
await writeFile(
  path.join(destination, "archive-assets.json"),
  JSON.stringify(
    {
      version: 1,
      sources,
      generated: Object.fromEntries(
        Object.entries(outputs).map(([name, bytes]) => [
          name,
          { sha256: hash(bytes), target: targets[name] },
        ]),
      ),
    },
    null,
    2,
  ) + "\n",
);
console.log(
  JSON.stringify({
    generated: Object.keys(outputs),
    canonicalSources: Object.keys(sources).length,
  }),
);
