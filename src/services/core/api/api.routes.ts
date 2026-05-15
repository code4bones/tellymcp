import { IncomingHttpHeaders, IncomingMessage, OutgoingMessage } from "http";
import { Context, Errors } from "moleculer";
import { ApiRouteSchema } from "moleculer-web";
import { useSessionMiddleware, onBeforeCall } from "./mixins/session";
import {
	TELEGRAM_MCP_HTTP_SERVICE_NAME,
	type TelegramMcpHttpServiceInstance,
} from "../../features/telegram-mcp/mcp-http.service";

declare module "moleculer-web" {
	export interface IncomingRequest {
		access_token: string;
	}
}

export interface IAuthMeta {
	$headers: IncomingHttpHeaders;
	$cookies: Record<string, string>;
	$session: unknown;
	$response: OutgoingMessage;
	$request: IncomingMessage;
	access_token: string;
}

export type IAuthContext = Context<unknown, IAuthMeta>;

const rootPrefix = process.env.ROOT_PREFIX || "/api";

function trimTrailingSlashes(value: string): string {
	return value.replace(/\/+$/u, "");
}

function createTelegramMcpAliasHandler(routeBasePath: string) {
	return function (
		this: {
			broker: { getLocalService: (name: string) => unknown };
			logger?: { debug?: (...args: unknown[]) => void };
		},
		req: IncomingMessage & { originalUrl?: string; parsedUrl?: string },
		res: OutgoingMessage,
		next: (error?: unknown) => void
	): void {
		const service = this.broker.getLocalService(
			TELEGRAM_MCP_HTTP_SERVICE_NAME,
		) as TelegramMcpHttpServiceInstance | null;

		if (!service?.routeRequest) {
			next(
				new Errors.MoleculerServerError(
					`Local service '${TELEGRAM_MCP_HTTP_SERVICE_NAME}' is unavailable`,
				),
			);
			return;
		}

		const rawPath =
			req.parsedUrl && req.parsedUrl.startsWith("/")
				? req.parsedUrl
				: req.originalUrl && req.originalUrl.startsWith("/")
					? req.originalUrl
					: req.url ?? "/";
		const normalizedBasePath = trimTrailingSlashes(routeBasePath) || "/";
		const normalizedRelativePath =
			rawPath === "/"
				? ""
				: rawPath.startsWith("/")
					? rawPath
					: `/${rawPath}`;
		const fullPath = normalizedRelativePath.startsWith(`${normalizedBasePath}/`) ||
			normalizedRelativePath === normalizedBasePath
			? normalizedRelativePath
			: normalizedBasePath === "/"
				? normalizedRelativePath || "/"
				: `${normalizedBasePath}${normalizedRelativePath}` || normalizedBasePath;
		const requestUrl = new URL(fullPath, "http://gateway.local");
		this.logger?.debug?.("telegram_mcp gateway alias matched", {
			method: req.method,
			routeBasePath: normalizedBasePath,
			rawPath,
			fullPath: requestUrl.pathname,
		});

		void service.routeRequest(req, res as never, requestUrl.pathname).catch(
			(error) => next(error),
		);
	};
}

const routes: ApiRouteSchema[] = [
	{
		path: `${rootPrefix}/healthz`,
		authorization: false,
		authentication: false,
		bodyParsers: {
			json: false,
			urlencoded: false,
		},
		aliases: {
			"GET /": createTelegramMcpAliasHandler(`${rootPrefix}/healthz`),
		},
		mappingPolicy: "restrict",
		logging: false,
	},
	{
		path: `${rootPrefix}/mcp`,
		authorization: false,
		authentication: false,
		bodyParsers: {
			json: {
				strict: false,
				limit: "1MB",
			},
			urlencoded: false,
		},
		aliases: {
			"GET /": createTelegramMcpAliasHandler(`${rootPrefix}/mcp`),
			"POST /": createTelegramMcpAliasHandler(`${rootPrefix}/mcp`),
			"DELETE /": createTelegramMcpAliasHandler(`${rootPrefix}/mcp`),
		},
		mappingPolicy: "restrict",
		logging: false,
	},
	{
		path: `${rootPrefix}/webapp`,
		authorization: false,
		authentication: false,
		bodyParsers: {
			json: false,
			urlencoded: false,
		},
		aliases: {
			"GET /": createTelegramMcpAliasHandler(`${rootPrefix}/webapp`),
			"GET /app.js": createTelegramMcpAliasHandler(`${rootPrefix}/webapp`),
			"GET /styles.css": createTelegramMcpAliasHandler(`${rootPrefix}/webapp`),
			"GET /live/:sessionId": createTelegramMcpAliasHandler(`${rootPrefix}/webapp`),
			"POST /api/bootstrap": createTelegramMcpAliasHandler(`${rootPrefix}/webapp`),
			"GET /api/view": createTelegramMcpAliasHandler(`${rootPrefix}/webapp`),
			"POST /api/action": createTelegramMcpAliasHandler(`${rootPrefix}/webapp`),
		},
		mappingPolicy: "restrict",
		logging: false,
	},
	{
		path: `${rootPrefix}/gateway`,
		authorization: false,
		authentication: false,
		bodyParsers: {
			json: false,
			urlencoded: false,
		},
		aliases: {
			"GET /:resourcePath(.*)": createTelegramMcpAliasHandler(`${rootPrefix}/gateway`),
			"POST /:resourcePath(.*)": createTelegramMcpAliasHandler(`${rootPrefix}/gateway`),
		},
		mappingPolicy: "restrict",
		logging: false,
	},
	{
		path: "/mgr/assets",
		use: useSessionMiddleware,
		authorization: false,
		authentication: false,
		onBeforeCall: onBeforeCall(false),
		bodyParsers: {
			json: false,
			urlencoded: false,
		},
		aliases: {
			"GET /:assetPath(.*)": "api.openWorkbenchAsset",
		},
		mappingPolicy: "restrict",
		logging: true,
	},
	{
		path: "/mgr",
		use: useSessionMiddleware,
		authorization: false,
		authentication: false,
		onBeforeCall: onBeforeCall(false),
		bodyParsers: {
			json: false,
			urlencoded: false,
		},
		aliases: {
			"GET /": "api.openWorkbench",
			"GET /:spaPath(.*)": "api.openWorkbench",
		},
		mappingPolicy: "restrict",
		logging: true,
	},
	{
		path: `${rootPrefix}/graphql-assets`,
		use: useSessionMiddleware,
		authorization: false,
		authentication: false,
		onBeforeCall: onBeforeCall(false),
		bodyParsers: {
			json: false,
			urlencoded: false,
		},
		aliases: {
			"GET /:assetPath(.*)": "api.openGraphqlAsset",
		},
		mappingPolicy: "restrict",
		logging: true,
	},
	{
		path: rootPrefix,
		whitelist: ["**"],
		use: useSessionMiddleware,
		mergeParams: true,
		authentication: false,
		authorization: false,
		autoAliases: true,
		/*
		onError(req, res, error: Errors.MoleculerError) {
			console.error("API Error:", error);
			res.setHeader("Content-Type", "application/json");
			res.writeHead(error.code || 500);
			res.end(JSON.stringify({ error: error.message, code: error.code, type: error.type }));
		},*/
		onBeforeCall: onBeforeCall(false),
		bodyParsers: {
			json: {
				strict: false,
				limit: "1MB",
			},
			urlencoded: {
				extended: true,
				limit: "1MB",
			},
		},
		mappingPolicy: "all", // Available values: "all", "restrict"
		logging: true,
	},
];

export default routes;
