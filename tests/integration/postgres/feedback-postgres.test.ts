import { randomUUID } from "node:crypto";
import { FeedbackService } from "@moya/api";
import {
  createPostgresPool,
  parsePostgresConfig,
} from "@moya/catalog-postgres";
import { PostgresFeedbackAdapter } from "@moya/community-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createCatalogScaleDatabase,
  type CatalogScaleDatabase,
} from "./catalog-scale-fixture.js";
import { requireSyntheticTestDatabaseUrl } from "./synthetic-test-database.js";

const target = requireSyntheticTestDatabaseUrl();
let db: CatalogScaleDatabase;
let feedback: FeedbackService;
let alice: string, bob: string;
const userId = () => `user-${randomUUID().replaceAll("-", "")}`;
const submit = (message: string) => ({ submissionId: randomUUID(), message });

beforeAll(async () => {
  db = await createCatalogScaleDatabase({
    target,
    label: "feedback",
    openPool: (url) =>
      createPostgresPool(parsePostgresConfig({ DATABASE_URL: url })),
  });
  feedback = new FeedbackService(new PostgresFeedbackAdapter(db.app));
  alice = userId();
  bob = userId();
  for (const [id, label] of [
    [alice, "Alice"],
    [bob, "Bob"],
  ])
    await db.setup.query(
      "INSERT INTO community.public_users(id,handle,display_name) VALUES($1,$2,$3)",
      [id, `feedback-${id!.slice(-20)}`, `Synthetic ${label}`],
    );
}, 60000);
afterAll(async () => {
  await db?.close();
});

describe("private feedback persistence under the real App role", () => {
  it("commits a trimmed message before returning its minimal receipt", async () => {
    const input = submit("  Synthetic saved feedback\n ");
    const receipt = await feedback.submit(alice, input);
    const saved = (
      await db.setup.query("SELECT * FROM community.feedback WHERE id=$1", [
        receipt.id,
      ])
    ).rows[0];
    expect(saved.message).toBe("Synthetic saved feedback");
    expect(saved.user_id).toBe(alice);
    expect(saved.created_at.toISOString()).toBe(receipt.createdAt);
    expect(Object.keys(receipt).sort()).toEqual(["createdAt", "id"]);
    expect(await feedback.submit(alice, input)).toEqual(receipt);
    await expect(
      feedback.submit(alice, { ...input, message: "Changed message" }),
    ).rejects.toMatchObject({ name: "CommunityConflictError" });
  });

  it("serializes concurrent retries and keeps submission keys scoped to the user", async () => {
    const input = submit("Synthetic concurrent feedback");
    const receipts = await Promise.all(
      Array.from({ length: 6 }, () => feedback.submit(alice, input)),
    );
    expect(new Set(receipts.map(({ id }) => id)).size).toBe(1);
    expect(
      (
        await db.setup.query(
          "SELECT count(*) AS n FROM community.feedback WHERE user_id=$1 AND submission_id=$2",
          [alice, input.submissionId],
        )
      ).rows[0]?.n,
    ).toBe("1");
    expect((await feedback.submit(bob, input)).id).not.toBe(receipts[0]!.id);
    const race = submit("First contender");
    const results = await Promise.allSettled([
      feedback.submit(alice, race),
      feedback.submit(alice, { ...race, message: "Second contender" }),
    ]);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(
      1,
    );
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(
      1,
    );
  });

  it("pages feedback newest first with the submitter display name", async () => {
    const earlier = await feedback.submit(
      alice,
      submit("Synthetic page earlier"),
    );
    const later = await feedback.submit(bob, submit("Synthetic page later"));
    await db.setup.query(
      "UPDATE community.feedback SET created_at=$2 WHERE id=$1",
      [earlier.id, "2090-01-01T00:00:00Z"],
    );
    await db.setup.query(
      "UPDATE community.feedback SET created_at=$2 WHERE id=$1",
      [later.id, "2090-01-02T00:00:00Z"],
    );
    const first = await feedback.operatorList({ page: 1, pageSize: 1 });
    const second = await feedback.operatorList({ page: 2, pageSize: 1 });
    expect(first.items[0]).toMatchObject({
      id: later.id,
      user: { id: bob, displayName: "Synthetic Bob" },
    });
    expect(second.items[0]?.id).toBe(earlier.id);
    expect(first.total).toBeGreaterThanOrEqual(2);
    expect(second.total).toBe(first.total);
  });

  it("rejects invalid text and inactive accounts without creating rows", async () => {
    for (const message of ["", " \n\t", "a".repeat(5001)])
      await expect(async () =>
        feedback.submit(alice, submit(message)),
      ).rejects.toMatchObject({ name: "CommunityInputError" });
    await db.setup.query(
      "UPDATE community.public_users SET status='suspended' WHERE id=$1",
      [bob],
    );
    await expect(
      feedback.submit(bob, submit("Should not save")),
    ).rejects.toMatchObject({ name: "CommunityConflictError" });
    expect(
      (
        await db.setup.query(
          "SELECT count(*) AS n FROM community.feedback WHERE message='Should not save'",
        )
      ).rows[0]?.n,
    ).toBe("0");
  });

  it("keeps public database reads denied and runtime feedback append-only", async () => {
    const privileges = (
      await db.app.query(
        "SELECT has_table_privilege(current_user,'community.feedback','SELECT') AS read, has_table_privilege(current_user,'community.feedback','INSERT') AS insert, has_table_privilege(current_user,'community.feedback','UPDATE') AS update, has_table_privilege(current_user,'community.feedback','DELETE') AS delete",
      )
    ).rows[0];
    expect(privileges).toEqual({
      read: true,
      insert: true,
      update: false,
      delete: false,
    });
    const feedbackOid = (
      await db.setup.query("SELECT 'community.feedback'::regclass::oid AS id")
    ).rows[0]!.id;
    const publicPrivileges = (
      await db.publicRead.query(
        "SELECT has_table_privilege(current_user,$1::oid,'SELECT') AS read, has_table_privilege(current_user,$1::oid,'INSERT') AS insert",
        [feedbackOid],
      )
    ).rows[0];
    expect(publicPrivileges).toEqual({ read: false, insert: false });
    await expect(
      db.publicRead.query("SELECT message FROM community.feedback"),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      db.app.query("UPDATE community.feedback SET message='Changed'"),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      db.app.query("DELETE FROM community.feedback"),
    ).rejects.toMatchObject({ code: "42501" });
  });
});
