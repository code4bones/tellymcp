import _ from "lodash";
import crudEvents, { CRUDEvents } from "@src/services/core/sys/mixins/events/crudEvents";
import { Context } from "moleculer";
import { DBMixin } from "@src/lib/mixins/db";
import { GQLSchema } from "@src/lib/moleculer";
import { gql } from "@src/lib";

const CRUDService: GQLSchema = {
	name: "crud",
	mixins: [DBMixin, crudEvents],
	hooks: {
		before: {
			"crud*": ["withObjectAccess", "withTableAccess"],
		},
	},
	settings: {
		graphql: {
			type: gql`
				enum CommonCRUDMergeMode {
					ignore
					merge
				}

				input CommonCRUDOnConflict {
					keys: [String!]!
					do: CommonCRUDMergeMode
				}

				input CommonCRUDInsertInput {
					table: String!
					rows: JSON!
					conflict: CommonCRUDMergeMode
				}

				input CommonCRUDDeleteInput {
					table: String!
					where: JSON
				}

				input CommonCRUDUpdateInput {
					table: String!
					rows: JSON!
					where: JSON
				}

				input CommonCRUDSelectInput {
					table: String!
					where: String
					columns: [String!]
					dataView: DataViewInput
				}
				type CRUDColumnDef {
					type: String!
					title: String!
					column: String
				}
				type CRUDSelect {
					columns: [CRUDColumnDef!]
					items: JSON
					pagination: DataViewPagination
				}
				type CRUDAllowedTable {
					name: String!
					table_name: String!
					title: String
					enabled: Boolean
					keys: [String!]!
				}
			`,
		},
	},
	actions: {
		allowedTables: {
			graphql: {
				query: "crudAllowedTables:[CRUDAllowedTable!]!",
			},
			object_access: true,
			handler(ctx) {
				return this.db("accounting.t_crud_allowed_tables").select("*").orderBy("name", "asc");
			},
		},
		crudInsertRecord: {
			graphql: {
				mutation: "crudInsertRecord(record:CommonCRUDInsertInput!):JSON",
			},
			object_access: true,
			handler(ctx) {
				const {
					record: { rows, table, conflict },
				} = ctx.params;
				const query = this.db(table).insert(rows);
				if (conflict) {
					const conf = query.onConflict(conflict.keys);
					if (conflict.do === "merge") conf.merge();
					else conf.ignore();
				}
				return query.returning("*").then(data => {
					this.tableDataChanged(ctx, null, {
						event: "insert",
						table,
						data,
					});
					return data;
				});
			},
		},
		crudDeleteRecord: {
			graphql: {
				mutation: "crudDeleteRecord(record:CommonCRUDDeleteInput!):JSON",
			},
			object_access: true,
			handler(ctx) {
				const {
					record: { table, where },
				} = ctx.params;
				return this.db(table)
					.delete()
					.where(function () {
						if (where) {
							if (_.isArray(where)) where.forEach(f => this.orWhere(f));
							else this.where(where);
						}
					})
					.returning("*")
					.then(data => {
						this.tableDataChanged(ctx, null, {
							event: "delete",
							table,
							data,
						});
						return data;
					});
			},
		},
		crudUpdateRecord: {
			graphql: {
				mutation: "crudUpdateRecord(record:CommonCRUDUpdateInput!):JSON",
			},
			object_access: true,
			handler(ctx) {
				const {
					record: { table, rows, where },
				} = ctx.params;
				return this.db(table)
					.update(rows)
					.where(function () {
						if (where) {
							this.where(where);
						}
					})
					.returning("*")
					.then(data => {
						this.tableDataChanged(ctx, null, {
							event: "update",
							table,
							data,
						});
						return data;
					});
			},
		},
		crudSelect: {
			graphql: {
				query: "crudSelect(what:CommonCRUDSelectInput!):CRUDSelect!",
			},
			object_access: true,
			async handler(ctx) {
				const {
					what: { where, table, dataView, columns = "*" },
				} = ctx.params;
				const [schema, tbl] = (table as string).split(".");
				const cols = await this.db
					.raw(`select * from storage.f_get_table_column_attrs(?,?)`, [schema, tbl])
					.then(({ rows }) => rows)
					.then(([r]) => r.f_get_table_column_attrs);

				/*
				this.db
					.with("flt", this.db.raw(`select * from ${table} where ${sqlFilter}`))
					.select(columns)
					.from("flt")
				*/
				return this.db(table)
					.select(columns)
					.where(function () {
						if (where) this.whereRaw(where);
					})
					.dataView(dataView)
					.then(data => {
						return {
							columns: cols,
							...data,
						};
					});
			},
		},
		onTableChanged: {
			graphql: {
				subscription: "crudDataChanged:JSON",
				tags: [CRUDEvents.tableDataChanged],
			},
			handler(ctx) {
				return ctx.params;
			},
		},
	},
	methods: {
		async withTableAccess(ctx: Context<any>) {
			const name = ctx.params.record?.table || ctx.params.what?.table;
			const row = await this.db("accounting.t_crud_allowed_tables")
				.where({ name })
				.orWhere({ table_name: name })
				.first();

			if (ctx.params.record) ctx.params.record.table = row.table_name;
			else ctx.params.what.table = row.table_name;

			if (row && !row.enabled) return;
			if (!row) {
				await this.db("accounting.t_crud_allowed_tables").insert({
					name,
					table_name: name,
					title: `Доступ к ${name}`,
				});
				throw new Error(`🚨 Access to table ${name} denied.`);
			}
		},
	},
};

export default CRUDService;
