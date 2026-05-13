import * as Minio from "minio";
import streamifier from "streamifier";
import mime from "mime-types";
import config from "./minio.config";
import { LoggerInstance } from "moleculer";
import { createWriteStream } from "fs";
import { mkdir, readdir } from "fs/promises";
import path from "path";
import { pipeline } from "stream/promises";
import { formatMinioStorageRef } from "./storage-ref";

/*
https://github.com/minio/minio-js/blob/master/examples

*/

/*
  https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/client/s3/
*/

class MinIOClient {
	client: Minio.Client;
	publicClient: Minio.Client;
	logger: LoggerInstance;

	constructor(logger: LoggerInstance) {
		this.client = new Minio.Client({
			endPoint: config.minio.endPoint,
			port: config.minio.port,
			useSSL: config.minio.useSSL,
			accessKey: config.minio.accessKey,
			secretKey: config.minio.secretKey,
			region: config.minio.region,
		});
		this.publicClient = new Minio.Client({
			endPoint: config.minio.publicEndPoint,
			port: config.minio.publicPort,
			useSSL: config.minio.publicUseSSL,
			accessKey: config.minio.accessKey,
			secretKey: config.minio.secretKey,
			region: config.minio.region,
		});
		this.logger = logger;
	}

	normalizePublicPathPrefix(prefix) {
		const raw = String(prefix || "").trim();
		if (!raw || raw === "/") {
			return "";
		}
		return `/${raw.replace(/^\/+|\/+$/g, "")}`;
	}

	applyPublicUploadUrlPathPrefix(url) {
		const pathPrefix = this.normalizePublicPathPrefix(config.minio.publicPathPrefix);
		if (!pathPrefix) {
			return url;
		}

		const parsed = new URL(url);
		parsed.pathname = `${pathPrefix}${parsed.pathname.startsWith("/") ? "" : "/"}${parsed.pathname}`;
		return parsed.toString();
	}

	/**
	 * Проверка соединения с MinIO сервером
	 * @returns {Promise<boolean>}
	 */
	async checkConnection() {
		try {
			// Проверяем соединение через получение списка бакетов
			await this.client.listBuckets();
			this.logger.info("Connection to MinIO server successful");
			return true;
		} catch (error) {
			this.logger.error("Connection to MinIO server failed:", error.message);
			throw new Error(`MinIO connection failed: ${error.message}`, { cause: error });
		}
	}

	/**
	 * Создание бакетов по умолчанию
	 * @returns {Promise<void>}
	 */
	async createDefaultBuckets() {
		const buckets = config.minio.defaultBuckets;

		await Promise.all(
			buckets.map(async bucketName => {
				try {
					const exists = await this.client.bucketExists(bucketName);

					if (!exists) {
						await this.client.makeBucket(bucketName, config.minio.region);
						this.logger.info(`Bucket created: ${bucketName}`);
					} else {
						this.logger.info(`Bucket already exists: ${bucketName}`);
					}

					const policy = config.minio.bucketPolicies[bucketName];
					if (policy) {
						await this.setBucketPolicy(bucketName, policy);
					}
				} catch (error) {
					this.logger.error(`Failed to create bucket ${bucketName}:`, error.message);
					throw error;
				}
			})
		);
	}

	/**
	 * Установка политики для бакета
	 * @param {string} bucketName - Имя бакета
	 * @param {string} policyType - Тип политики (public-read, private)
	 * @returns {Promise<void>}
	 */
	async setBucketPolicy(bucketName, policyType) {
		try {
			let policy;

			switch (policyType) {
				case "public-read":
					policy = {
						Version: "2012-10-17",
						Statement: [
							{
								Effect: "Allow",
								Principal: "*",
								Action: ["s3:GetObject"],
								Resource: [`arn:aws:s3:::${bucketName}/*`],
							},
						],
					};
					break;
				case "private":
					policy = {
						Version: "2012-10-17",
						Statement: [],
					};
					break;
				default:
					return;
			}

			await this.client.setBucketPolicy(bucketName, JSON.stringify(policy));
			this.logger.info(`Policy set for bucket ${bucketName}: ${policyType}`);
		} catch (error) {
			this.logger.error(`Failed to set policy for bucket ${bucketName}:`, error.message);
			throw error;
		}
	}

	/**
	 * Создание нового бакета
	 * @param {string} bucketName - Имя бакета
	 * @param {string} region - Регион
	 * @param {boolean} objectLock - Включение блокировки объектов
	 * @returns {Promise<boolean>}
	 */
	async createBucket(bucketName, region, ObjectLocking) {
		try {
			await this.client.makeBucket(bucketName, region, { ObjectLocking });
			this.logger.info(`Bucket created successfully: ${bucketName}`);
			return true;
		} catch (error) {
			this.logger.error(`Failed to create bucket ${bucketName}:`, error.message);
			throw error;
		}
	}

	/**
	 * Удаление бакета
	 * @param {string} bucketName - Имя бакета
	 * @returns {Promise<boolean>}
	 */
	async removeBucket(bucketName) {
		try {
			await this.client.removeBucket(bucketName);
			this.logger.info(`Bucket removed successfully: ${bucketName}`);
			return true;
		} catch (error) {
			this.logger.error(`Failed to remove bucket ${bucketName}:`, error.message);
			throw error;
		}
	}

	/**
	 * Проверка существования бакета
	 * @param {string} bucketName - Имя бакета
	 * @returns {Promise<boolean>}
	 */
	async bucketExists(bucketName) {
		try {
			return await this.client.bucketExists(bucketName);
		} catch (error) {
			this.logger.error(`Failed to check bucket ${bucketName}:`, error.message);
			throw error;
		}
	}

	/**
	 * Получение списка всех бакетов
	 * @returns {Promise<Array>}
	 */
	async listBuckets() {
		try {
			const buckets = await this.client.listBuckets();
			return buckets.map(bucket => ({
				name: bucket.name,
				creationDate: bucket.creationDate,
			}));
		} catch (error) {
			this.logger.error("Failed to list buckets:", error.message);
			throw error;
		}
	}

	/**
	 * Загрузка файла в бакет
	 * @param {string} bucketName - Имя бакета
	 * @param {string} objectName - Имя объекта
	 * @param {Buffer} data - Данные файла
	 * @param {string} contentType - MIME тип
	 * @param {Object} metadata - Метаданные
	 * @returns {Promise<Object>}
	 */
	async putObject(bucketName, objectName, data, contentType, metadata) {
		try {
			// Проверка размера файла
			if (data.length > config.minio.limits.maxFileSize) {
				throw new Error(`File size exceeds limit: ${config.minio.limits.maxFileSize} bytes`);
			}

			// Определение MIME типа если не указан
			if (!contentType) {
				contentType = mime.lookup(objectName) || "application/octet-stream";
			}

			// Преобразование буфера в поток
			const stream = streamifier.createReadStream(data);

			// Загрузка файла
			await this.client.putObject(bucketName, objectName, stream, data.length, {
				"Content-Type": contentType,
				...metadata,
			});

			this.logger.info(`Object uploaded successfully: ${bucketName}/${objectName}`);

			// Очистка кэша для этого бакета
			// await this.broker.cacher.clean(`${this.name}.listObjects:${bucketName}:*`);

			return {
				bucketName,
				objectName,
				storageRef: formatMinioStorageRef(bucketName, objectName),
				size: data.length,
				contentType,
				uploadedAt: new Date().toISOString(),
			};
		} catch (error) {
			this.logger.error(`Failed to upload object ${objectName}:`, error.message);
			throw error;
		}
	}

	/**
	 * Загрузка файла в бакет
	 * @param {string} bucketName - Имя бакета
	 * @param {string} objectName - Имя объекта
	 * @param {Buffer} data - Данные файла
	 * @param {string} contentType - MIME тип
	 * @param {Object} metadata - Метаданные
	 * @returns {Promise<Object>}
	 */
	async fPutObject(bucketName, objectName, fullPath, metadata = {}) {
		try {
			// Проверка размера файла
			// if (data.length > config.minio.limits.maxFileSize) {
			//  throw new Error(`File size exceeds limit: ${config.minio.limits.maxFileSize} bytes`);
			// }

			// Загрузка файла
			const contentType = mime.lookup(fullPath) || "application/octet-stream";

			await this.client.fPutObject(bucketName, objectName, fullPath, {
				"Content-Type": contentType,
				...metadata,
			});

			this.logger.info(`Object uploaded successfully: ${bucketName}/${objectName}`);

			// Очистка кэша для этого бакета
			// await this.broker.cacher.clean(`${this.name}.listObjects:${bucketName}:*`);

			return {
				bucketName,
				objectName,
				storageRef: formatMinioStorageRef(bucketName, objectName),
				contentType,
				uploadedAt: new Date().toISOString(),
			};
		} catch (error) {
			this.logger.error(`Failed to upload object ${objectName}:`, error.message);
			throw error;
		}
	}

	/**
	 * Получение файла из бакета
	 * @param {string} bucketName - Имя бакета
	 * @param {string} objectName - Имя объекта
	 * @returns {Promise<Buffer>}
	 */
	async getObject(bucketName, objectName) {
		try {
			// Получение потока данных
			const stream = await this.client.getObject(bucketName, objectName);

			// Сборка данных из потока
			return new Promise((resolve, reject) => {
				const chunks = [];
				stream.on("data", chunk => chunks.push(chunk));
				stream.on("end", () => resolve(Buffer.concat(chunks)));
				stream.on("error", reject);
			});
		} catch (error) {
			this.logger.error(`Failed to get object ${objectName}:`, error.message);
			throw error;
		}
	}

	async fGetObject(bucketName, objectName, filePath) {
		try {
			await mkdir(path.dirname(filePath), { recursive: true });
			const stream = await this.client.getObject(bucketName, objectName);
			await pipeline(stream, createWriteStream(filePath));
			this.logger.info(`Object downloaded successfully: ${bucketName}/${objectName} -> ${filePath}`);
			return {
				bucketName,
				objectName,
				filePath,
				storageRef: formatMinioStorageRef(bucketName, objectName),
				downloadedAt: new Date().toISOString(),
			};
		} catch (error) {
			this.logger.error(`Failed to download object ${objectName}:`, error.message);
			throw error;
		}
	}

	/**
	 * Удаление файла из бакета
	 * @param {string} bucketName - Имя бакета
	 * @param {string} objectName - Имя объекта
	 * @returns {Promise<boolean>}
	 */
	async removeObject(bucketName, objectName) {
		try {
			await this.client.removeObject(bucketName, objectName);
			this.logger.info(`Object removed successfully: ${bucketName}/${objectName}`);

			// Очистка кэша
			// await this.broker.cacher.clean(`${this.name}.getObject:${bucketName}:${objectName}`);
			// await this.broker.cacher.clean(`${this.name}.statObject:${bucketName}:${objectName}`);
			// await this.broker.cacher.clean(`${this.name}.objectExists:${bucketName}:${objectName}`);

			return true;
		} catch (error) {
			this.logger.error(`Failed to remove object ${objectName}:`, error.message);
			throw error;
		}
	}

	async removeObjects(bucketName, objectNames) {
		try {
			if (!Array.isArray(objectNames) || objectNames.length === 0) {
				return [];
			}
			const errors = await this.client.removeObjects(bucketName, objectNames);
			if (Array.isArray(errors) && errors.length > 0) {
				this.logger.warn(
					`Batch remove finished with ${errors.length} error(s): ${bucketName}`
				);
			} else {
				this.logger.info(
					`Objects removed successfully: ${bucketName} (${objectNames.length})`
				);
			}
			return errors || [];
		} catch (error) {
			this.logger.error(
				`Failed to remove objects from ${bucketName}:`,
				error.message
			);
			throw error;
		}
	}

	/**
	 * Проверка существования объекта
	 * @param {string} bucketName - Имя бакета
	 * @param {string} objectName - Имя объекта
	 * @returns {Promise<boolean>}
	 */
	async objectExists(bucketName, objectName) {
		try {
			await this.client.statObject(bucketName, objectName);
			return true;
		} catch (error) {
			if (error.code === "NotFound") {
				return false;
			}
			throw error;
		}
	}

	/**
	 * Получение информации о объекте
	 * @param {string} bucketName - Имя бакета
	 * @param {string} objectName - Имя объекта
	 * @returns {Promise<Object>}
	 */
	async statObject(bucketName, objectName) {
		try {
			const stat = await this.client.statObject(bucketName, objectName);
			return {
				bucketName,
				objectName,
				storageRef: formatMinioStorageRef(bucketName, objectName),
				size: stat.size,
				etag: stat.etag,
				contentType: stat.metaData["content-type"] || stat.metaData["Content-Type"],
				lastModified: stat.lastModified,
				versionId: stat.versionId,
				metadata: stat.metaData || {},
			};
		} catch (error) {
			this.logger.error(`Failed to get object stats ${objectName}:`, error.message);
			throw error;
		}
	}

	/**
	 * Получение списка объектов в бакете
	 * @param {string} bucketName - Имя бакета
	 * @param {string} prefix - Префикс для фильтрации
	 * @param {boolean} recursive - Рекурсивный поиск
	 * @returns {Promise<Array>}
	 */
	listObjects(
		bucketName,
		prefix,
		recursive,
		onItem?: (object: Record<string, unknown>, count: number) => void
	) {
		try {
			const objects = [];
			const stream = this.client.extensions.listObjectsV2WithMetadata(
				bucketName,
				prefix,
				recursive,
				""
			);
			return new Promise((resolve, reject) => {
				stream.on("data", obj => {
					if (obj) {
						objects.push(obj);
						if (typeof onItem === "function") {
							onItem(obj, objects.length);
						}
					}
				});
				stream.on("end", () => resolve(objects));
				stream.on("error", reject);
			});
		} catch (error) {
			this.logger.error(`Failed to list objects in bucket ${bucketName}:`, error.message);
			throw error;
		}
	}

	/**
	 * Генерация пресигнед урла для скачивания
	 * @param {string} bucketName - Имя бакета
	 * @param {string} objectName - Имя объекта
	 * @param {number} expiry - Время жизни в секундах
	 * @returns {Promise<string>}
	 */
	async presignedGetObject(bucketName, objectName, expiry) {
		try {
			const url = await this.client.presignedGetObject(bucketName, objectName, expiry);
			this.logger.info(`Presigned URL generated for ${bucketName}/${objectName}`);
			return url;
		} catch (error) {
			this.logger.error(`Failed to generate presigned URL for ${objectName}:`, error.message);
			throw error;
		}
	}

	/**
	 * Генерация пресигнед урла для загрузки
	 * @param {string} bucketName - Имя бакета
	 * @param {string} objectName - Имя объекта
	 * @param {number} expiry - Время жизни в секундах
	 * @param {string} contentType - MIME тип
	 * @returns {Promise<string>}
	 */
	async presignedPutObject(bucketName, objectName, expiry, contentType) {
		try {
			const url = await this.publicClient.presignedPutObject(bucketName, objectName, expiry);
			this.logger.info(`Presigned PUT URL generated for ${bucketName}/${objectName}`);
			return this.applyPublicUploadUrlPathPrefix(url);
		} catch (error) {
			this.logger.error(`Failed to generate presigned PUT URL for ${objectName}:`, error.message);
			throw error;
		}
	}

	/**
	 * Копирование объекта
	 * @param {string} sourceBucket - Исходный бакет
	 * @param {string} sourceObject - Исходный объект
	 * @param {string} destBucket - Целевой бакет
	 * @param {string} destObject - Целевой объект
	 * @returns {Promise<boolean>}
	 */
	async copyObject(sourceBucket, sourceObject, destBucket, destObject) {
		try {
			const copySource = `/${sourceBucket}/${sourceObject}`;
			await this.client.copyObject(destBucket, destObject, copySource);
			this.logger.info(
				`Object copied successfully: ${sourceBucket}/${sourceObject} -> ${destBucket}/${destObject}`
			);
			return true;
		} catch (error) {
			this.logger.error(`Failed to copy object:`, error.message);
			throw error;
		}
	}

	/**
	 * Получение публичного URL объекта
	 * @param {string} bucketName - Имя бакета
	 * @param {string} objectName - Имя объекта
	 * @returns {Promise<string>}
	 */
	getPublicUrl(bucketName, objectName) {
		try {
			const protocol = config.minio.useSSL ? "https" : "http";
			const endpoint = config.minio.endPoint;
			const port = config.minio.port;

			// Формирование публичного URL
			const url = `${protocol}://${endpoint}:${port}/${bucketName}/${objectName}`;
			return url;
		} catch (error) {
			this.logger.error(`Failed to generate public URL for ${objectName}:`, error.message);
			throw error;
		}
	}

	async readDirTree(dirPath) {
		const files = [];

		const readDir = async currentPath => {
			try {
				const entries = await readdir(currentPath, { withFileTypes: true });

				await Promise.all(
					entries.map(async entry => {
						const fullPath = path.join(currentPath, entry.name);

						if (entry.isDirectory()) {
							await readDir(fullPath);
						} else if (entry.isFile()) {
							files.push(fullPath);
						}
					})
				);
			} catch (_error) {
				// Игнорируем ошибки
			}
		};
		await readDir(dirPath);
		return files;
	}
}

export { MinIOClient };
