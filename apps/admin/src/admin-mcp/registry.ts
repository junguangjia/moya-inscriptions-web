import { ADMIN_OP_NAMES } from "@moya/contracts/internal/admin-mcp";
import type {
  AdminMcpSensitiveCategory,
  AdminOpClass,
  AdminOpName,
  AdminOpTool,
} from "@moya/contracts/internal/admin-mcp";

import { aiCredentialConfigured } from "../community/backend";
import { cmsOps } from "./ops/cms";
import { communityOps } from "./ops/community";
import type { AdminOpEntry } from "./ops/define";
import { editorialOps } from "./ops/editorial";
import { listOps } from "./ops/list";
import { otherOps, scriptOps } from "./ops/scripts";

export type { AdminOpContext, AdminOpEntry } from "./ops/define";

/**
 * Every op, classified (admin-mcp-completion-v1 section 5). A name in the contract
 * with no row, or a row with no name, fails typecheck;
 * tests/unit/backend/admin-mcp-registry.test.ts walks the real routes, collections,
 * views and script commands for the ones this type cannot see.
 */
export const adminOpMeta = {
  ...communityOps,
  ...editorialOps,
  ...listOps,
  ...cmsOps,
  ...scriptOps,
  ...otherOps,
} satisfies Readonly<Record<AdminOpName, AdminOpEntry>>;

export const isAdminOpName = (name: string): name is AdminOpName =>
  Object.hasOwn(adminOpMeta, name);

/**
 * The law: class decides the tool, so a tool's annotations are always true and no
 * tool mixes read and write. A sensitive read has its own read tool.
 */
const toolOfClass: Readonly<Record<AdminOpClass, AdminOpTool>> = {
  read: "admin_read",
  reversible: "admin_execute",
  irreversible: "admin_execute_irreversible",
};

export const toolForOp = ({
  klass,
  sensitive,
}: Pick<AdminOpEntry, "klass" | "sensitive">): AdminOpTool =>
  klass === "read" && sensitive !== undefined
    ? "admin_sensitive_read"
    : toolOfClass[klass];

/** Ops breaking the law, for the registry test and any table a slice composes. */
export const classToolViolations = (
  table: Readonly<Record<string, AdminOpEntry>> = adminOpMeta,
): readonly string[] =>
  Object.entries(table)
    .filter(([, entry]) => entry.tool !== toolForOp(entry))
    .map(([name]) => name);

/** An op's tool decides what a tool can run, in contract order. */
export const opsOnTool = (tool: AdminOpTool): readonly AdminOpName[] =>
  ADMIN_OP_NAMES.filter((name) => adminOpMeta[name].tool === tool);

const distance = (from: string, to: string): number => {
  let previous = Array.from({ length: to.length + 1 }, (_, index) => index);
  for (let row = 1; row <= from.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= to.length; column += 1)
      current[column] = Math.min(
        previous[column]! + 1,
        current[column - 1]! + 1,
        previous[column - 1]! + (from[row - 1] === to[column - 1] ? 0 : 1),
      );
    previous = current;
  }
  return previous[to.length]!;
};

/** Registry names only, so an answer naming them never echoes the caller's text. */
export const nearestOps = (name: string, count = 3): readonly AdminOpName[] =>
  ADMIN_OP_NAMES.map((candidate) => ({
    candidate,
    score: distance(name.slice(0, 64), candidate),
  }))
    .sort((a, b) => a.score - b.score || a.candidate.localeCompare(b.candidate))
    .slice(0, count)
    .map(({ candidate }) => candidate);

/** Not available yet, by code. Absent reads as callable now. */
export const opUnavailable = (
  entry: Pick<AdminOpEntry, "credential" | "run" | "sensitive">,
  switches: Readonly<Partial<Record<AdminMcpSensitiveCategory, boolean>>>,
):
  | "not_available"
  | "SENSITIVE_SWITCH_OFF"
  | "AI_CREDENTIAL_NOT_CONFIGURED"
  | undefined => {
  if (entry.run === undefined) return "not_available";
  if (entry.sensitive !== undefined && switches[entry.sensitive] !== true)
    return "SENSITIVE_SWITCH_OFF";
  if (entry.credential !== "none" && !aiCredentialConfigured(entry.credential))
    return "AI_CREDENTIAL_NOT_CONFIGURED";
  return undefined;
};
