/** Ctrl+] d detaches; doubled Ctrl+] forwards one literal prefix. */
export class AttachmentInput {
  private prefix = false;
  private marker = 0;
  private paste = false;
  private detached = false;

  push(data: Buffer): { data: Buffer; detach: boolean } {
    const out: number[] = [];
    for (const byte of data) {
      if (this.detached) break;
      if (this.paste) out.push(byte);
      else if (this.prefix) {
        this.prefix = false;
        if (byte === 0x64) {
          this.detached = true;
          break;
        }
        out.push(0x1d);
        if (byte !== 0x1d) out.push(byte);
      } else if (byte === 0x1d) this.prefix = true;
      else out.push(byte);
      const candidate = Buffer.from(this.paste ? "\x1b[201~" : "\x1b[200~");
      this.marker =
        byte === candidate[this.marker]
          ? this.marker + 1
          : byte === 0x1b
            ? 1
            : 0;
      if (this.marker === candidate.length) {
        this.marker = 0;
        this.paste = !this.paste;
      }
    }
    return { data: Buffer.from(out), detach: this.detached };
  }
}
