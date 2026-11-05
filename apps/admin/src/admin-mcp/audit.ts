import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import type {
  CollectionAfterChangeHook,
  CollectionBeforeChangeHook,
  CollectionConfig,
  Payload,
  PayloadRequest,
} from "payload";

import { isHumanOwner } from "../editorial/access";
import { EditorialError } from "../editorial/errors";
import { isLedgerRequest, withLedgerWrite } from "../editorial/state";
import type { McpAuditEvent } from "../payload-types";
import { workspacePageLabel } from "../workspace/routes";

/**
 * The AI audit ledger (docs/development/admin-mcp-completion-v1.md section 13).
 * Append-only by grant, with a trigger as a second net. No argument or content
 * reaches a row; a start with no finish reads as outcome unknown.
 */

const AUDIT_HREF = "/admin/collections/mcp-audit-events";

export const McpAuditEvents: CollectionConfig = {
  slug: "mcp-audit-events",
  labels: {
    singular: workspacePageLabel(AUDIT_HREF),
    plural: workspacePageLabel(AUDIT_HREF),
  },
  timestamps: false,
  disableBulkEdit: true,
  disableDuplicate: true,
  defaultSort: "-at",
  admin: {
    useAsTitle: "callId",
    group: "操作记录",
    description:
      "查看 AI 工具与自动化密钥的每次调用。写入有开始和结束两条记录，只有开始的记录表示结果未知。",
    defaultColumns: [
      "at",
      "tool",
      "op",
      "class",
      "phase",
      "ok",
      "code",
      "durationMs",
      "keyLabel",
      "authorizedBy",
    ],
  },
  access: {
    create: ({ req }) => isLedgerRequest(req),
    delete: () => false,
    read: ({ req }) => isHumanOwner(req),
    update: () => false,
  },
  fields: [
    {
      name: "at",
      type: "date",
      label: "时间",
      required: true,
      index: true,
      admin: { date: { pickerAppearance: "dayAndTime" } },
    },
    {
      name: "phase",
      type: "select",
      label: "阶段",
      required: true,
      options: [
        { label: "开始", value: "start" },
        { label: "结束", value: "finish" },
      ],
    },
    {
      name: "class",
      type: "select",
      label: "类别",
      required: true,
      options: [
        { label: "读取", value: "read" },
        { label: "可逆操作", value: "reversible" },
        { label: "不可逆操作", value: "irreversible" },
        { label: "插件路径写入", value: "write" },
        { label: "受保护设置变更", value: "reserved" },
      ],
    },
    { name: "tool", type: "text", label: "工具" },
    { name: "op", type: "text", label: "操作" },
    { name: "ok", type: "checkbox", label: "成功" },
    { name: "code", type: "text", label: "结果代码" },
    { name: "keyLabel", type: "text", label: "密钥或工具" },
    { name: "targetType", type: "text", label: "对象类型" },
    { name: "targetId", type: "text", label: "对象编号" },
    { name: "count", type: "number", label: "对象数量" },
    { name: "changedFields", type: "json", label: "变更字段" },
    {
      type: "collapsible",
      label: "执行详细信息",
      admin: { initCollapsed: true },
      fields: [
        // Pairs a start with its finish; requestId is the caller's dedupe key.
        {
          name: "callId",
          type: "text",
          label: "调用编号",
          required: true,
          index: true,
        },
        { name: "keyId", type: "number", label: "密钥编号" },
        { name: "userId", type: "text", label: "账号编号" },
        // A login-door call: which connection, and the email of the person who
        // authorized it at that moment. userId stays the AI row, keyId stays empty.
        { name: "connectionId", type: "text", label: "连接编号" },
        { name: "authorizedBy", type: "text", label: "授权人" },
        { name: "runId", type: "text", label: "运行编号" },
        { name: "requestId", type: "text", label: "请求编号" },
        { name: "durationMs", type: "number", label: "耗时（毫秒）" },
        { name: "responseBytes", type: "number", label: "响应字节数" },
        { name: "dbMs", type: "number", label: "数据库耗时（毫秒）" },
        { name: "upstreamMs", type: "number", label: "上游耗时（毫秒）" },
        { name: "queryCount", type: "number", label: "查询次数" },
        { name: "cacheHit", type: "checkbox", label: "命中缓存" },
        { name: "branchLatency", type: "json", label: "分支耗时" },
        // A definition write records only a hash of before and after.
        { name: "beforeHash", type: "text", label: "变更前校验值" },
        { name: "afterHash", type: "text", label: "变更后校验值" },
      ],
    },
  ],
  hooks: {
    beforeValidate: [
      ({ data, req }) => {
        if (!isLedgerRequest(req))
          throw new EditorialError("AUDIT_SERVER_ONLY", 403);
        return data;
      },
    ],
  },
};

export type AuditEvent = Omit<McpAuditEvent, "id" | "at">;

/**
 * One row, on a request of its own: never `req.transactionID`, so a rollback or a
 * failed COMMIT of the business transaction leaves the row. Throws on failure.
 */
export const writeAuditEvent = async (
  payload: Payload,
  event: AuditEvent,
): Promise<void> => {
  // payload.create completes this into a local request, keeping its identity.
  const req = {} as PayloadRequest;
  await withLedgerWrite(req, () =>
    payload.create({
      collection: "mcp-audit-events",
      req,
      overrideAccess: false,
      disableTransaction: true,
      depth: 0,
      select: { phase: true },
      data: { at: new Date().toISOString(), ...event },
    }),
  );
};

/** Bookkeeping Payload moves on its own, and secrets by another name. */
const UNNAMED_FIELDS: ReadonlySet<string> = new Set([
  "apiKeyIndex",
  "createdAt",
  "globalType",
  "hash",
  "id",
  "lockUntil",
  "loginAttempts",
  "salt",
  "sessions",
  "updatedAt",
]);

/** A relationship may arrive populated on one side and as an id on the other. */
const comparable = (value: unknown): unknown =>
  value !== null && typeof value === "object" && "id" in value
    ? value.id
    : (value ?? null);

/**
 * Names only, so a row never holds a value from an account, key or switch. A field
 * missing from `next` is unknown, not removed: a hidden or unselected field never
 * comes back from Payload, and a cleared one comes back null.
 */
export const changedFieldNames = (
  previous: Readonly<Record<string, unknown>>,
  next: Readonly<Record<string, unknown>>,
): string[] =>
  Object.keys(next)
    .filter(
      (name) =>
        !UNNAMED_FIELDS.has(name) &&
        !isDeepStrictEqual(comparable(previous[name]), comparable(next[name])),
    )
    .sort();

/** A reserved-surface change is recorded by a hook, whoever makes it. */
export const writeReservedChange = (
  req: PayloadRequest,
  slug: string,
  id: string | number | null,
  changedFields: readonly string[],
): Promise<void> =>
  writeAuditEvent(req.payload, {
    callId: randomUUID(),
    phase: "finish",
    class: "reserved",
    op: `${slug}.change`,
    ok: true,
    code: "OK",
    targetType: slug,
    ...(id === null ? {} : { targetId: String(id) }),
    ...(req.user ? { userId: String(req.user.id) } : {}),
    changedFields: [...changedFields],
  });

// Payload removes the password before the document hook can see it.
const passwordChanges = new WeakSet<PayloadRequest>();

/** Runs before Payload hashes the password, so the name reaches the row. */
export const noticePasswordChange: CollectionBeforeChangeHook = ({
  data,
  req,
}) => {
  if (typeof data.password === "string") passwordChanges.add(req);
  return data;
};

/**
 * Accounts and keys. A change that cannot be recorded does not happen: the throw
 * rolls back the transaction the change runs in.
 */
export const auditReservedCollection: CollectionAfterChangeHook = async ({
  collection,
  doc,
  operation,
  previousDoc,
  req,
}) => {
  const document = doc as Record<string, unknown>;
  const changed = changedFieldNames(
    operation === "create" ? {} : (previousDoc as Record<string, unknown>),
    document,
  );
  if (passwordChanges.delete(req)) changed.push("password");
  if (changed.length === 0) return doc;
  try {
    await writeReservedChange(
      req,
      collection.slug,
      document.id as string | number,
      changed,
    );
  } catch {
    req.payload.logger.error({ category: "ADMIN_MCP_AUDIT_WRITE_FAILED" });
    throw new EditorialError("AUDIT_UNAVAILABLE", 503);
  }
  return doc;
};
