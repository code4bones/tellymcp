import mime from "mime-types";

type S3CommanderRow = Record<string, unknown>;
type S3CommanderTreeNode = {
	kind: "bucket" | "prefix" | "object";
	name: string;
	prefix: string;
	objectName: string | null;
	children: S3CommanderTreeNode[];
};

type S3CommanderBrowseItem = {
	key: string;
	name: string;
	kind: "prefix" | "object";
	bucketName: string;
	objectName: string;
	size: "dir" | number | null;
	modifiedAt: string | null;
	contentType?: string | false | null;
};

const getS3CommanderRowString = (row: S3CommanderRow, key: string): string | null => {
	const value = row[key];
	return typeof value === "string" ? value : null;
};

const getS3CommanderRowNumber = (row: S3CommanderRow, key: string): number | null => {
	const value = row[key];
	return typeof value === "number" ? value : null;
};

const getS3CommanderRowDate = (row: S3CommanderRow, key: string): Date | null => {
	const value = row[key];
	return value instanceof Date ? value : null;
};

const getS3CommanderRowContentType = (row: S3CommanderRow): string | null => {
	const metaData = row.metaData;
	if (!metaData || typeof metaData !== "object") {
		return null;
	}
	const value = (metaData as Record<string, unknown>)["content-type"];
	return typeof value === "string" ? value : null;
};

export const buildS3CommanderBucketItems = (
	buckets: Array<{ name: string; creationDate?: Date | string | null }>
) =>
	buckets
		.map(bucketRow => ({
			key: `bucket:${bucketRow.name}`,
			name: bucketRow.name,
			kind: "bucket",
			bucketName: bucketRow.name,
			objectName: "",
			size: "bucket",
			modifiedAt:
				bucketRow.creationDate instanceof Date
					? bucketRow.creationDate.toISOString()
					: bucketRow.creationDate || null,
		}))
		.sort((left, right) => left.name.localeCompare(right.name));

export const buildS3CommanderBrowseItems = (
	bucket: string,
	rows: S3CommanderRow[],
	isDirectoryMarker: (objectName: string) => boolean
) =>
	rows
		.map<S3CommanderBrowseItem | null>(entry => {
			const prefixName = getS3CommanderRowString(entry, "prefix");
			if (prefixName) {
				const normalizedPrefix = String(prefixName);
				const trimmed = normalizedPrefix.endsWith("/")
					? normalizedPrefix.slice(0, -1)
					: normalizedPrefix;
				const name = trimmed.split("/").filter(Boolean).pop() || normalizedPrefix;
				return {
					key: `prefix:${normalizedPrefix}`,
					name: `${name}/`,
					kind: "prefix",
					bucketName: bucket,
					objectName: normalizedPrefix,
					size: "dir",
					modifiedAt: null,
				};
			}

			const objectName = getS3CommanderRowString(entry, "name") || "";
			if (isDirectoryMarker(objectName)) {
				return null;
			}
			const name = objectName.split("/").filter(Boolean).pop() || objectName;
			return {
				key: `object:${objectName}`,
				name,
				kind: "object",
				bucketName: bucket,
				objectName,
				contentType: getS3CommanderRowContentType(entry) || mime.lookup(objectName) || null,
				size: getS3CommanderRowNumber(entry, "size"),
				modifiedAt: getS3CommanderRowDate(entry, "lastModified")?.toISOString() || null,
			};
		})
		.filter((entry): entry is S3CommanderBrowseItem => entry !== null)
		.sort((left, right) => {
			if (left.kind !== right.kind) {
				return left.kind === "prefix" ? -1 : 1;
			}
			return left.name.localeCompare(right.name);
		});

export const calculateS3CommanderPrefixSizeStats = (
	rows: S3CommanderRow[],
	prefix: string,
	isDirectoryMarker: (objectName: string) => boolean
) => {
	let totalBytes = 0;
	let objectCount = 0;
	const directories = new Set<string>();

	for (const row of rows) {
		const objectName = (getS3CommanderRowString(row, "name") || "").trim();
		if (!objectName) {
			continue;
		}
		const relativeSource =
			prefix && objectName.startsWith(prefix) ? objectName.slice(prefix.length) : objectName;
		const parts = relativeSource.split("/").filter(Boolean);
		const lastPart = parts[parts.length - 1] || "";
		for (let index = 0; index < parts.length - 1; index += 1) {
			directories.add(parts.slice(0, index + 1).join("/"));
		}
		if (isDirectoryMarker(lastPart)) {
			continue;
		}
		totalBytes += getS3CommanderRowNumber(row, "size") || 0;
		objectCount += 1;
	}

	return {
		totalBytes,
		objectCount,
		directoryCount: directories.size,
		itemCount: objectCount + directories.size,
	};
};

export const buildS3CommanderPrefixTreeFromRows = (
	bucket: string,
	prefix: string,
	rows: S3CommanderRow[],
	normalizePrefix: (value: string) => string,
	isDirectoryMarker: (objectName: string) => boolean
) => {
	const createNode = (
		kind: "bucket" | "prefix" | "object",
		name: string,
		fullPrefix: string,
		objectName: string | null = null
	): S3CommanderTreeNode => ({
		kind,
		name,
		prefix: fullPrefix,
		objectName,
		children: [],
	});

	const rootName = prefix
		? prefix.replace(/\/$/, "").split("/").filter(Boolean).pop() || bucket
		: bucket;
	const rootPrefix = prefix;
	const root = createNode(prefix ? "prefix" : "bucket", rootName, rootPrefix, prefix || null);
	const byPrefix = new Map<string, S3CommanderTreeNode>([[rootPrefix, root]]);

	const ensurePrefixNode = (currentPrefix: string): S3CommanderTreeNode => {
		const normalizedPrefix = normalizePrefix(currentPrefix);
		const existingNode = byPrefix.get(normalizedPrefix);
		if (existingNode) {
			return existingNode;
		}
		const trimmed = normalizedPrefix.replace(/\/$/, "");
		const name = trimmed.split("/").filter(Boolean).pop() || bucket;
		const parentTrimmed = trimmed.split("/").slice(0, -1).join("/");
		let parentPrefix = parentTrimmed ? `${parentTrimmed}/` : "";
		if (rootPrefix && normalizedPrefix !== rootPrefix) {
			parentPrefix = parentPrefix.startsWith(rootPrefix) ? parentPrefix : rootPrefix;
		}
		const parentNode = ensurePrefixNode(parentPrefix);
		const node = createNode("prefix", name, normalizedPrefix, normalizedPrefix);
		byPrefix.set(normalizedPrefix, node);
		parentNode.children.push(node);
		return node;
	};

	for (const row of rows) {
		const objectName = (getS3CommanderRowString(row, "name") || "").trim();
		if (!objectName) {
			continue;
		}

		const relativeSource =
			prefix && objectName.startsWith(prefix) ? objectName.slice(prefix.length) : objectName;
		const parts = relativeSource.split("/").filter(Boolean);
		if (!parts.length) {
			continue;
		}

		for (let index = 0; index < parts.length - 1; index += 1) {
			const subPrefix = `${prefix}${parts.slice(0, index + 1).join("/")}/`;
			ensurePrefixNode(subPrefix);
		}

		const lastPart = parts[parts.length - 1] || "";
		if (isDirectoryMarker(lastPart)) {
			if (parts.length > 1) {
				ensurePrefixNode(`${prefix}${parts.slice(0, -1).join("/")}/`);
			}
			continue;
		}

		const parentPrefix =
			parts.length > 1 ? `${prefix}${parts.slice(0, -1).join("/")}/` : rootPrefix;
		const parentNode = ensurePrefixNode(parentPrefix);
		parentNode.children.push(
			createNode("object", lastPart, parentPrefix, `${prefix}${parts.join("/")}`)
		);
	}

	const kindOrder = {
		bucket: 0,
		prefix: 1,
		object: 2,
	};
	const sortTree = (node: S3CommanderTreeNode) => {
		node.children.sort((left: S3CommanderTreeNode, right: S3CommanderTreeNode) => {
			const leftOrder = kindOrder[String(left?.kind || "object") as keyof typeof kindOrder] ?? 9;
			const rightOrder = kindOrder[String(right?.kind || "object") as keyof typeof kindOrder] ?? 9;
			if (leftOrder !== rightOrder) {
				return leftOrder - rightOrder;
			}
			return String(left.name || "").localeCompare(String(right.name || ""));
		});
		node.children.forEach(sortTree);
		return node;
	};

	return sortTree(root);
};
