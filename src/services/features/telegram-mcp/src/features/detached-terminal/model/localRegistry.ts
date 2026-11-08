import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "../../../shared/lib/sqlite";
import { z } from "zod";

import { LOCAL_PROTOCOL_VERSION } from "./localProtocol";

const absolute = z.string().max(4096).refine(path.isAbsolute);
export const ownerSpecSchema = z
  .object({
    cwd: absolute,
    envPath: absolute,
    packageRoot: absolute,
    clientUuid: z.uuid(),
    sessionId: z.string().min(1).max(200),
    sessionLabel: z.string().min(1).max(200),
    agentId: z.enum(["codex", "claude"]).optional(),
    browserWsPort: z.number().int().min(1).max(65535).optional(),
    startupHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .optional(),
  })
  .strict();
export type OwnerSpec = z.infer<typeof ownerSpecSchema>;
export const ownerRecordSchema = z
  .object({
    version: z.literal(1),
    protocol: z.union([z.literal(1), z.literal(LOCAL_PROTOCOL_VERSION)]),
    instance: z.uuid(),
    packageVersion: z.string().min(1).max(100),
    pid: z.number().int().positive(),
    processStart: z.string().min(1).max(200),
    clientUuid: z.uuid(),
    sessionId: z.string().min(1).max(200),
    sessionLabel: z.string().min(1).max(200),
    cwd: absolute,
    envPath: absolute,
    socketPath: absolute,
    createdAt: z.string(),
    state: z.enum(["starting", "ready"]),
    agentId: z.enum(["codex", "claude"]).optional(),
    browserWsPort: z.number().int().min(1).max(65535).optional(),
    startupHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .optional(),
  })
  .strict();
export type OwnerRecord = z.infer<typeof ownerRecordSchema>;
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex").slice(0, 24);

export function processStartIdentity(pid: number): string | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    if (fields[0] === "Z") return null;
    const start = fields[19];
    if (!start || !/^\d+$/u.test(start))
      throw new Error("Invalid Linux process identity");
    return `${fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()}:${start}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error; // Permission errors are ambiguous, never evidence of a dead owner.
  }
}

export class LocalRegistry {
  readonly root: string;
  constructor(root = path.join(os.tmpdir(), `tellymcp-${process.getuid?.()}`)) {
    if (process.platform !== "linux" || !process.getuid)
      throw new Error("Detached session owners currently require Linux");
    this.root = path.resolve(root);
    try {
      fs.mkdirSync(this.root, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const stat = fs.lstatSync(this.root);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.uid !== process.getuid() ||
      stat.mode & 0o077
    )
      throw new Error("Unsafe local session registry permissions");
    if (Buffer.byteLength(path.join(this.root, "s-" + "x".repeat(36))) > 100)
      throw new Error("Local registry path is too long for Unix sockets");
  }

  private checkedFile(file: string): boolean {
    try {
      const stat = fs.lstatSync(file);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.uid !== process.getuid!() ||
        stat.mode & 0o077 ||
        stat.size > 65536
      )
        throw new Error("Unsafe registry file");
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  private locked<T>(operation: () => T): T {
    const file = path.join(this.root, "registry.sqlite");
    if (!this.checkedFile(file)) {
      try {
        fs.closeSync(fs.openSync(file, "wx", 0o600));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    this.checkedFile(file);
    const db = new DatabaseSync(file);
    try {
      db.exec("PRAGMA busy_timeout=3000; BEGIN IMMEDIATE");
      try {
        const result = operation();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    } finally {
      db.close();
    }
  }

  /** Serialize only the launcher's synchronous marker read/modify/write. */
  updateWorkspaceIdentity<T>(
    operation: (find: (spec: OwnerSpec) => OwnerRecord | null) => T,
  ): T {
    return this.locked(() => operation((spec) => this.findUnlocked(spec)));
  }

  private claimPaths(
    record: Pick<OwnerRecord, "cwd" | "sessionId" | "clientUuid">,
  ): string[] {
    return [
      path.join(
        this.root,
        `c-${hash(`${record.clientUuid}:${record.sessionId}`)}.json`,
      ),
      path.join(
        this.root,
        `w-${hash(`${record.cwd}:${record.sessionId}`)}.json`,
      ),
    ];
  }
  private readyPath(record: OwnerRecord): string {
    return path.join(this.root, `o-${record.instance}.json`);
  }
  private read(file: string): OwnerRecord | null {
    if (!this.checkedFile(file)) return null;
    const record = ownerRecordSchema.parse(
      JSON.parse(fs.readFileSync(file, "utf8")),
    );
    if (record.socketPath !== path.join(this.root, `s-${record.instance}`))
      throw new Error("Invalid registry socket path");
    return record;
  }
  private write(file: string, record: OwnerRecord): void {
    const tmp = `${file}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(record), {
        mode: 0o600,
        flag: "wx",
      });
      fs.renameSync(tmp, file);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }

  find(spec: OwnerSpec): OwnerRecord | null {
    return this.locked(() => this.findUnlocked(spec));
  }

  private findUnlocked(spec: OwnerSpec): OwnerRecord | null {
    const canonical = { ...spec, cwd: fs.realpathSync(spec.cwd) };
    const records = this.claimPaths(canonical)
      .map((file) => this.read(file))
      .filter((v): v is OwnerRecord => !!v);
    if (new Set(records.map((v) => v.instance)).size > 1)
      throw new Error("Ambiguous local owner claims");
    const record = records[0];
    if (!record) return null;
    if (
      (record.cwd !== canonical.cwd ||
        record.clientUuid !== spec.clientUuid ||
        record.sessionId !== spec.sessionId) &&
      processStartIdentity(record.pid) === record.processStart
    )
      throw new Error(
        "Console identity is already claimed by another workspace or owner",
      );
    return record;
  }

  createRecord(spec: OwnerSpec, packageVersion: string): OwnerRecord {
    const instance = randomUUID();
    return ownerRecordSchema.parse({
      ...Object.fromEntries(
        ["cwd", "envPath", "clientUuid", "sessionId", "sessionLabel"].map(
          (key) => [key, spec[key as keyof OwnerSpec]],
        ),
      ),
      cwd: fs.realpathSync(spec.cwd),
      version: 1,
      protocol: LOCAL_PROTOCOL_VERSION,
      packageVersion,
      instance,
      pid: process.pid,
      processStart: processStartIdentity(process.pid),
      socketPath: path.join(this.root, `s-${instance}`),
      state: "starting",
      createdAt: new Date().toISOString(),
      ...(spec.agentId ? { agentId: spec.agentId } : {}),
      ...(spec.browserWsPort !== undefined
        ? { browserWsPort: spec.browserWsPort }
        : {}),
      ...(spec.startupHash ? { startupHash: spec.startupHash } : {}),
    });
  }

  reserve(record: OwnerRecord): void {
    this.locked(() => {
      if (this.claimPaths(record).some((file) => this.read(file)))
        throw new Error("Session already claimed");
      try {
        for (const file of this.claimPaths(record)) this.write(file, record);
      } catch (error) {
        for (const file of this.claimPaths(record))
          if (this.read(file)?.instance === record.instance) fs.rmSync(file);
        throw error;
      }
    });
  }

  publish(record: OwnerRecord): void {
    this.locked(() => {
      if (
        this.claimPaths(record).some(
          (file) => this.read(file)?.instance !== record.instance,
        )
      )
        throw new Error("Owner lost startup claim");
      record.state = "ready";
      for (const file of this.claimPaths(record)) this.write(file, record);
      this.write(this.readyPath(record), record);
    });
  }

  list(): OwnerRecord[] {
    return this.locked(() =>
      fs
        .readdirSync(this.root)
        .filter((name) => /^o-[a-f0-9-]+\.json$/u.test(name))
        .map((name) => this.read(path.join(this.root, name)))
        .filter((v): v is OwnerRecord => !!v),
    );
  }

  /** Probe asynchronously first, then recheck identity and claim under the OS-backed lock. */
  async recover(
    record: OwnerRecord,
    probe: (record: OwnerRecord) => Promise<boolean>,
  ): Promise<boolean> {
    if (
      processStartIdentity(record.pid) === record.processStart ||
      (await probe(record))
    )
      return false;
    return this.locked(() => {
      if (processStartIdentity(record.pid) === record.processStart)
        return false;
      const paths = this.claimPaths(record);
      if (
        paths.some((file) => {
          const current = this.read(file);
          return current && current.instance !== record.instance;
        })
      )
        return false;
      this.removeFiles(record);
      return true;
    });
  }
  private removeFiles(record: OwnerRecord): void {
    for (const file of [...this.claimPaths(record), this.readyPath(record)])
      if (this.read(file)?.instance === record.instance)
        fs.rmSync(file, { force: true });
    // The pathname embeds an unguessable instance and lies in the private registry.
    if (
      path.dirname(record.socketPath) === this.root &&
      path.basename(record.socketPath) === `s-${record.instance}`
    )
      fs.rmSync(record.socketPath, { force: true });
  }
  release(record: OwnerRecord): void {
    this.locked(() => {
      this.removeFiles(record);
    });
  }
}
