import path from "node:path";
import { MEDIA_UPLOAD_CHUNK_BYTES } from "../../../packages/contracts/dist/internal/editorial/index.js";
import { privateJSON } from "../../curation/adapter.mjs";
import { withLocalHTTPCheckpointStore } from "./checkpoint-store.mjs";
import {
  createPayloadIsolatedNativeHTTP,
  nativeRouteClass,
} from "./local-native-http.mjs";
import {
  createTransferBudget,
  openTransferBudget,
} from "./transfer-budget.mjs";
import { digest, fail, targetIdentity } from "./identity.mjs";
import { normalizeProductionAuthority } from "./production-authority.mjs";
import {
  createCatalogDeliveryClient,
  normalizePayloadBridgeBinding,
  openCatalogDeliveryJournal,
} from "./catalog-delivery-journal.mjs";

const clone = (o) => JSON.parse(JSON.stringify(o));
const sha = (s) => typeof s === "string" && /^[a-f0-9]{64}$/.test(s);
const integer = (n) => Number.isSafeInteger(n) && n >= 0;
const exact = (o, keys) =>
  o &&
  Object.getPrototypeOf(o) === Object.prototype &&
  Object.keys(o).length === keys.length &&
  keys.every((k) => Object.hasOwn(o, k));
const configured = {
  maxAttempts: 2,
  concurrency: 4,
  chunkBytes: MEDIA_UPLOAD_CHUNK_BYTES,
};
async function maybeJSON(file) {
  try {
    return await privateJSON(file, 8 * 1024 * 1024);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    return null;
  }
}

export function openPayloadTransportJournal(options) {
  return openBoundTransportJournal(options, "payload-isolated", "local-http");
}

export function openProductionTransportJournal(options) {
  const binding = normalizeProductionAuthority(
    options.manifest,
    options.binding,
  );
  if (digest(binding) !== digest(options.binding))
    fail("PRODUCTION_TRANSPORT_INVALID");
  return openBoundTransportJournal(
    options,
    "production-native",
    "native-https",
  );
}

function openBoundTransportJournal(
  { manifest, binding, limits, responseByteLimit, saved = null },
  transportKind,
  executionKind,
) {
  const scopeSha256 = digest({
    transportKind,
    manifest,
    binding,
    limits,
    responseByteLimit,
  });
  const expected = {
    version: 1,
    executionKind,
    transportKind,
    scopeSha256,
    bindingSha256: digest(binding),
    responseByteLimit,
    budget: createTransferBudget(
      scopeSha256,
      limits,
      configured,
      executionKind,
    ),
    requests: [],
    publishedObserved: false,
    withdrawnObserved: manifest.records[0].protections.withdrawn,
  };
  if (
    !integer(responseByteLimit) ||
    responseByteLimit < 1 ||
    responseByteLimit > 1048576 ||
    limits.maxRequests > binding.caps.requests ||
    limits.maxUploadBytes > binding.caps.acceptedRequestBodyTotal ||
    limits.maxDownloadBytes > binding.caps.responseBodyTotal
  )
    fail("PAYLOAD_TRANSPORT_LIMITS_INVALID");
  if (!saved) return expected;
  if (
    !exact(saved, Object.keys(expected)) ||
    Object.keys(expected)
      .filter(
        (k) =>
          ![
            "budget",
            "requests",
            "publishedObserved",
            "withdrawnObserved",
          ].includes(k),
      )
      .some((k) => saved[k] !== expected[k]) ||
    typeof saved.publishedObserved !== "boolean" ||
    typeof saved.withdrawnObserved !== "boolean" ||
    (expected.withdrawnObserved && !saved.withdrawnObserved) ||
    !Array.isArray(saved.requests) ||
    saved.requests.length !== saved.budget.requests.length
  )
    fail("PAYLOAD_TRANSPORT_JOURNAL_INVALID");
  const result = clone(saved);
  result.budget = openTransferBudget(
    result.budget,
    scopeSha256,
    limits,
    configured,
    executionKind,
  );
  for (const [index, row] of result.requests.entries()) {
    const budget = result.budget.requests[index];
    if (
      !exact(row, [
        "sequence",
        "logicalKey",
        "logicalAttempt",
        "requestSha256",
        "route",
        "routeClass",
        "method",
        "status",
        "httpStatus",
        "requestBodyBytes",
        "responseBodyBytes",
        "binaryBodyBytes",
        "responseSha256",
        "receipt",
        "drained",
      ]) ||
      row.sequence !== index + 1 ||
      !sha(row.logicalKey) ||
      !integer(row.logicalAttempt) ||
      row.logicalAttempt < 1 ||
      row.requestSha256 !== budget.requestSha256 ||
      row.requestSha256 !==
        digest({
          logicalKey: row.logicalKey,
          sequence: row.sequence,
          logicalAttempt: row.logicalAttempt,
        }) ||
      row.routeClass !== nativeRouteClass(row.route, row.method) ||
      (transportKind === "payload-isolated"
        ? [
            "fixture-handshake",
            "save-receipt",
            "upload-control",
            "upload-binary",
          ]
        : ["fixture-handshake"]
      ).includes(row.routeClass) ||
      !["PENDING", "UNKNOWN", "COMPLETE"].includes(row.status) ||
      typeof row.drained !== "boolean" ||
      ![row.requestBodyBytes, row.responseBodyBytes, row.binaryBodyBytes].every(
        integer,
      ) ||
      (transportKind === "payload-isolated" && row.binaryBodyBytes !== 0) ||
      row.binaryBodyBytes > row.requestBodyBytes ||
      (row.responseSha256 !== null && !sha(row.responseSha256)) ||
      (row.httpStatus !== null &&
        (!integer(row.httpStatus) ||
          row.httpStatus < 100 ||
          row.httpStatus > 599))
    )
      fail("PAYLOAD_TRANSPORT_JOURNAL_INVALID");
    if (row.receipt !== null) {
      const r = row.receipt;
      if (
        !exact(r, [
          "version",
          "executionKind",
          "scopeSha256",
          "targetIdentitySha256",
          "requestSha256",
          "route",
          "method",
          "httpStatus",
          "transportStatus",
          "responseSha256",
          "resultSha256",
          "metadataSha256",
          ...(transportKind === "production-native" ? ["observedAt"] : []),
        ]) ||
        r.version !== 1 ||
        r.executionKind !== executionKind ||
        r.scopeSha256 !== scopeSha256 ||
        r.targetIdentitySha256 !== targetIdentity(manifest) ||
        r.requestSha256 !== row.requestSha256 ||
        r.route !== row.route ||
        r.method !== row.method ||
        r.httpStatus !== row.httpStatus ||
        r.transportStatus !== row.status ||
        r.responseSha256 !== row.responseSha256 ||
        !sha(r.resultSha256) ||
        (r.metadataSha256 !== null && !sha(r.metadataSha256)) ||
        (transportKind === "production-native" &&
          !Number.isFinite(Date.parse(r.observedAt)))
      )
        fail("PAYLOAD_TRANSPORT_JOURNAL_INVALID");
    }
    if (
      row.status === "COMPLETE" &&
      (!row.receipt ||
        !row.drained ||
        budget.status !== "COMPLETE" ||
        budget.actualUploadBytes !== row.requestBodyBytes ||
        budget.actualDownloadBytes !== row.responseBodyBytes ||
        budget.evidenceSha256 !==
          digest({
            requestSha256: row.requestSha256,
            status: row.httpStatus,
            responseSha256: row.responseSha256,
          }))
    )
      fail("PAYLOAD_TRANSPORT_JOURNAL_INVALID");
  }
  return result;
}

/** Offline code only until the platform provides a real, live ready binding.
 * Authentication stays in the caller's controlled provider, never in journals.
 */
export async function withPayloadIsolatedSession(options, work) {
  const manifest = clone(options.manifest),
    binding = normalizePayloadBridgeBinding(manifest, options.ready);
  return withLocalHTTPCheckpointStore(
    options.directory,
    manifest,
    async ({ inputMatches, assertOwned, persistCompanion }) => {
      if (!inputMatches) fail("CHECKPOINT_INPUT_CHANGED");
      const journal = openPayloadTransportJournal({
        manifest,
        binding,
        limits: options.limits,
        responseByteLimit: options.responseByteLimit,
        saved: await maybeJSON(
          path.join(options.directory, "payload-native-journal.json"),
        ),
      });
      const deliverySaved = await maybeJSON(
        path.join(options.directory, "catalog-delivery-journal.json"),
      );
      let deliveryJournal = null,
        deliveryClient = null,
        pending = Promise.resolve();
      const persist = (name, value) => {
        const snapshot = clone(value);
        pending = pending.then(async () => {
          await assertOwned();
          await persistCompanion(name, snapshot);
        });
        return pending;
      };
      await persist("payload-native-journal.json", journal);
      const validateTransportReceipt = async (receipt, request) => {
        const rows = journal.requests.filter(
            (r) => r.requestSha256 === receipt?.requestSha256,
          ),
          row = rows[0];
        if (
          rows.length !== 1 ||
          !row.receipt ||
          row.status !== "COMPLETE" ||
          !row.drained ||
          row.httpStatus !== 200 ||
          digest(row.receipt) !== digest(receipt) ||
          row.route !== request.route ||
          row.method !== request.method ||
          row.logicalKey !==
            digest({
              scope: journal.scopeSha256,
              route: request.route,
              method: request.method,
              bodySha256: request.bodySha256,
            }) ||
          receipt.resultSha256 !== request.resultSha256
        )
          fail("PAYLOAD_DELIVERY_RECEIPT_MISMATCH");
      };
      const transport = createPayloadIsolatedNativeHTTP({
        ...options,
        manifest,
        binding,
        journal,
        persist: () => persist("payload-native-journal.json", journal),
        assertAdmission: assertOwned,
        isIntentInScope: (intentId) =>
          typeof intentId === "string" &&
          Object.values(deliveryJournal?.actions ?? {}).some(
            (a) => a.result?.intentId === intentId,
          ),
      });
      try {
        const principal = await transport.verifyPrincipal();
        return await work({
          transport,
          binding,
          principal,
          async observeMainStatus(status) {
            if (!["published", "draft"].includes(status))
              fail("PAYLOAD_NATIVE_IDENTITY_MISMATCH");
            if (status === "draft" && journal.publishedObserved)
              journal.withdrawnObserved = true;
            if (status === "published") journal.publishedObserved = true;
            await persist("payload-native-journal.json", journal);
            return { withdrawn: journal.withdrawnObserved };
          },
          async openDelivery(frozen, inspectRecord) {
            if (deliveryClient) fail("DELIVERY_CLIENT_ALREADY_OPEN");
            deliveryJournal = openCatalogDeliveryJournal({
              manifest,
              binding,
              frozen,
              saved: deliverySaved,
            });
            for (const action of Object.values(deliveryJournal.actions))
              for (const attempt of action.attempts)
                if (attempt.status === "CONFIRMED")
                  await validateTransportReceipt(attempt.nativeReceipt, {
                    route: action.route,
                    method: action.method,
                    bodySha256: action.bodySha256,
                    resultSha256: attempt.resultSha256,
                  });
            await persist("catalog-delivery-journal.json", deliveryJournal);
            deliveryClient = createCatalogDeliveryClient({
              manifest,
              binding,
              frozen,
              journal: deliveryJournal,
              persist: (snapshot) =>
                persist("catalog-delivery-journal.json", snapshot),
              assertAdmission: assertOwned,
              send: transport.send,
              inspectRecord,
              verifyAccount: async () => principal,
              validateTransportReceipt,
              deadline: options.deadline,
              signal: options.signal,
            });
            return deliveryClient;
          },
        });
      } finally {
        try {
          await deliveryClient?.close();
        } finally {
          await transport.close();
          await pending;
        }
      }
    },
  );
}
