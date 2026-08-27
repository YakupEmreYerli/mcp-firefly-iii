import { z } from "zod";
import { isoDate } from "./common.js";

/** Two reporting periods to hold against each other.
 *
 * Both ends are INCLUSIVE, matching Firefly's own range behaviour, so a single
 * day is `start === end` and counts as one day.
 *
 * Ordering is checked in the handler rather than here: `StrictInput` only
 * admits a plain strict object, and a refinement would make this a
 * `ZodEffects` that `getSchema` could not publish.
 */
export const comparePeriodsInput = z
  .object({
    start: isoDate.describe("Start of the period being examined, YYYY-MM-DD"),
    end: isoDate.describe("End of the period being examined, YYYY-MM-DD. Inclusive — this day is part of the range, and must not fall before start."),
    baseline_start: isoDate.describe("Start of the earlier period to compare against, YYYY-MM-DD"),
    baseline_end: isoDate.describe("End of the earlier period to compare against, YYYY-MM-DD. Inclusive, and must not fall before baseline_start."),
    currency_code: z.string().optional().describe("Restrict both periods to a single currency"),
  })
  .strict();

/** A period to scan, plus how much repetition counts as a pattern.
 *
 * `end` is INCLUSIVE, as everywhere else.
 */
export const recurringInput = z
  .object({
    start: isoDate.describe("Start of the period to scan, YYYY-MM-DD"),
    end: isoDate.describe("End of the period to scan, YYYY-MM-DD. Inclusive."),
    min_occurrences: z
      .number()
      .int()
      .min(2)
      .max(50)
      .optional()
      .describe("How many payments to the same payee before it counts as recurring. Default 3."),
  })
  .strict();

/** A period to scan for transactions carrying no category. */
export const uncategorizedInput = z
  .object({
    start: isoDate.describe("Start of the period, YYYY-MM-DD"),
    end: isoDate.describe("End of the period, YYYY-MM-DD. Inclusive."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .describe("How many payee groups to return, largest total first. Default 25."),
  })
  .strict();
