import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { URL } from "node:url";

/**
 * What the login door's two acceptance children share: the tool's own half of the
 * flow, and the Owner's REST session. `verify-agent-connections.mjs` starts them
 * against a real issuer, a real Admin and PostgreSQL, under the `operator` profile.
 */

export const hex = (bytes = 8) => randomBytes(bytes).toString("hex");

/** Waits for something a browser will do by itself, and fails rather than hangs. */
export const until = async (check, what, limitMs = 60_000) => {
  const deadline = Date.now() + limitMs;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, what);
    await delay(50);
  }
};

export const bearer = (token) => ({
  authorization: ["Bearer", token].join(" "),
});

/** The closed list the services read, by family. */
export const closedList = () =>
  new Map(
    JSON.parse(process.env.AGENT_AUTHORIZATION_CLIENTS ?? "[]").map((entry) => [
      entry.family,
      entry,
    ]),
  );

/**
 * A native tool's loopback listener: the callback a browser returns to, and a page
 * on another site holding the link a person clicks, so the provider's redirect is a
 * real cross-site navigation.
 */
export const toolSide = async (callbackUrl) => {
  const { hostname, origin, port } = new URL(callbackUrl);
  const delivered = [];
  const waiting = [];
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", origin);
    if (url.pathname === "/tool") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        `<!doctype html><a id="go" href="${(
          url.searchParams.get("to") ?? ""
        ).replaceAll("&", "&amp;")}">connect</a>`,
      );
      return;
    }
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("ok");
    const arrival = {
      code: url.searchParams.get("code"),
      error: url.searchParams.get("error"),
    };
    const next = waiting.shift();
    if (next) next(arrival);
    else delivered.push(arrival);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(Number(port), hostname, resolve);
  });
  return {
    linkTo: (target) => `${origin}/tool?to=${encodeURIComponent(target)}`,
    /** The next arrival, or a failure rather than a wait that never ends. */
    take: async (limitMs = 30_000) => {
      const arrival = delivered.length
        ? delivered.shift()
        : await Promise.race([
            new Promise((resolve) => waiting.push(resolve)),
            delay(limitMs, null),
          ]);
      assert.ok(arrival, "nothing reached the tool's callback");
      return arrival;
    },
    /** Everything that arrived in a moment, for a step that should deliver no code. */
    settled: async (limitMs = 1500) => {
      await delay(limitMs);
      return delivered.splice(0);
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
};

/** What a client sends to `/auth`, and what it keeps to redeem the code. */
export const authorizationRequest = ({
  clientId,
  issuer,
  redirectUri,
  resource,
}) => {
  const verifier = randomBytes(32).toString("base64url");
  const url = new URL(`${issuer}/auth`);
  for (const [key, value] of Object.entries({
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: "artvenn:admin",
    resource,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    state: randomBytes(8).toString("base64url"),
  }))
    url.searchParams.set(key, value);
  return { clientId, redirectUri, url: url.href, verifier };
};

const tokenRequest = async (issuer, fields) => {
  const response = await globalThis.fetch(`${issuer}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new globalThis.URLSearchParams(fields),
  });
  return { status: response.status, ...(await response.json()) };
};

export const redeemCode = (issuer, resource, flow, code) =>
  tokenRequest(issuer, {
    grant_type: "authorization_code",
    code,
    redirect_uri: flow.redirectUri,
    client_id: flow.clientId,
    code_verifier: flow.verifier,
    resource,
  });

export const refreshTokens = (issuer, resource, clientId, refreshToken) =>
  tokenRequest(issuer, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
    resource,
  });

/** One `tools/list` on a token, as a tool's next request makes it. */
export const listTools = async (resource, headers) => {
  const response = await globalThis.fetch(resource, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    }),
  });
  const text = await response.text();
  if (response.status !== 200) return { status: response.status, names: [] };
  const frame = text.startsWith("event:")
    ? (text
        .split("\n")
        .find((line) => line.startsWith("data:"))
        ?.slice(5) ?? "{}")
    : text;
  return {
    status: response.status,
    names: (JSON.parse(frame).result?.tools ?? []).map(({ name }) => name),
  };
};

/**
 * The cookie session's REST calls, as the Admin's own pages make them. Bounded,
 * because Playwright here has no limit of its own and `next dev` compiles on demand.
 */
export const adminApi = (context, origin) => {
  const call = async (method, path, body) => {
    const response = await context.request.fetch(`${origin}/api/${path}`, {
      method,
      headers: { origin },
      timeout: 120_000,
      ...(body === undefined ? {} : { data: body }),
    });
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // A refusal that is not JSON is still a status.
    }
    return { status: response.status(), json };
  };
  return {
    call,
    audit: async (where) => {
      const query = new globalThis.URLSearchParams({
        depth: "0",
        limit: "100",
        sort: "id",
        ...where,
      });
      const { status, json } = await call(
        "GET",
        `mcp-audit-events?${query.toString()}`,
      );
      assert.equal(status, 200);
      return json.docs;
    },
    connections: async () => {
      const { status, json } = await call("GET", "agent-connections");
      assert.equal(status, 200);
      return json.result.connections;
    },
  };
};

export const signIn = async (page, email, password) => {
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(password);
  await page.locator('button[type="submit"]').click();
};

/** A request that carries a consent decision. */
export const isConsentPost = (request) =>
  request.method() === "POST" &&
  new URL(request.url()).pathname === "/api/agent-connections/consent";

/**
 * How many clicks each decision took, by stage, for the harness summary. A retry is
 * allowed and is shown here; a second POST is not allowed at all.
 */
export const consentClicks = {};

/**
 * Clicks 允许 or 拒绝 on the review page until the click reaches the page's own
 * handler, which sends the decision at once. The page shows before React has taken
 * it over, and WebKit has been seen to drop a click on a button that already looked
 * hydrated, so a click that sent nothing in a moment is made again. Every consent
 * POST the page sends is counted from before the first click, and the moment a click
 * has to send its POST in starts only once that click was delivered, so a slow click
 * is never taken for a lost one. A decision that sent two POSTs fails the stage.
 *
 * With `keyboard`, the button is focused and Enter pressed instead, as a person
 * without a pointer does.
 */
export const clickConsent = async (
  page,
  decision,
  stage,
  { keyboard = false } = {},
) => {
  const button = `[data-agent-consent-${decision}]`;
  let posts = 0;
  let finished = false;
  const count = (request) => {
    if (isConsentPost(request)) posts += 1;
  };
  page.on("request", count);
  // Resolves on the first POST, so a late one is never waited past.
  const firstPost = (async () => {
    while (!finished && posts === 0) await delay(50);
  })();
  try {
    let attempts = 0;
    while (posts === 0) {
      assert.ok(attempts < 5, "the click never reached the review page");
      // Hydrated, and for 允许 past its wait after the page was shown.
      await Promise.race([
        firstPost,
        page.waitForFunction((target) => {
          const element = globalThis.document.querySelector(target);
          return (
            element !== null &&
            Object.keys(element).some((key) =>
              key.startsWith("__reactFiber"),
            ) &&
            !element.disabled &&
            element.getAttribute("aria-disabled") !== "true"
          );
        }, button),
      ]);
      if (posts > 0) break;
      attempts += 1;
      if (keyboard) {
        await page.locator(button).focus();
        await page.keyboard.press("Enter");
      } else {
        // Not waiting for the navigation it starts: a test may hold that one.
        await page.locator(button).click({ noWaitAfter: true });
      }
      await Promise.race([firstPost, delay(5000)]);
    }
    // A late second POST, from an earlier click or from this one, would arrive now.
    await delay(2000);
    assert.equal(posts, 1, "a decision was sent more than once");
    (consentClicks[stage] ??= []).push(attempts);
  } finally {
    finished = true;
    page.off("request", count);
  }
};

/** An `ai_operator` account and its key at profile full, as an Owner issues them. */
export const issueAiKey = async (api) => {
  const created = await api.call("POST", "users", {
    email: `ai-${hex()}@editorial.example.invalid`,
    password: hex(24),
    role: "ai_operator",
    scopeCatalogIds: [],
  });
  assert.equal(created.status, 201);
  const secret = hex(32);
  const issued = await api.call("POST", "payload-mcp-api-keys", {
    user: created.json.doc.id,
    label: `synthetic-${hex()}`,
    enableAPIKey: true,
    apiKey: secret,
    toolProfile: "full",
  });
  assert.equal(issued.status, 201);
  return secret;
};
