/* eslint-disable @typescript-eslint/no-namespace */
import knex, { Knex } from "knex";
import { GQLSchema } from "@src/lib/moleculer";

declare module "knex" {
	namespace Knex {
		type Pagination = {
			offset?: number;
			limit?: number;
			total?: number;
		};

		export type Sort = {
			column: string;
			order: string;
			nulls?: string;
		};

		export interface Filter {
			column: string;
			operator: string;
			value: string;
			values: Array<number>;
			and: Filter[];
		}

		export type DataView = {
			pagination?: Pagination;
			sort?: Sort[];
			filter?: Filter[];
		};

		/*
		type Paginate<TRecord extends {}, TResult> = {
			pagination?: Pagination;
			sort?: Sort[];
		};
		*/

		interface QueryBuilder {
			dataView<TRecord extends object, TResult>(
				dataView: DataView
			): Knex.QueryBuilder<TRecord, TResult>;
		}
	}
}

const paginate = (q: Knex.QueryBuilder, pagination?: Knex.Pagination) => {
	if (!pagination) return q.then(items => ({ items }));
	return q
		.clone()
		.clearSelect()
		.clearOrder()
		.count("*")
		.first()
		.then(({ count: total }) => {
			if (pagination?.limit) q.limit(pagination.limit);
			if (pagination?.offset) q.offset(pagination.offset);
			return q.then(items => ({
				pagination: {
					total: +total,
					...pagination,
				},
				items,
			}));
		});
};

const filter = (q: Knex.QueryBuilder, flt: Knex.Filter[]) => {
	const create = (f: Knex.Filter, p?: Knex.QueryBuilder) => {
		if (f.operator.toLocaleUpperCase() === "IN") {
			q.whereIn(f.column, f.values);
		} else if (p) {
			console.log("P", p);
			p.andWhere(f.column, f.operator, f.value);
		} else q.orWhere(f.column, f.operator, f.value);
		if (f.and) {
			f.and.forEach((af: Knex.Filter) => create(af, q));
		}
		return q;
	};
	if (!flt) return q;
	flt.forEach(f => create(f));
	return q;
};

const orderBy = (q: Knex.QueryBuilder, sort: Knex.Sort[]) => {
	const orders = sort
		.map(({ column, order, nulls }: Knex.Sort) => {
			return `"${column}" ${order} ${nulls || ""}`;
		})
		.join(",");
	q.orderByRaw(orders);
};

knex.QueryBuilder.extend("dataView", function (dataView: Knex.DataView): Promise<any> {
	if (dataView?.filter) filter(this, dataView.filter);
	if (dataView?.sort) orderBy(this, dataView.sort);
	return paginate(this, dataView?.pagination);
});

const DBConfig: Knex.PgConnectionConfig = {
	host: process.env.DB_HOST || "localhost",
	port: Number(process.env.DB_PORT || 5432),
	user: process.env.DB_USER || "",
	password: process.env.DB_PASSWORD || "",
	database: process.env.DB_NAME || "",
};

const DB_ENABLED = Boolean(process.env.DB_HOST?.trim());

type NoopBuilderState = {
	countMode?: boolean;
};

const createNoopPromise = (value: unknown) => Promise.resolve(value);

const createNoopQueryBuilder = (state: NoopBuilderState = {}): any => {
	const target = function noopQueryBuilder() {
		return createNoopQueryBuilder(state);
	};

	const proxy = new Proxy(target, {
		apply() {
			return createNoopQueryBuilder(state);
		},
		get(_obj, prop: string | symbol) {
			if (prop === "then") {
				return createNoopPromise([]).then.bind(createNoopPromise([]));
			}
			if (prop === "catch") {
				return createNoopPromise([]).catch.bind(createNoopPromise([]));
			}
			if (prop === "finally") {
				return createNoopPromise([]).finally.bind(createNoopPromise([]));
			}
			if (prop === "first") {
				return () => createNoopPromise(state.countMode ? { count: 0 } : null);
			}
			if (prop === "pluck") {
				return () => createNoopPromise([]);
			}
			if (
				prop === "insert" ||
				prop === "update" ||
				prop === "delete" ||
				prop === "del" ||
				prop === "increment" ||
				prop === "decrement"
			) {
				return () => createNoopQueryBuilder(state);
			}
			if (prop === "count") {
				return () => createNoopQueryBuilder({ ...state, countMode: true });
			}
			if (
				prop === "clone" ||
				prop === "clearSelect" ||
				prop === "clearOrder" ||
				prop === "select" ||
				prop === "from" ||
				prop === "table" ||
				prop === "withSchema" ||
				prop === "where" ||
				prop === "andWhere" ||
				prop === "orWhere" ||
				prop === "whereIn" ||
				prop === "whereNotIn" ||
				prop === "whereNull" ||
				prop === "whereNotNull" ||
				prop === "leftJoin" ||
				prop === "rightJoin" ||
				prop === "join" ||
				prop === "groupBy" ||
				prop === "having" ||
				prop === "orderBy" ||
				prop === "orderByRaw" ||
				prop === "limit" ||
				prop === "offset" ||
				prop === "transacting" ||
				prop === "onConflict" ||
				prop === "merge" ||
				prop === "returning" ||
				prop === "modify" ||
				prop === "column" ||
				prop === "union" ||
				prop === "unionAll" ||
				prop === "forUpdate" ||
				prop === "forShare"
			) {
				return () => createNoopQueryBuilder(state);
			}

			return createNoopQueryBuilder(state);
		},
	});

	return proxy;
};

const createNoopSchema = (): any => {
	const schemaTarget = {};
	return new Proxy(schemaTarget, {
		get(_obj, prop: string | symbol) {
			if (prop === "hasTable") {
				return () => Promise.resolve(false);
			}
			if (
				prop === "withSchema" ||
				prop === "createTable" ||
				prop === "alterTable" ||
				prop === "dropTable" ||
				prop === "dropTableIfExists" ||
				prop === "createSchema" ||
				prop === "createSchemaIfNotExists"
			) {
				return () => createNoopSchema();
			}
			if (prop === "then") {
				return Promise.resolve(undefined).then.bind(Promise.resolve(undefined));
			}
			if (prop === "catch") {
				return Promise.resolve(undefined).catch.bind(Promise.resolve(undefined));
			}
			if (prop === "finally") {
				return Promise.resolve(undefined).finally.bind(Promise.resolve(undefined));
			}
			return () => createNoopSchema();
		},
	});
};

const createNoopKnex = (): Knex => {
	const queryBuilder = createNoopQueryBuilder();
	const schema = createNoopSchema();
	const rawResult = {
		rows: [],
		rowCount: 0,
		command: "NOOP",
	};

	const target = function noopKnex() {
		return createNoopQueryBuilder();
	};

	const proxy = new Proxy(target, {
		apply() {
			return createNoopQueryBuilder();
		},
		get(_obj, prop: string | symbol) {
			if (prop === "schema") {
				return schema;
			}
			if (prop === "fn") {
				return {
					now: () => new Date(),
				};
			}
			if (prop === "raw") {
				return async () => rawResult;
			}
			if (prop === "destroy") {
				return async () => undefined;
			}
			if (prop === "transaction") {
				return async (handler?: (trx: Knex) => unknown) => {
					if (typeof handler === "function") {
						return handler(proxy as unknown as Knex);
					}
					return proxy;
				};
			}
			if (prop === "withSchema" || prop === "table") {
				return () => createNoopQueryBuilder();
			}
			if (prop === "queryBuilder") {
				return () => createNoopQueryBuilder();
			}
			return (queryBuilder as Record<string | symbol, unknown>)[prop] ?? createNoopQueryBuilder();
		},
	});

	return proxy as unknown as Knex;
};

const DBMixin: GQLSchema = {
	name: "DBMixin",
	created() {
		if (!DB_ENABLED) {
			this.logger?.warn?.("DBMixin: DB_HOST is not set, using no-op database stub");
			this.db = createNoopKnex();
			return;
		}

		this.db = knex({
			debug: Boolean(process.env.PG_DEBUG),
			client: "pg",
			connection: {
				...DBConfig,
			},
			pool: {
				min: 1,
				max: 64,
				// acquireTimeoutMillis: 1000 * 60 * 60,
				propagateCreateError: false,
				afterCreate: (
					con: {
						on: (event: string, handler: (...payload: any[]) => void) => void;
						query: (sql: string, cb: (err: unknown) => void) => void;
					},
					callback: (err: unknown, connection: unknown) => void
				) => {
					con.on("error", (err: unknown) => {
						console.error("[KNEX-ERROR]", err);
					});
					con.on("notice", function (msg: { name?: string; severity?: string; message?: string }) {
						console.warn(`[DB] ${msg.name}/${msg.severity}:`, msg.message);
						// console.warn(`[PG]`, msg.message);
					});
					con.query('SET time zone  "Europe/Moscow"', (err: unknown) => {
						if (err) console.error("QUERY", err);
						callback(err, con);
					});
				},
			},
		});
	},
};

export { DBMixin };
