import { z } from "zod";
import { defineOperation, type EntityModule, type Operation } from "../registry.js";
import { dateRange, entityId, isoDate, pagination, periodOrDates } from "../schemas/common.js";
import { EntityType } from "../types.js";
import type { FireflyClient } from "../firefly.js";
import { FireflyApiError, ValidationError } from "../errors.js";

const id = z.object({ id: entityId }).strict();
const dates = { ...dateRange };
// `start` and `end` are optional in the schema only because `period` may stand
// in for them. `StrictInput` admits a plain strict object, so "one of these two
// forms" cannot be expressed as a refinement without becoming a ZodEffects that
// `getSchema` could not publish. `withPeriod` enforces it instead, and does so
// where the dates are used rather than in a list of operation names somewhere
// else that a new operation could be forgotten from.
const analysisInput = z
  .object({
    ...periodOrDates,
    currency_code: z.string().optional(),
  })
  .strict();

/** The dates an analysis needs, once the shortcut has been resolved.
 *
 * Registry.execute turns `period` into the pair before a handler runs, so
 * reaching here without them means the caller sent neither form. Refusing is
 * the point: Firefly answers a range-less insight query with a default period,
 * so a missing date would come back as a real-looking total for a period nobody
 * asked about.
 */
function withPeriod<T extends { start?: string; end?: string }>(query: T): T & { start: string; end: string } {
  if (query.start === undefined || query.end === undefined) {
    throw new ValidationError(
      "This operation needs a period: give start and end (YYYY-MM-DD), or a period shortcut such as last_month.",
    );
  }
  return query as T & { start: string; end: string };
}
const deleteResult = async (path: string, record: { id: string }, client: { del: (path: string) => Promise<unknown> }) => { await client.del(path); return { deleted: true, id: record.id }; };

const budgetData = z.object({ name: z.string().min(1), active: z.boolean().optional(), notes: z.string().optional() }).strict();
const limitData = z.object({ amount: z.string().min(1), start: isoDate, end: isoDate, currency_code: z.string().optional(), budget_id: entityId.optional() }).strict();
export const budgetOperations: Record<string, Operation> = {
  list: defineOperation({ description: "Which budgets exist for this period?", access: "read", input: z.object({ ...pagination, ...dates }).strict(), handler: (q, c) => c.get("/budgets", q) }),
  get: defineOperation({ description: "What are the details of this budget?", access: "read", input: z.object({ id: entityId, ...dates }).strict(), handler: ({ id, ...q }, c) => c.get(`/budgets/${id}`, q) }),
  create: defineOperation({ description: "Create a new budget.", access: "write", input: budgetData, handler: (b, c) => c.post("/budgets", b) }),
  update: defineOperation({ description: "Change an existing budget.", access: "write", input: z.object({ id: entityId, budget_update: budgetData }).strict(), handler: ({ id, budget_update }, c) => c.put(`/budgets/${id}`, budget_update) }),
  delete: defineOperation({ description: "Delete a budget.", access: "destructive", input: id, handler: ({ id }, c) => deleteResult(`/budgets/${id}`, { id }, c) }),
  list_limits: defineOperation({ description: "Which limits belong to this budget?", access: "read", input: z.object({ id: entityId, ...dates }).strict(), handler: ({ id, ...q }, c) => c.get(`/budgets/${id}/limits`, q) }),
  get_limit: defineOperation({ description: "What are the details of this budget limit?", access: "read", input: z.object({ budget_id: entityId, limit_id: entityId }).strict(), handler: ({ budget_id, limit_id }, c) => c.get(`/budgets/${budget_id}/limits/${limit_id}`) }),
  create_limit: defineOperation({ description: "Create a budget limit.", access: "write", input: z.object({ budget_id: entityId, budget_limit_store: limitData }).strict(), handler: ({ budget_id, budget_limit_store }, c) => c.post(`/budgets/${budget_id}/limits`, budget_limit_store) }),
  update_limit: defineOperation({ description: "Change a budget limit.", access: "write", input: z.object({ budget_id: entityId, limit_id: entityId, budget_limit: limitData }).strict(), handler: ({ budget_id, limit_id, budget_limit }, c) => c.put(`/budgets/${budget_id}/limits/${limit_id}`, budget_limit) }),
  delete_limit: defineOperation({ description: "Delete a budget limit.", access: "destructive", input: z.object({ budget_id: entityId, limit_id: entityId }).strict(), handler: ({ budget_id, limit_id }, c) => deleteResult(`/budgets/${budget_id}/limits/${limit_id}`, { id: limit_id }, c) }),
  list_transactions: defineOperation({ description: "Which transactions belong to this budget?", access: "read", input: z.object({ id: entityId, ...pagination, ...dates, type: z.string().optional() }).strict(), handler: ({ id, ...q }, c) => c.get(`/budgets/${id}/transactions`, q) }),
  list_attachments: defineOperation({ description: "Which files are attached to this budget?", access: "read", input: z.object({ id: entityId, ...pagination }).strict(), handler: ({ id, ...q }, c) => c.get(`/budgets/${id}/attachments`, q) }),
  list_transactions_without_budget: defineOperation({ description: "Which transactions have no budget?", access: "read", input: z.object({ ...pagination, ...dates }).strict(), handler: (q, c) => c.get("/budgets/transactions-without-budget", q) }),
};
export const budgetsModule: EntityModule = { entity: EntityType.Budget, hint: "budgets, limits, and budget transactions", operations: budgetOperations };

const billData = z.object({ name: z.string().min(1), amount_min: z.string().min(1), amount_max: z.string().min(1), date: z.string().min(1), repeat_freq: z.enum(["weekly", "monthly", "quarterly", "half-year", "yearly"]), skip: z.number().int().optional(), active: z.boolean().optional(), notes: z.string().optional() }).strict();
const billUpdate = billData.partial().extend({ name: z.string().min(1) }).strict();
export const billOperations: Record<string, Operation> = {
  list: defineOperation({ description: "Which bills are due in this period?", access: "read", input: z.object({ ...pagination, ...dates }).strict(), handler: (q, c) => c.get("/bills", q) }),
  get: defineOperation({ description: "What are the details of this bill?", access: "read", input: z.object({ id: entityId, ...dates }).strict(), handler: ({ id, ...q }, c) => c.get(`/bills/${id}`, q) }),
  create: defineOperation({ description: "Create a new bill.", access: "write", input: billData, handler: (b, c) => c.post("/bills", b) }),
  update: defineOperation({ description: "Change an existing bill.", access: "write", input: z.object({ id: entityId, bill_update: billUpdate }).strict(), handler: ({ id, bill_update }, c) => c.put(`/bills/${id}`, bill_update) }),
  delete: defineOperation({ description: "Delete a bill.", access: "destructive", input: id, handler: ({ id }, c) => deleteResult(`/bills/${id}`, { id }, c) }),
  list_transactions: defineOperation({ description: "Which transactions are associated with this bill?", access: "read", input: z.object({ id: entityId, ...pagination, ...dates, type: z.string().optional() }).strict(), handler: ({ id, ...q }, c) => c.get(`/bills/${id}/transactions`, q) }),
  list_attachments: defineOperation({ description: "Which files are attached to this bill?", access: "read", input: z.object({ id: entityId, ...pagination }).strict(), handler: ({ id, ...q }, c) => c.get(`/bills/${id}/attachments`, q) }),
  list_rules: defineOperation({ description: "Which rules set this bill?", access: "read", input: z.object({ id: entityId, ...pagination }).strict(), handler: ({ id, ...q }, c) => c.get(`/bills/${id}/rules`, q) }),
};
export const billsModule: EntityModule = { entity: EntityType.Bill, hint: "recurring bills and their transactions", operations: billOperations };

const piggyData = z.object({ name: z.string().min(1), amount: z.string().optional(), target_amount: z.string().min(1), start_date: isoDate, target_date: isoDate.optional(), transaction_currency_code: z.string().optional(), transaction_currency_id: entityId.optional(), order: z.number().int().optional(), active: z.boolean().optional(), notes: z.string().optional(), accounts: z.array(z.object({ account_id: entityId, current_amount: z.string().optional() }).strict()).min(1) }).strict();
const piggyUpdate = z.object({ name: z.string().optional(), target_amount: z.string().optional(), start_date: isoDate.optional(), target_date: isoDate.optional(), transaction_currency_code: z.string().optional(), transaction_currency_id: entityId.optional(), order: z.number().int().optional(), active: z.boolean().optional(), notes: z.string().optional(), accounts: z.array(z.object({ account_id: entityId, current_amount: z.string().optional() }).strict()).optional().describe("Sent as a complete list: Firefly REPLACES the whole set rather than merging into it, so any value already there and not repeated here is removed. To add one, read the current values first and send them all back.") }).strict();
export const piggyBankOperations: Record<string, Operation> = {
  list: defineOperation({ description: "Which piggy banks exist?", access: "read", input: z.object({ ...pagination }).strict(), handler: (q, c) => c.get("/piggy-banks", q) }),
  get: defineOperation({ description: "What are the details of this piggy bank?", access: "read", input: id, handler: ({ id }, c) => c.get(`/piggy-banks/${id}`) }),
  create: defineOperation({ description: "Create a new piggy bank.", access: "write", input: piggyData, handler: (b, c) => c.post("/piggy-banks", b) }),
  update: defineOperation({ description: "Change an existing piggy bank.", access: "write", input: z.object({ id: entityId, piggy_bank_update: piggyUpdate }).strict(), handler: ({ id, piggy_bank_update }, c) => c.put(`/piggy-banks/${id}`, piggy_bank_update) }),
  delete: defineOperation({ description: "Delete a piggy bank.", access: "destructive", input: id, handler: ({ id }, c) => deleteResult(`/piggy-banks/${id}`, { id }, c) }),
  list_events: defineOperation({ description: "Which events changed this piggy bank?", access: "read", input: z.object({ id: entityId, ...pagination }).strict(), handler: ({ id, ...q }, c) => c.get(`/piggy-banks/${id}/events`, q) }),
  list_attachments: defineOperation({ description: "Which files are attached to this piggy bank?", access: "read", input: z.object({ id: entityId, ...pagination }).strict(), handler: ({ id, ...q }, c) => c.get(`/piggy-banks/${id}/attachments`, q) }),
};
export const piggyBanksModule: EntityModule = { entity: EntityType.PiggyBank, hint: "savings goals and their events", operations: piggyBankOperations };

const ruleTrigger = z.object({ type: z.string().min(1), value: z.string() }).strict();
const ruleAction = z.object({ type: z.string().min(1), value: z.string() }).strict();
const ruleStore = z.object({ title: z.string().min(1), rule_group_id: entityId, description: z.string().optional(), active: z.boolean().optional(), strict: z.boolean().optional(), stop_processing: z.boolean().optional(), trigger: z.string().min(1), triggers: z.array(ruleTrigger).min(1), actions: z.array(ruleAction).min(1) }).strict();
const ruleUpdate = z.object({ title: z.string().optional(), rule_group_id: entityId.optional(), description: z.string().optional(), active: z.boolean().optional(), strict: z.boolean().optional(), stop_processing: z.boolean().optional(), trigger: z.string().optional(), triggers: z.array(ruleTrigger).optional().describe("Sent as a complete list: Firefly REPLACES the whole set rather than merging into it, so any value already there and not repeated here is removed. To add one, read the current values first and send them all back."), actions: z.array(ruleAction).optional().describe("Sent as a complete list: Firefly REPLACES the whole set rather than merging into it, so any value already there and not repeated here is removed. To add one, read the current values first and send them all back.") }).strict();
const ruleFilterShape = { ...dates, accounts: z.array(z.number().int().positive()).optional() };
export const ruleOperations: Record<string, Operation> = {
  list: defineOperation({ description: "Which rules exist?", access: "read", input: z.object({ ...pagination }).strict(), handler: (q, c) => c.get("/rules", q) }),
  get: defineOperation({ description: "What are the details of this rule?", access: "read", input: id, handler: ({ id }, c) => c.get(`/rules/${id}`) }),
  create: defineOperation({ description: "Create a new rule.", access: "write", input: ruleStore, handler: (b, c) => c.post("/rules", b) }),
  update: defineOperation({ description: "Change an existing rule.", access: "write", input: z.object({ id: entityId, rule_update: ruleUpdate }).strict(), handler: ({ id, rule_update }, c) => c.put(`/rules/${id}`, rule_update) }),
  delete: defineOperation({ description: "Delete a rule.", access: "destructive", input: id, handler: ({ id }, c) => deleteResult(`/rules/${id}`, { id }, c) }),
  test: defineOperation({ description: "Which transactions would this rule affect?", access: "read", input: z.object({ id: entityId, ...ruleFilterShape }).strict(), handler: ({ id, ...q }, c) => c.get(`/rules/${id}/test`, q) }),
  trigger: defineOperation({ description: "Apply this rule to matching transactions.", access: "write", input: z.object({ id: entityId, ...ruleFilterShape }).strict(), handler: ({ id, ...q }, c) => c.post(`/rules/${id}/trigger`, undefined, q) }),
};
export const rulesModule: EntityModule = { entity: EntityType.Rule, hint: "automation rules and rule tests", operations: ruleOperations };

const groupData = z.object({ title: z.string().min(1), description: z.string().optional(), active: z.boolean().optional(), order: z.number().int().optional() }).strict();
export const ruleGroupOperations: Record<string, Operation> = {
  list: defineOperation({ description: "Which rule groups exist?", access: "read", input: z.object({ ...pagination }).strict(), handler: (q, c) => c.get("/rule-groups", q) }),
  get: defineOperation({ description: "What are the details of this rule group?", access: "read", input: id, handler: ({ id }, c) => c.get(`/rule-groups/${id}`) }),
  create: defineOperation({ description: "Create a new rule group.", access: "write", input: groupData, handler: (b, c) => c.post("/rule-groups", b) }),
  update: defineOperation({ description: "Change an existing rule group.", access: "write", input: z.object({ id: entityId, rule_group_update: groupData }).strict(), handler: ({ id, rule_group_update }, c) => c.put(`/rule-groups/${id}`, rule_group_update) }),
  delete: defineOperation({ description: "Delete a rule group.", access: "destructive", input: id, handler: ({ id }, c) => deleteResult(`/rule-groups/${id}`, { id }, c) }),
  list_rules: defineOperation({ description: "Which rules belong to this rule group?", access: "read", input: z.object({ id: entityId, ...pagination }).strict(), handler: ({ id, ...q }, c) => c.get(`/rule-groups/${id}/rules`, q) }),
  test: defineOperation({ description: "Which transactions would this rule group affect?", access: "read", input: z.object({ id: entityId, ...pagination, ...ruleFilterShape, search_limit: z.number().int().positive().optional(), triggered_limit: z.number().int().positive().optional() }).strict(), handler: ({ id, ...q }, c) => c.get(`/rule-groups/${id}/test`, q) }),
  trigger: defineOperation({ description: "Apply this rule group to matching transactions.", access: "write", input: z.object({ id: entityId, ...ruleFilterShape }).strict(), handler: ({ id, ...q }, c) => c.post(`/rule-groups/${id}/trigger`, undefined, q) }),
};
export const ruleGroupsModule: EntityModule = { entity: EntityType.RuleGroup, hint: "groups of automation rules", operations: ruleGroupOperations };

/** Why `/summary/basic` refused a single-day range, and what to ask instead.
 *
 * Firefly answers `start === end` here with a bare 422, which leaves a caller
 * guessing between malformed dates, an empty period, and a wrong endpoint. The
 * hint is attached only when the request really was one day, so it never
 * explains a refusal it cannot account for.
 *
 * It deliberately does not offer to widen the range: `balance-in-*` measures
 * movement across the period, so a wider range answers a different question
 * rather than the same one more successfully.
 */
function singleDayRefusal(start: string, end: string): string | undefined {
  if (start !== end) return undefined;
  return (
    `/summary/basic does not accept a single-day range (start and end are both ${start}). ` +
    "Widening it would change the answer rather than repair it, because balance figures here " +
    "measure movement over the period. Ask for a longer period instead, such as last_7_days."
  );
}

export const insightOperations: Record<string, Operation> = {};
for (const name of ["expense_total", "expense_category", "expense_budget", "expense_tag", "expense_no_category", "income_total", "income_category", "transfer_total"]) {
  const parts = name.split("_");
  const path = `/insight/${parts[0]}/${parts.slice(1).join("-")}`;
  insightOperations[name] = defineOperation({ description: `What is the ${name.replaceAll("_", " ")} for this period?`, access: "read", input: analysisInput, handler: (q, c) => c.get(path, withPeriod(q)) });
}
export const insightModule: EntityModule = { entity: EntityType.Insight, hint: "period totals and financial breakdowns", operations: insightOperations };
export const summaryModule: EntityModule = { entity: EntityType.Summary, hint: "combined financial summaries", operations: {
  basic: defineOperation({
    description: "What is Firefly's basic summary for this period?",
    access: "read",
    input: analysisInput,
    handler: async (q, c) => {
      const dated = withPeriod(q);
      try {
        return await c.get("/summary/basic", dated);
      } catch (error) {
        const hint = error instanceof FireflyApiError && error.status === 422
          ? singleDayRefusal(dated.start, dated.end)
          : undefined;
        if (hint === undefined) throw error;
        throw new FireflyApiError(
          (error as FireflyApiError).status,
          `${(error as FireflyApiError).detail} — ${hint}`,
          (error as FireflyApiError).errors,
        );
      }
    },
  }),
  overview: defineOperation({ description: "How did this period go across income, spending, transfers, and balances?", access: "read", input: analysisInput, handler: (q, c) => buildOverview(withPeriod(q), c) }),
} };
export const searchModule: EntityModule = { entity: EntityType.Search, hint: "find transactions and accounts by text", operations: {
  transactions: defineOperation({ description: "Which transactions match this search?", access: "read", input: z.object({ query: z.string().min(1), ...pagination }).strict(), handler: (q, c) => c.get("/search/transactions", q) }),
  accounts: defineOperation({ description: "Which accounts match this search?", access: "read", input: z.object({ query: z.string().min(1), field: z.enum(["all", "iban", "name", "number", "id"]).default("all"), type: z.string().optional(), ...pagination }).strict(), handler: (q, c) => c.get("/search/accounts", q) }),
} };

export async function buildOverview(
  query: z.infer<typeof analysisInput> & { start: string; end: string },
  client: FireflyClient,
): Promise<unknown> {
  const period = { start: query.start, end: query.end };
  // Firefly rejects start === end on /summary/basic with a 422 while every
  // insight endpoint accepts it, so a single-day overview used to fail whole.
  // Only the balances come from there, and widening the range is not a way out:
  // balance-in-* moves with `start`, so it is period movement rather than a
  // point-in-time figure, and a widened range would report a wrong balance.
  // Losing the balances beats losing the period — and it is said out loud.
  const [income, expense, transfers, categories, basic] = await Promise.all([
    client.get("/insight/income/total", period),
    client.get("/insight/expense/total", period),
    client.get("/insight/transfer/total", period),
    client.get("/insight/expense/category", period),
    client.get("/summary/basic", query).then(
      (value) => ({ ok: true as const, value, reason: "" }),
      (error: unknown) => ({ ok: false as const, value: undefined, reason: balanceFailure(error, query.start, query.end) }),
    ),
  ]);
  const totals: Record<string, Record<string, number>> = {};
  addInsightTotals(totals, income, "income", false);
  addInsightTotals(totals, expense, "expense", true);
  addInsightTotals(totals, transfers, "transfers", true);
  for (const values of Object.values(totals)) {
    values.income ??= 0;
    values.expense ??= 0;
    values.transfers ??= 0;
    values.net = Math.round((values.income - values.expense) * 100) / 100;
  }
  // The filter is what makes `currency_code` mean anything here. It used to be
  // accepted, forwarded only to /summary/basic, and then dropped with that
  // endpoint's result — so a multi-currency ledger came back whole while the
  // schema promised a single currency, with no sign the filter was ignored.
  for (const code of Object.keys(totals)) {
    if (query.currency_code !== undefined && code !== query.currency_code) delete totals[code];
  }
  const expenseByCategory = onlyCurrency(insightEntries(categories).map((entry) => ({
    name: stringValue(entry.name) ?? "unknown",
    amount: Math.abs(numberValue(entry.difference_float) ?? numberValue(entry.difference) ?? 0),
    currency_code: stringValue(entry.currency_code) ?? "unknown",
  })), query.currency_code).sort((a, b) => b.amount - a.amount);
  return {
    period: { start: query.start, end: query.end, end_is_inclusive: true },
    totals,
    expense_by_category: expenseByCategory,
    expense_category_count: expenseByCategory.length,
    balances: basic.ok ? extractBalances(basic.value) : {},
    // Said rather than left as an empty object: the model must not read missing
    // balances as a net worth of nothing.
    ...(basic.ok ? {} : { balances_unavailable: basic.reason }),
  };
}

/** Why the balances are missing, in words that point at the actual cause.
 *
 * The single-day 422 is a property of the date range and nothing else is
 * wrong, which is what the rescue was built for. Every other failure — an
 * expired token, a 500, a TLS error — is a property of the instance, and
 * reporting it as a refused period sends the model to check the dates while
 * the connection is broken. Worse, it would keep calling the totals
 * "unaffected" when they came from the same instance.
 */
function balanceFailure(error: unknown, start: string, end: string): string {
  if (error instanceof FireflyApiError && error.status === 422) {
    // The first sentence is the guarantee this report already made: the
    // balances are missing rather than zero. The hint is added to it, not
    // swapped for it — a caller that only learns how to retry has still lost
    // the reason the numbers are absent.
    const refused = "Firefly refused the balance query for this period; the totals above are unaffected.";
    const hint = singleDayRefusal(start, end);
    return hint === undefined ? refused : `${refused} ${hint}`;
  }
  const detail = error instanceof Error ? error.message : String(error);
  return `The balance query failed for a reason that is not about the date range: ${detail}. The totals above came from the same instance, so treat them with the same suspicion.`;
}

/** Keep only the currency the caller asked for.
 *
 * Applied here rather than left to the query parameter: the insight endpoints
 * group by currency in their answer, and filtering what came back is true
 * whatever the endpoint does with `currency_code`. An unmatched code yields an
 * empty result, which is the honest answer to "how much did I spend in a
 * currency I never used".
 */
function onlyCurrency<T extends { currency_code: string }>(entries: T[], code: string | undefined): T[] {
  return code === undefined ? entries : entries.filter((entry) => entry.currency_code === code);
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function insightEntries(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.filter(isRecord);
  if (isRecord(value) && Array.isArray(value.data)) return value.data.filter(isRecord);
  return [];
}
function stringValue(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }
function numberValue(value: unknown): number | undefined { return typeof value === "number" ? value : typeof value === "string" ? Number(value) : undefined; }
function addInsightTotals(totals: Record<string, Record<string, number>>, payload: unknown, field: string, absolute: boolean): void {
  for (const entry of insightEntries(payload)) {
    const code = stringValue(entry.currency_code) ?? "unknown";
    const raw = numberValue(entry.difference_float) ?? numberValue(entry.difference) ?? 0;
    totals[code] ??= {};
    totals[code]![field] = absolute ? Math.abs(raw) : raw;
  }
}
function extractBalances(payload: unknown): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (!isRecord(payload)) return result;
  const source = isRecord(payload.data) ? payload.data : payload;
  for (const value of Object.values(source)) {
    if (!isRecord(value)) continue;
    const key = stringValue(value.key);
    if (key?.startsWith("balance-in-") || key?.startsWith("net-worth-in-")) result[key] = value.monetary_value;
  }
  return result;
}
