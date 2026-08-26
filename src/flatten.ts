/** Flatten Firefly's transaction groups into one row per split.
 *
 * In Firefly a "transaction" is a *group* holding one or more splits, so even a
 * single purchase arrives as `data[].attributes.transactions[0].amount` — three
 * levels down for the common case. This lifts each split's fields up into
 * `attributes`, producing one row per split.
 *
 * The shape is the same whether a group has one split or five: a caller that
 * learns the flat form on an ordinary purchase does not meet a different shape
 * the first time it reads a split transaction.
 *
 * `id` deliberately stays the *group* id. That is what `transaction.get`,
 * `update` and `delete` take; swapping in the split's `transaction_journal_id`
 * would send updates to an id Firefly does not match, and Firefly answers 200
 * to those rather than failing. Each row keeps `transaction_journal_id` too,
 * because updates need it inside the split.
 */

const SPLIT_KEY = "transactions";
const TRANSACTION_TYPE = "transactions";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True for a JSON:API record holding a transaction group with splits. */
function isTransactionGroup(value: unknown): value is {
  id?: unknown;
  type: string;
  attributes: Record<string, unknown>;
} {
  return (
    isRecord(value) &&
    value.type === TRANSACTION_TYPE &&
    isRecord(value.attributes) &&
    Array.isArray(value.attributes[SPLIT_KEY])
  );
}

function rowsFor(group: { id?: unknown; type: string; attributes: Record<string, unknown> }): unknown[] {
  const { [SPLIT_KEY]: splits, ...groupAttributes } = group.attributes;
  if (!Array.isArray(splits)) return [group];

  // A group with no splits carries nothing to lift; keep the record rather
  // than dropping a row and quietly changing the count.
  if (splits.length === 0) return [{ ...group, attributes: groupAttributes }];

  return splits.map((split) => {
    const attributes: Record<string, unknown> = isRecord(split)
      ? { ...groupAttributes, ...split }
      : { ...groupAttributes };
    // Only worth saying when it is true; on the common single-split record it
    // would be noise on every row.
    if (splits.length > 1) attributes.split_count = splits.length;
    return { ...group, attributes };
  });
}

/** Rewrite a payload's transaction groups as one row per split.
 *
 * Anything that is not a transaction group is returned untouched, so this is
 * safe to run over every response: it keys off the JSON:API `type`.
 *
 * `meta.pagination` is left exactly as Firefly sent it. Firefly paginates
 * *groups*, so its counts describe groups and not rows. Restating them here
 * would be a guess — the page only ever holds the groups Firefly chose — and
 * the two differ only for split transactions, which each row marks with
 * `split_count`.
 */
export function flattenTransactions(payload: unknown): unknown {
  if (!isRecord(payload)) return payload;

  const { data } = payload;

  if (Array.isArray(data)) {
    if (!data.some(isTransactionGroup)) return payload;
    return {
      ...payload,
      data: data.flatMap((record) => (isTransactionGroup(record) ? rowsFor(record) : [record])),
    };
  }

  if (isTransactionGroup(data)) {
    const rows = rowsFor(data);
    // A single-record response stays a single record; a genuinely split one
    // becomes a list rather than silently losing the other splits.
    return { ...payload, data: rows.length === 1 ? rows[0] : rows };
  }

  return payload;
}
