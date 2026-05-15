import _ from "lodash";
import settingsEvents, {
	SettingsEvents,
} from "@src/services/core/sys/mixins/events/settingsEvents";
import { DBMixin } from "@src/lib/mixins/db";
import { gql } from "@src/lib";
import { GQLSchema } from "@src/lib/moleculer";

const sysService: GQLSchema = {
	name: "settings",
	mixins: [DBMixin, settingsEvents],
	hooks: {
		before: {
			"*": ["withObjectAccess", "withObjectVisible"],
		},
	},
	settings: {
		graphql: {
			type: gql`
				"""
				Узел настроек
				"""
				type SettingsEntry {
					"""
					Уникальный идентификатор
					"""
					settings_id: Int!
					"""
					Родительская запись
					"""
					settings_parent_id: Int
					"""
					UI: Наименование настройки
					"""
					settings_title: String!
					"""
					UI: Комментарий к настроке
					"""
					settings_comment: String
					"""
					Область хранения настроек
					"""
					settings_scope: String!
					"""
					REST: альяс для получения настроек по /settings?alias=
					"""
					settings_alias: String
					"""
					Свободный JSON обьект с данными настройки
					"""
					settings_data: JSON
					"""
					Потомки
					"""
					childs: [SettingsEntry!]
					"""
					UI: Количество потомков
					"""
					has_childs: Int
				}

				input SettingsEntryInput {
					settings_parent_id: Int
					settings_title: String!
					settings_data: JSON
					settings_comment: String
					settings_scope: String
					settings_alias: String
				}

				input SettingsUpdateInput {
					settings_id: Int!
					settings_parent_id: Int
					settings_title: String
					settings_data: JSON
					settings_comment: String
					settings_scope: String
					settings_alias: String
				}

				input SettingsCommonQueryInput {
					queryName: String!
					dataView: DataViewInput
				}

				enum SettingsCommonMutationAction {
					create
					update
					delete
				}

				input SettingsCommonMutationInput {
					queryName: String!
					action: SettingsCommonMutationAction!
					"""
					Критерии для update/delete
					"""
					record: JSON
					"""
					Набор данных
					"""
					payload: JSON
				}
			`,
			resolvers: {
				SettingsEntry: {
					childs: {
						action: "settings.getChildEntries",
						rootParams: {
							settings_id: "settings_id",
						},
					},
				},
			},
		},
	},
	actions: {
		getTableColumnAttrs: {
			graphql: {
				query: "settingsGetTableColumnAttrs(table:String!):JSON",
			},
			handler(ctx) {
				const [schema, table] = (ctx.params.table as string).split(".");
				return this.db
					.raw(`select * from storage.f_get_table_column_attrs(?,?)`, [schema, table])
					.then(({ rows }) => rows)
					.then(([r]) => r.f_get_table_column_attrs);
			},
		},

		adSettingsWrite: {
			graphql: {
				mutation: "settingsWrite(entry:SettingsEntryInput!):SettingsEntry!",
			},
			object_access: true,
			handler(ctx) {
				const {
					entry: { settings_data, ...rest },
				} = ctx.params;
				return this.db("storage.t_settings_tree")
					.insert({
						settings_data: JSON.stringify(settings_data),
						...rest,
					})
					.returning("*")
					.then(([e]) => e)
					.then(data => {
						this.settingsChanged(ctx, null, {
							event: "write",
							data,
						});
						return data;
					});
			},
		},
		adSettingsTree: {
			graphql: {
				query: "settingsTree(parent_settings_key:String,scope:String):JSON",
			},
			handler(ctx) {
				const { parent_settings_key, scope = "default" } = ctx.params;
				return this.db
					.raw(`select * from storage.f_settings_get_tree(?,?) as settings`, [
						parent_settings_key || null,
						scope,
					])
					.then(({ rows }) => rows)
					.then(([data]) => {
						return data.settings;
					});
			},
		},
		// https://collectoradald.codup.pro/api/settings/adQuerySettingsValue
		// https://collectoradald.codup.pro/api/settings/get?id=5&token=0123456
		adQuerySettingsValue: {
			rest: {
				path: "/get",
				method: "GET",
			},
			params: {
				scope: { type: "string", optional: true, default: "default" },
				alias: { type: "string", optional: true },
				id: { type: "string", optional: true },
				token: { type: "string", optional: true },
			},
			handler(ctx) {
				const { alias, scope, id } = ctx.params;
				if (!alias && !id)
					throw new Error("Укажите либо идентификатор настройки(?id=), либо ее (?alias=)");
				return this.db("storage.t_settings_tree")
					.where(function () {
						if (id) this.where({ settings_id: id });
						else if (alias) this.where({ settings_alias: alias, settings_scope: scope });
					})
					.first()
					.then(res => {
						if (!res) throw new Error("Нет данных");
						return res;
					})
					.then(({ settings_data }) => settings_data)
					.then(data => {
						console.log(">>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>", data);
						this.logger.warn("Sending data", data);
						return data;
					});
			},
		},
		adSettingsRead: {
			graphql: {
				query: "settingsRead(settings_id:Int,scope:String):SettingsEntry!",
			},
			handler(ctx) {
				return this.db("storage.v_settings_tree")
					.where(function () {
						if (ctx.params.settings_id) this.where(ctx.params);
						if (ctx.params.scope) {
							this.where({ settings_scope: ctx.params.scope });
							this.andWhere({ settings_parent_id: null });
						}
					})
					.first();
			},
		},
		adSettings: {
			graphql: {
				query: "settings(settings_parent_id:Int,scope:String):[SettingsEntry!]",
			},
			handler(ctx) {
				const { settings_parent_id, scope } = ctx.params;
				return this.db("storage.v_settings_tree").where(function () {
					if ("scope" in ctx.params) this.where({ settings_scope: scope });
					if ("settings_parent_id" in ctx.params) {
						this.where({ settings_parent_id });
					}
				});
			},
		},
		adSettingsUpdate: {
			graphql: {
				mutation: "settingsUpdate(entry:SettingsUpdateInput!):SettingsEntry!",
			},
			handler(ctx) {
				const {
					entry: { settings_id, settings_data, ...rest },
				} = ctx.params;
				if (settings_data) rest.settings_data = JSON.stringify(settings_data);
				return this.db("storage.t_settings_tree")
					.update(rest)
					.where({ settings_id })
					.returning("*")
					.then(([res]) => res)
					.then(data => {
						this.settingsChanged(ctx, null, {
							event: "update",
							data,
						});
						return data;
					});
			},
		},
		adSettingsDelete: {
			graphql: {
				mutation: "settingsDelete(settings_ids:[Int!]!):[SettingsEntry!]!",
			},
			handler(ctx) {
				const { settings_ids } = ctx.params;
				return this.db("storage.t_settings_tree")
					.delete()
					.whereIn("settings_id", settings_ids)
					.returning("*")
					.then(data => {
						this.settingsChanged(ctx, null, {
							event: "delete",
							data,
						});
						return data;
					});
			},
		},
		getChildEntries: {
			object_access: false,
			handler(ctx) {
				const { settings_id } = ctx.params;
				return this.db("storage.t_settings_tree").where({
					settings_parent_id: settings_id,
				});
			},
		},
		adCommonQuery: {
			graphql: {
				query: "settingsCommonQuery(args:SettingsCommonQueryInput!):JSON",
			},
			async handler(ctx) {
				const { queryName, dataView } = ctx.params.args;
				const table = await this.db("storage.t_settings_query_map")
					.where({ query: queryName })
					.first();
				if (!table) throw new Error(`Соотношение настроек не найдено: ${queryName}`);
				const columns: [any] = await ctx.call(
					"settings.getTableColumnAttrs",
					{
						table: table.table_name,
					},
					{ meta: { local: true } }
				);
				const drills = await this.db("storage.t_settings_query_drill").where({
					source_query: queryName,
				});
				const rd = _.reduce(
					columns,
					(agg, col) => {
						const { column } = col;
						const dr = _.find(drills, { key_field: column });
						if (dr) {
							const { ui, target_query: query, target_field: filter_by } = dr;
							return [...agg, { ...col, drill: { query, filter_by, ui } }];
						}
						return [...agg, col];
					},
					[]
				);
				return this.db(table.table_name)
					.dataView(dataView)
					.then(res => {
						return {
							columns: rd,
							...res,
						};
					});
			},
		},
		settingsCommonMutation: {
			graphql: {
				mutation: "settingsCommonWrite(args:SettingsCommonMutationInput!):JSON",
			},
			async handler(ctx) {
				const { queryName, action, record: where, payload } = ctx.params.args;
				const table = await this.db("storage.t_settings_query_map")
					.where({ query: queryName })
					.first();
				if (!table) throw new Error(`Соотношение настроек не найдено: ${queryName}`);
				const query = this.db(table.table_name);
				if (action === "create") query.insert(payload);
				if (action === "update") query.update(payload).where(where);
				if (action === "delete") query.delete().where(where);
				return query
					.returning("*")
					.then(([res]) => res)
					.then(data => {
						this.settingsChanged(ctx, null, {
							event: "common_write",
							action,
							queryName,
							data,
						});
						return data;
					});
			},
		},
		settingsUpdateQueryMap: {
			graphql: {
				mutation: "settingsUpdateQueryMap(query:String!,table_name:String!,read_only:Boolean):JSON",
			},
			handler(ctx) {
				return this.db("storage.t_settings_query_map")
					.insert(ctx.params)
					.onConflict(["query", "table_name"])
					.merge()
					.returning("*")
					.then(([res]) => res)
					.then(data => {
						this.settingsChanged(ctx, null, {
							event: "query_map",
							data,
						});
						return data;
					});
			},
		},
		settingsQueryMap: {
			graphql: {
				query: "settingQueryMap(dataView:DataViewInput):JSON",
			},
			handler(ctx) {
				return this.db("storage.t_settings_query_map").dataView(ctx.params.dataView);
			},
		},
		onSettingsChanged: {
			graphql: {
				subscription: "settingsChanged:JSON",
				tags: [SettingsEvents.settingsChanged],
			},
			handler(ctx) {
				return ctx.params;
			},
		},
	},
};

export default sysService;
