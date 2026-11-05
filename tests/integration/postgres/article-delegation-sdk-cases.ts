import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
} from "node:crypto";
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
  isCommunityConflictError,
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
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

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
const productionHumans = async (
  pool: Pool,
  invitationSetupPool: Pool,
  directory: string,
) => {
  const invitationCode = randomBytes(16).toString("base64url");
  await invitationSetupPool.query(
    `INSERT INTO community.registration_invitations
      (id,digest,environment,max_uses,expires_at)
      VALUES($1,$2,'production',20,now()+interval '7 days')`,
    [
      `invitation-${randomBytes(16).toString("hex")}`,
      createHash("sha256")
        .update(`artvenn:registration-invitation:v1:${invitationCode}`)
        .digest("hex"),
    ],
  );
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
    AUTH_REGISTRATION_MODE: "invite-only",
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
      invitationCode,
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
  readonly invitationSetupPool: Pool;
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
        const humans = await productionHumans(
          fixture.pool,
          fixture.invitationSetupPool,
          privateDirectory,
        );
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
      if (production)
        await expect(grant.refresh()).rejects.toMatchObject({
          errorCode: "invalid_grant",
        });
    });

    describe("consent is bound to the browser that began the request", () => {
      /**
       * One browser profile. Its cookies live here alone and go only where a
       * browser would send them: the exact host, the cookie's path and its
       * Secure flag. A jar replaying every cookie could not tell two browsers
       * apart, which is the whole question here.
       */
      const browserContext = () => {
        const cookies = new Map<
          string,
          {
            name: string;
            value: string;
            host: string;
            path: string;
            secure: boolean;
          }
        >();
        const open = async (url: URL) => {
          const header = [...cookies.values()]
            .filter(
              (cookie) =>
                cookie.host === url.hostname &&
                (!cookie.secure || url.protocol === "https:") &&
                (url.pathname === cookie.path ||
                  url.pathname.startsWith(`${cookie.path}/`)),
            )
            .map((cookie) => `${cookie.name}=${cookie.value}`)
            .join("; ");
          const response = await requestFetch(url, {
            redirect: "manual",
            headers: header === "" ? {} : { cookie: header },
          });
          for (const raw of response.headers.getSetCookie()) {
            const [pair = "", ...attributes] = raw.split(";");
            const attribute = (name: string) =>
              attributes
                .map((entry) => entry.trim())
                .find((entry) => entry.toLowerCase().startsWith(`${name}=`))
                ?.slice(name.length + 1);
            const split = pair.indexOf("=");
            const name = pair.slice(0, split);
            const path = attribute("path") ?? "/";
            const key = `${name}\0${url.hostname}\0${path}`;
            const expires = attribute("expires");
            if (expires !== undefined && Date.parse(expires) <= Date.now())
              cookies.delete(key);
            else
              cookies.set(key, {
                name,
                value: pair.slice(split + 1),
                host: url.hostname,
                path,
                secure: attributes.some(
                  (entry) => entry.trim().toLowerCase() === "secure",
                ),
              });
          }
          return response;
        };
        return {
          /** Follows redirects until the browser leaves the issuer or stops. */
          navigate: async (target: URL | string) => {
            let url = new URL(target);
            for (let hop = 0; hop < 8; hop++) {
              const response = await open(url);
              const location = response.headers.get("location");
              if (location === null) return { response, url };
              url = new URL(location, url);
              if (url.origin !== issuer.bundle.config.issuer)
                return { response, url };
            }
            throw new Error("BROWSER_REDIRECT_LOOP");
          },
        };
      };
      type BrowserContext = ReturnType<typeof browserContext>;
      /** A listed public client's request, begun in this browser. */
      const begin = async (browser: BrowserContext) => {
        const verifier = randomBytes(32).toString("base64url");
        const state = randomBytes(16).toString("base64url");
        const url = new URL("/auth", issuer.bundle.config.issuer);
        url.search = new URLSearchParams({
          client_id: issuerClientId,
          redirect_uri: callback,
          response_type: "code",
          scope: "artvenn:article:draft artvenn:article:publish offline_access",
          resource,
          code_challenge: createHash("sha256")
            .update(verifier)
            .digest("base64url"),
          code_challenge_method: "S256",
          prompt: "consent",
          state,
        }).toString();
        const { url: landing } = await browser.navigate(url);
        expect(landing.origin).toBe(humanOrigin);
        return { uid: landing.pathname.split("/").at(-1)!, verifier, state };
      };
      /** The signed-in author's click on the consent page, whichever browser. */
      const review = async (uid: string) => {
        const response = await human(`consents/${uid}`);
        expect(response.status).toBe(200);
        return (await response.json()) as {
          consentTicket: string;
          scopes: string[];
        };
      };
      const decide = async (
        uid: string,
        ticket: Awaited<ReturnType<typeof review>>,
        requestId: string = randomUUID(),
        action: "approve" | "deny" = "approve",
      ) =>
        human(`consents/${uid}/${action}`, {
          requestId,
          interactionUid: uid,
          consentTicket: ticket.consentTicket,
          scopes: ticket.scopes,
        });
      const approve = async (uid: string) => {
        const answer = await decide(uid, await review(uid));
        expect(answer.status).toBe(200);
        return ((await answer.json()) as { resumeUrl: string }).resumeUrl;
      };
      const row = async (uid: string) =>
        (
          await fixture.controlPool.query<Record<string, unknown>>(
            "SELECT * FROM community.article_authoring_consents WHERE interaction_uid=$1",
            [uid],
          )
        ).rows[0]!;
      const withoutSecret = (resumeUrl: string) => {
        const url = new URL(resumeUrl);
        url.search = "";
        return url;
      };
      const digestOf = (resumeUrl: string) =>
        createHash("sha256")
          .update(new URL(resumeUrl).searchParams.get("secret") ?? "")
          .digest("hex");
      const expectRefused = (url: URL) => {
        expect(url.searchParams.has("code")).toBe(false);
        expect(url.searchParams.get("error")).toBe("access_denied");
      };
      /** The browser that began the request finishes it and redeems the code. */
      const finish = async (
        browser: BrowserContext,
        resumeUrl: string,
        started: Awaited<ReturnType<typeof begin>>,
      ) => {
        const { url } = await browser.navigate(resumeUrl);
        expect(url.origin + url.pathname).toBe(callback);
        expect(url.searchParams.get("state")).toBe(started.state);
        const tokens = await requestFetch(
          `${issuer.bundle.config.issuer}/token`,
          {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              grant_type: "authorization_code",
              code: url.searchParams.get("code") ?? "",
              redirect_uri: callback,
              client_id: issuerClientId,
              code_verifier: started.verifier,
              resource,
            }).toString(),
          },
        );
        expect(tokens.status).toBe(200);
        const body = (await tokens.json()) as { access_token: string };
        expect(body.access_token.startsWith("artvenn_article_ct_")).toBe(true);
      };

      it("gives the browser that began the request nothing when another browser approved", async () => {
        const stranger = browserContext();
        const { uid } = await begin(stranger);
        const resumeUrl = await approve(uid);
        const { url } = await stranger.navigate(withoutSecret(resumeUrl));
        expectRefused(url);
        expect(await row(uid)).toMatchObject({
          decision: "approved",
          resumed_at: null,
          provider_grant_id: null,
        });
      });

      it("voids the consent when the secret reaches a browser without the cookie", async () => {
        const stranger = browserContext();
        const author = browserContext();
        const { uid } = await begin(stranger);
        const resumeUrl = await approve(uid);
        const { response } = await author.navigate(resumeUrl);
        expect(response.status).toBe(403);
        expect(response.headers.get("content-type")).toBe(
          "text/html; charset=utf-8",
        );
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(response.headers.get("referrer-policy")).toBe("no-referrer");
        expect(await response.text()).toContain("这次授权已作废");
        expect(await row(uid)).toMatchObject({
          decision: "approved",
          resume_secret_digest: null,
          resumed_at: null,
          provider_grant_id: null,
        });
        // Both halves together no longer finish a voided consent.
        expectRefused((await stranger.navigate(resumeUrl)).url);
      });

      it("changes nothing for a wrong secret or no secret without the cookie", async () => {
        const browser = browserContext();
        const elsewhere = browserContext();
        const started = await begin(browser);
        const resumeUrl = await approve(started.uid);
        const wrong = new URL(resumeUrl);
        wrong.searchParams.set("secret", randomBytes(32).toString("base64url"));
        for (const target of [wrong, withoutSecret(resumeUrl)])
          expect((await elsewhere.navigate(target)).response.status).toBe(400);
        // Any other query is not a resume at all, for either browser.
        const extra = new URL(resumeUrl);
        extra.searchParams.set("extra", "1");
        for (const visitor of [elsewhere, browser])
          expect((await visitor.navigate(extra)).response.status).toBe(404);
        expect((await row(started.uid)).resume_secret_digest).toBe(
          digestOf(resumeUrl),
        );
        await finish(browser, resumeUrl, started);
      });

      it("keeps only a digest and lets the secret finish once in the browser that began the request", async () => {
        const browser = browserContext();
        const started = await begin(browser);
        const resumeUrl = await approve(started.uid);
        const secret = new URL(resumeUrl).searchParams.get("secret")!;
        expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/u);
        const armed = await row(started.uid);
        expect(armed.resume_secret_digest).toBe(digestOf(resumeUrl));
        expect(JSON.stringify(armed)).not.toContain(secret);
        await finish(browser, resumeUrl, started);
        const spent = await row(started.uid);
        expect(spent.resume_secret_digest).toBeNull();
        expect(spent.resumed_at).not.toBeNull();
        expect(spent.provider_grant_id).not.toBeNull();
        const { url } = await browser.navigate(resumeUrl);
        expect(url.searchParams.has("code")).toBe(false);
      });

      it("answers a replayed decision with a new secret and retires the lost one", async () => {
        const browser = browserContext();
        const elsewhere = browserContext();
        const started = await begin(browser);
        const ticket = await review(started.uid);
        const requestId = randomUUID();
        const resumeUrls: string[] = [];
        for (let attempt = 0; attempt < 2; attempt++) {
          const answer = await decide(started.uid, ticket, requestId);
          expect(answer.status).toBe(200);
          resumeUrls.push(
            ((await answer.json()) as { resumeUrl: string }).resumeUrl,
          );
        }
        const [lost, current] = resumeUrls as [string, string];
        expect(digestOf(lost)).not.toBe(digestOf(current));
        expect((await elsewhere.navigate(lost)).response.status).toBe(400);
        expect((await row(started.uid)).resume_secret_digest).toBe(
          digestOf(current),
        );
        await finish(browser, current, started);
      });

      it("cannot revive a voided consent by replay or by a direct write", async () => {
        const stranger = browserContext();
        const author = browserContext();
        const { uid } = await begin(stranger);
        const ticket = await review(uid);
        const requestId = randomUUID();
        const answer = await decide(uid, ticket, requestId);
        const { resumeUrl } = (await answer.json()) as { resumeUrl: string };
        expect((await author.navigate(resumeUrl)).response.status).toBe(403);
        expect((await decide(uid, ticket, requestId)).status).toBe(409);
        expect((await row(uid)).resume_secret_digest).toBeNull();
        await expect(
          fixture.controlPool.query(
            "UPDATE community.article_authoring_consents SET resume_secret_digest=$2 WHERE interaction_uid=$1",
            [uid, "a".repeat(64)],
          ),
        ).rejects.toMatchObject({ code: "23001" });
      });

      it("does not void a consent over an interaction lookup failure", async () => {
        const browser = browserContext();
        const started = await begin(browser);
        const resumeUrl = await approve(started.uid);
        const native = issuer.bundle.provider as unknown as {
          Interaction: { find(id: string): Promise<unknown> };
        };
        const failure = vi
          .spyOn(native.Interaction, "find")
          .mockRejectedValueOnce(new Error("SYNTHETIC_LOOKUP_FAILURE"));
        try {
          const { response } = await browser.navigate(resumeUrl);
          expect(response.status).toBe(500);
        } finally {
          failure.mockRestore();
        }
        expect((await row(started.uid)).resume_secret_digest).toBe(
          digestOf(resumeUrl),
        );
        await finish(browser, resumeUrl, started);
      });

      it("still reports a denial to the client from the browser that began the request", async () => {
        const browser = browserContext();
        const { uid } = await begin(browser);
        const answer = await decide(
          uid,
          await review(uid),
          randomUUID(),
          "deny",
        );
        expect(answer.status).toBe(200);
        const { resumeUrl } = (await answer.json()) as { resumeUrl: string };
        expectRefused((await browser.navigate(resumeUrl)).url);
        expect(await row(uid)).toMatchObject({
          decision: "denied",
          resumed_at: null,
        });
      });

      it("refuses a wrong or retired secret in the browser holding the cookie", async () => {
        const holder = browserContext();
        const { uid } = await begin(holder);
        const resumeUrl = await approve(uid);
        const wrong = new URL(resumeUrl);
        wrong.searchParams.set("secret", randomBytes(32).toString("base64url"));
        expectRefused((await holder.navigate(wrong)).url);
        expect(await row(uid)).toMatchObject({
          resume_secret_digest: digestOf(resumeUrl),
          resumed_at: null,
          provider_grant_id: null,
        });

        const replayed = browserContext();
        const started = await begin(replayed);
        const ticket = await review(started.uid);
        const requestId = randomUUID();
        const lost = await decide(started.uid, ticket, requestId);
        const { resumeUrl: retired } = (await lost.json()) as {
          resumeUrl: string;
        };
        const current = await decide(started.uid, ticket, requestId);
        expect(current.status).toBe(200);
        expectRefused((await replayed.navigate(retired)).url);
        expect((await row(started.uid)).resumed_at).toBeNull();
      });

      it("finalizes a grant only for the current secret", async () => {
        const { uid } = await begin(browserContext());
        const resumeUrl = await approve(uid);
        await expect(
          issuer.bundle.consents.finalizeGrant(
            uid,
            randomBytes(32).toString("base64url"),
            "synthetic-grant-never-made",
            new Date(),
          ),
        ).rejects.toSatisfy(isCommunityConflictError);
        expect(await row(uid)).toMatchObject({
          resume_secret_digest: digestOf(resumeUrl),
          resumed_at: null,
          provider_grant_id: null,
        });
      });

      it("lets only the issuer and human control roles write the resume digest", async () => {
        const writable = async (pool: Pool) =>
          (
            await pool.query<{ writable: boolean }>(
              "SELECT has_column_privilege(current_user,'community.article_authoring_consents','resume_secret_digest','UPDATE') AS writable",
            )
          ).rows[0]!.writable;
        expect(await writable(fixture.controlPool)).toBe(true);
        expect(await writable(fixture.issuerPool)).toBe(true);
        expect(await writable(fixture.pool)).toBe(false);
      });
    });
  });
