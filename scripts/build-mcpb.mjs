// Builds the Claude Desktop extension bundle (.mcpb) from the compiled server.
//
// Run with: npm run mcpb   (writes firefly-mcp-<version>.mcpb in the repo root)
//
// The bundle is the npm package plus its production dependencies, so Claude
// Desktop can run it with its own Node and no `npx` on the machine. It is
// assembled in a clean staging directory from package-lock.json rather than
// from this checkout's node_modules: a developer's tree carries devDependencies
// and whatever else was installed by hand, and none of that belongs in a file
// users install.

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const stage = join(root, "build", "mcpb");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const manifest = JSON.parse(readFileSync(join(root, "mcpb", "manifest.json"), "utf8"));

// The manifest carries its own version because the format requires one. A
// copy left behind would ship a bundle that announces the previous release,
// so a mismatch stops the build instead of being quietly overwritten.
if (manifest.version !== pkg.version) {
  console.error(`mcpb/manifest.json says ${manifest.version} but package.json says ${pkg.version}.`);
  process.exit(1);
}
if (!existsSync(join(root, "dist", "index.js"))) {
  console.error("dist/index.js is missing; run npm run build first.");
  process.exit(1);
}

const run = (command, args, cwd = root) => execFileSync(command, args, { cwd, stdio: "inherit" });
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

for (const file of ["package.json", "package-lock.json", "README.md", "LICENSE"]) {
  cpSync(join(root, file), join(stage, file));
}
cpSync(join(root, "dist"), join(stage, "dist"), { recursive: true });
writeFileSync(join(stage, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

// --ignore-scripts: nothing in the runtime tree needs an install script, and
// running one here would execute dependency code during a release build.
run(npm, ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], stage);
rmSync(join(stage, "package-lock.json"));

const output = join(root, `firefly-mcp-${pkg.version}.mcpb`);
run(join(root, "node_modules", ".bin", process.platform === "win32" ? "mcpb.cmd" : "mcpb"), ["pack", stage, output]);
console.log(`Wrote ${output}`);
