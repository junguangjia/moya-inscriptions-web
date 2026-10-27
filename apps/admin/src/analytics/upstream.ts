import { UMAMI_WORKSPACE_PATH } from "./config";

type Environment = Readonly<Record<string, string | undefined>>;

/** All authentication material remains in this server-only client. */
export const createUmamiUpstream = (
  environment: Environment = process.env,
  fetcher: typeof fetch = fetch,
  now: () => number = Date.now,
) => {
  let cached: { token: string; until: number } | undefined;
  let loggingIn: Promise<string> | undefined;

  const origin = (): URL => {
    let value: URL;
    try {
      value = new URL(environment.UMAMI_ORIGIN ?? "");
    } catch {
      throw new Error("ANALYTICS_NOT_CONFIGURED");
    }
    if (
      !["http:", "https:"].includes(value.protocol) ||
      !["127.0.0.1", "[::1]", "localhost"].includes(value.hostname) ||
      value.username ||
      value.password ||
      value.pathname !== "/" ||
      value.search ||
      value.hash
    )
      throw new Error("ANALYTICS_NOT_CONFIGURED");
    return value;
  };

  const login = async (): Promise<string> => {
    if (cached && cached.until > now()) return cached.token;
    if (loggingIn) return loggingIn;
    loggingIn = (async () => {
      const username = environment.UMAMI_VIEWER_USERNAME;
      const password = environment.UMAMI_VIEWER_PASSWORD;
      if (!username || !password) throw new Error("ANALYTICS_NOT_CONFIGURED");
      const response = await fetcher(
        new URL(`${UMAMI_WORKSPACE_PATH}/api/auth/login`, origin()),
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ username, password }),
          cache: "no-store",
          redirect: "error",
          signal: AbortSignal.timeout(5_000),
        },
      );
      if (!response.ok) throw new Error("ANALYTICS_UNAVAILABLE");
      const result: unknown = await response.json();
      if (
        typeof result !== "object" ||
        result === null ||
        !("token" in result) ||
        typeof result.token !== "string" ||
        result.token.length < 16 ||
        result.token.length > 8_192
      )
        throw new Error("ANALYTICS_UNAVAILABLE");
      cached = { token: result.token, until: now() + 10 * 60_000 };
      return result.token;
    })();
    try {
      return await loggingIn;
    } finally {
      loggingIn = undefined;
    }
  };

  return {
    origin,
    async request(path: string, init: RequestInit): Promise<Response> {
      const url = new URL(path, origin());
      const perform = async () => {
        const headers = new Headers(init.headers);
        headers.set("authorization", `Bearer ${await login()}`);
        return fetcher(url, {
          ...init,
          headers,
          cache: "no-store",
          redirect: "manual",
          signal: init.signal
            ? AbortSignal.any([init.signal, AbortSignal.timeout(15_000)])
            : AbortSignal.timeout(15_000),
        });
      };
      let response = await perform();
      if (response.status === 401) {
        await response.body?.cancel();
        cached = undefined;
        response = await perform();
      }
      return response;
    },
  };
};

export const umamiUpstream = createUmamiUpstream();

/** Enter the configured website in its real team scope, never an empty personal list. */
export async function resolveAnalyticsWorkspacePath(
  reader: Pick<typeof umamiUpstream, "request"> = umamiUpstream,
): Promise<string | null> {
  const websiteId = process.env.UMAMI_WEBSITE_ID ?? "";
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
      websiteId,
    ) ||
    !process.env.UMAMI_ORIGIN ||
    !process.env.UMAMI_VIEWER_USERNAME ||
    !process.env.UMAMI_VIEWER_PASSWORD
  )
    return null;
  const response = await reader.request(
    `${UMAMI_WORKSPACE_PATH}/api/websites/${websiteId}`,
    {
      method: "GET",
      headers: { accept: "application/json" },
    },
  );
  if (!response.ok) throw new Error("ANALYTICS_UNAVAILABLE");
  const website: unknown = await response.json();
  if (
    !website ||
    typeof website !== "object" ||
    !("id" in website) ||
    typeof website.id !== "string" ||
    website.id.toLowerCase() !== websiteId.toLowerCase()
  )
    throw new Error("ANALYTICS_UNAVAILABLE");
  const teamId = "teamId" in website ? website.teamId : null;
  if (
    typeof teamId === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
      teamId,
    )
  )
    return `${UMAMI_WORKSPACE_PATH}/teams/${teamId}/websites/${websiteId}`;
  return `${UMAMI_WORKSPACE_PATH}/websites/${websiteId}`;
}

/** Retain the existing configured Board as an additional analysis view. */
export async function resolveAnalyticsBoardPath(
  reader: Pick<typeof umamiUpstream, "request"> = umamiUpstream,
): Promise<string | null> {
  const boardId = process.env.UMAMI_BOARD_ID ?? "";
  const isId = (value: unknown): value is string =>
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
      value,
    );
  if (
    !isId(boardId) ||
    !process.env.UMAMI_ORIGIN ||
    !process.env.UMAMI_VIEWER_USERNAME ||
    !process.env.UMAMI_VIEWER_PASSWORD
  )
    return null;
  const response = await reader.request(
    `${UMAMI_WORKSPACE_PATH}/api/boards/${boardId}`,
    { method: "GET", headers: { accept: "application/json" } },
  );
  if (!response.ok) throw new Error("ANALYTICS_UNAVAILABLE");
  const board: unknown = await response.json();
  if (
    !board ||
    typeof board !== "object" ||
    !("id" in board) ||
    typeof board.id !== "string" ||
    board.id.toLowerCase() !== boardId.toLowerCase()
  )
    throw new Error("ANALYTICS_UNAVAILABLE");
  const teamId = "teamId" in board ? board.teamId : null;
  return isId(teamId)
    ? `${UMAMI_WORKSPACE_PATH}/teams/${teamId}/boards/${boardId}`
    : `${UMAMI_WORKSPACE_PATH}/boards/${boardId}`;
}
