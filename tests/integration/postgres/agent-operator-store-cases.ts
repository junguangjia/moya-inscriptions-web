import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import http from "node:http";

import {
  closePostgresPool,
  createPostgresPool,
  parsePostgresConfig,
} from "@moya/catalog-postgres";
import {
  AgentConnectionInvariantError,
  AgentConnectionRowError,
  createAgentConnectionStore,
  createConsentStore,
  createProviderAdapter,
  digestResumeSecret,
  isResumeSecret,
  mintResumeSecret,
  parseConnectionRow,
  parseConsentRow,
  parseGrantRow,
  providerAdapterKeysFrom,
  verifyCommunityMigrationLedger,
} from "@moya/community-postgres";
import { beforeAll, describe, expect, it } from "vitest";

import { requireSyntheticTestDatabaseUrl } from "./synthetic-test-database.js";

import type { StoredConnection } from "@moya/community-postgres";

/**
 * Issue #355, login door, slice O1: the stores under the Admin issuer.
 *
 * Every row here is seeded by the case that reads it, with fresh ids, so the
 * file passes alone on an empty database and on a used one. The role cases run
 * the REAL grant file and the REAL store methods as those roles, because a grant
 * plan only ever tested in paraphrase is a grant plan nobody has tested.
 */
export const registerAgentOperatorStoreTests = (
  pool: ReturnType<typeof createPostgresPool>,
) => {
  describe("Admin OAuth issuer stores on PostgreSQL", () => {
    type Queryable = Parameters<typeof createConsentStore>[0]["pool"];

    const connections = createAgentConnectionStore({ pool });
    const consents = createConsentStore({ pool });

    const hex = (bytes: number) => randomBytes(bytes).toString("hex");
    const digestOf = (value: string) =>
      createHash("sha256").update(value, "utf8").digest("hex");
    const uid = () => `int-${hex(12)}`;
    const clientId = () => `https://tool-${hex(6)}.invalid/client.json`;
    const later = (ms: number) => new Date(Date.now() + ms).toISOString();
    const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

    /** Fresh per call: one human and one client hold one connection. */
    const connectionFields = (
      overrides: Partial<StoredConnection> = {},
    ): StoredConnection => ({
      id: `conn-${hex(16)}`,
      principalLabel: `agent-operator-${hex(6)}`,
      humanAccountId: `owner-${hex(4)}`,
      client: "claude",
      oauthClientId: clientId(),
      environment: "development",
      preset: "operator",
      status: "awaiting-consent",
      generation: 0,
      revokedAt: null,
      consentedAt: null,
      ...overrides,
    });

    const openConnection = async (
      overrides: Partial<StoredConnection> = {},
    ): Promise<StoredConnection> => {
      const fields = connectionFields(overrides);
      expect(await connections.create(fields)).not.toBeNull();
      return fields;
    };

    /** Written through the owner, because this case is about what reads it. */
    const addGrant = async (
      connection: StoredConnection,
      generationAtConsent: number,
    ): Promise<string> => {
      const grantId = `grant-${hex(12)}`;
      expect(
        await connections.createGrant({
          grantId,
          connectionId: connection.id,
          generationAtConsent,
          oauthClientId: connection.oauthClientId,
          humanSubject: connection.humanAccountId,
          issuer: "https://issuer.invalid",
          resource: "https://resource.invalid/api/mcp",
          capabilityScopes: ["artvenn:admin"],
          protocolScopes: ["offline_access"],
          presetAtConsent: "operator",
        }),
      ).toBe(true);
      return grantId;
    };

    /** One operator interaction, armed, up to the moment of the decision. */
    const armedOperator = async (
      overrides: { readonly preset?: "operator" | "read-only" } = {},
    ) => {
      const ticket = hex(32);
      const connection = await openConnection();
      const interactionUid = uid();
      expect(
        await consents.open({
          interactionUid,
          oauthClientId: connection.oauthClientId,
          resource: "https://resource.invalid/api/mcp",
          capabilityScopes: ["artvenn:admin"],
          protocolScopes: ["offline_access"],
          preset: overrides.preset ?? "operator",
          expiresAt: later(5 * 60_000),
        }),
      ).not.toBeNull();
      expect(
        await consents.arm({
          interactionUid,
          ticketDigest: digestOf(ticket),
          connectionId: connection.id,
          humanAccountId: connection.humanAccountId,
        }),
      ).not.toBeNull();
      return { interactionUid, ticket, connection };
    };

    const approve = async (
      armed: Awaited<ReturnType<typeof armedOperator>>,
    ) => {
      const { secret, digest } = mintResumeSecret();
      const decided = await consents.decide({
        interactionUid: armed.interactionUid,
        ticketDigest: digestOf(armed.ticket),
        humanAccountId: armed.connection.humanAccountId,
        decision: "approved",
        grantedGeneration: 1,
        resumeSecretDigest: digest,
      });
      expect(decided).not.toBeNull();
      return { secret, digest, decided };
    };

    describe("the operator preset", () => {
      it("round-trips on a connection, a grant and a consent", async () => {
        const connection = await openConnection();
        expect((await connections.read(connection.id))?.connection.preset).toBe(
          "operator",
        );
        const grantId = await addGrant(connection, 1);
        expect((await connections.readGrant(grantId))?.presetAtConsent).toBe(
          "operator",
        );
        const { interactionUid } = await armedOperator();
        expect((await consents.read(interactionUid))?.preset).toBe("operator");
      });

      it("keeps management unreachable on a consent, under the new check's name", async () => {
        const opened = consents.open({
          interactionUid: uid(),
          oauthClientId: clientId(),
          resource: "https://resource.invalid/api/mcp",
          capabilityScopes: ["artvenn:manage"],
          protocolScopes: [],
          preset: "management",
          expiresAt: later(60_000),
        });
        await expect(opened).rejects.toBeInstanceOf(
          AgentConnectionInvariantError,
        );
        await expect(opened).rejects.toThrow(
          "agent_connection_consents_reachable_presets",
        );
      });

      it("refuses any other value on all three tables", async () => {
        const connection = await openConnection();
        for (const [statement, values, constraint] of [
          [
            `UPDATE community.agent_connections SET preset='admin' WHERE id=$1`,
            [connection.id],
            "agent_connections_preset_check",
          ],
          [
            `INSERT INTO community.agent_connection_grants
               (grant_id, connection_id, generation_at_consent, oauth_client_id,
                human_subject, issuer, resource, preset_at_consent)
             VALUES ($1,$2,1,'c','h','https://a.invalid','https://r.invalid','admin')`,
            [`grant-${hex(8)}`, connection.id],
            "agent_connection_grants_preset_at_consent_check",
          ],
          [
            `INSERT INTO community.agent_connection_consents
               (interaction_uid, oauth_client_id, resource, preset, expires_at)
             VALUES ($1,'c','https://r.invalid','admin',
                     CURRENT_TIMESTAMP + interval '5 min')`,
            [uid()],
            "agent_connection_consents_preset_check",
          ],
        ] as const)
          await expect(
            pool.query(statement, [...values]),
          ).rejects.toMatchObject({ code: "23514", constraint });
      });

      it("parses the new value and still refuses an unknown one", () => {
        const row = {
          id: "conn-x",
          principal_label: "agent-operator",
          human_account_id: "owner",
          client_family: "claude-code",
          oauth_client_id: "c",
          environment: "production",
          status: "authorized",
          generation: "1",
          version: "1",
          revoked_at: null,
          consented_at: new Date(),
        };
        expect(
          parseConnectionRow({ ...row, preset: "operator" }).connection.preset,
        ).toBe("operator");
        expect(() => parseConnectionRow({ ...row, preset: "owner" })).toThrow(
          AgentConnectionRowError,
        );
        const grant = {
          grant_id: "g",
          connection_id: "conn-x",
          generation_at_consent: "1",
          oauth_client_id: "c",
          human_subject: "owner",
          issuer: "https://a.invalid",
          resource: "https://r.invalid",
          capability_scopes: [],
          protocol_scopes: [],
          consented_at: new Date(),
          destroy_status: "not-requested",
          destroyed_at: null,
        };
        expect(
          parseGrantRow({ ...grant, preset_at_consent: "operator" })
            .presetAtConsent,
        ).toBe("operator");
        expect(() =>
          parseGrantRow({ ...grant, preset_at_consent: "owner" }),
        ).toThrow(AgentConnectionRowError);
      });
    });

    describe("listAuthorized", () => {
      // Far ahead, so a used database's own rows cannot push these past the
      // list's bound, and the order is this case's to assert.
      const consented = (day: number) => `2099-01-0${day}T00:00:00.000Z`;

      const authorized = (day: number, overrides = {}) =>
        openConnection({
          status: "authorized",
          generation: 1,
          consentedAt: consented(day),
          ...overrides,
        });

      const pointAt = async (connection: StoredConnection, grantId: string) =>
        expect(
          await connections.setCurrentGrant(
            connection.id,
            grantId,
            connection.generation,
          ),
        ).toBe(true);

      const listedIds = async () =>
        (await connections.listAuthorized()).map(
          ({ connection }) => connection.id,
        );

      it("lists every person's live connection, newest consent first", async () => {
        const first = await authorized(1);
        const second = await authorized(2);
        await pointAt(first, await addGrant(first, 1));
        const secondGrant = await addGrant(second, 1);
        await pointAt(second, secondGrant);
        expect(first.humanAccountId).not.toBe(second.humanAccountId);

        const listed = await connections.listAuthorized();
        const ids = listed.map(({ connection }) => connection.id);
        expect(ids).toContain(first.id);
        expect(ids.indexOf(second.id)).toBeLessThan(ids.indexOf(first.id));
        expect(
          listed.find(({ connection }) => connection.id === second.id),
        ).toMatchObject({
          connection: {
            humanAccountId: second.humanAccountId,
            oauthClientId: second.oauthClientId,
            preset: "operator",
            consentedAt: consented(2),
          },
          currentGrantId: secondGrant,
          lastVerifiedAt: null,
        });
      });

      it("omits an allow that never reached a grant, because no token stands behind it", async () => {
        // decideConsent raises the generation and sets `authorized` before the
        // browser resumes, so a voided or abandoned allow looks like this.
        const never = await authorized(1);
        const abandoned = await authorized(1, { generation: 2 });
        await pointAt(
          { ...abandoned, generation: 2 },
          await addGrant(abandoned, 2),
        );
        expect(await listedIds()).toContain(abandoned.id);
        // The next allow moves the generation, and its browser never comes back.
        const moved = await connections.read(abandoned.id);
        expect(
          await connections.compareAndSet(abandoned.id, moved?.version ?? 0, {
            ...abandoned,
            generation: 3,
          }),
        ).not.toBeNull();

        const ids = await listedIds();
        expect(ids).not.toContain(never.id);
        expect(ids).not.toContain(abandoned.id);

        // Its resume lands, and it is a connection again.
        await pointAt(
          { ...abandoned, generation: 3 },
          await addGrant(abandoned, 3),
        );
        expect(await listedIds()).toContain(abandoned.id);
      });

      it("omits a connection past the hard limit from its grant's consent, as the door does", async () => {
        // A grant is an immutable snapshot, so an old consent is written as one.
        const grantedAgo = async (
          connection: StoredConnection,
          days: number,
        ) => {
          const grantId = `grant-${hex(12)}`;
          await pool.query(
            `INSERT INTO community.agent_connection_grants
               (grant_id, connection_id, generation_at_consent, oauth_client_id,
                human_subject, issuer, resource, preset_at_consent, consented_at)
             VALUES ($1,$2,1,$3,$4,'https://issuer.invalid',
                     'https://resource.invalid/api/mcp','operator',
                     CURRENT_TIMESTAMP - make_interval(days => $5))`,
            [
              grantId,
              connection.id,
              connection.oauthClientId,
              connection.humanAccountId,
              days,
            ],
          );
          await pointAt(connection, grantId);
        };
        const expired = await authorized(1);
        const live = await authorized(1);
        await grantedAgo(expired, 181);
        await grantedAgo(live, 179);
        const ids = await listedIds();
        expect(ids).not.toContain(expired.id);
        expect(ids).toContain(live.id);
      });

      it("omits a connection awaiting consent and a revoked one", async () => {
        const waiting = await openConnection();
        expect(await listedIds()).not.toContain(waiting.id);
        // A disconnect raises the generation. At the same generation the status
        // alone has to keep the row off the list, so both are pinned.
        for (const generation of [2, 1]) {
          const revoked = await authorized(1);
          await pointAt(revoked, await addGrant(revoked, 1));
          expect(await listedIds()).toContain(revoked.id);
          const stored = await connections.read(revoked.id);
          expect(
            await connections.compareAndSet(revoked.id, stored?.version ?? 0, {
              ...revoked,
              status: "revoked",
              revokedAt: new Date().toISOString(),
              generation,
            }),
          ).not.toBeNull();
          expect(await listedIds()).not.toContain(revoked.id);
        }
      });
    });

    describe("markVerified", () => {
      const stamp = async (id: string): Promise<Date | null> => {
        const { rows } = await pool.query(
          "SELECT last_verified_at FROM community.agent_connections WHERE id=$1",
          [id],
        );
        return (rows[0] as { last_verified_at: Date | null }).last_verified_at;
      };

      it("stamps once a minute, and leaves the row alone in between", async () => {
        const { id } = await openConnection();
        expect(await connections.markVerified(id)).toBe(true);
        const first = await stamp(id);
        expect(first).not.toBeNull();
        expect(await connections.markVerified(id)).toBe(false);
        expect(await stamp(id)).toEqual(first);
      });

      it("stamps again once the minute has passed, whatever the version", async () => {
        const { id } = await openConnection();
        await pool.query(
          `UPDATE community.agent_connections
              SET last_verified_at=CURRENT_TIMESTAMP - interval '61 seconds'
            WHERE id=$1`,
          [id],
        );
        const stale = await stamp(id);
        const version = (await connections.read(id))?.version;
        expect(await connections.markVerified(id)).toBe(true);
        expect((await stamp(id))?.getTime()).toBeGreaterThan(
          stale?.getTime() ?? 0,
        );
        // An observation must not make a lifecycle compare-and-set lose.
        expect((await connections.read(id))?.version).toBe(version);
      });

      it("answers false for a connection that is not there", async () => {
        expect(await connections.markVerified(`conn-${hex(16)}`)).toBe(false);
      });
    });

    describe("the one-time resume secret", () => {
      it("mints a secret that travels in a URL, and stores nothing of it", async () => {
        const one = mintResumeSecret();
        const two = mintResumeSecret();
        expect(isResumeSecret(one.secret)).toBe(true);
        expect(encodeURIComponent(one.secret)).toBe(one.secret);
        expect(one.secret).not.toBe(two.secret);
        expect(one.digest).toBe(digestResumeSecret(one.secret));
        expect(one.digest).toBe(digestOf(one.secret));
        for (const malformed of ["", "short", `${one.secret}=`, 1, null])
          expect(isResumeSecret(malformed)).toBe(false);

        const armed = await armedOperator();
        const { secret, digest, decided } = await approve(armed);
        expect(decided).toMatchObject({
          decision: "approved",
          resumeSecretArmed: true,
          resumedAt: null,
        });
        // Presence, never the value.
        expect(JSON.stringify(decided)).not.toContain(digest);
        const { rows } = await pool.query(
          `SELECT row_to_json(c)::text AS whole
             FROM community.agent_connection_consents c
            WHERE interaction_uid=$1`,
          [armed.interactionUid],
        );
        expect((rows[0] as { whole: string }).whole).not.toContain(secret);
      });

      it("refuses an operator approval with no secret, and leaves it undecided", async () => {
        const armed = await armedOperator();
        const approval = {
          interactionUid: armed.interactionUid,
          ticketDigest: digestOf(armed.ticket),
          humanAccountId: armed.connection.humanAccountId,
          decision: "approved" as const,
          grantedGeneration: 1,
        };
        const refused = consents.decide(approval);
        await expect(refused).rejects.toBeInstanceOf(
          AgentConnectionInvariantError,
        );
        await expect(refused).rejects.toThrow(
          "agent_connection_consents_operator_approval_has_resume_secret",
        );
        expect(await consents.read(armed.interactionUid)).toMatchObject({
          decision: null,
          resumeSecretArmed: false,
        });
        // The ticket was not spent by the refusal.
        const { digest } = mintResumeSecret();
        expect(
          await consents.decide({ ...approval, resumeSecretDigest: digest }),
        ).toMatchObject({ decision: "approved", resumeSecretArmed: true });
      });

      it("lets a denial go without one, and refuses a denial carrying one", async () => {
        const armed = await armedOperator();
        const denial = {
          interactionUid: armed.interactionUid,
          ticketDigest: digestOf(armed.ticket),
          humanAccountId: armed.connection.humanAccountId,
          decision: "denied" as const,
          grantedGeneration: null,
        };
        await expect(
          consents.decide({
            ...denial,
            resumeSecretDigest: mintResumeSecret().digest,
          }),
        ).rejects.toMatchObject({ code: "RESUME_SECRET_WITHOUT_APPROVAL" });
        expect(await consents.decide(denial)).toMatchObject({
          decision: "denied",
          resumeSecretArmed: false,
        });
      });

      it("refuses a malformed digest before it reaches the database", async () => {
        const armed = await armedOperator();
        await expect(
          consents.decide({
            interactionUid: armed.interactionUid,
            ticketDigest: digestOf(armed.ticket),
            humanAccountId: armed.connection.humanAccountId,
            decision: "approved",
            grantedGeneration: 1,
            resumeSecretDigest: "not-a-digest",
          }),
        ).rejects.toMatchObject({ code: "MALFORMED" });
      });

      it("refuses a resume mark on an undecided row, which the older check let through", async () => {
        const undecided = await armedOperator();
        await expect(
          pool.query(
            `UPDATE community.agent_connection_consents
                SET resumed_at=CURRENT_TIMESTAMP WHERE interaction_uid=$1`,
            [undecided.interactionUid],
          ),
        ).rejects.toMatchObject({
          code: "23514",
          constraint: "agent_connection_consents_resume_follows_decision",
        });
      });

      it("keeps the column out of reach before the decision and after it, even for the owner", async () => {
        const write = (interactionUid: string, value: string) =>
          pool.query(
            `UPDATE community.agent_connection_consents
                SET resume_secret_digest=$2 WHERE interaction_uid=$1`,
            [interactionUid, value],
          );
        const undecided = await armedOperator();
        await expect(
          write(undecided.interactionUid, mintResumeSecret().digest),
        ).rejects.toMatchObject({
          code: "23514",
          constraint:
            "agent_connection_consents_resume_secret_follows_approval",
        });

        // Swapping it would hand the approval to a browser that never clicked.
        const approved = await armedOperator();
        await approve(approved);
        await expect(
          write(approved.interactionUid, mintResumeSecret().digest),
        ).rejects.toMatchObject({ code: "23001" });

        const denied = await armedOperator();
        await consents.decide({
          interactionUid: denied.interactionUid,
          ticketDigest: digestOf(denied.ticket),
          humanAccountId: denied.connection.humanAccountId,
          decision: "denied",
          grantedGeneration: null,
        });
        await expect(
          write(denied.interactionUid, mintResumeSecret().digest),
        ).rejects.toMatchObject({ code: "23001" });
      });

      it("answers only for the secret the approval stored", async () => {
        const armed = await armedOperator();
        const { digest } = await approve(armed);
        expect(
          await consents.resumeSecretMatches(armed.interactionUid, digest),
        ).toBe(true);
        expect(
          await consents.resumeSecretMatches(
            armed.interactionUid,
            mintResumeSecret().digest,
          ),
        ).toBe(false);
        expect(await consents.resumeSecretMatches(uid(), digest)).toBe(false);
        // An undecided row has none to match.
        const undecided = await armedOperator();
        expect(
          await consents.resumeSecretMatches(undecided.interactionUid, digest),
        ).toBe(false);
      });

      it("never resumes an operator approval without its secret", async () => {
        const armed = await armedOperator();
        const { digest } = await approve(armed);
        const grantId = `grant-${hex(8)}`;
        const interaction = { interactionUid: armed.interactionUid, grantId };
        for (const attempt of [
          interaction,
          { ...interaction, resumeSecretDigest: null },
          { ...interaction, resumeSecretDigest: mintResumeSecret().digest },
        ])
          expect(await consents.resume(attempt)).toBeNull();
        expect(await consents.read(armed.interactionUid)).toMatchObject({
          resumedAt: null,
          grantId: null,
        });

        const spent = await consents.resume({
          interactionUid: armed.interactionUid,
          grantId,
          resumeSecretDigest: digest,
        });
        expect(spent?.grantId).toBe(grantId);
        expect(spent?.resumedAt).not.toBeNull();
        // Once.
        expect(
          await consents.resume({
            interactionUid: armed.interactionUid,
            grantId: `grant-${hex(8)}`,
            resumeSecretDigest: digest,
          }),
        ).toBeNull();
      });

      it("voids an approval for the real secret alone, and nothing can finish it afterwards", async () => {
        const armed = await armedOperator();
        const { digest } = await approve(armed);
        // A stranger guessing at a uid changes nothing.
        expect(
          await consents.voidResume({
            interactionUid: armed.interactionUid,
            resumeSecretDigest: mintResumeSecret().digest,
          }),
        ).toBeNull();
        expect(
          (await consents.read(armed.interactionUid))?.resumedAt,
        ).toBeNull();

        const voided = await consents.voidResume({
          interactionUid: armed.interactionUid,
          resumeSecretDigest: digest,
        });
        expect(voided?.resumedAt).not.toBeNull();
        // Spent with no grant, and who clicked stays on the row.
        expect(voided?.grantId).toBeNull();
        expect(voided?.humanAccountId).toBe(armed.connection.humanAccountId);

        // The browser with the cookie now finds it spent, secret or no secret.
        expect(
          await consents.resume({
            interactionUid: armed.interactionUid,
            grantId: `grant-${hex(8)}`,
            resumeSecretDigest: digest,
          }),
        ).toBeNull();
        expect(
          await consents.voidResume({
            interactionUid: armed.interactionUid,
            resumeSecretDigest: digest,
          }),
        ).toBeNull();
      });

      it("cannot void a resumed interaction, so a real grant keeps its record", async () => {
        const armed = await armedOperator();
        const { digest } = await approve(armed);
        const grantId = `grant-${hex(8)}`;
        await consents.resume({
          interactionUid: armed.interactionUid,
          grantId,
          resumeSecretDigest: digest,
        });
        expect(
          await consents.voidResume({
            interactionUid: armed.interactionUid,
            resumeSecretDigest: digest,
          }),
        ).toBeNull();
        expect((await consents.read(armed.interactionUid))?.grantId).toBe(
          grantId,
        );
      });

      it("keeps a read-only approval resuming as it did before there was a secret", async () => {
        const armed = await armedOperator({ preset: "read-only" });
        const decided = await consents.decide({
          interactionUid: armed.interactionUid,
          ticketDigest: digestOf(armed.ticket),
          humanAccountId: armed.connection.humanAccountId,
          decision: "approved",
          grantedGeneration: 1,
        });
        expect(decided?.resumeSecretArmed).toBe(false);
        // Having no secret is not a secret anyone can name.
        expect(
          await consents.resume({
            interactionUid: armed.interactionUid,
            grantId: `grant-${hex(8)}`,
            resumeSecretDigest: mintResumeSecret().digest,
          }),
        ).toBeNull();
        expect(
          (
            await consents.resume({
              interactionUid: armed.interactionUid,
              grantId: `grant-${hex(8)}`,
            })
          )?.resumedAt,
        ).not.toBeNull();
      });

      it("refuses a row that escaped the constraints when it reads one back", () => {
        const row = {
          interaction_uid: "int-x",
          ticket_armed: true,
          connection_id: "conn-x",
          human_account_id: "owner",
          oauth_client_id: "c",
          resource: "https://r.invalid",
          capability_scopes: [],
          protocol_scopes: [],
          preset: "operator",
          granted_generation: "1",
          issued_at: new Date(),
          expires_at: new Date(),
          decided_at: new Date(),
          decision: "approved",
          resumed_at: null,
          grant_id: null,
        };
        expect(
          parseConsentRow({ ...row, resume_secret_armed: true })
            .resumeSecretArmed,
        ).toBe(true);
        for (const [escaped, code] of [
          [
            { ...row, resume_secret_armed: false },
            "OPERATOR_APPROVAL_WITHOUT_RESUME_SECRET",
          ],
          [{ ...row }, "NOT_A_BOOLEAN"],
          [
            {
              ...row,
              decision: null,
              decided_at: null,
              granted_generation: null,
              resume_secret_armed: true,
            },
            "RESUME_SECRET_WITHOUT_APPROVAL",
          ],
        ] as const)
          expect(() => parseConsentRow(escaped)).toThrow(
            expect.objectContaining({ code }),
          );
      });
    });

    describe("the consent reaper", () => {
      const DAY = 24 * 60 * 60_000;
      const HOUR = 60 * 60_000;

      /** Past deadlines cannot be reached through the store, so INSERT directly. */
      const seed = async (
        expiresAt: string,
        decided?: {
          readonly connection: StoredConnection;
          readonly decision: "approved" | "denied";
          readonly resumed?: boolean;
        },
      ): Promise<string> => {
        const interactionUid = uid();
        await pool.query(
          `INSERT INTO community.agent_connection_consents
             (interaction_uid, oauth_client_id, resource, preset, issued_at,
              expires_at, ticket_digest, human_account_id, connection_id,
              decision, decided_at, granted_generation, resume_secret_digest,
              resumed_at, grant_id)
           VALUES ($1,'c','https://r.invalid','operator',$2,$3,$4,$5,$6,$7,$8,$9,
                   $10,$11,$12)`,
          [
            interactionUid,
            new Date(Date.parse(expiresAt) - 30 * 60_000).toISOString(),
            expiresAt,
            decided === undefined ? null : digestOf(hex(32)),
            decided?.connection.humanAccountId ?? null,
            decided?.connection.id ?? null,
            decided?.decision ?? null,
            decided === undefined ? null : expiresAt,
            decided?.decision === "approved" ? 1 : null,
            decided?.decision === "approved" ? digestOf(hex(32)) : null,
            decided?.resumed === true ? expiresAt : null,
            decided?.resumed === true ? `grant-${hex(8)}` : null,
          ],
        );
        return interactionUid;
      };

      const exists = async (interactionUid: string) =>
        (await consents.read(interactionUid)) !== null;

      it("removes only rows nobody decided, more than a day past their deadline", async () => {
        const connection = await openConnection();
        const doomed = await seed(ago(DAY + HOUR));
        const armedDoomed = await seed(ago(DAY + HOUR));
        const armed = await armedOperator();
        await pool.query(
          `UPDATE community.agent_connection_consents
              SET ticket_digest=$2 WHERE interaction_uid=$1`,
          [armedDoomed, digestOf(hex(32))],
        );
        const kept = [
          // Expired, but still inside the day.
          await seed(ago(DAY - HOUR)),
          // Live, armed and undecided.
          armed.interactionUid,
          // Decided rows are the ledger, however old.
          await seed(ago(90 * DAY), { connection, decision: "approved" }),
          await seed(ago(90 * DAY), { connection, decision: "denied" }),
          await seed(ago(90 * DAY), {
            connection,
            decision: "approved",
            resumed: true,
          }),
        ];

        expect(await consents.reapExpired()).toBeGreaterThanOrEqual(2);
        expect(await exists(doomed)).toBe(false);
        expect(await exists(armedDoomed)).toBe(false);
        for (const interactionUid of kept)
          expect(await exists(interactionUid)).toBe(true);
      });

      it("takes no more than it is asked to", async () => {
        // Whatever an earlier run left, so the counts below are this case's own.
        while ((await consents.reapExpired(10_000)) > 0);
        for (let index = 0; index < 3; index += 1) await seed(ago(2 * DAY));
        expect(await consents.reapExpired(2)).toBe(2);
        expect(await consents.reapExpired(2)).toBe(1);
        expect(await consents.reapExpired(2)).toBe(0);
      });

      it("refuses a bound outside its range by name, and removes nothing", async () => {
        const doomed = await seed(ago(2 * DAY));
        for (const bound of [0, -1, 10_001])
          await expect(consents.reapExpired(bound)).rejects.toMatchObject({
            code: "22023",
          });
        await expect(
          pool.query("SELECT community.agent_connection_consents_reap(NULL)"),
        ).rejects.toMatchObject({ code: "22023" });
        expect(await exists(doomed)).toBe(true);
      });

      it("is a fixed definer function that PUBLIC cannot run", async () => {
        const { rows } = await pool.query(
          `SELECT p.prosecdef AS definer, p.proconfig AS settings,
                  has_function_privilege('public', p.oid, 'EXECUTE') AS public_runs
             FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'community'
              AND p.proname = 'agent_connection_consents_reap'`,
        );
        expect(rows).toEqual([
          {
            definer: true,
            settings: ["search_path=pg_catalog, community"],
            public_runs: false,
          },
        ]);
      });
    });

    describe("refreshReuseGraceMs", () => {
      const keys = providerAdapterKeysFrom({
        AGENT_CONNECTION_PROVIDER_INDEX_KEY: randomBytes(32).toString("base64"),
        AGENT_CONNECTION_PROVIDER_SEAL_KEY: randomBytes(32).toString("base64"),
      } as unknown as NodeJS.ProcessEnv);
      const CLIENT_ID = "artvenn-grace-client";
      const REDIRECT = "http://127.0.0.1:34699/callback";
      const RESOURCE = "http://127.0.0.1:3442/api/mcp";
      const GRACE_MS = 30_000;

      type TokenAnswer = {
        readonly access_token?: string;
        readonly refresh_token?: string;
        readonly error?: string;
      };

      /** The real provider on the real adapter, on a port of its own. */
      const startIssuer = async (grace: number | undefined) => {
        const require_ = createRequire(
          path.join(
            path.dirname(fileURLToPath(import.meta.url)),
            "../../../services/agent-authorization/package.json",
          ),
        );
        const { default: Provider } = (await import(
          pathToFileURL(require_.resolve("oidc-provider")).href
        )) as { default: new (issuer: string, config: unknown) => never };
        const grants: string[] = [];
        const revoked: string[] = [];
        // The adapter's clock alone. `consumed_at` is one-way, so the window is
        // passed by moving what it is measured against.
        let aheadMs = 0;
        let listener: http.RequestListener = () => undefined;
        const server = http.createServer((req, res) => listener(req, res));
        await new Promise<void>((resolve) =>
          server.listen(0, "127.0.0.1", resolve),
        );
        const { port } = server.address() as { port: number };
        const issuer = `http://127.0.0.1:${port}`;
        const provider = new Provider(issuer, {
          adapter: createProviderAdapter({
            pool,
            keys,
            now: () => new Date(Date.now() + aheadMs),
            ...(grace === undefined ? {} : { refreshReuseGraceMs: grace }),
          }),
          clients: [
            {
              client_id: CLIENT_ID,
              token_endpoint_auth_method: "none",
              grant_types: ["authorization_code", "refresh_token"],
              response_types: ["code"],
              redirect_uris: [REDIRECT],
              application_type: "native",
            },
          ],
          pkce: { required: () => true, methods: ["S256"] },
          scopes: ["artvenn:admin", "offline_access"],
          rotateRefreshToken: true,
          features: {
            resourceIndicators: {
              enabled: true,
              defaultResource: () => RESOURCE,
              getResourceServerInfo: () => ({
                scope: "artvenn:admin",
                audience: RESOURCE,
                accessTokenTTL: 3600,
                accessTokenFormat: "opaque",
              }),
            },
            devInteractions: { enabled: false },
          },
          ttl: {
            AccessToken: 3600,
            AuthorizationCode: 60,
            Grant: 180 * 86_400,
            RefreshToken: 30 * 86_400,
            Interaction: 600,
            Session: 3600,
          },
          findAccount: async (_ctx: unknown, id: string) => ({
            accountId: id,
            claims: async () => ({ sub: id }),
          }),
          interactions: {
            url: (_ctx: unknown, interaction: { uid: string }) =>
              `/grace-interaction/${interaction.uid}`,
          },
        }) as unknown as {
          callback: () => http.RequestListener;
          on: (
            event: string,
            listener: (ctx: unknown, grantId: string) => void,
          ) => void;
          interactionDetails: (req: unknown, res: unknown) => Promise<never>;
          interactionFinished: (...args: unknown[]) => Promise<void>;
          Grant: new (options: unknown) => {
            addOIDCScope: (scope: string) => void;
            addResourceScope: (resource: string, scope: string) => void;
            save: () => Promise<string>;
          };
        };
        provider.on("grant.revoked", (_ctx, grantId) => revoked.push(grantId));
        const callback = provider.callback();
        listener = (req, res) => {
          if (!req.url?.startsWith("/grace-interaction/")) {
            callback(req, res);
            return;
          }
          provider
            .interactionDetails(req, res)
            .then(async (interaction: unknown) => {
              const { params } = interaction as {
                params: Record<string, string>;
              };
              const grant = new provider.Grant({
                accountId: "user-owner",
                clientId: params.client_id,
              });
              grant.addOIDCScope("artvenn:admin offline_access");
              grant.addResourceScope(RESOURCE, "artvenn:admin");
              const grantId = await grant.save();
              grants.push(grantId);
              return provider.interactionFinished(
                req,
                res,
                { login: { accountId: "user-owner" }, consent: { grantId } },
                { mergeWithLastSubmission: false },
              );
            })
            .catch(() => {
              res.statusCode = 500;
              res.end();
            });
        };

        const post = async (body: Record<string, string>) =>
          (await (
            await fetch(`${issuer}/token`, {
              method: "POST",
              headers: { "content-type": "application/x-www-form-urlencoded" },
              body: new URLSearchParams({ client_id: CLIENT_ID, ...body }),
            })
          ).json()) as TokenAnswer;

        return {
          grants,
          revoked,
          advance: (ms: number) => {
            aheadMs += ms;
          },
          refresh: (refreshToken: string) =>
            post({
              grant_type: "refresh_token",
              refresh_token: refreshToken,
              resource: RESOURCE,
            }),
          /** Drives authorize and the code exchange, so `code` can be replayed. */
          authorize: async () => {
            const verifier = randomBytes(32).toString("base64url");
            const challenge = createHash("sha256")
              .update(verifier)
              .digest("base64url");
            const jar = new Map<string, string>();
            const remember = (response: Response) => {
              for (const raw of response.headers.getSetCookie()) {
                const pair = raw.split(";")[0] ?? "";
                const at = pair.indexOf("=");
                if (at > 0) jar.set(pair.slice(0, at), pair.slice(at + 1));
              }
            };
            let response = await fetch(
              `${issuer}/auth?client_id=${CLIENT_ID}&response_type=code` +
                `&redirect_uri=${encodeURIComponent(REDIRECT)}` +
                `&scope=${encodeURIComponent("artvenn:admin offline_access")}` +
                `&resource=${encodeURIComponent(RESOURCE)}` +
                `&code_challenge=${challenge}&code_challenge_method=S256` +
                `&state=${hex(8)}&prompt=consent`,
              { redirect: "manual" },
            );
            remember(response);
            let code = "";
            for (let hop = 0; hop < 6 && code === ""; hop += 1) {
              const location = response.headers.get("location");
              if (location === null) break;
              const next = new URL(location, issuer);
              if (next.origin === new URL(REDIRECT).origin) {
                code = next.searchParams.get("code") ?? "";
                break;
              }
              response = await fetch(next, {
                redirect: "manual",
                headers: {
                  cookie: [...jar].map(([n, v]) => `${n}=${v}`).join("; "),
                },
              });
              remember(response);
            }
            expect(code).not.toBe("");
            const exchange = () =>
              post({
                grant_type: "authorization_code",
                code,
                redirect_uri: REDIRECT,
                code_verifier: verifier,
                resource: RESOURCE,
              });
            return { tokens: await exchange(), exchange };
          },
          close: () =>
            new Promise<void>((resolve) => server.close(() => resolve())),
        };
      };

      const refreshRows = async (grantId: string) => {
        const { rows } = await pool.query(
          `SELECT consumed_at FROM community.agent_connection_provider_artifacts
            WHERE model='RefreshToken' AND grant_id=$1
            ORDER BY consumed_at NULLS LAST`,
          [grantId],
        );
        return rows as { consumed_at: Date | null }[];
      };

      it("lets a second use through inside the window, and revokes after it", async () => {
        const issuer = await startIssuer(GRACE_MS);
        try {
          const { tokens } = await issuer.authorize();
          const original = tokens.refresh_token ?? "";
          expect(original).not.toBe("");
          const grantId = issuer.grants[0] ?? "";

          const first = await issuer.refresh(original);
          expect(first.error).toBeUndefined();
          expect(first.refresh_token).not.toBe(original);
          const consumedAt = (await refreshRows(grantId))[0]?.consumed_at;
          expect(consumedAt).toBeInstanceOf(Date);

          // The same token again: this is the race, not a theft.
          const second = await issuer.refresh(original);
          expect(second.error).toBeUndefined();
          expect(typeof second.access_token).toBe("string");
          expect(second.refresh_token).not.toBe(first.refresh_token);
          // The window runs from the first use, and the grant stands.
          expect((await refreshRows(grantId))[0]?.consumed_at).toEqual(
            consumedAt,
          );
          expect(issuer.revoked).toEqual([]);
          // Both branches are live until something revokes.
          const continued = await issuer.refresh(second.refresh_token ?? "");
          expect(continued.error).toBeUndefined();

          issuer.advance(GRACE_MS + 1_000);
          expect((await issuer.refresh(original)).error).toBe("invalid_grant");
          expect(issuer.revoked).toEqual([grantId]);
          expect(await refreshRows(grantId)).toEqual([]);
          expect(
            (await issuer.refresh(continued.refresh_token ?? "")).error,
          ).toBe("invalid_grant");
        } finally {
          await issuer.close();
        }
      }, 30_000);

      it("treats a second use as theft at once when no window is set, as Article does", async () => {
        const issuer = await startIssuer(undefined);
        try {
          const { tokens } = await issuer.authorize();
          const original = tokens.refresh_token ?? "";
          const first = await issuer.refresh(original);
          expect(first.error).toBeUndefined();
          expect((await issuer.refresh(original)).error).toBe("invalid_grant");
          expect(issuer.revoked).toEqual([issuer.grants[0]]);
          expect((await issuer.refresh(first.refresh_token ?? "")).error).toBe(
            "invalid_grant",
          );
        } finally {
          await issuer.close();
        }
      }, 30_000);

      it("gives an authorization code no window at all", async () => {
        const issuer = await startIssuer(GRACE_MS);
        try {
          const { tokens, exchange } = await issuer.authorize();
          expect(tokens.error).toBeUndefined();
          expect((await exchange()).error).toBe("invalid_grant");
        } finally {
          await issuer.close();
        }
      }, 30_000);

      it("hides a consumed refresh token for exactly the window, and nothing else", async () => {
        let clock = new Date("2031-01-01T00:00:00.000Z");
        const Adapter = createProviderAdapter({
          pool,
          keys,
          now: () => clock,
          refreshReuseGraceMs: GRACE_MS,
        });
        const store = new Adapter("RefreshToken");
        const code = new Adapter("AuthorizationCode");
        const id = `grace-${hex(8)}`;
        await store.upsert(id, { jti: id }, 600);
        await code.upsert(id, { jti: id }, 600);
        await store.consume(id);
        await code.consume(id);

        clock = new Date(clock.getTime() + GRACE_MS - 1);
        expect((await store.find(id))?.consumed).toBeUndefined();
        expect(typeof (await code.find(id))?.consumed).toBe("number");

        clock = new Date(clock.getTime() + 1);
        expect(typeof (await store.find(id))?.consumed).toBe("number");

        // A later consume does not restart the window.
        await store.consume(id);
        expect(typeof (await store.find(id))?.consumed).toBe("number");
      });

      it.each([
        ["no window set", {}],
        ["a window of 0", { refreshReuseGraceMs: 0 }],
        ["Article's store", { namespace: "article-authoring" as const }],
      ])(
        "shows a consumed token as consumed when the clock steps back, with %s",
        async (_name, options) => {
          let clock = new Date("2031-01-01T00:00:00.000Z");
          const Adapter = createProviderAdapter({
            pool,
            keys,
            now: () => clock,
            ...options,
          });
          const store = new Adapter("RefreshToken");
          const id = `no-grace-${hex(8)}`;
          await store.upsert(id, { jti: id }, 600);
          await store.consume(id);
          expect(typeof (await store.find(id))?.consumed).toBe("number");

          clock = new Date(clock.getTime() - 5);
          expect(typeof (await store.find(id))?.consumed).toBe("number");
        },
      );

      it("refuses a nonsense window, and any window for Article", () => {
        for (const refreshReuseGraceMs of [-1, 1.5, Number.NaN])
          expect(() =>
            createProviderAdapter({ pool, keys, refreshReuseGraceMs }),
          ).toThrow(RangeError);
        expect(() =>
          createProviderAdapter({
            pool,
            keys,
            namespace: "article-authoring",
            refreshReuseGraceMs: 1,
          }),
        ).toThrow(RangeError);
        expect(() =>
          createProviderAdapter({
            pool,
            keys,
            namespace: "article-authoring",
            refreshReuseGraceMs: 0,
          }),
        ).not.toThrow();
      });
    });

    describe("infra/production/sql/admin-mcp-oauth-grants.sql", () => {
      // Fixed names, as the Development grant cases use, so a used cluster holds
      // these three however often this runs. They log in nowhere.
      const providerRole = "moya_oauth_case_provider";
      const consentRole = "moya_oauth_case_consent";
      const resourceRole = "moya_oauth_case_resource";
      const denied = { ok: false, sqlState: "42501" };

      const grantFile = () =>
        readFile(
          new URL(
            "../../../infra/production/sql/admin-mcp-oauth-grants.sql",
            import.meta.url,
          ),
          "utf8",
        );

      const applyAs = async (
        provider: string,
        consent: string,
        resource: string,
      ) => {
        const client = await pool.connect();
        try {
          for (const [setting, value] of [
            ["agent_connections.provider_role", provider],
            ["agent_connections.consent_role", consent],
            ["agent_connections.resource_role", resource],
          ])
            await client.query("SELECT set_config($1,$2,false)", [
              setting,
              value,
            ]);
          await client.query(await grantFile());
        } finally {
          client.release();
        }
      };

      const createRole = (role: string, attributes = "") =>
        pool.query(
          `DO $$ BEGIN
             IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${role}') THEN
               CREATE ROLE ${role} NOLOGIN ${attributes};
             END IF;
           END $$`,
        );

      beforeAll(async () => {
        for (const role of [providerRole, consentRole, resourceRole]) {
          await createRole(role);
          // A used cluster's role still holds what an older file granted it.
          await pool.query(`DROP OWNED BY ${role}`);
        }
        await applyAs(providerRole, consentRole, resourceRole);
      });

      /** Runs a statement as `role`, always rolled back. */
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
          await client.query("ROLLBACK").catch(() => undefined);
          client.release();
        }
      };

      /** Runs a real store method as `role`, and commits what it did. */
      const committedAs = async <T>(
        role: string,
        run: (client: Queryable) => Promise<T>,
      ): Promise<T> => {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await client.query(`SET LOCAL ROLE ${role}`);
          const value = await run(client as unknown as Queryable);
          await client.query("COMMIT");
          return value;
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
      };

      it("creates no role, holds no password and names no principal table", async () => {
        const statements = (await grantFile()).replace(/^\s*--.*$/gmu, "");
        expect(statements).not.toMatch(/CREATE\s+ROLE|ALTER\s+ROLE/iu);
        expect(statements).not.toMatch(/PASSWORD '|synthetic-local/iu);
        expect(statements).not.toContain("agent_principals");
        expect(statements).not.toContain("backend_role");
      });

      it("raises rather than granting nothing when no role is named", async () => {
        // Its own connection: a pooled one may hold these from an earlier case.
        const unnamed = createPostgresPool(
          parsePostgresConfig({
            DATABASE_URL: requireSyntheticTestDatabaseUrl(),
          }),
        );
        try {
          await expect(unnamed.query(await grantFile())).rejects.toMatchObject({
            code: "42704",
          });
        } finally {
          await closePostgresPool(unnamed);
        }
      });

      it("runs again and changes nothing", async () => {
        await expect(
          applyAs(providerRole, consentRole, resourceRole),
        ).resolves.toBeUndefined();
      });

      it("refuses a role that is missing, repeated, or wider than it should be", async () => {
        const absent = `moya_oauth_case_absent_${hex(4)}`;
        await expect(
          applyAs(providerRole, absent, resourceRole),
        ).rejects.toThrow("create the three login door roles first");
        await expect(
          applyAs(providerRole, providerRole, resourceRole),
        ).rejects.toThrow("must be distinct");
        const wide = "moya_oauth_case_wide";
        await createRole(wide, "CREATEROLE");
        await expect(applyAs(wide, consentRole, resourceRole)).rejects.toThrow(
          "must hold no superuser",
        );
        // Refused before a single grant, so the wide role holds nothing.
        expect(
          (
            await pool.query(
              `SELECT has_schema_privilege($1,'community','USAGE') AS usage`,
              [wide],
            )
          ).rows[0],
        ).toEqual({ usage: false });
        // Wide by membership: attributes would not show it, and the grants above
        // would then be the least of what this role can do.
        const member = "moya_oauth_case_member";
        const parent = "moya_oauth_case_parent";
        await createRole(member);
        await pool.query(`DROP OWNED BY ${member}`);
        await createRole(parent);
        await pool.query(`GRANT ${parent} TO ${member}`);
        await expect(
          applyAs(member, consentRole, resourceRole),
        ).rejects.toThrow("must be a member of no other role");
        expect(
          (
            await pool.query(
              `SELECT has_schema_privilege($1,'community','USAGE') AS usage`,
              [member],
            )
          ).rows[0],
        ).toEqual({ usage: false });
        const { rows } = await pool.query("SELECT current_user AS me");
        await expect(
          applyAs((rows[0] as { me: string }).me, consentRole, resourceRole),
        ).rejects.toThrow("must not be the account running this file");
      });

      it("grants nothing no code uses, and the ledger read to the issuer alone", async () => {
        for (const [role, table, column] of [
          [providerRole, "community.agent_connection_grants", "destroy_status"],
          [providerRole, "community.agent_connection_grants", "destroyed_at"],
          [
            consentRole,
            "community.agent_connections",
            "provider_cleanup_status",
          ],
          [
            consentRole,
            "community.agent_connections",
            "provider_cleanup_error",
          ],
        ] as const) {
          const { rows } = await pool.query(
            `SELECT has_column_privilege($1,$2,$3,'UPDATE') AS held`,
            [role, table, column],
          );
          expect(rows[0], `${role} ${column}`).toEqual({ held: false });
        }
        for (const [role, held] of [
          [providerRole, true],
          [consentRole, false],
          [resourceRole, false],
        ] as const) {
          const { rows } = await pool.query(
            `SELECT has_table_privilege($1,'community.schema_migrations','SELECT') AS held`,
            [role],
          );
          expect(rows[0], role).toEqual({ held });
        }
        // The issuer's check at start, on what that role was actually given.
        await expect(
          committedAs(providerRole, (client) =>
            verifyCommunityMigrationLedger({
              connect: async () => ({
                query: client.query.bind(client),
                release: () => undefined,
              }),
            } as never),
          ),
        ).resolves.toBeUndefined();
      });

      it("carries a whole consent through the three roles, each doing only its half", async () => {
        const humanAccountId = `owner-${hex(4)}`;
        const fields = connectionFields({ humanAccountId });
        const interactionUid = uid();

        // The provider opens what it will enforce.
        await committedAs(providerRole, (client) =>
          createConsentStore({ pool: client }).open({
            interactionUid,
            oauthClientId: fields.oauthClientId,
            resource: "https://resource.invalid/api/mcp",
            capabilityScopes: ["artvenn:admin"],
            protocolScopes: ["offline_access"],
            preset: "operator",
            expiresAt: later(5 * 60_000),
          }),
        );

        // The control plane says who, about what, and records the decision.
        const ticket = hex(32);
        const { secret, digest } = mintResumeSecret();
        const authorized = {
          ...fields,
          status: "authorized" as const,
          generation: 1,
          consentedAt: new Date().toISOString(),
        };
        await committedAs(consentRole, async (client) => {
          const store = createAgentConnectionStore({ pool: client });
          const opened = await store.createForClient(fields);
          const decisions = createConsentStore({ pool: client });
          await decisions.arm({
            interactionUid,
            ticketDigest: digestOf(ticket),
            connectionId: fields.id,
            humanAccountId,
          });
          await decisions.decide({
            interactionUid,
            ticketDigest: digestOf(ticket),
            humanAccountId,
            decision: "approved",
            grantedGeneration: 1,
            resumeSecretDigest: digest,
          });
          await store.compareAndSet(
            fields.id,
            opened?.version ?? 0,
            authorized,
          );
        });

        // The provider checks the secret, writes the grant and spends the row.
        const grantId = `grant-${hex(12)}`;
        await committedAs(providerRole, async (client) => {
          const decisions = createConsentStore({ pool: client });
          const store = createAgentConnectionStore({ pool: client });
          expect(
            await decisions.resumeSecretMatches(
              interactionUid,
              digestResumeSecret(secret),
            ),
          ).toBe(true);
          expect(
            await store.createGrant({
              grantId,
              connectionId: fields.id,
              generationAtConsent: 1,
              oauthClientId: fields.oauthClientId,
              humanSubject: humanAccountId,
              issuer: "https://issuer.invalid",
              resource: "https://resource.invalid/api/mcp",
              capabilityScopes: ["artvenn:admin"],
              protocolScopes: ["offline_access"],
              presetAtConsent: "operator",
            }),
          ).toBe(true);
          expect(await store.setCurrentGrant(fields.id, grantId, 1)).toBe(true);
          expect(
            (
              await decisions.resume({
                interactionUid,
                grantId,
                resumeSecretDigest: digest,
              })
            )?.grantId,
          ).toBe(grantId);
        });

        // The page lists it, the door reads and stamps it.
        const listed = await committedAs(consentRole, (client) =>
          createAgentConnectionStore({ pool: client }).listAuthorized(),
        );
        expect(listed.map(({ connection }) => connection.id)).toContain(
          fields.id,
        );
        await committedAs(resourceRole, async (client) => {
          const store = createAgentConnectionStore({ pool: client });
          expect(
            (await store.readForAuthorization(fields.id))?.grant?.grantId,
          ).toBe(grantId);
          expect(await store.markVerified(fields.id)).toBe(true);
        });
      });

      it("lets the provider void and reap, the two things only it does", async () => {
        const armed = await armedOperator();
        const { digest } = await approve(armed);
        const voided = await committedAs(providerRole, (client) =>
          createConsentStore({ pool: client }).voidResume({
            interactionUid: armed.interactionUid,
            resumeSecretDigest: digest,
          }),
        );
        expect(voided?.grantId).toBeNull();
        expect(voided?.resumedAt).not.toBeNull();

        expect(
          await committedAs(providerRole, (client) =>
            createConsentStore({ pool: client }).reapExpired(1),
          ),
        ).toBeGreaterThanOrEqual(0);
      });

      it("denies the provider a decision, a secret, a human and a direct delete", async () => {
        const connection = await openConnection();
        for (const statement of [
          `UPDATE community.agent_connection_consents SET resume_secret_digest=NULL`,
          `UPDATE community.agent_connection_consents SET decision='approved'`,
          `UPDATE community.agent_connection_consents SET ticket_digest=NULL`,
          `UPDATE community.agent_connection_consents SET human_account_id='owner'`,
          `DELETE FROM community.agent_connection_consents`,
          `UPDATE community.agent_connections SET status='revoked'`,
          `DELETE FROM community.agent_connections`,
          `UPDATE community.agent_connection_grants SET generation_at_consent=9`,
          `SELECT 1 FROM community.agent_principals LIMIT 1`,
        ])
          expect(await asRole(providerRole, statement)).toEqual(denied);
        for (const [column, value] of [
          ["resume_secret_digest", `'${"a".repeat(64)}'`],
          ["decision", "'approved'"],
          ["decided_at", "CURRENT_TIMESTAMP"],
          ["granted_generation", "1"],
          ["ticket_digest", `'${"a".repeat(64)}'`],
          ["human_account_id", "'owner'"],
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
                       'operator', CURRENT_TIMESTAMP + interval '5 min',
                       ${value})`,
            ),
          ).toEqual(denied);
      });

      it("denies the control plane a grant, a token, an interaction and the reaper", async () => {
        for (const statement of [
          `SELECT community.agent_connection_consents_reap(1)`,
          `DELETE FROM community.agent_connection_consents`,
          `UPDATE community.agent_connection_consents SET resumed_at=CURRENT_TIMESTAMP`,
          `UPDATE community.agent_connection_consents SET grant_id='forged'`,
          `INSERT INTO community.agent_connection_consents
             (interaction_uid, oauth_client_id, resource, preset, expires_at)
           VALUES ('forged','c','https://r.invalid','operator',
                   CURRENT_TIMESTAMP + interval '5 min')`,
          `UPDATE community.agent_connections SET current_grant_id='forged'`,
          `INSERT INTO community.agent_connection_grants
             (grant_id, connection_id, generation_at_consent, oauth_client_id,
              human_subject, issuer, resource, preset_at_consent)
           VALUES ('forged','conn-x',1,'c','owner','https://a.invalid',
                   'https://r.invalid','operator')`,
          `SELECT 1 FROM community.agent_connection_wrappers LIMIT 1`,
          `SELECT 1 FROM community.agent_connection_provider_artifacts LIMIT 1`,
          `SELECT 1 FROM community.agent_principals LIMIT 1`,
        ])
          expect(await asRole(consentRole, statement)).toEqual(denied);
      });

      it("denies the door everything except reading and one stamp", async () => {
        for (const statement of [
          `SELECT community.agent_connection_consents_reap(1)`,
          `SELECT 1 FROM community.agent_connection_consents LIMIT 1`,
          `SELECT 1 FROM community.agent_connection_provider_artifacts LIMIT 1`,
          `UPDATE community.agent_connections SET status='revoked'`,
          `UPDATE community.agent_connections SET current_grant_id='forged'`,
          `UPDATE community.agent_connection_wrappers SET invalidated_at=NULL`,
          `SELECT 1 FROM community.agent_principals LIMIT 1`,
        ])
          expect(await asRole(resourceRole, statement)).toEqual(denied);
      });
    });
  });
};
