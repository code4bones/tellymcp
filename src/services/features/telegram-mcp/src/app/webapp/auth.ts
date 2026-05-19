import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

export type TelegramWebAppUser = {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  photo_url?: string;
};

export type TelegramWebAppInitDataUnsafe = {
  auth_date?: number | string;
  hash?: string;
  query_id?: string;
  start_param?: string;
  user?: TelegramWebAppUser;
};

export type ValidatedWebAppInitData = {
  user: TelegramWebAppUser;
  authDate: number;
  rawInitData: string;
  queryId?: string;
  startParam?: string;
  validationDebug: {
    providedHash: string;
    officialRaw: {
      checkString: string;
      computedHash: string;
      matches: boolean;
    };
    userFields: {
      checkString: string;
      computedHash: string;
      matches: boolean;
    } | null;
  };
};

export type WebAppSessionTokenRecord = {
  token: string;
  sessionId: string;
  telegramUserId: number;
  expiresAtMs: number;
  createdAtMs: number;
  lastActionAtMs: number;
};

export type PendingWebAppLaunchRecord = {
  telegramUserId: number;
  sessionId: string;
  telegramChatId?: number;
  telegramMessageId?: number;
  allowForeignBinding?: boolean;
  expiresAtMs: number;
  createdAtMs: number;
};

export class WebAppLaunchRegistry {
  private readonly launches = new Map<number, PendingWebAppLaunchRecord>();

  public set(
    telegramUserId: number,
    sessionId: string,
    ttlSeconds: number,
    details?: {
      telegramChatId?: number;
      telegramMessageId?: number;
      allowForeignBinding?: boolean;
    },
  ): PendingWebAppLaunchRecord {
    this.cleanupExpired();
    const nowMs = Date.now();
    const record: PendingWebAppLaunchRecord = {
      telegramUserId,
      sessionId,
      ...(details?.telegramChatId !== undefined
        ? { telegramChatId: details.telegramChatId }
        : {}),
      ...(details?.telegramMessageId !== undefined
        ? { telegramMessageId: details.telegramMessageId }
        : {}),
      ...(details?.allowForeignBinding === true
        ? { allowForeignBinding: true }
        : {}),
      expiresAtMs: nowMs + ttlSeconds * 1000,
      createdAtMs: nowMs,
    };
    this.launches.set(telegramUserId, record);
    return record;
  }

  public getByUserId(telegramUserId: number): PendingWebAppLaunchRecord | null {
    this.cleanupExpired();
    const record = this.launches.get(telegramUserId);
    if (!record) {
      return null;
    }

    if (record.expiresAtMs <= Date.now()) {
      this.launches.delete(telegramUserId);
      return null;
    }

    return record;
  }

  public deleteByUserId(telegramUserId: number): void {
    this.launches.delete(telegramUserId);
  }

  private cleanupExpired(): void {
    const nowMs = Date.now();
    for (const [telegramUserId, record] of this.launches.entries()) {
      if (record.expiresAtMs <= nowMs) {
        this.launches.delete(telegramUserId);
      }
    }
  }
}

export class WebAppSessionRegistry {
  private readonly sessions = new Map<string, WebAppSessionTokenRecord>();

  public create(
    sessionId: string,
    telegramUserId: number,
    ttlSeconds: number,
  ): WebAppSessionTokenRecord {
    this.cleanupExpired();
    const nowMs = Date.now();
    const record: WebAppSessionTokenRecord = {
      token: randomUUID(),
      sessionId,
      telegramUserId,
      expiresAtMs: nowMs + ttlSeconds * 1000,
      createdAtMs: nowMs,
      lastActionAtMs: 0,
    };
    this.sessions.set(record.token, record);
    return record;
  }

  public get(token: string): WebAppSessionTokenRecord | null {
    this.cleanupExpired();
    const record = this.sessions.get(token);
    if (!record) {
      return null;
    }

    if (record.expiresAtMs <= Date.now()) {
      this.sessions.delete(token);
      return null;
    }

    return record;
  }

  public touchAction(token: string, nowMs: number): void {
    const record = this.sessions.get(token);
    if (!record) {
      return;
    }

    this.sessions.set(token, {
      ...record,
      lastActionAtMs: nowMs,
    });
  }

  private cleanupExpired(): void {
    const nowMs = Date.now();
    for (const [token, record] of this.sessions.entries()) {
      if (record.expiresAtMs <= nowMs) {
        this.sessions.delete(token);
      }
    }
  }
}

function normalizeTelegramWebAppInitData(rawInitData: string): string {
  let normalized = rawInitData.trim();

  if (normalized.startsWith("#")) {
    normalized = normalized.slice(1);
  }

  if (normalized.startsWith("tgWebAppData=")) {
    normalized = normalized.slice("tgWebAppData=".length);
  }

  const extraMarkers = [
    "&tgWebAppVersion=",
    "&tgWebAppPlatform=",
    "&tgWebAppThemeParams=",
  ];

  let cutIndex = -1;
  for (const marker of extraMarkers) {
    const markerIndex = normalized.indexOf(marker);
    if (markerIndex >= 0 && (cutIndex < 0 || markerIndex < cutIndex)) {
      cutIndex = markerIndex;
    }
  }

  if (cutIndex >= 0) {
    normalized = normalized.slice(0, cutIndex);
  }

  return normalized.trim();
}

function normalizeUnsafeUser(
  user: TelegramWebAppInitDataUnsafe["user"],
): TelegramWebAppUser | null {
  if (!user || typeof user !== "object" || typeof user.id !== "number") {
    return null;
  }

  return {
    id: user.id,
    ...(typeof user.first_name === "string" ? { first_name: user.first_name } : {}),
    ...(typeof user.last_name === "string" ? { last_name: user.last_name } : {}),
    ...(typeof user.username === "string" ? { username: user.username } : {}),
    ...(typeof user.language_code === "string"
      ? { language_code: user.language_code }
      : {}),
    ...(typeof user.photo_url === "string" ? { photo_url: user.photo_url } : {}),
  };
}

function buildOfficialRawValidation(
  rawInitData: string,
  botToken: string,
): {
  checkString: string;
  computedHash: string;
  providedHash: string;
  matches: boolean;
} | null {
  const params = new URLSearchParams(rawInitData);
  const receivedHash = params.get("hash");
  if (!receivedHash) {
    return null;
  }

  const checkString = [...params.entries()]
    .filter(([key, value]) => key !== "hash" && value !== undefined)
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const secretKey = createHmac("sha256", "WebAppData")
    .update(botToken.trim())
    .digest();
  const computed = createHmac("sha256", secretKey)
    .update(checkString)
    .digest("hex");

  const matches =
    computed.length === receivedHash.length &&
    timingSafeEqual(
      Buffer.from(computed, "utf8"),
      Buffer.from(receivedHash, "utf8"),
    );

  return {
    checkString,
    computedHash: computed,
    providedHash: receivedHash,
    matches,
  };
}

function buildUserFieldsValidation(
  unsafe: TelegramWebAppInitDataUnsafe | null,
  botToken: string,
): {
  checkString: string;
  computedHash: string;
  providedHash: string;
  matches: boolean;
} | null {
  if (!unsafe) {
    return null;
  }

  const user = normalizeUnsafeUser(unsafe.user);
  const authDateValue =
    typeof unsafe.auth_date === "number" || typeof unsafe.auth_date === "string"
      ? unsafe.auth_date
      : undefined;
  const receivedHash =
    typeof unsafe.hash === "string" && unsafe.hash.length > 0
      ? unsafe.hash
      : undefined;

  if (!user || authDateValue === undefined || !receivedHash) {
    return null;
  }

  const params: Record<string, string | number | undefined> = {
    id: user.id,
    first_name: user.first_name,
    last_name: user.last_name,
    username: user.username,
    photo_url: user.photo_url,
    auth_date: authDateValue,
  };

  const checkString = Object.keys(params)
    .sort()
    .filter((key) => params[key] !== undefined)
    .map((key) => `${key}=${params[key]}`)
    .join("\n");

  const secretKey = createHash("sha256")
    .update(botToken.trim())
    .digest();
  const computed = createHmac("sha256", secretKey)
    .update(checkString)
    .digest("hex");
  const matches =
    computed.length === receivedHash.length &&
    timingSafeEqual(
      Buffer.from(computed, "utf8"),
      Buffer.from(receivedHash, "utf8"),
    );

  return {
    checkString,
    computedHash: computed,
    providedHash: receivedHash,
    matches,
  };
}

export function validateTelegramWebAppInitData(
  rawInitData: string | null | undefined,
  unsafeInitData: TelegramWebAppInitDataUnsafe | null | undefined,
  botToken: string,
  maxAgeSeconds: number,
): ValidatedWebAppInitData {
  const normalizedRaw = rawInitData
    ? normalizeTelegramWebAppInitData(rawInitData)
    : "";
  const normalizedUnsafe = unsafeInitData ?? null;

  if (!normalizedRaw && !normalizedUnsafe) {
    throw new Error("Telegram WebApp initData is empty.");
  }

  const officialRawValidation = buildOfficialRawValidation(
    normalizedRaw,
    botToken,
  );
  const userFieldsValidation = buildUserFieldsValidation(
    normalizedUnsafe,
    botToken,
  );

  if (!officialRawValidation?.matches && !userFieldsValidation?.matches) {
    throw new Error("Telegram WebApp initData hash validation failed.");
  }

  if (!normalizedUnsafe) {
    throw new Error("Telegram WebApp unsafe init data is missing.");
  }

  const user = normalizeUnsafeUser(normalizedUnsafe.user);
  const authDateRaw =
    typeof normalizedUnsafe.auth_date === "number" ||
    typeof normalizedUnsafe.auth_date === "string"
      ? String(normalizedUnsafe.auth_date)
      : null;
  if (!authDateRaw || !user) {
    throw new Error("Telegram WebApp initData is missing auth_date or user.");
  }

  const authDate = Number.parseInt(authDateRaw, 10);
  if (!Number.isFinite(authDate) || authDate <= 0) {
    throw new Error("Telegram WebApp auth_date is invalid.");
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (nowSeconds - authDate > maxAgeSeconds) {
    throw new Error("Telegram WebApp initData is expired.");
  }

  return {
    user,
    authDate,
    rawInitData: normalizedRaw,
    ...(typeof normalizedUnsafe.query_id === "string"
      ? { queryId: normalizedUnsafe.query_id }
      : {}),
    ...(typeof normalizedUnsafe.start_param === "string"
      ? { startParam: normalizedUnsafe.start_param }
      : {}),
    validationDebug: {
      providedHash:
        officialRawValidation?.providedHash ??
        userFieldsValidation?.providedHash ??
        "",
      officialRaw: {
        checkString: officialRawValidation?.checkString ?? "",
        computedHash: officialRawValidation?.computedHash ?? "",
        matches: officialRawValidation?.matches ?? false,
      },
      userFields: userFieldsValidation
        ? {
            checkString: userFieldsValidation.checkString,
            computedHash: userFieldsValidation.computedHash,
            matches: userFieldsValidation.matches,
          }
        : null,
    },
  };
}
