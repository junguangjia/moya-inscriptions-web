import { threadIdSchema } from "@moya/contracts/schemas";

import type { ThreadId } from "@moya/contracts";

/** A Thread id from an untrusted path segment, or null when it is not one. */
export const parseThreadId = (value: string): ThreadId | null => {
  const parsed = threadIdSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
};
