import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { URL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { expect } from "@playwright/test";

/**
 * The Admin MCP rows of the Behavior Matrix on the standalone build, which is the
 * only place a Next production compile, its minified error classes and its folded
 * Development branches can be seen: "Reserved surface by any key or Authorization
 * header", "Admin control page and audit list", the door's named refusals, both
 * MCP paths, "Pause on" and "artvenn_*", and the code half of "Document open by the
 * Owner" and "Approval duplicate". tests/cms/admin-mcp-*.test.ts and
 * editorial-hardening.test.ts hold the same rows in depth; this holds them where
 * they ship.
 *
 * It reports through intermediate stage names only, because the harness compares
 * its list of completed stages exactly and owns that list.
 */

const ACCEPT = "application/json, text/event-stream";
const CONTROL = "/admin/mcp-control";
const AUDIT = "/admin/collections/mcp-audit-events";
const secret = () => randomBytes(32).toString("hex");
const bearer = (value) => ({ authorization: `Bearer ${value}` });
const rpc = (method, params) => ({
  jsonrpc: "2.0",
  id: 1,
  method,
  ...(params === undefined ? {} : { params }),
});

export const verifyAdminMcpSurfaces = async ({
  browser,
  page,
  origin,
  access,
  setStage,
}) => {
  const run = randomUUID();
  const password = secret();
  const endpoint = `${origin}/api/mcp`;

  // The Owner cookie session, through the browser context that logged in.
  const asOwner = async (method, route, data) => {
    const response = await page.request.fetch(`${origin}/api/${route}`, {
      method,
      ...(data === undefined ? {} : { data }),
    });
    assert(response.ok());
    return response.json();
  };
  const call = (method, route, headers, body) =>
    globalThis.fetch(`${origin}/api/${route}`, {
      method,
      redirect: "manual",
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const post = (body, headers = {}) =>
    globalThis.fetch(endpoint, {
      method: "POST",
      headers: {
        accept: ACCEPT,
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
    });

  setStage("admin-mcp-credentials");
  const account = async (name, role, extra = {}) =>
    (
      await asOwner("POST", "users", {
        email: `mcp-${name}-${run}@example.invalid`,
        password,
        role,
        scopeCatalogIds: [],
        ...extra,
      })
    ).doc;
  const makeKey = async (user, fields = {}) => {
    const value = secret();
    const { doc } = await asOwner("POST", "payload-mcp-api-keys", {
      user: user.id,
      label: `synthetic-${run}`,
      enableAPIKey: true,
      apiKey: value,
      ...fields,
    });
    return { id: doc.id, secret: value };
  };
  const past = new Date(Date.now() - 1000).toISOString();

  const automationRestKey = secret();
  const automation = await account("automation", "automation", {
    enableAPIKey: true,
    apiKey: automationRestKey,
    scopeCatalogIds: [`mcp-browser-${run}`],
  });
  const aiOperator = await account("ai", "ai_operator");
  // A token outlives a role change, which is how a JWT can sit on an AI row.
  const holder = await account("holder", "automation");
  const signedIn = await call("POST", "users/login", undefined, {
    email: holder.email,
    password,
  });
  assert.equal(signedIn.status, 200);
  const aiJwt = (await signedIn.json()).token;
  await asOwner("PATCH", `users/${holder.id}`, { role: "ai_operator" });
  const ownerRestKey = secret();
  await asOwner("PATCH", `users/${access.ownerId}`, {
    enableAPIKey: true,
    apiKey: ownerRestKey,
  });
  const ownerJwt = (await page.context().cookies()).find(
    ({ name }) => name === "payload-token",
  )?.value;
  assert(ownerJwt);

  const aiKey = await makeKey(aiOperator, { toolProfile: "read" });
  const automationKey = await makeKey(automation, {
    "payload-mcp-tool": { editorialQuery: true, artvennUsersFind: true },
  });

  setStage("admin-mcp-official-client");
  const clientFor = async (value) => {
    const client = new Client({ name: "synthetic", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(endpoint), {
        requestInit: { headers: bearer(value) },
      }),
    );
    return client;
  };
  const listed = async (value) => {
    const client = await clientFor(value);
    try {
      return (await client.listTools()).tools.map(({ name }) => name).sort();
    } finally {
      await client.close();
    }
  };
  const replyOf = (result) => JSON.parse(result.content[0].text);

  const native = await clientFor(aiKey.secret);
  try {
    const { tools } = await native.listTools();
    assert.deepEqual(
      tools.map(({ name }) => name),
      ["admin_whoami"],
    );
    assert.deepEqual(tools[0].annotations, {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    assert.equal(tools[0].outputSchema.type, "object");
    const whoami = await native.callTool({ name: "admin_whoami" });
    assert.equal(whoami.isError, undefined);
    assert.equal(whoami.structuredContent.ok, true);
    assert.equal(whoami.structuredContent.data.path, "native");
    assert.equal(whoami.structuredContent.data.user.role, "ai_operator");
  } finally {
    await native.close();
  }

  const plugin = await clientFor(automationKey.secret);
  try {
    assert.deepEqual(
      (await plugin.listTools()).tools.map(({ name }) => name).sort(),
      ["admin_whoami", "artvenn_users_find", "editorial_query"],
    );
    const pluginWhoami = replyOf(
      await plugin.callTool({ name: "admin_whoami", arguments: {} }),
    ).data;
    assert.equal(pluginWhoami.path, "plugin");
    // Listed by the plugin, but this answer says what the key can call.
    assert.deepEqual(pluginWhoami.tools, ["editorial_query", "admin_whoami"]);
    assert.deepEqual(
      replyOf(
        await plugin.callTool({
          name: "artvenn_users_find",
          arguments: { page: 1, pageSize: 20 },
        }),
      ),
      { ok: false, code: "NOT_FOUND" },
    );
    assert.deepEqual(
      replyOf(
        await plugin.callTool({
          name: "editorial_query",
          arguments: { page: 1 },
        }),
      ).docs,
      [],
    );
  } finally {
    await plugin.close();
  }

  setStage("admin-mcp-native-protocol");
  const aiHeaders = bearer(aiKey.secret);
  const got = await globalThis.fetch(endpoint, {
    headers: { accept: ACCEPT, ...aiHeaders },
  });
  assert.equal(got.status, 405);
  assert.equal(got.headers.get("allow"), "POST");
  const batch = await post([rpc("ping"), rpc("ping")], aiHeaders);
  assert.equal(batch.status, 400);
  assert.equal((await batch.json()).error.code, -32600);
  assert.equal(
    (
      await post(rpc("ping"), {
        ...aiHeaders,
        origin: "https://invalid.example",
      })
    ).status,
    403,
  );
  assert.equal((await post(rpc("ping"), { ...aiHeaders, origin })).status, 200);
  assert.equal(
    (
      await post(rpc("tools/list"), {
        ...aiHeaders,
        "mcp-protocol-version": "2026-07-28",
      })
    ).status,
    400,
  );

  setStage("admin-mcp-one-path-spelling");
  // On a real Next route: it decodes the slug, so only here does %4D reach dispatch.
  for (const spelling of ["MCP", "Mcp", "globals/mcp", "%4Dcp"])
    for (const headers of [
      {},
      aiHeaders,
      bearer(automationKey.secret),
      bearer(secret()),
    ]) {
      const answer = await globalThis.fetch(`${origin}/api/${spelling}`, {
        method: "POST",
        redirect: "manual",
        headers: {
          accept: ACCEPT,
          "content-type": "application/json",
          ...headers,
        },
        body: JSON.stringify(rpc("tools/list")),
      });
      assert.equal(answer.status, 404, spelling);
    }
  const trailing = await globalThis.fetch(`${origin}/api/mcp/`, {
    method: "POST",
    redirect: "manual",
    headers: {
      accept: ACCEPT,
      "content-type": "application/json",
      ...aiHeaders,
    },
    body: JSON.stringify(rpc("tools/list")),
  });
  assert([308, 404].includes(trailing.status));
  assert.equal((await post(rpc("ping"), aiHeaders)).status, 200);

  setStage("admin-mcp-door-refusals");
  const refusal = async (headers) => {
    const response = await post(rpc("ping"), headers);
    assert.equal(response.status, 401);
    return (await response.json()).errors[0].message;
  };
  for (const key of [
    await makeKey(aiOperator, { expiresAt: past }),
    await makeKey(automation, { expiresAt: past }),
  ])
    assert.equal(await refusal(bearer(key.secret)), "KEY_EXPIRED");
  const binding = await account("binding", "automation");
  const ownerBound = await makeKey(binding);
  await asOwner("PATCH", `users/${binding.id}`, { role: "owner" });
  try {
    assert.equal(await refusal(bearer(ownerBound.secret)), "KEY_OWNER_BOUND");
  } finally {
    await asOwner("PATCH", `users/${binding.id}`, { role: "automation" });
  }
  const disabled = await makeKey(aiOperator);
  await asOwner("PATCH", `payload-mcp-api-keys/${disabled.id}`, {
    enableAPIKey: false,
  });
  const generic = await refusal({});
  assert.doesNotMatch(generic, /KEY_/u);
  for (const headers of [
    bearer(secret()),
    bearer(disabled.secret),
    bearer(ownerJwt),
    bearer(`artvenn_ct_${"a".repeat(43)}`),
    bearer(`artvenn_article_ct_${"a".repeat(43)}`),
  ])
    assert.equal(await refusal(headers), generic);

  setStage("admin-mcp-reserved-surfaces");
  const refused = [
    ["no credential", {}],
    ["MCP key", bearer(aiKey.secret)],
    ["automation MCP key", bearer(automationKey.secret)],
    [
      "MCP key as a REST key",
      { authorization: `payload-mcp-api-keys API-Key ${aiKey.secret}` },
    ],
    ["Owner REST key", { authorization: `users API-Key ${ownerRestKey}` }],
    [
      "automation REST key",
      { authorization: `users API-Key ${automationRestKey}` },
    ],
    ["ai_operator JWT", { authorization: `JWT ${aiJwt}` }],
    ["Authorization JWT", { authorization: `JWT ${ownerJwt}` }],
    ["Authorization Bearer", bearer(ownerJwt)],
    [
      "the Owner cookie beside an Authorization JWT",
      { cookie: `payload-token=${ownerJwt}`, authorization: `JWT ${ownerJwt}` },
    ],
  ];
  const surfaces = [
    ["GET", "payload-mcp-api-keys?limit=1"],
    ["POST", "payload-mcp-api-keys", { user: automation.id, label: "refused" }],
    ["POST", "payload-mcp-api-keys/refresh-token"],
    ["PATCH", `users/${automation.id}`, { agentPrincipal: "agent-refused" }],
    ["GET", "mcp-audit-events?limit=1"],
    ["POST", "mcp-audit-events", { callId: run }],
    ["GET", "globals/mcp-control"],
    ["POST", "globals/mcp-control", { pause: true }],
  ];
  for (const [label, headers] of refused) {
    for (const [method, route, body] of surfaces)
      assert.deepEqual(
        [
          label,
          method,
          route,
          (await call(method, route, headers, body)).status,
        ],
        [label, method, route, 403],
      );
    for (const path of [CONTROL, AUDIT]) {
      const html = await (
        await globalThis.fetch(`${origin}${path}`, {
          redirect: "manual",
          headers,
        })
      ).text();
      assert.doesNotMatch(html, /data-mcp-control/u, label);
      // A row of the ledger names this tool, and the whoami above wrote one.
      assert.doesNotMatch(html, /admin_whoami/u, label);
    }
  }
  // Every Owner credential still reads its own row, where the session is one of them.
  for (const headers of [
    { authorization: `users API-Key ${ownerRestKey}` },
    { authorization: `JWT ${ownerJwt}` },
    bearer(ownerJwt),
  ]) {
    const me = await call("GET", "users/me", headers);
    assert.equal(me.status, 200);
    assert.equal((await me.json()).user.id, access.ownerId);
  }

  setStage("admin-mcp-owner-session");
  await page.goto(`${origin}${CONTROL}`);
  await page.locator("[data-mcp-control]").waitFor({ state: "visible" });
  await expect(page.getByText("此工作区仅限 Owner")).toHaveCount(0);
  await page.goto(`${origin}${AUDIT}?where[tool][equals]=admin_whoami`);
  await expect(page.getByText("admin_whoami").first()).toBeVisible();
  for (const route of [
    "payload-mcp-api-keys?limit=1",
    "mcp-audit-events?limit=1",
    "globals/mcp-control",
    "users?limit=1",
  ])
    await asOwner("GET", route);
  assert.equal((await asOwner("GET", "users/me")).user.id, access.ownerId);
  // Shadowed for everyone, the Owner's session too: its own refresh is on users.
  const keyRefresh = await page.request.post(
    `${origin}/api/payload-mcp-api-keys/refresh-token`,
  );
  assert.equal(keyRefresh.status(), 403);
  assert.deepEqual(await keyRefresh.json(), { error: "RESERVED_SURFACE" });
  assert.equal(
    (await page.request.post(`${origin}/api/users/refresh-token`)).status(),
    200,
  );

  setStage("admin-mcp-owner-key-form");
  // The reserved surfaces rest on the render path passing the session's real
  // headers, and until now these three screens had only REST behind them.
  const formLabel = `synthetic-form-${run}`;
  await page.goto(`${origin}/admin/collections/payload-mcp-api-keys/create`);
  await page.locator('input[name="label"]').fill(formLabel);
  const userPicker = page.locator("#field-user").getByRole("combobox");
  await userPicker.click();
  await userPicker.fill(automation.email);
  await page
    .getByRole("option", { name: automation.email, exact: true })
    .click();
  const keySaved = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/payload-mcp-api-keys" &&
      response.request().method() === "POST",
  );
  await page.locator("#action-save").click();
  const savedKey = await keySaved;
  assert.equal(savedKey.status(), 201);
  const { doc: formKey } = await savedKey.json();
  assert.equal(formKey.label, formLabel);
  assert.equal(formKey.user.id ?? formKey.user, automation.id);
  await page.waitForURL(
    (url) =>
      url.pathname === `/admin/collections/payload-mcp-api-keys/${formKey.id}`,
  );

  setStage("admin-mcp-owner-account-screens");
  // Another account's row: only the Owner's session reads past its own.
  await page.goto(
    `${origin}/admin/collections/users?where[email][equals]=${encodeURIComponent(automation.email)}`,
  );
  await expect(page.getByText(automation.email).first()).toBeVisible();
  await page.goto(`${origin}/admin/account`);
  await expect(page.locator('input[name="email"]')).toHaveValue(
    access.ownerEmail,
  );

  setStage("admin-mcp-page-loaded-first");
  // This session opened an Admin page before any route, the order a production
  // build's error classes are hardest on: see `namedRefusal` in the key door.
  const noPhrase = await page.request.post(
    `${origin}/api/globals/mcp-control`,
    { data: { dm: true } },
  );
  assert.equal(noPhrase.status(), 400);
  assert.equal(
    (await noPhrase.json()).errors[0].message,
    "COMPLIANCE_CONFIRMATION_REQUIRED",
  );
  const asAiRow = (attempt) =>
    call("POST", "users/login", undefined, {
      email: aiOperator.email,
      password: attempt,
    });
  const rightPassword = await asAiRow(password);
  const wrongPassword = await asAiRow(`${password}x`);
  assert.equal(rightPassword.status, 401);
  assert.equal(wrongPassword.status, 401);
  assert.deepEqual(await rightPassword.json(), await wrongPassword.json());

  setStage("admin-mcp-editorial-answers");
  // Still page first. The editorial path tells Payload's own refusals apart by
  // class and answers its codes on a native route too, so section 10's answers are
  // held here, where only a production compile can break them.
  const catalogId = `mcp-browser-${run}`;
  const restKey = { authorization: `users API-Key ${automationRestKey}` };
  const editorial = async (operation, body) => {
    const response = await call(
      "POST",
      `editorial/${operation}`,
      restKey,
      body,
    );
    return [response.status, await response.json()];
  };
  const refusedWith = (status, code) => [
    status,
    { ok: false, error: { code, fields: [] } },
  ];
  const content = {
    catalogId,
    sourceId: `source-${run}`,
    kind: "calligraphy",
    title: "Synthetic record",
    summary: "Synthetic summary",
    dynasty: { state: "UNSUPPLIED" },
    dateText: { state: "UNSUPPLIED" },
    province: { state: "UNSUPPLIED" },
    prefecture: { state: "UNSUPPLIED" },
    county: { state: "UNSUPPLIED" },
    currentLocation: { state: "UNSUPPLIED" },
    currentCustodian: { state: "UNSUPPLIED" },
    description: { state: "UNSUPPLIED" },
    scriptStyle: { state: "UNSUPPLIED" },
    transcription: { state: "VALUE", value: "合成" },
    historicalContext: { state: "UNSUPPLIED" },
    scholarlyResearch: { state: "UNSUPPLIED" },
    aliases: [],
    provenance: [],
    sourceCitations: [],
    contributors: [],
    media: [],
  };
  const [createdStatus, created] = await editorial("save-draft", {
    idempotencyKey: `${run}:create`,
    content,
  });
  assert.equal(createdStatus, 200);
  const { id: documentId, revision } = created.result;
  const editorKey = await makeKey(automation, {
    "payload-mcp-tool": {
      editorialRead: true,
      editorialSaveDraft: true,
      editorialPublishApproved: true,
    },
  });
  const editor = await clientFor(editorKey.secret);
  try {
    const tool = async (name, args) =>
      replyOf(await editor.callTool({ name, arguments: args }));
    const edit = {
      id: documentId,
      expectedRevision: revision,
      idempotencyKey: `${run}:edit`,
      content: { ...content, title: "Edited after the lock" },
    };
    const { doc: lock } = await asOwner("POST", "payload-locked-documents", {
      document: { relationTo: "catalogs", value: documentId },
      user: { relationTo: "users", value: access.ownerId },
    });
    assert.deepEqual(
      await editorial("save-draft", edit),
      refusedWith(423, "DOCUMENT_LOCKED"),
    );
    assert.deepEqual(await tool("editorial_save_draft", edit), {
      ok: false,
      code: "DOCUMENT_LOCKED",
    });
    await asOwner("DELETE", `payload-locked-documents/${lock.id}`);
    // The same key: neither refusal above left a receipt behind.
    assert.equal(
      (await tool("editorial_save_draft", edit)).revision,
      revision + 1,
    );
    const nothing = 2_000_000_000;
    assert.deepEqual(
      await editorial("read-draft", { id: nothing }),
      refusedWith(404, "RECORD_UNAVAILABLE"),
    );
    assert.deepEqual(await tool("editorial_read", { id: nothing }), {
      ok: false,
      code: "RECORD_UNAVAILABLE",
    });
    assert.deepEqual(
      await tool("editorial_publish_approved", {
        approvalId: nothing,
        id: documentId,
        idempotencyKey: `${run}:no-approval`,
      }),
      { ok: false, code: "RECORD_UNAVAILABLE" },
    );
  } finally {
    await editor.close();
  }
  const { result: approved } = await asOwner(
    "POST",
    "editorial/approve-batch",
    {
      automationUserId: automation.id,
      items: [{ id: documentId, revision: revision + 1 }],
    },
  );
  const copied = await page.request.post(
    `${origin}/api/editorial-approvals/${approved.approvalId}/duplicate`,
    { data: {} },
  );
  assert.equal(copied.status(), 403);
  assert.equal(
    (await copied.json()).errors[0].message,
    "APPROVAL_DUPLICATE_DISABLED",
  );

  setStage("admin-mcp-control-page-gate");
  for (const options of [{}, { extraHTTPHeaders: bearer(aiKey.secret) }]) {
    const context = await browser.newContext(options);
    try {
      const outsider = await context.newPage();
      outsider.setDefaultTimeout(20_000);
      await outsider.goto(`${origin}${CONTROL}`);
      await outsider
        .getByRole("alert")
        .filter({ hasText: "此工作区仅限 Owner" })
        .waitFor({ state: "visible" });
      await expect(outsider.locator("[data-mcp-control]")).toHaveCount(0);
      await outsider.goto(`${origin}${AUDIT}`);
      await outsider.waitForURL((url) => url.pathname === "/admin/login");
    } finally {
      await context.close();
    }
  }

  setStage("admin-mcp-pause");
  await asOwner("POST", "globals/mcp-control", { pause: true });
  try {
    assert.deepEqual(await listed(aiKey.secret), ["admin_whoami"]);
    assert.deepEqual(await listed(automationKey.secret), ["admin_whoami"]);
    const stopped = await clientFor(automationKey.secret);
    try {
      assert.equal(
        replyOf(await stopped.callTool({ name: "admin_whoami", arguments: {} }))
          .data.paused,
        true,
      );
      assert.equal(
        (
          await stopped.callTool({
            name: "editorial_query",
            arguments: { page: 1 },
          })
        ).isError,
        true,
      );
    } finally {
      await stopped.close();
    }
    // The Owner Admin and a REST key are the pause's two named exceptions.
    await page.goto(`${origin}${CONTROL}`);
    await page.locator('[data-mcp-pause="true"]').waitFor({ state: "visible" });
    assert.equal(
      (
        await call("GET", "catalogs?limit=1", {
          authorization: `users API-Key ${automationRestKey}`,
        })
      ).status,
      200,
    );
  } finally {
    await asOwner("POST", "globals/mcp-control", { pause: false });
  }
  assert.deepEqual(await listed(automationKey.secret), [
    "admin_whoami",
    "artvenn_users_find",
    "editorial_query",
  ]);

  setStage("admin-mcp-development-surfaces-absent");
  // Composition is the gate: absent from this build for the Owner too.
  for (const route of ["agent-connections", "agent-connections/start"]) {
    const response = await page.request.fetch(`${origin}/api/${route}`, {
      method: route === "agent-connections" ? "GET" : "POST",
    });
    assert.equal(response.status(), 404, route);
  }
};
