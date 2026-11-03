import {
  ADMIN_MCP_COMPLIANCE_PHRASES,
  ADMIN_MCP_DEFAULT_THRESHOLD,
  ADMIN_MCP_SENSITIVE_CATEGORIES,
} from "@moya/contracts/internal/admin-mcp";
import type { AdminMcpSensitiveCategory } from "@moya/contracts/internal/admin-mcp";
import type {
  Field,
  GlobalAfterChangeHook,
  GlobalBeforeChangeHook,
  GlobalConfig,
} from "payload";

import { isHumanOwner } from "../../editorial/access";
import { EditorialError } from "../../editorial/errors";
import { workspacePageLabel } from "../../workspace/routes";
import { changedFieldNames, writeReservedChange } from "../audit";

export const CONTROL_SLUG = "mcp-control";

export const SWITCH_LABELS: Readonly<
  Record<AdminMcpSensitiveCategory, string>
> = {
  dm: "私信",
  evidence: "举报证据文件",
  rawIp: "原始 IP 记录",
  selfOnly: "仅自己可见的作品",
};

/**
 * Opening a category takes the Owner's typed confirmation, stamped here. Closing
 * asks for nothing, and the stamp stays as the last time it was opened.
 */
const requireComplianceConfirmation: GlobalBeforeChangeHook = ({
  data,
  originalDoc,
  req,
}) => {
  const previous = (originalDoc ?? {}) as Record<string, unknown>;
  const opening = ADMIN_MCP_SENSITIVE_CATEGORIES.filter(
    (category) => data[category] === true && previous[category] !== true,
  );
  // One phrase names one category, so one confirmation opens one switch.
  if (opening.length > 1)
    throw new EditorialError("COMPLIANCE_ONE_SWITCH_AT_A_TIME", 400);
  const [category] = opening;
  if (category === undefined) return data;
  if (data.complianceConfirmation !== ADMIN_MCP_COMPLIANCE_PHRASES[category])
    throw new EditorialError("COMPLIANCE_CONFIRMATION_REQUIRED", 400);
  return {
    ...data,
    [`${category}OpenedAt`]: new Date().toISOString(),
    [`${category}OpenedBy`]: req.user?.id ?? null,
  };
};

/**
 * Every change leaves a row. The one exception is turning pause on: an emergency
 * stop must not depend on the ledger being healthy, so it still takes effect and
 * the failure is logged.
 */
const auditControlChange: GlobalAfterChangeHook = async ({
  doc,
  previousDoc,
  req,
}) => {
  const changed = changedFieldNames(
    previousDoc as Record<string, unknown>,
    doc as Record<string, unknown>,
  );
  if (changed.length === 0) return doc;
  try {
    await writeReservedChange(req, CONTROL_SLUG, null, changed);
  } catch {
    req.payload.logger.error({ category: "ADMIN_MCP_AUDIT_WRITE_FAILED" });
    if (changed.join() !== "pause" || doc.pause !== true)
      throw new EditorialError("AUDIT_UNAVAILABLE", 503);
  }
  return doc;
};

// Set by the hook above only: a value sent over REST is dropped.
const hookOnly = { update: () => false };

const switchFields = (category: AdminMcpSensitiveCategory): Field[] => [
  {
    name: category,
    type: "checkbox",
    label: SWITCH_LABELS[category],
    defaultValue: false,
  },
  { name: `${category}OpenedAt`, type: "date", access: hookOnly },
  {
    name: `${category}OpenedBy`,
    type: "relationship",
    relationTo: "users",
    access: hookOnly,
  },
];

/**
 * Reserved to the Owner's browser session (amendment 2026-11-03, section 4). No
 * tool exists for any of it. Hidden from native routing: the control page is the
 * Owner's only screen for it, and these rules hold on the REST route too.
 */
export const McpControl: GlobalConfig = {
  slug: CONTROL_SLUG,
  label: workspacePageLabel("/admin/mcp-control"),
  // A lock must never stand between the Owner and the pause switch.
  lockDocuments: false,
  admin: { hidden: true },
  access: {
    read: ({ req }) => isHumanOwner(req),
    update: ({ req }) => isHumanOwner(req),
  },
  fields: [
    { name: "pause", type: "checkbox", label: "暂停", defaultValue: false },
    {
      name: "threshold",
      type: "number",
      label: "不可逆操作确认阈值",
      required: true,
      defaultValue: ADMIN_MCP_DEFAULT_THRESHOLD,
      validate: (value: unknown) =>
        (typeof value === "number" &&
          Number.isSafeInteger(value) &&
          value >= 1) ||
        "阈值必须是正整数",
    },
    ...ADMIN_MCP_SENSITIVE_CATEGORIES.flatMap(switchFields),
    { name: "complianceConfirmation", type: "text", virtual: true },
  ],
  hooks: {
    beforeChange: [requireComplianceConfirmation],
    afterChange: [auditControlChange],
  },
};
