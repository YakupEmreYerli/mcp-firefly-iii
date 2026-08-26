import { z } from "zod";

/** A Firefly date, `YYYY-MM-DD`. */
export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "expected a date formatted YYYY-MM-DD")
  .describe("Date formatted YYYY-MM-DD");

/** A Firefly resource id. Always a numeric string in the JSON:API envelope. */
export const entityId = z.string().regex(/^\d+$/, "expected a numeric id");

/** Start and end of a reporting period.
 *
 * `end` is INCLUSIVE: `start=2026-08-25&end=2026-08-26` returns both days.
 * The note lives here, once, so no operation description can forget it.
 */
export const dateRange = {
  start: isoDate.optional().describe("Start date, YYYY-MM-DD"),
  end: isoDate
    .optional()
    .describe("End date, YYYY-MM-DD. Inclusive — this day is part of the range."),
};

/** Page controls shared by every list endpoint. */
export const pagination = {
  limit: z.number().int().positive().optional().describe("Number of items per page"),
  page: z.number().int().positive().optional().describe("Page number"),
};
