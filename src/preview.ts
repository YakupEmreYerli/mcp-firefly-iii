import type { FireflyClient, Query } from "./firefly.js";

/** One request an operation would have sent to Firefly III. */
export type PlannedWrite = { method: string; path: string; body?: unknown; query?: Query };

/** A client that reads for real but only records what it would write.
 *
 * Running the handler against this is what makes a preview worth having: the
 * plan comes back with ids resolved and the payload shaped exactly as Firefly
 * would receive it, rather than an echo of the caller's own parameters. Reads
 * stay live because handlers legitimately look things up first — the bulk
 * operations fetch a group before they PUT it.
 *
 * A handler that reads back its own write sees nothing, which is the one thing
 * a preview cannot honestly simulate.
 */
export function previewClient(real: FireflyClient, recorded: PlannedWrite[]): FireflyClient {
  return {
    get: (path, query) => real.get(path, query),
    getText: (path, query) => real.getText(path, query),
    post: async (path, body, query) => {
      recorded.push({ method: "POST", path, body, query });
      return {};
    },
    put: async (path, body) => {
      recorded.push({ method: "PUT", path, body });
      return {};
    },
    del: async (path, query) => {
      recorded.push({ method: "DELETE", path, query });
      return null;
    },
    postBinary: async (path) => {
      recorded.push({ method: "POST", path, body: "<binary upload>" });
      return {};
    },
  };
}

export type Warning = { kind: string; message: string; matches?: unknown[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function money(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(text(value));
  return Number.isFinite(parsed) ? Math.abs(parsed) : undefined;
}

/** The splits inside a transaction-create body. */
function splitsOf(body: unknown): Record<string, unknown>[] {
  if (!isRecord(body) || !Array.isArray(body.transactions)) return [];
  return body.transactions.filter(isRecord);
}

/** Existing transactions on a day, flattened to one row per split. */
async function transactionsOn(day: string, client: FireflyClient): Promise<Record<string, unknown>[]> {
  // `end` is inclusive, so start === end is exactly that day. /transactions
  // accepts it, unlike /accounts/{id}/transactions and /summary/basic.
  const payload = await client.get("/transactions", { start: day, end: day });
  if (!isRecord(payload) || !Array.isArray(payload.data)) return [];
  return payload.data.flatMap((record) => {
    if (!isRecord(record)) return [];
    const attributes = isRecord(record.attributes) ? record.attributes : record;
    const splits = Array.isArray(attributes.transactions) ? attributes.transactions.filter(isRecord) : [];
    return splits.map((split) => ({ ...split, id: record.id }));
  });
}

/** Transactions already recorded that look like the one about to be created.
 *
 * Deliberately narrow: same day, same amount, and both account names equal.
 * A looser rule would refuse to distinguish two genuine coffees on one day,
 * and a false alarm on a write is the same class of failure as a wrong answer
 * on a read — it teaches the caller to ignore the warning.
 *
 * This only ever warns. Firefly's own `error_if_duplicate_hash` is what
 * actually blocks an exact repeat; guessing a threshold here and enforcing it
 * would block legitimate writes the caller meant to make.
 */
export async function duplicateWarnings(plan: PlannedWrite[], client: FireflyClient): Promise<Warning[]> {
  const creates = plan.filter((entry) => entry.method === "POST" && entry.path === "/transactions");
  if (creates.length === 0) return [];

  const warnings: Warning[] = [];
  for (const create of creates) {
    for (const split of splitsOf(create.body)) {
      const day = text(split.date).slice(0, 10);
      const amount = money(split.amount);
      const source = text(split.source_name);
      const destination = text(split.destination_name);
      if (day === "" || amount === undefined || source === "" || destination === "") continue;

      const existing = await transactionsOn(day, client);
      const matches = existing
        .filter(
          (row) =>
            money(row.amount) === amount &&
            text(row.source_name) === source &&
            text(row.destination_name) === destination,
        )
        .map((row) => ({
          id: row.id,
          date: text(row.date).slice(0, 10),
          amount: money(row.amount),
          description: text(row.description),
          source_name: text(row.source_name),
          destination_name: text(row.destination_name),
        }));

      if (matches.length > 0) {
        warnings.push({
          kind: "possible_duplicate",
          message:
            `Firefly already has ${matches.length} transaction(s) on ${day} for ${amount} ` +
            `between '${source}' and '${destination}'. Check with the user before creating another.`,
          matches,
        });
      }
    }
  }
  return warnings;
}
