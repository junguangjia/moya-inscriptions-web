import type {
  AdminOpName,
  AiOperatorRoute,
} from "@moya/contracts/internal/admin-mcp";
import type { AdminMcpSlice } from "admin/admin-mcp";

// What Issue #355 still has to build, by the slice that builds it. The totality test
// holds the ops with no `run` to exactly these names, so an op added without a body
// names its slice here, and a slice that builds an op deletes its name, then its key.

export const NOT_BUILT: Readonly<
  Partial<Record<AdminMcpSlice, readonly AdminOpName[]>>
> = {
  // Preview and the run engine: every irreversible community write, the duplicates
  // that bind a new identity, and the run ledger's own read and cancel.
  S8: [
    "community.forward-report",
    "community.delete-body",
    "community.remove-thread",
    "community.abandon-publishing-job",
    "catalog.duplicate",
    "article.duplicate",
    "collection.duplicate",
    "list.runs",
    "run.cancel",
  ],
  // The byte channel: a new mediaId is registered through it.
  S9: ["media.register_upload"],
  // Masters, invitations and beta access, upload cleanup.
  S10: [
    "list.invitations",
    "list.masters",
    "ops.invitation.status",
    "ops.invitation.create",
    "ops.invitation.revoke",
    "ops.access.revoke",
    "ops.access.restore",
    "ops.master.candidates",
    "ops.master.status",
    "ops.master.guard",
    "ops.master.attach",
    "ops.master.attach_existing",
    "ops.master.requeue",
    "ops.master.set_limit",
    "ops.master.detach",
    "ops.master.erase",
    "ops.upload_gc.plan",
    "ops.upload_gc.run",
  ],
  // Search rebuild and password account provisioning.
  S11: [
    "catalog_search.status",
    "catalog_search.rebuild",
    "ops.account.provision",
  ],
  // Analytics writes.
  S12: [
    "analytics.definition.save",
    "analytics.definition.delete",
    "analytics.prune.run",
  ],
  // The sensitive switches.
  S13: [
    "community.read-dm-conversation",
    "community.lookup-dm-conversation",
    "community.remove-dm-message",
    "analytics.ips",
  ],
};

/**
 * Owner routes an unbuilt op will call, with no AI row until its slice adds one. The
 * parity test meets each through the op's own definition, and fails once a row exists
 * or the op is built, so the entry goes with the slice.
 */
export const AI_ROUTE_PENDING: readonly {
  readonly op: AdminOpName;
  readonly method: AiOperatorRoute["method"];
  readonly path: AiOperatorRoute["path"];
  readonly slice: AdminMcpSlice;
}[] = [
  {
    op: "community.forward-report",
    method: "POST",
    path: "/internal/community/reports/:id/forward",
    slice: "S8",
  },
  {
    op: "community.delete-body",
    method: "POST",
    path: "/internal/community/comments/:id/delete-body",
    slice: "S8",
  },
  {
    op: "community.remove-thread",
    method: "POST",
    path: "/internal/community/comments/:id/remove-thread",
    slice: "S8",
  },
  {
    op: "community.abandon-publishing-job",
    method: "POST",
    path: "/internal/community/publishing/jobs/:id/abandon",
    slice: "S8",
  },
];
