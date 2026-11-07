import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";

import type { IPty } from "node-pty";
import * as XtermHeadless from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";

import { currentSgr, serializeTerminalState } from "./terminalSnapshot";
import { isTerminalQuery, VtOutput } from "./vtOutput";

export type RestorationSnapshot = {
  instance: string;
  generation: number;
  sequence: number;
  cols: number;
  rows: number;
  ansi: string;
};
export type RestorationFrame = { sequence: number; data: string };
type Attachment = {
  generation: number;
  ready: boolean;
  frames: RestorationFrame[];
  bytes: number;
  decoder: StringDecoder;
};
export type PrototypeAttachment = {
  snapshot: RestorationSnapshot;
  acknowledge(): void;
  drain(): RestorationFrame[];
  write(data: string | Buffer): void;
  resize(cols: number, rows: number): Promise<void>;
  detach(): void;
};

function validateSize(cols: number, rows: number): void {
  if (
    ![cols, rows].every((v) => Number.isSafeInteger(v) && v >= 2 && v <= 500)
  ) {
    throw new Error("Prototype terminal dimensions must be integers in 2..500");
  }
}

/** Ordered terminal state/I/O. Process and transport lifetime belong to its caller. */
export class TerminalRestorationPrototype {
  readonly instance = randomUUID();
  private readonly terminal: InstanceType<typeof XtermHeadless.Terminal>;
  private readonly addon = new SerializeAddon();
  private readonly output = new VtOutput();
  private readonly subscriptions: Array<{ dispose(): void }>;
  private pipeline = Promise.resolve();
  private attachment: Attachment | undefined;
  private generation = 0;
  private sequence = 0;
  private pendingBytes = 0;
  private pendingOperations = 0;
  private failure: Error | undefined;
  private disposed = false;
  private ptyClosed = false;
  private readonly ownsTerminal: boolean;
  private readonly observers = new Set<(data: string) => void>();
  private exit: { exitCode: number; signal?: number } | undefined;

  constructor(
    private readonly pty: IPty,
    options: {
      cols: number;
      rows: number;
      scrollback?: number;
      maxQueueBytes?: number;
      terminal?: InstanceType<typeof XtermHeadless.Terminal>;
    },
  ) {
    validateSize(options.cols, options.rows);
    this.maxQueueBytes = options.maxQueueBytes ?? 1024 * 1024;
    if (!Number.isSafeInteger(this.maxQueueBytes) || this.maxQueueBytes < 1024)
      throw new Error("Invalid queue limit");
    const scrollback = options.scrollback ?? 500;
    if (
      !Number.isSafeInteger(scrollback) ||
      scrollback < 0 ||
      scrollback > 5000
    )
      throw new Error("Invalid scrollback limit");
    this.ownsTerminal = !options.terminal;
    this.terminal =
      options.terminal ??
      new XtermHeadless.Terminal({
        cols: options.cols,
        rows: options.rows,
        scrollback,
        allowProposedApi: true,
        windowOptions: { getWinSizeChars: true },
      });
    this.terminal.options.windowOptions = { getWinSizeChars: true };
    this.terminal.loadAddon(this.addon);
    // One query authority for the full lifetime, independent of attachment ACKs.
    this.terminal.parser.registerCsiHandler({ final: "c" }, (params) => {
      if (params[0] === 0) this.reply("\x1b[?1;0c"); // VT101, no optional capabilities advertised.
      return true;
    });
    this.terminal.parser.registerDcsHandler(
      { intermediates: "$", final: "q" },
      (value) => {
        if (value !== "m") return false;
        this.reply(`\x1bP1$r${currentSgr(this.terminal)}\x1b\\`);
        return true;
      },
    );
    for (const [id, color] of [
      [10, "ffff/ffff/ffff"],
      [11, "0000/0000/0000"],
      [12, "ffff/ffff/ffff"],
    ] as const) {
      this.terminal.parser.registerOscHandler(id, (value) => {
        if (value === "?") this.reply(`\x1b]${id};rgb:${color}\x1b\\`);
        // This prototype has a fixed palette; dynamic palette mutation is unsupported.
        return true;
      });
    }
    this.subscriptions = [
      this.terminal.onData((data) => {
        this.reply(data);
      }),
      pty.onData((data) => {
        this.acceptOutput(data);
      }),
      pty.onExit((info) => {
        this.ptyClosed = true;
        this.pipeline = this.pipeline.then(() => {
          this.exit = info;
        });
      }),
    ];
  }

  private readonly maxQueueBytes: number;

  private reply(data: string): void {
    if (this.ptyClosed || this.disposed || this.failure) return;
    try {
      this.pty.write(data);
    } catch (error) {
      this.fail(error);
    }
  }

  private fail(error: unknown): void {
    this.failure ??= error instanceof Error ? error : new Error(String(error));
    this.attachment = undefined;
  }

  get status() {
    return {
      pid: this.pty.pid,
      sequence: this.sequence,
      exit: this.exit,
      failure: this.failure?.message,
    };
  }

  private assertRunning(): void {
    if (this.disposed) throw new Error("Prototype disposed");
    if (this.failure) throw this.failure;
    if (this.exit) throw new Error(`PTY exited: ${this.exit.exitCode}`);
  }

  private enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.pipeline.then(() => {
      this.assertRunning();
      return operation();
    });
    // A rejected caller operation must not poison the queue. Output faults are
    // retained by acceptOutput instead of becoming unhandled event rejections.
    this.pipeline = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  private acceptOutput(data: string): void {
    if (this.disposed || this.failure || this.exit) return;
    const bytes = Buffer.byteLength(data);
    this.pendingBytes += bytes;
    this.pendingOperations++;
    if (
      this.pendingBytes > 4 * this.maxQueueBytes ||
      this.pendingOperations > 4096
    ) {
      this.failure = new Error("Prototype parser queue overflow");
      this.attachment = undefined;
      return;
    }
    void this.enqueue(async () => {
      try {
        const tokens = this.output.push(data);
        const complete = tokens.map((token) => token.data).join("");
        if (!complete) return;
        await new Promise<void>((resolve) => {
          this.terminal.write(complete, resolve);
        });
        this.sequence++;
        const display = tokens
          .filter((token) => !isTerminalQuery(token))
          .map((token) => token.data)
          .join("");
        const current = this.attachment;
        for (const observer of this.observers) {
          try {
            observer(display);
          } catch {
            this.observers.delete(observer);
          }
        }
        if (current) {
          const frameBytes = Buffer.byteLength(display);
          if (
            current.bytes + frameBytes > this.maxQueueBytes ||
            current.frames.length >= 4096
          ) {
            this.attachment = undefined; // Slow consumer must get a fresh snapshot.
          } else {
            current.frames.push({ sequence: this.sequence, data: display });
            current.bytes += frameBytes;
          }
        }
      } finally {
        this.pendingBytes -= bytes;
        this.pendingOperations--;
      }
    }).catch((error: unknown) => {
      this.fail(error);
    });
  }

  async settled(): Promise<void> {
    await this.pipeline;
    if (this.failure) throw this.failure;
  }

  subscribeOutput(observer: (data: string) => void): () => void {
    this.observers.add(observer);
    return () => {
      this.observers.delete(observer);
    };
  }

  resize(cols: number, rows: number): Promise<void> {
    validateSize(cols, rows);
    return this.enqueue(() => {
      this.terminal.resize(cols, rows);
      this.pty.resize(cols, rows);
    });
  }

  async attach(cols: number, rows: number): Promise<PrototypeAttachment> {
    validateSize(cols, rows);
    this.assertRunning();
    if (this.attachment) throw new Error("Controller already attached");
    const current: Attachment = {
      generation: ++this.generation,
      ready: false,
      frames: [],
      bytes: 0,
      decoder: new StringDecoder("utf8"),
    };
    this.attachment = current; // Reserve synchronously, including while the snapshot waits.
    const check = () => {
      if (this.disposed) throw new Error("Prototype disposed");
      if (this.failure) throw this.failure;
      if (this.attachment !== current)
        throw new Error("Attachment expired; request a fresh snapshot");
    };
    try {
      const snapshot = await this.enqueue(() => {
        check();
        this.terminal.resize(cols, rows);
        this.pty.resize(cols, rows);
        current.frames = [];
        current.bytes = 0;
        const ansi = serializeTerminalState(this.terminal, this.addon);
        if (Buffer.byteLength(ansi) > 4 * this.maxQueueBytes)
          throw new Error("Prototype snapshot limit exceeded");
        return {
          instance: this.instance,
          generation: current.generation,
          sequence: this.sequence,
          cols,
          rows,
          ansi,
        };
      });
      check();
      return {
        snapshot,
        acknowledge: () => {
          check();
          current.ready = true;
        },
        drain: () => {
          check();
          if (!current.ready) throw new Error("Snapshot must be acknowledged");
          const frames = current.frames;
          current.frames = [];
          current.bytes = 0;
          return frames;
        },
        write: (data) => {
          check();
          this.assertRunning();
          if (this.ptyClosed) throw new Error("PTY closing");
          if (!current.ready) throw new Error("Snapshot must be acknowledged");
          const decoded =
            typeof data === "string"
              ? current.decoder.end() + data
              : current.decoder.write(data);
          if (decoded) this.pty.write(decoded);
        },
        resize: (newCols, newRows) => {
          check();
          this.assertRunning();
          if (this.ptyClosed) throw new Error("PTY closing");
          validateSize(newCols, newRows);
          if (!current.ready) throw new Error("Snapshot must be acknowledged");
          return this.enqueue(() => {
            check();
            this.terminal.resize(newCols, newRows);
            this.pty.resize(newCols, newRows);
          });
        },
        detach: () => {
          if (this.attachment === current) this.attachment = undefined;
        },
      };
    } catch (error) {
      if (this.attachment === current) this.attachment = undefined;
      throw error;
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    for (const subscription of this.subscriptions) subscription.dispose();
    await this.pipeline;
    this.disposed = true;
    this.attachment = undefined;
    this.observers.clear();
    if (this.ownsTerminal) this.terminal.dispose(); // Never kill the caller's PTY.
  }
}
