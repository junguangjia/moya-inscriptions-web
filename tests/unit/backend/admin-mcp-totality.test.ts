import {
  ADMIN_OP_NAMES,
  adminRecordTypeSchema,
  type AdminOpName,
} from "@moya/contracts/internal/admin-mcp";
import {
  adminOpMeta,
  built,
  COMMUNITY_READ_FACTS,
  COMMUNITY_READS,
  COMMUNITY_RECORDS,
  COMMUNITY_WRITE_FACTS,
  COMMUNITY_WRITES,
  type AdminMcpSlice,
} from "admin/admin-mcp";
import { describe, expect, it } from "vitest";

import { NOT_BUILT } from "./admin-mcp-not-built.js";

// "Not built yet" and "forgotten" never read the same
// (docs/development/admin-mcp-extending.md). Typecheck holds each table whole over its
// key type; this holds the same at run time, so a table put back to Partial with a row
// left out still fails, and every notBuilt row is tied to NOT_BUILT.

const names = (list: readonly string[]) => [...list].sort();
const sliceOf = (row: object): AdminMcpSlice | undefined =>
  (row as { notBuilt?: AdminMcpSlice }).notBuilt;
const reasonOf = (row: object): string | undefined =>
  (row as { none?: string }).none;

const FACTS = {
  COMMUNITY_READ_FACTS,
  COMMUNITY_WRITE_FACTS,
} as const;
const BY_RECORD_TYPE = {
  COMMUNITY_RECORDS,
  COMMUNITY_READS,
  COMMUNITY_WRITES,
} as const;

const communityRoutes = (reads: boolean) =>
  ADMIN_OP_NAMES.filter(
    (op) =>
      op.startsWith("community.") &&
      (adminOpMeta[op].klass === "read") === reads,
  ).map((op) => op.slice("community.".length));

describe("ops with no body", () => {
  it("are exactly the names NOT_BUILT files under a slice", () => {
    const listed = Object.values(NOT_BUILT).flat();
    expect(names(listed)).toEqual(
      names(ADMIN_OP_NAMES.filter((op) => adminOpMeta[op].run === undefined)),
    );
    expect(new Set(listed).size).toBe(listed.length);
  });

  it("leave no slice listed with nothing in it", () => {
    for (const [slice, ops] of Object.entries(NOT_BUILT))
      expect(ops.length, slice).toBeGreaterThan(0);
  });
});

describe("the community facts tables", () => {
  it("hold every route of a read, and every route of a write, by the op's class", () => {
    expect(names(Object.keys(COMMUNITY_READ_FACTS))).toEqual(
      names(communityRoutes(true)),
    );
    expect(names(Object.keys(COMMUNITY_WRITE_FACTS))).toEqual(
      names(communityRoutes(false)),
    );
  });

  it("give a built op its body, and name the slice of each op without one", () => {
    for (const [table, rows] of Object.entries(FACTS))
      for (const [route, row] of Object.entries(rows)) {
        const op = `community.${route}` as AdminOpName;
        if (built(row) !== undefined) {
          expect(adminOpMeta[op].run, `${table} ${route}`).toBeDefined();
          continue;
        }
        const slice = sliceOf(row);
        expect(slice, `${table} ${route}`).toBeDefined();
        expect(NOT_BUILT[slice!], `${table} ${route}`).toContain(op);
      }
  });
});

describe("the tables admin_get and admin_find read by record type", () => {
  it("hold every record type", () => {
    for (const [table, rows] of Object.entries(BY_RECORD_TYPE))
      expect(names(Object.keys(rows)), table).toEqual(
        names(adminRecordTypeSchema.options),
      );
  });

  it("name only a slice still to come, and give every none a reason in fixed English", () => {
    for (const [table, rows] of Object.entries({ ...FACTS, ...BY_RECORD_TYPE }))
      for (const [key, row] of Object.entries(rows)) {
        const slice = sliceOf(row);
        if (slice !== undefined)
          expect(NOT_BUILT[slice], `${table} ${key}`).toBeDefined();
        const reason = reasonOf(row);
        if (reason !== undefined)
          expect(reason, `${table} ${key}`).toMatch(/^[\x20-\x7e]{1,80}$/u);
      }
  });
});
