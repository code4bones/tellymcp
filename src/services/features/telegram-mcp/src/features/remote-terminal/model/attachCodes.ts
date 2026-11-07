import { createHash, randomInt } from "node:crypto";
import type { Redis } from "ioredis";
import { z } from "zod";

export const ATTACH_CODE_TTL_SECONDS = 300;
export const attachGrantSchema = z
  .object({
    clientUuid: z.uuid(),
    sessionId: z.string().min(1).max(200),
    instance: z.uuid(),
    telegramUserId: z.number().int().positive(),
    expiresAt: z.number().int().positive(),
  })
  .strict();
export type AttachGrant = z.infer<typeof attachGrantSchema>;
export interface AttachCodeStore {
  put(key: string, grant: AttachGrant, ttl: number): Promise<boolean>;
  take(key: string): Promise<AttachGrant | null>;
  limit(key: string, maximum: number, seconds: number): Promise<boolean>;
}
export const attachCodeHash = (code: string) =>
  createHash("sha256").update(code).digest("hex");

/** Gateway Redis only; plaintext codes never enter storage or application logs. */
export class RedisAttachCodeStore implements AttachCodeStore {
  constructor(
    private readonly redis: Redis,
    private readonly prefix = "tellymcp:terminal-attach:",
  ) {}
  async put(key: string, grant: AttachGrant, ttl: number) {
    return (
      (await this.redis.set(
        this.prefix + "code:" + key,
        JSON.stringify(grant),
        "EX",
        ttl,
        "NX",
      )) === "OK"
    );
  }
  async take(key: string) {
    const raw = await this.redis.getdel(this.prefix + "code:" + key);
    return raw ? attachGrantSchema.parse(JSON.parse(raw)) : null;
  }
  async limit(key: string, maximum: number, seconds: number) {
    const count = await this.redis.eval(
      "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],ARGV[1]); end; return n",
      1,
      this.prefix + "rate:" + attachCodeHash(key),
      seconds,
    );
    return Number(count) <= maximum;
  }
}

export async function mintAttachCode(
  store: AttachCodeStore,
  grant: AttachGrant,
): Promise<string> {
  for (let tries = 0; tries < 8; tries++) {
    const code = String(randomInt(100000000)).padStart(8, "0");
    if (await store.put(attachCodeHash(code), grant, ATTACH_CODE_TTL_SECONDS))
      return code;
  }
  throw new Error("Could not allocate attach code; try again");
}
