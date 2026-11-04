import { z } from "zod";

/**
 * The time bound of a queue filter. Named ranges resolve in Admin, which echoes what
 * it resolved. Before 1970 no community row exists, and PostgreSQL refuses year zero.
 */
export const operatorTimeBoundSchema = z.iso
  .datetime({ offset: true })
  .refine((value) => Date.parse(value) >= 0);

/** A range ending before it starts is a mistake, never an empty answer. */
export const rangeInOrder = ({
  from,
  to,
}: {
  readonly from?: string | undefined;
  readonly to?: string | undefined;
}): boolean =>
  from === undefined || to === undefined || Date.parse(from) <= Date.parse(to);

/** An identity to compare exactly: PostgreSQL text cannot hold a NUL. */
export const operatorExactIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^\S+$/u)
  .refine((value) => !value.includes("\u0000"));
