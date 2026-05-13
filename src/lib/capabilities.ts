import fs from "fs";
import yaml from "js-yaml";
import path from "path";

type CapabilityRule = {
	roles?: string[];
	groups?: string[];
};

type CapabilityPolicyDocument = {
	capabilities?: Record<string, CapabilityRule>;
};

type UserLike = {
	roles?: string[] | null;
	groups?: string[] | null;
};

const DEFAULT_POLICY_FILE = "config/capabilities.yaml";

let cachedPolicyPath = "";
let cachedPolicyMtime = 0;
let cachedPolicy: CapabilityPolicyDocument = {};

function normalizeRule(rule?: CapabilityRule | null): CapabilityRule {
	return {
		roles: Array.isArray(rule?.roles) ? rule.roles : [],
		groups: Array.isArray(rule?.groups) ? rule.groups : [],
	};
}

function getPolicyFilePath() {
	const configuredPath = process.env.CAPABILITIES_FILE || DEFAULT_POLICY_FILE;
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

function loadPolicyFromYaml(filePath: string): CapabilityPolicyDocument {
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

	const document = parsed as CapabilityPolicyDocument;
	const capabilitySource =
		document.capabilities && typeof document.capabilities === "object" ? document.capabilities : {};

	return {
		capabilities: Object.entries(capabilitySource).reduce<Record<string, CapabilityRule>>(
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

export function getCapabilityPolicy() {
	return ensurePolicyLoaded().capabilities || {};
}

export function resolveCapabilities(user?: UserLike | null, keys?: string[] | null) {
	const roles = Array.isArray(user?.roles) ? user.roles : [];
	const groups = Array.isArray(user?.groups) ? user.groups : [];
	const keySet = Array.isArray(keys) && keys.length ? new Set(keys) : null;

	return Object.entries(getCapabilityPolicy())
		.filter(([capability]) => !keySet || keySet.has(capability))
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
