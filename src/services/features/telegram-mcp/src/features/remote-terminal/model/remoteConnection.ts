import { Duplex } from "node:stream";
import WebSocket from "ws";
import { z } from "zod";
import {
  FrameDecoder,
  LocalWriter,
} from "../../detached-terminal/model/localProtocol";
import {
  getTellyWebSocketAgent,
  type TellyProxySettings,
} from "../../../shared/lib/http/tellyProxy";
import { REMOTE_QUEUE_LIMIT } from "./remoteProtocol";

export function attachEndpoint(gateway: string, websocketBase = false): string {
  const url = new URL(gateway);
  if (url.username || url.password || url.search || url.hash)
    throw new Error(
      "Use a gateway URL without credentials or query parameters",
    );
  if (!["https:", "wss:", "http:", "ws:"].includes(url.protocol))
    throw new Error("Invalid gateway protocol");
  if (
    (url.protocol === "http:" || url.protocol === "ws:") &&
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  )
    throw new Error("Remote attach requires HTTPS/WSS");
  url.protocol =
    url.protocol === "https:" || url.protocol === "wss:" ? "wss:" : "ws:";
  const base = url.pathname.replace(/\/+$/u, "");
  url.pathname = base.endsWith("/attach")
    ? base
    : (websocketBase || base.endsWith("/ws") ? base : base + "/ws") + "/attach";
  return url.toString();
}

/** Backpressure is bounded by stream high-water marks and websocket bufferedAmount. */
class GatewayTerminalStream extends Duplex {
  constructor(private readonly websocket: WebSocket) {
    super({ highWaterMark: 65536 });
    this.on("error", () => {}); // Handshake may finish before the renderer subscribes.
    websocket.on("message", (raw, binary) => {
      if (!binary) {
        this.destroy(
          new Error(
            "Gateway ended the attachment; generate a fresh code to reconnect",
          ),
        );
        return;
      }
      const data = Buffer.isBuffer(raw)
        ? raw
        : Buffer.concat(Array.isArray(raw) ? raw : [Buffer.from(raw)]);
      if (!this.push(data)) websocket.pause();
    });
    websocket.on("close", () => {
      this.push(null);
      if (!this.writableEnded) this.end();
    });
    websocket.on("error", () =>
      this.destroy(
        new Error("Gateway connection lost; generate a fresh attach code"),
      ),
    );
  }
  _read() {
    this.websocket.resume();
  }
  _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    if (
      this.websocket.readyState !== 1 ||
      this.websocket.bufferedAmount + chunk.length > REMOTE_QUEUE_LIMIT
    ) {
      callback(new Error("Gateway stream unavailable or overloaded"));
      return;
    }
    this.websocket.send(chunk, { binary: true }, callback);
  }
  _final(callback: (error?: Error | null) => void) {
    this.websocket.close();
    callback();
  }
  _destroy(error: Error | null, callback: (error?: Error | null) => void) {
    this.websocket.terminate();
    callback(error);
  }
}

export function connectGatewayTerminal(
  endpoint: string,
  code: string,
  proxy?: TellyProxySettings,
): Promise<{
  instance: string;
  socket: Duplex;
  writer: LocalWriter;
  decoder: FrameDecoder;
}> {
  if (!/^\d{8}$/u.test(code))
    throw new Error("Use the 8-digit attach code from Telegram Live");
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(endpoint, {
      agent: getTellyWebSocketAgent(endpoint, proxy),
      maxPayload: 65541,
      perMessageDeflate: false,
    });
    let settled = false;
    const fail = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.terminate();
      reject(
        new Error(
          "Cannot attach: code invalid, expired or used, session unavailable, or gateway not updated. Generate a new code from Live.",
        ),
      );
    };
    const timer = setTimeout(fail, 12000);
    ws.on("error", fail);
    ws.once("close", fail);
    ws.once("open", () => ws.send(JSON.stringify({ type: "redeem", code })));
    ws.once("message", (raw, binary) => {
      try {
        if (binary) throw new Error("Invalid gateway handshake");
        const ready = z
          .object({
            type: z.literal("ready"),
            protocol: z.literal(1),
            instance: z.uuid(),
          })
          .strict()
          .parse(JSON.parse(raw.toString()));
        settled = true;
        clearTimeout(timer);
        ws.off("error", fail);
        ws.off("close", fail);
        const socket = new GatewayTerminalStream(ws);
        resolve({
          instance: ready.instance,
          socket,
          writer: new LocalWriter(socket),
          decoder: new FrameDecoder(),
        });
      } catch {
        fail();
      }
    });
  });
}
