import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import process from "node:process";
import console from "node:console";
import { URL } from "node:url";
import http from "node:http";
import { chromium } from "@playwright/test";
import {
  UnauthorizedError,
  auth,
  discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata,
  exchangeAuthorization,
  extractResourceMetadataUrl,
  extractWWWAuthenticateParams,
  startAuthorization,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ADMIN_MCP_OPERATOR_ROW_EMAIL } from "@moya/contracts/internal/admin-mcp";

import {
  adminApi,
  bearer,
  clickConsent,
  closedList,
  hex,
  issueAiKey,
  signIn,
  toolSide,
} from "./agent-connections-operator-kit.mjs";

/**
 * Agent Connections V1 (Issue #141) — an UNFAMILIAR client, using the official
 * MCP SDK, told nothing but the server URL and its own registration.
 *
 * WHY THIS IS A SEPARATE CHECK FROM THE BROWSER ACCEPTANCE. That one drives
 * ArtVenn's own flow with hand-built requests: it knows the issuer, it knows
 * `/auth` and `/token`, and it was written by the same people as the server.
 * It can prove the product works. It cannot prove the product is
 * DISCOVERABLE, because it never has to discover anything.
 *
 * So this starts where a real client starts — one URL — and learns the rest
 * through the published chain, using the SDK's own implementation of it:
 *
 *   1. call the MCP endpoint with no token, and read the challenge;
 *   2. follow `resource_metadata` to the protected-resource document;
 *   3. follow `authorization_servers` to the issuer's own metadata;
 *   4. build a PKCE authorization request from that metadata;
 *   5. let a HUMAN approve it in a real browser;
 *   6. exchange the code, then speak MCP.
 *
 * Nothing about the issuer or the token endpoint is supplied to it. If a step
 * of that chain is missing, this fails — which is the point, because that is
 * exactly the state the product was in before: the authorization server was
 * perfectly discoverable on an origin no client could learn about.
 *
 * The client's FAMILY is deliberately not one of the three onboarding presets,
 * and its registration required no code change to exist.
 */

const origin = process.env.AGENT_ACCEPTANCE_ADMIN_ORIGIN ?? "";
const resourceUrl = process.env.AGENT_ACCEPTANCE_RESOURCE ?? "";
const clientId = process.env.AGENT_ACCEPTANCE_GENERIC_CLIENT_ID ?? "";
const redirectUri = process.env.AGENT_ACCEPTANCE_GENERIC_REDIRECT ?? "";
const issuerHint = process.env.AGENT_ACCEPTANCE_ISSUER ?? "";
const seededHandle = process.env.AGENT_ACCEPTANCE_SEEDED_HANDLE ?? "";
const seededUserId = process.env.AGENT_ACCEPTANCE_SEEDED_USER_ID ?? "";
const seededDisplayName =
  process.env.AGENT_ACCEPTANCE_SEEDED_DISPLAY_NAME ?? "";

const READ_ONLY_TOOLS = [
  "artvenn_comments_query",
  "artvenn_comments_read",
  "artvenn_content_search",
  "artvenn_users_find",
];

const completed = [];
let stage = "configuration";
let browser;
let callbackServer;

/** The loopback callback a native client runs. */
const callbackListener = async () => {
  const waiting = [];
  const delivered = [];
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", redirectUri);
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("ok");
    const result = {
      code: url.searchParams.get("code"),
      error: url.searchParams.get("error"),
    };
    const next = waiting.shift();
    if (next) next(result);
    else delivered.push(result);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(Number(new URL(redirectUri).port), "127.0.0.1", resolve);
  });
  return {
    server,
    take: () =>
      delivered.length
        ? Promise.resolve(delivered.shift())
        : new Promise((resolve) => waiting.push(resolve)),
  };
};

// The login door has its own sequence, at the end of this file. The read-only one
// below stays as #141 measured it.
if (process.env.AGENT_AUTHORIZATION_PROFILE === "operator") {
  await operatorAcceptance();
  process.exit();
}

try {
  for (const value of [
    origin,
    resourceUrl,
    clientId,
    redirectUri,
    seededHandle,
    seededUserId,
    seededDisplayName,
  ])
    assert.ok(value.length > 0);

  stage = "unauthorized-access-advertises-discovery";
  const challenge = await globalThis.fetch(resourceUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "acme-agent", version: "0" },
      },
    }),
  });
  assert.equal(challenge.status, 401);
  // Read by the SDK, not by a regex of ours: if the header shape is wrong,
  // the SDK is what will fail to parse it, which is the thing worth knowing.
  const metadataUrl = extractResourceMetadataUrl(challenge);
  assert.ok(metadataUrl, "the 401 must advertise its resource metadata");
  completed.push(stage);

  stage = "discovery-reaches-the-canonical-issuer";
  const resourceMetadata = await discoverOAuthProtectedResourceMetadata(
    resourceUrl,
    { resourceMetadataUrl: metadataUrl },
  );
  assert.equal(resourceMetadata.resource, resourceUrl);
  const [authorizationServer] = resourceMetadata.authorization_servers ?? [];
  assert.ok(authorizationServer, "the resource must name an issuer");
  // The canonical issuer, and the one this deployment actually runs.
  assert.equal(authorizationServer, new URL(issuerHint).origin);
  const authorizationMetadata =
    await discoverAuthorizationServerMetadata(authorizationServer);
  assert.ok(authorizationMetadata, "the issuer must publish its metadata");
  assert.equal(authorizationMetadata.issuer, authorizationServer);
  assert.ok(
    (authorizationMetadata.code_challenge_methods_supported ?? []).includes(
      "S256",
    ),
  );
  completed.push(stage);

  stage = "generic-client-authorizes-through-real-consent";
  callbackServer = await callbackListener();
  const { authorizationUrl, codeVerifier } = await startAuthorization(
    authorizationServer,
    {
      metadata: authorizationMetadata,
      clientInformation: { client_id: clientId },
      redirectUrl: redirectUri,
      scope: "artvenn:read",
      state: randomBytes(8).toString("base64url"),
      resource: new URL(resourceUrl),
    },
  );
  // Deliberately NOT adding `prompt=consent`: a client we do not control will
  // not send it, and the renewal configuration has to work without it.
  assert.doesNotMatch(authorizationUrl.href, /prompt=consent/u);

  const access = JSON.parse(
    await readFile(process.env.CMS_QA_ACCESS_FILE, "utf8"),
  );
  browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext()).newPage();
  page.setDefaultTimeout(30_000);
  await page.goto(`${origin}/admin/login`);
  await page.locator('input[name="email"]').fill(access.ownerEmail);
  await page.locator('input[name="password"]').fill(access.ownerPassword);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((url) => url.pathname === "/admin");
  await page.goto(authorizationUrl.href);
  await page.waitForURL((url) => url.origin === origin);
  await page
    .locator("[data-agent-consent-landing]")
    .waitFor({ state: "visible" });
  await page.locator("[data-agent-consent-continue]").click();
  await page.waitForURL((url) =>
    url.pathname.startsWith("/admin/agent-connections/consent"),
  );
  await page.locator("[data-agent-consent]").waitFor({ state: "visible" });
  // The consent screen must name THIS client, not a preset it resembles.
  assert.equal(
    (await page.locator("[data-agent-consent-client]").innerText()).trim(),
    clientId,
  );
  await page.locator("[data-agent-consent-approve]").click();
  const arrival = await callbackServer.take();
  assert.equal(arrival.error, null);
  assert.ok(arrival.code);
  completed.push(stage);

  stage = "token-exchange-and-renewal-without-prompt-consent";
  const tokens = await exchangeAuthorization(authorizationServer, {
    metadata: authorizationMetadata,
    clientInformation: { client_id: clientId },
    authorizationCode: arrival.code,
    codeVerifier,
    redirectUri,
    resource: new URL(resourceUrl),
  });
  assert.match(tokens.access_token ?? "", /^artvenn_ct_/u);
  // A client that never asked for `offline_access` must still be renewable,
  // or it re-runs a browser consent every five minutes.
  assert.ok(tokens.refresh_token, "a refresh token must be issued");
  completed.push(stage);

  stage = "generic-client-sees-only-the-read-tools";
  const transport = new StreamableHTTPClientTransport(new URL(resourceUrl), {
    requestInit: {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    },
  });
  const client = new Client(
    { name: "acme-agent", version: "0" },
    { capabilities: {} },
  );
  await client.connect(transport);
  const listed = await client.listTools();
  assert.deepEqual(
    listed.tools.map((tool) => tool.name).sort(),
    READ_ONLY_TOOLS,
  );
  completed.push(stage);

  stage = "generic-client-reads-the-seeded-record";
  const answer = await client.callTool({
    name: "artvenn_users_find",
    arguments: { handle: seededHandle, page: 1, pageSize: 20 },
  });
  assert.notEqual(answer.isError, true);
  const parsed = JSON.parse(answer.content[0].text);
  assert.equal(parsed.ok, true, parsed.code ?? "refused");
  assert.equal(parsed.result.total, 1);
  const [user] = parsed.result.items;
  assert.equal(user.id, seededUserId);
  assert.equal(user.handle, seededHandle);
  assert.equal(user.displayName, seededDisplayName);
  assert.equal(user.status, "active");
  assert.deepEqual(Object.keys(user).sort(), [
    "displayName",
    "handle",
    "id",
    "matchKind",
    "status",
  ]);
  completed.push(stage);

  stage = "generic-client-is-denied-management";
  for (const name of [
    "artvenn_operations_execute",
    "artvenn_comments_prepare",
    "editorial_query",
  ]) {
    let denied = false;
    try {
      const forbidden = await client.callTool({ name, arguments: {} });
      const body = forbidden.content?.[0]?.text ?? "";
      denied =
        forbidden.isError === true ||
        (body.startsWith("{") && JSON.parse(body).ok === false);
    } catch {
      // A transport or protocol refusal is a denial too.
      denied = true;
    }
    assert.ok(denied, name);
  }
  // The positive control, so "denied" is not "everything is denied".
  const stillWorks = await client.callTool({
    name: "artvenn_users_find",
    arguments: { handle: seededHandle, page: 1, pageSize: 20 },
  });
  assert.equal(JSON.parse(stillWorks.content[0].text).ok, true);
  completed.push(stage);

  await client.close();
  console.log(JSON.stringify({ ok: true, stage, completed }));
} catch (error) {
  console.log(
    JSON.stringify({
      ok: false,
      stage,
      completed,
      category:
        error instanceof Error ? error.constructor.name : "UnknownError",
    }),
  );
  process.exitCode = 1;
} finally {
  await browser?.close();
  callbackServer?.server.close();
}

/**
 * The first token an issuer really issued, through a real consent, on the door
 * (Issue #355). The official SDK does all of a tool's half by itself from one URL:
 * it takes the 401, discovers, finds no registration endpoint, offers its client id
 * as a vendor's URL because the issuer says it may, and hands over the link a browser
 * opens. A person signs in and clicks 允许. That URL is on the closed list and nothing
 * fetches it: every address this client reaches is written down and checked.
 */
async function operatorAcceptance() {
  const vendorClientId = closedList().get("codex").clientId;
  const reached = new Set();
  const recordingFetch = (target, init) => {
    reached.add(new URL(String(target)).hostname);
    return globalThis.fetch(target, init);
  };

  /** What the SDK asks a tool to keep, kept here for as long as this run. */
  const kept = { redirects: [] };
  const provider = {
    get redirectUrl() {
      return redirectUri;
    },
    get clientMetadataUrl() {
      return vendorClientId;
    },
    get clientMetadata() {
      return {
        client_name: "vendor-style tool",
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      };
    },
    state: () => hex(),
    clientInformation: () => kept.client,
    saveClientInformation: (information) => {
      kept.client = information;
    },
    tokens: () => kept.tokens,
    saveTokens: (tokens) => {
      kept.tokens = tokens;
    },
    redirectToAuthorization: (url) => {
      kept.redirects.push(url);
    },
    saveCodeVerifier: (verifier) => {
      kept.verifier = verifier;
    },
    codeVerifier: () => kept.verifier,
    invalidateCredentials: (scope) => {
      if (scope === "tokens" || scope === "all") delete kept.tokens;
    },
  };
  const newTransport = () =>
    new StreamableHTTPClientTransport(new URL(resourceUrl), {
      authProvider: provider,
      fetch: recordingFetch,
    });
  const newClient = () =>
    new Client({ name: "vendor-style", version: "0" }, { capabilities: {} });

  let side;
  try {
    assert.equal(
      process.env.AGENT_AUTHORIZATION_ENVIRONMENT,
      process.env.CMS_ENVIRONMENT,
    );
    const access = JSON.parse(
      await readFile(process.env.CMS_QA_ACCESS_FILE, "utf8"),
    );
    side = await toolSide(redirectUri);

    stage = "the-challenge-names-the-metadata-and-the-scope";
    const challenge = await globalThis.fetch(resourceUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.equal(challenge.status, 401);
    // Read by the SDK, not by a regex of ours.
    const { resourceMetadataUrl, scope } =
      extractWWWAuthenticateParams(challenge);
    assert.equal(scope, "artvenn:admin");
    const resourceMetadata = await discoverOAuthProtectedResourceMetadata(
      resourceUrl,
      { resourceMetadataUrl },
    );
    assert.equal(resourceMetadata.resource, resourceUrl);
    assert.deepEqual(resourceMetadata.scopes_supported, ["artvenn:admin"]);
    const [authorizationServer] = resourceMetadata.authorization_servers;
    assert.equal(authorizationServer, new URL(issuerHint).origin);
    const metadata =
      await discoverAuthorizationServerMetadata(authorizationServer);
    assert.equal(metadata.issuer, authorizationServer);
    assert.equal(metadata.registration_endpoint, undefined);
    assert.equal(metadata.client_id_metadata_document_supported, true);
    assert.ok(metadata.scopes_supported.includes("artvenn:admin"));
    assert.ok(!metadata.scopes_supported.includes("openid"));
    completed.push(stage);

    stage = "the-sdk-starts-from-one-url-with-a-vendor-client-id";
    const client = newClient();
    await assert.rejects(client.connect(newTransport()), UnauthorizedError);
    assert.equal(kept.redirects.length, 1);
    const [firstLink] = kept.redirects;
    assert.equal(firstLink.searchParams.get("client_id"), vendorClientId);
    assert.equal(firstLink.searchParams.get("resource"), resourceUrl);
    assert.equal(firstLink.searchParams.get("scope"), "artvenn:admin");
    assert.equal(firstLink.searchParams.get("code_challenge_method"), "S256");
    assert.equal(firstLink.origin, authorizationServer);
    completed.push(stage);

    stage = "a-person-signs-in-and-allows";
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(120_000);
    /** The browser's part of a connect, from the link the SDK handed over. */
    const allow = async (link) => {
      await page.goto(link.href);
      const review = page.locator("[data-agent-consent]");
      await review.waitFor({ state: "visible" });
      assert.equal(
        await review.getAttribute("data-agent-consent-client"),
        vendorClientId,
      );
      await clickConsent(page, "approve");
      const arrival = await side.take();
      assert.equal(arrival.error, null);
      return arrival.code;
    };
    await page.goto(firstLink.href);
    await page.waitForURL((url) => url.pathname === "/admin/login");
    await signIn(page, access.ownerEmail, access.ownerPassword);
    const review = page.locator("[data-agent-consent]");
    await review.waitFor({ state: "visible" });
    await clickConsent(page, "approve");
    const arrival = await side.take();
    assert.equal(arrival.error, null);
    completed.push(stage);

    stage = "the-sdk-redeems-the-code-for-a-token-and-a-refresh-token";
    await newTransport().finishAuth(arrival.code);
    assert.match(kept.tokens.access_token, /^artvenn_ct_/u);
    assert.ok(kept.tokens.refresh_token);
    completed.push(stage);

    stage = "the-issued-token-lists-exactly-profile-full";
    const connected = newClient();
    await connected.connect(newTransport());
    const { tools } = await connected.listTools();
    const names = tools.map(({ name }) => name);
    assert.ok(names.length > 0 && names.length <= 15);
    assert.deepEqual(
      names.filter((name) => !name.startsWith("admin_")),
      [],
    );
    const api = adminApi(context, origin);
    const asKey = newClient();
    await asKey.connect(
      new StreamableHTTPClientTransport(new URL(resourceUrl), {
        requestInit: { headers: bearer(await issueAiKey(api)) },
        fetch: recordingFetch,
      }),
    );
    assert.deepEqual((await asKey.listTools()).tools, tools);
    await asKey.close();
    completed.push(stage);

    stage = "one-call-is-audited-naming-the-connection-and-the-person";
    const answer = await connected.callTool({
      name: "admin_whoami",
      arguments: {},
    });
    assert.notEqual(answer.isError, true);
    const whoami = answer.structuredContent;
    assert.equal(whoami.ok, true);
    const connectionId = whoami.data.key.id;
    assert.match(connectionId, /^conn-[0-9a-f]{32}$/u);
    assert.equal(whoami.data.key.toolProfile, "full");
    assert.equal(whoami.data.key.authorizedBy, access.ownerId);
    // No email in what a tool reads, while the audit below names the person.
    assert.ok(!JSON.stringify(answer).includes(access.ownerEmail));
    const rows = await api.audit({
      "where[connectionId][equals]": connectionId,
      "where[tool][equals]": "admin_whoami",
    });
    const operatorRow = (
      await api.call(
        "GET",
        `users?where[email][equals]=${ADMIN_MCP_OPERATOR_ROW_EMAIL}&depth=0`,
      )
    ).json.docs[0];
    assert.ok(operatorRow, "the seeded operator row");
    assert.deepEqual(
      rows.map(({ phase, ok, keyId, keyLabel, userId, authorizedBy }) => ({
        phase,
        ok,
        keyId: keyId ?? null,
        keyLabel,
        userId,
        authorizedBy,
      })),
      [
        {
          phase: "finish",
          ok: true,
          keyId: null,
          keyLabel: "Codex",
          userId: String(operatorRow.id),
          authorizedBy: access.ownerEmail,
        },
      ],
    );
    completed.push(stage);

    stage = "the-sdk-refreshes-with-no-person-and-the-token-rotates";
    const before = kept.tokens;
    assert.equal(
      await auth(provider, { serverUrl: resourceUrl }),
      "AUTHORIZED",
    );
    assert.notEqual(kept.tokens.refresh_token, before.refresh_token);
    assert.notEqual(kept.tokens.access_token, before.access_token);
    const refreshed = newClient();
    await refreshed.connect(newTransport());
    assert.equal((await refreshed.listTools()).tools.length, tools.length);
    await refreshed.close();
    assert.equal(kept.redirects.length, 1, "no person was asked");
    completed.push(stage);

    stage = "a-disconnect-sends-the-sdk-back-to-a-person";
    await page.goto(`${origin}/admin/agent-connections`);
    const row = page.locator(`[data-agent-connection="${connectionId}"]`);
    await row.waitFor({ state: "visible" });
    assert.notEqual(
      await row
        .locator("[data-agent-connection-last-verified]")
        .getAttribute("data-agent-connection-last-verified"),
      "",
    );
    await row.locator("[data-agent-connection-disconnect]").click();
    await page.locator("[data-agent-connections-confirm-accept]").click();
    await row.waitFor({ state: "hidden" });
    // Its 401 makes the SDK refresh. That answers invalid_grant, so the SDK drops
    // the tokens and asks for the browser again rather than failing silently.
    const stopped = newClient();
    await assert.rejects(stopped.connect(newTransport()), UnauthorizedError);
    assert.equal(kept.tokens, undefined);
    assert.equal(kept.redirects.length, 2);
    completed.push(stage);

    stage = "connecting-again-is-a-fresh-consent-that-works";
    const code = await allow(kept.redirects[1]);
    await newTransport().finishAuth(code);
    const again = newClient();
    await again.connect(newTransport());
    assert.equal(
      (await again.callTool({ name: "admin_whoami", arguments: {} }))
        .structuredContent.ok,
      true,
    );
    await again.close();
    completed.push(stage);

    stage = "nothing-reached-a-vendor";
    assert.deepEqual(
      [...reached].filter(
        (hostname) => !["127.0.0.1", "localhost"].includes(hostname),
      ),
      [],
    );
    completed.push(stage);

    await connected.close().catch(() => undefined);
    console.log(JSON.stringify({ ok: true, stage, completed }));
  } catch (error) {
    console.log(
      JSON.stringify({
        ok: false,
        stage,
        completed,
        category:
          error instanceof Error ? error.constructor.name : "UnknownError",
      }),
    );
    process.exitCode = 1;
  } finally {
    await browser?.close();
    await side?.close();
  }
}
