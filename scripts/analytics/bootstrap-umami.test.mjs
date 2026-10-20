import { URL } from "node:url";
import assert from "node:assert/strict";
import { mkdtemp, chmod, rm, writeFile, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  bootstrapPlan,
  bootstrapUmami,
  createUmamiClient,
} from "./bootstrap-umami.mjs";
import { readPrivateConfig, UMAMI_BASE_PATH } from "./common.mjs";

// Reviewed synthetic fixture identities and passwords, never real credentials.
const ids = {
  admin: "10000000-0000-4000-8000-000000000001",
  viewer: "10000000-0000-4000-8000-000000000002",
  team: "10000000-0000-4000-8000-000000000003",
  website: "10000000-0000-4000-8000-000000000004",
  funnel: "10000000-0000-4000-8000-000000000005",
  board: "10000000-0000-4000-8000-000000000006",
};
// Reviewed mock authorization; the token is an explicit non-live placeholder.
const syntheticAuthorization1 = `Bearer ${"REPLACE_ME_SYNTHETIC_88136879BCDB"}`;
const syntheticAuthorization2 = `Bearer ${"REPLACE_ME_SYNTHETIC_80673B50603F"}`;

const environment = {
  ANALYTICS_TASK_ENV: "synthetic",
  UMAMI_ORIGIN: "http://127.0.0.1:3010",
  UMAMI_WEBSITE_ID: ids.website,
  UMAMI_WEBSITE_DOMAIN: "synthetic.example.invalid",
  UMAMI_BOOTSTRAP_USERNAME: "synthetic-admin",
  UMAMI_BOOTSTRAP_PASSWORD: "synthetic-bootstrap-not-valid",
  UMAMI_VIEWER_USERNAME: "synthetic-viewer",
  UMAMI_VIEWER_PASSWORD: "synthetic-viewer-not-valid",
};

function fakeUmami() {
  const state = {
    teams: [],
    users: [],
    websites: [],
    memberships: [],
    funnels: [],
    boards: [],
    calls: [],
  };
  const page = (data) => ({ data, count: data.length, page: 1, pageSize: 100 });
  const fetchImpl = async (input, options) => {
    const url = new URL(input);
    assert.equal(url.origin, environment.UMAMI_ORIGIN);
    assert.ok(url.pathname.startsWith(`${UMAMI_BASE_PATH}/api/`));
    assert.equal(options.redirect, "error");
    const route = url.pathname.slice(`${UMAMI_BASE_PATH}/api`.length);
    const body = options.body ? JSON.parse(options.body) : undefined;
    const method = options.method;
    state.calls.push([method, route]);
    const response = (data) => globalThis.Response.json(data);
    if (route === "/auth/login") {
      const isAdmin = body.username === environment.UMAMI_BOOTSTRAP_USERNAME;
      assert.equal(
        body.password,
        isAdmin
          ? environment.UMAMI_BOOTSTRAP_PASSWORD
          : environment.UMAMI_VIEWER_PASSWORD,
      );
      return response({
        token: isAdmin
          ? "REPLACE_ME_SYNTHETIC_88136879BCDB"
          : "REPLACE_ME_SYNTHETIC_80673B50603F",
        user: isAdmin
          ? { id: ids.admin, role: "admin", isAdmin: true }
          : { ...state.users[0], isAdmin: false },
      });
    }
    const privileged =
      options.headers.Authorization === syntheticAuthorization1;
    assert.ok(
      privileged || options.headers.Authorization === syntheticAuthorization2,
    );
    if (route === "/teams" && method === "GET")
      return response(page(state.teams));
    if (route === "/teams" && method === "POST") {
      const team = { id: ids.team, ...body };
      state.teams.push(team);
      return response([
        team,
        { teamId: ids.team, userId: ids.admin, role: "team-owner" },
      ]);
    }
    if (route === "/admin/users") return response(page(state.users));
    if (route === "/users" && method === "POST") {
      const user = { id: ids.viewer, username: body.username, role: body.role };
      state.users.push(user);
      return response(user);
    }
    if (route === `/teams/${ids.team}/users`) {
      if (method === "GET") return response(page(state.memberships));
      state.memberships.push(body);
      return response(body);
    }
    if (route === "/admin/websites") return response(page(state.websites));
    if (route === "/websites" && method === "POST") {
      assert.equal(body.shareId, null);
      state.websites.push(body);
      return response(body);
    }
    if (route === `/websites/${ids.website}/funnels`) {
      if (method === "GET") return response(page(state.funnels));
      const funnel = { id: ids.funnel, ...body };
      state.funnels.push(funnel);
      return response(funnel);
    }
    if (route === `/teams/${ids.team}/boards`)
      return response(page(state.boards));
    if (route === "/boards" && method === "POST") {
      const board = { id: ids.board, ...body };
      state.boards.push(board);
      return response(board);
    }
    assert.equal(privileged, false);
    assert.ok(["GET", "POST"].includes(method));
    if (route === "/auth/verify")
      return response({ id: ids.viewer, role: "view-only" });
    if (route === `/websites/${ids.website}`)
      return response(state.websites[0]);
    if (route === `/boards/${ids.board}`) return response(state.boards[0]);
    if (route === `/websites/${ids.website}/retention`) return response([]);
    assert.fail("Unexpected native API request");
  };
  return { state, fetchImpl };
}

test("plan is offline and refuses implicit environment, public origins and invalid identities", async () => {
  assert.equal(
    (await bootstrapUmami(environment, "synthetic")).status,
    "PLAN_ONLY",
  );
  assert.throws(
    () => bootstrapPlan(environment, "production"),
    /EXPLICIT_ENVIRONMENT/,
  );
  for (const origin of [
    "https://analytics.example.invalid",
    "http://user:synthetic@127.0.0.1:3010",
    "http://127.0.0.1:3010/other",
  ]) {
    assert.throws(() =>
      bootstrapPlan({ ...environment, UMAMI_ORIGIN: origin }, "synthetic"),
    );
  }
  assert.throws(() =>
    bootstrapPlan(
      { ...environment, UMAMI_WEBSITE_ID: "not-an-id" },
      "synthetic",
    ),
  );
});

test("native website, team-view-only membership, saved funnel and Board bootstrap is idempotent", async () => {
  const { state, fetchImpl } = fakeUmami();
  const first = await bootstrapUmami(environment, "synthetic", {
    execute: true,
    fetchImpl,
  });
  assert.equal(first.status, "CONFIGURED");
  assert.equal(first.retention, "NATIVE_READ_VERIFIED");
  assert.equal(state.users[0].role, "view-only");
  assert.equal(state.memberships[0].role, "team-view-only");
  assert.deepEqual(
    state.funnels[0].parameters.steps.map((step) => step.value),
    ["content_impression", "content_open", "favorite"],
  );
  const rows = state.boards[0].parameters.rows;
  const components = rows.flatMap((row) =>
    row.columns.map((column) => column.component),
  );
  assert.equal(
    components.some((component) => component.type === "WorldMap"),
    false,
  );
  assert.equal(rows[1].id, "regions");
  const regions = rows[1].columns.map((column) => column.component);
  assert.deepEqual(
    regions.map((component) => component.props.type),
    ["region", "city"],
  );
  assert.ok(
    regions.every((component) => component.props.metric === "去重访客"),
  );
  assert.equal(regions[0].title, "省份 / 地区");
  assert.equal(regions[1].title, "城市");
  const serialized = JSON.stringify(first);
  for (const forbidden of [
    "password",
    "synthetic-viewer",
    "REPLACE_ME_SYNTHETIC_88136879BCDB",
    "Bearer",
  ])
    assert.ok(!serialized.includes(forbidden));
  const previousCalls = state.calls.length;
  // PostgreSQL jsonb object key ordering must not cause a false mismatch.
  state.funnels[0].parameters = {
    steps: state.funnels[0].parameters.steps,
    window: 60,
  };
  const second = await bootstrapUmami(environment, "synthetic", {
    execute: true,
    fetchImpl,
  });
  assert.deepEqual(second, first);
  assert.equal(
    state.calls
      .slice(previousCalls)
      .filter(
        ([method, route]) => method === "POST" && !route.startsWith("/auth/"),
      ).length,
    0,
  );
});

test("existing privileged viewer or altered native definition fails without changing it", async () => {
  const { state, fetchImpl } = fakeUmami();
  await bootstrapUmami(environment, "synthetic", { execute: true, fetchImpl });
  state.users[0].role = "admin";
  await assert.rejects(
    bootstrapUmami(environment, "synthetic", { execute: true, fetchImpl }),
    /VIEWER_MUST_BE_NON_ADMIN/,
  );
  state.users[0].role = "view-only";
  state.funnels[0].parameters.window = 90;
  await assert.rejects(
    bootstrapUmami(environment, "synthetic", { execute: true, fetchImpl }),
    /FUNNEL_CONFIGURATION_MISMATCH/,
  );
  assert.equal(state.funnels[0].parameters.window, 90);
});

test("upstream bodies and transport errors never become output error text", async () => {
  const api = createUmamiClient(environment.UMAMI_ORIGIN, async () =>
    globalThis.Response.json(
      { password: "synthetic-sensitive-response" },
      { status: 500 },
    ),
  );
  await assert.rejects(api.request("GET", "/config"), {
    message: "UMAMI_HTTP_500",
  });
  const failing = createUmamiClient(environment.UMAMI_ORIGIN, async () => {
    throw new Error("synthetic-private-address-and-token");
  });
  await assert.rejects(failing.request("GET", "/config"), {
    message: "UMAMI_REQUEST_FAILED",
  });
  const oversized = createUmamiClient(
    environment.UMAMI_ORIGIN,
    async () => new globalThis.Response("x".repeat(1048577)),
  );
  await assert.rejects(
    oversized.request("GET", "/config"),
    /UMAMI_RESPONSE_LIMIT/,
  );
});

test("private configuration is explicit, mode-restricted and refuses symlinks", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "umami-tool-test-"));
  try {
    const filename = path.join(directory, "synthetic.env");
    await writeFile(filename, "ANALYTICS_TASK_ENV=synthetic\n", {
      mode: 0o600,
    });
    assert.equal(
      (await readPrivateConfig(filename, "synthetic")).ANALYTICS_TASK_ENV,
      "synthetic",
    );
    await assert.rejects(
      readPrivateConfig(filename, "production"),
      /EXPLICIT_ENVIRONMENT/,
    );
    await chmod(filename, 0o644);
    await assert.rejects(
      readPrivateConfig(filename, "synthetic"),
      /PRIVATE_CONFIG_PERMISSIONS/,
    );
    await chmod(filename, 0o600);
    const link = path.join(directory, "link.env");
    await symlink(filename, link);
    await assert.rejects(
      readPrivateConfig(link, "synthetic"),
      /PRIVATE_CONFIG_PERMISSIONS/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
