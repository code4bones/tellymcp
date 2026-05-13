import fs from "fs";
import yaml from "js-yaml";
import path from "path";

type CapabilityRule = {
	roles?: string[];
	groups?: string[];
};

type CapabilityTree = {
	[key: string]: CapabilityRule | CapabilityTree | undefined;
};

type CapabilityPolicy = Record<string, CapabilityRule>;
type VfsUiConfig = {
	default_scope: string;
	scope_visible: boolean;
};
type UiConfig = {
	tree_toolbar: boolean;
	content_toolbar: boolean;
};
type VfsPolicyDocument = {
	vfs?: Partial<VfsUiConfig>;
	ui?: Partial<UiConfig>;
	capabilities?: CapabilityTree;
};

type UserLike = {
	roles?: string[] | null;
	groups?: string[] | null;
};

const DEFAULT_POLICY_FILE = "config/vfs-capabilities.yaml";

let cachedPolicyPath = "";
let cachedPolicyMtime = 0;
let cachedPolicy: VfsPolicyDocument = {};

function parseCsv(value?: string) {
	return String(value || "")
		.split(",")
		.map(item => item.trim())
		.filter(Boolean);
}

function normalizeRule(rule?: CapabilityRule | null): CapabilityRule {
	return {
		roles: Array.isArray(rule?.roles) ? rule.roles : [],
		groups: Array.isArray(rule?.groups) ? rule.groups : [],
	};
}

function isCapabilityRule(value: unknown): value is CapabilityRule {
	if (!value || typeof value !== "object") {
		return false;
	}

	const candidate = value as CapabilityRule;
	return Array.isArray(candidate.roles) || Array.isArray(candidate.groups);
}

function flattenCapabilities(source?: CapabilityTree | null, prefix = ""): CapabilityPolicy {
	if (!source || typeof source !== "object") {
		return {};
	}

	return Object.entries(source).reduce<CapabilityPolicy>((acc, [key, value]) => {
		if (!value || typeof value !== "object") {
			return acc;
		}

		const nextKey = prefix ? `${prefix}_${key}` : key;
		if (isCapabilityRule(value)) {
			acc[nextKey] = normalizeRule(value);
			return acc;
		}

		Object.assign(acc, flattenCapabilities(value as CapabilityTree, nextKey));
		return acc;
	}, {});
}

function normalizeUiConfig(config?: Partial<VfsUiConfig> | null): VfsUiConfig {
	return {
		default_scope:
			typeof config?.default_scope === "string" && config.default_scope.trim().length
				? config.default_scope.trim()
				: "fs",
		scope_visible: typeof config?.scope_visible === "boolean" ? config.scope_visible : true,
	};
}

function normalizeLayoutUiConfig(config?: Partial<UiConfig> | null): UiConfig {
	return {
		tree_toolbar: typeof config?.tree_toolbar === "boolean" ? config.tree_toolbar : true,
		content_toolbar: typeof config?.content_toolbar === "boolean" ? config.content_toolbar : true,
	};
}

function getPolicyFilePath() {
	const configuredPath = process.env.VFS_CAPABILITIES_FILE || DEFAULT_POLICY_FILE;
	const primaryPath = path.resolve(process.cwd(), configuredPath);
	if (fs.existsSync(primaryPath)) {
		return primaryPath;
	}

	const monorepoFallbackPath = path.resolve(process.cwd(), "back", configuredPath);
	if (fs.existsSync(monorepoFallbackPath)) {
		return monorepoFallbackPath;
	}

	return primaryPath;
}

function loadPolicyFromYaml(filePath: string): VfsPolicyDocument {
	if (!fs.existsSync(filePath)) {
		return {};
	}

	const source = fs.readFileSync(filePath, "utf8");
	if (!source.trim()) {
		return {};
	}

	const parsed = yaml.load(source);

	if (!parsed || typeof parsed !== "object") {
		return {};
	}

	const document = parsed as VfsPolicyDocument & Record<string, CapabilityRule | CapabilityTree>;
	const capabilitySource =
		document.capabilities && typeof document.capabilities === "object"
			? flattenCapabilities(document.capabilities)
			: Object.entries(document).reduce<CapabilityPolicy>((acc, [key, value]) => {
					if (key !== "vfs" && key !== "ui") {
						if (isCapabilityRule(value)) {
							acc[key] = normalizeRule(value);
							return acc;
						}
						Object.assign(acc, flattenCapabilities(value as CapabilityTree, key));
					}
					return acc;
				}, {});

	return {
		vfs: normalizeUiConfig(document.vfs),
		ui: normalizeLayoutUiConfig(document.ui),
		capabilities: Object.entries(capabilitySource).reduce<CapabilityPolicy>(
			(acc, [capability, rule]) => {
				acc[capability] = normalizeRule(rule);
				return acc;
			},
			{}
		),
	};
}

function ensurePolicyLoaded() {
	const filePath = getPolicyFilePath();

	try {
		const stat = fs.existsSync(filePath) ? fs.statSync(filePath) : null;
		const mtimeMs = stat?.mtimeMs || 0;

		if (cachedPolicyPath !== filePath || cachedPolicyMtime !== mtimeMs) {
			cachedPolicyPath = filePath;
			cachedPolicyMtime = mtimeMs;
			cachedPolicy = loadPolicyFromYaml(filePath);
		}
	} catch {
		cachedPolicyPath = filePath;
		cachedPolicyMtime = 0;
		cachedPolicy = {};
	}

	return cachedPolicy;
}

export function getVfsCapabilityPolicy() {
	const policy = ensurePolicyLoaded();
	return policy.capabilities || {};
}

export function getVfsUiConfig() {
	return normalizeUiConfig(ensurePolicyLoaded().vfs);
}

export function getVfsLayoutUiConfig() {
	return normalizeLayoutUiConfig(ensurePolicyLoaded().ui);
}

export function resolveVfsCapabilities(user?: UserLike | null) {
	const roles = Array.isArray(user?.roles) ? user.roles : [];
	const groups = Array.isArray(user?.groups) ? user.groups : [];
	const policy = getVfsCapabilityPolicy();

	return Object.entries(policy)
		.filter(([, rule]) => {
			const normalizedRule = normalizeRule(rule);
			const hasRole = normalizedRule.roles?.length
				? normalizedRule.roles.some(role => roles.includes(role))
				: false;
			const hasGroup = normalizedRule.groups?.length
				? normalizedRule.groups.some(group => groups.includes(group))
				: false;
			return hasRole || hasGroup;
		})
		.map(([capability]) => capability)
		.sort();
}

export function getVfsAdminCapabilities() {
	return parseCsv(process.env.VFS_ADMIN_CAPABILITIES);
}
