import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLocalReq, getPayload, type TypedUser } from "payload";
import { PostgresCatalogQueryAdapter } from "@moya/catalog-postgres";
import { editorialDraftSchema } from "@moya/contracts/internal/editorial";

import config from "admin/config";
import {
  approveBatch,
  ownerDraftPage,
  ownerHistoryPage,
  publishApproved,
  readDraft,
  restoreDraft,
  saveDraft,
} from "admin/editorial";

if (
  process.env.CMS_ENVIRONMENT !== "synthetic" ||
  !process.env.CMS_DATABASE_URL
) {
  throw new Error("An isolated synthetic CMS database is required");
}

const run = randomUUID();
const catalogId = (suffix: string) => `synthetic-${run}-${suffix}`;
const complete = (suffix: string) => ({
  catalogId: catalogId(suffix),
  sourceId: `source-${run}-${suffix}`,
  kind: "calligraphy",
  title: "Synthetic complete record",
  summary: "Synthetic summary",
  dynasty: { state: "UNSUPPLIED" },
  dateText: { state: "UNSUPPLIED" },
  province: { state: "UNSUPPLIED" },
  prefecture: { state: "UNSUPPLIED" },
  county: { state: "UNSUPPLIED" },
  currentLocation: { state: "UNSUPPLIED" },
  currentCustodian: { state: "UNSUPPLIED" },
  description: { state: "UNSUPPLIED" },
  scriptStyle: { state: "UNSUPPLIED" },
  transcription: { state: "VALUE", value: "異體字𠮷\n第二行　〔缺〕" },
  historicalContext: { state: "UNSUPPLIED" },
  scholarlyResearch: { state: "UNSUPPLIED" },
  aliases: [{ alias: "Synthetic alias", aliasType: "alternate" }],
  provenance: [],
  sourceCitations: [],
  contributors: [],
  media: [],
});

let payload: Awaited<ReturnType<typeof getPayload>>;
let owner: TypedUser;
let automation: TypedUser;
const reqFor = (user: TypedUser | null) =>
  createLocalReq(user ? { user } : {}, payload);
// Accounts and keys need an Owner browser session (amendment 2026-11-03).
const browserReqFor = (user: TypedUser) =>
  createLocalReq(
    {
      req: { headers: new Headers({ cookie: "payload-token=synthetic" }) },
      user: { ...user, _strategy: "local-jwt" } as unknown as TypedUser,
    },
    payload,
  );

beforeAll(async () => {
  payload = await getPayload({ config });
  // Bootstrap is restricted to this explicitly synthetic, isolated fixture.
  // Password values are generated in memory and never returned or logged.
  owner = await payload.create({
    collection: "users",
    overrideAccess: true,
    data: {
      email: `synthetic-owner-${run}@example.invalid`,
      password: randomUUID(),
      role: "owner",
    },
  });
  automation = await payload.create({
    collection: "users",
    overrideAccess: true,
    req: await reqFor(owner),
    user: owner,
    data: {
      email: `synthetic-automation-${run}@example.invalid`,
      password: randomUUID(),
      role: "automation",
      scopeCatalogIds: [
        "draft",
        "publish",
        "race",
        "approve-a",
        "approve-b",
        "restore",
        "rollback",
        "clear",
        "ownership-a",
        "ownership-b",
        "search",
      ].map(catalogId),
    },
  });
}, 30_000);

afterAll(async () => {
  if (payload) await payload.destroy();
});

describe.sequential("Payload PostgreSQL editorial workflow", () => {
  it("keeps Search on committed publications through drafts, restore, replay, rollback and withdrawal", async () => {
    const adapter = new PostgresCatalogQueryAdapter(payload.db.pool);
    const searchIds = async (q: string) =>
      (await adapter.search({ q, page: 1, pageSize: 10 })).items.map(
        ({ id }) => id,
      );
    const oldTitle = `合成檢索舊稿${run}`;
    const newTitle = `合成檢索新稿${run}`;
    const alias = `合成別名${run}`;
    const author = `合成作者${run}`;
    const description = `合成公開簡介${run}`;
    const privateNote = `合成私有備註${run}`;
    const first = await saveDraft(await reqFor(automation), {
      idempotencyKey: `${run}:search-create`,
      content: {
        ...complete("search"),
        title: oldTitle,
        aliases: [{ alias, aliasType: "alternate" }],
        contributors: [{ name: author, role: "textAuthor" }],
        description: { state: "VALUE", value: description },
        ownerNote: privateNote,
      },
    });
    expect(await searchIds(oldTitle)).toEqual([]);
    const grant = await approveBatch(await reqFor(owner), {
      automationUserId: automation.id,
      items: [{ id: first.id, revision: first.revision }],
    });
    const command = {
      approvalId: grant.approvalId,
      id: first.id,
      idempotencyKey: `${run}:search-publish`,
    };
    const published = await publishApproved(await reqFor(automation), command);
    for (const q of [
      oldTitle,
      `合成检索旧稿${run}`,
      alias,
      author,
      description,
    ])
      expect(await searchIds(q)).toEqual([catalogId("search")]);
    expect(await searchIds(privateNote)).toEqual([]);
    expect(await publishApproved(await reqFor(automation), command)).toEqual({
      ...published,
      replayed: true,
    });
    const versions = await payload.findVersions({
      collection: "catalogs",
      where: { parent: { equals: first.id } },
      sort: "createdAt",
      depth: 0,
      req: await reqFor(owner),
      user: owner,
      overrideAccess: false,
    });
    const draftCommand = {
      id: first.id,
      expectedRevision: published.revision,
      idempotencyKey: `${run}:search-draft`,
      content: {
        catalogId: catalogId("search"),
        sourceId: `source-${run}-search`,
        kind: "calligraphy",
        title: newTitle,
        aliases: [],
        contributors: [],
        description: { state: "CLEAR" },
      },
    };
    const edited = await saveDraft(await reqFor(automation), draftCommand);
    expect(await saveDraft(await reqFor(automation), draftCommand)).toEqual({
      ...edited,
      replayed: true,
    });
    expect(await searchIds(oldTitle)).toEqual([catalogId("search")]);
    expect(await searchIds(newTitle)).toEqual([]);
    const restored = await restoreDraft(await reqFor(owner), {
      versionId: versions.docs[0]!.id,
      expectedRevision: edited.revision,
    });
    expect(await searchIds(oldTitle)).toEqual([catalogId("search")]);
    const revised = await saveDraft(await reqFor(automation), {
      ...draftCommand,
      expectedRevision: restored.revision,
      idempotencyKey: `${run}:search-revised`,
    });

    // A completed native afterChange must still roll back with its caller's
    // transaction. A second public connection never sees the uncommitted title.
    const transactionalReq = await reqFor(owner);
    const transactionID = await payload.db.beginTransaction();
    if (!transactionID) throw new Error("Synthetic transaction required");
    transactionalReq.transactionID = transactionID;
    try {
      await payload.update({
        collection: "catalogs",
        id: first.id,
        data: { revision: revised.revision, _status: "published" },
        req: transactionalReq,
        user: owner,
        overrideAccess: false,
      });
      expect(await searchIds(oldTitle)).toEqual([catalogId("search")]);
      expect(await searchIds(newTitle)).toEqual([]);
    } finally {
      await payload.db.rollbackTransaction(transactionID);
      delete transactionalReq.transactionID;
    }
    expect(
      (await readDraft(await reqFor(owner), { id: first.id })).revision,
    ).toBe(revised.revision);
    expect(await searchIds(oldTitle)).toEqual([catalogId("search")]);
    const republished = await payload.update({
      collection: "catalogs",
      id: first.id,
      data: { revision: revised.revision, _status: "published" },
      req: await reqFor(owner),
      user: owner,
      overrideAccess: false,
    });
    expect(await searchIds(newTitle)).toEqual([catalogId("search")]);
    for (const q of [oldTitle, alias, author, description])
      expect(await searchIds(q)).toEqual([]);
    if (typeof republished.revision !== "number")
      throw new Error("Synthetic published revision required");
    await payload.update({
      collection: "catalogs",
      id: first.id,
      draft: false,
      data: { revision: republished.revision, _status: "draft" },
      req: await reqFor(owner),
      user: owner,
      overrideAccess: false,
    });
    expect(await searchIds(newTitle)).toEqual([]);
    expect(
      (
        await payload.db.pool.query(
          "SELECT catalog_id FROM catalog_search_documents WHERE catalog_id = $1",
          [catalogId("search")],
        )
      ).rows,
    ).toEqual([]);
    // Replaying an old approved command after withdrawal is only a receipt read.
    expect(await publishApproved(await reqFor(automation), command)).toEqual({
      ...published,
      replayed: true,
    });
    expect(await searchIds(oldTitle)).toEqual([]);
    expect(await searchIds(newTitle)).toEqual([]);
  });

  it("saves incomplete legal drafts, records real receipts, and replays without new versions", async () => {
    const content = {
      catalogId: catalogId("draft"),
      sourceId: `source-${run}-draft`,
      kind: "calligraphy",
    };
    const command = { idempotencyKey: `${run}:draft`, content };
    const result = await saveDraft(await reqFor(automation), command);
    expect(result.revision).toBe(1);
    const firstVersions = await payload.countVersions({
      collection: "catalogs",
      where: { parent: { equals: result.id } },
      req: await reqFor(owner),
      user: owner,
      overrideAccess: false,
    });
    const replayed = await saveDraft(await reqFor(automation), command);
    expect(replayed).toEqual({ ...result, replayed: true });
    const secondVersions = await payload.countVersions({
      collection: "catalogs",
      where: { parent: { equals: result.id } },
      req: await reqFor(owner),
      user: owner,
      overrideAccess: false,
    });
    expect(secondVersions.totalDocs).toBe(firstVersions.totalDocs);
    await expect(
      saveDraft(await reqFor(automation), {
        ...command,
        content: { ...content, title: "Changed replay" },
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(
      payload.update({
        collection: "catalogs",
        id: result.id,
        data: { revision: 1, _status: "published" },
        draft: false,
        req: await reqFor(owner),
        user: owner,
        overrideAccess: false,
      }),
    ).rejects.toMatchObject({ code: "CONTENT_INVALID" });
  });

  it("preserves exact text, identities, relations and published snapshot while automation edits drafts", async () => {
    const content = complete("publish");
    const first = await saveDraft(await reqFor(automation), {
      idempotencyKey: `${run}:publish-create`,
      content,
    });
    const published = await payload.update({
      collection: "catalogs",
      id: first.id,
      data: { revision: first.revision, _status: "published" },
      req: await reqFor(owner),
      user: owner,
      overrideAccess: false,
      overrideLock: false,
    });
    const edited = await saveDraft(await reqFor(automation), {
      id: first.id,
      expectedRevision: published.revision,
      idempotencyKey: `${run}:publish-draft`,
      content: {
        catalogId: content.catalogId,
        sourceId: content.sourceId,
        kind: content.kind,
        title: "Synthetic revised draft",
      },
    });
    const draft = await readDraft(await reqFor(owner), { id: first.id });
    const live = await payload.findByID({
      collection: "catalogs",
      id: first.id,
      draft: false,
      depth: 0,
      req: await reqFor(owner),
      user: owner,
      overrideAccess: false,
    });
    expect(edited.revision).toBe(Number(published.revision) + 1);
    expect(draft.content.transcription).toEqual(content.transcription);
    expect(draft.content.aliases).toEqual(content.aliases);
    expect(live.title).toBe(content.title);
    expect(live.revision).toBe(published.revision);
    expect(live._status).toBe("published");
    await expect(
      saveDraft(await reqFor(automation), {
        id: first.id,
        expectedRevision: edited.revision,
        idempotencyKey: `${run}:identity-denied`,
        content: { ...content, sourceId: `source-${run}-replacement` },
      }),
    ).rejects.toMatchObject({ code: "IDENTITY_IMMUTABLE" });
    await expect(
      payload.update({
        collection: "catalogs",
        id: first.id,
        data: { revision: edited.revision, _status: "published" },
        draft: true,
        req: await reqFor(automation),
        user: automation,
        overrideAccess: false,
      }),
    ).rejects.toMatchObject({ code: "PUBLISH_NOT_APPROVED" });
    await expect(
      payload.update({
        collection: "catalogs",
        id: first.id,
        data: { revision: edited.revision, _status: "draft" },
        draft: false,
        req: await reqFor(automation),
        user: automation,
        overrideAccess: false,
      }),
    ).rejects.toMatchObject({ code: "AUTOMATION_DRAFT_ONLY" });
  });

  it("preserves unspecified citation scopes through native save, read, update and restore", async () => {
    const unscoped = {
      label: "合成無範圍引用",
      citation: "異體字𠮷\r\n甲  乙",
    };
    const scoped = {
      label: "合成指定範圍引用",
      citation: "第二條\n〔闕〕",
      url: "https://example.invalid/synthetic-citation",
      appliesTo: ["scholarlyResearch", "record"],
    };
    const content = {
      ...complete("citation-scopes"),
      sourceCitations: [unscoped, scoped],
    };
    const expected = editorialDraftSchema.parse(content);
    const first = await saveDraft(await reqFor(owner), {
      idempotencyKey: `${run}:citation-scopes-create`,
      content,
    });
    const saved = await readDraft(await reqFor(owner), { id: first.id });
    expect(saved.content).toEqual(expected);
    expect(saved.fingerprint).toBe(first.fingerprint);
    const versions = await payload.findVersions({
      collection: "catalogs",
      where: { parent: { equals: first.id } },
      depth: 0,
      req: await reqFor(owner),
      user: owner,
      overrideAccess: false,
    });
    const originalVersion = versions.docs.find(
      (version) => version.version.revision === first.revision,
    );
    if (!originalVersion) throw new Error("Synthetic original version missing");

    const updatedContent = {
      ...content,
      sourceCitations: [
        { label: scoped.label, citation: scoped.citation, url: scoped.url },
        { ...unscoped, appliesTo: ["transcription", "description"] },
      ],
    };
    const edited = await saveDraft(await reqFor(owner), {
      id: first.id,
      expectedRevision: first.revision,
      idempotencyKey: `${run}:citation-scopes-update`,
      content: updatedContent,
    });
    const updated = await readDraft(await reqFor(owner), { id: first.id });
    expect(updated.content).toEqual(editorialDraftSchema.parse(updatedContent));
    expect(updated.revision).toBe(first.revision + 1);
    expect(updated.fingerprint).toBe(edited.fingerprint);
    expect(updated.fingerprint).not.toBe(first.fingerprint);

    const restored = await restoreDraft(await reqFor(owner), {
      versionId: originalVersion.id,
      expectedRevision: edited.revision,
    });
    const restoredDraft = await readDraft(await reqFor(owner), {
      id: first.id,
    });
    expect(restoredDraft.content).toEqual(expected);
    expect(restoredDraft.revision).toBe(edited.revision + 1);
    expect(restoredDraft.fingerprint).toBe(first.fingerprint);
    expect(restored.fingerprint).toBe(first.fingerprint);
  });

  it("requires an explicit main-record publication state and preserves explicit withdrawal", async () => {
    const content = complete("explicit-state");
    const first = await saveDraft(await reqFor(owner), {
      idempotencyKey: `${run}:explicit-state-create`,
      content,
    });
    const published = await payload.update({
      collection: "catalogs",
      id: first.id,
      data: { revision: first.revision, _status: "published" },
      req: await reqFor(owner),
      user: owner,
      overrideAccess: false,
      overrideLock: false,
    });
    const publishedRevision = Number(published.revision);
    const versionCount = await payload.countVersions({
      collection: "catalogs",
      where: { parent: { equals: first.id } },
      req: await reqFor(owner),
      user: owner,
      overrideAccess: false,
    });
    for (const options of [{}, { draft: false }]) {
      await expect(
        payload.update({
          collection: "catalogs",
          id: first.id,
          data: { revision: publishedRevision, title: null },
          ...options,
          req: await reqFor(owner),
          user: owner,
          overrideAccess: false,
          overrideLock: false,
        }),
      ).rejects.toMatchObject({ code: "PUBLICATION_STATE_REQUIRED" });
    }
    await expect(
      payload.update({
        collection: "catalogs",
        id: first.id,
        data: {
          revision: publishedRevision,
          title: null,
          _status: "published",
        },
        req: await reqFor(owner),
        user: owner,
        overrideAccess: false,
        overrideLock: false,
      }),
    ).rejects.toMatchObject({ code: "CONTENT_INVALID" });
    const preserved = await payload.findByID({
      collection: "catalogs",
      id: first.id,
      draft: false,
      req: await reqFor(owner),
      user: owner,
      overrideAccess: false,
    });
    expect(preserved._status).toBe("published");
    expect(preserved.title).toBe(content.title);
    expect(preserved.revision).toBe(published.revision);
    const unchangedVersions = await payload.countVersions({
      collection: "catalogs",
      where: { parent: { equals: first.id } },
      req: await reqFor(owner),
      user: owner,
      overrideAccess: false,
    });
    expect(unchangedVersions.totalDocs).toBe(versionCount.totalDocs);
    const withdrawn = await payload.update({
      collection: "catalogs",
      id: first.id,
      data: { revision: publishedRevision, _status: "draft" },
      draft: false,
      req: await reqFor(owner),
      user: owner,
      overrideAccess: false,
      overrideLock: false,
    });
    expect(withdrawn._status).toBe("draft");
    expect(withdrawn.revision).toBe(publishedRevision + 1);
    const main = await payload.findByID({
      collection: "catalogs",
      id: first.id,
      draft: false,
      req: await reqFor(owner),
      user: owner,
      overrideAccess: false,
    });
    expect(main._status).toBe("draft");
    expect(main.title).toBe(content.title);
    expect(main.revision).toBe(withdrawn.revision);
  });

  it("serializes native Admin/REST writes and automation before checking the latest revision", async () => {
    const content = complete("race");
    const first = await saveDraft(await reqFor(automation), {
      idempotencyKey: `${run}:race-create`,
      content,
    });
    const nativeReq = await reqFor(owner);
    const automationReq = await reqFor(automation);
    const results = await Promise.allSettled([
      payload.update({
        collection: "catalogs",
        id: first.id,
        data: {
          revision: first.revision,
          title: "Synthetic native winner",
          _status: "draft",
        },
        draft: true,
        req: nativeReq,
        user: owner,
        overrideAccess: false,
        overrideLock: false,
      }),
      saveDraft(automationReq, {
        id: first.id,
        expectedRevision: first.revision,
        idempotencyKey: `${run}:race-update`,
        content: { ...content, title: "Synthetic automation winner" },
      }),
    ]);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(
      1,
    );
    const rejected = results.find(
      ({ status }) => status === "rejected",
    ) as PromiseRejectedResult;
    expect(rejected.reason.code).toBe("REVISION_CONFLICT");
    const current = await readDraft(await reqFor(owner), { id: first.id });
    expect(current.revision).toBe(first.revision + 1);
  });

  it("binds Owner batch approval to exact revisions, allows partial success, and rejects forged grants", async () => {
    const records = await Promise.all(
      ["approve-a", "approve-b"].map(async (suffix) =>
        saveDraft(await reqFor(automation), {
          idempotencyKey: `${run}:${suffix}:create`,
          content: complete(suffix),
        }),
      ),
    );
    await expect(
      approveBatch(await reqFor(automation), {
        automationUserId: automation.id,
        items: records.map(({ id, revision }) => ({ id, revision })),
      }),
    ).rejects.toMatchObject({ code: "APPROVAL_OWNER_ONLY" });
    const approval = await approveBatch(await reqFor(owner), {
      automationUserId: automation.id,
      items: records.map(({ id, revision }) => ({ id, revision })),
    });
    await saveDraft(await reqFor(automation), {
      id: records[1]!.id,
      expectedRevision: records[1]!.revision,
      idempotencyKey: `${run}:approval-changed`,
      content: { ...complete("approve-b"), title: "Synthetic after approval" },
    });
    const command = {
      approvalId: approval.approvalId,
      id: records[0]!.id,
      idempotencyKey: `${run}:approved-publish`,
    };
    const success = await publishApproved(await reqFor(automation), command);
    expect(success.revision).toBe(records[0]!.revision + 1);
    expect(
      (await publishApproved(await reqFor(automation), command)).replayed,
    ).toBe(true);
    await expect(
      publishApproved(await reqFor(automation), {
        approvalId: approval.approvalId,
        id: records[1]!.id,
        idempotencyKey: `${run}:stale-approved-publish`,
      }),
    ).rejects.toMatchObject({ code: "APPROVED_REVISION_CHANGED" });
    const forged = await reqFor(automation);
    forged.context = {
      approved: true,
      isApprovedPublishRequest: true,
      ownerApproved: true,
    };
    await expect(
      payload.update({
        collection: "catalogs",
        id: records[1]!.id,
        data: { revision: 2, _status: "published" },
        draft: false,
        req: forged,
        user: automation,
        overrideAccess: false,
      }),
    ).rejects.toMatchObject({ code: "PUBLISH_NOT_APPROVED" });
  });

  it("restores historical content as a new draft without replacing the published version", async () => {
    const content = complete("restore");
    const first = await saveDraft(await reqFor(automation), {
      idempotencyKey: `${run}:restore-create`,
      content,
    });
    const published = await payload.update({
      collection: "catalogs",
      id: first.id,
      data: {
        revision: 1,
        title: "Synthetic published latest",
        _status: "published",
      },
      draft: false,
      req: await reqFor(owner),
      user: owner,
      overrideAccess: false,
    });
    const versions = await payload.findVersions({
      collection: "catalogs",
      where: { parent: { equals: first.id } },
      sort: "createdAt",
      depth: 0,
      req: await reqFor(owner),
      user: owner,
      overrideAccess: false,
    });
    expect(versions.docs.length).toBeGreaterThan(0);
    const versionId = versions.docs[0]!.id;
    // Regression: upstream Local API silently drops draft:true. It must fail
    // closed, never replace the main published snapshot as an implicit restore.
    await expect(
      payload.restoreVersion({
        collection: "catalogs",
        id: String(versionId),
        draft: true,
        req: await reqFor(owner),
        user: owner,
        overrideAccess: false,
      }),
    ).rejects.toMatchObject({ code: "RESTORE_REQUIRES_DRAFT" });
    const restored = await restoreDraft(await reqFor(owner), {
      versionId,
      expectedRevision: published.revision,
    });
    expect(restored.revision).toBe(Number(published.revision) + 1);
    const draft = await readDraft(await reqFor(owner), { id: first.id });
    expect(draft.content.title).toBe(content.title);
    const live = await payload.findByID({
      collection: "catalogs",
      id: first.id,
      draft: false,
      req: await reqFor(owner),
      user: owner,
      overrideAccess: false,
    });
    expect(live.title).toBe("Synthetic published latest");
    expect(live.revision).toBe(published.revision);
    await expect(
      restoreDraft(await reqFor(automation), {
        versionId,
        expectedRevision: restored.revision,
      }),
    ).rejects.toMatchObject({ code: "RESTORE_OWNER_ONLY" });
  });

  it("clears non-VALUE text and removed optional scalars in approved and native published snapshots", async () => {
    const first = await saveDraft(await reqFor(automation), {
      idempotencyKey: `${run}:clear-create`,
      content: {
        ...complete("clear"),
        description: {
          state: "VALUE",
          value: "Synthetic original description",
        },
      },
    });
    const firstPublished = await payload.update({
      collection: "catalogs",
      id: first.id,
      data: { revision: first.revision, _status: "published" },
      req: await reqFor(owner),
      user: owner,
      overrideAccess: false,
      overrideLock: false,
    });
    const clearedDraft = await payload.update({
      collection: "catalogs",
      id: first.id,
      draft: true,
      data: {
        revision: Number(firstPublished.revision),
        transcription: { state: "CLEAR" },
        summary: null,
      },
      req: await reqFor(owner),
      user: owner,
      overrideAccess: false,
      overrideLock: false,
    });
    const draft = await readDraft(await reqFor(owner), { id: first.id });
    expect(draft.content.transcription).toEqual({ state: "CLEAR" });
    expect(draft.content.summary).toBeUndefined();
    const grant = await approveBatch(await reqFor(owner), {
      automationUserId: automation.id,
      items: [{ id: first.id, revision: clearedDraft.revision }],
    });
    const approved = await publishApproved(await reqFor(automation), {
      approvalId: grant.approvalId,
      id: first.id,
      idempotencyKey: `${run}:clear-approved`,
    });
    const live = await payload.findByID({
      collection: "catalogs",
      id: first.id,
      draft: false,
      req: await reqFor(owner),
      user: owner,
      overrideAccess: false,
    });
    expect(live.transcription.state).toBe("CLEAR");
    expect(live.transcription.value).toBeNull();
    expect(live.summary).toBeNull();
    const native = await payload.update({
      collection: "catalogs",
      id: first.id,
      data: {
        revision: approved.revision,
        _status: "published",
        description: { state: "CLEAR" },
      },
      req: await reqFor(owner),
      user: owner,
      overrideAccess: false,
      overrideLock: false,
    });
    expect(native.description.state).toBe("CLEAR");
    expect(native.description.value).toBeNull();
  });

  it("permanently binds provenance identities across concurrent records and later removal", async () => {
    const secondarySource = `source-${run}-shared-secondary`;
    const contents = ["ownership-a", "ownership-b"].map((suffix) => ({
      ...complete(suffix),
      provenance: [{ sourceId: secondarySource }],
    }));
    const attempts = await Promise.allSettled(
      contents.map(async (content, index) =>
        saveDraft(await reqFor(automation), {
          idempotencyKey: `${run}:identity-race:${index}`,
          content,
        }),
      ),
    );
    expect(
      attempts.filter(({ status }) => status === "fulfilled"),
    ).toHaveLength(1);
    const winnerIndex = attempts.findIndex(
      ({ status }) => status === "fulfilled",
    );
    const loserIndex = winnerIndex === 0 ? 1 : 0;
    const winner = attempts[winnerIndex] as PromiseFulfilledResult<
      Awaited<ReturnType<typeof saveDraft>>
    >;
    const loser = attempts[loserIndex] as PromiseRejectedResult;
    expect(loser.reason.code).toBe("IDENTITY_ALREADY_BOUND");
    await saveDraft(await reqFor(automation), {
      id: winner.value.id,
      expectedRevision: winner.value.revision,
      idempotencyKey: `${run}:identity-remove`,
      content: { ...contents[winnerIndex], provenance: [] },
    });
    await expect(
      saveDraft(await reqFor(automation), {
        idempotencyKey: `${run}:identity-reassign`,
        content: contents[loserIndex],
      }),
    ).rejects.toMatchObject({ code: "IDENTITY_ALREADY_BOUND" });
    await expect(
      saveDraft(await reqFor(owner), {
        idempotencyKey: `${run}:identity-namespace`,
        content: { ...complete("outside"), catalogId: secondarySource },
      }),
    ).rejects.toMatchObject({ code: "IDENTITY_ALREADY_BOUND" });
    await expect(
      payload.create({
        collection: "editorial-identities",
        overrideAccess: false,
        req: await reqFor(owner),
        user: owner,
        data: {
          identityValue: `source-${run}-forged`,
          kind: "source",
          catalogId: catalogId("outside"),
        },
      }),
    ).rejects.toMatchObject({ code: "IDENTITY_SERVER_ONLY" });
  });

  it("provides safe Owner review summaries and denies automation access to approval preparation", async () => {
    const page = await ownerDraftPage(await reqFor(owner), {
      page: 1,
      pageSize: 50,
    });
    expect(page.docs.length).toBeGreaterThan(0);
    expect(page.automationUsers.some(({ id }) => id === automation.id)).toBe(
      true,
    );
    const ownDraft = page.docs.find(
      ({ catalogId: id }) => id === catalogId("draft"),
    );
    expect(ownDraft?.missingFields).toContain("title");
    expect(ownDraft?.changedFields).toContain("catalogId");
    for (const row of page.docs) {
      expect(Object.keys(row).sort()).toEqual([
        "catalogId",
        "changedFields",
        "id",
        "missingFields",
        "revision",
        "status",
        "title",
      ]);
    }
    const history = await ownerHistoryPage(await reqFor(owner), {
      id: ownDraft!.id,
    });
    expect(history.currentRevision).toBe(ownDraft!.revision);
    expect(history.docs.length).toBeGreaterThan(0);
    expect(Object.keys(history.docs[0]!).sort()).toEqual([
      "createdAt",
      "id",
      "revision",
      "status",
      "title",
    ]);
    for (const user of [automation, null]) {
      await expect(
        ownerDraftPage(await reqFor(user), {}),
      ).rejects.toMatchObject({ code: "OWNER_WORKFLOW_ONLY" });
      await expect(
        ownerHistoryPage(await reqFor(user), { id: ownDraft!.id }),
      ).rejects.toMatchObject({ code: "OWNER_WORKFLOW_ONLY" });
    }
  });

  it("enforces explicit native account-unlock permissions while preserving locked account state", async () => {
    // Only synthetic lock counters are set directly to exercise the real native
    // unlock operation without emitting or brute-forcing any authentication data.
    // Generated unlock typings require a password property; the actual official
    // unlock operation never reads it. Unrelated in-memory synthetic values below
    // satisfy the generated transport type and are not account credentials.
    await payload.db.updateOne({
      collection: "users",
      id: owner.id,
      data: {
        loginAttempts: 5,
        lockUntil: new Date(Date.now() + 600_000).toISOString(),
      },
      req: await reqFor(owner),
    });
    for (const user of [owner, automation, null]) {
      await expect(
        payload.unlock({
          collection: "users",
          overrideAccess: false,
          req: await reqFor(user),
          data: {
            email: `synthetic-owner-${run}@example.invalid`,
            password: randomUUID(),
          },
        }),
      ).rejects.toMatchObject({ status: 403 });
    }
    const stillLocked = await payload.findByID({
      collection: "users",
      id: owner.id,
      showHiddenFields: true,
      req: await reqFor(owner),
      user: owner,
      overrideAccess: false,
    });
    expect(stillLocked?.loginAttempts).toBe(5);
    await expect(
      payload.unlock({
        collection: "users",
        overrideAccess: false,
        req: await browserReqFor(owner),
        data: {
          email: `synthetic-owner-${run}@example.invalid`,
          password: randomUUID(),
        },
      }),
    ).resolves.toBe(true);
    const unlocked = await payload.findByID({
      collection: "users",
      id: owner.id,
      showHiddenFields: true,
      req: await reqFor(owner),
      user: owner,
      overrideAccess: false,
    });
    expect(unlocked?.loginAttempts).toBe(0);
    for (const user of [owner, automation, null]) {
      await expect(
        payload.unlock({
          collection: "payload-mcp-api-keys",
          overrideAccess: false,
          req: await reqFor(user),
          data: {
            email: `synthetic-no-key-${run}@example.invalid`,
            password: randomUUID(),
          },
        }),
      ).rejects.toMatchObject({ status: 403 });
    }
  });

  it("denies anonymous content/version reads, out-of-scope create and hard delete", async () => {
    await expect(
      payload.find({
        collection: "catalogs",
        req: await reqFor(null),
        overrideAccess: false,
      }),
    ).rejects.toBeDefined();
    await expect(
      payload.findVersions({
        collection: "catalogs",
        req: await reqFor(null),
        overrideAccess: false,
      }),
    ).rejects.toBeDefined();
    await expect(
      saveDraft(await reqFor(automation), {
        idempotencyKey: `${run}:scope-denied`,
        content: complete("outside"),
      }),
    ).rejects.toMatchObject({ code: "CATALOG_OUT_OF_SCOPE" });
    await expect(
      payload.delete({
        collection: "catalogs",
        id: 999999,
        req: await reqFor(owner),
        user: owner,
        overrideAccess: false,
      }),
    ).rejects.toMatchObject({ code: "HARD_DELETE_DISABLED" });
  });
});
