import next from "next";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createProductionHttpServer } from "./production-http-server.mts";

import type { IncomingMessage, ServerResponse } from "node:http";

export const parseListenArguments = (args: readonly string[]) => {
  let hostname = "127.0.0.1";
  let port = 3000;
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag === undefined || value === undefined || seen.has(flag)) {
      throw new Error("Invalid Web listener arguments");
    }
    seen.add(flag);
    if (flag === "--hostname" && value === "127.0.0.1") hostname = value;
    else if (flag === "--port" && /^[1-9][0-9]{0,4}$/.test(value)) {
      port = Number(value);
      if (port > 65_535) throw new Error("Invalid Web listener port");
    } else throw new Error("Invalid Web listener arguments");
  }
  return { hostname, port };
};

export const startProductionWeb = async (args: readonly string[]) => {
  if (process.env.NODE_ENV !== "production") {
    throw new Error("Web production startup requires NODE_ENV=production");
  }
  const { hostname, port } = parseListenArguments(args);
  let handler: (
    request: IncomingMessage,
    response: ServerResponse,
  ) => Promise<void> = async () => {
    throw new Error("Web handler is not prepared");
  };
  const server = createProductionHttpServer((request, response) =>
    handler(request, response),
  );
  const app = next({
    dev: false,
    dir: fileURLToPath(new URL("../", import.meta.url)),
    hostname,
    port,
    httpServer: server,
  });
  await app.prepare();
  handler = app.getRequestHandler();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, hostname, () => {
      server.off("error", reject);
      resolve();
    });
  });
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    // Stay below systemd's 30s deadline, including Next cleanup and active SSE.
    const deadline = setTimeout(() => {
      server.closeAllConnections();
      process.exit(1);
    }, 25_000);
    deadline.unref();
    server.close(() => {
      void app.close().then(
        () => process.exit(0),
        () => process.exit(1),
      );
    });
    server.closeIdleConnections();
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  return { app, server };
};

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  startProductionWeb(process.argv.slice(2)).catch(() => {
    // Startup diagnostics must never dump protected environment/request input.
    process.stderr.write("Web production startup failed\n");
    process.exitCode = 1;
  });
}
