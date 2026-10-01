import type { NotificationPage } from "@moya/contracts";
import { CommunityInputError } from "../errors/community-request-errors.js";
import type {
  NotificationFilter,
  NotificationPort,
} from "../ports/notification-port.js";

interface Observation {
  owner: string;
  purpose: "all" | "group" | "cursor";
  revision: string;
  expires: number;
  group?: string;
  before?: string;
  filter?: NotificationFilter;
}
/** Observation signatures authorize no identity: every operation still requires a Session. */
export class NotificationService {
  private readonly key = crypto.subtle.generateKey(
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  private encode(bytes: Uint8Array): string {
    return btoa(String.fromCharCode(...bytes))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/u, "");
  }
  private decode(value: string): Uint8Array<ArrayBuffer> {
    return Uint8Array.from(
      atob(value.replaceAll("-", "+").replaceAll("_", "/")),
      (c) => c.charCodeAt(0),
    );
  }
  constructor(
    private readonly store: NotificationPort,
    private readonly clock: () => number = Date.now,
  ) {}
  private async sign(value: Omit<Observation, "expires">): Promise<string> {
    const body = this.encode(
      new TextEncoder().encode(
        JSON.stringify({ ...value, expires: this.clock() + 30 * 60_000 }),
      ),
    );
    const signature = await crypto.subtle.sign(
      "HMAC",
      await this.key,
      new TextEncoder().encode(body),
    );
    return `${body}.${this.encode(new Uint8Array(signature))}`;
  }
  private async verify(token: string, owner: string): Promise<Observation> {
    const invalid = () =>
      new CommunityInputError(
        "Notification observation expired or invalid; refresh the inbox",
      );
    if (token.length > 4096) throw invalid();
    const [body, signature, ...rest] = token.split(".");
    if (!body || !signature || rest.length) throw invalid();
    let value: Observation;
    try {
      if (
        !(await crypto.subtle.verify(
          "HMAC",
          await this.key,
          this.decode(signature),
          new TextEncoder().encode(body),
        ))
      )
        throw invalid();
      value = JSON.parse(
        new TextDecoder().decode(this.decode(body)),
      ) as Observation;
    } catch {
      throw invalid();
    }
    if (
      value.owner !== owner ||
      !Number.isFinite(value.expires) ||
      value.expires < this.clock() ||
      !/^(0|[1-9][0-9]{0,18})$/u.test(value.revision)
    )
      throw invalid();
    return value;
  }
  async list(
    owner: string,
    filter: NotificationFilter,
    limit: number,
    cursor?: string,
  ): Promise<NotificationPage> {
    const observation =
      cursor === undefined ? undefined : await this.verify(cursor, owner);
    if (
      observation &&
      (observation.purpose !== "cursor" || observation.filter !== filter)
    )
      throw new CommunityInputError("Invalid notification cursor");
    const page = await this.store.read(owner, {
      filter,
      limit,
      ...(observation
        ? {
            highWater: observation.revision,
            ...(observation.before ? { before: observation.before } : {}),
          }
        : {}),
    });
    const last = page.items.at(-1);
    return {
      items: await Promise.all(
        page.items.map(async ({ revision, ...item }) => ({
          ...item,
          observation: await this.sign({
            owner,
            purpose: "group",
            revision,
            group: item.id,
          }),
        })),
      ),
      observation: await this.sign({
        owner,
        purpose: "all",
        revision: page.highWater,
      }),
      unread: page.unread,
      nextCursor:
        page.hasMore && last
          ? await this.sign({
              owner,
              purpose: "cursor",
              revision: page.highWater,
              before: last.revision,
              filter,
            })
          : null,
    };
  }
  async read(owner: string, token: string): Promise<void> {
    const observed = await this.verify(token, owner);
    if (observed.purpose !== "all" && observed.purpose !== "group")
      throw new CommunityInputError("Invalid read observation");
    await this.store.markRead(
      owner,
      observed.revision,
      observed.purpose === "group" ? observed.group : undefined,
    );
  }
  async lookup(owner: string, query: string) {
    const text = query.trim();
    if (
      [...text].length < 2 ||
      [...text].length > 40 ||
      [...text].some((character) => character.charCodeAt(0) < 32)
    )
      throw new CommunityInputError("Invalid mention lookup");
    return this.store.lookup(owner, text);
  }
}
