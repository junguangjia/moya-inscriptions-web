import type { PublicUserRecord, PublicUserStatus } from "@moya/api";
import type { QueryResultRow } from "pg";

export interface PublicUserRow extends QueryResultRow {
  readonly id: unknown;
  readonly handle: unknown;
  readonly display_name: unknown;
  readonly studio_name?: unknown;
  readonly status: unknown;
}

const publicUserIdPattern = /^user-[0-9a-f]{32}$/;
const handlePattern = /^[a-z][a-z0-9-]{2,31}$/;
const statuses: readonly PublicUserStatus[] = ["active", "suspended"];

const isStatus = (value: unknown): value is PublicUserStatus =>
  typeof value === "string" &&
  statuses.some((candidate) => candidate === value);

/** Fails closed on any row the schema constraints should have made impossible. */
export const mapPublicUserRow = (row: PublicUserRow): PublicUserRecord => {
  if (
    typeof row.id !== "string" ||
    !publicUserIdPattern.test(row.id) ||
    typeof row.handle !== "string" ||
    !handlePattern.test(row.handle) ||
    typeof row.display_name !== "string" ||
    row.display_name.trim() !== row.display_name ||
    row.display_name.length === 0 ||
    row.display_name.length > 40 ||
    (row.studio_name !== undefined &&
      (typeof row.studio_name !== "string" ||
        row.studio_name.trim() !== row.studio_name ||
        [...row.studio_name].length > 7 ||
        row.studio_name.includes("\u0000") ||
        /[\uD800-\uDFFF]/u.test(row.studio_name))) ||
    !isStatus(row.status)
  ) {
    throw new Error("Invalid PostgreSQL public user row");
  }
  return {
    id: row.id as PublicUserRecord["id"],
    handle: row.handle,
    displayName: row.display_name,
    ...(typeof row.studio_name === "string"
      ? { studioName: row.studio_name }
      : {}),
    status: row.status,
  };
};
