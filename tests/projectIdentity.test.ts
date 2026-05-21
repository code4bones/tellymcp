import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ProjectIdentityResolver } from "../src/services/features/telegram-mcp/src/shared/lib/project-identity/projectIdentity";

const tempDirs: string[] = [];

function makeResolver(): ProjectIdentityResolver {
  return makeResolverWithProject({});
}

function makeResolverWithProject(project: {
  name?: string;
  sessionId?: string;
  sessionLabel?: string;
}): ProjectIdentityResolver {
  return new ProjectIdentityResolver(
    {
      project,
    } as never,
    {
      info: () => undefined,
      warn: () => undefined,
    } as never,
  );
}

describe(".mcpsession session identity", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates a marker and reuses the same session id across tmux changes", () => {
    const cwd = mkdtempSync(join(tmpdir(), "telegram-mcp-session-"));
    tempDirs.push(cwd);
    const resolver = makeResolver();

    const first = resolver.resolveSessionDefaults({ cwd });
    const second = resolver.resolveSessionDefaults({
      cwd,
      tmux_session_name: "backend",
      tmux_window_name: "editor",
      tmux_pane_id: "%7",
    });

    expect(first.sessionId).toBe(second.sessionId);
    expect(first.sessionLabel).toBe(second.sessionLabel);
    expect(readFileSync(join(cwd, ".mcpsession.json"), "utf8")).toContain(
      first.sessionId,
    );
  });

  it("persists explicit session marker updates", () => {
    const cwd = mkdtempSync(join(tmpdir(), "telegram-mcp-session-"));
    tempDirs.push(cwd);
    const resolver = makeResolver();

    resolver.resolveSessionDefaults({ cwd });
    resolver.persistSessionMarker({
      cwd,
      sessionId: "stable-session-id",
      sessionLabel: "leftDev",
    });

    const resolved = resolver.resolveSessionDefaults({ cwd });
    expect(resolved.sessionId).toBe("stable-session-id");
    expect(resolved.sessionLabel).toBe("leftDev");
  });

  it("uses explicit runtime session override without touching the shared marker", () => {
    const cwd = mkdtempSync(join(tmpdir(), "telegram-mcp-session-"));
    tempDirs.push(cwd);

    const seededResolver = makeResolver();
    seededResolver.persistSessionMarker({
      cwd,
      sessionId: "seeded-session-id",
      sessionLabel: "seededLabel",
    });

    const overriddenResolver = makeResolverWithProject({
      name: "",
      sessionId: "backendDev",
      sessionLabel: "backendDev",
    });

    const resolved = overriddenResolver.resolveSessionDefaults({ cwd });
    expect(resolved.sessionId).toBe("backendDev");
    expect(resolved.sessionLabel).toBe("backendDev");
    expect(readFileSync(join(cwd, ".mcpsession.json"), "utf8")).toContain(
      "seeded-session-id",
    );
  });
});
