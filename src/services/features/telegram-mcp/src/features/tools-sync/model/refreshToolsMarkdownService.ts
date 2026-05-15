import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import type { AppConfig } from "../../../app/config/env";
import type {
  RefreshToolsMarkdownInput,
  RefreshToolsMarkdownOutput,
} from "../../../entities/request/model/types";
import type { SessionStore } from "../../../shared/api/storage/contract";
import type { Logger } from "../../../shared/lib/logger/logger";
import { ProjectIdentityResolver } from "../../../shared/lib/project-identity/projectIdentity";

function normalizeGatewayBaseUrl(value: string): URL {
  const url = new URL(value);
  url.pathname = url.pathname.replace(/\/+$/u, "");

  if (!url.pathname.endsWith("/gateway")) {
    url.pathname = `${url.pathname}/gateway`.replace(/\/{2,}/gu, "/");
  }

  return url;
}

export class RefreshToolsMarkdownService {
  public constructor(
    private readonly config: AppConfig,
    private readonly sessionStore: SessionStore,
    private readonly logger: Logger,
    private readonly projectIdentityResolver: ProjectIdentityResolver,
  ) {}

  public async refresh(
    input: RefreshToolsMarkdownInput = {},
  ): Promise<RefreshToolsMarkdownOutput> {
    const resolved = this.projectIdentityResolver.resolveSessionDefaults(input);
    const session = await this.sessionStore.getSession(resolved.sessionId);
    const workspaceDir = input.cwd?.trim()
      ? resolve(input.cwd.trim())
      : session?.cwd?.trim()
        ? resolve(session.cwd.trim())
        : undefined;
    const saveLocally = input.save_locally !== false;
    const gatewayToolsPath = join(process.cwd(), "TOOLS.md");

    let source: "gateway" | "local" = "local";
    let content: string;

    if (this.config.distributed.gatewayPublicUrl) {
      const url = normalizeGatewayBaseUrl(this.config.distributed.gatewayPublicUrl);
      url.pathname = `${url.pathname}/tools-md`.replace(/\/{2,}/gu, "/");

      const response = await fetch(url, {
        method: "GET",
        headers: {
          ...(this.config.distributed.gatewayAuthToken
            ? { authorization: `Bearer ${this.config.distributed.gatewayAuthToken}` }
            : {}),
        },
      });

      if (!response.ok) {
        const message = await response.text();
        throw new Error(
          `Gateway TOOLS.md request failed with status ${response.status}: ${message || response.statusText}`,
        );
      }

      content = await response.text();
      source = "gateway";
    } else {
      content = readFileSync(gatewayToolsPath, "utf8");
    }

    if (!workspaceDir) {
      throw new Error(
        "Could not resolve target workspace for TOOLS.md. Pair the session with cwd first or pass cwd/session_id explicitly.",
      );
    }

    const toolsPath = join(workspaceDir, "TOOLS.md");

    if (saveLocally) {
      writeFileSync(toolsPath, content, "utf8");
    }

    this.logger.info("TOOLS.md refreshed", {
      source,
      saved: saveLocally,
      path: toolsPath,
      bytes: Buffer.byteLength(content, "utf8"),
    });

    return {
      source,
      saved: saveLocally,
      bytes: Buffer.byteLength(content, "utf8"),
      ...(saveLocally ? { path: toolsPath } : {}),
    };
  }
}
