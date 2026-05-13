import * as redis from "redis";
import { sanitizeTraceValue } from "./trace";

const TRACE_CONTEXT_TTL_SEC = Math.max(1, Number(process.env.TRACE_CONTEXT_TTL_SEC || 2));
const TRACE_CONTEXT_KEY = "trace:active";

export type TraceContextPayload = {
	sessionId: string;
	name?: string | null;
	tag?: string | null;
	rootAction?: string | null;
	startedBy?: string | null;
};
type TraceRedisClient = ReturnType<typeof redis.createClient>;

let traceRedisClient: TraceRedisClient | null = null;
let traceRedisConnectPromise: Promise<TraceRedisClient> | null = null;

const createTraceRedisClient = () =>
	redis.createClient({
		socket: {
			host: process.env.REDIS_HOST || "localhost",
			port: +(process.env.REDIS_PORT || 6379),
		},
		database: +(process.env.REDIS_DB || 0),
		name: `${process.env.APP_NAME || process.env.APPNAME || "app"}:trace`,
	});

const getTraceRedisClient = async () => {
	if (traceRedisClient?.isOpen) {
		return traceRedisClient;
	}
	if (!traceRedisClient) {
		traceRedisClient = createTraceRedisClient();
	}
	if (!traceRedisConnectPromise) {
		traceRedisConnectPromise = traceRedisClient.connect().then(() => traceRedisClient as TraceRedisClient);
	}
	try {
		return await traceRedisConnectPromise;
	} finally {
		traceRedisConnectPromise = null;
	}
};

export const saveTraceContext = async (trace: TraceContextPayload | null | undefined) => {
	if (!trace?.sessionId) {
		return false;
	}
	const client = await getTraceRedisClient();
	await client.setEx(TRACE_CONTEXT_KEY, TRACE_CONTEXT_TTL_SEC, JSON.stringify(sanitizeTraceValue(trace)));
	return true;
};

export const loadTraceContext = async () => {
	const client = await getTraceRedisClient();
	const raw = await client.get(TRACE_CONTEXT_KEY);
	if (!raw) {
		return null;
	}
	try {
		const parsed = JSON.parse(Buffer.isBuffer(raw) ? raw.toString("utf-8") : String(raw));
		if (!parsed || typeof parsed !== "object") {
			return null;
		}
		return {
			sessionId: String((parsed as any).sessionId || ""),
			name: (parsed as any).name || null,
			tag: (parsed as any).tag || null,
			rootAction: (parsed as any).rootAction || null,
			startedBy: (parsed as any).startedBy || null,
		} satisfies TraceContextPayload;
	} catch {
		return null;
	}
};

export const touchTraceContext = async () => {
	const client = await getTraceRedisClient();
	const exists = await client.exists(TRACE_CONTEXT_KEY);
	if (!exists) {
		return false;
	}
	await client.expire(TRACE_CONTEXT_KEY, TRACE_CONTEXT_TTL_SEC);
	return true;
};

export const deleteTraceContext = async () => {
	const client = await getTraceRedisClient();
	await client.del(TRACE_CONTEXT_KEY);
	return true;
};
