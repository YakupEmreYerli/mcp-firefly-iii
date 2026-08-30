// Checks that do not rewrite anything, only report what is wrong. Each
// function takes the model plus whatever file text it needs and returns a
// list of plain-string problems; `cli.mjs` is the only place that decides
// what to do with them (print and exit non-zero).
//
// These catch a different class of drift than `render.mjs`: render keeps a
// known table and a known sentence in sync with the source, but a page can
// still point at a heading that moved, a file that was renamed, or an
// operation that no longer exists — none of which look like "the table is
// stale", so they need their own checks.

import fs from "node:fs";
import path from "node:path";

const LINK_PATTERN = /\[[^\]]*\]\(([^)]+)\)/g;
const HEADING_PATTERN = /^#{1,6}\s+(.+)$/gmu;
const OPERATION_REF_PATTERN = /`([a-z][a-z0-9_]*)\.([a-z][a-z0-9_]*)`/gu;

function slugify(heading) {
  // GitHub/mkdocs slug rules: lowercase, strip anything that is not a word
  // character/space/hyphen, spaces become hyphens. Good enough for this
  // repo's headings, which are plain ASCII prose with the odd backtick.
  return heading
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

function headingsIn(text) {
  const slugs = new Set();
  for (const match of text.matchAll(HEADING_PATTERN)) slugs.add(slugify(match[1]));
  return slugs;
}

/** Every setting this project has ever had — active or retired — is named
 * literally in configuration.md. A variable removed from that page without
 * being marked retired there is exactly the drift this whole system exists to
 * catch: the source says it still exists, the docs no longer mention it.
 *
 * The scan behind `model.envVars` reads every source file, not `config.ts`
 * alone. `MCP_UPDATE_CHECK` is read where it is used rather than in the
 * config module, and was therefore invisible to the check whose whole job was
 * to notice an undocumented setting.
 */
export function checkConfigCoverage(model, file = "docs/configuration.md") {
  const problems = [];
  const p = path.resolve(file);
  if (!fs.existsSync(p)) {
    problems.push(`${file}: does not exist, but src/config.ts defines environment variables`);
    return problems;
  }
  const text = fs.readFileSync(p, "utf8");
  for (const name of [...model.envVars, ...model.retiredEnvVars]) {
    if (!text.includes(name)) problems.push(`${file}: does not mention ${name}, which the source reads`);
  }
  return problems;
}

/** Every relative link across the doc set resolves to a file that exists, and
 * every `#anchor` on it resolves to a heading that file actually has.
 * Skips absolute URLs, mailto:, and bare anchors that mkdocs resolves at
 * build time in ways this checker cannot see (tag/glossary macros); the
 * plain-file case is the one that silently rots when a page is renamed.
 */
export function checkLinks(model) {
  const problems = [];
  for (const file of model.docFiles) {
    const p = path.resolve(file);
    if (!fs.existsSync(p)) continue;
    const text = fs.readFileSync(p, "utf8");
    for (const match of text.matchAll(LINK_PATTERN)) {
      const target = match[1].trim();
      if (target === "" || /^([a-z][a-z0-9+.-]*:)/iu.test(target)) continue; // scheme: http:, mailto:, etc.
      const [targetPath, anchor] = target.split("#");
      let resolvedText = text;
      if (targetPath !== "") {
        const resolved = path.resolve(path.dirname(p), targetPath);
        if (!fs.existsSync(resolved)) {
          problems.push(`${file}: links to ${target}, which does not exist`);
          continue;
        }
        if (anchor === undefined) continue;
        if (!resolved.endsWith(".md")) continue; // linked asset, not a page with headings
        resolvedText = fs.readFileSync(resolved, "utf8");
      }
      if (anchor !== undefined && anchor !== "" && !headingsIn(resolvedText).has(anchor)) {
        problems.push(`${file}: links to ${target}, but ${targetPath || "this page"} has no "${anchor}" heading`);
      }
    }
  }
  return problems;
}

/** A backtick-quoted `entity.operation` name — the shape this project's own
 * docs use throughout — that does not match anything the registry serves.
 * Narrowed to names starting with a known entity, so an unrelated
 * `dotted.identifier` in a code sample is not flagged as a stale operation
 * reference.
 */
export function checkOperationReferences(model) {
  const problems = [];
  const known = new Set(model.operations.map((op) => op.name));
  const entities = new Set(model.entities);
  for (const file of model.docFiles) {
    const p = path.resolve(file);
    if (!fs.existsSync(p)) continue;
    const text = fs.readFileSync(p, "utf8");
    const reported = new Set();
    for (const match of text.matchAll(OPERATION_REF_PATTERN)) {
      const name = `${match[1]}.${match[2]}`;
      if (!entities.has(match[1]) || known.has(name) || reported.has(name)) continue;
      reported.add(name);
      problems.push(`${file}: references \`${name}\`, which no longer exists`);
    }
  }
  return problems;
}

/** A parameter shared across many operations is named somewhere in the docs.
 *
 * The pipeline was built to keep written facts true, and it did that well —
 * but nothing failed when a fact was written nowhere at all. `period` shipped
 * as the headline feature of a release and appeared in no page under `docs/`,
 * because every check here started from the documentation and asked whether
 * it was still correct. This one starts from the code.
 *
 * Only the shared groups: a field belonging to a single Firefly endpoint is
 * described by its own schema, and demanding prose for each would produce
 * hundreds of findings nobody would read — which is how a check stops being
 * read at all.
 */
export function checkSharedParameterCoverage(model) {
  const problems = [];
  const texts = model.docFiles
    .map((file) => path.resolve(file))
    .filter((p) => fs.existsSync(p))
    .map((p) => fs.readFileSync(p, "utf8"));
  for (const name of model.sharedParams ?? []) {
    // Backticked, the way this project writes a parameter everywhere: bare
    // `start` and `end` are ordinary English and would match any prose.
    if (!texts.some((text) => text.includes(`\`${name}\``))) {
      problems.push(`no page documents \`${name}\`, a parameter shared across operations`);
    }
  }
  return problems;
}

export function runAll(model) {
  return [
    ...checkConfigCoverage(model),
    ...checkLinks(model),
    ...checkOperationReferences(model),
    ...checkSharedParameterCoverage(model),
  ];
}
