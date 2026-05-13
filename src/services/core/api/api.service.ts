// import Apollo from "@src/mixins/api/apollo";
import fs from "node:fs";
import path from "node:path";
import type { Context } from "moleculer";
import type { IncomingRequest, Route, ApiSettingsSchema } from "moleculer-web";
// eslint-disable-next-line no-duplicate-imports
import ApiGateway from "moleculer-web";
import Redis from "ioredis";
import mime from "mime-types";
import { RedisPubSub } from "graphql-redis-subscriptions";
import Apollo from "./mixins/apollo";
import routes from "./api.routes";
import { WebAppEvents } from "@src/lib/mixins/hooks/appEvent";
import { renderWorkbench } from "@src/lib/mixins/workbench";

const graphqlPublicRoot = path.resolve(__dirname, "../../../../public/graphql");
const workbenchPublicRoot = path.resolve(__dirname, "../../../../public/workbench");

const ApiService: ApiSettingsSchema = {
	name: "api",
	mixins: [ApiGateway, Apollo],

	dependencies: [],
	settings: {
		// Exposed port
		port: process.env.PORT !== null ? Number(process.env.PORT) : 3000,

		// Exposed IP
		ip: "0.0.0.0",

		path: "/",
		routes,

		log4XXResponses: false,
		logRequestParams: null,
		logResponseData: null,

		httpServerTimeout: null,

		cors: {
			origin: (process.env.ORIGINS || "").split(","),
			methods: ["GET", "OPTIONS", "POST", "PUT", "DELETE"],
			credentials: true,
		},

		assets: {
			folder: "public",
			// Options to `server-static` module
			options: {},
		},
		/*
		rateLimit: {
			// Глобальные настройки
			window: 60 * 1000, // 1 минута
			limit: 60, // максимум 30 запросов в окно
			headers: true, // возвращать заголовки Rate-Limit

			// Ключ для идентификации клиента (по умолчанию - IP)
			key: (req) => {
				const ip = req.headers["x-real-ip"] || req.headers["x-forwarded-for"];
				// console.log("***** CHECK RATE ", ip);
				return ip;
			},
		}, */
	},

	actions: {
		openWorkbench: {
			params: {
				spaPath: { type: "string", optional: true },
			},
			handler(ctx) {
				const html = renderWorkbench();
				ctx.meta.$responseHeaders = {
					"Content-Type": "text/html; charset=utf-8",
					"Cache-Control": "no-cache",
				};
				ctx.meta.$responseType = "text/html";
				return html;
			},
		},
		openWorkbenchAsset: {
			params: {
				assetPath: { type: "string" },
			},
			handler(ctx) {
				const relativeAssetPath = String(ctx.params.assetPath || "").trim();
				const normalizedAssetPath = path.posix.normalize(`/${relativeAssetPath}`).replace(/^\/+/, "");
				if (!normalizedAssetPath || normalizedAssetPath.startsWith("..") || normalizedAssetPath.includes("../")) {
					throw new Error("Invalid Workbench asset path");
				}

				const publicRoot = workbenchPublicRoot;
				const filePath = path.resolve(publicRoot, "assets", normalizedAssetPath);
				if (
					!filePath.startsWith(publicRoot) ||
					!fs.existsSync(filePath) ||
					!fs.statSync(filePath).isFile()
				) {
					throw new Error(`Workbench asset not found: ${normalizedAssetPath}`);
				}

				const contentType = mime.lookup(filePath) || "application/octet-stream";
				const fileBuffer = fs.readFileSync(filePath);

				ctx.meta.$responseHeaders = {
					"Content-Type": String(contentType),
					"Content-Length": String(fileBuffer.length),
					"Cache-Control": "public, max-age=31536000, immutable",
				};
				ctx.meta.$responseType = String(contentType);

				return fileBuffer;
			},
		},
		openGraphqlAsset: {
			params: {
				assetPath: { type: "string" },
			},
			handler(ctx) {
				const relativeAssetPath = String(ctx.params.assetPath || "").trim();
				const normalizedAssetPath = path.posix.normalize(`/${relativeAssetPath}`).replace(/^\/+/, "");
				if (!normalizedAssetPath || normalizedAssetPath.startsWith("..") || normalizedAssetPath.includes("../")) {
					throw new Error("Invalid GraphQL asset path");
				}

				const publicRoot = graphqlPublicRoot;
				const filePath = path.resolve(publicRoot, normalizedAssetPath);
				if (
					!filePath.startsWith(publicRoot) ||
					!fs.existsSync(filePath) ||
					!fs.statSync(filePath).isFile()
				) {
					throw new Error(`GraphQL asset not found: ${normalizedAssetPath}`);
				}

				const contentType = mime.lookup(filePath) || "application/octet-stream";
				const fileBuffer = fs.readFileSync(filePath);

				ctx.meta.$responseHeaders = {
					"Content-Type": String(contentType),
					"Content-Length": String(fileBuffer.length),
					"Cache-Control": "public, max-age=31536000, immutable",
				};
				ctx.meta.$responseType = String(contentType);

				return fileBuffer;
			},
		},
		webAppEvent: {
			graphql: {
				subscription: "webAppEvent:JSON",
				tags: [WebAppEvents.webAppEvent],
			},
			handler(ctx) {
				return ctx.params;
			},
		},
		backendEvent: {
			graphql: {
				subscription: "backendEvent(self:Boolean):JSON",
				tags: ["backendEvent"],
				filter: "api.userFilter",
			},
			handler(ctx) {
				return ctx.params;
			},
		},
		userFilter: {
			handler(ctx) {
				// console.log("USER_FILTER", ctx.params);
				// console.log("SUB", ctx.meta.user?.sub);
				if (ctx.params.self) {
					return ctx.params.self && ctx.params.payload.user_id === ctx.meta.user?.sub;
					// delete ctx.params.payload.user_id;
				}
				return true;
			},
		},
	},

	methods: {
		authenticate(ctx: Context<any, any>, route: Route, req: IncomingRequest) {},

		authorize(ctx: Context, route: Route, req: IncomingRequest) {},
		createPubSub() {
			return new RedisPubSub({
				publisher: new Redis({
					host: process.env.REDIS_HOST,
					port: +process.env.REDIS_PORT,
					username: process.env.REDIS_USER,
					password: process.env.REDIS_PASSWORD,
					db: +process.env.REDIS_DB || 10,
					connectionName: "GQL",
				}),
				subscriber: new Redis({
					host: process.env.REDIS_HOST,
					port: +process.env.REDIS_PORT,
					username: process.env.REDIS_USER,
					password: process.env.REDIS_PASSWORD,
					db: +process.env.REDIS_DB || 10,
					connectionName: "GQL",
				}),
				connectionListener: err => {
					if (!err) console.log("******************* CONNECTED *****************");
					else console.error(err);
				},
			});
		},
	},

	events: {
		"graphql.schema.updated": function ({ schema }) {
			// fs.writeFileSync(__dirname + "/generated-schema.gql", schema, "utf8");
			// console.log("Generated GraphQL schema", schema);
		},
	},
};

export default ApiService;
