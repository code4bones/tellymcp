import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import type { AppConfig } from "../../../app/config/env";
import type { Logger } from "../logger/logger";

type PackageJsonShape = {
  name?: unknown;
};

export type ProjectIdentity = {
  cwd: string;
  cwdName: string;
  gitRoot?: string | undefined;
  gitRootName?: string | undefined;
  packageJsonPath?: string | undefined;
  packageName?: string | undefined;
  configuredProjectName?: string | undefined;
  resolvedTitle: string;
  resolvedSessionId: string;
  titleSource: "env" | "package.json" | "git" | "cwd" | "generated";
};

export type SessionDefaultsInput = {
  session_id?: string | undefined;
  session_label?: string | undefined;
  cwd?: string | undefined;
};

export type ResolvedSessionDefaults = {
  sessionId: string;
  sessionLabel: string;
  cwd: string;
  sessionIdDerived: boolean;
  sessionLabelDerived: boolean;
};

export function resolveSessionDefaultsForCwd(input: SessionDefaultsInput & {
  fallbackCwd?: string | undefined;
  logger?: Logger;
}): ResolvedSessionDefaults {
  const inputCwd = resolveInputCwd(input.cwd);
  const resolvedCwd = inputCwd || resolveInputCwd(input.fallbackCwd) || process.cwd();
  const titleBase = basename(resolvedCwd) || "Project";
  const explicitSessionId = input.session_id?.trim();
  const explicitSessionLabel = input.session_label?.trim();
  const sessionMarker =
    explicitSessionId || explicitSessionLabel
      ? null
      : readSessionMarkerState(resolvedCwd, input.logger);
  const derivedSessionId =
    sessionMarker?.localSessionId ||
    `${slugify(titleBase) || "session"}-${shortHash(resolvedCwd)}`;
  const derivedSessionLabel = sessionMarker?.sessionLabel || titleBase;

  if (!sessionMarker && !explicitSessionId && !explicitSessionLabel) {
    writeSessionMarkerState({
      cwd: resolvedCwd,
      localSessionId: explicitSessionId || derivedSessionId,
      sessionLabel: explicitSessionLabel || derivedSessionLabel,
      ...(input.logger ? { logger: input.logger } : {}),
    });
  }

  return {
    sessionId: explicitSessionId || derivedSessionId,
    sessionLabel: explicitSessionLabel || derivedSessionLabel,
    cwd: resolvedCwd,
    sessionIdDerived: !explicitSessionId,
    sessionLabelDerived: !explicitSessionLabel,
  };
}

type SessionMarkerShape = {
  version?: unknown;
  local_session_id?: unknown;
  session_label?: unknown;
  cwd?: unknown;
  env_file?: unknown;
  last_seen_tools_hash?: unknown;
  last_notified_tools_hash?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
  first_seen_local_session_id?: unknown;
};

const SESSION_MARKER_FILE_NAME = ".mcpsession.json";

function slugify(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

function shortHash(input: string): string {
  return createHash("sha1").update(input).digest("hex").slice(0, 8);
}

function findUpward(startDir: string, target: string): string | undefined {
  let current = resolve(startDir);

  while (true) {
    const candidate = join(current, target);
    if (existsSync(candidate)) {
      return candidate;
    }

    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }

    current = parent;
  }
}

function readPackageName(
  packageJsonPath: string | undefined,
): string | undefined {
  if (!packageJsonPath) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(
      readFileSync(packageJsonPath, "utf8"),
    ) as PackageJsonShape;
    return typeof parsed.name === "string" && parsed.name.trim()
      ? parsed.name.trim()
      : undefined;
  } catch {
    return undefined;
  }
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function resolveInputCwd(value: string | undefined): string | undefined {
  const trimmed = normalizeOptionalString(value);
  return trimmed ? resolve(trimmed) : undefined;
}

export type SessionMarkerState = {
  localSessionId: string;
  sessionLabel?: string | undefined;
  cwd?: string | undefined;
  envFile?: string | undefined;
  lastSeenToolsHash?: string | undefined;
  lastNotifiedToolsHash?: string | undefined;
  updatedAt?: string | undefined;
};

export function readSessionMarkerState(
  inputCwd: string,
  logger?: Logger,
): SessionMarkerState | null {
  const resolvedCwd = resolve(inputCwd);
  const markerPath = join(resolvedCwd, SESSION_MARKER_FILE_NAME);
  if (!existsSync(markerPath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(
      readFileSync(markerPath, "utf8"),
    ) as SessionMarkerShape;
    const localSessionId =
      typeof parsed.local_session_id === "string"
        ? parsed.local_session_id.trim()
        : "";
    if (!localSessionId) {
      return null;
    }

    return {
      localSessionId,
      ...(typeof parsed.session_label === "string" &&
      parsed.session_label.trim()
        ? { sessionLabel: parsed.session_label.trim() }
        : {}),
      ...(typeof parsed.cwd === "string" && parsed.cwd.trim()
        ? { cwd: parsed.cwd.trim() }
        : {}),
      ...(typeof parsed.env_file === "string" && parsed.env_file.trim()
        ? { envFile: parsed.env_file.trim() }
        : {}),
      ...(typeof parsed.last_seen_tools_hash === "string" &&
      parsed.last_seen_tools_hash.trim()
        ? { lastSeenToolsHash: parsed.last_seen_tools_hash.trim() }
        : {}),
      ...(typeof parsed.last_notified_tools_hash === "string" &&
      parsed.last_notified_tools_hash.trim()
        ? { lastNotifiedToolsHash: parsed.last_notified_tools_hash.trim() }
        : {}),
      ...(typeof parsed.updated_at === "string" && parsed.updated_at.trim()
        ? { updatedAt: parsed.updated_at.trim() }
        : {}),
    };
  } catch (error) {
    logger?.warn("Failed to read .mcpsession.json, ignoring marker", {
      cwd: resolvedCwd,
      markerPath,
      error: error instanceof Error ? (error.stack ?? error.message) : String(error),
    });
    return null;
  }
}

export function writeSessionMarkerState(input: {
  cwd: string;
  localSessionId: string;
  sessionLabel?: string | undefined;
  envFile?: string | undefined;
  lastSeenToolsHash?: string | undefined;
  lastNotifiedToolsHash?: string | undefined;
  logger?: Logger;
}): void {
  const resolvedCwd = resolve(input.cwd);
  if (!existsSync(resolvedCwd)) {
    input.logger?.debug("Skipping .mcpsession.json write because cwd does not exist locally", {
      cwd: resolvedCwd,
      sessionId: input.localSessionId,
    });
    return;
  }

  const markerPath = join(resolvedCwd, SESSION_MARKER_FILE_NAME);
  const legacyTellyStatePath = join(resolvedCwd, ".tellysession.json");
  const now = new Date().toISOString();
  const current = readSessionMarkerState(resolvedCwd, input.logger);

  try {
    writeFileSync(
      markerPath,
      `${JSON.stringify(
        {
          version: 1,
          local_session_id: input.localSessionId,
          ...(input.sessionLabel ? { session_label: input.sessionLabel } : {}),
          cwd: resolvedCwd,
          ...(typeof input.envFile === "string" && input.envFile.trim()
            ? { env_file: input.envFile.trim() }
            : current?.envFile
              ? { env_file: current.envFile }
              : {}),
          ...(typeof input.lastSeenToolsHash === "string" && input.lastSeenToolsHash.trim()
            ? { last_seen_tools_hash: input.lastSeenToolsHash.trim() }
            : current?.lastSeenToolsHash
              ? { last_seen_tools_hash: current.lastSeenToolsHash }
              : {}),
          ...(typeof input.lastNotifiedToolsHash === "string" &&
          input.lastNotifiedToolsHash.trim()
            ? { last_notified_tools_hash: input.lastNotifiedToolsHash.trim() }
            : current?.lastNotifiedToolsHash
              ? { last_notified_tools_hash: current.lastNotifiedToolsHash }
              : {}),
          created_at: now,
          updated_at: now,
          ...(current ? { first_seen_local_session_id: current.localSessionId } : {}),
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    if (existsSync(legacyTellyStatePath)) {
      rmSync(legacyTellyStatePath, { force: true });
    }
  } catch (error) {
    input.logger?.warn("Failed to write .mcpsession.json", {
      cwd: resolvedCwd,
      markerPath,
      sessionId: input.localSessionId,
      error: error instanceof Error ? (error.stack ?? error.message) : String(error),
    });
  }
}

export class ProjectIdentityResolver {
  private readonly identity: ProjectIdentity;

  public constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {
    this.identity = this.buildIdentity();
    this.logger.info("Project identity resolved", {
      cwd: this.identity.cwd,
      cwdName: this.identity.cwdName,
      gitRoot: this.identity.gitRoot,
      gitRootName: this.identity.gitRootName,
      packageName: this.identity.packageName,
      configuredProjectName: this.identity.configuredProjectName,
      resolvedTitle: this.identity.resolvedTitle,
      resolvedSessionId: this.identity.resolvedSessionId,
      titleSource: this.identity.titleSource,
    });
  }

  public getIdentity(): ProjectIdentity {
    return this.identity;
  }

  public resolveSessionDefaults(
    input: SessionDefaultsInput,
  ): ResolvedSessionDefaults {
    return resolveSessionDefaultsForCwd({
      ...input,
      session_id: input.session_id?.trim() || this.config.project.sessionId?.trim(),
      session_label:
        input.session_label?.trim() || this.config.project.sessionLabel?.trim(),
      fallbackCwd: this.identity.cwd,
      logger: this.logger,
    });
  }

  public persistSessionMarker(input: {
    cwd?: string | undefined;
    sessionId: string;
    sessionLabel?: string | undefined;
    envFile?: string | undefined;
  }): void {
    const resolvedCwd = resolveInputCwd(input.cwd) || this.identity.cwd;
    const current = this.readSessionMarker(resolvedCwd);
    this.writeSessionMarker(resolvedCwd, {
      localSessionId: input.sessionId,
      sessionLabel: input.sessionLabel || current?.sessionLabel,
      cwd: resolvedCwd,
      envFile: input.envFile || current?.envFile,
    });
  }

  public removeSessionMarker(cwd?: string | undefined): void {
    const resolvedCwd = resolveInputCwd(cwd) || this.identity.cwd;
    const markerPath = join(resolvedCwd, SESSION_MARKER_FILE_NAME);
    if (!existsSync(markerPath)) {
      return;
    }

    try {
      rmSync(markerPath, { force: true });
    } catch (error) {
      this.logger.warn("Failed to remove .mcpsession.json", {
        cwd: resolvedCwd,
        markerPath,
        error: error instanceof Error ? (error.stack ?? error.message) : String(error),
      });
    }
  }

  private buildIdentity(): ProjectIdentity {
    const cwd = process.cwd();
    const cwdName = basename(cwd);
    const gitMarkerPath = findUpward(cwd, ".git");
    const gitRoot = gitMarkerPath ? dirname(gitMarkerPath) : undefined;
    const gitRootName = gitRoot ? basename(gitRoot) : undefined;
    const packageJsonPath = findUpward(cwd, "package.json");
    const packageName = readPackageName(packageJsonPath);
    const configuredProjectName = this.config.project.name;

    const titleCandidate =
      configuredProjectName || packageName || gitRootName || cwdName;

    const titleSource: ProjectIdentity["titleSource"] = configuredProjectName
      ? "env"
      : packageName
        ? "package.json"
        : gitRootName
          ? "git"
          : cwdName
            ? "cwd"
            : "generated";

    const resolvedTitle = titleCandidate || "Project";
    const slugBase = slugify(resolvedTitle) || "session";
    const fingerprint = shortHash(gitRoot || packageJsonPath || cwd);
    const resolvedSessionId = `${slugBase}-${fingerprint}`.slice(0, 64);

    return {
      cwd,
      cwdName,
      ...(gitRoot ? { gitRoot } : {}),
      ...(gitRootName ? { gitRootName } : {}),
      ...(packageJsonPath ? { packageJsonPath } : {}),
      ...(packageName ? { packageName } : {}),
      ...(configuredProjectName ? { configuredProjectName } : {}),
      resolvedTitle,
      resolvedSessionId,
      titleSource,
    };
  }

  private readSessionMarker(cwd: string): SessionMarkerState | null {
    return readSessionMarkerState(cwd, this.logger);
  }

  private writeSessionMarker(inputCwd: string, input: {
    localSessionId: string;
    sessionLabel?: string | undefined;
    cwd: string;
    envFile?: string | undefined;
  }): void {
    writeSessionMarkerState({
      cwd: inputCwd,
      localSessionId: input.localSessionId,
      sessionLabel: input.sessionLabel,
      envFile: input.envFile,
      logger: this.logger,
    });
  }
}
