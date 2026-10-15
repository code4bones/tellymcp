import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

function loadEnvFile(envPath) {
  if (!existsSync(envPath)) {
    return {};
  }
  const env = {};
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const eq = trimmed.indexOf("=");
    if (eq < 0) {
      continue;
    }
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

function run(cwd, command, args, extraEnv = {}) {
  console.log(`\n$ (${path.relative(repoRoot, cwd) || "."}) ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    env: { ...process.env, ...extraEnv },
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

const explicitVersion = process.argv[2];
const chromeDir = path.join(repoRoot, "packages", "chrome-attach-extension");
const firefoxDir = path.join(repoRoot, "packages", "firefox-attach-extension");

run(repoRoot, "node", [
  path.join(repoRoot, "scripts", "sync-extensions-version.mjs"),
  ...(explicitVersion ? [explicitVersion] : []),
]);

run(chromeDir, "npm", ["run", "pack"]);
run(chromeDir, "npm", ["run", "zip"]);

const firefoxEnv = loadEnvFile(path.join(firefoxDir, ".env"));
run(firefoxDir, "npm", ["run", "sign"], firefoxEnv);

console.log(
  "\nBoth extensions built and packaged with the same version.\n" +
    "Run `npm run publish` inside each package to push the artifacts to update-server.",
);
