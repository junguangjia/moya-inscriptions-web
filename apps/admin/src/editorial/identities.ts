import type { EditorialDraft } from "@moya/contracts/internal/editorial";
import type { CollectionConfig, PayloadRequest } from "payload";

import { EditorialError } from "./errors";
import { isIdentityRequest, withIdentityAccess } from "./state";
import { lockEditorialKey } from "./transaction";

/** Permanent identity bindings outlive draft removal and version retention. */
export const EditorialIdentities: CollectionConfig = {
  slug: "editorial-identities",
  admin: { hidden: true },
  access: {
    read: ({ req }) => isIdentityRequest(req),
    create: ({ req }) => isIdentityRequest(req),
    update: () => false,
    delete: () => false,
  },
  fields: [
    { name: "identityValue", type: "text", unique: true, required: true },
    {
      name: "kind",
      type: "select",
      options: ["catalog", "source"],
      required: true,
    },
    { name: "catalogId", type: "text", required: true },
  ],
  hooks: {
    beforeOperation: [
      ({ args, operation, req }) => {
        if (
          ["create", "update", "delete"].includes(operation) &&
          (operation !== "create" || !isIdentityRequest(req))
        ) {
          throw new EditorialError("IDENTITY_SERVER_ONLY", 403);
        }
        return args;
      },
    ],
  },
};

/** Which of these no record has bound yet. Bindings only ever grow. */
export const unboundEditorialIdentities = (
  req: PayloadRequest,
  values: readonly string[],
): Promise<readonly string[]> =>
  withIdentityAccess(req, async () => {
    const { docs } = await req.payload.find({
      collection: "editorial-identities",
      where: { identityValue: { in: [...values] } },
      select: { identityValue: true },
      limit: values.length,
      pagination: false,
      depth: 0,
      req,
      user: req.user,
      overrideAccess: false,
    });
    const bound = new Set(docs.map(({ identityValue }) => identityValue));
    return values.filter((value) => !bound.has(value));
  });

export const claimEditorialIdentities = async (
  req: PayloadRequest,
  content: EditorialDraft,
): Promise<void> => {
  const identities = [
    { identityValue: String(content.catalogId), kind: "catalog" as const },
    ...[
      ...new Set([
        content.sourceId,
        ...content.provenance.map(({ sourceId }) => sourceId),
      ]),
    ].map((sourceId) => ({
      identityValue: String(sourceId),
      kind: "source" as const,
    })),
  ].sort((left, right) =>
    left.identityValue < right.identityValue
      ? -1
      : left.identityValue > right.identityValue
        ? 1
        : 0,
  );
  for (const { identityValue } of identities) {
    await lockEditorialKey(req, `identity:${identityValue}`);
  }
  await withIdentityAccess(req, async () => {
    for (const identity of identities) {
      const result = await req.payload.find({
        collection: "editorial-identities",
        where: { identityValue: { equals: identity.identityValue } },
        limit: 1,
        depth: 0,
        req,
        user: req.user,
        overrideAccess: false,
      });
      const existing = result.docs[0];
      if (existing) {
        if (
          existing.kind !== identity.kind ||
          existing.catalogId !== content.catalogId
        ) {
          throw new EditorialError("IDENTITY_ALREADY_BOUND", 409, [
            "catalogId",
            "sourceId",
            "provenance",
          ]);
        }
        continue;
      }
      await req.payload.create({
        collection: "editorial-identities",
        data: { ...identity, catalogId: content.catalogId },
        depth: 0,
        req,
        user: req.user,
        overrideAccess: false,
      });
    }
  });
};
