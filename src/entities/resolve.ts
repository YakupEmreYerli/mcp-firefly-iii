import { z } from "zod";
import { defineOperation, type EntityModule, type Operation } from "../registry.js";
import { EntityType } from "../types.js";
import type { FireflyClient } from "../firefly.js";
import { resolve, type Candidate } from "../matching.js";

const nameQuery = z
  .object({
    query: z.string().min(1).describe("The name as the user said it, e.g. 'nakit' or 'MİGROS'"),
  })
  .strict();

const accountQuery = nameQuery.extend({
  type: z.string().optional().describe("Restrict to one Firefly account type, e.g. 'asset' or 'expense'"),
}).strict();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type Named = { id: string; name: string; type?: string };

/** Account types Firefly keeps for its own bookkeeping.
 *
 * Every asset account has a matching "Initial balance for …" record, so a
 * search for "nakit" finds two things and reports an ambiguity the user cannot
 * even see in their own Firefly. Nobody ever means these by name; they are
 * excluded unless the caller asks for that type outright.
 */
const INTERNAL_ACCOUNT_TYPES = new Set(["initial-balance", "reconciliation", "import"]);

/** Every record on an endpoint, flattened to id and name.
 *
 * Paged through rather than taking the first page: a name missing because it
 * sat on page two would resolve to the wrong record or to nothing, and both
 * are worse than a second request. The cap is a guard against a pathological
 * instance, not an expected limit — a personal Firefly has tens of accounts.
 */
async function allNamed(path: string, client: FireflyClient, query: Record<string, unknown> = {}): Promise<Named[]> {
  const found: Named[] = [];
  for (let page = 1; page <= 10; page += 1) {
    const payload = await client.get(path, { ...query, limit: 100, page });
    if (!isRecord(payload) || !Array.isArray(payload.data)) break;
    for (const record of payload.data) {
      if (!isRecord(record)) continue;
      const attributes = isRecord(record.attributes) ? record.attributes : record;
      const name = typeof attributes.name === "string" ? attributes.name : typeof attributes.tag === "string" ? attributes.tag : "";
      const id = typeof record.id === "string" ? record.id : "";
      const kind = typeof attributes.type === "string" ? attributes.type : undefined;
      if (name !== "" && id !== "") found.push({ id, name, ...(kind === undefined ? {} : { type: kind }) });
    }
    const total = isRecord(payload.meta) && isRecord(payload.meta.pagination) ? Number(payload.meta.pagination.total_pages) : 1;
    if (!Number.isFinite(total) || page >= total) break;
  }
  return found;
}

function asCandidate(entry: Candidate<Named>): Record<string, unknown> {
  return { id: entry.item.id, name: entry.item.name, matched_by: entry.kind, score: Math.round(entry.score * 100) / 100 };
}

/** Resolve one name, or hand back the candidates without choosing.
 *
 * `matched: false` with candidates is a real answer, not a failure: the caller
 * should ask the user which one. Picking the highest score regardless would
 * turn "I am not sure" into a transaction against the wrong account.
 */
async function resolveNamed(
  query: string,
  path: string,
  client: FireflyClient,
  extra: Record<string, unknown> = {},
): Promise<unknown> {
  const fetched = await allNamed(path, client, extra);
  const items =
    extra.type === undefined
      ? fetched.filter((item) => item.type === undefined || !INTERNAL_ACCOUNT_TYPES.has(item.type))
      : fetched;
  const result = resolve(query, items, (item) => item.name);

  if (!result.matched) {
    return {
      query,
      matched: false,
      reason: result.candidates.length === 0 ? "no_match" : "ambiguous",
      candidates: result.candidates.map(asCandidate),
      note:
        result.candidates.length === 0
          ? "Nothing in Firefly matches that name. Ask the user, or list the entity to see what exists."
          : "Several names fit. Ask the user which one before writing anything.",
    };
  }

  return {
    query,
    matched: true,
    match: asCandidate(result.best),
    // Carried so the caller can tell the user which name Firefly actually
    // uses. The name the user said and the name on the record differ often
    // enough that hiding the difference reads as the server having changed it.
    also_considered: result.others.map(asCandidate),
  };
}

export const resolveOperations: Record<string, Operation> = {
  account: defineOperation({
    description: "Which Firefly account does this name refer to?",
    access: "read",
    input: accountQuery,
    handler: ({ query, type }, client) => resolveNamed(query, "/accounts", client, type === undefined ? {} : { type }),
  }),
  category: defineOperation({
    description: "Which Firefly category does this name refer to?",
    access: "read",
    input: nameQuery,
    handler: ({ query }, client) => resolveNamed(query, "/categories", client),
  }),
  budget: defineOperation({
    description: "Which Firefly budget does this name refer to?",
    access: "read",
    input: nameQuery,
    handler: ({ query }, client) => resolveNamed(query, "/budgets", client),
  }),
  tag: defineOperation({
    description: "Which Firefly tag does this name refer to?",
    access: "read",
    input: nameQuery,
    handler: ({ query }, client) => resolveNamed(query, "/tags", client),
  }),
};

export const resolveModule: EntityModule = {
  entity: EntityType.Resolve,
  hint: "turn a name a user said into the Firefly record it means, or ask which one",
  operations: resolveOperations,
};
