import { createServer } from "node:http";
import type { IncomingMessage } from "node:http";
import type { ArticleAuthorizationConfig } from "./article-provider.js";
import {
  ARTICLE_RESUME_PATH,
  createArticleAuthorizationProvider,
} from "./article-provider.js";

/** The only proxy trust boundary: reject before provider, resume, or cookies. */
export const articleAuthorizationRequestAllowed = (
  request: IncomingMessage,
  config: ArticleAuthorizationConfig,
): boolean => {
  const issuer = new URL(config.issuer);
  if (request.headers.host !== issuer.host) return false;
  if (config.environment !== "production") return true;
  const count = (name: string) =>
    request.rawHeaders.filter(
      (_, index) =>
        index % 2 === 0 && request.rawHeaders[index]?.toLowerCase() === name,
    ).length;
  return (
    ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
      request.socket.remoteAddress ?? "",
    ) &&
    ["host", "x-forwarded-proto", "x-forwarded-host"].every(
      (name) => count(name) === 1,
    ) &&
    request.headers["x-forwarded-proto"] === "https" &&
    request.headers["x-forwarded-host"] === issuer.host &&
    request.headers.forwarded === undefined &&
    (request.headers["x-forwarded-port"] === undefined ||
      request.headers["x-forwarded-port"] === (issuer.port || "443")) &&
    (request.url ?? "").startsWith("/") &&
    !(request.url ?? "").startsWith("//")
  );
};

/** Additive listener in the existing authorization process; never a new Admin audience. */
export const startArticleAuthorizationServer = async (
  options: Parameters<typeof createArticleAuthorizationProvider>[0] & {
    readonly buildId: string;
  },
) => {
  const bundle = await createArticleAuthorizationProvider(options);
  if (options.config.environment === "production") {
    bundle.provider.proxy = true;
    bundle.provider.proxyIpHeader = "X-Article-Proxy-Peer";
    bundle.provider.maxIpsCount = 1;
  }
  const callback = bundle.provider.callback();
  const issuer = new URL(options.config.issuer);
  const server = createServer((request, response) => {
    if (!articleAuthorizationRequestAllowed(request, options.config)) {
      response.writeHead(400);
      response.end();
      return;
    }
    // Never let an incoming header supply the trusted peer used by Koa.
    request.headers["x-article-proxy-peer"] = request.socket.remoteAddress;
    let url: URL;
    try {
      url = new URL(request.url ?? "/", issuer);
    } catch {
      response.writeHead(400);
      response.end();
      return;
    }
    if (url.pathname === "/healthz" && request.method === "GET") {
      response.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      response.end(JSON.stringify({ status: "ok", buildId: options.buildId }));
      return;
    }
    const resume = ARTICLE_RESUME_PATH.exec(url.pathname);
    if (resume !== null && request.method === "GET" && url.search === "") {
      void bundle.resume(request, response, resume[1]!).catch(() => {
        options.recordFailure?.("ARTICLE_RESUME_FAILED");
        if (!response.headersSent) {
          response.writeHead(500);
          response.end();
        } else response.destroy();
      });
      return;
    }
    callback(request, response);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.config.port, options.config.host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  return {
    bundle,
    close: () =>
      new Promise<void>((resolve, reject) => {
        const deadline = setTimeout(() => server.closeAllConnections(), 5_000);
        deadline.unref();
        server.close((error) => {
          clearTimeout(deadline);
          if (error) reject(error);
          else resolve();
        });
        server.closeIdleConnections();
      }),
  };
};
