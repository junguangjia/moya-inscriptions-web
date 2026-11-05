import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import http from "node:http";
import https from "node:https";
import type { JsonWebKey } from "node:crypto";
import type { createPostgresPool } from "@moya/catalog-postgres";
type Pool = ReturnType<typeof createPostgresPool>;
import {
  adminAuthorizationPostgresFrom,
  articleAuthorizationConfigFrom,
  authorizationConfigFrom,
  authorizationEnabled,
  prepareAdminAuthorizationKeys,
  reapExpiredArtifacts,
  startArtifactReaper,
  startAuthorizationServer,
} from "@moya/agent-authorization";
import {
  connectionsEnabled,
  connectionOverrideAuth,
} from "admin/agent-connections";
import {
  connectionAuthDependencies,
  createResourceRuntime,
  resetResourceRuntime,
} from "admin/agent-connections-resource";
import { agentAdminTools } from "admin/agent-admin-mcp";
import { requiredCommunityMigrations } from "@moya/community-postgres";

/**
 * Issue #355, login door, slice O1: the Admin issuer's Production boundary, the
 * mirror of `article-production-issuer.test.ts`. Only persistence is replaced in
 * this file. The actual oidc-provider, HTTP listener, HTTPS proxy, key parsing
 * and cookies run. What the real PostgreSQL stores do is in
 * `tests/integration/postgres/agent-operator-flow-cases.ts`.
 */

const stores = vi.hoisted(() => ({
  minted: [] as string[],
  invalidated: [] as string[],
  opened: [] as Record<string, unknown>[],
  deleted: { wrappers: 0, consents: 0 },
}));

vi.mock("@moya/community-postgres", async (original) => {
  const actual = await original<typeof import("@moya/community-postgres")>();
  return {
    ...actual,
    createProviderAdapter: () => {
      const rows = new Map<string, Map<string, Record<string, unknown>>>();
      return class {
        readonly entries: Map<string, Record<string, unknown>>;
        constructor(name: string) {
          let entries = rows.get(name);
          if (!entries) {
            entries = new Map();
            rows.set(name, entries);
          }
          this.entries = entries;
        }
        async upsert(id: string, payload: Record<string, unknown>) {
          this.entries.set(id, structuredClone(payload));
        }
        async find(id: string) {
          return this.entries.get(id);
        }
        async findByUid(uid: string) {
          return [...this.entries.values()].find((value) => value.uid === uid);
        }
        async destroy(id: string) {
          this.entries.delete(id);
        }
        async consume(id: string) {
          const value = this.entries.get(id);
          if (value) value.consumed = Math.floor(Date.now() / 1000);
        }
        async revokeByGrantId(id: string) {
          for (const [key, value] of this.entries)
            if (value.grantId === id) this.entries.delete(key);
        }
      };
    },
    createWrapperStore: () => ({
      mint: async ({ grantId }: { grantId: string }) => {
        stores.minted.push(grantId);
        return { presented: "synthetic-wrapped-access" };
      },
      invalidateByGrant: async (grantId: string) => {
        stores.invalidated.push(grantId);
        return 1;
      },
    }),
    createConsentStore: () => ({
      open: async (opening: Record<string, unknown>) => {
        stores.opened.push(opening);
        return null;
      },
      read: async () => null,
      voidResume: async () => null,
      resumeSecretMatches: async () => false,
    }),
  };
});

const ISSUER_HOST = "admin-auth.example.invalid";
const RESOURCE = "https://app.example.invalid/api/mcp";
const HOSTED_CLIENT = "https://tool.example.invalid/oauth/client.json";
const HOSTED_CALLBACK = "https://tool.example.invalid/oauth/callback";
const LOOPBACK_CLIENT = "https://tool.example.invalid/oauth/native.json";

let directory: string;
let privateJwk: JsonWebKey;
let sequence = 0;
const keyFile = (value: unknown = { keys: [privateJwk] }, mode = 0o600) => {
  const file = join(directory, `signing-${++sequence}.json`);
  writeFileSync(file, JSON.stringify(value), { mode });
  return file;
};
const key32 = () => randomBytes(32).toString("base64");

const environment = (): NodeJS.ProcessEnv => ({
  NODE_ENV: "production",
  ADMIN_MCP_OAUTH_ENABLED: "true",
  AGENT_AUTHORIZATION_ISSUER: `https://${ISSUER_HOST}`,
  AGENT_AUTHORIZATION_RESOURCE: RESOURCE,
  AGENT_AUTHORIZATION_CONSENT_URL: "https://app.example.invalid",
  AGENT_AUTHORIZATION_PORT: "44561",
  AGENT_AUTHORIZATION_ENVIRONMENT: "production",
  AGENT_AUTHORIZATION_CLIENTS: JSON.stringify([
    {
      clientId: HOSTED_CLIENT,
      family: "claude",
      label: "Hosted synthetic tool",
      callbackPolicy: "hosted-https",
      redirectUris: [HOSTED_CALLBACK],
    },
    {
      clientId: LOOPBACK_CLIENT,
      family: "codex",
      label: "Local synthetic tool",
      callbackPolicy: "loopback-host",
      redirectUris: ["http://127.0.0.1:44563/callback"],
    },
  ]),
  AGENT_AUTHORIZATION_DATABASE_URL:
    "postgres://admin_issuer@127.0.0.1:5432/fixture?sslmode=disable",
  AGENT_CONSENT_DATABASE_TARGET:
    "postgres://admin_consent@127.0.0.1:5432/fixture?sslmode=disable",
  AGENT_RESOURCE_DATABASE_TARGET:
    "postgres://admin_resource@127.0.0.1:5432/fixture?sslmode=disable",
  DATABASE_TARGET:
    "postgres://catalog_read@127.0.0.1:5432/fixture?sslmode=disable",
  CMS_DATABASE_TARGET:
    "postgres://cms_runtime@127.0.0.1:5432/fixture?sslmode=disable",
  AGENT_CONNECTION_PROVIDER_INDEX_KEY: key32(),
  AGENT_CONNECTION_PROVIDER_SEAL_KEY: key32(),
  AGENT_CONNECTION_WRAPPER_INDEX_KEY: key32(),
  AGENT_CONNECTION_WRAPPER_SEAL_KEY: key32(),
  AGENT_AUTHORIZATION_COOKIE_KEY: randomBytes(32).toString("base64url"),
  AGENT_AUTHORIZATION_SIGNING_JWKS_FILE: keyFile(),
});

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "admin-issuer-config-"));
  chmodSync(directory, 0o700);
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  privateJwk = {
    ...privateKey.export({ format: "jwk" }),
    kid: "synthetic-current",
    use: "sig",
    alg: "RS256",
  };
});
afterAll(() => rmSync(directory, { recursive: true, force: true }));

describe("the gate", () => {
  it("opens in Production only for its own setting, and in Development only for its own", () => {
    const enabled = authorizationEnabled;
    expect(enabled({ NODE_ENV: "production" })).toBe(false);
    expect(
      enabled({ NODE_ENV: "production", AGENT_AUTHORIZATION_ENABLED: "true" }),
    ).toBe(false);
    expect(
      enabled({ NODE_ENV: "production", ADMIN_MCP_OAUTH_ENABLED: "false" }),
    ).toBe(false);
    expect(
      enabled({ NODE_ENV: "production", ADMIN_MCP_OAUTH_ENABLED: "true" }),
    ).toBe(true);
    expect(
      enabled({ NODE_ENV: "development", ADMIN_MCP_OAUTH_ENABLED: "true" }),
    ).toBe(false);
    expect(
      enabled({ NODE_ENV: "development", AGENT_AUTHORIZATION_ENABLED: "true" }),
    ).toBe(true);
    for (const value of ["test", "staging", "", undefined])
      expect(
        enabled({
          NODE_ENV: value as never,
          ADMIN_MCP_OAUTH_ENABLED: "true",
          AGENT_AUTHORIZATION_ENABLED: "true",
        }),
      ).toBe(false);
  });

  it("is always the operator profile in Production, whatever the setting says", () => {
    expect(authorizationConfigFrom(environment()).profile).toBe("operator");
    expect(
      authorizationConfigFrom({
        ...environment(),
        AGENT_AUTHORIZATION_PROFILE: "read-only",
      }).profile,
    ).toBe("operator");
  });

  it("defaults to read-only in Development, and refuses a profile it does not know", () => {
    const development: NodeJS.ProcessEnv = {
      ...environment(),
      NODE_ENV: "development",
      AGENT_AUTHORIZATION_ISSUER: "http://auth.localhost:44561",
      AGENT_AUTHORIZATION_RESOURCE: "http://app.localhost:44562/api/mcp",
      AGENT_AUTHORIZATION_CONSENT_URL: "http://app.localhost:44562",
      AGENT_AUTHORIZATION_ENVIRONMENT: "development",
      AGENT_AUTHORIZATION_CLIENTS: JSON.stringify([
        {
          clientId: "synthetic-loopback",
          family: "codex",
          label: "Local synthetic tool",
          redirectUris: ["http://127.0.0.1:44563/callback"],
        },
      ]),
    };
    expect(authorizationConfigFrom(development).profile).toBe("read-only");
    expect(
      authorizationConfigFrom({
        ...development,
        AGENT_AUTHORIZATION_PROFILE: "operator",
      }).profile,
    ).toBe("operator");
    expect(() =>
      authorizationConfigFrom({
        ...development,
        AGENT_AUTHORIZATION_PROFILE: "owner",
      }),
    ).toThrow(expect.objectContaining({ code: "PROFILE_UNKNOWN" }));
  });

  it("composes nothing on the plugin path in Production, with either setting on", () => {
    for (const settings of [
      { AGENT_CONNECTIONS_ENABLED: "true" },
      { ADMIN_MCP_OAUTH_ENABLED: "true" },
      { AGENT_CONNECTIONS_ENABLED: "true", ADMIN_MCP_OAUTH_ENABLED: "true" },
    ]) {
      const env = { NODE_ENV: "production", ...settings } as NodeJS.ProcessEnv;
      expect(connectionsEnabled(env)).toBe(false);
    }
    expect(
      createResourceRuntime({
        NODE_ENV: "production",
        AGENT_CONNECTIONS_ENABLED: "true",
      }),
    ).toBeNull();
    // What the plugin path composes from, built afresh under those settings.
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AGENT_CONNECTIONS_ENABLED", "true");
    vi.stubEnv("ADMIN_MCP_OAUTH_ENABLED", "true");
    resetResourceRuntime();
    try {
      expect(connectionAuthDependencies()).toBeNull();
    } finally {
      vi.unstubAllEnvs();
      resetResourceRuntime();
    }
  });

  it("refuses a connection token on the plugin path when nothing is composed", async () => {
    const auth = connectionOverrideAuth(null);
    const legacy = vi.fn(async () => ({}) as never);
    const presented = `artvenn_ct_${randomBytes(32).toString("base64url")}`;
    await expect(
      auth(
        {
          headers: new Headers({ Authorization: `Bearer ${presented}` }),
        } as never,
        legacy,
      ),
    ).rejects.toThrow();
    expect(legacy).not.toHaveBeenCalled();
  });

  it("keeps artvenn_* answering NOT_FOUND in Production with the door on", async () => {
    const callFor = vi.fn(() => {
      throw new Error("the operator channel must not be reached");
    });
    const bound = {
      headers: new Headers(),
      user: {
        collection: "users",
        id: 1,
        role: "automation",
        agentPrincipal: "agent-reviewer",
      },
    };
    const reply = async (tool: ReturnType<typeof agentAdminTools>[number]) => {
      const answer = (await tool.handler({}, bound as never, undefined)) as {
        content: { text: string }[];
      };
      return JSON.parse(answer.content[0]!.text) as { code?: string };
    };
    try {
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("AGENT_CONNECTIONS_ENABLED", "true");
      vi.stubEnv("ADMIN_MCP_OAUTH_ENABLED", "true");
      const tools = agentAdminTools(callFor);
      expect(tools.length).toBeGreaterThan(0);
      for (const tool of tools)
        expect(await reply(tool)).toEqual({ ok: false, code: "NOT_FOUND" });
      expect(callFor).not.toHaveBeenCalled();

      // Not refused for some other reason: the same call passes the gate here.
      vi.stubEnv("NODE_ENV", "development");
      expect((await reply(tools[0]!)).code).not.toBe("NOT_FOUND");
      expect(callFor).toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("Production configuration", () => {
  it.each([
    ["an http issuer", { AGENT_AUTHORIZATION_ISSUER: `http://${ISSUER_HOST}` }],
    [
      "an issuer with a path",
      { AGENT_AUTHORIZATION_ISSUER: `https://${ISSUER_HOST}/path` },
    ],
    [
      "an issuer with a bare query",
      { AGENT_AUTHORIZATION_ISSUER: `https://${ISSUER_HOST}?` },
    ],
    [
      "a consent page on the issuer's host",
      { AGENT_AUTHORIZATION_CONSENT_URL: `https://${ISSUER_HOST}` },
    ],
    [
      "an http consent page",
      { AGENT_AUTHORIZATION_CONSENT_URL: "http://app.example.invalid" },
    ],
    [
      "a consent page with a path",
      { AGENT_AUTHORIZATION_CONSENT_URL: "https://app.example.invalid/admin" },
    ],
    [
      "an http resource",
      { AGENT_AUTHORIZATION_RESOURCE: "http://app.example.invalid/api/mcp" },
    ],
    [
      "another resource path",
      { AGENT_AUTHORIZATION_RESOURCE: "https://app.example.invalid/other" },
    ],
    [
      "a resource with a query",
      { AGENT_AUTHORIZATION_RESOURCE: `${RESOURCE}?other=1` },
    ],
    ["a listener on the public port", { AGENT_AUTHORIZATION_PORT: "443" }],
    ["no listener port", { AGENT_AUTHORIZATION_PORT: "" }],
    ["no environment name", { AGENT_AUTHORIZATION_ENVIRONMENT: "" }],
    [
      "a misleading environment",
      { AGENT_AUTHORIZATION_ENVIRONMENT: "staging" },
    ],
    ["no client list", { AGENT_AUTHORIZATION_CLIENTS: "" }],
    ["an empty client list", { AGENT_AUTHORIZATION_CLIENTS: "[]" }],
    ["no database url", { AGENT_AUTHORIZATION_DATABASE_URL: "" }],
    [
      "the Article issuer's host",
      { ARTICLE_AUTHORING_ISSUER: `https://${ISSUER_HOST}` },
    ],
  ])("refuses %s", (_name, override) => {
    expect(() =>
      authorizationConfigFrom({ ...environment(), ...override }),
    ).toThrow("agent authorization configuration refused");
  });

  it("accepts a separate Article host, and listens on loopback only", () => {
    const config = authorizationConfigFrom({
      ...environment(),
      ARTICLE_AUTHORING_ISSUER: "https://article-issuer.example.invalid",
    });
    expect(config.host).toBe("127.0.0.1");
    expect(config.issuer).toBe(`https://${ISSUER_HOST}`);
    expect(config.resource).toBe(RESOURCE);
  });

  it("accepts an explicit public port as long as the listener differs from it", () => {
    const env = {
      ...environment(),
      AGENT_AUTHORIZATION_ISSUER: `https://${ISSUER_HOST}:44560`,
    };
    expect(authorizationConfigFrom(env).issuer).toBe(
      env.AGENT_AUTHORIZATION_ISSUER,
    );
    expect(() =>
      authorizationConfigFrom({ ...env, AGENT_AUTHORIZATION_PORT: "44560" }),
    ).toThrow(
      expect.objectContaining({ code: "LISTENER_PORT_IS_THE_PUBLIC_PORT" }),
    );
  });

  it("keeps Development's listener rule, and its environment cannot claim Production", () => {
    const development: NodeJS.ProcessEnv = {
      ...environment(),
      NODE_ENV: "development",
      AGENT_AUTHORIZATION_PROFILE: "operator",
      AGENT_AUTHORIZATION_ISSUER: "http://auth.localhost:44561",
      AGENT_AUTHORIZATION_RESOURCE: "http://app.localhost:44562/api/mcp",
      AGENT_AUTHORIZATION_CONSENT_URL: "http://app.localhost:44562",
      AGENT_AUTHORIZATION_ENVIRONMENT: "development",
    };
    expect(authorizationConfigFrom(development).issuer).toBe(
      "http://auth.localhost:44561",
    );
    expect(() =>
      authorizationConfigFrom({
        ...development,
        AGENT_AUTHORIZATION_PORT: "44565",
      }),
    ).toThrow(
      expect.objectContaining({ code: "ISSUER_PORT_DISAGREES_WITH_LISTENER" }),
    );
    expect(() =>
      authorizationConfigFrom({
        ...development,
        AGENT_AUTHORIZATION_ENVIRONMENT: "production",
      }),
    ).toThrow(
      expect.objectContaining({ code: "ENVIRONMENT_DISAGREES_WITH_NODE_ENV" }),
    );
  });

  it("takes hosted clients under operator only, and Article refuses them by name", () => {
    const hosted = environment().AGENT_AUTHORIZATION_CLIENTS!;
    expect(
      [...authorizationConfigFrom(environment()).clients.keys()].sort(),
    ).toEqual([HOSTED_CLIENT, LOOPBACK_CLIENT].sort());
    expect(() =>
      authorizationConfigFrom({
        ...environment(),
        NODE_ENV: "development",
        AGENT_AUTHORIZATION_ISSUER: "http://auth.localhost:44561",
        AGENT_AUTHORIZATION_RESOURCE: "http://app.localhost:44562/api/mcp",
        AGENT_AUTHORIZATION_CONSENT_URL: "http://app.localhost:44562",
        AGENT_AUTHORIZATION_ENVIRONMENT: "development",
      }),
    ).toThrow(expect.objectContaining({ code: "CLIENTS_HOSTED_NOT_ALLOWED" }));
    expect(() =>
      articleAuthorizationConfigFrom({
        NODE_ENV: "production",
        ARTICLE_AUTHORING_ENABLED: "true",
        ARTICLE_AUTHORING_ISSUER: "https://article-issuer.example.invalid",
        ARTICLE_AUTHORING_RESOURCE:
          "https://app.example.invalid/mcp/article-authoring",
        ARTICLE_AUTHORING_CONSENT_ORIGIN: "https://app.example.invalid",
        ARTICLE_AUTHORIZATION_PORT: "44551",
        ARTICLE_AUTHORIZATION_DATABASE_URL:
          "postgres://article_issuer@127.0.0.1:5432/fixture?sslmode=disable",
        ARTICLE_AUTHORING_CLIENTS: hosted,
      }),
    ).toThrow(expect.objectContaining({ code: "CLIENTS_HOSTED_NOT_ALLOWED" }));
  });

  it("refuses a hosted callback that is not exactly one https URL", () => {
    for (const redirect of [
      "http://tool.example.invalid/oauth/callback",
      "https://tool.example.invalid/",
      "https://tool.example.invalid:443/oauth/callback",
      "https://tool.example.invalid/oauth/callback?x=1",
      "https://127.0.0.1/oauth/callback",
      "https://localhost/oauth/callback",
    ])
      expect(() =>
        authorizationConfigFrom({
          ...environment(),
          AGENT_AUTHORIZATION_CLIENTS: JSON.stringify([
            {
              clientId: HOSTED_CLIENT,
              family: "claude",
              label: "Hosted synthetic tool",
              callbackPolicy: "hosted-https",
              redirectUris: [redirect],
            },
          ]),
        }),
      ).toThrow(
        expect.objectContaining({ code: "CLIENTS_REDIRECT_NOT_HOSTED" }),
      );
  });
});

describe("Protected keys", () => {
  const prepare = (env: NodeJS.ProcessEnv) =>
    prepareAdminAuthorizationKeys(authorizationConfigFrom(env), env);
  const REFUSED = "ADMIN_AUTHORIZATION_KEYS_REFUSED";

  it("hands back all of them, with the signing keys from the file", () => {
    const prepared = prepare(environment());
    expect(prepared.cookieKey).toBeTruthy();
    expect(prepared.jwks?.keys.map((key) => key.kid)).toEqual([
      "synthetic-current",
    ]);
    expect(prepared.providerKeys.indexKey).toHaveLength(32);
    expect(prepared.wrapperKeys.sealKey).toHaveLength(32);
  });

  it.each([
    "AGENT_CONNECTION_PROVIDER_INDEX_KEY",
    "AGENT_CONNECTION_PROVIDER_SEAL_KEY",
    "AGENT_CONNECTION_WRAPPER_INDEX_KEY",
    "AGENT_CONNECTION_WRAPPER_SEAL_KEY",
    "AGENT_AUTHORIZATION_COOKIE_KEY",
    "AGENT_AUTHORIZATION_SIGNING_JWKS_FILE",
  ])("refuses to start with %s missing", (name) => {
    const env = environment();
    delete env[name];
    expect(() => prepare(env)).toThrow(REFUSED);
  });

  it("refuses a key that is short, not canonical or reused", () => {
    const short = environment();
    short.AGENT_CONNECTION_PROVIDER_SEAL_KEY =
      randomBytes(16).toString("base64");
    expect(() => prepare(short)).toThrow(REFUSED);

    const shortCookie = environment();
    shortCookie.AGENT_AUTHORIZATION_COOKIE_KEY =
      randomBytes(16).toString("base64url");
    expect(() => prepare(shortCookie)).toThrow(REFUSED);

    // Long enough to read, 24 bytes once decoded.
    const shortOnceDecoded = environment();
    shortOnceDecoded.AGENT_AUTHORIZATION_COOKIE_KEY =
      randomBytes(24).toString("base64url");
    expect(() => prepare(shortOnceDecoded)).toThrow(REFUSED);

    // Decodes to 32 bytes, but not the spelling a generated key would have.
    const spelled = environment();
    spelled.AGENT_CONNECTION_WRAPPER_INDEX_KEY = randomBytes(32)
      .toString("base64")
      .replace(/=$/u, "");
    expect(() => prepare(spelled)).toThrow(REFUSED);

    const reused = environment();
    reused.AGENT_CONNECTION_WRAPPER_SEAL_KEY =
      reused.AGENT_CONNECTION_PROVIDER_INDEX_KEY;
    expect(() => prepare(reused)).toThrow(REFUSED);

    const cookieReused = environment();
    cookieReused.AGENT_AUTHORIZATION_COOKIE_KEY = Buffer.from(
      cookieReused.AGENT_CONNECTION_PROVIDER_SEAL_KEY!,
      "base64",
    ).toString("base64url");
    expect(() => prepare(cookieReused)).toThrow(REFUSED);
  });

  it.each([
    [
      "ARTICLE_AUTHORING_PROVIDER_INDEX_KEY",
      "AGENT_CONNECTION_PROVIDER_INDEX_KEY",
    ],
    [
      "ARTICLE_AUTHORING_PROVIDER_SEAL_KEY",
      "AGENT_CONNECTION_WRAPPER_INDEX_KEY",
    ],
    [
      "ARTICLE_AUTHORING_WRAPPER_INDEX_KEY",
      "AGENT_CONNECTION_WRAPPER_INDEX_KEY",
    ],
    ["ARTICLE_AUTHORING_WRAPPER_SEAL_KEY", "AGENT_CONNECTION_WRAPPER_SEAL_KEY"],
  ])("refuses a key equal to Article's %s", (article, own) => {
    const env = environment();
    env[article] = env[own];
    expect(() => prepare(env)).toThrow(REFUSED);
  });

  it("refuses a cookie key equal to Article's, and Article's other keys beside ours", () => {
    const same = environment();
    same.ARTICLE_AUTHORING_COOKIE_KEY = same.AGENT_AUTHORIZATION_COOKIE_KEY;
    expect(() => prepare(same)).toThrow(REFUSED);

    // Article's cookie key being one of our other keys, in its own encoding.
    const crossed = environment();
    crossed.ARTICLE_AUTHORING_COOKIE_KEY = Buffer.from(
      crossed.AGENT_CONNECTION_WRAPPER_INDEX_KEY!,
      "base64",
    ).toString("base64url");
    expect(() => prepare(crossed)).toThrow(REFUSED);

    const clean = environment();
    clean.ARTICLE_AUTHORING_PROVIDER_INDEX_KEY = key32();
    clean.ARTICLE_AUTHORING_COOKIE_KEY = randomBytes(32).toString("base64url");
    expect(() => prepare(clean)).not.toThrow();
  });

  it("refuses Article's signing key, by content and not only by path", () => {
    const env = environment();
    env.ARTICLE_AUTHORIZATION_SIGNING_JWKS_FILE = keyFile();
    expect(env.ARTICLE_AUTHORIZATION_SIGNING_JWKS_FILE).not.toBe(
      env.AGENT_AUTHORIZATION_SIGNING_JWKS_FILE,
    );
    expect(() => prepare(env)).toThrow(REFUSED);

    const other = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    }).privateKey.export({ format: "jwk" });
    env.ARTICLE_AUTHORIZATION_SIGNING_JWKS_FILE = keyFile({
      keys: [{ ...other, kid: "article", use: "sig", alg: "RS256" }],
    });
    expect(() => prepare(env)).not.toThrow();
  });

  it("refuses symlinks, group-readable files, directories and oversized inputs", () => {
    const link = join(directory, `link-${++sequence}`);
    symlinkSync(keyFile(), link);
    const large = join(directory, `large-${++sequence}`);
    writeFileSync(large, " ".repeat(65_537), { mode: 0o600 });
    for (const file of [link, keyFile(undefined, 0o640), directory, large])
      expect(() =>
        prepare({
          ...environment(),
          AGENT_AUTHORIZATION_SIGNING_JWKS_FILE: file,
        }),
      ).toThrow(REFUSED);
  });

  it("refuses invalid, public, duplicate or mismatched signing material", () => {
    const publicOnly = { ...privateJwk };
    delete publicOnly.d;
    const other = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    }).privateKey.export({ format: "jwk" });
    for (const keys of [
      [],
      [publicOnly],
      [privateJwk, privateJwk],
      [{ ...privateJwk, alg: "none" }],
      [{ ...privateJwk, n: other.n }],
    ])
      expect(() =>
        prepare({
          ...environment(),
          AGENT_AUTHORIZATION_SIGNING_JWKS_FILE: keyFile({ keys }),
        }),
      ).toThrow(REFUSED);
  });

  it("keeps Development's signing file optional, and its cookie key required", () => {
    const development: NodeJS.ProcessEnv = {
      ...environment(),
      NODE_ENV: "development",
      AGENT_AUTHORIZATION_PROFILE: "operator",
      AGENT_AUTHORIZATION_ISSUER: "http://auth.localhost:44561",
      AGENT_AUTHORIZATION_RESOURCE: "http://app.localhost:44562/api/mcp",
      AGENT_AUTHORIZATION_CONSENT_URL: "http://app.localhost:44562",
      AGENT_AUTHORIZATION_ENVIRONMENT: "development",
    };
    delete development.AGENT_AUTHORIZATION_SIGNING_JWKS_FILE;
    expect(prepare(development).jwks).toBeUndefined();
    delete development.AGENT_AUTHORIZATION_COOKIE_KEY;
    expect(() => prepare(development)).toThrow(REFUSED);
  });
});

describe("Issuer database identity and verified TLS", () => {
  const postgres = (env: NodeJS.ProcessEnv) =>
    adminAuthorizationPostgresFrom(authorizationConfigFrom(env), env);

  it("uses the issuer's own credentials, with distinct roles on one database", () => {
    const parsed = postgres(environment());
    expect(parsed.ssl).toBe(false);
    expect(parsed.connectionString).toContain("admin_issuer");
  });

  it.each([
    ["consent", "AGENT_CONSENT_DATABASE_TARGET"],
    ["resource", "AGENT_RESOURCE_DATABASE_TARGET"],
    ["CMS", "CMS_DATABASE_TARGET"],
    ["public-read", "DATABASE_TARGET"],
  ])("refuses the %s role being the issuer's own", (_name, setting) => {
    const env = environment();
    env[setting] =
      "postgres://admin_issuer@127.0.0.1:5432/fixture?sslmode=disable";
    expect(() => postgres(env)).toThrow("ADMIN_DATABASE_ROLE_SEPARATION");
  });

  it("refuses two of the others sharing a role", () => {
    const env = environment();
    env.AGENT_CONSENT_DATABASE_TARGET = env.AGENT_RESOURCE_DATABASE_TARGET;
    expect(() => postgres(env)).toThrow("ADMIN_DATABASE_ROLE_SEPARATION");
  });

  it("refuses a role on another database", () => {
    const env = environment();
    env.AGENT_RESOURCE_DATABASE_TARGET =
      "postgres://admin_resource@127.0.0.1:5432/foreign?sslmode=disable";
    expect(() => postgres(env)).toThrow("ADMIN_DATABASE_ROLE_SEPARATION");
  });

  it.each([
    ["a missing target", undefined],
    [
      "a password in a role target",
      "postgres://admin_consent:synthetic-placeholder@127.0.0.1:5432/fixture?sslmode=disable",
    ],
    [
      "an unverified remote target",
      "postgres://admin_consent@db.example.invalid/fixture?sslmode=require",
    ],
    [
      "a url parameter override",
      "postgres://admin_consent@127.0.0.1/fixture?host=foreign",
    ],
  ])("refuses %s", (_name, value) => {
    const env = environment();
    if (value === undefined) delete env.AGENT_CONSENT_DATABASE_TARGET;
    else env.AGENT_CONSENT_DATABASE_TARGET = value;
    expect(() => postgres(env)).toThrow("ADMIN_DATABASE_ROLE_REFUSED");
  });

  it("requires verified remote TLS, and refuses an invalid CA before connecting", () => {
    const env = environment();
    env.AGENT_AUTHORIZATION_DATABASE_URL =
      "postgres://admin_issuer@db.example.invalid/fixture?sslmode=verify-full";
    for (const [setting, role] of [
      ["AGENT_CONSENT_DATABASE_TARGET", "admin_consent"],
      ["AGENT_RESOURCE_DATABASE_TARGET", "admin_resource"],
      ["DATABASE_TARGET", "catalog_read"],
      ["CMS_DATABASE_TARGET", "cms_runtime"],
    ] as const)
      env[setting] =
        `postgres://${role}@db.example.invalid/fixture?sslmode=verify-full`;
    const parsed = postgres(env);
    expect(parsed.ssl).toEqual({ rejectUnauthorized: true });
    expect(new URL(parsed.connectionString).search).toBe("");
    env.AGENT_AUTHORIZATION_DATABASE_SSL_CA_FILE = keyFile({
      deliberately: "not a certificate",
    });
    expect(() => postgres(env)).toThrow("ADMIN_DATABASE_TLS_REFUSED");
  });

  it("refuses a remote issuer url that is not verify-full", () => {
    const env = environment();
    env.AGENT_AUTHORIZATION_DATABASE_URL =
      "postgres://admin_issuer@db.example.invalid/fixture?sslmode=require";
    expect(() => postgres(env)).toThrow("ADMIN_DATABASE_ROLE_REFUSED");
  });
});

const listen = (server: http.Server | https.Server) =>
  new Promise<number>((done, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("TEST_ADDRESS"));
        return;
      }
      done(address.port);
    });
  });
const close = (server: http.Server | https.Server) =>
  new Promise<void>((done, reject) => {
    server.closeAllConnections();
    server.close((error) => (error ? reject(error) : done()));
  });
const request = (options: https.RequestOptions, tls = false, data?: string) =>
  new Promise<{
    status: number;
    headers: http.IncomingHttpHeaders;
    body: string;
  }>((done, reject) => {
    const outgoing = (tls ? https : http).request(options, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += String(chunk);
      });
      response.on("end", () =>
        done({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body,
        }),
      );
    });
    outgoing.on("error", reject);
    outgoing.end(data);
  });

describe("the listener, through the real proxy boundary", () => {
  const start = async () => {
    const env = environment();
    const reservation = http.createServer();
    const port = await listen(reservation);
    await close(reservation);
    env.AGENT_AUTHORIZATION_PORT = String(port);
    const pool = {
      query: vi.fn(async () => {
        throw new Error("UNEXPECTED_DATABASE_ACCESS");
      }),
    };
    const recordFailure = vi.fn();
    const issuer = await startAuthorizationServer({
      config: authorizationConfigFrom(env),
      environment: env,
      pool: pool as unknown as Pool,
      buildId: "synthetic",
      recordFailure,
    });
    return { env, port, pool, issuer, recordFailure };
  };

  const goodHeaders = {
    host: ISSUER_HOST,
    "x-forwarded-host": ISSUER_HOST,
    "x-forwarded-proto": "https",
  };

  it("refuses a request the proxy did not shape, before any cookie or row", async () => {
    const { port, pool, issuer } = await start();
    try {
      for (const headers of [
        { host: ISSUER_HOST },
        { ...goodHeaders, host: "wrong.example.invalid" },
        { ...goodHeaders, "x-forwarded-proto": "http" },
        { ...goodHeaders, "x-forwarded-host": "wrong.example.invalid" },
        { ...goodHeaders, "x-forwarded-proto": "https,http" },
        { ...goodHeaders, "x-forwarded-port": "8443" },
        { ...goodHeaders, forwarded: "proto=https" },
      ])
        for (const path of [
          "/healthz",
          "/agent-connections/consent/synthetic/resume",
          "/.well-known/oauth-authorization-server",
        ]) {
          const denied = await request({
            hostname: "127.0.0.1",
            port,
            path,
            headers,
          });
          expect(denied.status).toBe(400);
          expect(denied.headers["set-cookie"]).toBeUndefined();
        }
      expect(pool.query).not.toHaveBeenCalled();
    } finally {
      await issuer.close();
    }
  });

  it("answers health with no configuration and no caching", async () => {
    const { port, issuer } = await start();
    try {
      const health = await request({
        hostname: "127.0.0.1",
        port,
        path: "/healthz",
        headers: goodHeaders,
      });
      expect(health.status).toBe(200);
      expect(health.headers["cache-control"]).toBe("no-store");
      expect(JSON.parse(health.body)).toEqual({
        status: "ok",
        buildId: "synthetic",
      });
    } finally {
      await issuer.close();
    }
  });

  it("does not take a trusted peer from the caller", async () => {
    const { port, issuer } = await start();
    const seen: unknown[] = [];
    issuer.bundle.provider.on("interaction.started", (context) => {
      seen.push((context as { ip?: unknown }).ip);
    });
    try {
      const query = new URLSearchParams({
        client_id: HOSTED_CLIENT,
        redirect_uri: HOSTED_CALLBACK,
        response_type: "code",
        scope: "artvenn:admin",
        resource: RESOURCE,
        code_challenge: randomBytes(32).toString("base64url"),
        code_challenge_method: "S256",
      });
      const answer = await request({
        hostname: "127.0.0.1",
        port,
        path: `/auth?${query.toString()}`,
        headers: {
          ...goodHeaders,
          "x-admin-proxy-peer": "203.0.113.9",
          "x-forwarded-for": "203.0.113.9",
        },
      });
      expect(answer.status).toBe(303);
      expect(seen).toHaveLength(1);
      expect(seen[0]).not.toBe("203.0.113.9");
      expect(String(seen[0])).toMatch(/127\.0\.0\.1$/u);
      const internals = issuer.bundle.provider;
      expect(internals.proxy).toBe(true);
      expect(internals.proxyIpHeader).toBe("X-Admin-Proxy-Peer");
      expect(internals.maxIpsCount).toBe(1);
    } finally {
      await issuer.close();
    }
  });

  it("answers a malformed request line with a refusal, not a crash", async () => {
    const { port, issuer } = await start();
    try {
      for (const path of ["//", "//evil.invalid/auth"]) {
        const denied = await request({
          hostname: "127.0.0.1",
          port,
          path,
          headers: goodHeaders,
        });
        expect(denied.status).toBe(400);
      }
    } finally {
      await issuer.close();
    }
  });

  it("serves discovery, keys, secure cookies, strict targets and rotation over real HTTPS", async () => {
    const { env, port, pool, issuer } = await start();
    let proxy: https.Server | undefined;
    stores.opened.length = 0;
    stores.minted.length = 0;
    try {
      const certificate = join(directory, "proxy-cert.pem");
      const privateKey = join(directory, "proxy-key.pem");
      execFileSync(
        "openssl",
        [
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-keyout",
          privateKey,
          "-out",
          certificate,
          "-days",
          "1",
          "-subj",
          `/CN=${ISSUER_HOST}`,
          "-addext",
          `subjectAltName=DNS:${ISSUER_HOST}`,
        ],
        { stdio: "pipe" },
      );
      proxy = https.createServer(
        { key: readFileSync(privateKey), cert: readFileSync(certificate) },
        (incoming, response) => {
          const outgoing = http.request(
            {
              hostname: "127.0.0.1",
              port,
              path: incoming.url,
              method: incoming.method,
              headers: {
                ...goodHeaders,
                ...(incoming.headers["content-type"]
                  ? { "content-type": incoming.headers["content-type"] }
                  : {}),
              },
            },
            (upstream) => {
              response.writeHead(upstream.statusCode ?? 502, upstream.headers);
              upstream.pipe(response);
            },
          );
          outgoing.on("error", () => {
            response.writeHead(502);
            response.end();
          });
          incoming.pipe(outgoing);
        },
      );
      const proxyPort = await listen(proxy);
      const base = {
        hostname: "127.0.0.1",
        port: proxyPort,
        servername: ISSUER_HOST,
        ca: readFileSync(certificate),
        headers: { host: ISSUER_HOST },
      };

      const discovery = await request(
        { ...base, path: "/.well-known/oauth-authorization-server" },
        true,
      );
      expect(discovery.status).toBe(200);
      const metadata = JSON.parse(discovery.body) as Record<string, unknown>;
      expect(metadata.issuer).toBe(env.AGENT_AUTHORIZATION_ISSUER);
      expect(metadata.token_endpoint).toBe(`https://${ISSUER_HOST}/token`);
      expect(metadata.scopes_supported).toEqual([
        "artvenn:admin",
        "offline_access",
      ]);
      expect(metadata.client_id_metadata_document_supported).toBe(true);
      expect(metadata.token_endpoint_auth_methods_supported).toEqual(["none"]);
      expect(metadata.response_types_supported).toEqual(["code"]);
      expect(metadata.registration_endpoint).toBeUndefined();
      expect(metadata.userinfo_endpoint).toBeUndefined();
      expect(metadata.pushed_authorization_request_endpoint).toBeUndefined();
      expect(metadata.dpop_signing_alg_values_supported).toBeUndefined();

      const jwks = await request({ ...base, path: "/jwks" }, true);
      const published = JSON.parse(jwks.body) as { keys: JsonWebKey[] };
      expect(published.keys.map((key) => key.kid)).toEqual([
        "synthetic-current",
      ]);
      expect(published.keys.every((key) => key.d === undefined)).toBe(true);

      const query = new URLSearchParams({
        client_id: HOSTED_CLIENT,
        redirect_uri: HOSTED_CALLBACK,
        response_type: "code",
        scope: "artvenn:admin",
        resource: RESOURCE,
        code_challenge: randomBytes(32).toString("base64url"),
        code_challenge_method: "S256",
        state: "synthetic-state",
      });
      query.append("resource", RESOURCE);
      const authorization = await request(
        { ...base, path: `/auth?${query.toString()}` },
        true,
      );
      expect(authorization.status).toBe(303);
      expect(
        authorization.headers.location?.startsWith(
          "https://app.example.invalid/agent-connections/consent/",
        ),
      ).toBe(true);
      const cookies = authorization.headers["set-cookie"] ?? [];
      expect(cookies.length).toBeGreaterThan(0);
      for (const cookie of cookies) {
        expect(cookie).toMatch(/; secure/iu);
        expect(cookie).toMatch(/; httponly/iu);
      }
      // Signed with our key, so a cookie cannot be written from outside.
      expect(
        cookies.some((cookie) => cookie.startsWith("_interaction.sig=")),
      ).toBe(true);
      expect(stores.opened).toHaveLength(1);
      expect(stores.opened[0]).toMatchObject({
        oauthClientId: HOSTED_CLIENT,
        resource: RESOURCE,
        capabilityScopes: ["artvenn:admin"],
        protocolScopes: ["offline_access"],
        preset: "operator",
      });

      // A target that is anything but exactly ours, in each form it can take.
      for (const resources of [
        [RESOURCE, "https://foreign.example.invalid/mcp"],
        ["https://foreign.example.invalid/mcp"],
        [""],
      ]) {
        const rejected = new URLSearchParams(query);
        rejected.delete("resource");
        for (const resource of resources) rejected.append("resource", resource);
        const result = await request(
          { ...base, path: `/auth?${rejected.toString()}` },
          true,
        );
        expect(
          result.headers.location?.startsWith(
            "https://app.example.invalid/agent-connections/consent/",
          ),
        ).not.toBe(true);
      }
      expect(stores.opened).toHaveLength(1);
      expect(pool.query).not.toHaveBeenCalled();

      // A real provider seeing an unlisted URL, and no database row for it.
      const unlisted = new URLSearchParams(query);
      unlisted.set("client_id", "https://other.example.invalid/client.json");
      const unknown = await request(
        { ...base, path: `/auth?${unlisted.toString()}` },
        true,
      );
      expect(unknown.status).toBe(400);
      expect(unknown.body).toContain("invalid_client");
      expect(stores.opened).toHaveLength(1);

      // The token endpoint on seeded grants: PKCE, target choice, rotation.
      pool.query.mockResolvedValue({
        rows: [{ id: "synthetic" }],
        rowCount: 1,
      } as never);
      const native = issuer.bundle.provider as unknown as {
        Client: { find(id: string): Promise<unknown> };
        Grant: new (input: Record<string, unknown>) => {
          addResourceScope(resource: string, scope: string): void;
          save(): Promise<string>;
        };
        AuthorizationCode: new (input: Record<string, unknown>) => {
          save(): Promise<string>;
        };
        RefreshToken: new (input: Record<string, unknown>) => {
          save(): Promise<string>;
        };
      };
      const client = await native.Client.find(HOSTED_CLIENT);
      const verifier = randomBytes(32).toString("base64url");
      const tokenRequest = (params: URLSearchParams) =>
        request(
          {
            ...base,
            path: "/token",
            method: "POST",
            headers: {
              host: ISSUER_HOST,
              "content-type": "application/x-www-form-urlencoded",
            },
          },
          true,
          params.toString(),
        );
      const seeded = async (grantType: string) => {
        const grant = new native.Grant({
          accountId: "synthetic-owner",
          clientId: HOSTED_CLIENT,
        });
        grant.addResourceScope(RESOURCE, "artvenn:admin");
        const grantId = await grant.save();
        const values = {
          accountId: "synthetic-owner",
          client,
          grantId,
          resource: [RESOURCE],
          scope: "artvenn:admin",
          expiresWithSession: false,
        };
        const source =
          grantType === "authorization_code"
            ? new native.AuthorizationCode({
                ...values,
                redirectUri: HOSTED_CALLBACK,
                codeChallenge: createHash("sha256")
                  .update(verifier)
                  .digest("base64url"),
                codeChallengeMethod: "S256",
              })
            : new native.RefreshToken(values);
        const token = await source.save();
        const params = new URLSearchParams({
          grant_type: grantType,
          client_id: HOSTED_CLIENT,
        });
        if (grantType === "authorization_code") {
          params.set("code", token);
          params.set("redirect_uri", HOSTED_CALLBACK);
          params.set("code_verifier", verifier);
        } else params.set("refresh_token", token);
        return params;
      };
      for (const grantType of ["authorization_code", "refresh_token"]) {
        for (const resources of [[], [RESOURCE], [RESOURCE, RESOURCE]]) {
          const params = await seeded(grantType);
          for (const target of resources) params.append("resource", target);
          const result = await tokenRequest(params);
          expect(result.status, `${grantType}: ${result.body}`).toBe(200);
          const answer = JSON.parse(result.body) as Record<string, unknown>;
          expect(answer.access_token).toBe("synthetic-wrapped-access");
          expect(answer.expires_in).toBe(3600);
          expect(answer.refresh_token).toBeTruthy();
          if (grantType === "refresh_token")
            expect(answer.refresh_token).not.toBe(params.get("refresh_token"));
        }
        for (const resources of [
          [RESOURCE, "https://foreign.example.invalid/mcp"],
          [""],
        ]) {
          const params = await seeded(grantType);
          for (const target of resources) params.append("resource", target);
          const result = await tokenRequest(params);
          expect(result.status).toBe(400);
          expect(JSON.parse(result.body).error).toBe("invalid_target");
        }
      }
      // A grant no longer current answers `invalid_grant`, and mints nothing.
      const minted = stores.minted.length;
      pool.query.mockResolvedValue({ rows: [], rowCount: 0 } as never);
      const stale = await tokenRequest(await seeded("refresh_token"));
      expect(stale.status).toBe(400);
      expect(JSON.parse(stale.body)).toEqual({ error: "invalid_grant" });
      expect(stores.minted).toHaveLength(minted);
    } finally {
      if (proxy) await close(proxy);
      await issuer.close();
    }
  }, 30_000);
});

describe("the reaper", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const HOUR = 60 * 60 * 1000;

  it("runs hourly, never twice at once, and a failure neither stops it nor escapes", async () => {
    vi.useFakeTimers();
    const runs: (() => void)[] = [];
    const reap = vi.fn(
      () =>
        new Promise<void>((done, reject) => {
          runs.push(() => (runs.length === 2 ? reject(new Error()) : done()));
        }),
    );
    const failures: string[] = [];
    const stop = startArtifactReaper(reap, (code) => failures.push(code));
    expect(reap).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(HOUR - 1);
    expect(reap).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(reap).toHaveBeenCalledTimes(1);

    // Still running when the next hour comes round.
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(reap).toHaveBeenCalledTimes(1);
    runs[0]!();
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(reap).toHaveBeenCalledTimes(2);

    runs[1]!();
    await vi.advanceTimersByTimeAsync(0);
    expect(failures).toEqual(["ARTIFACT_REAP_FAILED"]);
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(reap).toHaveBeenCalledTimes(3);

    // Stopping waits for the run in flight, and no run starts afterwards.
    let stopped = false;
    const stopping = stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(stopped).toBe(false);
    expect(reap).toHaveBeenCalledTimes(3);
    runs[2]!();
    await stopping;
    expect(stopped).toBe(true);
  });

  it("drains each store in bounded batches, and gives up rather than spin", async () => {
    const models: string[] = [];
    let wrapperCalls = 0;
    let consentCalls = 0;
    const bundle = {
      Adapter: class {
        constructor(readonly model: string) {
          models.push(model);
        }
        async deleteExpired(limit: number) {
          expect(limit).toBe(1000);
          return this.model === "Session" ? 1000 : 0;
        }
      },
      wrappers: {
        deleteExpired: async (before: Date, limit: number) => {
          expect(before).toBeInstanceOf(Date);
          expect(limit).toBe(1000);
          wrapperCalls += 1;
          return wrapperCalls === 1 ? 1000 : 3;
        },
      },
      consents: {
        reapExpired: async (limit: number) => {
          expect(limit).toBe(1000);
          consentCalls += 1;
          return 0;
        },
      },
    } as unknown as Parameters<typeof reapExpiredArtifacts>[0];
    await reapExpiredArtifacts(bundle);
    expect(models).toEqual([
      "Session",
      "Interaction",
      "AuthorizationCode",
      "AccessToken",
      "RefreshToken",
      "Grant",
    ]);
    expect(wrapperCalls).toBe(2);
    expect(consentCalls).toBe(1);
  });

  it("stops at its bound on a store that never empties", async () => {
    let calls = 0;
    const bundle = {
      Adapter: class {
        async deleteExpired() {
          return 0;
        }
      },
      wrappers: {
        deleteExpired: async () => {
          calls += 1;
          return 1000;
        },
      },
      consents: { reapExpired: async () => 0 },
    } as unknown as Parameters<typeof reapExpiredArtifacts>[0];
    await reapExpiredArtifacts(bundle);
    expect(calls).toBe(100);
  });
});

describe("the process itself", () => {
  const main = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../services/agent-authorization/dist/main.js",
  );

  /**
   * The entry point reads the migration ledger before it listens, and nothing
   * here has a database. This answers that one read, and only it: the ledger
   * check takes a client from the pool, and every other statement here goes
   * through `pool.query`, which still reaches the real port.
   */
  const ledgerAnswers = (
    applied: readonly (typeof requiredCommunityMigrations)[number][],
  ) => {
    const rows = applied.map(({ migrationId, filename, checksum }) => ({
      migration_id: migrationId,
      filename,
      checksum,
    }));
    const preload = `
      import { createRequire } from "node:module";
      const pg = createRequire(${JSON.stringify(main)})("pg");
      const { connect } = pg.Pool.prototype;
      pg.Pool.prototype.connect = function (callback) {
        if (callback !== undefined) return connect.call(this, callback);
        return Promise.resolve({
          query: async () => ({ rows: ${JSON.stringify(rows)} }),
          release: () => undefined,
        });
      };
    `;
    return [
      "--import",
      `data:text/javascript,${encodeURIComponent(preload)}`,
    ] as const;
  };

  /** The real entry point with a hard deadline. It opens no database connection. */
  const run = (
    env: NodeJS.ProcessEnv,
    onReady?: () => Promise<void>,
    nodeArguments: readonly string[] = [],
  ): Promise<{ code: number | null; stdout: string; stderr: string }> =>
    new Promise((done, reject) => {
      const child = spawn(process.execPath, [...nodeArguments, main], {
        env,
        stdio: "pipe",
      });
      let stdout = "";
      let stderr = "";
      const deadline = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`TEST_DEADLINE: ${stderr}`));
      }, 20_000);
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      let started = false;
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
        if (started || !stdout.includes("listeners ready")) return;
        started = true;
        void (onReady?.() ?? Promise.resolve())
          .catch(reject)
          .finally(() => child.kill("SIGTERM"));
      });
      child.on("close", (code) => {
        clearTimeout(deadline);
        done({ code, stdout, stderr });
      });
    });

  const freePort = async () => {
    const reservation = http.createServer();
    const port = await listen(reservation);
    await close(reservation);
    return port;
  };

  /** Every role on one database, on a port nothing listens on. */
  const unreachableDatabase = async () => {
    const closed = await freePort();
    const target = (role: string) =>
      `postgres://${role}@127.0.0.1:${closed}/fixture?sslmode=disable`;
    return {
      AGENT_AUTHORIZATION_DATABASE_URL: target("admin_issuer"),
      AGENT_CONSENT_DATABASE_TARGET: target("admin_consent"),
      AGENT_RESOURCE_DATABASE_TARGET: target("admin_resource"),
      DATABASE_TARGET: target("catalog_read"),
      CMS_DATABASE_TARGET: target("cms_runtime"),
    };
  };

  it("starts in Production behind its gate, answers through the proxy check, and stops on a signal", async () => {
    const port = await freePort();
    const result = await run(
      { ...environment(), AGENT_AUTHORIZATION_PORT: String(port) },
      async () => {
        const denied = await request({
          hostname: "127.0.0.1",
          port,
          path: "/healthz",
        });
        expect(denied.status).toBe(400);
        const health = await request({
          hostname: "127.0.0.1",
          port,
          path: "/healthz",
          headers: {
            host: ISSUER_HOST,
            "x-forwarded-host": ISSUER_HOST,
            "x-forwarded-proto": "https",
          },
        });
        expect(health.status).toBe(200);
      },
      ledgerAnswers(requiredCommunityMigrations),
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("listeners ready");
  }, 30_000);

  it.each([
    ["a migration missing", requiredCommunityMigrations.slice(0, -1)],
    ["no migration at all", []],
    [
      "a migration changed since it ran",
      requiredCommunityMigrations.map((entry, index) =>
        index === 0 ? { ...entry, checksum: "0".repeat(64) } : entry,
      ),
    ],
  ])(
    "refuses to start with %s, by name",
    async (_name, applied) => {
      const result = await run(
        {
          ...environment(),
          AGENT_AUTHORIZATION_PORT: String(await freePort()),
        },
        undefined,
        ledgerAnswers(applied),
      );
      expect(result.code).toBe(78);
      expect(result.stdout).not.toContain("listeners ready");
      expect(result.stderr).toContain("startup refused ADMIN_SCHEMA_NOT_READY");
    },
    30_000,
  );

  it("refuses to start on a database it cannot reach, and does not call that a schema fault", async () => {
    const result = await run({
      ...environment(),
      ...(await unreachableDatabase()),
      AGENT_AUTHORIZATION_PORT: String(await freePort()),
    });
    expect(result.code).toBe(78);
    expect(result.stdout).not.toContain("listeners ready");
    expect(result.stderr).toContain(
      "startup refused AUTHORIZATION_STARTUP_REFUSED",
    );
  }, 30_000);

  it("runs the reaper from the process, and a database it cannot reach costs only a code", async () => {
    // An hour is too long to wait, so this runs the hourly timer every 50 ms and
    // leaves every other timer alone. Nothing listens on the database port.
    const preload = `
      const { setInterval: real } = globalThis;
      globalThis.setInterval = (run, ms, ...rest) =>
        real(run, ms === 3600000 ? 50 : ms, ...rest);
    `;
    const port = await freePort();
    const result = await run(
      {
        ...environment(),
        ...(await unreachableDatabase()),
        AGENT_AUTHORIZATION_PORT: String(port),
      },
      async () => {
        await new Promise((tick) => setTimeout(tick, 1_000));
      },
      [
        ...ledgerAnswers(requiredCommunityMigrations),
        "--import",
        `data:text/javascript,${encodeURIComponent(preload)}`,
      ],
    );
    expect(result.code).toBe(0);
    expect(result.stderr).toContain(
      "authorization-failure ARTIFACT_REAP_FAILED",
    );
  }, 30_000);

  it.each([
    [
      "with its gate off",
      { ADMIN_MCP_OAUTH_ENABLED: "false" },
      "authorization requires",
    ],
    [
      "with Development's setting in Production",
      { ADMIN_MCP_OAUTH_ENABLED: "", AGENT_AUTHORIZATION_ENABLED: "true" },
      "authorization requires",
    ],
    [
      "with a key missing",
      { AGENT_AUTHORIZATION_COOKIE_KEY: "" },
      "startup refused ADMIN_AUTHORIZATION_KEYS_REFUSED",
    ],
    [
      "with roles not separated",
      { AGENT_CONSENT_DATABASE_TARGET: "" },
      "startup refused ADMIN_DATABASE_ROLE_REFUSED",
    ],
    [
      "with an http issuer",
      { AGENT_AUTHORIZATION_ISSUER: `http://${ISSUER_HOST}` },
      "startup refused PRODUCTION_HTTPS_REQUIRED",
    ],
  ])(
    "refuses to start %s, by a code and nothing else",
    async (_name, override, said) => {
      const secret = randomBytes(32).toString("base64");
      const result = await run({
        ...environment(),
        AGENT_CONNECTION_PROVIDER_SEAL_KEY: secret,
        ...override,
      });
      expect(result.code).toBe(78);
      expect(result.stdout).not.toContain("listeners ready");
      expect(result.stderr).toContain(said);
      expect(result.stderr).not.toContain(secret);
      expect(result.stderr).not.toContain(ISSUER_HOST);
    },
    30_000,
  );
});
