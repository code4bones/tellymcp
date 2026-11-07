/* eslint-disable no-control-regex -- VT controls are the input grammar of this module. */
export type VtToken = {
  kind: "text" | "escape" | "csi" | "osc" | "dcs" | "string";
  data: string;
};

/** Keep incomplete controls out of both the screen and the snapshot/live boundary. */
export class VtOutput {
  private pending = "";

  constructor(private readonly maxControlChars = 65536) {}

  push(data: string): VtToken[] {
    const input = this.pending + data;
    this.pending = "";
    const tokens: VtToken[] = [];
    let start = 0;
    let i = 0;
    const emitText = () => {
      if (i > start) tokens.push({ kind: "text", data: input.slice(start, i) });
    };
    while (i < input.length) {
      const ch = input.charCodeAt(i);
      if (ch !== 0x1b && ![0x90, 0x98, 0x9b, 0x9d, 0x9e, 0x9f].includes(ch)) {
        // A JS string can itself end halfway through a Unicode surrogate pair.
        if (ch >= 0xd800 && ch <= 0xdbff && i === input.length - 1) break;
        i++;
        continue;
      }
      emitText();
      start = i;
      const intro = ch === 0x1b ? input[i + 1] : String.fromCharCode(ch - 0x40);
      if (intro === undefined) break;
      const bodyStart = i + (ch === 0x1b ? 2 : 1);
      let kind: VtToken["kind"] = "escape";
      if (intro === "[") kind = "csi";
      if (intro === "]") kind = "osc";
      if (intro === "P") kind = "dcs";
      if (["X", "^", "_"].includes(intro)) kind = "string";
      let end = bodyStart;
      let complete = false;
      for (; end < input.length; end++) {
        const code = input.charCodeAt(end);
        // CAN/SUB cancel a sequence; an embedded ESC starts another control.
        if (code === 0x18 || code === 0x1a) {
          end++;
          complete = true;
          break;
        }
        if (kind === "osc" || kind === "dcs" || kind === "string") {
          if (code === 0x9c || (kind === "osc" && code === 7)) {
            end++;
            complete = true;
            break;
          }
          if (code === 0x1b) {
            if (end + 1 === input.length) break;
            if (input[end + 1] === "\\") {
              end += 2;
              complete = true;
              break;
            }
            complete = true;
            break;
          }
        } else {
          if (code === 0x1b) {
            complete = true;
            break;
          }
          if (code >= (kind === "csi" ? 0x40 : 0x30) && code <= 0x7e) {
            end++;
            complete = true;
            break;
          }
        }
      }
      // Simple ESC finals (ESC 7, ESC =, RIS...) are the introducer itself.
      if (kind === "escape" && intro.charCodeAt(0) >= 0x30) {
        end = bodyStart;
        complete = true;
      }
      if (end - start > this.maxControlChars)
        throw new Error("VT control exceeds prototype limit");
      if (!complete) {
        i = start;
        break;
      }
      tokens.push({ kind, data: input.slice(start, end) });
      i = end;
      start = i;
    }
    emitText();
    this.pending = input.slice(i);
    if (this.pending.length > this.maxControlChars)
      throw new Error("VT control exceeds prototype limit");
    return tokens;
  }
}

/** Queries belong to the owner, never to an attached display (even when unsupported). */
export function isTerminalQuery(token: VtToken): boolean {
  const data = token.data.replace(/[\x00-\x17\x19\x1c-\x1f]/gu, "");
  if (token.kind === "csi") {
    const body = data.replace(/^(?:\x1b\[|\x9b)/u, "");
    return (
      /[cn]$/u.test(body) ||
      /\$p$/u.test(body) ||
      /^(?:1[1-9]|20|21)(?:;[\d;]*)?t$/u.test(body) ||
      /^[?>=].*[qu]$/u.test(body)
    );
  }
  if (token.kind === "osc")
    return /^(?:\x1b\]|\x9d)(?:4|1[0-9]|52);/u.test(data) && data.includes("?");
  if (token.kind === "dcs") return /^(?:\x1bP|\x90)[\d;]*[+$]q/u.test(data);
  return token.kind === "escape" && data === "\x1bZ";
}
