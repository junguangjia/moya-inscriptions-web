import { adminSaveEchoSchema } from "@moya/contracts/internal/admin-mcp";
import type {
  CatalogDeliveryResult,
  OwnerDraftPage,
} from "@moya/contracts/internal/editorial";
import { sql, type PostgresAdapter } from "@payloadcms/db-postgres";
import { z } from "zod";

import {
  editorialOperationDefinitions,
  type EditorialOperationName,
} from "../../editorial/endpoints";
import { approveBatchOnce, restoreDraftOnce } from "../../editorial/operations";
import { isMissingRecord } from "../../editorial/transaction";
import { approveArticleBatchOnce } from "../../editorial-content/operations";
import { failedEnvelope, okEnvelope } from "../envelope";
import { outlineEnvelope } from "../record-views";
import { CMS_FAMILIES, readLatest, rowIdOf } from "../records";
import { envelopeCodeOf, targetFailureOf } from "../refusal";
import {
  example,
  numberedPageAfter,
  onField,
  readOp,
  requestKeyOf,
  reversibleOp,
  type AdminOpContext,
  type AdminOpEntry,
} from "./define";
import {
  classifyArticleSave,
  classifyCatalogSave,
  saveArticle,
  saveCatalogDraft,
} from "./saves";

const bindsIdentity = "the save binds an identity not yet bound";

/** A write takes its key from requestId and index, so a client never sends one. */
const inputWithoutKey = (route: EditorialOperationName) =>
  (editorialOperationDefinitions[route].input as z.ZodObject).omit({
    idempotencyKey: true,
  });

const saveInput = (route: EditorialOperationName) =>
  inputWithoutKey(route).extend({ allowRemoving: z.boolean().optional() });

/** The route's own operation, under this target's key. */
const relayedWrite =
  (route: EditorialOperationName) =>
  async (input: unknown, context: AdminOpContext) =>
    okEnvelope(
      await editorialOperationDefinitions[route].run(context.req, {
        ...(input as object),
        idempotencyKey: requestKeyOf(context),
      }),
    );

/** A read has no target to report on, so its refusal is the whole answer. */
const relayedRead =
  (route: EditorialOperationName, untrusted: readonly string[] = []) =>
  async (input: unknown, { req }: AdminOpContext) => {
    try {
      return okEnvelope(
        await editorialOperationDefinitions[route].run(req, input),
        untrusted,
      );
    } catch (error) {
      const { state, code } = targetFailureOf(error);
      // No named refusal: as any read's failure, not a statement about the data.
      if (state === "unknown") throw error;
      const named = envelopeCodeOf(code);
      return failedEnvelope(
        named,
        named === code ? {} : { data: { failed: [{ index: 0, code }] } },
      );
    }
  };

const onCatalog = { target: onField("catalog", "id") } as const;
const onArticle = { target: onField("article", "id") } as const;
const onDelivery = { target: onField("catalog_delivery", "intentId") } as const;

const SAVE_POINTERS = [
  "/data/results/*/title",
  "/data/results/*/catalogId",
  "/data/results/*/removedItems/media/*",
  "/data/results/*/removedItems/provenance/*",
];
const ARTICLE_SAVE_POINTERS = [
  "/data/results/*/title",
  "/data/results/*/articleId",
];
const DELIVERY_POINTERS = ["/data/results/*/catalogId"];

const DELIVERY_STEPS: Readonly<Record<string, string>> = {
  prepared:
    "Prepared, and nothing is public. Call editorial.request-catalog-release with stateVersion and manifestSha256 from results. Repeating this call cannot change the answer.",
  release_requested:
    "Release requested, and nothing is public yet. Read the delivery until readiness is READY, then call editorial.release-catalog-delivery with its stateVersion, revision and fingerprint. Repeating this call cannot change the answer.",
};

/**
 * Prepare and request-release only ask the worker to render: accepted never reads as
 * done, and the answer says where to read how far it got. Only a replay finds the
 * intent has moved since, and then says what it is now: released is the effect this
 * command asked for, and an ended one has nothing left to wait for.
 */
const deliveryAccepted: AdminOpEntry["completion"] = {
  kind: "async",
  settle: async (_input, result) => {
    const { intentId, state, readiness } = result as CatalogDeliveryResult;
    if (state === "released") return { ok: true, code: "OK" };
    if (state === "expired")
      return { ok: false, code: "CATALOG_DELIVERY_EXPIRED" };
    const step = DELIVERY_STEPS[state];
    if (step === undefined)
      return { ok: false, code: "CATALOG_DELIVERY_INACTIVE" };
    // No Backend pinned a recipe, so no worker will ever render this one.
    if (readiness === "NOT_CONFIGURED")
      return { ok: false, code: "CATALOG_DELIVERY_NOT_CONFIGURED" };
    return {
      ok: false,
      code: "QUEUED",
      state,
      hint: step,
      next: {
        tool: "admin_read",
        args: { op: "editorial.read-catalog-delivery", input: { intentId } },
      },
    };
  },
};

/** A release publishes the record behind its intent, so that is what can be held. */
const intentRecord = async (input: unknown, { req }: AdminOpContext) => {
  const { drizzle } = req.payload.db as unknown as Pick<
    PostgresAdapter,
    "drizzle"
  >;
  const { intentId } = input as { intentId: string };
  const { rows } = await drizzle.execute(sql`
    SELECT catalog_document_id FROM catalog_delivery_intents
    WHERE id = ${intentId}::uuid`);
  const id = rows[0]?.catalog_document_id;
  return { type: "catalog", ...(id === undefined ? {} : { id: Number(id) }) };
};

/** A page whose route already answers in small rows. A missing row is a miss. */
const relayedHistory = async (input: unknown, { req }: AdminOpContext) => {
  try {
    return okEnvelope(
      await editorialOperationDefinitions["owner-history"].run(req, input),
      ["/data/docs"],
    );
  } catch (error) {
    if (isMissingRecord(error)) return failedEnvelope("NOT_FOUND");
    throw error;
  }
};

/**
 * A cut page keeps fewer rows than it read, so its number and page count would be a
 * second way on, and one that skips rows. `next` is the one, whole page or cut, and
 * a cut replaces it with a page right after the rows kept. totalDocs stays.
 */
const reviewPage = async (input: unknown, { req, read }: AdminOpContext) => {
  const { docs, totalDocs, automationUsers, page, totalPages } =
    (await editorialOperationDefinitions["owner-drafts"].run(
      req,
      input,
    )) as OwnerDraftPage;
  const envelope = okEnvelope({ docs, totalDocs, automationUsers }, [
    "/data/docs",
  ]);
  const { pageSize } = input as { pageSize: number };
  return page < totalPages
    ? {
        ...envelope,
        next: {
          tool: "admin_read",
          args: {
            ...read,
            input: {
              ...read?.input,
              ...numberedPageAfter(page, pageSize, docs.length),
            },
          },
        },
      }
    : envelope;
};

const rows: Readonly<Record<EditorialOperationName, AdminOpEntry>> = {
  "owner-drafts": readOp("The review page of Catalog drafts.", {
    example: { page: 1, pageSize: 20 },
    run: reviewPage,
    paging: "numbered",
  }),
  "owner-history": readOp("A Catalog's version history.", {
    example: { id: 7, page: 1 },
    run: relayedHistory,
  }),
  // The whole draft would not fit one text result: its outline, and admin_get reads on.
  "read-draft": readOp("One Catalog draft's outline and its revision.", {
    example: { id: 7 },
    run: async (input, { req }) => {
      const family = CMS_FAMILIES.catalog;
      const { id } = input as { id: number | string };
      const row = await rowIdOf(req, family, id);
      if (row === undefined) return failedEnvelope("NOT_FOUND");
      try {
        return await outlineEnvelope(
          req,
          family,
          await readLatest(req, family, row),
        );
      } catch (error) {
        if (isMissingRecord(error)) return failedEnvelope("NOT_FOUND");
        throw error;
      }
    },
  }),
  "save-draft": reversibleOp(
    "Create or edit one Catalog draft. Never publishes.",
    "receipt",
    {
      risesWhen: bindsIdentity,
      classify: classifyCatalogSave,
      input: saveInput("save-draft"),
      output: { ai: adminSaveEchoSchema },
      run: saveCatalogDraft,
      untrusted: SAVE_POINTERS,
      ...onCatalog,
      example: {
        id: 7,
        expectedRevision: 4,
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
      run: async (input, context) =>
        okEnvelope(
          await approveBatchOnce(context.req, requestKeyOf(context), input),
        ),
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
      input: inputWithoutKey("publish-approved"),
      run: relayedWrite("publish-approved"),
      ...onCatalog,
      example: { approvalId: 3, id: 7 },
    },
  ),
  "restore-draft": reversibleOp(
    "Restore a past version as a new draft.",
    "receipt",
    {
      run: async (input, context) =>
        okEnvelope(
          await restoreDraftOnce(context.req, requestKeyOf(context), input),
        ),
      target: onField("catalog_version", "versionId"),
      example: { versionId: 21, expectedRevision: 4 },
    },
  ),
  "prepare-catalog-delivery": reversibleOp(
    "Prepare one Catalog draft's images for release.",
    "receipt",
    {
      completion: deliveryAccepted,
      input: inputWithoutKey("prepare-catalog-delivery"),
      run: relayedWrite("prepare-catalog-delivery"),
      untrusted: DELIVERY_POINTERS,
      ...onCatalog,
      example: {
        id: 7,
        expectedRevision: 4,
        expectedFingerprint: example.digest,
      },
    },
  ),
  "read-catalog-delivery": readOp("One delivery intent and its state.", {
    run: relayedRead("read-catalog-delivery", ["/data/catalogId"]),
    example: { intentId: "00000000-0000-4000-8000-000000000002" },
  }),
  "request-catalog-release": reversibleOp(
    "Ask to release a prepared delivery.",
    "receipt",
    {
      completion: deliveryAccepted,
      input: inputWithoutKey("request-catalog-release"),
      run: relayedWrite("request-catalog-release"),
      untrusted: DELIVERY_POINTERS,
      ...onDelivery,
      example: {
        intentId: "00000000-0000-4000-8000-000000000002",
        expectedStateVersion: 1,
        expectedManifestSha256: example.digest,
      },
    },
  ),
  "release-catalog-delivery": reversibleOp(
    "Publish a released delivery, or refuse while it is pending.",
    "receipt",
    {
      input: inputWithoutKey("release-catalog-delivery"),
      run: relayedWrite("release-catalog-delivery"),
      untrusted: DELIVERY_POINTERS,
      lockedRecord: intentRecord,
      ...onDelivery,
      example: {
        intentId: "00000000-0000-4000-8000-000000000002",
        expectedStateVersion: 2,
        expectedRevision: 4,
        expectedFingerprint: example.digest,
      },
    },
  ),
  "cancel-catalog-delivery": reversibleOp(
    "Cancel a delivery intent.",
    "receipt",
    {
      input: inputWithoutKey("cancel-catalog-delivery"),
      run: relayedWrite("cancel-catalog-delivery"),
      untrusted: DELIVERY_POINTERS,
      ...onDelivery,
      example: {
        intentId: "00000000-0000-4000-8000-000000000002",
        expectedStateVersion: 1,
      },
    },
  ),
  "catalog-delivery-capabilities": readOp(
    "Whether Catalog delivery is configured here.",
    { run: relayedRead("catalog-delivery-capabilities"), example: {} },
  ),
  "catalog-render-backlog": readOp("Counts of images awaiting a render.", {
    run: relayedRead("catalog-render-backlog"),
    example: {},
  }),
  "save-article-draft": reversibleOp(
    "Create or edit one Article draft. Never publishes.",
    "receipt",
    {
      risesWhen: bindsIdentity,
      classify: classifyArticleSave,
      input: saveInput("save-article-draft"),
      output: { ai: adminSaveEchoSchema },
      run: saveArticle,
      untrusted: ARTICLE_SAVE_POINTERS,
      ...onArticle,
      example: {
        id: 7,
        expectedRevision: 2,
        content: { title: "Synthetic title" },
      },
    },
  ),
  "approve-article-batch": reversibleOp(
    "Approve exact Article revisions for an automation account.",
    "receipt",
    {
      run: async (input, context) =>
        okEnvelope(
          await approveArticleBatchOnce(
            context.req,
            requestKeyOf(context),
            input,
          ),
        ),
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
      input: inputWithoutKey("publish-approved-article"),
      run: relayedWrite("publish-approved-article"),
      untrusted: ["/data/results/*/articleId"],
      ...onArticle,
      example: { approvalId: 3, id: 7 },
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
      {
        ...row,
        input: row.input ?? editorialOperationDefinitions[route].input,
      },
    ],
  ),
) as EditorialOps;
