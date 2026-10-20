import { Buffer } from "node:buffer";
import process from "node:process";
import console from "node:console";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import {
  AnalyticsToolError,
  UMAMI_BASE_PATH,
  UMAMI_SOURCE_COMMIT,
  UMAMI_VERSION,
  boundedText,
  readPrivateConfig,
  requireSetting,
  umamiOrigin,
  uuid,
  validateEnvironment,
} from "./common.mjs";

const names = {
  team: "ArtVenn Analytics",
  funnel: "ArtVenn: 曝光 → 打开 → 收藏",
  board: "ArtVenn: 内容行为与地域",
};

function funnelEvents(environment) {
  let events;
  try {
    events = JSON.parse(
      environment.UMAMI_FUNNEL_EVENTS_JSON ??
        '["content_impression","content_open","favorite"]',
    );
  } catch {
    throw new AnalyticsToolError("FUNNEL_EVENTS_INVALID");
  }
  if (!Array.isArray(events) || events.length !== 3)
    throw new AnalyticsToolError("FUNNEL_EVENTS_INVALID");
  return events.map((event) => boundedText(event, 50));
}

export function bootstrapPlan(environment, selected) {
  validateEnvironment(environment, selected);
  const origin = umamiOrigin(requireSetting(environment, "UMAMI_ORIGIN"));
  const websiteId = uuid(requireSetting(environment, "UMAMI_WEBSITE_ID"));
  const domain = requireSetting(environment, "UMAMI_WEBSITE_DOMAIN");
  if (
    domain.length > 253 ||
    !/^(localhost(?::[1-9]\d{0,4})?|[a-z0-9.-]+\.[a-z]{2,63})$/iu.test(domain)
  )
    throw new AnalyticsToolError("WEBSITE_DOMAIN_INVALID");
  return {
    origin,
    websiteId,
    domain,
    websiteName: boundedText(environment.UMAMI_WEBSITE_NAME ?? "ArtVenn", 100),
    teamName: boundedText(environment.UMAMI_TEAM_NAME ?? names.team, 50),
    events: funnelEvents(environment),
  };
}

/** Native Board parameters, pinned to v3.4.0's boardComponentRegistry. */
export function boardParameters(websiteId, funnelId) {
  const column = (id, type, props = {}) => ({
    id,
    size: 1,
    component: { type, props },
  });
  return {
    websiteId,
    rows: [
      {
        id: "summary",
        size: 1,
        columns: [column("metrics", "WebsiteMetricsBar")],
      },
      { id: "trend", size: 2, columns: [column("visitors", "WebsiteChart")] },
      {
        id: "geography",
        size: 2,
        columns: [
          column("map", "WorldMap"),
          column("countries", "MetricsTable", { type: "country", limit: 10 }),
        ],
      },
      {
        id: "regions",
        size: 2,
        columns: [
          column("region", "MetricsTable", { type: "region", limit: 10 }),
          column("city", "MetricsTable", { type: "city", limit: 10 }),
        ],
      },
      {
        id: "events",
        size: 2,
        columns: [column("events-chart", "EventsChart")],
      },
      {
        id: "conversion",
        size: 2,
        columns: [column("funnel", "Funnel", { reportId: funnelId })],
      },
    ],
  };
}

/** Bounded, non-logging client. A redirect must never carry the bearer elsewhere. */
export function createUmamiClient(
  origin,
  fetchImpl = globalThis.fetch,
  deadline = Date.now() + 120000,
) {
  let token;
  const request = async (method, endpoint, body, optional404 = false) => {
    if (!/^\/[a-zA-Z0-9/?=&_-]+$/u.test(endpoint))
      throw new AnalyticsToolError("UMAMI_ENDPOINT_INVALID");
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new AnalyticsToolError("BOOTSTRAP_DEADLINE");
    let response;
    try {
      response = await fetchImpl(`${origin}${UMAMI_BASE_PATH}/api${endpoint}`, {
        method,
        redirect: "error",
        signal: globalThis.AbortSignal.timeout(Math.min(10000, remaining)),
        headers: {
          Accept: "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new AnalyticsToolError("UMAMI_REQUEST_FAILED");
    }
    if (optional404 && response.status === 404) return null;
    if (!response.ok)
      throw new AnalyticsToolError(`UMAMI_HTTP_${response.status}`);
    const reader = response.body?.getReader();
    let bytes = 0;
    const chunks = [];
    if (!reader) throw new AnalyticsToolError("UMAMI_RESPONSE_INVALID");
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 1048576) {
        await reader.cancel();
        throw new AnalyticsToolError("UMAMI_RESPONSE_LIMIT");
      }
      chunks.push(Buffer.from(part.value));
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new AnalyticsToolError("UMAMI_RESPONSE_INVALID");
    }
  };
  return {
    request,
    async login(username, password) {
      const result = await request("POST", "/auth/login", {
        username,
        password,
      });
      if (
        result.requiresTwoFactor ||
        typeof result.token !== "string" ||
        !result.user
      )
        throw new AnalyticsToolError("BOOTSTRAP_ACCOUNT_REQUIRES_SESSION");
      token = result.token;
      return result.user;
    },
    async list(endpoint) {
      const items = [];
      for (let page = 1; page <= 20; page++) {
        const result = await request(
          "GET",
          `${endpoint}${endpoint.includes("?") ? "&" : "?"}page=${page}&pageSize=100`,
        );
        if (!Array.isArray(result.data) || !Number.isSafeInteger(result.count))
          throw new AnalyticsToolError("UMAMI_PAGING_INVALID");
        items.push(...result.data);
        if (items.length >= result.count) return items;
        if (result.data.length === 0) break;
      }
      throw new AnalyticsToolError("UMAMI_PAGING_LIMIT");
    },
  };
}

function named(items, predicate) {
  const matches = items.filter(predicate);
  if (matches.length > 1)
    throw new AnalyticsToolError("UMAMI_CONFIGURATION_AMBIGUOUS");
  return matches[0];
}

export async function bootstrapUmami(environment, selected, options = {}) {
  const plan = bootstrapPlan(environment, selected);
  if (!options.execute)
    return {
      ok: true,
      status: "PLAN_ONLY",
      version: UMAMI_VERSION,
      websiteId: plan.websiteId,
    };
  // Validate all configuration before the first mutation.
  const adminUsername = requireSetting(environment, "UMAMI_BOOTSTRAP_USERNAME");
  const adminPassword =
    environment.UMAMI_BOOTSTRAP_NEW_PASSWORD ??
    requireSetting(environment, "UMAMI_BOOTSTRAP_PASSWORD");
  const username = boundedText(
    requireSetting(environment, "UMAMI_VIEWER_USERNAME"),
    255,
  ).toLowerCase();
  const password = requireSetting(environment, "UMAMI_VIEWER_PASSWORD");
  if (password.length < 16 || password.length > 255)
    throw new AnalyticsToolError("VIEWER_PASSWORD_LENGTH");
  const deadline = Date.now() + 120000;
  const api = createUmamiClient(plan.origin, options.fetchImpl, deadline);
  const privileged = await api.login(adminUsername, adminPassword);
  if (privileged.role !== "admin" || privileged.isAdmin !== true)
    throw new AnalyticsToolError("BOOTSTRAP_ADMIN_REQUIRED");

  let team = named(
    await api.list("/teams"),
    (item) => item.name === plan.teamName,
  );
  if (!team) {
    // v3.4.0 returns Prisma's transaction tuple [Team, TeamUser].
    const created = await api.request("POST", "/teams", {
      name: plan.teamName,
    });
    if (!Array.isArray(created) || created.length !== 2)
      throw new AnalyticsToolError("UMAMI_TEAM_RESPONSE_INVALID");
    [team] = created;
  }
  const teamId = uuid(team.id);

  let viewer = named(
    await api.list("/admin/users"),
    (item) => item.username === username,
  );
  if (!viewer)
    viewer = await api.request("POST", "/users", {
      id: randomUUID(),
      username,
      password,
      role: "view-only",
    });
  if (viewer.role !== "view-only" || viewer.id === privileged.id)
    throw new AnalyticsToolError("VIEWER_MUST_BE_NON_ADMIN_READ_ONLY");
  const viewerId = uuid(viewer.id);
  const membership = named(
    await api.list(`/teams/${teamId}/users`),
    (item) => item.userId === viewerId || item.user?.id === viewerId,
  );
  if (membership && membership.role !== "team-view-only")
    throw new AnalyticsToolError("VIEWER_TEAM_ROLE_MISMATCH");
  if (!membership)
    await api.request("POST", `/teams/${teamId}/users`, {
      userId: viewerId,
      role: "team-view-only",
    });

  // A missing website can answer 401 at its permission check, not 404.
  // Inspect the privileged list instead of interpreting 401 as "missing".
  let website = named(
    await api.list("/admin/websites"),
    (item) => item.id === plan.websiteId,
  );
  if (!website)
    website = await api.request("POST", "/websites", {
      id: plan.websiteId,
      name: plan.websiteName,
      domain: plan.domain,
      teamId,
      shareId: null,
    });
  if (
    website.id !== plan.websiteId ||
    website.teamId !== teamId ||
    website.domain !== plan.domain ||
    website.shareId
  )
    throw new AnalyticsToolError("WEBSITE_CONFIGURATION_MISMATCH");

  const expectedFunnel = {
    window: 60,
    steps: plan.events.map((value) => ({ type: "event", value })),
  };
  let funnel = named(
    await api.list(`/websites/${plan.websiteId}/funnels`),
    (item) => item.name === names.funnel,
  );
  if (!funnel)
    funnel = await api.request("POST", `/websites/${plan.websiteId}/funnels`, {
      name: names.funnel,
      description:
        "同一访问中的曝光、打开与收藏；按事件计数，不能解释为同一内容的因果转化。",
      parameters: expectedFunnel,
    });
  if (!isDeepStrictEqual(funnel.parameters, expectedFunnel))
    throw new AnalyticsToolError("FUNNEL_CONFIGURATION_MISMATCH");
  const funnelId = uuid(funnel.id);

  const parameters = boardParameters(plan.websiteId, funnelId);
  let board = named(
    await api.list(`/teams/${teamId}/boards`),
    (item) => item.name === names.board,
  );
  if (!board)
    board = await api.request("POST", "/boards", {
      type: "website",
      name: names.board,
      description:
        "Umami 原生内容行为与近似地域看板；Owner、测试与开发活动在采集前排除。",
      teamId,
      parameters,
    });
  if (
    board.type !== "website" ||
    !isDeepStrictEqual(board.parameters, parameters)
  )
    throw new AnalyticsToolError("BOARD_CONFIGURATION_MISMATCH");
  const boardId = uuid(board.id);

  const readOnly = createUmamiClient(plan.origin, options.fetchImpl, deadline);
  const identified = await readOnly.login(username, password);
  if (
    identified.id !== viewerId ||
    identified.isAdmin ||
    identified.role !== "view-only"
  )
    throw new AnalyticsToolError("VIEWER_VERIFICATION_FAILED");
  await readOnly.request("POST", "/auth/verify", {});
  await readOnly.request("GET", `/websites/${plan.websiteId}`);
  await readOnly.request("GET", `/boards/${boardId}`);
  const until = Date.now();
  await readOnly.request(
    "GET",
    `/websites/${plan.websiteId}/retention?startAt=${until - 86400000}&endAt=${until}&timezone=UTC`,
  );
  return {
    ok: true,
    status: "CONFIGURED",
    version: UMAMI_VERSION,
    sourceCommit: UMAMI_SOURCE_COMMIT,
    websiteId: plan.websiteId,
    teamId,
    viewerId,
    funnelId,
    boardId,
    retention: "NATIVE_READ_VERIFIED",
    sharing: "NOT_CREATED",
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const { values } = parseArgs({
      options: {
        config: { type: "string" },
        environment: { type: "string" },
        execute: { type: "boolean", default: false },
      },
      allowPositionals: false,
    });
    const environment = await readPrivateConfig(
      values.config,
      values.environment,
    );
    console.info(
      JSON.stringify(
        await bootstrapUmami(environment, values.environment, {
          execute: values.execute,
        }),
      ),
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        ok: false,
        code:
          error instanceof AnalyticsToolError
            ? error.code
            : "UMAMI_BOOTSTRAP_FAILED",
      }),
    );
    process.exitCode = 1;
  }
}
