import { z } from "zod";
import { feedbackIdSchema, publicUserIdSchema } from "../../schemas.js";

export const operatorFeedbackQuerySchema = z.strictObject({
  page: z
    .union([z.number(), z.string().regex(/^[1-9]\d*$/u)])
    .pipe(z.coerce.number<string | number>().int().min(1).max(100000))
    .default(1),
  pageSize: z
    .union([z.number(), z.string().regex(/^[1-9]\d*$/u)])
    .pipe(z.coerce.number<string | number>().int().min(1).max(50))
    .default(20),
});
export type OperatorFeedbackQuery = z.infer<typeof operatorFeedbackQuerySchema>;
export const operatorFeedbackSchema = z.strictObject({
  id: feedbackIdSchema,
  message: z.string().min(1).max(5000),
  user: z.strictObject({ id: publicUserIdSchema, displayName: z.string() }),
  createdAt: z.iso.datetime(),
});
export type OperatorFeedback = z.infer<typeof operatorFeedbackSchema>;
export const operatorFeedbackPageSchema = z.strictObject({
  items: z.array(operatorFeedbackSchema).max(50),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().min(1).max(50),
});
export type OperatorFeedbackPage = z.infer<typeof operatorFeedbackPageSchema>;
