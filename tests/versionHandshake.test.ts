import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  evaluateVersionCompatibility,
  findPackageRoot,
  getTellyMcpPackageRoot,
  getTellyMcpPackageVersion,
  parseProtocolVersion,
  TELLYMCP_PROTOCOL_VERSION,
} from "../src/services/features/telegram-mcp/src/shared/lib/version/versionHandshake";

describe("version handshake", () => {
  it("parses protocol version", () => {
    expect(parseProtocolVersion("1.0")).toEqual({ major: 1, minor: 0 });
    expect(parseProtocolVersion("bad")).toBeNull();
    expect(parseProtocolVersion("")).toBeNull();
  });

  it("rejects missing client protocol version", () => {
    const result = evaluateVersionCompatibility({
      gatewayPackageVersion: "0.1.1",
      gatewayProtocolVersion: TELLYMCP_PROTOCOL_VERSION,
    });

    expect(result.compatibility).toBe("reject");
    expect(result.reasons[0]).toContain("Client protocol version");
  });

  it("rejects major protocol mismatch", () => {
    const result = evaluateVersionCompatibility({
      clientPackageVersion: "0.1.0",
      clientProtocolVersion: "2.0",
      gatewayPackageVersion: "0.1.1",
      gatewayProtocolVersion: "1.0",
    });

    expect(result.compatibility).toBe("reject");
    expect(result.reasons[0]).toContain("major mismatch");
  });

  it("warns on package mismatch with compatible protocol", () => {
    const result = evaluateVersionCompatibility({
      clientPackageVersion: "0.1.0",
      clientProtocolVersion: "1.0",
      gatewayPackageVersion: "0.1.1",
      gatewayProtocolVersion: "1.0",
    });

    expect(result.compatibility).toBe("warn");
    expect(result.reasons.join("\n")).toContain("Package version mismatch");
  });

  it("finds the package root and version", () => {
    const root = findPackageRoot(path.resolve(__dirname, ".."));
    expect(root).toBeTruthy();
    expect(getTellyMcpPackageRoot(__dirname)).toBe(root);
    expect(getTellyMcpPackageVersion(__dirname)).toMatch(/^\d+\.\d+\.\d+/u);
  });
});
