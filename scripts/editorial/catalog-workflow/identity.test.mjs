import assert from "node:assert/strict";
import test from "node:test";
import {
  digest,
  targetIdentity,
  validateManifest,
  verifyPrincipal,
} from "./identity.mjs";

const hash = (value) => value.repeat(64);
const clone = (value) => JSON.parse(JSON.stringify(value));
const fixture = () => ({
  version: 1,
  batchId: "synthetic-workflow-1",
  target: {
    instance: "development",
    origin: "http://127.0.0.1:12345",
    actorId: 1,
    role: "owner",
  },
  records: [
    {
      recordId: "SYNTHETIC-001",
      catalogId: "catalog-synthetic-1",
      sourceId: "source-synthetic-1",
      contentSha256: hash("a"),
      disposition: "draft",
      reuseOnly: true,
      protections: {
        rightsHold: false,
        explicitlyHidden: false,
        withdrawn: false,
      },
      media: [
        {
          mediaId: "media-synthetic-1",
          sourceSha256: hash("b"),
          uploadedSha256: hash("c"),
          bytes: 100,
          width: 100,
          height: 200,
          position: 0,
          isRepresentative: true,
        },
      ],
    },
  ],
});

const principal = (manifest) => ({
  ...manifest.target,
  verified: true,
  scopeCatalogIds: manifest.records.map((row) => row.catalogId),
});
const rejects = (work, code) =>
  assert.throws(work, (error) => error.code === code);

test("canonical object ordering is stable; media sequence remains significant", () => {
  assert.equal(digest({ b: 1, a: 2 }), digest({ a: 2, b: 1 }));
  assert.notEqual(digest([1, 2]), digest([2, 1]));
});

test("JSON identity refuses lossy values, non-JSON objects and cycles", () => {
  for (const value of [
    undefined,
    NaN,
    Infinity,
    new Date(),
    new Map(),
    Array(1),
  ])
    rejects(() => digest(value), "NON_JSON_INPUT");
  const cycle = {};
  cycle.self = cycle;
  rejects(() => digest(cycle), "NON_JSON_INPUT");
});

test("same exact manifest and verified principal survives credential refresh", () => {
  const manifest = fixture();
  const actual = principal(manifest);
  const first = verifyPrincipal(manifest, {
    ...actual,
    sessionToken: "SYNTHETIC_SESSION_FIRST",
  });
  const refreshed = verifyPrincipal(manifest, {
    ...actual,
    sessionToken: "SYNTHETIC_SESSION_RENEWED",
  });
  assert.equal(first, refreshed);
  assert.equal(first, targetIdentity(clone(manifest)));
});

test("a declared account without verified authentication is insufficient", () => {
  const manifest = fixture();
  rejects(
    () =>
      verifyPrincipal(manifest, { ...principal(manifest), verified: false }),
    "PRINCIPAL_OR_SCOPE_CHANGED",
  );
});

test("principal, origin, role and selected scope drift are rejected", () => {
  const manifest = fixture();
  for (const patch of [
    { actorId: 2 },
    { role: "automation" },
    { instance: "production" },
    { origin: "https://example.invalid" },
    { scopeCatalogIds: [] },
  ])
    rejects(
      () => verifyPrincipal(manifest, { ...principal(manifest), ...patch }),
      "PRINCIPAL_OR_SCOPE_CHANGED",
    );
});

test("credentials and unknown instruction fields cannot enter the manifest", () => {
  for (const alter of [
    (row) => (row.sessionToken = "SYNTHETIC_ONLY"),
    (row) => (row.target.apiKey = "SYNTHETIC_ONLY"),
    (row) => (row.records[0].confirmed = true),
    (row) => (row.records[0].media[0].instructions = "publish"),
  ]) {
    const manifest = fixture();
    alter(manifest);
    rejects(() => validateManifest(manifest), "MANIFEST_INVALID");
  }
});

test("production cannot target a loopback or credential-bearing origin", () => {
  for (const origin of [
    "http://example.invalid",
    "https://localhost",
    "https://127.0.0.1",
    "https://user:placeholder@example.invalid",
    "https://example.invalid/?token=SYNTHETIC_ONLY",
  ]) {
    const manifest = fixture();
    manifest.target.instance = "production";
    manifest.target.origin = origin;
    rejects(() => validateManifest(manifest), "TARGET_INVALID");
  }
});

test("representative selection is independent of first reading position", () => {
  const manifest = fixture();
  manifest.records[0].media[0].isRepresentative = false;
  manifest.records[0].media.push({
    ...manifest.records[0].media[0],
    mediaId: "media-synthetic-2",
    position: 3,
    isRepresentative: true,
  });
  assert.equal(validateManifest(manifest), manifest);
  assert.equal(manifest.records[0].media[0].position, 0);
  assert.equal(manifest.records[0].media[1].position, 3);
});

test("duplicate identities, changed order and ambiguous covers are rejected", () => {
  for (const alter of [
    (row) => row.records.push(clone(row.records[0])),
    (row) => row.records[0].media.push(clone(row.records[0].media[0])),
    (row) => (row.records[0].media[0].position = -1),
    (row) => (row.records[0].media[0].isRepresentative = false),
  ]) {
    const manifest = fixture();
    alter(manifest);
    rejects(() => validateManifest(manifest), "MANIFEST_INVALID");
  }
});

for (const kind of ["duplicate-source", "cross-kind-identity"]) {
  test(`server-bound ${kind} conflict is rejected before any operation`, () => {
    const manifest = fixture();
    const second = clone(manifest.records[0]);
    second.recordId = "SYNTHETIC-002";
    second.catalogId = "catalog-synthetic-2";
    second.sourceId = "source-synthetic-2";
    second.media[0].mediaId = "media-synthetic-2";
    if (kind === "duplicate-source")
      second.sourceId = manifest.records[0].sourceId;
    else second.catalogId = manifest.records[0].sourceId;
    manifest.records.push(second);
    rejects(() => validateManifest(manifest), "MANIFEST_INVALID");
  });
}

test("source/output byte identity and holds are part of the frozen manifest", () => {
  const manifest = fixture();
  const original = digest(validateManifest(manifest));
  for (const alter of [
    (row) => (row.records[0].media[0].uploadedSha256 = hash("d")),
    (row) => (row.records[0].protections.rightsHold = true),
    (row) => (row.records[0].protections.explicitlyHidden = true),
    (row) => (row.records[0].protections.withdrawn = true),
  ]) {
    const changed = clone(manifest);
    alter(changed);
    assert.notEqual(digest(validateManifest(changed)), original);
  }
});
