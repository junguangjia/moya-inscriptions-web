import { createHash } from "node:crypto";

import {
  catalogExpectedRenditions,
  createCatalogPublicationAuthority,
  currentCatalogRecipePolicy,
  planCatalogAsset,
  planCatalogPermissions,
} from "@moya/backend-production/internal/catalog-delivery";
import { parseCatalogPrepareRows } from "@moya/community-postgres";
import { describe, expect, it } from "vitest";

import { catalogAuthorityWithCopySet } from "./catalog-copy-set.js";
import { previousCatalogPlan } from "./catalog-plan-oracle.js";
import { snapshotCursors } from "./catalog-snapshot-cursor.js";

import type {
  CatalogAssetPermission,
  CatalogIntentPin,
  CatalogPlanIntent,
  CatalogPlanReads,
  CatalogPriorPin,
  CatalogSelectorRendition,
} from "@moya/backend-production/internal/catalog-delivery";

/*
 * catalog-scale-v1 (Issue #323) 1B W1: Catalog desired-set planning is
 * linear. One asset's plan is a pure function (planCatalogAsset); the whole
 * Catalog's plan (planCatalogPermissions, what the authority's plans() runs)
 * groups every row by pair once and plans each asset over its own rows.
 * Differential: on generated Catalogs (recipe bumps half done, released and
 * superseded rows still published or not, blocks, full rows, a slot ready
 * twice, a pair published twice, prepared, requested, released and ended
 * intents of the current and an earlier recipe policy, live and expired),
 * every asset gets exactly the permissions the #320 plans() gave it, the App
 * is read in the same order, and the copy selector is the same set. A pair
 * that is not public gets no live public permission. The plan visits each
 * selector row once, so its cost grows linearly with the Catalog. Synthetic
 * metadata only; no database, object store or network. The #320 plan is the
 * oracle (catalog-plan-oracle.ts).
 */

const md5 = (value: string) => createHash("md5").update(value).digest("hex");
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const assetOf = (mediaId: string, objectKey: string) =>
  `catalog-asset-${md5(`${mediaId}:${objectKey}`)}`;
const policy = currentCatalogRecipePolicy().recipeManifestSha256;
const EARLIER_POLICY = "e".repeat(64);
const PREVIOUS_DIGEST = "0".repeat(16);
const NOW = Date.parse("2126-10-22T00:00:00.000Z");
const HOUR = 3_600_000;
const STATES = [
  "prepared",
  "release_requested",
  "released",
  "cancelled",
  "superseded",
  "expired",
  "withdrawn",
] as const;
const SIZES = [
  [4096, 2731],
  [1000, 800],
  [3000, 2000],
  [512, 512],
  [9504, 6336],
] as const;
const ROLES = ["thumb", "cover", "display", "viewer"];

type Snapshot = Parameters<typeof planCatalogPermissions>[0];
interface Pair {
  readonly mediaId: string;
  readonly objectKey: string;
  readonly width: number;
  readonly height: number;
}

/** A small deterministic PRNG (mulberry32): a failing case names its seed. */
const random = (seed: number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
};

/** One CMS view row per member (a header row for an ended intent or an
 * empty manifest), as public.catalog_delivery_prepare_media lists them,
 * decoded by the snapshot's own decoder. */
const decodeIntent = (spec: {
  readonly intentId: string;
  readonly documentId: number;
  readonly state: (typeof STATES)[number];
  readonly stateVersion: number;
  readonly recipe: string;
  readonly expiresAt: number;
  readonly members: readonly Pair[];
}): CatalogPlanIntent => {
  const header = {
    intent_id: spec.intentId,
    catalog_document_id: spec.documentId,
    catalog_id: `synthetic-catalog-${spec.documentId}`,
    draft_revision: 1,
    draft_fingerprint: "a".repeat(64),
    media_manifest_sha256: sha(`${spec.intentId}:manifest`),
    recipe_manifest_sha256: spec.recipe,
    state: spec.state,
    state_version: spec.stateVersion,
    media_count: spec.members.length,
    expires_at: new Date(spec.expiresAt).toISOString(),
  };
  const live = ["prepared", "release_requested", "released"].includes(
    spec.state,
  );
  const rows =
    live && spec.members.length
      ? spec.members.map((member, i) => ({
          ...header,
          media_ordinal: i + 1,
          media_id: member.mediaId,
          object_key: member.objectKey,
          source_sha256: sha(`${member.mediaId}:bytes`),
          width: member.width,
          height: member.height,
        }))
      : [
          {
            ...header,
            media_ordinal: null,
            media_id: null,
            object_key: null,
            source_sha256: null,
            width: null,
            height: null,
          },
        ];
  const [intent] = parseCatalogPrepareRows(rows);
  return intent!;
};

/** A generated Catalog: the snapshot and the App facts of every intent and
 * pair, served by deterministic App reads that log what they are asked. */
const generate = (seed: number) => {
  const r = random(seed);
  const pick = <T>(list: readonly T[]) => list[Math.floor(r() * list.length)]!;
  const chance = (p: number) => r() < p;
  let next = 0;
  const rid = () =>
    `media-rendition-${(seed * 4096 + ++next).toString(16).padStart(32, "0")}`;
  const pairs: Pair[] = Array.from(
    { length: 1 + Math.floor(r() * 12) },
    (_, n) => {
      const [width, height] = pick(SIZES);
      const mediaId = `synthetic-${seed}-${n}`;
      const bytes = sha(`${mediaId}:bytes`);
      return {
        mediaId,
        objectKey: chance(0.8)
          ? `editorial/${sha(`catalog-${seed}-${n}`)}/${sha(mediaId)}-${bytes}.jpg`
          : `display/v1/media_${md5(mediaId)}/${bytes}.webp`,
        width,
        height,
      };
    },
  );
  // Everything rendered for each pair that the selector SQL can return: per
  // role slot the previous recipe's rendition (ready, or released or
  // superseded by a re-render) and the current one (absent, ready, or ready
  // with other geometry), each published or not; sometimes a slot ready
  // twice, full and block rows, or a master the plan does not expect. A
  // quarter of the pairs have finished a bump: the replacement is complete
  // and published, the previous set still published beside it.
  const rendered: CatalogSelectorRendition[] = [];
  for (const pair of pairs) {
    const master = chance(0.9) ? pair : { width: 1000, height: 800 };
    const finished = chance(0.25);
    const row = (
      role: string,
      digest: string,
      width: number,
      height: number,
      state: CatalogSelectorRendition["state"],
      published: boolean,
    ) => ({
      id: rid(),
      media_id: pair.mediaId,
      source_object_key: pair.objectKey,
      role,
      recipe_version: 1,
      recipe_digest: digest,
      width,
      height,
      master_width: master.width,
      master_height: master.height,
      state,
      published: ROLES.includes(role) && published,
    });
    for (const want of catalogExpectedRenditions(pair.width, pair.height)) {
      const shape = finished
        ? "finished"
        : pick([
            "previous",
            "bumping",
            "bumping",
            "current",
            "current",
            "empty",
            "twice",
          ] as const);
      if (shape === "finished") {
        rendered.push(
          row(
            want.role,
            PREVIOUS_DIGEST,
            want.width,
            want.height,
            "released",
            true,
          ),
          row(want.role, want.digest, want.width, want.height, "ready", true),
        );
        continue;
      }
      if (shape === "previous" || shape === "bumping" || shape === "twice")
        rendered.push(
          row(
            want.role,
            PREVIOUS_DIGEST,
            want.width,
            want.height,
            shape === "bumping"
              ? pick(["released", "superseded"] as const)
              : "ready",
            chance(0.7),
          ),
        );
      if (shape === "bumping" || shape === "current" || shape === "twice")
        rendered.push(
          row(
            want.role,
            want.digest,
            want.width,
            chance(0.9) ? want.height : want.height + 1,
            "ready",
            chance(0.6),
          ),
        );
    }
    if (chance(0.2))
      rendered.push(
        row("full", "1".repeat(16), pair.width, pair.height, "ready", false),
      );
    if (chance(0.3))
      for (const cell of ["block-00", "block-01"])
        rendered.push(row(cell, "2".repeat(16), 1026, 1026, "ready", false));
  }
  // The selector SQL's own filter: a row that is not ready only while it is
  // a published editorial one. Its order is the database's (none).
  const selectable = rendered
    .filter(
      (row) =>
        row.state === "ready" ||
        (row.published && row.source_object_key.startsWith("editorial/")),
    )
    .sort(() => r() - 0.5);
  const publishedSources = pairs
    .flatMap((pair) =>
      chance(0.6) ? (chance(0.15) ? [pair, pair] : [pair]) : [],
    )
    .sort(() => r() - 0.5);
  const intents = Array.from({ length: Math.floor(r() * 7) }, (_, n) =>
    decodeIntent({
      intentId: `00000000-0000-4000-8000-${(seed * 8 + n).toString(16).padStart(12, "0")}`,
      documentId: 1 + Math.floor(r() * 3),
      state: pick(STATES),
      stateVersion: 1 + Math.floor(r() * 3),
      recipe: chance(0.7) ? policy : EARLIER_POLICY,
      expiresAt: NOW + (chance(0.6) ? HOUR : -HOUR),
      members: pairs.filter(() => chance(0.4)).slice(0, 4),
    }),
  );
  const ready = new Map(intents.map((i) => [i.intentId, chance(0.7)]));
  // Pins of each member: some roles, of the current recipe or not, with the
  // planned geometry or not.
  const pinsOf = new Map<string, CatalogIntentPin[]>();
  const priorOf = new Map<string, CatalogPriorPin[]>();
  for (const intent of intents) {
    const pins: CatalogIntentPin[] = [];
    const prior: CatalogPriorPin[] = [];
    for (const m of intent.media)
      for (const want of catalogExpectedRenditions(m.width, m.height)) {
        if (chance(0.8))
          pins.push({
            rendition_id: rid(),
            media_id: m.mediaId,
            object_key: m.objectKey,
            role: want.role,
            recipe_version: want.version,
            recipe_digest: chance(0.85) ? want.digest : PREVIOUS_DIGEST,
            width: want.width,
            height: chance(0.9) ? want.height : want.height + 1,
            master_width: m.width,
            master_height: m.height,
          });
        if (chance(0.7))
          prior.push({
            rendition_id: rid(),
            media_id: m.mediaId,
            object_key: m.objectKey,
          });
      }
    pinsOf.set(
      intent.intentId,
      pins.sort(() => r() - 0.5),
    );
    priorOf.set(intent.intentId, prior);
  }
  const snapshot: Snapshot = {
    publishedSources: publishedSources.map((p) => ({
      mediaId: p.mediaId,
      objectKey: p.objectKey,
      width: p.width,
      height: p.height,
    })),
    preparations: intents,
  };
  const reads = () => {
    const log: string[] = [];
    const served: CatalogPlanReads = {
      inspect: async (intent) => {
        log.push(`inspect ${intent.intentId}`);
        return { privateReady: ready.get(intent.intentId)! };
      },
      pins: async (intent) => {
        log.push(`pins ${intent.intentId}`);
        return pinsOf.get(intent.intentId)!;
      },
      priorPins: async (intent) => {
        log.push(`prior ${intent.intentId}`);
        return priorOf.get(intent.intentId)!;
      },
      renditions: async (sources) => {
        log.push(`renditions ${JSON.stringify(sources)}`);
        const wanted = new Set(
          sources.map((s) => JSON.stringify([s.mediaId, s.objectKey])),
        );
        return selectable.filter((row) =>
          wanted.has(JSON.stringify([row.media_id, row.source_object_key])),
        );
      },
    };
    return { log, served };
  };
  return {
    pairs,
    intents,
    snapshot,
    reads,
    selectable,
    ready,
    pinsOf,
    priorOf,
  };
};

/** Permissions by asset, each asset's in order, an exact repeat dropped (a
 * repeat changes neither the copy set nor a fence's authorization). */
const byAsset = (permissions: readonly CatalogAssetPermission[]) => {
  const assets = new Map<string, string[]>();
  for (const permission of permissions) {
    const list = assets.get(permission.assetId) ?? [];
    const json = JSON.stringify(permission);
    if (!list.includes(json)) list.push(json);
    assets.set(permission.assetId, list);
  }
  return new Map(
    [...assets].map(([id, list]) => [
      id,
      list.map((json) => JSON.parse(json) as CatalogAssetPermission),
    ]),
  );
};
const copySet = (permissions: readonly CatalogAssetPermission[]) =>
  [...new Set(permissions.flatMap((p) => p.renditionIds))].sort();

describe("W1: the grouped Catalog plan equals the #320 plan, asset by asset", () => {
  const SEEDS = Array.from({ length: 400 }, (_, i) => i + 1);

  it("gives every asset the same permissions, reads App alike and selects the same copies", async () => {
    const reached = {
      assets: 0,
      privateB: 0,
      earlierPolicy: 0,
      currentPolicy: 0,
      livePublic: 0,
      publishedTwice: 0,
    };
    for (const seed of SEEDS) {
      const w = generate(seed);
      const before = w.reads();
      const after = w.reads();
      const expected = await previousCatalogPlan(
        w.snapshot,
        before.served,
        policy,
        NOW,
      );
      const actual = await planCatalogPermissions(
        w.snapshot,
        after.served,
        policy,
        NOW,
      );
      expect(after.log, `seed ${seed}`).toEqual(before.log);
      expect(byAsset(actual), `seed ${seed}`).toEqual(byAsset(expected));
      expect(copySet(actual), `seed ${seed}`).toEqual(copySet(expected));
      // One live public permission per asset, even for a pair published in
      // two records; nothing else repeats.
      expect(actual.length, `seed ${seed}`).toBe(
        [...byAsset(actual).values()].flat().length,
      );
      reached.assets += byAsset(expected).size;
      reached.privateB += actual.filter((p) => p.intentId !== null).length;
      reached.earlierPolicy += actual.filter(
        (p) => p.policy === EARLIER_POLICY,
      ).length;
      reached.currentPolicy += actual.filter(
        (p) => p.intentId === null && p.policy === policy,
      ).length;
      reached.livePublic += actual.filter(
        (p) => p.documentId === null && p.renditionIds.length > 0,
      ).length;
      if (expected.length > actual.length) reached.publishedTwice += 1;
    }
    // The generated Catalogs reach every kind of permission.
    for (const [kind, count] of Object.entries(reached))
      expect(count, kind).toBeGreaterThan(20);
  });

  it("plans one asset alone from its own facts, whatever else the rows hold", async () => {
    let planned = 0;
    for (const seed of SEEDS) {
      const w = generate(seed);
      const expected = byAsset(
        await previousCatalogPlan(w.snapshot, w.reads().served, policy, NOW),
      );
      const published = new Set(
        w.snapshot.publishedSources.map((s) =>
          JSON.stringify([s.mediaId, s.objectKey]),
        ),
      );
      for (const pair of w.pairs) {
        // Every intent naming the pair, each with all of its facts, and the
        // selector rows of every pair (public or not): the plan keeps its
        // own.
        const intents = w.intents.flatMap((intent) => {
          const member = intent.media.find(
            (m) => m.mediaId === pair.mediaId && m.objectKey === pair.objectKey,
          );
          if (!member) return [];
          const ready = w.ready.get(intent.intentId)!;
          return [
            {
              intent,
              ordinal: member.ordinal,
              facts:
                intent.recipeManifestSha256 === policy
                  ? {
                      kind: "current" as const,
                      privateReady: ready,
                      pins: ready ? w.pinsOf.get(intent.intentId)! : [],
                    }
                  : {
                      kind: "prior" as const,
                      pins: w.priorOf.get(intent.intentId)!,
                    },
            },
          ];
        });
        const isPublic = published.has(
          JSON.stringify([pair.mediaId, pair.objectKey]),
        );
        const plan = planCatalogAsset({
          mediaId: pair.mediaId,
          objectKey: pair.objectKey,
          public: isPublic,
          policy,
          now: NOW,
          intents,
          renditions: w.selectable,
        });
        expect(plan, `seed ${seed} ${pair.mediaId}`).toEqual(
          expected.get(assetOf(pair.mediaId, pair.objectKey)) ?? [],
        );
        // Public gating: an unpublished pair's only permissions are private
        // B ones of requested intents, never the live public one, even with
        // ready published renditions rendered for it.
        if (!isPublic)
          for (const permission of plan) {
            expect(permission.published).toBe(false);
            expect(permission.intentId).not.toBeNull();
          }
        planned += 1;
      }
    }
    expect(planned).toBeGreaterThan(2000);
  });
});

describe("W1: planCatalogAsset", () => {
  const pair: Pair = {
    mediaId: "synthetic-plan",
    objectKey: `editorial/${sha("catalog")}/${sha("media")}-${sha("bytes")}.jpg`,
    width: 4096,
    height: 2731,
  };
  const current = catalogExpectedRenditions(pair.width, pair.height).map(
    (want, i): CatalogSelectorRendition => ({
      id: `media-rendition-${(i + 1).toString(16).padStart(32, "0")}`,
      media_id: pair.mediaId,
      source_object_key: pair.objectKey,
      role: want.role,
      recipe_version: want.version,
      recipe_digest: want.digest,
      width: want.width,
      height: want.height,
      master_width: pair.width,
      master_height: pair.height,
      state: "ready",
      published: true,
    }),
  );
  const intent = (
    state: (typeof STATES)[number],
    recipe = policy,
    expiresAt = NOW + HOUR,
  ) =>
    decodeIntent({
      intentId: "00000000-0000-4000-8000-0000000000a1",
      documentId: 7,
      state,
      stateVersion: 2,
      recipe,
      expiresAt,
      members: [pair],
    });
  const pins = (ids: readonly CatalogSelectorRendition[]): CatalogIntentPin[] =>
    ids.map((r) => ({
      rendition_id: r.id,
      media_id: r.media_id,
      object_key: r.source_object_key,
      role: r.role,
      recipe_version: r.recipe_version,
      recipe_digest: r.recipe_digest,
      width: r.width,
      height: r.height,
      master_width: r.master_width,
      master_height: r.master_height,
    }));
  const plan = (
    isPublic: boolean,
    intents: Parameters<typeof planCatalogAsset>[0]["intents"] = [],
  ) =>
    planCatalogAsset({
      mediaId: pair.mediaId,
      objectKey: pair.objectKey,
      public: isPublic,
      policy,
      now: NOW,
      intents,
      renditions: current,
    });

  it("grants the live public permission only while the pair is public", () => {
    expect(plan(true)).toEqual([
      {
        assetId: assetOf(pair.mediaId, pair.objectKey),
        documentId: null,
        intentId: null,
        stateVersion: 0,
        manifestSha256: "",
        policy: "",
        published: true,
        renditionIds: current.map((r) => r.id),
      },
    ]);
    // Taken down: its ready, published renditions are no longer desired, so
    // the withdrawal is scheduled.
    expect(plan(false)).toEqual([]);
  });

  it("grants private B only to a requested intent before its expiry", () => {
    const facts = {
      kind: "current" as const,
      privateReady: true,
      pins: pins(current),
    };
    const requested = plan(false, [
      { intent: intent("release_requested"), ordinal: 1, facts },
    ]);
    expect(requested).toHaveLength(1);
    expect(requested[0]).toMatchObject({
      intentId: "00000000-0000-4000-8000-0000000000a1",
      documentId: 7,
      published: false,
      renditionIds: current.map((r) => r.id),
    });
    for (const quiet of [
      intent("prepared"),
      intent("released"),
      intent("release_requested", policy, NOW - HOUR),
      intent("release_requested", EARLIER_POLICY),
    ])
      expect(plan(false, [{ intent: quiet, ordinal: 1, facts }])).toEqual([]);
  });

  it("refuses missing facts and a member that is not the pair instead of granting nothing", () => {
    expect(() =>
      plan(true, [{ intent: intent("prepared"), ordinal: 1 }]),
    ).toThrow("Catalog plan facts unavailable");
    expect(() =>
      plan(true, [
        {
          intent: intent("released", EARLIER_POLICY),
          ordinal: 1,
          facts: { kind: "current", privateReady: true, pins: [] },
        },
      ]),
    ).toThrow("Catalog plan facts unavailable");
    expect(() =>
      plan(true, [
        {
          intent: intent("prepared"),
          ordinal: 2,
          facts: { kind: "current", privateReady: false, pins: [] },
        },
      ]),
    ).toThrow("Catalog plan member invalid");
    // Facts a plan never needs may be left out: an intent that is not a live
    // release request while the pair is not public, or one of an earlier
    // policy that is not released, grants it nothing.
    expect(plan(false, [{ intent: intent("prepared"), ordinal: 1 }])).toEqual(
      [],
    );
    expect(
      plan(true, [
        {
          intent: intent("release_requested", EARLIER_POLICY),
          ordinal: 1,
        },
      ]),
    ).toHaveLength(1);
  });
});

describe("W1: plan cost grows linearly with the Catalog", () => {
  /** `rows` behind a proxy that counts each element read into `visits.rows`:
   * a plan that filtered every row once per source shows as size x rows. */
  const counting = <T extends object>(
    rows: T[],
    visits: { rows: number },
  ): T[] =>
    new Proxy(rows, {
      get(target, key, receiver) {
        if (typeof key === "string" && /^[0-9]+$/u.test(key)) visits.rows += 1;
        return Reflect.get(target, key, receiver) as unknown;
      },
    });

  /** A Catalog of `size` published editorial images, every one with its
   * current recipe's set ready and published, read through the authority's
   * own SQL; the App selector rows are counted as the plan visits them. */
  const catalog = (size: number) => {
    const sources = Array.from({ length: size }, (_, n) => ({
      media_id: `synthetic-${n}`,
      object_key: `editorial/${sha(`catalog-${n}`)}/${sha(`media-${n}`)}-${sha(`bytes-${n}`)}.jpg`,
      width: 4096,
      height: 2731,
    }));
    let id = 0;
    const rows = sources.flatMap((source) =>
      catalogExpectedRenditions(source.width, source.height).map((want) => ({
        id: `media-rendition-${(++id).toString(16).padStart(32, "0")}`,
        media_id: source.media_id,
        source_object_key: source.object_key,
        master_width: source.width,
        master_height: source.height,
        role: want.role,
        recipe_version: want.version,
        recipe_digest: want.digest,
        width: want.width,
        height: want.height,
        state: "ready",
        published: true,
      })),
    );
    const visits = { rows: 0 };
    // The selector is read in batches of assets (W5): each statement answers
    // the rows of its own assets, counted as they are visited.
    const selected = (assetIds: readonly string[]) => {
      const wanted = new Set(assetIds);
      return counting(
        rows.filter((r) =>
          wanted.has(assetOf(r.media_id, r.source_object_key)),
        ),
        visits,
      );
    };
    // The complete published list is read through a cursor (W3).
    const cursors = snapshotCursors((sql) =>
      sql.includes("FROM catalog_media") ? sources : undefined,
    );
    const publishedQuery = async (sql: string) => {
      const cursor = cursors(sql);
      if (cursor) return cursor;
      if (sql.includes("clock_timestamp()"))
        return { rows: [{ at: new Date(NOW) }] };
      if (sql.includes("FROM catalog_media")) return { rows: sources };
      if (["BEGIN", "ROLLBACK"].some((prefix) => sql.startsWith(prefix)))
        return { rows: [] };
      throw new Error("UNEXPECTED_PUBLIC_SQL");
    };
    const published = {
      query: publishedQuery,
      connect: async () => ({ query: publishedQuery, release: () => {} }),
    } as unknown as Parameters<typeof createCatalogPublicationAuthority>[0];
    const app = {
      query: async (sql: string, values?: readonly unknown[]) => {
        if (sql.startsWith("SELECT DISTINCT r.id"))
          return { rows: selected(values![0] as string[]) };
        throw new Error("UNEXPECTED_APP_SQL");
      },
    } as unknown as Parameters<typeof createCatalogPublicationAuthority>[2];
    return {
      authority: catalogAuthorityWithCopySet(published, null, app),
      rows,
      visits,
    };
  };

  it(
    "visits each selector row once, at any Catalog size",
    { timeout: 60_000 },
    async () => {
      for (const size of [250, 2_000]) {
        const c = catalog(size);
        const ids = await c.authority.copyRenditionIds();
        expect([...ids].sort()).toEqual(c.rows.map((r) => r.id).sort());
        // The #320 plan filtered every row once per source: size x rows.
        expect(c.visits.rows).toBeLessThanOrEqual(2 * c.rows.length);
      }
    },
  );

  it(
    "plans 20,000 images, beyond the old ceilings, with work in proportion",
    { timeout: 60_000 },
    async () => {
      /** `size` published images, each with its ready current set, and one
       * released record (current policy, private-ready, pinned) per seven.
       * Selector row visits and App reads are counted. */
      const world = (size: number) => {
        const sources = Array.from({ length: size }, (_, n) => {
          const mediaId = `synthetic-${n}`;
          return {
            mediaId,
            objectKey: `editorial/${sha(`catalog-${Math.floor(n / 7)}`)}/${sha(mediaId)}-${sha(`${mediaId}:bytes`)}.jpg`,
            width: 4096,
            height: 2731,
          };
        });
        let id = 0;
        const rid = () =>
          `media-rendition-${(++id).toString(16).padStart(32, "0")}`;
        const rendered = sources.flatMap((s) =>
          catalogExpectedRenditions(s.width, s.height).map(
            (want): CatalogSelectorRendition => ({
              id: rid(),
              media_id: s.mediaId,
              source_object_key: s.objectKey,
              role: want.role,
              recipe_version: want.version,
              recipe_digest: want.digest,
              width: want.width,
              height: want.height,
              master_width: s.width,
              master_height: s.height,
              state: "ready",
              published: true,
            }),
          ),
        );
        const intents: CatalogPlanIntent[] = [];
        for (let start = 0; start < size; start += 7)
          intents.push(
            decodeIntent({
              intentId: `00000000-0000-4000-8000-${start.toString(16).padStart(12, "0")}`,
              documentId: 1 + start / 7,
              state: "released",
              stateVersion: 1,
              recipe: policy,
              expiresAt: NOW - HOUR,
              members: sources.slice(start, start + 7),
            }),
          );
        const visits = {
          rows: 0,
          inspect: 0,
          pins: 0,
          priorPins: 0,
          renditions: 0,
        };
        const reads: CatalogPlanReads = {
          inspect: async () => {
            visits.inspect += 1;
            return { privateReady: true };
          },
          pins: async (intent) => {
            visits.pins += 1;
            return intent.media.flatMap((m) =>
              catalogExpectedRenditions(m.width, m.height).map((want) => ({
                rendition_id: rid(),
                media_id: m.mediaId,
                object_key: m.objectKey,
                role: want.role,
                recipe_version: want.version,
                recipe_digest: want.digest,
                width: want.width,
                height: want.height,
                master_width: m.width,
                master_height: m.height,
              })),
            );
          },
          priorPins: async () => {
            visits.priorPins += 1;
            return [];
          },
          renditions: async () => {
            visits.renditions += 1;
            return counting(rendered, visits);
          },
        };
        return {
          snapshot: { publishedSources: sources, preparations: intents },
          reads,
          rendered,
          intents,
          visits,
        };
      };
      // 20,000 images are 80,000 selector rows, twice the #320 refusal. The
      // smaller Catalog comes first, so an S x R plan fails it in seconds
      // (2,500 x 10,000 visits) instead of running 20,000 x 80,000. Work is
      // counted, not timed: a wall clock belongs to the local bench (W0).
      for (const size of [2_500, 20_000]) {
        const w = world(size);
        const permissions = await planCatalogPermissions(
          w.snapshot,
          w.reads,
          policy,
          NOW,
        );
        // Each image: its released record's permission and the live one,
        // which copies its whole current set.
        expect(permissions).toHaveLength(2 * size);
        const live = permissions.filter((p) => p.documentId === null);
        expect(live).toHaveLength(size);
        expect(live.flatMap((p) => p.renditionIds).sort()).toEqual(
          w.rendered.map((r) => r.id).sort(),
        );
        // Each selector row is visited a bounded number of times, and App is
        // read once per intent (inspect, then pins) and once for the rows.
        expect(w.visits.rows, String(size)).toBeLessThanOrEqual(
          2 * w.rendered.length,
        );
        expect(w.visits).toMatchObject({
          inspect: w.intents.length,
          pins: w.intents.length,
          priorPins: 0,
          renditions: 1,
        });
      }
    },
  );
});
