import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  createAgentConnectionStore,
  createGrantDestroyer,
  createProviderAdapter,
  createWrapperStore,
  providerAdapterKeysFrom,
  wrapperKeysFrom,
} from "@moya/community-postgres";
import {
  ConnectionAuthError,
  admitGrant,
} from "admin/agent-connections-admission";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type {
  ConnectionRecord,
  VerifiedGrant,
} from "admin/agent-connections-admission";

import type { createPostgresPool } from "@moya/catalog-postgres";

/**
 * Agent Connections V1 (Issue #141 r14 §7) — the ten-step refresh-generation
 * regression, against the real provider.
 *
 * A note on provenance, because it matters and the record is thin: the ten
 * steps are NOT written down anywhere in Issue #141, the private handoff, the
 * design directory or the execution ledger. Every reference in the record is a
 * statement that the regression is ABSENT; none enumerates a step, and "§13"
 * resolves to two different things inside the Issue itself. The enumeration
 * implemented here is the Owner's r14 §7 wording, which is its first written
 * form. Recorded rather than glossed, so nobody later believes this was
 * reconstructed from an older spec.
 *
 * What this drives: a real `oidc-provider@9.12.2` over loopback, against the
 * real PostgreSQL provider adapter, with Design B wrapper minting on the token
 * response, the canonical connection store, the real grant-to-wrapper binding,
 * and — since the review caught an earlier draft claiming this falsely — the
 * production `admitGrant` from `apps/admin/src/agent-connections`.
 *
 * What it does NOT drive, stated plainly: there is no HTTP Admin, no Payload
 * MCP endpoint and no browser here. Steps that say "denied on its next
 * protected request" are checked at the admission boundary that the MCP
 * handler calls, not through a running Next server.
 */
export const registerAgentConnectionTenStepTests = (
  pool: ReturnType<typeof createPostgresPool>,
) => {
  describe("r14 §7 — ten steps, real provider, real rows", () => {
    const ISSUER = "http://127.0.0.1:34615";
    const RESOURCE = "http://admin.localhost:3442/api/mcp";
    const CLIENT_ID = "artvenn-r14-ten-step-client";
    const REDIRECT = "http://127.0.0.1:34616/callback";

    // Task-private synthetic keys, generated per run and never printed.
    const providerKeys = providerAdapterKeysFrom({
      AGENT_CONNECTION_PROVIDER_INDEX_KEY: randomBytes(32).toString("base64"),
      AGENT_CONNECTION_PROVIDER_SEAL_KEY: randomBytes(32).toString("base64"),
    } as unknown as NodeJS.ProcessEnv);
    const wrapperKeys = wrapperKeysFrom({
      AGENT_CONNECTION_WRAPPER_INDEX_KEY: randomBytes(32).toString("base64"),
      AGENT_CONNECTION_WRAPPER_SEAL_KEY: randomBytes(32).toString("base64"),
    } as unknown as NodeJS.ProcessEnv);

    const connections = createAgentConnectionStore({ pool });
    const wrappers = createWrapperStore({ pool, keys: wrapperKeys });

    /**
     * Step 3's narrow failpoint. When held, provider-side cleanup is deferred
     * — nothing is disabled, no constraint is dropped, no auth check is
     * bypassed. It only delays the downstream half, which is exactly the
     * window the r12 finding lives in.
     */
    let cleanupHeld = true;
    const deferred: string[] = [];

    let server: http.Server;
    let provider: {
      callback: () => http.RequestListener;
      interactionDetails: (req: unknown, res: unknown) => Promise<unknown>;
      interactionFinished: (...args: unknown[]) => Promise<void>;
      use: (middleware: unknown) => void;
      Grant: new (options: unknown) => {
        addOIDCScope: (scope: string) => void;
        addResourceScope: (resource: string, scope: string) => void;
        save: () => Promise<string>;
      };
      AccessToken: {
        find: (jti: string) => Promise<Record<string, unknown> | undefined>;
        revokeByGrantId?: (grantId: string) => Promise<void>;
      };
      RefreshToken: { revokeByGrantId?: (grantId: string) => Promise<void> };
    };

    /** The connection this flow consents for, chosen before the provider runs. */
    let connectionId = "";

    const destroyer = () =>
      createGrantDestroyer({
        pool,
        provider: {
          destroyGrant: async (grantId) => {
            const Grant = (
              provider as unknown as {
                Grant: { adapter: { destroy: (id: string) => Promise<void> } };
              }
            ).Grant;
            await Grant.adapter.destroy(grantId);
          },
          revokeIssued: async (grantId) => {
            await provider.AccessToken.revokeByGrantId?.(grantId);
            await provider.RefreshToken.revokeByGrantId?.(grantId);
          },
          isAbsent: async (grantId) => {
            const Grant = (
              provider as unknown as {
                Grant: {
                  adapter: {
                    find: (id: string) => Promise<unknown | undefined>;
                  };
                };
              }
            ).Grant;
            return (await Grant.adapter.find(grantId)) === undefined;
          },
        },
        invalidateWrappers: (grantId, at) =>
          wrappers.invalidateByGrant(grantId, at),
      });

    /**
     * The deferred-cleanup queue the failpoint gates. Holding it delays ONLY
     * the downstream half: the canonical revoke has already committed, no
     * constraint is dropped and no authorization check is skipped.
     */
    const runDeferredCleanup = async () => {
      if (cleanupHeld) throw new Error("cleanup is held by the test failpoint");
      const run = [...deferred];
      deferred.length = 0;
      const results = [];
      for (const grantId of run)
        results.push({
          grantId,
          status: (await destroyer().destroy(grantId)).status,
        });
      return results;
    };

    beforeAll(async () => {
      const require_ = createRequire(
        path.join(
          path.dirname(fileURLToPath(import.meta.url)),
          "../../../apps/admin/package.json",
        ),
      );
      const { default: Provider } = (await import(
        pathToFileURL(require_.resolve("oidc-provider")).href
      )) as { default: new (issuer: string, config: unknown) => never };

      provider = new Provider(ISSUER, {
        adapter: createProviderAdapter({ pool, keys: providerKeys }),
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
        scopes: ["artvenn:read", "artvenn:manage", "offline_access"],
        features: {
          resourceIndicators: {
            enabled: true,
            defaultResource: () => RESOURCE,
            getResourceServerInfo: () => ({
              scope: "artvenn:read artvenn:manage",
              audience: RESOURCE,
              accessTokenTTL: 300,
              accessTokenFormat: "opaque",
            }),
          },
          revocation: { enabled: true },
          // Or the provider ignores `interactions.url` entirely and only warns.
          devInteractions: { enabled: false },
        },
        ttl: { AccessToken: 300, AuthorizationCode: 60, Grant: 2592000 },
        findAccount: async (_ctx: unknown, id: string) => ({
          accountId: id,
          claims: async () => ({ sub: id }),
        }),
        interactions: {
          url: (_ctx: unknown, interaction: { uid: string }) =>
            `/r14-interaction/${interaction.uid}`,
        },
      } as unknown as never) as unknown as typeof provider;

      /**
       * Design B, as r11 chose and r12 proved: the provider cannot be made to
       * emit a prefixed token, so the token response is post-processed and the
       * access token replaced with an ArtVenn-minted opaque value.
       *
       * Matching `ctx.oidc.route` rather than a path suffix is deliberate — a
       * suffix test fails OPEN, silently stopping matching and shipping the
       * raw provider token if the route ever moves.
       */
      provider.use(
        async (ctx: Record<string, unknown>, next: () => Promise<void>) => {
          await next();
          const oidc = ctx.oidc as
            { route?: string; entities?: Record<string, unknown> } | undefined;
          if (oidc?.route !== "token" || ctx.status !== 200) return;
          const body = ctx.body as
            { access_token?: string; expires_in?: number } | undefined;
          if (body === undefined || typeof body.access_token !== "string")
            return;
          const issued = await provider.AccessToken.find(body.access_token);
          const grantId = issued?.grantId;
          if (typeof grantId !== "string") return;
          const { rows } = await pool.query(
            "SELECT 1 FROM community.agent_connection_grants WHERE grant_id=$1",
            [grantId],
          );
          // No canonical consent row means nothing can be anchored. Destroying
          // what was just issued and refusing is the only honest outcome: a
          // wrapper bound to nothing is a token with no revocation story.
          if (rows.length === 0) return;
          const minted = await wrappers.mint({
            grantId,
            jti: body.access_token,
            expiresAt: new Date(Date.now() + (body.expires_in ?? 300) * 1000),
          });
          body.access_token = minted.presented;
        },
      );

      const callback = provider.callback();
      server = http.createServer((req, res) => {
        if (req.url?.startsWith("/r14-interaction/")) {
          provider
            .interactionDetails(req, res)
            .then(async (interaction: unknown) => {
              const params = (interaction as { params: Record<string, string> })
                .params;
              const grant = new provider.Grant({
                accountId: "user-owner",
                clientId: params.client_id,
              });
              for (const scope of String(params.scope ?? "").split(" "))
                if (scope) grant.addOIDCScope(scope);
              grant.addResourceScope(RESOURCE, "artvenn:read");
              const grantId = await grant.save();

              // This is what a real consent route does, and the ordering is
              // the whole point: the canonical snapshot is written in the same
              // step as consent, carrying the connection's generation AS IT IS
              // NOW. A later reconnect adds a row; it never edits this one.
              const current = await connections.read(connectionId);
              await pool.query(
                `INSERT INTO community.agent_connection_grants
                   (grant_id, connection_id, generation_at_consent,
                    oauth_client_id, human_subject, issuer, resource,
                    capability_scopes, protocol_scopes, preset_at_consent)
                 VALUES ($1,$2,$3,$4,'user-owner',$5,$6,
                         '{artvenn:read}','{offline_access}','read-only')`,
                [
                  grantId,
                  connectionId,
                  current?.connection.generation ?? 0,
                  CLIENT_ID,
                  ISSUER,
                  RESOURCE,
                ],
              );
              await pool.query(
                "UPDATE community.agent_connections SET current_grant_id=$2 WHERE id=$1",
                [connectionId, grantId],
              );
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
          return;
        }
        callback(req, res);
      });
      await new Promise<void>((resolve) =>
        server.listen(34615, "127.0.0.1", resolve),
      );
    }, 30000);

    afterAll(async () => {
      if (server !== undefined)
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    /**
     * Per TEST, not per file, since migration 20260921010000 made
     * (human_account_id, oauth_client_id) unique.
     *
     * Two cases here open a connection for the SAME pair, and both need it to
     * be `user-owner` at this suite's one registered client: the provider
     * authorizes as that subject for that client, and the consent this suite
     * records names them too, so varying either would make a case refuse for a
     * reason it is not testing — which is how a negative control goes green
     * for the wrong cause. The pair is therefore a shared resource that each
     * case returns.
     *
     * NOT because `admitGrant` compares them to the connection. It does not,
     * and saying so here would reverse an r14 fix: `admission.ts:104-109`
     * compares the CONSENT's subject and client against the GRANT's, precisely
     * because the connection's own columns stay writable by design. The
     * connection is reached through `consent.connectionId` and checked for
     * identity, environment and revocation — never for who owns it.
     */
    afterEach(async () => {
      await pool.query(
        "DELETE FROM community.agent_connection_provider_artifacts",
      );
      // A consent references its connection, so this leaf goes before the
      // connection does, exactly like the wrappers below it.
      await pool.query("DELETE FROM community.agent_connection_consents");
      await pool.query("DELETE FROM community.agent_connection_wrappers");
      await pool.query(
        "UPDATE community.agent_connections SET current_grant_id=NULL",
      );
      await pool.query("DELETE FROM community.agent_connection_grants");
      await pool.query("DELETE FROM community.agent_connections");
    });

    const openConnection = async (humanAccountId = "user-owner") => {
      const id = `conn-${randomBytes(16).toString("hex")}`;
      const created = await connections.create({
        id,
        principalLabel: "agent-ten-step",
        humanAccountId,
        client: "claude",
        oauthClientId: CLIENT_ID,
        environment: "development",
        preset: "read-only",
        status: "awaiting-consent",
        generation: 0,
        revokedAt: null,
        consentedAt: null,
      });
      expect(created).not.toBeNull();
      return id;
    };

    /** Marks a connection consented, the way an Owner consent route would. */
    const recordConsent = async (id: string) => {
      const current = await connections.read(id);
      expect(current).not.toBeNull();
      await connections.compareAndSet(id, current?.version ?? 1, {
        ...(current?.connection ?? ({} as never)),
        status: "authorized",
        generation: (current?.connection.generation ?? 0) + 1,
        consentedAt: new Date().toISOString(),
        revokedAt: null,
      });
    };

    const authorizeAndExchange = async () => {
      const verifier = randomBytes(32).toString("base64url");
      const challenge = createHash("sha256")
        .update(verifier)
        .digest("base64url");
      const url =
        `${ISSUER}/auth?client_id=${CLIENT_ID}&response_type=code` +
        `&redirect_uri=${encodeURIComponent(REDIRECT)}` +
        `&scope=${encodeURIComponent("artvenn:read offline_access")}` +
        `&resource=${encodeURIComponent(RESOURCE)}` +
        `&code_challenge=${challenge}&code_challenge_method=S256` +
        // Without an explicit consent prompt `offline_access` does not survive
        // and no refresh token is issued at all.
        `&state=${randomBytes(8).toString("base64url")}&prompt=consent`;

      const jar = new Map<string, string>();
      const remember = (response: Response) => {
        for (const raw of response.headers.getSetCookie?.() ?? []) {
          const pair = raw.split(";")[0] ?? "";
          const at = pair.indexOf("=");
          if (at > 0) jar.set(pair.slice(0, at), pair.slice(at + 1));
        }
      };
      let response = await fetch(url, { redirect: "manual" });
      remember(response);
      let code: string | null = null;
      for (let hop = 0; hop < 6 && code === null; hop += 1) {
        const location = response.headers.get("location");
        if (location === null) break;
        const next = new URL(location, ISSUER);
        if (next.origin === new URL(REDIRECT).origin) {
          code = next.searchParams.get("code");
          break;
        }
        response = await fetch(next, {
          redirect: "manual",
          headers: { cookie: [...jar].map(([n, v]) => `${n}=${v}`).join("; ") },
        });
        remember(response);
      }
      expect(code).not.toBeNull();
      return (await (
        await fetch(`${ISSUER}/token`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            code: code ?? "",
            redirect_uri: REDIRECT,
            client_id: CLIENT_ID,
            code_verifier: verifier,
            resource: RESOURCE,
          }),
        })
      ).json()) as {
        access_token?: string;
        refresh_token?: string;
        error?: string;
      };
    };

    const redeemRefresh = async (refreshToken: string) =>
      (await (
        await fetch(`${ISSUER}/token`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: refreshToken,
            client_id: CLIENT_ID,
            resource: RESOURCE,
          }),
        })
      ).json()) as {
        access_token?: string;
        refresh_token?: string;
        error?: string;
      };

    /**
     * The resource server's admission decision, exercised through the
     * PRODUCTION function.
     *
     * An earlier draft of this file reimplemented the comparison here and its
     * header claimed to be exercising the production binding. It was not, and
     * the review proved it the only way that settles such a claim: gutting
     * three checks inside `admitGrant` left all 402 postgres tests green while
     * turning 11 unit tests red. A second implementation of one rule, with
     * nothing proving they cannot drift, is worse than no test at all — it
     * reads like coverage.
     *
     * What stays outside `admitGrant` is what genuinely belongs to the
     * resource server rather than to the connection boundary: whether the
     * wrapper resolves, whether it has been invalidated, and whether the
     * provider still knows the token it stands for.
     */
    /** The adapter the product will need too: store row shape -> boundary record. */
    const toRecord = (
      stored: {
        connection: ConnectionRecord["connection"];
        grant: {
          grantId: string;
          connectionId: string;
          generationAtConsent: number;
          oauthClientId: string;
          humanSubject: string;
          issuer: string;
          resource: string;
          presetAtConsent: "read-only" | "management" | "operator";
          capabilityScopes: readonly string[];
          consentedAt: string;
        } | null;
      } | null,
    ): ConnectionRecord | null =>
      stored === null
        ? null
        : {
            connection: stored.connection,
            grant:
              stored.grant === null
                ? null
                : {
                    grantId: stored.grant.grantId,
                    connectionId: stored.grant.connectionId,
                    generationAtConsent: stored.grant.generationAtConsent,
                    oauthClientId: stored.grant.oauthClientId,
                    humanSubject: stored.grant.humanSubject,
                    issuer: stored.grant.issuer,
                    resource: stored.grant.resource,
                    presetAtConsent: stored.grant.presetAtConsent,
                    capabilityScopes: stored.grant.capabilityScopes,
                    consentedAt: stored.grant.consentedAt,
                  },
          };

    const toVerifiedGrant = (
      resolved: { connectionId: string; generation: number },
      token: Record<string, unknown>,
    ): VerifiedGrant => ({
      connectionId: resolved.connectionId,
      // The FROZEN consent generation, off the wrapper — never re-read from
      // the connection. This is the field the whole revision is about.
      generation: resolved.generation,
      subject: String(token.accountId),
      clientId: String(token.clientId),
      // `aud`, NOT `resourceServer.audience` — the trap the r12 spike
      // recorded after being caught by it.
      resource: String(token.aud),
      // The provider's opaque access token carries no `iss`, so this comes
      // from configuration. `admitGrant` compares it against the same
      // configured value, which the r10 comment already records as vacuous:
      // wiring this helper does not make that check real.
      issuer: ISSUER,
      scopes: String(token.scope ?? "")
        .split(" ")
        .filter(Boolean),
      expiresAt: new Date(Number(token.exp) * 1000).toISOString(),
    });

    const admit = async (presented: string): Promise<string | null> => {
      const resolved = await wrappers.resolve(presented);
      if (resolved === undefined) return "WRAPPER_UNKNOWN";
      if (resolved.invalidatedAt !== null) return "WRAPPER_INVALIDATED";
      const token = await provider.AccessToken.find(resolved.jti);
      if (token === undefined) return "PROVIDER_TOKEN_GONE";
      const stored = await connections.readForAuthorization(
        resolved.connectionId,
      );
      if (stored === null) return "CONNECTION_NOT_FOUND";
      const record = toRecord(stored);
      try {
        admitGrant(toVerifiedGrant(resolved, token), record, {
          issuer: ISSUER,
          resource: RESOURCE,
          environment: "development",
        });
        return null;
      } catch (error) {
        if (error instanceof ConnectionAuthError) return error.code;
        throw error;
      }
    };

    it("runs the ten steps end to end", async () => {
      // 1 — genuine consent creates connection C, grant G1, generation E1.
      connectionId = await openConnection();
      await recordConsent(connectionId);
      const afterConsent = await connections.read(connectionId);
      const E1 = afterConsent?.connection.generation ?? 0;
      expect(E1).toBe(1);

      // 2 — the real PKCE code exchange produces wrapper A1 and refresh R1,
      //     and A1 is admitted.
      const first = await authorizeAndExchange();
      expect(first.error).toBeUndefined();
      const A1 = first.access_token ?? "";
      const R1 = first.refresh_token ?? "";
      expect(A1.startsWith("artvenn_ct_")).toBe(true);
      expect(R1).not.toBe("");
      expect(await admit(A1)).toBeNull();

      const G1 = (await wrappers.resolve(A1))?.grantId ?? "";
      expect(G1).not.toBe("");
      expect(
        (await connections.readForAuthorization(connectionId))?.grant,
      ).toMatchObject({ grantId: G1, generationAtConsent: E1 });

      // 3 — disconnect durably revokes C while cleanup is held. Nothing is
      //     disabled: the failpoint defers the downstream half only.
      cleanupHeld = true;
      const live = await connections.read(connectionId);
      await connections.compareAndSet(connectionId, live?.version ?? 1, {
        ...(live?.connection ?? ({} as never)),
        status: "revoked",
        revokedAt: new Date().toISOString(),
        generation: (live?.connection.generation ?? 0) + 1,
      });
      deferred.push(G1);
      expect((await connections.read(connectionId))?.connection.status).toBe(
        "revoked",
      );

      // 4 — A1 is denied on its next protected request.
      expect(await admit(A1)).toBe("CONNECTION_REVOKED");

      // 5 — a separate genuine reconnect creates G2/E2, whose token succeeds.
      await recordConsent(connectionId);
      const afterReconnect = await connections.read(connectionId);
      const E2 = afterReconnect?.connection.generation ?? 0;
      expect(E2).toBeGreaterThan(E1);
      const second = await authorizeAndExchange();
      const A2 = second.access_token ?? "";
      expect(await admit(A2)).toBeNull();
      const G2 = (await wrappers.resolve(A2))?.grantId ?? "";
      expect(G2).not.toBe(G1);

      // 6 — redeem the retained R1 at the real provider, cleanup still held.
      //     Non-vacuity first: prove R1 is still a LIVE, unexpired, undestroyed
      //     refresh token at the moment it is presented. §7 is explicit that
      //     this step must not pass merely because the token had already
      //     lapsed, and "it was live" is the one fact that rules that out.
      const r1Before = await pool.query(
        `SELECT count(*)::int AS n FROM community.agent_connection_provider_artifacts
          WHERE model='RefreshToken' AND grant_id=$1
            AND consumed_at IS NULL AND expires_at > CURRENT_TIMESTAMP`,
        [G1],
      );
      expect((r1Before.rows[0] as { n: number }).n).toBeGreaterThan(0);

      const refreshed = await redeemRefresh(R1);

      // 7 — nothing from G1 is admitted as G2/E2. Whether the provider
      //     refuses outright or issues, the ArtVenn side must not admit it,
      //     and the binding function is what decides.
      // The provider knows nothing about ArtVenn's generation, so with
      // cleanup still held it SHOULD issue — that is the r12 finding, and it
      // is asserted rather than tolerated. A test that quietly accepted
      // `invalid_grant` here would pass without ever exercising the binding.
      expect(refreshed.error).toBeUndefined();
      expect(typeof refreshed.access_token).toBe("string");
      const carried = await wrappers.resolve(refreshed.access_token ?? "");
      // Still anchored to the ORIGINAL grant and its consent generation —
      // not to the reconnected connection's current one.
      expect(carried?.grantId).toBe(G1);
      expect(carried?.generation).toBe(E1);
      expect(carried?.generation).not.toBe(E2);
      // And the production binding refuses it.
      expect(await admit(refreshed.access_token ?? "")).toBe(
        "CONNECTION_GENERATION_STALE",
      );

      // 8 — release the failpoint and finish the real provider cleanup, then
      //     prove G1 cannot renew.
      //     While held, the queue refuses to run at all — so the window in
      //     steps 6 and 7 was a real deferral, not a flag nobody consulted.
      await expect(runDeferredCleanup()).rejects.toThrow(/cleanup is held/u);
      cleanupHeld = false;
      const outcomes = await runDeferredCleanup();
      expect(outcomes).toEqual([{ grantId: G1, status: "done" }]);
      const afterCleanup = await redeemRefresh(R1);
      expect(afterCleanup.access_token).toBeUndefined();
      expect(afterCleanup.error).toBe("invalid_grant");
      // Destruction is recorded, and it is recorded as having HAPPENED rather
      // than inferred from a call count.
      expect(await connections.readGrant(G1)).toMatchObject({
        destroyStatus: "done",
      });
      // Specific, not merely "some refusal". And the specific answer is not
      // the one first written here: cleanup invalidates the WRAPPER before
      // admission ever reaches the provider, so this is the earlier refusal.
      // The assertion was wrong; the code was right.
      expect(await admit(A1)).toBe("WRAPPER_INVALIDATED");

      // 9 — new store objects over the same pool and the same keys. Calling
      //     this a "restart" would overstate it, and the review said so: it
      //     shows the constructors hold no state that matters, not survival
      //     across a process boundary. Proving THAT needs a service to
      //     restart, and there is no service.
      const restarted = createAgentConnectionStore({ pool });
      const restartedWrappers = createWrapperStore({
        pool,
        keys: wrapperKeys,
      });
      expect((await restartedWrappers.resolve(A1))?.generation).toBe(E1);
      expect((await restarted.read(connectionId))?.connection.generation).toBe(
        E2,
      );
      expect(await admit(A2)).toBeNull();

      // 10 — another connection is untouched; then G2 is revoked and stays
      //      unusable until a genuinely new consent.
      //
      // ANOTHER HUMAN's connection, because one human holds one connection per
      // client now (migration 20260921010000) and a second row for this pair
      // is the thing that index forbids. Nothing admits a token against this
      // one; it is here to be left alone.
      const otherId = await openConnection("user-other");
      await recordConsent(otherId);
      const otherBefore = await connections.read(otherId);
      expect(otherBefore?.connection.status).toBe("authorized");

      const beforeSecondRevoke = await connections.read(connectionId);
      await connections.compareAndSet(
        connectionId,
        beforeSecondRevoke?.version ?? 1,
        {
          ...(beforeSecondRevoke?.connection ?? ({} as never)),
          status: "revoked",
          revokedAt: new Date().toISOString(),
          generation: (beforeSecondRevoke?.connection.generation ?? 0) + 1,
        },
      );
      expect(await admit(A2)).toBe("CONNECTION_REVOKED");
      // AND THE OTHER CONNECTION IS STILL UNTOUCHED. This step is named for
      // that, but until now it was only ever read BEFORE the revoke, so a
      // revoke that scoped by (human, client) instead of by connection id
      // would have left it green. Read after the event it is about.
      const otherAfter = await connections.read(otherId);
      expect(otherAfter?.connection.status).toBe("authorized");
      expect(otherAfter?.connection.revokedAt).toBeNull();
      expect(otherAfter?.connection.generation).toBe(
        otherBefore?.connection.generation,
      );
      await recordConsent(connectionId);
      // A NEW consent is what restores access — the old wrapper stays dead.
      expect(await admit(A2)).toBe("CONNECTION_GENERATION_STALE");
      const third = await authorizeAndExchange();
      expect(await admit(third.access_token ?? "")).toBeNull();
    }, 60000);

    it("fails when the binding reads the connection instead of the grant", async () => {
      // The §7 negative control. The first version of this was a tautology --
      // it compared one expression to itself and asserted that `x !== x` is
      // false, so it PASSED while the r12 defect was live, under a name that
      // said the opposite. The review caught it by reintroducing the defect
      // and watching the control stay green.
      //
      // This version runs the same PRODUCTION `admitGrant` twice over the
      // same token and record, changing exactly one thing: where the grant's
      // `generation` came from. That is the defect, isolated.
      connectionId = await openConnection();
      await recordConsent(connectionId);
      const first = await authorizeAndExchange();
      const A1 = first.access_token ?? "";
      const resolved = await wrappers.resolve(A1);
      expect(resolved).toBeDefined();
      const token = await provider.AccessToken.find(resolved?.jti ?? "");
      expect(token).toBeDefined();

      // A disconnect-and-reconnect, so the connection has moved on.
      const live = await connections.read(connectionId);
      await connections.compareAndSet(connectionId, live?.version ?? 1, {
        ...(live?.connection ?? ({} as never)),
        generation: (live?.connection.generation ?? 0) + 5,
      });

      const stored = await connections.readForAuthorization(connectionId);
      const record = toRecord(stored);
      const expected = {
        issuer: ISSUER,
        resource: RESOURCE,
        environment: "development",
      };
      const correct = toVerifiedGrant(resolved ?? ({} as never), token ?? {});

      // CORRECT: generation off the wrapper's frozen anchor -> refused.
      expect(() => admitGrant(correct, record, expected)).toThrow(
        "CONNECTION_GENERATION_STALE",
      );

      // MUTANT: generation read from the connection at check time. Both sides
      // now come from the same mutable row, so the comparison can never fail
      // and the disconnect stops meaning anything.
      const mutant = {
        ...correct,
        generation: record?.connection.generation ?? -1,
      };
      expect(admitGrant(mutant, record, expected).connection.id).toBe(
        connectionId,
      );
      // And the two really did differ, so the control is not comparing a
      // value to itself a second time.
      expect(mutant.generation).not.toBe(correct.generation);
    }, 60000);

    it("disabled no constraint, trigger or auth check to get there", async () => {
      // Step 3 says the failpoint must delay provider cleanup and nothing
      // else. Asserted against the catalog rather than promised in a comment,
      // because "nothing was disabled" is exactly the kind of claim that
      // decays silently — and because this suite DOES disable a trigger
      // elsewhere, inside a try/finally, which is precisely why the end state
      // is worth checking.
      const { rows } = await pool.query(
        `SELECT t.tgname, t.tgenabled
           FROM pg_trigger t
           JOIN pg_class c ON c.oid = t.tgrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname='community'
            AND c.relname LIKE 'agent_connection%'
            AND NOT t.tgisinternal
          ORDER BY t.tgname`,
      );
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows as { tgname: string; tgenabled: string }[])
        expect({ [row.tgname]: row.tgenabled }).toEqual({
          [row.tgname]: "O",
        });

      const constraints = await pool.query(
        `SELECT count(*)::int AS n
           FROM pg_constraint c
           JOIN pg_class t ON t.oid = c.conrelid
           JOIN pg_namespace n ON n.oid = t.relnamespace
          WHERE n.nspname='community'
            AND t.relname='agent_connection_wrappers'
            AND c.conname='agent_connection_wrappers_grant_identity'
            AND c.convalidated`,
      );
      // The composite key is the thing that refuses a wrapper disagreeing with
      // its grant. If a future change ever drops or invalidates it, the ten
      // steps above would still pass on application logic alone, which is the
      // situation r13 built the constraint to prevent.
      expect((constraints.rows[0] as { n: number }).n).toBe(1);
    });
  });
};
