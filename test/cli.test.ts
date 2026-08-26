import { describe, expect, it } from "vitest";
import { packageVersion, parseArgs, usage } from "../src/cli.js";

describe("parseArgs", () => {
  it("serves when given no arguments, because that is how a client starts it", () => {
    expect(parseArgs([])).toEqual({ kind: "serve" });
  });

  it("runs setup", () => {
    expect(parseArgs(["setup"])).toEqual({ kind: "setup" });
  });

  it("refuses an unknown command instead of silently serving", () => {
    // An older version ignored the argument and sat there as a server waiting
    // on stdin, which to the person who typed it looks exactly like a hang.
    expect(parseArgs(["setu"])).toEqual({
      kind: "help",
      toStderr: true,
      unknown: "setu",
    });
  });

  it("refuses extra arguments rather than acting on the first", () => {
    expect(parseArgs(["setup", "--now"])).toEqual({
      kind: "help",
      toStderr: true,
      unknown: "setup --now",
    });
  });

  it("answers the help flags", () => {
    for (const flag of ["--help", "-h", "help"]) {
      expect(parseArgs([flag])).toEqual({ kind: "help", toStderr: false });
    }
  });

  it("answers the version flags", () => {
    for (const flag of ["--version", "-v"]) {
      expect(parseArgs([flag])).toEqual({ kind: "version" });
    }
  });
});

describe("usage", () => {
  it("names both binaries and the required environment", () => {
    const text = usage();

    expect(text).toContain("firefly-mcp setup");
    expect(text).toContain("firefly-mcp-http");
    expect(text).toContain("FIREFLY_API_TOKEN");
  });
});

describe("packageVersion", () => {
  it("reads the real version rather than a hardcoded one", () => {
    expect(packageVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
