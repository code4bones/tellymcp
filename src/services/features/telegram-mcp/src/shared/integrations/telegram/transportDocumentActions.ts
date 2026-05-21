import { GrammyError, type InputFile } from "grammy";

import type { Logger } from "../../lib/logger/logger";
import type { SendMessageMeta, TelegramMenuContext } from "./transportTypes";

export interface TransportDocumentActionsHost {
  logger: Logger;
}

export class TransportDocumentActions {
  public constructor(private readonly host: TransportDocumentActionsHost) {}

  public async replyDocumentWithRetry(
    ctx: TelegramMenuContext,
    document: InputFile,
    options: Parameters<TelegramMenuContext["replyWithDocument"]>[1] = {},
    meta: SendMessageMeta,
  ): Promise<void> {
    let attempt = 0;

    while (true) {
      attempt += 1;

      try {
        await ctx.replyWithDocument(document, options);
        return;
      } catch (error) {
        if (!(error instanceof GrammyError) || error.error_code !== 429) {
          throw error;
        }

        const retryAfterSeconds = Math.max(1, error.parameters.retry_after ?? 1);
        this.host.logger.warn(
          "Telegram rate limit hit while sending document, cooling down",
          {
            kind: meta.kind,
            sessionId: meta.sessionId,
            requestId: meta.requestId,
            attempt,
            retryAfterSeconds,
            description: error.description,
          },
        );

        await new Promise((resolve) =>
          setTimeout(resolve, retryAfterSeconds * 1000),
        );
      }
    }
  }
}
