import { createHash, randomUUID } from "node:crypto";
import {
  CommunityConflictError,
  CommunityInputError,
  CommunityNotFoundError,
} from "@moya/api";
import type {
  CommunityReportingPort,
  ReportingEvidenceRecord,
  ReportingExternalTargetResolver,
  ReportingResolvedTarget,
} from "@moya/api";
import {
  communityReportSchema,
  communityReportingDecisionSchema,
} from "@moya/contracts/schemas";
import type {
  CommunityReport,
  CommunityReportTarget,
  CreateCommunityReportRequest,
  CommunityReportMaterialRequest,
  CommunityReportAppealRequest,
  CommunityReportAction,
  CommunityReportEvidence,
} from "@moya/contracts";
import { operatorReportSchema } from "@moya/contracts/internal/community-operator";
import type {
  OperatorReport,
  OperatorReportQuery,
  OperatorReportDecisionRequest,
  OperatorReportReviewRequest,
  OperatorReportMetadataRequest,
  OperatorReportForwardRequest,
} from "@moya/contracts/internal/community-operator";
import type { Pool, PoolClient } from "pg";
import { asCommunityOperationError } from "./availability.js";
import {
  beginWorkPublicationSync,
  syncWorkHolds,
  beginArticlePublicationSync,
  requestOwnerPublicationSync,
} from "./publishing/publication-sync.js";
import type { PublicationSyncOptions } from "./publishing/publication-sync.js";

const opaque = (prefix: string) =>
  `${prefix}-${randomUUID().replaceAll("-", "")}`;
const publicEvidence = (
  e: ReportingEvidenceRecord,
): CommunityReportEvidence => ({
  id: e.id,
  fileName: e.fileName,
  mimeType: e.mimeType,
  size: e.size,
  sensitive: e.sensitive,
  createdAt: e.createdAt,
  downloadPath: e.downloadPath,
});
const iso = (v: Date | string) => new Date(v).toISOString();
interface CaseRow {
  id: string;
  reporter_id: string | null;
  target_type: CommunityReportTarget["type"];
  target_id: string;
  canonical_path: string;
  affected_user_id: string | null;
  snapshot: Record<string, unknown>;
  kind: CommunityReport["kind"];
  reason: CommunityReport["reason"];
  description: string;
  claimant: OperatorReport["claimant"];
  status: CommunityReport["status"];
  urgent: boolean;
  legal_hold: boolean;
  version: number;
  decision_id: string | null;
  created_at: Date;
  updated_at: Date;
}
interface DecisionRow {
  id: string;
  case_id: string;
  action: CommunityReportAction;
  reason: string;
  created_at: Date;
  reversed_at: Date | null;
  review_reason: string | null;
  appeal_text: string | null;
  appeal_at: Date | null;
  appeal_status: "pending" | "upheld" | "overturned" | null;
  restriction_key: string | null;
}
interface EvidenceRow {
  id: string;
  file_name: string;
  mime_type: string;
  byte_size: number;
  sensitive: boolean;
  sha256: string;
  created_at: Date;
}
interface Subject {
  table: string;
  kind: string;
  id: string;
  column: string;
  hidden: unknown;
}
/** A single transaction owns each command, its audit, and durable private messages. */
export class PostgresCommunityReportingAdapter implements CommunityReportingPort {
  constructor(
    private readonly pool: Pool,
    private readonly options: {
      readonly resolveExternalTarget?: ReportingExternalTargetResolver;
      readonly publication?: PublicationSyncOptions;
    } = {},
  ) {}
  private async tx<T>(fn: (db: PoolClient) => Promise<T>): Promise<T> {
    const db = await this.pool.connect().catch((e: unknown) => {
      throw asCommunityOperationError(e, "connect");
    });
    try {
      await db.query("BEGIN");
      await db.query("SET LOCAL statement_timeout='8s'");
      const out = await fn(db);
      await db.query("COMMIT");
      return out;
    } catch (e) {
      await db.query("ROLLBACK").catch(() => undefined);
      throw asCommunityOperationError(e, "query");
    } finally {
      db.release();
    }
  }
  private async active(db: PoolClient, actor: string) {
    if (
      (
        await db.query(
          "SELECT id FROM community.public_users WHERE id=$1 AND status='active' FOR NO KEY UPDATE",
          [actor],
        )
      ).rowCount !== 1
    )
      throw new CommunityNotFoundError();
  }
  private async receipt<T>(
    db: PoolClient,
    actor: string,
    requestId: string,
    input: unknown,
    run: () => Promise<T>,
  ): Promise<T> {
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,326))", [
      `${actor}:${requestId}`,
    ]);
    const hash = createHash("sha256")
      .update(JSON.stringify(input))
      .digest("hex");
    const old = (
      await db.query<{ fingerprint: string; result: T }>(
        "SELECT fingerprint,result FROM community.report_receipts WHERE actor_id=$1 AND request_id=$2",
        [actor, requestId],
      )
    ).rows[0];
    if (old) {
      if (old.fingerprint !== hash)
        throw new CommunityConflictError("Request identity was reused");
      if (
        typeof old.result === "object" &&
        old.result !== null &&
        "retentionRedacted" in old.result &&
        old.result.retentionRedacted === true
      )
        throw new CommunityConflictError("Request receipt expired");
      return old.result;
    }
    const result = await run();
    await db.query(
      "INSERT INTO community.report_receipts(actor_id,request_id,fingerprint,result) VALUES($1,$2,$3,$4::jsonb)",
      [actor, requestId, hash, JSON.stringify(result)],
    );
    return result;
  }
  private async row(
    db: PoolClient,
    id: string,
    lock = false,
  ): Promise<CaseRow> {
    const row = (
      await db.query<CaseRow>(
        `SELECT * FROM community.report_cases WHERE id=$1${lock ? " FOR UPDATE" : ""}`,
        [id],
      )
    ).rows[0];
    if (!row) throw new CommunityNotFoundError();
    return row;
  }
  private async owned(db: PoolClient, actor: string, id: string, lock = false) {
    const row = await this.row(db, id, lock);
    if (row.reporter_id !== actor) throw new CommunityNotFoundError();
    return row;
  }
  private async decision(
    db: PoolClient,
    id: string,
  ): Promise<DecisionRow | null> {
    return (
      (
        await db.query<DecisionRow>(
          "SELECT * FROM community.report_decisions WHERE id=$1",
          [id],
        )
      ).rows[0] ?? null
    );
  }
  private decisionDto(d: DecisionRow) {
    return {
      id: d.id,
      action: d.action,
      reason: d.reason,
      createdAt: iso(d.created_at),
      reversedAt: d.reversed_at ? iso(d.reversed_at) : null,
      reviewReason: d.review_reason,
    };
  }
  private appealDto(d: DecisionRow | null) {
    return d?.appeal_text && d.appeal_at && d.appeal_status
      ? {
          text: d.appeal_text,
          status: d.appeal_status,
          createdAt: iso(d.appeal_at),
        }
      : null;
  }
  private evidenceDto(id: string, e: EvidenceRow): ReportingEvidenceRecord {
    return {
      id: e.id,
      fileName: e.file_name,
      mimeType: e.mime_type,
      size: e.byte_size,
      sensitive: e.sensitive,
      sha256: e.sha256,
      createdAt: iso(e.created_at),
      downloadPath: `/v1/community/reports/${encodeURIComponent(id)}/evidence/${encodeURIComponent(e.id)}`,
    };
  }
  private async messages(db: PoolClient, row: CaseRow, actor: string | null) {
    return (
      await db.query<{
        id: string;
        kind: "notice" | "statement" | "result";
        text: string;
        created_at: Date;
      }>(
        "SELECT id,kind,text,created_at FROM community.report_messages WHERE case_id=$1 AND recipient_id=$2 ORDER BY created_at,id",
        [row.id, actor],
      )
    ).rows.map((m) => ({
      id: m.id,
      kind: m.kind,
      text: m.text,
      createdAt: iso(m.created_at),
    }));
  }
  private async publicDto(
    db: PoolClient,
    row: CaseRow,
  ): Promise<CommunityReport> {
    const d = row.decision_id ? await this.decision(db, row.decision_id) : null;
    const evidence = (
      await db.query<EvidenceRow>(
        "SELECT * FROM community.report_evidence WHERE case_id=$1 AND owner_id=$2 AND state='ready' ORDER BY created_at,id",
        [row.id, row.reporter_id],
      )
    ).rows.map((e) => {
      return publicEvidence(this.evidenceDto(row.id, e));
    });
    return communityReportSchema.parse({
      id: row.id,
      target: { type: row.target_type, id: row.target_id },
      canonicalPath: row.canonical_path,
      kind: row.kind,
      reason: row.reason,
      description: row.description,
      status: row.status,
      urgent: row.urgent,
      version: row.version,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
      decision: d ? this.decisionDto(d) : null,
      appeal: null,
      messages: await this.messages(db, row, row.reporter_id),
      evidence,
    });
  }
  private async affectedDto(db: PoolClient, row: CaseRow) {
    const d = row.decision_id ? await this.decision(db, row.decision_id) : null;
    if (!d) throw new CommunityNotFoundError();
    return communityReportingDecisionSchema.parse({
      caseId: row.id,
      kind: row.kind,
      target: { type: row.target_type, id: row.target_id },
      canonicalPath: row.canonical_path,
      evidence: (
        await db.query<EvidenceRow>(
          "SELECT * FROM community.report_evidence WHERE case_id=$1 AND owner_id=$2 AND state='ready' ORDER BY created_at,id",
          [row.id, row.affected_user_id],
        )
      ).rows.map((e) => {
        return publicEvidence(this.evidenceDto(row.id, e));
      }),
      decision: this.decisionDto(d),
      appeal: this.appealDto(d),
      messages: row.affected_user_id
        ? await this.messages(db, row, row.affected_user_id)
        : [],
    });
  }
  private isOfficial(row: CaseRow): boolean {
    return (
      row.affected_user_id === null &&
      (row.target_type === "catalog" || row.target_type === "article") &&
      row.snapshot["source"] !== "community"
    );
  }
  private async observeOfficial(
    row: CaseRow,
    expected: "unavailable" | "public",
  ) {
    const resolver = this.options.resolveExternalTarget;
    if (!resolver)
      throw new CommunityConflictError(
        "Native editorial publication status cannot be verified",
      );
    // This exact configured published read originally admitted the official
    // target. A missing resolver or thrown read is never proof of removal.
    const current = await resolver(
      { type: row.target_type, id: row.target_id },
      row.reporter_id ?? "",
    );
    if (
      (expected === "unavailable" && current !== null) ||
      (expected === "public" && current === null)
    )
      throw new CommunityConflictError(
        expected === "unavailable"
          ? "Use the native editorial workflow to remove this content before recording its removal"
          : "Native editorial restoration must be public before reversing this record",
      );
    return { status: expected, observedAt: new Date().toISOString() };
  }
  private async recordOfficialObservation(
    db: PoolClient,
    row: CaseRow,
    observation: { status: "unavailable" | "public"; observedAt: string },
  ) {
    await db.query(
      "UPDATE community.report_cases SET snapshot=snapshot||jsonb_build_object('source','official','nativePublicationObservation',$2::jsonb) WHERE id=$1",
      [row.id, JSON.stringify(observation)],
    );
  }
  private async operatorDto(
    db: PoolClient,
    row: CaseRow,
  ): Promise<OperatorReport> {
    const base = await this.publicDto(db, row),
      d = row.decision_id ? await this.decision(db, row.decision_id) : null;
    const materials = (
      await db.query<{
        id: string;
        author_id: string;
        kind: "supplement" | "statement";
        text: string;
        created_at: Date;
      }>(
        "SELECT * FROM community.report_materials WHERE case_id=$1 ORDER BY created_at,id",
        [row.id],
      )
    ).rows.map((m) => ({
      id: m.id,
      authorId: m.author_id,
      kind: m.kind,
      text: m.text,
      createdAt: iso(m.created_at),
    }));
    const history = (
      await db.query<{
        id: string;
        action: string;
        operator_label: string;
        reason: string;
        occurred_at: Date;
      }>(
        "SELECT * FROM community.report_audit WHERE case_id=$1 ORDER BY occurred_at,id",
        [row.id],
      )
    ).rows.map((a) => ({
      id: a.id,
      action: a.action,
      operator: a.operator_label,
      reason: a.reason,
      occurredAt: iso(a.occurred_at),
    }));
    const failures = (
      await db.query<{ n: number }>(
        "SELECT count(*)::integer AS n FROM community.report_urgent_outbox WHERE case_id=$1 AND delivered_at IS NULL AND last_error IS NOT NULL",
        [row.id],
      )
    ).rows[0]!.n;
    const allowedActions: CommunityReportAction[] = ["retain"];
    if (
      ["work", "comment", "thread"].includes(row.target_type) ||
      (row.target_type === "article" &&
        row.snapshot["source"] === "community") ||
      (this.isOfficial(row) && this.options.resolveExternalTarget !== undefined)
    )
      allowedActions.push("hide");
    if (row.affected_user_id)
      allowedActions.push("warn", "restrict_comments", "suspend");
    const allEvidence = (
      await db.query<EvidenceRow>(
        "SELECT * FROM community.report_evidence WHERE case_id=$1 AND state='ready' ORDER BY created_at,id",
        [row.id],
      )
    ).rows.map((e) => {
      return publicEvidence(this.evidenceDto(row.id, e));
    });
    return operatorReportSchema.parse({
      ...base,
      evidence: allEvidence,
      appeal: this.appealDto(d),
      allowedActions,
      reporterId: row.reporter_id,
      affectedUserId: row.affected_user_id,
      legalHold: row.legal_hold,
      snapshot: row.snapshot,
      claimant: row.claimant,
      materials,
      history,
      notificationFailures: failures,
    });
  }
  private async resolve(
    db: PoolClient,
    target: CommunityReportTarget,
    actor: string,
  ): Promise<ReportingResolvedTarget | null> {
    const id = target.id;
    if (target.type === "work") {
      const w = (
        await db.query<{ author_id: string; title: string; text: string }>(
          "SELECT w.author_id,w.title,w.text FROM community.works w JOIN community.public_users u ON u.id=w.author_id WHERE w.id=$1 AND community.work_is_public(w) AND u.status='active' AND community.accounts_can_interact($2,w.author_id) FOR SHARE OF w",
          [id, actor],
        )
      ).rows[0];
      return w
        ? {
            canonicalPath: `/?workId=${encodeURIComponent(id)}#detail`,
            affectedUserId: w.author_id,
            snapshot: { title: w.title, text: w.text, authorId: w.author_id },
          }
        : null;
    }
    if (target.type === "user") {
      const u = (
        await db.query<{ display_name: string; handle: string }>(
          "SELECT display_name,handle FROM community.public_users WHERE id=$1 AND status='active' AND community.accounts_can_interact($2,id)",
          [id, actor],
        )
      ).rows[0];
      return u
        ? {
            canonicalPath: `/?authorId=${encodeURIComponent(id)}#profile`,
            affectedUserId: id,
            snapshot: { displayName: u.display_name, handle: u.handle },
          }
        : null;
    }
    if (target.type === "thread") {
      const t = (
        await db.query<{ title: string; description: string }>(
          "SELECT title,description FROM community.threads WHERE id=$1 AND hidden_at IS NULL FOR SHARE",
          [id],
        )
      ).rows[0];
      return t
        ? {
            canonicalPath: `/?topic=${encodeURIComponent(id)}`,
            affectedUserId: null,
            snapshot: t,
          }
        : null;
    }
    if (target.type === "comment") {
      const c = (
        await db.query<{
          id: string;
          author_id: string;
          text: string;
          root_id: string;
          parent_text: string | null;
          parent_author: string | null;
          target_type: CommunityReportTarget["type"];
          target_id: string;
        }>(
          `SELECT c.id,c.author_id,c.text,c.id AS root_id,NULL::text AS parent_text,NULL::text AS parent_author,c.target_type,c.catalog_id AS target_id FROM community.catalog_comments c WHERE c.id=$1 AND c.moderation='visible' AND c.body_deleted_at IS NULL AND c.thread_removed_at IS NULL AND community.accounts_can_interact($2,c.author_id)
        UNION ALL SELECT r.id,r.author_id,r.text,c.id,c.text,c.author_id,c.target_type,c.catalog_id FROM community.catalog_comment_replies r JOIN community.catalog_comments c ON c.id=r.root_comment_id WHERE r.id=$1 AND r.moderation='visible' AND r.body_deleted_at IS NULL AND c.moderation='visible' AND c.body_deleted_at IS NULL AND c.thread_removed_at IS NULL AND community.accounts_can_interact($2,r.author_id) AND community.accounts_can_interact($2,c.author_id)`,
          [id, actor],
        )
      ).rows[0];
      if (!c) return null;
      const post = await this.resolve(
        db,
        { type: c.target_type, id: c.target_id },
        actor,
      );
      if (!post) return null;
      return {
        canonicalPath: post.canonicalPath,
        affectedUserId: c.author_id,
        snapshot: {
          text: c.text,
          authorId: c.author_id,
          rootId: c.root_id,
          parent:
            c.parent_text === null
              ? null
              : {
                  id: c.root_id,
                  text: c.parent_text,
                  authorId: c.parent_author,
                },
          post: {
            type: c.target_type,
            id: c.target_id,
            title: post.snapshot["title"],
          },
        },
      };
    }
    if (target.type === "article") {
      const a = (
        await db.query<{ title: string; owner_id: string }>(
          "SELECT a.title,a.owner_id FROM community.article_documents a JOIN community.public_users u ON u.id=a.owner_id WHERE a.id=$1 AND a.published_version IS NOT NULL AND NOT a.reporting_hidden AND u.status='active' AND community.accounts_can_interact($2,a.owner_id) FOR SHARE OF a",
          [id, actor],
        )
      ).rows[0];
      if (a)
        return {
          canonicalPath: `/?topic=${encodeURIComponent(id)}`,
          affectedUserId: a.owner_id,
          snapshot: {
            title: a.title,
            ownerId: a.owner_id,
            source: "community",
          },
        };
    }
    return this.options.resolveExternalTarget?.(target, actor) ?? null;
  }
  async create(actor: string, command: CreateCommunityReportRequest) {
    return this.tx(async (db) => {
      await this.active(db, actor);
      return this.receipt(db, actor, command.requestId, command, async () => {
        await db.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1,327))",
          [`${actor}:${command.target.type}:${command.target.id}`],
        );
        const source =
          command.kind === "rights_notice" && command.sourceCaseId !== undefined
            ? await this.followupSource(
                db,
                actor,
                command.sourceCaseId,
                command.target,
              )
            : null;
        // An open explicit source upgrades in place. A resolved source stays
        // untouched; retries with a fresh request id reuse its distinct open followup.
        const old =
          source !== null &&
          source.status !== "resolved" &&
          source.decision_id === null
            ? source
            : (
                await db.query<CaseRow>(
                  "SELECT * FROM community.report_cases WHERE reporter_id=$1 AND target_type=$2 AND target_id=$3 AND status IN ('open','reviewing','appealed') AND ($4::text IS NULL OR snapshot->>'sourceCaseId'=$4) ORDER BY created_at DESC,id DESC LIMIT 1 FOR UPDATE",
                  [
                    actor,
                    command.target.type,
                    command.target.id,
                    source?.id ?? null,
                  ],
                )
              ).rows[0];
        if (old) {
          if (command.kind === "rights_notice") {
            const claimant = {
              name: command.claimantName,
              contact: command.contact,
              rightsBasis: command.rightsBasis,
            };
            if (old.kind === "rights_notice") {
              if (
                old.description !== command.description ||
                old.claimant?.name !== claimant.name ||
                old.claimant?.contact !== claimant.contact ||
                old.claimant?.rightsBasis !== claimant.rightsBasis
              )
                throw new CommunityConflictError(
                  "A formal notice already exists; add supplemental material to that case",
                );
            } else {
              if (old.description)
                await db.query(
                  "INSERT INTO community.report_materials(id,case_id,author_id,kind,text) VALUES($1,$2,$3,'supplement',$4)",
                  [opaque("material"), old.id, actor, old.description],
                );
              await db.query(
                "UPDATE community.report_cases SET kind='rights_notice',reason='copyright',description=$2,claimant=$3::jsonb,status=CASE WHEN status='appealed' THEN 'appealed' ELSE 'reviewing' END,closed_at=NULL,snapshot=snapshot-'retentionRedacted',version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=$1",
                [old.id, command.description, JSON.stringify(claimant)],
              );
              await this.audit(
                db,
                old.id,
                "reporter",
                "rights_notice_submitted",
                `举报人补充正式权利通知；原举报原因：${old.reason ?? "未提供"}`,
              );
              if (source) {
                await db.query(
                  "UPDATE community.report_cases SET snapshot=snapshot||jsonb_build_object('sourceCaseId',$2::text) WHERE id=$1",
                  [old.id, source.id],
                );
                await this.audit(
                  db,
                  old.id,
                  "reporter",
                  "rights_notice_followup",
                  `来源案件：${source.id}`,
                );
              }
            }
          }
          if (
            command.kind === "standard" &&
            command.reason === "illegal_harmful" &&
            !old.urgent
          )
            await this.markSubmittedUrgent(db, old.id);
          return this.publicDto(db, await this.row(db, old.id));
        }
        const target = source
          ? {
              canonicalPath: source.canonical_path,
              affectedUserId: source.affected_user_id,
              snapshot: { ...source.snapshot, sourceCaseId: source.id },
            }
          : await this.resolve(db, command.target, actor);
        if (!target) throw new CommunityNotFoundError();
        const id = opaque("report");
        const claimant =
          command.kind === "rights_notice"
            ? {
                name: command.claimantName,
                contact: command.contact,
                rightsBasis: command.rightsBasis,
              }
            : null;
        await db.query(
          "INSERT INTO community.report_cases(id,reporter_id,target_type,target_id,canonical_path,affected_user_id,snapshot,kind,reason,description,claimant) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11::jsonb)",
          [
            id,
            actor,
            command.target.type,
            command.target.id,
            target.canonicalPath,
            target.affectedUserId,
            JSON.stringify(target.snapshot),
            command.kind,
            command.kind === "quick_comment" ? null : command.reason,
            command.kind === "quick_comment" ? "" : (command.description ?? ""),
            claimant ? JSON.stringify(claimant) : null,
          ],
        );
        if (source)
          await this.audit(
            db,
            id,
            "reporter",
            "rights_notice_followup",
            `来源案件：${source.id}`,
          );
        if (command.kind === "standard" && command.reason === "illegal_harmful")
          await this.markSubmittedUrgent(db, id);
        return this.publicDto(db, await this.row(db, id));
      });
    });
  }
  private async followupSource(
    db: PoolClient,
    actor: string,
    id: string,
    target: CommunityReportTarget,
  ): Promise<CaseRow> {
    const source = await this.owned(db, actor, id, true);
    if (source.target_type !== target.type || source.target_id !== target.id)
      throw new CommunityNotFoundError();
    const expired =
      (
        await db.query<{ expired: boolean | null }>(
          "SELECT NOT legal_hold AND closed_at<CURRENT_TIMESTAMP-interval '3 years' AS expired FROM community.report_cases WHERE id=$1",
          [id],
        )
      ).rows[0]?.expired === true;
    const snapshot = source.snapshot;
    const retained =
      typeof snapshot === "object" &&
      snapshot !== null &&
      !Array.isArray(snapshot) &&
      snapshot["retentionRedacted"] !== true &&
      snapshot["retentionRedacted"] !== "true" &&
      [snapshot["text"], snapshot["title"], snapshot["displayName"]].some(
        (value) => typeof value === "string",
      );
    if (expired || !retained || !source.canonical_path.startsWith("/"))
      throw new CommunityConflictError(
        "Source case context is no longer retained for a formal followup",
      );
    return source;
  }
  private async markSubmittedUrgent(db: PoolClient, id: string) {
    await db.query(
      "UPDATE community.report_cases SET urgent=true,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=$1",
      [id],
    );
    await db.query(
      "INSERT INTO community.report_urgent_outbox(id,case_id) VALUES($1,$2)",
      [opaque("report-urgent"), id],
    );
    await this.audit(
      db,
      id,
      "reporter",
      "urgent_report_submitted",
      "举报人报告违法有害内容；优先人工核查，不自动处置",
    );
  }
  async listOwn(actor: string, page: number, pageSize: number) {
    return this.tx(async (db) => {
      const rows = (
        await db.query<CaseRow>(
          "SELECT * FROM community.report_cases WHERE reporter_id=$1 ORDER BY created_at DESC,id DESC LIMIT $2 OFFSET $3",
          [actor, pageSize, (page - 1) * pageSize],
        )
      ).rows;
      const count = (
        await db.query<{ n: number }>(
          "SELECT count(*)::integer n FROM community.report_cases WHERE reporter_id=$1",
          [actor],
        )
      ).rows[0]!.n;
      return {
        items: await Promise.all(rows.map((r) => this.publicDto(db, r))),
        total: count,
        page,
        pageSize,
      };
    });
  }
  async readOwn(actor: string, id: string) {
    return this.tx(async (db) =>
      this.publicDto(db, await this.owned(db, actor, id)),
    );
  }
  async addMaterial(
    actor: string,
    id: string,
    command: CommunityReportMaterialRequest,
  ) {
    return this.tx(async (db) => {
      await this.active(db, actor);
      return this.receipt(
        db,
        actor,
        command.requestId,
        { id, ...command },
        async () => {
          const row = await this.owned(db, actor, id, true);
          if (row.status === "resolved")
            throw new CommunityConflictError("Case is closed");
          await db.query(
            "INSERT INTO community.report_materials(id,case_id,author_id,kind,text) VALUES($1,$2,$3,'supplement',$4)",
            [opaque("material"), id, actor, command.text],
          );
          await this.bump(db, id);
          return this.publicDto(db, await this.row(db, id));
        },
      );
    });
  }
  async decisions(actor: string, page: number, pageSize: number) {
    return this.tx(async (db) => {
      const rows = (
        await db.query<CaseRow>(
          "SELECT * FROM community.report_cases WHERE affected_user_id=$1 AND decision_id IS NOT NULL ORDER BY updated_at DESC,id DESC LIMIT $2 OFFSET $3",
          [actor, pageSize, (page - 1) * pageSize],
        )
      ).rows;
      const count = (
        await db.query<{ n: number }>(
          "SELECT count(*)::integer n FROM community.report_cases WHERE affected_user_id=$1 AND decision_id IS NOT NULL",
          [actor],
        )
      ).rows[0]!.n;
      return {
        items: await Promise.all(rows.map((r) => this.affectedDto(db, r))),
        total: count,
        page,
        pageSize,
      };
    });
  }
  async appeal(
    actor: string,
    decisionId: string,
    command: CommunityReportAppealRequest,
  ) {
    return this.tx(async (db) =>
      this.receipt(
        db,
        actor,
        command.requestId,
        { decisionId, ...command },
        async () => {
          const d = await this.decision(db, decisionId);
          if (!d) throw new CommunityNotFoundError();
          const row = await this.row(db, d.case_id, true);
          if (row.affected_user_id !== actor || row.decision_id !== decisionId)
            throw new CommunityNotFoundError();
          if (d.reversed_at || d.appeal_text)
            throw new CommunityConflictError(
              "Decision already reviewed or appealed",
            );
          await db.query(
            "UPDATE community.report_decisions SET appeal_text=$2,appeal_at=CURRENT_TIMESTAMP,appeal_status='pending' WHERE id=$1",
            [decisionId, command.text],
          );
          await db.query(
            "UPDATE community.report_cases SET status='appealed',closed_at=NULL,snapshot=snapshot-'retentionRedacted',version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=$1",
            [row.id],
          );
          return this.affectedDto(db, await this.row(db, row.id));
        },
      ),
    );
  }
  async statement(
    actor: string,
    id: string,
    command: CommunityReportMaterialRequest,
  ) {
    return this.tx(async (db) =>
      this.receipt(
        db,
        actor,
        command.requestId,
        { id, kind: "statement", ...command },
        async () => {
          const row = await this.row(db, id, true);
          if (
            row.affected_user_id !== actor ||
            row.kind !== "rights_notice" ||
            !row.decision_id
          )
            throw new CommunityNotFoundError();
          await db.query(
            "INSERT INTO community.report_materials(id,case_id,author_id,kind,text) VALUES($1,$2,$3,'statement',$4)",
            [opaque("material"), id, actor, command.text],
          );
          await this.reopenForFollowup(db, row);
          return this.affectedDto(db, await this.row(db, id));
        },
      ),
    );
  }
  private async reopenForFollowup(db: PoolClient, row: CaseRow) {
    await db.query(
      "UPDATE community.report_cases SET status=CASE WHEN status='appealed' THEN 'appealed' ELSE 'reviewing' END,closed_at=NULL,snapshot=snapshot-'retentionRedacted',version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=$1",
      [row.id],
    );
  }
  private async canUpload(db: PoolClient, actor: string, id: string) {
    const row = await this.row(db, id, true);
    if (row.reporter_id === actor) {
      await this.active(db, actor);
      if (row.status === "resolved")
        throw new CommunityConflictError("Case is closed");
      return row;
    }
    if (row.affected_user_id !== actor || !row.decision_id)
      throw new CommunityNotFoundError();
    const decision = await this.decision(db, row.decision_id);
    if (decision?.appeal_status !== "pending" && row.kind !== "rights_notice")
      throw new CommunityConflictError(
        "Evidence requires an active appeal or rights statement",
      );
    return row;
  }
  async authorizeEvidence(actor: string, id: string) {
    await this.tx(async (db) => {
      await this.canUpload(db, actor, id);
    });
  }
  async addEvidence(
    actor: string,
    id: string,
    e: ReportingEvidenceRecord,
    persist: () => Promise<void>,
    remove: () => Promise<void>,
  ) {
    const lease = opaque("evidence-upload");
    const reservation = await this.tx(async (db) => {
      await this.canUpload(db, actor, id);
      const old = (
        await db.query<
          EvidenceRow & { state: string; lease_until: Date | null }
        >(
          "SELECT * FROM community.report_evidence WHERE id=$1 AND case_id=$2 AND owner_id=$3 FOR UPDATE",
          [e.id, id, actor],
        )
      ).rows[0];
      if (old) {
        if (
          old.sha256 !== e.sha256 ||
          old.file_name !== e.fileName ||
          old.sensitive !== e.sensitive ||
          old.mime_type !== e.mimeType ||
          old.byte_size !== e.size
        )
          throw new CommunityConflictError("Evidence identity was reused");
        if (old.state === "ready")
          return { ready: publicEvidence(this.evidenceDto(id, old)) };
        if (old.lease_until && old.lease_until.getTime() > Date.now())
          throw new CommunityConflictError(
            "Evidence upload is already in progress",
          );
        await db.query(
          "UPDATE community.report_evidence SET upload_lease=$2,lease_until=CURRENT_TIMESTAMP+interval '2 minutes' WHERE id=$1",
          [e.id, lease],
        );
      } else {
        if (
          (
            await db.query<{ n: number }>(
              "SELECT count(*)::integer n FROM community.report_evidence WHERE case_id=$1",
              [id],
            )
          ).rows[0]!.n >= 10
        )
          throw new CommunityInputError("Evidence limit reached");
        await db.query(
          "INSERT INTO community.report_evidence(id,case_id,owner_id,file_name,mime_type,byte_size,sensitive,sha256,state,upload_lease,lease_until) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9,CURRENT_TIMESTAMP+interval '2 minutes')",
          [
            e.id,
            id,
            actor,
            e.fileName,
            e.mimeType,
            e.size,
            e.sensitive,
            e.sha256,
            lease,
          ],
        );
      }
      return { ready: null };
    });
    if (reservation.ready) return reservation.ready;
    try {
      await persist();
      return await this.tx(async (db) => {
        const row = await this.canUpload(db, actor, id);
        const finalized = (
          await db.query<EvidenceRow>(
            "UPDATE community.report_evidence SET state='ready',upload_lease=NULL,lease_until=NULL WHERE id=$1 AND owner_id=$2 AND state='pending' AND upload_lease=$3 RETURNING *",
            [e.id, actor, lease],
          )
        ).rows[0];
        if (!finalized)
          throw new CommunityConflictError("Evidence upload lease changed");
        if (row.affected_user_id === actor)
          await this.reopenForFollowup(db, row);
        else await this.bump(db, id);
        return publicEvidence(this.evidenceDto(id, finalized));
      });
    } catch (error) {
      // Query committed truth before cleanup: an uncertain successful finalize or
      // another lease's retry must never lose its file. A failed cleanup remains
      // a tracked pending reservation for the maintenance reconciler.
      await this.tx(async (db) => {
        const caseRow = await this.row(db, id, true);
        if (caseRow.legal_hold) return;
        const pending = (
          await db.query(
            "SELECT 1 FROM community.report_evidence WHERE id=$1 AND state='pending' AND upload_lease=$2 FOR UPDATE",
            [e.id, lease],
          )
        ).rowCount;
        if (pending) {
          await remove();
          await db.query(
            "DELETE FROM community.report_evidence WHERE id=$1 AND state='pending' AND upload_lease=$2",
            [e.id, lease],
          );
        }
      }).catch(() => undefined);
      throw error;
    }
  }
  async evidence(actor: string | null, id: string, evidenceId: string) {
    return this.tx(async (db) => {
      const row = await this.row(db, id);
      if (
        actor !== null &&
        row.reporter_id !== actor &&
        row.affected_user_id !== actor
      )
        throw new CommunityNotFoundError();
      const e = (
        await db.query<EvidenceRow>(
          "SELECT * FROM community.report_evidence WHERE id=$1 AND case_id=$2 AND state='ready' AND ($3::text IS NULL OR owner_id=$3)",
          [evidenceId, id, actor],
        )
      ).rows[0];
      if (!e) throw new CommunityNotFoundError();
      return this.evidenceDto(id, e);
    });
  }
  async operatorList(q: OperatorReportQuery) {
    return this.tx(async (db) => {
      const filter =
        "($1::text IS NULL OR status=$1) AND ($2::boolean IS NULL OR urgent=$2)";
      const args = [
        q.status ?? null,
        q.urgent === undefined ? null : q.urgent === "true",
      ];
      const rows = (
        await db.query<CaseRow>(
          `SELECT * FROM community.report_cases WHERE ${filter} ORDER BY urgent DESC,created_at,id LIMIT $3 OFFSET $4`,
          [...args, q.pageSize, (q.page - 1) * q.pageSize],
        )
      ).rows;
      const total = (
        await db.query<{ n: number }>(
          `SELECT count(*)::integer n FROM community.report_cases WHERE ${filter}`,
          args,
        )
      ).rows[0]!.n;
      return {
        items: await Promise.all(rows.map((r) => this.operatorDto(db, r))),
        total,
        page: q.page,
        pageSize: q.pageSize,
      };
    });
  }
  async operatorRead(id: string) {
    return this.tx(async (db) => this.operatorDto(db, await this.row(db, id)));
  }
  private async bump(db: PoolClient, id: string) {
    await db.query(
      "UPDATE community.report_cases SET version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=$1",
      [id],
    );
  }
  private version(row: CaseRow, expected: number) {
    if (row.version !== expected)
      throw new CommunityConflictError("Case changed; reload before deciding");
  }
  private async audit(
    db: PoolClient,
    id: string,
    operator: string,
    action: string,
    reason: string,
  ) {
    await db.query(
      "INSERT INTO community.report_audit(id,case_id,operator_label,action,reason) VALUES($1,$2,$3,$4,$5)",
      [opaque("report-audit"), id, operator, action, reason],
    );
  }
  private async message(
    db: PoolClient,
    row: CaseRow,
    recipient: string | null,
    kind: "notice" | "statement" | "result",
    text: string,
  ) {
    if (recipient)
      await db.query(
        "INSERT INTO community.report_messages(id,case_id,recipient_id,kind,text) VALUES($1,$2,$3,$4,$5)",
        [opaque("report-message"), row.id, recipient, kind, text],
      );
  }
  async decide(operator: string, id: string, c: OperatorReportDecisionRequest) {
    return this.tx(async (db) => {
      const row = await this.row(db, id, true);
      this.version(row, c.expectedVersion);
      if (row.decision_id) {
        const d = await this.decision(db, row.decision_id);
        if (d && !d.reversed_at)
          throw new CommunityConflictError("Case already has a decision");
      }
      const officialHide = c.action === "hide" && this.isOfficial(row);
      const observation = officialHide
        ? await this.observeOfficial(row, "unavailable")
        : null;
      const reason = officialHide
        ? `已核验原编辑流程下架。${c.reason}`
        : c.reason;
      if (reason.length > 2000)
        throw new CommunityInputError(
          "Reason is too long to include native removal verification",
        );
      const allowed = (await this.operatorDto(db, row)).allowedActions;
      if (!allowed.includes(c.action))
        throw new CommunityInputError("Action is unavailable for this target");
      const dId = opaque("report-decision");
      const key = officialHide ? null : await this.restrict(db, row, c.action);
      await db.query(
        "INSERT INTO community.report_decisions(id,case_id,action,reason,operator_label,restriction_key) VALUES($1,$2,$3,$4,$5,$6)",
        [dId, id, c.action, reason, operator, key],
      );
      await db.query(
        "UPDATE community.report_cases SET decision_id=$2,status='resolved',closed_at=CURRENT_TIMESTAMP,snapshot=snapshot-'retentionRedacted',version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=$1",
        [id, dId],
      );
      if (observation)
        await this.recordOfficialObservation(db, row, observation);
      await this.audit(db, id, operator, c.action, reason);
      await this.message(
        db,
        row,
        row.reporter_id,
        "result",
        officialHide ? reason : `举报已处理：${c.action}。${c.reason}`,
      );
      await this.message(
        db,
        row,
        row.affected_user_id,
        "result",
        `处理措施：${c.action}。理由：${c.reason}。可在举报与申诉中申请复核。`,
      );
      return this.operatorDto(db, await this.row(db, id));
    });
  }
  async review(operator: string, id: string, c: OperatorReportReviewRequest) {
    return this.tx(async (db) => {
      const row = await this.row(db, id, true);
      this.version(row, c.expectedVersion);
      const d = row.decision_id
        ? await this.decision(db, row.decision_id)
        : null;
      if (
        !d ||
        d.reversed_at ||
        (c.outcome === "uphold" &&
          d.appeal_status !== "pending" &&
          !(row.kind === "rights_notice" && row.status === "reviewing"))
      )
        throw new CommunityConflictError("No reviewable decision");
      const officialRestore =
        c.outcome === "overturn" && d.action === "hide" && this.isOfficial(row);
      const observation = officialRestore
        ? await this.observeOfficial(row, "public")
        : null;
      const reason = officialRestore
        ? `已核验原编辑流程恢复公开。${c.reason}`
        : row.kind === "moderation" &&
            d.action === "delete_body" &&
            c.outcome === "overturn"
          ? `已纠正处理记录；已删除的正文无法恢复。${c.reason}`
          : c.reason;
      if (reason.length > 2000)
        throw new CommunityInputError(
          "Reason is too long to include native restoration verification",
        );
      if (c.outcome === "overturn" && row.kind === "moderation") {
        if (d.action === "approve" || d.action === "restore")
          throw new CommunityConflictError(
            "Approval and restoration are informational; use the native moderation workflow for a new protective action",
          );
        if (d.action === "reject" && d.restriction_key === null)
          await this.requeueStaffCandidate(db, row);
      }
      if (c.outcome === "overturn") {
        await db.query(
          "UPDATE community.report_decisions SET reversed_at=CURRENT_TIMESTAMP,review_reason=$2,appeal_status=CASE WHEN appeal_text IS NULL THEN NULL ELSE 'overturned' END WHERE id=$1",
          [d.id, reason],
        );
        if (d.restriction_key) await this.release(db, d.restriction_key);
      } else
        await db.query(
          "UPDATE community.report_decisions SET review_reason=$2,appeal_status=CASE WHEN appeal_text IS NULL THEN NULL ELSE 'upheld' END WHERE id=$1",
          [d.id, reason],
        );
      await db.query(
        "UPDATE community.report_cases SET status='resolved',closed_at=CURRENT_TIMESTAMP,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=$1",
        [id],
      );
      if (observation)
        await this.recordOfficialObservation(db, row, observation);
      await this.audit(db, id, operator, c.outcome, reason);
      const remaining =
        c.outcome === "overturn" &&
        d.restriction_key !== null &&
        (
          await db.query(
            "SELECT 1 FROM community.report_decisions WHERE restriction_key=$1 AND reversed_at IS NULL LIMIT 1",
            [d.restriction_key],
          )
        ).rows.length > 0;
      const resultText = officialRestore
        ? reason
        : remaining
          ? `本次决定已撤销；其他有效措施仍在生效。${reason}`
          : `复核结果：${c.outcome}。${reason}`;
      await this.message(db, row, row.reporter_id, "result", resultText);
      await this.message(db, row, row.affected_user_id, "result", resultText);
      return this.operatorDto(db, await this.row(db, id));
    });
  }
  private async requeueStaffCandidate(db: PoolClient, row: CaseRow) {
    const saved = row.snapshot["staffReversal"];
    if (typeof saved !== "object" || saved === null || !("kind" in saved))
      throw new CommunityConflictError(
        "The exact rejected candidate is no longer available",
      );
    if (saved.kind === "work_submission") {
      const g = saved as {
        kind: "work_submission";
        workId: string;
        revisionId: string;
        contentSha256: string;
        revisionVersion: number;
        workVersion: number;
        authorRevisionId: string;
        visibility: string;
        publicRevisionId: string | null;
      };
      if (row.target_type !== "work" || g.workId !== row.target_id)
        throw new CommunityConflictError("Rejected Work target changed");
      const identity = (
        await db.query<{ author_id: string }>(
          "SELECT author_id FROM community.works WHERE id=$1",
          [g.workId],
        )
      ).rows[0];
      if (!identity || identity.author_id !== row.affected_user_id)
        throw new CommunityConflictError("Work ownership changed");
      await db.query(
        "SELECT id FROM community.public_users WHERE id=$1 FOR NO KEY UPDATE",
        [identity.author_id],
      );
      const work = (
        await db.query<{
          version: number;
          author_revision_id: string | null;
          visibility: string;
          public_revision_id: string | null;
          deleted_at: Date | null;
          trashed_at: Date | null;
        }>(
          "SELECT version,author_revision_id,visibility,public_revision_id,deleted_at,trashed_at FROM community.works WHERE id=$1 FOR UPDATE",
          [g.workId],
        )
      ).rows[0];
      const revision = (
        await db.query<{
          version: number;
          disposition: string;
          content_sha256: string;
        }>(
          "SELECT version,disposition,content_sha256 FROM community.work_revisions WHERE id=$1 AND work_id=$2 FOR UPDATE",
          [g.revisionId, g.workId],
        )
      ).rows[0];
      if (
        !work ||
        !revision ||
        work.deleted_at ||
        work.trashed_at ||
        work.version !== g.workVersion ||
        work.author_revision_id !== g.authorRevisionId ||
        g.authorRevisionId !== g.revisionId ||
        work.visibility !== g.visibility ||
        work.visibility !== "public" ||
        work.public_revision_id !== g.publicRevisionId ||
        revision.version !== g.revisionVersion ||
        revision.disposition !== "rejected" ||
        revision.content_sha256 !== g.contentSha256
      )
        throw new CommunityConflictError(
          "The rejected Work candidate or publication intent changed",
        );
      await db.query(
        "UPDATE community.work_revisions SET disposition='pending',decided_at=NULL,decided_by=NULL,version=version+1 WHERE id=$1",
        [g.revisionId],
      );
      return;
    }
    if (saved.kind === "article_submission") {
      const g = saved as {
        kind: "article_submission";
        articleId: string;
        candidateVersion: number;
        fingerprint: string;
        documentVersion: number;
        publicVersion: number | null;
      };
      if (row.target_type !== "article" || g.articleId !== row.target_id)
        throw new CommunityConflictError("Rejected Article target changed");
      const identity = (
        await db.query<{ owner_id: string }>(
          "SELECT owner_id FROM community.article_documents WHERE id=$1",
          [g.articleId],
        )
      ).rows[0];
      if (!identity || identity.owner_id !== row.affected_user_id)
        throw new CommunityConflictError("Article ownership changed");
      await db.query(
        "SELECT id FROM community.public_users WHERE id=$1 FOR NO KEY UPDATE",
        [identity.owner_id],
      );
      const article = (
        await db.query<{
          version: number;
          status: string;
          pending_version: number | null;
          published_version: number | null;
          deleted_at: Date | null;
          fingerprint: string;
        }>(
          "SELECT version,status,pending_version,published_version,deleted_at,fingerprint FROM community.article_documents WHERE id=$1 FOR UPDATE",
          [g.articleId],
        )
      ).rows[0];
      const candidate = (
        await db.query<{ fingerprint: string }>(
          "SELECT fingerprint FROM community.article_revisions WHERE article_id=$1 AND version=$2 AND owner_id=$3",
          [g.articleId, g.candidateVersion, identity.owner_id],
        )
      ).rows[0];
      if (
        !article ||
        !candidate ||
        article.deleted_at ||
        article.version !== g.documentVersion ||
        article.status !== "draft" ||
        article.pending_version !== null ||
        article.published_version !== g.publicVersion ||
        candidate.fingerprint !== g.fingerprint ||
        article.fingerprint !== g.fingerprint
      )
        throw new CommunityConflictError(
          "The rejected Article candidate or publication intent changed",
        );
      await db.query(
        "UPDATE community.article_documents SET status='pending',pending_version=$2,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=$1",
        [g.articleId, g.candidateVersion],
      );
      return;
    }
    throw new CommunityConflictError(
      "This decision requires the native moderation workflow",
    );
  }
  async metadata(
    operator: string,
    id: string,
    c: OperatorReportMetadataRequest,
  ) {
    return this.tx(async (db) => {
      const row = await this.row(db, id, true);
      this.version(row, c.expectedVersion);
      if (c.status && row.decision_id)
        throw new CommunityConflictError(
          "A decided case cannot be reopened without correcting its decision",
        );
      await db.query(
        "UPDATE community.report_cases SET urgent=COALESCE($2,urgent),legal_hold=COALESCE($3,legal_hold),status=COALESCE($4,status),closed_at=CASE WHEN $4::text IS NULL THEN closed_at ELSE NULL END,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=$1",
        [id, c.urgent ?? null, c.legalHold ?? null, c.status ?? null],
      );
      await this.audit(db, id, operator, "metadata", JSON.stringify(c));
      if (c.urgent === true && !row.urgent)
        await db.query(
          "INSERT INTO community.report_urgent_outbox(id,case_id) VALUES($1,$2)",
          [opaque("report-urgent"), id],
        );
      return this.operatorDto(db, await this.row(db, id));
    });
  }
  async forward(operator: string, id: string, c: OperatorReportForwardRequest) {
    return this.tx(async (db) => {
      const row = await this.row(db, id, true);
      this.version(row, c.expectedVersion);
      if (row.kind !== "rights_notice")
        throw new CommunityInputError("Only rights notices may be forwarded");
      if (c.kind === "result" && !this.isOfficial(row))
        throw new CommunityInputError(
          "Platform responses apply to official-content rights cases",
        );
      if (
        c.kind === "statement" &&
        (
          await db.query(
            "SELECT 1 FROM community.report_materials WHERE case_id=$1 AND kind='statement'",
            [id],
          )
        ).rowCount === 0
      )
        throw new CommunityConflictError("No statement was submitted");
      const recipient =
        c.kind === "notice" ? row.affected_user_id : row.reporter_id;
      if (!recipient)
        throw new CommunityInputError("No recipient is available");
      await this.message(db, row, recipient, c.kind, c.text);
      await this.audit(db, id, operator, `forward_${c.kind}`, c.text);
      await this.bump(db, id);
      return this.operatorDto(db, await this.row(db, id));
    });
  }
  async inbox(actor: string) {
    return this.tx(async (db) => ({
      items: (
        await db.query<{
          id: string;
          case_id: string;
          text: string;
          created_at: Date;
          read_at: Date | null;
        }>(
          "SELECT * FROM community.report_messages WHERE recipient_id=$1 ORDER BY created_at DESC,id DESC LIMIT 100",
          [actor],
        )
      ).rows.map((m) => ({
        id: m.id,
        caseId: m.case_id,
        text: m.text,
        createdAt: iso(m.created_at),
        readAt: m.read_at ? iso(m.read_at) : null,
      })),
    }));
  }
  async readInbox(actor: string, id: string) {
    await this.tx(async (db) => {
      if (
        (
          await db.query(
            "UPDATE community.report_messages SET read_at=COALESCE(read_at,CURRENT_TIMESTAMP) WHERE id=$1 AND recipient_id=$2",
            [id, actor],
          )
        ).rowCount !== 1
      )
        throw new CommunityNotFoundError();
    });
  }
  private subject(row: CaseRow, action: CommunityReportAction): Subject | null {
    if (action === "retain" || action === "warn") return null;
    if (action === "suspend" || action === "restrict_comments") {
      if (!row.affected_user_id) throw new CommunityInputError();
      return {
        table: "community.public_users",
        kind: action === "suspend" ? "user_status" : "user_comments",
        id: row.affected_user_id,
        column:
          action === "suspend" ? "status" : "reporting_comments_restricted",
        hidden: action === "suspend" ? "suspended" : true,
      };
    }
    if (row.target_type === "work")
      return {
        table: "community.works",
        kind: "work",
        id: row.target_id,
        column: "operator_state",
        hidden: "hidden",
      };
    if (row.target_type === "comment")
      return {
        table:
          row.snapshot["parent"] === null
            ? "community.catalog_comments"
            : "community.catalog_comment_replies",
        kind: row.snapshot["parent"] === null ? "comment" : "reply",
        id: row.target_id,
        column: "moderation",
        hidden: "hidden",
      };
    if (row.target_type === "thread")
      return {
        table: "community.threads",
        kind: "thread",
        id: row.target_id,
        column: "hidden_at",
        hidden: new Date().toISOString(),
      };
    if (row.target_type === "article" && row.snapshot["source"] === "community")
      return {
        table: "community.article_documents",
        kind: "article",
        id: row.target_id,
        column: "reporting_hidden",
        hidden: true,
      };
    throw new CommunityInputError(
      "This target cannot be hidden by the reporting boundary",
    );
  }
  private subjectFromHead(h: {
    subject_kind: string;
    subject_id: string;
  }): Subject {
    const kind = h.subject_kind,
      id = h.subject_id;
    if (kind === "user_status")
      return {
        table: "community.public_users",
        kind,
        id,
        column: "status",
        hidden: "suspended",
      };
    if (kind === "user_comments")
      return {
        table: "community.public_users",
        kind,
        id,
        column: "reporting_comments_restricted",
        hidden: true,
      };
    if (kind === "work")
      return {
        table: "community.works",
        kind,
        id,
        column: "operator_state",
        hidden: "hidden",
      };
    if (kind === "comment_thread")
      return {
        table: "community.catalog_comments",
        kind,
        id,
        column: "thread_removed_at",
        hidden: new Date().toISOString(),
      };
    if (kind === "comment" || kind === "reply")
      return {
        table:
          kind === "comment"
            ? "community.catalog_comments"
            : "community.catalog_comment_replies",
        kind,
        id,
        column: "moderation",
        hidden: "hidden",
      };
    if (kind === "thread")
      return {
        table: "community.threads",
        kind,
        id,
        column: "hidden_at",
        hidden: new Date().toISOString(),
      };
    if (kind === "article")
      return {
        table: "community.article_documents",
        kind,
        id,
        column: "reporting_hidden",
        hidden: true,
      };
    throw new CommunityInputError("Unknown restriction subject");
  }
  private revisionColumn(s: Subject) {
    return s.kind === "user_comments"
      ? "reporting_comment_revision"
      : s.kind === "comment_thread"
        ? "reporting_thread_revision"
        : "reporting_revision";
  }
  private async writeSubject(db: PoolClient, s: Subject, state: unknown) {
    const now = new Date();
    const sync =
      s.kind === "work"
        ? await beginWorkPublicationSync(db, s.id, this.options.publication)
        : s.kind === "article"
          ? await beginArticlePublicationSync(
              db,
              s.id,
              this.options.publication,
            )
          : null;
    await db.query(
      `UPDATE ${s.table} SET ${s.column}=$2${s.kind === "work" || s.kind === "article" ? ",version=version+1,updated_at=CURRENT_TIMESTAMP" : ""}${s.kind === "comment" || s.kind === "reply" ? ",moderated_at=CURRENT_TIMESTAMP,moderated_by='owner'" : ""} WHERE id=$1`,
      [s.id, state],
    );
    if (s.kind === "user_status") {
      if (state === "suspended")
        await db.query(
          "UPDATE community.sessions SET revoked_at=COALESCE(revoked_at,CURRENT_TIMESTAMP) WHERE user_id=$1",
          [s.id],
        );
      await requestOwnerPublicationSync(
        db,
        s.id,
        state === "active" ? "publish" : "withdraw",
        now,
        this.options.publication,
      );
    }
    const held =
      s.kind === "work"
        ? await syncWorkHolds(db, s.id, state === "removed", now)
        : [];
    await sync?.finish(now, held, state === "removed" ? "withdraw" : "publish");
  }
  private async restrict(
    db: PoolClient,
    row: CaseRow,
    action: CommunityReportAction,
  ): Promise<string | null> {
    const s = this.subject(row, action);
    if (!s) return null;
    const key = `${s.kind}:${s.id}`;
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,328))", [
      key,
    ]);
    if (
      (
        await db.query(
          "SELECT 1 FROM community.report_restriction_heads WHERE restriction_key=$1",
          [key],
        )
      ).rowCount
    )
      return key;
    const state = (
      await db.query<{ state: unknown; revision: string }>(
        `SELECT ${s.column} AS state,${this.revisionColumn(s)}::text AS revision FROM ${s.table} WHERE id=$1 FOR UPDATE`,
        [s.id],
      )
    ).rows[0];
    if (!state) throw new CommunityNotFoundError();
    if (s.kind === "thread" ? state.state === null : state.state !== s.hidden)
      await this.writeSubject(db, s, s.hidden);
    const after = (
      await db.query<{ revision: string }>(
        `SELECT ${this.revisionColumn(s)}::text AS revision FROM ${s.table} WHERE id=$1`,
        [s.id],
      )
    ).rows[0]!;
    await db.query(
      "INSERT INTO community.report_restriction_heads(restriction_key,subject_kind,subject_id,prior_state,applied_revision) VALUES($1,$2,$3,$4::jsonb,$5)",
      [
        key,
        s.kind,
        s.id,
        JSON.stringify({ value: state.state }),
        after.revision,
      ],
    );
    return key;
  }
  private async release(db: PoolClient, key: string) {
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,328))", [
      key,
    ]);
    if (
      (
        await db.query(
          "SELECT 1 FROM community.report_decisions WHERE restriction_key=$1 AND reversed_at IS NULL",
          [key],
        )
      ).rowCount
    )
      return;
    const h = (
      await db.query<{
        subject_kind: string;
        subject_id: string;
        prior_state: { value: unknown };
        applied_revision: string;
      }>(
        "SELECT * FROM community.report_restriction_heads WHERE restriction_key=$1 FOR UPDATE",
        [key],
      )
    ).rows[0];
    if (!h) return;
    const s = this.subjectFromHead(h);
    const current = (
      await db.query<{ revision: string }>(
        `SELECT ${this.revisionColumn(s)}::text AS revision FROM ${s.table} WHERE id=$1 FOR UPDATE`,
        [s.id],
      )
    ).rows[0];
    // A later independent moderation or author deletion invalidates restoration.
    if (current?.revision === String(h.applied_revision))
      await this.writeSubject(db, s, h.prior_state.value);
    await db.query(
      "DELETE FROM community.report_restriction_heads WHERE restriction_key=$1",
      [key],
    );
  }
  async claimUrgent(
    limit = 10,
  ): Promise<readonly { id: string; caseId: string; attempt: number }[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new CommunityInputError();
    return this.tx(async (db) =>
      (
        await db.query<{ id: string; case_id: string; attempts: number }>(
          `WITH ready AS (SELECT o.id FROM community.report_urgent_outbox o JOIN community.report_cases c ON c.id=o.case_id WHERE c.urgent AND o.delivered_at IS NULL AND o.next_attempt_at<=CURRENT_TIMESTAMP AND (o.lease_until IS NULL OR o.lease_until<CURRENT_TIMESTAMP) ORDER BY o.next_attempt_at,o.id LIMIT $1 FOR UPDATE OF o SKIP LOCKED) UPDATE community.report_urgent_outbox o SET attempts=attempts+1,lease_until=CURRENT_TIMESTAMP+interval '2 minutes' FROM ready WHERE o.id=ready.id RETURNING o.id,o.case_id,o.attempts`,
          [limit],
        )
      ).rows.map((r) => ({ id: r.id, caseId: r.case_id, attempt: r.attempts })),
    );
  }
  async completeUrgent(id: string, attempt: number): Promise<void> {
    await this.tx(async (db) => {
      await db.query(
        "UPDATE community.report_urgent_outbox SET delivered_at=CURRENT_TIMESTAMP,lease_until=NULL,last_error=NULL WHERE id=$1 AND attempts=$2 AND delivered_at IS NULL",
        [id, attempt],
      );
    });
  }
  async failUrgent(id: string, attempt: number): Promise<void> {
    await this.tx(async (db) => {
      await db.query(
        "UPDATE community.report_urgent_outbox SET lease_until=NULL,last_error='delivery_failed',next_attempt_at=CURRENT_TIMESTAMP+make_interval(secs=>LEAST(3600,30*power(2,LEAST(attempts,7)))::integer) WHERE id=$1 AND attempts=$2 AND delivered_at IS NULL",
        [id, attempt],
      );
    });
  }
  async purgeExpiredEvidence(
    remove: (evidenceId: string) => Promise<void>,
    limit = 20,
  ): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new CommunityInputError();
    return this.tx(async (db) => {
      const cases = (
        await db.query<{ id: string }>(
          `SELECT c.id FROM community.report_cases c WHERE NOT c.legal_hold AND EXISTS(SELECT 1 FROM community.report_evidence e WHERE e.case_id=c.id AND ((e.state='pending' AND e.lease_until<CURRENT_TIMESTAMP-interval '1 day') OR (e.state='ready' AND c.closed_at<CURRENT_TIMESTAMP-CASE WHEN e.sensitive THEN interval '180 days' ELSE interval '3 years' END))) ORDER BY c.id LIMIT $1 FOR UPDATE OF c SKIP LOCKED`,
          [limit],
        )
      ).rows;
      let count = 0;
      for (const c of cases) {
        const evidence = (
          await db.query<{ id: string }>(
            `SELECT e.id FROM community.report_evidence e JOIN community.report_cases c ON c.id=e.case_id WHERE e.case_id=$1 AND NOT c.legal_hold AND ((e.state='pending' AND e.lease_until<CURRENT_TIMESTAMP-interval '1 day') OR (e.state='ready' AND c.closed_at<CURRENT_TIMESTAMP-CASE WHEN e.sensitive THEN interval '180 days' ELSE interval '3 years' END)) FOR UPDATE OF e`,
            [c.id],
          )
        ).rows;
        for (const e of evidence) {
          await remove(e.id);
          await db.query("DELETE FROM community.report_evidence WHERE id=$1", [
            e.id,
          ]);
          count++;
        }
      }
      return count;
    });
  }
  async purgeExpiredCases(limit = 20): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new CommunityInputError();
    return this.tx(async (db) => {
      const candidates = (
        await db.query<CaseRow & { effective: boolean }>(
          `SELECT c.*,EXISTS(SELECT 1 FROM community.report_decisions d WHERE d.case_id=c.id AND d.restriction_key IS NOT NULL AND d.reversed_at IS NULL) AS effective
         FROM community.report_cases c WHERE NOT c.legal_hold AND c.closed_at<CURRENT_TIMESTAMP-interval '3 years'
         AND NOT EXISTS(SELECT 1 FROM community.report_evidence e WHERE e.case_id=c.id)
         AND (COALESCE(c.snapshot->>'retentionRedacted','false')<>'true' OR NOT EXISTS(SELECT 1 FROM community.report_decisions d WHERE d.case_id=c.id AND d.restriction_key IS NOT NULL AND d.reversed_at IS NULL))
         ORDER BY c.id LIMIT $1 FOR UPDATE OF c SKIP LOCKED`,
          [limit],
        )
      ).rows;
      const expiredText = "详细材料已按保留期限清理";
      for (const row of candidates) {
        // Receipts embed earlier private DTOs, including description and evidence
        // filenames. Never retain or replay those copies after case retention.
        await db.query(
          `UPDATE community.report_receipts SET result='{"retentionRedacted":true}'::jsonb WHERE COALESCE(result->>'id',result->>'caseId')=$1`,
          [row.id],
        );
        if (!row.effective) {
          await db.query("DELETE FROM community.report_cases WHERE id=$1", [
            row.id,
          ]);
          continue;
        }
        const snapshot: Record<string, unknown> = { retentionRedacted: true };
        if (row.snapshot["source"] === "community")
          snapshot["source"] = "community";
        else if (this.isOfficial(row)) snapshot["source"] = "official";
        const observation = row.snapshot["nativePublicationObservation"];
        if (
          typeof observation === "object" &&
          observation !== null &&
          "status" in observation &&
          (observation.status === "unavailable" ||
            observation.status === "public") &&
          "observedAt" in observation &&
          typeof observation.observedAt === "string"
        )
          snapshot["nativePublicationObservation"] = {
            status: observation.status,
            observedAt: observation.observedAt,
          };
        if (
          typeof row.snapshot["sourceCaseId"] === "string" &&
          /^report-[0-9a-f]{32}$/u.test(row.snapshot["sourceCaseId"])
        )
          snapshot["sourceCaseId"] = row.snapshot["sourceCaseId"];
        if (row.target_type === "comment")
          snapshot["parent"] = row.snapshot["parent"] === null ? null : {};
        await db.query(
          `UPDATE community.report_cases SET description='',snapshot=$2::jsonb,claimant=CASE WHEN claimant IS NULL THEN NULL ELSE '{"name":"","contact":"","rightsBasis":""}'::jsonb END,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=$1`,
          [row.id, JSON.stringify(snapshot)],
        );
        await db.query(
          "UPDATE community.report_materials SET text=$2 WHERE case_id=$1",
          [row.id, expiredText],
        );
        await db.query(
          "UPDATE community.report_messages SET text=$2 WHERE case_id=$1",
          [row.id, expiredText],
        );
        await db.query(
          "UPDATE community.report_audit SET reason=$2 WHERE case_id=$1",
          [row.id, expiredText],
        );
        await db.query(
          "UPDATE community.report_decisions SET reason=$2,review_reason=CASE WHEN review_reason IS NULL THEN NULL ELSE $2 END,appeal_text=CASE WHEN appeal_text IS NULL THEN NULL ELSE $2 END WHERE case_id=$1",
          [row.id, expiredText],
        );
      }
      await db.query(
        "DELETE FROM community.report_receipts WHERE created_at<CURRENT_TIMESTAMP-interval '3 years' AND NOT EXISTS(SELECT 1 FROM community.report_cases c WHERE c.id=COALESCE(result->>'id',result->>'caseId') AND c.legal_hold)",
      );
      return candidates.length;
    });
  }
}
