import { randomUUID } from "crypto";
import { GQLSchema } from "@src/lib/moleculer";
import { DBMixin } from "@src/lib/mixins/db";
import { normalizeTraceLevel, sanitizeTraceValue } from "@src/lib/trace";

export enum TraceEvents {
	traceEventAppended = "traceEventAppended",
	traceSessionUpdated = "traceSessionUpdated",
}

type TraceLevel = "fatal" | "error" | "warn" | "info" | "debug" | "trace";

const traceService: GQLSchema = {
	name: "trace",
	mixins: [DBMixin],
	settings: {
		graphql: {
			type: `
				type TraceSession {
					session_id: String!
					name: String!
					tag: String
					source: String
					status: String!
					summary: String
					meta: JSON
					created_by: String
					started_at: String
					ended_at: String
					updated_at: String
				}

				type TraceEvent {
					event_id: String!
					session_id: String!
					level: String!
					action: String
					state: String
					marker: String
					step: String
					message: String!
					data: JSON
					created_at: String
				}
			`,
		},
	},
	created() {
		this.traceSchemaReady = null;
	},
	async started() {
		return;
	},
	actions: {
		startSession: {
			graphql: {
				mutation: "traceStartSession(name:String!,tag:String,source:String,meta:JSON):TraceSession!",
			},
			async handler(ctx) {
				if (!ctx.meta.user && ctx.meta.$request) {
					throw new Error("Unauthorized");
				}
				const sessionId = randomUUID();
				const payload = {
					session_id: sessionId,
					name: String(ctx.params.name || "Trace session"),
					tag: ctx.params.tag ? String(ctx.params.tag) : null,
					source: ctx.params.source ? String(ctx.params.source) : null,
					status: "running",
					summary: null,
					meta: sanitizeTraceValue(ctx.params.meta || {}),
					created_by: ctx.meta.user?.sub || null,
					started_at: this.db.fn.now(),
					updated_at: this.db.fn.now(),
				};
				await this.db("tr.session").insert(payload);
				return this.getTraceSession(sessionId);
			},
		},
		log: {
			graphql: {
				mutation: "traceLog(session_id:String!,level:String,message:String!,step:String,action:String,state:String,marker:String,data:JSON):TraceEvent!",
			},
			async handler(ctx) {
				if (!ctx.meta.user && ctx.meta.$request) {
					throw new Error("Unauthorized");
				}
				return this.appendTraceEvent({
					sessionId: String(ctx.params.session_id),
					level: normalizeTraceLevel(ctx.params.level),
					action: ctx.params.action ? String(ctx.params.action) : null,
					state: ctx.params.state ? String(ctx.params.state) : null,
					marker: ctx.params.marker ? String(ctx.params.marker) : null,
					step: ctx.params.step ? String(ctx.params.step) : null,
					message: String(ctx.params.message || ""),
					data: ctx.params.data || null,
				});
			},
		},
		endSession: {
			graphql: {
				mutation: "traceEndSession(session_id:String!,status:String,summary:String,meta:JSON):TraceSession!",
			},
			async handler(ctx) {
				if (!ctx.meta.user && ctx.meta.$request) {
					throw new Error("Unauthorized");
				}
				const sessionId = String(ctx.params.session_id);
				const current = await this.getTraceSession(sessionId);
				if (!current) {
					throw new Error(`Trace session ${sessionId} not found`);
				}
				await this.db("tr.session")
					.where({ session_id: sessionId })
					.update({
						status: String(ctx.params.status || "succeeded"),
						summary: ctx.params.summary ? String(ctx.params.summary) : current.summary || null,
						meta: sanitizeTraceValue(ctx.params.meta || current.meta || {}),
						ended_at: this.db.fn.now(),
						updated_at: this.db.fn.now(),
					});
				const session = await this.getTraceSession(sessionId);
				await this.publishTraceSessionUpdated(session);
				return session;
			},
		},
		deleteSession: {
			graphql: {
				mutation: "traceDeleteSession(session_id:String!):Boolean!",
			},
			async handler(ctx) {
				if (!ctx.meta.user && ctx.meta.$request) {
					throw new Error("Unauthorized");
				}
				const sessionId = String(ctx.params.session_id || "").trim();
				if (!sessionId) {
					return false;
				}
				const session = await this.getTraceSession(sessionId);
				await this.db("tr.session").where({ session_id: sessionId }).delete();
				if (session) {
					await this.publishTraceSessionUpdated({
						...session,
						status: "deleted",
						updated_at: new Date().toISOString(),
					});
				}
				return true;
			},
		},
		clearSessions: {
			graphql: {
				mutation: "traceClearSessions(tag:String,status:String,search:String):Int!",
			},
			async handler(ctx) {
				if (!ctx.meta.user && ctx.meta.$request) {
					throw new Error("Unauthorized");
				}
				const tag = String(ctx.params.tag || "").trim();
				const status = String(ctx.params.status || "").trim();
				const search = String(ctx.params.search || "").trim();
				const rows = await this.db("tr.session")
					.select("session_id")
					.modify(query => {
						if (status) query.where({ status });
						if (tag) query.where({ tag });
						if (search) {
							query.andWhere(builder => {
								builder
									.whereILike("name", `%${search}%`)
									.orWhereILike("tag", `%${search}%`)
									.orWhereILike("source", `%${search}%`)
									.orWhereILike("summary", `%${search}%`);
							});
						}
					});
				const ids = rows.map(row => String(row.session_id)).filter(Boolean);
				if (!ids.length) {
					return 0;
				}
				await this.db("tr.session").whereIn("session_id", ids).delete();
				return ids.length;
			},
		},
		session: {
			graphql: {
				query: "traceSession(session_id:String!):TraceSession",
			},
			async handler(ctx) {
				if (!ctx.meta.user) {
					throw new Error("Unauthorized");
				}
				return this.getTraceSession(String(ctx.params.session_id));
			},
		},
		sessions: {
			graphql: {
				query: "traceSessions(limit:Int,status:String,tag:String,search:String,order:String):[TraceSession!]!",
			},
			async handler(ctx) {
				if (!ctx.meta.user) {
					throw new Error("Unauthorized");
				}
				const limit = Math.max(1, Math.min(500, Number(ctx.params.limit || 100)));
				const status = String(ctx.params.status || "").trim();
				const tag = String(ctx.params.tag || "").trim();
				const search = String(ctx.params.search || "").trim();
				const order = String(ctx.params.order || "desc").toLowerCase() === "asc" ? "asc" : "desc";
				const rows = await this.db("tr.session")
					.select("*")
					.modify(query => {
						if (status) query.where({ status });
						if (tag) query.where({ tag });
						if (search) {
							query.andWhere(builder => {
								builder
									.whereILike("name", `%${search}%`)
									.orWhereILike("tag", `%${search}%`)
									.orWhereILike("source", `%${search}%`)
									.orWhereILike("summary", `%${search}%`);
							});
						}
					})
					.orderBy("started_at", order)
					.limit(limit);
				return rows.map(row => this.normalizeTraceSession(row));
			},
		},
		sessionEvents: {
			graphql: {
				query: "traceSessionEvents(session_id:String!,limit:Int,search:String,order:String):[TraceEvent!]!",
			},
			async handler(ctx) {
				if (!ctx.meta.user) {
					throw new Error("Unauthorized");
				}
				const sessionId = String(ctx.params.session_id);
				const limit = Math.max(1, Math.min(2000, Number(ctx.params.limit || 500)));
				const search = String(ctx.params.search || "").trim();
				const order = String(ctx.params.order || "asc").toLowerCase() === "desc" ? "desc" : "asc";
				const rows = await this.db("tr.event")
					.select("*")
					.where({ session_id: sessionId })
					.modify(query => {
						if (search) {
							query.andWhere(builder => {
								builder
									.whereILike("message", `%${search}%`)
									.orWhereILike("action", `%${search}%`)
									.orWhereILike("state", `%${search}%`)
									.orWhereILike("marker", `%${search}%`)
									.orWhereILike("step", `%${search}%`)
									.orWhereILike("level", `%${search}%`)
									.orWhereRaw(`cast(data as text) ilike ?`, [`%${search}%`]);
							});
						}
					})
					.orderBy("created_at", order)
					.limit(limit);
				return rows.map(row => this.normalizeTraceEvent(row));
			},
		},
		eventAppended: {
			graphql: {
				subscription: "traceEventAppended(session_id:String!):TraceEvent!",
				tags: [TraceEvents.traceEventAppended],
				filter: "trace.traceEventFilter",
			},
			handler(ctx) {
				return ctx.params.payload;
			},
		},
		sessionUpdated: {
			graphql: {
				subscription: "traceSessionUpdated(session_id:String!):TraceSession!",
				tags: [TraceEvents.traceSessionUpdated],
				filter: "trace.traceSessionFilter",
			},
			handler(ctx) {
				return ctx.params.payload;
			},
		},
		traceEventFilter: {
			handler(ctx) {
				return String(ctx.params.session_id || "") === String(ctx.params.payload?.session_id || "");
			},
		},
		traceSessionFilter: {
			handler(ctx) {
				return String(ctx.params.session_id || "") === String(ctx.params.payload?.session_id || "");
			},
		},
	},
	methods: {
		async ensureTraceSchemaOnce() {
			return;
		},
		async ensureTraceSchema() {
			return;
		},
		normalizeTraceSession(row) {
			return {
				session_id: String(row.session_id),
				name: String(row.name || ""),
				tag: row.tag || null,
				source: row.source || null,
				status: String(row.status || "running"),
				summary: row.summary || null,
				meta: row.meta || {},
				created_by: row.created_by || null,
				started_at: row.started_at || null,
				ended_at: row.ended_at || null,
				updated_at: row.updated_at || null,
			};
		},
		normalizeTraceEvent(row) {
			return {
				event_id: String(row.event_id),
				session_id: String(row.session_id),
				level: normalizeTraceLevel(row.level),
				action: row.action || null,
				state: row.state || null,
				marker: row.marker || null,
				step: row.step || null,
				message: String(row.message || ""),
				data: row.data || {},
				created_at: row.created_at || null,
			};
		},
		async getTraceSession(sessionId: string) {
			const row = await this.db("tr.session").select("*").where({ session_id: sessionId }).first();
			return row ? this.normalizeTraceSession(row) : null;
		},
		async publishTraceEventAppended(event) {
			await this.broker.broadcast("graphql.publish", {
				tag: TraceEvents.traceEventAppended,
				payload: event,
			});
		},
		async publishTraceSessionUpdated(session) {
			await this.broker.broadcast("graphql.publish", {
				tag: TraceEvents.traceSessionUpdated,
				payload: session,
			});
		},
		async appendTraceEvent({
			sessionId,
			level,
			action,
			state,
			marker,
			step,
			message,
			data,
		}: {
			sessionId: string;
			level: TraceLevel;
			action?: string | null;
			state?: string | null;
			marker?: string | null;
			step?: string | null;
			message: string;
			data?: any;
		}) {
			const eventId = randomUUID();
			const normalizedData = sanitizeTraceValue(data || {});
			await this.db("tr.event").insert({
				event_id: eventId,
				session_id: sessionId,
				level,
				action: action || null,
				state: state || null,
				marker: marker || null,
				step: step || null,
				message,
				data: normalizedData,
				created_at: this.db.fn.now(),
			});
			await this.db("tr.session")
				.where({ session_id: sessionId })
				.update({
					updated_at: this.db.fn.now(),
				});
			const row = await this.db("tr.event").select("*").where({ event_id: eventId }).first();
			const event = this.normalizeTraceEvent(row);
			const session = await this.getTraceSession(sessionId);
			await this.publishTraceEventAppended(event);
			if (session) {
				await this.publishTraceSessionUpdated(session);
			}
			return event;
		},
	},
};

export default traceService;
