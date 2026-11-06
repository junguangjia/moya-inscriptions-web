import { createHash, randomBytes } from "node:crypto";
import type { Server } from "node:http";

import type {
  CommunityContentOperatorPort,
  CommunityReportingPort,
  ModerationEventQueryInput,
  OperatorCommentQueryInput,
  PublishingOperatorPort,
} from "@moya/api";
import {
  createBackendApplication,
  createBackendServer,
  startServer,
  stopServer,
} from "@moya/backend-runtime";
import { OPERATOR_SOURCES } from "@moya/community-postgres";
import type { SourceQuery, SourceSpec } from "@moya/community-postgres";
import type { AiCountSource } from "@moya/contracts/internal/admin-mcp";
import type { OperatorReadScope } from "@moya/contracts/internal/community-operator";
import { MappedStorageUrlResolver } from "@moya/image";
import { callAiOperator, callCommunityOperator } from "admin/community-backend";
import { communityOperationDefinitions } from "admin/community-endpoints";
import type { OperatorCall } from "admin/community-endpoints";
import type { PayloadRequest } from "payload";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { InMemoryCommunityCommentPort } from "../backend/community-comment-fixture.js";
import { InMemoryCommunityIdentityPort } from "../backend/community-identity-fixture.js";

/**
 * A queue filter reaches the SQL however it is added (admin-mcp-completion-v1 S8):
 * every key a queue's input takes travels from the Admin's definition into its URL,
 * through the real Backend handler and service to the port, and into the values its
 * source's filter binds. A key dropped on any hop would read as applied while the
 * page ignored it, so each hop is checked here for each key on its own.
 */

const hex = (seed: string) =>
  createHash("sha256").update(seed).digest("hex").slice(0, 32);
const user = `user-${hex("reach-user")}`;
const work = `work-${hex("reach-work")}`;
const from = "2026-01-01T00:00:00Z";
const to = "2026-02-01T00:00:00Z";

/** A valid value for every key each queue takes; a key added there needs one here. */
const SAMPLES = {
  "read-reports": {
    status: "open",
    unresolved: "true",
    urgent: "false",
    targetType: "work",
    targetId: work,
    affectedUserId: user,
    reporterId: `user-${hex("reach-reporter")}`,
    page: 2,
    pageSize: 5,
  },
  "read-comments": {
    moderation: "pending",
    kind: "reply",
    catalogId: "catalog-reach",
    search: "墨迹",
    authorId: user,
    from,
    to,
    order: "oldest",
    page: 2,
    pageSize: 5,
  },
  "read-works": {
    page: 2,
    pageSize: 5,
    search: "墨迹",
    authorId: user,
    workId: work,
    from,
    to,
  },
  "read-users": { page: 2, pageSize: 5, search: "墨迹", userId: user },
  "read-work-submissions": {
    state: "approved",
    authorId: user,
    workId: work,
    page: 2,
    pageSize: 5,
  },
  "read-publishing-jobs": {
    state: "failed",
    kind: "process_item",
    subjectId: `media-item-${hex("reach-item")}`,
    id: `publishing-job-${hex("reach-job")}`,
    page: 2,
    pageSize: 5,
  },
  "read-events": {
    subjectId: `comment-${hex("reach-comment")}`,
    action: "hide",
    page: 2,
    pageSize: 5,
  },
  "read-summary": { range: "30d" },
  "read-article-submissions": { cursor: "reachcursor", pageSize: 5 },
} as const satisfies Partial<
  Record<keyof typeof communityOperationDefinitions, Record<string, unknown>>
>;
type Queue = keyof typeof SAMPLES;

/** The port each queue lands on, and the source whose filter binds its values. */
const LANDS: Readonly<
  Record<
    Queue,
    {
      readonly port?: string;
      /** Where the AI's read lands, when it is not the Owner's port. */
      readonly aiPort?: string;
      readonly source?: AiCountSource;
    }
  >
> = {
  "read-reports": {
    port: "operatorList",
    aiPort: "operatorListForAi",
    source: "reports",
  },
  "read-comments": { port: "readOperatorComments", source: "comments" },
  "read-works": { port: "readWorks", source: "works" },
  "read-users": { port: "readUsers", source: "users" },
  "read-work-submissions": {
    port: "listSubmissions",
    source: "work_submissions",
  },
  "read-publishing-jobs": { port: "listJobs", source: "jobs" },
  "read-events": { port: "readModerationEvents" },
  // A range becomes two instants, and an Article page is the Backend's own cursor,
  // on a port this Backend is not given: for these the URL is the last hop checked.
  "read-summary": {},
  "read-article-submissions": {},
};

/** Keys that page a queue: they reach the port, and no filter binds them. */
const PAGING = new Set(["page", "pageSize", "order", "cursor"]);

interface Landed {
  readonly port: string;
  readonly query: Record<string, unknown>;
  readonly scope: OperatorReadScope | undefined;
}
const landed: Landed[] = [];
const land = (
  port: string,
  query: unknown,
  scope: OperatorReadScope | undefined,
) => landed.push({ port, query: query as Record<string, unknown>, scope });

const page = (query: unknown) => {
  const { page: number = 1, pageSize = 20 } = query as {
    page?: number;
    pageSize?: number;
  };
  return { items: [], total: 0, page: number, pageSize };
};

class RecordingCommentPort extends InMemoryCommunityCommentPort {
  override async readOperatorComments(
    query: OperatorCommentQueryInput,
    scope?: OperatorReadScope,
  ) {
    land("readOperatorComments", query, scope);
    return super.readOperatorComments(query);
  }
  override async readModerationEvents(
    query: ModerationEventQueryInput,
    scope?: OperatorReadScope,
  ) {
    land("readModerationEvents", query, scope);
    return super.readModerationEvents(query);
  }
}

const recordingPort = <Port>(names: readonly string[]): Port =>
  Object.fromEntries(
    names.map((name) => [
      name,
      async (query: unknown, scope?: OperatorReadScope) => {
        land(name, query, scope);
        return page(query);
      },
    ]),
  ) as Port;

const synthetic = () => randomBytes(32).toString("base64url");
const ownerToken = synthetic();
const communityToken = synthetic();
let server: Server;

beforeAll(async () => {
  server = createBackendServer(
    createBackendApplication({
      nodeEnv: "development",
      communityIdentityPort: new InMemoryCommunityIdentityPort(),
      storageUrlResolver: new MappedStorageUrlResolver(new Map()),
      communityCommentPort: new RecordingCommentPort(),
      contentOperatorPort: recordingPort<CommunityContentOperatorPort>([
        "readWorks",
        "readUsers",
      ]),
      reportingPort: recordingPort<CommunityReportingPort>([
        "operatorList",
        "operatorListForAi",
      ]),
      publishingOperatorPort: recordingPort<PublishingOperatorPort>([
        "listSubmissions",
        "listJobs",
      ]),
      communityOperatorCredential: ownerToken,
      operatorAiCommunityCredential: communityToken,
    }),
  );
  const { port } = await startServer(server, { host: "127.0.0.1", port: 0 });
  vi.stubEnv("COMMUNITY_OPERATOR_BASE_URL", `http://127.0.0.1:${port}`);
  vi.stubEnv("COMMUNITY_OPERATOR_TOKEN", ownerToken);
  vi.stubEnv("COMMUNITY_OPERATOR_AI_TOKEN", communityToken);
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await stopServer(server);
});

/** An object schema's own keys; this package reads zod's shape and does not import it. */
const keysOf = (schema: unknown): string[] =>
  Object.keys((schema as { readonly shape: object }).shape).sort();

/** One read through the real transport: the path it asked and what reached the port. */
const reach = async (
  queue: Queue,
  input: Record<string, unknown>,
  transport: OperatorCall,
) => {
  const definition = communityOperationDefinitions[queue];
  const paths: string[] = [];
  const call = (async (method, path, body) => {
    paths.push(path);
    return transport(method, path, body);
  }) as OperatorCall;
  const before = landed.length;
  const answered = definition.run(
    definition.input.parse(input),
    call,
    {} as PayloadRequest,
  );
  await (LANDS[queue].port === undefined
    ? answered.catch(() => undefined)
    : answered);
  const [path] = paths;
  return {
    asked: new URLSearchParams(path!.split("?")[1] ?? ""),
    landed: landed.slice(before),
  };
};

const TRANSPORTS = [
  ["the Owner", callCommunityOperator as OperatorCall],
  ["the AI", callAiOperator("community") as OperatorCall],
] as const;

describe("a queue filter", () => {
  it.each(Object.keys(SAMPLES) as Queue[])(
    "has a sample for every key %s takes",
    (queue) => {
      expect(Object.keys(SAMPLES[queue]).sort()).toEqual(
        keysOf(communityOperationDefinitions[queue].input),
      );
    },
  );

  const cases = TRANSPORTS.flatMap(([who, transport]) =>
    (Object.keys(SAMPLES) as Queue[]).flatMap((queue) =>
      Object.entries(SAMPLES[queue]).map(
        ([key, value]) => [who, queue, key, value, transport] as const,
      ),
    ),
  );

  it.each(cases)(
    "from %s's %s reaches its URL, the port and the values: %s",
    async (who, queue, key, value, transport) => {
      const { asked, landed: hit } = await reach(
        queue,
        { [key]: value },
        transport,
      );
      expect(asked.getAll(key)).toEqual([String(value)]);
      const { port, aiPort, source } = LANDS[queue];
      if (port === undefined) return;
      expect(hit.map((one) => one.port)).toEqual([
        who === "the AI" ? (aiPort ?? port) : port,
      ]);
      const [{ query, scope }] = hit as [Landed];
      const parsed = communityOperationDefinitions[queue].input.parse({
        [key]: value,
      }) as Record<string, unknown>;
      expect(query[key]).toEqual(parsed[key]);
      if (source === undefined || PAGING.has(key)) return;
      const { landed: bare } = await reach(queue, {}, transport);
      const spec = OPERATOR_SOURCES[source] as SourceSpec<
        SourceQuery<typeof source>
      >;
      expect(spec.values(query as never, scope)).not.toEqual(
        spec.values(bare[0]!.query as never, bare[0]!.scope),
      );
    },
  );
});
