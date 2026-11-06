import type {
  AdminMcpCompanionTool,
  AdminMcpNativeTool,
  AdminOpName,
} from "@moya/contracts/internal/admin-mcp";

import { agentAdminOperationNames } from "../community/agent-operations";

/**
 * Every Admin route, collection, view, page and operator command that no op is
 * named after, mapped to what covers it (admin-mcp-completion-v1 section 5). A route
 * of community/endpoints.ts or editorial/endpoints.ts maps to the op of its own
 * name and needs no row here. tests/unit/backend/admin-mcp-registry.test.ts walks
 * the real sources: a surface with no row fails, and so does a row with no surface.
 */
export type AdminSurfaceExclusion =
  "reserved" | "human-ui" | "dev-only" | "config" | "outside-parity";

export type AdminSurface =
  | { readonly op: readonly AdminOpName[]; readonly note?: string }
  | { readonly tool: readonly AdminMcpNativeTool[]; readonly note?: string }
  | {
      readonly companion: readonly AdminMcpCompanionTool[];
      readonly note?: string;
    }
  | { readonly excluded: AdminSurfaceExclusion; readonly why: string };

const humanUi = (why: string): AdminSurface => ({ excluded: "human-ui", why });
const reserved = (why: string): AdminSurface => ({ excluded: "reserved", why });
const devOnly = (why: string): AdminSurface => ({ excluded: "dev-only", why });
const config = (why: string): AdminSurface => ({ excluded: "config", why });
const op = (...names: readonly AdminOpName[]): AdminSurface => ({ op: names });
const tool = (...names: readonly AdminMcpNativeTool[]): AdminSurface => ({
  tool: names,
});
const companion = (
  ...names: readonly AdminMcpCompanionTool[]
): AdminSurface => ({
  companion: names,
});

const media = { tool: ["admin_view_media"] } as const;
const mediaAndFile: AdminSurface = {
  tool: ["admin_view_media"],
  note: "video derivatives through files_download",
};

export const ADMIN_SURFACES: Readonly<Record<string, AdminSurface>> = {
  // Routes with no op of their own name.
  ...Object.fromEntries(
    agentAdminOperationNames.map((name) => [
      `endpoint POST /community-moderation/${name}`,
      devOnly("the agent boundary"),
    ]),
  ),
  "endpoint POST /community-moderation/moderate-comments": {
    op: ["community.moderate-comment"],
    note: "per-target outcomes need single calls",
  },
  "endpoint GET /community-moderation/work-submission-media/:revisionId/:itemId/:variant/:editKey":
    mediaAndFile,
  "endpoint GET /community-moderation/article-submission-media/:id": media,
  "endpoint GET /community-moderation/report-evidence/:id/:evidenceId": {
    companion: ["files_download"],
    note: "behind the evidence switch",
  },
  "endpoint GET /community-moderation/feedback-media/:feedbackId/:itemId/:variant":
    media,
  "endpoint GET /community-moderation/comment-media/:commentId/:itemId/:variant":
    media,
  "endpoint GET /analytics/status": tool("admin_analytics"),
  "endpoint GET /analytics/ips": op("analytics.ips"),
  "endpoint POST /analytics/exclude-device": humanUi(
    "marks one browser, not an account",
  ),
  "endpoint POST /editorial/media-upload/start": companion("files_upload"),
  "endpoint POST /editorial/media-upload/status": companion("files_upload"),
  "endpoint POST /editorial/media-upload/chunk/:uploadId/:index":
    companion("files_upload"),
  "endpoint POST /editorial/media-upload/stream/:uploadId/:offset":
    companion("files_upload"),
  "endpoint POST /editorial/media-upload/complete": companion("files_upload"),
  "endpoint POST /editorial/media-ingest/start": companion("files_upload"),
  "endpoint POST /editorial/media-ingest/complete": companion("files_upload"),
  "endpoint POST /editorial/media-ingest/abandon": companion("files_upload"),
  "endpoint POST /editorial/media-ingest/verify": companion("files_upload"),
  "endpoint PUT /editorial/media-ingest/dev-put/:ingestId": devOnly(
    "the Development store's stand-in for a signed PUT",
  ),
  "endpoint GET /catalog-media-thumbnail": tool("admin_view_media"),
  "endpoint GET /access": humanUi(
    "what the Admin screen may show this session",
  ),
  "endpoint GET /editorial/preview/:id": {
    tool: ["admin_get"],
    note: "the rendered page through files_render_preview",
  },
  "endpoint POST /mcp": config("the transport these tools arrive on"),
  "endpoint GET /mcp": config("the transport these tools arrive on"),
  "endpoint POST /mcp-control/keys/:id/renew": reserved("key renewal"),
  "endpoint POST /mcp-control/runs/:id/confirm": reserved(
    "the Owner's confirmation of a run past the threshold",
  ),
  "endpoint POST /mcp-control/runs/:id/cancel": reserved(
    "the Owner's cancel of a run",
  ),
  "endpoint POST /agent-connections/consent": reserved(
    "approving or denying an AI connection",
  ),
  "endpoint GET /agent-connections": reserved("the list of AI connections"),
  "endpoint POST /agent-connections/start": devOnly(
    "the Development page's start button",
  ),
  "endpoint POST /agent-connections/disconnect": reserved(
    "disconnecting an AI connection",
  ),

  // Collections.
  "collection users": reserved("Admin accounts"),
  "collection catalogs": op(
    "list.catalogs",
    "editorial.save-draft",
    "catalog.publish",
  ),
  "collection media": op("list.media", "media.update_metadata"),
  "collection editorial-identities": op("editorial.save-draft"),
  "collection editorial-approvals": op("list.approvals", "approval.revoke"),
  "collection editorial-receipts": op("list.receipts"),
  "collection articles": op("list.articles", "editorial.save-article-draft"),
  "collection article-collections": op("list.collections", "collection.save"),
  "collection editorial-article-approvals": op(
    "list.article_approvals",
    "approval.revoke",
  ),
  "collection mcp-audit-events": reserved("audit records"),
  "collection payload-mcp-api-keys": reserved("MCP keys"),
  "collection payload-kv": config("Payload's internal store"),
  "collection payload-locked-documents": op(
    "document.lock_takeover",
    "document.lock_release",
  ),
  "collection payload-preferences": humanUi("Admin screen preferences"),
  "collection payload-migrations": config("schema history"),
  "global mcp-control": reserved("pause, threshold and sensitive switches"),

  // Views, by their config key.
  "view dashboard": op("list.overview"),
  "view analytics": tool("admin_analytics"),
  "view analyticsIps": op("analytics.ips"),
  "view analyticsBoard": tool("admin_analytics"),
  "view analyticsStatus": tool("admin_analytics"),
  "view mcpControl": reserved("the Owner's control page"),
  "view editorialWorkflow": op("list.review_page", "editorial.approve-batch"),
  "view communityModeration": op("list.comments", "community.moderate-comment"),
  "view communityReports": op("list.reports", "community.decide-report"),
  "view communityAppeals": op("list.appeals", "community.review-report"),
  "view communityThreads": op("list.threads", "community.update-thread"),
  "view communityDirectMessages": op("community.read-dm-conversation"),
  "view communitySettings": op("list.policy", "community.set-policy"),
  "view communityContent": op("list.works", "community.moderate-work"),
  "view communityFeedback": op("list.feedback"),
  "view communityHistory": op("list.events"),
  "view communityArticleSubmissions": op(
    "list.article_submissions",
    "community.moderate-article-submission",
  ),
  "view communityWorkSubmissions": op(
    "list.work_submissions",
    "community.moderate-work-submission",
  ),
  "view agentConnections": reserved("the AI connections page"),
  "view agentConnectionsConsent": reserved("the consent page"),
  "view communityAccountCapacity": op(
    "community.read-account-capacity",
    "community.set-account-capacity",
  ),
  "view communityPublishingJobs": op(
    "list.jobs",
    "community.retry-publishing-job",
  ),
  "view communityAgentOperations": devOnly("AI operations"),

  // Workspace pages, by their href.
  "page /admin": op("list.overview"),
  "page /admin/collections/catalogs": op("list.catalogs"),
  "page /admin/collections/media": op("list.media"),
  "page /admin/collections/articles": op("list.articles"),
  "page /admin/collections/article-collections": op("list.collections"),
  "page /admin/community-moderation/content": op("list.works"),
  "page /admin/community-moderation/content?tab=featured": op("list.featured"),
  "page /admin/community-moderation/threads": op("list.threads"),
  "page /admin/community-moderation": op("list.comments"),
  "page /admin/community-moderation/work-submissions": op(
    "list.work_submissions",
  ),
  "page /admin/community-moderation/article-submissions": op(
    "list.article_submissions",
  ),
  "page /admin/community-moderation/reports": op("list.reports"),
  "page /admin/community-moderation/appeals": op("list.appeals"),
  "page /admin/community-moderation/direct-messages": op(
    "community.read-dm-conversation",
  ),
  "page /admin/community-moderation/feedback": op("list.feedback"),
  "page /admin/community-moderation/content?tab=users": op("list.users"),
  "page /admin/community-moderation/account-capacity": op(
    "community.read-account-capacity",
  ),
  "page /admin/analytics": tool("admin_analytics"),
  "page /admin/analytics/board": tool("admin_analytics"),
  "page /admin/analytics/ips": op("analytics.ips"),
  "page /admin/analytics/status": tool("admin_analytics"),
  "page /admin/editorial-workflow": op("list.review_page"),
  "page /admin/collections/editorial-approvals": op("list.approvals"),
  "page /admin/collections/editorial-article-approvals": op(
    "list.article_approvals",
  ),
  "page /admin/community-moderation/publishing-jobs": op("list.jobs"),
  "page /admin/community-moderation/agent-operations": devOnly("AI operations"),
  "page /admin/agent-connections": reserved("the AI connections page"),
  "page /admin/community-moderation/history": op("list.events"),
  "page /admin/collections/editorial-receipts": op("list.receipts"),
  "page /admin/collections/mcp-audit-events": reserved("audit records"),
  "page /admin/community-moderation/settings": op(
    "list.policy",
    "list.work_settings",
  ),
  "page /admin/collections/users": reserved("Admin accounts"),
  "page /admin/collections/payload-mcp-api-keys": reserved("MCP keys"),
  "page /admin/mcp-control": reserved("the Owner's control page"),

  // catalog-master commands.
  "command catalog-master candidates": op("ops.master.candidates"),
  "command catalog-master manifest": companion("files_master_plan"),
  "command catalog-master attach": {
    op: ["ops.master.attach", "ops.master.attach_existing"],
    note: "new bytes through files_master_attach",
  },
  "command catalog-master attach-batch": companion("files_master_attach"),
  "command catalog-master status": op("ops.master.status"),
  "command catalog-master requeue": op("ops.master.requeue"),
  "command catalog-master set-limit": op("ops.master.set_limit"),
  "command catalog-master detach": op("ops.master.detach"),
  "command catalog-master erase": op("ops.master.erase"),
  "command catalog-master guard": op("ops.master.guard"),

  // manage-registration-invitations commands.
  "command invitations create": op("ops.invitation.create"),
  "command invitations status": op("ops.invitation.status"),
  "command invitations revoke": op("ops.invitation.revoke"),
  "command invitations revoke-access": op("ops.access.revoke"),
  "command invitations restore-access": op("ops.access.restore"),

  // Other operator scripts and CLIs.
  "script scripts/provision-password-account.mjs": {
    op: ["ops.account.provision"],
    note: "through files_account_provision",
  },
  "script scripts/analytics/bootstrap-umami.mjs": config("deployment"),
  "script scripts/analytics/build-umami-image.mjs": config("deployment"),
  "script scripts/analytics/common.mjs": config("a library of these scripts"),
  "script scripts/analytics/export-canonical.mjs": companion("files_download"),
  "script scripts/analytics/export-umami-runtime.mjs": config("deployment"),
  "script scripts/analytics/generate-admin-shell-assets.mjs": config("build"),
  "script scripts/analytics/prune-umami.mjs": op("analytics.prune.run"),
  "script scripts/analytics/render-client-ip-trust.mjs": config("deployment"),
  "script scripts/analytics/rotate-umami-password.mjs": config("credentials"),
  "script scripts/analytics/runtime-policy.mjs": config(
    "a library of these scripts",
  ),
  "script scripts/analytics/seed-synthetic-umami.mjs":
    devOnly("synthetic data"),
  "script scripts/analytics/summarize-traffic.mjs": tool("admin_analytics"),
  "cli catalog-importer catalog-import:validate-xlsx":
    companion("files_import"),
  "cli catalog-importer p5:api-audit": companion("files_import"),
  "cli catalog-importer p5:apply-validation": companion("files_import"),
  "cli catalog-importer p5:validate": companion("files_import"),
  "cli pilot prepare": companion("files_import"),
  "cli pilot apply": companion("files_import"),
  "cli pilot media": companion("files_import"),
  "cli admin cms:migrate": config("migrations"),
  "cli admin cms:migrate:create": config("migrations"),
  "cli admin cms:types": config("build"),
  "cli admin cms:importmap": config("build"),
  "cli admin cms:legacy": companion("files_import"),
  "cli admin cms:upload-gc": op("ops.upload_gc.plan", "ops.upload_gc.run"),
};
