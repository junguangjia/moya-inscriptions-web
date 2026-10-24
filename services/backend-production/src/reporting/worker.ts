import type { PostgresCommunityReportingAdapter } from "@moya/community-postgres";
import type { PrivateReportingEvidenceStore } from "./evidence-store.js";
import type { TencentSesConfiguration } from "../auth/config.js";
import { signTencentSes } from "../auth/signing.js";
import { sendProviderRequest } from "../auth/transport.js";
import type { ProviderTransport } from "../auth/transport.js";

export const createUrgentReportSender = (
  email: TencentSesConfiguration | null,
  recipient: string | undefined,
  template: string | undefined,
  transport: ProviderTransport = sendProviderRequest,
) => {
  const configured =
    email !== null &&
    recipient !== undefined &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(recipient) &&
    /^\d+$/u.test(template ?? "") &&
    Number(template) > 0;
  return async (caseId: string): Promise<void> => {
    if (!configured || !email || !/^report-[0-9a-f]{32}$/u.test(caseId))
      throw new Error("REPORT_URGENT_DELIVERY_NOT_CONFIGURED");
    const body = JSON.stringify({
      FromEmailAddress: email.from,
      Destination: [recipient],
      Subject: "社区紧急举报待处理",
      Template: {
        TemplateID: Number(template),
        TemplateData: JSON.stringify({
          case_id: caseId,
          admin_path: "/admin/community-moderation/reports",
        }),
      },
    });
    const response = await transport(signTencentSes(email, body, new Date()));
    if (
      response.status < 200 ||
      response.status >= 300 ||
      response.body.length > 65_536
    )
      throw new Error("REPORT_URGENT_DELIVERY_FAILED");
    let parsed: unknown;
    try {
      parsed = JSON.parse(response.body);
    } catch {
      throw new Error("REPORT_URGENT_DELIVERY_FAILED");
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("Response" in parsed)
    )
      throw new Error("REPORT_URGENT_DELIVERY_FAILED");
    const result = parsed.Response;
    if (
      typeof result !== "object" ||
      result === null ||
      "Error" in result ||
      !("MessageId" in result) ||
      typeof result.MessageId !== "string"
    )
      throw new Error("REPORT_URGENT_DELIVERY_FAILED");
  };
};
export class ReportingMaintenanceWorker {
  private stopped = true;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;
  private lastRetention = 0;
  constructor(
    private readonly adapter: PostgresCommunityReportingAdapter,
    private readonly send: (caseId: string) => Promise<void>,
    private readonly evidence?: PrivateReportingEvidenceStore,
  ) {}
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(0);
  }
  private schedule(delay: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.running = this.tick().finally(() => {
        this.running = undefined;
        this.schedule(5000);
      });
    }, delay);
    this.timer.unref();
  }
  private async tick(): Promise<void> {
    try {
      for (const claim of await this.adapter.claimUrgent(10)) {
        if (this.stopped) break;
        try {
          await this.send(claim.caseId);
          await this.adapter.completeUrgent(claim.id, claim.attempt);
        } catch {
          await this.adapter.failUrgent(claim.id, claim.attempt);
        }
      }
    } catch {
      console.error("[reporting] urgent_queue_unavailable");
    }
    if (Date.now() - this.lastRetention < 60 * 60 * 1000) return;
    this.lastRetention = Date.now();
    try {
      if (this.evidence)
        await this.adapter.purgeExpiredEvidence(
          (id) => this.evidence!.delete(id),
          20,
        );
      await this.adapter.purgeExpiredCases(20);
    } catch {
      console.error("[reporting] retention_unavailable");
    }
  }
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.running;
  }
}
