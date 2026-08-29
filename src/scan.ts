import type { FireflyClient } from "./firefly.js";
import { ValidationError } from "./errors.js";

/** One split, flattened, as the bulk operations reason about it.
 *
 * Flattened on purpose: a caller asking "which Trendyol lines have no
 * category" is asking about splits, not about the groups that hold them, and
 * every field it needs to decide is here.
 */
export type ScannedRow = {
  id: string;
  journal_id: string;
  date: string;
  amount: number;
  type: string;
  description: string;
  notes: string;
  source_id: string;
  source_name: string;
  destination_id: string;
  destination_name: string;
  category_name: string;
  tags: string[];
  splits: number;
};

export type TransactionFilter = {
  start?: string;
  end?: string;
  type?: string;
  description_contains?: string;
  description_like?: string;
  notes_contains?: string;
  source_name?: string;
  destination_name?: string;
  category_name?: string;
  has_no_category?: boolean;
  tag?: string;
  amount_equals?: string;
  amount_min?: string;
  amount_max?: string;
};

const PAGE_SIZE = 100;

/** How far a scan pages before it stops and says so.
 *
 * 50 pages of 100 GROUPS each — a ledger with split transactions yields more
 * splits than that, so 5,000 is a floor on what one scan sees, not the figure.
 * The bound exists so a broken pagination reply cannot spin forever, and so an
 * operation that walks the whole ledger has a cost the caller can predict.
 * `truncated` is returned rather than thrown: silently acting on part of an
 * unknown number of matches is the failure worth preventing, and the caller
 * can narrow the date range once it is told.
 */
const MAX_PAGES = 50;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function fold(value: string): string {
  // The Turkish locale is the wrong tool here, which is easy to get backwards:
  // "ISTANBUL".toLocaleLowerCase("tr-TR") is "ıstanbul" with a dotless ı, so a
  // caller typing "istanbul" would match nothing at all. Bank exports write
  // Turkish names in ASCII capitals while people type them properly, so all
  // four of I ı İ i collapse to one letter before the fold. It is a coarser
  // comparison than either locale would give, and it is the one that finds the
  // row the caller meant.
  return value.replace(/[Iıİi]/gu, "i").toLowerCase();
}

/** A caller-supplied pattern, parsed into segments.
 *
 * Deliberately NOT a regular expression. An earlier version took one and
 * claimed a length cap it did not have: `^(a+)+$` against a 31-character
 * description pinned the event loop for over 25 seconds, from the read-only
 * surface, and JavaScript cannot interrupt a running match. A ledger
 * description is also attacker-supplied text under this project's own threat
 * model, so a pattern that reaches the engine is a pattern an injected note
 * can ask for.
 *
 * The language is two wildcards and literal text:
 *   `#`  one run of digits
 *   `*`  any run of characters, including none
 * Everything else matches itself. `086200000023377-TRENDYOL.COM ISTANBUL TR`
 * is `#-* ISTANBUL TR`. Patterns are anchored: they describe the whole value.
 */
export type PatternSegment =
  | { kind: "literal"; text: string }
  | { kind: "any" }
  | { kind: "digits" };

const MAX_PATTERN = 120;
const MAX_WILDCARDS = 8;

export function parsePattern(source: string, field: string): PatternSegment[] {
  if (source.length > MAX_PATTERN) {
    throw new ValidationError(`${field} is longer than ${MAX_PATTERN} characters`);
  }
  const segments: PatternSegment[] = [];
  let literal = "";
  let wildcards = 0;
  for (const character of source) {
    if (character !== "*" && character !== "#") {
      literal += character;
      continue;
    }
    if (literal !== "") {
      segments.push({ kind: "literal", text: literal });
      literal = "";
    }
    const previous = segments[segments.length - 1];
    if (previous !== undefined && previous.kind !== "literal") {
      // Two wildcards in a row have no single answer — `**` could split
      // anywhere — and guessing one is how a rewrite lands text in the wrong
      // capture. Rejected instead.
      throw new ValidationError(`${field} puts two wildcards next to each other; separate them with text`);
    }
    wildcards += 1;
    segments.push(character === "*" ? { kind: "any" } : { kind: "digits" });
  }
  if (literal !== "") segments.push({ kind: "literal", text: literal });
  if (wildcards > MAX_WILDCARDS) {
    throw new ValidationError(`${field} uses more than ${MAX_WILDCARDS} wildcards`);
  }
  if (segments.length === 0) throw new ValidationError(`${field} is empty`);
  return segments;
}

/** Match a value against a parsed pattern, returning what each wildcard took.
 *
 * One left-to-right pass, no backtracking: each literal is found with
 * `indexOf` from the current position and the final literal is anchored with
 * `endsWith`. Cost is bounded by value length times pattern length, so there
 * is no input that makes this expensive — which is the entire reason the
 * regular expression is gone.
 *
 * Returns the captures in order, or undefined when the value does not match.
 */
export function matchPattern(segments: PatternSegment[], value: string): string[] | undefined {
  const captures: string[] = [];
  let position = 0;

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    if (segment.kind === "literal") {
      const last = index === segments.length - 1;
      if (last) {
        // Anchored at the end, so a pattern describes the whole value rather
        // than a prefix of it.
        if (!value.endsWith(segment.text) || value.length - segment.text.length < position) return undefined;
        position = value.length;
        continue;
      }
      if (!value.startsWith(segment.text, position)) return undefined;
      position += segment.text.length;
      continue;
    }

    const next = segments[index + 1];
    if (segment.kind === "digits") {
      let end = position;
      while (end < value.length && value.charCodeAt(end) >= 48 && value.charCodeAt(end) <= 57) end += 1;
      if (end === position) return undefined;
      captures.push(value.slice(position, end));
      position = end;
      continue;
    }

    if (next === undefined) {
      captures.push(value.slice(position));
      position = value.length;
      continue;
    }
    // Only a literal can follow `*` — parsePattern rejects anything else.
    const literal = (next as { kind: "literal"; text: string }).text;
    const found =
      index + 1 === segments.length - 1
        ? value.lastIndexOf(literal)
        : value.indexOf(literal, position);
    if (found < position) return undefined;
    captures.push(value.slice(position, found));
    position = found;
  }

  return position === value.length ? captures : undefined;
}

/** Apply `$1`..`$9` from a match to a replacement template. */
export function fillTemplate(template: string, captures: string[]): string {
  return template.replace(/\$([1-9])/gu, (_whole, digit: string) => captures[Number(digit) - 1] ?? "");
}

function money(value: unknown): number {
  const parsed = Number(text(value) || value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

/** Read a filter's amount, refusing one this server cannot compare.
 *
 * `Number("1.000,00")` is NaN, and every comparison against NaN is false — so
 * an unparseable bound did not narrow the selection, it removed the condition
 * entirely and the filter matched the whole ledger. On a destructive operation
 * that is the difference between rewriting eleven rows and rewriting every row
 * the page cap allows. Turkish thousands separators make this the normal way
 * to get it wrong, so it is refused rather than tolerated.
 */
function bound(value: string | undefined, field: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = money(value);
  if (Number.isNaN(parsed)) {
    throw new ValidationError(
      `${field} is not a number this server can compare: ${JSON.stringify(value)}. Use a plain decimal such as "1000.00".`,
    );
  }
  return parsed;
}

type Bounds = { equals?: number; min?: number; max?: number };

function matches(
  row: ScannedRow,
  filter: TransactionFilter,
  bounds: Bounds,
  pattern?: PatternSegment[],
): boolean {
  if (filter.description_contains !== undefined
      && !fold(row.description).includes(fold(filter.description_contains))) return false;
  if (pattern !== undefined && matchPattern(pattern, row.description) === undefined) return false;
  if (filter.notes_contains !== undefined
      && !fold(row.notes).includes(fold(filter.notes_contains))) return false;
  if (filter.source_name !== undefined && row.source_name !== filter.source_name) return false;
  if (filter.destination_name !== undefined && row.destination_name !== filter.destination_name) return false;
  if (filter.category_name !== undefined && row.category_name !== filter.category_name) return false;
  if (filter.has_no_category === true && row.category_name !== "") return false;
  if (filter.tag !== undefined && !row.tags.includes(filter.tag)) return false;
  // A row whose own amount Firefly returned unparseably cannot satisfy a bound.
  // Excluding it is the safe direction: the alternative is that every NaN
  // comparison is false and the row slips past every bound into a write set.
  if (bounds.equals !== undefined && !(row.amount === bounds.equals)) return false;
  if (bounds.min !== undefined && !(row.amount >= bounds.min)) return false;
  if (bounds.max !== undefined && !(row.amount <= bounds.max)) return false;
  return true;
}

/** Walk the ledger and return the splits a filter selects.
 *
 * Date range and type go to Firefly, which can filter on them; everything else
 * is applied here. That split is invisible to the caller and is what lets one
 * call stand in for the read-everything-then-decide loop it would otherwise
 * have to run itself.
 */
export async function scanTransactions(
  client: FireflyClient,
  filter: TransactionFilter,
): Promise<{ rows: ScannedRow[]; scanned: number; truncated: boolean }> {
  const pattern = filter.description_like === undefined
    ? undefined
    : parsePattern(filter.description_like, "description_like");
  const bounds: Bounds = {
    equals: bound(filter.amount_equals, "amount_equals"),
    min: bound(filter.amount_min, "amount_min"),
    max: bound(filter.amount_max, "amount_max"),
  };

  const rows: ScannedRow[] = [];
  let scanned = 0;
  let truncated = false;

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const query = {
      limit: PAGE_SIZE,
      page,
      ...(filter.start === undefined ? {} : { start: filter.start }),
      ...(filter.end === undefined ? {} : { end: filter.end }),
      ...(filter.type === undefined ? {} : { type: filter.type }),
    };
    const payload = await client.get("/transactions", query);
    if (!isRecord(payload) || !Array.isArray(payload.data)) break;

    for (const record of payload.data) {
      if (!isRecord(record)) continue;
      const attributes = isRecord(record.attributes) ? record.attributes : record;
      const splits = Array.isArray(attributes.transactions)
        ? attributes.transactions.filter(isRecord)
        : [];
      for (const split of splits) {
        scanned += 1;
        const row: ScannedRow = {
          id: text(record.id),
          journal_id: text(split.transaction_journal_id),
          date: text(split.date).slice(0, 10),
          amount: money(split.amount),
          type: text(split.type),
          description: text(split.description),
          notes: text(split.notes),
          source_id: text(split.source_id),
          source_name: text(split.source_name),
          destination_id: text(split.destination_id),
          destination_name: text(split.destination_name),
          category_name: text(split.category_name),
          tags: Array.isArray(split.tags) ? split.tags.filter((tag): tag is string => typeof tag === "string") : [],
          splits: splits.length,
        };
        if (matches(row, filter, bounds, pattern)) rows.push(row);
      }
    }

    const meta = isRecord(payload.meta) && isRecord(payload.meta.pagination) ? payload.meta.pagination : {};
    const total = Number(meta.total_pages);
    if (!Number.isFinite(total)) {
      // No usable pagination meta. A full page means there is very likely more
      // behind it, and stopping here while reporting a complete scan is what
      // lets a filter-driven write act on a fraction of its matches and call
      // it a success.
      truncated = payload.data.length >= PAGE_SIZE;
      break;
    }
    if (page >= total) break;
    if (page === MAX_PAGES) truncated = true;
  }

  return { rows, scanned, truncated };
}

/** Collapse every run of digits to `#`.
 *
 * This is what turns 30 card lines that differ only in their terminal number
 * into one pattern the caller can act on. Without it a caller looking for the
 * shape of its data has to read every row to find the handful of shapes.
 */
export function digitShape(value: string): string {
  return value.replace(/\d+/gu, "#");
}
