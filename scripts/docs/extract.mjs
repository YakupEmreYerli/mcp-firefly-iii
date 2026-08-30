// Read the source of truth and produce a normalized documentation model.
//
// This is the only file in the pipeline that touches the running registry or
// parses source text. Everything downstream (render, manifest, validate)
// works off the plain object this returns, so a caller never needs to know
// where a fact came from — the registry, config.ts, or a markdown file — to
// use it.
//
// Determinism matters here more than anywhere else in the pipeline: every
// list this module returns is sorted by a stable key, because an unordered
// Map iteration or an unsorted file walk would make the render and the
// manifest non-reproducible between two runs on the same commit.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/** Build a registry exactly the way the running server does, without a real
 * Firefly token — nothing here issues a request, only reads the shape each
 * `defineOperation` call declared. */
async function loadRegistry() {
  const { Registry } = await import("../../dist/registry.js");
  const { ENTITY_MODULES } = await import("../../dist/server.js");
  const config = {
    apiUrl: "https://docs-sync.invalid/api/v1",
    apiToken: "not-a-real-token",
    structuredOutput: false,
    resourceUrl: "",
    authorizationServers: [],
    disableSslVerify: false,
  };
  const registry = new Registry(config, {});
  for (const module of ENTITY_MODULES) registry.register(module);
  return registry;
}

/** A short, stable fingerprint of a JSON-serializable value.
 *
 * Used to detect whether an operation's schema or description changed
 * between two manifests, without the manifest itself carrying the entire
 * schema — the point is a fast, diffable signal, not a full copy.
 */
function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeysDeep(value[key])]));
  }
  return value;
}

export function fingerprint(value) {
  // `JSON.stringify(value, Object.keys(value).sort())` looks like it sorts
  // keys, but the array form of the replacer is a whitelist applied at EVERY
  // depth, not a sort of the top level — a nested `schema.type` that is not
  // itself named in that top-level key list is silently dropped from the
  // output. Two schemas that differed only in `type` fingerprinted identical,
  // which is the one thing this function exists to catch. Sorting keys
  // recursively before stringifying is the only way to get both properties:
  // stable key order, and every value actually included.
  const json = JSON.stringify(sortKeysDeep(value));
  return crypto.createHash("sha256").update(json).digest("hex").slice(0, 16);
}

/** Every operation the registry serves, with its input schema and a
 * fingerprint over {description, access, schema} — the three things that
 * define an operation's public contract. Sorted by name, which is already how
 * `listOperations` returns them, but re-sorted here so this module never
 * silently depends on that.
 */
export function extractOperations(registry) {
  return registry
    .listOperations()
    .map((info) => {
      const schema = registry.getSchema(info.entity, info.operation);
      return {
        name: info.name,
        entity: info.entity,
        operation: info.operation,
        description: info.description,
        access: info.access,
        schema,
        fingerprint: fingerprint({ description: info.description, access: info.access, schema }),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Environment variables `src/config.ts` reads, in the order first read.
 *
 * There is no static list of settings in the source — `loadConfig` reads
 * `process.env.FOO` inline, which is the natural way to write it and the
 * reason a hand-maintained settings table drifts. A regular expression over
 * the file text is a coarser tool than a real AST walk, but the source has
 * exactly one shape for this (`env.NAME`, always inside config.ts, always an
 * upper-snake-case identifier) and the pattern is what every other module in
 * this pipeline can cheaply re-check.
 */
export function extractEnvVars(configSource) {
  const seen = new Set();
  const names = [];
  const pattern = /\benv\.([A-Z][A-Z0-9_]*)\b/g;
  for (const match of configSource.matchAll(pattern)) {
    if (seen.has(match[1])) continue;
    seen.add(match[1]);
    names.push(match[1]);
  }
  return names.sort();
}

/** Which of those names the source itself says are retired — read, but only
 * to throw `ConfigurationError` if they would have restricted anything. Kept
 * separate from the active list because a retired variable is documented
 * differently: as "no longer supported", not with a default and a purpose.
 */
export function extractRetiredEnvVars(configSource) {
  const match = configSource.match(/function refuseRetiredSettings[\s\S]*?\n\}\n/u);
  if (!match) return [];
  return extractEnvVars(match[0]);
}

export function loadConfigSource() {
  return fs.readFileSync(path.resolve("src/config.ts"), "utf8");
}

/** Every TypeScript source in the project, concatenated.
 *
 * The env-var scan used to read `src/config.ts` alone, on the assumption that
 * settings all live there. `MCP_UPDATE_CHECK` does not — it is read where it
 * is used — so it was invisible to the check that exists to notice exactly
 * that. A setting is wherever someone put it; the scan should not have an
 * opinion about where that is.
 */
export function loadAllSources() {
  const parts = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.name.endsWith(".ts")) parts.push(fs.readFileSync(full, "utf8"));
    }
  };
  visit("src");
  return parts.join("\n");
}

/** The settings this project defines, as opposed to the ones the environment
 * already had.
 *
 * A rule rather than a list of exceptions: `APPDATA`, `XDG_CACHE_HOME`, `CI`
 * and `NO_UPDATE_NOTIFIER` are read here but named by the operating system or
 * by convention elsewhere, and a list of names to skip is a place to quietly
 * silence this check. Every setting this project has ever defined carries one
 * of these two prefixes, so a new one cannot slip past without being renamed
 * out of the project's own namespace first.
 */
export function isProjectSetting(name) {
  return /^(FIREFLY|MCP)_/.test(name);
}

/** Parameter groups shared across operations, read from the built schemas.
 *
 * A group is a plain object of Zod schemas — `dateRange`, `pagination`,
 * `periodOrDates` — as opposed to a bare schema like `isoDate`, which is a Zod
 * instance and not a plain object. These are the parameters that apply to many
 * operations at once and therefore need prose somewhere; a field belonging to
 * one Firefly endpoint does not.
 */
export async function listSharedParameters() {
  const common = await import("../../dist/schemas/common.js");
  const groups = Object.values(common).filter((value) => value && value.constructor === Object);
  return [...new Set(groups.flatMap((group) => Object.keys(group)))].sort();
}

/** Every markdown file under `docs/`, plus the two READMEs — the complete set
 * a stale fact could hide in. Sorted so a file walk (whose OS-level order is
 * not guaranteed) never changes the model's shape between two runs.
 */
export function listDocFiles() {
  const results = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.name.endsWith(".md")) results.push(toPosix(path.relative(".", full)));
    }
  };
  visit("docs");
  results.push("README.md", "README.tr.md");
  return results.sort();
}

/** The manifests whose descriptions are read by people who never open the
 * repository: npm renders one and the MCP Registry serves the other. They
 * carry the same operation count the docs do, from a copy nothing checked —
 * so the count in the two places most likely to be quoted elsewhere was the
 * count nothing kept honest. Not doc files: no links, no operation
 * references, only the sentence.
 */
/** The published demo: where it is hosted, and the size of the file that was
 * uploaded there.
 *
 * GitHub will not play a video from a repository path — its raw API serves
 * mp4 as application/octet-stream, so the browser downloads it — which leaves
 * `user-attachments`, and that upload is a manual step nothing can automate
 * away. What can be automated is noticing that it did not happen: rebuild the
 * video and the byte count here stops matching the file, which is exactly the
 * state the READMEs were in while they embedded a card telling people to run
 * an install this project warns against.
 */
export function demoRecord() {
  const path = "docs/assets/demo.json";
  if (!fs.existsSync(path)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

export function listManifestFiles() {
  return ["package.json", "server.json"];
}

export function toPosix(p) {
  return p.split(path.sep).join("/");
}

/** The full model: operations, config variables, and the doc files that exist
 * to describe them. Every renderer, validator and manifest builder in this
 * pipeline is a pure function of this object — none of them reach back into
 * the registry or the filesystem on their own.
 */
export async function buildModel() {
  const registry = await loadRegistry();
  const configSource = loadConfigSource();
  const retired = extractRetiredEnvVars(configSource);
  const retiredSet = new Set(retired);
  return {
    operations: extractOperations(registry),
    entities: [...new Set(registry.listOperations().map((op) => op.entity))].sort(),
    envVars: extractEnvVars(loadAllSources())
      .filter((name) => isProjectSetting(name) && !retiredSet.has(name)),
    retiredEnvVars: retired,
    docFiles: listDocFiles(),
    manifestFiles: listManifestFiles(),
    sharedParams: await listSharedParameters(),
    demo: demoRecord(),
  };
}
