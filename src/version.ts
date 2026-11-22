import type { FireflyClient } from "./firefly.js";

/** Numeric comparison of dotted versions; a leading `v` is ignored and a
 * missing or non-numeric part counts as 0. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.replace(/^v/, "").split(".").map((p) => Number.parseInt(p, 10) || 0);
  const left = parts(a);
  const right = parts(b);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

const versions = new WeakMap<FireflyClient, Promise<string | undefined>>();

/** The connected Firefly III's version, read once per client from `/about`.
 * Undefined when it cannot be read: a version check must never be the reason
 * a call fails. */
export function fireflyVersion(client: FireflyClient): Promise<string | undefined> {
  let pending = versions.get(client);
  if (!pending) {
    pending = client.get("/about").then(
      (payload) => {
        const data = (payload as { data?: { version?: unknown } } | undefined)?.data;
        return typeof data?.version === "string" ? data.version : undefined;
      },
      () => undefined,
    );
    versions.set(client, pending);
  }
  return pending;
}
