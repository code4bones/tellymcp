/**
 * MinIO S3 Storage Service для Moleculer
 *
 * @description Сервис для работы с объектным хранилищем MinIO
 * Предоставляет методы для загрузки, скачивания, удаления файлов
 * и управления бакетами
 *
 * @author Qwen ))
 * @version 1.0.0
 * @requires minio - MinIO JavaScript Client SDK
 * @requires streamifier - Для преобразования буферов в потоки
 * @requires mime-types - Для определения MIME типов
 */

import { GQLSchema } from "@core/index";
import { uploadMiddleware } from "./mixins/s3/busboyUpload";
import config from "./mixins/s3/minio.config";
import { readFileSync } from "fs";
import fs from "fs";
import { mkdir, rm } from "fs/promises";
import sharp from "sharp";
import path from "path";
import { createHmac, randomUUID } from "crypto";
import { spawn } from "child_process";
import mime from "mime-types";
import { MinIOClient } from "./mixins/s3/minio.client";
import { Errors as MoleculerErrors } from "moleculer";
import _ from "lodash";
import { isInternalCall, refreshToken, requreSession } from "../api/mixins/session";
import { formatMinioStorageRef, parseStorageRef } from "./mixins/s3/storage-ref";
import { DBMixin } from "@src/lib/mixins/db";
import { PubBuilder } from "@src/lib/pubsub";
import { loadTraceContext } from "@src/lib/traceContext";
import { publishVfsBridgeEvent } from "@src/lib/vfsEventBridge";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TILE_META_CACHE_TTL_MS = Math.max(
	1000,
	Number(process.env.MINIO_TILE_META_CACHE_TTL_MS || 5000)
);
const TILE_TOKEN_TTL_MIN = Math.max(
	1,
	Number(process.env.MINIO_TILE_TOKEN_TTL_MIN || 180)
);
const TILE_TOKEN_TTL_SEC = TILE_TOKEN_TTL_MIN * 60;
const TILE_DELETE_BATCH_SIZE = Math.max(
	50,
	Number(process.env.MINIO_TILE_DELETE_BATCH_SIZE || 500)
);
const TILE_DELETE_WORKER_STALE_MIN = Math.max(
	1,
	Number(process.env.MINIO_TILE_DELETE_WORKER_STALE_MIN || 30)
);
const TILE_DELETE_WORKER_START_GRACE_MS = 15 * 1000;
const MINIO_TILE_DELETE_PROGRESS_EVENT = "minio.tileDeleteProgress";
const DEFAULT_PREVIEW_SIZE = Math.max(
	64,
	Number(process.env.VFS_PREVIEW_DEFAULT_SIZE || 1024)
);
const PREVIEW_JPEG_QUALITY = Math.max(
	60,
	Math.min(100, Number(process.env.VFS_PREVIEW_JPEG_QUALITY || 90))
);
const UPLOAD_JOB_STALE_SEC = Math.max(
	15,
	Number(process.env.MINIO_UPLOAD_JOB_STALE_SEC || 30)
);

const isUuid = (value: string) => UUID_RE.test(String(value || "").trim());

declare module "moleculer" {
	interface Service {
		client: MinIOClient;
	}
}

type VfsAccessResult = {
	allowed: boolean;
	effectiveVisibility: string;
	node?: {
		node_id: number;
		name?: string;
	};
};

const minioService: GQLSchema = {
	name: "minio",
	mixins: [DBMixin],

	/**
	 * Метаданные сервиса
	 */
	metadata: {
		$category: "storage",
		$description: "MinIO S3 Storage Service",
		$official: false,
		$package: {
			name: "moleculer-minio",
			version: "1.0.0",
		},
	},

	/**
	 * Зависимости сервиса
	 */
	dependencies: [],

	/**
	 * Настройки сервиса
	 */
	settings: {
		// MinIO конфигурация из файла
		minio: config.minio,

		// Время ожидания для действий
		timeout: 30000, // 30 секунд

		// Количество повторных попыток
		retryCount: 3,
		retryDelay: 1000,

		// Включение кэширования
		caching: config.minio.cache.enabled,
		cacheCleanInterval: config.minio.cache.checkPeriod * 1000,
	},

	/**
	 * Инициализация сервиса
	 */
	created() {
		this.logger.info("Initializing MinIO service...");

		// Создание MinIO клиента
		this.client = new MinIOClient(this.logger);
		this.tileNodeCache = new Map();
		this.tileAccessCache = new Map();
		this.tileRecordCache = new Map();

		this.logger.info("MinIO client initialized successfully");
	},

	/**
	 * Старт сервиса
	 */
	async started() {
		this.logger.info("Starting MinIO service...");

		try {
			await this.ensureUploadJobSchema();
			await this.ensurePreviewSchema();
			await this.ensureTileDeleteSchema();
			// Проверка соединения с сервером
			await this.client.checkConnection();

			// Создание бакетов по умолчанию
			await this.client.createDefaultBuckets();
			await this.cleanupActiveUploadJobsOnStart();

			this.logger.info("MinIO service started successfully");
		} catch (error) {
			this.logger.error("Failed to start MinIO service:", error);
			throw error;
		}
	},

	/**
	 * Остановка сервиса
	 */
	stopped() {
		this.logger.info("Stopping MinIO service...");
		this.tileNodeCache?.clear?.();
		this.tileAccessCache?.clear?.();
		this.tileRecordCache?.clear?.();
		// Очистка ресурсов если необходимо
	},

	hooks: {
		before: {
			"createBucket|removeBucket|listBuckets": [requreSession, refreshToken, "enforceAdminAccess"],
			"bucketExists|getObject|objectExists|statObject|listObjects|presignedGetObject|getPublicUrl|tileInfo":
				[requreSession, refreshToken, "enforceReadAccess"],
			"uploadJobs": [requreSession, refreshToken, "enforceReadAccess"],
			"slice|putObject|presignedPutObject|copyObject|ingest|requestUpload|uploadProgress|abortUpload|completeUpload|upload": [
				requreSession,
				refreshToken,
				"enforceWriteAccess",
			],
			"removeObject|deleteTilesByNodeId|tileDeleteJob|tileDeleteJobs": [requreSession, refreshToken, "enforceDeleteAccess"],
			"upload|ingest": [uploadMiddleware],
		},
	},
	/**
	 * Действия сервиса
	 */
	actions: {
		front: {
			rest: {
				fullPath: "/api/tiles",
			},
			handler(ctx) {
				const html = readFileSync(process.env.TILES);
				ctx.meta.$responseHeaders = {
					"Content-Type": "text/html",
				};
				return html;
			},
		},
		slice: {
			graphql: {
				mutation: "minioSlice(nodeId:Int!,force:Boolean):JSON",
			},
			async handler(ctx) {
				const { nodeId, force = false } = ctx.params;
				const existing = await this.getTileInfoByNodeId(nodeId);
				if (existing && !force) {
					return {
						...existing,
						status: "exists",
					};
				}

				const node = await this.getVfsFileNode(nodeId);
				const ref = this.parseMinioRef(node.hash);
				const access = (await this.broker.call("vfs.resolveAccess", {
					node_id: nodeId,
					permission: "read",
				})) as VfsAccessResult;
				const tilesBucket = this.getTilesBucketByVisibility(
					access?.effectiveVisibility || "private"
				);
				const tilePrefix = this.getTilePrefix(node.node_id);
				const localRoot = path.join("/tmp/minio-tiles", String(node.node_id));
				const localBase = path.join(localRoot, "source");

				if (existing || force) {
					await this.deleteTilesByNodeId(nodeId, false);
				}

				await rm(localRoot, { recursive: true, force: true });
				await mkdir(localRoot, { recursive: true });

				const data = await this.client.getObject(ref.bucketName, ref.objectName);
				await sharp(data)
					.tile({
						size: 256,
						container: "fs",
						layout: "dz",
						overlap: 0,
					})
					.toFile(localBase);

				const files = await this.client.readDirTree(localRoot);
				await Promise.all(
					files.map(filePath => {
						const relativePath = path.relative(localRoot, filePath).replaceAll(path.sep, "/");
						return this.client.fPutObject(tilesBucket, `${tilePrefix}/${relativePath}`, filePath, {
							source_node_id: String(node.node_id),
							source_ref: node.hash,
						});
					})
				);

				await this.upsertTileRecord({
					nodeId,
					sourceRef: node.hash,
					bucketName: tilesBucket,
					dziObjectName: `${tilePrefix}/source.dzi`,
					tilePrefix: `${tilePrefix}/source_files/`,
				});

				const tileInfo = await this.getTileInfoByNodeId(nodeId);
				if (!tileInfo) {
					throw new Error("Tile manifest was not created");
				}
				await this.publishVfsTileEvent(ctx, nodeId, "tiles-create");

				return {
					...tileInfo,
					status: "created",
				};
			},
		},
		tileInfo: {
			graphql: {
				query: "minioTileInfo(nodeId:Int!):JSON",
			},
			handler(ctx) {
				return this.getTileInfoByNodeId(ctx.params.nodeId);
			},
		},
		syncTilesVisibility: {
			visibility: "protected",
			params: {
				nodeId: "number",
			},
			handler(ctx) {
				return this.syncTilesVisibility(ctx.params.nodeId);
			},
		},
		deleteTilesByNodeId: {
			visibility: "protected",
			params: {
				nodeId: "number",
			},
			async handler(ctx) {
				await this.ensureTileDeleteSchema();
				await this.reconcileTileDeleteJobs();
				const result = await this.enqueueTileDeleteJob(ctx, ctx.params.nodeId);
				return result;
			},
		},
		tileDeleteJob: {
			visibility: "protected",
			graphql: {
				query: "tileDeleteJob(node_id:Int!):JSON",
			},
			params: {
				node_id: "number",
			},
			async handler(ctx) {
				await this.ensureTileDeleteSchema();
				await this.reconcileTileDeleteJobs();
				const job = await this.db("storage.tile_delete_job")
					.select("*")
					.where({ node_id: ctx.params.node_id })
					.orderBy("created_at", "desc")
					.first();
				if (!job) {
					return null;
				}
				return {
					job_id: String(job.job_id),
					node_id: Number(job.node_id),
					trace_session_id: job.trace_session_id || null,
					status: String(job.status || ""),
					phase: String(job.phase || ""),
					scanned: Number(job.scanned || 0),
					total:
						job.total == null || job.total === ""
							? null
							: Number(job.total),
					deleted: Number(job.deleted || 0),
					percent:
						job.percent == null || job.percent === ""
							? null
							: Number(job.percent),
					last_error: job.last_error || null,
					created_at: job.created_at || null,
					started_at: job.started_at || null,
					finished_at: job.finished_at || null,
				};
			},
		},
		tileDeleteJobs: {
			visibility: "protected",
			graphql: {
				query: "tileDeleteJobs(node_ids:[Int!]):JSON",
			},
			params: {
				node_ids: { type: "array", items: "number", optional: true },
			},
			async handler(ctx) {
				await this.ensureTileDeleteSchema();
				await this.reconcileTileDeleteJobs();
				const nodeIds = Array.from(
					new Set(
						(Array.isArray(ctx.params.node_ids) ? ctx.params.node_ids : [])
							.map(value => Number(value))
							.filter(value => Number.isInteger(value) && value > 0)
					)
				);
				if (!nodeIds.length) {
					return [];
				}
				const rows = await this.db("storage.tile_delete_job")
					.select("*")
					.whereIn("node_id", nodeIds)
					.orderBy([
						{ column: "node_id", order: "asc" },
						{ column: "created_at", order: "desc" },
					]);
				const latestByNodeId = new Map<number, any>();
				rows.forEach(row => {
					const nodeId = Number(row.node_id);
					if (!latestByNodeId.has(nodeId)) {
						latestByNodeId.set(nodeId, row);
					}
				});
				return Array.from(latestByNodeId.values()).map(job => ({
					job_id: String(job.job_id),
					node_id: Number(job.node_id),
					trace_session_id: job.trace_session_id || null,
					status: String(job.status || ""),
					phase: String(job.phase || ""),
					scanned: Number(job.scanned || 0),
					total:
						job.total == null || job.total === ""
							? null
							: Number(job.total),
					deleted: Number(job.deleted || 0),
					percent:
						job.percent == null || job.percent === ""
							? null
							: Number(job.percent),
					last_error: job.last_error || null,
					created_at: job.created_at || null,
					started_at: job.started_at || null,
					finished_at: job.finished_at || null,
				}));
			},
		},
		publishTileDeleteProgress: {
			handler(ctx) {
				return PubBuilder.New(ctx, MINIO_TILE_DELETE_PROGRESS_EVENT)
					.payload(ctx.params || {})
					.pub();
			},
		},
		notifyTileDeleteFinished: {
			async handler(ctx) {
				const nodeId = Number(ctx.params.nodeId || 0);
				const status = String(ctx.params.status || "");
				const payload = {
					node_id: nodeId,
					status,
					phase: status,
				};
				await PubBuilder.New(ctx, MINIO_TILE_DELETE_PROGRESS_EVENT)
					.payload(payload)
					.pub();
				return { ok: true };
			},
		},
		onTileDeleteProgress: {
			graphql: {
				subscription: "tileDeleteProgress(node_id:Int!):JSON",
				tags: [MINIO_TILE_DELETE_PROGRESS_EVENT],
				filter: "minio.tileDeleteProgressFilter",
			},
			handler(ctx) {
				return ctx.params.payload;
			},
		},
		tileDeleteProgressFilter: {
			handler(ctx) {
				const { node_id, payload } = ctx.params;
				return Number(node_id) === Number(payload?.node_id);
			},
		},
		tileAsset: {
			params: {
				publicUrl: { type: "string" },
			},
			async handler(ctx) {
				const publicUrl = String(ctx.params.publicUrl || "").trim();
				let assetPath = String(ctx.params.assetPath || ctx.params["*"] || "").replace(/^\/+/, "");
				let tileToken = String(ctx.params.tile_token || ctx.params.tileToken || "").trim();
				const pathTokenMatch = assetPath.match(/^source_files\/__token__\/([^/]+)\/(.+)$/);
				if (pathTokenMatch) {
					tileToken = decodeURIComponent(pathTokenMatch[1]);
					assetPath = `source_files/${pathTokenMatch[2]}`;
				}
				if (!isUuid(publicUrl) || !assetPath) {
					throw new MoleculerErrors.ValidationError(
						"Tile asset path is required",
						"INVALID_TILE_ASSET_PATH"
					);
				}

				const tokenPayload = tileToken ? this.verifyTileToken(tileToken) : null;
				if (tokenPayload && tokenPayload.u === publicUrl) {
					const objectName =
						assetPath === "source.dzi"
							? tokenPayload.d
							: assetPath.startsWith("source_files/")
								? `${tokenPayload.p}${assetPath.slice("source_files/".length)}`
								: null;
					if (!objectName) {
						throw new MoleculerErrors.MoleculerClientError(
							"Tile asset path is invalid",
							400,
							"INVALID_TILE_ASSET_PATH"
						);
					}

					if (assetPath === "source.dzi") {
						const dziBuffer = (await this.client.getObject(
							tokenPayload.b,
							objectName
						)) as Buffer;
						const dziXml = this.injectDziTileUrl(
							dziBuffer.toString("utf8"),
							this.getTileAssetUrl(
								publicUrl,
								`source_files/__token__/${encodeURIComponent(tileToken)}/`
							)
						);
						ctx.meta.$responseHeaders = {
							"Content-Type": "application/xml",
							"Cache-Control": "private, max-age=300, immutable",
						};
						ctx.meta.$responseType = "application/xml";
						return Buffer.from(dziXml, "utf8");
					}

					const resolved = await this.getTileObjectWithFallback(tokenPayload.b, objectName);
					const contentType = this.getTileAssetContentType(assetPath, resolved.objectName);
					ctx.meta.$responseHeaders = {
						"Content-Type": contentType,
						"Cache-Control": "private, max-age=86400, immutable",
					};
					ctx.meta.$responseType = contentType;
					return resolved.data;
				}

				const node = await this.getCachedTileNodeByPublicUrl(publicUrl);
				const access = (await this.getCachedTileAccess(
					ctx,
					node.node_id,
					publicUrl
				)) as VfsAccessResult;
				if (!access?.allowed) {
					throw new MoleculerErrors.MoleculerClientError(
						"Access denied for tile read",
						403,
						"FORBIDDEN"
					);
				}

				const record = await this.getResolvedTileRecord(node, publicUrl);
				if (!record) {
					throw new MoleculerErrors.MoleculerClientError(
						"Tile asset not found",
						404,
						"TILE_ASSET_NOT_FOUND"
					);
				}

				const sessionUrls = this.buildTileSessionUrls(publicUrl, record);
				const tilesBucket = record.bucket_name || this.getTilesBucketByVisibility(access.effectiveVisibility);
				const objectName = this.resolveTileObjectName(assetPath, record);

				if (assetPath === "source.dzi") {
					const dziBuffer = (await this.client.getObject(tilesBucket, objectName)) as Buffer;
					const dziXml = this.injectDziTileUrl(dziBuffer.toString("utf8"), sessionUrls.tileUrl);
					ctx.meta.$responseHeaders = {
						"Content-Type": "application/xml",
						"Cache-Control": "private, max-age=300, immutable",
					};
					ctx.meta.$responseType = "application/xml";
					return Buffer.from(dziXml, "utf8");
				}

				const resolved = await this.getTileObjectWithFallback(tilesBucket, objectName);
				const contentType = this.getTileAssetContentType(assetPath, resolved.objectName);
				ctx.meta.$responseHeaders = {
					"Content-Type": contentType,
					"Cache-Control": "private, max-age=86400, immutable",
				};
				ctx.meta.$responseType = contentType;
				return resolved.data;
			},
		},

		upload: {
			rest: {
				method: "POST",
				fullPath: "/api/uploads",
			},
			handler(ctx) {
				return this.storeUploadedFiles(ctx, ctx.params.files || []);
			},
		},
		requestUpload: {
			rest: {
				method: "POST",
				fullPath: "/api/storage/upload/request",
			},
			async handler(ctx) {
				const userSub = String(ctx.meta?.user?.sub || "").trim();
				const originalName = String(ctx.params.name || "").trim();
				const contentType = String(ctx.params.contentType || ctx.params.type || "").trim();
				const rawParentId = ctx.params.parent_id ?? ctx.params.parentId ?? null;
				const parentId =
					rawParentId == null || rawParentId === ""
						? null
						: Number(rawParentId);
				const expiry = Math.max(
					60,
					Math.min(
						Number(ctx.params.expiry || config.presignedUrls.expiry || 3600),
						config.presignedUrls.maxExpiry || 86400
					)
				);

				if (!userSub) {
					throw new MoleculerErrors.MoleculerClientError(
						"Session is required",
						401,
						"UNAUTHORIZED"
					);
				}

				if (!originalName) {
					throw new MoleculerErrors.ValidationError(
						"name is required",
						"INVALID_UPLOAD_NAME"
					);
				}
				if (parentId != null && (!Number.isInteger(parentId) || parentId <= 0)) {
					throw new MoleculerErrors.ValidationError(
						"parent_id is invalid",
						"INVALID_PARENT_ID"
					);
				}
				const normalizedSize = Number.isFinite(Number(ctx.params.size))
					? Math.max(0, Number(ctx.params.size))
					: null;
				const duplicateJob = await this.db("storage.upload_job")
					.select("*")
					.where({
						owner_sub: userSub,
						parent_id: parentId,
						requested_name: originalName,
					})
					.whereIn("status", ["requested", "uploading", "finalizing"])
					.modify(query => {
						if (normalizedSize == null) {
							query.whereNull("size_bytes");
							return;
						}
						query.where({ size_bytes: normalizedSize });
					})
					.orderBy("created_at", "desc")
					.first();
				if (duplicateJob) {
					throw new MoleculerErrors.MoleculerClientError(
						"Upload already in progress",
						409,
						"DUPLICATE_UPLOAD_IN_PROGRESS",
						{
							uploadId: String(duplicateJob.upload_id),
						}
					);
				}

				const bucketName = this.getPrimaryBucket();
				const objectName = this.buildDirectUploadObjectName(userSub, originalName);
				const uploadId = randomUUID();
				const createdAt = new Date().toISOString();
				const uploadUrl = await this.client.presignedPutObject(
					bucketName,
					objectName,
					expiry,
					contentType || undefined
				);
				await this.db("storage.upload_job").insert({
					upload_id: uploadId,
					owner_sub: userSub,
					parent_id: parentId,
					original_name: originalName,
					requested_name: originalName,
					content_type: contentType || null,
					size_bytes: normalizedSize,
					bucket_name: bucketName,
					object_name: objectName,
					storage_ref: formatMinioStorageRef(bucketName, objectName),
					method: "PUT",
					status: "requested",
					progress: 0,
					loaded_bytes: 0,
					total_bytes: normalizedSize,
					error_text: null,
					heartbeat_at: createdAt,
					created_at: createdAt,
					updated_at: createdAt,
				});

					return {
						uploadId,
						method: "PUT",
						bucketName,
						objectName,
						storageRef: formatMinioStorageRef(bucketName, objectName),
						uploadUrl,
						expiresIn: expiry,
						headers: contentType ? { "Content-Type": contentType } : {},
						contentType: contentType || "application/octet-stream",
					createdAt,
				};
			},
		},
		uploadJobs: {
			rest: {
				method: "GET",
				fullPath: "/api/storage/upload/jobs",
			},
			async handler(ctx) {
				const userSub = String(ctx.meta?.user?.sub || "").trim();
				const rawParentId = ctx.params.parent_id ?? ctx.params.parentId ?? null;
				const parentId =
					rawParentId == null || rawParentId === ""
						? null
						: Number(rawParentId);
				const activeOnlyRaw = ctx.params.activeOnly;
				const activeOnly =
					activeOnlyRaw == null || activeOnlyRaw === ""
						? true
						: this.parseBooleanField(activeOnlyRaw);

				if (!userSub) {
					throw new MoleculerErrors.MoleculerClientError(
						"Session is required",
						401,
						"UNAUTHORIZED"
					);
				}

				if (parentId != null && (!Number.isInteger(parentId) || parentId <= 0)) {
					throw new MoleculerErrors.ValidationError(
						"parent_id is invalid",
						"INVALID_PARENT_ID"
					);
				}

				void this.markStaleUploadJobs(userSub).catch(error => {
					this.logger.warn("UPLOAD_JOBS_STALE_MARK_FAILED", {
						userSub,
						error: error instanceof Error ? error.message : String(error),
					});
				});

				const query = this.db("storage.upload_job")
					.leftJoin("storage.nodes as parent_node", "parent_node.node_id", "storage.upload_job.parent_id")
					.select("storage.upload_job.*", this.db.raw("parent_node.name as parent_name"))
					.where({ owner_sub: userSub })
					.orderBy([
						{ column: "created_at", order: "asc" },
						{ column: "upload_id", order: "asc" },
					]);

				if (parentId != null) {
					query.andWhere({ parent_id: parentId });
				}
				if (activeOnly) {
					query.whereIn("status", ["requested", "uploading", "finalizing"]);
				}

				const rows = await query.limit(100);
				return {
					jobs: rows.map(row => this.serializeUploadJob(row)),
				};
			},
		},
		uploadProgress: {
			rest: {
				method: "POST",
				fullPath: "/api/storage/upload/progress",
			},
			async handler(ctx) {
				const userSub = String(ctx.meta?.user?.sub || "").trim();
				const uploadId = String(ctx.params.uploadId || ctx.params.upload_id || "").trim();
				const status = String(ctx.params.status || "uploading").trim() || "uploading";
				const loadedBytes = Number(ctx.params.loadedBytes ?? ctx.params.loaded_bytes ?? 0);
				const totalBytesRaw = ctx.params.totalBytes ?? ctx.params.total_bytes ?? null;
				const totalBytes =
					totalBytesRaw == null || totalBytesRaw === ""
						? null
						: Number(totalBytesRaw);
				const explicitProgress = Number(ctx.params.progress);
				const progress = Number.isFinite(explicitProgress)
					? Math.max(0, Math.min(100, Math.round(explicitProgress)))
					: Number.isFinite(loadedBytes) && Number.isFinite(totalBytes) && totalBytes && totalBytes > 0
						? Math.max(0, Math.min(100, Math.round((loadedBytes / totalBytes) * 100)))
						: null;

				if (!userSub) {
					throw new MoleculerErrors.MoleculerClientError(
						"Session is required",
						401,
						"UNAUTHORIZED"
					);
				}
				if (!uploadId) {
					throw new MoleculerErrors.ValidationError(
						"uploadId is required",
						"INVALID_UPLOAD_ID"
					);
				}

				const job = await this.getUploadJobForOwner(uploadId, userSub);
				if (!job) {
					throw new MoleculerErrors.MoleculerClientError(
						"Upload job not found",
						404,
						"UPLOAD_JOB_NOT_FOUND"
					);
				}

				await this.touchUploadJob(uploadId, {
					status,
					progress: progress ?? Number(job.progress || 0),
					loaded_bytes: Number.isFinite(loadedBytes) ? Math.max(0, loadedBytes) : Number(job.loaded_bytes || 0),
					total_bytes:
						Number.isFinite(totalBytes) && totalBytes != null
							? Math.max(0, totalBytes)
							: job.total_bytes ?? null,
					error_text: null,
					started_at:
						status === "uploading" && !job.started_at ? this.db.fn.now() : job.started_at ?? null,
				});

				return {
					job: this.serializeUploadJob(await this.getUploadJobForOwner(uploadId, userSub)),
				};
			},
		},
		abortUpload: {
			rest: {
				method: "POST",
				fullPath: "/api/storage/upload/abort",
			},
			async handler(ctx) {
				const userSub = String(ctx.meta?.user?.sub || "").trim();
				const uploadId = String(ctx.params.uploadId || ctx.params.upload_id || "").trim();
				const reason = String(ctx.params.reason || "Upload aborted").trim() || "Upload aborted";

				if (!userSub) {
					throw new MoleculerErrors.MoleculerClientError(
						"Session is required",
						401,
						"UNAUTHORIZED"
					);
				}
				if (!uploadId) {
					throw new MoleculerErrors.ValidationError(
						"uploadId is required",
						"INVALID_UPLOAD_ID"
					);
				}

				const job = await this.getUploadJobForOwner(uploadId, userSub);
				if (!job) {
					return { job: null };
				}

				await this.client.removeObject(String(job.bucket_name || ""), String(job.object_name || "")).catch(() => null);
				await this.db("storage.upload_job").where({ upload_id: uploadId }).delete();

				return {
					job: null,
				};
			},
		},
		completeUpload: {
			rest: {
				method: "POST",
				fullPath: "/api/storage/upload/complete",
			},
			async handler(ctx) {
				const userSub = String(ctx.meta?.user?.sub || "").trim();
				const uploadId = String(ctx.params.uploadId || ctx.params.upload_id || "").trim();
				const uploadJob =
					userSub && uploadId ? await this.getUploadJobForOwner(uploadId, userSub) : null;
				const storageRef = String(ctx.params.storageRef || uploadJob?.storage_ref || "").trim();
				const requestedName = String(ctx.params.name || "").trim();
				const shouldSlice = this.parseBooleanField(ctx.params.slice);
				const forceSlice = this.parseBooleanField(ctx.params.force);
				const rawParentId = ctx.params.parent_id ?? ctx.params.parentId ?? uploadJob?.parent_id ?? null;
				const parentId =
					rawParentId == null || rawParentId === ""
						? null
						: Number(rawParentId);

				if (!storageRef) {
					throw new MoleculerErrors.ValidationError(
						"storageRef is required",
						"INVALID_STORAGE_REF"
					);
				}

				if (parentId != null && (!Number.isInteger(parentId) || parentId <= 0)) {
					throw new MoleculerErrors.ValidationError(
						"parent_id is invalid",
						"INVALID_PARENT_ID"
					);
				}

				const parsedRef = this.parseMinioRef(storageRef);
				this.assertDirectUploadOwnership(ctx, parsedRef.objectName);
				if (uploadId && !uploadJob) {
					throw new MoleculerErrors.MoleculerClientError(
						"Upload job not found",
						404,
						"UPLOAD_JOB_NOT_FOUND"
					);
				}
				if (uploadId && uploadJob && String(uploadJob.storage_ref || "") !== storageRef) {
					throw new MoleculerErrors.ValidationError(
						"storageRef does not match upload job",
						"UPLOAD_JOB_REF_MISMATCH"
					);
				}

				const objectExists = await this.client.objectExists(
					parsedRef.bucketName,
					parsedRef.objectName
				);

				if (!objectExists) {
					throw new MoleculerErrors.MoleculerClientError(
						"Uploaded object not found",
						404,
						"UPLOAD_NOT_FOUND"
					);
				}

				if (uploadId) {
					await this.touchUploadJob(uploadId, {
						status: "finalizing",
						progress: 100,
						loaded_bytes: uploadJob?.total_bytes ?? uploadJob?.loaded_bytes ?? 0,
						total_bytes: uploadJob?.total_bytes ?? null,
						error_text: null,
					});
				}

				let upload: any = await ctx.call("minio.resolveFileRef", {
					ref: storageRef,
					name:
						requestedName ||
						String(uploadJob?.requested_name || "").trim() ||
						path.basename(parsedRef.objectName),
				});

				let node = null;
				let tileInfo = null;

				try {
					if (parentId != null) {
						node = await ctx.call("vfs.vsCreateFile", {
							file: {
								parent_id: parentId,
								name:
									requestedName ||
									String(uploadJob?.requested_name || "").trim() ||
									path.basename(parsedRef.objectName),
								hash: storageRef,
							},
						});
						const finalStorageRef = await this.promoteFileRefToManagedStorage(
							node.node_id,
							node.name,
							storageRef
						);
						upload = {
							...upload,
							storageRef: finalStorageRef,
							ref: finalStorageRef,
							bucketName: this.getPrimaryBucket(),
							objectName: this.parseMinioRef(finalStorageRef).objectName,
						};
						node = {
							...node,
							hash: finalStorageRef,
						};
					}

					if (shouldSlice) {
						if (!node?.node_id) {
							throw new MoleculerErrors.ValidationError(
								"Cannot slice upload without parent_id",
								"INVALID_SLICE_REQUEST"
							);
						}
						tileInfo = await ctx.call("minio.slice", {
							nodeId: node.node_id,
							force: forceSlice,
						});
					}

					if (uploadId) {
						await this.db("storage.upload_job").where({ upload_id: uploadId }).delete();
					}

					return {
						upload,
						node,
						tileInfo,
					};
				} catch (error) {
					if (node?.node_id) {
						await ctx.call("vfs.vfsDeleteNode", { node_id: [node.node_id] }).catch(() => null);
					} else {
						await ctx.call("minio.deleteByRef", { ref: storageRef }).catch(() => null);
					}
					if (uploadId) {
						await this.touchUploadJob(uploadId, {
							status: "error",
							error_text: error instanceof Error ? error.message : "Upload finalize failed",
							finished_at: this.db.fn.now(),
						}).catch(() => null);
					}
					throw error;
				}
			},
		},
		ingest: {
			rest: {
				method: "POST",
				fullPath: "/api/storage/ingest",
			},
			async handler(ctx) {
				const files = ctx.params.files || [];
				const fields = ctx.params.fields || {};

				if (files.length !== 1) {
					throw new MoleculerErrors.ValidationError(
						"Exactly one file is required",
						"INVALID_UPLOAD_COUNT"
					);
				}

				const parentId = Number(fields.parent_id);
				if (!Number.isInteger(parentId) || parentId <= 0) {
					throw new MoleculerErrors.ValidationError("parent_id is required", "INVALID_PARENT_ID");
				}

				const requestedName = String(fields.name || "").trim();
				const shouldSlice = this.parseBooleanField(fields.slice);
				const forceSlice = this.parseBooleanField(fields.force);

				let uploaded = null;
				let node = null;

				try {
					[uploaded] = await this.storeUploadedFiles(ctx, files);

					node = await ctx.call("vfs.vsCreateFile", {
						file: {
							parent_id: parentId,
							name: requestedName || files[0].originalname || uploaded.objectName.split("/").pop(),
							hash: uploaded.storageRef,
						},
					});
					const finalStorageRef = await this.promoteFileRefToManagedStorage(
						node.node_id,
						node.name,
						uploaded.storageRef
					);
					uploaded = {
						...uploaded,
						bucketName: this.getPrimaryBucket(),
						objectName: this.parseMinioRef(finalStorageRef).objectName,
						storageRef: finalStorageRef,
					};
					node = {
						...node,
						hash: finalStorageRef,
					};

					let tileInfo = null;
					if (shouldSlice) {
						tileInfo = await ctx.call("minio.slice", {
							nodeId: node.node_id,
							force: forceSlice,
						});
					}

					return {
						node,
						upload: uploaded,
						tileInfo,
					};
				} catch (error) {
					if (node?.node_id) {
						await ctx.call("vfs.vfsDeleteNode", { node_id: [node.node_id] }).catch(() => null);
					} else if (uploaded?.storageRef) {
						await ctx.call("minio.deleteByRef", { ref: uploaded.storageRef }).catch(() => null);
					}
					throw error;
				}
			},
		},

		/**
		 * Проверка соединения с сервером
		 * @returns {Promise<boolean>} - true если соединение успешно
		 */
		checkConnection: {
			cache: false,
			handler(ctx) {
				return this.client.checkConnection();
			},
		},

		/**
		 * Создание нового бакета
		 * @param {Object} params - Параметры
		 * @param {string} params.bucketName - Имя бакета
		 * @param {string} params.region - Регион (опционально)
		 * @param {boolean} params.objectLock - Включение блокировки объектов (опционально)
		 * @returns {Promise<boolean>} - true если успешно
		 */
		createBucket: {
			graphql: {
				mutation: "minioCreateBucket(bucketName:String!):JSON",
			},
			params: {
				bucketName: "string",
				region: { type: "string", optional: true, default: config.minio.region },
				objectLock: { type: "boolean", optional: true, default: false },
			},
			handler(ctx) {
				const { bucketName, region, objectLock } = ctx.params;
				return this.client.createBucket(bucketName, region, objectLock);
			},
		},

		/**
		 * Удаление бакета
		 * @param {Object} params - Параметры
		 * @param {string} params.bucketName - Имя бакета
		 * @returns {Promise<boolean>} - true если успешно
		 */
		removeBucket: {
			params: {
				bucketName: "string",
			},
			handler(ctx) {
				const { bucketName } = ctx.params;
				return this.client.removeBucket(bucketName);
			},
		},

		/**
		 * Проверка существования бакета
		 * @param {Object} params - Параметры
		 * @param {string} params.bucketName - Имя бакета
		 * @returns {Promise<boolean>} - true если существует
		 */
		bucketExists: {
			cache: {
				keys: ["bucketName"],
				ttl: config.minio.cache.ttl,
			},
			params: {
				bucketName: "string",
			},
			handler(ctx) {
				const { bucketName } = ctx.params;
				return this.client.bucketExists(bucketName);
			},
		},

		/**
		 * Получение списка всех бакетов
		 * @returns {Promise<Array>} - Массив бакетов
		 */
		listBuckets: {
			graphql: {
				query: "minioListBuckets:JSON",
			},
			cache: {
				ttl: config.minio.cache.ttl,
			},
			handler(ctx) {
				return this.client.listBuckets();
			},
		},

		/**
		 * Загрузка файла в бакет
		 * @param {Object} params - Параметры
		 * @param {string} params.bucketName - Имя бакета
		 * @param {string} params.objectName - Имя объекта (путь в бакете)
		 * @param {Buffer} params.data - Данные файла (буфер)
		 * @param {string} params.contentType - MIME тип файла (опционально)
		 * @param {Object} params.metadata - Метаданные файла (опционально)
		 * @returns {Promise<Object>} - Информация о загруженном файле
		 */
		putObject: {
			params: {
				bucketName: "string",
				objectName: "string",
				fullPath: "string",
				metadata: { type: "object", optional: true, default: {} },
			},
			handler(ctx) {
				const { bucketName, objectName, data, contentType, metadata } = ctx.params;
				return this.client.putObject(bucketName, objectName, data, contentType, metadata);
			},
		},

		/**
		 * Получение файла из бакета
		 * @param {Object} params - Параметры
		 * @param {string} params.bucketName - Имя бакета
		 * @param {string} params.objectName - Имя объекта
		 * @returns {Promise<Buffer>} - Буфер с данными файла
		 */
		getObject: {
			cache: {
				keys: ["bucketName", "objectName"],
				ttl: config.minio.cache.ttl,
			},
			params: {
				bucketName: "string",
				objectName: "string",
			},
			handler(ctx) {
				const { bucketName, objectName } = ctx.params;
				return this.client.getObject(bucketName, objectName);
			},
		},

		/**
		 * Удаление файла из бакета
		 * @param {Object} params - Параметры
		 * @param {string} params.bucketName - Имя бакета
		 * @param {string} params.objectName - Имя объекта
		 * @returns {Promise<boolean>} - true если успешно
		 */
		removeObject: {
			params: {
				bucketName: "string",
				objectName: "string",
			},
			handler(ctx) {
				const { bucketName, objectName } = ctx.params;
				return this.client.removeObject(bucketName, objectName);
			},
		},

		/**
		 * Проверка существования объекта
		 * @param {Object} params - Параметры
		 * @param {string} params.bucketName - Имя бакета
		 * @param {string} params.objectName - Имя объекта
		 * @returns {Promise<boolean>} - true если существует
		 */
		objectExists: {
			cache: {
				keys: ["bucketName", "objectName"],
				ttl: config.minio.cache.ttl,
			},
			params: {
				bucketName: "string",
				objectName: "string",
			},
			handler(ctx) {
				const { bucketName, objectName } = ctx.params;
				return this.client.objectExists(bucketName, objectName);
			},
		},

		/**
		 * Получение информации о объекте
		 * @param {Object} params - Параметры
		 * @param {string} params.bucketName - Имя бакета
		 * @param {string} params.objectName - Имя объекта
		 * @returns {Promise<Object>} - Метаданные объекта
		 */
		statObject: {
			cache: {
				keys: ["bucketName", "objectName"],
				ttl: config.minio.cache.ttl,
			},
			params: {
				bucketName: "string",
				objectName: "string",
			},
			handler(ctx) {
				const { bucketName, objectName } = ctx.params;
				return this.client.statObject(bucketName, objectName);
			},
		},

		/**
		 * Получение списка объектов в бакете
		 * @param {Object} params - Параметры
		 * @param {string} params.bucketName - Имя бакета
		 * @param {string} params.prefix - Префикс для фильтрации (опционально)
		 * @param {boolean} params.recursive - Рекурсивный поиск (опционально)
		 * @returns {Promise<Array>} - Массив объектов
		 */
		listObjects: {
			graphql: {
				query: "minioListObjects(bucketName:String!,prefix:String,recursive:Boolean):JSON",
			},
			cache: {
				keys: ["bucketName", "prefix", "recursive"],
				ttl: config.minio.cache.ttl,
			},
			params: {
				bucketName: "string",
				prefix: { type: "string", optional: true, default: "" },
				recursive: { type: "boolean", optional: true, default: false },
			},
			handler(ctx) {
				const { bucketName, prefix, recursive } = ctx.params;
				return this.client.listObjects(bucketName, prefix, recursive);
			},
		},

		/**
		 * Генерация пресигнед урла для скачивания
		 * @param {Object} params - Параметры
		 * @param {string} params.bucketName - Имя бакета
		 * @param {string} params.objectName - Имя объекта
		 * @param {number} params.expiry - Время жизни в секундах (опционально, макс 7 дней)
		 * @returns {Promise<string>} - URL для скачивания
		 */
		presignedGetObject: {
			graphql: {
				query: "minioPresignedGetObject(bucketName:String!,objectName:String!):JSON",
			},
			params: {
				bucketName: "string",
				objectName: "string",
				expiry: {
					type: "number",
					optional: true,
					default: config.presignedUrls.expiry,
					min: 1,
					max: config.presignedUrls.maxExpiry,
				},
			},
			handler(ctx) {
				const { bucketName, objectName, expiry } = ctx.params;
				return this.client.presignedGetObject(bucketName, objectName, expiry);
			},
		},

		/**
		 * Генерация пресигнед урла для загрузки
		 * @param {Object} params - Параметры
		 * @param {string} params.bucketName - Имя бакета
		 * @param {string} params.objectName - Имя объекта
		 * @param {number} params.expiry - Время жизни в секундах (опционально)
		 * @param {string} params.contentType - MIME тип (опционально)
		 * @returns {Promise<string>} - URL для загрузки
		 */
		presignedPutObject: {
			params: {
				bucketName: "string",
				objectName: "string",
				expiry: {
					type: "number",
					optional: true,
					default: config.presignedUrls.expiry,
					min: 1,
					max: config.presignedUrls.maxExpiry,
				},
				contentType: { type: "string", optional: true },
			},
			handler(ctx) {
				const { bucketName, objectName, expiry, contentType } = ctx.params;
				return this.client.presignedPutObject(bucketName, objectName, expiry, contentType);
			},
		},

		/**
		 * Копирование объекта
		 * @param {Object} params - Параметры
		 * @param {string} params.sourceBucket - Исходный бакет
		 * @param {string} params.sourceObject - Исходный объект
		 * @param {string} params.destBucket - Целевой бакет
		 * @param {string} params.destObject - Целевой объект
		 * @returns {Promise<boolean>} - true если успешно
		 */
		copyObject: {
			params: {
				sourceBucket: "string",
				sourceObject: "string",
				destBucket: "string",
				destObject: "string",
			},
			handler(ctx) {
				const { sourceBucket, sourceObject, destBucket, destObject } = ctx.params;
				return this.client.copyObject(sourceBucket, sourceObject, destBucket, destObject);
			},
		},

		/**
		 * Получение публичного URL объекта
		 * @param {Object} params - Параметры
		 * @param {string} params.bucketName - Имя бакета
		 * @param {string} params.objectName - Имя объекта
		 * @returns {Promise<string>} - Публичный URL
		 */
		getPublicUrl: {
			graphql: {
				query: "minuiGetPublicUrl(bucketName:String!,objectName:String!):JSON",
			},
			params: {
				bucketName: "string",
				objectName: "string",
			},
			handler(ctx) {
				const { bucketName, objectName } = ctx.params;
				return this.client.getPublicUrl(bucketName, objectName);
			},
		},
		getByRef: {
			params: {
				ref: "string",
				download: { type: "boolean", optional: true },
				name: { type: "string", optional: true },
			},
			handler(ctx) {
				return this.streamFileByRef(
					ctx,
					ctx.params.ref,
					Boolean(ctx.params.download),
					ctx.params.name
				);
			},
		},
		getByPublicUrl: {
			params: {
				publicUrl: { type: "string" },
				download: { type: "string", optional: true },
			},
			async handler(ctx) {
				const publicUrl = String(ctx.params.publicUrl || "").trim();
				if (!isUuid(publicUrl)) {
					throw new MoleculerErrors.ValidationError(
						"Invalid public url",
						"INVALID_PUBLIC_URL"
					);
				}
				const downloadFlag =
					ctx.params.download === "1" ||
					ctx.params.download === "true" ||
					ctx.params.download === "yes";
				const node = await this.getVfsFileNodeByPublicUrl(publicUrl);
				return this.streamFileByRef(ctx, node.hash, downloadFlag, node.name);
			},
		},
		getPreviewByPublicUrl: {
			params: {
				publicUrl: { type: "string" },
				size: { type: "string", optional: true },
			},
			async handler(ctx) {
				const publicUrl = String(ctx.params.publicUrl || "").trim();
				if (!isUuid(publicUrl)) {
					throw new MoleculerErrors.ValidationError(
						"Invalid public url",
						"INVALID_PUBLIC_URL"
					);
				}

				const requestedSize = this.normalizePreviewSize(ctx.params.size);
				const node = await this.getVfsFileNodeByPublicUrl(publicUrl);
				const access = (await ctx.call("vfs.resolveAccess", {
					node_id: node.node_id,
					permission: "read",
				})) as VfsAccessResult;
				if (!access?.allowed) {
					throw new MoleculerErrors.MoleculerClientError(
						"Access denied for preview read",
						403,
						"FORBIDDEN"
					);
				}

				const record = await this.getBestPreviewRecordByNodeId(node.node_id, requestedSize);
				if (!record) {
					throw new MoleculerErrors.MoleculerClientError(
						"Preview not found",
						404,
						"PREVIEW_NOT_FOUND"
					);
				}

				const exists = await this.client
					.objectExists(record.bucket_name, record.object_name)
					.catch(() => false);
				if (!exists) {
					await this.removePreviewRecord(node.node_id, Number(record.size));
					throw new MoleculerErrors.MoleculerClientError(
						"Preview object not found",
						404,
						"PREVIEW_NOT_FOUND"
					);
				}

				const data = await this.client.getObject(record.bucket_name, record.object_name);
				const fileName = `${path.parse(node.name).name || "preview"}-preview-${record.size}.jpg`;
				const encodedName = encodeURIComponent(fileName);
				ctx.meta.$responseHeaders = {
					"Content-Type": record.mime || "image/jpeg",
					"Content-Disposition": `inline; filename=${encodedName}; filename*=UTF-8''${encodedName}`,
				};
				ctx.meta.$responseType = record.mime || "image/jpeg";
				return data;
			},
		},
		createPreviewByNodeId: {
			visibility: "protected",
			params: {
				nodeId: "number",
				size: { type: "number", integer: true, positive: true, optional: true },
				force: { type: "boolean", optional: true },
			},
			async handler(ctx) {
				return this.createPreviewByNodeId(ctx, ctx.params.nodeId, {
					size: ctx.params.size,
					force: Boolean(ctx.params.force),
				});
			},
		},
		deletePreviewsByNodeIds: {
			visibility: "protected",
			params: {
				nodeIds: { type: "array", items: "number" },
			},
			async handler(ctx) {
				return this.deletePreviewsByNodeIds(ctx.params.nodeIds);
			},
		},
		resolveFileRef: {
			visibility: "protected",
			params: {
				ref: "string",
				name: { type: "string", optional: true },
			},
			async handler(ctx) {
				const ref = this.parseMinioRef(ctx.params.ref);
				const stat = await this.client.statObject(ref.bucketName, ref.objectName);
				const fileName =
					ctx.params.name ||
					(await this.getVfsFileName(ref.raw)) ||
					this.decodeOriginalName(stat.metadata) ||
					stat.metadata?.originalname ||
					stat.metadata?.["x-amz-meta-originalname"] ||
					path.basename(ref.objectName);
				const dirName = path.posix.dirname(ref.objectName);

				return {
					hash: ref.raw,
					storageRef: ref.raw,
					bucketName: ref.bucketName,
					objectName: ref.objectName,
					path: dirName === "." ? ref.bucketName : `${ref.bucketName}/${dirName}`,
					name: fileName,
					mime: stat.contentType || "application/octet-stream",
					size: stat.size,
					created: stat.lastModified?.toISOString?.() || new Date().toISOString(),
				};
			},
		},
		objectExistsByRef: {
			visibility: "protected",
			params: {
				ref: "string",
			},
			handler(ctx) {
				const ref = this.parseMinioRef(ctx.params.ref);
				return this.client.objectExists(ref.bucketName, ref.objectName);
			},
		},
		deleteByRef: {
			visibility: "protected",
			params: {
				ref: "string",
			},
			async handler(ctx) {
				const ref = this.parseMinioRef(ctx.params.ref);
				await this.client.removeObject(ref.bucketName, ref.objectName);
				return {
					ref: ref.raw,
					bucketName: ref.bucketName,
					objectName: ref.objectName,
					storageRef: formatMinioStorageRef(ref.bucketName, ref.objectName),
				};
			},
		},
	},

	/**
	 * Методы сервиса
	 */
		methods: {
		resolveTileObjectName(assetPath: string, record: { dzi_object_name: string; tile_prefix: string }) {
			const normalizedPath = String(assetPath || "").replace(/^\/+/, "");
			if (normalizedPath === "source.dzi") {
				return record.dzi_object_name;
			}
			if (normalizedPath.startsWith("source_files/")) {
				return `${record.tile_prefix}${normalizedPath.slice("source_files/".length)}`;
			}
			return normalizedPath;
		},
		parseMinioRef(ref: string) {
			const parsed = parseStorageRef(ref);
			if (!parsed || parsed.kind !== "minio") {
				throw new MoleculerErrors.ValidationError("Invalid MinIO storage ref", "INVALID_REF");
			}
			return parsed;
		},
		getRequestHeaderValue(ctx: any, name: string) {
			const headers = ctx?.meta?.$headers || ctx?.meta?.$request?.headers || {};
			const raw = headers?.[name];
			if (Array.isArray(raw)) {
				return String(raw[0] || "").trim();
			}
			return String(raw || "").trim();
		},
		rewriteUploadUrlForRequest(ctx: any, url: string) {
			const forwardedProto = this.getRequestHeaderValue(ctx, "x-forwarded-proto")
				.split(",")[0]
				.trim()
				.toLowerCase();
			const forwardedHost = this.getRequestHeaderValue(ctx, "x-forwarded-host")
				.split(",")[0]
				.trim();
			const forwardedPort = this.getRequestHeaderValue(ctx, "x-forwarded-port")
				.split(",")[0]
				.trim();
			const host = (forwardedHost || this.getRequestHeaderValue(ctx, "host"))
				.split(",")[0]
				.trim();
			const hostHasExplicitPort = Boolean(host && host.includes(":"));

			if (!forwardedProto && !host) {
				return url;
			}

			const parsed = new URL(url);
			if (forwardedProto) {
				parsed.protocol = `${forwardedProto}:`;
			}

			if (host) {
				if (hostHasExplicitPort) {
					parsed.host = host;
				} else {
					parsed.hostname = host;
					if (forwardedPort) {
						parsed.port = forwardedPort;
					} else if (forwardedProto === "https" || forwardedProto === "http") {
						// If the external proxy doesn't pass X-Forwarded-Port, don't keep the
						// original MinIO port when we already trust the forwarded scheme/host.
						parsed.port = "";
					}
				}
			} else if (!forwardedPort && (forwardedProto === "https" || forwardedProto === "http")) {
				parsed.port = "";
			}

			if (
				(forwardedProto === "https" && parsed.port === "443") ||
				(forwardedProto === "http" && parsed.port === "80")
			) {
				parsed.port = "";
			}

			return parsed.toString();
		},
		getPrimaryBucket() {
			return this.settings.minio.bucket || config.minio.bucket;
		},
		isPublicBucket(bucketName: string) {
			return false;
		},
		getTilesBucketByVisibility(visibility: string) {
			return this.getPrimaryBucket();
		},
		getPreviewBucketByVisibility(visibility: string) {
			return this.getPrimaryBucket();
		},
		getTileAssetUrl(publicUrl: string, assetPath: string) {
			const apiBase = (process.env.APIS || "").replace(/\/$/, "");
			return `${apiBase}/tiles/vfs/${encodeURIComponent(publicUrl)}/${assetPath.replace(/^\/+/, "")}`;
		},
		getPreviewUrl(publicUrl: string, size: number) {
			const apiBase = (process.env.APIS || "").replace(/\/$/, "");
			return `${apiBase}/storage/preview/${encodeURIComponent(publicUrl)}?size=${encodeURIComponent(String(size))}`;
		},
		sanitizeManagedFileName(value: string) {
			return String(value || "")
				.trim()
				.replace(/[^\p{L}\p{N}._-]+/gu, "_")
				.replace(/^_+|_+$/g, "")
				.slice(0, 120);
		},
		buildManagedFileObjectName(nodeId: number, fileName: string) {
			const ext = path.extname(String(fileName || "")).toLowerCase().slice(0, 32);
			const baseName = path.basename(String(fileName || ""), ext);
			const safeBaseName = this.sanitizeManagedFileName(baseName) || "file";
			return `files/vfs/${nodeId}/${safeBaseName}-${randomUUID()}${ext}`;
		},
		async promoteFileRefToManagedStorage(nodeId: number, fileName: string, storageRef: string) {
			const parsedRef = this.parseMinioRef(storageRef);
			const targetBucket = this.getPrimaryBucket();
			const targetObjectName = this.buildManagedFileObjectName(nodeId, fileName);
			if (parsedRef.bucketName === targetBucket && parsedRef.objectName === targetObjectName) {
				return storageRef;
			}
			await this.client.copyObject(
				parsedRef.bucketName,
				parsedRef.objectName,
				targetBucket,
				targetObjectName
			);
			await this.client.removeObject(parsedRef.bucketName, parsedRef.objectName).catch(() => null);
			const nextRef = formatMinioStorageRef(targetBucket, targetObjectName);
			await this.db("storage.nodes")
				.where({ node_id: nodeId })
				.update({
					hash: nextRef,
					mtime: this.db.fn.now(),
				});
			return nextRef;
		},
		getPreviewObjectName(nodeId: number, size: number) {
			return `preview/vfs/${nodeId}/${size}.jpg`;
		},
		getUploadJobStaleMs() {
			return UPLOAD_JOB_STALE_SEC * 1000;
		},
		async ensureUploadJobSchema() {
			return;
		},
		normalizePreviewSize(value: unknown) {
			const parsed = Number(value);
			if (!Number.isFinite(parsed) || parsed <= 0) {
				return DEFAULT_PREVIEW_SIZE;
			}
			return Math.max(64, Math.min(4096, Math.round(parsed)));
		},
		isPreviewMimeSupported(mimeType?: string | null, fileName?: string | null) {
			const mimeValue = String(mimeType || "").toLowerCase();
			const ext = path.extname(String(fileName || "")).toLowerCase();
			if (mimeValue.startsWith("image/")) {
				return true;
			}
			return [".jpg", ".jpeg", ".png", ".webp", ".gif", ".tif", ".tiff", ".bmp", ".svg"].includes(ext);
		},
		async ensurePreviewSchema() {
			return;
		},
		async ensureTileDeleteSchema() {
			return;
		},
		getPreviewRecordByNodeIdSize(nodeId: number, size: number) {
			return this.db("storage.node_preview").where({ node_id: nodeId, size }).first();
		},
		async getBestPreviewRecordByNodeId(nodeId: number, requestedSize?: number | null) {
			const rows = await this.db("storage.node_preview")
				.select("*")
				.where({ node_id: nodeId })
				.orderBy("size", "asc");
			if (!rows.length) {
				return null;
			}
			if (!requestedSize) {
				return rows[rows.length - 1];
			}
			const exact = rows.find(row => Number(row.size) === requestedSize);
			if (exact) {
				return exact;
			}
			return rows.reduce((best, row) => {
				if (!best) {
					return row;
				}
				return Math.abs(Number(row.size) - requestedSize) < Math.abs(Number(best.size) - requestedSize)
					? row
					: best;
			}, null);
		},
		async upsertPreviewRecord({
			nodeId,
			size,
			sourceRef,
			bucketName,
			objectName,
			storageRef,
			mime: mimeType,
			width,
			height,
		}: {
			nodeId: number;
			size: number;
			sourceRef: string;
			bucketName: string;
			objectName: string;
			storageRef: string;
			mime: string;
			width?: number | null;
			height?: number | null;
		}) {
			const payload = {
				node_id: nodeId,
				size,
				source_ref: sourceRef,
				bucket_name: bucketName,
				object_name: objectName,
				storage_ref: storageRef,
				mime: mimeType,
				width: width ?? null,
				height: height ?? null,
				updated_at: this.db.fn.now(),
			};
			await this.db("storage.node_preview")
				.insert({
					...payload,
					created_at: this.db.fn.now(),
				})
				.onConflict(["node_id", "size"])
				.merge(payload);
			return this.getPreviewRecordByNodeIdSize(nodeId, size);
		},
		async getUploadJobForOwner(uploadId: string, ownerSub: string) {
			return this.db("storage.upload_job")
				.leftJoin("storage.nodes as parent_node", "parent_node.node_id", "storage.upload_job.parent_id")
				.select("storage.upload_job.*", this.db.raw("parent_node.name as parent_name"))
				.where({
					upload_id: uploadId,
					owner_sub: ownerSub,
				})
				.first();
		},
		async touchUploadJob(uploadId: string, patch: Record<string, unknown> = {}) {
			await this.db("storage.upload_job")
				.where({ upload_id: uploadId })
				.update({
					heartbeat_at: this.db.fn.now(),
					updated_at: this.db.fn.now(),
					...patch,
				});
		},
		async markStaleUploadJobs(ownerSub: string) {
			const staleBefore = new Date(Date.now() - this.getUploadJobStaleMs());
			const staleRows = await this.db("storage.upload_job")
				.select("*")
				.where({ owner_sub: ownerSub })
				.whereIn("status", ["requested", "uploading", "finalizing"])
				.andWhere(builder => {
					builder.where("heartbeat_at", "<", staleBefore).orWhere("updated_at", "<", staleBefore);
				});
			if (!staleRows.length) {
				return;
			}
			await Promise.all(
				staleRows.map(row =>
					this.client.removeObject(String(row.bucket_name || ""), String(row.object_name || "")).catch(() => null)
				)
			);
			await this.db("storage.upload_job")
				.where({ owner_sub: ownerSub })
				.whereIn("status", ["requested", "uploading", "finalizing"])
				.andWhere(builder => {
					builder.where("heartbeat_at", "<", staleBefore).orWhere("updated_at", "<", staleBefore);
				})
				.delete();
		},
		async cleanupActiveUploadJobsOnStart() {
			const activeRows = await this.db("storage.upload_job")
				.select("*")
				.whereIn("status", ["requested", "uploading", "finalizing"]);

			if (!activeRows.length) {
				return { cleanedCount: 0 };
			}

			this.logger.warn("UPLOAD_JOBS_STARTUP_CLEANUP", {
				count: activeRows.length,
			});

			await Promise.all(
				activeRows.map(row =>
					this.client
						.removeObject(String(row.bucket_name || ""), String(row.object_name || ""))
						.catch(() => null)
				)
			);

			await this.db("storage.upload_job")
				.whereIn("status", ["requested", "uploading", "finalizing"])
				.delete();

			this.logger.info("UPLOAD_JOBS_STARTUP_CLEANUP_DONE", {
				cleanedCount: activeRows.length,
			});

			return { cleanedCount: activeRows.length };
		},
		serializeUploadJob(row) {
			if (!row) {
				return null;
			}
			return {
				uploadId: String(row.upload_id),
				parentId: row.parent_id == null ? null : Number(row.parent_id),
				parentName: row.parent_name || null,
				name: String(row.requested_name || row.original_name || ""),
				originalName: String(row.original_name || ""),
				contentType: row.content_type || null,
				sizeBytes: row.size_bytes == null ? null : Number(row.size_bytes),
				storageRef: String(row.storage_ref || ""),
				status: String(row.status || "requested"),
				progress: Number(row.progress || 0),
				loadedBytes: Number(row.loaded_bytes || 0),
				totalBytes: row.total_bytes == null ? null : Number(row.total_bytes),
				error: row.error_text || null,
				createdAt: row.created_at || null,
				startedAt: row.started_at || null,
				finishedAt: row.finished_at || null,
				heartbeatAt: row.heartbeat_at || null,
			};
		},
		async removePreviewRecord(nodeId: number, size: number) {
			await this.db("storage.node_preview").where({ node_id: nodeId, size }).delete();
		},
		getTileDeleteWorkerStaleMs() {
			return TILE_DELETE_WORKER_STALE_MIN * 60 * 1000;
		},
		getTileDeleteWorkerStartGraceMs() {
			return TILE_DELETE_WORKER_START_GRACE_MS;
		},
		getTileDeleteWorkerRawLogPath(workerId: string) {
			const logFolder = path.resolve(String(process.env.LOG_FILE_FOLDER || "./logs"));
			const date = new Date().toISOString().slice(0, 10);
			return path.join(logFolder, `tile-delete-worker-raw-${date}-${workerId.slice(0, 8)}.log`);
		},
		buildTileDeleteWorkerCommand() {
			const cwd = process.cwd();
			const distWorker = path.resolve(cwd, "dist/services/core/sys/minio.tile-delete.worker.js");
			const runBuiltWorkers =
				String(process.env.NODE_ENV || "").trim() === "production" ||
				String(process.env.SERVICES || "").includes("dist/services");
			if (runBuiltWorkers && fs.existsSync(distWorker)) {
				return {
					command: process.execPath,
					args: [
						path.resolve(cwd, "node_modules/moleculer/bin/moleculer-runner.js"),
						"--config",
						path.resolve(cwd, "dist/moleculer.config.js"),
						distWorker,
					],
				};
			}

			return {
				command: process.execPath,
				args: [
					path.resolve(cwd, "node_modules/ts-node/dist/bin.js"),
					path.resolve(cwd, "node_modules/moleculer/bin/moleculer-runner.js"),
					"--config",
					path.resolve(cwd, "src/moleculer.config.ts"),
					path.resolve(cwd, "src/services/core/sys/minio.tile-delete.worker.ts"),
				],
			};
		},
		async touchTileDeleteJob(jobId: string, patch: Record<string, unknown> = {}) {
			await this.db("storage.tile_delete_job")
				.where({ job_id: jobId })
				.update({
					heartbeat_at: this.db.fn.now(),
					updated_at: this.db.fn.now(),
					...patch,
				});
		},
		isTileDeleteWorkerPidAlive(pid: number | null | undefined) {
			const numericPid = Number(pid || 0);
			if (!Number.isFinite(numericPid) || numericPid <= 0) {
				return false;
			}
			try {
				process.kill(numericPid, 0);
				return true;
			} catch (error: any) {
				if (error?.code === "EPERM") {
					return true;
				}
				return false;
			}
		},
		async getActiveTileDeleteJob(nodeId: number) {
			return this.db("storage.tile_delete_job")
				.select("*")
				.where({ node_id: nodeId })
				.whereIn("status", ["queued", "running"])
				.orderBy("created_at", "desc")
				.first();
		},
		async reconcileTileDeleteJobs() {
			const staleCutoff = new Date(Date.now() - this.getTileDeleteWorkerStaleMs()).toISOString();
			const queuedCutoff = new Date(
				Date.now() - this.getTileDeleteWorkerStartGraceMs()
			).toISOString();
			const staleQueuedJobs = await this.db("storage.tile_delete_job")
				.select("*")
				.where({ status: "queued" })
				.andWhere("created_at", "<", queuedCutoff);
			for (const job of staleQueuedJobs) {
				await this.db("storage.tile_delete_job")
					.where({ job_id: job.job_id })
					.update({
						status: "failed",
						last_error: "Tile delete worker did not start",
						finished_at: this.db.fn.now(),
						updated_at: this.db.fn.now(),
					});
				await this.broker.call("minio.notifyTileDeleteFinished", {
					nodeId: job.node_id,
					status: "failed",
				}).catch(() => null);
			}
			const staleJobs = await this.db("storage.tile_delete_job")
				.select("*")
				.where({ status: "running" })
				.andWhere(builder => {
					builder.whereNull("heartbeat_at").orWhere("heartbeat_at", "<", staleCutoff);
				});

			for (const job of staleJobs) {
				await this.db("storage.tile_delete_job")
					.where({ job_id: job.job_id })
					.update({
						status: "failed",
						last_error: "Tile delete worker heartbeat expired",
						finished_at: this.db.fn.now(),
						updated_at: this.db.fn.now(),
					});
				await this.broker.call("minio.notifyTileDeleteFinished", {
					nodeId: job.node_id,
					status: "failed",
				}).catch(() => null);
			}
			return { staleCount: staleJobs.length + staleQueuedJobs.length };
		},
		async spawnTileDeleteWorker(jobId: string, workerId: string) {
			const { command, args } = this.buildTileDeleteWorkerCommand();
			const nodeIdBase =
				process.env.MINIO_TILE_DELETE_NODE_BASE ||
				process.env.NODE_ID ||
				"minio";
			const rawLogPath = this.getTileDeleteWorkerRawLogPath(workerId);
			fs.mkdirSync(path.dirname(rawLogPath), { recursive: true });
			const rawLogFd = fs.openSync(rawLogPath, "a");
			let child;
			try {
				child = spawn(command, args, {
					cwd: process.cwd(),
					detached: true,
					stdio: ["ignore", rawLogFd, rawLogFd],
					env: {
						...process.env,
						SERVICES: "",
						MOLECULER_METRICS: "false",
						ENV_FILE: process.env.ENV_FILE || "./.env-dev",
						MINIO_TILE_DELETE_NODE_BASE: nodeIdBase,
						LOG_FILE_NAME:
							process.env.MINIO_TILE_DELETE_LOG_FILE_NAME ||
							"tile-delete-worker-{date}-{nodeID}.log",
						NODE_ID: `${nodeIdBase}:tdw:${workerId.slice(0, 8)}`,
						MINIO_TILE_DELETE_JOB_ID: jobId,
						MINIO_TILE_DELETE_WORKER_ID: workerId,
					},
				});
			} catch (error) {
				try {
					fs.closeSync(rawLogFd);
				} catch {
					// ignore
				}
				throw error;
			}
			const childNodeId = `${nodeIdBase}:tdw:${workerId.slice(0, 8)}`;
			this.logger.info(
				`MINIO_TILE_DELETE_CHILD_CMD job=${jobId} worker=${workerId} pid=${String(child.pid || "") || "-"} node=${childNodeId} rawLog=${rawLogPath} command=${command} args=${JSON.stringify(args)}`
			);
			child.on("spawn", () => {
				this.logger.info(
					`MINIO_TILE_DELETE_CHILD_SPAWNED job=${jobId} worker=${workerId} pid=${String(child.pid || "") || "-"}`
				);
			});
			child.on("error", error => {
				this.logger.error(
					`MINIO_TILE_DELETE_CHILD_ERROR job=${jobId} worker=${workerId} pid=${String(child.pid || "") || "-"}: ${error?.message || error}`
				);
			});
			child.on("exit", (code, signal) => {
				this.logger.warn(
					`MINIO_TILE_DELETE_CHILD_EXIT job=${jobId} worker=${workerId} pid=${String(child.pid || "") || "-"} code=${String(code)} signal=${String(signal)}`
				);
			});
			child.on("close", (code, signal) => {
				this.logger.warn(
					`MINIO_TILE_DELETE_CHILD_CLOSE job=${jobId} worker=${workerId} pid=${String(child.pid || "") || "-"} code=${String(code)} signal=${String(signal)}`
				);
				try {
					fs.closeSync(rawLogFd);
				} catch {
					// ignore
				}
			});
			setTimeout(() => {
				this.logger.info(
					`MINIO_TILE_DELETE_CHILD_PROBE job=${jobId} worker=${workerId} pid=${String(child.pid || "") || "-"} alive=${this.isTileDeleteWorkerPidAlive(child.pid || null) ? "1" : "0"}`
				);
			}, 1000).unref?.();
			child.unref();
			await this.touchTileDeleteJob(jobId, {
				pid: child.pid || null,
				worker_id: workerId,
			});
			return child.pid || null;
		},
		async enqueueTileDeleteJob(ctx, nodeId: number) {
			const existing = await this.getActiveTileDeleteJob(nodeId);
			if (existing) {
				return {
					jobId: String(existing.job_id),
					nodeId,
					status: String(existing.status),
				};
			}

			const existingRecord = await this.getTileRecordByNodeId(nodeId);
			const tilePrefix = existingRecord?.tile_prefix || `${this.getTilePrefix(nodeId)}/source_files/`;
			const dziObjectName = existingRecord?.dzi_object_name || `${this.getTilePrefix(nodeId)}/source.dzi`;
			const bucketName = existingRecord?.bucket_name || this.getPrimaryBucket() || null;
			const jobId = randomUUID();
			const workerId = randomUUID();
			const activeTrace = await loadTraceContext().catch(() => null);
			const traceSessionId = String(activeTrace?.sessionId || "").trim() || null;
			await this.db("storage.tile_delete_job").insert({
				job_id: jobId,
				node_id: nodeId,
				trace_session_id: traceSessionId,
				status: "queued",
				worker_id: workerId,
				bucket_name: bucketName,
				dzi_object_name: dziObjectName,
				tile_prefix: tilePrefix,
				phase: "queued",
				created_by: ctx.meta?.user?.sub || null,
				created_at: this.db.fn.now(),
				updated_at: this.db.fn.now(),
			});
			await ctx.call("minio.publishTileDeleteProgress", {
				node_id: nodeId,
				job_id: jobId,
				status: "queued",
				phase: "queued",
			}).catch(() => null);
			try {
				await this.spawnTileDeleteWorker(jobId, workerId);
			} catch (error: any) {
				await this.db("storage.tile_delete_job")
					.where({ job_id: jobId })
					.update({
						status: "failed",
						last_error: error?.message || "Failed to spawn tile delete worker",
						finished_at: this.db.fn.now(),
						updated_at: this.db.fn.now(),
					})
					.catch(() => null);
				await ctx.call("minio.publishTileDeleteProgress", {
					node_id: nodeId,
					job_id: jobId,
					status: "failed",
					phase: "failed",
					error: error?.message || "Failed to spawn tile delete worker",
				}).catch(() => null);
				throw error;
			}
			return {
				jobId,
				nodeId,
				status: "queued",
			};
		},
		getTilePrefix(nodeId: number) {
			return `tiles/vfs/${nodeId}`;
		},
		getCacheEntry(cache: Map<string, { expiresAt: number; value: unknown }>, key: string) {
			const entry = cache.get(key);
			if (!entry) return null;
			if (entry.expiresAt <= Date.now()) {
				cache.delete(key);
				return null;
			}
			return entry.value;
		},
		setCacheEntry(
			cache: Map<string, { expiresAt: number; value: unknown }>,
			key: string,
			value: unknown,
			ttlMs = TILE_META_CACHE_TTL_MS
		) {
			cache.set(key, {
				expiresAt: Date.now() + ttlMs,
				value,
			});
			return value;
		},
		getTileActorKey(ctx) {
			return String(
				ctx.meta?.user?.sub ||
					ctx.meta?.$session?.user?.sub ||
					ctx.meta?.$session?.sessionData?.sub ||
					"guest"
			);
		},
		getTileAssetContentType(assetPath: string, objectName: string) {
			if (String(assetPath || "").replace(/^\/+/, "") === "source.dzi") {
				return "application/xml";
			}
			return mime.lookup(objectName) || "application/octet-stream";
		},
		getAlternateTileObjectName(objectName: string) {
			const normalized = String(objectName || "");
			if (normalized.endsWith(".jpg")) {
				return `${normalized.slice(0, -4)}.jpeg`;
			}
			if (normalized.endsWith(".jpeg")) {
				return `${normalized.slice(0, -5)}.jpg`;
			}
			return null;
		},
		async getTileObjectWithFallback(bucketName: string, objectName: string) {
			try {
				const data = await this.client.getObject(bucketName, objectName);
				return {
					data,
					objectName,
				};
			} catch (error) {
				const alternateObjectName = this.getAlternateTileObjectName(objectName);
				if (!alternateObjectName) {
					throw error;
				}
				const data = await this.client.getObject(bucketName, alternateObjectName);
				return {
					data,
					objectName: alternateObjectName,
				};
			}
		},
		getTileTokenSecret() {
			return String(
				process.env.MINIO_TILE_TOKEN_SECRET ||
					process.env.SESSION_SECRET ||
					"minio-tile-secret"
			);
		},
		createTileToken(payload: {
			publicUrl: string;
			bucketName: string;
			dziObjectName: string;
			tilePrefix: string;
		}) {
			const body = {
				v: 1,
				u: payload.publicUrl,
				b: payload.bucketName,
				d: payload.dziObjectName,
				p: payload.tilePrefix,
				e: Math.floor(Date.now() / 1000) + TILE_TOKEN_TTL_SEC,
			};
			const encoded = Buffer.from(JSON.stringify(body), "utf8").toString("base64url");
			const signature = createHmac("sha256", this.getTileTokenSecret())
				.update(encoded)
				.digest("base64url");
			return `${encoded}.${signature}`;
		},
		verifyTileToken(token: string) {
			const [encoded, signature] = String(token || "").split(".");
			if (!encoded || !signature) {
				return null;
			}
			const expected = createHmac("sha256", this.getTileTokenSecret())
				.update(encoded)
				.digest("base64url");
			if (signature !== expected) {
				return null;
			}
			try {
				const payload = JSON.parse(
					Buffer.from(encoded, "base64url").toString("utf8")
				) as {
					v: number;
					u: string;
					b: string;
					d: string;
					p: string;
					e: number;
				};
				if (!payload?.u || !payload?.b || !payload?.d || !payload?.p || !payload?.e) {
					return null;
				}
				if (payload.e < Math.floor(Date.now() / 1000)) {
					return null;
				}
				return payload;
			} catch {
				return null;
			}
		},
		buildTileSessionUrls(publicUrl: string, record: { bucket_name: string; dzi_object_name: string; tile_prefix: string }) {
			const token = this.createTileToken({
				publicUrl,
				bucketName: record.bucket_name,
				dziObjectName: record.dzi_object_name,
				tilePrefix: record.tile_prefix,
			});
			return {
				token,
				dziUrl: `${this.getTileAssetUrl(publicUrl, "source.dzi")}?tile_token=${encodeURIComponent(token)}`,
				tileUrl: this.getTileAssetUrl(
					publicUrl,
					`source_files/__token__/${encodeURIComponent(token)}/`
				),
			};
		},
		injectDziTileUrl(xml: string, tileUrl: string) {
			const escapedTileUrl = tileUrl.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
			if (/\bUrl="/i.test(xml)) {
				return xml.replace(/\bUrl="[^"]*"/i, `Url="${escapedTileUrl}"`);
			}
			return xml.replace(/<Image\b/i, `<Image Url="${escapedTileUrl}"`);
		},
		async getCachedTileNodeByPublicUrl(publicUrl: string) {
			const cacheKey = `node:${publicUrl}`;
			const cached = this.getCacheEntry(this.tileNodeCache, cacheKey);
			if (cached) {
				return cached;
			}
			const node = await this.getVfsFileNodeRecordByPublicUrl(publicUrl);
			return this.setCacheEntry(this.tileNodeCache, cacheKey, node);
		},
		async getCachedTileAccess(ctx, nodeId: number, publicUrl: string) {
			const cacheKey = `access:${publicUrl}:${this.getTileActorKey(ctx)}`;
			const cached = this.getCacheEntry(this.tileAccessCache, cacheKey);
			if (cached) {
				return cached;
			}
			const access = (await ctx.call("vfs.resolveAccess", {
				node_id: nodeId,
				permission: "read",
			})) as VfsAccessResult;
			return this.setCacheEntry(this.tileAccessCache, cacheKey, access, 3000);
		},
		async getResolvedTileRecord(node, publicUrl: string) {
			const cacheKey = `record:${node.node_id}`;
			const cached = this.getCacheEntry(this.tileRecordCache, cacheKey);
			if (cached) {
				return cached;
			}

			let record = await this.getTileRecordByNodeId(node.node_id);
			if (!record) {
				const found = await this.findTileRecordInBuckets(node.node_id);
				if (!found) {
					return null;
				}
				record = await this.upsertTileRecord({
					nodeId: node.node_id,
					sourceRef: node.hash || publicUrl,
					bucketName: found.bucket_name,
					dziObjectName: found.dzi_object_name,
					tilePrefix: found.tile_prefix,
				});
			}

			return this.setCacheEntry(this.tileRecordCache, cacheKey, record);
		},
		getTileRecordByNodeId(nodeId: number) {
			return this.db("storage.node_tiles").where({ node_id: nodeId }).first();
		},
		async upsertTileRecord({
			nodeId,
			sourceRef,
			bucketName,
			dziObjectName,
			tilePrefix,
		}: {
			nodeId: number;
			sourceRef: string;
			bucketName: string;
			dziObjectName: string;
			tilePrefix: string;
		}) {
			const payload = {
				node_id: nodeId,
				source_ref: sourceRef,
				bucket_name: bucketName,
				dzi_object_name: dziObjectName,
				tile_prefix: tilePrefix,
				updated_at: this.db.fn.now(),
			};

			await this.db("storage.node_tiles")
				.insert({
					...payload,
					created_at: this.db.fn.now(),
				})
				.onConflict(["node_id"])
				.merge(payload);

			const record = await this.getTileRecordByNodeId(nodeId);
			this.setCacheEntry(this.tileRecordCache, `record:${nodeId}`, record);
			return record;
		},
		async removeTileRecord(nodeId: number) {
			await this.db("storage.node_tiles").where({ node_id: nodeId }).delete();
			this.tileRecordCache.delete(`record:${nodeId}`);
		},
		async findTileRecordInBuckets(nodeId: number) {
			const tilePrefix = this.getTilePrefix(nodeId);
			const dziObjectName = `${tilePrefix}/source.dzi`;
			const candidateBuckets = _.uniq(
				[
					this.settings.minio.bucket,
				].filter(Boolean)
			);
			const storageClient = this.client as unknown as MinIOClient;

			const bucketChecks = await Promise.all(
				candidateBuckets.map(async bucketName => ({
					bucketName,
					exists: await storageClient.objectExists(bucketName, dziObjectName).catch(() => false),
				}))
			);
			const existingBucket = bucketChecks.find(bucket => bucket.exists);
			if (existingBucket) {
				return {
					bucket_name: existingBucket.bucketName,
					dzi_object_name: dziObjectName,
					tile_prefix: `${tilePrefix}/source_files/`,
				};
			}

			return null;
		},
		async deleteTilesByNodeId(nodeId: number, removeRecord = true, progressCtx = null) {
			const existingRecord = await this.getTileRecordByNodeId(nodeId);
			const tilePrefix = existingRecord?.tile_prefix || `${this.getTilePrefix(nodeId)}/source_files/`;
			const dziObjectName = existingRecord?.dzi_object_name || `${this.getTilePrefix(nodeId)}/source.dzi`;
			const candidateBuckets = _.uniq(
				[
					existingRecord?.bucket_name,
					this.settings.minio.bucket,
				].filter(Boolean)
			);

			let scanned = 0;
			const publishProgress = async (payload: Record<string, unknown>) => {
				if (!progressCtx) {
					return;
				}
				await PubBuilder.New(progressCtx, MINIO_TILE_DELETE_PROGRESS_EVENT)
					.payload({
						node_id: nodeId,
						...payload,
					})
					.pub();
			};
			await publishProgress({
				phase: "scan_tiles",
				scanned: 0,
			});

			const bucketObjects = await Promise.all(
				candidateBuckets.map(async bucketName => ({
					bucketName,
					objects: (await this.client
						.listObjects(bucketName, tilePrefix, true, (_object, count) => {
							scanned += 1;
							if (scanned === 1 || scanned % 250 === 0) {
								void publishProgress({
									phase: "scan_tiles",
									scanned,
								});
							}
						})
						.catch(() => [])) as Array<{ name: string }>,
				}))
			);
			const chunkArray = <T,>(items: T[], size: number) => {
				const chunks: T[][] = [];
				for (let index = 0; index < items.length; index += size) {
					chunks.push(items.slice(index, index + size));
				}
				return chunks;
			};

			const total = bucketObjects.reduce((sum, { objects }) => sum + (objects?.length || 0), 0) + candidateBuckets.length;
			let deleted = 0;
			await publishProgress({
				phase: "delete_tiles",
				progress: {
					deleted,
					total,
					percent: total ? 0 : 100,
				},
			});

			for (const bucketName of candidateBuckets) {
				await this.client.removeObject(bucketName, dziObjectName).catch(() => null);
				deleted += 1;
				await publishProgress({
					phase: "delete_tiles",
					progress: {
						deleted,
						total,
						percent: total ? Math.round((deleted / total) * 100) : 100,
					},
				});
			}

			for (const { bucketName, objects } of bucketObjects.filter(({ objects }) => objects?.length)) {
				const objectNames = objects.map(object => object.name).filter(Boolean);
				const chunks = chunkArray(objectNames, TILE_DELETE_BATCH_SIZE);
				for (const chunk of chunks) {
					const errors = await this.client.removeObjects(bucketName, chunk).catch(() => []);
					const failedNames = new Set(
						Array.isArray(errors)
							? errors.map(error => error?.name).filter(Boolean)
							: []
					);
					deleted += chunk.filter(name => !failedNames.has(name)).length;
					await publishProgress({
						phase: "delete_tiles",
						progress: {
							deleted,
							total,
							percent: total ? Math.round((deleted / total) * 100) : 100,
						},
					});
				}
			}

			if (removeRecord) {
				await this.removeTileRecord(nodeId);
			}

			return {
				nodeId,
			};
		},
		async publishVfsTileEvent(ctx, nodeId: number, event: string) {
			const node = await this.db("storage.nodes").where({ node_id: nodeId }).first();
			const payload = {
				event,
				node_id: nodeId,
				parent_id: node?.parent_id ?? null,
				old_parent_id: node?.parent_id ?? null,
				type: node?.type ?? "FILE",
			};
			await publishVfsBridgeEvent({
				changed: payload,
				nodeChanged: payload,
			});
		},
		parseBooleanField(value: unknown) {
			if (typeof value === "boolean") {
				return value;
			}
			if (typeof value === "number") {
				return value === 1;
			}
			if (typeof value !== "string") {
				return false;
			}

			return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
		},
		sanitizeDirectUploadOwner(value: string) {
			return String(value || "")
				.trim()
				.replace(/[^a-zA-Z0-9._-]+/g, "_")
				.slice(0, 96);
		},
		getDirectUploadPrefix(ownerSub: string) {
			return `direct/${this.sanitizeDirectUploadOwner(ownerSub)}/`;
		},
		buildDirectUploadObjectName(ownerSub: string, originalName: string) {
			const ext = path.extname(String(originalName || "")).toLowerCase().slice(0, 32);
			const datePart = new Date().toISOString().slice(0, 10);
			return `${this.getDirectUploadPrefix(ownerSub)}${datePart}/${randomUUID()}${ext}`;
		},
		assertDirectUploadOwnership(ctx, objectName: string) {
			const userSub = String(ctx.meta?.user?.sub || "").trim();
			if (!userSub) {
				throw new MoleculerErrors.MoleculerClientError(
					"Session is required",
					401,
					"UNAUTHORIZED"
				);
			}

			const expectedPrefix = this.getDirectUploadPrefix(userSub);
			if (!String(objectName || "").startsWith(expectedPrefix)) {
				throw new MoleculerErrors.MoleculerClientError(
					"Upload object does not belong to current user",
					403,
					"UPLOAD_OWNERSHIP_VIOLATION"
				);
			}
		},
		storeUploadedFiles(ctx, files = []) {
			if (!Array.isArray(files) || !files.length) {
				return [];
			}

			const bucketName = this.getPrimaryBucket();

			return Promise.all(
				files.map(file => {
					const ext = path.extname(file.originalname || "").toLowerCase();
					const objectName = `${file.fieldname || "file"}/${randomUUID()}${ext}`;
					const metadata = {
						originalname_b64: Buffer.from(file.originalname || "", "utf8").toString("base64url"),
						fieldname: String(file.fieldname || "file"),
					};

					return this.client.putObject(
						bucketName,
						objectName,
						file.buffer,
						file.mimetype || undefined,
						metadata
					);
				})
			);
		},
		parseDziXml(xml: string, tileUrl: string) {
			const tileSize = xml.match(/TileSize="(\d+)"/i)?.[1];
			const overlap = xml.match(/Overlap="(\d+)"/i)?.[1];
			const format = xml.match(/Format="([^"]+)"/i)?.[1];
			const width = xml.match(/Width="(\d+)"/i)?.[1];
			const height = xml.match(/Height="(\d+)"/i)?.[1];

			if (!tileSize || !overlap || !format || !width || !height) {
				throw new Error("Invalid DZI manifest");
			}

			return {
				Image: {
					xmlns: "http://schemas.microsoft.com/deepzoom/2008",
					Url: tileUrl,
					Format: format,
					Overlap: overlap,
					TileSize: tileSize,
					Size: {
						Width: Number(width),
						Height: Number(height),
					},
				},
			};
		},
		async getVfsFileNode(nodeId: number) {
			const node = await this.getVfsFileNodeRecord(nodeId);
			if (!node.hash) {
				throw new MoleculerErrors.ValidationError("VFS node has no storage ref", "EMPTY_REF");
			}
			const parsed = parseStorageRef(node.hash);
			if (!parsed || parsed.kind !== "minio") {
				throw new MoleculerErrors.ValidationError(
					"VFS node is not backed by MinIO",
					"INVALID_STORAGE_REF"
				);
			}
			return node;
		},
		async getVfsFileNodeRecord(nodeId: number) {
			const node = await this.db("storage.nodes")
				.select("*")
				.where({ node_id: nodeId, type: "FILE" })
				.first();
			if (!node) {
				throw new MoleculerErrors.ValidationError("VFS file node not found", "NODE_NOT_FOUND");
			}
			return node;
		},
		async getVfsFileNodeByPublicUrl(publicUrl: string) {
			const node = await this.getVfsFileNodeRecordByPublicUrl(publicUrl);
			if (!node.hash) {
				throw new MoleculerErrors.ValidationError("VFS node has no storage ref", "EMPTY_REF");
			}
			const parsed = parseStorageRef(node.hash);
			if (!parsed || parsed.kind !== "minio") {
				throw new MoleculerErrors.ValidationError(
					"VFS node is not backed by MinIO",
					"INVALID_STORAGE_REF"
				);
			}
			return node;
		},
		async createPreviewByNodeId(ctx, nodeId: number, options: { size?: number; force?: boolean } = {}) {
			const size = this.normalizePreviewSize(options.size);
			const force = Boolean(options.force);
			const node = await this.getVfsFileNode(nodeId);
			const resolved = (await ctx.call("minio.resolveFileRef", {
				ref: node.hash,
				name: node.name,
			})) as {
				mime?: string | null;
			};
			const sourceMime = String(resolved?.mime || mime.lookup(node.name) || "").toLowerCase();
			if (!this.isPreviewMimeSupported(sourceMime, node.name)) {
				throw new MoleculerErrors.MoleculerClientError(
					`Preview is not supported for ${node.name} (${sourceMime || "unknown mime"})`,
					422,
					"PREVIEW_UNSUPPORTED",
					{
						nodeId,
						name: node.name,
						mime: sourceMime || null,
					}
				);
			}

			const existing = await this.getPreviewRecordByNodeIdSize(nodeId, size);
			const existingObjectAlive =
				existing &&
				(await this.client.objectExists(existing.bucket_name, existing.object_name).catch(() => false));
			if (
				existing &&
				existingObjectAlive &&
				!force &&
				String(existing.source_ref || "") === String(node.hash || "")
			) {
				return {
					nodeId,
					publicUrl: node.public_url,
					size,
					bucketName: existing.bucket_name,
					objectName: existing.object_name,
					mime: existing.mime || "image/jpeg",
					width: existing.width == null ? null : Number(existing.width),
					height: existing.height == null ? null : Number(existing.height),
					url: this.getPreviewUrl(node.public_url, size),
					storageRef: existing.storage_ref,
				};
			}

			const effectiveVisibility = String(
				(await this.broker.call("vfs.resolveEffectiveVisibility", {
					node_id: nodeId,
				})) || "private"
			);
			const targetBucket = this.getPreviewBucketByVisibility(effectiveVisibility);
			const objectName = this.getPreviewObjectName(nodeId, size);
			const parsed = this.parseMinioRef(node.hash);
			const sourceBuffer = (await this.client.getObject(
				parsed.bucketName,
				parsed.objectName
			)) as Buffer;
			const transformed = await sharp(sourceBuffer, { limitInputPixels: false })
				.rotate()
				.resize({
					width: size,
					height: size,
					fit: "inside",
					withoutEnlargement: true,
				})
				.jpeg({
					quality: PREVIEW_JPEG_QUALITY,
				})
				.toBuffer({ resolveWithObject: true });
			const previewMeta = await sharp(transformed.data, { limitInputPixels: false }).metadata();
			const uploaded = await this.client.putObject(
				targetBucket,
				objectName,
				transformed.data,
				"image/jpeg",
				{
					source_node_id: String(nodeId),
					source_ref: String(node.hash || ""),
					preview_size: String(size),
				}
			);

			if (
				existing &&
				(existing.bucket_name !== targetBucket || existing.object_name !== objectName)
			) {
				await this.client.removeObject(existing.bucket_name, existing.object_name).catch(() => null);
			}

			const record = await this.upsertPreviewRecord({
				nodeId,
				size,
				sourceRef: String(node.hash || ""),
				bucketName: targetBucket,
				objectName,
				storageRef: uploaded.storageRef,
				mime: "image/jpeg",
				width: previewMeta.width ?? null,
				height: previewMeta.height ?? null,
			});

			return {
				nodeId,
				publicUrl: node.public_url,
				size,
				bucketName: record?.bucket_name || targetBucket,
				objectName: record?.object_name || objectName,
				mime: record?.mime || "image/jpeg",
				width: record?.width == null ? null : Number(record.width),
				height: record?.height == null ? null : Number(record.height),
				url: this.getPreviewUrl(node.public_url, size),
				storageRef: record?.storage_ref || uploaded.storageRef,
			};
		},
		async deletePreviewsByNodeIds(nodeIds: number[] = []) {
			const normalizedNodeIds = Array.from(
				new Set(
					(nodeIds || [])
						.map(value => Number(value))
						.filter(value => Number.isInteger(value) && value > 0)
				)
			);
			if (!normalizedNodeIds.length) {
				return {
					nodes: 0,
					objects: 0,
				};
			}
			const rows = await this.db("storage.node_preview")
				.select("*")
				.whereIn("node_id", normalizedNodeIds);
			const objects = _.uniqBy(
				rows.map(row => ({
					bucketName: String(row.bucket_name || ""),
					objectName: String(row.object_name || ""),
				})),
				entry => `${entry.bucketName}/${entry.objectName}`
			).filter(entry => entry.bucketName && entry.objectName);
			await Promise.all(
				objects.map(entry =>
					this.client.removeObject(entry.bucketName, entry.objectName).catch(() => null)
				)
			);
			await this.db("storage.node_preview").whereIn("node_id", normalizedNodeIds).delete();
			return {
				nodes: normalizedNodeIds.length,
				objects: objects.length,
			};
		},
		async getVfsFileNodeRecordByPublicUrl(publicUrl: string) {
			const node = await this.db("storage.nodes")
				.select("*")
				.where({ public_url: publicUrl, type: "FILE" })
				.first();
			if (!node) {
				throw new MoleculerErrors.ValidationError("VFS file node not found", "NODE_NOT_FOUND");
			}
			return node;
		},
		async getTileInfoByNodeId(nodeId: number) {
			const node = await this.getVfsFileNodeRecord(nodeId);
			const access = (await this.broker.call("vfs.resolveAccess", {
				node_id: nodeId,
				permission: "read",
			})) as VfsAccessResult;
			const storageClient = this.client as unknown as MinIOClient;
			let record = await this.getTileRecordByNodeId(nodeId);
			if (!record) {
				const found = await this.findTileRecordInBuckets(nodeId);
				if (!found) {
					return null;
				}
				record = await this.upsertTileRecord({
					nodeId,
					sourceRef: node.hash || String(node.public_url || ""),
					bucketName: found.bucket_name,
					dziObjectName: found.dzi_object_name,
					tilePrefix: found.tile_prefix,
				});
			}

			const dziBuffer = (await storageClient.getObject(
				record.bucket_name,
				record.dzi_object_name
			)) as Buffer;
			const dziXml = dziBuffer.toString("utf8");
			const sessionUrls = this.buildTileSessionUrls(node.public_url, record);
			const dziUrl = sessionUrls.dziUrl;
			const tileUrl = sessionUrls.tileUrl;

			return {
				nodeId: node.node_id,
				publicUrl: node.public_url,
				name: node.name,
				sourceRef: node.hash || record.source_ref || null,
				bucketName: record.bucket_name,
				dziObjectName: record.dzi_object_name,
				tilePrefix: record.tile_prefix,
				dziUrl,
				tileUrl,
				tileToken: sessionUrls.token,
				visibility: access?.effectiveVisibility || "private",
				tileSource: this.parseDziXml(dziXml, tileUrl),
			};
		},
		async syncTilesVisibility(nodeId: number) {
			const node = await this.getVfsFileNodeRecord(nodeId);
			const access = (await this.broker.call("vfs.resolveAccess", {
				node_id: nodeId,
				permission: "read",
			})) as VfsAccessResult;
			const targetBucket = this.getTilesBucketByVisibility(
				access?.effectiveVisibility || "private"
			);
			const existingRecord = await this.getTileRecordByNodeId(nodeId);
			if (existingRecord) {
				if (existingRecord.bucket_name !== targetBucket) {
					const objects = (await this.client
						.listObjects(existingRecord.bucket_name, existingRecord.tile_prefix, true)
						.catch(() => [])) as Array<{ name: string }>;
					await this.client
						.copyObject(
							existingRecord.bucket_name,
							existingRecord.dzi_object_name,
							targetBucket,
							existingRecord.dzi_object_name
						)
						.catch(() => null);
					await Promise.all(
						objects.map(async object => {
							await this.client.copyObject(
								existingRecord.bucket_name,
								object.name,
								targetBucket,
								object.name
							);
							await this.client.removeObject(existingRecord.bucket_name, object.name);
						})
					);
					await this.client.removeObject(
						existingRecord.bucket_name,
						existingRecord.dzi_object_name
					).catch(() => null);
				}

				await this.upsertTileRecord({
					nodeId,
					sourceRef: node.hash || existingRecord.source_ref || String(node.public_url || ""),
					bucketName: targetBucket,
					dziObjectName: existingRecord.dzi_object_name,
					tilePrefix: existingRecord.tile_prefix,
				});

				return {
					nodeId,
					bucketName: targetBucket,
				};
			}

			const tilePrefix = this.getTilePrefix(node.node_id);
			const candidateBuckets = _.uniq(
				[
					this.settings.minio.bucket,
				].filter(Boolean)
			);
			const sourceBuckets = candidateBuckets.filter(sourceBucket => sourceBucket !== targetBucket);
			const bucketObjects = await Promise.all(
				sourceBuckets.map(async sourceBucket => ({
					sourceBucket,
					objects: (await this.client
						.listObjects(sourceBucket, tilePrefix, true)
						.catch(() => [])) as Array<{ name: string }>,
				}))
			);

			const foundObjects = bucketObjects.some(({ objects }) => objects?.length);
			await Promise.all(
				bucketObjects
					.filter(({ objects }) => objects?.length)
					.map(({ sourceBucket, objects }) =>
						Promise.all(
							objects.map(async object => {
								await this.client.copyObject(sourceBucket, object.name, targetBucket, object.name);
								await this.client.removeObject(sourceBucket, object.name);
							})
						)
					)
			);

			if (existingRecord || foundObjects) {
				await this.upsertTileRecord({
					nodeId,
					sourceRef: node.hash || String(node.public_url || ""),
					bucketName: targetBucket,
					dziObjectName: `${tilePrefix}/source.dzi`,
					tilePrefix: `${tilePrefix}/source_files/`,
				});
			}

			return {
				nodeId,
				bucketName: targetBucket,
			};
		},
		decodeOriginalName(metadata = {}) {
			const encoded =
				metadata?.originalname_b64 ||
				metadata?.["x-amz-meta-originalname_b64"] ||
				metadata?.["x-amz-meta-originalname-b64"];
			if (!encoded) {
				return null;
			}
			try {
				return Buffer.from(encoded, "base64url").toString("utf8");
			} catch {
				return null;
			}
		},
		async getVfsFileName(ref: string) {
			const node = await this.db("storage.nodes")
				.select("name")
				.where({ hash: ref, type: "FILE" })
				.orderBy("node_id", "asc")
				.first();
			return node?.name || null;
		},
		async streamFileByRef(ctx, ref: string, download = false, preferredName?: string) {
			const parsedRef = this.parseMinioRef(ref);
			const access = (await ctx.call("vfs.resolveAccess", {
				ref,
				permission: "read",
			})) as VfsAccessResult;
			if (!access?.allowed && !this.isPublicBucket(parsedRef.bucketName)) {
				throw new MoleculerErrors.MoleculerClientError(
					"Access denied for file read",
					403,
					"FORBIDDEN"
				);
			}
			const [fileInfo, data] = await Promise.all([
				ctx.call("minio.resolveFileRef", {
					ref,
					name: preferredName || access?.node?.name,
				}),
				this.client.getObject(parsedRef.bucketName, parsedRef.objectName),
			]);
			const enFilename = encodeURIComponent(fileInfo.name);
			ctx.meta.$responseHeaders = {
				"Content-Type": fileInfo.mime,
				"Content-Disposition": `${
					download ? "attachment" : "inline"
				}; filename=${enFilename}; filename*=UTF-8''${enFilename}`,
			};
			ctx.meta.$responseType = fileInfo.mime;
			return data;
		},
		isAllowedByRule(user, rule) {
			const roles = user?.roles || [];
			const groups = user?.groups || [];
			const hasRole = rule.roles?.length ? rule.roles.some(role => roles.includes(role)) : false;
			const hasGroup = rule.groups?.length
				? rule.groups.some(group => groups.includes(group))
				: false;
			return hasRole || hasGroup;
		},
		enforcePermission(ctx, permission) {
			if (isInternalCall(ctx)) {
				return;
			}
			const user = ctx.meta.user;
			if (!user) {
				throw new MoleculerErrors.MoleculerClientError("Unauthorized", 401, "UNAUTHORIZED");
			}

			if (this.isAllowedByRule(user, config.access.admin)) {
				return;
			}

			const rule = config.access[permission];
			if (!rule?.roles?.length && !rule?.groups?.length) {
				return;
			}

			if (!this.isAllowedByRule(user, rule)) {
				throw new MoleculerErrors.MoleculerClientError(
					`Access denied for MinIO ${permission}`,
					403,
					"FORBIDDEN"
				);
			}
		},
		enforceReadAccess(ctx) {
			this.enforcePermission(ctx, "read");
		},
		enforceWriteAccess(ctx) {
			this.enforcePermission(ctx, "write");
		},
		enforceDeleteAccess(ctx) {
			this.enforcePermission(ctx, "delete");
		},
		enforceAdminAccess(ctx) {
			this.enforcePermission(ctx, "admin");
		},
	},

	/**
	 * Обработчики событий
	 */
	events: {
		/**
		 * Обработчик события очистки кэша
		 */
		"cache.clean.minio"(payload) {
			this.logger.info("Cleaning MinIO cache...");
			if (this.broker.cacher) {
				this.broker.cacher.clean(`${this.name}.*`);
			}
		},
	},

	/**
	 * Обработчики ошибок
	 */
	/*
  errorHandlers: [
    {
      match: /MinIO connection failed/,
      handler: (err, ctx) => {
        this.logger.error('MinIO connection error:', err.message);
        // Можно добавить логику повторного подключения
      }
    },
    {
      match: /File size exceeds limit/,
      handler: (err, ctx) => {
        this.logger.warn('File size limit exceeded:', err.message);
      }
    }
  ]*/
};

export default minioService;
