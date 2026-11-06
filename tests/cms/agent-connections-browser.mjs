import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash, randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";
import console from "node:console";
import { setTimeout as delay } from "node:timers/promises";
import { URL } from "node:url";
import http from "node:http";
import { chromium, webkit } from "@playwright/test";
import {
  closePostgresPool,
  createPostgresPool,
  parsePostgresConfig,
} from "@moya/catalog-postgres";

import {
  adminApi,
  authorizationRequest,
  bearer,
  clickConsent,
  closedList,
  consentClicks,
  hex,
  isConsentPost,
  issueAiKey,
  listTools,
  redeemCode,
  refreshTokens,
  signIn,
  toolSide,
  until,
} from "./agent-connections-operator-kit.mjs";

/**
 * Agent Connections V1 (Issue #141 r15 §8, §10) — the acceptance sequence, in
 * a real browser against a real `next dev` Admin and a real authorization
 * listener.
 *
 * The browser does the half only a browser can do: the cross-site landing the
 * provider redirects to, the same-origin step the human takes, the Owner
 * session the review page authenticates, and the consent POST. Everything
 * after consent is the CLIENT's half and is done here over plain HTTP,
 * because that is what a client does — it holds a PKCE verifier and speaks
 * JSON-RPC, it does not run in the Owner's tab.
 *
 * Nothing sensitive reaches stdout. Stage names are fixed words; the two
 * tokens are written to a mode-restricted handoff file the orchestrator reads
 * after it restarts the services, exactly as the existing Owner-browser
 * harness hands its access state across a process boundary.
 */

const READ_ONLY_TOOLS = [
  "artvenn_comments_query",
  "artvenn_comments_read",
  "artvenn_content_search",
  "artvenn_users_find",
];

let browser;
let callbacks;
let stage = "configuration";
const completed = [];
let backendToolRead = "NOT_RUN";
let refusalCode = null;

const origin = process.env.AGENT_ACCEPTANCE_ADMIN_ORIGIN ?? "";
const issuer = process.env.AGENT_ACCEPTANCE_ISSUER ?? "";
const resource = process.env.AGENT_ACCEPTANCE_RESOURCE ?? "";
const clientId = process.env.AGENT_ACCEPTANCE_CLIENT_ID ?? "";
const redirectUri = process.env.AGENT_ACCEPTANCE_REDIRECT_URI ?? "";
// The one synthetic record this acceptance reads, seeded by the orchestrator
// into its own disposable database before any service started.
const seededHandle = process.env.AGENT_ACCEPTANCE_SEEDED_HANDLE ?? "";
const seededUserId = process.env.AGENT_ACCEPTANCE_SEEDED_USER_ID ?? "";
const seededDisplayName =
  process.env.AGENT_ACCEPTANCE_SEEDED_DISPLAY_NAME ?? "";

/**
 * The fields a read-only connection may see of a public user, and no others.
 * Asserted as an exact set rather than a subset: a lookup that started
 * returning an email, an IP or a moderation note would still satisfy every
 * "expected value is present" check ever written.
 */
const SAFE_USER_FIELDS = ["displayName", "handle", "id", "matchKind", "status"];

/** One JSON-RPC call to the Payload MCP endpoint. */
const mcp = async (token, body, sessionId) => {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${token}`,
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const response = await globalThis.fetch(`${origin}/api/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, ...body }),
  });
  const text = await response.text();
  // The endpoint may answer as JSON or as a single SSE frame.
  const payload = text.startsWith("event:")
    ? JSON.parse(
        text
          .split("\n")
          .find((line) => line.startsWith("data:"))
          ?.slice(5) ?? "{}",
      )
    : text
      ? JSON.parse(text)
      : {};
  return {
    status: response.status,
    sessionId: response.headers.get("mcp-session-id") ?? sessionId,
    payload,
  };
};

/**
 * The acceptance READ: one real `tools/call` to `artvenn_users_find` for an
 * exact handle, travelling OAuth -> Payload MCP -> the loopback operator
 * channel -> the running Backend -> `community.public_users` in PostgreSQL.
 *
 * Returns the parsed tool answer, or `null` when the call was denied at any
 * layer, so a caller can assert either direction without inspecting shapes.
 */
const readSeededUser = async (token, sessionId) => {
  const answer = await mcp(
    token,
    {
      method: "tools/call",
      params: {
        name: "artvenn_users_find",
        arguments: { handle: seededHandle, page: 1, pageSize: 20 },
      },
    },
    sessionId,
  );
  if (
    answer.status !== 200 ||
    answer.payload.error !== undefined ||
    answer.payload.result?.isError === true
  )
    return null;
  const text = answer.payload.result?.content?.[0]?.text;
  if (typeof text !== "string") return null;
  const parsed = JSON.parse(text);
  // The adapter answers `{ok:false, code}` for a refusal WITH HTTP 200 and no
  // `isError`, so a check that stopped at the transport would read a
  // forbidden principal as a successful business read.
  return parsed?.ok === true ? parsed.result : null;
};

/** Asserts the answer IS the seeded record, and carries nothing else. */
const assertSeededUser = (result) => {
  assert.ok(result, "the read returned no result");
  assert.equal(result.total, 1);
  assert.equal(result.resolution?.status, "exact");
  assert.equal(result.resolution?.uniqueIdentity, true);
  assert.equal(result.resolution?.matchKind, "handle");
  assert.equal(result.resolution?.userId, seededUserId);
  assert.equal(result.items?.length, 1);
  const [user] = result.items;
  assert.equal(user.id, seededUserId);
  assert.equal(user.handle, seededHandle);
  assert.equal(user.displayName, seededDisplayName);
  assert.equal(user.status, "active");
  assert.equal(user.matchKind, "handle");
  assert.deepEqual(Object.keys(user).sort(), SAFE_USER_FIELDS);
};

/**
 * The client's loopback callback, which is what a native client actually runs.
 *
 * Without it the browser's final hop lands on a closed port: the redirect is
 * real, so something has to answer it, and reading a code out of a failed
 * navigation would be reading a browser error rather than a delivered code.
 */
const callbackListener = async () => {
  const delivered = [];
  const waiting = [];
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
    take: () =>
      delivered.length
        ? Promise.resolve(delivered.shift())
        : new Promise((resolve) => waiting.push(resolve)),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
};

const exchange = async (code, verifier) =>
  (
    await globalThis.fetch(`${issuer}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new globalThis.URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        code_verifier: verifier,
        resource,
      }),
    })
  ).json();

// The login door has its own sequence, at the end of this file. The read-only one
// below stays as #141 measured it.
if (process.env.AGENT_AUTHORIZATION_PROFILE === "operator") {
  await operatorAcceptance();
  process.exit();
}

try {
  assert.equal(process.env.CMS_ENVIRONMENT, "synthetic");
  for (const value of [
    origin,
    issuer,
    resource,
    clientId,
    redirectUri,
    seededHandle,
    seededUserId,
    seededDisplayName,
  ])
    assert.ok(value.length > 0);
  for (const value of [origin, issuer])
    assert.ok(
      ["localhost", "127.0.0.1"].includes(new URL(value).hostname),
      "acceptance runs on loopback only",
    );
  // The whole design rests on these being different hosts: cookies are
  // host-scoped and not port-scoped.
  assert.notEqual(new URL(origin).hostname, new URL(issuer).hostname);

  const access = JSON.parse(
    await readFile(process.env.CMS_QA_ACCESS_FILE, "utf8"),
  );

  stage = "launch";
  callbacks = await callbackListener();
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);

  stage = "owner-signs-in";
  await page.goto(`${origin}/admin/login`);
  await page.locator('input[name="email"]').fill(access.ownerEmail);
  await page.locator('input[name="password"]').fill(access.ownerPassword);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((url) => url.pathname === "/admin");

  /** The client's half of one connection: PKCE, consent, code, token. */
  const connect = async (first) => {
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const authorize = new URL(`${issuer}/auth`);
    for (const [key, value] of Object.entries({
      client_id: clientId,
      response_type: "code",
      redirect_uri: redirectUri,
      scope: "artvenn:read offline_access",
      resource,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: randomBytes(8).toString("base64url"),
      // Without an explicit consent prompt `offline_access` does not survive
      // and no refresh token is issued at all.
      prompt: "consent",
    }))
      authorize.searchParams.set(key, value);

    // A real cross-site navigation: the browser starts on the issuer's host
    // and the provider sends it to the Admin's.
    await page.goto(authorize.href);
    await page.waitForURL((url) => url.origin === origin);

    if (first) {
      stage = "landing-is-unauthenticated";
      // The landing rendered, and it is NOT the admin shell: the Owner is
      // signed in, yet this navigation carried no session and the page did
      // not bounce them to a login they do not need.
      await page
        .locator("[data-agent-consent-landing]")
        .waitFor({ state: "visible" });
      assert.ok(!new URL(page.url()).pathname.startsWith("/admin"));
      assert.equal(
        await page.locator("[data-agent-consent-continue]").count(),
        1,
      );
      completed.push(stage);

      stage = "owner-continues-same-origin";
    }
    // The step the human takes. Same-origin, so the browser sends the
    // SameSite=Strict session it withheld a moment ago.
    await page.locator("[data-agent-consent-continue]").click();
    await page.waitForURL((url) =>
      url.pathname.startsWith("/admin/agent-connections/consent"),
    );
    if (first) completed.push(stage);

    if (first) {
      stage = "review-shows-the-request";
      await page.locator("[data-agent-consent]").waitFor({ state: "visible" });
      assert.equal(
        (await page.locator("[data-agent-consent-client]").innerText()).trim(),
        clientId,
      );
      assert.equal(
        (
          await page.locator("[data-agent-consent-resource]").innerText()
        ).trim(),
        resource,
      );
      assert.match(
        await page.locator("[data-agent-consent-scopes]").innerText(),
        /artvenn:read/u,
      );
      // Management is never offered.
      assert.doesNotMatch(
        await page.locator("[data-agent-consent-scopes]").innerText(),
        /artvenn:manage/u,
      );
      completed.push(stage);
      stage = "consent-approved";
    }

    await page.locator("[data-agent-consent-approve]").click();
    const arrival = await Promise.race([
      callbacks.take(),
      // The form renders a bare refusal code. Surfacing it is safe -- it names
      // a rule, never a value -- and without it a failure here says only
      // "the browser did not go where it was told".
      page
        .locator("[data-agent-consent-error]")
        .waitFor({ state: "visible", timeout: 30_000 })
        .then(async () => ({
          code: null,
          error: await page
            .locator("[data-agent-consent-error]")
            .getAttribute("data-agent-consent-error"),
        })),
    ]);
    if (arrival.error) refusalCode = arrival.error;
    assert.equal(arrival.error, null);
    assert.ok(arrival.code);
    if (first) completed.push(stage);
    const code = arrival.code;

    const tokens = await exchange(code, verifier);
    assert.equal(tokens.error, undefined);
    assert.match(tokens.access_token ?? "", /^artvenn_ct_/u);
    return tokens.access_token;
  };

  const firstToken = await connect(true);
  stage = "token-issued";
  completed.push(stage);

  stage = "mcp-initialize";
  const initialize = await mcp(firstToken, {
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "artvenn-acceptance", version: "0" },
    },
  });
  assert.equal(initialize.status, 200);
  assert.ok(initialize.payload.result);
  const session = initialize.sessionId;
  completed.push(stage);

  stage = "mcp-tools-list-is-read-only";
  const listed = await mcp(
    firstToken,
    { method: "tools/list", params: {} },
    session,
  );
  assert.equal(listed.status, 200);
  const names = (listed.payload.result?.tools ?? [])
    .map((tool) => tool.name)
    .sort();
  assert.deepEqual(names, READ_ONLY_TOOLS);
  completed.push(stage);

  stage = "backend-read-returns-the-seeded-record";
  // THE point of this milestone. Everything before it proves the client was
  // authorized; only this proves the authorization is worth holding.
  //
  // A successful `tools/list` was never evidence of a business read: the tool
  // list is assembled by the Admin's MCP adapter from the connection's preset
  // and never touches the Backend at all. Until the Backend was composed here
  // this call answered OPERATOR_UNREACHABLE with HTTP 200, which is precisely
  // why the summary carried `backendToolRead: NOT_RUN` rather than a pass.
  assertSeededUser(await readSeededUser(firstToken, session));
  backendToolRead = "VERIFIED";
  completed.push(stage);

  stage = "mcp-forbidden-tool-denied";
  // The real management tools of the OTHER preset, plus an editorial tool
  // from the separate policy domain. A read-only connection must reach none
  // of them, however its token is shaped.
  for (const name of [
    "artvenn_operations_execute",
    "artvenn_comments_prepare",
    "artvenn_featured_prepare",
    "editorial_query",
  ]) {
    const forbidden = await mcp(
      firstToken,
      { method: "tools/call", params: { name, arguments: {} } },
      session,
    );
    // Denied, whatever shape the denial takes: a transport refusal, a
    // JSON-RPC error, or an MCP tool result flagged `isError`. What must NOT
    // happen is a successful call.
    const denied =
      forbidden.status !== 200 ||
      forbidden.payload.error !== undefined ||
      forbidden.payload.result?.isError === true;
    assert.ok(denied, name);
  }
  completed.push(stage);

  stage = "revoked-token-denied";
  await page.goto(`${origin}/admin/agent-connections`);
  await page.locator("[data-agent-connections]").waitFor({ state: "visible" });
  // The page's "last observed authenticated request" must now say something,
  // because requests have authenticated. Until r15 nothing wrote that column
  // and this cell was permanently 尚未观察到 — a grant nobody exercised and a
  // row that could never be true.
  // Polled, not sampled once: `recordVerified` is fire-and-forget by
  // contract, so a single read after navigation would pass for timing reasons
  // rather than for its property. A review called that out as flake risk and
  // was right.
  await page.waitForFunction(
    () =>
      (
        globalThis.document.querySelector(
          "[data-agent-connection-last-verified]",
        )?.textContent ?? ""
      ).trim() !== "尚未观察到",
    undefined,
    { timeout: 15_000 },
  );
  const disconnect = page.locator("[data-agent-connection-disconnect]").first();
  await disconnect.waitFor({ state: "visible" });
  await disconnect.click();
  // Disconnecting is destructive, so the page asks first. The button above
  // now opens a confirmation rather than revoking, and this walks the same
  // path a human does: nothing is revoked until the second click.
  const confirm = page.locator("[data-agent-connections-confirm]");
  await confirm.waitFor({ state: "visible" });
  await page.locator("[data-agent-connections-confirm-accept]").click();
  await confirm.waitFor({ state: "hidden" });
  // A revoked connection leaves the primary list and appears under the
  // collapsed history, which is where a finished connection belongs. Opened
  // explicitly, because asserting on a row inside a closed disclosure would
  // be asserting on something the Owner cannot see either.
  const history = page.locator("[data-agent-connections-history]");
  await history.waitFor({ state: "visible" });
  await history.locator("summary").click();
  await page
    .locator('[data-agent-connection-status="revoked"]')
    .first()
    .waitFor({ state: "visible" });
  // The SAME token, on its next request. Nothing was deleted and no clock was
  // consulted.
  //
  // Be exact about WHICH rule denies it: the canonical deny is the
  // connection's revoked STATUS, which `admitGrant` refuses on before it ever
  // compares generations. Measured: with the revoke's generation bump removed,
  // this step still passes, because status alone is enough here. The
  // generation is what keeps the old token denied AFTER a reconnect, and that
  // is the step below, not this one.
  const afterRevoke = await mcp(
    firstToken,
    { method: "tools/list", params: {} },
    session,
  );
  assert.ok(
    afterRevoke.status === 401 ||
      afterRevoke.status === 403 ||
      afterRevoke.payload.error !== undefined,
  );
  completed.push(stage);

  stage = "backend-read-denied-after-disconnect";
  // The access that just worked, asked for the same record it just returned.
  // Stated as the loss of a capability the client DEMONSTRABLY had, which is
  // the only way a revocation claim means anything.
  // `strictEqual`, not `equal`: the loose form is `==`, and `undefined == null`
  // is true -- so an answer that came back successful but carried no result
  // would have satisfied a DENIAL assertion.
  assert.strictEqual(await readSeededUser(firstToken, session), null);
  completed.push(stage);

  stage = "reconnect-issues-new-access";
  const secondToken = await connect(false);
  assert.notEqual(secondToken, firstToken);
  const reconnected = await mcp(secondToken, {
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "artvenn-acceptance", version: "0" },
    },
  });
  assert.equal(reconnected.status, 200);
  completed.push(stage);

  stage = "old-token-still-denied";
  // `initialize`, not `tools/list`. An independent review pointed out that the
  // earlier version omitted the session id that every other `tools/list` in
  // this file passes, so a transport-level refusal for a MISSING SESSION would
  // have satisfied the assertion even with a fully valid token — the stage
  // could not fail for its own name. `initialize` needs no session, so the
  // only thing left that can refuse it is the boundary.
  const stale = await mcp(firstToken, {
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "artvenn-acceptance-stale", version: "0" },
    },
  });
  assert.ok(stale.status !== 200 || stale.payload.error !== undefined);
  // And the positive control, so "denied" is not just "everything is denied".
  const live = await mcp(secondToken, {
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "artvenn-acceptance-live", version: "0" },
    },
  });
  assert.equal(live.status, 200);
  completed.push(stage);

  stage = "backend-read-restored-by-fresh-consent";
  // Regained, and ONLY through a second trip through the browser: the human
  // approved again, and that is what put the record back within reach.
  const reconnectedSession = reconnected.sessionId;
  assertSeededUser(await readSeededUser(secondToken, reconnectedSession));
  // The revoked access is still revoked. A reconnect must not resurrect it,
  // which is what the generation bump is for -- status alone stopped being
  // enough the moment the connection became authorized again.
  assert.strictEqual(
    await readSeededUser(firstToken, reconnectedSession),
    null,
  );
  completed.push(stage);

  // Handed across the restart in a mode-restricted file, never on stdout.
  await writeFile(
    process.env.AGENT_ACCEPTANCE_TOKEN_FILE,
    JSON.stringify({ stale: firstToken, live: secondToken }),
    { mode: 0o600 },
  );

  console.log(JSON.stringify({ ok: true, stage, completed, backendToolRead }));
} catch (error) {
  console.log(
    JSON.stringify({
      ok: false,
      stage,
      completed,
      refusalCode,
      // Reported on the failure path too. The orchestrator would otherwise
      // have to infer NOT_RUN from an absent field, and an inferred negative
      // is exactly the kind of evidence this milestone refuses to accept.
      backendToolRead,
      category:
        error instanceof Error ? error.constructor.name : "UnknownError",
    }),
  );
  process.exitCode = 1;
} finally {
  await browser?.close();
  await callbacks?.close();
}

/**
 * The login door (amendment 2026-11-05), in two real browser engines at phone width,
 * against a real issuer, a real Admin and PostgreSQL. Every tool it names is on the
 * closed list with its real client id, and nothing reaches a vendor.
 *
 * Each engine runs the whole sequence with accounts of its own. The Owner signs in
 * fresh in each, so the signed-out path is real. What is read from the database is
 * only what no page shows: whether a ticket was armed. Everything else is read the
 * way a person or a tool would read it.
 */
async function operatorAcceptance() {
  const PHONE = { width: 390, height: 844 };
  const NOT_FOR_YOU = "只有管理员账号可以使用这一页。";
  const REVIEW_PATH = "/admin/agent-connections/consent";
  const list = closedList();
  const client = (family) => list.get(family);
  // A loopback tool's callback, on any port, as the provider allows a native client.
  const loopback = redirectUri;

  let pool;
  let side;
  let openBrowser;
  try {
    assert.equal(process.env.CMS_ENVIRONMENT, "synthetic");
    assert.equal(
      process.env.AGENT_AUTHORIZATION_ENVIRONMENT,
      process.env.CMS_ENVIRONMENT,
    );
    const access = JSON.parse(
      await readFile(process.env.CMS_QA_ACCESS_FILE, "utf8"),
    );
    pool = createPostgresPool(
      parsePostgresConfig({
        DATABASE_URL: process.env.AGENT_ACCEPTANCE_DATABASE_URL,
      }),
    );
    side = await toolSide(loopback);
    const ticketOf = async (uid) =>
      (
        await pool.query(
          "SELECT ticket_digest FROM community.agent_connection_consents WHERE interaction_uid=$1",
          [uid],
        )
      ).rows[0]?.ticket_digest ?? null;
    const authorize = (family, callback = loopback) =>
      authorizationRequest({
        clientId: client(family).clientId,
        issuer,
        redirectUri: callback,
        resource,
      });
    const door = (token) => listTools(resource, bearer(token));
    const refreshOf = (family, tokens) =>
      refreshTokens(
        issuer,
        resource,
        client(family).clientId,
        tokens.refresh_token,
      );
    const overflow = (page) =>
      page.evaluate(
        () =>
          globalThis.document.documentElement.scrollWidth -
          globalThis.document.documentElement.clientWidth,
      );

    for (const [name, engine] of [
      ["chromium", chromium],
      ["webkit", webkit],
    ]) {
      openBrowser = await engine.launch({ headless: true });
      const browser = openBrowser;
      // A context a person would have: phones are the first audience.
      const person = async (options = {}) => {
        const context = await browser.newContext({
          viewport: PHONE,
          ...options,
        });
        const page = await context.newPage();
        // `next dev` compiles a route on its first request.
        page.setDefaultTimeout(120_000);
        return { context, page, api: adminApi(context, origin) };
      };
      /**
       * A click on a hosted tool's review, up to the tool's own callback and not onto
       * its site. A browser follows that last redirect by itself, and Playwright cannot
       * intercept a redirect, so from the resume route on this walks the issuer's answers
       * with the browser's own cookies and stops at the vendor's address. Loopback tools
       * take every hop in the real browser, the resume route included.
       */
      const decideHosted = async ({ context, page }, decision) => {
        const pattern = `${issuer}/agent-connections/consent/*/resume*`;
        let arrival;
        let failure;
        const walk = async (route) => {
          try {
            let answer = await route.fetch({ maxRedirects: 0 });
            let at = route.request().url();
            while (answer.status() >= 300 && answer.status() < 400) {
              const next = new URL(answer.headers().location, at);
              if (next.origin !== new URL(issuer).origin) {
                arrival = next;
                await route.fulfill({
                  status: 200,
                  contentType: "text/plain",
                  body: "ok",
                });
                return;
              }
              at = next.href;
              answer = await context.request.get(at, { maxRedirects: 0 });
            }
            failure = new Error(
              "the issuer did not send the browser to the tool",
            );
          } catch (error) {
            failure = error;
          }
          await route.abort().catch(() => undefined);
        };
        await context.route(pattern, walk);
        await clickConsent(page, decision, stage);
        await until(
          () => arrival !== undefined || failure !== undefined,
          "no answer for the hosted tool",
        );
        await context.unroute(pattern, walk);
        if (failure !== undefined) throw failure;
        return arrival;
      };
      const fromTool = async (page, flow) => {
        await page.goto(side.linkTo(flow.url));
        await page.click("#go");
      };
      const review = (page) => page.locator("[data-agent-consent]");
      const reviewUid = (page) =>
        review(page).getAttribute("data-agent-consent");
      const allowAtLoopback = async (page, flow, how = {}) => {
        await clickConsent(page, "approve", stage, how);
        // The page shows a bare refusal code when the decision fails, so a failure
        // here names a rule rather than only a missing arrival.
        const refused = page.locator("[data-agent-consent-error]");
        const arrival = await Promise.race([
          side.take(),
          refused
            .waitFor({ state: "visible", timeout: 40_000 })
            .then(async () => ({
              code: null,
              error: await refused.getAttribute("data-agent-consent-error"),
            })),
        ]);
        if (arrival.error !== null) refusalCode = arrival.error;
        assert.equal(arrival.error, null);
        const tokens = await redeemCode(issuer, resource, flow, arrival.code);
        assert.equal(tokens.status, 200);
        assert.match(tokens.access_token, /^artvenn_ct_/u);
        assert.ok(tokens.refresh_token);
        return tokens;
      };
      /** One whole connection for a person already signed in, on a loopback tool. */
      const connect = async (page, family) => {
        const flow = authorize(family);
        await fromTool(page, flow);
        await review(page).waitFor({ state: "visible" });
        return allowAtLoopback(page, flow);
      };

      const owner = await person();
      const ownerApi = owner.api;

      stage = `${name}-signed-out-returns-to-the-same-review`;
      const firstFlow = authorize("codex");
      await fromTool(owner.page, firstFlow);
      await owner.page.waitForURL((url) => url.pathname === "/admin/login");
      const returnPath = new URL(owner.page.url()).searchParams.get("redirect");
      assert.ok(returnPath?.startsWith(`${REVIEW_PATH}?interaction=`));
      await signIn(owner.page, access.ownerEmail, access.ownerPassword);
      await owner.page.waitForURL((url) => url.pathname === REVIEW_PATH);
      await review(owner.page).waitFor({ state: "visible" });
      assert.equal(
        `${REVIEW_PATH}?interaction=${await reviewUid(owner.page)}`,
        returnPath,
      );
      completed.push(stage);

      stage = `${name}-no-page-can-frame-the-door`;
      // Sent by the Admin itself on both page groups, beside what Payload sends,
      // so no other page can put a hidden 允许 or 确认断开 under a click.
      for (const path of [
        "/admin/agent-connections",
        `${REVIEW_PATH}?interaction=${hex(12)}`,
        `/agent-connections/consent/${hex(12)}`,
      ]) {
        const answer = await owner.context.request.get(`${origin}${path}`, {
          maxRedirects: 0,
          timeout: 120_000,
        });
        const headers = answer.headers();
        assert.deepEqual(
          [
            path,
            answer.status(),
            headers["content-security-policy"],
            headers["x-frame-options"],
            headers["accept-ch"],
          ],
          [
            path,
            200,
            "frame-ancestors 'none'",
            "DENY",
            "Sec-CH-Prefers-Color-Scheme",
          ],
        );
      }
      completed.push(stage);

      stage = `${name}-review-says-it-plainly-at-phone-width`;
      const local = await review(owner.page).innerText();
      for (const phrase of [
        "「Codex」想连接由于艺后台",
        "不用你逐条确认",
        "发送给 Codex 的提供方 OpenAI",
        "它不能：管理账号和密钥、动暂停开关、看或改操作记录、改敏感开关",
        access.ownerEmail,
        "浏览器只会回到这台电脑上的程序（127.0.0.1、localhost）",
        "如果是别人发来的链接，请点拒绝",
      ])
        assert.ok(local.includes(phrase), phrase);
      for (const raw of [client("codex").clientId, resource, "artvenn:admin"])
        assert.ok(!local.includes(raw), raw);
      assert.equal(
        await review(owner.page).getAttribute("data-agent-consent-client"),
        client("codex").clientId,
      );
      assert.equal(
        await review(owner.page).getAttribute("data-agent-consent-resource"),
        resource,
      );
      assert.equal(await overflow(owner.page), 0);
      for (const button of [
        "[data-agent-consent-approve]",
        "[data-agent-consent-deny]",
      ]) {
        const box = await owner.page.locator(button).boundingBox();
        assert.ok(box && box.x >= 0 && box.x + box.width <= PHONE.width);
      }
      completed.push(stage);

      stage = `${name}-allow-ignores-a-click-that-comes-with-a-window-switch`;
      const approve = owner.page.locator("[data-agent-consent-approve]");
      const allowState = () => approve.getAttribute("aria-disabled");
      const sentEarly = [];
      const onEarlyPost = (request) => {
        if (isConsentPost(request)) sentEarly.push(stage);
      };
      owner.page.on("request", onEarlyPost);
      await until(
        async () => (await allowState()) === null,
        "允许 never became available",
      );
      // Where a keyboard user would be.
      await approve.focus();
      for (const target of ["focus", "visibilitychange"]) {
        const switched = Date.now();
        // The switch and a click in one task, as the second click of a double click
        // lands, then a key at once.
        await owner.page.evaluate((type) => {
          (type === "focus" ? globalThis : globalThis.document).dispatchEvent(
            new globalThis.Event(type),
          );
          globalThis.document
            .querySelector("[data-agent-consent-approve]")
            .click();
        }, target);
        await owner.page.keyboard.press("Enter");
        await until(
          async () => (await allowState()) === "true",
          `允许 did not wait after ${target}`,
          900,
        );
        // Still focused, so the page stays usable from a keyboard.
        assert.ok(
          await approve.evaluate(
            (element) => element === globalThis.document.activeElement,
          ),
          target,
        );
        await until(
          async () => (await allowState()) === null,
          `允许 did not come back after ${target}`,
        );
        assert.ok(Date.now() - switched >= 900, target);
      }
      owner.page.off("request", onEarlyPost);
      assert.deepEqual(sentEarly, []);
      completed.push(stage);

      stage = `${name}-deny-tells-the-tool-access-denied`;
      const deniedUid = await reviewUid(owner.page);
      await clickConsent(owner.page, "deny", stage, { keyboard: true });
      assert.deepEqual(await side.take(), {
        code: null,
        error: "access_denied",
      });
      const denied = await ownerApi.audit({
        "where[targetId][equals]": deniedUid,
      });
      assert.deepEqual(
        denied.map(({ phase, op, ok, code, userId }) => ({
          phase,
          op,
          ok: ok ?? null,
          code: code ?? null,
          userId,
        })),
        [
          {
            phase: "start",
            op: "agent-connections.deny",
            ok: null,
            code: null,
            userId: String(access.ownerId),
          },
          {
            phase: "finish",
            op: "agent-connections.deny",
            ok: true,
            code: "OK",
            userId: String(access.ownerId),
          },
        ],
      );
      completed.push(stage);

      stage = `${name}-signed-in-continues-by-itself-and-arms-once`;
      const secondFlow = authorize("codex");
      const reviewRequests = [];
      const visited = [];
      const onRequest = (request) => {
        const url = new URL(request.url());
        if (url.pathname === REVIEW_PATH)
          reviewRequests.push(
            `${request.resourceType()}:${url.searchParams.has("_rsc") ? "rsc" : "plain"}`,
          );
      };
      const onNavigated = (frame) => {
        if (frame === owner.page.mainFrame())
          visited.push(new URL(frame.url()).pathname);
      };
      owner.page.on("request", onRequest);
      owner.page.on("framenavigated", onNavigated);
      let release;
      const released = new Promise((resolve) => {
        release = resolve;
      });
      const hold = async (route) => {
        await released;
        await route.continue();
      };
      await owner.page.route(`**${REVIEW_PATH}?**`, hold);
      await fromTool(owner.page, secondFlow);
      const landing = owner.page.locator("[data-agent-consent-landing]");
      await landing.waitFor({ state: "visible" });
      const heldUid = await landing.getAttribute("data-agent-consent-landing");
      // The landing went on by itself, with nobody clicking. While the only request
      // for the review is held here, nothing has armed anything: no prefetch did.
      await until(
        () => reviewRequests.length > 0,
        "the landing did not continue",
      );
      assert.equal(await ticketOf(heldUid), null);
      release();
      await owner.page.waitForURL((url) => url.pathname === REVIEW_PATH);
      await owner.page.unroute(`**${REVIEW_PATH}?**`, hold);
      await review(owner.page).waitFor({ state: "visible" });
      assert.equal(await reviewUid(owner.page), heldUid);
      assert.deepEqual(reviewRequests, ["document:plain"]);
      assert.ok(!visited.includes("/admin/login"));
      assert.notEqual(await ticketOf(heldUid), null);
      owner.page.off("request", onRequest);
      owner.page.off("framenavigated", onNavigated);
      completed.push(stage);

      stage = `${name}-allow-reaches-the-door-at-profile-full`;
      // From the keyboard, once 允许 has waited.
      const codexTokens = await allowAtLoopback(owner.page, secondFlow, {
        keyboard: true,
      });
      const onDoor = await door(codexTokens.access_token);
      assert.equal(onDoor.status, 200);
      assert.ok(onDoor.names.includes("admin_whoami"));
      assert.deepEqual(
        onDoor.names.filter((tool) => /^(editorial|artvenn)_/u.test(tool)),
        [],
      );
      // Refresh rotates, with no person involved.
      const rotated = await refreshOf("codex", codexTokens);
      assert.equal(rotated.status, 200);
      assert.notEqual(rotated.refresh_token, codexTokens.refresh_token);
      assert.equal((await door(rotated.access_token)).status, 200);
      completed.push(stage);

      stage = `${name}-hosted-tool-returns-to-its-own-callback`;
      const [hostedCallback] = client("claude").redirectUris;
      const hostedFlow = authorize("claude", hostedCallback);
      await fromTool(owner.page, hostedFlow);
      await review(owner.page).waitFor({ state: "visible" });
      const hosted = await review(owner.page).innerText();
      for (const phrase of [
        "「Claude」想连接由于艺后台",
        "发送给 Claude 的提供方 Anthropic",
        "浏览器会回到：claude.ai",
      ])
        assert.ok(hosted.includes(phrase), phrase);
      for (const raw of [client("claude").clientId, hostedCallback, resource])
        assert.ok(!hosted.includes(raw), raw);
      const hostedArrival = await decideHosted(owner, "approve");
      assert.equal(
        `${hostedArrival.origin}${hostedArrival.pathname}`,
        hostedCallback,
      );
      const firstComputer = await redeemCode(
        issuer,
        resource,
        hostedFlow,
        hostedArrival.searchParams.get("code"),
      );
      assert.equal(firstComputer.status, 200);
      assert.equal((await door(firstComputer.access_token)).status, 200);
      completed.push(stage);

      stage = `${name}-connecting-again-always-asks-again`;
      // Never a silent token, for a hosted tool with a live session and grant too.
      const askedAgain = authorize("claude", hostedCallback);
      await fromTool(owner.page, askedAgain);
      await review(owner.page).waitFor({ state: "visible" });
      assert.equal(
        (await decideHosted(owner, "deny")).searchParams.get("error"),
        "access_denied",
      );
      // A refusal takes nothing from what the same person already connected.
      assert.equal((await door(firstComputer.access_token)).status, 200);
      completed.push(stage);

      stage = `${name}-second-computer-ends-the-first`;
      const secondComputer = await person();
      const elsewhere = authorize("claude", hostedCallback);
      await fromTool(secondComputer.page, elsewhere);
      await secondComputer.page.waitForURL(
        (url) => url.pathname === "/admin/login",
      );
      await signIn(
        secondComputer.page,
        access.ownerEmail,
        access.ownerPassword,
      );
      await review(secondComputer.page).waitFor({ state: "visible" });
      const secondArrival = await decideHosted(secondComputer, "approve");
      const secondTokens = await redeemCode(
        issuer,
        resource,
        elsewhere,
        secondArrival.searchParams.get("code"),
      );
      assert.equal(secondTokens.status, 200);
      assert.equal((await door(secondTokens.access_token)).status, 200);
      assert.equal((await door(firstComputer.access_token)).status, 401);
      assert.equal(
        (await refreshOf("claude", firstComputer)).error,
        "invalid_grant",
      );
      // One person and one tool is one connection, however many computers.
      assert.equal(
        (await ownerApi.connections()).filter(
          ({ family, mine }) => family === "claude" && mine,
        ).length,
        1,
      );
      await secondComputer.context.close();
      completed.push(stage);

      stage = `${name}-approval-does-not-resume-in-another-browser`;
      // A stranger starts a real request in their own browser and sends the page to
      // an administrator, who clicks allow in theirs.
      const stranger = await person();
      const phished = authorize("claude-code");
      await stranger.page.goto(phished.url);
      await stranger.page.waitForURL((url) => url.pathname === "/admin/login");
      const phishedUid = new URL(
        new URL(stranger.page.url()).searchParams.get("redirect"),
        origin,
      ).searchParams.get("interaction");
      const resumePath = `/agent-connections/consent/${phishedUid}/resume`;

      await owner.page.goto(
        `${origin}/agent-connections/consent/${phishedUid}`,
      );
      await review(owner.page).waitFor({ state: "visible" });
      assert.equal(await reviewUid(owner.page), phishedUid);
      let resumeRequest;
      let letResume;
      const resumeHeld = new Promise((resolve) => {
        letResume = resolve;
      });
      const holdResume = async (route) => {
        resumeRequest = route.request().url();
        await resumeHeld;
        await route.continue();
      };
      await owner.page.route(`**${resumePath}*`, holdResume);
      await clickConsent(owner.page, "approve", stage);
      await until(
        () => resumeRequest !== undefined,
        "the allow did not resume",
      );
      assert.ok(new URL(resumeRequest).searchParams.get("secret"));

      // The cookie alone, before the click's own browser even arrives.
      const cookieAlone = await stranger.page.goto(`${issuer}${resumePath}`);
      assert.equal(cookieAlone.status(), 400);
      assert.equal(
        await stranger.page.locator("h1").innerText(),
        "这次连接没有完成",
      );
      assert.equal(
        await stranger.page.locator("small").innerText(),
        "RESUME_SECRET_REQUIRED",
      );

      // The secret alone: the browser that clicked is told it did not start here.
      letResume();
      await owner.page.waitForURL((url) => url.pathname === resumePath);
      await owner.page.unroute(`**${resumePath}*`, holdResume);
      assert.equal(
        await owner.page.locator("h1").innerText(),
        "这次连接已作废",
      );
      assert.ok(
        (await owner.page.locator("body").innerText()).includes(
          "不是从这个浏览器发起的",
        ),
      );
      assert.equal(
        await owner.page.locator("small").innerText(),
        "CONSENT_VOIDED",
      );
      assert.equal(await overflow(owner.page), 0);

      // Afterwards the stranger's browser holds a cookie and an empty hand, and
      // even a leaked secret is spent.
      const noSecret = await stranger.page.goto(`${issuer}${resumePath}`);
      assert.equal(noSecret.status(), 400);
      await stranger.page.goto(resumeRequest).catch(() => undefined);
      assert.ok(
        (await side.settled()).every(({ code }) => code === null),
        "a code reached the tool",
      );
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::int AS grants FROM community.agent_connection_grants g JOIN community.agent_connection_consents c ON g.grant_id = c.grant_id WHERE c.interaction_uid=$1",
            [phishedUid],
          )
        ).rows[0].grants,
        0,
      );
      // Nothing to list as connected, and the audit keeps who clicked allow.
      assert.ok(
        !(await ownerApi.connections()).some(
          ({ family, mine }) => family === "claude-code" && mine,
        ),
      );
      assert.ok(
        (await ownerApi.audit({ "where[targetId][equals]": phishedUid })).some(
          ({ op, phase, userId }) =>
            op === "agent-connections.approve" &&
            phase === "start" &&
            userId === String(access.ownerId),
        ),
      );
      await stranger.context.close();
      completed.push(stage);

      stage = `${name}-nothing-arms-without-an-owner-browser-session`;
      const unopened = await person();
      await unopened.page.goto(
        authorize("chatgpt", client("chatgpt").redirectUris[0]).url,
      );
      await unopened.page.waitForURL((url) => url.pathname === "/admin/login");
      const unarmedPath = new URL(unopened.page.url()).searchParams.get(
        "redirect",
      );
      const unarmedUid = new URL(unarmedPath, origin).searchParams.get(
        "interaction",
      );
      await unopened.context.close();
      assert.equal(await ticketOf(unarmedUid), null);

      const ownerSession = await ownerApi.call("POST", "users/login", {
        email: access.ownerEmail,
        password: access.ownerPassword,
      });
      assert.equal(ownerSession.status, 200);
      const aiKey = await issueAiKey(ownerApi);
      const armedNothing = async (label, session) => {
        const answer = await session.page.goto(`${origin}${unarmedPath}`);
        // The page's own answer is the control page's: a sentence, not a status.
        assert.equal(answer.status(), 200, label);
        await session.page.getByText(NOT_FOR_YOU).waitFor({ state: "visible" });
        assert.equal(await review(session.page).count(), 0, label);
        assert.equal(new URL(session.page.url()).pathname, REVIEW_PATH, label);
        assert.equal(await overflow(session.page), 0, label);
        assert.equal(await ticketOf(unarmedUid), null, label);
        for (const [method, route, body] of [
          ["GET", "agent-connections", undefined],
          [
            "POST",
            "agent-connections/consent",
            { interaction: unarmedUid, ticket: hex(32), decision: "deny" },
          ],
          ["POST", "agent-connections/disconnect", { id: `conn-${hex(16)}` }],
        ]) {
          const refused = await session.api.call(method, route, body);
          assert.deepEqual(
            [label, route, refused.status, refused.json?.error],
            [label, route, 403, "OWNER_ONLY"],
          );
        }
        await session.context.close();
      };

      const automation = await person();
      assert.equal(
        (
          await automation.api.call("POST", "users/login", {
            email: access.automationEmail,
            password: access.automationPassword,
          })
        ).status,
        200,
      );
      await armedNothing("an automation session", automation);
      for (const [label, headers] of [
        ["a connection token", bearer(secondTokens.access_token)],
        ["an AI key", bearer(aiKey)],
        ["an automation MCP key", bearer(access.bearer)],
        [
          "an automation REST key",
          { authorization: `users API-Key ${access.restKey}` },
        ],
        [
          "an Owner token as a JWT",
          { authorization: `JWT ${ownerSession.json.token}` },
        ],
      ])
        await armedNothing(label, await person({ extraHTTPHeaders: headers }));
      // The positive control: the same page and the same routes in an Owner's own
      // browser session, so the refusals above are not everything refusing.
      await owner.page.goto(`${origin}${unarmedPath}`);
      await review(owner.page).waitFor({ state: "visible" });
      assert.notEqual(await ticketOf(unarmedUid), null);
      assert.equal(
        (await ownerApi.call("GET", "agent-connections")).status,
        200,
      );
      completed.push(stage);

      stage = `${name}-any-owner-sees-and-disconnects-with-the-audit-first`;
      const secondOwnerEmail = `second-${name}-${hex()}@editorial.example.invalid`;
      const secondOwnerPassword = hex(24);
      const madeOwner = await ownerApi.call("POST", "users", {
        email: secondOwnerEmail,
        password: secondOwnerPassword,
        role: "owner",
        scopeCatalogIds: [],
      });
      assert.equal(madeOwner.status, 201);
      const secondOwnerId = madeOwner.json.doc.id;
      const other = await person();
      const othersFlow = authorize("claude-code");
      await fromTool(other.page, othersFlow);
      await other.page.waitForURL((url) => url.pathname === "/admin/login");
      await signIn(other.page, secondOwnerEmail, secondOwnerPassword);
      await review(other.page).waitFor({ state: "visible" });
      const othersTokens = await allowAtLoopback(other.page, othersFlow);
      assert.equal((await door(othersTokens.access_token)).status, 200);

      // Told on the next visit, once.
      await owner.page.goto(`${origin}/admin`);
      const notice = owner.page.locator("[data-agent-connections-notice]");
      await notice.waitFor({ state: "visible" });
      assert.ok((await notice.innerText()).includes(secondOwnerEmail));
      await owner.page
        .locator("[data-agent-connections-notice-dismiss]")
        .click();
      await notice.waitFor({ state: "hidden" });
      await until(
        async () =>
          (
            await ownerApi.call(
              "GET",
              "payload-preferences/agent-connections-seen",
            )
          ).json?.value?.seenAt !== undefined,
        "the dismissal was not saved",
      );

      await owner.page.goto(`${origin}/admin/agent-connections`);
      const row = owner.page.locator(
        '[data-agent-connection-family="claude-code"]',
        { hasText: secondOwnerEmail },
      );
      await row.waitFor({ state: "visible" });
      await delay(1000);
      assert.equal(await notice.count(), 0);
      const othersConnection = await row.getAttribute("data-agent-connection");
      assert.equal(await overflow(owner.page), 0);
      await row.locator("[data-agent-connection-disconnect]").click();
      await owner.page
        .locator("[data-agent-connections-confirm-accept]")
        .click();
      await owner.page
        .locator('[role="status"][data-tone="success"]')
        .waitFor({ state: "visible" });
      await row.waitFor({ state: "hidden" });
      assert.equal((await door(othersTokens.access_token)).status, 401);
      assert.equal(
        (await refreshOf("claude-code", othersTokens)).error,
        "invalid_grant",
      );
      assert.deepEqual(
        (
          await ownerApi.audit({
            "where[targetId][equals]": othersConnection,
          })
        ).map(({ class: rowClass, op, phase, ok, userId, connectionId }) => ({
          rowClass,
          op,
          phase,
          ok: ok ?? null,
          userId,
          connectionId,
        })),
        [
          {
            rowClass: "reserved",
            op: "agent-connections.disconnect",
            phase: "start",
            ok: null,
            userId: String(access.ownerId),
            connectionId: othersConnection,
          },
          {
            rowClass: "reserved",
            op: "agent-connections.disconnect",
            phase: "finish",
            ok: true,
            userId: String(access.ownerId),
            connectionId: othersConnection,
          },
        ],
      );
      completed.push(stage);

      stage = `${name}-reconnect-after-disconnect-is-a-fresh-consent`;
      const reconnected = await connect(other.page, "claude-code");
      assert.equal((await door(reconnected.access_token)).status, 200);
      assert.equal((await door(othersTokens.access_token)).status, 401);
      completed.push(stage);

      stage = `${name}-demote-and-restore-leaves-the-old-token-refused`;
      const changeOther = (data) =>
        ownerApi.call("PATCH", `users/${String(secondOwnerId)}`, data);
      assert.equal((await changeOther({ role: "automation" })).status, 200);
      assert.equal((await door(reconnected.access_token)).status, 401);
      assert.equal((await changeOther({ role: "owner" })).status, 200);
      assert.equal((await door(reconnected.access_token)).status, 401);
      assert.equal(
        (await refreshOf("claude-code", reconnected)).error,
        "invalid_grant",
      );
      completed.push(stage);

      stage = `${name}-a-password-change-stops-that-persons-connections`;
      const beforePassword = await connect(other.page, "claude-code");
      assert.equal((await door(beforePassword.access_token)).status, 200);
      const nextPassword = hex(24);
      assert.equal((await changeOther({ password: nextPassword })).status, 200);
      assert.equal((await door(beforePassword.access_token)).status, 401);
      assert.equal(
        (await refreshOf("claude-code", beforePassword)).error,
        "invalid_grant",
      );
      // Nobody else's, and the new password works.
      assert.equal((await door(secondTokens.access_token)).status, 200);
      assert.equal(
        (
          await adminApi(other.context, origin).call("POST", "users/login", {
            email: secondOwnerEmail,
            password: nextPassword,
          })
        ).status,
        200,
      );
      await other.context.close();
      completed.push(stage);

      stage = `${name}-the-connections-page-works-at-phone-width`;
      await owner.page.goto(`${origin}/admin/agent-connections`);
      const page = owner.page.locator("[data-agent-connections]");
      await page.locator("[data-agent-connections-connect]").waitFor({
        state: "visible",
      });
      // A release keeps these equal, and a tool connects only if they are.
      assert.equal(
        await page.getAttribute("data-agent-connections-resource"),
        resource,
      );
      const connector = new URL(
        await owner.page
          .locator("[data-agent-connections-claude]")
          .getAttribute("href"),
      );
      assert.equal(connector.searchParams.get("connectorUrl"), resource);
      for (const family of ["claude-code", "codex", "chatgpt"])
        assert.equal(
          await owner.page
            .locator(`[data-agent-connections-steps="${family}"]`)
            .count(),
          1,
          family,
        );
      // Three one-click buttons, one under another and equally wide on a phone.
      const boxes = [];
      for (const tool of ["claude", "chatgpt", "cursor"]) {
        const button = owner.page.locator(`[data-agent-connections-${tool}]`);
        assert.equal(await button.count(), 1, tool);
        boxes.push(await button.boundingBox());
      }
      for (const [index, box] of boxes.entries()) {
        assert.ok(Math.abs(box.width - boxes[0].width) < 1, "one width");
        if (index > 0)
          assert.ok(box.y >= boxes[index - 1].y + boxes[index - 1].height);
      }
      // Cursor's link carries exactly the server entry, with Cursor's listed id.
      const install = new URL(
        await owner.page
          .locator("[data-agent-connections-cursor]")
          .getAttribute("href"),
      );
      assert.equal(
        `${install.origin}${install.pathname}`,
        "https://cursor.com/install-mcp",
      );
      assert.deepEqual(
        JSON.parse(
          Buffer.from(install.searchParams.get("config"), "base64").toString(
            "utf8",
          ),
        ),
        {
          type: "http",
          url: resource,
          auth: { CLIENT_ID: client("cursor").clientId },
        },
      );
      assert.equal(
        await owner.page
          .locator("[data-agent-connections-codex]")
          .getAttribute("href"),
        "codex://settings",
      );
      // The ChatGPT click copies the address and opens ChatGPT's page in a tab of its
      // own, which is stopped here before it reaches the vendor.
      const vendorRequests = [];
      await owner.context.route("https://chatgpt.com/**", (route) => {
        vendorRequests.push(route.request().url());
        return route.abort();
      });
      // Only Chromium grants the clipboard to a test; WebKit shows either answer.
      if (name === "chromium")
        await owner.context.grantPermissions(
          ["clipboard-read", "clipboard-write"],
          { origin },
        );
      const [vendorTab] = await Promise.all([
        owner.context.waitForEvent("page"),
        owner.page.locator("[data-agent-connections-chatgpt]").click(),
      ]);
      await vendorTab.waitForLoadState().catch(() => undefined);
      await vendorTab.close();
      assert.equal(vendorRequests[0], "https://chatgpt.com/plugins");
      await owner.page.bringToFront();
      const copied = owner.page.getByText("地址已复制。");
      if (name === "chromium") {
        await copied.waitFor({ state: "visible" });
        assert.equal(
          await owner.page.evaluate(() =>
            globalThis.navigator.clipboard.readText(),
          ),
          resource,
        );
      } else
        await copied
          .or(owner.page.locator("[data-agent-connections-copy-refused]"))
          .waitFor({ state: "visible" });
      assert.ok(
        await owner.page
          .locator(
            '[data-agent-connections-pause] a[href="/admin/mcp-control"]',
          )
          .isVisible(),
      );
      assert.equal(await overflow(owner.page), 0);
      completed.push(stage);

      // What the restart check reads: one token from before the second computer,
      // and the one that replaced it.
      await writeFile(
        process.env.AGENT_ACCEPTANCE_TOKEN_FILE,
        JSON.stringify({
          stale: firstComputer.access_token,
          live: secondTokens.access_token,
        }),
        { mode: 0o600 },
      );
      await owner.context.close();
      await browser.close();
      openBrowser = undefined;
    }
    console.log(JSON.stringify({ ok: true, stage, completed, consentClicks }));
  } catch (error) {
    console.log(
      JSON.stringify({
        ok: false,
        stage,
        completed,
        refusalCode,
        consentClicks,
        category:
          error instanceof Error ? error.constructor.name : "UnknownError",
      }),
    );
    process.exitCode = 1;
  } finally {
    await openBrowser?.close().catch(() => undefined);
    await side?.close();
    if (pool) await closePostgresPool(pool);
  }
}
