#!/usr/bin/env node
// The one entry point for this whole pipeline.
//
//   node scripts/docs/cli.mjs update   rewrites every generated page and
//                                      docs-manifest.json, and prints what
//                                      changed against the committed manifest
//   node scripts/docs/cli.mjs check    writes nothing; exits non-zero if a
//                                      page, the manifest, or a link/anchor/
//                                      reference is out of sync
//
// Both need `npm run build` first, since `extract.mjs` imports the compiled
// registry from `dist/` rather than re-running the TypeScript compiler
// itself — the built server is the one artifact this whole pipeline treats
// as ground truth. `npm run docs:update` / `docs:check` in package.json
// already do the build step.

import { buildModel } from "./extract.mjs";
import { planEdits, apply } from "./render.mjs";
import { buildManifest, serializeManifest, readCommittedManifest, diffManifests, formatDiff } from "./manifest.mjs";
import { runAll } from "./validate.mjs";
import fs from "node:fs";
import path from "node:path";

const MANIFEST_PATH = path.resolve("docs-manifest.json");

async function update() {
  const model = await buildModel();

  const edits = apply(model);
  for (const edit of edits) console.log(`updated ${edit.file}`);
  if (edits.length === 0) console.log("docs already in sync");

  const manifest = buildManifest(model);
  const serialized = serializeManifest(manifest);
  const previous = readCommittedManifest();
  const onDisk = fs.existsSync(MANIFEST_PATH) ? fs.readFileSync(MANIFEST_PATH, "utf8") : null;
  if (onDisk !== serialized) {
    fs.writeFileSync(MANIFEST_PATH, serialized);
    console.log("updated docs-manifest.json");
  }

  const diff = diffManifests(previous, manifest);
  console.log("\n" + formatDiff(diff));

  const problems = runAll(model);
  if (problems.length > 0) {
    console.log(`\n${problems.length} validation problem(s) remain — these are not auto-fixable:`);
    for (const problem of problems) console.log(`  - ${problem}`);
  }
}

async function check() {
  const model = await buildModel();
  const violations = [];

  for (const edit of planEdits(model)) violations.push(`${edit.file} is stale (run \`npm run docs:update\`)`);

  const manifest = buildManifest(model);
  const serialized = serializeManifest(manifest);
  const onDisk = fs.existsSync(MANIFEST_PATH) ? fs.readFileSync(MANIFEST_PATH, "utf8") : null;
  if (onDisk !== serialized) violations.push("docs-manifest.json is stale (run `npm run docs:update`)");

  violations.push(...runAll(model));

  const previous = readCommittedManifest();
  const diff = diffManifests(previous, manifest);
  if (diff.breaking.length > 0) {
    console.log("Breaking API changes since the last commit:");
    for (const entry of diff.breaking) console.log(`  - ${entry}`);
    console.log("This is informational — it does not fail the check on its own. Confirm the version bump matches.\n");
  }

  if (violations.length === 0) {
    console.log("docs are in sync");
    process.exit(0);
  }
  console.error("Docs are out of sync with the source:");
  for (const violation of violations) console.error(`  - ${violation}`);
  process.exit(1);
}

const command = process.argv[2];
if (command === "check") {
  await check();
} else if (command === "update") {
  await update();
} else {
  console.error(`Usage: node scripts/docs/cli.mjs <update|check>`);
  process.exit(2);
}
