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
import { readMcpControl, writeAuditEvent } from "admin/admin-mcp";
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
  `cms_prepare_reader_${suffix}`,
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

const applyPrepareReader = async (role: string, approved = roles[4]!) => {
  let sql = await readFile(
    new URL(
      "../../infra/development/catalog-media/grant-prepare-read.sql",
      import.meta.url,
    ),
    "utf8",
  );
  for (const [name, value] of Object.entries({
    prepare_reader: role,
    approved_prepare_reader: approved,
    public_read_role: roles[2]!,
    backend_read_role: roles[0]!,
  })) {
    sql = sql
      .replaceAll(`:"${name}"`, `"${value}"`)
      .replaceAll(`:'${name}'`, `'${value}'`);
  }
  const client = await setupPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(sql);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

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
      // The MCP key door stamps last use with this statement, as the runtime role.
      await expect(
        fresh.query(
          "UPDATE public.payload_mcp_api_keys SET last_used_at = now() WHERE id = 0",
        ),
      ).resolves.toMatchObject({ rowCount: 0 });
      const expected = await acl(roles[0]!);
      // The two new tables, exactly: the ledger is append-only by this grant, and
      // the sequences give USAGE alone, so a role cannot move them with setval.
      expect(
        expected.filter(({ table_name }) => table_name.startsWith("mcp_")),
      ).toEqual([
        { table_name: "mcp_audit_events", privilege_type: "INSERT" },
        { table_name: "mcp_audit_events", privilege_type: "SELECT" },
        { table_name: "mcp_control", privilege_type: "INSERT" },
        { table_name: "mcp_control", privilege_type: "SELECT" },
        { table_name: "mcp_control", privilege_type: "UPDATE" },
      ]);
      for (const sequence of ["mcp_audit_events_id_seq", "mcp_control_id_seq"])
        expect(
          (
            await setupPool().query(
              "SELECT has_sequence_privilege($1, $2, 'USAGE') AS usage, has_sequence_privilege($1, $2, 'UPDATE') AS change",
              [roles[0]!, `public.${sequence}`],
            )
          ).rows[0],
        ).toEqual({ usage: true, change: false });
      // The second net stands whatever the grant says, for the table owner too.
      expect(
        (
          await setupPool().query(
            `SELECT tgenabled, pg_get_triggerdef(oid) AS definition FROM pg_trigger
             WHERE tgrelid = 'public.mcp_audit_events'::regclass AND NOT tgisinternal
             ORDER BY tgname`,
          )
        ).rows,
      ).toEqual([
        {
          tgenabled: "O",
          definition: expect.stringContaining(
            "BEFORE DELETE OR UPDATE ON public.mcp_audit_events FOR EACH ROW EXECUTE FUNCTION mcp_audit_events_refuse_change()",
          ) as string,
        },
        {
          tgenabled: "O",
          definition: expect.stringContaining(
            "BEFORE TRUNCATE ON public.mcp_audit_events FOR EACH STATEMENT EXECUTE FUNCTION mcp_audit_events_refuse_change()",
          ) as string,
        },
      ]);
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

    it("grants only the explicitly approved private view reader and refuses shared public/backend identities or role reachability", async () => {
      const privateRole = roles[4]!;
      const refusal =
        "Catalog prepare reader must be the approved private non-owner role";
      await expect(applyPrepareReader(privateRole, roles[1]!)).rejects.toThrow(
        refusal,
      );
      await expect(applyPrepareReader(roles[2]!, roles[2]!)).rejects.toThrow(
        refusal,
      );
      await expect(applyPrepareReader(roles[0]!, roles[0]!)).rejects.toThrow(
        refusal,
      );
      for (const [granted, member, options] of [
        [privateRole, roles[2]!, "INHERIT FALSE, SET TRUE"],
        [roles[2]!, privateRole, "INHERIT FALSE, SET TRUE"],
        [privateRole, roles[0]!, "INHERIT TRUE, SET FALSE"],
        [roles[0]!, privateRole, "INHERIT TRUE, SET FALSE"],
      ]) {
        await setupPool().query(
          `GRANT "${granted}" TO "${member}" WITH ${options}`,
        );
        try {
          await expect(applyPrepareReader(privateRole)).rejects.toThrow(
            refusal,
          );
        } finally {
          await setupPool().query(`REVOKE "${granted}" FROM "${member}"`);
        }
      }
      await applyPrepareReader(privateRole);
      const reader = runtimePool(privateRole).pool;
      // catalog-scale-v1 M2: the live projection the worker's snapshot reads
      // has the same columns, and the same reader is its only grantee.
      expect(
        (
          await reader.query(
            "SELECT * FROM public.catalog_delivery_live_prepare_media LIMIT 0",
          )
        ).fields.map(({ name }) => name),
      ).toEqual(
        (
          await reader.query(
            "SELECT * FROM public.catalog_delivery_prepare_media LIMIT 0",
          )
        ).fields.map(({ name }) => name),
      );
      expect(
        (
          await reader.query(
            "SELECT * FROM public.catalog_delivery_prepare_media LIMIT 0",
          )
        ).fields.map(({ name }) => name),
      ).toEqual([
        "intent_id",
        "catalog_document_id",
        "catalog_id",
        "draft_revision",
        "draft_fingerprint",
        "media_manifest_sha256",
        "recipe_manifest_sha256",
        "state_version",
        "state",
        "media_count",
        "expires_at",
        "media_ordinal",
        "media_id",
        "object_key",
        "source_sha256",
        "width",
        "height",
      ]);
      expect(
        (
          await reader.query(
            "SELECT count(*)::int AS count FROM public.catalog_delivery_prepare_media",
          )
        ).rows[0].count,
      ).toBeGreaterThanOrEqual(0);
      for (const view of [
        "catalog_delivery_prepare_media",
        "catalog_delivery_live_prepare_media",
      ])
        for (const [privilege, allowed] of [
          ["SELECT", true],
          ["INSERT", false],
          ["UPDATE", false],
          ["DELETE", false],
        ] as const)
          expect(
            (
              await reader.query(
                "SELECT has_table_privilege(current_user,$2,$1) AS allowed",
                [privilege, `public.${view}`],
              )
            ).rows[0].allowed,
          ).toBe(allowed);
      expect(
        (
          await reader.query(
            "SELECT count(*)::int AS count FROM public.catalog_delivery_live_prepare_media",
          )
        ).rows[0].count,
      ).toBeGreaterThanOrEqual(0);
      for (const sql of [
        "SELECT * FROM public.catalog_delivery_intents",
        "SELECT * FROM public.catalog_entries",
      ]) {
        await expect(reader.query(sql)).rejects.toMatchObject({
          code: "42501",
        });
      }
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
          overrideAccess: true,
          req: await request(owner),
          user: owner,
          data: {
            email: `automation-${role}@example.invalid`,
            password,
            role: "automation",
            scopeCatalogIds: [catalogId],
          },
        });
        // Without the ledger's sequence the first audit insert fails and every tool
        // answers AUDIT_UNAVAILABLE. Creating the account above already wrote a row
        // through this role; this writes one directly, then saves the seeded control row.
        await writeAuditEvent(payload, {
          callId: randomUUID(),
          phase: "finish",
          class: "read",
          ok: true,
          code: "OK",
        });
        const control = await payload.updateGlobal({
          slug: "mcp-control",
          overrideAccess: true,
          data: { threshold: 20 },
        });
        expect(control.threshold).toBe(20);
        expect((await readMcpControl(payload)).pause).toBe(false);
        expect(
          (
            await pool.query(
              "SELECT count(*) FROM public.mcp_audit_events WHERE op = 'users.change'",
            )
          ).rows[0].count,
        ).not.toBe("0");
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
        // Commit truth, as this role: the two functions it asks PostgreSQL with.
        const statusOf = async (end: "COMMIT" | "ROLLBACK") => {
          const client = await pool.connect();
          let xid: string;
          try {
            await client.query("BEGIN");
            xid = (
              await client.query<{ xid: string }>(
                "SELECT pg_current_xact_id()::text AS xid",
              )
            ).rows[0]!.xid;
            await client.query(end);
          } finally {
            client.release();
          }
          return (
            await pool.query("SELECT pg_xact_status($1::xid8) AS status", [xid])
          ).rows[0].status as unknown;
        };
        expect(await statusOf("COMMIT")).toBe("committed");
        expect(await statusOf("ROLLBACK")).toBe("aborted");
        // And through the real write: a failed COMMIT reads as aborted, not as a
        // refused status read, because this same role then saves with no error.
        const refuseCommit = `refuse_commit_${suffix}`;
        await setupPool().query(`
          CREATE FUNCTION public.${refuseCommit}() RETURNS trigger LANGUAGE plpgsql
            AS $$ BEGIN RAISE EXCEPTION 'synthetic commit failure'; END $$;
          CREATE CONSTRAINT TRIGGER ${refuseCommit} AFTER INSERT ON public.editorial_receipts
            DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.${refuseCommit}()`);
        const saveKey = randomUUID();
        try {
          await expect(
            saveDraft(await request(automation), {
              idempotencyKey: saveKey,
              content,
            }),
          ).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
        } finally {
          await setupPool().query(`
            DROP TRIGGER ${refuseCommit} ON public.editorial_receipts;
            DROP FUNCTION public.${refuseCommit}()`);
        }
        const first = await saveDraft(await request(automation), {
          idempotencyKey: saveKey,
          content,
        });
        expect(first.replayed).toBe(false);
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
          "UPDATE public.mcp_audit_events SET code=code WHERE false",
          "DELETE FROM public.mcp_audit_events WHERE false",
          "TRUNCATE public.mcp_audit_events",
          "DELETE FROM public.mcp_control WHERE false",
          "SELECT setval('public.mcp_audit_events_id_seq',1)",
          "SELECT setval('public.mcp_control_id_seq',1)",
          "DELETE FROM public.catalog_delivery_intents WHERE false",
          "DELETE FROM public.catalog_delivery_receipts WHERE false",
          "UPDATE public.catalog_delivery_receipts SET operation=operation WHERE false",
          "UPDATE public.catalog_delivery_intents SET draft_snapshot=draft_snapshot WHERE false",
          "UPDATE public.catalog_delivery_intents SET media_manifest=media_manifest WHERE false",
          "UPDATE public.catalog_delivery_intents SET recipe_manifest_sha256=recipe_manifest_sha256 WHERE false",
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
        for (const table of [
          "catalog_delivery_intents",
          "catalog_delivery_receipts",
          "catalog_delivery_prepare_media",
          "catalog_delivery_live_prepare_media",
        ])
          await expect(
            publicPool.query(`SELECT * FROM public.${table}`),
          ).rejects.toMatchObject({ code: "42501" });
        await expect(
          publicPool.query(
            "UPDATE public.catalogs SET title=title WHERE false",
          ),
        ).rejects.toMatchObject({ code: "42501" });
      },
    );
  });
