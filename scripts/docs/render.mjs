// Rewrite the parts of the documentation that describe operations and are
// therefore derivable from the model `extract.mjs` builds — never the prose
// around them. A `| Entity | Purpose |` description ("Asset, expense, revenue
// and liability accounts") and a behaviour paragraph ("bulk_tag adds; it does
// not replace") are human judgement and are preserved verbatim; only the
// operation column and the operation counts are rewritten.
//
// Every function here is pure: (text, model) -> { text, changed }. `apply()`
// and `check()` are the only functions that touch the filesystem, and they
// differ only in whether the result is written.

import fs from "node:fs";
import path from "node:path";

// The order of the table rows and the human-written purpose for each entity.
// Order and purpose are authored, not derived; the operations beside them are.
export const ENTITY_ROWS = [
  ["summary", "Period summary and overview"],
  ["analysis", "Questions answered from the ledger rather than fetched"],
  ["resolve", "Turning a name a user said into the record they meant"],
  ["search", "Finding records without knowing an ID"],
  ["insight", "Spending and income analysis"],
  ["account", "Asset, expense, revenue and liability accounts"],
  ["transaction", "Transactions and transfers"],
  ["budget", "Budgets and spending limits"],
  ["category", "Transaction categories"],
  ["tag", "Transaction tags"],
  ["bill", "Recurring bills"],
  ["piggy_bank", "Savings goals"],
  ["rule", "Automation rules"],
  ["rule_group", "Rule groups"],
  ["currency", "Currencies"],
  ["exchange_rate", "Currency conversion rates"],
  ["attachment", "Files attached to financial records"],
  ["recurring_transaction", "Scheduled recurring transactions"],
  ["autocomplete", "Fast lookup suggestions"],
  ["available_budget", "Budget available within a period"],
  ["transaction_link", "Relationships between transactions"],
  ["link_type", "Names for those relationships"],
  ["object_group", "Groups of accounts and records"],
  ["preference", "User preferences"],
  ["configuration", "Firefly system settings"],
  ["data_export", "Exporting financial data"],
];

function byEntity(operations) {
  const map = new Map();
  for (const op of operations) {
    if (!map.has(op.entity)) map.set(op.entity, []);
    map.get(op.entity).push(op);
  }
  for (const list of map.values()) list.sort((a, b) => a.operation.localeCompare(b.operation));
  return map;
}

// The markdown table body shared by docs/index.md and docs/api/operations.md.
export function tableRows(model) {
  const grouped = byEntity(model.operations);
  const known = new Set(grouped.keys());
  const ordered = ENTITY_ROWS.filter(([entity]) => known.has(entity));
  const unknown = [...known].filter((entity) => !ENTITY_ROWS.some(([name]) => name === entity)).sort();
  for (const entity of unknown) ordered.push([entity, ""]); // new entity we have no purpose for
  return ordered.map(([entity, purpose]) => {
    const ops = grouped.get(entity).map((entry) => entry.operation);
    return `| **${entity}** | ${purpose} | ${ops.join(", ")} |`;
  });
}

// Replace `N operations` (a bare operation count, e.g. "146 operations across
// 26 entities", "**146 operations**", "All 146 operations") with the current
// count. A number in parentheses is an entity-specific count — "the largest
// entity (13 operations)" is about budgets, not the whole surface — and must
// not be rewritten to the total.
function rewriteCount(fullText, count) {
  return fullText.replace(/(?<!\()\b\d+\b(?= operations)/g, `${count}`);
}

function rewriteCountTr(fullText, count) {
  return fullText.replace(/(?<!\()\b\d+\b(?= operasyon)/g, `${count}`);
}

function replaceDescriptionSentence(fullText, { count, entities }) {
  let text = rewriteCount(fullText, count);
  text = text.replace(/\d+ operations across \d+ entities/g, `${count} operations across ${entities} entities`);
  text = rewriteCountTr(text, count);
  return { text, changed: text !== fullText };
}

// Find the table block: a run of lines that are markdown table rows, headed
// by "Entity" and "Purpose".
function replaceTableIn(fullText, replacementRows) {
  const lines = fullText.split("\n");
  const out = [];
  let i = 0;
  let changed = false;
  while (i < lines.length) {
    const line = lines[i];
    const isTableRow = /^\|/.test(line.trim()) && /.+\|/.test(line);
    if (isTableRow && /^\|.*Entity.*\|.*Purpose.*\|/.test(line)) {
      out.push(line);
      i += 1;
      out.push(lines[i]); // separator
      i += 1;
      // Skip the old rows. `isTableRow` above was computed once, for the
      // header line, and never changes — reusing it here (as an earlier
      // version of this function did) is `true` forever, so this loop ran to
      // the end of the file and silently deleted every line after the table,
      // headings and all. Each row must be tested on its own text.
      while (i < lines.length && /^\|/.test(lines[i].trim()) && /.+\|/.test(lines[i])) i += 1;
      out.push(...replacementRows);
      changed = true;
      continue;
    }
    out.push(line);
    i += 1;
  }
  return { text: out.join("\n"), changed };
}

// operations.md uses a plain header `| Entity | Count | Operations |`.
function replaceCellTitlesIn(fullText, model) {
  const lines = fullText.split("\n");
  const out = [];
  let i = 0;
  let changed = false;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim().startsWith("|") && line.includes("Count") && line.includes("Operations")) {
      out.push(line);
      i += 1;
      out.push(lines[i]); // separator
      i += 1;
      const grouped = byEntity(model.operations);
      while (i < lines.length && /^\|/.test(lines[i].trim()) && /\|/.test(lines[i])) i += 1;
      for (const [entity] of ENTITY_ROWS) {
        const ops = grouped.get(entity);
        if (!ops) continue;
        out.push(`| \`${entity}\` | ${ops.length} | ${ops.map((e) => e.operation).join(", ")} |`);
      }
      changed = true;
      continue;
    }
    out.push(line);
    i += 1;
  }
  return { text: out.join("\n"), changed };
}

/** Every rewrite `docs/index.md` needs: its operation table, then the count
 * sentence over whatever the table left behind. */
export function renderIndex(text, model) {
  const tabular = replaceTableIn(text, tableRows(model));
  const counted = replaceDescriptionSentence(tabular.text, { count: model.operations.length, entities: model.entities.length });
  return { text: counted.text, changed: counted.text !== text };
}

/** Every rewrite `docs/api/operations.md` needs: its own table shape, then
 * the same count sentence. */
export function renderOperationsPage(text, model) {
  const tabular = replaceCellTitlesIn(text, model);
  const counted = replaceDescriptionSentence(tabular.text, { count: model.operations.length, entities: model.entities.length });
  return { text: counted.text, changed: counted.text !== text };
}

/** Every other doc page: only the bare count sentence, never a table — a page
 * outside the two above has no operation table to rewrite. */
export function renderCountOnly(text, model) {
  const { text: next } = replaceDescriptionSentence(text, { count: model.operations.length, entities: model.entities.length });
  return { text: next, changed: next !== text };
}

/** Which renderer a given doc file needs. Exported so `validate.mjs` can ask
 * the same question without re-implementing the routing. */
export function rendererFor(file) {
  if (file === "docs/index.md") return renderIndex;
  if (file === "docs/api/operations.md") return renderOperationsPage;
  return renderCountOnly;
}

/** Run every renderer against the model and return the edits that would
 * result — without touching disk. `apply()` and `check()` both go through
 * this, so there is exactly one place that decides what "in sync" means. */
export function planEdits(model) {
  const edits = [];
  for (const file of model.docFiles) {
    const p = path.resolve(file);
    if (!fs.existsSync(p)) continue;
    const text = fs.readFileSync(p, "utf8");
    const { text: next, changed } = rendererFor(file)(text, model);
    if (changed) edits.push({ file, next, before: text });
  }
  return edits;
}

export function apply(model) {
  const edits = planEdits(model);
  for (const edit of edits) fs.writeFileSync(path.resolve(edit.file), edit.next);
  return edits;
}
