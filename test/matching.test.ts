import { describe, expect, it } from "vitest";
import { normalize, resolve, score } from "../src/matching.js";

/** Names taken from the live instance, so the cases are the real ones. */
const ACCOUNTS = ["Nakit (Cüzdan)", "Enpara (Vadesiz TL)", "Midas", "Aile / Harçlık"];
const CATEGORIES = ["Diğer", "Dijital abonelikler", "Eğitim", "Eğlence", "Giyim", "Market", "Ulaşım", "Yeme & İçme"];

const pick = (query: string, names: string[]) => {
  const result = resolve(query, names, (name) => name);
  return result.matched ? result.best.name : undefined;
};
const kindOf = (query: string, names: string[]) => {
  const result = resolve(query, names, (name) => name);
  return result.matched ? result.best.kind : undefined;
};

describe("normalize", () => {
  it("folds the two Turkish letters a plain lowercase gets wrong", () => {
    // toLowerCase maps I to i where Turkish wants ı, and leaves İ with a
    // combining dot; both spellings have to land on the same token.
    expect(normalize("NAKİT")).toBe(normalize("nakit"));
    expect(normalize("IŞIK")).toBe(normalize("ışık"));
  });

  it("folds the rest of the alphabet too", () => {
    expect(normalize("Eğlence")).toBe("eglence");
    expect(normalize("Ulaşım")).toBe("ulasim");
    expect(normalize("Cüzdan")).toBe("cuzdan");
  });

  it("turns punctuation into a separator rather than deleting it", () => {
    // Deleting it would glue "Nakit(Cüzdan)" into one word matching neither.
    expect(normalize("Nakit(Cüzdan)")).toBe("nakit cuzdan");
    expect(normalize("Yeme & İçme")).toBe("yeme icme");
  });
});

describe("score", () => {
  it("calls an identical name exact whatever the casing", () => {
    expect(score("NAKİT", "Nakit")?.kind).toBe("exact");
  });

  it("treats a shorter query as an abbreviation of the name", () => {
    expect(score("nakit", "Nakit (Cüzdan)")?.kind).toBe("contains");
  });

  it("does not treat a longer query as an abbreviation, since it names something else", () => {
    expect(score("nakit cüzdan hesabı", "Nakit")?.kind).not.toBe("contains");
  });

  it("ranks a full name above a partial one, so the exact account wins", () => {
    const partial = score("nakit", "Nakit (Cüzdan)")!;
    const full = score("nakit", "Nakit")!;
    expect(full.score).toBeGreaterThan(partial.score);
  });

  it("bridges a Turkish suffix that neither name contains", () => {
    expect(score("yemek", "Yeme & İçme")?.kind).toBe("stem");
  });

  it("refuses a shared stem too short to mean anything", () => {
    // The query is the longer word here, so only the stem tier could match it.
    // Three letters would tie half a category list together.
    expect(score("abcdefg", "abc")).toBeUndefined();
  });

  it("lets a short query prefix a name, and leaves the ambiguity to the margin", () => {
    // "gi" naming Giyim is fine on its own; it is two candidates that make it
    // a question, and that is decided in resolve, not here.
    expect(score("gi", "Giyim")?.kind).toBe("contains");
    expect(resolve("gi", ["Giyim", "Gider"], (name) => name).matched).toBe(false);
  });

  it("gives up rather than returning a weak score for unrelated words", () => {
    expect(score("xyzqwe", "Market")).toBeUndefined();
  });
});

describe("resolve", () => {
  it("finds the account behind the name the user actually says", () => {
    expect(pick("nakit", ACCOUNTS)).toBe("Nakit (Cüzdan)");
    expect(kindOf("nakit", ACCOUNTS)).toBe("contains");
  });

  it("finds it from the other half of the name too", () => {
    expect(pick("cüzdan", ACCOUNTS)).toBe("Nakit (Cüzdan)");
  });

  it("matches categories written without their Turkish letters", () => {
    expect(pick("ulasim", CATEGORIES)).toBe("Ulaşım");
    expect(pick("eglence", CATEGORIES)).toBe("Eğlence");
  });

  it("reaches a category through a shared stem", () => {
    expect(pick("yemek", CATEGORIES)).toBe("Yeme & İçme");
  });

  it("declines to choose between two names that fit equally", () => {
    // Guessing here would record a transaction against the wrong account.
    const result = resolve("hesap", ["Hesap A", "Hesap B"], (name) => name);
    expect(result.matched).toBe(false);
    if (!result.matched) expect(result.candidates.map((c) => c.name)).toEqual(["Hesap A", "Hesap B"]);
  });

  it("still answers when one of the near-ties is the name exactly", () => {
    const result = resolve("Market", ["Market", "Market Ek"], (name) => name);
    expect(result.matched).toBe(true);
    if (result.matched) expect(result.best.name).toBe("Market");
  });

  it("returns nothing at all rather than the least bad option", () => {
    const result = resolve("xyzqwe", ACCOUNTS, (name) => name);
    expect(result.matched).toBe(false);
    if (!result.matched) expect(result.candidates).toEqual([]);
  });

  it("carries the runners-up, so the caller can name them to the user", () => {
    const result = resolve("nakit", ACCOUNTS, (name) => name);
    expect(result.matched).toBe(true);
  });
});
