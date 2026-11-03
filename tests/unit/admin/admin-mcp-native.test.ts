import { readFile } from "node:fs/promises";
import path from "node:path";

import { APIError, UnauthorizedError, type PayloadRequest } from "payload";
import { describe, expect, it, vi } from "vitest";

import {
  ADMIN_MCP_CODES,
  ADMIN_MCP_TOOL_PROFILES,
  adminMcpEnvelopeSchema,
  type AdminMcpCodeGuide,
} from "@moya/contracts/internal/admin-mcp";

import {
  ADMIN_MCP_INSTRUCTIONS,
  ADMIN_MCP_TOOLS,
  CODE_GUIDE,
  adminMcpDispatch,
  adminMcpDispatchPlugin,
  admitKey,
  admittedKeyOf,
  bearerKeyOf,
  failedEnvelope,
  guardCall,
  inputInvalidEnvelope,
  markRequestStart,
  okEnvelope,
  toolFor,
  toolListingFor,
  toolResult,
  withGuard,
  withKeyDoor,
} from "admin/admin-mcp";
import { connectionOverrideAuth } from "admin/agent-connections";
import { cmsRuntimeLogFields } from "admin/runtime-settings";
import {
  LATEST_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
} from "@modelcontextprotocol/sdk/types.js";
import { repositoryRoot } from "../architecture/workspace-scanner.js";

// Synthetic values built at runtime, so no credential-shaped literal is tracked.
const connectionPrefix = ["artvenn", "ct"].join("_");
const bearerForged = `Bearer ${connectionPrefix}_forged`;
const bearerAny = `Bearer ${connectionPrefix}_any`;

const read = (file: string) =>
  readFile(path.join(repositoryRoot, file), "utf8");

describe("code guide", () => {
  it("guides every code with a fixed hint that cannot carry user content", () => {
    expect(Object.keys(CODE_GUIDE).sort()).toEqual([...ADMIN_MCP_CODES].sort());
    for (const code of ADMIN_MCP_CODES) {
      const { hint, retryable } = CODE_GUIDE[code];
      expect(hint, code).toMatch(/^[\x20-\x7e]{1,200}$/u);
      expect(hint, code).not.toContain("${");
      expect(typeof retryable, code).toBe("boolean");
    }
  });

  it("is declared against the contract's type, so a new code fails typecheck until guided", async () => {
    const declared: AdminMcpCodeGuide = CODE_GUIDE;
    expect(Object.keys(declared)).toEqual([...ADMIN_MCP_CODES]);
    expect(await read("apps/admin/src/admin-mcp/envelope.ts")).toContain(
      "export const CODE_GUIDE: AdminMcpCodeGuide = {",
    );
  });

  it("builds a failed envelope from the guide and omits a false retryable", () => {
    expect(
      adminMcpEnvelopeSchema.parse(failedEnvelope("OUTCOME_UNKNOWN")),
    ).toEqual({
      ok: false,
      code: "OUTCOME_UNKNOWN",
      hint: CODE_GUIDE.OUTCOME_UNKNOWN.hint,
      retryable: true,
      untrusted: [],
      meta: {},
    });
    const conflict = failedEnvelope("STATE_CONFLICT");
    expect(conflict.hint).toBe(CODE_GUIDE.STATE_CONFLICT.hint);
    expect(conflict).not.toHaveProperty("retryable");
    expect(okEnvelope({ a: 1 })).not.toHaveProperty("hint");
  });
});

describe("tool result", () => {
  const scope = (keyId: number, tool = "admin_whoami") => ({ keyId, tool });
  const invalid = () => inputInvalidEnvelope([{ path: ["a"], code: "custom" }]);

  it("carries one JSON in text and structuredContent, with isError exactly when ok is false", () => {
    const success = toolResult(scope(100), okEnvelope({ a: 1 }));
    expect(success).not.toHaveProperty("isError");
    expect(JSON.parse(success.content[0]!.text)).toEqual(
      success.structuredContent,
    );
    const failure = toolResult(scope(100), invalid());
    expect(failure.isError).toBe(true);
    expect(failure.structuredContent.code).toBe("INPUT_INVALID");
  });

  it("refuses to send an envelope that breaks the schema", () => {
    expect(() =>
      toolResult(scope(101), {
        ...okEnvelope({}),
        code: "QUEUED",
      }),
    ).toThrow();
  });

  it("sets meta.repeat from the third identical failure for one key, tool and code", () => {
    const repeat = (keyId: number, tool?: string, code = invalid()) =>
      (
        toolResult(scope(keyId, tool), code).structuredContent.meta as {
          repeat?: number;
        }
      ).repeat;
    expect(repeat(200)).toBeUndefined();
    expect(repeat(200)).toBeUndefined();
    expect(repeat(200)).toBe(3);
    expect(repeat(200)).toBe(4);
    expect(repeat(201)).toBeUndefined();
    expect(repeat(200, "another")).toBeUndefined();
    expect(repeat(200, undefined, failedEnvelope("STATE_CONFLICT"))).toBe(
      undefined,
    );
    expect(repeat(200)).toBeUndefined();
    toolResult(scope(202), invalid());
    toolResult(scope(202), invalid());
    toolResult(scope(202), okEnvelope({}));
    expect(repeat(202)).toBeUndefined();
  });
});

describe("tool table", () => {
  it("ships exactly admin_whoami in this slice, within the top-level lock", () => {
    expect(ADMIN_MCP_TOOLS.map(({ name }) => name)).toEqual(["admin_whoami"]);
    expect(ADMIN_MCP_TOOLS.length).toBeLessThanOrEqual(15);
  });

  it("sets all four annotations and an input schema on every listed tool", () => {
    for (const profile of ADMIN_MCP_TOOL_PROFILES)
      for (const tool of toolListingFor(profile, false)) {
        expect(Object.keys(tool.annotations).sort(), tool.name).toEqual([
          "destructiveHint",
          "idempotentHint",
          "openWorldHint",
          "readOnlyHint",
        ]);
        for (const hint of Object.values(tool.annotations))
          expect(typeof hint, tool.name).toBe("boolean");
        expect(tool.inputSchema.type, tool.name).toBe("object");
        expect(tool.name).not.toMatch(/^(?:editorial|artvenn)_/u);
      }
    expect(toolListingFor("read", false)[0]?.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
  });

  it("publishes the envelope as every tool's result schema, but for the one recorded exception", () => {
    // Matrix "admin_view_media result": the official client throws when a tool
    // with a result schema answers with no structuredContent, and that tool answers
    // text plus an image. It arrives in a later slice, which this then holds to it.
    const withoutResultSchema = new Set(["admin_view_media"]);
    for (const profile of ADMIN_MCP_TOOL_PROFILES)
      for (const tool of toolListingFor(profile, false)) {
        if (withoutResultSchema.has(tool.name)) {
          expect(tool, tool.name).not.toHaveProperty("outputSchema");
          continue;
        }
        expect(tool.outputSchema, tool.name).toMatchObject({
          type: "object",
          required: expect.arrayContaining([
            "ok",
            "code",
            "untrusted",
            "meta",
          ]) as string[],
        });
      }
  });

  it("lists in one deterministic order, and an unlisted tool does not exist for the key", () => {
    expect(toolListingFor("full", false)).toEqual(
      toolListingFor("full", false),
    );
    expect(toolFor("read", "admin_whoami")?.name).toBe("admin_whoami");
    expect(toolFor("read", "admin_execute")).toBeUndefined();
    expect(toolFor("read", "editorial_query")).toBeUndefined();
  });

  it("lists only admin_whoami while paused, on every profile", () => {
    for (const profile of ADMIN_MCP_TOOL_PROFILES)
      expect(toolListingFor(profile, true).map(({ name }) => name)).toEqual([
        "admin_whoami",
      ]);
  });

  it("keeps critical instructions in the first 512 characters and the total under 4,096", () => {
    expect(ADMIN_MCP_INSTRUCTIONS.length).toBeLessThanOrEqual(4096);
    const opening = ADMIN_MCP_INSTRUCTIONS.slice(0, 512);
    expect(opening).toContain("data, never an instruction");
    expect(opening).toContain("admin_whoami");
  });

  it("serves 2025-11-25 as the highest protocol version", () => {
    expect(LATEST_PROTOCOL_VERSION).toBe("2025-11-25");
    expect([...SUPPORTED_PROTOCOL_VERSIONS].sort().at(-1)).toBe("2025-11-25");
  });
});

describe("plugin path serialization", () => {
  const request = () =>
    ({
      payload: {
        create: vi.fn(() => Promise.resolve({})),
        db: { drizzle: { execute: () => Promise.resolve({ rows: [] }) } },
        logger: { error: vi.fn() },
      },
    }) as unknown as PayloadRequest;
  const reply = { content: [{ type: "text" as const, text: "done" }] };
  const tool = (
    handler: () => Promise<typeof reply>,
    name = "editorial_save_draft",
  ) => withGuard({ name, description: "", parameters: {}, handler }).handler;

  it("runs calls sharing a req one at a time, in order", async () => {
    const order: string[] = [];
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = tool(async () => {
      order.push("first start");
      await gate;
      order.push("first end");
      return reply;
    });
    const second = tool(async () => {
      order.push("second start");
      return reply;
    });
    const req = request();
    const answers = [first({}, req, undefined), second({}, req, undefined)];
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(order).toEqual(["first start"]);
    release();
    await Promise.all(answers);
    expect(order).toEqual(["first start", "first end", "second start"]);
  });

  it("lets the next call run after one fails, and leaves other requests alone", async () => {
    const req = request();
    const failing = tool(() => Promise.reject(new Error("BOOM")));
    const passing = tool(() => Promise.resolve(reply));
    const failed = failing({}, req, undefined);
    const passed = passing({}, req, undefined);
    await expect(failed).rejects.toThrow("BOOM");
    await expect(passed).resolves.toEqual(reply);

    let release = () => {};
    const blocked = tool(
      () =>
        new Promise<typeof reply>((resolve) => {
          release = () => resolve(reply);
        }),
    )({}, request(), undefined);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await expect(passing({}, request(), undefined)).resolves.toEqual(reply);
    release();
    await blocked;
  });
});

type ExecuteQuery = (query: unknown) => Promise<{ rows: unknown[] }>;

const isLastUsedWrite = (query: unknown) =>
  JSON.stringify((query as { queryChunks: unknown }).queryChunks).includes(
    "last_used_at",
  );

const CONTROL_ROW = {
  pause: false,
  threshold: "20",
  dm: false,
  evidence: false,
  raw_ip: false,
  self_only: false,
};

describe("the guard", () => {
  type AuditCreate = (args: {
    data: Record<string, unknown>;
  }) => Promise<unknown>;
  const SECRET_ARGUMENT = "synthetic-argument-canary";
  const reply = (text: string) => ({
    content: [{ type: "text" as const, text }],
  });
  const request = ({
    paused = false,
    create = vi.fn<AuditCreate>(() => Promise.resolve({})),
  }: {
    paused?: boolean;
    create?: ReturnType<typeof vi.fn<AuditCreate>>;
  } = {}) => ({
    create,
    req: {
      user: { id: 3 },
      payload: {
        create,
        db: {
          drizzle: {
            execute: () =>
              Promise.resolve({
                rows: [{ ...CONTROL_ROW, pause: paused }],
              }),
          },
        },
        logger: { error: vi.fn() },
      },
    } as unknown as PayloadRequest,
  });
  const rowsOf = (create: ReturnType<typeof vi.fn>) =>
    create.mock.calls.map(
      ([args]) => (args as { data: Record<string, unknown> }).data,
    );
  const pluginTool = (
    name: string,
    handler: () => Promise<ReturnType<typeof reply>>,
  ) => withGuard({ name, description: "", parameters: {}, handler }).handler;
  const failingCreate = (failOn: (data: Record<string, unknown>) => boolean) =>
    vi.fn((args: { data: Record<string, unknown> }) =>
      failOn(args.data) ? Promise.reject(new Error("db")) : Promise.resolve({}),
    );

  it("records only a finish for a read, with the outcome and no arguments", async () => {
    const { req, create } = request();
    const answer = await pluginTool("editorial_read", () =>
      Promise.resolve(reply(JSON.stringify({ id: 1 }))),
    )(
      { id: 41, field: SECRET_ARGUMENT, idempotencyKey: SECRET_ARGUMENT },
      req,
      undefined,
    );
    expect(answer).toEqual(reply(JSON.stringify({ id: 1 })));
    const rows = rowsOf(create);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      phase: "finish",
      class: "read",
      tool: "editorial_read",
      ok: true,
      code: "OK",
      targetType: "catalogs",
      targetId: "41",
      requestId: SECRET_ARGUMENT,
      userId: "3",
    });
    expect(rows[0]?.durationMs).toEqual(expect.any(Number));
    expect(rows[0]?.responseBytes).toBe(8);
  });

  it("leaves a caller's dedupe key out of the row unless it reads as an id", async () => {
    const { req, create } = request();
    await pluginTool("editorial_save_draft", () =>
      Promise.resolve(reply("{}")),
    )({ idempotencyKey: "free text, not an id" }, req, undefined);
    expect(JSON.stringify(rowsOf(create))).not.toContain("free text");
  });

  it("records a start before a write runs and a finish with the same callId after", async () => {
    const { req, create } = request();
    const seenBeforeRun: number[] = [];
    await pluginTool("editorial_save_draft", () => {
      seenBeforeRun.push(create.mock.calls.length);
      return Promise.resolve(
        reply(JSON.stringify({ ok: false, code: "REVISION_CONFLICT" })),
      );
    })({}, req, undefined);
    expect(seenBeforeRun).toEqual([1]);
    const [start, finish] = rowsOf(create);
    expect(start).toMatchObject({ phase: "start", class: "write" });
    expect(start).not.toHaveProperty("ok");
    expect(finish).toMatchObject({
      phase: "finish",
      ok: false,
      code: "REVISION_CONFLICT",
      callId: start?.callId,
    });
  });

  it("treats a tool it does not know as a write", async () => {
    const { req, create } = request();
    await pluginTool("artvenn_something_new", () =>
      Promise.resolve(reply("{}")),
    )({}, req, undefined);
    expect(rowsOf(create).map(({ phase }) => phase)).toEqual([
      "start",
      "finish",
    ]);
  });

  it("refuses a write whose start cannot be recorded, and never runs it", async () => {
    const { req } = request({ create: failingCreate(() => true) });
    const handler = vi.fn(() => Promise.resolve(reply("{}")));
    const answer = await pluginTool("editorial_save_draft", handler)(
      {},
      req,
      undefined,
    );
    expect(handler).not.toHaveBeenCalled();
    expect(JSON.parse(answer.content[0]!.text)).toMatchObject({
      ok: false,
      code: "AUDIT_UNAVAILABLE",
      retryable: true,
    });
    expect(req.payload.logger.error).toHaveBeenCalledWith({
      category: "ADMIN_MCP_AUDIT_WRITE_FAILED",
    });
  });

  it("delivers nothing from a read it could not record", async () => {
    const { req } = request({ create: failingCreate(() => true) });
    const answer = await pluginTool("editorial_read", () =>
      Promise.resolve(reply(SECRET_ARGUMENT)),
    )({}, req, undefined);
    expect(answer.content[0]?.text).not.toContain(SECRET_ARGUMENT);
    expect(JSON.parse(answer.content[0]!.text).code).toBe("AUDIT_UNAVAILABLE");
  });

  it("answers a write truthfully when only its finish could not be recorded", async () => {
    const { req } = request({
      create: failingCreate(({ phase }) => phase === "finish"),
    });
    const committed = reply(JSON.stringify({ id: 9 }));
    await expect(
      pluginTool("editorial_save_draft", () => Promise.resolve(committed))(
        {},
        req,
        undefined,
      ),
    ).resolves.toEqual(committed);
    expect(req.payload.logger.error).toHaveBeenCalledWith({
      category: "ADMIN_MCP_AUDIT_WRITE_FAILED",
    });
  });

  it("refuses everything but admin_whoami while paused, and records the refusal", async () => {
    for (const name of ["editorial_query", "editorial_save_draft"]) {
      const { req, create } = request({ paused: true });
      const handler = vi.fn(() => Promise.resolve(reply("{}")));
      const answer = await pluginTool(name, handler)({}, req, undefined);
      expect(handler).not.toHaveBeenCalled();
      expect(JSON.parse(answer.content[0]!.text)).toMatchObject({
        ok: false,
        code: "MCP_PAUSED",
      });
      expect(rowsOf(create).at(-1)).toMatchObject({
        phase: "finish",
        ok: false,
        code: "MCP_PAUSED",
      });
    }
    const { req } = request({ paused: true });
    const whoami = reply(JSON.stringify({ ok: true, code: "OK" }));
    await expect(
      pluginTool("admin_whoami", () => Promise.resolve(whoami))(
        {},
        req,
        undefined,
      ),
    ).resolves.toEqual(whoami);
  });

  it("records a tool that throws, and lets the throw through", async () => {
    const { req, create } = request();
    await expect(
      pluginTool("editorial_save_draft", () =>
        Promise.reject(new Error(SECRET_ARGUMENT)),
      )({}, req, undefined),
    ).rejects.toThrow(SECRET_ARGUMENT);
    expect(rowsOf(create).at(-1)).toMatchObject({
      phase: "finish",
      ok: false,
      code: "TOOL_FAILED",
    });
    expect(JSON.stringify(rowsOf(create))).not.toContain(SECRET_ARGUMENT);
  });

  it("counts the door in a request's first call, and only its own time in the next", async () => {
    const { req, create } = request();
    markRequestStart(req);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const run = pluginTool("editorial_read", () =>
      Promise.resolve(reply("{}")),
    );
    await run({}, req, undefined);
    await run({}, req, undefined);
    const [first, second] = rowsOf(create);
    expect(first?.durationMs).toBeGreaterThanOrEqual(15);
    expect(second?.durationMs).toBeLessThan(15);
  });

  it("gives guardCall's caller the refusal rather than running on a failed start", async () => {
    const { req } = request({ create: failingCreate(() => true) });
    const execute = vi.fn(() => Promise.resolve("value"));
    await expect(
      guardCall(
        { req, tool: "admin_execute", klass: "reversible" },
        execute,
        () => ({
          ok: true,
          code: "OK",
        }),
      ),
    ).resolves.toEqual({ refused: "AUDIT_UNAVAILABLE" });
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("the door", () => {
  const future = () => new Date(Date.now() + 60_000).toISOString();
  const request = (
    execute = vi.fn<ExecuteQuery>(() => Promise.resolve({ rows: [] })),
  ) => ({
    req: {
      headers: new Headers(),
      payload: {
        db: { drizzle: { execute } },
        logger: { warn: vi.fn(), error: vi.fn() },
      },
    } as unknown as PayloadRequest,
    execute,
  });
  const lastUsedWrites = (execute: ReturnType<typeof vi.fn>) =>
    execute.mock.calls.filter(([query]) => isLastUsedWrite(query));
  const key = (role: string, fields: Record<string, unknown> = {}) =>
    ({
      id: 7,
      expiresAt: future(),
      toolProfile: "operate",
      "payload-mcp-tool": { editorialQuery: true },
      user: { id: 3, role },
      ...fields,
    }) as never;
  const category = (req: PayloadRequest) =>
    (req.payload.logger.warn as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0];

  it("reads the bearer the way the plugin's default lookup does", () => {
    const of = (authorization?: string) =>
      bearerKeyOf({
        headers: new Headers(authorization ? { authorization } : {}),
      } as PayloadRequest);
    expect(of("Bearer abc")).toBe("abc");
    expect(of("bearer abc")).toBeNull();
    expect(of("JWT abc")).toBeNull();
    expect(of()).toBeNull();
  });

  it("refuses an Owner-bound key by name on either path, and logs its category", async () => {
    for (const path of ["native", "plugin"] as const) {
      const { req, execute } = request();
      const refused = admitKey(req, key("owner"), path);
      await expect(refused).rejects.toBeInstanceOf(APIError);
      await expect(refused).rejects.toMatchObject({
        status: 401,
        message: "KEY_OWNER_BOUND",
        // Without a name a minified production build answers an unknown error
        // once an Admin page has loaded first; owner-browser.mjs proves it there.
        name: "KEY_OWNER_BOUND",
        data: { code: "KEY_OWNER_BOUND" },
        isPublic: true,
      });
      expect(category(req)).toEqual({ category: "ADMIN_MCP_KEY_OWNER_BOUND" });
      expect(execute).not.toHaveBeenCalled();
    }
  });

  it("reads a role that does not belong on this path as unknown", async () => {
    for (const [role, path] of [
      ["ai_operator", "plugin"],
      ["automation", "native"],
      ["agent-connection", "plugin"],
      ["agent-connection", "native"],
    ] as const) {
      const { req, execute } = request();
      await expect(admitKey(req, key(role), path)).rejects.toBeInstanceOf(
        UnauthorizedError,
      );
      expect(category(req)).toEqual({ category: "ADMIN_MCP_KEY_REFUSED" });
      expect(execute).not.toHaveBeenCalled();
    }
  });

  it("refuses a null, past or unreadable expiry by name", async () => {
    for (const expiresAt of [
      null,
      undefined,
      "not a date",
      new Date(Date.now() - 1).toISOString(),
    ]) {
      const { req, execute } = request();
      await expect(
        admitKey(req, key("ai_operator", { expiresAt }), "native"),
      ).rejects.toMatchObject({
        status: 401,
        message: "KEY_EXPIRED",
        name: "KEY_EXPIRED",
        data: { code: "KEY_EXPIRED" },
      });
      expect(category(req)).toEqual({ category: "ADMIN_MCP_KEY_EXPIRED" });
      expect(execute).not.toHaveBeenCalled();
    }
  });

  it("admits, remembers the key on the request, and takes the read profile when none is stored", async () => {
    const { req } = request();
    const admitted = await admitKey(
      req,
      key("ai_operator", { toolProfile: null, label: "synthetic" }),
      "native",
    );
    expect(admitted).toMatchObject({
      id: 7,
      label: "synthetic",
      toolProfile: "read",
      path: "native",
      user: { id: 3, role: "ai_operator" },
    });
    expect(admittedKeyOf(req)).toBe(admitted);
  });

  it("skips the last-used write inside 60 s, and never refuses when it fails", async () => {
    const recent = request();
    await admitKey(
      recent.req,
      key("automation", {
        lastUsedAt: new Date(Date.now() - 30_000).toISOString(),
      }),
      "plugin",
    );
    expect(lastUsedWrites(recent.execute)).toHaveLength(0);

    const stale = request();
    await admitKey(
      stale.req,
      key("automation", {
        lastUsedAt: new Date(Date.now() - 61_000).toISOString(),
      }),
      "plugin",
    );
    expect(lastUsedWrites(stale.execute)).toHaveLength(1);

    const failing = request(
      vi.fn<ExecuteQuery>((query) =>
        isLastUsedWrite(query)
          ? Promise.reject(new Error("db"))
          : Promise.resolve({ rows: [] }),
      ),
    );
    await expect(
      admitKey(failing.req, key("ai_operator"), "native"),
    ).resolves.toMatchObject({ id: 7 });
    expect(category(failing.req)).toEqual({
      category: "ADMIN_MCP_LAST_USED_WRITE_FAILED",
    });
  });

  it("takes the pause from the control row, and reads a row never saved as not paused", async () => {
    const paused = request(
      vi.fn<ExecuteQuery>(() =>
        Promise.resolve({ rows: [{ ...CONTROL_ROW, pause: true }] }),
      ),
    );
    await expect(
      admitKey(paused.req, key("ai_operator"), "native"),
    ).resolves.toMatchObject({ paused: true });
    const unsaved = request();
    await expect(
      admitKey(unsaved.req, key("ai_operator"), "native"),
    ).resolves.toMatchObject({ paused: false });
  });

  it("answers 503 when it cannot read the pause, before stamping last used", async () => {
    for (const path of ["native", "plugin"] as const) {
      const { req, execute } = request(
        vi.fn<ExecuteQuery>(() => Promise.reject(new Error("db"))),
      );
      await expect(
        admitKey(
          req,
          key(path === "native" ? "ai_operator" : "automation"),
          path,
        ),
      ).rejects.toMatchObject({
        status: 503,
        message: "MCP_CONTROL_UNAVAILABLE",
        name: "MCP_CONTROL_UNAVAILABLE",
        data: { code: "MCP_CONTROL_UNAVAILABLE" },
      });
      expect(req.payload.logger.error).toHaveBeenCalledWith({
        category: "ADMIN_MCP_CONTROL_READ_FAILED",
      });
      expect(lastUsedWrites(execute)).toHaveLength(0);
      expect(admittedKeyOf(req)).toBeUndefined();
    }
  });
});

describe("the key door around the connection door", () => {
  const request = (authorization: string, rows: unknown[] = []) =>
    ({
      headers: new Headers({ authorization }),
      payload: {
        db: { drizzle: { execute: vi.fn(() => Promise.resolve({ rows })) } },
        logger: { warn: vi.fn(), error: vi.fn() },
      },
    }) as unknown as PayloadRequest;
  const stored = {
    id: 7,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    "payload-mcp-tool": { editorialQuery: true, artvennUsersFind: false },
    user: { id: 3, role: "automation" },
  };

  it("refuses a connection token with the surface off, never asking for a key", async () => {
    const resolver = vi.fn();
    await expect(
      withKeyDoor(connectionOverrideAuth(null))(
        request(bearerForged),
        resolver,
      ),
    ).rejects.toBeInstanceOf(UnauthorizedError);
    expect(resolver).not.toHaveBeenCalled();
  });

  it("leaves what a composed connection door answers alone", async () => {
    const settings = { user: { id: "connection" } } as never;
    const req = request(bearerAny);
    await expect(
      withKeyDoor(() => Promise.resolve(settings))(req, vi.fn()),
    ).resolves.toBe(settings);
    expect(admittedKeyOf(req)).toBeUndefined();
  });

  it("adds admin_whoami to an automation key's stored ticks and nothing else", async () => {
    const req = request("Bearer key");
    const settings = await withKeyDoor(connectionOverrideAuth(null))(req, () =>
      Promise.resolve(stored as never),
    );
    expect(settings["payload-mcp-tool"]).toEqual({
      editorialQuery: true,
      artvennUsersFind: false,
      adminWhoami: true,
    });
    expect(admittedKeyOf(req)?.path).toBe("plugin");
  });

  it("narrows an automation key to admin_whoami while paused", async () => {
    const req = request("Bearer key", [{ ...CONTROL_ROW, pause: true }]);
    const settings = await withKeyDoor(connectionOverrideAuth(null))(req, () =>
      Promise.resolve(stored as never),
    );
    expect(settings["payload-mcp-tool"]).toEqual({ adminWhoami: true });
    expect(admittedKeyOf(req)?.paused).toBe(true);
  });

  it("stops a connection token while paused too, with nothing listed", async () => {
    const settings = {
      user: { id: "connection" },
      "payload-mcp-tool": { artvennUsersFind: true },
    } as never;
    const req = request(bearerAny, [{ ...CONTROL_ROW, pause: true }]);
    const narrowed = await withKeyDoor(() => Promise.resolve(settings))(
      req,
      vi.fn(),
    );
    expect(narrowed["payload-mcp-tool"]).toEqual({ adminWhoami: false });
    expect(admittedKeyOf(req)).toBeUndefined();
  });

  it("logs a generic refusal from the plugin's lookup, and not a database failure", async () => {
    const refused = request("Bearer key");
    await expect(
      withKeyDoor(connectionOverrideAuth(null))(refused, () =>
        Promise.reject(new UnauthorizedError()),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedError);
    expect(refused.payload.logger.warn).toHaveBeenCalledWith({
      category: "ADMIN_MCP_KEY_REFUSED",
    });
    const broken = request("Bearer key");
    await expect(
      withKeyDoor(connectionOverrideAuth(null))(broken, () =>
        Promise.reject(new Error("db")),
      ),
    ).rejects.toThrow("db");
    expect(broken.payload.logger.warn).not.toHaveBeenCalled();
  });
});

describe("dispatch", () => {
  const request = (
    authorization: string | null,
    docs: unknown[] = [],
    method = "POST",
  ) => {
    const find = vi.fn(() => Promise.resolve({ docs }));
    return {
      find,
      req: {
        method,
        headers: new Headers(authorization ? { authorization } : {}),
        payload: {
          secret: "synthetic",
          find,
          db: {
            drizzle: { execute: vi.fn(() => Promise.resolve({ rows: [] })) },
          },
          logger: { warn: vi.fn(), error: vi.fn() },
        },
      } as unknown as PayloadRequest,
    };
  };
  const keyFor = (role: string, user: unknown = { id: 3, role }) => ({
    id: 7,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    user,
  });
  const fromPlugin = new Response("plugin");

  it.each([
    ["no credential", request(null)],
    ["a connection token, with no lookup", request(bearerAny)],
    ["a lowercase scheme, as the plugin reads it", request("bearer abc")],
    ["an unknown key", request("Bearer abc")],
    ["an automation key", request("Bearer abc", [keyFor("automation")])],
    ["an Owner-bound key", request("Bearer abc", [keyFor("owner")])],
    ["a key with no user", request("Bearer abc", [keyFor("x", null)])],
  ])("hands %s to the plugin untouched", async (label, { req, find }) => {
    const plugin = vi.fn(() => Promise.resolve(fromPlugin));
    await expect(adminMcpDispatch(plugin)(req)).resolves.toBe(fromPlugin);
    expect(plugin).toHaveBeenCalledOnce();
    if (label.includes("no lookup") || label.includes("credential"))
      expect(find).not.toHaveBeenCalled();
    expect(req.user).toBeUndefined();
  });

  it("sends an ai_operator key to the native handler, with the MCP request shape", async () => {
    const plugin = vi.fn(() => Promise.resolve(fromPlugin));
    const { req } = request("Bearer abc", [keyFor("ai_operator")], "GET");
    const answer = await adminMcpDispatch(plugin)(req);
    expect(answer.status).toBe(405);
    expect(answer.headers.get("allow")).toBe("POST");
    expect(plugin).not.toHaveBeenCalled();
    expect(req.payloadAPI).toBe("MCP");
    expect(req.user).toMatchObject({
      id: 3,
      collection: "users",
      _strategy: "mcp-api-key",
    });
  });

  it("declares a later order than the MCP plugin, because Payload sorts by it", () => {
    // The MCP plugin declares 10. The protocol test proves the wrapping itself.
    expect(adminMcpDispatchPlugin().order).toBe(11);
  });
});

describe("fixed log categories", () => {
  it.each([
    "ADMIN_MCP_KEY_REFUSED",
    "ADMIN_MCP_KEY_EXPIRED",
    "ADMIN_MCP_KEY_OWNER_BOUND",
    "ADMIN_MCP_LAST_USED_WRITE_FAILED",
    "ADMIN_MCP_TOOL_FAILED",
    "ADMIN_MCP_CONTROL_READ_FAILED",
    "ADMIN_MCP_AUDIT_WRITE_FAILED",
  ])("passes %s and nothing else", (category) => {
    const fields = cmsRuntimeLogFields([{ category, key: "secret-value" }]);
    expect(fields).toMatchObject({ category });
    expect(JSON.stringify(fields)).not.toContain("secret-value");
  });
});

describe("Nginx template", () => {
  it("limits /api/mcp as a whole path, classed machine-api before the admin-api rule", async () => {
    const template = await read("infra/production/nginx/yoyi.conf.template");
    expect(template).toContain(
      "limit_req_zone $server_name zone=yoyi_mcp:1m rate=10r/s;",
    );
    expect(template.indexOf("~^/api/mcp(?:/|$) machine-api;")).toBeGreaterThan(
      -1,
    );
    expect(template.indexOf("~^/api/mcp(?:/|$) machine-api;")).toBeLessThan(
      template.indexOf("~^/api/ admin-api;"),
    );
    const start = template.indexOf("location = /api/mcp {");
    expect(start).toBeGreaterThan(-1);
    const body = template.slice(start, template.indexOf("}", start));
    expect(body).toContain("limit_req zone=yoyi_mcp burst=40;");
    expect(body).toContain("limit_req_status 429;");
    expect(body).toContain("client_max_body_size 4m;");
    expect(body).toContain("proxy_pass http://yoyi_admin;");
  });
});

describe("dependency", () => {
  it("references the locked SDK directly from Admin and moves nothing else", async () => {
    const manifest = JSON.parse(await read("apps/admin/package.json")) as {
      dependencies: Record<string, string>;
    };
    expect(manifest.dependencies["@modelcontextprotocol/sdk"]).toBe("1.30.0");
    const lockfile = await read("pnpm-lock.yaml");
    expect(lockfile).toMatch(
      /apps\/admin:\n[\s\S]*?'@modelcontextprotocol\/sdk':\n\s+specifier: 1\.30\.0\n\s+version: 1\.30\.0\(zod@4\.4\.3\)/u,
    );
    // A re-resolving install would move this peer; the plugin's tools are zod 3.
    expect(lockfile).toContain(
      "mcp-handler@1.1.0(@modelcontextprotocol/sdk@1.30.0(zod@3.25.76))",
    );
  });
});
