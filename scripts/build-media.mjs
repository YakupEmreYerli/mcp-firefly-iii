// Maintainer tool, not part of the published package.
//
// Renders the project's title cards. They exist at two aspect ratios because
// their destinations differ: GitHub shows a repository's social preview at 2:1,
// while a Reddit or X feed wants 16:9. Both are generated here so the wording
// cannot drift between them — reproducing one by hand in an image editor is
// exactly how a stale headline survives a rename.
//
// The demo video is not built here: it comes from a screen recording far too
// large to keep in the repository, and its own intro card deliberately carries
// a different third line (it discloses that the footage shows fabricated data,
// which a static card showing no data does not need to say).
//
// Run with: npm run media            (write the cards)
//           npm run media -- --check (fail if the committed cards are stale)

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

const OUT = "docs/assets";

// One place for the wording.
const TITLE = "Firefly III MCP Server";
const TAGLINE = "152 operations behind 5 MCP tools";
const SUBLINE = "Self-hosted — your own Firefly III instance, your own token";

const INK = "0x141414";
const ACCENT = "0xD97757";
const MUTED = "0x9A9A9A";

const check = process.argv.includes("--check");
const tmp = mkdtempSync(join(tmpdir(), "firefly-media-"));

function ffmpeg(args) {
  execFileSync("ffmpeg", ["-nostdin", "-v", "error", "-y", ...args], { stdio: "inherit" });
}

// fc-match always answers, so a missing family silently becomes something else.
// Checking the filename keeps a machine without Fira Sans from producing cards
// that look nothing like the committed ones.
function requireFont(query, expected) {
  const path = execFileSync("fc-match", ["-f", "%{file}", query], { encoding: "utf8" }).trim();
  if (!path.includes(expected)) {
    throw new Error(
      `expected ${expected} for ${JSON.stringify(query)}, got ${path || "nothing"}. ` +
        "Install the font, or the generated cards will not match the committed ones.",
    );
  }
  return path;
}

const BOLD = requireFont("Fira Sans:style=Bold", "FiraSans-Bold");
const REGULAR = requireFont("Fira Sans:style=Regular", "FiraSans-Regular");

// drawtext needs escaping for `:` and `'`; a file sidesteps the whole problem.
let textFiles = 0;
function textFile(value) {
  const path = join(tmp, `text-${textFiles++}.txt`);
  writeFileSync(path, value, "utf8");
  return path;
}

function drawtext({ file, text, size, color, y }) {
  return [
    `drawtext=fontfile=${file}`,
    `textfile=${textFile(text)}`,
    `fontsize=${size}`,
    `fontcolor=${color}`,
    "x=(w-tw)/2",
    `y=${y}`,
  ].join(":");
}

/** Each size carries its own type scale and positions rather than being scaled
 * from the other: scaling a 2:1 layout up to 16:9 leaves the wording stranded
 * in the wrong half of the frame, which is a bug this script already had. */
function titleCard(path, { width, height, title, tagline, subline }) {
  ffmpeg([
    "-f", "lavfi", "-i", `color=c=${INK}:s=${width}x${height}`,
    "-frames:v", "1",
    "-vf", [
      drawtext({ file: BOLD, text: TITLE, size: title[0], color: "white", y: title[1] }),
      drawtext({ file: REGULAR, text: TAGLINE, size: tagline[0], color: ACCENT, y: tagline[1] }),
      drawtext({ file: REGULAR, text: SUBLINE, size: subline[0], color: MUTED, y: subline[1] }),
    ].join(","),
    path,
  ]);
}

const targets = [
  // GitHub Settings -> Social preview. GitHub renders this slot at 2:1.
  ["social-preview.png", (p) => titleCard(p, {
    width: 1280, height: 640,
    title: [66, 232], tagline: [35, 326], subline: [22, 392],
  })],
  // Feed image for Reddit, X and directory listings.
  ["share-card.png", (p) => titleCard(p, {
    width: 1920, height: 1080,
    title: [88, 400], tagline: [48, 530], subline: [30, 640],
  })],
];

const digest = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
let stale = 0;

for (const [name, build] of targets) {
  const committed = join(OUT, name);
  const fresh = join(tmp, name);
  build(fresh);
  const size = `${Math.round(readFileSync(fresh).length / 1024)} KB`;
  if (check) {
    const same = existsSync(committed) && digest(committed) === digest(fresh);
    console.log(`${same ? "ok   " : "STALE"} ${committed} (${size})`);
    if (!same) stale++;
  } else {
    writeFileSync(committed, readFileSync(fresh));
    console.log(`wrote ${committed} (${size})`);
  }
}

rmSync(tmp, { recursive: true, force: true });

if (check && stale > 0) {
  console.error(`\n${stale} card(s) differ from what this script produces. Run: npm run media`);
  process.exit(1);
}
