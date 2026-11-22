// Maintainer tool, not part of the published package.
//
// Diffs the fields each write operation sends against the fields Firefly III
// actually reads, taken from Firefly's own request classes at a release tag.
// The source, not the published OpenAPI document: the document is written by
// hand and can miss a field the code accepts (#20 was found in the code).
//
// Run with: npm run audit:api [-- --ref v6.7.9] [--json]

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ENTITY_MODULES } from "../../dist/server.js";
import { collectWriteOperations } from "./ours.mjs";
import { diffFields, requestClassFor } from "./diff.mjs";
import { extractRequestFields } from "./php-fields.mjs";

const args = process.argv.slice(2);
const ref = args.includes("--ref") ? args[args.indexOf("--ref") + 1] : "v6.7.9";
const asJson = args.includes("--json");
const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const cacheDir = join(root, "node_modules/.cache/api-audit", ref);

async function requestClass(file) {
  const cached = join(cacheDir, file);
  try {
    return await readFile(cached, "utf8");
  } catch {
    const url = `https://raw.githubusercontent.com/firefly-iii/firefly-iii/${ref}/app/Api/V1/Requests/${file}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    const text = await response.text();
    await mkdir(dirname(cached), { recursive: true });
    await writeFile(cached, text);
    return text;
  }
}

const rows = [];
const byHand = [];
for (const op of await collectWriteOperations(ENTITY_MODULES)) {
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
