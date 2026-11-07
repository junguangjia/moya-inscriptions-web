/**
 * The top-level tools of the native path, in listing order. A slice adds a tool
 * to apps/admin/src/admin-mcp/tools, never here at runtime; 15 at most, by test.
 */
export const ADMIN_MCP_NATIVE_TOOLS = [
  "admin_whoami",
  "admin_find",
  "admin_get",
  "admin_read",
  "admin_analytics",
  "admin_actions",
  "admin_view_media",
  "admin_job",
  "admin_sensitive_read",
  "admin_preview",
  "admin_execute",
  "admin_execute_irreversible",
] as const;

/** The local stdio process beside the client. It never runs on the server. */
export const ADMIN_MCP_COMPANION_TOOLS = [
  "files_upload",
  "files_download",
  "files_import",
  "files_status",
  "files_render_preview",
  "files_master_plan",
  "files_master_attach",
  "files_account_provision",
] as const;

/**
 * Every op an `ai_operator` key can name, as family plus existing endpoint name
 * (admin-mcp-completion-v1 section 5). adminOpMeta in apps/admin is a
 * Record over this list, so an unclassified op fails typecheck.
 */
export const ADMIN_OP_NAMES = [
  // community/endpoints.ts, every route but moderate-comments, because per-target
  // outcomes need single calls.
  "community.read-reports",
  "community.read-report",
  "community.decide-report",
  "community.review-report",
  "community.set-report-metadata",
  "community.forward-report",
  "community.read-feedback",
  "community.read-works",
  "community.read-users",
  "community.recommend-user",
  "community.moderate-work",
  "community.read-featured",
  "community.set-featured",
  "community.set-featured-quantity",
  "community.delete-body",
  "community.remove-thread",
  "community.read-dm-conversation",
  "community.lookup-dm-conversation",
  "community.remove-dm-message",
  "community.read-threads",
  "community.create-thread",
  "community.update-thread",
  "community.read-feature-catalogs",
  "community.read-policy",
  "community.set-policy",
  "community.read-comments",
  "community.read-comment",
  "community.moderate-comment",
  "community.moderate-user",
  "community.read-events",
  "community.read-summary",
  "community.read-work-publishing-settings",
  "community.set-work-publishing-settings",
  "community.read-article-submissions",
  "community.read-article-submission",
  "community.moderate-article-submission",
  "community.read-work-submissions",
  "community.read-work-submission",
  "community.moderate-work-submission",
  "community.read-account-capacity",
  "community.set-account-capacity",
  "community.read-publishing-jobs",
  "community.retry-publishing-job",
  "community.abandon-publishing-job",
  "community.read-timeline",
  "community.read-timeline-summary",
  "community.create-timeline-entry",
  "community.update-timeline-entry",
  "community.reorder-timeline",
  // editorial/endpoints.ts, every route.
  "editorial.owner-drafts",
  "editorial.owner-history",
  "editorial.read-draft",
  "editorial.save-draft",
  "editorial.approve-batch",
  "editorial.publish-approved",
  "editorial.restore-draft",
  "editorial.prepare-catalog-delivery",
  "editorial.read-catalog-delivery",
  "editorial.request-catalog-release",
  "editorial.release-catalog-delivery",
  "editorial.cancel-catalog-delivery",
  "editorial.catalog-delivery-capabilities",
  "editorial.catalog-render-backlog",
  "editorial.save-article-draft",
  "editorial.approve-article-batch",
  "editorial.publish-approved-article",
  // One read per queue or page.
  "list.comments",
  "list.works",
  "list.users",
  "list.threads",
  "list.featured",
  "list.feature_catalogs",
  "list.reports",
  "list.appeals",
  "list.work_submissions",
  "list.article_submissions",
  "list.jobs",
  "list.feedback",
  "list.events",
  "list.policy",
  "list.work_settings",
  "list.overview",
  "list.catalogs",
  "list.review_page",
  "list.approvals",
  "list.article_approvals",
  "list.receipts",
  "list.articles",
  "list.collections",
  "list.media",
  "list.render_backlog",
  "list.invitations",
  "list.masters",
  "list.runs",
  // CMS, on the Local API.
  "catalog.publish",
  "catalog.withdraw",
  "catalog.restore",
  "catalog.patch_text",
  "catalog.duplicate",
  "approval.revoke",
  "article.publish",
  "article.withdraw",
  "article.restore",
  "article.duplicate",
  "collection.save",
  "collection.publish",
  "collection.withdraw",
  "collection.restore",
  "collection.duplicate",
  "media.register_existing",
  "media.register_upload",
  "media.update_metadata",
  "document.lock_takeover",
  "document.lock_release",
  "catalog_search.status",
  "catalog_search.rebuild",
  // Operator scripts, as bounded server operations.
  "ops.invitation.status",
  "ops.invitation.create",
  "ops.invitation.revoke",
  "ops.access.revoke",
  "ops.access.restore",
  "ops.account.provision",
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
  // Analytics reads are reports on admin_analytics; raw IP records are not.
  "analytics.ips",
  "analytics.definition.save",
  "analytics.definition.delete",
  "analytics.prune.run",
  "run.cancel",
] as const;

export type AdminOpName = (typeof ADMIN_OP_NAMES)[number];
export type AdminMcpNativeTool = (typeof ADMIN_MCP_NATIVE_TOOLS)[number];
export type AdminMcpCompanionTool = (typeof ADMIN_MCP_COMPANION_TOOLS)[number];

/** An op's earlier name, and the op that now answers it. Dates are UTC days. */
export interface AdminOpAlias {
  readonly use: AdminOpName;
  readonly since: string;
  readonly until: string;
}

/**
 * Renamed ops, by their earlier name (extensibility plan 2.8). Until `until` that name
 * runs `use` and the answer says so in meta.deprecated; after it the name answers
 * OP_RETIRED with `use`. A row stays once retired, so an earlier name is never answered
 * as a typo. The window is at least 30 days and one Production release, the longer.
 */
export const ADMIN_OP_ALIASES: Readonly<Record<string, AdminOpAlias>> = {};
