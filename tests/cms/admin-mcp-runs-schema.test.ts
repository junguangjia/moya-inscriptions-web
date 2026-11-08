import { randomUUID } from "node:crypto";
import path from "node:path";

import { sql, type PostgresAdapter } from "@payloadcms/db-postgres";
import {
  createPostgresPool,
  parsePostgresConfig,
} from "@moya/catalog-postgres";
import { ADMIN_MCP_OPERATOR_ROW_EMAIL } from "@moya/contracts/internal/admin-mcp";
import { getPayload, type Payload } from "payload";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { assertSyntheticTestDatabaseUrl } from "../integration/postgres/synthetic-test-database.js";

// The run ledger's second net (admin-mcp-completion-v1 S8, amendment section 10), on
// the migrated synthetic database. The table owner writes here, which no grant binds,
// so each refusal is the trigger's or a CHECK's. Every case runs in a transaction that
// is rolled back, except the two lock cases, which remove what they made.

const connection = process.env.CMS_TEST_DATABASE_URL ?? "";
if (process.env.CMS_ENVIRONMENT !== "synthetic" || !connection)
  throw new Error("SYNTHETIC_CMS_TARGET_REQUIRED");
assertSyntheticTestDatabaseUrl(connection, "CMS_TEST_DATABASE_URL");

const MIGRATION = "20261106_103000_mcp_runs";
const pool = createPostgresPool(
  parsePostgresConfig({ DATABASE_URL: connection }),
);
const connect = () => pool.connect();
type Client = Awaited<ReturnType<typeof connect>>;
/** A statement and its values, spread into `query` or `refusal`. */
type Statement = [text: string, values: unknown[]];
let payload: Payload;

const hex = (character: string) => character.repeat(64);
const SEAL = hex("a");

/** Runs `check` in a transaction that is always rolled back. */
const rolledBack = async (check: (client: Client) => Promise<void>) => {
  const client = await connect();
  try {
    await client.query("BEGIN");
    await check(client);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
};

/** What a piece of work's refusal says, or null when it went through. */
const tried = async (
  client: Client,
  work: () => Promise<unknown>,
): Promise<{ message: string; code: string } | null> => {
  await client.query("SAVEPOINT attempt");
  try {
    await work();
    await client.query("RELEASE SAVEPOINT attempt");
    return null;
  } catch (error) {
    await client.query("ROLLBACK TO SAVEPOINT attempt");
    const { message, code } = error as { message: string; code: string };
    return { message, code };
  }
};
const refusal = (
  client: Client,
  text: string,
  values: readonly unknown[] = [],
) => tried(client, () => client.query(text, [...values]));
const raised = (message: string) => ({ message, code: "23514" });
const checkFailed = {
  message: expect.stringContaining("violates check constraint") as string,
  code: "23514",
};

const user = async (client: Client, role: string) =>
  (
    await client.query<{ id: number }>(
      `INSERT INTO users (role, email) VALUES ($1, $2) RETURNING id`,
      [role, `runs-${role}-${randomUUID()}@example.invalid`],
    )
  ).rows[0]!.id;

interface RunFields {
  readonly run_id?: string;
  readonly class?: string;
  readonly state?: string;
  readonly expected_count?: number | null;
  readonly key_id?: number | null;
  readonly connection_id?: string | null;
  readonly credential?: string;
  readonly request_id?: string | null;
  readonly sealed_at?: string | null;
  readonly seal_hash?: string | null;
}

/** A planning run of an AI row, by key 7 unless the fields say otherwise. */
const insertRun = async (
  client: Client,
  userId: number,
  fields: RunFields = {},
) => {
  const run = {
    run_id: randomUUID(),
    class: "irreversible",
    state: "planning",
    expected_count: null,
    key_id: 7,
    connection_id: null,
    credential: "key:7",
    request_id: `runs-${randomUUID()}`,
    sealed_at: null,
    seal_hash: null,
    ...fields,
  };
  await client.query(
    `INSERT INTO mcp_runs (run_id, format_version, contract_version, op_schema_hash, credential,
       key_id, connection_id, user_id, op, class, request_id, fingerprint, reason, common_input,
       selection, expected_count, sealed_at, seal_hash, state, expires_at)
     VALUES ($1, 1, '2026-11-06', $2, $3, $4, $5, $6, 'community.delete-body', $7, $8, $2,
       'synthetic reason', '{"reason":"synthetic"}', '{"kind":"targets"}', $9, $10, $11, $12,
       now() + interval '15 minutes')`,
    [
      run.run_id,
      hex("b"),
      run.credential,
      run.key_id,
      run.connection_id,
      userId,
      run.class,
      run.request_id,
      run.expected_count,
      run.sealed_at,
      run.seal_hash,
      run.state,
    ],
  );
  return run.run_id;
};
const target = (runId: string, idx: number) =>
  [
    `INSERT INTO mcp_run_targets (run_id, idx, ref, ref_key, frozen_input)
     VALUES ($1, $2, $3, $4, $3)`,
    [runId, idx, JSON.stringify({ id: `comment-${idx}` }), `comment-${idx}`],
  ] satisfies Statement;
const seal = (runId: string, count: number) =>
  [
    `UPDATE mcp_runs SET state = 'previewed', sealed_at = now(), seal_hash = $2, target_count = $3
     WHERE run_id = $1`,
    [runId, SEAL, count],
  ] satisfies Statement;
const setRun = (runId: string, assignments: string, values: unknown[] = []) =>
  [
    `UPDATE mcp_runs SET ${assignments} WHERE run_id = $1`,
    [runId, ...values],
  ] satisfies Statement;
const setTarget = (
  runId: string,
  assignments: string,
  values: unknown[] = [],
) =>
  [
    `UPDATE mcp_run_targets SET ${assignments} WHERE run_id = $1 AND idx = 0`,
    [runId, ...values],
  ] satisfies Statement;

beforeAll(async () => {
  payload = await getPayload({
    config: await (await import("admin/config")).default,
  });
});

afterAll(async () => {
  await payload?.destroy();
  await pool.end();
});

describe("the run ledger migration", () => {
  it("goes down to nothing and up again on the migrated database", async () => {
    const migration = (await import(
      /* @vite-ignore */
      path.join(
        (payload.db as unknown as Pick<PostgresAdapter, "migrationDir">)
          .migrationDir,
        `${MIGRATION}.ts`,
      )
    )) as Record<"up" | "down", (args: unknown) => Promise<void>>;
    const db = (payload.db as unknown as Pick<PostgresAdapter, "drizzle">)
      .drizzle;
    const objects = sql`
      SELECT (SELECT count(*)::int FROM pg_class WHERE relname IN ('mcp_runs', 'mcp_run_targets')
                AND relnamespace = 'public'::regnamespace) AS tables,
             (SELECT count(*)::int FROM pg_proc WHERE proname LIKE 'mcp_run%'
                AND pronamespace = 'public'::regnamespace) AS functions,
             (SELECT count(*)::int FROM pg_trigger WHERE NOT tgisinternal
                AND tgrelid IN (SELECT oid FROM pg_class WHERE relname IN ('mcp_runs', 'mcp_run_targets'))) AS triggers`;
    const seen: unknown[] = [];
    await db
      .transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL lock_timeout = '5s'`);
        seen.push((await tx.execute(objects)).rows[0]);
        await migration.down({ db: tx });
        seen.push((await tx.execute(objects)).rows[0]);
        await migration.up({ db: tx });
        seen.push((await tx.execute(objects)).rows[0]);
        tx.rollback();
      })
      .catch((error: unknown) => {
        if (seen.length < 3) throw error;
      });
    expect(seen).toEqual([
      { tables: 2, functions: 4, triggers: 4 },
      { tables: 0, functions: 0, triggers: 0 },
      { tables: 2, functions: 4, triggers: 4 },
    ]);
  });
});

describe("mcp_runs", () => {
  it("keeps a run's identity, and its common input but for clearing it", async () => {
    await rolledBack(async (client) => {
      const ai = await user(client, "ai_operator");
      const run = await insertRun(client, ai);
      const other = await user(client, "ai_operator");
      for (const [assignments, values] of [
        ["run_id = $2", [randomUUID()]],
        ["format_version = 2", []],
        ["contract_version = '2026-12-01'", []],
        ["op_schema_hash = $2", [hex("c")]],
        ["credential = 'key:8', key_id = 8", []],
        [
          "credential = 'conn:conn-1', key_id = NULL, connection_id = 'conn-1'",
          [],
        ],
        ["user_id = $2", [other]],
        ["op = 'community.remove-thread'", []],
        ["request_id = 'another'", []],
        ["fingerprint = $2", [hex("c")]],
        ["reason = 'another'", []],
        ["expected_count = 3", []],
        ["created_at = now() - interval '1 day'", []],
      ] as const)
        expect(
          await refusal(client, ...setRun(run, assignments, [...values])),
          assignments,
        ).toEqual(raised("MCP_RUN_IDENTITY_IMMUTABLE"));
      expect(
        await refusal(
          client,
          ...setRun(run, `common_input = '{"reason":"changed"}'`),
        ),
      ).toEqual(raised("MCP_RUN_INPUT_FROZEN"));
      expect(
        await refusal(client, ...setRun(run, "common_input = NULL")),
      ).toBeNull();
    });
  });

  it("raises a class only while planning, and never lowers one", async () => {
    await rolledBack(async (client) => {
      const ai = await user(client, "ai_operator");
      const rising = await insertRun(client, ai, { class: "reversible" });
      expect(
        await refusal(client, ...setRun(rising, "class = 'irreversible'")),
      ).toBeNull();
      expect(
        await refusal(client, ...setRun(rising, "class = 'reversible'")),
      ).toEqual(raised("MCP_RUN_CLASS_RISES_ONLY"));
      const sealed = await insertRun(client, ai, { class: "reversible" });
      await client.query(...seal(sealed, 0));
      expect(
        await refusal(client, ...setRun(sealed, "class = 'irreversible'")),
      ).toEqual(raised("MCP_RUN_CLASS_RISES_ONLY"));
    });
  });

  it("seals once, and only at the count of its targets and the one expected", async () => {
    await rolledBack(async (client) => {
      const ai = await user(client, "ai_operator");
      const run = await insertRun(client, ai, { expected_count: 2 });
      await client.query(...target(run, 0));
      expect(await refusal(client, ...seal(run, 2))).toEqual(
        raised("MCP_RUN_SEAL_COUNT"),
      );
      // One target frozen and one stored: true, but not the count expected.
      expect(await refusal(client, ...seal(run, 1))).toEqual(
        raised("MCP_RUN_SEAL_COUNT"),
      );
      await client.query(...target(run, 1));
      expect(await refusal(client, ...seal(run, 2))).toBeNull();
      for (const assignments of [
        "seal_hash = $2",
        "sealed_at = now() + interval '1 second'",
        "target_count = 3",
        "sealed_at = NULL, seal_hash = NULL, state = 'expired'",
      ])
        expect(
          await refusal(
            client,
            ...setRun(
              run,
              assignments,
              assignments.includes("$2") ? [hex("d")] : [],
            ),
          ),
          assignments,
        ).toEqual(raised("MCP_RUN_SEALED"));
      // And no target joins it afterwards.
      expect(await refusal(client, ...target(run, 2))).toEqual(
        raised("MCP_RUN_SEALED"),
      );
      // Nor before a seal is a run in a sealed state.
      const open = await insertRun(client, ai);
      expect(
        await refusal(client, ...setRun(open, "state = 'running'")),
      ).toEqual(checkFailed);
    });
  });

  it("is confirmed once, from awaiting_owner, to the sealed hash, by an Owner row alone", async () => {
    await rolledBack(async (client) => {
      const ai = await user(client, "ai_operator");
      const automation = await user(client, "automation");
      const owner = await user(client, "owner");
      const run = await insertRun(client, ai);
      await client.query(...target(run, 0));
      await client.query(...seal(run, 1));
      const confirm = (by: number, hash = SEAL, state = "confirmed") =>
        setRun(
          run,
          "state = $4, confirmed_by = $2, confirmed_at = now(), confirmed_seal_hash = $3",
          [by, hash, state],
        );
      // Not yet waiting for the Owner.
      expect(await refusal(client, ...confirm(owner))).toEqual(
        raised("MCP_RUN_CONFIRMATION_INVALID"),
      );
      await client.query(...setRun(run, "state = 'awaiting_owner'"));
      for (const [label, attempt] of [
        ["by the AI row", confirm(ai)],
        ["by an automation row", confirm(automation)],
        ["by no row", confirm(2_147_483_000)],
        ["to another hash", confirm(owner, hex("e"))],
        ["staying where it was", confirm(owner, SEAL, "awaiting_owner")],
        ["straight to running", confirm(owner, SEAL, "running")],
      ] as const)
        expect(await refusal(client, ...attempt), label).toEqual(
          raised("MCP_RUN_CONFIRMATION_INVALID"),
        );
      // Nothing leaves awaiting_owner but a confirmation, a cancel or an expiry.
      expect(
        await refusal(client, ...setRun(run, "state = 'running'")),
      ).toEqual(raised("MCP_RUN_AWAITS_OWNER"));
      expect(
        await refusal(client, ...setRun(run, "state = 'confirmed'")),
      ).toEqual(checkFailed);
      expect(await refusal(client, ...confirm(owner))).toBeNull();
      const another = await user(client, "owner");
      for (const assignments of [
        "confirmed_by = $2",
        "confirmed_at = now() + interval '1 second'",
        "confirmed_seal_hash = seal_hash, confirmed_by = $2",
      ])
        expect(
          await refusal(
            client,
            ...setRun(
              run,
              assignments,
              assignments.includes("$2") ? [another] : [],
            ),
          ),
          assignments,
        ).toEqual(raised("MCP_RUN_CONFIRMED"));
      expect(
        await refusal(client, ...setRun(run, "state = 'running'")),
      ).toBeNull();
      // A terminal state stays.
      expect(
        await refusal(client, ...setRun(run, "state = 'succeeded'")),
      ).toBeNull();
      expect(
        await refusal(client, ...setRun(run, "state = 'running'")),
      ).toEqual(raised("MCP_RUN_TERMINAL"));
    });
  });

  it("is inserted unsealed and unconfirmed, and leaves a read run's request and targets out", async () => {
    await rolledBack(async (client) => {
      const ai = await user(client, "ai_operator");
      const owner = await user(client, "owner");
      for (const fields of [
        { sealed_at: new Date().toISOString(), seal_hash: SEAL },
        { state: "running" },
        { state: "awaiting_owner" },
      ] as const)
        expect(
          await tried(client, () => insertRun(client, ai, fields)),
          JSON.stringify(fields),
        ).toEqual(raised("MCP_RUN_INSERT_UNSEALED"));
      expect(
        await refusal(
          client,
          `INSERT INTO mcp_runs (run_id, format_version, contract_version, op_schema_hash, credential,
             key_id, user_id, op, class, request_id, fingerprint, selection, state, expires_at,
             confirmed_by, confirmed_at, confirmed_seal_hash)
           VALUES ($1, 1, '2026-11-06', $2, 'key:7', 7, $3, 'community.delete-body', 'irreversible',
             'runs-confirmed', $2, '{}', 'planning', now(), $4, now(), $2)`,
          [randomUUID(), SEAL, ai, owner],
        ),
      ).toEqual(raised("MCP_RUN_INSERT_UNSEALED"));
      // A read run, S9's preview ticket: no requestId, no seal, no target.
      expect(
        await tried(client, () =>
          insertRun(client, ai, {
            class: "read",
            state: "previewed",
            request_id: null,
          }),
        ),
      ).toBeNull();
      expect(
        await tried(client, () =>
          insertRun(client, ai, { class: "reversible", request_id: null }),
        ),
      ).toEqual(checkFailed);
    });
  });

  it("names one credential, holds a requestId once per credential, and caps what the page reads", async () => {
    await rolledBack(async (client) => {
      const ai = await user(client, "ai_operator");
      const attempt = (fields: RunFields) =>
        tried(client, () => insertRun(client, ai, fields));
      expect(
        await attempt({
          key_id: 7,
          connection_id: "conn-1",
          credential: "key:7",
        }),
      ).toEqual(checkFailed);
      expect(await attempt({ key_id: 7, credential: "key:8" })).toEqual(
        checkFailed,
      );
      expect(await attempt({ key_id: null, credential: "key:7" })).toEqual(
        checkFailed,
      );
      expect(
        await attempt({
          key_id: null,
          connection_id: `conn-${"a".repeat(32)}`,
          credential: `conn:conn-${"a".repeat(32)}`,
          request_id: "shared",
        }),
      ).toBeNull();
      // The same requestId under a key is another run; under the same key it is not.
      expect(await attempt({ request_id: "shared" })).toBeNull();
      expect(await attempt({ request_id: "shared" })).toMatchObject({
        code: "23505",
      });
      const run = await insertRun(client, ai);
      expect(
        await refusal(
          client,
          ...setRun(
            run,
            `preview = jsonb_build_object('pad', repeat('x', 16400))`,
          ),
        ),
      ).toEqual(checkFailed);
      expect(
        await refusal(
          client,
          `INSERT INTO mcp_runs (run_id, format_version, contract_version, op_schema_hash, credential,
             key_id, user_id, op, class, request_id, fingerprint, reason, selection, state, expires_at)
           VALUES ($1, 1, '2026-11-06', $2, 'key:7', 7, $3, 'community.delete-body', 'irreversible',
             $4, $2, repeat('x', 2001), '{}', 'planning', now())`,
          [randomUUID(), SEAL, ai, `runs-${randomUUID()}`],
        ),
      ).toEqual(checkFailed);
    });
  });
});

describe("mcp_run_targets", () => {
  it("never moves a target, and keeps one ref per run", async () => {
    await rolledBack(async (client) => {
      const ai = await user(client, "ai_operator");
      const run = await insertRun(client, ai);
      const other = await insertRun(client, ai);
      await client.query(...target(run, 0));
      for (const [assignments, values] of [
        ["run_id = $2", [other]],
        ["idx = 5", []],
        [`ref = '{"id":"comment-9"}'`, []],
        ["ref_key = 'comment-9'", []],
      ] as const)
        expect(
          await refusal(client, ...setTarget(run, assignments, [...values])),
          assignments,
        ).toEqual(raised("MCP_RUN_TARGET_IMMUTABLE"));
      expect(
        await refusal(
          client,
          `INSERT INTO mcp_run_targets (run_id, idx, ref, ref_key) VALUES ($1, 1, '{}', 'comment-0')`,
          [run],
        ),
      ).toMatchObject({ code: "23505" });
    });
  });

  it("is stamped once, before the seal, with any filling of its input", async () => {
    await rolledBack(async (client) => {
      const ai = await user(client, "ai_operator");
      const run = await insertRun(client, ai);
      await client.query(...target(run, 0));
      await client.query(...target(run, 1));
      expect(
        await refusal(
          client,
          ...setTarget(
            run,
            `stamp = 'r1', frozen_input = '{"id":"comment-0","expectedAffectedCount":3}'`,
          ),
        ),
      ).toBeNull();
      for (const assignments of ["stamp = 'r2'", "stamp = NULL"])
        expect(
          await refusal(client, ...setTarget(run, assignments)),
          assignments,
        ).toEqual(raised("MCP_RUN_TARGET_STAMPED"));
      // Without a stamp written, the input may only be cleared.
      expect(
        await refusal(
          client,
          ...setTarget(run, `frozen_input = '{"id":"comment-0"}'`),
        ),
      ).toEqual(raised("MCP_RUN_TARGET_FROZEN"));
      await client.query(...seal(run, 2));
      expect(
        await refusal(
          client,
          `UPDATE mcp_run_targets SET stamp = 'r1' WHERE run_id = $1 AND idx = 1`,
          [run],
        ),
      ).toEqual(raised("MCP_RUN_TARGET_STAMPED"));
      expect(
        await refusal(
          client,
          `UPDATE mcp_run_targets SET frozen_input = '{"id":"comment-1","x":1}' WHERE run_id = $1 AND idx = 1`,
          [run],
        ),
      ).toEqual(raised("MCP_RUN_TARGET_FROZEN"));
      // Outcomes move, and the input is cleared at the end.
      expect(
        await refusal(
          client,
          ...setTarget(
            run,
            "state = 'applied', code = NULL, attempted_at = now(), frozen_input = NULL",
          ),
        ),
      ).toBeNull();
    });
  });
});

describe("a seal and a target arriving at once", () => {
  // Committed rows, so two sessions see them; removed by the table owner afterwards.
  const committedRun = async () => {
    const client = await connect();
    try {
      const ai = (
        await client.query<{ id: number }>(
          "SELECT id FROM users WHERE email = $1",
          [ADMIN_MCP_OPERATOR_ROW_EMAIL],
        )
      ).rows[0]!.id;
      return await insertRun(client, ai);
    } finally {
      client.release();
    }
  };
  const remove = (run: string) =>
    pool.query("DELETE FROM mcp_runs WHERE run_id = $1", [run]);
  /** `blocked` in its own transaction, giving up on a lock after 300 ms. */
  const waits = async (text: string, values: readonly unknown[]) => {
    const client = await connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout = '300ms'");
      return await refusal(client, text, values);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  };

  it("holds the seal off while a target is being added, and the target off while a seal is", async () => {
    const run = await committedRun();
    const holder = await connect();
    try {
      await holder.query("BEGIN");
      await holder.query(...target(run, 0));
      expect(await waits(...seal(run, 0))).toMatchObject({ code: "55P03" });
      await holder.query("ROLLBACK");
      await holder.query("BEGIN");
      await holder.query(...seal(run, 0));
      expect(await waits(...target(run, 0))).toMatchObject({ code: "55P03" });
      await holder.query("ROLLBACK");
    } finally {
      holder.release();
      await remove(run);
    }
  });
});
