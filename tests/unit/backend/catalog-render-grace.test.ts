import {
  CATALOG_PREPARE_RETENTION_HOURS,
  CATALOG_RENDER_GRACE_HOURS,
  CATALOG_RENDER_GRACE_MARGIN_HOURS,
  catalogRenderGraceReferenceSql,
  catalogRenderGraceSourcesSql,
} from "@moya/community-postgres";
import {
  CATALOG_PREPARE_RETENTION_HOURS as CMS_PREPARE_RETENTION_HOURS,
  upgradeCatalogDeliveryPrepareViewsSql,
} from "admin/published";
import { describe, expect, it } from "vitest";

/*
 * catalog-scale-v1 (Issue #323) 1B W10: render grace G and the retention R
 * of the CMS live private projection (Owner decision D3). An intent in grace
 * must still be in the live projection, so its App mirror is observed live
 * (and a newer intent of its document is mirrored) for the whole grace:
 * G <= R - 24 h, a named relation the community package enforces when it
 * loads. R is written by CMS migration M2 (admin) and read by the App
 * (community), two packages that must agree.
 */
describe("W10: render grace inside the prepare retention", () => {
  it("keeps G at least 24 hours inside R", () => {
    expect(CATALOG_RENDER_GRACE_MARGIN_HOURS).toBe(24);
    expect(CATALOG_RENDER_GRACE_HOURS).toBeLessThanOrEqual(
      CATALOG_PREPARE_RETENTION_HOURS - CATALOG_RENDER_GRACE_MARGIN_HOURS,
    );
    expect([
      CATALOG_RENDER_GRACE_HOURS,
      CATALOG_PREPARE_RETENTION_HOURS,
    ]).toEqual([72, 96]);
  });

  it("reads the R that CMS migration M2 writes into the live projection", () => {
    expect(CATALOG_PREPARE_RETENTION_HOURS).toBe(CMS_PREPARE_RETENTION_HOURS);
    expect(upgradeCatalogDeliveryPrepareViewsSql).toContain(
      `interval '${CATALOG_PREPARE_RETENTION_HOURS} hours'`,
    );
  });

  it("bounds the grace by G and a newer intent of the document, never by a permission", () => {
    for (const sql of [
      catalogRenderGraceReferenceSql("a.id"),
      catalogRenderGraceSourcesSql,
    ]) {
      expect(sql).toContain(`interval '${CATALOG_RENDER_GRACE_HOURS} hours'`);
      expect(sql).toMatch(/newer\.cms_document_id=gi\.cms_document_id/u);
      expect(sql).toMatch(/gi\.observed_live/u);
      // Render-only: no pin, approval or publication relation.
      expect(sql).not.toMatch(/rendition_pins|media_publications|approval/u);
    }
  });
});
