/* eslint-disable no-control-regex */
import { Loggers } from "moleculer";
import { logFeedStore, stringifyLogArgs, type LogFeedLevel } from "../logfeed/store";

const LEVELS: LogFeedLevel[] = ["fatal", "error", "warn", "info", "debug", "trace"];

type LoggerBindingsLike = {
	mod?: string | null;
	nodeID?: string | null;
	ns?: string | null;
	svc?: string | null;
};

class LogFeedLogger extends (Loggers.Base as unknown as new (...args: any[]) => any) {
	getLogHandler(bindings?: LoggerBindingsLike): ((type: string, args: unknown[]) => void) | null {
		const level = bindings ? (this as any).getLogLevel?.(bindings.mod) : null;
		if (!level) return null;

		const levelIdx = LEVELS.indexOf(level as LogFeedLevel);

		return (type: string, args: unknown[]) => {
			const typeIdx = LEVELS.indexOf(type as LogFeedLevel);
			if (typeIdx > levelIdx || !args?.length) return;

			const message = stringifyLogArgs(args);
			if (message.includes("graphql.publish")) {
				return;
			}

			logFeedStore.push({
				ts: Date.now(),
				level: type as LogFeedLevel,
				module: bindings?.mod?.toUpperCase?.() || null,
				nodeID: bindings?.nodeID || null,
				namespace: bindings?.ns || null,
				svc: bindings?.svc || null,
				message,
			});
		};
	}
}

export { LogFeedLogger };
