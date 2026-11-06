import { createHash } from "node:crypto";

import {
  ADMIN_OP_NAMES,
  ADMIN_RUN_FORMAT_VERSION,
  canonicalJson,
} from "@moya/contracts/internal/admin-mcp";
import {
  adminOpMeta,
  fingerprintOf,
  opFactsHashOf,
  opSchemaHash,
  requestKeyFor,
  RUN_CREDENTIAL,
  runCredentialOf,
  runTargetKey,
  sealHasher,
} from "admin/admin-mcp";
import { describe, expect, it } from "vitest";

/**
 * The run's durable formats (admin-mcp-completion-v1 S8, plan 2.9). A stored run
 * outlives a release, so each derivation is pinned by a vector worked out by hand
 * from its definition: a change here is a new version, never an edit.
 */

const RUN = "00000000-0000-4000-8000-000000000001";
const sha256 = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");

describe("a run target's key", () => {
  it("is fixed by the run and the index, in its own versioned domain", () => {
    expect(runTargetKey(RUN, 0)).toBe("bc1923aa-391a-4cc1-81b6-edcddad472ec");
    expect(runTargetKey(RUN, 7)).toBe("e42c232f-485e-4a20-840b-effed48bd24e");
    expect(runTargetKey(RUN, 0)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
  });

  it("never meets a key admin_execute derives from the same strings", () => {
    expect(requestKeyFor(RUN, 0)).toBe("b6d102cd-4224-4a25-8b3a-8b538e1df549");
    expect(runTargetKey(RUN, 0)).not.toBe(requestKeyFor(RUN, 0));
    expect(runTargetKey(RUN, 0)).not.toBe(
      requestKeyFor("run-target/v1", 0, RUN),
    );
  });
});

describe("a run's credential", () => {
  it("is a key by its row id or a connection by its own id, never the users row", () => {
    expect(runCredentialOf({ id: 7 })).toEqual({
      credential: "key:7",
      keyId: 7,
    });
    const connection = {
      id: "conn-0123456789abcdef",
      authorizedById: 1,
      authorizedByEmail: "owner@example.invalid",
    };
    expect(runCredentialOf({ id: connection.id, connection })).toEqual({
      credential: "conn:conn-0123456789abcdef",
      connectionId: "conn-0123456789abcdef",
    });
  });

  it("refuses what mcp_runs would refuse", () => {
    for (const key of [
      { id: 0 },
      { id: -1 },
      { id: 1.5 },
      { id: "conn-only-a-string" },
      {
        id: "x",
        connection: {
          id: "has space",
          authorizedById: 1,
          authorizedByEmail: "",
        },
      },
      {
        id: "x",
        connection: {
          id: "c".repeat(81),
          authorizedById: 1,
          authorizedByEmail: "",
        },
      },
    ])
      expect(() => runCredentialOf(key), JSON.stringify(key.id)).toThrow(
        "RUN_CREDENTIAL_INVALID",
      );
    expect(RUN_CREDENTIAL.test("key:07")).toBe(false);
  });
});

describe("a fingerprint", () => {
  it("is f1: sha256 of the format and the canonical JSON", () => {
    expect(fingerprintOf({ b: 1, a: "x" })).toBe(
      "bf15c5dd8f73e6bee53773495ab49abfc98f4392ec62729f8c082d18a956a1ec",
    );
    expect(fingerprintOf({ a: "x", b: 1 })).toBe(
      fingerprintOf({ b: 1, a: "x" }),
    );
    expect(fingerprintOf({ a: "x", b: 1 })).toBe(
      sha256(`f1:${canonicalJson({ a: "x", b: 1 })}`),
    );
  });
});

describe("a seal", () => {
  const header = {
    format: ADMIN_RUN_FORMAT_VERSION,
    op: "community.delete-body",
    klass: "irreversible" as const,
    commonInput: { reason: "Synthetic reason" },
  };
  const targets = [
    { refKey: "comment:1", frozenInput: { id: "comment-1" }, stamp: "r3" },
    { refKey: "comment:2", frozenInput: null, stamp: "none" },
  ];
  const sealOf = (rows: typeof targets, over = {}) => {
    const seal = sealHasher({ ...header, ...over });
    for (const row of rows) seal.add(row);
    return seal.digest();
  };

  it("is pinned, and is the hash of the whole in canonical JSON", () => {
    expect(sealOf(targets)).toBe(
      "03fb0146259914dd82659b1b78a5d97bfd4d62d1b3f859f4db9b53ac3d3e262c",
    );
    expect(sealOf(targets)).toBe(
      sha256(
        canonicalJson({
          format: header.format,
          op: header.op,
          class: header.klass,
          common: fingerprintOf(header.commonInput),
          targets: targets.map(({ refKey, frozenInput, stamp }) => [
            refKey,
            fingerprintOf(frozenInput),
            stamp,
          ]),
        }),
      ),
    );
    expect(sealOf([])).toBe(
      sha256(
        canonicalJson({
          class: header.klass,
          common: fingerprintOf(header.commonInput),
          format: header.format,
          op: header.op,
          targets: [],
        }),
      ),
    );
  });

  it("moves with any part of what will run", () => {
    const sealed = sealOf(targets);
    for (const changed of [
      sealOf([...targets].reverse()),
      sealOf(targets.slice(0, 1)),
      sealOf([{ ...targets[0]!, stamp: "r4" }, targets[1]!]),
      sealOf([
        { ...targets[0]!, frozenInput: { id: "comment-9" } },
        targets[1]!,
      ]),
      sealOf([{ ...targets[0]!, refKey: "comment:9" }, targets[1]!]),
      sealOf(targets, { klass: "reversible" }),
      sealOf(targets, { op: "community.remove-thread" }),
      sealOf(targets, { format: ADMIN_RUN_FORMAT_VERSION + 1 }),
      sealOf(targets, { commonInput: { reason: "Another reason" } }),
    ])
      expect(changed).not.toBe(sealed);
  });
});

describe("an op's schema hash", () => {
  it("is built for every op, once a process, and differs between ops", () => {
    const hashes = new Map<string, string>();
    for (const op of ADMIN_OP_NAMES) {
      const hash = opSchemaHash(op);
      expect(hash, op).toMatch(/^[0-9a-f]{64}$/u);
      expect(opSchemaHash(op), op).toBe(hash);
      hashes.set(op, hash!);
    }
    expect(opSchemaHash("community.not-an-op")).toBeUndefined();
    expect(hashes.get("editorial.save-draft")).not.toBe(
      hashes.get("editorial.save-article-draft"),
    );
  });

  it("moves with the input schema, the class, the recovery, the completion and the tool", () => {
    const entry = adminOpMeta["editorial.save-draft"];
    const base = opFactsHashOf(entry);
    expect(opFactsHashOf({ ...entry })).toBe(base);
    const withoutInput = Object.fromEntries(
      Object.entries(entry).filter(([name]) => name !== "input"),
    ) as typeof entry;
    for (const [name, changed] of [
      [
        "input",
        { ...entry, input: adminOpMeta["editorial.save-article-draft"].input! },
      ],
      ["no input", withoutInput],
      ["class", { ...entry, klass: "irreversible" as const }],
      ["recovery", { ...entry, recovery: "cas_read_back" as const }],
      ["completion", { ...entry, completion: { kind: "async" as const } }],
      ["tool", { ...entry, tool: "admin_execute_irreversible" as const }],
    ] as const)
      expect(opFactsHashOf(changed), name).not.toBe(base);
  });
});
