// security/token-binder.js
import crypto from "crypto";
import { generateDeviceFingerprint } from "../services/core/api/mixins/session";

class TokenBinder {
	secret: string;
	ttl: number;

	constructor(ttl?: number) {
		this.secret = process.env.TOKEN_BINDING_SECRET || "your-token-binding-secret";
		this.ttl = ttl ?? +(process.env.TOKEN_BINDING_TTL_MS || 90 * 24 * 60 * 60 * 1000);
	}

	/**
	 * Создает Proof-of-Possession (PoP) токен
	 * PoP токен доказывает, что клиент владеет access token
	 */
	createPoPToken(accessToken, clientFingerprint, sessionId) {
		// Хешируем access token
		const tokenHash = crypto.createHash("sha256").update(accessToken).digest("hex");

		const timestamp = Date.now();
		const nonce = crypto.randomBytes(16).toString("hex");

		// Создаем данные для подписи
		const data = `${tokenHash}:${clientFingerprint}:${sessionId}:${timestamp}:${nonce}`;

		// Создаем HMAC подпись
		const signature = crypto.createHmac("sha256", this.secret).update(data).digest("hex");

		return {
			popToken: `${timestamp}.${nonce}.${signature}`,
			timestamp,
			nonce,
			ttl: this.ttl,
		};
	}

	/**
	 * Верифицирует PoP токен
	 */
	verifyPoPToken(accessToken, receivedPopToken, clientFingerprint, sessionId) {
		try {
			if (!receivedPopToken || typeof receivedPopToken !== "string") {
				return false;
			}

			// console.log("VERIFY", { accessToken, sessionId });
			// Хешируем access token
			const tokenHash = crypto.createHash("sha256").update(accessToken).digest("hex");
			const tokenParts = receivedPopToken.split(".");

			// Backward compatibility for legacy PoP cookies that stored only the signature.
			if (tokenParts.length === 1) {
				const data = `${tokenHash}:${clientFingerprint}:${sessionId}`;
				const expectedSignature = crypto
					.createHmac("sha256", this.secret)
					.update(data)
					.digest("hex");
				return this.safeCompareHex(receivedPopToken, expectedSignature);
			}

			if (tokenParts.length !== 3) {
				return false;
			}

			const [timestampRaw, nonce, receivedSignature] = tokenParts;
			const timestamp = Number(timestampRaw);

			if (!Number.isFinite(timestamp) || !/^[a-f0-9]{32}$/i.test(nonce)) {
				return false;
			}

			// Воссоздаем данные для проверки
			const data = `${tokenHash}:${clientFingerprint}:${sessionId}:${timestamp}:${nonce}`;

			// Вычисляем ожидаемую подпись
			const expectedSignature = crypto.createHmac("sha256", this.secret).update(data).digest("hex");
			const isSignatureValid = this.safeCompareHex(receivedSignature, expectedSignature);

			// Проверяем срок действия
			const isNotExpired = this.ttl <= 0 || Date.now() - timestamp < this.ttl;

			// Проверяем nonce (предотвращаем replay атаки)
			const isNonceValid = this.validateNonce(nonce, timestamp);

			return isSignatureValid && isNotExpired && isNonceValid;
		} catch (error) {
			console.error("PoP token verification error:", error);
			return false;
		}
	}

	safeCompareHex(left, right) {
		if (
			typeof left !== "string" ||
			typeof right !== "string" ||
			left.length !== right.length ||
			left.length % 2 !== 0 ||
			!/^[a-f0-9]+$/i.test(left) ||
			!/^[a-f0-9]+$/i.test(right)
		) {
			return false;
		}

		return crypto.timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
	}

	/**
	 * Проверка nonce для защиты от replay атак
	 */
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	validateNonce(nonce, timestamp) {
		// Здесь можно добавить проверку в Redis, что этот nonce еще не использовался
		// Для простоты проверяем только формат
		return /^[a-f0-9]{32}$/.test(nonce);
	}

	/**
	 * Создает связанную пару: Access Token + PoP Token
	 */
	createBoundTokenPair(accessToken, req) {
		const clientFingerprint = generateDeviceFingerprint(req);
		const sessionId = req.sessionID;

		const popToken = this.createPoPToken(accessToken, clientFingerprint, sessionId);

		return {
			accessToken: accessToken.token,
			popToken: popToken.popToken,
			popTimestamp: popToken.timestamp,
			popNonce: popToken.nonce,
			clientFingerprint: clientFingerprint,
			expiresAt: Date.now() + (accessToken.expiresIn * 1000 || 300000),
		};
	}
}

export const verifyPoP = (ctx, ttl?: number) => {
	const req = ctx.meta.$request;
	const tokenBuilder = new TokenBinder(ttl);
	const popToken = ctx.meta.$cookies["pop"];
	try {
		const isValid = tokenBuilder.verifyPoPToken(
			ctx.meta.$session.token.access_token,
			popToken,
			generateDeviceFingerprint(req),
			req.sessionID
		);
		return isValid;
	} catch (e) {
		console.error(e);
	}
};

export const generatePoP = (access_token, req, ttl?: number) => {
	const tokenBinder = new TokenBinder(ttl);
	const popToken = tokenBinder.createPoPToken(
		access_token,
		generateDeviceFingerprint(req),
		req.sessionID
	);
	// console.log("********** POP ************",popToken)
	return popToken;
};

export { TokenBinder };
