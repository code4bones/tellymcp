import { stripVTControlCharacters } from "node:util";
import pc from "picocolors";

type SessionRow = {
  handle: string;
  session_label: string;
  state: string;
  attached: boolean | null;
  pty_pid: number | null;
  cwd: string;
};

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const clean = (value: string) =>
  stripVTControlCharacters(value).replace(/\p{Cc}/gu, " ");
function width(text: string): number {
  let result = 0;
  for (const { segment } of graphemes.segment(text)) {
    const code = segment.codePointAt(0)!;
    const wide =
      /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(segment) ||
      (code >= 0x1100 &&
        (code <= 0x115f ||
          (code >= 0x2e80 && code <= 0xa4cf) ||
          (code >= 0xac00 && code <= 0xd7a3) ||
          (code >= 0xf900 && code <= 0xfaff) ||
          (code >= 0xfe10 && code <= 0xfe6f) ||
          (code >= 0xff00 && code <= 0xff60) ||
          (code >= 0xffe0 && code <= 0xffe6) ||
          code >= 0x20000));
    result += wide ? 2 : 1;
  }
  return result;
}
function fit(text: string, limit: number, tail = false): string {
  if (width(text) <= limit) return text;
  const parts = Array.from(graphemes.segment(text), ({ segment }) => segment);
  if (tail) parts.reverse();
  let result = "",
    used = 0;
  for (const part of parts) {
    const size = width(part);
    if (used + size > Math.max(0, limit - 1)) break;
    result = tail ? part + result : result + part;
    used += size;
  }
  return tail ? "…" + result : result + "…";
}

export function formatSessionsTable(
  sessions: readonly SessionRow[],
  options: { columns?: number; color?: boolean } = {},
): string {
  const color = pc.createColors(options.color ?? pc.isColorSupported);
  const headers = [
    "HANDLE",
    "SESSION",
    "STATE",
    "CONTROLLER",
    "SHELL_PID",
    "CWD",
  ];
  const rows = sessions.map((session) => [
    session.handle,
    fit(clean(session.session_label), 24),
    session.state,
    session.attached === null
      ? "unknown"
      : session.attached
        ? "attached"
        : "detached",
    String(session.pty_pid ?? "-"),
    clean(session.cwd),
  ]);
  const widths = headers.map((header, index) =>
    Math.max(width(header), ...rows.map((row) => width(row[index]!))),
  );
  const paint = (text: string, column: number): string => {
    if (column === 0) return color.cyan(text);
    if (column === 1) return color.bold(text);
    if (column === 2)
      return text === "running"
        ? color.green(text)
        : text === "exited"
          ? color.red(text)
          : color.yellow(text);
    if (column === 3)
      return text === "attached"
        ? color.green(text)
        : text === "detached"
          ? color.yellow(text)
          : color.dim(text);
    return column === 4 ? color.magenta(text) : color.dim(text);
  };
  const columns = options.columns;
  const fixed = widths.slice(0, 5).reduce((sum, size) => sum + size, 0) + 10;
  if (columns && columns < fixed + 16) {
    // Full handles remain copyable even when six columns cannot fit.
    return (
      color.bold(color.cyan("LOCAL SESSIONS")) +
      "\n\n" +
      rows
        .map((row) =>
          [
            color.bold(fit(row[1]!, Math.max(8, columns - 40))) +
              "  " +
              paint(row[2]!, 2) +
              "  " +
              paint(row[3]!, 3) +
              "  " +
              color.dim("PID ") +
              paint(row[4]!, 4),
            paint(row[0]!, 0),
            color.dim(fit(row[5]!, columns, true)),
          ].join("\n"),
        )
        .join("\n\n") +
      "\n"
    );
  }
  if (columns) widths[5] = Math.min(widths[5]!, columns - fixed);
  const line = (row: string[], heading = false) =>
    row
      .map((raw, column) => {
        const text = fit(raw, widths[column]!, column === 5);
        const padding = " ".repeat(Math.max(0, widths[column]! - width(text)));
        const styled = heading
          ? color.bold(color.cyan(text))
          : paint(text, column);
        if (column === 5) return styled;
        return column === 4 ? padding + styled : styled + padding;
      })
      .join("  ");
  return (
    [
      line(headers, true),
      color.dim(widths.map((size) => "─".repeat(size)).join("  ")),
      ...rows.map((row) => line(row)),
    ].join("\n") + "\n"
  );
}
