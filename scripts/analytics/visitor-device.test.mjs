import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { UMAMI_VISITOR_DEVICE_SHA256 } from "./common.mjs";
import { runtimePolicy, COMPATIBILITY_POLICY } from "./runtime-policy.mjs";

const directory = new URL("../../infra/production/umami/", import.meta.url);
const bytes = (name) => readFile(new URL(name, directory));
const hash = (value) => createHash("sha256").update(value).digest("hex");
const inventory = (value) => {
  const rows = value
    .toString()
    .trim()
    .split("\n")
    .map((line) => {
      const match = /^([a-f0-9]{64}) {2}(src\/.+)$/u.exec(line);
      assert.ok(match, "Only pinned native source paths belong in this layer");
      return [match[2], match[1]];
    });
  assert.equal(new Set(rows.map(([name]) => name)).size, rows.length);
  return new Map(rows);
};

test("visitor/device patch and exact source inventories are pinned for both runtime policies", async () => {
  const patch = await bytes("visitor-device.patch");
  const source = JSON.parse(await bytes("source.json"));
  const paths = [...patch.toString().matchAll(/^\+\+\+ b\/(.+)$/gmu)].map(
    (match) => match[1],
  );
  assert.equal(hash(patch), UMAMI_VISITOR_DEVICE_SHA256);
  assert.equal(source.visitorDevice.sha256, UMAMI_VISITOR_DEVICE_SHA256);
  assert.equal(paths.length, source.visitorDevice.files);
  assert.equal(new Set(paths).size, paths.length);
  assert.ok(
    paths.every((name) => name.startsWith("src/") && !name.includes("../")),
  );
  assert.ok(
    !paths.some((name) => /(?:package\.json|lock|prisma\/schema)/u.test(name)),
  );
  for (const [beforeName, afterName] of [
    ["visitor-device-upstream.sha256", "visitor-device.sha256"],
    ["visitor-device-compat-upstream.sha256", "visitor-device-compat.sha256"],
  ]) {
    const before = inventory(await bytes(beforeName));
    const after = inventory(await bytes(afterName));
    assert.deepEqual([...after.keys()].sort(), [...paths].sort());
    assert.ok([...before.keys()].every((name) => after.has(name)));
    assert.ok(
      before.size < after.size,
      "New helpers remain explicit additions",
    );
  }
  assert.equal(
    runtimePolicy().visitorDevicePatchSha256,
    UMAMI_VISITOR_DEVICE_SHA256,
  );
  assert.equal(
    runtimePolicy(COMPATIBILITY_POLICY).visitorDevicePatchSha256,
    UMAMI_VISITOR_DEVICE_SHA256,
  );
});

test("both build policies verify their own baseline before the same additive patch", async () => {
  for (const [name, compat, expectedLayers] of [
    ["Dockerfile", false, 2],
    ["Dockerfile.ui-pre365-v1", true, 1],
  ]) {
    const recipe = (await bytes(name)).toString();
    const before = compat
      ? "visitor-device-compat-upstream.sha256"
      : "visitor-device-upstream.sha256";
    const after = compat
      ? "visitor-device-compat.sha256"
      : "visitor-device.sha256";
    assert.equal(
      recipe.split("patch -p1 --fuzz=0 < /tmp/visitor-device.patch").length - 1,
      expectedLayers,
    );
    for (const file of [before, after]) {
      assert.ok(recipe.includes(`${hash(await bytes(file))}  /tmp/${file}`));
      assert.ok(recipe.includes(`sha256sum -c /tmp/${file}`));
    }
    assert.ok(
      recipe.includes(
        `${UMAMI_VISITOR_DEVICE_SHA256}  /tmp/visitor-device.patch`,
      ),
    );
    assert.ok(
      recipe.includes(
        `com.artvenn.umami.visitor-device-sha256="${UMAMI_VISITOR_DEVICE_SHA256}"`,
      ),
    );
    assert.ok(recipe.includes("src/lib/artvenn-device.test.ts"));
    const ignore = (
      await bytes(compat ? `${name}.dockerignore` : ".dockerignore")
    ).toString();
    for (const file of ["visitor-device.patch", before, after])
      assert.ok(ignore.includes(`!${file}\n`));
    if (compat)
      assert.ok(
        recipe.indexOf("node /tmp/ui-pre365-v1-verify.mjs") <
          recipe.indexOf("COPY visitor-device.patch"),
      );
  }
});
