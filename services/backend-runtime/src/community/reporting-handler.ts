import {
  createCommunityReportRequestSchema,
  communityReportMaterialRequestSchema,
  communityReportAppealRequestSchema,
  communityReportEvidenceUploadRequestSchema,
} from "@moya/contracts/schemas";
import {
  CommunityInputError,
  isCommunityConflictError,
  isCommunityInputError,
  isCommunityNotFoundError,
  isCommunityStoreUnavailableError,
} from "@moya/api";
import type {
  CommunityReportingService,
  CommunitySessionService,
} from "@moya/api";
import type { IncomingMessage, ServerResponse } from "node:http";
import { sendApiError } from "../http/api-error-response.js";
import { JsonBodyError, readJsonBody } from "../http/json-body.js";
import { sendJson } from "../http/json-response.js";
import { readBearerToken } from "./session-credential.js";
const headers = { "cache-control": "private, no-store", vary: "Authorization" };
const parseReportingInput = <T>(
  schema: { parse(value: unknown): T },
  body: unknown,
): T => {
  try {
    return schema.parse(body);
  } catch {
    throw new CommunityInputError("Reporting request is invalid");
  }
};
export type ReportingIdentify = (
  token: string,
) => Promise<{ readonly id: string } | null>;
const page = (url: URL) => {
  if (
    [...url.searchParams.keys()].some(
      (k) =>
        !["page", "pageSize"].includes(k) ||
        url.searchParams.getAll(k).length !== 1,
    )
  )
    throw new JsonBodyError("Invalid query");
  const p = url.searchParams.get("page") ?? "1",
    s = url.searchParams.get("pageSize") ?? "20";
  if (!/^\d{1,6}$/u.test(p) || !/^\d{1,3}$/u.test(s))
    throw new JsonBodyError("Invalid query");
  return [Number(p), Number(s)] as const;
};
export async function handleReportingRequest(
  request: IncomingMessage,
  response: ServerResponse,
  service: CommunityReportingService,
  sessions: CommunitySessionService,
  restrictedIdentify?: ReportingIdentify,
): Promise<void> {
  try {
    const url = new URL(request.url ?? "/", "http://request.invalid"),
      path = url.pathname,
      token = readBearerToken(request);
    const normal = token ? await sessions.identify(token) : null;
    const allowRestricted =
      request.method === "GET" ||
      /^\/v1\/community\/reports\/[^/]+\/evidence$/u.test(path) ||
      /^\/v1\/community\/decisions\/[^/]+\/appeals$/u.test(path) ||
      /^\/v1\/community\/reports\/[^/]+\/statements$/u.test(path) ||
      /^\/v1\/community\/reporting-inbox\/[^/]+\/read$/u.test(path);
    const viewer =
      normal ??
      (token && allowRestricted ? await restrictedIdentify?.(token) : null);
    if (!viewer) {
      sendApiError(response, "UNAUTHENTICATED", "A valid session is required");
      return;
    }
    if (
      request.headers["x-author-account"] !== undefined &&
      request.headers["x-author-account"] !== viewer.id
    ) {
      sendApiError(response, "UNAUTHENTICATED", "Account changed");
      return;
    }
    if (path === "/v1/community/reports" && request.method === "GET") {
      const [p, s] = page(url);
      sendJson(response, 200, await service.listOwn(viewer.id, p, s), headers);
      return;
    }
    if (
      path === "/v1/community/reports" &&
      request.method === "POST" &&
      !url.search
    ) {
      sendJson(
        response,
        201,
        await service.create(
          viewer.id,
          parseReportingInput(
            createCommunityReportRequestSchema,
            await readJsonBody(request, 65536),
          ),
        ),
        headers,
      );
      return;
    }
    if (path === "/v1/community/decisions" && request.method === "GET") {
      const [p, s] = page(url);
      sendJson(
        response,
        200,
        await service.decisions(viewer.id, p, s),
        headers,
      );
      return;
    }
    if (
      path === "/v1/community/reporting-inbox" &&
      request.method === "GET" &&
      !url.search
    ) {
      sendJson(response, 200, await service.inbox(viewer.id), headers);
      return;
    }
    if (url.search) throw new JsonBodyError("Invalid query");
    let m = /^\/v1\/community\/reporting-inbox\/([^/]+)\/read$/u.exec(path);
    if (m && request.method === "POST") {
      await service.readInbox(viewer.id, decodeURIComponent(m[1]!));
      sendJson(response, 200, { read: true }, headers);
      return;
    }
    m = /^\/v1\/community\/decisions\/([^/]+)\/appeals$/u.exec(path);
    if (m && request.method === "POST") {
      sendJson(
        response,
        200,
        await service.appeal(
          viewer.id,
          decodeURIComponent(m[1]!),
          parseReportingInput(
            communityReportAppealRequestSchema,
            await readJsonBody(request, 65536),
          ),
        ),
        headers,
      );
      return;
    }
    m =
      /^\/v1\/community\/reports\/([^/]+)(?:\/(materials|statements|evidence)(?:\/([^/]+))?)?$/u.exec(
        path,
      );
    if (m) {
      const id = decodeURIComponent(m[1]!),
        operation = m[2];
      if (!operation && request.method === "GET") {
        sendJson(response, 200, await service.readOwn(viewer.id, id), headers);
        return;
      }
      if (operation === "materials" && request.method === "POST" && !m[3]) {
        sendJson(
          response,
          200,
          await service.addMaterial(
            viewer.id,
            id,
            parseReportingInput(
              communityReportMaterialRequestSchema,
              await readJsonBody(request, 65536),
            ),
          ),
          headers,
        );
        return;
      }
      if (operation === "statements" && request.method === "POST" && !m[3]) {
        sendJson(
          response,
          200,
          await service.statement(
            viewer.id,
            id,
            parseReportingInput(
              communityReportMaterialRequestSchema,
              await readJsonBody(request, 65536),
            ),
          ),
          headers,
        );
        return;
      }
      if (operation === "evidence" && request.method === "POST" && !m[3]) {
        sendJson(
          response,
          201,
          await service.uploadEvidence(
            viewer.id,
            id,
            parseReportingInput(
              communityReportEvidenceUploadRequestSchema,
              await readJsonBody(request, 12 * 1024 * 1024),
            ),
          ),
          headers,
        );
        return;
      }
      if (operation === "evidence" && request.method === "GET" && m[3]) {
        await sendReportingEvidence(
          response,
          service,
          viewer.id,
          id,
          decodeURIComponent(m[3]),
        );
        return;
      }
    }
    sendApiError(response, "ITEM_NOT_FOUND", "Reporting route not found");
  } catch (error) {
    if (response.headersSent) {
      response.end();
      return;
    }
    sendApiError(
      response,
      isCommunityInputError(error) ||
        error instanceof JsonBodyError ||
        error instanceof URIError
        ? "INVALID_INPUT"
        : isCommunityConflictError(error)
          ? "CONFLICT"
          : isCommunityNotFoundError(error)
            ? "ITEM_NOT_FOUND"
            : isCommunityStoreUnavailableError(error)
              ? "SERVICE_UNAVAILABLE"
              : "INTERNAL_ERROR",
      "Reporting request unavailable",
    );
  }
}
export async function sendReportingEvidence(
  response: ServerResponse,
  service: CommunityReportingService,
  actor: string | null,
  id: string,
  evidenceId: string,
) {
  const { metadata, bytes } = await service.evidence(actor, id, evidenceId);
  response.writeHead(200, {
    ...headers,
    "content-type": metadata.mimeType,
    "content-length": bytes.byteLength,
    "x-content-type-options": "nosniff",
    "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(metadata.fileName).replaceAll("'", "%27")}`,
  });
  response.end(Buffer.from(bytes));
}
export async function handleReportingOperatorRequest(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  service: CommunityReportingService,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://request.invalid");
  if (pathname === "/internal/community/reports" && request.method === "GET") {
    const query: Record<string, string> = {};
    for (const [key, value] of url.searchParams) {
      if (query[key] !== undefined) throw new JsonBodyError("Duplicate query");
      query[key] = value;
    }
    sendJson(response, 200, await service.operatorList(query), headers);
    return;
  }
  if (url.search) throw new JsonBodyError("Invalid query");
  const m =
    /^\/internal\/community\/reports\/([^/]+)(?:\/(decisions|review|metadata|forward|evidence)(?:\/([^/]+))?)?$/u.exec(
      pathname,
    );
  if (!m) {
    sendJson(response, 404, { error: { status: 404, code: "NOT_FOUND" } });
    return;
  }
  const id = decodeURIComponent(m[1]!),
    action = m[2];
  if (!action && request.method === "GET") {
    sendJson(response, 200, await service.operatorRead(id), headers);
    return;
  }
  if (action === "evidence" && m[3] && request.method === "GET") {
    await sendReportingEvidence(
      response,
      service,
      null,
      id,
      decodeURIComponent(m[3]),
    );
    return;
  }
  if (request.method === "POST" && !m[3]) {
    const body = await readJsonBody(request, 65536);
    const result =
      action === "decisions"
        ? await service.decide(id, body)
        : action === "review"
          ? await service.review(id, body)
          : action === "metadata"
            ? await service.metadata(id, body)
            : action === "forward"
              ? await service.forward(id, body)
              : null;
    if (result) {
      sendJson(response, 200, result, headers);
      return;
    }
  }
  sendJson(response, 405, {
    error: { status: 405, code: "METHOD_NOT_ALLOWED" },
  });
}
