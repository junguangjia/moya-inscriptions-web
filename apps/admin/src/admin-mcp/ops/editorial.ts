import {
  editorialOperationDefinitions,
  type EditorialOperationName,
} from "../../editorial/endpoints";
import { failedEnvelope, okEnvelope } from "../envelope";
import { outlineEnvelope } from "../record-views";
import { CMS_FAMILIES, readLatest, rowIdOf } from "../records";
import {
  asynchronous,
  example,
  readOp,
  reversibleOp,
  type AdminOpContext,
  type AdminOpEntry,
} from "./define";

const bindsIdentity = "the save binds an identity not yet bound";

/** A page whose route already answers in small rows, relayed as it stands. */
const relayed =
  (route: "owner-drafts" | "owner-history") =>
  async (input: unknown, { req }: AdminOpContext) =>
    okEnvelope(await editorialOperationDefinitions[route].run(req, input), [
      "/data/docs",
    ]);

const rows: Readonly<Record<EditorialOperationName, AdminOpEntry>> = {
  "owner-drafts": readOp("The review page of Catalog drafts.", {
    example: { page: 1, pageSize: 20 },
    run: relayed("owner-drafts"),
  }),
  "owner-history": readOp("A Catalog's version history.", {
    example: { id: 7, page: 1 },
    run: relayed("owner-history"),
  }),
  // The whole draft would not fit one text result: its outline, and admin_get reads on.
  "read-draft": readOp("One Catalog draft's outline and its revision.", {
    example: { id: 7 },
    run: async (input, { req }) => {
      const family = CMS_FAMILIES.catalog;
      const { id } = input as { id: number | string };
      const row = await rowIdOf(req, family, id);
      return row === undefined
        ? failedEnvelope("NOT_FOUND")
        : outlineEnvelope(req, family, await readLatest(req, family, row));
    },
  }),
  "save-draft": reversibleOp(
    "Create or edit one Catalog draft. Never publishes.",
    "receipt",
    {
      risesWhen: bindsIdentity,
      example: {
        id: 7,
        expectedRevision: 4,
        idempotencyKey: example.idempotencyKey,
        content: {
          catalogId: "synthetic-catalog",
          sourceId: "synthetic-source",
          kind: "inscription",
          title: "Synthetic title",
        },
      },
    },
  ),
  "approve-batch": reversibleOp(
    "Approve exact Catalog revisions for an automation account.",
    "receipt",
    {
      example: {
        automationUserId: 11,
        items: [{ id: 7, revision: 4 }],
      },
    },
  ),
  "publish-approved": reversibleOp(
    "Publish one approved exact Catalog revision.",
    "receipt",
    {
      example: {
        approvalId: 3,
        id: 7,
        idempotencyKey: example.idempotencyKey,
      },
    },
  ),
  "restore-draft": reversibleOp(
    "Restore a past version as a new draft.",
    "cas_read_back",
    { example: { versionId: 21, expectedRevision: 4 } },
  ),
  "prepare-catalog-delivery": reversibleOp(
    "Prepare one Catalog draft's images for release.",
    "receipt",
    {
      completion: asynchronous,
      example: {
        id: 7,
        expectedRevision: 4,
        expectedFingerprint: example.digest,
        idempotencyKey: example.idempotencyKey,
      },
    },
  ),
  "read-catalog-delivery": readOp("One delivery intent and its state.", {
    example: { intentId: "00000000-0000-4000-8000-000000000002" },
  }),
  "request-catalog-release": reversibleOp(
    "Ask to release a prepared delivery.",
    "receipt",
    {
      completion: asynchronous,
      example: {
        intentId: "00000000-0000-4000-8000-000000000002",
        expectedStateVersion: 1,
        expectedManifestSha256: example.digest,
        idempotencyKey: example.idempotencyKey,
      },
    },
  ),
  "release-catalog-delivery": reversibleOp(
    "Publish a released delivery, or refuse while it is pending.",
    "receipt",
    {
      example: {
        intentId: "00000000-0000-4000-8000-000000000002",
        expectedStateVersion: 2,
        expectedRevision: 4,
        expectedFingerprint: example.digest,
        idempotencyKey: example.idempotencyKey,
      },
    },
  ),
  "cancel-catalog-delivery": reversibleOp(
    "Cancel a delivery intent.",
    "receipt",
    {
      example: {
        intentId: "00000000-0000-4000-8000-000000000002",
        expectedStateVersion: 1,
        idempotencyKey: example.idempotencyKey,
      },
    },
  ),
  "catalog-delivery-capabilities": readOp(
    "Whether Catalog delivery is configured here.",
    { example: {} },
  ),
  "catalog-render-backlog": readOp("Counts of images awaiting a render.", {
    example: {},
  }),
  "save-article-draft": reversibleOp(
    "Create or edit one Article draft. Never publishes.",
    "receipt",
    {
      risesWhen: bindsIdentity,
      example: {
        id: 7,
        expectedRevision: 2,
        idempotencyKey: example.idempotencyKey,
        content: { title: "Synthetic title" },
      },
    },
  ),
  "approve-article-batch": reversibleOp(
    "Approve exact Article revisions for an automation account.",
    "receipt",
    {
      example: {
        automationUserId: 11,
        items: [{ id: 7, revision: 2 }],
      },
    },
  ),
  "publish-approved-article": reversibleOp(
    "Publish one approved exact Article revision.",
    "receipt",
    {
      example: {
        approvalId: 3,
        id: 7,
        idempotencyKey: example.idempotencyKey,
      },
    },
  ),
};

type EditorialOps = {
  readonly [
    Route in EditorialOperationName as `editorial.${Route}`
  ]: AdminOpEntry;
};

/** Each row takes its input from the definition its route runs. */
export const editorialOps = Object.fromEntries(
  (Object.entries(rows) as [EditorialOperationName, AdminOpEntry][]).map(
    ([route, row]): readonly [`editorial.${string}`, AdminOpEntry] => [
      `editorial.${route}`,
      { ...row, input: editorialOperationDefinitions[route].input },
    ],
  ),
) as EditorialOps;
