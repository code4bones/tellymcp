import { EventEmitter } from "node:events";
import { inspect } from "node:util";

export type LogFeedLevel = "fatal" | "error" | "warn" | "info" | "debug" | "trace";

export type LogFeedEntry = {
	id: string;
	seq: number;
	ts: number;
	level: LogFeedLevel;
	module: string | null;
	nodeID: string | null;
	namespace: string | null;
	svc: string | null;
	message: string;
};

type LogFeedEntryInput = Omit<LogFeedEntry, "id" | "seq">;

const DEFAULT_BUFFER_SIZE = +(process.env.LOGFEED_BUFFER_SIZE || 500);
const ANSI_PATTERN = /\u001b\[.*?m/g;

class LogFeedStore extends EventEmitter {
	buffer: LogFeedEntry[] = [];

	maxSize: number;

	seq = 0;

	constructor(maxSize = DEFAULT_BUFFER_SIZE) {
		super();
		this.maxSize = Number.isFinite(maxSize) && maxSize > 0 ? maxSize : DEFAULT_BUFFER_SIZE;
	}

	push(entry: LogFeedEntryInput) {
		const nextSeq = ++this.seq;
		const item: LogFeedEntry = {
			id: `${entry.ts}-${nextSeq}`,
			seq: nextSeq,
			...entry,
		};

		this.buffer.push(item);
		if (this.buffer.length > this.maxSize) {
			this.buffer.splice(0, this.buffer.length - this.maxSize);
		}

		this.emit("entry", item);
		return item;
	}

	list(limit = 200) {
		const normalizedLimit = Number.isFinite(limit) && limit > 0 ? Math.min(limit, this.maxSize) : 200;
		return this.buffer.slice(-normalizedLimit);
	}
}

export const stringifyLogArgs = (args: unknown[]) =>
	args
		.map(arg => {
			if (arg == null) {
				return "<null>";
			}

			if (typeof arg === "string") {
				return arg.replace(ANSI_PATTERN, "");
			}

			return `\r\n${inspect(arg, {
				showHidden: false,
				depth: 4,
				compact: false,
				breakLength: Number.POSITIVE_INFINITY,
			})}`;
		})
		.join(" ");

export const logFeedStore = new LogFeedStore();
