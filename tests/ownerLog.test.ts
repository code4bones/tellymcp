import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import boundedOwnerLog from "../src/lib/pinoTargets";

it("bounds the private owner journal and its rotation, including a huge log record", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telly-log-"));
  const destination = path.join(root, "owner.log");
  const log = boundedOwnerLog({ destination, maxBytes: 128 });
  const write = (data: string) =>
    new Promise<void>((resolve, reject) =>
      log.write(data, (error) => (error ? reject(error) : resolve())),
    );
  try {
    for (let i = 0; i < 10; i++) await write("x".repeat(80));
    await write("y".repeat(10000));
    for (const file of [destination, destination + ".1"]) {
      expect(fs.statSync(file).size).toBeLessThanOrEqual(128);
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    }
  } finally {
    log.end();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
