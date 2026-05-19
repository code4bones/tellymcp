import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export const TELLYMCP_PROTOCOL_VERSION = "1.0";
export const TELLYMCP_PACKAGE_NAME = "@deadragdoll/tellymcp";
export const TELLYMCP_CAPABILITIES = [
  "collab_projects",
  "delivery_status_push",
  "live_approval",
  "live_relay",
  "send_partner_file",
  "tools_sync",
  "version_handshake",
] as const;

export type TellyMcpCapability = (typeof TELLYMCP_CAPABILITIES)[number];
export type VersionCompatibility = "ok" | "warn" | "reject";

type ParsedProtocolVersion = {
  major: number;
  minor: number;
};

export function parseProtocolVersion(value: string | null | undefined): ParsedProtocolVersion | null {
  if (!value?.trim()) {
    return null;
  }

  const match = value.trim().match(/^(\d+)\.(\d+)$/u);
  if (!match) {
    return null;
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
  };
}

function mergeCompatibility(
  current: VersionCompatibility,
  next: VersionCompatibility,
): VersionCompatibility {
  if (current === "reject" || next === "reject") {
    return "reject";
  }
  if (current === "warn" || next === "warn") {
    return "warn";
  }
  return "ok";
}

export function evaluateVersionCompatibility(input: {
  clientPackageVersion?: string;
  clientProtocolVersion?: string;
  gatewayPackageVersion: string;
  gatewayProtocolVersion: string;
}): {
  compatibility: VersionCompatibility;
  reasons: string[];
} {
  const reasons: string[] = [];
  let compatibility: VersionCompatibility = "ok";

  const clientProtocol = parseProtocolVersion(input.clientProtocolVersion);
  const gatewayProtocol = parseProtocolVersion(input.gatewayProtocolVersion);

  if (!gatewayProtocol) {
    return {
      compatibility: "reject",
      reasons: ["Gateway protocol version is invalid."],
    };
  }

  if (!clientProtocol) {
    return {
      compatibility: "reject",
      reasons: ["Client protocol version is missing or invalid."],
    };
  }

  if (clientProtocol.major !== gatewayProtocol.major) {
    return {
      compatibility: "reject",
      reasons: [
        `Protocol major mismatch: client ${input.clientProtocolVersion} vs gateway ${input.gatewayProtocolVersion}.`,
      ],
    };
  }

  if (clientProtocol.minor !== gatewayProtocol.minor) {
    compatibility = mergeCompatibility(compatibility, "warn");
    reasons.push(
      `Protocol minor mismatch: client ${input.clientProtocolVersion} vs gateway ${input.gatewayProtocolVersion}.`,
    );
  }

  if (!input.clientPackageVersion?.trim()) {
    compatibility = mergeCompatibility(compatibility, "warn");
    reasons.push("Client package version is missing.");
  } else if (input.clientPackageVersion.trim() !== input.gatewayPackageVersion.trim()) {
    compatibility = mergeCompatibility(compatibility, "warn");
    reasons.push(
      `Package version mismatch: client ${input.clientPackageVersion.trim()} vs gateway ${input.gatewayPackageVersion.trim()}.`,
    );
  }

  return { compatibility, reasons };
}

export function findPackageRoot(startDir: string): string | null {
  let currentDir = path.resolve(startDir);

  while (true) {
    const packageJsonPath = path.join(currentDir, "package.json");
    if (existsSync(packageJsonPath)) {
      try {
        const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
          name?: string;
        };
        if (parsed.name === "@deadragdoll/tellymcp") {
          return currentDir;
        }
      } catch {
        // ignore malformed package.json while walking upward
      }
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return null;
    }
    currentDir = parentDir;
  }
}

export function getTellyMcpPackageRoot(startDir: string): string | null {
  return findPackageRoot(startDir);
}

let cachedPackageVersion: string | null = null;
let latestPublishedVersionPromise: Promise<string | null> | null = null;

export function getTellyMcpPackageVersion(startDir: string): string {
  if (cachedPackageVersion) {
    return cachedPackageVersion;
  }

  const packageRoot = findPackageRoot(startDir);
  if (!packageRoot) {
    return "0.0.0-unknown";
  }

  try {
    const packageJsonPath = path.join(packageRoot, "package.json");
    const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      version?: string;
    };
    cachedPackageVersion = parsed.version?.trim() || "0.0.0-unknown";
    return cachedPackageVersion;
  } catch {
    return "0.0.0-unknown";
  }
}

type ParsedSemver = {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
};

function parseSemver(value: string): ParsedSemver | null {
  const match = value
    .trim()
    .match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/u);
  if (!match) {
    return null;
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4]?.split(".").filter(Boolean) ?? [],
  };
}

function comparePrerelease(left: string[], right: string[]): number {
  if (left.length === 0 && right.length === 0) {
    return 0;
  }
  if (left.length === 0) {
    return 1;
  }
  if (right.length === 0) {
    return -1;
  }

  const maxLength = Math.max(left.length, right.length);
  for (let index = 0; index < maxLength; index += 1) {
    const leftPart = left[index];
    const rightPart = right[index];

    if (leftPart === undefined) {
      return -1;
    }
    if (rightPart === undefined) {
      return 1;
    }

    const leftNumber = /^\d+$/u.test(leftPart) ? Number(leftPart) : null;
    const rightNumber = /^\d+$/u.test(rightPart) ? Number(rightPart) : null;

    if (leftNumber !== null && rightNumber !== null) {
      if (leftNumber !== rightNumber) {
        return leftNumber > rightNumber ? 1 : -1;
      }
      continue;
    }

    if (leftNumber !== null) {
      return -1;
    }
    if (rightNumber !== null) {
      return 1;
    }

    if (leftPart !== rightPart) {
      return leftPart > rightPart ? 1 : -1;
    }
  }

  return 0;
}

export function comparePackageVersions(
  leftVersion: string,
  rightVersion: string,
): number | null {
  const left = parseSemver(leftVersion);
  const right = parseSemver(rightVersion);
  if (!left || !right) {
    return null;
  }

  if (left.major !== right.major) {
    return left.major > right.major ? 1 : -1;
  }
  if (left.minor !== right.minor) {
    return left.minor > right.minor ? 1 : -1;
  }
  if (left.patch !== right.patch) {
    return left.patch > right.patch ? 1 : -1;
  }

  return comparePrerelease(left.prerelease, right.prerelease);
}

export async function fetchLatestPublishedPackageVersion(
  timeoutMs = 1500,
): Promise<string | null> {
  if (!latestPublishedVersionPromise) {
    latestPublishedVersionPromise = (async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(
          `https://registry.npmjs.org/${encodeURIComponent(TELLYMCP_PACKAGE_NAME)}/latest`,
          {
            method: "GET",
            headers: {
              accept: "application/json",
            },
            signal: controller.signal,
          },
        );
        if (!response.ok) {
          return null;
        }

        const parsed = (await response.json()) as { version?: unknown };
        return typeof parsed.version === "string" && parsed.version.trim()
          ? parsed.version.trim()
          : null;
      } catch {
        return null;
      } finally {
        clearTimeout(timeout);
      }
    })();
  }

  return latestPublishedVersionPromise;
}

export async function detectAvailablePackageUpdate(input: {
  currentVersion: string;
  timeoutMs?: number;
}): Promise<{ currentVersion: string; latestVersion: string } | null> {
  if (!input.currentVersion.trim() || input.currentVersion === "0.0.0-unknown") {
    return null;
  }

  const latestVersion = await fetchLatestPublishedPackageVersion(
    input.timeoutMs,
  );
  if (!latestVersion) {
    return null;
  }

  const comparison = comparePackageVersions(latestVersion, input.currentVersion);
  if (comparison === null || comparison <= 0) {
    return null;
  }

  return {
    currentVersion: input.currentVersion,
    latestVersion,
  };
}
