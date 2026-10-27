import { APIError } from "payload";

/**
 * The Owner's Payload Admin is only a client of the Backend operator boundary:
 * it holds the credential server-side, never in the browser, and never touches
 * community tables itself. The Backend stays the sole writer.
 */

export class CommunityOperatorError extends APIError {
  readonly code: string;

  constructor(code: string, status = 400) {
    super(code, status, { code }, true);
    this.code = code;
  }
}

/**
 * A dedicated variable, never the public Backend base URL: the operator
 * credential must not follow a value that could legitimately point off-box.
 */
const operatorBaseUrlVariable = "COMMUNITY_OPERATOR_BASE_URL" as const;
const operatorTokenVariable = "COMMUNITY_OPERATOR_TOKEN" as const;

const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** The boundary is reached over loopback only, whatever the scheme. */
const operatorBaseUrl = (): URL => {
  const value = process.env[operatorBaseUrlVariable];
  if (value === undefined || value === "")
    throw new CommunityOperatorError("OPERATOR_NOT_CONFIGURED", 503);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CommunityOperatorError("OPERATOR_NOT_CONFIGURED", 503);
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    !loopbackHosts.has(url.hostname) ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  )
    throw new CommunityOperatorError("OPERATOR_NOT_CONFIGURED", 503);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/`;
  return url;
};

const operatorToken = (): string => {
  const value = process.env[operatorTokenVariable];
  if (value === undefined || value === "")
    throw new CommunityOperatorError("OPERATOR_NOT_CONFIGURED", 503);
  return value;
};

/** A refused request (400/422) keeps its status so a view never offers to re-send it. */
const statusCode = (status: number): number =>
  status === 404
    ? 404
    : status === 409
      ? 409
      : status === 400
        ? 400
        : status === 422
          ? 422
          : status === 503
            ? 503
            : 502;

/**
 * The Backend's bare codes become Admin codes the view can explain: a stale
 * state is a conflict to refresh from, an unknown subject is gone, an
 * unavailable store is a retry later; anything else is a plain failure.
 */
const operatorFailureCode = (status: number): string =>
  status === 401
    ? "OPERATOR_UNAUTHORIZED"
    : status === 404
      ? "NOT_FOUND"
      : status === 409
        ? "STATE_CONFLICT"
        : status === 503
          ? "OPERATOR_UNAVAILABLE"
          : "OPERATION_FAILED";

/** The agent boundary answers 403 for a principal without the scope: final, never re-sent. */
const agentFailureCode = (status: number): string | null =>
  status === 403 ? "AGENT_FORBIDDEN" : null;

const operatorCallWith =
  (extraHeaders: Readonly<Record<string, string>>) =>
  async <Result>(
    method: "GET" | "POST" | "PUT",
    path: string,
    body?: unknown,
  ): Promise<Result> => {
    const url = new URL(`internal/community/${path}`, operatorBaseUrl());
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${operatorToken()}`,
          ...extraHeaders,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      // Never surface the URL, the credential or a driver message.
      throw new CommunityOperatorError("OPERATOR_UNREACHABLE", 502);
    }
    if (!response.ok) {
      // The agent boundary answers with its own final codes: a forbidden
      // principal, an exceeded manifest cap, a planning timeout, zero matches
      // or an unresolved author. Those survive the loopback hop unchanged;
      // every other status keeps the existing narrowing.
      let code = agentFailureCode(response.status);
      if (code === null && response.status === 422) {
        const reported = (
          (await response.json().catch(() => null)) as {
            error?: { code?: unknown };
          } | null
        )?.error?.code;
        if (typeof reported === "string" && /^[A-Z_]{3,64}$/u.test(reported))
          code = reported;
      }
      throw new CommunityOperatorError(
        code ?? operatorFailureCode(response.status),
        response.status === 403 || response.status === 422
          ? response.status
          : statusCode(response.status),
      );
    }
    return (await response.json()) as Result;
  };

export const callCommunityOperator = operatorCallWith({});

/**
 * The same loopback call, asserting a machine principal for the agent
 * boundary (Issue #141 r3, Phase B). The label is a server-side value from
 * the Payload operator identity, never a request field; the Backend checks
 * the principal's scopes on every call.
 */
export const callAgentOperator = (principal: string) =>
  operatorCallWith({ "x-agent-principal": principal });

/**
 * Submission media reach the Owner only as Backend derivatives (thumb,
 * display, full, cover, motion); an original or a master is never a variant.
 * The relay accepts exactly these rendered types and nothing a browser could
 * run as a document.
 */
export const OPERATOR_MEDIA_TYPES: ReadonlySet<string> = new Set([
  "image/webp",
  "image/jpeg",
  "image/png",
  "video/mp4",
]);

/** A derivative is bounded; a larger answer is refused rather than relayed. */
export const OPERATOR_MEDIA_MAXIMUM_BYTES = 256 * 1024 * 1024;
/**
 * Waiting for the Backend's headers, and the longest the relay goes without
 * moving a byte: a stalled Backend and a viewer that stopped reading (a
 * paused video) are both cut off; the browser asks again with a range.
 */
export const OPERATOR_MEDIA_WAIT_MS = 15_000;
/** No single relayed response lives longer than this, reading or not. */
export const OPERATOR_MEDIA_LIFETIME_MS = 10 * 60_000;

const contentRangePattern = /^bytes (\d{1,15})-(\d{1,15})\/(\d{1,15})$/u;
const contentLengthPattern = /^\d{1,15}$/u;
const requestedRangePattern = /^bytes=(\d{0,15})-(\d{0,15})$/u;

export interface OperatorMediaResponse {
  readonly status: 200 | 206;
  readonly contentType: string;
  readonly contentLength: string | null;
  readonly contentRange: string | null;
  /** True only when the Backend itself serves byte ranges. */
  readonly acceptsRanges: boolean;
  readonly body: ReadableStream<Uint8Array>;
}

export type OperatorMediaCall = (
  path: string,
  range: string | null,
  /** The viewer's request; its abort cancels the Backend request. */
  signal?: AbortSignal,
) => Promise<OperatorMediaResponse>;

const discard = (response: Response): void => {
  void response.body?.cancel().catch(() => undefined);
};

/**
 * A 206 answer must be exactly the one range that was asked for: the start
 * the viewer named (or the suffix it named), the end it named clamped to the
 * resource, and a declared length that matches the span.
 */
const partialAnswerMatches = (
  requested: string | null,
  contentRange: string | null,
  contentLength: string | null,
): boolean => {
  const answer =
    contentRange === null ? null : contentRangePattern.exec(contentRange);
  const asked =
    requested === null ? null : requestedRangePattern.exec(requested);
  if (answer === null || asked === null) return false;
  const start = Number(answer[1]);
  const end = Number(answer[2]);
  const size = Number(answer[3]);
  if (start > end || end >= size) return false;
  if (contentLength !== null && Number(contentLength) !== end - start + 1)
    return false;
  const first = asked[1];
  const last = asked[2];
  if (first === "")
    // A suffix range: the last N bytes.
    return end === size - 1 && start === Math.max(0, size - Number(last));
  if (start !== Number(first)) return false;
  return end === (last === "" ? size - 1 : Math.min(Number(last), size - 1));
};

/**
 * Streams one operator media response without buffering it. The credential
 * stays server-side; only an allow-listed content type, a validated length
 * and range, and the bytes themselves are handed back. A stalled Backend, a
 * viewer that stops reading and an overlong response are cut off; a viewer
 * that goes away cancels the Backend request, before or after its headers.
 */
const openOperatorBinary = async (
  path: string,
  range: string | null,
  signal: AbortSignal | undefined,
  allowedTypes: ReadonlySet<string>,
  maximumBytes: number,
): Promise<OperatorMediaResponse> => {
  const url = new URL(`internal/community/${path}`, operatorBaseUrl());
  const token = operatorToken();
  const controller = new AbortController();
  let finished = false;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let relay: ReadableStreamDefaultController<Uint8Array> | null = null;
  let stallTimer: ReturnType<typeof setTimeout> | undefined;
  let lifetimeTimer: ReturnType<typeof setTimeout> | undefined;
  const settle = (): void => {
    finished = true;
    clearTimeout(stallTimer);
    clearTimeout(lifetimeTimer);
    signal?.removeEventListener("abort", cutOff);
  };
  /** Ends the relay from outside a read: the Backend request is aborted and the viewer's body fails. */
  const cutOff = (): void => {
    if (finished) return;
    settle();
    controller.abort();
    void reader?.cancel().catch(() => undefined);
    relay?.error(new CommunityOperatorError("OPERATOR_UNREACHABLE", 502));
  };
  // Any progress re-arms the stall timer, whether or not the viewer is reading.
  const armStall = (): void => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(cutOff, OPERATOR_MEDIA_WAIT_MS);
  };
  signal?.addEventListener("abort", cutOff, { once: true });
  if (signal?.aborted === true) cutOff();
  const headerTimer = setTimeout(
    () => controller.abort(),
    OPERATOR_MEDIA_WAIT_MS,
  );
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
      headers: {
        Accept: [...allowedTypes].join(", "),
        "Accept-Encoding": "identity",
        Authorization: `Bearer ${token}`,
        ...(range === null ? {} : { Range: range }),
      },
    });
  } catch {
    settle();
    // Never surface the URL, the credential or a driver message.
    throw new CommunityOperatorError("OPERATOR_UNREACHABLE", 502);
  } finally {
    clearTimeout(headerTimer);
  }
  const refusal = (code: string, status: number): CommunityOperatorError => {
    discard(response);
    settle();
    return new CommunityOperatorError(code, status);
  };
  if (finished) throw refusal("OPERATOR_UNREACHABLE", 502);
  if (response.status === 416) throw refusal("RANGE_NOT_SATISFIABLE", 416);
  if (!response.ok)
    throw refusal(
      operatorFailureCode(response.status),
      statusCode(response.status),
    );
  const contentType = (response.headers.get("content-type") ?? "")
    .split(";")[0]!
    .trim()
    .toLowerCase();
  const encoding = (response.headers.get("content-encoding") ?? "identity")
    .trim()
    .toLowerCase();
  const declaredLength = response.headers.get("content-length");
  const contentLength =
    declaredLength !== null && contentLengthPattern.test(declaredLength)
      ? declaredLength
      : null;
  const contentRange = response.headers.get("content-range");
  const source = response.body;
  if (
    (response.status !== 200 && response.status !== 206) ||
    !allowedTypes.has(contentType) ||
    encoding !== "identity" ||
    source === null ||
    (declaredLength !== null && contentLength === null) ||
    (contentLength !== null && Number(contentLength) > maximumBytes) ||
    (response.status === 206 &&
      !partialAnswerMatches(range, contentRange, contentLength))
  )
    throw refusal("OPERATOR_RESPONSE_INVALID", 502);
  // Never more than declared, and never more than the derivative bound.
  const limit = contentLength === null ? maximumBytes : Number(contentLength);
  const backend = source.getReader();
  reader = backend;
  let relayed = 0;
  const body = new ReadableStream<Uint8Array>({
    start(stream) {
      relay = stream;
      armStall();
      lifetimeTimer = setTimeout(cutOff, OPERATOR_MEDIA_LIFETIME_MS);
    },
    async pull(stream) {
      if (finished) return;
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await backend.read();
      } catch {
        if (finished) return;
        settle();
        stream.error(new CommunityOperatorError("OPERATOR_UNREACHABLE", 502));
        return;
      }
      if (finished) return;
      if (chunk.done) {
        settle();
        stream.close();
        return;
      }
      relayed += chunk.value.byteLength;
      if (relayed > limit) {
        settle();
        controller.abort();
        void backend.cancel().catch(() => undefined);
        stream.error(
          new CommunityOperatorError("OPERATOR_RESPONSE_INVALID", 502),
        );
        return;
      }
      armStall();
      stream.enqueue(chunk.value);
    },
    async cancel() {
      settle();
      controller.abort();
      await backend.cancel().catch(() => undefined);
    },
  });
  return {
    status: response.status === 206 ? 206 : 200,
    contentType,
    contentLength,
    contentRange: response.status === 206 ? contentRange : null,
    acceptsRanges:
      response.status === 206 ||
      response.headers.get("accept-ranges")?.trim().toLowerCase() === "bytes",
    body,
  };
};

/** Existing publishing previews retain their derivative-only policy. */
export const openCommunityOperatorMedia: OperatorMediaCall = (
  path,
  range,
  signal,
) =>
  openOperatorBinary(
    path,
    range,
    signal,
    OPERATOR_MEDIA_TYPES,
    OPERATOR_MEDIA_MAXIMUM_BYTES,
  );

/** Private report evidence is downloaded as an attachment, never embedded. */
export const OPERATOR_EVIDENCE_TYPES: ReadonlySet<string> = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
]);
export const OPERATOR_EVIDENCE_MAXIMUM_BYTES = 8 * 1024 * 1024;
export const openCommunityOperatorEvidence: OperatorMediaCall = (
  path,
  range,
  signal,
) =>
  openOperatorBinary(
    path,
    range,
    signal,
    OPERATOR_EVIDENCE_TYPES,
    OPERATOR_EVIDENCE_MAXIMUM_BYTES,
  );

/** The same bounded private relay, restricted to existing small Catalog WebP. */
export const openCatalogOperatorThumbnail: OperatorMediaCall = (
  path,
  _range,
  signal,
) =>
  openOperatorBinary(path, null, signal, new Set(["image/webp"]), 512 * 1024);
