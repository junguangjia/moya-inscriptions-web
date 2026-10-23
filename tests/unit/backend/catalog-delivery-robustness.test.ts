import { createHash } from "node:crypto";

import {
  catalogExpectedRenditions,
  createCatalogPublicationAuthority,
  currentCatalogRecipePolicy,
  parseCatalogPrepareDatabaseConfig,
  readCatalogSourceSnapshot,
} from "@moya/backend-production/internal/catalog-delivery";
import { createCatalogSync } from "@moya/backend-production/internal/publishing-catalog";
import {
  parseCatalogPrepareRows,
  partitionCatalogPrepareRows,
  readCatalogDeliveryProjection,
  synchronizeCatalogDeliveryIntents,
} from "@moya/community-postgres";
import { describe, expect, it, vi } from "vitest";

import { snapshotCursors } from "./catalog-snapshot-cursor.js";

/*
 * catalog-delivery-release-hardening-v1 (Issue #317), group g3:
 * N3 a recipe bump keeps the last published set desired and served, for every
 *    role at once, until the current recipe's set is complete and published;
 * F3 an intent that would revive its local tombstone is refused alone, and the
 *    sync logs it; a live one whose immutable identity drifted is skipped
 *    alone and its mirror left as it is, while a drifted one that is over is
 *    refused and tombstoned;
 * F7 one undecodable intent (an edge beyond 65,535 px) never fails the
 *    snapshot, plans or sync of the others, and an undecodable intent (even
 *    every intent at once) leaves its App mirror untouched;
 * F6 held publication fences never starve snapshot reads or the other lane;
 * W3 (catalog-scale-v1) a fence re-reads the live projection its snapshot was
 *    captured from, so an intent past retention never makes it busy.
 * Synthetic metadata only; no database, object store or network.
 */

type Authority = typeof createCatalogPublicationAuthority;
type Row = Record<string, unknown>;

const md5 = (value: string) => createHash("md5").update(value).digest("hex");
const assetOf = (mediaId: string, objectKey: string) =>
  `catalog-asset-${md5(`${mediaId}:${objectKey}`)}`;
const rid = (n: number) =>
  `media-rendition-${n.toString(16).padStart(32, "0")}`;
const PREVIOUS_DIGEST = "0".repeat(16);
const policy = currentCatalogRecipePolicy().recipeManifestSha256;

interface Source {
  readonly media_id: string;
  readonly object_key: string;
  readonly width: number;
  readonly height: number;
}
const editorialSource = (name: string, width: number, height: number) => ({
  media_id: `synthetic-${name}`,
  object_key: `editorial/${"a".repeat(64)}/${"b".repeat(64)}-${createHash(
    "sha256",
  )
    .update(name)
    .digest("hex")}.jpg`,
  width,
  height,
});

/** App rendition rows of a source (the plan's selector query): the current
 * recipe, or a previous one; ready and published unless stated otherwise. */
const renditionRows = (
  source: Source,
  start: number,
  recipe: "current" | "previous",
  roles?: readonly string[],
  facts: {
    readonly state?: "ready" | "released" | "superseded";
    readonly published?: boolean;
  } = {},
) =>
  catalogExpectedRenditions(source.width, source.height)
    .filter((want) => !roles || roles.includes(want.role))
    .map((want, i) => ({
      id: rid(start + i),
      media_id: source.media_id,
      source_object_key: source.object_key,
      master_width: source.width,
      master_height: source.height,
      role: want.role,
      recipe_version: want.version,
      recipe_digest: recipe === "current" ? want.digest : PREVIOUS_DIGEST,
      width: want.width,
      height: want.height,
      state: facts.state ?? "ready",
      published: facts.published ?? true,
    }));

/** One CMS view row per member, as public.catalog_delivery_prepare_media. */
const intentRows = (
  intentId: string,
  state: string,
  members: readonly Source[],
  documentId = 1,
): Row[] =>
  members.map((member, i) => ({
    intent_id: intentId,
    catalog_document_id: documentId,
    catalog_id: `synthetic-catalog-${documentId}`,
    draft_revision: 1,
    draft_fingerprint: "a".repeat(64),
    media_manifest_sha256: "b".repeat(64),
    recipe_manifest_sha256: policy,
    state,
    state_version: 1,
    media_count: members.length,
    expires_at: "2126-10-20T00:00:00.000Z",
    media_ordinal: i + 1,
    media_id: member.media_id,
    object_key: member.object_key,
    source_sha256: "c".repeat(64),
    width: member.width,
    height: member.height,
  }));

/**
 * Public, private (prepare) and App pools over synthetic rows. The prepare
 * pool hands out at most `max` clients at once and refuses one more the way a
 * node-postgres pool times out.
 */
const world = (options: {
  readonly published: readonly Source[];
  readonly privateRows?: readonly Row[];
  /** Rows of intents that ended past retention R: in the full prepare view
   * only, never in the live projection (CMS migration M2). */
  readonly retiredRows?: readonly Row[];
  /** The intents App mirror members still name, by asset. */
  readonly appIntentIds?: Readonly<Record<string, readonly string[]>>;
  readonly prepareMax?: number | null;
}) => {
  let publicRows: Row[] = [];
  const publicCursors = snapshotCursors((sql) =>
    sql.includes("FROM catalog_media") ? options.published : undefined,
  );
  const publishedQuery = vi.fn(async (sql: string) => {
    const cursor = publicCursors(sql);
    if (cursor) return cursor;
    if (sql.includes("clock_timestamp()"))
      return { rows: [{ at: new Date("2026-10-21T00:00:00.000Z") }] };
    if (sql.includes("pg_export_snapshot()"))
      return { rows: [{ id: "aaa-bbb-ccc" }] };
    if (sql.includes("FROM catalog_media"))
      return { rows: [...options.published] };
    if (["BEGIN", "ROLLBACK"].some((prefix) => sql.startsWith(prefix)))
      return { rows: [] };
    throw new Error("UNEXPECTED_PUBLIC_SQL");
  });
  const published = {
    query: publishedQuery,
    connect: async () => ({ query: publishedQuery, release: () => undefined }),
  } as unknown as Parameters<Authority>[0];
  const privateRows = options.privateRows ?? [];
  const privateCursors = snapshotCursors((sql) =>
    sql.startsWith("SELECT * FROM public.catalog_delivery_live_prepare_media")
      ? privateRows
      : undefined,
  );
  const privateQuery = async (sql: string, values?: readonly unknown[]) => {
    const cursor = privateCursors(sql);
    if (cursor) return cursor;
    if (sql.startsWith("SELECT DISTINCT intent_id")) {
      const [ids, assetId] = values as [string[], string];
      // The fence's re-read names its view: the live projection holds the
      // snapshot's rows, the full view every retired intent beside them.
      const viewRows = sql.includes(
        " FROM public.catalog_delivery_live_prepare_media ",
      )
        ? privateRows
        : sql.includes(" FROM public.catalog_delivery_prepare_media ")
          ? [...privateRows, ...(options.retiredRows ?? [])]
          : undefined;
      if (viewRows === undefined) throw new Error("UNEXPECTED_PRIVATE_SQL");
      const headers = new Map<string, Row>();
      for (const row of viewRows)
        if (
          ids.includes(row.intent_id as string) ||
          (row.media_ordinal !== null &&
            assetOf(row.media_id as string, row.object_key as string) ===
              assetId)
        )
          headers.set(row.intent_id as string, {
            intent_id: row.intent_id,
            catalog_document_id: row.catalog_document_id,
            state: row.state,
            state_version: row.state_version,
            media_manifest_sha256: row.media_manifest_sha256,
            recipe_manifest_sha256: row.recipe_manifest_sha256,
            expires_at: row.expires_at,
          });
      return { rows: [...headers.values()] };
    }
    if (
      ["BEGIN", "ROLLBACK", "SET ", "SELECT pg_advisory_xact_lock"].some(
        (prefix) => sql.startsWith(prefix),
      )
    )
      return { rows: [] };
    throw new Error("UNEXPECTED_PRIVATE_SQL");
  };
  const capacity = { active: 0, peak: 0, refused: 0 };
  const prepare =
    options.prepareMax === null
      ? null
      : ({
          connect: async () => {
            if (capacity.active >= (options.prepareMax ?? 4)) {
              capacity.refused += 1;
              throw new Error("timeout exceeded when trying to connect");
            }
            capacity.active += 1;
            capacity.peak = Math.max(capacity.peak, capacity.active);
            let released = false;
            return {
              query: privateQuery,
              release: () => {
                if (!released) capacity.active -= 1;
                released = true;
              },
            };
          },
        } as unknown as NonNullable<Parameters<Authority>[1]>);
  const appQuery = vi.fn(async (sql: string, values?: readonly unknown[]) => {
    if (sql.startsWith("SELECT DISTINCT r.id")) return { rows: publicRows };
    if (sql.startsWith("SELECT DISTINCT intent_id"))
      return {
        rows: (options.appIntentIds?.[values![0] as string] ?? []).map(
          (intent_id) => ({ intent_id }),
        ),
      };
    throw new Error("UNEXPECTED_APP_SQL");
  });
  const app = { query: appQuery } as unknown as Parameters<Authority>[2];
  return {
    authority: createCatalogPublicationAuthority(published, prepare, app),
    published,
    prepare,
    capacity,
    setRows: (rows: Row[]) => {
      publicRows = rows;
    },
  };
};

const sorted = (ids: readonly string[]) => [...ids].sort();
const idsOf = (rows: readonly { readonly id: string }[]) =>
  sorted(rows.map(({ id }) => id));

describe("N3: a recipe bump keeps the last published set desired", () => {
  const source = editorialSource("live", 4096, 2731);

  it("keeps every ready rendition desired while the current recipe's set is incomplete", async () => {
    const w = world({ published: [source], prepareMax: null });
    const previous = renditionRows(source, 1, "previous");
    expect(previous).toHaveLength(4);
    w.setRows(previous);
    // Reconcile withdraws exactly the published renditions missing from this
    // selector; the previous set stays in it until replacement exists.
    expect(sorted(await w.authority.copyRenditionIds())).toEqual(
      idsOf(previous),
    );
    // Part of the new set is ready (one ready rendition per role slot): the
    // remaining previous renditions still stay desired with it.
    const thumb = renditionRows(source, 10, "current", ["thumb"]);
    const mixed = [...thumb, ...previous.filter((r) => r.role !== "thumb")];
    w.setRows(mixed);
    expect(sorted(await w.authority.copyRenditionIds())).toEqual(idsOf(mixed));
  });

  it("retires the previous set only once the current recipe's set is complete", async () => {
    const w = world({ published: [source], prepareMax: null });
    const current = renditionRows(source, 20, "current");
    w.setRows(current);
    expect(sorted(await w.authority.copyRenditionIds())).toEqual(
      idsOf(current),
    );
    // A smaller image whose current plan omits the viewer: the previous
    // recipe's viewer stays ready (nothing replaces its slot) but is retired
    // once thumb, cover and display are current.
    const small = editorialSource("small", 1000, 800);
    expect(
      catalogExpectedRenditions(small.width, small.height).map((r) => r.role),
    ).toEqual(["thumb", "cover", "display"]);
    const s = world({ published: [small], prepareMax: null });
    const staleViewer = {
      ...renditionRows(small, 30, "previous", ["display"])[0]!,
      id: rid(39),
      role: "viewer",
      width: 1000,
      height: 800,
    };
    const previous = [...renditionRows(small, 30, "previous"), staleViewer];
    s.setRows(previous);
    expect(sorted(await s.authority.copyRenditionIds())).toEqual(
      idsOf(previous),
    );
    const replaced = [...renditionRows(small, 40, "current"), staleViewer];
    s.setRows(replaced);
    expect(sorted(await s.authority.copyRenditionIds())).toEqual(
      idsOf(renditionRows(small, 40, "current")),
    );
  });

  it("keeps the released set still published desired until its replacement is published", async () => {
    const w = world({ published: [source], prepareMax: null });
    // The re-render recorded the current set: each slot's previous rendition
    // is released at once, but it is still the published copy.
    const previous = renditionRows(source, 1, "previous", undefined, {
      state: "released",
    });
    const fresh = renditionRows(source, 20, "current", undefined, {
      published: false,
    });
    w.setRows([...previous, ...fresh]);
    // Reconcile copies the replacement and withdraws nothing it serves.
    expect(sorted(await w.authority.copyRenditionIds())).toEqual(
      idsOf([...previous, ...fresh]),
    );
    // Partly published (a copy in flight) is not yet a replacement.
    w.setRows([
      ...previous,
      ...renditionRows(source, 20, "current", ["thumb", "cover"]),
      ...renditionRows(source, 22, "current", ["display", "viewer"], {
        published: false,
      }),
    ]);
    expect(sorted(await w.authority.copyRenditionIds())).toEqual(
      idsOf([...previous, ...fresh]),
    );
    // Published: only now is the previous set retired.
    const current = renditionRows(source, 20, "current");
    w.setRows([...previous, ...current]);
    expect(sorted(await w.authority.copyRenditionIds())).toEqual(
      idsOf(current),
    );
    // A released rendition that is no longer published is never desired
    // again.
    const unpublished = renditionRows(source, 40, "previous", ["thumb"], {
      state: "released",
      published: false,
    });
    w.setRows([...unpublished, ...fresh]);
    expect(sorted(await w.authority.copyRenditionIds())).toEqual(idsOf(fresh));
  });

  // The previous set was rendered long ago; the re-render records the
  // current set and releases (or supersedes) each slot's previous rendition
  // in one transaction, at the same instant.
  const RENDERED = "2026-10-01T00:00:00.000Z";
  const BUMP = "2026-10-21T00:00:00.000Z";
  const projection = () => {
    let rows: Row[] = [];
    const pool = {
      query: async () => ({ rows }),
    } as unknown as Parameters<typeof readCatalogDeliveryProjection>[0];
    /** Published App rows of a set (the projection only reads published). */
    const asRows = (
      set: ReturnType<typeof renditionRows>,
      state: "ready" | "released" | "superseded" = "ready",
      times: { readonly created?: string; readonly replaced?: string } = {},
    ): Row[] =>
      set.map((r) => ({
        media_id: source.media_id,
        source_object_key: source.object_key,
        master_sha256: "d".repeat(64),
        source_sha256: "d".repeat(64),
        master_width: source.width,
        master_height: source.height,
        rendition_id: r.id,
        rendition_state: state,
        rendition_created_at: new Date(
          times.created ??
            (r.recipe_digest === PREVIOUS_DIGEST ? RENDERED : BUMP),
        ),
        rendition_replaced_at:
          state === "ready" ? null : new Date(times.replaced ?? BUMP),
        role: r.role,
        recipe_version: r.recipe_version,
        recipe_digest: r.recipe_digest,
        width: r.width,
        height: r.height,
        content_type: "image/webp",
        approved_intent: null,
      }));
    const read = async (set: Row[]) => {
      rows = set;
      return (
        await readCatalogDeliveryProjection(
          pool,
          [{ mediaId: source.media_id, objectKey: source.object_key }],
          catalogExpectedRenditions,
        )
      )
        .get(JSON.stringify([source.media_id, source.object_key]))
        ?.renditions?.map(({ key }) => key)
        .sort();
    };
    return { asRows, read };
  };

  it("serves the last published set until the current one is complete and published", async () => {
    const plan = catalogExpectedRenditions(source.width, source.height);
    const { asRows, read } = projection();
    const previous = renditionRows(source, 1, "previous");
    expect(await read(asRows(previous))).toEqual(idsOf(previous));
    const current = renditionRows(source, 20, "current");
    expect(await read(asRows(current))).toEqual(idsOf(current));
    expect(current).toHaveLength(plan.length);
    // Never a partial family.
    expect(
      await read(asRows(previous.filter((r) => r.role !== "display"))),
    ).toBeUndefined();
    // The re-render released the previous set before its replacement was
    // copied (only published rows are read): it keeps serving.
    expect(await read(asRows(previous, "released"))).toEqual(idsOf(previous));
    expect(
      await read([...asRows(previous, "released"), ...asRows(current)]),
    ).toEqual(idsOf(current));
    // A D7 superseded slot serves alike, beside a slot the bump left as it
    // was (its ready rendition predates the re-render).
    expect(
      await read([
        ...asRows(previous, "superseded").filter((r) => r.role !== "thumb"),
        ...asRows(
          current.filter((r) => r.role === "thumb"),
          "ready",
          { created: RENDERED },
        ),
      ]),
    ).toEqual(
      sorted([
        ...previous.filter((r) => r.role !== "thumb").map((r) => r.id),
        current.find((r) => r.role === "thumb")!.id,
      ]),
    );
  });

  it("never serves an early-published replacement beside the previous set", async () => {
    const { asRows, read } = projection();
    const previous = renditionRows(source, 1, "previous");
    const current = renditionRows(source, 20, "current");
    const replaced = asRows(previous, "released");
    // Reconcile copies each replacement as soon as it is desired: one, then
    // three of the four roles are published, the previous set still is.
    for (const roles of [["thumb"], ["thumb", "cover", "display"]])
      expect(
        await read([
          ...replaced,
          ...asRows(current.filter((r) => roles.includes(r.role))),
        ]),
      ).toEqual(idsOf(previous));
    // Two re-renders in flight (cover bumped after thumb, its replacement not
    // yet copied): still the set from before the first of them.
    const later = "2026-10-21T01:00:00.000Z";
    expect(
      await read([
        ...replaced.filter((r) => r.role === "thumb"),
        ...asRows(
          previous.filter((r) => r.role === "cover"),
          "released",
          { replaced: later },
        ),
        ...asRows(
          previous.filter((r) => ["display", "viewer"].includes(r.role)),
        ),
        ...asRows(current.filter((r) => r.role === "thumb")),
      ]),
    ).toEqual(idsOf(previous));
    // A role the current plan adds (a viewer the previous set never had) is
    // not served before the set is complete either.
    const withoutViewer = previous.filter((r) => r.role !== "viewer");
    expect(
      await read([
        ...asRows(withoutViewer, "released"),
        ...asRows(current.filter((r) => ["thumb", "viewer"].includes(r.role))),
      ]),
    ).toEqual(idsOf(withoutViewer));
    // Complete and published: every role switches at once.
    expect(await read([...replaced, ...asRows(current)])).toEqual(
      idsOf(current),
    );
  });

  it("keeps the previous rendition, deterministically, when a slot has two candidates", async () => {
    const { asRows, read } = projection();
    const previous = renditionRows(source, 1, "previous");
    const current = renditionRows(source, 20, "current");
    // Two ready renditions of one slot (the ready-slot unique index rules it
    // out in App; were a replacement recorded before the previous one was
    // released): the earlier, previous one keeps serving.
    expect(
      await read([
        ...asRows(previous),
        ...asRows(current.filter((r) => r.role === "thumb")),
      ]),
    ).toEqual(idsOf(previous));
    // Two released renditions of one slot recorded at the same instant: one
    // is kept by recipe version, then rendition ID, never the image dropped.
    const twin = asRows(previous, "released").map((row) => ({
      ...row,
      rendition_id: `${row.rendition_id as string}-again`,
      recipe_digest: "1".repeat(16),
    }));
    for (const set of [
      [...asRows(previous, "released"), ...twin],
      [...twin, ...asRows(previous, "released")],
    ])
      expect(await read(set)).toEqual(idsOf(previous));
  });
});

describe("F7: one undecodable intent never fails the snapshot of the others", () => {
  const live = editorialSource("live", 4096, 2731);
  const privateB = editorialSource("private-b", 3000, 2000);
  const handscroll = editorialSource("handscroll", 70_000, 1100);
  const valid = "00000000-0000-4000-8000-000000000001";
  const oversized = "00000000-0000-4000-8000-000000000002";
  const privateRows = [
    ...intentRows(valid, "prepared", [privateB], 1),
    // The same B image plus a handscroll beyond the 65,535 px snapshot bound.
    ...intentRows(oversized, "prepared", [privateB, handscroll], 2),
  ];

  it("partitions instead of throwing; the strict exact-intent decode still refuses", () => {
    expect(() => parseCatalogPrepareRows(privateRows)).toThrow();
    const { intents, undecodableIntentIds } =
      partitionCatalogPrepareRows(privateRows);
    expect(intents.map((i) => i.intentId)).toEqual([valid]);
    expect(undecodableIntentIds).toEqual([oversized]);
    expect(() =>
      partitionCatalogPrepareRows([{ ...privateRows[0]!, intent_id: 7 }]),
    ).toThrow("Catalog private source identity invalid");
  });

  it("keeps sync, plans and the fence of every other intent working", async () => {
    const w = world({ published: [live], privateRows });
    w.setRows(renditionRows(live, 1, "current"));
    const snapshot = await readCatalogSourceSnapshot(w.published, w.prepare);
    expect(snapshot?.preparations?.map((i) => i.intentId)).toEqual([valid]);
    expect(snapshot?.undecodableIntentIds).toEqual([oversized]);
    expect(snapshot?.sources.map((s) => s.mediaId).sort()).toEqual(
      [live.media_id, privateB.media_id].sort(),
    );
    expect(sorted(await w.authority.copyRenditionIds())).toEqual(
      idsOf(renditionRows(live, 1, "current")),
    );
    // The rejected intent also names this asset; it grants nothing, so its
    // rows never make the captured fence stale.
    const lease = await w.authority.acquire(
      assetOf(privateB.media_id, privateB.object_key),
    );
    try {
      expect(await lease.current()).toBe(true);
    } finally {
      await lease.release();
    }
    const port = {
      syncCatalogAssets: vi.fn(async () => ({
        referenced: 2,
        skipped: 0,
        created: 0,
        unreferenced: 0,
        enqueued: 0,
      })),
    };
    const logger = { info: vi.fn(), error: vi.fn() };
    await createCatalogSync({
      listSources: async () => [],
      readSnapshot: () => readCatalogSourceSnapshot(w.published, w.prepare),
      port,
      logger,
    }).run(new Date("2026-10-21T00:00:00.000Z"));
    expect(port.syncCatalogAssets).toHaveBeenCalledTimes(1);
    // The store learns which present intents were undecodable, so it leaves
    // their mirror rows as they are instead of tombstoning them.
    expect(
      (
        port.syncCatalogAssets.mock.calls[0] as unknown as [
          unknown,
          unknown,
          { snapshot: { undecodableIntentIds: string[] } },
        ]
      )[2].snapshot.undecodableIntentIds,
    ).toEqual([oversized]);
    expect(logger.error).toHaveBeenCalledWith(
      `[media-worker] catalog sync undecodable intents=1 ids=${oversized}`,
    );
  });

  it("leaves every mirror row untouched when no intent decodes (view or decoder skew)", async () => {
    // Every header carries a state this decoder does not know.
    const skewed = [
      ...intentRows(valid, "prepared_v2", [privateB], 1),
      ...intentRows(oversized, "released_v2", [live], 2),
    ];
    const { intents, undecodableIntentIds } =
      partitionCatalogPrepareRows(skewed);
    expect(intents).toEqual([]);
    expect(undecodableIntentIds).toEqual([valid, oversized]);
    const statements: { sql: string; values: readonly unknown[] }[] = [];
    const db = {
      query: vi.fn(async (sql: string, values: readonly unknown[] = []) => {
        statements.push({ sql, values });
        return { rows: [] };
      }),
    } as unknown as Parameters<typeof synchronizeCatalogDeliveryIntents>[0];
    const result = await synchronizeCatalogDeliveryIntents(
      db,
      intents,
      new Date("2026-10-21T00:05:00.000Z"),
      undecodableIntentIds,
    );
    expect(result).toEqual({
      refused: [],
      mismatched: [],
      undecodable: [valid, oversized],
    });
    const writes = statements.filter(({ sql }) =>
      /^\s*(UPDATE|INSERT INTO) community\.catalog_delivery_(prepares|media_refs)/u.test(
        sql,
      ),
    );
    // Only the absence tombstone runs, and it excludes both present intents.
    expect(writes).toHaveLength(1);
    expect(writes[0]!.sql).toContain("NOT(intent_id::text=ANY($3::text[]))");
    expect(writes[0]!.values[0]).toEqual([]);
    expect(writes[0]!.values[2]).toEqual([valid, oversized]);
    // An intent that fails the schema inside the sync is treated alike.
    statements.length = 0;
    const undecoded = await synchronizeCatalogDeliveryIntents(
      db,
      [{ intentId: valid, state: "prepared_v2" }] as unknown as Parameters<
        typeof synchronizeCatalogDeliveryIntents
      >[1],
      new Date("2026-10-21T00:10:00.000Z"),
    );
    expect(undecoded).toEqual({
      refused: [],
      mismatched: [],
      undecodable: [valid],
    });
    expect(statements.at(-1)!.values[2]).toEqual([valid]);
  });
});

describe("F6: held fences never starve snapshot reads or the other lane", () => {
  const live = editorialSource("live", 4096, 2731);
  const other = editorialSource("other", 3000, 2000);
  const configuredMax = parseCatalogPrepareDatabaseConfig({
    DATABASE_URL:
      "postgresql://synthetic_public@127.0.0.1:1/synthetic_cms?sslmode=disable",
    CATALOG_PREPARE_DATABASE_URL:
      "postgresql://synthetic_prepare@127.0.0.1:1/synthetic_cms?sslmode=disable",
  })!.max;

  // The publish and withdraw lanes each run one job (createPublicationWorkers).
  const LANES = 2;

  it("leaves pool clients for withdraw, sync and reconcile while a publish holds its fence", async () => {
    const w = world({ published: [live, other], prepareMax: configuredMax });
    w.setRows([
      ...renditionRows(live, 1, "current"),
      ...renditionRows(other, 20, "current"),
    ]);
    // The publish lane holds its fence across the whole object-store copy.
    const publish = await w.authority.acquire(
      assetOf(live.media_id, live.object_key),
    );
    // Reconcile and the Catalog sync read a fresh snapshot meanwhile.
    expect(await w.authority.copyRenditionIds()).toHaveLength(8);
    expect(
      await readCatalogSourceSnapshot(w.published, w.prepare),
    ).not.toBeNull();
    // The withdraw lane takes its own fence.
    const withdraw = await w.authority.acquire(
      assetOf(other.media_id, other.object_key),
    );
    expect(await w.authority.copyRenditionIds()).toHaveLength(8);
    // A fence beyond both lanes is busy (deferred), never a pool timeout,
    // and it never takes the clients the snapshot reads rely on.
    await expect(
      w.authority.acquire(assetOf(other.media_id, other.object_key)),
    ).rejects.toMatchObject({ code: "55P03" });
    expect(w.capacity.refused).toBe(0);
    expect(w.capacity.active).toBe(LANES);
    await publish.release();
    await publish.release();
    await withdraw.release();
    expect(w.capacity.active).toBe(0);
    const again = await w.authority.acquire(
      assetOf(live.media_id, live.object_key),
    );
    await again.release();
    expect(w.capacity.peak).toBeLessThanOrEqual(configuredMax);
  });
});

describe("W3: a fence re-reads the projection its snapshot was captured from", () => {
  const live = editorialSource("fence-live", 4096, 2731);
  const privateB = editorialSource("fence-private", 3000, 2000);
  const prepared = "00000000-0000-4000-8000-0000000000d1";
  const retiredLive = "00000000-0000-4000-8000-0000000000d2";
  const retiredPrivate = "00000000-0000-4000-8000-0000000000d3";
  /** The header row (no member) of an intent withdrawn longer ago than R. */
  const retired = (intentId: string, documentId: number): Row => ({
    ...intentRows(intentId, "withdrawn", [live], documentId)[0]!,
    state_version: 3,
    media_ordinal: null,
    media_id: null,
    object_key: null,
    source_sha256: null,
    width: null,
    height: null,
  });

  it("never makes a fence busy for an App-known intent past retention, which grants nothing", async () => {
    const liveAsset = assetOf(live.media_id, live.object_key);
    const privateAsset = assetOf(privateB.media_id, privateB.object_key);
    const privateRows = intentRows(prepared, "prepared", [privateB], 3);
    // App mirror members still name both retired intents; the full view
    // still lists them, the live projection the snapshot reads does not.
    const w = world({
      published: [live],
      privateRows,
      retiredRows: [retired(retiredLive, 1), retired(retiredPrivate, 2)],
      appIntentIds: {
        [liveAsset]: [retiredLive],
        [privateAsset]: [retiredPrivate, prepared],
      },
    });
    w.setRows(renditionRows(live, 1, "current"));
    const snapshot = await readCatalogSourceSnapshot(w.published, w.prepare);
    expect(snapshot?.preparations?.map((i) => i.intentId)).toEqual([prepared]);
    // A published asset: the stamps agree, and the public permission grants.
    const publish = await w.authority.acquire(liveAsset);
    try {
      expect(await publish.current()).toBe(true);
      expect(await publish.authorized()).toBe(true);
    } finally {
      await publish.release();
    }
    // A private one: the stamps agree, and only a live intent could grant
    // (this one is prepared, not requested), never the retired one.
    const fence = await w.authority.acquire(privateAsset);
    try {
      expect(await fence.current()).toBe(true);
      expect(await fence.authorized()).toBe(false);
      // The fence still follows the live intents it captured.
      for (const row of privateRows) row.state_version = 2;
      expect(await fence.current()).toBe(false);
    } finally {
      await fence.release();
    }
  });
});

describe("F3: an intent that would revive its tombstone is refused alone", () => {
  const live = "00000000-0000-4000-8000-00000000000a";
  const late = "00000000-0000-4000-8000-00000000000b";
  const member = editorialSource("member", 3000, 2000);
  const observed = new Date("2026-10-21T00:05:00.000Z");
  const header = (intentId: string, state: string, stateVersion: number) => ({
    intentId,
    documentId: 1,
    catalogId: "synthetic-catalog-1",
    revision: 1,
    fingerprint: "a".repeat(64),
    manifestSha256: "b".repeat(64),
    recipeManifestSha256: policy,
    state: state as "prepared",
    stateVersion,
    mediaCount: 1,
    media: ["prepared", "release_requested", "released"].includes(state)
      ? [
          {
            ordinal: 1,
            mediaId: member.media_id,
            objectKey: member.object_key,
            sourceSha256: "c".repeat(64),
            width: member.width,
            height: member.height,
          },
        ]
      : [],
    expiresAt: "2026-10-21T00:00:00.000Z",
  });
  const stored = (intentId: string, state: string, version: number) => ({
    intent_id: intentId,
    cms_document_id: 1,
    catalog_id: "synthetic-catalog-1",
    draft_revision: 1,
    draft_fingerprint: "a".repeat(64),
    manifest_sha256: "b".repeat(64),
    recipe_manifest_sha256: policy,
    media_count: 1,
    source_state: state,
    source_state_version: version,
    observed_live: true,
    expires_at: new Date("2026-10-21T00:00:00.000Z"),
    observed_at: new Date("2026-10-21T00:00:01.000Z"),
  });
  // The stored member of each intent the batched member read names
  // (catalog-scale-v1 W4: one read for every snapshot intent with a mirror).
  const storedMembers = (values: readonly unknown[]) => ({
    rows: (values[0] as string[]).map((intentId) => ({
      intent_id: intentId,
      ordinal: 1,
      media_id: member.media_id,
      object_key: member.object_key,
      source_sha256: "c".repeat(64),
      width: member.width,
      height: member.height,
    })),
  });
  // The rows of the one lifecycle UPDATE as [intent, state, version].
  const lifecycle = (write: { readonly values: readonly unknown[] }) =>
    (write.values[0] as string[]).map((intentId, i) => [
      intentId,
      (write.values[1] as string[])[i],
      (write.values[2] as number[])[i],
    ]);

  it("keeps the expired mirror of a late release and still applies every other intent", async () => {
    const statements: { sql: string; values: readonly unknown[] }[] = [];
    const db = {
      query: vi.fn(async (sql: string, values: readonly unknown[] = []) => {
        statements.push({ sql, values });
        if (sql.startsWith("SELECT * FROM community.catalog_delivery_prepares"))
          return {
            rows: [
              // Mirrored as expired: a snapshot saw release_requested after
              // expires_at, before the release committed (state_version 2).
              { ...stored(late, "expired", 2), observed_live: true },
              stored(live, "release_requested", 1),
            ],
          };
        if (sql.startsWith("SELECT intent_id,ordinal,media_id"))
          return storedMembers(values);
        return { rows: [] };
      }),
    } as unknown as Parameters<typeof synchronizeCatalogDeliveryIntents>[0];
    const result = await synchronizeCatalogDeliveryIntents(
      db,
      [
        header(late, "released", 3),
        header(live, "cancelled", 2),
      ] as unknown as Parameters<typeof synchronizeCatalogDeliveryIntents>[1],
      observed,
    );
    expect(result).toEqual({
      refused: [late],
      mismatched: [],
      undecodable: [],
    });
    const updates = statements.filter(({ sql }) =>
      sql.trimStart().startsWith("UPDATE community.catalog_delivery_prepares"),
    );
    // The other intent's lifecycle is applied; nothing is written for the
    // refused one except the shared fail-closed absence tombstone.
    expect(lifecycle(updates[0]!)).toEqual([[live, "cancelled", 2]]);
    expect(updates).toHaveLength(2);
    const absence = updates.at(-1)!;
    expect(absence.sql).toContain("observed_live=false");
    expect(absence.values[0]).toEqual([live]);
    expect(absence.values[2]).toEqual([]);
  });

  it("ends a mirror whose lease lapsed at the same state_version, so a later release is refused", async () => {
    const lapsed = "00000000-0000-4000-8000-00000000000d";
    // A stateful mirror: what one pass writes is what the next one reads.
    const rows = new Map<
      string,
      ReturnType<typeof stored> & { ended_at: Date | null }
    >([[lapsed, { ...stored(lapsed, "prepared", 1), ended_at: null }]]);
    const statements: { sql: string; values: readonly unknown[] }[] = [];
    const db = {
      query: vi.fn(async (sql: string, values: readonly unknown[] = []) => {
        statements.push({ sql, values });
        if (sql.startsWith("SELECT * FROM community.catalog_delivery_prepares"))
          return {
            rows: [...rows.values()]
              .filter(
                (row) =>
                  row.observed_live ||
                  (values[0] as string[]).includes(row.intent_id),
              )
              .map((row) => ({ ...row })),
          };
        if (sql.startsWith("SELECT intent_id,ordinal,media_id"))
          return storedMembers(values);
        if (
          sql
            .trimStart()
            .startsWith("UPDATE community.catalog_delivery_prepares p")
        ) {
          const [ids, states, versions, ended, at] = values as [
            string[],
            string[],
            number[],
            boolean[],
            string,
          ];
          ids.forEach((id, i) => {
            const row = rows.get(id)!;
            row.source_state = states[i]!;
            row.source_state_version = versions[i]!;
            row.observed_at = new Date(at);
            if (ended[i]) row.ended_at ??= new Date(at);
          });
        } else if (sql.includes("observed_live=false")) {
          const [present, at] = values as [string[], string];
          for (const row of rows.values())
            if (row.observed_live && !present.includes(row.intent_id)) {
              row.observed_live = false;
              row.ended_at ??= new Date(at);
            }
        }
        return { rows: [] };
      }),
    } as unknown as Parameters<typeof synchronizeCatalogDeliveryIntents>[0];
    const lifecycles = () =>
      statements
        .filter(({ sql }) =>
          sql
            .trimStart()
            .startsWith("UPDATE community.catalog_delivery_prepares p"),
        )
        .map(lifecycle);
    // The lease passed (expires_at 00:00) with no CMS change: the snapshot
    // still says prepared at state_version 1, and the mirror ends it.
    expect(
      await synchronizeCatalogDeliveryIntents(
        db,
        [header(lapsed, "prepared", 1)] as unknown as Parameters<
          typeof synchronizeCatalogDeliveryIntents
        >[1],
        observed,
      ),
    ).toEqual({ refused: [], mismatched: [], undecodable: [] });
    expect(lifecycles()).toEqual([[[lapsed, "expired", 1]]]);
    expect(rows.get(lapsed)).toMatchObject({
      source_state: "expired",
      source_state_version: 1,
      observed_live: true,
      ended_at: observed,
    });
    // A release the CMS commits after that expiry is refused and tombstoned,
    // never applied.
    statements.length = 0;
    const later = new Date("2026-10-21T00:10:00.000Z");
    expect(
      await synchronizeCatalogDeliveryIntents(
        db,
        [header(lapsed, "released", 2)] as unknown as Parameters<
          typeof synchronizeCatalogDeliveryIntents
        >[1],
        later,
      ),
    ).toEqual({ refused: [lapsed], mismatched: [], undecodable: [] });
    expect(lifecycles()).toEqual([]);
    expect(rows.get(lapsed)).toMatchObject({
      source_state: "expired",
      source_state_version: 1,
      observed_live: false,
      ended_at: observed,
    });
  });

  it("logs every intent a sync pass tombstoned", async () => {
    const logger = { info: vi.fn(), error: vi.fn() };
    await createCatalogSync({
      listSources: async () => [],
      readSnapshot: async () => ({
        sources: [],
        publishedSources: [],
        preparations: [],
        observedAt: observed,
      }),
      port: {
        syncCatalogAssets: async () => ({
          referenced: 0,
          skipped: 0,
          created: 0,
          unreferenced: 0,
          enqueued: 0,
          refusedIntentIds: [late],
        }),
      },
      logger,
    }).run(observed);
    expect(logger.error).toHaveBeenCalledWith(
      `[media-worker] catalog sync tombstoned intents=1 ids=${late}`,
    );
  });

  it("skips an intent whose identity drifted, leaving its live mirror as it is", async () => {
    const drifted = "00000000-0000-4000-8000-00000000000c";
    const later = "2026-10-22T00:00:00.000Z";
    const prepared = { ...header(drifted, "prepared", 1), expiresAt: later };
    for (const snapshot of [
      { ...prepared, expiresAt: "2026-10-23T00:00:00.000Z" },
      { ...prepared, fingerprint: "e".repeat(64) },
      { ...prepared, documentId: 2 },
      { ...prepared, media: [{ ...prepared.media[0]!, width: 3001 }] },
    ]) {
      const statements: { sql: string; values: readonly unknown[] }[] = [];
      const db = {
        query: vi.fn(async (sql: string, values: readonly unknown[] = []) => {
          statements.push({ sql, values });
          if (
            sql.startsWith("SELECT * FROM community.catalog_delivery_prepares")
          )
            return {
              rows: [
                {
                  ...stored(drifted, "prepared", 1),
                  expires_at: new Date(later),
                },
                stored(live, "release_requested", 1),
              ],
            };
          if (sql.startsWith("SELECT intent_id,ordinal,media_id"))
            return storedMembers(values);
          return { rows: [] };
        }),
      } as unknown as Parameters<typeof synchronizeCatalogDeliveryIntents>[0];
      const result = await synchronizeCatalogDeliveryIntents(
        db,
        [snapshot, header(live, "cancelled", 2)] as unknown as Parameters<
          typeof synchronizeCatalogDeliveryIntents
        >[1],
        observed,
      );
      const writes = statements.filter(({ sql }) =>
        /^\s*(UPDATE|INSERT INTO) community\.catalog_delivery_(prepares|media_refs)/u.test(
          sql,
        ),
      );
      // The other intent is applied; nothing at all is written for the
      // drifted one, and the absence tombstone counts it as present.
      expect(lifecycle(writes[0]!)).toEqual([[live, "cancelled", 2]]);
      const absence = writes.at(-1)!;
      expect(absence.sql).toContain("observed_live=false");
      expect(absence.values[0]).toEqual([live, drifted]);
      expect(writes).toHaveLength(2);
      expect(result).toEqual({
        refused: [],
        mismatched: [drifted],
        undecodable: [],
      });
    }
  });

  it("skips an identity drift beside a regression alike, header or media", async () => {
    const drifted = "00000000-0000-4000-8000-00000000000c";
    const later = "2026-10-22T00:00:00.000Z";
    // A state_version regression (2 -> 1) that also contradicts the identity.
    const regressed = { ...header(drifted, "prepared", 1), expiresAt: later };
    for (const snapshot of [
      { ...regressed, fingerprint: "e".repeat(64) },
      { ...regressed, media: [{ ...regressed.media[0]!, width: 3001 }] },
    ]) {
      const statements: { sql: string; values: readonly unknown[] }[] = [];
      const db = {
        query: vi.fn(async (sql: string, values: readonly unknown[] = []) => {
          statements.push({ sql, values });
          if (
            sql.startsWith("SELECT * FROM community.catalog_delivery_prepares")
          )
            return {
              rows: [
                {
                  ...stored(drifted, "release_requested", 2),
                  expires_at: new Date(later),
                },
              ],
            };
          if (sql.startsWith("SELECT intent_id,ordinal,media_id"))
            return storedMembers(values);
          return { rows: [] };
        }),
      } as unknown as Parameters<typeof synchronizeCatalogDeliveryIntents>[0];
      const result = await synchronizeCatalogDeliveryIntents(
        db,
        [snapshot] as unknown as Parameters<
          typeof synchronizeCatalogDeliveryIntents
        >[1],
        observed,
      );
      // Identity is checked first: a live drift is never tombstoned, its
      // mirror untouched.
      expect(result).toEqual({
        refused: [],
        mismatched: [drifted],
        undecodable: [],
      });
      const writes = statements.filter(({ sql }) =>
        /^\s*(UPDATE|INSERT INTO) community\.catalog_delivery_(prepares|media_refs)/u.test(
          sql,
        ),
      );
      expect(writes).toHaveLength(1);
      expect(writes[0]!.values[0]).toEqual([drifted]);
    }
  });

  it("tombstones an identity drift whose state is terminal", async () => {
    const drifted = "00000000-0000-4000-8000-00000000000c";
    const later = "2026-10-22T00:00:00.000Z";
    const ended = (state: string) => ({
      ...header(drifted, state, 2),
      expiresAt: later,
    });
    for (const snapshot of [
      { ...ended("withdrawn"), fingerprint: "e".repeat(64) },
      { ...ended("cancelled"), expiresAt: "2026-10-23T00:00:00.000Z" },
      { ...ended("superseded"), documentId: 2 },
      { ...ended("expired"), mediaCount: 2 },
      // Expired by its own (drifted) expiry, though the snapshot says prepared.
      {
        ...header(drifted, "prepared", 1),
        expiresAt: "2026-10-21T00:01:00.000Z",
      },
    ]) {
      const statements: { sql: string; values: readonly unknown[] }[] = [];
      const db = {
        query: vi.fn(async (sql: string, values: readonly unknown[] = []) => {
          statements.push({ sql, values });
          if (
            sql.startsWith("SELECT * FROM community.catalog_delivery_prepares")
          )
            return {
              rows: [
                {
                  ...stored(drifted, "prepared", 1),
                  expires_at: new Date(later),
                },
              ],
            };
          if (sql.startsWith("SELECT intent_id,ordinal,media_id"))
            return storedMembers(values);
          return { rows: [] };
        }),
      } as unknown as Parameters<typeof synchronizeCatalogDeliveryIntents>[0];
      const result = await synchronizeCatalogDeliveryIntents(
        db,
        [snapshot] as unknown as Parameters<
          typeof synchronizeCatalogDeliveryIntents
        >[1],
        observed,
      );
      // Refused, never frozen: nothing of the snapshot is applied, and the
      // absence tombstone no longer counts the intent as present.
      expect(result).toEqual({
        refused: [drifted],
        mismatched: [],
        undecodable: [],
      });
      const writes = statements.filter(({ sql }) =>
        /^\s*(UPDATE|INSERT INTO) community\.catalog_delivery_(prepares|media_refs)/u.test(
          sql,
        ),
      );
      expect(writes).toHaveLength(1);
      expect(writes[0]!.sql).toContain("observed_live=false");
      expect(writes[0]!.values[0]).toEqual([]);
    }
  });

  it("tombstones a drift that is over by the stored expiry, a member drift past expiry and a released mirror, beside an applied intent", async () => {
    const drifted = "00000000-0000-4000-8000-00000000000c";
    const later = "2026-10-22T00:00:00.000Z";
    for (const { mirror, snapshot } of [
      // Stored expiry passed; the snapshot's drifted expiry would extend it.
      {
        mirror: stored(drifted, "release_requested", 1),
        snapshot: {
          ...header(drifted, "release_requested", 1),
          expiresAt: later,
        },
      },
      // A member drift on a snapshot past its own (unchanged) expiry.
      {
        mirror: stored(drifted, "prepared", 1),
        snapshot: (() => {
          const prepared = header(drifted, "prepared", 1);
          return {
            ...prepared,
            media: [{ ...prepared.media[0]!, width: 3001 }],
          };
        })(),
      },
      // Past the stored lease, a contradicted `released` label never extends
      // a release_requested mirror.
      {
        mirror: stored(drifted, "release_requested", 1),
        snapshot: {
          ...header(drifted, "released", 2),
          fingerprint: "e".repeat(64),
        },
      },
      // A released mirror (its retention pin ignores expiry) withdrawn with
      // a drifted fingerprint.
      {
        mirror: {
          ...stored(drifted, "released", 2),
          expires_at: new Date(later),
        },
        snapshot: {
          ...header(drifted, "withdrawn", 3),
          expiresAt: later,
          fingerprint: "e".repeat(64),
        },
      },
    ]) {
      const statements: { sql: string; values: readonly unknown[] }[] = [];
      const db = {
        query: vi.fn(async (sql: string, values: readonly unknown[] = []) => {
          statements.push({ sql, values });
          if (
            sql.startsWith("SELECT * FROM community.catalog_delivery_prepares")
          )
            return { rows: [mirror, stored(live, "release_requested", 1)] };
          if (sql.startsWith("SELECT intent_id,ordinal,media_id"))
            return storedMembers(values);
          return { rows: [] };
        }),
      } as unknown as Parameters<typeof synchronizeCatalogDeliveryIntents>[0];
      const result = await synchronizeCatalogDeliveryIntents(
        db,
        [snapshot, header(live, "cancelled", 2)] as unknown as Parameters<
          typeof synchronizeCatalogDeliveryIntents
        >[1],
        observed,
      );
      expect(result).toEqual({
        refused: [drifted],
        mismatched: [],
        undecodable: [],
      });
      const writes = statements.filter(({ sql }) =>
        /^\s*(UPDATE|INSERT INTO) community\.catalog_delivery_(prepares|media_refs)/u.test(
          sql,
        ),
      );
      // The other intent is applied; nothing of the drifted snapshot is, and
      // the absence tombstone no longer counts it as present.
      expect(lifecycle(writes[0]!)).toEqual([[live, "cancelled", 2]]);
      const absence = writes.at(-1)!;
      expect(absence.sql).toContain("observed_live=false");
      expect(absence.values[0]).toEqual([live]);
      expect(writes).toHaveLength(2);
    }
  });

  it("never ends a released mirror for a drifted live label past its lease", async () => {
    const drifted = "00000000-0000-4000-8000-00000000000c";
    // A released row keeps its 24 h prepare lease, long past; the
    // contradicted snapshot says release_requested with a later expiry.
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.startsWith("SELECT * FROM community.catalog_delivery_prepares"))
          return { rows: [stored(drifted, "released", 2)] };
        return { rows: [] };
      }),
    } as unknown as Parameters<typeof synchronizeCatalogDeliveryIntents>[0];
    const result = await synchronizeCatalogDeliveryIntents(
      db,
      [
        {
          ...header(drifted, "release_requested", 2),
          expiresAt: "2026-10-23T00:00:00.000Z",
          fingerprint: "e".repeat(64),
          media: [],
          mediaCount: 0,
        },
      ] as unknown as Parameters<typeof synchronizeCatalogDeliveryIntents>[1],
      observed,
    );
    expect(result).toEqual({
      refused: [],
      mismatched: [drifted],
      undecodable: [],
    });
  });

  it("logs every intent a sync pass skipped for identity drift", async () => {
    const drifted = "00000000-0000-4000-8000-00000000000c";
    const logger = { info: vi.fn(), error: vi.fn() };
    await createCatalogSync({
      listSources: async () => [],
      readSnapshot: async () => ({
        sources: [],
        publishedSources: [],
        preparations: [],
        observedAt: observed,
      }),
      port: {
        syncCatalogAssets: async () => ({
          referenced: 0,
          skipped: 0,
          created: 0,
          unreferenced: 0,
          enqueued: 0,
          mismatchedIntentIds: [drifted],
        }),
      },
      logger,
    }).run(observed);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      `[media-worker] catalog sync mismatched intents=1 ids=${drifted}`,
    );
  });
});
