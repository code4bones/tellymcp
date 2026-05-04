import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import type { AppConfig } from "../../../app/config/env.js";
import type { Logger } from "../logger/logger.js";

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
  tmux_session_name?: string | undefined;
  tmux_window_name?: string | undefined;
  tmux_window_index?: number | undefined;
  tmux_pane_id?: string | undefined;
  tmux_pane_index?: number | undefined;
};

export type ResolvedSessionDefaults = {
  sessionId: string;
  sessionLabel: string;
  sessionIdDerived: boolean;
  sessionLabelDerived: boolean;
};

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

function buildTmuxContextParts(input: SessionDefaultsInput): {
  labelSuffix?: string;
  slugSuffix?: string;
  fingerprintSource?: string;
} {
  const sessionName = normalizeOptionalString(input.tmux_session_name);
  const windowName = normalizeOptionalString(input.tmux_window_name);
  const paneId = normalizeOptionalString(input.tmux_pane_id);
  const windowIndex =
    typeof input.tmux_window_index === "number"
      ? String(input.tmux_window_index)
      : undefined;
  const paneIndex =
    typeof input.tmux_pane_index === "number"
      ? String(input.tmux_pane_index)
      : undefined;

  const humanParts = [
    sessionName,
    windowName ?? (windowIndex ? `w${windowIndex}` : undefined),
    paneIndex ? `p${paneIndex}` : undefined,
  ].filter((part): part is string => Boolean(part));

  const slugParts = [
    sessionName,
    windowName,
    windowIndex ? `w${windowIndex}` : undefined,
    paneId ? paneId.replace(/[^a-zA-Z0-9]+/g, "-") : undefined,
    paneIndex ? `p${paneIndex}` : undefined,
  ]
    .map((part) => (part ? slugify(part) : undefined))
    .filter((part): part is string => Boolean(part));

  const fingerprintParts = [
    sessionName,
    windowName,
    windowIndex,
    paneId,
    paneIndex,
  ].filter((part): part is string => Boolean(part));

  return {
    ...(humanParts.length > 0
      ? { labelSuffix: humanParts.join(":") }
      : {}),
    ...(slugParts.length > 0 ? { slugSuffix: slugParts.join("-") } : {}),
    ...(fingerprintParts.length > 0
      ? { fingerprintSource: fingerprintParts.join("|") }
      : {}),
  };
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
    const tmuxContext = buildTmuxContextParts(input);
    const derivedSessionId = tmuxContext.slugSuffix
      ? `${slugify(this.identity.resolvedTitle) || "session"}-${tmuxContext.slugSuffix}-${shortHash(
          `${this.identity.gitRoot || this.identity.packageJsonPath || this.identity.cwd}|${tmuxContext.fingerprintSource || tmuxContext.slugSuffix}`,
        )}`.slice(0, 64)
      : this.identity.resolvedSessionId;
    const derivedSessionLabel = tmuxContext.labelSuffix
      ? `${this.identity.resolvedTitle} [${tmuxContext.labelSuffix}]`
      : this.identity.resolvedTitle;

    return {
      sessionId: input.session_id?.trim() || derivedSessionId,
      sessionLabel: input.session_label?.trim() || derivedSessionLabel,
      sessionIdDerived: !input.session_id?.trim(),
      sessionLabelDerived: !input.session_label?.trim(),
    };
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
}
