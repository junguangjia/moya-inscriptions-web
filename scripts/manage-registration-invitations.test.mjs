import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  manageRegistrationInvitations,
  parseInvitationCommand,
  registrationInvitationDigest,
} from "./manage-registration-invitations.mjs";

test("invitation command has bounded defaults and rejects ambiguous/malformed inputs", () => {
  assert.deepEqual(
    parseInvitationCommand([
      "create",
      "--output-file",
      "/tmp/synthetic-invite.json",
    ]),
    {
      action: "create",
      outputFile: "/tmp/synthetic-invite.json",
      maxUses: 20,
      expiresInDays: 7,
    },
  );
  for (const args of [
    [],
    ["create"],
    ["create", "--output-file", "relative"],
    ["create", "--output-file", "/tmp/synthetic", "--max-uses", "0"],
    ["create", "--output-file", "/tmp/synthetic", "--expires-in-days", "366"],
    [
      "create",
      "--output-file",
      "/tmp/synthetic",
      "--max-uses",
      "21",
      "--max-uses",
      "22",
    ],
    ["status", "--unknown", "x"],
    ["revoke"],
    ["revoke-access", "--user-id", "invalid"],
  ])
    assert.throws(
      () => parseInvitationCommand(args),
      /REGISTRATION_INVITATION_OPERATION_REFUSED/u,
    );
});

const fixture = (allowed = true, failInsert = false) => {
  const rows = [];
  const client = {
    async query(sql, values) {
      if (sql.includes("has_table_privilege")) return { rows: [{ allowed }] };
      if (sql.includes("INSERT INTO community.registration_invitations")) {
        if (failInsert) throw Error("Synthetic database failure");
        rows.push(values);
        return {
          rows: [
            {
              id: values[0],
              max_uses: values[3],
              used_count: 0,
              expires_at: "2030-01-01T00:00:00Z",
            },
          ],
        };
      }
      return { rows: [] };
    },
    release() {},
  };
  return {
    pool: {
      async connect() {
        return client;
      },
    },
    rows,
  };
};

test("create writes plaintext exclusively to an owned 0600 file and keeps result/DB hash-only", async () => {
  const dir = await mkdtemp(join(tmpdir(), "synthetic-invitation-cli-"));
  try {
    const output = join(dir, "invitation.json");
    const { pool, rows } = fixture();
    const result = await manageRegistrationInvitations(
      pool,
      parseInvitationCommand(["create", "--output-file", output]),
      "development",
    );
    const content = JSON.parse(await readFile(output, "utf8"));
    assert.equal((await stat(output)).mode & 0o777, 0o600);
    assert.equal(/^[A-Za-z0-9_-]{22}$/u.test(content.invitationCode), true);
    assert.equal(
      rows[0][1] === registrationInvitationDigest(content.invitationCode),
      true,
    );
    assert.equal(
      JSON.stringify(result).includes(content.invitationCode),
      false,
    );
    assert.equal(JSON.stringify(rows).includes(content.invitationCode), false);
    await assert.rejects(
      manageRegistrationInvitations(
        pool,
        parseInvitationCommand(["create", "--output-file", output]),
        "development",
      ),
    );
    const target = join(dir, "target");
    await writeFile(target, "preserve");
    const link = join(dir, "link");
    await symlink(target, link);
    await assert.rejects(
      manageRegistrationInvitations(
        pool,
        parseInvitationCommand(["create", "--output-file", link]),
        "development",
      ),
    );
    assert.equal(await readFile(target, "utf8"), "preserve");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runtime permissions refuse before creating a file; a failed insert removes its exclusive file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "synthetic-invitation-refusal-"));
  try {
    const output = join(dir, "invitation.json");
    const command = parseInvitationCommand(["create", "--output-file", output]);
    for (const pool of [fixture(false).pool, fixture(true, true).pool]) {
      await assert.rejects(
        manageRegistrationInvitations(pool, command, "development"),
        /REGISTRATION_INVITATION_OPERATION_REFUSED/u,
      );
      await assert.rejects(stat(output), { code: "ENOENT" });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
