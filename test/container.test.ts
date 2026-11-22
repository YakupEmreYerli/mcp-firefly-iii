import { describe, expect, it } from "vitest";
import { containerCommand } from "../src/container.js";

describe("containerCommand", () => {
  it("serves HTTP with no arguments, as the image always has", () => {
    expect(containerCommand([])).toBe("http");
  });

  // Inside the image the only setup that makes sense is the remote one.
  it("runs the remote setup for setup, with or without --remote", () => {
    expect(containerCommand(["setup"])).toBe("setup");
    expect(containerCommand(["setup", "--remote"])).toBe("setup");
  });

  it("runs the doctor", () => {
    expect(containerCommand(["doctor"])).toBe("doctor");
  });

  // Before the entry point existed, `docker run IMAGE node dist/http.js` and
  // compose `command:` overrides ran as given; they must keep working.
  it("runs any other command as given, as the image did before", () => {
    expect(containerCommand(["node", "dist/http.js"])).toEqual({ exec: ["node", "dist/http.js"] });
    expect(containerCommand(["sh"])).toEqual({ exec: ["sh"] });
    expect(containerCommand(["doctor", "x"])).toEqual({ exec: ["doctor", "x"] });
  });
});
