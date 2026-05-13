/* eslint-disable no-console */
import type { ServiceSchema } from "moleculer";
import { DBMixin } from "@src/lib/mixins/db";
import { publishVfsBridgeEvent } from "@src/lib/vfsEventBridge";
import { MinIOClient } from "./mixins/s3/minio.client";
import config from "./mixins/s3/minio.config";
import _ from "lodash";

const TILE_DELETE_BATCH_SIZE = Math.max(
	50,
	Number(process.env.MINIO_TILE_DELETE_BATCH_SIZE || 500)
);

const workerService: ServiceSchema = {
	name: "minio.tileDeleteWorker",
	mixins: [DBMixin],
	settings: {
		minio: config.minio,
	},
	created() {
		this.client = new MinIOClient(this.logger);
	},
	methods: {
		getTilePrefix(nodeId: number) {
			return `vfs/${nodeId}`;
		},
		getTileRecordByNodeId(nodeId: number) {
			return this.db("storage.node_tiles").where({ node_id: nodeId }).first();
		},
		async removeTileRecord(nodeId: number) {
			await this.db("storage.node_tiles").where({ node_id: nodeId }).delete();
		},
		async publishVfsTileEvent(nodeId: number, event: string) {
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
		async findTileRecordInBuckets(nodeId: number) {
			const tilePrefix = this.getTilePrefix(nodeId);
			const dziObjectName = `${tilePrefix}/source.dzi`;
			const candidateBuckets = _.uniq(
				[
					this.settings.minio.bucket,
				].filter(Boolean)
			);

			const bucketChecks = await Promise.all(
				candidateBuckets.map(async bucketName => ({
					bucketName,
					exists: await this.client.objectExists(bucketName, dziObjectName).catch(() => false),
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
		async touchJob(jobId: string, patch: Record<string, unknown> = {}) {
			await this.db("storage.tile_delete_job")
				.where({ job_id: jobId })
				.update({
					heartbeat_at: this.db.fn.now(),
					updated_at: this.db.fn.now(),
					...patch,
				});
		},
		async publishProgress(payload: Record<string, unknown>) {
			await this.broker.call("minio.publishTileDeleteProgress", payload).catch(() => null);
		},
		async assertNotCanceled(jobId: string) {
			const job = await this.db("storage.tile_delete_job")
				.select("cancel_requested", "status")
				.where({ job_id: jobId })
				.first();
			if (job?.status === "canceled" || job?.cancel_requested) {
				const error: any = new Error(`Tile delete job ${jobId} canceled`);
				error.code = "TILE_DELETE_CANCELED";
				throw error;
			}
		},
		async runTileDeleteJob(jobId: string) {
			const job = await this.db("storage.tile_delete_job").select("*").where({ job_id: jobId }).first();
			if (!job) {
				throw new Error(`Tile delete job ${jobId} not found`);
			}

			await this.touchJob(jobId, {
				status: "running",
				started_at: this.db.fn.now(),
				last_error: null,
				phase: "scan_tiles",
				scanned: 0,
				deleted: 0,
				percent: 0,
			});
			await this.publishProgress({
				node_id: job.node_id,
				job_id: jobId,
				status: "running",
				phase: "scan_tiles",
				scanned: 0,
			});

			const existingRecord =
				(await this.getTileRecordByNodeId(Number(job.node_id))) ||
				(await this.findTileRecordInBuckets(Number(job.node_id)));
			const tilePrefix = existingRecord?.tile_prefix || `${this.getTilePrefix(Number(job.node_id))}/source_files/`;
			const dziObjectName = existingRecord?.dzi_object_name || `${this.getTilePrefix(Number(job.node_id))}/source.dzi`;
			const candidateBuckets = _.uniq(
				[
					existingRecord?.bucket_name,
					this.settings.minio.bucket,
				].filter(Boolean)
			);

			let scanned = 0;
			const bucketObjects = await Promise.all(
				candidateBuckets.map(async bucketName => ({
					bucketName,
					objects: (await this.client
						.listObjects(bucketName, tilePrefix, true, async (_object, count) => {
							scanned += 1;
							if (scanned === 1 || scanned % 250 === 0) {
								await this.touchJob(jobId, {
									phase: "scan_tiles",
									scanned,
								});
								await this.publishProgress({
									node_id: job.node_id,
									job_id: jobId,
									status: "running",
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
			await this.touchJob(jobId, {
				phase: "delete_tiles",
				scanned,
				total,
				deleted,
				percent: total ? 0 : 100,
				bucket_name: existingRecord?.bucket_name || job.bucket_name,
				dzi_object_name: dziObjectName,
				tile_prefix: tilePrefix,
			});
			await this.publishProgress({
				node_id: job.node_id,
				job_id: jobId,
				status: "running",
				phase: "delete_tiles",
				progress: {
					deleted,
					total,
					percent: total ? 0 : 100,
				},
			});

			for (const bucketName of candidateBuckets) {
				await this.assertNotCanceled(jobId);
				await this.client.removeObject(bucketName, dziObjectName).catch(() => null);
				deleted += 1;
				await this.touchJob(jobId, {
					phase: "delete_tiles",
					deleted,
					total,
					percent: total ? Math.round((deleted / total) * 100) : 100,
				});
				await this.publishProgress({
					node_id: job.node_id,
					job_id: jobId,
					status: "running",
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
					await this.assertNotCanceled(jobId);
					const errors = await this.client.removeObjects(bucketName, chunk).catch(() => []);
					const failedNames = new Set(
						Array.isArray(errors)
							? errors.map(error => error?.name).filter(Boolean)
							: []
					);
					deleted += chunk.filter(name => !failedNames.has(name)).length;
					await this.touchJob(jobId, {
						phase: "delete_tiles",
						deleted,
						total,
						percent: total ? Math.round((deleted / total) * 100) : 100,
					});
					await this.publishProgress({
						node_id: job.node_id,
						job_id: jobId,
						status: "running",
						phase: "delete_tiles",
						progress: {
							deleted,
							total,
							percent: total ? Math.round((deleted / total) * 100) : 100,
						},
					});
				}
			}

			await this.removeTileRecord(Number(job.node_id)).catch(() => null);
			await this.touchJob(jobId, {
				status: "succeeded",
				phase: "done",
				deleted,
				total,
				percent: 100,
				finished_at: this.db.fn.now(),
			});
			await this.publishVfsTileEvent(Number(job.node_id), "tiles-delete");
			await this.broker.call("minio.notifyTileDeleteFinished", {
				nodeId: job.node_id,
				status: "succeeded",
			}).catch(error => {
				this.logger.warn("MINIO_TILE_DELETE_NOTIFY_FAILED", {
					nodeId: job.node_id,
					message: error instanceof Error ? error.message : String(error),
				});
			});
		},
	},
	async started() {
		setImmediate(async () => {
			const jobId = String(process.env.MINIO_TILE_DELETE_JOB_ID || "");
			const workerId = String(process.env.MINIO_TILE_DELETE_WORKER_ID || "");
			let exitCode = 0;
			if (!jobId || !workerId) {
				this.logger.error("MINIO_TILE_DELETE_WORKER: missing jobId/workerId");
				exitCode = 1;
			} else {
				try {
					await this.touchJob(jobId, {
						worker_id: workerId,
						pid: process.pid,
						status: "running",
						last_error: null,
						cancel_requested: false,
					});
					await this.runTileDeleteJob(jobId);
				} catch (error: any) {
					const isCanceled = error?.code === "TILE_DELETE_CANCELED";
					exitCode = isCanceled ? 0 : 1;
					await this.db("storage.tile_delete_job")
						.where({ job_id: jobId })
						.update({
							status: isCanceled ? "canceled" : "failed",
							last_error: isCanceled ? null : error?.message || "Tile delete worker failed",
							finished_at: this.db.fn.now(),
							updated_at: this.db.fn.now(),
						})
						.catch(() => null);
					await this.broker
						.call(
							"minio.notifyTileDeleteFinished",
							{
								nodeId: (
									await this.db("storage.tile_delete_job")
										.select("node_id")
										.where({ job_id: jobId })
										.first()
								)?.node_id,
								status: isCanceled ? "canceled" : "failed",
							}
						)
						.catch(() => null);
					this.logger.error("MINIO_TILE_DELETE_WORKER:", error);
				}
			}
			await this.broker.stop().catch(() => null);
			setImmediate(() => {
				process.exit(exitCode);
			});
		});
	},
};

export default workerService;
