declare module "ws" {
  export default class WebSocket {
    public constructor(url: string);
    public once(event: "open", listener: () => void): this;
    public once(
      event: "unexpected-response",
      listener: (
        request: unknown,
        response: { statusCode?: number },
      ) => void,
    ): this;
    public once(event: "error", listener: (error: Error) => void): this;
    public once(event: "close", listener: (code: number) => void): this;
    public once(event: string, listener: (...args: unknown[]) => void): this;
    public removeAllListeners(): this;
    public close(): void;
  }
}
