import { describe, expect, it, vi } from "vitest";

import {
  assertCodexRuntimeCompatible,
  inspectCodexRuntime,
} from "../src/services/features/telegram-mcp/src/features/agent-runtime/model/codexRuntimeDiagnostics";

describe("Codex runtime diagnostics", () => {
  it("feature-detects the app-server and remote TUI contract", () => {
    const runCommand = vi.fn((_path: string, args: string[]) => {
      if (args[0] === "--version") {
        return { status: 0, stdout: "codex-cli 0.147.0", stderr: "" };
      }
      if (args[0] === "app-server") {
        return {
          status: 0,
          stdout:
            "--listen <URL> unix:// generate-ts generate-json-schema",
          stderr: "",
        };
      }
      return { status: 0, stdout: "--remote", stderr: "" };
    });

    const result = inspectCodexRuntime("/bin/codex", runCommand);

    expect(result).toMatchObject({
      status: "ready",
      version: "0.147.0",
      capabilities: {
        appServer: true,
        unixSocketListen: true,
        remoteTui: true,
        schemaGeneration: true,
      },
    });
    expect(() => assertCodexRuntimeCompatible(result)).not.toThrow();
  });

  it("rejects an installed CLI that lacks the required structured-chat surface", () => {
    const result = inspectCodexRuntime("/bin/codex", (_path, args) =>
      args[0] === "--version"
        ? { status: 0, stdout: "codex-cli 0.90.0", stderr: "" }
        : { status: 0, stdout: "legacy help", stderr: "" },
    );

    expect(result.status).toBe("incompatible");
    expect(result.message).toContain("appServer");
    expect(() => assertCodexRuntimeCompatible(result)).toThrow(
      "incompatible with TellyMCP structured chat",
    );
  });
});
