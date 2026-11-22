// Maintainer tool, not part of the published package.
//
// Diffs the fields each write operation sends against the fields Firefly III
// actually reads, taken from Firefly's own request classes at a release tag.
// The source, not the published OpenAPI document: the document is written by
// hand and can miss a field the code accepts (#20 was found in the code).
//
// Run with: npm run audit:api [-- --ref v6.7.9] [--json]
//           npm run audit:api -- --since v6.4.20   (which release added each field)

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ENTITY_MODULES } from "../../dist/server.js";
import { collectWriteOperations } from "./ours.mjs";
import { diffFields, requestClassFor } from "./diff.mjs";
import { extractRequestFields } from "./php-fields.mjs";
import { fieldIntroductions } from "./history.mjs";
import { compareVersions } from "../../dist/version.js";

const args = process.argv.slice(2);
const ref = args.includes("--ref") ? args[args.indexOf("--ref") + 1] : "v6.7.9";
const asJson = args.includes("--json");
const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const since = args.includes("--since") ? args[args.indexOf("--since") + 1] : undefined;
const cacheRoot = join(root, "node_modules/.cache/api-audit");

async function requestClass(file, at = ref) {
  const cached = join(cacheRoot, at, file);
  try {
    return await readFile(cached, "utf8");
  } catch {
    const url = `https://raw.githubusercontent.com/firefly-iii/firefly-iii/${at}/app/Api/V1/Requests/${file}`;
    const response = await fetch(url);
    // A class that does not exist in an older release reads nothing there.
    if (response.status === 404) return "";
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    const text = await response.text();
    await mkdir(dirname(cached), { recursive: true });
    await writeFile(cached, text);
    return text;
  }
}

const operations = await collectWriteOperations(ENTITY_MODULES);

/** Release tags vX.Y.Z between `from` and `to`, oldest first. */
async function releaseTags(from, to) {
  const tags = [];
  for (let page = 1; page < 20; page++) {
    const response = await fetch(`https://api.github.com/repos/firefly-iii/firefly-iii/tags?per_page=100&page=${page}`);
    if (!response.ok) throw new Error(`GitHub tags: HTTP ${response.status}`);
    const batch = await response.json();
    if (batch.length === 0) break;
    for (const { name } of batch) if (/^v\d+\.\d+\.\d+$/.test(name)) tags.push(name);
  }
  return tags
    .filter((tag) => compareVersions(tag, from) >= 0 && compareVersions(tag, to) <= 0)
    .sort(compareVersions);
}

if (since) {
  const readsByRef = [];
  for (const at of await releaseTags(since, ref)) {
    const reads = {};
    for (const op of operations) {
      const file = op.method && op.method !== "DELETE" ? requestClassFor(op.method, op.path) : undefined;
      // Only fields we send matter: those are the ones an older release drops.
      const ours = op.bodyKeys.length > 0 ? op.bodyKeys : op.queryKeys;
      if (file) reads[op.name] = extractRequestFields(await requestClass(file, at)).read.filter((field) => ours.includes(field));
    }
    readsByRef.push({ ref: at, reads });
  }
  const found = fieldIntroductions(readsByRef);
  console.log(`Fields this server sends that Firefly III added after ${since} (up to ${ref}).\nAn older Firefly drops them silently, so each needs a version check:\n`);
  for (const { operation, field, since: at } of found) console.log(`  ${operation.padEnd(34)} ${field.padEnd(40)} since ${at}`);
  if (found.length === 0) console.log("  none");
  process.exit(0);
}

const rows = [];
const byHand = [];
for (const op of operations) {
  if (op.method === "DELETE") continue;
  const file = op.method ? requestClassFor(op.method, op.path) : undefined;
  if (!file) {
    byHand.push({ name: op.name, endpoint: `${op.method} ${op.path}`.trim(), reason: op.error ?? "no request class mapped" });
    continue;
  }
  const theirs = extractRequestFields(await requestClass(file));
  const ours = op.bodyKeys.length > 0 ? op.bodyKeys : op.queryKeys;
  rows.push({ name: op.name, endpoint: `${op.method} ${op.path}`, file, ...diffFields(ours, theirs), unvalidatedReads: theirs.read.filter((k) => !theirs.validated.includes(k)) });
}

if (asJson) {
  console.log(JSON.stringify({ ref, rows, byHand }, null, 2));
} else {
  console.log(`Firefly III ${ref}: ${rows.length} write operations compared, ${byHand.length} to check by hand\n`);
  for (const row of rows) {
    if (row.missing.length === 0 && row.ignored.length === 0) continue;
    console.log(`${row.name}  (${row.endpoint} → ${row.file})`);
    if (row.missing.length) console.log(`  missing  Firefly reads, we never send: ${row.missing.join(", ")}`);
    if (row.ignored.length) console.log(`  ignored  we send, Firefly never reads: ${row.ignored.join(", ")}`);
  }
  const clean = rows.filter((row) => row.missing.length === 0 && row.ignored.length === 0).map((row) => row.name);
  if (clean.length) console.log(`\nclean: ${clean.join(", ")}`);
  if (byHand.length) {
    console.log("\ncheck by hand:");
    for (const item of byHand) console.log(`  ${item.name}  ${item.endpoint}  — ${item.reason}`);
  }
}
