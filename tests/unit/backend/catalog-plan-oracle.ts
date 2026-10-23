import { createHash } from "node:crypto";

import { catalogExpectedRenditions } from "@moya/backend-production/internal/catalog-delivery";
import {
  catalogBlockListedSql,
  inspectCatalogDelivery,
} from "@moya/community-postgres";

import type {
  CatalogIntentPin,
  CatalogPlanReads,
  CatalogPriorPin,
  CatalogSelectorRendition,
  planCatalogPermissions,
} from "@moya/backend-production/internal/catalog-delivery";

/*
 * The differential oracle of catalog-scale-v1 (Issue #323) W1: the #320
 * Catalog plan (createCatalogPublicationAuthority's plans(), as of d51114c5),
 * kept apart from the code under test. previousCatalogPlan is its planning
 * after the snapshot read, verbatim but for its App reads, which go through a
 * CatalogPlanReads, and one clock reading for the whole plan: every published
 * source filters every selector row (S x R). previousCatalogPlanReads are its
 * App reads, verbatim.
 */

const assetOf = (mediaId: string, objectKey: string) =>
  `catalog-asset-${createHash("md5").update(`${mediaId}:${objectKey}`).digest("hex")}`;

export const previousCatalogPlan = async (
  snapshot: Parameters<typeof planCatalogPermissions>[0],
  reads: CatalogPlanReads,
  policy: string,
  now: number,
) => {
  const publicPairs = new Set(
    snapshot.publishedSources.map((s) =>
      JSON.stringify([s.mediaId, s.objectKey]),
    ),
  );
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
      new Date(intent.expiresAt).getTime() > now;
    if (
      !requested &&
      !intent.media.some((m) =>
        publicPairs.has(JSON.stringify([m.mediaId, m.objectKey])),
      )
    )
      continue;
    if (intent.recipeManifestSha256 !== policy) {
      if (intent.state === "released") {
        const prior = await reads.priorPins(intent);
        for (const media of intent.media)
          if (publicPairs.has(JSON.stringify([media.mediaId, media.objectKey])))
            permissions.push({
              assetId: assetOf(media.mediaId, media.objectKey),
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
    const facts = await reads.inspect(intent);
    if (!facts.privateReady) continue;
    const pins = await reads.pins(intent);
    for (const media of intent.media) {
      const isPublished = publicPairs.has(
        JSON.stringify([media.mediaId, media.objectKey]),
      );
      if (!requested && !isPublished) continue;
      permissions.push({
        assetId: assetOf(media.mediaId, media.objectKey),
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
  const publicReady = await reads.renditions(snapshot.publishedSources);
  for (const source of snapshot.publishedSources) {
    const matches = publicReady.filter(
      (r) =>
        r.media_id === source.mediaId &&
        r.source_object_key === source.objectKey,
    );
    const current = (r: (typeof matches)[number]) =>
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
    const replaced =
      plan.length > 0 &&
      plan.every(
        (want) =>
          matches.filter(
            (r) => r.role === want.role && current(r) && r.published,
          ).length === 1,
      );
    const ids = matches
      .filter(
        (r) =>
          /^block-[0-9]{2}$/u.test(r.role) ||
          !source.objectKey.startsWith("editorial/") ||
          (replaced
            ? current(r)
            : plan.length > 0 &&
              ["thumb", "cover", "display", "viewer"].includes(r.role) &&
              (r.state === "ready" || r.published)),
      )
      .map((r) => r.id);
    permissions.push({
      assetId: assetOf(source.mediaId, source.objectKey),
      documentId: null,
      intentId: null,
      stateVersion: 0,
      manifestSha256: "",
      policy: "",
      published: true,
      renditionIds: ids,
    });
  }
  return permissions;
};

export const previousCatalogPlanReads = (
  app: Parameters<typeof inspectCatalogDelivery>[0],
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
  renditions: async (sources) => {
    const rows = (
      await app.query<CatalogSelectorRendition>(
        `SELECT DISTINCT r.id,a.media_id,a.source_object_key,a.master_width,a.master_height,r.role,r.recipe_version,r.recipe_digest,r.width,r.height,r.state,pub.published FROM jsonb_to_recordset($1::jsonb) p("mediaId" text,"objectKey" text) JOIN community.catalog_media_assets a ON a.media_id=p."mediaId" AND a.source_object_key=p."objectKey" AND a.state='ready' JOIN community.media_renditions r ON r.catalog_asset_id=a.id JOIN community.media_blobs b ON b.id=r.blob_id AND b.state='committed' CROSS JOIN LATERAL (SELECT r.role IN ('thumb','cover','display','viewer') AND EXISTS (SELECT 1 FROM community.media_publications pp WHERE pp.rendition_id=r.id AND pp.state='published' AND pp.sha256=b.sha256 AND pp.byte_size=b.byte_size AND pp.storage_key=b.storage_key AND pp.content_type=r.content_type AND pp.purpose='catalog_derivative') AS published) pub WHERE r.edit_key='base' AND (r.state='ready' OR (pub.published AND a.source_object_key LIKE 'editorial/%')) AND (r.role IN ('thumb','cover','display','viewer','full') OR (r.catalog_master_id IS NOT NULL AND ${catalogBlockListedSql("r")})) LIMIT 40001`,
        [JSON.stringify(sources)],
      )
    ).rows;
    if (rows.length > 40000) throw new Error("Catalog selector invalid");
    return rows;
  },
});
