import { z } from "zod";
import type WebSocket from "ws";

export const REMOTE_QUEUE_LIMIT = 5 * 1024 * 1024;
export const RELAY_CHUNK_BYTES = 32768;
const id = z.uuid();
const target = { clientUuid: id, sessionId: z.string().min(1).max(200) };
export const terminalMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("terminal_describe"), id, ...target }).strict(),
  z
    .object({ type: z.literal("terminal_described"), id, instance: id })
    .strict(),
  z
    .object({ type: z.literal("terminal_open"), id, ...target, instance: id })
    .strict(),
  z.object({ type: z.literal("terminal_ready"), id, instance: id }).strict(),
  z
    .object({
      type: z.literal("terminal_data"),
      id,
      data: z.string().max(44000),
    })
    .strict(),
  z.object({ type: z.literal("terminal_end"), id }).strict(),
  z.object({ type: z.literal("terminal_keepalive"), id }).strict(),
  z
    .object({ type: z.literal("terminal_error"), id, code: z.string().max(80) })
    .strict(),
]);
export type TerminalMessage = z.infer<typeof terminalMessageSchema>;

export function readTerminalMessage(raw: unknown): TerminalMessage | null {
  const value: unknown = JSON.parse(String(raw));
  if (
    !value ||
    typeof value !== "object" ||
    !("type" in value) ||
    typeof value.type !== "string" ||
    !value.type.startsWith("terminal_")
  )
    return null;
  return terminalMessageSchema.parse(value);
}

export function relayBytes(data: string): Buffer {
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      data,
    )
  )
    throw new Error("Invalid terminal payload");
  const bytes = Buffer.from(data, "base64");
  if (!bytes.length || bytes.length > RELAY_CHUNK_BYTES)
    throw new Error("Invalid terminal payload size");
  return bytes;
}

export function sendTerminalMessage(
  socket: WebSocket,
  message: TerminalMessage,
): void {
  const data = JSON.stringify(message);
  if (
    socket.readyState !== 1 ||
    socket.bufferedAmount + Buffer.byteLength(data) > REMOTE_QUEUE_LIMIT
  )
    throw new Error("Terminal relay unavailable or overloaded");
  socket.send(data);
}
