import { createHash, type Hash } from "node:crypto";

import {
  canonicalJson,
  fingerprintTextOf,
} from "@moya/contracts/internal/admin-mcp";
import type { AdminOpClass } from "@moya/contracts/internal/admin-mcp";
import { z } from "zod";

import { adminOpMeta, isAdminOpName } from "../registry";
import type { AdminOpEntry } from "../registry";

/**
 * The hashes a run is frozen and checked by (S8 plan 2.9). Each is a durable format a
 * stored run carries across releases, pinned by fixed vectors in the tests.
 */

export const sha256Hex = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");

/** f1: a requestId's payload and a chunk's are compared by this, as are frozen inputs. */
export const fingerprintOf = (value: unknown) =>
  sha256Hex(fingerprintTextOf(value));

/**
 * What a frozen input is checked against: the op's input JSON Schema, class, recovery,
 * completion and tool. Anything that changes how a stored input runs changes this, so
 * the run answers PREVIEW_STALE instead of running old input under a new schema.
 */
export const opFactsHashOf = ({
  input,
  klass,
  recovery,
  completion,
  tool,
}: Pick<
  AdminOpEntry,
  "input" | "klass" | "recovery" | "completion" | "tool"
>) =>
  sha256Hex(
    canonicalJson({
      input:
        input === undefined
          ? null
          : z.toJSONSchema(input, {
              target: "draft-2020-12",
              io: "input",
              unrepresentable: "any",
            }),
      klass,
      recovery,
      completion: completion.kind,
      tool,
    }),
  );

const opSchemaHashes = new Map<string, string>();

/** Once per process per op, as the tool list is built. A name no op holds has none. */
export const opSchemaHash = (op: string): string | undefined => {
  if (!isAdminOpName(op)) return undefined;
  const known = opSchemaHashes.get(op);
  if (known !== undefined) return known;
  const hash = opFactsHashOf(adminOpMeta[op]);
  opSchemaHashes.set(op, hash);
  return hash;
};

export interface SealHeader {
  readonly format: number;
  readonly op: string;
  readonly klass: AdminOpClass;
  readonly commonInput: unknown;
}

export interface SealedTarget {
  readonly refKey: string;
  readonly frozenInput: unknown;
  readonly stamp: string | null;
}

/**
 * The seal: sha256 of canonical `{class, common, format, op, targets}`, each target
 * `[refKey, f1 of its frozen input, stamp]` in index order. Written as it streams, so a
 * run of any size seals without holding its targets; the keys above are already in
 * canonical order, which the tests check against canonicalJson of the whole.
 */
export const sealHasher = ({ format, op, klass, commonInput }: SealHeader) => {
  const hash: Hash = createHash("sha256");
  hash.update(
    `{"class":${canonicalJson(klass)},"common":${canonicalJson(fingerprintOf(commonInput ?? null))},"format":${canonicalJson(format)},"op":${canonicalJson(op)},"targets":[`,
    "utf8",
  );
  let first = true;
  return {
    add: ({ refKey, frozenInput, stamp }: SealedTarget) => {
      hash.update(
        `${first ? "" : ","}${canonicalJson([refKey, fingerprintOf(frozenInput ?? null), stamp])}`,
        "utf8",
      );
      first = false;
    },
    digest: () => hash.update("]}", "utf8").digest("hex"),
  };
};
