import { describe, expect, it, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { checkConfigCoverage, checkLinks, checkOperationReferences } from "../../scripts/docs/validate.mjs";

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
    expect(problems).toEqual([`${file}: does not mention FIREFLY_TOTALLY_UNDOCUMENTED, which src/config.ts reads`]);
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
