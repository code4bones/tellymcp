import type { Service, ServiceSchema } from "moleculer";

import {
  TELEGRAM_MCP_RUNTIME_SERVICE_NAME,
  type TelegramMcpRuntimeServiceInstance,
} from "./runtime.service";
import type {
  GetFileInput,
  GetFileListInput,
} from "./src/entities/request/model/types";
import { RemoteConsoleActionClient } from "./src/features/distributed-gateway/model/remoteConsoleActionClient";
import { GetFileService } from "./src/features/file-content/model/getFileService";

export const TELEGRAM_MCP_FILE_CONTENT_SERVICE_NAME = "telegramMcp.fileContent";

export type TelegramMcpFileContentServiceInstance = Service & {
  getFileService: GetFileService | null;
  getGetFileService: () => GetFileService;
};

type FileContentServiceCarrier = Service & {
  getFileService?: GetFileService | null;
  getGetFileService?: () => GetFileService;
};

const TelegramMcpFileContentService: ServiceSchema = {
  name: TELEGRAM_MCP_FILE_CONTENT_SERVICE_NAME,
  dependencies: [TELEGRAM_MCP_RUNTIME_SERVICE_NAME],

  actions: {
    listFilesRemote: {
      params: {
        $$strict: false,
        session_id: { type: "string", optional: true, trim: true, min: 1 },
        source: {
          type: "enum",
          optional: true,
          values: ["telegram-upload", "browser-screenshot", "partner-artifact"],
        },
        limit: {
          type: "number",
          optional: true,
          integer: true,
          positive: true,
          max: 200,
        },
      },
      async handler(
        this: FileContentServiceCarrier,
        ctx: { params: GetFileListInput },
      ) {
        return this.getGetFileService!().list(ctx.params);
      },
    },
    getFileRemote: {
      params: {
        $$strict: false,
        session_id: { type: "string", optional: true, trim: true, min: 1 },
        file_path: { type: "string", optional: true, trim: true, min: 1 },
        selector: {
          type: "enum",
          optional: true,
          values: ["latest_screenshot"],
        },
        type: {
          type: "enum",
          optional: true,
          values: ["text", "base64"],
        },
      },
      async handler(
        this: FileContentServiceCarrier,
        ctx: { params: GetFileInput },
      ) {
        return this.getGetFileService!().get(ctx.params);
      },
    },
    uploadFileRemote: {
      params: {
        $$strict: false,
        session_id: { type: "string", optional: true, trim: true, min: 1 },
        file_path: { type: "string", optional: true, trim: true, min: 1 },
        selector: {
          type: "enum",
          optional: true,
          values: ["latest_screenshot"],
        },
        type: { type: "enum", values: ["url"] },
        upload_url: { type: "string", trim: true, min: 1 },
      },
      async handler(
        this: FileContentServiceCarrier,
        ctx: { params: GetFileInput & { upload_url: string } },
      ) {
        return this.getGetFileService!().upload(ctx.params);
      },
    },
  },

  created(this: FileContentServiceCarrier) {
    this.getFileService = null;
  },

  methods: {
    getGetFileService(this: FileContentServiceCarrier): GetFileService {
      if (!this.getFileService) {
        throw new Error(
          "telegram_mcp file content service is not initialized yet",
        );
      }

      return this.getFileService;
    },
  },

  async started(this: FileContentServiceCarrier) {
    await this.broker.waitForServices([TELEGRAM_MCP_RUNTIME_SERVICE_NAME]);

    const runtimeService = this.broker.getLocalService(
      TELEGRAM_MCP_RUNTIME_SERVICE_NAME,
    ) as TelegramMcpRuntimeServiceInstance | null;

    if (!runtimeService) {
      throw new Error(
        `Local Moleculer service '${TELEGRAM_MCP_RUNTIME_SERVICE_NAME}' is unavailable`,
      );
    }

    const runtime = await runtimeService.waitUntilReady();

    this.logger.info("Starting telegram_mcp file content service");
    this.getFileService = new GetFileService(
      runtime.config,
      runtime.sessionStore,
      runtime.stateStore,
      runtime.stateStore,
      runtime.logger,
      runtime.projectIdentityResolver,
      new RemoteConsoleActionClient((actionName, params) =>
        this.broker.call(actionName, params, { meta: { internal_call: true } }),
      ),
      runtime.temporaryFileLinkStore,
    );
    this.logger.info("telegram_mcp file content service is ready");
  },
};

export default TelegramMcpFileContentService;
