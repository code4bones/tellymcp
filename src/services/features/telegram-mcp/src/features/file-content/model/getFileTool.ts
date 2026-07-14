import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  getFileInputSchema,
  getFileOutputSchema,
} from "../../../entities/request/model/schema";
import type { GetFileOutput } from "../../../entities/request/model/types";
import type { ToolModule } from "../../../shared/api/tool-registry/types";
import { assertSerializedBodySize } from "../../../shared/lib/bodyLimits";
import { GetFileService, type GetFileResult } from "./getFileService";

function createStructuredOutput(output: GetFileResult): GetFileOutput {
  return {
    type: output.type,
    data: output.data,
    mimetype: output.mimetype,
    filename: output.filename,
    size_bytes: output.size_bytes,
    ...(output.expires_at ? { expires_at: output.expires_at } : {}),
  };
}

function assertNativeImagePayload(data: string, sizeBytes: number): void {
  if (
    !data ||
    data === "[image]" ||
    Buffer.from(data, "base64").byteLength !== sizeBytes
  ) {
    throw new Error(
      "Native MCP image payload failed final tool-result validation.",
    );
  }
}

export class GetFileTool implements ToolModule {
  public constructor(private readonly getFileService: GetFileService) {}

  public register(server: McpServer): void {
    server.registerTool(
      "get_file",
      {
        title: "Get File",
        description:
          "Retrieve a file from the workspace of a selected live console. type='url' is the default and returns only a short-lived HTTPS download link. type='image' returns a native MCP image plus its URL. type='text' returns UTF-8 project files such as Markdown or source code directly as MCP text. type='base64' is the host-independent fallback and returns the complete JSON payload, including data, in an MCP text block. Provide an exact workspace-relative or absolute file_path, or selector='latest_screenshot'. Sensitive paths such as environment files, credential stores, and private keys are blocked. In gateway mode, pass session_id exactly as returned by list_gateway_sessions.",
        inputSchema: getFileInputSchema,
        outputSchema: getFileOutputSchema,
      },
      async (args) => {
        const output = await this.getFileService.get(args);
        if (output.native_image_data !== undefined) {
          assertNativeImagePayload(output.native_image_data, output.size_bytes);
          const structuredOutput = createStructuredOutput(output);
          return {
            content: [
              {
                type: "image",
                data: output.native_image_data,
                mimeType: output.mimetype,
              },
              {
                type: "text",
                text: `${output.filename}\nDownload URL: ${output.data}`,
              },
            ],
            structuredContent: structuredOutput,
          };
        }

        if (output.type === "text") {
          const result = {
            content: [
              {
                type: "text" as const,
                text: output.data,
              },
            ],
            structuredContent: output,
          };
          assertSerializedBodySize(result);
          return result;
        }

        const result = {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(output, null, 2),
            },
          ],
          structuredContent: output,
        };
        assertSerializedBodySize(result);
        return result;
      },
    );
  }
}
