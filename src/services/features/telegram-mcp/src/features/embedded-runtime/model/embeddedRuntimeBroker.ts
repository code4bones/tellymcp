import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { AppRuntime } from "../../../app/bootstrap/runtime";

export type EmbeddedRuntimeBrokerHandle = {
  broker: {
    call(actionName: string, params?: Record<string, unknown>): Promise<unknown>;
    stop(): Promise<void>;
    getLocalService(name: string): unknown;
  };
  runtime: AppRuntime;
};

type ServiceBrokerLike = new (config: Record<string, unknown>) => {
  createService(schema: unknown): void;
  call(actionName: string, params?: Record<string, unknown>): Promise<unknown>;
  start(): Promise<void>;
  stop(): Promise<void>;
  getLocalService(name: string): unknown;
};

function isSourceRuntimeMode(): boolean {
  return process.env.TELLYMCP_SOURCE_RUNTIME === "true";
}

function collectServiceSchemaFiles(
  rootDir: string,
  extension: ".service.js" | ".service.ts",
): string[] {
  const files: string[] = [];
  const stack = [rootDir];

  while (stack.length > 0) {
    const currentDir = stack.pop();
    if (!currentDir) {
      continue;
    }

    for (const entry of readdirSync(currentDir)) {
      const fullPath = path.join(currentDir, entry);
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (stat.isFile() && entry.endsWith(extension)) {
        files.push(fullPath);
      }
    }
  }

  return files.sort((left, right) => left.localeCompare(right));
}

function unwrapCjsDefault(value: unknown): unknown {
  let current = value;

  while (
    current &&
    typeof current === "object" &&
    "default" in (current as Record<string, unknown>) &&
    Object.keys(current as Record<string, unknown>).length <= 3
  ) {
    const next = (current as Record<string, unknown>).default;
    if (next === current || next == null) {
      break;
    }
    current = next;
  }

  return current;
}

function resolveServiceSchemaExport(moduleNamespace: Record<string, unknown>): unknown {
  const unwrappedModule = unwrapCjsDefault(moduleNamespace);
  if (
    unwrappedModule &&
    typeof unwrappedModule === "object" &&
    "name" in (unwrappedModule as Record<string, unknown>)
  ) {
    return unwrappedModule;
  }

  if (
    unwrappedModule &&
    typeof unwrappedModule === "object" &&
    "default" in (unwrappedModule as Record<string, unknown>)
  ) {
    return unwrapCjsDefault((unwrappedModule as Record<string, unknown>).default);
  }

  return unwrappedModule;
}

export async function createEmbeddedRuntimeBroker(input: {
  envPath: string;
  packageRoot: string;
  standaloneHttp: boolean;
}): Promise<EmbeddedRuntimeBrokerHandle> {
  process.env.ENV_FILE = input.envPath;
  process.env.TELLYMCP_STANDALONE_HTTP = input.standaloneHttp ? "true" : "false";

  const sourceRuntime = isSourceRuntimeMode();
  const brokerConfigPath = sourceRuntime
    ? path.join(input.packageRoot, "src", "moleculer.config.ts")
    : path.join(input.packageRoot, "dist", "moleculer.config.js");
  const servicesRoot = sourceRuntime
    ? path.join(input.packageRoot, "src", "services", "features", "telegram-mcp")
    : path.join(input.packageRoot, "dist", "services", "features", "telegram-mcp");
  const serviceExtension = sourceRuntime ? ".service.ts" : ".service.js";

  const { ServiceBroker } = (await import("moleculer")) as unknown as {
    ServiceBroker: ServiceBrokerLike;
  };
  const brokerConfigModule = (await import(
    pathToFileURL(brokerConfigPath).href
  )) as Record<string, unknown>;
  const brokerConfig = unwrapCjsDefault(brokerConfigModule) as Record<string, unknown>;

  const broker = new ServiceBroker(brokerConfig);
  const serviceFiles = collectServiceSchemaFiles(servicesRoot, serviceExtension);

  for (const serviceFile of serviceFiles) {
    const serviceModule = (await import(pathToFileURL(serviceFile).href)) as Record<
      string,
      unknown
    >;
    const schema = resolveServiceSchemaExport(serviceModule);
    broker.createService(schema);
  }

  await broker.start();

  const runtimeService = broker.getLocalService("telegramMcp.runtime") as
    | {
        waitUntilReady(): Promise<AppRuntime>;
      }
    | undefined;

  if (!runtimeService?.waitUntilReady) {
    await broker.stop();
    throw new Error("Embedded runtime service is unavailable");
  }

  const runtime = await runtimeService.waitUntilReady();
  return { broker, runtime };
}
