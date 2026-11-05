import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import {
  communityRefusal,
  COMMUNITY_READ_POOL_SHARE,
  createPoolSlots,
  findEnvelope,
  inPoolShare,
} from "admin/admin-mcp";
import {
  callAiOperator,
  CommunityOperatorError,
} from "admin/community-backend";
import { afterEach, describe, expect, it, vi } from "vitest";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A Backend stand-in whose calls wait until the test ends each one. */
const held = () => {
  const reached: { end: () => void; fail: (error: Error) => void }[] = [];
  const backend = async <Result>(): Promise<Result> =>
    new Promise<Result>((resolve, reject) => {
      reached.push({
        end: () => resolve({} as Result),
        fail: reject,
      });
    });
  return { backend, reached };
};

const limits = (waitMs: number, holdMs: number) => ({
  slots: createPoolSlots(COMMUNITY_READ_POOL_SHARE),
  waitMs,
  holdMs,
});

describe("community reads' share of the App pool", () => {
  it("lets a third call reach the Backend only once a slot frees", async () => {
    const { backend, reached } = held();
    const call = inPoolShare(backend, limits(5_000, 5_000));
    const first = call("GET", "a");
    const second = call("GET", "b");
    const third = call("GET", "c");
    await sleep(50);
    expect(reached).toHaveLength(COMMUNITY_READ_POOL_SHARE);
    reached[0]!.end();
    await first;
    await vi.waitFor(() => expect(reached).toHaveLength(3));
    reached[1]!.end();
    reached[2]!.end();
    await Promise.all([second, third]);
  });

  it("answers READ_TIMED_OUT past the wait, never reaches the Backend, and hands its turn back unused", async () => {
    const { backend, reached } = held();
    const share = limits(100, 5_000);
    const call = inPoolShare(backend, share);
    const holders = [call("GET", "a"), call("GET", "b")];
    const waited = Date.now();
    const refused = await call("GET", "c").catch((error: unknown) => error);
    expect(Date.now() - waited).toBeLessThan(2_000);
    expect(refused).toBeInstanceOf(CommunityOperatorError);
    expect(refused).toMatchObject({ code: "READ_TIMED_OUT", status: 503 });
    expect(reached).toHaveLength(COMMUNITY_READ_POOL_SHARE);
    // It goes to the caller by name, with no number.
    const envelope = communityRefusal(refused);
    expect(envelope).toMatchObject({
      ok: false,
      code: "READ_TIMED_OUT",
      retryable: true,
    });
    expect(envelope).not.toHaveProperty("data");
    reached[0]!.end();
    reached[1]!.end();
    await Promise.all(holders);
    // The late turn reached nothing, and its slot came back with the others.
    const after = [call("GET", "d"), call("GET", "e")];
    await vi.waitFor(() => expect(reached).toHaveLength(4));
    reached[2]!.end();
    reached[3]!.end();
    await Promise.all(after);
  });

  it("keeps the slot of a call given up on until the Backend's read can have ended", async () => {
    const { backend, reached } = held();
    const call = inPoolShare(backend, limits(5_000, 300));
    const lost = call("GET", "a").catch((error: unknown) => error);
    const other = call("GET", "b");
    await vi.waitFor(() => expect(reached).toHaveLength(2));
    const third = call("GET", "c");
    reached[0]!.fail(new CommunityOperatorError("OPERATOR_GAVE_UP", 502));
    expect(await lost).toMatchObject({ code: "OPERATOR_GAVE_UP" });
    await sleep(100);
    expect(reached).toHaveLength(2);
    await vi.waitFor(() => expect(reached).toHaveLength(3));
    reached[1]!.end();
    reached[2]!.end();
    await Promise.all([other, third]);
  });

  it("frees the slot at once on a refused connection and on a named refusal, because no read runs on", async () => {
    const { backend, reached } = held();
    const call = inPoolShare(backend, limits(5_000, 60_000));
    for (const code of [
      "OPERATOR_UNREACHABLE",
      "READ_TIMED_OUT",
      "NOT_FOUND",
    ]) {
      const before = reached.length;
      const answers = [
        call("GET", "a").catch((error: unknown) => error),
        call("GET", "b").catch((error: unknown) => error),
      ];
      await vi.waitFor(() => expect(reached).toHaveLength(before + 2));
      for (const { fail } of reached.slice(before))
        fail(new CommunityOperatorError(code, 502));
      for (const answer of await Promise.all(answers))
        expect(answer).toMatchObject({ code });
    }
  });
});

describe("the AI's call to the Backend", () => {
  const servers: Server[] = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    for (const server of servers.splice(0)) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  const stubbed = (origin: string) => {
    vi.stubEnv("COMMUNITY_OPERATOR_BASE_URL", origin);
    vi.stubEnv(
      "COMMUNITY_OPERATOR_AI_TOKEN",
      randomBytes(32).toString("base64url"),
    );
  };

  it("names a call given up on at its limit apart from a refused connection", async () => {
    const hung = createServer(() => undefined);
    servers.push(hung);
    await new Promise<void>((resolve) =>
      hung.listen(0, "127.0.0.1", () => resolve()),
    );
    stubbed(`http://127.0.0.1:${(hung.address() as AddressInfo).port}/`);
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => timeout(50));
    const gaveUp = await callAiOperator("community")("GET", "reports").catch(
      (error: unknown) => error,
    );
    expect(gaveUp).toMatchObject({ code: "OPERATOR_GAVE_UP", status: 502 });
    // Still the store could not be read, to whoever asked.
    expect(communityRefusal(gaveUp).code).toBe("COMMUNITY_UNAVAILABLE");

    stubbed("http://127.0.0.1:9/");
    expect(
      await callAiOperator("community")("GET", "reports").catch(
        (error: unknown) => error,
      ),
    ).toMatchObject({ code: "OPERATOR_UNREACHABLE", status: 502 });
  });

  it("names an answer lost after its headers the same way, and holds the slot only of one given up on", async () => {
    const reached: number[] = [];
    let ending: "stall" | "reset" | "garbage" = "stall";
    const backend = createServer((_request, response) => {
      reached.push(Date.now());
      response.writeHead(200, { "content-type": "application/json" });
      if (ending === "garbage") {
        response.end("not json");
        return;
      }
      response.write('{"items":');
      if (ending === "reset") setTimeout(() => response.destroy(), 10);
    });
    servers.push(backend);
    await new Promise<void>((resolve) =>
      backend.listen(0, "127.0.0.1", () => resolve()),
    );
    stubbed(`http://127.0.0.1:${(backend.address() as AddressInfo).port}/`);
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => timeout(500));
    const call = inPoolShare(callAiOperator("community"), {
      slots: createPoolSlots(1),
      waitMs: 5_000,
      holdMs: 1_500,
    });
    const answerOf = () =>
      call("GET", "reports").catch((error: unknown) => error);

    // Past the abort the Backend's read may still run, so its slot stays taken.
    const stalled = await answerOf();
    const gaveUpAt = Date.now();
    expect(stalled).toBeInstanceOf(CommunityOperatorError);
    expect(stalled).toMatchObject({ code: "OPERATOR_GAVE_UP", status: 502 });
    expect(communityRefusal(stalled).code).toBe("COMMUNITY_UNAVAILABLE");

    ending = "reset";
    const reset = await answerOf();
    expect(reached[1]! - gaveUpAt).toBeGreaterThanOrEqual(1_400);
    expect(reset).toBeInstanceOf(CommunityOperatorError);
    expect(reset).toMatchObject({ code: "OPERATOR_UNREACHABLE", status: 502 });
    expect(communityRefusal(reset).code).toBe("COMMUNITY_UNAVAILABLE");

    // A reset or a body that is not JSON means the Backend has finished: free at once.
    ending = "garbage";
    const nextAt = Date.now();
    const garbage = await answerOf();
    expect(reached[2]! - nextAt).toBeLessThan(1_000);
    expect(garbage).toBeInstanceOf(CommunityOperatorError);
    expect(garbage).toMatchObject({
      code: "OPERATOR_UNREACHABLE",
      status: 502,
    });
  });
});

describe("admin_find on a Backend that answers call by call", () => {
  const servers: Server[] = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    for (const server of servers.splice(0)) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  const SCOPE = { tools: [], userId: 9, switches: {} };
  const idOf = (prefix: string) =>
    `${prefix}-${randomBytes(16).toString("hex")}`;
  const linkTo = (parameters: string) => `https://x.example/?${parameters}`;

  const none = (source: string) =>
    [200, { items: [], sources: { [source]: "ok" }, excluded: [] }] as const;
  const unavailable = [503, { error: { status: 503, code: "X" } }] as const;
  const threadHit = (id: string) =>
    [
      200,
      {
        items: [
          {
            type: "thread",
            id,
            title: "synthetic",
            state: "open",
            disambiguators: {},
            match: { field: "id", kind: "identity" },
          },
        ],
        sources: { threads: "ok" },
        excluded: [],
      },
    ] as const;

  /** Answers each call in turn, and keeps the id each one asked for. */
  const backendAnswering = async (
    answers: readonly (readonly [number, unknown])[],
    onCall?: () => void,
  ) => {
    const asked: string[] = [];
    const server = createServer((request, response) => {
      asked.push(
        new URL(request.url ?? "/", "http://stub").searchParams.get("id") ?? "",
      );
      onCall?.();
      const [status, body] = answers[asked.length - 1]!;
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    });
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", () => resolve()),
    );
    vi.stubEnv(
      "COMMUNITY_OPERATOR_BASE_URL",
      `http://127.0.0.1:${(server.address() as AddressInfo).port}/`,
    );
    vi.stubEnv(
      "COMMUNITY_OPERATOR_AI_TOKEN",
      randomBytes(32).toString("base64url"),
    );
    return asked;
  };

  const find = (query: string, req: object = {}) =>
    findEnvelope(req as never, { query }, SCOPE) as Promise<{
      data: { resolution: { status: string }; items: { id: string }[] };
      meta: { sources: Record<string, string>; partial?: true };
    }>;

  it.each([
    ["a call that failed", unavailable, "failed"],
    [
      "a source the Backend itself named timed out",
      [200, { items: [], sources: { works: "timed_out" }, excluded: [] }],
      "timed_out",
    ],
    [
      "a source the Backend itself named failed",
      [200, { items: [], sources: { works: "failed" }, excluded: [] }],
      "failed",
    ],
  ] as const)(
    "keeps %s when a later call of the same source answers",
    async (_label, first, status) => {
      const [a, b] = [idOf("work"), idOf("work")];
      const asked = await backendAnswering([first, none("works")]);
      const { data, meta } = await find(linkTo(`workId=${a}&workId=${b}`));
      expect(asked).toEqual([a, b]);
      expect(meta.sources).toEqual({ works: status });
      expect(meta.partial).toBe(true);
      expect(data.resolution.status).toBe("none");
    },
  );

  it("keeps a failure whichever call it was", async () => {
    const [a, b] = [idOf("work"), idOf("work")];
    await backendAnswering([none("works"), unavailable]);
    const { meta } = await find(linkTo(`workId=${a}&workId=${b}`));
    expect(meta.sources).toEqual({ works: "failed" });
    expect(meta.partial).toBe(true);
  });

  it("keeps it beside a hit on the same source, as the product's own address can name two topics", async () => {
    const [a, b] = [idOf("thread"), idOf("thread")];
    const asked = await backendAnswering([unavailable, threadHit(b)]);
    const { data, meta } = await find(
      `https://x.example/?topic=${a}#topic-${b}`,
    );
    expect(asked).toEqual([a, b]);
    expect(data.resolution.status).toBe("candidates");
    expect(data.items.map(({ id }) => id)).toEqual([b]);
    expect(meta.sources).toEqual({ threads: "failed" });
    expect(meta.partial).toBe(true);
  });

  it("keeps it when the second id can name no record and takes no call", async () => {
    const a = idOf("work");
    const asked = await backendAnswering([unavailable]);
    const { data, meta } = await find(linkTo(`workId=${a}&workId=a%20b`));
    expect(asked).toEqual([a]);
    expect(data.resolution.status).toBe("none");
    expect(meta.sources).toEqual({ works: "failed" });
    expect(meta.partial).toBe(true);
  });

  it("reads as whole when every call answered", async () => {
    const [a, b] = [idOf("work"), idOf("work")];
    await backendAnswering([none("works"), none("works")]);
    const { meta } = await find(linkTo(`workId=${a}&workId=${b}`));
    expect(meta.sources).toEqual({ works: "ok" });
    expect(meta.partial).toBeUndefined();
  });

  it("starts no call past the exact stage's deadline, and names what it never asked", async () => {
    const [a, b] = [idOf("work"), idOf("work")];
    const c = idOf("user");
    const [d, e] = [idOf("thread"), idOf("thread")];
    const started = Date.now();
    let passed = 0;
    vi.spyOn(Date, "now").mockImplementation(() => started + passed);
    // Each call costs 15 s, so one starts at 0, 15 and 30 s and none at 45 s.
    const asked = await backendAnswering(
      [none("works"), none("works"), none("users")],
      () => {
        passed += 15_000;
      },
    );
    const { data, meta } = await find(
      linkTo(`workId=${a}&workId=${b}&authorId=${c}&topic=${d}&topic=${e}`),
    );
    expect(asked).toEqual([a, b, c]);
    expect(meta.sources).toEqual({
      works: "ok",
      users: "ok",
      threads: "timed_out",
    });
    expect(meta.partial).toBe(true);
    expect(data.resolution.status).toBe("none");
  });

  it("still asks what the deadline leaves room for", async () => {
    const [a, b] = [idOf("work"), idOf("thread")];
    const started = Date.now();
    let passed = 0;
    vi.spyOn(Date, "now").mockImplementation(() => started + passed);
    const asked = await backendAnswering(
      [none("works"), none("threads")],
      () => {
        passed += 34_000;
      },
    );
    const { meta } = await find(linkTo(`workId=${a}&topic=${b}`));
    expect(asked).toEqual([a, b]);
    expect(meta.sources).toEqual({ works: "ok", threads: "ok" });
    expect(meta.partial).toBeUndefined();
  });

  it("starts no call once the client has gone", async () => {
    const [a, b] = [idOf("work"), idOf("user")];
    const gone = new AbortController();
    const asked = await backendAnswering([none("works")], () => gone.abort());
    const { meta } = await find(linkTo(`workId=${a}&authorId=${b}`), {
      signal: gone.signal,
    });
    expect(asked).toEqual([a]);
    expect(meta.sources).toEqual({ works: "ok", users: "timed_out" });
    expect(meta.partial).toBe(true);
    const never = await find(linkTo(`workId=${a}`), {
      signal: AbortSignal.abort(),
    });
    expect(asked).toEqual([a]);
    expect(never.meta.sources).toEqual({ works: "timed_out" });
  });
});
