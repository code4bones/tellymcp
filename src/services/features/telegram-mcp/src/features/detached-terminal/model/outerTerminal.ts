import { execFileSync } from "node:child_process";
import type { ReadStream, WriteStream } from "node:tty";

const modes = [
  1, 6, 7, 9, 12, 25, 45, 66, 1000, 1002, 1003, 1004, 1005, 1006, 1015, 1016,
  2004,
];
export const OUTER_MODE_QUERY =
  modes.map((id) => "\x1b[?" + id + "$p").join("") +
  "\x1b[4$p\x1b[20$p\x1bP$q q\x1b\\\x1bP$qm\x1b\\\x1bP$qr\x1b\\";
const fallback =
  "\x1b[?1049l\x1b[?47l\x1b[0m\x1b(B\x1b)B\x0f\x1b[?6l\x1b[r" +
  "\x1b[4l\x1b[20l\x1b[?1l\x1b>\x1b[?45l\x1b[?7h\x1b[?25h\x1b[2 q" +
  [9, 1000, 1002, 1003, 1004, 1005, 1006, 1015, 1016, 2004]
    .map((id) => "\x1b[?" + id + "l")
    .join("");

/** Consume our ASCII status replies even when late/split; preserve pasted bytes. */
class OuterReplyFilter {
  private pending: number[] = [];
  private paste = false;
  constructor(private readonly reply: (token: string) => boolean) {}
  flushEscape(): Buffer {
    if (this.pending.length > 2) return Buffer.alloc(0);
    const bytes = Buffer.from(this.pending);
    this.pending = [];
    return bytes;
  }
  push(data: Buffer): Buffer {
    const out: number[] = [];
    for (const byte of data) {
      if (!this.pending.length && byte !== 0x1b) {
        out.push(byte);
        continue;
      }
      this.pending.push(byte);
      const intro = this.pending[1];
      if (intro === undefined) continue;
      if (
        intro === 0x50 &&
        this.pending.length >= 3 &&
        ((this.pending.length === 3 && ![0x30, 0x31].includes(byte)) ||
          (this.pending.length === 4 && byte !== 0x24) ||
          (this.pending.length === 5 && byte !== 0x72))
      ) {
        out.push(...this.pending);
        this.pending = [];
        continue;
      }
      const complete =
        (this.paste && intro !== 0x5b) ||
        (byte < 0x20 && byte !== 0x1b) ||
        (intro === 0x5b
          ? this.pending.length > 2 && byte >= 0x40 && byte <= 0x7e
          : intro === 0x50
            ? this.pending.length > 3 &&
              this.pending.at(-2) === 0x1b &&
              byte === 0x5c
            : true);
      if (!complete && this.pending.length < 1024) continue;
      const token = Buffer.from(this.pending).toString("latin1");
      if (token === "\x1b[200~") this.paste = true;
      const consumed = !this.paste && this.reply(token);
      if (!consumed) out.push(...this.pending);
      if (token === "\x1b[201~") this.paste = false;
      this.pending = [];
    }
    return Buffer.from(out);
  }
}

/** A short bounded probe consumes only replies to our own mode/status queries. */
export class OuterModeProbe {
  private bytes: Buffer[] = [];
  private length = 0;
  private restoreModes = "";
  private attributes = "";
  private region = "";
  private cursor = "";
  private readonly filter = new OuterReplyFilter((token) =>
    this.observe(token),
  );
  get restore(): string {
    return (
      fallback + this.region + this.restoreModes + this.cursor + this.attributes
    );
  }
  filterInput(data: Buffer): Buffer {
    return this.filter.push(data);
  }
  flushEscape(): Buffer {
    return this.filter.flushEscape();
  }
  push(data: Buffer): void {
    this.length += data.length;
    if (this.length > 262144)
      throw new Error("Input limit exceeded while restoring terminal state");
    this.bytes.push(this.filter.push(data));
  }
  private observe(token: string): boolean {
    // eslint-disable-next-line no-control-regex -- parse terminal status replies.
    const mode = /^\x1b\[(\??)(\d+);([0-4])\$y$/u.exec(token);
    if (mode) {
      const id = Number(mode[2]),
        state = Number(mode[3]);
      if (!(mode[1] ? modes.includes(id) : [4, 20].includes(id))) return false;
      if (state)
        this.restoreModes +=
          "\x1b[" + mode[1] + id + ([1, 3].includes(state) ? "h" : "l");
      if (this.restoreModes.length > 8192)
        throw new Error("Excess terminal mode replies");
      return true;
    }
    // eslint-disable-next-line no-control-regex -- parse DECRQSS replies.
    const status = /^\x1bP([01])\$r([\d;:]*m|[0-6] q|\d+;\d+r)?\x1b\\$/u.exec(
      token,
    );
    if (status) {
      const value = status[2];
      if (status[1] === "1" && value && value.length < 200) {
        if (value.endsWith("m")) this.attributes = "\x1b[" + value;
        else if (value.endsWith("r")) this.region = "\x1b[" + value;
        else this.cursor = "\x1b[" + value;
      }
      return true;
    }
    return false;
  }
  finish(): { restore: string; input: Buffer } {
    const input = Buffer.concat(this.bytes);
    this.bytes = [];
    this.length = 0;
    return { restore: this.restore, input };
  }
}

/** Save exact termios; raw input alone does not disable ONLCR on Linux. */
export function prepareOuterTerminal(
  stdin: ReadStream & { fd: number },
  stdout: WriteStream,
): { restoreModes: (value: string) => void; restore: () => void } {
  const fd = stdin.fd;
  const saved = execFileSync("stty", ["-g"], {
    stdio: [fd, "pipe", "ignore"],
    timeout: 1000,
  })
    .toString()
    .trim();
  const wasRaw = stdin.isRaw;
  let sequence = fallback,
    restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    try {
      stdout.write(sequence + "\r\n");
    } catch {
      /* stdout may have failed */
    }
    try {
      stdin.setRawMode(wasRaw);
    } finally {
      execFileSync("stty", [saved], {
        stdio: [fd, "ignore", "ignore"],
        timeout: 1000,
      });
    }
  };
  try {
    stdin.setRawMode(true);
    execFileSync("stty", ["-opost"], {
      stdio: [fd, "ignore", "ignore"],
      timeout: 1000,
    });
  } catch (error) {
    restore();
    throw error;
  }
  return {
    restoreModes: (value) => {
      sequence = value;
    },
    restore,
  };
}
