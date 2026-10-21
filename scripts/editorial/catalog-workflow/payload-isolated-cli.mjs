#!/usr/bin/env node
import process from "node:process";
import path from "node:path";
import { lstat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { privateJSON } from "../../curation/adapter.mjs";
import {
  editorialDraftSchema,
  editorialContentFromDocument,
  editorialUploadedMediaSchema,
  MEDIA_UPLOAD_CHUNK_BYTES,
} from "../../../packages/contracts/dist/internal/editorial/index.js";
import { digest, fail, validateManifest } from "./identity.mjs";
import {
  frozenCatalogDeliveryBinding,
  normalizePayloadBridgeBinding,
} from "./catalog-delivery-journal.mjs";
import { withPayloadIsolatedSession } from "./payload-isolated-session.mjs";

const exact = (o, keys) =>
  o &&
  Object.getPrototypeOf(o) === Object.prototype &&
  Object.keys(o).length === keys.length &&
  keys.every((k) => Object.hasOwn(o, k));
const select = (o, schema) =>
  schema.parse(
    Object.fromEntries(
      Object.keys(schema.shape)
        .filter((key) => o[key] !== undefined)
        .map((key) => [key, o[key]]),
    ),
  );
export function payloadMainContent(document) {
  const parsed = editorialDraftSchema.safeParse(
    editorialContentFromDocument(document),
  );
  if (!parsed.success) fail("PAYLOAD_MAIN_DTO_INVALID");
  return parsed.data;
}
const absent = async (p) => {
  try {
    await lstat(p);
    return false;
  } catch (e) {
    if (e.code === "ENOENT") return true;
    throw e;
  }
};

/** Only the platform owner's explicitly supplied synthetic fixture window. */
export async function runPayloadIsolatedCommand(args) {
  const opts = {};
  for (let i = 0; i < args.length; i += 2) {
    if (
      !["--ready", "--input", "--checkpoint", "--action", "--report"].includes(
        args[i],
      ) ||
      !args[i + 1] ||
      opts[args[i]]
    )
      fail("PAYLOAD_CLI_ARGUMENTS_INVALID");
    opts[args[i]] = args[i + 1];
  }
  if (
    Object.keys(opts).length !== 5 ||
    !["prepare", "read", "request", "release", "cancel"].includes(
      opts["--action"],
    ) ||
    ["--ready", "--input", "--checkpoint", "--report"].some(
      (k) => !path.isAbsolute(opts[k]),
    )
  )
    fail("PAYLOAD_CLI_ARGUMENTS_INVALID");
  const ready = await privateJSON(opts["--ready"], 65536),
    input = await privateJSON(opts["--input"], 1048576);
  if (
    !exact(input, ["version", "manifest", "nativeDraft"]) ||
    input.version !== 1
  )
    fail("PAYLOAD_CLI_INPUT_INVALID");
  const manifest = validateManifest(input.manifest),
    binding = normalizePayloadBridgeBinding(manifest, ready);
  const directory = path.dirname(opts["--ready"]),
    closedFile = path.join(directory, "closed.json");
  if (
    ready.authFile !== path.join(directory, "application-auth.private.json") ||
    !(await absent(closedFile))
  )
    fail("PAYLOAD_FIXTURE_CLOSED");
  const record = manifest.records[0],
    action = opts["--action"];
  const assertBindingActive = async () => {
    if (!(await absent(closedFile))) fail("PAYLOAD_FIXTURE_CLOSED");
    const live = await privateJSON(opts["--ready"], 65536);
    if (
      digest(normalizePayloadBridgeBinding(manifest, live)) !== digest(binding)
    )
      fail("PAYLOAD_FIXTURE_CHANGED");
  };
  const authorization = async () => {
    // Never returned to the agent or written to any report/journal/error.
    const auth = await privateJSON(ready.authFile, 32768);
    if (
      !exact(auth, [
        "version",
        "environmentMarker",
        "origin",
        "scheme",
        "session",
        "expiresAt",
        "jwtExpiresAt",
      ]) ||
      auth.version !== 1 ||
      auth.environmentMarker !== binding.environmentMarker ||
      auth.origin !== binding.origin ||
      auth.scheme !== "JWT" ||
      auth.expiresAt !== binding.expiresAt ||
      auth.jwtExpiresAt !== binding.jwtExpiresAt
    )
      fail("PAYLOAD_CREDENTIAL_BINDING_CHANGED");
    return `JWT ${auth.session}`;
  };
  const report = await withPayloadIsolatedSession(
    {
      directory: opts["--checkpoint"],
      manifest,
      ready,
      authorization,
      assertBindingActive,
      deadline: Math.min(Date.now() + 120000, Date.parse(binding.expiresAt)),
      timeoutMs: 10000,
      responseByteLimit: 131072,
      limits: {
        maxRequests: 96,
        maxUploadBytes: 4194304,
        maxDownloadBytes: 2097152,
        maxAttempts: 2,
        concurrency: 1,
        chunkBytes: MEDIA_UPLOAD_CHUNK_BYTES,
      },
    },
    async ({ transport, principal, openDelivery, observeMainStatus }) => {
      const request = async (route, method = "GET", body) => {
        const response = await transport.send(route, method, body);
        if (!response.ok) fail(response.code);
        return response.result;
      };
      const inspectRecord = async () => {
        const result = await request("/api/editorial/read-draft", "POST", {
          id: binding.fixtureCatalogDocumentId,
        });
        const rawMain = await request(
          `/api/catalogs/${binding.fixtureCatalogDocumentId}?depth=0&draft=false`,
        );
        const draft = {
          id: result.result?.id,
          revision: result.result?.revision,
          fingerprint: result.result?.fingerprint,
          content: editorialDraftSchema.parse(result.result?.content),
        };
        if (
          result.ok !== true ||
          draft.id !== binding.fixtureCatalogDocumentId ||
          rawMain.id !== draft.id ||
          !["draft", "published"].includes(rawMain._status)
        )
          fail("PAYLOAD_NATIVE_IDENTITY_MISMATCH");
        const observed = await observeMainStatus(rawMain._status);
        return {
          draft,
          main: {
            id: rawMain.id,
            revision: rawMain.revision,
            status: rawMain._status,
            content: payloadMainContent(rawMain),
          },
          protections: {
            ...record.protections,
            withdrawn: record.protections.withdrawn || observed.withdrawn,
          },
        };
      };
      const current = await inspectRecord();
      if (digest(current.draft.content) !== record.contentSha256)
        fail("DELIVERY_FROZEN_B_MISMATCH");
      const proofs = [];
      for (const asset of record.media) {
        const result = await request(
          `/api/media?where[mediaId][equals]=${asset.mediaId}&limit=1&depth=0`,
        );
        if (
          !Array.isArray(result.docs) ||
          result.docs.length !== 1 ||
          result.totalDocs !== 1
        )
          fail("NATIVE_MEDIA_IDENTITY_MISMATCH");
        proofs.push({
          media: select(result.docs[0], editorialUploadedMediaSchema),
          sourceSha256: asset.sourceSha256,
          uploadedSha256: asset.uploadedSha256,
        });
      }
      const frozen = [
        frozenCatalogDeliveryBinding(record, input.nativeDraft, proofs),
      ];
      const client = await openDelivery(frozen, inspectRecord),
        state = client.snapshot();
      const original = state.actions[`${record.recordId}:${action}`];
      const latest = [
        ...Object.values(state.actions).map((a) => a.result),
        ...state.observations.map((o) => o.result),
      ]
        .filter(Boolean)
        .sort((a, b) => b.stateVersion - a.stateVersion)[0];
      let body;
      if (original) {
        body = JSON.parse(original.bodyText);
        delete body.idempotencyKey;
      } else if (action === "prepare")
        body = {
          id: frozen[0].id,
          expectedRevision: frozen[0].revision,
          expectedFingerprint: frozen[0].fingerprint,
        };
      else {
        if (!latest) fail("DELIVERY_PREPARE_REQUIRED");
        body = {
          intentId: latest.intentId,
          ...(action === "read"
            ? {}
            : { expectedStateVersion: latest.stateVersion }),
          ...(action === "request"
            ? { expectedManifestSha256: frozen[0].manifestSha256 }
            : {}),
          ...(action === "release"
            ? {
                expectedRevision: frozen[0].revision,
                expectedFingerprint: frozen[0].fingerprint,
              }
            : {}),
        };
      }
      const outcome = await client.execute(record.recordId, action, body);
      return {
        version: 1,
        executionKind: "payload-isolated-protocol-http",
        payloadImplementationAcceptance: "REQUIRES_PLATFORM_EVIDENCE",
        action,
        target: {
          origin: binding.origin,
          environmentMarker: binding.environmentMarker,
          actorId: principal.actorId,
          role: principal.role,
          catalogDocumentId: frozen[0].id,
          catalogId: record.catalogId,
        },
        frozenRevision: frozen[0].revision,
        mediaMetadataVerified: proofs.length,
        outcome,
        transport: transport.metrics(),
        credentialMaterialIncluded: false,
        originalImageBytesTransferred: 0,
        productionRequests: 0,
        anonymousDeliveryVerified: false,
      };
    },
  );
  await writeFile(opts["--report"], JSON.stringify(report, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  return report;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (process.argv.includes("--help"))
    process.stdout.write(
      "Synthetic Payload window only: --ready ABS --input ABS --checkpoint ABS --action prepare|read|request|release|cancel --report ABS\n",
    );
  else
    runPayloadIsolatedCommand(process.argv.slice(2)).then(
      (r) =>
        process.stdout.write(
          JSON.stringify({
            action: r.action,
            status: r.outcome.status,
            requests: r.transport.requests,
            binaryBodyBytes: r.transport.binaryBodyBytes,
          }) + "\n",
        ),
      (e) => {
        process.stderr.write(
          JSON.stringify({
            code: /^[A-Z0-9_]{1,100}$/.test(e.code ?? "")
              ? e.code
              : "PAYLOAD_ISOLATED_COMMAND_FAILED",
          }) + "\n",
        );
        process.exitCode = 1;
      },
    );
}
