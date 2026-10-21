import assert from "node:assert/strict";
import test from "node:test";
import {
  editorialDraftSchema,
  EDITORIAL_STATEFUL_FIELDS,
  catalogFilterMetadataSchema,
} from "../../../packages/contracts/dist/internal/editorial/index.js";
import { fixture, hash } from "./test-fixtures.mjs";
import { digest } from "./identity.mjs";
import { payloadMainContent } from "./payload-isolated-cli.mjs";
import { frozenCatalogDeliveryBinding } from "./catalog-delivery-journal.mjs";
const { structuredClone } = globalThis;

function sample() {
  const manifest = fixture(),
    record = manifest.records[0],
    asset = record.media[0];
  const content = editorialDraftSchema.parse({
    catalogId: record.catalogId,
    sourceId: record.sourceId,
    kind: "inscription",
    title: "Synthetic B",
    summary: "Synthetic",
    ...Object.fromEntries(
      EDITORIAL_STATEFUL_FIELDS.map((k) => [k, { state: "UNSUPPLIED" }]),
    ),
    sourceCitations: [
      { label: "Synthetic archive", citation: "Synthetic reference" },
    ],
    media: [
      {
        mediaId: asset.mediaId,
        objectKey: "editorial/synthetic.png",
        width: asset.width,
        height: asset.height,
        alt: "Synthetic",
        position: 0,
        isRepresentative: true,
      },
    ],
  });
  record.contentSha256 = digest(content);
  const raw = {
    ...structuredClone(content),
    id: 10,
    revision: 2,
    _status: "published",
    periodLabel: null,
    ownerNote: null,
    ...Object.fromEntries(
      EDITORIAL_STATEFUL_FIELDS.map((k) => [k, { ...content[k], value: null }]),
    ),
    media: content.media.map((m) => ({ ...m, id: "native-media-row" })),
    sourceCitations: content.sourceCitations.map((c) => ({
      ...c,
      id: "native-citation-row",
      appliesTo: [],
    })),
    filterMetadata: catalogFilterMetadataSchema.parse({}),
  };
  const proof = {
    media: {
      ...content.media[0],
      catalogId: record.catalogId,
      sha256: asset.uploadedSha256,
      filesize: asset.bytes,
    },
    sourceSha256: asset.sourceSha256,
    uploadedSha256: asset.uploadedSha256,
  };
  const bind = (c) =>
    frozenCatalogDeliveryBinding(
      record,
      { id: 10, revision: 2, fingerprint: hash("d"), content: c },
      [proof],
    );
  return { content, raw, bind };
}

test("Native main storage controls normalize through the owning adapter without changing canonical B", () => {
  const { content, raw, bind } = sample(),
    before = structuredClone(raw),
    parsed = payloadMainContent(raw);
  assert.deepEqual(parsed, content);
  assert.equal(digest(parsed), digest(content));
  assert.deepEqual(raw, before);
  assert.deepEqual(bind(parsed), bind(content));
  assert.deepEqual(
    parsed.media.map((m) => [m.mediaId, m.position, m.isRepresentative]),
    content.media.map((m) => [m.mediaId, m.position, m.isRepresentative]),
  );
});

test("normalization never erases real content, state, scope or image changes from the frozen B gate", () => {
  for (const change of [
    (r) => {
      r.title = "Different real content";
    },
    (r) => {
      r.title = null;
    },
    (r) => {
      r.dynasty = { state: "UNKNOWN" };
    },
    (r) => {
      r.filterMetadata.dynasty = { state: "UNKNOWN", tokens: "" };
    },
    (r) => {
      r.sourceCitations[0].citation = "Different reference";
    },
    (r) => {
      r.sourceId = "source-other";
    },
    (r) => {
      r.media[0].objectKey = "editorial/other.png";
    },
  ]) {
    const { raw, bind } = sample();
    change(raw);
    assert.throws(() => bind(payloadMainContent(raw)), {
      code: "DELIVERY_FROZEN_B_MISMATCH",
    });
  }
});

test("invalid Native content retains a fixed safe error and strict validation", () => {
  for (const change of [
    (r) => {
      r.title = 123;
    },
    (r) => {
      r.dynasty = { state: "VALUE" };
    },
    (r) => {
      r.media[0].width = 0;
    },
  ]) {
    const { raw } = sample();
    change(raw);
    assert.throws(() => payloadMainContent(raw), {
      code: "PAYLOAD_MAIN_DTO_INVALID",
    });
  }
});
