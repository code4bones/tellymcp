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
    return {
      sessionId: input.session_id?.trim() || this.identity.resolvedSessionId,
      sessionLabel: input.session_label?.trim() || this.identity.resolvedTitle,
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
