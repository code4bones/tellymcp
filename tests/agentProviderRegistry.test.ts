import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  inspectAgentProviders,
  resolveAgentProvider,
  resolveExecutablePath,
} from "../src/services/features/telegram-mcp/src/features/agent-runtime/model/agentProviderRegistry";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("agent provider registry", () => {
  it("resolves provider and agent aliases", () => {
    expect(resolveAgentProvider("openai")?.agentId).toBe("codex");
    expect(resolveAgentProvider("codex")?.providerId).toBe("openai");
    expect(resolveAgentProvider("codex")?.transport).toBe("app-server");
    expect(resolveAgentProvider("claude-code")?.agentId).toBe("claude");
    expect(resolveAgentProvider("claude")?.transport).toBe("pty");
    expect(resolveAgentProvider("unknown")).toBeNull();
  });

  it("detects only executable provider binaries from PATH", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tellymcp-agent-provider-"));
    tempDirs.push(dir);
    const codexPath = path.join(dir, "codex");
    writeFileSync(codexPath, "#!/bin/sh\nexit 0\n", "utf8");
    chmodSync(codexPath, 0o755);

    expect(resolveExecutablePath("codex", { PATH: dir })).toBe(codexPath);
    expect(resolveExecutablePath("claude", { PATH: dir })).toBeNull();

    const statuses = inspectAgentProviders({ PATH: dir });
    expect(statuses.find((item) => item.agentId === "codex")).toMatchObject({
      available: true,
      executablePath: codexPath,
    });
    expect(statuses.find((item) => item.agentId === "claude")).toMatchObject({
      available: false,
    });
  });
});
