import { z } from "zod";

/** Human moderation reasons are required at the Owner HTTP/Admin boundary. */
export const operatorModerationReasonSchema = z
  .string()
  .trim()
  .min(1)
  .max(2000);
