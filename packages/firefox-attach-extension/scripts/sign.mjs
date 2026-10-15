import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageRoot = path.resolve(__dirname, "..");
const sourceDir = path.join(packageRoot, "dist");
const artifactsDir = path.join(packageRoot, "web-ext-artifacts");

const apiKey = process.env.AMO_API_KEY;
const apiSecret = process.env.AMO_API_SECRET;

if (!apiKey || !apiSecret) {
  console.error(
    "Missing AMO_API_KEY / AMO_API_SECRET environment variables.\n" +
      "Get a JWT issuer/secret pair from https://addons.mozilla.org/en-US/developers/addon/api/key/ " +
      "and export them before running this script.",
  );
  process.exit(1);
}

const build = spawnSync("node", [path.join(packageRoot, "scripts", "build.mjs")], {
  stdio: "inherit",
});
if (build.status !== 0) {
  process.exit(build.status ?? 1);
}

const sign = spawnSync(
  "npx",
  [
    "--yes",
    "web-ext",
    "sign",
    "--source-dir",
    sourceDir,
    "--artifacts-dir",
    artifactsDir,
    "--channel",
    "unlisted",
    "--api-key",
    apiKey,
    "--api-secret",
    apiSecret,
  ],
  { stdio: "inherit" },
);

process.exit(sign.status ?? 1);
