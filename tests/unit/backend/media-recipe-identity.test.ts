import { readFile } from "node:fs/promises";

import {
  LONG_SCROLL_ASPECT_RATIO,
  MOTION_COLOR,
  MOTION_DERIVATIVE,
  PROFILE_FAMILIES,
  PROFILE_ROLES as REGISTRY_PROFILE_ROLES,
  RECIPE_DIGESTS_V1,
  RECIPE_PARAMETERS_V1,
  RENDITION_ROLES as REGISTRY_ROLES,
  STILL_INPUT_LIMITS,
  canonicalRecipeJson,
  recipeDigest,
} from "@moya/backend-production/internal/publishing-processing";
import {
  ADOPTED_DERIVATIVE_ROLES,
  PROFILE_RENDITION_ROLES,
  RECIPE_DIGEST_PATTERN,
  RENDITION_ROLES,
  USER_PURGE_HOLDS_PRE_TASK_BLOBS,
  isProfileRenditionRole,
  isRenditionRole,
} from "@moya/community-postgres";
import { publishingJobKindSchema } from "@moya/contracts/internal/community-operator";
import {
  PROFILE_MEDIA_RENDITION_ROLES,
  profileMediaFamilyOf,
} from "@moya/contracts/schemas";
import { describe, expect, it } from "vitest";

/*
 * Rendition recipe identity version 1 (unified-media-pipeline-v1): the one
 * registry (backend-production `recipes.ts`) is the only source of
 * parameters and digests; the store keeps only the recorded form. Covered
 * here: the literal digests migration 20261004010000 adopts existing
 * derivatives with, the store's role list, the profile roles the contracts,
 * the registry and the store each name, the role and job kind lists each
 * migration restates, and parity of the version 1 parameters with the
 * pre-task processing profiles (the adopted bytes are what they produce).
 */

const migration = await readFile(
  new URL(
    "../../../database/community-migrations/20261004010000_unified_media_renditions.sql",
    import.meta.url,
  ),
  "utf8",
);
const publicationMigration = await readFile(
  new URL(
    "../../../database/community-migrations/20261008010000_media_publication.sql",
    import.meta.url,
  ),
  "utf8",
);
const profileMigration = await readFile(
  new URL(
    "../../../database/community-migrations/20261014010000_profile_media_renditions.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("rendition recipe identity, version 1", () => {
  it("records the registry's roles and identity form only", () => {
    expect([...RENDITION_ROLES].sort()).toEqual([...REGISTRY_ROLES].sort());
    for (const role of RENDITION_ROLES) {
      expect(isRenditionRole(role)).toBe(true);
      expect(RECIPE_DIGESTS_V1[role]).toMatch(RECIPE_DIGEST_PATTERN);
    }
    expect(isRenditionRole("tiles")).toBe(false);
    expect(RECIPE_DIGEST_PATTERN.test("0123456789ABCDEF")).toBe(false);
  });

  it("reconciles the profile roles of the contracts, the registry and the store", () => {
    // The registry keeps its own list: backend-production does not depend on
    // the contracts.
    expect([...REGISTRY_PROFILE_ROLES]).toEqual([
      ...PROFILE_MEDIA_RENDITION_ROLES,
    ]);
    expect([...PROFILE_RENDITION_ROLES]).toEqual([
      ...PROFILE_MEDIA_RENDITION_ROLES,
    ]);
    expect(RENDITION_ROLES.slice(-PROFILE_RENDITION_ROLES.length)).toEqual([
      ...PROFILE_RENDITION_ROLES,
    ]);
    for (const [family, { anchor, roles }] of Object.entries(
      PROFILE_FAMILIES,
    )) {
      expect(roles[0], family).toBe(anchor);
      for (const role of roles) expect(profileMediaFamilyOf(role)).toBe(family);
    }
    expect(
      Object.values(PROFILE_FAMILIES)
        .flatMap((entry) => entry.roles)
        .sort(),
    ).toEqual([...PROFILE_MEDIA_RENDITION_ROLES].sort());
    for (const role of RENDITION_ROLES)
      expect(isProfileRenditionRole(role), role).toBe(
        (PROFILE_MEDIA_RENDITION_ROLES as readonly string[]).includes(role),
      );
  });

  it("hashes canonical JSON independent of key order and refuses non-finite numbers", () => {
    expect(canonicalRecipeJson({ b: [2, { d: null, c: "x" }], a: true })).toBe(
      '{"a":true,"b":[2,{"c":"x","d":null}]}',
    );
    expect(recipeDigest({ b: 1, a: 2 })).toBe(recipeDigest({ a: 2, b: 1 }));
    expect(recipeDigest({ a: 1 })).toMatch(/^[0-9a-f]{16}$/u);
    expect(() => canonicalRecipeJson({ a: Number.NaN })).toThrow(TypeError);
    expect(() => canonicalRecipeJson({ a: Number.POSITIVE_INFINITY })).toThrow(
      TypeError,
    );
  });

  it("keeps version 1 equal to the pre-task processing profiles the adopted bytes came from", () => {
    // The pre-task static profiles (profiles.ts before increment 1).
    const pretask = {
      thumb: { quality: 80, maxLongEdge: 480 },
      display: { quality: 86, maxLongEdge: 2048 },
      full: { quality: 90, maxLongEdge: 8192 },
      cover: { quality: 86, maxLongEdge: 1080 },
    } as const;
    for (const role of ["thumb", "display", "full", "cover"] as const)
      expect(RECIPE_PARAMETERS_V1[role], role).toMatchObject(pretask[role]);
    expect(RECIPE_PARAMETERS_V1.thumb.framing).toBe("card");
    expect(RECIPE_PARAMETERS_V1.cover.framing).toBe("card");
    expect(RECIPE_PARAMETERS_V1.display.longScroll).toEqual({
      aspectRatio: LONG_SCROLL_ASPECT_RATIO,
      maxShortEdge: 1280,
      maxLongEdge: 16_000,
      maxPixels: 20_000_000,
    });
    expect(RECIPE_PARAMETERS_V1.full.longScroll).toEqual({
      aspectRatio: LONG_SCROLL_ASPECT_RATIO,
      maxShortEdge: null,
      maxLongEdge: 16_000,
      maxPixels: 40_000_000,
    });
    expect(RECIPE_PARAMETERS_V1.full.pipeline.decode).toEqual(
      STILL_INPUT_LIMITS,
    );
    const motion = RECIPE_PARAMETERS_V1.motion;
    expect({
      videoCodec: motion.video.codec,
      videoProfile: motion.video.profile,
      preset: motion.video.preset,
      crf: motion.video.crf,
      pixelFormat: motion.video.pixelFormat,
      maxLongEdge: motion.video.maxLongEdge,
      audioCodec: motion.audio.codec,
      audioBitrate: motion.audio.bitrate,
    }).toEqual({
      videoCodec: MOTION_DERIVATIVE.videoCodec,
      videoProfile: MOTION_DERIVATIVE.videoProfile,
      preset: MOTION_DERIVATIVE.preset,
      crf: MOTION_DERIVATIVE.crf,
      pixelFormat: MOTION_DERIVATIVE.pixelFormat,
      maxLongEdge: MOTION_DERIVATIVE.maxLongEdge,
      audioCodec: MOTION_DERIVATIVE.audioCodec,
      audioBitrate: MOTION_DERIVATIVE.audioBitrate,
    });
    expect(motion.colour).toMatchObject({
      outputPrimaries: MOTION_COLOR.outputPrimaries,
      outputTransfer: MOTION_COLOR.outputTransfer,
      outputMatrix: MOTION_COLOR.outputMatrix,
      outputRange: MOTION_COLOR.outputRange,
      nominalPeakNits: MOTION_COLOR.nominalPeakNits,
      toneMapOperator: MOTION_COLOR.toneMapOperator,
      hdrTransfers: MOTION_COLOR.hdrTransfers,
    });
    // The new bounded viewer never exceeds full.
    const viewer = RECIPE_PARAMETERS_V1.viewer;
    expect(viewer.maxLongEdge).toBeLessThan(
      RECIPE_PARAMETERS_V1.full.maxLongEdge,
    );
    expect(viewer.longScroll.maxPixels).toBeLessThanOrEqual(
      RECIPE_PARAMETERS_V1.full.longScroll.maxPixels,
    );
  });

  it("matches the literals migration 20261004010000 adopts and the lists each migration checks", () => {
    const adopted = Object.fromEntries(
      [...migration.matchAll(/WHEN '([a-z]+)' THEN '([0-9a-f]{16})'/gu)].map(
        (match) => [match[1], match[2]],
      ),
    );
    expect(adopted).toEqual(
      Object.fromEntries(
        ADOPTED_DERIVATIVE_ROLES.map((role) => [role, RECIPE_DIGESTS_V1[role]]),
      ),
    );
    const listed = (constraint: string, source = migration): string[] => {
      const start = source.indexOf(`CONSTRAINT ${constraint} CHECK`);
      expect(start, constraint).toBeGreaterThan(-1);
      const body = /CHECK\s*\(\s*(?:role|kind)\s+IN\s*\(([^)]*)\)/u.exec(
        source.slice(start),
      )?.[1];
      expect(body, constraint).toBeDefined();
      return [...body!.matchAll(/'([a-z0-9_-]+)'/gu)].map((match) => match[1]!);
    };
    // The roles before the profile roles (increment 3a).
    expect(listed("media_renditions_role_valid")).toEqual([
      "thumb",
      "cover",
      "display",
      "viewer",
      "full",
      "motion",
    ]);
    expect(listed("publishing_jobs_kind_valid")).toEqual([
      "process_item",
      "derive_edit",
      "purge_item",
      "purge_blob",
      "expire_session",
      "purge_trashed_work",
      "sweep_staging",
      "reconcile_capacity",
      "catalog_render",
    ]);
    // The kinds before profile rendering (increment 3a).
    expect(listed("publishing_jobs_kind_valid", publicationMigration)).toEqual([
      "process_item",
      "derive_edit",
      "purge_item",
      "purge_blob",
      "expire_session",
      "purge_trashed_work",
      "sweep_staging",
      "reconcile_capacity",
      "catalog_render",
      "publish_media",
      "withdraw_media",
      "verify_withdrawal",
      "reconcile_publication",
      "sweep_published",
    ]);
    // Migration 20261014010000 restates both complete lists.
    expect(listed("media_renditions_role_valid", profileMigration)).toEqual([
      ...RENDITION_ROLES,
    ]);
    expect(listed("publishing_jobs_kind_valid", profileMigration)).toEqual(
      publishingJobKindSchema.options,
    );
    const profileRoles =
      /CONSTRAINT media_renditions_profile_roles CHECK[^;]*?\brole\s+IN\s*\(([^)]*)\)/u.exec(
        profileMigration,
      )?.[1];
    expect(profileRoles).toBeDefined();
    expect(
      [...profileRoles!.matchAll(/'([a-z0-9_-]+)'/gu)].map((match) => match[1]),
    ).toEqual([...PROFILE_RENDITION_ROLES]);
  });

  it("keeps user-initiated purges as today (Owner answer Q4)", () => {
    expect(USER_PURGE_HOLDS_PRE_TASK_BLOBS).toBe(false);
  });
});
