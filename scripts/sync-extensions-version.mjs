import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

const targets = [
  {
    packageJson: path.join(repoRoot, "packages/chrome-attach-extension/package.json"),
    manifestJson: path.join(repoRoot, "packages/chrome-attach-extension/src/manifest.json"),
  },
  {
    packageJson: path.join(repoRoot, "packages/firefox-attach-extension/package.json"),
    manifestJson: path.join(repoRoot, "packages/firefox-attach-extension/src/manifest.json"),
  },
];

function readVersion(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8")).version;
}

function writeVersion(filePath, version) {
  const json = JSON.parse(readFileSync(filePath, "utf8"));
  if (json.version === version) {
    return false;
  }
  json.version = version;
  writeFileSync(filePath, `${JSON.stringify(json, null, 2)}\n`, "utf8");
  return true;
}

const explicitVersion = process.argv[2];
const version = explicitVersion || readVersion(targets[0].packageJson);

let changed = false;
for (const target of targets) {
  changed = writeVersion(target.packageJson, version) || changed;
  changed = writeVersion(target.manifestJson, version) || changed;
}

console.log(
  `Browser-attach extensions version: ${version}${changed ? " (synced)" : " (already in sync)"}`,
);
