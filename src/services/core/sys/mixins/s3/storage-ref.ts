const MINIO_REF_PREFIX = "minio";

export type MinioStorageRef = {
	kind: "minio";
	bucketName: string;
	objectName: string;
	raw: string;
};

export type LegacyStorageRef = {
	kind: "legacy";
	hash: string;
	raw: string;
};

export type StorageRef = MinioStorageRef | LegacyStorageRef;

export const formatMinioStorageRef = (bucketName: string, objectName: string) =>
	`${MINIO_REF_PREFIX}:${bucketName}:${Buffer.from(objectName, "utf8").toString("base64url")}`;

export const parseStorageRef = (value?: string | null): StorageRef | null => {
	if (!value) {
		return null;
	}

	if (!value.startsWith(`${MINIO_REF_PREFIX}:`)) {
		return {
			kind: "legacy",
			hash: value,
			raw: value,
		};
	}

	const [prefix, bucketName, ...rest] = value.split(":");
	if (prefix !== MINIO_REF_PREFIX || !bucketName || !rest.length) {
		return null;
	}

	try {
		const objectName = Buffer.from(rest.join(":"), "base64url").toString("utf8");
		if (!objectName) {
			return null;
		}

		return {
			kind: "minio",
			bucketName,
			objectName,
			raw: value,
		};
	} catch {
		return null;
	}
};

export const isMinioStorageRef = (value?: string | null) =>
	parseStorageRef(value)?.kind === "minio";
