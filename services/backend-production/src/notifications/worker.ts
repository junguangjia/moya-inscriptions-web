import { randomUUID } from "node:crypto";
import type { BackendApplicationOptions } from "@moya/backend-runtime";
type Port = NonNullable<BackendApplicationOptions["notificationWorkerPort"]>;
/** One small, independent pump per backend process. Never a publishing/media job. */
export class NotificationWorker {
  private stopped = true;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;
  private readonly owner = `notification-worker-${randomUUID()}`;
  constructor(
    private readonly port: Port,
    private readonly publish: (recipients: readonly string[]) => void,
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
        this.schedule(2000);
      });
    }, delay);
    this.timer.unref();
  }
  private async tick(): Promise<void> {
    try {
      const claims = await this.port.claim(this.owner, 20);
      for (const claim of claims) {
        if (this.stopped) break;
        try {
          const recipients = await this.port.project(claim);
          if (recipients.length) this.publish(recipients);
        } catch {
          await this.port.fail(claim);
          console.error("[notification-worker] projection_failed");
        }
      }
    } catch {
      console.error("[notification-worker] pump_unavailable");
    }
  }
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.running;
  }
}
