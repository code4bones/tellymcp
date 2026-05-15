import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import * as Minio from "minio";
import mime from "mime-types";
import * as redis from "redis";
import { Errors as MoleculerErrors } from "moleculer";
import { GQLSchema } from "@src/lib/moleculer";
import { DBMixin } from "@src/lib/mixins/db";
import {
	buildS3CommanderBrowseItems,
	buildS3CommanderBucketItems,
	buildS3CommanderPrefixTreeFromRows,
	calculateS3CommanderPrefixSizeStats,
} from "./s3commander.helpers";
import { uploadMiddleware } from "../../core/sys/mixins/s3/busboyUpload";
import { refreshToken, requireActiveToken, requreSession } from "../../core/api/mixins/session";

const S3C_CONNECTION_TABLE = "s3c.connection";
const S3C_DIRECTORY_MARKER_NAME = ".s3cmd.keep";
const S3C_SIZE_CACHE_PREFIX = "s3cmd:size";
const S3C_SIZE_CACHE_TTL_SEC = Math.max(
	1,
	Number.parseInt(String(process.env.S3_COMMANDER_SIZE_CACHE_TTL_SEC || "300"), 10) || 300
);

type S3CommanderRedisClient = ReturnType<typeof redis.createClient>;
type S3CommanderUploadFile = {
	originalname?: string | null;
	uniqueFilename?: string | null;
	buffer: Buffer;
	mimetype?: string | null;
	size?: number | string | null;
};
type S3CommanderUploadedItem = {
	name: string;
	objectName: string;
	size: number;
	contentType: string;
};
type S3CommanderCopiedItem = {
	sourceObject: string;
	destObject: string;
	size: number;
	contentType: string;
};

let s3CommanderRedisClient: S3CommanderRedisClient | null = null;
let s3CommanderRedisConnectPromise: Promise<S3CommanderRedisClient> | null = null;

const s3CommanderService: GQLSchema = {
	name: "s3commander",
	mixins: [DBMixin],
	hooks: {
		before: {
			"overview|connections|browse|openObject|downloadObject|downloadArchive|calculateSize": [
				requreSession,
				refreshToken,
			],
			"saveConnection|deleteConnection|testConnection|createBucket|createDirectory|deleteEntry|copyEntry|moveEntry|renameEntry":
				[requreSession, refreshToken, requireActiveToken],
			uploadObjects: [requreSession, refreshToken, requireActiveToken, uploadMiddleware],
		},
	},
	methods: {
		parseS3CommanderEndpoint(rawEndpoint, explicitUseSsl = true) {
			const value = String(rawEndpoint || "").trim();
			if (!value) {
				throw new Error("Connection endpoint is required");
			}

			const normalized = /^https?:\/\//i.test(value)
				? value
				: `${explicitUseSsl ? "https" : "http"}://${value}`;
			let parsed;
			try {
				parsed = new URL(normalized);
			} catch {
				throw new Error("Connection endpoint is invalid");
			}

			return {
				endpoint: parsed.hostname,
				port: parsed.port ? Number(parsed.port) : null,
				useSsl: parsed.protocol === "https:",
			};
		},
		async getS3CommanderRedisClient() {
			if (s3CommanderRedisClient?.isOpen) {
				return s3CommanderRedisClient;
			}
			if (!s3CommanderRedisClient) {
				s3CommanderRedisClient = redis.createClient({
					socket: {
						host: process.env.REDIS_HOST || "localhost",
						port: +(process.env.REDIS_PORT || 6379),
					},
					username: process.env.REDIS_USER || undefined,
					password: process.env.REDIS_PASSWORD || undefined,
					database: +(process.env.REDIS_DB || 0),
				});
				s3CommanderRedisClient.on("error", error => {
					this.logger.warn(`[s3commander] redis cache error: ${error?.message || error}`);
				});
			}
			if (!s3CommanderRedisConnectPromise) {
				s3CommanderRedisConnectPromise = s3CommanderRedisClient
					.connect()
					.then(() => s3CommanderRedisClient as S3CommanderRedisClient);
			}
			try {
				return await s3CommanderRedisConnectPromise;
			} catch (error) {
				s3CommanderRedisConnectPromise = null;
				throw error;
			}
		},
		getS3CommanderSizeCacheKey(connectionId, bucketName, prefixValue) {
			return `${S3C_SIZE_CACHE_PREFIX}:${String(connectionId || "").trim()}:${String(bucketName || "").trim()}:${this.normalizeS3CommanderPrefix(prefixValue)}`;
		},
		async readS3CommanderSizeCache(connectionId, bucketName, prefixValue) {
			try {
				const client = await this.getS3CommanderRedisClient();
				const cached = await client.get(
					this.getS3CommanderSizeCacheKey(connectionId, bucketName, prefixValue)
				);
				return cached ? JSON.parse(cached) : null;
			} catch (error) {
				this.logger.warn(`[s3commander] size cache read failed: ${error?.message || error}`);
				return null;
			}
		},
		async writeS3CommanderSizeCache(connectionId, bucketName, prefixValue, payload) {
			try {
				const client = await this.getS3CommanderRedisClient();
				await client.set(
					this.getS3CommanderSizeCacheKey(connectionId, bucketName, prefixValue),
					JSON.stringify(payload),
					{
						EX: S3C_SIZE_CACHE_TTL_SEC,
					}
				);
			} catch (error) {
				this.logger.warn(`[s3commander] size cache write failed: ${error?.message || error}`);
			}
		},
		async invalidateS3CommanderSizeCache(connectionId, bucketName) {
			try {
				const client = await this.getS3CommanderRedisClient();
				const pattern = `${S3C_SIZE_CACHE_PREFIX}:${String(connectionId || "").trim()}:${String(bucketName || "").trim()}:*`;
				let cursor = "0";
				do {
					// Cache invalidation must remain sequential because Redis SCAN advances by cursor.
					// eslint-disable-next-line no-await-in-loop
					const reply = await client.scan(cursor, {
						MATCH: pattern,
						COUNT: 200,
					});
					cursor = reply.cursor;
					if (reply.keys.length) {
						// Deleting the scanned batch before the next cursor step keeps invalidation predictable.
						// eslint-disable-next-line no-await-in-loop
						await client.del(reply.keys);
					}
				} while (cursor !== "0");
			} catch (error) {
				this.logger.warn(`[s3commander] size cache invalidate failed: ${error?.message || error}`);
			}
		},
		async assertS3CommanderSchema() {
			const exists = await this.db.schema.withSchema("s3c").hasTable("connection");
			if (!exists) {
				throw new Error(
					"S3 Commander schema is not initialized. Apply deploy/postgres-init/030_s3commander_schema.sql"
				);
			}
		},
		normalizeS3CommanderConnection(input = {}) {
			const payload = input && typeof input === "object" ? input : {};
			const readText = key => {
				const value = payload[key];
				return value === null || value === undefined ? null : String(value).trim();
			};
			const readBool = (key, fallback = false) => {
				const value = payload[key];
				if (value === null || value === undefined) return fallback;
				if (typeof value === "boolean") return value;
				const normalized = String(value).trim().toLowerCase();
				return (
					normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on"
				);
			};
			const rawPort = readText("port");
			const port = rawPort ? Number(rawPort) : null;
			const connectionId = readText("connectionId");
			const label = readText("label");
			const endpointInput = readText("endpoint");
			const credentials = readText("credentials");
			let accessKey = readText("accessKey");
			let secretKey = readText("secretKey");

			if (credentials && (!accessKey || !secretKey)) {
				const separatorIndex = credentials.indexOf(":");
				if (separatorIndex <= 0 || separatorIndex === credentials.length - 1) {
					throw new Error("Credentials must be in access:secret format");
				}
				accessKey = credentials.slice(0, separatorIndex).trim();
				secretKey = credentials.slice(separatorIndex + 1).trim();
			}

			if (!label) {
				throw new Error("Connection label is required");
			}
			if (!accessKey) {
				throw new Error("Connection access key is required");
			}
			if (!secretKey) {
				throw new Error("Connection secret key is required");
			}
			if (port !== null && (!Number.isFinite(port) || port <= 0 || port > 65535)) {
				throw new Error("Connection port is invalid");
			}

			const parsedEndpoint = this.parseS3CommanderEndpoint(endpointInput, readBool("useSsl", true));

			return {
				connection_id: connectionId || randomUUID(),
				label,
				endpoint: parsedEndpoint.endpoint,
				port: port ?? parsedEndpoint.port,
				region: readText("region"),
				bucket_hint: readText("bucketHint"),
				access_key: accessKey,
				secret_key: secretKey,
				use_ssl: parsedEndpoint.useSsl,
				force_path_style: readBool("forcePathStyle", true),
				notes: readText("notes"),
			};
		},
		async testS3CommanderConnection(input = {}) {
			const payload = this.normalizeS3CommanderConnection(input);
			const client = new Minio.Client({
				endPoint: payload.endpoint,
				port: payload.port || undefined,
				useSSL: payload.use_ssl,
				accessKey: payload.access_key,
				secretKey: payload.secret_key,
				region: payload.region || undefined,
			});
			const startedAt = Date.now();
			const buckets = await client.listBuckets();
			return {
				ok: true,
				endpoint: payload.endpoint,
				port: payload.port,
				useSsl: payload.use_ssl,
				region: payload.region,
				bucketCount: buckets.length,
				buckets: buckets.slice(0, 20).map(bucket => ({
					name: bucket.name,
					createdAt:
						bucket.creationDate instanceof Date
							? bucket.creationDate.toISOString()
							: bucket.creationDate,
				})),
				durationMs: Date.now() - startedAt,
			};
		},
		async getS3CommanderConnectionById(connectionId) {
			await this.assertS3CommanderSchema();
			const id = String(connectionId || "").trim();
			if (!id) {
				throw new Error("connectionId is required");
			}
			const row = await this.db(S3C_CONNECTION_TABLE)
				.select("*")
				.where({ connection_id: id })
				.first();
			if (!row) {
				throw new Error(`S3 Commander connection ${id} not found`);
			}
			return row;
		},
		createS3CommanderClient(connectionRow) {
			return new Minio.Client({
				endPoint: connectionRow.endpoint,
				port: connectionRow.port || undefined,
				useSSL: Boolean(connectionRow.use_ssl),
				accessKey: connectionRow.access_key,
				secretKey: connectionRow.secret_key,
				region: connectionRow.region || undefined,
			});
		},
		normalizeS3CommanderPrefix(value) {
			const raw = String(value || "")
				.trim()
				.replace(/^\/+/, "");
			if (!raw) {
				return "";
			}
			return raw.endsWith("/") ? raw : `${raw}/`;
		},
		normalizeS3CommanderPathSegment(value, fieldName = "name") {
			const raw = String(value || "")
				.trim()
				.replace(/^\/+|\/+$/g, "");
			if (!raw) {
				throw new MoleculerErrors.ValidationError(
					`${fieldName} is required`,
					`S3_COMMANDER_${fieldName.toUpperCase()}_REQUIRED`
				);
			}
			if (raw.includes("/")) {
				throw new MoleculerErrors.ValidationError(
					`${fieldName} must not contain '/'`,
					`S3_COMMANDER_${fieldName.toUpperCase()}_INVALID`
				);
			}
			return raw;
		},
		normalizeS3CommanderBucketName(value) {
			const bucket = this.normalizeS3CommanderPathSegment(value, "bucketName").toLowerCase();
			const isValid =
				bucket.length >= 3 &&
				bucket.length <= 63 &&
				/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(bucket) &&
				!/(\.\.)/.test(bucket) &&
				!/[.-]{2,}/.test(bucket.replace(/\.-/g, "--").replace(/-\./g, "--")) &&
				!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(bucket);

			if (!isValid) {
				throw new MoleculerErrors.ValidationError(
					"Некорректное имя бакета. Допустимы: латиница в нижнем регистре, цифры, '-' и '.'. Символ '_' запрещен.",
					"S3_COMMANDER_BUCKET_NAME_INVALID"
				);
			}

			return bucket;
		},
		isS3CommanderDirectoryMarker(objectName) {
			return path.posix.basename(String(objectName || "").trim()) === S3C_DIRECTORY_MARKER_NAME;
		},
		sanitizeS3CommanderFileName(value, fallback = "download") {
			const raw = String(value || "").trim();
			const normalized = raw
				.replace(/[\\/:*?"<>|]+/g, "-")
				.replace(/\s+/g, " ")
				.trim();
			return normalized || fallback;
		},
		sanitizeS3CommanderObjectName(value, fallback = "file") {
			const base = path.posix.basename(String(value || "").trim());
			return this.sanitizeS3CommanderFileName(base, fallback);
		},
		toSafeS3CommanderArchiveRelativePath(objectName, prefix) {
			const rawObjectName = String(objectName || "")
				.trim()
				.replace(/^\/+/, "");
			if (!rawObjectName) {
				throw new Error("Object name is required");
			}

			const normalizedPrefix = this.normalizeS3CommanderPrefix(prefix);
			const relativeSource =
				normalizedPrefix && rawObjectName.startsWith(normalizedPrefix)
					? rawObjectName.slice(normalizedPrefix.length)
					: rawObjectName;
			const parts = relativeSource
				.split("/")
				.map(part => part.trim())
				.filter(part => part && part !== "." && part !== "..");
			if (!parts.length) {
				throw new Error(`Cannot derive archive path for ${rawObjectName}`);
			}
			return path.join(...parts);
		},
		listS3CommanderObjects(client, bucketName, prefix, recursive = true) {
			return new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
				const rows: Array<Record<string, unknown>> = [];
				const stream = client.extensions.listObjectsV2WithMetadata(
					bucketName,
					this.normalizeS3CommanderPrefix(prefix),
					recursive,
					""
				);
				stream.on("data", item => rows.push(item));
				stream.on("end", () => resolve(rows));
				stream.on("error", reject);
			});
		},
		async readS3CommanderObjectBuffer(client, bucketName, objectName) {
			const stream = await client.getObject(bucketName, objectName);
			return new Promise<Buffer>((resolve, reject) => {
				const chunks: Buffer[] = [];
				stream.on("data", chunk =>
					chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
				);
				stream.on("end", () => resolve(Buffer.concat(chunks)));
				stream.on("error", reject);
			});
		},
		async createS3CommanderArchive(connectionId, bucketName, prefixValue) {
			const connection = await this.getS3CommanderConnectionById(connectionId);
			const client = this.createS3CommanderClient(connection);
			const bucket = String(bucketName || "").trim();
			const prefix = this.normalizeS3CommanderPrefix(prefixValue);
			if (!bucket) {
				throw new MoleculerErrors.ValidationError(
					"bucketName is required",
					"S3_COMMANDER_BUCKET_REQUIRED"
				);
			}

			const entries = (await this.listS3CommanderObjects(client, bucket, prefix, true)) as Array<
				Record<string, unknown>
			>;
			const objects = entries.map(entry => String(entry?.name || "").trim()).filter(Boolean);
			if (!objects.length) {
				throw new MoleculerErrors.MoleculerClientError(
					"No objects found for archive",
					404,
					"S3_COMMANDER_ARCHIVE_EMPTY"
				);
			}

			const tempRoot = await mkdtemp(path.join(os.tmpdir(), "s3commander-archive-"));
			const contentRoot = path.join(tempRoot, "content");
			const archivePath = path.join(tempRoot, "archive.zip");

			try {
				await mkdir(contentRoot, { recursive: true });
				for (const objectName of objects) {
					const relativePath = this.toSafeS3CommanderArchiveRelativePath(objectName, prefix);
					const localPath = path.join(contentRoot, relativePath);
					// Archive assembly intentionally downloads one object at a time to limit temp disk pressure.
					// eslint-disable-next-line no-await-in-loop
					await mkdir(path.dirname(localPath), { recursive: true });
					// eslint-disable-next-line no-await-in-loop
					await client.fGetObject(bucket, objectName, localPath);
				}

				await new Promise<void>((resolve, reject) => {
					const child = spawn("zip", ["-qr", archivePath, "."], {
						cwd: contentRoot,
						stdio: "ignore",
					});
					child.once("error", reject);
					child.once("close", code => {
						if (code === 0) {
							resolve();
							return;
						}
						reject(new Error(`zip exited with code ${code ?? "unknown"}`));
					});
				});

				const archiveBuffer = await readFile(archivePath);
				const scopeName = prefix
					? prefix.replace(/\/$/, "").split("/").filter(Boolean).pop()
					: bucket;
				const fileName = `${this.sanitizeS3CommanderFileName(scopeName, bucket)}.zip`;
				return {
					fileName,
					data: archiveBuffer,
					contentType: "application/zip",
				};
			} finally {
				await rm(tempRoot, { recursive: true, force: true }).catch(() => null);
			}
		},
		async buildS3CommanderObjectResponse(connectionId, bucketName, objectName) {
			const connection = await this.getS3CommanderConnectionById(connectionId);
			const client = this.createS3CommanderClient(connection);
			const bucket = String(bucketName || "").trim();
			const object = String(objectName || "")
				.trim()
				.replace(/^\/+/, "");
			if (!bucket) {
				throw new MoleculerErrors.ValidationError(
					"bucketName is required",
					"S3_COMMANDER_BUCKET_REQUIRED"
				);
			}
			if (!object) {
				throw new MoleculerErrors.ValidationError(
					"object is required",
					"S3_COMMANDER_OBJECT_REQUIRED"
				);
			}

			const stat = await client.statObject(bucket, object).catch(error => {
				throw new MoleculerErrors.MoleculerClientError(
					error?.message || "Object not found",
					404,
					"S3_COMMANDER_OBJECT_NOT_FOUND"
				);
			});
			const data = await this.readS3CommanderObjectBuffer(client, bucket, object);
			const fileName = this.sanitizeS3CommanderFileName(path.basename(object), "download.bin");
			const detectedContentType = mime.lookup(object) || mime.lookup(fileName) || null;
			const storedContentType = String(stat?.metaData?.["content-type"] || "")
				.trim()
				.toLowerCase();
			const contentType =
				!storedContentType ||
				storedContentType === "application/octet-stream" ||
				storedContentType === "binary/octet-stream"
					? detectedContentType || "application/octet-stream"
					: storedContentType;
			return {
				fileName,
				contentType,
				size: stat?.size ?? data.length,
				data,
			};
		},
		async createS3CommanderBucket(connectionId, bucketName) {
			const connection = await this.getS3CommanderConnectionById(connectionId);
			const client = this.createS3CommanderClient(connection);
			const bucket = this.normalizeS3CommanderBucketName(bucketName);
			const exists = await client.bucketExists(bucket).catch(() => false);
			if (exists) {
				throw new MoleculerErrors.MoleculerClientError(
					`Bucket ${bucket} already exists`,
					409,
					"S3_COMMANDER_BUCKET_EXISTS"
				);
			}
			await client.makeBucket(bucket, connection.region || undefined);
			await this.invalidateS3CommanderSizeCache(connection.connection_id, bucket);
			return {
				ok: true,
				connectionId: connection.connection_id,
				bucketName: bucket,
			};
		},
		async createS3CommanderDirectory(connectionId, bucketName, prefixValue, directoryName) {
			const connection = await this.getS3CommanderConnectionById(connectionId);
			const client = this.createS3CommanderClient(connection);
			const bucket = String(bucketName || "").trim();
			const prefix = this.normalizeS3CommanderPrefix(prefixValue);
			const name = this.normalizeS3CommanderPathSegment(directoryName, "directoryName");
			if (!bucket) {
				throw new MoleculerErrors.ValidationError(
					"bucketName is required",
					"S3_COMMANDER_BUCKET_REQUIRED"
				);
			}

			const objectName = `${prefix}${name}/${S3C_DIRECTORY_MARKER_NAME}`;
			const existing = await client.statObject(bucket, objectName).catch(() => null);
			if (existing) {
				throw new MoleculerErrors.MoleculerClientError(
					`Directory ${name} already exists`,
					409,
					"S3_COMMANDER_DIRECTORY_EXISTS"
				);
			}

			await client.putObject(bucket, objectName, Buffer.alloc(0), "application/x-directory");
			await this.invalidateS3CommanderSizeCache(connection.connection_id, bucket);
			return {
				ok: true,
				connectionId: connection.connection_id,
				bucketName: bucket,
				prefix,
				objectName,
			};
		},
		async deleteS3CommanderEntry(connectionId, bucketName, kind, objectName) {
			const connection = await this.getS3CommanderConnectionById(connectionId);
			const client = this.createS3CommanderClient(connection);
			const bucket = String(bucketName || "").trim();
			const entryKind = String(kind || "").trim();
			const object = String(objectName || "")
				.trim()
				.replace(/^\/+/, "");

			if (!bucket) {
				throw new MoleculerErrors.ValidationError(
					"bucketName is required",
					"S3_COMMANDER_BUCKET_REQUIRED"
				);
			}

			if (entryKind === "object") {
				if (!object) {
					throw new MoleculerErrors.ValidationError(
						"objectName is required",
						"S3_COMMANDER_OBJECT_REQUIRED"
					);
				}
				await client.removeObject(bucket, object);
				await this.invalidateS3CommanderSizeCache(connection.connection_id, bucket);
				return {
					ok: true,
					kind: entryKind,
					bucketName: bucket,
					objectName: object,
					removedObjects: 1,
				};
			}

			if (entryKind === "prefix") {
				const prefix = this.normalizeS3CommanderPrefix(object);
				if (!prefix) {
					throw new MoleculerErrors.ValidationError(
						"prefix is required",
						"S3_COMMANDER_PREFIX_REQUIRED"
					);
				}
				const rows = (await this.listS3CommanderObjects(client, bucket, prefix, true)) as Array<
					Record<string, unknown>
				>;
				const names = rows.map(row => String(row?.name || "").trim()).filter(Boolean);

				if (!names.includes(prefix)) {
					names.push(prefix);
				}

				for (const name of names) {
					// Deleting prefix contents sequentially avoids flooding the target S3 endpoint.
					// eslint-disable-next-line no-await-in-loop
					await client.removeObject(bucket, name).catch(() => null);
				}
				await this.invalidateS3CommanderSizeCache(connection.connection_id, bucket);

				return {
					ok: true,
					kind: entryKind,
					bucketName: bucket,
					objectName: prefix,
					removedObjects: names.length,
				};
			}

			if (entryKind === "bucket") {
				const rows = (await this.listS3CommanderObjects(client, bucket, "", true)) as Array<
					Record<string, unknown>
				>;
				const names = rows.map(row => String(row?.name || "").trim()).filter(Boolean);
				for (const name of names) {
					// Bucket purge stays sequential so large deletes do not overwhelm the backend.
					// eslint-disable-next-line no-await-in-loop
					await client.removeObject(bucket, name).catch(() => null);
				}
				await client.removeBucket(bucket);
				await this.invalidateS3CommanderSizeCache(connection.connection_id, bucket);
				return {
					ok: true,
					kind: entryKind,
					bucketName: bucket,
					objectName: null,
					removedObjects: names.length,
				};
			}

			throw new MoleculerErrors.ValidationError(
				`Unsupported kind ${entryKind}`,
				"S3_COMMANDER_KIND_UNSUPPORTED"
			);
		},
		async uploadS3CommanderObjects(
			connectionId,
			bucketName,
			prefixValue,
			files: S3CommanderUploadFile[] = []
		) {
			const connection = await this.getS3CommanderConnectionById(connectionId);
			const client = this.createS3CommanderClient(connection);
			const bucket = String(bucketName || "").trim();
			const prefix = this.normalizeS3CommanderPrefix(prefixValue);
			if (!bucket) {
				throw new MoleculerErrors.ValidationError(
					"bucketName is required",
					"S3_COMMANDER_BUCKET_REQUIRED"
				);
			}
			if (!Array.isArray(files) || !files.length) {
				throw new MoleculerErrors.ValidationError(
					"files are required",
					"S3_COMMANDER_FILES_REQUIRED"
				);
			}

			const uploaded: S3CommanderUploadedItem[] = [];
			const usedNames = new Map<string, number>();
			for (const file of files) {
				const originalName = this.sanitizeS3CommanderObjectName(
					file?.originalname || file?.uniqueFilename || "file",
					"file"
				);
				const parsed = path.posix.parse(originalName);
				const seenCount = usedNames.get(originalName) || 0;
				usedNames.set(originalName, seenCount + 1);
				const resolvedName =
					seenCount === 0 ? originalName : `${parsed.name} (${seenCount + 1})${parsed.ext || ""}`;
				const objectName = `${prefix}${resolvedName}`;
				const contentType = String(
					file.mimetype || mime.lookup(resolvedName) || "application/octet-stream"
				);
				// Uploading one multipart buffer at a time keeps memory/network usage bounded.
				// eslint-disable-next-line no-await-in-loop
				await client.putObject(bucket, objectName, file.buffer, contentType);
				uploaded.push({
					name: resolvedName,
					objectName,
					size: Number(file.size || 0),
					contentType,
				});
			}
			await this.invalidateS3CommanderSizeCache(connection.connection_id, bucket);

			return {
				ok: true,
				connectionId: connection.connection_id,
				bucketName: bucket,
				prefix,
				count: uploaded.length,
				uploaded,
			};
		},
		async copyS3CommanderObjectBetweenClients(
			sourceClient,
			destClient,
			sourceBucket,
			sourceObject,
			destBucket,
			destObject
		) {
			const stat = await sourceClient.statObject(sourceBucket, sourceObject);
			const stream = await sourceClient.getObject(sourceBucket, sourceObject);
			const contentType = String(
				stat?.metaData?.["content-type"] || mime.lookup(sourceObject) || "application/octet-stream"
			);
			await destClient.putObject(destBucket, destObject, stream, stat?.size, {
				"Content-Type": contentType,
			});
			return {
				sourceObject,
				destObject,
				size: Number(stat?.size || 0),
				contentType,
			};
		},
		async calculateS3CommanderEntrySize(connectionId, bucketName, prefixValue = "") {
			const bucket = String(bucketName || "").trim();
			const prefix = this.normalizeS3CommanderPrefix(prefixValue);
			if (!bucket) {
				throw new MoleculerErrors.ValidationError(
					"bucketName is required",
					"S3_COMMANDER_BUCKET_REQUIRED"
				);
			}

			const cached = await this.readS3CommanderSizeCache(connectionId, bucket, prefix);
			if (cached) {
				return {
					...cached,
					cached: true,
				};
			}

			const connection = await this.getS3CommanderConnectionById(connectionId);
			const client = this.createS3CommanderClient(connection);
			const rows = (await this.listS3CommanderObjects(client, bucket, prefix, true)) as Array<
				Record<string, unknown>
			>;
			const sizeStats = calculateS3CommanderPrefixSizeStats(rows, prefix, objectName =>
				this.isS3CommanderDirectoryMarker(objectName)
			);

			const payload = {
				connectionId: connection.connection_id,
				bucketName: bucket,
				prefix,
				...sizeStats,
				calculatedAt: new Date().toISOString(),
			};
			await this.writeS3CommanderSizeCache(connectionId, bucket, prefix, payload);
			return {
				...payload,
				cached: false,
			};
		},
		async buildS3CommanderPrefixTree(connectionId, bucketName, prefixValue = "") {
			const bucket = String(bucketName || "").trim();
			const prefix = this.normalizeS3CommanderPrefix(prefixValue);
			if (!bucket) {
				throw new MoleculerErrors.ValidationError(
					"bucketName is required",
					"S3_COMMANDER_BUCKET_REQUIRED"
				);
			}

			const connection = await this.getS3CommanderConnectionById(connectionId);
			const client = this.createS3CommanderClient(connection);
			const rows = (await this.listS3CommanderObjects(client, bucket, prefix, true)) as Array<
				Record<string, unknown>
			>;
			return {
				connectionId: connection.connection_id,
				bucketName: bucket,
				prefix,
				tree: buildS3CommanderPrefixTreeFromRows(
					bucket,
					prefix,
					rows,
					value => this.normalizeS3CommanderPrefix(value),
					objectName => this.isS3CommanderDirectoryMarker(objectName)
				),
			};
		},
		async transferS3CommanderEntry(params, move = false) {
			const sourceConnectionId = String(params.sourceConnectionId || "").trim();
			const sourceBucketName = String(params.sourceBucketName || "").trim();
			const kind = String(params.kind || "").trim();
			const sourceObjectName = String(params.sourceObjectName || "")
				.trim()
				.replace(/^\/+/, "");
			const destConnectionId = String(params.destConnectionId || "").trim();
			const destBucketName = String(params.destBucketName || "").trim();
			const destPrefix = this.normalizeS3CommanderPrefix(params.destPrefix);

			if (!sourceConnectionId || !destConnectionId) {
				throw new MoleculerErrors.ValidationError(
					"sourceConnectionId and destConnectionId are required",
					"S3_COMMANDER_CONNECTION_REQUIRED"
				);
			}
			if (!sourceBucketName || !destBucketName) {
				throw new MoleculerErrors.ValidationError(
					"sourceBucketName and destBucketName are required",
					"S3_COMMANDER_BUCKET_REQUIRED"
				);
			}
			if (kind !== "object" && kind !== "prefix") {
				throw new MoleculerErrors.ValidationError(
					"Only object and prefix transfers are supported",
					"S3_COMMANDER_TRANSFER_KIND_UNSUPPORTED"
				);
			}
			if (!sourceObjectName) {
				throw new MoleculerErrors.ValidationError(
					"sourceObjectName is required",
					"S3_COMMANDER_SOURCE_OBJECT_REQUIRED"
				);
			}

			const [sourceConnection, destConnection] = await Promise.all([
				this.getS3CommanderConnectionById(sourceConnectionId),
				this.getS3CommanderConnectionById(destConnectionId),
			]);
			const sourceClient = this.createS3CommanderClient(sourceConnection);
			const destClient = this.createS3CommanderClient(destConnection);

			if (kind === "object") {
				const fileName = path.posix.basename(sourceObjectName);
				const destObjectName = `${destPrefix}${fileName}`;
				if (
					sourceConnectionId === destConnectionId &&
					sourceBucketName === destBucketName &&
					sourceObjectName === destObjectName
				) {
					throw new MoleculerErrors.ValidationError(
						"Source and destination are identical",
						"S3_COMMANDER_TRANSFER_NOOP"
					);
				}

				const copied = await this.copyS3CommanderObjectBetweenClients(
					sourceClient,
					destClient,
					sourceBucketName,
					sourceObjectName,
					destBucketName,
					destObjectName
				);
				if (move) {
					await this.deleteS3CommanderEntry(
						sourceConnectionId,
						sourceBucketName,
						"object",
						sourceObjectName
					);
				}
				await this.invalidateS3CommanderSizeCache(destConnectionId, destBucketName);
				return {
					ok: true,
					mode: move ? "move" : "copy",
					kind,
					sourceBucketName,
					sourceObjectName,
					destBucketName,
					destObjectName,
					copiedCount: 1,
					copied,
				};
			}

			const sourcePrefix = this.normalizeS3CommanderPrefix(sourceObjectName);
			if (!sourcePrefix) {
				throw new MoleculerErrors.ValidationError(
					"source prefix is required",
					"S3_COMMANDER_PREFIX_REQUIRED"
				);
			}
			const prefixName =
				sourcePrefix.replace(/\/$/, "").split("/").filter(Boolean).pop() || "folder";
			const destPrefixRoot = `${destPrefix}${prefixName}/`;
			if (
				move &&
				sourceConnectionId === destConnectionId &&
				sourceBucketName === destBucketName &&
				(destPrefixRoot === sourcePrefix || destPrefixRoot.startsWith(sourcePrefix))
			) {
				throw new MoleculerErrors.ValidationError(
					"Cannot move a folder into itself",
					"S3_COMMANDER_MOVE_INTO_SELF"
				);
			}

			const rows = (await this.listS3CommanderObjects(
				sourceClient,
				sourceBucketName,
				sourcePrefix,
				true
			)) as Array<Record<string, unknown>>;
			const objects = rows.map(row => String(row?.name || "").trim()).filter(Boolean);
			if (!objects.length) {
				throw new MoleculerErrors.MoleculerClientError(
					"Source folder is empty",
					404,
					"S3_COMMANDER_PREFIX_EMPTY"
				);
			}

			const copied: S3CommanderCopiedItem[] = [];
			for (const objectName of objects) {
				const relativePath = sourceObjectName.endsWith("/")
					? objectName.slice(sourcePrefix.length)
					: objectName.slice(sourceObjectName.length);
				const destObjectName = `${destPrefixRoot}${relativePath}`;
				// Prefix transfer is intentionally sequential to preserve predictable copy order and backpressure.
				copied.push(
					// eslint-disable-next-line no-await-in-loop
					await this.copyS3CommanderObjectBetweenClients(
						sourceClient,
						destClient,
						sourceBucketName,
						objectName,
						destBucketName,
						destObjectName
					)
				);
			}

			if (move) {
				await this.deleteS3CommanderEntry(
					sourceConnectionId,
					sourceBucketName,
					"prefix",
					sourcePrefix
				);
			}
			await this.invalidateS3CommanderSizeCache(destConnectionId, destBucketName);

			return {
				ok: true,
				mode: move ? "move" : "copy",
				kind,
				sourceBucketName,
				sourceObjectName: sourcePrefix,
				destBucketName,
				destObjectName: destPrefixRoot,
				copiedCount: copied.length,
				copied,
			};
		},
		async renameS3CommanderEntry(connectionId, bucketName, kind, objectName, newName) {
			const connection = await this.getS3CommanderConnectionById(connectionId);
			const client = this.createS3CommanderClient(connection);
			const entryKind = String(kind || "").trim();
			const bucket = String(bucketName || "").trim();
			const sourceObjectName = String(objectName || "")
				.trim()
				.replace(/^\/+/, "");
			const nextNameRaw = String(newName || "").trim();

			if (!nextNameRaw) {
				throw new MoleculerErrors.ValidationError(
					"newName is required",
					"S3_COMMANDER_RENAME_NAME_REQUIRED"
				);
			}

			if (entryKind === "bucket") {
				if (!bucket) {
					throw new MoleculerErrors.ValidationError(
						"bucketName is required",
						"S3_COMMANDER_BUCKET_REQUIRED"
					);
				}
				const nextBucket = this.normalizeS3CommanderBucketName(nextNameRaw);
				if (nextBucket === bucket) {
					throw new MoleculerErrors.ValidationError(
						"Source and destination are identical",
						"S3_COMMANDER_RENAME_NOOP"
					);
				}
				const exists = await client.bucketExists(nextBucket).catch(() => false);
				if (exists) {
					throw new MoleculerErrors.MoleculerClientError(
						`Bucket ${nextBucket} already exists`,
						409,
						"S3_COMMANDER_BUCKET_EXISTS"
					);
				}

				await client.makeBucket(nextBucket, connection.region || undefined);
				const rows = (await this.listS3CommanderObjects(client, bucket, "", true)) as Array<
					Record<string, unknown>
				>;
				const objects = rows.map(row => String(row?.name || "").trim()).filter(Boolean);
				for (const currentObjectName of objects) {
					// Bucket rename must copy objects one by one because MinIO exposes copy per object.
					// eslint-disable-next-line no-await-in-loop
					await this.copyS3CommanderObjectBetweenClients(
						client,
						client,
						bucket,
						currentObjectName,
						nextBucket,
						currentObjectName
					);
				}
				await this.deleteS3CommanderEntry(connection.connection_id, bucket, "bucket", null);
				await this.invalidateS3CommanderSizeCache(connection.connection_id, nextBucket);
				return {
					ok: true,
					kind: entryKind,
					connectionId: connection.connection_id,
					bucketName: nextBucket,
					objectName: null,
					oldBucketName: bucket,
					newBucketName: nextBucket,
				};
			}

			if (entryKind === "object") {
				if (!bucket) {
					throw new MoleculerErrors.ValidationError(
						"bucketName is required",
						"S3_COMMANDER_BUCKET_REQUIRED"
					);
				}
				if (!sourceObjectName) {
					throw new MoleculerErrors.ValidationError(
						"objectName is required",
						"S3_COMMANDER_OBJECT_REQUIRED"
					);
				}
				const parentPrefix = sourceObjectName.includes("/")
					? `${sourceObjectName.split("/").slice(0, -1).join("/")}/`
					: "";
				const fileName = this.sanitizeS3CommanderObjectName(nextNameRaw, "file");
				const destObjectName = `${parentPrefix}${fileName}`;
				if (destObjectName === sourceObjectName) {
					throw new MoleculerErrors.ValidationError(
						"Source and destination are identical",
						"S3_COMMANDER_RENAME_NOOP"
					);
				}
				const existing = await client.statObject(bucket, destObjectName).catch(() => null);
				if (existing) {
					throw new MoleculerErrors.MoleculerClientError(
						`Object ${fileName} already exists`,
						409,
						"S3_COMMANDER_OBJECT_EXISTS"
					);
				}
				await this.copyS3CommanderObjectBetweenClients(
					client,
					client,
					bucket,
					sourceObjectName,
					bucket,
					destObjectName
				);
				await this.deleteS3CommanderEntry(
					connection.connection_id,
					bucket,
					"object",
					sourceObjectName
				);
				await this.invalidateS3CommanderSizeCache(connection.connection_id, bucket);
				return {
					ok: true,
					kind: entryKind,
					connectionId: connection.connection_id,
					bucketName: bucket,
					objectName: destObjectName,
					oldObjectName: sourceObjectName,
					newObjectName: destObjectName,
				};
			}

			if (entryKind === "prefix") {
				if (!bucket) {
					throw new MoleculerErrors.ValidationError(
						"bucketName is required",
						"S3_COMMANDER_BUCKET_REQUIRED"
					);
				}
				const sourcePrefix = this.normalizeS3CommanderPrefix(sourceObjectName);
				if (!sourcePrefix) {
					throw new MoleculerErrors.ValidationError(
						"prefix is required",
						"S3_COMMANDER_PREFIX_REQUIRED"
					);
				}
				const sourceParts = sourcePrefix.replace(/\/$/, "").split("/").filter(Boolean);
				const parentPrefix = sourceParts.length > 1 ? `${sourceParts.slice(0, -1).join("/")}/` : "";
				const prefixName = this.normalizeS3CommanderPathSegment(nextNameRaw, "directoryName");
				const destPrefix = `${parentPrefix}${prefixName}/`;
				if (destPrefix === sourcePrefix) {
					throw new MoleculerErrors.ValidationError(
						"Source and destination are identical",
						"S3_COMMANDER_RENAME_NOOP"
					);
				}
				const existingRows = (await this.listS3CommanderObjects(
					client,
					bucket,
					destPrefix,
					true
				)) as Array<Record<string, unknown>>;
				if (existingRows.some(row => String(row?.name || "").trim())) {
					throw new MoleculerErrors.MoleculerClientError(
						`Directory ${prefixName} already exists`,
						409,
						"S3_COMMANDER_DIRECTORY_EXISTS"
					);
				}

				const rows = (await this.listS3CommanderObjects(
					client,
					bucket,
					sourcePrefix,
					true
				)) as Array<Record<string, unknown>>;
				const objects = rows.map(row => String(row?.name || "").trim()).filter(Boolean);
				if (!objects.length) {
					throw new MoleculerErrors.MoleculerClientError(
						"Source folder is empty",
						404,
						"S3_COMMANDER_PREFIX_EMPTY"
					);
				}
				for (const currentObjectName of objects) {
					const relativePath = currentObjectName.slice(sourcePrefix.length);
					const destObjectName = `${destPrefix}${relativePath}`;
					// Prefix rename remains sequential so copy+delete semantics stay deterministic.
					// eslint-disable-next-line no-await-in-loop
					await this.copyS3CommanderObjectBetweenClients(
						client,
						client,
						bucket,
						currentObjectName,
						bucket,
						destObjectName
					);
				}
				await this.deleteS3CommanderEntry(connection.connection_id, bucket, "prefix", sourcePrefix);
				await this.invalidateS3CommanderSizeCache(connection.connection_id, bucket);
				return {
					ok: true,
					kind: entryKind,
					connectionId: connection.connection_id,
					bucketName: bucket,
					objectName: destPrefix,
					oldObjectName: sourcePrefix,
					newObjectName: destPrefix,
				};
			}

			throw new MoleculerErrors.ValidationError(
				`Unsupported kind ${entryKind}`,
				"S3_COMMANDER_KIND_UNSUPPORTED"
			);
		},
		async browseS3CommanderConnection(connectionId, bucketName, prefixValue) {
			const connection = await this.getS3CommanderConnectionById(connectionId);
			const client = this.createS3CommanderClient(connection);
			const bucket = String(bucketName || "").trim() || null;
			const prefix = this.normalizeS3CommanderPrefix(prefixValue);

			if (!bucket) {
				const buckets = await client.listBuckets();
				const items = buildS3CommanderBucketItems(buckets);
				return {
					connectionId: connection.connection_id,
					bucket: null,
					prefix: "",
					parentPrefix: null,
					items,
				};
			}

			const objects = (await new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
				const rows: Array<Record<string, unknown>> = [];
				const stream = client.extensions.listObjectsV2WithMetadata(bucket, prefix, false, "");
				stream.on("data", item => rows.push(item));
				stream.on("end", () => resolve(rows));
				stream.on("error", reject);
			})) as Array<Record<string, unknown>>;

			const items = buildS3CommanderBrowseItems(bucket, objects, objectName =>
				this.isS3CommanderDirectoryMarker(objectName)
			);

			const parentPrefix = prefix
				? prefix.replace(/\/$/, "").split("/").slice(0, -1).filter(Boolean).join("/")
				: null;

			return {
				connectionId: connection.connection_id,
				bucket,
				prefix,
				parentPrefix: parentPrefix ? `${parentPrefix}/` : bucket ? "" : null,
				items,
			};
		},
		toS3CommanderConnectionGraph(row) {
			if (!row) return null;
			return {
				connectionId: row.connection_id,
				label: row.label,
				endpoint: row.endpoint,
				port: row.port,
				region: row.region,
				bucketHint: row.bucket_hint,
				accessKey: row.access_key,
				secretKey: row.secret_key,
				useSsl: row.use_ssl,
				forcePathStyle: row.force_path_style,
				notes: row.notes,
				createdAt: row.created_at,
				updatedAt: row.updated_at,
			};
		},
		async listS3CommanderConnections() {
			await this.assertS3CommanderSchema();
			const rows = await this.db(S3C_CONNECTION_TABLE)
				.select("*")
				.orderBy([
					{ column: "label", order: "asc" },
					{ column: "created_at", order: "asc" },
				]);
			return rows.map(row => this.toS3CommanderConnectionGraph(row));
		},
	},
	actions: {
		overview: {
			graphql: {
				query: "s3CommanderOverview:JSON",
			},
			async handler() {
				let connections: unknown[] = [];
				try {
					connections = await this.listS3CommanderConnections();
				} catch (error) {
					this.logger.warn(`[s3commander] overview without schema: ${error.message}`);
				}
				return {
					ready: true,
					mode: "skeleton",
					service: "s3commander",
					features: {
						connections: false,
						listing: false,
						jobs: false,
						copyBetweenPanels: false,
					},
					connections,
					leftPanel: {
						connectionId: null,
						connectionLabel: null,
						bucket: null,
						prefix: "/",
						items: [],
					},
					rightPanel: {
						connectionId: null,
						connectionLabel: null,
						bucket: null,
						prefix: "/",
						items: [],
					},
					serverTime: new Date().toISOString(),
				};
			},
		},
		connections: {
			graphql: {
				query: "s3CommanderConnections:JSON",
			},
			handler() {
				return this.listS3CommanderConnections();
			},
		},
		browse: {
			graphql: {
				query: "s3CommanderBrowse(connectionId:String!,bucket:String,prefix:String):JSON",
			},
			handler(ctx) {
				return this.browseS3CommanderConnection(
					ctx.params.connectionId,
					ctx.params.bucket,
					ctx.params.prefix
				);
			},
		},
		calculateSize: {
			graphql: {
				query:
					"s3CommanderCalculateSize(connectionId:String!,bucketName:String!,prefix:String):JSON",
			},
			handler(ctx) {
				return this.calculateS3CommanderEntrySize(
					ctx.params.connectionId,
					ctx.params.bucketName,
					ctx.params.prefix
				);
			},
		},
		prefixTree: {
			graphql: {
				query: "s3CommanderPrefixTree(connectionId:String!,bucketName:String!,prefix:String):JSON",
			},
			handler(ctx) {
				return this.buildS3CommanderPrefixTree(
					ctx.params.connectionId,
					ctx.params.bucketName,
					ctx.params.prefix
				);
			},
		},
		saveConnection: {
			graphql: {
				mutation: "s3CommanderSaveConnection(input:JSON!):JSON",
			},
			async handler(ctx) {
				await this.assertS3CommanderSchema();
				const payload = this.normalizeS3CommanderConnection(ctx.params.input || {});
				const existing = await this.db(S3C_CONNECTION_TABLE)
					.select("connection_id")
					.where({ connection_id: payload.connection_id })
					.first();

				if (existing) {
					await this.db(S3C_CONNECTION_TABLE)
						.where({ connection_id: payload.connection_id })
						.update({
							...payload,
							updated_at: this.db.fn.now(),
						});
				} else {
					await this.db(S3C_CONNECTION_TABLE).insert({
						...payload,
						created_at: this.db.fn.now(),
						updated_at: this.db.fn.now(),
					});
				}

				const row = await this.db(S3C_CONNECTION_TABLE)
					.select("*")
					.where({ connection_id: payload.connection_id })
					.first();
				return this.toS3CommanderConnectionGraph(row);
			},
		},
		deleteConnection: {
			graphql: {
				mutation: "s3CommanderDeleteConnection(connectionId:String!):JSON",
			},
			async handler(ctx) {
				await this.assertS3CommanderSchema();
				const connectionId = String(ctx.params.connectionId || "").trim();
				if (!connectionId) {
					throw new Error("connectionId is required");
				}
				await this.db(S3C_CONNECTION_TABLE).where({ connection_id: connectionId }).delete();
				return {
					connectionId,
					deleted: true,
				};
			},
		},
		testConnection: {
			graphql: {
				mutation: "s3CommanderTestConnection(input:JSON!):JSON",
			},
			handler(ctx) {
				return this.testS3CommanderConnection(ctx.params.input || {});
			},
		},
		createBucket: {
			graphql: {
				mutation: "s3CommanderCreateBucket(connectionId:String!,bucketName:String!):JSON",
			},
			handler(ctx) {
				return this.createS3CommanderBucket(ctx.params.connectionId, ctx.params.bucketName);
			},
		},
		createDirectory: {
			graphql: {
				mutation:
					"s3CommanderCreateDirectory(connectionId:String!,bucketName:String!,prefix:String,name:String!):JSON",
			},
			handler(ctx) {
				return this.createS3CommanderDirectory(
					ctx.params.connectionId,
					ctx.params.bucketName,
					ctx.params.prefix,
					ctx.params.name
				);
			},
		},
		deleteEntry: {
			graphql: {
				mutation:
					"s3CommanderDeleteEntry(connectionId:String!,bucketName:String!,kind:String!,objectName:String):JSON",
			},
			handler(ctx) {
				return this.deleteS3CommanderEntry(
					ctx.params.connectionId,
					ctx.params.bucketName,
					ctx.params.kind,
					ctx.params.objectName
				);
			},
		},
		copyEntry: {
			graphql: {
				mutation:
					"s3CommanderCopyEntry(sourceConnectionId:String!,sourceBucketName:String!,kind:String!,sourceObjectName:String!,destConnectionId:String!,destBucketName:String!,destPrefix:String):JSON",
			},
			handler(ctx) {
				return this.transferS3CommanderEntry(ctx.params, false);
			},
		},
		moveEntry: {
			graphql: {
				mutation:
					"s3CommanderMoveEntry(sourceConnectionId:String!,sourceBucketName:String!,kind:String!,sourceObjectName:String!,destConnectionId:String!,destBucketName:String!,destPrefix:String):JSON",
			},
			handler(ctx) {
				return this.transferS3CommanderEntry(ctx.params, true);
			},
		},
		renameEntry: {
			graphql: {
				mutation:
					"s3CommanderRenameEntry(connectionId:String!,bucketName:String!,kind:String!,objectName:String,newName:String!):JSON",
			},
			handler(ctx) {
				return this.renameS3CommanderEntry(
					ctx.params.connectionId,
					ctx.params.bucketName,
					ctx.params.kind,
					ctx.params.objectName,
					ctx.params.newName
				);
			},
		},
		uploadObjects: {
			params: {
				connectionId: "string",
				bucketName: "string",
				prefix: { type: "string", optional: true },
			},
			handler(ctx) {
				const prefix = ctx.params.prefix ?? ctx.params.fields?.prefix ?? null;
				return this.uploadS3CommanderObjects(
					ctx.params.connectionId,
					ctx.params.bucketName,
					prefix,
					ctx.params.files || []
				);
			},
		},
		openObject: {
			params: {
				connectionId: "string",
				bucketName: "string",
				object: "string",
			},
			async handler(ctx) {
				const file = await this.buildS3CommanderObjectResponse(
					ctx.params.connectionId,
					ctx.params.bucketName,
					ctx.params.object
				);
				ctx.meta.$responseHeaders = {
					"Content-Type": String(file.contentType),
					"Content-Length": String(file.size),
					"Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
				};
				ctx.meta.$responseType = String(file.contentType);
				return file.data;
			},
		},
		downloadObject: {
			params: {
				connectionId: "string",
				bucketName: "string",
				object: "string",
			},
			async handler(ctx) {
				const file = await this.buildS3CommanderObjectResponse(
					ctx.params.connectionId,
					ctx.params.bucketName,
					ctx.params.object
				);
				ctx.meta.$responseHeaders = {
					"Content-Type": String(file.contentType),
					"Content-Length": String(file.size),
					"Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
				};
				ctx.meta.$responseType = String(file.contentType);
				return file.data;
			},
		},
		downloadArchive: {
			params: {
				connectionId: "string",
				bucketName: "string",
				prefix: { type: "string", optional: true },
			},
			async handler(ctx) {
				const archive = await this.createS3CommanderArchive(
					ctx.params.connectionId,
					ctx.params.bucketName,
					ctx.params.prefix
				);
				ctx.meta.$responseHeaders = {
					"Content-Type": archive.contentType,
					"Content-Length": String(archive.data.length),
					"Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(archive.fileName)}`,
				};
				ctx.meta.$responseType = archive.contentType;
				return archive.data;
			},
		},
	},
};

export = s3CommanderService;
