import { z } from "zod";

import {
  EDITORIAL_STATEFUL_FIELDS,
  isWellFormedEditorialText,
} from "../editorial/schemas.js";
import { adminSaveEchoSchema } from "./execute.js";
import { ADMIN_CMS_RECORD_TYPES } from "./locate.js";

/**
 * The CMS ops of admin_execute (admin-mcp-completion-v1 section 10). Each runs the
 * operation the Admin runs; these are only what a client sends for it and reads back.
 */

const wellFormed = (maximum: number) =>
  z.string().max(maximum).refine(isWellFormedEditorialText);

/** A number is the record's row id; a string is its public identity. */
const recordId = z.union([
  z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  wellFormed(128).min(1),
]);
const rowId = z.union([
  z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  z.string().regex(/^[1-9]\d{0,15}$/u),
]);
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);

/** What the record was when the caller decided. A record that moved is refused. */
export const adminExpectedSchema = z.strictObject({
  revision,
  fingerprint: digest.optional(),
});

export const adminPublicationInputSchema = z.strictObject({
  id: recordId,
  expected: adminExpectedSchema,
});

export const adminRestoreInputSchema = z.strictObject({
  id: recordId,
  versionId: rowId,
  expected: adminExpectedSchema,
});

/** The long text fields of a Catalog: a window of any of them can be read and sent. */
export const ADMIN_PATCH_TEXT_FIELDS = [
  "title",
  "summary",
  "periodLabel",
  "ownerNote",
  ...EDITORIAL_STATEFUL_FIELDS,
] as const;

const PATCH_TEXT_MAX_UNITS = 100_000;
const PATCH_MAX_EDITS = 50;

/** No normalization of any kind: what is sent is what is compared, unit by unit. */
export const adminPatchTextInputSchema = z.strictObject({
  catalogId: recordId,
  field: z.enum(ADMIN_PATCH_TEXT_FIELDS),
  edits: z
    .array(
      z
        .strictObject({
          oldText: wellFormed(PATCH_TEXT_MAX_UNITS).min(1),
          newText: wellFormed(PATCH_TEXT_MAX_UNITS),
          /** From 1. Says which place when oldText is in several on purpose. */
          occurrence: z.number().int().positive().max(1_000_000).optional(),
        })
        .refine(({ oldText, newText }) => oldText !== newText, {
          path: ["newText"],
          message: "An edit changes the text",
        }),
    )
    .min(1)
    .max(PATCH_MAX_EDITS),
  expected: z.strictObject({ revision, fingerprint: digest }),
});

const adminPatchRangeSchema = z.strictObject({
  /** In code points, in the new text, as admin_get's windows count. */
  offset: z.number().int().nonnegative(),
  oldLength: z.number().int().nonnegative(),
  newLength: z.number().int().nonnegative(),
  /** What surrounds it now, for the first edits: no more would fit one answer. */
  before: z.string().optional(),
  after: z.string().optional(),
});

/** Absent on a replay: a receipt keeps the revision and fingerprint, not the text. */
export const adminPatchEchoSchema = adminSaveEchoSchema.extend({
  field: z.enum(ADMIN_PATCH_TEXT_FIELDS).optional(),
  oldHash: digest.optional(),
  newHash: digest.optional(),
  newTotalLength: z.number().int().nonnegative().optional(),
  ranges: z.array(adminPatchRangeSchema).optional(),
});

const collectionText = (maximum: number) => wellFormed(maximum).nullable();

const collectionMemberSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("article"), article: rowId }),
  z.strictObject({ kind: z.literal("catalog"), catalogId: wellFormed(160) }),
]);

/** Field lengths and what must exist stay with the collection's own validation. */
export const adminCollectionSaveInputSchema = z.strictObject({
  id: recordId.optional(),
  expected: adminExpectedSchema.optional(),
  content: z
    .strictObject({
      title: wellFormed(120),
      subtitle: collectionText(120),
      summary: collectionText(1_000),
      category: collectionText(60),
      issue: collectionText(40),
      coverCatalog: rowId.nullable(),
      members: z.array(collectionMemberSchema).max(200),
    })
    .partial()
    .refine((content) => Object.keys(content).length > 0, {
      message: "A save names a field",
    }),
});

const articleText = z.string().refine(isWellFormedEditorialText).nullable();

/**
 * What a key may send of an Article: the fields its fingerprint covers, each of its
 * own kind, so a wrong one never reads as an emptied list. Nothing the server sets is
 * here. Field lengths and what must exist stay with the collection's own validation.
 */
export const adminArticleContentSchema = z
  .strictObject({
    presentation: articleText,
    title: articleText,
    subtitle: articleText,
    summary: articleText,
    section: articleText,
    issue: articleText,
    byline: articleText,
    coverCatalog: rowId.nullable(),
    coverAlt: articleText,
    intro: articleText,
    sections: z.array(
      z
        .strictObject({
          id: articleText,
          heading: articleText,
          body: articleText,
          imageCatalog: rowId.nullable(),
          imageCaption: articleText,
        })
        .partial(),
    ),
    citations: z.array(
      z
        .strictObject({ id: articleText, text: articleText, url: articleText })
        .partial(),
    ),
  })
  .partial();

/** A media row's other fields are permanent, so alt is all there is to edit. */
export const adminMediaUpdateInputSchema = z.strictObject({
  id: recordId,
  alt: wellFormed(2_000).min(1),
  expected: z.strictObject({ fingerprint: digest }),
});

/** Registering a new id is irreversible: only a row that exists answers directly. */
export const adminMediaRegisterInputSchema = z.strictObject({
  mediaId: wellFormed(128).min(1),
  catalogId: wellFormed(160).min(1),
  objectKey: wellFormed(2_048).min(1),
  sha256: digest,
  mimeType: z.enum(["image/jpeg", "image/png", "image/webp"]),
  filesize: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  width: z.number().int().positive().max(2_147_483_647),
  height: z.number().int().positive().max(2_147_483_647),
  alt: wellFormed(2_000).min(1),
  rights: wellFormed(2_000).optional(),
  orderConfidence: z.enum(["HIGH", "LOW"]).optional(),
});

export const adminApprovalRevokeInputSchema = z.strictObject({
  approvalId: rowId,
  /** Catalog and Article approvals are numbered apart, so this picks which. */
  type: z.enum(["catalog", "article"]),
});

const positiveInteger = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);

/** The lock as it was read: a holder still working moves it, and is not taken from. */
export const adminLockTakeoverInputSchema = z.strictObject({
  type: z.enum(ADMIN_CMS_RECORD_TYPES),
  id: recordId,
  expected: z.strictObject({
    lockId: positiveInteger,
    holderUserId: positiveInteger,
    // Year 0000 passes the format and no PostgreSQL timestamp can hold it.
    lastEditedAt: z.iso.datetime().refine((value) => !value.startsWith("0000")),
  }),
  reason: wellFormed(500).min(1),
});

export const adminLockReleaseInputSchema = z.strictObject({
  type: z.enum(ADMIN_CMS_RECORD_TYPES),
  id: recordId,
});

/** The revision and fingerprint to save on: the holder's last autosave may have moved them. */
export const adminLockTakeoverEchoSchema = z.strictObject({
  type: z.enum(ADMIN_CMS_RECORD_TYPES),
  id: z.number().int().positive(),
  title: z.string().optional(),
  lockId: z.number().int().positive(),
  expiresAt: z.string(),
  /** A media row has no revision. */
  revision: z.number().int().nonnegative().optional(),
  /** Null where stored content no longer parses, as admin_get says. */
  fingerprint: z.string().nullable(),
  replayed: z.literal(true).optional(),
});

export const adminLockReleaseEchoSchema = z.strictObject({
  type: z.enum(ADMIN_CMS_RECORD_TYPES),
  id: z.number().int().positive(),
  released: z.literal(true),
});

export type AdminPublicationInput = z.infer<typeof adminPublicationInputSchema>;
export type AdminRestoreInput = z.infer<typeof adminRestoreInputSchema>;
export type AdminPatchTextInput = z.infer<typeof adminPatchTextInputSchema>;
export type AdminPatchEcho = z.infer<typeof adminPatchEchoSchema>;
export type AdminCollectionSaveInput = z.infer<
  typeof adminCollectionSaveInputSchema
>;
export type AdminMediaUpdateInput = z.infer<typeof adminMediaUpdateInputSchema>;
export type AdminMediaRegisterInput = z.infer<
  typeof adminMediaRegisterInputSchema
>;
export type AdminApprovalRevokeInput = z.infer<
  typeof adminApprovalRevokeInputSchema
>;
export type AdminLockTakeoverInput = z.infer<
  typeof adminLockTakeoverInputSchema
>;
export type AdminLockTakeoverEcho = z.infer<typeof adminLockTakeoverEchoSchema>;
