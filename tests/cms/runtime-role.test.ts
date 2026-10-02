import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { postgresAdapter } from "@payloadcms/db-postgres";
import {
  createPostgresPool,
  parsePostgresConfig,
  PostgresCatalogQueryAdapter,
} from "@moya/catalog-postgres";
import { createLocalReq, getPayload, type TypedUser } from "payload";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import config from "admin/config";
import { catalogIdSchema } from "@moya/contracts/schemas";
import { runCommunityMigrations } from "@moya/community-postgres";
import { fileURLToPath } from "node:url";
import { saveDraft, approveBatch, publishApproved } from "admin/editorial";
import { assertSyntheticTestDatabaseUrl } from "../integration/postgres/synthetic-test-database.js";

const connection = process.env.CMS_TEST_DATABASE_URL ?? "";
let database: string;
let setup: ReturnType<typeof createPostgresPool> | undefined;
const setupPool = () => {
  if (setup === undefined)
    throw new Error("Synthetic CMS setup not initialized");
  return setup;
};
const suffix = randomBytes(8).toString("hex");
const roles = [
  `cms_release_fresh_${suffix}`,
  `cms_release_upgrade_${suffix}`,
  `cms_release_public_${suffix}`,
  `cms_release_owner_${suffix}`,
];
const createdRoles: string[] = [];
const password = randomBytes(32).toString("hex");
const pools: ReturnType<typeof createPostgresPool>[] = [];
const payloads: Awaited<ReturnType<typeof getPayload>>[] = [];
const runtimePool = (role: string) => {
  const url = new URL(connection);
  url.username = role;
  url.password = password;
  const poolConfig = parsePostgresConfig({ DATABASE_URL: url.toString() });
  const pool = createPostgresPool(poolConfig);
  pools.push(pool);
  return { pool, poolConfig };
};
const applyCms = async (role: string) => {
  const sql = (
    await readFile(
      new URL("../../infra/development/grant-cms-runtime.sql", import.meta.url),
      "utf8",
    )
  )
    .replaceAll(':"cms_role"', `"${role}"`)
    .replaceAll(":'cms_role'", `'${role}'`);
  const c = await setupPool().connect();
  try {
    await c.query("BEGIN");
    await c.query(sql);
    await c.query("COMMIT");
  } catch (error) {
    await c.query("ROLLBACK");
    throw error;
  } finally {
    c.release();
  }
};
const acl = async (role: string) =>
  (
    await setupPool().query(
      `SELECT table_name, privilege_type FROM information_schema.role_table_grants WHERE grantee=$1 ORDER BY 1,2`,
      [role],
    )
  ).rows;

// Cluster-wide role creation is bounded to the marked local disposable target.
// Existing remote synthetic CMS checks retain their separate emptiness proof.
describe
  .skipIf(Boolean(process.env.CMS_TEST_REMOTE_TARGET_JSON))
  .sequential("Payload runtime grants", () => {
    beforeAll(async () => {
      if (!connection || process.env.CMS_ENVIRONMENT !== "synthetic")
        throw new Error("Synthetic CMS target required");
      database = assertSyntheticTestDatabaseUrl(connection);
      setup = createPostgresPool(
        parsePostgresConfig({ DATABASE_URL: connection }),
      );
      const guard = await import(
        new URL("../../scripts/disposable-test-target.mjs", import.meta.url)
          .href
      );
      guard.assertDisposableTestTarget(
        (await setupPool().query(guard.disposableTestTargetProbeSql)).rows,
        database,
      );
      await runCommunityMigrations(
        setup,
        fileURLToPath(
          new URL("../../database/community-migrations", import.meta.url),
        ),
      );
      for (const role of roles) {
        await setupPool().query(
          `CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT`,
        );
        createdRoles.push(role);
        await setupPool().query(
          `GRANT CONNECT ON DATABASE "${database}" TO "${role}"`,
        );
      }
      // An existing independently owned Catalog-only role gains the newer named
      // Article/runtime surface, without adopting the historical migration owner.
      await setupPool().query(
        `GRANT USAGE ON SCHEMA public TO "${roles[1]}"; GRANT SELECT,INSERT,UPDATE ON public.catalogs TO "${roles[1]}"`,
      );
    });
    afterAll(async () => {
      try {
        for (const payload of payloads) await payload.destroy();
        await Promise.all(pools.map((pool) => pool.end()));
        for (const role of createdRoles) {
          await setupPool().query(`DROP OWNED BY "${role}"`);
          await setupPool().query(`DROP ROLE "${role}"`);
        }
      } finally {
        await setup?.end();
      }
    });

    it("requires explicit grants, repeats unchanged, and upgrades a non-owner role to the same named ACLs", async () => {
      const fresh = runtimePool(roles[0]!).pool;
      await expect(
        fresh.query("SELECT id FROM public.catalogs LIMIT 1"),
      ).rejects.toMatchObject({ code: "42501" });
      await applyCms(roles[0]!);
      const expected = await acl(roles[0]!);
      await applyCms(roles[0]!);
      expect(await acl(roles[0]!)).toEqual(expected);
      await applyCms(roles[1]!);
      expect(await acl(roles[1]!)).toEqual(expected);
      const setupRole = (await setupPool().query("SELECT current_user AS name"))
        .rows[0].name as string;
      await expect(applyCms(setupRole)).rejects.toThrow(
        "CMS runtime must be a non-owner role",
      );
      await setupPool().query(
        `CREATE TABLE public.cms_owner_probe_${suffix}(id int); ALTER TABLE public.cms_owner_probe_${suffix} OWNER TO "${roles[3]}"`,
      );
      await setupPool().query(
        `GRANT "${roles[3]}" TO "${roles[0]}" WITH INHERIT FALSE, SET TRUE`,
      );
      try {
        expect(
          (
            await setupPool().query(
              "SELECT pg_has_role($1,$2,'USAGE') AS inherited, pg_has_role($1,$2,'SET') AS switchable",
              [roles[0], roles[3]],
            )
          ).rows[0],
        ).toEqual({ inherited: false, switchable: true });
        await expect(applyCms(roles[0]!)).rejects.toThrow(
          "CMS runtime must be a non-owner role",
        );
      } finally {
        await setupPool().query(`REVOKE "${roles[3]}" FROM "${roles[0]}"`);
      }
      const publicSql = (
        await readFile(
          new URL(
            "../../infra/development/grant-public-read.sql",
            import.meta.url,
          ),
          "utf8",
        )
      )
        .replace(/\\if :\{\?public_read_role\}[\s\S]*?\\endif/u, "")
        .replaceAll(':"public_read_role"', `"${roles[2]}"`);
      await setupPool().query(publicSql);
      const articleRead = (
        await readFile(
          new URL(
            "../../infra/development/article-authoring/grant-public-read.sql",
            import.meta.url,
          ),
          "utf8",
        )
      ).replaceAll(':"public_read_role"', `"${roles[2]}"`);
      await setupPool().query(articleRead);
    });

    it.each(roles.slice(0, 2))(
      "runs actual draft/publication/session writes as %s with expected denials",
      async (role) => {
        const { pool, poolConfig } = runtimePool(role);
        const payload = await getPayload({
          key: role,
          config: {
            ...(await config),
            db: {
              allowIDOnCreate: false,
              name: "postgres",
              ...postgresAdapter({
                pool: poolConfig,
                push: false,
                disableCreateDatabase: true,
              }),
            },
          },
        });
        payloads.push(payload);
        expect(
          (await payload.db.pool.query("SELECT current_user,session_user"))
            .rows[0],
        ).toEqual({ current_user: role, session_user: role });
        const owner = await payload.create({
          collection: "users",
          overrideAccess: true,
          data: { email: `${role}@example.invalid`, password, role: "owner" },
        });
        const request = (actor: TypedUser) =>
          createLocalReq({ user: actor }, payload);
        const login = await payload.login({
          collection: "users",
          data: { email: `${role}@example.invalid`, password },
        });
        expect(login.user?.id).toBe(owner.id);
        const catalogId = catalogIdSchema.parse(`synthetic-${role}`);
        const automation = await payload.create({
          collection: "users",
          overrideAccess: false,
          req: await request(owner),
          user: owner,
          data: {
            email: `automation-${role}@example.invalid`,
            password,
            role: "automation",
            scopeCatalogIds: [catalogId],
          },
        });
        const content = {
          catalogId,
          sourceId: `source-${role}`,
          kind: "calligraphy",
          title: `Published ${role}`,
          summary: "Synthetic",
          ...Object.fromEntries(
            [
              "dynasty",
              "dateText",
              "province",
              "prefecture",
              "county",
              "currentLocation",
              "currentCustodian",
              "description",
              "scriptStyle",
              "transcription",
              "historicalContext",
              "scholarlyResearch",
            ].map((field) => [field, { state: "UNSUPPLIED" }]),
          ),
          aliases: [{ alias: "Synthetic alias", aliasType: "alternate" }],
          provenance: [],
          sourceCitations: [],
          contributors: [],
          media: [],
        };
        const first = await saveDraft(await request(automation), {
          idempotencyKey: randomUUID(),
          content,
        });
        const publicPool = runtimePool(roles[2]!).pool;
        const publicAdapter = new PostgresCatalogQueryAdapter(publicPool);
        expect(await publicAdapter.getById(catalogId)).toBeNull();
        const grant = await approveBatch(await request(owner), {
          automationUserId: automation.id,
          items: [{ id: first.id, revision: first.revision }],
        });
        const published = await publishApproved(await request(automation), {
          approvalId: grant.approvalId,
          id: first.id,
          idempotencyKey: randomUUID(),
        });
        expect((await publicAdapter.getById(catalogId))?.title).toBe(
          content.title,
        );
        await saveDraft(await request(automation), {
          id: first.id,
          expectedRevision: published.revision,
          idempotencyKey: randomUUID(),
          content: {
            ...content,
            title: `Private ${role}`,
            aliases: [{ alias: "Replacement", aliasType: "alternate" }],
          },
        });
        expect((await publicAdapter.getById(catalogId))?.title).toBe(
          content.title,
        );
        const article = await payload.create({
          collection: "articles",
          overrideAccess: false,
          req: await request(owner),
          user: owner,
          draft: false,
          data: {
            presentation: "news",
            title: `Article ${role}`,
            summary: "Synthetic summary",
            section: "Field",
            byline: "Synthetic",
            sections: [{ body: "Synthetic body" }],
            citations: [],
            _status: "published",
          },
        });
        if (typeof article.revision !== "number")
          throw new Error("Synthetic Article revision missing");
        await payload.update({
          collection: "articles",
          id: article.id,
          overrideAccess: false,
          req: await request(owner),
          user: owner,
          draft: true,
          data: {
            title: `Private article ${role}`,
            revision: article.revision,
            sections: [{ body: "Replacement body" }],
          },
        });
        expect(
          (
            await publicPool.query(
              "SELECT title FROM public.article_entries WHERE article_id=$1",
              [article.articleId],
            )
          ).rows[0].title,
        ).toBe(`Article ${role}`);
        for (const sql of [
          `CREATE TABLE public.denied_${suffix}(id int)`,
          "ALTER TABLE public.catalogs ADD COLUMN forbidden_runtime_column int",
          "UPDATE public.payload_migrations SET name=name WHERE false",
          "DELETE FROM public.payload_migrations WHERE false",
          "SELECT nextval('public.payload_migrations_id_seq')",
          "DELETE FROM public.catalogs WHERE false",
          "DELETE FROM public.users WHERE false",
          "DELETE FROM public.editorial_identities WHERE false",
          "DELETE FROM public.editorial_receipts WHERE false",
          "UPDATE public.catalog_first_publications SET first_published_at=first_published_at WHERE false",
          "SELECT * FROM community.public_users",
          "INSERT INTO community.public_users(id) VALUES (null)",
          "SELECT setval('public.catalogs_id_seq',1)",
        ])
          await expect(pool.query(sql)).rejects.toMatchObject({
            code: "42501",
          });
        expect(
          (
            await publicPool.query(
              "SELECT count(*) FROM community.published_authored_articles",
            )
          ).rows[0].count,
        ).toBe("0");
        await expect(
          publicPool.query("SELECT * FROM community.article_documents"),
        ).rejects.toMatchObject({ code: "42501" });
        await expect(
          publicPool.query("SELECT * FROM public.users"),
        ).rejects.toMatchObject({ code: "42501" });
        await expect(
          publicPool.query(
            "UPDATE public.catalogs SET title=title WHERE false",
          ),
        ).rejects.toMatchObject({ code: "42501" });
      },
    );
  });
