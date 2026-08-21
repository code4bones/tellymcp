import { ServiceBroker, type ServiceSchema } from "moleculer";
import { describe, expect, it } from "vitest";

import AgentRuntimeServiceSchema from "../src/services/features/telegram-mcp/agent-runtime.service";

function actionParams(name: string): unknown {
  const action = (
    AgentRuntimeServiceSchema.actions as Record<string, { params?: unknown }>
  )[name];
  if (!action?.params) {
    throw new Error(`Missing params schema for ${name}`);
  }
  return action.params;
}

describe("agent runtime Moleculer action schemas", () => {
  const broker = new ServiceBroker({ logger: false });

  it.each([
    ["listRemote", { session_id: "workspace" }],
    ["startRemote", { session_id: "workspace", agent_id: "codex" }],
    ["submitRemote", { session_id: "workspace", message: "Continue" }],
    ["stopRemote", { session_id: "workspace" }],
  ])("accepts the real %s request DTO", (actionName, params) => {
    const validate = broker.validator.compile(
      actionParams(actionName) as ServiceSchema,
    );

    expect(validate(params)).toBe(true);
  });

  it("requires the session id instead of a synthetic type field", () => {
    const validate = broker.validator.compile(
      actionParams("listRemote") as ServiceSchema,
    );

    expect(validate({ type: "object" })).not.toBe(true);
  });
});
