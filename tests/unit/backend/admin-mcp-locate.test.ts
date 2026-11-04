import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  ADMIN_CATALOG_MISSING_FIELDS,
  ADMIN_CMS_RECORD_TYPES,
  ADMIN_FIND_SKIP_MAX,
  ADMIN_MCP_TOKEN_BUDGET,
  adminFindInputSchema,
  adminGetInputSchema,
  adminReadInputSchema,
  type AdminCmsRecordType,
} from "@moya/contracts/internal/admin-mcp";
import {
  EDITORIAL_FIELD_NAMES,
  EDITORIAL_STATEFUL_FIELDS,
  ownerDraftPageRequestSchema,
} from "@moya/contracts/internal/editorial";
import { normalizeSearchText } from "@moya/search";
import { describe, expect, it, vi } from "vitest";

import {
  actionsFor,
  adminOpMeta,
  candidateActions,
  classifyQuery,
  CMS_FAMILIES,
  findContinuation,
  findInText,
  linkCarriesCredential,
  LINK_PARAMETER_EXCLUSIONS,
  LINK_PARAMETER_RULES,
  normalizeSearchQuery,
  readContinuation,
  textHash,
  textWindow,
  toolListingFor,
  WINDOW_BYTES,
} from "admin/admin-mcp";

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
const hex32 = (digit: string) => digit.repeat(32);

describe("the link classifier follows the Web's own links", () => {
  const historySource = () =>
    readFile(
      path.join(
        repositoryRoot,
        "apps/web/features/product-shell/product-history.ts",
      ),
      "utf8",
    );

  /** Every query parameter the Web reads or writes, in each form it uses them. */
  const parameterNames = (source: string): Set<string> => {
    const names = new Set<string>();
    for (const [, name] of source.matchAll(
      /\b(?:p|parameters|searchParams)\.(?:get|getAll|has|set|delete)\(\s*"(\w+)"/gu,
    ))
      names.add(name!);
    for (const [, name] of source.matchAll(
      /directIdentifierFromLocation\(\s*location,\s*"(\w+)"/gu,
    ))
      names.add(name!);
    for (const [, list] of source.matchAll(
      /for \(const key of \[([^\]]+)\]\)\s*parameters\.delete\(key\)/gu,
    ))
      for (const [, name] of list!.matchAll(/"(\w+)"/gu)) names.add(name!);
    return names;
  };

  const covered = (name: string) =>
    Object.hasOwn(LINK_PARAMETER_RULES, name) ||
    Object.hasOwn(LINK_PARAMETER_EXCLUSIONS, name);

  it("has a rule or a stated exclusion for each parameter product-history.ts names", async () => {
    const names = parameterNames(await historySource());
    // What the file names today, so the reader above cannot go quiet on its own.
    expect([...names].sort()).toEqual(
      expect.arrayContaining([
        "articleId",
        "authorId",
        "catalogId",
        "draftId",
        "image",
        "workId",
      ]),
    );
    expect([...names].filter((name) => !covered(name))).toEqual([]);
  });

  it("fails on a parameter the Web starts using with no rule", async () => {
    const names = parameterNames(
      `${await historySource()}\nparameters.get("reviewId");\n`,
    );
    expect([...names].filter((name) => !covered(name))).toEqual(["reviewId"]);
  });

  it("keeps a private draft's id out of every search", () => {
    expect(LINK_PARAMETER_EXCLUSIONS.draftId).toBe("private_draft");
    expect(LINK_PARAMETER_RULES).not.toHaveProperty("draftId");
  });
});

describe("classifying a reference, with no I/O", () => {
  it.each([
    [`user-${hex32("a")}`, "user"],
    [`work-${hex32("a")}`, "work"],
    [`comment-${hex32("a")}`, "comment"],
    [`thread-${hex32("a")}`, "thread"],
    [`feedback-${hex32("a")}`, "feedback"],
    [`report-${hex32("a")}`, "report"],
    [`publishing-job-${hex32("a")}`, "publishing_job"],
    [`work-revision-${hex32("a")}`, "work_revision"],
    [`media-item-${hex32("a")}`, "media_item"],
    [`invitation-${hex32("a")}`, "invitation"],
  ])("reads %s as a community %s", (query, type) => {
    expect(classifyQuery(query).references).toEqual([
      { kind: "community", type, value: query },
    ]);
  });

  it("reads the CMS's own id shapes as identities on one family", () => {
    expect(classifyQuery(`article-${hex32("a")}`).references[0]).toMatchObject({
      kind: "identity",
      type: "article",
      field: "articleId",
    });
    expect(
      classifyQuery(`collection-${hex32("a")}`).references[0],
    ).toMatchObject({
      kind: "identity",
      type: "collection",
      field: "collectionId",
    });
    expect(classifyQuery("media-abc.1").references[0]).toMatchObject({
      kind: "identity",
      type: "media",
    });
    // A media item is the community's, and its prefix must not read as media.
    expect(
      classifyQuery(`media-item-${hex32("a")}`).references[0],
    ).toMatchObject({ kind: "community" });
  });

  it("reads digits, a uuid, a sha256, a handle, a token and text apart", () => {
    expect(classifyQuery("42").references[0]).toEqual({
      kind: "digits",
      value: "42",
      id: 42,
    });
    // Media stores these in lower case; a catalogId or sourceId is exact as typed.
    expect(
      classifyQuery("A1B2C3D4-0000-4000-8000-000000000001").references[0],
    ).toEqual({
      kind: "uuid",
      value: "a1b2c3d4-0000-4000-8000-000000000001",
      typed: "A1B2C3D4-0000-4000-8000-000000000001",
    });
    expect(classifyQuery("A".repeat(64)).references[0]).toEqual({
      kind: "sha256",
      value: "a".repeat(64),
      typed: "A".repeat(64),
    });
    expect(classifyQuery("@lishu_test").references[0]).toEqual({
      kind: "handle",
      handle: "lishu_test",
    });
    expect(classifyQuery("taishan-001").references[0]).toEqual({
      kind: "token",
      value: "taishan-001",
    });
    expect(classifyQuery("兰亭 集序").references[0]).toEqual({
      kind: "text",
      text: "兰亭 集序",
    });
    expect(classifyQuery("x".repeat(129)).references[0]).toMatchObject({
      kind: "text",
    });
  });

  it("takes path and query only: a link means the same on any host", () => {
    const paths = [
      "/catalog/abc",
      "https://artvenn.example/catalog/abc",
      "http://127.0.0.1:3000/catalog/abc?x=1#detail",
      // As copied from an address bar, with no scheme.
      "artvenn.example/catalog/abc",
      "www.artvenn.example:8443/catalog/abc?x=1",
      "localhost:3000/catalog/abc",
      "127.0.0.1:3000/?catalogId=abc",
      // Extra parts after what the link names.
      "/catalog/abc/media/2",
      "/catalog/abc/",
    ];
    for (const link of paths)
      expect(classifyQuery(link)).toMatchObject({
        link: true,
        references: [
          {
            kind: "identity",
            type: "catalog",
            field: "catalogId",
            value: "abc",
          },
        ],
      });
  });

  it("decodes a percent-encoded id, and leaves a broken one unread", () => {
    expect(
      classifyQuery(`/catalog/${encodeURIComponent("碑-1")}`).references[0],
    ).toMatchObject({ value: "碑-1" });
    expect(classifyQuery("/catalog/%E0%A4%A")).toMatchObject({
      link: true,
      references: [],
    });
  });

  it("never lets a NUL out of a link: no record can hold one", () => {
    for (const link of [
      "/catalog/%00",
      "/catalog/a%00b",
      "/?catalogId=a%00b",
      "/?articleId=a%00b",
      "/#topic-a%00b",
    ])
      expect({ query: link, ...classifyQuery(link) }).toMatchObject({
        query: link,
        link: true,
        references: [],
      });
  });

  it("reads Admin paths as row ids, only on the families it can read", () => {
    expect(
      classifyQuery("/admin/collections/catalogs/7").references[0],
    ).toEqual({ kind: "row", type: "catalog", id: 7 });
    expect(
      classifyQuery("https://a.example/admin/collections/article-collections/9")
        .references[0],
    ).toEqual({ kind: "row", type: "collection", id: 9 });
    expect(classifyQuery("/admin/collections/users/7").references).toEqual([]);
    expect(
      classifyQuery("/admin/collections/catalogs/create").references,
    ).toEqual([]);
    // Extra parts after the row, such as a version of it.
    expect(
      classifyQuery("/admin/collections/catalogs/7/versions/3").references,
    ).toEqual([{ kind: "row", type: "catalog", id: 7 }]);
  });

  it("reads the path a preview answer gives, on the Catalog's row id", () => {
    for (const link of [
      "/editorial-preview/7",
      "https://any.example/editorial-preview/7/",
      "any.example/editorial-preview/7",
    ])
      expect(classifyQuery(link)).toMatchObject({
        link: true,
        references: [{ kind: "row", type: "catalog", id: 7 }],
      });
    expect(classifyQuery("/editorial-preview/draft")).toMatchObject({
      link: true,
      references: [],
    });
  });

  it("keeps a real link from ever becoming a text search", () => {
    for (const link of [
      "https://artvenn.example/about",
      "http://artvenn.example/?page=2",
      "?page=2",
      "/admin",
      "/admin/collections/users/7",
      "/?catalogId=",
    ])
      expect(classifyQuery(link)).toMatchObject({
        link: true,
        references: [],
      });
  });

  it("carries a known link's text only where a record could hold it as typed", () => {
    for (const text of [
      "any.example/catalog/abc",
      "localhost:3000/?catalogId=abc",
      "lib.example/x?image=5",
    ])
      expect(classifyQuery(text)).toMatchObject({ link: true, literal: text });
    for (const text of [
      "/catalog/abc",
      "/?catalogId=abc",
      "#topic-abc",
      "https://any.example/catalog/abc",
      `any.example/catalog/${"a".repeat(128)}`,
    ]) {
      expect(classifyQuery(text).link).toBe(true);
      expect(classifyQuery(text).literal).toBeUndefined();
    }
  });

  it("lets text that only looks like a link go on to identity and search", () => {
    for (const text of [
      "/about",
      "/source/甲",
      "/?page=2",
      "#拓本",
      "#detail",
      "/",
      "abc.def/ghi",
      "artvenn.example/about",
    ])
      expect(classifyQuery(text)).toEqual({
        references: [{ kind: "token", value: text }],
        excluded: [],
        link: false,
      });
    // No host, no path after it: a dotted id stays one.
    expect(classifyQuery("artvenn.example").references[0]).toEqual({
      kind: "token",
      value: "artvenn.example",
    });
    expect(classifyQuery("/甲 乙")).toMatchObject({
      link: false,
      references: [{ kind: "text", text: "/甲 乙" }],
    });
  });

  it("counts a value named twice once, and two values as two", () => {
    for (const link of [
      "/catalog/a?catalogId=a",
      "/?catalogId=a&catalogId=a",
      "https://any.example/catalog/a?catalogId=a#detail-a",
    ])
      expect(classifyQuery(link).references).toEqual([
        { kind: "identity", type: "catalog", field: "catalogId", value: "a" },
      ]);
    expect(classifyQuery("/?topic=t1#topic-t1").references).toEqual([
      { kind: "community", type: "thread", value: "t1" },
    ]);
    expect(classifyQuery("/catalog/a?catalogId=b").references).toHaveLength(2);
  });

  it("reads a name every object inherits as no rule at all", () => {
    for (const link of [
      "https://any.example/?constructor=1",
      "https://any.example/?__proto__=1",
      "https://any.example/?toString=1&hasOwnProperty=1",
      "/admin/collections/constructor/7",
      "/admin/collections/__proto__/7",
    ])
      expect(classifyQuery(link)).toEqual({
        references: [],
        excluded: [],
        link: true,
      });
  });

  it("reads every reference a link carries, so none is dropped silently", () => {
    expect(
      classifyQuery(`/?catalogId=a&workId=work-${hex32("b")}`).references,
    ).toHaveLength(2);
    expect(classifyQuery("/?catalogId=a&catalogId=b").references).toHaveLength(
      2,
    );
  });

  it("holds the image of a viewer link beside its record, or alone", () => {
    const viewer = classifyQuery("/?catalogId=a&image=media-b#viewer");
    expect(viewer.focusMediaId).toBe("media-b");
    expect(viewer.references).toHaveLength(1);
    expect(viewer.references[0]).toMatchObject({ value: "a" });
    expect(classifyQuery("/?image=media-b").references[0]).toMatchObject({
      type: "media",
      value: "media-b",
    });
  });

  it("reads a topic link by its query or its hash", () => {
    expect(classifyQuery("/?topic=t1").references[0]).toMatchObject({
      type: "thread",
      value: "t1",
    });
    expect(classifyQuery("/#topic-t1").references[0]).toMatchObject({
      type: "thread",
      value: "t1",
    });
  });

  it("never searches direct messages, in any shape", () => {
    for (const query of [
      `dm-${hex32("a")}`,
      `DM-${hex32("a")}`,
      `dmsg-${hex32("a")}`,
      `/?workId=dm-${hex32("a")}`,
    ]) {
      const { references, excluded } = classifyQuery(query);
      expect({ query, references, excluded }).toEqual({
        query,
        references: [],
        excluded: ["dm"],
      });
    }
  });

  it("never searches a private draft, as a parameter or as a bare id", () => {
    for (const query of [
      `/?draftId=work-draft-${hex32("a")}`,
      `work-draft-${hex32("a")}`,
      `/?workId=work-draft-${hex32("a")}`,
    ])
      expect(classifyQuery(query)).toMatchObject({
        references: [],
        excluded: ["private_draft"],
      });
  });
});

describe("text windows", () => {
  const pair = "𠮷";

  it("never splits a surrogate pair, at any offset or width", () => {
    const text = `${pair}a${pair}${pair}b`;
    const points = Array.from(text);
    for (let offset = 0; offset <= points.length; offset += 1)
      for (let maxChars = 1; maxChars <= points.length; maxChars += 1) {
        const window = textWindow(text, offset, maxChars);
        expect(window.text).toBe(
          points.slice(offset, offset + maxChars).join(""),
        );
        expect(/\p{Cs}/u.test(window.text)).toBe(false);
        expect(window.totalLength).toBe(points.length);
      }
  });

  it("walks a text to its end, whole, under the byte bound", () => {
    const text = `${pair.repeat(2_000)}${"中".repeat(2_000)}${'"\\\n'.repeat(2_000)}`;
    const pieces: string[] = [];
    let offset: number | undefined = 0;
    while (offset !== undefined) {
      const window = textWindow(text, offset);
      expect(
        Buffer.byteLength(JSON.stringify(window.text)),
      ).toBeLessThanOrEqual(WINDOW_BYTES + 2);
      pieces.push(window.text);
      offset = window.nextOffset;
    }
    expect(pieces.join("")).toBe(text);
    expect(pieces.length).toBeGreaterThan(1);
  });

  it("reports no next offset at or past the end", () => {
    expect(textWindow("abc", 3)).toEqual({ text: "", totalLength: 3 });
    expect(textWindow("abc", 9)).toEqual({ text: "", totalLength: 3 });
  });

  it("offsets a match in code points, never in UTF-16 units", () => {
    const { matches, count } = findInText(
      `${pair}${pair}目标`,
      "目标",
      "raw",
      1,
    );
    expect(count).toBe(1);
    expect(matches[0]).toEqual({
      offset: 2,
      length: 2,
      before: pair,
      match: "目标",
      after: "",
    });
  });

  it("counts overlaps, so one match really is one place", () => {
    expect(findInText("aaa", "aa", "raw", 0).count).toBe(2);
  });

  it("does not match a needle that starts inside a character", () => {
    expect(findInText(pair, pair.slice(1), "raw", 0).count).toBe(0);
  });

  it("matches raw exactly, and normalized only on request", () => {
    expect(findInText("蘭亭", "兰亭", "raw", 0).count).toBe(0);
    const { matches } = findInText("序蘭亭", "兰亭", "normalized", 1);
    expect(matches[0]).toMatchObject({
      offset: 1,
      match: "蘭亭",
      before: "序",
    });
  });

  it("keeps normalized offsets true across a supplementary-plane character", () => {
    const { matches } = findInText(`${pair}蘭亭`, "蘭亭", "normalized", 0);
    expect(matches[0]?.offset).toBe(1);
  });

  it("caps matches per call, and says there are more", () => {
    const text = "碑".repeat(120);
    const first = findInText(text, "碑", "raw", 0);
    expect(first.count).toBe(120);
    expect(first.matches).toHaveLength(50);
    expect(first.more).toBe(true);
    expect(findInText(text, "碑", "raw", 0, 100).more).toBe(false);
  });

  it("normalizes a query as the search documents were built", () => {
    for (const text of ["蘭亭集序", "泰山經石峪", "乾隆御筆", "Mount Tai"])
      expect(normalizeSearchQuery(text)).toBe(normalizeSearchText(text));
  });

  it("hashes the stored text", () => {
    expect(textHash("碑")).toMatch(/^[0-9a-f]{64}$/u);
    expect(textHash("碑")).not.toBe(textHash("碑 "));
  });
});

describe("the field lists", () => {
  const collectFieldNames = (fields: readonly unknown[]): string[] =>
    fields.flatMap((field) => {
      const row = field as {
        name?: string;
        fields?: readonly unknown[];
        tabs?: readonly { fields: readonly unknown[] }[];
      };
      return [
        ...(row.name === undefined ? [] : [row.name]),
        ...(row.fields === undefined || row.name !== undefined
          ? []
          : collectFieldNames(row.fields)),
        ...(row.tabs ?? []).flatMap((tab) => collectFieldNames(tab.fields)),
      ];
    });

  it("reads every field of the Catalog write contract, so none goes unseen", () => {
    expect(CMS_FAMILIES.catalog.fields.map(({ name }) => name).sort()).toEqual(
      [...EDITORIAL_FIELD_NAMES].sort(),
    );
  });

  it("offers `missing` on every stateful field", () => {
    for (const field of EDITORIAL_STATEFUL_FIELDS)
      expect(ADMIN_CATALOG_MISSING_FIELDS).toContain(field);
  });

  it.each([
    ["article", "articles"],
    ["collection", "article-collections"],
  ] as const)(
    "reads every field of the %s collection but its bookkeeping",
    async (type, slug) => {
      const directory = await mkdtemp(path.join(tmpdir(), "admin-mcp-locate-"));
      vi.stubEnv("CMS_SECRET", "synthetic-config-load-secret");
      vi.stubEnv(
        "CMS_DATABASE_URL",
        "postgresql://synthetic@127.0.0.1:1/synthetic",
      );
      vi.stubEnv("CMS_ENVIRONMENT", "synthetic");
      vi.stubEnv("CMS_STORAGE_MODE", "local");
      vi.stubEnv("CMS_MEDIA_DIR", directory);
      const resolved = await (await import("admin/config")).default;
      vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
      const collection = resolved.collections.find(
        (candidate) => candidate.slug === slug,
      )!;
      const known = CMS_FAMILIES[type].fields.map(({ name }) => name);
      const bookkeeping = new Set([
        "lastEditedBy",
        "revision",
        "_status",
        "createdAt",
        "updatedAt",
      ]);
      const declared = collectFieldNames(collection.fields).filter(
        (name) => !bookkeeping.has(name),
      );
      expect(known.sort()).toEqual([...new Set(declared)].sort());
    },
    60_000,
  );

  it("gives each family a slug, an identity and a path of its own", () => {
    expect(
      new Set(ADMIN_CMS_RECORD_TYPES.map((type) => CMS_FAMILIES[type].slug))
        .size,
    ).toBe(4);
  });

  it("names the media family's facts without its object key", () => {
    expect(CMS_FAMILIES.media.fields.map(({ name }) => name)).not.toContain(
      "objectKey",
    );
    expect(CMS_FAMILIES.media.findSelect).not.toHaveProperty("objectKey");
  });
});

describe("op skeletons", () => {
  const scope = {
    tools: ["admin_get", "admin_read", "admin_view_media", "admin_execute"],
    switches: {},
  };
  const catalogFacts = {
    type: "catalog" as const,
    id: 7,
    state: "draft" as const,
    revision: 4,
    fingerprint: "a".repeat(64),
    catalogId: "synthetic-catalog",
  };

  /** Pretends a slice built these ops, for one call, on the real registry. */
  const withBuilt = <T>(
    names: readonly (keyof typeof adminOpMeta)[],
    work: () => T,
  ): T => {
    const rows = names.map((name) => adminOpMeta[name] as { run?: unknown });
    for (const row of rows) row.run = () => undefined;
    try {
      return work();
    } finally {
      for (const row of rows) delete row.run;
    }
  };

  it("offers a read a key can call today, and no op that nothing has built", () => {
    const actions = actionsFor(catalogFacts, scope);
    expect(actions.map(({ tool }) => tool)).toEqual([
      "admin_get",
      "admin_read",
    ]);
    expect(actions[1]!.args).toEqual({
      op: "list.media",
      input: { filter: { catalogId: "synthetic-catalog" } },
    });
  });

  it("offers a mutation on an exact record the moment its op exists, prefilled", () => {
    const actions = withBuilt(["catalog.patch_text", "catalog.publish"], () =>
      actionsFor(catalogFacts, scope),
    );
    const byOp = new Map(
      actions.flatMap(({ args }) =>
        typeof args.op === "string" ? [[args.op, args.input]] : [],
      ),
    );
    expect(byOp.get("catalog.patch_text")).toMatchObject({
      catalogId: 7,
      expected: { revision: 4, fingerprint: "a".repeat(64) },
    });
    expect(byOp.get("catalog.publish")).toMatchObject({
      id: 7,
      expected: { revision: 4 },
    });
    expect(byOp.has("catalog.withdraw")).toBe(false);
  });

  it("offers publish or withdraw by the record's state", () => {
    const ops = (state: "draft" | "published" | "draft_over_published") =>
      withBuilt(["catalog.publish", "catalog.withdraw"], () =>
        actionsFor({ ...catalogFacts, state }, scope),
      )
        .map(({ args }) => args.op)
        .filter(Boolean);
    expect(ops("published")).toEqual(["list.media", "catalog.withdraw"]);
    expect(ops("draft")).toEqual(["list.media", "catalog.publish"]);
    expect(ops("draft_over_published")).toEqual([
      "list.media",
      "catalog.publish",
      "catalog.withdraw",
    ]);
  });

  it("offers a lock takeover only on a locked document", () => {
    const ops = (locked: boolean) =>
      withBuilt(["document.lock_takeover"], () =>
        actionsFor({ ...catalogFacts, locked }, scope),
      ).map(({ args }) => args.op);
    expect(ops(false)).not.toContain("document.lock_takeover");
    expect(ops(true)).toContain("document.lock_takeover");
  });

  it("offers nothing on a tool this key does not hold", () => {
    expect(
      withBuilt(["catalog.publish"], () =>
        actionsFor(catalogFacts, { tools: ["admin_get"], switches: {} }),
      ).map(({ tool }) => tool),
    ).toEqual(["admin_get"]);
  });

  it.each(ADMIN_CMS_RECORD_TYPES)(
    "gives a %s candidate exactly one admin_get, built or not",
    (type: AdminCmsRecordType) => {
      const built = withBuilt(
        ["catalog.publish", "article.publish", "media.update_metadata"],
        () => candidateActions(type, 7),
      );
      expect(built).toEqual([{ tool: "admin_get", args: { type, id: 7 } }]);
    },
  );
});

describe("a read cut at the size cap", () => {
  const rows = (count: number) =>
    Array.from({ length: count }, (_, index) => ({ id: index + 1 }));

  it("goes on by the last row, or a count's offset, on a list source", () => {
    expect(readContinuation({ op: "list.catalogs" }, rows(3))).toEqual({
      tool: "admin_read",
      args: { op: "list.catalogs", cursor: "3" },
    });
    expect(
      readContinuation({ op: "list.catalogs", view: "count", cursor: "200" }, [
        { count: 1 },
        { count: 1 },
        { count: 1 },
      ]),
    ).toEqual({
      tool: "admin_read",
      args: { op: "list.catalogs", view: "count", cursor: "203" },
    });
  });

  it.each([
    [{}, 7, { page: 2, pageSize: 7 }],
    [{ page: 1, pageSize: 50 }, 31, { page: 2, pageSize: 31 }],
    [{ page: 2, pageSize: 7 }, 5, { page: 2, pageSize: 12 }],
    [{ page: 3, pageSize: 50 }, 1, { page: 102, pageSize: 1 }],
    [{ page: 2, pageSize: 50 }, 49, { page: 4, pageSize: 33 }],
    // The size grows back to the default page once the offset allows it.
    [{ page: 20, pageSize: 1 }, 1, { page: 2, pageSize: 20 }],
  ])(
    "starts a numbered page right after %j and %i rows",
    (input, kept, want) => {
      const next = readContinuation(
        { op: "list.review_page", input },
        rows(kept),
      );
      expect(next?.args.input).toEqual(want);
      const page = (input as { page?: number }).page ?? 1;
      const pageSize = (input as { pageSize?: number }).pageSize ?? 20;
      expect((want.page - 1) * want.pageSize).toBe(
        (page - 1) * pageSize + kept,
      );
      expect(want.pageSize).toBeLessThanOrEqual(Math.max(kept, 20));
      expect(
        ownerDraftPageRequestSchema.safeParse(next?.args.input).success,
      ).toBe(true);
    },
  );

  it("has no way on where the op takes no page", () => {
    expect(
      readContinuation(
        { op: "editorial.owner-history", input: { id: 7, page: 1 } },
        rows(3),
      ),
    ).toBeUndefined();
    expect(
      readContinuation(
        { op: "editorial.read-draft", input: { id: 7 } },
        rows(3),
      ),
    ).toBeUndefined();
    expect(readContinuation({ op: "list.catalogs" }, [])).toBeUndefined();
    expect(readContinuation({ op: "no.such_op" }, rows(3))).toBeUndefined();
  });
});

describe("a search cut at the size cap", () => {
  it("goes on after what it kept, only ever to a call the tool accepts", () => {
    const kept = [{}, {}];
    const next = findContinuation({ query: "词", skip: 4 }, kept);
    expect(next).toEqual({
      tool: "admin_find",
      args: { query: "词", skip: 6 },
    });
    expect(adminFindInputSchema.safeParse(next!.args).success).toBe(true);
    const atTheEdge = findContinuation(
      { query: "词", skip: ADMIN_FIND_SKIP_MAX - 2 },
      kept,
    );
    expect(adminFindInputSchema.safeParse(atTheEdge!.args).success).toBe(true);
    expect(
      findContinuation({ query: "词", skip: ADMIN_FIND_SKIP_MAX - 1 }, kept),
    ).toBeUndefined();
    expect(findContinuation({ query: "词" }, [])).toBeUndefined();
  });
});

describe("what tools/list advertises", () => {
  it("lists find, get, read and view_media on every profile, in the contract's order", () => {
    for (const profile of ["read", "operate", "full"] as const)
      expect(toolListingFor(profile, false).map(({ name }) => name)).toEqual([
        "admin_whoami",
        "admin_find",
        "admin_get",
        "admin_read",
        "admin_analytics",
        "admin_actions",
        "admin_view_media",
      ]);
  });

  it("publishes no outputSchema on admin_view_media, and one on every other tool", () => {
    for (const listing of toolListingFor("read", false))
      expect({
        name: listing.name,
        schema: "outputSchema" in listing,
      }).toEqual({
        name: listing.name,
        schema: listing.name !== "admin_view_media",
      });
  });

  it("stays within its token budget", () => {
    for (const profile of ["read", "operate", "full"] as const) {
      const bytes = Buffer.byteLength(
        JSON.stringify(toolListingFor(profile, false)),
      );
      expect(bytes / 3).toBeLessThanOrEqual(ADMIN_MCP_TOKEN_BUDGET);
    }
  });

  it("names only read ops on admin_read, and refuses none at the door", () => {
    const listing = toolListingFor("read", false).find(
      ({ name }) => name === "admin_read",
    )!;
    const properties = listing.inputSchema.properties as Record<
      string,
      { enum?: string[] }
    >;
    const names = properties.op!.enum!;
    for (const name of names)
      expect(adminOpMeta[name as keyof typeof adminOpMeta].tool).toBe(
        "admin_read",
      );
    // The runtime check is wider, so a wrong name gets near names, not a bare refusal.
    expect(adminReadInputSchema.safeParse({ op: "list.catalog" }).success).toBe(
      true,
    );
  });

  it("refuses a field a tool does not take", () => {
    expect(
      adminFindInputSchema.safeParse({ query: "x", nope: 1 }).success,
    ).toBe(false);
    expect(
      adminGetInputSchema.safeParse({ type: "catalog", id: 1, nope: 1 })
        .success,
    ).toBe(false);
    expect(adminGetInputSchema.safeParse({ type: "dm", id: 1 }).success).toBe(
      false,
    );
  });
});

describe("a stored link that carries a credential", () => {
  const value = "0123456789abcdef";

  it.each([
    "token",
    "access_token",
    "accessToken",
    "AccessToken",
    "refresh-token",
    "TOKEN",
    "access%5Ftoken",
    "api_key",
    "apiKey",
    "APIKey",
    "apikey",
    "key",
    "x-api-key",
    "AWSAccessKeyId",
    "OSSAccessKeyId",
    "password",
    "passwd",
    "pwd",
    "secret",
    "client_secret",
    "sig",
    "sign",
    "signature",
    "Signature",
    "X-Amz-Signature",
    "X-Amz-Credential",
    "X-Amz-Security-Token",
    "q-signature",
    "q-sign-time",
    "x-goog-signature",
    "x-cos-security-token",
    "auth",
    "authorization",
    "jwt",
    "bearer",
    "session",
    "sessionId",
    "JSESSIONID",
    "PHPSESSID",
    "ticket",
    "accesstoken",
    "authtoken",
    "sessiontoken",
    "apitoken",
    "APIToken",
    "SSOToken",
    "JWTToken",
    "secretkey",
    "clientsecret",
    "appsecret",
    "appkey",
    "sessionkey",
    "privatekey",
    "passphrase",
    "passcode",
    "ACCESSTOKEN",
    "AUTHTOKEN",
    "SECRETKEY",
    "CLIENTSECRET",
    "SSOKey",
    "XAuth",
  ])("reads the query parameter %s as one", (name) => {
    expect(
      linkCarriesCredential(`https://a.example/b?page=1&${name}=${value}`),
    ).toBe(true);
  });

  it.each([
    `https://reader:${value}@a.example/b`,
    `https://${value}@a.example/b`,
    `http://reader:${value}@a.example:8080/`,
    `reader:${value}@a.example/b`,
    `a.example/b?token=${value}`,
    `//reader:${value}@a.example/b`,
    `https://a.example/b?page=1;token=${value}`,
    `https://a.example/a.jsp;jsessionid=${value}?id=1`,
    `https://a.example/a;token=${value}/b`,
    `https://a.example/a;v=1;accesstoken=${value}`,
    `a.example/a;%74oken=${value}`,
    `https://a.example/b#access_token=${value}`,
    `https://a.example/b#page=1&token=${value}`,
    `https://a.example/b#page=1;clientsecret=${value}`,
    `https://a.example/#/callback?access_token=${value}`,
    "https://[unreadable/b",
  ])("reads %s as one", (link) => {
    expect(linkCarriesCredential(link)).toBe(true);
  });

  it.each([
    "https://a.example/b",
    "https://a.example/b?page=3&v=2",
    "https://a.example/b?keyword=碑&keywords=拓片",
    "https://a.example/b?tokenize=1&monkey=2&signal=3&assign=4&design=5",
    "https://a.example/b?hockey=1&whiskey=2&passage=3&sortkey=4",
    "https://a.example/a;v=1/b;keyword=2;tokenize=3;monkey=4",
    "https://a.example/a;token/b",
    "https://a.example/b#page=2&keyword=1&tokenize=3&monkey=4",
    "https://a.example/b#token=",
    "https://a.example/b#:~:text=token",
    "https://a.example/@handle/b",
    "https://a.example/b#token",
    "https://kns.example/detail.aspx?dbcode=CJFD&filename=X&dbname=Y",
    "见《金石萃编》卷一",
    "",
  ])("leaves %s alone", (link) => {
    expect(linkCarriesCredential(link)).toBe(false);
  });
});
