/** Trim Firefly III responses before they reach the model's context.
 *
 * Firefly answers with full JSON:API documents. A single transaction carries 61
 * attributes, of which around 39 are null on a typical record, so most of what
 * reaches the model is padding. `stripEmpty` always runs; `projectFields` is
 * opt-in. Both preserve the JSON:API envelope so the model can still identify
 * records and follow pagination.
 */

/** Envelope keys that identify a record; never dropped by a field projection. */
const RECORD_KEYS = ["id", "type"] as const;

/** Transactions nest their real fields one level deeper, as "splits". */
const SPLIT_KEY = "transactions";

/** Top-level keys that stay even when empty. An empty `data` list is the answer
 * "no matches"; dropping it would read as a malformed response. */
const ENVELOPE_KEYS = new Set(["data"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True for values that carry no information.
 *
 * Deliberately narrow: `0`, `false` and `"0"` are facts (a zero balance, an
 * inactive account) and are kept.
 */
function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string" || Array.isArray(value)) return value.length === 0;
  if (isRecord(value)) return Object.keys(value).length === 0;
  return false;
}

export function stripEmpty(value: unknown, topLevel = true): unknown {
  if (Array.isArray(value)) return value.map((item) => stripEmpty(item, false));
  if (!isRecord(value)) return value;

  const result: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    const cleaned = stripEmpty(raw, false);
    if ((topLevel && ENVELOPE_KEYS.has(key)) || !isEmpty(cleaned)) {
      result[key] = cleaned;
    }
  }
  return result;
}

function projectAttributes(attributes: unknown, wanted: Set<string>): unknown {
  if (!isRecord(attributes)) return attributes;

  const projected: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (wanted.has(key)) projected[key] = value;
  }

  // Keep the splits container even when unnamed, projecting each split.
  const splits = attributes[SPLIT_KEY];
  if (Array.isArray(splits)) {
    projected[SPLIT_KEY] = splits.map((split) => {
      if (!isRecord(split)) return split;
      const kept: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(split)) {
        if (wanted.has(key)) kept[key] = value;
      }
      return kept;
    });
  }

  return projected;
}

function projectRecord(record: unknown, wanted: Set<string>): unknown {
  if (!isRecord(record)) return record;

  const projected: Record<string, unknown> = {};
  for (const key of RECORD_KEYS) {
    if (key in record) projected[key] = record[key];
  }
  if ("attributes" in record) {
    projected.attributes = projectAttributes(record.attributes, wanted);
  }
  return projected;
}

/** Keep only `fields` among record attributes.
 *
 * An empty or missing `fields` returns the payload untouched. Names that match
 * nothing are ignored rather than raising: the model should not have to know
 * the exact schema to ask for less.
 */
export function projectFields(value: unknown, fields?: string[]): unknown {
  const wanted = new Set(fields ?? []);
  if (wanted.size === 0 || !isRecord(value)) return value;

  const projected: Record<string, unknown> = { ...value };
  const data = value.data;
  if (Array.isArray(data)) {
    projected.data = data.map((record) => projectRecord(record, wanted));
  } else if (isRecord(data)) {
    projected.data = projectRecord(data, wanted);
  }
  return projected;
}
