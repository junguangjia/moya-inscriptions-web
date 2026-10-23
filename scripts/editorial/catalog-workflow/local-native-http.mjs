import http from "node:http";
import https from "node:https";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { URL } from "node:url";
import { setTimeout, clearTimeout } from "node:timers";
import {
  createNativeUploadFetch,
  NativeChunkBody,
  NativeStreamBody,
} from "../native-stream-fetch.mjs";
import { digest, fail, targetIdentity, verifyPrincipal } from "./identity.mjs";
import {
  nativeMediaMetadataProjection,
  nativeCatalogMetadataProjection,
} from "./registered-media-proof.mjs";
import { normalizePayloadBridgeBinding } from "./catalog-delivery-journal.mjs";
import {
  normalizeProductionAuthority,
  assertProductionCommand,
} from "./production-authority.mjs";
import {
  markTransferDrained,
  reserveTransfer,
  settleTransfer,
  transferUsage,
} from "./transfer-budget.mjs";

const { AbortController, AbortSignal, Headers, Response } = globalThis;
const bytesHash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const clone = (value) => JSON.parse(JSON.stringify(value));
const hash = (value) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const ALLOWED_CODES = new Set([
  "CATALOG_DELIVERY_NOT_CONFIGURED",
  "CATALOG_DELIVERY_PREPARATION_REQUIRED",
  // Admin refuses a source edge beyond the 65,535 px delivery bound (422).
  "CATALOG_DELIVERY_SOURCE_TOO_LARGE",
  "REVISION_CONFLICT",
  "CONCURRENT_OPERATION_BUSY",
]);
const REFUSAL_RETRYABLE = new Set(["save-draft", "native-withdraw"]);

/** A recorded attempt the server answered in full with a refusal (4xx): the
 * request reached Native and was not applied, so it may be sent again.
 */
export const definitivelyRejected = (row) =>
  row.status === "COMPLETE" &&
  Number.isSafeInteger(row.httpStatus) &&
  row.httpStatus >= 400 &&
  row.httpStatus < 500;

export function validateLocalFixture(manifest, fixture) {
  let url;
  try {
    url = new URL(fixture?.origin);
  } catch {
    fail("LOCAL_FIXTURE_REQUIRED");
  }
  if (
    manifest.target.instance !== "development" ||
    url.origin !== manifest.target.origin ||
    url.origin !== fixture.origin ||
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    !hash(fixture.id) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    fail("LOCAL_FIXTURE_REQUIRED");
  return { origin: url.origin, id: fixture.id };
}

export function nativeRouteClass(route, method) {
  if (method === "GET" && route === "/__catalog_fixture")
    return "fixture-handshake";
  if (method === "GET" && route === "/api/users/me") return "principal";
  if (
    method === "GET" &&
    /^\/api\/editorial-receipts\?where\[deduplicationKey\]\[equals\]=[a-f0-9]{64}&limit=2&depth=0$/.test(
      route,
    )
  )
    return "save-receipt";
  if (
    method === "GET" &&
    /^\/api\/media\?where\[mediaId\]\[equals\]=[A-Za-z0-9_-]{1,128}&limit=1&depth=0$/.test(
      route,
    )
  )
    return "media-metadata";
  if (
    method === "GET" &&
    /^\/api\/catalogs\/[1-9]\d*\?depth=0&draft=false$/.test(route)
  )
    return "native-main";
  if (
    method === "PATCH" &&
    /^\/api\/catalogs\/[1-9]\d*\?draft=false&depth=0$/.test(route)
  )
    return "native-withdraw";
  if (method === "POST" && route === "/api/editorial/read-draft")
    return "native-draft";
  if (method === "POST" && route === "/api/editorial/save-draft")
    return "save-draft";
  if (
    method === "POST" &&
    /^\/api\/editorial\/(prepare-catalog-delivery|read-catalog-delivery|request-catalog-release|release-catalog-delivery|cancel-catalog-delivery)$/.test(
      route,
    )
  )
    return "delivery";
  if (
    method === "POST" &&
    route === "/api/editorial/catalog-delivery-capabilities"
  )
    return "capabilities";
  if (
    method === "POST" &&
    /^\/api\/editorial\/media-upload\/(start|status|complete)$/.test(route)
  )
    return "upload-control";
  if (
    method === "POST" &&
    /^\/api\/editorial\/media-upload\/(chunk|stream)\/[a-f0-9]{64}\/(0|[1-9]\d{0,7})$/.test(
      route,
    )
  )
    return "upload-binary";
  fail("LOCAL_NATIVE_ROUTE_REJECTED");
}

/** Real HTTP Native protocol, strictly to a verified synthetic loopback fixture. */
function createBoundedNativeHTTP(
  {
    manifest,
    fixture,
    journal,
    persist,
    assertAdmission,
    deadline,
    timeoutMs = 1000,
  },
  boundary,
) {
  const target = boundary.target ?? validateLocalFixture(manifest, fixture);
  const targetIdentitySha256 = targetIdentity(manifest);
  if (
    journal.executionKind !==
      (boundary.kind === "production-native" ? "native-https" : "local-http") ||
    journal.budget.executionKind !== journal.executionKind ||
    typeof persist !== "function" ||
    typeof assertAdmission !== "function" ||
    !Number.isFinite(deadline) ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 100 ||
    timeoutMs > 30000
  )
    fail("LOCAL_HTTP_ARGUMENTS_INVALID");
  let verifiedFixture = ["payload-isolated", "production-native"].includes(
      boundary.kind,
    ),
    activeRequests = 0,
    closing = false;
  const controllers = new Set(),
    pending = new Set();
  const active = (signal) => {
    if (closing) fail("LOCAL_HTTP_CLOSED");
    if (signal?.aborted) fail("WORKFLOW_CANCELLED");
    if (Date.now() >= deadline) fail("WORKFLOW_DEADLINE_EXCEEDED");
  };
  const send = async (
    route,
    method = "GET",
    body,
    signal,
    extraHeaders = {},
  ) => {
    if (closing) fail("LOCAL_HTTP_CLOSED");
    active(signal);
    if (
      Object.keys(extraHeaders).some(
        (key) =>
          ![
            "content-length",
            "x-editorial-chunk-sha256",
            "x-editorial-stream-sha256",
          ].includes(key.toLowerCase()),
      )
    )
      fail("LOCAL_NATIVE_HEADERS_REJECTED");
    const routeClass = nativeRouteClass(route, method);
    boundary.assertRoute?.(route, method, body);
    if (
      routeClass === "native-withdraw" &&
      (!body ||
        Object.keys(body).length !== 2 ||
        !Number.isSafeInteger(body.revision) ||
        body.revision < 1 ||
        body._status !== "draft")
    )
      fail("LOCAL_NATIVE_PUBLICATION_NOT_BOUND");
    if (!verifiedFixture && routeClass !== "fixture-handshake")
      fail("LOCAL_FIXTURE_NOT_VERIFIED");
    const nativeBody =
      body instanceof NativeChunkBody || body instanceof NativeStreamBody;
    const binary = nativeBody || body instanceof Uint8Array;
    const bodyBytes = nativeBody
      ? body.bytes.subarray(body.offset, body.offset + body.byteLength)
      : body instanceof Uint8Array
        ? body
        : body === undefined
          ? Buffer.alloc(0)
          : Buffer.from(JSON.stringify(body));
    if (
      boundary.maximumRequestBodyBytes !== undefined &&
      bodyBytes.length > boundary.maximumRequestBodyBytes
    )
      fail("PAYLOAD_REQUEST_BODY_LIMIT");
    const logicalKey = digest({
      scope: journal.scopeSha256,
      method,
      route,
      bodySha256: bytesHash(bodyBytes),
    });
    const freshRead =
      [
        "fixture-handshake",
        "principal",
        "save-receipt",
        "media-metadata",
        "native-main",
        "native-draft",
        "capabilities",
      ].includes(routeClass) ||
      route.endsWith("/status") ||
      route.endsWith("/read-catalog-delivery");
    // Every check that can still refuse the request runs before its attempt is
    // recorded: a request refused here was never sent, so it must not leave a
    // pending attempt that blocks the caller's retry.
    await assertAdmission({ route, method });
    active(signal);
    const authorization = await boundary.authorization({ route, method });
    await assertAdmission({ route, method });
    active(signal);
    // A save or withdrawal the server definitively refused changed nothing;
    // only attempts that may have been applied count against its limit.
    const prior = journal.requests.filter(
      (row) =>
        row.logicalKey === logicalKey &&
        !(REFUSAL_RETRYABLE.has(routeClass) && definitivelyRejected(row)),
    );
    const logicalAttempt = freshRead ? 1 : prior.length + 1;
    const attemptLimit =
      routeClass === "native-withdraw" ? 1 : journal.budget.limits.maxAttempts;
    if (!freshRead && logicalAttempt > attemptLimit)
      return {
        ok: false,
        code: "NATIVE_REQUEST_ATTEMPT_LIMIT",
        retryable: false,
      };
    const sequence = journal.requests.length + 1;
    const requestSha256 = digest({ logicalKey, sequence, logicalAttempt });
    const maximumDownloadBytes = journal.responseByteLimit;
    let reservation;
    try {
      reservation = reserveTransfer(journal.budget, {
        requestSha256,
        maximumUploadBytes: bodyBytes.length,
        maximumDownloadBytes,
      });
    } catch {
      return { ok: false, code: "TRANSFER_BUDGET_EXCEEDED", retryable: false };
    }
    const row = {
      sequence,
      logicalKey,
      logicalAttempt,
      requestSha256,
      route,
      routeClass,
      method,
      status: "PENDING",
      httpStatus: null,
      requestBodyBytes: 0,
      responseBodyBytes: 0,
      binaryBodyBytes: 0,
      responseSha256: null,
      receipt: null,
      drained: false,
    };
    journal.requests.push(row);
    try {
      await persist();
    } catch {
      // hard admission: observers never decide whether transmission may start
      return { ok: false, code: "CHECKPOINT_PERSIST_FAILED", retryable: false };
    }
    active(signal);
    let actualUploadBytes = 0,
      actualDownloadBytes = 0,
      response,
      completed = false;
    let resolveDrained;
    const drained = new Promise((resolve) => {
      resolveDrained = resolve;
    });
    const awaitDrain = async () => {
      let timer;
      try {
        await Promise.race([
          drained,
          new Promise((resolve) => {
            timer = setTimeout(resolve, Math.min(timeoutMs, 1000));
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    };
    const closed = () => {
      row.drained = true;
      resolveDrained();
    };
    const controller = new AbortController();
    controllers.add(controller);
    const requestSignal = AbortSignal.any([
      controller.signal,
      ...(signal ? [signal] : []),
      AbortSignal.timeout(
        Math.min(timeoutMs, Math.max(1, deadline - Date.now())),
      ),
    ]);
    const accountWrite = (count) => {
      actualUploadBytes += count;
      row.requestBodyBytes = actualUploadBytes;
      if (binary) row.binaryBodyBytes = actualUploadBytes;
    };
    const fallback = async (address, options) =>
      new Promise((resolve, reject) => {
        if (options.signal.aborted) {
          closed();
          reject(
            Object.assign(new Error("TRANSPORT_UNCERTAIN"), {
              code: "TRANSPORT_UNCERTAIN",
            }),
          );
          return;
        }
        let incoming;
        const request = (
          new URL(address).protocol === "https:" ? https : http
        ).request(address, {
          method: options.method,
          headers: options.headers,
          agent: false,
        });
        const abort = () => {
          request.destroy();
          incoming?.destroy();
        };
        options.signal.addEventListener("abort", abort, { once: true });
        request.once("close", () => {
          options.signal.removeEventListener("abort", abort);
          closed();
        });
        request.once("error", () =>
          reject(
            Object.assign(new Error("TRANSPORT_UNCERTAIN"), {
              code: "TRANSPORT_UNCERTAIN",
            }),
          ),
        );
        request.once("response", (value) => {
          incoming = value;
          const headers = new Headers();
          for (const [key, item] of Object.entries(value.headers))
            if (item !== undefined)
              headers.set(key, Array.isArray(item) ? item.join(", ") : item);
          try {
            resolve(
              new Response(Readable.toWeb(value), {
                status: value.statusCode,
                headers,
              }),
            );
          } catch {
            value.destroy();
            request.destroy();
            reject(
              Object.assign(new Error("TRANSPORT_UNCERTAIN"), {
                code: "TRANSPORT_UNCERTAIN",
              }),
            );
          }
        });
        if (options.signal.aborted) {
          abort();
          return;
        }
        if (bodyBytes.length)
          request.write(bodyBytes, (error) => {
            if (!error) accountWrite(bodyBytes.length);
          });
        request.end();
      });
    const nativeFetch = createNativeUploadFetch(fallback, {
      onRequestClosed: closed,
    });
    if (nativeBody) {
      const observer = body.onWrite;
      body.onWrite = async (count, written) => {
        accountWrite(count);
        await observer(count, written);
      };
    }
    activeRequests++;
    try {
      response = await nativeFetch(`${target.origin}${route}`, {
        method,
        redirect: "error",
        signal: requestSignal,
        headers: {
          ...(routeClass === "fixture-handshake"
            ? {}
            : { Authorization: authorization }),
          ...(boundary.kind === "synthetic-http"
            ? { "x-catalog-fixture": target.id }
            : {}),
          "x-catalog-request-sha256": requestSha256,
          ...(body === undefined
            ? {}
            : {
                "Content-Type": binary
                  ? "application/octet-stream"
                  : "application/json",
                "Content-Length": String(bodyBytes.length),
              }),
          ...extraHeaders,
        },
        body: body === undefined ? undefined : nativeBody ? body : bodyBytes,
      });
      row.httpStatus = response.status;
      const reader = response.body?.getReader();
      if (
        !reader ||
        (boundary.kind === "synthetic-http" &&
          response.headers.get("x-catalog-fixture") !== target.id) ||
        (response.status >= 300 && response.status < 400)
      )
        fail("LOCAL_FIXTURE_RESPONSE_INVALID");
      const chunks = [];
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        actualDownloadBytes += part.value.length;
        row.responseBodyBytes = actualDownloadBytes;
        if (actualDownloadBytes > maximumDownloadBytes) {
          await reader.cancel();
          fail("RESPONSE_TOO_LARGE");
        }
        chunks.push(Buffer.from(part.value));
      }
      const bytes = Buffer.concat(chunks);
      row.responseSha256 = bytesHash(bytes);
      let json;
      try {
        json = JSON.parse(bytes.toString("utf8"));
      } catch {
        fail("RESPONSE_INVALID");
      }
      const metadataSha256 =
        routeClass === "media-metadata" && json.docs?.length === 1
          ? digest(nativeMediaMetadataProjection(json))
          : boundary.kind === "production-native" &&
              routeClass === "native-draft" &&
              response.ok
            ? digest(nativeCatalogMetadataProjection(json))
            : null;
      if (routeClass === "fixture-handshake") {
        if (
          !response.ok ||
          json.kind !== "catalog-native-isolated-http-v1" ||
          json.fixtureId !== target.id
        )
          fail("LOCAL_FIXTURE_RESPONSE_INVALID");
        verifiedFixture = true;
      }
      await awaitDrain();
      completed = true;
      row.status =
        row.drained && actualUploadBytes === bodyBytes.length
          ? "COMPLETE"
          : "UNKNOWN";
      row.receipt = {
        version: 1,
        executionKind: journal.executionKind,
        scopeSha256: journal.scopeSha256,
        targetIdentitySha256,
        requestSha256,
        route,
        method,
        httpStatus: response.status,
        transportStatus: row.status,
        responseSha256: row.responseSha256,
        resultSha256: digest(json),
        metadataSha256,
        ...(boundary.kind === "production-native"
          ? { observedAt: new Date().toISOString() }
          : {}),
      };
      settleTransfer(journal.budget, {
        requestSha256,
        attempt: reservation.attempt,
        status: row.status,
        actualUploadBytes,
        actualDownloadBytes,
        evidenceSha256: digest({
          requestSha256,
          status: response.status,
          responseSha256: row.responseSha256,
        }),
      });
      await persist();
      return response.ok && json?.ok !== false
        ? {
            ok: true,
            result: json,
            nativeReceipt: Object.freeze(clone(row.receipt)),
            streamUploadVersion: response.headers.get(
              "x-editorial-upload-stream",
            ),
          }
        : {
            ok: false,
            httpStatus: response.status,
            retryable:
              response.status === 429 ||
              response.status >= 500 ||
              (body instanceof NativeChunkBody &&
                response.status === 409 &&
                json?.error?.code === "CONCURRENT_OPERATION_BUSY"),
            code: ALLOWED_CODES.has(json?.error?.code)
              ? json.error.code
              : response.status === 409
                ? "REVISION_CONFLICT"
                : "NATIVE_REQUEST_REJECTED",
          };
    } catch (error) {
      if (completed) throw error; // completion persistence must never become a zero-byte failure
      row.status = "UNKNOWN";
      settleTransfer(journal.budget, {
        requestSha256,
        attempt: reservation.attempt,
        status: "UNKNOWN",
        actualUploadBytes,
        actualDownloadBytes,
        evidenceSha256: null,
      });
      await persist();
      return {
        ok: false,
        code:
          error.code === "RESPONSE_TOO_LARGE"
            ? error.code
            : "TRANSPORT_UNCERTAIN",
        retryable: error.code !== "RESPONSE_TOO_LARGE",
      };
    } finally {
      controller.abort();
      await awaitDrain();
      if (row.drained) {
        if (row.status === "UNKNOWN") {
          settleTransfer(journal.budget, {
            requestSha256,
            attempt: reservation.attempt,
            status: "UNKNOWN",
            actualUploadBytes,
            actualDownloadBytes,
            evidenceSha256: null,
          });
          markTransferDrained(
            journal.budget,
            requestSha256,
            digest({ requestSha256, event: "request-close" }),
          );
        }
        activeRequests--;
      }
      try {
        await persist();
      } finally {
        controllers.delete(controller);
      }
    }
  };
  const trackedSend = (...args) => {
    const operation = send(...args);
    pending.add(operation);
    operation.then(
      () => pending.delete(operation),
      () => pending.delete(operation),
    );
    return operation;
  };
  return {
    kind: "local-http",
    send: trackedSend,
    handshake: () => trackedSend("/__catalog_fixture"),
    close: async () => {
      closing = true;
      for (const controller of controllers) controller.abort();
      await Promise.allSettled([...pending]);
    },
    metrics: () => ({
      activeRequests,
      ...transferUsage(journal.budget),
      binaryBodyBytes: journal.requests.reduce(
        (sum, row) => sum + row.binaryBodyBytes,
        0,
      ),
    }),
    snapshot: () => clone(journal),
  };
}

/** Real CMS HTTPS. No fixture handshake, fixture header, login or privilege change. */
export function createProductionNativeHTTP(options) {
  const manifest = options.manifest;
  const binding = normalizeProductionAuthority(manifest, options.binding);
  assertProductionCommand(binding, options.command, manifest);
  if (
    options.journal.transportKind !== "production-native" ||
    options.journal.bindingSha256 !== digest(binding) ||
    options.journal.budget.limits.maxRequests > binding.caps.requests ||
    options.journal.budget.limits.maxUploadBytes >
      binding.caps.acceptedRequestBodyTotal ||
    options.journal.budget.limits.maxDownloadBytes >
      binding.caps.responseBodyTotal ||
    options.journal.responseByteLimit > binding.caps.responseBodyTotal ||
    typeof options.authorization !== "function" ||
    typeof options.assertBindingActive !== "function" ||
    typeof options.assertRoute !== "function"
  )
    fail("PRODUCTION_TRANSPORT_INVALID");
  let principal, verifiedHeader, observedHeader;
  const client = createBoundedNativeHTTP(
    {
      ...options,
      deadline: Math.min(
        options.deadline,
        Date.parse(binding.expiresAt),
        Date.parse(binding.credentialExpiresAt),
      ),
      assertAdmission: async (context) => {
        await options.assertAdmission();
        await options.assertBindingActive();
        await options.beforeRequest?.(context);
        normalizeProductionAuthority(manifest, binding);
      },
    },
    {
      kind: "production-native",
      target: { origin: binding.origin },
      maximumRequestBodyBytes: binding.caps.requestBodyPerRequest,
      assertRoute: (route, method, body) => {
        if (route === "/api/users/me" && method === "GET") return;
        if (!principal) fail("PRINCIPAL_NOT_VERIFIED");
        options.assertRoute(route, method, body);
      },
      authorization: async ({ route }) => {
        let header;
        try {
          header = await options.authorization({
            origin: binding.origin,
            actorId: binding.actorId,
          });
        } catch {
          fail("PRODUCTION_CREDENTIAL_PROVIDER_UNAVAILABLE");
        }
        if (
          typeof header !== "string" ||
          !/^(JWT [A-Za-z0-9_.-]{20,16384}|users API-Key [A-Za-z0-9_.~+/-]{16,16384})$/.test(
            header,
          )
        )
          fail("PRODUCTION_CREDENTIAL_PROVIDER_INVALID");
        if (
          route !== "/api/users/me" &&
          (!verifiedHeader || header !== verifiedHeader)
        )
          fail("PRODUCTION_CREDENTIAL_REVERIFY_REQUIRED");
        if (route === "/api/users/me") observedHeader = header;
        return header;
      },
    },
  );
  return {
    ...client,
    kind: "production-native",
    handshake: undefined,
    verifyPrincipal: async () => {
      const response = await client.send(
        "/api/users/me",
        "GET",
        undefined,
        options.signal,
      );
      if (!response.ok) fail(response.code);
      const user = response.result.user;
      if (user?.collection !== undefined && user.collection !== "users")
        fail("PRINCIPAL_OR_SCOPE_CHANGED");
      const actual = {
        ...manifest.target,
        actorId: user?.id,
        role: user?.role,
        verified: true,
        scopeCatalogIds:
          user?.role === "owner"
            ? manifest.records.map((r) => r.catalogId)
            : (user?.scopeCatalogIds ?? []),
      };
      verifyPrincipal(manifest, actual);
      verifiedHeader = observedHeader;
      principal = actual;
      return {
        ...actual,
        scopeBasis:
          user.role === "owner"
            ? "VERIFIED_OWNER_GLOBAL"
            : "NATIVE_EXPLICIT_SCOPE",
      };
    },
  };
}

export function createLocalNativeHTTP(options) {
  return createBoundedNativeHTTP(options, {
    kind: "synthetic-http",
    authorization: async () => "users API-Key SYNTHETIC_LOCAL_ONLY",
  });
}

/** Separate real-Payload loopback boundary. It never reads credentials itself.
 * The provider may only be connected inside the platform owner's live window.
 */
export function createPayloadIsolatedNativeHTTP(options) {
  const binding = normalizePayloadBridgeBinding(options.manifest, {
    ...options.binding,
    status: "READY",
    credentialMaterialInThisFile: false,
  });
  if (
    digest(binding) !== digest(options.binding) ||
    options.journal.transportKind !== "payload-isolated" ||
    options.journal.bindingSha256 !== digest(binding) ||
    typeof options.authorization !== "function" ||
    typeof options.assertBindingActive !== "function" ||
    typeof options.isIntentInScope !== "function" ||
    options.journal.budget.limits.maxRequests > binding.caps.requests ||
    options.journal.budget.limits.maxUploadBytes >
      binding.caps.acceptedRequestBodyTotal ||
    options.journal.budget.limits.maxDownloadBytes >
      binding.caps.responseBodyTotal ||
    options.journal.responseByteLimit > binding.caps.responseBodyTotal
  )
    fail("PAYLOAD_ISOLATED_TRANSPORT_INVALID");
  const manifest = options.manifest,
    catalogId = binding.fixtureCatalogDocumentId;
  let principal = null;
  const routeGuard = (route, method, body) => {
    if (route === "/api/users/me" && method === "GET") return;
    if (!principal) fail("PRINCIPAL_NOT_VERIFIED");
    if (
      method === "GET" &&
      route === `/api/catalogs/${catalogId}?depth=0&draft=false`
    )
      return;
    if (
      method === "PATCH" &&
      route === `/api/catalogs/${catalogId}?draft=false&depth=0`
    )
      return;
    if (
      method === "GET" &&
      manifest.records[0].media.some(
        (m) =>
          route ===
          `/api/media?where[mediaId][equals]=${m.mediaId}&limit=1&depth=0`,
      )
    )
      return;
    if (
      method === "POST" &&
      [
        "/api/editorial/read-draft",
        "/api/editorial/save-draft",
        "/api/editorial/prepare-catalog-delivery",
      ].includes(route) &&
      body?.id === catalogId
    ) {
      if (
        route.endsWith("/save-draft") &&
        (!body.content ||
          digest(body.content) !== manifest.records[0].contentSha256)
      )
        fail("DELIVERY_FROZEN_B_MISMATCH");
      return;
    }
    if (
      method === "POST" &&
      /^\/api\/editorial\/(read-catalog-delivery|request-catalog-release|release-catalog-delivery|cancel-catalog-delivery)$/.test(
        route,
      ) &&
      options.isIntentInScope(body?.intentId) === true
    )
      return;
    fail("PAYLOAD_ISOLATED_ROUTE_REJECTED");
  };
  const client = createBoundedNativeHTTP(
    {
      ...options,
      deadline: Math.min(
        options.deadline,
        Date.parse(binding.expiresAt),
        Date.parse(binding.jwtExpiresAt),
      ),
      assertAdmission: async () => {
        await options.assertAdmission();
        await options.assertBindingActive(binding);
      },
    },
    {
      kind: "payload-isolated",
      maximumRequestBodyBytes: binding.caps.requestBodyPerRequest,
      target: { origin: binding.origin },
      assertRoute: routeGuard,
      authorization: async () => {
        let header;
        try {
          header = await options.authorization({
            origin: binding.origin,
            environmentMarker: binding.environmentMarker,
          });
        } catch {
          fail("PAYLOAD_CREDENTIAL_PROVIDER_UNAVAILABLE");
        }
        if (
          typeof header !== "string" ||
          !/^JWT [A-Za-z0-9_.-]{20,16384}$/.test(header)
        )
          fail("PAYLOAD_CREDENTIAL_PROVIDER_INVALID");
        return header;
      },
    },
  );
  return {
    kind: "payload-isolated",
    send: client.send,
    close: client.close,
    metrics: client.metrics,
    snapshot: client.snapshot,
    verifyPrincipal: async () => {
      const response = await client.send(
        "/api/users/me",
        "GET",
        undefined,
        options.signal,
      );
      if (!response.ok) fail(response.code);
      const user = response.result.user;
      const actual = {
        ...manifest.target,
        actorId: user?.id,
        role: user?.role,
        verified: true,
        scopeCatalogIds:
          user?.role === "owner"
            ? manifest.records.map((r) => r.catalogId)
            : (user?.scopeCatalogIds ?? []),
      };
      verifyPrincipal(manifest, actual);
      principal = actual;
      return clone(actual);
    },
  };
}
