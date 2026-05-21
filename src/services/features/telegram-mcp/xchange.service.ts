import type { Service, ServiceSchema } from "moleculer";

import {
  TELEGRAM_MCP_RUNTIME_SERVICE_NAME,
  type TelegramMcpRuntimeServiceInstance,
} from "./runtime.service";
import { RemoteConsoleActionClient } from "./src/features/distributed-gateway/model/remoteConsoleActionClient";
import { XchangeService } from "./src/features/xchange/model/xchangeService";
import type {
  GetXchangeRecordInput,
  ListXchangeRecordsInput,
  MarkXchangeRecordReadInput,
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
      params: { type: "object" },
      async handler(
        this: XchangeServiceCarrier,
        ctx: { params: ListXchangeRecordsInput },
      ) {
        return this.getXchangeService!().listRecords(ctx.params);
      },
    },
    getRecordRemote: {
      params: { type: "object" },
      async handler(
        this: XchangeServiceCarrier,
        ctx: { params: GetXchangeRecordInput },
      ) {
        return this.getXchangeService!().getRecord(ctx.params);
      },
    },
    markReadRemote: {
      params: { type: "object" },
      async handler(
        this: XchangeServiceCarrier,
        ctx: { params: MarkXchangeRecordReadInput },
      ) {
        return this.getXchangeService!().markRead(ctx.params);
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
