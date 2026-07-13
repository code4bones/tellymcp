import {
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

function normalizeTelegramWebAppUser(user: unknown): TelegramWebAppUser | null {
  if (!user || typeof user !== "object") {
    return null;
  }

  const record = user as Record<string, unknown>;
  if (
    typeof record.id !== "number" ||
    !Number.isSafeInteger(record.id) ||
    record.id <= 0
  ) {
    return null;
  }

  return {
    id: record.id,
    ...(typeof record.first_name === "string"
      ? { first_name: record.first_name }
      : {}),
    ...(typeof record.last_name === "string"
      ? { last_name: record.last_name }
      : {}),
    ...(typeof record.username === "string"
      ? { username: record.username }
      : {}),
    ...(typeof record.language_code === "string"
      ? { language_code: record.language_code }
      : {}),
    ...(typeof record.photo_url === "string"
      ? { photo_url: record.photo_url }
      : {}),
  };
}

function validateOfficialRawHash(
  rawInitData: string,
  botToken: string,
): URLSearchParams {
  const params = new URLSearchParams(rawInitData);
  const receivedHashes = params.getAll("hash");
  if (receivedHashes.length !== 1 || !receivedHashes[0]) {
    throw new Error("Telegram WebApp initData hash validation failed.");
  }
  const receivedHash = receivedHashes[0];

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

  if (!matches) {
    throw new Error("Telegram WebApp initData hash validation failed.");
  }

  return params;
}

function readSignedParam(
  params: URLSearchParams,
  key: string,
  required: boolean,
): string | undefined {
  const values = params.getAll(key);
  if (values.length > 1) {
    throw new Error(`Telegram WebApp initData contains duplicate ${key}.`);
  }

  const value = values[0];
  if (required && (value === undefined || value.length === 0)) {
    throw new Error(`Telegram WebApp initData is missing ${key}.`);
  }

  return value;
}

function parseSignedUser(value: string): TelegramWebAppUser {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Telegram WebApp signed user is malformed.");
  }

  const user = normalizeTelegramWebAppUser(parsed);
  if (!user) {
    throw new Error("Telegram WebApp signed user is invalid.");
  }

  return user;
}

function assertUnsafeDataMatchesSigned(
  unsafe: TelegramWebAppInitDataUnsafe,
  signed: {
    user: TelegramWebAppUser;
    authDate: number;
    queryId?: string;
    startParam?: string;
    hash: string;
  },
): void {
  const unsafeUser = normalizeTelegramWebAppUser(unsafe.user);
  if (
    !unsafeUser ||
    JSON.stringify(unsafeUser) !== JSON.stringify(signed.user)
  ) {
    throw new Error("Telegram WebApp unsafe user does not match signed initData.");
  }

  const unsafeAuthDate =
    typeof unsafe.auth_date === "number" || typeof unsafe.auth_date === "string"
      ? String(unsafe.auth_date)
      : undefined;
  if (unsafeAuthDate !== String(signed.authDate)) {
    throw new Error(
      "Telegram WebApp unsafe auth_date does not match signed initData.",
    );
  }

  if (unsafe.query_id !== signed.queryId) {
    throw new Error(
      "Telegram WebApp unsafe query_id does not match signed initData.",
    );
  }

  if (unsafe.start_param !== signed.startParam) {
    throw new Error(
      "Telegram WebApp unsafe start_param does not match signed initData.",
    );
  }

  if (unsafe.hash !== undefined && unsafe.hash !== signed.hash) {
    throw new Error("Telegram WebApp unsafe hash does not match signed initData.");
  }
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

  if (!normalizedRaw) {
    throw new Error("Telegram WebApp initData is empty.");
  }

  const signedParams = validateOfficialRawHash(normalizedRaw, botToken);
  const user = parseSignedUser(readSignedParam(signedParams, "user", true)!);
  const authDateRaw = readSignedParam(signedParams, "auth_date", true)!;
  if (!/^\d+$/.test(authDateRaw)) {
    throw new Error("Telegram WebApp auth_date is invalid.");
  }
  const authDate = Number(authDateRaw);
  if (!Number.isSafeInteger(authDate) || authDate <= 0) {
    throw new Error("Telegram WebApp auth_date is invalid.");
  }

  const queryId = readSignedParam(signedParams, "query_id", false);
  const startParam = readSignedParam(signedParams, "start_param", false);

  if (unsafeInitData) {
    assertUnsafeDataMatchesSigned(unsafeInitData, {
      user,
      authDate,
      ...(queryId !== undefined ? { queryId } : {}),
      ...(startParam !== undefined ? { startParam } : {}),
      hash: readSignedParam(signedParams, "hash", true)!,
    });
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (nowSeconds - authDate > maxAgeSeconds) {
    throw new Error("Telegram WebApp initData is expired.");
  }

  return {
    user,
    authDate,
    rawInitData: normalizedRaw,
    ...(queryId !== undefined ? { queryId } : {}),
    ...(startParam !== undefined ? { startParam } : {}),
  };
}
