import { mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageRoot = path.resolve(__dirname, "..");
const distDir = path.join(packageRoot, "dist");
const artifactsDir = path.join(packageRoot, "webstore-artifacts");

const build = spawnSync("node", [path.join(packageRoot, "scripts", "build.mjs")], {
  stdio: "inherit",
});
if (build.status !== 0) {
  process.exit(build.status ?? 1);
}

const manifest = JSON.parse(readFileSync(path.join(distDir, "manifest.json"), "utf8"));
mkdirSync(artifactsDir, { recursive: true });
const zipPath = path.join(artifactsDir, `tellymcp-chrome-attach-${manifest.version}.zip`);
rmSync(zipPath, { force: true });

const zip = spawnSync("zip", ["-r", "-X", zipPath, "."], {
  cwd: distDir,
  stdio: "inherit",
});
if (zip.status !== 0) {
  process.exit(zip.status ?? 1);
}

console.log(`Zipped: ${zipPath}`);
