import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { AppConfig } from "../../../app/config/env";
import type {
  RefreshToolsMarkdownInput,
  RefreshToolsMarkdownOutput,
} from "../../../entities/request/model/types";
import type { Logger } from "../../../shared/lib/logger/logger";

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
    private readonly logger: Logger,
  ) {}

  public async refresh(
    input: RefreshToolsMarkdownInput = {},
  ): Promise<RefreshToolsMarkdownOutput> {
    const toolsPath = join(process.cwd(), "TOOLS.md");
    const saveLocally = input.save_locally !== false;

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
      content = readFileSync(toolsPath, "utf8");
    }

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
