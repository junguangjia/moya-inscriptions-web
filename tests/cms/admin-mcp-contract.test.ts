import { randomBytes, randomUUID } from "node:crypto";

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  ADMIN_ANALYTICS_REPORTS,
  ADMIN_CMS_RECORD_TYPES,
  ADMIN_COMMUNITY_RECORD_TYPES,
  ADMIN_EXECUTE_MAX_TARGETS,
  ADMIN_MCP_CONTRACT_VERSION,
  ADMIN_MCP_TEXT_CAP_BYTES,
  ADMIN_MCP_TOKEN_BUDGET,
  ADMIN_MCP_TOOL_PROFILES,
  adminMcpEnvelopeSchema,
  adminWhoamiDataSchema,
  type AdminMcpToolProfile,
} from "@moya/contracts/internal/admin-mcp";
import {
  getPayload,
  type Payload,
  type SanitizedConfig,
  type TypedUser,
} from "payload";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  actionsCatalogHash,
  adminMcpBudgets,
  CODE_GUIDE,
  contractOf,
  toolListingFor,
} from "admin/admin-mcp";

import { connectClient, serveRoutes } from "./admin-mcp-wire.js";

// What a connected tool can learn of the contract, and how a name that moved answers
// (extensibility plan 2.2 and 2.8), as real JSON-RPC with the official client: the
// tools/list it receives, serverInfo, admin_whoami's contract, the choices a refusal
// names now that tools/list shows them as strings, and earlier op names. The alias
// table is empty in the repository, so synthetic rows stand in for it here.

vi.mock("@moya/contracts/internal/admin-mcp", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@moya/contracts/internal/admin-mcp")
  >()),
  ADMIN_OP_ALIASES: {
    "list.catalog_rows": {
      use: "list.catalogs",
      since: "2026-11-06",
      until: "2999-12-31",
    },
    "catalog.publish_record": {
      use: "catalog.publish",
      since: "2026-11-06",
      until: "2999-12-31",
    },
    "list.media_rows": {
      use: "list.media",
      since: "2020-01-01",
      until: "2020-02-01",
    },
  },
}));

if (process.env.CMS_ENVIRONMENT !== "synthetic")
  throw new Error("SYNTHETIC_CMS_TARGET_REQUIRED");

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const run = randomUUID();
const password = randomBytes(24).toString("hex");
// At most 4,000 tokens (section 21), read at a cautious 3 bytes a token.
const CEILING_BYTES = ADMIN_MCP_TOKEN_BUDGET * 3;

let config: SanitizedConfig;
let payload: Payload;
let server: Awaited<ReturnType<typeof serveRoutes>>;
const secrets: Record<string, string> = {};

const makeKey = async (
  name: string,
  user: TypedUser,
  fields: Record<string, unknown>,
) => {
  const secret = randomBytes(32).toString("hex");
  await payload.create({
    collection: "payload-mcp-api-keys",
    overrideAccess: true,
    data: {
      user: user.id,
      label: `synthetic-contract-${name}`,
      enableAPIKey: true,
      apiKey: secret,
      ...fields,
    } as never,
  });
  secrets[name] = secret;
};

beforeAll(async () => {
  config = await (await import("admin/config")).default;
  payload = await getPayload({ config });
  const account = (name: string) =>
    payload.create({
      collection: "users",
      overrideAccess: true,
      data: {
        email: `contract-${name}-${run}@example.invalid`,
        password,
        role: "automation",
        scopeCatalogIds: [],
      },
    });
  const ai = await payload.update({
    collection: "users",
    id: (await account("ai")).id,
    overrideAccess: true,
    data: { role: "ai_operator" },
  });
  for (const profile of ADMIN_MCP_TOOL_PROFILES)
    await makeKey(profile, ai, { toolProfile: profile });
  await makeKey("automation", await account("automation"), {
    "payload-mcp-tool": { editorialQuery: true },
  });
  server = await serveRoutes(config);
});

afterAll(async () => {
  await server?.close();
  await payload?.db?.destroy?.();
});

const bearer = (name: string) => ({
  authorization: ["Bearer", secrets[name]!].join(" "),
});

const withClient = async <T>(
  name: string,
  use: (client: Client) => Promise<T>,
  fetchWith?: typeof fetch,
): Promise<T> => {
  const { client } = await connectClient(
    server.endpoint,
    bearer(name),
    fetchWith,
  );
  try {
    return await use(client);
  } finally {
    await client.close();
  }
};

/** One call's envelope, checked as every answer is. */
const callOn = async (
  client: Client,
  name: string,
  args: Json,
): Promise<Json> => {
  const result = await client.callTool({ name, arguments: args });
  const envelope = adminMcpEnvelopeSchema.parse(result.structuredContent);
  expect(result.isError === true).toBe(!envelope.ok);
  return envelope as Json;
};

/** The tools/list answer as the official client received it, and its bytes. */
const listedOnTheWire = async (profile: AdminMcpToolProfile) => {
  const bodies: string[] = [];
  const recording: typeof fetch = async (input, init) => {
    const response = await fetch(input, init);
    const sent = typeof init?.body === "string" ? init.body : "";
    if (sent.includes('"tools/list"'))
      bodies.push(await response.clone().text());
    return response;
  };
  return withClient(
    profile,
    async (client) => {
      const { tools } = await client.listTools();
      expect(bodies).toHaveLength(1);
      return { tools, bytes: Buffer.byteLength(bodies[0]!) };
    },
    recording,
  );
};

describe("tools/list as the official client receives it", () => {
  it.each(ADMIN_MCP_TOOL_PROFILES)(
    "stays within the ceiling for the %s profile",
    async (profile) => {
      const { tools, bytes } = await listedOnTheWire(profile);
      expect(tools.map(({ name }) => name)).toEqual(
        toolListingFor(profile, false).map(({ name }) => name),
      );
      expect(bytes).toBeLessThanOrEqual(CEILING_BYTES);
      // The capability document counts the tools array alone, the frame apart.
      const { toolsList } = adminMcpBudgets();
      expect(bytes - toolsList.frame).toBe(
        toolsList.profiles.find((row) => row.profile === profile)!.bytes,
      );
    },
  );

  it("shows what grows with the registry as a plain string, and the runtime still names the choices", async () => {
    const { tools } = await listedOnTheWire("read");
    const property = (tool: string, name: string) =>
      (
        tools.find((listed) => listed.name === tool)?.inputSchema
          .properties as Json
      )[name];
    expect(property("admin_find", "type")).toEqual({ type: "string" });
    expect(property("admin_get", "type")).toEqual({ type: "string" });
    expect(property("admin_analytics", "report")).toEqual({ type: "string" });
    expect(property("admin_get", "find")).toEqual({ type: "object" });
    const types = [...ADMIN_CMS_RECORD_TYPES, ...ADMIN_COMMUNITY_RECORD_TYPES];
    await withClient("read", async (client) => {
      for (const [tool, args, path, allowed] of [
        ["admin_get", { type: "sculpture", id: 1 }, ["type"], types],
        ["admin_find", { query: "x", type: "sculpture" }, ["type"], types],
        [
          "admin_analytics",
          { report: "weather" },
          ["report"],
          ADMIN_ANALYTICS_REPORTS,
        ],
      ] as const)
        expect(await callOn(client, tool, args), tool).toMatchObject({
          ok: false,
          code: "INPUT_INVALID",
          issues: [
            { path: [...path], code: "invalid_value", allowedValues: allowed },
          ],
        });
      // A version is a number or one of two words, and tools/list shows a string.
      for (const name of ["from", "to"])
        expect(
          await callOn(client, "admin_get", {
            type: "catalog",
            id: 1,
            view: "diff",
            [name]: "latest",
          }),
          name,
        ).toMatchObject({
          ok: false,
          code: "INPUT_INVALID",
          issues: [
            {
              path: [name],
              code: "invalid_union",
              allowedValues: ["draft", "published"],
            },
          ],
        });
    });
  });

  it("names a shared input's choices once, so a whole batch's refusal fits uncut", async () => {
    // Nothing reaches the Backend: the input is refused before any effect.
    vi.stubEnv("COMMUNITY_OPERATOR_AI_TOKEN", "synthetic-unused");
    try {
      await withClient("full", async (client) => {
        for (const [op, prefix] of [
          ["community.moderate-user", "user"],
          ["community.moderate-comment", "comment"],
        ] as const) {
          const result = await client.callTool({
            name: "admin_execute",
            arguments: {
              requestId: randomUUID(),
              op,
              targets: Array.from(
                { length: ADMIN_EXECUTE_MAX_TARGETS },
                (_, index) => ({
                  id: `${prefix}-${index.toString(16).padStart(32, "0")}`,
                }),
              ),
              input: { action: "ban", reason: "Synthetic reason" },
            },
          });
          const { text } = (result.content as { text: string }[])[0]!;
          const answer = JSON.parse(text) as Json;
          expect(Buffer.byteLength(text), op).toBeLessThanOrEqual(
            ADMIN_MCP_TEXT_CAP_BYTES,
          );
          expect(answer, op).toMatchObject({
            ok: false,
            code: "INPUT_INVALID",
            hint: CODE_GUIDE.INPUT_INVALID.hint,
          });
          expect(answer.meta, op).not.toHaveProperty("truncated");
          expect(answer, op).not.toHaveProperty("remaining");
          const issues = answer.issues as Json[];
          expect(issues, op).toHaveLength(ADMIN_EXECUTE_MAX_TARGETS);
          expect(
            issues.every(
              ({ path, code }, index) =>
                code === "invalid_value" &&
                JSON.stringify(path) ===
                  JSON.stringify(["targets", String(index), "action"]),
            ),
            op,
          ).toBe(true);
          expect(
            issues.filter((issue) => "allowedValues" in issue),
            op,
          ).toEqual([expect.objectContaining({ path: issues[0]!.path })]);
        }
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("the contract a client can read", () => {
  it("names the contract version as serverInfo", async () => {
    await withClient("read", async (client) => {
      expect(client.getServerVersion()).toEqual({
        name: "artvenn-admin",
        version: ADMIN_MCP_CONTRACT_VERSION,
      });
    });
  });

  it("gives admin_whoami the version, the catalog's hash and this key's tools/list hash", async () => {
    const contracts: Record<string, Json> = {};
    for (const profile of ADMIN_MCP_TOOL_PROFILES)
      contracts[profile] = await withClient(profile, async (client) => {
        const { data } = await callOn(client, "admin_whoami", {});
        return adminWhoamiDataSchema.parse(data).contract!;
      });
    for (const profile of ADMIN_MCP_TOOL_PROFILES)
      expect(contracts[profile]).toEqual({
        version: ADMIN_MCP_CONTRACT_VERSION,
        catalog: actionsCatalogHash(),
        tools: contractOf({ toolProfile: profile, paused: false }).tools,
      });
    // One catalog for every key; a listing of its own for each profile.
    expect(contracts.read!.catalog).toBe(contracts.full!.catalog);
    expect(contracts.read!.tools).not.toBe(contracts.full!.tools);
  });

  it("leaves the plugin path's admin_whoami as it was", async () => {
    await withClient("automation", async (client) => {
      const result = await client.callTool({
        name: "admin_whoami",
        arguments: {},
      });
      const [text] = result.content as { type: string; text: string }[];
      const { data } = JSON.parse(text!.text) as { data: Json };
      expect(data.path).toBe("plugin");
      expect(data).not.toHaveProperty("contract");
    });
  });
});

describe("an op called by a name that moved", () => {
  it("runs an earlier name under the op that replaced it, and says so", async () => {
    await withClient("full", async (client) => {
      const current = await callOn(client, "admin_read", {
        op: "list.catalogs",
        view: "count",
      });
      const earlier = await callOn(client, "admin_read", {
        op: "list.catalog_rows",
        view: "count",
      });
      expect(current.ok).toBe(true);
      expect(earlier).toMatchObject({ ok: true, data: current.data });
      expect(current.meta).not.toHaveProperty("deprecated");
      const deprecated = [
        { op: "list.catalog_rows", use: "list.catalogs", until: "2999-12-31" },
      ];
      expect(earlier.meta.deprecated).toEqual(deprecated);
      const detail = await callOn(client, "admin_actions", {
        op: "list.catalog_rows",
      });
      expect(detail.data.details.map(({ op }: Json) => op)).toEqual([
        "list.catalogs",
      ]);
      expect(detail.meta.deprecated).toEqual(deprecated);
      // On the write tool too, refusals included: the call reached the op itself.
      const write = await callOn(client, "admin_execute", {
        requestId: randomUUID(),
        op: "catalog.publish_record",
        input: {},
      });
      expect(write).toMatchObject({
        ok: false,
        code: "INPUT_INVALID",
        meta: {
          deprecated: [
            {
              op: "catalog.publish_record",
              use: "catalog.publish",
              until: "2999-12-31",
            },
          ],
        },
      });
    });
  });

  it("answers a retired name with what replaced it, never as a typo", async () => {
    await withClient("full", async (client) => {
      const retired = {
        ok: false,
        code: "OP_RETIRED",
        data: { op: "list.media_rows", use: "list.media" },
      };
      expect(
        await callOn(client, "admin_read", { op: "list.media_rows" }),
      ).toEqual(expect.objectContaining(retired));
      expect(
        await callOn(client, "admin_actions", {
          ops: ["list.catalogs", "list.media_rows"],
        }),
      ).toEqual(expect.objectContaining(retired));
      expect(
        await callOn(client, "admin_execute", {
          requestId: randomUUID(),
          op: "list.media_rows",
        }),
      ).toEqual(expect.objectContaining(retired));
      // A typo still gets near names.
      expect(
        await callOn(client, "admin_read", { op: "list.catalog" }),
      ).toMatchObject({
        code: "UNKNOWN_OP",
        data: {
          nearest: expect.arrayContaining(["list.catalogs"]) as string[],
        },
      });
    });
  });

  it("tells an op named on the wrong tool where it runs, and runs nothing", async () => {
    await withClient("full", async (client) => {
      for (const [tool, args, runsOn] of [
        ["admin_read", { op: "catalog.publish" }, "admin_execute"],
        ["admin_read", { op: "analytics.ips" }, "admin_sensitive_read"],
        [
          "admin_execute",
          { requestId: randomUUID(), op: "list.catalogs" },
          "admin_read",
        ],
      ] as const)
        expect(await callOn(client, tool, args), tool).toEqual(
          expect.objectContaining({
            ok: false,
            code: "WRONG_TOOL",
            data: { tool: runsOn },
          }),
        );
      // The irreversible move keeps the answer it always had.
      expect(
        await callOn(client, "admin_execute", {
          requestId: randomUUID(),
          op: "community.delete-body",
          input: {},
        }),
      ).toMatchObject({ code: "USE_EXECUTE_IRREVERSIBLE" });
    });
  });
});
