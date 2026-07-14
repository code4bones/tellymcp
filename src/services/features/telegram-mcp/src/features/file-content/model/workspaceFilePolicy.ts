import path from "node:path";
import { TextDecoder } from "node:util";

import { lookup as lookupMimeType } from "mime-types";

const BLOCKED_DIRECTORY_NAMES = new Set([
  ".aws",
  ".azure",
  ".docker",
  ".git",
  ".gnupg",
  ".kube",
  ".ssh",
  ".tellymcp",
]);

const BLOCKED_FILE_NAMES = new Set([
  ".dockerconfigjson",
  ".git-credentials",
  ".netrc",
  ".npmrc",
  ".pypirc",
  ".yarnrc",
  ".yarnrc.yml",
  "_netrc",
  "credentials",
  "credentials.json",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "id_rsa",
  "secrets.json",
  "service-account-key.json",
  "service-account.json",
]);

const BLOCKED_FILE_EXTENSIONS = new Set([
  ".jks",
  ".kdbx",
  ".key",
  ".keystore",
  ".p12",
  ".pem",
  ".pfx",
]);

const SAFE_ENV_TEMPLATE_MARKERS = new Set([
  "dist",
  "example",
  "sample",
  "template",
]);

const SOURCE_MIME_TYPES = new Map<string, string>([
  [".astro", "text/plain"],
  [".cts", "text/typescript"],
  [".gql", "application/graphql"],
  [".graphql", "application/graphql"],
  [".jsx", "text/javascript"],
  [".mdx", "text/markdown"],
  [".mts", "text/typescript"],
  [".prisma", "text/plain"],
  [".svelte", "text/plain"],
  [".toml", "application/toml"],
  [".ts", "text/typescript"],
  [".tsx", "text/typescript"],
  [".vue", "text/plain"],
]);

const SOURCE_FILE_MIME_TYPES = new Map<string, string>([
  ["dockerfile", "text/plain"],
  ["makefile", "text/plain"],
]);

function isBlockedEnvFile(fileName: string): boolean {
  if (fileName === ".env") {
    return true;
  }
  if (!fileName.startsWith(".env.")) {
    return false;
  }

  const suffixSegments = fileName.slice(".env.".length).split(".");
  return !suffixSegments.some((segment) =>
    SAFE_ENV_TEMPLATE_MARKERS.has(segment),
  );
}

export function assertWorkspaceFilePathAllowed(filePath: string): void {
  const normalized = filePath.replaceAll("\\", "/").toLowerCase();
  const segments = normalized.split("/").filter(Boolean);
  const fileName = segments.at(-1) ?? "";

  if (
    segments.some((segment) => BLOCKED_DIRECTORY_NAMES.has(segment)) ||
    BLOCKED_FILE_NAMES.has(fileName) ||
    BLOCKED_FILE_EXTENSIONS.has(path.posix.extname(fileName)) ||
    isBlockedEnvFile(fileName)
  ) {
    throw new Error("Access to sensitive workspace files is blocked.");
  }
}

export function resolveWorkspaceFileMimeType(fileName: string): string {
  const normalized = fileName.toLowerCase();
  return (
    SOURCE_FILE_MIME_TYPES.get(normalized) ||
    SOURCE_MIME_TYPES.get(path.extname(normalized)) ||
    lookupMimeType(fileName) ||
    "application/octet-stream"
  );
}

export function decodeWorkspaceTextContent(content: Uint8Array): string {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    throw new Error(
      "type='text' requires valid UTF-8 content; use type='url' or type='base64' for binary files.",
    );
  }

  if (text.includes("\0")) {
    throw new Error(
      "type='text' does not accept binary content; use type='url' or type='base64'.",
    );
  }
  return text;
}
