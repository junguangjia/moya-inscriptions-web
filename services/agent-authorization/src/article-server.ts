import { createServer } from "node:http";
import {
  ARTICLE_RESUME_PATH,
  createArticleAuthorizationProvider,
} from "./article-provider.js";

/** Additive listener in the existing authorization process; never a new Admin audience. */
export const startArticleAuthorizationServer = async (
  options: Parameters<typeof createArticleAuthorizationProvider>[0] & {
    readonly buildId: string;
  },
) => {
  const bundle = await createArticleAuthorizationProvider(options);
  const callback = bundle.provider.callback();
  const issuer = new URL(options.config.issuer);
  const server = createServer((request, response) => {
    if (request.headers.host !== issuer.host) {
      response.writeHead(400);
      response.end();
      return;
    }
    const url = new URL(request.url ?? "/", issuer);
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
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
};
