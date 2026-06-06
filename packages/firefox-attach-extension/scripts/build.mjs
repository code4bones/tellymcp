import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageRoot = path.resolve(__dirname, "..");
const srcDir = path.join(packageRoot, "src");
const distDir = path.join(packageRoot, "dist");

mkdirSync(distDir, { recursive: true });

const entries = [
  "manifest.json",
  "background.js",
  "options.html",
  "options.js",
  "popup.html",
  "popup.js",
  "icon.svg",
  "recorder-content.js",
  "recorder-page.js",
];

for (const entry of entries) {
  rmSync(path.join(distDir, entry), { recursive: true, force: true });
}

for (const entry of entries) {
  const sourcePath = path.join(srcDir, entry);
  if (existsSync(sourcePath)) {
    cpSync(sourcePath, path.join(distDir, entry));
  }
}

console.log(`Built Firefox attach extension into ${distDir}`);
