import type { AdminMcpSensitiveCategory } from "./op-meta.js";

/**
 * The Owner's control page (admin-mcp-completion-v1 section 13). No key reads or
 * writes any of this; the door reads pause and the switches for itself.
 */
export const ADMIN_MCP_SENSITIVE_CATEGORIES = [
  "dm",
  "evidence",
  "rawIp",
  "selfOnly",
] as const satisfies readonly AdminMcpSensitiveCategory[];

/** A key lives at most this long, and a renewal starts the same clock. */
export const ADMIN_MCP_KEY_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

/** Targets in one irreversible execution before it waits for the Owner. */
export const ADMIN_MCP_DEFAULT_THRESHOLD = 20;

/**
 * Whether the published policy text covers a category. Shown on the control page;
 * it refuses nothing, because opening after the policy change is the Owner's
 * ordering. tests/unit/contracts/admin-mcp.test.ts ties it to the policy text, so
 * a release changing either side must change both.
 */
export const AI_POLICY_DISCLOSURE: Readonly<
  Record<AdminMcpSensitiveCategory, boolean>
> = { dm: false, evidence: false, rawIp: false, selfOnly: false };

/** What the Owner types to open a category. Opening nothing else asks for it. */
export const ADMIN_MCP_COMPLIANCE_PHRASES: Readonly<
  Record<AdminMcpSensitiveCategory, string>
> = {
  dm: "我确认合规，开启私信",
  evidence: "我确认合规，开启举报证据",
  rawIp: "我确认合规，开启原始 IP",
  selfOnly: "我确认合规，开启仅自己可见作品",
};

export interface AdminMcpSwitchRow {
  readonly category: AdminMcpSensitiveCategory;
  readonly label: string;
  readonly open: boolean;
  readonly openedAt: string | null;
  readonly policyCovers: boolean;
  readonly phrase: string;
}

export interface AdminMcpExpiringKey {
  readonly id: number;
  readonly label: string | null;
  readonly expiresAt: string | null;
  readonly lastUsedAt: string | null;
}

export interface AdminMcpToolTiming {
  readonly tool: string;
  readonly calls: number;
  readonly p95Ms: number;
  /** Absent where section 21 sets no budget for this tool. */
  readonly budgetMs: number | null;
}

/** What the control view hands its browser half; null reads as unavailable. */
export interface AdminMcpControlPage {
  readonly pause: boolean;
  readonly threshold: number;
  readonly switches: readonly AdminMcpSwitchRow[];
  readonly expiringKeys: readonly AdminMcpExpiringKey[];
  readonly figures: {
    /** Irreversible targets executed in the last 24 hours. */
    readonly irreversibleTargets: number;
    /** Audit starts older than five minutes with no finish. */
    readonly outcomeUnknown: number;
    readonly timings: readonly AdminMcpToolTiming[];
  } | null;
}
