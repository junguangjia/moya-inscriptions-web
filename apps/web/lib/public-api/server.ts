import "server-only";
import { trustedAuthSourceHeaders } from "./auth-request-source";
import {
  ARTICLE_DOCUMENT_LIMITS,
  authCapabilitiesSchema,
  authPasswordResetResultSchema,
} from "@moya/contracts/schemas";
import { localCatalogFileUrl } from "../../features/detail/local-catalog-media";
import {
  isSecureRequest,
  readCommunitySessionToken,
  serializeClearedCommunitySessionCookie,
  serializeCommunitySessionCookie,
} from "./community-session-cookie";

import { fetchCatalogSearchPage } from "./catalog-search";
import type { CatalogSearchTransportResult } from "./catalog-search";
import type { CatalogSearchTransportQuery } from "@moya/contracts";

import { fetchCatalogDetail } from "./catalog-detail";
import { fetchCatalogPage } from "./catalog-list";
import {
  createCatalogComment,
  createCatalogCommentReply,
  fetchCatalogCommentPage,
  fetchCatalogCommentReplyPage,
} from "./catalog-comments";
import {
  accessDenied,
  fetchCurrentUser,
  fetchProductAccess,
  signInDevelopmentAccount,
  signOutDevelopmentSession,
} from "./community-session";

import type {
  CatalogComment,
  CatalogCommentReply,
  CatalogCommentListingTransportQuery,
  CatalogCommentTransportQuery,
  CatalogListTransportQuery,
} from "@moya/contracts";
import type { CatalogDetailTransportResult } from "./catalog-detail";
import type { CatalogPageTransportResult } from "./catalog-list";
import type {
  CommentPageTransportResult,
  CommentReplyPageTransportResult,
  CommentSubmissionTransportResult,
} from "./catalog-comments";
import type {
  AccessDeniedTransportResult,
  CurrentUserTransportResult,
  DevelopmentSignInTransportResult,
  DevelopmentSignOutTransportResult,
  ProductAccessTransportResult,
} from "./community-session";

const publicApiBaseUrlVariable = "MOYA_PUBLIC_API_BASE_URL" as const;

export const parsePublicApiBaseUrl = (value: string | undefined): URL => {
  if (value === undefined || value === "" || value !== value.trim()) {
    throw new Error(`${publicApiBaseUrlVariable} is required`);
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${publicApiBaseUrlVariable} must be an absolute URL`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${publicApiBaseUrlVariable} must use HTTP(S)`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error(`${publicApiBaseUrlVariable} must not contain credentials`);
  }
  if (url.search !== "") {
    throw new Error(`${publicApiBaseUrlVariable} must not contain a query`);
  }
  if (url.hash !== "") {
    throw new Error(`${publicApiBaseUrlVariable} must not contain a hash`);
  }

  url.pathname = `${url.pathname.replace(/\/+$/, "")}/`;
  return url;
};

/**
 * The Backend decides product access on every request, so each content read
 * carries the visitor's session and is never stored. A refusal by that policy
 * is reported as such instead of as a failed read.
 */
const withVisitorSession = async <Result>(
  token: string | undefined,
  send: (fetch: typeof globalThis.fetch) => Promise<Result>,
  // A write already reports a missing session itself; only 403 is new to it.
  write = false,
): Promise<Result | AccessDeniedTransportResult> => {
  let denied: AccessDeniedTransportResult | null = null;
  const result = await send(async (input, init) => {
    const headers = new Headers(init?.headers);
    if (token !== undefined) headers.set("Authorization", `Bearer ${token}`);
    const response = await globalThis.fetch(input, {
      ...init,
      cache: "no-store",
      headers,
    });
    denied =
      write && response.status !== 403 ? null : accessDenied(response.status);
    return response;
  });
  return denied ?? result;
};

/** Whether this session may use the product; Web renders nothing protected without it. */
export const fetchServerProductAccess = async (
  token: string | undefined,
): Promise<ProductAccessTransportResult> => {
  try {
    const baseUrl = parsePublicApiBaseUrl(process.env.MOYA_PUBLIC_API_BASE_URL);
    return await fetchProductAccess(
      { baseUrl, fetch: globalThis.fetch },
      token,
    );
  } catch {
    return { state: "unavailable" };
  }
};

export const fetchServerCatalogPage = async (
  query: CatalogListTransportQuery = {},
  token?: string,
): Promise<CatalogPageTransportResult | AccessDeniedTransportResult> => {
  try {
    const baseUrl = parsePublicApiBaseUrl(process.env.MOYA_PUBLIC_API_BASE_URL);
    return await withVisitorSession(token, (fetch) =>
      fetchCatalogPage({ baseUrl, fetch }, query),
    );
  } catch {
    return { state: "unexpected-error" };
  }
};

export const fetchServerCatalogDetail = async (
  catalogId: string,
  token?: string,
): Promise<CatalogDetailTransportResult | AccessDeniedTransportResult> => {
  try {
    const baseUrl = parsePublicApiBaseUrl(process.env.MOYA_PUBLIC_API_BASE_URL);
    return await withVisitorSession(token, (fetch) =>
      fetchCatalogDetail({ baseUrl, fetch }, catalogId),
    );
  } catch {
    return { state: "unexpected-error" };
  }
};

export const fetchServerCatalogSearchPage = async (
  query: CatalogSearchTransportQuery,
  signal?: AbortSignal,
  token?: string,
): Promise<CatalogSearchTransportResult | AccessDeniedTransportResult> => {
  try {
    const baseUrl = parsePublicApiBaseUrl(process.env.MOYA_PUBLIC_API_BASE_URL);
    return await withVisitorSession(token, (fetch) =>
      fetchCatalogSearchPage({ baseUrl, fetch }, query, signal),
    );
  } catch {
    return { state: "unexpected-error" };
  }
};

export const fetchServerCatalogCommentPage = async (
  catalogId: string,
  query: CatalogCommentListingTransportQuery = {},
  signal?: AbortSignal,
  token?: string,
): Promise<CommentPageTransportResult | AccessDeniedTransportResult> => {
  try {
    const baseUrl = parsePublicApiBaseUrl(process.env.MOYA_PUBLIC_API_BASE_URL);
    return await withVisitorSession(token, (fetch) =>
      fetchCatalogCommentPage(
        { baseUrl, fetch },
        catalogId,
        query,
        signal,
        token,
      ),
    );
  } catch (error) {
    if (signal?.aborted === true) throw error;
    return { state: "unexpected-error" };
  }
};

export const fetchServerCatalogCommentReplyPage = async (
  catalogId: string,
  commentId: string,
  query: CatalogCommentTransportQuery = {},
  signal?: AbortSignal,
  token?: string,
): Promise<CommentReplyPageTransportResult | AccessDeniedTransportResult> => {
  try {
    const baseUrl = parsePublicApiBaseUrl(process.env.MOYA_PUBLIC_API_BASE_URL);
    return await withVisitorSession(token, (fetch) =>
      fetchCatalogCommentReplyPage(
        { baseUrl, fetch },
        catalogId,
        commentId,
        query,
        signal,
        token,
      ),
    );
  } catch (error) {
    if (signal?.aborted === true) throw error;
    return { state: "unexpected-error" };
  }
};

export const createServerCatalogComment = async (
  catalogId: string,
  token: string,
  body: unknown,
): Promise<
  CommentSubmissionTransportResult<CatalogComment> | AccessDeniedTransportResult
> => {
  try {
    const baseUrl = parsePublicApiBaseUrl(process.env.MOYA_PUBLIC_API_BASE_URL);
    return await withVisitorSession(
      token,
      (fetch) =>
        createCatalogComment({ baseUrl, fetch }, catalogId, token, body),
      true,
    );
  } catch {
    return { state: "unexpected-error" };
  }
};

export const createServerCatalogCommentReply = async (
  catalogId: string,
  commentId: string,
  token: string,
  body: unknown,
): Promise<
  | CommentSubmissionTransportResult<CatalogCommentReply>
  | AccessDeniedTransportResult
> => {
  try {
    const baseUrl = parsePublicApiBaseUrl(process.env.MOYA_PUBLIC_API_BASE_URL);
    return await withVisitorSession(
      token,
      (fetch) =>
        createCatalogCommentReply(
          { baseUrl, fetch },
          catalogId,
          commentId,
          token,
          body,
        ),
      true,
    );
  } catch {
    return { state: "unexpected-error" };
  }
};

/** Web relays the cookie credential explicitly; it never decodes or validates it. */
export const fetchServerCurrentUser = async (
  token: string,
): Promise<CurrentUserTransportResult> => {
  try {
    const baseUrl = parsePublicApiBaseUrl(process.env.MOYA_PUBLIC_API_BASE_URL);
    return await fetchCurrentUser({ baseUrl, fetch: globalThis.fetch }, token);
  } catch {
    return { state: "unexpected-error" };
  }
};

export const signInServerDevelopmentAccount = async (
  handle: string,
): Promise<DevelopmentSignInTransportResult> => {
  try {
    const baseUrl = parsePublicApiBaseUrl(process.env.MOYA_PUBLIC_API_BASE_URL);
    return await signInDevelopmentAccount(
      { baseUrl, fetch: globalThis.fetch },
      handle,
    );
  } catch {
    return { state: "unexpected-error" };
  }
};

export const signOutServerDevelopmentSession = async (
  token: string,
): Promise<DevelopmentSignOutTransportResult> => {
  try {
    const baseUrl = parsePublicApiBaseUrl(process.env.MOYA_PUBLIC_API_BASE_URL);
    return await signOutDevelopmentSession(
      { baseUrl, fetch: globalThis.fetch },
      token,
    );
  } catch {
    return { state: "unexpected-error" };
  }
};

/** True when the Backend refuses the presented Session itself: `me` answers 401. */
const communitySessionRefused = async (
  base: URL,
  token: string,
): Promise<boolean> => {
  try {
    const answer = await fetch(new URL("v1/me", base), {
      method: "GET",
      headers: { accept: "application/json", Authorization: `Bearer ${token}` },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
    await answer.body?.cancel().catch(() => undefined);
    return answer.status === 401;
  } catch {
    return false;
  }
};

/** Fixed business namespace relay. Credentials stay on the server and every read is private. */
export const relayServerAuthorCommunity = async (
  request: Request,
): Promise<Response> => {
  const headers: Record<string, string> = {
    "cache-control": "private, no-store",
    vary: "Cookie",
    "x-content-type-options": "nosniff",
  };
  const fail = (status: number) => new Response(null, { status, headers });
  if (!["GET", "POST", "PUT", "DELETE"].includes(request.method))
    return fail(405);
  const incoming = new URL(request.url);
  // Next's development Request.url may normalize the hostname to localhost.
  // Host is the browser's requested authority; scripts cannot forge it. Never
  // trust forwarded-host to turn a foreign Origin into an accepted mutation.
  const origin = request.headers.get("origin");
  const authority = request.headers.get("host") ?? incoming.host;
  let sameOrigin = origin === null;
  if (origin !== null) {
    try {
      const source = new URL(origin);
      sameOrigin =
        source.origin === origin &&
        source.host === authority &&
        source.protocol === incoming.protocol;
    } catch {
      sameOrigin = false;
    }
  }
  if (
    request.method !== "GET" &&
    (!sameOrigin || request.headers.get("sec-fetch-site") === "cross-site")
  )
    return fail(403);
  const prefix = "/api/community/";
  if (!incoming.pathname.startsWith(prefix)) return fail(404);
  const suffix = incoming.pathname.slice(prefix.length);
  const articleAuthoring =
    suffix === "article-authoring" || suffix.startsWith("article-authoring/");
  if (request.method === "PUT" && !articleAuthoring) return fail(405);
  try {
    if (
      suffix.split("/").some((p) => {
        const d = decodeURIComponent(p);
        return (
          !d ||
          d === "." ||
          d === ".." ||
          d.includes("\u0000") ||
          /[\\/]/u.test(d)
        );
      })
    )
      return fail(404);
    const base = parsePublicApiBaseUrl(process.env.MOYA_PUBLIC_API_BASE_URL);
    const target = new URL(`v1/community/${suffix}`, base);
    target.search = incoming.search;
    const token = readCommunitySessionToken(request.headers.get("cookie"));
    const outgoing: Record<string, string> = {
      accept: "application/json, image/png",
    };
    if (token !== undefined) outgoing.Authorization = `Bearer ${token}`;
    // Bind private inbox reads to the UI's confirmed account when another tab changed the cookie.
    if (
      request.method === "GET" &&
      (suffix === "notifications" || articleAuthoring)
    ) {
      const expected = request.headers.get("x-author-account");
      if (expected) {
        if (!/^user-[0-9a-f]{32}$/u.test(expected)) return fail(422);
        outgoing["x-author-account"] = expected;
      }
    }
    let bytes: Uint8Array | undefined;
    if (request.method !== "GET") {
      const type = request.headers.get("content-type");
      if (type !== "application/json" && type !== "image/png") return fail(422);
      outgoing["content-type"] = type;
      const expected = request.headers.get("x-author-account");
      if (expected) {
        if (!/^user-[0-9a-f]{32}$/u.test(expected)) return fail(422);
        outgoing["x-author-account"] = expected;
      }
      const id = request.headers.get("x-request-id");
      if (id) outgoing["x-request-id"] = id;
      const reader = request.body?.getReader();
      if (!reader) return fail(422);
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (articleAuthoring && type !== "application/json") return fail(422);
      const limit =
        type === "image/png"
          ? 4194304
          : articleAuthoring
            ? ARTICLE_DOCUMENT_LIMITS.documentBytes + 16_384
            : 100000;
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > limit) {
          await reader.cancel();
          return fail(413);
        }
        chunks.push(part.value);
      }
      bytes = new Uint8Array(Buffer.concat(chunks));
    }
    const send = (credentials: Record<string, string>) =>
      fetch(target, {
        method: request.method,
        headers: credentials,
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(15000),
        ...(bytes === undefined ? {} : { body: bytes as BodyInit }),
      });
    let upstream = await send(outgoing);
    // email-auth-v1: a Session the Backend no longer accepts (logged out or
    // factor-replaced on another device, expired, unknown) must not keep this
    // browser from public reads. Once the Backend refuses the Session itself
    // (not an account header that no longer matches it), the cookie is cleared
    // and a read is answered as for a signed-out browser; a write is not
    // repeated.
    if (
      upstream.status === 401 &&
      token !== undefined &&
      (await communitySessionRefused(base, token))
    ) {
      headers["set-cookie"] = serializeClearedCommunitySessionCookie(
        isSecureRequest(request),
      );
      if (request.method === "GET") {
        await upstream.body?.cancel().catch(() => undefined);
        const signedOut = { ...outgoing };
        delete signedOut.Authorization;
        upstream = await send(signedOut);
      }
    }
    if (articleAuthoring && upstream.status === 204) {
      await upstream.body?.cancel().catch(() => undefined);
      return new Response(null, { status: 204, headers });
    }
    const type = upstream.headers.get("content-type")?.split(";")[0];
    if (type !== "application/json" && type !== "image/png")
      return fail(upstream.ok ? 502 : upstream.status);
    const reader = upstream.body?.getReader();
    if (!reader) return fail(502);
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 4500000) {
        await reader.cancel();
        return fail(502);
      }
      chunks.push(part.value);
    }
    return new Response(new Uint8Array(Buffer.concat(chunks)), {
      status: upstream.status,
      headers: { ...headers, "content-type": type },
    });
  } catch {
    return fail(503);
  }
};

const editorialOwnerPattern = /^(article|collection)-[0-9a-f]{32}$/u;
const editorialLocalFile = /^[a-f0-9]{64}-[a-f0-9]{64}\.(png|jpg|webp)$/u;
const editorialMediaTypes: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  webp: "image/webp",
};

/** Every image source a published editorial detail carries. */
const editorialImageSources = (
  value: unknown,
  found: string[] = [],
): string[] => {
  if (Array.isArray(value))
    for (const item of value) editorialImageSources(item, found);
  else if (value !== null && typeof value === "object")
    for (const [key, item] of Object.entries(value)) {
      if (key === "src" && typeof item === "string") found.push(item);
      else editorialImageSources(item, found);
    }
  return found;
};

/**
 * Development-only caller, as for Catalog media: an editorial image is served
 * through the Web origin only when the published Article or Collection named
 * by `owner` shows it. Its loopback file URL comes from that published detail,
 * never from the request, and both reads are anonymous.
 */
export const relayServerLocalEditorialMedia = async (
  owner: string,
  file: string,
  token?: string,
): Promise<Response> => {
  const headers = {
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
  };
  const fail = (status: number) => new Response(null, { status, headers });
  const kind = editorialOwnerPattern.exec(owner)?.[1];
  const match = editorialLocalFile.exec(file);
  if (!kind || !match) return fail(404);
  const expected = editorialMediaTypes[match[1]!]!;
  try {
    const lookup = (session: string | undefined) =>
      fetch(
        new URL(
          `v1/community/editorial/${kind}s/${owner}`,
          parsePublicApiBaseUrl(process.env.MOYA_PUBLIC_API_BASE_URL),
        ),
        {
          method: "GET",
          headers: {
            accept: "application/json",
            ...(session === undefined
              ? {}
              : { Authorization: `Bearer ${session}` }),
          },
          cache: "no-store",
          redirect: "error",
          signal: AbortSignal.timeout(15000),
        },
      );
    let detail = await lookup(token);
    // As in the community relay: a Session the Backend refuses must not keep
    // this browser from a read that needs none. A closed beta refuses the
    // signed-out read as well, and that answer stands.
    if (detail.status === 401 && token !== undefined) {
      await detail.body?.cancel().catch(() => undefined);
      detail = await lookup(undefined);
    }
    if (!detail.ok) {
      await detail.body?.cancel().catch(() => undefined);
      return fail(
        accessDenied(detail.status)?.status ??
          (detail.status === 404 ? 404 : 503),
      );
    }
    const url = editorialImageSources(await detail.json())
      .map((src) => localCatalogFileUrl(src))
      .find((candidate) => candidate?.pathname === `/api/media/file/${file}`);
    if (!url) return fail(404);
    const response = await fetch(url, {
      method: "GET",
      headers: { accept: expected },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return fail(
        response.status === 404 || response.status === 403 ? 404 : 503,
      );
    }
    if (response.headers.get("content-type")?.split(";")[0] !== expected) {
      await response.body?.cancel().catch(() => undefined);
      return fail(502);
    }
    const reader = response.body?.getReader();
    if (!reader) return fail(502);
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > 12 * 1024 * 1024) {
        await reader.cancel();
        return fail(502);
      }
      chunks.push(next.value);
    }
    return new Response(new Uint8Array(Buffer.concat(chunks)), {
      status: 200,
      headers: { ...headers, "content-type": expected },
    });
  } catch {
    return fail(503);
  }
};

/** Development-only caller; look up published membership before an anonymous native file read. */
export const relayServerLocalCatalogMedia = async (
  catalogId: string,
  mediaId: string,
  token?: string,
): Promise<Response> => {
  const headers = {
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
  };
  const fail = (status: number) => new Response(null, { status, headers });
  try {
    const detail = await fetchServerCatalogDetail(catalogId, token);
    if (detail.state === "access-denied") return fail(detail.status);
    if (detail.state !== "success")
      return fail(detail.state === "not-found" ? 404 : 503);
    const media =
      detail.detail.media.find((item) => item.id === mediaId) ??
      (detail.detail.representativeMedia?.id === mediaId
        ? detail.detail.representativeMedia
        : undefined);
    const url = media ? localCatalogFileUrl(media.src) : null;
    if (!url) return fail(404);
    const response = await fetch(url, {
      method: "GET",
      headers: { accept: "image/png,image/jpeg,image/webp" },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok)
      return fail(
        response.status === 404 || response.status === 403 ? 404 : 503,
      );
    const type = response.headers.get("content-type")?.split(";")[0];
    if (!type || !["image/png", "image/jpeg", "image/webp"].includes(type))
      return fail(502);
    const reader = response.body?.getReader();
    if (!reader) return fail(502);
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > 12 * 1024 * 1024) {
        await reader.cancel();
        return fail(502);
      }
      chunks.push(next.value);
    }
    return new Response(new Uint8Array(Buffer.concat(chunks)), {
      headers: { ...headers, "content-type": type },
    });
  } catch {
    return fail(503);
  }
};

// Work publishing: dedicated streaming relays. JSON commands keep
// using relayServerAuthorCommunity; these two carry raw component bytes and
// private derivative bytes, which are never buffered in Web memory.

const publishingPrivateHeaders = {
  "cache-control": "private, no-store",
  vary: "Cookie",
  "x-content-type-options": "nosniff",
} as const;
/**
 * Sanity ceiling only, equal to the largest per-item and per-component size the
 * operator settings contract allows (8 GiB); the Backend enforces each
 * component's registered size exactly and the relay never buffers the body.
 */
const publishingUploadCeilingBytes = 8 * 1024 * 1024 * 1024;
/**
 * Marks an upload answer the relay produced because no usable Backend answer
 * arrived. The transfer's outcome is then unknown (the Backend may have
 * refused, failed or committed), so the client reconciles by reading the item
 * again. A genuine Backend refusal never carries this header.
 */
const publishingRelayHeader = "x-publishing-relay";
/** Bounded wait for the Backend's answer after the last component byte, or once an early answer begins. */
const publishingUploadResponseWaitMs = 60_000;
/** Bounded wait for derivative response headers; the body then streams without a timeout. */
const publishingMediaResponseWaitMs = 15_000;
const publishingUploadResponseMaxBytes = 64 * 1024;
const publishingUploadStatuses: ReadonlySet<number> = new Set([
  200, 401, 403, 404, 409, 413, 422, 503,
]);
const publishingMediaTypes: ReadonlySet<string> = new Set([
  "image/webp",
  "image/jpeg",
  "image/png",
  "video/mp4",
]);
const publishingMediaVariants: ReadonlySet<string> = new Set([
  "thumb",
  "display",
  "full",
  "cover",
  "motion",
]);
const publishingAccountPattern = /^user-[0-9a-f]{32}$/u;
const publishingAttemptPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const publishingComponentIdPattern = /^media-component-[0-9a-f]{32}$/u;
const publishingItemIdPattern = /^media-item-[0-9a-f]{32}$/u;
const publishingEditKeyPattern = /^(?:base|[0-9a-f]{32})$/u;
/** One range only: `bytes=start-`, `bytes=start-end` or a suffix `bytes=-length`. */
const publishingRangePattern = /^bytes=(?:(\d{1,16})-(\d{0,16})|-\d{1,16})$/u;

/**
 * A browser write must come from this origin. Unlike the generic relay, any
 * Fetch Metadata value other than same-origin is refused. A request without
 * Origin is not a browser cross-site write and still needs the session cookie.
 */
const isSameOriginPublishingWrite = (request: Request): boolean => {
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin") return false;
  const origin = request.headers.get("origin");
  if (origin === null) return true;
  const incoming = new URL(request.url);
  // Host is the browser's requested authority; forwarded-host is never trusted.
  const authority = request.headers.get("host") ?? incoming.host;
  try {
    const source = new URL(origin);
    return (
      source.origin === origin &&
      source.host === authority &&
      source.protocol === incoming.protocol
    );
  } catch {
    return false;
  }
};

const cancelQuietly = async (
  body: ReadableStream<Uint8Array> | null,
): Promise<void> => {
  try {
    await body?.cancel();
  } catch {
    /* The upstream body is already closed. */
  }
};

/** Reads a small upstream body with a running cap; null when it is larger. */
const readBoundedUpstreamBody = async (
  body: ReadableStream<Uint8Array> | null,
  limit: number,
): Promise<Uint8Array<ArrayBuffer> | null> => {
  if (body === null) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(part.value);
  }
  return new Uint8Array(Buffer.concat(chunks));
};

const mediaTypeOf = (response: Response): string | undefined =>
  response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();

/**
 * Development streaming relay for one media component upload (POST, raw
 * bytes). Web never buffers the body: a chunk is pulled from the browser only
 * when the Backend connection accepts more, so memory stays bounded to one
 * chunk. A browser disconnect aborts the Backend request. No timeout applies
 * while bytes flow; the answer after the last byte has a bounded wait. The
 * session cookie becomes a Bearer credential and redirects are never followed.
 *
 * A Backend JSON answer (200/401/404/409/413/422/503) passes through. When no
 * usable answer arrives the relay answers with `x-publishing-relay`: 502
 * `interrupted` (the Backend connection failed or closed before a complete
 * answer, e.g. an early refusal that closed the socket while bytes still
 * flowed), 504 `timeout` (the bounded answer wait elapsed) or 502
 * `invalid-answer` (an answer outside this contract). Those outcomes are
 * unknown to the browser, which must read the item again.
 */
export const relayServerPublishingUpload = async (
  request: Request,
  componentId: string,
): Promise<Response> => {
  const fail = (status: number) =>
    new Response(null, { status, headers: publishingPrivateHeaders });
  if (request.method !== "POST") return fail(405);
  if (!isSameOriginPublishingWrite(request)) return fail(403);
  if (
    new URL(request.url).search !== "" ||
    !publishingComponentIdPattern.test(componentId)
  )
    return fail(404);
  const account = request.headers.get("x-author-account");
  const attempt = request.headers.get("x-upload-attempt");
  if (
    account === null ||
    !publishingAccountPattern.test(account) ||
    attempt === null ||
    !publishingAttemptPattern.test(attempt) ||
    request.headers.get("content-type") !== "application/octet-stream" ||
    request.headers.has("transfer-encoding")
  )
    return fail(422);
  const length = request.headers.get("content-length");
  if (length === null) return fail(411);
  if (!/^[1-9]\d{0,15}$/u.test(length)) return fail(422);
  const declared = Number(length);
  if (declared > publishingUploadCeilingBytes) return fail(413);
  const source = request.body;
  if (source === null) return fail(422);
  const token = readCommunitySessionToken(request.headers.get("cookie"));
  if (token === undefined) return fail(401);
  let target: URL;
  try {
    target = new URL(
      `v1/community/publishing/uploads/${componentId}`,
      parsePublicApiBaseUrl(process.env.MOYA_PUBLIC_API_BASE_URL),
    );
  } catch {
    return fail(503);
  }
  if (request.signal.aborted) return fail(400);

  const upstreamAbort = new AbortController();
  const abortUpstream = () => upstreamAbort.abort();
  request.signal.addEventListener("abort", abortUpstream, { once: true });
  const reader = source.getReader();
  let relayed = 0;
  let complete = false;
  let lengthIssue: 413 | 422 | null = null;
  let responseWait: ReturnType<typeof setTimeout> | undefined;
  let answerTimedOut = false;
  /** Starts the one bounded wait: after the last byte, or once an answer has begun. */
  const boundAnswer = () => {
    responseWait ??= setTimeout(() => {
      answerTimedOut = true;
      abortUpstream();
    }, publishingUploadResponseWaitMs);
  };
  /** An answer without a usable Backend answer; see the relay contract above. */
  const unanswered = (
    status: 502 | 504,
    reason: "interrupted" | "timeout" | "invalid-answer",
  ) =>
    new Response(null, {
      status,
      headers: { ...publishingPrivateHeaders, [publishingRelayHeader]: reason },
    });
  const body = new ReadableStream<Uint8Array>(
    {
      pull: async (controller) => {
        const next = await reader.read();
        if (next.done) {
          if (relayed !== declared) {
            lengthIssue = 422;
            controller.error(new RangeError("upload ended before its length"));
            abortUpstream();
            return;
          }
          complete = true;
          controller.close();
          boundAnswer();
          return;
        }
        relayed += next.value.byteLength;
        if (relayed > declared) {
          lengthIssue = 413;
          controller.error(new RangeError("upload exceeds its length"));
          abortUpstream();
          return;
        }
        controller.enqueue(next.value);
      },
    },
    { highWaterMark: 0 },
  );
  const init: RequestInit & { duplex: "half" } = {
    method: "POST",
    headers: {
      accept: "application/json",
      Authorization: `Bearer ${token}`,
      "content-type": "application/octet-stream",
      "content-length": length,
      "x-author-account": account,
      "x-upload-attempt": attempt,
    },
    body,
    duplex: "half",
    cache: "no-store",
    redirect: "error",
    signal: upstreamAbort.signal,
  };
  try {
    const upstream = await fetch(target, init);
    boundAnswer();
    try {
      if (!publishingUploadStatuses.has(upstream.status)) {
        await cancelQuietly(upstream.body);
        return unanswered(502, "invalid-answer");
      }
      if (mediaTypeOf(upstream) !== "application/json") {
        await cancelQuietly(upstream.body);
        return upstream.status === 200
          ? unanswered(502, "invalid-answer")
          : fail(upstream.status);
      }
      const answer = await readBoundedUpstreamBody(
        upstream.body,
        publishingUploadResponseMaxBytes,
      );
      if (answer === null) return unanswered(502, "invalid-answer");
      return new Response(answer, {
        status: upstream.status,
        headers: {
          ...publishingPrivateHeaders,
          "content-type": "application/json",
        },
      });
    } finally {
      // An answer before the last byte (a superseded attempt, a size refusal)
      // ends the relay of the remaining bytes.
      if (!complete) upstreamAbort.abort();
    }
  } catch {
    if (lengthIssue !== null) return fail(lengthIssue);
    // Nobody is left to read an answer for a browser that went away.
    if (request.signal.aborted) return fail(400);
    return answerTimedOut
      ? unanswered(504, "timeout")
      : unanswered(502, "interrupted");
  } finally {
    clearTimeout(responseWait);
    request.signal.removeEventListener("abort", abortUpstream);
  }
};

/**
 * Development streaming relay for one private derivative (GET, at most one
 * byte range). The Backend authorizes the viewer; Web forwards the session as
 * a Bearer credential when present, streams the body back without a body
 * timeout and aborts the Backend read when the browser goes away.
 */
export const relayServerPublishingMedia = async (
  request: Request,
  itemId: string,
  variant: string,
  editKey: string,
): Promise<Response> => {
  const fail = (status: number, extra: Record<string, string> = {}) =>
    new Response(null, {
      status,
      headers: { ...publishingPrivateHeaders, ...extra },
    });
  if (request.method !== "GET" && request.method !== "HEAD") return fail(405);
  if (
    new URL(request.url).search !== "" ||
    !publishingItemIdPattern.test(itemId) ||
    !publishingMediaVariants.has(variant) ||
    !publishingEditKeyPattern.test(editKey)
  )
    return fail(404);
  const range = request.headers.get("range");
  if (range !== null) {
    const bounds = publishingRangePattern.exec(range);
    if (
      bounds === null ||
      (bounds[1] !== undefined &&
        bounds[2] !== undefined &&
        bounds[2] !== "" &&
        Number(bounds[1]) > Number(bounds[2]))
    )
      return fail(416);
  }
  let target: URL;
  try {
    target = new URL(
      `v1/community/publishing/media/${itemId}/${variant}/${editKey}`,
      parsePublicApiBaseUrl(process.env.MOYA_PUBLIC_API_BASE_URL),
    );
  } catch {
    return fail(503);
  }
  if (request.signal.aborted) return fail(400);
  const token = readCommunitySessionToken(request.headers.get("cookie"));
  const outgoing: Record<string, string> = {
    accept: "image/webp, image/jpeg, image/png, video/mp4",
  };
  if (token !== undefined) outgoing.Authorization = `Bearer ${token}`;
  if (range !== null) outgoing.range = range;

  const upstreamAbort = new AbortController();
  const abortUpstream = () => upstreamAbort.abort();
  request.signal.addEventListener("abort", abortUpstream, { once: true });
  const headersWait = setTimeout(abortUpstream, publishingMediaResponseWaitMs);
  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: "GET",
      headers: outgoing,
      cache: "no-store",
      redirect: "error",
      signal: upstreamAbort.signal,
    });
  } catch {
    request.signal.removeEventListener("abort", abortUpstream);
    return fail(503);
  } finally {
    clearTimeout(headersWait);
  }
  const contentRange = upstream.headers.get("content-range");
  if (upstream.status === 416) {
    await cancelQuietly(upstream.body);
    return fail(
      416,
      contentRange !== null && /^bytes \*\/\d{1,16}$/u.test(contentRange)
        ? { "content-range": contentRange }
        : {},
    );
  }
  if (upstream.status !== 200 && upstream.status !== 206) {
    await cancelQuietly(upstream.body);
    return fail(
      [401, 403, 404, 503].includes(upstream.status) ? upstream.status : 502,
    );
  }
  const type = mediaTypeOf(upstream);
  const length = upstream.headers.get("content-length");
  if (
    type === undefined ||
    !publishingMediaTypes.has(type) ||
    upstream.body === null ||
    (length !== null && !/^\d{1,16}$/u.test(length)) ||
    (upstream.status === 206 &&
      (contentRange === null ||
        !/^bytes \d{1,16}-\d{1,16}\/\d{1,16}$/u.test(contentRange)))
  ) {
    await cancelQuietly(upstream.body);
    return fail(502);
  }
  const headers: Record<string, string> = {
    ...publishingPrivateHeaders,
    "content-type": type,
    "cross-origin-resource-policy": "same-origin",
  };
  if (length !== null) headers["content-length"] = length;
  if (upstream.status === 206 && contentRange !== null)
    headers["content-range"] = contentRange;
  if (upstream.headers.get("accept-ranges") === "bytes")
    headers["accept-ranges"] = "bytes";
  if (request.method === "HEAD") {
    await cancelQuietly(upstream.body);
    return new Response(null, { status: upstream.status, headers });
  }
  return new Response(upstream.body, { status: upstream.status, headers });
};

/**
 * Same-origin authentication relay. A session token returned by the Backend is
 * stored in the HttpOnly cookie and removed before the body reaches the browser.
 */
export const relayServerCommunityAuth = async (
  request: Request,
): Promise<Response> => {
  const headers = {
    "cache-control": "private, no-store",
    vary: "Cookie",
    "x-content-type-options": "nosniff",
  };
  const fail = (status: number) => new Response(null, { status, headers });
  if (!["GET", "POST"].includes(request.method)) return fail(405);
  const incoming = new URL(request.url);
  const origin = request.headers.get("origin");
  const authority = request.headers.get("host") ?? incoming.host;
  let sameOrigin = origin === null;
  if (origin !== null) {
    try {
      const source = new URL(origin);
      sameOrigin =
        source.host === authority && source.protocol === incoming.protocol;
    } catch {
      sameOrigin = false;
    }
  }
  if (
    request.method !== "GET" &&
    (!sameOrigin || request.headers.get("sec-fetch-site") === "cross-site")
  )
    return fail(403);
  const prefix = "/api/community/auth/";
  if (!incoming.pathname.startsWith(prefix)) return fail(404);
  const suffix = incoming.pathname.slice(prefix.length);
  if (suffix === "sign-out" && request.method !== "POST") return fail(405);
  try {
    const base = parsePublicApiBaseUrl(process.env.MOYA_PUBLIC_API_BASE_URL);
    const target = new URL(`v1/community/auth/${suffix}`, base);
    const token = readCommunitySessionToken(request.headers.get("cookie"));
    const sourceHeaders =
      request.method === "POST" && process.env.NODE_ENV === "production"
        ? trustedAuthSourceHeaders(request)
        : {};
    if (sourceHeaders === null) return fail(403);
    const outgoing: Record<string, string> = {
      accept: "application/json",
      ...sourceHeaders,
    };
    if (token !== undefined) outgoing.authorization = `Bearer ${token}`;
    let body: string | undefined;
    if (request.method === "POST") {
      outgoing["content-type"] = "application/json";
      body = await request.text();
      if (body.length > 16_384) return fail(413);
    }
    const upstream = await fetch(target, {
      method: request.method,
      headers: outgoing,
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
      ...(body === undefined ? {} : { body }),
    });
    if (suffix === "sign-out") {
      const secure = isSecureRequest(request);
      return new Response(null, {
        status: upstream.status,
        headers: {
          ...headers,
          "set-cookie": serializeClearedCommunitySessionCookie(secure),
        },
      });
    }
    const type = upstream.headers.get("content-type") ?? "";
    if (!type.includes("application/json"))
      return fail(upstream.ok ? 502 : upstream.status);
    const payload: unknown = await upstream.json();
    // A misrouted Development Backend cannot advertise simulated verification
    // as a Production login capability. Real authentication is supplied by the
    // separately delivered Backend implementation through this same relay.
    if (suffix === "capabilities" && upstream.ok) {
      const capabilities = authCapabilitiesSchema.safeParse(payload);
      if (!capabilities.success) return fail(502);
      if (
        process.env.NODE_ENV === "production" &&
        capabilities.data.developmentOnly
      )
        return fail(503);
    }
    const secure = isSecureRequest(request);
    let setCookie: string | undefined;
    if (
      (suffix === "passwords/reset" &&
        upstream.status === 200 &&
        authPasswordResetResultSchema.safeParse(payload).success) ||
      (upstream.status === 401 &&
        token !== undefined &&
        (await communitySessionRefused(base, token)))
    )
      setCookie = serializeClearedCommunitySessionCookie(secure);
    if (
      typeof payload === "object" &&
      payload !== null &&
      "session" in payload
    ) {
      const session = payload.session;
      if (
        typeof session === "object" &&
        session !== null &&
        "token" in session &&
        "expiresAt" in session &&
        typeof session.token === "string" &&
        typeof session.expiresAt === "string"
      ) {
        setCookie = serializeCommunitySessionCookie(
          session.token,
          new Date(session.expiresAt),
          secure,
        );
        delete session.token;
      }
    }
    return Response.json(payload, {
      status: upstream.status,
      headers: {
        ...headers,
        ...(setCookie === undefined ? {} : { "set-cookie": setCookie }),
      },
    });
  } catch {
    return fail(503);
  }
};
