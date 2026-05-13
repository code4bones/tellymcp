/**
 * Конфигурация MinIO S3 для Moleculer сервиса
 *
 * @description Настройки подключения к MinIO серверу
 * @author Your Name
 * @version 1.0.0
 */

const parseCsv = value =>
	(value || "")
		.split(",")
		.map(item => item.trim())
		.filter(Boolean);

const tryParseUrl = value => {
	const raw = String(value || "").trim();
	if (!raw) {
		return null;
	}
	try {
		return new URL(raw);
	} catch {
		return null;
	}
};

const resolvePublicMinioTarget = () => {
	const rawPublicEndpoint = String(process.env.MINIO_PUBLIC_ENDPOINT || "").trim();
	const rawDomain = String(process.env.DOMAIN || "").trim();
	const rawMinioEndpoint = String(process.env.MINIO_ENDPOINT || "localhost").trim();
	const apiUrl = tryParseUrl(process.env.APIS);
	const publicUrl = tryParseUrl(rawPublicEndpoint);
	const domainUrl = tryParseUrl(rawDomain);

	const endpointSource = rawPublicEndpoint || rawDomain || rawMinioEndpoint;
	const parsedEndpoint = publicUrl || domainUrl;
	const endPoint = parsedEndpoint
		? parsedEndpoint.hostname
		: endpointSource.replace(/^[a-z]+:\/\//i, "").replace(/[/?#].*$/, "").replace(/:\d+$/, "");

	const explicitPublicUseSsl = process.env.MINIO_PUBLIC_USE_SSL;
	const inferredUseSsl =
		explicitPublicUseSsl === "true" ||
		(explicitPublicUseSsl == null &&
			(Boolean(publicUrl && publicUrl.protocol === "https:") ||
				Boolean(domainUrl && domainUrl.protocol === "https:") ||
				Boolean(apiUrl && apiUrl.protocol === "https:") ||
				process.env.HTTPS === "true" ||
				process.env.MINIO_USE_SSL === "true"));

	const portSource =
		process.env.MINIO_PUBLIC_PORT ||
		(parsedEndpoint && parsedEndpoint.port) ||
		(apiUrl && apiUrl.port) ||
		(inferredUseSsl ? "443" : "80");
	const publicPort = parseInt(String(portSource || (inferredUseSsl ? "443" : "80")), 10);
	const publicUseSSL =
		explicitPublicUseSsl === "true" ||
		(explicitPublicUseSsl == null &&
			(inferredUseSsl || Number(publicPort) === 443));

	return {
		endPoint: endPoint || "localhost",
		port: Number.isFinite(publicPort) ? publicPort : publicUseSSL ? 443 : 80,
		useSSL: publicUseSSL,
	};
};

const publicMinioTarget = resolvePublicMinioTarget();
const minioBucket = process.env.MINIO_BUCKET || "atlas";
const multipartUploadMaxFiles = Number.parseInt(String(process.env.MULTIPART_UPLOAD_MAX_FILES || "200"), 10);
const multipartUploadMaxFileSize = Number.parseInt(
	String(process.env.MULTIPART_UPLOAD_MAX_FILE_SIZE || String(100 * 1024 * 1024)),
	10
);

export default {
	// Настройки подключения к MinIO
	minio: {
		endPoint: process.env.MINIO_ENDPOINT || "localhost",
		port: parseInt(process.env.MINIO_PORT || "9000"),
		useSSL: process.env.MINIO_USE_SSL === "true" || false,
		publicEndPoint: publicMinioTarget.endPoint,
		publicPort: publicMinioTarget.port,
		publicUseSSL: publicMinioTarget.useSSL,
		publicPathPrefix: process.env.MINIO_PUBLIC_PATH_PREFIX || "/s3",
		accessKey: process.env.MINIO_ACCESS_KEY || "minioadmin",
		secretKey: process.env.MINIO_SECRET_KEY || "minioadmin123",
		region: process.env.MINIO_REGION || "us-east-1",
		bucket: minioBucket,
		// Настройки бакетов по умолчанию
		defaultBuckets: [minioBucket],

		// Настройки политики бакетов
		bucketPolicies: {
			[minioBucket]: "private",
		},

		// Настройки кэширования
		cache: {
			enabled: true,
			ttl: 300, // 5 минут в секундах
			checkPeriod: 60, // Проверка каждые 60 секунд
		},

		// Настройки лимитов
		limits: {
			maxFileSize: Number.isFinite(multipartUploadMaxFileSize) && multipartUploadMaxFileSize > 0
				? multipartUploadMaxFileSize
				: 100 * 1024 * 1024,
			maxFilesPerUpload: Number.isFinite(multipartUploadMaxFiles) && multipartUploadMaxFiles > 0
				? multipartUploadMaxFiles
				: 200,
			allowedMimeTypes: [
				"image/jpeg",
				"image/png",
				"image/gif",
				"application/pdf",
				"application/json",
				"text/plain",
				"video/mp4",
				"audio/mpeg",
			],
		},
	},

	access: {
		admin: {
			roles: parseCsv(process.env.MINIO_ADMIN_ROLES),
			groups: parseCsv(process.env.MINIO_ADMIN_GROUPS),
		},
		read: {
			roles: parseCsv(process.env.MINIO_READ_ROLES),
			groups: parseCsv(process.env.MINIO_READ_GROUPS),
		},
		write: {
			roles: parseCsv(process.env.MINIO_WRITE_ROLES),
			groups: parseCsv(process.env.MINIO_WRITE_GROUPS),
		},
		delete: {
			roles: parseCsv(process.env.MINIO_DELETE_ROLES),
			groups: parseCsv(process.env.MINIO_DELETE_GROUPS),
		},
	},

	// Настройки генерации пресигнед урлов
	presignedUrls: {
		expiry: 3600, // 1 час по умолчанию
		maxExpiry: 86400, // Максимум 24 часа
	},
};
