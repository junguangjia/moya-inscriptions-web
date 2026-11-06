import {
  ADMIN_ANALYTICS_NATIVE_KINDS,
  ADMIN_ANALYTICS_UMAMI_FILTERS,
  ADMIN_EXECUTE_MAX_TARGETS,
  adminAnalyticsInputSchema,
  ANALYTICS_CANONICAL_DIMENSIONS,
  ANALYTICS_UMAMI_DIMENSIONS,
} from "@moya/contracts/internal/admin-mcp";
import type {
  AdminMcpNativeTool,
  AdminToolExample,
} from "@moya/contracts/internal/admin-mcp";

import { notBuilt } from "../not-built";
import type { Unbuilt } from "../not-built";
import { example } from "../ops/define";

const listed = (names: readonly string[]) => names.join(", ");

const UMAMI_FILTERS: readonly string[] = ADMIN_ANALYTICS_UMAMI_FILTERS;
const CANONICAL_FILTERS = Object.keys(
  adminAnalyticsInputSchema.shape.filter.unwrap().shape,
).filter((name) => !UMAMI_FILTERS.includes(name));

/**
 * The worked calls tools/list has no room for (section 5): each description keeps one,
 * and admin_actions `{tool}` gives the rest. Every args parses on its tool, and every op
 * it names runs there, by the registry test. A tool not built yet says which slice
 * brings it, so the table holds every native tool.
 */
export const ADMIN_TOOL_EXAMPLES: Readonly<
  Record<AdminMcpNativeTool, readonly Readonly<AdminToolExample>[] | Unbuilt>
> = {
  admin_whoami: [
    {
      args: {},
      says: "Takes no arguments: who this credential is, the tools it can call now and when it expires.",
    },
  ],
  admin_find: [
    {
      args: { query: "/catalog/abc" },
      says: "A pasted public or Admin path. Act on resolution.ref, never on the first candidate.",
    },
    {
      args: { query: "https://.../?articleId=article-..." },
      says: "A whole pasted link: the parameter that names a record decides.",
    },
    {
      args: { query: "@handle" },
      says: "A community member by handle.",
    },
    {
      args: { query: "兰亭序", type: "catalog" },
      says: "Free text on one record type. A draft Catalog matches on its title only, as typed and by one simplified-traditional conversion, so another form of a character and any draft alias are missed. Community text is matched as stored, with no such conversion. Retry in the other form before saying it does not exist.",
    },
  ],
  admin_get: [
    {
      args: { type: "catalog", id: 7 },
      says: "The default outline: each field's state, length and hash, no long text, and which version was read.",
    },
    {
      args: { type: "report", id: example.report },
      says: "A community record has outline, full and field only.",
    },
    {
      args: { type: "catalog", id: 7, field: "transcription", offset: 0 },
      says: "Long text in windows; offsets count code points.",
    },
    {
      args: {
        type: "catalog",
        id: 7,
        field: "transcription",
        find: { text: "Synthetic" },
      },
      says: "Find a passage inside one field.",
    },
    {
      args: { type: "catalog", id: 7, view: "diff", from: "published" },
      says: "What changed since the published version. view also takes full, published, preview and history.",
    },
  ],
  admin_read: [
    {
      args: {
        op: "list.catalogs",
        input: { filter: { missing: ["transcription"] } },
      },
      says: "Rows are compact: long text is only ever state, length and hash. Continue with next.",
    },
    {
      args: { op: "list.reports", input: { status: "open" } },
      says: "A community queue, with the filter of its own page.",
    },
    {
      args: {
        op: "list.catalogs",
        view: "count",
        groupBy: "dynasty",
        input: { filter: { missing: ["transcription"] } },
      },
      says: "Count in SQL with no rows.",
    },
    {
      args: {
        op: "list.reports",
        view: "count",
        groupBy: "kind",
        input: { unresolved: "true" },
      },
      says: "Count a community queue by group.",
    },
    {
      args: { op: "list.catalogs", fields: ["title", "dynasty"] },
      says: "Project rows onto the fields named.",
    },
  ],
  admin_analytics: [
    {
      args: { report: "status" },
      says: "What each store holds, from when, and what is not collected.",
    },
    {
      args: { report: "overview", range: "this_week" },
      says: "Week on week. Answers name source, range, asOf, quality and metrics by definition; unique counts never add up.",
    },
    {
      args: { report: "trend", range: "last_30_days", groupBy: "day" },
      says: "One series over time. A date-only from or to reads in tz, which defaults to Asia/Shanghai.",
    },
    {
      args: {
        report: "breakdown",
        dimension: "content",
        filter: { targetType: "work" },
      },
      says: `Top works. dimension: ${listed(ANALYTICS_CANONICAL_DIMENSIONS)}, or Umami's ${listed(ANALYTICS_UMAMI_DIMENSIONS)}. filter: ${listed(CANONICAL_FILTERS)}, or Umami's ${listed(UMAMI_FILTERS)}.`,
    },
    {
      args: {
        report: "compare",
        range: "last_week",
        dimension: "content",
        direction: "down",
      },
      says: "What dropped most against the period before.",
    },
    {
      args: {
        report: "funnel",
        steps: ["content_open", "like"],
        sameTarget: true,
      },
      says: "A funnel of two to five events, or a saved funnelId.",
    },
    { args: { report: "realtime" }, says: "Online now." },
    {
      args: { report: "sessions", range: "today" },
      says: "Sessions in a range, newest first.",
    },
    {
      args: { report: "session", visitorId: example.requestId },
      says: "One visitor's sessions and steps.",
    },
    {
      args: { report: "product", range: "last_7_days" },
      says: "Counts from the business tables.",
    },
    {
      args: { report: "native", kind: "retention", range: "last_30_days" },
      says: `Umami's own reports. kind: ${listed(ADMIN_ANALYTICS_NATIVE_KINDS)}.`,
    },
    {
      args: { report: "reconcile", range: "last_week" },
      says: "Canonical against Umami, day by day, each difference explained.",
    },
  ],
  admin_actions: [
    {
      args: {},
      says: "The index: every op this credential can call, by tool, as name(required,fields).",
    },
    {
      args: { ops: ["list.catalogs", "editorial.save-draft"] },
      says: "Each op's JSON Schema, class, recovery, completion and an example.",
    },
    {
      args: { tool: "admin_analytics" },
      says: "That tool's worked calls, as here.",
    },
  ],
  admin_view_media: [
    {
      args: { kind: "catalog_thumb", mediaId: "media-1" },
      says: "A Catalog thumbnail as WebP of at most 512 KiB, original and rendered size in the text.",
    },
    {
      args: {
        kind: "catalog_original",
        mediaId: "media-1",
        region: { left: 0, top: 0, width: 800, height: 600 },
      },
      says: "One passage of the original, in its own pixels. Save a transcription only from text you can read; if you cannot read it, say so.",
    },
  ],
  admin_job: [
    {
      args: {
        kind: "settlement",
        refs: [{ type: "work", id: example.work, intent: "publish" }],
      },
      says: "Copy refs from a QUEUED answer's next; the op is not repeated. ok:true once no job is open or failed; else QUEUED or MEDIA_JOB_FAILED.",
    },
  ],
  admin_sensitive_read: notBuilt("S13"),
  admin_preview: [
    {
      args: {
        requestId: "hide-spam-1",
        op: "community.moderate-comment",
        input: { action: "hide", reason: example.reason },
        targets: [{ id: example.comment }],
        expectedCount: 2,
      },
      says: "Freezes each target's input and state, and runs nothing; a call takes up to 5,000 targets. expectedCount says how many the run will hold: it seals when that many are frozen, and until then answers IN_PROGRESS with remaining.",
    },
    {
      args: {
        requestId: "hide-spam-1",
        previewId: example.requestId,
        chunkSeq: 1,
        appendTargets: [{ id: `comment-${"0".repeat(31)}c` }],
      },
      says: "The next chunk of up to 5,000 targets, numbered from 1, under the run's own requestId. The same number with the same targets replays; a slip in one target refuses the whole chunk, so count stays true.",
    },
    {
      args: {
        requestId: "new-record-1",
        op: "editorial.save-draft",
        targets: [
          {
            content: {
              catalogId: "synthetic-catalog",
              sourceId: "synthetic-source",
              kind: "inscription",
              title: "Synthetic title",
            },
          },
        ],
      },
      says: "A save that binds a new identity is irreversible: the preview says so, with needsOwnerConfirmation past the Owner's threshold, and gives no next.",
    },
  ],
  admin_execute: [
    {
      args: {
        requestId: "publish-approved-3",
        op: "editorial.publish-approved",
        input: { approvalId: 3 },
        targets: [{ id: 7 }, { id: 8 }],
      },
      says: `One op on up to ${ADMIN_EXECUTE_MAX_TARGETS} targets, in order, each with its own outcome; each target merges over input.`,
    },
    {
      args: {
        requestId: "save-draft-7",
        op: "editorial.save-draft",
        input: {
          id: 7,
          expectedRevision: 4,
          content: {
            catalogId: "synthetic-catalog",
            sourceId: "synthetic-source",
            kind: "inscription",
            title: "Synthetic title",
          },
        },
      },
      says: "One write. A new requestId per intention: the same one replays and never repeats, and it is what to retry after OUTCOME_UNKNOWN.",
    },
    {
      args: {
        requestId: "publish-approved-3",
        op: "editorial.publish-approved",
        input: { approvalId: 3 },
        targets: [{ id: 7 }, { id: 8 }],
        startAt: 1,
      },
      says: "Go on from a target, as next does. ok:true means every target's whole effect completed; anything else names each target's state in data.",
    },
    {
      args: { requestId: "hide-spam-run-1", previewId: example.requestId },
      says: "Run a reversible run admin_preview sealed, past 100 targets with no cap. Nothing else travels: what runs is what was frozen. Each call runs what its budget allows; follow next to go on.",
    },
  ],
  admin_execute_irreversible: [
    {
      args: { requestId: "new-records-1", previewId: example.requestId },
      says: "Run an irreversible run admin_preview sealed. A target that moved since its preview is a conflict and does not run. Past the Owner's threshold it answers AWAITING_OWNER with the control page path and expiresAt.",
    },
    {
      args: { requestId: "new-records-2", runId: example.requestId },
      says: "Go on after the Owner confirms, or after IN_PROGRESS: runId and previewId are one id, and any requestId resumes it; no target runs twice.",
    },
  ],
};
