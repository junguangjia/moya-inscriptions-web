import {
  PUBLISHING_DRAFT_CHANGED,
  apiErrorSchema,
  createPublishingDraftCommandSchema,
  createPublishingSessionCommandSchema,
  deletedResultSchema,
  discardedResultSchema,
  editableWorkSchema,
  mediaComponentIdSchema,
  mediaComponentRoleSchema,
  mediaItemIdSchema,
  openWorkEditDraftCommandSchema,
  publishingDraftDeletionCommandSchema,
  publishingDraftDeletionResultSchema,
  publishingDraftPageSchema,
  publishingDraftSaveResultSchema,
  publishingDraftSchema,
  publishingLimitsSchema,
  publishingMediaItemSchema,
  publishingOpenedEditDraftSchema,
  publishingPageQuerySchema,
  publishingReadinessCommandSchema,
  publishingReadinessSchema,
  publishingSessionHeartbeatCommandSchema,
  publishingSessionIdSchema,
  publishingSessionSchema,
  publishingSnapshotPageSchema,
  publishingUploadResultSchema,
  registerMediaItemCommandSchema,
  requestIdentitySchema,
  resolvePublishingConflictCommandSchema,
  restorePublishingSnapshotCommandSchema,
  savePublishingDraftCommandSchema,
  workDraftIdSchema,
  workPublishingFailureCodeSchema,
  workSubmissionCommandSchema,
  workSubmissionReceiptSchema,
  workSubmissionResultSchema,
  workVisibilityCommandSchema,
  workVisibilityResultSchema,
} from "@moya/contracts/schemas";
import type {
  CreatePublishingDraftCommand,
  CreatePublishingSessionCommand,
  EditableWork,
  MediaComponentRole,
  OpenWorkEditDraftCommand,
  PublishingDraft,
  PublishingDraftDeletionCommand,
  PublishingDraftDeletionResult,
  PublishingDraftPage,
  PublishingDraftSaveResult,
  PublishingHolder,
  PublishingLimits,
  PublishingMediaItem,
  PublishingOpenedEditDraft,
  PublishingReadiness,
  PublishingReadinessCommand,
  PublishingSession,
  PublishingSnapshotPage,
  PublishingUploadResult,
  RegisterMediaItemCommand,
  ResolvePublishingConflictCommand,
  RestorePublishingSnapshotCommand,
  SavePublishingDraftCommand,
  WorkPublishingFailureCode,
  WorkSubmissionCommand,
  WorkSubmissionReceipt,
  WorkSubmissionResult,
  WorkVisibilityCommand,
  WorkVisibilityResult,
} from "@moya/contracts";

import { AuthorRequestError, authorClient } from "./author-community-client";

/**
 * The shared work publishing text rule (C02) and limits from the contracts,
 * so Web counters, field checks and the Backend count identically. Client
 * Components reach them through `features/publishing/publishing-data.ts`.
 */
export {
  AUTHORSHIP_ORIGINAL_AUTHOR_MAXIMUM,
  AUTHORSHIP_REFERENCE_TITLE_MAXIMUM,
  AUTHORSHIP_SOURCE_NOTE_MAXIMUM,
  DRAFT_TEXT_RAW_ALLOWANCE,
  WORK_BODY_MAXIMUM,
  WORK_EXCERPT_MAXIMUM,
  WORK_ITEMS_CONFIGURABLE_MAXIMUM,
  WORK_ITEMS_HARD_MAXIMUM,
  WORK_TITLE_MAXIMUM,
  checkPublishingBody,
  checkPublishingText,
  checkPublishingTitle,
  codePointLength,
  hasInvalidPublishingCharacters,
  normalizePublishingBody,
  normalizePublishingLineBreaks,
  normalizePublishingTitle,
  publishingBodyRule,
  publishingContentIssues,
  publishingTitleRule,
} from "@moya/contracts/schemas";
export type {
  PublishingContentInput,
  PublishingContentIssue,
  PublishingTextCheck,
  PublishingTextIssue,
  PublishingTextRule,
} from "@moya/contracts/schemas";
export type {
  PublishingHolder,
  PublishingReadiness,
  PublishingReadinessCommand,
};

/**
 * Browser client for work publishing (work-publishing-v1 §10). JSON commands
 * go through the same-origin community relay; component bytes go through the
 * dedicated upload relay with Uppy's XHR (this module only names the endpoint,
 * headers and answer parsing). Every request is private: same-origin
 * credentials, no cache, no redirects, the confirmed account on every write,
 * and contract parsing of every answer.
 *
 * Reconciliation rule for writes: a `PublishingRequestError` with
 * `outcomeUnknown` means the command may have taken effect although no
 * confirmed answer arrived. Callers show a reconciling state and then either
 * repeat the same command with the same `requestId` (commands are idempotent
 * per request identity) or read the resulting state (`submissionReceipt`,
 * `item`, `draft`, `editableWork`). They never create a new write intent for
 * it. After any failed component upload the upload manager reads `item(id)`
 * again before offering a retry.
 */

interface SafeParser<T> {
  safeParse: (value: unknown) =>
    | { readonly success: true; readonly data: T }
    | {
        readonly success: false;
        readonly error: { readonly issues: readonly { message: string }[] };
      };
}

export interface PublishingPageQueryInput {
  readonly page?: number;
  readonly pageSize?: number;
}

export interface PublishingRequestIdentity {
  readonly requestId: string;
}

/**
 * Field and state codes a refusal can carry: the contract's failure codes plus
 * `draft_changed` (a conditional draft deletion found another revision).
 */
export type PublishingRequestErrorCode =
  WorkPublishingFailureCode | typeof PUBLISHING_DRAFT_CHANGED;

/**
 * A refused or failed publishing request. `message` is always product text
 * (Backend wording is never shown). `code` carries the field-specific failure
 * the Backend named (422, or a 409/413 whose message is a code) so the editor
 * can point at the field; `status` 0 means the network failed.
 */
export class PublishingRequestError extends AuthorRequestError {
  constructor(
    status: number,
    message: string,
    readonly code: PublishingRequestErrorCode | null = null,
    /**
     * True only for a write (or upload) that may have taken effect without a
     * confirmed answer: the connection failed or timed out after sending, a
     * success answer was unreadable or broke the contract, a gateway failure
     * arrived without a Backend refusal, or the account changed before a
     * non-refusal answer was handed over. Always false for reads and for
     * refusals. See the reconciliation rule above.
     */
    readonly outcomeUnknown = false,
  ) {
    super(status, message);
    this.name = "PublishingRequestError";
  }
}

const requestTimeoutMs = 15_000;
const unavailableMessage = "暂时无法完成，请重试";
const networkMessage = "网络连接中断，请检查后重试";
const networkUnconfirmedMessage = "网络连接中断，结果尚未确认";
const unconfirmedMessage = "暂时无法确认结果，请稍后检查";

const failureMessages: Readonly<Record<PublishingRequestErrorCode, string>> = {
  empty_work: "标题、正文和图片不能都为空",
  title_too_long: "标题过长",
  title_line_break: "标题不能换行",
  body_too_long: "正文过长",
  reference_title_too_long: "参考作品名称过长",
  original_author_too_long: "原作者名称过长",
  source_note_too_long: "来源说明过长",
  items_limit: "图片数量已达上限",
  not_ready: "仍有图片未处理完成",
  capacity_exceeded: "存储空间不足，文字仍可保存",
  daily_limit: "今日新发布作品数量已达上限",
  draft_limit: "草稿数量已达上限",
  original_item_too_large: "原图超过单项大小上限",
  component_too_large: "文件超过允许的大小",
  unsupported_type: "格式不支持",
  pairing_mismatch: "实况照片的图片与视频不匹配",
  work_unavailable: "作品不可用",
  thread_unavailable: "该话题已关闭或不可用，作品未发布",
  thread_conflict: "该作品已属于其他话题",
  thread_items_limit: "参与话题最多附 3 张静态图片",
  [PUBLISHING_DRAFT_CHANGED]: "草稿已在别处更改，未删除",
};

const statusMessage = (status: number): string => {
  switch (status) {
    case 401:
      return "请先登录";
    case 404:
      return "内容不可用";
    case 409:
      return "状态已变化，请检查后重试";
    case 413:
      return "内容超过允许的大小";
    case 422:
      return "内容不符合要求，请检查后修改";
    default:
      return unavailableMessage;
  }
};

const failureCodeOf = (value: unknown): WorkPublishingFailureCode | null => {
  const parsed = workPublishingFailureCodeSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
};

/** The failure code a refusal names: a contract code, or `draft_changed` on a 409. */
const refusalCodeOf = (
  status: number,
  message: unknown,
): PublishingRequestErrorCode | null =>
  status === 409 && message === PUBLISHING_DRAFT_CHANGED
    ? PUBLISHING_DRAFT_CHANGED
    : failureCodeOf(message);

const errorMessageOf = (body: unknown): unknown =>
  typeof body === "object" &&
  body !== null &&
  "error" in body &&
  typeof body.error === "object" &&
  body.error !== null &&
  "message" in body.error
    ? body.error.message
    : undefined;

/**
 * Maps a refused answer to product text; a failure code named by a 409, 413
 * or 422 survives as `code`. Backend wording never reaches the message.
 */
const refusal = (status: number, body: unknown): PublishingRequestError => {
  const code =
    status === 409 || status === 413 || status === 422
      ? refusalCodeOf(status, errorMessageOf(body))
      : null;
  return code === null
    ? new PublishingRequestError(status, statusMessage(status))
    : new PublishingRequestError(status, failureMessages[code], code);
};

/**
 * Whether an unsuccessful answer is a definite refusal (nothing was applied):
 * any 4xx, or the Backend's own declared unavailability. Other 5xx answers
 * (a relay timeout or interruption, an internal error) leave a write's
 * outcome unknown.
 */
const isRefusal = (status: number, body: unknown): boolean => {
  if (status >= 400 && status < 500) return true;
  if (status < 500) return false;
  const parsed = apiErrorSchema.safeParse(body);
  return parsed.success && parsed.data.error.code === "SERVICE_UNAVAILABLE";
};

/** An answer that belonged to an earlier account is never handed over. */
const accountChanged = (write: boolean, outcomeUnknown: boolean) =>
  write
    ? new PublishingRequestError(
        401,
        outcomeUnknown
          ? "账户状态已变化，请刷新后检查操作结果"
          : "账户状态已变化，操作未完成",
        null,
        outcomeUnknown,
      )
    : new PublishingRequestError(401, "账户状态已变化，请重试读取");

/** Validates a command before it leaves the browser, keeping the field code. */
const command = <T>(schema: SafeParser<T>, value: unknown): T => {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const code =
    parsed.error.issues
      .map((issue) => failureCodeOf(issue.message))
      .find((candidate) => candidate !== null) ?? null;
  throw new PublishingRequestError(
    422,
    code === null ? statusMessage(422) : failureMessages[code],
    code,
  );
};

const workIdPattern = /^work-[0-9a-f]{32}$/u;

/** A path segment is only ever a validated platform id; anything else is unavailable. */
const segment = (valid: boolean, value: string): string => {
  if (!valid) throw new PublishingRequestError(404, statusMessage(404));
  return value;
};
const draftSegment = (id: string) =>
  segment(workDraftIdSchema.safeParse(id).success, id);
const workSegment = (id: string) => segment(workIdPattern.test(id), id);
const sessionSegment = (id: string) =>
  segment(publishingSessionIdSchema.safeParse(id).success, id);
const itemSegment = (id: string) =>
  segment(mediaItemIdSchema.safeParse(id).success, id);
const requestSegment = (id: string) =>
  segment(requestIdentitySchema.safeParse({ requestId: id }).success, id);

const pageQuery = (query: PublishingPageQueryInput): string => {
  const { page, pageSize } = command(publishingPageQuerySchema, query);
  return new URLSearchParams({
    page: String(page),
    pageSize: String(pageSize),
  }).toString();
};

type Method = "GET" | "POST" | "DELETE";

interface RequestOptions {
  readonly method?: Method;
  readonly body?: unknown;
  readonly signal?: AbortSignal | undefined;
  /** Answer null instead of refusing when the Backend has nothing (404). */
  readonly missingAsNull?: boolean;
}

async function request<T>(
  path: string,
  schema: SafeParser<T>,
  options: RequestOptions & { readonly missingAsNull: true },
): Promise<T | null>;
async function request<T>(
  path: string,
  schema: SafeParser<T>,
  options?: RequestOptions,
): Promise<T>;
async function request<T>(
  path: string,
  schema: SafeParser<T>,
  options: RequestOptions = {},
): Promise<T | null> {
  const method = options.method ?? "GET";
  const write = method !== "GET";
  const account = authorClient.account();
  const epoch = authorClient.accountEpoch();
  if (write && account === null)
    throw new PublishingRequestError(401, "请先确认当前账户");
  const timeout = AbortSignal.timeout(requestTimeoutMs);
  let response: Response;
  try {
    response = await fetch(`/api/community/${path}`, {
      method,
      cache: "no-store",
      credentials: "same-origin",
      redirect: "error",
      signal: options.signal
        ? AbortSignal.any([options.signal, timeout])
        : timeout,
      headers: write
        ? {
            accept: "application/json",
            "content-type": "application/json",
            "x-author-account": account!,
          }
        : { accept: "application/json" },
      ...(write ? { body: JSON.stringify(options.body) } : {}),
    });
  } catch (error) {
    // A caller's own abort is rethrown as is; for a write it leaves the
    // outcome unknown just like a lost connection or the request timeout.
    if (options.signal?.aborted) throw error;
    throw write
      ? new PublishingRequestError(0, networkUnconfirmedMessage, null, true)
      : new PublishingRequestError(0, networkMessage);
  }
  let value: unknown;
  let readable = true;
  try {
    value = await response.json();
  } catch {
    if (options.signal?.aborted) throw options.signal.reason;
    readable = false;
  }
  const refused = !response.ok && isRefusal(response.status, value);
  // Checked once the whole answer is in: the epoch only grows, so any account
  // change during the request (even A→B→A) is detected here.
  if (authorClient.accountEpoch() !== epoch)
    throw accountChanged(write, write && !refused);
  if (options.missingAsNull && response.status === 404) return null;
  if (!response.ok) {
    if (refused || !write) throw refusal(response.status, value);
    throw new PublishingRequestError(
      response.status,
      unconfirmedMessage,
      null,
      true,
    );
  }
  const parsed = readable ? schema.safeParse(value) : null;
  if (parsed === null || !parsed.success)
    throw write
      ? new PublishingRequestError(502, unconfirmedMessage, null, true)
      : new PublishingRequestError(502, unavailableMessage);
  return parsed.data;
}

const post = <T>(
  path: string,
  schema: SafeParser<T>,
  body: unknown,
  signal?: AbortSignal,
) => request(path, schema, { method: "POST", body, signal });

const uploadAttemptPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export const publishingClient = {
  limits: async (signal?: AbortSignal): Promise<PublishingLimits> =>
    request("publishing/limits", publishingLimitsSchema, { signal }),

  createDraft: async (
    cmd: CreatePublishingDraftCommand,
    signal?: AbortSignal,
  ): Promise<PublishingDraft> =>
    post(
      "publishing/drafts",
      publishingDraftSchema,
      command(createPublishingDraftCommandSchema, cmd),
      signal,
    ),

  listDrafts: async (
    query: PublishingPageQueryInput = {},
    signal?: AbortSignal,
  ): Promise<PublishingDraftPage> =>
    request(
      `publishing/drafts?${pageQuery(query)}`,
      publishingDraftPageSchema,
      {
        signal,
      },
    ),

  draft: async (
    draftId: string,
    signal?: AbortSignal,
  ): Promise<PublishingDraft> =>
    request(
      `publishing/drafts/${draftSegment(draftId)}`,
      publishingDraftSchema,
      {
        signal,
      },
    ),

  saveDraft: async (
    draftId: string,
    cmd: SavePublishingDraftCommand,
    signal?: AbortSignal,
  ): Promise<PublishingDraftSaveResult> =>
    post(
      `publishing/drafts/${draftSegment(draftId)}/save`,
      publishingDraftSaveResultSchema,
      command(savePublishingDraftCommandSchema, cmd),
      signal,
    ),

  /** Save now: the same conditional save, kept as an important snapshot. */
  saveDraftNow: async (
    draftId: string,
    cmd: SavePublishingDraftCommand,
    signal?: AbortSignal,
  ): Promise<PublishingDraftSaveResult> =>
    post(
      `publishing/drafts/${draftSegment(draftId)}/snapshot`,
      publishingDraftSaveResultSchema,
      command(savePublishingDraftCommandSchema, cmd),
      signal,
    ),

  /**
   * Deletes that draft, its history, conflict copies and exclusively held
   * media. With `expectedRevision` the deletion only happens while the draft
   * still has that revision; otherwise it is refused with code
   * `draft_changed` and nothing is deleted.
   */
  deleteDraft: async (
    draftId: string,
    cmd: PublishingDraftDeletionCommand,
    signal?: AbortSignal,
  ): Promise<PublishingDraftDeletionResult> =>
    request(
      `publishing/drafts/${draftSegment(draftId)}`,
      publishingDraftDeletionResultSchema,
      {
        method: "DELETE",
        body: command(publishingDraftDeletionCommandSchema, cmd),
        signal,
      },
    ),

  draftHistory: async (
    draftId: string,
    query: PublishingPageQueryInput = {},
    signal?: AbortSignal,
  ): Promise<PublishingSnapshotPage> =>
    request(
      `publishing/drafts/${draftSegment(draftId)}/history?${pageQuery(query)}`,
      publishingSnapshotPageSchema,
      { signal },
    ),

  restoreSnapshot: async (
    draftId: string,
    cmd: RestorePublishingSnapshotCommand,
    signal?: AbortSignal,
  ): Promise<PublishingDraft> =>
    post(
      `publishing/drafts/${draftSegment(draftId)}/restore`,
      publishingDraftSchema,
      command(restorePublishingSnapshotCommandSchema, cmd),
      signal,
    ),

  resolveConflict: async (
    draftId: string,
    cmd: ResolvePublishingConflictCommand,
    signal?: AbortSignal,
  ): Promise<PublishingDraft> =>
    post(
      `publishing/drafts/${draftSegment(draftId)}/resolve`,
      publishingDraftSchema,
      command(resolvePublishingConflictCommandSchema, cmd),
      signal,
    ),

  /**
   * Opens (or returns) the work's private edit draft. `created` is true only
   * when this call inserted it, so an untouched draft is removed again on
   * leaving only by the editor that created it.
   */
  openWorkEditDraft: async (
    workId: string,
    cmd: OpenWorkEditDraftCommand,
    signal?: AbortSignal,
  ): Promise<PublishingOpenedEditDraft> =>
    post(
      `publishing/works/${workSegment(workId)}/draft`,
      publishingOpenedEditDraftSchema,
      command(openWorkEditDraftCommandSchema, cmd),
      signal,
    ),

  editableWork: async (
    workId: string,
    signal?: AbortSignal,
  ): Promise<EditableWork> =>
    request(
      `publishing/works/${workSegment(workId)}/editable`,
      editableWorkSchema,
      { signal },
    ),

  setVisibility: async (
    workId: string,
    cmd: WorkVisibilityCommand,
    signal?: AbortSignal,
  ): Promise<WorkVisibilityResult> =>
    post(
      `publishing/works/${workSegment(workId)}/visibility`,
      workVisibilityResultSchema,
      command(workVisibilityCommandSchema, cmd),
      signal,
    ),

  createSession: async (
    cmd: CreatePublishingSessionCommand,
    signal?: AbortSignal,
  ): Promise<PublishingSession> =>
    post(
      "publishing/sessions",
      publishingSessionSchema,
      command(createPublishingSessionCommandSchema, cmd),
      signal,
    ),

  heartbeatSession: async (
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<PublishingSession> =>
    post(
      `publishing/sessions/${sessionSegment(sessionId)}/heartbeat`,
      publishingSessionSchema,
      command(publishingSessionHeartbeatCommandSchema, {}),
      signal,
    ),

  discardSession: async (
    sessionId: string,
    cmd: PublishingRequestIdentity,
    signal?: AbortSignal,
  ): Promise<{ discarded: true }> =>
    post(
      `publishing/sessions/${sessionSegment(sessionId)}/discard`,
      discardedResultSchema,
      command(requestIdentitySchema, cmd),
      signal,
    ),

  registerItem: async (
    cmd: RegisterMediaItemCommand,
    signal?: AbortSignal,
  ): Promise<PublishingMediaItem> =>
    post(
      "publishing/items",
      publishingMediaItemSchema,
      command(registerMediaItemCommandSchema, cmd),
      signal,
    ),

  item: async (
    itemId: string,
    signal?: AbortSignal,
  ): Promise<PublishingMediaItem> =>
    request(
      `publishing/items/${itemSegment(itemId)}`,
      publishingMediaItemSchema,
      {
        signal,
      },
    ),

  cancelItem: async (
    itemId: string,
    cmd: PublishingRequestIdentity,
    signal?: AbortSignal,
  ): Promise<PublishingMediaItem> =>
    post(
      `publishing/items/${itemSegment(itemId)}/cancel`,
      publishingMediaItemSchema,
      command(requestIdentitySchema, cmd),
      signal,
    ),

  /** Explicit user retry of one component: a new attempt from its first byte. */
  resetComponent: async (
    itemId: string,
    role: MediaComponentRole,
    cmd: PublishingRequestIdentity,
    signal?: AbortSignal,
  ): Promise<PublishingMediaItem> =>
    post(
      `publishing/items/${itemSegment(itemId)}/components/${segment(
        mediaComponentRoleSchema.safeParse(role).success,
        role,
      )}/reset`,
      publishingMediaItemSchema,
      command(requestIdentitySchema, cmd),
      signal,
    ),

  /** The same-origin streaming relay path for one component (Uppy XHRUpload `endpoint`, POST). */
  uploadEndpoint: (componentId: string): string =>
    `/api/community/publishing/uploads/${segment(
      mediaComponentIdSchema.safeParse(componentId).success,
      componentId,
    )}`,

  /**
   * Uppy XHRUpload `headers` for one attempt: raw bytes, the confirmed account
   * and the attempt id the Backend fences this transfer with. The browser sets
   * Content-Length. Keep the returned `x-author-account` for `uploadResult`.
   */
  uploadHeaders: (attempt: string): Record<string, string> => {
    const account = authorClient.account();
    if (account === null)
      throw new PublishingRequestError(401, "请先确认当前账户");
    if (!uploadAttemptPattern.test(attempt))
      throw new PublishingRequestError(422, statusMessage(422));
    return {
      "content-type": "application/octet-stream",
      "x-author-account": account,
      "x-upload-attempt": attempt,
    };
  },

  /**
   * Parses the relay's answer to one component upload (XHR status and
   * response text). `account` is the `x-author-account` the upload was sent
   * with; an answer is never handed to a different account. A refusal (4xx,
   * or the Backend's declared unavailability) has a known outcome; status 0,
   * the relay's 502/504 (`x-publishing-relay`) and an unreadable success are
   * `outcomeUnknown`. Either way the manager reads `item(id)` again.
   */
  uploadResult: (
    status: number,
    responseText: string,
    account: string,
  ): PublishingUploadResult => {
    let value: unknown;
    try {
      value = responseText === "" ? undefined : JSON.parse(responseText);
    } catch {
      value = undefined;
    }
    const success = status >= 200 && status <= 299;
    const refused = !success && isRefusal(status, value);
    if (authorClient.account() !== account)
      throw accountChanged(true, !refused);
    if (status === 0)
      throw new PublishingRequestError(
        0,
        networkUnconfirmedMessage,
        null,
        true,
      );
    if (refused) throw refusal(status, value);
    if (!success)
      throw new PublishingRequestError(status, unconfirmedMessage, null, true);
    const parsed = publishingUploadResultSchema.safeParse(value);
    if (!parsed.success)
      throw new PublishingRequestError(502, unconfirmedMessage, null, true);
    return parsed.data;
  },

  /**
   * Explicit readiness of the holder's current content: the Backend starts
   * any missing edit derivative at once and answers which item keys still
   * wait (`pendingItemKeys`) or failed (`failedItemKeys`), and for ready
   * edited items the edit key of their thumb
   * (`/api/community/publishing/media/<itemId>/thumb/<editKey>`). A
   * submission is refused as `not_ready` exactly while `ready` is false, so
   * the editor shows this instead of its own guess. Not receipted.
   */
  readiness: async (
    holder: PublishingHolder,
    content: PublishingReadinessCommand["content"],
    signal?: AbortSignal,
  ): Promise<PublishingReadiness> =>
    post(
      "draftId" in holder
        ? `publishing/drafts/${draftSegment(holder.draftId)}/readiness`
        : `publishing/sessions/${sessionSegment(holder.sessionId)}/readiness`,
      publishingReadinessSchema,
      command(publishingReadinessCommandSchema, { content }),
      signal,
    ),

  submit: async (
    cmd: WorkSubmissionCommand,
    signal?: AbortSignal,
  ): Promise<WorkSubmissionResult> =>
    post(
      "publishing/submissions",
      workSubmissionResultSchema,
      command(workSubmissionCommandSchema, cmd),
      signal,
    ),

  /**
   * The receipt for a submission whose answer was lost. `null` only means no
   * committed submission exists for this request identity yet: the original
   * `submit` may still be in flight. Callers keep reconciling (ask again, or
   * repeat `submit` with the same command and `requestId`) instead of treating
   * `null` as a failure.
   */
  submissionReceipt: async (
    requestId: string,
    signal?: AbortSignal,
  ): Promise<WorkSubmissionReceipt | null> =>
    request(
      `publishing/submissions/${requestSegment(requestId)}`,
      workSubmissionReceiptSchema,
      { signal, missingAsNull: true },
    ),

  /** Permanently deletes a submitted work (the existing work deletion route). */
  deleteWork: async (
    workId: string,
    cmd: PublishingRequestIdentity,
    signal?: AbortSignal,
  ): Promise<{ deleted: true }> =>
    request(`works/${workSegment(workId)}`, deletedResultSchema, {
      method: "DELETE",
      body: command(requestIdentitySchema, cmd),
      signal,
    }),
};
