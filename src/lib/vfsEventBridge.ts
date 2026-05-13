import * as redis from "redis";

const VFS_EVENT_BRIDGE_CHANNEL = String(
	process.env.VFS_EVENT_BRIDGE_CHANNEL || "vfs:event-bridge"
).trim();

export type VfsBridgePayload = {
	changed?: Record<string, unknown> | null;
	nodeChanged?: Record<string, unknown> | null;
};

type BridgeRedisClient = ReturnType<typeof redis.createClient>;

let publisherClient: BridgeRedisClient | null = null;
let publisherConnectPromise: Promise<BridgeRedisClient> | null = null;
let subscriberClient: BridgeRedisClient | null = null;
let subscriberConnectPromise: Promise<BridgeRedisClient> | null = null;

const createBridgeClient = (name: string) =>
	redis.createClient({
		socket: {
			host: process.env.REDIS_HOST || "localhost",
			port: +(process.env.REDIS_PORT || 6379),
		},
		database: +(process.env.REDIS_DB || 0),
		name,
	});

const getPublisherClient = async () => {
	if (publisherClient?.isOpen) {
		return publisherClient;
	}
	if (!publisherClient) {
		publisherClient = createBridgeClient(
			`${process.env.APP_NAME || process.env.APPNAME || "app"}:vfs-bridge:pub`
		);
	}
	if (!publisherConnectPromise) {
		publisherConnectPromise = publisherClient
			.connect()
			.then(() => publisherClient as BridgeRedisClient);
	}
	try {
		return await publisherConnectPromise;
	} finally {
		publisherConnectPromise = null;
	}
};

const getSubscriberClient = async () => {
	if (subscriberClient?.isOpen) {
		return subscriberClient;
	}
	if (!subscriberClient) {
		subscriberClient = createBridgeClient(
			`${process.env.APP_NAME || process.env.APPNAME || "app"}:vfs-bridge:sub`
		);
	}
	if (!subscriberConnectPromise) {
		subscriberConnectPromise = subscriberClient
			.connect()
			.then(() => subscriberClient as BridgeRedisClient);
	}
	try {
		return await subscriberConnectPromise;
	} finally {
		subscriberConnectPromise = null;
	}
};

export const publishVfsBridgeEvent = async (payload: VfsBridgePayload) => {
	if (!payload?.changed && !payload?.nodeChanged) {
		return false;
	}
	const client = await getPublisherClient();
	await client.publish(VFS_EVENT_BRIDGE_CHANNEL, JSON.stringify(payload));
	return true;
};

export const subscribeVfsBridgeEvents = async (
	handler: (payload: VfsBridgePayload) => void | Promise<void>
) => {
	const client = await getSubscriberClient();
	await client.subscribe(VFS_EVENT_BRIDGE_CHANNEL, async raw => {
		if (!raw) {
			return;
		}
		try {
			const payload = JSON.parse(raw) as VfsBridgePayload;
			if (!payload || typeof payload !== "object") {
				return;
			}
			await handler(payload);
		} catch {
			return;
		}
	});
	return async () => {
		if (!subscriberClient?.isOpen) {
			return;
		}
		await subscriberClient.unsubscribe(VFS_EVENT_BRIDGE_CHANNEL).catch(() => null);
	};
};

export const isDetachedWorkerProcess = () =>
	Boolean(
		process.env.TRANSCODER_WORKER_JOB_ID ||
			process.env.MINIO_TILE_DELETE_JOB_ID ||
			process.env.MIGRATION_WORKER_RUN_ID
	);
