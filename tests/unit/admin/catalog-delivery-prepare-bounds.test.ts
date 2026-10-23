import { catalogProcessingIntentSchema } from "@moya/contracts/internal/editorial";
import type { PayloadRequest } from "payload";
import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * catalog-delivery-release-hardening-v1 (Issue #317) F7: Admin accepts any
 * upload up to 80 MP, but the private processing snapshot and the App media
 * reference CHECK bound each source edge at 65,535 px. Prepare refuses a
 * longer edge with a clear category before it writes any intent or receipt.
 * The transaction, policy and media lookups are synthetic stand-ins.
 */

const state = vi.hoisted(() => ({
  media: [] as { width: number; height: number }[],
  statements: [] as string[],
}));
const db = vi.hoisted(() => ({
  execute: vi.fn(async (query: { queryChunks?: unknown[] }) => {
    const text = (query.queryChunks ?? [])
      .flatMap((chunk) =>
        Array.isArray((chunk as { value?: unknown }).value)
          ? ((chunk as { value: string[] }).value ?? [])
          : [],
      )
      .join("?");
    state.statements.push(text);
    return { rows: [] };
  }),
}));
vi.mock("../../../apps/admin/src/editorial/transaction", () => ({
  editorialTransaction: async () => db,
  lockEditorialKey: async () => undefined,
  withEditorialTransaction: async (_req: unknown, work: () => unknown) =>
    work(),
}));
vi.mock(
  "../../../apps/admin/src/editorial/catalog-delivery-backend",
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    readCatalogRecipePolicy: async () => null,
  }),
);
vi.mock("../../../apps/admin/src/media/validation", () => ({
  validateCatalogMedia: async () => undefined,
}));
vi.mock(
  "../../../apps/admin/src/editorial/content",
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    contentFingerprint: () => "f".repeat(64),
    draftContent: () => ({
      catalogId: "synthetic-catalog",
      media: state.media.map((size, position) => ({
        mediaId: `synthetic-media-${position}`,
        objectKey: `editorial/${"a".repeat(64)}/${"b".repeat(64)}-${String(position).repeat(64).slice(0, 64)}.png`,
        alt: "Synthetic media",
        position,
        isRepresentative: position === 0,
        ...size,
      })),
    }),
  }),
);

import { EditorialError, prepareCatalogDelivery } from "admin/editorial";

const request = () =>
  ({
    user: { collection: "users", role: "owner", id: 7 },
    payload: {
      // The registered source hashes the manifest records (reads only).
      find: vi.fn(
        async ({ where }: { where: { mediaId: { in: string[] } } }) => ({
          docs: where.mediaId.in.map((mediaId) => ({
            mediaId,
            sha256: "d".repeat(64),
          })),
        }),
      ),
      // The latest draft is read first; the primary (published) document read
      // that precedes every intent write is reached only after the edge check.
      findByID: vi.fn(async ({ draft }: { draft: boolean }) => {
        if (draft) return { revision: 3, _status: "draft" };
        throw new Error("PRIMARY_LOOKUP_REACHED");
      }),
    },
  }) as unknown as PayloadRequest;
const command = {
  id: 1,
  expectedRevision: 3,
  expectedFingerprint: "f".repeat(64),
  idempotencyKey: "synthetic-prepare",
};

beforeEach(() => {
  state.statements = [];
  db.execute.mockClear();
});

describe("Catalog delivery prepare source bounds", () => {
  it("refuses an edge beyond 65,535 px before any intent or receipt is written", async () => {
    // A long PNG handscroll: 77 MP, within the Admin upload limit.
    state.media = [
      { width: 1200, height: 900 },
      { width: 70_000, height: 1100 },
    ];
    const req = request();
    const error = await prepareCatalogDelivery(req, command).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(EditorialError);
    expect(error).toMatchObject({
      code: "CATALOG_DELIVERY_SOURCE_TOO_LARGE",
      status: 422,
      fields: ["media"],
    });
    expect(req.payload.findByID).not.toHaveBeenCalledWith(
      expect.objectContaining({ draft: false }),
    );
    expect(
      state.statements.filter((sql) => /\bINSERT\b|\bUPDATE\b/u.test(sql)),
    ).toEqual([]);
    state.media = [{ width: 1100, height: 65_536 }];
    await expect(prepareCatalogDelivery(request(), command)).rejects.toThrow(
      "CATALOG_DELIVERY_SOURCE_TOO_LARGE",
    );
  });

  it("accepts edges up to the bound the processing snapshot itself accepts", async () => {
    state.media = [{ width: 65_535, height: 1100 }];
    await expect(prepareCatalogDelivery(request(), command)).rejects.toThrow(
      "PRIMARY_LOOKUP_REACHED",
    );
    const intent = (width: number) => ({
      intentId: "00000000-0000-4000-8000-000000000001",
      documentId: 1,
      catalogId: "synthetic-catalog",
      revision: 1,
      fingerprint: "a".repeat(64),
      manifestSha256: "b".repeat(64),
      recipeManifestSha256: "c".repeat(64),
      state: "prepared",
      stateVersion: 1,
      mediaCount: 1,
      media: [
        {
          ordinal: 1,
          mediaId: "synthetic-media-0",
          objectKey: `editorial/${"a".repeat(64)}/${"b".repeat(64)}-${"0".repeat(64)}.png`,
          sourceSha256: "d".repeat(64),
          width,
          height: 1100,
        },
      ],
      expiresAt: "2126-10-20T00:00:00.000Z",
    });
    expect(
      catalogProcessingIntentSchema.safeParse(intent(65_535)).success,
    ).toBe(true);
    expect(
      catalogProcessingIntentSchema.safeParse(intent(65_536)).success,
    ).toBe(false);
  });
});
