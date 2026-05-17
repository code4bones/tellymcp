import type { Context } from "moleculer";
import type { ExtendedMeta, TracerSchema } from "./moleculer";

type TraceLevel = "fatal" | "error" | "warn" | "info" | "debug" | "trace";

const TRACE_MAX_DEPTH = 4;
const TRACE_MAX_ARRAY = 25;
const TRACE_MAX_KEYS = 40;
const TRACE_MAX_STRING = 1000;

const truncateString = (value: string) =>
	value.length > TRACE_MAX_STRING ? `${value.slice(0, TRACE_MAX_STRING)}...` : value;

export const normalizeTraceLevel = (value: unknown): TraceLevel => {
	const level = String(value || "info").toLowerCase();
	if (["fatal", "error", "warn", "info", "debug", "trace"].includes(level)) {
		return level as TraceLevel;
	}
	return "info";
};

const sanitizeError = (error: unknown, depth: number, seen: WeakSet<object>) => {
	if (!(error instanceof Error)) {
		return sanitizeTraceValue(error, depth, seen);
	}
	return {
		name: error.name,
		message: truncateString(error.message || ""),
		stack: truncateString(error.stack || ""),
	};
};

export const sanitizeTraceValue = (
	value: unknown,
	depth = 0,
	seen: WeakSet<object> = new WeakSet()
): unknown => {
	if (value == null || typeof value === "boolean" || typeof value === "number") {
		return value;
	}
	if (typeof value === "string") {
		return truncateString(value);
	}
	if (typeof value === "bigint") {
		return value.toString();
	}
	if (typeof value === "symbol") {
		return value.toString();
	}
	if (typeof value === "function") {
		return `[Function ${value.name || "anonymous"}]`;
	}
	if (value instanceof Date) {
		return value.toISOString();
	}
	if (value instanceof Error) {
		return sanitizeError(value, depth, seen);
	}
	if (Buffer.isBuffer(value)) {
		return `[Buffer ${value.length}]`;
	}
	if (value instanceof Set) {
		return {
			type: "Set",
			size: value.size,
			values: Array.from(value.values())
				.slice(0, TRACE_MAX_ARRAY)
				.map(item => sanitizeTraceValue(item, depth + 1, seen)),
		};
	}
	if (value instanceof Map) {
		return {
			type: "Map",
			size: value.size,
			entries: Array.from(value.entries())
				.slice(0, TRACE_MAX_ARRAY)
				.map(([key, item]) => [
					sanitizeTraceValue(key, depth + 1, seen),
					sanitizeTraceValue(item, depth + 1, seen),
				]),
		};
	}
	if (Array.isArray(value)) {
		if (depth >= TRACE_MAX_DEPTH) {
			return `[Array(${value.length})]`;
		}
		return value
			.slice(0, TRACE_MAX_ARRAY)
			.map(item => sanitizeTraceValue(item, depth + 1, seen));
	}
	if (typeof value === "object") {
		const objectValue = value as Record<string, unknown>;
		if (seen.has(objectValue)) {
			return "[Circular]";
		}
		seen.add(objectValue);
		if (depth >= TRACE_MAX_DEPTH) {
			return `[${objectValue?.constructor?.name || "Object"}]`;
		}
		const keys = Object.keys(objectValue).slice(0, TRACE_MAX_KEYS);
		const result: Record<string, unknown> = {};
		for (const key of keys) {
			result[key] = sanitizeTraceValue(objectValue[key], depth + 1, seen);
		}
		if (Object.keys(objectValue).length > TRACE_MAX_KEYS) {
			result.__truncatedKeys = Object.keys(objectValue).length - TRACE_MAX_KEYS;
		}
		return result;
	}
	return String(value);
};

const pickFields = (source: unknown, fields: boolean | string[] | undefined) => {
	if (fields === false) {
		return undefined;
	}
	if (fields === true || fields == null) {
		return sanitizeTraceValue(source);
	}
	if (!source || typeof source !== "object") {
		return sanitizeTraceValue(source);
	}
	const result: Record<string, unknown> = {};
	for (const key of fields) {
		result[key] = sanitizeTraceValue((source as Record<string, unknown>)[key]);
	}
	return result;
};

export const buildTraceMetaSummary = (ctx: Context<any, ExtendedMeta>) =>
	sanitizeTraceValue({
		requestID: ctx.requestID || null,
		userSub: ctx.meta?.user?.sub || null,
	});

export const buildTraceStartData = (
	ctx: Context<any, ExtendedMeta>,
	actionName: string,
	tracer?: TracerSchema,
	startedSession = false
) =>
	sanitizeTraceValue({
		action: actionName,
		startedSession,
		params: pickFields(ctx.params, tracer?.captureParams),
		meta: buildTraceMetaSummary(ctx),
	});

export const buildTraceSuccessData = (
	ctx: Context<any, ExtendedMeta>,
	actionName: string,
	result: unknown,
	durationMs: number,
	tracer?: TracerSchema
) =>
	sanitizeTraceValue({
		action: actionName,
		durationMs,
		result:
			tracer?.captureResult === undefined
				? undefined
				: pickFields(result, tracer.captureResult),
	});

export const buildTraceErrorData = (
	ctx: Context<any, ExtendedMeta>,
	actionName: string,
	error: unknown,
	durationMs: number,
	tracer?: TracerSchema
) =>
	sanitizeTraceValue({
		action: actionName,
		durationMs,
		error:
			tracer?.captureError === undefined
				? sanitizeError(error, 0, new WeakSet())
				: pickFields(error, tracer.captureError),
		meta: buildTraceMetaSummary(ctx),
	});
