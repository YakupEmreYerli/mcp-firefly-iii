import { z } from "zod";
import { defineOperation, type EntityModule, type Operation } from "../registry.js";
import { EntityType } from "../types.js";
import type { FireflyClient } from "../firefly.js";
import { ValidationError } from "../errors.js";
import { dateRange, entityId, pagination } from "../schemas/common.js";
import {
  patternGrouping,
  rewriteField,
  statementRow,
  transactionBulkEdit,
  transactionBulkFields,
  transactionBulkSetFields,
  transactionFilter,
  transactionSplitStore,
  transactionSplitUpdate,
  transactionTypeFilter,
} from "../schemas/transactions.js";
import { digitShape, fillTemplate, matchPattern, parsePattern, scanTransactions, type ScannedRow } from "../scan.js";

/** How many rows one bulk call may carry.
 *
 * Every row costs a GET and a PUT against Firefly, run one after another. The
 * bound is not a correctness rule — it stops a single call from turning into
 * thousands of sequential requests against a personal instance, which times
 * out somewhere in the middle and leaves the caller unable to say how far it
 * got.
 */
const MAX_BULK_ROWS = 200;

export const transactionOperations: Record<string, Operation> = {
  list: defineOperation({
    description:
      "Which transactions happened in this period? Filterable by date range and type, paginated.",
    access: "read",
    input: z
      .object({
        ...pagination,
        ...dateRange,
        type: transactionTypeFilter.optional().describe("Filter on the transaction type(s) returned"),
      })
      .strict(),
    handler: (params, client) => client.get("/transactions", params),
  }),

  get: defineOperation({
    description: "What are the details of this transaction?",
    access: "read",
    input: z.object({ id: entityId }).strict(),
    handler: ({ id }, client) => client.get(`/transactions/${id}`),
  }),

  list_attachments: defineOperation({
    description: "Which files are attached to this transaction?",
    access: "read",
    input: z.object({ id: entityId, ...pagination }).strict(),
    handler: ({ id, ...query }, client) => client.get(`/transactions/${id}/attachments`, query),
  }),

  list_piggy_bank_events: defineOperation({
    description: "Which piggy bank events did this transaction cause?",
    access: "read",
    input: z.object({ id: entityId, ...pagination }).strict(),
    handler: ({ id, ...query }, client) =>
      client.get(`/transactions/${id}/piggy-bank-events`, query),
  }),

  create: defineOperation({
    description: "Record a new transaction.",
    access: "write",
    input: z
      .object({
        transactions: z.array(transactionSplitStore).min(1),
        group_title: z.string().optional().describe("Title for a split transaction group"),
        apply_rules: z.boolean().optional(),
        fire_webhooks: z.boolean().optional(),
        error_if_duplicate_hash: z.boolean().optional(),
      })
      .strict(),
    handler: (body, client) => client.post("/transactions", body),
  }),

  update: defineOperation({
    description: "Change an existing transaction.",
    access: "write",
    // `id` sits beside the update fields rather than wrapping them. Firefly
    // does not reject unknown top-level keys: a body sent under a wrapper key
    // returns 200 and changes nothing. `.strict()` plus this flat shape means
    // such a body cannot be built in the first place.
    input: z
      .object({
        id: entityId,
        transactions: z.array(transactionSplitUpdate).min(1),
        group_title: z.string().optional(),
        apply_rules: z.boolean().optional(),
        fire_webhooks: z.boolean().optional(),
      })
      .strict(),
    handler: ({ id, ...body }, client) => client.put(`/transactions/${id}`, body),
  }),

  delete: defineOperation({
    description: "Delete a transaction.",
    access: "destructive",
    input: z.object({ id: entityId }).strict(),
    handler: async ({ id }, client) => {
      // Firefly answers 204 with no body. Reporting the id back is a fact;
      // a fabricated "deleted successfully" message would be an unverified
      // claim dressed as a response.
      await client.del(`/transactions/${id}`);
      return { deleted: true, id };
    },
  }),

  // Firefly III's `/data/bulk/transactions` only moves transactions between
  // accounts (a `{where,update}` JSON over `account_id`); it cannot set a
  // category or tags. The earlier implementation sent `category_name=<name>`
  // as the `query` string, which the endpoint rejects with 500 "Syntax error"
  // — it never worked. The only API path that sets a category or tags on
  // existing transactions is a per-group PUT, so these operations fan out
  // into a GET + PUT per id.
  bulk_categorize: defineOperation({
    description: "Assign one category to several transactions at once.",
    access: "destructive",
    input: z
      .object({
        transaction_ids: z.array(z.number().int().positive()).min(1),
        category_name: z.string().min(1),
      })
      .strict(),
    handler: async ({ transaction_ids, category_name }, client) =>
      applyToEach(transaction_ids, client, (journal) => ({
        transaction_journal_id: journal.transaction_journal_id,
        category_name,
      })).then((outcome) => ({ ...outcome, category_name })),
  }),

  bulk_tag: defineOperation({
    description:
      "Add one or more tags to several transactions at once. Tags already on a transaction are kept.",
    access: "destructive",
    input: z
      .object({
        transaction_ids: z.array(z.number().int().positive()).min(1),
        tag_names: z.array(z.string().min(1)).min(1),
      })
      .strict(),
    handler: async ({ transaction_ids, tag_names }, client) =>
      // Merged, not replaced. Firefly rewrites the whole tag set on a journal
      // update, so sending only the new tags erased every tag the transaction
      // already carried — and reported it as a successful update, on data
      // nothing here can restore.
      applyToEach(transaction_ids, client, (journal) => ({
        transaction_journal_id: journal.transaction_journal_id,
        tags: [...new Set([...(journal.tags ?? []), ...tag_names])],
      })).then((outcome) => ({ ...outcome, tag_names })),
  }),

  // The operation a data cleanup needs. `bulk_categorize` and `bulk_tag` each
  // set one field to one value across many ids; rewriting 150 descriptions,
  // moving 20 deposits onto another account, or converting a type meant 150
  // separate `update` calls, which is where a caller runs out of room before
  // it runs out of work.
  bulk_update: defineOperation({
    description:
      "Rewrite several transactions in one call, each with its own fields — description, notes, category, accounts, even the transaction type.",
    access: "destructive",
    input: z
      .object({
        updates: z
          .array(transactionBulkEdit)
          .min(1)
          .max(MAX_BULK_ROWS)
          // Two rows for one id used to keep only the last one's fields while
          // reporting both as updated, so an edit vanished and the caller was
          // told it landed.
          .refine(
            (updates) => new Set(updates.map((edit) => edit.transaction_id)).size === updates.length,
            { message: "Each transaction_id may appear once; merge the fields you meant to set on it." },
          ),
      })
      .strict(),
    handler: async ({ updates }, client) => {
      const edits = new Map(updates.map((edit) => [edit.transaction_id, edit.fields]));
      return applyToEach(
        updates.map((edit) => edit.transaction_id),
        client,
        (journal, id) => ({
          transaction_journal_id: journal.transaction_journal_id,
          ...edits.get(id),
        }),
        (journals) => multiSplitReason(journals.length),
      );
    },
  }),

  bulk_delete: defineOperation({
    description: "Delete several transactions at once.",
    access: "destructive",
    input: z
      .object({ transaction_ids: z.array(entityId).min(1).max(MAX_BULK_ROWS) })
      .strict(),
    handler: async ({ transaction_ids }, client) => {
      const results: IdOutcome[] = [];
      for (const id of transaction_ids) {
        try {
          await client.del(`/transactions/${id}`);
          results.push({ id, status: "deleted" });
        } catch (error) {
          results.push({
            id,
            status: "failed",
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return {
        deleted: results.filter((entry) => entry.status === "deleted").length,
        failed: results.filter((entry) => entry.status === "failed").length,
        results,
      };
    },
  }),

  // Discovery. A caller that has to read every row before it can decide which
  // rows to change spends its whole context on the reading, which is what
  // pushed this work into throwaway scripts. Grouping happens here so the
  // answer is the handful of shapes behind the ledger, not the ledger.
  group_patterns: defineOperation({
    description:
      "What shapes does this set of transactions have? Groups them and returns each shape once, with a count, a total and one example.",
    access: "read",
    input: z
      .object({
        where: transactionFilter.optional(),
        by: patternGrouping.default("description_shape"),
        limit: z.number().int().positive().max(500).default(100),
      })
      .strict(),
    handler: async ({ where, by, limit }, client) => {
      const { rows, scanned, truncated } = await scanTransactions(client, where ?? {});
      const groups = new Map<string, { key: string; count: number; total: number; example: unknown }>();
      for (const row of rows) {
        const key =
          by === "description" ? row.description
          // A transfer has an asset account at both ends, so neither one is
          // "the counterpart" — naming only the source filed both directions
          // of the same pair under one key.
          : by === "counterpart" ? (row.type === "transfer"
              ? `${row.source_name} → ${row.destination_name}`
              : row.type === "withdrawal" ? row.destination_name : row.source_name)
          : by === "category" ? (row.category_name || "(no category)")
          : digitShape(row.description);
        const existing = groups.get(key);
        if (existing === undefined) {
          groups.set(key, {
            key,
            count: 1,
            total: row.amount,
            example: { id: row.id, date: row.date, amount: row.amount, description: row.description },
          });
        } else {
          existing.count += 1;
          existing.total += Number.isFinite(row.amount) ? row.amount : Number.NaN;
        }
      }
      const patterns = [...groups.values()]
        .sort((a, b) => b.count - a.count)
        .slice(0, limit)
        // A row Firefly returned an unparseable amount for would poison the
        // sum into NaN, which serialises to JSON null — a total that silently
        // stops being a number.
        .map((group) => ({
          ...group,
          total: Number.isFinite(group.total) ? Number(group.total.toFixed(2)) : null,
        }));
      return { matched: rows.length, scanned, truncated, distinct: groups.size, patterns };
    },
  }),

  // Selection and writing in one call. `bulk_update` still exists for the case
  // where the caller already knows the ids; this is for the case where working
  // them out is the expensive part.
  bulk_update_where: defineOperation({
    description:
      "Set the same fields on every transaction matching a filter, without naming their ids. Requires max_matches: it refuses to write anything if more transactions match than that.",
    access: "destructive",
    input: z
      .object({
        where: transactionFilter,
        set: transactionBulkSetFields,
        max_matches: z
          .number()
          .int()
          .positive()
          .max(MAX_BULK_ROWS)
          .describe("Refuse to write if more than this many transactions match. Run with dry_run first to learn the number."),
      })
      .strict(),
    handler: async ({ where, set, max_matches }, client) => {
      const { rows, truncated } = await scanTransactions(client, where);
      const refusal = tooMany(rows.length, max_matches, truncated);
      if (refusal !== undefined) return refusal;
      return applyRows(rows, client, () => set as Record<string, unknown>);
    },
  }),

  // The pattern rewrite. Bank imports arrive as one raw line per transaction;
  // turning them into something readable is a per-row computation, and doing
  // it anywhere but here means pulling every row across the wire to compute it.
  bulk_rewrite: defineOperation({
    description:
      "Rewrite a text field across matching transactions with a wildcard pattern, e.g. turn '086200000023377-TRENDYOL.COM ISTANBUL TR Pos satis' into 'Trendyol'. Rows the pattern does not change are left alone.",
    access: "destructive",
    input: z
      .object({
        where: transactionFilter,
        field: rewriteField.default("description"),
        match: z
          .string()
          .min(1)
          .max(200)
          .describe(
            "Pattern over the WHOLE field, the same language as description_like: `#` is one run of digits, `*` is any run of characters, everything else is literal. '#-*TRENDYOL*' matches '086200000023377-TRENDYOL.COM ISTANBUL TR Pos satis'. NOT a regular expression — `.`, `\\`, `(`, `+` and `$` match themselves, so a regex sent here silently fails to match, or matches something else.",
          ),
        replace: z
          .string()
          .describe(
            "Replacement for the whole field. $1..$9 stand for what the wildcards captured, numbered left to right: with match '#-*' , $1 is the leading digits and $2 the rest. An empty string clears the field.",
          ),
        max_matches: z.number().int().positive().max(MAX_BULK_ROWS),
        keep_original_in_notes: z
          .boolean()
          .default(false)
          .describe(
            "Only with field 'description': append the untouched original to the notes before overwriting, so the import text is not lost",
          ),
      })
      .strict(),
    handler: async ({ where, field, match, replace, max_matches, keep_original_in_notes }, client) => {
      // Rewriting the notes while promising to preserve the original in the
      // notes has no honest meaning. The flag used to be accepted here and
      // then silently ignored, destroying the exact text it was set to keep.
      if (field === "notes" && keep_original_in_notes) {
        throw new ValidationError(
          "keep_original_in_notes cannot be used when field is 'notes': the notes are what would be overwritten.",
        );
      }
      const pattern = parsePattern(match, "match");
      const { rows, truncated } = await scanTransactions(client, where);

      const changes: { row: (typeof rows)[number]; next: string }[] = [];
      let unchanged = 0;
      for (const row of rows) {
        const current = field === "description" ? row.description : row.notes;
        const captures = matchPattern(pattern, current);
        if (captures === undefined) {
          unchanged += 1;
          continue;
        }
        const next = fillTemplate(replace, captures);
        // Firefly requires a description, so an empty one is a broken record
        // rather than a rewrite. Notes may legitimately be cleared, so the
        // check is not applied to them.
        if (next === current || (field === "description" && next.trim() === "")) {
          unchanged += 1;
          continue;
        }
        changes.push({ row, next });
      }

      const refusal = tooMany(changes.length, max_matches, truncated);
      if (refusal !== undefined) return { ...refusal, unchanged };

      const samples = changes.slice(0, 5).map(({ row, next }) => ({
        id: row.id,
        before: field === "description" ? row.description : row.notes,
        after: next,
      }));
      // Keyed by the row object, not by its journal id: `text()` coerces a
      // missing id to "", and two such rows collided in the map — both were
      // written with the last row's replacement.
      const nextFor = new Map(changes.map(({ row, next }) => [row, next] as const));
      const outcome = await applyRows(
        changes.map(({ row }) => row),
        client,
        (row) => {
          const next = nextFor.get(row)!;
          if (field === "notes") return { notes: next };
          const keep =
            keep_original_in_notes && !row.notes.includes(ORIGINAL_MARKER)
              ? { notes: `${row.notes}${row.notes === "" ? "" : "\n\n"}${ORIGINAL_MARKER}${row.description}` }
              : {};
          return { description: next, ...keep };
        },
      );
      return { ...outcome, unchanged, samples };
    },
  }),

  // Reconciliation. The statement file itself stays with the caller — reading
  // a spreadsheet is not this server's business — but the matching is, because
  // it is quadratic in the number of rows and neither side belongs in a
  // model's context to do it.
  reconcile: defineOperation({
    description:
      "Which statement rows are missing from Firefly, and which Firefly transactions are missing from the statement? Give the rows read from a bank export.",
    access: "read",
    input: z
      .object({
        account_id: entityId,
        rows: z.array(statementRow).min(1).max(2000),
        start: z.string().min(1),
        end: z.string().min(1).describe("Inclusive"),
        day_tolerance: z
          .number()
          .int()
          .min(0)
          .max(7)
          .default(0)
          .describe("How many days a value date may differ from the booking date"),
      })
      .strict(),
    handler: async ({ account_id, rows, start, end, day_tolerance }, client) => {
      const { rows: scanned, truncated } = await scanTransactions(client, { start, end });
      const ledger = scanned
        .filter((row) => row.source_id === account_id || row.destination_id === account_id)
        .map((row) => ({
          id: row.id,
          date: row.date,
          amount: Number(((row.destination_id === account_id ? 1 : -1) * row.amount).toFixed(2)),
          description: row.description,
        }));

      const days = (a: string, b: string): number =>
        Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;

      const taken = new Set<number>();
      const missingInFirefly: unknown[] = [];
      for (const row of rows) {
        const wanted = Number(Number(row.amount).toFixed(2));
        let best = -1;
        let bestGap = Infinity;
        for (let index = 0; index < ledger.length; index += 1) {
          if (taken.has(index) || ledger[index]!.amount !== wanted) continue;
          const gap = days(ledger[index]!.date, row.date);
          if (gap <= day_tolerance && gap < bestGap) { best = index; bestGap = gap; }
        }
        if (best === -1) missingInFirefly.push({ date: row.date, amount: row.amount, label: row.label });
        else taken.add(best);
      }
      const missingInStatement = ledger.filter((_, index) => !taken.has(index));

      const sum = (values: number[]): number => Number(values.reduce((a, b) => a + b, 0).toFixed(2));
      return {
        matched: taken.size,
        statement_rows: rows.length,
        ledger_rows: ledger.length,
        truncated,
        difference: Number(
          (sum(ledger.map((entry) => entry.amount)) - sum(rows.map((row) => Number(row.amount)))).toFixed(2),
        ),
        missing_in_firefly: missingInFirefly,
        missing_in_statement: missingInStatement,
      };
    },
  }),
};

/** Marker under which a rewrite keeps the text it replaced.
 *
 * Fixed, and checked before appending, so re-running a rewrite cannot stack
 * copies of the original into the notes.
 */
const ORIGINAL_MARKER = "Original import text: ";

/** Refuse a write whose scope the caller did not predict.
 *
 * `max_matches` is required on every filter-driven write for this one reason.
 * A filter is easy to get subtly wrong, Firefly answers 200 to each rewrite,
 * and there is no undo — so the caller states how many rows it expects and a
 * wider match stops the operation before the first PUT rather than after the
 * four hundredth. A truncated scan refuses too: acting on the first page of an
 * unknown number of matches is the same failure wearing a smaller number.
 */
function tooMany(
  matched: number,
  max: number,
  truncated: boolean,
):
  | { refused: true; matched: number; max_matches: number; truncated: boolean; note: string }
  | undefined {
  if (matched <= max && !truncated) return undefined;
  return {
    refused: true,
    matched,
    max_matches: max,
    truncated,
    note: truncated
      ? "The scan could not confirm it saw every page, so more transactions may match than are reported here. Nothing was written; narrow the date range."
      : `${matched} transactions matched but max_matches is ${max}. Nothing was written. Run again with max_matches raised once that count is the one you expect.`,
  };
}

/** One split as the bulk operations need to read it back. */
type Journal = { transaction_journal_id: string; tags?: string[] };

/** What happened to one id. `skipped` is a group the operation declined to
 * touch — no splits came back, the group holds several, or Firefly gave no
 * journal id — which is neither a success nor a failure worth aborting for. */
type IdOutcome = {
  id: string | number;
  status: "updated" | "deleted" | "skipped" | "failed";
  reason?: string;
};

/** Rewrite one field across several transactions, and report each one.
 *
 * The per-id record is the point. These are `destructive` operations, and
 * throwing out of the loop discarded the list of ids already rewritten — the
 * caller got `{error: …}` and no way to tell whether none or nearly all of
 * them had been changed. A failure on one id is recorded and the rest are
 * still attempted, because the caller named each id deliberately and one stale
 * entry is not a reason to abandon the other nine.
 */
async function applyToEach<Id extends string | number>(
  ids: readonly Id[],
  client: FireflyClient,
  rewrite: (journal: Journal, id: Id) => Record<string, unknown>,
  guard?: (journals: Journal[], id: Id) => string | undefined,
): Promise<{ updated: number; failed: number; skipped: number; results: IdOutcome[] }> {
  const results: IdOutcome[] = [];
  for (const id of ids) {
    try {
      const group = (await client.get(`/transactions/${id}`)) as {
        data?: { attributes?: { transactions?: Journal[] } };
      };
      const journals = group.data?.attributes?.transactions ?? [];
      if (journals.length === 0) {
        results.push({ id, status: "skipped", reason: "the group came back with no splits" });
        continue;
      }
      const refused = guard?.(journals, id);
      if (refused !== undefined) {
        results.push({ id, status: "skipped", reason: refused });
        continue;
      }
      // Not `journals.map(rewrite)`: map passes the array index as the second
      // argument, which would arrive where the id belongs.
      await client.put(`/transactions/${id}`, {
        transactions: journals.map((journal) => rewrite(journal, id)),
      });
      results.push({ id, status: "updated" });
    } catch (error) {
      results.push({
        id,
        status: "failed",
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const count = (status: IdOutcome["status"]): number =>
    results.filter((entry) => entry.status === status).length;
  return { updated: count("updated"), failed: count("failed"), skipped: count("skipped"), results };
}

/** Why a group with more than one split is not rewritten in bulk.
 *
 * An earlier version allowed it for every field except amount, type and date.
 * That list was incomplete — `source_id` and `destination_id` belong to one
 * split too, and a three-way split exists precisely so its legs can point at
 * different accounts. Fanning one destination across all three collapsed them
 * onto one account, and Firefly answered 200.
 *
 * Rather than maintain a list of fields that are safe to repeat, bulk writes
 * decline split groups outright and say so. `update` names one journal at a
 * time and is the operation for them. `bulk_categorize` and `bulk_tag` keep
 * their older fan-out: a category and a tag genuinely do belong to the whole
 * group, and their behaviour is long-standing and tested.
 */
function multiSplitReason(splits: number): string | undefined {
  if (splits <= 1) return undefined;
  return (
    `the group holds ${splits} splits, whose fields are not interchangeable. ` +
    `Use the single-transaction update, which names one journal at a time.`
  );
}

async function applyRows(
  rows: ScannedRow[],
  client: FireflyClient,
  fields: (row: ScannedRow) => Record<string, unknown>,
): Promise<{ updated: number; failed: number; skipped: number; results: IdOutcome[] }> {
  const results: IdOutcome[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    // One result per group, not per matched split: a three-split group used to
    // report `skipped: 3` with the same id three times, a count on a different
    // scale from the `updated` beside it.
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    if (row.splits > 1) {
      results.push({ id: row.id, status: "skipped", reason: multiSplitReason(row.splits)! });
      continue;
    }
    if (row.journal_id === "") {
      // CLAUDE.md: without it Firefly returns 200 and changes nothing. Writing
      // anyway would report a success that never happened.
      results.push({ id: row.id, status: "skipped", reason: "Firefly returned no transaction_journal_id for this split" });
      continue;
    }
    try {
      await client.put(`/transactions/${row.id}`, {
        transactions: [{ transaction_journal_id: row.journal_id, ...fields(row) }],
      });
      results.push({ id: row.id, status: "updated" });
    } catch (error) {
      results.push({
        id: row.id,
        status: "failed",
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const count = (status: IdOutcome["status"]): number =>
    results.filter((entry) => entry.status === status).length;
  return { updated: count("updated"), failed: count("failed"), skipped: count("skipped"), results };
}

export const transactionsModule: EntityModule = {
  entity: EntityType.Transaction,
  hint: "individual transactions and their splits, attachments, and reconciliation against a statement",
  operations: transactionOperations,
};
