import { z } from "zod";

/**
 * The time bound of a queue filter. Named ranges resolve in Admin, which echoes what
 * it resolved. Before 1970 no community row exists, and PostgreSQL refuses year zero,
 * an offset past 15:59 and a text longer than its field buffer. All of it sits in one
 * refine, so the published JSON Schema does not change.
 */
export const operatorTimeBoundSchema = z.iso
  .datetime({ offset: true })
  .refine(
    (value) =>
      value.length <= 40 &&
      Date.parse(value) >= 0 &&
      !/[+-](?:1[6-9]|2\d):\d\d$/u.test(value),
  );

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
