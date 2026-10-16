import {
  isCommunityConflictError,
  isCommunityInputError,
  isCommunityNotFoundError,
  isCommunityStoreUnavailableError,
  parseWorkPublishingCommand as command,
  parseWorkPublishingSegment as segment,
} from "@moya/api";
import { workPublishingFailureCodeSchema } from "@moya/contracts/schemas";

import { sendApiError } from "../http/api-error-response.js";
import { JsonBodyError, readJsonBody } from "../http/json-body.js";
import { sendJson } from "../http/json-response.js";
import { collectTransportQuery } from "../http/transport-query.js";
import { deliverPublishingMedia } from "./publishing-media-read.js";
import { handlePublishingUpload, refuseTransfer } from "./publishing-upload.js";

import type {
  PublishingOperatorService,
  WorkPublishingService,
} from "@moya/api";
import type { IncomingMessage, ServerResponse } from "node:http";

const privateHeaders = {
  "cache-control": "private, no-store",
  vary: "Authorization",
};
/** Draft content with a full body and fifty items stays well within this. */
const commandBodyLimit = 100_000;
const failureCodes: ReadonlySet<string> = new Set(
  workPublishingFailureCodeSchema.options,
);

class Unauthorized extends Error {}
class InvalidInput extends Error {}
/** Media items are not accepted without a configured store and processor. */
class MediaUnavailable extends Error {}

/** The authenticated account of an author request, resolved by the author handler. */
export interface WorkPublishingViewer {
  readonly viewer: string | null;
}

/**
 * Author routes under `/v1/community/publishing/` (design §10), dispatched by
 * the author handler on `path[0] === "publishing"` after session
 * identification. JSON responses are private and never cached; a non-GET
 * command requires `x-author-account` equal to the session account. Rule
 * rejections answer 422 INVALID_INPUT with the failure code as the message;
 * a stale state answers 409 CONFLICT; a conflicting draft save is a 200 result.
 * `POST drafts/:draftId/readiness` and `sessions/:sessionId/readiness` are
 * commands too (they may enqueue derivative jobs) and answer 200 with the
 * holder's readiness.
 */
export const handleWorkPublishingRequest = async (
  request: IncomingMessage,
  response: ServerResponse,
  segments: readonly string[],
  service: WorkPublishingService,
  { viewer }: WorkPublishingViewer,
): Promise<void> => {
  const url = new URL(request.url ?? "/", "http://request.invalid");
  const method = request.method ?? "GET";
  const route = segments.join("/");
  const [resource, id, leaf, extra, last] = segments;
  try {
    const requireActor = (): string => {
      if (viewer === null) throw new Unauthorized();
      if (method !== "GET" && method !== "HEAD") {
        const asserted = request.headers["x-author-account"];
        if (asserted !== viewer) throw new Unauthorized();
      }
      return viewer;
    };
    const reply = (value: unknown, status = 200) =>
      sendJson(response, status, value, privateHeaders);
    const noQuery = () => {
      if (url.search !== "") throw new InvalidInput();
    };
    const query = () => collectTransportQuery(url.searchParams);
    const body = async () => {
      noQuery();
      return readJsonBody(request, commandBodyLimit);
    };

    // Component bytes: POST uploads/:componentId (raw octet stream).
    if (resource === "uploads" && id !== undefined && segments.length === 2) {
      if (method !== "POST") {
        sendApiError(response, "ITEM_NOT_FOUND", "Not found");
        return;
      }
      let actor: string;
      try {
        actor = requireActor();
      } catch {
        refuseTransfer(
          request,
          response,
          401,
          "UNAUTHENTICATED",
          "A valid session is required",
          service.transferPolicy.refusalReadMs,
        );
        return;
      }
      await handlePublishingUpload(request, response, service, actor, id);
      return;
    }

    // Derivative bytes: GET media/:itemId/:variant/:editKey (Range).
    if (
      resource === "media" &&
      segments.length === 4 &&
      (method === "GET" || method === "HEAD")
    ) {
      noQuery();
      const itemId = segment("itemId", id);
      const variant = segment("variant", leaf);
      const editKey = segment("editKey", extra);
      await deliverPublishingMedia(
        request,
        response,
        (range) => service.openMedia(viewer, itemId, variant, editKey, range),
        privateHeaders,
      );
      return;
    }

    if (method === "GET" && route === "limits") {
      requireActor();
      noQuery();
      reply(await service.limits());
      return;
    }

    if (resource === "drafts") {
      if (segments.length === 1) {
        if (method === "POST") {
          const actor = requireActor();
          reply(
            await service.createDraft(
              actor,
              command("createDraft", await body()),
            ),
            201,
          );
          return;
        }
        if (method === "GET") {
          const actor = requireActor();
          reply(await service.listDrafts(actor, command("pageQuery", query())));
          return;
        }
      }
      if (id !== undefined && segments.length === 2) {
        if (method === "GET") {
          const actor = requireActor();
          noQuery();
          reply(await service.readDraft(actor, segment("draftId", id)));
          return;
        }
        if (method === "DELETE") {
          const actor = requireActor();
          const draftId = segment("draftId", id);
          reply(
            await service.deleteDraft(
              actor,
              draftId,
              command("deleteDraft", await body()),
            ),
          );
          return;
        }
      }
      if (id !== undefined && segments.length === 3) {
        if (method === "GET" && leaf === "history") {
          const actor = requireActor();
          reply(
            await service.listHistory(
              actor,
              segment("draftId", id),
              command("pageQuery", query()),
            ),
          );
          return;
        }
        if (
          method === "POST" &&
          (leaf === "save" ||
            leaf === "snapshot" ||
            leaf === "restore" ||
            leaf === "resolve" ||
            leaf === "readiness")
        ) {
          const actor = requireActor();
          const draftId = segment("draftId", id);
          const value = await body();
          if (leaf === "readiness")
            reply(
              await service.readiness(
                actor,
                { draftId },
                command("readiness", value),
              ),
            );
          else if (leaf === "save")
            reply(
              await service.saveDraft(
                actor,
                draftId,
                command("saveDraft", value),
              ),
            );
          else if (leaf === "snapshot")
            reply(
              await service.snapshotDraft(
                actor,
                draftId,
                command("saveDraft", value),
              ),
            );
          else if (leaf === "restore")
            reply(
              await service.restoreSnapshot(
                actor,
                draftId,
                command("restoreSnapshot", value),
              ),
            );
          else
            reply(
              await service.resolveConflict(
                actor,
                draftId,
                command("resolveConflict", value),
              ),
            );
          return;
        }
      }
    }

    if (resource === "works" && id !== undefined && segments.length === 3) {
      if (method === "POST" && leaf === "draft") {
        const actor = requireActor();
        const workId = segment("workId", id);
        reply(
          await service.openEditDraft(
            actor,
            workId,
            command("openEditDraft", await body()),
          ),
        );
        return;
      }
      if (method === "GET" && leaf === "editable") {
        const actor = requireActor();
        noQuery();
        reply(await service.readEditableWork(actor, segment("workId", id)));
        return;
      }
      if (method === "POST" && leaf === "visibility") {
        const actor = requireActor();
        const workId = segment("workId", id);
        reply(
          await service.setVisibility(
            actor,
            workId,
            command("visibility", await body()),
          ),
        );
        return;
      }
    }

    if (resource === "sessions" && method === "POST") {
      if (segments.length === 1) {
        const actor = requireActor();
        reply(
          await service.createSession(
            actor,
            command("createSession", await body()),
          ),
          201,
        );
        return;
      }
      if (id !== undefined && segments.length === 3) {
        if (leaf === "heartbeat") {
          const actor = requireActor();
          const sessionId = segment("sessionId", id);
          command("heartbeat", await body());
          reply(await service.heartbeatSession(actor, sessionId));
          return;
        }
        if (leaf === "discard") {
          const actor = requireActor();
          const sessionId = segment("sessionId", id);
          reply(
            await service.discardSession(
              actor,
              sessionId,
              command("requestIdentity", await body()),
            ),
          );
          return;
        }
        if (leaf === "readiness") {
          const actor = requireActor();
          const sessionId = segment("sessionId", id);
          reply(
            await service.readiness(
              actor,
              { sessionId },
              command("readiness", await body()),
            ),
          );
          return;
        }
      }
    }

    if (resource === "items") {
      if (
        id !== undefined &&
        segments.length === 3 &&
        leaf === "progress" &&
        method === "GET"
      ) {
        const actor = requireActor();
        noQuery();
        reply(await service.readItemProgress(actor, segment("itemId", id)));
        return;
      }
      if (
        id !== undefined &&
        segments.length === 4 &&
        leaf === "processing" &&
        extra === "retry" &&
        method === "POST"
      ) {
        const actor = requireActor();
        reply(
          await service.retryItemProcessing(
            actor,
            segment("itemId", id),
            command("requestIdentity", await body()),
          ),
        );
        return;
      }
      if (segments.length === 1 && method === "POST") {
        const actor = requireActor();
        if (!service.acceptsMedia) throw new MediaUnavailable();
        reply(
          await service.registerItem(
            actor,
            command("registerItem", await body()),
          ),
          201,
        );
        return;
      }
      if (id !== undefined && segments.length === 2 && method === "GET") {
        const actor = requireActor();
        noQuery();
        reply(await service.readItem(actor, segment("itemId", id)));
        return;
      }
      if (
        id !== undefined &&
        segments.length === 3 &&
        leaf === "cancel" &&
        method === "POST"
      ) {
        const actor = requireActor();
        const itemId = segment("itemId", id);
        reply(
          await service.cancelItem(
            actor,
            itemId,
            command("requestIdentity", await body()),
          ),
        );
        return;
      }
      if (
        id !== undefined &&
        segments.length === 5 &&
        leaf === "components" &&
        extra !== undefined &&
        last === "reset" &&
        method === "POST"
      ) {
        const actor = requireActor();
        const itemId = segment("itemId", id);
        const role = segment("role", extra);
        reply(
          await service.resetComponent(
            actor,
            itemId,
            role,
            command("requestIdentity", await body()),
          ),
        );
        return;
      }
    }

    if (resource === "submissions") {
      if (segments.length === 1 && method === "POST") {
        const actor = requireActor();
        reply(await service.submit(actor, command("submission", await body())));
        return;
      }
      if (id !== undefined && segments.length === 2 && method === "GET") {
        const actor = requireActor();
        noQuery();
        reply(
          await service.readSubmissionReceipt(actor, segment("requestId", id)),
        );
        return;
      }
    }

    sendApiError(response, "ITEM_NOT_FOUND", "Not found");
  } catch (error) {
    sendWorkPublishingError(response, error);
  }
};

/** The Public API error envelope for publishing routes; never a cause or content. */
export const sendWorkPublishingError = (
  response: ServerResponse,
  error: unknown,
): void => {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  if (error instanceof Unauthorized)
    sendApiError(response, "UNAUTHENTICATED", "A valid session is required");
  else if (error instanceof InvalidInput || error instanceof JsonBodyError)
    sendApiError(response, "INVALID_INPUT", "Invalid community input");
  else if (isCommunityInputError(error))
    sendApiError(
      response,
      "INVALID_INPUT",
      failureCodes.has(error.message)
        ? error.message
        : "Invalid community input",
    );
  else if (isCommunityNotFoundError(error))
    sendApiError(response, "ITEM_NOT_FOUND", "This item is unavailable");
  else if (isCommunityConflictError(error))
    sendApiError(response, "CONFLICT", error.message);
  else if (
    error instanceof MediaUnavailable ||
    isCommunityStoreUnavailableError(error)
  )
    sendApiError(
      response,
      "SERVICE_UNAVAILABLE",
      "Media is temporarily unavailable",
    );
  else
    sendApiError(
      response,
      "SERVICE_UNAVAILABLE",
      "Community service is temporarily unavailable",
    );
};

type OperatorStatus = 400 | 401 | 404 | 405 | 409 | 500 | 503;

const sendOperatorError = (
  response: ServerResponse,
  status: OperatorStatus,
  code: string,
): void => {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  sendJson(response, status, { error: { status, code } });
};

const operatorPrefix = "/internal/community/publishing/";

/**
 * Operator routes under `/internal/community/publishing/` (design §10), called
 * by the operator handler after the operator credential was verified. Returns
 * false when the path is not a publishing route. Bare operator error codes,
 * never the Public API envelope.
 *
 *   GET|PUT settings
 *   GET     submissions?state&page&pageSize
 *   GET     submissions/:revisionId
 *   POST    submissions/:revisionId/moderation
 *   GET     media/:revisionId/:itemId/:variant/:editKey   (binary, Range)
 *   GET|PUT accounts/:accountId/capacity
 *   GET     jobs?state&kind&page&pageSize
 *   POST    jobs/:jobId/retry | jobs/:jobId/abandon
 */
export const handlePublishingOperatorRequest = async (
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  service: PublishingOperatorService,
): Promise<boolean> => {
  if (!pathname.startsWith(operatorPrefix)) return false;
  const url = new URL(request.url ?? "/", "http://request.invalid");
  const method = request.method ?? "GET";
  const segments = pathname.slice(operatorPrefix.length).split("/");
  const [resource, id, leaf, extra, last] = segments;
  const methodNotAllowed = () =>
    sendOperatorError(response, 405, "METHOD_NOT_ALLOWED");
  try {
    const noQuery = () => {
      if (url.search !== "") throw new InvalidInput();
    };
    const commandBody = async () => {
      noQuery();
      return readJsonBody(request, commandBodyLimit);
    };
    const reply = (value: unknown) => sendJson(response, 200, value);

    if (resource === "settings" && segments.length === 1) {
      if (method === "GET") {
        noQuery();
        reply(await service.readSettings());
      } else if (method === "PUT")
        reply(await service.setSettings(await commandBody()));
      else methodNotAllowed();
      return true;
    }

    if (resource === "submissions") {
      if (segments.length === 1) {
        if (method !== "GET") methodNotAllowed();
        else
          reply(
            await service.listSubmissions(
              collectTransportQuery(url.searchParams),
            ),
          );
        return true;
      }
      if (id !== undefined && segments.length === 2) {
        if (method !== "GET") methodNotAllowed();
        else {
          noQuery();
          reply(await service.readSubmission(segment("revisionId", id)));
        }
        return true;
      }
      if (id !== undefined && segments.length === 3 && leaf === "moderation") {
        if (method !== "POST") methodNotAllowed();
        else {
          const revisionId = segment("revisionId", id);
          reply(
            await service.moderateSubmission(revisionId, await commandBody()),
          );
        }
        return true;
      }
    }

    if (resource === "media" && segments.length === 5) {
      if (method !== "GET" && method !== "HEAD") {
        methodNotAllowed();
        return true;
      }
      noQuery();
      const revisionId = segment("revisionId", id);
      const itemId = segment("itemId", leaf);
      const variant = segment("variant", extra);
      const editKey = segment("editKey", last);
      await deliverPublishingMedia(
        request,
        response,
        (range) =>
          service.openMedia(revisionId, itemId, variant, editKey, range),
        { "cache-control": "private, no-store" },
      );
      return true;
    }

    if (
      resource === "accounts" &&
      id !== undefined &&
      segments.length === 3 &&
      leaf === "capacity"
    ) {
      if (method === "GET") {
        noQuery();
        reply(await service.readCapacity(id));
      } else if (method === "PUT")
        reply(await service.setCapacity(id, await commandBody()));
      else methodNotAllowed();
      return true;
    }

    if (resource === "jobs") {
      if (segments.length === 1) {
        if (method !== "GET") methodNotAllowed();
        else
          reply(
            await service.listJobs(collectTransportQuery(url.searchParams)),
          );
        return true;
      }
      if (
        id !== undefined &&
        segments.length === 3 &&
        (leaf === "retry" || leaf === "abandon")
      ) {
        if (method !== "POST") methodNotAllowed();
        else if (leaf === "retry")
          reply(await service.retryJob(id, await commandBody()));
        else reply(await service.abandonJob(id, await commandBody()));
        return true;
      }
    }

    sendOperatorError(response, 404, "NOT_FOUND");
    return true;
  } catch (error) {
    if (error instanceof InvalidInput || error instanceof JsonBodyError)
      sendOperatorError(response, 400, "INVALID_COMMAND");
    else if (isCommunityNotFoundError(error))
      sendOperatorError(response, 404, "NOT_FOUND");
    else if (isCommunityConflictError(error))
      sendOperatorError(response, 409, "STATE_CONFLICT");
    else if (isCommunityInputError(error))
      sendOperatorError(response, 400, "INVALID_COMMAND");
    else if (isCommunityStoreUnavailableError(error))
      sendOperatorError(response, 503, "STORE_UNAVAILABLE");
    else sendOperatorError(response, 500, "INTERNAL_ERROR");
    return true;
  }
};
