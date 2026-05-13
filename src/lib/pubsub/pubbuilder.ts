import _ from "lodash";
import { Context } from "moleculer";
// import { TEvents } from "./names";

type Options = {
	user_id?: string;
	event?: string;
	args?: any;
	payload?: any;
};

interface IPubBulter {
	ctx?: Context;
	opts?: Options;
}

class PubBuilder implements IPubBulter {
	ctx?: Context;

	opts?: Options;

	constructor(ctx: Context, event: string) {
		this.ctx = ctx;
		this.opts = {
			event,
		};
	}

	static New(ctx: Context, event: string) {
		return new PubBuilder(ctx, event);
	}

	to(user_id: string) {
		this.opts.user_id = user_id;
		return this;
	}

	args(args) {
		this.opts.args = args;
		return this;
	}

	payload(payload) {
		this.opts.payload = payload;
		return this;
	}

	pub() {
		const data = {
			...this.opts.payload,
		};
		if (this.opts.user_id) {
			data.target_ids = _.isArray(this.opts.user_id) ? [...this.opts.user_id] : [this.opts.user_id];
		}
		if (this.opts.args) {
			data.args = { ...this.opts.args };
		}
		/*
		this.ctx.call("tg.message", {
			message: `🚀 Подписка <b>${this.opts.event}</b>(👤${
				data.target_ids ? data.target_ids.length : "*"
			})\r\n${JSON.stringify(this.opts.payload, null, 2)}`,
		});
		*/
		const message = `🚀 Подписка <b>${this.opts.event}</b>(👤${
			data.target_ids ? data.target_ids.length : "*"
		})\r\n${JSON.stringify(this.opts.payload, null, 2)}`;

		this.ctx.service.logger.warn(message);
		this.ctx.broadcast("graphql.publish", {
			tag: this.opts.event,
			payload: data,
		});
		return {
			tag: this.opts.event,
			payload: this.opts.payload,
		};
	}
}

export default PubBuilder;
