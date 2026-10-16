import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageRoot = path.resolve(__dirname, "..");
const srcDir = path.join(packageRoot, "src");
const distDir = path.join(packageRoot, "dist");

// Wipe the whole dist dir rather than just the known entries below, so stray
// files (e.g. web-ext's own .amo-upload-uuid cache, written here by `npm run
// sign`) never linger and get swept into a packaged zip/xpi.
rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

const entries = [
  "manifest.json",
  "background.js",
  "options.html",
  "options.js",
  "popup.html",
  "popup.js",
  "icon.svg",
  "icon-16.png",
  "icon-32.png",
  "icon-48.png",
  "icon-128.png",
  "recorder-content.js",
  "recorder-page.js",
];

for (const entry of entries) {
  const sourcePath = path.join(srcDir, entry);
  if (existsSync(sourcePath)) {
    cpSync(sourcePath, path.join(distDir, entry));
  }
}

console.log(`Built Firefox attach extension into ${distDir}`);
