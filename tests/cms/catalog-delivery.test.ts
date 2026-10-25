import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import {
  handleOperatorRequest,
  type OperatorRouteDependencies,
} from "@moya/backend-runtime/internal/community-operator";
import { currentCatalogRecipePolicy } from "@moya/backend-production/internal/catalog-delivery";

import {
  cancelCatalogDeliverySchema,
  catalogDeliveryManifestSchema,
  catalogDeliveryMediaSchema,
  EDITORIAL_STATEFUL_FIELDS,
  editorialDraftSchema,
  prepareCatalogDeliverySchema,
  readCatalogDeliverySchema,
  releaseCatalogDeliverySchema,
  requestCatalogReleaseSchema,
} from "@moya/contracts/internal/editorial";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createLocalReq,
  getPayload,
  handleEndpoints,
  type PayloadRequest,
  type TypedUser,
} from "payload";
import sharp from "sharp";

import { selectedMediaSnapshot } from "admin/media-snapshot";
import {
  approveBatch,
  publishApproved,
  saveDraft,
  editorialEndpoints,
  assertCatalogDeliveryPublication,
  cancelCatalogDelivery,
  prepareCatalogDelivery,
  readCatalogDelivery,
} from "admin/editorial";

const run = randomUUID();
const fingerprint = "0".repeat(64);
const privateKey = `editorial/${fingerprint}/${fingerprint}.png`;
const syntheticMedia = (id: string, position = 0) =>
  catalogDeliveryMediaSchema.parse({
    mediaId: id,
    objectKey: `${privateKey}-${position}`,
    width: 3,
    height: 2,
    alt: "Synthetic media",
    position,
    isRepresentative: position === 0,
    sourceSha256: fingerprint,
  });

describe("Catalog delivery internal boundary", () => {
  it("registers five actual authenticated Payload operations", () => {
    const paths = editorialEndpoints.map(
      ({ path, method }) => `${method}:${path}`,
    );
    for (const name of [
      "prepare-catalog-delivery",
      "read-catalog-delivery",
      "request-catalog-release",
      "release-catalog-delivery",
      "cancel-catalog-delivery",
    ])
      expect(paths).toContain(`post:/editorial/${name}`);
  });

  it("denies anonymous requests at all five handlers before reading JSON or accessing persistence", async () => {
    const guarded = editorialEndpoints.filter(({ path }) =>
      [
        "prepare-catalog-delivery",
        "read-catalog-delivery",
        "request-catalog-release",
        "release-catalog-delivery",
        "cancel-catalog-delivery",
      ].some((name) => path === `/editorial/${name}`),
    );
    const request = new Proxy(
      { user: null },
      {
        get(target, property) {
          if (property === "user") return target.user;
          throw new Error("Anonymous request crossed authentication boundary");
        },
      },
    ) as unknown as PayloadRequest;
    for (const route of guarded) {
      const response = await route.handler(request);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        ok: false,
        error: { code: "AUTHORIZATION_REQUIRED" },
      });
    }
  });

  it("rejects caller-supplied readiness, source keys, actors, and unbounded request keys", () => {
    const prepare = {
      id: 1,
      expectedRevision: 1,
      expectedFingerprint: fingerprint,
      idempotencyKey: "synthetic-prepare",
    };
    expect(prepareCatalogDeliverySchema.safeParse(prepare).success).toBe(true);
    for (const extra of [
      { ready: true },
      { actorId: 1 },
      { objectKey: privateKey },
      { recipeManifestSha256: fingerprint },
    ])
      expect(
        prepareCatalogDeliverySchema.safeParse({ ...prepare, ...extra })
          .success,
      ).toBe(false);
    expect(
      prepareCatalogDeliverySchema.safeParse({
        ...prepare,
        idempotencyKey: "a".repeat(129),
      }).success,
    ).toBe(false);
    const intentId = randomUUID();
    for (const [schema, input] of [
      [readCatalogDeliverySchema, { intentId }],
      [
        requestCatalogReleaseSchema,
        {
          intentId,
          expectedStateVersion: 1,
          expectedManifestSha256: fingerprint,
          idempotencyKey: "request",
        },
      ],
      [
        releaseCatalogDeliverySchema,
        {
          intentId,
          expectedStateVersion: 1,
          expectedRevision: 1,
          expectedFingerprint: fingerprint,
          idempotencyKey: "release",
        },
      ],
      [
        cancelCatalogDeliverySchema,
        { intentId, expectedStateVersion: 1, idempotencyKey: "cancel" },
      ],
    ] as const) {
      expect(schema.safeParse(input).success).toBe(true);
      expect(schema.safeParse({ ...input, ready: true }).success).toBe(false);
    }
  });

  it("retains separate logical media with identical bytes and rejects repeated identities", () => {
    const first = syntheticMedia("synthetic-first");
    const second = syntheticMedia("synthetic-second", 1);
    expect(catalogDeliveryManifestSchema.parse([first, second])).toHaveLength(
      2,
    );
    expect(
      catalogDeliveryManifestSchema.safeParse([
        first,
        { ...second, mediaId: first.mediaId },
      ]).success,
    ).toBe(false);
    expect(
      createHash("sha256")
        .update(JSON.stringify([first, second]))
        .digest("hex"),
    ).not.toBe(
      createHash("sha256")
        .update(JSON.stringify([second, first]))
        .digest("hex"),
    );
  });

  it("requires delivery for editorial originals while retaining qualified legacy and text-only publication", async () => {
    const content = editorialDraftSchema.parse({
      catalogId: "synthetic-guard",
      sourceId: "synthetic-guard-source",
      kind: "calligraphy",
      media: [],
    });
    await expect(
      assertCatalogDeliveryPublication(content),
    ).resolves.toBeUndefined();
    await expect(
      assertCatalogDeliveryPublication({
        ...content,
        media: [
          {
            ...syntheticMedia("synthetic-legacy"),
            objectKey: "display/v1/synthetic.webp",
          },
        ],
      }),
    ).resolves.toBeUndefined();
    await expect(
      assertCatalogDeliveryPublication({
        ...content,
        media: [syntheticMedia("synthetic-private")],
      }),
    ).rejects.toThrow("CATALOG_DELIVERY_PREPARATION_REQUIRED");
  });

  it("publishes editorial originals unprepared only while CMS_CATALOG_DIRECT_PUBLISH is on", async () => {
    const content = {
      ...editorialDraftSchema.parse({
        catalogId: "synthetic-direct",
        sourceId: "synthetic-direct-source",
        kind: "calligraphy",
        media: [],
      }),
      media: [syntheticMedia("synthetic-direct-private")],
    };
    try {
      vi.stubEnv("CMS_CATALOG_DIRECT_PUBLISH", "on");
      await expect(
        assertCatalogDeliveryPublication(content),
      ).resolves.toBeUndefined();
      for (const value of ["", "off"]) {
        vi.stubEnv("CMS_CATALOG_DIRECT_PUBLISH", value);
        await expect(assertCatalogDeliveryPublication(content)).rejects.toThrow(
          "CATALOG_DELIVERY_PREPARATION_REQUIRED",
        );
      }
      vi.stubEnv("CMS_CATALOG_DIRECT_PUBLISH", "ON");
      await expect(assertCatalogDeliveryPublication(content)).rejects.toThrow(
        "CMS_CATALOG_DIRECT_PUBLISH_INVALID",
      );
    } finally {
      vi.stubEnv("CMS_CATALOG_DIRECT_PUBLISH", "");
    }
  });
});

// The pure boundary cases above run without a DB. These cases only run with the
// existing verification harness's explicitly synthetic, task-owned CMS target.
describe
  .skipIf(!process.env.CMS_DATABASE_URL)
  .sequential("durable Payload draft delivery intents", () => {
    let payload: Awaited<ReturnType<typeof getPayload>>;
    let config: Awaited<typeof import("admin/config")>["default"];
    let owner: TypedUser;
    let automation: TypedUser;
    let outside: TypedUser;
    let ownerSession: string;
    let automationSession: string;
    const ids = [
      "http",
      "prune",
      "race",
      "expiry",
      "bypass",
      "pinned",
      "live",
      "pacing",
      "direct",
      "direct-native",
    ].map((name) => `synthetic-delivery-${name}-${run}`);
    /** A loopback operator boundary with the real handler and stub facts. */
    const syntheticOperatorBoundary = async (
      dependencies: Partial<OperatorRouteDependencies>,
    ) => {
      const credential = randomUUID();
      const server = createServer((request, response) => {
        void handleOperatorRequest(
          request,
          response,
          new URL(request.url!, "http://127.0.0.1").pathname,
          {
            moderationService: {},
            operatorCredential: credential,
            ...dependencies,
          } as OperatorRouteDependencies,
        );
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("Synthetic operator address missing");
      vi.stubEnv(
        "COMMUNITY_OPERATOR_BASE_URL",
        `http://127.0.0.1:${address.port}`,
      );
      vi.stubEnv("COMMUNITY_OPERATOR_TOKEN", credential);
      return async () => {
        vi.stubEnv("COMMUNITY_OPERATOR_BASE_URL", "");
        vi.stubEnv("COMMUNITY_OPERATOR_TOKEN", "");
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      };
    };
    const reqFor = (user: TypedUser | null = owner) =>
      createLocalReq(user ? { user } : {}, payload);
    const post = (name: string, input: unknown, session = ownerSession) =>
      handleEndpoints({
        config,
        request: new Request(`http://127.0.0.1:3002/api/editorial/${name}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(session ? { authorization: `JWT ${session}` } : {}),
          },
          body: JSON.stringify(input),
        }),
      });
    const complete = (catalogId: string) =>
      editorialDraftSchema.parse({
        catalogId,
        sourceId: `${catalogId}-source`,
        kind: "calligraphy",
        title: "Synthetic published A",
        summary: "Synthetic summary",
        ...Object.fromEntries(
          EDITORIAL_STATEFUL_FIELDS.map((name) => [
            name,
            { state: "UNSUPPLIED" },
          ]),
        ),
        media: [],
      });
    const draftB = async (catalogId: string, mediaCount = 1) => {
      const content = complete(catalogId);
      const saved = await saveDraft(await reqFor(), {
        idempotencyKey: `${catalogId}:A`,
        content,
      });
      const primary = await payload.update({
        collection: "catalogs",
        id: saved.id,
        req: await reqFor(),
        overrideAccess: false,
        data: { revision: saved.revision, _status: "published" },
      });
      const bytes = await sharp({
        create: { width: 3, height: 2, channels: 3, background: "white" },
      })
        .png()
        .toBuffer();
      const snapshots: NonNullable<ReturnType<typeof selectedMediaSnapshot>>[] =
        [];
      let firstMedia;
      for (let ordinal = 0; ordinal < mediaCount; ordinal++) {
        const media = await payload.create({
          collection: "media",
          req: await reqFor(),
          overrideAccess: false,
          data: {
            mediaId: `synthetic-media-${catalogId}-${ordinal}`,
            catalogId,
            origin: "upload",
            objectKey: "",
            sha256: "",
            alt: "Synthetic B",
            rights: "Synthetic fixture",
            orderConfidence: "HIGH",
          },
          file: {
            name: "synthetic.png",
            data: bytes,
            mimetype: "image/png",
            size: bytes.length,
          },
        });
        firstMedia ??= media;
        snapshots.push(
          selectedMediaSnapshot({ ...media }, catalogId, snapshots)!,
        );
      }
      const contentB = {
        ...content,
        title: "Synthetic private B",
        media: snapshots,
      };
      const draft = await saveDraft(await reqFor(automation), {
        id: saved.id,
        expectedRevision: Number(primary.revision),
        idempotencyKey: `${catalogId}:B`,
        content: contentB,
      });
      return {
        draft,
        contentB,
        media: firstMedia!,
        command: {
          id: draft.id,
          expectedRevision: draft.revision,
          expectedFingerprint: draft.fingerprint,
          idempotencyKey: `${catalogId}:prepare`,
        },
      };
    };

    beforeAll(async () => {
      if (
        process.env.CMS_ENVIRONMENT !== "synthetic" ||
        process.env.CMS_STORAGE_MODE !== "local"
      )
        throw new Error("Task-owned synthetic local CMS required");
      // These fixtures deliberately exercise the disconnected policy state;
      // inherited operator configuration must never contact another service.
      vi.stubEnv("COMMUNITY_OPERATOR_BASE_URL", "");
      vi.stubEnv("COMMUNITY_OPERATOR_TOKEN", "");
      config = (await import("admin/config")).default;
      payload = await getPayload({ config });
      const syntheticPassword = randomUUID();
      owner = await payload.create({
        collection: "users",
        overrideAccess: true,
        data: {
          email: `delivery-owner-${run}@example.invalid`,
          password: syntheticPassword,
          role: "owner",
        },
      });
      automation = await payload.create({
        collection: "users",
        req: await reqFor(),
        overrideAccess: false,
        data: {
          email: `delivery-automation-${run}@example.invalid`,
          password: syntheticPassword,
          role: "automation",
          scopeCatalogIds: ids,
        },
      });
      outside = await payload.create({
        collection: "users",
        req: await reqFor(),
        overrideAccess: false,
        data: {
          email: `delivery-outside-${run}@example.invalid`,
          password: syntheticPassword,
          role: "automation",
          scopeCatalogIds: [`synthetic-outside-${run}`],
        },
      });
      ownerSession = (
        await payload.login({
          collection: "users",
          data: { email: owner.email, password: syntheticPassword },
        })
      ).token!;
      automationSession = (
        await payload.login({
          collection: "users",
          data: { email: automation.email, password: syntheticPassword },
        })
      ).token!;
    }, 30_000);
    afterAll(async () => {
      await payload?.destroy();
      vi.unstubAllEnvs();
    });

    it("uses actual authenticated endpoints; private prepare never grants copies or fake readiness", async () => {
      const { command, draft } = await draftB(ids[0]!);
      const prepared = await post("prepare-catalog-delivery", command);
      expect(prepared.status).toBe(200);
      const { result } = await prepared.json();
      expect(result).toMatchObject({
        id: draft.id,
        revision: draft.revision,
        state: "prepared",
        stateVersion: 1,
        recipeManifestSha256: null,
        readiness: "NOT_CONFIGURED",
        publicCopyAuthorized: false,
        mediaCount: 1,
      });
      expect(JSON.stringify(result)).not.toContain("editorial/");
      expect(JSON.stringify(result)).not.toContain("Synthetic private B");
      expect((await post("prepare-catalog-delivery", command, "")).status).toBe(
        403,
      );
      expect(
        (await prepareCatalogDelivery(await reqFor(), command)).replayed,
      ).toBe(true);
      await expect(
        readCatalogDelivery(await reqFor(outside), {
          intentId: result.intentId,
        }),
      ).rejects.toMatchObject({ code: "RECORD_UNAVAILABLE" });
      const releaseRequest = {
        intentId: result.intentId,
        expectedStateVersion: 1,
        expectedManifestSha256: result.manifestSha256,
        idempotencyKey: `${run}:request`,
      };
      expect(
        (
          await post(
            "request-catalog-release",
            releaseRequest,
            automationSession,
          )
        ).status,
      ).toBe(403);
      const blocked = await post("request-catalog-release", releaseRequest);
      expect(blocked.status).toBe(503);
      expect((await blocked.json()).error.code).toBe(
        "CATALOG_DELIVERY_NOT_CONFIGURED",
      );
      const release = await post("release-catalog-delivery", {
        intentId: result.intentId,
        expectedStateVersion: 1,
        expectedRevision: draft.revision,
        expectedFingerprint: draft.fingerprint,
        idempotencyKey: `${run}:release`,
      });
      expect(release.status).toBe(503);
      expect(
        (
          await readCatalogDelivery(await reqFor(), {
            intentId: result.intentId,
          })
        ).stateVersion,
      ).toBe(1);
      const primary = await payload.findByID({
        collection: "catalogs",
        id: draft.id,
        draft: false,
        req: await reqFor(),
        overrideAccess: false,
      });
      expect(primary.title).toBe("Synthetic published A");
      expect(primary.media).toEqual([]);
      expect(
        (
          await payload.db.pool.query(
            "SELECT count(*)::int AS count FROM public.catalog_media WHERE catalog_id = $1",
            [ids[0]],
          )
        ).rows[0].count,
      ).toBe(0);
      const cancelled = await post("cancel-catalog-delivery", {
        intentId: result.intentId,
        expectedStateVersion: 1,
        idempotencyKey: `${run}:cancel`,
      });
      expect(cancelled.status).toBe(200);
      expect((await cancelled.json()).result).toMatchObject({
        state: "cancelled",
        stateVersion: 2,
      });
      expect(
        await prepareCatalogDelivery(await reqFor(), command),
      ).toMatchObject({ state: "cancelled", replayed: true });
      await expect(
        prepareCatalogDelivery(await reqFor(), {
          ...command,
          expectedFingerprint: "1".repeat(64),
        }),
      ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    });

    it("pins real policy and two distinct native media identities; replay never calls an unavailable operator", async () => {
      const syntheticOperator = randomUUID();
      let available = true;
      let calls = 0;
      const server = createServer((request, response) => {
        calls++;
        void handleOperatorRequest(
          request,
          response,
          new URL(request.url!, "http://127.0.0.1").pathname,
          {
            moderationService: {},
            operatorCredential: syntheticOperator,
            ...(available
              ? {
                  catalogRecipePolicy: async () => currentCatalogRecipePolicy(),
                }
              : {}),
          } as OperatorRouteDependencies,
        );
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("Synthetic operator address missing");
      vi.stubEnv(
        "COMMUNITY_OPERATOR_BASE_URL",
        `http://127.0.0.1:${address.port}`,
      );
      vi.stubEnv("COMMUNITY_OPERATOR_TOKEN", syntheticOperator);
      try {
        const { command, draft } = await draftB(ids[5]!, 2);
        const response = await post("prepare-catalog-delivery", command);
        expect(response.status).toBe(200);
        const { result } = await response.json();
        expect(result).toMatchObject({
          state: "prepared",
          mediaCount: 2,
          readiness: "PENDING",
          publicCopyAuthorized: false,
          recipeManifestSha256:
            currentCatalogRecipePolicy().recipeManifestSha256,
        });
        const stored = (
          await payload.db.pool.query(
            "SELECT recipe_manifest,media_manifest FROM catalog_delivery_intents WHERE id=$1",
            [result.intentId],
          )
        ).rows[0];
        expect(stored.recipe_manifest).toEqual(
          JSON.parse(currentCatalogRecipePolicy().canonicalManifest),
        );
        const media = stored.media_manifest as {
          mediaId: string;
          objectKey: string;
          sourceSha256: string;
        }[];
        expect(new Set(media.map((m) => m.mediaId)).size).toBe(2);
        expect(new Set(media.map((m) => m.objectKey)).size).toBe(2);
        expect(new Set(media.map((m) => m.sourceSha256)).size).toBe(1);
        const rows = (
          await payload.db.pool.query(
            "SELECT * FROM catalog_delivery_prepare_media WHERE intent_id=$1 ORDER BY media_ordinal",
            [result.intentId],
          )
        ).rows;
        expect(rows).toHaveLength(2);
        expect(rows.map((r) => r.media_id)).toEqual(
          media.map((m) => m.mediaId),
        );
        const beforeReplay = calls;
        available = false;
        expect(
          await prepareCatalogDelivery(await reqFor(), command),
        ).toMatchObject({ intentId: result.intentId, replayed: true });
        expect(calls).toBe(beforeReplay);
        await expect(
          prepareCatalogDelivery(await reqFor(), {
            ...command,
            idempotencyKey: `${run}:policy-off`,
          }),
        ).rejects.toMatchObject({ code: "CATALOG_RECIPE_POLICY_UNAVAILABLE" });
        expect(
          (
            await payload.db.pool.query(
              "SELECT count(*)::int n FROM catalog_delivery_intents WHERE catalog_document_id=$1",
              [draft.id],
            )
          ).rows[0].n,
        ).toBe(1);
        await cancelCatalogDelivery(await reqFor(), {
          intentId: result.intentId,
          expectedStateVersion: 1,
          idempotencyKey: `${run}:pinned-cancel`,
        });
        const terminal = (
          await payload.db.pool.query(
            "SELECT * FROM catalog_delivery_prepare_media WHERE intent_id=$1",
            [result.intentId],
          )
        ).rows;
        expect(terminal).toHaveLength(1);
        expect(terminal[0]).toMatchObject({
          state: "cancelled",
          media_count: 2,
          media_ordinal: null,
          media_id: null,
          object_key: null,
          source_sha256: null,
          width: null,
          height: null,
        });
        expect(
          (
            await payload.findByID({
              collection: "catalogs",
              id: draft.id,
              draft: false,
              req: await reqFor(),
              overrideAccess: false,
            })
          ).title,
        ).toBe("Synthetic published A");
      } finally {
        vi.stubEnv("COMMUNITY_OPERATOR_BASE_URL", "");
        vi.stubEnv("COMMUNITY_OPERATOR_TOKEN", "");
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    });

    it("preserves immutable B after more than 100 versions and never revives it through receipt replay", async () => {
      const { command, draft, contentB } = await draftB(ids[1]!);
      const intent = await prepareCatalogDelivery(await reqFor(), command);
      let revision = draft.revision;
      for (let index = 0; index < 101; index++) {
        const changed = await saveDraft(await reqFor(automation), {
          id: draft.id,
          expectedRevision: revision,
          idempotencyKey: `${run}:prune:${index}`,
          content: { ...contentB, title: `Synthetic later ${index}` },
        });
        revision = changed.revision;
      }
      const stored = (
        await payload.db.pool.query(
          "SELECT draft_snapshot, media_manifest_sha256, state, state_version FROM catalog_delivery_intents WHERE id = $1",
          [intent.intentId],
        )
      ).rows[0];
      expect(stored.draft_snapshot.title).toBe("Synthetic private B");
      expect(stored.media_manifest_sha256).toBe(intent.manifestSha256);
      expect(stored.state).toBe("superseded");
      expect(stored.state_version).toBe(2);
      expect(
        (
          await payload.db.pool.query(
            "SELECT count(*)::int AS count FROM _catalogs_v WHERE parent_id = $1",
            [draft.id],
          )
        ).rows[0].count,
      ).toBeLessThanOrEqual(100);
      expect(
        await prepareCatalogDelivery(await reqFor(), command),
      ).toMatchObject({
        intentId: intent.intentId,
        state: "superseded",
        replayed: true,
      });
    }, 30_000);

    it("serializes cancellation against edits and rejects stale state versions", async () => {
      const { command, draft, contentB } = await draftB(ids[2]!);
      const [first, replay] = await Promise.all([
        prepareCatalogDelivery(await reqFor(), command),
        prepareCatalogDelivery(await reqFor(), command),
      ]);
      expect(first.intentId).toBe(replay.intentId);
      expect([first.replayed, replay.replayed].sort()).toEqual([false, true]);
      await expect(
        cancelCatalogDelivery(await reqFor(), {
          intentId: first.intentId,
          expectedStateVersion: 2,
          idempotencyKey: `${run}:wrong-version`,
        }),
      ).rejects.toMatchObject({ code: "CATALOG_DELIVERY_STATE_CONFLICT" });
      const outcomes = await Promise.allSettled([
        cancelCatalogDelivery(await reqFor(), {
          intentId: first.intentId,
          expectedStateVersion: 1,
          idempotencyKey: `${run}:race-cancel`,
        }),
        saveDraft(await reqFor(automation), {
          id: draft.id,
          expectedRevision: draft.revision,
          idempotencyKey: `${run}:race-edit`,
          content: { ...contentB, title: "Synthetic changed" },
        }),
      ]);
      expect(outcomes[1]!.status).toBe("fulfilled");
      const current = await readCatalogDelivery(await reqFor(), {
        intentId: first.intentId,
      });
      expect(["cancelled", "superseded"]).toContain(current.state);
      expect(current.stateVersion).toBe(2);
      expect(current.publicCopyAuthorized).toBe(false);
    });

    it("expires an intent durably and withdraws active intent pins in the Native transaction", async () => {
      const { command, draft } = await draftB(ids[3]!);
      const intent = await prepareCatalogDelivery(await reqFor(), command);
      await payload.db.pool.query(
        "UPDATE catalog_delivery_intents SET expires_at = now() - interval '1 second' WHERE id = $1",
        [intent.intentId],
      );
      // A rejected mutation must commit expiry before any successful read.
      await expect(
        cancelCatalogDelivery(await reqFor(), {
          intentId: intent.intentId,
          expectedStateVersion: 1,
          idempotencyKey: `${run}:expired-cancel`,
        }),
      ).rejects.toMatchObject({ code: "CATALOG_DELIVERY_EXPIRED" });
      expect(
        (
          await payload.db.pool.query(
            "SELECT state, state_version FROM catalog_delivery_intents WHERE id = $1",
            [intent.intentId],
          )
        ).rows[0],
      ).toMatchObject({ state: "expired", state_version: 2 });
      expect(
        (
          await payload.db.pool.query(
            "SELECT count(*)::int AS count FROM catalog_delivery_receipts WHERE intent_id = $1 AND operation = 'cancel'",
            [intent.intentId],
          )
        ).rows[0].count,
      ).toBe(0);
      expect(
        await readCatalogDelivery(await reqFor(), {
          intentId: intent.intentId,
        }),
      ).toMatchObject({ state: "expired", stateVersion: 2 });
      const fresh = await prepareCatalogDelivery(await reqFor(), {
        ...command,
        idempotencyKey: `${run}:new-after-expiry`,
      });
      const transactionID = await payload.db.beginTransaction();
      if (!transactionID) throw new Error("Fixture transaction unavailable");
      const nested = await reqFor();
      nested.transactionID = transactionID;
      try {
        await expect(
          cancelCatalogDelivery(nested, {
            intentId: fresh.intentId,
            expectedStateVersion: 1,
            idempotencyKey: `${run}:nested-cancel`,
          }),
        ).rejects.toMatchObject({
          code: "CATALOG_DELIVERY_TRANSACTION_ACTIVE",
        });
      } finally {
        await payload.db.rollbackTransaction(transactionID);
      }
      await payload.update({
        collection: "catalogs",
        id: draft.id,
        draft: false,
        req: await reqFor(),
        overrideAccess: false,
        data: { revision: draft.revision, _status: "draft" },
      });
      expect(
        await readCatalogDelivery(await reqFor(), { intentId: fresh.intentId }),
      ).toMatchObject({ state: "withdrawn", stateVersion: 2 });
      expect(
        (
          await payload.db.pool.query(
            "SELECT count(*)::int AS count FROM catalog_delivery_prepare_media WHERE intent_id = $1",
            [fresh.intentId],
          )
        ).rows[0].count,
      ).toBe(0);
    });

    it("blocks Native Owner and approved automation publication bypasses while readiness is absent", async () => {
      const { draft } = await draftB(ids[4]!);
      await expect(
        payload.update({
          collection: "catalogs",
          id: draft.id,
          req: await reqFor(),
          overrideAccess: false,
          data: { revision: draft.revision, _status: "published" },
        }),
      ).rejects.toThrow("CATALOG_DELIVERY_PREPARATION_REQUIRED");
      const approval = await approveBatch(await reqFor(), {
        automationUserId: automation.id,
        items: [{ id: draft.id, revision: draft.revision }],
      });
      await expect(
        publishApproved(await reqFor(automation), {
          id: draft.id,
          approvalId: approval.approvalId,
          idempotencyKey: `${run}:bypass`,
        }),
      ).rejects.toThrow("CATALOG_DELIVERY_PREPARATION_REQUIRED");
      const response = await handleEndpoints({
        config,
        request: new Request(`http://127.0.0.1:3002/api/catalogs/${draft.id}`, {
          method: "PATCH",
          headers: {
            "content-type": "application/json",
            authorization: `JWT ${ownerSession}`,
          },
          body: JSON.stringify({
            revision: draft.revision,
            _status: "published",
          }),
        }),
      });
      expect(response.status).toBe(409);
      const primary = await payload.findByID({
        collection: "catalogs",
        id: draft.id,
        draft: false,
        req: await reqFor(),
        overrideAccess: false,
      });
      expect(primary.title).toBe("Synthetic published A");
    });

    it("publishes unprepared editorial originals through approved automation and Native Owner PATCH while CMS_CATALOG_DIRECT_PUBLISH is on", async () => {
      const { draft } = await draftB(ids[8]!);
      const { draft: native } = await draftB(ids[9]!);
      const primaryTitle = async (id: number | string) =>
        (
          await payload.findByID({
            collection: "catalogs",
            id,
            draft: false,
            req: await reqFor(),
            overrideAccess: false,
          })
        ).title;
      // The operator would refuse every image; with the switch on it is
      // never asked, so publication holds no Backend read.
      let asked = 0;
      const close = await syntheticOperatorBoundary({
        catalogPublishedRenditions: async (media) => {
          asked++;
          return {
            media: media.map(({ mediaId, objectKey }) => ({
              mediaId,
              objectKey,
              complete: false,
            })),
          };
        },
      });
      try {
        vi.stubEnv("CMS_CATALOG_DIRECT_PUBLISH", "on");
        const approval = await approveBatch(await reqFor(), {
          automationUserId: automation.id,
          items: [{ id: draft.id, revision: draft.revision }],
        });
        await publishApproved(await reqFor(automation), {
          id: draft.id,
          approvalId: approval.approvalId,
          idempotencyKey: `${run}:direct`,
        });
        expect(await primaryTitle(draft.id)).toBe("Synthetic private B");
        const response = await handleEndpoints({
          config,
          request: new Request(
            `http://127.0.0.1:3002/api/catalogs/${native.id}`,
            {
              method: "PATCH",
              headers: {
                "content-type": "application/json",
                authorization: `JWT ${ownerSession}`,
              },
              body: JSON.stringify({
                revision: native.revision,
                _status: "published",
              }),
            },
          ),
        });
        expect(response.status).toBe(200);
        expect(await primaryTitle(native.id)).toBe("Synthetic private B");
        expect(asked).toBe(0);
      } finally {
        vi.stubEnv("CMS_CATALOG_DIRECT_PUBLISH", "");
        await close();
      }
    });

    it("publishes editorial originals that already have complete published sets, and still refuses one that lacks its set", async () => {
      const complete = new Set<string>();
      const asked: { mediaId: string; objectKey: string }[][] = [];
      const close = await syntheticOperatorBoundary({
        catalogPublishedRenditions: async (media) => {
          asked.push(media);
          return {
            media: media.map(({ mediaId, objectKey }) => ({
              mediaId,
              objectKey,
              complete: complete.has(mediaId),
            })),
          };
        },
      });
      try {
        const { draft, contentB } = await draftB(ids[6]!, 2);
        const publish = async (revision: number) =>
          payload.update({
            collection: "catalogs",
            id: draft.id,
            req: await reqFor(),
            overrideAccess: false,
            data: { revision, _status: "published" },
          });
        complete.add(contentB.media[0]!.mediaId);
        await expect(publish(draft.revision)).rejects.toThrow(
          "CATALOG_DELIVERY_PREPARATION_REQUIRED",
        );
        const registered = await payload.find({
          collection: "media",
          req: await reqFor(),
          overrideAccess: false,
          where: {
            mediaId: { in: contentB.media.map(({ mediaId }) => mediaId) },
          },
        });
        expect(asked.at(-1)).toEqual(
          contentB.media.map(({ mediaId, objectKey }) => ({
            mediaId,
            objectKey,
            sourceSha256: registered.docs.find(
              (doc) => doc.mediaId === mediaId,
            )!.sha256,
          })),
        );
        complete.add(contentB.media[1]!.mediaId);
        const published = await publish(draft.revision);
        expect(published).toMatchObject({
          _status: "published",
          title: "Synthetic private B",
        });
        // A later text-only edit of the live record publishes the same way.
        const edited = await saveDraft(await reqFor(automation), {
          id: draft.id,
          expectedRevision: Number(published.revision),
          idempotencyKey: `${run}:live-text`,
          content: { ...contentB, title: "Synthetic text-only edit" },
        });
        expect((await publish(edited.revision)).title).toBe(
          "Synthetic text-only edit",
        );
        expect(
          (
            await payload.db.pool.query(
              "SELECT count(*)::int AS count FROM catalog_delivery_intents WHERE catalog_document_id = $1",
              [draft.id],
            )
          ).rows[0].count,
        ).toBe(0);
        // An image without its set (a new upload) still needs preparation.
        complete.delete(contentB.media[1]!.mediaId);
        const again = await saveDraft(await reqFor(automation), {
          id: draft.id,
          expectedRevision: edited.revision + 1,
          idempotencyKey: `${run}:live-text-2`,
          content: { ...contentB, title: "Synthetic second edit" },
        });
        await expect(publish(again.revision)).rejects.toThrow(
          "CATALOG_DELIVERY_PREPARATION_REQUIRED",
        );
      } finally {
        await close();
      }
    });

    it("reports delivery capability to release tooling without reading or writing records", async () => {
      const capability = async (session = ownerSession) => {
        const response = await post(
          "catalog-delivery-capabilities",
          {},
          session,
        );
        return { status: response.status, body: await response.json() };
      };
      expect((await capability("")).status).toBe(403);
      expect(await capability()).toMatchObject({
        status: 200,
        body: { ok: true, result: { delivery: "NOT_CONFIGURED" } },
      });
      for (const [dependencies, delivery] of [
        [{}, "UNAVAILABLE"],
        [
          { catalogRecipePolicy: async () => currentCatalogRecipePolicy() },
          "NOT_CONFIGURED",
        ],
        [
          {
            catalogRecipePolicy: async () => currentCatalogRecipePolicy(),
            catalogDeliveryReadiness: async () => null,
          },
          "AVAILABLE",
        ],
      ] as const) {
        const close = await syntheticOperatorBoundary(dependencies);
        try {
          expect((await capability(automationSession)).body).toEqual({
            ok: true,
            result: { delivery },
          });
        } finally {
          await close();
        }
      }
    });

    it("adds the images of intents prepared since the count or up to 10 minutes before it, live or released, never ended ones (I9)", async () => {
      // Files run one at a time, so no other intent is created meanwhile.
      const { command } = await draftB(ids[7]!, 2);
      const prepared = await post("prepare-catalog-delivery", command);
      expect(prepared.status).toBe(200);
      const { result: intent } = await prepared.json();
      // Its prepare's start, moved far from every other intent (a run's own
      // hour in 2098), so the 10-minute window around a count holds it alone;
      // put back afterwards, so no later run can meet it there.
      const { created_at: originalCreatedAt } = (
        await payload.db.pool.query(
          "SELECT created_at FROM catalog_delivery_intents WHERE id = $1",
          [intent.intentId],
        )
      ).rows[0] as { created_at: Date };
      const hour = Number.parseInt(run.replaceAll("-", "").slice(0, 8), 16);
      const createdAt = new Date(
        Date.UTC(2098, 0, 1) + (hour % 8_000) * 3_600_000,
      );
      const placeAt = (at: Date) =>
        payload.db.pool.query(
          "UPDATE catalog_delivery_intents SET created_at = $2 WHERE id = $1",
          [intent.intentId, at],
        );
      await placeAt(createdAt);
      const minute = 60_000;
      let countedAt = new Date(createdAt.getTime() - 1);
      const close = await syntheticOperatorBoundary({
        catalogRenderBacklog: async () => ({
          tiers: { t0: 0, t1: 0, t2: 7, t3: 0, t4: 0 },
          countedAt: countedAt.toISOString(),
          queued: 7,
          running: 0,
        }),
      });
      const pacing = async () => {
        const response = await post(
          "catalog-render-backlog",
          {},
          automationSession,
        );
        expect(response.status).toBe(200);
        return (await response.json()).result;
      };
      try {
        // Prepared after the count: its 2 images are not in any tier yet.
        expect(await pacing()).toMatchObject({
          tiers: { t2: 7 },
          preparedSince: 2,
        });
        // Begun just before the count: its commit may have followed the
        // pass's snapshot, or the worker's clock may run ahead, so it is
        // still added (counted twice at worst, never missed).
        for (const after of [1_000, 10 * minute - 1_000]) {
          countedAt = new Date(createdAt.getTime() + after);
          expect((await pacing()).preparedSince, String(after)).toBe(2);
        }
        // Begun over 10 minutes before the count: the sync pass holds it.
        countedAt = new Date(createdAt.getTime() + 10 * minute + 1_000);
        expect((await pacing()).preparedSince).toBe(0);
        // Ended, it will never be rendered for this intent.
        countedAt = new Date(createdAt.getTime() - 1);
        const cancelled = await post("cancel-catalog-delivery", {
          intentId: intent.intentId,
          expectedStateVersion: 1,
          idempotencyKey: `${run}:pacing-cancel`,
        });
        expect(cancelled.status).toBe(200);
        expect((await pacing()).preparedSince).toBe(0);
      } finally {
        await placeAt(originalCreatedAt);
        await close();
      }
    });

    it("proxies the render backlog to an authenticated editorial actor only, counts only (I9)", async () => {
      const backlog = async (session = ownerSession, input: unknown = {}) => {
        const response = await post("catalog-render-backlog", input, session);
        return { status: response.status, body: await response.json() };
      };
      // Counted after every intent here: none was prepared since.
      const counted = {
        tiers: { t0: 3, t1: 2, t2: 40, t3: 0, t4: 1_200 },
        countedAt: "2099-01-01T00:00:00.000Z",
        queued: 300,
        running: 1,
      };
      const failure = (code: string) => ({
        status: 503,
        body: { ok: false, error: { code, fields: [] } },
      });
      const reader = vi.fn(async () => counted);
      // Anonymous: refused before the Backend is asked.
      const anonymous = await backlog("");
      expect(anonymous.status).toBe(403);
      expect(anonymous.body).toMatchObject({
        ok: false,
        error: { code: "AUTHORIZATION_REQUIRED" },
      });
      // No operator boundary configured in this Admin.
      expect(await backlog()).toEqual(
        failure("CATALOG_RENDER_BACKLOG_NOT_CONFIGURED"),
      );
      const close = await syntheticOperatorBoundary({
        catalogRenderBacklog: reader,
      });
      try {
        for (const session of [ownerSession, automationSession])
          expect(await backlog(session)).toEqual({
            status: 200,
            body: { ok: true, result: { ...counted, preparedSince: 0 } },
          });
        expect(reader).toHaveBeenCalledTimes(2);
        // The body is the capability probe's: empty.
        for (const input of [{ catalogId: ids[0] }, { tiers: null }, []])
          expect((await backlog(ownerSession, input)).status).toBe(400);
        expect(reader).toHaveBeenCalledTimes(2);
      } finally {
        await close();
      }
      // A Backend without the reader (503), or whose reader fails (500), is
      // unavailable.
      for (const dependencies of [
        {},
        {
          catalogRenderBacklog: async () => {
            throw new Error("synthetic backlog failure");
          },
        },
      ] as Partial<OperatorRouteDependencies>[]) {
        const closeFailing = await syntheticOperatorBoundary(dependencies);
        try {
          expect(await backlog(automationSession)).toEqual(
            failure("CATALOG_RENDER_BACKLOG_UNAVAILABLE"),
          );
        } finally {
          await closeFailing();
        }
      }
      // A Backend older than the route (404) is not configured; an answer
      // beyond the contract is unavailable, never passed on.
      for (const [status, answer, code] of [
        [
          404,
          { error: { status: 404, code: "NOT_FOUND" } },
          "CATALOG_RENDER_BACKLOG_NOT_CONFIGURED",
        ],
        [
          200,
          { ...counted, assetIds: ["synthetic-asset"] },
          "CATALOG_RENDER_BACKLOG_UNAVAILABLE",
        ],
      ] as const) {
        const raw = createServer((_request, response) => {
          response.writeHead(status, { "content-type": "application/json" });
          response.end(JSON.stringify(answer));
        });
        await new Promise<void>((resolve) =>
          raw.listen(0, "127.0.0.1", resolve),
        );
        try {
          const address = raw.address();
          if (!address || typeof address === "string")
            throw new Error("Synthetic operator address missing");
          vi.stubEnv(
            "COMMUNITY_OPERATOR_BASE_URL",
            `http://127.0.0.1:${address.port}`,
          );
          vi.stubEnv("COMMUNITY_OPERATOR_TOKEN", randomUUID());
          const answered = await backlog();
          expect(answered).toEqual(failure(code));
          expect(JSON.stringify(answered)).not.toContain("synthetic-asset");
        } finally {
          vi.stubEnv("COMMUNITY_OPERATOR_BASE_URL", "");
          vi.stubEnv("COMMUNITY_OPERATOR_TOKEN", "");
          await new Promise<void>((resolve, reject) =>
            raw.close((error) => (error ? reject(error) : resolve())),
          );
        }
      }
    });
  });
