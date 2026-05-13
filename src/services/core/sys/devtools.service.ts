import { GQLSchema } from "@src/lib/moleculer";
import { DBMixin } from "@src/lib/mixins/db";
import IORedis from "ioredis";
import {
	refreshToken,
	requireActiveToken,
	getRedisSID,
	sessionFromRedis,
	SESSION_PRESET,
} from "../api/mixins/session";

const ENV_WHITELIST = [
	"APPNAME",
	"NODE_ENV",
	"NAMESPACE",
	"DOMAIN",
	"APIS",
	"ROOT_PREFIX",
	"PORT",
	"ORIGINS",
	"SESSION_PRESET",
	"DB_HOST",
	"DB_PORT",
	"DB_NAME",
	"REDIS_HOST",
	"REDIS_PORT",
	"REDIS_DB",
	"MINIO_ENDPOINT",
	"MINIO_PORT",
	"MINIO_USE_SSL",
	"MINIO_REGION",
	"MINIO_BUCKET",
	"KC_URI",
	"KC_REALM",
	"KC_CLIENT_ID",
	"KC_POST_LOGIN_REDIRECT",
	"KC_POST_LOGOUT_REDIRECT",
	"HTTPS",
	"TILES",
	"LOG_LEVEL",
];

const devtoolsService: GQLSchema = {
	name: "devtools",
	mixins: [DBMixin],
	hooks: {
		before: {
			"*": [refreshToken, requireActiveToken],
		},
	},
	actions: {
		services: {
			graphql: {
				query: "devtoolsServices:JSON",
			},
			handler() {
				return this.getServicesOverview();
			},
		},
		runAction: {
			graphql: {
				mutation: "devtoolsRunAction(name:String!,params:JSON,meta:JSON):JSON",
			},
			async handler(ctx) {
				const { name, params = {}, meta = {} } = ctx.params;
				const startedAt = Date.now();
				try {
					const result = await ctx.call(name, params, {
						parentCtx: ctx,
						meta,
					});
					return {
						ok: true,
						name,
						durationMs: Date.now() - startedAt,
						result: this.toJsonSafe(result),
					};
				} catch (error: any) {
					return {
						ok: false,
						name,
						durationMs: Date.now() - startedAt,
						error: {
							message: error?.message || "Unknown error",
							code: error?.code,
							type: error?.type,
							data: this.toJsonSafe(error?.data),
						},
					};
				}
			},
		},
		currentMeta: {
			graphql: {
				query: "devtoolsCurrentMeta:JSON",
			},
			handler(ctx) {
				return this.sanitizeAuthMeta(ctx.meta);
			},
		},
		sessionInspect: {
			graphql: {
				query: "devtoolsSessionInspect:JSON",
			},
			async handler(ctx) {
				const sid = getRedisSID(ctx.meta?.$request);
				const redisSession = await sessionFromRedis(sid);

				if (!redisSession) {
					return {
						sid: sid || null,
						preset: SESSION_PRESET,
						session: null,
					};
				}

				const token = redisSession?.token || null;

				return {
					sid: sid || null,
					preset: SESSION_PRESET,
					session: this.toJsonSafe(redisSession),
					cookie: this.toJsonSafe(redisSession?.cookie || null),
					user: this.toJsonSafe(redisSession?.user || null),
					sessionData: this.toJsonSafe(redisSession?.sessionData || null),
					token: this.toJsonSafe(token),
					decodedTokens: {
						accessToken: this.decodeJwtToken(token?.access_token),
						idToken: this.decodeJwtToken(token?.id_token),
						refreshToken: this.decodeJwtToken(token?.refresh_token),
					},
				};
			},
		},
		health: {
			graphql: {
				query: "devtoolsHealth:JSON",
			},
			handler(ctx) {
				return this.getHealthReport(ctx);
			},
		},
		env: {
			graphql: {
				query: "devtoolsEnv:JSON",
			},
			handler() {
				return {
					env: this.getSafeEnv(),
				};
			},
		},
		vfsInspect: {
			graphql: {
				query: "devtoolsVfsInspect(nodeId:Int!):JSON",
			},
			async handler(ctx) {
				const { nodeId } = ctx.params;
				const node = await this.db("storage.nodes").where({ node_id: nodeId }).first();
				if (!node) {
					return null;
				}

				const [path, children, descendants] = await Promise.all([
					ctx.call("vfs.vfsGetPathIds", { target_id: nodeId }),
					this.db("storage.nodes")
						.select("*")
						.where({ parent_id: nodeId })
						.orderBy([
							{ column: "type", order: "asc" },
							{ column: "name", order: "asc" },
						]),
					this.db.raw(`select count(*)::int as count from storage."vfsGetDescendantNodeIds"(?)`, [
						nodeId,
					]),
				]);

				let file = null;
				if (node.hash) {
					try {
						file = await ctx.call("minio.resolveFileRef", {
							ref: node.hash,
							name: node.name,
						});
					} catch {
						file = null;
					}
				}

				return {
					node: this.toJsonSafe(node),
					path: this.toJsonSafe(path),
					children: this.toJsonSafe(children),
					descendantsCount: descendants?.rows?.[0]?.count ?? 0,
					file: this.toJsonSafe(file),
				};
			},
		},
		minioInspect: {
			graphql: {
				query: "devtoolsMinioInspect(ref:String,bucketName:String,objectName:String):JSON",
			},
			async handler(ctx) {
				const { ref, bucketName, objectName } = ctx.params;
				const resolved: any = ref
					? await ctx.call("minio.resolveFileRef", { ref })
					: bucketName && objectName
						? await ctx.call("minio.resolveFileRef", {
								ref: `minio:${bucketName}:${Buffer.from(objectName, "utf8").toString("base64url")}`,
							})
						: null;
				if (!resolved) {
					throw new Error("ref or bucketName/objectName is required");
				}

				const [stat, exists, presignedUrl, publicUrl] = await Promise.all([
					ctx.call("minio.statObject", {
						bucketName: resolved.bucketName,
						objectName: resolved.objectName,
					}),
					ctx.call("minio.objectExists", {
						bucketName: resolved.bucketName,
						objectName: resolved.objectName,
					}),
					ctx.call("minio.presignedGetObject", {
						bucketName: resolved.bucketName,
						objectName: resolved.objectName,
					}),
					ctx.call("minio.getPublicUrl", {
						bucketName: resolved.bucketName,
						objectName: resolved.objectName,
					}),
				]);

				return {
					resolved: this.toJsonSafe(resolved),
					exists,
					stat: this.toJsonSafe(stat),
					presignedUrl,
					publicUrl,
				};
			},
		},
	},
	methods: {
		sanitizeValue(value, seen = new WeakSet()) {
			if (value == null) return value;
			if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
				return value;
			}
			if (typeof value === "bigint") {
				return value.toString();
			}
			if (typeof value === "function" || typeof value === "symbol") {
				return undefined;
			}
			if (value instanceof Date) {
				return value.toISOString();
			}
			if (Buffer.isBuffer(value)) {
				return {
					type: "Buffer",
					length: value.length,
				};
			}
			if (Array.isArray(value)) {
				return value.map(item => this.sanitizeValue(item, seen)).filter(item => item !== undefined);
			}
			if (typeof value === "object") {
				if (seen.has(value)) {
					return "[Circular]";
				}
				seen.add(value);
				const result = Object.entries(value).reduce((acc, [key, item]) => {
					const sanitized = this.sanitizeValue(item, seen);
					if (sanitized !== undefined) {
						acc[key] = sanitized;
					}
					return acc;
				}, {});
				seen.delete(value);
				return result;
			}
			return String(value);
		},
		sanitizeMeta(meta = {}) {
			const safeMeta = this.sanitizeValue(meta) || {};
			delete safeMeta.$request;
			delete safeMeta.$response;
			delete safeMeta.$responseHeaders;
			delete safeMeta.$statusCode;
			delete safeMeta.$statusMessage;
			delete safeMeta.$service;
			delete safeMeta.$action;
			delete safeMeta.$node;
			delete safeMeta.$route;
			delete safeMeta.$endpoint;
			delete safeMeta.$ctx;
			delete safeMeta.parentCtx;
			delete safeMeta.caller;
			return safeMeta;
		},
		sanitizeAuthMeta(meta = {}) {
			const user = this.sanitizeValue(meta?.user);
			const session = this.sanitizeValue(meta?.$session);

			return {
				user: user || null,
				$session: session || null,
			};
		},
		decodeJwtPart(value?: string) {
			if (!value) return null;

			try {
				const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
				const padded = normalized.padEnd(
					normalized.length + ((4 - (normalized.length % 4)) % 4),
					"="
				);
				return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
			} catch {
				return null;
			}
		},
		decodeJwtToken(token?: string) {
			if (!token || typeof token !== "string") {
				return null;
			}

			const [headerPart, payloadPart, signaturePart] = token.split(".");
			if (!headerPart || !payloadPart || !signaturePart) {
				return {
					raw: token,
					valid: false,
				};
			}

			return {
				raw: token,
				valid: true,
				header: this.decodeJwtPart(headerPart),
				payload: this.decodeJwtPart(payloadPart),
				signature: signaturePart,
			};
		},
		toJsonSafe(value) {
			if (value === undefined) return null;
			try {
				return JSON.parse(JSON.stringify(value));
			} catch {
				return {
					value: String(value),
				};
			}
		},
		getSafeEnv() {
			return ENV_WHITELIST.reduce((acc, key) => {
				if (process.env[key] !== undefined) {
					acc[key] = process.env[key];
				}
				return acc;
			}, {});
		},
		getActionDefinition(localService, actionName: string) {
			const rawActionName = actionName.includes(".") ? actionName.split(".").pop() : actionName;
			return localService?.schema?.actions?.[rawActionName];
		},
		getServicesOverview() {
			const services = this.broker.registry.getServiceList({
				withActions: true,
				onlyAvailable: true,
				skipInternal: false,
			});

			return services.map(service => {
				const localService =
					this.broker.getLocalService(service.fullName) ||
					this.broker.getLocalService(service.name);
				const actions = Object.values(service.actions || {}).map((action: any) => {
					const def = this.getActionDefinition(localService, action.name);
					return {
						name: action.name,
						rawName: action.rawName,
						visibility: action.visibility,
						cache: Boolean(action.cache),
						timeout: action.timeout,
						params: this.toJsonSafe(def?.params),
						rest: this.toJsonSafe(def?.rest),
						graphql: this.toJsonSafe(def?.graphql),
						roles: this.toJsonSafe(def?.roles),
						groups: this.toJsonSafe(def?.groups),
						object_access: Boolean(def?.object_access),
					};
				});

				return {
					name: service.name,
					fullName: service.fullName,
					version: service.version,
					nodeID: service.nodeID,
					settings: {
						category: localService?.schema?.metadata?.$category,
						description: localService?.schema?.metadata?.$description,
						dependencies: this.toJsonSafe(localService?.schema?.dependencies || []),
					},
					actions,
				};
			});
		},
		async runCheck(name: string, handler: () => Promise<any>) {
			const startedAt = Date.now();
			try {
				const details = await handler();
				return {
					name,
					ok: true,
					latencyMs: Date.now() - startedAt,
					details: this.toJsonSafe(details),
				};
			} catch (error: any) {
				return {
					name,
					ok: false,
					latencyMs: Date.now() - startedAt,
					error: error?.message || "Unknown error",
				};
			}
		},
		async getHealthReport(ctx) {
			const redisClient = new IORedis({
				host: process.env.REDIS_HOST,
				port: +(process.env.REDIS_PORT || 6379),
				username: process.env.REDIS_USER,
				password: process.env.REDIS_PASSWORD,
				db: +process.env.REDIS_DB || 10,
				lazyConnect: true,
				maxRetriesPerRequest: 1,
			});

			try {
				const [db, redis, minio, keycloak] = await Promise.all([
					this.runCheck("postgres", () => this.db.raw("select 1 as ok")),
					this.runCheck("redis", async () => {
						await redisClient.connect();
						return redisClient.ping();
					}),
					this.runCheck("minio", () => ctx.call("minio.checkConnection")),
					this.runCheck("keycloak", async () => {
						const response = await fetch(
							`${process.env.KC_URI}/realms/${process.env.KC_REALM}/.well-known/openid-configuration`
						);
						if (!response.ok) {
							throw new Error(`HTTP ${response.status}`);
						}
						return {
							status: response.status,
						};
					}),
				]);

				return {
					timestamp: new Date().toISOString(),
					nodeID: this.broker.nodeID,
					namespace: this.broker.namespace,
					services: this.broker.registry.getServiceList({ onlyAvailable: true }).length,
					checks: [db, redis, minio, keycloak],
				};
			} finally {
				await redisClient.quit().catch(() => undefined);
			}
		},
	},
};

export default devtoolsService;
