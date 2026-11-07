import { randomUUID } from "node:crypto";

import { CommunityInputError, CommunityNotFoundError } from "@moya/api";
import {
  createBackendApplication,
  createBackendServer,
  startServer,
  stopServer,
} from "@moya/backend-runtime";
import {
  apiErrorSchema,
  contentTimelineEntrySchema,
  developmentSessionSchema,
  timelinePostCountsSchema,
  workPageSchema,
  workTimelineEntryResultSchema,
} from "@moya/contracts/schemas";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  InMemoryCommunityIdentityPort,
  fixtureUsers,
} from "./community-identity-fixture.js";

import type {
  AuthorCommunityPort,
  TimelinePostsPort,
  WorkPublishingPort,
} from "@moya/api";
import type { ApiErrorCode, UserWork } from "@moya/contracts";
import type { Server } from "node:http";

// timeline-posts-v1: the public routes over stand-in ports; the SQL runs in
// tests/integration/postgres/timeline-posts.test.ts. Content is fictional.

const actor = fixtureUsers.active.id;
const workId = "work-0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0a";
const catalogId = "catalog-fictional";
const named = {
  id: "fictional-row",
  title: "虚构碑",
  fullTitle: "虚构朝虚构碑",
};

const work: UserWork = {
  id: workId,
  authorId: actor,
  authorName: "虚构作者",
  title: "虚构访碑",
  text: "",
  media: [],
  coverMediaId: null,
  coverSrc: null,
  firstPublishedAt: null,
  version: 1,
  canEdit: false,
  available: true,
};

const servers = new Set<Server>();
afterEach(async () => {
  await Promise.all(
    [...servers].map(async (server) => {
      await stopServer(server);
      servers.delete(server);
    }),
  );
});

interface Ports {
  readonly posts?: Partial<TimelinePostsPort>;
  readonly publishing?: Partial<WorkPublishingPort>;
  readonly readWork?: AuthorCommunityPort["readWork"];
  readonly isPublished?: (id: string) => Promise<boolean>;
}
const backend = async ({
  posts,
  publishing,
  readWork = async () => work,
  isPublished = async () => true,
}: Ports = {}) => {
  const server = createBackendServer(
    createBackendApplication({
      nodeEnv: "development",
      communityIdentityPort: new InMemoryCommunityIdentityPort(),
      authorCommunityPort: { readWork } as unknown as AuthorCommunityPort,
      catalogPublicationPort: {
        isPublished: async (id) => isPublished(id),
        readTitle: async () => "Test catalog",
      },
      ...(posts === undefined
        ? {}
        : { timelinePostsPort: posts as TimelinePostsPort }),
      ...(publishing === undefined
        ? {}
        : { workPublishingPort: publishing as WorkPublishingPort }),
    }),
  );
  servers.add(server);
  const address = await startServer(server, { host: "127.0.0.1", port: 0 });
  const base = `http://${address.address}:${address.port}`;
  const signIn = async () => {
    const response = await fetch(`${base}/v1/development/sign-in`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handle: fixtureUsers.active.handle }),
    });
    return developmentSessionSchema.parse(await response.json()).token;
  };
  return { base, signIn };
};

const expectApiError = async (
  response: Response,
  status: number,
  code: ApiErrorCode,
  message?: string,
) => {
  expect(response.status).toBe(status);
  const body = apiErrorSchema.parse(await response.json());
  expect(body.error.code).toBe(code);
  if (message !== undefined) expect(body.error.message).toBe(message);
};
const expectPrivate = (response: Response) => {
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("vary")).toBe("Authorization");
};

describe("GET /v1/community/timeline/post-counts", () => {
  it("answers each viewer the validated counts, uncached", async () => {
    const timelinePostCounts = vi.fn(async () => ({
      counts: { "fictional-row": 3 },
    }));
    const { base, signIn } = await backend({ posts: { timelinePostCounts } });
    const guest = await fetch(`${base}/v1/community/timeline/post-counts`);
    expect(guest.status).toBe(200);
    expectPrivate(guest);
    expect(timelinePostCountsSchema.parse(await guest.json())).toEqual({
      counts: { "fictional-row": 3 },
    });
    const token = await signIn();
    await fetch(`${base}/v1/community/timeline/post-counts`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(timelinePostCounts.mock.calls).toEqual([[null], [actor]]);
  });

  it("rejects a query, refuses an answer the contract refuses, and is not a route without its port", async () => {
    const timelinePostCounts = vi.fn(async () => ({ counts: { "Bad Id": 0 } }));
    const { base } = await backend({ posts: { timelinePostCounts } });
    await expectApiError(
      await fetch(`${base}/v1/community/timeline/post-counts?entry=a`),
      422,
      "INVALID_INPUT",
    );
    expect(timelinePostCounts).not.toHaveBeenCalled();
    const refused = await fetch(`${base}/v1/community/timeline/post-counts`);
    expect(refused.status).toBe(503);
    expect(await refused.text()).not.toContain("Bad Id");
    const bare = await backend();
    expect(
      (await fetch(`${bare.base}/v1/community/timeline/post-counts`)).status,
    ).toBe(404);
  });
});

describe("GET /v1/community/timeline/{entryId}/posts", () => {
  it("passes the entry, the viewer and the page, and answers the page uncached", async () => {
    const listTimelinePosts = vi.fn(async () => ({
      items: [work],
      total: 1,
      page: 2,
      pageSize: 6,
    }));
    const { base } = await backend({ posts: { listTimelinePosts } });
    const response = await fetch(
      `${base}/v1/community/timeline/fictional-row/posts?page=2&pageSize=6`,
    );
    expect(response.status).toBe(200);
    expectPrivate(response);
    expect(workPageSchema.parse(await response.json()).total).toBe(1);
    expect(listTimelinePosts).toHaveBeenCalledWith(
      "fictional-row",
      null,
      expect.objectContaining({ page: 2, pageSize: 6 }),
    );
  });

  it("rejects a malformed entry id or another query field before reading, and answers 404 for a hidden row", async () => {
    const listTimelinePosts = vi.fn(async () => {
      throw new CommunityNotFoundError();
    });
    const { base } = await backend({ posts: { listTimelinePosts } });
    for (const path of [
      "timeline/Not_An_Id/posts",
      "timeline/fictional-row/posts?sort=old",
      "timeline/fictional-row/posts?pageSize=51",
    ])
      await expectApiError(
        await fetch(`${base}/v1/community/${path}`),
        422,
        "INVALID_INPUT",
      );
    expect(listTimelinePosts).not.toHaveBeenCalled();
    await expectApiError(
      await fetch(`${base}/v1/community/timeline/fictional-row/posts`),
      404,
      "ITEM_NOT_FOUND",
    );
    // The timeline read itself keeps its exact path.
    await expectApiError(
      await fetch(`${base}/v1/community/timeline/fictional-row`),
      404,
      "ITEM_NOT_FOUND",
    );
  });
});

describe("GET /v1/community/content/{type}/{id}/timeline-entry", () => {
  it("names the row of a visible work or a published Catalog record, or null", async () => {
    const timelineEntryOf = vi
      .fn<TimelinePostsPort["timelineEntryOf"]>()
      .mockResolvedValueOnce({ entry: named })
      .mockResolvedValueOnce({ entry: null });
    const { base } = await backend({ posts: { timelineEntryOf } });
    const first = await fetch(
      `${base}/v1/community/content/work/${workId}/timeline-entry`,
    );
    expect(first.status).toBe(200);
    expectPrivate(first);
    expect(contentTimelineEntrySchema.parse(await first.json())).toEqual({
      entry: named,
    });
    const second = await fetch(
      `${base}/v1/community/content/catalog/${catalogId}/timeline-entry`,
    );
    expect(contentTimelineEntrySchema.parse(await second.json())).toEqual({
      entry: null,
    });
    expect(timelineEntryOf.mock.calls).toEqual([
      [{ type: "work", id: workId }, null],
      [{ type: "catalog", id: catalogId }, null],
    ]);
  });

  it("answers 404 for a target the viewer may not see, before reading the row", async () => {
    const timelineEntryOf = vi.fn();
    const { base } = await backend({
      posts: { timelineEntryOf },
      readWork: async () => {
        throw new CommunityNotFoundError();
      },
      isPublished: async () => false,
    });
    for (const path of [
      `content/work/${workId}/timeline-entry`,
      `content/catalog/${catalogId}/timeline-entry`,
    ])
      await expectApiError(
        await fetch(`${base}/v1/community/${path}`),
        404,
        "ITEM_NOT_FOUND",
      );
    expect(timelineEntryOf).not.toHaveBeenCalled();
    await expectApiError(
      await fetch(
        `${base}/v1/community/content/work/not-a-work/timeline-entry`,
      ),
      422,
      "INVALID_INPUT",
    );
  });

  it("names the row of the author's own work an operator hid, which the posts list shows them, and never a third party's", async () => {
    const timelineEntryOf = vi
      .fn<TimelinePostsPort["timelineEntryOf"]>()
      .mockResolvedValue({ entry: named });
    // The author's read of an own hidden work: listed, not available.
    let read: UserWork = { ...work, canEdit: true, available: false };
    const { base, signIn } = await backend({
      posts: { timelineEntryOf },
      readWork: async () => read,
    });
    const token = await signIn();
    const path = `${base}/v1/community/content/work/${workId}/timeline-entry`;
    const own = await fetch(path, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(own.status).toBe(200);
    expect(contentTimelineEntrySchema.parse(await own.json())).toEqual({
      entry: named,
    });
    expect(timelineEntryOf.mock.calls).toEqual([
      [{ type: "work", id: workId }, actor],
    ]);
    // A work that is not available to a third party stays not found.
    read = { ...work, canEdit: false, available: false };
    await expectApiError(
      await fetch(path, { headers: { authorization: `Bearer ${token}` } }),
      404,
      "ITEM_NOT_FOUND",
    );
    await expectApiError(await fetch(path), 404, "ITEM_NOT_FOUND");
    expect(timelineEntryOf).toHaveBeenCalledOnce();
  });
});

describe("POST /v1/community/publishing/works/{workId}/timeline-entry", () => {
  const path = `/v1/community/publishing/works/${workId}/timeline-entry`;
  const post = (
    base: string,
    token: string | null,
    body: unknown,
    account: string | null = actor,
  ) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
        ...(account === null ? {} : { "x-author-account": account }),
      },
      body: JSON.stringify(body),
    });

  it("attaches, moves or detaches for the signed-in author and answers the result", async () => {
    const setTimelineEntry = vi.fn<WorkPublishingPort["setTimelineEntry"]>(
      async (_actor, id, command) => ({
        workId: id,
        entryId: command.entryId,
        version: 2,
      }),
    );
    const { base, signIn } = await backend({
      publishing: { setTimelineEntry },
    });
    const token = await signIn();
    const requestId = randomUUID();
    const response = await post(base, token, {
      requestId,
      entryId: "fictional-row",
    });
    expect(response.status).toBe(200);
    expectPrivate(response);
    expect(workTimelineEntryResultSchema.parse(await response.json())).toEqual({
      workId,
      entryId: "fictional-row",
      version: 2,
    });
    const detached = await post(base, token, {
      requestId: randomUUID(),
      entryId: null,
    });
    expect(await detached.json()).toEqual({
      workId,
      entryId: null,
      version: 2,
    });
    expect(setTimelineEntry.mock.calls[0]!.slice(0, 3)).toEqual([
      actor,
      workId,
      { requestId, entryId: "fictional-row" },
    ]);
    expect(setTimelineEntry.mock.calls[0]![3]).toBeInstanceOf(Date);
  });

  it("requires the session and its account, and a strict command", async () => {
    const setTimelineEntry = vi.fn();
    const { base, signIn } = await backend({
      publishing: { setTimelineEntry },
    });
    const command = { requestId: randomUUID(), entryId: "fictional-row" };
    await expectApiError(
      await post(base, null, command),
      401,
      "UNAUTHENTICATED",
    );
    const token = await signIn();
    await expectApiError(
      await post(base, token, command, null),
      401,
      "UNAUTHENTICATED",
    );
    for (const body of [
      { requestId: "not-a-uuid", entryId: "fictional-row" },
      { requestId: randomUUID() },
      { ...command, entryId: "Not An Id" },
      { ...command, extra: true },
    ])
      await expectApiError(await post(base, token, body), 422, "INVALID_INPUT");
    expect(setTimelineEntry).not.toHaveBeenCalled();
  });

  it("answers a rule refusal as INVALID_INPUT naming its code", async () => {
    for (const code of [
      "timeline_entry_unavailable",
      "timeline_entry_withheld",
      "work_unavailable",
    ]) {
      const { base, signIn } = await backend({
        publishing: {
          setTimelineEntry: async () => {
            throw new CommunityInputError(code);
          },
        },
      });
      await expectApiError(
        await post(base, await signIn(), {
          requestId: randomUUID(),
          entryId: "fictional-row",
        }),
        422,
        "INVALID_INPUT",
        code,
      );
    }
  });
});
