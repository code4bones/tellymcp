import { GQLSchema } from "@src/lib/moleculer";
import { logFeedStore, type LogFeedEntry } from "@src/lib/logfeed/store";

export enum LogFeedEvents {
	logFeedAppended = "logFeedAppended",
}

const logfeedService: GQLSchema = {
	name: "logfeed",
	settings: {
		graphql: {
			type: `
				type LogFeedEntry {
					id: String!
					seq: Int!
					ts: Float!
					level: String!
					module: String
					nodeID: String
					namespace: String
					svc: String
					message: String!
				}
			`,
		},
	},
	actions: {
		latest: {
			graphql: {
				query: "logFeedLatest(limit:Int):[LogFeedEntry!]!",
			},
			handler(ctx) {
				if (!ctx.meta.user) {
					throw new Error("Unauthorized");
				}

				return logFeedStore.list(ctx.params.limit);
			},
		},
		appended: {
			graphql: {
				subscription: "logFeedAppended:LogFeedEntry!",
				tags: [LogFeedEvents.logFeedAppended],
				filter: "logfeed.logFeedAccess",
			},
			handler(ctx) {
				return ctx.params.payload as LogFeedEntry;
			},
		},
		logFeedAccess: {
			handler(ctx) {
				return Boolean(ctx.meta.user);
			},
		},
	},
	started() {
		this.logFeedListener = (entry: LogFeedEntry) => {
			this.broker.broadcast("graphql.publish", {
				tag: LogFeedEvents.logFeedAppended,
				payload: entry,
			});
		};

		logFeedStore.on("entry", this.logFeedListener);
	},
	stopped() {
		if (this.logFeedListener) {
			logFeedStore.off("entry", this.logFeedListener);
		}
	},
};

export default logfeedService;
