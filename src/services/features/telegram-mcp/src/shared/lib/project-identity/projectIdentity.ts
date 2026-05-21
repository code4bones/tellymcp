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
  tmux_session_name?: string | undefined;
  tmux_window_name?: string | undefined;
  tmux_window_index?: number | undefined;
  tmux_pane_id?: string | undefined;
  tmux_pane_index?: number | undefined;
};

export type ResolvedSessionDefaults = {
  sessionId: string;
  sessionLabel: string;
  cwd: string;
  sessionIdDerived: boolean;
  sessionLabelDerived: boolean;
};

type SessionMarkerShape = {
  version?: unknown;
  local_session_id?: unknown;
  session_label?: unknown;
  cwd?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
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
    const inputCwd = resolveInputCwd(input.cwd);
    const resolvedCwd = inputCwd || this.identity.cwd;
    const titleBase = basename(resolvedCwd) || this.identity.resolvedTitle || "Project";
    const explicitSessionId =
      input.session_id?.trim() || this.config.project.sessionId?.trim();
    const explicitSessionLabel =
      input.session_label?.trim() || this.config.project.sessionLabel?.trim();
    const sessionMarker =
      explicitSessionId || explicitSessionLabel
        ? null
        : this.readSessionMarker(resolvedCwd);
    const derivedSessionId =
      sessionMarker?.localSessionId ||
      `${slugify(titleBase) || "session"}-${shortHash(resolvedCwd)}`;
    const derivedSessionLabel = sessionMarker?.sessionLabel || titleBase;

    if (!sessionMarker && !explicitSessionId && !explicitSessionLabel) {
      this.writeSessionMarker(resolvedCwd, {
        localSessionId: explicitSessionId || derivedSessionId,
        sessionLabel: explicitSessionLabel || derivedSessionLabel,
        cwd: resolvedCwd,
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

  public persistSessionMarker(input: {
    cwd?: string | undefined;
    sessionId: string;
    sessionLabel?: string | undefined;
  }): void {
    const resolvedCwd = resolveInputCwd(input.cwd) || this.identity.cwd;
    const current = this.readSessionMarker(resolvedCwd);
    this.writeSessionMarker(resolvedCwd, {
      localSessionId: input.sessionId,
      sessionLabel: input.sessionLabel || current?.sessionLabel,
      cwd: resolvedCwd,
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

  private readSessionMarker(
    cwd: string,
  ): { localSessionId: string; sessionLabel?: string; cwd?: string } | null {
    const markerPath = join(cwd, SESSION_MARKER_FILE_NAME);
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
      };
    } catch (error) {
      this.logger.warn("Failed to read .mcpsession.json, ignoring marker", {
        cwd,
        markerPath,
        error: error instanceof Error ? (error.stack ?? error.message) : String(error),
      });
      return null;
    }
  }

  private writeSessionMarker(inputCwd: string, input: {
    localSessionId: string;
    sessionLabel?: string | undefined;
    cwd: string;
  }): void {
    const markerPath = join(inputCwd, SESSION_MARKER_FILE_NAME);
    const now = new Date().toISOString();
    const current = this.readSessionMarker(inputCwd);

    try {
      writeFileSync(
        markerPath,
        `${JSON.stringify(
          {
            version: 1,
            local_session_id: input.localSessionId,
            ...(input.sessionLabel ? { session_label: input.sessionLabel } : {}),
            cwd: input.cwd,
            created_at: now,
            updated_at: now,
            ...(current ? { first_seen_local_session_id: current.localSessionId } : {}),
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
    } catch (error) {
      this.logger.warn("Failed to write .mcpsession.json", {
        cwd: inputCwd,
        markerPath,
        sessionId: input.localSessionId,
        error: error instanceof Error ? (error.stack ?? error.message) : String(error),
      });
    }
  }
}
