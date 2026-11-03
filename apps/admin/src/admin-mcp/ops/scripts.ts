import type { AdminOpName } from "@moya/contracts/internal/admin-mcp";

import {
  asynchronous,
  irreversibleOp,
  readOp,
  reversibleOp,
  type AdminOpEntry,
} from "./define";

type ScriptOpName = Extract<AdminOpName, `ops.${string}`>;
type OtherOpName = Extract<
  AdminOpName,
  `analytics.${string}` | `run.${string}`
>;

const community = { credential: "community" } as const;
const base = { credential: "base" } as const;

/** Operator scripts as bounded server operations with fixed statements. */
export const scriptOps: Readonly<Record<ScriptOpName, AdminOpEntry>> = {
  "ops.invitation.status": readOp(
    "Invitation status; no plain code.",
    community,
  ),
  "ops.invitation.create": reversibleOp(
    "Create an invitation; its code returns once.",
    "receipt",
    community,
  ),
  "ops.invitation.revoke": irreversibleOp(
    "Revoke an invitation.",
    "state_idempotent",
    community,
  ),
  "ops.access.revoke": reversibleOp(
    "Revoke a user's beta access.",
    "state_idempotent",
    community,
  ),
  "ops.access.restore": reversibleOp(
    "Restore a user's beta access.",
    "state_idempotent",
    community,
  ),
  "ops.account.provision": irreversibleOp(
    "Provision one password account; the companion sends the password.",
    "state_idempotent",
    community,
  ),
  "ops.master.candidates": readOp("A Catalog's master candidates.", base),
  "ops.master.status": readOp("A Catalog's masters and storage figures.", base),
  "ops.master.guard": readOp("Master guard counts.", base),
  "ops.master.attach": reversibleOp(
    "Attach a new deep zoom master through the companion.",
    "state_idempotent",
    { ...base, completion: asynchronous },
  ),
  "ops.master.attach_existing": reversibleOp(
    "Attach a master from bytes already stored.",
    "state_idempotent",
    { ...base, completion: asynchronous },
  ),
  "ops.master.requeue": reversibleOp(
    "Requeue a master's block rendering.",
    "state_idempotent",
    { ...base, completion: asynchronous },
  ),
  "ops.master.set_limit": reversibleOp(
    "Set a master's maximum long edge.",
    "state_idempotent",
    { ...base, completion: asynchronous },
  ),
  "ops.master.detach": reversibleOp(
    "Detach a master from its media.",
    "state_idempotent",
    base,
  ),
  "ops.master.erase": irreversibleOp(
    "Erase a detached master's bytes.",
    "state_idempotent",
    base,
  ),
  "ops.upload_gc.plan": readOp("What upload cleanup would remove."),
  "ops.upload_gc.run": irreversibleOp(
    "Run upload cleanup; off until the Owner sets its switch.",
    "state_idempotent",
  ),
};

export const otherOps: Readonly<Record<OtherOpName, AdminOpEntry>> = {
  "analytics.ips": readOp("Raw IP records, behind the rawIp switch.", {
    ...base,
    sensitive: "rawIp",
    tool: "admin_sensitive_read",
  }),
  "analytics.definition.save": reversibleOp(
    "Save a funnel or board definition.",
    "state_idempotent",
  ),
  "analytics.definition.delete": irreversibleOp(
    "Delete a definition no board references.",
    "state_idempotent",
  ),
  "analytics.prune.run": irreversibleOp(
    "Run the fixed 180-day Umami prune.",
    "state_idempotent",
    { ...base, completion: asynchronous },
  ),
  "run.cancel": reversibleOp(
    "Cancel a run with no live lease.",
    "state_idempotent",
  ),
};
