import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import {
  handleOperatorRequest,
  type OperatorRouteDependencies,
} from "@moya/backend-runtime/internal/community-operator";
import { createCatalogRenderBacklog } from "@moya/backend-production/internal/catalog-delivery";
import {
  catalogRenderBacklogSchema,
  type CatalogRenderBacklogReport,
} from "@moya/contracts/internal/editorial";
import { afterEach, describe, expect, it, vi } from "vitest";

/*
 * catalog-scale-v1 (Issue #323) increment 2, I9: the read-only render-backlog
 * operator route the Admin proxies for the CLI's prepare waves. It answers
 * only the operator credential, only GET, only the contract (counts, no
 * record, image or key), and its App reader issues one SELECT.
 */

const root = fileURLToPath(new URL("../../../", import.meta.url));
const syntheticOperator = "EXPLICIT_SYNTHETIC_PLACEHOLDER";
const route = "/internal/community/catalog-delivery/render-backlog";
type Provider = NonNullable<OperatorRouteDependencies["catalogRenderBacklog"]>;
const counted: CatalogRenderBacklogReport = {
  tiers: { t0: 3, t1: 2, t2: 40, t3: 0, t4: 1_200 },
  countedAt: "2026-10-23T12:00:00.000Z",
  queued: 300,
  running: 1,
};
const uncounted: CatalogRenderBacklogReport = {
  tiers: null,
  countedAt: null,
  queued: 0,
  running: 0,
};

const invoke = async (
  provider: Provider | undefined,
  {
    method = "GET",
    authorization = `Bearer ${syntheticOperator}`,
  }: { method?: string; authorization?: string | null } = {},
) => {
  const writeHead = vi.fn();
  const end = vi.fn();
  const request = Object.assign(Readable.from([]), {
    method,
    url: route,
    headers: authorization === null ? {} : { authorization },
  }) as unknown as IncomingMessage;
  const response = {
    writeHead,
    end,
    headersSent: false,
  } as unknown as ServerResponse;
  await handleOperatorRequest(request, response, route, {
    moderationService: {},
    operatorCredential: syntheticOperator,
    ...(provider ? { catalogRenderBacklog: provider } : {}),
  } as unknown as OperatorRouteDependencies);
  return {
    status: writeHead.mock.calls[0]![0] as number,
    body: JSON.parse(String(end.mock.calls[0]![0])) as unknown,
  };
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Catalog render-backlog operator route", () => {
  it("answers only the operator credential, and only GET", async () => {
    const provider = vi.fn<Provider>(async () => counted);
    for (const authorization of [
      null,
      "Bearer ",
      `Bearer ${syntheticOperator}-other`,
      `Basic ${syntheticOperator}`,
    ])
      expect(await invoke(provider, { authorization })).toEqual({
        status: 401,
        body: { error: { status: 401, code: "OPERATOR_UNAUTHORIZED" } },
      });
    for (const method of ["POST", "PUT", "DELETE"])
      expect(await invoke(provider, { method })).toMatchObject({
        status: 405,
        body: { error: { code: "METHOD_NOT_ALLOWED" } },
      });
    expect(provider).not.toHaveBeenCalled();
    expect(await invoke(undefined)).toEqual({
      status: 503,
      body: { error: { status: 503, code: "CATALOG_DELIVERY_NOT_CONFIGURED" } },
    });
  });

  it("returns the App's counts as the contract, counted or not yet", async () => {
    for (const report of [counted, uncounted]) {
      const provider = vi.fn<Provider>(async () => report);
      const answer = await invoke(provider);
      expect(answer).toEqual({ status: 200, body: report });
      expect(catalogRenderBacklogSchema.parse(answer.body)).toEqual(report);
      expect(provider).toHaveBeenCalledTimes(1);
    }
  });

  it("never passes on more than the contract, and fails without content", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const report of [
      { ...counted, assetIds: ["catalog-asset-synthetic"] },
      { ...counted, countedAt: null },
      { ...counted, tiers: { ...counted.tiers!, t2: -1 } },
    ]) {
      const answer = await invoke(
        async () => report as unknown as CatalogRenderBacklogReport,
      );
      expect(answer).toEqual({
        status: 500,
        body: { error: { status: 500, code: "INTERNAL_ERROR" } },
      });
    }
    const logged = JSON.stringify(error.mock.calls);
    expect(logged).not.toContain("catalog-asset-synthetic");
    expect(logged).not.toContain(syntheticOperator);
  });
});

describe("the App reader behind the route", () => {
  it("reads once with a SELECT and reports the time as an ISO instant", async () => {
    for (const [row, report] of [
      [
        {
          render_backlog: { t0: 3, t1: 2, t2: 40, t3: 0, t4: 1_200 },
          render_backlog_at: new Date("2026-10-23T12:00:00.000Z"),
          queued: 300,
          running: 1,
        },
        counted,
      ],
      [
        {
          render_backlog: null,
          render_backlog_at: null,
          queued: 0,
          running: 0,
        },
        uncounted,
      ],
    ] as const) {
      const query = vi.fn<(text: string) => Promise<{ rows: unknown[] }>>(
        async () => ({ rows: [row] }),
      );
      const read = createCatalogRenderBacklog({
        query,
      } as unknown as Parameters<typeof createCatalogRenderBacklog>[0]);
      expect(await read()).toEqual(report);
      expect(query).toHaveBeenCalledTimes(1);
      const text = query.mock.calls[0]![0];
      expect(text.trimStart()).toMatch(/^SELECT /u);
      expect(text).not.toMatch(/\b(INSERT|UPDATE|DELETE|FOR UPDATE|LOCK)\b/iu);
    }
  });

  it("is what the production composition answers the route with", async () => {
    const composition = await readFile(
      `${root}/services/backend-production/src/composition.ts`,
      "utf8",
    );
    // The Backend's own App pool, beside the publish gate's facts.
    expect(composition).toMatch(
      /catalogRenderBacklog: createCatalogRenderBacklog\(communityPool\),/u,
    );
  });
});
