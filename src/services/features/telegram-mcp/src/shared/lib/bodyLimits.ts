import type { IncomingMessage } from "node:http";

export const MAX_BODY_SIZE = 16;
export const MAX_BODY_SIZE_BYTES = MAX_BODY_SIZE * 1024 * 1024;
export const MAX_BASE64_SOURCE_SIZE_BYTES = Math.floor(
  (MAX_BODY_SIZE_BYTES * 3) / 4,
);

export class BodySizeLimitError extends Error {
  public readonly statusCode = 413;

  public constructor(
    public readonly actualBytes: number,
    public readonly maxBytes = MAX_BODY_SIZE_BYTES,
  ) {
    const maxMiB = maxBytes / (1024 * 1024);
    super(`Body size ${actualBytes} bytes exceeds the ${maxMiB} MiB limit.`);
    this.name = "BodySizeLimitError";
  }
}

export const isBodySizeLimitError = (
  error: unknown,
): error is BodySizeLimitError => error instanceof BodySizeLimitError;

export const assertBodySize = (
  actualBytes: number,
  maxBytes = MAX_BODY_SIZE_BYTES,
): void => {
  if (actualBytes > maxBytes) {
    throw new BodySizeLimitError(actualBytes, maxBytes);
  }
};

export const assertStringBodySize = (
  value: string,
  maxBytes = MAX_BODY_SIZE_BYTES,
): void => {
  assertBodySize(Buffer.byteLength(value, "utf8"), maxBytes);
};

export const assertSerializedBodySize = (value: unknown): void => {
  if (value === undefined) {
    return;
  }
  assertStringBodySize(JSON.stringify(value));
};

export const readLimitedJsonBody = async (
  req: IncomingMessage,
): Promise<unknown> => {
  const contentLength = req.headers["content-length"];
  if (typeof contentLength === "string" && /^\d+$/u.test(contentLength)) {
    assertBodySize(Number(contentLength));
  }

  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk as Uint8Array | string);
    totalBytes += buffer.byteLength;
    assertBodySize(totalBytes);
    chunks.push(buffer);
  }

  if (chunks.length === 0) {
    return undefined;
  }

  const raw = Buffer.concat(chunks, totalBytes).toString("utf8").trim();
  if (!raw) {
    return undefined;
  }
  return JSON.parse(raw) as unknown;
};
