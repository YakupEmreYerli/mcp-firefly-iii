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
