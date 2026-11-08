import * as z from "zod/v4";

const id = z.string().min(1).max(256);
const rect = z.strictObject({
  x: z.number().finite().nonnegative(),
  y: z.number().finite().nonnegative(),
  width: z.number().finite().positive(),
  height: z.number().finite().positive(),
});
const element = z.strictObject({
  tagName: z.string().max(64),
  role: z.string().max(64).optional(),
  text: z.string().max(16384),
  html: z.string().max(16384),
  ancestors: z
    .array(
      z.strictObject({
        tagName: z.string().max(64),
        role: z.string().max(64).optional(),
      }),
    )
    .max(5),
  attributes: z.partialRecord(
    z.enum(["role", "aria-label", "aria-description", "title", "alt"]),
    z.string().max(256),
  ),
  table: z
    .strictObject({
      headers: z.array(z.string().max(256)).max(20),
      rows: z.array(z.array(z.string().max(256)).max(20)).max(30),
      visibleOnly: z.literal(true),
    })
    .optional(),
});
export const inspectorContextSchema = z.strictObject({
  schemaVersion: z.literal(1),
  selectionId: id,
  requestId: id,
  timestamp: z.iso.datetime(),
  source: z.strictObject({ connectionId: id, tabId: id, sessionId: id }),
  page: z.strictObject({
    url: z.url().max(2048),
    origin: z.url().max(2048),
    title: z.string().max(512),
    viewport: z.strictObject({
      width: z.number().finite().positive().max(100000),
      height: z.number().finite().positive().max(100000),
      deviceScaleFactor: z.number().finite().positive().max(16),
    }),
  }),
  selection: z.strictObject({
    mode: z.enum(["element", "region"]),
    rect,
    element: element.optional(),
  }),
  screenshot: z
    .strictObject({
      mimeType: z.literal("image/png"),
      width: z.number().int().positive().max(1600),
      height: z.number().int().positive().max(1600),
      attachmentId: id,
    })
    .optional(),
  question: z.string().max(2000).optional(),
  redaction: z.strictObject({
    applied: z.literal(true),
    warnings: z.array(z.string().max(512)).max(10),
  }),
});
export const inspectorInputSchema = z.object({
  session_id: id.optional(),
  operation: z.enum([
    "start",
    "get_selection",
    "highlight",
    "response",
    "stop",
  ]),
  mode: z.enum(["element", "region"]).optional(),
  request_id: id.optional(),
  selection_id: id.optional(),
  include_image: z.boolean().optional(),
  explanation: z.string().max(16384).optional(),
});
export type InspectorInput = z.infer<typeof inspectorInputSchema>;
export const inspectorResultSchema = z.object({
  status: z.enum([
    "awaiting_user",
    "selected",
    "pending",
    "highlighted",
    "responded",
    "stopped",
  ]),
  request_id: id.optional(),
  ttl_seconds: z.number().positive().optional(),
  receiver: id.nullable().optional(),
  context: inspectorContextSchema.optional(),
  image: z
    .strictObject({
      png_base64: z
        .string()
        .max(349532)
        .regex(/^[A-Za-z0-9+/]+={0,2}$/),
      width: z.number().int().positive().max(1600),
      height: z.number().int().positive().max(1600),
    })
    .optional(),
});

export function validateInspectorResult(
  value: unknown,
  binding: { sessionId: string; instanceId: string; tabId: number },
): z.infer<typeof inspectorResultSchema> {
  const output = inspectorResultSchema.parse(value);
  if (output.context) {
    const c = output.context;
    if (
      Buffer.byteLength(JSON.stringify(c), "utf8") > 65536 ||
      c.source.sessionId !== binding.sessionId ||
      c.source.connectionId !== binding.instanceId ||
      c.source.tabId !== String(binding.tabId) ||
      Math.abs(Date.now() - Date.parse(c.timestamp)) > 300000
    )
      throw new Error(
        "Inspector selection is expired or belongs to another session/tab",
      );
    const url = new URL(c.page.url);
    if (
      !/^https?:$/.test(url.protocol) ||
      url.search ||
      url.hash ||
      url.username ||
      url.password ||
      url.origin !== c.page.origin
    )
      throw new Error("Inspector URL must be sanitized HTTP(S)");
    const r = c.selection.rect,
      v = c.page.viewport;
    if (r.x + r.width > v.width + 1 || r.y + r.height > v.height + 1)
      throw new Error("Inspector selection exceeds viewport");
  }
  if (output.status === "selected" && !output.context)
    throw new Error("Inspector selection is missing");
  if (output.image) {
    const image = output.image,
      png = Buffer.from(image.png_base64, "base64");
    if (
      !output.context?.screenshot ||
      png.length > 262144 ||
      png.length < 24 ||
      png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" ||
      png.toString("ascii", 12, 16) !== "IHDR" ||
      png.readUInt32BE(16) !== image.width ||
      png.readUInt32BE(20) !== image.height ||
      image.width !== output.context.screenshot.width ||
      image.height !== output.context.screenshot.height ||
      output.context.screenshot.attachmentId !== output.context.selectionId
    )
      throw new Error(
        "Inspector screenshot does not match its attachment metadata",
      );
  }
  return output;
}
