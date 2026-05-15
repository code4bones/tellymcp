import { DBMixin } from "@src/lib/mixins/db";
import { GQLContext, GQLSchema } from "@src/lib/moleculer";
import { gql } from "@src/lib";

const UIService: GQLSchema = {
	name: "ui",
	mixins: [DBMixin],
	settings: {
		graphql: {
			type: gql`
				input UIRouteEntryInput {
					route: String!
					authOnly: Boolean
				}
				input UIItemGrantedInput {
					item_ids: [String!]!
					scope: String
				}
				type UIItemGranted {
					granted: Boolean
					item_id: String
				}
			`,
		},
	},
	actions: {
		uiCheckAccess: {
			hooks: {
				before: [
					/*applySession*/
				],
			},
			graphql: {
				query: "uiWithAccess(id:String!):JSON",
			},
			handler(ctx) {
				const allowed = ctx.meta.user.roles.indexOf("telegram-manager") !== -1;
				console.log("ROLES", { allowed }, ctx.meta.user.roles);
				return { allowed };
			},
		},
		uiItemGranted: {
			graphql: {
				query: "uiItemGranted(check:UIItemGrantedInput!):[UIItemGranted!]!",
			},
			handler(ctx) {
				const {
					check: { item_ids, scope },
				} = ctx.params;
				return item_ids.map(item_id => ({ item_id, granted: true }));
			},
		},
		uiGetRoutesAccess: {
			graphql: {
				query: "uiGetRoutesAccess(routes:[UIRouteEntryInput!]!):JSON",
			},
			object_access: true,
			handler(ctx) {
				const { routes } = ctx.params;
				return Promise.all(
					routes.map(route => {
						return ctx.call("ui.uiCheckRouteAccess", route);
					})
				);
			},
		},
		uiCheckRouteAccess: {
			graphql: {
				query: "uiCheckRouteAccess(route:String!,authOnly:Boolean):JSON",
			},
			object_access: true,
			async handler(ctx) {
				const { route, authOnly = false } = ctx.params;
				const roles = process.env?.DEFAULT_COMPONENT_ACCESS_ROLES?.split(",") || [];
				const groups = process.env?.DEFAULT_COMPONENT_ACCESS_GROUPS?.split(",") || [];
				const found = [];
				const access = await this.db("accounting.oidc_route_access").where({ route }).first();
				/*
				if (!access) {
					await this.db("accounting.oidc_route_access").insert({
						route,
						enabled: false,
						info: `Доступ к ${route}`,
						groups: JSON.stringify(groups),
						roles: JSON.stringify(roles),
					});
					const arr = authAccessIntersection(ctx.meta.user, { groups, roles });
					found.push(...arr);
				} else if (!access.enabled) found.push(...[groups, roles]);
				else {
					const arr = authAccessIntersection(ctx.meta.user, access);
					found.push(...arr);
				}
				*/
				return { [route]: found.length > 0 || !authOnly, authOnly };
			},
		},
		uiCheckComponentAccess: {
			graphql: {
				query: "uiCheckComponentAccess(component:String!):JSON",
			},
			object_access: true,
			async handler(ctx: GQLContext<{ component: string }>) {
				const { component } = ctx.params;
				const roles = process.env?.DEFAULT_COMPONENT_ACCESS_ROLES?.split(",") || [];
				const groups = process.env?.DEFAULT_COMPONENT_ACCESS_GROUPS?.split(",") || [];
				const found = [];
				const access = await this.db("accounting.oidc_component_access")
					.where({ component })
					.first();
				if (!access) {
					await this.db("accounting.oidc_component_access").insert({
						component,
						groups: JSON.stringify(groups),
						roles: JSON.stringify(roles),
					});
					// const arr = authAccessIntersection(ctx.meta.user, { groups, roles });
					// found.push(...arr);
				} // else if (!access.enabled) found.push(...[groups, roles]);
				else {
					// const arr = authAccessIntersection(ctx.meta.user, access);
					// found.push(...arr);
				}
				return { [component]: found.length > 0 };
			},
		},
	},
};

export default UIService;
