/** Manual fidelity harness. Intentionally independent of the public CLI/runtime. */
import { spawn } from "node-pty";

import {
  TerminalRestorationPrototype,
  type PrototypeAttachment,
} from "../src/services/features/telegram-mcp/src/features/detached-terminal/model/terminalRestorationPrototype";

async function main(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error("Run this prototype in an interactive terminal");
  const size = () => ({
    cols: Math.min(500, Math.max(2, process.stdout.columns)),
    rows: Math.min(500, Math.max(2, process.stdout.rows)),
  });
  const dimensions = size();
  const pty = spawn("/bin/bash", ["--noprofile", "--norc", "-i"], {
    ...dimensions,
    cwd: process.cwd(),
    name: "xterm-256color",
    env: { ...process.env },
  });
  const model = new TerminalRestorationPrototype(pty, dimensions);
  let attachment: PrototypeAttachment | undefined;
  let attaching = false;
  let finished = false;
  let busy = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const originalRaw = process.stdin.isRaw;
  const print = (data: string) =>
    new Promise<void>((resolve, reject) => {
      process.stdout.write(data, (error) =>
        error ? reject(error) : resolve(),
      );
    });
  const cleanupModes =
    "\x1b[?1049l\x1b[0m\x1b[?25h\x1b[?1l\x1b>\x1b[?2004l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1004l\x1b[?1006l\x1b[?1016l\x1b[r\x1b[?6l\x1b[?7h";

  const detach = () => {
    attachment?.detach();
    attachment = undefined;
    process.stdout.write(
      `${cleanupModes}\r\n[prototype detached; shell PID ${pty.pid}; a = attach, q = stop]\r\n`,
    );
  };
  const attach = async () => {
    if (attaching || attachment || finished) return;
    attaching = true;
    try {
      const current = size();
      const next = await model.attach(current.cols, current.rows);
      await print(next.snapshot.ansi);
      next.acknowledge();
      attachment = next;
    } finally {
      attaching = false;
    }
  };

  const onInput = (data: Buffer) => {
    if (attaching) return;
    if (!attachment) {
      if (data.includes(0x71)) void finish(0);
      else if (data.includes(0x61))
        void attach().catch((error: unknown) => finish(1, error));
      return;
    }
    const prefix = data.indexOf(0x1d); // Ctrl+] is reserved by this harness only.
    try {
      if (prefix < 0) attachment.write(data);
      else {
        attachment.write(data.subarray(0, prefix));
        detach();
      }
    } catch (error) {
      void finish(1, error);
    }
  };
  const onResize = () => {
    if (!attachment) return;
    const current = size();
    void attachment
      .resize(current.cols, current.rows)
      .catch((error: unknown) => finish(1, error));
  };
  const onSigterm = () => {
    void finish(143);
  };
  const onSigint = () => {
    void finish(130);
  };
  const fdError = (error: NodeJS.ErrnoException) => {
    if (error.code !== "EIO" || error.syscall !== "read") void finish(1, error);
  };
  const finish = async (code: number, error?: unknown) => {
    if (finished) return;
    finished = true;
    if (timer) clearInterval(timer);
    process.stdin.off("data", onInput);
    process.stdout.off("resize", onResize);
    process.off("SIGTERM", onSigterm);
    process.off("SIGINT", onSigint);
    process.stdin.setRawMode(originalRaw);
    process.stdin.pause();
    await model.dispose();
    if (!model.status.exit) pty.kill();
    process.stdout.write(cleanupModes + "\r\n");
    if (error)
      console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = code;
  };
  (pty as unknown as { on(event: string, fn: typeof fdError): void }).on(
    "error",
    fdError,
  );
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", onInput);
  process.stdout.on("resize", onResize);
  process.on("SIGTERM", onSigterm);
  process.on("SIGINT", onSigint);
  try {
    await attach();
    timer = setInterval(() => {
      if (busy || finished) return;
      busy = true;
      void (async () => {
        if (model.status.failure) throw new Error(model.status.failure);
        if (attachment) {
          let frames;
          try {
            frames = attachment.drain();
          } catch {
            detach();
            return;
          }
          for (const frame of frames) await print(frame.data);
        }
        if (model.status.exit) await finish(model.status.exit.exitCode);
      })()
        .catch((error: unknown) => finish(1, error))
        .finally(() => {
          busy = false;
        });
    }, 10);
  } catch (error) {
    await finish(1, error);
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
