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

  it("refuses anything else instead of starting a server", () => {
    expect(containerCommand(["serve"])).toEqual({ unknown: "serve" });
    expect(containerCommand(["doctor", "x"])).toEqual({ unknown: "doctor x" });
  });
});
