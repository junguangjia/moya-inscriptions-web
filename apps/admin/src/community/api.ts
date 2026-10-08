import type {
  AccountCapacityClass,
  CommentModerationAction,
  CommentModerationState,
  ModerationEventAction,
  ModerationEventSubjectKind,
  OperatorCommentKind,
  OperatorWork,
  OperatorWorkSubmission,
  PublicationPolicy,
  PublishingJobKind,
  PublishingJobState,
  WorkSubmissionModerationAction,
  WorkSubmissionQueueState,
} from "@moya/contracts/internal/community-operator";

/**
 * Operator shapes the work publishing browser modules render. Types only:
 * every value still crosses the same-origin Payload endpoints.
 */
export type {
  AccountCapacityClass,
  OperatorAccountCapacity,
  OperatorPublishingJob,
  OperatorPublishingJobPage,
  OperatorSubmissionMedia,
  OperatorWork,
  OperatorWorkSubmission,
  OperatorWorkSubmissionPage,
  PublicationPolicy,
  PublishingJobAction,
  PublishingJobKind,
  PublishingJobState,
  SetWorkPublishingSettingsCommand,
  WorkPublishingSettings,
  WorkSubmissionModerationAction,
  WorkSubmissionModerationResult,
  WorkSubmissionQueueState,
} from "@moya/contracts/internal/community-operator";

/**
 * Browser-side helpers for the Owner's moderation workspace. Every call goes
 * to the same-origin Payload endpoints, which hold the operator credential
 * server-side; nothing here knows the Backend or any secret.
 */

export class OperatorFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    /** The same-origin endpoint's HTTP status; null when no answer arrived. */
    readonly status: number | null = null,
  ) {
    super(message);
  }
}

const messages: Record<string, string> = {
  COMMUNITY_OWNER_ONLY: "此操作仅限 Owner。",
  OPERATOR_NOT_CONFIGURED: "尚未配置社区后端连接，请先设置后再操作。",
  OPERATOR_UNAUTHORIZED: "社区操作凭据无效，请重新配置后端连接。",
  AGENT_FORBIDDEN: "该代理主体未启用或不具备所需权限范围。",
  OPERATOR_UNREACHABLE: "无法连接社区后端。",
  OPERATOR_UNAVAILABLE: "社区数据暂时不可用。",
  COMMAND_INVALID: "请求参数无效，未执行任何操作。",
  JSON_BODY_REQUIRED: "请求格式无效，未执行任何操作。",
  NOT_FOUND: "目标已不存在。",
  STATE_CONFLICT: "该项状态已变化（可能已被处理），本次操作未执行。",
  OPERATOR_RESPONSE_INVALID:
    "社区后端返回的数据与约定不符，未显示也未执行后续操作。",
  RANGE_NOT_SATISFIABLE: "请求的媒体片段不存在。",
  OPERATION_FAILED: "操作未完成，内容不会被自动修改。",
};

/** What the Owner can do next; never a stack trace, SQL or secret. */
const hints: Record<string, string> = {
  STATE_CONFLICT: "请刷新当前列表后再决定。",
  NOT_FOUND: "请刷新当前列表。",
  OPERATOR_UNAVAILABLE: "稍后可直接重试。",
  OPERATOR_UNREACHABLE: "请确认后端已启动，然后重试。",
  OPERATOR_NOT_CONFIGURED: "配置完成后刷新页面。",
  OPERATOR_UNAUTHORIZED: "配置完成后刷新页面。",
  AGENT_FORBIDDEN: "请在代理操作视图中检查主体状态与权限范围。",
  COMMAND_INVALID: "请刷新页面后重试。",
  JSON_BODY_REQUIRED: "请刷新页面后重试。",
  OPERATOR_RESPONSE_INVALID: "请确认前后端版本一致后刷新页面。",
  RANGE_NOT_SATISFIABLE: "请刷新页面。",
  OPERATION_FAILED: "可重试一次；若仍失败请刷新页面。",
};

export const failureMessage = (code: string): string =>
  (Object.hasOwn(messages, code) ? messages[code] : undefined) ??
  messages.OPERATION_FAILED!;

export const failureHint = (code: string): string =>
  (Object.hasOwn(hints, code) ? hints[code] : undefined) ??
  hints.OPERATION_FAILED!;

export const describeFailure = (
  error: unknown,
): { code: string; text: string } => {
  const code =
    error instanceof OperatorFailure ? error.code : "OPERATION_FAILED";
  return { code, text: `${failureMessage(code)}${failureHint(code)}` };
};

export async function call<Result>(
  name: string,
  input: unknown = {},
  signal?: AbortSignal,
): Promise<Result> {
  let response: Response;
  try {
    response = await fetch(`/api/community-moderation/${name}`, {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error) {
    if (signal?.aborted === true) throw error;
    throw new OperatorFailure(
      "OPERATOR_UNREACHABLE",
      failureMessage("OPERATOR_UNREACHABLE"),
    );
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new OperatorFailure(
      "OPERATION_FAILED",
      failureMessage("OPERATION_FAILED"),
      response.status,
    );
  }
  if (
    body === null ||
    typeof body !== "object" ||
    !("ok" in body) ||
    body.ok !== true
  ) {
    const code =
      body !== null &&
      typeof body === "object" &&
      "error" in body &&
      body.error !== null &&
      typeof body.error === "object" &&
      "code" in body.error &&
      typeof body.error.code === "string"
        ? body.error.code
        : "OPERATION_FAILED";
    throw new OperatorFailure(code, failureMessage(code), response.status);
  }
  return (body as unknown as { result: Result }).result;
}

/**
 * Whether a failed command may still have been applied, so re-sending the
 * same request identity is the safe next step. An answer the Backend decided
 * (a refused or invalid request, a conflict, a missing subject, an answer
 * outside the contract) is final and is never offered again.
 */
export const outcomeUnknown = (error: unknown): boolean => {
  if (!(error instanceof OperatorFailure)) return true;
  if (
    error.code === "OPERATOR_UNREACHABLE" ||
    error.code === "OPERATOR_UNAVAILABLE"
  )
    return true;
  return (
    error.code === "OPERATION_FAILED" &&
    error.status !== 400 &&
    error.status !== 422
  );
};

/** The text for a final refusal: nothing was changed and the same request is not re-sent. */
export const describeFinalFailure = (error: unknown): string => {
  const { code, text } = describeFailure(error);
  return code === "OPERATION_FAILED"
    ? "后端拒绝了该请求，未执行任何操作。请刷新页面后重新检查。"
    : text;
};

export const moderationLabels: Record<CommentModerationState, string> = {
  pending: "待审核",
  visible: "已公开",
  hidden: "已隐藏",
};

export const kindLabels: Record<OperatorCommentKind, string> = {
  comment: "根评论",
  reply: "回复",
};

export const actionLabels: Record<ModerationEventAction, string> = {
  approve: "通过并公开",
  reject: "拒绝（不公开）",
  hide: "隐藏",
  unhide: "恢复公开",
  suspend: "停用账号",
  reinstate: "恢复账号",
  set_publication_policy: "切换发布模式",
  delete_body: "删除正文",
  remove_thread: "移除整帖",
};

/** Past-tense receipts for a completed comment action. */
export const doneLabels: Record<CommentModerationAction, string> = {
  approve: "已通过并公开",
  reject: "已拒绝，未公开",
  hide: "已隐藏",
  unhide: "已恢复公开",
};

export const subjectKindLabels: Record<ModerationEventSubjectKind, string> = {
  comment: "根评论",
  reply: "回复",
  user: "账号",
  setting: "发布设置",
};

export const policyLabels: Record<PublicationPolicy, string> = {
  DIRECT_PUBLICATION: "直接发布",
  PRE_MODERATION: "先审后发",
};

export const policyDescriptions: Record<PublicationPolicy, string> = {
  DIRECT_PUBLICATION: "新评论与回复通过校验后立即公开；Owner 仍可随时隐藏。",
  PRE_MODERATION: "新评论与回复进入待审核；只有 Owner 通过后才会公开。",
};

/** The work publication policy: independent of the comment policy, prospective only. */
export const workPolicyDescriptions: Record<PublicationPolicy, string> = {
  DIRECT_PUBLICATION:
    "作者明确提交并选择公开的作品版本通过校验后立即公开；Owner 仍可随时隐藏或移除作品。",
  PRE_MODERATION:
    "作者明确提交并选择公开的作品版本进入「作品提交审核」；通过前，其他人只能看到该作品上一次公开的版本，新作品则暂不可见。",
};

export const submissionStateLabels: Record<WorkSubmissionQueueState, string> = {
  pending: "待审核",
  approved: "已通过",
  rejected: "已拒绝",
  superseded: "已被新提交取代",
  withdrawn: "已撤回公开",
};

export const submissionActionLabels: Record<
  WorkSubmissionModerationAction,
  string
> = {
  approve: "通过并公开",
  reject: "拒绝（不公开）",
};

export const submissionDoneLabels: Record<
  WorkSubmissionModerationAction,
  string
> = {
  approve: "已通过并公开",
  reject: "已拒绝，未公开",
};

export const authorshipLabels: Record<
  NonNullable<OperatorWorkSubmission["authorship"]>["kind"],
  string
> = {
  original: "原创",
  copy_practice: "临摹或练习",
  material_sharing: "素材分享",
};

/** Shown when a revision declares no authorship; nothing is presented as 原创 unless declared. */
export const AUTHORSHIP_NOT_SET = "未设置";

export const authorshipLabel = (
  authorship: OperatorWorkSubmission["authorship"],
): string =>
  authorship === null ? AUTHORSHIP_NOT_SET : authorshipLabels[authorship.kind];

export const workStateLabels: Record<
  OperatorWorkSubmission["workState"],
  string
> = {
  visible: "作品可见",
  hidden: "作品已隐藏",
  removed: "作品已移除",
};

export const qualityModeLabels: Record<
  OperatorWorkSubmission["items"][number]["qualityMode"],
  string
> = {
  standard: "标准",
  original: "原图",
  legacy: "早期作品图片",
};

export const mediaStateLabels: Record<
  OperatorWorkSubmission["items"][number]["state"],
  string
> = {
  awaiting_upload: "等待上传",
  processing: "处理中",
  ready: "已就绪",
  failed: "失败",
  cancelled: "已取消",
  purged: "已清除",
};

export const capacityClassLabels: Record<AccountCapacityClass, string> = {
  ordinary: "普通账号",
  owner: "Owner 账号",
};

export const jobKindLabels: Record<PublishingJobKind, string> = {
  process_item: "处理媒体",
  derive_edit: "生成编辑后的衍生图",
  purge_item: "清除媒体项",
  purge_blob: "清除媒体文件",
  expire_session: "结束过期临时会话",
  purge_trashed_work: "清除回收站作品",
  sweep_staging: "清理上传暂存",
  reconcile_capacity: "核对账号容量",
  catalog_render: "生成图录衍生图",
  publish_media: "发布媒体",
  withdraw_media: "撤回公开媒体",
  verify_withdrawal: "核验媒体撤回",
  reconcile_publication: "核对公开媒体",
  sweep_published: "清理历史公开媒体",
};

export const jobStateLabels: Record<PublishingJobState, string> = {
  queued: "排队中",
  running: "运行中",
  succeeded: "已完成",
  failed: "已失败",
  abandoned: "已放弃",
};

/**
 * The same-origin relay for one derivative of one submission item. Every
 * segment comes from a contract-checked descriptor and is encoded once.
 */
export const workSubmissionMediaSrc = (
  revisionId: string,
  itemId: string,
  variant: OperatorWorkSubmission["items"][number]["variants"][number],
  editKey: string,
): string =>
  `/api/community-moderation/work-submission-media/${encodeURIComponent(revisionId)}/${encodeURIComponent(itemId)}/${encodeURIComponent(variant)}/${encodeURIComponent(editKey)}`;

/** The UI-only placeholder for an empty title; storage keeps it empty. */
export const UNTITLED_WORK = "未命名作品";

/** The title the operator sees for a work: the latest submission's, else the public one, else the placeholder. */
export const workTitleOf = (item: {
  readonly title: string;
  readonly latestSubmission?: { readonly title: string } | null | undefined;
}): string => item.latestSubmission?.title || item.title || UNTITLED_WORK;

/** Action phrases for a work management change, as the buttons read them. */
export const workActionPhrases: Record<OperatorWork["state"], string> = {
  visible: "解除管理限制",
  hidden: "隐藏作品",
  removed: "移除作品",
};

/** Which comment actions a stored state allows; nothing else is offered. */
export const applicableActions = (
  state: CommentModerationState,
): readonly CommentModerationAction[] =>
  state === "pending"
    ? ["approve", "reject"]
    : state === "visible"
      ? ["hide"]
      : ["unhide"];

const zone = "Asia/Shanghai";
const human = new Intl.DateTimeFormat("zh-CN", {
  timeZone: zone,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
const precise = new Intl.DateTimeFormat("zh-CN", {
  timeZone: zone,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

/** Beijing time, minute precision, the zone always stated once on the page. */
export const formatTime = (iso: string): string => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : human.format(date);
};

export const formatPreciseTime = (iso: string): string => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : `${precise.format(date)}（北京时间，UTC+8）`;
};

export const TIME_ZONE_NOTE = "时间均为北京时间（UTC+8）";

/** Truncates by code point, so an astral character is never split before the marker. */
export const excerpt = (text: string, length = 80): string => {
  const chars = Array.from(text);
  return chars.length <= length ? text : `${chars.slice(0, length).join("")}…`;
};

export const shortId = (id: string): string =>
  id.length <= 18 ? id : `${id.slice(0, 12)}…${id.slice(-4)}`;

// Exact Article pending/review presentation DTOs; values stay in Owner endpoints.
export type {
  ArticlePendingPage,
  ArticlePendingPreview,
  ArticleModerationResult,
  ModerateArticlePendingCommand,
} from "@moya/contracts/internal/community-operator";
