import { PostgresMediaPublicationAdapter } from "@moya/community-postgres";
import { describe, expect, it, vi } from "vitest";

import type { PublishingJobLease } from "@moya/api";

/*
 * catalog-scale-v1 (Issue #323) 1B W1: the publication adapter binds the
 * Catalog authority's selected rendition IDs as one text[] parameter of its
 * desired-set SQL (the reconcile, a job's own desired set and the item
 * lookup), never as SQL literals, so the selector has no 40,000 ceiling. A
 * malformed ID is still refused before the desired set is read. Synthetic
 * statements only; no database.
 */

const NOW = new Date("2126-10-22T00:00:00.000Z");
const rid = (n: number) =>
  `media-rendition-${n.toString(16).padStart(32, "0")}`;
/** More than the 40,000 IDs the inline selector refused. */
const SELECTED = Array.from({ length: 50_000 }, (_, i) => rid(i + 1));
const LITERAL = /media-rendition-[0-9a-f]{32}/u;

const harness = (selected: readonly string[] = SELECTED) => {
  const subject = `catalog-asset-${"1".repeat(32)}`;
  const statements: { sql: string; values: readonly unknown[] }[] = [];
  const query = vi.fn(async (sql: string, values: readonly unknown[] = []) => {
    statements.push({ sql, values });
    const rows = sql.startsWith("SELECT id FROM community.publishing_jobs")
      ? [{ id: "synthetic-job" }]
      : sql.startsWith("SELECT a.* FROM community.media_public_assets")
        ? [
            {
              id: "a".repeat(32),
              item_id: null,
              catalog_asset_id: subject,
              desired_seq: "1",
              lease_job_id: null,
              lease_job_owner: null,
              lease_sequence: null,
              lease_expires_at: null,
            },
          ]
        : [];
    return { rows, rowCount: rows.length };
  });
  const pool = {
    query,
    connect: vi.fn(async () => ({ query, release: vi.fn() })),
  };
  const port = new PostgresMediaPublicationAdapter(
    pool as unknown as ConstructorParameters<
      typeof PostgresMediaPublicationAdapter
    >[0],
    {
      isPublic: () => true,
      allowPublish: () => true,
      catalogAuthority: {
        copyRenditionIds: async () => selected,
        publishedAssetIds: async () => [],
        acquire: async () => ({
          renditionIds: selected,
          current: async () => true,
          authorized: async () => true,
          release: async () => undefined,
        }),
      },
    },
  );
  const job: PublishingJobLease = {
    id: "synthetic-job",
    leaseOwner: "synthetic-owner",
  };
  return { port, statements, subject, job };
};

describe("W1: the Catalog desired set binds its selected IDs", () => {
  it("reconciles with more than 40,000 selected IDs in one text[] parameter", async () => {
    const h = harness();
    expect(await h.port.reconcile(NOW, true, 10)).toEqual({
      publish: 0,
      withdraw: 0,
    });
    const reconcile = h.statements.find(({ sql }) =>
      sql.startsWith("WITH desired AS"),
    )!;
    expect(reconcile.sql).toContain("r.id=ANY($3::text[])");
    expect(reconcile.sql).not.toMatch(LITERAL);
    expect(reconcile.values).toEqual([10, true, SELECTED]);
  });

  it("binds a job's own captured IDs in its desired set", async () => {
    const h = harness();
    const plan = await h.port.planWithdrawal(h.subject, h.job, NOW);
    expect(plan.status).toBe("ready");
    const desired = h.statements.find(({ sql }) =>
      sql.startsWith("SELECT d.* FROM ("),
    )!;
    expect(desired.sql).toContain("r.id=ANY($3::text[])");
    expect(desired.sql).not.toMatch(LITERAL);
    expect(desired.values).toEqual([null, h.subject, SELECTED]);
  });

  it("binds an empty selection for item lookups", async () => {
    const h = harness();
    await h.port.lookupPublishedItems(["synthetic-item"], NOW);
    const lookup = h.statements.find(({ sql }) =>
      sql.startsWith("SELECT a.item_id,p.role"),
    )!;
    expect(lookup.sql).toContain("r.id=ANY($2::text[])");
    expect(lookup.values).toEqual([["synthetic-item"], []]);
  });

  it("refuses a malformed selected ID before the desired set is read", async () => {
    const h = harness([rid(1), "media-rendition-x'||'1"]);
    await expect(h.port.reconcile(NOW, true, 10)).rejects.toThrow(
      "Catalog selector invalid",
    );
    expect(
      h.statements.some(({ sql }) => sql.startsWith("WITH desired AS")),
    ).toBe(false);
  });
});
