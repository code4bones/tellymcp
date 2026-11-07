import * as XtermHeadless from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";

type Terminal = InstanceType<typeof XtermHeadless.Terminal>;

// Version-pinned adapter: addon-serialize itself also uses xterm private state.
// Keep all additional private access here and cover it with replay tests.
type Attributes = {
  getFgColor(): number;
  getBgColor(): number;
  getFgColorMode(): number;
  getBgColorMode(): number;
  isFgRGB(): boolean;
  isBgRGB(): boolean;
  isFgPalette(): boolean;
  isBgPalette(): boolean;
  isBold(): number;
  isDim(): number;
  isItalic(): number;
  isUnderline(): number;
  isBlink(): number;
  isInverse(): number;
  isInvisible(): number;
  isStrikethrough(): number;
};
type BufferState = {
  scrollTop: number;
  scrollBottom: number;
  x: number;
  y: number;
  ybase: number;
  savedX: number;
  savedY: number;
  savedCharset: Record<string, string> | undefined;
  tabs: Record<string, boolean>;
  savedCurAttrData: Attributes;
};
type Xterm55 = {
  _core: {
    _bufferService: { buffers: { normal: BufferState; alt: BufferState } };
    coreService: { isCursorHidden: boolean };
    coreMouseService: { activeEncoding: string };
    _inputHandler: {
      _curAttrData: Attributes;
      _parser: { precedingJoinState: number };
    };
    _charsetService: {
      glevel: number;
      _charsets: Array<Record<string, string> | undefined>;
    };
  };
};

function charset(value: Record<string, string> | undefined): string {
  if (!value) return "B";
  if (value.q === "─") return "0";
  if (value["#"] === "£") return "A";
  throw new Error("Prototype snapshot does not support this character set");
}

function position(
  terminal: Terminal,
  buffer: BufferState,
  alternate: boolean,
  origin = false,
): string {
  const row = buffer.y + 1 - (origin ? buffer.scrollTop : 0);
  if (buffer.x < terminal.cols) return `\x1b[${row};${buffer.x + 1}H`;
  // CUP cannot express a pending wrap at x == cols. Repaint the last cell to
  // restore it, including a wide character occupying the last two columns.
  const line = (
    alternate ? terminal.buffer.alternate : terminal.buffer.normal
  ).getLine(buffer.ybase + buffer.y)!;
  let column = terminal.cols - 1;
  if (line.getCell(column)?.getWidth() === 0) column--;
  const cell = line.getCell(column)!;
  return (
    `\x1b[${row};${column + 1}H` + attributes(cell) + (cell.getChars() || " ")
  );
}

function bufferState(
  terminal: Terminal,
  buffer: BufferState,
  alternate: boolean,
  currentAttributes: Attributes,
): string {
  let result = `\x1b[${buffer.scrollTop + 1};${buffer.scrollBottom + 1}r\x1b[3g`;
  for (const column of Object.keys(buffer.tabs)
    .map(Number)
    .sort((a, b) => a - b)) {
    if (column < terminal.cols && buffer.tabs[column])
      result += `\x1b[1;${column + 1}H\x1bH`;
  }
  const savedRow = Math.max(
    0,
    Math.min(terminal.rows - 1, buffer.savedY - buffer.ybase),
  );
  result +=
    `\x1b[${savedRow + 1};${Math.min(buffer.savedX + 1, terminal.cols)}H` +
    attributes(buffer.savedCurAttrData) +
    `\x1b(${charset(buffer.savedCharset)}\x1b7\x1b(B`;
  result +=
    position(terminal, buffer, alternate) + attributes(currentAttributes);
  return result;
}

function attributes(value: Attributes): string {
  const params = [0];
  for (const [enabled, code] of [
    [value.isBold(), 1],
    [value.isDim(), 2],
    [value.isItalic(), 3],
    [value.isUnderline(), 4],
    [value.isBlink(), 5],
    [value.isInverse(), 7],
    [value.isInvisible(), 8],
    [value.isStrikethrough(), 9],
  ]) {
    if (enabled) params.push(code!);
  }
  for (const [color, mode, rgb, palette, base] of [
    [
      value.getFgColor(),
      value.getFgColorMode(),
      value.isFgRGB(),
      value.isFgPalette(),
      38,
    ],
    [
      value.getBgColor(),
      value.getBgColorMode(),
      value.isBgRGB(),
      value.isBgPalette(),
      48,
    ],
  ] as const) {
    if (rgb)
      params.push(
        base,
        2,
        (color >> 16) & 255,
        (color >> 8) & 255,
        color & 255,
      );
    else if (mode === 0x1000000)
      params.push(base - 8 + (color < 8 ? color : 60 + color - 8));
    else if (palette) params.push(base, 5, color);
  }
  return `\x1b[${params.join(";")}m`;
}

/** xterm 5.5's built-in DECRQSS SGR reply is always 0m; use the actual state. */
export function currentSgr(terminal: Terminal): string {
  return attributes(
    (terminal as unknown as Xterm55)._core._inputHandler._curAttrData,
  ).slice(2);
}

export function serializeTerminalState(
  terminal: Terminal,
  addon: SerializeAddon,
): string {
  const core = (terminal as unknown as Xterm55)._core;
  const buffers = core._bufferService.buffers;
  if (
    !buffers.normal ||
    !buffers.alt ||
    typeof core.coreMouseService.activeEncoding !== "string"
  ) {
    throw new Error("Unsupported xterm snapshot adapter (requires 5.5.0)");
  }
  let content = addon.serialize({ excludeModes: true });
  const altMarker = "\x1b[?1049h\x1b[H";
  if (terminal.buffer.active.type === "alternate") {
    const split = content.indexOf(altMarker);
    if (split < 0)
      throw new Error("Unsupported serialize addon alternate buffer format");
    // The addon uses the active attributes for BOTH buffers. Restore the saved
    // normal attributes before 1049h and reset SGR before painting alt cells.
    content =
      content.slice(0, split) +
      bufferState(
        terminal,
        buffers.normal,
        false,
        buffers.normal.savedCurAttrData,
      ) +
      `\x1b(${charset(buffers.normal.savedCharset)}` +
      altMarker +
      "\x1b(B\x1b[0m" +
      content.slice(split + altMarker.length) +
      bufferState(terminal, buffers.alt, true, core._inputHandler._curAttrData);
  } else {
    content += bufferState(
      terminal,
      buffers.normal,
      false,
      core._inputHandler._curAttrData,
    );
  }
  const modes = terminal.modes;
  if (modes.applicationCursorKeysMode) content += "\x1b[?1h";
  if (modes.applicationKeypadMode) content += "\x1b=";
  if (modes.bracketedPasteMode) content += "\x1b[?2004h";
  if (modes.insertMode) content += "\x1b[4h";
  if (modes.reverseWraparoundMode) content += "\x1b[?45h";
  if (modes.sendFocusMode) content += "\x1b[?1004h";
  if (!modes.wraparoundMode) content += "\x1b[?7l";
  if (terminal.options.convertEol) content += "\x1b[20h";
  if (modes.originMode) {
    const active =
      terminal.buffer.active.type === "alternate"
        ? buffers.alt
        : buffers.normal;
    content +=
      "\x1b[?6h" +
      position(
        terminal,
        active,
        terminal.buffer.active.type === "alternate",
        true,
      ) +
      attributes(core._inputHandler._curAttrData);
  }
  for (let level = 0; level < 4; level++)
    content += `\x1b${["(", ")", "*", "+"][level]}${charset(core._charsetService._charsets[level])}`;
  content += ["\x0f", "\x0e", "\x1bn", "\x1bo"][core._charsetService.glevel];
  const mouse = { none: 0, x10: 9, vt200: 1000, drag: 1002, any: 1003 }[
    modes.mouseTrackingMode
  ];
  if (mouse) content += `\x1b[?${mouse}h`;
  if (core.coreMouseService.activeEncoding === "SGR") content += "\x1b[?1006h";
  if (core.coreMouseService.activeEncoding === "SGR_PIXELS")
    content += "\x1b[?1016h";
  const cursorStyle = { block: 2, underline: 4, bar: 6 }[
    terminal.options.cursorStyle || "block"
  ];
  content += `\x1b[${cursorStyle - (terminal.options.cursorBlink ? 1 : 0)} q`;
  content += core.coreService.isCursorHidden ? "\x1b[?25l" : "\x1b[?25h";
  // A snapshot's controls clear REP's preceding printable character. Repaint
  // that cell LAST so a live CSI b (or combining continuation) sees the same
  // parser state. In insert mode, delete the old cell before inserting it again.
  if (core._inputHandler._parser.precedingJoinState) {
    const active = terminal.buffer.active;
    const line = active.getLine(active.baseY + active.cursorY)!;
    let column = active.cursorX - 1;
    if (line.getCell(column)?.getWidth() === 0) column--;
    const cell = line.getCell(column);
    if (cell && cell.getChars()) {
      const buffer = active.type === "alternate" ? buffers.alt : buffers.normal;
      const row =
        active.cursorY + 1 - (modes.originMode ? buffer.scrollTop : 0);
      content += `\x1b[${row};${column + 1}H`;
      if (modes.insertMode) content += `\x1b[${cell.getWidth()}P`;
      content += cell.getChars();
    }
  }
  // Fresh state, not historical output: no old bells, queries or clipboard writes.
  return "\x1bc" + content;
}
