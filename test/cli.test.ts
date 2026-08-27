import { describe, expect, it } from "vitest";
import { diagnostic, packageVersion, parseArgs, usage } from "../src/cli.js";
import { ConfigurationError } from "../src/errors.js";

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

describe("diagnostic", () => {
  it("prints only the message for a situation the operator can fix", () => {
    // A retired setting in the environment is not a crash. Printing a stack
    // trace at someone whose .env needs one line changed buries the one
    // sentence that tells them which line.
    const error = new ConfigurationError("FIREFLY_READ_ONLY is no longer supported.");
    expect(diagnostic(error)).toBe("FIREFLY_READ_ONLY is no longer supported.");
  });

  it("keeps the whole error for anything unexpected", () => {
    // A genuine crash still needs its stack: there is nothing for the operator
    // to fix, so the trace is the useful part.
    const error = new Error("socket hang up");
    expect(diagnostic(error)).toBe(error);
  });
});
