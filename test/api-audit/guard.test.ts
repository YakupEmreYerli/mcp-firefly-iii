import { describe, expect, it } from "vitest";
import { assertDisposableInstance } from "../../scripts/api-audit/guard.mjs";

const flag = { FIREFLY_WRITE_SMOKE: "disposable" };

describe("assertDisposableInstance", () => {
  it("refuses a remote instance even with the flag set", () => {
    expect(() => assertDisposableInstance("https://firefly.example/api/v1", flag)).toThrow();
  });

  it("refuses a local instance without the flag", () => {
    expect(() => assertDisposableInstance("http://127.0.0.1:4620/api/v1", {})).toThrow();
  });

  it("refuses a host that only starts with a loopback name", () => {
    expect(() => assertDisposableInstance("http://localhost.example.com/api/v1", flag)).toThrow();
  });

  it("allows a loopback instance that is flagged disposable", () => {
    expect(() => assertDisposableInstance("http://127.0.0.1:4620/api/v1", flag)).not.toThrow();
    expect(() => assertDisposableInstance("http://localhost:4620/api/v1", flag)).not.toThrow();
  });
});
