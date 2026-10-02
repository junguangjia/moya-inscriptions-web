import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createServer as createHttpsServer,
  request as httpsRequest,
} from "node:https";
import { Readable } from "node:stream";
import { createServer, request as httpRequest } from "node:http";
import type { RequestListener } from "node:http";
import type { createPostgresPool } from "@moya/catalog-postgres";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  auth,
  refreshAuthorization,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  ArticleAuthoringService,
  CommunitySessionService,
  hashSessionToken,
} from "@moya/api";
import {
  PostgresArticleAuthoringAdapter,
  PostgresCommunityIdentityAdapter,
  PostgresCommunityAuthAdapter,
  admitArticleOAuthGrant,
  createWrapperStore,
  wrapperKeysFrom,
  parseRegisteredClients,
} from "@moya/community-postgres";
import { articleAuthorizationConfigFrom } from "@moya/agent-authorization";
import { startArticleAuthorizationServer } from "@moya/agent-authorization";
import {
  createArticleDelegationPersistence,
  createArticleDelegationRuntime,
} from "@moya/backend-production";
import {
  createConfiguredProductionAuthService,
  loadProductionAuthConfiguration,
} from "@moya/backend-production/internal/auth";
import type { ProviderTransport } from "@moya/backend-production/internal/auth";
import { handleArticleDelegationRequest } from "@moya/backend-runtime";
import {
  articleDraftSchema,
  articlePreviewSchema,
  articleApprovalResultSchema,
  emptyArticleDocument,
  articlePublicationResultSchema,
} from "@moya/contracts/schemas";
import type { ArticleDraft, PublicUserId } from "@moya/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

type Pool = ReturnType<typeof createPostgresPool>;

/** Test-only HTTPS bridge. Public origins retain default 443 while each verified
 * TLS connection reaches this invocation's loopback listener. No global fetch,
 * DNS, trust store, TLS verification or process environment is changed. */
const productionHttps = async (
  directory: string,
  issuerPort: number,
  backendPort: number,
) => {
  const issuerHost = "article-issuer.example.invalid";
  const resourceHost = "article-web.example.invalid";
  const keyFile = join(directory, "tls-key.pem");
  const certificateFile = join(directory, "tls-cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyFile,
      "-out",
      certificateFile,
      "-days",
      "1",
      "-subj",
      `/CN=${issuerHost}`,
      "-addext",
      `subjectAltName=DNS:${issuerHost},DNS:${resourceHost}`,
    ],
    { stdio: "ignore", timeout: 15_000 },
  );
  chmodSync(keyFile, 0o600);
  const certificate = readFileSync(certificateFile);
  const proxy = createHttpsServer(
    { key: readFileSync(keyFile), cert: certificate },
    (request, response) => {
      const host = request.headers.host;
      if (host !== issuerHost && host !== resourceHost) {
        response.writeHead(421).end();
        return;
      }
      const headers = { ...request.headers };
      delete headers.forwarded;
      headers.host = host;
      headers["x-forwarded-host"] = host;
      headers["x-forwarded-proto"] = "https";
      headers["x-forwarded-port"] = "443";
      headers["x-forwarded-for"] = "127.0.0.1";
      const upstream = httpRequest(
        {
          hostname: "127.0.0.1",
          port: host === issuerHost ? issuerPort : backendPort,
          path: request.url,
          method: request.method,
          headers,
        },
        (incoming) => {
          response.writeHead(incoming.statusCode ?? 502, incoming.headers);
          incoming.pipe(response);
          response.once("close", () => incoming.destroy());
        },
      );
      upstream.once("error", () => {
        response.writeHead(502).end();
      });
      response.once("close", () => upstream.destroy());
      request.pipe(upstream);
    },
  );
  await new Promise<void>((resolve, reject) => {
    proxy.once("error", reject);
    proxy.listen(0, "127.0.0.1", () => {
      proxy.removeListener("error", reject);
      resolve();
    });
  });
  const address = proxy.address();
  if (address === null || typeof address === "string")
    throw Error("TEST_TLS_LISTENER_MISSING");
  const fetchVerified: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (
      url.protocol !== "https:" ||
      url.port !== "" ||
      ![issuerHost, resourceHost].includes(url.hostname)
    )
      throw Error("TEST_HTTPS_ORIGIN_REFUSED");
    const body =
      request.body === null
        ? undefined
        : Buffer.from(await request.arrayBuffer());
    return new Promise<Response>((resolve, reject) => {
      const outgoing = httpsRequest(
        {
          hostname: "127.0.0.1",
          port: address.port,
          servername: url.hostname,
          ca: certificate,
          path: `${url.pathname}${url.search}`,
          method: request.method,
          headers: { ...Object.fromEntries(request.headers), host: url.host },
          signal: request.signal,
        },
        (incoming) => {
          const headers = new Headers();
          for (let index = 0; index < incoming.rawHeaders.length; index += 2)
            headers.append(
              incoming.rawHeaders[index]!,
              incoming.rawHeaders[index + 1]!,
            );
          const status = incoming.statusCode ?? 502;
          if (request.redirect === "error" && status >= 300 && status < 400) {
            incoming.destroy();
            reject(Error("TEST_REDIRECT_REFUSED"));
            return;
          }
          const response = new Response(
            [204, 205, 304].includes(status) || request.method === "HEAD"
              ? null
              : (Readable.toWeb(incoming) as ReadableStream<Uint8Array>),
            { status, headers },
          );
          Object.defineProperty(response, "url", { value: url.href });
          resolve(response);
        },
      );
      outgoing.setTimeout(20_000, () =>
        outgoing.destroy(Error("TEST_HTTPS_TIMEOUT")),
      );
      outgoing.once("error", () => reject(Error("TEST_VERIFIED_HTTPS_FAILED")));
      outgoing.end(body);
    });
  };
  return {
    fetch: fetchVerified,
    close: () =>
      new Promise<void>((resolve, reject) => {
        proxy.closeAllConnections();
        proxy.close((error) => (error ? reject(error) : resolve()));
      }),
  };
};

/** Executes the actual Production config/factory, signing and OTP proof logic.
 * Only the provider transport is simulated in code. Nothing leaves this process. */
const productionHumans = async (pool: Pool, directory: string) => {
  const agreement = {
    version: "synthetic-sdk-v1",
    title: "Synthetic agreement",
    body: "Synthetic acceptance fixture only.",
  };
  const agreementFile = join(directory, "agreement.json");
  writeFileSync(agreementFile, JSON.stringify(agreement), { mode: 0o600 });
  let deliveredCode = "";
  let sends = 0;
  const transport: ProviderTransport = async (request) => {
    if (
      request.url !== "https://ses.tencentcloudapi.com/" ||
      request.headers["x-tc-action"] !== "SendEmail"
    )
      throw Error("TEST_PROVIDER_REQUEST_REFUSED");
    const body = JSON.parse(request.body) as {
      Template: { TemplateData: string };
    };
    const data = JSON.parse(body.Template.TemplateData) as { code: string };
    if (!/^[0-9]{6}$/u.test(data.code))
      throw Error("TEST_PROVIDER_CODE_MISSING");
    deliveredCode = data.code;
    sends++;
    return {
      status: 200,
      body: JSON.stringify({ Response: { MessageId: "synthetic-accepted" } }),
    };
  };
  const config = await loadProductionAuthConfiguration({
    NODE_ENV: "production",
    AUTH_PUBLIC_ENABLED: "true",
    AUTH_EMAIL_PROVIDER: "tencent-ses",
    AUTH_KEY_VERSION: "1",
    AUTH_LOOKUP_KEY: randomBytes(32).toString("base64"),
    AUTH_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    AUTH_OTP_KEY: randomBytes(32).toString("base64"),
    TENCENT_SES_ENDPOINT: "https://ses.tencentcloudapi.com",
    TENCENT_SES_REGION: "ap-guangzhou",
    TENCENT_SES_SECRET_ID: randomBytes(16).toString("hex"),
    TENCENT_SES_SECRET_KEY: randomBytes(32).toString("base64"),
    TENCENT_SES_FROM: "synthetic@example.invalid",
    TENCENT_SES_TEMPLATE_ID: "42",
    AUTH_REGISTRATION_AGREEMENT_FILE: agreementFile,
  });
  if (config === null) throw Error("TEST_PRODUCTION_AUTH_DISABLED");
  const service = createConfiguredProductionAuthService(
    new PostgresCommunityAuthAdapter(pool),
    config,
    { transport },
  );
  const register = async () => {
    const sent = await service.sendChallenge({
      channel: "email",
      purpose: "register",
      identifier: `${randomUUID()}@example.invalid`,
      idempotencyKey: randomUUID(),
      source: "synthetic-sdk",
    });
    if (!sent.ok || !sent.value.continuationToken)
      throw Error("TEST_PRODUCTION_CHALLENGE_REFUSED");
    const verified = await service.verifyChallenge({
      challengeId: sent.value.challengeId,
      continuationToken: sent.value.continuationToken,
      code: deliveredCode,
      idempotencyKey: randomUUID(),
    });
    deliveredCode = "";
    if (!verified.ok || verified.value.outcome !== "registration_required")
      throw Error("TEST_PRODUCTION_PROOF_REFUSED");
    const registered = await service.confirmRegistration({
      handoffToken: verified.value.handoffToken,
      displayName: "合成协议作者",
      agreement: true,
      agreementVersion: agreement.version,
      idempotencyKey: randomUUID(),
    });
    if (!registered.ok) throw Error("TEST_PRODUCTION_REGISTRATION_REFUSED");
    const provenance = await pool.query(
      "SELECT issuer,auth_environment FROM community.sessions WHERE token_hash=$1",
      [await hashSessionToken(registered.value.token)],
    );
    expect(provenance.rows).toEqual([
      { issuer: "verified_login", auth_environment: "production" },
    ]);
    return registered.value;
  };
  const owner = await register();
  const foreign = await register();
  expect(sends).toBe(2);
  return { owner, foreign };
};

/**
 * Register only inside the isolated disposable Article persistence suite, after
 * migrations and owned synthetic public accounts. No private env reads here.
 * Actual OIDC HTTP + real SDK client/server + the SAME PostgreSQL Article port.
 * This tests protocol/transport; rendered browser and vendor clients remain separate.
 */
export const registerArticleDelegationSdkCases = (fixture: {
  readonly pool: Pool;
  readonly controlPool: Pool;
  readonly issuerPool: Pool;
  readonly userId: PublicUserId;
  readonly handle: string;
  readonly issuerDatabaseTarget?: string;
  readonly environment?: "development" | "production";
}) =>
  describe(`${fixture.environment ?? "development"} public-user Article OAuth and SDK protocol`, () => {
    const production = fixture.environment === "production";
    const mode = production ? "production" : "development";
    let userId: PublicUserId;
    let foreignSession: string | undefined;
    let foreignUserId: PublicUserId | undefined;
    let privateDirectory: string | undefined;
    let requestFetch: typeof fetch = fetch;
    let checkEnvironment: ((token: string) => Promise<unknown>) | undefined;
    const sockets: { close: () => Promise<void> }[] = [];
    const sdkClients: Client[] = [];
    const authorizationCategories: string[] = [];
    const issuerClientId = `article-sdk-${randomUUID()}`;
    const callback = "http://127.0.0.1:44551/callback";
    let issuer: Awaited<ReturnType<typeof startArticleAuthorizationServer>>;
    let service: ArticleAuthoringService;
    let runtime: NonNullable<ReturnType<typeof createArticleDelegationRuntime>>;
    let resource: string;
    let humanOrigin: string;
    const now = new Date();
    let humanSession: string;
    let sessionService: CommunitySessionService;
    const callIds = () => ({ requestId: randomUUID() });
    const listen = async (listener: RequestListener) => {
      const server = createServer(listener);
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          server.removeListener("error", reject);
          resolve();
        });
      });
      const address = server.address();
      if (address === null || typeof address === "string")
        throw new Error("TEST_LISTENER_NOT_TCP");
      const close = () =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      sockets.push({ close });
      return {
        origin: `http://127.0.0.1:${address.port}`,
        close,
        port: address.port,
      };
    };
    beforeAll(async () => {
      let route: RequestListener = (_request, response) => {
        response.writeHead(503);
        response.end();
      };
      const backend = await listen((request, response) =>
        route(request, response),
      );
      resource = production
        ? "https://article-web.example.invalid/mcp/article-authoring"
        : `${backend.origin}/mcp/article-authoring`;
      humanOrigin = production
        ? "https://article-web.example.invalid"
        : `http://localhost:${new URL(backend.origin).port}`;
      const reservation = await listen((_request, response) => response.end());
      const issuerOrigin = production
        ? "https://article-issuer.example.invalid"
        : reservation.origin;
      await reservation.close();
      sockets.pop();
      const environment: NodeJS.ProcessEnv = {
        NODE_ENV: mode,
        ARTICLE_AUTHORING_ENABLED: "true",
        ARTICLE_AUTHORING_ISSUER: issuerOrigin,
        ARTICLE_AUTHORING_RESOURCE: resource,
        ARTICLE_AUTHORING_CONSENT_ORIGIN: humanOrigin,
        ARTICLE_AUTHORIZATION_PORT: String(reservation.port),
        ARTICLE_AUTHORIZATION_DATABASE_URL: production
          ? fixture.issuerDatabaseTarget
          : "harness-supplies-owned-pool",
        ARTICLE_AUTHORING_CLIENTS: JSON.stringify([
          {
            clientId: issuerClientId,
            family: "claude",
            label: "Synthetic Article SDK",
            redirectUris: [callback],
          },
        ]),
        ARTICLE_AUTHORING_PROVIDER_INDEX_KEY:
          randomBytes(32).toString("base64"),
        ARTICLE_AUTHORING_PROVIDER_SEAL_KEY: randomBytes(32).toString("base64"),
        ARTICLE_AUTHORING_WRAPPER_INDEX_KEY: randomBytes(32).toString("base64"),
        ARTICLE_AUTHORING_WRAPPER_SEAL_KEY: randomBytes(32).toString("base64"),
        ARTICLE_AUTHORING_COOKIE_KEY: randomBytes(32).toString("base64url"),
      };
      if (production) {
        privateDirectory = mkdtempSync(
          join(tmpdir(), "article-sdk-production-"),
        );
        const { privateKey } = generateKeyPairSync("rsa", {
          modulusLength: 2048,
        });
        const file = join(privateDirectory, "signing-jwks.json");
        writeFileSync(
          file,
          JSON.stringify({
            keys: [
              {
                ...privateKey.export({ format: "jwk" }),
                kid: "synthetic-sdk",
                alg: "RS256",
                use: "sig",
              },
            ],
          }),
          { mode: 0o600 },
        );
        environment.ARTICLE_AUTHORIZATION_SIGNING_JWKS_FILE = file;
        const bridge = await productionHttps(
          privateDirectory,
          reservation.port,
          backend.port,
        );
        sockets.push(bridge);
        requestFetch = bridge.fetch;
      }
      const config = articleAuthorizationConfigFrom(environment);
      if (config === null) throw new Error("TEST_ARTICLE_CONFIG_DISABLED");
      const authority = {
        issuer: config.issuer,
        resource,
        environment: mode,
      } as const;
      const persistence = createArticleDelegationPersistence(
        fixture.controlPool,
        authority,
        { readPool: fixture.pool, clock: () => now },
      );
      const port = new PostgresArticleAuthoringAdapter(
        fixture.pool,
        persistence.adapterOptions,
      );
      service = new ArticleAuthoringService(port, { now: () => now });
      const wrappers = createWrapperStore({
        pool: fixture.pool,
        namespace: "article-authoring",
        keys: wrapperKeysFrom({
          NODE_ENV: mode,
          AGENT_CONNECTION_WRAPPER_INDEX_KEY:
            environment.ARTICLE_AUTHORING_WRAPPER_INDEX_KEY,
          AGENT_CONNECTION_WRAPPER_SEAL_KEY:
            environment.ARTICLE_AUTHORING_WRAPPER_SEAL_KEY,
        }),
      });
      if (production)
        checkEnvironment = (presented) =>
          admitArticleOAuthGrant({
            presented,
            wrappers,
            pool: fixture.pool,
            authority: { ...authority, environment: "development" },
            now,
          });
      const composed = createArticleDelegationRuntime({
        nodeEnv: mode,
        enabled: true,
        pool: fixture.pool,
        authority,
        wrappers,
        persistence,
        authoring: service,
        humanWebOrigin: humanOrigin,
        clients: parseRegisteredClients(environment.ARTICLE_AUTHORING_CLIENTS!),
        readPublished: (id) => port.readPublished(id),
        now: () => now,
        // Protocol tests keep discovery empty; real managed/Catalog and visual
        // fixtures are covered by the persistence/media suites, not invented here.
        readCatalog: async () => null,
        discoverCatalog: async () => {
          throw new Error("DISCOVERY_FIXTURE_REQUIRED");
        },
        inspectThumbnail: async () => {
          throw new Error("THUMBNAIL_FIXTURE_REQUIRED");
        },
      });
      if (composed === undefined)
        throw new Error("TEST_ARTICLE_RUNTIME_DISABLED");
      runtime = composed;
      sessionService = new CommunitySessionService(
        new PostgresCommunityIdentityAdapter(fixture.pool, {
          requireProductionSession: production,
        }),
      );
      if (production) {
        if (privateDirectory === undefined)
          throw Error("TEST_PRIVATE_DIRECTORY_REQUIRED");
        const humans = await productionHumans(fixture.pool, privateDirectory);
        userId = humans.owner.profile.id;
        humanSession = humans.owner.token;
        foreignUserId = humans.foreign.profile.id;
        foreignSession = humans.foreign.token;
      } else {
        userId = fixture.userId;
        const signedIn = await sessionService.signInDevelopmentAccount(
          fixture.handle,
        );
        if (signedIn === null) throw Error("TEST_DEVELOPMENT_ACCOUNT_REQUIRED");
        humanSession = signedIn.token;
      }
      route = (request, response) => {
        const path = new URL(request.url ?? "/", backend.origin).pathname;
        if (path.startsWith("/v1/community/article-authoring/")) {
          const credential = /^Bearer ([A-Za-z0-9_-]+)$/u.exec(
            request.headers.authorization ?? "",
          )?.[1];
          void (
            credential === undefined
              ? Promise.resolve(null)
              : sessionService.identify(credential)
          ).then((viewer) =>
            handleArticleDelegationRequest(
              request,
              response,
              path.slice("/v1/community/article-authoring/".length).split("/"),
              viewer?.id ?? null,
              runtime.human,
            ),
          );
        } else {
          void runtime.mcp(request, response);
        }
      };
      issuer = await startArticleAuthorizationServer({
        config,
        pool: fixture.issuerPool,
        environment,
        buildId: "synthetic-sdk-roundtrip",
        recordFailure: (category) => authorizationCategories.push(category),
      });
      sockets.push(issuer);
    });
    afterAll(async () => {
      await Promise.allSettled(sdkClients.map((client) => client.close()));
      await Promise.allSettled(sockets.map((socket) => socket.close()));
      if (privateDirectory !== undefined)
        rmSync(privateDirectory, { recursive: true, force: true });
      // The owning disposable database suite performs teardown, never a shared DB.
    });

    const human = async (
      path: string,
      body?: unknown,
      session = humanSession,
      account = userId,
    ) =>
      requestFetch(
        `${new URL(resource).origin}/v1/community/article-authoring/${path}`,
        {
          method: body === undefined ? "GET" : "POST",
          redirect: "error",
          cache: "no-store",
          headers: {
            authorization: `Bearer ${session}`,
            "x-author-account": account,
            ...(body === undefined
              ? {}
              : { "content-type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
      );
    const authorize = async (scopes: string) => {
      let tokens: OAuthTokens | undefined;
      let verifier = "";
      let authorization: URL | undefined;
      const state = randomBytes(32).toString("base64url");
      const provider: OAuthClientProvider = {
        redirectUrl: callback,
        clientMetadata: {
          redirect_uris: [callback],
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          scope: scopes,
        },
        clientInformation: () => ({ client_id: issuerClientId }),
        tokens: () => tokens,
        saveTokens: (value) => {
          tokens = value;
        },
        saveCodeVerifier: (value) => {
          verifier = value;
        },
        codeVerifier: () => verifier,
        state: () => state,
        redirectToAuthorization: (url) => {
          authorization = url;
        },
      };
      const outcome = await auth(provider, {
        fetchFn: requestFetch,
        serverUrl: resource,
        scope: scopes,
      });
      expect(outcome).toBe("REDIRECT");
      if (authorization === undefined)
        throw new Error("OAUTH_REDIRECT_MISSING");
      expect(authorization.searchParams.get("code_challenge_method")).toBe(
        "S256",
      );
      authorization.searchParams.set("prompt", "consent");
      const jar = new Map<string, string>();
      const remember = (response: Response) => {
        for (const raw of response.headers.getSetCookie()) {
          const pair = raw.split(";")[0]!;
          const split = pair.indexOf("=");
          if (split > 0) jar.set(pair.slice(0, split), pair.slice(split + 1));
        }
      };
      let next = authorization,
        landing: URL | undefined;
      for (let hop = 0; hop < 8; hop++) {
        const response = await requestFetch(next, {
          redirect: "manual",
          headers: {
            cookie: [...jar]
              .map(([key, value]) => `${key}=${value}`)
              .join("; "),
          },
        });
        remember(response);
        const location = response.headers.get("location");
        if (location === null) {
          const body = await response.text();
          const category =
            /\b(invalid_request|invalid_scope|server_error|access_denied|unauthorized_client|invalid_client|invalid_redirect_uri)\b/u.exec(
              body,
            )?.[1] ?? "unclassified";
          throw new Error(
            `OAUTH_LANDING_MISSING: HTTP_${response.status}; ${category}; ${authorizationCategories.join(",")}`,
          );
        }
        next = new URL(location, issuer.bundle.config.issuer);
        if (next.origin === humanOrigin) {
          landing = next;
          break;
        }
      }
      if (landing === undefined) throw new Error("HUMAN_CONSENT_NOT_REACHED");
      const uid = landing.pathname.split("/").at(-1)!;
      const reviewResponse = await human(`consents/${uid}`);
      expect(reviewResponse.status).toBe(200);
      const review = await reviewResponse.json();
      const decisionResponse = await human(`consents/${uid}/approve`, {
        ...callIds(),
        interactionUid: uid,
        consentTicket: review.consentTicket,
        scopes: review.scopes,
      });
      expect(decisionResponse.status).toBe(200);
      const decision = await decisionResponse.json();
      const resume = await requestFetch(decision.resumeUrl, {
        redirect: "manual",
        headers: {
          cookie: [...jar].map(([key, value]) => `${key}=${value}`).join("; "),
        },
      });
      const location = resume.headers.get("location");
      if (location === null) throw new Error("OAUTH_CALLBACK_MISSING");
      remember(resume);
      let result = new URL(location, issuer.bundle.config.issuer);
      const expectedCallback = new URL(callback);
      for (
        let hop = 0;
        hop < 8 &&
        (result.origin !== expectedCallback.origin ||
          result.pathname !== expectedCallback.pathname);
        hop++
      ) {
        if (result.origin !== issuer.bundle.config.issuer)
          throw new Error("OAUTH_REDIRECT_ORIGIN_MISMATCH");
        const response = await requestFetch(result, {
          redirect: "manual",
          headers: {
            cookie: [...jar]
              .map(([key, value]) => `${key}=${value}`)
              .join("; "),
          },
        });
        remember(response);
        const target = response.headers.get("location");
        if (target === null) throw new Error("OAUTH_CALLBACK_MISSING");
        result = new URL(target, issuer.bundle.config.issuer);
      }
      if (
        result.origin !== expectedCallback.origin ||
        result.pathname !== expectedCallback.pathname
      )
        throw new Error("OAUTH_CALLBACK_NOT_REACHED");
      if (result.searchParams.get("state") !== state)
        throw new Error("OAUTH_STATE_MISMATCH");
      const code = result.searchParams.get("code");
      if (code === null) throw new Error("OAUTH_CODE_MISSING");
      await auth(provider, {
        fetchFn: requestFetch,
        serverUrl: resource,
        scope: scopes,
        authorizationCode: code,
      });
      if (
        tokens === undefined ||
        !tokens.access_token.startsWith("artvenn_article_ct_")
      )
        throw new Error("PUBLIC_TOKEN_WRAPPER_MISSING");
      const client = new Client({
        name: "synthetic-article-sdk",
        version: "1.0.0",
      });
      sdkClients.push(client);
      await client.connect(
        new StreamableHTTPClientTransport(new URL(resource), {
          authProvider: provider,
          fetch: requestFetch,
        }) as Parameters<Client["connect"]>[0],
      );
      const refresh = async () => {
        if (!tokens?.refresh_token) throw Error("TEST_REFRESH_TOKEN_MISSING");
        tokens = await refreshAuthorization(issuer.bundle.config.issuer, {
          clientInformation: { client_id: issuerClientId },
          refreshToken: tokens.refresh_token,
          resource: new URL(resource),
          fetchFn: requestFetch,
          metadata: await (
            await requestFetch(
              `${issuer.bundle.config.issuer}/.well-known/openid-configuration`,
            )
          ).json(),
        });
      };
      return { client, provider, refresh, token: () => tokens!.access_token };
    };
    const draft = (
      value: Awaited<ReturnType<Client["callTool"]>>,
    ): ArticleDraft => {
      if (value.isError) throw new Error("MCP_ARTICLE_CALL_REFUSED");
      return articleDraftSchema.parse(value.structuredContent);
    };
    it("human control can lock an exact candidate but cannot update its identity, version or document", async () => {
      const created = await service.create(
        { source: "human", userId: userId },
        {
          ...callIds(),
          title: "Synthetic control lock",
          coverRefId: null,
          document: emptyArticleDocument(),
        },
      );
      const locked = await fixture.controlPool.query(
        "SELECT id FROM community.article_documents WHERE id=$1 FOR SHARE",
        [created.id],
      );
      expect(locked.rows).toEqual([{ id: created.id }]);
      await expect(
        fixture.controlPool.query(
          "UPDATE community.article_documents SET id=id WHERE id=$1",
          [created.id],
        ),
      ).rejects.toMatchObject({ code: "23000" });
      for (const assignment of [
        "version=version+1",
        "document=document",
        "owner_id=owner_id",
      ]) {
        await expect(
          fixture.controlPool.query(
            `UPDATE community.article_documents SET ${assignment} WHERE id=$1`,
            [created.id],
          ),
        ).rejects.toMatchObject({ code: "42501" });
      }
      expect(
        (await service.read({ source: "human", userId: userId }, created.id))
          .version,
      ).toBe(created.version);
    });
    it("real SDK negotiates and keeps default grants draft-only; exact human edit makes an Agent write stale", async () => {
      const grant = await authorize("artvenn:article:draft");
      if (production) {
        await expect(checkEnvironment!(grant.token())).rejects.toThrow();
        await grant.refresh();
      }
      const tools = await grant.client.listTools();
      expect(
        tools.tools.some((tool) => tool.name === "artvenn_article_publish"),
      ).toBe(false);
      expect(
        tools.tools.every(
          (tool) =>
            tool.inputSchema.type === "object" &&
            tool.outputSchema?.type === "object",
        ),
      ).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(tools))).toBeLessThan(200_000);
      const created = draft(
        await grant.client.callTool({
          name: "artvenn_article_drafts_create",
          arguments: {
            ...callIds(),
            title: "Synthetic draft",
            coverRefId: null,
            document: emptyArticleDocument(),
          },
        }),
      );
      await service.save({ source: "human", userId: userId }, created.id, {
        ...callIds(),
        expectedVersion: created.version,
        title: "Human revision",
        coverRefId: created.coverRefId,
        document: created.document,
      });
      const stale = await grant.client.callTool({
        name: "artvenn_article_drafts_update",
        arguments: {
          articleId: created.id,
          command: {
            ...callIds(),
            expectedVersion: created.version,
            title: "Stale Agent revision",
            coverRefId: null,
            document: created.document,
          },
        },
      });
      expect(stale.isError).toBe(true);
      expect(
        (await service.read({ source: "human", userId: userId }, created.id))
          .title,
      ).toBe("Human revision");
    });
    it("candidate preview links to the human session, self-approval fails, approval publishes once and revoke rejects receipt replay", async () => {
      const grant = await authorize(
        "artvenn:article:draft artvenn:article:publish",
      );
      const initial = draft(
        await grant.client.callTool({
          name: "artvenn_article_drafts_create",
          arguments: {
            ...callIds(),
            title: "Synthetic approved candidate",
            coverRefId: null,
            document: emptyArticleDocument(),
          },
        }),
      );
      const created = draft(
        await grant.client.callTool({
          name: "artvenn_article_drafts_update",
          arguments: {
            articleId: initial.id,
            command: {
              ...callIds(),
              expectedVersion: initial.version,
              title: "Synthetic edited approved candidate",
              coverRefId: initial.coverRefId,
              document: initial.document,
            },
          },
        }),
      );
      expect(created.version).toBe(initial.version + 1);
      const candidate = {
        ...callIds(),
        articleId: created.id,
        expectedVersion: created.version,
        fingerprint: created.fingerprint,
      };
      const preview = await grant.client.callTool({
        name: "artvenn_article_preview",
        arguments: candidate,
      });
      expect(
        articlePreviewSchema.parse(preview.structuredContent).draft.document,
      ).toEqual(created.document);
      expect(
        CallToolResultSchema.parse(preview).content.some(
          (item) =>
            item.type === "text" &&
            item.text.includes("/article-authoring/approval?"),
        ),
      ).toBe(true);
      const approvals = await grant.client.callTool({
        name: "artvenn_article_approval_status",
        arguments: candidate,
      });
      const status = approvals.structuredContent as {
        approval: unknown;
        approvalUrl: string;
      };
      expect(status.approval).toBeNull();
      const link = new URL(status.approvalUrl);
      const exact = {
        connectionId: link.searchParams.get("connection"),
        articleId: created.id,
        expectedVersion: created.version,
        fingerprint: created.fingerprint,
      };
      // A delegated token cannot authenticate the human approval HTTP boundary.
      const forged = await requestFetch(
        `${new URL(resource).origin}/v1/community/article-authoring/approvals`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${grant.token()}`,
            "content-type": "application/json",
            "x-author-account": userId,
          },
          body: JSON.stringify({ ...callIds(), ...exact, confirmed: true }),
        },
      );
      expect(forged.status).toBe(401);
      if (production) {
        if (!foreignSession || !foreignUserId)
          throw Error("TEST_FOREIGN_SESSION_MISSING");
        const staleReview = await human("approvals/review", {
          ...exact,
          expectedVersion: initial.version,
        });
        expect(staleReview.status).toBe(409);
        const foreignReview = await human(
          "approvals/review",
          exact,
          foreignSession,
          foreignUserId,
        );
        expect(foreignReview.status).toBe(404);
        const spoofed = await human(
          "approvals/review",
          exact,
          foreignSession,
          userId,
        );
        expect(spoofed.status).toBe(401);
      }
      const reviewResponse = await human("approvals/review", exact);
      expect(reviewResponse.status).toBe(200);
      const review = await reviewResponse.json();
      if (production) {
        const foreignApproval = await human(
          "approvals",
          { ...callIds(), ...exact, reviewTicket: review.reviewTicket },
          foreignSession,
          foreignUserId,
        );
        expect(foreignApproval.status).toBe(404);
      }
      const approvedResponse = await human("approvals", {
        ...callIds(),
        ...exact,
        reviewTicket: review.reviewTicket,
      });
      expect(approvedResponse.status).toBe(201);
      const approval = articleApprovalResultSchema.parse(
        await approvedResponse.json(),
      );
      const published = await grant.client.callTool({
        name: "artvenn_article_publish",
        arguments: { ...candidate, approvalId: approval.id },
      });
      const result = articlePublicationResultSchema.parse(
        published.structuredContent,
      );
      expect(result.status).toBe("published");
      const connectionResponse = await human("connections");
      const connections = await connectionResponse.json();
      const current = connections.items.find(
        (item: { id: string }) => item.id === exact.connectionId,
      );
      const revoked = await human(`connections/${current.id}/revoke`, {
        ...callIds(),
        expectedGeneration: current.generation,
      });
      expect(revoked.status).toBe(204);
      const replay = await requestFetch(resource, {
        method: "POST",
        headers: {
          authorization: `Bearer ${grant.token()}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: {},
        }),
      });
      expect(replay.status).toBe(401);
      // Reusing the successful publication request ID cannot restore authority.
      const callReplay = await requestFetch(resource, {
        method: "POST",
        headers: {
          authorization: `Bearer ${grant.token()}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "artvenn_article_publish",
            arguments: { ...candidate, approvalId: approval.id },
          },
        }),
      });
      expect(callReplay.status).toBe(401);
      if (production) await expect(grant.refresh()).rejects.toThrow();
    });
  });
