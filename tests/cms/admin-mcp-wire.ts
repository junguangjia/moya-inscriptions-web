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

/**
 * An answer with one more field, and each record of a list in it: what a Backend
 * released first adds. Deeper objects stay as sent, because some are maps, where a new
 * key is an entry and not a field.
 */
export const withFieldAdded = (value: unknown, name: string): unknown => {
  const added = (item: unknown) =>
    item === null || typeof item !== "object" || Array.isArray(item)
      ? item
      : { ...item, [name]: "synthetic" };
  if (Array.isArray(value)) return value.map(added);
  if (value === null || typeof value !== "object") return value;
  return added(
    Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        Array.isArray(item) ? item.map(added) : item,
      ]),
    ),
  );
};

/**
 * A relay in front of a real Backend that rewrites each JSON answer it passes on, so a
 * suite can show what the Admin makes of a Backend that answers otherwise. Anything not
 * JSON passes as it came.
 */
export const relayRewriting = async (
  upstream: string,
  rewrite: (body: unknown) => unknown,
) => {
  const relay = createServer((incoming, outgoing) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(chunk as Buffer);
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers))
        if (typeof value === "string" && name !== "host")
          headers.set(name, value);
      const answer = await fetch(
        new URL((incoming.url ?? "/").slice(1), upstream),
        {
          method: incoming.method ?? "GET",
          headers,
          ...(chunks.length === 0 ? {} : { body: Buffer.concat(chunks) }),
        },
      );
      const type = answer.headers.get("content-type") ?? "";
      const body = Buffer.from(await answer.arrayBuffer());
      outgoing.writeHead(answer.status, { "content-type": type });
      outgoing.end(
        type.includes("json")
          ? JSON.stringify(rewrite(JSON.parse(body.toString("utf8"))))
          : body,
      );
    })().catch(() => outgoing.destroy());
  });
  await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", resolve));
  return {
    origin: `http://127.0.0.1:${(relay.address() as AddressInfo).port}/`,
    close: async () => {
      relay.closeAllConnections();
      await new Promise((resolve) => relay.close(resolve));
    },
  };
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
