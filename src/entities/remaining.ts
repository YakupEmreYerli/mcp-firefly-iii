import { z } from "zod";
import { defineOperation, type EntityModule, type Operation } from "../registry.js";
import { dateRange, entityId, isoDate, pagination } from "../schemas/common.js";
import { EntityType } from "../types.js";
import type { FireflyClient } from "../firefly.js";

const id = z.object({ id: entityId }).strict();
const dates = { ...dateRange };
const analysisInput = z.object({ start: isoDate, end: isoDate, currency_code: z.string().optional() }).strict();
const deleteResult = async (path: string, record: { id: string }, client: { del: (path: string) => Promise<unknown> }) => { await client.del(path); return { deleted: true, id: record.id }; };

const budgetData = z.object({ name: z.string().min(1), active: z.boolean().optional(), notes: z.string().optional() }).strict();
const limitData = z.object({ amount: z.string().min(1), start: isoDate, end: isoDate, currency_code: z.string().optional(), budget_id: entityId.optional() }).strict();
export const budgetOperations: Record<string, Operation> = {
  list: defineOperation({ description: "Which budgets exist for this period?", access: "read", input: z.object({ ...pagination, ...dates }).strict(), handler: (q, c) => c.get("/budgets", q) }),
  get: defineOperation({ description: "What are the details of this budget?", access: "read", input: z.object({ id: entityId, ...dates }).strict(), handler: ({ id, ...q }, c) => c.get(`/budgets/${id}`, q) }),
  create: defineOperation({ description: "Create a new budget.", access: "write", input: budgetData, handler: (b, c) => c.post("/budgets", b) }),
  update: defineOperation({ description: "Change an existing budget.", access: "write", input: z.object({ id: entityId, budget_update: budgetData }).strict(), handler: ({ id, budget_update }, c) => c.put(`/budgets/${id}`, budget_update) }),
  delete: defineOperation({ description: "Delete a budget.", access: "write", input: id, handler: ({ id }, c) => deleteResult(`/budgets/${id}`, { id }, c) }),
  list_limits: defineOperation({ description: "Which limits belong to this budget?", access: "read", input: z.object({ id: entityId, ...dates }).strict(), handler: ({ id, ...q }, c) => c.get(`/budgets/${id}/limits`, q) }),
  get_limit: defineOperation({ description: "What are the details of this budget limit?", access: "read", input: z.object({ budget_id: entityId, limit_id: entityId }).strict(), handler: ({ budget_id, limit_id }, c) => c.get(`/budgets/${budget_id}/limits/${limit_id}`) }),
  create_limit: defineOperation({ description: "Create a budget limit.", access: "write", input: z.object({ budget_id: entityId, budget_limit_store: limitData }).strict(), handler: ({ budget_id, budget_limit_store }, c) => c.post(`/budgets/${budget_id}/limits`, budget_limit_store) }),
  update_limit: defineOperation({ description: "Change a budget limit.", access: "write", input: z.object({ budget_id: entityId, limit_id: entityId, budget_limit: limitData }).strict(), handler: ({ budget_id, limit_id, budget_limit }, c) => c.put(`/budgets/${budget_id}/limits/${limit_id}`, budget_limit) }),
  delete_limit: defineOperation({ description: "Delete a budget limit.", access: "write", input: z.object({ budget_id: entityId, limit_id: entityId }).strict(), handler: ({ budget_id, limit_id }, c) => deleteResult(`/budgets/${budget_id}/limits/${limit_id}`, { id: limit_id }, c) }),
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
  delete: defineOperation({ description: "Delete a bill.", access: "write", input: id, handler: ({ id }, c) => deleteResult(`/bills/${id}`, { id }, c) }),
  list_transactions: defineOperation({ description: "Which transactions are associated with this bill?", access: "read", input: z.object({ id: entityId, ...pagination, ...dates, type: z.string().optional() }).strict(), handler: ({ id, ...q }, c) => c.get(`/bills/${id}/transactions`, q) }),
  list_attachments: defineOperation({ description: "Which files are attached to this bill?", access: "read", input: z.object({ id: entityId, ...pagination }).strict(), handler: ({ id, ...q }, c) => c.get(`/bills/${id}/attachments`, q) }),
  list_rules: defineOperation({ description: "Which rules set this bill?", access: "read", input: z.object({ id: entityId, ...pagination }).strict(), handler: ({ id, ...q }, c) => c.get(`/bills/${id}/rules`, q) }),
};
export const billsModule: EntityModule = { entity: EntityType.Bill, hint: "recurring bills and their transactions", operations: billOperations };

const piggyData = z.object({ name: z.string().min(1), amount: z.string().optional(), target_amount: z.string().min(1), start_date: isoDate, target_date: isoDate.optional(), transaction_currency_code: z.string().optional(), transaction_currency_id: entityId.optional(), order: z.number().int().optional(), active: z.boolean().optional(), notes: z.string().optional(), accounts: z.array(z.object({ account_id: entityId, current_amount: z.string().optional() }).strict()).min(1) }).strict();
const piggyUpdate = z.object({ name: z.string().optional(), target_amount: z.string().optional(), start_date: isoDate.optional(), target_date: isoDate.optional(), transaction_currency_code: z.string().optional(), transaction_currency_id: entityId.optional(), order: z.number().int().optional(), active: z.boolean().optional(), notes: z.string().optional(), accounts: z.array(z.object({ account_id: entityId, current_amount: z.string().optional() }).strict()).optional() }).strict();
export const piggyBankOperations: Record<string, Operation> = {
  list: defineOperation({ description: "Which piggy banks exist?", access: "read", input: z.object({ ...pagination }).strict(), handler: (q, c) => c.get("/piggy-banks", q) }),
  get: defineOperation({ description: "What are the details of this piggy bank?", access: "read", input: id, handler: ({ id }, c) => c.get(`/piggy-banks/${id}`) }),
  create: defineOperation({ description: "Create a new piggy bank.", access: "write", input: piggyData, handler: (b, c) => c.post("/piggy-banks", b) }),
  update: defineOperation({ description: "Change an existing piggy bank.", access: "write", input: z.object({ id: entityId, piggy_bank_update: piggyUpdate }).strict(), handler: ({ id, piggy_bank_update }, c) => c.put(`/piggy-banks/${id}`, piggy_bank_update) }),
  delete: defineOperation({ description: "Delete a piggy bank.", access: "write", input: id, handler: ({ id }, c) => deleteResult(`/piggy-banks/${id}`, { id }, c) }),
  list_events: defineOperation({ description: "Which events changed this piggy bank?", access: "read", input: z.object({ id: entityId, ...pagination }).strict(), handler: ({ id, ...q }, c) => c.get(`/piggy-banks/${id}/events`, q) }),
  list_attachments: defineOperation({ description: "Which files are attached to this piggy bank?", access: "read", input: z.object({ id: entityId, ...pagination }).strict(), handler: ({ id, ...q }, c) => c.get(`/piggy-banks/${id}/attachments`, q) }),
};
export const piggyBanksModule: EntityModule = { entity: EntityType.PiggyBank, hint: "savings goals and their events", operations: piggyBankOperations };

const ruleTrigger = z.object({ type: z.string().min(1), value: z.string() }).strict();
const ruleAction = z.object({ type: z.string().min(1), value: z.string() }).strict();
const ruleStore = z.object({ title: z.string().min(1), rule_group_id: entityId, description: z.string().optional(), active: z.boolean().optional(), strict: z.boolean().optional(), stop_processing: z.boolean().optional(), trigger: z.string().min(1), triggers: z.array(ruleTrigger).min(1), actions: z.array(ruleAction).min(1) }).strict();
const ruleUpdate = z.object({ title: z.string().optional(), rule_group_id: entityId.optional(), description: z.string().optional(), active: z.boolean().optional(), strict: z.boolean().optional(), stop_processing: z.boolean().optional(), trigger: z.string().optional(), triggers: z.array(ruleTrigger).optional(), actions: z.array(ruleAction).optional() }).strict();
const ruleFilterShape = { ...dates, accounts: z.array(z.number().int().positive()).optional() };
export const ruleOperations: Record<string, Operation> = {
  list: defineOperation({ description: "Which rules exist?", access: "read", input: z.object({ ...pagination }).strict(), handler: (q, c) => c.get("/rules", q) }),
  get: defineOperation({ description: "What are the details of this rule?", access: "read", input: id, handler: ({ id }, c) => c.get(`/rules/${id}`) }),
  create: defineOperation({ description: "Create a new rule.", access: "write", input: ruleStore, handler: (b, c) => c.post("/rules", b) }),
  update: defineOperation({ description: "Change an existing rule.", access: "write", input: z.object({ id: entityId, rule_update: ruleUpdate }).strict(), handler: ({ id, rule_update }, c) => c.put(`/rules/${id}`, rule_update) }),
  delete: defineOperation({ description: "Delete a rule.", access: "write", input: id, handler: ({ id }, c) => deleteResult(`/rules/${id}`, { id }, c) }),
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
  delete: defineOperation({ description: "Delete a rule group.", access: "write", input: id, handler: ({ id }, c) => deleteResult(`/rule-groups/${id}`, { id }, c) }),
  list_rules: defineOperation({ description: "Which rules belong to this rule group?", access: "read", input: z.object({ id: entityId, ...pagination }).strict(), handler: ({ id, ...q }, c) => c.get(`/rule-groups/${id}/rules`, q) }),
  test: defineOperation({ description: "Which transactions would this rule group affect?", access: "read", input: z.object({ id: entityId, ...pagination, ...ruleFilterShape, search_limit: z.number().int().positive().optional(), triggered_limit: z.number().int().positive().optional() }).strict(), handler: ({ id, ...q }, c) => c.get(`/rule-groups/${id}/test`, q) }),
  trigger: defineOperation({ description: "Apply this rule group to matching transactions.", access: "write", input: z.object({ id: entityId, ...ruleFilterShape }).strict(), handler: ({ id, ...q }, c) => c.post(`/rule-groups/${id}/trigger`, undefined, q) }),
};
export const ruleGroupsModule: EntityModule = { entity: EntityType.RuleGroup, hint: "groups of automation rules", operations: ruleGroupOperations };

export const insightOperations: Record<string, Operation> = {};
for (const name of ["expense_total", "expense_category", "expense_budget", "expense_tag", "expense_no_category", "income_total", "income_category", "transfer_total"]) {
  const parts = name.split("_");
  const path = `/insight/${parts[0]}/${parts.slice(1).join("-")}`;
  insightOperations[name] = defineOperation({ description: `What is the ${name.replaceAll("_", " ")} for this period?`, access: "read", input: analysisInput, handler: (q, c) => c.get(path, q) });
}
export const insightModule: EntityModule = { entity: EntityType.Insight, hint: "period totals and financial breakdowns", operations: insightOperations };
export const summaryModule: EntityModule = { entity: EntityType.Summary, hint: "combined financial summaries", operations: {
  basic: defineOperation({ description: "What is Firefly's basic summary for this period?", access: "read", input: analysisInput, handler: (q, c) => c.get("/summary/basic", q) }),
  overview: defineOperation({ description: "How did this period go across income, spending, transfers, and balances?", access: "read", input: analysisInput, handler: (q, c) => buildOverview(q, c) }),
} };
export const searchModule: EntityModule = { entity: EntityType.Search, hint: "find transactions and accounts by text", operations: {
  transactions: defineOperation({ description: "Which transactions match this search?", access: "read", input: z.object({ query: z.string().min(1), ...pagination }).strict(), handler: (q, c) => c.get("/search/transactions", q) }),
  accounts: defineOperation({ description: "Which accounts match this search?", access: "read", input: z.object({ query: z.string().min(1), field: z.enum(["all", "iban", "name", "number", "id"]).default("all"), type: z.string().optional(), ...pagination }).strict(), handler: (q, c) => c.get("/search/accounts", q) }),
} };

async function buildOverview(query: z.infer<typeof analysisInput>, client: FireflyClient): Promise<unknown> {
  const period = { start: query.start, end: query.end };
  const [income, expense, transfers, categories, basic] = await Promise.all([
    client.get("/insight/income/total", period),
    client.get("/insight/expense/total", period),
    client.get("/insight/transfer/total", period),
    client.get("/insight/expense/category", period),
    client.get("/summary/basic", query),
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
  const expenseByCategory = insightEntries(categories).map((entry) => ({
    name: stringValue(entry.name) ?? "unknown",
    amount: Math.abs(numberValue(entry.difference_float) ?? numberValue(entry.difference) ?? 0),
    currency_code: stringValue(entry.currency_code) ?? "unknown",
  })).sort((a, b) => b.amount - a.amount);
  return {
    period: { start: query.start, end: query.end, end_is_inclusive: true },
    totals,
    expense_by_category: expenseByCategory,
    expense_category_count: expenseByCategory.length,
    balances: extractBalances(basic),
  };
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
