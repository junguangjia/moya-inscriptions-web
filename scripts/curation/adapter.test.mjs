/** Mocked unit tests only. These are not native CMS integration evidence. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { Buffer } from "node:buffer";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  atomicPrivateJSON,
  createDraftReadClient,
  dependencies,
  developmentOrigin,
  draftRoundtrip,
  privateJSON,
  validatePublicationPackage,
} from "./adapter.mjs";

const { Response, URL } = globalThis;
const repoRoot =
  process.env.ARTVENN_CURATION_TEST_REPO ??
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fakeConfig = {
  instance: "development",
  syntheticOnly: true,
  targetVerified: true,
  baseURL: "http://127.0.0.1:43219",
  apiKey: "SYNTHETIC_TEST_ONLY_NOT_A_REAL_KEY",
  catalogIds: ["synthetic-catalog-a", "synthetic-catalog-b"],
};
const object = (suffix = "a") => ({
  objectId: `object-${suffix}`,
  catalogId: `synthetic-catalog-${suffix}`,
  sourceId: `synthetic-source-${suffix}`,
  kind: "calligraphy",
  title: `Synthetic ${suffix}`,
  fields: {
    transcription: { state: "VALUE", value: "合成資料\n〔缺〕" },
    dateText: { state: "UNSUPPLIED" },
  },
  media: [],
  localAnnotations: {
    modelConfidence: 0.2,
    reviewDecision: "test fixture only",
  },
});
const fixture = (objects) => ({
  version: 1,
  instance: "development",
  synthetic: true,
  selectionConfirmed: true,
  objects,
});
const fingerprint = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

function mockedCMS(deps) {
  const documents = new Map();
  const receipts = new Map();
  const media = new Map();
  const calls = [];
  const server = { failCatalog: null, calls, documents, media, created: 0 };
  const json = (value, status = 200) => Response.json(value, { status });
  server.fetch = async (url, options = {}) => {
    const target = new URL(url);
    const route = target.pathname;
    calls.push(route);
    const authenticated = !!options.headers?.Authorization;
    if (!authenticated)
      return json(
        { ok: false, error: { code: "AUTHORIZATION_REQUIRED" } },
        403,
      );
    if (route === "/api/media" && options.method === "POST") {
      const metadata = JSON.parse(options.body.get("_payload"));
      const bytes = Buffer.from(await options.body.get("file").arrayBuffer());
      const image = await deps.sharp(bytes).metadata();
      const record = {
        ...metadata,
        id: media.size + 1,
        objectKey: "synthetic-unit/" + metadata.mediaId,
        filename: metadata.mediaId + ".png",
        sha256: createHash("sha256").update(bytes).digest("hex"),
        width: image.width,
        height: image.height,
      };
      media.set(metadata.mediaId, { record, bytes });
      return json({ doc: record });
    }
    if (route === "/api/media") {
      const item = media.get(target.searchParams.get("where[mediaId][equals]"));
      return json({ docs: item ? [item.record] : [] });
    }
    if (route.startsWith("/api/media/file/")) {
      const item = [...media.values()].find(
        (value) =>
          value.record.filename ===
          decodeURIComponent(route.slice("/api/media/file/".length)),
      );
      return item ? new Response(item.bytes) : json({ ok: false }, 404);
    }
    if (route === "/api/editorial/read-draft") {
      let doc = documents.get(JSON.parse(options.body).id);
      if (doc && server.nativeDefaults)
        doc = {
          ...doc,
          content: {
            ...doc.content,
            ...Object.fromEntries(
              deps.EDITORIAL_STATEFUL_FIELDS.map((key) => [
                key,
                doc.content[key] ?? {
                  state:
                    server.inventUnknown && key === "province"
                      ? "UNKNOWN"
                      : "UNSUPPLIED",
                },
              ]),
            ),
          },
        };
      return doc
        ? json({
            ok: true,
            result: {
              id: doc.id,
              revision: doc.revision,
              fingerprint: fingerprint(doc.content),
              content: doc.content,
            },
          })
        : json({ ok: false }, 404);
    }
    if (route === "/api/editorial/save-draft") {
      const body = JSON.parse(options.body);
      if (body.content.catalogId === server.failCatalog)
        return json({ ok: false, error: { code: "CONTENT_INVALID" } }, 422);
      if (receipts.has(body.idempotencyKey)) {
        const prior = receipts.get(body.idempotencyKey);
        return prior.hash === fingerprint(body)
          ? json({ ok: true, result: { ...prior.result, replayed: true } })
          : json({ ok: false }, 409);
      }
      const content = deps.editorialDraftSchema.parse(body.content);
      let doc;
      if (body.id === undefined) {
        if (
          [...documents.values()].some(
            (row) => row.content.catalogId === content.catalogId,
          )
        )
          return json({ ok: false }, 409);
        const id = ++server.created;
        doc = { id, revision: 1, content };
        documents.set(id, doc);
      } else {
        doc = documents.get(body.id);
        if (!doc || doc.revision !== body.expectedRevision)
          return json({ ok: false, error: { code: "REVISION_CONFLICT" } }, 409);
        doc.content = server.nativePatch
          ? deps.editorialDraftSchema.parse({ ...doc.content, ...content })
          : content;
        doc.revision += 1;
      }
      const result = {
        id: doc.id,
        revision: doc.revision,
        fingerprint: fingerprint(doc.content),
        replayed: false,
      };
      receipts.set(body.idempotencyKey, { hash: fingerprint(body), result });
      return json({ ok: true, result });
    }
    if (route.startsWith("/api/catalogs/")) return json({ _status: "draft" });
    throw new Error("MOCK_ROUTE_NOT_IMPLEMENTED");
  };
  return server;
}

async function workspace(input) {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "artvenn-adapter-unit-"),
  );
  const packageFile = path.join(directory, "publication-package.json");
  const configFile = path.join(directory, "cms-config.json");
  await atomicPrivateJSON(packageFile, input);
  await atomicPrivateJSON(configFile, fakeConfig);
  return {
    directory,
    packageFile,
    configFile,
    stateDirectory: path.join(directory, "receipts"),
  };
}

test("mocked safety unit: only explicit protected Development loopback is accepted", async () => {
  assert.equal(developmentOrigin(fakeConfig), fakeConfig.baseURL);
  for (const patch of [
    { baseURL: "https://example.invalid" },
    { baseURL: "http://127.0.0.1" },
    { baseURL: "http://127.0.0.1:43219/?host=elsewhere" },
    { instance: "production" },
    { targetVerified: false },
    { syntheticOnly: false },
  ])
    assert.throws(() => developmentOrigin({ ...fakeConfig, ...patch }));
  let calls = 0;
  const client = createDraftReadClient(fakeConfig, {
    fetchImpl: async () => {
      calls += 1;
      return Response.json({});
    },
  });
  await assert.rejects(
    client.request("/api/editorial/publish-approved", "POST", {}),
    /OPERATION_NOT_AUTHORIZED/u,
  );
  await assert.rejects(
    client.request("/api/editorial/approve-batch", "POST", {}),
    /OPERATION_NOT_AUTHORIZED/u,
  );
  assert.equal(calls, 0);
});

test("offline unit with real contracts: rejects invalid canonical fields and uncontrolled identities", async () => {
  const deps = await dependencies(repoRoot);
  const valid = fixture([object()]);
  assert.equal(
    (
      await validatePublicationPackage(valid, {
        deps,
        packageDirectory: os.tmpdir(),
      })
    ).objects.length,
    1,
  );
  await assert.rejects(
    validatePublicationPackage(
      { ...valid, selectionConfirmed: false },
      { deps, packageDirectory: os.tmpdir() },
    ),
    /PUBLICATION_PACKAGE_INVALID/u,
  );
  await assert.rejects(
    validatePublicationPackage(
      fixture([{ ...object(), sourceId: object().catalogId }]),
      { deps, packageDirectory: os.tmpdir() },
    ),
    /EDITORIAL_CONTENT_INVALID/u,
  );
  await assert.rejects(
    validatePublicationPackage(
      fixture([
        {
          ...object(),
          fields: {
            dateText: { state: "VALUE", value: "合成", confidence: "HIGH" },
          },
        },
      ]),
      { deps, packageDirectory: os.tmpdir() },
    ),
    /EDITORIAL_CONTENT_INVALID/u,
  );
  await assert.rejects(
    validatePublicationPackage(
      fixture([{ ...object(), fields: { catalogId: "override" } }]),
      { deps, packageDirectory: os.tmpdir() },
    ),
    /RESERVED_EDITORIAL_FIELD/u,
  );
});

test("mocked unit: real materials never reach the transport", async () => {
  const deps = await dependencies(repoRoot);
  const files = await workspace({ ...fixture([object()]), synthetic: false });
  let calls = 0;
  await assert.rejects(
    draftRoundtrip({
      repoRoot,
      ...files,
      deps,
      fetchImpl: async () => {
        calls += 1;
      },
    }),
    /REAL_MATERIAL_TRANSFER_NOT_AUTHORIZED/u,
  );
  assert.equal(calls, 0);
});

test("mocked unit: genuine-client server replay and stale revision guard retain one identity", async () => {
  const deps = await dependencies(repoRoot);
  const files = await workspace(fixture([object()]));
  const cms = mockedCMS(deps);
  const first = await draftRoundtrip({
    repoRoot,
    ...files,
    deps,
    fetchImpl: cms.fetch,
  });
  assert.equal(first.succeeded, 1);
  assert.equal(first.failed, 0);
  assert.equal(cms.created, 1);
  assert.equal(first.results[0].revision, 2);
  const second = await draftRoundtrip({
    repoRoot,
    ...files,
    deps,
    fetchImpl: cms.fetch,
  });
  assert.equal(second.succeeded, 1);
  assert.equal(cms.created, 1);
  assert.equal(second.results[0].revision, 2);
  assert.ok(
    cms.calls.filter((route) => route === "/api/editorial/save-draft").length >=
      6,
  );
  assert.ok(
    cms.calls.every(
      (route) => !route.includes("publish") && !route.includes("approve"),
    ),
  );
  const saved = await privateJSON(
    path.join(files.stateDirectory, "adapter-state.json"),
  );
  assert.equal(saved.objects["object-a"].phase, "verified");
});

test("mocked unit: a rejected object does not discard completed objects and bounded resume recovers", async () => {
  const deps = await dependencies(repoRoot);
  const files = await workspace(fixture([object("a"), object("b")]));
  const cms = mockedCMS(deps);
  cms.failCatalog = "synthetic-catalog-b";
  const first = await draftRoundtrip({
    repoRoot,
    ...files,
    deps,
    fetchImpl: cms.fetch,
  });
  assert.equal(first.succeeded, 1);
  assert.equal(first.failed, 1);
  assert.equal(cms.created, 1);
  cms.failCatalog = null;
  const resumed = await draftRoundtrip({
    repoRoot,
    ...files,
    deps,
    fetchImpl: cms.fetch,
  });
  assert.equal(resumed.succeeded, 2);
  assert.equal(resumed.failed, 0);
  assert.equal(cms.created, 2);
  assert.equal(resumed.results[0].revision, 2);
});

test("mocked unit: revised reviewed package reuses mapped Draft and rejects cross-instance binding", async () => {
  const deps = await dependencies(repoRoot);
  const files = await workspace(fixture([object()]));
  const cms = mockedCMS(deps);
  const first = await draftRoundtrip({
    repoRoot,
    ...files,
    deps,
    fetchImpl: cms.fetch,
  });
  const revisedObject = {
    ...object(),
    title: "Synthetic reviewer correction",
    cmsDraft: first.results[0].cmsDraft,
  };
  await atomicPrivateJSON(files.packageFile, fixture([revisedObject]));
  const updated = await draftRoundtrip({
    repoRoot,
    ...files,
    stateDirectory: path.join(files.directory, "updated"),
    deps,
    fetchImpl: cms.fetch,
  });
  assert.equal(updated.succeeded, 1);
  assert.equal(updated.results[0].revision, 3);
  assert.equal(cms.created, 1);
  const otherInstance = {
    ...revisedObject,
    cmsDraft: {
      ...updated.results[0].cmsDraft,
      baseURL: "http://127.0.0.1:43220",
    },
  };
  await atomicPrivateJSON(files.packageFile, fixture([otherInstance]));
  const calls = cms.calls.length;
  await assert.rejects(
    draftRoundtrip({
      repoRoot,
      ...files,
      stateDirectory: path.join(files.directory, "wrong-instance"),
      deps,
      fetchImpl: cms.fetch,
    }),
    /EXISTING_DRAFT_INSTANCE_MISMATCH/u,
  );
  assert.equal(cms.calls.length, calls);
  assert.equal(cms.created, 1);
});

test("offline media unit with real Sharp: derivative SHA mismatch is refused before any API call", async () => {
  const deps = await dependencies(repoRoot);
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "artvenn-derivative-unit-"),
  );
  const bytes = await deps
    .sharp({
      create: { width: 8, height: 8, channels: 3, background: "#777777" },
    })
    .png()
    .toBuffer();
  const derivativePath = path.join(directory, "synthetic.png");
  await writeFile(derivativePath, bytes, { mode: 0o600 });
  const media = {
    assetId: "asset-a",
    mediaId: `synthetic-media-${randomUUID()}`,
    derivativePath,
    sourceSha256: fingerprint(bytes),
    uploadedSha256: "0".repeat(64),
    alt: "Explicit synthetic unit image",
    position: 0,
    isRepresentative: true,
  };
  await assert.rejects(
    validatePublicationPackage(fixture([{ ...object(), media: [media] }]), {
      deps,
      packageDirectory: directory,
    }),
    /DERIVATIVE_DIGEST_MISMATCH/u,
  );
});

for (const [label, patch] of [
  ["origin", { baseURL: "http://127.0.0.1:43220" }],
  ["databaseName", { databaseName: "synthetic-other" }],
]) {
  test(`mocked safety unit: existing state refuses changed ${label} before HTTP`, async () => {
    const deps = await dependencies(repoRoot);
    const input = fixture([object()]);
    const files = await workspace(input);
    const targetIdentity = deps.stableDigest({
      origin: fakeConfig.baseURL,
      databaseName: fakeConfig.databaseName ?? null,
    });
    await atomicPrivateJSON(
      path.join(files.stateDirectory, "adapter-state.json"),
      {
        version: 1,
        instance: "development",
        targetIdentity,
        packageHash: deps.stableDigest(input),
        objects: {},
      },
    );
    await atomicPrivateJSON(files.configFile, { ...fakeConfig, ...patch });
    let calls = 0;
    await assert.rejects(
      draftRoundtrip({
        repoRoot,
        ...files,
        deps,
        fetchImpl: async () => {
          calls++;
        },
      }),
      /TARGET_INSTANCE_CHANGED/u,
    );
    assert.equal(calls, 0);
  });
}

test("mocked native transport: absent groups equal UNSUPPLIED while UNKNOWN stays different", async () => {
  const deps = await dependencies(repoRoot);
  const files = await workspace(fixture([object()]));
  const cms = mockedCMS(deps);
  cms.nativeDefaults = true;
  const first = await draftRoundtrip({
    repoRoot,
    ...files,
    deps,
    fetchImpl: cms.fetch,
  });
  assert.equal(first.succeeded, 1);
  cms.inventUnknown = true;
  const second = await draftRoundtrip({
    repoRoot,
    ...files,
    deps,
    fetchImpl: cms.fetch,
  });
  assert.equal(second.failed, 1);
  assert.equal(second.results[0].category, "DRAFT_CONTENT_READBACK_MISMATCH");
});

test("mapped native patch keeps omitted factual values and relation arrays; explicit CLEAR remains explicit", async () => {
  const deps = await dependencies(repoRoot);
  const files = await workspace(
    fixture([
      {
        ...object(),
        fields: {
          dateText: { state: "VALUE", value: "Synthetic date" },
          contributors: [{ name: "Synthetic author", role: "calligrapher" }],
        },
      },
    ]),
  );
  const cms = mockedCMS(deps);
  cms.nativePatch = true;
  cms.nativeDefaults = true;
  const first = await draftRoundtrip({
    repoRoot,
    ...files,
    deps,
    fetchImpl: cms.fetch,
  });
  assert.equal(first.succeeded, 1);
  const revised = {
    ...object(),
    title: "Synthetic title update",
    fields: {},
    cmsDraft: first.results[0].cmsDraft,
  };
  await atomicPrivateJSON(files.packageFile, fixture([revised]));
  const second = await draftRoundtrip({
    repoRoot,
    ...files,
    stateDirectory: path.join(files.directory, "mapped-preserve"),
    deps,
    fetchImpl: cms.fetch,
  });
  assert.equal(second.succeeded, 1);
  const actual = cms.documents.get(second.results[0].id).content;
  assert.equal(actual.dateText.state, "VALUE");
  assert.equal(actual.dateText.value, "Synthetic date");
  assert.deepEqual(actual.contributors, [
    { name: "Synthetic author", role: "calligrapher" },
  ]);
  const clear = {
    ...revised,
    fields: { dateText: { state: "CLEAR" } },
    cmsDraft: second.results[0].cmsDraft,
  };
  await atomicPrivateJSON(files.packageFile, fixture([clear]));
  const third = await draftRoundtrip({
    repoRoot,
    ...files,
    stateDirectory: path.join(files.directory, "mapped-clear"),
    deps,
    fetchImpl: cms.fetch,
  });
  assert.equal(third.succeeded, 1);
  assert.equal(
    cms.documents.get(third.results[0].id).content.dateText.state,
    "CLEAR",
  );
});

const grantFor = (input, deps) => ({
  version: 1,
  purpose: "admin-draft-only",
  ownerAuthorized: true,
  instance: "development",
  baseURL: fakeConfig.baseURL,
  packageHash: deps.stableDigest(input),
  objects: input.objects.map((item) => ({
    objectId: item.objectId,
    catalogId: item.catalogId,
    media: item.media.map((photo) => ({
      assetId: photo.assetId,
      sourceSha256: photo.sourceSha256,
      uploadedSha256: photo.uploadedSha256,
    })),
  })),
  expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
});

async function selectedMaterial(deps) {
  const input = { ...fixture([object()]), synthetic: false };
  const files = await workspace(input);
  const bytes = await deps
    .sharp({
      create: { width: 12, height: 8, channels: 3, background: "#777777" },
    })
    .png()
    .toBuffer();
  const derivativePath = path.join(files.directory, "selected-unit.png");
  await writeFile(derivativePath, bytes, { mode: 0o600 });
  input.objects[0].media = [
    {
      assetId: "selected-unit-asset",
      mediaId: "synthetic-selected-unit-media",
      derivativePath,
      sourceSha256: createHash("sha256").update(bytes).digest("hex"),
      uploadedSha256: createHash("sha256").update(bytes).digest("hex"),
      alt: "Generated unit-test image, no real material",
      position: 0,
      isRepresentative: true,
    },
  ];
  await atomicPrivateJSON(files.packageFile, input);
  return { input, files };
}

test("mocked real-material gate: exact Owner grant permits Draft, image upload and readback only", async () => {
  const deps = await dependencies(repoRoot);
  const { input, files } = await selectedMaterial(deps);
  const authorizationFile = path.join(files.directory, "owner-grant.json");
  await atomicPrivateJSON(authorizationFile, grantFor(input, deps));
  const cms = mockedCMS(deps);
  const result = await draftRoundtrip({
    repoRoot,
    ...files,
    authorizationFile,
    deps,
    fetchImpl: cms.fetch,
  });
  assert.equal(result.succeeded, 1);
  assert.equal(result.failed, 0);
  assert.equal(
    result.results[0].adminURL,
    fakeConfig.baseURL + "/admin/collections/catalogs/1",
  );
  assert.equal(result.results[0].exactContentReadback, true);
  assert.equal(result.results[0].mediaBytesReadback, true);
  assert.equal(cms.media.size, 1);
  assert.equal(cms.documents.get(1).content.media.length, 1);
  assert.ok(
    cms.calls.every(
      (route) => !route.includes("publish") && !route.includes("approve"),
    ),
  );
});

test("mocked real-material gate: mismatched, expired and unbounded grants fail before transport", async () => {
  const deps = await dependencies(repoRoot);
  const { input, files } = await selectedMaterial(deps);
  const authorizationFile = path.join(files.directory, "owner-grant.json");
  const valid = grantFor(input, deps);
  const changes = [
    { baseURL: "http://127.0.0.1:43220" },
    { packageHash: "0".repeat(64) },
    { purpose: "publish-approved" },
    { ownerAuthorized: false },
    { instance: "production" },
    { expiresAt: new Date(Date.now() - 1000).toISOString() },
    { expiresAt: new Date(Date.now() + 25 * 60 * 60 * 1000).toISOString() },
    { expiresAt: "not-a-date" },
    { objects: [] },
    { objects: [{ ...valid.objects[0], objectId: "unselected-object" }] },
    { objects: [{ ...valid.objects[0], catalogId: "unselected-catalog" }] },
    { objects: [{ ...valid.objects[0], media: [] }] },
    ...["assetId", "sourceSha256", "uploadedSha256"].map((key) => ({
      objects: [
        {
          ...valid.objects[0],
          media: [
            {
              ...valid.objects[0].media[0],
              [key]: key === "assetId" ? "unselected-asset" : "0".repeat(64),
            },
          ],
        },
      ],
    })),
  ];
  for (const change of changes) {
    await atomicPrivateJSON(authorizationFile, { ...valid, ...change });
    let calls = 0;
    await assert.rejects(
      draftRoundtrip({
        repoRoot,
        ...files,
        authorizationFile,
        deps,
        fetchImpl: async () => {
          calls++;
        },
      }),
      /REAL_MATERIAL_AUTHORIZATION_INVALID/u,
    );
    assert.equal(calls, 0);
  }
  await atomicPrivateJSON(authorizationFile, valid);
  await chmod(authorizationFile, 0o400);
  let calls = 0;
  await assert.rejects(
    draftRoundtrip({
      repoRoot,
      ...files,
      authorizationFile,
      deps,
      fetchImpl: async () => {
        calls++;
      },
    }),
    /REAL_MATERIAL_AUTHORIZATION_INVALID/u,
  );
  assert.equal(calls, 0);
});

test("mocked real-material gate: an exact grant cannot exceed three cards or twelve photos", async () => {
  const deps = await dependencies(repoRoot);
  const { input, files } = await selectedMaterial(deps);
  const tooManyCards = {
    ...input,
    objects: ["a", "b", "c", "d"].map((suffix) => object(suffix)),
  };
  const photo = input.objects[0].media[0];
  const tooManyPhotos = {
    ...input,
    objects: [
      {
        ...object(),
        media: Array.from({ length: 13 }, (_, position) => ({
          ...photo,
          assetId: "selected-unit-" + position,
          mediaId: "synthetic-selected-media-" + position,
          position,
          isRepresentative: position === 0,
        })),
      },
    ],
  };
  for (const selected of [tooManyCards, tooManyPhotos]) {
    await atomicPrivateJSON(files.packageFile, selected);
    const authorizationFile = path.join(files.directory, "owner-grant.json");
    await atomicPrivateJSON(authorizationFile, grantFor(selected, deps));
    let calls = 0;
    await assert.rejects(
      draftRoundtrip({
        repoRoot,
        ...files,
        authorizationFile,
        deps,
        fetchImpl: async () => {
          calls++;
        },
      }),
      /REAL_MATERIAL_AUTHORIZATION_INVALID/u,
    );
    assert.equal(calls, 0);
  }
});

test("mocked safety unit: cached mapped Draft cannot bypass target check with zero photos", async () => {
  const deps = await dependencies(repoRoot);
  const input = fixture([
    {
      ...object(),
      cmsDraft: {
        id: 1,
        expectedRevision: 2,
        instance: "development",
        baseURL: "http://127.0.0.1:43220",
      },
    },
  ]);
  const files = await workspace(input);
  await atomicPrivateJSON(
    path.join(files.stateDirectory, "adapter-state.json"),
    {
      version: 1,
      instance: "development",
      targetIdentity: deps.stableDigest({
        origin: fakeConfig.baseURL,
        databaseName: null,
      }),
      packageHash: deps.stableDigest(input),
      objects: { "object-a": { id: 1, revision: 2, phase: "verified" } },
    },
  );
  let calls = 0;
  await assert.rejects(
    draftRoundtrip({
      repoRoot,
      ...files,
      deps,
      fetchImpl: async () => {
        calls++;
      },
    }),
    /EXISTING_DRAFT_INSTANCE_MISMATCH/u,
  );
  assert.equal(calls, 0);
});
