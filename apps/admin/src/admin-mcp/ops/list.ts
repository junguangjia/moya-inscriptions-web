import type { AdminOpName } from "@moya/contracts/internal/admin-mcp";

import { communityOps } from "./community";
import { readOp, type AdminOpEntry } from "./define";
import { editorialOps } from "./editorial";
import { LIST_SOURCES, runListSource } from "./list-sources";
import type { ListSource } from "./list-sources";

type ListOpName = Extract<AdminOpName, `list.${string}`>;

/** A queue read on the operation its page already uses. */
const on = (
  source: AdminOpEntry,
  summary: string,
  facts: Partial<AdminOpEntry> = {},
): AdminOpEntry => ({ ...source, summary, ...facts });

const communityOnly = { credential: "community" } as const;

/** A CMS source: built here, with the filter its row and count both answer to. */
const ofSource = (
  source: ListSource,
  example: Readonly<Record<string, unknown>>,
): Partial<AdminOpEntry> => ({
  input: source.input,
  run: runListSource(source),
  example,
});

/** One read per queue or page. Filters beyond the page's own arrive with the op. */
export const listOps: Readonly<Record<ListOpName, AdminOpEntry>> = {
  "list.comments": on(
    communityOps["community.read-comments"],
    "Comment queue.",
  ),
  "list.works": on(communityOps["community.read-works"], "Works page."),
  "list.users": on(communityOps["community.read-users"], "Website users page."),
  "list.threads": on(communityOps["community.read-threads"], "Threads page."),
  "list.featured": on(
    communityOps["community.read-featured"],
    "Featured page.",
  ),
  "list.feature_catalogs": on(
    communityOps["community.read-feature-catalogs"],
    "Catalogs that can be featured.",
  ),
  "list.reports": on(communityOps["community.read-reports"], "Report queue."),
  "list.appeals": on(communityOps["community.read-reports"], "Appeal queue.", {
    example: { status: "appealed" },
  }),
  "list.work_submissions": on(
    communityOps["community.read-work-submissions"],
    "Work submission queue.",
  ),
  "list.article_submissions": on(
    communityOps["community.read-article-submissions"],
    "Article submission queue.",
  ),
  "list.jobs": on(
    communityOps["community.read-publishing-jobs"],
    "Publishing jobs.",
  ),
  "list.feedback": on(
    communityOps["community.read-feedback"],
    "Feedback page.",
  ),
  "list.events": on(
    communityOps["community.read-events"],
    "Community history.",
  ),
  "list.policy": on(communityOps["community.read-policy"], "Comment policy."),
  "list.work_settings": on(
    communityOps["community.read-work-publishing-settings"],
    "Work publishing settings.",
  ),
  "list.overview": on(
    communityOps["community.read-summary"],
    "Workbench counts.",
  ),
  "list.catalogs": readOp(
    "Catalog rows, drafts unless asked, with filters.",
    ofSource(LIST_SOURCES.catalogs, {
      filter: { missing: ["transcription"] },
    }),
  ),
  "list.review_page": on(
    editorialOps["editorial.owner-drafts"],
    "Batch review page.",
  ),
  "list.approvals": readOp(
    "Catalog approval batches.",
    ofSource(LIST_SOURCES.approvals, { filter: { status: "active" } }),
  ),
  "list.article_approvals": readOp(
    "Article approval batches.",
    ofSource(LIST_SOURCES.article_approvals, { filter: { status: "active" } }),
  ),
  "list.receipts": readOp(
    "Batch execution receipts.",
    ofSource(LIST_SOURCES.receipts, { filter: { status: "rejected" } }),
  ),
  "list.articles": readOp(
    "Editorial Articles.",
    ofSource(LIST_SOURCES.articles, { filter: { status: "draft" } }),
  ),
  "list.collections": readOp(
    "Article collections.",
    ofSource(LIST_SOURCES.collections, { filter: { status: "draft" } }),
  ),
  "list.media": readOp(
    "Media rows, with filters.",
    ofSource(LIST_SOURCES.media, {
      filter: { catalogId: "synthetic-catalog" },
    }),
  ),
  "list.render_backlog": on(
    editorialOps["editorial.catalog-render-backlog"],
    "Render backlog counts.",
  ),
  "list.invitations": readOp(
    "Registration invitations; no plain code.",
    communityOnly,
  ),
  "list.masters": readOp("Deep zoom masters.", { credential: "base" }),
  "list.runs": readOp("This key's preview and bulk runs."),
};
