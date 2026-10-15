import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageRoot = path.resolve(__dirname, "..");
const artifactsDir = path.join(packageRoot, "web-ext-artifacts");

const baseUrl = (process.env.UPDATE_SERVER_BASE_URL || "").replace(/\/+$/u, "");
const token = process.env.UPDATE_SERVER_PUBLISH_TOKEN;
const component = process.env.UPDATE_SERVER_COMPONENT || "tellymcp-firefox-attach";

if (!baseUrl || !token) {
  console.error(
    "Missing UPDATE_SERVER_BASE_URL / UPDATE_SERVER_PUBLISH_TOKEN environment variables.",
  );
  process.exit(1);
}

const manifest = JSON.parse(
  readFileSync(path.join(packageRoot, "src", "manifest.json"), "utf8"),
);
const version = manifest.version;

const xpiFiles = readdirSync(artifactsDir).filter((name) => name.endsWith(".xpi"));
if (xpiFiles.length === 0) {
  console.error(`No .xpi files found in ${artifactsDir}. Run "npm run sign" first.`);
  process.exit(1);
}
const latestXpi = xpiFiles.sort().at(-1);
const sourcePath = path.join(artifactsDir, latestXpi);
const filename = `tellymcp-firefox-attach-${version}.xpi`;

const url = `${baseUrl}/v1/files/${component}/${version}/${filename}`;
const body = readFileSync(sourcePath);

console.log(`Publishing ${sourcePath}`);
console.log(`  -> ${url}`);

const response = await fetch(url, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/x-xpinstall",
  },
  body,
});

const text = await response.text();
if (!response.ok) {
  console.error(`Publish failed: ${response.status} ${response.statusText}\n${text}`);
  process.exit(1);
}

console.log(`Published: ${text}`);
