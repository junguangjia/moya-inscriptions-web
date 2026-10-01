import { createHash, randomUUID } from "node:crypto";

import {
  CommunityConflictError,
  CommunityInputError,
  CommunityNotFoundError,
} from "@moya/api";
import {
  directConversationPageSchema,
  directConversationSchema,
  directMessagePageSchema,
  directMessageSchema,
  directMessageUnreadSchema,
} from "@moya/contracts/schemas";
import {
  operatorDmConversationSchema,
  operatorDmMessageSchema,
} from "@moya/contracts/internal/community-operator";

import { asCommunityOperationError } from "./availability.js";

import type { DirectMessagePort, DirectMessageSendInput } from "@moya/api";
import type {
  DirectConversation,
  DirectConversationPage,
  DirectMessage,
  DirectMessagePage,
  DirectMessageUnread,
  DmConversationId,
  DmMessageId,
} from "@moya/contracts";
import type {
  OperatorDmConversation,
  OperatorDmMessage,
} from "@moya/contracts/internal/community-operator";
import type { Pool, PoolClient, QueryResultRow } from "pg";

/*
 * content-community-completion-v1: direct messages on PostgreSQL.
 *
 * Every write runs in one transaction that first takes a per-pair advisory
 * lock (hash of the sorted PublicUserIds), so pair creation, the first send,
 * the recipient's activating reply, hide / undo and a concurrent block are
 * serialized and re-checked after the lock wait. Permission is evaluated
 * inside the transaction, never from a pre-transaction read. Commands are
 * receipted in community.dm_command_receipts.
 */

const DAILY_NEW_CONVERSATIONS = 20;
const MESSAGES_PER_MINUTE = 20;

const fail = (code: string): never => {
  throw new CommunityInputError(code);
};

const opaque = (prefix: string) =>
  `${prefix}-${randomUUID().replaceAll("-", "")}`;

const pairKey = (a: string, b: string) => [a, b].sort().join(":");

interface ConversationRow extends QueryResultRow {
  id: string;
  user_low: string;
  user_high: string;
  initiator_id: string;
  state: "requested" | "active";
  next_sequence: string | number;
  last_message_at: Date | null;
  created_at: Date;
  // participant (viewer) state
  hidden_at: Date | null;
  hidden_before_sequence: string | number;
  muted: boolean;
  read_sequence: string | number;
  // other participant
  other_id: string;
  other_name: string;
  other_status: "active" | "suspended";
  can_interact: boolean;
  unread_count: string | number;
  message_count: string | number;
  last_sequence: string | number | null;
  last_sender_id: string | null;
  last_text: string | null;
  last_removed: boolean | null;
  last_created_at: Date | null;
}

interface MessageRow extends QueryResultRow {
  id: string;
  conversation_id: string;
  sequence: string | number;
  sender_id: string;
  sender_name?: string;
  text: string;
  created_at: Date;
  removed_at: Date | null;
  removed_by: string | null;
}

const conversationSelect = (viewerParam: string) => `
  SELECT c.id, c.user_low, c.user_high, c.initiator_id, c.state, c.next_sequence, c.last_message_at, c.created_at,
    p.hidden_at, p.hidden_before_sequence, p.muted, p.read_sequence,
    o.id AS other_id, o.display_name AS other_name, o.status AS other_status,
    community.accounts_can_interact(${viewerParam}, o.id) AS can_interact,
    (SELECT count(*) FROM community.dm_messages m
      WHERE m.conversation_id = c.id AND m.sender_id <> ${viewerParam}
        AND m.removed_at IS NULL AND m.sequence > p.read_sequence) AS unread_count,
    (SELECT count(*) FROM community.dm_messages m WHERE m.conversation_id = c.id) AS message_count,
    l.sequence AS last_sequence, l.sender_id AS last_sender_id,
    CASE WHEN l.removed_at IS NULL THEN l.text END AS last_text,
    (l.removed_at IS NOT NULL) AS last_removed, l.created_at AS last_created_at
  FROM community.dm_conversations c
  JOIN community.dm_participants p ON p.conversation_id = c.id AND p.user_id = ${viewerParam}
  JOIN community.public_users o ON o.id = CASE WHEN c.user_low = ${viewerParam} THEN c.user_high ELSE c.user_low END
  LEFT JOIN LATERAL (
    SELECT m.sequence, m.sender_id, m.text, m.removed_at, m.created_at
    FROM community.dm_messages m WHERE m.conversation_id = c.id ORDER BY m.sequence DESC LIMIT 1) l ON TRUE`;

export class PostgresDirectMessageAdapter implements DirectMessagePort {
  constructor(private readonly pool: Pool) {}

  private async run<T>(
    write: boolean,
    fn: (db: PoolClient) => Promise<T>,
  ): Promise<T> {
    const db = await this.pool.connect().catch((error) => {
      throw asCommunityOperationError(error, "connect");
    });
    try {
      await db.query(
        write ? "BEGIN" : "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
      );
      const result = await fn(db);
      await db.query("COMMIT");
      return result;
    } catch (error) {
      await db.query("ROLLBACK").catch(() => undefined);
      throw asCommunityOperationError(error, "query");
    } finally {
      db.release();
    }
  }

  private async active(
    db: PoolClient,
    id: string,
    lock = false,
  ): Promise<void> {
    const r = await db.query(
      `SELECT id FROM community.public_users WHERE id=$1 AND status='active'${lock ? " FOR NO KEY UPDATE" : ""}`,
      [id],
    );
    if (r.rowCount !== 1) throw new CommunityNotFoundError();
  }

  /** Replay-safe command: identical retry replays, different command conflicts. */
  private async receipt<T>(
    db: PoolClient,
    actor: string,
    requestId: string,
    command: unknown,
    work: () => Promise<T>,
  ): Promise<T> {
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(command))
      .digest("hex");
    const prior = (
      await db.query<{ fingerprint: string; result: T }>(
        "SELECT fingerprint, result FROM community.dm_command_receipts WHERE actor_id=$1 AND request_id=$2",
        [actor, requestId],
      )
    ).rows[0];
    if (prior) {
      if (prior.fingerprint !== fingerprint)
        throw new CommunityConflictError(
          "Request identity was already used for different content",
        );
      return prior.result;
    }
    const result = await work();
    await db.query(
      "INSERT INTO community.dm_command_receipts(actor_id, request_id, fingerprint, result) VALUES($1,$2,$3,$4::jsonb)",
      [actor, requestId, fingerprint, JSON.stringify(result)],
    );
    return result;
  }

  private async lockPair(db: PoolClient, a: string, b: string): Promise<void> {
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 7))", [
      `dm:${pairKey(a, b)}`,
    ]);
  }

  private conversationDto(
    row: ConversationRow,
    viewer: string,
  ): DirectConversation {
    const nextSequence = Number(row.next_sequence);
    const messageCount = Number(row.message_count);
    const otherAvailable = row.other_status === "active" && row.can_interact;
    let sendRefusal: DirectConversation["sendRefusal"] = null;
    if (!otherAvailable)
      sendRefusal = row.other_status !== "active" ? "unavailable" : "blocked";
    else if (
      row.state === "requested" &&
      row.initiator_id === viewer &&
      messageCount >= 1
    )
      sendRefusal = "request_pending";
    return directConversationSchema.parse({
      id: row.id,
      participant: {
        id: row.other_id,
        displayName: row.other_name,
        available: otherAvailable,
      },
      state: row.state,
      canSend: sendRefusal === null,
      sendRefusal,
      lastMessage:
        row.last_sequence === null
          ? null
          : {
              sequence: Number(row.last_sequence),
              senderId: row.last_sender_id,
              text: row.last_text,
              removed: row.last_removed === true,
              createdAt: row.last_created_at!.toISOString(),
            },
      unreadCount: Number(row.unread_count),
      muted: row.muted,
      hidden: row.hidden_at !== null,
      readSequence: Math.min(Number(row.read_sequence), nextSequence - 1),
      createdAt: row.created_at.toISOString(),
    });
  }

  private messageDto(row: MessageRow): DirectMessage {
    return directMessageSchema.parse({
      id: row.id,
      conversationId: row.conversation_id,
      sequence: Number(row.sequence),
      senderId: row.sender_id,
      text: row.removed_at === null ? row.text : null,
      removed: row.removed_at !== null,
      createdAt: row.created_at.toISOString(),
    });
  }

  private async conversationFor(
    db: PoolClient,
    viewer: string,
    id: string,
    lock = false,
  ): Promise<ConversationRow> {
    const row = (
      await db.query<ConversationRow>(
        `${conversationSelect("$1")} WHERE c.id = $2${lock ? " FOR UPDATE OF c, p" : ""}`,
        [viewer, id],
      )
    ).rows[0];
    if (!row) throw new CommunityNotFoundError();
    return row;
  }

  async send(
    actor: string,
    input: DirectMessageSendInput,
  ): Promise<DirectMessage> {
    const text = input.text.trim();
    if (text.length === 0 || [...text].length > 2000) fail("dm_text_invalid");
    return this.run(true, async (db) => {
      await this.active(db, actor);
      // Resolve the other party first (needed for the pair lock), then lock,
      // then re-derive everything under the lock.
      let other: string;
      if (input.conversationId !== undefined) {
        const row = (
          await db.query<{ user_low: string; user_high: string }>(
            "SELECT user_low, user_high FROM community.dm_conversations c JOIN community.dm_participants p ON p.conversation_id=c.id AND p.user_id=$2 WHERE c.id=$1",
            [input.conversationId, actor],
          )
        ).rows[0];
        if (!row) throw new CommunityNotFoundError();
        other = row.user_low === actor ? row.user_high : row.user_low;
      } else {
        other = input.recipientId!;
      }
      if (other === actor) fail("dm_self");
      await this.lockPair(db, actor, other);
      return this.receipt(
        db,
        actor,
        input.requestId,
        ["dm.send", other, text],
        async () => {
          // Re-check under the lock: the recipient may have been suspended or
          // blocked while this transaction waited.
          const recipient = (
            await db.query<{ status: string; allowed: boolean }>(
              "SELECT u.status, community.accounts_can_interact($1,$2) AS allowed FROM community.public_users u WHERE u.id=$2",
              [actor, other],
            )
          ).rows[0];
          if (!recipient || recipient.status !== "active")
            return fail("dm_recipient_unavailable");
          if (!recipient.allowed) fail("dm_blocked");
          const [low, high] = [actor, other].sort();
          let conversation = (
            await db.query<{
              id: string;
              state: "requested" | "active";
              initiator_id: string;
              next_sequence: string | number;
            }>(
              "SELECT id, state, initiator_id, next_sequence FROM community.dm_conversations WHERE user_low=$1 AND user_high=$2 FOR UPDATE",
              [low, high],
            )
          ).rows[0];
          if (!conversation) {
            if (input.conversationId !== undefined)
              throw new CommunityNotFoundError();
            // Daily new-conversation limit, UTC calendar day of server time.
            const opened = Number(
              (
                await db.query<{ n: string }>(
                  "SELECT count(*) AS n FROM community.dm_conversations WHERE initiator_id=$1 AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'",
                  [actor],
                )
              ).rows[0]!.n,
            );
            if (opened >= DAILY_NEW_CONVERSATIONS) fail("dm_daily_limit");
            const id = opaque("dm");
            await db.query(
              "INSERT INTO community.dm_conversations(id,user_low,user_high,initiator_id,state) VALUES($1,$2,$3,$4,'requested')",
              [id, low, high, actor],
            );
            await db.query(
              "INSERT INTO community.dm_participants(conversation_id,user_id) VALUES($1,$2),($1,$3)",
              [id, low, high],
            );
            conversation = {
              id,
              state: "requested",
              initiator_id: actor,
              next_sequence: 1,
            };
          }
          const messageCount = Number(
            (
              await db.query<{ n: string }>(
                "SELECT count(*) AS n FROM community.dm_messages WHERE conversation_id=$1",
                [conversation.id],
              )
            ).rows[0]!.n,
          );
          // The request gate: the initiator commits exactly one message until
          // the recipient's committed reply activates the conversation.
          if (
            conversation.state === "requested" &&
            conversation.initiator_id === actor &&
            messageCount >= 1
          )
            fail("dm_request_pending");
          // Bounded send rate per account on server time.
          const recent = Number(
            (
              await db.query<{ n: string }>(
                "SELECT count(*) AS n FROM community.dm_messages WHERE sender_id=$1 AND created_at > now() - interval '60 seconds'",
                [actor],
              )
            ).rows[0]!.n,
          );
          if (recent >= MESSAGES_PER_MINUTE) fail("dm_rate_limited");
          const sequence = Number(conversation.next_sequence);
          const messageId = opaque("dmsg");
          const inserted = (
            await db.query<MessageRow>(
              `INSERT INTO community.dm_messages(id,conversation_id,sequence,sender_id,text)
               VALUES($1,$2,$3,$4,$5) RETURNING id, conversation_id, sequence, sender_id, text, created_at, removed_at, removed_by`,
              [messageId, conversation.id, sequence, actor, text],
            )
          ).rows[0]!;
          const activates =
            conversation.state === "requested" &&
            conversation.initiator_id !== actor;
          await db.query(
            `UPDATE community.dm_conversations SET next_sequence = $2 + 1,
               last_message_at = $3::timestamptz, state = CASE WHEN $4::boolean THEN 'active' ELSE state END,
               updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
            [
              conversation.id,
              sequence,
              inserted.created_at.toISOString(),
              activates,
            ],
          );
          // Own sends are observed; a genuinely new message resurfaces the
          // conversation for a recipient who had hidden it, and for a sender
          // who writes into a pair they had hidden.
          await db.query(
            "UPDATE community.dm_participants SET read_sequence = GREATEST(read_sequence, $3), updated_at = CURRENT_TIMESTAMP WHERE conversation_id=$1 AND user_id=$2",
            [conversation.id, actor, sequence],
          );
          await db.query(
            "UPDATE community.dm_participants SET hidden_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE conversation_id=$1 AND hidden_at IS NOT NULL",
            [conversation.id],
          );
          return this.messageDto(inserted);
        },
      );
    });
  }

  async listConversations(
    actor: string,
    query: { cursor?: string; pageSize: number },
  ): Promise<DirectConversationPage> {
    return this.run(false, async (db) => {
      await this.active(db, actor);
      let cursorAt: string | null = null;
      let cursorId: string | null = null;
      if (query.cursor) {
        const [at, id] = query.cursor.split("|");
        if (!at || !id || Number.isNaN(Date.parse(at)))
          throw new CommunityInputError("Malformed conversation cursor");
        cursorAt = new Date(at).toISOString();
        cursorId = id;
      }
      const rows = (
        await db.query<ConversationRow>(
          `${conversationSelect("$1")}
           WHERE p.hidden_at IS NULL
             AND ($2::timestamptz IS NULL OR (COALESCE(c.last_message_at, c.created_at), c.id) < ($2::timestamptz, $3::text))
           ORDER BY COALESCE(c.last_message_at, c.created_at) DESC, c.id DESC
           LIMIT $4`,
          [actor, cursorAt, cursorId, query.pageSize + 1],
        )
      ).rows;
      const page = rows.slice(0, query.pageSize);
      const last = page[page.length - 1];
      return directConversationPageSchema.parse({
        items: page.map((row) => this.conversationDto(row, actor)),
        nextCursor:
          rows.length > query.pageSize && last
            ? `${(last.last_message_at ?? last.created_at).toISOString()}|${last.id}`
            : null,
      });
    });
  }

  async readConversation(
    actor: string,
    id: DmConversationId,
    query: { before?: number; after?: number; pageSize: number },
  ): Promise<DirectMessagePage> {
    return this.run(false, async (db) => {
      await this.active(db, actor);
      const row = await this.conversationFor(db, actor, id);
      const messages = (
        await db.query<MessageRow>(
          `SELECT id, conversation_id, sequence, sender_id, text, created_at, removed_at, removed_by
           FROM community.dm_messages
           WHERE conversation_id = $1
             AND ($2::bigint IS NULL OR sequence < $2::bigint)
             AND ($3::bigint IS NULL OR sequence > $3::bigint)
           ORDER BY sequence DESC LIMIT $4`,
          [id, query.before ?? null, query.after ?? null, query.pageSize + 1],
        )
      ).rows;
      const page = messages.slice(0, query.pageSize);
      const oldest = page[page.length - 1];
      return directMessagePageSchema.parse({
        conversation: this.conversationDto(row, actor),
        items: page.map((message) => this.messageDto(message)),
        nextBefore:
          messages.length > query.pageSize && oldest
            ? Number(oldest.sequence)
            : null,
      });
    });
  }

  async findConversationWith(
    actor: string,
    otherId: string,
  ): Promise<DirectConversation | null> {
    return this.run(false, async (db) => {
      await this.active(db, actor);
      const [low, high] = [actor, otherId].sort();
      const row = (
        await db.query<ConversationRow>(
          `${conversationSelect("$1")} WHERE c.user_low = $2 AND c.user_high = $3`,
          [actor, low, high],
        )
      ).rows[0];
      return row ? this.conversationDto(row, actor) : null;
    });
  }

  private async participantCommand(
    actor: string,
    id: DmConversationId,
    requestId: string,
    command: readonly unknown[],
    change: (db: PoolClient, row: ConversationRow) => Promise<void>,
  ): Promise<DirectConversation> {
    return this.run(true, async (db) => {
      await this.active(db, actor);
      const pair = (
        await db.query<{ user_low: string; user_high: string }>(
          "SELECT c.user_low, c.user_high FROM community.dm_conversations c JOIN community.dm_participants p ON p.conversation_id=c.id AND p.user_id=$2 WHERE c.id=$1",
          [id, actor],
        )
      ).rows[0];
      if (!pair) throw new CommunityNotFoundError();
      await this.lockPair(db, pair.user_low, pair.user_high);
      return this.receipt(db, actor, requestId, command, async () => {
        const row = await this.conversationFor(db, actor, id, true);
        await change(db, row);
        return this.conversationDto(
          await this.conversationFor(db, actor, id),
          actor,
        );
      });
    });
  }

  setHidden(
    actor: string,
    id: DmConversationId,
    hidden: boolean,
    requestId: string,
  ) {
    return this.participantCommand(
      actor,
      id,
      requestId,
      ["dm.hide", id, hidden],
      async (db, row) => {
        // Hide-for-self only; the marker is preserved so unread derives from it
        // when a new message or an explicit undo reveals the conversation again.
        await db.query(
          `UPDATE community.dm_participants SET
           hidden_at = CASE WHEN $3::boolean THEN COALESCE(hidden_at, CURRENT_TIMESTAMP) ELSE NULL END,
           hidden_before_sequence = CASE WHEN $3::boolean THEN $4 ELSE hidden_before_sequence END,
           updated_at = CURRENT_TIMESTAMP
         WHERE conversation_id=$1 AND user_id=$2`,
          [id, actor, hidden, Number(row.next_sequence) - 1],
        );
      },
    );
  }

  setMuted(
    actor: string,
    id: DmConversationId,
    muted: boolean,
    requestId: string,
  ) {
    return this.participantCommand(
      actor,
      id,
      requestId,
      ["dm.mute", id, muted],
      async (db) => {
        await db.query(
          "UPDATE community.dm_participants SET muted=$3, updated_at=CURRENT_TIMESTAMP WHERE conversation_id=$1 AND user_id=$2",
          [id, actor, muted],
        );
      },
    );
  }

  markRead(
    actor: string,
    id: DmConversationId,
    sequence: number,
    requestId: string,
  ) {
    return this.participantCommand(
      actor,
      id,
      requestId,
      ["dm.read", id, sequence],
      async (db, row) => {
        // Monotonic and clamped: never beyond the latest existing message.
        const latest = Number(row.next_sequence) - 1;
        await db.query(
          "UPDATE community.dm_participants SET read_sequence = GREATEST(read_sequence, LEAST($3::bigint, $4::bigint)), updated_at=CURRENT_TIMESTAMP WHERE conversation_id=$1 AND user_id=$2",
          [id, actor, sequence, latest],
        );
      },
    );
  }

  async unread(actor: string): Promise<DirectMessageUnread> {
    return this.run(false, async (db) => {
      const row = (
        await db.query<{ n: string }>(
          `SELECT count(*) AS n FROM community.dm_participants p
           JOIN community.dm_conversations c ON c.id = p.conversation_id
           WHERE p.user_id = $1 AND p.hidden_at IS NULL AND EXISTS (
             SELECT 1 FROM community.dm_messages m
             WHERE m.conversation_id = c.id AND m.sender_id <> $1 AND m.removed_at IS NULL AND m.sequence > p.read_sequence)`,
          [actor],
        )
      ).rows[0]!;
      return directMessageUnreadSchema.parse({
        unreadConversations: Number(row.n),
      });
    });
  }

  // -- Owner-only moderation over one explicitly selected conversation -------

  private async operatorConversation(
    db: PoolClient,
    id: string,
  ): Promise<OperatorDmConversation | null> {
    const c = (
      await db.query<{
        id: string;
        user_low: string;
        user_high: string;
        initiator_id: string;
        state: "requested" | "active";
        created_at: Date;
      }>(
        "SELECT id, user_low, user_high, initiator_id, state, created_at FROM community.dm_conversations WHERE id=$1",
        [id],
      )
    ).rows[0];
    if (!c) return null;
    const people = (
      await db.query<{
        id: string;
        display_name: string;
        status: "active" | "suspended";
      }>(
        "SELECT id, display_name, status FROM community.public_users WHERE id IN ($1,$2) ORDER BY id",
        [c.user_low, c.user_high],
      )
    ).rows;
    const total = Number(
      (
        await db.query<{ n: string }>(
          "SELECT COUNT(*) AS n FROM community.dm_messages WHERE conversation_id = $1",
          [id],
        )
      ).rows[0]!.n,
    );
    // The latest window of a long conversation, oldest first; the total
    // count says how much lies before it.
    const messages = (
      await db.query<MessageRow>(
        `SELECT * FROM (
           SELECT m.id, m.conversation_id, m.sequence, m.sender_id, u.display_name AS sender_name, m.text, m.created_at, m.removed_at, m.removed_by
           FROM community.dm_messages m JOIN community.public_users u ON u.id = m.sender_id
           WHERE m.conversation_id = $1 ORDER BY m.sequence DESC LIMIT 200
         ) latest ORDER BY sequence ASC`,
        [id],
      )
    ).rows;
    return operatorDmConversationSchema.parse({
      id: c.id,
      participants: people.map((p) => ({
        id: p.id,
        displayName: p.display_name,
        status: p.status,
      })),
      initiatorId: c.initiator_id,
      state: c.state,
      messageCount: total,
      createdAt: c.created_at.toISOString(),
      messages: messages.map((m) => ({
        id: m.id,
        sequence: Number(m.sequence),
        senderId: m.sender_id,
        senderName: m.sender_name,
        text: m.removed_at === null ? m.text : null,
        removed: m.removed_at !== null,
        removedBy: m.removed_by,
        createdAt: m.created_at.toISOString(),
      })),
    });
  }

  /** Content-free audit of each authorized access or action. */
  private async audit(
    db: PoolClient,
    operator: string,
    action: "read_conversation" | "remove_message",
    conversationId: string,
    messageId: string | null,
    purpose: string,
  ): Promise<void> {
    await db.query(
      "INSERT INTO community.dm_moderation_events(id, operator_label, action, conversation_id, message_id, purpose) VALUES($1,$2,$3,$4,$5,$6)",
      [randomUUID(), operator, action, conversationId, messageId, purpose],
    );
  }

  async operatorReadConversation(
    operator: string,
    id: string,
    purpose: string,
  ) {
    return this.run(true, async (db) => {
      const conversation = await this.operatorConversation(db, id);
      if (!conversation) throw new CommunityNotFoundError();
      await this.audit(db, operator, "read_conversation", id, null, purpose);
      return conversation;
    });
  }

  async operatorFindConversation(
    operator: string,
    userIds: readonly [string, string],
    purpose: string,
  ) {
    return this.run(true, async (db) => {
      const [low, high] = [...userIds].sort();
      const id = (
        await db.query<{ id: string }>(
          "SELECT id FROM community.dm_conversations WHERE user_low=$1 AND user_high=$2",
          [low, high],
        )
      ).rows[0]?.id;
      if (!id) return null;
      const conversation = await this.operatorConversation(db, id);
      if (conversation)
        await this.audit(db, operator, "read_conversation", id, null, purpose);
      return conversation;
    });
  }

  async operatorRemoveMessage(
    operator: string,
    id: DmMessageId,
    requestId: string,
    purpose: string,
  ): Promise<OperatorDmMessage> {
    return this.run(true, async (db) => {
      const message = (
        await db.query<MessageRow>(
          "SELECT m.*, u.display_name AS sender_name FROM community.dm_messages m JOIN community.public_users u ON u.id=m.sender_id WHERE m.id=$1 FOR UPDATE OF m",
          [id],
        )
      ).rows[0];
      if (!message) throw new CommunityNotFoundError();
      const fingerprint = createHash("sha256")
        .update(JSON.stringify(["dm.remove", id, purpose]))
        .digest("hex");
      const prior = (
        await db.query<{ fingerprint: string; result: OperatorDmMessage }>(
          "SELECT fingerprint, result FROM community.content_operator_receipts WHERE operator_label=$1 AND request_id=$2",
          [operator, requestId],
        )
      ).rows[0];
      if (prior) {
        if (prior.fingerprint !== fingerprint)
          throw new CommunityConflictError("Request identity already used");
        return prior.result;
      }
      if (message.removed_at === null) {
        await db.query(
          "UPDATE community.dm_messages SET removed_at=CURRENT_TIMESTAMP, removed_by=$2 WHERE id=$1",
          [id, operator],
        );
        // The sender's send receipt replays the committed message; it must
        // not keep a second copy of removed text.
        await db.query(
          "UPDATE community.dm_command_receipts SET result = jsonb_set(jsonb_set(result, '{text}', 'null'::jsonb), '{removed}', 'true'::jsonb) WHERE result->>'id' = $1",
          [id],
        );
      }
      const after = (
        await db.query<MessageRow>(
          "SELECT m.*, u.display_name AS sender_name FROM community.dm_messages m JOIN community.public_users u ON u.id=m.sender_id WHERE m.id=$1",
          [id],
        )
      ).rows[0]!;
      const result = operatorDmMessageSchema.parse({
        id: after.id,
        sequence: Number(after.sequence),
        senderId: after.sender_id,
        senderName: after.sender_name,
        text: null,
        removed: true,
        removedBy: after.removed_by,
        createdAt: after.created_at.toISOString(),
      });
      await this.audit(
        db,
        operator,
        "remove_message",
        after.conversation_id,
        id,
        purpose,
      );
      await db.query(
        "INSERT INTO community.content_operator_receipts(operator_label,request_id,fingerprint,result) VALUES($1,$2,$3,$4)",
        [operator, requestId, fingerprint, JSON.stringify(result)],
      );
      return result;
    });
  }
}
