import axios, { AxiosError } from "axios";
import { gql } from "@src/lib";
import { GQLSchema } from "@src/lib/moleculer";
import { refreshToken, requireActiveToken, kcOIDC, kcRealm } from "../api/mixins/session";

type PrincipalKind = "role" | "group" | "user";

type PrincipalItem = {
	kind: PrincipalKind;
	id: string;
	label: string;
	secondary?: string | null;
};

type PrincipalPage = {
	kind: PrincipalKind;
	search: string;
	first: number;
	max: number;
	hasMore: boolean;
	total?: number | null;
	items: PrincipalItem[];
};

const KC_ADMIN_CFG = {
	realm: process.env.KC_REALM || "",
	adminBase: `${process.env.KC_URI}/admin/realms/${process.env.KC_REALM}`,
	token: `${kcOIDC}/token`,
	clientId: process.env.KC_ADMIN_CLIENT_ID,
	clientSecret: process.env.KC_ADMIN_CLIENT_SECRET,
};

const PRINCIPAL_KINDS: PrincipalKind[] = ["role", "group", "user"];
const PAGE_DEFAULT = 10;
const PAGE_MAX = 50;
const TOKEN_SKEW_MS = 10_000;
const ROLES_CACHE_TTL_MS = 30_000;

const KcAdminService: GQLSchema = {
	name: "kcadmin",
	settings: {
		graphql: {
			type: gql`
				enum KCAdminPrincipalKind {
					role
					group
					user
				}

				type KCAdminPrincipalItem {
					kind: KCAdminPrincipalKind!
					id: String!
					label: String!
					secondary: String
				}

				type KCAdminPrincipalPage {
					kind: KCAdminPrincipalKind!
					search: String
					first: Int!
					max: Int!
					hasMore: Boolean!
					total: Int
					items: [KCAdminPrincipalItem!]!
				}
			`,
		},
	},
	hooks: {
		before: {
			"*": [refreshToken, requireActiveToken],
		},
	},
	created() {
		this.adminTokenCache = null;
		this.rolesCache = null;
	},
	actions: {
		principals: {
			params: {
				kind: { type: "enum", values: PRINCIPAL_KINDS },
				search: { type: "string", optional: true, convert: true },
				first: { type: "number", integer: true, optional: true, convert: true, min: 0 },
				max: {
					type: "number",
					integer: true,
					optional: true,
					convert: true,
					min: 1,
					max: PAGE_MAX,
				},
			},
			graphql: {
				query:
					"kcAdminPrincipals(kind:KCAdminPrincipalKind!,search:String,first:Int,max:Int):KCAdminPrincipalPage!",
			},
			handler(ctx): Promise<PrincipalPage> {
				this.assertAdminConfig();
				const kind = ctx.params.kind as PrincipalKind;
				const search = (ctx.params.search || "").trim();
				const { first, max } = this.normalizePage(ctx.params.first, ctx.params.max);

				switch (kind) {
					case "role":
						return this.searchRoles(search, first, max);
					case "group":
						return this.searchGroups(search, first, max);
					case "user":
						return this.searchUsers(search, first, max);
					default:
						throw new Error(`Unsupported principal kind: ${kind}`);
				}
			},
		},
	},
	methods: {
		assertAdminConfig() {
			if (!KC_ADMIN_CFG.clientId || !KC_ADMIN_CFG.clientSecret || !KC_ADMIN_CFG.realm) {
				throw new Error("Keycloak admin client is not configured");
			}
		},

		normalizePage(first?: number, max?: number) {
			const normalizedFirst = Number.isInteger(first) && first! >= 0 ? first! : 0;
			const normalizedMax =
				Number.isInteger(max) && max! > 0 ? Math.min(max!, PAGE_MAX) : PAGE_DEFAULT;
			return { first: normalizedFirst, max: normalizedMax };
		},

		async getAdminAccessToken(): Promise<string> {
			const cached = this.adminTokenCache;
			if (cached && cached.expiresAt > Date.now() + TOKEN_SKEW_MS) {
				return cached.accessToken;
			}

			const response = await axios.post(
				KC_ADMIN_CFG.token,
				new URLSearchParams({
					grant_type: "client_credentials",
					client_id: KC_ADMIN_CFG.clientId!,
					client_secret: KC_ADMIN_CFG.clientSecret!,
				}),
				{
					headers: { "Content-Type": "application/x-www-form-urlencoded" },
				}
			);

			this.adminTokenCache = {
				accessToken: response.data.access_token,
				expiresAt: Date.now() + (response.data.expires_in || 60) * 1000,
			};

			return this.adminTokenCache.accessToken;
		},

		async adminGet(path: string, params?: Record<string, any>) {
			const request = async () => {
				const accessToken = await this.getAdminAccessToken();
				return axios.get(`${KC_ADMIN_CFG.adminBase}${path}`, {
					headers: {
						Authorization: `Bearer ${accessToken}`,
					},
					params,
				});
			};

			try {
				return await request();
			} catch (error) {
				if (
					error instanceof AxiosError &&
					(error.response?.status === 401 || error.response?.status === 403)
				) {
					this.adminTokenCache = null;
					return request();
				}
				throw error;
			}
		},

		async adminCount(path: string, params?: Record<string, any>) {
			try {
				const response = await this.adminGet(path, params);
				return typeof response.data === "number" ? response.data : null;
			} catch {
				return null;
			}
		},

		buildPage(
			kind: PrincipalKind,
			search: string,
			first: number,
			max: number,
			items: PrincipalItem[],
			total?: number | null
		): PrincipalPage {
			return {
				kind,
				search,
				first,
				max,
				hasMore: total != null ? first + items.length < total : items.length > max,
				total: total ?? null,
				items: items.slice(0, max),
			};
		},

		async getRealmRoles() {
			const cached = this.rolesCache;
			if (cached && cached.expiresAt > Date.now()) {
				return cached.roles;
			}

			const response = await this.adminGet("/roles");
			const roles = Array.isArray(response.data) ? response.data : [];
			this.rolesCache = {
				roles,
				expiresAt: Date.now() + ROLES_CACHE_TTL_MS,
			};
			return roles;
		},

		async searchRoles(search: string, first: number, max: number): Promise<PrincipalPage> {
			const roles = await this.getRealmRoles();
			const searchLower = search.toLowerCase();
			const filtered = roles.filter(role => {
				if (!searchLower) return true;
				const haystack = [role.name, role.description].filter(Boolean).join(" ").toLowerCase();
				return haystack.includes(searchLower);
			});

			const items = filtered.slice(first, first + max).map(role => ({
				kind: "role" as const,
				id: role.name,
				label: role.name,
				secondary: role.description || null,
			}));

			return this.buildPage("role", search, first, max, items, filtered.length);
		},

		async searchGroups(search: string, first: number, max: number): Promise<PrincipalPage> {
			const requestMax = max + 1;
			const [response, total] = await Promise.all([
				this.adminGet("/groups", {
					search: search || undefined,
					first,
					max: requestMax,
					briefRepresentation: true,
				}),
				this.adminCount("/groups/count", {
					search: search || undefined,
				}),
			]);

			const groups = Array.isArray(response.data) ? response.data : [];
			const items = groups.map(group => ({
				kind: "group" as const,
				id: group.path || group.name,
				label: group.path || group.name,
				secondary: group.path && group.name && group.path !== group.name ? group.name : null,
			}));

			return this.buildPage("group", search, first, max, items, total);
		},

		async searchUsers(search: string, first: number, max: number): Promise<PrincipalPage> {
			const requestMax = max + 1;
			const [response, total] = await Promise.all([
				this.adminGet("/users", {
					search: search || undefined,
					first,
					max: requestMax,
					briefRepresentation: true,
				}),
				this.adminCount("/users/count", {
					search: search || undefined,
				}),
			]);

			const users = Array.isArray(response.data) ? response.data : [];
			const items = users.map(user => ({
				kind: "user" as const,
				id: user.id,
				label: user.username || user.email || user.id,
				secondary:
					[user.firstName, user.lastName].filter(Boolean).join(" ").trim() || user.email || null,
			}));

			return this.buildPage("user", search, first, max, items, total);
		},
	},
};

export default KcAdminService;
