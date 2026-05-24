import type { Service, ServiceSchema } from "moleculer";

import {
  TELEGRAM_MCP_RUNTIME_SERVICE_NAME,
  type TelegramMcpRuntimeServiceInstance,
} from "./runtime.service";
import { RemoteConsoleActionClient } from "./src/features/distributed-gateway/model/remoteConsoleActionClient";
import { XchangeService } from "./src/features/xchange/model/xchangeService";
import type { TelegramXchangeFileMeta } from "./src/entities/inbox/model/types";
import type {
  GetXchangeRecordInput,
  ListXchangeRecordsInput,
  MarkXchangeRecordReadInput,
  XchangeRecordCategory,
  XchangeRecordDirection,
  XchangeRecordStatus,
} from "./src/entities/xchange/model/types";

export const TELEGRAM_MCP_XCHANGE_SERVICE_NAME = "telegramMcp.xchange";

export type TelegramMcpXchangeServiceInstance = Service & {
  xchangeService: XchangeService | null;
  getXchangeService: () => XchangeService;
};

type XchangeServiceCarrier = Service & {
  xchangeService?: XchangeService | null;
  getXchangeService?: () => XchangeService;
};

const TelegramMcpXchangeService: ServiceSchema = {
  name: TELEGRAM_MCP_XCHANGE_SERVICE_NAME,
  dependencies: [TELEGRAM_MCP_RUNTIME_SERVICE_NAME],

  actions: {
    listRecordsRemote: {
      params: {
        $$strict: false,
        session_id: { type: "string", optional: true, trim: true, min: 1 },
        status: {
          type: "enum",
          optional: true,
          values: ["new", "read", "archived"] satisfies XchangeRecordStatus[],
        },
        category: {
          type: "enum",
          optional: true,
          values: [
            "partner_note",
            "local_handoff",
            "telegram_message",
          ] satisfies XchangeRecordCategory[],
        },
        direction: {
          type: "enum",
          optional: true,
          values: ["incoming", "outgoing", "local"] satisfies XchangeRecordDirection[],
        },
        limit: { type: "number", integer: true, positive: true, optional: true },
      },
      async handler(
        this: XchangeServiceCarrier,
        ctx: { params: ListXchangeRecordsInput },
      ) {
        return this.getXchangeService!().listRecords(ctx.params);
      },
    },
    getRecordRemote: {
      params: {
        $$strict: false,
        session_id: { type: "string", optional: true, trim: true, min: 1 },
        record_id: { type: "string", trim: true, min: 1 },
      },
      async handler(
        this: XchangeServiceCarrier,
        ctx: { params: GetXchangeRecordInput },
      ) {
        return this.getXchangeService!().getRecord(ctx.params);
      },
    },
    markReadRemote: {
      params: {
        $$strict: false,
        session_id: { type: "string", optional: true, trim: true, min: 1 },
        record_id: { type: "string", trim: true, min: 1 },
      },
      async handler(
        this: XchangeServiceCarrier,
        ctx: { params: MarkXchangeRecordReadInput },
      ) {
        return this.getXchangeService!().markRead(ctx.params);
      },
    },
    listFileMetasRemote: {
      params: {
        $$strict: false,
        session_id: { type: "string", optional: true, trim: true, min: 1 },
        source: {
          type: "enum",
          optional: true,
          values: [
            "telegram-upload",
            "browser-screenshot",
            "partner-artifact",
          ] satisfies TelegramXchangeFileMeta["source"][],
        },
      },
      async handler(
        this: XchangeServiceCarrier,
        ctx: {
          params: {
            session_id?: string;
            source?: TelegramXchangeFileMeta["source"];
          };
        },
      ) {
        return this.getXchangeService!().listFileMetas(ctx.params);
      },
    },
    getFileMetaRemote: {
      params: {
        $$strict: false,
        session_id: { type: "string", optional: true, trim: true, min: 1 },
        file_path: { type: "string", trim: true, min: 1 },
      },
      async handler(
        this: XchangeServiceCarrier,
        ctx: { params: { session_id?: string; file_path: string } },
      ) {
        return this.getXchangeService!().getFileMeta(ctx.params);
      },
    },
    deleteFileMetaRemote: {
      params: {
        $$strict: false,
        session_id: { type: "string", optional: true, trim: true, min: 1 },
        file_path: { type: "string", trim: true, min: 1 },
      },
      async handler(
        this: XchangeServiceCarrier,
        ctx: { params: { session_id?: string; file_path: string } },
      ) {
        return this.getXchangeService!().deleteFileMeta(ctx.params);
      },
    },
  },

  created(this: XchangeServiceCarrier) {
    this.xchangeService = null;
  },

  methods: {
    getXchangeService(this: XchangeServiceCarrier): XchangeService {
      if (!this.xchangeService) {
        throw new Error("telegram_mcp xchange service is not initialized yet");
      }

      return this.xchangeService;
    },
  },

  async started(this: XchangeServiceCarrier) {
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
    this.logger.info("Starting telegram_mcp xchange service");
    this.xchangeService = new XchangeService(
      runtime.config,
      runtime.sessionStore,
      runtime.stateStore,
      runtime.stateStore,
      runtime.logger,
      runtime.projectIdentityResolver,
      new RemoteConsoleActionClient((actionName, params) =>
        this.broker.call(actionName, params, { meta: { internal_call: true } }),
      ),
    );
    this.logger.info("telegram_mcp xchange service is ready");
  },
};

export default TelegramMcpXchangeService;
