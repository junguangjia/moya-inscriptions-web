import { UMAMI_WORKSPACE_PATH } from "./config";
import { umamiUpstream } from "./upstream";

const privateHeaders = {
  "cache-control": "private, no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

const failure = (status: number, message: string) =>
  new Response(message, { status, headers: privateHeaders });

// Only build-addressed files may be reused by this browser. Never cache native
// documents, RSC, configuration, geography data or private API responses.
const hashedAsset =
  /^\/_next\/static\/(?:chunks|css|media)\/(?:[A-Za-z0-9_()[\].@-]+\/)*(?:[A-Za-z0-9_()[\].@-]*[.-])?(?:[a-f0-9]{8,}|[a-z0-9_-]{12,})(?:\.[a-z0-9]+){1,2}$/u;

const id = "[0-9a-f-]{36}";
const teamDetail = new RegExp(`^/api/teams/${id}$`, "iu");
const teamWebsites = new RegExp(`^/api/teams/${id}/websites$`, "iu");
const teamBoards = new RegExp(`^/api/teams/${id}/boards$`, "iu");
const teamLinks = new RegExp(`^/api/teams/${id}/links$`, "iu");
const teamPixels = new RegExp(`^/api/teams/${id}/pixels$`, "iu");
const userWebsites = new RegExp(`^/api/users/${id}/websites$`, "iu");
const websiteDetail = new RegExp(`^/api/websites/${id}$`, "iu");
const teamPage = new RegExp(
  `^/teams/${id}(?:/(?:websites|boards|links|pixels)(?:/[^/]+)*)?/?$`,
  "iu",
);
const pick = (value: unknown, keys: readonly string[]) =>
  Object.fromEntries(
    keys.flatMap((key) =>
      value && typeof value === "object" && key in value
        ? [[key, (value as Record<string, unknown>)[key]]]
        : [],
    ),
  );
const publicTeam = (value: unknown) => pick(value, ["id", "name", "logoUrl"]);
const publicWebsite = (value: unknown) =>
  pick(value, [
    "id",
    "name",
    "domain",
    "createdAt",
    "resetAt",
    "deletedAt",
    "userId",
    "teamId",
  ]);
const publicPage = (value: unknown, project: (row: unknown) => unknown) => {
  if (Array.isArray(value)) return value.map(project);
  const page = pick(value, ["count", "page", "pageSize", "orderBy", "search"]);
  return {
    ...page,
    data:
      value &&
      typeof value === "object" &&
      "data" in value &&
      Array.isArray(value.data)
        ? value.data.map(project)
        : [],
  };
};

/** Read-only native workspace, including assets, RSC and config, is Owner-gated. */
export const createAnalyticsProxy =
  ({
    isOwner,
    upstream = umamiUpstream,
  }: {
    readonly isOwner: (request: Request) => Promise<boolean>;
    readonly upstream?: typeof umamiUpstream;
  }) =>
  async (request: Request): Promise<Response> => {
    // Authenticate BEFORE inspecting or fetching any upstream resource.
    if (!(await isOwner(request)))
      return failure(403, "仅限 Owner 访问数据分析。");
    const url = new URL(request.url);
    const suffix = url.pathname.slice(UMAMI_WORKSPACE_PATH.length);
    if (
      (url.pathname !== UMAMI_WORKSPACE_PATH &&
        !url.pathname.startsWith(`${UMAMI_WORKSPACE_PATH}/`)) ||
      /[%\\]/u.test(url.pathname) ||
      suffix.startsWith("//")
    )
      return failure(404, "Not found");

    // Upstream rewrites /teams/:teamId/:path* to /:path*. Only native pages
    // may use that alias; an API alias must never bypass the checks below.
    if (
      /^\/teams\//iu.test(suffix) &&
      (!teamPage.test(suffix) ||
        /\/(?:api|compat|share|login|logout|auth|settings|admin|_next)(?:\/|$)/iu.test(
          suffix,
        ))
    )
      return failure(404, "Not found");

    const verify = suffix === "/api/auth/verify";
    const isTeamDetail = teamDetail.test(suffix);
    const isWebsiteList =
      ["/api/websites", "/api/me/websites"].includes(suffix) ||
      teamWebsites.test(suffix) ||
      userWebsites.test(suffix);
    if (
      !["GET", "HEAD"].includes(request.method) &&
      !(request.method === "POST" && verify)
    )
      return failure(405, "此工作台仅支持读取。");
    // Do not expose collection, share capabilities, login or account management.
    if (
      /^\/(?:login|logout|share|settings|admin)(?:\/|$)/iu.test(suffix) ||
      /\/(?:shares|api-keys)(?:\/|$)/iu.test(suffix) ||
      (/^\/api\/(?:send|batch|share|shares|users|teams|admin|me|api-keys|auth|2fa)(?:\/|$)/iu.test(
        suffix,
      ) &&
        !verify &&
        !isTeamDetail &&
        !isWebsiteList &&
        !teamBoards.test(suffix) &&
        !teamLinks.test(suffix) &&
        !teamPixels.test(suffix) &&
        suffix !== "/api/2fa/status" &&
        !["/api/me", "/api/me/teams", "/api/me/websites"].includes(suffix))
    )
      return failure(404, "此入口仅提供分析报表；请在现有后台管理账号。");

    const headers = new Headers();
    const staticAsset =
      hashedAsset.test(suffix) &&
      !request.headers.has("rsc") &&
      !request.headers.has("x-moya-umami-rsc");
    if (staticAsset) {
      for (const name of ["if-none-match", "if-modified-since"]) {
        const value = request.headers.get(name);
        if (value) headers.set(name, value);
      }
    }
    for (const name of [
      "accept",
      "accept-language",
      "rsc",
      "next-router-state-tree",
      "next-router-prefetch",
      "next-router-segment-prefetch",
      "next-url",
    ]) {
      // Nginx envelopes native Next headers before Payload's own Next server
      // can normalize/remove them. Restore only this fixed read-only set.
      const value =
        request.headers.get(`x-moya-umami-${name}`) ??
        request.headers.get(name);
      if (value) headers.set(name, value);
    }
    if (request.method === "POST")
      headers.set("content-type", "application/json");
    const nativeHash = request.headers.get("x-moya-umami-rsc-query");
    if (nativeHash !== null) {
      if (!/^[A-Za-z0-9_-]{0,128}$/u.test(nativeHash))
        return failure(400, "Invalid native request");
      url.searchParams.set("_rsc", nativeHash);
    }
    try {
      const upstreamPath = userWebsites.test(suffix)
        ? `${UMAMI_WORKSPACE_PATH}/api/me/websites${url.search}`
        : `${url.pathname}${url.search}`;
      const response = await upstream.request(upstreamPath, {
        method: request.method,
        headers,
        signal: request.signal,
        // Native bootstrap needs POST verify; never relay credentials or bodies.
        ...(request.method === "POST" ? { body: "{}" } : {}),
      });
      if (
        request.method === "GET" &&
        response.ok &&
        (isTeamDetail ||
          suffix === "/api/me/teams" ||
          isWebsiteList ||
          websiteDetail.test(suffix))
      ) {
        const value: unknown = await response.json();
        const result = isTeamDetail
          ? {
              ...publicTeam(value),
              members:
                value &&
                typeof value === "object" &&
                "members" in value &&
                Array.isArray(value.members)
                  ? value.members.map((member: unknown) =>
                      pick(member, ["userId", "role"]),
                    )
                  : [],
            }
          : suffix === "/api/me/teams"
            ? publicPage(value, publicTeam)
            : isWebsiteList
              ? publicPage(value, publicWebsite)
              : publicWebsite(value);
        return Response.json(result, {
          headers: { ...privateHeaders, vary: "Cookie" },
        });
      }
      // Native /api/me returns its server auth context, including the bearer.
      // Project only public identity fields; never stream that context out.
      if (suffix === "/api/me" && request.method === "GET" && response.ok) {
        const context = (await response.json()) as {
          user?: Record<string, unknown>;
          authType?: unknown;
        };
        const user = Object.fromEntries(
          ["id", "username", "role", "isAdmin"].flatMap((key) => {
            const value = context.user?.[key];
            return typeof value === "string" || typeof value === "boolean"
              ? [[key, value]]
              : [];
          }),
        );
        return Response.json(
          {
            user,
            ...(typeof context.authType === "string"
              ? { authType: context.authType }
              : {}),
          },
          { headers: { ...privateHeaders, vary: "Cookie" } },
        );
      }
      const outgoing = new Headers(privateHeaders);
      if (
        staticAsset &&
        [200, 304].includes(response.status) &&
        !response.headers.has("location") &&
        !/text\/(?:html|x-component)/iu.test(
          response.headers.get("content-type") ?? "",
        )
      ) {
        outgoing.set("cache-control", "private, max-age=31536000, immutable");
        for (const name of ["etag", "last-modified"]) {
          const value = response.headers.get(name);
          if (value) outgoing.set(name, value);
        }
      }
      for (const name of [
        "content-type",
        "content-security-policy",
        "x-frame-options",
        "vary",
        "content-disposition",
      ]) {
        const value = response.headers.get(name);
        if (value) outgoing.set(name, value);
      }
      outgoing.append("vary", "Cookie");
      const location = response.headers.get("location");
      if (location) {
        const target = new URL(location, upstream.origin());
        if (
          target.origin !== upstream.origin().origin ||
          (target.pathname !== UMAMI_WORKSPACE_PATH &&
            !target.pathname.startsWith(`${UMAMI_WORKSPACE_PATH}/`))
        ) {
          await response.body?.cancel();
          return failure(502, "分析工作台暂时不可用。");
        }
        outgoing.set("location", `${target.pathname}${target.search}`);
      }
      if (response.status >= 500) {
        await response.body?.cancel();
        return failure(503, "分析工作台暂时不可用，请稍后重试。");
      }
      return new Response(
        request.method === "HEAD" || [204, 304].includes(response.status)
          ? null
          : response.body,
        { status: response.status, headers: outgoing },
      );
    } catch {
      return failure(503, "分析工作台尚未配置或暂时不可用。");
    }
  };
