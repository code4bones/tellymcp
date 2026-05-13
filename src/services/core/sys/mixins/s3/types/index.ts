// ============================================
// ОБЩИЕ ТИПЫ
// ============================================

/**
 * Размер файла в байтах
 */
type FileSize = number;

/**
 * MIME тип файла
 */
type MimeType = string;

/**
 * Уникальный идентификатор загрузки
 */
type UploadId = string;

/**
 * Имя бакета в MinIO/S3
 */
type BucketName = string;

/**
 * Путь к объекту внутри бакета
 */
type ObjectPath = string;

/**
 * Уникальное имя файла
 */
type UniqueFilename = string;

/**
 * Оригинальное имя файла
 */
type OriginalFilename = string;

/**
 * Пресигнед URL для временного доступа
 */
type PresignedUrl = string;

/**
 * Публичный URL для прямого доступа
 */
type PublicUrl = string;

/**
 * Метаданные объекта S3
 */
interface S3Metadata {
	[key: string]: string;
}

/**
 * Статистика объекта S3
 */
interface S3ObjectStats {
	size: FileSize;
	etag: string;
	contentType: MimeType;
	lastModified: Date;
	versionId?: string;
}

/**
 * Информация об объекте
 */
interface S3Object {
	name: ObjectPath;
	size: FileSize;
	etag: string;
	lastModified: Date;
}

/**
 * Информация о бакете
 */
interface S3Bucket {
	name: BucketName;
	creationDate: Date;
}

// ============================================
// ТИПЫ ДЛЯ ФАЙЛОВ
// ============================================

/**
 * Файл, полученный через загрузку
 */
interface UploadedFile {
	fieldname: string;
	originalname: OriginalFilename;
	encoding: string;
	mimetype: MimeType;
	size: FileSize;
	buffer: Buffer;
	uniqueFilename: UniqueFilename;
}

/**
 * Результат загрузки файла
 */
interface UploadResult {
	success: boolean;
	bucketName: BucketName;
	objectName: ObjectPath;
	originalName: OriginalFilename;
	uniqueFilename: UniqueFilename;
	size: FileSize;
	mimeType: MimeType;
	publicUrl: PublicUrl;
	path: ObjectPath;
	uploadedAt: string;
}

/**
 * Результат множественной загрузки
 */
interface MultipleUploadResult {
	success: boolean;
	message: string;
	files: Array<UploadResult | { originalName: string; error: string }>;
	totalSize: FileSize;
	uploadedAt: string;
}

// ============================================
// ТИПЫ ДЛЯ ПРЕСИГНЕННЫХ URL
// ============================================

/**
 * Результат генерации пресигнед URL для загрузки
 */
interface PresignedUploadUrlResult {
	success: boolean;
	uploadUrl: PresignedUrl;
	downloadUrl: PresignedUrl;
	publicUrl: PublicUrl;
	bucket: BucketName;
	path: ObjectPath;
	filename: OriginalFilename;
	expiry: number;
	expiresAt: string;
	instructions: {
		method: "PUT";
		headers: Record<string, string>;
		example: string;
	};
}

/**
 * Результат генерации пресигнед URL для скачивания
 */
interface PresignedDownloadUrlResult {
	success: boolean;
	url: PresignedUrl;
	expiry: number;
	expiresAt: string;
}

// ============================================
// ТИПЫ ДЛЯ ЧАНКОВОЙ ЗАГРУЗКИ
// ============================================

/**
 * Результат инициации чанковой загрузки
 */
interface ChunkedUploadInitResult {
	success: boolean;
	uploadId: UploadId;
	filename: OriginalFilename;
	totalSize: FileSize;
	totalChunks: number;
	chunkSize: FileSize;
	bucket: BucketName;
	path: ObjectPath;
	message: string;
	instructions: string;
}

/**
 * Результат загрузки чанка
 */
interface ChunkUploadResult {
	success: boolean;
	uploadId: UploadId;
	chunkNumber: number;
	receivedChunks: number;
	totalChunks: number;
	progress: number;
	message: string;
}

/**
 * Результат завершения чанковой загрузки
 */
interface ChunkedUploadCompleteResult {
	success: boolean;
	uploadId: UploadId;
	bucket: BucketName;
	path: ObjectPath;
	filename: OriginalFilename;
	size: FileSize;
	publicUrl: PublicUrl;
	message: string;
	completedAt: string;
}

// ============================================
// ТИПЫ ДЛЯ СПИСКОВ И ПОИСКА
// ============================================

/**
 * Результат списка объектов
 */
interface ListObjectsResult {
	success: boolean;
	bucket: BucketName;
	prefix: string;
	count: number;
	files: S3Object[];
}

/**
 * Результат списка с поддержкой "псевдо-каталогов"
 */
interface ListObjectsWithDelimiterResult {
	success: boolean;
	bucket: BucketName;
	prefix: string;
	count: number;
	files: S3Object[];
	directories: string[]; // Общие префиксы (псевдо-каталоги)
}

/**
 * Результат списка бакетов
 */
interface ListBucketsResult {
	success: boolean;
	buckets: S3Bucket[];
}

// ============================================
// ТИПЫ ДЛЯ УПРАВЛЕНИЯ БАКЕТАМИ
// ============================================

/**
 * Результат создания бакета
 */
interface CreateBucketResult {
	success: boolean;
	bucketName: BucketName;
	region: string;
	message: string;
}

/**
 * Результат удаления бакета
 */
interface RemoveBucketResult {
	success: boolean;
	bucketName: BucketName;
	message: string;
}

/**
 * Результат проверки существования бакета
 */
interface BucketExistsResult {
	exists: boolean;
	bucketName: BucketName;
}

// ============================================
// ПАРАМЕТРЫ МЕТОДОВ СЕРВИСА UPLOAD
// ============================================

/**
 * Параметры для загрузки одного файла
 */
interface UploadSingleParams {
	files: UploadedFile[];
	fields?: Record<string, string>;
	bucket?: BucketName;
	path?: ObjectPath;
}

/**
 * Параметры для загрузки нескольких файлов
 */
interface UploadMultipleParams {
	files: UploadedFile[];
	fields?: Record<string, string>;
	bucket?: BucketName;
	path?: ObjectPath;
}

/**
 * Параметры для получения файла
 */
interface GetFileParams {
	bucket: BucketName;
	path: ObjectPath;
}

/**
 * Параметры для удаления файла
 */
interface DeleteFileParams {
	bucket: BucketName;
	path: ObjectPath;
}

/**
 * Параметры для получения статистики файла
 */
interface GetFileStatsParams {
	bucket: BucketName;
	path: ObjectPath;
}

/**
 * Параметры для генерации пресигнед URL скачивания
 */
interface GetPresignedUrlParams {
	bucket: BucketName;
	path: ObjectPath;
	expiry?: number; // в секундах
}

/**
 * Параметры для списка файлов
 */
interface ListFilesParams {
	bucket: BucketName;
	prefix?: string;
	recursive?: boolean;
}

// ============================================
// ПАРАМЕТРЫ МЕТОДОВ СЕРВИСА PRESIGNED-UPLOAD
// ============================================

/**
 * Параметры для генерации пресигнед URL загрузки
 */
interface GenerateUploadUrlParams {
	bucket: BucketName;
	path: ObjectPath;
	filename: OriginalFilename;
	expiry?: number; // в секундах
	contentType?: MimeType;
}

/**
 * Параметры для генерации нескольких пресигнед URL
 */
interface GenerateMultipleUploadUrlsParams {
	bucket: BucketName;
	path: ObjectPath;
	filenames: OriginalFilename[];
	expiry?: number;
}

// ============================================
// ПАРАМЕТРЫ МЕТОДОВ СЕРВИСА CHUNKED-UPLOAD
// ============================================

/**
 * Параметры для инициации чанковой загрузки
 */
interface InitiateUploadParams {
	filename: OriginalFilename;
	totalSize: FileSize;
	bucket?: BucketName;
	path?: ObjectPath;
	totalChunks: number;
}

/**
 * Параметры для загрузки чанка
 */
interface UploadChunkParams {
	uploadId: UploadId;
	chunkNumber: number;
	totalChunks: number;
	files: UploadedFile[];
}

/**
 * Параметры для завершения загрузки
 */
interface CompleteUploadParams {
	uploadId: UploadId;
}

/**
 * Параметры для отмены загрузки
 */
interface AbortUploadParams {
	uploadId: UploadId;
}

// ============================================
// ПАРАМЕТРЫ МЕТОДОВ СЕРВИСА MINIO
// ============================================

/**
 * Параметры для создания бакета
 */
interface CreateBucketParams {
	bucketName: BucketName;
	region?: string;
	objectLock?: boolean;
}

/**
 * Параметры для удаления бакета
 */
interface RemoveBucketParams {
	bucketName: BucketName;
}

/**
 * Параметры для проверки существования бакета
 */
interface BucketExistsParams {
	bucketName: BucketName;
}

/**
 * Параметры для загрузки объекта
 */
interface PutObjectParams {
	bucketName: BucketName;
	objectName: ObjectPath;
	Buffer;
	contentType?: MimeType;
	metadata?: S3Metadata;
}

/**
 * Параметры для получения объекта
 */
interface GetObjectParams {
	bucketName: BucketName;
	objectName: ObjectPath;
}

/**
 * Параметры для удаления объекта
 */
interface RemoveObjectParams {
	bucketName: BucketName;
	objectName: ObjectPath;
}

/**
 * Параметры для проверки существования объекта
 */
interface ObjectExistsParams {
	bucketName: BucketName;
	objectName: ObjectPath;
}

/**
 * Параметры для получения статистики объекта
 */
interface StatObjectParams {
	bucketName: BucketName;
	objectName: ObjectPath;
}

/**
 * Параметры для списка объектов
 */
interface ListObjectsParams {
	bucketName: BucketName;
	prefix?: string;
	recursive?: boolean;
}

/**
 * Параметры для пресигнед GET URL
 */
interface PresignedGetParams {
	bucketName: BucketName;
	objectName: ObjectPath;
	expiry?: number;
}

/**
 * Параметры для пресигнед PUT URL
 */
interface PresignedPutParams {
	bucketName: BucketName;
	objectName: ObjectPath;
	expiry?: number;
	contentType?: MimeType;
}

/**
 * Параметры для копирования объекта
 */
interface CopyObjectParams {
	sourceBucket: BucketName;
	sourceObject: ObjectPath;
	destBucket: BucketName;
	destObject: ObjectPath;
}

/**
 * Параметры для получения публичного URL
 */
interface GetPublicUrlParams {
	bucketName: BucketName;
	objectName: ObjectPath;
}
