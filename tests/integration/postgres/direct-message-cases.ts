import { randomUUID } from "node:crypto";

import {
  CommunityConflictError,
  CommunityInputError,
  CommunityNotFoundError,
} from "@moya/api";
import { PostgresDirectMessageAdapter } from "@moya/community-postgres";
import { afterAll, describe, expect, it } from "vitest";

import type { DmConversationId } from "@moya/contracts";
import type { createPostgresPool } from "@moya/catalog-postgres";

const id = (prefix: string) => `${prefix}-${randomUUID().replaceAll("-", "")}`;

/**
 * content-community-completion-v1: direct messages on the real community
 * schema. Concurrency cases use separate connections and deterministic
 * synchronization through the adapter's own pair lock; each assertion would
 * fail if the guard it names were removed.
 */
export const registerDirectMessageTests = (
  pool: ReturnType<typeof createPostgresPool>,
) => {
  describe("direct messages (content-community-completion-v1)", () => {
    const dm = new PostgresDirectMessageAdapter(pool);
    const users: string[] = [];
    const user = async (label: string): Promise<string> => {
      const created = id("user");
      await pool.query(
        "INSERT INTO community.public_users(id,handle,display_name) VALUES($1,$2,$3)",
        [created, `dm-${created.slice(-24)}`, label],
      );
      users.push(created);
      return created;
    };
    const send = (
      actor: string,
      recipientId: string,
      text: string,
      requestId = randomUUID(),
    ) => dm.send(actor, { requestId, recipientId, text });
    const sendIn = (
      actor: string,
      conversationId: string,
      text: string,
      requestId = randomUUID(),
    ) => dm.send(actor, { requestId, conversationId, text });
    const code = async (p: Promise<unknown>) => {
      try {
        await p;
        return null;
      } catch (error) {
        return error instanceof CommunityInputError
          ? error.message
          : error instanceof CommunityConflictError
            ? "conflict"
            : error instanceof CommunityNotFoundError
              ? "not_found"
              : "other";
      }
    };
    afterAll(async () => {
      if (users.length === 0) return;
      await pool.query(
        "DELETE FROM community.dm_moderation_events WHERE conversation_id IN (SELECT id FROM community.dm_conversations WHERE user_low=ANY($1::text[]) OR user_high=ANY($1::text[]))",
        [users],
      );
      await pool.query(
        "DELETE FROM community.dm_command_receipts WHERE actor_id=ANY($1::text[])",
        [users],
      );
      await pool.query(
        "DELETE FROM community.dm_messages WHERE conversation_id IN (SELECT id FROM community.dm_conversations WHERE user_low=ANY($1::text[]) OR user_high=ANY($1::text[]))",
        [users],
      );
      await pool.query(
        "DELETE FROM community.dm_participants WHERE conversation_id IN (SELECT id FROM community.dm_conversations WHERE user_low=ANY($1::text[]) OR user_high=ANY($1::text[]))",
        [users],
      );
      await pool.query(
        "DELETE FROM community.dm_conversations WHERE user_low=ANY($1::text[]) OR user_high=ANY($1::text[])",
        [users],
      );
      await pool.query(
        "DELETE FROM community.content_operator_receipts WHERE result::text LIKE '%dmsg-%'",
      );
      await pool
        .query(
          "DELETE FROM community.blocks WHERE blocker_id=ANY($1::text[]) OR blocked_id=ANY($1::text[])",
          [users],
        )
        .catch(() => undefined);
      // The fixture accounts themselves; nothing else references them once the
      // DM rows above are gone.
      await pool.query(
        "DELETE FROM community.public_users WHERE id=ANY($1::text[])",
        [users],
      );
    });

    it("enforces the one-first-message request gate until the recipient's committed reply", async () => {
      const a = await user("甲");
      const b = await user("乙");
      expect(await code(send(a, a, "自言自语"))).toBe("dm_self");
      const first = await send(a, b, "你好，想请教拓片保存的问题。");
      expect(first.sequence).toBe(1);
      const conversation = (await dm.findConversationWith(a, b))!;
      expect(conversation.state).toBe("requested");
      expect(conversation.canSend).toBe(false);
      expect(conversation.sendRefusal).toBe("request_pending");
      // Second initiator message refused, also through the conversation id.
      expect(await code(send(a, b, "在吗？"))).toBe("dm_request_pending");
      expect(await code(sendIn(a, conversation.id, "在吗？"))).toBe(
        "dm_request_pending",
      );
      // Reading, hiding, unhiding, muting never unlock.
      await dm.readConversation(a, conversation.id as DmConversationId, {
        pageSize: 10,
      });
      await dm.setHidden(
        a,
        conversation.id as DmConversationId,
        true,
        randomUUID(),
      );
      await dm.setHidden(
        a,
        conversation.id as DmConversationId,
        false,
        randomUUID(),
      );
      await dm.setMuted(
        a,
        conversation.id as DmConversationId,
        true,
        randomUUID(),
      );
      await dm.markRead(
        a,
        conversation.id as DmConversationId,
        99,
        randomUUID(),
      );
      expect(await code(send(a, b, "还在吗？"))).toBe("dm_request_pending");
      // A rolled-back reply does not unlock: simulate with a transaction that
      // inserts a reply and rolls back, then re-check.
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          "INSERT INTO community.dm_messages(id,conversation_id,sequence,sender_id,text) VALUES($1,$2,2,$3,'未提交的回复')",
          [id("dmsg"), conversation.id, b],
        );
        await client.query("ROLLBACK");
      } finally {
        client.release();
      }
      expect(await code(send(a, b, "仍然等待"))).toBe("dm_request_pending");
      // The recipient's committed reply activates the pair for both.
      const reply = await sendIn(b, conversation.id, "在的，你说。");
      expect(reply.sequence).toBe(2);
      const active = (await dm.findConversationWith(a, b))!;
      expect(active.state).toBe("active");
      expect(active.canSend).toBe(true);
      const third = await send(a, b, "太好了。");
      expect(third.sequence).toBe(3);
      // Unread for b counts a's messages after b's read sequence (b read up to 2 by sending).
      const forB = (await dm.findConversationWith(b, a))!;
      expect(forB.unreadCount).toBe(1);
      expect((await dm.unread(b)).unreadConversations).toBe(1);
      expect((await dm.unread(a)).unreadConversations).toBe(0);
    });

    it("replays an identical retry and conflicts on a different command under the same identity", async () => {
      const a = await user("丙");
      const b = await user("丁");
      const requestId = randomUUID();
      const first = await send(a, b, "初次问候", requestId);
      const again = await send(a, b, "初次问候", requestId);
      expect(again).toEqual(first);
      expect(await code(send(a, b, "别的内容", requestId))).toBe("conflict");
      const messages = await pool.query(
        "SELECT count(*) AS n FROM community.dm_messages WHERE conversation_id=$1",
        [first.conversationId],
      );
      expect(Number(messages.rows[0].n)).toBe(1);
    });

    it("serializes concurrent first sends on one pair so exactly one first message commits", async () => {
      const a = await user("戊");
      const b = await user("己");
      const results = await Promise.allSettled([
        send(a, b, "并发一"),
        send(a, b, "并发二"),
        send(a, b, "并发三"),
      ]);
      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");
      expect(fulfilled.length).toBe(1);
      expect(rejected.length).toBe(2);
      for (const r of rejected)
        expect((r as PromiseRejectedResult).reason).toMatchObject({
          message: "dm_request_pending",
        });
      const conversations = await pool.query(
        "SELECT count(*) AS n FROM community.dm_conversations WHERE user_low=$1 AND user_high=$2",
        [[a, b].sort()[0], [a, b].sort()[1]],
      );
      expect(Number(conversations.rows[0].n)).toBe(1);
      // Concurrent replies after activation allocate distinct sequences.
      const conversation = (await dm.findConversationWith(a, b))!;
      await sendIn(b, conversation.id, "回复");
      const burst = await Promise.all([
        sendIn(a, conversation.id, "一"),
        sendIn(b, conversation.id, "二"),
        sendIn(a, conversation.id, "三"),
      ]);
      expect(new Set(burst.map((m) => m.sequence)).size).toBe(3);
    });

    it("denies sending across a block and to a suspended account, without resetting history or the gate", async () => {
      const a = await user("庚");
      const b = await user("辛");
      const first = await send(a, b, "问候");
      await sendIn(b, first.conversationId, "回复");
      await pool.query(
        "INSERT INTO community.blocks(blocker_id,blocked_id) VALUES($1,$2)",
        [b, a],
      );
      expect(await code(send(a, b, "被屏蔽后"))).toBe("dm_blocked");
      const blocked = (await dm.findConversationWith(a, b))!;
      expect(blocked.canSend).toBe(false);
      expect(blocked.sendRefusal).toBe("blocked");
      // Existing history stays readable to the participants.
      const history = await dm.readConversation(
        a,
        first.conversationId as DmConversationId,
        { pageSize: 10 },
      );
      expect(history.items.length).toBe(2);
      await pool.query(
        "DELETE FROM community.blocks WHERE blocker_id=$1 AND blocked_id=$2",
        [b, a],
      );
      const restored = (await dm.findConversationWith(a, b))!;
      expect(restored.state).toBe("active");
      expect(restored.canSend).toBe(true);
      await pool.query(
        "UPDATE community.public_users SET status='suspended' WHERE id=$1",
        [b],
      );
      expect(await code(send(a, b, "对方停用后"))).toBe(
        "dm_recipient_unavailable",
      );
      await pool.query(
        "UPDATE community.public_users SET status='active' WHERE id=$1",
        [b],
      );
    });

    it("hides for self only, resurfaces on a new incoming message, keeps read markers monotonic and clamped", async () => {
      const a = await user("壬");
      const b = await user("癸");
      const first = await send(a, b, "第一条");
      const conversationId = first.conversationId as DmConversationId;
      await sendIn(b, conversationId, "第二条");
      const hidden = await dm.setHidden(a, conversationId, true, randomUUID());
      expect(hidden.hidden).toBe(true);
      expect(
        (await dm.listConversations(a, { pageSize: 10 })).items.some(
          (c) => c.id === conversationId,
        ),
      ).toBe(false);
      // The other participant is unaffected.
      expect((await dm.findConversationWith(b, a))!.hidden).toBe(false);
      // Hiding did not mark anything read; the badge excludes hidden conversations.
      expect((await dm.unread(a)).unreadConversations).toBe(0);
      expect((await dm.findConversationWith(a, b))!.unreadCount).toBe(1);
      // A new incoming message resurfaces it with unread derived from the marker.
      await sendIn(b, conversationId, "第三条");
      const visible = (
        await dm.listConversations(a, { pageSize: 10 })
      ).items.find((c) => c.id === conversationId)!;
      expect(visible.hidden).toBe(false);
      expect(visible.unreadCount).toBe(2);
      // Undo of a hide restores only that state; a stale replay cannot re-hide.
      const undoRequest = randomUUID();
      const rehidden = await dm.setHidden(
        a,
        conversationId,
        true,
        randomUUID(),
      );
      expect(rehidden.hidden).toBe(true);
      const undone = await dm.setHidden(a, conversationId, false, undoRequest);
      expect(undone.hidden).toBe(false);
      expect(
        (await dm.setHidden(a, conversationId, false, undoRequest)).hidden,
      ).toBe(false);
      // Read marker clamps to the latest sequence and never regresses.
      const read = await dm.markRead(a, conversationId, 999, randomUUID());
      expect(read.readSequence).toBe(3);
      expect(read.unreadCount).toBe(0);
      const regress = await dm.markRead(a, conversationId, 1, randomUUID());
      expect(regress.readSequence).toBe(3);
      // History is newest first with bounded cursors.
      const page = await dm.readConversation(a, conversationId, {
        pageSize: 2,
      });
      expect(page.items.map((m) => m.sequence)).toEqual([3, 2]);
      expect(page.nextBefore).toBe(2);
      const older = await dm.readConversation(a, conversationId, {
        before: 2,
        pageSize: 2,
      });
      expect(older.items.map((m) => m.sequence)).toEqual([1]);
      expect(older.nextBefore).toBeNull();
      // Foreign membership and forged ids are refused.
      const c = await user("外人");
      expect(
        await code(dm.readConversation(c, conversationId, { pageSize: 5 })),
      ).toBe("not_found");
      expect(
        await code(dm.setHidden(c, conversationId, true, randomUUID())),
      ).toBe("not_found");
    });

    it("removes a message only through the audited operator path and keeps its sequence", async () => {
      const a = await user("子");
      const b = await user("丑");
      const first = await send(a, b, "需要处理的内容");
      const reply = await sendIn(b, first.conversationId, "正常回复");
      const removed = await dm.operatorRemoveMessage(
        "owner",
        first.id as never,
        randomUUID(),
        "验收：移除一条测试消息",
      );
      expect(removed.removed).toBe(true);
      expect(removed.text).toBeNull();
      const history = await dm.readConversation(
        a,
        first.conversationId as DmConversationId,
        { pageSize: 10 },
      );
      expect(history.items.map((m) => [m.sequence, m.removed, m.text])).toEqual(
        [
          [2, false, "正常回复"],
          [1, true, null],
        ],
      );
      void reply;
      const audit = await pool.query<{ action: string; purpose: string }>(
        "SELECT action, purpose FROM community.dm_moderation_events WHERE conversation_id=$1 ORDER BY created_at",
        [first.conversationId],
      );
      expect(audit.rows.map((r) => r.action)).toEqual(["remove_message"]);
      // Reading through the operator path is itself audited; ordinary logs never carry bodies.
      const view = await dm.operatorReadConversation(
        "owner",
        first.conversationId,
        "验收：查看对话",
      );
      expect(view.messages.length).toBe(2);
      const auditAfter = await pool.query(
        "SELECT count(*) AS n FROM community.dm_moderation_events WHERE conversation_id=$1",
        [first.conversationId],
      );
      expect(Number(auditAfter.rows[0].n)).toBe(2);
    });
  });
};
