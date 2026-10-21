import { createHash } from "node:crypto";

import { parsePostgresConfig } from "@moya/catalog-postgres";
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

/** Separate CMS authority. Absent means private preparing is not connected;
 * even Development cannot borrow the public or App role. The real connection
 * is opened by composition only, with a single bounded client in its pool.
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
    return { ...config, max: 1 };
  } catch {
    throw new Error(
      "Catalog private prepare database configuration is invalid",
    );
  }
};

// All data below is metadata. No source reader, publication provider or HTTP
// request is involved. CMS identity and App facts remain separate connections.
import {
  inspectCatalogDelivery,
  parseCatalogPrepareRows,
  catalogBlockListedSql,
  type PostgresMediaPublicationAdapter,
} from "@moya/community-postgres";
import type { createPostgresPool } from "@moya/catalog-postgres";
import { listPublishedCatalogSources } from "./catalog.js";

type CatalogPool = ReturnType<typeof createPostgresPool>;
type CatalogAuthority = NonNullable<
  ConstructorParameters<
    typeof PostgresMediaPublicationAdapter
  >[1]["catalogAuthority"]
>;
const sourceAssetId = (mediaId: string, objectKey: string) =>
  `catalog-asset-${createHash("md5").update(`${mediaId}:${objectKey}`).digest("hex")}`;
const privateRowsSql = `SELECT * FROM public.catalog_delivery_prepare_media ORDER BY intent_id,media_ordinal NULLS FIRST LIMIT 20001`;

/** Both roles import exactly the same CMS MVCC snapshot, or refuse the entire
 * round. A local promise serializes capture+apply, while App's durable watermark
 * rejects an older complete snapshot from another process.
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
    const sources = await listPublishedCatalogSources(publicClient);
    if (sources === null) return null;
    let preparations: ReturnType<typeof parseCatalogPrepareRows> | undefined;
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
      preparations = parseCatalogPrepareRows(
        (await privateClient.query(privateRowsSql)).rows,
      );
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
    if (union.size > 10000) return null;
    return {
      sources: [...union.values()],
      publishedSources: sources,
      ...(preparations ? { preparations } : {}),
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
 */
export const createCatalogPublicationAuthority = (
  published: CatalogPool,
  prepare: CatalogPool | null,
  app: CatalogPool,
): CatalogAuthority => {
  const publicIds = async () => {
    const sources = await listPublishedCatalogSources(published);
    if (!sources) throw new Error("Catalog published source incomplete");
    return sources.map((s) => sourceAssetId(s.mediaId, s.objectKey));
  };
  const plans = async () => {
    const snapshot = await readCatalogSourceSnapshot(published, prepare);
    if (!snapshot) throw new Error("Catalog complete source unavailable");
    const publicPairs = new Set(
      snapshot.publishedSources.map((s) =>
        JSON.stringify([s.mediaId, s.objectKey]),
      ),
    );
    const policy = currentCatalogRecipePolicy().recipeManifestSha256;
    const permissions: {
      assetId: string;
      documentId: number | null;
      intentId: string | null;
      stateVersion: number;
      manifestSha256: string;
      policy: string;
      published: boolean;
      renditionIds: string[];
    }[] = [];
    for (const intent of snapshot.preparations ?? []) {
      const requested =
        intent.state === "release_requested" &&
        new Date(intent.expiresAt).getTime() > Date.now();
      if (
        !requested &&
        !intent.media.some((m) =>
          publicPairs.has(JSON.stringify([m.mediaId, m.objectKey])),
        )
      )
        continue;
      if (intent.recipeManifestSha256 !== policy) {
        if (intent.state === "released") {
          const prior = (
            await app.query<{
              rendition_id: string;
              media_id: string;
              object_key: string;
            }>(
              `SELECT pp.rendition_id,m.media_id,m.object_key FROM community.catalog_delivery_rendition_pins pp JOIN community.catalog_delivery_prepares i ON i.intent_id=pp.intent_id JOIN community.catalog_delivery_media_refs m ON m.intent_id=pp.intent_id AND m.ordinal=pp.ordinal JOIN community.media_renditions r ON r.id=pp.rendition_id JOIN community.media_blobs b ON b.id=r.blob_id AND b.state='committed' JOIN community.media_publications p ON p.id=pp.public_generation_id AND p.version=pp.public_generation_version AND p.rendition_id=r.id AND p.state='published' AND p.sha256=b.sha256 AND p.byte_size=b.byte_size AND p.storage_key=b.storage_key WHERE pp.intent_id=$1 AND i.manifest_sha256=$2 AND i.recipe_manifest_sha256=$3 ORDER BY pp.ordinal,pp.role`,
              [
                intent.intentId,
                intent.manifestSha256,
                intent.recipeManifestSha256,
              ],
            )
          ).rows;
          for (const media of intent.media)
            if (
              publicPairs.has(JSON.stringify([media.mediaId, media.objectKey]))
            )
              permissions.push({
                assetId: sourceAssetId(media.mediaId, media.objectKey),
                documentId: intent.documentId,
                intentId: null,
                stateVersion: intent.stateVersion,
                manifestSha256: intent.manifestSha256,
                policy: intent.recipeManifestSha256,
                published: true,
                renditionIds: prior
                  .filter(
                    (p) =>
                      p.media_id === media.mediaId &&
                      p.object_key === media.objectKey,
                  )
                  .map((p) => p.rendition_id),
              });
        }
        continue;
      }
      const facts = await inspectCatalogDelivery(
        app,
        intent,
        policy,
        catalogExpectedRenditions,
      );
      if (!facts.privateReady) continue;
      const pins = (
        await app.query<{
          rendition_id: string;
          media_id: string;
          object_key: string;
          role: string;
          recipe_version: number;
          recipe_digest: string;
          width: number;
          height: number;
          master_width: number;
          master_height: number;
        }>(
          `SELECT p.rendition_id,m.media_id,m.object_key,p.role,p.recipe_version,p.recipe_digest,r.width,r.height,a.master_width,a.master_height FROM community.catalog_delivery_rendition_pins p JOIN community.catalog_delivery_media_refs m ON m.intent_id=p.intent_id AND m.ordinal=p.ordinal JOIN community.media_renditions r ON r.id=p.rendition_id JOIN community.catalog_media_assets a ON a.id=r.catalog_asset_id WHERE p.intent_id=$1 ORDER BY p.ordinal,p.role`,
          [intent.intentId],
        )
      ).rows;
      for (const media of intent.media) {
        const isPublished = publicPairs.has(
          JSON.stringify([media.mediaId, media.objectKey]),
        );
        if (!requested && !isPublished) continue;
        permissions.push({
          assetId: sourceAssetId(media.mediaId, media.objectKey),
          documentId: intent.documentId,
          intentId: requested ? intent.intentId : null,
          stateVersion: intent.stateVersion,
          manifestSha256: intent.manifestSha256,
          policy,
          published: isPublished,
          renditionIds: pins
            .filter(
              (p) =>
                p.media_id === media.mediaId &&
                p.object_key === media.objectKey &&
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
    }
    const publicReady = (
      await app.query<{
        id: string;
        media_id: string;
        source_object_key: string;
        role: string;
        recipe_version: number;
        recipe_digest: string;
        width: number;
        height: number;
        master_width: number;
        master_height: number;
      }>(
        `SELECT DISTINCT r.id,a.media_id,a.source_object_key,a.master_width,a.master_height,r.role,r.recipe_version,r.recipe_digest,r.width,r.height FROM jsonb_to_recordset($1::jsonb) p("mediaId" text,"objectKey" text) JOIN community.catalog_media_assets a ON a.media_id=p."mediaId" AND a.source_object_key=p."objectKey" AND a.state='ready' JOIN community.media_renditions r ON r.catalog_asset_id=a.id AND r.state='ready' JOIN community.media_blobs b ON b.id=r.blob_id AND b.state='committed' WHERE r.edit_key='base' AND (r.role IN ('thumb','cover','display','viewer','full') OR (r.catalog_master_id IS NOT NULL AND ${catalogBlockListedSql("r")})) LIMIT 40001`,
        [JSON.stringify(snapshot.publishedSources)],
      )
    ).rows;
    if (publicReady.length > 40000) throw new Error("Catalog selector invalid");
    for (const source of snapshot.publishedSources) {
      const matches = publicReady.filter(
        (r) =>
          r.media_id === source.mediaId &&
          r.source_object_key === source.objectKey,
      );
      const ids = matches
        .filter(
          (r) =>
            // Blocks have already passed the shared active-master/cell SQL.
            // Only current public CMS pairs reach this branch; private B
            // continues to authorize its four ordinary immutable pins only.
            /^block-[0-9]{2}$/u.test(r.role) ||
            !source.objectKey.startsWith("editorial/") ||
            (r.master_width &&
              r.master_height &&
              catalogExpectedRenditions(r.master_width, r.master_height).some(
                (want) =>
                  want.role === r.role &&
                  want.version === r.recipe_version &&
                  want.digest === r.recipe_digest &&
                  want.width === r.width &&
                  want.height === r.height,
              )),
        )
        .map((r) => r.id);
      // Existing live Native A needs no newly created B intent. A without an
      // intent/document ID retains live-public pre-copy/commit checks; only
      // private requested B claims the stronger CMS document lease boundary.
      permissions.push({
        assetId: sourceAssetId(source.mediaId, source.objectKey),
        documentId: null,
        intentId: null,
        stateVersion: 0,
        manifestSha256: "",
        policy: "",
        published: true,
        renditionIds: ids,
      });
    }
    return { permissions, snapshot };
  };
  return {
    async publishedAssetIds(ids) {
      const live = new Set(await publicIds());
      return ids.filter((id) => live.has(id));
    },
    async copyRenditionIds() {
      return [
        ...new Set((await plans()).permissions.flatMap((p) => p.renditionIds)),
      ];
    },
    async acquire(assetId) {
      if (!/^catalog-asset-[a-f0-9]{32}$/.test(assetId))
        throw new Error("Catalog source identity invalid");
      // Resolve immutable App facts before holding a CMS connection. No App row
      // lock is held while acquiring the shared Native document lock.
      const captured = await plans();
      const permissions = captured.permissions.filter(
        (p) => p.assetId === assetId,
      );
      const knownIntentIds = (
        await app.query<{ intent_id: string }>(
          "SELECT DISTINCT intent_id FROM community.catalog_delivery_media_refs WHERE asset_id=$1",
          [assetId],
        )
      ).rows.map((r) => r.intent_id);
      const contexts = (captured.snapshot.preparations ?? []).filter(
        (p) =>
          knownIntentIds.includes(p.intentId) ||
          p.media.some(
            (m) => sourceAssetId(m.mediaId, m.objectKey) === assetId,
          ),
      );
      const stamp = (
        rows: readonly {
          intentId: string;
          documentId: number;
          state: string;
          stateVersion: number;
          manifestSha256: string;
          recipeManifestSha256: string;
          expiresAt: string;
        }[],
      ) =>
        JSON.stringify(
          [...rows]
            .sort((a, b) => a.intentId.localeCompare(b.intentId))
            .map((p) => [
              p.intentId,
              p.documentId,
              p.state === "released"
                ? p.state
                : new Date(p.expiresAt).getTime() <= Date.now() &&
                    ["prepared", "release_requested"].includes(p.state)
                  ? "expired"
                  : p.state,
              p.stateVersion,
              p.manifestSha256,
              p.recipeManifestSha256,
              p.expiresAt,
            ]),
        );
      const capturedStamp = stamp(contexts);
      const renditionIds = [
        ...new Set(permissions.flatMap((p) => p.renditionIds)),
      ];
      const client = prepare ? await prepare.connect() : null;
      let finished = false;
      const release = async () => {
        if (!finished) {
          finished = true;
          if (client) {
            await client.query("ROLLBACK").catch(() => undefined);
            client.release();
          }
        }
      };
      try {
        if (client) {
          await client.query("BEGIN READ ONLY");
          await client.query("SET LOCAL lock_timeout='5s'");
          for (const documentId of [
            ...new Set(contexts.map((p) => p.documentId)),
          ].sort((a, b) => a - b))
            await client.query(
              "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
              [`moya-editorial:document:${documentId}`],
            );
        }
        const current = async () => {
          if (finished) return false;
          if (!client) return true; // Legacy live A retains its weaker live-public fence.
          const rows = (
            await client.query(
              `SELECT DISTINCT intent_id,catalog_document_id,state,state_version,media_manifest_sha256,recipe_manifest_sha256,expires_at FROM public.catalog_delivery_prepare_media WHERE intent_id=ANY($1::uuid[]) OR (media_ordinal IS NOT NULL AND 'catalog-asset-'||md5(media_id||':'||object_key)=$2) ORDER BY intent_id`,
              [
                [
                  ...new Set([
                    ...knownIntentIds,
                    ...contexts.map((p) => p.intentId),
                  ]),
                ],
                assetId,
              ],
            )
          ).rows;
          return (
            capturedStamp ===
            stamp(
              rows.map((p) => ({
                intentId: p.intent_id,
                documentId: p.catalog_document_id,
                state: p.state,
                stateVersion: p.state_version,
                manifestSha256: p.media_manifest_sha256,
                recipeManifestSha256: p.recipe_manifest_sha256,
                expiresAt: new Date(p.expires_at).toISOString(),
              })),
            )
          );
        };
        return {
          renditionIds,
          release,
          current,
          async authorized() {
            if (!(await current()) || !permissions.length) return false;
            const publicLive = (await publicIds()).includes(assetId);
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
