import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export const TELLYMCP_PROTOCOL_VERSION = "1.0";
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
