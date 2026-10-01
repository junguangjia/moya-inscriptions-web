/**
 * content-community-completion-v1, integration finding C1: Owner moderation of
 * direct messages under the REAL runtime App role.
 *
 * The other direct-message suites run as the database owner, which holds every
 * privilege, so a missing runtime grant was invisible there: removal redacts
 * the sender's send receipt and needs UPDATE (result) on
 * community.dm_command_receipts. This suite creates a disposable database and a
 * NOSUPERUSER App role, applies the exact infra/development grant-runtime.sql,
 * and exercises the adapter only through that role.
 *
 * clean   — a fresh role receives grant-runtime.sql once.
 * reapply — the SAME role first holds the previous grant state (this plan
 *           without the receipt-redaction grant) and is brought forward by
 *           reapplying grant-runtime.sql. Its effective direct-message
 *           privileges must then equal those of a reference role that only
 *           ever received the current plan.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  createPostgresPool,
  parsePostgresConfig,
} from "@moya/catalog-postgres";
import {
  PostgresDirectMessageAdapter,
  runCommunityMigrations,
} from "@moya/community-postgres";
import type { DmConversationId, DmMessageId } from "@moya/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { requireSyntheticTestDatabaseUrl } from "./synthetic-test-database.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const target = requireSyntheticTestDatabaseUrl();
if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(target).hostname))
  throw Error("Loopback synthetic database required");
type Pool = ReturnType<typeof createPostgresPool>;
const poolFor = (url: string): Pool =>
  createPostgresPool(parsePostgresConfig({ DATABASE_URL: url }));
const admin = poolFor(target);
const guard = await import(
  new URL("../../../scripts/disposable-test-target.mjs", import.meta.url).href
);
afterAll(async () => {
  await admin.end();
});

const DM_TABLES = [
  "dm_conversations",
  "dm_participants",
  "dm_messages",
  "dm_command_receipts",
  "dm_moderation_events",
];
const privilegesOf = async (pool: Pool, role: string): Promise<string[]> =>
  (
    await pool.query<{ p: string }>(
      `SELECT c.relname||' '||a.privilege_type AS p
         FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
         CROSS JOIN LATERAL aclexplode(c.relacl) a
        WHERE n.nspname='community' AND c.relname = ANY($2::text[])
          AND a.grantee=(SELECT oid FROM pg_roles WHERE rolname=$1)
       UNION ALL
       SELECT c.relname||'.'||att.attname||' '||a.privilege_type
         FROM pg_attribute att JOIN pg_class c ON c.oid=att.attrelid
         JOIN pg_namespace n ON n.oid=c.relnamespace
         CROSS JOIN LATERAL aclexplode(att.attacl) a
        WHERE n.nspname='community' AND c.relname = ANY($2::text[])
          AND a.grantee=(SELECT oid FROM pg_roles WHERE rolname=$1)
       ORDER BY 1`,
      [role, DM_TABLES],
    )
  ).rows.map((row) => row.p);
const denied = async (run: Promise<unknown>) =>
  run.then(
    () => "allowed",
    (error: { code?: string }) => error.code ?? "error",
  );

describe.each(["clean", "reapply"] as const)(
  "direct-message moderation as the App role (%s)",
  (mode) => {
    const suffix = randomBytes(6).toString("hex"),
      database = `dm_app_${suffix}_synthetic_test`,
      role = `dm_app_${suffix}`,
      reference = `dm_ref_${suffix}`;
    let setup: Pool | undefined,
      app: Pool | undefined,
      createdDB = false;
    const createdRoles: string[] = [];
    let dm: PostgresDirectMessageAdapter;
    let grants = "";
    const apply = (grantee: string) =>
      setup!.query(grants.replaceAll(':"app_role"', `"${grantee}"`));
    const user = async (label: string) => {
      const id = `user-${randomUUID().replaceAll("-", "")}`;
      await setup!.query(
        "INSERT INTO community.public_users(id,handle,display_name) VALUES($1,$2,$3)",
        [id, `dm-${id.slice(-24)}`, label],
      );
      return id;
    };
    const receipt = async (actor: string, requestId: string) =>
      (
        await setup!.query<{ result: Record<string, unknown> }>(
          "SELECT result FROM community.dm_command_receipts WHERE actor_id=$1 AND request_id=$2",
          [actor, requestId],
        )
      ).rows[0]?.result;
    const removals = async (messageId: string) =>
      Number(
        (
          await setup!.query<{ n: string }>(
            "SELECT count(*) AS n FROM community.dm_moderation_events WHERE message_id=$1 AND action='remove_message'",
            [messageId],
          )
        ).rows[0]!.n,
      );

    beforeAll(async () => {
      const probe = await admin.query(guard.disposableTestTargetProbeSql);
      guard.assertDisposableTestTarget(
        probe.rows,
        decodeURI(new URL(target).pathname.slice(1)),
      );
      const password = randomBytes(32).toString("hex");
      for (const name of [role, reference]) {
        await admin.query(
          `CREATE ROLE ${name} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT`,
        );
        createdRoles.push(name);
      }
      await admin.query(`CREATE DATABASE ${database}`);
      createdDB = true;
      const url = new URL(target);
      url.pathname = `/${database}`;
      setup = poolFor(url.toString());
      await runCommunityMigrations(
        setup,
        `${root}/database/community-migrations`,
      );
      // parallel-community-integration-qa: grant-runtime.sql also names C's
      // published-only public.article_entries (the notification Article bridge);
      // Development creates it with the Payload migration
      // 20260922_015000_editorial_content_views before the runtime grants, so it is
      // stood in here like the Catalog views.
      await setup.query(
        "CREATE TABLE public.catalog_entries(catalog_id text PRIMARY KEY,province text,province_state text); CREATE TABLE public.catalog_discovery(catalog_id text PRIMARY KEY,kind text,title text,aliases varchar[],first_published_at timestamptz,filter_metadata jsonb); CREATE TABLE public.catalog_media(catalog_id text,media_id text,object_key text,width integer,height integer,is_representative boolean); CREATE TABLE public.article_entries(article_id text PRIMARY KEY,title text)",
      );
      grants = await readFile(
        `${root}/infra/development/work-publishing/grant-runtime.sql`,
        "utf8",
      );
      if (mode === "reapply") {
        // The previous plan (before this repair) lacked the redaction grant.
        await apply(role);
        await setup.query(
          `REVOKE UPDATE (result) ON TABLE community.dm_command_receipts FROM "${role}"`,
        );
        expect(await privilegesOf(setup, role)).not.toContain(
          "dm_command_receipts.result UPDATE",
        );
      }
      await apply(role);
      await apply(reference);
      url.username = role;
      url.password = password;
      app = poolFor(url.toString());
      expect(
        (
          await app.query<{ current_user: string; rolsuper: boolean }>(
            "SELECT current_user, rolsuper FROM pg_roles WHERE rolname=current_user",
          )
        ).rows,
      ).toEqual([{ current_user: role, rolsuper: false }]);
      dm = new PostgresDirectMessageAdapter(app);
    }, 60_000);

    afterAll(async () => {
      await app?.end();
      await setup?.end();
      if (createdDB) await admin.query(`DROP DATABASE ${database}`);
      for (const name of createdRoles) await admin.query(`DROP ROLE ${name}`);
    });

    it("holds exactly the reference direct-message privileges and converges when reapplied", async () => {
      const actual = await privilegesOf(setup!, role);
      expect(actual).toEqual(await privilegesOf(setup!, reference));
      expect(actual).toContain("dm_command_receipts.result UPDATE");
      // Only the stored result is writable; identity and ownership stay write-once.
      expect(actual.filter((p) => p.startsWith("dm_command_receipts"))).toEqual(
        [
          "dm_command_receipts INSERT",
          "dm_command_receipts SELECT",
          "dm_command_receipts.result UPDATE",
        ],
      );
      await apply(role);
      expect(await privilegesOf(setup!, role)).toEqual(actual);
    });

    it("removes a message, redacts the sender's receipt and audits it, all as the App role", async () => {
      const a = await user("甲"),
        b = await user("乙");
      const body = `待移除的私信正文 ${randomUUID()}`;
      const sendRequest = randomUUID();
      const first = await dm.send(a, {
        requestId: sendRequest,
        recipientId: b,
        text: body,
      });
      await dm.send(b, {
        requestId: randomUUID(),
        conversationId: first.conversationId,
        text: "收到",
      });
      const operatorRequest = randomUUID();
      const removed = await dm.operatorRemoveMessage(
        "owner",
        first.id as DmMessageId,
        operatorRequest,
        "验收：移除一条测试私信",
      );
      expect(removed).toMatchObject({
        id: first.id,
        removed: true,
        text: null,
      });

      for (const reader of [a, b]) {
        const history = await dm.readConversation(
          reader,
          first.conversationId as DmConversationId,
          { pageSize: 10 },
        );
        const placeholder = history.items.find((m) => m.id === first.id);
        expect(placeholder).toMatchObject({ removed: true, text: null });
        expect(JSON.stringify(history)).not.toContain(body);
      }
      const redacted = await receipt(a, sendRequest);
      expect(redacted).toMatchObject({
        id: first.id,
        removed: true,
        text: null,
      });
      expect(JSON.stringify(redacted)).not.toContain(body);
      expect(await removals(first.id)).toBe(1);
      expect(
        (
          await setup!.query(
            "SELECT 1 FROM community.content_operator_receipts WHERE operator_label='owner' AND request_id=$1",
            [operatorRequest],
          )
        ).rowCount,
      ).toBe(1);
    });

    it("replays a removal idempotently and refuses a reused request identity with a different command", async () => {
      const a = await user("丙"),
        b = await user("丁");
      const first = await dm.send(a, {
        requestId: randomUUID(),
        recipientId: b,
        text: "另一条待移除的私信",
      });
      const operatorRequest = randomUUID();
      const purpose = "验收：重复移除";
      const once = await dm.operatorRemoveMessage(
        "owner",
        first.id as DmMessageId,
        operatorRequest,
        purpose,
      );
      const removedAt = (
        await setup!.query<{ removed_at: Date }>(
          "SELECT removed_at FROM community.dm_messages WHERE id=$1",
          [first.id],
        )
      ).rows[0]!.removed_at;
      const again = await dm.operatorRemoveMessage(
        "owner",
        first.id as DmMessageId,
        operatorRequest,
        purpose,
      );
      expect(again).toEqual(once);
      expect(await removals(first.id)).toBe(1);
      await expect(
        dm.operatorRemoveMessage(
          "owner",
          first.id as DmMessageId,
          operatorRequest,
          "另一个目的",
        ),
      ).rejects.toThrow();
      // A new command on an already removed message changes nothing it removed.
      const later = await dm.operatorRemoveMessage(
        "owner",
        first.id as DmMessageId,
        randomUUID(),
        purpose,
      );
      expect(later).toMatchObject({ id: first.id, removed: true, text: null });
      expect(
        (
          await setup!.query<{ removed_at: Date }>(
            "SELECT removed_at FROM community.dm_messages WHERE id=$1",
            [first.id],
          )
        ).rows[0]!.removed_at,
      ).toEqual(removedAt);
    });

    it("replays the original send after removal without revealing the body or resurrecting the message", async () => {
      const a = await user("戊"),
        b = await user("己");
      const body = `重放前的私信正文 ${randomUUID()}`;
      const sendRequest = randomUUID();
      const first = await dm.send(a, {
        requestId: sendRequest,
        recipientId: b,
        text: body,
      });
      await dm.operatorRemoveMessage(
        "owner",
        first.id as DmMessageId,
        randomUUID(),
        "验收：移除后重放",
      );
      const count = async () =>
        Number(
          (
            await setup!.query<{ n: string }>(
              "SELECT count(*) AS n FROM community.dm_messages WHERE conversation_id=$1",
              [first.conversationId],
            )
          ).rows[0]!.n,
        );
      const before = await count();
      const replay = await dm.send(a, {
        requestId: sendRequest,
        recipientId: b,
        text: body,
      });
      expect(replay).toMatchObject({ id: first.id, removed: true, text: null });
      expect(JSON.stringify(replay)).not.toContain(body);
      expect(await count()).toBe(before);
      const history = await dm.readConversation(
        b,
        first.conversationId as DmConversationId,
        { pageSize: 10 },
      );
      expect(history.items.map((m) => [m.id, m.removed])).toEqual([
        [first.id, true],
      ]);
    });

    it("denies the App role any rewrite of receipt identity, message bodies or audit, and any delete", async () => {
      const a = await user("庚"),
        b = await user("辛");
      const sendRequest = randomUUID();
      const first = await dm.send(a, {
        requestId: sendRequest,
        recipientId: b,
        text: "权限边界",
      });
      const where = `WHERE actor_id='${a}' AND request_id='${sendRequest}'`;
      for (const statement of [
        `UPDATE community.dm_command_receipts SET fingerprint=repeat('0',64) ${where}`,
        `UPDATE community.dm_command_receipts SET actor_id='${b}' ${where}`,
        `UPDATE community.dm_command_receipts SET request_id='${randomUUID()}' ${where}`,
        `UPDATE community.dm_command_receipts SET created_at=now() ${where}`,
        `DELETE FROM community.dm_command_receipts ${where}`,
        `UPDATE community.dm_messages SET text='改写' WHERE id='${first.id}'`,
        `UPDATE community.dm_messages SET sender_id='${b}' WHERE id='${first.id}'`,
        `DELETE FROM community.dm_messages WHERE id='${first.id}'`,
        `UPDATE community.dm_moderation_events SET purpose='改写'`,
        `DELETE FROM community.dm_moderation_events`,
      ])
        expect([statement, await denied(app!.query(statement))]).toEqual([
          statement,
          "42501",
        ]);
    });

    it("leaves no removal, redaction, audit or receipt when removal fails part-way", async () => {
      const a = await user("壬"),
        b = await user("癸");
      const body = `失败回滚的私信正文 ${randomUUID()}`;
      const sendRequest = randomUUID();
      const first = await dm.send(a, {
        requestId: sendRequest,
        recipientId: b,
        text: body,
      });
      // Fail the audit insert, which runs after the message update and the
      // receipt redaction inside the same transaction.
      await setup!.query(`
        CREATE FUNCTION community.dm_app_role_test_fail_audit() RETURNS trigger
          LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected audit failure'; END $$;
        GRANT EXECUTE ON FUNCTION community.dm_app_role_test_fail_audit() TO "${role}";
        CREATE TRIGGER dm_app_role_test_fail_audit BEFORE INSERT ON community.dm_moderation_events
          FOR EACH ROW WHEN (NEW.action = 'remove_message')
          EXECUTE FUNCTION community.dm_app_role_test_fail_audit();`);
      const operatorRequest = randomUUID();
      try {
        await expect(
          dm.operatorRemoveMessage(
            "owner",
            first.id as DmMessageId,
            operatorRequest,
            "验收：失败回滚",
          ),
        ).rejects.toThrow();
      } finally {
        await setup!.query(`
          DROP TRIGGER dm_app_role_test_fail_audit ON community.dm_moderation_events;
          DROP FUNCTION community.dm_app_role_test_fail_audit();`);
      }
      const row = (
        await setup!.query<{ removed_at: Date | null }>(
          "SELECT removed_at FROM community.dm_messages WHERE id=$1",
          [first.id],
        )
      ).rows[0]!;
      expect(row.removed_at).toBeNull();
      expect(await receipt(a, sendRequest)).toMatchObject({
        id: first.id,
        removed: false,
        text: body,
      });
      expect(await removals(first.id)).toBe(0);
      expect(
        (
          await setup!.query(
            "SELECT 1 FROM community.content_operator_receipts WHERE request_id=$1",
            [operatorRequest],
          )
        ).rowCount,
      ).toBe(0);
    });
  },
);
