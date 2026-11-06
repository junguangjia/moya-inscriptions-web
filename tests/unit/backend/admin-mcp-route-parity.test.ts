import {
  ADMIN_OP_NAMES,
  aiOperatorRouteFor,
  type AdminMcpSensitiveCategory,
  type AiOperatorRoute,
  type AiOperatorRouteClass,
} from "@moya/contracts/internal/admin-mcp";
import { adminOpMeta, requestKeyFor, type AdminOpEntry } from "admin/admin-mcp";
import {
  communityOperationDefinitions,
  type CommunityOperationName,
  type OperatorCall,
} from "admin/community-endpoints";
import type { PayloadRequest } from "payload";
import { describe, expect, it, vi } from "vitest";

import { AI_ROUTE_PENDING, NOT_BUILT } from "./admin-mcp-not-built.js";

// Every op that calls the Backend on an AI credential has its row in AI_OPERATOR_ROUTES,
// of its own class and on its own credential, so a built op is never one the Backend
// always refuses. Each op runs its own example over a call that records and answers as
// an unreachable Backend, so the first call it makes is the one checked. An op not built
// yet runs its route's definition, and its route has a row or is pending for its slice.

const recorded = vi.hoisted(
  () => [] as { credential: string; method: string; path: string }[],
);

vi.mock(import("admin/community-backend"), async (importOriginal) => {
  const actual = await importOriginal();
  const recording =
    (credential: string) => async (method: string, path: string) => {
      recorded.push({ credential, method, path });
      throw new actual.CommunityOperatorError("OPERATOR_UNAVAILABLE", 503);
    };
  return {
    ...actual,
    callAiOperator: recording as unknown as typeof actual.callAiOperator,
  };
});

const CLASS_ROUTE = {
  read: "read",
  reversible: "write",
  irreversible: "irreversible",
} as const satisfies Record<AdminOpEntry["klass"], AiOperatorRouteClass>;

const SENSITIVE_ROUTE: Readonly<
  Partial<Record<AdminMcpSensitiveCategory, AiOperatorRouteClass>>
> = {
  dm: "sensitive:dm",
  evidence: "sensitive:evidence",
  rawIp: "sensitive:raw_ip",
};

const routeClassOf = ({ klass, sensitive }: AdminOpEntry) =>
  sensitive === undefined ? CLASS_ROUTE[klass] : SENSITIVE_ROUTE[sensitive];

/** What a route's `selfOnly` can name: a target of one of these may be withheld. */
const SELF_ONLY_SUBJECTS: readonly string[] = [
  "work",
  "comment",
  "work_revision",
  "article",
  "report",
  "publishing_job",
] satisfies readonly NonNullable<AiOperatorRoute["selfOnly"]>[];

/** As callAiOperator sends it: under internal/community, query and all. */
const rowOf = ({ method, path }: { method: string; path: string }) => {
  const { pathname, searchParams } = new URL(
    `/internal/community/${path}`,
    "http://route.invalid",
  );
  return {
    at: `${method} ${pathname}`,
    pathname,
    row: aiOperatorRouteFor(method, pathname, searchParams),
  };
};

const segmentsMatch = (pattern: string, pathname: string) => {
  const expected = pattern.split("/");
  const actual = pathname.split("/");
  return (
    expected.length === actual.length &&
    expected.every(
      (segment, index) =>
        actual[index] === segment ||
        (segment.startsWith(":") && actual[index] !== ""),
    )
  );
};

const req = {} as PayloadRequest;
const requestKey = requestKeyFor("00000000-0000-4000-8000-000000000001", 0);

const builtOnBackend = ADMIN_OP_NAMES.filter(
  (op) =>
    adminOpMeta[op].run !== undefined && adminOpMeta[op].credential !== "none",
);
const unbuiltCommunity = ADMIN_OP_NAMES.filter(
  (op) => op.startsWith("community.") && adminOpMeta[op].run === undefined,
);

describe("a built op on an AI credential", () => {
  it("is in this walk at all", () => {
    expect(builtOnBackend.length).toBeGreaterThan(40);
  });

  it.each(builtOnBackend)(
    "%s calls only routes with its AI row, class and credential",
    async (op) => {
      const entry = adminOpMeta[op];
      const input =
        entry.klass === "read"
          ? (entry.input?.parse(entry.example ?? {}) ?? {})
          : entry.example;
      recorded.length = 0;
      const answer: unknown = await entry.run!(input, {
        req,
        key: {} as never,
        read: {},
        requestKey,
      }).catch((error: unknown) => error);
      expect(
        recorded.length,
        `no Backend call; answered ${JSON.stringify((answer as { code?: unknown }).code ?? String(answer))}`,
      ).toBeGreaterThan(0);
      const subject = entry.target?.(entry.example).type;
      for (const call of recorded) {
        const { at, row } = rowOf(call);
        expect(row, at).toBeDefined();
        expect(row!.credentials, at).toContain(call.credential);
        expect(call.credential, at).toBe(entry.credential);
        expect(row!.klass, at).toBe(routeClassOf(entry));
        if (subject !== undefined && SELF_ONLY_SUBJECTS.includes(subject))
          expect(row!.selfOnly, at).toBe(subject);
      }
    },
  );
});

describe("a community op not built yet", () => {
  it.each(unbuiltCommunity)(
    "%s will call a route with its row, or one pending for its slice",
    async (op) => {
      const entry = adminOpMeta[op];
      const definition =
        communityOperationDefinitions[
          op.slice("community.".length) as CommunityOperationName
        ];
      const calls: { method: string; path: string }[] = [];
      const recorder: OperatorCall = async <Result>(
        method: string,
        path: string,
      ) => {
        calls.push({ method, path });
        return {} as Result;
      };
      await definition.run(
        definition.input.parse(entry.example),
        recorder,
        req,
      );
      expect(calls).toHaveLength(1);
      const { at, pathname, row } = rowOf(calls[0]!);
      const pending = AI_ROUTE_PENDING.filter((route) => route.op === op);
      if (row !== undefined) {
        expect(pending, at).toEqual([]);
        expect(row.klass, at).toBe(routeClassOf(entry));
        return;
      }
      expect(pending, at).toHaveLength(1);
      expect(pending[0]!.method, at).toBe(calls[0]!.method);
      expect(segmentsMatch(pending[0]!.path, pathname), at).toBe(true);
      expect(NOT_BUILT[pending[0]!.slice], at).toContain(op);
    },
  );

  it("keeps no pending route that has a row now, or whose op is built", () => {
    for (const { op, method, path } of AI_ROUTE_PENDING) {
      expect(adminOpMeta[op].run, op).toBeUndefined();
      expect(
        aiOperatorRouteFor(
          method,
          path.replaceAll(/:\w+/gu, "x"),
          new URLSearchParams(),
        ),
        op,
      ).toBeUndefined();
    }
  });
});
