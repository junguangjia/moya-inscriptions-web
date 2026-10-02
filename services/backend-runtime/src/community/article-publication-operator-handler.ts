import {
  CommunityInputError,
  parseArticlePendingId,
  parseArticlePendingListQuery,
  parseArticlePendingModerationCommand,
} from "@moya/api";
import type { ArticlePublicationOperatorService } from "@moya/api";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readJsonBody } from "../http/json-body.js";
import { sendJson } from "../http/json-response.js";
import { collectTransportQuery } from "../http/transport-query.js";

/** Invoke ONLY inside handleOperatorRequest, AFTER isAuthorizedOperator. */
export const handleArticlePublicationOperatorRequest = async (
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  service: ArticlePublicationOperatorService,
): Promise<boolean> => {
  const root = "/internal/community/articles/submissions";
  const subject =
    /^\/internal\/community\/articles\/(article-[0-9a-f]{32})\/(submission|moderation)$/u.exec(
      pathname,
    );
  if (pathname !== root && subject === null) return false;
  const url = new URL(request.url ?? "/", "http://request.invalid");
  const method = request.method ?? "GET";
  const reply = (value: unknown) =>
    sendJson(response, 200, value, { "cache-control": "private, no-store" });
  const wrongMethod = () =>
    sendJson(response, 405, {
      error: { status: 405, code: "METHOD_NOT_ALLOWED" },
    });
  if (pathname === root) {
    if (method !== "GET") {
      wrongMethod();
      return true;
    }
    reply(
      await service.listPending(
        parseArticlePendingListQuery(collectTransportQuery(url.searchParams)),
      ),
    );
    return true;
  }
  if (url.search !== "")
    throw new CommunityInputError("Invalid operator query");
  const id = parseArticlePendingId(subject![1]);
  if (subject![2] === "submission") {
    if (method !== "GET") {
      wrongMethod();
      return true;
    }
    reply(await service.readPending(id));
    return true;
  }
  if (method !== "POST") {
    wrongMethod();
    return true;
  }
  reply(
    await service.moderatePending(
      id,
      parseArticlePendingModerationCommand(await readJsonBody(request, 4_096)),
    ),
  );
  return true;
};
