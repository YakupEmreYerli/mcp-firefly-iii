// Maintainer tool, not part of the published package.
//
// The write smoke creates, changes and deletes records. It must never reach a
// ledger someone cares about, so it runs only against a loopback instance that
// the operator has explicitly flagged as disposable.

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * @param {string} apiUrl
 * @param {Record<string, string | undefined>} env
 */
export function assertDisposableInstance(apiUrl, env) {
  const host = new URL(apiUrl).hostname;
  if (!LOOPBACK.has(host)) {
    throw new Error(`Refusing to write to ${host}: the write smoke runs only against a local instance.`);
  }
  if (env.FIREFLY_WRITE_SMOKE !== "disposable") {
    throw new Error("Refusing to write: set FIREFLY_WRITE_SMOKE=disposable to confirm this instance may be changed.");
  }
}
