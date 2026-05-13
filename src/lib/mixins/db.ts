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

const orderBy = (q: Knex.QueryBuilder, sort) => {
	const orders = sort
		.map(({ column, order, nulls }) => {
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

const DBConfig: Knex.StaticConnectionConfig = {
	host: process.env.DB_HOST,
	port: Number(process.env.DB_PORT),
	user: process.env.DB_USER,
	password: process.env.DB_PASSWORD,
	database: process.env.DB_NAME,
};

const DBMixin: GQLSchema = {
	name: "DBMixin",
	created() {
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
				afterCreate: (con, callback) => {
					con.on("error", err => {
						console.error("[KNEX-ERROR]", err);
					});
					con.on("notice", function (msg) {
						console.warn(`[DB] ${msg.name}/${msg.severity}:`, msg.message);
						// console.warn(`[PG]`, msg.message);
					});
					con.query('SET time zone  "Europe/Moscow"', err => {
						if (err) console.error("QUERY", err);
						callback(err, callback);
					});
				},
			},
		});
	},
};

export { DBMixin };
