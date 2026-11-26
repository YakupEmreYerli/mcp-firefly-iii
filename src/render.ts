/** Short plain-text rendering of operation results, for `firefly-cli`.
 *
 * The terminal caller is usually an agent paying for every byte, so a list is
 * one line per record and a single record is `key: value` lines. `--json`
 * bypasses all of this and prints the payload the MCP tools return.
 *
 * Nothing here may change a number. Firefly writes amounts with twelve
 * decimals; only trailing zeros are dropped, never significant digits.
 */
import { stringify } from "yaml";

type Row = Record<string, unknown>;

function isRecord(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const MAX_TEXT = 60;

/** "125.500000000000" → "125.50", "0.123400" → "0.1234", "7" → "7". */
export function trimAmount(text: string): string {
  const match = /^(-?\d+)\.(\d+)$/.exec(text);
  if (!match) return text;
  const [, whole, decimals] = match as unknown as [string, string, string];
  const significant = decimals.replace(/0+$/, "");
  return `${whole}.${significant.padEnd(2, "0")}`;
}

function scalar(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") {
    const flat = trimAmount(value.replace(/\s+/g, " ").trim());
    return flat.length > MAX_TEXT ? `${flat.slice(0, MAX_TEXT - 1)}…` : flat;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value) && value.every((item) => typeof item !== "object")) return value.join(",");
  return JSON.stringify(value);
}

function day(value: unknown): string {
  return typeof value === "string" ? value.slice(0, 10) : scalar(value);
}

function transactionLine(attributes: Row): string {
  const parts = [day(attributes.date), `${scalar(attributes.amount)} ${scalar(attributes.currency_code)}`.trim()];
  if (attributes.type !== undefined && attributes.type !== "withdrawal") parts.push(`(${scalar(attributes.type)})`);
  parts.push(scalar(attributes.description));
  if (attributes.source_name !== undefined || attributes.destination_name !== undefined) {
    parts.push(`${scalar(attributes.source_name)} → ${scalar(attributes.destination_name)}`);
  }
  if (attributes.category_name !== undefined) parts.push(`[${scalar(attributes.category_name)}]`);
  if (attributes.budget_name !== undefined) parts.push(`{${scalar(attributes.budget_name)}}`);
  if (attributes.tags !== undefined) parts.push(`#${scalar(attributes.tags)}`);
  if (attributes.split_count !== undefined) parts.push(`split×${scalar(attributes.split_count)}`);
  return parts.filter((part) => part !== "").join("  ");
}

/** The attributes worth a line for any other record type, in this order. */
const SUMMARY_KEYS = [
  "title", "type", "account_role", "current_balance", "balance", "amount", "amount_min", "amount_max",
  "target_amount", "current_amount", "currency_code", "date", "start", "end", "repeat_freq",
  "next_expected_match", "active", "code", "symbol", "value", "trigger", "strict", "rule_group_title",
];

function recordLine(record: Row, fields?: readonly string[]): string {
  const id = record.id === undefined ? "" : `#${scalar(record.id)}`;
  const attributes = isRecord(record.attributes) ? record.attributes : record;
  if (fields && fields.length > 0) {
    const pairs = fields.filter((key) => attributes[key] !== undefined).map((key) => `${key}=${scalar(attributes[key])}`);
    return [id, ...pairs].filter(Boolean).join("  ");
  }
  if (record.type === "transactions") return [id, transactionLine(attributes)].filter(Boolean).join("  ");

  const head = attributes.name ?? attributes.description;
  const pairs = SUMMARY_KEYS.filter((key) => attributes[key] !== undefined && !(key === "title" && head !== undefined))
    .slice(0, 6)
    .map((key) => `${key}=${scalar(attributes[key])}`);
  if (head === undefined && pairs.length === 0) {
    // Unknown shape: the first few scalar attributes rather than nothing.
    for (const [key, value] of Object.entries(attributes)) {
      if (typeof value !== "object" && pairs.length < 6) pairs.push(`${key}=${scalar(value)}`);
    }
  }
  return [id, head === undefined ? "" : scalar(head), ...pairs].filter(Boolean).join("  ");
}

function pagination(payload: Row): string | undefined {
  const meta = isRecord(payload.meta) && isRecord(payload.meta.pagination) ? payload.meta.pagination : undefined;
  if (!meta) return undefined;
  const current = Number(meta.current_page);
  const total = Number(meta.total_pages);
  if (!Number.isFinite(current) || !Number.isFinite(total) || total <= 1) return undefined;
  const next = current < total ? `  next: page=${current + 1}` : "";
  return `page ${current}/${total} (${scalar(meta.count)} of ${scalar(meta.total)})${next}`;
}

function singleRecord(record: Row): string {
  const attributes = isRecord(record.attributes) ? record.attributes : {};
  const head = [record.id === undefined ? "" : `#${scalar(record.id)}`, scalar(record.type)].filter(Boolean).join("  ");
  const lines = Object.entries(attributes).map(([key, value]) =>
    typeof value === "object" ? `${key}: ${JSON.stringify(value)}` : `${key}: ${typeof value === "string" ? trimAmount(value) : String(value)}`,
  );
  return [head, ...lines].join("\n");
}

function isFlat(value: unknown): value is Row {
  return isRecord(value) && Object.values(value).every((inner) => typeof inner !== "object" || inner === null);
}

function pairs(row: Row): string {
  return Object.entries(row).map(([key, inner]) => `${key}=${scalar(inner)}`).join("  ");
}

/** Indented `key: value` lines; a list of flat objects is one line per item. */
function tree(value: unknown, indent: string): string[] {
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${indent}(none)`];
    return value.flatMap((item) => {
      if (isFlat(item)) return [`${indent}- ${pairs(item)}`];
      if (typeof item !== "object" || item === null) return [`${indent}- ${scalar(item)}`];
      return [`${indent}-`, ...tree(item, `${indent}  `)];
    });
  }
  if (!isRecord(value)) return [`${indent}${scalar(value)}`];
  return Object.entries(value).flatMap(([key, inner]) => {
    if (typeof inner !== "object" || inner === null) return [`${indent}${key}: ${scalar(inner)}`];
    if (Array.isArray(inner) && inner.every((item) => typeof item !== "object")) return [`${indent}${key}: ${inner.join(", ")}`];
    return [`${indent}${key}:`, ...tree(inner, `${indent}  `)];
  });
}

function generic(value: unknown): string {
  if (Array.isArray(value) && value.length === 0) return "(no results)";
  if (Array.isArray(value) && value.every(isFlat)) return value.map(pairs).join("\n");
  return tree(value, "").join("\n");
}

/** Render an operation's result. `fields` is what the caller asked to keep. */
export function renderResult(payload: unknown, fields?: readonly string[]): string {
  if (!isRecord(payload)) return generic(payload);
  const { _untrusted, ...rest } = payload;
  const note = typeof _untrusted === "string" ? [`note: ${_untrusted}`] : [];
  const data = rest.data;

  let body: string[];
  if (Array.isArray(data) && (data.length === 0 || data.every(isRecord))) {
    body = data.length === 0 ? ["(no results)"] : (data as Row[]).map((record) => recordLine(record, fields));
    const pages = pagination(rest);
    if (pages) body.push(pages);
  } else if (isRecord(data) && (data.attributes !== undefined || data.id !== undefined)) {
    body = [fields && fields.length > 0 ? recordLine(data, fields) : singleRecord(data)];
  } else {
    body = [generic(rest)];
  }
  return [...body, ...note].join("\n");
}

/** Render a dry-run plan from `Registry.execute`. */
export function renderPreview(plan: Row, applyFlags: string): string {
  const lines = ["PREVIEW — nothing was written."];
  const writes = Array.isArray(plan.would_send) ? plan.would_send.filter(isRecord) : [];
  if (writes.length === 0) lines.push("(no requests would be sent)");
  for (const write of writes) {
    const query = isRecord(write.query) && Object.keys(write.query).length > 0 ? ` ${JSON.stringify(write.query)}` : "";
    lines.push(`${scalar(write.method)} ${scalar(write.path)}${query}`);
    if (write.body !== undefined) {
      lines.push(...stringify(write.body, { lineWidth: 0, defaultStringType: "QUOTE_DOUBLE", defaultKeyType: "PLAIN" }).trimEnd().split("\n").map((line) => `  ${line}`));
    }
  }
  if (plan.outcome !== undefined) lines.push(`refused: ${JSON.stringify(plan.outcome)}`);
  const warnings = Array.isArray(plan.warnings) ? plan.warnings.filter(isRecord) : [];
  for (const warning of warnings) lines.push(`WARNING ${scalar(warning.kind)}: ${String(warning.message)}`);
  if (typeof plan._untrusted === "string") lines.push(`note: ${plan._untrusted}`);
  lines.push(`To apply, run the same command with ${applyFlags}.`);
  return lines.join("\n");
}
