import { randomBytes, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, readdir, rename, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import type { Logger } from "../../../shared/lib/logger/logger";

const FILE_LINK_TTL_MS = 10 * 60 * 1000;
const FILE_LINK_MAX_BYTES = 32 * 1024 * 1024;
const FILE_LINK_MAX_DOWNLOADS = 3;
const FILE_LINK_CLEANUP_INTERVAL_MS = 60 * 1000;

type TemporaryFileRecord = {
  id: string;
  uploadToken: string;
  downloadToken: string;
  cacheKey: string;
  filePath: string;
  partialPath: string;
  expiresAtMs: number;
  status: "pending" | "ready";
  filename?: string | undefined;
  mimetype?: string | undefined;
  sizeBytes?: number | undefined;
  downloadCount: number;
};

export type TemporaryFileTicket = {
  upload_url: string;
  download_token: string;
  expires_at: string;
};

export type TemporaryFileLink = {
  url: string;
  filename: string;
  mimetype: string;
  size_bytes: number;
  expires_at: string;
};

function sanitizeFilename(value: string | undefined): string {
  const basename = path.basename(value?.trim() || "file.bin");
  const safe = basename
    .replace(/[\u0000-\u001f\u007f]/gu, "-")
    .replace(/[/\\<>:"|?*]/gu, "-")
    .trim();
  return safe || "file.bin";
}

function decodeFilenameHeader(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function encodeContentDispositionFilename(filename: string): string {
  return encodeURIComponent(filename).replace(/[!'()*]/gu, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export function resolvePublicFilesBaseUrl(
  gatewayPublicUrl: string | undefined,
): URL {
  if (!gatewayPublicUrl?.trim()) {
    throw new Error("URL file delivery requires GATEWAY_PUBLIC_URL.");
  }

  const url = new URL(gatewayPublicUrl);
  url.search = "";
  url.hash = "";
  url.pathname = url.pathname.replace(/\/+$/u, "");
  if (url.pathname.endsWith("/gateway")) {
    url.pathname = url.pathname.slice(0, -"/gateway".length) || "/";
  }
  url.pathname = `${url.pathname.replace(/\/+$/u, "")}/files`.replace(
    /\/{2,}/gu,
    "/",
  );
  return url;
}

function readSingleHeader(
  req: IncomingMessage,
  name: string,
): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

export class TemporaryFileLinkStore {
  private readonly recordsByUploadToken = new Map<string, TemporaryFileRecord>();

  private readonly recordsByDownloadToken = new Map<
    string,
    TemporaryFileRecord
  >();

  private readonly recordsByCacheKey = new Map<string, TemporaryFileRecord>();

  private cleanupTimer: NodeJS.Timeout | null = null;

  private readonly baseUrl: URL;

  private readonly rootDir: string;

  public constructor(
    gatewayPublicUrl: string | undefined,
    private readonly logger: Logger,
    rootDir = path.resolve(".tellymcp", "tmp", "file-links"),
  ) {
    this.baseUrl = resolvePublicFilesBaseUrl(gatewayPublicUrl);
    this.rootDir = rootDir;
  }

  public async start(): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
    const entries = await readdir(this.rootDir).catch(() => []);
    await Promise.all(
      entries.map((entry) =>
        rm(path.join(this.rootDir, entry), { force: true, recursive: true }),
      ),
    );
    this.cleanupTimer = setInterval(() => {
      void this.cleanupExpired();
    }, FILE_LINK_CLEANUP_INTERVAL_MS);
    this.cleanupTimer.unref();
  }

  public async stop(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    await this.cleanupExpired(true);
  }

  public createTicket(cacheKey: string): TemporaryFileTicket {
    const id = randomUUID();
    const uploadToken = randomBytes(32).toString("base64url");
    const downloadToken = randomBytes(32).toString("base64url");
    const expiresAtMs = Date.now() + FILE_LINK_TTL_MS;
    const record: TemporaryFileRecord = {
      id,
      uploadToken,
      downloadToken,
      cacheKey,
      filePath: path.join(this.rootDir, `${id}.bin`),
      partialPath: path.join(this.rootDir, `${id}.upload`),
      expiresAtMs,
      status: "pending",
      downloadCount: 0,
    };
    this.recordsByUploadToken.set(uploadToken, record);
    this.recordsByDownloadToken.set(downloadToken, record);
    this.recordsByCacheKey.set(cacheKey, record);

    const uploadUrl = new URL(this.baseUrl);
    uploadUrl.pathname = `${this.baseUrl.pathname}/upload/${uploadToken}`;
    return {
      upload_url: uploadUrl.toString(),
      download_token: downloadToken,
      expires_at: new Date(expiresAtMs).toISOString(),
    };
  }

  public async discard(downloadToken: string): Promise<void> {
    const record = this.recordsByDownloadToken.get(downloadToken);
    if (record) {
      await this.deleteRecord(record);
    }
  }

  public getReadyLink(downloadToken: string): TemporaryFileLink {
    const record = this.recordsByDownloadToken.get(downloadToken);
    if (!record || record.expiresAtMs <= Date.now() || record.status !== "ready") {
      throw new Error("Temporary file upload did not complete.");
    }
    if (!record.filename || !record.mimetype || record.sizeBytes === undefined) {
      throw new Error("Temporary file metadata is incomplete.");
    }

    const downloadUrl = new URL(this.baseUrl);
    downloadUrl.pathname = `${this.baseUrl.pathname}/download/${record.downloadToken}/${encodeURIComponent(record.filename)}`;
    return {
      url: downloadUrl.toString(),
      filename: record.filename,
      mimetype: record.mimetype,
      size_bytes: record.sizeBytes,
      expires_at: new Date(record.expiresAtMs).toISOString(),
    };
  }

  public async readCachedBase64(cacheKey: string, maxBytes: number): Promise<{
    data: string;
    filename: string;
    mimetype: string;
    size_bytes: number;
  } | null> {
    const record = this.recordsByCacheKey.get(cacheKey);
    if (
      !record ||
      record.status !== "ready" ||
      record.expiresAtMs <= Date.now() ||
      !record.filename ||
      !record.mimetype ||
      record.sizeBytes === undefined ||
      record.sizeBytes > maxBytes
    ) {
      return null;
    }
    const content = await readFile(record.filePath);
    return {
      data: content.toString("base64"),
      filename: record.filename,
      mimetype: record.mimetype,
      size_bytes: record.sizeBytes,
    };
  }

  public matches(pathname: string): boolean {
    return pathname.startsWith("/files/");
  }

  public async handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
  ): Promise<boolean> {
    if (!this.matches(pathname)) {
      return false;
    }

    const uploadMatch = /^\/files\/upload\/([^/]+)$/u.exec(pathname);
    if (uploadMatch) {
      await this.handleUpload(req, res, uploadMatch[1] ?? "");
      return true;
    }

    const downloadMatch = /^\/files\/download\/([^/]+)(?:\/[^/]*)?$/u.exec(
      pathname,
    );
    if (downloadMatch) {
      await this.handleDownload(req, res, downloadMatch[1] ?? "");
      return true;
    }

    res.statusCode = 404;
    res.end("Not found");
    return true;
  }

  private async handleUpload(
    req: IncomingMessage,
    res: ServerResponse,
    uploadToken: string,
  ): Promise<void> {
    if (req.method !== "PUT") {
      res.statusCode = 405;
      res.end("Method not allowed");
      return;
    }

    const record = this.recordsByUploadToken.get(uploadToken);
    if (!record || record.expiresAtMs <= Date.now() || record.status !== "pending") {
      res.statusCode = 404;
      res.end("Upload ticket not found");
      return;
    }

    const declaredLength = Number(readSingleHeader(req, "content-length") ?? "0");
    if (
      !Number.isFinite(declaredLength) ||
      declaredLength < 0 ||
      declaredLength > FILE_LINK_MAX_BYTES
    ) {
      res.statusCode = 413;
      res.end("Invalid or oversized content-length");
      return;
    }

    let receivedBytes = 0;
    const limiter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        receivedBytes += chunk.byteLength;
        if (receivedBytes > FILE_LINK_MAX_BYTES) {
          callback(new Error("Temporary file exceeds the 32 MiB limit."));
          return;
        }
        callback(null, chunk);
      },
    });

    try {
      await pipeline(
        req,
        limiter,
        createWriteStream(record.partialPath, { flags: "wx" }),
      );
      if (receivedBytes !== declaredLength) {
        throw new Error("Uploaded file size does not match content-length.");
      }
      await rename(record.partialPath, record.filePath);
      record.filename = sanitizeFilename(
        decodeFilenameHeader(readSingleHeader(req, "x-telly-filename")),
      );
      record.mimetype =
        readSingleHeader(req, "content-type")?.split(";", 1)[0]?.trim() ||
        "application/octet-stream";
      record.sizeBytes = receivedBytes;
      record.status = "ready";
      this.recordsByUploadToken.delete(uploadToken);
      res.statusCode = 204;
      res.end();
    } catch (error) {
      await rm(record.partialPath, { force: true });
      this.logger.warn("Temporary file upload failed", {
        transferId: record.id,
        error: error instanceof Error ? error.message : String(error),
      });
      res.statusCode = 400;
      res.end("Upload failed");
    }
  }

  private async handleDownload(
    req: IncomingMessage,
    res: ServerResponse,
    downloadToken: string,
  ): Promise<void> {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.statusCode = 405;
      res.end("Method not allowed");
      return;
    }

    const record = this.recordsByDownloadToken.get(downloadToken);
    if (
      !record ||
      record.status !== "ready" ||
      record.expiresAtMs <= Date.now() ||
      !record.filename ||
      !record.mimetype ||
      record.sizeBytes === undefined ||
      record.downloadCount >= FILE_LINK_MAX_DOWNLOADS
    ) {
      res.statusCode = 404;
      res.end("File link expired or unavailable");
      return;
    }

    res.statusCode = 200;
    res.setHeader("content-type", record.mimetype);
    res.setHeader("content-length", record.sizeBytes);
    res.setHeader(
      "content-disposition",
      `attachment; filename*=UTF-8''${encodeContentDispositionFilename(record.filename)}`,
    );
    res.setHeader("cache-control", "private, no-store, max-age=0");
    res.setHeader("x-content-type-options", "nosniff");
    if (req.method === "HEAD") {
      res.end();
      return;
    }

    record.downloadCount += 1;
    try {
      await pipeline(createReadStream(record.filePath), res);
    } catch (error) {
      record.downloadCount -= 1;
      this.logger.warn("Temporary file download failed", {
        transferId: record.id,
        error: error instanceof Error ? error.message : String(error),
      });
      if (!res.writableEnded) {
        res.destroy(error instanceof Error ? error : undefined);
      }
    }
  }

  private async cleanupExpired(force = false): Promise<void> {
    const now = Date.now();
    const records = [...this.recordsByDownloadToken.values()];
    await Promise.all(
      records
        .filter((record) => force || record.expiresAtMs <= now)
        .map((record) => this.deleteRecord(record)),
    );
  }

  private async deleteRecord(record: TemporaryFileRecord): Promise<void> {
    this.recordsByUploadToken.delete(record.uploadToken);
    this.recordsByDownloadToken.delete(record.downloadToken);
    if (this.recordsByCacheKey.get(record.cacheKey) === record) {
      this.recordsByCacheKey.delete(record.cacheKey);
    }
    await Promise.all([
      rm(record.filePath, { force: true }),
      rm(record.partialPath, { force: true }),
    ]);
  }
}

export const TEMPORARY_FILE_LINK_MAX_BYTES = FILE_LINK_MAX_BYTES;
