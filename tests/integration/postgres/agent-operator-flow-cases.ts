import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import http from "node:http";
import { createServer as createTcpServer } from "node:net";

import {
  discoverAuthorizationServerMetadata,
  exchangeAuthorization,
  refreshAuthorization,
  startAuthorization,
} from "@modelcontextprotocol/sdk/client/auth.js";
import {
  authorizationConfigFrom,
  prepareAdminAuthorizationKeys,
  reapExpiredArtifacts,
  startAuthorizationServer,
} from "@moya/agent-authorization";
import {
  RESUME_SECRET_PARAMETER,
  createAgentConnectionStore,
  createConsentStore,
  mintResumeSecret,
} from "@moya/community-postgres";
import {
  authorizeConnection,
  reconnectConnection,
  revokeConnection,
} from "admin/agent-connections";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type { AuthorizationServer } from "@moya/agent-authorization";
import type { createPostgresPool } from "@moya/catalog-postgres";

/**
 * Issue #355, login door, slice O1: the Admin issuer's `operator` profile, the
 * REAL service on PostgreSQL over real HTTP.
 *
 * What this drives: `startAuthorizationServer`, the real oidc-provider, the real
 * adapter, wrapper and resume route, as the REAL provider role under
 * `infra/production/sql/admin-mcp-oauth-grants.sql`. The official MCP SDK client
 * drives the case that says so.
 *
 * What it does NOT drive, plainly: the Admin. `decideConsent` learns the operator
 * preset and mints the resume secret in slice O3, so `approve` below writes what
 * it will write, directly and as the consent role, with a stored digest. The
 * door is slice O2, so nothing here presents a token to `/api/mcp`.
 *
 * Every case makes its own person, and a person plus a client is one connection,
 * so this passes alone on an empty database and on a used one.
 */

const CLAUDE = "https://claude.ai/oauth/mcp-oauth-client-metadata";
const CLAUDE_CODE = "https://claude.ai/oauth/claude-code-client-metadata";
const CODEX = "https://chatgpt.com/oauth/codex/client.json";
const CHATGPT = "https://chatgpt.com/oauth/client.json";
const CLAUDE_CALLBACK = "https://claude.ai/api/mcp/auth_callback";
const CHATGPT_CALLBACK =
  "https://chatgpt.com/connector_platform_oauth_redirect";

/** As the record's section 22 has them, and as the Production list will. */
const CLIENTS = [
  {
    clientId: CLAUDE,
    family: "claude",
    label: "Claude",
    callbackPolicy: "hosted-https",
    redirectUris: [CLAUDE_CALLBACK],
  },
  {
    clientId: CLAUDE_CODE,
    family: "claude-code",
    label: "Claude Code",
    callbackPolicy: "loopback-host",
    redirectUris: [
      "http://localhost:49152/callback",
      "http://127.0.0.1:49152/callback",
    ],
  },
  {
    clientId: CODEX,
    family: "codex",
    label: "Codex",
    callbackPolicy: "loopback-host",
    redirectUris: [
      "http://127.0.0.1:49152/callback",
      "http://localhost:49152/callback",
    ],
  },
  {
    clientId: CHATGPT,
    family: "chatgpt",
    label: "ChatGPT",
    callbackPolicy: "hosted-https",
    redirectUris: [CHATGPT_CALLBACK],
  },
] as const;

const CONSENT_BASE = "http://admin.localhost:3442";
const RESOURCE = `${CONSENT_BASE}/api/mcp`;
const PREFIX = "/agent-connections/consent";
const DAY = 24 * 60 * 60 * 1000;

const hex = (bytes: number) => randomBytes(bytes).toString("hex");
const person = () => `user-owner-${hex(6)}`;

type TokenAnswer = {
  readonly access_token?: string;
  readonly refresh_token?: string;
  readonly expires_in?: number;
  readonly scope?: string;
  readonly id_token?: string;
  readonly error?: string;
};

/** A browser's cookie jar, down to the path, because the provider relies on it. */
const newJar = () => {
  const cookies = new Map<
    string,
    { value: string; path: string; expires: number | null }
  >();
  return {
    header: (url: URL) =>
      [...cookies]
        .filter(([, cookie]) => url.pathname.startsWith(cookie.path))
        .map(([name, cookie]) => `${name}=${cookie.value}`)
        .join("; "),
    /** What a hostile client can do that a browser will not: send every cookie. */
    everything: () =>
      [...cookies]
        .map(([name, cookie]) => `${name}=${cookie.value}`)
        .join("; "),
    holds: (name: string) => cookies.has(name),
    expiresAt: (name: string) => cookies.get(name)?.expires ?? null,
    remember: (response: Response) => {
      for (const raw of response.headers.getSetCookie()) {
        const [pair = "", ...attributes] = raw.split(/;\s*/u);
        const at = pair.indexOf("=");
        if (at <= 0) continue;
        const name = pair.slice(0, at);
        const value = pair.slice(at + 1);
        const path =
          attributes
            .find((part) => part.toLowerCase().startsWith("path="))
            ?.slice(5) ?? "/";
        const expires = attributes
          .find((part) => part.toLowerCase().startsWith("expires="))
          ?.slice(8);
        if (
          value === "" ||
          (expires !== undefined && Date.parse(expires) <= Date.now())
        )
          cookies.delete(name);
        else
          cookies.set(name, {
            value,
            path,
            expires: expires === undefined ? null : Date.parse(expires),
          });
      }
    },
  };
};
type Jar = ReturnType<typeof newJar>;

export const registerAgentOperatorFlowTests = (
  pool: ReturnType<typeof createPostgresPool>,
) => {
  describe("the Admin issuer's operator profile on PostgreSQL", () => {
    const PROVIDER_ROLE = "moya_oauth_case_provider";
    const CONSENT_ROLE = "moya_oauth_case_consent";
    const RESOURCE_ROLE = "moya_oauth_case_resource";

    /** Set to make the next matching statement fail, as an outage would. */
    let outage: ((text: string, values: readonly unknown[]) => boolean) | null =
      null;

    /** The pool the service is given: every statement runs as `role`, and commits. */
    const asRole = (role: string) => ({
      query: async (text: string, values: readonly unknown[] = []) => {
        if (outage?.(text, values) === true)
          throw new Error("synthetic database outage");
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await client.query(`SET LOCAL ROLE ${role}`);
          const result = await client.query(text, [...values]);
          await client.query("COMMIT");
          return result;
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
      },
    });

    const decisions = createConsentStore({
      pool: asRole(CONSENT_ROLE) as never,
    });
    const control = createAgentConnectionStore({
      pool: asRole(CONSENT_ROLE) as never,
    });

    let issuer = "";
    let server: AuthorizationServer;
    const failures: string[] = [];
    const resumes: string[] = [];

    const issuerKeys = {
      AGENT_AUTHORIZATION_COOKIE_KEY: randomBytes(32).toString("base64url"),
      AGENT_CONNECTION_PROVIDER_INDEX_KEY: randomBytes(32).toString("base64"),
      AGENT_CONNECTION_PROVIDER_SEAL_KEY: randomBytes(32).toString("base64"),
      AGENT_CONNECTION_WRAPPER_INDEX_KEY: randomBytes(32).toString("base64"),
      AGENT_CONNECTION_WRAPPER_SEAL_KEY: randomBytes(32).toString("base64"),
    };

    const environment = (port: number) =>
      ({
        ...issuerKeys,
        NODE_ENV: "development",
        AGENT_AUTHORIZATION_ENABLED: "true",
        AGENT_AUTHORIZATION_PROFILE: "operator",
        AGENT_AUTHORIZATION_ISSUER: `http://127.0.0.1:${port}`,
        AGENT_AUTHORIZATION_RESOURCE: RESOURCE,
        AGENT_AUTHORIZATION_CONSENT_URL: CONSENT_BASE,
        AGENT_AUTHORIZATION_PORT: String(port),
        AGENT_AUTHORIZATION_CLIENTS: JSON.stringify(CLIENTS),
        AGENT_AUTHORIZATION_ENVIRONMENT: "development",
        AGENT_AUTHORIZATION_DATABASE_URL: "unused-by-this-harness",
      }) as unknown as NodeJS.ProcessEnv;

    const applyGrantFile = async () => {
      for (const role of [PROVIDER_ROLE, CONSENT_ROLE, RESOURCE_ROLE])
        await pool.query(
          `DO $$ BEGIN
             IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${role}') THEN
               CREATE ROLE ${role} NOLOGIN;
             END IF;
           END $$`,
        );
      const client = await pool.connect();
      try {
        for (const [setting, value] of [
          ["agent_connections.provider_role", PROVIDER_ROLE],
          ["agent_connections.consent_role", CONSENT_ROLE],
          ["agent_connections.resource_role", RESOURCE_ROLE],
        ])
          await client.query("SELECT set_config($1,$2,false)", [
            setting,
            value,
          ]);
        await client.query(
          await readFile(
            new URL(
              "../../../infra/production/sql/admin-mcp-oauth-grants.sql",
              import.meta.url,
            ),
            "utf8",
          ),
        );
      } finally {
        client.release();
      }
    };

    const startIssuer = async () => {
      const reservation = http.createServer();
      await new Promise<void>((done) =>
        reservation.listen(0, "127.0.0.1", done),
      );
      const { port } = reservation.address() as { port: number };
      await new Promise<void>((done) => reservation.close(() => done()));
      const env = environment(port);
      const config = authorizationConfigFrom(env);
      return startAuthorizationServer({
        config,
        pool: asRole(PROVIDER_ROLE) as never,
        environment: env,
        preparedKeys: prepareAdminAuthorizationKeys(config, env),
        buildId: "operator-flow-cases",
        recordFailure: (code) => failures.push(code),
        recordResume: (code) => resumes.push(code),
      });
    };

    beforeAll(async () => {
      await applyGrantFile();
      server = await startIssuer();
      issuer = server.origin;
    }, 30_000);

    afterAll(async () => {
      await server?.close();
    });

    afterEach(() => {
      vi.useRealTimers();
      outage = null;
    });

    /** How many interactions this database has opened, for "no row was written". */
    const consentCount = async () => {
      const { rows } = await pool.query(
        "SELECT count(*)::int AS n FROM community.agent_connection_consents",
      );
      return (rows[0] as { n: number }).n;
    };

    interface Started {
      readonly jar: Jar;
      readonly uid: string;
      readonly verifier: string;
      readonly state: string;
      readonly clientId: string;
      readonly redirect: string;
    }

    /** The tool's half, up to the moment the browser is handed to the consent host. */
    const authorizeUrl = (
      clientId: string,
      redirect: string,
      options: {
        readonly scope?: string | null;
        readonly resource?: string | null;
        readonly verifier: string;
        readonly state: string;
      },
    ) => {
      const params = new URLSearchParams({
        client_id: clientId,
        response_type: "code",
        redirect_uri: redirect,
        code_challenge: createHash("sha256")
          .update(options.verifier)
          .digest("base64url"),
        code_challenge_method: "S256",
        state: options.state,
      });
      if (options.scope !== null)
        params.set("scope", options.scope ?? "artvenn:admin");
      if (options.resource !== null)
        params.set("resource", options.resource ?? RESOURCE);
      return `${issuer}/auth?${params.toString()}`;
    };

    const begin = async (
      clientId: string,
      redirect: string,
      options: {
        readonly jar?: Jar;
        readonly scope?: string | null;
        readonly resource?: string | null;
        readonly repeatResource?: boolean;
      } = {},
    ): Promise<Started> => {
      const verifier = randomBytes(32).toString("base64url");
      const state = randomBytes(8).toString("base64url");
      const jar = options.jar ?? newJar();
      const url = new URL(
        authorizeUrl(clientId, redirect, { ...options, verifier, state }),
      );
      if (options.repeatResource === true)
        url.searchParams.append("resource", RESOURCE);
      const response = await fetch(url, {
        redirect: "manual",
        headers: { cookie: jar.header(url) },
      });
      jar.remember(response);
      const location = response.headers.get("location");
      expect(location, `status ${response.status}`).not.toBeNull();
      const landing = new URL(location ?? "");
      // Fresh every time: nothing here may skip the screen.
      expect(landing.origin).toBe(CONSENT_BASE);
      expect(landing.pathname.startsWith(`${PREFIX}/`)).toBe(true);
      const uid = landing.pathname.split("/").pop() ?? "";
      return { jar, uid, verifier, state, clientId, redirect };
    };

    /**
     * What `decideConsent` will do in slice O3, in its order: the decision and
     * the digest in one statement, then the connection under compare-and-set.
     */
    const approve = async (
      uid: string,
      human: string,
      options: { readonly environment?: string } = {},
    ) => {
      const consent = await decisions.read(uid);
      expect(consent).not.toBeNull();
      const client = CLIENTS.find(
        (entry) => entry.clientId === consent?.oauthClientId,
      );
      const found = await control.findForClient(
        human,
        consent?.oauthClientId ?? "",
      );
      const stored =
        found ??
        (await control.createForClient({
          id: `conn-${hex(16)}`,
          principalLabel: `agent-operator-${hex(6)}`,
          humanAccountId: human,
          client: client?.family ?? "",
          oauthClientId: consent?.oauthClientId ?? "",
          environment: options.environment ?? "development",
          preset: "operator",
          status: "awaiting-consent",
          generation: 0,
          revokedAt: null,
          consentedAt: null,
        }));
      if (stored === null) throw new Error("TEST_CONNECTION_NOT_CREATED");
      const ticket = hex(32);
      const ticketDigest = createHash("sha256").update(ticket).digest("hex");
      expect(
        await decisions.arm({
          interactionUid: uid,
          ticketDigest,
          connectionId: stored.connection.id,
          humanAccountId: human,
        }),
      ).not.toBeNull();
      const record = {
        humanAccountId: human,
        preset: "operator" as const,
        at: new Date().toISOString(),
      };
      const next =
        stored.connection.status === "revoked"
          ? reconnectConnection(stored.connection as never, record)
          : authorizeConnection(stored.connection as never, record);
      const { secret, digest } = mintResumeSecret();
      expect(
        await decisions.decide({
          interactionUid: uid,
          ticketDigest,
          humanAccountId: human,
          decision: "approved",
          grantedGeneration: next.generation,
          resumeSecretDigest: digest,
        }),
      ).not.toBeNull();
      expect(
        await control.compareAndSet(
          stored.connection.id,
          stored.version,
          next as never,
        ),
      ).not.toBeNull();
      return { secret, connectionId: stored.connection.id };
    };

    const deny = async (uid: string, human: string) => {
      const consent = await decisions.read(uid);
      const connection = await control.createForClient({
        id: `conn-${hex(16)}`,
        principalLabel: `agent-operator-${hex(6)}`,
        humanAccountId: human,
        client: "claude",
        oauthClientId: consent?.oauthClientId ?? "",
        environment: "development",
        preset: "operator",
        status: "awaiting-consent",
        generation: 0,
        revokedAt: null,
        consentedAt: null,
      });
      const ticket = hex(32);
      const ticketDigest = createHash("sha256").update(ticket).digest("hex");
      await decisions.arm({
        interactionUid: uid,
        ticketDigest,
        connectionId: connection?.connection.id ?? "",
        humanAccountId: human,
      });
      expect(
        await decisions.decide({
          interactionUid: uid,
          ticketDigest,
          humanAccountId: human,
          decision: "denied",
          grantedGeneration: null,
        }),
      ).not.toBeNull();
    };

    const disconnect = async (connectionId: string) => {
      const stored = await control.read(connectionId);
      if (stored === null) throw new Error("TEST_CONNECTION_MISSING");
      expect(
        await control.compareAndSet(
          connectionId,
          stored.version,
          revokeConnection(
            stored.connection as never,
            new Date().toISOString(),
          ) as never,
        ),
      ).not.toBeNull();
    };

    const resumeUrl = (uid: string, secret?: string) =>
      new URL(
        `${issuer}${PREFIX}/${uid}/resume` +
          (secret === undefined
            ? ""
            : `?${RESUME_SECRET_PARAMETER}=${encodeURIComponent(secret)}`),
      );

    /** A browser following the resume route until it leaves the issuer or stops. */
    const follow = async (
      jar: Jar,
      start: URL,
      options: { readonly replayAll?: boolean } = {},
    ) => {
      let url = start;
      for (let hop = 0; hop < 8; hop += 1) {
        const response = await fetch(url, {
          redirect: "manual",
          headers: {
            cookie:
              options.replayAll === true ? jar.everything() : jar.header(url),
          },
        });
        jar.remember(response);
        const location = response.headers.get("location");
        if (location === null)
          return {
            status: response.status,
            page: await response.text(),
            headers: response.headers,
            arrived: null,
          };
        const next = new URL(location, issuer);
        if (next.origin !== issuer)
          return {
            status: response.status,
            page: "",
            headers: response.headers,
            arrived: next,
          };
        url = next;
      }
      throw new Error("TEST_TOO_MANY_REDIRECTS");
    };

    const post = async (body: Record<string, string>) => {
      const response = await fetch(`${issuer}/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(body),
      });
      return {
        status: response.status,
        ...((await response.json()) as TokenAnswer),
      };
    };

    const exchange = (started: Started, code: string) =>
      post({
        grant_type: "authorization_code",
        client_id: started.clientId,
        code,
        redirect_uri: started.redirect,
        code_verifier: started.verifier,
        resource: RESOURCE,
      });

    const refresh = (clientId: string, token: string) =>
      post({
        grant_type: "refresh_token",
        client_id: clientId,
        refresh_token: token,
      });

    /** One complete trip: authorize, consent, resume with both halves, tokens. */
    const connect = async (
      clientId: string,
      redirect: string,
      human: string,
      options: {
        readonly jar?: Jar;
        readonly scope?: string | null;
        readonly resource?: string | null;
      } = {},
    ) => {
      const started = await begin(clientId, redirect, options);
      const { secret, connectionId } = await approve(started.uid, human);
      const back = await follow(started.jar, resumeUrl(started.uid, secret));
      expect(back.page).toBe("");
      expect(back.arrived?.searchParams.get("error")).toBeNull();
      const code = back.arrived?.searchParams.get("code") ?? "";
      expect(code).not.toBe("");
      const tokens = await exchange(started, code);
      expect(tokens.error).toBeUndefined();
      return { started, connectionId, tokens, arrived: back.arrived };
    };

    const wrapperRow = async (presented: string) => {
      const { rows } = await pool.query(
        `SELECT invalidated_at, expires_at
           FROM community.agent_connection_wrappers WHERE lookup_digest=$1`,
        [server.bundle.wrappers.digestOf(presented)],
      );
      return rows[0] as
        { invalidated_at: Date | null; expires_at: Date } | undefined;
    };

    /** Counted, not timed: some cases freeze the date this would measure with. */
    const until = async (done: () => Promise<boolean>) => {
      for (let attempt = 0; attempt < 600; attempt += 1) {
        if (await done()) return;
        await new Promise((tick) => setTimeout(tick, 25));
      }
      throw new Error("TEST_CONDITION_NEVER_HELD");
    };

    const stateOf = async (uid: string) => {
      const consent = await decisions.read(uid);
      return {
        decision: consent?.decision,
        resumed: consent?.resumedAt !== null,
        grantId: consent?.grantId,
        human: consent?.humanAccountId,
      };
    };

    const grantsOf = async (connectionId: string) => {
      const { rows } = await pool.query(
        `SELECT grant_id, generation_at_consent::int AS generation
           FROM community.agent_connection_grants WHERE connection_id=$1
          ORDER BY generation_at_consent`,
        [connectionId],
      );
      return rows as { grant_id: string; generation: number }[];
    };

    const VOIDED_PAGE = "不是从这个浏览器发起的";
    const REFUSED_PAGE = "这次连接没有完成";

    describe("each listed client", () => {
      it.each([
        ["Claude", CLAUDE, CLAUDE_CALLBACK],
        ["ChatGPT", CHATGPT, CHATGPT_CALLBACK],
        [
          "Claude Code on localhost",
          CLAUDE_CODE,
          "http://localhost:53111/callback",
        ],
        [
          "Claude Code on an address",
          CLAUDE_CODE,
          "http://127.0.0.1:53112/callback",
        ],
        ["Codex on an address", CODEX, "http://127.0.0.1:53113/callback"],
        ["Codex on localhost", CODEX, "http://localhost:53114/callback"],
      ])(
        "%s connects, and the code lands on its exact callback",
        async (_name, clientId, redirect) => {
          const human = person();
          const { started, connectionId, tokens, arrived } = await connect(
            clientId,
            redirect,
            human,
          );
          const landed = new URL(redirect);
          expect(arrived?.origin).toBe(landed.origin);
          expect(arrived?.pathname).toBe(landed.pathname);
          expect(arrived?.searchParams.get("state")).toBe(started.state);
          // Issuer identification, which the hosted vendors require.
          expect(arrived?.searchParams.get("iss")).toBe(issuer);

          // The client gets our opaque value, and never the provider's.
          expect(tokens.access_token).toMatch(/^artvenn_ct_/u);
          expect(tokens.refresh_token).toBeTruthy();
          expect(tokens.expires_in).toBe(3600);
          expect(tokens.scope).toBe("artvenn:admin");
          expect(tokens.id_token).toBeUndefined();

          const stored = await control.readForAuthorization(connectionId);
          expect(stored?.connection).toMatchObject({
            status: "authorized",
            generation: 1,
            preset: "operator",
            oauthClientId: clientId,
            humanAccountId: human,
          });
          expect(stored?.grant).toMatchObject({
            connectionId,
            generationAtConsent: 1,
            oauthClientId: clientId,
            humanSubject: human,
            issuer,
            resource: RESOURCE,
            capabilityScopes: ["artvenn:admin"],
            protocolScopes: ["offline_access"],
            presetAtConsent: "operator",
          });
          expect(
            (await wrapperRow(tokens.access_token ?? ""))?.invalidated_at,
          ).toBeNull();

          // A live connection, as the operator page will list it.
          const listed = await control.listAuthorized();
          expect(listed.map(({ connection }) => connection.id)).toContain(
            connectionId,
          );
        },
      );

      it.each([
        ["another path on a hosted client", CLAUDE, "https://claude.ai/other"],
        [
          "another host on a hosted client",
          CLAUDE,
          "https://evil.invalid/api/mcp/auth_callback",
        ],
        [
          "http on a hosted client",
          CHATGPT,
          "http://chatgpt.com/connector_platform_oauth_redirect",
        ],
        ["a query on a hosted client", CHATGPT, `${CHATGPT_CALLBACK}?next=x`],
        ["another client's callback", CLAUDE, CHATGPT_CALLBACK],
        [
          "another path on a local client",
          CODEX,
          "http://127.0.0.1:53120/other",
        ],
        [
          "another host on a local client",
          CODEX,
          "http://attacker.invalid:53120/callback",
        ],
      ])(
        "refuses %s before anything is written",
        async (_name, clientId, redirect) => {
          const before = await consentCount();
          const url = authorizeUrl(clientId, redirect, {
            verifier: "v".repeat(43),
            state: "s",
          });
          const response = await fetch(url, { redirect: "manual" });
          expect(response.status).toBe(400);
          expect(response.headers.get("location")).toBeNull();
          const page = await response.text();
          expect(page).toContain("invalid_redirect_uri");
          expect(page).not.toContain(redirect);
          expect(await consentCount()).toBe(before);
        },
      );

      it("requires PKCE, and its S256 form", async () => {
        const before = await consentCount();
        for (const remove of [["code_challenge"], ["code_challenge_method"]]) {
          const url = new URL(
            authorizeUrl(CLAUDE, CLAUDE_CALLBACK, {
              verifier: "v".repeat(43),
              state: "s",
            }),
          );
          for (const name of remove) url.searchParams.delete(name);
          const response = await fetch(url, { redirect: "manual" });
          const location = new URL(response.headers.get("location") ?? issuer);
          expect(location.origin).not.toBe(CONSENT_BASE);
        }
        expect(await consentCount()).toBe(before);
      });
    });

    describe("an unlisted client", () => {
      it("gets invalid_client, no row, and no network call to its metadata URL", async () => {
        // A real listener at the URL the client id names, so a fetch would show.
        const contacts: unknown[] = [];
        const listener = createTcpServer((socket) => {
          contacts.push(socket.remoteAddress);
          socket.destroy();
        });
        await new Promise<void>((done) =>
          listener.listen(0, "127.0.0.1", done),
        );
        const { port } = listener.address() as { port: number };
        const fetchSpy = vi.spyOn(globalThis, "fetch");
        try {
          for (const clientId of [
            `https://127.0.0.1:${port}/oauth/client.json`,
            "https://claude.ai/oauth/not-on-our-list",
            `https://tool-${hex(4)}.invalid/client.json`,
            "plain-unknown-client",
          ]) {
            const before = await consentCount();
            fetchSpy.mockClear();
            const url = authorizeUrl(clientId, CLAUDE_CALLBACK, {
              verifier: "v".repeat(43),
              state: "s",
            });
            const response = await fetch(url, { redirect: "manual" });
            expect(response.status).toBe(400);
            expect(response.headers.get("location")).toBeNull();
            const page = await response.text();
            expect(page).toContain("invalid_client");
            // The plain page, not the library's, which imports a web font.
            expect(page).toContain("这次连接没有完成");
            expect(page).not.toMatch(/https?:/u);
            expect(response.headers.get("cache-control")).toBe("no-store");
            expect(await consentCount()).toBe(before);
            expect(
              fetchSpy.mock.calls.map(
                ([target]) => new URL(String(target)).origin,
              ),
            ).toEqual([issuer]);
          }
          // Long enough for anything that had started to have connected.
          await new Promise((tick) => setTimeout(tick, 100));
          expect(contacts).toEqual([]);
        } finally {
          fetchSpy.mockRestore();
          await new Promise<void>((done) => listener.close(() => done()));
        }
      });
    });

    describe("what the issuer says about itself", () => {
      it("publishes exactly the metadata a listed client reads", async () => {
        const response = await fetch(
          `${issuer}/.well-known/oauth-authorization-server`,
        );
        expect(response.status).toBe(200);
        const metadata = (await response.json()) as Record<string, unknown>;
        expect(metadata).toMatchObject({
          issuer,
          authorization_endpoint: `${issuer}/auth`,
          token_endpoint: `${issuer}/token`,
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          scopes_supported: ["artvenn:admin", "offline_access"],
          client_id_metadata_document_supported: true,
          authorization_response_iss_parameter_supported: true,
        });
        expect(metadata).not.toHaveProperty("registration_endpoint");
        expect(metadata).not.toHaveProperty("userinfo_endpoint");
        expect(metadata).not.toHaveProperty(
          "pushed_authorization_request_endpoint",
        );
        expect(metadata).not.toHaveProperty(
          "require_pushed_authorization_requests",
        );
        expect(metadata).not.toHaveProperty(
          "dpop_signing_alg_values_supported",
        );
        expect(metadata.scopes_supported).not.toContain("openid");
        // The same document under the OpenID name, with the same limits.
        const oidc = (await (
          await fetch(`${issuer}/.well-known/openid-configuration`)
        ).json()) as Record<string, unknown>;
        expect(oidc).not.toHaveProperty("registration_endpoint");
        expect(oidc).not.toHaveProperty(
          "pushed_authorization_request_endpoint",
        );
        expect(oidc).not.toHaveProperty("dpop_signing_alg_values_supported");
        expect(oidc.scopes_supported).toEqual([
          "artvenn:admin",
          "offline_access",
        ]);
      });

      it("has neither pushed requests nor DPoP to fail on", async () => {
        failures.length = 0;
        const pushed = await fetch(`${issuer}/request`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ client_id: CODEX }),
        });
        expect(pushed.status).toBe(404);

        const referred = new URLSearchParams({
          client_id: CODEX,
          request_uri: "urn:ietf:params:oauth:request_uri:synthetic",
        });
        const answer = await fetch(`${issuer}/auth?${referred.toString()}`, {
          redirect: "manual",
        });
        expect(answer.status).toBe(400);

        // A tool that sends a proof anyway gets an ordinary token for its click.
        const started = await begin(CODEX, "http://127.0.0.1:53133/callback");
        const { secret } = await approve(started.uid, person());
        const back = await follow(started.jar, resumeUrl(started.uid, secret));
        const redeemed = await fetch(`${issuer}/token`, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            dpop: "synthetic-proof",
          },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            client_id: started.clientId,
            code: back.arrived?.searchParams.get("code") ?? "",
            redirect_uri: started.redirect,
            code_verifier: started.verifier,
          }),
        });
        expect(redeemed.status).toBe(200);
        expect(((await redeemed.json()) as TokenAnswer).access_token).toMatch(
          /^artvenn_ct_/u,
        );
        expect(failures).toEqual([]);
      });

      it("answers a request line it cannot parse with a refusal", async () => {
        const { port } = new URL(issuer);
        const status = await new Promise<number | undefined>((done, reject) => {
          http
            .get(
              { hostname: "127.0.0.1", port: Number(port), path: "//" },
              (response) => {
                response.resume();
                done(response.statusCode);
              },
            )
            .on("error", reject);
        });
        expect(status).toBe(400);
        // Still listening.
        expect((await fetch(`${issuer}/healthz`)).status).toBe(200);
      });

      it("has no registration route to find", async () => {
        const response = await fetch(`${issuer}/reg`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            redirect_uris: ["https://evil.invalid/callback"],
            token_endpoint_auth_method: "none",
          }),
        });
        expect(response.status).toBe(404);
      });

      it("connects the official MCP SDK client from that metadata alone", async () => {
        const human = person();
        const metadata = await discoverAuthorizationServerMetadata(issuer);
        expect(metadata?.client_id_metadata_document_supported).toBe(true);
        const redirect = "http://127.0.0.1:53130/callback";
        const clientInformation = { client_id: CODEX };
        const { authorizationUrl, codeVerifier } = await startAuthorization(
          issuer,
          {
            ...(metadata === undefined ? {} : { metadata }),
            clientInformation,
            redirectUrl: redirect,
            scope: "artvenn:admin",
            state: "sdk-state",
            resource: new URL(RESOURCE),
          },
        );
        const jar = newJar();
        const opened = await fetch(authorizationUrl, { redirect: "manual" });
        jar.remember(opened);
        const uid = new URL(opened.headers.get("location") ?? "").pathname
          .split("/")
          .pop();
        const { secret } = await approve(uid ?? "", human);
        const back = await follow(jar, resumeUrl(uid ?? "", secret));
        const tokens = await exchangeAuthorization(issuer, {
          ...(metadata === undefined ? {} : { metadata }),
          clientInformation,
          authorizationCode: back.arrived?.searchParams.get("code") ?? "",
          codeVerifier,
          redirectUri: redirect,
          resource: new URL(RESOURCE),
        });
        expect(tokens.access_token).toMatch(/^artvenn_ct_/u);
        const renewed = await refreshAuthorization(issuer, {
          ...(metadata === undefined ? {} : { metadata }),
          clientInformation,
          refreshToken: tokens.refresh_token ?? "",
          resource: new URL(RESOURCE),
        });
        expect(renewed.access_token).toMatch(/^artvenn_ct_/u);
        expect(renewed.refresh_token).not.toBe(tokens.refresh_token);
      });
    });

    describe("what a client asks for", () => {
      it("cannot change what a consent grants", async () => {
        const opened = [
          "artvenn:admin offline_access",
          "artvenn:read",
          "artvenn:manage artvenn:read offline_access",
          "offline_access",
          "something-else",
          null,
        ];
        for (const scope of opened) {
          const { uid } = await begin(CLAUDE, CLAUDE_CALLBACK, { scope });
          expect(await decisions.read(uid), String(scope)).toMatchObject({
            oauthClientId: CLAUDE,
            resource: RESOURCE,
            capabilityScopes: ["artvenn:admin"],
            protocolScopes: ["offline_access"],
            preset: "operator",
            // The provider authenticates nobody, so it says nothing about who.
            humanAccountId: null,
            connectionId: null,
            ticketArmed: false,
            decision: null,
          });
        }
      });

      it.each([
        ["no scope at all", null],
        ["only a scope this profile has no use for", "artvenn:read"],
        ["only the refresh scope", "offline_access"],
        ["the full scope", "artvenn:admin offline_access"],
      ])("still connects a client asking for %s", async (_name, scope) => {
        const human = person();
        const { connectionId, tokens } = await connect(
          CODEX,
          "http://127.0.0.1:53131/callback",
          human,
          { scope },
        );
        expect(tokens.access_token).toMatch(/^artvenn_ct_/u);
        expect(tokens.refresh_token).toBeTruthy();
        expect((await grantsOf(connectionId)).length).toBe(1);
      });

      it("does not bounce a client that asks for openid, and its id_token says only who authorized", async () => {
        const human = person();
        const { connectionId, tokens } = await connect(
          CLAUDE,
          CLAUDE_CALLBACK,
          human,
          { scope: "openid artvenn:admin offline_access" },
        );
        expect(tokens.access_token).toMatch(/^artvenn_ct_/u);
        const stored = await control.readForAuthorization(connectionId);
        expect(stored?.grant?.capabilityScopes).toEqual(["artvenn:admin"]);
        expect(stored?.grant?.protocolScopes).toEqual(["offline_access"]);
        const claims = JSON.parse(
          Buffer.from(
            (tokens.id_token ?? "").split(".")[1] ?? "",
            "base64url",
          ).toString("utf8"),
        ) as Record<string, unknown>;
        expect(Object.keys(claims).sort()).toEqual([
          "aud",
          "exp",
          "iat",
          "iss",
          "sub",
        ]);
        expect(claims.sub).toBe(human);
        // There is no user information to ask for with it.
        const answer = await fetch(`${issuer}/me`, {
          headers: { authorization: `Bearer ${tokens.access_token ?? ""}` },
        });
        expect(answer.status).toBe(404);
      });

      it.each([
        ["another resource", "https://foreign.invalid/api/mcp"],
        ["our host at another path", `${CONSENT_BASE}/other`],
      ])("refuses %s without a row", async (_name, resource) => {
        const before = await consentCount();
        const url = authorizeUrl(CLAUDE, CLAUDE_CALLBACK, {
          verifier: "v".repeat(43),
          state: "s",
          resource,
        });
        const response = await fetch(url, { redirect: "manual" });
        const location = new URL(response.headers.get("location") ?? issuer);
        expect(location.origin).toBe("https://claude.ai");
        expect(location.searchParams.get("error")).toBe("invalid_target");
        expect(await consentCount()).toBe(before);
      });

      it("takes an omitted resource as the one it serves", async () => {
        const { uid } = await begin(CLAUDE, CLAUDE_CALLBACK, {
          resource: null,
        });
        expect((await decisions.read(uid))?.resource).toBe(RESOURCE);
      });

      it("connects with the resource left out, and with it repeated, all the way to a token", async () => {
        const omitted = await connect(CLAUDE, CLAUDE_CALLBACK, person(), {
          resource: null,
        });
        expect(omitted.tokens.access_token).toMatch(/^artvenn_ct_/u);
        const stored = await control.readForAuthorization(omitted.connectionId);
        expect(stored?.grant?.resource).toBe(RESOURCE);

        // A token request may leave it out as well.
        const started = await begin(CHATGPT, CHATGPT_CALLBACK);
        const { secret } = await approve(started.uid, person());
        const back = await follow(started.jar, resumeUrl(started.uid, secret));
        const tokens = await post({
          grant_type: "authorization_code",
          client_id: CHATGPT,
          code: back.arrived?.searchParams.get("code") ?? "",
          redirect_uri: CHATGPT_CALLBACK,
          code_verifier: started.verifier,
        });
        expect(tokens.access_token).toMatch(/^artvenn_ct_/u);

        const twice = await begin(CODEX, "http://127.0.0.1:53132/callback", {
          repeatResource: true,
        });
        const again = await approve(twice.uid, person());
        const home = await follow(
          twice.jar,
          resumeUrl(twice.uid, again.secret),
        );
        expect(home.arrived?.searchParams.get("error")).toBeNull();
        const repeated = await exchange(
          twice,
          home.arrived?.searchParams.get("code") ?? "",
        );
        expect(repeated.access_token).toMatch(/^artvenn_ct_/u);
      });
    });

    describe("refreshing", () => {
      it("rotates, needs no person, and leaves the connection alone", async () => {
        const human = person();
        const { tokens, connectionId } = await connect(
          CLAUDE,
          CLAUDE_CALLBACK,
          human,
        );
        const first = await refresh(CLAUDE, tokens.refresh_token ?? "");
        expect(first.error).toBeUndefined();
        expect(first.access_token).toMatch(/^artvenn_ct_/u);
        expect(first.access_token).not.toBe(tokens.access_token);
        expect(first.refresh_token).toBeTruthy();
        expect(first.refresh_token).not.toBe(tokens.refresh_token);
        expect(first.expires_in).toBe(3600);
        const stored = await control.readForAuthorization(connectionId);
        expect(stored?.connection.generation).toBe(1);
        expect(await grantsOf(connectionId)).toHaveLength(1);
      });

      it("refuses another client's refresh token", async () => {
        const { tokens } = await connect(CLAUDE, CLAUDE_CALLBACK, person());
        const stolen = await refresh(CHATGPT, tokens.refresh_token ?? "");
        expect(stolen.status).toBe(400);
        expect(stolen.error).toBe("invalid_grant");
      });

      it("refuses a code twice, and a code with the wrong verifier", async () => {
        const started = await begin(CLAUDE, CLAUDE_CALLBACK);
        const { secret } = await approve(started.uid, person());
        const back = await follow(started.jar, resumeUrl(started.uid, secret));
        const code = back.arrived?.searchParams.get("code") ?? "";
        const wrong = await post({
          grant_type: "authorization_code",
          client_id: CLAUDE,
          code,
          redirect_uri: CLAUDE_CALLBACK,
          code_verifier: randomBytes(32).toString("base64url"),
          resource: RESOURCE,
        });
        expect(wrong.error).toBe("invalid_grant");

        const started2 = await begin(CLAUDE, CLAUDE_CALLBACK);
        const second = await approve(started2.uid, person());
        const back2 = await follow(
          started2.jar,
          resumeUrl(started2.uid, second.secret),
        );
        const code2 = back2.arrived?.searchParams.get("code") ?? "";
        expect((await exchange(started2, code2)).error).toBeUndefined();
        expect((await exchange(started2, code2)).error).toBe("invalid_grant");
      });

      it("answers invalid_grant after a disconnect, and mints nothing", async () => {
        const human = person();
        const { tokens, connectionId } = await connect(
          CLAUDE,
          CLAUDE_CALLBACK,
          human,
        );
        await disconnect(connectionId);
        const { rows: before } = await pool.query(
          "SELECT count(*)::int AS n FROM community.agent_connection_wrappers",
        );
        failures.length = 0;
        const answer = await refresh(CLAUDE, tokens.refresh_token ?? "");
        expect(answer.status).toBe(400);
        expect(answer).toMatchObject({ error: "invalid_grant" });
        expect(answer.access_token).toBeUndefined();
        expect(answer.refresh_token).toBeUndefined();
        const { rows: after } = await pool.query(
          "SELECT count(*)::int AS n FROM community.agent_connection_wrappers",
        );
        expect(after).toEqual(before);
        // An ordinary answer, not an alarm.
        expect(failures).toEqual([]);
      });

      it("answers invalid_grant for the code too, when a disconnect beat the exchange", async () => {
        const started = await begin(CLAUDE, CLAUDE_CALLBACK);
        const { secret, connectionId } = await approve(started.uid, person());
        const back = await follow(started.jar, resumeUrl(started.uid, secret));
        await disconnect(connectionId);
        const answer = await exchange(
          started,
          back.arrived?.searchParams.get("code") ?? "",
        );
        expect(answer).toMatchObject({ status: 400, error: "invalid_grant" });
      });

      it("treats a failed currency check as a fault, not as a stale grant", async () => {
        const { tokens } = await connect(CLAUDE, CLAUDE_CALLBACK, person());
        failures.length = 0;
        outage = (text) =>
          text.includes("c.generation=g.generation_at_consent");
        const response = await fetch(`${issuer}/token`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            client_id: CLAUDE,
            refresh_token: tokens.refresh_token ?? "",
          }),
        });
        expect(response.status).toBe(500);
        expect(failures).toEqual(["WRAP_PERSISTENCE_FAILED"]);
      });

      it("does not call a grant current for another status, issuer or environment", async () => {
        // Each clause on its own, with the generation still matching.
        const awaiting = await connect(CLAUDE, CLAUDE_CALLBACK, person());
        const stored = await control.read(awaiting.connectionId);
        expect(
          await control.compareAndSet(
            awaiting.connectionId,
            stored?.version ?? 0,
            {
              ...stored!.connection,
              status: "awaiting-consent",
              consentedAt: null,
            },
          ),
        ).not.toBeNull();
        expect(
          await refresh(CLAUDE, awaiting.tokens.refresh_token ?? ""),
        ).toMatchObject({ status: 400, error: "invalid_grant" });

        const revoked = await connect(CLAUDE, CLAUDE_CALLBACK, person());
        const live = await control.read(revoked.connectionId);
        expect(
          await control.compareAndSet(
            revoked.connectionId,
            live?.version ?? 0,
            {
              ...live!.connection,
              status: "revoked",
              revokedAt: new Date().toISOString(),
            },
          ),
        ).not.toBeNull();
        expect(
          await refresh(CLAUDE, revoked.tokens.refresh_token ?? ""),
        ).toMatchObject({ status: 400, error: "invalid_grant" });

        const started = await begin(CLAUDE, CLAUDE_CALLBACK);
        const elsewhere = await approve(started.uid, person(), {
          environment: "synthetic",
        });
        const back = await follow(
          started.jar,
          resumeUrl(started.uid, elsewhere.secret),
        );
        expect(
          await exchange(started, back.arrived?.searchParams.get("code") ?? ""),
        ).toMatchObject({ status: 400, error: "invalid_grant" });

        // A second grant at the same generation, the connection pointing at it.
        const replaced = await connect(CLAUDE, CLAUDE_CALLBACK, person());
        const current = await control.readForAuthorization(
          replaced.connectionId,
        );
        const grantId = `grant-${hex(12)}`;
        expect(
          await server.bundle.connections.createGrant({
            ...current!.grant!,
            grantId,
          }),
        ).toBe(true);
        expect(
          await server.bundle.connections.setCurrentGrant(
            replaced.connectionId,
            grantId,
            current!.connection.generation,
          ),
        ).toBe(true);
        expect(
          await refresh(CLAUDE, replaced.tokens.refresh_token ?? ""),
        ).toMatchObject({ status: 400, error: "invalid_grant" });

        // The same keys and database under another issuer name.
        const other = await startIssuer();
        try {
          const { tokens } = await connect(CLAUDE, CLAUDE_CALLBACK, person());
          const response = await fetch(`${other.origin}/token`, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              grant_type: "refresh_token",
              client_id: CLAUDE,
              refresh_token: tokens.refresh_token ?? "",
            }),
          });
          expect(response.status).toBe(400);
          expect(await response.json()).toEqual({ error: "invalid_grant" });
        } finally {
          await other.close();
        }
      });

      it("lets a tool end its own connection by revoking its refresh token", async () => {
        const { tokens } = await connect(CLAUDE, CLAUDE_CALLBACK, person());
        const response = await fetch(`${issuer}/token/revocation`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: CLAUDE,
            token: tokens.refresh_token ?? "",
          }),
        });
        expect(response.status).toBe(200);
        await until(
          async () =>
            (await wrapperRow(tokens.access_token ?? ""))?.invalidated_at !==
            null,
        );
        expect((await refresh(CLAUDE, tokens.refresh_token ?? "")).error).toBe(
          "invalid_grant",
        );
      });

      const revokeToken = (clientId: string, token: string) =>
        fetch(`${issuer}/token/revocation`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ client_id: clientId, token }),
        });

      it("lets a tool end its own connection by revoking the access token it holds", async () => {
        const { tokens } = await connect(CLAUDE, CLAUDE_CALLBACK, person());
        const response = await revokeToken(CLAUDE, tokens.access_token ?? "");
        expect(response.status).toBe(200);
        expect(
          (await wrapperRow(tokens.access_token ?? ""))?.invalidated_at,
        ).not.toBeNull();
        expect((await refresh(CLAUDE, tokens.refresh_token ?? "")).error).toBe(
          "invalid_grant",
        );
      });

      it("stops nothing for another client's access token, or for one it never issued", async () => {
        const { tokens } = await connect(CLAUDE, CLAUDE_CALLBACK, person());
        for (const [clientId, token] of [
          [CHATGPT, tokens.access_token ?? ""],
          [CLAUDE, `artvenn_ct_${randomBytes(32).toString("base64url")}`],
        ] as const)
          expect((await revokeToken(clientId, token)).status).toBe(200);
        expect(
          (await wrapperRow(tokens.access_token ?? ""))?.invalidated_at,
        ).toBeNull();
        expect(
          (await refresh(CLAUDE, tokens.refresh_token ?? "")).error,
        ).toBeUndefined();
      });

      it("does not claim to have stopped a token when it could not", async () => {
        const { tokens } = await connect(CLAUDE, CLAUDE_CALLBACK, person());
        failures.length = 0;
        outage = (text) => text.includes("SET invalidated_at");
        const response = await revokeToken(CLAUDE, tokens.access_token ?? "");
        expect(response.status).toBe(500);
        expect(failures).toEqual(["WRAPPER_REVOCATION_FAILED"]);
      });

      it("keeps the lifetimes the amendment names", async () => {
        const jar = newJar();
        const before = Date.now();
        const started = await begin(CLAUDE, CLAUDE_CALLBACK, { jar });
        const minutes = (ms: number | null) =>
          Math.round(((ms ?? 0) - before) / 60_000);
        expect(minutes(jar.expiresAt("_interaction"))).toBe(30);
        const consent = await decisions.read(started.uid);
        expect(minutes(Date.parse(consent?.expiresAt ?? ""))).toBe(30);

        const { secret } = await approve(started.uid, person());
        const back = await follow(jar, resumeUrl(started.uid, secret));
        expect(minutes(jar.expiresAt("_session"))).toBe(60);
        const code = back.arrived?.searchParams.get("code") ?? "";

        // A code lasts a minute.
        vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
        vi.advanceTimersByTime(61_000);
        expect((await exchange(started, code)).error).toBe("invalid_grant");
        vi.useRealTimers();

        const { tokens } = await connect(CHATGPT, CHATGPT_CALLBACK, person());
        expect(tokens.expires_in).toBe(3600);
        const wrapper = await wrapperRow(tokens.access_token ?? "");
        expect(
          Math.round((wrapper?.expires_at.getTime() ?? 0) - Date.now()) /
            60_000,
        ).toBeCloseTo(60, 0);
      });

      it("tolerates a second use for 30 seconds, then revokes and kills live access tokens", async () => {
        const human = person();
        const { tokens, connectionId } = await connect(
          CLAUDE,
          CLAUDE_CALLBACK,
          human,
        );
        const original = tokens.refresh_token ?? "";
        // Only the date, so sockets and timers run as usual.
        vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
        const first = await refresh(CLAUDE, original);
        expect(first.error).toBeUndefined();

        vi.advanceTimersByTime(29_000);
        const race = await refresh(CLAUDE, original);
        expect(race.error).toBeUndefined();
        expect(race.access_token).not.toBe(first.access_token);
        for (const token of [
          tokens.access_token,
          first.access_token,
          race.access_token,
        ])
          expect((await wrapperRow(token ?? ""))?.invalidated_at).toBeNull();
        expect(await grantsOf(connectionId)).toHaveLength(1);

        vi.advanceTimersByTime(2_000);
        const replay = await refresh(CLAUDE, original);
        expect(replay).toMatchObject({ status: 400, error: "invalid_grant" });

        await until(async () =>
          (
            await Promise.all(
              [tokens.access_token, first.access_token, race.access_token].map(
                (token) => wrapperRow(token ?? ""),
              ),
            )
          ).every((row) => row?.invalidated_at !== null),
        );
        // The chain is gone whichever branch asks next.
        for (const branch of [first.refresh_token, race.refresh_token])
          expect((await refresh(CLAUDE, branch ?? "")).error).toBe(
            "invalid_grant",
          );
        // Revoked where the provider keeps it, and the snapshot stays the ledger.
        expect(await grantsOf(connectionId)).toHaveLength(1);
      });

      it("records it when live tokens could not be stopped", async () => {
        const { tokens } = await connect(CLAUDE, CLAUDE_CALLBACK, person());
        const original = tokens.refresh_token ?? "";
        vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
        await refresh(CLAUDE, original);
        vi.advanceTimersByTime(31_000);
        failures.length = 0;
        outage = (text) => text.includes("SET invalidated_at");
        expect((await refresh(CLAUDE, original)).error).toBe("invalid_grant");
        await until(async () => failures.length > 0);
        expect(failures).toEqual(["WRAPPER_INVALIDATION_FAILED"]);
      });

      it("ends a connection idle past 30 days, and renews one in use up to 180 days", async () => {
        const idle = await connect(CLAUDE, CLAUDE_CALLBACK, person());
        vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
        vi.advanceTimersByTime(30 * DAY + 60_000);
        expect(
          await refresh(CLAUDE, idle.tokens.refresh_token ?? ""),
        ).toMatchObject({ status: 400, error: "invalid_grant" });
        vi.useRealTimers();

        const busy = await connect(CHATGPT, CHATGPT_CALLBACK, person());
        vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
        let token = busy.tokens.refresh_token ?? "";
        // Every 29 days: never idle, and all the way up to the hard limit.
        for (let used = 29; used < 180; used += 29) {
          vi.advanceTimersByTime(29 * DAY);
          const answer = await refresh(CHATGPT, token);
          expect(answer.error, `day ${used}`).toBeUndefined();
          token = answer.refresh_token ?? "";
        }
        // Day 174. Past day 180 the grant itself is over, however fresh the token.
        vi.advanceTimersByTime(7 * DAY);
        expect(await refresh(CHATGPT, token)).toMatchObject({
          status: 400,
          error: "invalid_grant",
        });
      });
    });

    describe("connecting again", () => {
      it("shows a fresh screen in the same browser every time, for a hosted client too", async () => {
        for (const [clientId, redirect] of [
          [CLAUDE, CLAUDE_CALLBACK],
          [CODEX, "http://127.0.0.1:53140/callback"],
        ] as const) {
          const human = person();
          const jar = newJar();
          const first = await connect(clientId, redirect, human, { jar });
          // A live provider session and a live grant, the case a `web` client
          // would answer with a silent code.
          expect(jar.holds("_session")).toBe(true);

          const again = await begin(clientId, redirect, { jar });
          expect(again.uid).not.toBe(first.started.uid);
          expect((await decisions.read(again.uid))?.decision).toBeNull();

          const { secret } = await approve(again.uid, human);
          const back = await follow(jar, resumeUrl(again.uid, secret));
          const code = back.arrived?.searchParams.get("code") ?? "";
          const tokens = await exchange(again, code);
          expect(tokens.access_token).toMatch(/^artvenn_ct_/u);
          const stored = await control.readForAuthorization(first.connectionId);
          expect(stored?.connection.generation).toBe(2);
          expect(stored?.grant?.generationAtConsent).toBe(2);

          // The older tokens stopped: one person and one tool is one connection.
          expect(
            await refresh(clientId, first.tokens.refresh_token ?? ""),
          ).toMatchObject({ status: 400, error: "invalid_grant" });
          // And the new ones work.
          expect(
            (await refresh(clientId, tokens.refresh_token ?? "")).error,
          ).toBeUndefined();
        }
      });

      it("shows a fresh screen after a disconnect, and then works", async () => {
        for (const [clientId, redirect] of [
          [CHATGPT, CHATGPT_CALLBACK],
          [CLAUDE_CODE, "http://localhost:53141/callback"],
        ] as const) {
          const human = person();
          const jar = newJar();
          const first = await connect(clientId, redirect, human, { jar });
          await disconnect(first.connectionId);

          const again = await begin(clientId, redirect, { jar });
          expect((await decisions.read(again.uid))?.decision).toBeNull();
          const { secret } = await approve(again.uid, human);
          const back = await follow(jar, resumeUrl(again.uid, secret));
          const tokens = await exchange(
            again,
            back.arrived?.searchParams.get("code") ?? "",
          );
          expect(tokens.access_token).toMatch(/^artvenn_ct_/u);
          const stored = await control.readForAuthorization(first.connectionId);
          expect(stored?.connection).toMatchObject({
            status: "authorized",
            generation: 3,
          });
          expect(
            await refresh(clientId, first.tokens.refresh_token ?? ""),
          ).toMatchObject({ error: "invalid_grant" });
        }
      });

      it("ends the first computer when the same person connects from a second", async () => {
        const human = person();
        const first = await connect(
          CODEX,
          "http://127.0.0.1:53142/callback",
          human,
        );
        const second = await connect(
          CODEX,
          "http://127.0.0.1:53143/callback",
          human,
        );
        expect(second.connectionId).toBe(first.connectionId);
        expect(
          await refresh(CODEX, first.tokens.refresh_token ?? ""),
        ).toMatchObject({ error: "invalid_grant" });
        expect(
          (await refresh(CODEX, second.tokens.refresh_token ?? "")).error,
        ).toBeUndefined();
      });

      it("finishes for the right person when two administrators share a browser", async () => {
        const jar = newJar();
        const first = await connect(CLAUDE, CLAUDE_CALLBACK, person(), { jar });
        expect(jar.holds("_session")).toBe(true);

        const other = person();
        const started = await begin(CHATGPT, CHATGPT_CALLBACK, { jar });
        const { secret, connectionId } = await approve(started.uid, other);
        // The provider session belongs to the first person, so the library asks
        // for a logout first. A browser submits this form by itself.
        const asked = await follow(jar, resumeUrl(started.uid, secret));
        expect(asked.status).toBe(200);
        const action = /action="([^"]+)"/u.exec(asked.page)?.[1] ?? "";
        const xsrf = /name="xsrf" value="([^"]+)"/u.exec(asked.page)?.[1] ?? "";
        expect(new URL(action).pathname).toBe("/session/end/confirm");
        const confirm = new URL(action);
        const confirmed = await fetch(confirm, {
          method: "POST",
          redirect: "manual",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            cookie: jar.header(confirm),
          },
          body: new URLSearchParams({ xsrf, logout: "yes" }),
        });
        jar.remember(confirmed);
        const onward = new URL(confirmed.headers.get("location") ?? "", issuer);
        const back = await follow(jar, onward);
        const code = back.arrived?.searchParams.get("code") ?? "";
        expect(code).not.toBe("");
        const tokens = await exchange(started, code);
        expect(tokens.access_token).toMatch(/^artvenn_ct_/u);

        const stored = await control.readForAuthorization(connectionId);
        expect(stored?.grant?.humanSubject).toBe(other);
        // The first person's connection was not touched by it.
        expect(
          (await refresh(CLAUDE, first.tokens.refresh_token ?? "")).error,
        ).toBeUndefined();
      });
    });

    describe("resume needs both the provider cookie and the one-time secret", () => {
      /** Two browsers: the stranger started the request, the owner clicked allow. */
      const phished = async (clientId = CLAUDE, redirect = CLAUDE_CALLBACK) => {
        const human = person();
        const stranger = await begin(clientId, redirect);
        const owner = newJar();
        const { secret, connectionId } = await approve(stranger.uid, human);
        return { human, stranger, owner, secret, connectionId };
      };

      it("voids the consent when the secret arrives without the cookie, and the cookie's holder gets nothing afterwards", async () => {
        const { human, stranger, owner, secret, connectionId } =
          await phished();
        resumes.length = 0;

        const clicked = await follow(owner, resumeUrl(stranger.uid, secret));
        expect(clicked.status).toBe(400);
        expect(clicked.arrived).toBeNull();
        expect(clicked.page).toContain(VOIDED_PAGE);
        expect(clicked.page).toContain("告诉其他管理员");
        expect(resumes).toEqual(["CONSENT_VOIDED"]);
        // Who clicked stays on the row for the audit; nothing was granted.
        expect(await stateOf(stranger.uid)).toEqual({
          decision: "approved",
          resumed: true,
          grantId: null,
          human,
        });
        expect(await grantsOf(connectionId)).toEqual([]);

        // The stranger's browser now holds a cookie and an empty hand.
        const afterwards = await follow(stranger.jar, resumeUrl(stranger.uid));
        expect(afterwards.arrived).toBeNull();
        expect(afterwards.page).toContain(REFUSED_PAGE);

        // Even if the secret leaked to them later, it is spent.
        const leaked = await follow(
          stranger.jar,
          resumeUrl(stranger.uid, secret),
        );
        expect(leaked.arrived?.searchParams.get("code") ?? null).toBeNull();
        expect(await grantsOf(connectionId)).toEqual([]);

        // A voided allow leaves nothing to list as connected.
        const listed = await control.listAuthorized();
        expect(listed.map(({ connection }) => connection.id)).not.toContain(
          connectionId,
        );
      });

      it("refuses the cookie without the secret, changes nothing, and the real pair still finishes", async () => {
        const started = await begin(CLAUDE, CLAUDE_CALLBACK);
        const human = person();
        const { secret, connectionId } = await approve(started.uid, human);
        resumes.length = 0;

        const alone = await follow(started.jar, resumeUrl(started.uid));
        expect(alone.status).toBe(400);
        expect(alone.arrived).toBeNull();
        expect(alone.page).toContain(REFUSED_PAGE);
        expect(resumes).toEqual(["RESUME_SECRET_REQUIRED"]);
        expect(await stateOf(started.uid)).toEqual({
          decision: "approved",
          resumed: false,
          grantId: null,
          human,
        });
        expect(await grantsOf(connectionId)).toEqual([]);

        // The refusal burned nothing for the browser that holds both.
        const both = await follow(started.jar, resumeUrl(started.uid, secret));
        expect(both.arrived?.searchParams.get("code")).toBeTruthy();
        expect((await stateOf(started.uid)).grantId).toBeTruthy();
        expect(await grantsOf(connectionId)).toHaveLength(1);
      });

      it("refuses a wrong secret with the cookie, and does not spend the approval", async () => {
        const started = await begin(CLAUDE, CLAUDE_CALLBACK);
        const { secret } = await approve(started.uid, person());
        for (const wrong of [
          mintResumeSecret().secret,
          "not-a-secret",
          `${secret}x`,
          "",
        ]) {
          const answer = await follow(
            started.jar,
            resumeUrl(started.uid, wrong),
          );
          expect(answer.arrived).toBeNull();
          expect(answer.page).toContain(REFUSED_PAGE);
          expect((await stateOf(started.uid)).resumed).toBe(false);
        }
        const both = await follow(started.jar, resumeUrl(started.uid, secret));
        expect(both.arrived?.searchParams.get("code")).toBeTruthy();
      });

      it("counts a repeated parameter as no secret", async () => {
        const started = await begin(CLAUDE, CLAUDE_CALLBACK);
        const { secret } = await approve(started.uid, person());
        const url = resumeUrl(started.uid, secret);
        url.searchParams.append(RESUME_SECRET_PARAMETER, secret);
        const twice = await follow(started.jar, url);
        expect(twice.arrived).toBeNull();
        expect(twice.page).toContain(REFUSED_PAGE);
        expect((await stateOf(started.uid)).resumed).toBe(false);
      });

      it("does not void for a wrong secret without the cookie, so a stranger cannot spend an approval", async () => {
        const { stranger, owner, secret } = await phished();
        for (const wrong of [mintResumeSecret().secret, "not-a-secret", ""]) {
          const answer = await follow(owner, resumeUrl(stranger.uid, wrong));
          expect(answer.page).toContain(REFUSED_PAGE);
          expect(answer.page).not.toContain(VOIDED_PAGE);
          expect((await stateOf(stranger.uid)).resumed).toBe(false);
        }
        // The real one still does, and only then.
        const real = await follow(owner, resumeUrl(stranger.uid, secret));
        expect(real.page).toContain(VOIDED_PAGE);
      });

      it("shows a plain page and changes nothing with neither", async () => {
        const started = await begin(CLAUDE, CLAUDE_CALLBACK);
        const human = person();
        await approve(started.uid, human);
        const before = await stateOf(started.uid);
        const answer = await follow(newJar(), resumeUrl(started.uid));
        expect(answer.status).toBe(400);
        expect(answer.page).toContain(REFUSED_PAGE);
        expect(await stateOf(started.uid)).toEqual(before);
        // For a name nobody ever issued, too.
        const unknown = await follow(newJar(), resumeUrl(`unknown-${hex(8)}`));
        expect(unknown.status).toBe(400);
        expect(unknown.page).toContain(REFUSED_PAGE);
      });

      it("serves its plain page with nothing to load and nothing to leak", async () => {
        const answer = await follow(newJar(), resumeUrl(`unknown-${hex(8)}`));
        expect(answer.headers.get("content-type")).toBe(
          "text/html; charset=utf-8",
        );
        expect(answer.headers.get("cache-control")).toBe("no-store");
        expect(answer.headers.get("referrer-policy")).toBe("no-referrer");
        expect(answer.headers.get("content-security-policy")).toBe(
          "default-src 'none'; frame-ancestors 'none'",
        );
        expect(answer.page).toContain('name="viewport"');
        expect(answer.page).not.toMatch(/<script|<link|<img|https?:/u);
      });

      it("serves the logout pages as plainly, and the routes still work", async () => {
        const plain = (answer: Awaited<ReturnType<typeof follow>>) => {
          expect(answer.status).toBe(200);
          expect(answer.headers.get("cache-control")).toBe("no-store");
          expect(answer.headers.get("content-type")).toBe(
            "text/html; charset=utf-8",
          );
          expect(answer.headers.get("referrer-policy")).toBe("no-referrer");
          expect(answer.headers.get("content-security-policy")).toBe(
            "default-src 'none'; frame-ancestors 'none'",
          );
          expect(answer.page).not.toMatch(
            /<script|<link|<img|<style|@import|fonts\./u,
          );
        };
        plain(await follow(newJar(), new URL(`${issuer}/session/end/success`)));

        const jar = newJar();
        const { tokens } = await connect(CLAUDE, CLAUDE_CALLBACK, person(), {
          jar,
        });
        expect(jar.holds("_session")).toBe(true);
        const asked = await follow(jar, new URL(`${issuer}/session/end`));
        plain(asked);
        const action = /action="([^"]+)"/u.exec(asked.page)?.[1] ?? "";
        const xsrf = /name="xsrf" value="([^"]+)"/u.exec(asked.page)?.[1] ?? "";
        expect(asked.page).toMatch(/form="op\.logoutForm" name="logout"/u);
        const confirm = new URL(action);
        expect(confirm.pathname).toBe("/session/end/confirm");
        const confirmed = await fetch(confirm, {
          method: "POST",
          redirect: "manual",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            cookie: jar.header(confirm),
          },
          body: new URLSearchParams({ xsrf, logout: "yes" }),
        });
        jar.remember(confirmed);
        expect(jar.holds("_session")).toBe(false);
        plain(
          await follow(
            jar,
            new URL(confirmed.headers.get("location") ?? "", issuer),
          ),
        );
        // What the page says: the tool is not touched by it.
        expect(
          (await refresh(CLAUDE, tokens.refresh_token ?? "")).error,
        ).toBeUndefined();
      });

      it("treats a cookie for a different interaction as no cookie, and leaves that one alone", async () => {
        // The administrator's own browser, already holding its own request.
        const own = await begin(CODEX, "http://127.0.0.1:53150/callback");
        const human = person();
        const theirs = await begin(CLAUDE, CLAUDE_CALLBACK);
        const { secret, connectionId } = await approve(theirs.uid, human);

        // A browser would not send this cookie on this path. A script can.
        const clicked = await follow(own.jar, resumeUrl(theirs.uid, secret), {
          replayAll: true,
        });
        expect(clicked.arrived).toBeNull();
        expect(clicked.page).toContain(VOIDED_PAGE);
        expect((await stateOf(theirs.uid)).grantId).toBeNull();
        expect(await grantsOf(connectionId)).toEqual([]);

        // The request this browser really started is untouched, and finishes.
        const mine = await approve(own.uid, human);
        const back = await follow(own.jar, resumeUrl(own.uid, mine.secret));
        expect(back.arrived?.searchParams.get("code")).toBeTruthy();
      });

      it("tells the tool access_denied on a denial, only in the browser that started it", async () => {
        const started = await begin(CLAUDE, CLAUDE_CALLBACK);
        const human = person();
        await deny(started.uid, human);

        const elsewhere = await follow(newJar(), resumeUrl(started.uid));
        expect(elsewhere.arrived).toBeNull();
        expect(elsewhere.page).toContain(REFUSED_PAGE);

        const answer = await follow(started.jar, resumeUrl(started.uid));
        expect(answer.arrived?.origin).toBe("https://claude.ai");
        expect(answer.arrived?.searchParams.get("error")).toBe("access_denied");
        expect(answer.arrived?.searchParams.get("code")).toBeNull();
      });

      it("refuses before any decision, whatever the browser holds", async () => {
        const started = await begin(CLAUDE, CLAUDE_CALLBACK);
        for (const secret of [undefined, mintResumeSecret().secret]) {
          const answer = await follow(
            started.jar,
            resumeUrl(started.uid, secret),
          );
          expect(answer.arrived).toBeNull();
          expect(answer.page).toContain(REFUSED_PAGE);
        }
        expect((await decisions.read(started.uid))?.decision).toBeNull();
      });

      it("cannot be resumed twice", async () => {
        const started = await begin(CLAUDE, CLAUDE_CALLBACK);
        const { secret, connectionId } = await approve(started.uid, person());
        const url = resumeUrl(started.uid, secret);
        const once = await follow(started.jar, url);
        expect(once.arrived?.searchParams.get("code")).toBeTruthy();
        const again = await follow(started.jar, url);
        expect(again.arrived?.searchParams.get("code") ?? null).toBeNull();
        expect(await grantsOf(connectionId)).toHaveLength(1);
      });

      it("denies a decision when the same connection was approved again meanwhile", async () => {
        // Still authorized, only further on: the case the generation pin is for.
        const human = person();
        const stale = await begin(CLAUDE, CLAUDE_CALLBACK);
        const approval = await approve(stale.uid, human);
        const fresh = await connect(CLAUDE, CLAUDE_CALLBACK, human);
        expect(fresh.connectionId).toBe(approval.connectionId);

        const answer = await follow(
          stale.jar,
          resumeUrl(stale.uid, approval.secret),
        );
        expect(answer.arrived?.searchParams.get("error")).toBe("access_denied");
        expect(answer.arrived?.searchParams.get("code")).toBeNull();
        expect(await grantsOf(approval.connectionId)).toHaveLength(1);
        expect(
          (await refresh(CLAUDE, fresh.tokens.refresh_token ?? "")).error,
        ).toBeUndefined();
      });

      it("denies a decision whose connection moved while the browser was away", async () => {
        const started = await begin(CLAUDE, CLAUDE_CALLBACK);
        const { secret, connectionId } = await approve(started.uid, person());
        await disconnect(connectionId);
        const answer = await follow(
          started.jar,
          resumeUrl(started.uid, secret),
        );
        expect(answer.arrived?.searchParams.get("error")).toBe("access_denied");
        expect(await grantsOf(connectionId)).toEqual([]);
      });

      it("does not take an outage for a stranger's browser", async () => {
        const started = await begin(CLAUDE, CLAUDE_CALLBACK);
        const { secret } = await approve(started.uid, person());
        failures.length = 0;
        outage = (_text, values) => values.includes("Interaction");
        const url = resumeUrl(started.uid, secret);
        const response = await fetch(url, {
          redirect: "manual",
          headers: { cookie: started.jar.header(url) },
        });
        expect(response.status).toBe(500);
        expect(failures).toEqual(["RESUME_FAILED"]);
        outage = null;
        expect((await stateOf(started.uid)).resumed).toBe(false);
        const both = await follow(started.jar, url);
        expect(both.arrived?.searchParams.get("code")).toBeTruthy();
      });

      it.each([
        ["a read-only row", { preset: "read-only" }],
        ["a row for another capability", { capability: "artvenn:read" }],
        [
          "a row for another resource",
          { resource: "https://other.invalid/mcp" },
        ],
        ["a row for another client", { client: CHATGPT }],
      ])(
        "will not finish %s, even with the cookie and the secret",
        async (_name, row) => {
          const started = await begin(CLAUDE, CLAUDE_CALLBACK);
          // Only reachable past the Admin and the CHECKs, so written by the owner.
          await pool.query(
            "DELETE FROM community.agent_connection_consents WHERE interaction_uid=$1",
            [started.uid],
          );
          await pool.query(
            `INSERT INTO community.agent_connection_consents
             (interaction_uid, oauth_client_id, resource, capability_scopes,
              protocol_scopes, preset, expires_at)
           VALUES ($1,$2,$3,$4,ARRAY['offline_access'],$5,
                   CURRENT_TIMESTAMP + interval '5 min')`,
            [
              started.uid,
              "client" in row ? row.client : CLAUDE,
              "resource" in row ? row.resource : RESOURCE,
              ["capability" in row ? row.capability : "artvenn:admin"],
              "preset" in row ? row.preset : "operator",
            ],
          );
          const { secret, connectionId } = await approve(started.uid, person());
          const answer = await follow(
            started.jar,
            resumeUrl(started.uid, secret),
          );
          expect(answer.arrived?.searchParams.get("error")).toBe(
            "access_denied",
          );
          expect(answer.arrived?.searchParams.get("code")).toBeNull();
          expect(await grantsOf(connectionId)).toEqual([]);
        },
      );
    });

    describe("the reaper", () => {
      it("removes only what has expired, and nothing anyone decided", async () => {
        const { Adapter } = server.bundle;
        // A wrapper past its expiry and one inside it. They are immutable, so
        // the first is made old by moving only the date past its hour.
        const old = await connect(CLAUDE, CLAUDE_CALLBACK, person());
        vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
        vi.advanceTimersByTime(61 * 60_000);
        const fresh = await connect(CHATGPT, CHATGPT_CALLBACK, person());

        // Past deadlines cannot be reached through the store.
        const seedConsent = async (
          expires: string,
          approved?: { readonly connectionId: string },
        ) => {
          const interaction = `reap-${hex(8)}`;
          await pool.query(
            `INSERT INTO community.agent_connection_consents
               (interaction_uid, oauth_client_id, resource, preset, issued_at,
                expires_at, ticket_digest, human_account_id, connection_id,
                decision, decided_at, granted_generation, resume_secret_digest)
             VALUES ($1,$2,$3,'operator',
                     CURRENT_TIMESTAMP - $4::interval - interval '30 minutes',
                     CURRENT_TIMESTAMP - $4::interval,
                     $5,$6,$7,$8,
                     CASE WHEN $8::text IS NULL THEN NULL
                          ELSE CURRENT_TIMESTAMP - $4::interval END,
                     $9,$10)`,
            [
              interaction,
              CLAUDE,
              RESOURCE,
              expires,
              approved === undefined ? null : hex(32),
              approved === undefined ? null : person(),
              approved?.connectionId ?? null,
              approved === undefined ? null : "approved",
              approved === undefined ? null : 1,
              approved === undefined ? null : hex(32),
            ],
          );
          return interaction;
        };
        const seeded = await Promise.all(
          [
            "Session",
            "Interaction",
            "AuthorizationCode",
            "AccessToken",
            "RefreshToken",
            "Grant",
          ].map(async (model) => {
            const adapter = new Adapter(model);
            const dead = `reap-dead-${hex(8)}`;
            const live = `reap-live-${hex(8)}`;
            await adapter.upsert(dead, { jti: dead }, -120);
            await adapter.upsert(live, { jti: live }, 600);
            return { adapter, dead, live };
          }),
        );
        const doomed = await seedConsent("2 days");
        const recent = await seedConsent("2 hours");
        const decided = await seedConsent("90 days", {
          connectionId: old.connectionId,
        });
        const live = await begin(CLAUDE, CLAUDE_CALLBACK);

        await reapExpiredArtifacts(server.bundle);

        for (const { adapter, dead, live: alive } of seeded) {
          expect(await adapter.find(dead)).toBeUndefined();
          expect(await adapter.find(alive)).toBeDefined();
        }
        expect(await wrapperRow(old.tokens.access_token ?? "")).toBeUndefined();
        expect(await wrapperRow(fresh.tokens.access_token ?? "")).toBeDefined();
        expect(await decisions.read(doomed)).toBeNull();
        expect(await decisions.read(recent)).not.toBeNull();
        expect(await decisions.read(decided)).not.toBeNull();
        expect(await decisions.read(live.uid)).not.toBeNull();
        // A connection and its snapshot are not artifacts.
        expect(await grantsOf(old.connectionId)).toHaveLength(1);
        // And a live connection still works after a sweep.
        expect(
          (await refresh(CHATGPT, fresh.tokens.refresh_token ?? "")).error,
        ).toBeUndefined();
      });
    });
  });
};
