/* eslint-disable no-console */

import type { MetricRegistry } from "moleculer";
// eslint-disable-next-line no-duplicate-imports
import { Errors } from "moleculer";
import env from "dotenv";
import "module-alias/register";
import pino from "pino";
import { LogFeedLogger } from "./lib/mixins/logfeed";
import { BackendError, wrapUnhandledBackendError } from "./lib/mixins/session.errors";
import { createPinoTargets } from "./lib/pinoTargets";

env.config({ path: process.env.ENV_FILE ?? ".env" });

/**
 * Moleculer ServiceBroker configuration file 1
 *
 * More info about options:
 *     https://moleculer.services/docs/0.14/configuration.html
 *
 *
 * Overwriting options in production:
 * ================================
 *    You can overwrite any option with environment variables.
 *    For example to overwrite the "logLevel" value, use `LOGLEVEL=warn` env var.
 *    To overwrite a nested parameter, e.g. retryPolicy.retries, use `RETRYPOLICY_RETRIES=10` env var.
 *
 *    To overwrite broker’s deeply nested default options, which are not presented in "moleculer.config.js",
 *    use the `MOL_` prefix and double underscore `__` for nested properties in .env file.
 *    For example, to set the cacher prefix to `MYCACHE`, you should declare an env var as `MOL_CACHER__OPTIONS__PREFIX=mycache`.
 *  It will set this:
 *  {
 *    cacher: {
 *      options: {
 *        prefix: "mycache"
 *      }
 *    }
 *  }
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const configuredTransport = process.env.TRANSPORT?.trim();

const pinoTransport = pino.transport({
	targets: createPinoTargets({
		level: process.env.LOG_LEVEL || "info",
		fileEnabled: process.env.LOG_FILE_ENABLED === "true",
		filePath: process.env.LOG_FILE_PATH || ".tellymcp/log.jsonl",
	}),
});

const logger: any = [
	{
		type: "Pino",
		options: {
			pino: {
				options: {
					name: "tellymcp-broker",
					level: process.env.LOG_LEVEL || "info",
					timestamp: pino.stdTimeFunctions.isoTime,
				},
				destination: pinoTransport,
			},
		},
	},
];

const metricsEnabled = process.env.MOLECULER_METRICS === "true";
const metricsPort = +(process.env.METRICS_PORT || 3030);
const metricsPath = process.env.METRICS_PATH || "/metrics";
const logFeedEnabled =
	process.env.ENABLE_LOGFEED != null
		? !["0", "false", "no", "off"].includes(process.env.ENABLE_LOGFEED.toLowerCase())
		: process.env.LOGFEED_ENABLED !== "false";

if (logFeedEnabled) {
	logger.push(
		new (LogFeedLogger as any)({
			level: process.env.LOGFEED_LEVEL || process.env.LOG_LEVEL || "info",
		})
	);
}

const brokerConfig: any = {
	// Namespace of nodes to segment your nodes on the same network.
	namespace: process.env.NAMESPACE,
	// Unique node identifier. Must be unique in a namespace.
	nodeID: process.env.NODE_ID,
	// Custom metadata store. Store here what you want. Accessing: `this.broker.metadata`
	metadata: {},

	// Enable/disable logging or use custom logger. More info: https://moleculer.services/docs/0.14/logging.html
	// Available logger types: "Console", "File", "Pino", "Winston", "Bunyan", "debug", "Log4js", "Datadog"
	logger,
	// Default log level for built-in console logger. It can be overwritten in logger options above.
	// Available values: trace, debug, info, warn, error, fatal
	logLevel: process.env.LOG_LEVEL || "info",

	// Define transporter only when explicitly requested.
	// For TellyMCP gateway/client nodes we use our own WS/HTTP control plane,
	// so Moleculer UDP/TCP discovery is unnecessary and only adds noisy multicast warnings.
	...(configuredTransport ? { transporter: configuredTransport } : {}),

	// Define a cacher.
	// More info: https://moleculer.services/docs/0.14/caching.html
	// cacher:false,

	cacher: false,

	// Define a serializer.
	// Available values: "JSON", "Avro", "ProtoBuf", "MsgPack", "Notepack", "Thrift".
	// More info: https://moleculer.services/docs/0.14/networking.html#Serialization
	serializer: "JSON",

	// Number of milliseconds to wait before reject a request with a RequestTimeout error. Disabled: 0
	requestTimeout: 0, // 0 , 10 * 60 * 1000,

	// Retry policy settings. More info: https://moleculer.services/docs/0.14/fault-tolerance.html#Retry
	retryPolicy: {
		// Enable feature
		enabled: false,
		// Count of retries
		retries: 5,
		// First delay in milliseconds.
		delay: 100,
		// Maximum delay in milliseconds.
		maxDelay: 1000,
		// Backoff factor for delay. 2 means exponential backoff.
		factor: 2,
		// A function to check failed requests.
		check: (err: Error) => err && err instanceof Errors.MoleculerRetryableError && !!err.retryable,
	},

	// Limit of calling level. If it reaches the limit, broker will throw an MaxCallLevelError error. (Infinite loop protection)
	maxCallLevel: 100,

	// Number of seconds to send heartbeat packet to other nodes.
	heartbeatInterval: 10,
	// Number of seconds to wait before setting node to unavailable status.
	heartbeatTimeout: 30,

	// Cloning the params of context if enabled. High performance impact, use it with caution!
	contextParamsCloning: false,

	// Tracking requests and waiting for running requests before shuting down. More info: https://moleculer.services/docs/0.14/context.html#Context-tracking
	tracking: {
		// Enable feature
		enabled: false,
		// Number of milliseconds to wait before shuting down the process.
		shutdownTimeout: 5000,
	},

	// Disable built-in request & emit balancer. (Transporter must support it, as well.). More info: https://moleculer.services/docs/0.14/networking.html#Disabled-balancer
	disableBalancer: false,

	// Settings of Service Registry. More info: https://moleculer.services/docs/0.14/registry.html
	registry: {
		// Define balancing strategy. More info: https://moleculer.services/docs/0.14/balancing.html
		// Available values: "RoundRobin", "Random", "CpuUsage", "Latency", "Shard"
		strategy: "RoundRobin",
		// Enable local action call preferring. Always call the local action instance if available.
		preferLocal: true,
	},

	// Settings of Circuit Breaker. More info: https://moleculer.services/docs/0.14/fault-tolerance.html#Circuit-Breaker
	circuitBreaker: {
		// Enable feature
		enabled: false,
		// Threshold value. 0.5 means that 50% should be failed for tripping.
		threshold: 0.5,
		// Minimum request count. Below it, CB does not trip.
		minRequestCount: 20,
		// Number of seconds for time window.
		windowTime: 60,
		// Number of milliseconds to switch from open to half-open state
		halfOpenTime: 10 * 1000,
		// A function to check failed requests.
		check: (err: Error) => err && err instanceof Errors.MoleculerError && err.code >= 500,
	},

	// Settings of bulkhead feature. More info: https://moleculer.services/docs/0.14/fault-tolerance.html#Bulkhead
	bulkhead: {
		// Enable feature.
		enabled: false,
		// Maximum concurrent executions.
		concurrency: 10,
		// Maximum size of queue
		maxQueueSize: 100,
	},

	// Enable action & event parameter validation. More info: https://moleculer.services/docs/0.14/validating.html
	validator: true,

	errorHandler: (
		err: unknown,
		{ ctx, service }: { ctx: unknown; service: unknown }
	) => {
		if (err instanceof BackendError) {
			return err;
		} else if (err instanceof Error) {
			const rawName =
				(ctx as any)?.action?.rawName ||
				(ctx as any)?.action?.name ||
				(service as any)?.name ||
				"UNKNOWN";
			return wrapUnhandledBackendError(err, String(rawName));
		}
		return err;
	},

	// Enable/disable built-in metrics function. More info: https://moleculer.services/docs/0.14/metrics.html
	metrics: {
		enabled: metricsEnabled,
		// Available built-in reporters: "Console", "CSV", "Event", "Prometheus", "Datadog", "StatsD"
		reporter: {
			type: "Prometheus",
			options: {
				// HTTP port
				port: metricsPort,
				// HTTP URL path
				path: metricsPath,
				// Default labels which are appended to all metrics labels
				defaultLabels: (registry: MetricRegistry) => ({
					namespace: registry.broker.namespace,
					nodeID: registry.broker.nodeID,
				}),
			},
		},
	},

	// Enable built-in tracing function. More info: https://moleculer.services/docs/0.14/tracing.html
	tracing: {
		enabled: process.env.MOLECULER_TRACE,
		// Available built-in exporters: "Console", "Datadog", "Event", "EventLegacy", "Jaeger", "Zipkin"
		exporter: {
			type: "Console", // Console exporter is only for development!
			options: {
				// Custom logger
				logger: null,
				// Using colors
				colors: true,
				// Width of row
				width: 100,
				// Gauge width in the row
				gaugeWidth: 40,
			},
		},
	},

	// Register custom middlewares
	middlewares: [],

	// Register custom REPL commands.
	replCommands: null,

	// Called after broker created.
	// created(broker: ServiceBroker): void {},

	// Called after broker stopped.
	// async stopped(broker: ServiceBroker): Promise<void> {},
};

export default brokerConfig;
