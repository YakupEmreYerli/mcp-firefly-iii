// Maintainer tool, not part of the published package.
//
// Walks the write operations against a DISPOSABLE local Firefly III: create,
// read back, update, read back, delete, confirm gone. Every write is checked
// with an independent read through the raw client, because a 200 from Firefly
// is not proof the change landed (an unknown wrapper key returns 200 and
// changes nothing). It refuses to run unless the instance is on loopback and
// FIREFLY_WRITE_SMOKE=disposable is set.
//
// Run with: npm run smoke:write   (reads .env.demo)

import { loadConfig } from "../dist/config.js";
import { createClient } from "../dist/firefly.js";
import { Registry } from "../dist/registry.js";
import { ENTITY_MODULES } from "../dist/server.js";
import { assertDisposableInstance } from "./api-audit/guard.mjs";

const config = loadConfig();
assertDisposableInstance(config.apiUrl, process.env);
const client = createClient(config);
const registry = new Registry(config, client);
for (const module of ENTITY_MODULES) registry.register(module);

const results = [];
const run = (entity, operation, params) => registry.execute(entity, operation, params);
const idOf = (payload) => payload?.data?.id ?? payload?.id;
const attributesAt = async (path) => (await client.get(path)).data.attributes;

/** Compare what we sent with what Firefly stored. Fields Firefly does not echo are skipped. */
function mismatches(sent, stored, prefix = "") {
  const out = [];
  for (const [key, value] of Object.entries(sent)) {
    if (!(key in stored)) continue;
    const got = stored[key];
    if (Array.isArray(value) && Array.isArray(got)) {
      value.forEach((item, i) => {
        if (item && typeof item === "object" && got[i] && typeof got[i] === "object") out.push(...mismatches(item, got[i], `${prefix}${key}[${i}].`));
      });
      continue;
    }
    if (value && typeof value === "object") continue;
    const same =
      String(got) === String(value) ||
      (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value) && String(got).startsWith(value.slice(0, 10))) ||
      (!Number.isNaN(Number(value)) && value !== "" && Number(got) === Number(value)) ||
      (typeof value === "string" && typeof got === "string" && got.toLowerCase() === value.toLowerCase());
    if (!same) out.push(`${prefix}${key}: sent ${JSON.stringify(value)}, stored ${JSON.stringify(got)}`);
  }
  return out;
}

async function step(name, fn) {
  try {
    const problems = (await fn()) ?? [];
    results.push({ name, status: problems.length ? "mismatch" : "ok", detail: problems.join("; ") });
  } catch (error) {
    results.push({ name, status: "error", detail: (error instanceof Error ? error.message : String(error)).split("\n")[0].slice(0, 220) });
  }
}

/** create → read → update → read → delete → gone, for one entity. */
async function lifecycle({ entity, path, create, update, wrapper, deleteParams, unchecked = [] }) {
  let id;
  await step(`${entity}.create`, async () => {
    id = idOf(await run(entity, "create", create));
    if (!id) throw new Error("no id in create response");
    const checked = Object.fromEntries(Object.entries(create).filter(([key]) => !unchecked.includes(key)));
    return mismatches(checked, await attributesAt(`${path}/${id}`));
  });
  if (!id) return;
  if (update) {
    await step(`${entity}.update`, async () => {
      await run(entity, "update", { id, [wrapper]: update });
      return mismatches(update, await attributesAt(`${path}/${id}`));
    });
  }
  await step(`${entity}.delete`, async () => {
    await run(entity, "delete", deleteParams ? deleteParams(id) : { id });
    try {
      await client.get(`${path}/${id}`);
      return ["still readable after delete"];
    } catch {
      return [];
    }
  });
}

// Foreign currencies used below must be enabled.
for (const code of ["IDR", "USD"]) await run("currency", "enable", { code }).catch(() => undefined);

await lifecycle({
  entity: "bill", path: "/bills", wrapper: "bill_update",
  create: { name: "Smoke IDR bill", amount_min: "66600", amount_max: "66600", date: "2026-12-19", repeat_freq: "monthly", currency_code: "IDR", end_date: "2027-12-31", extension_date: "2027-06-30", notes: "smoke" },
  update: { name: "Smoke IDR bill", currency_code: "USD", order: 3, object_group_title: "Smoke group" },
});

await lifecycle({
  entity: "piggy_bank", path: "/piggy-banks", wrapper: "piggy_bank_update",
  create: { name: "Smoke piggy", target_amount: "500", start_date: "2026-11-01", accounts: [{ account_id: "3", current_amount: "50" }], transaction_currency_code: "EUR", object_group_title: "Smoke goals", notes: "smoke" },
  update: { name: "Smoke piggy renamed", target_amount: "600" },
});

await lifecycle({
  entity: "category", path: "/categories", wrapper: "category_update",
  create: { name: "Smoke category", notes: "smoke", color: "ff8800" },
  update: { name: "Smoke category", color: "0088ff" },
});

await lifecycle({
  entity: "budget", path: "/budgets", wrapper: "budget_update",
  create: { name: "Smoke budget", auto_budget_type: "reset", auto_budget_amount: "100", auto_budget_period: "monthly", auto_budget_currency_code: "EUR" },
  update: { name: "Smoke budget", auto_budget_type: "reset", auto_budget_amount: "150", auto_budget_period: "monthly" },
});

await lifecycle({
  entity: "tag", path: "/tags", wrapper: "tag_update",
  create: { tag: "smoke-tag", description: "smoke" },
  update: { tag: "smoke-tag", description: "smoke updated" },
});

await lifecycle({
  entity: "account", path: "/accounts", wrapper: "account_update",
  create: { name: "Smoke loan", type: "liability", liability_type: "loan", liability_direction: "credit", interest: "3", interest_period: "monthly", currency_code: "EUR", notes: "smoke" },
  update: { name: "Smoke loan", liability_amount: "1000", liability_start_date: "2026-01-15" },
  // Firefly stores the type as "liabilities"; the request word is "liability".
  unchecked: ["type"],
});

// Budget limits hang off a budget.
await step("budget.limit lifecycle", async () => {
  const budgetId = idOf(await run("budget", "create", { name: "Smoke limit budget" }));
  const limit = { amount: "200", start: "2026-11-01", end: "2026-11-30", notes: "smoke limit" };
  const limitId = idOf(await run("budget", "create_limit", { budget_id: budgetId, budget_limit_store: limit }));
  const problems = mismatches(limit, await attributesAt(`/budgets/${budgetId}/limits/${limitId}`));
  await run("budget", "update_limit", { budget_id: budgetId, limit_id: limitId, budget_limit: { amount: "250", start: "2026-11-01", end: "2026-11-30", notes: "changed" } });
  problems.push(...mismatches({ amount: "250", notes: "changed" }, await attributesAt(`/budgets/${budgetId}/limits/${limitId}`)));
  await run("budget", "delete", { id: budgetId });
  return problems;
});

// Rules: a prohibited ("not") trigger must stay prohibited.
await step("rule lifecycle", async () => {
  const groupId = idOf(await run("rule_group", "create", { title: "Smoke rules" }));
  const triggers = [{ type: "description_contains", value: "smoke", prohibited: true }];
  const ruleId = idOf(await run("rule", "create", { title: "Smoke rule", rule_group_id: groupId, trigger: "store-journal", triggers, actions: [{ type: "set_category", value: "Smoke" }], order: 1 }));
  const stored = await attributesAt(`/rules/${ruleId}`);
  const problems = mismatches({ prohibited: true }, stored.triggers[0] ?? {}, "triggers[0].");
  await run("rule", "update", { id: ruleId, rule_update: { title: "Smoke rule 2" } });
  problems.push(...mismatches({ title: "Smoke rule 2" }, await attributesAt(`/rules/${ruleId}`)));
  await run("rule_group", "delete", { id: groupId });
  return problems;
});

// Transactions, a link between two of them, then cleanup.
await step("transaction lifecycle", async () => {
  let stage = "create";
  try {
  const split = { type: "withdrawal", date: "2026-11-10", amount: "12.50", description: "Smoke coffee", source_id: "1", destination_name: "Smoke Cafe", internal_reference: "SMOKE-1", external_url: "https://example.com/r/1", book_date: "2026-11-11" };
  const created = await run("transaction", "create", { transactions: [split] });
  const id = idOf(created);
  const stored = (await client.get(`/transactions/${id}`)).data.attributes.transactions[0];
  const problems = mismatches(split, stored, "split.");
  stage = "update";
  await run("transaction", "update", { id, transactions: [{ transaction_journal_id: stored.transaction_journal_id, description: "Smoke coffee 2", due_date: "2026-11-20" }] });
  const after = (await client.get(`/transactions/${id}`)).data.attributes.transactions[0];
  problems.push(...mismatches({ description: "Smoke coffee 2", due_date: "2026-11-20" }, after, "split."));

  stage = "link";
  const otherId = idOf(await run("transaction", "create", { transactions: [{ ...split, description: "Smoke refund", internal_reference: "SMOKE-2" }] }));
  const other = (await client.get(`/transactions/${otherId}`)).data.attributes.transactions[0];
  const linkId = idOf(await run("transaction_link", "create", { link_type_name: "Related", inward_id: stored.transaction_journal_id, outward_id: other.transaction_journal_id, notes: "smoke" }));
  // Update by id with both ends: link_type_name corrupts the link on 6.7.9.
  const refund = (await client.get("/link-types")).data.find((t) => t.attributes.name === "Refund");
  await run("transaction_link", "update", { id: linkId, transaction_link_update: { link_type_id: refund.id, inward_id: stored.transaction_journal_id, outward_id: other.transaction_journal_id, notes: "changed" } });
  problems.push(...mismatches({ link_type_id: refund.id, notes: "changed" }, await attributesAt(`/transaction-links/${linkId}`), "link."));
  await run("transaction_link", "delete", { id: linkId });
  stage = "bulk_update";
  await run("transaction", "bulk_update", { updates: [{ transaction_id: String(id), fields: { description: "Smoke coffee bulk", notes: "bulk" } }] });
  const bulk = (await client.get(`/transactions/${id}`)).data.attributes.transactions[0];
  problems.push(...mismatches({ description: "Smoke coffee bulk", notes: "bulk" }, bulk, "bulk."));
  stage = "cleanup";
  await run("transaction", "delete", { id });
  await run("transaction", "delete", { id: otherId });
  return problems;
  } catch (error) {
    throw new Error(`at ${stage}: ${error instanceof Error ? error.message : String(error)}`);
  }
});

await step("exchange_rate lifecycle", async () => {
  const rate = { from: "USD", to: "EUR", rate: "0.9", date: "2026-11-01" };
  const id = idOf(await run("exchange_rate", "create", rate));
  const problems = mismatches({ rate: "0.9" }, await attributesAt(`/exchange-rates/${id}`));
  await run("exchange_rate", "update", { id, exchange_rate_update: { rate: "0.95", date: "2026-11-01" } });
  problems.push(...mismatches({ rate: "0.95" }, await attributesAt(`/exchange-rates/${id}`)));
  await run("exchange_rate", "delete", { id });
  return problems;
});

await step("recurring_transaction lifecycle", async () => {
  const id = idOf(await run("recurring_transaction", "create", {
    type: "withdrawal", title: "Smoke rent", first_date: "2026-12-01", repeat_until: "2027-12-01",
    repetitions: [{ type: "monthly", moment: "1" }],
    transactions: [{ description: "Smoke rent", amount: "900", source_id: "1", destination_id: "7" }],
  }));
  // The update replaces the transactions, so they are sent back as stored.
  const current = (await attributesAt(`/recurrences/${id}`)).transactions.map((t) => ({ description: t.description, amount: t.amount, source_id: String(t.source_id), destination_id: String(t.destination_id) }));
  await run("recurring_transaction", "update", { id, recurrence_update: { title: "Smoke rent 2", transactions: current } });
  const problems = mismatches({ title: "Smoke rent 2" }, await attributesAt(`/recurrences/${id}`));
  await run("recurring_transaction", "delete", { id });
  return problems;
});

const width = Math.max(...results.map((r) => r.name.length));
for (const r of results) console.log(`${r.status.padEnd(8)} ${r.name.padEnd(width)}  ${r.detail}`);
const bad = results.filter((r) => r.status !== "ok").length;
console.log(`\n${results.length - bad}/${results.length} ok`);
process.exitCode = bad ? 1 : 0;
