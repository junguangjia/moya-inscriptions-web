import {
  ANALYTICS_INSIGHT_REPORTS,
  ANALYTICS_INSIGHTS_PATH,
} from "./analytics.js";
import type { AdminOpCredential } from "./op-meta.js";

/** The Backend credentials an AI operator can present. Both are labelled `ai-admin`. */
export type AiOperatorCredential = Exclude<AdminOpCredential, "none">;

export const AI_OPERATOR_CREDENTIALS = [
  "base",
  "community",
] as const satisfies readonly AiOperatorCredential[];

/** The audit label of every AI credential, beside the Owner's `owner`. */
export const AI_OPERATOR_LABEL = "ai-admin";

/** A self-only work, or what it withholds: it exists, and it is the Owner's. */
export const SELF_ONLY_OWNER_REVIEW = "SELF_ONLY_OWNER_REVIEW";

/**
 * A person's own request about their personal information: a `privacy` report on their
 * own profile. AI reads it, and every AI write on the case answers this, because the
 * public policy has the Owner verify and handle it.
 */
export const PERSONAL_INFO_OWNER_REVIEW = "PERSONAL_INFO_OWNER_REVIEW";

/** Urgent is one-way for AI: it can raise a case and not lower it. */
export const URGENT_OWNER_ONLY = "URGENT_OWNER_ONLY";

/**
 * Set only by the run engine. This does not stop a compromised Admin; it makes a
 * misclassified op fail instead of skipping preview.
 */
export const AI_OPERATOR_RUN_HEADER = "x-admin-mcp-run";

const RUN_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/**
 * A run header the engine could have set: one run id, a uuid. Anything else, a word,
 * a repeated header or an empty one, is no run header at all.
 */
export const isAiRunHeader = (value: unknown): value is string =>
  typeof value === "string" && RUN_ID.test(value);

/**
 * This target's key on a write whose body has no `requestId`: the comment, user and
 * policy routes, whose receipt the route builds from it, so a retry replays and never
 * moderates twice.
 */
export const AI_OPERATOR_REQUEST_ID_HEADER = "x-operator-request-id";

export type AiOperatorRouteClass =
  | "read"
  | "write"
  | "irreversible"
  | "sensitive:raw_ip"
  | "sensitive:dm"
  | "sensitive:evidence";

export interface AiOperatorRoute {
  readonly method: "GET" | "POST" | "PUT";
  /**
   * Exact, but for whole `:name` segments: a prefix would pass a future route
   * unclassified.
   */
  readonly path: string;
  readonly klass: AiOperatorRouteClass;
  readonly credentials: readonly AiOperatorCredential[];
  /** Parameters that must each appear exactly once, with this value. */
  readonly query?: Readonly<Record<string, string>>;
  /**
   * The route's `:id` names this record: while it is self-only, or for an Article
   * while it uses an item of a self-only work, or for a job while its subject is a
   * self-only work, the route answers SELF_ONLY_OWNER_REVIEW, and withheld never reads
   * as not found.
   */
  readonly selfOnly?:
    | "work"
    | "comment"
    | "work_revision"
    | "article"
    | "report"
    | "publishing_job";
}

const base = ["base"] as const;
const community = ["community"] as const;
const master = "/internal/community/ai/catalog-master";
const internal = "/internal/community";

const communityRead = (
  path: string,
  selfOnly?: AiOperatorRoute["selfOnly"],
): AiOperatorRoute => ({
  method: "GET",
  path: `${internal}/${path}`,
  klass: "read",
  credentials: community,
  ...(selfOnly === undefined ? {} : { selfOnly }),
});

const communityWrite = (
  method: "POST" | "PUT",
  path: string,
  selfOnly?: AiOperatorRoute["selfOnly"],
): AiOperatorRoute => ({
  method,
  path: `${internal}/${path}`,
  klass: "write",
  credentials: community,
  ...(selfOnly === undefined ? {} : { selfOnly }),
});

/**
 * Where an AI credential may go on the Backend (admin-mcp-completion-v1 section 2).
 * Default deny: a method and path with no row answers 403, binary routes included,
 * and so do `agent/*`, delegations and principals. The base credential's routes are
 * apart, so Catalog work and analytics never need the community token. The
 * irreversible community writes join with the run engine, which sets their header.
 */
export const AI_OPERATOR_ROUTES: readonly AiOperatorRoute[] = [
  {
    method: "GET",
    path: "/internal/community/catalog-delivery/thumbnail",
    klass: "read",
    credentials: base,
  },
  // Job subjects are media item or Catalog asset ids, so Catalog work settles without
  // the community token. Settling a work, an article or a user reads community state,
  // so those are on that credential alone.
  {
    method: "GET",
    path: "/internal/community/ai/settlement",
    klass: "read",
    credentials: ["base", "community"],
    query: { type: "item" },
  },
  ...(["work", "article", "user"] as const).map((type): AiOperatorRoute => ({
    method: "GET",
    path: "/internal/community/ai/settlement",
    klass: "read",
    credentials: community,
    query: { type },
  })),
  {
    method: "GET",
    path: `${master}/candidates`,
    klass: "read",
    credentials: base,
  },
  { method: "GET", path: `${master}/status`, klass: "read", credentials: base },
  { method: "GET", path: `${master}/guard`, klass: "read", credentials: base },
  {
    method: "POST",
    path: `${master}/attach`,
    klass: "write",
    credentials: base,
  },
  {
    method: "POST",
    path: `${master}/attach-existing`,
    klass: "write",
    credentials: base,
  },
  {
    method: "POST",
    path: `${master}/requeue`,
    klass: "write",
    credentials: base,
  },
  {
    method: "POST",
    path: `${master}/set-limit`,
    klass: "write",
    credentials: base,
  },
  {
    method: "POST",
    path: `${master}/detach`,
    klass: "write",
    credentials: base,
  },
  {
    method: "POST",
    path: `${master}/erase`,
    klass: "irreversible",
    credentials: base,
  },
  // `export` and `traffic` have no handler yet.
  ...[...ANALYTICS_INSIGHT_REPORTS, "export", "traffic"].map(
    (report): AiOperatorRoute => ({
      method: "GET",
      path: `${ANALYTICS_INSIGHTS_PATH}/${report}`,
      klass: "read",
      credentials: base,
    }),
  ),
  {
    method: "POST",
    path: `${ANALYTICS_INSIGHTS_PATH}/prune`,
    klass: "irreversible",
    credentials: base,
  },
  {
    method: "GET",
    path: "/internal/community/analytics/ips",
    klass: "sensitive:raw_ip",
    credentials: base,
  },
  communityRead("ai/find"),
  communityRead("ai/count"),
  communityRead("ai/select"),
  communityRead("reports"),
  communityRead("reports/:id"),
  {
    method: "GET",
    path: `${internal}/reports/:id/evidence/:evidenceId`,
    klass: "sensitive:evidence",
    credentials: community,
  },
  communityRead("feedback"),
  communityRead("feedback/:id/images/:itemId/:variant"),
  communityRead("works"),
  communityRead("users"),
  communityRead("featured"),
  communityRead("threads"),
  communityRead("publication-policy"),
  communityRead("comments"),
  communityRead("comments/:id", "comment"),
  communityRead("comments/:id/images/:itemId/:variant", "comment"),
  communityRead("moderation-events"),
  communityRead("summary"),
  communityRead("publishing/settings"),
  communityRead("publishing/submissions"),
  communityRead("publishing/submissions/:id", "work_revision"),
  communityRead(
    "publishing/media/:id/:itemId/:variant/:editKey",
    "work_revision",
  ),
  communityRead("publishing/accounts/:id/capacity"),
  communityRead("publishing/jobs"),
  communityRead("articles/submissions"),
  communityRead("articles/:id/submission"),
  communityRead("articles/:id/submission-media", "article"),
  ...["conversation", "lookup", ":id/remove"].map((leaf): AiOperatorRoute => ({
    method: "POST",
    path: `${internal}/messages/${leaf}`,
    klass: "sensitive:dm",
    credentials: community,
  })),
  communityWrite("POST", "reports/:id/decisions", "report"),
  communityWrite("POST", "reports/:id/review", "report"),
  communityWrite("POST", "reports/:id/metadata", "report"),
  communityWrite("POST", "comments/:id/moderation", "comment"),
  communityWrite("POST", "users/:id/status"),
  communityWrite("PUT", "users/recommendation"),
  communityWrite("POST", "works/:id/moderation", "work"),
  // Names its work in the body, so the route's handler asks the self-only question.
  communityWrite("PUT", "featured"),
  communityWrite("PUT", "featured/settings"),
  communityWrite("PUT", "publication-policy"),
  communityWrite("POST", "threads"),
  communityWrite("POST", "threads/:id"),
  communityWrite("PUT", "publishing/settings"),
  communityWrite(
    "POST",
    "publishing/submissions/:id/moderation",
    "work_revision",
  ),
  communityWrite("PUT", "publishing/accounts/:id/capacity"),
  communityWrite("POST", "publishing/jobs/:id/retry", "publishing_job"),
  communityWrite("POST", "articles/:id/moderation", "article"),
  // home-timeline-v1 (Issue #384 r3): reference rows, no self-only record. The
  // three top-level paths differ, so an entry id never matches another row.
  communityRead("timeline-entries"),
  communityRead("timeline-summary"),
  communityWrite("POST", "timeline-entries"),
  communityWrite("POST", "timeline-entries/:id"),
  communityWrite("POST", "timeline-order"),
  // timeline-posts-v1: posts on timeline rows. The read leaves self-only works
  // out by itself; a write names its work, so it is withheld by the route.
  communityRead("timeline-posts"),
  communityWrite("POST", "timeline-posts/:id", "work"),
];

const segmentsMatch = (pattern: string, pathname: string): boolean => {
  const expected = pattern.split("/");
  const actual = pathname.split("/");
  return (
    expected.length === actual.length &&
    expected.every(
      (segment, index) =>
        actual[index] === segment ||
        (segment.startsWith(":") && actual[index] !== ""),
    )
  );
};

/** The segment a route's `:id` holds, as sent. */
export const aiOperatorRouteId = (
  route: AiOperatorRoute,
  pathname: string,
): string | undefined => {
  const index = route.path.split("/").indexOf(":id");
  return index < 0 ? undefined : pathname.split("/")[index];
};

/** The row deciding this request, or undefined, which is a refusal. */
export const aiOperatorRouteFor = (
  method: string,
  pathname: string,
  query: URLSearchParams,
): AiOperatorRoute | undefined =>
  AI_OPERATOR_ROUTES.find(
    (route) =>
      route.method === method &&
      segmentsMatch(route.path, pathname) &&
      Object.entries(route.query ?? {}).every(([name, value]) => {
        const values = query.getAll(name);
        return values.length === 1 && values[0] === value;
      }),
  );
