import {
  ADMIN_OP_NAMES,
  type AdminOpClass,
} from "@moya/contracts/internal/admin-mcp";
import {
  adminOpMeta,
  isIssuedTicket,
  issueRunTicket,
  okEnvelope,
  requestKeyFor,
  requireAdmission,
  routeCheckedAiCall,
  runTarget,
  type AdminOpContext,
  type AdminOpEntry,
  type RunTicket,
} from "admin/admin-mcp";
import type { PayloadRequest } from "payload";
import { beforeEach, describe, expect, it, vi } from "vitest";

// What stands between a target and an irreversible effect before any run exists
// (admin-mcp-completion-v1 S8, plan 2.8). A CMS write that may bind an identity for
// good runs only through the per-target core, admitted at the class it read; a
// community write carries a run id only under a ticket the run executor issued; an
// irreversible route never leaves the Admin without one.

const recorded = vi.hoisted(
  () =>
    [] as {
      credential: string;
      headers: Record<string, string>;
      method: string;
      path: string;
    }[],
);

vi.mock(import("admin/community-backend"), async (importOriginal) => {
  const actual = await importOriginal();
  const recording =
    (credential: string, headers: Record<string, string> = {}) =>
    async (method: string, path: string) => {
      recorded.push({ credential, headers: { ...headers }, method, path });
      throw new actual.CommunityOperatorError("OPERATOR_UNAVAILABLE", 503);
    };
  return {
    ...actual,
    callAiOperator: recording as unknown as typeof actual.callAiOperator,
  };
});

beforeEach(() => {
  recorded.length = 0;
});

const RUN_ID = "00000000-0000-4000-8000-0000000000b1";
const requestKey = requestKeyFor("00000000-0000-4000-8000-000000000001", 0);
const contextOf = (run?: RunTicket): AdminOpContext => ({
  req: {} as PayloadRequest,
  key: {} as never,
  requestKey,
  ...(run === undefined ? {} : { run }),
});
const forged = (): RunTicket => ({ runId: RUN_ID });

/** An op whose class is what `klass` says, and whose run asks for its admission. */
const fakeOp = (klass: AdminOpClass) => {
  const seen: { classified?: AdminOpContext; ran?: AdminOpContext } = {};
  const entry: AdminOpEntry = {
    summary: "Synthetic op.",
    klass: "reversible",
    tool: "admin_execute",
    credential: "none",
    recovery: "receipt",
    completion: { kind: "sync" },
    untrusted: [],
    classify: async (_raw, context) => {
      seen.classified = context;
      return klass;
    },
    run: async (_raw, context) => {
      seen.ran = context;
      requireAdmission(context);
      return okEnvelope({ id: 7 });
    },
  };
  return { entry, seen };
};

const outcome = (
  klass: AdminOpClass,
  allow: "reversible" | "irreversible",
  run?: RunTicket,
) => {
  const { entry, seen } = fakeOp(klass);
  return runTarget(entry, {}, 0, contextOf(run), allow).then((answer) => ({
    answer,
    seen,
  }));
};

describe("a CMS write that may bind an identity for good", () => {
  const rising = ADMIN_OP_NAMES.filter((op) => {
    const entry = adminOpMeta[op];
    return (
      entry.credential === "none" &&
      entry.run !== undefined &&
      (entry.klass === "irreversible" || entry.classify !== undefined)
    );
  });

  // A new one is named here, and its run asks for its admission first.
  it("is each save, the collection save and a media registration", () => {
    expect([...rising].sort()).toEqual(
      [
        "collection.save",
        "editorial.save-article-draft",
        "editorial.save-draft",
        "media.register_existing",
      ].sort(),
    );
  });

  it.each(rising)(
    "%s refuses a direct call of its run before it reads anything",
    async (op) => {
      const entry = adminOpMeta[op];
      for (const run of [undefined, forged(), issueRunTicket(RUN_ID)])
        await expect(
          entry.run!(entry.example, contextOf(run)),
          String(run?.runId),
        ).rejects.toThrow("RUN_ADMISSION_REQUIRED");
    },
  );
});

describe("the per-target core", () => {
  it("never runs a target that rose past what the call allows", async () => {
    const { answer, seen } = await outcome("irreversible", "reversible");
    expect(answer).toEqual({
      index: 0,
      state: "failed",
      code: "PREVIEW_REQUIRED",
    });
    expect(seen.ran).toBeUndefined();
    expect((await outcome("read", "irreversible")).answer.code).toBe(
      "PREVIEW_REQUIRED",
    );
  });

  it("admits a reversible target on the very context its class was read on", async () => {
    const { answer, seen } = await outcome("reversible", "reversible");
    expect(answer).toMatchObject({ state: "applied", code: "OK", id: 7 });
    expect(seen.ran).toBe(seen.classified);
    // The admission is that context's own: a copy of it carries none.
    expect(() => requireAdmission({ ...seen.ran! })).toThrow(
      "RUN_ADMISSION_REQUIRED",
    );
  });

  it("admits an irreversible target only inside a ticket the executor issued", async () => {
    for (const run of [undefined, forged()])
      expect(
        (await outcome("irreversible", "irreversible", run)).answer,
        String(run?.runId),
      ).toMatchObject({ state: "failed", code: "RUN_ADMISSION_REQUIRED" });
    expect(
      (await outcome("irreversible", "irreversible", issueRunTicket(RUN_ID)))
        .answer,
    ).toMatchObject({ state: "applied", code: "OK" });
  });
});

describe("a run ticket", () => {
  it("names one run id, and only an issued one counts", () => {
    expect(() => issueRunTicket("synthetic")).toThrow("RUN_TICKET_INVALID");
    expect(() => issueRunTicket(RUN_ID.toUpperCase())).toThrow(
      "RUN_TICKET_INVALID",
    );
    const ticket = issueRunTicket(RUN_ID);
    expect(Object.isFrozen(ticket)).toBe(true);
    expect(isIssuedTicket(ticket)).toBe(true);
    expect(isIssuedTicket(forged())).toBe(false);
    expect(isIssuedTicket({ ...ticket })).toBe(false);
    expect(isIssuedTicket(undefined)).toBe(false);
  });
});

describe("an AI route call", () => {
  const erase = "ai/catalog-master/erase";

  it("never sends an irreversible write without a run id", async () => {
    for (const headers of [{}, { "x-admin-mcp-run": "synthetic" }])
      await expect(
        routeCheckedAiCall("base", headers)("POST", erase, {}),
        JSON.stringify(headers),
      ).rejects.toMatchObject({ code: "AI_RUN_REQUIRED", status: 403 });
    expect(recorded).toEqual([]);
    await expect(
      routeCheckedAiCall("base", { "x-admin-mcp-run": RUN_ID })(
        "POST",
        erase,
        {},
      ),
    ).rejects.toMatchObject({ code: "OPERATOR_UNAVAILABLE" });
    expect(recorded).toMatchObject([{ method: "POST", path: erase }]);
  });

  it("sends a reversible write as it always has", async () => {
    await expect(
      routeCheckedAiCall("base")("POST", "ai/catalog-master/attach", {}),
    ).rejects.toMatchObject({ code: "OPERATOR_UNAVAILABLE" });
    expect(recorded).toHaveLength(1);
  });
});

describe("a community write", () => {
  const entry = adminOpMeta["community.set-report-metadata"];
  const release = {
    id: entry.example!.id,
    expectedVersion: 3,
    legalHold: false,
  };
  const sentHeaders = () =>
    recorded
      .filter(({ method }) => method === "POST")
      .map(({ headers }) => headers);

  it("carries the run id only under an issued ticket", async () => {
    await runTarget(
      entry,
      release,
      0,
      contextOf(issueRunTicket(RUN_ID)),
      "irreversible",
    );
    expect(sentHeaders()).toEqual([
      expect.objectContaining({ "x-admin-mcp-run": RUN_ID }),
    ]);
    for (const run of [undefined, forged()]) {
      recorded.length = 0;
      await runTarget(entry, release, 0, contextOf(run), "irreversible");
      expect(sentHeaders(), String(run?.runId)).toHaveLength(1);
      expect(sentHeaders()[0], String(run?.runId)).not.toHaveProperty(
        "x-admin-mcp-run",
      );
    }
  });

  it("answers PREVIEW_REQUIRED on admin_execute and sends nothing", async () => {
    expect(
      await runTarget(entry, release, 0, contextOf(), "reversible"),
    ).toEqual({
      index: 0,
      id: entry.example!.id,
      state: "failed",
      code: "PREVIEW_REQUIRED",
    });
    expect(recorded).toEqual([]);
  });
});
