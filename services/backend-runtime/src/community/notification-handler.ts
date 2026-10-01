import {
  isCommunityInputError,
  isCommunityNotFoundError,
  isCommunityStoreUnavailableError,
} from "@moya/api";
import type {
  CommunitySessionService,
  NotificationService,
  NotificationFilter,
} from "@moya/api";
import { notificationReadSchema } from "@moya/contracts/schemas";
import type { IncomingMessage, ServerResponse } from "node:http";
import { sendApiError } from "../http/api-error-response.js";
import { sendJson } from "../http/json-response.js";
import { JsonBodyError, readJsonBody } from "../http/json-body.js";
import { readBearerToken } from "./session-credential.js";
import type { NotificationStreams } from "./notification-stream.js";

const headers = { "cache-control": "private, no-store", vary: "Authorization" };
export async function handleNotificationRequest(
  request: IncomingMessage,
  response: ServerResponse,
  service: NotificationService,
  sessions: CommunitySessionService,
  streams: NotificationStreams,
): Promise<void> {
  try {
    const token = readBearerToken(request),
      viewer = token ? await sessions.identify(token) : null;
    if (!token || !viewer) {
      sendApiError(response, "UNAUTHENTICATED", "A valid session is required");
      return;
    }
    const url = new URL(request.url ?? "/", "http://request.invalid");
    const path = url.pathname;
    if (
      request.headers["x-author-account"] !== undefined &&
      request.headers["x-author-account"] !== viewer.id
    ) {
      sendApiError(response, "UNAUTHENTICATED", "Account changed");
      return;
    }
    const invalid = () =>
      sendApiError(response, "INVALID_INPUT", "Invalid notification request");
    if (
      path === "/v1/community/notifications/stream" &&
      request.method === "GET"
    ) {
      if (url.search || request.headers["last-event-id"]) {
        invalid();
        return;
      }
      if (!streams.open(viewer.id, token, response))
        sendApiError(response, "SERVICE_UNAVAILABLE", "Stream limit reached");
      return;
    }
    if (path === "/v1/community/mentions" && request.method === "GET") {
      if (
        [...url.searchParams.keys()].some((k) => k !== "q") ||
        url.searchParams.getAll("q").length !== 1
      ) {
        invalid();
        return;
      }
      sendJson(
        response,
        200,
        await service.lookup(viewer.id, url.searchParams.get("q") ?? ""),
        headers,
      );
      return;
    }
    if (path === "/v1/community/notifications" && request.method === "GET") {
      if (
        [...url.searchParams.keys()].some(
          (k) =>
            !["filter", "limit", "cursor"].includes(k) ||
            url.searchParams.getAll(k).length !== 1,
        )
      ) {
        invalid();
        return;
      }
      const filter = url.searchParams.get("filter") ?? "all",
        rawLimit = url.searchParams.get("limit") ?? "20",
        limit = Number(rawLimit);
      if (
        !["all", "likes", "comments", "mentions"].includes(filter) ||
        !/^\d{1,2}$/u.test(rawLimit) ||
        limit < 1 ||
        limit > 50
      ) {
        invalid();
        return;
      }
      sendJson(
        response,
        200,
        await service.list(
          viewer.id,
          filter as NotificationFilter,
          limit,
          url.searchParams.get("cursor") ?? undefined,
        ),
        headers,
      );
      return;
    }
    if (
      path === "/v1/community/notifications/read" &&
      request.method === "POST" &&
      !url.search
    ) {
      const input = notificationReadSchema.safeParse(
        await readJsonBody(request),
      );
      if (!input.success) {
        invalid();
        return;
      }
      await service.read(viewer.id, input.data.observation);
      streams.changed(viewer.id);
      sendJson(response, 200, { read: true }, headers);
      return;
    }
    response.writeHead(404, headers);
    response.end();
  } catch (error) {
    if (response.headersSent) {
      response.end();
      return;
    }
    sendApiError(
      response,
      isCommunityInputError(error) || error instanceof JsonBodyError
        ? "INVALID_INPUT"
        : isCommunityNotFoundError(error)
          ? "ITEM_NOT_FOUND"
          : isCommunityStoreUnavailableError(error)
            ? "SERVICE_UNAVAILABLE"
            : "INTERNAL_ERROR",
      "Notification request unavailable",
    );
  }
}
