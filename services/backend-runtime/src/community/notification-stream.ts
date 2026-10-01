import type { CommunitySessionService } from "@moya/api";
import type { ServerResponse } from "node:http";

/** Process-local refresh fan-out. Durable inbox state, not this signal, is truth. */
export class NotificationSignals {
  private readonly listeners = new Set<
    (recipients: readonly string[]) => void
  >();
  subscribe(listener: (recipients: readonly string[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  publish(recipients: readonly string[]): void {
    for (const listener of this.listeners) listener(recipients);
  }
}
interface Client {
  owner: string;
  token: string;
  response: ServerResponse;
  busy: boolean;
  dirty: boolean;
  closed: boolean;
}
export class NotificationStreams {
  private readonly clients = new Set<Client>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private unsubscribe: (() => void) | undefined;
  constructor(
    private readonly sessions: CommunitySessionService,
    private readonly signals: NotificationSignals,
  ) {}
  changed(owner: string): void {
    this.signals.publish([owner]);
  }
  open(owner: string, token: string, response: ServerResponse): boolean {
    if (
      this.clients.size >= 100 ||
      [...this.clients].filter((c) => c.owner === owner).length >= 4
    )
      return false;
    const client: Client = {
      owner,
      token,
      response,
      busy: false,
      dirty: false,
      closed: false,
    };
    this.clients.add(client);
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "private, no-store, no-transform",
      vary: "Authorization",
      "x-accel-buffering": "no",
      "x-content-type-options": "nosniff",
    });
    response.flushHeaders();
    response.once("close", () => this.remove(client));
    if (!this.timer) {
      this.timer = setInterval(() => {
        for (const c of this.clients) void this.signal(c);
      }, 15_000);
      this.timer.unref();
      this.unsubscribe = this.signals.subscribe((ids) => {
        const selected = new Set(ids);
        for (const c of this.clients)
          if (selected.has(c.owner)) void this.signal(c);
      });
    }
    void this.signal(client);
    return true;
  }
  private remove(client: Client): void {
    client.closed = true;
    client.token = "";
    this.clients.delete(client);
    if (!this.clients.size) {
      if (this.timer) clearInterval(this.timer);
      this.timer = undefined;
      this.unsubscribe?.();
      this.unsubscribe = undefined;
    }
  }
  private async signal(client: Client): Promise<void> {
    if (client.closed) return;
    if (client.busy) {
      client.dirty = true;
      return;
    }
    client.busy = true;
    try {
      const identified = await this.sessions.identify(client.token);
      if (client.closed) return;
      if (identified?.id !== client.owner) {
        client.response.end();
        this.remove(client);
        return;
      }
      // No counts, excerpts, IDs or Session value in this lightweight signal.
      if (!client.response.write("event: refresh\ndata: {}\n\n")) {
        client.response.end();
        this.remove(client);
      }
    } catch {
      client.response.end();
      this.remove(client);
    } finally {
      client.busy = false;
      if (client.dirty && !client.closed) {
        client.dirty = false;
        void this.signal(client);
      }
    }
  }
}
