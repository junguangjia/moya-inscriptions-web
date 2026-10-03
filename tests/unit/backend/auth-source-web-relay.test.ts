import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { relayServerCommunityAuth } from "../../../apps/web/lib/public-api/server";

// Mock only Web's compile-time server boundary poison in this Node transport test.
vi.mock("../../../apps/web/node_modules/server-only/index.js", () => ({}));

const servers = new Set<Server>();
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    [...servers].map(
      (server) =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
    ),
  );
  servers.clear();
});
const listen = async (server: Server) => {
  servers.add(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw Error("TEST_ADDRESS_REQUIRED");
  return `http://127.0.0.1:${address.port}`;
};
const setup = async () => {
  const ingress = randomBytes(32).toString("base64url"),
    relay = randomBytes(32).toString("base64url");
  const observed: {
    source: string | string[] | undefined;
    authenticated: boolean;
    ingress: boolean;
    forwarded: boolean;
  }[] = [];
  const backend = await listen(
    createServer((req, res) => {
      req.resume();
      observed.push({
        source: req.headers["x-moya-auth-source"],
        authenticated: req.headers["x-moya-auth-relay"] === relay,
        ingress: req.headers["x-moya-auth-ingress"] !== undefined,
        forwarded:
          req.headers["x-forwarded-for"] !== undefined ||
          req.headers.forwarded !== undefined,
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ accepted: true }));
    }),
  );
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("MOYA_PUBLIC_API_BASE_URL", backend);
  vi.stubEnv("AUTH_INGRESS_TOKEN", ingress);
  vi.stubEnv("AUTH_SOURCE_RELAY_TOKEN", relay);
  const web = await listen(
    createServer(async (req, res) => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const headers = new Headers();
        for (let i = 0; i < req.rawHeaders.length; i += 2)
          headers.append(req.rawHeaders[i]!, req.rawHeaders[i + 1]!);
        const response = await relayServerCommunityAuth(
          new Request(`http://${req.headers.host}${req.url}`, {
            method: req.method ?? "GET",
            headers,
            ...(req.method === "POST"
              ? { body: Buffer.concat(chunks).toString() }
              : {}),
          }),
        );
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(Buffer.from(await response.arrayBuffer()));
      } catch {
        res.writeHead(500);
        res.end();
      }
    }),
  );
  const post = (headers: HeadersInit) =>
    fetch(`${web}/api/community/auth/challenges`, {
      method: "POST",
      headers,
      body: "{}",
    });
  return { ingress, relay, web, post, observed };
};

it("forwards independently authenticated client sources across actual Web HTTP without client forwarding claims", async () => {
  const h = await setup();
  for (let i = 1; i <= 21; i++)
    expect(
      (
        await h.post({
          "x-moya-auth-ingress": h.ingress,
          "x-moya-client-ip": `192.0.2.${i}`,
          "x-forwarded-for": "203.0.113.99",
          forwarded: "for=203.0.113.99",
          "x-moya-auth-source": "203.0.113.99",
          "x-moya-auth-relay": "SYNTHETIC_FORGED",
        })
      ).status,
    ).toBe(200);
  expect(h.observed.map((value) => value.source)).toEqual(
    Array.from({ length: 21 }, (_, i) => `192.0.2.${i + 1}`),
  );
  expect(
    h.observed.every(
      (value) => value.authenticated && !value.ingress && !value.forwarded,
    ),
  ).toBe(true);
});
it("rejects direct Web spoofing and ambiguous source credentials before any Backend HTTP", async () => {
  const h = await setup();
  const attempts: HeadersInit[] = [
    { "x-forwarded-for": "192.0.2.7", forwarded: "for=192.0.2.7" },
    { "x-moya-auth-ingress": h.relay, "x-moya-client-ip": "192.0.2.7" },
    {
      "x-moya-auth-ingress": h.ingress,
      "x-moya-client-ip": "192.0.2.7, 192.0.2.8",
    },
    {
      "x-moya-auth-ingress": `${h.ingress}, ${h.ingress}`,
      "x-moya-client-ip": "192.0.2.7",
    },
    { "x-moya-auth-ingress": h.ingress, "x-moya-client-ip": "::1%lo0" },
    { "x-moya-auth-ingress": h.ingress, "x-moya-client-ip": "::1 folded" },
  ];
  for (const headers of attempts)
    expect((await h.post(headers)).status).toBe(403);
  expect(h.observed).toEqual([]);
  vi.stubEnv("AUTH_SOURCE_RELAY_TOKEN", h.ingress);
  expect(
    (
      await h.post({
        "x-moya-auth-ingress": h.ingress,
        "x-moya-client-ip": "192.0.2.7",
      })
    ).status,
  ).toBe(403);
  expect(h.observed).toEqual([]);
});
it("canonicalizes IPv6 and mapped IPv4 while leaving public capabilities ungated", async () => {
  const h = await setup();
  for (const source of ["2001:0db8:0:0:0:0:0:1", "::ffff:192.0.2.7"])
    expect(
      (
        await h.post({
          "x-moya-auth-ingress": h.ingress,
          "x-moya-client-ip": source,
        })
      ).status,
    ).toBe(200);
  expect(h.observed.map((value) => value.source)).toEqual([
    "2001:db8::1",
    "192.0.2.7",
  ]);
  vi.stubEnv("AUTH_INGRESS_TOKEN", "");
  // Non-capability GET still proves no forwarding credential is needed before
  // ordinary Backend Session authorization; capabilities are validated separately.
  expect((await fetch(`${h.web}/api/community/auth/account`)).status).toBe(200);
});
