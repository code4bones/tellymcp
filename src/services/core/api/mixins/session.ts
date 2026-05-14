import { RedisStore } from "connect-redis";
import * as redis from "redis";
import session from "express-session";
import cookieParser from "cookie-parser";
import { Route, GatewayResponse } from "moleculer-web";
import { GQLContext } from "@core/index";
import { IncomingMessage } from "http";
import cookie from "cookie-parse";
import * as crypto from "crypto";
import * as Errors from "@src/lib/mixins/session.errors";
import {
	SESSION_PRESETS,
	SESSION_PRESET,
	SESSION_STRATEGY,
	DEFAULT_SESSION_PRESET,
} from "./session_presets";
import type { RequestHandler } from "express";

export const kcRealm = `${process.env.KC_URI}/realms/${process.env.KC_REALM}`;
export const kcOIDC = `${kcRealm}/protocol/openid-connect`;
export const authPath = "/api/auth";

const kcCfg = {
	issuer: kcRealm,
	auth: `${kcOIDC}/auth`,
	deauth: `${kcOIDC}/logout`,
	token: `${kcOIDC}/token`,
	userinfo: `${kcOIDC}/userinfo`,
	introspection: `${kcOIDC}/token/introspect`,
	clientId: process.env.KC_CLIENT_ID,
	clientSecret: process.env.KC_CLIENT_SECRET,
	callback: `${process.env.APIS}/auth/callback`,
	post_login_redirect: process.env.KC_POST_LOGIN_REDIRECT,
	post_logout_redirect: process.env.KC_POST_LOGOUT_REDIRECT,
	tgClientId: process.env.KC_TGAPP_CLIENT_ID,
	tgClientSecret: process.env.KC_TGAPP_CLIENT_SECRET,
};

const isProduction = process.env.NODE_ENV === "production";
const isHttps = process.env.HTTPS === "true" || isProduction;

const cookieOpts = {
	secure: isHttps,
	sameSite: "lax",
	// maxAge: (+process.env.COOKIE_MAX_AGE || 24) * 60 * 60 * 1000,
	maxAge: SESSION_STRATEGY.MAX_SESSION_LIFETIME / 1000,
	sessionName: "auth.sid",
	path: "/",
};

export function generateDeviceFingerprint(req) {
	const components = [
		req.headers["user-agent"] || "",
		req.headers["accept-language"] || "",
		req.headers["x-real-ip"] || req.headers["x-forwarded-for"] || "0.0.0.0",
		req.headers["sec-ch-ua"] || "", // User-Agent Client Hints
		req.headers["sec-ch-ua-platform"] || "",
	].join("|");

	return crypto.createHash("sha256").update(components).digest("hex").substring(0, 32);

	// Хешируем для приватности
}

const buildCookie = (name, value, maxAge) => {
	const parts = [`${name}=${encodeURIComponent(value)}`, "Path=/", "HttpOnly", `Max-Age=${maxAge}`];
	if (cookieOpts.secure) parts.push("Secure");
	if (cookieOpts.sameSite) parts.push(`SameSite=${cookieOpts.sameSite}`);
	return parts.join("; ");
};

const buildDeleteCookie = name => {
	const parts = [
		`${name}=`,
		"Path=/",
		"HttpOnly",
		"Max-Age=0", // Истекший срок
	];
	if (cookieOpts.secure) parts.push("Secure");
	if (cookieOpts.sameSite) parts.push(`SameSite=${cookieOpts.sameSite}`);
	return parts.join("; ");
};

const deleteCookies = ctx => {
	ctx.meta.$response.setHeader("Set-Cookie", [buildDeleteCookie(cookieOpts.sessionName)]);
};

const deleteSession = ctx => {
	return new Promise(resolve => {
		deleteCookies(ctx);
		ctx.meta.$session.destroy(resolve);
	});
};

const getRedisSID = req => {
	const cookies = req.headers.cookie;
	if (!cookies) return;

	const parsed = cookie.parse(cookies);
	if (!parsed[cookieOpts.sessionName]) return;
	const [sid] = parsed[cookieOpts.sessionName].substring(2).split(".");
	return sid;
};

type SessionRedisClient = ReturnType<typeof redis.createClient>;

let redisClient: SessionRedisClient | null = null;
let redisConnectPromise: Promise<SessionRedisClient> | null = null;
let sessionMiddleware: RequestHandler | null = null;
let sessionMiddlewarePromise: Promise<RequestHandler> | null = null;

const createSessionRedisClient = () =>
	redis.createClient({
		url: `redis://${process.env.REDIS_HOST}:${process.env.REDIS_PORT}`,
		socket: {
			host: process.env.REDIS_HOST,
			port: +(process.env.REDIS_PORT || 6379),
			connectTimeout: +(process.env.REDIS_CONNECT_TIMEOUT_MS || 5000),
		},
		database: 3,
		name: process.env.APPNAME,
	});

export const getSessionRedisClient = async () => {
	if (redisClient?.isOpen) {
		return redisClient;
	}
	if (!redisClient) {
		redisClient = createSessionRedisClient();
		redisClient.on("error", error => {
			console.error("[session.redis]", error?.message || error);
		});
	}
	if (!redisConnectPromise) {
		redisConnectPromise = redisClient.connect().then(() => redisClient as SessionRedisClient);
	}
	try {
		return await redisConnectPromise;
	} catch (error) {
		redisConnectPromise = null;
		throw error;
	}
};

const createSessionMiddleware = async () => {
	const client = await getSessionRedisClient();
	const store = new RedisStore({
		client,
		ttl: SESSION_STRATEGY.REFRESH_TOKEN_LIFETIME / 1000,
		scanCount: 4,
		prefix: `${process.env.NAMESPACE}_`,
	});

	return session({
		store,
		secret: process.env.SESSION_SECRET || "your-session-secret-key-change-in-production",
		resave: false,
		saveUninitialized: false,
		proxy: true,
		// unset: "destroy",
		cookie: function () {
			return {
				path: "/",
				secure: cookieOpts.secure,
				httpOnly: true,
				maxAge: cookieOpts.maxAge * 1000,
				sameSite: cookieOpts.sameSite,
			};
		},
		name: cookieOpts.sessionName,
		rolling: SESSION_STRATEGY.SLIDING_SESSION,
	});
};

const getSessionMiddleware = async () => {
	if (sessionMiddleware) {
		return sessionMiddleware;
	}
	if (!sessionMiddlewarePromise) {
		sessionMiddlewarePromise = createSessionMiddleware().then(middleware => {
			sessionMiddleware = middleware;
			return middleware;
		});
	}
	try {
		return await sessionMiddlewarePromise;
	} catch (error) {
		sessionMiddlewarePromise = null;
		throw error;
	}
};

export function isInternalCall(ctx) {
	return ctx?.meta?.internal_call === true;
}

export function requreSession(ctx) {
	if (isInternalCall(ctx)) {
		return;
	}
	if (!ctx.meta.$session?.token) {
		return Promise.reject(new Errors.SessionNotFoundError());
	}
}

export const getRefreshBufferMs = () => +(process.env.KC_REFRESH_DELTA_MIN || 2) * 60 * 1000;

export const shouldRefreshSessionToken = (token, now = Date.now()) =>
	!token?.expires_at || token.expires_at - now < getRefreshBufferMs();

export const canUseCurrentAccessToken = (token, now = Date.now()) =>
	Boolean(token?.access_token && token?.expires_at && token.expires_at > now);

export const getSessionId = req => req?.sessionID || getRedisSID(req);

export const applySessionSnapshot = (session, snapshot) => {
	if (!session || !snapshot || typeof snapshot !== "object") {
		return false;
	}

	let changed = false;
	for (const key of ["token", "user", "sessionData"]) {
		if (snapshot[key] !== undefined) {
			session[key] = snapshot[key];
			changed = true;
		}
	}

	return changed;
};

export const saveSession = session =>
	new Promise((resolve, reject) => {
		if (!session?.save) {
			resolve(null);
			return;
		}

		session.save(error => {
			if (error) {
				reject(error);
				return;
			}
			resolve(null);
		});
	});

export async function syncSessionFromRedis(ctx) {
	const sid = getSessionId(ctx?.meta?.$request);
	if (!sid) return null;
	const redisSession = await sessionFromRedis(sid);
	if (!redisSession) return null;
	applySessionSnapshot(ctx?.meta?.$session, redisSession);
	return redisSession;
}

export async function requireActiveToken(ctx) {
	if (isInternalCall(ctx)) {
		return;
	}
	if (!ctx.meta.$session?.token) {
		return Promise.reject(new Errors.TokenNotFoundError());
	}

	const { access_token, refresh_token, expires_at, refresh_expires_at } = ctx.meta.$session.token;
	const now = Date.now();

	if (!access_token || !refresh_token) {
		await deleteSession(ctx);
		return Promise.reject(new Errors.TokenInvalidError());
	}

	if (refresh_expires_at && refresh_expires_at <= now) {
		await deleteSession(ctx);
		return Promise.reject(new Errors.SessionExpiredError("Refresh token expired"));
	}
}

export async function refreshToken(ctx: GQLContext) {
	if (isInternalCall(ctx)) {
		return;
	}
	if (!ctx.meta.$session?.token)
		return Promise.reject(
			new Errors.TokenNotFoundError("Refresh token not available. Please login again.")
		);
	const { token } = ctx.meta.$session;

	try {
		if (!token.refresh_token) {
			throw new Errors.TokenNotFoundError("Refresh token not available. Please login again.");
		}

		if (!ctx.meta.$session.sessionData) {
			ctx.meta.$statusCode = 401;
			throw new Errors.SessionInvalidError("Session data not found");
		}

		const now = Date.now();

		const idleTimeout = SESSION_STRATEGY.IDLE_TIMEOUT; // 30 дней
		const idleTime = now - ctx.meta.$session.sessionData.lastActivity;

		if (idleTime > idleTimeout) {
			ctx.service?.logger.warn("Session idle timeout exceeded");
			throw new Errors.SessionIdleTimeoutExceededError("Session expired due to inactivity");
		}

		const maxSessionLifetime = SESSION_STRATEGY.MAX_SESSION_LIFETIME; // 2 года
		const sessionAge = now - ctx.meta.$session.sessionData.createdAt;

		if (sessionAge > maxSessionLifetime) {
			ctx.service?.logger.warn("Session max lifetime exceeded");
			deleteSession(ctx);
			ctx.meta.$statusCode = 401;
			throw new Errors.SessionMaxLifetimeExceededError("Session max lifetime exceeded");
		}

		const shouldRefresh = shouldRefreshSessionToken(token, now);
		if (shouldRefresh) {
			try {
				const refreshResult = (await ctx.call("kcauth.refresh")) as
					| { reused?: boolean; recovered?: boolean }
					| undefined;
				if (refreshResult?.recovered) {
					ctx.service?.logger.info("Token refresh recovered from shared session state");
				} else if (!refreshResult?.reused) {
					ctx.service?.logger.info("Token refresh completed");
				}
			} catch (error) {
				const recoveredSession = await syncSessionFromRedis(ctx);
				const recoveredToken = recoveredSession?.token || ctx.meta.$session?.token;
				const errorKind = error?.extensions?.data?.kind || error?.data?.kind;
				const canContinue = canUseCurrentAccessToken(recoveredToken, now);

				if (canContinue && (errorKind === "transient" || errorKind === "lock_timeout")) {
					ctx.service?.logger.warn(
						`sessions.refreshToken: proceeding with current access token after ${errorKind}`
					);
				} else {
					throw error;
				}
			}
		}
		if (SESSION_STRATEGY.SLIDING_SESSION) {
			ctx.meta.$session.sessionData.lastActivity = Date.now();
		}
	} catch (error) {
		ctx.service?.logger.error("sessions.refreshToken: Token refresh failed => ", error.message);
		if (ctx.meta.$session) {
			await deleteSession(ctx);
		}
		return Promise.reject(error);
	}
}

export const onBeforeCall =
	(isGraphQL = false) =>
	(ctx: GQLContext, route: Route, req: IncomingMessage, res: GatewayResponse) => {
		if (isGraphQL && req.method === "GET" && !("x-playground-token" in req.headers)) {
			const ip = req.headers["x-real-ip"] || req.headers["x-forwarded-for"];
			if (process.env.RESTRICT_PLAYGROUND === "true") {
				res.writeHead(403, { "Content-Type": "text/plain" });
				res.end(`Playground disabled for ${ip}`);
				return;
			}
		}
		ctx.meta.$headers = req.headers;
		ctx.meta.$cookies = (req as any).cookies;
		ctx.meta.$response = res;
		ctx.meta.$request = req;

		if ((req as any).session) {
			ctx.meta.$session = (req as any).session;
			if (ctx.meta.$session.user) {
				ctx.meta.user = ctx.meta.$session.user;
			}
		}
	};

const sessionFromRedis = async sid => {
	if (!sid) return;
	const redisKey = `${process.env.NAMESPACE}_${sid}`;
	const redisClient = await getSessionRedisClient();
	const redisSessionStr = await redisClient.get(redisKey);
	if (!redisSessionStr) return;
	const redisSession = JSON.parse(redisSessionStr as string);
	return redisSession;
};

const useSessionMiddleware = [
	cookieParser(),
	(req, res, next) => {
		getSessionMiddleware()
			.then(middleware => middleware(req, res, next))
			.catch(next);
	},
];
export {
	useSessionMiddleware,
	kcCfg,
	SESSION_STRATEGY,
	SESSION_PRESET,
	SESSION_PRESETS,
	DEFAULT_SESSION_PRESET,
	buildCookie,
	buildDeleteCookie,
	deleteSession,
	deleteCookies,
	sessionFromRedis,
	getRedisSID,
	redisClient,
};
