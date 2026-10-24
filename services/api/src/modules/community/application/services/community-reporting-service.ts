import { createHash } from "node:crypto";
import {
  operatorReportDecisionRequestSchema,
  operatorReportReviewRequestSchema,
  operatorReportMetadataRequestSchema,
  operatorReportForwardRequestSchema,
  operatorReportQuerySchema,
} from "@moya/contracts/internal/community-operator";
import type {
  CommunityReportEvidenceUploadRequest,
  CreateCommunityReportRequest,
  CommunityReportMaterialRequest,
  CommunityReportAppealRequest,
} from "@moya/contracts";
import type {
  CommunityReportingPort,
  CommunityReportingEvidenceStore,
} from "../ports/community-reporting-port.js";
import {
  CommunityInputError,
  CommunityNotFoundError,
} from "../errors/community-request-errors.js";

/** The Backend owns validation, identity separation, and private evidence access. */
export class CommunityReportingService {
  private readonly operator: string;
  constructor(
    private readonly port: CommunityReportingPort,
    private readonly options: {
      readonly evidenceStore?: CommunityReportingEvidenceStore;
      readonly operatorLabel?: string;
    } = {},
  ) {
    this.operator = options.operatorLabel ?? "owner";
    if (!/^[a-z][a-z0-9-]{0,63}$/u.test(this.operator))
      throw new Error("Invalid reporting operator identity");
  }
  private parse<T>(schema: { parse(value: unknown): T }, body: unknown): T {
    try {
      return schema.parse(body);
    } catch {
      throw new CommunityInputError("Reporting request is invalid");
    }
  }
  private pagination(page: number, pageSize: number) {
    if (
      !Number.isSafeInteger(page) ||
      page < 1 ||
      page > 100000 ||
      !Number.isSafeInteger(pageSize) ||
      pageSize < 1 ||
      pageSize > 100
    )
      throw new CommunityInputError("Invalid reporting page");
  }
  create(actor: string, command: CreateCommunityReportRequest) {
    return this.port.create(actor, command);
  }
  listOwn(actor: string, page = 1, pageSize = 20) {
    this.pagination(page, pageSize);
    return this.port.listOwn(actor, page, pageSize);
  }
  readOwn(actor: string, id: string) {
    return this.port.readOwn(actor, id);
  }
  addMaterial(
    actor: string,
    id: string,
    command: CommunityReportMaterialRequest,
  ) {
    return this.port.addMaterial(actor, id, command);
  }
  decisions(actor: string, page = 1, pageSize = 20) {
    this.pagination(page, pageSize);
    return this.port.decisions(actor, page, pageSize);
  }
  appeal(
    actor: string,
    decisionId: string,
    command: CommunityReportAppealRequest,
  ) {
    return this.port.appeal(actor, decisionId, command);
  }
  statement(
    actor: string,
    id: string,
    command: CommunityReportMaterialRequest,
  ) {
    return this.port.statement(actor, id, command);
  }
  operatorList(query: unknown) {
    return this.port.operatorList(this.parse(operatorReportQuerySchema, query));
  }
  operatorRead(id: string) {
    return this.port.operatorRead(id);
  }
  decide(id: string, body: unknown) {
    return this.port.decide(
      this.operator,
      id,
      this.parse(operatorReportDecisionRequestSchema, body),
    );
  }
  review(id: string, body: unknown) {
    return this.port.review(
      this.operator,
      id,
      this.parse(operatorReportReviewRequestSchema, body),
    );
  }
  metadata(id: string, body: unknown) {
    return this.port.metadata(
      this.operator,
      id,
      this.parse(operatorReportMetadataRequestSchema, body),
    );
  }
  forward(id: string, body: unknown) {
    return this.port.forward(
      this.operator,
      id,
      this.parse(operatorReportForwardRequestSchema, body),
    );
  }
  inbox(actor: string) {
    return this.port.inbox(actor);
  }
  readInbox(actor: string, id: string) {
    return this.port.readInbox(actor, id);
  }
  async uploadEvidence(
    actor: string,
    id: string,
    input: CommunityReportEvidenceUploadRequest,
  ) {
    // Authorize before writing bytes; the store never accepts user-chosen keys.
    await this.port.authorizeEvidence(actor, id);
    const store = this.options.evidenceStore;
    if (!store)
      throw new CommunityInputError("Private evidence storage is unavailable");
    const bytes = this.evidenceBytes(input);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const evidenceId = `evidence-${createHash("sha256").update(`${actor}:${id}:${input.requestId}`).digest("hex").slice(0, 32)}`;
    return this.port.addEvidence(
      actor,
      id,
      {
        id: evidenceId,
        fileName: input.fileName,
        mimeType: input.mimeType,
        size: bytes.length,
        // A caller cannot extend private identity/evidence retention by mislabelling it.
        sensitive: true,
        sha256,
        createdAt: new Date().toISOString(),
        downloadPath: `/v1/community/reports/${encodeURIComponent(id)}/evidence/${evidenceId}`,
      },
      () => store.put({ id: evidenceId, mimeType: input.mimeType, bytes }),
      () => store.delete(evidenceId),
    );
  }
  private evidenceBytes(input: CommunityReportEvidenceUploadRequest): Buffer {
    if (
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
        input.contentBase64,
      )
    )
      throw new CommunityInputError("Invalid evidence encoding");
    const bytes = Buffer.from(input.contentBase64, "base64");
    if (bytes.length < 4 || bytes.length > 8 * 1024 * 1024)
      throw new CommunityInputError("Invalid evidence size");
    const valid =
      input.mimeType === "application/pdf"
        ? bytes.subarray(0, 5).toString("ascii") === "%PDF-"
        : input.mimeType === "image/png"
          ? bytes
              .subarray(0, 8)
              .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
          : input.mimeType === "image/jpeg"
            ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
            : bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
              bytes.subarray(8, 12).toString("ascii") === "WEBP";
    if (!valid)
      throw new CommunityInputError(
        "Evidence format does not match its media type",
      );
    return bytes;
  }
  async evidence(actor: string | null, id: string, evidenceId: string) {
    const metadata = await this.port.evidence(actor, id, evidenceId);
    const file = await this.options.evidenceStore?.read(metadata.id);
    if (
      !file ||
      createHash("sha256").update(file.bytes).digest("hex") !== metadata.sha256
    )
      throw new CommunityNotFoundError();
    return { metadata, bytes: file.bytes };
  }
}
