import { createHash } from "node:crypto";

import {
  CATALOG_SCOPE_BATCH,
  captureCatalogAssets,
  catalogExpectedRenditions,
  catalogLiveIntentRowsSql,
  createCatalogPublicationAuthority,
  currentCatalogRecipePolicy,
  planCatalogScope,
} from "@moya/backend-production/internal/catalog-delivery";
import { publishedCatalogPairsSql } from "@moya/backend-production/internal/publishing-catalog";
import {
  PostgresMediaPublicationAdapter,
  partitionCatalogPrepareRows,
} from "@moya/community-postgres";
import { afterEach, describe, expect, it, vi } from "vitest";

import { previousCatalogPlan } from "./catalog-plan-oracle.js";

import type { PublishingJobLease } from "@moya/api";
import type {
  CatalogAssetPermission,
  CatalogIntentPin,
  CatalogPlanReads,
  CatalogPriorPin,
  CatalogSelectorRendition,
} from "@moya/backend-production/internal/catalog-delivery";

/*
 * catalog-scale-v1 (Issue #323) 1B W5 and W7: a Catalog job's publication authority
 * reads only its own asset. acquire captures the asset's plan from its App
 * row, the intents App mirror members name for it and its exact CMS pair
 * (captureCatalogAssets); the fence re-reads exactly those intents by id;
 * authorized() checks exactly that pair; the publication adapter's desired
 * set is the job's own capture, never a whole-Catalog plan.
 * - Differential: on generated Catalogs (published twice, unpublished pairs,
 *   App rows missing, intents of every state, of the current and an earlier
 *   policy, live and lapsed, known to App or not), each asset's capture is
 *   exactly the whole-Catalog oracle's (the #320 plan, catalog-plan-oracle)
 *   permissions for it, but those of intents App does not know, which never
 *   grant a rendition there either.
 * - Fence consistency: capture and every check run the same read of the same
 *   App-known intents; an intent App does not know never changes the fence;
 *   a captured live intent that changes, ends or lapses makes it stale.
 * - Read errors throw, never "not public" or "nothing permitted".
 * - Cost: acquire, current() and authorized() issue the same statements
 *   whatever the Catalog's size, and never list the published Catalog.
 * - W7: a scoped reconcile pass plans its scope in batches exactly as each
 *   asset's own capture, with each intent's facts read once per pass; an
 *   asset whose plan throws is isolated, a pass where every plan throws
 *   fails, and the budget stops it after a prefix of its scope.
 * Synthetic metadata only; no database, object store or network.
 */

type Row = Record<string, unknown>;

const md5 = (value: string) => createHash("md5").update(value).digest("hex");
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const assetOf = (mediaId: string, objectKey: string) =>
  `catalog-asset-${md5(`${mediaId}:${objectKey}`)}`;
const key = (mediaId: string, objectKey: string) =>
  JSON.stringify([mediaId, objectKey]);
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
  [9504, 6336],
] as const;
const ROLES = ["thumb", "cover", "display", "viewer"];

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

interface Pair {
  readonly mediaId: string;
  readonly objectKey: string;
  readonly width: number;
  readonly height: number;
}
const pairOf = (
  name: string,
  editorial = true,
  size: readonly [number, number] = SIZES[0],
): Pair => {
  const bytes = sha(`${name}:bytes`);
  return {
    mediaId: `synthetic-${name}`,
    objectKey: editorial
      ? `editorial/${sha(`catalog-${name}`)}/${sha(name)}-${bytes}.jpg`
      : `display/v1/media_${md5(name)}/${bytes}.webp`,
    width: size[0],
    height: size[1],
  };
};

interface Intent {
  readonly intentId: string;
  documentId: number;
  state: (typeof STATES)[number];
  stateVersion: number;
  readonly recipe: string;
  expiresAt: number;
  readonly members: readonly Pair[];
  /** Whether App mirror members name it (the sync mirrored it). */
  readonly appKnown: boolean;
}

/** The rows the live private projection holds for an intent at `now`, as
 * CMS migration M2 defines it: a member row each while released, or
 * prepared or requested within its lease; otherwise one header row, whose
 * state reads expired once a lease lapses. */
const viewRows = (intent: Intent, now = NOW): Row[] => {
  const lapsed =
    ["prepared", "release_requested"].includes(intent.state) &&
    intent.expiresAt <= now;
  const header = {
    intent_id: intent.intentId,
    catalog_document_id: intent.documentId,
    catalog_id: `synthetic-catalog-${intent.documentId}`,
    draft_revision: 1,
    draft_fingerprint: "a".repeat(64),
    media_manifest_sha256: sha(`${intent.intentId}:manifest`),
    recipe_manifest_sha256: intent.recipe,
    state: lapsed ? "expired" : intent.state,
    state_version: intent.stateVersion,
    media_count: intent.members.length,
    expires_at: new Date(intent.expiresAt).toISOString(),
  };
  const live =
    !lapsed &&
    ["prepared", "release_requested", "released"].includes(intent.state);
  return live && intent.members.length
    ? intent.members.map((member, i) => ({
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
};

/** One synthetic Catalog on both sides. The CMS: the published list and
 * the live private projection. App: the asset rows, the mirror's member
 * references (App-known intents only) and every fact a plan reads. */
interface World {
  readonly pairs: readonly Pair[];
  /** The published list (a pair two records show is listed twice). */
  readonly published: readonly Pair[];
  readonly intents: Intent[];
  /** Pairs App has an asset row for (the sync creates rows in batches). */
  readonly appAssets: ReadonlySet<string>;
  /** App selector rows of every pair (rows of its asset). */
  readonly selector: readonly CatalogSelectorRendition[];
  readonly pins: ReadonlyMap<string, readonly CatalogIntentPin[]>;
  readonly prior: ReadonlyMap<string, readonly CatalogPriorPin[]>;
  readonly ready: ReadonlyMap<string, boolean>;
}

const sortedIntents = (intents: readonly Intent[]) =>
  [...intents].sort((a, b) => a.intentId.localeCompare(b.intentId));

/** The view rows of the whole world, in the snapshot's order. */
const worldRows = (w: World, now = NOW) =>
  sortedIntents(w.intents).flatMap((intent) => viewRows(intent, now));

/** App's plan reads of the world, logging what they are asked. App facts
 * need App's mirror: an intent App does not know is never private-ready and
 * has no pins of an earlier policy (both join the mirror). */
const readsOf = (w: World, log: string[] = []): CatalogPlanReads => {
  const known = (intentId: string) =>
    w.intents.find((i) => i.intentId === intentId)?.appKnown === true;
  return {
    inspect: async (intent) => {
      log.push(`inspect ${intent.intentId}`);
      return {
        privateReady:
          known(intent.intentId) && w.ready.get(intent.intentId) === true,
      };
    },
    pins: async (intent) => {
      log.push(`pins ${intent.intentId}`);
      return w.pins.get(intent.intentId) ?? [];
    },
    priorPins: async (intent) => {
      log.push(`prior ${intent.intentId}`);
      return known(intent.intentId) ? (w.prior.get(intent.intentId) ?? []) : [];
    },
    renditions: async (sources) => {
      log.push(`renditions ${sources.length}`);
      const wanted = new Set(sources.map((s) => key(s.mediaId, s.objectKey)));
      return w.selector.filter((r) =>
        wanted.has(key(r.media_id, r.source_object_key)),
      );
    },
  };
};

/** The three pools over the world, recording every statement. `fail`
 * rejects the first statement of a pool that contains its text. */
const poolsOf = (
  w: World,
  options: {
    readonly statements?: { pool: string; sql: string; values: unknown[] }[];
    fail?: { readonly pool: string; readonly text: string } | undefined;
    readonly now?: () => number;
  } = {},
) => {
  const statements = options.statements ?? [];
  const run =
    (pool: string, answer: (sql: string, values: unknown[]) => Row[]) =>
    async (sql: string, values: unknown[] = []) => {
      statements.push({ pool, sql, values });
      const fail = options.fail;
      if (fail && fail.pool === pool && sql.includes(fail.text)) {
        options.fail = undefined;
        throw Object.assign(new Error("terminating connection"), {
          code: "57P01",
        });
      }
      const rows = answer(sql, values);
      return { rows, rowCount: rows.length };
    };
  const control = (sql: string) =>
    ["BEGIN", "ROLLBACK", "SET ", "SELECT pg_advisory_xact_lock"].some(
      (prefix) => sql.startsWith(prefix),
    );
  const publishedQuery = run("cms", (sql, values) => {
    if (sql === publishedCatalogPairsSql) {
      const [mediaIds, objectKeys] = values as [string[], string[]];
      const live = new Map<string, Row>();
      for (const p of w.published)
        if (mediaIds.includes(p.mediaId) && objectKeys.includes(p.objectKey))
          live.set(key(p.mediaId, p.objectKey), {
            media_id: p.mediaId,
            object_key: p.objectKey,
          });
      return [...live.values()];
    }
    if (sql.startsWith("SELECT pg_export_snapshot()"))
      return [{ id: "aaa-bbb-ccc" }];
    if (control(sql)) return [];
    throw new Error(`UNEXPECTED_CMS_SQL ${sql.slice(0, 60)}`);
  });
  const prepareQuery = run("prepare", (sql, values) => {
    // The live projection by intent id, with exactly the row condition the
    // statement names.
    if (
      sql.startsWith(
        "SELECT * FROM public.catalog_delivery_live_prepare_media WHERE intent_id=ANY(",
      )
    ) {
      const [ids] = values as [string[]];
      return worldRows(w, options.now?.() ?? NOW).filter(
        (row) =>
          ids.includes(row.intent_id as string) &&
          (!sql.includes("media_ordinal IS NOT NULL") ||
            row.media_ordinal !== null),
      );
    }
    if (control(sql)) return [];
    throw new Error(`UNEXPECTED_PREPARE_SQL ${sql.slice(0, 60)}`);
  });
  const appQuery = run("app", (sql, values) => {
    if (
      sql.startsWith(
        "SELECT id,media_id,source_object_key FROM community.catalog_media_assets WHERE id=ANY(",
      )
    )
      return w.pairs
        .filter(
          (p) =>
            w.appAssets.has(key(p.mediaId, p.objectKey)) &&
            (values[0] as string[]).includes(assetOf(p.mediaId, p.objectKey)),
        )
        .map((p) => ({
          id: assetOf(p.mediaId, p.objectKey),
          media_id: p.mediaId,
          source_object_key: p.objectKey,
        }));
    if (sql.startsWith("SELECT DISTINCT asset_id,intent_id")) {
      const rows: Row[] = [];
      for (const assetId of [...(values[0] as string[])].sort())
        for (const intent of sortedIntents(w.intents))
          if (
            intent.appKnown &&
            intent.members.some(
              (m) => assetOf(m.mediaId, m.objectKey) === assetId,
            )
          )
            rows.push({ asset_id: assetId, intent_id: intent.intentId });
      return rows;
    }
    if (sql.startsWith("SELECT pp.rendition_id,m.media_id,m.object_key"))
      return [...(w.prior.get(values[0] as string) ?? [])] as unknown as Row[];
    if (sql.startsWith("SELECT DISTINCT r.id")) {
      // The selector reads its assets by primary key.
      const wanted = new Set(values[0] as string[]);
      return w.selector.filter((r) =>
        wanted.has(assetOf(r.media_id, r.source_object_key)),
      ) as unknown as Row[];
    }
    throw new Error(`UNEXPECTED_APP_SQL ${sql.slice(0, 60)}`);
  });
  const prepareClients = { active: 0 };
  return {
    statements,
    prepareClients,
    published: {
      query: publishedQuery,
      connect: async () => ({ query: publishedQuery, release: () => {} }),
    } as unknown as Parameters<typeof createCatalogPublicationAuthority>[0],
    prepare: {
      connect: async () => {
        if (options.fail?.pool === "prepare.connect") {
          options.fail = undefined;
          throw new Error("timeout exceeded when trying to connect");
        }
        prepareClients.active += 1;
        let released = false;
        return {
          query: prepareQuery,
          release: () => {
            if (!released) prepareClients.active -= 1;
            released = true;
          },
        };
      },
    } as unknown as NonNullable<
      Parameters<typeof createCatalogPublicationAuthority>[1]
    >,
    app: { query: appQuery } as unknown as Parameters<
      typeof createCatalogPublicationAuthority
    >[2],
  };
};

/** A generated Catalog (seeded). */
const generate = (seed: number): World => {
  const r = random(seed);
  const pick = <T>(list: readonly T[]) => list[Math.floor(r() * list.length)]!;
  const chance = (p: number) => r() < p;
  let next = 0;
  const rid = () =>
    `media-rendition-${(seed * 4096 + ++next).toString(16).padStart(32, "0")}`;
  const pairs = Array.from({ length: 1 + Math.floor(r() * 10) }, (_, n) =>
    pairOf(`${seed}-${n}`, chance(0.8), pick(SIZES)),
  );
  const appAssets = new Set(
    pairs.filter(() => chance(0.9)).map((p) => key(p.mediaId, p.objectKey)),
  );
  // Selector rows only exist for pairs App has an asset row for: per role
  // slot the previous recipe's rendition (ready, or released or superseded
  // by a re-render) and the current one, each published or not; sometimes
  // full and block rows, or a master the plan does not expect.
  const selector: CatalogSelectorRendition[] = [];
  for (const pair of pairs) {
    if (!appAssets.has(key(pair.mediaId, pair.objectKey))) continue;
    const master = chance(0.9) ? pair : { width: 1000, height: 800 };
    const row = (
      role: string,
      digest: string,
      width: number,
      height: number,
      state: CatalogSelectorRendition["state"],
      published: boolean,
    ): CatalogSelectorRendition => ({
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
      const shape = pick(["previous", "bumping", "current", "both"] as const);
      if (shape !== "current")
        selector.push(
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
      if (shape !== "previous")
        selector.push(
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
      selector.push(
        row("full", "1".repeat(16), pair.width, pair.height, "ready", false),
      );
    if (chance(0.3))
      selector.push(
        row("block-00", "2".repeat(16), 1026, 1026, "ready", false),
      );
  }
  const published = pairs
    .flatMap((pair) =>
      chance(0.6) ? (chance(0.15) ? [pair, pair] : [pair]) : [],
    )
    .sort(() => r() - 0.5);
  const intents: Intent[] = Array.from(
    { length: Math.floor(r() * 7) },
    (_, n) => ({
      intentId: `00000000-0000-4000-8000-${(seed * 8 + n).toString(16).padStart(12, "0")}`,
      documentId: 1 + Math.floor(r() * 3),
      state: pick(STATES),
      stateVersion: 1 + Math.floor(r() * 3),
      recipe: chance(0.7) ? policy : EARLIER_POLICY,
      expiresAt: NOW + (chance(0.6) ? HOUR : -HOUR),
      members: pairs.filter(() => chance(0.4)).slice(0, 4),
      appKnown: chance(0.75),
    }),
  );
  const pins = new Map<string, CatalogIntentPin[]>();
  const prior = new Map<string, CatalogPriorPin[]>();
  const ready = new Map<string, boolean>();
  for (const intent of intents) {
    ready.set(intent.intentId, chance(0.7));
    const own: CatalogIntentPin[] = [];
    const earlier: CatalogPriorPin[] = [];
    for (const m of intent.members) {
      // A pin names a rendition of the member's asset, so only of a pair
      // App has a row for.
      if (!appAssets.has(key(m.mediaId, m.objectKey))) continue;
      for (const want of catalogExpectedRenditions(m.width, m.height)) {
        if (chance(0.8))
          own.push({
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
          earlier.push({
            rendition_id: rid(),
            media_id: m.mediaId,
            object_key: m.objectKey,
          });
      }
    }
    pins.set(intent.intentId, own);
    prior.set(intent.intentId, earlier);
  }
  return { pairs, published, intents, appAssets, selector, pins, prior, ready };
};

/** Permissions by asset, an exact repeat dropped (as the W1 differential). */
const byAsset = (permissions: readonly CatalogAssetPermission[]) => {
  const assets = new Map<string, CatalogAssetPermission[]>();
  for (const permission of permissions) {
    const list = assets.get(permission.assetId) ?? [];
    if (!list.some((p) => JSON.stringify(p) === JSON.stringify(permission)))
      list.push(permission);
    assets.set(permission.assetId, list);
  }
  return assets;
};
const copySet = (permissions: readonly CatalogAssetPermission[]) =>
  [...new Set(permissions.flatMap((p) => p.renditionIds))].sort();
/** What authorized() grants a fence on these permissions, while the pair is
 * public or not and every private B request still holds. */
const grants = (
  permissions: readonly CatalogAssetPermission[],
  isPublic: boolean,
) =>
  permissions.length > 0 &&
  permissions.some((p) => (p.published && isPublic) || p.intentId !== null);

/** The #320 plan of the whole world (the oracle). */
const oracle = async (w: World) =>
  byAsset(
    await previousCatalogPlan(
      {
        publishedSources: w.published.map((p) => ({
          mediaId: p.mediaId,
          objectKey: p.objectKey,
          width: p.width,
          height: p.height,
        })),
        preparations: partitionCatalogPrepareRows(worldRows(w)).intents,
      },
      readsOf(w),
      policy,
      NOW,
    ),
  );

describe("W5: each asset's capture equals the whole-Catalog oracle", () => {
  const SEEDS = Array.from({ length: 600 }, (_, i) => i + 1);

  it("gives every asset the oracle's permissions for it, but those of intents App does not know, which grant nothing", async () => {
    const reached = {
      assets: 0,
      privateB: 0,
      earlierPolicy: 0,
      currentPolicy: 0,
      livePublic: 0,
      unknownDropped: 0,
      missingAppRow: 0,
      publishedTwice: 0,
    };
    for (const seed of SEEDS) {
      const w = generate(seed);
      const expected = await oracle(w);
      const ids = w.pairs.map((p) => assetOf(p.mediaId, p.objectKey));
      // One call for every asset, as a scope (W7) names many, and one call
      // per asset, as a job names its own: the same plans.
      const batch = await captureCatalogAssets(
        poolsOf(w),
        ids,
        readsOf(w),
        policy,
        NOW,
      );
      const manifestOf = new Map(
        w.intents.map((i) => [sha(`${i.intentId}:manifest`), i]),
      );
      for (const pair of w.pairs) {
        const id = assetOf(pair.mediaId, pair.objectKey);
        const label = `seed ${seed} ${pair.mediaId}`;
        const single = (
          await captureCatalogAssets(poolsOf(w), [id], readsOf(w), policy, NOW)
        ).get(id)!;
        const captured = batch.get(id)!;
        expect(single, label).toEqual(captured);
        const isPublic = w.published.some(
          (p) =>
            key(p.mediaId, p.objectKey) === key(pair.mediaId, pair.objectKey),
        );
        expect(captured.public, label).toBe(
          w.appAssets.has(key(pair.mediaId, pair.objectKey)) && isPublic,
        );
        const all = expected.get(id) ?? [];
        if (!w.appAssets.has(key(pair.mediaId, pair.objectKey))) {
          // No App row (the sync has not created it yet): nothing is
          // planned, and the oracle has nothing to copy for it either.
          expect(captured.pair, label).toBeNull();
          expect(captured.permissions, label).toEqual([]);
          expect(copySet(all), label).toEqual([]);
          reached.missingAppRow += 1;
          continue;
        }
        // The oracle's own permissions of intents App knows, in its order.
        const intentOf = (p: CatalogAssetPermission) =>
          p.documentId === null ? undefined : manifestOf.get(p.manifestSha256);
        const known = all.filter(
          (p) => p.documentId === null || intentOf(p)!.appKnown,
        );
        expect(captured.permissions, label).toEqual(known);
        // An intent App does not know grants this asset nothing: no copy,
        // no private B, and never a different authorization.
        for (const dropped of all.filter((p) => !known.includes(p))) {
          expect(dropped.renditionIds, label).toEqual([]);
          expect(dropped.intentId, label).toBeNull();
          reached.unknownDropped += 1;
        }
        expect(copySet(captured.permissions), label).toEqual(copySet(all));
        expect(grants(captured.permissions, isPublic), label).toBe(
          grants(all, isPublic),
        );
        // Public gating: an unpublished pair is granted only private B.
        if (!isPublic)
          for (const permission of captured.permissions)
            expect(permission.intentId, label).not.toBeNull();
        reached.assets += 1;
        reached.privateB += captured.permissions.filter(
          (p) => p.intentId !== null,
        ).length;
        reached.earlierPolicy += captured.permissions.filter(
          (p) => p.policy === EARLIER_POLICY,
        ).length;
        reached.currentPolicy += captured.permissions.filter(
          (p) => p.intentId === null && p.policy === policy,
        ).length;
        reached.livePublic += captured.permissions.filter(
          (p) => p.documentId === null && p.renditionIds.length > 0,
        ).length;
        if (w.published.filter((p) => p === pair).length > 1)
          reached.publishedTwice += 1;
      }
    }
    // The generated Catalogs reach every kind of permission and difference.
    for (const [kind, count] of Object.entries(reached))
      expect(count, kind).toBeGreaterThan(5);
  });

  it("reads each App-known intent's facts once per call, and never an intent App does not know", async () => {
    let shared = 0;
    for (const seed of SEEDS) {
      const w = generate(seed);
      const log: string[] = [];
      await captureCatalogAssets(
        poolsOf(w),
        w.pairs.map((p) => assetOf(p.mediaId, p.objectKey)),
        readsOf(w, log),
        policy,
        NOW,
      );
      const facts = log.filter((line) => !line.startsWith("renditions"));
      expect(new Set(facts).size, `seed ${seed}`).toBe(facts.length);
      for (const line of facts) {
        const intent = w.intents.find((i) => line.endsWith(i.intentId))!;
        expect(intent.appKnown, `seed ${seed} ${line}`).toBe(true);
        if (
          intent.members.filter((m) =>
            w.appAssets.has(key(m.mediaId, m.objectKey)),
          ).length > 1
        )
          shared += 1;
      }
      // At most one selector statement for the public pairs of the call.
      expect(
        log.filter((line) => line.startsWith("renditions")).length,
        `seed ${seed}`,
      ).toBeLessThanOrEqual(1);
    }
    expect(shared).toBeGreaterThan(20);
  });
});

/** A small hand-built world for the fence: the asset under test, and
 * intents that name it. */
const fenceWorld = () => {
  const subject = pairOf("fence-subject");
  const other = pairOf("fence-other");
  const intent = (
    n: number,
    state: Intent["state"],
    overrides: Partial<Intent> = {},
  ): Intent => ({
    intentId: `00000000-0000-4000-8000-0000000000f${n}`,
    documentId: n,
    state,
    stateVersion: 1,
    recipe: policy,
    expiresAt: NOW + HOUR,
    members: [subject, other],
    appKnown: true,
    ...overrides,
  });
  const w: World = {
    pairs: [subject, other],
    published: [],
    intents: [
      // Live and known: the stamp and the document lock follow it.
      intent(1, "prepared"),
      // Known, ended within R: a header row only, never in a stamp.
      intent(2, "withdrawn"),
      // Unknown to App (prepared after the last sync): never read.
      intent(3, "release_requested", { appKnown: false }),
    ],
    appAssets: new Set([
      key(subject.mediaId, subject.objectKey),
      key(other.mediaId, other.objectKey),
    ]),
    selector: [],
    pins: new Map(),
    prior: new Map(),
    ready: new Map(),
  };
  return {
    w,
    subject,
    assetId: assetOf(subject.mediaId, subject.objectKey),
    intent: (n: number) => w.intents.find((i) => i.intentId.endsWith(`f${n}`))!,
  };
};

describe("W5: the fence re-reads exactly its capture", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("captures and re-reads the App-known live intents by id, and locks only their documents", async () => {
    const f = fenceWorld();
    const pools = poolsOf(f.w, { now: () => Date.now() });
    vi.useFakeTimers({ toFake: ["Date"], now: NOW });
    const authority = createCatalogPublicationAuthority(
      pools.published,
      pools.prepare,
      pools.app,
    );
    const lease = await authority.acquire(f.assetId);
    try {
      const captured = pools.statements.filter(
        (s) => s.sql === catalogLiveIntentRowsSql,
      );
      // The capture: one read of both App-known intents (the live one and
      // the ended one), never of the intent App does not know.
      expect(captured.map((s) => s.values)).toEqual([
        [[f.intent(1).intentId, f.intent(2).intentId]],
      ]);
      // The prepared intent's document is locked, nothing else.
      expect(
        pools.statements
          .filter((s) => s.sql.startsWith("SELECT pg_advisory_xact_lock"))
          .map((s) => s.values),
      ).toEqual([["moya-editorial:document:1"]]);
      // Nothing is permitted: the pair is not public and no intent known to
      // App is requested.
      expect(lease.renditionIds).toEqual([]);
      pools.statements.length = 0;
      expect(await lease.current()).toBe(true);
      // Exactly the capture's statement, with exactly its ids.
      expect(pools.statements).toEqual([
        {
          pool: "prepare",
          sql: catalogLiveIntentRowsSql,
          values: captured[0]!.values,
        },
      ]);
      // The intent App does not know changes; the fence never reads it.
      f.intent(3).stateVersion = 2;
      f.intent(3).state = "released";
      expect(await lease.current()).toBe(true);
      // The ended known intent leaves retention: it was never in the stamp.
      f.w.intents.splice(f.w.intents.indexOf(f.intent(2)), 1);
      expect(await lease.current()).toBe(true);
      // The captured live intent advances: stale.
      f.intent(1).stateVersion = 2;
      expect(await lease.current()).toBe(false);
    } finally {
      await lease.release();
    }
    expect(pools.prepareClients.active).toBe(0);
  });

  it.each([
    [
      "ends",
      (i: Intent) => {
        i.state = "cancelled";
      },
    ],
    [
      "is released",
      (i: Intent) => {
        i.state = "released";
        i.stateVersion = 2;
      },
    ],
    [
      "moves to another document",
      (i: Intent) => {
        i.documentId = 9;
      },
    ],
    ["lapses by the clock", () => vi.setSystemTime(NOW + 2 * HOUR)],
  ] as const)(
    "makes the fence stale when a captured live intent %s",
    async (_, change) => {
      const f = fenceWorld();
      vi.useFakeTimers({ toFake: ["Date"], now: NOW });
      // The CMS view keeps listing the members (as before its own clock
      // passes the lease): the fence's own clock still ends it.
      const pools = poolsOf(f.w);
      const lease = await createCatalogPublicationAuthority(
        pools.published,
        pools.prepare,
        pools.app,
      ).acquire(f.assetId);
      try {
        expect(await lease.current()).toBe(true);
        change(f.intent(1));
        expect(await lease.current()).toBe(false);
        expect(await lease.authorized()).toBe(false);
      } finally {
        await lease.release();
      }
    },
  );

  it("grants nothing for an intent App does not know, however it names the pair", async () => {
    const f = fenceWorld();
    // Only the unknown intent is live and requested, and its facts say
    // ready: it is never read, so nothing is permitted.
    f.w.intents.splice(0, 2);
    (f.w.ready as Map<string, boolean>).set(f.intent(3).intentId, true);
    const pools = poolsOf(f.w);
    const lease = await createCatalogPublicationAuthority(
      pools.published,
      pools.prepare,
      pools.app,
    ).acquire(f.assetId);
    try {
      expect(lease.renditionIds).toEqual([]);
      expect(await lease.authorized()).toBe(false);
      // No App-known intent: no private read at all, and none per check.
      expect(await lease.current()).toBe(true);
      expect(
        pools.statements.some((s) => s.sql === catalogLiveIntentRowsSql),
      ).toBe(false);
    } finally {
      await lease.release();
    }
  });
});

describe("W5: a read error throws, never 'not public' or 'nothing permitted'", () => {
  /** A published subject with a known released intent of an earlier
   * policy (its pins are read) and a selector row. */
  const published = () => {
    const f = fenceWorld();
    f.w.intents.splice(0, 3, {
      ...f.intent(1),
      state: "released",
      recipe: EARLIER_POLICY,
    });
    (f.w.published as Pair[]).push(f.subject);
    const prior = {
      rendition_id: `media-rendition-${"1".repeat(32)}`,
      media_id: f.subject.mediaId,
      object_key: f.subject.objectKey,
    };
    (f.w.prior as Map<string, CatalogPriorPin[]>).set(f.intent(1).intentId, [
      prior,
    ]);
    return f;
  };

  it.each([
    ["the App asset row", "app", "FROM community.catalog_media_assets"],
    [
      "the App-known intents",
      "app",
      "FROM community.catalog_delivery_media_refs",
    ],
    ["the pair check", "cms", "FROM catalog_media"],
    ["the snapshot export", "cms", "pg_export_snapshot"],
    ["the private connection", "prepare.connect", ""],
    ["the live intent rows", "prepare", "catalog_delivery_live_prepare_media"],
    ["the earlier policy's pins", "app", "SELECT pp.rendition_id"],
    ["the selector", "app", "SELECT DISTINCT r.id"],
  ] as const)(
    "acquire throws when %s cannot be read, and holds no fence",
    async (_, pool, text) => {
      const f = published();
      const pools = poolsOf(f.w, { fail: { pool, text } });
      const authority = createCatalogPublicationAuthority(
        pools.published,
        pools.prepare,
        pools.app,
      );
      await expect(authority.acquire(f.assetId)).rejects.toThrow(
        /terminating connection|timeout exceeded/u,
      );
      expect(pools.prepareClients.active).toBe(0);
      // Both lanes' fences are still free.
      const first = await authority.acquire(f.assetId);
      const second = await authority.acquire(f.assetId);
      expect(first.renditionIds).toEqual(second.renditionIds);
      expect(first.renditionIds.length).toBeGreaterThan(0);
      await first.release();
      await second.release();
    },
  );

  it("authorized() throws when the pair check fails, and current() when the private read does", async () => {
    const f = published();
    const statements: { pool: string; sql: string; values: unknown[] }[] = [];
    const options: Parameters<typeof poolsOf>[1] = { statements };
    const pools = poolsOf(f.w, options);
    const lease = await createCatalogPublicationAuthority(
      pools.published,
      pools.prepare,
      pools.app,
    ).acquire(f.assetId);
    try {
      expect(await lease.authorized()).toBe(true);
      options.fail = { pool: "cms", text: "FROM catalog_media" };
      await expect(lease.authorized()).rejects.toMatchObject({
        code: "57P01",
      });
      options.fail = {
        pool: "prepare",
        text: "catalog_delivery_live_prepare_media",
      };
      await expect(lease.current()).rejects.toMatchObject({ code: "57P01" });
      options.fail = {
        pool: "prepare",
        text: "catalog_delivery_live_prepare_media",
      };
      await expect(lease.authorized()).rejects.toMatchObject({
        code: "57P01",
      });
      // Read again, it grants as before.
      expect(await lease.current()).toBe(true);
      expect(await lease.authorized()).toBe(true);
    } finally {
      await lease.release();
    }
  });
});

describe("W5: a job costs the same at any Catalog size", () => {
  /** The published subject with two known live intents (a prepared one
   * and a released one, both of an earlier policy, so only the released
   * one's pins are read) and a selector row, among `size` other published
   * pairs. */
  const world = (size: number) => {
    const f = fenceWorld();
    f.w.intents.splice(
      0,
      3,
      { ...f.intent(1), recipe: EARLIER_POLICY },
      { ...f.intent(2), state: "released", recipe: EARLIER_POLICY },
    );
    const others = Array.from({ length: size }, (_, n) =>
      pairOf(`catalog-${n}`),
    );
    (f.w.published as Pair[]).push(f.subject, ...others);
    (f.w.pairs as Pair[]).push(...others);
    for (const p of others)
      (f.w.appAssets as Set<string>).add(key(p.mediaId, p.objectKey));
    (f.w.selector as CatalogSelectorRendition[]).push(
      ...[f.subject, ...others].map((p, n) => ({
        id: `media-rendition-${n.toString(16).padStart(32, "0")}`,
        media_id: p.mediaId,
        source_object_key: p.objectKey,
        role: "thumb",
        recipe_version: 1,
        recipe_digest: PREVIOUS_DIGEST,
        width: 160,
        height: 107,
        master_width: p.width,
        master_height: p.height,
        state: "ready" as const,
        published: true,
      })),
    );
    return f;
  };
  const measure = async (size: number) => {
    const f = world(size);
    const pools = poolsOf(f.w);
    const authority = createCatalogPublicationAuthority(
      pools.published,
      pools.prepare,
      pools.app,
    );
    const counts = () => {
      const byPool: Record<string, number> = {};
      for (const s of pools.statements)
        byPool[s.pool] = (byPool[s.pool] ?? 0) + 1;
      const statements = [...pools.statements];
      pools.statements.length = 0;
      return { byPool, statements };
    };
    const lease = await authority.acquire(f.assetId);
    const acquire = counts();
    expect(await lease.current()).toBe(true);
    const current = counts();
    expect(await lease.authorized()).toBe(true);
    const authorized = counts();
    await lease.release();
    return { acquire, current, authorized, renditionIds: lease.renditionIds };
  };

  it("issues the same statements for one asset among 10 or 20,000 published images, and never lists the Catalog", async () => {
    const small = await measure(10);
    const large = await measure(20_000);
    for (const op of ["acquire", "current", "authorized"] as const) {
      expect(large[op].byPool, op).toEqual(small[op].byPool);
      expect(
        large[op].statements.map((s) => s.sql),
        op,
      ).toEqual(small[op].statements.map((s) => s.sql));
      for (const s of large[op].statements) {
        // No cursor, no listing of the published Catalog or a private view.
        expect(s.sql, op).not.toMatch(/DECLARE|FETCH|ORDER BY media_id/u);
        if (s.pool === "prepare" && s.sql.startsWith("SELECT *"))
          expect(s.sql, op).toBe(catalogLiveIntentRowsSql);
        if (s.sql.includes("FROM community.catalog_delivery_media_refs"))
          expect(s.sql, op).toContain("WHERE asset_id=ANY(");
        // Every bound list names this asset's own facts only.
        for (const value of s.values)
          if (Array.isArray(value)) expect(value.length, op).toBeLessThan(5);
      }
    }
    expect(large.renditionIds).toEqual(small.renditionIds);
    // App: the asset row, its known intents, one intent's pins, the
    // selector; CMS: the pair check in an exported snapshot; prepare: the
    // intents' live rows in that snapshot, then the fence and its two
    // document locks.
    expect(small.acquire.byPool).toEqual({ app: 4, cms: 4, prepare: 8 });
    expect(small.current.byPool).toEqual({ prepare: 1 });
    expect(small.authorized.byPool).toEqual({ prepare: 1, cms: 1 });
  });
});

describe("W5: the publication adapter plans a Catalog subject from its own job's fence only", () => {
  const NOW_DATE = new Date(NOW);
  const subject = assetOf("synthetic-adapter", "editorial/synthetic.jpg");
  const rid = (n: number) =>
    `media-rendition-${n.toString(16).padStart(32, "0")}`;
  const harness = () => {
    const statements: { sql: string; values: readonly unknown[] }[] = [];
    const asset = {
      id: "a".repeat(32),
      item_id: null,
      catalog_asset_id: subject,
      desired_seq: "1",
      lease_job_id: null,
      lease_job_owner: null,
      lease_sequence: null,
      lease_expires_at: null,
    };
    const query = vi.fn(
      async (sql: string, values: readonly unknown[] = []) => {
        statements.push({ sql, values });
        const rows = sql.startsWith("SELECT id FROM community.publishing_jobs")
          ? [{ id: "synthetic-job" }]
          : sql.startsWith("SELECT a.* FROM community.media_public_assets") ||
              sql.startsWith("SELECT * FROM community.media_public_assets")
            ? [asset]
            : sql.startsWith("SELECT sweep_cursor")
              ? [{ sweep_cursor: null, policy_digest: policy }]
              : [];
        return { rows, rowCount: rows.length };
      },
    );
    const leases: {
      renditionIds: string[];
      authorized: ReturnType<typeof vi.fn>;
      released: boolean;
    }[] = [];
    const planScope = vi.fn(async () => ({
      policy,
      plans: new Map<string, readonly string[]>(),
      failed: [],
    }));
    const port = new PostgresMediaPublicationAdapter(
      {
        query,
        connect: vi.fn(async () => ({ query, release: vi.fn() })),
      } as unknown as ConstructorParameters<
        typeof PostgresMediaPublicationAdapter
      >[0],
      {
        isPublic: () => true,
        allowPublish: () => true,
        catalogAuthority: {
          planScope,
          publishedAssetIds: async () => [],
          // Each acquire is its own capture, with its own rendition ID.
          acquire: async () => {
            const lease = {
              renditionIds: [rid(leases.length + 1)],
              authorized: vi.fn(async () => true),
              released: false,
            };
            leases.push(lease);
            return {
              renditionIds: lease.renditionIds,
              current: async () => !lease.released,
              authorized: lease.authorized,
              release: async () => {
                lease.released = true;
              },
            };
          },
        },
      },
    );
    /** The Catalog IDs the last desired-set statement bound. */
    const lastDesired = () =>
      statements
        .filter(({ sql }) => sql.startsWith("SELECT d.* FROM ("))
        .at(-1)!.values[2];
    return { port, statements, leases, planScope, lastDesired };
  };
  const job = (id: string): PublishingJobLease => ({
    id,
    leaseOwner: `owner-${id}`,
  });

  it("keeps a job's desired set its own capture while another job on the same asset holds and releases its fence", async () => {
    const h = harness();
    const publish = await h.port.planPublish(subject, job("a"), NOW_DATE);
    expect(publish.status).toBe("ready");
    expect(h.lastDesired()).toEqual([rid(1)]);
    // The withdraw lane captures the same asset meanwhile.
    const withdraw = await h.port.planWithdrawal(subject, job("b"), NOW_DATE);
    expect(withdraw.status).toBe("ready");
    expect(h.lastDesired()).toEqual([rid(2)]);
    if (publish.status !== "ready" || withdraw.status !== "ready")
      throw new Error("unreachable");
    // The publish job's fence check binds its own capture, not the other's.
    expect(await h.port.isCurrent(publish.fence, NOW_DATE)).toBe(true);
    expect(h.lastDesired()).toEqual([rid(1)]);
    // The other job releases its fence: the publish job keeps its own, and
    // never reads the whole Catalog's copy set.
    await h.port.release(withdraw.fence, NOW_DATE);
    expect(await h.port.isCurrent(publish.fence, NOW_DATE)).toBe(true);
    expect(h.lastDesired()).toEqual([rid(1)]);
    expect(await h.port.finishPublish(publish.fence, NOW_DATE)).toBe(true);
    expect(h.lastDesired()).toEqual([rid(1)]);
    expect(h.leases[0]!.authorized.mock.calls.length).toBeGreaterThanOrEqual(3);
    await h.port.release(publish.fence, NOW_DATE);
    expect(h.planScope).not.toHaveBeenCalled();
    // Only the reconcile plans, and only its scope (W7).
    await h.port.reconcile(NOW_DATE, true, 10);
    expect(h.planScope).toHaveBeenCalledTimes(1);
  });

  it("refuses a Catalog subject's desired set without its job's fence instead of planning the whole Catalog", async () => {
    const h = harness();
    const desired = (
      h.port as unknown as {
        desired(
          db: unknown,
          asset: unknown,
          allow: boolean,
          job: PublishingJobLease,
        ): Promise<unknown>;
      }
    ).desired.bind(h.port);
    const db = { query: async () => ({ rows: [], rowCount: 0 }) };
    await expect(
      desired(db, { item_id: null, catalog_asset_id: subject }, true, job("x")),
    ).rejects.toThrow("Catalog subject holds no source fence");
    // Another subject's fence is not this subject's.
    const other = await h.port.planWithdrawal(subject, job("y"), NOW_DATE);
    expect(other.status).toBe("ready");
    await expect(
      desired(
        db,
        {
          item_id: null,
          catalog_asset_id: assetOf("synthetic-other", "editorial/other.jpg"),
        },
        true,
        job("y"),
      ),
    ).rejects.toThrow("Catalog subject holds no source fence");
    expect(h.planScope).not.toHaveBeenCalled();
    // A withdrawal while the Catalog is not public needs no plan at all.
    expect(
      await desired(
        db,
        { item_id: null, catalog_asset_id: subject },
        false,
        job("x"),
      ),
    ).toEqual([]);
  });
});

/** One world of many generated ones (their names, intents and renditions
 * never collide), for scopes of several batches. */
const mergeWorlds = (worlds: readonly World[]): World => ({
  pairs: worlds.flatMap((w) => w.pairs),
  published: worlds.flatMap((w) => w.published),
  intents: worlds.flatMap((w) => w.intents),
  appAssets: new Set(worlds.flatMap((w) => [...w.appAssets])),
  selector: worlds.flatMap((w) => w.selector),
  pins: new Map(worlds.flatMap((w) => [...w.pins])),
  prior: new Map(worlds.flatMap((w) => [...w.prior])),
  ready: new Map(worlds.flatMap((w) => [...w.ready])),
});

describe("W7: a scoped reconcile pass plans its scope as each asset's own capture", () => {
  const world = mergeWorlds(
    Array.from({ length: 60 }, (_, i) => generate(1_000 + i)),
  );
  const ids = world.pairs.map((p) => assetOf(p.mediaId, p.objectKey));
  const capture = async (id: string) =>
    (
      await captureCatalogAssets(poolsOf(world), [id], readsOf(world), policy)
    ).get(id)!;
  const BUDGET = { budgetMs: 60_000 };

  it("plans a scope of several batches as each asset's capture, one CMS check a batch, each intent's facts read once", async () => {
    expect(ids.length).toBeGreaterThan(2 * CATALOG_SCOPE_BATCH);
    // An intent whose facts the plan reads, with two members that have App
    // rows, one first in the scope and the other first in its second batch.
    const shared = world.intents.find(
      (intent) =>
        intent.appKnown &&
        intent.recipe === policy &&
        ["prepared", "release_requested", "released"].includes(intent.state) &&
        intent.expiresAt > NOW &&
        intent.members.filter(
          (m) =>
            world.appAssets.has(key(m.mediaId, m.objectKey)) &&
            world.published.includes(m),
        ).length > 1,
    )!;
    const [a, b] = shared.members
      .filter(
        (m) =>
          world.appAssets.has(key(m.mediaId, m.objectKey)) &&
          world.published.includes(m),
      )
      .map((m) => assetOf(m.mediaId, m.objectKey));
    const rest = ids.filter((id) => id !== a && id !== b);
    const order = [
      a!,
      ...rest.slice(0, CATALOG_SCOPE_BATCH - 1),
      b!,
      ...rest.slice(CATALOG_SCOPE_BATCH - 1),
    ];
    const statements: { pool: string; sql: string; values: unknown[] }[] = [];
    const log: string[] = [];
    const { plans, failed } = await planCatalogScope(
      poolsOf(world, { statements }),
      order,
      readsOf(world, log),
      policy,
      BUDGET,
    );
    expect(failed).toEqual([]);
    expect([...plans.keys()]).toEqual(order);
    let granted = 0;
    for (const id of ids) {
      const expected = copySet((await capture(id)).permissions);
      expect([...plans.get(id)!].sort(), id).toEqual(expected);
      if (expected.length) granted += 1;
    }
    expect(granted).toBeGreaterThan(50);
    // One pair check per batch, never the published list.
    expect(
      statements.filter(({ sql }) => sql === publishedCatalogPairsSql),
    ).toHaveLength(Math.ceil(ids.length / CATALOG_SCOPE_BATCH));
    // Each intent's facts once per pass, the shared one's too.
    const facts = log.filter((line) => !line.startsWith("renditions"));
    expect(new Set(facts).size).toBe(facts.length);
    expect(log).toContain(`inspect ${shared.intentId}`);
  });

  it("captures a failed batch again asset by asset: only the asset whose plan throws is excluded", async () => {
    // A public asset with an App row; its own read fails every time.
    const target = world.pairs.find(
      (p) =>
        world.appAssets.has(key(p.mediaId, p.objectKey)) &&
        world.published.includes(p),
    )!;
    const targetId = assetOf(target.mediaId, target.objectKey);
    const pools = poolsOf(world);
    const appQuery = (
      pools.app as unknown as {
        query(sql: string, values?: unknown[]): Promise<unknown>;
      }
    ).query;
    const app = {
      query: async (sql: string, values: unknown[] = []) => {
        if (
          sql.startsWith(
            "SELECT id,media_id,source_object_key FROM community.catalog_media_assets",
          ) &&
          (values[0] as string[]).includes(targetId)
        )
          throw Object.assign(new Error("terminating connection"), {
            code: "57P01",
          });
        return appQuery(sql, values);
      },
    } as unknown as typeof pools.app;
    const { plans, failed } = await planCatalogScope(
      { ...pools, app },
      ids,
      readsOf(world),
      policy,
      BUDGET,
    );
    expect(failed).toEqual([targetId]);
    expect([...plans.keys()]).toEqual(ids.filter((id) => id !== targetId));
    for (const id of ids.slice(0, 2 * CATALOG_SCOPE_BATCH))
      if (id !== targetId)
        expect([...plans.get(id)!].sort(), id).toEqual(
          copySet((await capture(id)).permissions),
        );
    // A read that fails once is captured again with the rest: nothing fails.
    const once = await planCatalogScope(
      poolsOf(world, { fail: { pool: "prepare", text: "intent_id=ANY(" } }),
      ids,
      readsOf(world),
      policy,
      BUDGET,
    );
    expect(once.failed).toEqual([]);
    expect(once.plans.size).toBe(ids.length);
  });

  it("fails the pass when every asset attempted fails, as the whole-Catalog plan did", async () => {
    const pools = poolsOf(world);
    const app = {
      query: async () => {
        throw Object.assign(new Error("permission denied"), { code: "42501" });
      },
    } as unknown as typeof pools.app;
    await expect(
      planCatalogScope({ ...pools, app }, ids, readsOf(world), policy, BUDGET),
    ).rejects.toThrow("permission denied");
  });

  it("starts a batch only while the longest one so far fits the budget, so the assets attempted are a prefix", async () => {
    // Each clock reading is 10 ms later, so each batch takes 10 ms: the
    // second starts at 30 ms (plus 10 fits in 45), the third would end at
    // 60 ms and does not start.
    let ms = 0;
    const clock = () => (ms += 10);
    const { plans, failed } = await planCatalogScope(
      poolsOf(world),
      ids,
      readsOf(world),
      policy,
      { budgetMs: 45, clock },
    );
    expect(failed).toEqual([]);
    expect([...plans.keys()]).toEqual(ids.slice(0, 2 * CATALOG_SCOPE_BATCH));
  });

  it("attempts the reserved assets whatever the budget, then stops as before", async () => {
    // Each clock reading is 10 ms later: a budget of 15 ms admits one batch
    // alone. With 150 reserved assets the first two batches run, and the
    // third does not start.
    let ms = 0;
    const clock = () => (ms += 10);
    const { plans, failed } = await planCatalogScope(
      poolsOf(world),
      ids,
      readsOf(world),
      policy,
      { budgetMs: 15, reserved: CATALOG_SCOPE_BATCH + 50, clock },
    );
    expect(failed).toEqual([]);
    expect([...plans.keys()]).toEqual(ids.slice(0, 2 * CATALOG_SCOPE_BATCH));
  });

  it("retries a failed reserved batch asset by asset past the budget, but only about one batch past it", async () => {
    // The clock moves only as the App reads a capture's assets (its first
    // statement), by `cost` of how many it names, which then fails with
    // `error` when one is given.
    let ms = 0;
    const clock = () => ms;
    const timed = (
      cost: (assets: number) => number,
      options: {
        readonly fail?: { readonly pool: string; readonly text: string };
        readonly error?: Error;
      },
    ) => {
      const pools = poolsOf(world, { fail: options.fail });
      const appQuery = (
        pools.app as unknown as {
          query(sql: string, values?: unknown[]): Promise<unknown>;
        }
      ).query;
      const app = {
        query: async (sql: string, values: unknown[] = []) => {
          if (
            sql.startsWith(
              "SELECT id,media_id,source_object_key FROM community.catalog_media_assets",
            )
          ) {
            ms += cost((values[0] as string[]).length);
            if (options.error) throw options.error;
          }
          return appQuery(sql, values);
        },
      } as unknown as typeof pools.app;
      return { ...pools, app };
    };
    // A reserved batch whose capture takes 1,000 ms (past the 150 ms budget)
    // and throws once is captured again asset by asset, each in 1 ms (its
    // intents' facts were read once this pass): all of it, within the budget
    // plus that batch.
    const retried = await planCatalogScope(
      timed((assets) => (assets === 1 ? 1 : 10 * assets), {
        fail: { pool: "prepare", text: "intent_id=ANY(" },
      }),
      ids.slice(0, CATALOG_SCOPE_BATCH),
      readsOf(world),
      policy,
      { budgetMs: 150, reserved: CATALOG_SCOPE_BATCH, clock },
    );
    expect(retried.failed).toEqual([]);
    expect([...retried.plans.keys()]).toEqual(
      ids.slice(0, CATALOG_SCOPE_BATCH),
    );
    expect(ms).toBe(10 * CATALOG_SCOPE_BATCH + CATALOG_SCOPE_BATCH);
    // An outage: every capture fails after 10 ms (a connect that times out).
    // The two reserved batches are not retried 200 times: the first batch's
    // retries go on past the 50 ms budget by about that batch and end the
    // pass, which fails as every asset it attempted did.
    ms = 0;
    await expect(
      planCatalogScope(
        timed(() => 10, {
          error: new Error("timeout exceeded when trying to connect"),
        }),
        ids,
        readsOf(world),
        policy,
        { budgetMs: 50, reserved: 2 * CATALOG_SCOPE_BATCH, clock },
      ),
    ).rejects.toThrow("timeout exceeded when trying to connect");
    expect(ms).toBeGreaterThan(50);
    expect(ms).toBeLessThanOrEqual(50 + 10 + 10);
  });

  it("refuses an asset id or a budget it cannot plan", async () => {
    await expect(
      planCatalogScope(
        poolsOf(world),
        ["catalog-asset-x"],
        readsOf(world),
        policy,
        BUDGET,
      ),
    ).rejects.toThrow(TypeError);
    await expect(
      planCatalogScope(poolsOf(world), ids, readsOf(world), policy, {
        budgetMs: 0,
      }),
    ).rejects.toThrow(TypeError);
    for (const reserved of [-1, 1.5, Number.NaN])
      await expect(
        planCatalogScope(poolsOf(world), ids, readsOf(world), policy, {
          ...BUDGET,
          reserved,
        }),
      ).rejects.toThrow(TypeError);
    // Nothing named, nothing read.
    const statements: { pool: string; sql: string; values: unknown[] }[] = [];
    expect(
      (
        await planCatalogScope(
          poolsOf(world, { statements }),
          [],
          readsOf(world),
          policy,
          BUDGET,
        )
      ).plans.size,
    ).toBe(0);
    expect(statements).toEqual([]);
  });

  it("leaves no whole-Catalog plan in the production authority", () => {
    // The whole Catalog's copy set is the tests' oracle (catalog-copy-set.ts)
    // only: what production builds plans a scope, a job or a read.
    const pools = poolsOf(world);
    expect(
      Object.keys(
        createCatalogPublicationAuthority(
          pools.published,
          pools.prepare,
          pools.app,
        ),
      ).sort(),
    ).toEqual(["acquire", "planScope", "publishedAssetIds"]);
  });
});
