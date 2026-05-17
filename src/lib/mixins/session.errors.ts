export class BackendError extends Error {
	statusCode: number;
	code: string;
	data?: unknown;

	constructor(message: string, statusCode: number = 500, code?: string, data?: unknown) {
		super(message);
		this.name = "BackendError";
		this.statusCode = statusCode;
		this.code = code || String(statusCode);
		this.data = data;
	}
}

export const buildUnhandledBackendErrorCode = (rawName: string): string =>
	`XC_${rawName.toUpperCase()}`;

export const wrapUnhandledBackendError = (err: Error, rawName: string): BackendError =>
	new BackendError(err.message, 502, buildUnhandledBackendErrorCode(rawName));

export class UnauthorizedError extends BackendError {
	constructor(message: string = "Unauthorized", data?: any) {
		super(message, 401, "UNAUTHORIZED", data);
	}
}

export class ForbiddenError extends BackendError {
	constructor(message: string = "Forbidden", data?: any) {
		super(message, 403, "FORBIDDEN", data);
	}
}

export class SessionNotFoundError extends BackendError {
	constructor(message: string = "Session not found", data?: any) {
		super(message, 401, "SESSION_NOT_FOUND", data);
	}
}

export class SessionExpiredError extends BackendError {
	constructor(message: string = "Session expired", data?: any) {
		super(message, 401, "SESSION_EXPIRED", data);
	}
}

export class SessionInvalidError extends BackendError {
	constructor(message: string = "Session invalid", data?: any) {
		super(message, 401, "SESSION_INVALID", data);
	}
}

export class SessionStealedError extends BackendError {
	constructor(message: string = "Session stealed", data?: any) {
		super(message, 401, "SESSION_STEALED", data);
	}
}

export class SessionMaxLifetimeExceededError extends BackendError {
	constructor(message: string = "Session max lifetime exceeded", data?: any) {
		super(message, 401, "SESSION_MAX_LIFETIME_EXCEEDED", data);
	}
}

export class SessionRefreshError extends BackendError {
	constructor(message: string = "Session refresh failed", data?: any) {
		super(message, 401, "SESSION_REFRESH_FAILED", data);
	}
}

export class SessionValidationError extends BackendError {
	constructor(message: string = "Session validation failed", data?: any) {
		super(message, 401, "SESSION_VALIDATION_FAILED", data);
	}
}

export class SessionTokenInvalidError extends BackendError {
	constructor(message: string = "Session token invalid", data?: any) {
		super(message, 401, "SESSION_TOKEN_INVALID", data);
	}
}

export class SessionTokenExpiredError extends BackendError {
	constructor(message: string = "Session token expired", data?: any) {
		super(message, 401, "SESSION_TOKEN_EXPIRED", data);
	}
}

export class SessionTokenNotActiveError extends BackendError {
	constructor(message: string = "Session token not active", data?: any) {
		super(message, 401, "SESSION_TOKEN_NOT_ACTIVE", data);
	}
}

export class SessionTokenRevokedError extends BackendError {
	constructor(message: string = "Session token revoked", data?: any) {
		super(message, 401, "SESSION_TOKEN_REVOKED", data);
	}
}

export class SessionTokenNotFoundError extends BackendError {
	constructor(message: string = "Session token not found", data?: any) {
		super(message, 401, "SESSION_TOKEN_NOT_FOUND", data);
	}
}

export class SessionTokenMismatchError extends BackendError {
	constructor(message: string = "Session token mismatch", data?: any) {
		super(message, 401, "SESSION_TOKEN_MISMATCH", data);
	}
}

export class SessionTokenInvalidFormatError extends BackendError {
	constructor(message: string = "Session token invalid format", data?: any) {
		super(message, 401, "SESSION_TOKEN_INVALID_FORMAT", data);
	}
}

export class SessionTokenSignatureInvalidError extends BackendError {
	constructor(message: string = "Session token signature invalid", data?: any) {
		super(message, 401, "SESSION_TOKEN_SIGNATURE_INVALID", data);
	}
}

export class TokenNotFoundError extends BackendError {
	constructor(message: string = "Token not found", data?: any) {
		super(message, 401, "TOKEN_NOT_FOUND", data);
	}
}

export class TokenInvalidError extends BackendError {
	constructor(message: string = "Token invalid", data?: any) {
		super(message, 401, "TOKEN_INVALID", data);
	}
}

export class SessionIdleTimeoutExceededError extends BackendError {
	constructor(message: string = "Session idle timeout exceeded", data?: any) {
		super(message, 401, "SESSION_IDLE_TIMEOUT_EXCEEDED", data);
	}
}

export class PlaygroundDisabledError extends BackendError {
	constructor(message: string = "Playground disabled", data?: any) {
		super(message, 403, "PLAYGROUND_DISABLED", data);
	}
}
