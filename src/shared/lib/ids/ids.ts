import { randomBytes, randomInt } from "node:crypto";

function randomBase36(size: number): string {
  return randomBytes(size)
    .toString("base64url")
    .replace(/[^A-Za-z0-9]/g, "")
    .slice(0, size)
    .toUpperCase();
}

export function createRequestId(now = new Date()): string {
  const timestamp = now
    .toISOString()
    .replace(/[-:.TZ]/g, "")
    .slice(0, 14);
  return `req_${timestamp}_${randomBase36(6).toLowerCase()}`;
}

export function createPairCode(): string {
  return randomInt(0, 1000).toString().padStart(3, "0");
}

export function createInboxMessageId(now = new Date()): string {
  const timestamp = now
    .toISOString()
    .replace(/[-:.TZ]/g, "")
    .slice(0, 14);
  return `inbox_${timestamp}_${randomBase36(6).toLowerCase()}`;
}

export function createMenuPayloadKey(): string {
  return `mk_${randomBase36(8).toLowerCase()}`;
}
