/** Name matching for Firefly entities the caller named in prose.
 *
 * The problem this solves showed up in a real conversation: the account is
 * called "Nakit (Cüzdan)", the user said "Nakit", and the assistant picked the
 * right account but the user could not tell — they asked whether it had been
 * renamed. Resolving a name is a matter of trust, not convenience, so this
 * layer reports how it matched and refuses to choose when it is not sure.
 */

/** Turkish letters folded to ASCII.
 *
 * `toLowerCase()` alone is wrong for this language: it maps `I` to `i` when
 * Turkish wants `ı`, and leaves `İ` as `i̇` with a combining dot. Folding both
 * cases of every affected letter to a plain ASCII stand-in sidesteps the whole
 * question, because the fold only ever has to be self-consistent.
 */
const FOLD: Record<string, string> = {
  ç: "c", Ç: "c", ğ: "g", Ğ: "g", ı: "i", I: "i", İ: "i", i: "i",
  ö: "o", Ö: "o", ş: "s", Ş: "s", ü: "u", Ü: "u",
};

/** A name reduced to what matching should care about.
 *
 * Punctuation becomes a space rather than vanishing, so "Nakit(Cüzdan)" and
 * "Nakit (Cüzdan)" reduce to the same two tokens instead of one run-together
 * word that matches neither.
 */
export function normalize(value: string): string {
  return value
    .replace(/[çÇğĞıIİiöÖşŞüÜ]/g, (character) => FOLD[character] ?? character)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokens(value: string): string[] {
  return normalize(value).split(" ").filter(Boolean);
}

/** Levenshtein distance, iterative and single-row.
 *
 * Used only as the last resort below, on short names, so the quadratic cost
 * never matters here.
 */
function distance(left: string, right: string): number {
  if (left === right) return 0;
  if (left.length === 0) return right.length;
  if (right.length === 0) return left.length;

  let previous = Array.from({ length: right.length + 1 }, (_unused, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= right.length; j += 1) {
      const substitution = previous[j - 1]! + (left[i - 1] === right[j - 1] ? 0 : 1);
      current[j] = Math.min(current[j - 1]! + 1, previous[j]! + 1, substitution);
    }
    previous = current;
  }
  return previous[right.length]!;
}

/** How a candidate matched, strongest first. */
export type MatchKind = "exact" | "contains" | "stem" | "close";

/** Shortest prefix worth treating as a shared stem.
 *
 * Turkish glues suffixes onto stems, so "yemek" and "Yeme & İçme" share a stem
 * that neither contains. Three letters would make "gid" tie half the category
 * list together; four is short enough for real stems and long enough that a
 * coincidence is unlikely.
 */
const STEM_LENGTH = 4;

function sharesStem(left: string, right: string): boolean {
  const shorter = left.length <= right.length ? left : right;
  const longer = shorter === left ? right : left;
  return shorter.length >= STEM_LENGTH && longer.startsWith(shorter);
}

export type Scored = { score: number; kind: MatchKind };

/** How much of the name the caller actually wrote, as a fraction of it.
 *
 * Clamped at 1 because the ratio is otherwise unbounded above: a caller who
 * repeats a word ("Nakit Nakit") supplies more tokens than a one-word name
 * holds, and the raw ratio would push a `contains` score past the 1.0 an exact
 * match scores — inverting the tier order rather than blurring it. Coverage
 * cannot exceed the whole name, so the clamp is the honest reading.
 */
function coverage(queryTokens: string[], candidateTokens: string[]): number {
  return Math.min(1, queryTokens.length / candidateTokens.length);
}

/** Score one candidate name against what the caller wrote.
 *
 * The tiers are ordered by how much interpretation each one takes:
 *
 * - `exact` — the same name once folded. "NAKİT" is the account "Nakit".
 * - `contains` — every word the caller wrote appears in the name. This is the
 *   "Nakit" / "Nakit (Cüzdan)" case, and it is deliberately one-directional:
 *   a caller who writes less than the full name is abbreviating, while one who
 *   writes more is naming something else.
 * - `stem` — every word shares a prefix with one in the name, in either
 *   direction. "yemek" and "Yeme & İçme" contain neither the other.
 * - `close` — a typo, measured as edit distance over the longer string.
 *
 * Returns undefined when nothing plausible is left, so a caller cannot mistake
 * a weak score for a weak match.
 */
export function score(query: string, candidate: string): Scored | undefined {
  const left = normalize(query);
  const right = normalize(candidate);
  if (left === "" || right === "") return undefined;
  if (left === right) return { score: 1, kind: "exact" };

  const queryTokens = tokens(query);
  const candidateTokens = tokens(candidate);
  const everyWordAppears = queryTokens.every((word) =>
    candidateTokens.some((other) => other === word || other.startsWith(word)),
  );
  if (everyWordAppears) {
    // Nearer to 1 the more of the name the caller actually wrote, so "Nakit"
    // loses to an account literally called "Nakit" but still beats a typo.
    return { score: 0.75 + 0.2 * coverage(queryTokens, candidateTokens), kind: "contains" };
  }

  // A shared stem, in either direction: the caller's word may be the longer
  // one. Ranked below `contains` because it is a guess about morphology.
  const everyWordShares = queryTokens.every((word) => candidateTokens.some((other) => sharesStem(word, other)));
  if (everyWordShares) {
    return { score: 0.6 + 0.15 * coverage(queryTokens, candidateTokens), kind: "stem" };
  }

  const longest = Math.max(left.length, right.length);
  const similarity = 1 - distance(left, right) / longest;
  return similarity >= 0.8 ? { score: similarity * 0.55, kind: "close" } : undefined;
}

export type Candidate<T> = { item: T; name: string; score: number; kind: MatchKind };

export type Resolution<T> =
  | { matched: true; best: Candidate<T>; others: Candidate<T>[] }
  | { matched: false; candidates: Candidate<T>[] };

/** The margin a winner needs over the runner-up before it is called a match.
 *
 * Without it, two accounts scoring 0.95 and 0.94 would silently become a
 * decision. Writing to the wrong account is far more expensive than asking.
 */
const MARGIN = 0.08;

/** Pick a match, or report the candidates and decline to choose.
 *
 * Declining is the point. A resolver that always answers moves the failure
 * from "I could not tell" — which a caller can act on — to a transaction
 * recorded against the wrong account, which nobody notices until reconciling.
 */
export function resolve<T>(query: string, items: T[], nameOf: (item: T) => string): Resolution<T> {
  const scored = items
    .map((item) => {
      const name = nameOf(item);
      const result = score(query, name);
      return result === undefined ? undefined : { item, name, score: result.score, kind: result.kind };
    })
    .filter((entry): entry is Candidate<T> => entry !== undefined)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) return { matched: false, candidates: [] };

  const [best, runnerUp] = scored;
  const clear = runnerUp === undefined || best!.score - runnerUp.score >= MARGIN;
  // An exact hit wins even against a near tie: a name that is literally the
  // one asked for is not an ambiguity worth raising.
  if (clear || best!.kind === "exact") {
    return { matched: true, best: best!, others: scored.slice(1, 5) };
  }
  return { matched: false, candidates: scored.slice(0, 5) };
}
