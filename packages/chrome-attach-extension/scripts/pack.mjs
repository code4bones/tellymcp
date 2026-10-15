import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageRoot = path.resolve(__dirname, "..");
const distDir = path.join(packageRoot, "dist");
const keyPath = path.join(packageRoot, "key.pem");
const artifactsDir = path.join(packageRoot, "crx-artifacts");
const generatedCrxPath = path.join(packageRoot, "dist.crx");
const generatedPemPath = path.join(packageRoot, "dist.pem");

const chromeBinary = process.env.CHROME_BINARY || "chromium-gost";

const build = spawnSync("node", [path.join(packageRoot, "scripts", "build.mjs")], {
  stdio: "inherit",
});
if (build.status !== 0) {
  process.exit(build.status ?? 1);
}

const hadKey = existsSync(keyPath);
const packArgs = [
  "--headless",
  "--no-sandbox",
  `--pack-extension=${distDir}`,
  ...(hadKey ? [`--pack-extension-key=${keyPath}`] : []),
];

const pack = spawnSync(chromeBinary, packArgs, { stdio: "inherit" });
if (pack.status !== 0) {
  process.exit(pack.status ?? 1);
}

if (!hadKey) {
  if (!existsSync(generatedPemPath)) {
    console.error(`Expected ${chromeBinary} to generate ${generatedPemPath}, but it did not.`);
    process.exit(1);
  }
  renameSync(generatedPemPath, keyPath);
  console.log(`Generated a new persistent signing key: ${keyPath}`);
  console.log("Keep this file private and out of git — it fixes the extension's id across rebuilds.");
}

if (!existsSync(generatedCrxPath)) {
  console.error(`Expected ${chromeBinary} to produce ${generatedCrxPath}, but it did not.`);
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(path.join(distDir, "manifest.json"), "utf8"));
mkdirSync(artifactsDir, { recursive: true });
const finalCrxPath = path.join(artifactsDir, `tellymcp-chrome-attach-${manifest.version}.crx`);
rmSync(finalCrxPath, { force: true });
renameSync(generatedCrxPath, finalCrxPath);

console.log(`Packed: ${finalCrxPath}`);
