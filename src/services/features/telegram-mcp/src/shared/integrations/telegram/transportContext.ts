import type { AppConfig } from "../../../app/config/env";
import { normalizeLocale, translate, type SupportedLocale } from "../../i18n";
import type { TelegramUserLocaleStore } from "../../api/storage/contract";
import type {
  GatewayActorProfile,
  TelegramMenuContext,
} from "./transportTypes";

type Principal = { telegramChatId: number; telegramUserId: number };

export interface TransportContextHost {
  config: AppConfig;
  localeStore: TelegramUserLocaleStore;
}

export class TransportContext {
  public constructor(private readonly host: TransportContextHost) {}

  public getPrincipalFromContext(ctx: TelegramMenuContext): Principal | null {
    const chatId = ctx.chat?.id;
    const userId = ctx.from?.id;
    if (!chatId || !userId) {
      return null;
    }

    return {
      telegramChatId: chatId,
      telegramUserId: userId,
    };
  }

  public async resolveLocaleForContext(
    ctx: TelegramMenuContext,
  ): Promise<SupportedLocale> {
    if (this.host.config?.telegram?.debugLanguage) {
      return normalizeLocale(this.host.config.telegram.debugLanguage);
    }

    const telegramUserId = ctx.from?.id;
    const telegramLanguageCode = ctx.from?.language_code;
    if (!telegramUserId) {
      return normalizeLocale(telegramLanguageCode);
    }

    const storedLocale = await this.host.localeStore?.getUserLocale?.(telegramUserId);
    if (storedLocale) {
      return normalizeLocale(storedLocale);
    }

    const detectedLocale = normalizeLocale(telegramLanguageCode);
    await this.host.localeStore?.setUserLocale?.(telegramUserId, detectedLocale);
    return detectedLocale;
  }

  public async resolveLocaleForTelegramUserId(
    telegramUserId?: number,
    telegramLanguageCode?: string | null | undefined,
  ): Promise<SupportedLocale> {
    if (this.host.config?.telegram?.debugLanguage) {
      return normalizeLocale(this.host.config.telegram.debugLanguage);
    }

    if (!telegramUserId) {
      return normalizeLocale(telegramLanguageCode);
    }

    const storedLocale = await this.host.localeStore?.getUserLocale?.(telegramUserId);
    if (storedLocale) {
      return normalizeLocale(storedLocale);
    }

    const detectedLocale = normalizeLocale(telegramLanguageCode);
    await this.host.localeStore?.setUserLocale?.(telegramUserId, detectedLocale);
    return detectedLocale;
  }

  public async tForContext(
    ctx: TelegramMenuContext,
    key: string,
    options?: Record<string, unknown>,
  ): Promise<string> {
    return this.t(await this.resolveLocaleForContext(ctx), key, options);
  }

  public async tForTelegramUserId(
    telegramUserId: number | undefined,
    key: string,
    options?: Record<string, unknown>,
  ): Promise<string> {
    return this.t(
      await this.resolveLocaleForTelegramUserId(telegramUserId),
      key,
      options,
    );
  }

  public t(
    locale: SupportedLocale,
    key: string,
    options?: Record<string, unknown>,
  ): string {
    return translate(locale, key, options);
  }

  public getGatewayActorFromContext(
    ctx: TelegramMenuContext,
  ): GatewayActorProfile | undefined {
    const firstName = ctx.from?.first_name?.trim();
    const lastName = ctx.from?.last_name?.trim();
    const username = ctx.from?.username?.trim();
    const displayName = [firstName, lastName].filter(Boolean).join(" ").trim();

    if (!firstName && !lastName && !username) {
      return undefined;
    }

    return {
      ...(username ? { telegramUsername: username } : {}),
      ...(firstName ? { telegramFirstName: firstName } : {}),
      ...(lastName ? { telegramLastName: lastName } : {}),
      ...(displayName ? { telegramDisplayName: displayName } : {}),
    };
  }
}
