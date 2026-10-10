import { describe, expect, it } from "vitest";
import {
  PUBLISHING_DRAFT_CHANGED,
  WORK_ITEMS_CONFIGURABLE_MAXIMUM,
  authorMediaSchema,
  authorPersonSchema,
  authorProfileSchema,
  CARD_GALLERY_MAXIMUM,
  contentCardSchema,
  createPublishingDraftCommandSchema,
  editableWorkSchema,
  mediaCropSchema,
  mediaEditSchema,
  mediaItemIdSchema,
  mediaVariantSchema,
  publishingDraftDeletionCommandSchema,
  publishingDraftSaveResultSchema,
  publishingDraftSchema,
  publishingDraftSummarySchema,
  publishingHolderSchema,
  publishingLimitsSchema,
  publishingMediaItemSchema,
  publishingMediaSrcSchema,
  publishingOpenedEditDraftSchema,
  publishingSessionSchema,
  publishingSnapshotPageSchema,
  registerMediaItemCommandSchema,
  savePublishingDraftCommandSchema,
  workDraftContentSchema,
  workCoverSrcSchema,
  workDraftIdSchema,
  workMediaSchema,
  workSchema,
  workSubmissionCommandSchema,
  workSubmissionResultSchema,
  publishingReadinessCommandSchema,
  publishingReadinessSchema,
} from "@moya/contracts/schemas";
import {
  authorCommunityJsonSchemas,
  workPublishingJsonSchemas,
} from "@moya/contracts/json-schema";
import {
  adminModerateWorkSubmissionRequestSchema,
  adminPublishingJobRequestSchema,
  adminSetAccountCapacityClassRequestSchema,
  operatorAccountCapacitySchema,
  operatorPublishingJobSchema,
  operatorWorkSchema,
  operatorWorkSubmissionQuerySchema,
  operatorWorkSubmissionSchema,
  setWorkPublishingSettingsCommandSchema,
  workPublishingSettingsSchema,
  workSubmissionModerationResultSchema,
} from "@moya/contracts/internal/community-operator";

const hex = (character: string) => character.repeat(32);
const requestId = "9b62b05d-fb9a-48b8-aa9a-a5dafbeb242b";
const itemId = `media-item-${hex("a")}`;
const draftId = `work-draft-${hex("b")}`;
const sessionId = `publishing-session-${hex("c")}`;
const workId = `work-${hex("d")}`;
const revisionId = `work-revision-${hex("f")}`;
const legacySrc = `/api/community/media/user-media-${hex("a")}`;
const at = "2026-09-13T10:00:00.000Z";
// Phase 4 accepted a title with LF and a body with CR/CRLF (trimmed, ≤ UTF-16 limit).
const legacyTitle = "上\n下";
const legacyBody = "第一行\r\n第二行\r第三行";
const src = (variant: string, id = itemId) =>
  `/api/community/publishing/media/${id}/${variant}/base`;
const baseEdit = { rotation: 0, crop: null };
const item = (key: string, overrides: Record<string, unknown> = {}) => ({
  key,
  itemId: `media-item-${Buffer.from(key).toString("hex").padStart(32, "0")}`,
  kind: "static",
  qualityMode: "standard",
  edit: baseEdit,
  ...overrides,
});
const content = (overrides: Record<string, unknown> = {}) => ({
  title: "",
  body: "",
  authorship: { kind: "original" },
  visibility: "public",
  items: [],
  coverKey: null,
  coverCrop: null,
  ...overrides,
});
const messagesOf = (result: {
  success: boolean;
  error?: { issues: { message: string }[] };
}) =>
  result.success ? [] : result.error!.issues.map(({ message }) => message);

describe("work publishing identifiers", () => {
  it("accepts only the exact platform prefix with 32 lowercase hex", () => {
    expect(mediaItemIdSchema.safeParse(itemId).success).toBe(true);
    expect(workDraftIdSchema.safeParse(draftId).success).toBe(true);
    for (const invalid of [
      `media-item-${"A".repeat(32)}`,
      `media-item-${"a".repeat(31)}`,
      `media-blob-${hex("a")}`,
      ` ${itemId}`,
      `${itemId}\n`,
    ])
      expect(mediaItemIdSchema.safeParse(invalid).success).toBe(false);
    expect(workDraftIdSchema.safeParse(`draft-${hex("b")}`).success).toBe(
      false,
    );
  });
});

describe("media edits", () => {
  it("accepts crops inside the unit square and refuses edges beyond it", () => {
    for (const crop of [
      { x: 0, y: 0, width: 1, height: 1 },
      { x: 0.3, y: 0.7, width: 0.7, height: 0.3 },
      { x: 0.1, y: 0.2, width: 0.9, height: 0.8 },
      { x: 0.99, y: 0.99, width: 0.01, height: 0.01 },
    ])
      expect(mediaCropSchema.safeParse(crop).success).toBe(true);
    for (const crop of [
      { x: 0.5, y: 0, width: 0.6, height: 1 },
      { x: 0, y: 0.5, width: 1, height: 0.500001 },
      { x: -0.1, y: 0, width: 0.5, height: 0.5 },
      { x: 0, y: 0, width: 0.005, height: 0.5 },
      { x: 0, y: 0, width: 1.1, height: 1 },
      { x: Number.NaN, y: 0, width: 0.5, height: 0.5 },
      { x: 0, y: 0, width: Number.POSITIVE_INFINITY, height: 0.5 },
      { x: 0, y: 0, width: 0.5, height: 0.5, focus: 1 },
    ])
      expect(mediaCropSchema.safeParse(crop).success).toBe(false);
  });

  it("allows only quarter-turn rotations and a nullable crop", () => {
    for (const rotation of [0, 90, 180, 270])
      expect(mediaEditSchema.safeParse({ rotation, crop: null }).success).toBe(
        true,
      );
    for (const rotation of [45, 360, -90, "90"])
      expect(mediaEditSchema.safeParse({ rotation, crop: null }).success).toBe(
        false,
      );
    expect(mediaEditSchema.safeParse({ rotation: 0 }).success).toBe(false);
    expect(
      mediaEditSchema.safeParse({ rotation: 0, crop: null, filter: "sepia" })
        .success,
    ).toBe(false);
  });
});

describe("draft and submission content", () => {
  it("keeps a pending label consistent with the item kind", () => {
    const pending = {
      key: "k-pending",
      itemId: null,
      kind: "static",
      qualityMode: "standard",
      edit: baseEdit,
    };
    expect(
      workDraftContentSchema.safeParse(
        content({ items: [{ ...pending, pendingLabel: "photo" }] }),
      ).success,
    ).toBe(true);
    expect(
      workDraftContentSchema.safeParse(
        content({ items: [{ ...pending, pendingLabel: "live" }] }),
      ).success,
    ).toBe(false);
    expect(
      workDraftContentSchema.safeParse(
        content({
          items: [{ ...pending, kind: "live", pendingLabel: "photo" }],
        }),
      ).success,
    ).toBe(false);
  });

  it("saves incomplete drafts with pending placeholders and never raw file names", () => {
    const pending = {
      key: "k-pending",
      itemId: null,
      kind: "live",
      qualityMode: "original",
      edit: baseEdit,
      pendingLabel: "live",
    };
    expect(
      workDraftContentSchema.safeParse(
        content({ items: [pending], coverKey: "k-pending" }),
      ).success,
    ).toBe(true);
    expect(
      workDraftContentSchema.safeParse(
        content({ items: [{ ...pending, pendingName: "IMG_0001.HEIC" }] }),
      ).success,
    ).toBe(false);
    expect(
      workDraftContentSchema.safeParse(
        content({ items: [{ ...item("k1"), pendingLabel: "photo" }] }),
      ).success,
    ).toBe(false);
  });

  it("requires unique keys and items, a real cover key and a cover crop only with a cover", () => {
    expect(
      workDraftContentSchema.safeParse(
        content({ items: [item("k1"), item("k1")] }),
      ).success,
    ).toBe(false);
    expect(
      workDraftContentSchema.safeParse(
        content({
          items: [item("k1"), item("k2", { itemId: item("k1").itemId })],
        }),
      ).success,
    ).toBe(false);
    expect(
      workDraftContentSchema.safeParse(
        content({ items: [item("k1")], coverKey: "k2" }),
      ).success,
    ).toBe(false);
    expect(
      workDraftContentSchema.safeParse(
        content({
          items: [item("k1")],
          coverKey: null,
          coverCrop: { x: 0, y: 0, width: 1, height: 1 },
        }),
      ).success,
    ).toBe(false);
    expect(
      workDraftContentSchema.safeParse(
        content({
          items: [item("k1"), item("k2")],
          coverKey: "k2",
          coverCrop: { x: 0.25, y: 0, width: 0.5, height: 1 },
        }),
      ).success,
    ).toBe(true);
  });

  it("bounds items at the hard schema maximum with the items_limit code", () => {
    const items = (count: number) =>
      Array.from({ length: count }, (_, index) => item(`k${index}`));
    expect(
      workDraftContentSchema.safeParse(content({ items: items(500) })).success,
    ).toBe(true);
    expect(
      messagesOf(
        workDraftContentSchema.safeParse(content({ items: items(501) })),
      ),
    ).toContain("items_limit");
  });

  it("keeps the clipboard origin of uploaded and pending items as presentation only", () => {
    const pending = {
      key: "k-pending",
      itemId: null,
      kind: "static",
      qualityMode: "standard",
      edit: baseEdit,
      pendingLabel: "photo",
    };
    for (const items of [
      [item("k1", { origin: "clipboard" })],
      [{ ...pending, origin: "clipboard" }],
    ]) {
      expect(workDraftContentSchema.safeParse(content({ items })).success).toBe(
        true,
      );
      expect(
        workSubmissionCommandSchema.safeParse({
          requestId,
          holder: { draftId },
          content: content({ title: "标题", items }),
          baseRevisionId: null,
        }).success,
      ).toBe(true);
    }
    for (const origin of ["camera", "picker", "drop", "", null])
      expect(
        workDraftContentSchema.safeParse(
          content({ items: [item("k1", { origin })] }),
        ).success,
      ).toBe(false);
  });

  it("keeps a full save of the configurable item maximum with realistic text within the 100 KB command limit", () => {
    expect(WORK_ITEMS_CONFIGURABLE_MAXIMUM).toBe(100);
    // Realistic worst case: CJK text (3 UTF-8 bytes per code point) at every
    // text limit, line breaks in the body, the longest item keys, Original
    // Live items with a rotation, a full-precision crop and the clipboard
    // origin, and a cropped cover. `trailing` adds the raw draft allowance as
    // trimmable ideographic spaces, the most bytes it can realistically add.
    const saveOf = (trailing: number, character = "碑") => {
      const cjk = (length: number) => character.repeat(length);
      const pad = "\u3000".repeat(trailing);
      const lines = Array.from({ length: 200 }, () => cjk(49)).join("\n");
      const body = `${lines}${cjk(10_000 - [...lines].length)}${pad}`;
      const crop = {
        x: 0.12345678901234568,
        y: 0.2345678901234568,
        width: 0.7654321098765432,
        height: 0.6543210987654321,
      };
      const items = Array.from(
        { length: WORK_ITEMS_CONFIGURABLE_MAXIMUM },
        (_, index) => ({
          key: `k${String(index).padStart(3, "0")}-${"x".repeat(59)}`,
          itemId: `media-item-${index.toString(16).padStart(32, "f")}`,
          kind: "live",
          qualityMode: "original",
          edit: { rotation: 270, crop },
          origin: "clipboard",
        }),
      );
      return {
        baseRevision: 2_147_483_647,
        content: {
          title: `${cjk(200)}${pad}`,
          body,
          authorship: {
            kind: "material_sharing",
            referenceTitle: `${cjk(200)}${pad}`,
            originalAuthor: `${cjk(100)}${pad}`,
            sourceNote: `${cjk(500)}${pad}`,
          },
          visibility: "public",
          items,
          coverKey: items[99]!.key,
          coverCrop: crop,
        },
        deviceClass: "desktop",
      };
    };
    for (const trailing of [0, 2_000]) {
      const save = saveOf(trailing);
      expect(savePublishingDraftCommandSchema.safeParse(save).success).toBe(
        true,
      );
      const bytes = Buffer.byteLength(JSON.stringify(save), "utf8");
      expect(bytes).toBeGreaterThan(trailing === 0 ? 55_000 : 80_000);
      expect(bytes).toBeLessThan(100_000);
    }
    // Not a bound on every valid save: 4-byte characters at every limit pass
    // the schema and serialize past the command limit, which refuses them.
    const astral = saveOf(2_000, "\u{20000}");
    expect(savePublishingDraftCommandSchema.safeParse(astral).success).toBe(
      true,
    );
    expect(Buffer.byteLength(JSON.stringify(astral), "utf8")).toBeGreaterThan(
      100_000,
    );
  });

  it("keeps authorship to the three kinds with optional references only when referenced", () => {
    expect(
      workDraftContentSchema.safeParse(
        content({
          authorship: {
            kind: "copy_practice",
            referenceTitle: "合成碑帖",
            originalAuthor: "合成作者",
            sourceNote: "第一行\n第二行",
          },
        }),
      ).success,
    ).toBe(true);
    expect(
      workDraftContentSchema.safeParse(
        content({ authorship: { kind: "material_sharing" } }),
      ).success,
    ).toBe(true);
    expect(
      workDraftContentSchema.safeParse(
        content({ authorship: { kind: "original", referenceTitle: "x" } }),
      ).success,
    ).toBe(false);
    expect(
      workDraftContentSchema.safeParse(
        content({ authorship: { kind: "copy_practice", tags: ["x"] } }),
      ).success,
    ).toBe(false);
    for (const [authorship, code] of [
      [{ referenceTitle: "𠀀".repeat(201) }, "reference_title_too_long"],
      [{ originalAuthor: "作".repeat(101) }, "original_author_too_long"],
      [{ sourceNote: "𠀀".repeat(501) }, "source_note_too_long"],
    ] as const)
      expect(
        messagesOf(
          workDraftContentSchema.safeParse(
            content({ authorship: { kind: "copy_practice", ...authorship } }),
          ),
        ),
      ).toEqual([code]);
    expect(
      workDraftContentSchema.safeParse(
        content({
          authorship: {
            kind: "material_sharing",
            referenceTitle: "𠀀".repeat(200),
            originalAuthor: "作".repeat(100),
            sourceNote: "𠀀".repeat(500),
          },
        }),
      ).success,
    ).toBe(true);
  });

  it("treats a null authorship as not set in drafts, submissions and editable content, never as original", () => {
    const notSet = content({ title: "旧作", authorship: null });
    expect(workDraftContentSchema.parse(notSet).authorship).toBeNull();
    expect(
      workSubmissionCommandSchema.parse({
        requestId,
        holder: { sessionId },
        content: notSet,
        baseRevisionId: null,
      }).content.authorship,
    ).toBeNull();
    expect(
      editableWorkSchema.safeParse({
        workId,
        revisionId,
        content: notSet,
        mediaItems: [],
        visibility: "public",
        firstPublishedAt: at,
        editedAt: null,
        draftId: null,
        version: 1,
      }).success,
    ).toBe(true);
    // The key stays required: an absent authorship is not a default.
    const absent: Record<string, unknown> = { ...notSet };
    delete absent.authorship;
    for (const invalid of [
      absent,
      content({ authorship: {} }),
      content({ authorship: { kind: null } }),
      content({ authorship: "original" }),
    ]) {
      expect(workDraftContentSchema.safeParse(invalid).success).toBe(false);
      expect(
        workSubmissionCommandSchema.safeParse({
          requestId,
          holder: { sessionId },
          content: { ...invalid, title: "旧作" },
          baseRevisionId: null,
        }).success,
      ).toBe(false);
    }
  });

  it("refuses to create an empty draft", () => {
    expect(
      messagesOf(
        createPublishingDraftCommandSchema.safeParse({
          requestId,
          content: content({ title: "  ", body: "\r\n" }),
          deviceClass: "phone",
        }),
      ),
    ).toEqual(["empty_work"]);
    expect(
      createPublishingDraftCommandSchema.safeParse({
        requestId,
        content: content({ body: "正文" }),
        deviceClass: null,
      }).success,
    ).toBe(true);
  });

  it("accepts text-only, title-only and media-only submissions and refuses empty or pending ones", () => {
    const submit = (overrides: Record<string, unknown>) =>
      workSubmissionCommandSchema.safeParse({
        requestId,
        holder: { draftId },
        content: content(overrides),
        baseRevisionId: null,
      });
    expect(submit({ body: "正文\n第二行" }).success).toBe(true);
    expect(submit({ title: "只有标题" }).success).toBe(true);
    expect(submit({ items: [item("k1")] }).success).toBe(true);
    expect(messagesOf(submit({ title: " ", body: " " }))).toEqual([
      "empty_work",
    ]);
    // Readiness has one channel: the Backend's not_ready result, never a 422.
    expect(
      submit({
        items: [
          {
            key: "k1",
            itemId: null,
            kind: "static",
            qualityMode: "standard",
            edit: baseEdit,
          },
        ],
      }).success,
    ).toBe(true);
    expect(
      messagesOf(
        submit({
          title: legacyTitle,
          authorship: { kind: "copy_practice", referenceTitle: "上\n下" },
        }),
      ),
    ).toEqual(["title_line_break", "line_break"]);
  });
});

describe("upload holders and item registration", () => {
  it("accepts a draft holder or a session holder, never both or neither", () => {
    expect(publishingHolderSchema.safeParse({ draftId }).success).toBe(true);
    expect(publishingHolderSchema.safeParse({ sessionId }).success).toBe(true);
    for (const holder of [
      { draftId, sessionId },
      {},
      { draftId: sessionId },
      { sessionId: draftId },
      { workId: `work-${hex("d")}` },
    ])
      expect(publishingHolderSchema.safeParse(holder).success).toBe(false);
  });

  // Standard components default to browser-optimized output unless a case
  // names its outcome (or `standardOutcome: undefined` to omit it).
  const register = (overrides: Record<string, unknown>) => {
    const kind = overrides.kind ?? "static";
    const qualityMode = overrides.qualityMode ?? "standard";
    const components = (
      (overrides.components as Record<string, unknown>[] | undefined) ?? [
        { role: "still", byteSize: 1024, contentType: "image/webp" },
      ]
    ).map((component) =>
      qualityMode === "standard" && !("standardOutcome" in component)
        ? { ...component, standardOutcome: "optimized" }
        : component,
    );
    return registerMediaItemCommandSchema.safeParse({
      requestId,
      holder: { draftId },
      kind,
      qualityMode,
      ...(qualityMode === "standard" && {
        processingProfile:
          kind === "live" ? "standard-live-v1" : "standard-image-v1",
      }),
      ...overrides,
      components,
    });
  };
  const livePair = [
    { role: "still", byteSize: 4_000_000, contentType: "image/heic" },
    { role: "motion", byteSize: 9_000_000, contentType: "video/quicktime" },
  ];
  const applePairing = {
    method: "apple-content-identifier",
    identifierSha256: "f".repeat(64),
  };

  it("applies role rules: static is one still, Live is still + motion or one package", () => {
    expect(register({}).success).toBe(true);
    expect(
      register({
        qualityMode: "original",
        kind: "live",
        components: livePair,
        clientPairing: applePairing,
      }).success,
    ).toBe(true);
    expect(
      register({
        qualityMode: "original",
        kind: "live",
        components: [
          { role: "package", byteSize: 5_000_000, contentType: "image/jpeg" },
        ],
        clientPairing: { method: "motion-photo-container" },
      }).success,
    ).toBe(true);
    for (const components of [
      [{ role: "motion", byteSize: 1, contentType: "video/mp4" }],
      [
        { role: "still", byteSize: 1, contentType: "image/png" },
        { role: "still", byteSize: 1, contentType: "image/png" },
      ],
      [],
    ])
      expect(messagesOf(register({ components }))).toContain(
        "unsupported_type",
      );
    expect(
      messagesOf(
        register({
          kind: "live",
          qualityMode: "original",
          components: [livePair[0]],
          clientPairing: applePairing,
        }),
      ),
    ).toEqual(["unsupported_type"]);
    expect(
      register({
        kind: "live",
        qualityMode: "original",
        components: [...livePair, livePair[0]],
        clientPairing: applePairing,
      }).success,
    ).toBe(false);
  });

  it("refuses sending a HEIC or MOV source as Standard", () => {
    expect(
      messagesOf(
        register({
          components: [
            { role: "still", byteSize: 1024, contentType: "image/heic" },
          ],
        }),
      ),
    ).toEqual(["unsupported_type"]);
    expect(
      register({
        qualityMode: "original",
        components: [
          { role: "still", byteSize: 1024, contentType: "image/heic" },
        ],
      }).success,
    ).toBe(true);
    expect(
      messagesOf(
        register({
          kind: "live",
          components: [
            { role: "still", byteSize: 1, contentType: "image/jpeg" },
            { role: "motion", byteSize: 1, contentType: "video/quicktime" },
          ],
          clientPairing: applePairing,
        }),
      ),
    ).toEqual(["unsupported_type"]);
    expect(
      messagesOf(
        register({
          kind: "live",
          components: [
            { role: "package", byteSize: 1, contentType: "image/jpeg" },
          ],
          clientPairing: { method: "motion-photo-container" },
        }),
      ),
    ).toEqual(["unsupported_type"]);
    expect(
      register({
        components: [
          { role: "still", byteSize: 1, contentType: "application/zip" },
        ],
      }).success,
    ).toBe(false);
    expect(register({ qualityMode: "legacy" }).success).toBe(false);
  });

  it("limits retained Standard masters to already-small JPEG, PNG and WebP stills", () => {
    for (const contentType of ["image/jpeg", "image/png", "image/webp"]) {
      expect(
        register({
          components: [
            {
              role: "still",
              byteSize: 638_780,
              contentType,
              standardOutcome: "retained",
            },
          ],
        }).success,
      ).toBe(true);
    }
    expect(
      register({
        kind: "live",
        components: [
          {
            role: "still",
            byteSize: 638_780,
            contentType: "image/jpeg",
            standardOutcome: "retained",
          },
          {
            role: "motion",
            byteSize: 2_009_858,
            contentType: "video/mp4",
            standardOutcome: "retained",
          },
        ],
        clientPairing: applePairing,
      }).success,
    ).toBe(false);
    expect(
      register({
        components: [
          {
            role: "still",
            byteSize: 1,
            contentType: "image/png",
            standardOutcome: undefined,
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      register({
        qualityMode: "original",
        components: [
          {
            role: "still",
            byteSize: 1,
            contentType: "image/jpeg",
            standardOutcome: "retained",
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("never accepts a HEIC/HEIF still or QuickTime motion as Standard, even declared retained", () => {
    const heic = {
      role: "still",
      byteSize: 1_853_402,
      contentType: "image/heic",
    };
    for (const contentType of ["image/heic", "image/heif"]) {
      for (const standardOutcome of ["retained", "optimized"]) {
        expect(
          messagesOf(
            register({
              components: [{ ...heic, contentType, standardOutcome }],
            }),
          ),
        ).toEqual(["unsupported_type"]);
      }
    }
    expect(
      messagesOf(
        register({
          kind: "live",
          components: [
            { ...heic, standardOutcome: "retained" },
            {
              role: "motion",
              byteSize: 2_377_146,
              contentType: "video/quicktime",
              standardOutcome: "retained",
            },
          ],
          clientPairing: applePairing,
        }),
      ),
    ).toEqual(["unsupported_type", "unsupported_type"]);
    expect(
      messagesOf(
        register({
          kind: "live",
          components: [
            {
              role: "still",
              byteSize: 1,
              contentType: "image/webp",
              standardOutcome: "optimized",
            },
            {
              role: "motion",
              byteSize: 2_377_146,
              contentType: "video/quicktime",
              standardOutcome: "retained",
            },
          ],
          clientPairing: applePairing,
        }),
      ),
    ).toEqual(["unsupported_type"]);
    // Original mode still accepts the source types themselves.
    expect(
      register({
        kind: "live",
        qualityMode: "original",
        components: livePair,
        clientPairing: applePairing,
      }).success,
    ).toBe(true);
  });

  it("records the browser profile exactly for Standard items", () => {
    expect(register({ processingProfile: undefined }).success).toBe(false);
    expect(register({ processingProfile: "standard-live-v1" }).success).toBe(
      false,
    );
    expect(
      register({
        qualityMode: "original",
        processingProfile: "standard-image-v1",
      }).success,
    ).toBe(false);
    expect(
      register({
        kind: "live",
        components: [
          { role: "still", byteSize: 1, contentType: "image/jpeg" },
          { role: "motion", byteSize: 1, contentType: "video/mp4" },
        ],
        clientPairing: {
          method: "apple-content-identifier",
          identifierSha256: "f".repeat(64),
          stillTimeMs: 1_500,
        },
      }).success,
    ).toBe(true);
    expect(register({ processingProfile: "standard-image-v2" }).success).toBe(
      false,
    );
  });

  it("keeps the still time of a paired Live Photo for alignment", () => {
    const live = {
      kind: "live",
      qualityMode: "original",
      components: [
        { role: "package", byteSize: 5_000_000, contentType: "image/jpeg" },
      ],
    };
    expect(
      register({
        ...live,
        clientPairing: { method: "motion-photo-container", stillTimeMs: 1_500 },
      }).success,
    ).toBe(true);
    for (const stillTimeMs of [-1, 1.5, 60_001])
      expect(
        register({
          ...live,
          clientPairing: { method: "motion-photo-container", stillTimeMs },
        }).success,
      ).toBe(false);
    expect(
      register({ clientPairing: { method: "none", stillTimeMs: 0 } }).success,
    ).toBe(false);
  });

  it("requires trustworthy pairing for Live Photos", () => {
    const live = {
      kind: "live",
      qualityMode: "original",
      components: livePair,
    };
    expect(messagesOf(register(live))).toEqual(["pairing_mismatch"]);
    expect(
      messagesOf(register({ ...live, clientPairing: { method: "none" } })),
    ).toEqual(["pairing_mismatch"]);
    expect(
      register({
        ...live,
        clientPairing: { method: "apple-content-identifier" },
      }).success,
    ).toBe(false);
    expect(
      register({
        clientPairing: { method: "none", identifierSha256: "f".repeat(64) },
      }).success,
    ).toBe(false);
    expect(messagesOf(register({ clientPairing: applePairing }))).toEqual([
      "pairing_mismatch",
    ]);
  });

  it("bounds private metadata to 16 KiB serialized with provenance and no NUL", () => {
    const metadata = (values: Record<string, unknown>, status = "parsed") => ({
      provenance: { source: "client", parser: "exifr@7.1.3", status },
      values,
    });
    expect(
      register({
        metadata: metadata({ Make: "合成", Orientation: 1, FNumber: 1.8 }),
      }).success,
    ).toBe(true);
    expect(register({ metadata: metadata({}, "absent") }).success).toBe(true);
    expect(
      register({ metadata: metadata({ Make: "x" }, "absent") }).success,
    ).toBe(false);
    const large = Object.fromEntries(
      Array.from({ length: 40 }, (_, index) => [
        `Key${index}`,
        "字".repeat(170),
      ]),
    );
    expect(register({ metadata: metadata(large) }).success).toBe(false);
    expect(register({ metadata: metadata({ Make: "a\u0000b" }) }).success).toBe(
      false,
    );
    expect(register({ metadata: metadata({ "../path": "x" }) }).success).toBe(
      false,
    );
    expect(
      register({
        metadata: {
          ...metadata({}),
          provenance: { source: "server", parser: "x", status: "parsed" },
        },
      }).success,
    ).toBe(false);
    // How the browser received the file: untrusted, private provenance.
    for (const clientSource of ["picker", "drop", "clipboard"]) {
      const withSource = {
        ...metadata({}, "absent"),
        provenance: {
          source: "client",
          parser: "exifr@7.1.3",
          status: "absent",
          clientSource,
        },
      };
      expect(register({ metadata: withSource }).success).toBe(true);
    }
    for (const clientSource of ["camera", "url", "", null])
      expect(
        register({
          metadata: {
            ...metadata({}, "absent"),
            provenance: {
              source: "client",
              parser: "exifr@7.1.3",
              status: "absent",
              clientSource,
            },
          },
        }).success,
      ).toBe(false);
  });
});

describe("media item DTO", () => {
  const ready = {
    id: itemId,
    kind: "live",
    qualityMode: "original",
    state: "ready",
    failureCode: null,
    components: [
      {
        id: `media-component-${hex("1")}`,
        role: "still",
        state: "verified",
        byteSize: 10,
        receivedBytes: 10,
      },
      {
        id: `media-component-${hex("2")}`,
        role: "motion",
        state: "verified",
        byteSize: 20,
        receivedBytes: 20,
      },
    ],
    presentation: {
      width: 4032,
      height: 3024,
      durationMs: 2900,
      hasAudio: true,
    },
    media: {
      thumbSrc: src("thumb"),
      displaySrc: src("display"),
      motionSrc: src("motion"),
    },
  };

  it("carries same-origin derivative paths exactly when ready", () => {
    expect(publishingMediaItemSchema.safeParse(ready).success).toBe(true);
    expect(
      publishingMediaItemSchema.safeParse({ ...ready, state: "processing" })
        .success,
    ).toBe(false);
    expect(
      publishingMediaItemSchema.safeParse({
        ...ready,
        state: "processing",
        media: null,
      }).success,
    ).toBe(true);
    expect(
      publishingMediaItemSchema.safeParse({
        ...ready,
        state: "failed",
        media: null,
      }).success,
    ).toBe(false);
    expect(
      publishingMediaItemSchema.safeParse({
        ...ready,
        state: "failed",
        failureCode: "decode_failed",
        media: null,
      }).success,
    ).toBe(true);
  });

  it("refuses foreign, original or malformed media paths", () => {
    for (const thumbSrc of [
      `https://cdn.example/${itemId}/thumb/base`,
      `/api/community/media/user-media-${hex("a")}`,
      `/api/community/publishing/media/${itemId}/original/base`,
      `/api/community/publishing/media/${itemId}/thumb/base?download=1`,
      `/api/community/publishing/media/../${itemId}/thumb/base`,
    ])
      expect(
        publishingMediaItemSchema.safeParse({
          ...ready,
          media: { ...ready.media, thumbSrc },
        }).success,
      ).toBe(false);
  });

  it("requires every derivative path to name this item and its own variant", () => {
    const otherItem = `media-item-${hex("b")}`;
    for (const media of [
      { ...ready.media, thumbSrc: src("thumb", otherItem) },
      { ...ready.media, motionSrc: src("motion", otherItem) },
      { ...ready.media, displaySrc: src("thumb") },
      { ...ready.media, fullSrc: src("display") },
      { ...ready.media, thumbSrc: legacySrc },
    ])
      expect(
        publishingMediaItemSchema.safeParse({ ...ready, media }).success,
      ).toBe(false);
    expect(
      publishingMediaItemSchema.safeParse({
        ...ready,
        media: { ...ready.media, fullSrc: src("full") },
      }).success,
    ).toBe(true);
  });

  it("serves a legacy item from its Phase 4 user media path", () => {
    const legacy = {
      id: itemId,
      kind: "static",
      qualityMode: "legacy",
      state: "ready",
      failureCode: null,
      components: [],
      presentation: { width: 1200, height: 800 },
      media: { thumbSrc: legacySrc, displaySrc: legacySrc },
    };
    expect(publishingMediaItemSchema.safeParse(legacy).success).toBe(true);
    for (const invalid of [
      { media: { thumbSrc: src("thumb"), displaySrc: src("display") } },
      { media: { ...legacy.media, fullSrc: src("full") } },
      { media: { ...legacy.media, motionSrc: src("motion") }, kind: "live" },
      { kind: "live" },
    ])
      expect(
        publishingMediaItemSchema.safeParse({ ...legacy, ...invalid }).success,
      ).toBe(false);
  });

  it("keeps kind and component invariants", () => {
    expect(
      publishingMediaItemSchema.safeParse({
        ...ready,
        media: { thumbSrc: src("thumb"), displaySrc: src("display") },
      }).success,
    ).toBe(false);
    expect(
      publishingMediaItemSchema.safeParse({
        ...ready,
        kind: "static",
        components: [ready.components[0]],
        presentation: { width: 1, height: 1 },
      }).success,
    ).toBe(false);
    expect(
      publishingMediaItemSchema.safeParse({
        ...ready,
        components: [
          { ...ready.components[0], receivedBytes: 11 },
          ready.components[1],
        ],
      }).success,
    ).toBe(false);
    expect(
      publishingMediaItemSchema.safeParse({ ...ready, sha256: "f".repeat(64) })
        .success,
    ).toBe(false);
  });
});

describe("draft save results, summaries and submission receipts", () => {
  const draft = {
    id: draftId,
    kind: "new",
    workId: null,
    baseRevisionId: null,
    revision: 3,
    content: content({ body: "正文" }),
    mediaItems: [],
    conflict: null,
    deviceClass: "desktop",
    createdAt: "2026-09-13T10:00:00.000Z",
    updatedAt: "2026-09-13T10:05:00.000Z",
  };
  const conflict = {
    id: `work-draft-${hex("e")}`,
    device: {
      content: content({ body: "本机版本" }),
      baseRevision: 2,
      deviceClass: "phone",
      savedAt: "2026-09-13T10:06:00.000Z",
    },
    account: {
      content: content({ body: "账户版本" }),
      revision: 3,
      deviceClass: "desktop",
      updatedAt: "2026-09-13T10:05:00.000Z",
    },
    createdAt: "2026-09-13T10:06:00.000Z",
  };

  it("returns saved or a conflict carrying both real versions", () => {
    expect(
      publishingDraftSaveResultSchema.safeParse({ status: "saved", draft })
        .success,
    ).toBe(true);
    expect(
      publishingDraftSaveResultSchema.safeParse({
        status: "conflict",
        draft: { ...draft, conflict },
        conflict,
      }).success,
    ).toBe(true);
    expect(
      publishingDraftSaveResultSchema.safeParse({
        status: "conflict",
        draft: { ...draft, conflict },
        conflict: { ...conflict, account: undefined },
      }).success,
    ).toBe(false);
    for (const draftConflict of [
      null,
      { ...conflict, id: `work-draft-${hex("9")}` },
    ])
      expect(
        publishingDraftSaveResultSchema.safeParse({
          status: "conflict",
          draft: { ...draft, conflict: draftConflict },
          conflict,
        }).success,
      ).toBe(false);
    expect(
      publishingDraftSaveResultSchema.safeParse({ status: "conflict", draft })
        .success,
    ).toBe(false);
    expect(
      publishingDraftSaveResultSchema.safeParse({
        status: "saved",
        draft: { ...draft, kind: "edit" },
      }).success,
    ).toBe(false);
  });

  it("answers an opened edit draft with whether this request created it", () => {
    const edit = { ...draft, kind: "edit", workId, baseRevisionId: revisionId };
    for (const created of [true, false])
      expect(
        publishingOpenedEditDraftSchema.parse({ draft: edit, created }),
      ).toEqual({ draft: edit, created });
    for (const invalid of [
      { draft: edit },
      { draft: edit, created: "yes" },
      { draft: edit, created: true, extra: 1 },
      { draft, created: true },
      edit,
    ])
      expect(
        publishingOpenedEditDraftSchema.safeParse(invalid).success,
        JSON.stringify(invalid).slice(0, 40),
      ).toBe(false);
    expect(workPublishingJsonSchemas.PublishingOpenedEditDraft).toMatchObject({
      additionalProperties: false,
      required: ["draft", "created"],
      type: "object",
    });
  });

  it("confirms a draft deletion optionally against the revision the author saw", () => {
    expect(PUBLISHING_DRAFT_CHANGED).toBe("draft_changed");
    for (const command of [{ requestId }, { requestId, expectedRevision: 1 }])
      expect(
        publishingDraftDeletionCommandSchema.safeParse(command).success,
      ).toBe(true);
    for (const invalid of [
      {},
      { expectedRevision: 3 },
      { requestId, expectedRevision: 0 },
      { requestId, expectedRevision: 1.5 },
      { requestId, expectedRevision: "3" },
      { requestId, expectedRevision: null },
      { requestId, expectedRevision: 2_147_483_648 },
      { requestId, expectedRevision: 3, scope: "all" },
    ])
      expect(
        publishingDraftDeletionCommandSchema.safeParse(invalid).success,
      ).toBe(false);
  });

  it("carries the base revision of an edit draft and none for a new draft", () => {
    const edit = { ...draft, kind: "edit", workId, baseRevisionId: revisionId };
    expect(publishingDraftSchema.safeParse(edit).success).toBe(true);
    expect(
      publishingDraftSchema.safeParse({ ...edit, baseRevisionId: null })
        .success,
    ).toBe(false);
    expect(
      publishingDraftSchema.safeParse({ ...draft, baseRevisionId: revisionId })
        .success,
    ).toBe(false);
    expect(
      publishingDraftSchema.safeParse({ ...draft, baseRevisionId: undefined })
        .success,
    ).toBe(false);
  });

  it("summarizes drafts with normalized text and truthful counts", () => {
    const summary = {
      id: draftId,
      kind: "edit",
      workId: `work-${hex("d")}`,
      title: "",
      excerpt: "正文开头",
      coverSrc: src("cover"),
      itemCount: 3,
      missingLocalCount: 1,
      deviceClass: null,
      updatedAt: "2026-09-13T10:05:00.000Z",
    };
    expect(publishingDraftSummarySchema.safeParse(summary).success).toBe(true);
    for (const valid of [
      { title: legacyTitle, excerpt: "第一行\r\n第二行" },
      { coverSrc: legacySrc },
      { coverSrc: null },
      { excerpt: "𠀀".repeat(160) },
    ])
      expect(
        publishingDraftSummarySchema.safeParse({ ...summary, ...valid })
          .success,
      ).toBe(true);
    for (const invalid of [
      { title: "标题 " },
      { title: "a\u0000b" },
      { excerpt: "字".repeat(161) },
      { missingLocalCount: 4 },
      { workId: null },
      { coverSrc: "/api/community/media/x" },
    ])
      expect(
        publishingDraftSummarySchema.safeParse({ ...summary, ...invalid })
          .success,
      ).toBe(false);
  });

  it("confirms submissions author-neutrally or lists items that are not ready", () => {
    const receipt = {
      state: "confirmed",
      requestId,
      workId: `work-${hex("d")}`,
      revisionId: `work-revision-${hex("f")}`,
      visibility: "public",
      submittedAt: "2026-09-13T10:07:00.000Z",
    };
    expect(workSubmissionResultSchema.safeParse(receipt).success).toBe(true);
    expect(
      workSubmissionResultSchema.safeParse({
        ...receipt,
        disposition: "pending",
      }).success,
    ).toBe(false);
    expect(
      workSubmissionResultSchema.safeParse({
        state: "not_ready",
        itemKeys: ["k1", "k2"],
      }).success,
    ).toBe(true);
    expect(
      workSubmissionResultSchema.safeParse({ state: "not_ready", itemKeys: [] })
        .success,
    ).toBe(false);
  });

  it("checks a holder's readiness with the draft content and reports keys and thumb edit keys", () => {
    const editKey = "0123456789abcdef0123456789abcdef";
    expect(
      publishingReadinessCommandSchema.safeParse({
        content: content({
          items: [
            item("k1"),
            item("pending", { itemId: null, pendingLabel: "photo" }),
          ],
        }),
      }).success,
    ).toBe(true);
    expect(
      publishingReadinessCommandSchema.safeParse({
        content: content(),
        requestId,
      }).success,
    ).toBe(false);
    expect(publishingReadinessCommandSchema.safeParse({}).success).toBe(false);
    const pending = {
      ready: false,
      pendingItemKeys: ["k1", "pending"],
      failedItemKeys: ["k2"],
      editKeys: { k3: editKey },
    };
    expect(publishingReadinessSchema.safeParse(pending).success).toBe(true);
    expect(
      publishingReadinessSchema.safeParse({
        ready: true,
        pendingItemKeys: [],
        failedItemKeys: [],
        editKeys: {},
      }).success,
    ).toBe(true);
    for (const invalid of [
      { ready: true },
      { ready: true, pendingItemKeys: ["k1"] },
      { ready: false, pendingItemKeys: [], failedItemKeys: [] },
      { editKeys: { k3: "base" } },
      { editKeys: { k3: "not-a-key" } },
      { editKeys: { "bad key": editKey } },
      { pendingItemKeys: ["bad key"] },
      { failedItemKeys: "k2" },
      { items: [] },
    ])
      expect(
        publishingReadinessSchema.safeParse({ ...pending, ...invalid }).success,
      ).toBe(false);
  });
});

describe("read shapes for stored and legacy content", () => {
  const legacyItem = {
    key: "legacy-1",
    itemId,
    kind: "static",
    qualityMode: "legacy",
    edit: baseEdit,
  };
  const legacyContent = content({
    title: legacyTitle,
    body: legacyBody,
    items: [legacyItem],
    coverKey: "legacy-1",
  });
  const legacyMedia = {
    id: itemId,
    kind: "static",
    qualityMode: "legacy",
    state: "ready",
    failureCode: null,
    components: [],
    presentation: { width: 1200, height: 800 },
    media: { thumbSrc: legacySrc, displaySrc: legacySrc },
  };

  it("opens a legacy Phase 4 work for editing without rewriting its text", () => {
    const editable = {
      workId,
      revisionId,
      content: legacyContent,
      mediaItems: [legacyMedia],
      visibility: "public",
      firstPublishedAt: at,
      editedAt: null,
      draftId: null,
      version: 4,
    };
    const parsed = editableWorkSchema.safeParse(editable);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.content.title).toBe(legacyTitle);
    expect(parsed.data?.content.body).toBe(legacyBody);
    for (const invalid of [
      { revisionId: null },
      { visibility: "private" },
      { mediaItems: [{ ...legacyMedia, media: null }] },
      { content: { ...legacyContent, title: "𠀀".repeat(201) } },
    ])
      expect(
        editableWorkSchema.safeParse({ ...editable, ...invalid }).success,
      ).toBe(false);
    // Saving the opened legacy text as a draft still works; submitting asks for a single-line title.
    expect(
      createPublishingDraftCommandSchema.safeParse({
        requestId,
        content: legacyContent,
        deviceClass: "desktop",
      }).success,
    ).toBe(true);
    expect(
      messagesOf(
        workSubmissionCommandSchema.safeParse({
          requestId,
          holder: { draftId },
          content: legacyContent,
          baseRevisionId: revisionId,
        }),
      ),
    ).toEqual(["title_line_break"]);
  });

  it("lists history snapshots including pinned legacy drafts", () => {
    const snapshot = {
      id: `work-snapshot-${hex("7")}`,
      kind: "legacy_draft",
      draftId: null,
      workId,
      sourceRevision: null,
      pinned: true,
      createdAt: at,
      content: legacyContent,
    };
    const page = {
      items: [snapshot],
      total: 1,
      page: 1,
      pageSize: 20,
      totalPages: 1,
    };
    expect(publishingSnapshotPageSchema.safeParse(page).success).toBe(true);
    for (const invalid of [
      { ...snapshot, kind: "autosave" },
      { ...snapshot, id: `draft-${hex("7")}` },
      { ...snapshot, content: { ...legacyContent, items: undefined } },
    ])
      expect(
        publishingSnapshotPageSchema.safeParse({ ...page, items: [invalid] })
          .success,
      ).toBe(false);
    expect(
      publishingSnapshotPageSchema.safeParse({
        ...page,
        items: Array.from({ length: 51 }, () => snapshot),
      }).success,
    ).toBe(false);
  });

  it("describes no-save sessions with a lease and client limits", () => {
    const session = {
      id: sessionId,
      state: "active",
      workId: null,
      leaseExpiresAt: "2026-09-13T16:00:00.000Z",
      createdAt: at,
    };
    expect(publishingSessionSchema.safeParse(session).success).toBe(true);
    for (const invalid of [
      { state: "paused" },
      { leaseExpiresAt: null },
      { id: draftId },
      { draftId },
    ])
      expect(
        publishingSessionSchema.safeParse({ ...session, ...invalid }).success,
      ).toBe(false);
    const limits = {
      maxItems: 50,
      originalItemMaxBytes: 134_217_728,
      standardComponentMaxBytes: 268_435_456,
      titleMax: 200,
      bodyMax: 10_000,
    };
    expect(publishingLimitsSchema.safeParse(limits).success).toBe(true);
    expect(
      publishingLimitsSchema.safeParse({ ...limits, maxItems: 100 }).success,
    ).toBe(true);
    for (const invalid of [
      { maxItems: 0 },
      { maxItems: 101 },
      { maxItems: 501 },
      { originalItemMaxBytes: 0 },
      { dailyNewWorkLimit: 100 },
    ])
      expect(
        publishingLimitsSchema.safeParse({ ...limits, ...invalid }).success,
      ).toBe(false);
  });
});

describe("backward-compatible Phase 4 adjustments", () => {
  it("lets cards carry an empty title, a bounded excerpt and a LIVE flag", () => {
    const card = {
      aliases: [],
      target: { type: "work", id: `work-${hex("d")}` },
      title: "",
      kind: null,
      authorId: `user-${hex("1")}`,
      firstPublishedAt: null,
      media: null,
    };
    expect(contentCardSchema.safeParse(card).success).toBe(true);
    expect(
      contentCardSchema.safeParse({
        ...card,
        excerpt: "𠀀".repeat(160),
        live: true,
      }).success,
    ).toBe(true);
    expect(
      contentCardSchema.safeParse({ ...card, excerpt: "𠀀".repeat(161) })
        .success,
    ).toBe(false);
    expect(
      contentCardSchema.safeParse({ ...card, title: " 标题" }).success,
    ).toBe(false);
  });

  it("leaves the avatar media contract exactly as Phase 4 shipped it", () => {
    const legacy = {
      id: `user-media-${hex("a")}`,
      src: legacySrc,
      width: 1200,
      height: 800,
    };
    expect(Object.keys(authorMediaSchema.shape).sort()).toEqual([
      "height",
      "id",
      "src",
      "width",
    ]);
    expect(authorProfileSchema.shape.avatar.unwrap()).toBe(authorMediaSchema);
    expect(authorPersonSchema.shape.avatar.unwrap()).toBe(authorMediaSchema);
    expect(authorMediaSchema.safeParse(legacy).success).toBe(true);
    for (const invalid of [
      { id: itemId },
      { src: src("display") },
      { width: 8193 },
      { kind: "static" },
      { motionSrc: src("motion") },
      { src: "https://example.test/a" },
    ])
      expect(
        authorMediaSchema.safeParse({ ...legacy, ...invalid }).success,
      ).toBe(false);
    expect(authorCommunityJsonSchemas.AuthorMedia).toMatchObject({
      additionalProperties: false,
      required: ["id", "src", "width", "height"],
      properties: {
        width: { maximum: 8192 },
        height: { maximum: 8192 },
      },
    });
    expect(
      Object.keys(
        (authorCommunityJsonSchemas.AuthorMedia as { properties: object })
          .properties,
      ),
    ).toEqual(["id", "src", "width", "height"]);
  });

  it("gives work media its own shape with matching ids, paths and Live fields", () => {
    const legacy = {
      id: `user-media-${hex("a")}`,
      src: legacySrc,
      width: 1200,
      height: 800,
    };
    const live = {
      id: itemId,
      src: src("display"),
      width: 8688,
      height: 5792,
      kind: "live",
      motionSrc: src("motion"),
      hasAudio: true,
    };
    for (const valid of [
      legacy,
      live,
      { id: itemId, src: src("display"), width: 1, height: 1, kind: "static" },
      { id: itemId, src: legacySrc, width: 1200, height: 800 },
      { ...live, hasAudio: undefined },
    ])
      expect(workMediaSchema.safeParse(valid).success).toBe(true);
    for (const invalid of [
      { ...legacy, src: `/api/community/media/user-media-${hex("b")}` },
      { ...legacy, src: src("display") },
      { ...legacy, kind: "live", motionSrc: src("motion") },
      { ...live, src: src("display", `media-item-${hex("b")}`) },
      { ...live, src: src("motion") },
      { ...live, motionSrc: undefined },
      { ...live, motionSrc: src("motion", `media-item-${hex("b")}`) },
      { ...live, motionSrc: src("display") },
      { ...live, kind: "static" },
      { ...live, kind: undefined },
      { id: itemId, src: legacySrc, width: 1, height: 1, kind: "live" },
      { ...legacy, hasAudio: false },
    ])
      expect(workMediaSchema.safeParse(invalid).success).toBe(false);
    expect(workSchema.shape.media.element).toBe(workMediaSchema);
  });

  it("accepts existing works and the new nullable first publication and author-only fields", () => {
    const work = {
      id: `work-${hex("d")}`,
      authorId: `user-${hex("1")}`,
      authorName: "合成作者",
      title: "合成标题",
      text: "正文",
      media: [],
      firstPublishedAt: "2026-09-01T00:00:00.000Z",
      version: 1,
      canEdit: false,
      available: true,
    };
    expect(workSchema.safeParse(work).success).toBe(true);
    expect(
      workSchema.safeParse({
        ...work,
        title: "",
        firstPublishedAt: null,
        canEdit: true,
        editedAt: null,
        visibility: "self",
        authorship: { kind: "original" },
        trashedAt: null,
      }).success,
    ).toBe(true);
    // Attribution is visible to readers without any author-only field.
    expect(
      workSchema.safeParse({
        ...work,
        title: legacyTitle,
        text: legacyBody,
        media: [
          {
            id: itemId,
            src: src("display"),
            width: 4032,
            height: 3024,
            kind: "live",
            motionSrc: src("motion"),
          },
        ],
        editedAt: at,
        authorship: {
          kind: "copy_practice",
          referenceTitle: "合成碑帖",
          originalAuthor: "合成作者",
        },
      }).success,
    ).toBe(true);
    expect(
      workSchema.safeParse({ ...work, visibility: "private" }).success,
    ).toBe(false);
    // Not set is absent: a work never carries a null or defaulted authorship.
    expect(workSchema.parse(work)).not.toHaveProperty("authorship");
    expect(workSchema.safeParse({ ...work, authorship: null }).success).toBe(
      false,
    );
  });

  it("names the card cover still of the viewer's revision", () => {
    const work = {
      id: `work-${hex("d")}`,
      authorId: `user-${hex("1")}`,
      authorName: "合成作者",
      title: "",
      text: "正文",
      media: [],
      firstPublishedAt: at,
      version: 1,
      canEdit: false,
      available: true,
    };
    expect(workSchema.shape.coverSrc.unwrap().unwrap()).toBe(
      workCoverSrcSchema,
    );
    for (const coverSrc of [
      undefined,
      null,
      legacySrc,
      src("cover"),
      `/api/community/publishing/media/${itemId}/cover/${hex("7")}`,
      src("display"),
      // unified-media-pipeline-v1 (CW6): the unsigned published still.
      "https://example.com/cover.webp",
    ])
      expect(
        workSchema.safeParse({ ...work, coverSrc }).success,
        String(coverSrc),
      ).toBe(true);
    for (const coverSrc of [
      "",
      src("motion"),
      `/api/community/publishing/media/${itemId}/original/base`,
      "https://example.com/cover.webp?sign=1",
      "https://example.com/cover.webp#cover",
      "https://reader@example.com/cover.webp",
      `/api/community/media/${itemId}`,
    ])
      expect(
        workSchema.safeParse({ ...work, coverSrc }).success,
        coverSrc,
      ).toBe(false);
  });

  it("names the cover among the work's media and tells only the author whether it is public", () => {
    const legacyId = `user-media-${hex("a")}`;
    const work = {
      id: `work-${hex("d")}`,
      authorId: `user-${hex("1")}`,
      authorName: "合成作者",
      title: "",
      text: "正文",
      media: [
        { id: legacyId, src: legacySrc, width: 1200, height: 800 },
        {
          id: itemId,
          src: src("display"),
          width: 4032,
          height: 3024,
          kind: "static",
        },
      ],
      firstPublishedAt: at,
      version: 1,
      canEdit: false,
      available: true,
    };
    for (const coverMediaId of [itemId, legacyId])
      expect(workSchema.safeParse({ ...work, coverMediaId }).success).toBe(
        true,
      );
    expect(
      workSchema.safeParse({ ...work, media: [], coverMediaId: null }).success,
    ).toBe(true);
    for (const coverMediaId of [
      `media-item-${hex("e")}`,
      `user-media-${hex("e")}`,
      "cover",
    ])
      expect(workSchema.safeParse({ ...work, coverMediaId }).success).toBe(
        false,
      );

    const own = {
      ...work,
      canEdit: true,
      visibility: "public",
      trashedAt: null,
      coverMediaId: itemId,
    };
    for (const publiclyVisible of [true, false])
      expect(workSchema.safeParse({ ...own, publiclyVisible }).success).toBe(
        true,
      );
    // A pending first submission or an operator-hidden work is not public.
    expect(
      workSchema.safeParse({
        ...own,
        firstPublishedAt: null,
        visibility: "self",
        publiclyVisible: false,
      }).success,
    ).toBe(true);
    for (const invalid of [
      { canEdit: false, publiclyVisible: false },
      { canEdit: false, publiclyVisible: true },
      { visibility: "self", publiclyVisible: true },
      { trashedAt: at, publiclyVisible: true },
      { publiclyVisible: "yes" },
    ])
      expect(workSchema.safeParse({ ...own, ...invalid }).success).toBe(false);
  });
});

describe("media delivery on work reads (unified-media-pipeline-v1)", () => {
  const editKey = hex("7");
  const coverKey = hex("8");
  const otherItem = `media-item-${hex("b")}`;
  const path = (role: string, key = editKey, id = itemId) =>
    `/api/community/publishing/media/${id}/${role}/${key}`;
  const published = (name: string) =>
    `https://img.example.invalid/v1/${hex("1")}/${hex("2")}/${editKey}/${name}.r1.webp`;
  const signed = `https://img.example.invalid/display.webp?sign=${hex("3")}`;
  const rendition = (src: string, width: number, height: number) => ({
    src,
    width,
    height,
    contentType: "image/webp",
  });
  type Rendition = ReturnType<typeof rendition>;
  const replaced = (
    list: readonly Rendition[],
    index: number,
    entry: Record<string, unknown>,
  ) =>
    list.map((current, at) =>
      at === index ? { ...current, ...entry } : current,
    );
  const asPublished = (list: readonly Rendition[]) =>
    list.map((entry, index) => ({ ...entry, src: published(`r${index}`) }));
  const detail = [
    rendition(path("thumb"), 480, 320),
    rendition(path("cover"), 1_080, 720),
    rendition(path("display"), 2_048, 1_365),
    rendition(path("viewer"), 4_096, 2_731),
    rendition(path("full"), 8_192, 5_461),
  ];
  const media = {
    id: itemId,
    src: path("display"),
    width: 2_048,
    height: 1_365,
    kind: "static",
    renditions: detail,
    placeholderColor: "#5f6f58",
  };
  const coverList = [
    rendition(path("thumb", coverKey), 480, 480),
    rendition(path("cover", coverKey), 1_080, 1_080),
  ];

  it("adds the viewer variant to the authorized relay only", () => {
    expect(mediaVariantSchema.options).toEqual([
      "thumb",
      "display",
      "full",
      "motion",
      "cover",
      "viewer",
    ]);
    // Owner and MCP shapes keep their derivative paths and no published URL.
    for (const value of [path("viewer"), published("display")])
      expect(publishingMediaSrcSchema.safeParse(value).success, value).toBe(
        false,
      );
  });

  it("anchors work media candidates of its edit framing at src", () => {
    expect(workMediaSchema.parse(media)).toEqual(media);
    // A published group switches src, motion and every candidate together.
    const publishedLive = {
      ...media,
      src: published("r2"),
      kind: "live",
      motionSrc: published("motion").replace(/\.webp$/u, ".mp4"),
      hasAudio: true,
      renditions: asPublished(detail),
    };
    for (const valid of [
      publishedLive,
      { ...media, kind: "live", motionSrc: path("motion"), hasAudio: true },
      { ...media, src: published("display"), renditions: undefined },
      { ...media, renditions: undefined, placeholderColor: undefined },
      { ...media, renditions: detail.slice(0, 3) },
    ])
      expect(
        workMediaSchema.safeParse(valid).success,
        JSON.stringify(valid),
      ).toBe(true);
    for (const invalid of [
      // src is not one of the candidates, or not of their form.
      {
        ...media,
        renditions: detail.filter((entry) => entry.src !== media.src),
      },
      { ...media, renditions: asPublished(detail) },
      { ...publishedLive, renditions: detail },
      { ...media, renditions: replaced(detail, 4, { src: published("r4") }) },
      // Every same-origin candidate names this item and the edit of src.
      {
        ...media,
        renditions: replaced(detail, 0, {
          src: path("thumb", editKey, otherItem),
        }),
      },
      {
        ...media,
        renditions: replaced(detail, 1, { src: path("cover", coverKey) }),
      },
      { ...media, renditions: replaced(detail, 3, { src: path("motion") }) },
      // A 1:1 cover-crop list under a 3:2 parent.
      { ...media, src: path("cover", coverKey), renditions: coverList },
      // Signed URLs never appear in work reads.
      { ...media, src: signed, renditions: undefined },
      { ...publishedLive, motionSrc: `${published("motion")}?sign=1` },
      { ...media, renditions: replaced(detail, 0, { src: signed }) },
      {
        ...media,
        renditions: replaced(detail, 1, { contentType: "image/png" }),
      },
      { ...media, renditions: replaced(detail, 1, { storageKey: "blobs/aa" }) },
      { ...media, placeholderColor: "#ABCDEF" },
      { ...media, placeholderColor: "#abc" },
      // A Live Photo still needs its motion; only a Live Photo has one.
      { ...publishedLive, motionSrc: undefined },
      { ...media, motionSrc: published("motion") },
      // Never half of a Live Photo published: still and motion share a form.
      { ...publishedLive, motionSrc: path("motion") },
      {
        ...media,
        kind: "live",
        motionSrc: publishedLive.motionSrc,
        hasAudio: true,
      },
    ])
      expect(
        workMediaSchema.safeParse(invalid).success,
        JSON.stringify(invalid),
      ).toBe(false);
  });

  it("keeps Phase 4 and legacy entries on their user media path without candidates", () => {
    const phase4 = {
      id: `user-media-${hex("a")}`,
      src: legacySrc,
      width: 1200,
      height: 800,
    };
    const candidates = [rendition(legacySrc, 1200, 800)];
    for (const invalid of [
      { ...phase4, renditions: candidates },
      { ...phase4, renditions: [rendition(published("r0"), 1200, 800)] },
      { ...phase4, src: published("r0") },
      {
        ...phase4,
        src: published("r0"),
        renditions: [rendition(published("r0"), 1200, 800)],
      },
      { ...phase4, kind: "live", motionSrc: published("motion") },
      {
        id: itemId,
        src: legacySrc,
        width: 1200,
        height: 800,
        renditions: [rendition(path("display"), 1200, 800)],
      },
    ])
      expect(
        workMediaSchema.safeParse(invalid).success,
        JSON.stringify(invalid),
      ).toBe(false);
  });

  it("anchors the cover candidates of a work at coverSrc", () => {
    const work = {
      id: `work-${hex("d")}`,
      authorId: `user-${hex("1")}`,
      authorName: "合成作者",
      title: "",
      text: "正文",
      media: [media],
      coverMediaId: itemId,
      coverSrc: path("cover", coverKey),
      coverRenditions: coverList,
      firstPublishedAt: at,
      version: 1,
      canEdit: false,
      available: true,
    };
    expect(workSchema.parse(work)).toEqual(work);
    expect(
      workSchema.safeParse({
        ...work,
        coverSrc: published("r1"),
        coverRenditions: asPublished(coverList),
      }).success,
    ).toBe(true);
    for (const invalid of [
      { coverSrc: undefined },
      { coverSrc: null },
      { coverSrc: path("display") },
      { coverSrc: legacySrc },
      { coverRenditions: [] },
      { coverRenditions: asPublished(coverList) },
      {
        coverRenditions: replaced(coverList, 0, {
          src: path("thumb", coverKey, otherItem),
        }),
      },
      { coverRenditions: replaced(coverList, 0, { src: path("thumb") }) },
      { coverRenditions: replaced(coverList, 0, { width: 480, height: 320 }) },
      { coverRenditions: replaced(coverList, 0, { src: signed }) },
    ])
      expect(
        workSchema.safeParse({ ...work, ...invalid }).success,
        JSON.stringify(invalid),
      ).toBe(false);
  });

  it("gives a card one form of card candidates anchored at its image", () => {
    const card = {
      aliases: [],
      target: { type: "work", id: `work-${hex("d")}` },
      title: "",
      kind: null,
      authorId: `user-${hex("1")}`,
      firstPublishedAt: null,
      media: {
        id: itemId,
        src: path("cover", coverKey),
        width: 1_080,
        height: 1_080,
        renditions: coverList,
        placeholderColor: "#5f6f58",
      },
    };
    const catalogSrc = (name: string) =>
      `https://media.example.invalid/${name}.webp?sign=${hex("4")}`;
    const catalogCard = {
      ...card,
      target: { type: "catalog", id: "catalog-example-001" },
      kind: "inscription",
      authorId: null,
      media: {
        id: "media-example-001",
        src: catalogSrc("display"),
        width: 1_600,
        height: 900,
        renditions: [
          rendition(catalogSrc("thumb"), 480, 270),
          rendition(catalogSrc("cover"), 1_080, 608),
          rendition(catalogSrc("display"), 1_600, 900),
        ],
      },
    };
    for (const valid of [
      card,
      catalogCard,
      {
        ...card,
        media: {
          ...card.media,
          src: published("r1"),
          renditions: asPublished(coverList),
        },
      },
    ])
      expect(
        contentCardSchema.safeParse(valid).success,
        JSON.stringify(valid),
      ).toBe(true);
    for (const media of [
      // One form per list: never Catalog URLs and relay paths together.
      {
        ...catalogCard.media,
        renditions: replaced(catalogCard.media.renditions, 0, {
          src: path("thumb", coverKey),
        }),
      },
      { ...card.media, renditions: replaced(coverList, 0, { src: signed }) },
      { ...card.media, src: signed, renditions: undefined },
      { ...card.media, src: path("display") },
      // A 1:1 cover-crop list under a 3:2 parent.
      { ...card.media, width: 1_620, height: 1_080 },
      {
        ...card.media,
        renditions: replaced(coverList, 0, { contentType: "image/png" }),
      },
      {
        ...card.media,
        renditions: replaced(coverList, 0, { objectKey: "a.webp" }),
      },
      { ...card.media, placeholderColor: "#5F6F58" },
      // A work card never lists signed URLs, even as a whole Catalog-form list.
      catalogCard.media,
    ])
      expect(
        contentCardSchema.safeParse({ ...card, media }).success,
        JSON.stringify(media),
      ).toBe(false);
    // A Catalog card lists only the resolved form of Catalog media.
    expect(
      contentCardSchema.safeParse({ ...catalogCard, media: card.media })
        .success,
    ).toBe(false);
  });

  it("lets a card list its item's images in the card's own delivery form", () => {
    const card = {
      aliases: [],
      target: { type: "work", id: `work-${hex("d")}` },
      title: "",
      kind: null,
      authorId: `user-${hex("1")}`,
      firstPublishedAt: null,
      media: {
        id: itemId,
        src: path("cover", coverKey),
        width: 1_080,
        height: 1_080,
        renditions: coverList,
      },
    };
    // Each entry is the item's display still with card candidates up to it.
    const still = (id: string) => ({
      id,
      src: path("display", editKey, id),
      width: 2_048,
      height: 1_365,
      renditions: [
        rendition(path("thumb", editKey, id), 480, 320),
        rendition(path("cover", editKey, id), 1_080, 720),
        rendition(path("display", editKey, id), 2_048, 1_365),
      ],
    });
    const gallery = [still(itemId), { ...still(otherItem), live: true }];
    const catalogSrc = (name: string) =>
      `https://media.example.invalid/${name}.webp?sign=${hex("4")}`;
    const catalogImage = (id: string) => ({
      id,
      src: catalogSrc(`${id}-display`),
      width: 1_600,
      height: 900,
      renditions: [
        rendition(catalogSrc(`${id}-thumb`), 480, 270),
        rendition(catalogSrc(`${id}-display`), 1_600, 900),
      ],
    });
    const catalogCard = {
      ...card,
      target: { type: "catalog", id: "catalog-example-001" },
      kind: "inscription",
      authorId: null,
      media: catalogImage("media-example-001"),
    };
    const many = (count: number) =>
      Array.from({ length: count }, (_, index) =>
        still(`media-item-${String(index).padStart(32, "0")}`),
      );
    for (const valid of [
      { ...card, gallery, mediaCount: 2 },
      // The gallery may stop short of the item's total.
      { ...card, gallery: many(CARD_GALLERY_MAXIMUM), mediaCount: 14 },
      {
        ...card,
        gallery: [
          {
            ...still(itemId),
            // The anchor is the published display candidate.
            src: published("r2"),
            renditions: asPublished(still(itemId).renditions),
          },
        ],
        mediaCount: 1,
      },
      {
        ...catalogCard,
        gallery: [
          catalogImage("media-example-001"),
          catalogImage("media-example-002"),
        ],
        mediaCount: 2,
      },
    ])
      expect(
        contentCardSchema.safeParse(valid).success,
        JSON.stringify(valid),
      ).toBe(true);
    for (const invalid of [
      // The two fields travel together, and only with a card image.
      { ...card, gallery },
      { ...card, mediaCount: 2 },
      { ...card, media: null, gallery, mediaCount: 2 },
      { ...card, gallery: [], mediaCount: 1 },
      { ...card, gallery, mediaCount: 1 },
      { ...card, gallery: [still(itemId), still(itemId)], mediaCount: 2 },
      {
        ...card,
        gallery: many(CARD_GALLERY_MAXIMUM + 1),
        mediaCount: CARD_GALLERY_MAXIMUM + 1,
      },
      // A work entry is a still in the community form, never motion or a
      // signed URL, anchored in its own candidates.
      {
        ...card,
        gallery: [{ ...still(itemId), src: path("motion") }],
        mediaCount: 1,
      },
      {
        ...card,
        gallery: [{ ...still(itemId), src: signed, renditions: undefined }],
        mediaCount: 1,
      },
      {
        ...card,
        gallery: [{ ...still(itemId), width: 1_080, height: 1_080 }],
        mediaCount: 1,
      },
      {
        ...card,
        gallery: [catalogImage("media-example-001")],
        mediaCount: 1,
      },
      // A Catalog card lists only resolved Catalog media.
      { ...catalogCard, gallery: [still(itemId)], mediaCount: 1 },
      {
        ...card,
        gallery: [{ ...still(itemId), motionSrc: path("motion") }],
        mediaCount: 1,
      },
    ])
      expect(
        contentCardSchema.safeParse(invalid).success,
        JSON.stringify(invalid),
      ).toBe(false);
  });
});

describe("operator work publishing shapes", () => {
  const settings = {
    requestId,
    expectedVersion: 1,
    policy: "PRE_MODERATION",
    maxItemsPerWork: 50,
    originalItemMaxBytes: 134_217_728,
    standardComponentMaxBytes: 268_435_456,
    ordinaryAccountCapacityBytes: 10_737_418_240,
    ownerAccountCapacityBytes: 21_474_836_480,
    maxActiveDrafts: 100,
    dailyNewWorkLimit: 100,
    historyLimit: 20,
    trashRetentionDays: 30,
    orphanGraceDays: 7,
    unsavedSessionLeaseMinutes: 360,
  };

  it("accepts the documented defaults and refuses out-of-bound or extra settings", () => {
    expect(
      setWorkPublishingSettingsCommandSchema.safeParse(settings).success,
    ).toBe(true);
    expect(
      setWorkPublishingSettingsCommandSchema.safeParse({
        ...settings,
        maxItemsPerWork: WORK_ITEMS_CONFIGURABLE_MAXIMUM,
      }).success,
    ).toBe(true);
    for (const invalid of [
      { maxItemsPerWork: 0 },
      { maxItemsPerWork: 101 },
      { maxItemsPerWork: 501 },
      { originalItemMaxBytes: 1_000 },
      { trashRetentionDays: 0 },
      { policy: "AUTO" },
      { expectedVersion: -1 },
      { requestId: undefined },
      { avatarDailyLimit: 1 },
    ])
      expect(
        setWorkPublishingSettingsCommandSchema.safeParse({
          ...settings,
          ...invalid,
        }).success,
      ).toBe(false);
  });

  it("uses strict Admin envelopes carrying the subject id", () => {
    const moderation = {
      id: `work-revision-${hex("f")}`,
      requestId,
      action: "approve",
      expectedVersion: 2,
    };
    expect(
      adminModerateWorkSubmissionRequestSchema.safeParse(moderation).success,
    ).toBe(true);
    for (const invalid of [
      { action: "hide" },
      { id: `work-${hex("f")}` },
      { expectedVersion: undefined },
      { note: "x" },
    ])
      expect(
        adminModerateWorkSubmissionRequestSchema.safeParse({
          ...moderation,
          ...invalid,
        }).success,
      ).toBe(false);
    const capacity = {
      accountId: `user-${hex("1")}`,
      capacityClass: "owner",
      requestId,
      expectedVersion: 0,
    };
    expect(
      adminSetAccountCapacityClassRequestSchema.safeParse(capacity).success,
    ).toBe(true);
    for (const invalid of [
      { accountId: "owner-handle" },
      { capacityClass: "unlimited" },
      { capacityBytes: 1 },
    ])
      expect(
        adminSetAccountCapacityClassRequestSchema.safeParse({
          ...capacity,
          ...invalid,
        }).success,
      ).toBe(false);
    expect(
      adminPublishingJobRequestSchema.safeParse({
        id: `publishing-job-${hex("9")}`,
        action: "retry",
        requestId,
      }).success,
    ).toBe(true);
    expect(
      adminPublishingJobRequestSchema.safeParse({
        id: `publishing-job-${hex("9")}`,
        action: "delete",
        requestId,
      }).success,
    ).toBe(false);
  });

  it("reads settings, capacity and the Phase 4 work list for never-public works", () => {
    const current: Record<string, unknown> = {
      ...settings,
      version: 3,
      updatedAt: at,
      updatedBy: null,
    };
    delete current.requestId;
    delete current.expectedVersion;
    expect(workPublishingSettingsSchema.safeParse(current).success).toBe(true);
    for (const invalid of [
      { updatedAt: "2026-09-13T10:00:00+08:00" },
      { requestId },
      { ownerAccountCapacityBytes: 2 * 1024 ** 4 },
    ])
      expect(
        workPublishingSettingsSchema.safeParse({ ...current, ...invalid })
          .success,
      ).toBe(false);
    const capacity = {
      accountId: `user-${hex("1")}`,
      capacityClass: "owner",
      capacityBytes: 21_474_836_480,
      committedBytes: 1_024,
      reservedBytes: 0,
      version: 1,
      updatedAt: null,
    };
    expect(operatorAccountCapacitySchema.safeParse(capacity).success).toBe(
      true,
    );
    for (const invalid of [
      { accountId: "handle" },
      { reservedBytes: -1 },
      { capacityClass: "admin" },
    ])
      expect(
        operatorAccountCapacitySchema.safeParse({ ...capacity, ...invalid })
          .success,
      ).toBe(false);
    const work = {
      id: workId,
      title: "",
      text: "正文",
      authorId: `user-${hex("1")}`,
      authorName: "合成作者",
      authorStatus: "active",
      state: "visible",
      authorDeleted: false,
      version: 1,
      firstPublishedAt: null,
      latestSubmission: null,
      publicRevisionId: null,
      publiclyVisible: false,
    };
    expect(operatorWorkSchema.safeParse(work).success).toBe(true);
    expect(
      operatorWorkSchema.safeParse({ ...work, firstPublishedAt: at }).success,
    ).toBe(true);
  });

  it("queues only public submissions, with legacy text as stored", () => {
    const submission = {
      revisionId,
      workId,
      sequence: 1,
      origin: "legacy",
      author: {
        id: `user-${hex("1")}`,
        handle: "synthetic-author",
        displayName: "合成作者",
        status: "active",
      },
      title: legacyTitle,
      body: legacyBody,
      authorship: null,
      coverItemId: itemId,
      coverCrop: null,
      items: [
        {
          position: 1,
          itemId,
          kind: "static",
          qualityMode: "legacy",
          state: "ready",
          edit: baseEdit,
          editKey: "base",
          coverEditKey: "base",
          presentation: { width: 1200, height: 800 },
          variants: [],
        },
      ],
      disposition: "approved",
      latest: true,
      workState: "visible",
      workTrashed: false,
      submittedAt: at,
      decidedAt: at,
      decidedBy: null,
      version: 1,
    };
    expect(operatorWorkSubmissionSchema.safeParse(submission).success).toBe(
      true,
    );
    // A legacy baseline declares no authorship; a declared one is kept.
    expect(
      operatorWorkSubmissionSchema.safeParse({
        ...submission,
        authorship: { kind: "copy_practice", referenceTitle: "合成碑帖" },
      }).success,
    ).toBe(true);
    for (const invalid of [
      { authorship: undefined },
      { authorship: { kind: "unknown" } },
      { disposition: "not_required" },
      { requestedVisibility: "self" },
      { title: " 标题" },
      { body: "𠀀".repeat(10_001) },
      { items: [{ ...submission.items[0], variants: ["thumb", "thumb"] }] },
      // The viewer zoom still is a reader candidate, never a moderation
      // derivative of the queue (unified media pipeline).
      { items: [{ ...submission.items[0], variants: ["display", "viewer"] }] },
    ])
      expect(
        operatorWorkSubmissionSchema.safeParse({ ...submission, ...invalid })
          .success,
      ).toBe(false);

    // Thumb and cover of a cropped cover item use their own key; every other
    // item names none.
    const croppedKey = "c".repeat(32);
    const second = {
      ...submission.items[0]!,
      position: 2,
      itemId: `media-item-${hex("e")}`,
      edit: { rotation: 90, crop: null },
      editKey: "e".repeat(32),
      coverEditKey: null,
    };
    const cropped = {
      ...submission,
      coverCrop: { x: 0, y: 0.25, width: 1, height: 0.5 },
      items: [
        {
          ...submission.items[0]!,
          coverEditKey: croppedKey,
          variants: ["thumb", "display", "cover"],
        },
        second,
      ],
    };
    expect(operatorWorkSubmissionSchema.safeParse(cropped).success).toBe(true);
    expect(
      operatorWorkSubmissionSchema.safeParse({
        ...cropped,
        coverItemId: null,
        coverCrop: null,
        items: [{ ...cropped.items[0], coverEditKey: null }, second],
      }).success,
    ).toBe(true);
    for (const items of [
      [{ ...cropped.items[0], coverEditKey: null }, second],
      [cropped.items[0], { ...second, coverEditKey: croppedKey }],
      [cropped.items[0], { ...second, coverEditKey: undefined }],
      [{ ...cropped.items[0], coverEditKey: "cover" }, second],
    ])
      expect(
        operatorWorkSubmissionSchema.safeParse({ ...cropped, items }).success,
      ).toBe(false);
    expect(
      operatorWorkSubmissionQuerySchema.safeParse({ state: "not_required" })
        .success,
    ).toBe(false);
    const result = {
      revisionId,
      workId,
      disposition: "approved",
      version: 2,
    };
    expect(workSubmissionModerationResultSchema.safeParse(result).success).toBe(
      true,
    );
    expect(
      workSubmissionModerationResultSchema.safeParse({
        ...result,
        disposition: "pending",
      }).success,
    ).toBe(false);
  });

  it("keeps jobs content-free and queues bounded", () => {
    const job = {
      id: `publishing-job-${hex("9")}`,
      kind: "purge_blob",
      subjectId: `media-blob-${hex("8")}`,
      state: "failed",
      attempts: 5,
      maxAttempts: 5,
      runAfter: "2026-09-13T10:00:00.000Z",
      leaseExpiresAt: null,
      lastErrorCode: "unlink_failed",
      createdAt: "2026-09-13T09:00:00.000Z",
      updatedAt: "2026-09-13T10:00:00.000Z",
      finishedAt: "2026-09-13T10:00:00.000Z",
    };
    expect(operatorPublishingJobSchema.safeParse(job).success).toBe(true);
    for (const invalid of [
      { lastErrorCode: "ENOENT: /srv/media/blobs/aa/bb/file" },
      { subjectId: "blobs/aa/bb/IMG_0001.HEIC" },
      { payload: {} },
    ])
      expect(
        operatorPublishingJobSchema.safeParse({ ...job, ...invalid }).success,
      ).toBe(false);
    expect(
      operatorWorkSubmissionQuerySchema.parse({ state: "pending", page: "2" }),
    ).toEqual({ state: "pending", page: 2, pageSize: 20 });
    expect(
      operatorWorkSubmissionQuerySchema.safeParse({ pageSize: "51" }).success,
    ).toBe(false);
  });
});

describe("work publishing JSON Schemas", () => {
  it("exports strict components free of forbidden OpenAPI terms and names", () => {
    const serialized = JSON.stringify(workPublishingJsonSchemas).toLowerCase();
    for (const term of [
      "rawsource",
      "candidate",
      "evidence",
      "review",
      "lifecycle",
      "objectkey",
      "object_key",
      "bucket",
      "storageprovider",
      "storage_provider",
      "images",
      "city",
      "sourceid",
      "source_id",
      "workflow",
      "moderation",
      "operator",
      "internal",
    ])
      expect(serialized).not.toContain(term);
    for (const name of Object.keys(workPublishingJsonSchemas))
      expect(authorCommunityJsonSchemas).not.toHaveProperty(name);
    expect(workPublishingJsonSchemas.PublishingMediaItem).toMatchObject({
      additionalProperties: false,
      type: "object",
    });
    expect(
      JSON.stringify(workPublishingJsonSchemas.RegisterMediaItemCommand),
    ).not.toMatch(/pendingName|fileName|filename|gps/iu);
    expect(
      workPublishingJsonSchemas.PublishingDraftDeletionCommand,
    ).toMatchObject({
      additionalProperties: false,
      required: ["requestId"],
      type: "object",
    });
    expect(workPublishingJsonSchemas.PublishingReadinessCommand).toMatchObject({
      additionalProperties: false,
      required: ["content"],
      type: "object",
    });
    expect(workPublishingJsonSchemas.PublishingReadiness).toMatchObject({
      additionalProperties: false,
      required: ["ready", "pendingItemKeys", "failedItemKeys", "editKeys"],
      type: "object",
      properties: { editKeys: { type: "object" } },
    });
  });
});
