/** Reporting is authenticated; private staff operations are intentionally excluded. */
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (name: string) => ({ "application/json": { schema: ref(name) } });
const path = (name: string) => ({
  name,
  in: "path",
  required: true,
  schema: { type: "string", minLength: 1, maxLength: 128 },
});
const pagination = [
  {
    name: "page",
    in: "query",
    schema: { type: "integer", minimum: 1, maximum: 100000 },
  },
  {
    name: "pageSize",
    in: "query",
    schema: { type: "integer", minimum: 1, maximum: 100 },
  },
];
const op = (
  operationId: string,
  result: string,
  input?: string,
  parameters: unknown[] = [],
  success = "200",
) => ({
  operationId,
  tags: ["CommunityReporting"],
  security: [{ session: [] }],
  parameters,
  description:
    "Private, no-store. Reporter reads expose only their own report and evidence. Affected users read only their decision, appeal and deliberately forwarded material. Restricted appeal sessions cannot create reports or add reporter supplements. Request identities are bound to the authenticated account.",
  ...(input ? { requestBody: { required: true, content: json(input) } } : {}),
  responses: {
    [success]: {
      description: "Committed private result",
      content: json(result),
    },
    "401": {
      description: "A valid session is required",
      content: json("ApiError"),
    },
    "404": {
      description: "Unavailable or foreign-owned case or evidence",
      content: json("ApiError"),
    },
    "409": {
      description: "Case changed or request identity was reused",
      content: json("ApiError"),
    },
    "422": {
      description: "Invalid bounded input or forbidden target/action",
      content: json("ApiError"),
    },
    "503": {
      description: "Infrastructure is unavailable",
      content: json("ApiError"),
    },
  },
});
const reports = "/v1/community/reports",
  one = `${reports}/{caseId}`;
const evidence = op(
  "readPrivateReportEvidence",
  "CommunityReportEvidence",
  undefined,
  [path("caseId"), path("evidenceId")],
);
const binaryEvidence = {
  ...evidence,
  responses: {
    ...evidence.responses,
    "200": {
      description: "Private authenticated attachment with nosniff and no-store",
      content: Object.fromEntries(
        ["image/jpeg", "image/png", "image/webp", "application/pdf"].map(
          (type) => [type, { schema: { type: "string", format: "binary" } }],
        ),
      ),
    },
  },
};
export const reportingPaths: Record<string, unknown> = {
  [reports]: {
    get: op("listOwnReports", "CommunityReportPage", undefined, pagination),
    post: op(
      "createReport",
      "CommunityReport",
      "CreateCommunityReportRequest",
      [],
      "201",
    ),
  },
  [one]: {
    get: op("readOwnReport", "CommunityReport", undefined, [path("caseId")]),
  },
  [`${one}/materials`]: {
    post: op(
      "supplementOwnReport",
      "CommunityReport",
      "CommunityReportMaterialRequest",
      [path("caseId")],
    ),
  },
  [`${one}/statements`]: {
    post: op(
      "submitRightsStatement",
      "CommunityReportingDecision",
      "CommunityReportMaterialRequest",
      [path("caseId")],
    ),
  },
  [`${one}/evidence`]: {
    post: op(
      "uploadPrivateReportEvidence",
      "CommunityReportEvidence",
      "CommunityReportEvidenceUploadRequest",
      [path("caseId")],
      "201",
    ),
  },
  [`${one}/evidence/{evidenceId}`]: { get: binaryEvidence },
  "/v1/community/decisions": {
    get: op(
      "listOwnReportingDecisions",
      "CommunityReportingDecisionPage",
      undefined,
      pagination,
    ),
  },
  "/v1/community/decisions/{decisionId}/appeals": {
    post: op(
      "appealReportingDecision",
      "CommunityReportingDecision",
      "CommunityReportAppealRequest",
      [path("decisionId")],
    ),
  },
  "/v1/community/reporting-inbox": {
    get: op("readReportingInbox", "CommunityReportingInbox"),
  },
  "/v1/community/reporting-inbox/{messageId}/read": {
    post: op("markReportingMessageRead", "ReportingReadResult", undefined, [
      path("messageId"),
    ]),
  },
};
