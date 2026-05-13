import { GQLSchema } from "@core/index";
import axios from "axios";
import crypto from "crypto";
import {
	kcCfg,
	authPath,
	refreshToken,
	requreSession,
	deleteSession,
	deleteCookies,
	requireActiveToken,
	SESSION_STRATEGY,
	SESSION_PRESET,
	getRedisSID,
	generateDeviceFingerprint,
	getSessionRedisClient,
	getSessionId,
	saveSession,
	syncSessionFromRedis,
	shouldRefreshSessionToken,
	canUseCurrentAccessToken,
} from "../api/mixins/session";
import { renderJSON } from "@src/lib/responseHTML";
import * as SessionErrors from "@src/lib/mixins/session.errors";
import { Errors } from "moleculer";

const kcAuth: GQLSchema = {
	name: "kcauth",
	mixins: [],
	dependencies: [],
	settings: {},
	hooks: {
		before: {
			"userinfo|endsession|token|validate|sessioninfo": [requreSession, refreshToken],
		},
	},
	actions: {
		login: {
			rest: {
				fullPath: `${authPath}/login`,
			},
			handler(ctx) {
				const { post_login_redirect = kcCfg.post_login_redirect } = ctx.params;
				const authScope = ["openid", "profile", "email"];
				if (SESSION_STRATEGY.USE_OFFLINE_ACCESS) {
					authScope.push("offline_access");
				}

				const state = this.generateState();
				const codeVerifier = this.generateCodeVerifier();
				const codeChallenge = this.generateCodeChallenge(codeVerifier);
				const authUrl = `${kcCfg.auth}?${new URLSearchParams({
					client_id: kcCfg.clientId!,
					response_type: "code",
					scope: authScope.join(" "),
					redirect_uri: kcCfg.callback,
					state,
					code_challenge: codeChallenge,
					code_challenge_method: "S256",
				})}`;

				ctx.meta.$session.postlogin_redirect = post_login_redirect;
				ctx.meta.$session.state = state;
				ctx.meta.$session.code_verifier = codeVerifier;
				ctx.meta.$statusCode = 302;
				ctx.meta.$location = authUrl;
				return { redirect: authUrl };
			},
		},
		callback: {
			rest: {
				fullPath: `${authPath}/callback`,
			},
			async handler(ctx) {
				const { code, state, error, rememberMe = false } = ctx.params;
				const codeVerifier = ctx.meta.$session?.code_verifier;

				if (error) {
					this.logger.error(error);
					throw new SessionErrors.SessionValidationError(error);
				}

				if (!code || !state) {
					this.logger.error("code or state missing");
					throw new Errors.ValidationError(
						!code ? "code Missing" : "state Missing...",
						"INVALID_STATE"
					);
				}

				if (state !== ctx.meta.$session.state) {
					this.logger.error(`Invalid state req ${ctx.meta.$session.state}, got ${state}`);
					throw new Errors.ValidationError("Invalid state", "INVALID_STATE");
				}
				if (!codeVerifier) {
					this.logger.error("PKCE code verifier missing in session");
					throw new SessionErrors.SessionValidationError("PKCE code verifier missing");
				}
				try {
					const tokenResponse = await axios.post(
						kcCfg.token,
						new URLSearchParams({
							grant_type: "authorization_code",
							code,
							redirect_uri: kcCfg.callback,
							client_id: kcCfg.clientId!,
							client_secret: kcCfg.clientSecret!,
							code_verifier: codeVerifier,
						}),
						{
							headers: { "Content-Type": "application/x-www-form-urlencoded" },
						}
					);
					const { access_token, expires_in, refresh_expires_in } = tokenResponse.data;

					const userInfoResponse = await axios.get(kcCfg.userinfo, {
						headers: { Authorization: `Bearer ${access_token}` },
					});
					const userInfo = userInfoResponse.data;

					const now = Date.now();

					ctx.meta.$session.token = {
						...tokenResponse.data,
						expires_at: now + expires_in * 1000,
						refresh_expires_at: refresh_expires_in ? now + refresh_expires_in * 1000 : 0, // now + refresh_expires_in * 1000,
					};
					ctx.meta.$session.user = this.normalizeUserInfo({
						...userInfo,
						expires_in,
						refresh_expires_in,
						expires_at: ctx.meta.$session.token.expires_at,
					});
					ctx.meta.user = ctx.meta.$session.user;
					const deviceFingerprint = this.generateDeviceFingerprint(ctx);
					ctx.meta.$session.sessionData = {
						createdAt: now,
						lastActivity: now,
						deviceFingerprint,
						rememberMe,
					};

					if (rememberMe) {
						const maxAge = SESSION_STRATEGY.MAX_SESSION_LIFETIME / 1000;
						ctx.meta.$session.cookie.maxAge = maxAge;
					}

					const returnUri = ctx.meta.$session.postlogin_redirect;
					delete ctx.meta.$session.code_verifier;
					delete ctx.meta.$session.state;
					ctx.meta.$statusCode = 302;
					ctx.meta.$location = returnUri;

					return "OK";
				} catch (e) {
					this.logger.error(e);
					delete ctx.meta.$session.code_verifier;
					return Promise.reject(e);
				}
			},
		},
		logout: {
			rest: {
				fullPath: `${authPath}/logout`,
			},
			handler(ctx) {
				return this.performLogout(ctx);
			},
		},
		endsession: {
			rest: {
				fullPath: `${authPath}/endsession`,
			},
			handler(ctx) {
				return this.performLogout(ctx);
			},
		},
		refresh: {
			visibility: "protected",
			async handler(ctx) {
				const sessionKey = this.getRefreshSessionKey(ctx);
				const previousToken = { ...(ctx.meta.$session?.token || {}) };
				let lock = await this.acquireRefreshLock(sessionKey);

				if (!lock.acquired) {
					const reusedToken = await this.waitForSharedSessionRefresh(ctx, previousToken);
					if (reusedToken) {
						return {
							token: reusedToken,
							reused: true,
							recovered: true,
						};
					}

					lock = await this.acquireRefreshLock(sessionKey);
					if (!lock.acquired) {
						throw new SessionErrors.SessionRefreshError("Refresh lock timeout", {
							kind: "lock_timeout",
						});
					}
				}
				try {
					const redisSession = await syncSessionFromRedis(ctx);
					const latestToken = redisSession?.token || ctx.meta.$session?.token;

					if (!latestToken?.refresh_token) {
						throw new SessionErrors.TokenNotFoundError(
							"Refresh token not available. Please login again."
						);
					}

					if (!shouldRefreshSessionToken(latestToken)) {
						return {
							token: latestToken,
							reused: true,
							recovered: true,
						};
					}

					const refreshedToken = await this.exchangeRefreshToken(
						latestToken.refresh_token,
						latestToken.id_token
					);
					this.applyRefreshResult(ctx, refreshedToken);
					await saveSession(ctx.meta.$session);

					return {
						token: refreshedToken,
						reused: false,
					};
				} catch (e) {
					const recoveredToken = await this.recoverRefreshedToken(ctx, previousToken);
					if (recoveredToken) {
						return {
							token: recoveredToken,
							reused: true,
							recovered: true,
						};
					}

					this.logger.error(`kcAuth.refresh: ${e.message}`);
					if (e.response?.data) {
						const { error, error_description } = e.response.data;
						const kind =
							error === "invalid_grant" || error === "invalid_token"
								? "invalid_grant"
								: "transient";
						throw new SessionErrors.SessionRefreshError(
							error_description || e.message,
							error
								? { kind, error, provider: e.response.data }
								: { kind, provider: e.response.data }
						);
					}

					if (e instanceof SessionErrors.BackendError) {
						throw e;
					}

					throw new SessionErrors.SessionRefreshError(e.message, {
						kind: canUseCurrentAccessToken(ctx.meta.$session?.token) ? "transient" : "fatal",
					});
				} finally {
					await this.releaseRefreshLock(lock);
				}
			},
		},
		token: {
			rest: {
				fullPath: `${authPath}/token`,
			},
			handler(ctx) {
				return ctx.meta.$session.token.access_token;
			},
		},

		sessioninfo: {
			rest: {
				fullPath: `${authPath}/session-info`,
			},
			handler(ctx) {
				if (!ctx.meta.$session?.sessionData) {
					ctx.meta.$statusCode = 401;
					return { authenticated: false };
				}

				const now = Date.now();
				const { sessionData, token } = ctx.meta.$session;

				// Проверяем таймаут бездействия
				const idleTime = now - sessionData.lastActivity;
				const idleTimeout = SESSION_STRATEGY.IDLE_TIMEOUT;

				if (idleTime > idleTimeout) {
					this.logger.warn("Session idle timeout exceeded");
					deleteSession(ctx);
					ctx.meta.$statusCode = 401;
					return { authenticated: false, error: "Session idle timeout" };
				}

				// Проверяем максимальный срок жизни сессии
				const sessionAge = now - sessionData.createdAt;
				const maxSessionLifetime = SESSION_STRATEGY.MAX_SESSION_LIFETIME;

				if (sessionAge > maxSessionLifetime) {
					this.logger.warn("Session max lifetime exceeded");
					deleteSession(ctx);
					ctx.meta.$statusCode = 401;
					return { authenticated: false, error: "Session max lifetime exceeded" };
				}

				const sessionInfo = {
					authenticated: true,
					preset: SESSION_PRESET,
					session: {
						createdAt: sessionData.createdAt,
						lastActivity: sessionData.lastActivity,
						idleTime: Math.floor(idleTime / 1000),
						idleTimeout: SESSION_STRATEGY.IDLE_TIMEOUT / 1000,
						sessionAge: Math.floor(sessionAge / 1000),
						maxSessionLifetime: SESSION_STRATEGY.MAX_SESSION_LIFETIME / 1000,
						deviceFingerprint: sessionData.deviceFingerprint,
						rememberMe: sessionData.rememberMe,
					},
					token: {
						expiresAt: `${token.expires_at} [ ${new Date(token.expires_at).toLocaleString()} ]`,
						refreshExpiresAt: `${token.refresh_expires_at} [ ${new Date(token.refresh_expires_at).toLocaleString()} ]`,
						expiresIn: Math.floor((token.expires_at - now) / 1000),
						refreshExpiresIn: token.refresh_expires_in
							? Math.floor((token.refresh_expires_at - now) / 1000)
							: 0,
					},
				};

				return ctx.params.html ? renderJSON(ctx, sessionInfo) : sessionInfo;
			},
		},
		userinfo: {
			rest: {
				fullPath: `${authPath}/userinfo`,
			},
			async handler(ctx) {
				try {
					const userInfoResponse = await axios.get(kcCfg.userinfo, {
						headers: {
							Authorization: `Bearer ${ctx.meta.$session.token.access_token}`,
						},
					});
					// Добавим ключ редиса, что бы фронт мог его передать если нудно в connectParams для подписок
					const redisSid = getRedisSID(ctx.meta.$request);
					const info = this.normalizeUserInfo({ ...userInfoResponse.data, sid: redisSid });
					return ctx.params.html ? renderJSON(ctx, info) : info;
				} catch (e) {
					this.logger.error(e);
					return Promise.reject(e);
				}
			},
		},

		validate: {
			rest: {
				fullPath: `${authPath}/validate`,
			},
			handler(ctx) {
				return requireActiveToken(ctx);
			},
		},
	},
	methods: {
		async performLogout(ctx) {
			const { redirect_uri = kcCfg.post_logout_redirect } = ctx.params;
			const token = ctx.meta.$session?.token;
			const refreshToken = token?.refresh_token;
			const idToken = token?.id_token;

			if (refreshToken) {
				try {
					const payload = new URLSearchParams({
						client_id: kcCfg.clientId!,
						client_secret: kcCfg.clientSecret!,
						refresh_token: refreshToken,
					});

					if (redirect_uri) {
						payload.set("post_logout_redirect_uri", redirect_uri);
					}
					if (idToken) {
						payload.set("id_token_hint", idToken);
					}

					await axios.post(kcCfg.deauth, payload, {
						headers: { "Content-Type": "application/x-www-form-urlencoded" },
					});
				} catch (err) {
					const providerError = err?.response?.data?.error;
					const providerDescription = err?.response?.data?.error_description;
					if (providerError === "invalid_grant" || providerError === "invalid_token") {
						this.logger.warn(
							`KC logout ignored: ${providerError}${providerDescription ? ` (${providerDescription})` : ""}`
						);
					} else {
						this.logger.error("KC logout error:", err?.response?.data || err.message || err);
					}
				}
			}

			if (ctx.meta.$session?.destroy) {
				await deleteSession(ctx);
			} else {
				deleteCookies(ctx);
			}

			ctx.meta.$statusCode = 302;
			ctx.meta.$location = redirect_uri;

			return {
				success: true,
				message: "Session destroyed successfully",
			};
		},
		generateState() {
			return (
				Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15)
			);
		},
		base64UrlEncode(input) {
			return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
		},
		generateCodeVerifier() {
			return this.base64UrlEncode(crypto.randomBytes(64));
		},
		generateCodeChallenge(codeVerifier) {
			return this.base64UrlEncode(crypto.createHash("sha256").update(codeVerifier).digest());
		},
		normalizeUserInfo(userInfo = {}) {
			const roles = Array.isArray(userInfo.roles) ? userInfo.roles : [];
			const groups = Array.isArray(userInfo.groups) ? userInfo.groups : [];
			return {
				...userInfo,
				roles,
				groups,
			};
		},
		generateDeviceFingerprint(ctx) {
			return generateDeviceFingerprint(ctx.meta.$request);
		},
		getRefreshSessionKey(ctx) {
			const sid = getSessionId(ctx.meta?.$request) || getRedisSID(ctx.meta?.$request);
			if (sid) {
				return `session:${sid}`;
			}

			const refreshToken = String(ctx.meta?.$session?.token?.refresh_token || "");
			const fallback = crypto.createHash("sha256").update(refreshToken).digest("hex");
			return `refresh:${fallback}`;
		},
		getRefreshLockKey(sessionKey) {
			return `${process.env.NAMESPACE}_auth_refresh_lock:${sessionKey}`;
		},
		async acquireRefreshLock(sessionKey, ttlMs = 15000) {
			const key = this.getRefreshLockKey(sessionKey);
			const value = crypto.randomUUID();
			const redisClient = await getSessionRedisClient();
			const acquired = await redisClient.set(key, value, {
				NX: true,
				PX: ttlMs,
			});

			return {
				key,
				value,
				acquired: acquired === "OK",
			};
		},
		async releaseRefreshLock(lock) {
			if (!lock?.acquired) {
				return;
			}

			const redisClient = await getSessionRedisClient();
			await redisClient
				.eval(
					"if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
					{
						keys: [lock.key],
						arguments: [lock.value],
					}
				)
				.catch(() => null);
		},
		isTokenAdvanced(currentToken, previousToken) {
			if (!currentToken) return false;
			if (!previousToken?.refresh_token) return true;

			return (
				currentToken.refresh_token !== previousToken.refresh_token ||
				currentToken.access_token !== previousToken.access_token ||
				Number(currentToken.expires_at || 0) > Number(previousToken.expires_at || 0)
			);
		},
		async recoverRefreshedToken(ctx, previousToken) {
			const redisSession = await syncSessionFromRedis(ctx);
			const currentToken = redisSession?.token || ctx.meta?.$session?.token;
			if (this.isTokenAdvanced(currentToken, previousToken)) {
				return currentToken;
			}
			return null;
		},
		async waitForSharedSessionRefresh(ctx, previousToken, timeoutMs = 16000, intervalMs = 150) {
			const startedAt = Date.now();

			while (Date.now() - startedAt < timeoutMs) {
				const recoveredToken = await this.recoverRefreshedToken(ctx, previousToken);
				if (recoveredToken && !shouldRefreshSessionToken(recoveredToken)) {
					return recoveredToken;
				}

				await new Promise(resolve => setTimeout(resolve, intervalMs));
			}

			return null;
		},
		async exchangeRefreshToken(refresh_token, id_token) {
			const refreshPayload = new URLSearchParams({
				grant_type: "refresh_token",
				refresh_token,
				client_id: kcCfg.clientId!,
				client_secret: kcCfg.clientSecret!,
			});
			if (SESSION_STRATEGY.USE_OFFLINE_ACCESS) {
				refreshPayload.set("scope", "offline_access");
			}

			const tokenResponse = await axios.post(kcCfg.token, refreshPayload, {
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
			});
			const {
				access_token,
				refresh_token: new_refresh_token,
				expires_in,
				refresh_expires_in,
				id_token: new_id_token,
			} = tokenResponse.data;

			const now = Date.now();
			return {
				access_token,
				refresh_token: SESSION_STRATEGY.TOKEN_ROTATION ? new_refresh_token : refresh_token,
				expires_in,
				refresh_expires_in,
				id_token: new_id_token || id_token,
				expires_at: now + expires_in * 1000,
				refresh_expires_at: refresh_expires_in ? now + refresh_expires_in * 1000 : 0,
			};
		},
		applyRefreshResult(ctx, token) {
			ctx.meta.$session.token = token;

			if (ctx.meta.$session.sessionData) {
				ctx.meta.$session.sessionData.lastActivity = Date.now();
			}
		},
	},
};

export default kcAuth;
