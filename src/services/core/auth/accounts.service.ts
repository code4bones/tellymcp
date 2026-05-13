import { GQLSchema } from "@src/lib/moleculer";
import schema from "./mixins/schema";
import { refreshToken, requireActiveToken } from "../api/mixins/session";
import {
	getVfsLayoutUiConfig,
	getVfsUiConfig,
	resolveVfsCapabilities,
} from "@src/lib/vfsCapabilities";
import { resolveCapabilities } from "@src/lib/capabilities";

const AccountsService: GQLSchema = {
	name: "accounts",
	mixins: [schema],
	/**
	 * Settings
	 */
	settings: {},

	/**
	 * Dependencies
	 */
	dependencies: [],

	hooks: {
		before: {
			"*": [refreshToken, requireActiveToken],
		},
	},

	actions: {
		me: {
			graphql: {
				query: "me:User",
			},
			handler(ctx) {
				const sessionUser = ctx.meta.$session?.user;
				if (!sessionUser) {
					return null;
				}

				return {
					...sessionUser,
					sid: sessionUser.sid || ctx.meta.$request?.sessionID || ctx.meta.$sessionID || null,
				};
			},
		},

		sessionInfo: {
			hooks: {
				before: [requireActiveToken],
			},
			graphql: {
				query: "sessionInfo:JSON",
			},
			handler(ctx) {
				return ctx.call("kcauth.sessioninfo");
			},
		},
		vfsUiConfig: {
			graphql: {
				query: "vfsUiConfig:VFSUIConfig!",
			},
			handler(ctx) {
				const vfs = getVfsUiConfig();
				const ui = getVfsLayoutUiConfig();
				return {
					default_scope: vfs.default_scope,
					scope_visible: vfs.scope_visible,
					tree_toolbar: ui.tree_toolbar,
					content_toolbar: ui.content_toolbar,
					capabilities: resolveVfsCapabilities(ctx.meta.user),
				};
			},
		},
		viewerCapabilities: {
			graphql: {
				query: "viewerCapabilities(keys:[String!]): [String!]!",
			},
			params: {
				keys: {
					type: "array",
					items: "string",
					optional: true,
				},
			},
			handler(ctx) {
				const keys =
					Array.isArray(ctx.params.keys) && ctx.params.keys.length > 0
						? ctx.params.keys
						: undefined;
				return resolveCapabilities(ctx.meta.user, keys);
			},
		},

		wipeExpired: {
			handler(ctx) {},
		},
	},

	/**
	 * Methods
	 */
	methods: {},
};

export default AccountsService;
