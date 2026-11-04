import type { AdminOpCredential } from "./op-meta.js";

/** The Backend credentials an AI operator can present. Both are labelled `ai-admin`. */
export type AiOperatorCredential = Exclude<AdminOpCredential, "none">;

export const AI_OPERATOR_CREDENTIALS = [
  "base",
  "community",
] as const satisfies readonly AiOperatorCredential[];

/** The audit label of every AI credential, beside the Owner's `owner`. */
export const AI_OPERATOR_LABEL = "ai-admin";

/**
 * Set only by the run engine. This does not stop a compromised Admin; it makes a
 * misclassified op fail instead of skipping preview.
 */
export const AI_OPERATOR_RUN_HEADER = "x-admin-mcp-run";

export type AiOperatorRouteClass =
  "read" | "write" | "irreversible" | "sensitive:raw_ip";

export interface AiOperatorRoute {
  readonly method: "GET" | "POST";
  /** Exact, or a prefix ending in `/*` that takes plain path segments. */
  readonly path: string;
  readonly klass: AiOperatorRouteClass;
  readonly credentials: readonly AiOperatorCredential[];
  /** Parameters that must each appear exactly once, with this value. */
  readonly query?: Readonly<Record<string, string>>;
}

const base = ["base"] as const;
const master = "/internal/community/ai/catalog-master";

/**
 * Where an AI credential may go on the Backend (admin-mcp-completion-v1 section 2).
 * Default deny: a method and path with no row answers 403, binary routes included,
 * and so do `agent/*`, delegations and principals. These are the base credential's
 * routes, so Catalog work and analytics never need the community token.
 */
export const AI_OPERATOR_ROUTES: readonly AiOperatorRoute[] = [
  {
    method: "GET",
    path: "/internal/community/catalog-delivery/thumbnail",
    klass: "read",
    credentials: base,
  },
  // Job subjects are media item or Catalog asset ids. Settling a work, an article
  // or a user reads community state, so those are not on this credential.
  {
    method: "GET",
    path: "/internal/community/ai/settlement",
    klass: "read",
    credentials: base,
    query: { type: "item" },
  },
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
  {
    method: "GET",
    path: "/internal/analytics/insights/*",
    klass: "read",
    credentials: base,
  },
  {
    method: "POST",
    path: "/internal/analytics/insights/prune",
    klass: "irreversible",
    credentials: base,
  },
  {
    method: "GET",
    path: "/internal/community/analytics/ips",
    klass: "sensitive:raw_ip",
    credentials: base,
  },
];

const plainSegments = /^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/u;

const pathMatches = (pattern: string, pathname: string): boolean =>
  pattern.endsWith("/*")
    ? pathname.startsWith(pattern.slice(0, -1)) &&
      plainSegments.test(pathname.slice(pattern.length - 1))
    : pathname === pattern;

/** The row deciding this request, or undefined, which is a refusal. */
export const aiOperatorRouteFor = (
  method: string,
  pathname: string,
  query: URLSearchParams,
): AiOperatorRoute | undefined =>
  AI_OPERATOR_ROUTES.find(
    (route) =>
      route.method === method &&
      pathMatches(route.path, pathname) &&
      Object.entries(route.query ?? {}).every(([name, value]) => {
        const values = query.getAll(name);
        return values.length === 1 && values[0] === value;
      }),
  );
