import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { handleEndpoints, type SanitizedConfig } from "payload";

// What the Admin MCP suites share: Payload's own route handler behind a real
// socket, and the official client speaking real JSON-RPC to it over HTTP.

export const serveRoutes = async (config: SanitizedConfig) => {
  const http = createServer((incoming, outgoing) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(chunk as Buffer);
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers))
        if (value !== undefined)
          headers.set(name, Array.isArray(value) ? value.join(", ") : value);
      const body = Buffer.concat(chunks);
      const response = await handleEndpoints({
        config,
        request: new Request(new URL(incoming.url ?? "/", origin), {
          method: incoming.method ?? "GET",
          headers,
          ...(body.length > 0 ? { body } : {}),
        }),
      });
      outgoing.writeHead(
        response.status,
        Object.fromEntries(response.headers.entries()),
      );
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    })().catch(() => {
      outgoing.destroy();
    });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  return {
    origin,
    endpoint: `${origin}/api/mcp`,
    close: async () => {
      http.closeAllConnections();
      await new Promise((resolve) => http.close(resolve));
    },
  };
};

export const connectClient = async (
  endpoint: string,
  headers: Record<string, string>,
  fetchWith?: typeof fetch,
) => {
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
    requestInit: { headers },
    ...(fetchWith === undefined ? {} : { fetch: fetchWith }),
  });
  const client = new Client({ name: "synthetic", version: "1.0.0" });
  await client.connect(transport as Parameters<Client["connect"]>[0]);
  return { client, transport };
};

export const syntheticCatalogDraft = (catalogId: string, sourceId: string) => ({
  catalogId,
  sourceId,
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
});
