import {
  communityReportSchema,
  communityReportPageSchema,
  communityReportEvidenceSchema,
  communityReportingDecisionSchema,
  communityReportingDecisionPageSchema,
  communityReportingInboxSchema,
  createCommunityReportRequestSchema,
  communityReportMaterialRequestSchema,
  communityReportAppealRequestSchema,
  communityReportEvidenceUploadRequestSchema,
} from "@moya/contracts/schemas";
import type {
  CreateCommunityReportRequest,
  CommunityReportMaterialRequest,
  CommunityReportAppealRequest,
  CommunityReportEvidenceUploadRequest,
} from "@moya/contracts";

export class ReportingRequestError extends Error {
  constructor(readonly status: number) {
    super(
      status === 401
        ? "请重新登录后再提交"
        : status === 403
          ? "当前账户无权执行此操作"
          : status === 404
            ? "举报目标已不可用"
            : status === 413
              ? "附件超过大小限制"
              : status === 429
                ? "操作过于频繁，请稍后重试"
                : status === 400 || status === 422
                  ? "请检查填写内容后重试"
                  : "操作未完成，请重试",
    );
  }
}
interface Parser<T> {
  parse: (value: unknown) => T;
}
const request = async <T>(
  account: string,
  path: string,
  parser: Parser<T>,
  body?: unknown,
  signal?: AbortSignal,
  restricted = false,
): Promise<T> => {
  const response = await fetch(`/api/community/${path}`, {
    method: body === undefined ? "GET" : "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: {
      Accept: "application/json",
      "x-author-account": account,
      ...(restricted ? { "x-reporting-session": "appeal" } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(signal === undefined ? {} : { signal }),
  });
  if (!response.ok) throw new ReportingRequestError(response.status);
  return parser.parse(await response.json());
};
const segment = encodeURIComponent;
const caseActions = (restricted: boolean) => ({
  evidence: (
    account: string,
    id: string,
    command: CommunityReportEvidenceUploadRequest,
  ) =>
    request(
      account,
      `reports/${segment(id)}/evidence`,
      communityReportEvidenceSchema,
      communityReportEvidenceUploadRequestSchema.parse(command),
      undefined,
      restricted,
    ),
  decisions: (account: string, page = 1, signal?: AbortSignal) =>
    request(
      account,
      `decisions?page=${page}`,
      communityReportingDecisionPageSchema,
      undefined,
      signal,
      restricted,
    ),
  appeal: (
    account: string,
    id: string,
    command: CommunityReportAppealRequest,
  ) =>
    request(
      account,
      `decisions/${segment(id)}/appeals`,
      communityReportingDecisionSchema,
      communityReportAppealRequestSchema.parse(command),
      undefined,
      restricted,
    ),
  statement: (
    account: string,
    caseId: string,
    command: CommunityReportMaterialRequest,
  ) =>
    request(
      account,
      `reports/${segment(caseId)}/statements`,
      communityReportingDecisionSchema,
      communityReportMaterialRequestSchema.parse(command),
      undefined,
      restricted,
    ),
});
export const reportingClient = {
  ...caseActions(false),
  create: (account: string, command: CreateCommunityReportRequest) =>
    request(
      account,
      "reports",
      communityReportSchema,
      createCommunityReportRequestSchema.parse(command),
    ),
  list: (account: string, page = 1, signal?: AbortSignal) =>
    request(
      account,
      `reports?page=${page}`,
      communityReportPageSchema,
      undefined,
      signal,
    ),
  detail: (account: string, id: string, signal?: AbortSignal) =>
    request(
      account,
      `reports/${segment(id)}`,
      communityReportSchema,
      undefined,
      signal,
    ),
  material: (
    account: string,
    id: string,
    command: CommunityReportMaterialRequest,
  ) =>
    request(
      account,
      `reports/${segment(id)}/materials`,
      communityReportSchema,
      communityReportMaterialRequestSchema.parse(command),
    ),
  inbox: (account: string, signal?: AbortSignal) =>
    request(
      account,
      "reporting-inbox",
      communityReportingInboxSchema,
      undefined,
      signal,
    ),
  read: (account: string, id: string) =>
    request(
      account,
      `reporting-inbox/${segment(id)}/read`,
      { parse: () => undefined },
      {},
    ),
};

export const appealReportingClient = caseActions(true);

export const downloadReportEvidence = async (
  account: string,
  caseId: string,
  evidenceId: string,
  restricted = false,
): Promise<Blob> => {
  const response = await fetch(
    `/api/community/reports/${segment(caseId)}/evidence/${segment(evidenceId)}`,
    {
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        "x-author-account": account,
        ...(restricted ? { "x-reporting-session": "appeal" } : {}),
      },
    },
  );
  if (!response.ok) throw new ReportingRequestError(response.status);
  const type = response.headers.get("content-type")?.split(";")[0];
  if (
    !["image/jpeg", "image/png", "image/webp", "application/pdf"].includes(
      type ?? "",
    )
  )
    throw new Error("附件读取失败");
  const blob = await response.blob();
  if (blob.size > 8 * 1024 * 1024) throw new Error("附件超过大小限制");
  return blob;
};
