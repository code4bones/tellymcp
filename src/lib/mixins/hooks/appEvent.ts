import { GQLContext } from "@core/index";
import { PubBuilder } from "@src/lib/pubsub";

export enum WebAppEvents {
	webAppEvent = "webAppEvent",
}

const webAppEvent = (ctx, id, payload) =>
	PubBuilder.New(ctx, WebAppEvents.webAppEvent).to(id).payload(payload).pub();

export default {
	name: "webAppEvent",
	methods: {
		webAppEvent,
	},
};

export const hookWebAppEvent = (ctx: GQLContext, res) => {
	const { app_event } = ctx.action as any;
	if (app_event) {
		webAppEvent(ctx, null, {
			action: "refetch",
			refetch: app_event,
		});
	}
	return res;
};

export const hookEmitEvent = (ctx: GQLContext, res) => {
	if (!(ctx.action as any).event) return res;
	const { rawName, event } = ctx.action;
	const payload: any = {};
	if (event) {
		if (typeof event === "function" && !event(ctx, res)) return res;
		else if (event === "result") {
			payload.result = res;
		}
	}
	ctx.broadcast("graphql.publish", {
		tag: "backendEvent",
		payload: {
			action: rawName,
			user_id: ctx.meta?.user?.sub,
			...payload,
		},
	});
	return res;
};
