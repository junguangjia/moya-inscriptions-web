import type {
  CommunityReport,
  CommunityReportEvidence,
  CommunityReportPage,
  CommunityReportTarget,
  CommunityReportingDecision,
  CommunityReportingDecisionPage,
  CommunityReportingInbox,
  CreateCommunityReportRequest,
  CommunityReportMaterialRequest,
  CommunityReportAppealRequest,
} from "@moya/contracts";
import type {
  OperatorReport,
  OperatorReportQuery,
  OperatorReportPage,
  OperatorReportDecisionRequest,
  OperatorReportReviewRequest,
  OperatorReportMetadataRequest,
  OperatorReportForwardRequest,
  ReportingEvidenceWriteOutcome,
} from "@moya/contracts/internal/community-operator";

export interface ReportingEvidenceRecord extends CommunityReportEvidence {
  readonly sha256: string;
}
export interface CommunityReportingPort {
  create(
    actor: string,
    command: CreateCommunityReportRequest,
  ): Promise<CommunityReport>;
  listOwn(
    actor: string,
    page: number,
    pageSize: number,
  ): Promise<CommunityReportPage>;
  readOwn(actor: string, id: string): Promise<CommunityReport>;
  addMaterial(
    actor: string,
    id: string,
    command: CommunityReportMaterialRequest,
  ): Promise<CommunityReport>;
  decisions(
    actor: string,
    page: number,
    pageSize: number,
  ): Promise<CommunityReportingDecisionPage>;
  appeal(
    actor: string,
    decisionId: string,
    command: CommunityReportAppealRequest,
  ): Promise<CommunityReportingDecision>;
  statement(
    actor: string,
    id: string,
    command: CommunityReportMaterialRequest,
  ): Promise<CommunityReportingDecision>;
  authorizeEvidence(actor: string, id: string): Promise<void>;
  addEvidence(
    actor: string,
    id: string,
    evidence: ReportingEvidenceRecord,
    persist: () => Promise<void | ReportingEvidenceWriteOutcome>,
    remove: () => Promise<void>,
  ): Promise<CommunityReportEvidence>;
  evidence(
    actor: string | null,
    id: string,
    evidenceId: string,
  ): Promise<ReportingEvidenceRecord>;
  operatorList(query: OperatorReportQuery): Promise<OperatorReportPage>;
  operatorRead(id: string): Promise<OperatorReport>;
  decide(
    operator: string,
    id: string,
    command: OperatorReportDecisionRequest,
  ): Promise<OperatorReport>;
  review(
    operator: string,
    id: string,
    command: OperatorReportReviewRequest,
  ): Promise<OperatorReport>;
  metadata(
    operator: string,
    id: string,
    command: OperatorReportMetadataRequest,
  ): Promise<OperatorReport>;
  forward(
    operator: string,
    id: string,
    command: OperatorReportForwardRequest,
  ): Promise<OperatorReport>;
  inbox(actor: string): Promise<CommunityReportingInbox>;
  readInbox(actor: string, id: string): Promise<void>;
}
export interface CommunityReportingEvidenceStore {
  put(input: {
    readonly id: string;
    readonly mimeType: string;
    readonly bytes: Uint8Array;
  }): Promise<void | ReportingEvidenceWriteOutcome>;
  read(
    id: string,
  ): Promise<{ readonly bytes: Uint8Array; readonly mimeType: string } | null>;
  delete(id: string): Promise<void>;
}
export interface ReportingResolvedTarget {
  readonly canonicalPath: string;
  readonly affectedUserId: string | null;
  readonly snapshot: Record<string, unknown>;
}
export type ReportingExternalTargetResolver = (
  target: CommunityReportTarget,
  actor: string,
) => Promise<ReportingResolvedTarget | null>;
