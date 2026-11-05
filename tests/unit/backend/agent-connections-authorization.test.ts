import {
  CONNECTION_TOKEN_PREFIX,
  PRESET_CAPABILITY_SCOPES,
  PRESET_TOOLS,
  admitGrant,
  admitScopeClaim,
  canonicalCapabilityScopes,
  canonicalScopes,
  connectionAuth,
  isCimdClientId,
  isPreregisteredClientId,
  oauthClientIdSchema,
  toolGrantKey,
  connectionOverrideAuth,
  connectionsEnabled,
  verifyConnection,
} from "admin/agent-connections";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it, vi } from "vitest";

import type {
  AgentConnection,
  ConnectionRecord,
  ConsentSnapshot,
  VerifiedGrant,
} from "admin/agent-connections";
import type { PayloadRequest } from "payload";

/**
 * Agent Connections V1 (Issue #141 r9): the authentication boundary for a
 * browser-consented connection.
 *
 * These regressions exist because the dangerous failures here are all
 * "succeeds when it should not": a revoked token that still works, a
 * read-only connection that can write, a forged connection token that gets
 * retried as a legacy API key, or an OAuth failure that quietly lands on an
 * Owner session.
 */

const ISSUER = "https://auth.artvenn.invalid";
const RESOURCE = "https://admin.artvenn.invalid/api/mcp";
const ENVIRONMENT = "development";
const CLIENT_ID = "artvenn-claude-desktop-01";
/** The canonical scope set a read-only token must carry. Nothing more, nothing less. */
/** External capability scopes — the published OAuth contract, not the Backend's. */
const READ_ONLY_SCOPES = ["artvenn:read"];
const MANAGEMENT_SCOPES = ["artvenn:manage", "artvenn:read"];
/** The Backend's internal seven, which a token must never name. */
const INTERNAL_SCOPES = ["comments:read", "content:read", "users:read"];

const connection = (
  overrides: Partial<AgentConnection> = {},
): AgentConnection => ({
  id: "conn-1",
  principalLabel: "agent-phone",
  humanAccountId: "user-owner",
  client: "claude",
  environment: ENVIRONMENT,
  oauthClientId: CLIENT_ID,
  consentedAt: "2026-09-18T00:00:00Z",
  preset: "read-only",
  status: "authorized",
  generation: 3,
  revokedAt: null,
  ...overrides,
});

/**
 * The frozen consent snapshot. r14 moved identity here: `admitGrant` reads
 * the subject, the client and the consented preset off this row rather than
 * off the connection, whose own copies stay writable by design.
 *
 * It defaults to AGREEING with the connection, so a test that wants a
 * mismatch has to say which side moved — which is the distinction the change
 * exists to make visible.
 */
const consent = (
  overrides: Partial<ConsentSnapshot> = {},
  from: AgentConnection = connection(),
): ConsentSnapshot => ({
  grantId: "g-1",
  connectionId: from.id,
  generationAtConsent: from.generation,
  oauthClientId: from.oauthClientId,
  humanSubject: from.humanAccountId,
  issuer: ISSUER,
  resource: RESOURCE,
  presetAtConsent: from.preset,
  // Defaults to the canonical set for the preset, so a test wanting an
  // incoherent consent has to say so deliberately.
  capabilityScopes: PRESET_CAPABILITY_SCOPES[from.preset],
  consentedAt: from.consentedAt ?? "2026-09-18T00:00:00Z",
  ...overrides,
});

/** What the store hands the boundary. */
const record = (
  from: AgentConnection = connection(),
  grantOverrides: Partial<ConsentSnapshot> | null = {},
): ConnectionRecord => ({
  connection: from,
  grant: grantOverrides === null ? null : consent(grantOverrides, from),
});

const grant = (overrides: Partial<VerifiedGrant> = {}): VerifiedGrant => ({
  connectionId: "conn-1",
  subject: "user-owner",
  clientId: CLIENT_ID,
  resource: RESOURCE,
  issuer: ISSUER,
  scopes: READ_ONLY_SCOPES,
  generation: 3,
  expiresAt: "2099-01-01T00:00:00Z",
  ...overrides,
});

const expected = {
  issuer: ISSUER,
  resource: RESOURCE,
  environment: ENVIRONMENT,
};

const request = (authorization?: string): PayloadRequest =>
  ({
    headers: new Headers(
      authorization === undefined ? {} : { Authorization: authorization },
    ),
  }) as unknown as PayloadRequest;

const token = (suffix = "good") => `${CONNECTION_TOKEN_PREFIX}${suffix}`;
/** Composed rather than written out, so no fixture reads as a credential. */
const header = (value: string) => ["Bearer", value].join(" ");
const notOurs = ["ordinary", "payload", "api", "key"].join("-");

const auth = (
  over: {
    verify?: (presented: string) => Promise<VerifiedGrant | null>;
    read?: (id: string) => Promise<ConnectionRecord | null>;
  } = {},
) =>
  connectionAuth({
    verifyAccessToken: over.verify ?? (async () => grant()),
    readConnection: over.read ?? (async () => record()),
    issuer: ISSUER,
    resource: RESOURCE,
    environment: ENVIRONMENT,
  });

describe("admitGrant", () => {
  it("admits a current grant whose issuer, resource, environment and generation all agree", () => {
    expect(
      admitGrant(grant(), record(connection()), expected).connection.id,
    ).toBe("conn-1");
  });

  it("refuses a token minted by another issuer, so a look-alike authorization server cannot mint access", () => {
    expect(() =>
      admitGrant(
        grant({ issuer: "https://evil.invalid" }),
        record(connection()),
        expected,
      ),
    ).toThrow("CONNECTION_ISSUER_MISMATCH");
  });

  it("refuses a token addressed to another resource, so a token for a different ArtVenn endpoint is not replayable here", () => {
    expect(() =>
      admitGrant(
        grant({ resource: "https://other.invalid/api/mcp" }),
        record(connection()),
        expected,
      ),
    ).toThrow("CONNECTION_RESOURCE_MISMATCH");
  });

  it("refuses a grant for a connection in another environment", () => {
    expect(() =>
      admitGrant(
        grant(),
        record(connection({ environment: "production" })),
        expected,
      ),
    ).toThrow("CONNECTION_ENVIRONMENT_MISMATCH");
  });

  it("refuses a missing connection rather than inventing one", () => {
    expect(() => admitGrant(grant(), null, expected)).toThrow(
      "CONNECTION_NOT_FOUND",
    );
  });

  it("refuses a revoked connection even while its token is unexpired", () => {
    expect(() =>
      admitGrant(
        grant(),
        record(
          connection({ status: "revoked", revokedAt: "2026-09-18T00:00:00" }),
        ),
        expected,
      ),
    ).toThrow("CONNECTION_REVOKED");
  });

  it("refuses a connection still awaiting consent, so a grant cannot precede the human", () => {
    expect(() =>
      admitGrant(
        grant(),
        record(connection({ status: "awaiting-consent" })),
        expected,
      ),
    ).toThrow("CONNECTION_NOT_AUTHORIZED");
  });

  it("refuses a token from a previous generation: disconnect denies an unexpired token without waiting for a clock", () => {
    expect(() =>
      admitGrant(
        grant({ generation: 2 }),
        record(connection({ generation: 3 })),
        expected,
      ),
    ).toThrow("CONNECTION_GENERATION_STALE");
  });

  it("refuses a token whose connection id disagrees with the record it resolved", () => {
    expect(() =>
      admitGrant(grant(), record(connection({ id: "conn-2" })), expected),
    ).toThrow("CONNECTION_MISMATCH");
  });
});

describe("connectionAuth", () => {
  it("leaves a request with no bearer to the legacy resolver, so existing API-key callers are untouched", async () => {
    const legacy = vi.fn(async () => ({ user: { id: "legacy" } }) as never);
    await auth()(request(), legacy);
    expect(legacy).toHaveBeenCalledOnce();
  });

  it("leaves a legacy API key to the legacy resolver: a bearer that is not ours is not ours", async () => {
    const legacy = vi.fn(async () => ({ user: { id: "legacy" } }) as never);
    await auth()(request(header(notOurs)), legacy);
    expect(legacy).toHaveBeenCalledOnce();
  });

  it("never falls back to the legacy resolver when OUR token fails, so a forged connection token cannot be retried as an API key", async () => {
    const legacy = vi.fn(async () => ({ user: { id: "legacy" } }) as never);
    await expect(
      auth({ verify: async () => null })(
        request(header(token("forged"))),
        legacy,
      ),
    ).rejects.toThrow();
    expect(legacy).not.toHaveBeenCalled();
  });

  it("never falls back when the connection is revoked", async () => {
    const legacy = vi.fn(async () => ({ user: { id: "legacy" } }) as never);
    await expect(
      auth({ read: async () => record(connection({ status: "revoked" })) })(
        request(header(token())),
        legacy,
      ),
    ).rejects.toThrow();
    expect(legacy).not.toHaveBeenCalled();
  });

  it("resolves a restricted principal the existing tools already understand, and never an Owner", async () => {
    const settings = await auth()(
      request(header(token())),
      async () => ({}) as never,
    );
    const user = settings.user as unknown as Record<string, unknown>;
    expect(user.agentPrincipal).toBe("agent-phone");
    expect(user.role).not.toBe("owner");
    expect(user._strategy).toBe("artvenn-connection");
  });

  it("grants a read-only connection exactly the four read tools, so management tools are absent from tools/list", async () => {
    const settings = await auth()(
      request(header(token())),
      async () => ({}) as never,
    );
    const tools = settings["payload-mcp-tool"] ?? {};
    expect(Object.keys(tools).sort()).toEqual(
      [...PRESET_TOOLS["read-only"]].map(toolGrantKey).sort(),
    );
    expect(tools.artvennFeaturedPrepare).toBeUndefined();
    expect(tools.artvennOperationsExecute).toBeUndefined();
  });

  it("grants a management connection the execute tools but still never an approval tool", async () => {
    const settings = await auth({
      read: async () => record(connection({ preset: "management" })),
      verify: async () => grant({ scopes: MANAGEMENT_SCOPES }),
    })(request(header(token())), async () => ({}) as never);
    const tools = settings["payload-mcp-tool"] ?? {};
    expect(tools.artvennOperationsExecute).toBe(true);
    expect(tools.artvennFeaturedPrepare).toBe(true);
    expect(Object.keys(tools).some((name) => /approve/iu.test(name))).toBe(
      false,
    );
  });

  it("refuses a token whose scope claim is wider than its connection's preset, instead of silently narrowing it", async () => {
    await expect(
      auth({ verify: async () => grant({ scopes: MANAGEMENT_SCOPES }) })(
        request(header(token())),
        async () => ({}) as never,
      ),
    ).rejects.toThrow();
  });

  it("grants no editorial tool to any connection: the editorial domain is not inherited", async () => {
    for (const preset of ["read-only", "management"] as const) {
      const settings = await auth({
        read: async () => record(connection({ preset })),
        verify: async () =>
          grant({
            scopes:
              preset === "management" ? MANAGEMENT_SCOPES : READ_ONLY_SCOPES,
          }),
      })(request(header(token())), async () => ({}) as never);
      const tools = settings["payload-mcp-tool"] ?? {};
      expect(
        Object.keys(tools).filter((name) => /^editorial/iu.test(name)),
      ).toEqual([]);
    }
  });

  it("turns off collection, global, config, job and auth capabilities for a connection", async () => {
    const settings = await auth()(
      request(header(token())),
      async () => ({}) as never,
    );
    expect(settings.collections).toEqual({
      create: false,
      delete: false,
      find: false,
      update: false,
    });
    expect(settings.auth?.login).toBe(false);
    expect(settings.jobs?.run).toBe(false);
  });

  it("re-reads the connection on every request, so a disconnect takes effect on the next call rather than the next handshake", async () => {
    const read = vi.fn(async () => record());
    const authorize = auth({ read });
    await authorize(request(header(token())), async () => ({}) as never);
    await authorize(request(header(token())), async () => ({}) as never);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("answers one refusal shape, so a probe cannot tell a bad signature from a revoked connection", async () => {
    const shapes = await Promise.all(
      [
        auth({ verify: async () => null }),
        auth({ read: async () => null }),
        auth({ read: async () => record(connection({ status: "revoked" })) }),
        auth({ verify: async () => grant({ generation: 1 }) }),
      ].map(async (authorize) => {
        try {
          await authorize(request(header(token())), async () => ({}) as never);
          return "resolved";
        } catch (error) {
          return (error as Error).name;
        }
      }),
    );
    expect(new Set(shapes).size).toBe(1);
    expect(shapes[0]).not.toBe("resolved");
  });
});

describe("verifyConnection", () => {
  const OPERATOR_CLIENT = "https://claude.ai/oauth/mcp-oauth-client-metadata";
  const operator = connection({
    preset: "operator",
    client: "claude",
    oauthClientId: OPERATOR_CLIENT,
  });
  const operatorGrant = grant({
    clientId: OPERATOR_CLIENT,
    scopes: ["artvenn:admin"],
  });
  const dependencies = (
    verified: unknown,
    stored: ConnectionRecord | null = record(operator),
  ) => ({
    verifyAccessToken: vi.fn(async () => verified as VerifiedGrant),
    readConnection: vi.fn(async () => stored),
    ...expected,
    recordRefusal: vi.fn(),
    recordVerified: vi.fn(),
  });

  it("admits an operator connection and leaves the observation to its caller", async () => {
    const door = dependencies(operatorGrant);
    const admitted = await verifyConnection(door, "presented");
    expect(door.verifyAccessToken).toHaveBeenCalledWith("presented");
    expect(door.readConnection).toHaveBeenCalledWith("conn-1");
    expect(admitted.connection.id).toBe("conn-1");
    expect(admitted.consent.presetAtConsent).toBe("operator");
    expect(door.recordVerified).not.toHaveBeenCalled();
    expect(door.recordRefusal).not.toHaveBeenCalled();
  });

  it.each([
    ["a token nobody knows", null, undefined, "CONNECTION_TOKEN_INVALID"],
    [
      "a claim that does not parse",
      { ...operatorGrant, extra: true },
      undefined,
      "CONNECTION_GRANT_MALFORMED",
    ],
    [
      "a read-only scope on an operator consent",
      { ...operatorGrant, scopes: ["artvenn:read"] },
      undefined,
      "CONNECTION_SCOPE_MISMATCH",
    ],
    [
      "a stale generation",
      { ...operatorGrant, generation: 2 },
      undefined,
      "CONNECTION_GENERATION_STALE",
    ],
    [
      "a revoked connection",
      operatorGrant,
      record({
        ...operator,
        status: "revoked",
        revokedAt: "2026-09-19T00:00:00Z",
      }),
      "CONNECTION_REVOKED",
    ],
    ["a missing connection", operatorGrant, null, "CONNECTION_NOT_FOUND"],
  ] as const)(
    "refuses %s with its own code",
    async (_, verified, stored, code) => {
      await expect(
        verifyConnection(dependencies(verified, stored), "presented"),
      ).rejects.toMatchObject({ code });
    },
  );

  it("lets a store failure through for its caller to shape", async () => {
    const outage = new Error("store unavailable");
    const door = dependencies(operatorGrant);
    door.readConnection.mockRejectedValueOnce(outage);
    await expect(verifyConnection(door, "presented")).rejects.toBe(outage);
  });

  it("is what the plugin path runs: an operator connection authenticates there and lists nothing", async () => {
    const door = dependencies(operatorGrant);
    const settings = await connectionAuth(door)(
      request(header(token())),
      vi.fn(),
    );
    expect(settings["payload-mcp-tool"]).toEqual({});
    expect(door.recordVerified).toHaveBeenCalledWith("conn-1");
    const refused = dependencies(null);
    await expect(
      connectionAuth(refused)(request(header(token())), vi.fn()),
    ).rejects.toThrow();
    expect(refused.recordRefusal).toHaveBeenCalledWith(
      "CONNECTION_TOKEN_INVALID",
    );
    expect(refused.recordVerified).not.toHaveBeenCalled();
  });
});

describe("connectionOverrideAuth composition gate", () => {
  it("is off unless BOTH development and the explicit opt-in hold", () => {
    expect(connectionsEnabled({ NODE_ENV: "development" } as never)).toBe(
      false,
    );
    expect(
      connectionsEnabled({ AGENT_CONNECTIONS_ENABLED: "true" } as never),
    ).toBe(false);
    expect(
      connectionsEnabled({
        NODE_ENV: "production",
        AGENT_CONNECTIONS_ENABLED: "true",
      } as never),
    ).toBe(false);
    expect(
      connectionsEnabled({
        NODE_ENV: "development",
        AGENT_CONNECTIONS_ENABLED: "true",
      } as never),
    ).toBe(true);
  });

  it("refuses a connection token outright when the surface is off, instead of quietly trying it as an API key", async () => {
    const legacy = vi.fn(async () => ({ user: { id: "legacy" } }) as never);
    await expect(
      connectionOverrideAuth(null)(request(header(token())), legacy),
    ).rejects.toThrow();
    expect(legacy).not.toHaveBeenCalled();
  });

  it("leaves legacy API-key callers working when the surface is off", async () => {
    const legacy = vi.fn(async () => ({ user: { id: "legacy" } }) as never);
    await connectionOverrideAuth(null)(request(header(notOurs)), legacy);
    expect(legacy).toHaveBeenCalledOnce();
  });

  it("leaves a request with no credential to the legacy resolver's own refusal when the surface is off", async () => {
    const legacy = vi.fn(async () => {
      throw new Error("UNAUTHORIZED");
    });
    await expect(
      connectionOverrideAuth(null)(request(), legacy as never),
    ).rejects.toThrow("UNAUTHORIZED");
    expect(legacy).toHaveBeenCalledOnce();
  });
});

describe("r10 §3.1 — the token subject must be the consenting human", () => {
  it("admits a grant whose subject is the connection's human", () => {
    expect(
      admitGrant(
        grant({ subject: "user-owner" }),
        record(connection()),
        expected,
      ).connection.id,
    ).toBe("conn-1");
  });

  it("refuses a validly signed token issued for a different human", () => {
    expect(() =>
      admitGrant(
        grant({ subject: "user-someone-else" }),
        record(connection()),
        expected,
      ),
    ).toThrow("CONNECTION_SUBJECT_MISMATCH");
  });

  it("gives that refusal the same external shape as every other failure", async () => {
    const outcome = await auth({
      verify: async () => grant({ subject: "user-someone-else" }),
    })(request(header(token())), async () => ({}) as never).then(
      () => "resolved",
      (error: Error) => error.name,
    );
    expect(outcome).not.toBe("resolved");
    expect(outcome).toBe("UnauthorizedError");
  });
});

describe("r10 §3.2 — the exact registered OAuth client, not the vendor family", () => {
  it("admits a grant from the exact authorized client", () => {
    expect(
      admitGrant(grant(), record(connection()), expected).consent.oauthClientId,
    ).toBe(CLIENT_ID);
  });

  it("refuses another registered client even when human, connection, issuer, resource and generation all match", () => {
    expect(() =>
      admitGrant(
        grant({ clientId: "artvenn-claude-desktop-02" }),
        record(connection()),
        expected,
      ),
    ).toThrow("CONNECTION_CLIENT_MISMATCH");
  });

  it("does not accept the descriptive family label as a client identity", () => {
    expect(() =>
      admitGrant(grant({ clientId: "claude" }), record(connection()), expected),
    ).toThrow("CONNECTION_CLIENT_MISMATCH");
  });
});

describe("r10 §3.3 — exact scope agreement", () => {
  const refuse = (scopes: unknown) =>
    expect(() =>
      admitGrant(
        grant({ scopes: scopes as string[] }),
        record(connection()),
        expected,
      ),
    ).toThrow("CONNECTION_SCOPE_MISMATCH");

  it("accepts the canonical set for the preset", () => {
    expect(
      admitGrant(
        grant({ scopes: READ_ONLY_SCOPES }),
        record(connection()),
        expected,
      ).connection.id,
    ).toBe("conn-1");
  });

  it("accepts the canonical set in any order, because both sides normalize", () => {
    expect(
      admitGrant(
        grant({ scopes: ["artvenn:manage", "artvenn:read"] }),
        record(connection({ preset: "management" })),
        expected,
      ).connection.id,
    ).toBe("conn-1");
  });

  it("refuses an extra capability scope", () => {
    refuse([...READ_ONLY_SCOPES, "artvenn:manage"]);
  });

  it("refuses a missing capability scope", () => {
    refuse(["offline_access"]);
  });

  it("refuses a duplicated scope rather than collapsing it", () => {
    refuse([...READ_ONLY_SCOPES, "artvenn:read"]);
  });

  it("refuses an unknown scope", () => {
    refuse([...READ_ONLY_SCOPES, "admin:everything"]);
  });

  it("refuses an empty claim: absent scopes never inherit the preset", () => {
    refuse([]);
  });

  it("refuses a malformed claim", () => {
    refuse(undefined);
    refuse("artvenn:read");
    refuse([" artvenn:read"]);
    refuse([1, 2, 3]);
  });

  it("requires the management capabilities for a management connection, and refuses the read-only set there", () => {
    const managed = record(connection({ preset: "management" }));
    expect(
      admitGrant(grant({ scopes: MANAGEMENT_SCOPES }), managed, expected)
        .connection.id,
    ).toBe("conn-1");
    expect(() =>
      admitGrant(grant({ scopes: READ_ONLY_SCOPES }), managed, expected),
    ).toThrow("CONNECTION_SCOPE_MISMATCH");
  });
});

describe("r10 §3.4 — the read-only preset advertises only what its scopes authorize", () => {
  it("does not advertise artvenn_operations_get, which the Backend gates on operations:execute", () => {
    expect(PRESET_TOOLS["read-only"]).not.toContain("artvenn_operations_get");
  });

  it("advertises exactly the four tools covered by users:read, content:read and comments:read", () => {
    expect([...PRESET_TOOLS["read-only"]].sort()).toEqual([
      "artvenn_comments_query",
      "artvenn_comments_read",
      "artvenn_content_search",
      "artvenn_users_find",
    ]);
  });

  it("keeps artvenn_operations_get available to management, which does hold operations:execute", () => {
    expect(PRESET_TOOLS.management).toContain("artvenn_operations_get");
    expect(canonicalScopes("management")).toContain("operations:execute");
  });

  it("does not widen the read-only Backend scope set to keep a tool: no operations scope is present", () => {
    expect(canonicalScopes("read-only")).toEqual(INTERNAL_SCOPES);
  });
});

describe("r10 review blocker 1 — the grant map must use the key the plugin reads", () => {
  it("matches the plugin's own toCamelCase for every tool in the real registry", async () => {
    // Compared against the plugin's function, not against a second copy of the
    // conversion, so the two cannot drift apart silently.
    const require_ = createRequire(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "../../../apps/admin/package.json",
      ),
    );
    const entry = require_.resolve("@payloadcms/plugin-mcp");
    const camelCaseModule = (await import(
      pathToFileURL(path.join(path.dirname(entry), "utils/camelCase.js")).href
    )) as { toCamelCase: (value: string) => string };

    for (const preset of ["read-only", "management"] as const)
      for (const tool of PRESET_TOOLS[preset])
        expect(toolGrantKey(tool), tool).toBe(
          camelCaseModule.toCamelCase(tool),
        );
  });

  it("emits keys a snake_case lookup would miss, which is the defect this guards", async () => {
    const settings = await auth()(
      request(header(token())),
      async () => ({}) as never,
    );
    const tools = settings["payload-mcp-tool"] ?? {};
    expect(tools.artvennUsersFind).toBe(true);
    // The shape that silently disabled every tool.
    expect(tools.artvenn_users_find).toBeUndefined();
  });
});

describe("r10 review finding 6 — token freshness is checked here", () => {
  it("refuses an expired token even when every other binding agrees", () => {
    expect(() =>
      admitGrant(
        grant({ expiresAt: "2020-01-01T00:00:00Z" }),
        record(connection()),
        expected,
      ),
    ).toThrow("CONNECTION_TOKEN_EXPIRED");
  });

  it("admits a token that has not expired yet", () => {
    expect(
      admitGrant(
        grant({ expiresAt: "2099-01-01T00:00:00Z" }),
        record(connection()),
        expected,
        new Date("2026-09-18T00:00:00Z"),
      ).connection.id,
    ).toBe("conn-1");
  });
});

describe("r10 re-review blocker — an unreadable expiry is an expired token", () => {
  it("refuses a JWT-style numeric exp, which Date.parse answers NaN for", async () => {
    // The value a real verifier is most likely to produce: JWT `exp` is a
    // NumericDate, i.e. a number. Written as a bare `<=`, the check was
    // skipped entirely and the grant admitted.
    await expect(
      auth({
        verify: async () =>
          ({ ...grant(), expiresAt: 1789693200 }) as unknown as VerifiedGrant,
      })(request(header(token())), async () => ({}) as never),
    ).rejects.toThrow();
  });

  it("refuses an unparseable expiry string", () => {
    expect(() =>
      admitGrant(
        { ...grant(), expiresAt: "not-a-date" } as VerifiedGrant,
        record(),
        expected,
      ),
    ).toThrow("CONNECTION_TOKEN_EXPIRED");
  });

  it("refuses a missing expiry rather than treating it as no constraint", () => {
    const withoutExpiry: Record<string, unknown> = { ...grant() };
    delete withoutExpiry.expiresAt;
    expect(() =>
      admitGrant(withoutExpiry as unknown as VerifiedGrant, record(), expected),
    ).toThrow("CONNECTION_TOKEN_EXPIRED");
  });

  it("refuses a grant whose shape the verifier got wrong, before any comparison", async () => {
    await expect(
      auth({
        verify: async () =>
          ({ connectionId: "conn-1" }) as unknown as VerifiedGrant,
      })(request(header(token())), async () => ({}) as never),
    ).rejects.toThrow();
  });
});

describe("r10 re-review — diagnostics never change the answer", () => {
  it("records the refusal code, and never the presented credential", async () => {
    const codes: string[] = [];
    const settings = connectionAuth({
      verifyAccessToken: async () => null,
      readConnection: async () => record(),
      issuer: ISSUER,
      resource: RESOURCE,
      environment: ENVIRONMENT,
      recordRefusal: (code) => codes.push(code),
    });
    await expect(
      settings(
        request(header(token("secret-value"))),
        async () => ({}) as never,
      ),
    ).rejects.toThrow();
    expect(codes).toEqual(["CONNECTION_TOKEN_INVALID"]);
    expect(codes.join(" ")).not.toContain("secret-value");
  });

  it("still answers UnauthorizedError when the diagnostics sink itself throws", async () => {
    const settings = connectionAuth({
      verifyAccessToken: async () => null,
      readConnection: async () => record(),
      issuer: ISSUER,
      resource: RESOURCE,
      environment: ENVIRONMENT,
      recordRefusal: () => {
        throw new Error("logger transport down");
      },
    });
    const outcome = await settings(
      request(header(token())),
      async () => ({}) as never,
    ).then(
      () => "resolved",
      (error: Error) => error.name,
    );
    expect(outcome).toBe("UnauthorizedError");
  });
});

describe("r14 §4 — identity comes off the frozen consent, never off the connection", () => {
  it("refuses a token whose client matches the connection but not the consent", () => {
    // The attack this closes. `agent_connections.oauth_client_id` is writable
    // by design and no trigger freezes it, so anything that could rewrite the
    // connection row could previously make a foreign client's token admit by
    // simply editing the connection to agree with it. The grant cannot move.
    const rewritten = connection({ oauthClientId: "attacker-client" });
    expect(() =>
      admitGrant(
        grant({ clientId: "attacker-client" }),
        { connection: rewritten, grant: consent({}, connection()) },
        expected,
      ),
    ).toThrow("CONNECTION_CLIENT_MISMATCH");
  });

  it("refuses a token whose subject matches the connection but not the consent", () => {
    const rewritten = connection({ humanAccountId: "user-other" });
    expect(() =>
      admitGrant(
        grant({ subject: "user-other" }),
        { connection: rewritten, grant: consent({}, connection()) },
        expected,
      ),
    ).toThrow("CONNECTION_SUBJECT_MISMATCH");
  });

  it("still admits when the frozen consent is the one that agrees", () => {
    // The same rewrite, with a token minted under the consent that is
    // actually recorded, is admitted — so the refusals above are about the
    // SOURCE of identity, not about rejecting everything.
    const rewritten = connection({ oauthClientId: "attacker-client" });
    expect(
      admitGrant(
        grant(),
        { connection: rewritten, grant: consent({}, connection()) },
        expected,
      ).connection.id,
    ).toBe("conn-1");
  });

  it("refuses a connection with no consent as ungranted, not as missing", () => {
    // A real record behind a misleading code is worse than a refusal: the
    // operator reading diagnostics would go looking for a connection that is
    // sitting right there, awaiting consent.
    expect(() =>
      admitGrant(grant(), { connection: connection(), grant: null }, expected),
    ).toThrow("CONNECTION_CONSENT_MISSING");
  });

  it("refuses a consent whose frozen scopes disagree with its own preset", () => {
    // `capability_scopes` is the one column recording what the human actually
    // approved at the provider, and until r14 authorization never read it —
    // the expected set was derived from the preset alone, so a grant that
    // disagreed with itself would have been admitted without comment.
    expect(() =>
      admitGrant(
        grant(),
        {
          connection: connection(),
          grant: consent({ capabilityScopes: ["artvenn:manage"] }),
        },
        expected,
      ),
    ).toThrow("CONNECTION_CONSENT_INCOHERENT");
  });

  it("refuses a consent snapshot belonging to another connection", () => {
    expect(() =>
      admitGrant(
        grant(),
        {
          connection: connection(),
          grant: consent({ connectionId: "conn-2" }),
        },
        expected,
      ),
    ).toThrow("CONNECTION_CONSENT_MISMATCH");
  });

  it("takes the tool map from the consented preset, so editing the connection widens nothing", async () => {
    // A preset raised on the connection without a new consent must not widen
    // a token that already exists. Narrowing is done by revoking, which bumps
    // the generation and already has its own regressions.
    const widened = connection({ preset: "management" });
    const settings = await auth({
      read: async () => ({
        connection: widened,
        grant: consent({ presetAtConsent: "read-only" }, connection()),
      }),
      verify: async () => grant({ scopes: READ_ONLY_SCOPES }),
    })(request(header(token())), async () => ({}) as never);
    const tools = settings["payload-mcp-tool"] ?? {};
    expect(Object.keys(tools).sort()).toEqual(
      [...PRESET_TOOLS["read-only"]].map(toolGrantKey).sort(),
    );
    expect(tools.artvennOperationsExecute).toBeUndefined();
  });
});

describe("r11 §3 — capability scopes, protocol scopes and Backend scopes are three vocabularies", () => {
  const admit = (
    scopes: unknown,
    preset: AgentConnection["preset"] = "read-only",
  ) =>
    admitGrant(
      grant({ scopes: scopes as string[] }),
      record(connection({ preset })),
      expected,
    );

  it("publishes a small external vocabulary, not the Backend's seven", () => {
    expect(canonicalCapabilityScopes("read-only")).toEqual(["artvenn:read"]);
    expect(canonicalCapabilityScopes("management")).toEqual([
      "artvenn:manage",
      "artvenn:read",
    ]);
  });

  it("refuses a token naming an internal Backend scope: those are not the external contract", () => {
    for (const internal of INTERNAL_SCOPES)
      expect(() => admit([internal])).toThrow("CONNECTION_SCOPE_MISMATCH");
    expect(() => admit([...READ_ONLY_SCOPES, "operations:execute"])).toThrow(
      "CONNECTION_SCOPE_MISMATCH",
    );
  });

  it("accepts offline_access alongside the capability set, for the refresh lifecycle", () => {
    expect(admit(["artvenn:read", "offline_access"]).connection.id).toBe(
      "conn-1",
    );
    expect(
      admit(["artvenn:read", "artvenn:manage", "offline_access"], "management")
        .connection.id,
    ).toBe("conn-1");
  });

  it("grants nothing for offline_access: it cannot stand in for a capability", () => {
    expect(() => admit(["offline_access"])).toThrow(
      "CONNECTION_SCOPE_MISMATCH",
    );
  });

  it("does not let a protocol scope change the tool map", async () => {
    const withProtocol = await auth({
      verify: async () => grant({ scopes: ["artvenn:read", "offline_access"] }),
    })(request(header(token())), async () => ({}) as never);
    const without = await auth()(
      request(header(token())),
      async () => ({}) as never,
    );
    expect(Object.keys(withProtocol["payload-mcp-tool"] ?? {}).sort()).toEqual(
      Object.keys(without["payload-mcp-tool"] ?? {}).sort(),
    );
  });

  it("refuses openid, which is not on the protocol allowlist", () => {
    expect(() => admit(["artvenn:read", "openid"])).toThrow(
      "CONNECTION_SCOPE_MISMATCH",
    );
    expect(() => admit(["artvenn:read", "profile"])).toThrow(
      "CONNECTION_SCOPE_MISMATCH",
    );
  });

  it("refuses a duplicated protocol scope on the same terms as a duplicated capability", () => {
    expect(() =>
      admit(["artvenn:read", "offline_access", "offline_access"]),
    ).toThrow("CONNECTION_SCOPE_MISMATCH");
  });

  it("classifies a claim into its two vocabularies, or refuses it whole", () => {
    expect(admitScopeClaim(["artvenn:read", "offline_access"])).toEqual({
      capabilities: ["artvenn:read"],
      protocol: ["offline_access"],
    });
    expect(admitScopeClaim(["artvenn:read", "users:read"])).toBeNull();
    expect(admitScopeClaim([])).toBeNull();
  });

  it("keeps the Backend scopes derived from the preset, never read off the token", () => {
    // A management token on a read-only connection is refused, so there is no
    // path by which a claim could reach the Backend scope derivation at all.
    expect(() => admit(MANAGEMENT_SCOPES)).toThrow("CONNECTION_SCOPE_MISMATCH");
    expect(canonicalScopes("management")).toHaveLength(7);
  });
});

describe("r11 §4 — a CIMD client id is an HTTPS URL, not an identifier", () => {
  it("stores and matches a client id far longer than an identifier ceiling", () => {
    const cimd = `https://client.example.invalid/${"a".repeat(400)}/metadata.json`;
    expect(cimd.length).toBeGreaterThan(256);
    expect(
      admitGrant(
        grant({ clientId: cimd }),
        record(connection({ oauthClientId: cimd })),
        expected,
      ).connection.id,
    ).toBe("conn-1");
  });

  it("still refuses a different metadata URL from the same vendor", () => {
    const mine = "https://client.example.invalid/a/metadata.json";
    const theirs = "https://client.example.invalid/b/metadata.json";
    expect(() =>
      admitGrant(
        grant({ clientId: theirs }),
        record(connection({ oauthClientId: mine })),
        expected,
      ),
    ).toThrow("CONNECTION_CLIENT_MISMATCH");
  });
});

describe("r12 §4.1 — client identity in two explicit forms, bounded by real bytes", () => {
  it("measures the ceiling in UTF-8 bytes, not UTF-16 units", () => {
    // The r11 claim of a "1024-byte" ceiling was false in the permissive
    // direction: `.max(1024)` accepts 1024 accented characters, which are
    // 2048 bytes. This is the case that used to pass and must not.
    const twoThousandBytes = "\u00e9".repeat(1024);
    expect(twoThousandBytes.length).toBe(1024);
    expect(new TextEncoder().encode(twoThousandBytes).length).toBe(2048);
    expect(isPreregisteredClientId(twoThousandBytes)).toBe(false);
    expect(oauthClientIdSchema.safeParse(twoThousandBytes).success).toBe(false);
  });

  it("accepts a bounded opaque preregistered identifier", () => {
    expect(isPreregisteredClientId("artvenn-claude-desktop-01")).toBe(true);
    expect(
      oauthClientIdSchema.safeParse("artvenn-claude-desktop-01").success,
    ).toBe(true);
  });

  it("refuses control characters, padding and emptiness in an opaque identifier", () => {
    for (const bad of [
      "",
      " padded",
      "trailing ",
      `with${String.fromCharCode(0)}null`,
      `bell${String.fromCharCode(7)}`,
    ])
      expect(isPreregisteredClientId(bad), JSON.stringify(bad)).toBe(false);
  });

  it("accepts a canonical HTTPS CIMD metadata URL", () => {
    const cimd = "https://client.example.invalid/metadata.json";
    expect(isCimdClientId(cimd)).toBe(true);
    expect(oauthClientIdSchema.safeParse(cimd).success).toBe(true);
  });

  it("refuses a CIMD URL carrying userinfo, because that is a credential in an identifier", () => {
    // Composed rather than written out: a literal credentialed URL is worth
    // blocking even in a test, and the credential check is right to say so.
    const userinfo = ["someone", "opaque-value"].join(":");
    expect(
      isCimdClientId(
        `https://${userinfo}@client.example.invalid/metadata.json`,
      ),
    ).toBe(false);
  });

  it("refuses a fragment, which is not part of the identity the provider recognizes", () => {
    expect(isCimdClientId("https://client.example.invalid/m.json#frag")).toBe(
      false,
    );
  });

  it("refuses a non-HTTPS metadata URL", () => {
    expect(isCimdClientId("http://client.example.invalid/m.json")).toBe(false);
    expect(isCimdClientId("file:///etc/passwd")).toBe(false);
  });

  it("refuses a non-canonical spelling rather than normalizing two spellings into one identity", () => {
    // `new URL` would happily canonicalise these; accepting them would make two
    // different presented strings match one stored identity.
    for (const nonCanonical of [
      "https://client.example.invalid/a/../metadata.json",
      "https://CLIENT.example.invalid/metadata.json",
      "https://client.example.invalid:443/metadata.json",
    ])
      expect(isCimdClientId(nonCanonical), nonCanonical).toBe(false);
  });

  it("bounds a CIMD URL by bytes too", () => {
    const long = `https://client.example.invalid/${"\u00e9".repeat(600)}`;
    expect(new TextEncoder().encode(long).length).toBeGreaterThan(1024);
    expect(isCimdClientId(long)).toBe(false);
  });

  it("rejects rather than truncates: a prefix of an identity is a different identity", () => {
    const full = `https://client.example.invalid/${"a".repeat(1100)}`;
    const parsed = oauthClientIdSchema.safeParse(full);
    expect(parsed.success).toBe(false);
    expect(parsed.success ? parsed.data : undefined).toBeUndefined();
  });

  it("still binds exactly: a CIMD id is matched whole against the connection", () => {
    const cimd = "https://client.example.invalid/metadata.json";
    expect(
      admitGrant(
        grant({ clientId: cimd }),
        record(connection({ oauthClientId: cimd })),
        expected,
      ).connection.id,
    ).toBe("conn-1");
  });
});
