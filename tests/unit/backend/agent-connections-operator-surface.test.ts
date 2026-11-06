import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

import {
  ConsentRuntimeError,
  agentConnectionAuthenticateHeader,
  agentConnectionEndpoints,
  authorizationServerMetadataUrl,
  consentRuntime,
  createConsentRuntime,
  protectedResourceMetadata,
  resetConsentRuntime,
  wwwAuthenticate,
} from "admin/agent-connections";
import { createResourceRuntime } from "admin/agent-connections-resource";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

/**
 * The login door's Admin surfaces, at the rules that decide who gets through: what
 * composes where, what the runtime refuses to build on, what discovery says, and the
 * handlers' order. A stubbed runtime and a recording `payload` stand in for storage,
 * so the order of the audit row and the change can be read back; the same code on a
 * real database is in `agent-operator-flow-cases.ts` and `tests/cms`.
 */

// The real parser and pool, recorded: this suite opens no connection, and what the
// pool was given is the only place the TLS settings can be read back from.
const pools = vi.hoisted(() => ({ configs: [] as unknown[] }));
vi.mock("@moya/catalog-postgres", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@moya/catalog-postgres")>();
  return {
    ...original,
    createPostgresPool: (
      ...args: Parameters<typeof original.createPostgresPool>
    ) => {
      pools.configs.push(args[0]);
      return original.createPostgresPool(...args);
    },
  };
});

// The handlers read the runtime from one module-level seam; the rest stays real.
const runtimeStub = vi.hoisted(() => ({ current: undefined as unknown }));
vi.mock(
  "../../../apps/admin/src/agent-connections/runtime",
  async (importOriginal) => {
    const original =
      await importOriginal<typeof import("admin/agent-connections")>();
    return {
      ...original,
      consentRuntime: () => {
        if (runtimeStub.current === undefined) return original.consentRuntime();
        if (runtimeStub.current instanceof Error) throw runtimeStub.current;
        return runtimeStub.current;
      },
    };
  },
);

const ISSUER = "https://auth.artvenn.invalid";
const RESOURCE = "https://admin.artvenn.invalid/api/mcp";
const ADMIN_ORIGIN = "https://admin.artvenn.invalid";
const CLAUDE = "https://claude.ai/oauth/mcp-oauth-client-metadata";
const LIST = JSON.stringify([
  {
    clientId: CLAUDE,
    family: "claude",
    label: "Claude",
    callbackPolicy: "hosted-https",
    redirectUris: ["https://claude.ai/api/mcp/auth_callback"],
  },
]);
const LOOPBACK_LIST = JSON.stringify([
  {
    clientId: "artvenn-local-verify",
    family: "claude",
    label: "Local",
    redirectUris: ["http://127.0.0.1:44563/callback"],
  },
]);

const production: Record<string, string | undefined> = {
  NODE_ENV: "production",
  ADMIN_MCP_OAUTH_ENABLED: "true",
  CMS_ENVIRONMENT: "production",
  AGENT_AUTHORIZATION_ISSUER: ISSUER,
  AGENT_AUTHORIZATION_RESOURCE: RESOURCE,
  AGENT_AUTHORIZATION_CLIENTS: LIST,
  AGENT_CONSENT_DATABASE_URL:
    "postgresql://x@db.example.invalid:5432/synthetic?sslmode=verify-full",
};
const readOnly: Record<string, string | undefined> = {
  NODE_ENV: "development",
  AGENT_CONNECTIONS_ENABLED: "true",
  AGENT_AUTHORIZATION_ISSUER: "http://127.0.0.1:44561",
  AGENT_AUTHORIZATION_RESOURCE: "http://app.localhost:44562/api/mcp",
  AGENT_AUTHORIZATION_CLIENTS: LOOPBACK_LIST,
  AGENT_CONSENT_DATABASE_URL: "postgresql://x@127.0.0.1:5432/synthetic",
};
const developmentOperator: Record<string, string | undefined> = {
  ...readOnly,
  AGENT_AUTHORIZATION_PROFILE: "operator",
  AGENT_AUTHORIZATION_CLIENTS: LIST,
  CMS_ENVIRONMENT: "synthetic",
  AGENT_AUTHORIZATION_ENVIRONMENT: "synthetic",
};

const asEnvironment = (settings: Record<string, string | undefined>) =>
  settings as unknown as NodeJS.ProcessEnv;

const compose = (
  base: Record<string, string | undefined>,
  override: Record<string, string | undefined> = {},
) => createConsentRuntime(asEnvironment({ ...base, ...override }));

const refusalOf = (
  base: Record<string, string | undefined>,
  override: Record<string, string | undefined> = {},
) => {
  try {
    compose(base, override);
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return "COMPOSED";
};

let certificates: string;
let authority: string;

beforeAll(() => {
  certificates = mkdtempSync(path.join(tmpdir(), "consent-ca-"));
  authority = path.join(certificates, "authority.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      path.join(certificates, "authority-key.pem"),
      "-out",
      authority,
      "-days",
      "1",
      "-subj",
      "/CN=synthetic-consent-ca",
    ],
    { stdio: "pipe" },
  );
  production.AGENT_DATABASE_SSL_CA_FILE = authority;
});

afterAll(() => {
  rmSync(certificates, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetConsentRuntime();
  runtimeStub.current = undefined;
  pools.configs.length = 0;
});

describe("the consent runtime", () => {
  it("opens on each environment's own setting, and never on the other's", () => {
    for (const [settings, built] of [
      [{}, false],
      [{ NODE_ENV: "production" }, false],
      [{ NODE_ENV: "production", AGENT_CONNECTIONS_ENABLED: "true" }, false],
      [{ NODE_ENV: "production", ADMIN_MCP_OAUTH_ENABLED: "false" }, false],
      [{ NODE_ENV: "development" }, false],
      [{ NODE_ENV: "development", ADMIN_MCP_OAUTH_ENABLED: "true" }, false],
      [{ NODE_ENV: "test", ADMIN_MCP_OAUTH_ENABLED: "true" }, false],
    ] as const)
      expect(
        compose(production, {
          NODE_ENV: undefined,
          ADMIN_MCP_OAUTH_ENABLED: undefined,
          ...settings,
        }) !== null,
      ).toBe(built);
    expect(compose(production)).not.toBeNull();
    expect(compose(readOnly)).not.toBeNull();
  });

  it("serves operator in Production, always, on verified TLS and a pool of 2", () => {
    const runtime = compose(production, {
      // Production never reads the Development setting.
      AGENT_AUTHORIZATION_PROFILE: "read-only",
    });
    expect(runtime).toMatchObject({
      preset: "operator",
      issuer: ISSUER,
      resource: RESOURCE,
      environment: "production",
    });
    expect([...(runtime?.clients.keys() ?? [])]).toEqual([CLAUDE]);
    expect(pools.configs.at(-1)).toMatchObject({
      max: 2,
      ssl: { rejectUnauthorized: true, ca: readFileSync(authority, "utf8") },
    });
    const { connectionString } = pools.configs.at(-1) as {
      connectionString: string;
    };
    expect(connectionString).not.toContain("sslmode");
    expect(connectionString).toContain("query_timeout=5000");
    expect(connectionString).toContain("statement_timeout=4000");
  });

  it("requires verify-full by its exact spelling in Production, loopback included", () => {
    const base = "postgresql://x@db.example.invalid:5432/synthetic";
    for (const query of [
      "",
      "?sslmode=disable",
      "?sslmode=require",
      "?sslmode=verify-ca",
      "?sslmode=verify-full&sslmode=disable",
      "?sslmode=verify-full&host=elsewhere.invalid",
      "?sslrootcert=/tmp/x&sslmode=verify-full",
    ])
      expect([
        query,
        refusalOf(production, {
          AGENT_CONSENT_DATABASE_URL: `${base}${query}`,
        }),
      ]).toEqual([query, "CONSENT_DATABASE_TLS_REQUIRED"]);
    expect(
      refusalOf(production, {
        AGENT_CONSENT_DATABASE_URL: "postgresql://x@127.0.0.1:5432/synthetic",
      }),
    ).toBe("CONSENT_DATABASE_TLS_REQUIRED");
  });

  it("names what it cannot use in Production", () => {
    for (const [override, code] of [
      [
        { AGENT_DATABASE_SSL_CA_FILE: undefined },
        "CONSENT_DATABASE_CA_REQUIRED",
      ],
      [{ AGENT_DATABASE_SSL_CA_FILE: "" }, "CONSENT_DATABASE_CA_REQUIRED"],
      [
        { AGENT_DATABASE_SSL_CA_FILE: `${certificates}/absent.pem` },
        "CONSENT_DATABASE_REFUSED",
      ],
      [{ AGENT_CONSENT_DATABASE_URL: undefined }, "CONSENT_DATABASE_REQUIRED"],
      [
        { AGENT_CONSENT_DATABASE_URL: "not a url" },
        "CONSENT_DATABASE_MALFORMED",
      ],
      [
        { AGENT_AUTHORIZATION_ISSUER: "http://auth.artvenn.invalid" },
        "PRODUCTION_HTTPS_REQUIRED",
      ],
      [
        {
          AGENT_AUTHORIZATION_RESOURCE: "http://admin.artvenn.invalid/api/mcp",
        },
        "PRODUCTION_HTTPS_REQUIRED",
      ],
      [
        { AGENT_AUTHORIZATION_ISSUER: ADMIN_ORIGIN },
        "ISSUER_AND_RESOURCE_SHARE_AN_ORIGIN",
      ],
      [{ CMS_ENVIRONMENT: undefined }, "ENVIRONMENT_DISAGREES_WITH_NODE_ENV"],
      [{ CMS_ENVIRONMENT: "synthetic" }, "ENVIRONMENT_DISAGREES_WITH_NODE_ENV"],
      [{ AGENT_AUTHORIZATION_CLIENTS: undefined }, "CLIENTS_MALFORMED"],
      [{ AGENT_AUTHORIZATION_CLIENTS: "[]" }, "CLIENTS_REQUIRED"],
    ] as const)
      expect([override, refusalOf(production, override)]).toEqual([
        override,
        code,
      ]);
  });

  it("stays on loopback in Development, under either profile", () => {
    const AGENT_CONSENT_DATABASE_URL =
      "postgresql://x@db.example.invalid:5432/synthetic?sslmode=verify-full";
    for (const profile of [readOnly, developmentOperator])
      expect(refusalOf(profile, { AGENT_CONSENT_DATABASE_URL })).toBe(
        "CONSENT_DATABASE_NOT_LOOPBACK",
      );
  });

  it("leaves the read-only profile read-only, with no hosted entry", () => {
    const runtime = compose(readOnly);
    expect(runtime).toMatchObject({
      preset: "read-only",
      environment: "development",
    });
    expect(pools.configs.at(-1)).toMatchObject({ max: 2, ssl: false });
    expect(refusalOf(readOnly, { AGENT_AUTHORIZATION_CLIENTS: LIST })).toBe(
      "CLIENTS_HOSTED_NOT_ALLOWED",
    );
    // Nothing about this profile reads the issuer's environment name.
    expect(
      refusalOf(readOnly, { AGENT_AUTHORIZATION_ENVIRONMENT: "synthetic" }),
    ).toBe("COMPOSED");
  });

  it("holds Development's operator profile to the issuer's environment name", () => {
    expect(compose(developmentOperator)).toMatchObject({
      preset: "operator",
      environment: "synthetic",
    });
    for (const override of [
      { AGENT_AUTHORIZATION_ENVIRONMENT: undefined },
      { AGENT_AUTHORIZATION_ENVIRONMENT: "development" },
      { CMS_ENVIRONMENT: undefined },
    ])
      expect(refusalOf(developmentOperator, override)).toBe(
        "ENVIRONMENT_DISAGREES_WITH_ISSUER",
      );
  });

  it("keeps a refusal, says its bare code once, and never brings the rest down", () => {
    for (const [name, value] of Object.entries({
      ...production,
      AGENT_CONSENT_DATABASE_URL: "postgresql://x@db.example.invalid/synthetic",
    }))
      vi.stubEnv(name, value as string);
    resetConsentRuntime();
    const written: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    expect(() => consentRuntime()).toThrow(ConsentRuntimeError);
    expect(() => consentRuntime()).toThrow(ConsentRuntimeError);
    expect(written).toEqual([
      "agent-connections composition refused: CONSENT_DATABASE_TLS_REQUIRED\n",
    ]);
    expect(pools.configs).toEqual([]);
  });
});

/**
 * Slice O4: `admin.env.example` read as the Admin would, with only the host's CA
 * path and the placeholder keys stood in for, so a misspelt or missing door
 * setting fails here rather than on the first request after the release.
 */
describe("the Production template", () => {
  const repository = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../..",
  );
  const template = (name: string) =>
    parseEnv(readFileSync(path.join(repository, name), "utf8"));

  it("composes both sides of the door from admin.env, aimed at the issuer its own file names", async () => {
    const admin = template("infra/production/env/admin.env.example");
    const issuer = template(
      "infra/production/env/admin-authorization.env.example",
    );
    expect(admin.AGENT_DATABASE_SSL_CA_FILE).toMatch(/^\/etc\/yoyi\//u);
    const env = asEnvironment({
      ...admin,
      AGENT_DATABASE_SSL_CA_FILE: authority,
      AGENT_CONNECTION_WRAPPER_INDEX_KEY: randomBytes(32).toString("base64"),
      AGENT_CONNECTION_WRAPPER_SEAL_KEY: randomBytes(32).toString("base64"),
    });
    const listed = (
      JSON.parse(issuer.AGENT_AUTHORIZATION_CLIENTS!) as { clientId: string }[]
    ).map(({ clientId }) => clientId);

    const consent = createConsentRuntime(env);
    expect(consent).toMatchObject({
      preset: "operator",
      issuer: issuer.AGENT_AUTHORIZATION_ISSUER,
      resource: issuer.AGENT_AUTHORIZATION_RESOURCE,
      environment: "production",
    });
    expect([...(consent?.clients.keys() ?? [])]).toEqual(listed);
    const resource = createResourceRuntime(env);
    try {
      expect([...(resource?.clients.keys() ?? [])]).toEqual(listed);
    } finally {
      await resource?.close();
      await consent?.close();
    }
    // Both pools on verified TLS with the CA, and query limits of their own.
    expect(pools.configs).toHaveLength(2);
    for (const config of pools.configs)
      expect(config).toMatchObject({
        ssl: { rejectUnauthorized: true, ca: readFileSync(authority, "utf8") },
      });
    expect(protectedResourceMetadata(env)).toMatchObject({
      resource: issuer.AGENT_AUTHORIZATION_RESOURCE,
      authorization_servers: [issuer.AGENT_AUTHORIZATION_ISSUER],
    });
  });
});

describe("discovery", () => {
  const POINTER =
    'resource_metadata="https://admin.artvenn.invalid/.well-known/oauth-protected-resource/api/mcp"';

  it("publishes each profile's own scope, and only the header method", () => {
    expect(protectedResourceMetadata(asEnvironment(production))).toEqual({
      resource: RESOURCE,
      authorization_servers: [ISSUER],
      scopes_supported: ["artvenn:admin"],
      bearer_methods_supported: ["header"],
    });
    expect(
      protectedResourceMetadata(asEnvironment(developmentOperator))
        ?.scopes_supported,
    ).toEqual(["artvenn:admin"]);
    expect(
      protectedResourceMetadata(asEnvironment(readOnly))?.scopes_supported,
    ).toEqual(["artvenn:read"]);
  });

  it("says nothing with the surface off, which is what the well-known paths' 404 reads", () => {
    for (const settings of [
      { ...production, ADMIN_MCP_OAUTH_ENABLED: undefined },
      { ...production, ADMIN_MCP_OAUTH_ENABLED: "false" },
      {
        ...production,
        AGENT_CONNECTIONS_ENABLED: "true",
        ADMIN_MCP_OAUTH_ENABLED: undefined,
      },
      { ...readOnly, AGENT_CONNECTIONS_ENABLED: undefined },
      {
        ...readOnly,
        AGENT_CONNECTIONS_ENABLED: undefined,
        ADMIN_MCP_OAUTH_ENABLED: "true",
      },
    ]) {
      const environment = asEnvironment(settings);
      expect(protectedResourceMetadata(environment)).toBeNull();
      expect(authorizationServerMetadataUrl(environment)).toBeNull();
      expect(wwwAuthenticate(environment)).toBeNull();
    }
  });

  it("will not point a tool at plain http in Production", () => {
    for (const override of [
      { AGENT_AUTHORIZATION_ISSUER: "http://auth.artvenn.invalid" },
      { AGENT_AUTHORIZATION_RESOURCE: "http://admin.artvenn.invalid/api/mcp" },
    ])
      expect(
        protectedResourceMetadata(
          asEnvironment({ ...production, ...override }),
        ),
      ).toBeNull();
    expect(
      authorizationServerMetadataUrl(
        asEnvironment({
          ...production,
          AGENT_AUTHORIZATION_ISSUER: "http://auth.artvenn.invalid",
        }),
      ),
    ).toBeNull();
    expect(authorizationServerMetadataUrl(asEnvironment(production))).toBe(
      `${ISSUER}/.well-known/oauth-authorization-server`,
    );
  });

  it("challenges with the pointer and the scope, and names no reason", () => {
    expect(wwwAuthenticate(asEnvironment(production))).toBe(
      `${["Bearer", POINTER].join(" ")}, scope="artvenn:admin"`,
    );
    expect(wwwAuthenticate(asEnvironment(developmentOperator))).toContain(
      'scope="artvenn:admin"',
    );
    expect(wwwAuthenticate(asEnvironment(readOnly))).toContain(
      'scope="artvenn:read"',
    );
    expect(wwwAuthenticate(asEnvironment(production))).not.toContain("error=");
  });

  it("puts that on a Production 401 from the door's path, and on nothing else", () => {
    for (const [name, value] of Object.entries(production))
      vi.stubEnv(name, value as string);
    const challenge = (status: number, pathname: string) => {
      const req: { url: string; responseHeaders?: Headers } = {
        url: `http://127.0.0.1:3000${pathname}`,
      };
      agentConnectionAuthenticateHeader({
        error: Object.assign(new Error("refused"), { status }),
        req,
      });
      return req.responseHeaders?.get("WWW-Authenticate") ?? null;
    };
    const expected = wwwAuthenticate(process.env);
    expect(expected).toContain(POINTER);
    expect(expected).toContain('scope="artvenn:admin"');
    expect(challenge(401, "/api/mcp")).toBe(expected);
    expect(challenge(403, "/api/mcp")).toBeNull();
    expect(challenge(401, "/api/users/me")).toBeNull();
    vi.stubEnv("ADMIN_MCP_OAUTH_ENABLED", "false");
    expect(challenge(401, "/api/mcp")).toBeNull();
  });
});

describe("the reserved routes", () => {
  const INTERACTION = "abc123_-XYZ";
  const TICKET = "a".repeat(64);
  const CONNECTION = `conn-${"0".repeat(32)}`;
  const OWNER = "payload-user-7";

  /** A runtime that writes down what happened and when. */
  const stubRuntime = (
    preset: "read-only" | "operator",
    events: string[],
    overrides: Record<string, unknown> = {},
  ) => {
    const connection = {
      id: CONNECTION,
      principalLabel: "agent-claude-0123456789ab",
      humanAccountId: "payload-user-8",
      client: "claude",
      oauthClientId: CLAUDE,
      environment: "production",
      preset,
      status: "authorized",
      generation: 1,
      revokedAt: null,
      consentedAt: "2026-11-05T00:00:00.000Z",
    };
    return {
      preset,
      issuer: ISSUER,
      resource: RESOURCE,
      environment: "production",
      clients: new Map([
        [CLAUDE, { clientId: CLAUDE, family: "claude", label: "Claude" }],
      ]),
      consents: {
        read: async () => ({
          interactionUid: INTERACTION,
          connectionId: CONNECTION,
          humanAccountId: OWNER,
          oauthClientId: CLAUDE,
          resource: RESOURCE,
          preset,
        }),
        decide: async (input: { decision: string }) => {
          events.push(`decide:${input.decision}`);
          return { decision: input.decision };
        },
      },
      connections: {
        read: async () => ({
          connection: { ...connection, humanAccountId: OWNER },
          version: 1,
        }),
        compareAndSet: async () => {
          events.push("compareAndSet");
          return { connection, version: 2 };
        },
        listAuthorized: async () => [
          { connection, version: 1, lastVerifiedAt: null, currentGrantId: "g" },
        ],
        listForHuman: async () => {
          events.push("listForHuman");
          return [];
        },
      },
      authority: {
        revoke: async (id: string) => {
          events.push("revoke");
          return { ...connection, id, status: "revoked" };
        },
      },
      principals: {},
      close: async () => undefined,
      ...overrides,
    };
  };

  const useRuntime = (runtime: unknown) => {
    runtimeStub.current = runtime;
  };

  const handlerOf = (method: string, pathname: string) => {
    const endpoint = agentConnectionEndpoints({
      NODE_ENV: "development",
      AGENT_CONNECTIONS_ENABLED: "true",
    } as NodeJS.ProcessEnv).find(
      (entry) => entry.method === method && entry.path === pathname,
    );
    if (endpoint === undefined) throw new Error(`no ${method} ${pathname}`);
    return endpoint.handler;
  };

  /** Only `isHumanOwner` reads these, so they say exactly what it needs. */
  const request = (
    events: string[],
    options: {
      readonly user?: Record<string, unknown> | null;
      readonly headers?: Record<string, string>;
      readonly body?: unknown;
      readonly auditFails?: "start" | "finish";
    } = {},
  ) => {
    const logged: unknown[] = [];
    const rows: Record<string, unknown>[] = [];
    return {
      rows,
      logged,
      req: {
        url: `${ADMIN_ORIGIN}/api/agent-connections`,
        user:
          options.user === undefined
            ? {
                collection: "users",
                role: "owner",
                id: 7,
                _strategy: "local-jwt",
              }
            : options.user,
        headers: new Headers(
          options.headers ?? {
            cookie: "payload-token=synthetic",
            origin: ADMIN_ORIGIN,
          },
        ),
        json: async () => options.body,
        payload: {
          config: { cookiePrefix: "payload" },
          logger: { error: (entry: unknown) => logged.push(entry) },
          find: async () => ({
            docs: [
              { id: 7, email: "seven@example.invalid" },
              { id: 8, email: "eight@example.invalid" },
            ],
          }),
          create: async ({ data }: { data: Record<string, unknown> }) => {
            if (options.auditFails === data.phase)
              throw new Error("synthetic audit failure");
            events.push(`audit:${String(data.phase)}`);
            rows.push(data);
            return data;
          },
        },
      } as never,
    };
  };

  const decision = {
    interaction: INTERACTION,
    ticket: TICKET,
    decision: "approve",
  };

  const answerOf = async (response: Response) => ({
    status: response.status,
    body: (await response.json()) as {
      ok: boolean;
      error?: string;
      result?: Record<string, unknown>;
    },
  });

  it.each([
    ["anonymous", { user: null }],
    [
      "an automation session",
      {
        user: {
          collection: "users",
          role: "automation",
          id: 7,
          _strategy: "local-jwt",
        },
      },
    ],
    [
      "an AI key",
      {
        user: {
          collection: "users",
          role: "ai_operator",
          id: 7,
          _strategy: "mcp-api-key",
        },
      },
    ],
    [
      "an AI connection",
      {
        user: {
          collection: "users",
          role: "ai_operator",
          id: 7,
          _strategy: "mcp-connection",
        },
      },
    ],
    [
      "an Owner with a REST key",
      {
        user: {
          collection: "users",
          role: "owner",
          id: 7,
          _strategy: "api-key",
        },
      },
    ],
    [
      "an Owner JWT in a header",
      {
        headers: {
          authorization: "JWT synthetic",
          cookie: "payload-token=synthetic",
          origin: ADMIN_ORIGIN,
        },
      },
    ],
    ["an Owner JWT with no cookie", { headers: { origin: ADMIN_ORIGIN } }],
  ])("refuses %s on every route, touching nothing", async (_name, options) => {
    const events: string[] = [];
    useRuntime(stubRuntime("operator", events));
    for (const [method, pathname, body] of [
      ["post", "/agent-connections/consent", decision],
      ["get", "/agent-connections", undefined],
      ["post", "/agent-connections/disconnect", { id: CONNECTION }],
      ["post", "/agent-connections/start", { clientId: CLAUDE }],
    ] as const) {
      const { req, rows } = request(events, { ...options, body });
      expect([
        pathname,
        await answerOf(await handlerOf(method, pathname)(req)),
      ]).toEqual([
        pathname,
        { status: 403, body: { ok: false, error: "OWNER_ONLY" } },
      ]);
      expect(rows).toEqual([]);
    }
    expect(events).toEqual([]);
  });

  it.each([
    ["none", { cookie: "payload-token=synthetic" }],
    [
      "another site's",
      {
        cookie: "payload-token=synthetic",
        origin: "https://evil.example.invalid",
      },
    ],
    [
      "the same host over http",
      {
        cookie: "payload-token=synthetic",
        origin: "http://admin.artvenn.invalid",
      },
    ],
  ])("refuses a change whose Origin is %s", async (_name, headers) => {
    vi.stubEnv("CMS_PUBLIC_URL", ADMIN_ORIGIN);
    const events: string[] = [];
    useRuntime(stubRuntime("operator", events));
    for (const [pathname, body] of [
      ["/agent-connections/consent", decision],
      ["/agent-connections/disconnect", { id: CONNECTION }],
      ["/agent-connections/start", { clientId: CLAUDE }],
    ] as const) {
      const { req } = request(events, { headers, body });
      expect(await answerOf(await handlerOf("post", pathname)(req))).toEqual({
        status: 403,
        body: { ok: false, error: "ORIGIN_REQUIRED" },
      });
    }
    expect(events).toEqual([]);
  });

  it("checks the Origin against the public address, not Next's internal one", async () => {
    vi.stubEnv("CMS_PUBLIC_URL", "https://public.artvenn.invalid");
    const events: string[] = [];
    useRuntime(stubRuntime("operator", events));
    const { req } = request(events, {
      body: { id: CONNECTION },
      headers: {
        cookie: "payload-token=synthetic",
        origin: ADMIN_ORIGIN,
      },
    });
    expect(
      await answerOf(
        await handlerOf("post", "/agent-connections/disconnect")(req),
      ),
    ).toMatchObject({ status: 403, body: { error: "ORIGIN_REQUIRED" } });
  });

  it("reads the list with no Origin, as a browser's same-origin GET has none", async () => {
    const events: string[] = [];
    useRuntime(stubRuntime("operator", events));
    const { req } = request(events, {
      headers: { cookie: "payload-token=synthetic" },
    });
    expect(
      (await answerOf(await handlerOf("get", "/agent-connections")(req)))
        .status,
    ).toBe(200);
  });

  it("writes the reserved row first, then decides, then says how it ended", async () => {
    vi.stubEnv("CMS_PUBLIC_URL", ADMIN_ORIGIN);
    const events: string[] = [];
    useRuntime(stubRuntime("operator", events));
    const { req, rows } = request(events, {
      body: { ...decision, decision: "deny" },
    });
    const answer = await answerOf(
      await handlerOf("post", "/agent-connections/consent")(req),
    );
    expect(answer).toMatchObject({
      status: 200,
      body: { ok: true, result: { decision: "denied" } },
    });
    expect(events).toEqual(["audit:start", "decide:denied", "audit:finish"]);
    expect(rows[0]).toMatchObject({
      phase: "start",
      class: "reserved",
      op: "agent-connections.deny",
      targetType: "agent-connections",
      targetId: INTERACTION,
      connectionId: CONNECTION,
      keyLabel: "Claude",
      // The person acting, not an AI row.
      userId: "7",
    });
    expect(rows[0]).not.toHaveProperty("ok");
    expect(rows[1]).toMatchObject({
      phase: "finish",
      callId: rows[0]?.callId,
      ok: true,
      code: "OK",
    });
    expect(JSON.stringify(rows)).not.toContain(TICKET);
  });

  it("does not decide at all when the row cannot be written", async () => {
    vi.stubEnv("CMS_PUBLIC_URL", ADMIN_ORIGIN);
    const events: string[] = [];
    useRuntime(stubRuntime("operator", events));
    for (const [pathname, body] of [
      ["/agent-connections/consent", decision],
      ["/agent-connections/disconnect", { id: CONNECTION }],
    ] as const) {
      const { req } = request(events, { body, auditFails: "start" });
      expect(await answerOf(await handlerOf("post", pathname)(req))).toEqual({
        status: 500,
        body: { ok: false, error: "CONSENT_UNAVAILABLE" },
      });
    }
    expect(events).toEqual([]);
  });

  it("records a refused decision as refused, and answers the refusal", async () => {
    vi.stubEnv("CMS_PUBLIC_URL", ADMIN_ORIGIN);
    const events: string[] = [];
    const runtime = stubRuntime("operator", events);
    useRuntime({
      ...runtime,
      consents: {
        ...runtime.consents,
        decide: async () => {
          events.push("decide:refused");
          return null;
        },
      },
    });
    const { req, rows } = request(events, {
      body: { ...decision, decision: "deny" },
    });
    expect(
      await answerOf(
        await handlerOf("post", "/agent-connections/consent")(req),
      ),
    ).toEqual({
      status: 400,
      body: { ok: false, error: "CONSENT_NOT_DECIDABLE" },
    });
    expect(events).toEqual(["audit:start", "decide:refused", "audit:finish"]);
    expect(rows[1]).toMatchObject({
      ok: false,
      code: "CONSENT_NOT_DECIDABLE",
    });
  });

  it("keeps a change whose closing row was lost, and logs a category", async () => {
    vi.stubEnv("CMS_PUBLIC_URL", ADMIN_ORIGIN);
    const events: string[] = [];
    useRuntime(stubRuntime("operator", events));
    const { req, logged } = request(events, {
      body: { id: CONNECTION },
      auditFails: "finish",
    });
    expect(
      (
        await answerOf(
          await handlerOf("post", "/agent-connections/disconnect")(req),
        )
      ).status,
    ).toBe(200);
    expect(events).toEqual(["audit:start", "revoke"]);
    expect(logged).toEqual([{ category: "AGENT_CONNECTION_AUDIT_FAILED" }]);
  });

  it("leaves no row for a malformed body or a uid nobody opened", async () => {
    vi.stubEnv("CMS_PUBLIC_URL", ADMIN_ORIGIN);
    const events: string[] = [];
    const runtime = stubRuntime("operator", events);
    useRuntime(runtime);
    const malformed = request(events, {
      body: { ...decision, decision: "yes" },
    });
    expect(
      await answerOf(
        await handlerOf("post", "/agent-connections/consent")(malformed.req),
      ),
    ).toMatchObject({ status: 400, body: { error: "REQUEST_MALFORMED" } });
    useRuntime({
      ...runtime,
      consents: { ...runtime.consents, read: async () => null },
    });
    const unknown = request(events, { body: decision });
    expect(
      await answerOf(
        await handlerOf("post", "/agent-connections/consent")(unknown.req),
      ),
    ).toMatchObject({ status: 400, body: { error: "CONSENT_NOT_DECIDABLE" } });
    expect(events).toEqual([]);
  });

  it("lets any owner disconnect anyone's connection under operator, with the row first", async () => {
    vi.stubEnv("CMS_PUBLIC_URL", ADMIN_ORIGIN);
    const events: string[] = [];
    const runtime = stubRuntime("operator", events);
    useRuntime({
      ...runtime,
      connections: {
        ...runtime.connections,
        read: async () => ({
          connection: {
            id: CONNECTION,
            humanAccountId: "payload-user-8",
            oauthClientId: CLAUDE,
          },
          version: 1,
        }),
      },
    });
    const { req, rows } = request(events, { body: { id: CONNECTION } });
    expect(
      await answerOf(
        await handlerOf("post", "/agent-connections/disconnect")(req),
      ),
    ).toEqual({
      status: 200,
      body: { ok: true, result: { id: CONNECTION, status: "revoked" } },
    });
    expect(events).toEqual(["audit:start", "revoke", "audit:finish"]);
    expect(rows[0]).toMatchObject({
      op: "agent-connections.disconnect",
      targetId: CONNECTION,
      connectionId: CONNECTION,
      keyLabel: "Claude",
      userId: "7",
    });
  });

  it("keeps the read-only profile to the acting person's own connection", async () => {
    vi.stubEnv("CMS_PUBLIC_URL", ADMIN_ORIGIN);
    const events: string[] = [];
    const runtime = stubRuntime("read-only", events);
    useRuntime({
      ...runtime,
      connections: {
        ...runtime.connections,
        read: async () => ({
          connection: {
            id: CONNECTION,
            humanAccountId: "payload-user-8",
            oauthClientId: CLAUDE,
          },
          version: 1,
        }),
      },
    });
    const { req } = request(events, { body: { id: CONNECTION } });
    expect(
      await answerOf(
        await handlerOf("post", "/agent-connections/disconnect")(req),
      ),
    ).toMatchObject({ status: 404, body: { error: "CONNECTION_NOT_FOUND" } });
    expect(events).toEqual([]);
  });

  it("lists every live connection under operator, with who authorized it", async () => {
    const events: string[] = [];
    useRuntime(stubRuntime("operator", events));
    const { req } = request(events);
    const { body } = await answerOf(
      await handlerOf("get", "/agent-connections")(req),
    );
    expect(events).toEqual([]);
    expect(body.result).toEqual({
      preset: "operator",
      resource: RESOURCE,
      clients: [{ family: "claude", label: "Claude" }],
      connections: [
        {
          id: CONNECTION,
          family: "claude",
          tool: "Claude",
          authorizedBy: "eight@example.invalid",
          mine: false,
          consentedAt: "2026-11-05T00:00:00.000Z",
          lastVerifiedAt: null,
        },
      ],
    });
    // Nothing that would put a client id or a principal on a screen.
    expect(JSON.stringify(body.result)).not.toContain(CLAUDE);
    expect(JSON.stringify(body.result)).not.toContain("agent-claude");
  });

  it("still lists a connection whose person or tool has gone, so it can be stopped", async () => {
    const events: string[] = [];
    const runtime = stubRuntime("operator", events);
    useRuntime({
      ...runtime,
      clients: new Map(),
      connections: {
        ...runtime.connections,
        listAuthorized: async () => [
          {
            connection: {
              id: CONNECTION,
              humanAccountId: "payload-user-99",
              client: "claude",
              oauthClientId: CLAUDE,
              consentedAt: "2026-11-05T00:00:00.000Z",
            },
            version: 1,
            lastVerifiedAt: "2026-11-05T01:00:00.000Z",
            currentGrantId: "g",
          },
        ],
      },
    });
    const { req } = request(events);
    const { body } = await answerOf(
      await handlerOf("get", "/agent-connections")(req),
    );
    expect(body.result?.connections).toEqual([
      {
        id: CONNECTION,
        family: "claude",
        tool: null,
        authorizedBy: null,
        mine: false,
        consentedAt: "2026-11-05T00:00:00.000Z",
        lastVerifiedAt: "2026-11-05T01:00:00.000Z",
      },
    ]);
  });

  it("gives the read-only page its own person's rows, in the shape it always had", async () => {
    const events: string[] = [];
    useRuntime(stubRuntime("read-only", events));
    const { req } = request(events);
    const { body } = await answerOf(
      await handlerOf("get", "/agent-connections")(req),
    );
    expect(events).toEqual(["listForHuman"]);
    expect(Object.keys(body.result ?? {}).sort()).toEqual([
      "authMethod",
      "clients",
      "connections",
      "environment",
      "issuer",
      "resource",
    ]);
  });

  it("answers 404 when the door's runtime is off, and a bare code when it refused", async () => {
    vi.stubEnv("CMS_PUBLIC_URL", ADMIN_ORIGIN);
    const events: string[] = [];
    useRuntime(null);
    expect(
      await answerOf(
        await handlerOf("get", "/agent-connections")(request(events).req),
      ),
    ).toMatchObject({ status: 404, body: { error: "NOT_FOUND" } });
    useRuntime(new ConsentRuntimeError("CONSENT_DATABASE_TLS_REQUIRED"));
    expect(
      await answerOf(
        await handlerOf("get", "/agent-connections")(request(events).req),
      ),
    ).toEqual({
      status: 500,
      body: { ok: false, error: "CONSENT_UNAVAILABLE" },
    });
  });
});
