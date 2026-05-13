import type { RiskLevel } from "../../types/common";

export type HumanTransportRequest = {
  requestId: string;
  sessionId: string;
  sessionLabel?: string;
  recipient: {
    telegramUserId: number;
    telegramChatId: number;
  };
  task?: string;
  question: string;
  context?: string;
  affectedFiles?: string[];
  options?: string[];
  recommendedOption?: string;
  riskLevel?: RiskLevel;
  fallbackIfTimeout?: string;
};

export type HumanTransportReply = {
  requestId: string;
  answer: string;
  receivedAt: string;
};

export type HumanTransportNotification = {
  sessionId: string;
  sessionLabel?: string;
  recipient: {
    telegramUserId: number;
    telegramChatId: number;
  };
  message: string;
  task?: string;
  context?: string;
  riskLevel?: RiskLevel;
};

export interface HumanTransport {
  start(): Promise<void>;
  stop(): Promise<void>;
  sendRequest(
    input: HumanTransportRequest,
  ): Promise<{ externalMessageId?: string | number }>;
  waitForReply(
    requestId: string,
    timeoutSeconds: number,
  ): Promise<HumanTransportReply | null>;
  sendNotification(
    input: HumanTransportNotification,
  ): Promise<{ externalMessageId?: string | number }>;
}
