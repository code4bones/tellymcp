import * as XtermHeadless from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";
import { attributes, serializeTerminalState } from "./terminalSnapshot";

type Terminal = InstanceType<typeof XtermHeadless.Terminal>;
type BufferView = Terminal["buffer"]["normal"];

/** Keep a VT model at the owner's authoritative size when physical sizes differ.
 * Paint positioned cells, clip a smaller window and pad a larger one without
 * rewrapping. Equal-size terminals retain the existing byte-for-byte fast path.
 */
export class NativeViewport {
  private readonly terminal: Terminal;
  private readonly addon = new SerializeAddon();
  private projected = false;
  private initialized = false;
  private active: "normal" | "alternate" = "normal";
  private lines: string[] = [];
  private physicalSize = "";
  private historyAnchor: unknown;
  private historyLength = 0;

  constructor(
    cols: number,
    rows: number,
    private readonly physical: () => { cols: number; rows: number },
  ) {
    this.terminal = new XtermHeadless.Terminal({
      cols,
      rows,
      scrollback: 5000,
      allowProposedApi: true,
    });
    this.terminal.loadAddon(this.addon);
  }

  async write(data: string | Buffer): Promise<string | Buffer> {
    await new Promise<void>((resolve) => this.terminal.write(data, resolve));
    return this.render(data);
  }

  async restore(
    cols: number,
    rows: number,
    ansi: string,
  ): Promise<string | Buffer> {
    this.terminal.resize(cols, rows);
    this.initialized = false;
    await new Promise<void>((resolve) => this.terminal.write(ansi, resolve));
    return this.render(ansi);
  }

  dispose(): void {
    this.terminal.dispose();
  }

  private line(buffer: BufferView, index: number, width: number): string {
    const line = buffer.getLine(index);
    if (!line) return "\x1b[0m\x1b[K";
    let text = "",
      previous = "";
    for (
      let column = 0;
      column < Math.min(width, this.terminal.cols);
      column++
    ) {
      const cell = line.getCell(column);
      if (!cell || cell.getWidth() === 0) continue;
      const style = attributes(cell);
      if (style !== previous) {
        text += style;
        previous = style;
      }
      text += column + cell.getWidth() > width ? " " : cell.getChars() || " ";
    }
    return text + "\x1b[0m\x1b[K";
  }

  // xterm 5.5's BufferLineApiView wraps the actual circular-buffer line. Identity
  // distinguishes scrolling at a full history cap from an ordinary repaint.
  private lineIdentity(buffer: BufferView, index: number): unknown {
    return (buffer.getLine(index) as unknown as { _line?: unknown } | undefined)
      ?._line;
  }

  private historyDelta(buffer: BufferView): number | null {
    if (buffer.baseY < this.historyLength) return null;
    if (!this.historyAnchor) return buffer.baseY - this.historyLength;
    for (let index = buffer.baseY - 1; index >= 0; index--) {
      if (this.lineIdentity(buffer, index) === this.historyAnchor)
        return buffer.baseY - 1 - index;
    }
    return null;
  }

  private rememberHistory(): void {
    const normal = this.terminal.buffer.normal;
    this.historyLength = normal.baseY;
    this.historyAnchor = normal.baseY
      ? this.lineIdentity(normal, normal.baseY - 1)
      : undefined;
  }

  private cursorAndModes(): string {
    const t = this.terminal,
      b = t.buffer.active,
      modes = t.modes;
    const physical = this.physical();
    const core = t as unknown as {
      _core: {
        coreService: { isCursorHidden: boolean };
        coreMouseService: { activeEncoding: string };
      };
    };
    let value = `\x1b[${Math.min(b.cursorY + 1, physical.rows)};${Math.min(b.cursorX + 1, physical.cols, t.cols)}H`;
    // The projector itself writes absolute cells with wrapping and insert off.
    value += "\x1b[?6l\x1b[?7l\x1b[4l\x1b(B\x0f";
    value += modes.applicationCursorKeysMode ? "\x1b[?1h" : "\x1b[?1l";
    value += modes.applicationKeypadMode ? "\x1b=" : "\x1b>";
    value += modes.bracketedPasteMode ? "\x1b[?2004h" : "\x1b[?2004l";
    value += modes.sendFocusMode ? "\x1b[?1004h" : "\x1b[?1004l";
    for (const id of [9, 1000, 1002, 1003, 1006, 1016]) value += `\x1b[?${id}l`;
    const mouse = { none: 0, x10: 9, vt200: 1000, drag: 1002, any: 1003 }[
      modes.mouseTrackingMode
    ];
    if (mouse) value += `\x1b[?${mouse}h`;
    if (core._core.coreMouseService.activeEncoding === "SGR")
      value += "\x1b[?1006h";
    if (core._core.coreMouseService.activeEncoding === "SGR_PIXELS")
      value += "\x1b[?1016h";
    const style = { block: 2, underline: 4, bar: 6 }[
      t.options.cursorStyle || "block"
    ];
    value += `\x1b[${style - (t.options.cursorBlink ? 1 : 0)} q`;
    const clipped =
      b.cursorY >= physical.rows ||
      (b.cursorX >= physical.cols && this.terminal.cols > physical.cols);
    value +=
      core._core.coreService.isCursorHidden || clipped
        ? "\x1b[?25l"
        : "\x1b[?25h";
    return value;
  }

  private rebuild(cols: number, rows: number): string {
    let result = "\x1bc\x1b[?7l\x1b[?6l\x1b[4l";
    const normal = this.terminal.buffer.normal;
    const count = normal.baseY + Math.min(this.terminal.rows, rows);
    for (let index = 0; index < count; index++) {
      if (index) result += "\r\n";
      result += this.line(normal, index, cols);
      if (result.length > 8 * 1024 * 1024)
        throw new Error("Projected snapshot exceeds output limit");
    }
    for (let index = this.terminal.rows; index < rows; index++)
      result += "\r\n\x1b[0m\x1b[K";
    if (this.terminal.buffer.active.type === "alternate")
      result += "\x1b[?1049h";
    this.active = this.terminal.buffer.active.type;
    this.lines = [];
    this.initialized = true;
    this.rememberHistory();
    return result;
  }

  private render(raw: string | Buffer): string | Buffer {
    const { cols, rows } = this.physical();
    if (cols === this.terminal.cols && rows === this.terminal.rows) {
      if (!this.projected) return raw;
      this.projected = false;
      this.initialized = false;
      return serializeTerminalState(this.terminal, this.addon);
    }
    this.projected = true;
    let result = "";
    const size = `${cols}:${rows}`;
    if (!this.initialized || size !== this.physicalSize) {
      result += this.rebuild(cols, rows);
      this.physicalSize = size;
    } else {
      const active = this.terminal.buffer.active.type;
      if (active !== this.active) {
        result += active === "alternate" ? "\x1b[?1049h" : "\x1b[?1049l";
        this.active = active;
        this.lines = [];
      }
      if (active === "normal") {
        const delta = this.historyDelta(this.terminal.buffer.normal);
        if (delta === null || delta > Math.min(rows, this.terminal.rows))
          result += this.rebuild(cols, rows);
        else if (delta) {
          result += `\x1b[r\x1b[${rows};1H` + "\r\n".repeat(delta);
          this.lines = [];
        }
        this.rememberHistory();
      }
    }
    result += "\x1b[?6l\x1b[?7l\x1b[4l\x1b[r";
    const buffer = this.terminal.buffer.active;
    for (let row = 0; row < rows; row++) {
      const line =
        row < this.terminal.rows
          ? this.line(buffer, buffer.baseY + row, cols)
          : "\x1b[0m\x1b[K";
      if (line !== this.lines[row]) result += `\x1b[${row + 1};1H` + line;
      this.lines[row] = line;
    }
    return result + this.cursorAndModes();
  }
}
