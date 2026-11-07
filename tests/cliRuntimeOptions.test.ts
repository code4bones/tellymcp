import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { browserWsOverrides, defaultClientEnvPath, resolveRuntimeEnvPath } from "../src/cliRuntimeOptions";

describe("CLI client configuration discovery", () => {
  let root: string;
  let cwd: string;
  let homeDir: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "telly-cli-options-"));
    cwd = path.join(root, "workspace");
    homeDir = path.join(root, "home");
    mkdirSync(cwd); mkdirSync(homeDir);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("uses the shared home profile in a fresh workspace", () => {
    expect(resolveRuntimeEnvPath([], { cwd, homeDir })).toBe(path.join(homeDir, ".tellymcp", ".env"));
  });

  it("keeps explicit --env precedence in any argument order", () => {
    for (const args of [
      ["--env", "custom.env", "--ws", "9999"],
      ["--ws", "9999", "-s", "New", "--env", "custom.env"],
      ["--ws=9999", "--env=custom.env"],
    ]) {
      expect(resolveRuntimeEnvPath(args, { cwd, homeDir, markerEnvFile: "saved.env" })).toBe(path.join(cwd, "custom.env"));
    }
  });

  it("keeps a workspace's saved custom profile and missing-file errors", () => {
    const saved = path.join(cwd, "saved.env");
    expect(resolveRuntimeEnvPath([], { cwd, homeDir, markerEnvFile: "saved.env" })).toBe(saved);
    writeFileSync(saved, "DISTRIBUTED_MODE=client\n");
    expect(resolveRuntimeEnvPath([], { cwd, homeDir, markerEnvFile: "saved.env" })).toBe(saved);
  });

  it("prefers a local workspace .env over the home default", () => {
    writeFileSync(path.join(cwd, ".env"), "DISTRIBUTED_MODE=client\n");
    expect(resolveRuntimeEnvPath([], { cwd, homeDir })).toBe(path.join(cwd, ".env"));
  });

  it("moves old shared-profile markers to the new home location", () => {
    const global = defaultClientEnvPath(homeDir);
    mkdirSync(path.dirname(global)); writeFileSync(global, "DISTRIBUTED_MODE=client\n");
    expect(resolveRuntimeEnvPath([], { cwd, homeDir, markerEnvFile: path.join(homeDir, ".env-client") })).toBe(global);
  });

  it.each([["--env"], ["--env="], ["--env", "--ws", "9999"], ["--env=a", "--env=b"]])("rejects ambiguous or missing env arguments %j", (...args) => {
    expect(() => resolveRuntimeEnvPath(args, { cwd, homeDir })).toThrow();
  });
});

describe("per-launch browser extension port", () => {
  it("preserves the env settings when --ws is omitted", () => {
    const env = { BROWSER_ATTACH_ENABLED: "false", BROWSER_ATTACH_WS_PORT: "7777" };
    expect({ ...env, ...browserWsOverrides(["-s", "New"]) }).toEqual(env);
  });

  it("enables the listener and overrides the env port for this launch", () => {
    const env = { BROWSER_ATTACH_ENABLED: "false", BROWSER_ATTACH_WS_PORT: "7777" };
    for (const args of [["--ws", "9999"], ["--env", "custom.env", "--ws=9999", "-s", "New"]]) {
      expect({ ...env, ...browserWsOverrides(args) }).toEqual({ BROWSER_ATTACH_ENABLED: "true", BROWSER_ATTACH_WS_PORT: "9999" });
      expect(env.BROWSER_ATTACH_WS_PORT).toBe("7777");
    }
  });

  it.each(["0", "65536", "-1", "1.5", "1e3", "abc", ""])('rejects invalid port "%s"', (value) => {
    expect(() => browserWsOverrides([`--ws=${value}`])).toThrow();
  });

  it("rejects a missing or duplicate --ws value", () => {
    expect(() => browserWsOverrides(["--ws"])).toThrow();
    expect(() => browserWsOverrides(["--ws", "-s", "New"])).toThrow();
    expect(() => browserWsOverrides(["--ws", "9999", "--ws=8888"])).toThrow();
  });
});
