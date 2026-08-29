// The public API as a deterministic, committed snapshot — docs-manifest.json
// at the repo root — and the diff between two such snapshots.
//
// Two things read this file:
//
// 1. `npm run docs:check`, which regenerates it from the current source and
//    fails if the committed copy does not match: the manifest is itself
//    generated output, covered by the same staleness check as the prose docs.
//
// 2. An agent editing this repo, before reading source it does not need to.
//    Each entry carries a fingerprint over exactly what defines that
//    operation's contract (description, access, schema); an agent that only
//    needs to know whether `transaction.bulk_update` changed can compare one
//    string instead of reading src/entities/transactions.ts.
//
// There is no separate "previous snapshot" file. The previous manifest is
// whatever is at HEAD in git — `docs-manifest.json` is a normal tracked file,
// and `git show` is a complete, dependency-free way to read an older version
// of it. A cache would only duplicate what git already keeps for free.

import { execFileSync } from "node:child_process";

/** The manifest is sorted and re-stringified on every build, never hand
 * edited — so two builds from the same commit produce byte-identical JSON,
 * which is what makes `docs:check` able to diff it at all. */
export function buildManifest(model) {
  return {
    // Bumped only if this file's own shape changes in a way old consumers
    // could not parse; content changes (a new operation) do not need it.
    manifestVersion: 1,
    operations: model.operations.map((op) => ({
      name: op.name,
      entity: op.entity,
      operation: op.operation,
      access: op.access,
      fingerprint: op.fingerprint,
    })),
    envVars: model.envVars.slice().sort(),
    retiredEnvVars: model.retiredEnvVars.slice().sort(),
  };
}

export function serializeManifest(manifest) {
  return JSON.stringify(manifest, null, 2) + "\n";
}

/** The manifest as committed at HEAD, or null if the file is new (first run,
 * or a fork that has not generated one yet) — a missing previous version is
 * not an error, it just means every entry in the new one is "added". */
export function readCommittedManifest() {
  try {
    const raw = execFileSync("git", ["show", "HEAD:docs-manifest.json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** What changed between two manifests, split into three buckets.
 *
 * `breaking` is the one worth reading first: a removed operation, an access
 * level that widened its own restriction (read -> write -> destructive, the
 * direction that takes something a caller could do away from them), or an env
 * var that moved from active to retired. Everything else — a new operation, a
 * description edit, a schema addition — is additive or informational and
 * lands in `changed`/`added`.
 */
export function diffManifests(previous, current) {
  const result = { added: [], removed: [], changed: [], breaking: [] };
  if (previous === null) {
    result.added = current.operations.map((op) => op.name);
    return result;
  }

  const before = new Map(previous.operations.map((op) => [op.name, op]));
  const after = new Map(current.operations.map((op) => [op.name, op]));
  const ACCESS_RANK = { read: 0, write: 1, destructive: 2 };

  for (const name of after.keys()) {
    if (!before.has(name)) result.added.push(name);
  }
  for (const name of before.keys()) {
    if (!after.has(name)) {
      result.removed.push(name);
      result.breaking.push(`operation removed: ${name}`);
    }
  }
  for (const [name, prev] of before) {
    const now = after.get(name);
    if (!now || now.fingerprint === prev.fingerprint) continue;
    result.changed.push(name);
    if (ACCESS_RANK[now.access] > ACCESS_RANK[prev.access]) {
      result.breaking.push(`${name}: access widened from ${prev.access} to ${now.access}`);
    }
  }

  const prevActive = new Set(previous.envVars ?? []);
  const nowRetired = new Set(current.retiredEnvVars ?? []);
  for (const name of prevActive) {
    if (nowRetired.has(name)) result.breaking.push(`env var retired: ${name}`);
  }

  result.added.sort();
  result.removed.sort();
  result.changed.sort();
  result.breaking.sort();
  return result;
}

export function formatDiff(diff) {
  const lines = [];
  if (diff.breaking.length > 0) {
    lines.push("BREAKING:");
    for (const entry of diff.breaking) lines.push(`  - ${entry}`);
  }
  if (diff.added.length > 0) lines.push(`Added: ${diff.added.join(", ")}`);
  if (diff.removed.length > 0) lines.push(`Removed: ${diff.removed.join(", ")}`);
  if (diff.changed.length > 0) lines.push(`Changed: ${diff.changed.join(", ")}`);
  if (lines.length === 0) lines.push("No API changes since the last commit.");
  return lines.join("\n");
}
