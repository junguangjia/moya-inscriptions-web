import { createHash } from "node:crypto";

import {
  asCatalogQueryUnavailableError,
  parsePostgresConfig,
} from "@moya/catalog-postgres";
import type { BackendApplicationOptions } from "@moya/backend-runtime";

import {
  MAX_OUTPUT_EDGE,
  LONG_SCROLL_ASPECT_RATIO,
  PROFILE_ROLES,
  RECIPE_PARAMETERS_V1,
  RENDITION_PLANS,
  canonicalRecipeJson,
  currentRecipe,
  isProfileRole,
  plannedStillSize,
  stillOutputSize,
} from "./processing/recipes.js";

const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");

type CatalogRecipePolicy = Awaited<
  ReturnType<NonNullable<BackendApplicationOptions["catalogRecipePolicy"]>>
>;
type CatalogPublishedRenditionsReader = NonNullable<
  BackendApplicationOptions["catalogPublishedRenditions"]
>;

/** The actual immutable registry and actual geometry functions in this build.
 * Full's parameters are only the viewer comparison bound; full is never an
 * allowed output. No image, object-store read, fixture or database is involved.
 */
export const currentCatalogRecipePolicy = (): CatalogRecipePolicy => {
  const canonicalManifest = canonicalRecipeJson({
    version: 1,
    plan: "catalog",
    roles: (["thumb", "cover", "display", "viewer"] as const).map((role) => ({
      ...currentRecipe(role),
      parameters: RECIPE_PARAMETERS_V1[role],
    })),
    geometry: {
      frame: "oriented-uncropped-source",
      plannedStillSizeSha256: sha256(plannedStillSize.toString()),
      stillOutputSizeSha256: sha256(stillOutputSize.toString()),
      planFull: RENDITION_PLANS.catalog.full,
      dependencySha256: sha256(
        canonicalRecipeJson({
          isProfileRole: isProfileRole.toString(),
          profileRoles: PROFILE_ROLES,
          plan: RENDITION_PLANS.catalog,
          maxOutputEdge: MAX_OUTPUT_EDGE,
          longScrollAspectRatio: LONG_SCROLL_ASPECT_RATIO,
        }),
      ),
      viewer: "omit-when-equal-to-display-or-larger-than-full",
      comparisonFullParameters: RECIPE_PARAMETERS_V1.full,
      maxOutputEdge: MAX_OUTPUT_EDGE,
    },
    excludedRoles: ["full", "motion"],
  });
  return {
    canonicalManifest,
    recipeManifestSha256: sha256(canonicalManifest),
  };
};

/** Lease clients one authority holds at once: a publication fence keeps its
 * client (and the Native document lock) until the job releases it, and the
 * publish and withdraw lanes each run one job.
 */
export const CATALOG_PREPARE_LEASES = 2;
/** Every lease client plus two for the short snapshot and readiness reads, so
 * held fences never starve withdraw, sync, reconcile or readiness.
 */
export const CATALOG_PREPARE_POOL_MAX = CATALOG_PREPARE_LEASES + 2;

/** Separate CMS authority. Absent means private preparing is not connected;
 * even Development cannot borrow the public or App role. The real connection
 * is opened by composition only, with a small bounded pool.
 */
export const parseCatalogPrepareDatabaseConfig = (
  environment: Readonly<Record<string, string | undefined>>,
) => {
  const url = environment.CATALOG_PREPARE_DATABASE_URL;
  const ca = environment.CATALOG_PREPARE_DATABASE_SSL_CA_FILE;
  if (url === undefined && ca === undefined) return null;
  if (!url || !environment.DATABASE_URL)
    throw new Error(
      "Catalog private prepare database configuration is incomplete",
    );
  try {
    const privateUrl = new URL(url);
    const publicUrl = new URL(environment.DATABASE_URL);
    if (
      privateUrl.hostname !== publicUrl.hostname ||
      (privateUrl.port || "5432") !== (publicUrl.port || "5432") ||
      privateUrl.pathname !== publicUrl.pathname ||
      decodeURIComponent(privateUrl.username) ===
        decodeURIComponent(publicUrl.username)
    )
      throw new Error(
        "Catalog prepare database identity separation is required",
      );
    const config = parsePostgresConfig({
      DATABASE_URL: url,
      ...(ca === undefined ? {} : { DATABASE_SSL_CA_FILE: ca }),
    });
    return { ...config, max: CATALOG_PREPARE_POOL_MAX };
  } catch {
    throw new Error(
      "Catalog private prepare database configuration is invalid",
    );
  }
};

// All data below is metadata. No source reader, publication provider or HTTP
// request is involved. CMS identity and App facts remain separate connections.
import {
  CATALOG_SNAPSHOT_MAX_PRIVATE_ROWS,
  CATALOG_SNAPSHOT_MAX_SOURCES,
  inspectCatalogDelivery,
  parseCatalogPrepareRows,
  partitionCatalogPrepareRows,
  catalogBlockListedSql,
  readCatalogDeliveryProjection,
  readCatalogSnapshotCursor,
  type PostgresMediaPublicationAdapter,
} from "@moya/community-postgres";
import type { createPostgresPool } from "@moya/catalog-postgres";
import {
  CATALOG_PUBLISHED_PAIRS_MAX,
  publishedCatalogPairs,
  readPublishedCatalogSources,
} from "./catalog.js";

type CatalogPool = ReturnType<typeof createPostgresPool>;
type CatalogAuthority = NonNullable<
  ConstructorParameters<
    typeof PostgresMediaPublicationAdapter
  >[1]["catalogAuthority"]
>;
type CatalogDeliveryFacts = NonNullable<
  NonNullable<BackendApplicationOptions["storageUrlResolver"]>["catalogFacts"]
>;
const sourceAssetId = (mediaId: string, objectKey: string) =>
  `catalog-asset-${createHash("md5").update(`${mediaId}:${objectKey}`).digest("hex")}`;
// The live private projection (CMS migration M2): every released intent and
// every other intent that ended or expired within its retention. An older one
// is absent, and the sync tombstones its App mirror by absence.
const privateRowsSql = `SELECT * FROM public.catalog_delivery_live_prepare_media ORDER BY intent_id,media_ordinal NULLS FIRST`;

/** Both roles import exactly the same CMS MVCC snapshot, or refuse the entire
 * round. A local promise serializes capture+apply, while App's durable watermark
 * rejects an older complete snapshot from another process.
 *
 * Each side is read through a cursor in batches (catalog-scale-v1 W3), never
 * past one row beyond the snapshot ceiling (`@moya/community-postgres`
 * CATALOG_SNAPSHOT_*): the published list, the live private rows, or their
 * union above it is `null`, never a partial list, and the sync then writes
 * nothing. A failed FETCH throws, and the sync writes nothing either.
 */
export const readCatalogSourceSnapshot = async (
  published: CatalogPool,
  prepare: CatalogPool | null,
) => {
  const publicClient = await published.connect();
  let privateClient;
  try {
    await publicClient.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const observedAt = (
      await publicClient.query<{ at: Date }>("SELECT clock_timestamp() AS at")
    ).rows[0]!.at;
    const sources = await readPublishedCatalogSources(publicClient);
    if (sources === null) return null;
    let preparations: ReturnType<typeof parseCatalogPrepareRows> | undefined;
    let undecodableIntentIds: string[] | undefined;
    let privateRows: number | undefined;
    if (prepare) {
      const snapshot = (
        await publicClient.query<{ id: string }>(
          "SELECT pg_export_snapshot() AS id",
        )
      ).rows[0]!.id;
      if (!/^[a-f0-9]+-[a-f0-9]+-[a-f0-9]+$/i.test(snapshot))
        throw new Error("Catalog snapshot identifier invalid");
      privateClient = await prepare.connect();
      await privateClient.query(
        "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
      );
      await privateClient.query(`SET TRANSACTION SNAPSHOT '${snapshot}'`);
      const rows = await readCatalogSnapshotCursor<Record<string, unknown>>(
        privateClient,
        "catalog_private_snapshot",
        privateRowsSql,
        CATALOG_SNAPSHOT_MAX_PRIVATE_ROWS,
      );
      if (rows === null) return null;
      privateRows = rows.length;
      // One undecodable intent is left out (it is granted nothing, and the
      // sync leaves its App mirror untouched), never the whole round for
      // every other intent. Every page is read before any is decoded.
      ({ intents: preparations, undecodableIntentIds } =
        partitionCatalogPrepareRows(rows));
    }
    const union = new Map(
      sources.map((s) => [sourceAssetId(s.mediaId, s.objectKey), s]),
    );
    for (const intent of preparations ?? [])
      if (
        ["prepared", "release_requested"].includes(intent.state) &&
        intent.recipeManifestSha256 ===
          currentCatalogRecipePolicy().recipeManifestSha256
      )
        for (const media of intent.media)
          union.set(sourceAssetId(media.mediaId, media.objectKey), media);
    if (union.size > CATALOG_SNAPSHOT_MAX_SOURCES) return null;
    return {
      sources: [...union.values()],
      publishedSources: sources,
      ...(preparations ? { preparations } : {}),
      ...(undecodableIntentIds?.length ? { undecodableIntentIds } : {}),
      // Live private rows read, for the sync's ceiling warning.
      ...(privateRows === undefined ? {} : { privateRows }),
      observedAt,
    };
  } finally {
    if (privateClient) {
      await privateClient.query("ROLLBACK").catch(() => undefined);
      privateClient.release();
    }
    await publicClient.query("ROLLBACK").catch(() => undefined);
    publicClient.release();
  }
};

/** Exact live CMS permission. The same document lock as Native writes is held
 * until the existing queue/publication fence is released. No App mirror is an
 * authority; expiry is re-evaluated on every streaming/commit check.
 *
 * A job reads only its own asset (catalog-scale-v1 W5): acquire captures the
 * asset's plan from its App-known intents and its exact pair
 * (captureCatalogAssets), the fence re-reads exactly those intents, and
 * authorized() checks exactly that pair, so a job, a fence check and an
 * authorization cost the same at any Catalog size and never read the
 * published list or a whole private view. The reconcile plans a bounded
 * scope of assets the same way (planScope, W7); nothing in production plans
 * the whole Catalog any more (planCatalogPermissions is the tests' oracle).
 * Every read error throws; none is read as "not public" or "nothing
 * permitted".
 */
export const createCatalogPublicationAuthority = (
  published: CatalogPool,
  prepare: CatalogPool | null,
  app: CatalogPool,
): CatalogAuthority => {
  // A fence keeps its client for the whole publication lease. Fences never
  // take more than CATALOG_PREPARE_LEASES clients, so snapshot reads (sync,
  // reconcile scopes) and the other lane always find one; a fence beyond the
  // cap is busy (lock_not_available, as a contended document lock), so the job
  // is deferred instead of failing an attempt on a pool timeout.
  let fences = 0;
  const connectFence = async (pool: CatalogPool) => {
    if (fences >= CATALOG_PREPARE_LEASES)
      throw Object.assign(new Error("Catalog document fence busy"), {
        code: "55P03",
      });
    fences += 1;
    try {
      return await pool.connect();
    } catch (error) {
      fences -= 1;
      throw error;
    }
  };
  return {
    // The public read path (resolveKeys): the requested assets' exact pairs,
    // by App primary key (the id is derived from the pair by a CHECK), then
    // the live CMS check of only those pairs on the public read pool. Never
    // the prepare pool, and never the whole published list
    // (catalog-scale-v1 1A).
    async publishedAssetIds(ids) {
      const requested = [...new Set(ids)];
      for (const id of requested)
        if (typeof id !== "string" || !/^catalog-asset-[a-f0-9]{32}$/.test(id))
          throw new TypeError("Catalog source identity invalid");
      if (!requested.length) return [];
      if (requested.length > CATALOG_PUBLISHED_PAIRS_MAX)
        throw new TypeError("Catalog published asset batch too large");
      const rows = (
        await app.query<{
          id: string;
          media_id: string;
          source_object_key: string;
        }>(
          "SELECT id,media_id,source_object_key FROM community.catalog_media_assets WHERE id=ANY($1::text[])",
          [requested],
        )
      ).rows;
      const live = await publishedCatalogPairs(
        published,
        rows.map((row) => ({
          mediaId: row.media_id,
          objectKey: row.source_object_key,
        })),
      );
      const approved = new Set(
        rows
          .filter((row) =>
            live.has(JSON.stringify([row.media_id, row.source_object_key])),
          )
          .map((row) => row.id),
      );
      return ids.filter((id) => approved.has(id));
    },
    // One scoped reconcile pass's plans (catalog-scale-v1 W7): the named
    // assets only, batched, within the pass's time budget.
    async planScope(assetIds, options) {
      const policy = currentCatalogRecipePolicy().recipeManifestSha256;
      return {
        policy,
        ...(await planCatalogScope(
          { published, prepare, app },
          assetIds,
          catalogPlanReads(app, policy),
          policy,
          options,
        )),
      };
    },
    async acquire(assetId) {
      if (!/^catalog-asset-[a-f0-9]{32}$/.test(assetId))
        throw new Error("Catalog source identity invalid");
      // Resolve immutable App facts before holding a CMS connection. No App row
      // lock is held while acquiring the shared Native document lock. The
      // capture reads only this asset: its App row and App-known intents, its
      // exact CMS pair and those intents' live rows (one CMS snapshot), and
      // App facts of only those intents and this pair.
      const policy = currentCatalogRecipePolicy().recipeManifestSha256;
      const captured = (
        await captureCatalogAssets(
          { published, prepare, app },
          [assetId],
          catalogPlanReads(app, policy),
          policy,
        )
      ).get(assetId)!;
      const { permissions, pair } = captured;
      const capturedStamp = catalogIntentStamp(captured.live, Date.now());
      const renditionIds = [
        ...new Set(permissions.flatMap((p) => p.renditionIds)),
      ];
      const client = prepare ? await connectFence(prepare) : null;
      let finished = false;
      const release = async () => {
        if (!finished) {
          finished = true;
          if (client) {
            await client.query("ROLLBACK").catch(() => undefined);
            try {
              client.release();
            } finally {
              fences -= 1;
            }
          }
        }
      };
      try {
        if (client) {
          await client.query("BEGIN READ ONLY");
          await client.query("SET LOCAL lock_timeout='5s'");
          // The documents of the live intents App knows for this asset. An
          // intent App does not know grants nothing (inspect needs its App
          // header, a release its proof), so it needs no lock.
          for (const documentId of [
            ...new Set(captured.live.intents.map((p) => p.documentId)),
          ].sort((a, b) => a - b))
            await client.query(
              "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
              [`moya-editorial:document:${documentId}`],
            );
        }
        const current = async () => {
          if (finished) return false;
          if (!client) return true; // Legacy live A retains its weaker live-public fence.
          // Exactly the capture's read of exactly its intents, by primary
          // key: an intent past retention or ended (never a grant) is absent
          // from both stamps, and a live one that changes state or version,
          // ends or expires changes this one.
          return (
            capturedStamp ===
            catalogIntentStamp(
              await readLiveCatalogIntents(client, captured.intentIds),
              Date.now(),
            )
          );
        };
        return {
          renditionIds,
          release,
          current,
          async authorized() {
            if (!(await current()) || !permissions.length || !pair)
              return false;
            // The exact pair on the public read pool, as a read checks it; a
            // failed check throws (a job retries), never "not public", which
            // would withdraw everything the asset serves.
            const publicLive = (
              await publishedCatalogPairs(published, [pair])
            ).has(pairKey(pair.mediaId, pair.objectKey));
            for (const permission of permissions) {
              if (permission.published && publicLive) return true;
              if (!permission.intentId || !client) continue;
              const result = await client.query(
                `SELECT 1 FROM public.catalog_delivery_prepare_media WHERE intent_id=$1 AND state='release_requested' AND state_version=$2 AND media_manifest_sha256=$3 AND recipe_manifest_sha256=$4 AND expires_at>clock_timestamp() AND media_ordinal IS NOT NULL AND 'catalog-asset-'||md5(media_id||':'||object_key)=$5 LIMIT 1`,
                [
                  permission.intentId,
                  permission.stateVersion,
                  permission.manifestSha256,
                  permission.policy,
                  assetId,
                ],
              );
              if (result.rowCount === 1) return true;
            }
            return false;
          },
        };
      } catch (error) {
        await release();
        throw error;
      }
    },
  };
};

export const catalogExpectedRenditions = (width: number, height: number) =>
  (["thumb", "cover", "display", "viewer"] as const).flatMap((role) => {
    const size = plannedStillSize(role, { width, height }, "catalog");
    return size ? [{ ...currentRecipe(role), ...size }] : [];
  });

/** A decoded private intent, as the complete snapshot lists it. */
export type CatalogPlanIntent = ReturnType<
  typeof parseCatalogPrepareRows
>[number];

/** One permission of an asset's plan: the renditions a publication of the
 * asset may copy, and the authority it rests on. `intentId` is set only for a
 * release_requested intent (private B); the live public permission has no
 * document, intent or policy. */
export interface CatalogAssetPermission {
  readonly assetId: string;
  readonly documentId: number | null;
  readonly intentId: string | null;
  readonly stateVersion: number;
  readonly manifestSha256: string;
  readonly policy: string;
  readonly published: boolean;
  readonly renditionIds: readonly string[];
}

/** An App rendition the publication selector reads for a public pair: ready,
 * or an editorial one a re-render released or superseded while it is still
 * published. */
export interface CatalogSelectorRendition {
  readonly id: string;
  readonly media_id: string;
  readonly source_object_key: string;
  readonly role: string;
  readonly recipe_version: number;
  readonly recipe_digest: string;
  readonly width: number;
  readonly height: number;
  readonly master_width: number;
  readonly master_height: number;
  readonly state: "ready" | "superseded" | "released";
  readonly published: boolean;
}

/** A rendition pin of an intent of the current recipe policy. */
export interface CatalogIntentPin {
  readonly rendition_id: string;
  readonly media_id: string;
  readonly object_key: string;
  readonly role: string;
  readonly recipe_version: number;
  readonly recipe_digest: string;
  readonly width: number;
  readonly height: number;
  readonly master_width: number;
  readonly master_height: number;
}

/** A pin of a released intent of an earlier recipe policy whose public
 * generation is still published. */
export interface CatalogPriorPin {
  readonly rendition_id: string;
  readonly media_id: string;
  readonly object_key: string;
}

/** What App holds for one intent, read once per intent: for a released
 * intent of an earlier policy its still-published pins; for one of the
 * current policy inspect's verdict and, only when it is private-ready, its
 * pins. Pins may name the intent's other pairs; a plan keeps its own. */
export type CatalogIntentFacts =
  | { readonly kind: "prior"; readonly pins: readonly CatalogPriorPin[] }
  | {
      readonly kind: "current";
      readonly privateReady: boolean;
      readonly pins: readonly CatalogIntentPin[];
    };

/** Everything one asset's plan reads. `intents` are the decoded intents that
 * name the pair (as their member `ordinal`), in snapshot order, each with its
 * App facts. Facts may be left out only where the plan needs none: an intent
 * that is not a live release request while the pair is not public, or one of
 * an earlier policy that is not released. `renditions` are the pair's
 * selector rows; they count only while the pair is public. Requested intents
 * expire against `now`. */
export interface CatalogAssetPlanInput {
  readonly mediaId: string;
  readonly objectKey: string;
  readonly public: boolean;
  readonly policy: string;
  readonly now: number;
  readonly intents: readonly {
    readonly intent: CatalogPlanIntent;
    readonly ordinal: number;
    readonly facts?: CatalogIntentFacts;
  }[];
  readonly renditions: readonly CatalogSelectorRendition[];
}

/**
 * The publication plan of one Catalog asset (one exact CMS pair), with no
 * database, clock or other I/O, so a whole-Catalog plan, a single job and a
 * scoped reconcile share one rule (catalog-scale-v1 W1). Per intent naming
 * the pair: a release_requested one before its expiry (private B), or any
 * one while the pair is public; of an earlier recipe policy only a released
 * one, with its still-published pins; of the current policy only a
 * private-ready one, with its pins of the current recipe. Then, only while
 * the pair is public, the live public permission over the selector rows
 * (N3). A pair that is not public gets no live public permission whatever is
 * rendered for it: a taken-down asset's ready renditions are not desired, so
 * its withdrawal is scheduled. Missing facts, or a member that is not this
 * pair, throw; they are never read as "nothing permitted".
 */
export const planCatalogAsset = (
  input: CatalogAssetPlanInput,
): CatalogAssetPermission[] => {
  const { mediaId, objectKey, policy } = input;
  const assetId = sourceAssetId(mediaId, objectKey);
  const own = (p: { media_id: string; object_key: string }) =>
    p.media_id === mediaId && p.object_key === objectKey;
  const permissions: CatalogAssetPermission[] = [];
  for (const { intent, ordinal, facts } of input.intents) {
    const member = intent.media[ordinal - 1];
    if (member?.mediaId !== mediaId || member.objectKey !== objectKey)
      throw new Error("Catalog plan member invalid");
    const requested =
      intent.state === "release_requested" &&
      new Date(intent.expiresAt).getTime() > input.now;
    if (!requested && !input.public) continue;
    if (intent.recipeManifestSha256 !== policy) {
      if (intent.state !== "released") continue;
      if (facts?.kind !== "prior")
        throw new Error("Catalog plan facts unavailable");
      permissions.push({
        assetId,
        documentId: intent.documentId,
        intentId: null,
        stateVersion: intent.stateVersion,
        manifestSha256: intent.manifestSha256,
        policy: intent.recipeManifestSha256,
        published: true,
        renditionIds: facts.pins.filter(own).map((p) => p.rendition_id),
      });
      continue;
    }
    if (facts?.kind !== "current")
      throw new Error("Catalog plan facts unavailable");
    if (!facts.privateReady) continue;
    permissions.push({
      assetId,
      documentId: intent.documentId,
      intentId: requested ? intent.intentId : null,
      stateVersion: intent.stateVersion,
      manifestSha256: intent.manifestSha256,
      policy,
      published: input.public,
      renditionIds: facts.pins
        .filter(
          (p) =>
            own(p) &&
            catalogExpectedRenditions(p.master_width, p.master_height).some(
              (want) =>
                want.role === p.role &&
                want.version === p.recipe_version &&
                want.digest === p.recipe_digest &&
                want.width === p.width &&
                want.height === p.height,
            ),
        )
        .map((p) => p.rendition_id),
    });
  }
  if (!input.public) return permissions;
  const matches = input.renditions.filter(
    (r) => r.media_id === mediaId && r.source_object_key === objectKey,
  );
  const current = (r: CatalogSelectorRendition) =>
    r.state === "ready" &&
    !!r.master_width &&
    !!r.master_height &&
    catalogExpectedRenditions(r.master_width, r.master_height).some(
      (want) =>
        want.role === r.role &&
        want.version === r.recipe_version &&
        want.digest === r.recipe_digest &&
        want.width === r.width &&
        want.height === r.height,
    );
  const master = matches[0];
  const plan =
    master?.master_width && master.master_height
      ? catalogExpectedRenditions(master.master_width, master.master_height)
      : [];
  // A recipe version bump re-renders at a bounded rate, and recording the
  // new set releases the old rows before the new ones are copied. Until the
  // current recipe's set is complete and published, the ready set (one ready
  // rendition per slot, whatever its recipe) and every rendition still
  // published stay desired, so reconcile copies the replacement and withdraws
  // nothing it still serves; afterwards only the current set is desired and
  // the old one is retired.
  const replaced =
    plan.length > 0 &&
    plan.every(
      (want) =>
        matches.filter((r) => r.role === want.role && current(r) && r.published)
          .length === 1,
    );
  const ids = matches
    .filter(
      (r) =>
        // Blocks have already passed the shared active-master/cell SQL. Only
        // current public CMS pairs reach this branch; private B continues to
        // authorize its four ordinary immutable pins only.
        /^block-[0-9]{2}$/u.test(r.role) ||
        !objectKey.startsWith("editorial/") ||
        (replaced
          ? current(r)
          : plan.length > 0 &&
            ["thumb", "cover", "display", "viewer"].includes(r.role) &&
            (r.state === "ready" || r.published)),
    )
    .map((r) => r.id);
  // Existing live Native A needs no newly created B intent. A without an
  // intent/document ID retains live-public pre-copy/commit checks; only
  // private requested B claims the stronger CMS document lease boundary.
  permissions.push({
    assetId,
    documentId: null,
    intentId: null,
    stateVersion: 0,
    manifestSha256: "",
    policy: "",
    published: true,
    renditionIds: ids,
  });
  return permissions;
};

/** The App reads a Catalog plan makes, kept apart so planning stays pure. */
export interface CatalogPlanReads {
  /** inspectCatalogDelivery of an intent of the current policy; it pins the
   * intent's exact ready renditions. */
  inspect(
    intent: CatalogPlanIntent,
  ): Promise<{ readonly privateReady: boolean }>;
  pins(intent: CatalogPlanIntent): Promise<readonly CatalogIntentPin[]>;
  priorPins(intent: CatalogPlanIntent): Promise<readonly CatalogPriorPin[]>;
  /** The selector rows of these public pairs, or a throw, never a prefix. */
  renditions(
    sources: readonly {
      readonly mediaId: string;
      readonly objectKey: string;
    }[],
  ): Promise<readonly CatalogSelectorRendition[]>;
}

/** Pairs per selector statement: a batch bound of one read (about four rows
 * a pair, eight mid recipe bump, plus listed blocks), not a ceiling on the
 * Catalog. At the 25k fixture 250 assets plan as primary-key and index
 * lookups at a cost of about 33,000, below JIT's threshold (100,000); from
 * about 400 the planner hashes a whole scan of the committed blobs. */
export const CATALOG_PLAN_SELECTOR_BATCH = 250;

/** The App reads of a Catalog plan, with the App role: one asset's (a job's
 * capture), a reconcile scope batch's (W7), or the whole Catalog's (the
 * tests' oracle). The selector rows are read CATALOG_PLAN_SELECTOR_BATCH
 * pairs at a time, every row of each pair, with no row ceiling
 * (catalog-scale-v1 W5, W-AC7): #320 refused the whole Catalog above 40,000
 * rows, about 10,000 published images. Each pair is read by its App asset's
 * primary key (the id derives from the pair by a CHECK), so a job's single
 * pair never scans the assets, at any Catalog size (W-AC3). */
export const catalogPlanReads = (
  app: CatalogPool,
  policy: string,
): CatalogPlanReads => ({
  inspect: (intent) =>
    inspectCatalogDelivery(app, intent, policy, catalogExpectedRenditions),
  pins: async (intent) =>
    (
      await app.query<CatalogIntentPin>(
        `SELECT p.rendition_id,m.media_id,m.object_key,p.role,p.recipe_version,p.recipe_digest,r.width,r.height,a.master_width,a.master_height FROM community.catalog_delivery_rendition_pins p JOIN community.catalog_delivery_media_refs m ON m.intent_id=p.intent_id AND m.ordinal=p.ordinal JOIN community.media_renditions r ON r.id=p.rendition_id JOIN community.catalog_media_assets a ON a.id=r.catalog_asset_id WHERE p.intent_id=$1 ORDER BY p.ordinal,p.role`,
        [intent.intentId],
      )
    ).rows,
  priorPins: async (intent) =>
    (
      await app.query<CatalogPriorPin>(
        `SELECT pp.rendition_id,m.media_id,m.object_key FROM community.catalog_delivery_rendition_pins pp JOIN community.catalog_delivery_prepares i ON i.intent_id=pp.intent_id JOIN community.catalog_delivery_media_refs m ON m.intent_id=pp.intent_id AND m.ordinal=pp.ordinal JOIN community.media_renditions r ON r.id=pp.rendition_id JOIN community.media_blobs b ON b.id=r.blob_id AND b.state='committed' JOIN community.media_publications p ON p.id=pp.public_generation_id AND p.version=pp.public_generation_version AND p.rendition_id=r.id AND p.state='published' AND p.sha256=b.sha256 AND p.byte_size=b.byte_size AND p.storage_key=b.storage_key WHERE pp.intent_id=$1 AND i.manifest_sha256=$2 AND i.recipe_manifest_sha256=$3 ORDER BY pp.ordinal,pp.role`,
        [intent.intentId, intent.manifestSha256, intent.recipeManifestSha256],
      )
    ).rows,
  async renditions(sources) {
    // Each asset once (a pair two records show is listed twice), so no row
    // is read twice across batches.
    const ids = [
      ...new Set(sources.map((s) => sourceAssetId(s.mediaId, s.objectKey))),
    ];
    const batches: (readonly CatalogSelectorRendition[])[] = [];
    for (let at = 0; at < ids.length; at += CATALOG_PLAN_SELECTOR_BATCH)
      batches.push(
        (
          await app.query<CatalogSelectorRendition>(
            // Ready renditions, plus an editorial set a re-render released (or
            // superseded) that is still published on a committed blob: the
            // projection serves it until its replacement is published.
            `SELECT DISTINCT r.id,a.media_id,a.source_object_key,a.master_width,a.master_height,r.role,r.recipe_version,r.recipe_digest,r.width,r.height,r.state,pub.published FROM community.catalog_media_assets a JOIN community.media_renditions r ON r.catalog_asset_id=a.id JOIN community.media_blobs b ON b.id=r.blob_id AND b.state='committed' CROSS JOIN LATERAL (SELECT r.role IN ('thumb','cover','display','viewer') AND EXISTS (SELECT 1 FROM community.media_publications pp WHERE pp.rendition_id=r.id AND pp.state='published' AND pp.sha256=b.sha256 AND pp.byte_size=b.byte_size AND pp.storage_key=b.storage_key AND pp.content_type=r.content_type AND pp.purpose='catalog_derivative') AS published) pub WHERE a.id=ANY($1::text[]) AND a.state='ready' AND r.edit_key='base' AND (r.state='ready' OR (pub.published AND a.source_object_key LIKE 'editorial/%')) AND (r.role IN ('thumb','cover','display','viewer','full') OR (r.catalog_master_id IS NOT NULL AND ${catalogBlockListedSql("r")}))`,
            [ids.slice(at, at + CATALOG_PLAN_SELECTOR_BATCH)],
          )
        ).rows,
      );
    // One batch (a job's single pair) is returned as read.
    return batches.length === 1 ? batches[0]! : batches.flat();
  },
});

const pairKey = (mediaId: string, objectKey: string) =>
  JSON.stringify([mediaId, objectKey]);

const groupBy = <T>(rows: readonly T[], key: (row: T) => string) => {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    const list = groups.get(k);
    if (list) list.push(row);
    else groups.set(k, [row]);
  }
  return groups;
};

/** What App holds for one intent, read once and shared by every pair of it
 * a plan needs: for an earlier policy's released intent its still-published
 * pins, for a current one inspect's verdict and (only when private-ready) its
 * pins, keyed by pair. `null` for an earlier policy's intent that is not
 * released: it grants nothing and nothing of it is read. */
const readIntentFacts = async (
  intent: CatalogPlanIntent,
  reads: CatalogPlanReads,
  policy: string,
): Promise<((key: string) => CatalogIntentFacts) | null> => {
  if (intent.recipeManifestSha256 !== policy) {
    if (intent.state !== "released") return null;
    const prior = groupBy(await reads.priorPins(intent), (p) =>
      pairKey(p.media_id, p.object_key),
    );
    return (key) => ({ kind: "prior", pins: prior.get(key) ?? [] });
  }
  if (!(await reads.inspect(intent)).privateReady)
    return () => ({ kind: "current", privateReady: false, pins: [] });
  const pins = groupBy(await reads.pins(intent), (p) =>
    pairKey(p.media_id, p.object_key),
  );
  return (key) => ({
    kind: "current",
    privateReady: true,
    pins: pins.get(key) ?? [],
  });
};

/**
 * The whole Catalog's plan, the oracle the differential and scale tests
 * compare the per-asset and scoped plans against; no production path calls
 * it since the reconcile plans a bounded scope (catalog-scale-v1 W7). It is
 * the plan of every asset a complete snapshot names: each published pair,
 * and each member of a release_requested intent. App is read as before: per
 * intent in snapshot order, only for one that is requested or names a
 * public pair, then the selector rows of the published pairs once. Every row
 * is grouped by pair once and each asset is planned by planCatalogAsset over
 * its own rows: O(S + R) for S sources and R rows, never S x R. A pair the
 * published list names twice (two records) is one asset with one live
 * public permission. Permissions are grouped by asset, published pairs
 * first; each asset's come in intent order, then the public one. One clock
 * reading (`now`) serves the whole plan.
 */
export const planCatalogPermissions = async (
  snapshot: {
    readonly publishedSources: readonly {
      readonly mediaId: string;
      readonly objectKey: string;
    }[];
    readonly preparations?: readonly CatalogPlanIntent[];
  },
  reads: CatalogPlanReads,
  policy: string,
  now = Date.now(),
): Promise<CatalogAssetPermission[]> => {
  const assets = new Map<
    string,
    {
      readonly mediaId: string;
      readonly objectKey: string;
      readonly intents: CatalogAssetPlanInput["intents"][number][];
    }
  >();
  const assetOf = (mediaId: string, objectKey: string) => {
    const key = pairKey(mediaId, objectKey);
    let asset = assets.get(key);
    if (!asset) {
      asset = { mediaId, objectKey, intents: [] };
      assets.set(key, asset);
    }
    return asset;
  };
  const publicPairs = new Set<string>();
  for (const s of snapshot.publishedSources) {
    publicPairs.add(pairKey(s.mediaId, s.objectKey));
    assetOf(s.mediaId, s.objectKey);
  }
  for (const intent of snapshot.preparations ?? []) {
    const requested =
      intent.state === "release_requested" &&
      new Date(intent.expiresAt).getTime() > now;
    // The members this intent may grant something. An intent that is not
    // requested and names no public pair is not read; a requested one is,
    // even with an empty manifest, as it always was.
    const granted = intent.media.filter(
      (m) => requested || publicPairs.has(pairKey(m.mediaId, m.objectKey)),
    );
    if (!requested && !granted.length) continue;
    const facts = await readIntentFacts(intent, reads, policy);
    if (!facts) continue;
    for (const m of granted)
      assetOf(m.mediaId, m.objectKey).intents.push({
        intent,
        ordinal: m.ordinal,
        facts: facts(pairKey(m.mediaId, m.objectKey)),
      });
  }
  const renditions = groupBy(
    await reads.renditions(snapshot.publishedSources),
    (r) => pairKey(r.media_id, r.source_object_key),
  );
  const permissions: CatalogAssetPermission[] = [];
  for (const [key, asset] of assets)
    permissions.push(
      ...planCatalogAsset({
        ...asset,
        public: publicPairs.has(key),
        policy,
        now,
        renditions: renditions.get(key) ?? [],
      }),
    );
  return permissions;
};

/** The live rows of the given intents in the live private projection (CMS
 * migration M2), by primary key, and only rows that name a member: the view
 * gives members only to an intent that is released, or prepared or requested
 * within its lease. A job's capture and each of its fence checks run exactly
 * this read (catalog-scale-v1 W5), so their stamps compare like with like. */
export const catalogLiveIntentRowsSql = `SELECT * FROM public.catalog_delivery_live_prepare_media WHERE intent_id=ANY($1::uuid[]) AND media_ordinal IS NOT NULL ORDER BY intent_id,media_ordinal`;

/** Intents as the live projection holds them: the ones that decode, in id
 * order, and the ones that do not (F7: each is granted nothing). */
export interface CatalogLiveIntents {
  readonly intents: readonly CatalogPlanIntent[];
  readonly undecodableIntentIds: readonly string[];
}

/** The live intents among `intentIds` (catalogLiveIntentRowsSql). No intent,
 * no read. A failed read throws. */
const readLiveCatalogIntents = async (
  client: Pick<CatalogPool, "query">,
  intentIds: readonly string[],
): Promise<CatalogLiveIntents> =>
  intentIds.length
    ? partitionCatalogPrepareRows(
        (
          await client.query<Record<string, unknown>>(
            catalogLiveIntentRowsSql,
            [intentIds],
          )
        ).rows,
      )
    : { intents: [], undecodableIntentIds: [] };

/** A fence stamp: each live intent's document, lifecycle (a prepared or
 * requested one whose lease has passed reads as expired, as the mirror and
 * the view call it), version and manifests, and the intents that do not
 * decode. Capture and fence compare two stamps of the same read. */
const catalogIntentStamp = (live: CatalogLiveIntents, now: number) =>
  JSON.stringify([
    [...live.intents]
      .sort((a, b) => a.intentId.localeCompare(b.intentId))
      .map((p) => [
        p.intentId,
        p.documentId,
        ["prepared", "release_requested"].includes(p.state) &&
        new Date(p.expiresAt).getTime() <= now
          ? "expired"
          : p.state,
        p.stateVersion,
        p.manifestSha256,
        p.recipeManifestSha256,
        p.expiresAt,
      ]),
    [...live.undecodableIntentIds].sort(),
  ]);

/** One Catalog asset as a job (or a scope) captures it: its plan, and what
 * its fence re-reads. */
export interface CatalogAssetCapture {
  readonly assetId: string;
  /** The exact CMS pair, from the asset's App row (whose id the pair derives
   * by a CHECK); null without one, and then nothing is planned. */
  readonly pair: {
    readonly mediaId: string;
    readonly objectKey: string;
  } | null;
  /** Whether the published Catalog names the pair. */
  readonly public: boolean;
  /** Every intent App mirror members name for the asset, in id order. */
  readonly intentIds: readonly string[];
  /** Those of them the live projection holds as live. */
  readonly live: CatalogLiveIntents;
  readonly permissions: readonly CatalogAssetPermission[];
}

/**
 * The publication plans of the named Catalog assets, each from its own facts
 * only (catalog-scale-v1 W5): a job's acquire names one asset; a scoped
 * reconcile pass names a batch of its scope (planCatalogScope, W7). Per
 * call:
 * - App: the assets' rows (each pair, by primary key) and the intents App
 *   mirror members name for them (`catalog_delivery_media_refs` by asset);
 * - CMS, in one exported snapshot as the complete snapshot reads it: the
 *   exact check of only these pairs (publishedCatalogPairs, as a public read
 *   checks it), and only those intents' live rows by primary key
 *   (catalogLiveIntentRowsSql);
 * - App facts of only those intents, each read once whatever number of the
 *   assets it names, and the selector rows of only the public pairs.
 * Each asset is then planned by planCatalogAsset, as the whole-Catalog plan
 * plans it. An intent App does not know is not read: it grants nothing there
 * either (inspect needs its App header, an earlier policy's pins join its
 * App mirror). So the cost follows the assets named and their own intents,
 * never the Catalog, and no listing ceiling applies. Every read error
 * throws; no asset is ever planned from a partial read.
 */
export const captureCatalogAssets = async (
  pools: {
    readonly published: CatalogPool;
    readonly prepare: CatalogPool | null;
    readonly app: CatalogPool;
  },
  assetIds: readonly string[],
  reads: CatalogPlanReads,
  policy: string,
  now = Date.now(),
): Promise<ReadonlyMap<string, CatalogAssetCapture>> => {
  const ids = [...new Set(assetIds)];
  for (const id of ids)
    if (typeof id !== "string" || !/^catalog-asset-[a-f0-9]{32}$/.test(id))
      throw new TypeError("Catalog source identity invalid");
  const captures = new Map<string, CatalogAssetCapture>();
  if (!ids.length) return captures;
  const pairs = new Map(
    (
      await pools.app.query<{
        id: string;
        media_id: string;
        source_object_key: string;
      }>(
        "SELECT id,media_id,source_object_key FROM community.catalog_media_assets WHERE id=ANY($1::text[])",
        [ids],
      )
    ).rows.map((row) => [
      row.id,
      { mediaId: row.media_id, objectKey: row.source_object_key },
    ]),
  );
  // Without a prepare reader no intent is read, and none grants anything
  // (as a complete snapshot without one holds none).
  const known = new Map<string, string[]>();
  if (pools.prepare && pairs.size)
    for (const row of (
      await pools.app.query<{ asset_id: string; intent_id: string }>(
        "SELECT DISTINCT asset_id,intent_id FROM community.catalog_delivery_media_refs WHERE asset_id=ANY($1::text[]) ORDER BY asset_id,intent_id",
        [[...pairs.keys()]],
      )
    ).rows) {
      const list = known.get(row.asset_id);
      if (list) list.push(row.intent_id);
      else known.set(row.asset_id, [row.intent_id]);
    }
  const intentIds = [...new Set([...known.values()].flat())];
  const checkPairs = async (client: Pick<CatalogPool, "query">) => {
    const list = [...pairs.values()];
    const live = new Set<string>();
    for (let at = 0; at < list.length; at += CATALOG_PUBLISHED_PAIRS_MAX)
      for (const key of await publishedCatalogPairs(
        client,
        list.slice(at, at + CATALOG_PUBLISHED_PAIRS_MAX),
      ))
        live.add(key);
    return live;
  };
  let publicPairs: ReadonlySet<string> = new Set();
  let live: CatalogLiveIntents = { intents: [], undecodableIntentIds: [] };
  if (pools.prepare && intentIds.length) {
    const publicClient = await pools.published.connect();
    let privateClient;
    try {
      await publicClient.query(
        "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
      );
      publicPairs = await checkPairs(publicClient);
      const snapshot = (
        await publicClient.query<{ id: string }>(
          "SELECT pg_export_snapshot() AS id",
        )
      ).rows[0]!.id;
      if (!/^[a-f0-9]+-[a-f0-9]+-[a-f0-9]+$/i.test(snapshot))
        throw new Error("Catalog snapshot identifier invalid");
      privateClient = await pools.prepare.connect();
      await privateClient.query(
        "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
      );
      await privateClient.query(`SET TRANSACTION SNAPSHOT '${snapshot}'`);
      live = await readLiveCatalogIntents(privateClient, intentIds);
    } finally {
      if (privateClient) {
        await privateClient.query("ROLLBACK").catch(() => undefined);
        privateClient.release();
      }
      await publicClient.query("ROLLBACK").catch(() => undefined);
      publicClient.release();
    }
  } else if (pairs.size) publicPairs = await checkPairs(pools.published);
  const decoded = new Map(live.intents.map((i) => [i.intentId, i]));
  const undecodable = new Set(live.undecodableIntentIds);
  const facts = new Map<string, ((key: string) => CatalogIntentFacts) | null>();
  const planned: {
    readonly id: string;
    readonly pair: CatalogAssetCapture["pair"];
    readonly isPublic: boolean;
    readonly own: readonly string[];
    readonly intents: CatalogAssetPlanInput["intents"][number][];
  }[] = [];
  for (const id of ids) {
    const pair = pairs.get(id) ?? null;
    const own = known.get(id) ?? [];
    const key = pair ? pairKey(pair.mediaId, pair.objectKey) : "";
    const isPublic = !!pair && publicPairs.has(key);
    const intents: CatalogAssetPlanInput["intents"][number][] = [];
    if (pair)
      for (const intentId of own) {
        const intent = decoded.get(intentId);
        // A live intent that no longer names this pair grants it nothing.
        const members =
          intent?.media.filter(
            (m) => m.mediaId === pair.mediaId && m.objectKey === pair.objectKey,
          ) ?? [];
        if (!intent || !members.length) continue;
        const requested =
          intent.state === "release_requested" &&
          new Date(intent.expiresAt).getTime() > now;
        // Read only what the plan needs, as the whole-Catalog plan reads it:
        // a requested intent, or any intent of a public pair.
        if ((requested || isPublic) && !facts.has(intentId))
          facts.set(intentId, await readIntentFacts(intent, reads, policy));
        const read = facts.get(intentId);
        for (const m of members)
          intents.push({
            intent,
            ordinal: m.ordinal,
            ...(read ? { facts: read(key) } : {}),
          });
      }
    planned.push({ id, pair, isPublic, own, intents });
  }
  const selected = planned.flatMap((p) =>
    p.isPublic && p.pair ? [p.pair] : [],
  );
  const renditions = groupBy(
    selected.length ? await reads.renditions(selected) : [],
    (r) => pairKey(r.media_id, r.source_object_key),
  );
  for (const { id, pair, isPublic, own, intents } of planned)
    captures.set(id, {
      assetId: id,
      pair,
      public: isPublic,
      intentIds: own,
      live: {
        intents: own.flatMap((i) => decoded.get(i) ?? []),
        undecodableIntentIds: own.filter((i) => undecodable.has(i)),
      },
      permissions: pair
        ? planCatalogAsset({
            ...pair,
            public: isPublic,
            policy,
            now,
            intents,
            renditions:
              renditions.get(pairKey(pair.mediaId, pair.objectKey)) ?? [],
          })
        : [],
    });
  return captures;
};

/** Assets per capture of a scoped reconcile pass (planCatalogScope). Each
 * batch is one CMS snapshot, one App read of its assets' rows and intents,
 * and one selector statement (below CATALOG_PLAN_SELECTOR_BATCH), so a pass
 * of K assets takes about K / 100 snapshots, and the pass's budget is kept
 * to within about one batch's time. A snapshot per batch, not one per scope
 * (the design's wording), is what lets the budget stop between batches and a
 * failed batch be captured again asset by asset. Two batches may see
 * different CMS states; each asset is still planned from one snapshot, its
 * job re-plans it from the live CMS, and a mark made meanwhile outlives the
 * pass (the mark_seq clear). */
export const CATALOG_SCOPE_BATCH = 100;

/** Plan reads that read each intent's App facts once per pass, however many
 * batches name it. The key is every field of the intent a fact depends on,
 * so an intent whose state, version or lease differs in a later batch's
 * snapshot is read again; a failed read is not kept. */
const memoizedPlanReads = (reads: CatalogPlanReads): CatalogPlanReads => {
  const kept = new Map<string, Promise<unknown>>();
  const once = <T>(
    kind: string,
    intent: CatalogPlanIntent,
    read: () => Promise<T>,
  ): Promise<T> => {
    const key = JSON.stringify([
      kind,
      intent.intentId,
      intent.documentId,
      intent.state,
      intent.stateVersion,
      intent.manifestSha256,
      intent.recipeManifestSha256,
      intent.mediaCount,
      intent.expiresAt,
    ]);
    let value = kept.get(key) as Promise<T> | undefined;
    if (!value) {
      value = read();
      kept.set(key, value);
      value.catch(() => kept.delete(key));
    }
    return value;
  };
  return {
    inspect: (intent) => once("inspect", intent, () => reads.inspect(intent)),
    pins: (intent) => once("pins", intent, () => reads.pins(intent)),
    priorPins: (intent) => once("prior", intent, () => reads.priorPins(intent)),
    renditions: (sources) => reads.renditions(sources),
  };
};

/**
 * The plans of one scoped reconcile pass (catalog-scale-v1 W7): the named
 * assets in order, CATALOG_SCOPE_BATCH at a time, each batch captured as a
 * job captures its own asset (captureCatalogAssets: one CMS snapshot, the
 * assets' own App rows and intents), with each intent's App facts read once
 * per pass. Inspecting an intent records its pins' public generations, so
 * every intent of a planned asset that may grant it something has them
 * recorded again. A batch starts only while the longest batch so far still
 * fits in `budgetMs`, so the assets attempted are a prefix of the order and
 * the pass ends within its budget. A batch that throws is captured again
 * asset by asset: an asset whose plan throws is `failed` alone and the others
 * are planned; none is ever planned from a partial read. When every asset
 * attempted failed, the failure is the pass's (the CMS or App is unavailable)
 * and is thrown, as a whole-Catalog plan threw. A plan is the asset's desired
 * Catalog rendition IDs, the union of its permissions'.
 */
export const planCatalogScope = async (
  pools: Parameters<typeof captureCatalogAssets>[0],
  assetIds: readonly string[],
  reads: CatalogPlanReads,
  policy: string,
  options: { readonly budgetMs: number; readonly clock?: () => number },
): Promise<{
  readonly plans: ReadonlyMap<string, readonly string[]>;
  readonly failed: readonly string[];
}> => {
  if (!Number.isFinite(options.budgetMs) || options.budgetMs <= 0)
    throw new TypeError("Catalog scope budget invalid");
  const ids = [...new Set(assetIds)];
  for (const id of ids)
    if (typeof id !== "string" || !/^catalog-asset-[a-f0-9]{32}$/.test(id))
      throw new TypeError("Catalog source identity invalid");
  const clock = options.clock ?? Date.now;
  const started = clock();
  // A batch starts only while the longest one so far still fits, so the
  // pass ends within its budget instead of one batch past it.
  let longest = 0;
  const spent = (at: number) => at - started + longest >= options.budgetMs;
  const memo = memoizedPlanReads(reads);
  const plans = new Map<string, readonly string[]>();
  const failed: string[] = [];
  let failure: unknown;
  const capture = async (batch: readonly string[]) => {
    for (const [id, captured] of await captureCatalogAssets(
      pools,
      batch,
      memo,
      policy,
    ))
      plans.set(id, [
        ...new Set(captured.permissions.flatMap((p) => p.renditionIds)),
      ]);
  };
  scope: for (let at = 0; at < ids.length; at += CATALOG_SCOPE_BATCH) {
    const begun = clock();
    if (spent(begun)) break;
    const batch = ids.slice(at, at + CATALOG_SCOPE_BATCH);
    try {
      await capture(batch);
    } catch {
      for (const id of batch) {
        if (clock() - started >= options.budgetMs) break scope;
        try {
          await capture([id]);
        } catch (error) {
          failure ??= error;
          failed.push(id);
        }
      }
    }
    longest = Math.max(longest, clock() - begun);
  }
  if (failed.length && !plans.size) throw failure;
  return { plans, failed };
};

/**
 * The public rendition-fact lookup (`catalogFacts`) every reader shares
 * (Catalog, editorial, authored Article bodies, author cards): the live CMS
 * check of only the requested pairs on the public read pool (never the
 * prepare pool), then the App delivery projection of only the live ones, each
 * once (a Detail names its representative image twice, and the projection's
 * bound counts what it is handed). No Catalog image reads nothing, from
 * either database. A failed or refused check or App read, or an oversized
 * batch, is Catalog unavailability, the documented 503, never a 500
 * (catalog-delivery-release-hardening-v1 F9; catalog-scale-v1 1A).
 */
export const createCatalogDeliveryFacts =
  (published: CatalogPool, app: CatalogPool): CatalogDeliveryFacts =>
  async (locators) => {
    if (!locators.length) return new Map();
    try {
      const live = await publishedCatalogPairs(published, locators);
      const approved = new Map<string, (typeof locators)[number]>();
      for (const locator of locators) {
        const key = JSON.stringify([locator.mediaId, locator.objectKey]);
        if (live.has(key)) approved.set(key, locator);
      }
      if (!approved.size) return new Map();
      return await readCatalogDeliveryProjection(
        app,
        [...approved.values()],
        catalogExpectedRenditions,
      );
    } catch (error) {
      throw asCatalogQueryUnavailableError(error);
    }
  };
export const createCatalogReadiness =
  (prepare: CatalogPool, app: CatalogPool) => async (intentId: string) => {
    const rows = (
      await prepare.query(
        "SELECT * FROM public.catalog_delivery_prepare_media WHERE intent_id=$1 ORDER BY media_ordinal NULLS FIRST LIMIT 2001",
        [intentId],
      )
    ).rows;
    if (!rows.length) return null;
    const intents = parseCatalogPrepareRows(rows);
    if (intents.length !== 1)
      throw new Error("Catalog exact intent unavailable");
    return inspectCatalogDelivery(
      app,
      intents[0]!,
      currentCatalogRecipePolicy().recipeManifestSha256,
      catalogExpectedRenditions,
    );
  };

/** Admin publish gate for media that is already live: is the exact CMS source
 * (pair and bytes) a ready asset whose current-recipe set is complete, each
 * rendition ready on a committed blob with exactly one published Catalog
 * generation? The same whole-set facts the release proof requires, read with
 * the Backend's own App role. Metadata only; nothing is pinned or written.
 */
export const createCatalogPublishedRenditions =
  (app: CatalogPool) =>
  async (
    media: Parameters<CatalogPublishedRenditionsReader>[0],
  ): ReturnType<CatalogPublishedRenditionsReader> => {
    const rows = (
      await app.query<{
        media_id: string;
        source_object_key: string;
        master_width: number | null;
        master_height: number | null;
        role: string;
        recipe_version: number;
        recipe_digest: string;
        width: number;
        height: number;
      }>(
        `SELECT a.media_id,a.source_object_key,a.master_width,a.master_height,r.role,r.recipe_version,r.recipe_digest,r.width,r.height FROM jsonb_to_recordset($1::jsonb) m("mediaId" text,"objectKey" text,"sourceSha256" text) JOIN community.catalog_media_assets a ON a.media_id=m."mediaId" AND a.source_object_key=m."objectKey" AND a.state='ready' AND a.source_sha256=m."sourceSha256" AND a.master_sha256=m."sourceSha256" JOIN community.media_renditions r ON r.catalog_asset_id=a.id AND r.state='ready' AND r.edit_key='base' AND r.content_type='image/webp' JOIN community.media_blobs b ON b.id=r.blob_id AND b.state='committed' JOIN community.media_publications p ON p.rendition_id=r.id AND p.state='published' AND p.sha256=b.sha256 AND p.byte_size=b.byte_size AND p.storage_key=b.storage_key AND p.content_type='image/webp' AND p.purpose='catalog_derivative' LIMIT 40001`,
        [JSON.stringify(media)],
      )
    ).rows;
    if (rows.length > 40000) throw new Error("Catalog selector invalid");
    return {
      media: media.map(({ mediaId, objectKey }) => {
        const matches = rows.filter(
          (r) => r.media_id === mediaId && r.source_object_key === objectKey,
        );
        const asset = matches[0];
        const plan =
          asset?.master_width && asset.master_height
            ? catalogExpectedRenditions(asset.master_width, asset.master_height)
            : [];
        return {
          mediaId,
          objectKey,
          complete:
            plan.length > 0 &&
            plan.every(
              (want) =>
                matches.filter(
                  (r) =>
                    r.role === want.role &&
                    r.recipe_version === want.version &&
                    r.recipe_digest === want.digest &&
                    r.width === want.width &&
                    r.height === want.height,
                ).length === 1,
            ),
        };
      }),
    };
  };
