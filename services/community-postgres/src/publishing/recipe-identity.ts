/*
 * Rendition recipe identity as the community store records it (unified media
 * pipeline, increment 1). Pure: no database, no image library. A rendition
 * row names its recipe by role, version and digest. The one recipe registry
 * is `services/backend-production/src/publishing/processing/recipes.ts`: the
 * processor renders with it and names what it rendered; the store only
 * validates the form and never computes, defaults or compares parameters.
 * Migration 20261004010000 adopts every existing derivative row as version 1
 * of its role with the registry's literal digests (a unit test pins them).
 */

/** Rendition roles the `media_renditions_role_valid` CHECK admits. */
export const RENDITION_ROLES = [
  "thumb",
  "cover",
  "display",
  "viewer",
  "full",
  "motion",
] as const;
export type RenditionRole = (typeof RENDITION_ROLES)[number];

/** The roles `media_derivatives` holds; migration 20261004010000 copies these. */
export const ADOPTED_DERIVATIVE_ROLES = [
  "thumb",
  "display",
  "full",
  "motion",
  "cover",
] as const satisfies readonly RenditionRole[];

/** `media_renditions.recipe_digest` format. */
export const RECIPE_DIGEST_PATTERN = /^[0-9a-f]{16}$/u;

export interface RecipeIdentity {
  readonly role: RenditionRole;
  /** Integer ≥ 1, bumped in the registry whenever an output-affecting parameter changes. */
  readonly version: number;
  /** First 16 hex characters of the registry's parameter digest. */
  readonly digest: string;
}

export const isRenditionRole = (value: unknown): value is RenditionRole =>
  typeof value === "string" &&
  (RENDITION_ROLES as readonly string[]).includes(value);
