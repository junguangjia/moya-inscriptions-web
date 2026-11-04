import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import {
  communityRefusal,
  COMMUNITY_READ_POOL_SHARE,
  createPoolSlots,
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
});
