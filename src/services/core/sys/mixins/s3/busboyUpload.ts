import Busboy from "busboy";
import path from "path";
import crypto from "crypto";

const parsePositiveInt = (value: string | undefined, fallback: number) => {
	const parsed = Number.parseInt(String(value || "").trim(), 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const config = {
	upload: {
		maxFileSize: parsePositiveInt(process.env.MULTIPART_UPLOAD_MAX_FILE_SIZE, 5 * 1024 * 1024 * 1024), // 5 GB
		maxFiles: parsePositiveInt(process.env.MULTIPART_UPLOAD_MAX_FILES, 200),
		storage: "memory", // 'memory' или 'disk'
		uploadDir: "./uploads/tmp",
	},
};

/**
 * Генерация уникального имени файла
 */
function sanitizeObjectNamePart(value: string) {
	const cleaned = Array.from(value)
		.filter(char => {
			const code = char.charCodeAt(0);
			return (code >= 32 && code !== 127) || char === "\n" || char === "\r" || char === "\t";
		})
		.join("");

	return (
		cleaned
			.replace(/[\\/]+/g, "_")
			.replace(/\s+/g, " ")
			.trim()
			.slice(0, 180) || "file"
	);
}

function normalizeFilename(value: string) {
	if (!value) {
		return "file";
	}

	try {
		const restored = Buffer.from(value, "latin1").toString("utf8");
		if (restored.includes("\uFFFD")) {
			return value;
		}
		return restored;
	} catch {
		return value;
	}
}

function generateUniqueFilename(originalName: string) {
	const timestamp = Date.now();
	const randomString = crypto.randomBytes(8).toString("hex");
	const ext = path.extname(originalName).toLowerCase();
	const name = path.basename(originalName, ext);
	const safeName = sanitizeObjectNamePart(name);

	return `${safeName}_${timestamp}_${randomString}${ext}`;
}

/**
 * Форматирование размера файла
 */
function formatFileSize(bytes) {
	if (bytes === 0) return "0 Bytes";
	const k = 1024;
	const sizes = ["Bytes", "KB", "MB", "GB"];
	const i = Math.floor(Math.log(bytes) / Math.log(k));
	return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + " " + sizes[i];
}

/**
 * Основное middleware для обработки загрузки
 */
function uploadMiddleware(ctx) {
	if (Array.isArray(ctx.params?.files) && ctx.params.files.length > 0) {
		return Promise.resolve(ctx);
	}

	const req = ctx.meta.$request;
	if (!req?.headers) {
		return Promise.resolve(ctx);
	}

	// Проверка типа контента
	const contentType = req.headers["content-type"] || "";

	if (!contentType.includes("multipart/form-data")) {
		return Promise.resolve(ctx);
	}

	return new Promise((resolve, reject) => {
		const busboy = Busboy({
			headers: req.headers,
			limits: {
				fileSize: config.upload.maxFileSize,
				files: config.upload.maxFiles,
			},
		});

		const fields = {};
		const files = [];

		// Обработка полей формы
		busboy.on("field", (fieldname, val) => {
			fields[fieldname] = val;
		});

		// Обработка файлов
		busboy.on("file", (fieldname, file, { filename, encoding, mimeType }) => {
			const normalizedFilename = normalizeFilename(filename);
			// Сборка данных файла в буфер
			const chunks = [];
			let fileSize = 0;

			file.on("data", chunk => {
				chunks.push(chunk);
				fileSize += chunk.length;

				// Проверка размера в реальном времени
				if (fileSize > config.upload.maxFileSize) {
					file.resume();
					ctx.meta.$statusCode = 413;
					reject(
						new Error(`File size exceeds limit: ${formatFileSize(config.upload.maxFileSize)}`)
					);
				}
			});

			file.on("end", () => {
				const buffer = Buffer.concat(chunks);

				files.push({
					fieldname: fieldname,
					originalname: normalizedFilename,
					encoding: encoding,
					mimetype: mimeType,
					size: fileSize,
					buffer: buffer,
					uniqueFilename: generateUniqueFilename(normalizedFilename),
				});
				ctx.service.logger.info(
					`File received: ${normalizedFilename} (${formatFileSize(fileSize)})`
				);
			});

			file.on("error", error => {
				ctx.service.logger.error("File upload error:", error);
				reject(error);
			});
		});

		// Завершение обработки
		busboy.on("finish", () => {
			try {
				// Добавление файлов и полей в контекст
				(ctx.params as any).files = files;
				(ctx.params as any).fields = fields;

				// Вызов следующего middleware или обработчика
				// const result = await handler(ctx);
				resolve(ctx);
			} catch (error) {
				reject(error);
			}
		});

		busboy.on("error", error => {
			ctx.service.logger.error("Busboy error:", error);
			reject(error);
		});

		// Проверка на наличие файлов
		busboy.on("partsLimit", () => {
			ctx.meta.$statusCode = 413;
			reject(new Error(`Too many parts. Maximum is ${config.upload.maxFiles}`));
		});

		busboy.on("filesLimit", () => {
			ctx.meta.$statusCode = 413;
			reject(new Error(`Too many files. Maximum is ${config.upload.maxFiles}`));
		});

		busboy.on("fieldsLimit", () => {
			ctx.meta.$statusCode = 413;
			reject(new Error("Too many fields"));
		});

		// Запуск обработки
		if (req.pipe) {
			req.pipe(busboy);
		} else {
			reject(new Error("Request body is not a stream"));
		}
	});
}

export { uploadMiddleware };
