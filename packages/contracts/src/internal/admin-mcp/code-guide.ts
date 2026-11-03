import type { AdminMcpCode } from "./envelope.js";

/** Fixed English. A hint never interpolates user content. */
export interface AdminMcpCodeGuideEntry {
  readonly hint: string;
  readonly retryable: boolean;
}

/** Exhaustive by type, so an unguided code fails typecheck. */
export type AdminMcpCodeGuide = Readonly<
  Record<AdminMcpCode, AdminMcpCodeGuideEntry>
>;
