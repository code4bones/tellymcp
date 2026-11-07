import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import WebSocket, { WebSocketServer } from "ws";
import { z } from "zod";
import {
  attachCodeHash,
  ATTACH_CODE_TTL_SECONDS,
  mintAttachCode,
  type AttachCodeStore,
  type AttachGrant,
} from "./attachCodes";
import {
  readTerminalMessage,
  relayBytes,
  RELAY_CHUNK_BYTES,
  REMOTE_QUEUE_LIMIT,
  sendTerminalMessage,
} from "./remoteProtocol";

const redemptionSchema = z
  .object({ type: z.literal("redeem"), code: z.string().regex(/^\d{8}$/u) })
  .strict();
type Target = { clientUuid: string; sessionId: string };
type Viewer = {
  id: string;
  socket: WebSocket;
  backend?: WebSocket;
  grant?: AttachGrant;
  ready: boolean;
  authenticating: boolean;
  alive: boolean;
  timer: NodeJS.Timeout;
};
type Description = {
  backend: WebSocket;
  timer: NodeJS.Timeout;
  resolve: (instance: string) => void;
  reject: (error: Error) => void;
};

/** Account proof comes only from the bot. Redeem carries a code, never a target or owner. */
export class GatewayTerminalAttach {
  private readonly server = new WebSocketServer({
    noServer: true,
    maxPayload: 65541,
    perMessageDeflate: false,
  });
  private readonly viewers = new Map<string, Viewer>();
  private readonly descriptions = new Map<string, Description>();
  private readonly heartbeat: NodeJS.Timeout;
  constructor(
    private readonly input: {
      path: string;
      codes: AttachCodeStore;
      ownedTarget: (
        telegramUserId: number,
        sessionId: string,
      ) => Promise<Target | null>;
      ownerSocket: (clientUuid: string) => WebSocket | undefined;
      heartbeatMs?: number;
    },
  ) {
    this.server.on("connection", (socket, req) => this.connected(socket, req));
    this.heartbeat = setInterval(() => {
      for (const viewer of this.viewers.values()) {
        if (!viewer.alive) {
          this.end(viewer.id);
          continue;
        }
        viewer.alive = false;
        viewer.socket.ping();
        if (viewer.ready && viewer.backend) {
          try {
            sendTerminalMessage(viewer.backend, {
              type: "terminal_keepalive",
              id: viewer.id,
            });
          } catch {
            this.end(viewer.id);
          }
        }
      }
    }, input.heartbeatMs ?? 10000);
    this.heartbeat.unref();
  }
  upgrade(req: IncomingMessage, socket: Socket, head: Buffer): boolean {
    const url = new URL(req.url ?? "/", "http://gateway.local");
    if (url.pathname.replace(/\/+$/u, "") !== this.input.path) return false;
    // Credentials are accepted only in the first websocket message, never URLs.
    if (url.search || this.viewers.size >= 256) {
      socket.end(
        "HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
      );
      return true;
    }
    this.server.handleUpgrade(req, socket, head, (ws) =>
      this.server.emit("connection", ws, req),
    );
    return true;
  }
  private describe(backend: WebSocket, target: Target): Promise<string> {
    if (this.descriptions.size >= 128)
      throw new Error("Attach service is busy");
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.descriptions.delete(id);
        reject(new Error("Session owner did not respond"));
      }, 5000);
      this.descriptions.set(id, { backend, timer, resolve, reject });
      try {
        sendTerminalMessage(backend, {
          type: "terminal_describe",
          id,
          ...target,
        });
      } catch (error) {
        clearTimeout(timer);
        this.descriptions.delete(id);
        reject(
          error instanceof Error ? error : new Error("Session unavailable"),
        );
      }
    });
  }
  async issue(telegramUserId: number, sessionId: string) {
    if (!Number.isSafeInteger(telegramUserId) || telegramUserId <= 0)
      throw new Error("Telegram identity unavailable");
    if (!(await this.input.codes.limit("issue:" + telegramUserId, 5, 300)))
      throw new Error("Too many attach codes; try again later");
    const target = await this.input.ownedTarget(telegramUserId, sessionId);
    if (!target)
      throw new Error("Only the session owner can create an attach code");
    const backend = this.input.ownerSocket(target.clientUuid);
    if (!backend || backend.readyState !== 1)
      throw new Error("Session is offline");
    const instance = await this.describe(backend, target);
    const expiresAt = Date.now() + ATTACH_CODE_TTL_SECONDS * 1000;
    const code = await mintAttachCode(this.input.codes, {
      ...target,
      instance,
      telegramUserId,
      expiresAt,
    });
    return { code, expiresAt };
  }
  private connected(socket: WebSocket, req: IncomingMessage) {
    const id = randomUUID();
    const viewer: Viewer = {
      id,
      socket,
      ready: false,
      authenticating: false,
      alive: true,
      timer: setTimeout(() => this.end(id), 10000),
    };
    this.viewers.set(id, viewer);
    socket.on("pong", () => {
      viewer.alive = true;
    });
    socket.on("error", () => this.end(id));
    socket.on("close", () => this.end(id));
    socket.on("message", (raw, binary) => {
      void this.viewerMessage(
        viewer,
        raw,
        binary,
        req.socket.remoteAddress ?? "unknown",
      ).catch(() => this.end(id, "ATTACH_REJECTED"));
    });
  }
  private async viewerMessage(
    viewer: Viewer,
    raw: WebSocket.RawData,
    binary: boolean,
    address: string,
  ) {
    if (!this.viewers.has(viewer.id)) return;
    if (!viewer.grant) {
      if (binary || viewer.authenticating || raw.toString().length > 128)
        throw new Error("Invalid authentication");
      viewer.authenticating = true;
      const { code } = redemptionSchema.parse(JSON.parse(raw.toString()));
      if (
        !(await this.input.codes.limit("redeem:" + address, 10, 60)) ||
        !(await this.input.codes.limit("redeem:global", 100, 60))
      )
        throw new Error("Attach rate limit");
      const grant = await this.input.codes.take(attachCodeHash(code));
      if (!grant || grant.expiresAt <= Date.now())
        throw new Error("Invalid attach code");
      const target = await this.input.ownedTarget(
        grant.telegramUserId,
        grant.clientUuid + ":" + grant.sessionId,
      );
      if (
        !target ||
        target.clientUuid !== grant.clientUuid ||
        target.sessionId !== grant.sessionId
      )
        throw new Error("Session ownership changed");
      const backend = this.input.ownerSocket(grant.clientUuid);
      if (!backend || backend.readyState !== 1)
        throw new Error("Session offline");
      if ((await this.describe(backend, target)) !== grant.instance)
        throw new Error("Owner changed");
      if (!this.viewers.has(viewer.id)) return;
      viewer.grant = grant;
      viewer.backend = backend;
      sendTerminalMessage(backend, {
        type: "terminal_open",
        id: viewer.id,
        ...target,
        instance: grant.instance,
      });
      return;
    }
    if (!viewer.ready || !binary || !viewer.backend)
      throw new Error("Invalid terminal message");
    const bytes = Buffer.isBuffer(raw)
      ? raw
      : Buffer.concat(Array.isArray(raw) ? raw : [Buffer.from(raw)]);
    if (!bytes.length || bytes.length > 65541)
      throw new Error("Invalid terminal frame size");
    for (let offset = 0; offset < bytes.length; offset += RELAY_CHUNK_BYTES)
      sendTerminalMessage(viewer.backend, {
        type: "terminal_data",
        id: viewer.id,
        data: bytes
          .subarray(offset, offset + RELAY_CHUNK_BYTES)
          .toString("base64"),
      });
  }
  handle(backend: WebSocket, raw: unknown): boolean {
    const message = readTerminalMessage(raw);
    if (!message) return false;
    const pending = this.descriptions.get(message.id);
    if (pending && pending.backend === backend) {
      if (message.type === "terminal_described")
        pending.resolve(message.instance);
      else if (message.type === "terminal_error")
        pending.reject(
          new Error("This session does not support terminal attach"),
        );
      else return true;
      clearTimeout(pending.timer);
      this.descriptions.delete(message.id);
      return true;
    }
    const viewer = this.viewers.get(message.id);
    if (!viewer || viewer.backend !== backend) return true;
    try {
      if (message.type === "terminal_ready") {
        if (viewer.ready || viewer.grant?.instance !== message.instance)
          throw new Error("Owner mismatch");
        viewer.ready = true;
        clearTimeout(viewer.timer);
        viewer.socket.send(
          JSON.stringify({
            type: "ready",
            protocol: 1,
            instance: message.instance,
          }),
        );
      } else if (message.type === "terminal_data") {
        if (!viewer.ready) throw new Error("Terminal not ready");
        const bytes = relayBytes(message.data);
        if (viewer.socket.bufferedAmount + bytes.length > REMOTE_QUEUE_LIMIT)
          throw new Error("Slow viewer");
        viewer.socket.send(bytes, { binary: true });
      } else if (message.type === "terminal_end") this.end(viewer.id);
      else if (message.type === "terminal_error")
        this.end(viewer.id, "ATTACH_UNAVAILABLE");
    } catch {
      this.end(viewer.id, "ATTACH_UNAVAILABLE");
    }
    return true;
  }
  private end(id: string, error?: string) {
    const viewer = this.viewers.get(id);
    if (!viewer) return;
    this.viewers.delete(id);
    clearTimeout(viewer.timer);
    if (viewer.backend) {
      try {
        sendTerminalMessage(viewer.backend, { type: "terminal_end", id });
      } catch {
        /* lost owner */
      }
    }
    if (viewer.socket.readyState === 1) {
      if (error)
        viewer.socket.send(JSON.stringify({ type: "error", code: error }));
      viewer.socket.close(error ? 4003 : 1000);
      const reaper = setTimeout(() => viewer.socket.terminate(), 1000);
      reaper.unref();
    } else viewer.socket.terminate();
  }
  backendClosed(backend: WebSocket) {
    for (const viewer of this.viewers.values())
      if (viewer.backend === backend) this.end(viewer.id, "OWNER_DISCONNECTED");
    for (const [id, pending] of this.descriptions)
      if (pending.backend === backend) {
        clearTimeout(pending.timer);
        pending.reject(new Error("Owner disconnected"));
        this.descriptions.delete(id);
      }
  }
  close() {
    clearInterval(this.heartbeat);
    for (const id of this.viewers.keys()) this.end(id);
    for (const pending of this.descriptions.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Gateway stopped"));
    }
    this.descriptions.clear();
    this.server.close();
  }
}
