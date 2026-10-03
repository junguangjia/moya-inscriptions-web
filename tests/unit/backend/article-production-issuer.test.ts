import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import http from "node:http";
import https from "node:https";
import type { createPostgresPool } from "@moya/catalog-postgres";
type Pool = ReturnType<typeof createPostgresPool>;
import type { JsonWebKey } from "node:crypto";
import {
  articleAuthorizationConfigFrom,
  articleAuthorizationPostgresFrom,
  articleAuthorizationRequestAllowed,
  articleDatabaseRoleTarget,
  authorizationEnabled,
  installAccessTokenWrapper,
  prepareArticleAuthorizationKeys,
  readArticleSigningJwks,
  startArticleAuthorizationServer,
} from "@moya/agent-authorization";

import type {
  OidcProvider,
  ProviderBundle,
  ProviderContext,
} from "@moya/agent-authorization";

// Only persistence is replaced in this focused protocol-boundary test. The
// actual oidc-provider, HTTP listener, HTTPS proxy, key parsing and cookies run.
vi.mock("@moya/community-postgres", async (original) => {
  const actual = await original<typeof import("@moya/community-postgres")>();
  return {
    ...actual,
    createProviderAdapter: () => {
      const stores = new Map<string, Map<string, Record<string, unknown>>>();
      return class {
        readonly entries: Map<string, Record<string, unknown>>;
        constructor(name: string) {
          let entries = stores.get(name);
          if (!entries) {
            entries = new Map();
            stores.set(name, entries);
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
        async findByUserCode(code: string) {
          return [...this.entries.values()].find(
            (value) => value.userCode === code,
          );
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
      mint: async () => ({ presented: "synthetic-wrapped-access" }),
    }),
    createArticleConsentStore: () => ({
      open: async () => undefined,
      read: async () => null,
    }),
  };
});

let directory: string;
let privateJwk: JsonWebKey;
let sequence = 0;
const keyFile = (value: unknown = { keys: [privateJwk] }, mode = 0o600) => {
  const file = join(directory, `signing-${++sequence}.json`);
  writeFileSync(file, JSON.stringify(value), { mode });
  return file;
};
const environment = (): NodeJS.ProcessEnv => ({
  NODE_ENV: "production",
  ARTICLE_AUTHORING_ENABLED: "true",
  ARTICLE_AUTHORING_ISSUER: "https://article-issuer.example.invalid",
  ARTICLE_AUTHORING_RESOURCE:
    "https://app.example.invalid/mcp/article-authoring",
  ARTICLE_AUTHORING_CONSENT_ORIGIN: "https://app.example.invalid",
  ARTICLE_AUTHORIZATION_PORT: "44551",
  ARTICLE_AUTHORIZATION_DATABASE_URL:
    "postgres://article_issuer@127.0.0.1:5432/fixture?sslmode=disable",
  ARTICLE_AUTHORING_CONTROL_DATABASE_TARGET:
    "postgres://article_control@127.0.0.1:5432/fixture?sslmode=disable",
  ARTICLE_AUTHORING_RESOURCE_DATABASE_TARGET:
    "postgres://article_resource@127.0.0.1:5432/fixture?sslmode=disable",
  DATABASE_TARGET:
    "postgres://catalog_read@127.0.0.1:5432/fixture?sslmode=disable",
  CMS_DATABASE_TARGET:
    "postgres://cms_runtime@127.0.0.1:5432/fixture?sslmode=disable",
  ARTICLE_AUTHORING_CLIENTS: JSON.stringify([
    {
      clientId: "synthetic-article-client",
      family: "claude",
      label: "Synthetic test client",
      redirectUris: ["http://127.0.0.1:44553/callback"],
    },
  ]),
  ARTICLE_AUTHORING_PROVIDER_INDEX_KEY: randomBytes(32).toString("base64"),
  ARTICLE_AUTHORING_PROVIDER_SEAL_KEY: randomBytes(32).toString("base64"),
  ARTICLE_AUTHORING_WRAPPER_INDEX_KEY: randomBytes(32).toString("base64"),
  ARTICLE_AUTHORING_WRAPPER_SEAL_KEY: randomBytes(32).toString("base64"),
  ARTICLE_AUTHORING_COOKIE_KEY: randomBytes(32).toString("base64url"),
  ARTICLE_AUTHORIZATION_SIGNING_JWKS_FILE: keyFile(),
});
const configFrom = (env: NodeJS.ProcessEnv) => {
  const config = articleAuthorizationConfigFrom(env);
  if (!config) throw new Error("TEST_CONFIG_DISABLED");
  return config;
};
beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "article-issuer-config-"));
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

describe("Production Article issuer configuration", () => {
  it("requires opt-in and preserves the independent Admin Development gate", () => {
    expect(
      articleAuthorizationConfigFrom({ NODE_ENV: "production" }),
    ).toBeNull();
    expect(
      authorizationEnabled({
        NODE_ENV: "production",
        AGENT_AUTHORIZATION_ENABLED: "true",
      }),
    ).toBe(false);
    expect(configFrom(environment()).environment).toBe("production");
  });
  it.each([
    { ARTICLE_AUTHORING_ISSUER: "http://article-issuer.example.invalid" },
    { ARTICLE_AUTHORING_ISSUER: "https://article-issuer.example.invalid/path" },
    {
      ARTICLE_AUTHORING_CONSENT_ORIGIN:
        "https://article-issuer.example.invalid",
    },
    { ARTICLE_AUTHORING_CONSENT_ORIGIN: "http://app.example.invalid" },
    { ARTICLE_AUTHORING_RESOURCE: "https://app.example.invalid/other" },
    {
      ARTICLE_AUTHORING_RESOURCE:
        "https://app.example.invalid/mcp/article-authoring?other=1",
    },
    { ARTICLE_AUTHORIZATION_PORT: "443" },
    { ARTICLE_AUTHORIZATION_PORT: "" },
    {
      ARTICLE_AUTHORING_CLIENTS: JSON.stringify([
        {
          clientId: "hosted",
          family: "claude",
          label: "Hosted",
          redirectUris: ["https://callback.example.invalid/cb"],
        },
      ]),
    },
  ])("refuses an invalid public boundary", (override) => {
    expect(() => configFrom({ ...environment(), ...override })).toThrow();
  });
  it("accepts explicit HTTPS public ports while requiring a distinct loopback listener", () => {
    const env = {
      ...environment(),
      ARTICLE_AUTHORING_ISSUER: "https://article-issuer.example.invalid:44551",
      ARTICLE_AUTHORIZATION_PORT: "44554",
      ARTICLE_AUTHORING_CONSENT_ORIGIN: "https://app.example.invalid:44552",
      ARTICLE_AUTHORING_RESOURCE:
        "https://app.example.invalid:44552/mcp/article-authoring",
    };
    const config = configFrom(env);
    expect(config.issuer).toBe(env.ARTICLE_AUTHORING_ISSUER);
    expect(() =>
      configFrom({ ...env, ARTICLE_AUTHORIZATION_PORT: "44551" }),
    ).toThrow("ARTICLE_AUTHORIZATION_PORT");
  });
  it("resource config consumes role-only metadata without issuer password or signing-file reads", () => {
    const env = environment();
    delete env.ARTICLE_AUTHORIZATION_DATABASE_URL;
    delete env.ARTICLE_AUTHORIZATION_SIGNING_JWKS_FILE;
    env.ARTICLE_AUTHORIZATION_DATABASE_TARGET =
      "postgres://article_issuer@127.0.0.1:5432/fixture?sslmode=disable";
    expect(
      articleAuthorizationConfigFrom(env, { databaseRole: "resource" })
        ?.environment,
    ).toBe("production");
    env.ARTICLE_AUTHORIZATION_DATABASE_TARGET =
      "postgres://article_issuer:synthetic-placeholder@127.0.0.1:5432/fixture";
    expect(() =>
      articleAuthorizationConfigFrom(env, { databaseRole: "resource" }),
    ).toThrow("ARTICLE_DATABASE_ROLE_REFUSED");
  });
  it("retains Development loopback and direct issuer-port rules", () => {
    const env: NodeJS.ProcessEnv = {
      ...environment(),
      NODE_ENV: "development",
      ARTICLE_AUTHORING_ISSUER: "http://article-issuer.localhost:44551",
      ARTICLE_AUTHORING_RESOURCE:
        "http://localhost:44552/mcp/article-authoring",
      ARTICLE_AUTHORING_CONSENT_ORIGIN: "http://localhost:44550",
    };
    expect(configFrom(env).environment).toBe("development");
    expect(() =>
      configFrom({ ...env, ARTICLE_AUTHORIZATION_PORT: "44555" }),
    ).toThrow();
    expect(() =>
      configFrom({
        ...env,
        ARTICLE_AUTHORING_CONSENT_ORIGIN: "http://foreign.example.invalid",
      }),
    ).toThrow();
  });
});

describe("Protected dedicated signing keys", () => {
  it("validates a private RSA signing file and never supplies a missing Production fallback", () => {
    expect(readArticleSigningJwks(keyFile()).keys).toHaveLength(1);
    const env = environment();
    delete env.ARTICLE_AUTHORIZATION_SIGNING_JWKS_FILE;
    expect(() => prepareArticleAuthorizationKeys(configFrom(env), env)).toThrow(
      "ARTICLE_AUTHORIZATION_KEYS_REFUSED",
    );
  });
  it("refuses symlinks, group-readable files, directories and oversized inputs", () => {
    const link = join(directory, `link-${++sequence}`);
    symlinkSync(keyFile(), link);
    const large = join(directory, `large-${++sequence}`);
    writeFileSync(large, " ".repeat(65_537), { mode: 0o600 });
    for (const file of [link, keyFile(undefined, 0o640), directory, large])
      expect(() => readArticleSigningJwks(file)).toThrow(
        "ARTICLE_SIGNING_JWKS_REFUSED",
      );
  });
  it("refuses invalid/public/duplicate or mismatched signing material", () => {
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
      expect(() => readArticleSigningJwks(keyFile({ keys }))).toThrow(
        "ARTICLE_SIGNING_JWKS_REFUSED",
      );
  });
  it("refuses reuse across the dedicated Article and configured Admin keys", () => {
    const env = environment();
    env.ARTICLE_AUTHORING_WRAPPER_INDEX_KEY =
      env.ARTICLE_AUTHORING_PROVIDER_INDEX_KEY;
    expect(() => prepareArticleAuthorizationKeys(configFrom(env), env)).toThrow(
      "ARTICLE_AUTHORIZATION_KEYS_REFUSED",
    );
    const adminReuse = environment();
    adminReuse.AGENT_CONNECTION_WRAPPER_SEAL_KEY =
      adminReuse.ARTICLE_AUTHORING_PROVIDER_SEAL_KEY;
    expect(() =>
      prepareArticleAuthorizationKeys(configFrom(adminReuse), adminReuse),
    ).toThrow("ARTICLE_AUTHORIZATION_KEYS_REFUSED");
  });
});

describe("Issuer database identity and verified TLS", () => {
  it("uses only issuer credentials and distinct same-target role-only metadata", () => {
    const env = environment();
    expect(articleAuthorizationPostgresFrom(configFrom(env), env).ssl).toBe(
      false,
    );
    env.ARTICLE_AUTHORING_CONTROL_DATABASE_TARGET =
      env.ARTICLE_AUTHORIZATION_DATABASE_URL;
    expect(() =>
      articleAuthorizationPostgresFrom(configFrom(env), env),
    ).toThrow("ARTICLE_DATABASE_ROLE_SEPARATION");
  });
  it("refuses credential-bearing metadata, a foreign target and CMS/public role substitution", () => {
    for (const override of [
      {
        ARTICLE_AUTHORING_CONTROL_DATABASE_TARGET:
          "postgres://control:synthetic-placeholder@127.0.0.1:5432/fixture?sslmode=disable",
      },
      {
        ARTICLE_AUTHORING_CONTROL_DATABASE_TARGET:
          "postgres://control@127.0.0.1:5432/foreign?sslmode=disable",
      },
      {
        CMS_DATABASE_TARGET:
          "postgres://article_issuer@127.0.0.1:5432/fixture?sslmode=disable",
      },
      {
        DATABASE_TARGET:
          "postgres://article_control@127.0.0.1:5432/fixture?sslmode=disable",
      },
    ]) {
      const env = { ...environment(), ...override };
      expect(() =>
        articleAuthorizationPostgresFrom(configFrom(env), env),
      ).toThrow();
    }
  });
  it.each([
    "postgres://issuer@db.example.invalid/fixture",
    "postgres://issuer@db.example.invalid/fixture?sslmode=require",
    "postgres://issuer@127.0.0.1/fixture?user=foreign",
    "postgres://issuer@127.0.0.1/fixture?sslmode=disable&sslmode=disable",
    "postgres://issuer@127.0.0.1/fixture?sslrootcert=other",
    "postgres://issuer@127.0.0.1/fixture?host=foreign",
  ])("refuses unsafe database configuration", (raw) => {
    expect(() => articleDatabaseRoleTarget(raw, { production: true })).toThrow(
      "ARTICLE_DATABASE_ROLE_REFUSED",
    );
  });
  it("requires verified remote TLS and refuses invalid role-specific CA before connecting", () => {
    const env = environment();
    env.ARTICLE_AUTHORIZATION_DATABASE_URL =
      "postgres://issuer@db.example.invalid/fixture?sslmode=verify-full";
    env.ARTICLE_AUTHORING_CONTROL_DATABASE_TARGET =
      "postgres://control@db.example.invalid/fixture?sslmode=verify-full";
    env.ARTICLE_AUTHORING_RESOURCE_DATABASE_TARGET =
      "postgres://resource@db.example.invalid/fixture?sslmode=verify-full";
    env.DATABASE_TARGET =
      "postgres://catalog@db.example.invalid/fixture?sslmode=verify-full";
    env.CMS_DATABASE_TARGET =
      "postgres://cms@db.example.invalid/fixture?sslmode=verify-full";
    const parsed = articleAuthorizationPostgresFrom(configFrom(env), env);
    expect(parsed.ssl).toEqual({ rejectUnauthorized: true });
    expect(new URL(parsed.connectionString).search).toBe("");
    env.ARTICLE_AUTHORIZATION_DATABASE_SSL_CA_FILE = keyFile({
      deliberately: "not a certificate",
    });
    expect(() =>
      articleAuthorizationPostgresFrom(configFrom(env), env),
    ).toThrow("ARTICLE_DATABASE_TLS_REFUSED");
  });
});

const listen = (server: http.Server | https.Server) =>
  new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("TEST_ADDRESS"));
        return;
      }
      resolve(address.port);
    });
  });
const close = (server: http.Server | https.Server) =>
  new Promise<void>((resolve, reject) => {
    server.closeAllConnections();
    server.close((error) => (error ? reject(error) : resolve()));
  });
const request = (options: https.RequestOptions, tls = false, data?: string) =>
  new Promise<{
    status: number;
    headers: http.IncomingHttpHeaders;
    body: string;
  }>((resolve, reject) => {
    const outgoing = (tls ? https : http).request(options, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += String(chunk);
      });
      response.on("end", () =>
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body,
        }),
      );
    });
    outgoing.on("error", reject);
    outgoing.end(data);
  });

describe("Actual Production issuer HTTPS proxy boundary", () => {
  it("checks the configured HTTPS public port in trusted forwarding headers", () => {
    const config = configFrom({
      ...environment(),
      ARTICLE_AUTHORING_ISSUER: "https://article-issuer.example.invalid:44551",
      ARTICLE_AUTHORIZATION_PORT: "44554",
    });
    const incoming = {
      headers: {
        host: "article-issuer.example.invalid:44551",
        "x-forwarded-proto": "https",
        "x-forwarded-host": "article-issuer.example.invalid:44551",
        "x-forwarded-port": "44551",
      },
      rawHeaders: [
        "Host",
        "article-issuer.example.invalid:44551",
        "X-Forwarded-Proto",
        "https",
        "X-Forwarded-Host",
        "article-issuer.example.invalid:44551",
        "X-Forwarded-Port",
        "44551",
      ],
      socket: { remoteAddress: "127.0.0.1" },
      url: "/healthz",
    } as unknown as http.IncomingMessage;
    expect(articleAuthorizationRequestAllowed(incoming, config)).toBe(true);
    incoming.headers["x-forwarded-port"] = "443";
    expect(articleAuthorizationRequestAllowed(incoming, config)).toBe(false);
  });
  it("rejects a remote proxy even when headers claim the canonical issuer", () => {
    const config = configFrom(environment());
    const incoming = {
      headers: {
        host: "article-issuer.example.invalid",
        "x-forwarded-proto": "https",
        "x-forwarded-host": "article-issuer.example.invalid",
      },
      rawHeaders: [
        "Host",
        "article-issuer.example.invalid",
        "X-Forwarded-Proto",
        "https",
        "X-Forwarded-Host",
        "article-issuer.example.invalid",
      ],
      socket: { remoteAddress: "192.0.2.2" },
      url: "/auth",
    } as unknown as http.IncomingMessage;
    expect(articleAuthorizationRequestAllowed(incoming, config)).toBe(false);
  });
  it("serves formal discovery and secure protocol cookies only through the checked loopback HTTPS proxy", async () => {
    const env = environment();
    const reservation = http.createServer();
    const port = await listen(reservation);
    await close(reservation);
    env.ARTICLE_AUTHORIZATION_PORT = String(port);
    const pool = {
      query: vi.fn(() => {
        throw new Error("UNEXPECTED_DATABASE_ACCESS");
      }),
    } as unknown as Pool;
    const issuer = await startArticleAuthorizationServer({
      config: configFrom(env),
      environment: env,
      pool,
      buildId: "synthetic",
    });
    let proxy: https.Server | undefined;
    try {
      const host = "article-issuer.example.invalid";
      const goodHeaders = {
        host,
        "x-forwarded-host": host,
        "x-forwarded-proto": "https",
      };
      for (const headers of [
        { host },
        { ...goodHeaders, host: "wrong.example.invalid" },
        { ...goodHeaders, "x-forwarded-proto": "http" },
        { ...goodHeaders, "x-forwarded-host": "wrong.example.invalid" },
        { ...goodHeaders, "x-forwarded-proto": "https,http" },
        { ...goodHeaders, forwarded: "proto=https" },
      ]) {
        const denied = await request({
          hostname: "127.0.0.1",
          port,
          path: "/article-authoring/consent/synthetic/resume",
          headers,
        });
        expect(denied.status).toBe(400);
        expect(denied.headers["set-cookie"] === undefined).toBe(true);
      }
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
          `/CN=${host}`,
          "-addext",
          `subjectAltName=DNS:${host}`,
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
        servername: host,
        ca: readFileSync(certificate),
        headers: { host },
      };
      const discovery = await request(
        { ...base, path: "/.well-known/oauth-authorization-server" },
        true,
      );
      expect(discovery.status).toBe(200);
      const metadata = JSON.parse(discovery.body) as {
        issuer: string;
        code_challenge_methods_supported: string[];
      };
      expect(metadata.issuer).toBe(env.ARTICLE_AUTHORING_ISSUER);
      expect(metadata.code_challenge_methods_supported).toContain("S256");
      const jwks = await request({ ...base, path: "/jwks" }, true);
      expect(jwks.status).toBe(200);
      const published = JSON.parse(jwks.body) as { keys: JsonWebKey[] };
      expect(published.keys.map((key) => key.kid)).toEqual([
        "synthetic-current",
      ]);
      expect(published.keys.every((key) => key.d === undefined)).toBe(true);
      const query = new URLSearchParams({
        client_id: "synthetic-article-client",
        redirect_uri: "http://127.0.0.1:44553/callback",
        response_type: "code",
        scope: "artvenn:article:draft",
        resource: env.ARTICLE_AUTHORING_RESOURCE!,
        code_challenge: randomBytes(32).toString("base64url"),
        code_challenge_method: "S256",
        prompt: "consent",
        state: "synthetic-state",
      });
      query.append("resource", env.ARTICLE_AUTHORING_RESOURCE!);
      const authorization = await request(
        { ...base, path: `/auth?${query.toString()}` },
        true,
      );
      expect(authorization.status).toBe(303);
      expect(
        authorization.headers.location?.startsWith(
          "https://app.example.invalid/article-authoring/consent/",
        ),
      ).toBe(true);
      const cookies = authorization.headers["set-cookie"] ?? [];
      expect(cookies.length > 0).toBe(true);
      expect(
        cookies.every(
          (cookie) => /; secure/iu.test(cookie) && /; httponly/iu.test(cookie),
        ),
      ).toBe(true);
      for (const resources of [
        [
          env.ARTICLE_AUTHORING_RESOURCE!,
          "https://foreign.example.invalid/mcp",
        ],
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
            "https://app.example.invalid/article-authoring/consent/",
          ),
        ).not.toBe(true);
      }
      expect(pool.query).not.toHaveBeenCalled();
      // Seed synthetic native grant artifacts to exercise the maintained token
      // endpoint, PKCE, resource selection, rotation and replay over real HTTPS.
      // These fixtures do not represent a human consent or a live acceptance.
      vi.mocked(pool.query).mockResolvedValue({
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
      const client = await native.Client.find("synthetic-article-client");
      const resource = env.ARTICLE_AUTHORING_RESOURCE!;
      const scope = "artvenn:article:draft";
      const verifier = randomBytes(32).toString("base64url");
      const tokenRequest = async (params: URLSearchParams) =>
        request(
          {
            ...base,
            path: "/token",
            method: "POST",
            headers: {
              host,
              "content-type": "application/x-www-form-urlencoded",
            },
          },
          true,
          params.toString(),
        );
      for (const grantType of ["authorization_code", "refresh_token"]) {
        for (const resources of [
          [resource, resource],
          [resource, "https://foreign.example.invalid/mcp"],
          [""],
        ]) {
          const grant = new native.Grant({
            accountId: "synthetic-owner",
            clientId: "synthetic-article-client",
          });
          grant.addResourceScope(resource, scope);
          const grantId = await grant.save();
          const values = {
            accountId: "synthetic-owner",
            client,
            grantId,
            resource: [resource],
            scope,
            expiresWithSession: false,
          };
          const source =
            grantType === "authorization_code"
              ? new native.AuthorizationCode({
                  ...values,
                  redirectUri: "http://127.0.0.1:44553/callback",
                  codeChallenge: createHash("sha256")
                    .update(verifier)
                    .digest("base64url"),
                  codeChallengeMethod: "S256",
                })
              : new native.RefreshToken(values);
          const token = await source.save();
          const params = new URLSearchParams({
            grant_type: grantType,
            client_id: "synthetic-article-client",
          });
          if (grantType === "authorization_code") {
            params.set("code", token);
            params.set("redirect_uri", "http://127.0.0.1:44553/callback");
            params.set("code_verifier", verifier);
          } else params.set("refresh_token", token);
          for (const target of resources) params.append("resource", target);
          const result = await tokenRequest(params);
          if (resources.every((entry) => entry === resource)) {
            expect(
              result.status,
              result.status === 200
                ? undefined
                : `${grantType}: ${result.body}`,
            ).toBe(200);
            expect(JSON.parse(result.body).access_token).toBe(
              "synthetic-wrapped-access",
            );
            const replay = await tokenRequest(params);
            expect(replay.status).toBe(400);
            expect(JSON.parse(replay.body).error).toBe("invalid_grant");
          } else {
            expect(result.status).toBe(400);
            expect(JSON.parse(result.body).error).toBe("invalid_target");
          }
        }
      }
    } finally {
      if (proxy) await close(proxy);
      await issuer.close();
    }
  }, 15_000);
});

describe("Article token wrapping distinguishes stale grants from service faults", () => {
  const fixture = (assertGrantCurrent?: () => Promise<void | false>) => {
    let middleware: Parameters<OidcProvider["use"]>[0] | undefined;
    const find = vi.fn(async () => ({ grantId: "synthetic-grant" }));
    const revoke = vi.fn(async () => undefined);
    const mint = vi.fn(async () => ({ presented: "synthetic-wrapped-access" }));
    const recordFailure = vi.fn();
    const provider = {
      use: (handler: Parameters<OidcProvider["use"]>[0]) => {
        middleware = handler;
      },
      AccessToken: { find, revokeByGrantId: revoke },
    } as unknown as OidcProvider;
    const wrappers = { mint } as unknown as ProviderBundle["wrappers"];
    installAccessTokenWrapper(
      { provider, wrappers },
      {
        ...(assertGrantCurrent ? { assertGrantCurrent } : {}),
        recordFailure,
      },
    );
    const body = {
      access_token: "synthetic-unwrapped-access",
      expires_in: 300,
      refresh_token: "synthetic-refresh",
    };
    const ctx: ProviderContext = {
      oidc: { route: "token" },
      status: 200,
      body,
    };
    const run = async () => {
      if (!middleware) throw new Error("TEST_WRAPPER_NOT_INSTALLED");
      await middleware(ctx, async () => undefined);
    };
    return { ctx, run, find, revoke, mint, recordFailure };
  };

  it("returns exact invalid_grant only for a completed authoritative policy refusal", async () => {
    const f = fixture(async () => false);
    await f.run();
    expect(f.ctx.status).toBe(400);
    expect(f.ctx.body).toEqual({ error: "invalid_grant" });
    expect(f.mint).not.toHaveBeenCalled();
    expect(f.revoke).toHaveBeenCalledExactlyOnceWith("synthetic-grant");
    expect(f.recordFailure).not.toHaveBeenCalled();
  });

  it("keeps a current-grant database failure as an empty server error", async () => {
    const f = fixture(async () => {
      throw new Error("synthetic database fault");
    });
    await f.run();
    expect(f.ctx.status).toBe(500);
    expect(f.ctx.body).toBeUndefined();
    expect(f.mint).not.toHaveBeenCalled();
    expect(f.revoke).toHaveBeenCalledExactlyOnceWith("synthetic-grant");
    expect(f.recordFailure).toHaveBeenCalledExactlyOnceWith(
      "WRAP_PERSISTENCE_FAILED",
    );
  });

  it("keeps wrapper persistence faults distinct from invalid_grant", async () => {
    const f = fixture(async () => undefined);
    f.mint.mockRejectedValueOnce(new Error("synthetic persistence fault"));
    await f.run();
    expect(f.ctx.status).toBe(500);
    expect(f.ctx.body).toBeUndefined();
    expect(f.revoke).toHaveBeenCalledExactlyOnceWith("synthetic-grant");
    expect(f.recordFailure).toHaveBeenCalledExactlyOnceWith(
      "WRAP_PERSISTENCE_FAILED",
    );
  });

  it.each([false, true])(
    "preserves successful wrapping with or without the Article policy (%s)",
    async (policy) => {
      const f = fixture(policy ? async () => undefined : undefined);
      await f.run();
      expect(f.ctx.status).toBe(200);
      expect(f.ctx.body).toEqual({
        access_token: "synthetic-wrapped-access",
        expires_in: 300,
        refresh_token: "synthetic-refresh",
      });
      expect(f.revoke).not.toHaveBeenCalled();
      expect(f.recordFailure).not.toHaveBeenCalled();
    },
  );

  it("preserves the no-provider-grant refusal without calling policy or mint", async () => {
    const policy = vi.fn(async () => undefined);
    const f = fixture(policy);
    f.find.mockRejectedValueOnce(new Error("synthetic token lookup fault"));
    await f.run();
    expect(f.ctx.status).toBe(500);
    expect(f.ctx.body).toBeUndefined();
    expect(policy).not.toHaveBeenCalled();
    expect(f.mint).not.toHaveBeenCalled();
    expect(f.recordFailure).toHaveBeenCalledExactlyOnceWith(
      "WRAP_NO_PROVIDER_GRANT",
    );
  });
});
