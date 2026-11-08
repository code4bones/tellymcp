import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { getTellyMcpPackageRoot } from "../../shared/lib/version/versionHandshake";

const packageRoot = getTellyMcpPackageRoot(__dirname);
if (!packageRoot)
  throw new Error(
    "TellyMCP package root is unavailable for Telegram SDK assets.",
  );

export const TELEGRAM_SDK_JS = readFileSync(
  join(packageRoot, "vendor/telegram-web-app/telegram-web-app.js"),
  "utf8",
);
export const TELEGRAM_SDK_SHA256 = createHash("sha256")
  .update(TELEGRAM_SDK_JS)
  .digest("hex");
export const TELEGRAM_SDK_FILENAME = `telegram-web-app.${TELEGRAM_SDK_SHA256.slice(0, 16)}.js`;
