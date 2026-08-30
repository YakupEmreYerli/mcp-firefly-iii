import { describe, expect, it, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  checkConfigCoverage,
  checkLinks,
  checkOperationReferences,
  checkDemoVideo,
  checkGeneratedMedia,
  checkSharedParameterCoverage,
} from "../../scripts/docs/validate.mjs";
import { STAMP_KEY, readText, writeText } from "../../scripts/png-text.mjs";

// Every check reads real files by the path the model names, so these tests
// write real (throwaway) files under a temp dir and point the model at them
// with paths relative to process.cwd() — the same shape `extract.mjs`
// produces. Cleaned up after each test regardless of outcome.
const written: string[] = [];

function writeDoc(relPath: string, content: string): string {
  const full = path.resolve(relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  written.push(full);
  return relPath;
}

afterEach(() => {
  for (const file of written.splice(0)) fs.rmSync(file, { force: true });
});

function tempDocPath(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "docgen-test-"));
  // Use a path under the repo so path.resolve/relative behave the same way
  // the real pipeline sees them, but namespaced so a failed test cannot
  // collide with a real doc file.
  return `.docgen-test-${path.basename(dir)}-${name}`;
}

describe("checkConfigCoverage", () => {
  it("flags an env var the source reads but the page never mentions", () => {
    const file = writeDoc(tempDocPath("config.md"), "This page never mentions the variable.\n");
    const problems = checkConfigCoverage({ envVars: ["FIREFLY_TOTALLY_UNDOCUMENTED"], retiredEnvVars: [] } as never, file);
    expect(problems).toEqual([`${file}: does not mention FIREFLY_TOTALLY_UNDOCUMENTED, which the source reads`]);
  });

  it("passes once the page mentions every active and retired variable", () => {
    const file = writeDoc(tempDocPath("config.md"), "FIREFLY_API_URL and FIREFLY_OLD_SETTING are both here.\n");
    const problems = checkConfigCoverage(
      { envVars: ["FIREFLY_API_URL"], retiredEnvVars: ["FIREFLY_OLD_SETTING"] } as never,
      file,
    );
    expect(problems).toEqual([]);
  });

  it("reports the page itself as missing when it does not exist", () => {
    const problems = checkConfigCoverage({ envVars: ["FIREFLY_X"], retiredEnvVars: [] } as never, tempDocPath("gone.md"));
    expect(problems[0]).toContain("does not exist");
  });

  it("passes when every variable's name appears in the real configuration.md", () => {
    const text = fs.readFileSync(path.resolve("docs/configuration.md"), "utf8");
    const names = [...text.matchAll(/\bFIREFLY_[A-Z_]+\b|\bMCP_[A-Z_]+\b/g)].map((m) => m[0]);
    expect(names.length).toBeGreaterThan(0);
    expect(checkConfigCoverage({ envVars: names.slice(0, 3), retiredEnvVars: [] } as never)).toEqual([]);
  });
});

describe("checkLinks", () => {
  it("flags a relative link to a file that does not exist", () => {
    const file = writeDoc(tempDocPath("a.md"), "See [gone](./this-file-does-not-exist.md) for more.\n");
    const problems = checkLinks({ docFiles: [file] } as never);
    expect(problems).toEqual([`${file}: links to ./this-file-does-not-exist.md, which does not exist`]);
  });

  it("does not flag a link to a file that exists", () => {
    const target = writeDoc(tempDocPath("target.md"), "# Target\n");
    const file = writeDoc(tempDocPath("a.md"), `See [it](./${path.basename(target)}) for more.\n`);
    expect(checkLinks({ docFiles: [file, target] } as never)).toEqual([]);
  });

  it("flags an anchor that does not match any heading on the target page", () => {
    const target = writeDoc(tempDocPath("target.md"), "# Real Heading\n\nBody text.\n");
    const file = writeDoc(tempDocPath("a.md"), `See [it](./${path.basename(target)}#missing-heading).\n`);
    const problems = checkLinks({ docFiles: [file, target] } as never);
    expect(problems[0]).toContain('no "missing-heading" heading');
  });

  it("resolves a heading slug the same way mkdocs does: lowercase, spaces to hyphens", () => {
    const target = writeDoc(tempDocPath("target.md"), "## What The Assistant May Do\n");
    const file = writeDoc(tempDocPath("a.md"), `See [it](./${path.basename(target)}#what-the-assistant-may-do).\n`);
    expect(checkLinks({ docFiles: [file, target] } as never)).toEqual([]);
  });

  it("ignores absolute URLs and mailto links", () => {
    const file = writeDoc(tempDocPath("a.md"), "[ext](https://example.com/nope) and [mail](mailto:a@b.com)\n");
    expect(checkLinks({ docFiles: [file] } as never)).toEqual([]);
  });

  it("ignores a same-page anchor with no file component", () => {
    const file = writeDoc(tempDocPath("a.md"), "# Section\n\nSee [above](#section).\n");
    expect(checkLinks({ docFiles: [file] } as never)).toEqual([]);
  });
});

describe("checkOperationReferences", () => {
  it("flags a referenced operation the registry no longer serves", () => {
    const file = writeDoc(tempDocPath("a.md"), "Call `account.vanished` to do the thing.\n");
    const model = { docFiles: [file], operations: [{ name: "account.get" }], entities: ["account"] };
    const problems = checkOperationReferences(model as never);
    expect(problems).toEqual([`${file}: references \`account.vanished\`, which no longer exists`]);
  });

  it("does not flag an operation that exists", () => {
    const file = writeDoc(tempDocPath("a.md"), "Call `account.get` to fetch it.\n");
    const model = { docFiles: [file], operations: [{ name: "account.get" }], entities: ["account"] };
    expect(checkOperationReferences(model as never)).toEqual([]);
  });

  it("ignores a dotted identifier whose prefix is not a known entity", () => {
    const file = writeDoc(tempDocPath("a.md"), "Set `object.property` in your config.\n");
    const model = { docFiles: [file], operations: [{ name: "account.get" }], entities: ["account"] };
    expect(checkOperationReferences(model as never)).toEqual([]);
  });

  it("reports a stale reference only once even if it appears many times", () => {
    const file = writeDoc(tempDocPath("a.md"), "`account.gone` here, `account.gone` there.\n");
    const model = { docFiles: [file], operations: [{ name: "account.get" }], entities: ["account"] };
    expect(checkOperationReferences(model as never)).toHaveLength(1);
  });
});

describe("checkSharedParameterCoverage", () => {
  /** Every other check starts from the documentation and asks whether it is
   * still true, which is why nothing failed when `period` shipped as a
   * release's headline feature and appeared in no page at all. This one starts
   * from the code. */
  it("reports a shared parameter no page mentions", () => {
    const file = writeDoc("tmp-params.md", "Filtering uses `start` and `end`.\n");
    const problems = checkSharedParameterCoverage({
      docFiles: [file],
      sharedParams: ["start", "end", "period"],
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("period");
  });

  it("wants the backticked name, not the English word", () => {
    // "the period being examined" is prose about a date range and says nothing
    // about a parameter called `period`.
    const file = writeDoc("tmp-prose.md", "Totals are computed over the period being examined.\n");
    expect(checkSharedParameterCoverage({ docFiles: [file], sharedParams: ["period"] })).toHaveLength(1);
  });

  it("is satisfied by any page in the set", () => {
    const a = writeDoc("tmp-a.md", "Nothing relevant here.\n");
    const b = writeDoc("tmp-b.md", "Pass `period` instead of the pair.\n");
    expect(checkSharedParameterCoverage({ docFiles: [a, b], sharedParams: ["period"] })).toEqual([]);
  });
});

/** A 1x1 PNG, so the stamping tests need no ffmpeg and no fixture file. */
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

function writePng(relPath: string): string {
  const full = path.resolve(relPath);
  fs.writeFileSync(full, TINY_PNG);
  written.push(full);
  return relPath;
}

describe("stamping a PNG", () => {
  it("round-trips a value and replaces it rather than adding a second", () => {
    const file = path.resolve(writePng("tmp-stamp.png"));
    expect(readText(file, STAMP_KEY)).toBeUndefined();
    writeText(file, STAMP_KEY, 152);
    expect(readText(file, STAMP_KEY)).toBe("152");
    // Stamped twice, one answer — two would leave a reader choosing.
    writeText(file, STAMP_KEY, 160);
    expect(readText(file, STAMP_KEY)).toBe("160");
    const data = fs.readFileSync(file);
    let chunks = 0;
    for (let offset = 8; offset + 8 <= data.length; ) {
      const length = data.readUInt32BE(offset);
      if (data.toString("latin1", offset + 4, offset + 8) === "tEXt") chunks += 1;
      offset += 12 + length;
    }
    expect(chunks).toBe(1);
  });

  it("leaves the image itself intact", () => {
    const file = path.resolve(writePng("tmp-intact.png"));
    writeText(file, STAMP_KEY, 152);
    const data = fs.readFileSync(file);
    expect(data.subarray(0, 8)).toEqual(TINY_PNG.subarray(0, 8));
    // IEND stays last, which the format requires.
    expect(data.toString("latin1", data.length - 8, data.length - 4)).toBe("IEND");
  });
});

describe("checkGeneratedMedia", () => {
  /** The count is rendered into the social preview, the one copy of it nothing
   * can correct after the fact — GitHub caches that image, and so does every
   * platform that ever scraped it. The image carries the number it was
   * rendered from, so there is one copy rather than a file kept beside it. */
  it("reports an image rendered from a different count", () => {
    const file = path.resolve(writePng("tmp-media.png"));
    writeText(file, STAMP_KEY, 140);
    const problems = checkGeneratedMedia({ operations: new Array(152) }, file);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("140");
    expect(problems[0]).toContain("152");
  });

  it("is quiet when they agree", () => {
    const file = path.resolve(writePng("tmp-media-ok.png"));
    writeText(file, STAMP_KEY, 152);
    expect(checkGeneratedMedia({ operations: new Array(152) }, file)).toEqual([]);
  });

  it("says so when the image carries no count at all", () => {
    const file = path.resolve(writePng("tmp-media-bare.png"));
    expect(checkGeneratedMedia({ operations: [] }, file)).toHaveLength(1);
  });
});

describe("checkDemoVideo", () => {
  /** GitHub will not play a video from a repository path — its raw API serves
   * mp4 as application/octet-stream — so both READMEs embed a
   * `user-attachments` URL, which is a second upload of the same file. That
   * upload cannot be automated; noticing it did not happen can be, and this is
   * the only way to do it without a network call. */
  it("reports a video rebuilt but not re-uploaded", () => {
    const video = writeDoc("tmp-demo.mp4", "0123456789");
    const problems = checkDemoVideo(
      { demo: { url: "https://example.invalid/v", bytes: 999 } },
      video,
    );
    expect(problems.some((line) => line.includes("999"))).toBe(true);
  });

  it("reports a README that still embeds the previous upload", () => {
    const video = writeDoc("tmp-demo2.mp4", "0123456789");
    // Both READMEs are the real ones, which carry the real URL, so a record
    // naming a different one must be reported against them.
    const problems = checkDemoVideo(
      { demo: { url: "https://example.invalid/not-the-one", bytes: 10 } },
      video,
    );
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain("README");
  });

  it("says so when nothing records where the demo is published", () => {
    expect(checkDemoVideo({ demo: undefined })).toHaveLength(1);
  });
});
