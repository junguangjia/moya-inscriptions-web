import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  AgentConnectionInvariantError,
  createAgentConnectionStore,
  createConsentStore,
} from "@moya/community-postgres";
import { beforeAll, describe, expect, it } from "vitest";

import type { StoredConnection } from "@moya/community-postgres";
import type { createPostgresPool } from "@moya/catalog-postgres";

/**
 * Agent Connections V1 (Issue #141 r15 §5) — the browser consent transaction.
 *
 * The property under test is not "a form posts". It is that an interaction
 * uid, which travels in a URL and proves nothing, only becomes a grant after
 * an authenticated human produced a secret this server rendered to THEM.
 *
 * The row has two writers and they are deliberately incapable of each other's
 * half: the provider states what it will enforce, the control plane states who
 * decided. The role cases at the end apply the REAL grant file rather than a
 * re-typed copy, because a grant plan only ever tested in paraphrase is a
 * grant plan nobody has tested.
 */
export const registerAgentConnectionConsentTests = (
  pool: ReturnType<typeof createPostgresPool>,
) => {
  describe("Agent connection consent transaction on PostgreSQL", () => {
    const connections = createAgentConnectionStore({ pool });
    const consents = createConsentStore({ pool });

    /**
     * Three FIXED names, reused on every run, and deliberately not dropped.
     *
     * The review that found the acceptance harness leaking roles was right
     * about the harness, which generated a NEW pair per run and accumulated
     * thirty. This suite is the other case: `grant-authorization.sql` creates
     * them `IF NOT EXISTS`, so the cluster holds exactly three however often
     * this runs.
     *
     * Dropping them from an `afterAll` was tried and reverted, for a reason
     * worth stating precisely because I first got it wrong: `DROP OWNED BY`
     * revokes privileges and takes locks across the WHOLE database while
     * vitest is still running other files against it, which is cluster-wide
     * surgery from inside one concurrent suite for no benefit here.
     *
     * I originally justified the revert by saying it had broken
     * `community-postgres.test.ts`'s setup. It had not. Running the suite
     * three times unchanged afterwards gave FAIL, PASS, PASS — that
     * foreign-key collision between one file's `public_users` delete and
     * another's receipts is an intermittent pre-existing race on this local
     * disposable database, and I had attributed it to my own change from a
     * single sample.
     */
    const providerRole = "moya_consent_case_provider";
    const consentRole = "moya_consent_case_consent";
    const resourceRole = "moya_consent_case_resource";

    const ticket = () => randomBytes(32).toString("hex");
    const digestOf = (value: string) =>
      createHash("sha256").update(value, "utf8").digest("hex");
    const uid = () => `int-${randomBytes(12).toString("hex")}`;
    const later = (ms: number) => new Date(Date.now() + ms).toISOString();

    /**
     * A client of its own per connection.
     *
     * One human holds at most ONE connection per registered client — migration
     * 20260921010000 is the index that says so — and this suite opens a
     * connection in most of its cases without dropping the earlier ones. A
     * fixed pair here would therefore be eleven rows the product can never
     * produce, and the first case to run would be the only one that could
     * open a connection at all.
     */
    const caseClientId = () =>
      `artvenn-consent-case-${randomBytes(6).toString("hex")}`;

    const openConnection = async (
      oauthClientId: string = caseClientId(),
    ): Promise<StoredConnection> => {
      const fields: StoredConnection = {
        id: `conn-${randomBytes(16).toString("hex")}`,
        principalLabel: "agent-consent-case",
        humanAccountId: "user-owner",
        client: "claude",
        oauthClientId,
        environment: "development",
        preset: "read-only",
        status: "awaiting-consent",
        generation: 0,
        revokedAt: null,
        consentedAt: null,
      };
      await connections.create(fields);
      return fields;
    };

    /** What the PROVIDER writes: the facts it will enforce, and no human. */
    // The default client is generated per call for the same reason
    // `openConnection`'s is: a fixed literal here would pair a consent for one
    // client with a connection opened for another wherever the two are not
    // threaded together through `armed()`.
    const providerFacts = (overrides: Record<string, unknown> = {}) => ({
      interactionUid: uid(),
      oauthClientId: caseClientId(),
      resource: "https://resource.invalid/mcp",
      capabilityScopes: ["artvenn:read"],
      protocolScopes: ["offline_access"],
      preset: "read-only" as const,
      expiresAt: later(5 * 60_000),
      ...overrides,
    });

    /**
     * The whole pre-decision sequence: the provider opens an interaction, then
     * the review page arms it with the human it authenticated, the connection,
     * and the digest of the ticket it handed that browser.
     */
    const armed = async (overrides: Record<string, unknown> = {}) => {
      const secret = ticket();
      // One client id for both halves: the consent the provider enforces and
      // the connection the review page attaches it to name the same client,
      // exactly as they do in the product.
      const client = caseClientId();
      // The injected client comes LAST on purpose: spreading `overrides` after
      // it would let a future `armed({ oauthClientId })` split the consent from
      // the connection this opens, and nothing in the suite compares them, so
      // the case would assert whatever it asserts for an unrelated reason.
      const facts = providerFacts({ ...overrides, oauthClientId: client });
      const connection = await openConnection(client);
      expect(await consents.open(facts)).not.toBeNull();
      const row = await consents.arm({
        interactionUid: facts.interactionUid,
        ticketDigest: digestOf(secret),
        connectionId: connection.id,
        humanAccountId: "user-owner",
      });
      return { secret, facts, connection, row };
    };

    beforeAll(async () => {
      const client = await pool.connect();
      try {
        await client.query("SELECT set_config($1,$2,false)", [
          "agent_connections.provider_role",
          providerRole,
        ]);
        await client.query("SELECT set_config($1,$2,false)", [
          "agent_connections.consent_role",
          consentRole,
        ]);
        await client.query("SELECT set_config($1,$2,false)", [
          "agent_connections.resource_role",
          resourceRole,
        ]);
        await client.query(
          await readFile(
            new URL(
              "../../../infra/development/agent-connections/grant-authorization.sql",
              import.meta.url,
            ),
            "utf8",
          ),
        );
      } finally {
        client.release();
      }
    });

    /** Runs one statement as `role`, transaction-scoped and always rolled back. */
    const asRole = async (
      role: string,
      statement: string,
      values: readonly unknown[] = [],
    ): Promise<{ ok: true } | { ok: false; sqlState: string }> => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(`SET LOCAL ROLE ${role}`);
        await client.query(statement, [...values]);
        return { ok: true };
      } catch (error) {
        return {
          ok: false,
          sqlState: String((error as { code?: unknown }).code ?? ""),
        };
      } finally {
        // Nothing a role case does is ever kept, including the successes.
        await client.query("ROLLBACK").catch(() => undefined);
        client.release();
      }
    };

    it("opens an interaction that names nobody, because the provider knows nobody", async () => {
      const facts = providerFacts();
      const opened = await consents.open(facts);
      expect(opened).toMatchObject({
        interactionUid: facts.interactionUid,
        oauthClientId: facts.oauthClientId,
        resource: facts.resource,
        // The provider cannot say who is consenting or about what, and the
        // row starts unable to express it.
        humanAccountId: null,
        connectionId: null,
        ticketArmed: false,
        decision: null,
      });
      // One set of enforced facts per uid: a second open changes nothing.
      expect(
        await consents.open({ ...facts, resource: "https://other.invalid" }),
      ).toBeNull();
      expect((await consents.read(facts.interactionUid))?.resource).toBe(
        facts.resource,
      );
    });

    it("turns an interaction into a decision only for the secret it rendered", async () => {
      const { secret, facts } = await armed();

      // A POST that cannot produce the ticket writes nothing at all.
      expect(
        await consents.decide({
          interactionUid: facts.interactionUid,
          ticketDigest: digestOf(ticket()),
          humanAccountId: "user-owner",
          decision: "approved",
          grantedGeneration: 1,
        }),
      ).toBeNull();

      // Nor does the right ticket in somebody else's hands.
      expect(
        await consents.decide({
          interactionUid: facts.interactionUid,
          ticketDigest: digestOf(secret),
          humanAccountId: "user-someone-else",
          decision: "approved",
          grantedGeneration: 1,
        }),
      ).toBeNull();

      const decided = await consents.decide({
        interactionUid: facts.interactionUid,
        ticketDigest: digestOf(secret),
        humanAccountId: "user-owner",
        decision: "approved",
        grantedGeneration: 1,
      });
      expect(decided?.decision).toBe("approved");
      expect(decided?.grantedGeneration).toBe(1);
      expect(decided?.decidedAt).not.toBeNull();

      // Single use. The second approval finds a decided row and writes nothing.
      expect(
        await consents.decide({
          interactionUid: facts.interactionUid,
          ticketDigest: digestOf(secret),
          humanAccountId: "user-owner",
          decision: "approved",
          grantedGeneration: 2,
        }),
      ).toBeNull();
      expect(
        (await consents.read(facts.interactionUid))?.grantedGeneration,
      ).toBe(1);
    });

    it("cannot be decided at all while it is unarmed", async () => {
      const facts = providerFacts();
      await consents.open(facts);
      expect(
        await consents.decide({
          interactionUid: facts.interactionUid,
          ticketDigest: digestOf(ticket()),
          humanAccountId: "user-owner",
          decision: "approved",
          grantedGeneration: 1,
        }),
      ).toBeNull();
      expect((await consents.read(facts.interactionUid))?.decision).toBeNull();
    });

    it("re-arms an undecided interaction, which kills the ticket it replaced", async () => {
      const { secret, facts, connection } = await armed();
      const second = ticket();
      expect(
        await consents.arm({
          interactionUid: facts.interactionUid,
          ticketDigest: digestOf(second),
          connectionId: connection.id,
          humanAccountId: "user-owner",
        }),
      ).not.toBeNull();

      // The page that was open first can no longer decide anything.
      expect(
        await consents.decide({
          interactionUid: facts.interactionUid,
          ticketDigest: digestOf(secret),
          humanAccountId: "user-owner",
          decision: "approved",
          grantedGeneration: 1,
        }),
      ).toBeNull();
      expect(
        await consents.decide({
          interactionUid: facts.interactionUid,
          ticketDigest: digestOf(second),
          humanAccountId: "user-owner",
          decision: "approved",
          grantedGeneration: 1,
        }),
      ).not.toBeNull();

      // And a decided interaction can never be re-armed.
      expect(
        await consents.arm({
          interactionUid: facts.interactionUid,
          ticketDigest: digestOf(ticket()),
          connectionId: connection.id,
          humanAccountId: "user-owner",
        }),
      ).toBeNull();
    });

    it("refuses an expired interaction, so an abandoned tab is not a standing permission", async () => {
      // Expiry is measured against the DATABASE clock, so the deadline is read
      // from it rather than from this process: a host whose clocks disagree
      // would otherwise make this pass or fail for the wrong reason. The
      // `expires_at > issued_at` CHECK also refuses an already-dead row, so
      // the interaction has to be opened alive and then actually expire.
      const { rows } = await pool.query(
        "SELECT CURRENT_TIMESTAMP + interval '300 milliseconds' AS deadline",
      );
      const { secret, facts } = await armed({
        expiresAt: (rows[0] as { deadline: Date }).deadline.toISOString(),
      });
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(
        await consents.decide({
          interactionUid: facts.interactionUid,
          ticketDigest: digestOf(secret),
          humanAccountId: "user-owner",
          decision: "approved",
          grantedGeneration: 1,
        }),
      ).toBeNull();
      // Nor can it be re-armed back to life.
      expect(
        await consents.arm({
          interactionUid: facts.interactionUid,
          ticketDigest: digestOf(ticket()),
          connectionId: (await openConnection()).id,
          humanAccountId: "user-owner",
        }),
      ).toBeNull();
    });

    it("spends an approved interaction exactly once and never resumes a denial", async () => {
      const approved = await armed();
      await consents.decide({
        interactionUid: approved.facts.interactionUid,
        ticketDigest: digestOf(approved.secret),
        humanAccountId: "user-owner",
        decision: "approved",
        grantedGeneration: 1,
      });
      const grantId = `grant-${randomBytes(8).toString("hex")}`;
      await pool.query(
        `INSERT INTO community.agent_connection_grants
           (grant_id, connection_id, generation_at_consent, oauth_client_id,
            human_subject, issuer, resource, preset_at_consent)
         VALUES ($1,$2,1,$3,'user-owner','https://auth.invalid',
                 'https://resource.invalid/mcp','read-only')`,
        [grantId, approved.connection.id, approved.facts.oauthClientId],
      );

      const resumed = await consents.resume({
        interactionUid: approved.facts.interactionUid,
        grantId,
      });
      expect(resumed?.grantId).toBe(grantId);
      expect(resumed?.resumedAt).not.toBeNull();
      // A replayed resume cannot produce a second grant from one consent.
      expect(
        await consents.resume({
          interactionUid: approved.facts.interactionUid,
          grantId,
        }),
      ).toBeNull();

      const denied = await armed();
      await consents.decide({
        interactionUid: denied.facts.interactionUid,
        ticketDigest: digestOf(denied.secret),
        humanAccountId: "user-owner",
        decision: "denied",
        grantedGeneration: null,
      });
      expect(
        await consents.resume({
          interactionUid: denied.facts.interactionUid,
          grantId,
        }),
      ).toBeNull();
    });

    it("refuses a management consent at the database, not in a branch a UI could skip", async () => {
      const refused = consents.open(providerFacts({ preset: "management" }));
      await expect(refused).rejects.toBeInstanceOf(
        AgentConnectionInvariantError,
      );
      await expect(refused).rejects.toThrow(
        "agent_connection_consents_reachable_presets",
      );
    });

    it("freezes what the provider will enforce, even against the table owner", async () => {
      const facts = providerFacts();
      await consents.open(facts);
      await expect(
        pool.query(
          `UPDATE community.agent_connection_consents
              SET oauth_client_id='a-different-client'
            WHERE interaction_uid=$1`,
          [facts.interactionUid],
        ),
      ).rejects.toMatchObject({ code: "23001" });
    });

    it("keeps a decided consent attributed to the identity it was decided under", async () => {
      const { secret, facts } = await armed();
      await consents.decide({
        interactionUid: facts.interactionUid,
        ticketDigest: digestOf(secret),
        humanAccountId: "user-owner",
        decision: "approved",
        grantedGeneration: 1,
      });
      await expect(
        pool.query(
          `UPDATE community.agent_connection_consents
              SET human_account_id='user-somebody-else'
            WHERE interaction_uid=$1`,
          [facts.interactionUid],
        ),
      ).rejects.toMatchObject({ code: "23001" });
    });

    describe("the grant file's own role split", () => {
      // 42501 is insufficient_privilege: PostgreSQL refusing, not this code.
      const denied = { ok: false, sqlState: "42501" };

      it("denies the provider role any way to say who consented", async () => {
        // An independent review found the hole this test was NAMED for and
        // did not cover: every statement here was an UPDATE, while the grant
        // was table-level INSERT. The provider could therefore write a row
        // with decision='approved' in the first place -- no UPDATE needed,
        // and the freeze trigger is BEFORE UPDATE so it never fired.
        // Measured on the live schema before the fix: INSERT 0 1, and the
        // row read back approved. The INSERT case below is the regression.
        const connection = await openConnection();
        for (const statement of [
          `UPDATE community.agent_connection_consents
              SET decision='approved', decided_at=CURRENT_TIMESTAMP,
                  granted_generation=1`,
          `UPDATE community.agent_connection_consents
              SET human_account_id='user-owner'`,
          `UPDATE community.agent_connection_consents SET connection_id=NULL`,
          `UPDATE community.agent_connection_consents SET ticket_digest=NULL`,
          `UPDATE community.agent_connection_consents SET resume_secret_digest=NULL`,
          // It reaps through the fixed function, never by a DELETE of its own.
          `DELETE FROM community.agent_connection_consents`,
        ])
          expect(await asRole(providerRole, statement)).toEqual(denied);

        // The whole forged-consent path, one column at a time. Each of these
        // is a column the provider must not be able to write AT ALL.
        for (const [column, value] of [
          ["decision", "'approved'"],
          ["decided_at", "CURRENT_TIMESTAMP"],
          ["granted_generation", "1"],
          ["ticket_digest", `'${"a".repeat(64)}'`],
          ["resume_secret_digest", `'${"a".repeat(64)}'`],
          ["human_account_id", "'user-owner'"],
          ["connection_id", `'${connection.id}'`],
          ["resumed_at", "CURRENT_TIMESTAMP"],
          ["grant_id", "'forged'"],
        ])
          expect(
            await asRole(
              providerRole,
              `INSERT INTO community.agent_connection_consents
                 (interaction_uid, oauth_client_id, resource, preset,
                  expires_at, ${column})
               VALUES ('forged-${column}', 'c', 'https://r.invalid',
                       'read-only', CURRENT_TIMESTAMP + interval '5 min',
                       ${value})`,
            ),
          ).toEqual(denied);

        // And the complete forgery, exactly as the review wrote it.
        expect(
          await asRole(
            providerRole,
            `INSERT INTO community.agent_connection_consents
               (interaction_uid, oauth_client_id, resource, capability_scopes,
                protocol_scopes, preset, expires_at, ticket_digest,
                human_account_id, connection_id, decided_at, decision,
                granted_generation)
             VALUES ('forged-whole', 'c', 'https://r.invalid',
                     '{artvenn:read}', '{}', 'read-only',
                     CURRENT_TIMESTAMP + interval '10 min', $1,
                     'user-owner', $2, CURRENT_TIMESTAMP, 'approved', 1)`,
            ["a".repeat(64), connection.id],
          ),
        ).toEqual(denied);
      });

      it("denies the consent role any way to mint a grant, a token or an interaction", async () => {
        for (const statement of [
          `UPDATE community.agent_connections SET current_grant_id='forged'`,
          // Same column, the INSERT form: a table-level INSERT let this role
          // create a connection already pointing at a grant it did not make.
          `INSERT INTO community.agent_connections
             (id, human_account_id, client_family, oauth_client_id,
              environment, principal_label, preset, status, current_grant_id)
           VALUES ('conn-${"c".repeat(32)}', 'user-owner', 'claude', 'c',
                   'development', 'agent-forged', 'read-only',
                   'awaiting-consent', 'forged')`,
          `INSERT INTO community.agent_connection_grants
             (grant_id, connection_id, generation_at_consent, oauth_client_id,
              human_subject, issuer, resource, preset_at_consent)
           VALUES ('forged','conn-x',1,'c','user-owner','https://a.invalid',
                   'https://r.invalid','read-only')`,
          `SELECT lookup_digest FROM community.agent_connection_wrappers LIMIT 1`,
          `UPDATE community.agent_connection_consents
              SET resumed_at=CURRENT_TIMESTAMP`,
          `SELECT community.agent_connection_consents_reap(1)`,
          // It cannot conjure an authorization request nobody made.
          `INSERT INTO community.agent_connection_consents
             (interaction_uid, oauth_client_id, resource, preset, expires_at)
           VALUES ('forged','c','https://r.invalid','read-only',
                   CURRENT_TIMESTAMP + interval '5 min')`,
        ])
          expect(await asRole(consentRole, statement)).toEqual(denied);
      });

      it("denies the resource role everything except reading and one stamp", async () => {
        // The boundary that authenticates MCP requests decides nothing about
        // authority. Until this run it was described in a comment and wired
        // to the database owner, which is how a table-level INSERT on the
        // consent table survived a review of the role split.
        for (const statement of [
          `UPDATE community.agent_connections SET status='revoked'`,
          `UPDATE community.agent_connections SET generation=generation+1`,
          `UPDATE community.agent_connections SET current_grant_id='forged'`,
          `INSERT INTO community.agent_connection_grants
             (grant_id, connection_id, generation_at_consent, oauth_client_id,
              human_subject, issuer, resource, preset_at_consent)
           VALUES ('forged','conn-x',1,'c','user-owner','https://a.invalid',
                   'https://r.invalid','read-only')`,
          `UPDATE community.agent_connection_wrappers SET invalidated_at=NULL`,
          `SELECT interaction_uid FROM community.agent_connection_consents LIMIT 1`,
          `SELECT 1 FROM community.agent_connection_provider_artifacts LIMIT 1`,
          `SELECT community.agent_connection_consents_reap(1)`,
        ])
          expect(await asRole(resourceRole, statement)).toEqual(denied);

        // The positives: it can read what it authenticates against, and stamp
        // the one column the page shows as an observation.
        const connection = await openConnection();
        for (const statement of [
          `SELECT id FROM community.agent_connections LIMIT 1`,
          `SELECT grant_id FROM community.agent_connection_grants LIMIT 1`,
          `SELECT lookup_digest FROM community.agent_connection_wrappers LIMIT 1`,
        ])
          expect(await asRole(resourceRole, statement)).toEqual({ ok: true });
        expect(
          await asRole(
            resourceRole,
            `UPDATE community.agent_connections SET last_verified_at=CURRENT_TIMESTAMP
              WHERE id=$1`,
            [connection.id],
          ),
        ).toEqual({ ok: true });
      });

      it("cannot move a connection out of its owner's reach, even holding the column", async () => {
        // A consequence of the F1 fix that an independent review caught: the
        // consent role's UPDATE list had to grow to thirteen columns because
        // `compareAndSet` round-trips the whole consented shape, and four of
        // the new ones had no backstop.
        //
        // `human_account_id` is the worst of them. It is the ONLY key the
        // Owner's disconnect is scoped by, and authentication reads identity
        // from the FROZEN grant — so moving it would not break a single
        // request. It would produce a live, authenticating connection that had
        // vanished from its owner's page and from their disconnect scope: a
        // token the human who consented can no longer revoke.
        const connection = await openConnection();
        for (const [column, value] of [
          ["human_account_id", "'user-somebody-else'"],
          ["oauth_client_id", "'a-different-client'"],
          ["client_family", "'codex'"],
          ["environment", "'production'"],
        ])
          expect(
            await asRole(
              consentRole,
              `UPDATE community.agent_connections SET ${column}=${value}
                WHERE id=$1`,
              [connection.id],
            ),
          ).toEqual({ ok: false, sqlState: "23001" });

        // 23001, not 42501: the role DOES hold these columns, and the trigger
        // is what refuses. That distinction is the finding — a test asserting
        // a bare refusal would have passed before the freeze existed.
        // Meanwhile a real transition still works.
        expect(
          await asRole(
            consentRole,
            `UPDATE community.agent_connections
                SET status='authorized', generation=generation+1,
                    consented_at=CURRENT_TIMESTAMP, version=version+1
              WHERE id=$1`,
            [connection.id],
          ),
        ).toEqual({ ok: true });
      });

      it("grants each role exactly the half it needs, so neither is merely locked out", async () => {
        // The negative controls above are only meaningful if the positives
        // work: a role denied everything would pass all of them.
        const connection = await openConnection();
        const facts = providerFacts();
        expect(
          await asRole(
            providerRole,
            `INSERT INTO community.agent_connection_consents
               (interaction_uid, oauth_client_id, resource, preset, expires_at)
             VALUES ($1,$2,$3,'read-only',
                     CURRENT_TIMESTAMP + interval '5 min')`,
            [facts.interactionUid, facts.oauthClientId, facts.resource],
          ),
        ).toEqual({ ok: true });

        await consents.open(facts);
        expect(
          await asRole(
            consentRole,
            `UPDATE community.agent_connection_consents
                SET ticket_digest=$2, human_account_id='user-owner',
                    connection_id=$3
              WHERE interaction_uid=$1`,
            [facts.interactionUid, digestOf(ticket()), connection.id],
          ),
        ).toEqual({ ok: true });
        expect(
          await asRole(
            providerRole,
            `SELECT interaction_uid FROM community.agent_connection_consents
              WHERE interaction_uid=$1`,
            [facts.interactionUid],
          ),
        ).toEqual({ ok: true });
        // The digest with the decision is the consent role's to write, and the
        // provider's to read and compare.
        expect(
          await asRole(
            consentRole,
            `UPDATE community.agent_connection_consents
                SET ticket_digest=$2, human_account_id='user-owner',
                    connection_id=$3, decision='approved',
                    decided_at=CURRENT_TIMESTAMP, granted_generation=1,
                    resume_secret_digest=$4
              WHERE interaction_uid=$1`,
            [
              facts.interactionUid,
              digestOf(ticket()),
              connection.id,
              digestOf(ticket()),
            ],
          ),
        ).toEqual({ ok: true });
        expect(
          await asRole(
            providerRole,
            `SELECT resume_secret_digest
               FROM community.agent_connection_consents
              WHERE interaction_uid=$1`,
            [facts.interactionUid],
          ),
        ).toEqual({ ok: true });
        expect(
          await asRole(
            providerRole,
            `SELECT community.agent_connection_consents_reap(1)`,
          ),
        ).toEqual({ ok: true });
        expect(
          await asRole(
            providerRole,
            `UPDATE community.agent_connections SET current_grant_id=NULL
              WHERE id=$1`,
            [connection.id],
          ),
        ).toEqual({ ok: true });
      });
    });
  });
};
